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
    return await new Promise((resolve, reject) => {
      /* A hidden/occluded app window can stall a DevTools evaluate forever
         (rAF-driven library code never settles); without this the watchdog
         main loop would stick on `restoring` and stop restoring entirely. */
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out after 240s`)); }, 240000);
      pending.set(id, {
        resolve: value => { clearTimeout(timer); resolve(value); },
        reject: error => { clearTimeout(timer); reject(error); },
      });
    });
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
  const wallpaper = listWallpapers().find(item => item.id === wallpaperId);

  /* Resolve the best fallback media entirely on the Node side. Codex's page
     CSP blocks page-side fetch() to both the WebWallGL CDN and this watchdog
     server, so the previous design (which let the page fetch its fallback over
     HTTP) produced a pure-black background. We now inject the bytes through
     DevTools, which bypasses CSP and mirrors the working video/image path. */
  let fallbackPath = null;
  let fallbackMime = "image/gif";
  if (wallpaper && wallpaper.sceneVideo && fs.existsSync(wallpaper.sceneVideo)) {
    fallbackPath = wallpaper.sceneVideo; fallbackMime = "video/mp4";
  } else if (wallpaper && wallpaper.preview && fs.existsSync(wallpaper.preview)) {
    fallbackPath = wallpaper.preview;
    const ext = path.extname(wallpaper.preview).toLowerCase();
    fallbackMime = { ".gif": "image/gif", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" }[ext] || "image/gif";
  }
  const fallbackChunks = [];
  if (fallbackPath) {
    try {
      const base64 = fs.readFileSync(fallbackPath).toString("base64");
      for (let offset = 0; offset < base64.length; offset += chunkSize) fallbackChunks.push(base64.slice(offset, offset + chunkSize));
    } catch (error) { log(`scene fallback read failed for ${wallpaperId}: ${error.message}`); }
  }

  /* Optional live WebGL rendering via a vendored WebWallGL build. Drop
     webwallgl.global.min.js into <plugin>/server/vendor/ to enable it. The
     library is injected through Runtime.evaluate, which bypasses CSP. */
  const vendorLib = path.join(root, "vendor", "webwallgl.global.min.js");
  let librarySource = null;
  try { if (fs.existsSync(vendorLib)) librarySource = fs.readFileSync(vendorLib, "utf8"); } catch {}

  /* The scene pkg bytes must also be injected: WebWallGL's httpSource would
     fetch() from this server, and the page CSP (default-src 'none') blocks
     connect-src even for inspector-injected code. bytesSource(pkgBytes,
     project, key) feeds the library directly, so the scene renders with zero
     page-side network. */
  const sceneChunkSize = 4 * 1024 * 1024;
  let sceneChunks = [];
  let sceneProject = null;
  if (librarySource && wallpaper && wallpaper.scene && fs.existsSync(wallpaper.scene)) {
    try {
      const base64 = fs.readFileSync(wallpaper.scene).toString("base64");
      for (let offset = 0; offset < base64.length; offset += sceneChunkSize) sceneChunks.push(base64.slice(offset, offset + sceneChunkSize));
      const projectPath = path.join(path.dirname(wallpaper.scene), "project.json");
      if (fs.existsSync(projectPath)) { try { sceneProject = JSON.parse(fs.readFileSync(projectPath, "utf8")); } catch {} }
    } catch (error) { log(`scene pkg read failed for ${wallpaperId}: ${error.message}`); sceneChunks = []; }
  }

  const result = await withPage(found.target, async command => {
    await command("Runtime.evaluate", { expression: "window.__codexSceneFallback = { chunks: [], mime: '' }; 0", returnByValue: true });
    for (const chunk of fallbackChunks) {
      await command("Runtime.evaluate", { expression: `window.__codexSceneFallback.chunks.push(${JSON.stringify(chunk)}); 0`, returnByValue: true });
    }
    await command("Runtime.evaluate", { expression: `window.__codexSceneFallback.mime = ${JSON.stringify(fallbackMime)}; 0`, returnByValue: true });

    let libraryAvailable = false;
    if (librarySource) {
      libraryAvailable = await command("Runtime.evaluate", {
        expression: `(() => { try { (0,eval)(${JSON.stringify(librarySource)}); window.__webwallglLibError = ""; return !!window.WebWallGL; } catch (e) { window.__webwallglLibError = String(e); return false; } })()`,
        returnByValue: true,
        awaitPromise: true
      });
    }

    if (libraryAvailable && sceneChunks.length) {
      await command("Runtime.evaluate", { expression: "window.__codexScenePkg = { chunks: [], project: null }; 0", returnByValue: true });
      for (const chunk of sceneChunks) {
        await command("Runtime.evaluate", { expression: `window.__codexScenePkg.chunks.push(${JSON.stringify(chunk)}); 0`, returnByValue: true });
      }
      await command("Runtime.evaluate", { expression: `window.__codexScenePkg.project = ${JSON.stringify(sceneProject)}; 0`, returnByValue: true });
    }

    return await command("Runtime.evaluate", {
      expression: `(async () => {
        const wallpaperId = ${JSON.stringify(wallpaperId)};
        const libraryAvailable = ${JSON.stringify(!!libraryAvailable)};
        const loseGl = (el) => { try { const ctx = el && el.getContext ? (el.getContext("webgl2") || el.getContext("webgl")) : null; if (ctx && ctx.getExtension) { const ext = ctx.getExtension("WEBGL_lose_context"); if (ext) ext.loseContext(); } } catch {} };
        const teardown = () => {
          if (window.__webwallglInstance) { try { if (window.__webwallglInstance.destroy) window.__webwallglInstance.destroy(); } catch {} try { if (window.__webwallglInstance.unmount) window.__webwallglInstance.unmount(); } catch {} try { if (window.__webwallglInstance.dispose) window.__webwallglInstance.dispose(); } catch {} window.__webwallglInstance = null; }
          for (const sel of ["#codex-custom-background-base canvas", "#codex-custom-background-media", "#codex-custom-background-base"]) { const el = document.querySelector(sel); if (el) { loseGl(el); el.remove(); } }
          for (const id of ["codex-background-readability", "codex-background-controls", "codex-custom-background-style", "codex-background-opacity-style", "codex-background-readability-style"]) { try { document.getElementById(id)?.remove(); } catch {} }
        };
        const injectBaseStyle = () => {
          const style = document.createElement("style");
          style.id = "codex-custom-background-style";
          style.textContent = [
            "html, body, #root, #root *, #root *::before, #root *::after { background: transparent !important; backdrop-filter: none !important; box-shadow: none !important; }",
            "#root { position: relative !important; z-index: 1 !important; min-height: 100vh !important; }",
            "#codex-custom-background-media { display: block !important; visibility: visible !important; }"
          ].join("\\n");
          document.head.append(style);
        };
        const renderFallback = (reason) => {
          const data = window.__codexSceneFallback;
          if (!data || !Array.isArray(data.chunks) || !data.chunks.length) return { ok: false, renderMode: "failed", webglError: String(reason), fallbackError: "no fallback media injected", source: wallpaperId };
          const binary = atob(data.chunks.join(""));
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
          const objectUrl = URL.createObjectURL(new Blob([bytes], { type: data.mime }));
          const isVideo = data.mime.startsWith("video/");
          const usedMime = data.mime;
          const usedBytes = bytes.length;
          window.__codexSceneFallback = null;
          teardown();
          const fb = document.createElement(isVideo ? "video" : "img");
          fb.id = "codex-custom-background-media";
          fb.src = objectUrl;
          fb.setAttribute("data-object-url", objectUrl);
          fb.setAttribute("data-wallpaper-source", wallpaperId);
          fb.setAttribute("data-render-mode", "fallback");
          fb.setAttribute("data-background-opacity", "1");
          fb.setAttribute("data-surface-opacity", "0");
          fb.setAttribute("data-blur", "0");
          if (isVideo) { fb.autoplay = true; fb.loop = true; fb.muted = true; fb.playsInline = true; fb.disablePictureInPicture = true; }
          fb.style.cssText = "position:fixed!important;inset:0!important;width:100vw!important;height:100vh!important;object-fit:cover!important;z-index:0!important;pointer-events:none!important;background:#000;opacity:1";
          document.body.prepend(fb);
          const fbBase = document.createElement("div");
          fbBase.id = "codex-custom-background-base";
          fbBase.setAttribute("data-wallpaper-source", wallpaperId);
          fbBase.style.cssText = "position:fixed!important;inset:0!important;background:#000!important;z-index:0!important;pointer-events:none!important";
          document.body.prepend(fbBase);
          injectBaseStyle();
          if (isVideo) fb.play().catch(() => {});
          return { ok: true, renderMode: "fallback", webglError: String(reason), source: wallpaperId, fallbackBytes: usedBytes, fallbackMime: usedMime };
        };
        const mountWebGL = async () => {
          teardown();
          if (!libraryAvailable) {
            return renderFallback(window.__webwallglLibError ? ("WebWallGL library error: " + window.__webwallglLibError) : "WebWallGL library not vendored (offline environment)");
          }
          const tc = document.createElement("canvas");
          const testCtx = tc.getContext("webgl2");
          if (!testCtx) return renderFallback("WebGL2 not available");
          try { testCtx.getExtension("WEBGL_lose_context")?.loseContext(); } catch {}
          const base = document.createElement("div");
          base.id = "codex-custom-background-base";
          base.setAttribute("data-wallpaper-source", wallpaperId);
          base.style.cssText = "position:fixed!important;inset:0!important;background:#000!important;z-index:0!important;pointer-events:none!important;display:block!important";
          document.body.prepend(base);
          const pkgData = window.__codexScenePkg;
          if (!pkgData || !pkgData.chunks.length) throw new Error("scene pkg not injected (missing scene.pkg?)");
          const pkgBinary = atob(pkgData.chunks.join(""));
          const pkgBytes = new Uint8Array(pkgBinary.length);
          for (let i = 0; i < pkgBinary.length; i++) pkgBytes[i] = pkgBinary.charCodeAt(i);
          const pkgLen = pkgBytes.length;
          const pkgProject = pkgData.project;
          window.__codexScenePkg = null;
          const { mount, bytesSource } = window.WebWallGL;
          const mountStarted = performance.now();
          const inst = await mount(base, { source: bytesSource(pkgBytes, pkgProject, "watchdog:" + wallpaperId) });
          if (!inst) throw new Error("WebWallGL mount returned no instance");
          window.__webwallglInstance = inst;
          const mediaEl = document.createElement("div");
          mediaEl.id = "codex-custom-background-media";
          mediaEl.setAttribute("data-wallpaper-source", wallpaperId);
          mediaEl.setAttribute("data-render-mode", "webgl");
          mediaEl.setAttribute("data-webgl-ready", "true");
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
            "#codex-custom-background-base, #codex-custom-background-base canvas { display: block !important; visibility: visible !important; width: 100vw !important; height: 100vh !important; }"
          ].join("\\n");
          document.head.append(style);
          return { ok: true, renderMode: "webgl", source: wallpaperId, pkgBytes: pkgLen, mountMs: Math.round(performance.now() - mountStarted) };
        };
        /* While the app window is hidden/occluded Chromium freezes rAF, so the
           render loop cannot produce the first frame mount() waits for (the
           library gives up after 60s or hangs outright). Show the injected
           fallback right away and upgrade to WebGL the moment the page
           becomes visible again. */
        if (document.visibilityState === "hidden" && window.__codexSceneFallback && window.__codexSceneFallback.chunks.length) {
          const deferred = renderFallback("window hidden - WebGL mount deferred until the page is visible");
          if (deferred && deferred.ok) {
            document.addEventListener("visibilitychange", () => {
              if (document.visibilityState !== "visible") return;
              mountWebGL().then(result => { window.__codexDeferredWebGL = result && result.renderMode === "webgl" ? "webgl" : "failed"; }).catch(() => { window.__codexDeferredWebGL = "failed"; });
            }, { once: true });
            setTimeout(() => { window.__codexScenePkg = null; }, 600000);
            return { ...deferred, deferredWebGL: true };
          }
          return deferred;
        }
        try {
          return await mountWebGL();
        } catch (err) {
          return renderFallback(err);
        }
      })()`,
      returnByValue: true,
      awaitPromise: true
    });
  });
  if (result && result.renderMode === "webgl") {
    log(`scene webgl ${wallpaperId}: renderMode=webgl (vendored WebWallGL, bytesSource pkgBytes=${result.pkgBytes} mountMs=${result.mountMs})`);
  } else if (result) {
    log(`scene webgl ${wallpaperId}: renderMode=${result.renderMode}${result.deferredWebGL ? " deferredWebGL=true" : ""}${result.webglError ? " webglError=" + String(result.webglError).slice(0, 180) : ""}${result.fallbackError ? " fallbackError=" + result.fallbackError : ""}${result.fallbackBytes ? " fallbackBytes=" + result.fallbackBytes + " mime=" + result.fallbackMime : ""}${result.error ? " error=" + result.error : ""}`);
  }
  return result;
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
        const loseGl = (el) => { try { const ctx = el && el.getContext ? (el.getContext("webgl2") || el.getContext("webgl")) : null; if (ctx && ctx.getExtension) { const ext = ctx.getExtension("WEBGL_lose_context"); if (ext) ext.loseContext(); } } catch {} };
        if (window.__webwallglInstance) { try { window.__webwallglInstance.destroy && window.__webwallglInstance.destroy(); } catch {} try { window.__webwallglInstance.unmount && window.__webwallglInstance.unmount(); } catch {} try { window.__webwallglInstance.dispose && window.__webwallglInstance.dispose(); } catch {} window.__webwallglInstance = null; }
        for (const sel of ["#codex-custom-background-base canvas"]) { const el = document.querySelector(sel); if (el) { loseGl(el); el.remove(); } }
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
        base.setAttribute("data-wallpaper-source", ${JSON.stringify(current.source)});
        const media = document.createElement(${JSON.stringify(isVideo ? "video" : "img")});
        media.id = "codex-custom-background-media";
        if (${JSON.stringify(isVideo)}) { media.autoplay = true; media.loop = true; media.muted = true; media.playsInline = true; media.disablePictureInPicture = true; }
        media.src = objectUrl;
        media.setAttribute("data-object-url", objectUrl);
        media.setAttribute("data-wallpaper-source", ${JSON.stringify(current.source)});
        media.setAttribute("data-render-mode", ${JSON.stringify(media.renderMode)});
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
