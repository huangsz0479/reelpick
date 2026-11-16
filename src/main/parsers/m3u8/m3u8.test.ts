import { describe, expect, test } from 'vitest'
import { ParseError } from '../../errors'
import { parse } from '../index'
import { finalUrlVia } from '../http'
import type { FetchLike, ParseContext, SniffedPage } from '../types'
import { titleFromUrl } from './index'
import { parseAttributes, parsePlaylist, parseSegments } from './playlist'

const BASE = 'https://cdn.test/v/abc'
// 结构取自 Apple 的示例流：同一清晰度有多个码率，音频单独成流并分 AAC / AC-3 两组
const MASTER = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud1",NAME="English",DEFAULT=YES,URI="a1/prog_index.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud2",NAME="English",DEFAULT=YES,URI="a2/prog_index.m3u8"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="sub1",NAME="English",URI="s1/en/prog_index.m3u8"
#EXT-X-STREAM-INF:AVERAGE-BANDWIDTH=2218327,BANDWIDTH=2227464,CODECS="avc1.640020,mp4a.40.2",RESOLUTION=960x540,AUDIO="aud1"
v5/prog_index.m3u8
#EXT-X-STREAM-INF:AVERAGE-BANDWIDTH=8144656,BANDWIDTH=8178040,CODECS="avc1.64002a,mp4a.40.2",RESOLUTION=1920x1080,AUDIO="aud1"
v9/prog_index.m3u8
#EXT-X-STREAM-INF:AVERAGE-BANDWIDTH=6307144,BANDWIDTH=6453202,CODECS="avc1.64002a,mp4a.40.2",RESOLUTION=1920x1080,AUDIO="aud1"
v8/prog_index.m3u8
#EXT-X-STREAM-INF:AVERAGE-BANDWIDTH=8366033,BANDWIDTH=8399417,CODECS="avc1.64002a,ac-3",RESOLUTION=1920x1080,AUDIO="aud2"
v9/prog_index.m3u8
#EXT-X-STREAM-INF:AVERAGE-BANDWIDTH=9000000,CODECS="hvc1.2.4.L123.B0,mp4a.40.2",RESOLUTION=3840x2160,AUDIO="aud1"
v10/prog_index.m3u8
`
const media = (seconds: number, extra = '', end = '#EXT-X-ENDLIST') =>
  `#EXTM3U\n#EXT-X-TARGETDURATION:10\n${extra}\n${Array.from({ length: seconds / 10 }, (_, i) => `#EXTINF:10.000,\nseg${i}.ts`).join('\n')}\n${end}\n`

function context(files: Record<string, string>, page?: SniffedPage, seen: Record<string, string | null>[] = []): ParseContext {
  const fetch: FetchLike = async (input, init) => {
    seen.push({ url: input, referer: new Headers(init?.headers).get('referer') })
    const body = files[input]
    return body === undefined ? new Response('', { status: 404 }) : new Response(body)
  }
  return {
    fetch,
    finalUrl: finalUrlVia(fetch),
    capturePage: () => Promise.reject(new Error('unused')),
    sniffPage: async (_url, match) => {
      expect(match.url.test('https://x.test/a.m3u8?token=1')).toBe(true)
      expect(match.url.test('https://x.test/a.m3u8.js')).toBe(false)
      expect(match.mime?.test('application/vnd.apple.mpegurl')).toBe(true)
      if (!page) throw new Error('timeout')
      return page
    }
  }
}

test('parseAttributes keeps commas inside quotes', () => {
  expect(parseAttributes('BANDWIDTH=1,CODECS="avc1.64001f,mp4a.40.2",RESOLUTION=1280x720')).toEqual({
    BANDWIDTH: '1', CODECS: 'avc1.64001f,mp4a.40.2', RESOLUTION: '1280x720'
  })
})

test('parsePlaylist', () => {
  expect(parsePlaylist('<html>', BASE)).toBeNull()
  expect(parsePlaylist(media(30), BASE)).toEqual({ kind: 'media', duration: 30, live: false, encryption: undefined })
  expect(parsePlaylist(media(30, '', ''), BASE)).toMatchObject({ live: true })
  expect(parsePlaylist(media(30, '#EXT-X-KEY:METHOD=AES-128,URI="k"'), BASE)).toMatchObject({ encryption: undefined })
  expect(parsePlaylist(media(30, '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://k"'), BASE)).toMatchObject({ encryption: 'SAMPLE-AES' })
})

test.each([
  ['https://cdn.test/movies/大电影/index.m3u8', '大电影'],
  ['https://cdn.test/v/1/hls/playlist.m3u8', 'cdn.test 的视频'],
  ['https://cdn.test/clip-2024.m3u8', 'clip-2024'],
  // 不成对的 % 解不了码，保持原样而不是报错
  ['https://cdn.test/100%/clip.m3u8', 'clip'],
  ['https://cdn.test/50%off/index.m3u8', '50%off']
])('titleFromUrl %s', (url, expected) => {
  expect(titleFromUrl(new URL(url))).toBe(expected)
})

describe('direct m3u8 link', () => {
  test('master playlist: one variant per quality with its audio stream', async () => {
    const files = { [`${BASE}/master.m3u8`]: MASTER, [`${BASE}/v10/prog_index.m3u8`]: media(600) }
    const result = await parse(`${BASE}/master.m3u8?token=1`.replace('?token=1', ''), context(files))

    expect(result).toMatchObject({ platform: 'web', title: 'abc', headers: { 'User-Agent': expect.any(String) } })
    const item = result.items[0]
    if (item?.kind !== 'video') throw new Error('expected a video item')
    expect(item.duration).toBe(600)
    expect(item.variants.map((v) => [v.label, v.codec, v.video.url, v.audio?.url, v.hls])).toEqual([
      ['2160P', 'HEVC', `${BASE}/v10/prog_index.m3u8`, `${BASE}/a1/prog_index.m3u8`, true],
      ['1080P', 'H.264', `${BASE}/v9/prog_index.m3u8`, `${BASE}/a1/prog_index.m3u8`, true],
      ['540P', 'H.264', `${BASE}/v5/prog_index.m3u8`, `${BASE}/a1/prog_index.m3u8`, true]
    ])
    expect(item.variants[1]).toMatchObject({ size: Math.round((8144656 * 600) / 8), sizeIsEstimate: true })
  })

  test('media playlist: a single variant', async () => {
    const result = await parse(`${BASE}/index.m3u8`, context({ [`${BASE}/index.m3u8`]: media(120) }))
    const item = result.items[0]
    if (item?.kind !== 'video') throw new Error('expected a video item')
    expect(item).toMatchObject({ duration: 120, variants: [{ label: '原画', hls: true, video: { url: `${BASE}/index.m3u8` } }] })
  })

  test.each([
    [{ [`${BASE}/a.m3u8`]: media(30, '', '') }, 'unsupported', '直播'],
    [{ [`${BASE}/a.m3u8`]: media(30, '#EXT-X-KEY:METHOD=SAMPLE-AES') }, 'unsupported', '加密'],
    [{ [`${BASE}/a.m3u8`]: '<html></html>' }, 'unsupported', '不是 m3u8'],
    [{}, 'not_found', '过期']
  ])('%# → %s', async (files, code, hint) => {
    const error = await parse(`${BASE}/a.m3u8`, context(files)).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ParseError)
    expect(error).toMatchObject({ code, platform: 'web', message: expect.stringContaining(hint) })
  })
})

describe('web page', () => {
  const PAGE = 'https://video.test/watch/1'
  const req = (url: string, Referer = 'https://player.test/embed') => ({ url, headers: { Referer, Origin: 'https://player.test' } })

  test('picks the longest stream, skips variants of a master, sends the page as Referer', async () => {
    const files = {
      [`${BASE}/master.m3u8`]: MASTER,
      [`${BASE}/v10/prog_index.m3u8`]: media(600),
      [`${BASE}/v5/prog_index.m3u8`]: media(600),
      'https://ads.test/ad.m3u8': media(30)
    }
    const page = { title: ' 页面标题 ', requests: [req('https://ads.test/ad.m3u8'), req(`${BASE}/master.m3u8`), req(`${BASE}/v5/prog_index.m3u8`), req('https://cdn.test/broken.m3u8')] }
    const seen: Record<string, string | null>[] = []
    const result = await parse(PAGE, context(files, page, seen))

    expect(result).toMatchObject({
      platform: 'web', title: '页面标题', sourceUrl: PAGE,
      headers: { Referer: 'https://player.test/', Origin: 'https://player.test' },
      notice: expect.stringContaining('2 个视频流')
    })
    const item = result.items[0]
    if (item?.kind !== 'video') throw new Error('expected a video item')
    expect(item.duration).toBe(600)
    expect(item.variants.map((v) => v.label)).toEqual(['2160P', '1080P', '540P'])
    expect(seen.every((s) => s.referer === 'https://player.test/')).toBe(true)
  })

  test.each([
    [undefined, 'no_stream', '自己播放一次'],
    [{ title: 't', requests: [] }, 'no_stream', '自己播放一次'],
    [{ title: 't', requests: [req('https://cdn.test/live.m3u8')] }, 'unsupported', '直播']
  ])('%# → %s', async (page, code, hint) => {
    const error = await parse(PAGE, context({ 'https://cdn.test/live.m3u8': media(30, '', '') }, page)).catch((e: unknown) => e)
    expect(error).toMatchObject({ code, platform: 'web', message: expect.stringContaining(hint) })
  })
})

test('manual mode is passed to the page and changes the hint', async () => {
  const ctx = context({})
  const options: unknown[] = []
  ctx.manual = true
  ctx.sniffPage = async (_url, _match, opts) => {
    options.push(opts)
    throw new Error('not found')
  }
  const error = await parse('https://video.test/watch/1', ctx).catch((e: unknown) => e)
  expect(options).toEqual([{ manual: true }])
  expect(error).toMatchObject({ code: 'no_stream', message: expect.stringContaining('窗口关闭前') })
})

describe.runIf(process.env.LIVE)('live', () => {
  const live = context({})
  live.fetch = (input, init) => fetch(input, init)

  test('parses a public master playlist', async () => {
    const result = await parse('https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8', live)
    const item = result.items[0]
    if (item?.kind !== 'video') throw new Error('expected a video item')
    console.log(item.duration, item.variants.map((v) => `${v.label} ${v.codec} ${v.size}`))
    expect(item.duration).toBeGreaterThan(600)
    expect(item.variants.map((v) => v.label)).toContain('1080P')
  })

  test('parses a master playlist with separate audio', async () => {
    const result = await parse('https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_ts/master.m3u8', live)
    const item = result.items[0]
    if (item?.kind !== 'video') throw new Error('expected a video item')
    console.log(item.duration, item.variants.map((v) => `${v.label} ${v.codec} ${v.audio?.url.split('/').slice(-2)[0]}`))
    expect(item.variants[0]?.audio?.url).toMatch(/\/a1\/prog_index\.m3u8$/)
  })
})

describe('parseSegments', () => {
  const list = (body: string) => `#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:7\n${body}\n#EXT-X-ENDLIST`

  test('lists segments with resolved addresses and the total duration', () => {
    const plan = parseSegments(list('#EXTINF:4.0,\ns7.ts\n#EXTINF:2.5,\n/abs/s8.ts?t=1'), 'https://cdn.test/v/index.m3u8')
    expect(plan).toEqual({
      duration: 6.5,
      segments: [
        { url: 'https://cdn.test/v/s7.ts', duration: 4 },
        { url: 'https://cdn.test/abs/s8.ts?t=1', duration: 2.5 }
      ]
    })
  })

  test('gives encrypted segments their key and IV: explicit, or the sequence number', () => {
    const plan = parseSegments(
      list('#EXT-X-KEY:METHOD=AES-128,URI="k1"\n#EXTINF:1,\na.ts\n#EXT-X-KEY:METHOD=AES-128,URI="k2",IV=0x000102030405060708090a0b0c0d0e0f\n#EXTINF:1,\nb.ts\n#EXT-X-KEY:METHOD=NONE\n#EXTINF:1,\nc.ts'),
      'https://cdn.test/v/index.m3u8'
    )!
    const [a, b, c] = plan.segments
    expect(a!.key!.url).toBe('https://cdn.test/v/k1')
    expect(Buffer.from(a!.key!.iv).toString('hex')).toBe('00000000000000000000000000000007')
    expect(b!.key!.url).toBe('https://cdn.test/v/k2')
    expect(Buffer.from(b!.key!.iv).toString('hex')).toBe('000102030405060708090a0b0c0d0e0f')
    expect(c!.key).toBeUndefined()
  })

  test('turns byte ranges into offsets, continuing from the previous one when no offset is given', () => {
    const plan = parseSegments(
      list('#EXT-X-MAP:URI="all.mp4",BYTERANGE="800@0"\n#EXTINF:1,\n#EXT-X-BYTERANGE:1000@800\nall.mp4\n#EXTINF:1,\n#EXT-X-BYTERANGE:500\nall.mp4'),
      'https://cdn.test/v/index.m3u8'
    )!
    expect(plan.init).toEqual({ url: 'https://cdn.test/v/all.mp4', range: { start: 0, end: 799 } })
    expect(plan.segments.map((s) => s.range)).toEqual([{ start: 800, end: 1799 }, { start: 1800, end: 2299 }])
  })

  test.each([
    ['a live stream', '#EXTM3U\n#EXTINF:1,\na.ts'],
    ['a master playlist', '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv.m3u8\n#EXT-X-ENDLIST'],
    ['a stream spliced from several sources', list('#EXTINF:1,\na.ts\n#EXT-X-DISCONTINUITY\n#EXTINF:1,\nb.ts')],
    ['an encryption other than AES-128', list('#EXT-X-KEY:METHOD=SAMPLE-AES,URI="k"\n#EXTINF:1,\na.ts')],
    ['an empty playlist', list('')]
  ])('leaves %s to ffmpeg', (_what, text) => {
    expect(parseSegments(text, 'https://cdn.test/v/index.m3u8')).toBeNull()
  })
})
