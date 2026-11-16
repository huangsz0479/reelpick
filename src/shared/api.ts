import type { BrowserState } from './browser'
import type { AppInfo, DownloadRequest, DownloadTask, MediaResult, Platform, Result, Settings } from './types'

/** 渲染进程通过 window.api 调用的全部能力 */
export interface Api {
  platform: 'darwin' | 'win32' | 'linux'
  /** manual：识别网页视频时显示网页窗口，由用户自己播放一次 */
  parse(text: string, options?: { manual?: boolean }): Promise<Result<MediaResult>>
  /** 打开平台的登录窗口，用户关闭窗口后返回 */
  login(platform: Platform): Promise<void>
  readClipboard(): Promise<string>
  appInfo(): Promise<AppInfo>
  downloads: {
    list(): Promise<DownloadTask[]>
    start(request: DownloadRequest): Promise<DownloadTask>
    cancel(id: string): Promise<void>
    /** 重新下载失败或已取消的任务 */
    retry(id: string): Promise<void>
    remove(id: string): Promise<void>
    clearFinished(): Promise<void>
    /** 在访达 / 资源管理器中显示；文件已不存在时返回 false */
    reveal(id: string): Promise<boolean>
    open(id: string): Promise<boolean>
    onChange(listener: (tasks: DownloadTask[]) => void): () => void
  }
  settings: {
    get(): Promise<Settings>
    /** 弹出目录选择框；用户取消时返回当前设置 */
    chooseDownloadDir(): Promise<Settings>
    openDownloadDir(): Promise<void>
    /** 打开设置窗口；已经开着时把它带到最前 */
    openWindow(): Promise<void>
  }
  /** 「浏览网页」页面：在主窗口里打开网页并找出其中的视频 */
  browser: {
    /**
     * 界面布局变化时调用。visible：是否停在「浏览网页」页面上，网页只在这个页面上显示，离开后静音；
     * panel：右边「找到的视频」是否展开，收起时网页占满右侧
     */
    show(visible: boolean, panel: boolean): Promise<void>
    /** address 是地址栏里输入的内容：网址、不带协议的域名或搜索词 */
    navigate(address: string): Promise<void>
    back(): Promise<void>
    forward(): Promise<void>
    reload(): Promise<void>
    stop(): Promise<void>
    /** 清空找到的视频 */
    clear(): Promise<void>
    /** 把找到的视频的某个清晰度加入下载，返回下载任务的 id；它已经不在列表里时返回 null */
    download(resourceId: string, variantId: string): Promise<string | null>
    state(): Promise<BrowserState>
    onChange(listener: (state: BrowserState) => void): () => void
  }
}

export const CHANNELS = {
  parse: 'parse',
  login: 'login',
  readClipboard: 'clipboard:read',
  appInfo: 'app:info',
  downloadsList: 'downloads:list',
  downloadsStart: 'downloads:start',
  downloadsCancel: 'downloads:cancel',
  downloadsRetry: 'downloads:retry',
  downloadsRemove: 'downloads:remove',
  downloadsClear: 'downloads:clear',
  downloadsReveal: 'downloads:reveal',
  downloadsOpen: 'downloads:open',
  downloadsChanged: 'downloads:changed',
  settingsGet: 'settings:get',
  settingsChooseDir: 'settings:choose-dir',
  settingsOpenDir: 'settings:open-dir',
  settingsOpenWindow: 'settings:open-window',
  browserShow: 'browser:show',
  browserNavigate: 'browser:navigate',
  browserBack: 'browser:back',
  browserForward: 'browser:forward',
  browserReload: 'browser:reload',
  browserStop: 'browser:stop',
  browserClear: 'browser:clear',
  browserDownload: 'browser:download',
  browserState: 'browser:state',
  browserChanged: 'browser:changed'
} as const
