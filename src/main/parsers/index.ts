import type { MediaResult } from '@shared/types'
import { ParseError } from '../errors'
import { bilibili } from './bilibili'
import { douyin } from './douyin'
import { m3u8 } from './m3u8'
import type { ParseContext, Parser } from './types'
import { web } from './web'
import { xiaohongshu } from './xiaohongshu'

// web 匹配任意网页，必须排在最后
const parsers: Parser[] = [bilibili, xiaohongshu, douyin, m3u8, web]

/** 分享文本通常是「文案 + 链接」，取出其中第一个链接。链接到空白、汉字、全角标点或弯引号为止 */
export function extractUrl(text: string): URL | null {
  const match = /https?:\/\/[^\s\u4e00-\u9fff\u3000-\u303f\uff00-\uffef\u2018-\u201f\u2026]+/i.exec(text)
  if (!match) return null
  try {
    return new URL(match[0])
  } catch {
    return null
  }
}

export async function parse(text: string, ctx: ParseContext): Promise<MediaResult> {
  const url = extractUrl(text)
  if (!url) throw new ParseError('no_url', '没有在粘贴的内容里找到链接')
  const parser = parsers.find((p) => p.match(url))
  if (!parser) throw new ParseError('unsupported', `暂不支持 ${url.hostname}，目前支持 B 站、小红书、抖音的分享链接，以及 m3u8 地址和视频网页`)
  return parser.parse(url, ctx)
}
