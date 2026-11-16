import type { MediaResult, StreamRef, VideoVariant } from '@shared/types'
import { ParseError } from '../../errors'
import { DESKTOP_UA, getJson } from '../http'
import type { ParseContext, Parser } from '../types'
import { keyFromUrl, mixinKey, signWbi } from './wbi'

const API = 'https://api.bilibili.com'
const SHORT_HOSTS = new Set(['b23.tv', 'bili2233.cn'])
const AVC_CODEC_ID = 7
/** 不含登录 Cookie：下载媒体文件和还原短链接都用这一份 */
const HEADERS = { 'User-Agent': DESKTOP_UA, Referer: 'https://www.bilibili.com/' }

interface ApiResponse<T> {
  code: number
  message: string
  data?: T
}
interface ViewData {
  bvid: string
  title: string
  pic: string
  owner?: { name: string }
  pages: { cid: number; page: number; part: string; duration: number }[]
}
interface NavData {
  isLogin?: boolean
  wbi_img: { img_url: string; sub_url: string }
}
interface DashStream {
  id: number
  baseUrl: string
  backupUrl?: string[]
  bandwidth: number
  codecs: string
  codecid?: number
  width?: number
  height?: number
}
interface PlayData {
  quality: number
  accept_quality?: number[]
  accept_description?: string[]
  durl?: { url: string; backup_url?: string[]; size: number }[]
  dash?: { video: DashStream[]; audio?: DashStream[] | null }
}

export type VideoRef = { bvid: string } | { aid: string }

export function extractVideoRef(url: URL): VideoRef | null {
  const bv = /\/(BV[0-9A-Za-z]{10})/.exec(url.pathname)
  if (bv?.[1]) return { bvid: bv[1] }
  const av = /\/av(\d+)/i.exec(url.pathname)
  return av?.[1] ? { aid: av[1] } : null
}

const https = (url: string) => url.replace(/^http:/, 'https:')
/** 0 是官方的镜像 CDN，1 是其他自建节点，2 是 P2P 节点（mcdn，或者地址里带端口号） */
function cdnRank(url: string): number {
  const { hostname, port } = new URL(url)
  return port || /mcdn|mountaintoys|szbdyd/.test(hostname) ? 2 : hostname.startsWith('upos-') ? 0 : 1
}
/** 接口常把 P2P 节点排在最前面，它们又慢又不稳定：实测同一个文件比镜像 CDN 慢一个数量级。官方 CDN 提到前面，P2P 节点留作备用 */
function stream(url: string, backups?: string[] | null): StreamRef {
  const [first, ...rest] = [url, ...(backups ?? [])].sort((a, b) => cdnRank(a) - cdnRank(b))
  return { url: first!, backupUrls: rest.length ? rest : undefined }
}
/** 分流的流都是分片 MP4 */
const dashStream = (s: DashStream, kind: 'video' | 'audio'): StreamRef => ({ ...stream(s.baseUrl, s.backupUrl), mime: `${kind}/mp4; codecs="${s.codecs}"` })
/** "高清 1080P+" → "1080P+" */
const shortLabel = (desc: string | undefined, qn: number) => desc?.split(' ').pop() ?? `qn ${qn}`
/** B 站只有三类编码；杜比视界等写成 dvh1、hvc1 的也是 HEVC */
const codecName = (codecs: string) => (codecs.startsWith('avc') ? 'H.264' : codecs.startsWith('av01') ? 'AV1' : 'HEVC')

function headers(ctx: ParseContext): Record<string, string> {
  const cookie = ctx.cookies?.bilibili
  return { ...HEADERS, ...(cookie ? { Cookie: cookie } : {}) }
}

async function api<T>(ctx: ParseContext, pathAndQuery: string): Promise<T> {
  const res = await getJson<ApiResponse<T>>(ctx.fetch, 'bilibili', API + pathAndQuery, headers(ctx))
  if (res.code === 0 && res.data) return res.data
  if (res.code === -404 || res.code === 62002 || res.code === 62012)
    throw new ParseError('not_found', '视频不存在或已被删除', 'bilibili')
  if (res.code === -403 || res.code === 62004)
    throw new ParseError('login_required', '这个视频需要登录或权限才能观看', 'bilibili')
  throw new ParseError('platform_changed', `B 站接口返回错误：${res.message}（${res.code}）`, 'bilibili')
}

async function resolveShortLink(url: URL, ctx: ParseContext): Promise<URL> {
  if (!SHORT_HOSTS.has(url.hostname)) return url
  try {
    return new URL(await ctx.finalUrl(url.href, HEADERS))
  } catch {
    throw new ParseError('network', '短链接打不开，请检查网络，或改用视频页面的完整链接', 'bilibili')
  }
}

function buildVariants(play: PlayData, muxed: PlayData | null, duration: number): VideoVariant[] {
  const describe = (p: PlayData, qn: number) =>
    shortLabel(p.accept_description?.[p.accept_quality?.indexOf(qn) ?? -1], qn)
  const variants: VideoVariant[] = []

  const file = muxed?.durl?.length === 1 ? muxed.durl[0] : undefined
  if (muxed && file)
    variants.push({
      id: `mp4-${muxed.quality}`,
      label: describe(muxed, muxed.quality),
      codec: 'H.264',
      size: file.size,
      video: stream(file.url, file.backup_url)
    })

  const audio = [...(play.dash?.audio ?? [])].sort((a, b) => b.bandwidth - a.bandwidth)[0]
  const streams = play.dash?.video ?? []
  for (const qn of new Set(streams.map((s) => s.id))) {
    // 同一清晰度已有免合并的单文件时，不再重复提供分流版本
    if (muxed && file && qn === muxed.quality) continue
    const sameQuality = streams.filter((s) => s.id === qn)
    const v = sameQuality.find((s) => s.codecid === AVC_CODEC_ID) ?? sameQuality[0]
    if (!v) continue
    variants.push({
      id: `dash-${qn}`,
      label: describe(play, qn),
      width: v.width,
      height: v.height,
      codec: codecName(v.codecs),
      size: Math.round(((v.bandwidth + (audio?.bandwidth ?? 0)) * duration) / 8),
      sizeIsEstimate: true,
      video: dashStream(v, 'video'),
      audio: audio && dashStream(audio, 'audio')
    })
  }
  const quality = (v: VideoVariant) => Number(v.id.split('-')[1])
  return variants.sort((a, b) => quality(b) - quality(a))
}

export const bilibili: Parser = {
  platform: 'bilibili',

  match: (url) => /(^|\.)bilibili\.com$/.test(url.hostname) || SHORT_HOSTS.has(url.hostname),

  async parse(input, ctx): Promise<MediaResult> {
    const url = await resolveShortLink(input, ctx)
    const ref = extractVideoRef(url)
    if (!ref)
      throw new ParseError('unsupported', '暂时只支持 B 站的普通视频链接（BV 号或 av 号）', 'bilibili')

    const idQuery = 'bvid' in ref ? `bvid=${ref.bvid}` : `aid=${ref.aid}`
    const [view, nav] = await Promise.all([
      api<ViewData>(ctx, `/x/web-interface/view?${idQuery}`),
      // 未登录时 nav 的 code 是 -101，但 data 里仍然带签名用的 key
      getJson<ApiResponse<NavData>>(ctx.fetch, 'bilibili', `${API}/x/web-interface/nav`, headers(ctx))
    ])
    const wbi = nav.data?.wbi_img
    if (!wbi) throw new ParseError('platform_changed', 'B 站没有返回签名密钥，解析规则可能已变化', 'bilibili')
    const key = mixinKey(keyFromUrl(wbi.img_url), keyFromUrl(wbi.sub_url))

    const pageNo = Number(url.searchParams.get('p')) || 1
    const page = view.pages.find((p) => p.page === pageNo) ?? view.pages[0]
    if (!page) throw new ParseError('platform_changed', 'B 站没有返回视频分 P 信息', 'bilibili')

    const playurl = (params: Record<string, string | number>) =>
      api<PlayData>(
        ctx,
        `/x/player/wbi/playurl?${signWbi({ bvid: view.bvid, cid: page.cid, ...params }, key, Math.floor(Date.now() / 1000))}`
      )
    const [dash, muxed] = await Promise.all([
      playurl({ qn: 127, fnval: 4048, fnver: 0, fourk: 1 }),
      // 单文件 MP4 只是为了免合并，拿不到不影响结果
      playurl({ qn: 64, fnval: 1, platform: 'html5', high_quality: 1 }).catch(() => null)
    ])

    const variants = buildVariants(dash, muxed, page.duration)
    if (variants.length === 0)
      throw new ParseError('platform_changed', 'B 站没有返回可下载的视频地址，解析规则可能已变化', 'bilibili')

    const multiPage = view.pages.length > 1
    const notices = [
      multiPage && `这个视频共 ${view.pages.length} 个分 P，当前是第 ${page.page} 个。要下载其他分 P，请粘贴带 ?p= 的链接。`,
      !nav.data?.isLogin && '未登录 B 站账号，最高只能获取 720P。'
    ].filter(Boolean)

    return {
      platform: 'bilibili',
      id: view.bvid,
      title: multiPage ? `${view.title} - P${page.page} ${page.part}` : view.title,
      author: view.owner?.name,
      cover: https(view.pic),
      sourceUrl: `https://www.bilibili.com/video/${view.bvid}${multiPage ? `?p=${page.page}` : ''}`,
      items: [{ kind: 'video', id: String(page.cid), duration: page.duration, variants }],
      headers: HEADERS,
      notice: notices.join(' ') || undefined,
      loginHint: !nav.data?.isLogin || undefined
    }
  }
}
