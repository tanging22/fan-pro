#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""风扇管家 fan-pro —— Web API（Flask，gunicorn unix-socket 部署）。"""

import os
import sys

from flask import Flask, jsonify, request, send_from_directory

APP_DIR = os.path.dirname(os.path.abspath(__file__))
UI_DIR = os.path.join(os.path.dirname(APP_DIR), "ui")
sys.path.insert(0, APP_DIR)

from fancontrol import Engine           # noqa: E402

app = Flask(__name__, static_folder=None)

# ---------------------------------------------------------------- 网关前缀
URL_PREFIX = os.environ.get("FANPRO_URL_PREFIX", "/app/fan-pro")


class _PrefixMiddleware:
    """fnOS 统一网关转发保留 /app/<name> 前缀：剥掉再进 Flask；
    裸前缀 308 到带斜杠路径（相对资源定位）。"""

    def __init__(self, wsgi):
        self.wsgi = wsgi

    def __call__(self, environ, start_response):
        pi = environ.get("PATH_INFO", "")
        if pi == URL_PREFIX:
            start_response("308 Permanent Redirect",
                           [("Location", URL_PREFIX + "/"),
                            ("Content-Length", "0")])
            return [b""]
        if pi.startswith(URL_PREFIX + "/"):
            environ["PATH_INFO"] = pi[len(URL_PREFIX):] or "/"
        return self.wsgi(environ, start_response)


app.wsgi_app = _PrefixMiddleware(app.wsgi_app)

DATA_DIR = os.environ.get("FANPRO_DATA_DIR",
                          os.path.join(APP_DIR, "..", "..", "data"))
engine = Engine(DATA_DIR)
engine.start()


def ok(data=None):
    return jsonify({"ok": True, "data": data or {}})


def err(msg, code=400):
    return jsonify({"ok": False, "error": str(msg)}), code


# ---------------------------------------------------------------- 静态
@app.get("/")
def index():
    return send_from_directory(UI_DIR, "index.html")


@app.get("/assets/<path:p>")
def assets(p):
    return send_from_directory(os.path.join(UI_DIR, "assets"), p)


# ---------------------------------------------------------------- API
@app.get("/api/status")
def api_status():
    return ok(engine.status())


@app.get("/api/config")
def api_config():
    return ok(engine.cfg)


@app.post("/api/config")
def api_config_save():
    body = request.get_json(silent=True) or {}
    if not isinstance(body, dict):
        return err("配置格式错误")
    saved = engine.save_config(body)
    return ok(saved)


@app.get("/api/disks")
def api_disks():
    import hwmon
    return ok({"disks": hwmon.list_disks()})


@app.post("/api/mode")
def api_mode():
    body = request.get_json(silent=True) or {}
    mode = body.get("mode")
    if mode not in ("auto", "manual"):
        return err("mode 必须是 auto 或 manual")
    cfg = dict(engine.cfg)
    cfg["mode"] = mode
    engine.save_config(cfg)
    return ok({"mode": mode})


@app.post("/api/pwm")
def api_pwm():
    body = request.get_json(silent=True) or {}
    cfg = dict(engine.cfg)
    # 支持直接以目标转速（RPM）控制：pwm = rpm / max_rpm * 255
    if body.get("rpm") is not None:
        try:
            rpm = int(body.get("rpm"))
        except (TypeError, ValueError):
            return err("rpm 必须是整数")
        max_rpm = int(cfg.get("fan", {}).get("max_rpm") or 3000) or 3000
        pwm = round(max(0, min(rpm, max_rpm)) / max_rpm * 255)
    else:
        try:
            pwm = int(body.get("pwm"))
        except (TypeError, ValueError):
            return err("pwm/rpm 必须是整数")
    if not 0 <= pwm <= 255:
        return err("换算后 pwm 范围 0-255")
    cfg["manual_pwm"] = pwm
    engine.save_config(cfg)
    return ok({"pwm": pwm})


@app.post("/api/bark/test")
def api_bark_test():
    good, msg = engine.bark_test()
    return ok({"sent": good, "detail": msg}) if good else err("发送失败：%s" % msg)


# ---------------------------------------------------------------- main
if __name__ == "__main__":
    port = int(os.environ.get("FANPRO_PORT", "28200"))
    app.run(host="127.0.0.1", port=port, threaded=True)
