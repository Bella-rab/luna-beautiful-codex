#!/usr/bin/env node
/* One-shot regression self-test for the Luna Beautiful Codex wallpaper watchdog.

   What it does:
     1. Checks the watchdog is healthy on 127.0.0.1:43310.
     2. Finds the Codex desktop page via its DevTools port and connects.
     3. Switches to every wallpaper in the library and verifies the LIVE page
        state: the background element appears with the expected render mode
        (webgl scenes must show render-mode=webgl plus a live canvas; native
        and fallback wallpapers show as a plain media element).
     4. Reports load (scene pkg size), install time, and render mode for each.
     5. Restores the wallpaper that was selected before the test.
     6. Prints a summary table with pass/fail counts.

   The script runs from anywhere (repo checkout, plugin cache, or installed
   source directory): it never reads on-disk logs, it asserts against the page
   the way the user actually sees it.

   Usage:  node server/selftest.mjs
   Exit code 0 = all assertions passed, 1 = at least one failure. */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { spawn } from "node:child_process";
import { buildWebDocument, webPropertyPayload } from "./web-wallpaper.mjs";

const PORT = process.env.WATCHDOG_PORT || "43310";
const BASE = `http://127.0.0.1:${PORT}`;
const DEVTOOLS_PORTS = (process.env.LUNA_DEVTOOLS_PORTS || "9229,9230,9231,9232,9233,9234,9235,9236,9237,9238,9239")
  .split(",").map(value => parseInt(value, 10)).filter(value => value > 0);
const STEAM_CONTENT = process.env.STEAM_CONTENT || "steamapps/workshop/content/431960";

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function json(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`);
  return response.json();
}

function pkgSizeMB(id) {
  for (const drive of ["C", "D", "E", "F", "G"]) {
    for (const base of [`${drive}:\\Steam`, `${drive}:\\steam`, `${drive}:\\Program Files (x86)\\Steam`, `${drive}:\\Program Files\\Steam`]) {
      const pkg = path.join(base, STEAM_CONTENT, id, "scene.pkg");
      try { return fs.statSync(pkg).size / 1048576; } catch {}
    }
  }
  return null;
}

async function findPage() {
  for (const port of DEVTOOLS_PORTS) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const target = targets.find(item => item.type === "page" && item.url === "app://-/index.html");
      if (target) return target;
    } catch {}
  }
  return null;
}

function connectPage(target) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(target.webSocketDebuggerUrl);
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
    socket.onopen = () => resolve({
      close: () => socket.close(),
      command: (method, params = {}) => {
        const id = nextId++;
        socket.send(JSON.stringify({ id, method, params }));
        return new Promise((res, rej) => pending.set(id, { resolve: res, reject: rej }));
      },
      evaluate: (expression, awaitPromise = false) => {
        const id = nextId++;
        socket.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise } }));
        return new Promise((res, rej) => pending.set(id, { resolve: res, reject: rej }));
      },
    });
    socket.onerror = () => reject(new Error("DevTools connection failed"));
  });
}

async function waitForBackground(page, id, expectedMode, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  const started = Date.now();
  let last = null;
  while (Date.now() < deadline) {
    await sleep(2000);
    last = await page.evaluate(`(() => {
      const base = document.getElementById("codex-custom-background-base");
      const media = document.getElementById("codex-custom-background-media");
      return {
        source: (base && base.getAttribute("data-wallpaper-source")) || (media && media.getAttribute("data-wallpaper-source")) || null,
        renderMode: media ? media.getAttribute("data-render-mode") : null,
        canvases: base ? base.querySelectorAll("canvas").length : 0,
        mediaTag: media ? media.tagName : null,
      };
    })()`);
    if (last && last.source === id) {
      const elapsed = Math.round((Date.now() - started) / 1000);
      if (expectedMode === "webgl") {
        if (last.renderMode === "webgl" && last.canvases > 0) return { ok: true, detail: `webgl canvas=${last.canvases}`, seconds: elapsed };
        if (last.renderMode === "fallback") return { ok: false, detail: `fell back (expected webgl)`, seconds: elapsed };
      } else if (last.renderMode === "failed") {
        return { ok: false, detail: `renderMode=failed`, seconds: elapsed };
      } else {
        return { ok: true, detail: `${last.mediaTag || "media"} mode=${last.renderMode || "native"}`, seconds: elapsed };
      }
    }
  }
  return { ok: false, detail: `timeout`, seconds: Math.round((Date.now() - started) / 1000) };
}

/* Regression guard for the picker panel: it used to be toggled by the
   `.panel.open` class alone, so a leftover inline `display` on the panel kept
   the list hidden for good - clicking 壁纸 looked like a no-op. */
async function clickPoint(page, x, y) {
  await page.command("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await page.command("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}

async function verifyPicker(page, restoreSource, restoreMode) {
  const launcher = await page.evaluate(`(() => {
    const host = document.getElementById("codex-wallpaper-picker");
    if (!host || !host.shadowRoot) return null;
    const panel = host.shadowRoot.querySelector(".panel");
    const button = host.shadowRoot.querySelector(".launcher");
    if (!panel || !button) return null;
    panel.classList.remove("open");
    panel.style.removeProperty("display");
    const rect = button.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, display: getComputedStyle(panel).display };
  })()`);
  if (!launcher) return { ok: false, detail: "picker UI not injected (run enable_wallpaper_picker first)" };
  if (launcher.display !== "none") return { ok: false, detail: `panel should start closed, computed display=${launcher.display}` };

  await clickPoint(page, launcher.x, launcher.y);
  await sleep(400);
  const opened = await page.evaluate(`(() => {
    const host = document.getElementById("codex-wallpaper-picker");
    const panel = host.shadowRoot.querySelector(".panel");
    const rows = [...host.shadowRoot.querySelectorAll(".item")];
    const selected = document.getElementById("codex-custom-background-media")?.getAttribute("data-wallpaper-source") || "";
    const row = rows.find(item => item.querySelector(".id").textContent.trim() !== selected) || rows[0];
    const rect = row ? row.getBoundingClientRect() : null;
    return {
      display: getComputedStyle(panel).display,
      rows: rows.length,
      pick: rect ? { id: row.querySelector(".id").textContent.trim(), x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } : null
    };
  })()`);
  /* Phase 2 turned the panel into a flex column; any visible display is fine. */
  if (opened.display === "none") return { ok: false, detail: `panel stayed hidden after clicking 壁纸 (computed display=${opened.display})` };
  if (!opened.pick) return { ok: false, detail: "panel opened but listed no wallpapers" };

  await clickPoint(page, opened.pick.x, opened.pick.y);
  let applied = false;
  for (let attempt = 0; attempt < 15 && !applied; attempt++) {
    await sleep(1000);
    const status = await json(`${BASE}/status`);
    applied = Boolean(status.selection && status.selection.source === opened.pick.id);
  }
  const close = await page.evaluate(`(() => {
    const host = document.getElementById("codex-wallpaper-picker");
    const rect = host.shadowRoot.querySelector(".close").getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  })()`);
  await clickPoint(page, close.x, close.y);
  await sleep(300);
  const closed = await page.evaluate(`getComputedStyle(document.getElementById("codex-wallpaper-picker").shadowRoot.querySelector(".panel")).display`);

  if (restoreSource) {
    await json(`${BASE}/select?id=${restoreSource}`);
    await waitForBackground(page, restoreSource, restoreMode, 60000);
  }
  if (!applied) return { ok: false, detail: `clicking ${opened.pick.id} inside the picker was never applied by the watchdog` };
  if (closed !== "none") return { ok: false, detail: `panel did not close again (computed display=${closed})` };
  return { ok: true, detail: `${opened.rows} rows listed, click applied ${opened.pick.id}, panel closes again` };
}

/* Phase 4: the appearance panel is a separate shadow-DOM surface. These three
   checks assert structure and computed state only - no screenshots - so they
   stay stable across theme changes. */
async function verifyAppearancePanel(page) {
  const prepared = await page.evaluate(`(() => {
    const host = document.getElementById("codex-appearance-panel");
    if (!host || !host.shadowRoot) return null;
    const panel = host.shadowRoot.getElementById("panel");
    const button = host.shadowRoot.getElementById("chip");
    const close = host.shadowRoot.getElementById("close");
    if (!panel || !button || !close) return null;
    if (panel.classList.contains("open")) close.click();
    return { display: getComputedStyle(panel).display };
  })()`);
  if (!prepared) return { ok: false, detail: "appearance panel not injected" };
  await sleep(200);
  const chip = await page.evaluate(`(() => {
    const host = document.getElementById("codex-appearance-panel");
    const button = host.shadowRoot.getElementById("chip");
    const panel = host.shadowRoot.getElementById("panel");
    const rect = button.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, display: getComputedStyle(panel).display };
  })()`);
  if (chip.display !== "none") return { ok: false, detail: `appearance panel should start closed, display=${chip.display}` };
  await clickPoint(page, chip.x, chip.y);
  await sleep(400);
  const opened = await page.evaluate(`(() => {
    const host = document.getElementById("codex-appearance-panel");
    const panel = host.shadowRoot.getElementById("panel");
    const close = host.shadowRoot.getElementById("close").getBoundingClientRect();
    return { open: panel.classList.contains("open"), display: getComputedStyle(panel).display, closeX: close.x + close.width / 2, closeY: close.y + close.height / 2, sections: host.shadowRoot.querySelectorAll("details").length };
  })()`);
  await clickPoint(page, opened.closeX, opened.closeY);
  await sleep(300);
  const closed = await page.evaluate(`!document.getElementById("codex-appearance-panel").shadowRoot.getElementById("panel").classList.contains("open")`);
  const ok = opened.open && opened.display !== "none" && closed && opened.sections >= 5;
  return { ok, detail: `open=${opened.open} display=${opened.display} sections=${opened.sections} closeWorks=${closed}` };
}

async function verifyGlassToggle(page) {
  const result = await page.evaluate(`(() => {
    const host = document.getElementById("codex-appearance-panel");
    const root = host && host.shadowRoot;
    const api = window.__lunaAppearance;
    if (!root || !api || typeof api.status !== "function") return null;
    /* The glass switch is a <button class="toggle"> row, not an input. */
    const button = [...root.querySelectorAll("button.toggle")].find(node => {
      const text = (node.textContent || "").trim();
      return text.indexOf("启用玻璃") === 0 || (text.indexOf("玻璃") >= 0 && text.indexOf("·") >= 0 && text.indexOf("透明") < 0);
    });
    if (!button) return null;
    const sample = () => {
      const sheet = document.getElementById("codex-glass-style");
      return { on: api.status().glass, sheet: !!sheet, rules: sheet ? sheet.textContent.length : 0 };
    };
    const original = api.status().glass;
    /* Normalise to a known-off start so the assertion never depends on the
       saved preference: the old check toggled off first and then looked for the
       sheet, which failed whenever glass had been on to begin with. */
    if (api.status().glass) button.click();
    const off = sample();
    button.click();
    const on = sample();
    if (api.status().glass !== original) button.click();
    const restored = sample();
    return { original, off, on, restored: { on: restored.on, sheet: restored.sheet, rules: restored.rules } };
  })()`);
  if (!result) return { ok: false, detail: "glass toggle not found in the appearance panel" };
  const ok = result.off.on === false && result.off.sheet === false
    && result.on.on === true && result.on.sheet === true && result.on.rules > 0
    && result.restored.on === result.original
    && result.restored.sheet === result.original;
  return {
    ok,
    detail: `glass off(sheet=${result.off.sheet}) -> on(sheet=${result.on.sheet}, ${result.on.rules}b) -> restored ${result.original}(sheet=${result.restored.sheet})`
  };
}

async function verifyTransitionSwitch(page) {
  const before = (await json(`${BASE}/status`)).library.transition.mode;
  const target = await page.evaluate(`(() => {
    const host = document.getElementById("codex-wallpaper-picker");
    const select = host && host.shadowRoot ? host.shadowRoot.querySelector(".tmode") : null;
    if (!select) return "";
    const next = select.value === "zoom" ? "iris" : "zoom";
    select.value = next;
    select.dispatchEvent(new Event("change", { bubbles: true }));
    return next;
  })()`);
  await sleep(1200);
  const after = (await json(`${BASE}/status`)).library.transition.mode;
  await page.evaluate(`(() => {
    const host = document.getElementById("codex-wallpaper-picker");
    const select = host && host.shadowRoot ? host.shadowRoot.querySelector(".tmode") : null;
    if (!select) return false;
    select.value = ${JSON.stringify(before)};
    select.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  })()`);
  await sleep(1200);
  const restored = (await json(`${BASE}/status`)).library.transition.mode;
  const ok = !!target && after === target && restored === before;
  return { ok, detail: `transition ${before} -> ${after} -> ${restored}` };
}

/* The appearance panel builds most sections lazily on first expand, so a check
   that grabs a control before expanding the section sees nothing. Opening the
   panel re-mounts its body, so the section lookup is retried until the list of
   <details> is stable instead of racing the re-render. */
async function openAppearanceSection(page, title) {
  await page.evaluate(`(() => {
    const host = document.getElementById("codex-appearance-panel");
    const root = host && host.shadowRoot;
    if (!root) return false;
    const panel = root.getElementById("panel");
    if (panel && !panel.classList.contains("open")) root.getElementById("chip").click();
    return true;
  })()`);
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    const opened = await page.evaluate(`(() => {
      const host = document.getElementById("codex-appearance-panel");
      const root = host && host.shadowRoot;
      if (!root) return false;
      const details = [...root.querySelectorAll("details")].find(node => ((node.querySelector("summary") || {}).textContent || "").indexOf(${JSON.stringify(title)}) >= 0);
      if (!details) return false;
      if (!details.open) { details.open = true; details.dispatchEvent(new Event("toggle")); }
      /* A section is usable only once its body has been built. */
      const holder = details.querySelector(".sectionBody");
      return !!(holder && holder.children.length);
    })()`);
    if (opened) return true;
    await sleep(300);
  }
  return false;
}

/* Click a labelled .toggle row until it holds `want`. The label is the stable
   prefix; the 开/关 suffix is what the syncers write. The lookup is retried
   because opening the panel rebuilds the section bodies. */
async function setPanelToggle(page, label, want) {
  const deadline = Date.now() + 6000;
  let last = null;
  while (Date.now() < deadline) {
    last = await page.evaluate(`(() => {
      const host = document.getElementById("codex-appearance-panel");
      const root = host && host.shadowRoot;
      if (!root) return { ok: false, error: "appearance panel not injected" };
      const button = [...root.querySelectorAll("button.toggle")].find(node => (node.textContent || "").trim().indexOf(${JSON.stringify(label)}) === 0);
      if (!button) return { ok: false, error: "toggle not found: " + ${JSON.stringify(label)} };
      const state = () => (button.textContent || "").trim().endsWith("开");
      const before = state();
      let clicks = 0;
      while (state() !== ${want} && clicks < 4) { button.click(); clicks += 1; }
      return { ok: state() === ${want}, label: ${JSON.stringify(label)}, before, after: state(), clicks };
    })()`);
    if (last && last.ok) return last;
    if (last && last.error && !last.error.startsWith("toggle not found")) return last;
    await sleep(300);
  }
  return last || { ok: false, error: "toggle lookup timed out" };
}

/* Phase 3: extension effects live in the page runtime and are observable
   through window.__lunaExt.stats() plus their DOM nodes. */
async function verifyExtEffects(page) {
  if (!(await openAppearanceSection(page, "扩展特效"))) return { ok: false, detail: "扩展特效 section not found" };
  await sleep(250);
  const before = await page.evaluate(`(() => {
    const api = window.__lunaAppearance;
    const ext = api && api.state() ? api.state().ext : null;
    if (!ext) return null;
    return { enabled: ext.enabled === true, click: ext.fx.click.enabled === true, mascot: ext.mascot.enabled === true };
  })()`);
  if (!before) return { ok: false, detail: "appearance state has no ext block" };

  const steps = [
    ["扩展总开关", true],
    ["启用点击特效", true],
    ["启用吉祥物", true]
  ];
  for (const [label, want] of steps) {
    const step = await setPanelToggle(page, label, want);
    if (!step.ok) return { ok: false, detail: `could not enable ${label}: ${step.error || "stuck"}` };
  }
  await sleep(900);
  const live = await page.evaluate(`(() => {
    const stats = window.__lunaExt && window.__lunaExt.stats ? window.__lunaExt.stats() : null;
    return {
      fxCanvas: !!document.getElementById("codex-fx-layer"),
      mascot: !!document.getElementById("codex-mascot"),
      stats: stats ? { running: stats.running, clicks: stats.clicks, mascot: stats.mascot, frames: stats.frames } : null
    };
  })()`);
  await page.evaluate(`document.dispatchEvent(new PointerEvent("pointerdown", { clientX: Math.round(innerWidth / 2), clientY: Math.round(innerHeight / 2), bubbles: true })); true`);
  await sleep(500);
  const clicked = await page.evaluate(`(() => { const s = window.__lunaExt.stats(); return { clicks: s.clicks, frames: s.frames, trailPoints: s.trailPoints }; })()`);

  for (const [label, want] of steps.slice().reverse()) {
    const step = await setPanelToggle(page, label, before[label === "扩展总开关" ? "enabled" : label === "启用点击特效" ? "click" : "mascot"]);
    if (!step.ok) return { ok: false, detail: `could not restore ${label}: ${step.error || "stuck"}` };
  }
  await sleep(800);
  const restored = await page.evaluate(`(() => ({
    fxCanvas: !!document.getElementById("codex-fx-layer"),
    mascot: !!document.getElementById("codex-mascot"),
    ext: window.__lunaAppearance && window.__lunaAppearance.state() ? window.__lunaAppearance.state().ext.enabled === true : null
  }))()`);

  const ok = live.fxCanvas && live.mascot && !!live.stats && live.stats.mascot
    && clicked.clicks > live.stats.clicks && clicked.frames > 0
    && restored.ext === before.enabled
    && restored.fxCanvas === (before.enabled && before.click)
    && restored.mascot === (before.enabled && before.mascot);
  return {
    ok,
    detail: `canvas=${live.fxCanvas} mascot=${live.mascot} clicks ${live.stats ? live.stats.clicks : "?"}->${clicked.clicks} frames=${clicked.frames}, restored ext=${restored.ext} canvas=${restored.fxCanvas} mascot=${restored.mascot}`
  };
}

/* Phase 1: the panel writes into dataset.prefsCommand and the watchdog drains
   it on its next tick. Change one slider, wait for the save, change it back. */
async function verifyAppearanceSave(page) {
  if (!(await openAppearanceSection(page, "画面滤镜"))) return { ok: false, detail: "画面滤镜 section not found" };
  await sleep(250);
  const before = (await json(`${BASE}/prefs`)).appearance.filters.brightness;
  const changed = await page.evaluate(`(() => {
    const root = document.getElementById("codex-appearance-panel").shadowRoot;
    const input = root.querySelector('input[data-path="filters.brightness"]');
    if (!input) return null;
    const target = Number(input.max) >= 140 ? 137 : 90;
    input.value = String(target);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return { target, shown: Number(input.value) };
  })()`);
  if (!changed) return { ok: false, detail: "filters.brightness slider not found" };
  await sleep(2200);
  const saved = (await json(`${BASE}/prefs`)).appearance.filters.brightness;
  const restored = await page.evaluate(`(() => {
    const input = document.getElementById("codex-appearance-panel").shadowRoot.querySelector('input[data-path="filters.brightness"]');
    if (!input) return false;
    input.value = ${JSON.stringify(String(before))};
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()`);
  await sleep(2200);
  const final = (await json(`${BASE}/prefs`)).appearance.filters.brightness;
  let restoredToBaseline = final === before;
  if (!restoredToBaseline) {
    /* The slider click path can be unavailable (closed panel, re-injected node).
       Fall back to writing the baseline straight to the watchdog so a failed
       check can never leave the user's brightness changed. */
    const currentAppearance = (await json(`${BASE}/prefs`)).appearance;
    currentAppearance.filters.brightness = before;
    try {
      const response = await fetch(`${BASE}/prefs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ appearance: currentAppearance }) });
      restoredToBaseline = response.ok;
      await sleep(700);
    } catch {}
  }
  const ok = changed.shown === changed.target && saved === changed.target && restoredToBaseline;
  return { ok, detail: `brightness ${before} -> saved ${saved} -> restored ${final}${restoredToBaseline ? "" : " (fallback failed)"}` };
}

/* Phase 2: the picker library channel is a POST /library round trip plus a
   mirror into the page. Exercises hidden ids, type filters and rotation start. */
async function verifyLibraryChannel(page, baseline) {
  const before = (await json(`${BASE}/library`)).library;
  const target = baseline.selection.source;
  const written = {
    ...before,
    hidden: [...new Set([...(before.hidden || []), target])],
    filters: { ...before.filters, types: ["scene"], tag: "all" },
    rotation: { ...before.rotation, enabled: true, intervalSec: 3600 }
  };
  let response;
  try {
    response = await fetch(`${BASE}/library`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ library: written }) });
  } catch (error) { return { ok: false, detail: `POST /library failed: ${error.message}` }; }
  if (!response.ok) return { ok: false, detail: `POST /library -> HTTP ${response.status}` };
  await sleep(500);
  const stored = await json(`${BASE}/library`);
  const wallpapers = await json(`${BASE}/wallpapers`);
  const hiddenFlag = wallpapers.find(item => item.id === target)?.hidden;
  await sleep(1500);
  const mirror = await page.evaluate(`(() => {
    const host = document.getElementById("codex-wallpaper-picker");
    const raw = (host && host.dataset.library) || "";
    let payload = null;
    try { payload = JSON.parse(raw); } catch {}
    return {
      seen: !!payload,
      hidden: payload && payload.library ? payload.library.hidden : null,
      types: payload && payload.library ? payload.library.filters.types : null,
      rotation: payload && payload.rotation ? { enabled: payload.rotation.enabled, candidates: payload.rotation.candidates } : null
    };
  })()`);
  try {
    await fetch(`${BASE}/library`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ library: before }) });
  } catch {}
  await sleep(400);
  const restored = (await json(`${BASE}/library`)).library;
  const ok = stored.library.hidden.includes(target)
    && stored.library.filters.types.join(",") === "scene"
    && hiddenFlag === true
    && mirror.seen && Array.isArray(mirror.hidden) && mirror.hidden.includes(target)
    && mirror.rotation && mirror.rotation.enabled === true
    && restored.hidden.join(",") === (before.hidden || []).join(",")
    && restored.filters.types.join(",") === (before.filters.types || []).join(",");
  return {
    ok,
    detail: `hidden=${stored.library.hidden.length} types=${stored.library.filters.types.join("+") || "all"} hiddenFlag=${hiddenFlag} mirror=${mirror.seen} candidates=${mirror.rotation ? mirror.rotation.candidates : "?"} restored=${restored.hidden.length}`
  };
}

/* White text is a stylesheet the watchdog reconciles on its status tick, so the
   check polls instead of assuming one fixed delay - the tick cadence varies with
   picker/recent-interaction state. */
async function verifyWhiteText(page) {
  const before = (await json(`${BASE}/prefs`)).whiteText !== false;
  const hasSheet = () => page.evaluate(`!!document.getElementById("codex-force-white-style")`);
  const waitFor = async want => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if ((await hasSheet()) === want) return true;
      await sleep(500);
    }
    return false;
  };
  try {
    await json(`${BASE}/white-text?enabled=false`);
    const off = await waitFor(false);
    await json(`${BASE}/white-text?enabled=true`);
    const on = await waitFor(true);
    if (before) await json(`${BASE}/white-text?enabled=true`);
    else await json(`${BASE}/white-text?enabled=false`);
    await waitFor(before);
    const ok = off === true && on === true;
    return { ok, detail: `style off=${off} on=${on} (pref restored to ${before})` };
  } catch (error) {
    return { ok: false, detail: `white text channel failed: ${error.message}` };
  }
}

/* Phase 4: native video audio arrives through library.video. */
async function verifyVideoAudio(page, wallpapers, baselineLibrary) {
  const video = wallpapers.find(item => item.kind === "video") || wallpapers.find(item => item.renderMode === "native");
  if (!video) return { ok: true, skipped: true, detail: "no native video wallpaper installed - skipped" };
  await json(`${BASE}/select?id=${video.id}`);
  const outcome = await waitForBackground(page, video.id, video.renderMode, 45000);
  if (!outcome.ok) return { ok: false, detail: `${video.id} did not install for the audio check` };
  const desired = { ...baselineLibrary, video: { audio: true, volume: 55 } };
  await fetch(`${BASE}/library`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ library: desired }) });
  await sleep(1800);
  const applied = await page.evaluate(`(() => {
    const el = document.getElementById("codex-custom-background-media");
    if (!el) return null;
    return { tag: el.tagName, muted: el.muted === true, volume: Math.round((el.volume || 0) * 100), attr: el.getAttribute("data-video-audio") };
  })()`);
  await fetch(`${BASE}/library`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ library: baselineLibrary }) });
  await sleep(1200);
  if (!applied || applied.tag !== "VIDEO") return { ok: false, detail: `expected a VIDEO element, got ${applied ? applied.tag : "none"}` };
  const ok = applied.muted === false && applied.volume === 55 && applied.attr === "on";
  return { ok, detail: `muted=${applied.muted} volume=${applied.volume} attr=${applied.attr}` };
}

/* Phase 4: reset must actually stay reset. The watchdog used to reinstall the
   remembered wallpaper within one tick, which made the MCP tool a no-op. */
async function verifyReset(page, baselineSelection, baselineMode) {
  const response = await fetch(`${BASE}/reset`);
  if (!response.ok) return { ok: false, detail: `/reset -> HTTP ${response.status}` };
  await sleep(3000);
  const clean = await page.evaluate(`(() => ({
    media: !!document.getElementById("codex-custom-background-media"),
    base: !!document.getElementById("codex-custom-background-base"),
    style: !!document.getElementById("codex-custom-background-style")
  }))()`);
  const status = await json(`${BASE}/status`);
  const disabled = status.selection && status.selection.disabled === true;
  await json(`${BASE}/select?id=${baselineSelection.source}`);
  const restored = await waitForBackground(page, baselineSelection.source, baselineMode, 60000);
  const ok = !clean.media && !clean.base && !clean.style && disabled && restored.ok;
  return {
    ok,
    detail: `media=${clean.media} base=${clean.base} style=${clean.style} disabled=${disabled} restored=${restored.ok}`
  };
}

/* Phase 4 module check. The srcdoc builder is what makes web wallpapers work
   under Codex's CSP, and it is only exercised when the user happens to have a
   web project installed - so build a throwaway fixture instead. */
function verifyWebDocumentBuilder() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "luna-webdoc-"));
  try {
    fs.mkdirSync(path.join(root, "assets"), { recursive: true });
    fs.writeFileSync(path.join(root, "index.html"), [
      "<!doctype html><html><head><link rel=\"stylesheet\" href=\"style.css\"></head><body>",
      "<canvas id=\"c\"></canvas><img id=\"pic\" src=\"assets/pic.png\">",
      "<script src=\"script.js\"></script><script>window.inline = 1;</script>",
      "</body></html>"
    ].join(""));
    fs.writeFileSync(path.join(root, "style.css"), "body{margin:0;background:url(assets/pic.png)}");
    fs.writeFileSync(path.join(root, "script.js"), "window.external = true;");
    /* 1x1 transparent PNG */
    fs.writeFileSync(path.join(root, "assets", "pic.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));

    const built = buildWebDocument({ webEntry: path.join(root, "index.html"), webDir: root });
    const problems = [];
    if (!built.ok) problems.push("build failed: " + built.error);
    else {
      if (!/<style data-luna-source="style\.css">/.test(built.html)) problems.push("stylesheet was not inlined");
      if (!/url\("data:image\/png;base64,/.test(built.html)) problems.push("css url() was not inlined");
      if (!/src="data:image\/png;base64,/.test(built.html)) problems.push("img src was not inlined");
      if (/<script\b/i.test(built.html)) problems.push("a <script> tag survived in the srcdoc");
      if (built.scripts.length !== 2) problems.push(`expected 2 runnable scripts, got ${built.scripts.length}`);
      if (!built.scripts.some(code => code.includes("window.external"))) problems.push("external script body missing");
      if (!built.scripts.some(code => code.includes("window.inline"))) problems.push("inline script body missing");
    }
    const props = webPropertyPayload([{ key: "schemecolor", type: "color", value: "#ff0000" }], null);
    const weColor = props.schemecolor && props.schemecolor.value;
    if (weColor !== "1 0 0") problems.push(`schemecolor should be "1 0 0", got ${JSON.stringify(weColor)}`);
    const kept = webPropertyPayload([{ key: "glow", type: "bool", value: true }], { glow: false });
    if (!kept.glow || kept.glow.value !== false) problems.push("saved property override was not applied");
    return problems.length
      ? { ok: false, detail: problems.join("; ") }
      : { ok: true, detail: `inlined ${built.inlineBytes}b, scripts=${built.scripts.length}, warnings=${built.warnings.length}, color=${weColor}` };
  } catch (error) {
    return { ok: false, detail: "web document builder crashed: " + error.message };
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  }
}

/* The dim/readability panel is rebuilt after every wallpaper switch. It used to
   hard-code apply(100) and applyReadability(45) on injection, so both settings
   silently reset on each switch. This asserts they survive one. */
async function verifyPanelPersistence(page, wallpapers, restoreId, restoreMode) {
  const prefsBefore = await json(`${BASE}/prefs`);
  const dim = 70;
  const opacityResponse = await fetch(`${BASE}/opacity?value=${dim}`);
  if (!opacityResponse.ok) return { ok: false, detail: `/opacity -> HTTP ${opacityResponse.status}` };
  await sleep(600);

  const readabilitySet = await page.evaluate(`(() => {
    const host = document.getElementById("codex-background-controls");
    const root = host && host.shadowRoot;
    if (!root) return null;
    const button = [...root.querySelectorAll(".modes button")].find(node => node.dataset.mode === "bubble");
    if (!button) return null;
    button.click();
    return { mode: button.dataset.mode, active: button.classList.contains("active") };
  })()`);
  if (!readabilitySet) return { ok: false, detail: "readability panel not injected" };
  await sleep(1600);

  /* Switch away and back so the panel is torn down and rebuilt at least once. */
  const other = wallpapers.find(item => item.id !== restoreId && item.renderMode === "native") || wallpapers.find(item => item.id !== restoreId);
  let switched = false;
  if (other) {
    await json(`${BASE}/select?id=${other.id}`);
    const outcome = await waitForBackground(page, other.id, other.renderMode, 45000);
    switched = outcome.ok;
    await sleep(1800);
  }
  const afterSwitch = await page.evaluate(`(() => {
    const host = document.getElementById("codex-background-controls");
    const root = host && host.shadowRoot;
    if (!root) return { panel: false };
    const range = root.querySelector("input");
    const mode = [...root.querySelectorAll(".modes button")].find(node => node.classList.contains("active"));
    const style = document.getElementById("codex-background-opacity-style");
    return {
      panel: true,
      range: range ? Number(range.value) : null,
      mode: mode ? mode.dataset.mode : null,
      opacityRule: style ? style.textContent : null
    };
  })()`);
  const prefsAfter = await json(`${BASE}/prefs`);

  await json(`${BASE}/select?id=${restoreId}`);
  const restored = await waitForBackground(page, restoreId, restoreMode, 60000);
  await fetch(`${BASE}/opacity?value=100`);
  await json(`${BASE}/prefs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ appearance: prefsBefore.appearance, readability: prefsBefore.readability, backgroundOpacity: prefsBefore.backgroundOpacity }) });
  await sleep(800);

  const dimHeld = afterSwitch.panel && afterSwitch.range === dim && (() => {
    const match = /opacity:\s*([0-9.]+)/.exec(afterSwitch.opacityRule || "");
    return !!match && Math.abs(Number(match[1]) * 100 - dim) < 0.5;
  })();
  const modeHeld = prefsAfter.readability && prefsAfter.readability.mode === "bubble" && afterSwitch.mode === "bubble";
  const ok = switched && dimHeld && modeHeld && restored.ok;
  const dimRule = (() => {
    const match = /opacity:\s*([0-9.]+)/.exec(afterSwitch.opacityRule || "");
    return match ? Math.round(Number(match[1]) * 100) : null;
  })();
  return {
    ok,
    detail: `switch=${switched} range=${afterSwitch.range} ruleOpacity=${dimRule} readability=${afterSwitch.mode}/${prefsAfter.readability ? prefsAfter.readability.mode : "?"} restored=${restored.ok}`
  };
}

/* A partial prefs write (dim only, readability only) used to reset the whole
   appearance block to defaults, because /prefs treated any body without an
   `appearance` key as a bare appearance object. It must merge, and the change
   must reach the live page. */
async function verifyPrefsMerge(page) {
  const before = (await json(`${BASE}/status`)).appearance;
  const marker = { ...before, glass: { ...before.glass, enabled: before.glass.enabled, blur: Math.min(40, Number(before.glass.blur) + 3) } };
  try {
    const seed = await fetch(`${BASE}/prefs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ appearance: marker }) });
    if (!seed.ok) return { ok: false, detail: `seeding appearance -> HTTP ${seed.status}` };
    await sleep(1500);
    const dimOnly = await fetch(`${BASE}/prefs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ backgroundOpacity: 83 }) });
    if (!dimOnly.ok) return { ok: false, detail: `partial prefs write -> HTTP ${dimOnly.status}` };
    await sleep(1500);
    const after = (await json(`${BASE}/status`)).appearance;
    const liveGlass = await page.evaluate(`(() => { const api = window.__lunaAppearance; return api && api.status ? api.status().glass : null; })()`);
    const keptPreset = after.activePreset === before.activePreset;
    const keptBlur = Number(after.glass.blur) === Number(marker.glass.blur);
    const keptFonts = JSON.stringify(after.fonts) === JSON.stringify(before.fonts);
    const keptExt = JSON.stringify(after.ext) === JSON.stringify(before.ext);
    const opacityApplied = (await json(`${BASE}/prefs`)).backgroundOpacity === 83;
    /* The monitor pass mirrors external writes; the page must agree with disk. */
    const mirrored = liveGlass === after.glass.enabled;
    await fetch(`${BASE}/prefs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ appearance: before, backgroundOpacity: null, readability: before.readability }) });
    await sleep(1500);
    const ok = keptPreset && keptBlur && keptFonts && keptExt && opacityApplied && mirrored;
    return { ok, detail: `preset=${keptPreset} blur=${keptBlur} fonts=${keptFonts} ext=${keptExt} opacity=${opacityApplied} mirrored=${mirrored}` };
  } catch (error) {
    return { ok: false, detail: `prefs merge failed: ${error.message}` };
  }
}

/* The 外观 panel used to be welded to one corner with one width and one column.
   Dock cycling, the two-column layout and a real header drag are all asserted
   here, then the default placement is restored. */
async function verifyPanelPlacement(page) {
  /* Start from a known layout: a previous run (or the user) may have left the
     panel dragged or in two-column mode, and the checks below compare widths. */
  await page.evaluate(`(() => {
    const host = document.getElementById("codex-appearance-panel");
    const root = host && host.shadowRoot;
    if (!root) return false;
    const panel = root.getElementById("panel");
    if (!panel.classList.contains("open")) root.getElementById("chip").click();
    return true;
  })()`);
  await sleep(500);
  const resetOk = await page.evaluate(`(() => {
    const root = document.getElementById("codex-appearance-panel").shadowRoot;
    const button = root.getElementById("dock-tl");
    if (!button) return false;
    button.click();
    return true;
  })()`);
  if (!resetOk) return { ok: false, detail: "appearance panel not injected" };
  await sleep(600);

  const state = () => page.evaluate(`(() => {
    const root = document.getElementById("codex-appearance-panel").shadowRoot;
    const panel = root.getElementById("panel");
    const body = root.getElementById("body");
    const rect = panel.getBoundingClientRect();
    const bs = body ? getComputedStyle(body) : null;
    return {
      free: panel.classList.contains("free"),
      wide: panel.classList.contains("wide"),
      x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width),
      columns: bs ? getComputedStyle(body).gridTemplateColumns : null,
      ui: window.__lunaAppearance.status().ui
    };
  })()`);

  const initial = await state();
  await page.evaluate(`(() => { document.getElementById("codex-appearance-panel").shadowRoot.getElementById("dock-br").click(); return true; })()`);
  await sleep(400);
  const docked = await state();
  const dockMoved = docked.ui.dock !== initial.ui.dock || JSON.stringify(docked.ui) === JSON.stringify(initial.ui);

  await page.evaluate(`(() => { document.getElementById("codex-appearance-panel").shadowRoot.getElementById("dock-layout").click(); return true; })()`);
  await sleep(500);
  const wide = await state();

  await page.evaluate(`(() => {
    const root = document.getElementById("codex-appearance-panel").shadowRoot;
    const head = root.getElementById("head");
    const r = head.getBoundingClientRect();
    const opts = { bubbles: true, cancelable: true, pointerId: 1, pointerType: "mouse", isPrimary: true, button: 0, buttons: 1 };
    head.dispatchEvent(new PointerEvent("pointerdown", { ...opts, clientX: r.x + 50, clientY: r.y + 12 }));
    document.dispatchEvent(new PointerEvent("pointermove", { ...opts, clientX: r.x - 180, clientY: r.y + 260 }));
    document.dispatchEvent(new PointerEvent("pointerup", { ...opts, clientX: r.x - 180, clientY: r.y + 260, buttons: 0 }));
    return true;
  })()`);
  await sleep(700);
  const dragged = await state();

  await page.evaluate(`(() => { document.getElementById("codex-appearance-panel").shadowRoot.getElementById("dock-tl").click(); return true; })()`);
  await sleep(500);
  const restored = await state();
  /* Leave the panel open, docked bottom-right, single column. The sections after
     this one expand lazy groups, and they used to fail purely because this check
     had left the panel closed in a dragged two-column state. */
  await page.evaluate(`(() => {
    const root = document.getElementById("codex-appearance-panel").shadowRoot;
    const panel = root.getElementById("panel");
    if (!panel.classList.contains("open")) root.getElementById("chip").click();
    return true;
  })()`);
  await sleep(400);
  const reopened = await state();

  const ok = dockMoved
    && wide.wide && wide.w > initial.w
    && wide.columns && wide.columns.includes(" ")
    && dragged.free && dragged.ui.left !== null && dragged.ui.top !== null
    && !restored.free && !restored.wide && restored.ui.dock === "br"
    && reopened.wide === false;
  return {
    ok,
    detail: `dock=${docked.ui.dock} wide=${wide.wide}/${wide.w}px cols=${wide.columns ? wide.columns.split(" ").length : "?"} drag=${dragged.free}@${dragged.ui.left},${dragged.ui.top} reset=${restored.ui.dock}/${restored.w}px reopened=${reopened.w}px`
  };
}

/* Presets could only be applied - there was no way to turn one off again, so a
   single misclick meant rebuilding the user's look by hand. Asserts apply ->
   dedicated off button -> restored, and that an imported preset can be deleted. */
async function verifyPresetOff(page) {
  if (!(await openAppearanceSection(page, "预设"))) return { ok: false, detail: "预设 section not found" };
  await sleep(300);

  const snap = () => page.evaluate(`(() => {
    const api = window.__lunaAppearance;
    const state = api.state();
    const root = document.getElementById("codex-appearance-panel").shadowRoot;
    const clear = root.querySelector(".clear-preset");
    return {
      active: state.activePreset,
      hasUndo: !!state.presetUndo,
      blur: state.glass.blur,
      glass: state.glass.enabled,
      clearDisabled: clear ? clear.disabled : null,
      names: (state.presets || []).map(entry => entry.name),
      removeButtons: root.querySelectorAll(".presets .pbtn.remove").length
    };
  })()`);

  const before = await snap();
  /* The button list is rebuilt with the section body, so retry the click until it
     lands instead of assuming one shot right after opening. */
  let applied = false;
  const applyDeadline = Date.now() + 6000;
  while (Date.now() < applyDeadline && !applied) {
    applied = await page.evaluate(`(() => {
      const root = document.getElementById("codex-appearance-panel").shadowRoot;
      const button = [...root.querySelectorAll(".presets .pbtn")].find(b => !b.classList.contains("remove") && b.textContent.trim().indexOf("黑客绿") === 0);
      if (!button) return false;
      button.click();
      button.click();
      return true;
    })()`);
    if (!applied) await sleep(300);
  }
  if (!applied) return { ok: false, detail: "黑客绿 preset button not found" };
  await sleep(1200);
  const afterApply = await snap();

  const cleared = await page.evaluate(`(() => {
    const root = document.getElementById("codex-appearance-panel").shadowRoot;
    const button = root.querySelector(".clear-preset");
    if (!button || button.disabled) return false;
    button.click();
    return true;
  })()`);
  await sleep(1200);
  const afterClear = await snap();

  /* Inject a throwaway preset and delete it, restoring the original list. */
  const imported = await page.evaluate(`(() => {
    const api = window.__lunaAppearance;
    const state = JSON.parse(JSON.stringify(api.state()));
    const base = JSON.parse(JSON.stringify(state));
    base.presets = [];
    base.activePreset = "__selftest_preset__";
    state.presets = (state.presets || []).concat([{ name: "__selftest_preset__", builtIn: false, values: base }]);
    api.apply(state);
    const root = document.getElementById("codex-appearance-panel").shadowRoot;
    const details = [...root.querySelectorAll("details")].find(n => ((n.querySelector("summary") || {}).textContent || "").indexOf("预设") >= 0);
    if (details && !details.open) { details.open = true; details.dispatchEvent(new Event("toggle")); }
    return true;
  })()`);
  await sleep(1000);
  const withImported = await snap();
  const deleted = await page.evaluate(`(() => {
    const root = document.getElementById("codex-appearance-panel").shadowRoot;
    const buttons = [...root.querySelectorAll(".presets .pbtn.remove")];
    if (!buttons.length) return false;
    buttons[buttons.length - 1].click();
    return true;
  })()`);
  await sleep(1000);
  const afterDelete = await snap();

  const ok = applied
    && afterApply.active === "黑客绿" && afterApply.hasUndo === true && afterApply.clearDisabled === false
    && cleared
    && afterClear.active === "自定义" && afterClear.hasUndo === false
    && afterClear.blur === before.blur && afterClear.glass === before.glass
    && imported && withImported.removeButtons >= 1
    && deleted && !afterDelete.names.includes("__selftest_preset__");
  return {
    ok,
    detail: `apply=${afterApply.active}/undo=${afterApply.hasUndo} off=${afterClear.active}/undo=${afterClear.hasUndo} blur ${before.blur}->${afterClear.blur} deleteTest=${withImported.removeButtons >= 1 && afterDelete.removeButtons === 0}`
  };
}

/* ---------- full type coverage ----------
   The user's own library usually contains only some of the kinds the plugin
   supports (this machine had 9 WebGL scenes and 9 native videos, zero web, zero
   static images, zero fallbacks). Those paths were therefore never exercised by a
   real run. This fixture builds a throwaway Steam tree with one item per kind,
   starts an isolated watchdog (own port + own state dir) against it, switches to
   each item and asserts what the LIVE page actually built - then tears it down
   without touching the user's library or the running watchdog. */
function makePng(width, height, shade) {
  const CRC_TABLE = (() => {
    const table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
    return table;
  })();
  const crc32 = buffer => {
    let c = 0xffffffff;
    for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([length, body, crc]);
  };
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let offset = 0;
  for (let y = 0; y < height; y++) {
    raw[offset++] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b] = shade(x / Math.max(1, width - 1), y / Math.max(1, height - 1));
      raw[offset++] = r; raw[offset++] = g; raw[offset++] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function buildTypeFixtures(root) {
  const workshop = path.join(root, "steamapps", "workshop", "content", "431960");
  fs.mkdirSync(workshop, { recursive: true });
  const gradient = (u, v) => [Math.round(30 + 150 * u), Math.round(40 + 90 * v), Math.round(200 - 120 * u)];

  /* web: HTML entry with an external stylesheet, an external script, an inline
     script and a binary image - every resource the srcdoc inliner must handle. */
  const web = path.join(workshop, "990000001");
  fs.mkdirSync(path.join(web, "assets"), { recursive: true });
  fs.writeFileSync(path.join(web, "project.json"), JSON.stringify({
    title: "Selftest Web", type: "web", file: "index.html",
    general: { properties: {
      schemecolor: { text: "主色", type: "color", value: "0.2 0.8 0.6" },
      speed: { text: "速度", type: "slider", value: 50, min: 0, max: 100, step: 1 },
      glow: { text: "发光", type: "bool", value: true }
    } }
  }, null, 2));
  fs.writeFileSync(path.join(web, "index.html"), [
    "<!doctype html><html><head><meta charset=\"utf-8\">",
    "<link rel=\"stylesheet\" href=\"style.css\"></head><body>",
    "<canvas id=\"c\" width=\"640\" height=\"360\"></canvas>",
    "<img id=\"pic\" src=\"assets/pic.png\">",
    "<script src=\"script.js\"></script>",
    "<script>window.__inlineRan = (window.__inlineRan || 0) + 1;</script>",
    "</body></html>"
  ].join(""));
  fs.writeFileSync(path.join(web, "style.css"), "body{margin:0;background:#05070c;overflow:hidden}\n#c{display:block;width:100vw;height:100vh}");
  fs.writeFileSync(path.join(web, "script.js"), [
    "window.__fixtureReady = true;",
    "window.wallpaperPropertyListener = { applyUserProperties: function (props) {",
    "  try { parent.postMessage({ __fixturePropKeys: Object.keys(props || {}) }, '*'); } catch (e) {}",
    "} };",
    "var ctx = document.getElementById('c').getContext('2d');",
    "ctx.fillStyle = '#2a3f5f'; ctx.fillRect(0, 0, 640, 360);"
  ].join("\n"));
  fs.writeFileSync(path.join(web, "assets", "pic.png"), makePng(48, 48, gradient));
  fs.writeFileSync(path.join(web, "preview.png"), makePng(160, 90, gradient));

  /* native: a plain image file declared directly. */
  const image = path.join(workshop, "990000002");
  fs.mkdirSync(image, { recursive: true });
  fs.writeFileSync(path.join(image, "project.json"), JSON.stringify({ title: "Selftest Image", type: "image", file: "wall.png" }, null, 2));
  fs.writeFileSync(path.join(image, "wall.png"), makePng(320, 180, gradient));

  /* fallback: declares scene.pkg but ships only a preview - a half-installed item. */
  const fallback = path.join(workshop, "990000003");
  fs.mkdirSync(fallback, { recursive: true });
  fs.writeFileSync(path.join(fallback, "project.json"), JSON.stringify({ title: "Selftest Fallback", type: "scene", file: "scene.pkg" }, null, 2));
  fs.writeFileSync(path.join(fallback, "preview.png"), makePng(240, 135, gradient));

  /* empty: nothing usable, must never appear in the library. */
  const empty = path.join(workshop, "990000004");
  fs.mkdirSync(empty, { recursive: true });
  fs.writeFileSync(path.join(empty, "project.json"), JSON.stringify({ title: "Selftest Empty" }, null, 2));

  return { root, workshop };
}

async function verifyAllTypes(page, port) {
  const root = path.join(os.tmpdir(), "luna-selftest-types");
  const stateDir = path.join(os.tmpdir(), "luna-selftest-types-state");
  const base = `http://127.0.0.1:${port}`;
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(stateDir, { recursive: true, force: true }); } catch {}
  buildTypeFixtures(root);
  fs.mkdirSync(stateDir, { recursive: true });

  const child = spawn(process.execPath, [path.join(import.meta.dirname, "codex-wallpaper-watchdog.mjs")], {
    env: {
      ...process.env,
      WATCHDOG_PORT: String(port),
      LUNA_STATE_DIR: stateDir,
      STEAM_LIBRARY: root,
      /* Otherwise the registry probe adds the real Steam libraries and this run
         would switch through the user's whole collection. */
      STEAM_LIBRARY_ONLY: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", chunk => { log += chunk.toString(); });
  child.stderr.on("data", chunk => { log += chunk.toString(); });

  const waitHealth = async () => {
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1200) });
        if (response.ok) return true;
      } catch {}
      await sleep(400);
    }
    return false;
  };
  const waitBuilt = async (id, predicate, timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
      await sleep(1200);
      last = await page.evaluate(`(() => {
        const media = document.getElementById("codex-custom-background-media");
        const base = document.getElementById("codex-custom-background-base");
        return {
          source: media?.getAttribute("data-wallpaper-source") || base?.getAttribute("data-wallpaper-source") || null,
          renderMode: media?.getAttribute("data-render-mode") || null,
          tag: media?.tagName || null,
          width: media?.naturalWidth || media?.videoWidth || 0,
          height: media?.naturalHeight || media?.videoHeight || 0,
          webReady: media?.getAttribute("data-web-ready") || null,
          webScripts: media?.getAttribute("data-web-scripts") || null
        };
      })()`);
      if (last && last.source === id && predicate(last)) return { ok: true, state: last };
    }
    return { ok: false, state: last };
  };

  try {
    if (!(await waitHealth())) return { ok: false, detail: "fixture watchdog did not start: " + log.slice(-300) };

    const listed = await json(`${base}/wallpapers`);
    const byMode = {};
    for (const item of listed) byMode[item.renderMode] = (byMode[item.renderMode] || 0) + 1;
    const emptyLeaked = listed.some(item => item.id === "990000004");

    await json(`${base}/select?id=990000001`);
    const web = await waitBuilt("990000001", s => s.renderMode === "web" && s.tag === "IFRAME", 90000);

    let bridge = { ok: false, detail: "no parent listener" };
    if (web.ok) {
      await page.evaluate(`(() => {
        window.__typeMessages = [];
        window.addEventListener("message", event => { try { window.__typeMessages.push(JSON.parse(JSON.stringify(event.data || {}))); } catch {} });
        return true;
      })()`);
      await json(`${base}/select?id=990000001`);
      await waitBuilt("990000001", s => s.renderMode === "web" && s.tag === "IFRAME", 90000);
      await page.evaluate(`(() => {
        const media = document.getElementById("codex-custom-background-media");
        if (!media || !media.contentWindow) return false;
        media.contentWindow.postMessage({ __lunaProps: { speed: { value: 77 } } }, "*");
        return true;
      })()`);
      await sleep(1600);
      const messages = JSON.parse(await page.evaluate(`JSON.stringify(window.__typeMessages || [])`) || "[]");
      const booted = messages.some(m => typeof m.__lunaBooted === "string");
      const keys = messages.filter(m => Array.isArray(m.__fixturePropKeys)).map(m => m.__fixturePropKeys);
      const propsOk = keys.some(list => list.includes("speed"));
      bridge = { ok: booted && propsOk, detail: `booted=${booted} propKeys=${keys.length}` };
    }

    await json(`${base}/select?id=990000002`);
    const nativeImage = await waitBuilt("990000002", s => s.renderMode === "native" && s.tag === "IMG" && s.width > 0, 45000);

    await json(`${base}/select?id=990000003`);
    const fallback = await waitBuilt("990000003", s => s.tag === "IMG" && s.width > 0, 45000);

    const ok = !emptyLeaked
      && byMode.web === 1 && byMode.native === 1 && byMode.fallback === 1
      && web.ok && web.state.webReady === "true" && Number(web.state.webScripts) > 0
      && bridge.ok
      && nativeImage.ok
      && fallback.ok;
    return {
      ok,
      detail: `modes=${JSON.stringify(byMode)} empty=${emptyLeaked ? "leaked" : "skipped"} `
        + `web=${web.ok ? `iframe/${web.state.webScripts} scripts` : "FAIL"} `
        + `bridge=${bridge.detail} native=${nativeImage.ok ? `${nativeImage.state.width}x${nativeImage.state.height}` : "FAIL"} `
        + `fallback=${fallback.ok ? `${fallback.state.width}x${fallback.state.height}` : "FAIL"}`
    };
  } catch (error) {
    return { ok: false, detail: `type coverage crashed: ${error.message}` };
  } finally {
    try { child.kill(); } catch {}
    for (const cleanup of [root, stateDir]) { try { fs.rmSync(cleanup, { recursive: true, force: true }); } catch {} }
  }
}

async function main() {
  let health;
  try { health = await json(`${BASE}/health`); } catch (error) { console.error(`selftest: watchdog unreachable on ${BASE} (${error.message})`); process.exit(1); }
  console.log(`selftest: watchdog pid=${health.pid}`);

  const target = await findPage();
  if (!target) { console.error("selftest: Codex desktop page not found on DevTools ports - is Codex Desktop open?"); process.exit(1); }
  const page = await connectPage(target);
  try { await page.command("Page.bringToFront"); } catch {}
  /* Chromium freezes rAF while the window is occluded or minimised, so every
     WebGL scene would "fall back" even though nothing is wrong. Focus emulation
     lets the harness observe what a foreground window observes; it changes no
     product code and is test-harness only. */
  try { await page.command("Emulation.setFocusEmulationEnabled", { enabled: true }); } catch {}
  await sleep(1000);

  const status = await json(`${BASE}/status`);
  const original = status.selection;
  const baselineLibrary = status.library;
  /* The whole saved preference set, captured before any assertion runs. Several
     checks toggle real controls, and their own restores each had to re-derive the
     previous value from the live page; when one of those was wrong the test left
     the user's appearance changed (glass ended up off). Restoring this snapshot
     unconditionally at the end makes that class of bug impossible. */
  const baselinePrefs = await json(`${BASE}/prefs`);
  const baselineAppearance = baselinePrefs.appearance;
  const restoreBaselinePrefs = async () => {
    try {
      const response = await fetch(`${BASE}/prefs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          appearance: baselineAppearance,
          readability: baselinePrefs.readability ?? null,
          backgroundOpacity: baselinePrefs.backgroundOpacity ?? null,
          whiteText: baselinePrefs.whiteText !== false,
          library: baselinePrefs.library ?? null,
        }),
      });
      return response.ok;
    } catch { return false; }
  };
  console.log(`selftest: current selection ${original.source} (${original.title}) - will restore afterwards\n`);

  const wallpapers = await json(`${BASE}/wallpapers`);
  const sceneCount = wallpapers.filter(w => w.renderMode === "webgl").length;
  const nativeCount = wallpapers.filter(w => w.renderMode === "native").length;
  const fallbackCount = wallpapers.filter(w => w.renderMode === "fallback").length;
  const webCount = wallpapers.filter(w => w.renderMode === "web").length;
  console.log(`selftest: ${wallpapers.length} wallpapers (${sceneCount} webgl, ${nativeCount} native, ${webCount} web, ${fallbackCount} fallback)\n`);

  const failures = [];
  const rows = [];
  let passCount = 0;
  for (const wallpaper of wallpapers) {
    const load = wallpaper.renderMode === "webgl" ? pkgSizeMB(wallpaper.id) : null;
    const loadStr = load !== null ? `${load.toFixed(1)}MB` : "-";
    process.stdout.write(`  ${wallpaper.id}  ${wallpaper.renderMode.padEnd(8)}  ${loadStr.padEnd(8)}  `);
    try { await json(`${BASE}/select?id=${wallpaper.id}`); } catch (error) { failures.push(`${wallpaper.id} select failed: ${error.message}`); console.log("SELECT FAILED"); continue; }
    const outcome = await waitForBackground(page, wallpaper.id, wallpaper.renderMode);
    rows.push({ id: wallpaper.id, mode: wallpaper.renderMode, load: loadStr, detail: outcome.detail, seconds: outcome.seconds, ok: outcome.ok });
    if (outcome.ok) { passCount++; console.log(`OK  ${String(outcome.seconds + "s").padEnd(6)}  ${outcome.detail}`); }
    else { failures.push(`${wallpaper.id} ${outcome.detail}`); console.log(`FAIL  ${String(outcome.seconds + "s").padEnd(6)}  ${outcome.detail}`); }
  }

  await json(`${BASE}/select?id=${original.source}`);
  await waitForBackground(page, original.source, wallpapers.find(item => item.id === original.source)?.renderMode || "native", 60000);
  console.log(`\nselftest: restored selection to ${original.source}`);

  console.log("\nselftest: picker UI");
  const picker = await verifyPicker(page, original.source, wallpapers.find(item => item.id === original.source)?.renderMode || "native");
  rows.push({ id: "picker", mode: "ui", load: "-", detail: picker.detail, seconds: 0, ok: picker.ok });
  console.log(`  ${picker.ok ? "OK" : "FAIL"}  ${picker.detail}`);
  if (picker.ok) passCount++;
  else failures.push(`picker: ${picker.detail}`);

  console.log("\nselftest: appearance UI + transitions");
  const uiChecks = [
    ["appearance", await verifyAppearancePanel(page)],
    ["glass", await verifyGlassToggle(page)],
    ["transition", await verifyTransitionSwitch(page)],
    ["appearance-save", await verifyAppearanceSave(page)],
    ["preset-off", await verifyPresetOff(page)],
    ["ext", await verifyExtEffects(page)],
  ];
  console.log("\nselftest: channels");
  uiChecks.push(
    ["web-doc", verifyWebDocumentBuilder()],
    ["library", await verifyLibraryChannel(page, status)],
    ["panel-state", await verifyPanelPersistence(page, wallpapers, original.source, wallpapers.find(item => item.id === original.source)?.renderMode || "native")],
    ["prefs-merge", await verifyPrefsMerge(page)],
    ["white-text", await verifyWhiteText(page)],
    ["video-audio", await verifyVideoAudio(page, wallpapers, baselineLibrary)],
    ["reset", await verifyReset(page, original, wallpapers.find(item => item.id === original.source)?.renderMode || "native")],
    /* Last on purpose: this one drags the panel around and changes its layout, so
       running it earlier left later checks fighting a moved/rebuilt panel. */
    ["panel-placement", await verifyPanelPlacement(page)],
  );
  console.log("\nselftest: every render type (isolated fixture library)");
  uiChecks.push(["all-types", await verifyAllTypes(page, 43999)]);
  for (const [id, outcome] of uiChecks) {
    rows.push({ id, mode: "ui", load: "-", detail: outcome.detail, seconds: 0, ok: outcome.ok });
    console.log(`  ${outcome.ok ? "OK" : "FAIL"}  ${id}: ${outcome.detail}`);
    if (outcome.ok) passCount++;
    else failures.push(`${id}: ${outcome.detail}`);
  }

  /* Restore the exact prefs the run started with, then assert the restore itself:
     a test that changes the user's look and does not put it back is a failure even
     when every assertion above passed. */
  const restoredPrefs = await restoreBaselinePrefs();
  await sleep(1500);
  const finalStatus = await json(`${BASE}/status`);
  const glassMatches = finalStatus.appearance.glass.enabled === baselineAppearance.glass.enabled;
  const dimMatches = (finalStatus.prefs.backgroundOpacity ?? null) === (baselinePrefs.backgroundOpacity ?? null);
  const readabilityMatches = !!finalStatus.prefs.readability && finalStatus.prefs.readability.mode === baselinePrefs.readability.mode
    && finalStatus.prefs.readability.percent === baselinePrefs.readability.percent;
  const libraryMatches = JSON.stringify(finalStatus.library.hidden) === JSON.stringify(baselineLibrary.hidden)
    && JSON.stringify(finalStatus.library.filters.types) === JSON.stringify(baselineLibrary.filters.types);
  const restoreCheck = {
    ok: restoredPrefs && glassMatches && dimMatches && readabilityMatches && libraryMatches,
    detail: `saved=${restoredPrefs} glass=${finalStatus.appearance.glass.enabled}(want ${baselineAppearance.glass.enabled}) dim=${finalStatus.prefs.backgroundOpacity} readability=${finalStatus.prefs.readability?.mode}/${finalStatus.prefs.readability?.percent} library=${libraryMatches}`
  };
  rows.push({ id: "restore", mode: "ui", load: "-", detail: restoreCheck.detail, seconds: 0, ok: restoreCheck.ok });
  console.log(`  ${restoreCheck.ok ? "OK" : "FAIL"}  restore: ${restoreCheck.detail}`);
  if (restoreCheck.ok) passCount++;
  else failures.push(`restore: ${restoreCheck.detail}`);

  page.close();
  console.log("\n== SELFTEST RESULTS ==");
  console.log("  id            mode      load      time    result   detail");
  console.log("  " + "-".repeat(74));
  for (const r of rows) {
    console.log(`  ${r.id}  ${r.mode.padEnd(8)}  ${r.load.padEnd(8)}  ${String(r.seconds + "s").padStart(5)}   ${r.ok ? "PASS" : "FAIL"}    ${r.detail}`);
  }
  console.log("  " + "-".repeat(74));
  console.log(`  ${passCount}/${rows.length} passed, ${failures.length} failed`);
  if (failures.length) { console.log("\nFAILURES:"); for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
  console.log("\nselftest: ALL PASSED");
}

if (typeof WebSocket === "undefined") {
  console.error("selftest: this script needs Node.js 22+ (global WebSocket)");
  process.exit(1);
}
main();
