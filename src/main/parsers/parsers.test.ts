import { describe, expect, test } from 'vitest'
import { ParseError } from '../errors'
import { extractVideoRef } from './bilibili'
import { extractUrl, parse } from './index'
import { finalUrlVia } from './http'
import type { FetchLike, ParseContext } from './types'

const context = (fetch: FetchLike): ParseContext => ({
  fetch,
  finalUrl: finalUrlVia(fetch),
  capturePage: () => Promise.reject(new Error('unused')),
  sniffPage: () => Promise.reject(new Error('unused'))
})

const VIDEO = 'https://www.bilibili.com/video/BV1GJ411x7h7'

describe('extractUrl', () => {
  test('finds the link inside share text', () => {
    expect(extractUrl('【官方 MV】Never Gonna Give You Up https://b23.tv/abc123 复制打开')?.href).toBe(
      'https://b23.tv/abc123'
    )
  })
  test('stops at Chinese text glued to the link', () => {
    expect(extractUrl(`${VIDEO}，快来看`)?.pathname).toBe('/video/BV1GJ411x7h7')
  })
  test.each(['「https://b23.tv/abc123」', '链接：https://b23.tv/abc123；还有别的', '“https://b23.tv/abc123”', 'https://b23.tv/abc123……'])(
    'stops at full-width punctuation around the link: %s',
    (text) => {
      expect(extractUrl(text)?.href).toBe('https://b23.tv/abc123')
    }
  )
  test('returns null without a link', () => {
    expect(extractUrl('没有链接')).toBeNull()
  })
})

describe('extractVideoRef', () => {
  test.each([
    [`${VIDEO}/?p=2`, { bvid: 'BV1GJ411x7h7' }],
    ['https://m.bilibili.com/video/av80433022', { aid: '80433022' }],
    ['https://www.bilibili.com/bangumi/play/ep1', null]
  ])('%s', (url, expected) => {
    expect(extractVideoRef(new URL(url))).toEqual(expected)
  })
})

describe('parse', () => {
  const offline: FetchLike = () => Promise.reject(new Error('offline'))

  test.each([
    ['纯文字', 'no_url'],
    ['https://example.com/video/1', 'no_stream'],
    ['https://www.bilibili.com/bangumi/play/ep1', 'unsupported'],
    [VIDEO, 'network'],
    ['https://b23.tv/abc', 'network']
  ])('%s → %s', async (text, code) => {
    const error = await parse(text, context(offline)).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ParseError)
    expect((error as ParseError).code).toBe(code)
  })

  const dashStream = (id: number, codecid: number, codecs: string) => ({
    id, codecid, codecs, baseUrl: `https://cdn.test/${id}-${codecid}.m4s`, bandwidth: 800_000, width: 1920, height: 1080
  })
  /** 模拟 B 站接口；video 是 playurl 返回的分流视频列表 */
  function api(video = [dashStream(80, 12, 'hev1'), dashStream(80, 7, 'avc1.64'), dashStream(64, 7, 'avc1.64'), dashStream(32, 7, 'avc1.64')], seen: Record<string, string | null>[] = []): FetchLike {
    const responses: Record<string, unknown> = {
      '/x/web-interface/view': {
        code: 0,
        data: {
          bvid: 'BV1GJ411x7h7', title: '标题', pic: 'http://i1.hdslb.com/a.jpg', owner: { name: 'UP' },
          pages: [{ cid: 1, page: 1, part: 'P1', duration: 100 }]
        }
      },
      '/x/web-interface/nav': {
        code: -101,
        data: { isLogin: false, wbi_img: { img_url: 'https://x/7cd084941338484aae1ad9425b84077c.png', sub_url: 'https://x/4932caff0ff746eab6f01bf08b70ac45.png' } }
      },
      html5: {
        code: 0,
        data: { quality: 64, accept_quality: [64, 16], accept_description: ['高清 720P', '流畅 360P'], durl: [{ url: 'https://cdn.test/720.mp4', size: 5000 }] }
      },
      dash: {
        code: 0,
        data: {
          quality: 80, accept_quality: [80, 64, 32], accept_description: ['高清 1080P', '高清 720P', '清晰 480P'],
          dash: {
            video,
            audio: [{ id: 30216, baseUrl: 'https://cdn.test/low.m4s', bandwidth: 60_000, codecs: 'mp4a' }, { id: 30280, baseUrl: 'https://cdn.test/high.m4s', bandwidth: 200_000, codecs: 'mp4a' }]
          }
        }
      }
    }
    return async (input, init) => {
      const url = new URL(input)
      seen.push({ host: url.hostname, cookie: new Headers(init?.headers).get('cookie') })
      const key = url.pathname.endsWith('/playurl') ? (url.searchParams.get('platform') ?? 'dash') : url.pathname
      expect(url.pathname.endsWith('/playurl') ? url.searchParams.get('w_rid') : 'signed').toBeTruthy()
      return Response.json(responses[key])
    }
  }

  test('builds a result from API responses', async () => {
    const result = await parse(VIDEO, context(api()))

    expect(result).toMatchObject({ platform: 'bilibili', id: 'BV1GJ411x7h7', title: '标题', author: 'UP', cover: 'https://i1.hdslb.com/a.jpg' })
    expect(result.notice).toContain('720P')
    const item = result.items[0]
    if (item?.kind !== 'video') throw new Error('expected a video item')
    expect(item.variants.map((v) => [v.id, v.label, v.codec])).toEqual([
      ['dash-80', '1080P', 'H.264'],
      ['mp4-64', '720P', 'H.264'],
      ['dash-32', '480P', 'H.264']
    ])
    expect(item.variants[0]?.audio?.url).toBe('https://cdn.test/high.m4s')
    // 分流的两路流带上 MIME，应用内预览靠它交给 MSE
    expect(item.variants[0]?.video.mime).toBe('video/mp4; codecs="avc1.64"')
    expect(item.variants[0]?.audio?.mime).toBe('audio/mp4; codecs="mp4a"')
    expect(item.variants[1]?.video.mime).toBeUndefined()
    expect(item.variants[1]?.size).toBe(5000)
    expect(item.variants[1]?.audio).toBeUndefined()
  })

  test('puts the official CDN ahead of the P2P nodes the API lists first', async () => {
    const p2p = 'https://xy1x2x3x4xy.mcdn.bilivideo.cn:8082/v.m4s'
    const edge = 'https://abc.edge.mountaintoys.cn:4483/v.m4s'
    const node = 'https://cn-gddg-ct-01-12.bilivideo.com/v.m4s'
    const mirror = 'https://upos-sz-mirrorcos.bilivideo.com/v.m4s'
    const stream = { ...dashStream(80, 7, 'avc1.64'), baseUrl: p2p, backupUrl: [edge, node, mirror] }
    const item = (await parse(VIDEO, context(api([stream])))).items[0]
    const dash = item?.kind === 'video' ? item.variants.find((v) => v.id === 'dash-80') : undefined
    expect(dash?.video).toMatchObject({ url: mirror, backupUrls: [node, p2p, edge] })
  })

  test('names the codec of each stream, including the HEVC flavours', async () => {
    const video = [dashStream(126, 12, 'dvh1.08.07'), dashStream(125, 12, 'hvc1.2.4.L153.90'), dashStream(120, 13, 'av01.0.13M.10.0.110'), dashStream(112, 12, 'hev1.1.6.L150.90'), dashStream(80, 7, 'avc1.640032')]
    const item = (await parse(VIDEO, context(api(video)))).items[0]
    expect(item?.kind === 'video' && item.variants.map((v) => [v.id, v.codec])).toEqual([
      ['dash-126', 'HEVC'],
      ['dash-125', 'HEVC'],
      ['dash-120', 'AV1'],
      ['dash-112', 'HEVC'],
      ['dash-80', 'H.264'],
      ['mp4-64', 'H.264']
    ])
  })

  test('sends the login cookie to the API but not to the short-link host', async () => {
    const seen: Record<string, string | null>[] = []
    const ctx: ParseContext = {
      ...context(api(undefined, seen)),
      cookies: { bilibili: 'SESSDATA=secret' },
      finalUrl: async (url, headers) => {
        seen.push({ host: new URL(url).hostname, cookie: new Headers(headers).get('cookie') })
        return VIDEO
      }
    }
    await parse('https://b23.tv/abc', ctx)
    expect(seen.find((s) => s.host === 'b23.tv')).toEqual({ host: 'b23.tv', cookie: null })
    const apiCalls = seen.filter((s) => s.host === 'api.bilibili.com')
    expect(apiCalls.length).toBe(4)
    expect(apiCalls.every((s) => s.cookie === 'SESSDATA=secret')).toBe(true)
  })
})

describe.runIf(process.env.LIVE)('live', () => {
  test('parses a public Bilibili video', async () => {
    const result = await parse(VIDEO, context((input, init) => fetch(input, init)))
    expect(result.title).toContain('Never Gonna Give You Up')
    const item = result.items[0]
    if (item?.kind !== 'video') throw new Error('expected a video item')
    console.log(item.variants.map((v) => `${v.label} ${v.codec} ${v.size} ${v.audio ? 'dash' : 'mp4'}`))
    expect(item.variants.length).toBeGreaterThan(0)
    const head = await fetch(item.variants[0]!.video.url, { headers: { ...result.headers, Range: 'bytes=0-9' } })
    expect(head.status).toBe(206)
  })

  test('follows a short link', async () => {
    const result = await parse('https://b23.tv/BV1GJ411x7h7', context((input, init) => fetch(input, init)))
    expect(result.id).toBe('BV1GJ411x7h7')
  })
})
