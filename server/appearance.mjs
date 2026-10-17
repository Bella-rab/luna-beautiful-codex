/* Luna Beautiful Codex - appearance model (Phase 1).
 *
 * Phase 1 migrates the beautification feature set of elysia395/dsh-wallpaper-engine
 * (MIT) into this plugin. Only the feature definitions and parameter semantics are
 * borrowed: DSH runs inside its own web shell, whereas this plugin reaches the Codex
 * page through CDP injection + the watchdog HTTP loop + prefs.json, so the host
 * architecture is deliberately different (no host monkey-patching, no extra process).
 *
 * Everything the page needs is one self-contained function (pageRuntime) that is
 * serialised with Function.prototype.toString() and evaluated in the page. Writing the
 * page half as real, lintable code beats hand-escaping a template literal. It must not
 * close over module scope and it must stay dependency free.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EXT_BUILD, extRuntime } from "./ext.mjs";

export const APPEARANCE_VERSION = 1;

export const GLASS_FACES = ["sidebar", "sidebarContent", "settingsWindow", "conversation", "thinkingTrigger", "floaters"];
export const FACE_LABELS = {
  sidebar: "\u5DE6\u4FA7\u680F",
  sidebarContent: "\u4FA7\u680F\u5185\u5BB9\u533A",
  settingsWindow: "\u8BBE\u7F6E\u7A97",
  conversation: "\u5BF9\u8BDD\u533A",
  thinkingTrigger: "\u601D\u8003\u533A",
  floaters: "\u6D6E\u5C42"
};
export const FACE_MODES = ["inherit", "custom", "off"];
export const FACE_MODE_LABELS = { inherit: "\u8DDF\u968F\u5168\u5C40", custom: "\u72EC\u7ACB", off: "\u5173\u95ED" };

/* Design limits for the extra frosted-glass selectors: at most 8 entries, each at
   most 120 characters. Anything longer, or past the eighth, is dropped whole - the
   spec is explicit that entries are never truncated. */
export const MAX_EXTRA_SELECTORS = 8;
export const MAX_EXTRA_SELECTOR_LENGTH = 120;

export function extraSelectorList(text) {
  if (typeof text !== "string") return [];
  const out = [];
  for (const raw of text.split(/[\n,]+/)) {
    const entry = raw.trim();
    if (!entry) continue;
    if (entry.length > MAX_EXTRA_SELECTOR_LENGTH) continue;
    if (out.length >= MAX_EXTRA_SELECTORS) break;
    out.push(entry);
  }
  return out;
}

export const OBJECT_FITS = ["cover", "contain", "fill"];
export const EXT_FORMS = ["whale", "cat", "rabbit", "fox", "penguin", "robot"];
export const CLICK_STYLES = ["ripple", "spark", "ring"];
export const TRAIL_STYLES = ["comet", "line", "dots"];
export const BLEND_MODES = ["screen", "normal", "overlay"];
export const COLOR_MODES = ["single", "rainbow"];
export function defaultExt() {
  return {
    version: 1,
    enabled: false,
    fx: {
      click: { enabled: false, style: "ripple", size: 96, glow: 60, colorMode: "single", color: "#7dd3fc", opacity: 80, blend: "screen" },
      trail: { enabled: false, style: "comet", length: 240, width: 3, glow: 60, colorMode: "single", color: "#a78bfa", opacity: 70, blend: "screen" }
    },
    parallax: { enabled: false, bg: 1, ui: 1, mascot: 1, smooth: 60, depths: { chat: 1, composer: 1, sidebar: 1, bubble: 1 } },
    avatar: { enabled: false, size: 40, radius: 50, file: "", image: "" },
    mascot: { enabled: false, form: "whale", scale: 1, x: 96, y: 92, drag: true, file: "", image: "" }
  };
}
export function defaultAppearance() {
  return {
    version: APPEARANCE_VERSION,
    activePreset: "\u81EA\u5B9A\u4E49",
    glass: {
      enabled: false,
      blur: 9,
      alpha: 80,
      border: 90,
      /* scrim is a 0-1 darkening scrim behind every glass surface */
      scrim: 0,
      /* fidelity 0-100 maps to a backdrop-filter saturate() multiplier of 1+f/100 */
      fidelity: 35,
      colorLight: "#266d3c",
      colorDark: "#266d3c",
      faces: { sidebar: "inherit", sidebarContent: "inherit", settingsWindow: "inherit", conversation: "inherit", thinkingTrigger: "inherit", floaters: "inherit" },
      face: {
        sidebar: { blur: 8, alpha: 85, color: "#ffffff" },
        sidebarContent: { blur: 8, alpha: 20, color: "#ffffff" },
        settingsWindow: { blur: 8, alpha: 90, color: "#ffffff" },
        conversation: { blur: 8, alpha: 30, color: "#ffffff" },
        thinkingTrigger: { blur: 20, alpha: 100, color: "#ffffff" },
        floaters: { blur: 8, alpha: 90, color: "#ffffff" }
      },
      sidebarFollowGlobal: true,
      sidebarRadius: 20,
      sidebarSquareTL: false,
      sidebarSquareTR: false,
      sidebarSquareBR: false,
      sidebarSquareBL: false,
      sidebarFullClear: false,
      extraSelectors: ""
    },
    fonts: {
      globalFamily: "",
      roles: {
        secondary: { family: "", size: "", weight: "", light: "", dark: "" },
        caption: { family: "", size: "", weight: "", light: "", dark: "" },
        body: { family: "", size: "", weight: "", light: "", dark: "" }
      },
      components: {
        sidebar: { family: "", size: "" },
        titlebar: { family: "", size: "" },
        composer: { family: "", size: "" },
        message: { family: "", size: "" }
      },
      caretColor: "",
      ui: { sendButton: "", link: "", fileIcon: "", tab: "", reasoning: "" }
    },
    filters: {
      blur: 0,
      brightness: 100,
      contrast: 100,
      saturate: 100,
      opacity: 100,
      darken: 0,
      objectFit: "cover",
      positionX: 50,
      positionY: 50,
      scale: 100
    },
    ext: defaultExt(),
    presets: []
  };
}

const isObject = value => !!value && typeof value === "object" && !Array.isArray(value);
export function normalizeAppearance(raw, options = {}) {
  const out = defaultAppearance();
  if (!isObject(raw)) return out;
  const num = (value, lo, hi, fallback) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.min(hi, Math.max(lo, parsed)) : fallback;
  };
  const text = value => (typeof value === "string" ? value : "");
  const color = (value, fallback) => {
    const trimmed = text(value).trim();
    if (!trimmed) return fallback;
    return /^#[0-9a-fA-F]{3}$|^#[0-9a-fA-F]{6}$|^#[0-9a-fA-F]{8}$/.test(trimmed) ? trimmed : fallback;
  };
  const cssValue = (value, fallback = "") => {
    const trimmed = text(value).trim();
    /* Declarations are injected into a stylesheet, so refuse anything that could close
       the rule (or the sheet) instead of only checking the length. */
    return trimmed.length <= 64 && !/[;{}<>]/.test(trimmed) ? trimmed : fallback;
  };
  const mode = value => (FACE_MODES.includes(value) ? value : "inherit");

  const glass = isObject(raw.glass) ? raw.glass : {};
  const outGlass = out.glass;
  outGlass.enabled = glass.enabled === true;
  outGlass.blur = num(glass.blur, 0, 40, outGlass.blur);
  outGlass.alpha = num(glass.alpha, 0, 100, outGlass.alpha);
  outGlass.border = num(glass.border, 0, 100, outGlass.border);
  /* The panel and the model both speak 0-1, but accepting 0-100 from an imported
     preset keeps hand-written files working instead of silently pinning 1. */
  const scrim = Number(glass.scrim);
  outGlass.scrim = Number.isFinite(scrim) ? Math.min(1, Math.max(0, scrim > 1 ? scrim / 100 : scrim)) : outGlass.scrim;
  outGlass.fidelity = num(glass.fidelity, 0, 100, outGlass.fidelity);
  outGlass.colorLight = color(glass.colorLight, outGlass.colorLight);
  outGlass.colorDark = color(glass.colorDark, outGlass.colorDark);
  const faces = isObject(glass.faces) ? glass.faces : {};
  for (const face of GLASS_FACES) outGlass.faces[face] = mode(faces[face]);
  const faceParams = isObject(glass.face) ? glass.face : {};
  for (const face of GLASS_FACES) {
    const source = isObject(faceParams[face]) ? faceParams[face] : {};
    const target = outGlass.face[face];
    target.blur = num(source.blur, 0, 60, target.blur);
    target.alpha = num(source.alpha, 0, 100, target.alpha);
    target.color = color(source.color, target.color);
  }
  outGlass.sidebarFollowGlobal = glass.sidebarFollowGlobal !== false;
  outGlass.sidebarRadius = num(glass.sidebarRadius, 0, 40, outGlass.sidebarRadius);
  outGlass.sidebarSquareTL = glass.sidebarSquareTL === true;
  outGlass.sidebarSquareTR = glass.sidebarSquareTR === true;
  outGlass.sidebarSquareBR = glass.sidebarSquareBR === true;
  outGlass.sidebarSquareBL = glass.sidebarSquareBL === true;
  outGlass.sidebarFullClear = glass.sidebarFullClear === true;
  outGlass.extraSelectors = text(glass.extraSelectors).slice(0, 4000);
  const fonts = isObject(raw.fonts) ? raw.fonts : {};
  out.fonts.globalFamily = cssValue(fonts.globalFamily);
  const roles = isObject(fonts.roles) ? fonts.roles : {};
  for (const role of Object.keys(out.fonts.roles)) {
    const source = isObject(roles[role]) ? roles[role] : {};
    const target = out.fonts.roles[role];
    target.family = cssValue(source.family);
    target.size = cssValue(source.size);
    target.weight = cssValue(source.weight);
    target.light = color(source.light, "");
    target.dark = color(source.dark, "");
  }
  const components = isObject(fonts.components) ? fonts.components : {};
  for (const key of Object.keys(out.fonts.components)) {
    const source = isObject(components[key]) ? components[key] : {};
    const target = out.fonts.components[key];
    target.family = cssValue(source.family);
    target.size = cssValue(source.size);
  }
  out.fonts.caretColor = color(fonts.caretColor, "");
  const ui = isObject(fonts.ui) ? fonts.ui : {};
  for (const key of Object.keys(out.fonts.ui)) out.fonts.ui[key] = color(ui[key], "");

  const filters = isObject(raw.filters) ? raw.filters : {};
  const outFilters = out.filters;
  outFilters.blur = num(filters.blur, 0, 20, outFilters.blur);
  outFilters.brightness = num(filters.brightness, 0, 200, outFilters.brightness);
  outFilters.contrast = num(filters.contrast, 0, 200, outFilters.contrast);
  outFilters.saturate = num(filters.saturate, 0, 200, outFilters.saturate);
  outFilters.opacity = num(filters.opacity, 5, 100, outFilters.opacity);
  outFilters.darken = num(filters.darken, 0, 80, outFilters.darken);
  outFilters.objectFit = OBJECT_FITS.includes(filters.objectFit) ? filters.objectFit : outFilters.objectFit;
  outFilters.positionX = num(filters.positionX, 0, 100, outFilters.positionX);
  outFilters.positionY = num(filters.positionY, 0, 100, outFilters.positionY);
  outFilters.scale = num(filters.scale, 100, 200, outFilters.scale);

  const extRaw = isObject(raw.ext) ? raw.ext : {};
  const clampPick = (value, list, fallback) => (list.includes(value) ? value : fallback);
  out.ext.enabled = extRaw.enabled === true;
  const fxRaw = isObject(extRaw.fx) ? extRaw.fx : {};
  const clickRaw = isObject(fxRaw.click) ? fxRaw.click : {};
  out.ext.fx.click.enabled = clickRaw.enabled === true;
  out.ext.fx.click.style = clampPick(clickRaw.style, CLICK_STYLES, out.ext.fx.click.style);
  out.ext.fx.click.size = num(clickRaw.size, 40, 240, out.ext.fx.click.size);
  out.ext.fx.click.glow = num(clickRaw.glow, 0, 100, out.ext.fx.click.glow);
  out.ext.fx.click.colorMode = clampPick(clickRaw.colorMode, COLOR_MODES, out.ext.fx.click.colorMode);
  out.ext.fx.click.color = color(clickRaw.color, out.ext.fx.click.color);
  out.ext.fx.click.opacity = num(clickRaw.opacity, 0, 100, out.ext.fx.click.opacity);
  out.ext.fx.click.blend = clampPick(clickRaw.blend, BLEND_MODES, out.ext.fx.click.blend);
  const trailRaw = isObject(fxRaw.trail) ? fxRaw.trail : {};
  out.ext.fx.trail.enabled = trailRaw.enabled === true;
  out.ext.fx.trail.style = clampPick(trailRaw.style, TRAIL_STYLES, out.ext.fx.trail.style);
  out.ext.fx.trail.length = num(trailRaw.length, 80, 800, out.ext.fx.trail.length);
  out.ext.fx.trail.width = num(trailRaw.width, 1, 10, out.ext.fx.trail.width);
  out.ext.fx.trail.glow = num(trailRaw.glow, 0, 100, out.ext.fx.trail.glow);
  out.ext.fx.trail.colorMode = clampPick(trailRaw.colorMode, COLOR_MODES, out.ext.fx.trail.colorMode);
  out.ext.fx.trail.color = color(trailRaw.color, out.ext.fx.trail.color);
  out.ext.fx.trail.opacity = num(trailRaw.opacity, 0, 100, out.ext.fx.trail.opacity);
  out.ext.fx.trail.blend = clampPick(trailRaw.blend, BLEND_MODES, out.ext.fx.trail.blend);
  const parallaxRaw = isObject(extRaw.parallax) ? extRaw.parallax : {};
  out.ext.parallax.enabled = parallaxRaw.enabled === true;
  out.ext.parallax.bg = num(parallaxRaw.bg, 0, 3, out.ext.parallax.bg);
  out.ext.parallax.ui = num(parallaxRaw.ui, 0, 3, out.ext.parallax.ui);
  out.ext.parallax.mascot = num(parallaxRaw.mascot, 0, 3, out.ext.parallax.mascot);
  out.ext.parallax.smooth = num(parallaxRaw.smooth, 0, 100, out.ext.parallax.smooth);
  const depthsRaw = isObject(parallaxRaw.depths) ? parallaxRaw.depths : {};
  for (const key of ["chat", "composer", "sidebar", "bubble"]) out.ext.parallax.depths[key] = num(depthsRaw[key], 0, 3, out.ext.parallax.depths[key]);
  const avatarRaw = isObject(extRaw.avatar) ? extRaw.avatar : {};
  out.ext.avatar.enabled = avatarRaw.enabled === true;
  out.ext.avatar.size = num(avatarRaw.size, 24, 72, out.ext.avatar.size);
  out.ext.avatar.radius = num(avatarRaw.radius, 0, 100, out.ext.avatar.radius);
  out.ext.avatar.file = text(avatarRaw.file).trim().slice(0, 120);
  out.ext.avatar.image = /^data:image\/(png|jpeg|webp);base64,/.test(text(avatarRaw.image)) ? text(avatarRaw.image) : "";
  const mascotRaw = isObject(extRaw.mascot) ? extRaw.mascot : {};
  out.ext.mascot.enabled = mascotRaw.enabled === true;
  out.ext.mascot.form = clampPick(mascotRaw.form, EXT_FORMS, out.ext.mascot.form);
  out.ext.mascot.scale = num(mascotRaw.scale, 0.6, 1.4, out.ext.mascot.scale);
  out.ext.mascot.x = num(mascotRaw.x, 0, 100, out.ext.mascot.x);
  out.ext.mascot.y = num(mascotRaw.y, 0, 100, out.ext.mascot.y);
  out.ext.mascot.drag = mascotRaw.drag !== false;
  out.ext.mascot.file = text(mascotRaw.file).trim().slice(0, 120);
  out.ext.mascot.image = /^data:image\/(png|jpeg|webp);base64,/.test(text(mascotRaw.image)) ? text(mascotRaw.image) : "";
  out.activePreset = text(raw.activePreset).trim() ? text(raw.activePreset).trim().slice(0, 48) : out.activePreset;
  if (options.withPresets !== false) {
    const list = Array.isArray(raw.presets) ? raw.presets : [];
    for (const entry of list) {
      if (!isObject(entry) || typeof entry.name !== "string") continue;
      const values = normalizeAppearance(isObject(entry.values) ? entry.values : entry, { withPresets: false });
      values.presets = [];
      values.activePreset = entry.name.trim().slice(0, 48) || values.activePreset;
      out.presets.push({ name: values.activePreset, builtIn: entry.builtIn === true, values });
    }
  }
  return out;
}

/* Preset snapshots are full appearance objects (minus the preset list itself), so any
   field a later Phase adds is captured automatically. */
export function appearanceSnapshot(appearance) {
  const snapshot = normalizeAppearance(appearance, { withPresets: false });
  snapshot.presets = [];
  return snapshot;
}

function presetOf(name, values) {
  const snapshot = normalizeAppearance(values, { withPresets: false });
  snapshot.activePreset = name;
  snapshot.presets = [];
  return { name, builtIn: true, values: snapshot };
}
/* The five factory presets. Names and colour direction follow the DSH factory group
   (default / frosted / night / readable / vivid); every value is a full appearance
   snapshot, so fields added by later Phases land in the presets automatically. */
export const FACTORY_PRESETS = [
  presetOf("\u9ED1\u5BA2\u7EFF", {
    activePreset: "\u9ED1\u5BA2\u7EFF",
    glass: {
      enabled: true, blur: 9, alpha: 80, border: 90, scrim: 0.6, fidelity: 35,
      colorLight: "#266d3c", colorDark: "#266d3c",
      faces: { sidebarContent: "custom", conversation: "custom" },
      face: {
        sidebarContent: { blur: 8, alpha: 20, color: "#ffffff" },
        conversation: { blur: 8, alpha: 30, color: "#ffffff" }
      },
      sidebarRadius: 20
    },
    fonts: {
      caretColor: "#96ff00",
      roles: { secondary: { dark: "#00ff96" }, caption: { dark: "#96ff00" } },
      ui: { reasoning: "#00ff96" }
    },
    filters: { saturate: 150 }
  }),
  presetOf("\u78E8\u7802", {
    activePreset: "\u78E8\u7802",
    glass: {
      enabled: true, blur: 16, alpha: 70, border: 40, scrim: 0.25, fidelity: 0,
      colorLight: "#ffffff", colorDark: "#ffffff",
      faces: { sidebarContent: "custom", conversation: "custom" },
      face: {
        sidebarContent: { blur: 16, alpha: 35, color: "#ffffff" },
        conversation: { blur: 16, alpha: 45, color: "#ffffff" }
      },
      sidebarRadius: 24
    },
    filters: { saturate: 110 }
  }),
  presetOf("\u591C\u822A", {
    activePreset: "\u591C\u822A",
    glass: {
      enabled: true, blur: 12, alpha: 88, border: 25, scrim: 0.55, fidelity: 10,
      colorLight: "#0b1020", colorDark: "#0b1020",
      faces: { sidebarContent: "custom" },
      face: { sidebarContent: { blur: 12, alpha: 55, color: "#0b1020" } },
      sidebarRadius: 18
    },
    fonts: { caretColor: "#7dd3fc" },
    filters: { brightness: 85, darken: 20 }
  }),
  presetOf("\u53EF\u8BFB", {
    activePreset: "\u53EF\u8BFB",
    glass: {
      enabled: true, blur: 10, alpha: 92, border: 60, scrim: 0.72, fidelity: 0,
      colorLight: "#0a0f14", colorDark: "#0a0f14",
      faces: { sidebarContent: "custom" },
      face: { sidebarContent: { blur: 10, alpha: 70, color: "#0a0f14" } },
      sidebarRadius: 14
    },
    filters: { brightness: 92, contrast: 115 }
  }),
  presetOf("\u9C9C\u8273", {
    activePreset: "\u9C9C\u8273",
    glass: {
      enabled: true, blur: 6, alpha: 62, border: 70, scrim: 0.15, fidelity: 70,
      colorLight: "#ffffff", colorDark: "#ffffff",
      faces: { sidebarContent: "custom", conversation: "custom" },
      face: {
        sidebarContent: { blur: 6, alpha: 28, color: "#ffffff" },
        conversation: { blur: 6, alpha: 38, color: "#ffffff" }
      },
      sidebarRadius: 28
    },
    filters: { saturate: 165, contrast: 108, brightness: 105 }
  })
];

export function factoryPresets() {
  return FACTORY_PRESETS.map(entry => ({ name: entry.name, builtIn: true, values: normalizeAppearance(entry.values, { withPresets: false }) }));
}

/* The preset list always carries the factory entries; imports are appended after them.
   A stored preset whose name matches a factory one is treated as an override. */
export function withFactoryPresets(appearance) {
  const next = normalizeAppearance(appearance);
  const factoryNames = new Set(FACTORY_PRESETS.map(entry => entry.name));
  const overrides = new Map(next.presets.filter(entry => factoryNames.has(entry.name)).map(entry => [entry.name, entry]));
  const user = next.presets.filter(entry => !factoryNames.has(entry.name));
  next.presets = [
    ...factoryPresets().map(entry => overrides.get(entry.name) || entry),
    ...user
  ];
  if (!next.presets.some(entry => entry.name === next.activePreset)) next.activePreset = "\u81EA\u5B9A\u4E49";
  return next;
}

export function stateRoot(env = process.env) {
  return path.join(env.APPDATA || os.homedir(), "Codex", "luna-beautiful-codex");
}

export function appearancePrefsPath(env = process.env) {
  return path.join(stateRoot(env), "prefs.json");
}

const imageCache = new Map();
/* Uploaded avatar/mascot images live as files under uploads/; the page cannot read a
   path (CSP + no file access), so the Node half inlines them as data URLs for the
   handful of kilobytes a UI image needs. Cached by (path, mtime, size). */
export function hydrateExtImages(appearance, env = process.env) {
  const ext = appearance && appearance.ext;
  if (!ext) return appearance;
  for (const kind of ["avatar", "mascot"]) {
    const slot = ext[kind];
    if (!slot) continue;
    slot.image = "";
    const name = path.basename(String(slot.file || ""));
    if (!name) continue;
    const full = path.join(stateRoot(env), "uploads", name);
    try {
      const stat = fs.statSync(full);
      if (!stat.isFile() || stat.size <= 0 || stat.size > 3 * 1024 * 1024) continue;
      const key = full + ":" + stat.mtimeMs + ":" + stat.size;
      let data = imageCache.get(key);
      if (!data) {
        const extName = path.extname(full).toLowerCase();
        const mime = extName === ".png" ? "image/png" : extName === ".webp" ? "image/webp" : "image/jpeg";
        data = "data:" + mime + ";base64," + fs.readFileSync(full).toString("base64");
        imageCache.set(key, data);
        if (imageCache.size > 6) imageCache.delete(imageCache.keys().next().value);
      }
      slot.image = data;
    } catch (error) {}
  }
  return appearance;
}
export function readAppearancePrefs(env = process.env) {
  try {
    const stored = JSON.parse(fs.readFileSync(appearancePrefsPath(env), "utf8"));
    return hydrateExtImages(withFactoryPresets(stored && stored.appearance), env);
  } catch {
    return withFactoryPresets(null);
  }
}
/* Bumped whenever the page half changes. The watchdog compares it against the build the
   page latched on window.__lunaAppearance and re-injects on a mismatch, which is what
   makes a watchdog restart after a code update take effect on a page that is already
   running an older runtime (the panel node alone cannot tell the two apart). */
export const APPEARANCE_BUILD = "phase4+2026.10.18.1";
const BUILD_TOKEN = "__LUNA_APPEARANCE_BUILD__";

/* The page-side half. It is serialised with Function.prototype.toString() and evaluated
   inside the Codex page, so it must be fully self-contained: no imports, no closure over
   module scope. It owns the stylesheet, the surface marking and the "外观" panel, and it
   talks back to the watchdog only through dataset attributes (the page never fetches,
   which keeps the CSP baseline untouched). */
function pageRuntime() {
  const BUILD = "__LUNA_APPEARANCE_BUILD__";
  const FACE_ORDER = ["sidebar", "sidebarContent", "settingsWindow", "conversation", "thinkingTrigger", "floaters"];
  const FACE_LABELS = { sidebar: "左侧栏", sidebarContent: "侧栏内容区", settingsWindow: "设置窗（原生窗口）", conversation: "对话区", thinkingTrigger: "思考区", floaters: "浮层（按需）" };
  const FACE_MODES = ["inherit", "custom", "off"];
  const FACE_MODE_LABELS = { inherit: "跟随全局", custom: "独立", off: "关闭" };
  const OBJECT_FITS = ["cover", "contain", "fill"];
  const MAX_EXTRA_SELECTORS = 8;
  const MAX_EXTRA_SELECTOR_LENGTH = 120;
  const EXT_FORMS = ["whale", "cat", "rabbit", "fox", "penguin", "robot"];
  const CLICK_STYLES = ["ripple", "spark", "ring"];
  const TRAIL_STYLES = ["comet", "line", "dots"];
  const BLEND_MODES = ["screen", "normal", "overlay"];
  const COLOR_MODES = ["single", "rainbow"];
  const HOST_ID = "codex-appearance-panel";

  /* Selectors verified against the running Codex DOM. Every face keeps fallbacks and a
     face that cannot be located is skipped quietly, reported once through the log. */
  const FACE_SELECTORS = {
    sidebar: ["aside.app-shell-left-panel", "[data-codex-readability-surface=sidebar]"],
    sidebarContent: ["aside.app-shell-left-panel > div > div > div", "[data-app-action-sidebar-scroll]"],
    settingsWindow: ["[role=dialog][data-state=open]", "[aria-modal=true]", "[class*=_SettingsWindow_]", "[class*=_SettingsView_]", "[role=dialog]"],
    conversation: ["main[class*=_MainContentSurface_]", "main"],
    thinkingTrigger: [".thread-scroll-container [class*=\"group/activity-header\"]", "[data-markdown-text-style=reasoning]", "[class*=_Reasoning_]"],
    floaters: ["[role=menu][data-state=open]", "[data-radix-popper-content-wrapper] [role=menu]", "[role=listbox][data-state=open]", "[role=tooltip][data-state=open]", "[data-radix-popper-content-wrapper]"]
  };
  const ROLE_SELECTORS = {
    secondary: ["aside.app-shell-left-panel [data-app-action-sidebar-thread-title]", "[data-assistant-message-sent-time]", "[class*=_ComposerFooterLabel_]"],
    caption: ["[class*=_ComposerDropdownLabelText_]", ".thread-scroll-container [class*=\"group/activity-header\"] span"],
    body: ["#root"]
  };
  const COMPONENT_SELECTORS = {
    sidebar: ["aside.app-shell-left-panel"],
    titlebar: ["[data-app-shell-titlebar]", "main > header"],
    composer: ["[data-codex-composer-root]", "[class*=_ComposerLayoutRoot_]"],
    message: ["[data-user-message-bubble]", "[data-markdown-text-style=assistant-message]"]
  };
  const UI_SELECTORS = {
    link: ["#root a"],
    tab: ["#root [role=tab]"],
    sendButton: ["#root button[aria-label*=\"发送\"]", "#root button[type=submit]"],
    fileIcon: ["#root [data-file-icon]", "#root svg[class*=\"file\"]"],
    reasoning: [".thread-scroll-container [class*=\"group/activity-header\"] span"]
  };
  const MEDIA_SELECTOR = "#codex-custom-background-media";
  const CANVAS_SELECTOR = "#codex-custom-background-base canvas,#codex-custom-background-base-pending canvas,#codex-custom-background-base-pending-hover canvas";
  const ROLE_LABELS = { secondary: "次要文本", caption: "注脚", body: "正文" };
  const COMPONENT_LABELS = { sidebar: "侧栏", titlebar: "标题栏", composer: "输入框", message: "消息气泡" };
  const UI_LABELS = { sendButton: "发送按钮", link: "链接", fileIcon: "文件图标", tab: "页签", reasoning: "思考区文字" };
  const CORNER_LABELS = [["TL", "左上"], ["TR", "右上"], ["BR", "右下"], ["BL", "左下"]];

  const clamp = (value, lo, hi) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.min(hi, Math.max(lo, parsed)) : lo;
  };
  /* Glass economy is pushed by the watchdog through data-economy when a heavy
     WebGL scene cannot hold the frame budget with a viewport-sized blur. */
  const economyOn = () => {
    try { return document.getElementById(HOST_ID)?.dataset.economy === "1"; } catch { return false; }
  };
  /* Overlay menus/tooltips exist in the DOM permanently but stay display:none, so
     the floaters face must only bind to a node that is actually on screen. */
  const firstVisibleMatch = list => {
    for (const selector of list) {
      let nodes = [];
      try { nodes = document.querySelectorAll(selector); } catch { continue; }
      for (const node of nodes) {
        try {
          const style = getComputedStyle(node);
          if (style.display !== "none" && style.visibility !== "hidden" && node.getClientRects().length) return node;
        } catch {}
      }
    }
    return null;
  };
  const firstMatch = list => {
    for (const selector of list) {
      try { const found = document.querySelector(selector); if (found) return found; } catch {}
    }
    return null;
  };
  const isDarkTheme = () => {
    try {
      const root = document.documentElement;
      if (root.classList.contains("dark") || root.dataset.theme === "dark") return true;
      if (root.classList.contains("light") || root.dataset.theme === "light") return false;
    } catch {}
    try { return !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches); } catch {}
    return true;
  };
  const hexToRgb = value => {
    const raw = String(value || "").trim().replace(/^#/, "");
    if (raw.length === 3) return [0, 1, 2].map(index => parseInt(raw[index] + raw[index], 16));
    if (raw.length === 6 || raw.length === 8) return [0, 2, 4].map(index => parseInt(raw.slice(index, index + 2), 16));
    return [0, 0, 0];
  };
  const rgba = (hex, alpha) => {
    const [r, g, b] = hexToRgb(hex);
    return "rgba(" + r + "," + g + "," + b + "," + clamp(alpha, 0, 1).toFixed(3) + ")";
  };
  const extraSelectors = text => {
    if (typeof text !== "string") return [];
    const out = [];
    for (const raw of text.split(/[\n,]+/)) {
      const entry = raw.trim();
      if (!entry) continue;
      if (entry.length > MAX_EXTRA_SELECTOR_LENGTH) continue;
      if (out.length >= MAX_EXTRA_SELECTORS) break;
      out.push(entry);
    }
    return out;
  };

  /* The readability sheet (inject-background-controls.mjs) owns the same surfaces we do:
     body[data-codex-readability-mode=soft] #root main[data-codex-readability-surface] lands
     at (1,2,2) and pins border-radius:0 / backdrop-filter:none, while every text colour is
     forced through #root *:not(#codex-force-white) at (2,0,0). Both outrank a plain
     #root [data-codex-glass="x"] (1,1,0), which silently swallowed an enabled glass face,
     the sidebar radius and the role colours. Repeating :not(#codex-force-white) lifts an
     appearance rule clear of that sheet without editing it. */
  const LIFT = ":not(#codex-force-white)";
  const lifted = selector => (String(selector).includes("#codex-force-white") ? String(selector) : String(selector) + LIFT + LIFT);

  let state = null;
  let message = null;
  const log = (level, text) => {
    try {
      const queue = window.__codexAppearanceLog || (window.__codexAppearanceLog = []);
      queue.push({ level, text: String(text).slice(0, 200), t: Math.round(performance.now()) });
      if (queue.length > 20) queue.shift();
    } catch {}
  };

  /* Re-inserting a sheet costs a full style recalc, so only touch the node when the
     text actually changed. */
  const writeStyle = (id, text) => {
    const existing = document.getElementById(id);
    if (existing && existing.textContent === text) return;
    if (existing) existing.remove();
    if (!text) return;
    const style = document.createElement("style");
    style.id = id;
    style.textContent = text;
    document.head.append(style);
  };
  /* ---------- glass ---------- */
  const surfaceCss = (appearance, dark) => {
    const glass = appearance.glass || {};
    if (!glass.enabled) return "";
    /* #root * carries "background: transparent !important, backdrop-filter: none
       !important" and the readability sheet pins the sidebar/conversation surfaces, so
       every glass rule is lifted past both (see LIFT above). */
    const borderChannel = dark ? "255,255,255" : "0,0,0";
    const saturation = (1 + Number(glass.fidelity || 0) / 100).toFixed(2);
    const borderAlpha = (Number(glass.border || 0) / 100).toFixed(2);
    const rules = [];
    for (const face of FACE_ORDER) {
      const mode = (glass.faces || {})[face] || "inherit";
      if (mode === "off") continue;
      const own = (glass.face || {})[face] || {};
      /* sidebarFollowGlobal makes the sidebar ignore its own custom values, which is
         how DSH keeps the sidebar tied to the global glass. */
      const useOwn = mode === "custom" && !(face === "sidebar" && glass.sidebarFollowGlobal !== false);
      const blur = clamp(useOwn ? own.blur : glass.blur, 0, 60);
      const alpha = clamp(useOwn ? own.alpha : glass.alpha, 0, 100);
      const base = dark ? glass.colorDark : glass.colorLight;
      const color = useOwn ? (own.color || base) : base;
      /* Economy mode (heavy WebGL scene) drops only the conversation backdrop blur:
         that surface is viewport-sized and owns almost all of the compositor cost,
         while tint/border/radius keep the glass visibly on. */
      const declarations = [
        "background:" + rgba(color, alpha / 100) + " !important"
      ];
      if (!(economyOn() && face === "conversation")) {
        declarations.push(
          "backdrop-filter:blur(" + blur + "px) saturate(" + saturation + ") !important",
          "-webkit-backdrop-filter:blur(" + blur + "px) saturate(" + saturation + ") !important"
        );
      }
      declarations.push("border:1px solid rgba(" + borderChannel + "," + borderAlpha + ") !important");
      if (face === "sidebar") {
        const radius = clamp(glass.sidebarRadius, 0, 40);
        const corners = [
          glass.sidebarSquareTL ? "0" : radius + "px",
          glass.sidebarSquareTR ? "0" : radius + "px",
          glass.sidebarSquareBR ? "0" : radius + "px",
          glass.sidebarSquareBL ? "0" : radius + "px"
        ].join(" ");
        declarations.push("border-radius:" + corners + " !important");
        if (glass.sidebarFullClear) declarations.push("background:transparent !important", "border-color:transparent !important");
      }
      rules.push(lifted("#root [data-codex-glass=\"" + face + "\"]") + "{" + declarations.join(";") + "}");
    }
    /* Extra frosting: a lone ::before blurs whatever sits underneath without owning the
       element itself, so the element's own children (and its floaters) stay untouched. */
    for (const selector of extraSelectors(glass.extraSelectors)) {
      rules.push(lifted(selector) + "::before{content:\"\"!important;position:absolute!important;inset:0!important;pointer-events:none!important;z-index:-1!important;backdrop-filter:blur(" + clamp(glass.blur, 0, 60) + "px) saturate(" + saturation + ") !important;-webkit-backdrop-filter:blur(" + clamp(glass.blur, 0, 60) + "px) saturate(" + saturation + ") !important;background:" + rgba(dark ? glass.colorDark : glass.colorLight, Number(glass.alpha || 0) / 100) + " !important}");
    }
    return rules.join("\n");
  };

  /* ---------- typography and colour ---------- */
  const fontCss = (appearance, dark) => {
    const fonts = appearance.fonts || {};
    const rules = [];
    if (fonts.globalFamily) rules.push(lifted("#root") + "{font-family:" + fonts.globalFamily + " !important}");
    if (fonts.caretColor) rules.push(lifted("#root") + "," + lifted("#root *") + "{caret-color:" + fonts.caretColor + " !important}");
    for (const role of Object.keys(ROLE_LABELS)) {
      const value = (fonts.roles || {})[role] || {};
      const color = dark ? value.dark : value.light;
      const declarations = [];
      if (value.family) declarations.push("font-family:" + value.family + " !important");
      if (value.size) declarations.push("font-size:" + value.size + " !important");
      if (value.weight) declarations.push("font-weight:" + value.weight + " !important");
      if (color) declarations.push("color:" + color + " !important");
      if (!declarations.length) continue;
      for (const selector of ROLE_SELECTORS[role] || []) rules.push(lifted(selector) + "{" + declarations.join(";") + "}");
    }
    for (const key of Object.keys(COMPONENT_LABELS)) {
      const value = (fonts.components || {})[key] || {};
      const declarations = [];
      if (value.family) declarations.push("font-family:" + value.family + " !important");
      if (value.size) declarations.push("font-size:" + value.size + " !important");
      if (!declarations.length) continue;
      for (const selector of COMPONENT_SELECTORS[key]) rules.push(lifted(selector) + "{" + declarations.join(";") + "}");
    }
    for (const key of Object.keys(UI_LABELS)) {
      const color = (fonts.ui || {})[key];
      if (!color) continue;
      for (const selector of UI_SELECTORS[key]) rules.push(lifted(selector) + "{color:" + color + " !important;fill:" + color + " !important}");
    }
    return rules.join("\n");
  };
  /* ---------- wallpaper filter and framing ---------- */
  const filterCss = appearance => {
    const filters = appearance.filters || {};
    const blur = clamp(filters.blur, 0, 20);
    const parts = [];
    if (blur) parts.push("blur(" + blur + "px)");
    if (Number(filters.brightness) !== 100) parts.push("brightness(" + clamp(filters.brightness, 0, 200) + "%)");
    if (Number(filters.contrast) !== 100) parts.push("contrast(" + clamp(filters.contrast, 0, 200) + "%)");
    if (Number(filters.saturate) !== 100) parts.push("saturate(" + clamp(filters.saturate, 0, 200) + "%)");
    /* Background opacity rides inside the filter list on purpose: the readability panel
       already owns the element's opacity declaration, and two !important sheets on one
       property would make the winner depend on insertion order. A blur also samples
       transparent pixels past a viewport-sized layer, so the layer is scaled up to keep
       its edges covered (blur 20px -> 1.2x). */
    if (Number(filters.opacity) !== 100) parts.push("opacity(" + (clamp(filters.opacity, 5, 100) / 100).toFixed(3) + ")");
    const zoom = clamp(filters.scale, 100, 200) / 100 * (1 + blur / 100);
    const shiftX = ((clamp(filters.positionX, 0, 100) - 50) / 50) * 4;
    const shiftY = ((clamp(filters.positionY, 0, 100) - 50) / 50) * 4;
    const rules = [];
    if (parts.length) rules.push(MEDIA_SELECTOR + "{filter:" + parts.join(" ") + " !important}");
    const canvasRules = [];
    if (parts.length) canvasRules.push("filter:" + parts.join(" ") + " !important");
    const transform = [];
    if (shiftX || shiftY) transform.push("translate(" + shiftX.toFixed(2) + "%," + shiftY.toFixed(2) + "%)");
    if (transform.length || zoom !== 1) transform.push("scale(" + zoom.toFixed(3) + ")");
    if (transform.length) canvasRules.push("transform:" + transform.join(" ") + " !important");
    if (canvasRules.length) rules.push(CANVAS_SELECTOR + "{" + canvasRules.join(";") + "}");
    return rules.join("\n");
  };

  /* framing (object-fit/object-position/scale) is applied through the style object, not a
     sheet: the install path writes object-fit inline with !important, and an inline
     !important declaration always outranks a stylesheet one. */
  const framingTargets = () => {
    const out = [];
    const media = document.getElementById("codex-custom-background-media");
    if (media && (media.tagName === "VIDEO" || media.tagName === "IMG")) out.push({ node: media, native: true });
    try { document.querySelectorAll(CANVAS_SELECTOR).forEach(node => out.push({ node, native: false })); } catch {}
    return out;
  };

  const applyFraming = appearance => {
    const filters = appearance.filters || {};
    const zoom = clamp(filters.scale, 100, 200) / 100;
    const shiftX = ((clamp(filters.positionX, 0, 100) - 50) / 50) * 4;
    const shiftY = ((clamp(filters.positionY, 0, 100) - 50) / 50) * 4;
    for (const target of framingTargets()) {
      try {
        if (target.native) {
          target.node.style.setProperty("object-fit", OBJECT_FITS.includes(filters.objectFit) ? filters.objectFit : "cover", "important");
          target.node.style.setProperty("object-position", clamp(filters.positionX, 0, 100) + "% " + clamp(filters.positionY, 0, 100) + "%", "important");
          if (zoom !== 1) target.node.style.setProperty("transform", "scale(" + zoom.toFixed(3) + ")", "important");
          else target.node.style.removeProperty("transform");
        } else {
          const transform = [];
          if (shiftX || shiftY) transform.push("translate(" + shiftX.toFixed(2) + "%," + shiftY.toFixed(2) + "%)");
          if (transform.length || zoom !== 1) transform.push("scale(" + zoom.toFixed(3) + ")");
          if (transform.length) target.node.style.setProperty("transform", transform.join(" "), "important");
          else target.node.style.removeProperty("transform");
        }
      } catch {}
    }
  };

  /* The filter darken and the glass scrim both want to sit between the wallpaper and
     #root, so they share one overlay whose alpha is the union of the two. #root is
     z-index 1 and the wallpaper layers are z-index 0, so a z-index 0 overlay appended
     last still paints behind the app but above the wallpaper. */
  const shadeAlpha = appearance => {
    const darken = clamp((appearance.filters || {}).darken, 0, 80) / 100;
    const scrim = (appearance.glass || {}).enabled ? clamp((appearance.glass || {}).scrim, 0, 1) : 0;
    return 1 - (1 - darken) * (1 - scrim);
  };

  const applyShade = appearance => {
    const alpha = shadeAlpha(appearance);
    const node = document.getElementById("codex-wallpaper-shade");
    if (alpha <= 0.001) {
      if (node) node.remove();
      return;
    }
    const target = node || document.createElement("div");
    if (!node) {
      target.id = "codex-wallpaper-shade";
      document.body.append(target);
    }
    const cssText = "position:fixed!important;inset:0!important;z-index:0!important;pointer-events:none!important;display:block!important;background:rgba(0,0,0," + alpha.toFixed(3) + ")";
    if (target.style.cssText !== cssText) target.style.cssText = cssText;
  };
  /* ---------- surface marking ---------- */
  const markedFaces = new Map();
  const missingReported = new Set();
  let markTimer = null;
  let dark = true;

  const markFaces = () => {
    if (!state) return;
    const glass = state.glass || {};
    for (const face of FACE_ORDER) {
      const mode = (glass.faces || {})[face] || "inherit";
      const active = !!glass.enabled && mode !== "off";
      const previous = markedFaces.get(face);
      const node = active ? (face === "floaters" ? firstVisibleMatch(FACE_SELECTORS[face]) : firstMatch(FACE_SELECTORS[face])) : null;
      if (previous && previous !== node) {
        markedFaces.delete(face);
        try { if (previous.getAttribute("data-codex-glass") === face) previous.removeAttribute("data-codex-glass"); } catch {}
      }
      if (!node) {
        if (active && !missingReported.has(face)) {
          missingReported.add(face);
          log("info", "glass face not located, skipped: " + face);
        }
        continue;
      }
      /* Stale marks survive a React re-render of the same face, so the attribute is only
         rewritten when it actually differs. */
      if (node.getAttribute("data-codex-glass") !== face) node.setAttribute("data-codex-glass", face);
      markedFaces.set(face, node);
    }
  };

  const apply = next => {
    state = next;
    dark = isDarkTheme();
    writeStyle("codex-glass-style", surfaceCss(state, dark));
    writeStyle("codex-font-style", fontCss(state, dark));
    writeStyle("codex-filter-style", filterCss(state));
    markFaces();
    applyFraming(state);
    applyShade(state);
    try { if (window.__lunaExt) window.__lunaExt.apply(state.ext || null); } catch (error) { log("error", "ext apply failed: " + (error && error.message)); }
    return {
      ok: true,
      glass: !!state.glass.enabled,
      faces: FACE_ORDER.filter(face => document.querySelector("[data-codex-glass=\"" + face + "\"]")),
      extraSelectors: extraSelectors(state.glass.extraSelectors).length,
      shade: Number(shadeAlpha(state).toFixed(3)),
      economy: economyOn()
    };
  };

  /* New wallpaper layers are created on every switch, and the framing written through
     the style object dies with them, so watch body childList (subtree:false keeps this
     cheap) and re-run the marking pass once the swap settles. */
  const scheduleMark = () => {
    if (markTimer) return;
    markTimer = setTimeout(() => {
      markTimer = null;
      if (!state) return;
      try { markFaces(); applyFraming(state); } catch (error) { log("error", "mark failed: " + (error && error.message)); }
      /* A wallpaper switch creates a fresh base layer; parallax has to rebind to it. */
      try { if (state.ext && state.ext.parallax && state.ext.parallax.enabled && window.__lunaExt) window.__lunaExt.refresh(); } catch (error) {}
    }, 120);
  };

  const watch = () => {
    if (window.__lunaAppearanceObserver) window.__lunaAppearanceObserver.disconnect();
    window.__lunaAppearanceObserver = new MutationObserver(scheduleMark);
    window.__lunaAppearanceObserver.observe(document.body, { childList: true, subtree: false });
    return true;
  };

  const host = () => document.getElementById(HOST_ID);
  /* ---------- the 外观 panel ---------- */
  const PANEL_CSS = [
    ":host{all:initial;font-family:\"Segoe UI\",\"Microsoft YaHei\",sans-serif;color:#f4f7ff}",
    "*{box-sizing:border-box}",
    ".chip{pointer-events:auto;display:inline-flex;align-items:center;gap:6px;padding:9px 12px;border:1px solid rgba(255,255,255,.24);border-radius:12px;background:rgba(9,15,26,.9);color:#f4f7ff;font:700 12px/1 inherit;cursor:pointer;box-shadow:0 10px 30px #0007}",
    ".chip:hover{background:rgba(30,50,80,.95)}",
    ".panel{pointer-events:auto;display:none;position:absolute;right:0;bottom:54px;width:min(342px,calc(100vw - 44px));max-height:min(74vh,660px);flex-direction:column;border:1px solid rgba(255,255,255,.18);border-radius:16px;background:rgba(8,13,24,.96);box-shadow:0 18px 55px #0009;overflow:hidden}",
    ".panel.open{display:flex}",
    ".head{display:flex;justify-content:space-between;align-items:center;padding:12px 14px 10px;border-bottom:1px solid rgba(255,255,255,.1)}",
    ".title{font:700 14px/1 inherit}",
    ".close{width:26px;height:26px;border:0;border-radius:8px;background:rgba(255,255,255,.14);color:#fff;cursor:pointer;font:700 14px/1 inherit}",
    ".body{overflow:auto;padding:6px 14px 2px}",
    ".msg{margin:0;padding:8px 14px 12px;font:600 11.5px/1.4 inherit;color:#a7b6ce;min-height:16px}",
    ".msg.err{color:#fca5a5}",
    "details{border-bottom:1px solid rgba(255,255,255,.08)}",
    "summary{cursor:pointer;padding:10px 0;font:700 12.5px/1 inherit;color:#cfe0f5;list-style:none}",
    "summary::-webkit-details-marker{display:none}",
    "summary:before{content:\"\\25B8 \";color:#7dd3fc}",
    "details[open] summary:before{content:\"\\25BE \"}",
    ".row{margin:8px 0 10px}",
    ".row label{display:flex;justify-content:space-between;align-items:baseline;gap:8px;font:600 12px/1.35 inherit;color:#c7d5e8}",
    ".row output{font:700 11.5px/1 inherit;color:#7dd3fc;white-space:nowrap}",
    ".row input[type=range]{width:100%;height:24px;margin:2px 0 0;accent-color:#38bdf8}",
    ".row input[type=text],.row textarea{width:100%;margin-top:5px;padding:6px 8px;border:1px solid rgba(255,255,255,.18);border-radius:8px;background:rgba(255,255,255,.06);color:#f4f7ff;font:500 12px/1.3 inherit}",
    ".row textarea{resize:vertical;min-height:54px;font-family:ui-monospace,Consolas,monospace}",
    ".row input[type=color]{width:100%;height:28px;margin-top:5px;padding:0;border:1px solid rgba(255,255,255,.18);border-radius:8px;background:transparent}",
    ".grid2{display:grid;grid-template-columns:1fr 1fr;gap:8px}",
    ".grid3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;margin-top:5px}",
    ".grid4{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-top:5px}",
    ".toggle{width:100%;padding:8px 6px;border:1px solid rgba(255,255,255,.16);border-radius:9px;background:rgba(255,255,255,.06);color:#dbe7f7;font:650 11.5px/1.25 inherit;cursor:pointer}",
    ".toggle.on{background:rgba(56,189,248,.36);border-color:rgba(125,211,252,.7);color:#fff}",
    ".faces{display:flex;flex-direction:column;gap:6px;margin-top:6px}",
    ".face{border:1px solid rgba(255,255,255,.12);border-radius:10px;padding:7px 8px}",
    ".face .line{display:grid;grid-template-columns:1fr 108px;gap:6px;align-items:center}",
    ".face .name{font:600 12px/1.2 inherit;color:#dce7f6}",
    ".face .custom{display:grid;grid-template-columns:1fr 1fr 44px;gap:6px;margin-top:6px;align-items:center}",
    ".face .custom.idle{opacity:.35}",
    ".note{margin-top:4px;font:500 10.5px/1.35 inherit;color:#8fa3bd}",
    ".face input[type=range]{width:100%;height:22px;accent-color:#38bdf8}",
    ".face input[type=color]{width:100%;height:22px;padding:0;border:1px solid rgba(255,255,255,.18);border-radius:6px;background:transparent}",
    ".face select{width:100%;padding:5px 6px;border:1px solid rgba(255,255,255,.18);border-radius:8px;background:rgba(255,255,255,.06);color:#f4f7ff;font:500 12px/1.2 inherit}",
    ".presets{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:6px}",
    ".pbtn{padding:9px 6px;border:1px solid rgba(255,255,255,.16);border-radius:9px;background:rgba(255,255,255,.06);color:#e6eefb;font:650 11.5px/1.3 inherit;cursor:pointer;text-align:center}",
    ".pbtn.active{background:rgba(56,189,248,.4);border-color:rgba(125,211,252,.75);color:#fff}",
    ".pbtn.confirm{background:rgba(248,113,113,.45);border-color:rgba(252,165,165,.8)}",
    ".actions{display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;margin-top:8px}",
    ".actions button{padding:8px 4px;border:1px solid rgba(255,255,255,.16);border-radius:9px;background:rgba(56,189,248,.2);color:#f2f7ff;font:650 11px/1.2 inherit;cursor:pointer}",
    ".hint{font:500 11px/1.45 inherit;color:#8fa2bb;margin:2px 0 10px}",
    "#dump{display:none;min-height:76px}",
    "#debugButton{width:100%;margin:2px 0 10px;padding:8px;border:1px solid rgba(255,255,255,.16);border-radius:9px;background:rgba(255,255,255,.06);color:#dbe7f7;font:650 11.5px/1.2 inherit;cursor:pointer}"
  ].join("");

  const PANEL_SHELL = [
    "<button class=\"chip\" id=\"chip\">外观</button>",
    "<div class=\"panel\" id=\"panel\">",
    "<div class=\"head\"><div class=\"title\">外观 · 液态玻璃</div><button class=\"close\" id=\"close\">\u00d7</button></div>",
    "<div class=\"body\" id=\"body\"></div>",
    "<div class=\"msg\" id=\"msg\"></div>",
    "</div>"
  ].join("");

  const buildPanel = () => {
    const node = host();
    if (!node) return null;
    if (node.shadowRoot) return node.shadowRoot;
    node.style.cssText = "position:fixed!important;right:22px!important;bottom:118px!important;z-index:2147483645!important;display:block!important;visibility:visible!important;opacity:1!important;pointer-events:none!important";
    const shadow = node.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = PANEL_CSS;
    shadow.append(style);
    const shell = document.createElement("div");
    shell.innerHTML = PANEL_SHELL;
    while (shell.firstChild) shadow.append(shell.firstChild);
    return shadow;
  };
  const syncers = [];
  const subSyncers = [];
  let presetRedraw = null;

  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  };
  const section = (parent, title, open) => {
    const wrap = el("details");
    if (open) wrap.open = true;
    wrap.append(el("summary", null, title));
    parent.append(wrap);
    return wrap;
  };
  /* Phase 4: the panel now has well over a hundred controls. Building every
     section up front cost ~100ms on open, so only the default-open group is
     built eagerly and the rest are created on their first expand. Any section
     that is built later runs the syncers once so it reflects the live state. */
  const lazySection = (parent, title, open, build) => {
    const wrap = el("details");
    wrap.append(el("summary", null, title));
    const holder = el("div", "sectionBody");
    wrap.append(holder);
    let built = false;
    const run = () => {
      if (built) return;
      built = true;
      try { build(holder); } catch (error) { try { log("error", "panel section failed: " + (error && error.message)); } catch {} }
      syncersRun();
    };
    wrap.addEventListener("toggle", () => { if (wrap.open) run(); });
    parent.append(wrap);
    if (open) { wrap.open = true; run(); }
    return wrap;
  };
  const syncersRun = () => {
    for (const run of syncers.concat(subSyncers)) { try { run(); } catch {} }
  };
  const format = (value, unit) => {
    const number = Number(value);
    if (unit === "px") return Math.round(number) + "px";
    if (unit === "%") return Math.round(number) + "%";
    return String(Number(number.toFixed(2)));
  };
  const bind = (input, path) => {
    input.dataset.path = path;
    return input;
  };
  const rangeRow = (parent, path, label, min, max, step, unit) => {
    const row = el("div", "row");
    const lab = el("label");
    const out = el("output");
    lab.append(document.createTextNode(label), out);
    const input = bind(el("input"), path);
    input.type = "range";
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    row.append(lab, input);
    parent.append(row);
    syncers.push(() => {
      const value = Number(getPath(state, path));
      input.value = String(value);
      out.textContent = format(value, unit);
    });
    return input;
  };
  const colorRow = (parent, path, label) => {
    const row = el("div", "row");
    const lab = el("label");
    const out = el("output");
    lab.append(document.createTextNode(label), out);
    const input = bind(el("input"), path);
    input.type = "color";
    row.append(lab, input);
    parent.append(row);
    syncers.push(() => {
      const value = String(getPath(state, path) || "");
      input.value = /^#[0-9a-fA-F]{6}$/.test(value) ? value : "#000000";
      out.textContent = value || "—";
    });
    return input;
  };
  const textRow = (parent, path, label, placeholder) => {
    const row = el("div", "row");
    const lab = el("label");
    lab.append(document.createTextNode(label));
    const input = bind(el("input"), path);
    input.type = "text";
    input.placeholder = placeholder || "";
    row.append(lab, input);
    parent.append(row);
    syncers.push(() => { input.value = String(getPath(state, path) || ""); });
    return input;
  };
  const selectRow = (parent, path, label, options) => {
    const row = el("div", "row");
    const lab = el("label");
    lab.append(document.createTextNode(label));
    const select = bind(el("select"), path);
    for (const value of options) {
      const option = el("option", null, value);
      option.value = value;
      select.append(option);
    }
    row.append(lab, select);
    parent.append(row);
    syncers.push(() => { select.value = String(getPath(state, path) || ""); });
    return select;
  };
  const selectLabeled = (parent, path, label, options, labels) => {
    const row = el("div", "row");
    const lab = el("label");
    lab.append(document.createTextNode(label));
    const select = bind(el("select"), path);
    for (const value of options) {
      const option = el("option", null, (labels && labels[value]) || value);
      option.value = value;
      select.append(option);
    }
    row.append(lab, select);
    parent.append(row);
    syncers.push(() => { select.value = String(getPath(state, path) || ""); });
    return select;
  };
  const toggleRow = (parent, path, label) => {
    const row = el("div", "row");
    const button = bind(el("button", "toggle"), path);
    row.append(button);
    parent.append(row);
    syncers.push(() => {
      const on = getPath(state, path) === true;
      button.classList.toggle("on", on);
      button.textContent = label + (on ? " · 开" : " · 关");
    });
    return button;
  };
  const optionalColorRow = (parent, path, label) => {
    const row = el("div", "row");
    const lab = el("label");
    lab.append(document.createTextNode(label));
    const inline = el("div", "grid2");
    const input = bind(el("input"), path);
    input.type = "color";
    const clear = bind(el("button", "toggle"), path);
    clear.dataset.clear = "1";
    inline.append(input, clear);
    row.append(lab, inline);
    parent.append(row);
    syncers.push(() => {
      const value = String(getPath(state, path) || "");
      input.value = /^#[0-9a-fA-F]{6}$/.test(value) ? value : "#ffffff";
      clear.textContent = value ? "清空（当前 " + value + "）" : "未设置";
      clear.classList.toggle("on", !!value);
    });
    return { input, clear };
  };

  const getPath = (root, dotted) => dotted.split(".").reduce((acc, key) => (acc == null ? acc : acc[key]), root);
  const setPath = (root, dotted, value) => {
    const parts = dotted.split(".");
    let cursor = root;
    for (let index = 0; index < parts.length - 1; index += 1) {
      if (typeof cursor[parts[index]] !== "object" || cursor[parts[index]] === null) cursor[parts[index]] = {};
      cursor = cursor[parts[index]];
    }
    cursor[parts[parts.length - 1]] = value;
  };
  const presetList = () => (Array.isArray(state.presets) ? state.presets : []);
  const say = (text, error) => {
    if (!message) return;
    message.textContent = text;
    message.classList.toggle("err", !!error);
  };
  /* Persistence goes through a dataset attribute, never through fetch: the page keeps its
     CSP baseline untouched and the watchdog picks the command up on its next status tick
     (120ms while the picker is open, 800ms idle). The local apply already happened, so
     the tick latency is invisible. */
  const persistable = () => {
    const copy = JSON.parse(JSON.stringify(state));
    if (copy.ext) {
      if (copy.ext.avatar) copy.ext.avatar.image = "";
      if (copy.ext.mascot) copy.ext.mascot.image = "";
    }
    return copy;
  };
  const queueSave = () => {
    const node = host();
    if (!node || !state) return;
    try { node.dataset.prefsCommand = JSON.stringify({ appearance: persistable() }); } catch {}
  };
  let saveTimer = null;
  const debouncedSave = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { saveTimer = null; queueSave(); }, 150);
  };
  const applyNormalized = next => {
    const result = apply(next);
    if (presetRedraw) { try { presetRedraw(); } catch {} }
    syncersRun();
    debouncedSave();
    return result;
  };

  const renderPresets = body => lazySection(body, "预设", false, wrap => {
    const list = el("div", "presets");
    /* Two-step confirm instead of window.confirm(): a blocking dialog on an unfocused
       window would freeze the page the watchdog is driving. */
    const draw = () => {
      list.textContent = "";
      for (const preset of presetList()) {
        const button = el("button", "pbtn", preset.name + (preset.builtIn ? "" : " · 导入"));
        button.classList.toggle("active", state.activePreset === preset.name);
        let armed = false;
        let disarmed = null;
        const restore = () => {
          if (disarmed) clearTimeout(disarmed);
          disarmed = null;
          armed = false;
          button.classList.remove("confirm");
          button.textContent = preset.name + (preset.builtIn ? "" : " · 导入");
        };
        button.addEventListener("click", () => {
          if (!armed) {
            armed = true;
            button.classList.add("confirm");
            button.textContent = "确认套用？将覆盖当前外观设置";
            disarmed = setTimeout(restore, 3200);
            return;
          }
          if (disarmed) clearTimeout(disarmed);
          armed = false;
          const kept = presetList().map(entry => ({ name: entry.name, builtIn: entry.builtIn, values: entry.values }));
          const next = JSON.parse(JSON.stringify(preset.values));
          next.presets = kept;
          next.activePreset = preset.name;
          applyNormalized(next);
          say("已套用预设：" + preset.name);
        });
        list.append(button);
      }
    };
    draw();
    presetRedraw = draw;
    wrap.append(list);

    const actions = el("div", "actions");
    const exportButton = el("button", null, "导出 JSON");
    const importButton = el("button", null, "导入 JSON");
    const saveButton = el("button", null, "存为预设");
    actions.append(exportButton, importButton, saveButton);
    wrap.append(actions);
    wrap.append(el("div", "hint", "导出会下载 JSON 并把内容填进下方文本框（便于手动复制）；导入只加入列表，不会自动套用，非法 JSON 只会报错、不动现有配置。"));

    const fileInput = el("input");
    fileInput.type = "file";
    fileInput.accept = ".json,application/json";
    fileInput.style.display = "none";
    wrap.append(fileInput);
    const dump = el("textarea");
    dump.id = "dump";
    wrap.append(dump);

    exportButton.addEventListener("click", () => {
      const values = JSON.parse(JSON.stringify(state));
      values.presets = [];
      const payload = { type: "luna-appearance-preset@1", name: state.activePreset || "自定义", values };
      const json = JSON.stringify(payload, null, 2);
      dump.value = json;
      let downloaded = false;
      try {
        const blob = new Blob([json], { type: "application/json" });
        const anchor = document.createElement("a");
        anchor.href = URL.createObjectURL(blob);
        anchor.download = "luna-appearance-" + (state.activePreset || "custom") + ".json";
        anchor.style.display = "none";
        document.body.append(anchor);
        anchor.click();
        setTimeout(() => { try { URL.revokeObjectURL(anchor.href); anchor.remove(); } catch {} }, 4000);
        downloaded = true;
      } catch {}
      dump.style.display = "block";
      say(downloaded ? "已导出 JSON（已下载，下方文本框也可复制）" : "下载被拦截，请从下方文本框复制 JSON");
    });
    importButton.addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", () => {
      const file = fileInput.files && fileInput.files[0];
      fileInput.value = "";
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const parsed = JSON.parse(String(reader.result || ""));
          const values = parsed && parsed.values ? parsed.values : parsed;
          if (!values || typeof values !== "object" || Array.isArray(values)) throw new Error("shape");
          const normalized = normalize(values, { withPresets: false });
          normalized.presets = [];
          const name = String((parsed && parsed.name) || file.name.replace(/\.json$/i, "")).trim().slice(0, 48) || "导入预设";
          normalized.activePreset = name;
          const entries = presetList().slice();
          const index = entries.findIndex(entry => entry.name === name);
          const entry = { name, builtIn: false, values: normalized };
          if (index >= 0) entries[index] = entry; else entries.push(entry);
          state.presets = entries;
          draw();
          debouncedSave();
          say("已导入预设：" + name + "（点击该按钮可套用）");
        } catch (error) {
          say("导入失败：不是有效的预设 JSON，当前配置未变。", true);
        }
      };
      reader.onerror = () => say("导入失败：无法读取文件。", true);
      reader.readAsText(file);
    });
    saveButton.addEventListener("click", () => {
      const suggested = state.activePreset === "自定义" ? "我的预设" : state.activePreset;
      const answer = window.prompt("预设名称", suggested);
      if (answer == null) return;
      const name = String(answer).trim().slice(0, 48);
      if (!name) { say("预设名称不能为空。", true); return; }
      const values = JSON.parse(JSON.stringify(state));
      values.presets = [];
      values.activePreset = name;
      const entries = presetList().slice();
      const index = entries.findIndex(entry => entry.name === name);
      const entry = { name, builtIn: false, values };
      if (index >= 0) entries[index] = entry; else entries.push(entry);
      state.presets = entries;
      state.activePreset = name;
      draw();
      debouncedSave();
      say("已保存预设：" + name);
    });
  });
  const renderGlass = body => lazySection(body, "液态玻璃", true, wrap => {
    const head = el("div", "grid2");
    wrap.append(head);
    toggleRow(head, "glass.enabled", "启用玻璃");
    rangeRow(head, "glass.blur", "全局模糊", 0, 40, 1, "px");
    rangeRow(head, "glass.alpha", "全局透明度", 0, 100, 1, "%");
    rangeRow(head, "glass.border", "边框强度", 0, 100, 1, "%");
    rangeRow(head, "glass.scrim", "遮罩暗化", 0, 1, 0.05, "");
    rangeRow(head, "glass.fidelity", "保真度（饱和）", 0, 100, 1, "%");
    colorRow(head, "glass.colorLight", "底色 · 浅色主题");
    colorRow(head, "glass.colorDark", "底色 · 深色主题");

    const faces = el("div", "faces");
    for (const face of FACE_ORDER) {
      const box = el("div", "face");
      const line = el("div", "line");
      line.append(el("span", "name", FACE_LABELS[face]));
      const select = bind(el("select"), "glass.faces." + face);
      for (const mode of FACE_MODES) {
        const option = el("option", null, FACE_MODE_LABELS[mode]);
        option.value = mode;
        select.append(option);
      }
      line.append(select);
      box.append(line);
      /* Codex's settings window is a native Electron window, not page DOM, and the
         floaters only exist while a menu is open - say so instead of failing quietly. */
      if (face === "settingsWindow") box.append(el("div", "note", "不可用：Codex 设置窗是原生窗口，页面内无对应 DOM。"));
      if (face === "floaters") box.append(el("div", "note", "按需生效：仅当菜单/下拉/提示实际打开时套用玻璃。"));
      const custom = el("div", "custom");
      const blur = bind(el("input"), "glass.face." + face + ".blur");
      blur.type = "range";
      blur.min = "0";
      blur.max = "60";
      blur.step = "1";
      blur.title = "独立模糊";
      const alpha = bind(el("input"), "glass.face." + face + ".alpha");
      alpha.type = "range";
      alpha.min = "0";
      alpha.max = "100";
      alpha.step = "1";
      alpha.title = "独立透明度";
      const color = bind(el("input"), "glass.face." + face + ".color");
      color.type = "color";
      color.title = "独立底色";
      custom.append(blur, alpha, color);
      box.append(custom);
      faces.append(box);
      subSyncers.push(() => {
        const mode = String(getPath(state, "glass.faces." + face) || "inherit");
        select.value = mode;
        blur.value = String(getPath(state, "glass.face." + face + ".blur"));
        alpha.value = String(getPath(state, "glass.face." + face + ".alpha"));
        const value = String(getPath(state, "glass.face." + face + ".color") || "");
        color.value = /^#[0-9a-fA-F]{6}$/.test(value) ? value : "#ffffff";
        custom.classList.toggle("idle", mode !== "custom");
      });
    }
    wrap.append(faces);
    wrap.append(el("div", "hint", "每面三态：跟随全局 / 独立（可单独设模糊、透明度、底色）/ 关闭。侧栏设置独立时以侧栏三态优先。"));

    toggleRow(wrap, "glass.sidebarFollowGlobal", "侧栏跟随全局");
    rangeRow(wrap, "glass.sidebarRadius", "侧栏圆角", 0, 40, 1, "px");
    const cornerRow = el("div", "row");
    cornerRow.append(el("label", null, "四角独立圆角（点亮 = 直角）"));
    const grid = el("div", "grid4");
    for (const [key, label] of CORNER_LABELS) {
      const button = bind(el("button", "toggle"), "glass.sidebarSquare" + key);
      grid.append(button);
      subSyncers.push(() => {
        const on = getPath(state, "glass.sidebarSquare" + key) === true;
        button.classList.toggle("on", on);
        button.textContent = label + (on ? " 直角" : "");
      });
    }
    cornerRow.append(grid);
    wrap.append(cornerRow);
    toggleRow(wrap, "glass.sidebarFullClear", "侧栏完全透明");

    const extraRow = el("div", "row");
    const extraLabel = el("label");
    const extraOut = el("output");
    extraLabel.append(document.createTextNode("补雾化选择器"), extraOut);
    const area = bind(el("textarea"), "glass.extraSelectors");
    area.placeholder = ".my-overlay\n[data-foo=\"bar\"]";
    area.rows = 3;
    extraRow.append(extraLabel, area);
    wrap.append(extraRow);
    wrap.append(el("div", "hint", "每行或逗号分隔一条；最多 8 条、每条最多 120 字，超长或超出的整条丢弃（不截断）。命中元素需已定位为 fixed/absolute，玻璃会在其 ::before 上生成，不影响其内部浮层。"));
    subSyncers.push(() => {
      area.value = String(getPath(state, "glass.extraSelectors") || "");
      const used = extraSelectors(area.value);
      extraOut.textContent = used.length + " / " + MAX_EXTRA_SELECTORS;
    });
  });
  const renderFonts = body => lazySection(body, "字体与配色", false, wrap => {
    textRow(wrap, "fonts.globalFamily", "全局字体族（应用到 #root）", "\"LXGW WenKai\", sans-serif");
    const systemRow = el("div", "row");
    const system = el("button", "toggle", "使用系统字体（queryLocalFonts）");
    systemRow.append(system);
    wrap.append(systemRow);
    system.addEventListener("click", async () => {
      try {
        if (typeof window.queryLocalFonts !== "function") throw new Error("unsupported");
        const fonts = await window.queryLocalFonts();
        const families = [...new Set(fonts.map(item => item.family))].sort();
        if (!families.length) throw new Error("empty");
        const answer = window.prompt("已找到 " + families.length + " 个系统字体。输入要使用的字体名，例如：" + families.slice(0, 6).join(" / "), families[0]);
        if (answer == null) return;
        const name = String(answer).trim().replace(/["'\\;{}]/g, "");
        if (!name) return;
        state.fonts.globalFamily = "\"" + name + "\", sans-serif";
        applyNormalized(state);
        say("已应用系统字体：" + name);
      } catch (error) {
        say("queryLocalFonts 不可用（或未授权），请在上方输入框手动填写字体名。", true);
      }
    });
    wrap.append(el("div", "hint", "留空的项一律不写入样式，等于沿用 Codex 默认外观。"));

    for (const role of Object.keys(ROLE_LABELS)) {
      const row = el("div", "row");
      row.append(el("label", null, "角色字体 · " + ROLE_LABELS[role]));
      const triple = el("div", "grid3");
      const family = bind(el("input"), "fonts.roles." + role + ".family");
      family.type = "text";
      family.placeholder = "字体族";
      const size = bind(el("input"), "fonts.roles." + role + ".size");
      size.type = "text";
      size.placeholder = "字号 13px";
      const weight = bind(el("input"), "fonts.roles." + role + ".weight");
      weight.type = "text";
      weight.placeholder = "字重 600";
      triple.append(family, size, weight);
      row.append(triple);
      const colorPair = el("div", "grid3");
      const light = bind(el("input"), "fonts.roles." + role + ".light");
      light.type = "color";
      light.title = "浅色主题颜色";
      const dark = bind(el("input"), "fonts.roles." + role + ".dark");
      dark.type = "color";
      dark.title = "深色主题颜色";
      const clear = el("button", "toggle", "清空颜色");
      clear.dataset.clearRole = role;
      colorPair.append(light, dark, clear);
      row.append(colorPair);
      wrap.append(row);
      const roles = ["light", "dark"];
      for (const tone of roles) {
        const input = tone === "light" ? light : dark;
        input.addEventListener("input", () => {
          setPath(state, "fonts.roles." + role + "." + tone, input.value);
          clear.textContent = "清空颜色";
        });
      }
      subSyncers.push(() => {
        const value = getPath(state, "fonts.roles." + role) || {};
        family.value = String(value.family || "");
        size.value = String(value.size || "");
        weight.value = String(value.weight || "");
        light.value = /^#[0-9a-fA-F]{6}$/.test(String(value.light || "")) ? value.light : "#ffffff";
        dark.value = /^#[0-9a-fA-F]{6}$/.test(String(value.dark || "")) ? value.dark : "#ffffff";
        clear.classList.toggle("on", !!(value.light || value.dark));
        clear.textContent = (value.light || value.dark) ? "清空颜色" : "未设置颜色";
      });
      clear.addEventListener("click", () => {
        setPath(state, "fonts.roles." + role + ".light", "");
        setPath(state, "fonts.roles." + role + ".dark", "");
        applyNormalized(state);
        say("已清空「" + ROLE_LABELS[role] + "」的颜色覆盖。");
      });
    }

    for (const key of Object.keys(COMPONENT_LABELS)) {
      const row = el("div", "row");
      row.append(el("label", null, "组件覆盖 · " + COMPONENT_LABELS[key] + "（留空 = 继承）"));
      const pair = el("div", "grid2");
      const family = bind(el("input"), "fonts.components." + key + ".family");
      family.type = "text";
      family.placeholder = "字体族";
      const size = bind(el("input"), "fonts.components." + key + ".size");
      size.type = "text";
      size.placeholder = "字号 13px";
      pair.append(family, size);
      row.append(pair);
      wrap.append(row);
      subSyncers.push(() => {
        const value = getPath(state, "fonts.components." + key) || {};
        family.value = String(value.family || "");
        size.value = String(value.size || "");
      });
    }

    colorRow(wrap, "fonts.caretColor", "光标颜色（caret-color）");
    for (const key of Object.keys(UI_LABELS)) {
      if (key === "caretColor") continue;
      const pair = optionalColorRow(el("div"), "fonts.ui." + key, "UI 配色 · " + UI_LABELS[key]);
      wrap.append(pair.input.closest(".row"));
    }
    wrap.append(el("div", "hint", "UI 配色留空即不改动；发送按钮/文件图标这类目标是按当前 DOM 推断的选择器，若 Codex 改版可能失配（只会不生效，不会报错）。"));
  });
  const renderFilters = body => lazySection(body, "画面滤镜与取景", false, wrap => {
    rangeRow(wrap, "filters.blur", "背景模糊", 0, 20, 1, "px");
    rangeRow(wrap, "filters.brightness", "亮度", 0, 200, 1, "%");
    rangeRow(wrap, "filters.contrast", "对比度", 0, 200, 1, "%");
    rangeRow(wrap, "filters.saturate", "饱和度", 0, 200, 1, "%");
    rangeRow(wrap, "filters.opacity", "壁纸不透明度", 5, 100, 1, "%");
    rangeRow(wrap, "filters.darken", "叠加黑色遮罩", 0, 80, 1, "%");
    selectRow(wrap, "filters.objectFit", "取景方式 object-fit", OBJECT_FITS);
    rangeRow(wrap, "filters.positionX", "水平位置", 0, 100, 1, "%");
    rangeRow(wrap, "filters.positionY", "垂直位置", 0, 100, 1, "%");
    rangeRow(wrap, "filters.scale", "缩放", 100, 200, 1, "%");
    wrap.append(el("div", "hint", "滤镜走 CSS filter（GPU 合成），取景对原生视频用 object-fit/object-position、对 WebGL 画布用 transform；新旧背景层会带上同一套参数，切换时不会跳变。"));
  });
  /* ---------- Phase 3: 扩展特效 ---------- */
  const EXT_FORM_LABELS = { whale: "鲸鱼", cat: "猫", rabbit: "兔", fox: "狐狸", penguin: "企鹅", robot: "机器人" };
  const CLICK_LABELS = { ripple: "涟漪", spark: "火花", ring: "圆环" };
  const TRAIL_LABELS = { comet: "彗尾", line: "细线", dots: "点阵" };
  const BLEND_LABELS = { screen: "滤色 screen", normal: "正常 normal", overlay: "叠加 overlay" };
  const COLOR_LABELS = { single: "单色", rainbow: "彩虹" };
  const DEPTH_LABELS = [["chat", "对话滚动区"], ["composer", "输入区"], ["sidebar", "侧栏"], ["bubble", "消息气泡"]];

  /* Image inputs never read a path in the page (CSP and no filesystem access). The File
     object is parked on window.__lunaUpload; the watchdog streams it out in 2MB slices
     and mirrors the saved data URL back through data-prefs. */
  const imagePicker = (parent, kind, label) => {
    const row = el("div", "row");
    const lab = el("label");
    lab.append(document.createTextNode(label));
    const input = el("input");
    input.type = "file";
    input.accept = "image/png,image/jpeg,image/webp";
    const clear = el("button", "toggle", "清除图片");
    const line = el("div", "grid2");
    line.append(input, clear);
    row.append(lab, line);
    parent.append(row);
    input.addEventListener("change", () => {
      const file = input.files && input.files[0];
      input.value = "";
      if (!file) return;
      if (file.size > 3 * 1024 * 1024) { say("图片不能超过 3MB。", true); return; }
      const hostNode = host();
      if (!hostNode) { say("外观面板宿主不存在。", true); return; }
      window.__lunaUpload = { file };
      try { hostNode.dataset.imageCommand = JSON.stringify({ kind, name: file.name, size: file.size }); } catch {}
      say("已提交" + label + "：" + file.name + "（保存后自动生效）");
    });
    clear.addEventListener("click", () => {
      const hostNode = host();
      if (!hostNode) return;
      try { hostNode.dataset.imageCommand = JSON.stringify({ kind, clear: true }); } catch {}
      say("已请求清除" + label + "。");
    });
    syncers.push(() => {
      const slot = state.ext && state.ext[kind] ? state.ext[kind] : {};
      clear.classList.toggle("on", !!(slot.file || slot.image));
      clear.textContent = slot.file ? "清除图片（" + slot.file + "）" : "清除图片";
    });
    return { input, clear };
  };

  const renderExt = body => lazySection(body, "扩展特效（点击 / 拖尾 / 视差 / 头像 / 吉祥物）", false, wrap => {
    toggleRow(wrap, "ext.enabled", "扩展总开关");
    wrap.append(el("div", "hint", "总开关关闭时所有特效层都不创建；特效层 pointer-events:none，不会拦截任何原生点击。"));

    const click = el("div", "face");
    click.append(el("div", "name", "点击特效"));
    toggleRow(click, "ext.fx.click.enabled", "启用点击特效");
    selectLabeled(click, "ext.fx.click.style", "样式", CLICK_STYLES, CLICK_LABELS);
    rangeRow(click, "ext.fx.click.size", "尺寸", 40, 240, 1, "px");
    rangeRow(click, "ext.fx.click.glow", "光晕", 0, 100, 1, "%");
    selectLabeled(click, "ext.fx.click.colorMode", "配色", COLOR_MODES, COLOR_LABELS);
    colorRow(click, "ext.fx.click.color", "单色颜色");
    rangeRow(click, "ext.fx.click.opacity", "不透明度", 0, 100, 1, "%");
    selectLabeled(click, "ext.fx.click.blend", "混合模式", BLEND_MODES, BLEND_LABELS);
    wrap.append(click);

    const trail = el("div", "face");
    trail.append(el("div", "name", "拖尾特效"));
    toggleRow(trail, "ext.fx.trail.enabled", "启用拖尾特效");
    selectLabeled(trail, "ext.fx.trail.style", "样式", TRAIL_STYLES, TRAIL_LABELS);
    rangeRow(trail, "ext.fx.trail.length", "拖尾长度", 80, 800, 10, "px");
    rangeRow(trail, "ext.fx.trail.width", "线宽", 1, 10, 0.5, "px");
    rangeRow(trail, "ext.fx.trail.glow", "光晕", 0, 100, 1, "%");
    selectLabeled(trail, "ext.fx.trail.colorMode", "配色", COLOR_MODES, COLOR_LABELS);
    colorRow(trail, "ext.fx.trail.color", "单色颜色");
    rangeRow(trail, "ext.fx.trail.opacity", "不透明度", 0, 100, 1, "%");
    selectLabeled(trail, "ext.fx.trail.blend", "混合模式", BLEND_MODES, BLEND_LABELS);
    wrap.append(trail);

    const parallax = el("div", "face");
    parallax.append(el("div", "name", "视差（默认关闭）"));
    toggleRow(parallax, "ext.parallax.enabled", "启用视差");
    rangeRow(parallax, "ext.parallax.bg", "背景层倍率", 0, 3, 0.1, "");
    rangeRow(parallax, "ext.parallax.ui", "UI 总倍率", 0, 3, 0.1, "");
    rangeRow(parallax, "ext.parallax.mascot", "吉祥物倍率", 0, 3, 0.1, "");
    rangeRow(parallax, "ext.parallax.smooth", "平滑度", 0, 100, 1, "%");
    for (const pair of DEPTH_LABELS) rangeRow(parallax, "ext.parallax.depths." + pair[0], "分区深度 · " + pair[1], 0, 3, 0.1, "");
    parallax.append(el("div", "note", "视差只写 translate，不改变布局；滚动与输入时不重排。"));
    wrap.append(parallax);

    const avatar = el("div", "face");
    avatar.append(el("div", "name", "会话头像（默认关闭）"));
    toggleRow(avatar, "ext.avatar.enabled", "启用会话头像");
    rangeRow(avatar, "ext.avatar.size", "尺寸", 24, 72, 1, "px");
    rangeRow(avatar, "ext.avatar.radius", "圆角", 0, 100, 1, "%");
    imagePicker(avatar, "avatar", "头像图片");
    const avatarState = el("div", "note", "定位中…");
    avatar.append(avatarState);
    syncers.push(() => {
      let count = 0;
      try { count = window.__lunaExt && window.__lunaExt.stats ? Number(window.__lunaExt.stats().avatarNodes) || 0 : 0; } catch { count = 0; }
      avatarState.textContent = count > 0 ? "已定位 " + count + " 个用户消息" : "未定位：当前会话还没有用户消息气泡（不可用/未定位）。";
    });
    wrap.append(avatar);

    const mascot = el("div", "face");
    mascot.append(el("div", "name", "吉祥物（默认关闭）"));
    toggleRow(mascot, "ext.mascot.enabled", "启用吉祥物");
    selectLabeled(mascot, "ext.mascot.form", "形象", EXT_FORMS, EXT_FORM_LABELS);
    rangeRow(mascot, "ext.mascot.scale", "大小", 0.6, 1.4, 0.05, "");
    rangeRow(mascot, "ext.mascot.x", "水平位置", 0, 100, 1, "%");
    rangeRow(mascot, "ext.mascot.y", "垂直位置", 0, 100, 1, "%");
    toggleRow(mascot, "ext.mascot.drag", "允许拖动");
    imagePicker(mascot, "mascot", "自定义立绘");
    mascot.append(el("div", "note", "拖动移动（位置自动保存）；点击开合壁纸选择器。只有吉祥物自身接收指针事件。"));
    wrap.append(mascot);
  });
  /* The page keeps its own copy of the model so an imported preset can be validated
     before it ever reaches the stylesheet. It mirrors the Node-side normaliser. */
  const normalize = (raw, options) => {
    const withPresets = !options || options.withPresets !== false;
    const out = {
      version: 1,
      activePreset: "自定义",
      glass: {
        enabled: false, blur: 9, alpha: 80, border: 90, scrim: 0, fidelity: 35,
        colorLight: "#266d3c", colorDark: "#266d3c",
        faces: { sidebar: "inherit", sidebarContent: "inherit", settingsWindow: "inherit", conversation: "inherit", thinkingTrigger: "inherit", floaters: "inherit" },
        face: {
          sidebar: { blur: 8, alpha: 85, color: "#ffffff" },
          sidebarContent: { blur: 8, alpha: 20, color: "#ffffff" },
          settingsWindow: { blur: 8, alpha: 90, color: "#ffffff" },
          conversation: { blur: 8, alpha: 30, color: "#ffffff" },
          thinkingTrigger: { blur: 20, alpha: 100, color: "#ffffff" },
          floaters: { blur: 8, alpha: 90, color: "#ffffff" }
        },
        sidebarFollowGlobal: true,
        sidebarRadius: 20,
        sidebarSquareTL: false, sidebarSquareTR: false, sidebarSquareBR: false, sidebarSquareBL: false,
        sidebarFullClear: false,
        extraSelectors: ""
      },
      fonts: {
        globalFamily: "",
        roles: {
          secondary: { family: "", size: "", weight: "", light: "", dark: "" },
          caption: { family: "", size: "", weight: "", light: "", dark: "" },
          body: { family: "", size: "", weight: "", light: "", dark: "" }
        },
        components: { sidebar: { family: "", size: "" }, titlebar: { family: "", size: "" }, composer: { family: "", size: "" }, message: { family: "", size: "" } },
        caretColor: "",
        ui: { sendButton: "", link: "", fileIcon: "", tab: "", reasoning: "" }
      },
      filters: { blur: 0, brightness: 100, contrast: 100, saturate: 100, opacity: 100, darken: 0, objectFit: "cover", positionX: 50, positionY: 50, scale: 100 },
      ext: {
        version: 1,
        enabled: false,
        fx: {
          click: { enabled: false, style: "ripple", size: 96, glow: 60, colorMode: "single", color: "#7dd3fc", opacity: 80, blend: "screen" },
          trail: { enabled: false, style: "comet", length: 240, width: 3, glow: 60, colorMode: "single", color: "#a78bfa", opacity: 70, blend: "screen" }
        },
        parallax: { enabled: false, bg: 1, ui: 1, mascot: 1, smooth: 60, depths: { chat: 1, composer: 1, sidebar: 1, bubble: 1 } },
        avatar: { enabled: false, size: 40, radius: 50, file: "", image: "" },
        mascot: { enabled: false, form: "whale", scale: 1, x: 96, y: 92, drag: true, file: "", image: "" }
      },
      presets: []
    };
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
    const num = (value, lo, hi, fallback) => { const parsed = Number(value); return Number.isFinite(parsed) ? Math.min(hi, Math.max(lo, parsed)) : fallback; };
    const color = (value, fallback) => {
      const trimmed = typeof value === "string" ? value.trim() : "";
      if (!trimmed) return fallback;
      return /^#[0-9a-fA-F]{3}$|^#[0-9a-fA-F]{6}$|^#[0-9a-fA-F]{8}$/.test(trimmed) ? trimmed : fallback;
    };
    const css = value => {
      const trimmed = typeof value === "string" ? value.trim() : "";
      return trimmed.length <= 64 && !/[;{}<>]/.test(trimmed) ? trimmed : "";
    };
    if (typeof raw.activePreset === "string" && raw.activePreset.trim()) out.activePreset = raw.activePreset.trim().slice(0, 48);
    const glass = raw.glass && typeof raw.glass === "object" ? raw.glass : {};
    out.glass.enabled = glass.enabled === true;
    out.glass.blur = num(glass.blur, 0, 40, out.glass.blur);
    out.glass.alpha = num(glass.alpha, 0, 100, out.glass.alpha);
    out.glass.border = num(glass.border, 0, 100, out.glass.border);
    const scrim = Number(glass.scrim);
    out.glass.scrim = Number.isFinite(scrim) ? Math.min(1, Math.max(0, scrim > 1 ? scrim / 100 : scrim)) : out.glass.scrim;
    out.glass.fidelity = num(glass.fidelity, 0, 100, out.glass.fidelity);
    out.glass.colorLight = color(glass.colorLight, out.glass.colorLight);
    out.glass.colorDark = color(glass.colorDark, out.glass.colorDark);
    const faces = glass.faces && typeof glass.faces === "object" ? glass.faces : {};
    for (const face of FACE_ORDER) out.glass.faces[face] = FACE_MODES.includes(faces[face]) ? faces[face] : "inherit";
    const faceParams = glass.face && typeof glass.face === "object" ? glass.face : {};
    for (const face of FACE_ORDER) {
      const source = faceParams[face] && typeof faceParams[face] === "object" ? faceParams[face] : {};
      out.glass.face[face].blur = num(source.blur, 0, 60, out.glass.face[face].blur);
      out.glass.face[face].alpha = num(source.alpha, 0, 100, out.glass.face[face].alpha);
      out.glass.face[face].color = color(source.color, out.glass.face[face].color);
    }
    out.glass.sidebarFollowGlobal = glass.sidebarFollowGlobal !== false;
    out.glass.sidebarRadius = num(glass.sidebarRadius, 0, 40, out.glass.sidebarRadius);
    out.glass.sidebarSquareTL = glass.sidebarSquareTL === true;
    out.glass.sidebarSquareTR = glass.sidebarSquareTR === true;
    out.glass.sidebarSquareBR = glass.sidebarSquareBR === true;
    out.glass.sidebarSquareBL = glass.sidebarSquareBL === true;
    out.glass.sidebarFullClear = glass.sidebarFullClear === true;
    out.glass.extraSelectors = typeof glass.extraSelectors === "string" ? glass.extraSelectors.slice(0, 4000) : "";
    const fonts = raw.fonts && typeof raw.fonts === "object" ? raw.fonts : {};
    out.fonts.globalFamily = css(fonts.globalFamily);
    const roles = fonts.roles && typeof fonts.roles === "object" ? fonts.roles : {};
    for (const role of Object.keys(out.fonts.roles)) {
      const source = roles[role] && typeof roles[role] === "object" ? roles[role] : {};
      out.fonts.roles[role] = { family: css(source.family), size: css(source.size), weight: css(source.weight), light: color(source.light, ""), dark: color(source.dark, "") };
    }
    const components = fonts.components && typeof fonts.components === "object" ? fonts.components : {};
    for (const key of Object.keys(out.fonts.components)) {
      const source = components[key] && typeof components[key] === "object" ? components[key] : {};
      out.fonts.components[key] = { family: css(source.family), size: css(source.size) };
    }
    out.fonts.caretColor = color(fonts.caretColor, "");
    const ui = fonts.ui && typeof fonts.ui === "object" ? fonts.ui : {};
    for (const key of Object.keys(out.fonts.ui)) out.fonts.ui[key] = color(ui[key], "");
    const filters = raw.filters && typeof raw.filters === "object" ? raw.filters : {};
    out.filters.blur = num(filters.blur, 0, 20, out.filters.blur);
    out.filters.brightness = num(filters.brightness, 0, 200, out.filters.brightness);
    out.filters.contrast = num(filters.contrast, 0, 200, out.filters.contrast);
    out.filters.saturate = num(filters.saturate, 0, 200, out.filters.saturate);
    out.filters.opacity = num(filters.opacity, 5, 100, out.filters.opacity);
    out.filters.darken = num(filters.darken, 0, 80, out.filters.darken);
    out.filters.objectFit = OBJECT_FITS.includes(filters.objectFit) ? filters.objectFit : out.filters.objectFit;
    out.filters.positionX = num(filters.positionX, 0, 100, out.filters.positionX);
    out.filters.positionY = num(filters.positionY, 0, 100, out.filters.positionY);
    out.filters.scale = num(filters.scale, 100, 200, out.filters.scale);
    /* Phase 3 extension block: same clamps as the Node-side normaliser, so a preset
       imported in the page and one persisted by the watchdog round-trip identically. */
    const extRaw = raw.ext && typeof raw.ext === "object" ? raw.ext : {};
    const pick = (value, list, fallback) => (list.indexOf(value) >= 0 ? value : fallback);
    const str = value => (typeof value === "string" ? value.trim() : "");
    out.ext.enabled = extRaw.enabled === true;
    const fxRaw = extRaw.fx && typeof extRaw.fx === "object" ? extRaw.fx : {};
    const clickRaw = fxRaw.click && typeof fxRaw.click === "object" ? fxRaw.click : {};
    out.ext.fx.click.enabled = clickRaw.enabled === true;
    out.ext.fx.click.style = pick(clickRaw.style, CLICK_STYLES, out.ext.fx.click.style);
    out.ext.fx.click.size = num(clickRaw.size, 40, 240, out.ext.fx.click.size);
    out.ext.fx.click.glow = num(clickRaw.glow, 0, 100, out.ext.fx.click.glow);
    out.ext.fx.click.colorMode = pick(clickRaw.colorMode, COLOR_MODES, out.ext.fx.click.colorMode);
    out.ext.fx.click.color = color(clickRaw.color, out.ext.fx.click.color);
    out.ext.fx.click.opacity = num(clickRaw.opacity, 0, 100, out.ext.fx.click.opacity);
    out.ext.fx.click.blend = pick(clickRaw.blend, BLEND_MODES, out.ext.fx.click.blend);
    const trailRaw = fxRaw.trail && typeof fxRaw.trail === "object" ? fxRaw.trail : {};
    out.ext.fx.trail.enabled = trailRaw.enabled === true;
    out.ext.fx.trail.style = pick(trailRaw.style, TRAIL_STYLES, out.ext.fx.trail.style);
    out.ext.fx.trail.length = num(trailRaw.length, 80, 800, out.ext.fx.trail.length);
    out.ext.fx.trail.width = num(trailRaw.width, 1, 10, out.ext.fx.trail.width);
    out.ext.fx.trail.glow = num(trailRaw.glow, 0, 100, out.ext.fx.trail.glow);
    out.ext.fx.trail.colorMode = pick(trailRaw.colorMode, COLOR_MODES, out.ext.fx.trail.colorMode);
    out.ext.fx.trail.color = color(trailRaw.color, out.ext.fx.trail.color);
    out.ext.fx.trail.opacity = num(trailRaw.opacity, 0, 100, out.ext.fx.trail.opacity);
    out.ext.fx.trail.blend = pick(trailRaw.blend, BLEND_MODES, out.ext.fx.trail.blend);
    const parallaxRaw = extRaw.parallax && typeof extRaw.parallax === "object" ? extRaw.parallax : {};
    out.ext.parallax.enabled = parallaxRaw.enabled === true;
    out.ext.parallax.bg = num(parallaxRaw.bg, 0, 3, out.ext.parallax.bg);
    out.ext.parallax.ui = num(parallaxRaw.ui, 0, 3, out.ext.parallax.ui);
    out.ext.parallax.mascot = num(parallaxRaw.mascot, 0, 3, out.ext.parallax.mascot);
    out.ext.parallax.smooth = num(parallaxRaw.smooth, 0, 100, out.ext.parallax.smooth);
    const depthsRaw = parallaxRaw.depths && typeof parallaxRaw.depths === "object" ? parallaxRaw.depths : {};
    for (const key of ["chat", "composer", "sidebar", "bubble"]) out.ext.parallax.depths[key] = num(depthsRaw[key], 0, 3, out.ext.parallax.depths[key]);
    const avatarRaw = extRaw.avatar && typeof extRaw.avatar === "object" ? extRaw.avatar : {};
    out.ext.avatar.enabled = avatarRaw.enabled === true;
    out.ext.avatar.size = num(avatarRaw.size, 24, 72, out.ext.avatar.size);
    out.ext.avatar.radius = num(avatarRaw.radius, 0, 100, out.ext.avatar.radius);
    out.ext.avatar.file = str(avatarRaw.file).slice(0, 120);
    out.ext.avatar.image = /^data:image\/(png|jpeg|webp);base64,/.test(str(avatarRaw.image)) ? str(avatarRaw.image) : "";
    const mascotRaw = extRaw.mascot && typeof extRaw.mascot === "object" ? extRaw.mascot : {};
    out.ext.mascot.enabled = mascotRaw.enabled === true;
    out.ext.mascot.form = pick(mascotRaw.form, EXT_FORMS, out.ext.mascot.form);
    out.ext.mascot.scale = num(mascotRaw.scale, 0.6, 1.4, out.ext.mascot.scale);
    out.ext.mascot.x = num(mascotRaw.x, 0, 100, out.ext.mascot.x);
    out.ext.mascot.y = num(mascotRaw.y, 0, 100, out.ext.mascot.y);
    out.ext.mascot.drag = mascotRaw.drag !== false;
    out.ext.mascot.file = str(mascotRaw.file).slice(0, 120);
    out.ext.mascot.image = /^data:image\/(png|jpeg|webp);base64,/.test(str(mascotRaw.image)) ? str(mascotRaw.image) : "";
    if (withPresets) {
      const list = Array.isArray(raw.presets) ? raw.presets : [];
      for (const entry of list) {
        if (!entry || typeof entry !== "object" || typeof entry.name !== "string") continue;
        const values = normalize(entry.values && typeof entry.values === "object" ? entry.values : entry, { withPresets: false });
        values.presets = [];
        values.activePreset = entry.name.trim().slice(0, 48) || values.activePreset;
        out.presets.push({ name: values.activePreset, builtIn: entry.builtIn === true, values });
      }
    }
    return out;
  };
  const mountPanel = () => {
    const shadow = buildPanel();
    if (!shadow) return { ok: false, error: "host missing" };
    const node = host();
    const chip = shadow.getElementById("chip");
    const panel = shadow.getElementById("panel");
    const body = shadow.getElementById("body");
    const close = shadow.getElementById("close");
    message = shadow.getElementById("msg");
    panel.classList.remove("open");
    chip.style.display = "";
    body.textContent = "";
    syncers.length = 0;
    subSyncers.length = 0;
    renderPresets(body);
    renderGlass(body);
    renderFonts(body);
    renderFilters(body);
    renderExt(body);
    /* The mascot lives in the page runtime; a drag hands its new position back so the
       panel persists it through the same debounced save as every slider. */
    try {
      if (window.__lunaExt && window.__lunaExt.setPersist) {
        window.__lunaExt.setPersist(next => {
          if (!state || !state.ext || !state.ext.mascot || !next) return;
          state.ext.mascot.x = Number(next.x);
          state.ext.mascot.y = Number(next.y);
          syncersRun();
          debouncedSave();
        });
      }
    } catch {}
    syncersRun();

    let open = false;
    let lastEditAt = 0;
    let awaiting = false;
    let lastAdopted = 0;
    let applySoon = null;

    const markCustom = () => {
      if (state.activePreset === "自定义") return;
      state.activePreset = "自定义";
      if (presetRedraw) { try { presetRedraw(); } catch {} }
    };
    /* Text fields re-render the whole sheet on every keystroke, so they wait for a short
       pause; sliders and swatches feel instant because they only rebuild a few rules. */
    const slowApply = () => {
      if (applySoon) clearTimeout(applySoon);
      applySoon = setTimeout(() => { applySoon = null; applyNormalized(state); }, 220);
    };
    const onField = event => {
      const target = event.target;
      if (!target || target.tagName === "BUTTON" || !target.dataset || !target.dataset.path) return;
      const path = target.dataset.path;
      lastEditAt = Date.now();
      markCustom();
      setPath(state, path, target.type === "range" ? Number(target.value) : target.value);
      if (target.type === "text" || target.tagName === "TEXTAREA") slowApply();
      else applyNormalized(state);
    };
    const onClick = event => {
      const target = event.target;
      if (!target || target.tagName !== "BUTTON" || !target.dataset || !target.dataset.path) return;
      const path = target.dataset.path;
      lastEditAt = Date.now();
      markCustom();
      if (target.dataset.clear) {
        setPath(state, path, "");
        applyNormalized(state);
        say("已清空：" + path);
        return;
      }
      setPath(state, path, getPath(state, path) !== true);
      applyNormalized(state);
    };
    panel.addEventListener("input", onField);
    panel.addEventListener("change", onField);
    panel.addEventListener("click", onClick);

    const setOpen = next => {
      open = next;
      panel.classList.toggle("open", open);
      chip.style.display = open ? "none" : "";
      if (!open) return;
      /* Reading the saved configuration on open: the page cannot fetch (CSP), so it asks
         the watchdog through a dataset attribute and adopts whatever comes back. */
      awaiting = true;
      try { node.dataset.prefsRequest = String(Date.now()); } catch {}
      say("已读取已保存的外观配置：" + (state.activePreset || "自定义"));
      setTimeout(() => { awaiting = false; }, 2500);
    };
    chip.addEventListener("click", () => setOpen(true));
    close.addEventListener("click", () => setOpen(false));

    if (node.__lunaPrefsObserver) { try { node.__lunaPrefsObserver.disconnect(); } catch {} }
    node.__lunaPrefsObserver = new MutationObserver(() => {
      const raw = node.dataset.prefs;
      if (!raw) return;
      let payload = null;
      try { payload = JSON.parse(raw); } catch { return; }
      if (!payload || typeof payload !== "object" || !payload.t || payload.t === lastAdopted) return;
      /* Never yank the values out from under an in-flight edit. */
      if (open && !awaiting && Date.now() - lastEditAt < 1500) return;
      lastAdopted = payload.t;
      awaiting = false;
      const next = normalize(payload.appearance === undefined ? payload : payload.appearance);
      apply(next);
      if (presetRedraw) { try { presetRedraw(); } catch {} }
      syncersRun();
    });
    node.__lunaPrefsObserver.observe(node, { attributes: true, attributeFilter: ["data-prefs"] });

    /* Upload progress comes back on a separate attribute so it never collides with
       the appearance mirror. */
    if (node.__lunaImageObserver) { try { node.__lunaImageObserver.disconnect(); } catch {} }
    node.__lunaImageObserver = new MutationObserver(() => {
      const raw = node.dataset.imageStatus;
      if (!raw) return;
      let payload = null;
      try { payload = JSON.parse(raw); } catch { return; }
      if (!payload) return;
      node.dataset.imageStatus = "";
      say(String(payload.message || (payload.state === "done" ? "已保存" : "处理中")), payload.state === "error");
    });
    node.__lunaImageObserver.observe(node, { attributes: true, attributeFilter: ["data-image-status"] });

    return { ok: true, open: false, sections: ["preset", "glass", "fonts", "filters", "ext"], fields: syncers.length + subSyncers.length };
  };

  return {
    apply: (raw, options) => applyNormalized(normalize(raw, options)),
    mountPanel,
    normalize,
    watch,
    /* Re-run the current state (the watchdog pushes data-economy after a frame-rate
       decision and needs the glass sheet rebuilt without touching saved prefs). */
    refresh: () => (state ? apply(state) : { ok: false, error: "no appearance state" }),
    state: () => state,
    faces: FACE_ORDER,
    status: () => ({
      ok: !!state,
      build: BUILD,
      glass: !!(state && state.glass.enabled),
      faces: FACE_ORDER.filter(face => !!document.querySelector("[data-codex-glass=\"" + face + "\"]")),
      marked: [...markedFaces.keys()],
      missing: [...missingReported],
      extraSelectors: state ? extraSelectors(state.glass.extraSelectors) : [],
      shade: state ? Number(shadeAlpha(state).toFixed(3)) : 0,
      styles: ["codex-glass-style", "codex-font-style", "codex-filter-style"].filter(id => !!document.getElementById(id)),
      economy: economyOn(),
      panel: !!document.getElementById(HOST_ID)
    }),
    events: () => (window.__codexAppearanceLog || []).slice()
  };
}

const EXT_RUNTIME_SOURCE = "(" + extRuntime.toString().replace("__LUNA_EXT_BUILD__", EXT_BUILD) + ")()";
export const PANEL_RUNTIME_SOURCE = "(() => { window.__lunaExt = " + EXT_RUNTIME_SOURCE + "; return (" + pageRuntime.toString().replace(BUILD_TOKEN, APPEARANCE_BUILD) + ")(); })()";
