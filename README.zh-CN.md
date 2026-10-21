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
- **外观工作室** — 液态玻璃（六个面、逐面覆盖、侧栏四角独立圆角）、5 套预设、
  字体与配色、背景滤镜与取景。
- **壁纸库与特效** — 类型/标签/隐藏筛选、本地上传、自动轮播、7 种过场；
  点击/拖尾/视差特效、会话头像与可拖动吉祥物。
- **Web 壁纸与属性** — Wallpaper Engine `type: "web"` 项目在沙箱 iframe 中渲染；
  支持读取 `general.properties` 并实时应用；视频壁纸可选音轨与音量。

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
   C:\Users\<you>\.codex\plugins\cache\personal\luna-beautiful-codex\0.2.3
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
  -Path "$HOME\.codex\plugins\cache\personal\luna-beautiful-codex\0.2.3" `
  -Target "$(Get-Location)"
```

然后重启 Codex 并启用插件。

## 🎯 使用方法

1. 在对话里说（这是插件的默认提示词）：

   > 打开我的 Wallpaper Engine 壁纸选择器

2. Codex 对话页右下角会出现 **壁纸** 按钮。点开列表，再点任意一行即可把该壁纸
   应用到当前会话；顶部搜索框可按标题或创意工坊 ID 过滤。
3. 其余操作同样可以用对话完成（见上方「MCP 工具」）：`list_backgrounds` 列出
   壁纸、`set_background` 直接指定（ID / 标题 / 本地路径 / URL）、
   `set_background_opacity` 调不透明度与模糊、`reset_background` 还原、
   `background_status` 查看当前状态。
4. 选择器与上次的壁纸会在下次打开 Codex 时自动恢复；你的选择保存在
   `%APPDATA%\Codex\luna-beautiful-codex\wallpaper-selection.json`。

## 🎨 外观与特效

右下角 **外观** 按钮打开外观工作室，所有修改即时生效并写入 `prefs.json`：

- **液态玻璃** —— 侧栏、对话区、设置窗、思考区、浮层可分别继承/自定义/关闭；
  可调模糊、底色、边框、遮罩与保真度；侧栏支持四角独立圆角与最多 8 条额外毛玻璃选择器。
- **预设** —— 黑客绿 / 磨砂 / 夜航 / 可读 / 鲜艳，支持导出与导入 JSON（导入只加入列表，不自动应用）。
- **字体与配色** —— 全局字体族（可尝试系统字体）、次要/注脚/正文三种角色、组件级覆盖、光标与 UI 配色。
- **画面滤镜与取景** —— 模糊、亮度、对比度、饱和度、不透明度、暗化，以及 cover/contain/fill、位置与缩放。
- **扩展特效** —— 点击涟漪/火花/圆环、指针拖尾、视差、会话头像、可拖动吉祥物。
  特效层全部 `pointer-events:none`，空闲时不跑 rAF。

## 🗂️ 壁纸库与过场

选择器支持按类型（场景/视频/图片/网页）、标签与隐藏状态筛选；隐藏不会删除文件；
可添加本地 JPG/PNG/MP4/WebM；自动轮播只从当前筛选结果中取候选，并优先预热下一张。
7 种过场（硬切/淡化/缩放/推移/擦除/圆形扩散/条形展开）都先让新层就绪再动，黑屏空档为 0。

## 🌐 Web 壁纸、属性与音轨

Wallpaper Engine `type: "web"` 项目在 `sandbox="allow-scripts"` 的 iframe 中渲染
（不透明源、`pointer-events:none`）。CSS/图片/字体内联为 data URL，项目脚本经
DevTools 新文档注入执行（页面 CSP 禁止内联脚本）；8 秒未就绪则回退到项目的视频或预览图。
`general.properties`（schemecolor、滑块、下拉、开关）会显示在选择器中，Scene 通过
`setProperties()`、Web 通过 `wallpaperPropertyListener.applyUserProperties` 应用。
视频壁纸可开启音轨并调音量；浏览器拦截有声自动播放时先静音播放并提示点击一次页面。

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
    ├── appearance.mjs          # 外观模型 + 面板运行时（玻璃/字体/滤镜/特效）
    ├── ext.mjs                 # 点击/拖尾/视差/头像/吉祥物运行时
    ├── library-state.mjs       # 壁纸库筛选/标签/隐藏/轮播/过场状态
    ├── web-wallpaper.mjs       # Web 壁纸内联构建 + 沙箱引导脚本
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

覆盖范围共 33 项断言：每张壁纸的安装与渲染模式、壁纸选择器点击、外观面板开关、
液态玻璃样式表增删、过场切换、外观设置持久化、面板拖动/停靠/双列布局、扩展特效
（点击/吉祥物）、网页壁纸 srcdoc 构建、壁纸库通道（隐藏/类型筛选/轮播）、透明度与
排版面板在切换后保持、局部写入 prefs 不会清空外观配置、强制白字、视频音量、`reset`
后不会被守护进程自动装回，以及**结束时把整份 prefs 还原到运行前快照并验证**——
测试改动了你的外观却没还原，本身就算失败。

## 📝 备注

- 守护进程随 Codex MCP 服务端一起启动。
- Scene 壁纸以 WebGL 实时渲染；若 WebGL2 不可用或 WebWallGL 加载失败，回退到
  提取的内嵌视频或静态预览图。
- 视频与图片壁纸按原始画质直接使用。

## 📄 更新日志

- **0.3.2** — 观感与布局修复（用户反馈「壁纸很丑、外观面板不能改位置和布局」）。
  （1）壁纸被压到 5% 不透明度：`backgroundOpacity: null`（表示「无覆盖」）被 `Number()`
  读成 0，再被夹到下限 5%，于是壁纸几乎看不见而所有控件仍显示 100%。现在 null 表示不加覆盖，
  100% 时直接移除样式表，遗留的旧样式表也会在每次安装后被清掉。
  （2）气泡模式把壁纸洗白：Codex 浅色主题给主内容区铺了一层 30% 白色蒙层，叠在壁纸上像一层
  牛奶膜，壁纸发灰、白字失去对比。气泡模式现在清掉这层蒙层，让壁纸原色透出。
  （3）气泡模式的文字面板改成采样壁纸的「深色」分量并叠加真实背景模糊，不再是往白色混 66%——
  那会在浅色壁纸上产生白底白字。侧栏与顶栏在气泡模式下也补上同样的暗色磨砂底。
  （4）外观面板可以拖动、四角停靠、切单列/双列。拖动顶部标题栏即可自由摆放，位置与布局写进
  `appearance.ui` 并在重开、切换壁纸后保持；`⌂` 一键恢复默认，`▥` 切换双列（720px，
  每列 344px，五个分组一屏可见，不用滚动）。
  （5）自测新增「放置」与「恢复」断言：停靠、双列、真实拖拽都要断言，并在结束时把整份
  prefs 还原到运行前的快照再验证一次——测试改动了用户外观却没还原，本身就算失败。
  （6）强制白字改为按页面实际状态校准，不再依赖缓存标志；页面被重注入或外部脚本改动后
  不会再永久失步。自测从 31 项扩到 33 项。
- **0.3.1** — 自测与工具链修复。6 个真实缺陷：
  （1）`reset_background` 返回成功却无效——守护进程在一个 tick 内就把记忆的壁纸装回来；
  现在新增 `/reset` 与 `/disable`，重置会写入 `selection.disabled` 并在选中新壁纸前停止恢复。
  （2）`set_background` 设原生/网页壁纸时不同步守护进程的选择，下一 tick 就被覆盖；现在库内壁纸
  统一走 `/select`，只有自定义文件/URL 才走页面注入。
  （3）背景透明度面板在每次切换后被重建，并硬编码回 100%/45%，把用户或工具设的透明度、
  气泡排版强度冲掉；现在两个值都写进 prefs 并在重建时回放，切换后保持。
  （4）面板持有旧的 media 节点，切换后在已卸载的图层上调透明度；改为按需解析当前节点。
  （5）`set_background` 的 `opacity` 参数在委托给守护进程后失效；新增 `/opacity` 通道，
  透明度成为持久状态并在每次安装后重新应用。
  （6）`POST /prefs` 把任何没有 `appearance` 键的请求体当成「裸外观对象」，于是只改透明度或
  排版强度就会把液态玻璃、字体、滤镜整块重置为出厂值；现在按字段合并，并把外部写入镜像到页面。
  自测从 22 项扩到 31 项，并修掉了玻璃断言自身的顺序错误（先关玻璃再检查样式表，玻璃本来开着时必挂）。
- **0.3.0** — 外观工作室与壁纸库大版本：液态玻璃（六面 + 逐面覆盖）、5 套预设与 JSON 导入导出、
  字体/配色、背景滤镜与取景、点击/拖尾/视差、会话头像与吉祥物、壁纸库筛选/标签/隐藏/上传、
  自动轮播、7 种过场、Web 壁纸（沙箱 iframe）、Wallpaper Engine 属性、视频音轨；
  外观面板改为分组懒渲染（打开 ≤50 ms），`/status` 增加 `appearance.lastError`，
  自测新增外观面板/玻璃/过场三项断言。
- **0.2.3** — 切换更顺、更清晰。三个根因一起修：
  （1）部分壁纸的 `project.json` 里写的是首字母大写的 `"type": "Scene"`，旧逻辑只认小写 `scene`，
  于是这些 3D 动态壁纸被当成「静态图」，把低分辨率的 `preview.gif` 拉伸到全屏——这就是
  「刚出来是模糊的」。现在只要目录里有 `scene.pkg` 就一律按 Scene 处理，直接用 WebGL 实时渲染。
  （2）每次扫描壁纸都要把 `scene.pkg` 整个读进内存去找内嵌视频（最大的有 126MB），一次约
  0.5–0.7 秒，而一次切换会扫描好几遍。现在扫描结果缓存 30 秒、内嵌视频探测按
  （路径 + 修改时间 + 大小）记忆化，重复扫描耗时降为 0 毫秒。
  （3）以前切换会先把旧背景拆掉再装新的，中间整屏发黑，而且最先看到的是糊的预览图。
  现在「旧图先留着，新图在后台挂好再交叉淡出」，实测黑屏空档为 0。
  其他：渲染精度提升到「设备像素比与 1.5 取较大值」并开启 4× MSAA（此前纹理只按
  0.5–0.6 倍采样，这是画面发糊的第二个来源），实测帧率仍保持 59–60fps；不再为注定
  用不上的回退视频预注入 100MB 数据；已在运行的守护进程不会再被反复拉起。普通 Scene
  壁纸的切换耗时从约 7.6 秒降到约 2 秒。
- **0.2.2** — 修复「点击壁纸没反应」：`GET /status` 会抛
  `state is not defined`，错误处理里再次 `writeHead` 触发
  `ERR_HTTP_HEADERS_SENT`，直接把守护进程整个打挂——凡是读过 `/status`
  的一方（包括自带的 `server/selftest.mjs`）都会让点击失效。现在该接口返回
  真实状态，错误处理也不会再拖垮进程。选择器面板改为显式写入 `display`
  （不再只切换 class），遗留的内联 `display` 不会再让列表永久隐藏；列表也不再
  每 1.2 秒重建（此前会吞掉正在进行的点击、并把滚动位置弹回顶部）。选择器改用
  与守护进程一致的 DevTools 端口探测范围（9229–9239）而不是写死 9229；MCP
  服务端在守护进程已在运行时直接复用，不再每 5 秒重复拉起。
- **0.2.1** — Scene 壁纸恢复真正的实时渲染：内置 WebWallGL，场景包以字节
  （`bytesSource`）注入，绕过令一切页面侧 fetch 失败的页面 CSP（纯黑背景的
  根因）。回退媒体同样改为注入而非拉取。切换到原生壁纸时销毁 WebGL 实例
  （不再泄漏 GL 上下文）；窗口隐藏时延迟 WebGL 挂载而不是超时退化为静态图。
  新增 `server/selftest.mjs`（基于 DevTools 的页面断言）。
- **0.2.0** — 首个公开版本。

## 📄 许可证

MIT — 见 [LICENSE](LICENSE)。
