import { listWallpapers } from "./wallpaper-library.mjs";

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
  host.style.cssText = "position:fixed;bottom:18px;right:18px;z-index:2147483646;pointer-events:auto";
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
  function currentSource(){return document.getElementById("codex-custom-background-media")?.getAttribute("data-wallpaper-source")||""}
  function render(){
    const needle=search.value.trim().toLowerCase();
    const items=wallpapers.filter(item=>item.title.toLowerCase().includes(needle)||item.id.includes(needle));
    list.innerHTML="";
    for(const item of items){
      const button=document.createElement("button");
      button.className="item"+(item.id===currentSource()?" active":"");
      button.innerHTML='<span class="id">'+item.id+'</span><span class="name">'+item.title.replace(/</g,"&lt;")+'</span><span class="quality">'+item.quality+'</span>';
      button.onclick=()=>{hostRoot.dataset.command=item.id;status.textContent="正在切换："+item.title};
      list.append(button);
    }
  }
  launcher.onclick=()=>{panel.classList.toggle("open");if(panel.classList.contains("open"))render()};
  shadow.querySelector(".close").onclick=()=>panel.classList.remove("open");
  search.oninput=render;
  setInterval(()=>{if(panel.classList.contains("open"))render()},1200);
  document.body.append(host);
  render();
  return {ok:true,count:wallpapers.length};
})()`;

const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
console.log(JSON.stringify(result.result.value));
socket.close();
