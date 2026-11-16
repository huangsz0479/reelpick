import { describe, expect, test } from 'vitest'
import { ParseError } from '../../errors'
import { parse } from '../index'
import type { ParseContext } from '../types'
import { extractAwemeId } from './index'

const ID = '7673914871142548337'

// 字段结构取自真实接口响应，只保留解析器用到的部分
const stream = (width: number, height: number, bit_rate: number, is_h265: number) => ({
  bit_rate,
  is_h265,
  play_addr: { width, height, data_size: bit_rate, url_list: [`https://cdn.test/${width}-${bit_rate}-a`, `https://cdn.test/${width}-${bit_rate}-b`] }
})
const detail = (overrides: object = {}) => ({
  status_code: 0,
  aweme_detail: {
    aweme_id: ID,
    desc: '挖掘机师傅下班路过农田，\n顺手清淤。 ',
    author: { nickname: '九江青年' },
    images: null,
    video: {
      duration: 17810,
      cover: { url_list: ['https://pic.test/cover.jpeg'] },
      bit_rate: [stream(1080, 1920, 4654996, 0), stream(1080, 1920, 3631758, 1), stream(576, 1024, 3253032, 0), stream(720, 1280, 2993851, 0), stream(720, 1280, 2917468, 0), stream(576, 1024, 2627934, 0)]
    },
    ...overrides
  }
})

function context(response: unknown, calls: string[] = []): ParseContext {
  return {
    fetch: () => Promise.reject(new Error('unused')),
    sniffPage: () => Promise.reject(new Error('unused')),
    finalUrl: async () => `https://www.iesdouyin.com/share/video/${ID}/?region=CN`,
    capturePage: async (url, pattern) => {
      calls.push(url)
      expect(pattern.test('https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=1')).toBe(true)
      if (response instanceof Error) throw response
      return typeof response === 'string' ? response : JSON.stringify(response)
    }
  }
}

test.each([
  [`https://www.douyin.com/video/${ID}`, ID],
  [`https://www.iesdouyin.com/share/video/${ID}/?region=CN`, ID],
  [`https://www.douyin.com/note/${ID}`, ID],
  [`https://www.douyin.com/discover?modal_id=${ID}`, ID],
  [`https://jingxuan.douyin.com/m/video/${ID}`, ID],
  ['https://www.douyin.com/user/abc', null]
])('extractAwemeId %s', (url, expected) => {
  expect(extractAwemeId(new URL(url))).toBe(expected)
})

describe('parse', () => {
  test('resolves a short link and builds one H.264 variant per quality', async () => {
    const calls: string[] = []
    const result = await parse('3.87 复制打开抖音，看看 https://v.douyin.com/L4FJNR3/ 08/14', context(detail(), calls))

    expect(calls).toEqual([`https://www.douyin.com/video/${ID}`])
    expect(result).toMatchObject({
      platform: 'douyin',
      id: ID,
      title: '挖掘机师傅下班路过农田， 顺手清淤。',
      author: '九江青年',
      cover: 'https://pic.test/cover.jpeg',
      headers: { Referer: 'https://www.douyin.com/' }
    })
    const item = result.items[0]
    if (item?.kind !== 'video') throw new Error('expected a video item')
    expect(item.duration).toBe(17.81)
    expect(item.variants.map((v) => [v.label, v.codec, v.size])).toEqual([
      ['1080P', 'H.264', 4654996],
      ['720P', 'H.264', 2993851],
      ['540P', 'H.264', 3253032]
    ])
    expect(item.variants[0]?.video).toEqual({ url: 'https://cdn.test/1080-4654996-a', backupUrls: ['https://cdn.test/1080-4654996-b'] })
    expect(item.variants[0]?.audio).toBeUndefined()
  })

  test('keeps a quality that only exists in HEVC', async () => {
    const res = detail({ video: { bit_rate: [stream(2160, 3840, 900, 1), stream(1080, 1920, 500, 1), stream(1080, 1920, 100, 0)] } })
    const item = (await parse(`https://www.douyin.com/video/${ID}`, context(res))).items[0]
    expect(item?.kind === 'video' && item.variants.map((v) => [v.label, v.codec, v.size])).toEqual([
      ['2160P', 'HEVC', 900],
      ['1080P', 'H.264', 100]
    ])
  })

  test.each([
    ['deleted work', { status_code: 0, aweme_detail: null, filter_detail: { detail_msg: '因作品权限或已被删除，无法观看' } }, 'not_found', '无法观看'],
    ['image post without addresses', detail({ images: [{}] }), 'platform_changed', '图片地址'],
    ['no streams', detail({ video: { bit_rate: [] } }), 'platform_changed', '视频地址'],
    ['page never answers', new Error('timeout'), 'platform_changed', '验证'],
    ['garbage body', '<html>', 'platform_changed', '无法识别']
  ])('%s → %s', async (_name, response, code, message) => {
    const error = await parse(`https://www.douyin.com/video/${ID}`, context(response)).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ParseError)
    expect(error).toMatchObject({ code, platform: 'douyin', message: expect.stringContaining(message) })
  })

  test('builds image items from an image post, preferring JPEG', async () => {
    const image = (n: number, extra: object = {}) => ({
      width: 3840,
      height: 2160,
      url_list: [`https://p3.test/${n}~tplv:q75.webp?x=1`, `https://p9.test/${n}~tplv:q75.webp?x=1`, `https://p3.test/${n}~tplv:q75.jpeg?x=1`],
      ...extra
    })
    const live = { video: { play_addr: { url_list: ['https://v.test/live-a', 'https://v.test/live-b'] } } }
    const res = detail({ images: [image(1), image(2, live), { url_list: ['https://p3.test/3.webp'] }], video: { duration: 0, bit_rate: [] } })

    const result = await parse(`https://www.douyin.com/note/${ID}`, context(res))

    expect(result.sourceUrl).toBe(`https://www.douyin.com/note/${ID}`)
    expect(result.items).toEqual([
      { kind: 'image', id: '1', image: { url: 'https://p3.test/1~tplv:q75.jpeg?x=1', backupUrls: [] }, ext: 'jpg', width: 3840, height: 2160, liveVideo: undefined },
      { kind: 'image', id: '2', image: { url: 'https://p3.test/2~tplv:q75.jpeg?x=1', backupUrls: [] }, ext: 'jpg', width: 3840, height: 2160, liveVideo: { url: 'https://v.test/live-a', backupUrls: ['https://v.test/live-b'] } },
      { kind: 'image', id: '3', image: { url: 'https://p3.test/3.webp', backupUrls: [] }, ext: 'webp', width: undefined, height: undefined, liveVideo: undefined }
    ])
  })

  test('rejects links without a work id', async () => {
    const error = await parse('https://www.douyin.com/user/abc', context(detail())).catch((e: unknown) => e)
    expect(error).toMatchObject({ code: 'unsupported' })
  })
})
