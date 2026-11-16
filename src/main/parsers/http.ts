import type { Platform } from '@shared/types'
import { ParseError } from '../errors'
import type { FetchLike } from './types'

export const DESKTOP_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'

const TIMEOUT_MS = 15_000

export async function request(
  fetch: FetchLike,
  platform: Platform,
  url: string,
  headers: Record<string, string>
): Promise<Response> {
  try {
    return await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) })
  } catch (e) {
    const timedOut = e instanceof Error && e.name === 'TimeoutError'
    throw new ParseError('network', timedOut ? '请求超时，请检查网络后重试' : '网络请求失败，请检查网络后重试', platform)
  }
}

/** 适用于 response.url 可靠的 fetch 实现（Node、浏览器）；Electron 的 net.fetch 不在此列 */
export const finalUrlVia =
  (fetch: FetchLike) =>
  async (url: string, headers: Record<string, string>): Promise<string> => {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) })
    await res.body?.cancel()
    return res.url
  }

export async function getJson<T>(
  fetch: FetchLike,
  platform: Platform,
  url: string,
  headers: Record<string, string>
): Promise<T> {
  const res = await request(fetch, platform, url, headers)
  try {
    return (await res.json()) as T
  } catch {
    throw new ParseError('platform_changed', `接口返回了无法识别的内容（HTTP ${res.status}）`, platform)
  }
}
