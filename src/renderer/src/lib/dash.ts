import { readSegmentIndex, type Segment, type SegmentIndex } from './mp4'

export interface DashTrack {
  /** vt-media:// 预览地址 */
  url: string
  /** 带 codecs 的 MIME */
  mime: string
}

/** 播放位置之后缓冲这么多秒 */
const AHEAD_SECONDS = 30
/** 先读文件开头这么多字节找分片索引，不够再按索引的实际长度重读 */
const HEAD_BYTES = 64 * 1024
/** 预读时一次请求至少取这么多字节：音频分片只有一百多 KB，一个个请求的话时间都花在等响应上 */
const BATCH_BYTES = 1024 * 1024

/** 看分片的中点在不在已缓冲的范围里：浏览器回收过的分片不算 */
function isBuffered(segment: Segment, buffered: [number, number][]): boolean {
  const middle = segment.time + segment.duration / 2
  return buffered.some(([from, to]) => middle >= from && middle < to)
}

/**
 * 下一批要下载的分片，返回首尾的序号。从播放位置起、预读范围内还没缓冲的第一个分片开始。
 * 播放位置上还没有数据时只取这一个，画面能尽快出来；已经有数据、是在预读时，
 * 接上后面连续缺的，凑够一次请求的量。没有要下的返回 null
 */
export function nextBatch(segments: Segment[], buffered: [number, number][], position: number): [first: number, last: number] | null {
  const wanted = (s: Segment | undefined): s is Segment => !!s && s.time < position + AHEAD_SECONDS && !isBuffered(s, buffered)
  const first = segments.findIndex((s) => s.time + s.duration > position && wanted(s))
  if (first === -1) return null
  let last = first
  if (buffered.some(([from, to]) => position >= from && position < to))
    while (wanted(segments[last + 1]) && segments[last]!.end - segments[first]!.start + 1 < BATCH_BYTES) last++
  return [first, last]
}

async function fetchRange(url: string, start: number, end: number, signal: AbortSignal): Promise<ArrayBuffer> {
  const res = await fetch(url, { headers: { Range: `bytes=${start}-${end}` }, signal })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.arrayBuffer()
}

async function loadIndex(url: string, signal: AbortSignal): Promise<{ index: SegmentIndex; init: ArrayBuffer }> {
  for (let size = HEAD_BYTES; ; ) {
    const head = await fetchRange(url, 0, size - 1, signal)
    const index = readSegmentIndex(head)
    if (!('need' in index)) return { index, init: head.slice(0, index.initSize) }
    // 整个文件都读完了还不够，说明不是预期的结构
    if (index.need <= size || head.byteLength < size) throw new Error('文件里没有分片索引')
    size = index.need
  }
}

function append(buffer: SourceBuffer, data: ArrayBuffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const settle = (finish: () => void) => () => {
      buffer.removeEventListener('updateend', done)
      buffer.removeEventListener('error', failed)
      finish()
    }
    const done = settle(resolve)
    const failed = settle(() => reject(new Error('分片写入失败')))
    buffer.addEventListener('updateend', done)
    buffer.addEventListener('error', failed)
    try {
      buffer.appendBuffer(data)
    } catch (e) {
      settle(() => reject(e))()
    }
  })
}

const bufferedRanges = (buffer: SourceBuffer): [number, number][] =>
  Array.from({ length: buffer.buffered.length }, (_, i) => [buffer.buffered.start(i), buffer.buffered.end(i)])

interface Track {
  url: string
  buffer: SourceBuffer
  segments: Segment[]
  /** 正在下载的那一批：第一个分片的序号，和取消它用的控制器。一路流同时只下一批 */
  fetching?: { first: number; abort: AbortController }
}

/**
 * 音视频分流的版本没法直接交给 <video>：用 MSE 把两路流按播放位置一段段喂进同一个播放器，
 * 这样进度条、音量这些自带的控制都照常能用。
 * 返回的函数停止加载并释放资源。流加载不了或这台电脑不支持时调用 onError。
 */
export function attachDash(video: HTMLVideoElement, sources: DashTrack[], onError: () => void): () => void {
  if (!sources.every((s) => MediaSource.isTypeSupported(s.mime))) {
    onError()
    return () => {}
  }

  const media = new MediaSource()
  const objectUrl = URL.createObjectURL(media)
  const stop = new AbortController()
  const tracks: Track[] = []
  let failed = false

  function fail() {
    if (failed || stop.signal.aborted) return
    failed = true
    onError()
  }

  async function open() {
    const loaded = await Promise.all(sources.map((s) => loadIndex(s.url, stop.signal)))
    if (stop.signal.aborted) return
    // 要先把所有 SourceBuffer 加好，再写入数据：播放器拿到初始化段之后不能再加
    const buffers = sources.map((s) => media.addSourceBuffer(s.mime))
    media.duration = Math.max(...loaded.flatMap(({ index }) => index.segments.slice(-1).map((s) => s.time + s.duration)))
    for (const [i, { index, init }] of loaded.entries()) {
      await append(buffers[i]!, init)
      tracks.push({ url: sources[i]!.url, buffer: buffers[i]!, segments: index.segments })
    }
    // 等播放器读完初始化段：界面会在这个时候跳回切换清晰度之前的位置，从那里开始取才不白下
    if (video.readyState < HTMLMediaElement.HAVE_METADATA)
      await new Promise((resolve) => video.addEventListener('loadedmetadata', resolve, { once: true }))
    if (stop.signal.aborted) return
    video.addEventListener('timeupdate', pump)
    video.addEventListener('seeking', onSeeking)
    pump()
  }

  /** 给一路流补上播放位置附近缺的分片，直到预读范围填满 */
  async function fill(track: Track) {
    // 播放器出错或换了视频后 MediaSource 会关闭，这时读 buffered 会抛错
    if (track.fetching || failed || stop.signal.aborted || media.readyState === 'closed') return
    const batch = nextBatch(track.segments, bufferedRanges(track.buffer), video.currentTime)
    if (!batch) return finish()

    const abort = new AbortController()
    track.fetching = { first: batch[0], abort }
    try {
      const signal = AbortSignal.any([stop.signal, abort.signal])
      // 连续的分片在文件里也是连续的，一次取回来可以整块写入
      await append(track.buffer, await fetchRange(track.url, track.segments[batch[0]]!.start, track.segments[batch[1]]!.end, signal))
    } catch (e) {
      track.fetching = undefined
      // 缓冲区满了：等播放往前走，浏览器回收掉前面的数据再继续
      if (e instanceof DOMException && e.name === 'QuotaExceededError') return
      // 被取消是因为跳到了别的位置或播放器已经关掉，从新的位置重新开始
      if (!abort.signal.aborted) return fail()
    }
    track.fetching = undefined
    void fill(track)
  }

  /** 每路流的最后一个分片都缓冲好了，告诉播放器到头了 */
  function finish() {
    if (media.readyState !== 'open' || tracks.some((t) => t.fetching || t.buffer.updating)) return
    const complete = tracks.every((t) => {
      const last = t.segments.at(-1)
      return !last || isBuffered(last, bufferedRanges(t.buffer))
    })
    if (complete) media.endOfStream()
  }

  function pump() {
    for (const track of tracks) void fill(track)
  }

  /** 跳到别的位置后，正在下的那批如果不是新位置要的就取消 */
  function onSeeking() {
    if (media.readyState === 'closed') return
    for (const track of tracks) {
      const batch = nextBatch(track.segments, bufferedRanges(track.buffer), video.currentTime)
      if (track.fetching && track.fetching.first !== batch?.[0]) track.fetching.abort.abort()
    }
    pump()
  }

  media.addEventListener('sourceopen', () => void open().catch(fail), { once: true })
  video.src = objectUrl

  return () => {
    stop.abort()
    video.removeEventListener('timeupdate', pump)
    video.removeEventListener('seeking', onSeeking)
    URL.revokeObjectURL(objectUrl)
  }
}
