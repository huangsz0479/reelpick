# dy.kukutool.com 逆向分析报告

- 分析日期：2026-11-15
- 目标：https://dy.kukutool.com/ （KuKuTool，多平台视频/图片/Live 图去水印解析下载）
- 方法：抓取 SSR HTML 与 RSC 数据、下载并格式化全部前端 JS 产物（29 个首屏 chunk + 14 个懒加载 chunk）做静态分析；对公开接口做只读探测；按前端协议用一条公开 B 站链接完整跑通了一次解析。
- 标注约定：**[实测]** = 线上请求实际观察到；**[代码]** = 前端产物里读到；**[推断]** = 没有直接证据的判断。

## 1. 结论摘要

1. 网站是 **Next.js App Router + next-intl + Tailwind** 的前端，解析能力全部在**服务端**：浏览器只把分享链接发给 `/api/parse`，服务端返回无水印直链 JSON。
2. 真正的核心资产是**服务端各平台解析器**（抖音、快手、小红书、B 站、微博等），前端产物里完全看不到，**无法通过逆向前端复刻**，需要自研或接入开源/第三方解析方案。这是复刻工作量的主体。
3. 前端可复刻的部分很清晰：两段式「票据 + 加密」请求协议、结果渲染、浏览器端下载（直连失败回退代理）、JSZip 批量打包、ffmpeg.wasm 音频提取与视频压缩、11 种语言、深浅色主题。
4. 围绕解析有一套完整的**防刷与变现体系**：一次性票据、IP 秒级/日级限流、自动封禁、匿名每日 10 次、积分/会员、看广告解锁、AdSense、App/小程序导流。

## 2. 技术栈

| 层 | 内容 | 依据 |
|---|---|---|
| 框架 | Next.js（App Router，RSC 流式渲染），路由 `app/[locale]/...` | [实测] `x-powered-by: Next.js`、`x-middleware-rewrite: /zh`、chunk 路径 |
| 国际化 | next-intl，11 个 locale：zh（默认无前缀）、en、zh-Hant、zh-Hans-SG、de、es、fr、ja、ko、ru、vi；Cookie `NEXT_LOCALE`；时区 Asia/Shanghai | [实测] 响应头 `link` hreflang、RSC 里的 `messages` |
| 样式 | Tailwind CSS，`dark` class 切换；`<head>` 内联同步脚本 `VideoCleanerTheme`（localStorage `video-cleaner-theme`），`/tiktok` 页强制深色 | [代码] |
| 数据请求 | SWR（用户会话）、axios、原生 fetch | [代码] chunk 8677 |
| 浏览器端处理 | `@ffmpeg/ffmpeg` 0.12.10 + `@ffmpeg/core` wasm、JSZip + FileSaver、Web Crypto（crypto-js 兜底） | [代码] chunk 902/1631/6043/7496/97/3052 |
| 统计 | 自建 Matomo（`stat.hellotik.app`，siteId 1），大量 `trackEvent` | [代码] |
| 广告 | Google AdSense（`ca-pub-7112274049624154`）+ Funding Choices | [代码] chunk 5859 |
| 边缘 | `server: wafcdn`（WAF/CDN） | [实测] |
| 项目名 | 内部工程名 `video-cleaner`（路径 `/root/develop/video-cleaner/`） | [代码] chunk 902 |

### 服务拆分

| 服务 | 地址 | 作用 |
|---|---|---|
| 主站 | `dy.kukutool.com/` | Next.js 前端 + `/api/*` 路由（解析、票据、下载代理、权益等） |
| 账号中心 | `dy.kukutool.com/account/*` | **独立的另一个 Next.js 应用**（basePath `/account`）：登录、注册、定价、积分、个人中心；另有 `/account/user/api/*` |
| GeoIP | `dy.kukutool.com/getip/geoip` | 独立 Express 服务，返回 `{ip, isoCode}` |
| 运营后台 | `ops.kukutool.com` | SCM 运营位内容（`/api/scm/content`）、事件上报（`/api/events/parse`、`/api/events/ultra-hd`） |
| 批量解析 | `www.maxhelper.app/batch` | 姊妹站点，批量功能导流过去 |
| 下载中转 | `redown1.maxhelper.app` 等，路径 `/v1/download/(video\|image)?token=...` | 带 token 的媒体中转下载 |
| 静态资源 | 腾讯云 COS（广州） | 图片、ffmpeg wasm 备用源 |

## 3. 页面与功能清单

| 路径 | 功能 |
|---|---|
| `/`（及 `/{locale}`） | 首页：输入框 + 解析 + 结果区 + 特性/FAQ/使用步骤 |
| `/douyin` `/kuaishou` `/xiaohongshu` `/weibo` `/bilibili` `/tieba` `/haokan` `/xigua` `/zhihu` | 各平台 SEO 落地页，复用同一解析组件（`/xiaohongshu` 是独立布局，有简繁两版） |
| `/tiktok` `/tiktok-downloader` `/instagram-downloader` `/facebook-downloader` `/rednote-downloader` | 海外平台落地页（`/tiktok` 默认英文、强制深色） |
| `/audio-extractor` | 视频提取音频：上传文件或输入链接，浏览器端 ffmpeg.wasm 转 WAV/MP3 |
| `/batch` | 批量解析（多行链接、进度、ZIP 打包），导航入口指向 maxhelper.app |
| `/guides/download-xiaohongshu-videos-photos`、`/live-photo-tutorial` | 教程内容页 |
| `/mobile` | App（iOS/Android）与微信小程序「动动去水印」下载页 |
| `/contact` `/feedback` `/privacy` `/terms` | 联系、反馈、协议 |
| `/account/*` | 登录注册、会员定价、解析点数 |
| `/admin/*`（robots 禁止） | 管理后台：Ticket IP 统计、趋势图、封禁管理、自动封禁预设、维护开关 |
| `/llms.txt` `/robots.txt` `/sitemap.xml` | SEO / AI 抓取说明 |

首页结果区功能 [代码]：

- 标题展示与复制文案
- 单视频：下载无水印视频、提取音频（跳 `/audio-extractor?videoUrl=...`）、复制无水印链接、在线预览
- 多清晰度：`video_fullinfo` 列表逐项下载，显示文件大小
- 图集 / Live 图：图片列表逐张下载、封面下载、全选后批量 ZIP（图片 ZIP、视频 ZIP 分开，仅桌面端）
- 下载进度与速度显示、可取消、失败后弹出原始直链（新窗口打开 / 复制）
- 「更多尺寸」`/api/more-size`（高清/原图，付费或登录功能）
- 视频压缩（ffmpeg.wasm：libx264 veryfast + aac，按目标体积算码率）
- 快捷键：Enter 提交、Ctrl/Cmd+I 聚焦输入框；「粘贴链接」按钮读剪贴板

## 4. 核心：解析请求协议

### 4.1 时序

```
浏览器                                            dy.kukutool.com
  │ (可选) POST /api/parse-entitlement-status  →  返回报价/额度 + quoteToken
  │ POST /api/auth-970b03 {requestURL,pagePath,mode}
  │                                           ←  {k_970b03, s_970b03} + Set-Cookie parse_sid
  │ AES-GCM 加密参数（key = SHA-256(k + ":" + s)）
  │ POST /api/parse {version:3, k_970b03, p_970b03, i_970b03, r_970b03}
  │                                           ←  {status:0, encrypt:true, data, iv, ...}
  │ 反混淆 + AES-CBC 解密 → 媒体 JSON
  │ POST ops.kukutool.com/api/events/parse（转发服务端签名回执）
```

### 4.2 第一步：取票据 [实测]

`POST /api/auth-970b03`（路由名随「协议档案」轮换，当前 profile id `20260907`；默认名 `parse-auth`）

```json
{ "requestURL": "<用户输入>", "pagePath": "/", "mode": "single" }
```

返回 `{ "k_970b03": "<32 字符>", "s_970b03": "<43 字符>" }`，并下发 Cookie `parse_sid`。登录用户额外带请求头 `X-Auth-Session`。

票据是一次性的，绑定请求 URL 与会话。失败原因码（字段名同样被混淆映射）[代码]：`ticket_expired`、`ticket_used`、`ticket_missing`、`ticket_subject_mismatch`、`ticket_request_mismatch`、`ticket_profile_inactive`、`ticket_ip_rate_limited`、`ticket_ip_daily_limited`、`ticket_ip_restricted`、`ticket_service_maintenance`。

### 4.3 第二步：加密提交 [实测]

明文参数：

```json
{
  "requestURL": "...", "captchaKey": "", "captchaInput": "",
  "totalSuccessCount": "0", "successCount": "0", "firstSuccessDate": "",
  "pagePath": "/", "uwx_id": "uwx_<6位时间戳><4位随机><2大写字母>",
  "isMobile": "false", "geoipIp": "", "confirmPurchased": false,
  "qualityTier": "hd", "quoteToken": null, "country_code": null,
  "userID": "<登录后才有>"
}
```

加密：`key = SHA-256(authKey + ":" + authSeed)`，AES-GCM，12 字节随机 IV，密文与 IV 均 base64。

```json
{ "version": 3, "k_970b03": "<authKey>", "p_970b03": "<密文>", "i_970b03": "<iv>", "r_970b03": 1 }
```

### 4.4 响应与解密 [实测]

```json
{ "status": 0, "encrypt": true, "data": "<混淆密文>", "iv": "<混淆iv>",
  "qualityFallback": true, "qualityTier": "standard", "message": "...",
  "_ops_parse_receipt": { "version":1, "body":"...", "timestamp":"...", "signature":"...", "key_version":"1" } }
```

`data` 与 `iv` 的还原步骤（chunk 3052 `kukudemethod`）：

1. 每个字符与 `90` 异或
2. 每 8 个字符一组做组内反转
3. 自定义字母表换回标准 base64（`ZYXABC…W zyxabc…w 9876543210-_` → `A-Za-z0-9+/`）
4. AES-CBC 解密，key = `SHA-256("12345678901234567890123456789013")`（前端硬编码）

这层加密只是混淆（密钥在前端），真正的防护是 4.2 的票据。

### 4.5 结果数据结构

[实测] B 站链接返回：

```json
{
  "title": "【官方 MV】Never Gonna Give You Up - Rick Astley",
  "type": "video",
  "cover": "https://i1.hdslb.com/...jpg",
  "url": "https://upos-sz-mirrorcos.bilivideo.com/...mp4?...",
  "videos": [ { "url": "..." } ],
  "pics": [ "https://i1.hdslb.com/...jpg" ]
}
```

[代码] 其他会出现的字段：

- `videos[]` 元素可以是字符串或对象；对象可带 `video_fullinfo[]`（多清晰度，每项有 `url`、`type`、`size`、`originalUrl`）
- `pics[]` 图集；Live 图 = `pics` 与 `videos` 并存（多视频时弹 Live 图教程）
- `moreSizeToken`：调 `/api/more-size` 用
- 顶层 `creditsConsumed` / `creditsRemaining`：积分扣减提示

### 4.6 错误状态码约定 [代码]

| HTTP | 含义 |
|---|---|
| 400 | 链接无效 / 平台解析失败（`PLATFORM_PARSE_FAILED`） |
| 401 | 需要登录（特定 code 触发登录弹窗） |
| 403 | 签名/票据校验失败 |
| 429 | 请求过于频繁 |
| 500 | 服务器错误 |
| 511 | 验证码错误（图形验证码逻辑仍在，当前首页未启用） |
| 533 | 积分不足 |
| 535 | 匿名每日 10 次用完，要求登录 |
| 536 | 小红书解析失败，引导看教程 |
| 538 | 普通解析超限，弹「看广告/扫码解锁、升级、登录」 |
| 539 | 高级解析免费次数用完 |
| 541 | 确认是否消耗一次已购高级解析 |

## 5. 下载实现 [代码]

媒体直链在第三方 CDN 上，跨域和防盗链是主要障碍，站点的做法：

1. **Referrer**：全站 `<meta name="referrer" content="same-origin">`，跨域请求不带 Referer，绕过多数防盗链。
2. **浏览器直接拉取为 Blob**：
   - 中转地址（`/v1/download/video?token=`）走 `fetch` + `ReadableStream`，带进度；断线后用 `Range` + `If-Range`（ETag / Last-Modified）续传一次。
   - 其他地址走 `XMLHttpRequest`（`responseType: blob`）。
   - 超时 5 分钟；响应是 `text/html` 或 `application/json` 视为失败。
3. **失败回退代理**：`POST /api/download-proxy-url {url, sourceUrl, type}` 换一个中转 URL 再下。
4. **token 里藏原始地址**：中转 URL 的 `token` 是 base64url JSON（`b`/`d` 互换做了轻度混淆），含 `{url, ts}`；全部失败时把原始直链展示给用户手动打开。
5. **保存**：读文件头魔数判断真实类型（如 `ftyp heic`）决定扩展名，`URL.createObjectURL` + `<a download>` 触发保存。
6. **体积上限**：默认 500 MB，超出提示用户复制链接到新标签页下载。
7. **批量 ZIP**：全部拉成 Blob 后用 JSZip（DEFLATE level 6）打包，FileSaver 保存，附一份「下载报告.txt」；多清晰度时先弹窗统一选择清晰度。
8. **埋点**：每次下载的阶段（request/prepare/save）、结果、错误码上报到 `/api/download-events`。

## 6. 音频提取与视频压缩 [代码]

- `@ffmpeg/ffmpeg` 0.12.10，worker 与 core JS 同源托管（`/ffmpeg/0.12.10-v3/`）。
- wasm 多源下载并按地区择优：自有中转 → 腾讯云 COS → jsDelivr；存入 Cache Storage（`ffmpeg-core-v0.12.10`），二次打开直接读缓存；加载总超时 60 秒。
- 音频提取命令：`-i input -vn -acodec libmp3lame -ab ... -ar ... -ac ...`（MP3）或输出 WAV；全程在浏览器内，不上传。
- 输入链接模式：先走同一套解析协议拿到视频直链，再下载到内存后转码；跨域失败则提示用户改用上传。
- 视频压缩：先 `-i` 探测时长与音轨，再按预设目标体积计算视频/音频码率，`libx264 -preset veryfast -pix_fmt yuv420p` + `aac`，带缩放与帧率上限滤镜，编码超时 5 分钟。

## 7. 防刷、配额与变现

**防刷** [代码 + 后台文案]

- 一次性票据 + `parse_sid` 会话 Cookie + 请求体绑定
- IP 秒级限流、IP 日限额
- 脚本特征打分自动封禁：脚本 UA、缺失 UA、缺失 Accept、缺失 Origin/Referer、缺失 Sec-Fetch 头、匿名重复请求且无会话；三档预设（宽松/标准/严格），当日阶梯加时
- 手动封禁/解封、封禁历史、Redis 存储（`redisAvailable` 字段）
- 协议档案轮换：路由名与字段名带随机后缀（`970b03`），支持新旧档案并存过渡
- 维护开关 `/api/maintenance-mode` [实测]：全站开关 + 按平台开关（当前 youtube、x、threads 处于维护）

**配额与付费**

- 匿名每日 10 次；登录后按会员/积分
- `/api/parse-entitlement-status` 返回报价 [实测]：`showQuote`、`tiers.standard/hd` 的 `baseCost/chargeCost/memberFree/freeRemaining`、`balance`、`quoteToken`。Instagram、Facebook 需要解析点数（新用户送 20 点，每日送 10 体验点）
- 清晰度档位 `standard` / `hd`，高清拿不到时自动降级并在响应里注明 `qualityFallback`
- 看广告解锁：微信小程序码（`/api/wxqrcode`）、App 二维码（`/api/reward-qrcode`），扫码看激励广告后解锁时长或次数，前端轮询权益状态
- 付费功能门禁 `/api/paid-feature-access`（小红书原图、更多尺寸等）

**广告与导流**

- AdSense 展示频率由 localStorage 计数控制（前 5 次每次、之后逐步稀疏、每日上限 15）
- SCM 运营位：`ops.kukutool.com/api/scm/content?lang=&slots=`，位置键如 `kuku-home_top_notify`、`kuku-home_input_link`、`kuku-home_banner`、`kuku-home_after_success_alert`、`kuku-home_immediate_alert`，支持「第 N 次成功后弹窗」
- App / 小程序横幅、iOS 下载成功弹窗、批量解析推广（单日 8 次或 7 天内活跃 3 天且成功 20 次才展示）

**身份与会话**

- 匿名 ID `uwx_id`：前端生成，存 localStorage（有降级存储）
- 登录态：账号中心登录后带 `?auth_code=` 跳回，`POST /api/user-session {code}` 换 `session_id`，存 localStorage `auth_session`，后续请求带 `X-Auth-Session`
- 本地计数：`successCount`、`totalSuccessCount`、`firstSuccessDate`（随解析请求上报，按北京时间跨日清零）

## 8. 接口清单

| 接口 | 方法 | 用途 |
|---|---|---|
| `/api/auth-970b03` | POST | 取解析票据 [实测] |
| `/api/parse` | POST | 解析（加密请求/响应）[实测] |
| `/api/parse-entitlement-status` | GET/POST | 报价、额度、解锁状态 [实测] |
| `/api/more-size` | POST | 更多尺寸/原图（头 `X-More-Size-Token`） |
| `/api/download-proxy-url` | POST | 换取中转下载地址 |
| `/api/download-events` | POST | 下载埋点 |
| `/api/paid-feature-access` | POST | 付费功能校验/消耗 |
| `/api/wxqrcode`、`/api/reward-qrcode`、`/api/reward-qr-event` | GET/POST | 看广告解锁二维码与事件 |
| `/api/user-session` | GET/POST | 会话查询、auth_code 换会话 [实测] |
| `/api/maintenance-mode` | GET | 维护状态 [实测] |
| `/api/batch-promotion/events` | POST | 批量推广埋点 |
| `/getip/geoip[?minimal=1]` | GET | IP 与国家码 [实测] |
| `ops…/api/scm/content`、`/api/scm/event` | GET/POST | 运营位内容与曝光点击 [实测] |
| `ops…/api/events/parse`、`/api/events/ultra-hd` | POST | 解析回执、超清事件（`X-Ops-Signature` 签名） |
| `/account/user/api/parse-stat`、`/conversion/track`、`/conversion/funnel` | POST | 解析统计与转化漏斗 |

## 9. 未能确认的部分

- **服务端各平台解析逻辑**：完全不可见。「130+ 平台」[推断] 是自研头部平台解析器 + yt-dlp 一类通用方案兜底，无证据。
- `/api/download-proxy-url` 与 `/api/more-size` 的真实响应：未探测（前者需有效媒体地址，后者需付费权益）。
- 中转下载服务如何处理各平台防盗链（Referer/UA/Cookie 注入）：服务端行为，不可见。
- 账号中心（`/account`）内部：登录方式、支付渠道、积分规则未分析。
- 管理后台只看到了文案，未看到接口实现。
- 小红书独立页、`/batch` 页的专属 chunk 未逐行阅读，结论基于首页共享模块。

## 10. 复刻建议

**工作量分布**：前端与协议约占三成，服务端解析器与持续维护占七成。各平台接口和签名算法频繁变化，这是长期成本。

**建议的最小可用版本**

1. Next.js + next-intl + Tailwind：首页输入框、结果区、平台落地页
2. `/api/parse`：服务端识别平台 → 调对应解析器 → 返回统一结构 `{title, type, cover, url, videos[], pics[]}`（沿用其结构即可）
3. 解析器：先做 3–5 个头部平台（抖音、快手、小红书、B 站、微博），其余用 yt-dlp 兜底
4. 下载：`referrer` 设为 `same-origin`/`no-referrer` + 浏览器 Blob 下载；加一个服务端流式代理接口处理跨域与防盗链失败的情况
5. 批量 ZIP：JSZip + FileSaver
6. 基础限流：IP + Redis 计数

**第二阶段**

- 票据 + 加密协议、脚本特征封禁、管理后台
- ffmpeg.wasm 音频提取与压缩（需要配置 COOP/COEP 或使用单线程 core，并自托管 wasm）
- 账号、积分、会员、广告解锁
- 运营位系统、埋点

**需要你决定的事项**

- 解析器是自研、基于开源项目，还是购买第三方解析 API
- 是否需要账号/付费体系，还是只做免费工具
- 目标平台范围与优先级
- 部署环境（中转下载的带宽成本很高，是否做中转直接影响成本）

**合规提示**：该类工具涉及各平台服务条款与内容版权，目标站自身也声明「不存储任何视频及图片」并保留了平台维护开关；上线前建议评估目标市场的合规风险。

## 附：分析产物位置

- 格式化后的前端 JS：`/tmp/kuku/pretty/`（关键文件：`4873-*.js` 协议、`7039-*.js` 首页、`7576-*.js` 下载、`2705-*.js` 批量与压缩、`3052.*.js` 解密、`1631.*.js` ffmpeg）
- 中文文案全集：`/tmp/kuku/messages.zh.json`
- 协议验证脚本与样例结果：`/tmp/kuku/probe/probe.mjs`、`/tmp/kuku/probe/data.json`

以上在系统临时目录，重启后可能丢失，需要保留请告知。
