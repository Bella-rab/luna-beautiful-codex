import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { listWallpapers, resolveWallpaperMedia } from "./wallpaper-library.mjs";

const root = import.meta.dirname;
const stateRoot = path.join(process.env.APPDATA || os.homedir(), "Codex", "luna-beautiful-codex");
const selectionPath = path.join(stateRoot, "wallpaper-selection.json");
const prefsPath = path.join(stateRoot, "prefs.json");
const controlsScript = path.join(root, "inject-background-controls.mjs");
const pickerScript = path.join(root, "inject-wallpaper-picker.mjs");
const logPath = path.join(root, "codex-wallpaper-watchdog.log");
const lockPort = 43310;
const devtoolsPorts = [9229, 9230, 9231, 9232, 9233, 9234, 9235, 9236, 9237, 9238, 9239];
const chunkSize = 512 * 1024;
const mediaCache = new Map();
let memorySelection = null;

function log(message) {
  try { fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${message}\n`); } catch {}
}

function wait(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function readJson(filePath, fallback) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); } catch { return fallback; }
}

function writeSelection(source, title) {
  memorySelection = { source, title };
  try { fs.mkdirSync(stateRoot, { recursive: true }); fs.writeFileSync(selectionPath, JSON.stringify({ source, title }, null, 2)); } catch {}
}

function selection() {
  if (memorySelection && memorySelection.source) return memorySelection;
  const value = readJson(selectionPath, null);
  if (value && value.source) return value;
  const first = listWallpapers()[0];
  const next = first ? { source: first.id, title: first.title } : { source: "", title: "" };
  if (next.source) writeSelection(next.source, next.title);
  return next;
}

function prefs() {
  return { whiteText: true, ...readJson(prefsPath, null) };
}

function writePrefs(patch) {
  const next = { ...prefs(), ...patch };
  fs.mkdirSync(stateRoot, { recursive: true });
  fs.writeFileSync(prefsPath, JSON.stringify(next, null, 2));
  return next;
}

function loadMedia(source) {
  if (!mediaCache.has(source)) {
    const media = resolveWallpaperMedia(source);
    if (media.renderMode === "webgl") mediaCache.set(source, media);
    else
    mediaCache.set(source, { ...media, base64: fs.readFileSync(media.path).toString("base64") });
  }
  return mediaCache.get(source);
}

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

async function acquireServer() {
  return await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      cors(res);
      if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
      const url = new URL(req.url, "http://127.0.0.1");
      try {
        if (url.pathname === "/health") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, pid: process.pid }));
        } else if (url.pathname === "/wallpapers") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(listWallpapers().map(item => ({ id: item.id, title: item.title, quality: item.renderMode === "native" ? "原生高清" : item.renderMode === "webgl" ? "WebGL渲染" : "静态预览", renderMode: item.renderMode }))));
        } else if (url.pathname === "/select") {
          const id = url.searchParams.get("id") || "";
          const wallpaper = listWallpapers().find(item => item.id === id);
          if (wallpaper) {
            writeSelection(wallpaper.id, wallpaper.title);
            mediaCache.delete(wallpaper.id);
            log(`select ${wallpaper.id} via http`);
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true, source: wallpaper.id, title: wallpaper.title }));
          } else {
            res.writeHead(404, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "wallpaper not found" }));
          }
        } else if (url.pathname === "/white-text") {
          const enabled = url.searchParams.get("enabled") !== "false";
          const next = writePrefs({ whiteText: enabled });
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, whiteText: next.whiteText }));
        } else if (url.pathname === "/prefs") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(prefs()));
        } else if (url.pathname === "/status") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ selection: selection(), prefs: prefs(), pid: process.pid }));
        } else if (url.pathname.startsWith("/scene-fallback/")) {
          const fid = url.pathname.split("/").filter(Boolean)[1];
          const fw = listWallpapers().find(item => item.id === fid);
          let fPath = null, fMime = null;
          if (fw && fw.sceneVideo && fs.existsSync(fw.sceneVideo)) { fPath = fw.sceneVideo; fMime = "video/mp4"; }
          else if (fw && fw.preview && fs.existsSync(fw.preview)) {
            fPath = fw.preview;
            const fx = path.extname(fw.preview).toLowerCase();
            fMime = { ".gif": "image/gif", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" }[fx] || "image/gif";
          }
          if (fPath) { res.writeHead(200, { "content-type": fMime }); fs.createReadStream(fPath).pipe(res); }
          else { res.writeHead(404, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: false, error: "no fallback media" })); }
        } else if (url.pathname.startsWith("/scene/")) {
          const parts = url.pathname.split("/").filter(Boolean);
          const sid = parts[1];
          const sw = listWallpapers().find(item => item.id === sid);
          if (sw && sw.sceneDir) {
            const rel = parts.slice(2).join("/");
            const safe = path.resolve(sw.sceneDir, rel || "scene.pkg");
            if (safe.startsWith(sw.sceneDir) && fs.existsSync(safe) && fs.statSync(safe).isFile()) {
              const ext = path.extname(safe).toLowerCase();
              const mime = { ".pkg": "application/octet-stream", ".tex": "application/octet-stream", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".bin": "application/octet-stream", ".txt": "text/plain", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg" }[ext] || "application/octet-stream";
              res.writeHead(200, { "content-type": mime }); fs.createReadStream(safe).pipe(res);
            } else { res.writeHead(404, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: false, error: "scene resource not found" })); }
          } else { res.writeHead(404, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: false, error: "scene wallpaper not found" })); }
        } else {
          res.writeHead(404, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "unknown route" }));
        }
      } catch (error) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: String(error.message || error) }));
      }
    });
    server.once("error", reject);
    server.listen(lockPort, "127.0.0.1", () => resolve(server));
  });
}

async function findPage() {
  for (const port of devtoolsPorts) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, { cache: "no-store" });
      if (!response.ok) continue;
      const targets = await response.json();
      const target = targets.find(item => item.type === "page" && item.url === "app://-/index.html");
      if (target) return { target, port };
    } catch {}
  }
  return null;
}

async function withPage(target, callback) {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = () => reject(new Error("DevTools connection failed"));
  });
  let nextId = 1;
  const pending = new Map();
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const waiter = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message));
    else if (message.result?.exceptionDetails) waiter.reject(new Error(message.result.exceptionDetails.exception?.description || message.result.exceptionDetails.text));
    else waiter.resolve(message.result?.result?.value);
  };
  async function command(method, params = {}) {
    const id = nextId++;
    socket.send(JSON.stringify({ id, method, params }));
    return await new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  }
  try { return await callback(command); } finally { socket.close(); }
}

async function status() {
  const found = await findPage();
  if (!found) return { page: false };
  return await withPage(found.target, command => command("Runtime.evaluate", {
    expression: `(() => ({
      page: true,
      background: !!document.getElementById("codex-custom-background-media"),
      base: !!document.getElementById("codex-custom-background-base"),
      source: document.getElementById("codex-custom-background-media")?.getAttribute("data-wallpaper-source") || null,
      readability: !!document.getElementById("codex-background-readability"),
      controls: !!document.getElementById("codex-background-controls"),
      picker: !!document.getElementById("codex-wallpaper-picker"),
      whiteText: !!document.getElementById("codex-force-white-style"),
      pickerCommand: (() => {
        const picker = document.getElementById("codex-wallpaper-picker");
        const command = picker?.dataset.command || "";
        if (picker) picker.dataset.command = "";
        return command;
      })()
    }))()`,
    returnByValue: true,
    awaitPromise: true
  }));
}

async function applyWhiteText() {
  const found = await findPage();
  if (!found) return false;
  return await withPage(found.target, command => command("Runtime.evaluate", {
    expression: `(() => {
      let style = document.getElementById("codex-force-white-style");
      if (!style) { style = document.createElement("style"); style.id = "codex-force-white-style"; document.head.append(style); }
      style.textContent = [
        "#root, #root *, #root *::before, #root *::after { color: #ffffff !important; fill: #ffffff !important; caret-color: #ffffff !important; }",
        "#root ::placeholder { color: rgba(255,255,255,.78) !important; }",
        "#root ::selection { background: rgba(56,189,248,.42) !important; color: #ffffff !important; }",
        "#root * { text-shadow: 0 1px 2px rgba(0,0,0,.62), 0 0 12px rgba(0,0,0,.32) !important; }"
      ].join("\\n");
      return { ok: true };
    })()`,
    returnByValue: true,
    awaitPromise: true
  }));
}

async function removeWhiteText() {
  const found = await findPage();
  if (!found) return false;
  return await withPage(found.target, command => command("Runtime.evaluate", {
    expression: `document.getElementById("codex-force-white-style")?.remove(); true`,
    returnByValue: true,
    awaitPromise: true
  }));
}

async function installSceneWebGL(found, current) {
  const port = lockPort;
  const wallpaperId = current.source;
  await withPage(found.target, async command => {
    return await command("Runtime.evaluate", {
      expression: `(async () => {
        for (const id of ["codex-custom-background-media", "codex-custom-background-base", "codex-background-readability", "codex-background-controls"]) document.getElementById(id)?.remove();
        for (const id of ["codex-custom-background-style", "codex-background-opacity-style", "codex-background-readability-style"]) document.getElementById(id)?.remove();
        const base = document.createElement("div");
        base.id = "codex-custom-background-base";
        base.style.cssText = "position:fixed!important;inset:0!important;background:#000!important;z-index:0!important;pointer-events:none!important";
        document.body.prepend(base);
        const mediaEl = document.createElement("div");
        mediaEl.id = "codex-custom-background-media";
        mediaEl.setAttribute("data-wallpaper-source", ${JSON.stringify(wallpaperId)});
        mediaEl.setAttribute("data-render-mode", "webgl");
        mediaEl.setAttribute("data-background-opacity", "1");
        mediaEl.setAttribute("data-surface-opacity", "0");
        mediaEl.setAttribute("data-blur", "0");
        mediaEl.style.cssText = "position:fixed!important;inset:0!important;z-index:0!important;pointer-events:none!important;opacity:1";
        document.body.prepend(mediaEl);
        const style = document.createElement("style");
        style.id = "codex-custom-background-style";
        style.textContent = [
          "html, body, #root, #root *, #root *::before, #root *::after { background: transparent !important; backdrop-filter: none !important; box-shadow: none !important; }",
          "#root { position: relative !important; z-index: 1 !important; min-height: 100vh !important; }",
          "#codex-custom-background-base, #codex-custom-background-base canvas { display: block !important; visibility: visible !important; }"
        ].join("\\n");
        document.head.append(style);
        try {
          const tc = document.createElement("canvas");
          if (!tc.getContext("webgl2")) throw new Error("WebGL2 not available");
          if (!window.WebWallGL) {
            await new Promise((resolve, reject) => {
              const s = document.createElement("script");
              s.src = "https://cdn.jsdelivr.net/npm/webwallgl@2.0.2/webwallgl.global.min.js";
              s.onload = () => resolve();
              s.onerror = () => reject(new Error("webwallgl load failed"));
              document.head.append(s);
            });
          }
          const { mount, httpSource } = window.WebWallGL;
          await mount(base, { source: httpSource("http://127.0.0.1:${port}/scene/${wallpaperId}") });
          mediaEl.setAttribute("data-webgl-ready", "true");
          return { ok: true, renderMode: "webgl", source: ${JSON.stringify(wallpaperId)} };
        } catch (err) {
          const fbUrl = "http://127.0.0.1:${port}/scene-fallback/${wallpaperId}";
          try {
            const resp = await fetch(fbUrl);
            if (!resp.ok) throw new Error("fallback fetch failed");
            const ct = resp.headers.get("content-type") || "";
            const blob = await resp.blob();
            const objUrl = URL.createObjectURL(blob);
            const isVideo = ct.startsWith("video/");
            mediaEl.remove();
            const fb = document.createElement(isVideo ? "video" : "img");
            fb.id = "codex-custom-background-media";
            fb.src = objUrl;
            fb.setAttribute("data-object-url", objUrl);
            fb.setAttribute("data-wallpaper-source", ${JSON.stringify(wallpaperId)});
            fb.setAttribute("data-render-mode", "fallback");
            fb.setAttribute("data-background-opacity", "1");
            fb.setAttribute("data-surface-opacity", "0");
            fb.setAttribute("data-blur", "0");
            if (isVideo) { fb.autoplay = true; fb.loop = true; fb.muted = true; fb.playsInline = true; fb.disablePictureInPicture = true; }
            fb.style.cssText = "position:fixed!important;inset:0!important;width:100vw!important;height:100vh!important;object-fit:cover!important;z-index:0!important;pointer-events:none!important;background:#000;opacity:1";
            document.body.prepend(fb);
            if (isVideo) fb.play().catch(() => {});
          } catch (e2) {}
          return { ok: true, renderMode: "fallback", error: String(err), source: ${JSON.stringify(wallpaperId)} };
        }
      })()`,
      returnByValue: true,
      awaitPromise: true
    });
  });
}
async function installBackground(current) {
  const found = await findPage();
  if (!found) throw new Error("Codex main page disappeared");
  const media = loadMedia(current.source);
  if (media.renderMode === "webgl") return await installSceneWebGL(found, current);
  const isVideo = media.type.startsWith("video/");
  await withPage(found.target, async command => {
    await command("Runtime.evaluate", { expression: "window.__codexWallpaperChunks = []; 0", returnByValue: true });
    for (let offset = 0; offset < media.base64.length; offset += chunkSize) {
      const chunk = media.base64.slice(offset, offset + chunkSize);
      await command("Runtime.evaluate", { expression: `window.__codexWallpaperChunks.push(${JSON.stringify(chunk)}); 0`, returnByValue: true });
    }
    return await command("Runtime.evaluate", {
      expression: `(() => {
        for (const id of ["codex-custom-background-media", "codex-custom-background-base", "codex-background-readability", "codex-background-controls"]) document.getElementById(id)?.remove();
        for (const id of ["codex-custom-background-style", "codex-background-opacity-style", "codex-background-readability-style"]) document.getElementById(id)?.remove();
        const binary = atob(window.__codexWallpaperChunks.join(""));
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
        window.__codexWallpaperChunks = [];
        const objectUrl = URL.createObjectURL(new Blob([bytes], { type: ${JSON.stringify(media.type)} }));
        const base = document.createElement("div");
        base.id = "codex-custom-background-base";
        base.style.cssText = "position:fixed!important;inset:0!important;background:#000!important;z-index:0!important;pointer-events:none!important";
        const media = document.createElement(${JSON.stringify(isVideo ? "video" : "img")});
        media.id = "codex-custom-background-media";
        if (${JSON.stringify(isVideo)}) { media.autoplay = true; media.loop = true; media.muted = true; media.playsInline = true; media.disablePictureInPicture = true; }
        media.src = objectUrl;
        media.setAttribute("data-object-url", objectUrl);
        media.setAttribute("data-wallpaper-source", ${JSON.stringify(current.source)});
        media.setAttribute("data-background-opacity", "1");
        media.setAttribute("data-surface-opacity", "0");
        media.setAttribute("data-blur", "0");
        media.style.cssText = "position:fixed!important;inset:0!important;width:100vw!important;height:100vh!important;object-fit:cover!important;z-index:0!important;pointer-events:none!important;background:#000;opacity:1";
        document.body.prepend(media);
        document.body.insertBefore(base, media);
        const style = document.createElement("style");
        style.id = "codex-custom-background-style";
        style.textContent = [
          "html, body, #root, #root *, #root *::before, #root *::after { background: transparent !important; backdrop-filter: none !important; box-shadow: none !important; }",
          "#root { position: relative !important; z-index: 1 !important; min-height: 100vh !important; }",
          "#codex-custom-background-media { display: block !important; visibility: visible !important; }"
        ].join("\\n");
        document.head.append(style);
        if (${JSON.stringify(isVideo)}) media.play().catch(() => {});
        return { bytes: bytes.length, type: ${JSON.stringify(media.type)}, source: ${JSON.stringify(current.source)} };
      })()`,
      returnByValue: true,
      awaitPromise: true
    });
  });
}

let restoring = false;
let controlsRunning = false;
let pickerRunning = false;
function launchControls() {
  controlsRunning = true;
  const child = spawn(process.execPath, [controlsScript], { windowsHide: true, cwd: root, stdio: "ignore" });
  child.once("error", error => { controlsRunning = false; log(`controls error: ${error.message}`); });
  child.once("exit", code => { controlsRunning = false; log(code === 0 ? "readability controls restored" : `controls exited ${code}`); });
}
function launchPicker() {
  pickerRunning = true;
  const child = spawn(process.execPath, [pickerScript], { windowsHide: true, cwd: root, stdio: "ignore" });
  child.once("error", error => { pickerRunning = false; log(`picker error: ${error.message}`); });
  child.once("exit", code => { pickerRunning = false; log(code === 0 ? "wallpaper picker restored" : `picker exited ${code}`); });
}

try {
  await acquireServer();
} catch (error) {
  log(`another watchdog already owns :${lockPort} (${error.message}); exiting`);
  process.exit(0);
}
log(`watchdog started pid=${process.pid}`);
let lastWhite = null;
for (;;) {
  try {
    const current = selection();
    const preference = prefs();
    const state = await status();
    if (state.page && state.pickerCommand && /^\d+$/.test(state.pickerCommand)) {
      const wallpaper = listWallpapers().find(item => item.id === state.pickerCommand);
      if (wallpaper) { writeSelection(wallpaper.id, wallpaper.title); mediaCache.delete(wallpaper.id); log(`picker selected ${wallpaper.id}`); }
    }
    if (state.page && preference.whiteText && !state.whiteText && lastWhite !== true) { await applyWhiteText(); lastWhite = true; }
    else if (state.page && !preference.whiteText && state.whiteText && lastWhite !== false) { await removeWhiteText(); lastWhite = false; }
    else if (!state.page) { lastWhite = null; }
    if (!current.source) { await wait(5000); continue; }
    const needsBackground = state.page && (!state.background || !state.base || state.source !== current.source);
    const needsControls = state.page && (!state.readability || !state.controls);
    const needsPicker = state.page && !state.picker;
    if (!restoring && (needsBackground || (needsControls && !controlsRunning) || (needsPicker && !pickerRunning))) {
      restoring = true;
      try {
        if (needsBackground) { await installBackground(current); log(`background installed: ${current.source}`); }
        if (needsBackground || needsControls) launchControls();
        if (needsPicker) launchPicker();
      } catch (error) { log(`restore error: ${error.message}`); mediaCache.delete(current.source); }
      finally { restoring = false; }
    }
  } catch (error) { log(`error: ${error.message}`); }
  await wait(2000);
}
