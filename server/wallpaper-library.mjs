import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const WE_APP_ID = "431960";
export const MEDIA_TYPES = new Map([
  [".mp4", "video/mp4"], [".m4v", "video/mp4"], [".webm", "video/webm"], [".mov", "video/quicktime"],
  [".gif", "image/gif"], [".jpg", "image/jpeg"], [".jpeg", "image/jpeg"], [".png", "image/png"],
  [".webp", "image/webp"], [".avif", "image/avif"]
]);

/* Scanning the workshop is not free: it spawns reg.exe, stats every folder and
   - for Scene wallpapers - used to read every scene.pkg just to look for an
   embedded video. The watchdog re-scans on every selection, so both the scan
   result and the per-package video probe are memoized here. */
const LIST_TTL_MS = 30000;
let cachedWallpapers = null;
let cachedListedAt = 0;
let cachedLibraries = null;
const sceneVideoMemo = new Map();

export function invalidateWallpaperCache() {
  cachedWallpapers = null;
  cachedListedAt = 0;
  cachedLibraries = null;
  sceneVideoMemo.clear();
}

function reg(key, value) {
  try {
    const result = spawnSync("reg.exe", ["query", key, "/v", value], { encoding: "utf8" });
    if (!result || result.error || result.status !== 0) return null;
    const match = result.stdout.match(/REG_\w+\s+([^\r\n]+)/i);
    return match ? match[1].trim() : null;
  } catch { return null; }
}

/* Scan drive letters for Steam as fallback when reg.exe is sandboxed. */
function probeDrivesForSteam() {
  const found = new Set();
  for (const letter of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
    const drive = letter + ":";
    if (!existsSync(drive + "\\")) continue;
    for (const candidate of [
      path.join(drive, "Steam"),
      path.join(drive, "steam"),
      path.join(drive, "Program Files (x86)", "Steam"),
      path.join(drive, "Program Files", "Steam"),
    ]) {
      if (existsSync(path.join(candidate, "steamapps"))) found.add(candidate);
    }
  }
  return found;
}

export function steamLibraries() {
  if (cachedLibraries) return cachedLibraries;
  const libraries = new Set();
  if (process.env.STEAM_LIBRARY) libraries.add(process.env.STEAM_LIBRARY);

  for (const [key, value] of [
    ["HKCU\\Software\\Valve\\Steam", "SteamPath"],
    ["HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam", "InstallPath"],
    ["HKLM\\SOFTWARE\\Valve\\Steam", "InstallPath"],
  ]) {
    const steamPath = reg(key, value);
    if (!steamPath) continue;
    libraries.add(steamPath);
    const vdf = path.join(steamPath, "steamapps", "libraryfolders.vdf");
    if (!existsSync(vdf)) continue;
    for (const match of readFileSync(vdf, "utf8").matchAll(/"path"\s+"([^"]+)"/g)) {
      libraries.add(match[1].replace(/\\\\/g, "\\"));
    }
  }

  /* Drive-probe fallback */
  for (const candidate of probeDrivesForSteam()) {
    libraries.add(candidate);
    const vdf = path.join(candidate, "steamapps", "libraryfolders.vdf");
    if (!existsSync(vdf)) continue;
    for (const match of readFileSync(vdf, "utf8").matchAll(/"path"\s+"([^"]+)"/g)) {
      libraries.add(match[1].replace(/\\\\/g, "\\"));
    }
  }

  cachedLibraries = [...libraries];
  return cachedLibraries;
}

/* Try several writable locations for the extraction cache. */
function resolveCacheDir() {
  const fallbacks = [
    path.join(process.env.APPDATA || "", "Codex", "luna-beautiful-codex", "cache"),
    path.join(process.env.LOCALAPPDATA || "", "Codex", "luna-beautiful-codex", "cache"),
    path.join(os.homedir(), ".cache", "luna-beautiful-codex"),
    path.join(os.tmpdir(), "luna-beautiful-codex"),
  ];
  for (const candidate of fallbacks) {
    try { mkdirSync(candidate, { recursive: true }); return candidate; } catch {}
  }
  return null;
}

export function listWallpapers() {
  const now = Date.now();
  if (cachedWallpapers && now - cachedListedAt < LIST_TTL_MS) return cachedWallpapers;

  const wallpapers = [];
  const seen = new Set();
  for (const library of steamLibraries()) {
    const workshop = path.join(library, "steamapps", "workshop", "content", WE_APP_ID);
    try {
      if (!existsSync(workshop)) continue;
      for (const id of readdirSync(workshop)) {
        if (seen.has(id)) continue;
        const directory = path.join(workshop, id);
        try { if (!statSync(directory).isDirectory()) continue; } catch { continue; }
        seen.add(id);
        let metadata = {};
        try { metadata = JSON.parse(readFileSync(path.join(directory, "project.json"), "utf8")); } catch {}
        let preview = null;
        for (const name of ["preview.gif", "preview.jpg", "preview.png", "preview.jpeg", "preview.webp"]) {
          const candidate = path.join(directory, name);
          if (existsSync(candidate)) { preview = candidate; break; }
        }
        const declared = metadata.file ? path.join(directory, metadata.file) : null;
        const declaredExt = declared ? path.extname(declared).toLowerCase() : "";
        /* A declared media file always wins. Otherwise the folder is a Scene
           whenever scene.pkg exists - package name and casing of metadata.type
           ("scene" vs "Scene") both vary between workshop uploads, and the old
           exact "scene" match sent Scene wallpapers into the blurry static
           preview(path). */
        const direct = declared && MEDIA_TYPES.has(declaredExt) && existsSync(declared) ? declared : null;
        let scene = null;
        if (!direct) {
          if (declared && declaredExt === ".pkg" && existsSync(declared)) scene = declared;
          else {
            const sceneCandidate = path.join(directory, "scene.pkg");
            if (existsSync(sceneCandidate)) scene = sceneCandidate;
          }
        }

        let sceneVideo = null;
        if (scene) { try { sceneVideo = extractSceneVideo(scene); } catch {} }

        if (!direct && !scene && !preview) continue;
        wallpapers.push({
          id, title: metadata.title || id,
          type: metadata.type || (direct ? "video" : scene ? "scene" : "unknown"),
          file: direct || sceneVideo || scene || preview,
          preview, scene, direct, sceneVideo,
          sceneDir: scene ? path.dirname(scene) : null,
          fallbackPreview: (!direct && !sceneVideo && preview) ? preview : null,
          renderMode: direct ? "native" : scene ? "webgl" : preview ? "fallback" : "unknown",
        });
      }
    } catch {}
  }
  cachedWallpapers = wallpapers.sort((a, b) => a.title.localeCompare(b.title, "zh-Hans-CN"));
  cachedListedAt = Date.now();
  return cachedWallpapers;
}

function parsePkg(buffer) {
  let offset = 0;
  const int32 = () => { const v = buffer.readInt32LE(offset); offset += 4; return v; };
  const string = () => { const l = int32(); const s = buffer.subarray(offset, offset + l).toString("utf8"); offset += l; return s; };
  const magic = string();
  if (!magic.startsWith("PKGV")) throw new Error("Unsupported package: " + magic);
  const count = int32();
  const entries = [];
  for (let i = 0; i < count; i++) entries.push({ path: string(), offset: int32(), length: int32() });
  return { dataStart: offset, entries };
}

function embeddedVideo(bytes) {
  const sig = bytes.indexOf(Buffer.from("ftyp"));
  if (sig < 4 || bytes.length < 512 * 1024) return null;
  const cand = bytes.subarray(sig - 4);
  return cand.subarray(8, 12).toString("latin1") === "isom" ? cand : null;
}

export function extractSceneVideo(scenePath) {
  let stat;
  try { stat = statSync(scenePath); } catch { return null; }
  const memo = sceneVideoMemo.get(scenePath);
  if (memo && memo.mtimeMs === stat.mtimeMs && memo.size === stat.size) return memo.result;
  const result = extractSceneVideoUncached(scenePath);
  sceneVideoMemo.set(scenePath, { mtimeMs: stat.mtimeMs, size: stat.size, result });
  return result;
}

/* Only the current generation is kept: previous "<id>.<mtime>.<size>.mp4" files for
   the same wallpaper are deleted once the fresh extraction is in place. */
function dropStaleSceneVideoCache(cacheDir, stem, keepPath) {
  try {
    const keepName = path.basename(keepPath);
    const legacyName = stem + ".mp4";
    const prefix = stem + ".";
    for (const name of readdirSync(cacheDir)) {
      /* The pre-0.2.4 layout was a single "<id>.mp4"; the keyed name supersedes it,
         so the legacy file is dead weight (tens of MB per wallpaper) and is swept. */
      if (name === legacyName) { try { unlinkSync(path.join(cacheDir, name)); } catch {} continue; }
      if (name === keepName || !name.startsWith(prefix) || !name.endsWith(".mp4")) continue;
      const generation = name.slice(prefix.length, name.length - 4);
      if (!/^[0-9]+[.][0-9]+$/.test(generation)) continue;
      try { unlinkSync(path.join(cacheDir, name)); } catch {}
    }
  } catch {}
}

function extractSceneVideoUncached(scenePath) {
  const cacheDir = resolveCacheDir();
  if (!cacheDir) return null;
  /* Key the cached extraction on the source package identity. Steam re-downloads and
     workshop updates replace scene.pkg in place, and the old code happily reused the
     previous extraction for the new package. */
  let sourceStat;
  try { sourceStat = statSync(scenePath); } catch { return null; }
  if (sourceStat.size < 512 * 1024) return null;
  const cacheStem = path.basename(path.dirname(scenePath));
  const cachePath = path.join(cacheDir, `${cacheStem}.${Math.round(sourceStat.mtimeMs)}.${sourceStat.size}.mp4`);
  if (existsSync(cachePath) && statSync(cachePath).size > 512 * 1024) {
    dropStaleSceneVideoCache(cacheDir, cacheStem, cachePath);
    return cachePath;
  }
  const buffer = readFileSync(scenePath);
  const pkg = parsePkg(buffer);
  const candidates = [];
  for (const entry of pkg.entries) {
    const ext = path.extname(entry.path).toLowerCase();
    const start = pkg.dataStart + entry.offset;
    const bytes = buffer.subarray(start, start + entry.length);
    if (ext === ".mp4" || ext === ".webm") candidates.push(bytes);
    if (ext === ".tex" && embeddedVideo(bytes)) candidates.push(embeddedVideo(bytes));
  }
  candidates.sort((a, b) => b.length - a.length);
  if (!candidates.length || candidates[0].length < 512 * 1024) return null;
  try { writeFileSync(cachePath, candidates[0]); } catch { return null; }
  dropStaleSceneVideoCache(cacheDir, cacheStem, cachePath);
  return cachePath;
}

export function resolveWallpaperMedia(source) {
  const wallpapers = listWallpapers();
  const item = /^\d+$/.test(source)
    ? wallpapers.find(w => w.id === source)
    : wallpapers.find(w => source === w.id || source === w.title);
  if (item) {
    if (item.direct) return { path: item.direct, type: MEDIA_TYPES.get(path.extname(item.direct).toLowerCase()), wallpaper: item, renderMode: "native" };
    if (item.scene) return { wallpaper: item, renderMode: "webgl", scene: item.scene, sceneDir: item.sceneDir, fallbackVideo: item.sceneVideo, fallbackPreview: item.preview };
    if (item.fallbackPreview) return { path: item.fallbackPreview, type: MEDIA_TYPES.get(path.extname(item.fallbackPreview).toLowerCase()) || "image/gif", wallpaper: item, fallback: true, renderMode: "fallback" };
  }
  const filePath = path.resolve(source);
  if (!existsSync(filePath) || !statSync(filePath).isFile()) throw new Error("Wallpaper media not found: " + source);
  const type = MEDIA_TYPES.get(path.extname(filePath).toLowerCase());
  if (!type) throw new Error("Unsupported wallpaper media: " + filePath);
  return { path: filePath, type, renderMode: "native" };
}