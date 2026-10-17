/* Library-side state for Phase 2: wallpapers filters, content tags, hidden ids,
   uploads, auto-rotation and switch transitions.

   The page never talks to this module directly. The picker panel writes JSON
   commands into dataset attributes on its host element, the watchdog drains them
   through the normal status() poll, normalizes them here and mirrors the saved
   state back. Everything is clamped so a hand-edited prefs.json can never push
   junk into the picker or the rotation timer. */

export const CONTENT_TAGS = ["safe", "suggestive", "nsfw"];
export const TYPE_KEYS = ["scene", "video", "image"];
export const TRANSITION_MODES = ["cut", "fade", "zoom", "push", "wipe", "iris", "bars"];
export const TRANSITION_DIRS = ["left", "right", "up", "down"];
export const TRANSITION_SPEEDS = ["fast", "normal", "slow"];
export const TRANSITION_MS = { fast: 220, normal: 360, slow: 560 };
export const ROTATION_ORDERS = ["sequential", "random"];
export const ROTATION_INTERVALS = [15, 30, 60, 300];
export const MIN_ROTATION_SEC = 5;
export const MAX_ROTATION_SEC = 86400;
/* Upper bound on remembered ids so a runaway picker cannot grow prefs.json
   without limit. */
const MAX_LIST = 2000;

const clampInt = (value, min, max, fallback) => {
  const number = Math.round(Number(value));
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
};

const uniqueIds = value => {
  const out = [];
  const seen = new Set();
  for (const entry of Array.isArray(value) ? value : []) {
    const id = typeof entry === "string" ? entry.trim() : "";
    if (!id || id.length > 120 || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= MAX_LIST) break;
  }
  return out;
};

export function defaultLibrary() {
  return {
    version: 1,
    filters: { types: [], tag: "all", showHidden: false },
    hidden: [],
    contentTags: {},
    rotation: { enabled: false, intervalSec: 30, order: "sequential" },
    transition: { mode: "fade", dir: "left", speed: "normal" }
  };
}

/* Accepts anything (null, a partial object, a stale shape) and always returns a
   complete, clamped library object. */
export function normalizeLibrary(raw) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const filters = source.filters && typeof source.filters === "object" ? source.filters : {};
  const rotation = source.rotation && typeof source.rotation === "object" ? source.rotation : {};
  const transition = source.transition && typeof source.transition === "object" ? source.transition : {};

  /* An empty type list means "all types"; keep the array form so the picker can
     remember an explicit multi-select once the user touches it. */
  const types = [...new Set((Array.isArray(filters.types) ? filters.types : [])
    .map(value => String(value))
    .filter(value => TYPE_KEYS.includes(value)))];

  const tag = CONTENT_TAGS.includes(filters.tag) ? filters.tag : "all";

  const tags = {};
  if (source.contentTags && typeof source.contentTags === "object" && !Array.isArray(source.contentTags)) {
    let count = 0;
    for (const [id, value] of Object.entries(source.contentTags)) {
      if (count >= MAX_LIST) break;
      const key = String(id).trim();
      if (!key || key.length > 120) continue;
      if (!CONTENT_TAGS.includes(value)) continue;
      tags[key] = value;
      count++;
    }
  }

  return {
    version: 1,
    filters: { types, tag, showHidden: filters.showHidden === true },
    hidden: uniqueIds(source.hidden),
    contentTags: tags,
    rotation: {
      enabled: rotation.enabled === true,
      intervalSec: clampInt(rotation.intervalSec, MIN_ROTATION_SEC, MAX_ROTATION_SEC, 30),
      order: ROTATION_ORDERS.includes(rotation.order) ? rotation.order : "sequential"
    },
    transition: {
      mode: TRANSITION_MODES.includes(transition.mode) ? transition.mode : "fade",
      dir: TRANSITION_DIRS.includes(transition.dir) ? transition.dir : "left",
      speed: TRANSITION_SPEEDS.includes(transition.speed) ? transition.speed : "normal"
    }
  };
}

export function tagOf(library, id) {
  const value = library && library.contentTags ? library.contentTags[id] : null;
  return CONTENT_TAGS.includes(value) ? value : "safe";
}

/* Shared filter used by the picker (mirrored into the page) and by the rotation
   candidate list, so "what you see" and "what rotates" can never drift apart. */
export function filterWallpapers(wallpapers, library, options = {}) {
  const state = library || defaultLibrary();
  const hidden = new Set(state.hidden || []);
  const types = state.filters.types || [];
  const tag = state.filters.tag || "all";
  const showHidden = options.showHidden === undefined ? !!state.filters.showHidden : !!options.showHidden;
  const needle = String(options.search || "").trim().toLowerCase();
  return (wallpapers || []).filter(item => {
    const isHidden = hidden.has(item.id);
    if (isHidden && !showHidden) return false;
    if (types.length && !types.includes(item.kind || "image")) return false;
    if (tag !== "all" && tagOf(state, item.id) !== tag) return false;
    if (needle && !(String(item.title || "").toLowerCase().includes(needle) || String(item.id).toLowerCase().includes(needle))) return false;
    return true;
  });
}

/* Payload for the picker: everything it needs to render the list and its
   filter bar, in one object. */
export function libraryPayload(library, wallpapers, extra = {}) {
  const state = library || defaultLibrary();
  const hidden = new Set(state.hidden || []);
  const items = (wallpapers || []).map(item => ({
    id: item.id,
    title: item.title,
    kind: item.kind || "image",
    renderMode: item.renderMode,
    quality: item.renderMode === "native" ? "原生高清" : item.renderMode === "webgl" ? "WebGL渲染" : "静态预览",
    custom: !!item.custom,
    tag: tagOf(state, item.id),
    hidden: hidden.has(item.id)
  }));
  return { library: state, items, ...extra };
}