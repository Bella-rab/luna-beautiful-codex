import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const WE_APP_ID = "431960";
export const MEDIA_TYPES = new Map([
  [".mp4", "video/mp4"], [".m4v", "video/mp4"], [".webm", "video/webm"], [".mov", "video/quicktime"],
  [".gif", "image/gif"], [".jpg", "image/jpeg"], [".jpeg", "image/jpeg"], [".png", "image/png"],
  [".webp", "image/webp"], [".avif", "image/avif"]
]);

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

  return [...libraries];
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
        const sceneCandidate = path.join(directory, "scene.pkg");
        const sceneFromMetadata = declared && path.extname(declared).toLowerCase() === ".pkg" && existsSync(declared) ? declared : null;
        const scene = (metadata.type === "scene" && existsSync(sceneCandidate)) ? sceneCandidate : sceneFromMetadata;
        const direct = !scene && declared && MEDIA_TYPES.has(path.extname(declared).toLowerCase()) && existsSync(declared) ? declared : null;

        let sceneVideo = null;
        if (scene) { try { sceneVideo = extractSceneVideo(scene); } catch {} }

        if (!direct && !sceneVideo && !preview) continue;
        wallpapers.push({
          id, title: metadata.title || id,
          type: metadata.type || (direct ? "video" : scene ? "scene" : "unknown"),
          file: direct || sceneVideo || scene || preview,
          preview, scene, direct, sceneVideo,
          fallbackPreview: (!direct && !sceneVideo && preview) ? preview : null,
        });
      }
    } catch {}
  }
  return wallpapers.sort((a, b) => a.title.localeCompare(b.title, "zh-Hans-CN"));
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
  const cacheDir = resolveCacheDir();
  if (!cacheDir) return null;
  const cachePath = path.join(cacheDir, path.basename(path.dirname(scenePath)) + ".mp4");
  if (existsSync(cachePath) && statSync(cachePath).size > 512 * 1024) return cachePath;
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
  return cachePath;
}

export function resolveWallpaperMedia(source) {
  const wallpapers = listWallpapers();
  const item = /^\d+$/.test(source)
    ? wallpapers.find(w => w.id === source)
    : wallpapers.find(w => source === w.id || source === w.title);
  if (item) {
    if (item.direct) return { path: item.direct, type: MEDIA_TYPES.get(path.extname(item.direct).toLowerCase()), wallpaper: item };
    if (item.sceneVideo) return { path: item.sceneVideo, type: "video/mp4", wallpaper: item, extracted: true };
    if (item.fallbackPreview) return { path: item.fallbackPreview, type: MEDIA_TYPES.get(path.extname(item.fallbackPreview).toLowerCase()) || "image/gif", wallpaper: item, fallback: true };
    if (item.scene) {
      const extracted = extractSceneVideo(item.scene);
      if (extracted) return { path: extracted, type: "video/mp4", wallpaper: item, extracted: true };
      throw new Error("This Scene wallpaper has no extractable video: " + item.title);
    }
  }
  const filePath = path.resolve(source);
  if (!existsSync(filePath) || !statSync(filePath).isFile()) throw new Error("Wallpaper media not found: " + source);
  const type = MEDIA_TYPES.get(path.extname(filePath).toLowerCase());
  if (!type) throw new Error("Unsupported wallpaper media: " + filePath);
  return { path: filePath, type };
}
