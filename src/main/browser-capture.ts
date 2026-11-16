import { BrowserWindow, session, type Session } from 'electron'
import type { SniffedPage, SniffMatch } from './parsers/types'

/** 抓取页面和登录窗口共用的会话，登录状态因此对抓取生效 */
export const CAPTURE_PARTITION = 'persist:capture'
/** 隐藏窗口里的页面弹出 alert / confirm 时，用户看不到是谁弹的，页面脚本也会一直卡到对话框关闭，所以直接禁用 */
const HIDDEN_PAGE = { disableDialogs: true }

interface ResponseEvent {
  requestId: string
  response: { url: string; status: number }
}

/**
 * 在隐藏窗口里打开页面，让页面自己的脚本发请求（签名、Cookie 都由它处理），
 * 返回第一个地址匹配 pattern 且内容非空的响应体。
 */
export async function capturePage(pageUrl: string, pattern: RegExp, timeoutMs = 25_000): Promise<string> {
  getCaptureSession()
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 800,
    webPreferences: { partition: CAPTURE_PARTITION, backgroundThrottling: false, ...HIDDEN_PAGE }
  })
  win.webContents.setAudioMuted(true)
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  const dbg = win.webContents.debugger

  try {
    await win.loadURL('about:blank')
    dbg.attach('1.3')
    await dbg.sendCommand('Network.enable')

    return await new Promise<string>((resolve, reject) => {
      const matched = new Set<string>()
      const timer = setTimeout(() => reject(new Error('timeout')), timeoutMs)
      dbg.on('message', (_event, method, params: ResponseEvent) => {
        if (method === 'Network.responseReceived') {
          if (params.response.status === 200 && pattern.test(params.response.url)) matched.add(params.requestId)
        } else if (method === 'Network.loadingFinished' && matched.has(params.requestId)) {
          dbg
            .sendCommand('Network.getResponseBody', { requestId: params.requestId })
            .then((res: { body: string; base64Encoded: boolean }) => {
              const body = res.base64Encoded ? Buffer.from(res.body, 'base64').toString() : res.body
              if (!body) return
              clearTimeout(timer)
              resolve(body)
            })
            .catch(() => {
              // 响应体可能已被回收，等下一个匹配的请求
            })
        }
      })
      // 页面可能跳转到自定义协议而报错，这不影响抓取
      win.loadURL(pageUrl).catch(() => {})
    })
  } finally {
    win.destroy()
  }
}

export interface SniffedResponse {
  status: number
  headers: Record<string, string[]>
}
/** 每个请求调用两次：发出时带请求头，开始收到响应时带响应类型和响应头 */
type Sniffer = (url: string, requestHeaders: Record<string, string> | undefined, contentType: string | undefined, response?: SniffedResponse) => void
const sniffers = new Map<number, Sniffer>()
let captureSession: Session | null = null

/** 抓取会话只装一次监听器（每个事件只能有一个），再按窗口分发；同时拒绝页面的权限请求和下载 */
function getCaptureSession(): Session {
  if (captureSession) return captureSession
  const ses = session.fromPartition(CAPTURE_PARTITION)
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  ses.on('will-download', (event) => event.preventDefault())
  ses.webRequest.onSendHeaders((details) => {
    if (details.webContentsId !== undefined) sniffers.get(details.webContentsId)?.(details.url, details.requestHeaders, undefined)
  })
  ses.webRequest.onResponseStarted((details) => {
    if (details.webContentsId === undefined) return
    const headers = details.responseHeaders ?? {}
    const name = Object.keys(headers).find((k) => k.toLowerCase() === 'content-type')
    sniffers.get(details.webContentsId)?.(details.url, undefined, name ? headers[name]?.[0] : undefined, { status: details.statusCode, headers })
  })
  return (captureSession = ses)
}

/** 持续监听一个页面（含 iframe）发出的请求，页面必须属于抓取会话。返回停止监听的函数 */
export function watchRequests(webContentsId: number, sniffer: Sniffer): () => void {
  getCaptureSession()
  sniffers.set(webContentsId, sniffer)
  return () => sniffers.delete(webContentsId)
}

/** 在页面的每个 frame 里执行：播放所有视频，并点一下常见播放器的播放按钮 */
const START_PLAYBACK = `(() => {
  document.querySelectorAll('video').forEach((v) => { v.muted = true; v.play().catch(() => {}) })
  const selectors = ['.vjs-big-play-button', '.jw-icon-display', '.jw-display-icon-container', '.plyr__control--overlaid', '.dplayer-play-icon', '.dplayer-mobile-play', '.art-state', '.art-control-playAndPause', '.xgplayer-start', '.prism-big-play-btn', '.mejs__overlay-button', '.fp-play', '.ckplayer-play', '.play-button', '.play-btn', '.playButton', '.btn-play', '#play', 'button[aria-label*="play" i]', 'button[aria-label*="播放"]', 'button[title*="play" i]', 'button[title*="播放"]']
  for (const el of document.querySelectorAll(selectors.join(','))) if (el.offsetParent !== null) { el.click(); break }
})()`
const PLAY_DELAYS_MS = [1200, 4000]
/** 页面加载完之后这么久还没找到，就不再等 */
const IDLE_AFTER_LOAD_MS = 9_000

export interface SniffOptions {
  /** 显示窗口让用户自己操作（登录、点播放），不限时，找到后自动关闭；用户关掉窗口还没找到则失败 */
  manual?: boolean
  parent?: BrowserWindow | null
}

/**
 * 打开页面，收集它（含 iframe）发出的、地址或响应类型匹配的请求。
 * 找到第一个之后再等 quietMs 没有新的就返回。默认用隐藏窗口并自动尝试播放，超时还没找到则失败。
 */
export async function sniffPage(pageUrl: string, match: SniffMatch, options: SniffOptions = {}, timeoutMs = 25_000, quietMs = 2_500): Promise<SniffedPage> {
  getCaptureSession()
  const { manual = false } = options
  const win = new BrowserWindow({
    show: manual,
    parent: (manual && options.parent) || undefined,
    width: 1280,
    height: 800,
    title: '播放一下视频，识别到后这个窗口会自动关闭',
    autoHideMenuBar: true,
    webPreferences: { partition: CAPTURE_PARTITION, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required', ...(manual ? {} : HIDDEN_PAGE) }
  })
  const wc = win.webContents
  const id = wc.id
  if (manual) win.on('page-title-updated', (event) => event.preventDefault())
  else wc.setAudioMuted(true)
  // 新窗口一律在当前窗口里打开：手动模式下用户能继续操作，自动模式下不会弹出广告窗口
  wc.setWindowOpenHandler(({ url }) => {
    if (manual && /^https?:\/\//.test(url)) void wc.loadURL(url).catch(() => {})
    return { action: 'deny' }
  })
  const sent = new Map<string, Record<string, string>>()
  const found = new Map<string, Record<string, string>>()
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const later = (fn: () => void, ms: number) => {
    const timer = setTimeout(fn, ms)
    timers.add(timer)
    return timer
  }
  let pageTitle = ''

  try {
    await new Promise<void>((resolve, reject) => {
      const giveUp = () => (found.size ? resolve() : reject(new Error('not found')))
      if (!manual) later(giveUp, timeoutMs)
      win.on('closed', giveUp)
      wc.on('page-title-updated', (_event, title) => (pageTitle = title))
      let quiet: ReturnType<typeof setTimeout> | undefined
      sniffers.set(id, (url, requestHeaders, contentType) => {
        if (requestHeaders) sent.set(url, requestHeaders)
        const hit = requestHeaders ? match.url.test(url) : !!contentType && !!match.mime?.test(contentType)
        if (!hit || found.has(url)) return
        found.set(url, sent.get(url) ?? {})
        clearTimeout(quiet)
        quiet = later(resolve, quietMs)
      })
      if (!manual) {
        const startPlayback = () => {
          if (wc.isDestroyed()) return
          for (const frame of wc.mainFrame.framesInSubtree) frame.executeJavaScript(START_PLAYBACK, true).catch(() => {})
        }
        wc.on('did-finish-load', () => {
          for (const delay of PLAY_DELAYS_MS) later(startPlayback, delay)
          later(giveUp, IDLE_AFTER_LOAD_MS)
        })
      }
      // 页面可能跳转到自定义协议而报错，这不影响抓取
      win.loadURL(pageUrl).catch(() => {})
    })
    return { title: pageTitle, requests: [...found].map(([url, headers]) => ({ url, headers })) }
  } finally {
    for (const timer of timers) clearTimeout(timer)
    sniffers.delete(id)
    if (!win.isDestroyed()) win.destroy()
  }
}
