#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""sysfs hwmon 枚举：CPU/GPU/磁盘温度源 + PWM/转速通道探测。"""

import glob
import os
import re


def _read(path):
    try:
        with open(path) as f:
            return f.read().strip()
    except OSError:
        return ""


def _read_int(path):
    v = _read(path)
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


def list_hwmons():
    """[{path, name}]"""
    out = []
    for p in sorted(glob.glob("/sys/class/hwmon/hwmon*")):
        name = _read(os.path.join(p, "name"))
        if name:
            out.append({"path": p, "name": name})
    return out


def find_cpu_source():
    """coretemp（K10/amdhsf 兜底）。返回 {path, label:"CPU", inputs:[file...]}"""
    for h in list_hwmons():
        if h["name"] in ("coretemp", "k10temp", "zenpower"):
            inputs = sorted(
                f for f in glob.glob(os.path.join(h["path"], "temp*_input"))
            )
            if inputs:
                return {"path": h["path"], "label": "CPU", "inputs": inputs}
    return None


def find_gpu_source():
    for h in list_hwmons():
        if h["name"] in ("i915", "amdgpu", "nouveau"):
            inputs = sorted(
                f for f in glob.glob(os.path.join(h["path"], "temp*_input"))
            )
            if inputs:
                return {"path": h["path"], "label": "GPU", "inputs": inputs}
    return None


def list_disks():
    """全部可测温磁盘：[{name, model, kind, temp}]。

    drivetemp/nvme hwmon 的 device realpath 与 /sys/block/<sdX> 的
    父设备 realpath 相同，据此建立 盘名<->hwmon 映射。
    """
    disks = []
    # 建 block 父目录 -> 盘名 映射
    parent_of = {}
    for blk in glob.glob("/sys/block/sd*") + glob.glob("/sys/block/nvme*n*"):
        name = os.path.basename(blk)
        real = os.path.realpath(blk)          # .../<target>/block/sda 或 nvme0/nvme0n1
        if name.startswith("nvme"):
            parent = os.path.dirname(real)     # .../nvme0
        else:
            parent = os.path.dirname(os.path.dirname(real))  # .../<target>/0:0:0:0
        parent_of[parent] = name
    for h in list_hwmons():
        if h["name"] not in ("drivetemp", "nvme"):
            continue
        dev = os.path.realpath(os.path.join(h["path"], "device"))
        name = parent_of.get(dev)
        if not name:
            continue
        model = ""
        for mp in ("/sys/block/%s/device/model" % name,
                   "/sys/block/%s/device/nvme/model" % ""):
            pass
        # nvme model 在 /sys/class/nvme/nvme0/model；SATA 在 device/model
        if name.startswith("nvme"):
            nv = name.removesuffix("n1") if name.endswith("n1") else name
            model = _read("/sys/class/nvme/%s/model" % name.rstrip("0123456789n")) or \
                _read("/sys/block/%s/device/model" % name)
        else:
            model = _read("/sys/block/%s/device/model" % name)
        temps = sorted(
            f for f in glob.glob(os.path.join(h["path"], "temp*_input"))
            if _read(f.replace("_input", "_label")) in ("", "Composite", "Drive temp")
            or True
        )
        temp = None
        for t in temps:                      # 取第一个有效温度（Composite 优先已排序）
            v = _read_int(t)
            if v is not None and 0 < v < 90000:   # drivetemp 偶有 0/dummy
                temp = v
                break
        disks.append({
            "name": name,
            "model": " ".join(model.split()) if model else name,
            "kind": "nvme" if h["name"] == "nvme" else "sata",
            "temp": round(temp / 1000.0, 1) if temp is not None else None,
        })
    return disks


def find_pwm():
    """探测主控 PWM 通道：优先 nct67xx 且有转速的 fan。"""
    best = None
    for h in list_hwmons():
        pwms = sorted(glob.glob(os.path.join(h["path"], "pwm[0-9]")))
        for pw in pwms:
            idx = re.findall(r"pwm(\d+)", pw)[0]
            fan = os.path.join(h["path"], "fan%s_input" % idx)
            fan_rpm = _read_int(fan) or 0
            cand = {
                "hwmon": h["path"], "name": h["name"],
                "pwm_file": pw,
                "enable_file": pw + "_enable",
                "fan_file": fan,
                "fan_rpm": fan_rpm,
            }
            if h["name"].startswith("nct6") and fan_rpm > 0:
                return cand                  # 最佳：NCT 芯片 + 风扇在转
            if best is None and fan_rpm > 0:
                best = cand
    return best or best


def read_temps(inputs):
    """读一组 temp*_input，返回有效摄氏度列表。"""
    out = []
    for f in inputs:
        v = _read_int(f)
        if v is not None and 0 < v < 120000:
            out.append(v / 1000.0)
    return out
