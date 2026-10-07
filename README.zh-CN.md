[English](README.md) | 简体中文

# Luna Beautiful Codex

> 连接本地 Wallpaper Engine，在 Codex 桌面端对话页内嵌壁纸选择器，一键切换页面背景。

一个个人用的 Codex 桌面端插件：扫描**你自己的**本地 Steam Wallpaper Engine
创意工坊库，在 Codex 对话页右下角注入一个**壁纸**选择器，并在每次打开 Codex
时自动恢复上次选择的背景。插件使用原始高分辨率媒体，并能从受支持的 Scene 包
中提取内嵌视频。它不会修改你的 Windows 桌面壁纸，也不会改变 Codex 窗口透明度。

---

## ✨ 功能特性

- **本地 Wallpaper Engine 浏览器** — 扫描每个用户自己的 Steam 创意工坊目录中
  `431960`（Wallpaper Engine）的内容。
- **页内选择器** — 在 Codex（`app://-/index.html`）内部添加右下角启动器，
  无需离开对话即可切换壁纸。
- **原始画质** — 视频/图片壁纸按原始分辨率直接使用，并从受支持的 Scene
  `.pkg` 包中提取内嵌高清视频。无法提取视频的 Scene 会被隐藏，而不会降级为
  模糊预览。
- **白色文字 + 可读性控制** — 强制 Codex 对话文字显示为白色并带可读阴影，
  另有应用内面板可调节背景不透明度、可读性“蒙层”（surface）、模糊，以及
  纯净 / 柔和 / 气泡三种模式。
- **自动恢复** — 一个轻量的本地守护进程在每次打开 Codex 时自动重装你上次的
  壁纸与选择器。
- **隐私优先** — 所有扫描、提取与渲染都在本地完成，不上传任何数据。每个用户
  的选择保存在自己的 `%APPDATA%\Codex\luna-beautiful-codex` 下。

## 🧩 MCP 工具

| 工具 | 说明 |
| --- | --- |
| `list_backgrounds` | 列出可用的 Wallpaper Engine 媒体（可选 `search` 参数）。 |
| `set_background` | 按创意工坊 ID、标题、本地路径或 URL 安装背景。 |
| `set_background_opacity` | 调节不透明度 / 蒙层不透明度 / 模糊。 |
| `reset_background` | 移除自定义背景并恢复原始样式。 |
| `enable_white_text` / `disable_white_text` | 开关强制白色文字。 |
| `background_status` | 检查背景是否已安装并正在播放。 |
| `enable_wallpaper_picker` | 启动本地守护进程并显示选择器。 |

## 📦 环境要求

- **Windows**（Steam/Wallpaper Engine 扫描与注册表探测仅支持 Windows）。
- **Codex Desktop** 以远程调试端口运行（守护进程默认连接
  `http://127.0.0.1:9229`，同时探测 `9230`–`9239`）。
- **Node.js** — 可以是 Codex 自带的运行时
  （`~/.cache/codex-runtimes/*/dependencies/node`），也可以是 `PATH` 中的系统
  `node`。启动器（`server/boot.ps1`）会自动查找。
- **Steam + Wallpaper Engine** 已为当前用户安装，且至少下载过一个创意工坊
  壁纸。

## 🚀 安装（个人使用）

1. 将本目录复制到你的 Codex 个人插件缓存：

   ```
   C:\Users\<you>\.codex\plugins\cache\personal\luna-beautiful-codex\0.2.0
   ```

2. 重启 Codex Desktop 并启用 **Luna Beautiful Codex** 插件。

3. 在对话中说：

   > 打开我的 Wallpaper Engine 壁纸选择器

   右下角会出现**壁纸**选择器，同时你的壁纸库会被扫描。

> `.mcp.json` 通过 `server/boot.ps1` 启动服务端，后者以可移植方式发现
> Node——没有写死的用户路径。

## 🔌 从仓库安装 / 开发者方式

```powershell
git clone https://github.com/<you>/luna-beautiful-codex.git
cd luna-beautiful-codex
# 用 junction 把你的 Codex 插件缓存指向克隆目录：
New-Item -ItemType Junction `
  -Path "$HOME\.codex\plugins\cache\personal\luna-beautiful-codex\0.2.0" `
  -Target "$(Get-Location)"
```

然后重启 Codex 并启用插件。

## 🗂️ 项目结构

```
luna-beautiful-codex/
├── .codex-plugin/plugin.json   # Codex 插件清单
├── .mcp.json                   # MCP 服务端入口（可移植启动器）
├── skills/background/SKILL.md  # 面向模型的技能说明
└── server/
    ├── boot.ps1 / boot.cmd     # 可移植 Node 探测 + 启动器
    ├── index.mjs               # MCP stdio 服务端（工具分发）
    ├── codex-wallpaper-watchdog.mjs   # 本地守护 + HTTP 控制 + 自动恢复
    ├── inject-background-controls.mjs # 可读性/不透明度控制面板
    ├── inject-wallpaper-picker.mjs    # 右下角壁纸选择器 UI
    └── wallpaper-library.mjs   # Steam 探测 + PKG/Scene 解析
```

## ⚙️ 工作原理

1. `index.mjs` 是 Codex 启动的 MCP stdio 服务端，暴露上述工具并拉起守护进程。
2. `codex-wallpaper-watchdog.mjs` 在本地 `43310` 端口运行一个小型 HTTP 服务
   （负责选择、偏好设置、白字开关），连接 Codex 的 DevTools 端点读取页面状态，
   并在背景、控制面板或选择器缺失时自动重装。
3. `wallpaper-library.mjs` 发现 Steam 库（注册表 + libraryfolders.vdf +
   盘符兜底），读取每个壁纸的 `project.json`，并将 Scene `.pkg` 包中最大的
   内嵌视频提取到按用户隔离的缓存中。

## 🔒 隐私

所有扫描、提取与渲染都在本地完成。插件不会上传壁纸或 Steam 数据。按用户
隔离的状态保存在 `%APPDATA%\Codex\luna-beautiful-codex` 下。

## 📝 备注

- 守护进程随 Codex MCP 服务端一起启动。
- 不受支持的 Scene 会从选择器中隐藏，而不是降级为预览。
- 视频与图片壁纸按原始画质直接使用。

## 📄 许可证

MIT — 见 [LICENSE](LICENSE)。
