---
name: background
description: Set an image or video background inside the Codex desktop conversation page without changing the Windows desktop wallpaper.
---

# Luna Beautiful Codex

Use this skill when the user wants a custom Codex page background, including Wallpaper Engine media, local images/videos, or image/video URLs.

## Workflow

1. Use `list_backgrounds` when the user asks for available Wallpaper Engine media.
2. Use `enable_wallpaper_picker` when the bottom-right picker is missing.
3. Use `set_background` with a workshop ID, title, local path, or URL.
4. Use `set_background_opacity` when the user wants the background stronger, softer, clearer, or more blurred.
5. Use `reset_background` when the user wants to remove the custom background.
6. Use `background_status` to verify installation and playback.

The preferred experience is the bottom-right **壁纸** picker injected into Codex. Each user's Steam library and selected wallpaper stay local to their own Windows profile. The preferred default is fully clear mode: background opacity `1`, surface opacity `0`, and blur `0`. The media is injected only into `app://-/index.html`; it never changes the Windows desktop wallpaper or Codex window transparency.
All listed workshop items use original high-resolution media or an extractable high-resolution Scene video; unsupported Scenes are omitted rather than replaced with blurry previews. Installed backgrounds also force Codex text to white with a readable shadow.
