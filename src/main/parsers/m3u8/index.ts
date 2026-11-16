import type { MediaResult, VideoVariant } from '@shared/types'
import { ParseError } from '../../errors'
import { DESKTOP_UA, request } from '../http'
import { qualityLabel } from '../quality'
import type { ParseContext, Parser } from '../types'
import { parsePlaylist, type HlsVariant, type MediaPlaylist } from './playlist'

export interface HlsSource {
  /** 这个地址是否为多清晰度的主列表 */
  master: boolean
  /** 主列表里列出的各清晰度地址，用来识别重复的流 */
  variantUrls: string[]
  duration: number
  variants: VideoVariant[]
}

const GENERIC_NAMES = /^(index|playlist|master|main|video|media|chunklist|prog_index|hls|stream|manifest|v\d*)$/i

async function fetchPlaylist(url: string, headers: Record<string, string>, ctx: Pick<ParseContext, 'fetch'>) {
  const res = await request(ctx.fetch, 'web', url, headers)
  if (res.status === 401 || res.status === 403)
    throw new ParseError('not_found', `视频流地址拒绝访问（HTTP ${res.status}），它可能已过期，或只允许从原网页播放`, 'web')
  if (!res.ok) throw new ParseError('not_found', `视频流地址打不开（HTTP ${res.status}），它可能已过期`, 'web')
  const playlist = parsePlaylist(await res.text(), url)
  if (!playlist) throw new ParseError('unsupported', '这个地址返回的不是 m3u8 播放列表', 'web')
  return playlist
}

function checkMedia(media: MediaPlaylist): MediaPlaylist {
  if (media.live) throw new ParseError('unsupported', '这是还在进行的直播流，目前只支持下载已结束的视频', 'web')
  if (media.encryption)
    throw new ParseError('unsupported', `这个视频用了受版权保护的加密方式（${media.encryption}），无法下载`, 'web')
  return media
}

const codecName = (codecs: string) =>
  /avc1/i.test(codecs) ? 'H.264' : /hvc1|hev1/i.test(codecs) ? 'HEVC' : /av01/i.test(codecs) ? 'AV1' : undefined

function buildVariants(list: HlsVariant[], duration: number): VideoVariant[] {
  const hasVideo = list.some((v) => v.height || codecName(v.codecs))
  const label = (v: HlsVariant) => (v.height ? qualityLabel(v.width, v.height) : v.bandwidth ? `${Math.round(v.bandwidth / 1000)}kbps` : '原画')
  // 同一清晰度优先 H.264 视频和 AAC 音频（兼容性最好），其次码率高的
  const score = (v: HlsVariant) => [codecName(v.codecs) === 'H.264' ? 1 : 0, /mp4a/i.test(v.codecs) || !v.codecs ? 1 : 0, v.bandwidth]
  const better = (a: HlsVariant, b: HlsVariant) => {
    const [sa, sb] = [score(a), score(b)]
    const i = sa.findIndex((n, k) => n !== sb[k])
    return i >= 0 && sa[i]! > sb[i]!
  }
  const best = new Map<string, HlsVariant>()
  for (const v of list) {
    // 主列表里混着的纯音频流不单独列出
    if (hasVideo && !v.height && !codecName(v.codecs)) continue
    const current = best.get(label(v))
    if (!current || better(v, current)) best.set(label(v), v)
  }
  return [...best]
    .sort(([, a], [, b]) => (b.height ?? 0) - (a.height ?? 0) || b.bandwidth - a.bandwidth)
    .map(([id, v]): VideoVariant => ({
      id,
      label: id,
      width: v.width,
      height: v.height,
      codec: codecName(v.codecs),
      size: v.bandwidth && duration ? Math.round((v.bandwidth * duration) / 8) : undefined,
      sizeIsEstimate: true,
      hls: true,
      video: { url: v.url },
      audio: v.audioUrl ? { url: v.audioUrl } : undefined
    }))
}

/** 读取一个 m3u8 地址：主列表展开成各清晰度，普通列表就是单个清晰度 */
export async function resolveHls(url: string, headers: Record<string, string>, ctx: Pick<ParseContext, 'fetch'>): Promise<HlsSource> {
  const playlist = await fetchPlaylist(url, headers, ctx)
  if (playlist.kind === 'media') {
    const { duration } = checkMedia(playlist)
    return { master: false, variantUrls: [], duration, variants: [{ id: '原画', label: '原画', hls: true, video: { url } }] }
  }
  const top = [...playlist.variants].sort((a, b) => b.bandwidth - a.bandwidth)[0]
  if (!top) throw new ParseError('unsupported', '这个 m3u8 播放列表里没有可下载的视频流', 'web')
  // 时长、是否直播、是否加密都写在具体清晰度的列表里，读码率最高的那个
  const media = await fetchPlaylist(top.url, headers, ctx)
  const duration = media.kind === 'media' ? checkMedia(media).duration : 0
  return { master: true, variantUrls: playlist.variants.map((v) => v.url), duration, variants: buildVariants(playlist.variants, duration) }
}

export function hlsResult(source: HlsSource, info: { title: string; sourceUrl: string; headers: Record<string, string>; notice?: string }): MediaResult {
  return {
    platform: 'web',
    id: info.sourceUrl,
    title: info.title,
    sourceUrl: info.sourceUrl,
    items: [{ kind: 'video', id: info.sourceUrl, duration: source.duration || undefined, variants: source.variants }],
    headers: info.headers,
    notice: info.notice
  }
}

/** 地址里有不成对的 % 时解不了码，保持原样 */
function decode(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

export function titleFromUrl(url: URL): string {
  const names = url.pathname.split('/').map((s) => decode(s).replace(/\.m3u8$/i, '')).filter(Boolean)
  const name = names.reverse().find((n) => !GENERIC_NAMES.test(n) && !/^\d{1,4}$/.test(n))
  return name ? name.slice(0, 80) : `${url.hostname} 的视频`
}

export const m3u8: Parser = {
  platform: 'web',

  match: (url) => /\.m3u8$/i.test(url.pathname),

  async parse(url, ctx): Promise<MediaResult> {
    const headers = { 'User-Agent': DESKTOP_UA }
    const source = await resolveHls(url.href, headers, ctx)
    return hlsResult(source, { title: titleFromUrl(url), sourceUrl: url.href, headers })
  }
}
