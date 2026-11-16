import { createDecipheriv } from 'node:crypto'
import { open } from 'node:fs/promises'
import { parseSegments, type ByteRange, type SegmentPlan } from '../parsers/m3u8/playlist'
import type { FetchLike } from '../parsers/types'
import { allOrAbort } from './concurrent'
import { DownloadError } from './failure'
import { byLine, runFfmpeg } from './ffmpeg'

export interface HlsProgress {
  /** 已下载的字节数 */
  bytes: number
  /** 已处理的时长（秒） */
  seconds: number
  /** 从播放列表算出的总时长；让 ffmpeg 拉流时不知道 */
  totalSeconds?: number
}

export interface HlsDeps {
  ffmpegPath: string
  fetch: FetchLike
  /** 一个请求这么久没收到数据就放弃重试 */
  stallTimeoutMs: number
}

export interface HlsPaths {
  /** 每路流（视频、音频）拼好的分片各存一个临时文件 */
  parts: string[]
  /** 封装好的 MP4 */
  out: string
}

export interface HlsEvents {
  progress: (progress: HlsProgress) => void
  /** 分片都下完了，开始封装成 MP4 */
  remuxing: () => void
}

/** 同时下载的分片数 */
const CONCURRENCY = 8
/** 下好的分片要按顺序写进文件；最前面那个迟迟下不完时，后面最多先下这么多个放在内存里 */
const WINDOW = 32
const ATTEMPTS = 3
const PLAYLIST_TIMEOUT_MS = 15_000

const LOST = '文件不完整，没有保留'

/**
 * 下载 m3u8 视频流并封装成 MP4。分片自己并发下载（走应用的网络栈，跟随系统代理），
 * 下完后在本地用 ffmpeg 封装；播放列表不适合这样拼接时，整个交给 ffmpeg 去拉。
 * inputs 有两个时第一个是视频、第二个是音频。
 */
export async function downloadHls(
  deps: HlsDeps,
  inputs: string[],
  headers: Record<string, string>,
  paths: HlsPaths,
  signal: AbortSignal,
  events: HlsEvents
): Promise<void> {
  const loaded = await Promise.all(inputs.map((url) => loadPlan(deps, url, headers, signal)))
  const plans = loaded.filter((plan) => plan !== null)
  if (plans.length < inputs.length) return pullWithFfmpeg(deps.ffmpegPath, inputs, headers, paths.out, signal, events.progress)

  const totalSeconds = Math.max(...plans.map((plan) => plan.duration))
  const totalSegments = plans.reduce((sum, plan) => sum + plan.segments.length, 0)
  let bytes = 0
  let segments = 0
  const onSegment = (size: number) => {
    bytes += size
    segments++
    events.progress({ bytes, seconds: (segments / totalSegments) * totalSeconds, totalSeconds })
  }
  const abort = new AbortController()
  const all = AbortSignal.any([signal, abort.signal])
  await allOrAbort(plans.map((plan, i) => fetchSegments(deps, plan, headers, paths.parts[i]!, all, onSegment)), abort)

  events.remuxing()
  const files = paths.parts.slice(0, plans.length)
  const maps = files.length > 1 ? ['-map', '0:v:0', '-map', '1:a:0'] : []
  const args = ['-y', '-v', 'error', ...files.flatMap((file) => ['-i', file]), ...maps, '-c', 'copy', '-movflags', '+faststart', '-f', 'mp4', paths.out]
  const { code, stderr } = await runFfmpeg(deps.ffmpegPath, args, signal, '视频没有封装成 MP4')
  if (code !== 0) throw new DownloadError('merge', `视频流封装成 MP4 失败：${stderr.trim().split('\n').pop() || `ffmpeg 退出码 ${code}`}`)
}

/** 读不到或不适合自己拼接时返回 null */
async function loadPlan(deps: HlsDeps, url: string, headers: Record<string, string>, signal: AbortSignal): Promise<SegmentPlan | null> {
  try {
    const res = await deps.fetch(url, { headers, signal: AbortSignal.any([signal, AbortSignal.timeout(PLAYLIST_TIMEOUT_MS)]) })
    if (!res.ok) {
      void res.body?.cancel().catch(() => {})
      return null
    }
    return parseSegments(await res.text(), url)
  } catch (e) {
    if (signal.aborted) throw e
    return null
  }
}

/** 并发下载一个播放列表的全部分片，按顺序写进 dest */
async function fetchSegments(
  deps: HlsDeps,
  plan: SegmentPlan,
  headers: Record<string, string>,
  dest: string,
  signal: AbortSignal,
  onSegment: (bytes: number) => void
): Promise<void> {
  const keys = new Map<string, Promise<Buffer>>()
  const keyFor = (url: string) => {
    if (!keys.has(url)) keys.set(url, fetchBytes(deps, url, headers, undefined, signal))
    return keys.get(url)!
  }
  const fetchSegment = async (index: number): Promise<Buffer> => {
    const segment = plan.segments[index]!
    const data = await fetchBytes(deps, segment.url, headers, segment.range, signal)
    if (!segment.key) return data
    const key = await keyFor(segment.key.url)
    try {
      const decipher = createDecipheriv('aes-128-cbc', key, segment.key.iv)
      return Buffer.concat([decipher.update(data), decipher.final()])
    } catch {
      throw new DownloadError('unknown', `视频流解密失败，${LOST}。可以重新解析后再试一次`)
    }
  }

  const file = await open(dest, 'w')
  try {
    if (plan.init) await file.writeFile(await fetchBytes(deps, plan.init.url, headers, plan.init.range, signal))
    await inOrder(plan.segments.length, signal, fetchSegment, async (data) => {
      await file.writeFile(data)
      onSegment(data.byteLength)
    })
  } finally {
    await file.close()
  }
}

/** 并发取第 0 到 count-1 项，取到的结果严格按序号交给 write */
async function inOrder(count: number, signal: AbortSignal, fetchItem: (index: number) => Promise<Buffer>, write: (data: Buffer) => Promise<void>): Promise<void> {
  const ready = new Map<number, Buffer>()
  let next = 0
  let written = 0
  let waiters: (() => void)[] = []
  const wake = () => {
    for (const resume of waiters.splice(0)) resume()
  }
  let flushing = Promise.resolve()
  const flush = () =>
    (flushing = flushing.then(async () => {
      for (let data = ready.get(written); data; data = ready.get(written)) {
        ready.delete(written)
        await write(data)
        written++
      }
      wake()
    }))
  const worker = async () => {
    while (next < count) {
      signal.throwIfAborted()
      if (next - written >= WINDOW) {
        await new Promise<void>((resume) => waiters.push(resume))
        continue
      }
      const index = next++
      ready.set(index, await fetchItem(index))
      await flush()
    }
  }
  const abort = new AbortController()
  // 等着写入位置前移的那些要叫醒，它们才会发现已经取消
  const all = AbortSignal.any([signal, abort.signal])
  all.addEventListener('abort', wake)
  try {
    await allOrAbort(Array.from({ length: Math.min(CONCURRENCY, count) }, worker), abort)
  } finally {
    all.removeEventListener('abort', wake)
  }
}

/** 取一个分片（或密钥、初始化段）的全部内容，网络问题重试几次 */
async function fetchBytes(deps: HlsDeps, url: string, headers: Record<string, string>, range: ByteRange | undefined, signal: AbortSignal): Promise<Buffer> {
  const requestHeaders = range ? { ...headers, Range: `bytes=${range.start}-${range.end}` } : headers
  for (let attempt = 1; ; attempt++) {
    // 连接或传输停滞超过时限就放弃这一次：Chromium 的网络栈遇到不再发数据的连接会一直等下去
    const stall = new AbortController()
    const watchdog = setTimeout(() => stall.abort(), deps.stallTimeoutMs)
    let refused = 0
    try {
      const res = await deps.fetch(url, { headers: requestHeaders, signal: AbortSignal.any([signal, stall.signal]) })
      if (!res.ok || !res.body) {
        void res.body?.cancel().catch(() => {})
        refused = res.status
        throw new Error(`HTTP ${res.status}`)
      }
      const chunks: Uint8Array[] = []
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        watchdog.refresh()
        chunks.push(chunk)
      }
      const data = Buffer.concat(chunks)
      if (data.byteLength === 0) throw new Error('empty')
      return data
    } catch (e) {
      if (signal.aborted) throw e
      // 服务器明确拒绝（多半是地址里的凭证过期了），原样重试没有用
      if (refused >= 400 && refused < 500 && refused !== 408 && refused !== 429)
        throw new DownloadError('expired', `视频流有内容服务器不再提供（HTTP ${refused}），${LOST}。请重新解析后再下载`)
      if (attempt >= ATTEMPTS) throw new DownloadError('network', `视频流有内容没有下载下来，${LOST}。请检查网络后重试`)
      await new Promise((resume) => setTimeout(resume, 300 * attempt))
    } finally {
      clearTimeout(watchdog)
    }
  }
}

/** 分片下不到或传到一半断开时，ffmpeg 只是跳过它并照常以成功退出，这两条日志是唯一的迹象 */
const LOST_SEGMENT = /failed too many times, skipping|Stream ends prematurely/
/** 服务器拒绝了请求（多半是地址里的凭证过期了），原样重试没有用 */
const REFUSED = /HTTP error 4\d\d/

/** 让 ffmpeg 拉取 m3u8（分片下载、AES-128 解密都由它完成），不转码直接封装成 MP4。它一次只下一个分片，只在自己下不了时用 */
async function pullWithFfmpeg(
  ffmpegPath: string,
  inputs: string[],
  headers: Record<string, string>,
  outPath: string,
  signal: AbortSignal,
  onProgress: (progress: HlsProgress) => void
): Promise<void> {
  const { 'User-Agent': userAgent, ...rest } = headers
  const headerLines = Object.entries(rest).map(([k, v]) => `${k}: ${v}\r\n`).join('')
  const input = (url: string) => [
    '-rw_timeout', '30000000',
    ...(userAgent ? ['-user_agent', userAgent] : []),
    ...(headerLines ? ['-headers', headerLines] : []),
    '-i', url
  ]
  // 两个输入时第一个是视频、第二个是音频
  const maps = inputs.length > 1 ? ['-map', '0:v:0', '-map', '1:a:0'] : []
  // 被跳过的分片只在 warning 级别的日志里出现
  const args = ['-y', '-v', 'warning', '-nostats', '-progress', 'pipe:1', ...inputs.flatMap(input), ...maps, '-c', 'copy', '-movflags', '+faststart', '-f', 'mp4', outPath]

  const progress: HlsProgress = { bytes: 0, seconds: 0 }
  let lost = 0
  let refused = false
  const { code, stderr } = await runFfmpeg(ffmpegPath, args, signal, '视频流没有下载', {
    stdout: byLine((line) => {
      const [key, value] = line.trim().split('=')
      if (key === 'total_size') progress.bytes = Number(value) || progress.bytes
      else if (key === 'out_time_us') progress.seconds = Number(value) / 1e6 || progress.seconds
      else if (key === 'progress') onProgress({ ...progress })
    }),
    stderr: byLine((line) => {
      if (LOST_SEGMENT.test(line)) lost++
      else if (REFUSED.test(line)) refused = true
    })
  })

  if (code === 0) {
    if (!lost) return
    throw refused
      ? new DownloadError('expired', `视频流有 ${lost} 段内容服务器不再提供，文件不完整，没有保留。请重新解析后再下载`)
      : new DownloadError('network', `视频流有 ${lost} 段内容没有下载下来，文件不完整，没有保留。请检查网络后重试`)
  }
  const detail = stderr.trim().split('\n').pop() ?? ''
  if (/Server returned 4\d\d|403 Forbidden|404 Not Found|401 Unauthorized/i.test(stderr))
    throw new DownloadError('expired', '视频流地址已失效或拒绝访问，请重新解析后再下载')
  if (/Server returned 5\d\d/i.test(stderr)) throw new DownloadError('server', '视频服务器暂时出错，请稍后重试')
  if (/timed out|Connection (refused|reset)|Failed to resolve|Network is unreachable|I\/O error|Error in the pull function/i.test(stderr))
    throw new DownloadError('network', '网络中断，请检查网络后重试')
  if (/No space left/i.test(stderr)) throw new DownloadError('disk_full', '磁盘空间不足，请清理空间后重试')
  throw new DownloadError('unknown', `视频流下载失败：${detail || `ffmpeg 退出码 ${code}`}`)
}
