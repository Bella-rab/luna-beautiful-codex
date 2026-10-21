import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { listWallpapers, resolveWallpaperMedia, invalidateWallpaperCache, uploadsDir, WEB_TYPES } from "./wallpaper-library.mjs";
import { APPEARANCE_BUILD, hydrateExtImages, normalizeAppearance, withFactoryPresets } from "./appearance.mjs";
import { TRANSITION_MS, filterWallpapers, libraryPayload, normalizeLibrary, tagOf } from "./library-state.mjs";
import { buildWebDocument, webPreludeSource, webPropertyPayload } from "./web-wallpaper.mjs";

const root = import.meta.dirname;
const stateRoot = path.join(process.env.APPDATA || os.homedir(), "Codex", "luna-beautiful-codex");
const selectionPath = path.join(stateRoot, "wallpaper-selection.json");
const prefsPath = path.join(stateRoot, "prefs.json");
const controlsScript = path.join(root, "inject-background-controls.mjs");
const pickerScript = path.join(root, "inject-wallpaper-picker.mjs");
const appearanceScript = path.join(root, "inject-appearance.mjs");
const logPath = path.join(root, "codex-wallpaper-watchdog.log");
const lockPort = 43310;
/* Must match inject-background-controls.mjs; a mismatch makes the watchdog
   re-inject the panel once so a code update reaches the live page. */
const CONTROLS_BUILD = "0.3.2+panel-fixes.5";
const devtoolsPorts = [9229, 9230, 9231, 9232, 9233, 9234, 9235, 9236, 9237, 9238, 9239];
const chunkSize = 512 * 1024;

/* A single hidden file input lives in the page so the renderer can read
   wallpaper files straight off disk. DevTools hands the input real file paths,
   Chromium exposes them to the page as file-backed Blobs, and WebWallGL takes
   that File directly - which removes the base64-over-DevTools transport that
   made large packages slow (126MB used to need ~273 chunked round trips) while
   leaving CSP untouched: the page still does no fetching of its own. */
const FILE_INPUT_ID = "__luna_file";
/* Prewarm gets its own hidden input. With a single shared input the scene the
   prewarm handed to WebWallGL could be replaced under it by the *next* priming -
   the library resolves the File lazily through fileSource(), so the mount parsed
   whatever the input held at that moment and died with a corrupt package header
   ("魔数长度异常: 536870912"), which then turned the first click into a full
   re-install. Nothing outside the prewarm path touches this element. */
const PREWARM_FILE_INPUT_ID = "__luna_prewarm_file";
const VENDORED_WEBWALLGL_VERSION = "2.1.0";
let libCapabilitiesLogged = false;
const mediaCache = new Map();
let memorySelection = null;
let lastDeferredUpgrade = null;
const REQUESTED_QUALITY = { antiAliasing: "msaa4", particles: "high", postProcessing: "high" };
const QUALITY_SCENE_FPS = 60;
const QUALITY_RESTORE_RATIO = 0.85;
const QUALITY_RESTORE_HOLD_MS = 5000;
const QUALITY_RESTORE_COOLDOWN_MS = 30000;
const QUALITY_FPS_WINDOW_MS = 10000;
const QUALITY_FPS_MIN_SAMPLES = 5;
const QUALITY_HOLD_MIN_MS = 60000;
const QUALITY_RESTORE_MAX_COOLDOWN_MS = 300000;
/* Once a scene is downgraded again soon after a re-apply it is clear the tier
   does not hold there; re-applying it every cycle is pure churn (40+ cycles were
   observed on one scene), so the scene is settled for the rest of the session and
   the per-cycle logging is muted after the first sighting. */
const QUALITY_SETTLE_WINDOW_MS = 10000;
const QUALITY_DEGRADE_LOG_EVERY = 10;
const CONTEXT_REMOUNT_GRACE_MS = 6000;
const CONTEXT_REMOUNT_COOLDOWN_MS = 20000;
const CONTEXT_REMOUNT_MAX = 3;
/* Hover prewarm: a picker row has to be hovered before it can be clicked, so the
   scene is mounted into the hidden pending layer while the user aims and the click
   only pays the cross-fade. The staged mount is not free - measured on this machine
   it blocks the visible wallpaper for ~270ms at 1.6MB, ~300ms at 9.1MB and ~500ms
   at 30MB (mount + the library's background bake) - so only scenes at or below this
   budget prewarm. A heavier package would fight the visible wallpaper for the GPU
   while the user is still browsing, and it also made a click on a *different* row
   contend with the in-flight 30MB mount, so the click path already lands under 1s
   for those without prewarming. */
const PREWARM_MAX_BYTES = 16 * 1024 * 1024;
const PREWARM_TICK_MS = 120;
/* A prewarm that fails is not retried for a while: the failure is usually the
   library refusing the scene, and retrying it on every tick only re-paid the
   mount cost while the user was still browsing. */
const PREWARM_FAIL_COOLDOWN_MS = 10000;
/* Bound on how long a click may wait for an in-flight prewarm. Past this the
   click installs normally, so a stuck prewarm can never make the click slower
   than having no prewarm at all. */
const PREWARM_CLICK_WAIT_MS = 600;
/* How long a prewarm is expected to need. Older attempts are dropped on click
   instead of waited for. */
const PREWARM_READY_WINDOW_MS = 900;
const IDLE_TICK_MS = 800;
/* After the picker closes (or right after a pick) keep a short fast window: a pick
   made from a hotkey/launcher is detected within ~200ms instead of waiting for the
   idle 800ms tick, while a genuinely idle page still polls slowly. */
const RECENT_TICK_MS = 200;
const RECENT_WINDOW_MS = 10000;
/* Phase 2 rotation. A prewarmed switch is preferred but bounded: past this the
   rotation installs directly, so a slow scene can never stall the timer. */
const ROTATION_PREWARM_WAIT_MS = 2500;
const ROTATION_FAIL_TTL_MS = 10 * 60 * 1000;
const ROTATION_RETRY_MS = 1500;
let lastContextRemount = 0;
let contextRemounts = 0;
let contextLostSeenAt = 0;
const qualityFpsWindow = [];
let lastQualityRestoreAt = 0;
let qualityBackoff = QUALITY_RESTORE_COOLDOWN_MS;
let qualityBackoffMountSeq = -1;
let lastQuality = null;
const qualitySceneStats = new Map();

/* The watchdog appends to a single log file for the life of the install, so cap it:
   past LOG_MAX_BYTES the live file is rotated to ".1" (replacing the previous
   archive) and the byte counter resets. */
const LOG_MAX_BYTES = 5 * 1024 * 1024;
let logBytes = 0;
try { logBytes = fs.statSync(logPath).size; } catch { logBytes = 0; }

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  try {
    if (logBytes > LOG_MAX_BYTES) {
      try { fs.renameSync(logPath, logPath + ".1"); } catch {}
      logBytes = 0;
    }
    fs.appendFileSync(logPath, line);
    logBytes += Buffer.byteLength(line);
  } catch {}
}

function wait(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function readJson(filePath, fallback) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); } catch { return fallback; }
}

/* Surfaces the installed plugin build in /status. Lives beside the log helpers so
   the manifest is read once at startup instead of on every request. */
const pluginDir = path.dirname(root);
const pluginVersion = readJson(path.join(pluginDir, ".codex-plugin", "plugin.json"), {}).version || null;

/* `disabled` is the reset state: the user explicitly removed the background, so
   the watchdog must stop restoring the remembered wallpaper. It lives next to
   source/title instead of deleting the selection, so re-enabling from the picker
   or MCP keeps the last wallpaper. Every ordinary selection clears it. */
function writeSelection(source, title, extra = {}) {
  memorySelection = { source: String(source || ""), title: String(title || ""), disabled: extra.disabled === true };
  try { fs.mkdirSync(stateRoot, { recursive: true }); fs.writeFileSync(selectionPath, JSON.stringify(memorySelection, null, 2)); } catch {}
  return memorySelection;
}

function selection() {
  if (memorySelection && (memorySelection.source || memorySelection.disabled)) return memorySelection;
  const value = readJson(selectionPath, null);
  if (value && (value.source || value.disabled === true)) {
    return { source: String(value.source || ""), title: String(value.title || ""), disabled: value.disabled === true };
  }
  const first = listWallpapers()[0];
  const next = first ? writeSelection(first.id, first.title) : { source: "", title: "", disabled: false };
  return next;
}

function prefs() {
  /* prefs() sits on the 800ms hot path, so the stored appearance object is handed back
     untouched - writeAppearance() already clamped it before it was written. Anything that
     needs the full shape reads appearanceState(). */
  return { whiteText: true, appearance: null, library: null, backgroundOpacity: null, readability: null, ...readJson(prefsPath, null) };
}

/* The readability panel's two controls. They are persisted so a wallpaper switch
   (which tears the panel down and rebuilds it) does not silently reset the user's
   text-shadow strength or surface mode. */
const READABILITY_MODES = ["halo", "soft", "bubble"];
function readabilityState() {
  const raw = prefs().readability;
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const percent = Number(source.percent);
  return {
    percent: Number.isFinite(percent) ? Math.min(100, Math.max(0, Math.round(percent))) : 45,
    mode: READABILITY_MODES.includes(source.mode) ? source.mode : "soft"
  };
}

/* Background opacity is a watchdog-owned preference, separate from the
   readability slider: tools and the picker can dim the wallpaper without
   touching the readability (text shadow) strength. null means "no override",
   which leaves readability's own value in charge. */
function backgroundOpacityValue() {
  const raw = prefs().backgroundOpacity;
  if (raw === null || raw === undefined) return null;
  return backgroundOpacityValueFor(raw);
}

/* Clamp one caller-supplied value (number or numeric string) to the supported
   range; anything unusable returns null so callers can report a 400. */
function backgroundOpacityValueFor(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.min(100, Math.max(5, Math.round(number)));
}

async function applyBackgroundOpacity(percent) {
  return await pageCommand(`(() => {
    const percent = ${JSON.stringify(percent)};
    const media = document.getElementById("codex-custom-background-media");
    if (!media) return { ok: false, reason: "no background" };
    /* Keep the readability panel in sync: it reports its own slider value on the
       next interaction, so a stale slider would push the old dim back. */
    const syncPanel = () => {
      const panel = document.getElementById("codex-background-controls");
      const root = panel && panel.shadowRoot;
      if (!root) return;
      const input = root.querySelector('input[type="range"]');
      const output = root.querySelector("output");
      if (percent === null) return;
      if (input && input.value !== String(percent)) input.value = String(percent);
      if (output) output.textContent = percent + "%";
    };
    let style = document.getElementById("codex-background-opacity-style");
    if (percent === null) {
      if (style) style.remove();
      syncPanel();
      return { ok: true, cleared: true };
    }
    if (!style) { style = document.createElement("style"); style.id = "codex-background-opacity-style"; document.head.append(style); }
    style.textContent = "#codex-custom-background-media,#codex-custom-background-base,#codex-custom-background-base canvas{opacity:" + (percent / 100).toFixed(2) + " !important}";
    media.setAttribute("data-background-opacity", String(percent / 100));
    syncPanel();
    return { ok: true, percent };
  })()`);
}

function writePrefs(patch) {
  const next = { ...prefs(), ...patch };
  fs.mkdirSync(stateRoot, { recursive: true });
  fs.writeFileSync(prefsPath, JSON.stringify(next, null, 2));
  return next;
}

/* Phase 1 appearance state. The factory presets are always part of the list and every
   field is clamped, so a hand-edited prefs.json can never push junk into a stylesheet. */
function appearanceState() {
  /* Hydration inlines uploads/avatar_* and uploads/mascot_* as data URLs for the
     page; the stored prefs only ever keep the bare file name. */
  return hydrateExtImages(withFactoryPresets(prefs().appearance));
}

function writeAppearance(raw) {
  const appearance = withFactoryPresets(normalizeAppearance(raw));
  /* Uploads are files, never prefs payload: drop any inlined data URL before the
     JSON lands on disk, otherwise a 3MB image would be rewritten every save. */
  if (appearance.ext && appearance.ext.avatar) appearance.ext.avatar.image = "";
  if (appearance.ext && appearance.ext.mascot) appearance.ext.mascot.image = "";
  writePrefs({ appearance });
  return appearance;
}

/* Phase 2 library state: filters, tags, hidden ids, rotation and transitions.
   The picker polls /status every tick, so the stored object is re-normalized on
   read; normalizeLibrary is pure and cheap (a handful of keys plus the id lists). */
function libraryState() {
  return normalizeLibrary(prefs().library);
}

function writeLibrary(raw) {
  const library = normalizeLibrary(raw);
  writePrefs({ library });
  return library;
}

/* The page-side reveal animates with these; the speed name is resolved to
   milliseconds here so the page never has to know the table. */
function transitionFor() {
  const transition = libraryState().transition;
  return { mode: transition.mode, dir: transition.dir, speedMs: TRANSITION_MS[transition.speed] };
}

/* Injected into every page expression that reveals a new wallpaper layer. */
const SWITCH_SOURCE = "/* Phase 2 switch transitions. New layers are staged at opacity 0 behind the\n   visible wallpaper and only start moving once the caller has the fresh mount\n   ready, so the page never shows a frame without a background. Only CSS\n   transition/transform/clip-path are used - no per-frame JS. */\nwindow.__lunaSwitchTransition = (baseEl, mediaEl, oldLayers, cfg, cleanup) => {\n  cfg = cfg || {};\n  let mode = String(cfg.mode || 'fade');\n  const dir = String(cfg.dir || 'left');\n  const speed = Math.max(80, Math.min(1200, Number(cfg.speedMs) || 360));\n  let reduced = false;\n  try { reduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (e) {}\n  if (reduced || document.visibilityState === 'hidden') mode = 'cut';\n  if (['cut','fade','zoom','push','wipe','iris','bars'].indexOf(mode) < 0) mode = 'fade';\n  const news = [baseEl, mediaEl].filter(Boolean);\n  const olds = (oldLayers || []).filter(el => el && el.isConnected);\n  const ease = 'cubic-bezier(.22,.61,.36,1)';\n  const finish = () => { try { if (cleanup) cleanup(); } catch (e) {} };\n  const settle = () => {\n    for (const el of news) {\n      el.style.transition = '';\n      el.style.transform = '';\n      el.style.clipPath = '';\n      el.style.opacity = '1';\n      try { el.style.setProperty('z-index', '0', 'important'); el.style.setProperty('background', '#000', 'important'); } catch (e) {}\n    }\n  };\n  if (mode === 'cut') {\n    for (const el of news) el.style.opacity = '1';\n    for (const el of olds) el.style.opacity = '0';\n    settle(); finish(); return mode;\n  }\n  for (const el of news) { try { el.style.setProperty('z-index', '2', 'important'); el.style.setProperty('background', 'transparent', 'important'); } catch (e) {} }\n  for (const el of olds) { try { el.style.setProperty('z-index', '0', 'important'); } catch (e) {} }\n  const raf = fn => { let fired = false; const go = () => { if (fired) return; fired = true; fn(); }; try { requestAnimationFrame(() => requestAnimationFrame(go)); } catch (e) {} setTimeout(go, 80); };\n  const end = () => { settle(); finish(); };\n  if (mode === 'fade') {\n    for (const el of news) { el.style.transition = 'opacity ' + speed + 'ms ease'; el.style.opacity = '0'; }\n    for (const el of olds) { el.style.transition = 'opacity ' + speed + 'ms ease'; el.style.opacity = '1'; }\n    raf(() => { for (const el of news) el.style.opacity = '1'; });\n    setTimeout(end, speed + 60); return mode;\n  }\n  if (mode === 'zoom') {\n    for (const el of news) { el.style.transformOrigin = '50% 50%'; el.style.transition = 'opacity ' + speed + 'ms ease, transform ' + speed + 'ms ' + ease; el.style.transform = 'scale(1.06)'; el.style.opacity = '0'; }\n    for (const el of olds) { el.style.transformOrigin = '50% 50%'; el.style.transition = 'transform ' + speed + 'ms ' + ease; }\n    raf(() => { for (const el of news) { el.style.opacity = '1'; el.style.transform = 'scale(1)'; } for (const el of olds) el.style.transform = 'scale(1.04)'; });\n    setTimeout(end, speed + 60); return mode;\n  }\n  if (mode === 'push') {\n    const axis = (dir === 'up' || dir === 'down') ? 'Y' : 'X';\n    const sign = (dir === 'right' || dir === 'down') ? 1 : -1;\n    const from = axis === 'X' ? 'translateX(' + (sign * 100) + '%)' : 'translateY(' + (sign * 100) + '%)';\n    const out = axis === 'X' ? 'translateX(' + (-sign * 100) + '%)' : 'translateY(' + (-sign * 100) + '%)';\n    for (const el of news) { el.style.transition = 'transform ' + speed + 'ms ' + ease; el.style.transform = from; el.style.opacity = '1'; }\n    for (const el of olds) { el.style.transition = 'transform ' + speed + 'ms ' + ease; }\n    raf(() => { for (const el of news) el.style.transform = 'translate(0,0)'; for (const el of olds) el.style.transform = out; });\n    setTimeout(end, speed + 60); return mode;\n  }\n  if (mode === 'wipe') {\n    const closed = { left: 'inset(0 100% 0 0)', right: 'inset(0 0 0 100%)', up: 'inset(100% 0 0 0)', down: 'inset(0 0 100% 0)' }[dir] || 'inset(0 100% 0 0)';\n    for (const el of news) { el.style.transition = 'clip-path ' + speed + 'ms ' + ease; el.style.clipPath = closed; el.style.opacity = '1'; }\n    raf(() => { for (const el of news) el.style.clipPath = 'inset(0 0 0 0)'; });\n    setTimeout(end, speed + 60); return mode;\n  }\n  if (mode === 'iris') {\n    for (const el of news) { el.style.transition = 'clip-path ' + speed + 'ms ' + ease; el.style.clipPath = 'circle(0% at 50% 50%)'; el.style.opacity = '1'; }\n    raf(() => { for (const el of news) el.style.clipPath = 'circle(75% at 50% 50%)'; });\n    setTimeout(end, speed + 60); return mode;\n  }\n  if (mode === 'bars') {\n    const n = 6;\n    const build = open => { const pts = []; const step = 100 / n; for (let i = 0; i < n; i += 1) { const a = i * step; const b = a + (open ? step : 0); pts.push(a + '% 0%', b + '% 0%', b + '% 100%', a + '% 100%'); } return 'polygon(' + pts.join(',') + ')'; };\n    for (const el of news) { el.style.transition = 'clip-path ' + speed + 'ms ' + ease; el.style.clipPath = build(false); el.style.opacity = '1'; }\n    raf(() => { for (const el of news) el.style.clipPath = build(true); });\n    setTimeout(end, speed + 60); return mode;\n  }\n  return mode;\n};";

/* Rotation candidates honour exactly the filters the picker shows, and skip the
   wallpaper that is already playing. */
function rotationCandidates(currentId, library) {
  const visible = filterWallpapers(listWallpapers(), library, { showHidden: false });
  return visible.filter(item => {
    if (item.id === currentId) return false;
    const failedAt = rotationFailed.get(item.id);
    return !failedAt || Date.now() - failedAt > ROTATION_FAIL_TTL_MS;
  });
}

/* Surfaced through /status and mirrored into the picker so the panel can show the
   countdown without keeping its own timer. */
function rotationState() {
  const library = libraryState();
  const candidates = library.rotation.enabled ? rotationCandidates(selection().source, library) : [];
  return {
    enabled: library.rotation.enabled,
    intervalSec: library.rotation.intervalSec,
    order: library.rotation.order,
    candidates: candidates.length,
    nextInSec: library.rotation.enabled && rotationNextAt ? Math.max(0, Math.round((rotationNextAt - Date.now()) / 1000)) : null,
    lastSwitchAt: lastRotationSwitchAt || null,
    skipped: [...rotationFailed.keys()]
  };
}

/* The panel POSTs its state here. The body is only a few KB, but it is still bounded so
   a stray request cannot buffer forever. */
function readBody(request, limitBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on("data", chunk => {
      size += chunk.length;
      if (size > limitBytes) { reject(new Error("body too large")); request.destroy(); return; }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

/* Wallpaper metadata only. The bytes are no longer read up front: the page reads
   them from the File the DOM command channel handed it, and the byte-injection
   fallback reads the file off disk only when it is actually needed. */
function mediaMeta(source) {
  if (!mediaCache.has(source)) mediaCache.set(source, resolveWallpaperMedia(source));
  return mediaCache.get(source);
}

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

/* External writers (tools, scripts, the self-test) change prefs over HTTP; the
   page only learns about a change through the mirror pass in the main loop. This
   holder is declared before the HTTP server starts so a request can never hit a
   temporal-dead-zone reference. */
const pendingMirrors = { appearance: false, library: false };

const RESET_BACKGROUND_EXPRESSION = `(() => {
  const loseGl = el => { try { const ctx = el && el.getContext ? (el.getContext("webgl2") || el.getContext("webgl")) : null; const ext = ctx && ctx.getExtension ? ctx.getExtension("WEBGL_lose_context") : null; if (ext) ext.loseContext(); } catch (e) {} };
  const prewarm = window.__codexPrewarm;
  if (prewarm && prewarm.instance) { try { prewarm.instance.destroy && prewarm.instance.destroy(); } catch (e) {} try { prewarm.instance.dispose && prewarm.instance.dispose(); } catch (e) {} }
  window.__codexPrewarm = null;
  for (const el of document.querySelectorAll("#codex-custom-background-base, #codex-custom-background-base-pending, #codex-custom-background-base-pending-hover")) {
    const canvas = el.querySelector ? el.querySelector("canvas") : null;
    if (canvas) loseGl(canvas);
    el.remove();
  }
  for (const el of document.querySelectorAll("#codex-custom-background-media")) {
    const url = el.getAttribute && el.getAttribute("data-object-url");
    if (url) { try { URL.revokeObjectURL(url); } catch (e) {} }
    if (el.tagName === "VIDEO") { try { el.pause(); } catch (e) {} }
    el.remove();
  }
  const instance = window.__webwallglInstance;
  if (instance) { try { instance.destroy && instance.destroy(); } catch (e) {} try { instance.unmount && instance.unmount(); } catch (e) {} try { instance.dispose && instance.dispose(); } catch (e) {} }
  window.__webwallglInstance = null;
  document.getElementById("codex-custom-background-style")?.remove();
  document.getElementById("codex-custom-background-tune-style")?.remove();
  document.getElementById("codex-background-opacity-style")?.remove();
  document.getElementById("codex-wallpaper-shade")?.remove();
  /* The dim/readability panel has nothing to control once the background is
     gone; it is rebuilt by launchControls when a wallpaper returns. */
  for (const id of ["codex-background-controls", "codex-background-readability", "codex-background-readability-style"]) { try { document.getElementById(id)?.remove(); } catch (e) {} }
  window.__codexWallpaperBytes = null;
  return { ok: true };
})()`;

async function acquireServer() {
  return await new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      cors(res);
      if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
      const url = new URL(req.url, "http://127.0.0.1");
      try {
        if (url.pathname === "/health") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, pid: process.pid }));
        } else if (url.pathname === "/wallpapers") {
          res.writeHead(200, { "content-type": "application/json" });
          if (url.searchParams.get("refresh")) invalidateWallpaperCache();
          const library = libraryState();
          const hidden = new Set(library.hidden);
          res.end(JSON.stringify(listWallpapers().map(item => ({
            id: item.id, title: item.title, custom: !!item.custom, kind: item.kind || "image",
            tag: tagOf(library, item.id), hidden: hidden.has(item.id),
            quality: item.renderMode === "native" ? "原生高清" : item.renderMode === "webgl" ? "WebGL渲染" : item.renderMode === "web" ? "网页壁纸" : "静态预览", renderMode: item.renderMode
          }))));
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
        } else if (url.pathname === "/reset" || url.pathname === "/disable") {
          /* /reset removes every background layer and stops the watchdog from
             restoring the remembered wallpaper until a new selection arrives.
             /disable only stops the restore, so the MCP server can inject a
             custom file/URL background without the next tick tearing it down. */
          const before = selection();
          writeSelection(before.source, before.title, { disabled: true });
          mediaCache.clear();
          prewarm = null;
          prewarmEpoch += 1;
          rotationPending = null;
          let pageResult = null;
          if (url.pathname === "/reset") {
            try { pageResult = await pageCommand(RESET_BACKGROUND_EXPRESSION, 15000); }
            catch (error) { pageResult = { ok: false, error: String(error.message || error) }; }
          }
          log(url.pathname === "/reset" ? `background reset (selection disabled${pageResult && pageResult.ok === false ? ", page error: " + pageResult.error : ""})` : "background restore paused (selection disabled)");
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, reset: url.pathname === "/reset", disabled: true, source: before.source, page: pageResult }));
        } else if (url.pathname === "/library") {
          if (req.method === "POST") {
            let parsed = null;
            try { parsed = JSON.parse((await readBody(req)) || "{}"); } catch { parsed = null; }
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
              res.writeHead(400, { "content-type": "application/json" });
              res.end(JSON.stringify({ ok: false, error: "expected a JSON object body" }));
            } else {
              const library = writeLibrary(parsed.library === undefined ? parsed : parsed.library);
              /* external writers (tests, scripts) must reach the open picker too */
              pendingMirrors.library = true;
              log("library state written via http (hidden=" + library.hidden.length + ", rotation=" + library.rotation.enabled + ")");
              res.writeHead(200, { "content-type": "application/json" });
              res.end(JSON.stringify({ ok: true, library }));
            }
          } else {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify(libraryPayload(libraryState(), listWallpapers(), { rotation: rotationState() })));
          }
        } else if (url.pathname === "/opacity") {
          /* Background dimming exposed to tools. ?value=clear removes the
             override; 5..100 sets it. Applied immediately and remembered, so a
             wallpaper switch re-applies it after the layer is rebuilt. */
          const raw = url.searchParams.get("value");
          const clear = raw === null || raw === "clear" || raw === "";
          const percent = clear ? null : backgroundOpacityValueFor(raw);
          if (!clear && percent === null) {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "value must be 5..100" }));
          } else {
            writePrefs({ backgroundOpacity: percent });
            let applied = null;
            try { applied = await applyBackgroundOpacity(percent); } catch (error) { applied = { ok: false, error: String(error.message || error) }; }
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true, backgroundOpacity: percent, applied }));
          }
        } else if (url.pathname === "/white-text") {
          const enabled = url.searchParams.get("enabled") !== "false";
          const next = writePrefs({ whiteText: enabled });
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, whiteText: next.whiteText }));
        } else if (url.pathname === "/prefs") {
          if (req.method === "POST") {
            let parsed = null;
            try { parsed = JSON.parse((await readBody(req)) || "{}"); } catch { parsed = null; }
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
              res.writeHead(400, { "content-type": "application/json" });
              res.end(JSON.stringify({ ok: false, error: "expected a JSON object body" }));
            } else {
              /* Three body shapes are accepted:
                   1. { appearance: {...}, ...otherPrefs } - appearance replaced, other keys merged
                   2. a bare appearance object (has glass/fonts/filters/ext/...)
                   3. plain prefs only ({ whiteText | readability | backgroundOpacity })
                 Shape 3 used to fall into writeAppearance() and silently reset the
                 whole appearance block to factory defaults - a single dimming
                 change wiped custom glass, fonts and filters. */
              const appearanceShaped = value => value && typeof value === "object" && !Array.isArray(value)
                && ["glass", "fonts", "filters", "ext", "presets", "activePreset", "version"].some(key => key in value);
              const hasAppearance = parsed.appearance !== undefined || appearanceShaped(parsed);
              let appearance = null;
              if (hasAppearance) {
                appearance = writeAppearance(parsed.appearance !== undefined ? parsed.appearance : parsed);
                const rest = { ...parsed };
                delete rest.appearance;
                if (appearanceShaped(parsed) && parsed.appearance === undefined) {
                  for (const key of ["glass", "fonts", "filters", "ext", "presets", "activePreset", "version"]) delete rest[key];
                }
                if (Object.keys(rest).length) writePrefs(rest);
                pendingMirrors.appearance = true;
                log("appearance prefs written via http (preset=" + appearance.activePreset + ")");
              } else {
                writePrefs(parsed);
                /* A dim-only or readability-only write still has to reach the
                   open panel, otherwise the page keeps showing the old values. */
                if (parsed.backgroundOpacity !== undefined || parsed.readability !== undefined) pendingMirrors.appearance = true;
                log("prefs written via http (" + Object.keys(parsed).join(",") + ")");
              }
              res.writeHead(200, { "content-type": "application/json" });
              res.end(JSON.stringify({ ok: true, appearance: appearance || appearanceState(), prefs: prefs() }));
            }
          } else {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ...prefs(), appearance: appearanceState() }));
          }
        } else if (url.pathname === "/status") {
          const payload = { selection: selection(), prefs: prefs(), appearance: { ...appearanceState(), lastError: appearanceLastError }, library: libraryState(), rotation: rotationState(), glassEconomy, pid: process.pid, deferredUpgrade: lastDeferredUpgrade, quality: lastQuality, lastQualityEvent: lastQuality, qualitySettledForScene: [...qualitySceneStats].filter(([, v]) => v.settled).map(([id]) => id), contextRemounts, version: pluginVersion, pluginDir };
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(payload));
        } else if (url.pathname.startsWith("/web/")) {
          /* Web wallpapers' relative assets. The page itself cannot fetch this
             origin (CSP), so the srcdoc builder inlines them; the route stays
             available for diagnostics and for hosts whose CSP allows frames. */
          const parts = url.pathname.split("/").filter(Boolean);
          const wid = parts[1];
          const ww = listWallpapers().find(item => item.id === wid);
          if (ww && ww.webDir && ww.webEntry) {
            let rel = parts.slice(2).join("/");
            try { rel = decodeURIComponent(rel); } catch { rel = ""; }
            if (!rel) rel = path.basename(ww.webEntry);
            const webRoot = path.resolve(ww.webDir);
            const safe = path.resolve(webRoot, rel);
            /* Same separator-aware containment check as /scene/: a plain
               prefix test would accept sibling folders that merely share the
               prefix (e.g. ../../<id>-evil). */
            if ((safe === webRoot || safe.startsWith(webRoot + path.sep)) && !safe.includes("\0") && fs.existsSync(safe) && fs.statSync(safe).isFile()) {
              const ext = path.extname(safe).toLowerCase();
              const mime = WEB_TYPES.get(ext) || "application/octet-stream";
              res.writeHead(200, { "content-type": mime, "cache-control": "no-store" });
              fs.createReadStream(safe).pipe(res);
            } else { res.writeHead(404, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: false, error: "web resource not found" })); }
          } else { res.writeHead(404, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: false, error: "web wallpaper not found" })); }
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
            const sceneRoot = path.resolve(sw.sceneDir);
            const safe = path.resolve(sceneRoot, rel || "scene.pkg");
            /* Compare against the root plus a separator: a plain prefix test also
               accepts sibling directories whose name merely starts with the scene
               dir, so "../../431960-evil/x" would have escaped the root. */
            if ((safe === sceneRoot || safe.startsWith(sceneRoot + path.sep)) && fs.existsSync(safe) && fs.statSync(safe).isFile()) {
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
    /* Runtime.evaluate answers with {result:{value}}; DOM domain commands answer
       with a plain object (e.g. {nodeId}). Return whichever is present so the CDP
       file channel can be driven through this same helper. */
    else waiter.resolve(message.result && message.result.result ? message.result.result.value : message.result);
  };
  socket.onclose = () => { for (const waiter of pending.values()) { try { waiter.reject(new Error("DevTools socket closed")); } catch {} } pending.clear(); };
  function sendCommand(method, params = {}, timeoutMs = 30000) {
    const id = nextId++;
    socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
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
  /* Raw variant: resolves with the whole CDP result so callers can inspect
     exceptionDetails instead of turning a failed script into a thrown error. */
  async function commandRaw(method, params = {}, timeoutMs = 30000) {
    return await sendCommand(method, params, timeoutMs);
  }
  async function command(method, params = {}, timeoutMs = 30000) {
    const message = await sendCommand(method, params, timeoutMs);
    if (message && message.exceptionDetails) throw new Error(message.exceptionDetails.exception?.description || message.exceptionDetails.text);
    return message && message.result ? message.result.value : message;
  }
  try { return await callback(command, commandRaw); } finally { socket.close(); }
}

/* sandbox="allow-scripts" without allow-same-origin gives the frame an opaque
   origin, and Chromium runs it out of process: its execution context never
   appears on the page target and Page.getFrameTree does not list it. Find the
   iframe target whose window.name carries our per-mount token instead. */
async function findWebFrameTarget(port, token, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, { cache: "no-store" });
      if (response.ok) {
        const targets = await response.json();
        for (const target of targets.filter(item => item.type === "iframe")) {
          try {
            const name = await withPage(target, command => command("Runtime.evaluate", { expression: "window.name", returnByValue: true }, 4000));
            if (name === token) return target;
          } catch {}
        }
      }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 120));
  }
  return null;
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
      controlsBuild: (() => {
        const node = document.getElementById("codex-background-controls");
        return (node && node.dataset && node.dataset.controlsBuild) || "";
      })(),
      appearance: !!document.getElementById("codex-appearance-panel"),
      /* The panel node survives a code update, so the injected runtime carries its own
         build id; a mismatch forces one re-injection instead of leaving the old page half
         running against the new Node half. */
      appearanceBuild: (() => {
        try { const api = window.__lunaAppearance; return (api && api.status && api.status().build) || ""; } catch { return ""; }
      })(),
      /* The 外观 panel cannot fetch anything (CSP), so it leaves its saved state in a
         dataset attribute; read-and-clear it here and persist it in the loop. */
      appearanceCommand: (() => {
        const host = document.getElementById("codex-appearance-panel");
        const command = (host && host.dataset.prefsCommand) || "";
        if (host) host.dataset.prefsCommand = "";
        return command;
      })(),
      /* Bumped by the panel whenever it opens and wants the saved state mirrored back. */
      appearanceRefresh: (() => {
        const host = document.getElementById("codex-appearance-panel");
        return (host && host.dataset.prefsRequest) || "";
      })(),
      picker: !!document.getElementById("codex-wallpaper-picker"),
      /* Phase 2: the picker has no fetch (CSP), so its library edits, the mirror
         request and the upload hand-off all ride on dataset attributes. */
      libraryCommand: (() => {
        const picker = document.getElementById("codex-wallpaper-picker");
        const value = (picker && picker.dataset.libraryCommand) || "";
        if (picker) picker.dataset.libraryCommand = "";
        return value;
      })(),
      libraryRequest: (() => {
        const picker = document.getElementById("codex-wallpaper-picker");
        return (picker && picker.dataset.libraryRequest) || "";
      })(),
      uploadReady: (() => {
        const picker = document.getElementById("codex-wallpaper-picker");
        const value = (picker && picker.dataset.uploadReady) || "";
        if (picker) picker.dataset.uploadReady = "";
        return value;
      })(),
      uploadDelete: (() => {
        const picker = document.getElementById("codex-wallpaper-picker");
        const value = (picker && picker.dataset.uploadDelete) || "";
        if (picker) picker.dataset.uploadDelete = "";
        return value;
      })(),
      /* Phase 4: wallpaper property edits. The picker leaves {id, props} here;
         the loop persists it and pushes the values into the live instance. */
      propsCommand: (() => {
        const picker = document.getElementById("codex-wallpaper-picker");
        const value = (picker && picker.dataset.propsCommand) || "";
        if (picker) picker.dataset.propsCommand = "";
        return value;
      })(),
      /* Phase 3: avatar/mascot image hand-off. The panel parks the File on
         window.__lunaUpload and leaves {kind,name,size} (or {kind,clear}) here. */
      imageReady: (() => {
        const host = document.getElementById("codex-appearance-panel");
        const value = (host && host.dataset.imageCommand) || "";
        if (host) host.dataset.imageCommand = "";
        return value;
      })(),
      whiteText: !!document.getElementById("codex-force-white-style"),
      deferredUpgrade: (() => { const v = window.__codexDeferredWebGL || null; if (v) { const d = window.__codexDeferredDiag || ""; window.__codexDeferredWebGL = null; window.__codexDeferredDiag = null; return { result: v, lastDiag: d }; } return null; })(),
      contextLost: window.__codexContextLost || null,
      contextEvents: (() => { const queue = window.__codexContextEvents || []; window.__codexContextEvents = []; return queue.slice(-20); })(),
      quality: window.__webwallglInstance && typeof window.__webwallglInstance.getQuality === "function" ? window.__webwallglInstance.getQuality() : null,
      qualityRequested: window.__codexQualityRequested || null,
      stats: window.__webwallglInstance && window.__webwallglInstance.stats ? { fps: window.__webwallglInstance.stats.fps, running: window.__webwallglInstance.stats.running, idle: window.__webwallglInstance.stats.idle, occluded: window.__webwallglInstance.stats.occluded, throttled: window.__webwallglInstance.stats.throttled } : null,
      mountSeq: window.__codexMountSeq || 0,
      visibility: document.visibilityState,
      pickerOpen: (() => {
        const picker = document.getElementById("codex-wallpaper-picker");
        const panel = picker && picker.shadowRoot ? picker.shadowRoot.querySelector(".panel") : null;
        return !!(panel && panel.classList.contains("open"));
      })(),
      hoverCommand: (() => {
        const picker = document.getElementById("codex-wallpaper-picker");
        return (picker && picker.dataset.hover) || "";
      })(),
      pickerCommand: (() => {
        const picker = document.getElementById("codex-wallpaper-picker");
        const command = picker?.dataset.command || "";
        if (picker) picker.dataset.command = "";
        return command;
      })(),
      controlsCommand: (() => {
        const controls = document.getElementById("codex-background-controls");
        const command = (controls && controls.dataset.controlsCommand) || "";
        if (controls) controls.dataset.controlsCommand = "";
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
let pkgCacheBytes = 0;

function evictPkgCache() {
  while (pkgCacheBytes > PKG_CACHE_BUDGET && pkgByteCache.size > 0) {
    const oldest = pkgByteCache.keys().next().value;
    const entry = pkgByteCache.get(oldest);
    pkgByteCache.delete(oldest);
    pkgCacheBytes -= entry.bytes.length;
  }
}

/* Drive the hidden file input over the DOM domain. It returns { ok: true } only
   after the page confirms it can see every requested file, so callers can fall
   back to byte injection on any failure. DOM.requestNode answers 0 for this
   page, hence getDocument + querySelector; the node is re-resolved on every call
   because node ids go stale whenever the page reloads. */
const fileInputInitExpression = inputId => `(() => {
  let input = document.getElementById(${JSON.stringify(inputId)});
  if (!input || !input.isConnected) {
    input = document.createElement("input");
    input.type = "file";
    input.id = ${JSON.stringify(inputId)};
    input.multiple = true;
    input.tabIndex = -1;
    input.setAttribute("aria-hidden", "true");
    input.style.cssText = "position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;pointer-events:none;z-index:-1";
    (document.documentElement || document.body).append(input);
  }
  return input.isConnected;
})()`;

/* Node ids only change when the page reloads, but resolving the input used to
   cost four DevTools round trips (DOM.enable, DOM.getDocument, DOM.querySelector
   and a verify evaluate) on every single switch. Remember the id that worked and
   re-resolve only when it goes stale. */
const fileInputNodeIds = new Map();
let domDomainEnabled = false;

async function resolveFileInputNode(command, inputId = FILE_INPUT_ID) {
  const selector = "#" + inputId;
  if (!domDomainEnabled) {
    try { await command("DOM.enable", {}); domDomainEnabled = true; }
    catch { return 0; }
  }
  let rootId = 0;
  try { const doc = await command("DOM.getDocument", { depth: 1 }); rootId = doc && doc.root ? doc.root.nodeId : 0; } catch { return 0; }
  if (!rootId) return 0;
  try { const node = await command("DOM.querySelector", { nodeId: rootId, selector }); return node && node.nodeId ? node.nodeId : 0; } catch { return 0; }
}

async function primeFileInput(command, paths, inputId = FILE_INPUT_ID) {
  const wanted = [...new Set((paths || []).filter(Boolean))];
  if (!wanted.length) return { ok: false, error: "no files to hand over" };
  let nodeId = fileInputNodeIds.get(inputId) || 0;
  let failure = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!nodeId) {
      try { await command("Runtime.evaluate", { expression: fileInputInitExpression(inputId), returnByValue: true }); }
      catch (error) { return { ok: false, error: "file input init failed: " + error.message }; }
      nodeId = await resolveFileInputNode(command, inputId);
      if (!nodeId) return { ok: false, error: "file input missing from the page" };
    }
    try { await command("DOM.setFileInputFiles", { files: wanted, nodeId }); failure = null; break; }
    catch (error) { failure = error; nodeId = 0; /* stale id (page reloaded): resolve again */ }
  }
  if (failure) return { ok: false, error: "DOM.setFileInputFiles failed: " + failure.message };
  fileInputNodeIds.set(inputId, nodeId);
  let seen = null;
  try { seen = await command("Runtime.evaluate", { expression: `(() => { const input = document.getElementById(${JSON.stringify(inputId)}); return input && input.files ? Array.from(input.files).map(file => file.name + ":" + file.size) : null; })()`, returnByValue: true }); }
  catch (error) { return { ok: false, error: "file input verify failed: " + error.message }; }
  if (!Array.isArray(seen) || seen.length !== wanted.length) {
    fileInputNodeIds.set(inputId, 0);
    return { ok: false, error: "file input holds " + (Array.isArray(seen) ? seen.length : "no") + " of " + wanted.length + " file(s)" };
  }
  return { ok: true, files: seen };
}

/* Hand the hidden input the absolute paths this switch needs and report them
   back in input order. Chromium turns each path into a file-backed Blob, so the
   page can give WebWallGL - or a <video>/<img> - the File itself and read the
   media straight off disk. No wallpaper bytes cross DevTools this way; ok=false
   means the caller should fall back to the byte stream. */
async function primeWallpaperFiles(command, paths, inputId = FILE_INPUT_ID) {
  const wanted = [];
  const seen = new Set();
  for (const candidate of paths || []) {
    if (!candidate || seen.has(candidate)) continue;
    let exists = false;
    try { exists = fs.existsSync(candidate); } catch {}
    if (!exists) continue;
    seen.add(candidate);
    wanted.push(candidate);
  }
  if (!wanted.length) return { ok: false, error: "no wallpaper files on disk" };
  const primed = await primeFileInput(command, wanted, inputId);
  if (!primed.ok) return primed;
  return { ok: true, paths: wanted, names: wanted.map(item => path.basename(item)), files: primed.files };
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
async function installSceneWebGL(found, current, options = {}) {
  const port = lockPort;
  const wallpaperId = current.source;
  const installEpoch = selectEpoch;
  const wallpaper = listWallpapers().find(item => item.id === wallpaperId);

  /* Wallpaper Engine general.properties for this scene. Defaults come from
     project.json; the picker's saved values win. The instance API takes a
     simple { key: value } map, and colours must arrive in WE's "r g b" form
     (a bare "#rrggbb" reads back as black), so the shared normaliser runs
     even for the mount-time defaults. */
  const sceneProperties = {};
  if (wallpaper && Array.isArray(wallpaper.properties) && wallpaper.properties.length) {
    try {
      const saved = libraryState().props[wallpaperId] || {};
      for (const [key, entry] of Object.entries(webPropertyPayload(wallpaper.properties, saved))) sceneProperties[key] = entry.value;
    } catch {}
  }

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
  /* Prefer the embedded scene video while it fits the budget: it is a far better
     picture than the low-resolution preview image that is usually the smallest
     candidate. Above the budget we fall back to the smallest candidate, and when
     nothing fits we skip the pre-injection entirely. */
  const videoFallback = fallbackCandidates.find(candidate => candidate.mime.startsWith("video/") && candidate.size > 0 && candidate.size <= FALLBACK_MAX_BYTES) || null;
  const smallestFallback = fallbackCandidates.filter(candidate => candidate.size > 0).sort((a, b) => a.size - b.size)[0] || null;
  const chosenFallback = videoFallback || (smallestFallback && smallestFallback.size <= FALLBACK_MAX_BYTES ? smallestFallback : null);
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
  /* The scene bytes only need to sit in Node's memory for the byte-stream
     fallback. With the CDP file channel the page reads the file itself, so the
     read (up to 126MB for the heaviest package) is deferred until that fallback
     is actually used. */
  let sceneBuf = null;
  const loadSceneBuf = () => {
    if (sceneBuf || !scenePath || sceneBytes <= 0) return sceneBuf;
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
    return sceneBuf;
  };

  const phaseMs = { pre: 0 };
  const result = await withPage(found.target, async command => {
    const preStartedAt = Date.now();
    if (options.cancelled && options.cancelled()) { log(`install aborted (superseded before priming): ${wallpaperId}`); return { ok: true, renderMode: "aborted", source: wallpaperId }; }
    /* Commit path. The hover prewarm already handed the page the package, loaded
       the library and mounted the scene into the pending layer, so the click only
       has to swap the two layers and cross-fade. */
    if (options.commit) {
      phaseMs.pre = 0;
      return await command("Runtime.evaluate", {
        expression: `${SWITCH_SOURCE}
(() => {
          const wallpaperId = ${JSON.stringify(wallpaperId)};
          const expectedToken = ${JSON.stringify(options.prewarmToken || "")};
          const pending = window.__codexPrewarm || null;
          const base = document.getElementById("codex-custom-background-base-pending-hover");
          if (!pending || pending.source !== wallpaperId || (expectedToken && pending.token !== expectedToken) || !base || !base.isConnected || !pending.instance || !pending.instance.canvas || !pending.instance.canvas.isConnected) {
            return { ok: false, renderMode: "no-prewarm", reason: "prewarm missing or stale", source: wallpaperId };
          }
          const started = performance.now();
          window.__codexPrewarm = null;
          window.__codexPrewarmToken = null;
          const previousInstance = window.__webwallglInstance;
          const whenIdle = (fn, timeoutMs) => { const run = () => { try { fn(); } catch {} }; try { if (typeof window.requestIdleCallback === "function") { window.requestIdleCallback(run, { timeout: timeoutMs }); return; } } catch {} setTimeout(run, timeoutMs); };
          const mediaEl = document.createElement("div");
          mediaEl.setAttribute("data-wallpaper-source", wallpaperId);
          mediaEl.setAttribute("data-render-mode", "webgl");
          mediaEl.setAttribute("data-webgl-ready", "true");
          mediaEl.setAttribute("data-background-opacity", "1");
          mediaEl.setAttribute("data-surface-opacity", "0");
          mediaEl.setAttribute("data-blur", "0");
          mediaEl.style.cssText = "position:fixed!important;inset:0!important;z-index:0!important;pointer-events:none!important;opacity:1";
          window.__webwallglInstance = pending.instance;
          const oldLayers = Array.from(document.querySelectorAll("#codex-custom-background-base, #codex-custom-background-media"));
          base.id = "codex-custom-background-base";
          mediaEl.id = "codex-custom-background-media";
          document.body.prepend(mediaEl);
          document.body.prepend(base);
          window.__lunaSwitchTransition(base, mediaEl, oldLayers, ${JSON.stringify(transitionFor())}, () => {
            for (const el of oldLayers) {
              if (!el || !el.isConnected) continue;
              const deadCanvas = el.querySelector ? el.querySelector("canvas") : null;
              whenIdle(() => {
                try {
                  if (deadCanvas) { const ctx = deadCanvas.getContext("webgl2") || deadCanvas.getContext("webgl"); const ext = ctx && ctx.getExtension ? ctx.getExtension("WEBGL_lose_context") : null; if (ext) ext.loseContext(); }
                  el.remove();
                } catch {}
              }, 700);
            }
            if (previousInstance && previousInstance !== pending.instance) {
              whenIdle(() => { try { previousInstance.destroy && previousInstance.destroy(); } catch {} try { previousInstance.unmount && previousInstance.unmount(); } catch {} try { previousInstance.dispose && previousInstance.dispose(); } catch {} }, 1000);
            }
          });
          return { ok: true, renderMode: "webgl", source: wallpaperId, via: "prewarm", pkgBytes: pending.pkgLen || 0, mountMs: 0, revealMs: Math.round(performance.now() - started), prewarmed: true };
        })()`,
        returnByValue: true,
        awaitPromise: true
      }, 20000);
    }

    /* Hand the page the files themselves over the DOM domain: only paths cross
       the wire, and Chromium exposes each as a file-backed Blob the page reads
       at disk speed. The scene pkg (and its fallback media) therefore no longer
       travel as base64 chunks through DevTools - the source of the switch lag. */
    const wantedPaths = [];
    if (scenePath && sceneBytes > 0) wantedPaths.push(scenePath);
    if (fallbackPath && fallbackBytes > 0) wantedPaths.push(fallbackPath);
    const primed = wantedPaths.length ? await primeWallpaperFiles(command, wantedPaths, options.prewarm ? PREWARM_FILE_INPUT_ID : FILE_INPUT_ID) : { ok: false, error: "no scene files on disk" };
    const sceneIndex = primed.ok ? primed.paths.indexOf(scenePath) : -1;
    const fallbackIndex = primed.ok ? primed.paths.indexOf(fallbackPath) : -1;
    if (!primed.ok) log(`scene ${wallpaperId}: file channel unavailable (${primed.error}), streaming bytes`);

    await command("Runtime.evaluate", { expression: `${INGEST_HELPER}\nwindow.__codexScenePkg = null; window.__codexSceneFallback = null; window.__codexSceneFiles = ${JSON.stringify({ sceneIndex, project: sceneProject, fallbackIndex, fallbackMime })}; 0`, returnByValue: true });

    /* Tier three: stream the pkg bytes through DevTools only when the file did
       not make it into the page. */
    if (sceneIndex < 0 && scenePath && sceneBytes > 0) {
      await command("Runtime.evaluate", { expression: `window.__codexScenePkg = { bytes: new Uint8Array(${sceneBytes}), offset: 0, project: ${JSON.stringify(sceneProject)} }; 0`, returnByValue: true });
      let sceneInjected = true;
      const buffered = loadSceneBuf();
      const sceneSource = buffered ? base64ChunkSourceFromBuffer(buffered, sceneRawChunk) : base64ChunkSource(scenePath, sceneRawChunk);
      for (const chunk of sceneSource) {
        if (selectEpoch !== installEpoch) { log(`install aborted (superseded during scene injection): ${wallpaperId}`); sceneInjected = false; break; }
        try { await command("Runtime.evaluate", { expression: `window.__codexIngest("__codexScenePkg", ${JSON.stringify(chunk)})`, returnByValue: true, awaitPromise: true }); }
        catch (error) { log(`scene pkg inject failed for ${wallpaperId}: ${error.message}`); sceneInjected = false; break; }
      }
      if (!sceneInjected) { await command("Runtime.evaluate", { expression: "window.__codexScenePkg = null; 0", returnByValue: true }); }
    }
    if (fallbackIndex < 0 && fallbackPath && fallbackBytes > 0) {
      await command("Runtime.evaluate", { expression: `window.__codexSceneFallback = { bytes: new Uint8Array(${fallbackBytes}), offset: 0, mime: ${JSON.stringify(fallbackMime)} }; 0`, returnByValue: true });
      let fallbackInjected = true;
      for (const chunk of base64ChunkSource(fallbackPath, fallbackRawChunk)) {
        if (selectEpoch !== installEpoch) { log(`install aborted (superseded during fallback injection): ${wallpaperId}`); fallbackInjected = false; break; }
        try { await command("Runtime.evaluate", { expression: `window.__codexIngest("__codexSceneFallback", ${JSON.stringify(chunk)})`, returnByValue: true, awaitPromise: true }); }
        catch (error) { log(`scene fallback inject failed for ${wallpaperId}: ${error.message}`); fallbackInjected = false; break; }
      }
      if (!fallbackInjected) { await command("Runtime.evaluate", { expression: "window.__codexSceneFallback = null; 0", returnByValue: true }); }
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


    phaseMs.pre = Date.now() - preStartedAt;
    if (selectEpoch !== installEpoch || (options.cancelled && options.cancelled())) { log(`install aborted (superseded): ${wallpaperId}`); return { ok: true, renderMode: "aborted", source: wallpaperId }; }
    return await command("Runtime.evaluate", {
      expression: `${SWITCH_SOURCE}
(async () => {
        const wallpaperId = ${JSON.stringify(wallpaperId)};
        const libraryAvailable = ${JSON.stringify(!!libraryAvailable)};
        const PREWARM_ONLY = ${JSON.stringify(options.prewarm === true)};
        const PREWARM_TOKEN = ${JSON.stringify(options.prewarmToken || "")};
        const PROPERTIES = ${JSON.stringify(sceneProperties)};
        /* A prewarm stages into its own hidden input so no other install can
           replace the File under the library lazy fileSource() read. */
        const FILE_INPUT_ID = PREWARM_ONLY ? ${JSON.stringify(PREWARM_FILE_INPUT_ID)} : ${JSON.stringify(FILE_INPUT_ID)};
        if (PREWARM_ONLY) { try { window.__codexPrewarmToken = PREWARM_TOKEN; } catch {} }
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
        /* The universal "#root *" rule below blanks the whole app shell, so
           re-inserting the element costs a full-document style recalc (~150-220ms
           on a busy transcript). The text is constant, so keep the node while it
           already carries it and only rebuild on an actual change. */
        const applyStyleOnce = (id, text) => {
          const existing = document.getElementById(id);
          if (existing && existing.textContent === text) return;
          if (existing) existing.remove();
          const style = document.createElement("style");
          style.id = id;
          style.textContent = text;
          document.head.append(style);
        };
        /* One shared stylesheet text for every render path. The rules below match
           #root * across the whole app shell, so rewriting the sheet invalidates style
           for every node (~150-220ms on a busy transcript). Native and WebGL used to
           carry slightly different copies, so every native<->webgl switch rebuilt the
           sheet; with identical text applyStyleOnce leaves the existing node in place. */
        const BACKGROUND_STYLE_TEXT = [
          "html, body, #root, #root *, #root *::before, #root *::after { background: transparent !important; backdrop-filter: none !important; box-shadow: none !important; }",
          "#root { position: relative !important; z-index: 1 !important; min-height: 100vh !important; }",
          "#codex-custom-background-media { display: block !important; visibility: visible !important; }",
          "#codex-custom-background-base, #codex-custom-background-base-pending { display: block !important; visibility: visible !important; width: 100vw !important; height: 100vh !important; }",
          "#codex-custom-background-base canvas, #codex-custom-background-base-pending canvas { display: block !important; visibility: visible !important; width: 100vw !important; height: 100vh !important; }"
        ].join("\\n");
        /* Releasing an outgoing background (GL context, dead layers, instance) is
           real main-thread work. Run it when the page is idle instead of in the
           frames right after the swap; the timeout keeps it bounded. Separate
           deadlines keep the two jobs in separate tasks. */
        const whenIdle = (fn, timeoutMs) => {
          const run = () => { try { fn(); } catch {} };
          try { if (typeof window.requestIdleCallback === "function") { window.requestIdleCallback(run, { timeout: timeoutMs }); return; } } catch {}
          setTimeout(run, timeoutMs);
        };
        const injectBaseStyle = () => applyStyleOnce("codex-custom-background-style", BACKGROUND_STYLE_TEXT);
        /* Cross-fade plumbing. The currently visible layers are captured up
           front and left alone (still rendering) while the replacement is
           staged at opacity 0; once it is ready we swap the ids into place and
           fade the old layers out. Previously every switch tore the old
           background down first, so the page sat on a black canvas for the
           whole inject+mount window - and with a slow mount the blurry preview
           was the first thing the user saw. */
        const PENDING_BASE_ID = "codex-custom-background-base-pending";
        /* The staged layer gets its own id so a click on a different row can start
           an install immediately instead of waiting for this mount to finish. */
        const PREWARM_BASE_ID = PENDING_BASE_ID + "-hover";
        const prewarmBaseStyle = "position:fixed!important;inset:0!important;background:#000!important;z-index:0!important;pointer-events:none!important;opacity:0;display:block!important;visibility:visible!important;width:100vw!important;height:100vh!important";
        const dropPrewarmLayer = () => { const el = document.getElementById(PREWARM_BASE_ID); if (el) { loseGl(el.querySelector("canvas")); el.remove(); } };
        const previousLayers = () => ["codex-custom-background-base", "codex-custom-background-media"].map(id => document.getElementById(id)).filter(Boolean);
        const dropPending = () => { const el = document.getElementById(PENDING_BASE_ID); if (el) { loseGl(el.querySelector("canvas")); el.remove(); } };
        const revealBackground = (baseEl, mediaEl, oldLayers) => {
          baseEl.id = "codex-custom-background-base";
          mediaEl.id = "codex-custom-background-media";
          document.body.prepend(mediaEl);
          document.body.prepend(baseEl);
          window.__lunaSwitchTransition(baseEl, mediaEl, oldLayers, ${JSON.stringify(transitionFor())}, () => {
            for (const el of oldLayers) {
              if (!el || !el.isConnected) continue;
              const deadCanvas = el.querySelector ? el.querySelector("canvas") : null;
              whenIdle(() => { try { if (deadCanvas) loseGl(deadCanvas); el.remove(); } catch {} }, 700);
            }
          });
        };
        const renderFallback = (reason, oldLayers) => {
          const data = window.__codexSceneFallback;
          const sceneInfo = window.__codexSceneFiles;
          const fallbackInput = document.getElementById(FILE_INPUT_ID);
          const fallbackFile = fallbackInput && sceneInfo && sceneInfo.fallbackIndex >= 0 && fallbackInput.files ? fallbackInput.files[sceneInfo.fallbackIndex] : null;
          let objectUrl = null;
          let usedMime = "";
          let usedBytes = 0;
          if (fallbackFile) {
            objectUrl = URL.createObjectURL(fallbackFile);
            usedMime = (sceneInfo && sceneInfo.fallbackMime) || fallbackFile.type || "image/gif";
            usedBytes = fallbackFile.size;
          } else if (data && data.bytes && data.bytes.length) {
            usedBytes = data.bytes.length;
            usedMime = data.mime;
            objectUrl = URL.createObjectURL(new Blob([data.bytes], { type: usedMime }));
          } else {
            return { ok: false, renderMode: "failed", webglError: String(reason), fallbackError: "no fallback media injected", source: wallpaperId };
          }
          const isVideo = usedMime.startsWith("video/");
          window.__codexSceneFallback = null;
          dropPending();
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
          return { ok: true, renderMode: "fallback", webglError: String(reason), source: wallpaperId, fallbackBytes: usedBytes, fallbackMime: usedMime, via: fallbackFile ? "file" : "cdp" };
        };
        /* One page-wide guard for WEBGL context loss. Installed once and
           intentionally listening on document (capture) so it survives the
           background swaps that replace the canvas: the live instance is
           resolved at event time. Only a loss on the canvas the current
           WebWallGL instance renders into counts - the loseContext() calls this
           plugin makes while tearing down an outgoing background must not look
           like a failure. The page attempts an in-place rebuild first and only
           reports the loss to the watchdog when that does not take. */
        const installGlGuard = requestedQuality => {
          if (!window.__codexGlGuardInstalled) {
            window.__codexGlGuardInstalled = true;
            window.__codexContextEvents = window.__codexContextEvents || [];
            const note = (kind, extra) => { try { const queue = window.__codexContextEvents; queue.push({ kind, t: Date.now(), source: document.getElementById("codex-custom-background-media")?.getAttribute("data-wallpaper-source") || null, ...extra }); if (queue.length > 40) queue.shift(); } catch {} };
            const rebuild = () => { window.__codexSuppressGlLossUntil = Date.now() + 3000; const live = window.__webwallglInstance; if (!live || typeof live.restore !== "function") { note("restore-skip"); return false; } live.restore(); return true; };
            const verify = attempt => {
              setTimeout(() => {
                let lost = true;
                try { const live = window.__webwallglInstance; const canvas = live && live.canvas; const gl = canvas && canvas.getContext ? (canvas.getContext("webgl2") || canvas.getContext("webgl")) : null; lost = gl ? !!gl.isContextLost() : true; } catch {}
                if (!lost) { window.__codexContextLost = null; note("restore-ok"); return; }
                if (attempt < 2) { note("restore-retry", { attempt }); try { rebuild(); } catch (error) { note("restore-fail", { attempt, message: String(error && error.message || error).slice(0, 160) }); } verify(attempt + 1); return; }
                note("restore-fail", { attempt });
              }, 700 + attempt * 500);
            };
            document.addEventListener("webglcontextlost", event => {
              try {
                const live = window.__webwallglInstance;
                if (!live || !live.canvas || event.target !== live.canvas || !live.canvas.isConnected) { note("lost-ignored"); return; }
                if (window.__codexSuppressGlLossUntil && Date.now() < window.__codexSuppressGlLossUntil) { note("lost-suppressed"); return; }
                window.__codexContextLost = { t: Date.now(), source: document.getElementById("codex-custom-background-media")?.getAttribute("data-wallpaper-source") || null };
                note("lost");
                setTimeout(() => { try { rebuild(); } catch (error) { note("restore-fail", { attempt: 0, message: String(error && error.message || error).slice(0, 160) }); } verify(1); }, 60);
              } catch (error) { note("lost-handler-error", { message: String(error && error.message || error).slice(0, 160) }); }
            }, true);
            document.addEventListener("webglcontextrestored", () => note("restored"), true);
          }
          try { window.__codexQualityRequested = { ...requestedQuality }; window.__codexMountSeq = (window.__codexMountSeq || 0) + 1; window.__codexContextLost = null; } catch {}
        };
        /* A prewarm must never touch the visible wallpaper: when the scene cannot
           be staged, report the failure instead of swapping a fallback on screen. */
        const prewarmUnavailable = reason => ({ ok: false, renderMode: "prewarm-unavailable", reason, source: wallpaperId });
        const mountWebGL = async (oldLayers) => {
          dropPending();
          if (!libraryAvailable) {
            if (PREWARM_ONLY) return prewarmUnavailable("WebWallGL library unavailable");
            return renderFallback(window.__webwallglLibError ? ("WebWallGL library error: " + window.__webwallglLibError) : "WebWallGL library not vendored (offline environment)", oldLayers);
          }
          if (window.__codexWebgl2Available === undefined) {
            const probe = document.createElement("canvas");
            const probeCtx = probe.getContext("webgl2");
            window.__codexWebgl2Available = !!probeCtx;
            try { probeCtx?.getExtension("WEBGL_lose_context")?.loseContext(); } catch {}
          }
          if (!window.__codexWebgl2Available) { if (PREWARM_ONLY) return prewarmUnavailable("WebGL2 not available"); return renderFallback("WebGL2 not available", oldLayers); }
          const previousInstance = window.__webwallglInstance;
          const base = document.createElement("div");
          base.id = PREWARM_ONLY ? PREWARM_BASE_ID : PENDING_BASE_ID;
          if (PREWARM_ONLY) base.setAttribute("data-prewarm-token", PREWARM_TOKEN);
          base.setAttribute("data-wallpaper-source", wallpaperId);
          base.style.cssText = PREWARM_ONLY ? prewarmBaseStyle : "position:fixed!important;inset:0!important;background:#000!important;z-index:0!important;pointer-events:none!important;display:block!important;opacity:0";
          if (PREWARM_ONLY) dropPrewarmLayer();
          document.body.prepend(base);
          const sceneInfo = window.__codexSceneFiles || null;
          const pkgData = window.__codexScenePkg;
          const pkgProject = (sceneInfo && sceneInfo.project) || (pkgData && pkgData.project) || null;
          const fileInput = document.getElementById(FILE_INPUT_ID);
          const sceneFile = fileInput && sceneInfo && sceneInfo.sceneIndex >= 0 && fileInput.files ? fileInput.files[sceneInfo.sceneIndex] : null;
          const { mount, bytesSource, fileSource } = window.WebWallGL;
          /* Three tiers, cheapest first: let WebWallGL read the pkg off disk; else
             read the File into memory ourselves; else use the bytes streamed
             through DevTools. */
          let source = null;
          let via = "none";
          let pkgLen = 0;
          if (sceneFile && typeof fileSource === "function") {
            source = fileSource(sceneFile, pkgProject);
            via = "file-source";
            pkgLen = sceneFile.size;
          } else if (sceneFile) {
            try { const fileBytes = new Uint8Array(await sceneFile.arrayBuffer()); source = bytesSource(fileBytes, pkgProject, "watchdog:" + wallpaperId); via = "file-buffer"; pkgLen = fileBytes.length; }
            catch (error) { pushDiag("error", "scene file read failed: " + String(error && error.message || error).slice(0, 120)); }
          }
          if (!source && pkgData && pkgData.bytes && pkgData.bytes.length) {
            source = bytesSource(pkgData.bytes, pkgProject, "watchdog:" + wallpaperId);
            via = "cdp";
            pkgLen = pkgData.bytes.length;
          }
          if (!source) throw new Error("scene pkg not available (missing scene.pkg?)");
          window.__codexScenePkg = null;
          /* Ask WebWallGL for the top tier it can hold: renderDpr >= 1.5 lifts
             its internal resource cap (textures were sampled at 0.6-0.8x) and
             4x MSAA cleans up edges. The library's own adaptive quality still
             steps down on a machine that cannot keep up. */
          const renderDpr = Math.min(2, Math.max(window.devicePixelRatio || 1, 1.5));
          const quality = { antiAliasing: "msaa4", particles: "high", postProcessing: "high" };
          const mountOptions = extra => ({
            source,
            renderDpr,
            quality,
            properties: PROPERTIES,
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
              nb.id = PREWARM_ONLY ? PREWARM_BASE_ID : PENDING_BASE_ID;
              if (PREWARM_ONLY) nb.setAttribute("data-prewarm-token", PREWARM_TOKEN);
              nb.setAttribute("data-wallpaper-source", wallpaperId);
              nb.style.cssText = PREWARM_ONLY ? prewarmBaseStyle : "position:fixed!important;inset:0!important;background:#000!important;z-index:0!important;pointer-events:none!important;display:block!important;opacity:0";
              document.body.prepend(nb);
              pushDiag("info", "retrying mount with mountTimeoutMs=0 (first-frame timeout recovery)");
              try { inst = await mount(nb, mountOptions({ mountTimeoutMs: 0 })); retried = true; }
              catch (retryErr) { pushDiag("error", "mount retry failed: " + String(retryErr && retryErr.message || retryErr).slice(0, 160)); throw retryErr; }
            } else { throw mountErr; }
          }
          if (!inst) throw new Error("WebWallGL mount returned no instance");
          if (Object.keys(PROPERTIES).length && typeof inst.setProperties === "function") {
            try { inst.setProperties(PROPERTIES); } catch (error) { pushDiag("error", "setProperties failed: " + String(error && error.message || error).slice(0, 120)); }
          }
          if (PREWARM_ONLY) {
            /* Superseded while the mount was running: the drop already invalidated
               this token, so throw the fresh instance and its layer away rather
               than leaving a second live scene behind. */
            if (window.__codexPrewarmToken !== PREWARM_TOKEN) {
              try { inst.destroy && inst.destroy(); } catch {}
              try { inst.unmount && inst.unmount(); } catch {}
              try { inst.dispose && inst.dispose(); } catch {}
              dropPrewarmLayer();
              return { ok: true, renderMode: "aborted", source: wallpaperId };
            }
            /* Park the mounted instance in the staged layer and leave the live
               wallpaper, its style sheet and the GL guard untouched. */
            const parked = document.getElementById(PREWARM_BASE_ID);
            if (parked) { try { const cv = parked.querySelector("canvas"); if (cv) { cv.style.display = "block"; cv.style.visibility = "visible"; cv.style.width = "100vw"; cv.style.height = "100vh"; } } catch {} }
            window.__codexPrewarm = { source: wallpaperId, token: PREWARM_TOKEN, baseId: PREWARM_BASE_ID, instance: inst, quality, pkgLen, at: Date.now() };
            installGlGuard(quality);
            return { ok: true, renderMode: "webgl", prewarmed: true, source: wallpaperId, via, pkgBytes: pkgLen, mountMs: Math.round(performance.now() - mountStarted), lastDiag: lastDiag(), diagCount: diagCount() };
          }
          window.__webwallglInstance = inst;
          const mediaEl = document.createElement("div");
          mediaEl.setAttribute("data-wallpaper-source", wallpaperId);
          mediaEl.setAttribute("data-render-mode", "webgl");
          mediaEl.setAttribute("data-webgl-ready", "true");
          mediaEl.setAttribute("data-background-opacity", "1");
          mediaEl.setAttribute("data-surface-opacity", "0");
          mediaEl.setAttribute("data-blur", "0");
          mediaEl.style.cssText = "position:fixed!important;inset:0!important;z-index:0!important;pointer-events:none!important;opacity:1";
          revealBackground(document.getElementById(PREWARM_ONLY ? PREWARM_BASE_ID : PENDING_BASE_ID) || base, mediaEl, oldLayers);
          if (previousInstance && previousInstance !== inst) {
            whenIdle(() => { try { previousInstance.destroy && previousInstance.destroy(); } catch {} try { previousInstance.unmount && previousInstance.unmount(); } catch {} try { previousInstance.dispose && previousInstance.dispose(); } catch {} }, 1000);
          }
          applyStyleOnce("codex-custom-background-style", BACKGROUND_STYLE_TEXT);
          installGlGuard(quality);
          return { ok: true, renderMode: "webgl", source: wallpaperId, via, pkgBytes: pkgLen, mountMs: Math.round(performance.now() - mountStarted), mountRetried: retried, renderDpr, lastDiag: lastDiag(), diagCount: diagCount() };
        };
        /* While the app window is hidden/occluded Chromium freezes rAF, so the
           render loop cannot produce the first frame mount() waits for (the
           library gives up after 60s or hangs outright). Show the injected
           fallback right away and upgrade to WebGL the moment the page
           becomes visible again. */
        const oldLayers = previousLayers();
        const fallbackReady = (() => { const info = window.__codexSceneFiles; const input = document.getElementById(FILE_INPUT_ID); if (info && info.fallbackIndex >= 0 && input && input.files && input.files[info.fallbackIndex]) return true; return !!(window.__codexSceneFallback && window.__codexSceneFallback.bytes && window.__codexSceneFallback.bytes.length); })();
        if (document.visibilityState === "hidden" && fallbackReady) {
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
          if (PREWARM_ONLY) { dropPending(); return prewarmUnavailable(String(err && err.message || err).slice(0, 160)); }
          return renderFallback(err, oldLayers);
        }
      })()`,
      returnByValue: true,
      awaitPromise: true
    }, options.prewarm ? 20000 : 120000);
  });
  if (result && typeof result === "object") result.preMs = phaseMs.pre;
  if (result && result.renderMode === "webgl" && result.prewarmed && result.via !== "prewarm") {
    log(`scene prewarm ${wallpaperId}: staged into the pending layer (via=${result.via} pkgBytes=${result.pkgBytes} mountMs=${result.mountMs} preMs=${result.preMs})`);
  } else if (result && result.renderMode === "webgl" && result.via !== "prewarm") {
    log(`scene webgl ${wallpaperId}: renderMode=webgl (vendored WebWallGL, via=${result.via} pkgBytes=${result.pkgBytes} mountMs=${result.mountMs} preMs=${phaseMs.pre}${result.mountRetried ? " retried=true" : ""}${result.lastDiag ? " lastDiag=" + String(result.lastDiag).slice(0, 160) : ""}${result.diagCount ? " diagCount=" + result.diagCount : ""})`);
  } else if (result) {
    log(`scene webgl ${wallpaperId}: renderMode=${result.renderMode}${result.via ? " via=" + result.via : ""}${result.deferredWebGL ? " deferredWebGL=true" : ""}${result.webglError ? " webglError=" + String(result.webglError).slice(0, 180) : ""}${result.fallbackError ? " fallbackError=" + result.fallbackError : ""}${result.fallbackBytes ? " fallbackBytes=" + result.fallbackBytes + " mime=" + result.fallbackMime : ""}${result.error ? " error=" + result.error : ""}${result.lastDiag ? " lastDiag=" + String(result.lastDiag).slice(0, 160) : ""}${result.diagCount ? " diagCount=" + result.diagCount : ""}`);
  }
  return result;
}
const WEB_FALLBACK_MAX_BYTES = 24 * 1024 * 1024;
const WEB_LOAD_TIMEOUT_MS = 8000;

const PREVIEW_MIME = { ".gif": "image/gif", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".avif": "image/avif" };

/* Phase 4: Wallpaper Engine web projects.

   The page cannot load 127.0.0.1 in a frame (CSP frame-src) and cannot run an
   inline <script> inside srcdoc (CSP script-src), so the watchdog:
     1. inlines styles/images/fonts/media into one srcdoc document,
     2. mounts an iframe with sandbox="allow-scripts" only,
     3. attaches to the frame's own DevTools target (the sandbox makes it an
        out-of-process frame) and runs the prelude plus the project's scripts
        through Runtime.evaluate there: global scope, unaffected by CSP.
   The opaque origin keeps Codex cookies/localStorage out of reach; later
   property edits travel through postMessage to the prelude, which calls
   wallpaperPropertyListener.applyUserProperties inside the frame. */
async function installWebWallpaper(found, current) {
  const item = listWallpapers().find(entry => entry.id === current.source);
  if (!item || !item.webEntry) return { ok: false, renderMode: "failed", source: current.source, error: "web wallpaper metadata missing" };
  const built = buildWebDocument(item);
  if (!built.ok) {
    log(`web ${current.source}: document build failed (${built.error})`);
    return { ok: false, renderMode: "failed", source: current.source, error: built.error };
  }
  if (built.warnings.length) log(`web ${current.source}: ${built.warnings.slice(0, 5).join(" | ")}${built.warnings.length > 5 ? " (+" + (built.warnings.length - 5) + " more)" : ""}`);

  /* Same preference as the Scene fallback: a video that fits the budget is a
     far better picture than the preview thumbnail, and when nothing fits the
     switch reports failure instead of showing a broken frame. */
  const fallbackCandidates = [];
  if (item.preview && fs.existsSync(item.preview)) {
    try { fallbackCandidates.push({ path: item.preview, mime: PREVIEW_MIME[path.extname(item.preview).toLowerCase()] || "image/gif", size: fs.statSync(item.preview).size }); } catch {}
  }
  if (item.webDir) {
    try {
      for (const name of fs.readdirSync(item.webDir).slice(0, 200)) {
        const ext = path.extname(name).toLowerCase();
        if (ext !== ".mp4" && ext !== ".webm") continue;
        const candidate = path.join(item.webDir, name);
        fallbackCandidates.push({ path: candidate, mime: ext === ".mp4" ? "video/mp4" : "video/webm", size: fs.statSync(candidate).size });
        if (fallbackCandidates.length > 2) break;
      }
    } catch {}
  }
  const videoCandidate = fallbackCandidates.find(candidate => candidate.mime.startsWith("video/") && candidate.size > 0 && candidate.size <= WEB_FALLBACK_MAX_BYTES) || null;
  const smallestCandidate = fallbackCandidates.filter(candidate => candidate.size > 0).sort((a, b) => a.size - b.size)[0] || null;
  const chosenFallback = videoCandidate || (smallestCandidate && smallestCandidate.size <= WEB_FALLBACK_MAX_BYTES ? smallestCandidate : null);
  const fallbackPath = chosenFallback ? chosenFallback.path : null;
  const fallbackMime = chosenFallback ? chosenFallback.mime : "image/gif";

  const propertyPayload = webPropertyPayload(item.properties, libraryState().props[current.source] || {});
  const scriptCount = built.scripts.length;
  /* Step 1 - mount. The frame stays at opacity 0 behind the current wallpaper
     until its scripts have run, so a slow project never shows a black gap and
     the old wallpaper keeps painting. */
  const mountExpression = `(async () => {
  const wallpaperId = ${JSON.stringify(current.source)};
  const TOKEN = ${JSON.stringify(built.token)};
  const SRCDOC = ${JSON.stringify(built.html)};
  const TIMEOUT_MS = ${WEB_LOAD_TIMEOUT_MS};
  document.getElementById("codex-custom-background-web-frame")?.remove();
  document.getElementById("codex-custom-background-web-base")?.remove();
  const stale = window.__lunaWebStage;
  if (stale && stale.onMessage) { try { window.removeEventListener("message", stale.onMessage); } catch {} }
  const oldLayers = ["codex-custom-background-base", "codex-custom-background-media"].map(id => document.getElementById(id)).filter(Boolean);
  const previousInstance = window.__webwallglInstance;
  window.__webwallglInstance = null;
  const base = document.createElement("div");
  base.setAttribute("data-wallpaper-source", wallpaperId);
  base.style.cssText = "position:fixed!important;inset:0!important;background:#000!important;z-index:0!important;pointer-events:none!important;opacity:0";
  const frame = document.createElement("iframe");
  frame.id = "codex-custom-background-web-frame";
  frame.name = TOKEN;
  frame.setAttribute("sandbox", "allow-scripts");
  frame.setAttribute("allow", "");
  frame.setAttribute("referrerpolicy", "no-referrer");
  frame.setAttribute("data-wallpaper-source", wallpaperId);
  frame.setAttribute("data-render-mode", "web");
  frame.style.cssText = "position:fixed!important;inset:0!important;width:100vw!important;height:100vh!important;border:0!important;background:#000!important;pointer-events:none!important;display:block!important;opacity:0";
  const stage = { token: TOKEN, source: wallpaperId, base, frame, oldLayers, previousInstance, errors: [], booted: false, loaded: false, started: performance.now() };
  stage.onMessage = event => {
    if (!frame.contentWindow || event.source !== frame.contentWindow) return;
    const data = event.data || {};
    if (data.__lunaBooted === TOKEN) stage.booted = true;
    if (data.__lunaWebError) stage.errors.push(String(data.__lunaWebError).slice(0, 220));
  };
  window.addEventListener("message", stage.onMessage);
  window.__lunaWebStage = stage;
  const waitLoad = new Promise(resolve => {
    let done = false;
    const finish = value => { if (done) return; done = true; resolve(value); };
    frame.addEventListener("load", () => { stage.loaded = true; setTimeout(() => finish(true), 60); }, { once: true });
    setTimeout(() => finish(false), TIMEOUT_MS);
  });
  document.body.prepend(frame);
  document.body.prepend(base);
  frame.srcdoc = SRCDOC;
  await waitLoad;
  return { loaded: stage.loaded, booted: stage.booted, webMs: Math.round(performance.now() - stage.started), errors: stage.errors.slice(0, 6) };
})()`;

  /* Step 2 - reveal. Runs after the project scripts and properties landed. */
  const revealExpression = `${SWITCH_SOURCE}
(() => {
  const stage = window.__lunaWebStage;
  if (!stage || !stage.frame || !stage.frame.isConnected) return { ok: false, error: "web stage missing" };
  const frame = stage.frame;
  const base = stage.base;
  const oldLayers = stage.oldLayers || [];
  try { window.removeEventListener("message", stage.onMessage); } catch {}
  const whenIdle = (fn, timeoutMs) => { const run = () => { try { fn(); } catch {} }; try { if (typeof window.requestIdleCallback === "function") { window.requestIdleCallback(run, { timeout: timeoutMs }); return; } } catch {} setTimeout(run, timeoutMs); };
  const loseGl = el => { try { const ctx = el && el.getContext ? (el.getContext("webgl2") || el.getContext("webgl")) : null; const ext = ctx && ctx.getExtension ? ctx.getExtension("WEBGL_lose_context") : null; if (ext) ext.loseContext(); } catch {} };
  frame.id = "codex-custom-background-media";
  frame.setAttribute("data-web-ready", "true");
  frame.setAttribute("data-web-scripts", ${JSON.stringify(String(scriptCount))});
  base.id = "codex-custom-background-base";
  window.__lunaWeb = { source: stage.source, token: stage.token, at: Date.now(), scripts: ${JSON.stringify(scriptCount)} };
  window.__lunaSwitchTransition(base, frame, oldLayers, ${JSON.stringify(transitionFor())}, () => {
    for (const old of oldLayers) {
      if (!old || !old.isConnected || old === frame || old === base) continue;
      const deadCanvas = old.querySelector ? old.querySelector("canvas") : null;
      const deadUrl = old.getAttribute ? old.getAttribute("data-object-url") : null;
      whenIdle(() => { try { if (deadCanvas) loseGl(deadCanvas); if (deadUrl) URL.revokeObjectURL(deadUrl); if (old.pause) old.pause(); old.remove(); } catch {} }, 700);
    }
    const previousInstance = stage.previousInstance;
    if (previousInstance) whenIdle(() => { try { previousInstance.destroy && previousInstance.destroy(); } catch {} try { previousInstance.unmount && previousInstance.unmount(); } catch {} try { previousInstance.dispose && previousInstance.dispose(); } catch {} }, 1000);
  });
  return { ok: true, webMs: Math.round(performance.now() - stage.started) };
})()`;

  /* Step 3 - fallback. Uses the frame's prepared base layer so no second black
     gap appears; the temp frame is dropped before the media mounts. */
  const fallbackExpression = (reason, fileIndex) => `${SWITCH_SOURCE}
(() => {
  const stage = window.__lunaWebStage;
  const wallpaperId = ${JSON.stringify(current.source)};
  const REASON = ${JSON.stringify(String(reason || "web wallpaper unavailable"))};
  const FALLBACK = ${JSON.stringify({ index: Number(fileIndex), mime: fallbackMime })};
  const FILE_INPUT_ID = ${JSON.stringify(FILE_INPUT_ID)};
  const whenIdle = (fn, timeoutMs) => { const run = () => { try { fn(); } catch {} }; try { if (typeof window.requestIdleCallback === "function") { window.requestIdleCallback(run, { timeout: timeoutMs }); return; } } catch {} setTimeout(run, timeoutMs); };
  const loseGl = el => { try { const ctx = el && el.getContext ? (el.getContext("webgl2") || el.getContext("webgl")) : null; const ext = ctx && ctx.getExtension ? ctx.getExtension("WEBGL_lose_context") : null; if (ext) ext.loseContext(); } catch {} };
  const base = stage && stage.base ? stage.base : document.createElement("div");
  const oldLayers = stage && stage.oldLayers ? stage.oldLayers : [];
  const previousInstance = stage && stage.previousInstance ? stage.previousInstance : window.__webwallglInstance;
  if (stage) { try { window.removeEventListener("message", stage.onMessage); } catch {} try { stage.frame.remove(); } catch {} }
  const input = document.getElementById(FILE_INPUT_ID);
  const file = input && FALLBACK.index >= 0 && input.files ? input.files[FALLBACK.index] : null;
  if (!file) { try { base.remove(); } catch {} return { ok: false, renderMode: "failed", source: wallpaperId, error: REASON }; }
  const url = URL.createObjectURL(file);
  const isVideo = FALLBACK.mime.indexOf("video/") === 0;
  const el = document.createElement(isVideo ? "video" : "img");
  el.src = url;
  el.setAttribute("data-object-url", url);
  el.setAttribute("data-wallpaper-source", wallpaperId);
  el.setAttribute("data-render-mode", "fallback");
  el.setAttribute("data-background-opacity", "1");
  el.setAttribute("data-surface-opacity", "0");
  el.setAttribute("data-blur", "0");
  if (isVideo) { el.autoplay = true; el.loop = true; el.muted = true; el.playsInline = true; el.disablePictureInPicture = true; }
  el.style.cssText = "position:fixed!important;inset:0!important;width:100vw!important;height:100vh!important;object-fit:cover!important;z-index:0!important;pointer-events:none!important;background:#000;opacity:0";
  el.id = "codex-custom-background-media";
  base.id = "codex-custom-background-base";
  document.body.prepend(el);
  window.__lunaSwitchTransition(base, el, oldLayers, ${JSON.stringify(transitionFor())}, () => {
    for (const old of oldLayers) {
      if (!old || !old.isConnected || old === el || old === base) continue;
      const deadCanvas = old.querySelector ? old.querySelector("canvas") : null;
      const deadUrl = old.getAttribute ? old.getAttribute("data-object-url") : null;
      whenIdle(() => { try { if (deadCanvas) loseGl(deadCanvas); if (deadUrl) URL.revokeObjectURL(deadUrl); if (old.pause) old.pause(); old.remove(); } catch {} }, 700);
    }
    if (previousInstance) whenIdle(() => { try { previousInstance.destroy && previousInstance.destroy(); } catch {} try { previousInstance.unmount && previousInstance.unmount(); } catch {} try { previousInstance.dispose && previousInstance.dispose(); } catch {} }, 1000);
  });
  if (isVideo) el.play().catch(() => {});
  return { ok: true, renderMode: "fallback", webError: REASON, source: wallpaperId, via: "file", fallbackMime: FALLBACK.mime };
})()`;

  const result = await withPage(found.target, async command => {
    let fallbackIndex = -1;
    if (fallbackPath) {
      const primed = await primeWallpaperFiles(command, [fallbackPath]);
      fallbackIndex = primed.ok ? primed.paths.indexOf(fallbackPath) : -1;
      if (!primed.ok) log(`web ${current.source}: fallback file channel unavailable (${primed.error})`);
    }
    const mount = await command("Runtime.evaluate", { expression: mountExpression, returnByValue: true, awaitPromise: true }, WEB_LOAD_TIMEOUT_MS + 12000);
    if (!mount || !mount.loaded) {
      const reason = !mount ? "web mount gave no answer" : "iframe load timeout";
      if (mount && mount.errors && mount.errors.length) log(`web ${current.source}: ${mount.errors.slice(0, 3).join(" | ")}`);
      const outcome = await command("Runtime.evaluate", { expression: fallbackExpression(reason, fallbackIndex), returnByValue: true, awaitPromise: true }, 12000);
      if (outcome) outcome.webErrors = (mount && mount.errors) || [];
      return outcome;
    }

    /* The frame is out of process, so both the prelude and the project's
       scripts run through a second CDP session attached to the iframe target
       (Page.addScriptToEvaluateOnNewDocument never reaches an OOPIF). Only a
       target whose window.name matches this mount's token is accepted:
       guessing could run a wallpaper's script inside Codex's own page. */
    const frameTarget = await findWebFrameTarget(found.port, built.token);
    const scriptErrors = [];
    if (!frameTarget) scriptErrors.push("script context unavailable");
    if (frameTarget) {
      try {
        await withPage(frameTarget, async (frameCommand, frameRaw) => {
          /* Installs the property/error bridge. Must run before the project's
             scripts so a listener they define is picked up lazily. */
          await frameCommand("Runtime.evaluate", { expression: webPreludeSource(built.token), returnByValue: false }, 8000);
          for (let index = 0; index < scriptCount; index += 1) {
            try {
              const evaluated = await frameRaw("Runtime.evaluate", { expression: built.scripts[index], returnByValue: false, awaitPromise: false }, 20000);
              if (evaluated && evaluated.exceptionDetails) scriptErrors.push("script-" + index + ": " + String(evaluated.exceptionDetails.exception?.description || evaluated.exceptionDetails.text || "error").slice(0, 180));
            } catch (error) {
              scriptErrors.push("script-" + index + ": " + String(error.message).slice(0, 180));
            }
          }
          if (Object.keys(propertyPayload).length) {
            try {
              const applied = await frameCommand("Runtime.evaluate", {
                expression: `(() => {
                  const payload = ${JSON.stringify(propertyPayload)};
                  const keys = Object.keys(payload);
                  const listener = window.wallpaperPropertyListener;
                  try {
                    if (listener && typeof listener.applyUserProperties === "function") listener.applyUserProperties(payload);
                    else if (typeof window.applyUserProperties === "function") window.applyUserProperties(payload);
                    else return { ok: false, via: "missing", keys: keys };
                  } catch (error) { return { ok: false, via: "throw", error: String(error && error.message || error), keys: keys }; }
                  return { ok: true, via: "listener", keys: keys };
                })()`,
                returnByValue: true,
                awaitPromise: false
              }, 8000);
              if (!applied || !applied.ok) scriptErrors.push("properties: " + JSON.stringify(applied));
            } catch (error) {
              scriptErrors.push("properties: " + String(error.message).slice(0, 180));
            }
          }
        });
      } catch (error) {
        scriptErrors.push("frame session: " + String(error.message).slice(0, 180));
      }
    }

    const reveal = await command("Runtime.evaluate", { expression: revealExpression, returnByValue: true, awaitPromise: true }, 12000);
    if (!reveal || !reveal.ok) {
      const outcome = await command("Runtime.evaluate", { expression: fallbackExpression("web reveal failed", fallbackIndex), returnByValue: true, awaitPromise: true }, 12000);
      return outcome;
    }
    if (scriptErrors.length) log(`web ${current.source}: script issues (${scriptErrors.slice(0, 4).join(" | ")})`);
    return { ok: true, renderMode: "web", source: current.source, scripts: scriptCount, inlineBytes: built.inlineBytes, webMs: mount.webMs, scriptErrors: scriptErrors.length, scriptErrorSample: scriptErrors.slice(0, 3), via: frameTarget ? "cdp-scripts" : "static" };
  });
  if (result) log(`web ${current.source}: renderMode=${result.renderMode}${result.webMs ? " webMs=" + result.webMs : ""}${result.scripts !== undefined ? " scripts=" + result.scripts : ""}${result.inlineBytes ? " inlineBytes=" + result.inlineBytes : ""}${result.via ? " via=" + result.via : ""}${result.scriptErrors !== undefined ? " scriptErrors=" + result.scriptErrors : ""}${result.webError ? " webError=" + String(result.webError).slice(0, 160) : ""}${result.error ? " error=" + String(result.error).slice(0, 160) : ""}`);
  return result;
}
async function installBackground(current) {
  const found = await findPage();
  if (!found) throw new Error("Codex main page disappeared");
  const media = mediaMeta(current.source);
  if (media.renderMode === "webgl") return await installSceneWebGL(found, current);
  if (media.renderMode === "web") return await installWebWallpaper(found, current);
  const installEpoch = selectEpoch;
  const isVideo = media.type.startsWith("video/");
  const videoAudio = libraryState().video || { audio: false, volume: 70 };
  const nativeRawChunk = 3 * 1024 * 1024;
  const result = await withPage(found.target, async command => {
    /* Preferred path: the page reads the media straight off disk through the
       file-backed Blob the DOM channel handed the hidden input, so the video or
       image is never copied through DevTools. The byte stream below is the
       fallback for when the DOM domain is unavailable. */
    const primed = await primeWallpaperFiles(command, [media.path]);
    const fileIndex = primed.ok ? primed.paths.indexOf(media.path) : -1;
    if (fileIndex < 0) {
      const mediaBytes = fs.statSync(media.path).size;
      log(`native ${current.source}: file channel unavailable (${primed.error || "unknown"}), streaming bytes`);
      await command("Runtime.evaluate", { expression: `${INGEST_HELPER}\nwindow.__codexWallpaperBytes = { bytes: new Uint8Array(${mediaBytes}), offset: 0 }; 0`, returnByValue: true });
      let nativeInjected = true;
      for (const chunk of base64ChunkSource(media.path, nativeRawChunk)) {
        if (selectEpoch !== installEpoch) { log(`install aborted (superseded during native injection): ${current.source}`); nativeInjected = false; break; }
        try { await command("Runtime.evaluate", { expression: `window.__codexIngest("__codexWallpaperBytes", ${JSON.stringify(chunk)})`, returnByValue: true, awaitPromise: true }); }
        catch (error) { log(`native inject failed for ${current.source}: ${error.message}`); nativeInjected = false; break; }
      }
      if (!nativeInjected) { await command("Runtime.evaluate", { expression: "window.__codexWallpaperBytes = null; 0", returnByValue: true }); return { ok: false, renderMode: "failed", source: current.source }; }
    } else {
      await command("Runtime.evaluate", { expression: "window.__codexWallpaperBytes = null; 0", returnByValue: true });
    }
    const via = fileIndex >= 0 ? "file" : "cdp";
    return await command("Runtime.evaluate", {
      expression: `${SWITCH_SOURCE}
(async () => {
        const loseGl = (el) => { try { const ctx = el && el.getContext ? (el.getContext("webgl2") || el.getContext("webgl")) : null; if (ctx && ctx.getExtension) { const ext = ctx.getExtension("WEBGL_lose_context"); if (ext) ext.loseContext(); } } catch {} };
        const previousLayers = () => ["codex-custom-background-base", "codex-custom-background-media"].map(id => document.getElementById(id)).filter(Boolean);
        const oldLayers = previousLayers();
        const previousInstance = window.__webwallglInstance;
        window.__webwallglInstance = null;
        document.getElementById("codex-custom-background-base-pending")?.remove();
        const fileIndex = ${JSON.stringify(fileIndex)};
        const AUDIO = ${JSON.stringify({ enabled: videoAudio.audio === true, volume: videoAudio.volume })};
        const mediaInput = document.getElementById(${JSON.stringify(FILE_INPUT_ID)});
        const mediaFile = mediaInput && mediaInput.files && fileIndex >= 0 ? mediaInput.files[fileIndex] : null;
        const bytes = window.__codexWallpaperBytes ? window.__codexWallpaperBytes.bytes : null;
        window.__codexWallpaperBytes = null;
        let objectUrl = null, byteLen = 0;
        if (mediaFile) { objectUrl = URL.createObjectURL(mediaFile); byteLen = mediaFile.size; }
        else if (bytes && bytes.length) { objectUrl = URL.createObjectURL(new Blob([bytes], { type: ${JSON.stringify(media.type)} })); byteLen = bytes.length; }
        else return { ok: false, renderMode: "failed", source: ${JSON.stringify(current.source)}, error: "no media bytes" };
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
        const applyStyleOnce = (id, text) => {
          const existing = document.getElementById(id);
          if (existing && existing.textContent === text) return;
          if (existing) existing.remove();
          const style = document.createElement("style");
          style.id = id;
          style.textContent = text;
          document.head.append(style);
        };
        /* One shared stylesheet text for every render path. The rules below match
           #root * across the whole app shell, so rewriting the sheet invalidates style
           for every node (~150-220ms on a busy transcript). Native and WebGL used to
           carry slightly different copies, so every native<->webgl switch rebuilt the
           sheet; with identical text applyStyleOnce leaves the existing node in place. */
        const BACKGROUND_STYLE_TEXT = [
          "html, body, #root, #root *, #root *::before, #root *::after { background: transparent !important; backdrop-filter: none !important; box-shadow: none !important; }",
          "#root { position: relative !important; z-index: 1 !important; min-height: 100vh !important; }",
          "#codex-custom-background-media { display: block !important; visibility: visible !important; }",
          "#codex-custom-background-base, #codex-custom-background-base-pending { display: block !important; visibility: visible !important; width: 100vw !important; height: 100vh !important; }",
          "#codex-custom-background-base canvas, #codex-custom-background-base-pending canvas { display: block !important; visibility: visible !important; width: 100vw !important; height: 100vh !important; }"
        ].join("\\n");
        const whenIdle = (fn, timeoutMs) => {
          const run = () => { try { fn(); } catch {} };
          try { if (typeof window.requestIdleCallback === "function") { window.requestIdleCallback(run, { timeout: timeoutMs }); return; } } catch {}
          setTimeout(run, timeoutMs);
        };
        applyStyleOnce("codex-custom-background-style", BACKGROUND_STYLE_TEXT);
        window.__lunaSwitchTransition(base, el, oldLayers, ${JSON.stringify(transitionFor())}, () => {
          for (const old of oldLayers) {
            if (!old || !old.isConnected || old === el || old === base) continue;
            const deadCanvas = old.querySelector ? old.querySelector("canvas") : null;
            const deadUrl = old.getAttribute ? old.getAttribute("data-object-url") : null;
            whenIdle(() => { try { if (deadCanvas) loseGl(deadCanvas); if (deadUrl) URL.revokeObjectURL(deadUrl); old.remove(); } catch {} }, 700);
          }
          if (previousInstance) whenIdle(() => { try { previousInstance.destroy && previousInstance.destroy(); } catch {} try { previousInstance.unmount && previousInstance.unmount(); } catch {} try { previousInstance.dispose && previousInstance.dispose(); } catch {} }, 1000);
        });
        if (${JSON.stringify(isVideo)}) {
          el.setAttribute("data-video-audio", AUDIO.enabled ? "on" : "off");
          el.volume = Math.max(0, Math.min(1, (Number(AUDIO.volume) || 0) / 100));
          const showAudioHint = () => {
            let hint = document.getElementById("codex-video-audio-hint");
            if (!hint) {
              hint = document.createElement("div");
              hint.id = "codex-video-audio-hint";
              hint.textContent = "🔊 点击页面一次以启用壁纸声音";
              hint.style.cssText = "position:fixed;right:18px;bottom:64px;z-index:99999;padding:8px 12px;border-radius:10px;background:rgba(12,20,32,.92);color:#dbeafe;font:600 12px/1.4 system-ui;pointer-events:none;box-shadow:0 6px 24px rgba(0,0,0,.4)";
              document.body.append(hint);
            }
            hint.style.display = "block";
            clearTimeout(window.__lunaAudioHintTimer);
            window.__lunaAudioHintTimer = setTimeout(() => { const node = document.getElementById("codex-video-audio-hint"); if (node) node.style.display = "none"; }, 8000);
            if (!window.__lunaAudioGestureBound) {
              window.__lunaAudioGestureBound = true;
              window.addEventListener("pointerdown", () => {
                const live = document.getElementById("codex-custom-background-media");
                if (live && live.tagName === "VIDEO" && live.muted) { live.muted = false; live.play().catch(() => {}); }
                const node = document.getElementById("codex-video-audio-hint"); if (node) node.style.display = "none";
              }, { capture: true, once: true });
            }
          };
          if (!AUDIO.enabled) {
            el.muted = true;
            el.play().catch(() => {});
          } else {
            /* Audible autoplay needs a user gesture. Try it first (a gesture may
               already have happened in this page), and fall back to muted
               playback plus one explicit hint rather than a hard failure. */
            el.muted = false;
            const attempt = el.play();
            if (attempt && typeof attempt.catch === "function") {
              attempt.catch(() => { el.muted = true; el.setAttribute("data-video-audio", "blocked"); el.play().catch(() => {}); showAudioHint(); });
            }
          }
        }
        return { bytes: byteLen, type: ${JSON.stringify(media.type)}, renderMode: ${JSON.stringify(media.renderMode)}, source: ${JSON.stringify(current.source)}, via: ${JSON.stringify(via)} };
      })()`,
      returnByValue: true,
      awaitPromise: true
    });
  });
  if (result && result.via) log(`native ${current.source}: renderMode=${result.renderMode} via=${result.via} bytes=${result.bytes}`);
  return result;
}

/* Quality monitoring. WebWallGL's adaptive controller only ever steps the
   post-processing tier down (onDowngrade over a 3s window below 85% of the
   frame cap) and never steps it back up. The facade's setQuality() does still
   re-apply a tier - it feeds the resolved options straight into the scene's
   effective-quality setter - so once the page has held >=85% of the cap for 5s
   the requested tier is re-applied. Measured on the live page: setQuality()
   moves postProcessing off->high and it holds; restore() (a surface rebuild)
   does NOT and in fact settles lower, so it is deliberately not used here.
   Attempts are cooldown-gated rather than once-per-mount so a scene downgraded
   again hours later can recover, and every attempt is logged and surfaced in
   /status. */
async function pageCommand(expression, timeoutMs = 20000) {
  const found = await findPage();
  if (!found) return null;
  try {
    return await withPage(found.target, command => command("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, timeoutMs));
  } catch {
    return null;
  }
}

async function pageEval(expression, timeoutMs = 20000) {
  const found = await findPage();
  if (!found) return null;
  return await withPage(found.target, command => command("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, timeoutMs));
}

/* Phase 4: push saved property values into whatever is live. Scenes take the
   simple { key: value } map through setProperties(); web wallpapers receive the
   Wallpaper Engine { key: { value } } payload over postMessage so the sandboxed
   frame never needs a same-origin bridge. */
async function applyWallpaperProperties(id, values) {
  const payload = values && typeof values === "object" && !Array.isArray(values) ? values : {};
  const item = listWallpapers().find(entry => entry.id === String(id));
  const hasDefs = !!(item && Array.isArray(item.properties) && item.properties.length);
  const expanded = hasDefs ? webPropertyPayload(item.properties, payload) : Object.fromEntries(Object.entries(payload).map(([key, value]) => [key, { value }]));
  /* The WebWallGL instance takes bare values, the sandboxed web frame takes
     the { key: { value } } envelope. */
  const normalised = hasDefs ? Object.fromEntries(Object.entries(expanded).map(([key, entry]) => [key, entry.value])) : payload;
  return await pageCommand(`(() => {
    const media = document.getElementById("codex-custom-background-media");
    const source = media && media.getAttribute("data-wallpaper-source");
    if (source && source !== ${JSON.stringify(String(id))}) return { ok: false, via: "not-current", source };
    const props = ${JSON.stringify(normalised)};
    if (media && media.tagName === "IFRAME" && media.getAttribute("data-render-mode") === "web" && media.contentWindow) {
      const expanded = ${JSON.stringify(expanded)};
      try { media.contentWindow.postMessage({ __lunaProps: expanded }, "*"); return { ok: true, via: "web" }; }
      catch (error) { return { ok: false, via: "web", error: String(error && error.message || error) }; }
    }
    const instance = window.__webwallglInstance;
    if (instance && typeof instance.setProperties === "function") {
      try { instance.setProperties(props); return { ok: true, via: "webgl" }; }
      catch (error) { return { ok: false, via: "webgl", error: String(error && error.message || error) }; }
    }
    return { ok: false, via: (media && media.getAttribute("data-render-mode")) || "none" };
  })()`);
}

/* Phase 4: native video audio. The setting lives in library.video so the picker
   can change it without a separate channel. */
async function applyVideoAudio(audio) {
  const settings = audio && typeof audio === "object" ? audio : { audio: false, volume: 70 };
  return await pageCommand(`(() => {
    const el = document.getElementById("codex-custom-background-media");
    if (!el || el.tagName !== "VIDEO") return { ok: false, via: el ? el.tagName : "none" };
    const enabled = ${JSON.stringify(settings.audio === true)};
    const volume = Math.max(0, Math.min(100, Number(${JSON.stringify(settings.volume)}) || 0));
    el.volume = Math.max(0, Math.min(1, volume / 100));
    el.muted = !enabled;
    el.setAttribute("data-video-audio", enabled ? "on" : "off");
    if (enabled) el.play().catch(() => { el.muted = true; el.setAttribute("data-video-audio", "blocked"); el.play().catch(() => {}); });
    else { const hint = document.getElementById("codex-video-audio-hint"); if (hint) hint.style.display = "none"; }
    return { ok: true, via: "video", muted: el.muted, volume: Math.round(el.volume * 100) };
  })()`);
}
/* Per-scene downgrade bookkeeping. A transition into the downgraded state is one
   event. Two events inside the settle window count as a loop, and so does a
   downgrade that lands after one of our re-applies - that is the library
   rejecting the tier we just pushed back on, and two rejections in a session
   mean the scene simply cannot hold it (the observed scene looped 40+ times).
   The rejection counter is deliberately not time-bounded: the library waits out
   the re-apply before dropping again, so a 10s window alone rarely catches it. */
function trackQualityScene(id, downgraded, now) {
  let scene = qualitySceneStats.get(id);
  if (!scene) { scene = { lastDowngraded: false, recent: [], transitions: 0, restores: 0, rejections: 0, cycles: 0, settled: false, settledAt: 0 }; qualitySceneStats.set(id, scene); }
  if (downgraded && !scene.lastDowngraded) {
    scene.transitions += 1;
    scene.recent.push(now);
    while (scene.recent.length && now - scene.recent[0] > QUALITY_SETTLE_WINDOW_MS) scene.recent.shift();
    if (scene.restores > scene.rejections) scene.rejections += 1;
    if (!scene.settled && (scene.recent.length >= 2 || scene.rejections >= 2)) {
      scene.settled = true;
      scene.settledAt = now;
      log(`quality settled for ${id}: ${scene.transitions} downgrade(s) this session (${scene.recent.length} within ${QUALITY_SETTLE_WINDOW_MS}ms, ${scene.rejections} after a re-apply); leaving the library tier as-is`);
    }
  }
  scene.lastDowngraded = downgraded;
  return scene;
}
async function attemptQualityRestore(current, effective, fps, scene) {
  const heldMs = qualityFpsWindow.length > 1 ? Math.round(Date.now() - qualityFpsWindow[0].t) : 0;
  const loud = !scene || scene.cycles === 1 || scene.cycles % QUALITY_DEGRADE_LOG_EVERY === 0;
  if (loud) log(`quality degraded on ${current.source}: postProcessing=${effective && effective.postProcessing} (aa=${effective && effective.antiAliasing} particles=${effective && effective.particles}); re-applying the requested tier after ${heldMs}ms at ${fps.toFixed(1)}fps`);
  const result = await pageEval(`(() => {
    const instance = window.__webwallglInstance;
    if (!instance || typeof instance.setQuality !== "function") return { outcome: "no-instance" };
    const requested = ${JSON.stringify(REQUESTED_QUALITY)};
    const before = instance.getQuality ? instance.getQuality() : null;
    if (before && !Object.keys(requested).some(key => before[key] !== requested[key])) return { outcome: "already-requested", before };
    try { instance.setQuality(requested); } catch (error) { return { outcome: "error", before, message: String(error && error.message || error).slice(0, 160) }; }
    const after = instance.getQuality ? instance.getQuality() : null;
    const restored = !!after && Object.keys(requested).every(key => after[key] === requested[key]);
    return { outcome: restored ? "restored" : "not-restored", before, after };
  })()`);
  if (loud) log(`quality re-apply ${JSON.stringify(result)}: ${current.source}`);
  return result;
}
let restoring = false;
let selectEpoch = 0;
/* Polling every 2s made every switch feel sluggish even after the scan cache
   landed; 800ms keeps the loop cheap and /select now wakes it instantly. */
let ticker = null;
function wakeTicker() { if (ticker) ticker(); }
function nextTick(delayMs = IDLE_TICK_MS) {
  return new Promise(resolve => {
    const timer = setTimeout(() => { ticker = null; resolve(); }, delayMs);
    ticker = () => { clearTimeout(timer); ticker = null; resolve(); };
  });
}
let controlsRunning = false;
let pickerRunning = false;
let appearanceRunning = false;
let appearanceLastError = null;
function launchControls() {
  controlsRunning = true;
  /* The panel is rebuilt after every wallpaper switch, so the saved dim and
     readability values ride along through the environment; without them the new
     panel would start at 100%/45% and overwrite what the user had chosen. */
  const child = spawn(process.execPath, [controlsScript], {
    windowsHide: true,
    cwd: root,
    stdio: "ignore",
    env: {
      ...process.env,
      LUNA_CONTROLS_STATE: JSON.stringify({
        backgroundOpacity: backgroundOpacityValue(),
        readability: readabilityState()
      })
    }
  });
  child.once("error", error => { controlsRunning = false; log(`controls error: ${error.message}`); });
  child.once("exit", code => { controlsRunning = false; log(code === 0 ? "readability controls restored" : `controls exited ${code}`); });
}
function launchPicker() {
  pickerRunning = true;
  const child = spawn(process.execPath, [pickerScript], { windowsHide: true, cwd: root, stdio: "ignore" });
  child.once("error", error => { pickerRunning = false; log(`picker error: ${error.message}`); });
  child.once("exit", code => { pickerRunning = false; log(code === 0 ? "wallpaper picker restored" : `picker exited ${code}`); });
}
function launchAppearance() {
  appearanceRunning = true;
  const child = spawn(process.execPath, [appearanceScript], { windowsHide: true, cwd: root, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  try { if (child.stderr) child.stderr.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-4000); }); } catch {}
  child.once("error", error => { appearanceRunning = false; appearanceLastError = "spawn failed: " + error.message; log(`appearance error: ${error.message}`); });
  child.once("exit", code => {
    appearanceRunning = false;
    if (code === 0) { appearanceLastError = null; log("appearance panel restored"); }
    else {
      appearanceLastError = `appearance exited ${code}${stderr.trim() ? ": " + stderr.trim().slice(-300) : ""}`;
      log(appearanceLastError);
    }
  });
}

try {
  await acquireServer();
} catch (error) {
  log(`another watchdog already owns :${lockPort} (${error.message}); exiting`);
  process.exit(0);
}
log(`watchdog started pid=${process.pid}`);
let lastWhite = null;
let lastPickerOpen = false;
let lastAppearanceRefresh = "";
/* Phase 2: rotation and the glass economy flag. rotationNextAt is epoch ms, so a
   config change simply rewrites it instead of restarting a timer object. */
let rotationNextAt = 0;
let rotationPending = null;
let rotationPendingAt = 0;
let lastRotationSwitchAt = 0;
const rotationFailed = new Map();
let lastLibraryRequest = "";
let libraryMirrorPending = false;
let appearanceMirrorPending = false;
let lastVideoAudio = "";
let lastHoverCommand = "";
let recentInteractionAt = 0;
let glassEconomy = null;
let lastEconomyPush = "";
let economyLowStreak = 0;
let economyHighSince = 0;
let uploadRun = null;
let prewarm = null;
let prewarmEpoch = 0;
let prewarmBusy = false;
let prewarmFlight = null;
const prewarmSizes = new Map();
const prewarmFailedAt = new Map();

/* Cheapest gate first: only a WebGL scene whose package is small enough to stage
   without fighting the visible wallpaper for the GPU can prewarm. */
function prewarmInfo(id) {
  if (!id || !/^\d+$/.test(id)) return null;
  const now = Date.now();
  if (now - (prewarmFailedAt.get(id) || 0) < PREWARM_FAIL_COOLDOWN_MS) return null;
  const memo = prewarmSizes.get(id);
  if (memo && now - memo.at < 20000) return memo.info;
  let info = null;
  try {
    const wallpaper = listWallpapers().find(item => item.id === id) || null;
    if (wallpaper && wallpaper.scene && mediaMeta(id).renderMode === "webgl") {
      const size = fs.statSync(wallpaper.scene).size;
      if (size > 0 && size <= PREWARM_MAX_BYTES) info = { scene: wallpaper.scene, size };
    }
  } catch { info = null; }
  prewarmSizes.set(id, { at: now, info });
  return info;
}

/* Release a staged scene: destroy the instance, drop its GL context and take the
   pending layer out of the DOM. The token check keeps a late drop from touching a
   newer prewarm or an install that already replaced the pending layer. */
function prewarmDropExpression(token) {
  return `(() => {
    if (window.__codexPrewarmToken !== ${JSON.stringify(token)}) return { ok: false, reason: "superseded" };
    window.__codexPrewarmToken = null;
    const pending = window.__codexPrewarm || null;
    window.__codexPrewarm = null;
    try {
      if (pending && pending.instance) {
        const inst = pending.instance;
        try { inst.destroy && inst.destroy(); } catch {}
        try { inst.unmount && inst.unmount(); } catch {}
        try { inst.dispose && inst.dispose(); } catch {}
      }
    } catch {}
    const el = document.getElementById("codex-custom-background-base-pending-hover");
    if (el) {
      try {
        const canvas = el.querySelector("canvas");
        const ctx = canvas && canvas.getContext ? (canvas.getContext("webgl2") || canvas.getContext("webgl")) : null;
        const ext = ctx && ctx.getExtension ? ctx.getExtension("WEBGL_lose_context") : null;
        if (ext) ext.loseContext();
      } catch {}
      try { el.remove(); } catch {}
    }
    return { ok: true };
  })()`;
}

function dropPrewarm(reason, target = prewarm) {
  if (!target) return;
  if (prewarm === target) prewarm = null;
  prewarmEpoch++;
  pageEval(prewarmDropExpression(target.token), 8000).catch(() => {});
  log(`prewarm dropped (${reason}): ${target.id}`);
}

function startPrewarm(id, info) {
  const token = id + "-" + Math.random().toString(36).slice(2, 10);
  const entry = { id, token, epoch: ++prewarmEpoch, status: "running", startedAt: Date.now(), result: null, promise: null, size: info.size };
  prewarm = entry;
  prewarmBusy = true;
  log(`prewarm start ${id} (${(info.size / 1048576).toFixed(1)}MB)`);
  const flight = (async () => {
    try {
      const found = await findPage();
      if (!found) throw new Error("Codex main page disappeared");
      const result = await installSceneWebGL(found, { source: id }, { prewarm: true, prewarmToken: token, cancelled: () => prewarm !== entry || entry.token !== token });
      if (prewarm !== entry) return;
      if (result && result.prewarmed) { entry.status = "ready"; entry.result = result; prewarmFailedAt.delete(id); log(`prewarm ready ${id} (mountMs=${result.mountMs} via=${result.via} pkgBytes=${result.pkgBytes})`); }
      else { entry.status = "failed"; prewarmFailedAt.set(id, Date.now()); entry.result = result; log(`prewarm failed ${id}: ${JSON.stringify(result).slice(0, 200)}`); }
    } catch (error) {

      entry.status = "failed";
      prewarmFailedAt.set(id, Date.now());
      log(`prewarm error ${id}: ${error.message}`);
      if (prewarm === entry) { prewarm = null; prewarmEpoch++; pageEval(prewarmDropExpression(token), 8000).catch(() => {}); }
    }
  })();
  entry.promise = flight;
  prewarmFlight = flight;
  flight.then(() => { if (prewarmFlight === flight) { prewarmBusy = false; prewarmFlight = null; } });
  return entry;
}

async function commitPrewarmSelection(current, staged) {
  try {
    const found = await findPage();
    if (!found) { log(`prewarm commit skipped for ${current.source}: page missing`); return false; }
    const committed = await installSceneWebGL(found, current, { commit: true, prewarmToken: staged.token });
    if (committed && committed.ok) { log(`background installed: ${current.source} (revealed from prewarm, revealMs=${committed.revealMs})`); return true; }
    log(`prewarm commit unavailable for ${current.source}: ${committed ? committed.reason : "no result"}`);
    return false;
  } catch (error) { log(`prewarm commit failed for ${current.source}: ${error.message}`); return false; }
}
/* ---------------- Phase 2 rotation ---------------- */
function pickRotationTarget(currentId, library) {
  const candidates = rotationCandidates(currentId, library);
  if (!candidates.length) {
    /* Everything was skipped: a stale failure list must not freeze rotation
       forever, so clear it and retry once. */
    if (rotationFailed.size) { rotationFailed.clear(); const retry = rotationCandidates(currentId, library); if (retry.length) return retry[0].id; }
    return "";
  }
  if (library.rotation.order === "random") return candidates[Math.floor(Math.random() * candidates.length)].id;
  const ordered = filterWallpapers(listWallpapers(), library, { showHidden: false });
  const index = ordered.findIndex(item => item.id === currentId);
  for (let step = 1; step <= ordered.length; step++) {
    const candidate = ordered[(index + step) % ordered.length];
    if (candidate && candidates.some(item => item.id === candidate.id)) return candidate.id;
  }
  return candidates[0].id;
}

/* Prepare-then-switch: stage the next scene in the hidden pending layer when it
   is cheap enough to prewarm, and fall back to the normal install (which already
   cross-fades) if the stage does not finish inside the bounded wait. */
async function rotateTo(id) {
  const item = listWallpapers().find(entry => entry.id === id);
  if (!item) return false;
  const next = { source: item.id, title: item.title };
  const info = prewarmInfo(id);
  if (info && !prewarm && !prewarmBusy) {
    const staged = startPrewarm(id, info);
    await Promise.race([staged.promise, wait(ROTATION_PREWARM_WAIT_MS)]);
    if (staged.status === "ready") {
      writeSelection(next.source, next.title);
      if (await commitPrewarmSelection(next, staged)) {
        prewarm = null;
        prewarmEpoch++;
        log("rotation switched " + id + " (prewarmed)");
        return true;
      }
    }
    if (prewarm === staged) dropPrewarm("rotation fallback", staged);
  }
  writeSelection(next.source, next.title);
  mediaCache.delete(next.source);
  log("rotation switched " + id);
  return true;
}

/* ---------------- Phase 2 library mirror ---------------- */
async function mirrorLibrary() {
  const payload = libraryPayload(libraryState(), listWallpapers(), { rotation: rotationState(), t: Date.now() });
  const json = JSON.stringify(JSON.stringify(payload));
  return await pageCommand('(() => { const host = document.getElementById("codex-wallpaper-picker"); if (!host) return false; host.dataset.library = ' + json + '; return true; })()');
}

/* ---------------- Phase 2 uploads ----------------
   The page can never read a path: it hands over the File the user picked, and the
   bytes are pulled in 2MB slices through the existing DevTools session and written
   here. Nothing crosses the network and the page CSP stays as it is. */
const UPLOAD_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".avif", ".mp4", ".webm", ".m4v", ".mov"]);
const UPLOAD_CHUNK_BYTES = 2 * 1024 * 1024;
const UPLOAD_MAX_BYTES = 2 * 1024 * 1024 * 1024;

async function uploadReport(state, message) {
  const payload = JSON.stringify(JSON.stringify({ state, message: message || "", t: Date.now() }));
  await pageCommand('(() => { const host = document.getElementById("codex-wallpaper-picker"); if (!host) return false; host.dataset.uploadStatus = ' + payload + '; return true; })()');
}

/* Removing an uploaded wallpaper never touches anything outside the uploads
   folder: the page can only name an id, and the file path is re-resolved here. */
async function handleUploadDelete(raw) {
  let cmd = null;
  try { cmd = JSON.parse(raw); } catch { return; }
  const id = String((cmd && cmd.id) || "");
  const deleteFile = cmd && cmd.deleteFile === true;
  const item = listWallpapers().find(entry => entry.id === id && entry.custom);
  if (!item || !item.file) { await uploadReport("info", "找不到该上传壁纸"); return; }
  const root = path.resolve(uploadsDir());
  const file = path.resolve(item.file);
  if (deleteFile) {
    if (file === root || !file.startsWith(root + path.sep)) { await uploadReport("info", "拒绝删除上传目录之外的文件"); return; }
    try { fs.unlinkSync(file); } catch (error) { log("upload delete failed " + id + ": " + error.message); await uploadReport("info", "文件删除失败：" + error.message); return; }
  }
  const current = libraryState();
  const tags = { ...current.contentTags };
  delete tags[id];
  writeLibrary({ ...current, hidden: current.hidden.filter(entry => entry !== id), contentTags: tags });
  invalidateWallpaperCache();
  mediaCache.clear();
  prewarmSizes.clear();
  log("upload removed " + id + (deleteFile ? " (file deleted)" : " (file kept)"));
  await uploadReport("info", deleteFile ? "已删除壁纸和文件" : "已移出列表（文件保留）");
  await mirrorLibrary();
}

async function handleUpload(raw) {
  if (uploadRun) { log("upload ignored: another upload is still running"); return; }
  let meta = null;
  try { meta = JSON.parse(raw); } catch { return; }
  const name = String((meta && meta.name) || "").trim();
  const size = Number((meta && meta.size) || 0);
  const ext = path.extname(name).toLowerCase();
  if (!name || !UPLOAD_EXTENSIONS.has(ext)) { log("upload rejected: unsupported file " + (name || "(unnamed)")); await uploadReport("error", "不支持的格式（JPG/PNG/WEBP/MP4/WEBM）"); return; }
  if (!(size > 0) || size > UPLOAD_MAX_BYTES) { log("upload rejected: bad size " + size); await uploadReport("error", "文件为空或超过 2GB"); return; }

  uploadRun = { name, size, done: 0 };
  const safeName = name.replace(/[\\/:*?"<>|]/g, "_").slice(-120) || "wallpaper";
  let dest = null;
  try {
    const dir = uploadsDir();
    fs.mkdirSync(dir, { recursive: true });
    dest = path.join(dir, Date.now() + "_" + safeName);
    const fd = fs.openSync(dest, "w");
    try {
      for (let offset = 0; offset < size; offset += UPLOAD_CHUNK_BYTES) {
        const end = Math.min(size, offset + UPLOAD_CHUNK_BYTES);
        const expression = '(async () => {' +
          ' const up = window.__lunaUpload;' +
          ' if (!up || !up.file) return null;' +
          ' const buffer = await up.file.slice(' + offset + ', ' + end + ').arrayBuffer();' +
          ' const bytes = new Uint8Array(buffer);' +
          ' if (typeof bytes.toBase64 === "function") return bytes.toBase64();' +
          ' let binary = "";' +
          ' for (let index = 0; index < bytes.length; index += 8192) binary += String.fromCharCode.apply(null, bytes.subarray(index, index + 8192));' +
          ' return btoa(binary);' +
          ' })()';
        const b64 = await pageCommand(expression, 60000);
        if (!b64) throw new Error("page lost the upload file");
        fs.writeSync(fd, Buffer.from(b64, "base64"));
        uploadRun.done = end;
      }
    } finally { fs.closeSync(fd); }
    invalidateWallpaperCache();
    mediaCache.clear();
    log("upload saved: " + path.basename(dest) + " (" + (size / 1048576).toFixed(1) + "MB)");
    await uploadReport("done");
    await mirrorLibrary();
  } catch (error) {
    if (dest) { try { fs.unlinkSync(dest); } catch {} }
    log("upload failed: " + error.message);
    await uploadReport("error", error.message);
  } finally {
    uploadRun = null;
    await pageCommand('(() => { try { window.__lunaUpload = null; } catch {} return true; })()');
  }
}
/* Avatar/mascot images: much smaller than a wallpaper, same page-side hand-off.
   The file lands in uploads/ with a typed prefix so the wallpaper library can skip
   it (see wallpaper-library.mjs) and prefs only stores the basename. */
const IMAGE_KINDS = new Set(["avatar", "mascot"]);
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const IMAGE_MAX_BYTES = 3 * 1024 * 1024;

async function imageReport(state, message) {
  const payload = JSON.stringify(JSON.stringify({ state, message: message || "", t: Date.now() }));
  await pageCommand('(() => { const host = document.getElementById("codex-appearance-panel"); if (!host) return false; host.dataset.imageStatus = ' + payload + '; return true; })()');
}

async function handleImageUpload(raw) {
  if (uploadRun) { log("image upload ignored: another upload is still running"); return; }
  let cmd = null;
  try { cmd = JSON.parse(raw); } catch { return; }
  const kind = String((cmd && cmd.kind) || "");
  if (!IMAGE_KINDS.has(kind)) { await imageReport("error", "未知图片类型"); return; }
  const current = appearanceState();
  current.ext.avatar.image = "";
  current.ext.mascot.image = "";
  if (cmd && cmd.clear === true) {
    current.ext[kind].file = "";
    current.ext[kind].image = "";
    writeAppearance(current);
    appearanceMirrorPending = true;
    log("appearance " + kind + " image cleared");
    await imageReport("done", "已清除");
    return;
  }
  const name = String((cmd && cmd.name) || "").trim();
  const size = Number((cmd && cmd.size) || 0);
  const ext = path.extname(name).toLowerCase();
  if (!name || !IMAGE_EXTENSIONS.has(ext)) { log("image upload rejected: unsupported file " + (name || "(unnamed)")); await imageReport("error", "仅支持 PNG/JPG/WEBP"); return; }
  if (!(size > 0) || size > IMAGE_MAX_BYTES) { log("image upload rejected: bad size " + size); await imageReport("error", "图片为空或超过 3MB"); return; }

  uploadRun = { name, size, done: 0, image: true };
  let dest = null;
  try {
    const dir = uploadsDir();
    fs.mkdirSync(dir, { recursive: true });
    const base = kind + "_" + Date.now() + (ext === ".jpeg" ? ".jpg" : ext);
    dest = path.join(dir, base);
    const fd = fs.openSync(dest, "w");
    try {
      for (let offset = 0; offset < size; offset += UPLOAD_CHUNK_BYTES) {
        const end = Math.min(size, offset + UPLOAD_CHUNK_BYTES);
        const expression = '(async () => {' +
          ' const up = window.__lunaUpload;' +
          ' if (!up || !up.file) return null;' +
          ' const buffer = await up.file.slice(' + offset + ', ' + end + ').arrayBuffer();' +
          ' const bytes = new Uint8Array(buffer);' +
          ' if (typeof bytes.toBase64 === "function") return bytes.toBase64();' +
          ' let binary = "";' +
          ' for (let index = 0; index < bytes.length; index += 8192) binary += String.fromCharCode.apply(null, bytes.subarray(index, index + 8192));' +
          ' return btoa(binary);' +
          ' })()';
        const b64 = await pageCommand(expression, 60000);
        if (!b64) throw new Error("page lost the image file");
        fs.writeSync(fd, Buffer.from(b64, "base64"));
      }
    } finally { fs.closeSync(fd); }
    current.ext[kind].file = path.basename(dest);
    current.ext[kind].image = "";
    writeAppearance(current);
    appearanceMirrorPending = true;
    log("appearance " + kind + " image saved: " + path.basename(dest) + " (" + (size / 1024).toFixed(0) + "KB)");
    await imageReport("done", "已保存 " + path.basename(dest));
  } catch (error) {
    if (dest) { try { fs.unlinkSync(dest); } catch {} }
    log("image upload failed: " + error.message);
    await imageReport("error", error.message);
  } finally {
    uploadRun = null;
    await pageCommand('(() => { try { window.__lunaUpload = null; } catch {} return true; })()');
  }
}

for (;;) {
  let tickDelay = IDLE_TICK_MS;
  try {
    let current = selection();
    const preference = prefs();
    const state = await status();
    const pickerVisibilityChanged = !!(state && state.pickerOpen) !== lastPickerOpen;
    const hoverCommand = (state && state.hoverCommand) || "";
    const hoverChanged = !!hoverCommand && hoverCommand !== lastHoverCommand;
    if (state && state.page && (state.pickerCommand || pickerVisibilityChanged || hoverChanged)) recentInteractionAt = Date.now();
    lastHoverCommand = hoverCommand;
    if (state && state.page) {
      const recent = Date.now() - recentInteractionAt < RECENT_WINDOW_MS;
      tickDelay = state.pickerOpen ? PREWARM_TICK_MS : recent ? RECENT_TICK_MS : IDLE_TICK_MS;
    }
    let pickerPicked = "";
    if (state.page && state.pickerCommand && /^\d+$/.test(state.pickerCommand)) {
      const wallpaper = listWallpapers().find(item => item.id === state.pickerCommand);
      if (wallpaper) { writeSelection(wallpaper.id, wallpaper.title); mediaCache.delete(wallpaper.id); log(`picker selected ${wallpaper.id}`); pickerPicked = wallpaper.id; }
      /* The selection was read before the command was handled, so re-read it:
         otherwise this tick still compares against the old wallpaper and the
         install only starts on the next full tick - the invisible 800ms wait. */
      current = selection();
    }
    /* Reset state: no wallpaper until the user (or a tool) picks one again. */
    const disabled = current.disabled === true;
    if (state.page && !!state.pickerOpen !== lastPickerOpen) {
      lastPickerOpen = !!state.pickerOpen;
      if (lastPickerOpen) { invalidateWallpaperCache(); mediaCache.clear(); prewarmSizes.clear(); log("picker opened: wallpaper library cache invalidated"); }
    }
    if (state.page && state.imageReady) await handleImageUpload(state.imageReady);
    if (state.page && state.appearanceCommand) {
      try {
        const parsed = JSON.parse(state.appearanceCommand);
        const saved = writeAppearance(parsed && parsed.appearance !== undefined ? parsed.appearance : parsed);
        log(`appearance prefs saved via panel (preset=${saved.activePreset}, glass=${saved.glass.enabled})`);
      } catch (error) { appearanceLastError = "appearance command rejected: " + error.message; log(appearanceLastError); }
    }
    if (state.page && (state.appearanceRefresh !== lastAppearanceRefresh || appearanceMirrorPending || pendingMirrors.appearance)) {
      lastAppearanceRefresh = state.appearanceRefresh || "";
      appearanceMirrorPending = false;
      pendingMirrors.appearance = false;
      /* Mirror the saved state back so the panel can honour "read on open" and a
         freshly uploaded avatar/mascot shows up without a reload. */
      const mirror = JSON.stringify({ t: Date.now(), appearance: appearanceState() });
      await pageCommand(`(() => { const host = document.getElementById("codex-appearance-panel"); if (!host) return false; host.dataset.prefs = ${JSON.stringify(mirror)}; return true; })()`);
    }
    /* ---- Phase 2: picker library channel ---- */
    if (state.page && state.libraryCommand) {
      try {
        const parsed = JSON.parse(state.libraryCommand);
        const saved = writeLibrary(parsed && parsed.library !== undefined ? parsed.library : parsed);
        log("library state saved via picker (hidden=" + saved.hidden.length + " types=" + (saved.filters.types.join("+") || "all") + " tag=" + saved.filters.tag + " rotation=" + saved.rotation.enabled + ")");
        libraryMirrorPending = true;
        if (!saved.rotation.enabled) { rotationNextAt = 0; rotationPending = null; }
        else if (!rotationNextAt) rotationNextAt = Date.now() + saved.rotation.intervalSec * 1000;
      } catch (error) { log("library command rejected: " + error.message); }
    }
    /* ---- Phase 4: per-wallpaper properties ---- */
    if (state.page && state.propsCommand) {
      try {
        const parsed = JSON.parse(state.propsCommand);
        const id = String(parsed && parsed.id || "");
        const values = parsed && parsed.props && typeof parsed.props === "object" && !Array.isArray(parsed.props) ? parsed.props : null;
        if (!id || !values) throw new Error("expected {id, props}");
        const currentLibrary = libraryState();
        writeLibrary({ ...currentLibrary, props: { ...currentLibrary.props, [id]: values } });
        libraryMirrorPending = true;
        const applied = await applyWallpaperProperties(id, values);
        log(`wallpaper props saved for ${id} (${applied && applied.ok ? "applied via " + applied.via : "not applied: " + ((applied && applied.via) || "no page")})`);
      } catch (error) { log("props command rejected: " + error.message); }
    }
    if (state.page && (state.libraryRequest !== lastLibraryRequest || libraryMirrorPending || pendingMirrors.library)) {
      lastLibraryRequest = state.libraryRequest || "";
      libraryMirrorPending = false;
      pendingMirrors.library = false;
      await mirrorLibrary();
    }
    if (state.page && state.uploadReady) await handleUpload(state.uploadReady);
    if (state.page && state.uploadDelete) await handleUploadDelete(state.uploadDelete);
    /* ---- readability panel channel ----
       The panel is rebuilt on every switch, so its values are saved here and fed
       back in through launchControls(). A value equal to the stored one is a
       no-op (the panel announces its initial state once on injection). */
    if (state.page && state.controlsCommand) {
      try {
        const parsed = JSON.parse(state.controlsCommand);
        const patch = {};
        if (parsed && parsed.backgroundOpacity !== undefined) {
          const percent = backgroundOpacityValueFor(parsed.backgroundOpacity);
          if (percent !== null && percent !== backgroundOpacityValue()) {
            patch.backgroundOpacity = percent;
            if (percent !== 100) { try { await applyBackgroundOpacity(percent); } catch {} }
            else { try { await pageCommand('document.getElementById("codex-background-opacity-style")?.remove(); true'); } catch {} }
          }
        }
        if (parsed && parsed.readability && typeof parsed.readability === "object") {
          const current = readabilityState();
          const percent = Number(parsed.readability.percent);
          const mode = READABILITY_MODES.includes(parsed.readability.mode) ? parsed.readability.mode : current.mode;
          const next = {
            percent: Number.isFinite(percent) ? Math.min(100, Math.max(0, Math.round(percent))) : current.percent,
            mode
          };
          if (next.percent !== current.percent || next.mode !== current.mode) patch.readability = next;
        }
        if (Object.keys(patch).length) writePrefs(patch);
      } catch (error) { log("controls command rejected: " + error.message); }
    }

    /* ---- Phase 2: auto rotation ---- */
    let rotationTargetFromRotation = "";
    const library = libraryState();
    const audioKey = (library.video && library.video.audio ? "1" : "0") + ":" + (library.video ? library.video.volume : 70);
    if (state.page && audioKey !== lastVideoAudio) {
      lastVideoAudio = audioKey;
      const audioApplied = await applyVideoAudio(library.video || { audio: false, volume: 70 });
      if (audioApplied && audioApplied.ok) log(`video audio ${library.video && library.video.audio ? "on" : "off"} volume=${library.video ? library.video.volume : 70}`);
    }
    if (!library.rotation.enabled) {
      rotationNextAt = 0;
      rotationPending = null;
    } else {
      if (!rotationNextAt) rotationNextAt = Date.now() + library.rotation.intervalSec * 1000;
      if (pickerPicked) {
        /* A manual pick resets the timer instead of stopping rotation: the user
           asked for this wallpaper now, not for the slideshow to end. */
        rotationNextAt = Date.now() + library.rotation.intervalSec * 1000;
        rotationPending = null;
        log("rotation timer reset by manual pick");
      } else if (!restoring && !disabled && state.page && state.visibility === "visible" && !state.pickerOpen && Date.now() >= rotationNextAt) {
        const targetId = pickRotationTarget(current.source, library);
        if (targetId) {
          log("rotation -> " + targetId + " (order=" + library.rotation.order + ", candidates=" + rotationCandidates(current.source, library).length + ")");
          await rotateTo(targetId);
          current = selection();
          lastRotationSwitchAt = Date.now();
          rotationTargetFromRotation = targetId;
        } else {
          log("rotation skipped: no candidate matches the current filters");
        }
        rotationNextAt = Date.now() + library.rotation.intervalSec * 1000;
      }
    }
    /* Reconcile against the page itself, not a cached flag. lastWhite assumed the
       page could only change through this loop, so anything else touching the
       sheet (a re-injection, a script, a leftover from an older build) desynced
       white text permanently: the flag said "already applied" while the page
       disagreed. /status already reports state.whiteText, so this costs nothing. */
    if (state.page) {
      if (preference.whiteText && !state.whiteText) { await applyWhiteText(); lastWhite = true; }
      else if (!preference.whiteText && state.whiteText) { await removeWhiteText(); lastWhite = false; }
    } else { lastWhite = null; }
    if (state.page && state.deferredUpgrade) { lastDeferredUpgrade = state.deferredUpgrade; log(`deferred webgl upgrade ${current.source}: result=${state.deferredUpgrade.result}${state.deferredUpgrade.lastDiag ? " lastDiag=" + String(state.deferredUpgrade.lastDiag).slice(0, 160) : ""}`); }
    if (!current.source) { await wait(5000); continue; }

    /* WebGL context loss. The page-side guard rebuilds the scene in place and
       reports the outcome through __codexContextEvents / __codexContextLost;
       log every event, and if the page-side repair did not take within the
       grace window, remount the selection here. */
    if (state.page && Array.isArray(state.contextEvents) && state.contextEvents.length) {
      for (const event of state.contextEvents) log(`webgl context ${event.kind}${event.source ? " source=" + event.source : ""}${event.message ? " (" + String(event.message).slice(0, 160) + ")" : ""}`);
    }
    let contextRecovery = false;
    if (state.page && state.contextLost) {
      const now = Date.now();
      if (!contextLostSeenAt) { contextLostSeenAt = now; log(`context loss reported for ${current.source}; waiting ${CONTEXT_REMOUNT_GRACE_MS}ms for the page-side rebuild before remounting`); }
      if (now - contextLostSeenAt >= CONTEXT_REMOUNT_GRACE_MS && now - lastContextRemount >= CONTEXT_REMOUNT_COOLDOWN_MS) {
        lastContextRemount = now;
        if (contextRemounts < CONTEXT_REMOUNT_MAX) {
          contextRemounts += 1;
          contextRecovery = true;
          log(`context loss not repaired in the page: remounting ${current.source} (attempt ${contextRemounts}/${CONTEXT_REMOUNT_MAX})`);
        } else {
          log(`context loss still reported for ${current.source} but the remount budget is exhausted; leaving the page as-is`);
        }
      }
    } else if (contextLostSeenAt || contextRemounts > 0) {
      contextLostSeenAt = 0;
      if (state.page && state.background && state.source === current.source) contextRemounts = 0;
    }

    /* Adaptive quality only steps down in the library, so re-apply the
       requested tier once the page has been comfortably fast for a while. A
       rolling window is used instead of "N consecutive samples above the bar"
       because a borderline scene crosses the threshold every few samples, which
       keeps resetting a consecutive timer and leaves the scene degraded forever
       - the exact complaint this fixes. When the window averages at or above
       85% of the cap for 5s the tier goes back on; a cooldown bounds how often
       that can happen. */
    if (state.page && state.quality && state.qualityRequested) {
      if (qualityBackoffMountSeq !== state.mountSeq) { qualityBackoffMountSeq = state.mountSeq; qualityBackoff = QUALITY_RESTORE_COOLDOWN_MS; }
      const downgraded = ["antiAliasing", "particles", "postProcessing"].some(key => state.quality[key] !== state.qualityRequested[key]);
      const stats = state.stats || null;
      const fps = stats && Number.isFinite(stats.fps) ? stats.fps : null;
      const busy = !stats || stats.occluded === true || stats.running === false;
      const qualityScene = trackQualityScene(current.source, downgraded, Date.now());
      lastQuality = { requested: state.qualityRequested, effective: state.quality, downgraded, fps: fps === null ? null : Math.round(fps * 10) / 10, sceneFps: QUALITY_SCENE_FPS, mountSeq: state.mountSeq, secondsSinceRestore: lastQualityRestoreAt ? Math.round((Date.now() - lastQualityRestoreAt) / 1000) : null, settledForScene: !!qualityScene.settled, sceneDegrades: qualityScene.transitions };
      if (!downgraded || busy || fps === null || state.visibility !== "visible") {
        qualityFpsWindow.length = 0;
      } else {
        const now = Date.now();
        qualityFpsWindow.push({ t: now, fps });
        while (qualityFpsWindow.length && now - qualityFpsWindow[0].t > QUALITY_FPS_WINDOW_MS) qualityFpsWindow.shift();
        const avgFps = qualityFpsWindow.reduce((sum, sample) => sum + sample.fps, 0) / qualityFpsWindow.length;
        const heldMs = qualityFpsWindow.length > 1 ? now - qualityFpsWindow[0].t : 0;
        lastQuality.avgFps = Math.round(avgFps * 10) / 10;
        lastQuality.samples = qualityFpsWindow.length;
        if (!restoring && !qualityScene.settled && heldMs >= QUALITY_RESTORE_HOLD_MS && qualityFpsWindow.length >= QUALITY_FPS_MIN_SAMPLES && avgFps >= QUALITY_SCENE_FPS * QUALITY_RESTORE_RATIO && now - lastQualityRestoreAt >= qualityBackoff) {
          /* Thrash guard: a scene sitting right on the frame cap will be
             downgraded again immediately after the tier goes back on. Every
             re-apply that did not hold for a minute doubles the wait, so a
             borderline scene settles into a slow cadence instead of flickering
             between tiers. A scene that holds the tier resets it to the floor. */
          const sinceLast = lastQualityRestoreAt ? now - lastQualityRestoreAt : Infinity;
          qualityBackoff = sinceLast < QUALITY_HOLD_MIN_MS ? Math.min(qualityBackoff * 2, QUALITY_RESTORE_MAX_COOLDOWN_MS) : QUALITY_RESTORE_COOLDOWN_MS;
          lastQualityRestoreAt = now;
          lastQuality.cooldownMs = qualityBackoff;
          qualityScene.cycles += 1;
          qualityScene.restores += 1;
          try { lastQuality.reapplied = await attemptQualityRestore(current, state.quality, avgFps, qualityScene); } catch (error) { log(`quality re-apply failed: ${error.message}`); }
          qualityFpsWindow.length = 0;
        }
      }
    } else {
      /* No live WebGL instance (native wallpaper, or no page): drop the stale
         reading so /status does not report a tier for a background that has no
         WebGL post-processing at all. */
      qualityFpsWindow.length = 0;
      lastQuality = null;
    }

    /* ---- Phase 2: glass economy over WebGL ----
       backdrop-filter over a live canvas is a per-frame composite pass; measured
       here the full glass set costs ~9.5fps and the conversation surface alone
       accounts for ~7 of it (34.2 -> 24.7 -> 31.5 fps). When the scene cannot hold
       85% of the frame cap the conversation face drops only its blur pass: the
       tint, border and radius stay, so the user's glass stays visibly on. */
    const webglActive = state.page && !!state.quality;
    const fpsNow = state.stats && Number.isFinite(state.stats.fps) ? state.stats.fps : null;
    if (!webglActive) {
      economyLowStreak = 0;
      economyHighSince = 0;
      glassEconomy = false;
    } else if (state.visibility === "visible" && fpsNow !== null) {
      if (fpsNow < QUALITY_SCENE_FPS * 0.85) {
        economyLowStreak += 1;
        economyHighSince = 0;
        if (economyLowStreak >= 3 && glassEconomy !== true) {
          glassEconomy = true;
          log("glass economy on (WebGL fps " + fpsNow.toFixed(1) + " < 51): conversation blur skipped, tint and border kept");
        }
      } else if (fpsNow >= QUALITY_SCENE_FPS * 0.95) {
        economyLowStreak = 0;
        if (glassEconomy === true) {
          if (!economyHighSince) economyHighSince = Date.now();
          else if (Date.now() - economyHighSince >= 10000) { glassEconomy = false; economyHighSince = 0; log("glass economy off (WebGL fps " + fpsNow.toFixed(1) + " held for 10s)"); }
        }
      } else {
        economyLowStreak = 0;
        economyHighSince = 0;
      }
    }
    const economyFlag = glassEconomy ? "1" : "0";
    if (state.page && lastEconomyPush !== economyFlag) {
      lastEconomyPush = economyFlag;
      await pageCommand('(() => { const host = document.getElementById("codex-appearance-panel"); if (!host) return false; host.dataset.economy = "' + economyFlag + '"; const api = window.__lunaAppearance; if (api && api.refresh) api.refresh(); return true; })()');
    }
    /* ---- hover prewarm ----
       A row has to be hovered before it can be clicked, so the mount is staged in
       the hidden pending layer while the user aims; the click then only pays the
       cross-fade. Anything that changes the intent (another row, the panel
       closing, a different wallpaper being picked) drops the staged scene and
       releases its GL context. */
    let prewarmCommitted = false;
    const staged = prewarm;
    const hoverId = state.page && state.pickerOpen && /^\d+$/.test(state.hoverCommand || "") ? state.hoverCommand : "";
    const wantPrewarm = !pickerPicked && state.page && state.pickerOpen && state.visibility === "visible" && hoverId && hoverId !== current.source && prewarmInfo(hoverId) ? hoverId : "";
    if (pickerPicked && staged && staged.id === pickerPicked) {
      /* A prewarm must never make the click slower than having none: only a
         fresh stage is waited for, only for a bounded window, and anything
         failed or stale is dropped so the install starts on this same tick. */
      const stagedAge = Date.now() - staged.startedAt;
      if (staged.status === "running" && stagedAge <= PREWARM_READY_WINDOW_MS) { try { await Promise.race([staged.promise, wait(PREWARM_CLICK_WAIT_MS)]); } catch {} }
      if (staged.status === "ready") {
        prewarmCommitted = await commitPrewarmSelection(current, staged);
        if (prewarmCommitted) { prewarm = null; prewarmEpoch++; }
        else dropPrewarm("commit failed", staged);
      } else {
        log(`prewarm for ${pickerPicked} not usable (status=${staged.status}, ageMs=${stagedAge}); installing normally`);
        dropPrewarm("not ready", staged);
      }
    } else if (staged && staged.id !== wantPrewarm) {
      dropPrewarm(wantPrewarm ? "hover moved to another wallpaper" : "hover left or the panel closed", staged);
    }
    if (wantPrewarm && !prewarm && !prewarmBusy && !restoring && !pickerPicked) {
      const info = prewarmInfo(wantPrewarm);
      if (info) startPrewarm(wantPrewarm, info);
    }

    const needsBackground = state.page && !disabled && !prewarmCommitted && (contextRecovery || !state.background || !state.base || state.source !== current.source);
    /* A controls panel injected by an older build keeps running its old logic
       forever otherwise (that is how a 5% dim survived a fix). Re-inject once when
       the build id changes. */
    const controlsStale = state.page && (state.controls || state.readability) && state.controlsBuild !== CONTROLS_BUILD;
    const needsControls = state.page && !disabled && (!state.readability || !state.controls || controlsStale);
    const needsPicker = state.page && !state.picker;
    const needsAppearance = state.page && (!state.appearance || state.appearanceBuild !== APPEARANCE_BUILD);
    if (!restoring && (needsBackground || (needsControls && !controlsRunning) || (needsPicker && !pickerRunning) || (needsAppearance && !appearanceRunning))) {
      restoring = true;
      const installSafety = setTimeout(() => { if (restoring) { log(`install forced-reset (over 180s): ${current.source}`); restoring = false; } }, 180000);
      try {
        if (needsBackground) {
          const bgResult = await installBackground(current);
          if (bgResult && bgResult.renderMode === "aborted") log(`install aborted (superseded): ${current.source}`);
          else {
            log(`background installed: ${current.source}`);
            /* Every install builds fresh layers, which drop the dimming style;
               re-apply the saved override so a switch keeps the chosen opacity.
               With no saved override the stale sheet (and the 5% dim an older
               build could leave behind) is removed instead. */
            try { await applyBackgroundOpacity(backgroundOpacityValue()); } catch {}
            if (rotationTargetFromRotation && bgResult && bgResult.ok === false) {
              rotationFailed.set(current.source, Date.now());
              log(`rotation candidate ${current.source} failed; skipped for 10 minutes`);
              rotationNextAt = Date.now() + ROTATION_RETRY_MS;
            }
          }
        }
        if (needsBackground || needsControls) launchControls();
        if (needsAppearance) launchAppearance();
        if (needsPicker) launchPicker();
      } catch (error) { log(`restore error: ${error.message}`); mediaCache.delete(current.source); }
      finally { clearTimeout(installSafety); restoring = false; }
    }

    /* Release the picker gate once the picked wallpaper is live. Without this the
       first click of a session would suppress every later hover prewarm. */
    if (pickerPicked && !restoring && state.background && state.base && state.source === pickerPicked) pickerPicked = '';
  } catch (error) { log(`error: ${error.message}`); }
  await nextTick(tickDelay);
}
