import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync, mkdirSync, openSync, readSync, closeSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const WE_APP_ID = "431960";
export const MEDIA_TYPES = new Map([
  [".mp4", "video/mp4"], [".m4v", "video/mp4"], [".webm", "video/webm"], [".mov", "video/quicktime"],
  [".gif", "image/gif"], [".jpg", "image/jpeg"], [".jpeg", "image/jpeg"], [".png", "image/png"],
  [".webp", "image/webp"], [".avif", "image/avif"]
]);

/* Wallpaper Engine web projects point project.json at an HTML entry (or declare
   type "web"). Their relative resources are served through the watchdog's
   /web/<id>/<path> route; the page itself cannot fetch that origin (CSP), so the
   watchdog also inlines the entry into a sandboxed srcdoc iframe. */
export const WEB_TYPES = new Map([
  [".html", "text/html; charset=utf-8"], [".htm", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"], [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"], [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"], [".png", "image/png"], [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"], [".gif", "image/gif"], [".webp", "image/webp"],
  [".avif", "image/avif"], [".ico", "image/x-icon"], [".woff", "font/woff"],
  [".woff2", "font/woff2"], [".ttf", "font/ttf"], [".otf", "font/otf"],
  [".mp3", "audio/mpeg"], [".ogg", "audio/ogg"], [".wav", "audio/wav"],
  [".mp4", "video/mp4"], [".webm", "video/webm"], [".txt", "text/plain; charset=utf-8"]
]);

const MAX_PROPERTIES = 32;

/* A small, explicit subset of general.properties. Only types the panel can
   actually render are exposed; unknown types are skipped rather than guessed. */
export function parseWallpaperProperties(metadata) {
  const raw = metadata && metadata.general && metadata.general.properties;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const out = [];
  for (const [key, value] of Object.entries(raw)) {
    if (out.length >= MAX_PROPERTIES) break;
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const declared = String(value.type || "").toLowerCase();
    const type = declared || (String(key).toLowerCase() === "schemecolor" ? "color" : "");
    if (!["bool", "color", "slider", "combo", "text"].includes(type)) continue;
    const prop = {
      key: String(key).slice(0, 80),
      type,
      text: String(value.text || key).slice(0, 120),
      value: undefined
    };
    if (type === "bool") prop.value = value.value === true || value.value === "true";
    else if (type === "slider") {
      const min = Number(value.min);
      const max = Number(value.max);
      const step = Number(value.step);
      const numeric = Number(value.value);
      prop.min = Number.isFinite(min) ? min : 0;
      prop.max = Number.isFinite(max) && max > prop.min ? max : 100;
      prop.step = Number.isFinite(step) && step > 0 ? step : 1;
      prop.value = Number.isFinite(numeric) ? Math.min(prop.max, Math.max(prop.min, numeric)) : prop.min;
    } else if (type === "combo") {
      const options = [];
      if (Array.isArray(value.options)) {
        for (const option of value.options.slice(0, 32)) {
          if (option && typeof option === "object" && option.value !== undefined) {
            options.push({ value: String(option.value).slice(0, 120), label: String(option.label ?? option.value).slice(0, 120) });
          } else if (option !== undefined) {
            options.push({ value: String(option).slice(0, 120), label: String(option).slice(0, 120) });
          }
        }
      } else if (value.options && typeof value.options === "object") {
        for (const [optionValue, optionLabel] of Object.entries(value.options).slice(0, 32)) {
          options.push({ value: String(optionValue).slice(0, 120), label: String(optionLabel).slice(0, 120) });
        }
      }
      if (!options.length) continue;
      prop.options = options;
      prop.value = String(value.value ?? options[0].value).slice(0, 120);
      if (!options.some(option => option.value === prop.value)) prop.value = options[0].value;
    } else if (type === "color") {
      prop.value = typeof value.value === "string" ? value.value.slice(0, 80) : "#ffffff";
    } else {
      prop.value = typeof value.value === "string" ? value.value.slice(0, 500) : String(value.value ?? "");
    }
    out.push(prop);
  }
  return out;
}

/* Resolve a project-declared file without ever leaving the wallpaper folder. */
function insideDir(directory, relative) {
  if (!relative || typeof relative !== "string") return null;
  const root = path.resolve(directory);
  const target = path.resolve(root, relative.replace(/^[\\/]+/, ""));
  return target === root || target.startsWith(root + path.sep) ? target : null;
}

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
  /* Keep cachedLibraries: re-probing means three reg.exe spawns plus a stat on
     every drive letter, which is slow under a sandboxed host and does not help
     find a newly installed wallpaper - the workshop directory listing below is
     what picks those up. A new Steam library is still found on restart/TTL. */
  /* Keep sceneVideoMemo: it is keyed by (path, mtimeMs, size), so a replaced
     scene.pkg invalidates itself and a newly installed one simply misses. Clearing
     it here made every picker open re-read every package (18 scenes, ~500MB) to
     look for an embedded video, which stalled the first pick by ~2 seconds. */
  if (sceneVideoMemo.size > 96) sceneVideoMemo.clear();
}

/* A scene.pkg whose header cannot be read is not a usable scene. Only the header
   is inspected (magic + entry count), so this stays cheap: the real package is
   read by the page later anyway. Memoized on (path, mtime, size) like the video
   probe, so a re-downloaded package re-evaluates itself. */
const sceneUsableMemo = new Map();
function scenePackageUsable(scenePath) {
  let stat;
  try { stat = statSync(scenePath); } catch { return false; }
  if (stat.size < 8) return false;
  const memo = sceneUsableMemo.get(scenePath);
  if (memo && memo.mtimeMs === stat.mtimeMs && memo.size === stat.size) return memo.ok;
  let ok = false;
  let handle = null;
  try {
    handle = openSync(scenePath, "r");
    const head = Buffer.alloc(Math.min(64 * 1024, stat.size));
    const read = readSync(handle, head, 0, head.length, 0);
    if (read >= 8) {
      /* Layout: int32 length, then "PKGV...." magic, then int32 entry count. */
      const magicLength = head.readInt32LE(0);
      if (magicLength > 0 && magicLength <= 32 && 4 + magicLength + 4 <= read) {
        const magic = head.subarray(4, 4 + magicLength).toString("latin1");
        const count = head.readInt32LE(4 + magicLength);
        ok = magic.startsWith("PKGV") && count >= 0 && count < 200000;
      }
    }
  } catch { ok = false; }
  finally { if (handle !== null) { try { closeSync(handle); } catch {} } }
  sceneUsableMemo.set(scenePath, { mtimeMs: stat.mtimeMs, size: stat.size, ok });
  if (sceneUsableMemo.size > 256) sceneUsableMemo.delete(sceneUsableMemo.keys().next().value);
  return ok;
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
  /* Tests point STEAM_LIBRARY at a throwaway tree; without this the registry and
     drive probe still add the real Steam libraries, so a "fixture only" run ends
     up listing the user's whole collection too. */
  if (process.env.STEAM_LIBRARY_ONLY === "1") {
    cachedLibraries = [...libraries];
    return cachedLibraries;
  }

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

/* User-added wallpapers live beside prefs.json. The page hands the bytes over
   through the watchdog (it can never read a path itself), and the copy keeps its
   extension with a timestamp prefix so two uploads of "wall.jpg" cannot collide. */
export function uploadsDir() {
  const base = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  return path.join(base, "Codex", "luna-beautiful-codex", "uploads");
}

/* "1737142200000_my wallpaper.jpg" -> { id: "up_1737142200000_my wallpaper", title: "my wallpaper" } */
function uploadEntry(filePath) {
  const base = path.basename(filePath);
  const ext = path.extname(base);
  const stem = base.slice(0, base.length - ext.length);
  const id = "up_" + stem;
  const title = stem.replace(/^[0-9]{10,}_/, "").replace(/[_]+/g, " ").trim() || stem;
  return { id, title };
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
        let sceneBroken = null;
        for (const name of ["preview.gif", "preview.jpg", "preview.png", "preview.jpeg", "preview.webp"]) {
          const candidate = path.join(directory, name);
          if (existsSync(candidate)) { preview = candidate; break; }
        }
        const declared = metadata.file ? insideDir(directory, metadata.file) : null;
        const declaredExt = declared ? path.extname(declared).toLowerCase() : "";
        /* A declared media file always wins. Otherwise the folder is a Scene
           whenever scene.pkg exists - package name and casing of metadata.type
           ("scene" vs "Scene") both vary between workshop uploads, and the old
           exact "scene" match sent Scene wallpapers into the blurry static
           preview(path). */
        const direct = declared && MEDIA_TYPES.has(declaredExt) && existsSync(declared) ? declared : null;
        /* Web wallpapers declare type "web" (project.json -> file: index.html).
           Treat an HTML entry as web even when the type field is missing, which
           is common in hand-made projects. */
        const webEntry = !direct && declared && WEB_TYPES.has(declaredExt) && [".html", ".htm"].includes(declaredExt) && existsSync(declared)
          ? declared : null;
        const webDir = webEntry ? path.dirname(webEntry) : null;
        let scene = null;
        if (!direct && !webEntry) {
          if (declared && declaredExt === ".pkg" && existsSync(declared)) scene = declared;
          else {
            const sceneCandidate = path.join(directory, "scene.pkg");
            if (existsSync(sceneCandidate)) scene = sceneCandidate;
          }
        }
        /* A broken or missing project.json used to hide a perfectly playable
           folder: the scan only looked at metadata.file, so a directory holding a
           real video/image next to an unparsable project.json was skipped entirely.
           Fall back to the obvious media file in the folder itself. */
        let loose = null;
        if (!direct && !webEntry && !scene) {
          try {
            for (const name of readdirSync(directory)) {
              const ext = path.extname(name).toLowerCase();
              if (!MEDIA_TYPES.has(ext)) continue;
              /* preview.* is the wallpaper's thumbnail, not a wallpaper in its own
                 right. Treating it as a directly playable file turned every
                 preview-only item into a "native" wallpaper and hid the fallback
                 path it actually takes. */
              if (/^preview\.(gif|jpe?g|png|webp)$/i.test(name)) continue;
              const candidate = path.join(directory, name);
              try { if (!statSync(candidate).isFile()) continue; } catch { continue; }
              /* Prefer a video over a still: the playable one is what the user wants. */
              if (!loose || MEDIA_TYPES.get(ext).startsWith("video/")) loose = candidate;
              if (MEDIA_TYPES.get(ext).startsWith("video/")) break;
            }
          } catch {}
        }

        let sceneVideo = null;
        if (scene) { try { sceneVideo = extractSceneVideo(scene); } catch {} }

        /* A scene.pkg that cannot even be opened is not a WebGL scene, whatever
           its name. Listing it as webgl made every selection pay a full failed
           mount (often 10s+) before falling back to the preview. Probe it once
           here - the result is memoized by (path, mtime, size) - and demote to the
           preview path when the package is unusable. */
        if (scene) {
          const usable = scenePackageUsable(scene);
          if (!usable) {
            sceneBroken = scene;
            scene = null;
          }
        }

        const picked = direct || webEntry || scene || loose || preview;
        if (!picked) continue;
        wallpapers.push({
          id, title: metadata.title || id,
          type: metadata.type || (direct ? "video" : scene ? "scene" : webEntry ? "web" : "unknown"),
          file: direct || webEntry || sceneVideo || scene || loose || preview,
          preview, scene, direct: direct || loose, sceneVideo,
          webEntry, webDir,
          sceneDir: scene ? path.dirname(scene) : null,
          brokenScene: sceneBroken,
          fallbackPreview: (!direct && !webEntry && !sceneVideo && preview) ? preview : null,
          renderMode: direct || loose ? "native" : scene ? "webgl" : webEntry ? "web" : preview ? "fallback" : "unknown",
          /* "scene" means the wallpaper is a WebGL scene (even when this switch
             falls back to its preview), which is what the type filter offers.
             A broken package is not offered as a scene: it can never render one. */
          kind: scene ? "scene" : webEntry ? "web" : direct && MEDIA_TYPES.get(declaredExt).startsWith("video/") ? "video" : "image",
          properties: parseWallpaperProperties(metadata),
          custom: false,
        });
      }
    } catch {}
  }
  /* Custom uploads last, so the workshop library keeps its familiar order. */
  try {
    const dir = uploadsDir();
    if (existsSync(dir)) {
      for (const name of readdirSync(dir)) {
        /* Appearance uploads (avatar_/mascot_) live in the same folder but are not
           wallpapers; without this skip they would show up in the picker. */
        if (name.startsWith("avatar_") || name.startsWith("mascot_")) continue;
        const filePath = path.join(dir, name);
        const ext = path.extname(name).toLowerCase();
        const mime = MEDIA_TYPES.get(ext);
        if (!mime) continue;
        let stat; try { stat = statSync(filePath); } catch { continue; }
        if (!stat.isFile() || stat.size < 1) continue;
        const { id, title } = uploadEntry(filePath);
        if (seen.has(id)) continue;
        seen.add(id);
        const isVideo = mime.startsWith("video/");
        wallpapers.push({
          id, title, type: isVideo ? "video" : "image",
          file: filePath, preview: isVideo ? null : filePath,
          scene: null, direct: filePath, sceneVideo: null, sceneDir: null,
          fallbackPreview: null,
          renderMode: "native",
          kind: isVideo ? "video" : "image",
          custom: true,
          addedAt: Math.round(stat.mtimeMs)
        });
      }
    }
  } catch {}

  cachedWallpapers = wallpapers.sort((a, b) => {
    /* Uploads stay at the end of the list regardless of title ordering. */
    if (!!a.custom !== !!b.custom) return a.custom ? 1 : -1;
    if (a.custom && b.custom) return (a.addedAt || 0) - (b.addedAt || 0);
    return a.title.localeCompare(b.title, "zh-Hans-CN");
  });
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
  /* Workshop libraries rarely exceed a few hundred entries; bound the memo anyway
     so a long-running watchdog cannot grow it without limit. */
  if (sceneVideoMemo.size > 256) sceneVideoMemo.delete(sceneVideoMemo.keys().next().value);
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
    if (item.webEntry) return { wallpaper: item, renderMode: "web", webEntry: item.webEntry, webDir: item.webDir, fallbackVideo: item.sceneVideo, fallbackPreview: item.preview };
    if (item.fallbackPreview) return { path: item.fallbackPreview, type: MEDIA_TYPES.get(path.extname(item.fallbackPreview).toLowerCase()) || "image/gif", wallpaper: item, fallback: true, renderMode: "fallback" };
  }
  const filePath = path.resolve(source);
  if (!existsSync(filePath) || !statSync(filePath).isFile()) throw new Error("Wallpaper media not found: " + source);
  const type = MEDIA_TYPES.get(path.extname(filePath).toLowerCase());
  if (!type) throw new Error("Unsupported wallpaper media: " + filePath);
  return { path: filePath, type, renderMode: "native" };
}
