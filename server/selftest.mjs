#!/usr/bin/env node
/* One-shot regression self-test for the Luna Beautiful Codex wallpaper watchdog.

   What it does:
     1. Checks the watchdog is healthy on 127.0.0.1:43310.
     2. Lists every wallpaper in the local Wallpaper Engine workshop library.
     3. Switches to each wallpaper and waits for the watchdog to report
        "background installed: <id>" in its log.
     4. For wallpapers flagged renderMode=webgl, asserts the scene really
        rendered via WebGL (renderMode=webgl in the log), warning instead of
        failing when the vendored WebWallGL library is missing.
     5. Restores the wallpaper that was selected before the test.

   Usage:  node server/selftest.mjs
   Exit code 0 = all assertions passed, 1 = at least one failure. */

import fs from "node:fs";
import path from "node:path";

const PORT = process.env.WATCHDOG_PORT || "43310";
const BASE = `http://127.0.0.1:${PORT}`;
const LOG = path.join(import.meta.dirname, "codex-wallpaper-watchdog.log");

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function json(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`);
  return response.json();
}

async function waitForInstall(id, fromSize, timeoutMs = 150000) {
  const deadline = Date.now() + timeoutMs;
  let text = "";
  while (Date.now() < deadline) {
    await sleep(2000);
    text = fs.readFileSync(LOG, "utf8").slice(fromSize);
    if (text.includes(`background installed: ${id}`)) {
      const match = text.match(new RegExp(`scene webgl ${id}: renderMode=(\\w+)[^\\r\\n]*`));
      return { installed: true, sceneLine: match ? match[0] : null };
    }
    if (text.includes("restore error")) return { installed: false, sceneLine: null };
  }
  return { installed: false, sceneLine: null };
}

async function main() {
  if (!fs.existsSync(LOG)) { console.error(`selftest: watchdog log not found at ${LOG} - is the watchdog running?`); process.exit(1); }
  let health;
  try { health = await json(`${BASE}/health`); } catch (error) { console.error(`selftest: watchdog unreachable on ${BASE} (${error.message})`); process.exit(1); }
  console.log(`selftest: watchdog pid=${health.pid}`);

  const status = await json(`${BASE}/status`);
  const original = status.selection;
  console.log(`selftest: current selection ${original.source} (${original.title}) - will restore afterwards`);

  const wallpapers = await json(`${BASE}/wallpapers`);
  console.log(`selftest: ${wallpapers.length} wallpapers in library\n`);

  const failures = [];
  const warnings = [];
  const rows = [];
  for (const wallpaper of wallpapers) {
    const mark = fs.statSync(LOG).size;
    process.stdout.write(`  ${wallpaper.id}  ${wallpaper.renderMode.padEnd(8)}  `);
    try { await json(`${BASE}/select?id=${wallpaper.id}`); } catch (error) { failures.push(`${wallpaper.id} select failed: ${error.message}`); console.log("SELECT FAILED"); continue; }
    const { installed, sceneLine } = await waitForInstall(wallpaper.id, mark);
    if (!installed) { failures.push(`${wallpaper.id} install timed out or errored`); console.log("INSTALL FAILED"); continue; }
    if (wallpaper.renderMode === "webgl") {
      const webglOk = sceneLine && sceneLine.includes("renderMode=webgl");
      const fallback = sceneLine && sceneLine.includes("renderMode=fallback");
      if (webglOk) { rows.push([wallpaper.id, "webgl", sceneLine]); console.log("webgl OK"); }
      else if (fallback) { warnings.push(sceneLine); rows.push([wallpaper.id, "fallback", sceneLine]); console.log("fallback (webgl unavailable)"); }
      else { failures.push(`${wallpaper.id} scene render unknown: ${sceneLine}`); console.log("UNKNOWN"); }
    } else {
      rows.push([wallpaper.id, wallpaper.renderMode, "background installed"]);
      console.log("installed");
    }
  }

  await json(`${BASE}/select?id=${original.source}`);
  console.log(`\nselftest: restored selection to ${original.source}`);

  console.log("\n== SELFTEST RESULTS ==");
  for (const [id, mode, detail] of rows) console.log(`  ${id}  ${mode.padEnd(8)}  ${detail ? detail.slice(detail.indexOf("renderMode=") >= 0 ? detail.indexOf("renderMode=") : 0) : ""}`);
  for (const warning of warnings) console.log(`  WARN ${warning}`);
  if (failures.length) { for (const failure of failures) console.log(`  FAIL ${failure}`); console.log(`\nselftest: ${failures.length} failure(s), ${warnings.length} warning(s)`); process.exit(1); }
  console.log(`\nselftest: ALL PASSED (${warnings.length} warning(s))`);
}

main();
