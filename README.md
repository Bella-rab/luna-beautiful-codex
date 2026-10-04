# Luna Beautiful Codex

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

- **0.2.1** — Scene wallpapers render for real again: WebWallGL is vendored and the scene package is injected as bytes (`bytesSource`), bypassing the page CSP that made every page-side fetch fail (the cause of the pure-black background). Fallback media is also injected instead of fetched. Added `server/selftest.mjs`.
- **0.2.0** — Initial public release.

## Notes

- The plugin starts its local watcher with the Codex MCP server.
- Scene wallpapers are rendered in real-time via WebGL; if WebGL2 is unavailable or the webwallgl library fails to load, the plugin falls back to an extracted embedded video or a static preview image.
- Direct video/image wallpapers are used at their original quality.