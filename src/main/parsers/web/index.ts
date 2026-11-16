import type { MediaResult } from '@shared/types'
import { ParseError } from '../../errors'
import { DESKTOP_UA } from '../http'
import { hlsResult, resolveHls, type HlsSource } from '../m3u8'
import type { Parser } from '../types'

const M3U8_URL = /\.m3u8(?:[?#]|$)/i
const M3U8_MIME = /mpegurl/i
const MAX_CANDIDATES = 8
const NOT_FOUND =
  '没有在这个网页里自动找到视频流（m3u8）。有些网页要登录或点一下才开始播放，可以打开网页自己播放一次，识别到后会自动返回'
const NOT_FOUND_MANUAL =
  '网页窗口关闭前没有出现 m3u8 视频流。这个网页的视频可能不是用 m3u8 播放的，或者关闭窗口时视频还没开始播放'

/** 任意网页：在隐藏窗口里打开，找出页面播放器请求的 m3u8 */
export const web: Parser = {
  platform: 'web',

  match: (url) => url.protocol === 'http:' || url.protocol === 'https:',

  async parse(url, ctx): Promise<MediaResult> {
    const notFound = () => new ParseError('no_stream', ctx.manual ? NOT_FOUND_MANUAL : NOT_FOUND, 'web')
    const page = await ctx.sniffPage(url.href, { url: M3U8_URL, mime: M3U8_MIME }, { manual: ctx.manual }).catch(() => null)
    const requests = [...new Map((page?.requests ?? []).map((r) => [r.url, r])).values()].slice(0, MAX_CANDIDATES)
    if (!page || requests.length === 0) throw notFound()

    const resolved = await Promise.all(
      requests.map(async (req) => {
        // 很多视频服务器只认来自原网页的请求。只带来源站点：Electron 的 net.fetch 会拒绝带路径的跨站 Referer
        const headers: Record<string, string> = { 'User-Agent': DESKTOP_UA, Referer: `${new URL(req.headers.Referer ?? url.href).origin}/` }
        if (req.headers.Origin) headers.Origin = req.headers.Origin
        try {
          return { url: req.url, headers, source: await resolveHls(req.url, headers, ctx) }
        } catch (error) {
          return { url: req.url, headers, error }
        }
      })
    )
    const ok = resolved.filter((r): r is typeof r & { source: HlsSource } => 'source' in r)
    if (ok.length === 0) {
      const error = resolved[0]?.error
      throw error instanceof ParseError ? error : notFound()
    }
    // 主列表下的各清晰度会被播放器再请求一次，不算独立的视频
    const listed = new Set(ok.flatMap((r) => r.source.variantUrls))
    const candidates = ok.filter((r) => !listed.has(r.url))
    // 页面里可能还有广告或预告片，取最长的那个
    const best = (candidates.length ? candidates : ok).reduce((a, b) => (b.source.duration > a.source.duration ? b : a))

    return hlsResult(best.source, {
      title: page.title.trim() || `${url.hostname} 的视频`,
      sourceUrl: url.href,
      headers: best.headers,
      notice: candidates.length > 1 ? `在页面里找到 ${candidates.length} 个视频流，已选择最长的一个。` : undefined
    })
  }
}
