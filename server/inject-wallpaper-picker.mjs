import { listWallpapers } from "./wallpaper-library.mjs";

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
  quality: item.renderMode === "native" ? "原生高清" : item.renderMode === "webgl" ? "WebGL渲染" : "静态预览"
}));

const expression = `(() => {
  document.getElementById("codex-wallpaper-picker")?.remove();
  const host = document.createElement("div");
  host.id = "codex-wallpaper-picker";
  host.dataset.command = "";
  host.style.cssText = "position:fixed!important;bottom:18px!important;right:18px!important;z-index:2147483646!important;pointer-events:auto!important;display:block!important;visibility:visible!important;opacity:1!important";
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = \`
    <style>
      :host{all:initial;font-family:"Segoe UI","Microsoft YaHei",sans-serif;color:#f4f7ff}
      .launcher{width:46px;height:46px;border:1px solid rgba(255,255,255,.22);border-radius:16px;background:rgba(9,15,26,.88);color:#f4f7ff;font:750 12px/1 inherit;cursor:pointer;box-shadow:0 10px 30px #0007}
      .launcher:hover{background:rgba(28,45,72,.94)}
      .panel{display:none;width:min(390px,calc(100vw - 36px));max-height:min(560px,calc(100vh - 36px));padding:14px;border:1px solid rgba(255,255,255,.18);border-radius:16px;background:rgba(8,13,24,.97);box-shadow:0 22px 65px #000a}
      .panel.open{display:block}
      .head{display:flex;gap:8px;align-items:center;margin-bottom:10px}
      .title{flex:1;font:750 14px/1 inherit}
      input{flex:1;height:32px;padding:0 10px;border:1px solid rgba(255,255,255,.18);border-radius:9px;background:rgba(255,255,255,.08);color:#fff;outline:none}
      .close{width:28px;height:28px;border:0;border-radius:8px;background:rgba(255,255,255,.13);color:#fff;cursor:pointer}
      .list{display:grid;max-height:420px;overflow:auto;padding-right:3px}
      .item{display:flex;gap:9px;align-items:center;width:100%;padding:10px;border:0;border-radius:10px;background:transparent;color:#eaf2ff;text-align:left;cursor:pointer}
      .item:hover{background:rgba(94,234,212,.16)}
      .item.active{background:rgba(94,234,212,.24)}
      .id{width:82px;flex:none;font:650 11px/1 inherit;color:#8dd9c7}
      .name{flex:1;font:650 12px/1.35 inherit}
      .quality{flex:none;font:600 10px/1 inherit;color:#9db1ca}
      .status{min-height:16px;margin-top:9px;font:600 11px/1 inherit;color:#9db1ca}
    </style>
    <button class="launcher">壁纸</button>
    <div class="panel">
      <div class="head"><div class="title">Codex Wallpaper</div><input placeholder="搜索标题 / ID"><button class="close">×</button></div>
      <div class="list"></div><div class="status">选择一张壁纸</div>
    </div>
  \`;
  const wallpapers = ${JSON.stringify(wallpapers)};
  const hostRoot = host;
  const launcher = shadow.querySelector(".launcher");
  const panel = shadow.querySelector(".panel");
  const search = shadow.querySelector("input");
  const list = shadow.querySelector(".list");
  const status = shadow.querySelector(".status");
  let pointerDown = false;
  let hoverId = "";
  let hoverTimer = 0;
  function clearHover(){ clearTimeout(hoverTimer); hoverTimer = 0; hoverId = ""; if (hostRoot.dataset.hover) hostRoot.dataset.hover = ""; }
  /* Hover is the only reliable "about to click this row" signal; arm it after a
     short dwell so sweeping across the list does not stage a scene. */
  function armHover(id){ clearTimeout(hoverTimer); hoverTimer = setTimeout(() => { hoverId = id; hostRoot.dataset.hover = id; }, 120); }
  let lastSignature = null;
  function currentSource(){return document.getElementById("codex-custom-background-media")?.getAttribute("data-wallpaper-source")||""}
  function render(force){
    /* Rebuilding the list while the user is pressing a row replaces the node
       under their pointer, so the click is swallowed. */
    if (pointerDown && !force) return;
    const needle = search.value.trim().toLowerCase();
    const items = wallpapers.filter(item => item.title.toLowerCase().includes(needle) || item.id.includes(needle));
    const next = needle + "|" + currentSource() + "|" + items.map(item => item.id).join(",");
    if (!force && next === lastSignature) return;
    lastSignature = next;
    const scrollTop = list.scrollTop;
    const active = currentSource();
    clearHover();
    list.innerHTML = "";
    for (const item of items) {
      const button = document.createElement("button");
      button.className = "item" + (item.id === active ? " active" : "");
      button.innerHTML = '<span class="id">' + item.id + '</span><span class="name">' + item.title.replace(/</g, "&lt;") + '</span><span class="quality">' + item.quality + '</span>';
      button.onpointerenter = () => armHover(item.id);
      button.onpointerleave = () => { if (hoverId === item.id) clearHover(); };
      button.onclick = () => { clearHover(); hostRoot.dataset.command = item.id; status.textContent = "正在切换：" + item.title; };
      list.append(button);
    }
    list.scrollTop = scrollTop;
  }
  function setOpen(open){
    panel.classList.toggle("open", open);
    /* Set display explicitly instead of trusting the .panel.open class alone:
       a leftover inline display on the panel outranks the stylesheet and made
       the 壁纸 button look dead. */
    panel.style.setProperty("display", open ? "block" : "none", "important");
    if (!open) clearHover();
    if (open) render(true);
  }
  launcher.onclick = () => setOpen(!panel.classList.contains("open"));
  shadow.querySelector(".close").onclick = () => setOpen(false);
  search.oninput = () => render(true);
  window.addEventListener("pointerdown", () => { pointerDown = true; }, true);
  window.addEventListener("pointerup", () => { pointerDown = false; }, true);
  window.addEventListener("pointercancel", () => { pointerDown = false; }, true);
  setInterval(() => { if (panel.classList.contains("open")) render(false); }, 1200);
  document.body.append(host);
  setOpen(false);
  render(true);
  return { ok: true, count: wallpapers.length };
})()`;

const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
console.log(JSON.stringify(result.result.value));
socket.close();
