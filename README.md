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
- Adds a full appearance studio (liquid glass, presets, fonts, filters), library filters and rotation, click/trail/parallax effects, a mascot, Web wallpapers, wallpaper properties and an optional video audio track.

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

## Appearance and effects

The **外观** chip opens the appearance studio. Every change applies immediately and is stored in `prefs.json`:

- **Liquid glass** — blur, tint, border, scrim and saturation for the sidebar, conversation, settings window, reasoning blocks and floaters. Each face can inherit, override or switch off; the sidebar supports independent corner radii and up to 8 extra selectors.
- **Presets** — 黑客绿 / 磨砂 / 夜航 / 可读 / 鲜艳, plus JSON export and import.
- **Fonts and colours** — global family (with a system-font picker), secondary/caption/body roles, per-component overrides, caret and accent colours.
- **Background filters** — blur, brightness, contrast, saturation, opacity and darkening, with cover/contain/fill framing, position and zoom.
- **Extensions** — click ripple/spark/ring, pointer trails, parallax, a session avatar and a draggable mascot. All effect layers are `pointer-events:none` and idle at zero rAF cost.

## Wallpaper library

Filter by type (scene / video / image / web), content tag and hidden state. Rows can be hidden without deleting files, local JPG/PNG/MP4/WebM files can be added, and auto-rotation chooses only from the current filter result. Seven switch transitions (cut, fade, zoom, push, wipe, iris, bars) stage the new layer first, so there is never a black frame.

## Web wallpapers, properties and audio

Wallpaper Engine `type: "web"` projects render inside a sandboxed iframe (`allow-scripts`, opaque origin, `pointer-events:none`). Stylesheets, images and fonts are inlined as data URLs; project scripts run through a DevTools bootstrap because the page CSP blocks inline scripts. A frame that does not become ready within 8 s falls back to the project's video or preview image. `general.properties` (scheme colour, sliders, combos, booleans) appear in the picker and reach Scene instances through `setProperties()` and web frames through `wallpaperPropertyListener.applyUserProperties`.

Video wallpapers have an opt-in audio track with a volume control. Chromium blocks audible autoplay without a gesture, so the plugin starts muted and asks for one click instead of failing.

## Wallpaper types

| Type | Render mode | Description |
|------|-------------|-------------|
| Video (mp4/webm/mov) | `native` | Direct video playback at original quality |
| GIF / Image | `native` | Direct image display at original quality |
| Scene (`.pkg`) | `webgl` | Real-time WebGL rendering via webwallgl; falls back to extracted video or static preview |
| Web (`type: "web"`) | `web` | Sandboxed iframe with inlined assets; falls back to the project video/preview |
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

The run covers 35 assertions: per-wallpaper install and render mode, a real picker click, the appearance panel toggles, the liquid-glass sheet appearing and disappearing, transition switching, appearance persistence, preset apply/off/delete, panel drag/dock/two-column layout, extension effects (click FX and mascot), the web-wallpaper srcdoc builder, the library channel (hidden ids / type filters / rotation), dim and readability settings surviving a wallpaper switch, partial prefs writes not wiping the appearance block, forced white text, video volume, `reset` staying reset instead of being restored by the next watchdog tick, and a final restore check that writes the whole prefs snapshot back and verifies it — a run that changes your appearance and does not put it back fails on its own.

The last check, `all-types`, builds a temporary wallpaper library and renders a web wallpaper, a native image and a fallback end to end (on its own port and state directory, so your library is never touched), so "supported types" means verified rather than documented.

## Changelog

- **0.4.0** — Real coverage for every render type (asked: "did all wallpaper types actually run?"). Until now the self-test only exercised the kinds present in the user's own library — 9 WebGL scenes and 9 native videos, with zero web wallpapers, zero static images, zero fallbacks and zero uploads. Those branches had never been executed. (1) A new `all-types` assertion builds a throwaway Steam-shaped library (web project, native PNG, a package-less fallback, an empty folder), starts a SECOND watchdog on its own port with its own state directory, switches through each item and asserts what the live page actually built: web renders in a sandboxed iframe with its scripts really executed and the property bridge really receiving `postMessage`; native produces an `<img>` at the right size; fallback draws the preview. The empty folder must be skipped. (2) The fixture library and its watchdog are destroyed afterwards — the user's library and running watchdog are untouched. (3) Added `STEAM_LIBRARY_ONLY=1`: `STEAM_LIBRARY` used to *append*, so a fixture run also scanned the real collection (this round it listed all 21 items). (4) `WATCHDOG_PORT` and `LUNA_STATE_DIR` are now configurable so a test instance can run isolated. Self-test: 34 -> 35 assertions, ~193s.
- **0.3.3** — Presets can be turned off (reported as "there is no way to close a preset"). (1) Applying a preset now stores the previous look in `presetUndo`, and a dedicated "关闭预设并还原" button restores it; clicking the already-active preset does the same. Before this the only exit was re-editing every field by hand. (2) Imported presets get a `×` delete button, which also restores the pre-apply look when the deleted preset was the active one. (3) The preset hint now spells out all three exits. (4) Fixed a `ReferenceError` where the page runtime called the module-level `appearanceSnapshot()` — the same class of bug as 0.3.2's `PANEL_DOCKS`: a `toString()`-serialized function cannot see module scope. (5) Stopped the watchdog from re-mounting the appearance panel several times per second, which reset any group the user had expanded; injection is now gated on a missing panel or a build mismatch. (6) The self-test gained a preset assertion (apply -> turn off -> verify restore, plus import -> delete) and the panel-placement check now runs last so moving the panel cannot disturb later assertions. Self-test: 33 -> 34 assertions.
- **0.3.2** — Look and layout fixes (reported as "the wallpaper looks ugly" and "can the appearance panel live somewhere else / lay out differently"). (1) The wallpaper was pinned at 5% opacity: `backgroundOpacity: null` means "no override", but `Number(null)` is 0, which then clamped up to the 5% floor — so the picture was nearly invisible while every control still read 100%. Null now means exactly that, 100% removes the sheet outright, and any stale sheet is swept after each install. (2) Bubble mode washed the picture out: Codex's light theme paints `_MainContentSurface_` with a 30% white film that sits on top of the wallpaper, greying the image and stealing contrast from the forced white text. Bubble mode clears that film now. (3) The bubble text panels sample the wallpaper's *dark* shade and add a real backdrop blur instead of mixing 66% toward white — that mix produced white-on-white on bright pictures. The sidebar and top bar get the same dark frosted treatment in bubble mode. (4) The appearance panel can be dragged anywhere from its title bar, cycled through the four corners, and switched between one and two columns. Position and layout persist in `appearance.ui` across reopening and wallpaper switches; `⌂` restores the default and `▥` toggles the 720px two-column layout (each column 344px, all five groups visible without scrolling). (5) The self-test grew a placement assertion (dock, two-column, real pointer drag) and a restore assertion: the whole prefs snapshot is written back at the end and verified, so a run that changes the user's look and does not put it back counts as a failure. (6) Forced white text now reconciles against the page's actual state instead of a cached flag, so a re-injection or external script can no longer desync it permanently. Self-test: 31 -> 33 assertions.
- **0.3.1** — Self-test and tooling fixes. Six real defects: (1) `reset_background` reported success but the watchdog reinstalled the remembered wallpaper within one tick — there is now a `/reset` and `/disable` route, and a reset records `selection.disabled` so restore stays off until a new wallpaper is picked. (2) `set_background` injected native/web wallpapers without telling the watchdog, so the next tick replaced them — library wallpapers now always go through `/select` and only custom files/URLs use the in-page injector. (3) The dim/readability panel is rebuilt after every switch and hard-coded itself back to 100%/45%, wiping a dim or bubble setting; both values are now persisted and replayed. (4) The panel kept a reference to the old media node, so after a switch it dimmed a detached layer; the node is resolved on demand now. (5) `set_background`'s `opacity` argument did nothing once rendering moved into the watchdog — a new `/opacity` channel makes the dim persistent and re-applies it after every install. (6) `POST /prefs` treated any body without an `appearance` key as a bare appearance object, so a dim-only or readability-only write reset the whole appearance block to factory defaults; it now merges, and external writes are mirrored into the live page. The self-test grew from 22 to 31 assertions, and its glass check no longer fails purely because glass was already on.
- **0.3.0** — Appearance studio, library and effects release. Adds liquid glass with six faces and per-face overrides, five factory presets with JSON import/export, fonts/colours, background filters and framing, click/trail/parallax effects, a session avatar and mascot, library filters/tags/hiding/uploads, auto-rotation, seven switch transitions, Web wallpapers in sandboxed iframes, Wallpaper Engine property controls, an optional video audio track, lazy-rendered appearance groups (panel opens in ≤50 ms), `appearance.lastError` in `/status`, and three new selftest UI assertions.
- **0.2.3** — Smoother, sharper switches. Three root causes fixed: (1) some wallpapers write `"type": "Scene"` with a capital S in `project.json`, and the old exact-match logic only accepted lowercase `scene`, so those 3D wallpapers fell back to the stretched low-res `preview.gif` — that is the blurry first frame. A folder containing `scene.pkg` is now always treated as a Scene and rendered live through WebGL. (2) Every scan read each `scene.pkg` (up to 126 MB) fully into memory just to hunt for an embedded video, costing ~0.5-0.7 s, and a single switch scanned several times. Scans are now cached for 30 s and the per-package video probe is memoized on (path, mtime, size), so repeat scans cost 0 ms. (3) Switching tore the old background down before mounting the new one, so the page went black and the first thing the user saw was the blurry preview. The old layers now stay up until the replacement is ready and then cross-fade out - the measured black gap is 0 ms. Also: the render DPR is raised to `max(devicePixelRatio, 1.5)` with 4x MSAA (textures were previously sampled at 0.5-0.6x, a second source of blur) at no frame-rate cost (59-60 fps); the 100 MB+ embedded fallback video is no longer pre-injected when WebGL will be used; and an already-running watchdog is no longer respawned every few seconds. A typical Scene switch dropped from ~7.6 s to ~2 s.
- **0.2.2** — Fixes the picker going dead. `GET /status` threw `state is not defined`, and the error handler then re-sent headers (`ERR_HTTP_HEADERS_SENT`), which killed the watchdog process itself — so anything that read `/status`, including the bundled `server/selftest.mjs`, silently stopped clicks from applying wallpapers. The endpoint now reports the real state and the handler can no longer take the process down. The picker panel is opened and closed by writing an explicit `display` rule instead of only toggling a class, so a leftover inline `display` can no longer keep the list hidden, and the list no longer rebuilds every 1.2 s (which used to swallow in-flight clicks and reset the scroll position mid-pick). The picker probes DevTools ports 9229–9239 like the watchdog instead of assuming 9229, and the MCP server now attaches to an already running watchdog instead of respawning one every 5 s.
- **0.2.1** — Scene wallpapers render for real again: WebWallGL is vendored and the scene package is injected as bytes (`bytesSource`), bypassing the page CSP that made every page-side fetch fail (the cause of the pure-black background). Fallback media is also injected instead of fetched. The WebGL instance is torn down when switching to a native wallpaper (no more leaked GL contexts), background elements carry complete `data-wallpaper-source`/`data-render-mode` attributes, and a hidden/occluded window defers the WebGL mount instead of timing out to a static fallback. Added `server/selftest.mjs` (DevTools-based page assertions).
- **0.2.0** — Initial public release.

## Notes

- The plugin starts its local watcher with the Codex MCP server.
- Scene wallpapers are rendered in real-time via WebGL; if WebGL2 is unavailable or the webwallgl library fails to load, the plugin falls back to an extracted embedded video or a static preview image.
- Direct video/image wallpapers are used at their original quality.
