#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""风扇控制引擎：温度采集 → 曲线/手动 → PWM 写入 → 状态暴露 + Bark 告警。"""

import atexit
import json
import os
import threading
import time
from collections import deque

import requests

import hwmon

FAKE = os.environ.get("FAN_FAKE", "") == "1"   # 开发模式：不写 sysfs

DEFAULT_CPU_CURVE = [
    {"temp": 20, "pwm": 20}, {"temp": 30, "pwm": 30}, {"temp": 40, "pwm": 50},
    {"temp": 50, "pwm": 80}, {"temp": 60, "pwm": 120}, {"temp": 65, "pwm": 160},
    {"temp": 70, "pwm": 210}, {"temp": 80, "pwm": 255},
]
DEFAULT_DISK_CURVE = [
    {"temp": 20, "pwm": 20}, {"temp": 26, "pwm": 35}, {"temp": 32, "pwm": 55},
    {"temp": 38, "pwm": 85}, {"temp": 44, "pwm": 130}, {"temp": 50, "pwm": 175},
    {"temp": 55, "pwm": 220}, {"temp": 60, "pwm": 255},
]

DEFAULT_CONFIG = {
    "mode": "auto",                # auto | manual
    "manual_pwm": 128,
    "interval": 2.5,               # 采样间隔（秒）
    "history_size": 4,             # 滑动平均窗口
    "pwm_change_threshold": 2,     # 变化小于该值不写
    "pwm_min": 20,
    "pwm_max": 255,
    "restore_on_exit": True,       # 退出时恢复主板自动（pwm_enable=5）
    "cpu": {"method": "max", "curve": DEFAULT_CPU_CURVE},
    "disk": {"method": "max", "disks": [], "curve": DEFAULT_DISK_CURVE},
    "alert": {
        "enabled": True, "cpu_temp": 62, "disk_temp": 42,
        "interval": 60, "hostname": "Abyss",
    },
    "bark": {"enabled": False, "url": "", "icon": "",
             "group": "fan-pro", "sound": ""},
}


def curve_interp(curve, temp):
    """曲线查表 + 线性插值。curve=[{temp,pwm},...]"""
    pts = sorted((float(p["temp"]), int(p["pwm"])) for p in curve if p.get("temp") is not None)
    if not pts:
        return 0
    if temp <= pts[0][0]:
        return pts[0][1]
    if temp >= pts[-1][0]:
        return pts[-1][1]
    for (t0, p0), (t1, p1) in zip(pts, pts[1:]):
        if t0 <= temp <= t1:
            if t1 == t0:
                return p1
            return round(p0 + (p1 - p0) * (temp - t0) / (t1 - t0))
    return pts[-1][1]


def curve_threshold(curve, temp):
    """返回当前命中的曲线档位（供 UI 显示阈值）。"""
    pts = sorted((float(p["temp"]), int(p["pwm"])) for p in curve if p.get("temp") is not None)
    if not pts:
        return None
    lo = hi = None
    for (t0, p0), (t1, p1) in zip(pts, pts[1:]):
        if t0 <= temp <= t1:
            lo, hi = (t0, p0), (t1, p1)
            break
    if lo is None:
        lo = hi = (pts[0] if temp < pts[0][0] else pts[-1])
    return {"low": {"temp": lo[0], "pwm": lo[1]},
            "high": {"temp": hi[0], "pwm": hi[1]}}


class Engine:
    def __init__(self, data_dir):
        self.data_dir = data_dir
        self.config_path = os.path.join(data_dir, "config.json")
        self.lock = threading.Lock()
        self.cfg = self._load_config()
        self.state = {
            "rpm": 0, "pwm": 0, "target_pwm": 0, "mode": self.cfg["mode"],
            "temps": {"cpu": None, "gpu": None, "disk": None,
                      "disks": {}, "cpu_raw": [], "disk_raw": []},
            "active": "init",          # cpu / disk / manual
            "threshold": None, "errors": [],
            "alert": {"cpu_fired": False, "disk_fired": False},
            "conflicts": [],
            "started_at": time.time(),
        }
        self._hist_cpu = deque(maxlen=8)
        self._hist_disk = deque(maxlen=8)
        self.started_at = time.time()
        self.stats = {"max_rpm": 0, "max_cpu": None, "max_disk": None}
        self._last_alert = {}
        self._stop = threading.Event()
        self._thread = None
        self.pwm = hwmon.find_pwm()
        self.cpu_src = hwmon.find_cpu_source()
        self.gpu_src = hwmon.find_gpu_source()
        self._orig_enable = None
        if self.pwm:
            try:
                with open(self.pwm["enable_file"]) as f:
                    self._orig_enable = f.read().strip()
            except OSError:
                pass
        atexit.register(self._restore)

    # ---------------- config ----------------
    def _load_config(self):
        cfg = json.loads(json.dumps(DEFAULT_CONFIG))   # deep copy
        try:
            with open(self.config_path) as f:
                saved = json.load(f)
            for k, v in saved.items():
                if isinstance(v, dict) and isinstance(cfg.get(k), dict):
                    cfg[k].update(v)
                else:
                    cfg[k] = v
        except (OSError, ValueError):
            pass
        return self._sanitize(cfg)

    def _sanitize(self, cfg):
        try:
            cfg["mode"] = "manual" if cfg.get("mode") == "manual" else "auto"
            cfg["manual_pwm"] = max(cfg.get("pwm_min", 20),
                                    min(int(cfg.get("manual_pwm", 128)),
                                        cfg.get("pwm_max", 255)))
            cfg["interval"] = max(0.5, min(float(cfg.get("interval", 2.5)), 30))
            cfg["history_size"] = max(1, min(int(cfg.get("history_size", 4)), 30))
            for key in ("cpu", "disk"):
                c = cfg.get(key) or {}
                c["method"] = "avg" if c.get("method") == "avg" else "max"
                c["curve"] = [{"temp": float(p.get("temp", 0)),
                               "pwm": max(0, min(255, int(p.get("pwm", 0))))}
                              for p in (c.get("curve") or []) if p.get("temp") is not None]
                cfg[key] = c
        except Exception:
            return json.loads(json.dumps(DEFAULT_CONFIG))
        return cfg

    def save_config(self, cfg):
        with self.lock:
            self.cfg = self._sanitize(cfg)
            os.makedirs(self.data_dir, exist_ok=True)
            tmp = self.config_path + ".tmp"
            with open(tmp, "w") as f:
                json.dump(self.cfg, f, ensure_ascii=False, indent=2)
            os.replace(tmp, self.config_path)
            self.state["mode"] = self.cfg["mode"]
        return self.cfg

    # ---------------- 采样 ----------------
    def _sample(self):
        errs = []
        # CPU
        cpu_t = None
        if self.cpu_src:
            raw = hwmon.read_temps(self.cpu_src["inputs"])
            if raw:
                cpu_t = (sum(raw) / len(raw)) if self.cfg["cpu"]["method"] == "avg" else max(raw)
                self._hist_cpu.append(cpu_t)
                cpu_t = round(sum(self._hist_cpu) / len(self._hist_cpu), 1)
            else:
                errs.append("CPU 温度读取失败")
        # GPU（仅显示）
        gpu_t = None
        if self.gpu_src:
            raw = hwmon.read_temps(self.gpu_src["inputs"])
            if raw:
                gpu_t = round(max(raw), 1)
        # 磁盘
        all_disks = hwmon.list_disks()
        chosen = self.cfg["disk"].get("disks") or []
        disk_map = {}
        disk_t = None
        raw_sel = []
        for d in all_disks:
            if d["temp"] is not None:
                disk_map[d["name"]] = d["temp"]
            if chosen and d["name"] not in chosen:
                continue
            if d["temp"] is not None:
                raw_sel.append(d["temp"])
        if raw_sel:
            disk_t = (sum(raw_sel) / len(raw_sel)) if self.cfg["disk"]["method"] == "avg" else max(raw_sel)
            self._hist_disk.append(disk_t)
            disk_t = round(sum(self._hist_disk) / len(self._hist_disk), 1)
        else:
            errs.append("没有可测温的选中磁盘")
        with self.lock:
            if cpu_t is not None and (self.stats["max_cpu"] is None or cpu_t > self.stats["max_cpu"]):
                self.stats["max_cpu"] = cpu_t
            if disk_t is not None and (self.stats["max_disk"] is None or disk_t > self.stats["max_disk"]):
                self.stats["max_disk"] = disk_t
            self.state["temps"] = {
                "cpu": cpu_t, "gpu": gpu_t, "disk": disk_t,
                "disks": disk_map,
                "cpu_method": self.cfg["cpu"]["method"],
                "disk_method": self.cfg["disk"]["method"],
                "disk_chosen": chosen,
            }
            self.state["errors"] = errs
        return cpu_t, disk_t

    # ---------------- PWM ----------------
    def _apply_pwm(self, cpu_t, disk_t):
        cfg = self.cfg
        mode = cfg["mode"]
        th = None
        if mode == "manual" or cpu_t is None:
            target = int(cfg["manual_pwm"])
            active = "manual" if mode == "manual" else "hold"
        else:
            p_cpu = curve_interp(cfg["cpu"]["curve"], cpu_t)
            th_cpu = curve_threshold(cfg["cpu"]["curve"], cpu_t)
            if disk_t is not None:
                p_disk = curve_interp(cfg["disk"]["curve"], disk_t)
                th_disk = curve_threshold(cfg["disk"]["curve"], disk_t)
                if p_disk > p_cpu:
                    target, active, th = int(p_disk), "disk", th_disk
                else:
                    target, active, th = int(p_cpu), "cpu", th_cpu
            else:
                target, active, th = int(p_cpu), "cpu", th_cpu
        target = max(cfg["pwm_min"], min(cfg["pwm_max"], target))
        cur = self._read_pwm()
        if cur is None or abs(target - cur) >= cfg["pwm_change_threshold"]:
            self._write_pwm(target)
        rpm = 0
        if self.pwm:
            try:
                with open(self.pwm["fan_file"]) as f:
                    rpm = int(f.read().strip())
            except (OSError, ValueError):
                pass
        with self.lock:
            self.state.update({"rpm": rpm, "pwm": target if FAKE else (self._read_pwm() or target),
                               "target_pwm": target, "mode": mode,
                               "active": active, "threshold": th})
            if rpm > self.stats["max_rpm"]:
                self.stats["max_rpm"] = rpm

    def _read_pwm(self):
        if not self.pwm or FAKE:
            return self.state.get("target_pwm") or 0
        try:
            with open(self.pwm["pwm_file"]) as f:
                return int(f.read().strip())
        except (OSError, ValueError):
            return None

    def _write_pwm(self, value):
        if not self.pwm or FAKE:
            return
        try:
            with open(self.pwm["enable_file"], "w") as f:
                f.write("1")               # 手动模式接管
            with open(self.pwm["pwm_file"], "w") as f:
                f.write(str(int(value)))
        except OSError as e:
            with self.lock:
                self.state["errors"] = ["PWM 写入失败：%s" % e]

    def _restore(self):
        if FAKE or not self.pwm or not self.cfg.get("restore_on_exit"):
            return
        try:
            with open(self.pwm["enable_file"], "w") as f:
                f.write(self._orig_enable or "5")   # 交还主板自动
        except OSError:
            pass

    # ---------------- 告警 ----------------
    def _alert_check(self, cpu_t, disk_t):
        a = self.cfg.get("alert") or {}
        if not a.get("enabled"):
            return
        now = time.time()
        events = []
        if cpu_t is not None and cpu_t >= a.get("cpu_temp", 62):
            events.append(("cpu", cpu_t, a.get("cpu_temp", 62)))
        if disk_t is not None and disk_t >= a.get("disk_temp", 42):
            events.append(("disk", disk_t, a.get("disk_temp", 42)))
        st = self.state["alert"]
        for key, t, th in events:
            last = self._last_alert.get(key, 0)
            if now - last < a.get("interval", 60):
                st[key + "_fired"] = True
                continue
            self._last_alert[key] = now
            st[key + "_fired"] = True
            name = "CPU" if key == "cpu" else "硬盘"
            self._bark("%s 温度过高" % name,
                       "%s 当前 %.1f°C，已超过阈值 %d°C" % (name, t, th))
        if not events:                       # 恢复通知
            for key, cur in (("cpu", cpu_t), ("disk", disk_t)):
                if st.get(key + "_fired") and cur is not None and (
                        (key == "cpu" and cur < a.get("cpu_temp", 62) - 3)
                        or (key == "disk" and cur < a.get("disk_temp", 42) - 3)):
                    st[key + "_fired"] = False
                    name = "CPU" if key == "cpu" else "硬盘"
                    self._bark("%s 温度已恢复" % name,
                               "当前 %.1f°C，回到阈值以下" % cur)

    def _bark(self, title, body):
        b = self.cfg.get("bark") or {}
        if not b.get("enabled") or not b.get("url"):
            return
        try:
            payload = {"title": title, "body": body,
                       "group": b.get("group") or "fan-pro"}
            if b.get("icon"):
                payload["icon"] = b["icon"]
            if b.get("sound"):
                payload["sound"] = b["sound"]
            requests.post(b["url"].rstrip("/") + "/", json=payload, timeout=8)
        except Exception:
            pass

    def bark_test(self):
        b = self.cfg.get("bark") or {}
        if not b.get("url"):
            return False, "请先填写 Bark 地址"
        try:
            payload = {"title": "风扇管家测试通知",
                       "body": "如果你看到这条，说明 Bark 配置成功啦",
                       "group": b.get("group") or "fan-pro"}
            if b.get("icon"):
                payload["icon"] = b["icon"]
            if b.get("sound"):
                payload["sound"] = b["sound"]
            r = requests.post(b["url"].rstrip("/") + "/", json=payload, timeout=8)
            return r.status_code == 200, "HTTP %s" % r.status_code
        except Exception as e:
            return False, str(e)

    # ---------------- 主循环 ----------------
    def _detect_conflicts(self):
        import subprocess
        try:
            out = subprocess.run(["pgrep", "-af", "fan_control.py"],
                                 capture_output=True, text=True, timeout=5).stdout
            self.state["conflicts"] = ["fn-fan"] if "fn-fan" in out else []
        except Exception:
            pass

    def _loop(self):
        self._detect_conflicts()
        while not self._stop.is_set():
            try:
                cpu_t, disk_t = self._sample()
                self._apply_pwm(cpu_t, disk_t)
                self._alert_check(cpu_t, disk_t)
            except Exception as e:
                with self.lock:
                    self.state["errors"] = ["控制循环异常：%s" % e]
            self._stop.wait(self.cfg.get("interval", 2.5))

    def start(self):
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()

    def status(self):
        with self.lock:
            st = dict(self.state)
            st["temps"] = dict(self.state["temps"])
            st["alert"] = dict(self.state["alert"])
            st["stats"] = dict(self.stats)
        st["uptime"] = int(time.time() - self.started_at)
        st["pwm_channel"] = self.pwm
        st["fake"] = FAKE
        return st
