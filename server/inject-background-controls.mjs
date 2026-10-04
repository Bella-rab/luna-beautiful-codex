const target = (await (await fetch("http://127.0.0.1:9229/json/list")).json())
  .find(item => item.type === "page" && item.url === "app://-/index.html");
if (!target) throw new Error("Codex main page target not found");

const socket = new WebSocket(target.webSocketDebuggerUrl);
let nextId = 1;
const pending = new Map();

socket.onmessage = event => {
  const message = JSON.parse(event.data);
  if (!message.id || !pending.has(message.id)) return;
  const waiter = pending.get(message.id);
  pending.delete(message.id);
  if (message.error) waiter.reject(new Error(message.error.message));
  else waiter.resolve(message.result);
};

function send(method, params = {}) {
  const id = nextId++;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`CDP command timed out: ${method}`));
      }
    }, 10000);
  });
}

await new Promise((resolve, reject) => {
  socket.onopen = resolve;
  socket.onerror = () => reject(new Error("Unable to connect to Codex DevTools"));
});

const expression = `(() => {
  document.getElementById("codex-background-controls")?.remove();
  const host = document.createElement("div");
  host.id = "codex-background-controls";
  host.style.cssText = "display:none!important;position:fixed;top:88px;right:22px;z-index:2147483647;pointer-events:none!important";
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = \`
    <style>
      :host{all:initial;font-family:"Segoe UI","Microsoft YaHei",sans-serif;color:#f4f7ff}
      .panel{width:270px;padding:14px;border:1px solid rgba(255,255,255,.18);border-radius:16px;background:rgba(8,13,24,.95);box-shadow:0 18px 55px #0009}
      .head{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;cursor:move;user-select:none}
      .title{font:700 14px/1 inherit}
      .close{width:24px;height:24px;border:0;border-radius:8px;background:rgba(255,255,255,.14);color:#fff;cursor:pointer;font:600 14px/1 inherit}
      .value{display:flex;justify-content:space-between;align-items:baseline}
      output{font-size:27px;font-weight:750;color:#7dd3fc}
      span{font-size:12px;color:#a4b3ca}
      input{width:100%;height:30px;margin:8px 0 0;accent-color:#38bdf8}
      .presets{display:grid;grid-template-columns:repeat(5,1fr);gap:6px;margin-top:9px}
      .modes{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-top:10px}
      .modes button.active{background:rgba(125,211,252,.48)}
      button{border:0;border-radius:8px;padding:8px 0;background:rgba(56,189,248,.22);color:#f8fbff;font:650 12px/1 inherit;cursor:pointer}
      button:hover{background:rgba(56,189,248,.38)}
      .status{min-height:17px;margin:9px 0 0;color:#a7b6ce;font-size:12px;text-align:center}
      .readout{display:flex;justify-content:space-between;align-items:baseline;margin-top:12px}
      .readout span{font-size:12px;color:#a4b3ca}
      .chip{display:none;position:fixed;top:88px;right:22px;padding:9px 11px;border:1px solid rgba(255,255,255,.2);border-radius:12px;background:rgba(8,13,24,.95);color:#f4f7ff;font:650 12px/1 inherit;cursor:pointer}
    </style>
    <div class="panel">
      <div class="head"><div class="title">背景透明度</div><button class="close" title="收起">–</button></div>
      <div class="value"><output>100%</output><span>壁纸不透明度</span></div>
      <input type="range" min="0" max="100" step="1" value="100">
      <div class="readout"><output id="readability-output">45%</output><span>背景协调气泡</span></div>
      <input id="readability" type="range" min="0" max="100" step="1" value="45">
      <div class="modes">
        <button data-mode="halo">纯净</button><button data-mode="soft" class="active">柔光</button><button data-mode="bubble">气泡</button>
      </div>
      <div class="presets">
        <button data-value="100">100</button><button data-value="75">75</button><button data-value="50">50</button><button data-value="25">25</button><button data-value="0">隐藏</button>
      </div>
      <div class="status">正在读取背景…</div>
    </div>
    <button class="chip">背景透明度</button>
  \`;

  const media = document.getElementById("codex-custom-background-media");
  const root = shadow.querySelector(".panel");
  const chip = shadow.querySelector(".chip");
  const range = shadow.querySelector("input");
  const readabilityRange = shadow.querySelector("#readability");
  const readabilityOutput = shadow.querySelector("#readability-output");
  const output = shadow.querySelector("output");
  const status = shadow.querySelector(".status");
  const close = shadow.querySelector(".close");
  let readabilityMode = "soft";

  function render(value) {
    range.value = value;
    output.textContent = value + "%";
  }

  function apply(value) {
    const percent = Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
    render(percent);
    if (!media) {
      status.textContent = "当前没有背景";
      return;
    }
    let base = document.getElementById("codex-custom-background-base");
    if (!base) { base = document.createElement("div"); base.id = "codex-custom-background-base"; base.style.cssText = "position:fixed!important;inset:0!important;background:#000!important;z-index:0!important;pointer-events:none!important"; media.before(base); }
    const opacityStyle = document.getElementById("codex-background-opacity-style") ?? document.createElement("style");
    opacityStyle.id = "codex-background-opacity-style";
    opacityStyle.textContent = "#codex-custom-background-media,#codex-custom-background-base,#codex-custom-background-base canvas{opacity:" + percent / 100 + " !important}";
    document.head.append(opacityStyle);
    media.setAttribute("data-background-opacity", String(percent / 100));
    if (media.tagName === "VIDEO") media.play().catch(() => {});
    status.textContent = percent === 100 ? "壁纸完全显示" : percent === 0 ? "背景已隐藏" : "已应用 " + percent + "%";
  }

  function markReadabilityBubble(element, kind) {
    if (element && !element.hasAttribute("data-codex-readability-bubble")) {
      element.setAttribute("data-codex-readability-bubble", kind);
    }
  }

  function markReadabilitySurface(element, kind) {
    if (element) element.setAttribute("data-codex-readability-surface", kind);
  }

  function markReadabilityBubbles() {
    document.querySelectorAll("[data-codex-readability-bubble]").forEach(element => {
      element.removeAttribute("data-codex-readability-bubble");
    });
    document.querySelectorAll("#root, #root *").forEach(element => {
      element.style.setProperty("color", "#ffffff", "important");
      element.style.setProperty("caret-color", "#ffffff", "important");
    });
    markReadabilityBubble(document.querySelector("aside.app-shell-left-panel"), "sidebar");
    markReadabilityBubble(document.querySelector(".ProseMirror")?.closest('[class*="_ComposerLayoutRoot_"]'), "composer");
    markReadabilityBubble(document.querySelector("main > header"), "header");
    document.querySelectorAll('.thread-scroll-container [class*="group/user-message"] [class*="_bubble_"]').forEach(element => {
      markReadabilityBubble(element, "user");
    });
    document.querySelectorAll("[data-markdown-text-style=assistant-message]").forEach(element => {
      markReadabilityBubble(element.closest(".group.flex.min-w-0.flex-col"), "assistant");
    });
    document.querySelectorAll('.thread-scroll-container [class*="group/activity-header"]').forEach(element => {
      markReadabilityBubble(element.parentElement, "activity");
    });
  }

  function markReadabilitySurfaces() {
    document.querySelectorAll("[data-codex-readability-surface]").forEach(element => {
      element.removeAttribute("data-codex-readability-surface");
    });
    markReadabilitySurface(document.querySelector("aside.app-shell-left-panel"), "sidebar");
    markReadabilitySurface(document.querySelector('[class*="_ApplicationMenuTopBar_"]'), "topbar");
    markReadabilitySurface(document.querySelector("main"), "content");
    markReadabilitySurface(document.querySelector("main > header"), "header");
    markReadabilitySurface(document.querySelector(".ProseMirror")?.closest('[class*="_ComposerLayoutRoot_"]'), "composer");
  }

  function pastelTint(pixels) {
    let red = 0;
    let green = 0;
    let blue = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      red += pixels[index];
      green += pixels[index + 1];
      blue += pixels[index + 2];
    }
    const count = pixels.length / 4;
    return [red / count, green / count, blue / count]
      .map(value => Math.round(value * 0.34 + 255 * 0.66))
      .join(",");
  }

  function deepTint(pixels) {
    let red = 0;
    let green = 0;
    let blue = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      red += pixels[index];
      green += pixels[index + 1];
      blue += pixels[index + 2];
    }
    const count = pixels.length / 4;
    return [red / count, green / count, blue / count]
      .map(value => Math.round(value * 0.40 + 10 * 0.60))
      .join(",");
  }

  function updateBubbleTint() {
    if (!media || media.readyState < 2) return;
    const canvas = window.__codexBubbleTintCanvas ?? document.createElement("canvas");
    canvas.width = 24;
    canvas.height = 14;
    window.__codexBubbleTintCanvas = canvas;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.drawImage(media, 0, 0, canvas.width, canvas.height);
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    [0, 1, 2].forEach(zone => {
      const start = zone * 8;
      const end = start + 8;
      const pixels = [];
      for (let y = 0; y < canvas.height; y++) {
        for (let x = start; x < end; x++) {
          const offset = (y * canvas.width + x) * 4;
          pixels.push(data[offset], data[offset + 1], data[offset + 2], data[offset + 3]);
        }
      }
      document.documentElement.style.setProperty("--codex-bubble-tint-" + zone, pastelTint(pixels));
      document.documentElement.style.setProperty("--codex-bubble-shade-" + zone, deepTint(pixels));
    });
  }

  function applyReadability(value) {
    const percent = Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
    readabilityRange.value = percent;
    readabilityOutput.textContent = percent + "%";
    let layer = document.getElementById("codex-background-readability");
    if (!layer) {
      layer = document.createElement("div");
      layer.id = "codex-background-readability";
      media?.after(layer);
    }
    const strength = percent / 100;
    document.body.dataset.codexReadabilityMode = readabilityMode;
    layer.style.cssText = "position:fixed!important;inset:0!important;z-index:0!important;pointer-events:none!important;background:none!important";
    let readabilityStyle = document.getElementById("codex-background-readability-style");
    if (!readabilityStyle) {
      readabilityStyle = document.createElement("style");
      readabilityStyle.id = "codex-background-readability-style";
      document.head.append(readabilityStyle);
    }
    const softAlpha = 0.16 + strength * 0.26;
    const bubbleAlpha = 0.24 + strength * 0.30;
    const haloAlpha = readabilityMode === "halo" ? 0.62 + strength * 0.30 : 0.24 + strength * 0.24;
    readabilityStyle.textContent = [
      "#root,#root *,#root *:not(#codex-force-white){color:#fff!important;caret-color:#fff!important}",
      "#root ::placeholder{color:rgba(255,255,255,.72)!important}",
      "#root ::selection{background:rgba(56,189,248,.42)!important;color:#fff!important}",
      "#root aside,#root main,#root [class*='_ComposerLayoutRoot_'],#root aside *,#root main *,#root [class*='_ComposerLayoutRoot_'] *{text-shadow:0 1px 2px rgba(0,0,0," + (0.62 + strength * 0.24).toFixed(2) + "),0 0 " + (6 + strength * 10).toFixed(1) + "px rgba(0,0,0," + (0.38 + strength * 0.32).toFixed(2) + ") !important}",
      "#root aside svg,#root main svg,#root [class*='_ComposerLayoutRoot_'] svg,#root aside img,#root main img,#root [class*='_ComposerLayoutRoot_'] img{filter:drop-shadow(0 1px " + (1 + strength * 2).toFixed(1) + "px rgba(0,0,0," + (0.62 + strength * 0.26).toFixed(2) + "))}",
      "body[data-codex-readability-mode=soft] #root [data-codex-readability-surface]{position:relative!important;border:0!important;box-shadow:none!important;backdrop-filter:none!important;-webkit-backdrop-filter:none!important}",
      "body[data-codex-readability-mode=soft] #root [data-codex-readability-surface=topbar]{background:linear-gradient(105deg,rgba(var(--codex-bubble-shade-0,12,14,18)," + (softAlpha + 0.16).toFixed(3) + "),rgba(var(--codex-bubble-shade-1,10,12,16)," + (softAlpha + 0.14).toFixed(3) + ") 44%,rgba(var(--codex-bubble-shade-2,8,10,14)," + (softAlpha + 0.14).toFixed(3) + "))!important;border-radius:0!important}",
      "body[data-codex-readability-mode=soft] #root aside[data-codex-readability-surface]{background:linear-gradient(100deg,rgba(var(--codex-bubble-shade-0,12,14,18)," + (softAlpha + 0.20).toFixed(3) + "),rgba(var(--codex-bubble-shade-1,10,12,16)," + (softAlpha + 0.12).toFixed(3) + "))!important;border-radius:0!important}",
      "body[data-codex-readability-mode=soft] #root main[data-codex-readability-surface]{background:linear-gradient(105deg,rgba(var(--codex-bubble-shade-0,12,14,18)," + (softAlpha + 0.16).toFixed(3) + "),rgba(var(--codex-bubble-shade-1,10,12,16)," + (softAlpha + 0.08).toFixed(3) + ") 44%,rgba(var(--codex-bubble-shade-2,8,10,14)," + (softAlpha + 0.14).toFixed(3) + "))!important;border-radius:0!important}",
      "body[data-codex-readability-mode=soft] #root [data-codex-readability-surface=header]{background:none!important}",
      "body[data-codex-readability-mode=soft] #root [data-codex-readability-surface=composer]{background:linear-gradient(105deg,rgba(var(--codex-bubble-shade-0,12,14,18)," + (softAlpha + 0.24).toFixed(3) + "),rgba(var(--codex-bubble-shade-2,8,10,14)," + (softAlpha + 0.20).toFixed(3) + "))!important;border-radius:24px!important}",
      "body[data-codex-readability-mode=bubble] #root [data-codex-readability-bubble]{position:relative!important;isolation:isolate!important;border-radius:28px!important;background:linear-gradient(105deg,rgba(var(--codex-bubble-tint-0,255,255,255)," + (bubbleAlpha + 0.04).toFixed(3) + "),rgba(var(--codex-bubble-tint-1,250,250,252)," + bubbleAlpha.toFixed(3) + ") 48%,rgba(var(--codex-bubble-tint-2,255,255,255)," + (bubbleAlpha + 0.03).toFixed(3) + "))!important;backdrop-filter:none!important;-webkit-backdrop-filter:none!important;border:0!important;box-shadow:0 12px 32px rgba(12,16,24," + (0.035 + strength * 0.09).toFixed(3) + "),inset 0 1px 0 rgba(255,255,255,.18)!important}",
      "body[data-codex-readability-mode=bubble] #root aside[data-codex-readability-bubble]{border-radius:0 28px 28px 0!important}",
      "body[data-codex-readability-mode=bubble] #root [data-codex-readability-bubble=composer]{border-radius:24px!important}",
      "body[data-codex-readability-mode=bubble] #root [data-codex-readability-bubble=user]{border-radius:18px!important}"
    ].join("\\n");
  }

  if (!media) {
    range.disabled = true;
    status.textContent = "当前没有背景";
  } else {
    const percent = Math.round(Number(getComputedStyle(media).opacity || 1) * 100);
    render(percent);
    status.textContent = "背景已连接 · " + (media.videoWidth || media.naturalWidth || 0) + "×" + (media.videoHeight || media.naturalHeight || 0);
  }

  range.addEventListener("input", () => apply(range.value));
  readabilityRange.addEventListener("input", () => applyReadability(readabilityRange.value));
  shadow.querySelectorAll(".modes button").forEach(button => {
    button.addEventListener("click", () => {
      readabilityMode = button.dataset.mode;
      shadow.querySelectorAll(".modes button").forEach(item => item.classList.toggle("active", item === button));
      applyReadability(readabilityRange.value);
    });
  });
  shadow.querySelectorAll(".presets button").forEach(button => {
    button.addEventListener("click", () => apply(button.dataset.value));
  });
  close.addEventListener("click", event => {
    event.stopPropagation();
    root.style.display = "none";
    chip.style.display = "block";
  });
  chip.addEventListener("click", () => {
    root.style.display = "";
    chip.style.display = "none";
  });

  const head = shadow.querySelector(".head");
  let drag = null;
  head.addEventListener("pointerdown", event => {
    if (event.target === close) return;
    drag = { x: event.clientX, y: event.clientY, top: host.offsetTop, left: host.offsetLeft };
    head.setPointerCapture(event.pointerId);
  });
  head.addEventListener("pointermove", event => {
    if (!drag) return;
    host.style.left = Math.max(8, Math.min(window.innerWidth - 286, drag.left + event.clientX - drag.x)) + "px";
    host.style.top = Math.max(8, Math.min(window.innerHeight - 82, drag.top + event.clientY - drag.y)) + "px";
    host.style.right = "auto";
  });
  head.addEventListener("pointerup", () => drag = null);
  head.addEventListener("pointercancel", () => drag = null);

  document.body.append(host);
  updateBubbleTint();
  clearInterval(window.__codexBubbleTintTimer);
  window.__codexBubbleTintTimer = setInterval(updateBubbleTint, 500);
  markReadabilityBubbles();
  markReadabilitySurfaces();
  if (window.__codexReadabilityObserver) window.__codexReadabilityObserver.disconnect();
  window.__codexReadabilityObserver = new MutationObserver(() => {
    clearTimeout(window.__codexReadabilityMarkTimer);
    window.__codexReadabilityMarkTimer = setTimeout(markReadabilityBubbles, 80);
    clearTimeout(window.__codexReadabilitySurfaceTimer);
    window.__codexReadabilitySurfaceTimer = setTimeout(markReadabilitySurfaces, 80);
  });
  window.__codexReadabilityObserver.observe(document.body, { childList: true, subtree: true });
  apply(100);
  applyReadability(45);
  return { ok: true, backgroundInstalled: !!media, inlineControls: true };
})()`;

const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
console.log(JSON.stringify(result.result.value, null, 2));
socket.close();
