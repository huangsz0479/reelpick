import { extractUrl } from './parsers'

/** 从一个响应看出来的视频：m3u8 视频流，或者直接就是视频文件 */
export type MediaHit = { kind: 'hls' } | { kind: 'file'; ext: string; size?: number }

const FILE_TYPES: Record<string, string> = {
  'video/mp4': 'mp4',
  'video/x-m4v': 'm4v',
  'video/webm': 'webm',
  'video/x-flv': 'flv',
  'video/quicktime': 'mov',
  'video/x-matroska': 'mkv'
}
const FILE_EXTS = /^(mp4|m4v|webm|flv|mov|mkv)$/
/** 服务器没说明类型时用的几种写法，这时看地址的扩展名 */
const GENERIC_TYPES = new Set(['', 'application/octet-stream', 'binary/octet-stream', 'application/force-download'])
/** 分片：m3u8 和 DASH 播放器一段一段请求的小文件，单独一个没法看 */
const SEGMENT_EXTS = /^(ts|m4s|m4a|aac|mp3|key)$/
/** 比这还小的视频文件多半是广告、动效或分片 */
const MIN_FILE_SIZE = 1024 * 1024

type Headers = Record<string, string | string[] | undefined>

function header(headers: Headers, name: string): string {
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name)
  const value = key ? headers[key] : undefined
  return (Array.isArray(value) ? value[0] : value) ?? ''
}

/** 判断页面发出的一个请求的响应是不是可以下载的视频 */
export function classifyResponse(url: string, status: number, headers: Headers): MediaHit | null {
  if (status !== 200 && status !== 206) return null
  if (!URL.canParse(url)) return null
  const parsed = new URL(url)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  const ext = /\.([a-z0-9]{2,5})$/i.exec(parsed.pathname)?.[1]?.toLowerCase() ?? ''
  const type = header(headers, 'content-type').split(';')[0]!.trim().toLowerCase()

  // 地址以 .m3u8 结尾却返回网页的，是出错页面
  if (type.includes('mpegurl') || (ext === 'm3u8' && type !== 'text/html')) return { kind: 'hls' }
  // 地址里带 range 参数的是播放器按片请求的一段（YouTube 这类没有清单的站点）
  if (SEGMENT_EXTS.test(ext) || parsed.searchParams.has('range')) return null
  const fileExt = FILE_TYPES[type] ?? (GENERIC_TYPES.has(type) && FILE_EXTS.test(ext) ? ext : undefined)
  if (!fileExt) return null

  // 播放器通常只请求文件的一部分，整个文件的大小写在 Content-Range 的斜杠后面
  const total = /\/(\d+)\s*$/.exec(header(headers, 'content-range'))?.[1]
  const size = Number(total ?? (status === 200 ? header(headers, 'content-length') : '')) || undefined
  if (size !== undefined && size < MIN_FILE_SIZE) return null
  return { kind: 'file', ext: fileExt, size }
}

/** 同一个视频只列一次。视频文件的查询参数里常有每次请求都不同的凭证，所以只看路径 */
export function resourceKey(url: string, kind: MediaHit['kind']): string {
  if (kind === 'hls') return url
  const { origin, pathname } = new URL(url)
  return origin + pathname
}

const HOST_LIKE = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}(:\d+)?(\/.*)?$/i
const LOCAL_HOST = /^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?(\/.*)?$/i

/** 地址栏里输入的内容要打开的网址：链接（含夹在分享文案里的）、不带协议的域名，其余当作搜索词 */
export function addressToUrl(input: string): string | null {
  const text = input.trim()
  if (!text) return null
  const url = extractUrl(text)
  if (url) return url.href
  if (LOCAL_HOST.test(text)) return `http://${text}`
  if (HOST_LIKE.test(text)) return `https://${text}`
  return `https://www.bing.com/search?q=${encodeURIComponent(text)}`
}
