import type { MediaResult, Platform } from '@shared/types'

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export interface ParseContext {
  fetch: FetchLike
  /** 跟随跳转并返回最终地址，用于还原短链接 */
  finalUrl: (url: string, headers: Record<string, string>) => Promise<string>
  /** 用真实浏览器页面打开 pageUrl，返回页面发出的、地址匹配 pattern 的请求的响应体 */
  capturePage: (pageUrl: string, pattern: RegExp) => Promise<string>
  /** 用真实浏览器页面打开 pageUrl（含其中的 iframe），返回页面标题和它发出的、地址或响应类型匹配的请求 */
  sniffPage: (pageUrl: string, match: SniffMatch, options?: { manual?: boolean }) => Promise<SniffedPage>
  /** 用户选择自己在窗口里操作网页（登录、点播放），而不是全自动识别 */
  manual?: boolean
  /** 各平台的登录 Cookie，可选 */
  cookies?: Partial<Record<Platform, string>>
}

export interface SniffMatch {
  url: RegExp
  /** 响应的 Content-Type，用来识别地址里看不出类型的资源 */
  mime?: RegExp
}

export interface SniffedPage {
  title: string
  requests: { url: string; headers: Record<string, string> }[]
}

export interface Parser {
  platform: Platform
  match(url: URL): boolean
  parse(url: URL, ctx: ParseContext): Promise<MediaResult>
}
