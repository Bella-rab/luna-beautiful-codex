#!/usr/bin/env node
/* One-shot regression self-test for the Luna Beautiful Codex wallpaper watchdog.

   What it does:
     1. Checks the watchdog is healthy on 127.0.0.1:43310.
     2. Finds the Codex desktop page via its DevTools port and connects.
     3. Switches to every wallpaper and verifies the LIVE page state:
        `#codex-custom-background-base[data-wallpaper-source=<id>]` appears and
        the media element carries the expected `data-render-mode`
        (webgl scenes must show render-mode=webgl plus a live canvas).
     4. Restores the wallpaper that was selected before the test.

   The script runs from anywhere (repo checkout, plugin cache, or installed
   source directory): it never reads on-disk logs, it asserts against the page
   the way the user actually sees it.

   Usage:  node server/selftest.mjs
   Exit code 0 = all assertions passed, 1 = at least one failure. */

const PORT = process.env.WATCHDOG_PORT || "43310";
const BASE = `http://127.0.0.1:${PORT}`;
const DEVTOOLS_PORTS = (process.env.LUNA_DEVTOOLS_PORTS || "9229,9230,9231,9232,9233,9234,9235,9236,9237,9238,9239")
  .split(",").map(value => parseInt(value, 10)).filter(value => value > 0);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function json(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`);
  return response.json();
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
        webglReady: media ? media.getAttribute("data-webgl-ready") : null,
      };
    })()`);
    if (last && last.source === id) {
      if (expectedMode === "webgl") {
        if (last.renderMode === "webgl" && last.canvases > 0) return { ok: true, detail: `renderMode=webgl canvases=${last.canvases}` };
        if (last.renderMode === "fallback") return { ok: false, detail: `fell back (expected webgl): ${JSON.stringify(last)}` };
      } else if (last.renderMode === "failed") {
        return { ok: false, detail: `renderMode=failed` };
      } else if (expectedMode === "webgl") {
        /* keep waiting for the canvas to appear */
      } else {
        /* native and fallback wallpapers end up as a plain media element
           (data-render-mode="native" since the watchdog sets it; older
           watchdogs leave it unset) - presence of the source is the
           success signal */
        return { ok: true, detail: `media=${last.mediaTag} mode=${last.renderMode || "native"}` };
      }
    }
  }
  return { ok: false, detail: `timeout waiting for ${id}: ${JSON.stringify(last)}` };
}

async function main() {
  let health;
  try { health = await json(`${BASE}/health`); } catch (error) { console.error(`selftest: watchdog unreachable on ${BASE} (${error.message})`); process.exit(1); }
  console.log(`selftest: watchdog pid=${health.pid}`);

  const target = await findPage();
  if (!target) { console.error("selftest: Codex desktop page not found on DevTools ports - is Codex Desktop open?"); process.exit(1); }
  const page = await connectPage(target);

  /* A hidden/occluded window freezes rAF, so WebGL scenes cannot produce the
     first frame mount() waits for - bring the page to the front so the test
     asserts real rendering, not the hidden-window fallback. */
  try { await page.command("Page.bringToFront"); } catch {}
  await sleep(1000);

  const status = await json(`${BASE}/status`);
  const original = status.selection;
  console.log(`selftest: current selection ${original.source} (${original.title}) - will restore afterwards`);

  const wallpapers = await json(`${BASE}/wallpapers`);
  console.log(`selftest: ${wallpapers.length} wallpapers in library\n`);

  const failures = [];
  const rows = [];
  for (const wallpaper of wallpapers) {
    process.stdout.write(`  ${wallpaper.id}  ${wallpaper.renderMode.padEnd(8)}  `);
    try { await json(`${BASE}/select?id=${wallpaper.id}`); } catch (error) { failures.push(`${wallpaper.id} select failed: ${error.message}`); console.log("SELECT FAILED"); continue; }
    const outcome = await waitForBackground(page, wallpaper.id, wallpaper.renderMode);
    rows.push([wallpaper.id, wallpaper.renderMode, outcome.detail]);
    if (outcome.ok) console.log(`OK  ${outcome.detail}`);
    else { failures.push(`${wallpaper.id} ${outcome.detail}`); console.log(`FAIL  ${outcome.detail}`); }
  }

  await json(`${BASE}/select?id=${original.source}`);
  await waitForBackground(page, original.source, wallpapers.find(item => item.id === original.source)?.renderMode || "native", 60000);
  console.log(`\nselftest: restored selection to ${original.source}`);

  page.close();
  console.log("\n== SELFTEST RESULTS ==");
  for (const [id, mode, detail] of rows) console.log(`  ${id}  ${mode.padEnd(8)}  ${detail}`);
  if (failures.length) { for (const failure of failures) console.log(`  FAIL ${failure}`); console.log(`\nselftest: ${failures.length} failure(s)`); process.exit(1); }
  console.log("\nselftest: ALL PASSED");
}

/* Node 22+ provides the global WebSocket the DevTools link needs. */
if (typeof WebSocket === "undefined") {
  console.error("selftest: this script needs Node.js 22+ (global WebSocket)");
  process.exit(1);
}
main();
