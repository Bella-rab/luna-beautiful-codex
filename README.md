# Luna Beautiful Codex

English | [简体中文](README.zh-CN.md)

> 连接本地 Wallpaper Engine，在 Codex 桌面端对话页内嵌壁纸选择器，一键切换页面背景。

A personal Codex desktop plugin that scans **your own** local Steam Wallpaper Engine
workshop library, injects a bottom-right **壁纸** picker into the Codex conversation
page, and restores the selected background automatically every time Codex opens.
It uses original high-resolution media and can extract embedded videos from
supported Scene packages. It never changes your Windows desktop wallpaper or
Codex window transparency.

---

## ✨ Features

- **Local Wallpaper Engine browser** — scans each user's own Steam workshop folder
  for `431960` (Wallpaper Engine) content.
- **In-page picker** — adds a bottom-right launcher inside Codex (`app://-/index.html`)
  to switch wallpapers without leaving the chat.
- **Original quality** — uses direct video/image wallpapers at full resolution and
  extracts the embedded high-res video from supported Scene `.pkg` packages. Scenes
  without an extractable video are hidden instead of falling back to blurry previews.
- **White text + readability controls** — forces Codex conversation text to white
  with a readable shadow, plus an in-app panel to tune background opacity, a
  readability "surface" overlay, blur, and pure / soft / bubble modes.
- **Automatic restore** — a lightweight local watcher reinstalls your last
  wallpaper and picker each time Codex is open.
- **Private by design** — all scanning, extraction, and rendering happen locally.
  Nothing is uploaded. Each user's selection is saved under their own
  `%APPDATA%\Codex\luna-beautiful-codex`.

## 🧩 MCP tools

| Tool | Description |
| --- | --- |
| `list_backgrounds` | List available Wallpaper Engine media (optional `search`). |
| `set_background` | Install a background by workshop ID, title, local path, or URL. |
| `set_background_opacity` | Adjust opacity / surface opacity / blur. |
| `reset_background` | Remove the custom background and restore original styling. |
| `enable_white_text` / `disable_white_text` | Toggle forced white text. |
| `background_status` | Check whether a background is installed and playing. |
| `enable_wallpaper_picker` | Start the local watcher and show the picker. |

## 📦 Requirements

- **Windows** (the Steam/Wallpaper Engine scan and registry probe are Windows-only).
- **Codex Desktop** running with its remote debugging port (the watcher connects to
  `http://127.0.0.1:9229` by default; it also probes `9230`–`9239`).
- **Node.js** — either the Codex-bundled runtime
  (`~/.cache/codex-runtimes/*/dependencies/node`) or a system `node` on your
  `PATH`. The launcher (`server/boot.ps1`) finds it automatically.
- **Steam + Wallpaper Engine** installed for the current user, with at least one
  downloaded workshop wallpaper.

## 🚀 Install (for yourself)

1. Copy this folder into your Codex personal plugins cache:

   ```
   C:\Users\<you>\.codex\plugins\cache\personal\luna-beautiful-codex\0.2.0
   ```

2. Restart Codex Desktop and enable the **Luna Beautiful Codex** plugin.

3. In the chat, say:

   > 打开我的 Wallpaper Engine 壁纸选择器

   The bottom-right **壁纸** picker appears and your library is scanned.

> The `.mcp.json` launches the server via `server/boot.ps1`, which discovers
> Node portably — no hardcoded user paths.

## 🔌 Install from a repo / as a developer

```powershell
git clone https://github.com/<you>/luna-beautiful-codex.git
cd luna-beautiful-codex
# point your Codex plugin cache at the clone with a junction:
New-Item -ItemType Junction `
  -Path "$HOME\.codex\plugins\cache\personal\luna-beautiful-codex\0.2.0" `
  -Target "$(Get-Location)"
```

Then restart Codex and enable the plugin.

## 🗂️ Project layout

```
luna-beautiful-codex/
├── .codex-plugin/plugin.json   # Codex plugin manifest
├── .mcp.json                   # MCP server entrypoint (portable launcher)
├── skills/background/SKILL.md  # Skill instructions for the model
└── server/
    ├── boot.ps1 / boot.cmd     # Portable Node discovery + launchers
    ├── index.mjs               # MCP stdio server (tool dispatcher)
    ├── codex-wallpaper-watchdog.mjs   # Local watcher + HTTP control + auto-restore
    ├── inject-background-controls.mjs # Readability/opacity control panel
    ├── inject-wallpaper-picker.mjs    # Bottom-right wallpaper picker UI
    └── wallpaper-library.mjs   # Steam discovery + PKG/Scene parsing
```

## ⚙️ How it works

1. `index.mjs` is the MCP stdio server Codex starts. It exposes the tools above
   and spawns the watchdog.
2. `codex-wallpaper-watchdog.mjs` runs a tiny local HTTP server on port `43310`
   (selection, prefs, white-text toggle), connects to Codex's DevTools endpoint to
   read page state, and reinstalls the background, controls, and picker when missing.
3. `wallpaper-library.mjs` discovers Steam libraries (registry + libraryfolders.vdf
   + a drive-letter fallback), reads each wallpaper's `project.json`, and extracts
   the largest embedded video from Scene `.pkg` packages into a per-user cache.

## 🔒 Privacy

All scanning, extraction, and rendering happen locally. The plugin does not upload
wallpapers or Steam data. Per-user state lives under
`%APPDATA%\Codex\luna-beautiful-codex`.

## 📝 Notes

- The watcher starts alongside the Codex MCP server.
- Unsupported Scenes are hidden from the picker instead of being downgraded to previews.
- Direct video/image wallpapers are used at their original quality.

## 📄 License

MIT — see [LICENSE](LICENSE).