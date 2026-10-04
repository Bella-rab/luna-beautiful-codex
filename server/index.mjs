#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { listWallpapers as scanWallpapers, resolveWallpaperMedia } from "./wallpaper-library.mjs";

const manifest = JSON.parse(readFileSync(path.join(import.meta.dirname, "..", ".codex-plugin", "plugin.json"), "utf8"));
const pluginVersion = manifest.version;
const WATCHDOG_SCRIPT = path.join(import.meta.dirname, "codex-wallpaper-watchdog.mjs");
const MAX_MEDIA_BYTES = 120 * 1024 * 1024;
const MEDIA_TYPES = new Map([
  [".mp4", "video/mp4"],
  [".m4v", "video/mp4"],
  [".webm", "video/webm"],
  [".mov", "video/quicktime"],
  [".gif", "image/gif"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".png", "image/png"],
  [".webp", "image/webp"],
  [".avif", "image/avif"]
]);

function filteredWallpapers(search) {
  const wallpapers = scanWallpapers();
  if (!search) return wallpapers;
  const needle = String(search).toLowerCase();
  return wallpapers.filter(item => item.title.toLowerCase().includes(needle) || item.id.includes(needle));
}

async function loadMedia(source) {
  if (/^https?:\/\//i.test(source)) {
    const response = await fetch(source);
    if (!response.ok) throw new Error(`Media request failed: ${response.status} ${response.statusText}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    const contentType = response.headers.get("content-type") || "";
    const type = contentType.split(";")[0].toLowerCase();
    const ext = path.extname(new URL(source).pathname).toLowerCase();
    return { buffer, type: MEDIA_TYPES.get(ext) || type || "application/octet-stream" };
  }

  const resolved = resolveWallpaperMedia(source);
  const filePath = resolved.path;
  if (!existsSync(filePath) || !statSync(filePath).isFile()) throw new Error(`Media file not found: ${source}`);
  const info = statSync(filePath);
  if (info.size > MAX_MEDIA_BYTES) throw new Error(`Media is larger than 120 MB: ${info.size} bytes`);
  return { buffer: readFileSync(filePath), type: resolved.type, filePath };
}

async function findDevTools() {
  for (let port = 9229; port <= 9239; port++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(800) });
      if (!response.ok) continue;
      const targets = await response.json();
      const target = targets.find(item => item.type === "page" && item.url === "app://-/index.html");
      if (target) return { target, port };
    } catch {}
  }
  throw new Error("Codex DevTools endpoint not found. Open Codex Desktop and try again.");
}

class CodexPage {
  constructor(target) {
    this.socket = new WebSocket(target.webSocketDebuggerUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.socket.onmessage = event => {
      const message = JSON.parse(event.data);
      if (!message.id || !this.pending.has(message.id)) return;
      const waiter = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result);
    };
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.socket.onopen = resolve;
      this.socket.onerror = () => reject(new Error("Unable to connect to Codex DevTools"));
      setTimeout(() => reject(new Error("Codex DevTools connection timed out")), 5000);
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP command timed out: ${method}`));
        }
      }, 30000);
    });
  }

  async evaluate(expression, awaitPromise = false) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    }
    return result.result?.value;
  }

  close() {
    this.socket.close();
  }
}

function boundedNumber(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, number));
}

function backgroundCss(backgroundOpacity, surfaceOpacity, blur) {
  if (surfaceOpacity === 0 && blur === 0) {
    return [
      "html, body, #root, #root *, #root *::before, #root *::after { background: transparent !important; backdrop-filter: none !important; box-shadow: none !important; }",
      "#root { position: relative !important; z-index: 1 !important; min-height: 100vh !important; }",
      "#root * { color: #fff !important; text-shadow: 0 1px 2px rgba(0,0,0,.58), 0 0 12px rgba(0,0,0,.30) !important; }",
      "#codex-custom-background-media { display: block !important; visibility: visible !important; }"
    ].join("\n");
  }
  return [
    "html, body, #root { background: transparent !important; }",
    "#root { position: relative !important; z-index: 1 !important; min-height: 100vh !important; }",
    "#root * { color: #fff !important; text-shadow: 0 1px 2px rgba(0,0,0,.58), 0 0 12px rgba(0,0,0,.30) !important; }",
    `main[class*="_MainContentSurface_"] { background: rgba(16, 16, 22, ${surfaceOpacity}) !important; backdrop-filter: blur(${blur}px) saturate(125%) !important; }`,
    `aside, nav, [class*="Sidebar"], [class*="sidebar"] { background: rgba(13, 13, 18, ${Math.min(0.92, surfaceOpacity + 0.10)}) !important; backdrop-filter: blur(${Math.max(12, blur + 2)}px) saturate(125%) !important; }`,
    '[class*="_MainContentSurface_"] *::selection { background: rgba(139, 92, 246, .38) !important; }',
    "#codex-custom-background-media { display: block !important; visibility: visible !important; }"
  ].join("\n");
}

async function installBackground({ source, opacity = 1, surfaceOpacity = 0, blur = 0 }) {
  try {
    const resolved = resolveWallpaperMedia(source);
    if (resolved.renderMode === "webgl") {
      const port = process.env.WATCHDOG_PORT || "43310";
      const r = await fetch("http://127.0.0.1:" + port + "/select?id=" + resolved.wallpaper.id);
      if (r.ok) {
        const j = await r.json();
        return { ok: true, renderMode: "webgl", source: j.source, title: j.title, note: "Scene wallpaper delegated to watchdog for WebGL rendering; it will appear within a few seconds." };
      }
      if (resolved.fallbackVideo) source = resolved.fallbackVideo;
      else if (resolved.fallbackPreview) source = resolved.fallbackPreview;
    }
  } catch {}
  const media = await loadMedia(source);
  const backgroundOpacity = boundedNumber(opacity, 1, 0.05, 1);
  const surfaceOpacityValue = boundedNumber(surfaceOpacity, 0, 0, 1);
  const blurValue = boundedNumber(blur, 0, 0, 40);
  const { target } = await findDevTools();
  const page = new CodexPage(target);
  await page.connect();

  try {
    await page.evaluate("window.__codexBackgroundChunks = []");
    const base64 = media.buffer.toString("base64");
    const chunkSize = 1024 * 1024;
    for (let offset = 0; offset < base64.length; offset += chunkSize) {
      const chunk = base64.slice(offset, offset + chunkSize);
      await page.evaluate(`window.__codexBackgroundChunks.push(${JSON.stringify(chunk)})`);
    }

    const isVideo = media.type.startsWith("video/");
    const setup = `
      (() => {
        for (const oldMedia of document.querySelectorAll("#codex-custom-background-media, #codex-custom-background-video")) {
          const oldUrl = oldMedia.getAttribute("data-object-url");
          if (oldUrl) URL.revokeObjectURL(oldUrl);
          oldMedia.remove();
        }
        document.getElementById("codex-custom-background-style")?.remove();
        document.getElementById("codex-background-opacity-style")?.remove();
        const base64 = window.__codexBackgroundChunks.join("");
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
        window.__codexBackgroundChunks = [];
        const objectUrl = URL.createObjectURL(new Blob([bytes], { type: ${JSON.stringify(media.type)} }));
        const element = document.createElement(${JSON.stringify(isVideo ? "video" : "img")});
        element.id = "codex-custom-background-media";
        element.src = objectUrl;
        element.setAttribute("data-object-url", objectUrl);
        element.setAttribute("data-background-opacity", ${JSON.stringify(String(backgroundOpacity))});
        element.setAttribute("data-surface-opacity", ${JSON.stringify(String(surfaceOpacityValue))});
        element.setAttribute("data-blur", ${JSON.stringify(String(blurValue))});
        if (${JSON.stringify(isVideo)}) {
          element.autoplay = true;
          element.loop = true;
          element.muted = true;
          element.playsInline = true;
          element.disablePictureInPicture = true;
        }
        element.style.cssText = "position:fixed!important;inset:0!important;width:100vw!important;height:100vh!important;object-fit:cover!important;z-index:0!important;pointer-events:none!important;background:#000;";
        element.style.opacity = ${JSON.stringify(String(backgroundOpacity))};
        document.body.prepend(element);
        const base = document.createElement("div");
        base.id = "codex-custom-background-base";
        base.style.cssText = "position:fixed!important;inset:0!important;background:#000!important;z-index:0!important;pointer-events:none!important";
        document.body.insertBefore(base, element);
        const style = document.createElement("style");
        style.id = "codex-custom-background-style";
        style.textContent = ${JSON.stringify(backgroundCss(backgroundOpacity, surfaceOpacityValue, blurValue))};
        document.head.append(style);
        if (${JSON.stringify(isVideo)}) element.play().catch(() => {});
        return { bytes: bytes.length, type: ${JSON.stringify(media.type)}, objectUrl };
      })()`;

    const installed = await page.evaluate(setup, true);
    await new Promise(resolve => setTimeout(resolve, 1600));
    const status = await page.evaluate(`(() => {
      const media = document.getElementById("codex-custom-background-media");
      if (!media) return { installed: false };
      return {
        installed: true,
        tagName: media.tagName,
        readyState: media.readyState ?? null,
        networkState: media.networkState ?? null,
        paused: media.paused ?? null,
        duration: media.duration ?? null,
        width: media.naturalWidth || media.videoWidth || 0,
        height: media.naturalHeight || media.videoHeight || 0,
        opacity: getComputedStyle(media).opacity,
        error: media.error ? media.error.message : null
      };
    })()`);
    return { ok: status.installed && !status.error, media: installed, status };
  } finally {
    page.close();
  }
}

async function setOpacity({ opacity, surfaceOpacity, blur }) {
  const { target } = await findDevTools();
  const page = new CodexPage(target);
  await page.connect();
  try {
    const current = await page.evaluate(`(() => {
      const media = document.getElementById("codex-custom-background-media");
      if (!media) return { installed: false };
      return {
        installed: true,
        opacity: Number(media.getAttribute("data-background-opacity") || 0.85),
        surfaceOpacity: Number(media.getAttribute("data-surface-opacity") || 0),
        blur: Number(media.getAttribute("data-blur") || 0)
      };
    })()`);
    if (!current.installed) return { ok: false, error: "No custom background is installed." };
    const backgroundOpacity = boundedNumber(opacity ?? current.opacity, current.opacity, 0.05, 1);
    const surfaceOpacityValue = boundedNumber(surfaceOpacity ?? current.surfaceOpacity, current.surfaceOpacity, 0, 1);
    const blurValue = boundedNumber(blur ?? current.blur, current.blur, 0, 40);
    const css = backgroundCss(backgroundOpacity, surfaceOpacityValue, blurValue);
    return await page.evaluate(`(() => {
      const backgroundOpacity = ${JSON.stringify(backgroundOpacity)};
      const surfaceOpacityValue = ${JSON.stringify(surfaceOpacityValue)};
      const blurValue = ${JSON.stringify(blurValue)};
      const media = document.getElementById("codex-custom-background-media");
      const style = document.getElementById("codex-custom-background-style");
      if (!media || !style) return { ok: false, error: "No custom background is installed." };
      media.style.opacity = String(backgroundOpacity);
      media.setAttribute("data-background-opacity", String(backgroundOpacity));
      media.setAttribute("data-surface-opacity", String(surfaceOpacityValue));
      media.setAttribute("data-blur", String(blurValue));
      style.textContent = ${JSON.stringify(css)};
      return { ok: true, opacity: backgroundOpacity, surfaceOpacity: surfaceOpacityValue, blur: blurValue };
    })()`, true);
  } finally {
    page.close();
  }
}

async function resetBackground() {
  const { target } = await findDevTools();
  const page = new CodexPage(target);
  await page.connect();
  try {
    return await page.evaluate(`(() => {
      for (const media of document.querySelectorAll("#codex-custom-background-media, #codex-custom-background-video")) {
        const objectUrl = media.getAttribute("data-object-url");
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        media.remove();
      }
      document.getElementById("codex-custom-background-base")?.remove();
      document.getElementById("codex-custom-background-style")?.remove();
      document.getElementById("codex-background-opacity-style")?.remove();
      window.__codexBackgroundChunks = [];
      return { ok: true, reset: true };
    })()`, true);
  } finally {
    page.close();
  }
}

async function backgroundStatus() {
  const { target, port } = await findDevTools();
  const page = new CodexPage(target);
  await page.connect();
  try {
    const status = await page.evaluate(`(() => {
      const media = document.getElementById("codex-custom-background-media");
      const style = document.getElementById("codex-custom-background-style");
      return {
        installed: !!media,
        styleInstalled: !!style,
        tagName: media?.tagName || null,
        readyState: media?.readyState ?? null,
        paused: media?.paused ?? null,
        duration: media?.duration ?? null,
        width: media?.naturalWidth || media?.videoWidth || 0,
        height: media?.naturalHeight || media?.videoHeight || 0,
        opacity: media ? getComputedStyle(media).opacity : null,
        error: media?.error?.message || null
      };
    })()`);
    return { ok: true, devToolsPort: port, ...status };
  } finally {
    page.close();
  }
}

const TOOLS = [
  {
    name: "list_backgrounds",
    description: "List locally installed Wallpaper Engine media that can be used as Codex in-page backgrounds.",
    inputSchema: {
      type: "object",
      properties: {
        search: { type: "string", description: "Optional title or workshop ID substring" }
      }
    }
  },
  {
    name: "set_background",
    description: "Set an in-page image/video background for Codex only. Accepts a Wallpaper Engine ID/title, local file path, or http(s) URL.",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", description: "Workshop ID/title, local media path, or URL" },
        opacity: { type: "number", description: "Background opacity from 0.05 to 1 (default 1)" },
        surfaceOpacity: { type: "number", description: "Codex panel opacity from 0 to 1 (default 0 for fully clear)" },
        blur: { type: "number", description: "Panel blur in pixels (default 0)" }
      },
      required: ["source"]
    }
  },
  {
    name: "set_background_opacity",
    description: "Adjust the installed Codex in-page background opacity, panel opacity, and blur.",
    inputSchema: {
      type: "object",
      properties: {
        opacity: { type: "number" },
        surfaceOpacity: { type: "number" },
        blur: { type: "number" }
      }
    }
  },
  {
    name: "reset_background",
    description: "Remove the custom background and restore Codex's original page styling.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "enable_white_text",
    description: "Force all Codex conversation text to white with a readable shadow.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "disable_white_text",
    description: "Turn off forced white Codex text and restore original colors.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "background_status",
    description: "Check whether a Codex in-page custom background is installed and playing.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "enable_wallpaper_picker",
    description: "Start the local Wallpaper Engine watcher and show the bottom-right picker in Codex.",
    inputSchema: { type: "object", properties: {} }
  }
];

let wallpaperWatchdog = null;
function startWallpaperWatchdog() {
  if (wallpaperWatchdog && wallpaperWatchdog.exitCode === null) {
    return { ok: true, running: true, pid: wallpaperWatchdog.pid };
  }
  wallpaperWatchdog = spawn(process.execPath, [WATCHDOG_SCRIPT], {
    windowsHide: true,
    detached: true,
    cwd: import.meta.dirname,
    stdio: "ignore"
  });
  wallpaperWatchdog.unref();
  wallpaperWatchdog.once("error", () => { wallpaperWatchdog = null; });
  wallpaperWatchdog.once("exit", () => { wallpaperWatchdog = null; });
  return { ok: true, started: true, pid: wallpaperWatchdog.pid };
}

async function toggleWhiteText(enabled) {
  const base = "http://127.0.0.1:" + (process.env.WATCHDOG_PORT || "43310") + "/white-text?enabled=" + (enabled ? "true" : "false");
  try { const r = await fetch(base); const j = await r.json(); return { ok: true, whiteText: j.whiteText }; }
  catch (error) { return { ok: false, hint: "wallpaper watchdog not running yet; white text is on by default", error: String(error.message || error) }; }
}

async function callTool(name, args = {}) {
  switch (name) {
    case "list_backgrounds": return { ok: true, wallpapers: filteredWallpapers(args.search) };
    case "set_background": return installBackground(args);
    case "set_background_opacity": return setOpacity(args);
    case "reset_background": return resetBackground();
    case "enable_white_text": return toggleWhiteText(true);
    case "disable_white_text": return toggleWhiteText(false);
    case "background_status": return backgroundStatus();
    case "enable_wallpaper_picker": return startWallpaperWatchdog();
    default: return { ok: false, error: "Unknown tool: " + name };
  }
}

const readlineInterface = readline.createInterface({ input: process.stdin });
readlineInterface.on("line", async line => {
  line = line.trim();
  if (!line) return;
  let message;
  try { message = JSON.parse(line); } catch { return; }
  const { id, method, params } = message;
  if (method === "notifications/initialized") return;
  const send = result => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
  const sendError = (code, errorMessage) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message: errorMessage } }) + "\n");
  try {
    if (method === "initialize") {
      send({
        protocolVersion: params?.protocolVersion || "2025-03-26",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "luna-beautiful-codex", version: pluginVersion }
      });
    } else if (method === "ping") {
      send({});
    } else if (method === "tools/list") {
      send({ tools: TOOLS });
    } else if (method === "tools/call") {
      const result = await callTool(params.name, params.arguments || {});
      send({ content: [{ type: "text", text: JSON.stringify(result, null, 2) }] });
    } else if (method) {
      sendError(-32601, "Method not found: " + method);
    }
  } catch (error) {
    sendError(-32603, String(error?.message || error));
  }
});

startWallpaperWatchdog();
setInterval(() => {
  if (!wallpaperWatchdog) startWallpaperWatchdog();
}, 5000);

