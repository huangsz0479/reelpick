import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeTheme, net, protocol, shell, type BrowserWindowConstructorOptions } from 'electron'
import ffmpegStatic from 'ffmpeg-static'
import { CHANNELS } from '@shared/api'
import { parsePreviewUrl, PREVIEW_SCHEME } from '@shared/preview'
import type { DownloadRequest, MediaResult, Platform, Result } from '@shared/types'
import { SniffBrowser } from './browser'
import { capturePage, sniffPage } from './browser-capture'
import { DownloadManager } from './download/manager'
import { toAppError } from './errors'
import { loginCookies, openLoginWindow } from './login'
import { installMenu } from './menu'
import { parse } from './parsers'
import type { FetchLike, ParseContext } from './parsers/types'
import { SettingsStore } from './settings'

const APP_NAME = '拾影'
const isMac = process.platform === 'darwin'
/** 标题栏高度，和界面里对应的 CSS 保持一致 */
const MAIN_TITLEBAR = 52
const SETTINGS_TITLEBAR = 40
// 打包后用安装包里的图标；开发时系统显示的是 Electron 自带的，换成自己的
const devIcon = app.isPackaged ? undefined : join(import.meta.dirname, '../../build', isMac ? 'icon.png' : 'icon.ico')
/** 退出前等下载清理的最长时间，超过就不再等 */
const QUIT_CLEANUP_TIMEOUT_MS = 3_000

// net.fetch 走 Chromium 网络栈，会跟随系统代理设置
const fetchImpl: FetchLike = (input, init) => net.fetch(input, init)
// net.fetch 跳转后 response.url 为空，也不支持手动跳转，所以用 net.request 跟踪
const finalUrl = (url: string, headers: Record<string, string>) =>
  new Promise<string>((resolve, reject) => {
    const req = net.request({ url, redirect: 'manual' })
    for (const [name, value] of Object.entries(headers)) req.setHeader(name, value)
    const timer = setTimeout(() => {
      req.abort()
      reject(new Error('timeout'))
    }, 15_000)
    let current = url
    req.on('redirect', (_status, _method, redirectUrl) => {
      current = redirectUrl
      req.followRedirect()
    })
    req.on('response', () => {
      clearTimeout(timer)
      req.abort()
      resolve(current)
    })
    req.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    req.end()
  })
// 打包后二进制位于 asar 之外
const ffmpegPath = (ffmpegStatic ?? 'ffmpeg').replace('app.asar', 'app.asar.unpacked')

let window: BrowserWindow | null = null
let settingsWindow: BrowserWindow | null = null

// 必须在 app ready 之前注册；stream 让 <video> 可以按 Range 请求拖动进度。
// corsEnabled 加上响应里的跨域头，页面才能用 fetch 读到数据：音视频分流的预览要自己取分片
protocol.registerSchemesAsPrivileged([
  { scheme: PREVIEW_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }
])
/** 上游的响应头不能改，也可能已经带了跨域头：复制一份再设置，避免同一个头出现两次 */
function withCors(res: Response): Response {
  const headers = new Headers(res.headers)
  headers.set('Access-Control-Allow-Origin', '*')
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
}

/** 带上平台要求的请求头转发媒体请求，依次尝试主地址和备用地址 */
async function servePreview(request: Request): Promise<Response> {
  // 带 Range 头的 fetch 会先发预检请求
  if (request.method === 'OPTIONS')
    return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Range' } })
  const target = parsePreviewUrl(request.url)
  if (!target) return new Response(null, { status: 400 })
  const range = request.headers.get('range')
  const headers = { ...target.headers, ...(range ? { Range: range } : {}) }
  let last: Response | null = null
  for (const url of target.urls) {
    try {
      const res = await net.fetch(url, { headers, signal: request.signal })
      if (res.ok) return withCors(res)
      // 不再需要的失败响应要主动丢弃，否则连接会一直占着
      void last?.body?.cancel().catch(() => {})
      last = res
    } catch {
      // 换下一个地址
    }
  }
  return last ?? new Response(null, { status: 502 })
}

// 取值和 tokens.css 里的 --bg、--text 一致
const background = () => (nativeTheme.shouldUseDarkColors ? '#141415' : '#ffffff')
const overlay = (height: number) => ({ color: background(), symbolColor: nativeTheme.shouldUseDarkColors ? '#ededed' : '#171717', height })

/** 主窗口和设置窗口共用：同一份界面（设置窗口带查询参数）、隐藏标题栏、跟随系统深浅色 */
function openAppWindow(options: BrowserWindowConstructorOptions, titlebar: number, search?: string): BrowserWindow {
  const inset = (titlebar - 16) / 2
  const win = new BrowserWindow({
    show: false,
    backgroundColor: background(),
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    ...(isMac ? { trafficLightPosition: { x: inset, y: inset } } : { titleBarOverlay: overlay(titlebar) }),
    webPreferences: { preload: join(import.meta.dirname, '../preload/index.cjs') },
    ...(devIcon && !isMac ? { icon: devIcon } : {}),
    ...options
  })
  const syncTheme = () => {
    win.setBackgroundColor(background())
    if (!isMac) win.setTitleBarOverlay(overlay(titlebar))
  }
  nativeTheme.on('updated', syncTheme)
  win.on('closed', () => nativeTheme.off('updated', syncTheme))
  win.once('ready-to-show', () => win.show())
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event) => event.preventDefault())

  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) void win.loadURL(search ? `${devUrl}?${search}` : devUrl)
  else void win.loadFile(join(import.meta.dirname, '../renderer/index.html'), { search })
  return win
}

function createWindow(): void {
  window = openAppWindow({ width: 1180, height: 760, minWidth: 760, minHeight: 520, title: APP_NAME }, MAIN_TITLEBAR)
  window.on('closed', () => {
    window = null
    // Windows 上最后一个窗口关掉才退出应用，设置窗口不单独留着
    if (!isMac) settingsWindow?.close()
  })
}

function openSettings(): void {
  if (settingsWindow) return settingsWindow.focus()
  settingsWindow = openAppWindow(
    { width: 560, height: 220, useContentSize: true, resizable: false, minimizable: false, maximizable: false, fullscreenable: false, title: '设置' },
    SETTINGS_TITLEBAR,
    'window=settings'
  )
  settingsWindow.on('closed', () => (settingsWindow = null))
}

void app.whenReady().then(() => {
  app.setName(APP_NAME)
  if (devIcon) app.dock?.setIcon(devIcon)
  installMenu(openSettings)
  protocol.handle(PREVIEW_SCHEME, servePreview)
  const settings = new SettingsStore(join(app.getPath('userData'), 'settings.json'), {
    downloadDir: join(app.getPath('downloads'), APP_NAME)
  })
  const downloads = new DownloadManager({
    fetch: fetchImpl,
    ffmpegPath,
    downloadDir: () => settings.get().downloadDir,
    historyFile: join(app.getPath('userData'), 'downloads.json'),
    onChange: (tasks) => window?.webContents.send(CHANNELS.downloadsChanged, tasks)
  })
  const sniffer = new SniffBrowser({ window: () => window, enqueue: (request) => downloads.enqueue(request) })
  const savedFile = (id: string) => {
    const path = downloads.get(id)?.filePath
    return path && existsSync(path) ? path : null
  }
  // 下载到一半退出时先取消并清理：否则 ffmpeg 会留在后台继续下载，保存位置里也会留下 .part 文件
  let cleanedUp = false
  app.on('before-quit', (event) => {
    if (cleanedUp || !downloads.hasActive()) return
    event.preventDefault()
    cleanedUp = true
    const timeout = new Promise((resolve) => setTimeout(resolve, QUIT_CLEANUP_TIMEOUT_MS))
    void Promise.race([downloads.shutdown(), timeout]).finally(() => app.quit())
  })

  ipcMain.handle(CHANNELS.parse, async (_e, text: string, options?: { manual?: boolean }): Promise<Result<MediaResult>> => {
    try {
      const ctx: ParseContext = {
        fetch: fetchImpl,
        finalUrl,
        capturePage,
        sniffPage: (pageUrl, match, sniff) => sniffPage(pageUrl, match, { ...sniff, parent: window }),
        cookies: await loginCookies(),
        manual: options?.manual === true
      }
      return { ok: true, value: await parse(String(text), ctx) }
    } catch (e) {
      return { ok: false, error: toAppError(e) }
    }
  })
  ipcMain.handle(CHANNELS.login, (_e, platform: Platform) => openLoginWindow(platform, window))
  ipcMain.handle(CHANNELS.readClipboard, () => clipboard.readText())
  ipcMain.handle(CHANNELS.appInfo, () => ({ name: APP_NAME, version: app.getVersion() }))
  ipcMain.handle(CHANNELS.downloadsList, () => downloads.list())
  ipcMain.handle(CHANNELS.downloadsStart, (_e, request: DownloadRequest) => downloads.enqueue(request))
  ipcMain.handle(CHANNELS.downloadsCancel, (_e, id: string) => downloads.cancel(id))
  ipcMain.handle(CHANNELS.downloadsRetry, (_e, id: string) => downloads.retry(id))
  ipcMain.handle(CHANNELS.downloadsRemove, (_e, id: string) => downloads.remove(id))
  ipcMain.handle(CHANNELS.downloadsClear, () => downloads.clearFinished())
  ipcMain.handle(CHANNELS.downloadsReveal, (_e, id: string) => {
    const path = savedFile(id)
    if (path) shell.showItemInFolder(path)
    return !!path
  })
  ipcMain.handle(CHANNELS.downloadsOpen, async (_e, id: string) => {
    const path = savedFile(id)
    return !!path && (await shell.openPath(path)) === ''
  })
  ipcMain.handle(CHANNELS.settingsGet, () => settings.get())
  ipcMain.handle(CHANNELS.settingsChooseDir, async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender)
    if (!owner) return settings.get()
    const picked = await dialog.showOpenDialog(owner, {
      title: '选择保存位置',
      defaultPath: settings.get().downloadDir,
      properties: ['openDirectory', 'createDirectory']
    })
    const dir = picked.filePaths[0]
    return picked.canceled || !dir ? settings.get() : settings.update({ downloadDir: dir })
  })
  ipcMain.handle(CHANNELS.settingsOpenDir, async () => {
    const dir = settings.get().downloadDir
    await mkdir(dir, { recursive: true })
    await shell.openPath(dir)
  })
  ipcMain.handle(CHANNELS.settingsOpenWindow, () => openSettings())
  ipcMain.handle(CHANNELS.browserShow, (_e, visible: boolean, panel: boolean) => sniffer.setVisible(visible === true, panel !== false))
  ipcMain.handle(CHANNELS.browserNavigate, (_e, address: string) => sniffer.navigate(String(address)))
  ipcMain.handle(CHANNELS.browserBack, () => sniffer.back())
  ipcMain.handle(CHANNELS.browserForward, () => sniffer.forward())
  ipcMain.handle(CHANNELS.browserReload, () => sniffer.reload())
  ipcMain.handle(CHANNELS.browserStop, () => sniffer.stop())
  ipcMain.handle(CHANNELS.browserClear, () => sniffer.clear())
  ipcMain.handle(CHANNELS.browserDownload, (_e, resourceId: string, variantId: string) => sniffer.download(resourceId, variantId))
  ipcMain.handle(CHANNELS.browserState, () => sniffer.state())

  createWindow()
  app.on('activate', () => {
    if (!window) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (!isMac) app.quit()
})
