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

All scanning, extraction, and rendering happen locally. The plugin does not upload wallpapers or Steam data. webwallgl is loaded from a CDN on first use; the Scene package files are served from the local Steam workshop directory via a loopback HTTP server (`127.0.0.1:43310`).

## Notes

- The plugin starts its local watcher with the Codex MCP server.
- Scene wallpapers are rendered in real-time via WebGL; if WebGL2 is unavailable or the webwallgl library fails to load, the plugin falls back to an extracted embedded video or a static preview image.
- Direct video/image wallpapers are used at their original quality.