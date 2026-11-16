import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { mkdir, open, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { DownloadRequest, DownloadTask, StreamRef } from '@shared/types'
import type { FetchLike } from '../parsers/types'
import { allOrAbort } from './concurrent'
import { DownloadError, describeFailure, httpFailure } from './failure'
import { mergeStreams } from './ffmpeg'
import { sanitizeExt, sanitizeFileName, uniquePath } from './filename'
import { downloadHls } from './hls'

const MAX_CONCURRENT = 3
const PROGRESS_INTERVAL_MS = 500
/** 这么久没收到数据就放弃当前地址，和 ffmpeg 拉流用的 rw_timeout 一致 */
const STALL_TIMEOUT_MS = 30_000

export interface DownloadDeps {
  fetch: FetchLike
  ffmpegPath: string
  downloadDir: () => string
  onChange: (tasks: DownloadTask[]) => void
  /** 下载记录保存在这个文件里，下次启动时读回来；不给就只留在内存里 */
  historyFile?: string
  /** 默认 30 秒，测试里用来缩短等待 */
  stallTimeoutMs?: number
}

interface Entry {
  task: DownloadTask
  /** 上次运行留下的记录没有请求：下载地址和 Cookie 不写进文件，过了一次重启也多半已经失效 */
  request?: DownloadRequest
  abort: AbortController
  /** 上一次运行（含清理临时文件）结束的时刻 */
  settled?: Promise<void>
}

const isActive = (t: DownloadTask) => t.status === 'queued' || t.status === 'downloading' || t.status === 'merging'

/** 写进记录文件的样子。没结束的任务按「被退出打断」记，这样应用崩溃或被强制退出后记录也还在 */
const toRecord = (t: DownloadTask): DownloadTask =>
  isActive(t)
    ? { ...t, status: 'failed', received: 0, total: null, speed: 0, error: '退出应用时还没下载完，请重新解析链接后再下载', retryable: false }
    : { ...t, speed: 0 }

export class DownloadManager {
  private entries = new Map<string, Entry>()
  private reserved = new Set<string>()
  private running = 0

  private savedHistory = ''

  constructor(private deps: DownloadDeps) {
    if (!deps.historyFile) return
    try {
      this.savedHistory = readFileSync(deps.historyFile, 'utf8')
      for (const task of JSON.parse(this.savedHistory) as DownloadTask[])
        this.entries.set(task.id, { task: { ...toRecord(task), retryable: false }, abort: new AbortController() })
    } catch {
      // 首次启动或文件损坏时从空列表开始
      this.entries.clear()
    }
  }

  list(): DownloadTask[] {
    return [...this.entries.values()].map((e) => ({ ...e.task })).reverse()
  }

  get(id: string): DownloadTask | undefined {
    return this.entries.get(id)?.task
  }

  enqueue(request: DownloadRequest): DownloadTask {
    const task: DownloadTask = {
      id: randomUUID(),
      platform: request.platform,
      title: request.title,
      label: request.label,
      cover: request.cover,
      status: 'queued',
      received: 0,
      total: request.expectedSize ?? null,
      speed: 0,
      createdAt: Date.now()
    }
    this.entries.set(task.id, { task, request, abort: new AbortController() })
    this.pump()
    return task
  }

  cancel(id: string): void {
    const entry = this.entries.get(id)
    if (!entry || !isActive(entry.task)) return
    const wasQueued = entry.task.status === 'queued'
    entry.task.status = 'cancelled'
    entry.task.speed = 0
    entry.abort.abort()
    if (wasQueued) this.changed()
  }

  /** 重新下载失败或已取消的任务，沿用原来的请求 */
  retry(id: string): void {
    const entry = this.entries.get(id)
    const request = entry?.request
    if (!entry || !request || (entry.task.status !== 'failed' && entry.task.status !== 'cancelled')) return
    // 取消后的清理可能还没结束，等它结束再重新排队
    void (entry.settled ?? Promise.resolve()).then(() => {
      if (!this.entries.has(id) || isActive(entry.task)) return
      entry.abort = new AbortController()
      Object.assign(entry.task, {
        status: 'queued', received: 0, total: request.expectedSize ?? null, speed: 0,
        error: undefined, errorCode: undefined, retryable: undefined
      })
      this.pump()
    })
  }

  /** 从列表移除已结束的任务，不删除文件 */
  remove(id: string): void {
    const entry = this.entries.get(id)
    if (!entry || isActive(entry.task)) return
    this.entries.delete(id)
    this.changed()
  }

  clearFinished(): void {
    for (const [id, e] of this.entries) if (!isActive(e.task)) this.entries.delete(id)
    this.changed()
  }

  hasActive(): boolean {
    return [...this.entries.values()].some((e) => isActive(e.task))
  }

  /** 取消所有没结束的任务，等 ffmpeg 退出、临时文件清理完再返回。退出应用前调用 */
  async shutdown(): Promise<void> {
    const active = [...this.entries.values()].filter((e) => isActive(e.task))
    for (const e of active) this.cancel(e.task.id)
    await Promise.all(active.map((e) => e.settled))
  }

  private changed(): void {
    this.saveHistory()
    this.deps.onChange(this.list())
  }

  /** 进度变化不改变记录的内容，只有任务增减或结束时才真的写文件 */
  private saveHistory(): void {
    const file = this.deps.historyFile
    if (!file) return
    const history = JSON.stringify([...this.entries.values()].map((e) => toRecord(e.task)))
    if (history === this.savedHistory) return
    try {
      mkdirSync(dirname(file), { recursive: true })
      // 先写临时文件再改名：写到一半退出也不会留下一份坏的记录
      writeFileSync(`${file}.tmp`, history)
      renameSync(`${file}.tmp`, file)
      this.savedHistory = history
    } catch {
      // 记录存不下来不影响下载本身，下次变化时再试
    }
  }

  private pump(): void {
    for (const entry of this.entries.values()) {
      if (this.running >= MAX_CONCURRENT) break
      const { request } = entry
      if (entry.task.status !== 'queued' || !request) continue
      this.running++
      entry.settled = this.run(entry, request).finally(() => {
        this.running--
        this.pump()
      })
    }
    this.changed()
  }

  private async run({ task, abort }: Entry, request: DownloadRequest): Promise<void> {
    const root = this.deps.downloadDir()
    const dir = request.subDir ? join(root, sanitizeFileName(request.subDir)) : root
    const finalPath = uniquePath(dir, sanitizeFileName(request.fileName), sanitizeExt(request.ext), this.reserved)
    this.reserved.add(finalPath)
    // 中间文件都带 .part 后缀，最终文件只在内容完整之后才出现
    const videoPart = `${finalPath}.video.part`
    const audioPart = `${finalPath}.audio.part`
    const mergedPart = `${finalPath}.part`

    task.status = 'downloading'
    let lastReceived = 0
    const timer = setInterval(() => {
      task.speed = ((task.received - lastReceived) * 1000) / PROGRESS_INTERVAL_MS
      lastReceived = task.received
      this.changed()
    }, PROGRESS_INTERVAL_MS)

    try {
      await mkdir(dir, { recursive: true })
      if (request.hls) {
        const inputs = [request.source.url, ...(request.audio ? [request.audio.url] : [])]
        const deps = { ffmpegPath: this.deps.ffmpegPath, fetch: this.deps.fetch, stallTimeoutMs: this.deps.stallTimeoutMs ?? STALL_TIMEOUT_MS }
        await downloadHls(deps, inputs, request.headers, { parts: [videoPart, audioPart], out: mergedPart }, abort.signal, {
          progress: ({ bytes, seconds, totalSeconds }) => {
            task.received = bytes
            // 按已处理的时长推算总大小，界面才能显示百分比
            const duration = totalSeconds ?? request.duration
            const fraction = duration ? Math.min(1, seconds / duration) : 0
            task.total = fraction > 0.01 ? Math.max(bytes, Math.round(bytes / fraction)) : (request.expectedSize ?? null)
          },
          remuxing: () => {
            if (abort.signal.aborted) return
            task.status = 'merging'
            task.speed = 0
            this.changed()
          }
        })
        task.total = task.received
        await rename(mergedPart, finalPath)
      } else {
        const parts: [StreamRef, string][] = [[request.source, videoPart]]
        if (request.audio) parts.push([request.audio, audioPart])
        // 解析时的大小可能只是估算；每个文件的真实大小都知道后就换成真实的
        const sizes: (number | null)[] = parts.map(() => null)
        const fetchPart = ([ref, dest]: [StreamRef, string], index: number) =>
          this.fetchToFile(ref, dest, request.headers, abort.signal, (bytes) => (task.received += bytes), (size) => {
            sizes[index] = size
            const known = sizes.filter((n) => n !== null)
            task.total = known.length === sizes.length ? known.reduce((sum, n) => sum + n, 0) : (request.expectedSize ?? null)
          })
        await allOrAbort(parts.map(fetchPart), abort)
        task.total = task.received
        if (request.audio) {
          task.status = 'merging'
          task.speed = 0
          this.changed()
          await mergeStreams(this.deps.ffmpegPath, videoPart, audioPart, mergedPart, abort.signal)
          await rename(mergedPart, finalPath)
        } else {
          await rename(videoPart, finalPath)
        }
      }
      task.status = 'done'
      task.filePath = finalPath
    } catch (e) {
      abort.abort()
      // cancel() 会在下载过程中把状态改成 cancelled，这里的类型收窄看不到那次修改
      if ((task.status as DownloadTask['status']) !== 'cancelled') {
        const failure = describeFailure(e)
        task.status = 'failed'
        task.error = failure.message
        task.errorCode = failure.code
        task.retryable = failure.retryable
      }
    } finally {
      clearInterval(timer)
      task.speed = 0
      // 清理不了（例如文件被别的程序占用）不应该改变任务的结果
      await Promise.allSettled([videoPart, audioPart, mergedPart].map((part) => rm(part, { force: true })))
      this.reserved.delete(finalPath)
      this.changed()
    }
  }

  /** 依次尝试主地址和备用地址，把内容写进 dest */
  private async fetchToFile(
    ref: StreamRef,
    dest: string,
    headers: Record<string, string>,
    signal: AbortSignal,
    onBytes: (n: number) => void,
    /** 服务器报出的文件大小；不知道或这个地址失败时为 null */
    onSize: (size: number | null) => void
  ): Promise<void> {
    let lastError: unknown = new DownloadError('expired', '没有可用的下载地址，请重新解析链接后再下载')
    for (const url of [ref.url, ...(ref.backupUrls ?? [])]) {
      let written = 0
      // 连接或传输停滞超过时限就放弃这个地址：Chromium 的网络栈遇到不再发数据的连接会一直等下去
      const stall = new AbortController()
      const watchdog = setTimeout(() => stall.abort(), this.deps.stallTimeoutMs ?? STALL_TIMEOUT_MS)
      try {
        const res = await this.deps.fetch(url, { headers, signal: AbortSignal.any([signal, stall.signal]) })
        const refused =
          !res.ok || !res.body
            ? httpFailure(res.status)
            : /^(text\/html|application\/json)/i.test(res.headers.get('content-type') ?? '')
              ? new DownloadError('expired', '下载地址返回的不是媒体文件，链接可能已过期，请重新解析后再下载')
              : null
        if (refused) {
          void res.body?.cancel().catch(() => {})
          throw refused
        }
        const length = Number(res.headers.get('content-length'))
        onSize(length > 0 && !res.headers.get('content-encoding') ? length : null)
        // 逐块等待写入完成：写入出错（没有权限、磁盘满）会在这里抛出，归类成任务失败
        const file = await open(dest, 'w')
        try {
          for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
            watchdog.refresh()
            await file.writeFile(chunk)
            written += chunk.byteLength
            onBytes(chunk.byteLength)
          }
        } finally {
          await file.close()
        }
        if (written === 0) throw new DownloadError('server', '下载到的文件是空的，请稍后重试')
        return
      } catch (e) {
        if (signal.aborted) throw e
        onBytes(-written)
        onSize(null)
        lastError = stall.signal.aborted ? new DownloadError('network', '下载长时间没有收到数据，可能是网络中断，请检查网络后重试') : e
      } finally {
        clearTimeout(watchdog)
      }
    }
    throw lastError
  }
}
