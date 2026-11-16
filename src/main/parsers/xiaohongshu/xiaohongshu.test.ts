import { describe, expect, test } from 'vitest'
import { ParseError } from '../../errors'
import { parse } from '../index'
import type { ParseContext } from '../types'
import { extractNoteId, parseInitialState } from './index'

const ID = '6ad58cf3000000002701cfd3'
const QUERY = '?xsec_token=ABtoken=&xsec_source=pc_feed'
const LINK = `https://www.xiaohongshu.com/explore/${ID}${QUERY}`

// 字段结构取自真实页面里的 window.__INITIAL_STATE__，只保留解析器用到的部分
const stream = (name: string, width: number, height: number, size: number, videoCodec: string) => ({
  masterUrl: `http://sns-video-v3.xhscdn.com/stream/${name}.mp4?sign=s&t=1`,
  backupUrls: [`http://sns-bak-v1.xhscdn.com/stream/${name}.mp4`],
  width, height, size, videoCodec
})
const videoNote = {
  noteId: ID, type: 'video', title: '', desc: '真的再一次惊叹静婉的勇敢啊 #一路繁花[话题]#\n第二行', user: { nickname: '作者' },
  imageList: [{ fileId: 'cover', width: 1440, height: 1080, urlDefault: 'http://sns-webpic-qc.xhscdn.com/1/2/cover!nd_dft_wlteh_webp_3', livePhoto: false, stream: {} }],
  video: {
    capa: { duration: 39 },
    media: {
      stream: {
        av1: [], h266: [],
        h264: [stream('720-avc', 960, 720, 7878196, 'h264'), stream('1080-avc', 1440, 1080, 13451906, 'h264')],
        h265: [stream('720-hevc', 960, 720, 3906481, 'hevc'), stream('1080-hevc', 1440, 1080, 4992609, 'hevc'), stream('2k-hevc', 1920, 1440, 9000000, 'hevc')]
      }
    }
  }
}
const image = (fileId: string, live = false) => ({
  fileId, width: 3024, height: 4032, livePhoto: live,
  urlDefault: `http://sns-webpic-qc.xhscdn.com/1/2/${fileId}!nd_dft_wlteh_webp_3`,
  stream: live ? { h265: [], h264: [{ masterUrl: `http://sns-video-v3.xhscdn.com/live/${fileId}.mp4`, backupUrls: [] }] } : {}
})
const imageNote = {
  noteId: ID, type: 'normal', title: '好想挤痘痘啊', desc: '正文', user: { nickname: '作者' },
  imageList: [image('notes_pre_post/jpeg', true), image('notes_pre_post/png'), image('notes_pre_post/unknown')]
}

const page = (note: unknown, title = '笔记 - 小红书') =>
  `<html><head><title>${title}</title></head><body><script>window.__INITIAL_STATE__=${JSON.stringify({
    global: { a: 'undefined,' },
    note: { noteDetailMap: note ? { [ID]: { note } } : {}, currentNoteId: '__U__', list: ['__U__'] }
  }).replaceAll('"__U__"', 'undefined')}</script></body></html>`

const MAGIC: Record<string, number[]> = { jpeg: [0xff, 0xd8, 0xff, 0xe0], png: [0x89, 0x50, 0x4e, 0x47], unknown: [0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63] }

function context(html: string, calls: string[] = []): ParseContext {
  return {
    fetch: async (input, init) => {
      expect(new Headers(init?.headers).get('range')).toBe('bytes=0-15')
      return new Response(new Uint8Array(MAGIC[input.split('/').pop()!] ?? []), { status: 206 })
    },
    sniffPage: () => Promise.reject(new Error('unused')),
    finalUrl: async () => `https://www.xiaohongshu.com/discovery/item/${ID}${QUERY}&app_platform=ios`,
    capturePage: async (url, pattern) => {
      calls.push(url)
      expect(pattern.test(url)).toBe(true)
      expect(pattern.test('https://www.xiaohongshu.com/404?source=note')).toBe(true)
      expect(pattern.test('https://edith.xiaohongshu.com/api/sns/web/v1/feed')).toBe(false)
      return html
    }
  }
}

test.each([
  [LINK, ID],
  [`https://www.xiaohongshu.com/discovery/item/${ID}?a=1`, ID],
  [`https://www.xiaohongshu.com/user/profile/5ff0e6500000000001008400/${ID}`, ID],
  ['https://www.xiaohongshu.com/user/profile/5ff0e6500000000001008400', null],
  ['https://www.xiaohongshu.com/explore', null]
])('extractNoteId %s', (url, expected) => {
  expect(extractNoteId(new URL(url))).toBe(expected)
})

test('parseInitialState turns bare undefined into null without touching strings', () => {
  const state = parseInitialState(page(videoNote)) as unknown as { global: { a: string }; note: { currentNoteId: null; list: null[] } }
  expect(state.global.a).toBe('undefined,')
  expect(state.note.currentNoteId).toBeNull()
  expect(state.note.list).toEqual([null])
})

describe('parse', () => {
  test('video note: one variant per quality, H.264 preferred', async () => {
    const calls: string[] = []
    const result = await parse(`看看这个 ${LINK}`, context(page(videoNote), calls))

    expect(calls).toEqual([LINK])
    expect(result).toMatchObject({
      platform: 'xiaohongshu', id: ID, title: '真的再一次惊叹静婉的勇敢啊 #一路繁花', author: '作者', sourceUrl: LINK,
      cover: 'https://sns-webpic-qc.xhscdn.com/1/2/cover!nd_dft_wlteh_webp_3'
    })
    const item = result.items[0]
    if (item?.kind !== 'video') throw new Error('expected a video item')
    expect(item.duration).toBe(39)
    expect(item.variants.map((v) => [v.label, v.codec, v.size])).toEqual([
      ['1440P', 'HEVC', 9000000],
      ['1080P', 'H.264', 13451906],
      ['720P', 'H.264', 7878196]
    ])
    expect(item.variants[1]?.video).toEqual({
      url: 'https://sns-video-v3.xhscdn.com/stream/1080-avc.mp4?sign=s&t=1',
      backupUrls: ['https://sns-bak-v1.xhscdn.com/stream/1080-avc.mp4']
    })
  })

  test('reads obfuscated codec keys', async () => {
    const note = { ...videoNote, video: { media: { stream: { EF4: [stream('a', 720, 1280, 2, 'EF4')], EF5: [stream('b', 720, 1280, 1, 'EF5'), stream('c', 1080, 1920, 3, 'EF5')] } } } }
    const result = await parse(LINK, context(page(note)))
    const item = result.items[0]
    if (item?.kind !== 'video') throw new Error('expected a video item')
    expect(item.variants.map((v) => [v.label, v.codec])).toEqual([['1080P', 'HEVC'], ['720P', 'H.264']])
  })

  test('image note: originals with sniffed type, live photo video, short link', async () => {
    const calls: string[] = []
    const result = await parse('59 标题 http://xhslink.com/a/AbCdEf，复制本条信息，打开【小红书】App查看精彩内容！', context(page(imageNote), calls))

    expect(calls).toEqual([`https://www.xiaohongshu.com/explore/${ID}${QUERY}&app_platform=ios`])
    expect(result.title).toBe('好想挤痘痘啊')
    expect(result.items).toEqual([
      {
        kind: 'image', id: '1', ext: 'jpg', width: 3024, height: 4032,
        image: { url: 'https://sns-img-bd.xhscdn.com/notes_pre_post/jpeg', backupUrls: ['https://ci.xiaohongshu.com/notes_pre_post/jpeg?imageView2/2/w/0/format/jpg'] },
        preview: 'https://sns-webpic-qc.xhscdn.com/1/2/notes_pre_post/jpeg!nd_dft_wlteh_webp_3',
        liveVideo: { url: 'https://sns-video-v3.xhscdn.com/live/notes_pre_post/jpeg.mp4', backupUrls: [] }
      },
      {
        kind: 'image', id: '2', ext: 'png', width: 3024, height: 4032,
        image: { url: 'https://sns-img-bd.xhscdn.com/notes_pre_post/png', backupUrls: undefined },
        preview: 'https://sns-webpic-qc.xhscdn.com/1/2/notes_pre_post/png!nd_dft_wlteh_webp_3',
        liveVideo: undefined
      },
      {
        kind: 'image', id: '3', ext: 'jpg', width: 3024, height: 4032,
        image: { url: 'https://ci.xiaohongshu.com/notes_pre_post/unknown?imageView2/2/w/0/format/jpg' },
        preview: 'https://sns-webpic-qc.xhscdn.com/1/2/notes_pre_post/unknown!nd_dft_wlteh_webp_3',
        liveVideo: undefined
      }
    ])
  })

  test.each([
    [LINK, page(null, '小红书 - 你访问的页面不见了'), 'not_found', '重新复制'],
    [`https://www.xiaohongshu.com/explore/${ID}`, page(null, '小红书 - 你访问的页面不见了'), 'not_found', 'xsec_token'],
    [LINK, page(null, '小红书 - 你的生活兴趣社区'), 'login_required', '登录'],
    [LINK, '<html>验证</html>', 'platform_changed', '解析规则'],
    ['https://www.xiaohongshu.com/user/profile/5ff0e6500000000001008400', '', 'unsupported', '单篇笔记']
  ])('%s → %s', async (text, html, code, hint) => {
    const error = await parse(text, context(html)).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ParseError)
    expect(error).toMatchObject({ code, platform: 'xiaohongshu', message: expect.stringContaining(hint) })
  })

  test('expired short link', async () => {
    const ctx = { ...context(''), finalUrl: async () => 'http://www.xiaohongshu.com' }
    const error = await parse('http://xhslink.com/h04FrT', ctx).catch((e: unknown) => e)
    expect(error).toMatchObject({ code: 'not_found', message: expect.stringContaining('短链接') })
  })
})
