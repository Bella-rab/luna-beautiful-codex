/* Injects the appearance runtime (liquid glass / presets / typography / wallpaper filters)
   into the Codex page and mounts the "外观" panel. Said differently: this is the only
   entry point for Phase 1 - the watchdog spawns it whenever the panel is missing, and it
   can be run by hand to force a re-inject after the page half changed.

   The saved configuration is read from prefs.json on the Node side and embedded into the
   expression, so the page itself never fetches anything (the CSP baseline stays as-is). */
import { readAppearancePrefs, PANEL_RUNTIME_SOURCE } from "./appearance.mjs";

/* The Codex page is not always exposed on the same DevTools port, so probe the same
   range the watchdog uses instead of assuming 9229. */
const devtoolsPorts = (process.env.LUNA_DEVTOOLS_PORTS || "9229,9230,9231,9232,9233,9234,9235,9236,9237,9238,9239")
  .split(",").map(value => parseInt(value, 10)).filter(value => value > 0);

async function findPage() {
  for (const port of devtoolsPorts) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, { cache: "no-store" });
      if (!response.ok) continue;
      const targets = await response.json();
      const target = targets.find(item => item.type === "page" && item.url === "app://-/index.html");
      if (target) return target;
    } catch {}
  }
  return null;
}

const target = await findPage();
if (!target) throw new Error("Codex main page target not found");

const socket = new WebSocket(target.webSocketDebuggerUrl);
let nextId = 1;
const pending = new Map();
socket.onmessage = event => {
  const payload = JSON.parse(event.data);
  if (!payload.id || !pending.has(payload.id)) return;
  const waiter = pending.get(payload.id);
  pending.delete(payload.id);
  payload.error ? waiter.reject(new Error(payload.error.message)) : waiter.resolve(payload.result);
};
function send(method, params = {}) {
  const id = nextId++;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error(`CDP command timed out: ${method}`)); }
    }, 20000);
  });
}
await new Promise((resolve, reject) => {
  socket.onopen = resolve;
  socket.onerror = () => reject(new Error("Unable to connect to Codex DevTools"));
});

const appearance = readAppearancePrefs();

const expression = `(() => {
  /* Re-injecting must not leave stale listeners behind: the panel is rebuilt from
     scratch, while the stylesheets and the marking pass are idempotent. */
  try { document.getElementById("codex-appearance-panel")?.remove(); } catch {}
  let host = document.getElementById("codex-appearance-panel");
  if (!host) {
    host = document.createElement("div");
    host.id = "codex-appearance-panel";
    document.body.append(host);
  }
  /* Also latch the API onto window: it makes the panel scriptable (and lets the
     verification scripts drive apply()/status() without re-injecting). */
  const api = window.__lunaAppearance = (0, eval)(${JSON.stringify(PANEL_RUNTIME_SOURCE)});
  const applied = api.apply(${JSON.stringify(appearance)});
  api.watch();
  const mounted = api.mountPanel();
  return JSON.stringify({ applied, mounted, status: api.status(), events: api.events() });
})()`;

const outcome = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
if (outcome.exceptionDetails) throw new Error(outcome.exceptionDetails.exception?.description || outcome.exceptionDetails.text);
console.log(outcome.result.value);
socket.close();