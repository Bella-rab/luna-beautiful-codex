/* The Codex page is not always exposed on the same DevTools port, so probe the
   same range the watchdog uses instead of assuming 9229. */
const devtoolsPorts = (process.env.LUNA_DEVTOOLS_PORTS || "9229,9230,9231,9232,9233,9234,9235,9236,9237,9238,9239")
  .split(",").map(value => parseInt(value, 10)).filter(value => value > 0);

async function findPage() {
  for (const port of devtoolsPorts) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, { cache: "no-store" });
      if (!response.ok) continue;
      const targets = await response.json();
      const target = targets.find(item => item.type === "page" && item.url === "app://-/index.html");
      if (target) return target;
    } catch {}
  }
  return null;
}

/* Saved panel state, handed over by the watchdog through the environment. The
   page cannot fetch the watchdog (CSP connect-src), and this script is spawned
   fresh after every wallpaper switch, so anything not passed in here would be
   lost - which is exactly how the opacity override and the readability slider
   used to snap back to their defaults on every switch. */
const initialState = (() => {
  try { return JSON.parse(process.env.LUNA_CONTROLS_STATE || "{}") || {}; } catch { return {}; }
})();
const READABILITY_MODES = ["halo", "soft", "bubble"];
const initialReadability = (() => {
  const raw = initialState.readability && typeof initialState.readability === "object" ? initialState.readability : {};
  const percent = Math.max(0, Math.min(100, Math.round(Number(raw.percent))));
  return {
    percent: Number.isFinite(percent) ? percent : 45,
    mode: READABILITY_MODES.includes(raw.mode) ? raw.mode : "soft"
  };
})();
const initialOpacity = (() => {
  const raw = Number(initialState.backgroundOpacity);
  return Number.isFinite(raw) ? Math.max(5, Math.min(100, Math.round(raw))) : null;
})();

const target = await findPage();
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

  /* Resolved on demand: every wallpaper switch replaces the media element, and a
     panel that kept the old node would dim a detached layer while the live one
     stayed bright. */
  const liveMedia = () => document.getElementById("codex-custom-background-media");
  const root = shadow.querySelector(".panel");
  const chip = shadow.querySelector(".chip");
  const range = shadow.querySelector("input");
  const readabilityRange = shadow.querySelector("#readability");
  const readabilityOutput = shadow.querySelector("#readability-output");
  const output = shadow.querySelector("output");
  const status = shadow.querySelector(".status");
  const close = shadow.querySelector(".close");
  let readabilityMode = ${JSON.stringify(initialReadability.mode)};

  /* Writes the current panel values back to the watchdog, which persists them and
     replays them into the next injection. */
  function notifyWatchdog() {
    try {
      host.dataset.controlsCommand = JSON.stringify({
        backgroundOpacity: Number(range.value),
        readability: { percent: Number(readabilityRange.value), mode: readabilityMode }
      });
    } catch {}
  }

  /* Controls are re-injected after every background swap because the panel has
     to rebind to the new media element, but the sheets and markers it writes are
     almost always byte-identical to what is already there. Re-assigning
     identical textContent still makes Chromium re-parse the sheet and
     invalidate style for the whole tree, which showed up as a ~150ms long task
     per injection, so every write below is guarded by a value comparison. The
     stylesheet cache lives on window so it survives re-injection. */
  const cssCache = window.__codexLastCss || (window.__codexLastCss = {});
  function writeCss(id, text) {
    let style = document.getElementById(id);
    if (style && cssCache[id] === text && style.textContent === text) return style;
    if (!style) {
      style = document.createElement("style");
      style.id = id;
      document.head.append(style);
    }
    if (style.textContent !== text) style.textContent = text;
    cssCache[id] = text;
    return style;
  }
  function setText(node, text) {
    if (node && node.textContent !== text) node.textContent = text;
  }
  function setAttr(element, name, value) {
    if (element && element.getAttribute(name) !== value) element.setAttribute(name, value);
  }

  function render(value) {
    if (range.value !== String(value)) range.value = value;
    setText(output, value + "%");
  }

  function apply(value) {
    const percent = Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
    const media = liveMedia();
    render(percent);
    if (!media) {
      setText(status, "当前没有背景");
      return;
    }
    let base = document.getElementById("codex-custom-background-base");
    if (!base) { base = document.createElement("div"); base.id = "codex-custom-background-base"; base.style.cssText = "position:fixed!important;inset:0!important;background:#000!important;z-index:0!important;pointer-events:none!important"; media.before(base); }
    const opacityStyle = writeCss("codex-background-opacity-style", "#codex-custom-background-media,#codex-custom-background-base,#codex-custom-background-base canvas{opacity:" + percent / 100 + " !important}");
    if (opacityStyle.parentNode !== document.head) document.head.append(opacityStyle);
    setAttr(media, "data-background-opacity", String(percent / 100));
    if (media.tagName === "VIDEO") media.play().catch(() => {});
    setText(status, percent === 100 ? "壁纸完全显示" : percent === 0 ? "背景已隐藏" : "已应用 " + percent + "%");
  }

  /* Marked elements are remembered in a registry: clearing marks used to walk
     every node in the document, and the per-element white/caret inline styles
     duplicated the stylesheet rule in applyReadability - both ran on every
     DOM mutation while the thread was streaming. */
  const markedBubbles = new Set();
  const markedSurfaces = new Set();

  function markReadabilityBubble(element, kind) {
    if (!element) return;
    if (element.getAttribute("data-codex-readability-bubble") !== kind) element.setAttribute("data-codex-readability-bubble", kind);
    markedBubbles.add(element);
  }

  function markReadabilitySurface(element, kind) {
    if (!element) return;
    if (element.getAttribute("data-codex-readability-surface") !== kind) element.setAttribute("data-codex-readability-surface", kind);
    markedSurfaces.add(element);
  }

  /* Re-marking used to clear the whole registry first, which rewrote the
     attribute on every marked node (100+ mutations per injection) and made
     Chromium recompute style for the entire transcript. Only nodes that drop
     out of the current pass need their mark removed, so keep the ones re-marked
     in this pass and prune the rest; the end state is identical. */
  function clearStaleMarks(registry, attribute, keep) {
    for (const element of [...registry]) {
      if (keep.has(element)) continue;
      registry.delete(element);
      if (!element.isConnected) continue;
      try { element.removeAttribute(attribute); } catch {}
    }
  }

  function markReadabilityBubbles() {
    const keep = new Set();
    const mark = (element, kind) => { if (!element) return; markReadabilityBubble(element, kind); keep.add(element); };
    mark(document.querySelector("aside.app-shell-left-panel"), "sidebar");
    mark(document.querySelector(".ProseMirror")?.closest('[class*="_ComposerLayoutRoot_"]'), "composer");
    mark(document.querySelector("main > header"), "header");
    document.querySelectorAll('.thread-scroll-container [class*="group/user-message"] [class*="_bubble_"]').forEach(element => mark(element, "user"));
    document.querySelectorAll(".thread-scroll-container [data-markdown-text-style=assistant-message]").forEach(element => mark(element.closest(".group.flex.min-w-0.flex-col"), "assistant"));
    document.querySelectorAll('.thread-scroll-container [class*="group/activity-header"]').forEach(element => mark(element.parentElement, "activity"));
    clearStaleMarks(markedBubbles, "data-codex-readability-bubble", keep);
  }

  function markReadabilitySurfaces() {
    const keep = new Set();
    const mark = (element, kind) => { if (!element) return; markReadabilitySurface(element, kind); keep.add(element); };
    mark(document.querySelector("aside.app-shell-left-panel"), "sidebar");
    mark(document.querySelector('[class*="_ApplicationMenuTopBar_"]'), "topbar");
    mark(document.querySelector("main"), "content");
    mark(document.querySelector("main > header"), "header");
    mark(document.querySelector(".ProseMirror")?.closest('[class*="_ComposerLayoutRoot_"]'), "composer");
    clearStaleMarks(markedSurfaces, "data-codex-readability-surface", keep);
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

  /* Sampling a frame costs ~25ms and every changed custom property on :root
     forces a full style recalculation (~95ms), so the old 500ms timer kept the
     main thread busy even when the tint was not on screen. Sampling now runs
     only in bubble mode, on a calmer 2s cadence, writes a property only when
     its value really changed, and can never throw on every tick. */
  const lastTintValues = new Map();
  let bubbleTintTimer = null;

  function tintSource() {
    const media = liveMedia();
    if (!media) return null;
    if (media.tagName !== "VIDEO" && media.tagName !== "IMG") return null;
    if (typeof media.readyState !== "number" || media.readyState < 2) return null;
    return media;
  }

  function writeTint(name, value) {
    if (lastTintValues.get(name) === value) return;
    lastTintValues.set(name, value);
    document.documentElement.style.setProperty(name, value);
  }

  function updateBubbleTint() {
    const source = tintSource();
    if (!source) return;
    try {
      const canvas = window.__codexBubbleTintCanvas ?? document.createElement("canvas");
      canvas.width = 24;
      canvas.height = 14;
      window.__codexBubbleTintCanvas = canvas;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      context.drawImage(source, 0, 0, canvas.width, canvas.height);
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
        writeTint("--codex-bubble-tint-" + zone, pastelTint(pixels));
        writeTint("--codex-bubble-shade-" + zone, deepTint(pixels));
      });
    } catch { /* one failed sample must not become an uncaught error every tick */ }
  }

  function syncBubbleTintTimer() {
    const wanted = readabilityMode === "bubble" && !!tintSource();
    if (wanted && bubbleTintTimer === null) {
      updateBubbleTint();
      bubbleTintTimer = setInterval(updateBubbleTint, 2000);
    } else if (!wanted && bubbleTintTimer !== null) {
      clearInterval(bubbleTintTimer);
      bubbleTintTimer = null;
    }
    window.__codexBubbleTintTimer = bubbleTintTimer;
  }

  function applyReadability(value) {
    const percent = Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
    if (readabilityRange.value !== String(percent)) readabilityRange.value = percent;
    setText(readabilityOutput, percent + "%");
    let layer = document.getElementById("codex-background-readability");
    if (!layer) {
      layer = document.createElement("div");
      layer.id = "codex-background-readability";
      liveMedia()?.after(layer);
    }
    const strength = percent / 100;
    if (document.body.dataset.codexReadabilityMode !== readabilityMode) document.body.dataset.codexReadabilityMode = readabilityMode;
    const layerCss = "position:fixed!important;inset:0!important;z-index:0!important;pointer-events:none!important;background:none!important";
    if (layer.style.cssText !== layerCss) layer.style.cssText = layerCss;
    const softAlpha = 0.16 + strength * 0.26;
    const bubbleAlpha = 0.24 + strength * 0.30;
    const haloAlpha = readabilityMode === "halo" ? 0.62 + strength * 0.30 : 0.24 + strength * 0.24;
    const readabilityCss = [
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
    ];
    writeCss("codex-background-readability-style", readabilityCss.join("\\n"));
  }

  const initialMedia = liveMedia();
  if (!initialMedia) {
    range.disabled = true;
    status.textContent = "当前没有背景";
  } else {
    const percent = Math.round(Number(getComputedStyle(initialMedia).opacity || 1) * 100);
    render(percent);
    status.textContent = "背景已连接 · " + (initialMedia.videoWidth || initialMedia.naturalWidth || 0) + "×" + (initialMedia.videoHeight || initialMedia.naturalHeight || 0);
  }

  range.addEventListener("input", () => { apply(range.value); notifyWatchdog(); });
  readabilityRange.addEventListener("input", () => { applyReadability(readabilityRange.value); notifyWatchdog(); });
  shadow.querySelectorAll(".modes button").forEach(button => {
    button.addEventListener("click", () => {
      readabilityMode = button.dataset.mode;
      shadow.querySelectorAll(".modes button").forEach(item => item.classList.toggle("active", item === button));
      applyReadability(readabilityRange.value);
      syncBubbleTintTimer();
      notifyWatchdog();
    });
  });
  shadow.querySelectorAll(".presets button").forEach(button => {
    button.addEventListener("click", () => { apply(button.dataset.value); notifyWatchdog(); });
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
  clearInterval(window.__codexBubbleTintTimer);
  window.__codexBubbleTintTimer = null;
  /* syncBubbleTintTimer samples once itself whenever bubble mode is active, so
     the unconditional sample that used to run here only cost a 4K video
     readback (measured ~26ms) on every injection while it was off screen. */
  syncBubbleTintTimer();
  markReadabilityBubbles();
  markReadabilitySurfaces();
  if (window.__codexReadabilityObserver) window.__codexReadabilityObserver.disconnect();
  window.__codexReadabilityObserver = new MutationObserver(() => {
    clearTimeout(window.__codexReadabilityMarkTimer);
    window.__codexReadabilityMarkTimer = setTimeout(markReadabilityBubbles, 250);
    clearTimeout(window.__codexReadabilitySurfaceTimer);
    window.__codexReadabilitySurfaceTimer = setTimeout(markReadabilitySurfaces, 250);
  });
  window.__codexReadabilityObserver.observe(document.body, { childList: true, subtree: true });
  /* The saved pref is authoritative: the media element's recorded value can be
     stale (a scene canvas has no attribute at all), and this panel is the only
     writer of that attribute. */
  const savedOpacity = ${initialOpacity === null ? "null" : initialOpacity};
  const recordedOpacity = (() => {
    const node = liveMedia();
    if (!node) return null;
    const value = Number(node.getAttribute("data-background-opacity"));
    return Number.isFinite(value) ? value : null;
  })();
  apply(savedOpacity !== null ? savedOpacity : recordedOpacity !== null ? Math.round(recordedOpacity * 100) : 100);
  shadow.querySelectorAll(".modes button").forEach(item => item.classList.toggle("active", item.dataset.mode === readabilityMode));
  applyReadability(${initialReadability.percent});
  return { ok: true, backgroundInstalled: !!liveMedia(), inlineControls: true, readability: "${initialReadability.mode}:${initialReadability.percent}", opacity: savedOpacity };
})()`;

const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
console.log(JSON.stringify(result.result.value, null, 2));
socket.close();
