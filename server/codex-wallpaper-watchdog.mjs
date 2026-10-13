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
const VENDORED_WEBWALLGL_VERSION = "2.1.0";
let libCapabilitiesLogged = false;
const mediaCache = new Map();
let memorySelection = null;
let lastDeferredUpgrade = null;

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
    else {
      const buf = fs.readFileSync(media.path);
      mediaCache.set(source, buf.length <= NATIVE_CACHE_MAX ? { ...media, buf } : media);
    }
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
            selectEpoch++;
            writeSelection(wallpaper.id, wallpaper.title);
            mediaCache.delete(wallpaper.id);
            log(`select ${wallpaper.id} via http`);
            wakeTicker();
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
          const payload = { selection: selection(), prefs: prefs(), pid: process.pid, deferredUpgrade: lastDeferredUpgrade };
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(payload));
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
        /* A route can throw after it already wrote its status line; re-sending
           headers from here raised ERR_HTTP_HEADERS_SENT inside the catch and
           killed the whole watchdog process (any /status caller could do it). */
        if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
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
  socket.onclose = () => { for (const waiter of pending.values()) { try { waiter.reject(new Error("DevTools socket closed")); } catch {} } pending.clear(); };
  async function command(method, params = {}, timeoutMs = 30000) {
    const id = nextId++;
    socket.send(JSON.stringify({ id, method, params }));
    return await new Promise((resolve, reject) => {
      /* A hidden/occluded app window can stall a DevTools evaluate forever
         (rAF-driven library code never settles); without this the watchdog
         main loop would stick on `restoring` and stop restoring entirely. */
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out after ${timeoutMs}ms`)); }, timeoutMs);
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
      deferredUpgrade: (() => { const v = window.__codexDeferredWebGL || null; if (v) { const d = window.__codexDeferredDiag || ""; window.__codexDeferredWebGL = null; window.__codexDeferredDiag = null; return { result: v, lastDiag: d }; } return null; })(),
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

/* Phase 2: yield independently-decodable base64 chunks (each encodes a whole
   number of raw bytes) so the page can decode them one at a time straight into
   a pre-allocated Uint8Array. Never holds the whole file or its full base64
   expansion in memory - only one chunk buffer at a time. */
function* base64ChunkSource(filePath, rawChunkBytes) {
  let fd;
  try { fd = fs.openSync(filePath, "r"); } catch { return; }
  try {
    const buf = Buffer.alloc(rawChunkBytes);
    let pos = 0;
    for (;;) {
      const n = fs.readSync(fd, buf, 0, rawChunkBytes, pos);
      if (n <= 0) break;
      yield buf.subarray(0, n).toString("base64");
      pos += n;
    }
  } finally { try { fs.closeSync(fd); } catch {} }
}

/* Phase 3: yield base64 chunks from a cached in-memory Buffer (hot path).
   The cache stores raw bytes (not the ~1.33x base64 expansion) keyed by
   (wallpaper id, pkg mtime, pkg size). LRU eviction keeps the total under
   PKG_CACHE_BUDGET; files larger than PKG_CACHE_MAX per entry bypass the
   cache and stream from disk (Phase 2 cold path). */
function* base64ChunkSourceFromBuffer(buf, rawChunkBytes) {
  for (let pos = 0; pos < buf.length; pos += rawChunkBytes) {
    yield buf.subarray(pos, Math.min(pos + rawChunkBytes, buf.length)).toString("base64");
  }
}

const pkgByteCache = new Map();
const PKG_CACHE_MAX = 256 * 1024 * 1024;
const PKG_CACHE_BUDGET = 512 * 1024 * 1024;
const NATIVE_CACHE_MAX = 256 * 1024 * 1024;
let pkgCacheBytes = 0;

function evictPkgCache() {
  while (pkgCacheBytes > PKG_CACHE_BUDGET && pkgByteCache.size > 0) {
    const oldest = pkgByteCache.keys().next().value;
    const entry = pkgByteCache.get(oldest);
    pkgByteCache.delete(oldest);
    pkgCacheBytes -= entry.bytes.length;
  }
}
/* In-page chunk sink shared by the scene pkg, the scene fallback and the native
   media injection. Uint8Array.fromBase64 decodes a whole chunk in one native
   call, and the sink yields to the page after every chunk so the outgoing
   wallpaper keeps painting while the next one is staged - the old inline
   atob + per-byte loop held the main thread for the entire chunk. */
const INGEST_HELPER = `window.__codexIngest = async (key, b64) => {
  const target = window[key];
  if (!target || !target.bytes) throw new Error("no ingest target " + key);
  const offset = target.offset;
  let chunk;
  if (typeof Uint8Array.fromBase64 === "function") chunk = Uint8Array.fromBase64(b64);
  else { const binary = atob(b64); chunk = new Uint8Array(binary.length); for (let i = 0; i < binary.length; i++) chunk[i] = binary.charCodeAt(i); }
  target.bytes.set(chunk, offset);
  target.offset = offset + chunk.length;
  await new Promise(resolve => {
    let done = false;
    const finish = () => { if (done) return; done = true; clearTimeout(timer); resolve(); };
    const timer = setTimeout(finish, 250);
    if (window.scheduler && typeof scheduler.yield === "function") scheduler.yield().then(finish, finish);
    else requestAnimationFrame(finish);
  });
  return chunk.length;
}; 0`;
async function installSceneWebGL(found, current) {
  const port = lockPort;
  const wallpaperId = current.source;
  const installEpoch = selectEpoch;
  const wallpaper = listWallpapers().find(item => item.id === wallpaperId);

  /* Resolve the best fallback media entirely on the Node side. Codex's page
     CSP blocks page-side fetch() to both the WebWallGL CDN and this watchdog
     server, so we inject the bytes through DevTools (bypassing CSP). Phase 2:
     only the total byte count is read up front; the bytes themselves are
     streamed chunk-by-chunk during injection, so neither side ever holds the
     whole file plus its ~1.33x base64 expansion at once. */
  /* Pick the cheapest fallback media. A few Scene packages embed a >100MB video
     that the old code streamed through DevTools on every single switch (273 x
     384KB round trips) even though WebGL renders fine; the ~1MB preview image
     is plenty for the rare WebGL failure, so prefer the smaller candidate and
     skip the pre-injection entirely when even that is oversized. */
  const FALLBACK_MAX_BYTES = 24 * 1024 * 1024;
  const fallbackCandidates = [];
  if (wallpaper && wallpaper.sceneVideo && fs.existsSync(wallpaper.sceneVideo)) {
    let size = 0; try { size = fs.statSync(wallpaper.sceneVideo).size; } catch {}
    fallbackCandidates.push({ path: wallpaper.sceneVideo, mime: "video/mp4", size });
  }
  if (wallpaper && wallpaper.preview && fs.existsSync(wallpaper.preview)) {
    const ext = path.extname(wallpaper.preview).toLowerCase();
    let size = 0; try { size = fs.statSync(wallpaper.preview).size; } catch {}
    fallbackCandidates.push({ path: wallpaper.preview, mime: { ".gif": "image/gif", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" }[ext] || "image/gif", size });
  }
  fallbackCandidates.sort((a, b) => a.size - b.size);
  const chosenFallback = fallbackCandidates.find(candidate => candidate.size > 0) || null;
  let fallbackPath = null;
  let fallbackMime = "image/gif";
  let fallbackBytes = 0;
  if (chosenFallback && chosenFallback.size <= FALLBACK_MAX_BYTES) {
    fallbackPath = chosenFallback.path; fallbackMime = chosenFallback.mime; fallbackBytes = chosenFallback.size;
  }

  /* Optional live WebGL rendering via a vendored WebWallGL build. Drop
     webwallgl.global.min.js into <plugin>/server/vendor/ to enable it. The
     library is injected through Runtime.evaluate, which bypasses CSP. */
  const vendorLib = path.join(root, "vendor", "webwallgl.global.min.js");
  let librarySource = null;
  try { if (fs.existsSync(vendorLib)) librarySource = fs.readFileSync(vendorLib, "utf8"); } catch {}

  /* The scene pkg bytes are injected the same way (page CSP blocks any
     page-side fetch). Phase 2 streams the pkg; only its total size is read up
     front so the page can pre-allocate the destination Uint8Array. */
  const sceneRawChunk = 3 * 1024 * 1024;
  const fallbackRawChunk = 384 * 1024;
  let scenePath = null;
  let sceneBytes = 0;
  let sceneProject = null;
  if (librarySource && wallpaper && wallpaper.scene && fs.existsSync(wallpaper.scene)) {
    try {
      scenePath = wallpaper.scene;
      sceneBytes = fs.statSync(scenePath).size;
      const projectPath = path.join(path.dirname(wallpaper.scene), "project.json");
      if (fs.existsSync(projectPath)) { try { sceneProject = JSON.parse(fs.readFileSync(projectPath, "utf8")); } catch {} }
    } catch (error) { log(`scene pkg stat failed for ${wallpaperId}: ${error.message}`); scenePath = null; sceneBytes = 0; }
  }
  /* Resolve scene bytes: try the in-memory pkg cache first (Phase 3), so
     A->B->A re-selects skip disk I/O entirely. On cache miss + file small
     enough, read the full file once and cache it for future hot paths. */
  let sceneBuf = null;
  if (scenePath && sceneBytes > 0) {
    let stat;
    try { stat = fs.statSync(scenePath); } catch { stat = null; }
    const cached = stat ? pkgByteCache.get(wallpaperId) : null;
    if (cached && cached.mtime === stat.mtimeMs && cached.size === sceneBytes) {
      sceneBuf = cached.bytes;
      log(`pkg cache hit ${wallpaperId}`);
    } else if (stat && sceneBytes <= PKG_CACHE_MAX) {
      try {
        const bytes = fs.readFileSync(scenePath);
        /* Drop a stale entry's bytes first so the budget does not over-count. */
        const staleEntry = pkgByteCache.get(wallpaperId);
        if (staleEntry) pkgCacheBytes -= staleEntry.bytes.length;
        pkgByteCache.delete(wallpaperId);
        pkgByteCache.set(wallpaperId, { bytes, mtime: stat.mtimeMs, size: sceneBytes });
        pkgCacheBytes += bytes.length;
        evictPkgCache();
        sceneBuf = bytes;
        log(`pkg cache populated ${wallpaperId} (${bytes.length} bytes, cache total ${pkgCacheBytes} bytes)`);
      } catch (error) { log(`pkg cache populate failed ${wallpaperId}: ${error.message}`); sceneBuf = null; }
    } else if (stat && sceneBytes > PKG_CACHE_MAX) {
      log(`pkg cache bypass ${wallpaperId} (file ${sceneBytes} bytes exceeds ${PKG_CACHE_MAX} limit, streaming from disk)`);
    }
  }

  const phaseMs = { pre: 0 };
  const result = await withPage(found.target, async command => {
    const preStartedAt = Date.now();
    await command("Runtime.evaluate", { expression: `${INGEST_HELPER}\nwindow.__codexSceneFallback = { bytes: new Uint8Array(${fallbackBytes}), offset: 0, mime: ${JSON.stringify(fallbackMime)} }; 0`, returnByValue: true });
    if (fallbackPath && fallbackBytes > 0) {
      let fallbackInjected = true;
      for (const chunk of base64ChunkSource(fallbackPath, fallbackRawChunk)) {
        if (selectEpoch !== installEpoch) { log(`install aborted (superseded during fallback injection): ${wallpaperId}`); fallbackInjected = false; break; }
        try { await command("Runtime.evaluate", { expression: `window.__codexIngest("__codexSceneFallback", ${JSON.stringify(chunk)})`, returnByValue: true, awaitPromise: true }); }
        catch (error) { log(`scene fallback inject failed for ${wallpaperId}: ${error.message}`); fallbackInjected = false; break; }
      }
      if (!fallbackInjected) { await command("Runtime.evaluate", { expression: "window.__codexSceneFallback = { bytes: new Uint8Array(0), offset: 0, mime: '' }; 0", returnByValue: true }); }
    }

    let libraryAvailable = false;
    if (librarySource) {
      /* Re-evaluating the ~1.1MB library on every switch cost a few hundred ms.
         window.WebWallGL survives background swaps, so only inject it when the
         page has actually lost it (fresh page, or after an app reload). */
      libraryAvailable = await command("Runtime.evaluate", {
        expression: `(() => { if (window.WebWallGL && typeof window.WebWallGL.mount === "function" && typeof window.WebWallGL.bytesSource === "function") return true; try { (0,eval)(${JSON.stringify(librarySource)}); window.__webwallglLibError = ""; window.__webwallglApiKeys = window.WebWallGL ? Object.keys(window.WebWallGL).sort().join(",") : ""; return !!window.WebWallGL; } catch (e) { window.__webwallglLibError = String(e); return false; } })()`,
        returnByValue: true,
        awaitPromise: true
      });
    }
    if (libraryAvailable && !libCapabilitiesLogged) { try { const apiKeys = await command("Runtime.evaluate", { expression: "window.__webwallglApiKeys || ''", returnByValue: true }); const missing = ["mount", "bytesSource"].filter(k => !apiKeys.includes(k)); log(`webwallgl vendored=${VENDORED_WEBWALLGL_VERSION} api=[${apiKeys}]${missing.length ? " MISSING=" + missing.join(",") : ""}`); libCapabilitiesLogged = true; } catch {} }

    if (libraryAvailable && scenePath && sceneBytes > 0) {
      await command("Runtime.evaluate", { expression: `${INGEST_HELPER}\nwindow.__codexScenePkg = { bytes: new Uint8Array(${sceneBytes}), offset: 0, project: ${JSON.stringify(sceneProject)} }; 0`, returnByValue: true });
      let sceneInjected = true;
      const sceneSource = sceneBuf ? base64ChunkSourceFromBuffer(sceneBuf, sceneRawChunk) : base64ChunkSource(scenePath, sceneRawChunk);
      for (const chunk of sceneSource) {
        if (selectEpoch !== installEpoch) { log(`install aborted (superseded during scene injection): ${wallpaperId}`); sceneInjected = false; break; }
        try { await command("Runtime.evaluate", { expression: `window.__codexIngest("__codexScenePkg", ${JSON.stringify(chunk)})`, returnByValue: true, awaitPromise: true }); }
        catch (error) { log(`scene pkg inject failed for ${wallpaperId}: ${error.message}`); sceneInjected = false; break; }
      }
      if (!sceneInjected) { await command("Runtime.evaluate", { expression: "window.__codexScenePkg = null; 0", returnByValue: true }); }
    }

    phaseMs.pre = Date.now() - preStartedAt;
    if (selectEpoch !== installEpoch) { log(`install aborted (superseded): ${wallpaperId}`); return { ok: true, renderMode: "aborted", source: wallpaperId }; }
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
        const diagBuffer = []; const diagMax = 16; window.__codexWebglDiag = diagBuffer;
        const pushDiag = (level, msg) => { const text = String(msg || "").slice(0, 200); diagBuffer.push({ level: String(level || "").toUpperCase(), msg: text, t: Math.round(performance.now()) }); if (diagBuffer.length > diagMax) diagBuffer.shift(); };
        const lastDiag = () => { if (!diagBuffer.length) return ""; const last = diagBuffer[diagBuffer.length - 1]; return last.level + ":" + last.msg; };
        const diagCount = () => diagBuffer.length;
        const injectBaseStyle = () => {
          document.getElementById("codex-custom-background-style")?.remove();
          const style = document.createElement("style");
          style.id = "codex-custom-background-style";
          style.textContent = [
            "html, body, #root, #root *, #root *::before, #root *::after { background: transparent !important; backdrop-filter: none !important; box-shadow: none !important; }",
            "#root { position: relative !important; z-index: 1 !important; min-height: 100vh !important; }",
            "#codex-custom-background-media { display: block !important; visibility: visible !important; }"
          ].join("\\n");
          document.head.append(style);
        };
        /* Cross-fade plumbing. The currently visible layers are captured up
           front and left alone (still rendering) while the replacement is
           staged at opacity 0; once it is ready we swap the ids into place and
           fade the old layers out. Previously every switch tore the old
           background down first, so the page sat on a black canvas for the
           whole inject+mount window - and with a slow mount the blurry preview
           was the first thing the user saw. */
        const PENDING_BASE_ID = "codex-custom-background-base-pending";
        const previousLayers = () => ["codex-custom-background-base", "codex-custom-background-media"].map(id => document.getElementById(id)).filter(Boolean);
        const dropPending = () => { const el = document.getElementById(PENDING_BASE_ID); if (el) { loseGl(el.querySelector("canvas")); el.remove(); } };
        const revealBackground = (baseEl, mediaEl, oldLayers) => {
          baseEl.id = "codex-custom-background-base";
          mediaEl.id = "codex-custom-background-media";
          document.body.prepend(mediaEl);
          document.body.prepend(baseEl);
          baseEl.style.opacity = "1";
          mediaEl.style.opacity = "1";
          for (const el of oldLayers) {
            if (!el || !el.isConnected) continue;
            const deadCanvas = el.querySelector ? el.querySelector("canvas") : null;
            el.style.transition = "opacity 260ms ease";
            el.style.opacity = "0";
            setTimeout(() => { try { if (deadCanvas) loseGl(deadCanvas); el.remove(); } catch {} }, 340);
          }
        };
        const renderFallback = (reason, oldLayers) => {
          const data = window.__codexSceneFallback;
          if (!data || !data.bytes || !data.bytes.length) return { ok: false, renderMode: "failed", webglError: String(reason), fallbackError: "no fallback media injected", source: wallpaperId };
          const bytes = data.bytes;
          const usedMime = data.mime;
          const isVideo = usedMime.startsWith("video/");
          const usedBytes = bytes.length;
          window.__codexSceneFallback = null;
          dropPending();
          const objectUrl = URL.createObjectURL(new Blob([bytes], { type: usedMime }));
          const fb = document.createElement(isVideo ? "video" : "img");
          fb.src = objectUrl;
          fb.setAttribute("data-object-url", objectUrl);
          fb.setAttribute("data-wallpaper-source", wallpaperId);
          fb.setAttribute("data-render-mode", "fallback");
          fb.setAttribute("data-background-opacity", "1");
          fb.setAttribute("data-surface-opacity", "0");
          fb.setAttribute("data-blur", "0");
          if (isVideo) { fb.autoplay = true; fb.loop = true; fb.muted = true; fb.playsInline = true; fb.disablePictureInPicture = true; }
          fb.style.cssText = "position:fixed!important;inset:0!important;width:100vw!important;height:100vh!important;object-fit:cover!important;z-index:0!important;pointer-events:none!important;background:#000;opacity:0";
          const fbBase = document.createElement("div");
          fbBase.setAttribute("data-wallpaper-source", wallpaperId);
          fbBase.style.cssText = "position:fixed!important;inset:0!important;background:#000!important;z-index:0!important;pointer-events:none!important;opacity:0";
          revealBackground(fbBase, fb, oldLayers);
          injectBaseStyle();
          if (isVideo) fb.play().catch(() => {});
          return { ok: true, renderMode: "fallback", webglError: String(reason), source: wallpaperId, fallbackBytes: usedBytes, fallbackMime: usedMime };
        };
        const mountWebGL = async (oldLayers) => {
          dropPending();
          if (!libraryAvailable) {
            return renderFallback(window.__webwallglLibError ? ("WebWallGL library error: " + window.__webwallglLibError) : "WebWallGL library not vendored (offline environment)", oldLayers);
          }
          const tc = document.createElement("canvas");
          const testCtx = tc.getContext("webgl2");
          if (!testCtx) return renderFallback("WebGL2 not available", oldLayers);
          try { testCtx.getExtension("WEBGL_lose_context")?.loseContext(); } catch {}
          const previousInstance = window.__webwallglInstance;
          const base = document.createElement("div");
          base.id = PENDING_BASE_ID;
          base.setAttribute("data-wallpaper-source", wallpaperId);
          base.style.cssText = "position:fixed!important;inset:0!important;background:#000!important;z-index:0!important;pointer-events:none!important;display:block!important;opacity:0";
          document.body.prepend(base);
          const pkgData = window.__codexScenePkg;
          if (!pkgData || !pkgData.bytes || !pkgData.bytes.length) throw new Error("scene pkg not injected (missing scene.pkg?)");
          const pkgBytes = pkgData.bytes;
          const pkgLen = pkgBytes.length;
          const pkgProject = pkgData.project;
          window.__codexScenePkg = null;
          const { mount, bytesSource } = window.WebWallGL;
          /* Ask WebWallGL for the top tier it can hold: renderDpr >= 1.5 lifts
             its internal resource cap (textures were sampled at 0.6-0.8x) and
             4x MSAA cleans up edges. The library's own adaptive quality still
             steps down on a machine that cannot keep up. */
          const renderDpr = Math.min(2, Math.max(window.devicePixelRatio || 1, 1.5));
          const quality = { antiAliasing: "msaa4", particles: "high", postProcessing: "high" };
          const mountOptions = extra => ({
            source: bytesSource(pkgBytes, pkgProject, "watchdog:" + wallpaperId),
            renderDpr,
            quality,
            onDiagnostic: (lvl, msg) => pushDiag(lvl, msg),
            onError: () => pushDiag("error", "mount onError"),
            ...extra
          });
          const mountStarted = performance.now();
          let inst = null; let retried = false;
          try { inst = await mount(base, mountOptions({})); }
          catch (mountErr) {
            const msg = String(mountErr && mountErr.message || mountErr || "");
            const isFirstFrameTimeout = /首帧超时|first frame|firstFrame/i.test(msg);
            pushDiag("error", "mount failed: " + msg.slice(0, 160));
            if (isFirstFrameTimeout) {
              try { if (mountErr && mountErr.instance && mountErr.instance.destroy) mountErr.instance.destroy(); } catch {}
              dropPending();
              const nb = document.createElement("div");
              nb.id = PENDING_BASE_ID;
              nb.setAttribute("data-wallpaper-source", wallpaperId);
              nb.style.cssText = "position:fixed!important;inset:0!important;background:#000!important;z-index:0!important;pointer-events:none!important;display:block!important;opacity:0";
              document.body.prepend(nb);
              pushDiag("info", "retrying mount with mountTimeoutMs=0 (first-frame timeout recovery)");
              try { inst = await mount(nb, mountOptions({ mountTimeoutMs: 0 })); retried = true; }
              catch (retryErr) { pushDiag("error", "mount retry failed: " + String(retryErr && retryErr.message || retryErr).slice(0, 160)); throw retryErr; }
            } else { throw mountErr; }
          }
          if (!inst) throw new Error("WebWallGL mount returned no instance");
          window.__webwallglInstance = inst;
          const mediaEl = document.createElement("div");
          mediaEl.setAttribute("data-wallpaper-source", wallpaperId);
          mediaEl.setAttribute("data-render-mode", "webgl");
          mediaEl.setAttribute("data-webgl-ready", "true");
          mediaEl.setAttribute("data-background-opacity", "1");
          mediaEl.setAttribute("data-surface-opacity", "0");
          mediaEl.setAttribute("data-blur", "0");
          mediaEl.style.cssText = "position:fixed!important;inset:0!important;z-index:0!important;pointer-events:none!important;opacity:1";
          revealBackground(document.getElementById(PENDING_BASE_ID) || base, mediaEl, oldLayers);
          if (previousInstance && previousInstance !== inst) {
            setTimeout(() => { try { previousInstance.destroy && previousInstance.destroy(); } catch {} try { previousInstance.unmount && previousInstance.unmount(); } catch {} try { previousInstance.dispose && previousInstance.dispose(); } catch {} }, 360);
          }
          document.getElementById("codex-custom-background-style")?.remove();
          const style = document.createElement("style");
          style.id = "codex-custom-background-style";
          style.textContent = [
            "html, body, #root, #root *, #root *::before, #root *::after { background: transparent !important; backdrop-filter: none !important; box-shadow: none !important; }",
            "#root { position: relative !important; z-index: 1 !important; min-height: 100vh !important; }",
            "#codex-custom-background-base, #codex-custom-background-base-pending { display: block !important; visibility: visible !important; width: 100vw !important; height: 100vh !important; }",
            "#codex-custom-background-base canvas, #codex-custom-background-base-pending canvas { display: block !important; visibility: visible !important; width: 100vw !important; height: 100vh !important; }"
          ].join("\\n");
          document.head.append(style);
          return { ok: true, renderMode: "webgl", source: wallpaperId, pkgBytes: pkgLen, mountMs: Math.round(performance.now() - mountStarted), mountRetried: retried, renderDpr, lastDiag: lastDiag(), diagCount: diagCount() };
        };
        /* While the app window is hidden/occluded Chromium freezes rAF, so the
           render loop cannot produce the first frame mount() waits for (the
           library gives up after 60s or hangs outright). Show the injected
           fallback right away and upgrade to WebGL the moment the page
           becomes visible again. */
        const oldLayers = previousLayers();
        if (document.visibilityState === "hidden" && window.__codexSceneFallback && window.__codexSceneFallback.bytes && window.__codexSceneFallback.bytes.length) {
          const deferred = renderFallback("window hidden - WebGL mount deferred until the page is visible", oldLayers);
          if (deferred && deferred.ok) {
            document.addEventListener("visibilitychange", () => {
              if (document.visibilityState !== "visible") return;
              mountWebGL(previousLayers()).then(result => { window.__codexDeferredWebGL = result && result.renderMode === "webgl" ? "webgl" : "failed"; if (result && result.lastDiag) window.__codexDeferredDiag = result.lastDiag; }).catch(err => { window.__codexDeferredWebGL = "failed"; window.__codexDeferredDiag = String(err?.message || err); });
            }, { once: true });
            setTimeout(() => { window.__codexScenePkg = null; }, 600000);
            return { ...deferred, deferredWebGL: true };
          }
          return deferred;
        }
        try {
          return await mountWebGL(oldLayers);
        } catch (err) {
          return renderFallback(err, oldLayers);
        }
      })()`,
      returnByValue: true,
      awaitPromise: true
    }, 120000);
  });
  if (result && result.renderMode === "webgl") {
    log(`scene webgl ${wallpaperId}: renderMode=webgl (vendored WebWallGL, bytesSource pkgBytes=${result.pkgBytes} mountMs=${result.mountMs} preMs=${phaseMs.pre}${result.mountRetried ? " retried=true" : ""}${result.lastDiag ? " lastDiag=" + String(result.lastDiag).slice(0, 160) : ""}${result.diagCount ? " diagCount=" + result.diagCount : ""})`);
  } else if (result) {
    log(`scene webgl ${wallpaperId}: renderMode=${result.renderMode}${result.deferredWebGL ? " deferredWebGL=true" : ""}${result.webglError ? " webglError=" + String(result.webglError).slice(0, 180) : ""}${result.fallbackError ? " fallbackError=" + result.fallbackError : ""}${result.fallbackBytes ? " fallbackBytes=" + result.fallbackBytes + " mime=" + result.fallbackMime : ""}${result.error ? " error=" + result.error : ""}${result.lastDiag ? " lastDiag=" + String(result.lastDiag).slice(0, 160) : ""}${result.diagCount ? " diagCount=" + result.diagCount : ""}`);
  }
  return result;
}
async function installBackground(current) {
  const found = await findPage();
  if (!found) throw new Error("Codex main page disappeared");
  const media = loadMedia(current.source);
  if (media.renderMode === "webgl") return await installSceneWebGL(found, current);
  const installEpoch = selectEpoch;
  const isVideo = media.type.startsWith("video/");
  const mediaBytes = media.buf ? media.buf.length : fs.statSync(media.path).size;
  const nativeRawChunk = 3 * 1024 * 1024;
  await withPage(found.target, async command => {
    await command("Runtime.evaluate", { expression: `${INGEST_HELPER}\nwindow.__codexWallpaperBytes = { bytes: new Uint8Array(${mediaBytes}), offset: 0 }; 0`, returnByValue: true });
    const chunkSource = media.buf ? base64ChunkSourceFromBuffer(media.buf, nativeRawChunk) : base64ChunkSource(media.path, nativeRawChunk);
    let nativeInjected = true;
    for (const chunk of chunkSource) {
      if (selectEpoch !== installEpoch) { log(`install aborted (superseded during native injection): ${current.source}`); nativeInjected = false; break; }
      try { await command("Runtime.evaluate", { expression: `window.__codexIngest("__codexWallpaperBytes", ${JSON.stringify(chunk)})`, returnByValue: true, awaitPromise: true }); }
      catch (error) { log(`native inject failed for ${current.source}: ${error.message}`); nativeInjected = false; break; }
    }
    if (!nativeInjected) { await command("Runtime.evaluate", { expression: "window.__codexWallpaperBytes = null; 0", returnByValue: true }); return { ok: false, renderMode: "failed", source: current.source }; }
    return await command("Runtime.evaluate", {
      expression: `(async () => {
        const loseGl = (el) => { try { const ctx = el && el.getContext ? (el.getContext("webgl2") || el.getContext("webgl")) : null; if (ctx && ctx.getExtension) { const ext = ctx.getExtension("WEBGL_lose_context"); if (ext) ext.loseContext(); } } catch {} };
        const previousLayers = () => ["codex-custom-background-base", "codex-custom-background-media"].map(id => document.getElementById(id)).filter(Boolean);
        const oldLayers = previousLayers();
        const previousInstance = window.__webwallglInstance;
        document.getElementById("codex-custom-background-base-pending")?.remove();
        const bytes = window.__codexWallpaperBytes.bytes;
        window.__codexWallpaperBytes = null;
        const objectUrl = URL.createObjectURL(new Blob([bytes], { type: ${JSON.stringify(media.type)} }));
        const base = document.createElement("div");
        base.style.cssText = "position:fixed!important;inset:0!important;background:#000!important;z-index:0!important;pointer-events:none!important;opacity:0";
        base.setAttribute("data-wallpaper-source", ${JSON.stringify(current.source)});
        const el = document.createElement(${JSON.stringify(isVideo ? "video" : "img")});
        if (${JSON.stringify(isVideo)}) { el.autoplay = true; el.loop = true; el.muted = true; el.playsInline = true; el.disablePictureInPicture = true; el.preload = "auto"; }
        el.src = objectUrl;
        el.setAttribute("data-object-url", objectUrl);
        el.setAttribute("data-wallpaper-source", ${JSON.stringify(current.source)});
        el.setAttribute("data-render-mode", ${JSON.stringify(media.renderMode)});
        el.setAttribute("data-background-opacity", "1");
        el.setAttribute("data-surface-opacity", "0");
        el.setAttribute("data-blur", "0");
        el.style.cssText = "position:fixed!important;inset:0!important;width:100vw!important;height:100vh!important;object-fit:cover!important;z-index:0!important;pointer-events:none!important;background:#000;opacity:0";
        /* Hold the new media behind the visible background (opacity 0) until it
           has something to paint, then swap and cross-fade - the page never
           goes black and never shows a half-decoded frame. */
        el.id = "codex-custom-background-media";
        base.id = "codex-custom-background-base";
        document.body.prepend(el);
        document.body.prepend(base);
        await new Promise(resolve => {
          let settled = false;
          const done = () => { if (!settled) { settled = true; resolve(); } };
          if (${JSON.stringify(isVideo)}) {
            if (el.readyState >= 2) return done();
            el.addEventListener("loadeddata", done, { once: true });
            el.addEventListener("error", done, { once: true });
            setTimeout(done, 4000);
            return;
          }
          if (el.complete && el.naturalWidth) return done();
          el.addEventListener("load", done, { once: true });
          el.addEventListener("error", done, { once: true });
          setTimeout(done, 4000);
        });
        el.style.opacity = "1";
        base.style.opacity = "1";
        for (const old of oldLayers) {
          if (!old || !old.isConnected || old === el || old === base) continue;
          const deadCanvas = old.querySelector ? old.querySelector("canvas") : null;
          old.style.transition = "opacity 260ms ease";
          old.style.opacity = "0";
          setTimeout(() => { try { if (deadCanvas) loseGl(deadCanvas); old.remove(); } catch {} }, 340);
        }
        if (previousInstance) setTimeout(() => { try { previousInstance.destroy && previousInstance.destroy(); } catch {} try { previousInstance.unmount && previousInstance.unmount(); } catch {} try { previousInstance.dispose && previousInstance.dispose(); } catch {} }, 360);
        document.getElementById("codex-custom-background-style")?.remove();
        const style = document.createElement("style");
        style.id = "codex-custom-background-style";
        style.textContent = [
          "html, body, #root, #root *, #root *::before, #root *::after { background: transparent !important; backdrop-filter: none !important; box-shadow: none !important; }",
          "#root { position: relative !important; z-index: 1 !important; min-height: 100vh !important; }",
          "#codex-custom-background-media { display: block !important; visibility: visible !important; }"
        ].join("\\n");
        document.head.append(style);
        if (${JSON.stringify(isVideo)}) el.play().catch(() => {});
        return { bytes: bytes.length, type: ${JSON.stringify(media.type)}, source: ${JSON.stringify(current.source)} };
      })()`,
      returnByValue: true,
      awaitPromise: true
    });
  });
}

let restoring = false;
let selectEpoch = 0;
/* Polling every 2s made every switch feel sluggish even after the scan cache
   landed; 800ms keeps the loop cheap and /select now wakes it instantly. */
let ticker = null;
function wakeTicker() { if (ticker) ticker(); }
function nextTick() {
  return new Promise(resolve => {
    const timer = setTimeout(() => { ticker = null; resolve(); }, 800);
    ticker = () => { clearTimeout(timer); ticker = null; resolve(); };
  });
}
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
    if (state.page && state.deferredUpgrade) { lastDeferredUpgrade = state.deferredUpgrade; log(`deferred webgl upgrade ${current.source}: result=${state.deferredUpgrade.result}${state.deferredUpgrade.lastDiag ? " lastDiag=" + String(state.deferredUpgrade.lastDiag).slice(0, 160) : ""}`); }
    if (!current.source) { await wait(5000); continue; }
    const needsBackground = state.page && (!state.background || !state.base || state.source !== current.source);
    const needsControls = state.page && (!state.readability || !state.controls);
    const needsPicker = state.page && !state.picker;
    if (!restoring && (needsBackground || (needsControls && !controlsRunning) || (needsPicker && !pickerRunning))) {
      restoring = true;
      const installSafety = setTimeout(() => { if (restoring) { log(`install forced-reset (over 180s): ${current.source}`); restoring = false; } }, 180000);
      try {
        if (needsBackground) { const bgResult = await installBackground(current); if (bgResult && bgResult.renderMode === "aborted") log(`install aborted (superseded): ${current.source}`); else log(`background installed: ${current.source}`); }
        if (needsBackground || needsControls) launchControls();
        if (needsPicker) launchPicker();
      } catch (error) { log(`restore error: ${error.message}`); mediaCache.delete(current.source); }
      finally { clearTimeout(installSafety); restoring = false; }
    }
  } catch (error) { log(`error: ${error.message}`); }
  await nextTick();
}
