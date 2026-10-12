# Luna Beautiful Codex

English | [简体中文](README.zh-CN.md)

## What it does

- Connects to the current user's local Steam Wallpaper Engine workshop library.
- Adds a bottom-right **壁纸** picker to the Codex desktop conversation page.
- Supports direct video/image wallpapers and extracts embedded videos from supported Scene packages.
- Renders Scene wallpapers (`.pkg`) natively via WebGL using [webwallgl](https://github.com/oneincase/webwallgl), the same library powering [WallpaperEM](https://github.com/oneincase/WallpaperEM). Scene wallpapers with real-time particle systems, shader animations, skeletal meshes, and scripted effects are now fully animated.
- Falls back to embedded video extraction or a static preview when WebGL2 is unavailable or webwallgl fails to load.
- Forces Codex conversation text to white with a readable shadow.
- Saves each user's selected wallpaper under their own `%APPDATA%\Codex\luna-beautiful-codex`.
- Restores the selected background automatically while Codex is open.
- Does not change the Windows desktop wallpaper and does not make the Codex window transparent.

## Install

Luna Beautiful Codex is a **Codex desktop plugin** (a skill plus a small local MCP server) — not a standalone app. Codex starts the server, and the server draws the picker inside the Codex conversation page.

Personal install (per user):

1. Clone the plugin into your personal plugin directory:

   ```
   git clone https://github.com/Bella-rab/luna-beautiful-codex.git "$HOME/plugins/luna-beautiful-codex"
   ```

2. Register it in your personal marketplace, `~/.agents/plugins/marketplace.json` (keep any existing entries and append this one):

   ```json
   {
     "name": "personal",
     "interface": { "displayName": "Personal" },
     "plugins": [
       {
         "name": "luna-beautiful-codex",
         "source": { "source": "local", "path": "./plugins/luna-beautiful-codex" },
         "policy": { "installation": "AVAILABLE", "authentication": "ON_INSTALL" },
         "category": "Productivity"
       }
     ]
   }
   ```

3. Restart Codex Desktop, open the plugin list and enable **Luna Beautiful Codex**. Make sure Wallpaper Engine has at least one downloaded workshop wallpaper.

Alternatively you can simply ask Codex to install this repository as a personal plugin.

## Usage

1. Ask Codex to start the picker — these are the plugin's default prompts:

   > 打开我的 Wallpaper Engine 壁纸选择器

2. A **壁纸** button appears in the bottom-right corner of the Codex conversation page. Click it, then click a row in the list to apply that wallpaper to the current session. The search box filters by title or workshop ID.

3. Everything can also be driven from chat:

   | Tool | What it does |
   |------|--------------|
   | `list_backgrounds` | List local Wallpaper Engine media (optional `search`). |
   | `set_background` | Apply a wallpaper by workshop ID, title, local path or URL (plus `opacity`, `surfaceOpacity`, `blur`). |
   | `set_background_opacity` | Tune opacity / panel opacity / blur of the installed background. |
   | `reset_background` | Remove the custom background and restore Codex's original styling. |
   | `enable_white_text` / `disable_white_text` | Toggle the forced white conversation text. |
   | `background_status` | Check what is installed and whether it is playing. |
   | `enable_wallpaper_picker` | Start the local watcher and show the bottom-right picker. |

4. The local watcher restores your last selection the next time Codex starts; the choice is stored in `%APPDATA%\Codex\luna-beautiful-codex\wallpaper-selection.json`.

## Wallpaper types

| Type | Render mode | Description |
|------|-------------|-------------|
| Video (mp4/webm/mov) | `native` | Direct video playback at original quality |
| GIF / Image | `native` | Direct image display at original quality |
| Scene (`.pkg`) | `webgl` | Real-time WebGL rendering via webwallgl; falls back to extracted video or static preview |
| URL | `native` | Remote media fetched and displayed inline |

## Requirements

- Windows
- Codex Desktop
- Steam and Wallpaper Engine installed for the current user
- At least one downloaded Wallpaper Engine workshop wallpaper

## Privacy

All scanning, extraction, and rendering happen locally. The plugin does not upload wallpapers or Steam data. The WebWallGL library is vendored at `server/vendor/` (no CDN access needed); Scene packages are read from the local Steam workshop directory and injected straight into the page — the loopback HTTP server (`127.0.0.1:43310`) only serves the wallpaper picker UI and health/status endpoints.

## How WebGL rendering works

The Codex desktop page ships a strict Content-Security-Policy (`default-src 'none'`), which blocks every page-side `fetch()` — including requests to `https://` CDNs and to `http://127.0.0.1:43310`. `connect-src` falls back to `default-src`, so even DevTools-injected code cannot fetch the scene over HTTP. Loading WebWallGL from a CDN (the pre-0.2.1 design) therefore always failed and Scene wallpapers showed a pure-black background.

The watchdog works around this without touching the CSP, entirely over the DevTools protocol:

1. The watchdog reads `webwallgl.global.min.js`, `scene.pkg`, and `project.json` from disk on the Node side.
2. It injects them into the page as base64 chunks via `Runtime.evaluate` (inspector evaluation is not subject to the page CSP).
3. In-page, it rebuilds the bytes and constructs the source with `WebWallGL.bytesSource(pkgBytes, project, key)` — the library parses the package locally, so rendering needs **zero page-side network requests**.
4. If the library or WebGL2 is unavailable, the same injection path installs the scene's embedded video or static preview as a fallback (never a black screen).
5. While the Codex window is hidden or fully occluded, Chromium freezes `requestAnimationFrame`, so a WebGL scene cannot produce the first frame `mount()` waits for. In that case the watchdog installs the fallback media immediately and defers the WebGL mount via an in-page `visibilitychange` listener — the live scene appears the moment the window becomes visible. Every DevTools command also carries a 240s timeout so a stalled page can never wedge the watchdog's restore loop.

## The vendor directory

`server/vendor/webwallgl.global.min.js` is [webwallgl@2.1.0](https://www.npmjs.com/package/webwallgl) (MIT, © oneincase), vendored so the plugin works offline. To upgrade it:

```
npm pack webwallgl@<version>
tar -xzf webwallgl-<version>.tgz package/webwallgl.global.min.js
copy package\webwallgl.global.min.js server\vendor\
```

`webwallgl.d.ts` and `webwallgl.LICENSE` are kept next to it for reference. If the file is missing, the watchdog logs `WebWallGL library not vendored` and falls back to embedded video/preview media.

## Troubleshooting

- Log file: `server/codex-wallpaper-watchdog.log`. Key lines:
  - `scene webgl <id>: renderMode=webgl (vendored WebWallGL, bytesSource pkgBytes=... mountMs=...)` — live WebGL rendering active.
  - `renderMode=fallback webglError=...` — WebGL unavailable; the injected video/preview is shown instead.
  - `renderMode=failed` — neither WebGL nor fallback media could be installed (e.g. the wallpaper has no `scene.pkg` and no preview).
  - `another watchdog already owns :43310` — a second watchdog instance exited because one is already running (normal).
- Wallpapers come from `<Steam library>\steamapps\workshop\content\431960\`. A missing `scene.pkg` or `project.json` downgrades the wallpaper to preview mode.
- The watchdog finds the Codex page by probing DevTools ports 9229–9239 for `app://-/index.html`; keep Codex Desktop's remote debugging enabled.

## Self-test

With Codex Desktop open and the watchdog running:

```
node server/selftest.mjs
```

It switches to every wallpaper in the library, asserts each `webgl`-flagged one really rendered via WebGL (from the watchdog log), restores your previous selection, and exits non-zero on any failure.

## Changelog

- **0.2.3** — Smoother, sharper switches. Three root causes fixed: (1) some wallpapers write `"type": "Scene"` with a capital S in `project.json`, and the old exact-match logic only accepted lowercase `scene`, so those 3D wallpapers fell back to the stretched low-res `preview.gif` — that is the blurry first frame. A folder containing `scene.pkg` is now always treated as a Scene and rendered live through WebGL. (2) Every scan read each `scene.pkg` (up to 126 MB) fully into memory just to hunt for an embedded video, costing ~0.5-0.7 s, and a single switch scanned several times. Scans are now cached for 30 s and the per-package video probe is memoized on (path, mtime, size), so repeat scans cost 0 ms. (3) Switching tore the old background down before mounting the new one, so the page went black and the first thing the user saw was the blurry preview. The old layers now stay up until the replacement is ready and then cross-fade out - the measured black gap is 0 ms. Also: the render DPR is raised to `max(devicePixelRatio, 1.5)` with 4x MSAA (textures were previously sampled at 0.5-0.6x, a second source of blur) at no frame-rate cost (59-60 fps); the 100 MB+ embedded fallback video is no longer pre-injected when WebGL will be used; and an already-running watchdog is no longer respawned every few seconds. A typical Scene switch dropped from ~7.6 s to ~2 s.
- **0.2.2** — Fixes the picker going dead. `GET /status` threw `state is not defined`, and the error handler then re-sent headers (`ERR_HTTP_HEADERS_SENT`), which killed the watchdog process itself — so anything that read `/status`, including the bundled `server/selftest.mjs`, silently stopped clicks from applying wallpapers. The endpoint now reports the real state and the handler can no longer take the process down. The picker panel is opened and closed by writing an explicit `display` rule instead of only toggling a class, so a leftover inline `display` can no longer keep the list hidden, and the list no longer rebuilds every 1.2 s (which used to swallow in-flight clicks and reset the scroll position mid-pick). The picker probes DevTools ports 9229–9239 like the watchdog instead of assuming 9229, and the MCP server now attaches to an already running watchdog instead of respawning one every 5 s.
- **0.2.1** — Scene wallpapers render for real again: WebWallGL is vendored and the scene package is injected as bytes (`bytesSource`), bypassing the page CSP that made every page-side fetch fail (the cause of the pure-black background). Fallback media is also injected instead of fetched. The WebGL instance is torn down when switching to a native wallpaper (no more leaked GL contexts), background elements carry complete `data-wallpaper-source`/`data-render-mode` attributes, and a hidden/occluded window defers the WebGL mount instead of timing out to a static fallback. Added `server/selftest.mjs` (DevTools-based page assertions).
- **0.2.0** — Initial public release.

## Notes

- The plugin starts its local watcher with the Codex MCP server.
- Scene wallpapers are rendered in real-time via WebGL; if WebGL2 is unavailable or the webwallgl library fails to load, the plugin falls back to an extracted embedded video or a static preview image.
- Direct video/image wallpapers are used at their original quality.