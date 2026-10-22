/* 风扇管家 fan-pro 前端 */
"use strict";

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const _BASE = location.pathname.startsWith("/app/")
  ? location.pathname.replace(/\/+$/, "") : "";

async function api(method, path, body) {
  try {
    const r = await fetch(_BASE + path, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    return await r.json();
  } catch (e) {
    return { ok: false, error: "网络异常：" + e.message };
  }
}

let toastTimer = null;
function toast(msg, kind = "", ms = 2600) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = kind;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), ms);
}

let CFG = null;            // 服务端配置副本
let MODE = "auto";         // 实时模式（轮询更新，竖条拖动判断用）
let curveTab = "cpu";      // 当前曲线 tab
let editingCurve = null;   // 编辑中的曲线数组
let tmTarget = null;       // 温度弹窗目标 cpu/disk
let diskListCache = [];

function fmtUptime(sec) {
  if (!sec || sec < 60) return sec ? sec + " 秒" : "--";
  const d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600), m = Math.floor(sec % 3600 / 60);
  if (d) return d + " 天 " + h + " 小时";
  if (h) return h + " 小时 " + m + " 分";
  return m + " 分钟";
}

/* ---------------- 状态轮询 ---------------- */
function maxRpm() { return (CFG && CFG.fan && CFG.fan.max_rpm) || 3000; }

const rail = $("#rail-track");
let railDrag = false;
let railPid = null;
function railVertical() {
  const rect = rail.getBoundingClientRect();
  return rect.height > rect.width;   // 窄屏立起来时高>宽
}

async function poll() {
  const r = await api("GET", "/api/status");
  if (!r.ok) return;
  const s = r.data;
  MODE = s.mode || "auto";
  const mr = maxRpm();
  // 转速（风扇动画由 rAF 循环按百分比平滑驱动，此处只更新数字）
  const rpm = s.rpm || 0;
  $("#rpm").textContent = rpm || "--";
  rpmNow = rpm;
  // 下发转速条（桌面横放 / 窄屏立右侧）：填充 + 手柄（拖动中不被轮询覆盖）
  // 手动模式基准 = manual_pwm（当前设定，打开即在正确位置）；自动 = 实际下发 target_pwm
  const basePwm = s.mode === "manual" ? (s.manual_pwm ?? s.target_pwm ?? s.pwm ?? 0)
                                      : (s.target_pwm ?? s.pwm ?? 0);
  const tgtRpm = Math.round((basePwm / 255) * mr);
  const pctN = Math.round(Math.max(0, Math.min(100, (tgtRpm / mr) * 100)));
  const pct = pctN + "%";                 // 显示用
  const pc = pct;                          // 样式用（同一值，勿再加 %）
  if (!railDrag) {
    if (railVertical()) {
      $("#rail-fill").style.width = "100%";
      $("#rail-fill").style.height = pc;
      $("#rail-thumb").style.bottom = "calc(" + pc + " - 12px)";
    } else {
      $("#rail-fill").style.width = pc;
      $("#rail-fill").style.height = "100%";
      $("#rail-thumb").style.left = "calc(" + pc + " - 12px)";
    }
    $("#rail-label").textContent = (s.mode === "manual" ? "手动 · " : "下发 · ") + pct;
  }
  $("#rail-thumb").style.opacity = s.mode === "manual" ? 1 : 0.55;
  $("#rail-track").classList.toggle("draggable", s.mode === "manual");

  // 生效说明
  const th = s.threshold;
  let line = "";
  if (s.mode === "manual") {
    line = "手动定速 · <b>" + Math.round((s.target_pwm || 0) / 255 * 100) + "%</b>（PWM " + s.target_pwm + "）";
  } else if (s.active === "disk" && th) {
    line = "自动 · <b>硬盘曲线</b>起作用（" + th.low.temp + "–" + th.high.temp + "°C 档 → PWM " + th.high.pwm + "）";
  } else if (s.active === "cpu" && th) {
    line = "自动 · <b>CPU 曲线</b>起作用（" + th.low.temp + "–" + th.high.temp + "°C 档 → PWM " + th.high.pwm + "）";
  } else if (s.active === "hold") {
    line = "自动 · 等待温度数据…";
  } else {
    line = "自动 · PWM " + s.target_pwm;
  }
  if (s.fake) line += ' <span class="mini">演练模式（不写硬件）</span>';
  $("#active-line").innerHTML = line;
  // 错误
  const errs = (s.errors || []).join("；");
  $("#err-line").textContent = errs;
  $("#err-line").classList.toggle("hidden", !errs);
  // 冲突提示
  $("#conflict").classList.toggle("hidden", !(s.conflicts || []).length);
  // 温度
  const t = s.temps || {};
  $("#t-cpu").innerHTML = t.cpu != null ? t.cpu.toFixed(1) + '<span class="deg"> °C</span>' : "--";
  $("#t-gpu").innerHTML = t.gpu != null ? t.gpu.toFixed(1) + '<span class="deg"> °C</span>' : "--";
  $("#t-disk").innerHTML = t.disk != null ? t.disk.toFixed(1) + '<span class="deg"> °C</span>' : "--";
  $("#cpu-method-label").textContent = t.cpu_method === "avg" ? "平均" : "最高";
  // 本次运行统计
  $("#st-uptime").textContent = fmtUptime(s.uptime || 0);
  const stt = s.stats || {};
  const tmax = [];
  if (stt.max_cpu != null) tmax.push("CPU " + stt.max_cpu + "°C");
  if (stt.max_disk != null) tmax.push("盘 " + stt.max_disk + "°C");
  $("#st-tmax").textContent = tmax.length ? tmax.join(" · ") : "--";
  $("#st-rmax").textContent = stt.max_rpm ? stt.max_rpm.toLocaleString() + " RPM" : "--";
  $("#disk-method-label").textContent = t.disk_method === "avg" ? "平均" : "最高";
  // 模式按钮
  $$("#mode-seg .seg-btn").forEach(b => b.classList.toggle("on", b.dataset.mode === s.mode));
  $("#manual-box").classList.toggle("hidden", s.mode !== "manual");
  $("#auto-box").classList.toggle("hidden", s.mode === "manual");
}

/* ---------------- 配置 ---------------- */
async function loadConfig() {
  const r = await api("GET", "/api/config");
  if (!r.ok) return toast("读取配置失败", "bad");
  CFG = r.data;
  $("#hostname").textContent = "· " + (CFG.alert?.hostname || "NAS");
  // bark 表单
  const b = CFG.bark || {};
  $("#bark-on").checked = !!b.enabled;
  $("#bark-url").value = b.url || "";
  $("#bark-icon").value = b.icon || "";
  $("#bark-group").value = b.group || "";
  const a = CFG.alert || {};
  $("#alert-cpu").value = a.cpu_temp ?? 62;
  $("#alert-disk").value = a.disk_temp ?? 42;
  $("#alert-interval").value = a.interval ?? 60;
  switchCurve(curveTab);
}

async function saveConfig(patch, quiet) {
  const next = JSON.parse(JSON.stringify(CFG));
  (function merge(dst, src) {
    for (const k in src) {
      if (src[k] && typeof src[k] === "object" && !Array.isArray(src[k]) && dst[k]) {
        merge(dst[k], src[k]);
      } else dst[k] = src[k];
    }
  })(next, patch);
  const r = await api("POST", "/api/config", next);
  if (!r.ok) return toast("保存失败：" + r.error, "bad"), false;
  CFG = r.data;
  if (!quiet) toast("已保存", "good");
  return true;
}

/* ---------------- 模式 & 滑条 ---------------- */
$$("#mode-seg .seg-btn").forEach(b => b.onclick = async () => {
  const r = await api("POST", "/api/mode", { mode: b.dataset.mode });
  if (r.ok) { MODE = b.dataset.mode; CFG.mode = MODE; toast(MODE === "manual" ? "已切手动定速" : "已切自动曲线", "good"); poll(); }
  else toast(r.error, "bad");
});

let pwmTimer = null;
function sendTargetRpm(rpm) {
  clearTimeout(pwmTimer);
  pwmTimer = setTimeout(async () => {
    const r = await api("POST", "/api/pwm", { rpm });
    if (!r.ok) toast(r.error, "bad");
  }, 350);
}



/* 竖直转速条拖动（窄屏显示；手动模式下可拖动控制转速） */
function railApply(clientX, clientY) {
  const rect = rail.getBoundingClientRect();
  const mr = maxRpm();
  let ratio;
  if (railVertical()) ratio = 1 - (clientY - rect.top) / rect.height;      // 竖：顶=满速
  else ratio = (clientX - rect.left) / rect.width;                          // 横：右=满速
  const clamped = Math.max(0, Math.min(1, ratio));
  const rpm = Math.round(clamped * mr);
  const pc = (clamped * 100) + "%";
  if (railVertical()) {
    $("#rail-fill").style.width = "100%";
    $("#rail-fill").style.height = pc;
    $("#rail-thumb").style.bottom = "calc(" + pc + " - 12px)";
  } else {
    $("#rail-fill").style.width = pc;
    $("#rail-fill").style.height = "100%";
    $("#rail-thumb").style.left = "calc(" + pc + " - 12px)";
  }
  $("#rail-label").textContent = "手动 · " + Math.round(clamped * 100) + "%";
  if (MODE === "manual") { sendTargetRpm(rpm); CFG.manual_pwm = Math.round(clamped * 255); }
}

rail.addEventListener("pointerdown", (e) => {
  if (MODE !== "manual") return;   // 自动模式只显示不可拖
  railDrag = true;
  railPid = e.pointerId;
  try { rail.setPointerCapture(e.pointerId); } catch (err) { /* 合成事件无真实指针 */ }
  railApply(e.clientX, e.clientY);
  e.preventDefault();
});
rail.addEventListener("pointermove", (e) => {
  if (railDrag && e.pointerId === railPid) railApply(e.clientX, e.clientY);
});
rail.addEventListener("pointerup", () => railDrag = false);
rail.addEventListener("pointercancel", () => railDrag = false);

/* ---------------- 温度设置弹窗 ---------------- */
$$(".link-btn[data-set]").forEach(b => b.onclick = () => openTempModal(b.dataset.set));

function openTempModal(target) {
  tmTarget = target;
  $("#tm-title").textContent = target === "cpu" ? "CPU 温度设置" : "硬盘温度设置";
  const method = CFG[target]?.method || "max";
  $$("#tm-method .seg-btn").forEach(b => b.classList.toggle("on", b.dataset.v === method));
  $("#tm-disks").classList.toggle("hidden", target !== "disk");
  if (target === "disk") renderDiskPick();
  $("#modal-temp").classList.remove("hidden");
}

async function renderDiskPick() {
  const r = await api("GET", "/api/disks");
  diskListCache = r.ok ? r.data.disks : [];
  const chosen = new Set(CFG.disk?.disks || []);
  $("#tm-disk-list").innerHTML = diskListCache.map(d => `
    <label class="disk-item">
      <input type="checkbox" value="${d.name}" ${!chosen.size || chosen.has(d.name) ? "checked" : ""}>
      <span>${d.name}</span><span class="d-model">${d.model} · ${d.temp != null ? d.temp + "°C" : "无温度"}</span>
    </label>`).join("");
}

$$("#tm-method .seg-btn").forEach(b => b.onclick = () => {
  $$("#tm-method .seg-btn").forEach(x => x.classList.remove("on"));
  b.classList.add("on");
});

$("#tm-cancel").onclick = () => $("#modal-temp").classList.add("hidden");
$("#tm-save").onclick = async () => {
  const method = $("#tm-method .seg-btn.on")?.dataset.v || "max";
  const patch = {};
  if (tmTarget === "cpu") patch.cpu = { method };
  else {
    const sel = $$("#tm-disk-list input:checked").map(i => i.value);
    patch.disk = { method, disks: sel };
  }
  if (await saveConfig(patch)) {
    $("#modal-temp").classList.add("hidden");
    toast("已保存，稍等几秒生效", "good");
  }
};

/* ---------------- 曲线编辑（表格 + 可拖动画布） ---------------- */
$$(".tab").forEach(t => t.onclick = () => switchCurve(t.dataset.curve));

function switchCurve(tab) {
  curveTab = tab;
  $$(".tab").forEach(t => t.classList.toggle("on", t.dataset.curve === tab));
  editingCurve = JSON.parse(JSON.stringify(CFG?.[tab]?.curve || []));
  renderCurve();
}

function renderCurve() {
  editingCurve.sort((a, b) => a.temp - b.temp);
  $("#curve-rows").innerHTML = editingCurve.map((p, i) => `
    <div class="curve-row" data-i="${i}">
      <input type="number" data-i="${i}" data-k="temp" value="${p.temp}" step="1"> °C
      <span style="color:var(--dim)">→</span>
      <input type="number" data-i="${i}" data-k="pwm" value="${p.pwm}" min="0" max="255" step="1"> PWM
      <span class="del" data-i="${i}">✕</span>
    </div>`).join("");
  $$("#curve-rows input").forEach(inp => {
    inp.oninput = () => {                       // 输入中：只更新数据 + 重画曲线，绝不重建表格（保住焦点）
      const p = editingCurve[+inp.dataset.i];
      if (!p) return;
      p[inp.dataset.k] = +inp.value;
      drawCurve();
    };
    inp.onchange = () => {                      // 提交（失焦/回车）：只有顺序变了才重建行
      const p = editingCurve[+inp.dataset.i];
      if (p && inp.dataset.k === "pwm") p.pwm = Math.max(0, Math.min(255, +inp.value || 0));
      const before = editingCurve.map(x => x.temp).join(",");
      editingCurve.sort((a, b) => a.temp - b.temp);
      const after = editingCurve.map(x => x.temp).join(",");
      if (before !== after) renderCurve();
      else drawCurve();
    };
  });
  $$("#curve-rows .del").forEach(d => d.onclick = () => {
    editingCurve.splice(+d.dataset.i, 1);
    renderCurve();
  });
  drawCurve();
}

$("#curve-add").onclick = () => {
  const last = editingCurve[editingCurve.length - 1] || { temp: 40, pwm: 100 };
  editingCurve.push({ temp: Math.min(95, last.temp + 5), pwm: Math.min(255, last.pwm + 25) });
  renderCurve();
};

$("#curve-save").onclick = async () => {
  const clean = editingCurve
    .filter(p => p.temp != null && p.pwm != null && !isNaN(p.temp))
    .map(p => ({ temp: +p.temp, pwm: Math.max(0, Math.min(255, +p.pwm)) }))
    .sort((a, b) => a.temp - b.temp);
  if (clean.length < 2) return toast("至少要两个档位", "bad");
  const patch = {};
  patch[curveTab] = { curve: clean };
  if (await saveConfig(patch)) toast("曲线已保存", "good");
};

/* 画布视图参数（拖拽换算用） */
let view = null;

function drawCurve() {
  const cv = $("#curve-canvas");
  const W = cv.clientWidth || 600, H = cv.clientHeight || 170;
  cv.width = W * devicePixelRatio; cv.height = H * devicePixelRatio;
  const ctx = cv.getContext("2d");
  ctx.scale(devicePixelRatio, devicePixelRatio);
  ctx.clearRect(0, 0, W, H);
  const pts = [...editingCurve].sort((a, b) => a.temp - b.temp);
  if (!pts.length) { view = null; return; }
  const tMin = Math.min(20, pts[0].temp - 4), tMax = Math.max(90, pts[pts.length - 1].temp + 4);
  const pad = { l: 36, r: 14, t: 14, b: 24 };
  const X = (t) => pad.l + (t - tMin) / (tMax - tMin || 1) * (W - pad.l - pad.r);
  const Y = (p) => H - pad.b - p / 255 * (H - pad.t - pad.b);
  view = { W, H, pad, tMin, tMax, X, Y, pts };
  // 网格
  ctx.strokeStyle = "#dbe4ec"; ctx.lineWidth = 1;
  ctx.font = "10px sans-serif"; ctx.fillStyle = "#8aa0b2";
  for (let p = 0; p <= 255; p += 64) {
    ctx.beginPath(); ctx.moveTo(pad.l, Y(p)); ctx.lineTo(W - pad.r, Y(p)); ctx.stroke();
    ctx.fillText(p, 4, Y(p) + 3);
  }
  for (let t = Math.ceil(tMin / 10) * 10; t <= tMax; t += 10) {
    ctx.fillText(t + "°", X(t) - 8, H - 8);
  }
  // 折线
  ctx.strokeStyle = "#0ea5c9"; ctx.lineWidth = 2;
  ctx.beginPath();
  pts.forEach((p, i) => i ? ctx.lineTo(X(p.temp), Y(p.pwm)) : ctx.moveTo(X(p.temp), Y(p.pwm)));
  ctx.stroke();
  // 点
  pts.forEach(p => {
    ctx.beginPath(); ctx.arc(X(p.temp), Y(p.pwm), 5, 0, 7);
    ctx.fillStyle = "#ffffff"; ctx.fill();
    ctx.lineWidth = 2.5; ctx.strokeStyle = "#0d7bb0"; ctx.stroke();
  });
  // 当前温度竖线
  const cur = curveTab === "cpu" ? parseFloat($("#t-cpu").textContent) : parseFloat($("#t-disk").textContent);
  if (!isNaN(cur) && cur >= tMin && cur <= tMax) {
    ctx.strokeStyle = "#e09a2e"; ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(X(cur), pad.t); ctx.lineTo(X(cur), H - pad.b); ctx.stroke();
    ctx.setLineDash([]);
  }
}

/* 拖拽交互：命中节点拖动 / 点击线段插入 */
const cvEl = () => $("#curve-canvas");

function canvasPos(e) {
  const r = cvEl().getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

let dragIdx = -1;

cvEl().addEventListener("pointerdown", (e) => {
  if (!view) return;
  const p = canvasPos(e);
  const pts = view.pts;
  // 命中最近点
  let best = -1, bestD = 24;
  pts.forEach((pt, i) => {
    const d = Math.hypot(p.x - view.X(pt.temp), p.y - view.Y(pt.pwm));
    if (d < bestD) { bestD = d; best = i; }
  });
  if (best >= 0) {
    dragIdx = best;
    cvEl().setPointerCapture(e.pointerId);
    e.preventDefault();
    return;
  }
  // 点击空白线段 → 插入新档位
  if (p.x > view.pad.l && p.x < view.W - view.pad.r && p.y > view.pad.t && p.y < view.H - view.pad.b) {
    const t = Math.round(view.tMin + (p.x - view.pad.l) / (view.W - view.pad.l - view.pad.r) * (view.tMax - view.tMin));
    const pw = Math.round((view.H - view.pad.b - p.y) / (view.H - view.pad.t - view.pad.b) * 255);
    editingCurve.push({ temp: Math.min(95, Math.max(20, t)), pwm: Math.max(0, Math.min(255, pw)) });
    renderCurve();
  }
});

cvEl().addEventListener("pointermove", (e) => {
  if (dragIdx < 0 || !view) return;
  const p = canvasPos(e);
  const pt = editingCurve[dragIdx];
  if (!pt) return;
  const raw = Math.round(view.tMin + (p.x - view.pad.l) / (view.W - view.pad.l - view.pad.r) * (view.tMax - view.tMin));
  // 温度夹在相邻档位之间，保持单调
  const sorted = [...editingCurve].sort((a, b) => a.temp - b.temp);
  const i = sorted.indexOf(pt);
  const lo = i > 0 ? sorted[i - 1].temp + 1 : 20;
  const hi = i < sorted.length - 1 ? sorted[i + 1].temp - 1 : 95;
  pt.temp = Math.min(hi, Math.max(lo, raw));
  pt.pwm = Math.max(0, Math.min(255, Math.round((view.H - view.pad.b - p.y) / (view.H - view.pad.t - view.pad.b) * 255)));
  // 同步表格（不整体重渲染，避免拖动中丢失焦点）
  const rows = $$("#curve-rows .curve-row");
  const row = rows[dragIdx];
  if (row) {
    row.querySelector('[data-k="temp"]').value = pt.temp;
    row.querySelector('[data-k="pwm"]').value = pt.pwm;
  }
  drawCurve();
});

function endDrag() {
  if (dragIdx >= 0) {
    editingCurve.sort((a, b) => a.temp - b.temp);
    renderCurve();
    dragIdx = -1;
  }
}
cvEl().addEventListener("pointerup", endDrag);
cvEl().addEventListener("pointercancel", endDrag);

/* ---------------- Bark ---------------- */
$("#bark-test").onclick = async () => {
  // 先把表单值存了再测试
  await collectNotifyForm(true);
  const r = await api("POST", "/api/bark/test");
  if (r.ok && r.data.sent) toast("测试通知已发出，看一眼手机", "good", 4000);
  else toast(r.error || "发送失败", "bad", 4000);
};

$("#notify-save").onclick = async () => {
  if (await collectNotifyForm()) toast("通知设置已保存", "good");
};

async function collectNotifyForm(quiet) {
  const patch = {
    bark: {
      enabled: $("#bark-on").checked,
      url: $("#bark-url").value.trim(),
      icon: $("#bark-icon").value.trim(),
      group: $("#bark-group").value.trim() || "fan-pro",
    },
    alert: {
      hostname: (CFG.alert?.hostname) || "NAS",
      enabled: CFG.alert?.enabled ?? true,
      cpu_temp: +$("#alert-cpu").value || 62,
      disk_temp: +$("#alert-disk").value || 42,
      interval: +$("#alert-interval").value || 60,
    },
  };
  return saveConfig(patch, quiet);
}

/* ---------------- 卡片收纳（曲线 / 通知默认收起） ---------------- */
$$(".fold-btn").forEach(b => b.onclick = () => {
  const card = b.closest(".card");
  card.classList.toggle("open");
  b.textContent = card.classList.contains("open") ? "收起" : "设置";
  if (card.classList.contains("curve-card") && card.classList.contains("open"))
    requestAnimationFrame(drawCurve);   // 展开后画布才有宽度，重画一次
});

/* ---------------- 风扇平滑转动：rAF 按百分比调速，变速时角度连续无跳变 ---------------- */
let rpmNow = 0, fanAngle = 0, fanLast = 0;
const fanBlades = $("#blades");
function fanLoop(t) {
  requestAnimationFrame(fanLoop);
  if (!fanLast) { fanLast = t; return; }
  const dt = Math.min(0.1, (t - fanLast) / 1000);   // 切后台回来不跳帧
  fanLast = t;
  if (rpmNow <= 0) return;                          // 0 转停转
  const rps = 0.25 + rpmNow / maxRpm();             // 转速百分比线性加快：100% ≈ 1.25 转/秒
  fanAngle = (fanAngle + rps * 360 * dt) % 360;
  fanBlades.setAttribute("transform", "rotate(" + fanAngle.toFixed(2) + " 100 100)");
}
requestAnimationFrame(fanLoop);

window.addEventListener("resize", drawCurve);
loadConfig().then(() => { poll(); setInterval(poll, 2000); setInterval(drawCurve, 4000); });
