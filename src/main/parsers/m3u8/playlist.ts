/** HLS 播放列表（m3u8）的文本解析，不发请求 */

export interface HlsVariant {
  url: string
  bandwidth: number
  width?: number
  height?: number
  codecs: string
  /** 音频单独成流时的播放列表地址 */
  audioUrl?: string
}

export interface MasterPlaylist {
  kind: 'master'
  variants: HlsVariant[]
}

export interface MediaPlaylist {
  kind: 'media'
  /** 秒 */
  duration: number
  /** 没有结束标记，是还在更新的直播流 */
  live: boolean
  /** ffmpeg 解不了的加密方式，例如 SAMPLE-AES */
  encryption?: string
}

export type Playlist = MasterPlaylist | MediaPlaylist

/** 解析 `KEY=value,KEY="quoted, value"` 形式的属性表 */
export function parseAttributes(text: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  for (const m of text.matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g)) attrs[m[1]!] = m[2]!.replace(/^"|"$/g, '')
  return attrs
}

export function parsePlaylist(text: string, baseUrl: string): Playlist | null {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  if (!lines[0]?.startsWith('#EXTM3U')) return null
  const resolve = (uri: string) => new URL(uri, baseUrl).href
  const tag = (line: string, name: string) => (line.startsWith(`${name}:`) ? line.slice(name.length + 1) : null)

  if (lines.some((l) => l.startsWith('#EXT-X-STREAM-INF'))) {
    const audio = new Map<string, { url: string; isDefault: boolean }>()
    for (const line of lines) {
      const media = tag(line, '#EXT-X-MEDIA')
      if (!media) continue
      const a = parseAttributes(media)
      const group = a['GROUP-ID']
      if (a.TYPE !== 'AUDIO' || !a.URI || !group) continue
      const isDefault = a.DEFAULT === 'YES'
      if (!audio.has(group) || (isDefault && !audio.get(group)!.isDefault)) audio.set(group, { url: resolve(a.URI), isDefault })
    }
    const variants: HlsVariant[] = []
    lines.forEach((line, i) => {
      const inf = tag(line, '#EXT-X-STREAM-INF')
      const uri = lines.slice(i + 1).find((l) => !l.startsWith('#'))
      if (!inf || !uri) return
      const a = parseAttributes(inf)
      const [width, height] = (a.RESOLUTION ?? '').split('x').map(Number)
      variants.push({
        url: resolve(uri),
        bandwidth: Number(a['AVERAGE-BANDWIDTH'] ?? a.BANDWIDTH) || 0,
        width: width || undefined,
        height: height || undefined,
        codecs: a.CODECS ?? '',
        audioUrl: a.AUDIO ? audio.get(a.AUDIO)?.url : undefined
      })
    })
    return { kind: 'master', variants }
  }

  let duration = 0
  let encryption: string | undefined
  for (const line of lines) {
    const inf = tag(line, '#EXTINF')
    if (inf) duration += parseFloat(inf) || 0
    const key = tag(line, '#EXT-X-KEY')
    const method = key && parseAttributes(key).METHOD
    if (method && method !== 'NONE' && method !== 'AES-128') encryption = method
  }
  return { kind: 'media', duration, live: !lines.includes('#EXT-X-ENDLIST'), encryption }
}

export interface ByteRange {
  start: number
  end: number
}

export interface HlsSegment {
  url: string
  /** 秒 */
  duration: number
  /** 只取文件的这一段（EXT-X-BYTERANGE） */
  range?: ByteRange
  /** AES-128 加密：密钥地址和这个分片的初始向量 */
  key?: { url: string; iv: Uint8Array }
}

export interface SegmentPlan {
  /** fMP4 的初始化段，要写在所有分片前面 */
  init?: { url: string; range?: ByteRange }
  segments: HlsSegment[]
  /** 秒 */
  duration: number
}

/** `长度[@起点]`，没写起点时接在同一个文件上一段的后面 */
function byteRange(text: string, after: number): ByteRange {
  const [length, offset] = text.split('@').map(Number)
  const start = offset ?? after
  return { start, end: start + (length ?? 0) - 1 }
}

/** 没写初始向量时用分片的序号 */
function sequenceIv(sequence: number): Uint8Array {
  const iv = Buffer.alloc(16)
  iv.writeUInt32BE(sequence >>> 0, 12)
  return iv
}

/**
 * 列出一个播放列表的全部分片，供自己并发下载后按顺序拼起来。
 * 拼起来不保证能正常播放的情况返回 null，交给 ffmpeg 处理：主列表、直播、中途换了片源（DISCONTINUITY，
 * 常见于插了广告的流）、AES-128 之外的加密、不止一个初始化段。
 */
export function parseSegments(text: string, baseUrl: string): SegmentPlan | null {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  if (!lines[0]?.startsWith('#EXTM3U') || !lines.includes('#EXT-X-ENDLIST')) return null
  const resolve = (uri: string) => new URL(uri, baseUrl).href
  const tag = (line: string, name: string) => (line.startsWith(`${name}:`) ? line.slice(name.length + 1) : null)

  const plan: SegmentPlan = { segments: [], duration: 0 }
  let sequence = 0
  let key: { url: string; iv?: Uint8Array } | undefined
  let duration = 0
  let range: string | undefined
  /** 每个文件上一段结束的位置 */
  const ends = new Map<string, number>()
  for (const line of lines) {
    if (line === '#EXT-X-DISCONTINUITY' || line.startsWith('#EXT-X-STREAM-INF')) return null
    const value = (name: string) => tag(line, name)
    const media = value('#EXT-X-MEDIA-SEQUENCE')
    const keyTag = value('#EXT-X-KEY')
    const map = value('#EXT-X-MAP')
    if (media) sequence = Number(media) || 0
    else if (keyTag) {
      const a = parseAttributes(keyTag)
      if (a.METHOD === 'NONE') key = undefined
      else if (a.METHOD === 'AES-128' && a.URI && (!a.KEYFORMAT || a.KEYFORMAT === 'identity'))
        key = { url: resolve(a.URI), iv: a.IV ? Buffer.from(a.IV.replace(/^0x/i, '').padStart(32, '0'), 'hex') : undefined }
      else return null
    } else if (map) {
      const a = parseAttributes(map)
      if (plan.init || key || !a.URI) return null
      plan.init = { url: resolve(a.URI), range: a.BYTERANGE ? byteRange(a.BYTERANGE, 0) : undefined }
    } else if (value('#EXTINF')) duration = parseFloat(value('#EXTINF')!) || 0
    else if (value('#EXT-X-BYTERANGE')) range = value('#EXT-X-BYTERANGE')!
    else if (!line.startsWith('#')) {
      const url = resolve(line)
      const segment: HlsSegment = { url, duration }
      if (range) {
        // 加密的分片按块对齐，和按字节取一段混用时怎么算没有定论
        if (key) return null
        segment.range = byteRange(range, ends.get(url) ?? 0)
        ends.set(url, segment.range.end + 1)
      }
      if (key) segment.key = { url: key.url, iv: key.iv ?? sequenceIv(sequence) }
      plan.segments.push(segment)
      plan.duration += duration
      sequence++
      duration = 0
      range = undefined
    }
  }
  return plan.segments.length ? plan : null
}
