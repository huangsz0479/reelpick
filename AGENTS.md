# 拾影 Reelpick（video-tools）

本地运行的无水印视频下载桌面应用。Electron + TypeScript + React + Base UI + CSS Modules。不使用 Tailwind。

产品背景见 `PRODUCT.md`，视觉规范见 `DESIGN.md`，对标站点分析见 `docs/kukutool-analysis.md`。

## 环境

- Node 22（`.nvmrc`）。Vitest 5 在 Node 20 下会崩溃。
- 包管理器用 pnpm。npm 10 在这个项目上安装会报 arborist 错误。
- 用 Electron 跑脚本崩溃后，macOS 下次启动会卡在“是否恢复窗口”的询问上（`app.whenReady` 不返回）。加参数 `-ApplePersistenceIgnoreState YES` 可以跳过。
- 在 Devin / VS Code 的终端里，环境变量 `ELECTRON_RUN_AS_NODE=1` 会让 Electron 以 Node 模式启动、不出窗口。启动前先 `unset ELECTRON_RUN_AS_NODE`。
- 用 Electron 跑一次性脚本时，最后一个窗口销毁后应用会自己退出，脚本后面的部分不会执行。先注册一个空的 `window-all-closed` 监听。
- Electron 脚本是 ES 模块时，把 `app.whenReady()` 之后的逻辑放进 `.then()`。在模块顶层 `await` 它会卡死：Electron 等入口模块执行完才触发 ready。
- macOS 包没有开发者证书，用临时签名（package.json 里 `mac.identity` 为 `-`，并关掉 `hardenedRuntime`）。完全不签名的包在 Apple 芯片上会被系统判为“已损坏”；临时签名加 `hardenedRuntime` 会启动失败。写明 `identity` 后 electron-builder 也不再去钥匙串里自动选证书。
- 脚本或测试里，本地 HTTP 服务和 ffmpeg 同在一个进程时用异步的 `spawn`。`spawnSync` 会卡住事件循环，服务无法应答，ffmpeg 只会等到超时。
- 查看安装包内容时在临时目录里运行 `asar`：`extract-file` 把文件解到当前目录，会覆盖同名文件。
- 数据目录（设置、登录状态）在 macOS 上是 `~/Library/Application Support/video-tools`，开发和打包后相同：目录名取自 package.json 的 `name`，`app.setName` 在 ready 之后调用，不影响它。

## 命令

- `pnpm dev`：开发模式
- `pnpm typecheck`：类型检查（主进程和渲染进程各一份 tsconfig）
- `pnpm test`：单元测试与本地集成测试
- `pnpm test:live`：额外跑真实平台接口的测试，需要联网
- `pnpm build`：构建到 `out/`
- `pnpm icons`：改了 `build/icon.svg` 后运行，重新导出同目录下的 `icon.png`、`icon.icns`、`icon.ico`
- `pnpm dist:mac` / `pnpm dist:win`：打安装包。ffmpeg 二进制随安装平台下载，Windows 包必须在 Windows 上打。

## 发布

- 仓库：`github.com/huangsz0479/reelpick`。`.github/workflows/build.yml` 在推送到 `main` 和提 PR 时跑类型检查、测试并打包（mac arm64、mac x64、win x64），安装包在 Actions 运行页的 Artifacts 里。
- 发版：改 package.json 的 `version`，推送同名标签（如 `v0.1.0`），工作流会建 GitHub Release 并附上三个安装包。
- 安装包文件名由 `build.artifactName` 定为 `Reelpick-<版本>-<系统>-<架构>`：GitHub Release 会把附件名里的中文去掉。

## 结构

- `src/shared/`：主进程与渲染进程共用的类型和 IPC 约定
- `src/main/parsers/<平台>/`：各平台解析器，实现 `Parser` 接口并在 `parsers/index.ts` 注册
- `src/main/download/`：下载队列、文件命名、ffmpeg 合并
- `src/renderer/src/`：界面

## 约定

- 解析器只通过 `ParseContext` 发请求，不直接用全局 `fetch`，这样测试里可以替换。
- Electron 的 `net.fetch` 跳转后 `response.url` 为空，短链接必须用 `ctx.finalUrl` 还原。
- 需要页面脚本签名的平台（抖音）不逆向签名算法，用 `ctx.capturePage` 在隐藏窗口里打开真实页面并截取它自己的接口响应。这类解析器无法在 vitest 里跑真实请求，要在应用里手动验证。
- 在应用里验证可以脚本化：启动时加 `--remote-debugging-port=<端口> --user-data-dir=<临时目录>`，通过 CDP 在渲染进程里调用 `window.api`、操作界面、截图。小红书的测试链接取自发现页（`/explore`）里带 `xsec_token` 的链接。
- 主进程里的状态（应用菜单、窗口列表）用 `--inspect=<端口>` 检查：通过 Node inspector 的 `Runtime.evaluate` 执行代码，带上 `includeCommandLineAPI: true` 才有 `require('electron')`，`import()` 在那里不可用。
- 设置窗口和主窗口加载同一份页面，设置窗口带 `?window=settings`，`main.tsx` 据此只引入 `SettingsWindow` 或 `App` 其中一个。新窗口用 `openAppWindow` 创建。
- 音视频分流的版本（B 站）在应用内预览靠 MSE：`lib/dash.ts` 用 `fetch` 从 `vt-media://` 按播放位置取分片。这要求三处同时成立：协议注册了 `corsEnabled` 且响应带跨域头；构建时的 CSP 有 `connect-src vt-media:` 和 `media-src blob:`；解析器在两路流的 `StreamRef.mime` 里给出带 codecs 的 MIME。
- B 站接口返回的媒体地址里，P2P 节点（`mcdn`、带端口号的地址）常排在最前面，实测比镜像 CDN（`upos-*`）慢一个数量级。解析器里的 `stream()` 把官方 CDN 排到前面，下载和预览都受益。
- 隐藏的抓取窗口都设 `disableDialogs`：页面调用 `alert()` 时对话框会卡住页面脚本，抓取只能等到超时。手动模式的窗口保留对话框。
- 小红书的笔记数据写在页面 HTML 的 `window.__INITIAL_STATE__` 里，用 `ctx.capturePage` 截取页面文档本身。普通 HTTP 请求（包括带 Cookie 的）会被跳转到登录页，所以同样无法在 vitest 里跑真实请求。
- 小红书链接里的 `xsec_token` 是访问凭证，不带就是 404，解析时必须保留原链接的查询参数。
- 小红书原图在 `sns-img-bd.xhscdn.com/<fileId>`，格式可能是 JPEG、PNG 或 HEIC，响应头的类型不可靠，要读文件头判断；`ci.xiaohongshu.com/<fileId>?imageView2/2/w/0/format/jpg` 固定返回原尺寸 JPEG。
- 平台 `web` 是三个平台之外的来源：`parsers/m3u8` 处理直接给出的 m3u8 地址，`parsers/web` 用 `ctx.sniffPage` 在隐藏窗口里打开任意网页并找出它请求的 m3u8。`web` 匹配所有网址，在 `parsers/index.ts` 里必须排最后。自动识别失败时报 `no_stream`，界面提供“打开网页”，以 `manual` 模式显示窗口让用户自己播放一次。
- 「浏览网页」页面（`src/main/browser.ts` 的 `SniffBrowser`）是持续嗅探：用户自己浏览和播放，页面请求里的 m3u8 和视频文件一直往列表里加，由用户挑着下载。它是主窗口里的一个页面，不是单独的窗口（用户明确要求）：网页是叠在主窗口界面上的 `WebContentsView`，位置由 `src/shared/browser.ts` 里的三个尺寸决定，界面在那里留空。
- `WebContentsView` 盖在界面上面，界面的东西遮不住它。切到别的页面时由界面调用 `window.api.browser.show(false)` 把它藏起来并静音，网页本身继续开着。以后在「浏览网页」页面上加弹层，也要先把它藏起来。
- 哪些响应算视频由 `src/main/sniff.ts` 的 `classifyResponse` 判断（纯函数，有单元测试）：分片、小于 1MB 的文件、地址带 `range` 参数的请求不算。没有清单、按片请求的站点（YouTube）和 DRM 抓不到。
- 「浏览网页」里的下载从抓取会话读出该地址的 Cookie 放进请求头：下载用的 `net.fetch` 和 ffmpeg 都不带这个会话的 Cookie。ffmpeg 会把它发给 m3u8 引用的所有地址。
- 「浏览网页」可以脚本化验证：本地起一个带 Cookie 校验的测试站（网页、MP4、多清晰度 m3u8），通过 CDP 在界面里调用 `window.api.browser`。
- m3u8 的分片自己并发下载（`download/hls.ts`，同时 8 个，走 `net.fetch`、跟随系统代理），按顺序拼成一个文件后在本地用 ffmpeg 封装成 MP4，变体上用 `hls: true` 标记。实测 10 分钟的 720p 流从 108 秒降到 30 秒。拼接不保证能播的播放列表（`parseSegments` 返回 null：中途换片源的 DISCONTINUITY、AES-128 之外的加密、多个初始化段）仍然整个交给 ffmpeg 拉流，ffmpeg 走自己的网络栈，不跟随系统代理。
- 退回到 ffmpeg 拉 m3u8 时，分片下不到或传到一半断开只会被跳过，进程照常以 0 退出。`download/hls.ts` 靠 warning 级别的日志识别出来并判为失败；`-reconnect` 系列参数对分片不起作用（ffmpeg 6.0 实测）。
- Electron 的 `net.fetch` 会取消带路径的跨站 Referer（日志里是 invalid referrer），请求头里的 Referer 只写到站点根路径。
- 登录窗口（`src/main/login.ts`）和页面抓取共用 `persist:capture` 会话。直接请求接口的平台（B 站）从这个会话读 Cookie 传给 `ctx.cookies`。
- 下载记录由 `DownloadManager` 存在数据目录的 `downloads.json` 里，只存任务本身，不存请求（下载地址会过期，请求头里可能有 Cookie）。所以上次运行留下的记录不能重试，`retryable` 一律为 false；没结束的任务按失败记，应用崩溃后记录也在。
- 下载失败统一经 `download/failure.ts` 归类成错误码，界面按 `retryable` 决定是否显示重试。
- 下载的中间文件都带 `.part` 后缀，最终文件只在内容完整后改名出现。退出应用前由 `DownloadManager.shutdown()` 取消并清理，否则 ffmpeg 会留在后台继续下载。
- 启动 ffmpeg 一律用 `runFfmpeg`：取消时直接杀掉，等进程退出后才返回，这之后才能删它的输出文件（Windows 不允许删除还被别的进程打开的文件）。
- 下载写文件用 `FileHandle` 逐块 `await`。用 `createWriteStream` 时，目录只读或磁盘满的错误事件没人接，会变成主进程的未捕获异常，或让任务永远停在下载中。
- `net.fetch` 遇到不再发数据的连接会一直等，普通文件下载靠 `fetchToFile` 里的停滞计时器放弃当前地址。
- 只有渲染进程用的包放 `devDependencies`（构建时已打进 `out/renderer`）。放进 `dependencies` 会被 electron-builder 整包装进安装包。
- 抖音手机分享页（iesdouyin.com/share）已不返回作品数据，只有电脑版页面 `www.douyin.com/video/<id>` 可用。
- 平台接口行为先用真实请求确认，再写解析器；每个解析器都要有 `test:live` 用例。
- 面向用户的错误信息用中文，说明问题和用户能做什么。
