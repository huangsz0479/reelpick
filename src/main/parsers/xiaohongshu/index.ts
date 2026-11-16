import type { ImageItem, MediaItem, MediaResult, StreamRef, VideoVariant } from '@shared/types'
import { ParseError } from '../../errors'
import { DESKTOP_UA } from '../http'
import { qualityLabel } from '../quality'
import type { ParseContext, Parser } from '../types'

const SHORT_HOST = /(^|\.)xhslink\.com$/
/** 笔记页本身，以及打不开时跳转到的 404 页和登录页 */
const NOTE_PAGE = /^https?:\/\/www\.xiaohongshu\.com\/(explore\/|discovery\/item\/|404|login|website-login)/
const HEADERS = { 'User-Agent': DESKTOP_UA, Referer: 'https://www.xiaohongshu.com/' }
/** 原图，可能是 JPEG 也可能是 PNG，响应头里的类型不可靠 */
const ORIGINAL_HOST = 'https://sns-img-bd.xhscdn.com/'
/** 按原尺寸转成 JPEG，比原图小 */
const JPEG_HOST = 'https://ci.xiaohongshu.com/'

interface Stream {
  masterUrl?: string
  backupUrls?: string[]
  width?: number
  height?: number
  size?: number
  videoCodec?: string
}
/** 键是编码名：h264 / h265 / av1 / h266，部分会话里是 EF4 / EF5 / EF6 / EF7 */
type StreamMap = Record<string, Stream[] | null | undefined>
interface NoteImage {
  fileId?: string
  width?: number
  height?: number
  urlDefault?: string
  livePhoto?: boolean
  stream?: StreamMap
}
interface Note {
  noteId?: string
  type?: string
  title?: string
  desc?: string
  user?: { nickname?: string }
  imageList?: NoteImage[] | null
  video?: { capa?: { duration?: number }; media?: { stream?: StreamMap } }
}
interface InitialState {
  note?: { noteDetailMap?: Record<string, { note?: Note } | undefined> }
}

export function extractNoteId(url: URL): string | null {
  return /^\/(?:explore|discovery\/item|user\/profile\/[^/]+)\/([0-9a-f]{24})(?:\/|$)/.exec(url.pathname)?.[1] ?? null
}

/** 页面把数据写在 window.__INITIAL_STATE__ 里，是带 undefined 的 JS 对象字面量 */
export function parseInitialState(html: string): InitialState | null {
  const source = /window\.__INITIAL_STATE__=(.*?)<\/script>/s.exec(html)?.[1]
  if (!source) return null
  try {
    return JSON.parse(source.replace(/(?<=[:[,])undefined(?=[,}\]])/g, 'null')) as InitialState
  } catch {
    return null
  }
}

const https = (url: string) => url.replace(/^http:/, 'https:')
const codecName = (key: string, s: Stream) =>
  /h264|avc|EF4/i.test(`${key} ${s.videoCodec}`) ? 'H.264' : /h265|hevc|EF5/i.test(`${key} ${s.videoCodec}`) ? 'HEVC' : key.toUpperCase()
const streamRef = (s: Stream): StreamRef => ({ url: https(s.masterUrl!), backupUrls: s.backupUrls?.map(https) })
const playable = (streams: StreamMap | undefined) =>
  Object.entries(streams ?? {}).flatMap(([key, list]) => (list ?? []).filter((s) => s.masterUrl).map((s) => ({ s, codec: codecName(key, s) })))

function buildVariants(streams: StreamMap | undefined): VideoVariant[] {
  // 每个清晰度优先 H.264（兼容性最好），该清晰度只有 HEVC 时才用 HEVC
  const best = new Map<string, { s: Stream; codec: string }>()
  for (const entry of playable(streams)) {
    const label = qualityLabel(entry.s.width, entry.s.height)
    const current = best.get(label)
    const isH264 = entry.codec === 'H.264'
    const currentIsH264 = current?.codec === 'H.264'
    if (!current || (isH264 && !currentIsH264) || (isH264 === currentIsH264 && (entry.s.size ?? 0) > (current.s.size ?? 0)))
      best.set(label, entry)
  }
  return [...best]
    .map(([label, { s, codec }]): VideoVariant => ({ id: label, label, width: s.width, height: s.height, codec, size: s.size, video: streamRef(s) }))
    .sort((a, b) => (parseInt(b.label) || 0) - (parseInt(a.label) || 0))
}

/** 读文件开头几个字节判断原图格式；HEIC 等不通用的格式和判断不了的都返回 null，改用 JPEG */
async function sniffExt(url: string, ctx: ParseContext): Promise<string | null> {
  try {
    const res = await ctx.fetch(url, { headers: { ...HEADERS, Range: 'bytes=0-15' }, signal: AbortSignal.timeout(8000) })
    if (!res.ok) return null
    const head = Buffer.from(await res.arrayBuffer()).subarray(0, 16)
    if (head[0] === 0xff && head[1] === 0xd8) return 'jpg'
    if (head.subarray(0, 4).toString('latin1') === '\x89PNG') return 'png'
    if (head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp'
    if (head.subarray(0, 3).toString('latin1') === 'GIF') return 'gif'
    return null
  } catch {
    return null
  }
}

async function buildImages(images: NoteImage[], ctx: ParseContext): Promise<ImageItem[]> {
  const items = await Promise.all(
    images.map(async (img, index): Promise<ImageItem | null> => {
      const preview = img.urlDefault ? https(img.urlDefault) : undefined
      let image: StreamRef
      let ext = 'jpg'
      if (img.fileId) {
        const original = ORIGINAL_HOST + img.fileId
        const jpeg = `${JPEG_HOST}${img.fileId}?imageView2/2/w/0/format/jpg`
        const sniffed = await sniffExt(original, ctx)
        if (sniffed) {
          ext = sniffed
          image = { url: original, backupUrls: sniffed === 'jpg' ? [jpeg] : undefined }
        } else image = { url: jpeg }
      } else if (preview) {
        image = { url: preview }
        ext = 'webp'
      } else return null
      const live = img.livePhoto ? playable(img.stream) : []
      const liveStream = (live.find((l) => l.codec === 'H.264') ?? live[0])?.s
      return {
        kind: 'image',
        id: String(index + 1),
        image,
        preview,
        ext,
        width: img.width,
        height: img.height,
        liveVideo: liveStream && streamRef(liveStream)
      }
    })
  )
  return items.filter((i) => i !== null)
}

const clean = (text: string | undefined) =>
  (text ?? '').replace(/#([^#[\n]+)\[话题\]#/g, '#$1').replace(/\s+/g, ' ').trim()

export async function fromNote(note: Note, id: string, sourceUrl: string, ctx: ParseContext): Promise<MediaResult> {
  let items: MediaItem[]
  if (note.type === 'video') {
    const variants = buildVariants(note.video?.media?.stream)
    if (variants.length === 0)
      throw new ParseError('platform_changed', '小红书没有返回可下载的视频地址，解析规则可能已变化', 'xiaohongshu')
    items = [{ kind: 'video', id, duration: note.video?.capa?.duration, variants }]
  } else {
    items = await buildImages(note.imageList ?? [], ctx)
    if (items.length === 0)
      throw new ParseError('platform_changed', '小红书没有返回可下载的图片地址，解析规则可能已变化', 'xiaohongshu')
  }
  const cover = note.imageList?.[0]?.urlDefault
  return {
    platform: 'xiaohongshu',
    id,
    title: clean(note.title) || clean(note.desc?.split('\n')[0]) || `小红书笔记 ${id}`,
    author: note.user?.nickname,
    cover: cover && https(cover),
    sourceUrl,
    items,
    headers: HEADERS
  }
}

export const xiaohongshu: Parser = {
  platform: 'xiaohongshu',

  match: (url) => /(^|\.)xiaohongshu\.com$/.test(url.hostname) || SHORT_HOST.test(url.hostname),

  async parse(input, ctx): Promise<MediaResult> {
    let url = input
    if (SHORT_HOST.test(url.hostname)) {
      try {
        url = new URL(await ctx.finalUrl(url.href, { 'User-Agent': DESKTOP_UA }))
      } catch {
        throw new ParseError('network', '短链接打不开，请检查网络后重试', 'xiaohongshu')
      }
      if (!extractNoteId(url))
        throw new ParseError('not_found', '这个短链接已经失效，请在小红书里重新点「分享 → 复制链接」', 'xiaohongshu')
    }
    const id = extractNoteId(url)
    if (!id) throw new ParseError('unsupported', '没有在链接里找到小红书笔记编号，请粘贴单篇笔记的分享链接', 'xiaohongshu')

    // 链接里的 xsec_token 等参数是访问凭证，必须原样带上；笔记数据直接写在页面 HTML 里
    const pageUrl = `https://www.xiaohongshu.com/explore/${id}${url.search}`
    let html: string
    try {
      html = await ctx.capturePage(pageUrl, NOTE_PAGE)
    } catch {
      throw new ParseError('network', '小红书页面打不开，请检查网络后重试', 'xiaohongshu')
    }
    const state = parseInitialState(html)
    if (!state?.note) throw new ParseError('platform_changed', '小红书页面里没有找到笔记数据，解析规则可能已变化', 'xiaohongshu')
    const details = state.note.noteDetailMap ?? {}
    const note = (details[id] ?? Object.values(details)[0])?.note
    if (note) return fromNote(note, id, pageUrl, ctx)

    if (!html.includes('页面不见了'))
      throw new ParseError('login_required', '小红书要求登录后才能查看这篇笔记，请登录后重试', 'xiaohongshu')
    throw new ParseError(
      'not_found',
      url.searchParams.has('xsec_token')
        ? '笔记打不开：可能已被删除、设为私密，或链接已过期。请在小红书里重新复制分享链接'
        : '这个链接缺少访问凭证（xsec_token），小红书不允许直接打开。请在小红书里点「分享 → 复制链接」后重新粘贴',
      'xiaohongshu'
    )
  }
}
