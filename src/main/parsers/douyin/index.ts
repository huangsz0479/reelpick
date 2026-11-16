import type { ImageItem, MediaItem, MediaResult, VideoVariant } from '@shared/types'
import { ParseError } from '../../errors'
import { DESKTOP_UA } from '../http'
import { qualityLabel } from '../quality'
import type { Parser } from '../types'

const SHORT_HOSTS = new Set(['v.douyin.com'])
const DETAIL_API = /\/aweme\/v1\/web\/aweme\/detail\//

interface Address {
  url_list?: string[]
  width?: number
  height?: number
  data_size?: number
}
interface BitRate {
  bit_rate: number
  /** 0 表示 H.264，其余为 HEVC 等新编码 */
  is_h265?: number
  play_addr?: Address
}
interface AwemeImage {
  /** 无水印地址，通常是两个 webp 加一个 jpeg */
  url_list?: string[]
  width?: number
  height?: number
  /** 实况图才有 */
  video?: { play_addr?: Address }
}
interface AwemeDetail {
  aweme_id: string
  desc?: string
  author?: { nickname?: string }
  images?: AwemeImage[] | null
  video?: {
    duration?: number
    cover?: Address
    play_addr?: Address
    bit_rate?: BitRate[] | null
  }
}
interface DetailResponse {
  status_code?: number
  aweme_detail?: AwemeDetail | null
  filter_detail?: { detail_msg?: string; notice?: string }
}

export function extractAwemeId(url: URL): string | null {
  return /\/(?:video|note)\/(\d+)/.exec(url.pathname)?.[1] ?? /^\d+$/.exec(url.searchParams.get('modal_id') ?? '')?.[0] ?? null
}

function buildVariants(video: NonNullable<AwemeDetail['video']>): VideoVariant[] {
  const streams = (video.bit_rate ?? []).filter((b) => b.play_addr?.url_list?.length)
  // 每个清晰度优先 H.264（兼容性最好），该清晰度只有其他编码时才用其他编码，
  // 这样只提供 HEVC 的 2K / 4K 档位不会被漏掉
  const best = new Map<string, BitRate>()
  for (const s of streams) {
    const label = qualityLabel(s.play_addr!.width, s.play_addr!.height)
    const current = best.get(label)
    const isH264 = s.is_h265 === 0
    const currentIsH264 = current?.is_h265 === 0
    if (!current || (isH264 && !currentIsH264) || (isH264 === currentIsH264 && s.bit_rate > current.bit_rate))
      best.set(label, s)
  }
  const variants = [...best].map(([label, s]): VideoVariant => {
    const [url, ...backupUrls] = s.play_addr!.url_list!
    return {
      id: label,
      label,
      width: s.play_addr!.width,
      height: s.play_addr!.height,
      codec: s.is_h265 === 0 ? 'H.264' : 'HEVC',
      size: s.play_addr!.data_size,
      video: { url: url!, backupUrls }
    }
  })
  if (variants.length === 0 && video.play_addr?.url_list?.length) {
    const [url, ...backupUrls] = video.play_addr.url_list
    variants.push({ id: 'default', label: qualityLabel(video.play_addr.width, video.play_addr.height), size: video.play_addr.data_size, video: { url: url!, backupUrls } })
  }
  return variants.sort((a, b) => parseInt(b.label) - parseInt(a.label))
}

const extOf = (url: string) => (/\.(jpe?g|png|webp|heic|gif)(?:$|[?~])/i.exec(url)?.[1] ?? 'jpg').toLowerCase().replace('jpeg', 'jpg')

function buildImages(images: AwemeImage[]): ImageItem[] {
  return images.flatMap((img, index): ImageItem[] => {
    const urls = img.url_list ?? []
    // JPEG 兼容性最好；没有时用第一个地址，其余同格式地址作备用
    const primary = urls.find((u) => extOf(u) === 'jpg') ?? urls[0]
    if (!primary) return []
    const ext = extOf(primary)
    const [liveUrl, ...liveBackups] = img.video?.play_addr?.url_list ?? []
    return [
      {
        kind: 'image',
        id: String(index + 1),
        image: { url: primary, backupUrls: urls.filter((u) => u !== primary && extOf(u) === ext) },
        ext,
        width: img.width,
        height: img.height,
        liveVideo: liveUrl ? { url: liveUrl, backupUrls: liveBackups } : undefined
      }
    ]
  })
}

export function fromDetail(res: DetailResponse, id: string): MediaResult {
  const detail = res.aweme_detail
  if (!detail)
    throw new ParseError('not_found', res.filter_detail?.detail_msg || res.filter_detail?.notice || '作品不存在、已被删除或设为私密', 'douyin')
  let items: MediaItem[]
  if (detail.images?.length) {
    items = buildImages(detail.images)
    if (items.length === 0)
      throw new ParseError('platform_changed', '抖音没有返回可下载的图片地址，解析规则可能已变化', 'douyin')
  } else {
    const variants = detail.video ? buildVariants(detail.video) : []
    if (variants.length === 0)
      throw new ParseError('platform_changed', '抖音没有返回可下载的视频地址，解析规则可能已变化', 'douyin')
    items = [{ kind: 'video', id, duration: detail.video?.duration ? detail.video.duration / 1000 : undefined, variants }]
  }

  return {
    platform: 'douyin',
    id,
    title: detail.desc?.replace(/\s+/g, ' ').trim() || `抖音视频 ${id}`,
    author: detail.author?.nickname,
    cover: detail.video?.cover?.url_list?.[0],
    sourceUrl: `https://www.douyin.com/${detail.images?.length ? 'note' : 'video'}/${id}`,
    items,
    headers: { 'User-Agent': DESKTOP_UA, Referer: 'https://www.douyin.com/' }
  }
}

export const douyin: Parser = {
  platform: 'douyin',

  match: (url) => /(^|\.)(douyin|iesdouyin)\.com$/.test(url.hostname),

  async parse(input, ctx): Promise<MediaResult> {
    let url = input
    if (SHORT_HOSTS.has(url.hostname)) {
      try {
        url = new URL(await ctx.finalUrl(url.href, { 'User-Agent': DESKTOP_UA }))
      } catch {
        throw new ParseError('network', '短链接打不开，请检查网络后重试', 'douyin')
      }
    }
    const id = extractAwemeId(url)
    if (!id) throw new ParseError('unsupported', '没有在链接里找到抖音作品编号，请粘贴单个作品的分享链接', 'douyin')

    // 抖音接口需要页面脚本生成的签名，所以让真实页面自己去请求
    let body: string
    try {
      body = await ctx.capturePage(`https://www.douyin.com/video/${id}`, DETAIL_API)
    } catch {
      throw new ParseError('platform_changed', '抖音页面没有返回作品数据，可能是网络问题或触发了平台验证，请稍后重试', 'douyin')
    }
    let res: DetailResponse
    try {
      res = JSON.parse(body) as DetailResponse
    } catch {
      throw new ParseError('platform_changed', '抖音返回了无法识别的内容，解析规则可能已变化', 'douyin')
    }
    return fromDetail(res, id)
  }
}
