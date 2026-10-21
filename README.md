# 风扇管家 fan-pro

fnOS 上的本机风扇 PWM 智能调控应用：直读 sysfs 硬件传感器（CPU / GPU / 硬盘温度、风扇转速），按温度曲线自动调速，或手动定速；超温时通过 Bark 推送到手机。

## 功能

- **转动风扇动画**：主页左侧风扇随真实转速转动，右侧大字 RPM + PWM 进度条 + 当前生效档位说明
- **自动 / 手动双模式**：
  - 自动：联动温度曲线（CPU 曲线与硬盘曲线取较大 PWM）动态调节
  - 手动：滑条直接设定 PWM（20-255），立即生效
- **温度三卡**：CPU、GPU、硬盘实时温度
  - CPU / 硬盘可分别设置计算方式：**取最高** 或 **取平均**（滑动平均去抖）
  - 硬盘不统计所有盘：可勾选参与计算的盘（例如只关心机械盘）
- **温度曲线编辑**：CPU、硬盘两条曲线独立设置（温度 → PWM 档位，档位间线性过渡），带实时折线图与当前温度落点
- **Bark 通知**：CPU / 硬盘超温推送（可带图标、分组），温度恢复也会通知；支持测试发送
- **硬件安全**：退出时把 PWM 通道交还主板自动模式（restore_on_exit）；检测到 fn-fan 同时在跑会在界面提示

## 安装

1. 应用中心安装 `fan-pro-<版本>-amd64.fpk`（Release 页下载）
2. 桌面打开「风扇管家」——走 fnOS 统一网关，无需额外配置
3. **注意**：本应用接管主板 PWM 通道，请先停用或卸载旧的 fn-fan，避免两个程序打架

## 硬件支持

- 温度源自动探测：`coretemp`/`k10temp`（CPU）、`i915`/`amdgpu`（GPU）、`drivetemp`/`nvme`（硬盘，按块设备映射盘名）
- PWM 通道自动探测：优先 NCT67xx 监控芯片中有风扇在转的通道（与 fn-fan 相同的 pwm2）
- 写 PWM 需要 root，安装时以 root 运行（install_type=root）

## 开发

```bash
./build.sh                # 构建 FPK 到 dist/
FAN_FAKE=1 FANPRO_DATA_DIR=/tmp/fanpro FANPRO_PORT=28201 python3 app/server/app.py
# FAN_FAKE=1：演练模式，不写 sysfs（普通用户开发用）
```

## 目录

```
app/server/hwmon.py       sysfs 探测（CPU/GPU/盘温度、PWM/转速通道）
app/server/fancontrol.py  控制引擎（采样、曲线、PWM 写入、Bark 告警）
app/server/app.py         Flask API（/api/status|config|disks|mode|pwm|bark/test）
app/ui/                   单页前端（风扇动画、曲线编辑、Bark 设置）
fpk/                      manifest、cmd 脚本、图标、向导
```
