import { randomUUID } from 'node:crypto'
import { session, WebContentsView, type BrowserWindow } from 'electron'
import { CHANNELS } from '@shared/api'
import { BROWSER_PANEL, BROWSER_SIDEBAR, BROWSER_TOOLBAR, type BrowserState, type SniffedResource } from '@shared/browser'
import type { DownloadRequest, DownloadTask } from '@shared/types'
import { CAPTURE_PARTITION, watchRequests } from './browser-capture'
import { ParseError } from './errors'
import { resolveHls } from './parsers/m3u8'
import { addressToUrl, classifyResponse, resourceKey, type MediaHit } from './sniff'

/** 列表里最多保留这么多个，再多就丢掉最早的 */
const MAX_RESOURCES = 100
/** 记着请求头、还没等到响应的请求超过这个数就清空：失败的请求不会有响应 */
const MAX_PENDING = 2_000
/** Chromium 的“请求被取消”，用户点了停止或又打开了别的网页，不算打不开 */
const ERR_ABORTED = -3

// Electron 默认的 User-Agent 带着 Electron 和应用名，一些网站会因此拒绝播放
const OS_TOKEN = process.platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10_15_7' : 'Windows NT 10.0; Win64; x64'
const USER_AGENT = `Mozilla/5.0 (${OS_TOKEN}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome?.split('.')[0]}.0.0.0 Safari/537.36`

export interface SniffBrowserDeps {
  /** 主窗口：网页叠在它的「浏览网页」页面上 */
  window: () => BrowserWindow | null
  enqueue: (request: DownloadRequest) => DownloadTask
}

interface Entry {
  resource: SniffedResource
  /** 下载它要带的请求头 */
  headers: Record<string, string>
}

interface Open {
  win: BrowserWindow
  view: WebContentsView
  /** 打开过网页之后网页才显示出来，之前那块地方是界面的使用说明 */
  started: boolean
  /** 网页里的视频进了全屏 */
  fullscreen: boolean
  error?: string
}

const headerOf = (headers: Record<string, string>, name: string) => headers[Object.keys(headers).find((k) => k.toLowerCase() === name) ?? '']

/**
 * 主窗口里的「浏览网页」页面：用户在里面正常浏览和播放，页面请求里出现的视频（m3u8、视频文件）持续列出来供下载。
 * 网页和登录窗口、页面抓取共用一个会话，在这里登录过的网站对解析同样生效。
 */
export class SniffBrowser {
  private current: Open | null = null
  private entries = new Map<string, Entry>()
  /** 正在读取的 m3u8，读完才进列表 */
  private resolving = new Set<string>()
  /** 各个主列表里列出的清晰度地址：播放器会再请求它们，不算独立的视频 */
  private listed = new Set<string>()
  private sent = new Map<string, Record<string, string>>()
  /** 清空列表或关掉窗口后加一，之前开始读取的 m3u8 就不再进列表 */
  private generation = 0
  /** 界面是否停在「浏览网页」页面上 */
  private visible = false
  /** 右边「找到的视频」是否展开 */
  private panel = true

  constructor(private deps: SniffBrowserDeps) {}

  /** 离开「浏览网页」页面后网页继续开着（找到的视频不丢），只是藏起来并静音 */
  setVisible(visible: boolean, panel: boolean): void {
    this.visible = visible
    this.panel = panel
    this.layout()
    this.apply()
  }

  navigate(address: string): void {
    const url = addressToUrl(address)
    const open = this.current ?? this.create()
    if (!url || !open) return
    if (!open.started) {
      open.started = true
      open.win.contentView.addChildView(open.view)
      this.layout()
      this.apply()
    }
    this.load(() => open.view.webContents.loadURL(url).catch(() => {}))
    open.view.webContents.focus()
  }

  back(): void {
    this.load((wc) => wc.navigationHistory.goBack())
  }

  forward(): void {
    this.load((wc) => wc.navigationHistory.goForward())
  }

  reload(): void {
    this.load((wc) => wc.reload())
  }

  stop(): void {
    this.current?.view.webContents.stop()
  }

  clear(): void {
    this.generation++
    this.entries.clear()
    this.resolving.clear()
    this.listed.clear()
    this.push()
  }

  /** 登录后才能看的视频要带上网站的 Cookie：下载走的是另一套网络栈，不会自己带 */
  async download(resourceId: string, variantId: string): Promise<string | null> {
    const entry = [...this.entries.values()].find((e) => e.resource.id === resourceId)
    const variant = entry?.resource.variants.find((v) => v.id === variantId)
    if (!entry || !variant || entry.resource.error) return null
    const { resource } = entry
    const cookies = await session.fromPartition(CAPTURE_PARTITION).cookies.get({ url: variant.video.url })
    const cookie = cookies.map((c) => `${c.name}=${c.value}`).join('; ')
    const task = this.deps.enqueue({
      platform: 'web',
      title: resource.title,
      label: variant.label,
      fileName: resource.title,
      ext: variant.hls ? 'mp4' : resource.ext,
      headers: { ...entry.headers, ...(cookie ? { Cookie: cookie } : {}) },
      source: variant.video,
      audio: variant.audio,
      expectedSize: variant.size,
      hls: variant.hls,
      duration: resource.duration
    })
    return task.id
  }

  state(): BrowserState {
    const open = this.current
    const wc = open?.started ? open.view.webContents : null
    return {
      url: wc?.getURL() ?? '',
      title: wc?.getTitle() ?? '',
      loading: wc?.isLoading() ?? false,
      canGoBack: wc?.navigationHistory.canGoBack() ?? false,
      canGoForward: wc?.navigationHistory.canGoForward() ?? false,
      error: open?.error,
      resources: [...this.entries.values()].map((e) => e.resource).reverse()
    }
  }

  /** 第一次打开网页时才创建，跟着主窗口一起销毁 */
  private create(): Open | null {
    const win = this.deps.window()
    if (!win) return null
    const view = new WebContentsView({ webPreferences: { partition: CAPTURE_PARTITION } })
    const open: Open = (this.current = { win, view, started: false, fullscreen: false })
    const wc = view.webContents
    wc.setUserAgent(USER_AGENT)
    // 新窗口一律在当前网页里打开，不弹出广告窗口
    wc.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) void wc.loadURL(url).catch(() => {})
      return { action: 'deny' }
    })
    // 网页想拉起别的应用（自定义协议）时不跟过去
    wc.on('will-navigate', (event) => {
      if (!/^https?:\/\//i.test(event.url)) event.preventDefault()
    })
    const push = () => this.push()
    wc.on('did-start-loading', push)
    wc.on('did-stop-loading', push)
    wc.on('did-navigate', push)
    wc.on('did-navigate-in-page', push)
    wc.on('page-title-updated', push)
    // 打不开之后 Chromium 还会载入一张自己的空白错误页，它不算打开了新网页
    wc.on('did-start-navigation', (event) => {
      if (event.isMainFrame && !event.isSameDocument && /^https?:/i.test(event.url)) this.setError(undefined)
    })
    wc.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
      if (isMainFrame && code !== ERR_ABORTED) this.setError(`这个网页打不开（${description}），请检查网址和网络后重试`)
    })
    // 网页里的视频全屏时网页占满整个窗口
    wc.on('enter-html-full-screen', () => this.setFullscreen(true))
    wc.on('leave-html-full-screen', () => this.setFullscreen(false))

    const unwatch = watchRequests(wc.id, (url, requestHeaders, _type, response) => {
      if (requestHeaders) {
        if (this.sent.size >= MAX_PENDING) this.sent.clear()
        this.sent.set(url, requestHeaders)
        return
      }
      const sent = this.sent.get(url) ?? {}
      this.sent.delete(url)
      const hit = response && classifyResponse(url, response.status, response.headers)
      if (hit) this.found(url, hit, sent)
    })
    const layout = () => this.layout()
    win.on('resize', layout)
    win.once('closed', () => {
      unwatch()
      // 网页不会跟着窗口一起销毁，不关掉的话视频会在后台继续播放
      wc.close()
      this.current = null
      this.sent.clear()
      this.clear()
    })
    return open
  }

  private apply(): void {
    const open = this.current
    if (!open) return
    // 打不开时把网页藏起来，露出下面界面里的错误说明
    open.view.setVisible(this.visible && open.started && !open.error)
    open.view.webContents.setAudioMuted(!this.visible)
  }

  private load(action: (wc: Electron.WebContents) => void): void {
    if (!this.current?.started) return
    this.setError(undefined)
    action(this.current.view.webContents)
  }

  private setError(error: string | undefined): void {
    const open = this.current
    if (!open || open.error === error) return
    open.error = error
    this.apply()
    this.push()
  }

  private setFullscreen(fullscreen: boolean): void {
    if (!this.current) return
    this.current.fullscreen = fullscreen
    this.layout()
  }

  private layout(): void {
    const open = this.current
    if (!open) return
    const [width = 0, height = 0] = open.win.getContentSize()
    open.view.setBounds(
      open.fullscreen
        ? { x: 0, y: 0, width, height }
        : {
            x: BROWSER_SIDEBAR,
            y: BROWSER_TOOLBAR,
            width: Math.max(0, width - BROWSER_SIDEBAR - (this.panel ? BROWSER_PANEL : 0)),
            height: Math.max(0, height - BROWSER_TOOLBAR)
          }
    )
  }

  private push(): void {
    const wc = this.current?.win.webContents
    if (wc && !wc.isDestroyed()) wc.send(CHANNELS.browserChanged, this.state())
  }

  private found(url: string, hit: MediaHit, sent: Record<string, string>): void {
    const wc = this.current?.view.webContents
    const key = resourceKey(url, hit.kind)
    if (!wc || this.entries.has(key) || this.resolving.has(key) || this.listed.has(url)) return
    const pageUrl = wc.getURL()
    const referer = headerOf(sent, 'referer') ?? pageUrl
    const origin = headerOf(sent, 'origin')
    // 很多视频服务器只认来自原网页的请求。只带来源站点：Electron 的 net.fetch 会拒绝带路径的跨站 Referer
    const headers: Record<string, string> = {
      'User-Agent': headerOf(sent, 'user-agent') ?? USER_AGENT,
      ...(URL.canParse(referer) ? { Referer: `${new URL(referer).origin}/` } : {}),
      ...(origin ? { Origin: origin } : {})
    }
    const resource: SniffedResource = {
      id: randomUUID(),
      kind: hit.kind,
      url,
      title: wc.getTitle().trim() || `${new URL(url).hostname} 的视频`,
      pageUrl,
      ext: hit.kind === 'file' ? hit.ext : 'mp4',
      variants: hit.kind === 'file' ? [{ id: 'file', label: hit.ext.toUpperCase(), size: hit.size, video: { url } }] : []
    }
    if (hit.kind === 'file') return this.add(key, { resource, headers })

    const generation = this.generation
    this.resolving.add(key)
    // 用网页所在的会话读取，网站的 Cookie 会自动带上
    const ses = session.fromPartition(CAPTURE_PARTITION)
    resolveHls(url, headers, { fetch: (input, init) => ses.fetch(input, init) })
      .then(
        (source) => {
          resource.duration = source.duration || undefined
          resource.variants = source.variants
          return source.variantUrls
        },
        (error: unknown) => {
          resource.error = error instanceof ParseError ? error.message : '这个视频流读取失败，可以刷新网页再试一次'
          return []
        }
      )
      .then((variantUrls) => {
        if (generation !== this.generation) return
        this.resolving.delete(key)
        for (const variant of variantUrls) {
          this.listed.add(variant)
          this.entries.delete(variant)
        }
        if (this.listed.has(url)) this.push()
        else this.add(key, { resource, headers })
      })
  }

  private add(key: string, entry: Entry): void {
    this.entries.set(key, entry)
    for (const oldest of this.entries.keys()) {
      if (this.entries.size <= MAX_RESOURCES) break
      this.entries.delete(oldest)
    }
    this.push()
  }
}
