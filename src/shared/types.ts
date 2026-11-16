/** web 指平台之外的来源：直接给出的 m3u8 地址，或从任意网页里找到的视频流 */
export type Platform = 'bilibili' | 'xiaohongshu' | 'douyin' | 'web'

export const PLATFORM_NAMES: Record<Platform, string> = {
  bilibili: 'B 站',
  xiaohongshu: '小红书',
  douyin: '抖音',
  web: '网页视频'
}

/** 「登录 B 站」「登录小红书」：平台名以西文开头时，中间加一个空格 */
export const loginLabel = (platform: Platform): string =>
  `登录${/^[A-Za-z]/.test(PLATFORM_NAMES[platform]) ? ' ' : ''}${PLATFORM_NAMES[platform]}`

export interface StreamRef {
  url: string
  backupUrls?: string[]
  /** 带 codecs 的 MIME，例如 video/mp4; codecs="avc1.640032"。音视频分流的版本要有它才能在应用内预览 */
  mime?: string
}

export interface VideoVariant {
  id: string
  label: string
  width?: number
  height?: number
  codec?: string
  size?: number
  sizeIsEstimate?: boolean
  /** video 和 audio 是 m3u8 播放列表地址，要交给 ffmpeg 拉流，不能当普通文件下载 */
  hls?: boolean
  video: StreamRef
  /** 存在时表示音视频分流，下载后需要合并 */
  audio?: StreamRef
}

export interface VideoItem {
  kind: 'video'
  id: string
  title?: string
  duration?: number
  variants: VideoVariant[]
}

export interface ImageItem {
  kind: 'image'
  id: string
  image: StreamRef
  /** 列表里显示用的小图；没有时直接用 image */
  preview?: string
  /** 文件扩展名，不含点 */
  ext: string
  width?: number
  height?: number
  /** 实况图附带的视频 */
  liveVideo?: StreamRef
}

export type MediaItem = VideoItem | ImageItem

export interface MediaResult {
  platform: Platform
  id: string
  title: string
  author?: string
  cover?: string
  sourceUrl: string
  items: MediaItem[]
  /** 下载媒体文件时需要带的请求头 */
  headers: Record<string, string>
  notice?: string
  /** 登录后能拿到更好的结果，界面据此提供登录入口 */
  loginHint?: boolean
}

export type ParseErrorCode =
  | 'no_url'
  | 'unsupported'
  | 'not_found'
  | 'login_required'
  | 'network'
  | 'platform_changed'
  /** 自动打开网页没找到视频流，可以让用户自己打开网页播放一次再识别 */
  | 'no_stream'

export interface AppError {
  code: ParseErrorCode | 'download' | 'internal'
  message: string
  platform?: Platform
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: AppError }

export type DownloadStatus = 'queued' | 'downloading' | 'merging' | 'done' | 'failed' | 'cancelled'

export type DownloadErrorCode = 'expired' | 'network' | 'server' | 'disk_full' | 'permission' | 'merge' | 'unknown'

export interface DownloadRequest {
  platform: Platform
  title: string
  /** 不含扩展名 */
  fileName: string
  ext: string
  /** 保存到下载目录下的这个子文件夹，用于一组图片 */
  subDir?: string
  headers: Record<string, string>
  source: StreamRef
  /** 存在时表示音视频分流，下载后与 source 合并 */
  audio?: StreamRef
  expectedSize?: number
  /** source 和 audio 是 m3u8 播放列表地址 */
  hls?: boolean
  /** 视频时长（秒），用来估算 m3u8 的下载进度 */
  duration?: number
  cover?: string
  label?: string
}

export interface DownloadTask {
  id: string
  platform: Platform
  title: string
  label?: string
  cover?: string
  status: DownloadStatus
  received: number
  total: number | null
  /** 字节/秒 */
  speed: number
  filePath?: string
  error?: string
  errorCode?: DownloadErrorCode
  /** 原样重试有可能成功；为 false 时需要用户先处理（例如重新解析链接）。上次运行留下的记录一律为 false */
  retryable?: boolean
  createdAt: number
}

export interface Settings {
  downloadDir: string
}

export interface AppInfo {
  name: string
  version: string
}
