import fs from "node:fs";
import path from "node:path";
import { WEB_TYPES } from "./wallpaper-library.mjs";

/* Wallpaper Engine web projects are regular HTML folders. Codex's page CSP
   forbids the page from fetching this watchdog (frame-src and connect-src do
   not include 127.0.0.1) and also blocks inline <script> inside a srcdoc
   frame. The watchdog therefore builds a self-contained document here:
   stylesheets, images, fonts and media are inlined as data URLs, scripts are
   collected and executed through Page.addScriptToEvaluateOnNewDocument, and
   the frame is mounted with sandbox="allow-scripts" (opaque origin, so the
   wallpaper can never read Codex cookies or localStorage). */

const MAX_HTML_BYTES = 4 * 1024 * 1024;
const MAX_SCRIPT_BYTES = 4 * 1024 * 1024;
const MAX_RESOURCE_BYTES = 12 * 1024 * 1024;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;
export const TRANSPARENT_GIF = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";

const decodeEntities = value => String(value || "")
  .replace(/&amp;/gi, "&").replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
  .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">");

const attrOf = (attrs, name) => {
  const match = new RegExp("\\b" + name + "\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s>]+))", "i").exec(attrs || "");
  return match ? decodeEntities(match[1] ?? match[2] ?? match[3] ?? "") : "";
};

const mimeOf = file => WEB_TYPES.get(path.extname(file).toLowerCase()) || "application/octet-stream";

/* Resolve a relative reference without ever leaving the wallpaper folder.
   Remote URLs and data/blob references return null so the caller can leave
   them alone (CSP blocks the remote ones anyway). */
function resolveLocal(root, reference) {
  const raw = String(reference || "").trim();
  if (!raw || raw.startsWith("#") || raw.startsWith("//")) return null;
  if (/^(?:data:|blob:|https?:|javascript:|mailto:|chrome:|file:)/i.test(raw)) return null;
  const withoutQuery = raw.split("#")[0].split("?")[0];
  if (!withoutQuery) return null;
  let decoded = withoutQuery;
  try { decoded = decodeURIComponent(withoutQuery); } catch { return null; }
  if (decoded.includes("\0") || path.isAbsolute(decoded)) return null;
  const base = path.resolve(root);
  const target = path.resolve(base, decoded.replace(/^[\\/]+/, ""));
  if (target !== base && !target.startsWith(base + path.sep)) return null;
  try { return fs.statSync(target).isFile() ? target : null; } catch { return null; }
}

/* Build one srcdoc document plus the script list that must run in the frame.
   Returns { ok, html, scripts, warnings, inlineBytes, resources, entry }. */
export function buildWebDocument(item) {
  const entry = item && item.webEntry ? path.resolve(item.webEntry) : null;
  const dir = item && item.webDir ? path.resolve(item.webDir) : entry ? path.dirname(entry) : null;
  const warnings = [];
  const scripts = [];
  const resources = [];
  let inlineBytes = 0;

  if (!entry || !dir) return { ok: false, error: "web entry missing" };
  let html = "";
  try {
    const stat = fs.statSync(entry);
    if (!stat.isFile()) return { ok: false, error: "web entry is not a file" };
    if (stat.size > MAX_HTML_BYTES) return { ok: false, error: "web entry is too large (" + stat.size + " bytes)" };
    html = fs.readFileSync(entry, "utf8");
  } catch (error) {
    return { ok: false, error: "web entry read failed: " + error.message };
  }

  const budgetLeft = () => MAX_TOTAL_BYTES - inlineBytes;
  const dataUrlOf = (file, label) => {
    if (!file) return null;
    let stat;
    try { stat = fs.statSync(file); } catch { return null; }
    if (!stat.isFile() || stat.size < 1) return null;
    if (stat.size > MAX_RESOURCE_BYTES) { warnings.push((label || path.basename(file)) + " skipped: " + stat.size + " bytes exceeds per-resource cap"); return null; }
    if (stat.size > budgetLeft()) { warnings.push((label || path.basename(file)) + " skipped: inline budget exhausted"); return null; }
    try {
      const bytes = fs.readFileSync(file);
      inlineBytes += bytes.length;
      resources.push({ file: path.basename(file), bytes: bytes.length });
      return "data:" + mimeOf(file) + ";base64," + bytes.toString("base64");
    } catch (error) {
      warnings.push((label || path.basename(file)) + " read failed: " + error.message);
      return null;
    }
  };

  const inlineCss = (css, cssDir) => String(css || "").replace(/url\(\s*(?:\"([^\"]*)\"|'([^']*)'|([^)\s]+))\s*\)/gi, (all, a, b, c) => {
    const reference = decodeEntities(a ?? b ?? c ?? "");
    const file = resolveLocal(cssDir, reference);
    if (!file) return all;
    const url = dataUrlOf(file, reference);
    return url ? "url(\"" + url + "\")" : "url(\"" + TRANSPARENT_GIF + "\")";
  });

  /* Stylesheet links become inline <style> blocks. Remote sheets cannot load
     under frame-src/script-src anyway. */
  html = html.replace(/<link\b([^>]*)>/gi, (all, attrs) => {
    if (!/\brel\s*=\s*(?:\"|')?stylesheet/i.test(attrs)) return all;
    const href = attrOf(attrs, "href");
    const file = resolveLocal(dir, href);
    if (!file) { warnings.push("stylesheet skipped (not local): " + (href || "(empty)")); return ""; }
    let css = "";
    try { css = fs.readFileSync(file, "utf8"); } catch (error) { warnings.push("stylesheet read failed: " + error.message); return ""; }
    return "<style data-luna-source=\"" + path.basename(file).replace(/\"/g, "") + "\">\n" + inlineCss(css, path.dirname(file)) + "\n</style>";
  });

  /* Inline style blocks resolve their url() against the HTML folder. */
  html = html.replace(/<style\b([^>]*)>([\s\S]*?)<\/style>/gi, (all, attrs, css) => "<style" + attrs + ">" + inlineCss(css, dir) + "</style>");

  /* Scripts are removed from the document and executed later through the
     DevTools-injected bootstrap (which bypasses the frame CSP). JSON-LD and
     import maps are data, not code - keep them out of the runnable list. */
  html = html.replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (all, attrs, body) => {
    const type = attrOf(attrs, "type").toLowerCase();
    if (type.includes("json") || type.includes("importmap") || type.includes("speculationrules")) return all;
    const src = attrOf(attrs, "src");
    if (src) {
      const file = resolveLocal(dir, src);
      if (!file) { warnings.push("script skipped (not local): " + src); return ""; }
      try {
        const stat = fs.statSync(file);
        if (stat.size > MAX_SCRIPT_BYTES) { warnings.push("script skipped (too large): " + src); return ""; }
        scripts.push(fs.readFileSync(file, "utf8"));
      } catch (error) { warnings.push("script read failed: " + error.message); }
      return "";
    }
    const code = String(body || "");
    if (!code.trim()) return "";
    if (code.length > MAX_SCRIPT_BYTES) { warnings.push("inline script skipped (too large)"); return ""; }
    scripts.push(code);
    return "";
  });

  /* Media and image attributes. srcset is dropped instead of half-rewritten:
     a mixed list would make the browser fetch a remote candidate. */
  html = html.replace(/<(img|video|audio|source|track|embed|input)\b([^>]*)>/gi, (all, tag, attrs) => {
    let next = attrs.replace(/\s+srcset\s*=\s*(?:\"[^\"]*\"|'[^']*'|[^\s>]+)/gi, "");
    for (const name of ["src", "poster"]) {
      const reference = attrOf(attrs, name);
      if (!reference) continue;
      const file = resolveLocal(dir, reference);
      if (!file) continue;
      const url = dataUrlOf(file, reference);
      if (!url) continue;
      const pattern = new RegExp("\\b" + name + "\\s*=\\s*(?:\"[^\"]*\"|'[^']*'|[^\\s>]+)", "i");
      next = next.replace(pattern, name + "=\"" + url + "\"");
    }
    return "<" + tag + next + ">";
  });

  if (!scripts.length) warnings.push("project contains no runnable scripts (static HTML)");

  const token = "lunaweb" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  return {
    ok: true,
    token,
    html,
    scripts,
    warnings,
    inlineBytes,
    resources,
    entry,
    dir
  };
}

/* The prelude is the only source registered with
   Page.addScriptToEvaluateOnNewDocument. It must stay eval-free: Codex's CSP
   rejects both eval() and inline <script> inside a srcdoc frame. Project
   scripts therefore run through Runtime.evaluate in the frame's main world
   (global scope, no unsafe-eval) once the iframe has loaded.

   The prelude reports runtime errors, accepts property updates over
   postMessage and announces the messaging bridge. window.name carries the
   per-mount token, so a leftover registration can never touch an unrelated
   document. */
export function webPreludeSource(token) {
  const id = JSON.stringify(String(token || ""));
  return `(() => {
  if (!${id} || window.name !== ${id}) return;
  const post = message => { try { parent.postMessage(message, "*"); } catch (error) {} };
  const describe = error => String((error && (error.message || (error.reason && error.reason.message))) || error || "unknown");
  const report = (kind, error) => post({ __lunaWebError: String(kind + ": " + describe(error)).slice(0, 300) });
  window.__lunaWebPrelude = { token: ${id} };
  window.addEventListener("error", event => report("runtime", event && (event.message || event.error)));
  window.addEventListener("unhandledrejection", event => report("promise", event && event.reason));
  window.addEventListener("message", event => {
    if (!event || event.source !== window.parent) return;
    const data = event.data || {};
    if (!data.__lunaProps) return;
    try {
      const listener = window.wallpaperPropertyListener;
      if (listener && typeof listener.applyUserProperties === "function") listener.applyUserProperties(data.__lunaProps);
      else if (typeof window.applyUserProperties === "function") window.applyUserProperties(data.__lunaProps);
      post({ __lunaPropsApplied: ${id}, keys: Object.keys(data.__lunaProps) });
    } catch (error) { report("properties", error); }
  });
  post({ __lunaBooted: ${id} });
})();`;
}

/* Wallpaper Engine properties arrive as { key: { value } }. The panel stores
   the bare values, so expand and normalise colours ("#rrggbb" -> "r g b"). */
export function webPropertyPayload(defs, saved) {
  const hexToWe = value => {
    const match = /^#([0-9a-f]{6})$/i.exec(String(value || ""));
    if (!match) return String(value ?? "");
    const n = parseInt(match[1], 16);
    const channel = part => String(Math.round(part / 255 * 1000) / 1000);
    return channel((n >> 16) & 255) + " " + channel((n >> 8) & 255) + " " + channel(n & 255);
  };
  const out = {};
  for (const def of Array.isArray(defs) ? defs : []) {
    const value = saved && saved[def.key] !== undefined ? saved[def.key] : def.value;
    out[def.key] = { value: def.type === "color" ? hexToWe(value) : value };
  }
  return out;
}
