import type { VideoVariant } from './types'

/**
 * 「浏览网页」页面里界面占的位置：左边是侧栏，上面是工具栏，右边是找到的视频。
 * 主进程把网页摆在剩下的区域，界面在那里留空。侧栏和工具栏的尺寸与 App.module.css、tokens.css 的 --titlebar 一致
 */
export const BROWSER_SIDEBAR = 208
export const BROWSER_TOOLBAR = 52
export const BROWSER_PANEL = 280

/** 浏览网页时从页面请求里识别出的一个视频 */
export interface SniffedResource {
  id: string
  /** hls 是 m3u8 视频流，file 是页面直接请求的视频文件 */
  kind: 'hls' | 'file'
  url: string
  /** 识别到它时所在网页的标题，也是保存时的文件名 */
  title: string
  pageUrl: string
  /** 文件扩展名，不含点 */
  ext: string
  /** 秒 */
  duration?: number
  variants: VideoVariant[]
  /** 识别到了但下载不了的原因（直播、加密、地址拒绝访问） */
  error?: string
}

export interface BrowserState {
  /** 还没打开过网页时为空 */
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  /** 当前网页打不开的原因 */
  error?: string
  /** 新找到的排在前面 */
  resources: SniffedResource[]
}
