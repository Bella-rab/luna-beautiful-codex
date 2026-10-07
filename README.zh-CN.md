[English](README.md) | 简体中文

# Luna Beautiful Codex

> 连接本地 Wallpaper Engine，在 Codex 桌面端对话页内嵌壁纸选择器，一键切换页面背景。

一个个人用的 Codex 桌面端插件：扫描**你自己的**本地 Steam Wallpaper Engine
创意工坊库，在 Codex 对话页右下角注入一个**壁纸**选择器，并以 WebGL 实时渲染
Scene 壁纸（粒子、着色器动画、脚本特效），在每次打开 Codex 时自动恢复上次选择
的背景。它不会修改你的 Windows 桌面壁纸，也不会改变 Codex 窗口透明度。

---

## ✨ 功能特性

- **本地 Wallpaper Engine 浏览器** — 扫描每个用户自己的 Steam 创意工坊目录中
  `431960`（Wallpaper Engine）的内容。
- **页内选择器** — 在 Codex（`app://-/index.html`）内部添加右下角启动器，
  无需离开对话即可切换壁纸。
- **原始画质** — 视频/图片壁纸按原始分辨率直接使用；Scene（`.pkg`）壁纸通过
  [webwallgl](https://github.com/oneincase/webwallgl) 以 WebGL 实时渲染——粒子
  系统、着色器动画、骨骼网格与脚本特效全部可用。
- **零网络渲染** — 渲染库与场景包字节全部经 DevTools 注入页面，不受 Codex 页面
  CSP 限制（详见下文「WebGL 渲染原理」）；WebGL 不可用时回退到内嵌视频或静态
  预览，永远不会黑屏。
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
   C:\Users\<you>\.codex\plugins\cache\personal\luna-beautiful-codex\0.2.1
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
  -Path "$HOME\.codex\plugins\cache\personal\luna-beautiful-codex\0.2.1" `
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
    ├── selftest.mjs           # 一键回归自测脚本
    ├── wallpaper-library.mjs   # Steam 探测 + PKG/Scene 解析
    └── vendor/                 # webwallgl@2.1.0（MIT）内置渲染库
```

## ⚙️ 工作原理

1. `index.mjs` 是 Codex 启动的 MCP stdio 服务端，暴露上述工具并拉起守护进程。
2. `codex-wallpaper-watchdog.mjs` 在本地 `43310` 端口运行一个小型 HTTP 服务
   （负责选择、偏好设置、白字开关），连接 Codex 的 DevTools 端点读取页面状态，
   并在背景、控制面板或选择器缺失时自动重装。
3. `wallpaper-library.mjs` 发现 Steam 库（注册表 + libraryfolders.vdf +
   盘符兜底），读取每个壁纸的 `project.json`；Scene `.pkg` 包经
   `bytesSource` 字节注入交给 WebWallGL 在页内实时渲染，内嵌视频提取仅作为
   WebGL 不可用时的回退，提取结果缓存在按用户隔离的缓存中。

## 🔒 隐私

所有扫描、提取与渲染都在本地完成。插件不会上传壁纸或 Steam 数据。WebWallGL
渲染库已内置于 `server/vendor/`（无需访问 CDN）；Scene 包从本地 Steam 创意
工坊目录读取并直接注入页面，本地回环 HTTP 服务（`127.0.0.1:43310`）只服务于
壁纸选择器 UI 和健康/状态端点。按用户隔离的状态保存在
`%APPDATA%\Codex\luna-beautiful-codex` 下。

## 🖥️ WebGL 渲染原理

Codex 桌面端页面带有严格的 Content-Security-Policy（`default-src 'none'`），
会拦截页面侧的一切 `fetch()`——包括对 CDN 和 `http://127.0.0.1:43310` 的请求
（`connect-src` 回退到 `default-src`）。因此 0.2.1 之前「从 CDN 加载 WebWallGL」
的设计必然失败，Scene 壁纸只会得到纯黑背景。

守护进程完全绕开 CSP（不触碰它），全部通过 DevTools 协议完成：

1. 守护进程在 Node 侧读取 `webwallgl.global.min.js`、`scene.pkg` 和
   `project.json`；
2. 以 base64 分块经 `Runtime.evaluate` 注入页面（inspector 求值不受页面 CSP
   约束）；
3. 页内重建字节并用 `WebWallGL.bytesSource(pkgBytes, project, key)` 构建
   source——库在页内本地解析场景包，渲染过程**零页面侧网络请求**；
4. 若库或 WebGL2 不可用，同一条注入路径会安装 Scene 的内嵌视频或静态预览作为
   回退（绝不黑屏）；
5. 当 Codex 窗口被隐藏/完全遮挡时，Chromium 会冻结 `requestAnimationFrame`，
   Scene 无法产出 `mount()` 等待的首帧——此时守护进程立即安装回退媒体，并通过
   页内 `visibilitychange` 监听器延迟 WebGL 挂载，窗口重新可见的瞬间自动升级
   为实时渲染。每条 DevTools 命令还带有 240 秒超时，页面卡死不会拖垮守护进程
   的恢复循环。

## 📚 vendor 目录

`server/vendor/webwallgl.global.min.js` 是
[webwallgl@2.1.0](https://www.npmjs.com/package/webwallgl)（MIT，© oneincase），
内置提供以支持离线使用。升级方式：

```
npm pack webwallgl@<version>
tar -xzf webwallgl-<version>.tgz package/webwallgl.global.min.js
copy package\webwallgl.global.min.js server\vendor\
```

`webwallgl.d.ts` 与 `webwallgl.LICENSE` 保存在同级目录供参考。若该文件缺失，
守护进程会记录 `WebWallGL library not vendored` 并回退到内嵌视频/预览媒体。

## 🩺 故障排查

- 日志文件：`server/codex-wallpaper-watchdog.log`。关键行：
  - `scene webgl <id>: renderMode=webgl (vendored WebWallGL, bytesSource pkgBytes=... mountMs=...)` —— WebGL 实时渲染已生效；
  - `renderMode=fallback webglError=...` —— WebGL 不可用，展示注入的视频/预览；
  - `renderMode=failed` —— WebGL 与回退媒体都无法安装（例如壁纸既无 `scene.pkg` 也无预览图）；
  - `another watchdog already owns :43310` —— 已有实例在运行，第二个实例自行退出（正常）。
- 壁纸来自 `<Steam 库>\steamapps\workshop\content\431960\`；缺少 `scene.pkg`
  或 `project.json` 会降级为预览模式。
- 守护进程通过探测 DevTools 端口 9229–9239 寻找 `app://-/index.html` 页面；请
  保持 Codex Desktop 的远程调试开启。

## 🧪 自测

在 Codex Desktop 打开且守护进程运行时：

```
node server/selftest.mjs
```

脚本会切换到库中的每一张壁纸，对标记为 `webgl` 的壁纸断言其真正以 WebGL 渲染
（基于 DevTools 页面断言而非日志），恢复你之前的选择，任何失败都会以非零退出码
结束。

## 📝 备注

- 守护进程随 Codex MCP 服务端一起启动。
- Scene 壁纸以 WebGL 实时渲染；若 WebGL2 不可用或 WebWallGL 加载失败，回退到
  提取的内嵌视频或静态预览图。
- 视频与图片壁纸按原始画质直接使用。

## 📄 更新日志

- **0.2.1** — Scene 壁纸恢复真正的实时渲染：内置 WebWallGL，场景包以字节
  （`bytesSource`）注入，绕过令一切页面侧 fetch 失败的页面 CSP（纯黑背景的
  根因）。回退媒体同样改为注入而非拉取。切换到原生壁纸时销毁 WebGL 实例
  （不再泄漏 GL 上下文）；窗口隐藏时延迟 WebGL 挂载而不是超时退化为静态图。
  新增 `server/selftest.mjs`（基于 DevTools 的页面断言）。
- **0.2.0** — 首个公开版本。

## 📄 许可证

MIT — 见 [LICENSE](LICENSE)。
