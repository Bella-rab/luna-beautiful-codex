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
import path from "node:path";

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
  if (opened.display !== "block") return { ok: false, detail: `panel stayed hidden after clicking 壁纸 (computed display=${opened.display})` };
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

async function main() {
  let health;
  try { health = await json(`${BASE}/health`); } catch (error) { console.error(`selftest: watchdog unreachable on ${BASE} (${error.message})`); process.exit(1); }
  console.log(`selftest: watchdog pid=${health.pid}`);

  const target = await findPage();
  if (!target) { console.error("selftest: Codex desktop page not found on DevTools ports - is Codex Desktop open?"); process.exit(1); }
  const page = await connectPage(target);
  try { await page.command("Page.bringToFront"); } catch {}
  await sleep(1000);

  const status = await json(`${BASE}/status`);
  const original = status.selection;
  console.log(`selftest: current selection ${original.source} (${original.title}) - will restore afterwards\n`);

  const wallpapers = await json(`${BASE}/wallpapers`);
  const sceneCount = wallpapers.filter(w => w.renderMode === "webgl").length;
  const nativeCount = wallpapers.filter(w => w.renderMode === "native").length;
  const fallbackCount = wallpapers.filter(w => w.renderMode === "fallback").length;
  console.log(`selftest: ${wallpapers.length} wallpapers (${sceneCount} webgl, ${nativeCount} native, ${fallbackCount} fallback)\n`);

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