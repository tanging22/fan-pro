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
let curveTab = "cpu";      // 当前曲线 tab
let editingCurve = null;   // 编辑中的曲线数组
let tmTarget = null;       // 温度弹窗目标 cpu/disk
let diskListCache = [];

/* ---------------- 状态轮询 ---------------- */
async function poll() {
  const r = await api("GET", "/api/status");
  if (!r.ok) return;
  const s = r.data;
  // 转速 & 风扇动画
  const rpm = s.rpm || 0;
  $("#rpm").textContent = rpm || "--";
  const dur = rpm > 0 ? Math.max(0.32, Math.min(3.5, 3.5 - (rpm / 1000) * 1.15)) : 0;
  const blades = $("#blades");
  blades.style.setProperty("--spin-dur", dur + "s");
  blades.style.animationPlayState = rpm > 0 ? "running" : "paused";
  // PWM 进度条
  const pwm = s.pwm || 0;
  $("#pwm-bar").style.width = Math.round((pwm / 255) * 100) + "%";
  $("#pwm-label").textContent = "PWM " + pwm + " / 255";
  // 生效说明
  const th = s.threshold;
  let line = "";
  if (s.mode === "manual") {
    line = "手动定速 · PWM <b>" + s.target_pwm + "</b>";
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
  $("#disk-method-label").textContent = t.disk_method === "avg" ? "平均" : "最高";
  // 模式按钮
  $$("#mode-seg .seg-btn").forEach(b => b.classList.toggle("on", b.dataset.mode === s.mode));
  $("#manual-box").classList.toggle("hidden", s.mode !== "manual");
  if (s.mode === "manual" && document.activeElement !== $("#pwm-slider")) {
    $("#pwm-slider").value = s.target_pwm;
    $("#slider-val").textContent = s.target_pwm;
  }
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
  // 滑条初值
  $("#pwm-slider").value = CFG.manual_pwm ?? 128;
  $("#slider-val").textContent = CFG.manual_pwm ?? 128;
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
  if (r.ok) { toast(b.dataset.mode === "manual" ? "已切手动定速" : "已切自动曲线", "good"); poll(); }
  else toast(r.error, "bad");
});

let pwmTimer = null;
$("#pwm-slider").addEventListener("input", (e) => {
  $("#slider-val").textContent = e.target.value;
  clearTimeout(pwmTimer);
  pwmTimer = setTimeout(async () => {
    const r = await api("POST", "/api/pwm", { pwm: +e.target.value });
    if (!r.ok) toast(r.error, "bad");
  }, 350);
});

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

/* ---------------- 曲线编辑 ---------------- */
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
    <div class="curve-row">
      <input type="number" data-i="${i}" data-k="temp" value="${p.temp}" step="1"> °C
      <span style="color:var(--dim)">→</span>
      <input type="number" data-i="${i}" data-k="pwm" value="${p.pwm}" min="0" max="255" step="1"> PWM
      <span class="del" data-i="${i}">✕</span>
    </div>`).join("");
  $$("#curve-rows input").forEach(inp => inp.oninput = () => {
    const p = editingCurve[+inp.dataset.i];
    if (!p) return;
    p[inp.dataset.k] = +inp.value;
    drawCurve();
  });
  $$("#curve-rows .del").forEach(d => d.onclick = () => {
    editingCurve.splice(+d.dataset.i, 1);
    renderCurve();
  });
  drawCurve();
}

$("#curve-add").onclick = () => {
  const last = editingCurve[editingCurve.length - 1] || { temp: 40, pwm: 100 };
  editingCurve.push({ temp: last.temp + 5, pwm: Math.min(255, last.pwm + 25) });
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

function drawCurve() {
  const cv = $("#curve-canvas");
  const W = cv.clientWidth || 600, H = 150;
  cv.width = W * devicePixelRatio; cv.height = H * devicePixelRatio;
  const ctx = cv.getContext("2d");
  ctx.scale(devicePixelRatio, devicePixelRatio);
  ctx.clearRect(0, 0, W, H);
  const pts = [...editingCurve].sort((a, b) => a.temp - b.temp);
  if (!pts.length) return;
  const tMin = pts[0].temp - 4, tMax = pts[pts.length - 1].temp + 4;
  const pad = { l: 34, r: 12, t: 12, b: 20 };
  const X = (t) => pad.l + (t - tMin) / (tMax - tMin || 1) * (W - pad.l - pad.r);
  const Y = (p) => H - pad.b - p / 255 * (H - pad.t - pad.b);
  // 网格
  ctx.strokeStyle = "#1c3242"; ctx.lineWidth = 1;
  ctx.font = "10px sans-serif"; ctx.fillStyle = "#5b7f99";
  for (let p = 0; p <= 255; p += 64) {
    ctx.beginPath(); ctx.moveTo(pad.l, Y(p)); ctx.lineTo(W - pad.r, Y(p)); ctx.stroke();
    ctx.fillText(p, 6, Y(p) + 3);
  }
  for (let t = Math.ceil(tMin / 10) * 10; t <= tMax; t += 10) {
    ctx.fillText(t + "°", X(t) - 8, H - 6);
  }
  // 折线
  ctx.strokeStyle = "#3fc3ec"; ctx.lineWidth = 2;
  ctx.beginPath();
  pts.forEach((p, i) => i ? ctx.lineTo(X(p.temp), Y(p.pwm)) : ctx.moveTo(X(p.temp), Y(p.pwm)));
  ctx.stroke();
  // 点
  ctx.fillStyle = "#7de3ff";
  pts.forEach(p => { ctx.beginPath(); ctx.arc(X(p.temp), Y(p.pwm), 3.5, 0, 7); ctx.fill(); });
  // 当前温度竖线
  const cur = curveTab === "cpu" ? parseFloat($("#t-cpu").textContent) : parseFloat($("#t-disk").textContent);
  if (!isNaN(cur) && cur >= tMin && cur <= tMax) {
    ctx.strokeStyle = "#ffb648"; ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(X(cur), pad.t); ctx.lineTo(X(cur), H - pad.b); ctx.stroke();
    ctx.setLineDash([]);
  }
}

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

window.addEventListener("resize", drawCurve);
loadConfig().then(() => { poll(); setInterval(poll, 2000); setInterval(drawCurve, 4000); });
