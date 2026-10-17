import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listWallpapers } from "./wallpaper-library.mjs";
import { defaultLibrary, normalizeLibrary } from "./library-state.mjs";

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

/* The picker renders from the same state the watchdog persists, read straight off
   prefs.json here so the first paint already honours the saved filters instead of
   flashing the unfiltered list until the first mirror arrives. */
function readLibrary() {
  try {
    const base = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    const raw = JSON.parse(fs.readFileSync(path.join(base, "Codex", "luna-beautiful-codex", "prefs.json"), "utf8"));
    return raw && raw.library ? raw.library : null;
  } catch { return null; }
}

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
  message.error ? waiter.reject(new Error(message.error.message)) : waiter.resolve(message.result);
};
function send(method, params = {}) {
  const id = nextId++;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}
await new Promise((resolve, reject) => {
  socket.onopen = resolve;
  socket.onerror = () => reject(new Error("Unable to connect to Codex DevTools"));
});

const wallpapers = listWallpapers().map(item => ({
  id: item.id,
  title: item.title,
  kind: item.kind || "image",
  quality: item.renderMode === "native" ? "原生高清" : item.renderMode === "webgl" ? "WebGL渲染" : item.renderMode === "web" ? "网页壁纸" : "静态预览",
  renderMode: item.renderMode,
  custom: !!item.custom,
  properties: Array.isArray(item.properties) ? item.properties : []
}));

const library = normalizeLibrary(readLibrary());

const expression = `(() => {
  document.getElementById("codex-wallpaper-picker")?.remove();
  const host = document.createElement("div");
  host.id = "codex-wallpaper-picker";
  host.dataset.command = "";
  host.dataset.libraryCommand = "";
  host.dataset.uploadReady = "";
  host.dataset.uploadCancel = "";
  host.style.cssText = "position:fixed!important;bottom:18px!important;right:18px!important;z-index:2147483646!important;pointer-events:auto!important;display:block!important;visibility:visible!important;opacity:1!important";
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = \`
    <style>
      :host{all:initial;font-family:"Segoe UI","Microsoft YaHei",sans-serif;color:#f4f7ff}
      *{box-sizing:border-box}
      .launcher{width:46px;height:46px;border:1px solid rgba(255,255,255,.22);border-radius:16px;background:rgba(9,15,26,.88);color:#f4f7ff;font:750 12px/1 inherit;cursor:pointer;box-shadow:0 10px 30px #0007}
      .launcher:hover{background:rgba(28,45,72,.94)}
      .panel{display:none;width:min(410px,calc(100vw - 36px));max-height:min(86vh,720px);padding:12px;border:1px solid rgba(255,255,255,.18);border-radius:16px;background:rgba(8,13,24,.97);box-shadow:0 22px 65px #000a;overflow:hidden;flex-direction:column}
      .panel.open{display:flex}
      .head{display:flex;gap:8px;align-items:center;margin-bottom:8px}
      .title{flex:none;font:750 14px/1 inherit}
      .head input{flex:1;height:30px;padding:0 9px;border:1px solid rgba(255,255,255,.18);border-radius:9px;background:rgba(255,255,255,.08);color:#fff;outline:none}
      .close{width:28px;height:28px;border:0;border-radius:8px;background:rgba(255,255,255,.13);color:#fff;cursor:pointer}
      .filters{display:grid;gap:6px;margin-bottom:8px}
      .chips{display:flex;gap:5px}
      .chip{flex:1;height:26px;border:1px solid rgba(255,255,255,.16);border-radius:8px;background:rgba(255,255,255,.05);color:#c9d8ec;font:650 11px/1 inherit;cursor:pointer}
      .chip.on{background:rgba(94,234,212,.26);border-color:rgba(94,234,212,.55);color:#eafffb}
      .row2{display:flex;gap:6px;align-items:center}
      .row2 select{flex:1;height:26px;border:1px solid rgba(255,255,255,.16);border-radius:8px;background:rgba(20,30,46,.95);color:#dbe8f8;font:600 11px/1 inherit}
      .check{display:flex;gap:5px;align-items:center;font:600 11px/1 inherit;color:#c3d3e6;white-space:nowrap}
      .list{display:grid;grid-auto-columns:minmax(0,1fr);gap:2px;min-height:60px;max-height:290px;overflow:auto;padding-right:3px}
      .item{display:flex;gap:8px;align-items:center;width:100%;min-width:0;padding:8px 9px;border:0;border-radius:10px;background:transparent;color:#eaf2ff;text-align:left;cursor:pointer}
      .item:hover{background:rgba(94,234,212,.16)}
      .item.active{background:rgba(94,234,212,.24)}
      .item.is-hidden{opacity:.5}
      .id{width:96px;flex:none;font:650 10px/1.2 inherit;color:#8dd9c7;overflow:hidden;text-overflow:ellipsis}
      .name{flex:1;min-width:0;font:650 12px/1.3 inherit;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .quality{flex:none;font:600 10px/1 inherit;color:#9db1ca}
      .tools{display:flex;flex:none;gap:4px}
      .mini{height:22px;padding:0 7px;border:1px solid rgba(255,255,255,.16);border-radius:7px;background:rgba(255,255,255,.06);color:#cfe0f5;font:650 10px/1 inherit;cursor:pointer}
      .mini:hover{background:rgba(255,255,255,.14)}
      .mini.tally-safe{color:#86efac;border-color:rgba(134,239,172,.4)}
      .mini.tally-suggestive{color:#fcd34d;border-color:rgba(252,211,77,.4)}
      .mini.tally-nsfw{color:#fca5a5;border-color:rgba(252,165,165,.4)}
      .bulk{display:flex;gap:5px;margin-top:7px}
      .bulk .mini{flex:1;height:26px}
      details{border-top:1px solid rgba(255,255,255,.08);margin-top:6px}
      summary{cursor:pointer;padding:7px 0 5px;font:700 11.5px/1 inherit;color:#cfe0f5;list-style:none}
      summary::-webkit-details-marker{display:none}
      .grid2{display:grid;grid-template-columns:1fr 1fr;gap:6px;padding-bottom:8px}
      .field{display:grid;gap:3px;font:600 10.5px/1.2 inherit;color:#a9bbd2}
      .field select,.field input[type=number]{height:26px;border:1px solid rgba(255,255,255,.16);border-radius:8px;background:rgba(20,30,46,.95);color:#dbe8f8;font:600 11px/1 inherit;padding:0 6px}
      .propsHost{display:grid;gap:5px;padding:2px 0 8px}
      .propRow{display:grid;grid-template-columns:minmax(0,1fr) minmax(92px,42%);gap:7px;align-items:center;font:600 10.5px/1.2 inherit;color:#b9cbe0}
      .propRow input[type=text],.propRow input[type=number],.propRow select{width:100%;height:25px;border:1px solid rgba(255,255,255,.16);border-radius:8px;background:rgba(20,30,46,.95);color:#dbe8f8;font:600 10.5px/1 inherit;padding:0 6px}
      .propRow input[type=color]{width:100%;height:25px;border:1px solid rgba(255,255,255,.16);border-radius:8px;background:rgba(20,30,46,.95);padding:2px}
      .propRow input[type=checkbox]{width:16px;height:16px;justify-self:end}
      .propRow input[type=range]{width:100%}
      .propsHint{font:600 10.5px/1.35 inherit;color:#8fa3bb;padding:2px 0 6px}
      .status{min-height:16px;margin-top:7px;font:600 11px/1.3 inherit;color:#9db1ca}
      .status.err{color:#fca5a5}
      .confirm{display:flex;gap:5px;align-items:center;margin-top:7px}
      .confirm .confirmText{flex:1;font:600 10.5px/1.3 inherit;color:#fcd34d}
      .mini.danger{color:#fca5a5;border-color:rgba(252,165,165,.45)}
      .empty{padding:14px 8px;font:600 11px/1.4 inherit;color:#8fa3bb;text-align:center}
    </style>
    <button class="launcher">壁纸</button>
    <div class="panel">
      <div class="head"><div class="title">壁纸库</div><input class="search" placeholder="搜索标题 / ID"><button class="close">×</button></div>
      <div class="filters">
        <div class="chips">
          <button class="chip" data-type="scene">场景</button>
          <button class="chip" data-type="video">视频</button>
          <button class="chip" data-type="image">图片</button>
          <button class="chip" data-type="web">网页</button>
        </div>
        <div class="row2">
          <select class="tag"><option value="all">全部标签</option><option value="safe">安全</option><option value="suggestive">轻度</option><option value="nsfw">成人</option></select>
          <label class="check"><input type="checkbox" class="showHidden">显示已隐藏</label>
        </div>
      </div>
      <details class="propsPanel">
        <summary>壁纸属性</summary>
        <div class="propsHost"></div>
      </details>
      <div class="list"></div>
      <div class="bulk">
        <button class="mini" data-act="unhideAll">全部显示</button>
        <button class="mini" data-act="hideFiltered">隐藏筛选结果</button>
        <button class="mini" data-act="add">添加壁纸</button>
      </div>
      <details>
        <summary>自动轮播</summary>
        <div class="grid2">
          <label class="check"><input type="checkbox" class="rotOn">启用轮播</label>
          <label class="field">顺序<select class="rotOrder"><option value="sequential">顺序</option><option value="random">随机</option></select></label>
          <label class="field">间隔<select class="rotEvery"><option value="15">15 秒</option><option value="30">30 秒</option><option value="60">1 分钟</option><option value="300">5 分钟</option><option value="custom">自定义</option></select></label>
          <label class="field">自定义秒<input type="number" class="rotSecs" min="5" max="86400" step="5"></label>
        </div>
      </details>
      <details>
        <summary>过场动画</summary>
        <div class="grid2">
          <label class="field">效果<select class="tmode"><option value="cut">硬切</option><option value="fade">淡入淡出</option><option value="zoom">缩放</option><option value="push">推移</option><option value="wipe">擦除</option><option value="iris">圆形扩散</option><option value="bars">条形展开</option></select></label>
          <label class="field">方向<select class="tdir"><option value="left">向左</option><option value="right">向右</option><option value="up">向上</option><option value="down">向下</option></select></label>
          <label class="field">速度<select class="tspeed"><option value="fast">快 220ms</option><option value="normal">标准 360ms</option><option value="slow">慢 560ms</option></select></label>
        </div>
      </details>
      <details>
        <summary>视频音轨</summary>
        <div class="grid2">
          <label class="check"><input type="checkbox" class="audioOn">启用视频声音</label>
          <label class="field">音量<input type="range" class="audioVol" min="0" max="100" step="1"></label>
        </div>
      </details>
      <div class="confirm" style="display:none">
        <span class="confirmText"></span>
        <button class="mini" data-del="keep">仅移出列表</button>
        <button class="mini danger" data-del="file">同时删除文件</button>
        <button class="mini" data-del="cancel">取消</button>
      </div>
      <div class="status">选择一张壁纸</div>
      <input class="uploader" type="file" multiple hidden accept=".jpg,.jpeg,.png,.webp,.avif,.mp4,.webm,.m4v,.mov">
    </div>
  \`;  const wallpapers = __WALLPAPERS__;
  const state = {
    library: __LIBRARY__,
    items: wallpapers.map(item => ({ id: item.id, title: item.title, kind: item.kind, quality: item.quality, renderMode: item.renderMode, custom: item.custom, properties: item.properties || [], tag: "safe", hidden: false })),
    rotation: null
  };
  const hostRoot = host;
  const launcher = shadow.querySelector(".launcher");
  const panel = shadow.querySelector(".panel");
  const search = shadow.querySelector(".search");
  const list = shadow.querySelector(".list");
  const status = shadow.querySelector(".status");
  const chipNodes = [...shadow.querySelectorAll(".chip")];
  const tagSelect = shadow.querySelector(".tag");
  const showHiddenBox = shadow.querySelector(".showHidden");
  const rotOn = shadow.querySelector(".rotOn");
  const rotOrder = shadow.querySelector(".rotOrder");
  const rotEvery = shadow.querySelector(".rotEvery");
  const rotSecs = shadow.querySelector(".rotSecs");
  const tMode = shadow.querySelector(".tmode");
  const tDir = shadow.querySelector(".tdir");
  const tSpeed = shadow.querySelector(".tspeed");
  const audioOn = shadow.querySelector(".audioOn");
  const audioVol = shadow.querySelector(".audioVol");
  const uploader = shadow.querySelector(".uploader");
  const confirmBar = shadow.querySelector(".confirm");
  const confirmText = shadow.querySelector(".confirmText");
  const propsHost = shadow.querySelector(".propsHost");
  let pendingDelete = null;
  let pointerDown = false;
  let hoverId = "";
  let hoverTimer = 0;
  let lastSignature = null;
  let localSaveAt = 0;
  let uploadQueue = [];
  let uploadSeen = 0;
  let uploadBusy = false;
  {
    const video = state.library.video || { audio: false, volume: 70 };
    audioOn.checked = !!video.audio;
    audioVol.value = String(Number(video.volume) || 0);
  }

  function setStatus(text, isError) {
    status.textContent = text;
    status.classList.toggle("err", !!isError);
  }
  function clearHover() { clearTimeout(hoverTimer); hoverTimer = 0; hoverId = ""; if (hostRoot.dataset.hover) hostRoot.dataset.hover = ""; }
  /* Hover is the only reliable "about to click this row" signal; arm it after a
     short dwell so sweeping across the list does not stage a scene. */
  function armHover(id) { clearTimeout(hoverTimer); hoverTimer = setTimeout(() => { hoverId = id; hostRoot.dataset.hover = id; }, 120); }
  function currentSource() { return document.getElementById("codex-custom-background-media")?.getAttribute("data-wallpaper-source") || ""; }
  function hiddenSet() { return new Set(state.library.hidden || []); }
  function tagOf(id) { const value = (state.library.contentTags || {})[id]; return value === "suggestive" || value === "nsfw" ? value : "safe"; }
  function save() {
    localSaveAt = Date.now();
    hostRoot.dataset.libraryCommand = JSON.stringify({ op: "save", library: state.library });
  }

  /* ---- wallpaper properties (Wallpaper Engine general.properties) ---- */
  function propStore() {
    if (!state.library.props || typeof state.library.props !== "object") state.library.props = {};
    return state.library.props;
  }
  function propsOf(id) {
    const values = propStore()[id];
    return values && typeof values === "object" ? values : {};
  }
  function colorToHex(value) {
    const text = String(value == null ? "" : value).trim();
    if (/^#[0-9a-f]{6}$/i.test(text)) return text;
    if (/^#[0-9a-f]{3}$/i.test(text)) return "#" + text[1] + text[1] + text[2] + text[2] + text[3] + text[3];
    const parts = text.split(/[\s,]+/).map(Number);
    if (parts.length >= 3 && parts.slice(0, 3).every(Number.isFinite)) {
      const channel = n => Math.max(0, Math.min(255, Math.round(n <= 1 ? n * 255 : n)));
      return "#" + parts.slice(0, 3).map(n => channel(n).toString(16).padStart(2, "0")).join("");
    }
    return "#ffffff";
  }
  function hexToWeColor(value) {
    const match = /^#([0-9a-f]{6})$/i.exec(String(value || ""));
    if (!match) return String(value || "#ffffff");
    const n = parseInt(match[1], 16);
    const channel = v => (v / 255).toFixed(3).replace(/0+$/, "").replace(/[.]$/, "");
    return channel((n >> 16) & 255) + " " + channel((n >> 8) & 255) + " " + channel(n & 255);
  }
  function pushProps(id, values) {
    const all = { ...propStore() };
    all[id] = { ...values };
    state.library.props = all;
    save();
    hostRoot.dataset.propsCommand = JSON.stringify({ id, props: all[id], t: Date.now() });
  }
  function renderProps() {
    propsHost.textContent = "";
    const active = currentSource();
    const item = state.items.find(entry => entry.id === active);
    if (!item) {
      const hint = document.createElement("div");
      hint.className = "propsHint";
      hint.textContent = "选择一张壁纸后可调整它的属性";
      propsHost.append(hint);
      return;
    }
    const defs = Array.isArray(item.properties) ? item.properties : [];
    if (!defs.length) {
      const hint = document.createElement("div");
      hint.className = "propsHint";
      hint.textContent = "「" + item.title + "」没有可调属性";
      propsHost.append(hint);
      return;
    }
    const saved = propsOf(item.id);
    for (const def of defs) {
      const row = document.createElement("label");
      row.className = "propRow";
      const name = document.createElement("span");
      name.textContent = def.text || def.key;
      let input = null;
      const value = saved[def.key] !== undefined ? saved[def.key] : def.value;
      if (def.type === "bool") {
        input = document.createElement("input");
        input.type = "checkbox";
        input.checked = value === true;
      } else if (def.type === "color") {
        input = document.createElement("input");
        input.type = "color";
        input.value = colorToHex(value);
      } else if (def.type === "slider") {
        input = document.createElement("input");
        input.type = "range";
        input.min = String(def.min ?? 0);
        input.max = String(def.max ?? 100);
        input.step = String(def.step ?? 1);
        input.value = String(value ?? def.min ?? 0);
      } else if (def.type === "combo") {
        input = document.createElement("select");
        for (const option of def.options || []) {
          const node = document.createElement("option");
          node.value = option.value;
          node.textContent = option.label;
          input.append(node);
        }
        input.value = String((value ?? (def.options && def.options[0] && def.options[0].value)) || "");
      } else {
        input = document.createElement("input");
        input.type = "text";
        input.value = String(value ?? "");
      }
      input.dataset.propKey = def.key;
      input.dataset.propType = def.type;
      input.onchange = () => {
        const next = { ...propsOf(item.id) };
        if (def.type === "bool") next[def.key] = !!input.checked;
        else if (def.type === "color") next[def.key] = hexToWeColor(input.value);
        else if (def.type === "slider") next[def.key] = Number(input.value);
        else next[def.key] = String(input.value);
        pushProps(item.id, next);
        setStatus("已应用属性：" + (def.text || def.key));
      };
      row.append(name, input);
      propsHost.append(row);
    }
  }

  /* ---- filtering (mirrors library-state.mjs; the Node side re-clamps anyway) ---- */
  function filtered() {
    const lib = state.library;
    const types = lib.filters.types || [];
    const tag = lib.filters.tag || "all";
    const showHidden = !!lib.filters.showHidden;
    const needle = search.value.trim().toLowerCase();
    const hidden = hiddenSet();
    return state.items.filter(item => {
      const isHidden = hidden.has(item.id);
      if (isHidden && !showHidden) return false;
      if (types.length && types.indexOf(item.kind) < 0) return false;
      if (tag !== "all" && tagOf(item.id) !== tag) return false;
      if (needle && item.title.toLowerCase().indexOf(needle) < 0 && String(item.id).toLowerCase().indexOf(needle) < 0) return false;
      return true;
    });
  }

  function render(force) {
    /* Rebuilding the list while the user is pressing a row replaces the node
       under their pointer, so the click is swallowed. */
    if (pointerDown && !force) return;
    const items = filtered();
    const hidden = hiddenSet();
    const active = currentSource();
    const next = search.value.trim() + "|" + active + "|" + items.map(item => item.id).join(",") + "|" + items.map(item => (hidden.has(item.id) ? "h" : "-") + tagOf(item.id)).join(",");
    if (!force && next === lastSignature) return;
    lastSignature = next;
    const scrollTop = list.scrollTop;
    list.innerHTML = "";
    if (!items.length) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "没有符合当前筛选的壁纸";
      list.append(empty);
    }
    for (const item of items) {
      const row = document.createElement("div");
      row.className = "item" + (item.id === active ? " active" : "") + (hidden.has(item.id) ? " is-hidden" : "");
      row.setAttribute("role", "button");
      row.tabIndex = 0;
      const idNode = document.createElement("span");
      idNode.className = "id";
      idNode.textContent = item.id;
      const nameNode = document.createElement("span");
      nameNode.className = "name";
      nameNode.textContent = item.title;
      const qualityNode = document.createElement("span");
      qualityNode.className = "quality";
      qualityNode.textContent = hidden.has(item.id) ? "已隐藏" : item.custom ? "自定义" : item.quality;
      const tools = document.createElement("span");
      tools.className = "tools";
      const tally = document.createElement("button");
      tally.className = "mini tally-" + tagOf(item.id);
      tally.textContent = tagOf(item.id) === "safe" ? "安全" : tagOf(item.id) === "suggestive" ? "轻度" : "成人";
      tally.title = "点击切换分级标签";
      tally.onclick = event => {
        event.stopPropagation();
        const order = ["safe", "suggestive", "nsfw"];
        const nextTag = order[(order.indexOf(tagOf(item.id)) + 1) % order.length];
        const map = { ...(state.library.contentTags || {}) };
        if (nextTag === "safe") delete map[item.id]; else map[item.id] = nextTag;
        state.library.contentTags = map;
        save();
        render(true);
      };
      const hideBtn = document.createElement("button");
      hideBtn.className = "mini";
      hideBtn.textContent = hidden.has(item.id) ? "恢复" : "隐藏";
      hideBtn.title = hidden.has(item.id) ? "重新显示这张壁纸" : "从列表隐藏（不删除文件）";
      hideBtn.onclick = event => {
        event.stopPropagation();
        const set = hiddenSet();
        if (set.has(item.id)) set.delete(item.id); else set.add(item.id);
        state.library.hidden = [...set];
        save();
        render(true);
      };
      if (item.custom) {
        const delBtn = document.createElement("button");
        delBtn.className = "mini";
        delBtn.textContent = "删除";
        delBtn.title = "删除这张上传的壁纸（可选是否删除文件）";
        delBtn.onclick = event => {
          event.stopPropagation();
          pendingDelete = item;
          confirmText.textContent = "删除「" + item.title + "」？默认保留文件";
          confirmBar.style.display = "flex";
        };
        tools.append(delBtn);
      }
      tools.append(tally, hideBtn);
      row.append(idNode, nameNode, qualityNode, tools);
      row.onpointerenter = () => armHover(item.id);
      row.onpointerleave = () => { if (hoverId === item.id) clearHover(); };
      row.onclick = () => { clearHover(); hostRoot.dataset.command = item.id; setStatus("正在切换：" + item.title); };
      row.onkeydown = event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); row.click(); } };
      list.append(row);
    }
    list.scrollTop = scrollTop;
    /* A library mirror or a filter change rebuilds the rows; that must not cancel a
       hover-driven prewarm while the pointer is still resting on the same wallpaper.
       Keep the hover id when it survived the rebuild, drop it only when it vanished. */
    if (hoverId) {
      if (items.some(item => item.id === hoverId)) hostRoot.dataset.hover = hoverId;
      else clearHover();
    }
    syncControls();
    renderProps();
  }

  function syncControls() {
    const lib = state.library;
    const types = lib.filters.types || [];
    for (const chip of chipNodes) chip.classList.toggle("on", types.indexOf(chip.dataset.type) >= 0);
    tagSelect.value = lib.filters.tag || "all";
    showHiddenBox.checked = !!lib.filters.showHidden;
    rotOn.checked = !!lib.rotation.enabled;
    rotOrder.value = lib.rotation.order;
    const interval = lib.rotation.intervalSec;
    if ([15, 30, 60, 300].indexOf(interval) >= 0) { rotEvery.value = String(interval); rotSecs.value = String(interval); }
    else { rotEvery.value = "custom"; rotSecs.value = String(interval); }
    rotSecs.disabled = rotEvery.value !== "custom";
    tMode.value = lib.transition.mode;
    tDir.value = lib.transition.dir;
    tSpeed.value = lib.transition.speed;
  }

  function toggleType(type) {
    const types = new Set(state.library.filters.types || []);
    if (types.has(type)) types.delete(type); else types.add(type);
    state.library.filters.types = [...types];
    save();
    render(true);
  }

  for (const chip of chipNodes) chip.onclick = () => toggleType(chip.dataset.type);
  tagSelect.onchange = () => { state.library.filters.tag = tagSelect.value; save(); render(true); };
  showHiddenBox.onchange = () => { state.library.filters.showHidden = showHiddenBox.checked; save(); render(true); };

  shadow.querySelector('[data-act="unhideAll"]').onclick = () => {
    state.library.hidden = [];
    save();
    render(true);
    setStatus("已恢复全部隐藏的壁纸");
  };
  shadow.querySelector('[data-act="hideFiltered"]').onclick = () => {
    const set = hiddenSet();
    let added = 0;
    for (const item of filtered()) { if (!set.has(item.id)) { set.add(item.id); added += 1; } }
    state.library.hidden = [...set];
    save();
    render(true);
    setStatus(added ? "已隐藏 " + added + " 张（当前筛选结果）" : "当前筛选结果已全部隐藏");
  };

  /* ---- custom uploads: the page only ever hands over the File it was given, the
     watchdog pulls the bytes and writes the copy itself ---- */
  shadow.querySelectorAll(".confirm [data-del]").forEach(button => {
    button.onclick = () => {
      const item = pendingDelete;
      const mode = button.dataset.del;
      pendingDelete = null;
      confirmBar.style.display = "none";
      if (!item || mode === "cancel") return;
      const deleteFile = mode === "file";
      state.items = state.items.filter(entry => entry.id !== item.id);
      const set = hiddenSet();
      set.delete(item.id);
      state.library.hidden = [...set];
      save();
      hostRoot.dataset.uploadDelete = JSON.stringify({ id: item.id, deleteFile, t: Date.now() });
      render(true);
      setStatus(deleteFile ? "正在删除壁纸和文件…" : "正在移出列表（文件保留）…");
    };
  });
  shadow.querySelector('[data-act="add"]').onclick = () => uploader.click();
  uploader.onchange = () => {
    const files = [...uploader.files];
    uploader.value = "";
    if (!files.length) return;
    uploadQueue = files.concat(uploadQueue);
    if (!uploadBusy) startNextUpload();
  };
  function startNextUpload() {
    if (!uploadQueue.length) { uploadBusy = false; setStatus("上传完成"); return; }
    const file = uploadQueue.shift();
    uploadBusy = true;
    window.__lunaUpload = { file, name: file.name, size: file.size };
    hostRoot.dataset.uploadReady = JSON.stringify({ name: file.name, size: file.size, type: file.type, t: Date.now() });
    setStatus("正在上传 " + file.name + " …");
  }

  /* ---- rotation + transition controls ---- */
  rotOn.onchange = () => { state.library.rotation.enabled = rotOn.checked; save(); };
  rotOrder.onchange = () => { state.library.rotation.order = rotOrder.value; save(); };
  rotEvery.onchange = () => {
    if (rotEvery.value === "custom") { rotSecs.disabled = false; rotSecs.focus(); }
    else { rotSecs.disabled = true; state.library.rotation.intervalSec = Number(rotEvery.value); save(); }
  };
  rotSecs.onchange = () => {
    const value = Math.max(5, Math.min(86400, Math.round(Number(rotSecs.value) || 30)));
    rotSecs.value = String(value);
    state.library.rotation.intervalSec = value;
    save();
  };
  tMode.onchange = () => { state.library.transition.mode = tMode.value; save(); };
  tDir.onchange = () => { state.library.transition.dir = tDir.value; save(); };
  tSpeed.onchange = () => { state.library.transition.speed = tSpeed.value; save(); };
  audioOn.onchange = () => {
    if (!state.library.video || typeof state.library.video !== "object") state.library.video = { audio: false, volume: 70 };
    state.library.video.audio = !!audioOn.checked;
    save();
    setStatus(audioOn.checked ? "已请求开启视频声音（若浏览器拦截，请点击一次页面）" : "视频声音已关闭");
  };
  audioVol.oninput = () => {
    if (!state.library.video || typeof state.library.video !== "object") state.library.video = { audio: false, volume: 70 };
    state.library.video.volume = Math.max(0, Math.min(100, Math.round(Number(audioVol.value) || 0)));
    save();
  };

  /* ---- mirror from the watchdog ---- */
  function absorbMirror(raw) {
    let payload = null;
    try { payload = JSON.parse(raw); } catch { return; }
    if (!payload || !payload.library) return;
    if (payload.items) {
      state.items = payload.items.map(item => ({ id: item.id, title: item.title, kind: item.kind, quality: item.quality, renderMode: item.renderMode, custom: item.custom, properties: item.properties || [], tag: item.tag, hidden: item.hidden }));
    }
    /* A mirror that arrives right after a local save carries the same state; a
       stale one must not overwrite what the user is still editing. */
    if (Date.now() - localSaveAt > 1200) {
      state.library = payload.library;
      state.rotation = payload.rotation || null;
      const video = state.library.video || { audio: false, volume: 70 };
      audioOn.checked = !!video.audio;
      audioVol.value = String(Number(video.volume) || 0);
      render(true);
      if (payload.rotation && payload.rotation.enabled) {
        const secs = payload.rotation.nextInSec;
        setStatus("轮播中 · " + (secs === null || secs === undefined ? "已启用" : "下一张 " + secs + " 秒后") + " · 候选 " + (payload.rotation.candidates || 0) + " 张");
      }
    } else {
      state.rotation = payload.rotation || state.rotation;
    }
  }
  let mirrorSeen = hostRoot.dataset.library || "";
  function pollMirror() {
    const raw = hostRoot.dataset.library || "";
    if (raw && raw !== mirrorSeen) { mirrorSeen = raw; absorbMirror(raw); }
    const up = hostRoot.dataset.uploadStatus || "";
    if (up) {
      hostRoot.dataset.uploadStatus = "";
      let report = null;
      try { report = JSON.parse(up); } catch {}
      if (report && report.t !== uploadSeen) {
        uploadSeen = report.t || uploadSeen;
        if (report.state === "info") { setStatus(report.message || ""); }
        else if (report.state === "done") { uploadBusy = false; startNextUpload(); }
        else if (report.state === "error") { uploadBusy = false; uploadQueue = []; setStatus("上传失败：" + (report.message || "未知错误"), true); }
      }
    }
  }

  function setOpen(open) {
    panel.classList.toggle("open", open);
    /* Set display explicitly instead of trusting the .panel.open class alone:
       a leftover inline display on the panel outranks the stylesheet and made
       the 壁纸 button look dead. */
    panel.style.setProperty("display", open ? "flex" : "none", "important");
    if (!open) { clearHover(); return; }
    hostRoot.dataset.libraryRequest = String(Date.now());
    render(true);
  }
  launcher.onclick = () => setOpen(!panel.classList.contains("open"));
  shadow.querySelector(".close").onclick = () => setOpen(false);
  search.oninput = () => render(true);
  window.addEventListener("pointerdown", () => { pointerDown = true; }, true);
  window.addEventListener("pointerup", () => { pointerDown = false; }, true);
  window.addEventListener("pointercancel", () => { pointerDown = false; }, true);
  setInterval(() => { pollMirror(); if (panel.classList.contains("open")) render(false); }, 900);
  document.body.append(host);
  setOpen(false);
  render(true);
  return { ok: true, count: wallpapers.length, filters: state.library.filters };
})()`;

const fill = (template, token, value) => template.split(token).join(JSON.stringify(value));
const source = fill(fill(expression, "__WALLPAPERS__", wallpapers), "__LIBRARY__", library);
const result = await send("Runtime.evaluate", { expression: source, returnByValue: true, awaitPromise: true });
if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
console.log(JSON.stringify(result.result.value));
socket.close();
