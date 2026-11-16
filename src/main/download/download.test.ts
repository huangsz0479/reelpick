import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ffmpegPath from 'ffmpeg-static'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import type { DownloadRequest, DownloadTask } from '@shared/types'
import { sanitizeExt, sanitizeFileName, uniquePath } from './filename'
import { DownloadManager, type DownloadDeps } from './manager'

describe('sanitizeFileName', () => {
  test.each([
    ['a/b:c*d?"e<f>g|h', 'a b c d e f g h'],
    ['  结尾有点...  ', '结尾有点'],
    ['CON', '_CON'],
    ['///', '未命名'],
    ['...开头有点', '开头有点'],
    ['..', '未命名'],
    ['😀'.repeat(150), '😀'.repeat(60)]
  ])('%s', (input, expected) => {
    expect(sanitizeFileName(input)).toBe(expected)
  })
})

test.each([
  ['mp4', 'mp4'],
  ['JPG', 'JPG'],
  ['../../evil', 'bin'],
  ['a.b', 'bin'],
  ['', 'bin']
])('sanitizeExt %s', (input, expected) => {
  expect(sanitizeExt(input)).toBe(expected)
})

test('uniquePath avoids existing and reserved names', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vt-'))
  const first = uniquePath(dir, 'a', 'mp4', new Set())
  expect(first).toBe(join(dir, 'a.mp4'))
  expect(uniquePath(dir, 'a', 'mp4', new Set([first]))).toBe(join(dir, 'a (1).mp4'))
})

describe('DownloadManager', () => {
  const ffmpeg = ffmpegPath!
  const fixtures = mkdtempSync(join(tmpdir(), 'vt-fixtures-'))
  const outDir = mkdtempSync(join(tmpdir(), 'vt-out-'))
  let server: Server
  let base: string
  let hangRequests = 0
  let flakyRequests = 0
  let slowInFlight = 0
  let slowPeak = 0

  beforeAll(async () => {
    const gen = (args: string[]) => execFileSync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', ...args])
    gen(['-i', 'testsrc=size=160x120:rate=10:duration=1', '-pix_fmt', 'yuv420p', join(fixtures, 'video.mp4')])
    gen(['-i', 'sine=frequency=440:duration=1', join(fixtures, 'audio.m4a')])
    gen(['-i', 'testsrc=size=160x120:rate=10:duration=3', '-pix_fmt', 'yuv420p', '-g', '10', '-f', 'hls', '-hls_time', '1', '-hls_playlist_type', 'vod', '-hls_segment_filename', join(fixtures, 'v%d.ts'), join(fixtures, 'video.m3u8')])
    gen(['-i', 'sine=frequency=440:duration=3', '-f', 'hls', '-hls_time', '1', '-hls_playlist_type', 'vod', '-hls_segment_filename', join(fixtures, 'a%d.ts'), join(fixtures, 'audio.m3u8')])
    // 加密的流（AES-128）和所有分片放在同一个文件里、按字节范围取的流
    writeFileSync(join(fixtures, 'enc.key'), Buffer.from('0123456789abcdef'))
    writeFileSync(join(fixtures, 'enc.keyinfo'), `enc.key\n${join(fixtures, 'enc.key')}\n`)
    gen(['-i', 'testsrc=size=160x120:rate=10:duration=3', '-pix_fmt', 'yuv420p', '-g', '10', '-f', 'hls', '-hls_time', '1', '-hls_playlist_type', 'vod', '-hls_key_info_file', join(fixtures, 'enc.keyinfo'), '-hls_segment_filename', join(fixtures, 'e%d.ts'), join(fixtures, 'enc.m3u8')])
    gen(['-i', 'testsrc=size=160x120:rate=10:duration=3', '-pix_fmt', 'yuv420p', '-g', '10', '-f', 'hls', '-hls_time', '1', '-hls_playlist_type', 'vod', '-hls_flags', 'single_file', join(fixtures, 'single.m3u8')])
    server = createServer((req, res) => {
      const name = req.url!.slice(1)
      if (name === 'hang') {
        hangRequests++
        res.writeHead(200, { 'content-type': 'video/mp4' })
        res.write('x')
        return
      }
      if (name === 'flaky' && flakyRequests++ === 0) return void res.writeHead(503).end()
      if (name === 'flaky') return void res.writeHead(200, { 'content-type': 'video/mp4' }).end('data')
      if (name === 'expired') return void res.writeHead(200, { 'content-type': 'text/html' }).end('<html>')
      if (name === 'trickle' || name === 'sized') {
        // 数据陆续到达，像真实的下载；sized 额外报出总大小
        res.writeHead(200, { 'content-type': 'video/mp4', ...(name === 'sized' ? { 'content-length': '8000' } : {}) })
        let sent = 0
        const timer = setInterval(() => (++sent > 8 ? (clearInterval(timer), res.end()) : res.write('x'.repeat(1000))), name === 'sized' ? 100 : 40)
        return void res.on('close', () => clearInterval(timer))
      }
      if (name === 'garbage') return void res.writeHead(200, { 'content-type': 'video/mp4' }).end('not a media file')
      // 同一个视频流的三种变体：缺一个分片、一个分片传到一半断开、每个分片都很慢
      const variant = /^(gap|cut|slow)\.m3u8$/.exec(name)?.[1]
      if (variant) return void res.writeHead(200).end(readFileSync(join(fixtures, 'video.m3u8'), 'utf8').replaceAll(/^v(\d)\.ts$/gm, `${variant}-v$1.ts`))
      if (name === 'gap-v1.ts') return void res.writeHead(404).end()
      if (name === 'cut-v1.ts') {
        res.writeHead(200, { 'content-length': String(statSync(join(fixtures, 'v1.ts')).size) })
        res.write(readFileSync(join(fixtures, 'v1.ts')).subarray(0, 200))
        return void setTimeout(() => res.destroy(), 50)
      }
      const segment = /^(?:gap|cut|slow)-(v\d\.ts)$/.exec(name)?.[1]
      if (segment && name.startsWith('slow')) {
        slowPeak = Math.max(slowPeak, ++slowInFlight)
        res.on('close', () => slowInFlight--)
      }
      if (segment) return void setTimeout(() => res.writeHead(200).end(readFileSync(join(fixtures, segment))), name.startsWith('slow') ? 400 : 0)
      if (!existsSync(join(fixtures, name))) return void res.writeHead(404).end()
      if (req.headers.referer !== 'https://example.test/') return void res.writeHead(403).end()
      const range = /bytes=(\d+)-(\d+)/.exec(req.headers.range ?? '')
      if (range) return void res.writeHead(206).end(readFileSync(join(fixtures, name)).subarray(Number(range[1]), Number(range[2]) + 1))
      res.writeHead(200, { 'content-type': 'video/mp4' }).end(readFileSync(join(fixtures, name)))
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterAll(() => {
    server.closeAllConnections()
    server.close()
  })

  const baseDeps: Omit<DownloadDeps, 'onChange'> = { fetch: (input, init) => fetch(input, init), ffmpegPath: ffmpeg, downloadDir: () => outDir }
  const baseRequest = (): DownloadRequest => ({
    platform: 'bilibili', title: 't', fileName: 'clip', ext: 'mp4',
    headers: { Referer: 'https://example.test/' }, source: { url: `${base}/video.mp4` }
  })

  /** 下载一个文件，返回它结束时的状态；onUpdate 能看到中途的每次更新 */
  function run(
    request: Partial<DownloadRequest>,
    during?: (m: DownloadManager, id: string) => void,
    deps: Partial<Omit<DownloadDeps, 'onChange'>> = {},
    onUpdate?: (task: DownloadTask) => void
  ) {
    return new Promise<DownloadTask>((resolve) => {
      let id = ''
      const manager = new DownloadManager({
        ...baseDeps,
        ...deps,
        onChange: (tasks) => {
          const task = tasks.find((t) => t.id === id)
          if (task) onUpdate?.(task)
          if (task && ['done', 'failed', 'cancelled'].includes(task.status)) resolve(task)
        }
      })
      id = manager.enqueue({ ...baseRequest(), ...request }).id
      during?.(manager, id)
    })
  }
  const leftovers = () => readdirSync(outDir).filter((f) => f.endsWith('.part'))
  const saved = (prefix: string) => readdirSync(outDir).filter((f) => f.startsWith(prefix))
  /** 命令行里带着这个输出文件名的 ffmpeg 进程是否还在 */
  const ffmpegAlive = (fileName: string) => process.platform !== 'win32' && spawnSync('pgrep', ['-f', fileName]).status === 0

  test('saves a single file and sends the request headers', async () => {
    const task = await run({})
    expect(task).toMatchObject({ status: 'done', filePath: join(outDir, 'clip.mp4') })
    expect(statSync(task.filePath!).size).toBe(statSync(join(fixtures, 'video.mp4')).size)
    expect(task.received).toBe(task.total)
    expect(leftovers()).toEqual([])
  })

  test('merges separate video and audio streams', async () => {
    const task = await run({ fileName: 'merged', audio: { url: `${base}/audio.m4a` } })
    expect(task.status).toBe('done')
    const probe = spawnSync(ffmpeg, ['-i', task.filePath!]).stderr.toString()
    expect(probe).toMatch(/Video: h264/)
    expect(probe).toMatch(/Audio: aac/)
    expect(leftovers()).toEqual([])
  })

  test('saves into a sanitized subfolder', async () => {
    const task = await run({ fileName: '01', subDir: '图集: 标题?' })
    expect(task).toMatchObject({ status: 'done', filePath: join(outDir, '图集 标题', '01.mp4') })
  })

  test('falls back to a backup address', async () => {
    const task = await run({ fileName: 'backup', source: { url: `${base}/missing.mp4`, backupUrls: [`${base}/video.mp4`] } })
    expect(task.status).toBe('done')
    expect(task.received).toBe(statSync(join(fixtures, 'video.mp4')).size)
  })

  test('reports a failure and leaves no files behind', async () => {
    const task = await run({ fileName: 'bad', source: { url: `${base}/expired` } })
    expect(task).toMatchObject({ status: 'failed', errorCode: 'expired', retryable: false, error: expect.stringContaining('过期') })
    expect(readdirSync(outDir).filter((f) => f.startsWith('bad'))).toEqual([])
  })

  test('classifies failures and retries a retryable one', async () => {
    const missing = await run({ fileName: 'gone', source: { url: `${base}/missing.mp4` } })
    expect(missing).toMatchObject({ status: 'failed', errorCode: 'expired', retryable: false })
    const offline = await run({ fileName: 'offline', source: { url: 'http://127.0.0.1:1/x' } })
    expect(offline).toMatchObject({ status: 'failed', errorCode: 'network', retryable: true })

    let retried = false
    const task = await new Promise<DownloadTask>((resolve) => {
      const manager: DownloadManager = new DownloadManager({
        fetch: (input, init) => fetch(input, init),
        ffmpegPath: ffmpeg,
        downloadDir: () => outDir,
        onChange: ([t]) => {
          if (t?.status === 'done') resolve(t)
          if (t?.status !== 'failed' || retried) return
          expect(t).toMatchObject({ errorCode: 'server', retryable: true })
          retried = true
          manager.retry(t.id)
        }
      })
      manager.enqueue({ platform: 'bilibili', title: 't', fileName: 'flaky', ext: 'mp4', headers: {}, source: { url: `${base}/flaky` } })
    })
    expect(retried).toBe(true)
    expect(task).toMatchObject({ status: 'done', error: undefined, errorCode: undefined, received: 4 })
  })

  test('downloads an m3u8 stream with separate audio into one MP4', async () => {
    const task = await run({ fileName: 'hls', hls: true, duration: 3, source: { url: `${base}/video.m3u8` }, audio: { url: `${base}/audio.m3u8` } })
    expect(task).toMatchObject({ status: 'done', filePath: join(outDir, 'hls.mp4') })
    expect(task.received).toBe(task.total)
    expect(task.received).toBeGreaterThan(1000)
    const probe = spawnSync(ffmpeg, ['-i', task.filePath!]).stderr.toString()
    expect(probe).toMatch(/Duration: 00:00:0[23]/)
    expect(probe).toMatch(/Video: h264/)
    expect(probe).toMatch(/Audio: aac/)
    expect(leftovers()).toEqual([])
  })

  test.each([
    ['enc', 'AES-128 encrypted segments'],
    ['single', 'segments that are byte ranges of one file']
  ])('downloads an m3u8 stream with %s (%s)', async (name) => {
    const task = await run({ fileName: `hls-${name}`, hls: true, source: { url: `${base}/${name}.m3u8` } })
    expect(task).toMatchObject({ status: 'done', filePath: join(outDir, `hls-${name}.mp4`) })
    const probe = spawnSync(ffmpeg, ['-i', task.filePath!]).stderr.toString()
    expect(probe).toMatch(/Duration: 00:00:0[23]/)
    expect(probe).toMatch(/Video: h264/)
    expect(leftovers()).toEqual([])
  })

  test('downloads the segments of an m3u8 stream several at a time', async () => {
    slowPeak = 0
    const statuses = new Set<string>()
    const task = await run({ fileName: 'hls-parallel', hls: true, source: { url: `${base}/slow.m3u8` } }, undefined, {}, (t) => statuses.add(t.status))
    expect(task.status).toBe('done')
    expect(slowPeak).toBeGreaterThan(1)
    // 没有给时长也能显示进度：总时长来自播放列表
    expect(statuses).toContain('merging')
  })

  test('reports an unreachable m3u8 stream as expired', async () => {
    const task = await run({ fileName: 'hls-gone', hls: true, source: { url: `${base}/missing.m3u8` } })
    expect(task).toMatchObject({ status: 'failed', errorCode: 'expired', retryable: false })
    expect(readdirSync(outDir).filter((f) => f.startsWith('hls-gone'))).toEqual([])
  })

  test.skipIf(process.platform === 'win32')('reports a folder it cannot write to as a permission failure', async () => {
    const locked = mkdtempSync(join(tmpdir(), 'vt-locked-'))
    chmodSync(locked, 0o555)
    try {
      const task = await run({ fileName: 'locked', source: { url: `${base}/trickle` } }, undefined, { downloadDir: () => locked })
      expect(task).toMatchObject({ status: 'failed', errorCode: 'permission', retryable: false })
    } finally {
      chmodSync(locked, 0o755)
    }
  })

  test.each([
    ['gap', 'a segment the server no longer has', 'expired', false],
    ['cut', 'a segment cut off mid-transfer', 'network', true]
  ] as const)('fails an m3u8 download with %s (%s) instead of saving an incomplete video', async (variant, _what, errorCode, retryable) => {
    const task = await run({ fileName: `hls-${variant}`, hls: true, duration: 3, source: { url: `${base}/${variant}.m3u8` } })
    expect(task).toMatchObject({ status: 'failed', errorCode, retryable, error: expect.stringContaining('不完整') })
    expect(saved(`hls-${variant}`)).toEqual([])
  })

  test('never lets a file extension escape the download folder', async () => {
    const task = await run({ fileName: 'escape', ext: '../../escape' })
    expect(task).toMatchObject({ status: 'done', filePath: join(outDir, 'escape.bin') })
  })

  test('replaces an estimated size with the size the server reports', async () => {
    const totals = new Set<number | null>()
    const task = await run({ fileName: 'sized', expectedSize: 123, source: { url: `${base}/sized` } }, undefined, {}, (t) => {
      if (t.status === 'downloading') totals.add(t.total)
    })
    expect(task).toMatchObject({ status: 'done', received: 8000, total: 8000 })
    // 下载途中显示的是服务器报出的大小，不是解析时的估算值
    expect([...totals]).toEqual([8000])
  })

  test('gives up on a connection that stops sending data', async () => {
    const task = await run({ fileName: 'stalled', source: { url: `${base}/hang` } }, undefined, { stallTimeoutMs: 200 })
    expect(task).toMatchObject({ status: 'failed', errorCode: 'network', retryable: true, error: expect.stringContaining('没有收到数据') })
    expect(saved('stalled')).toEqual([])
  })

  test('moves on to a backup address when the first one stalls', async () => {
    const task = await run({ fileName: 'stalled-backup', source: { url: `${base}/hang`, backupUrls: [`${base}/video.mp4`] } }, undefined, { stallTimeoutMs: 200 })
    expect(task).toMatchObject({ status: 'done', received: statSync(join(fixtures, 'video.mp4')).size })
  })

  test('leaves nothing behind when merging fails', async () => {
    const task = await run({ fileName: 'unmergeable', audio: { url: `${base}/garbage` } })
    expect(task).toMatchObject({ status: 'failed', errorCode: 'merge', retryable: false })
    expect(saved('unmergeable')).toEqual([])
  })

  test('cancelling an m3u8 download stops ffmpeg before reporting back', async () => {
    const task = await run({ fileName: 'hls-cancel', hls: true, duration: 3, source: { url: `${base}/slow.m3u8` } }, (manager, id) => {
      setTimeout(() => manager.cancel(id), 300)
    })
    expect(task.status).toBe('cancelled')
    expect(ffmpegAlive('hls-cancel')).toBe(false)
    expect(saved('hls-cancel')).toEqual([])
  })

  test('shutdown cancels everything and waits for the cleanup', async () => {
    const manager = new DownloadManager({ ...baseDeps, onChange: () => {} })
    const requests: Partial<DownloadRequest>[] = [
      { fileName: 'quit-hls', hls: true, source: { url: `${base}/slow.m3u8` } },
      { fileName: 'quit-file', source: { url: `${base}/trickle` } },
      { fileName: 'quit-merge', source: { url: `${base}/trickle` }, audio: { url: `${base}/trickle` } },
      { fileName: 'quit-queued' }
    ]
    for (const request of requests) manager.enqueue({ ...baseRequest(), ...request })
    await new Promise((r) => setTimeout(r, 300))
    expect(manager.hasActive()).toBe(true)

    await manager.shutdown()

    expect(manager.hasActive()).toBe(false)
    expect(manager.list().map((t) => t.status)).toEqual(['cancelled', 'cancelled', 'cancelled', 'cancelled'])
    expect(ffmpegAlive('quit-hls')).toBe(false)
    expect(saved('quit-')).toEqual([])
  })

  test('keeps finished downloads across restarts', async () => {
    const historyFile = join(mkdtempSync(join(tmpdir(), 'vt-history-')), 'downloads.json')
    const done = await run({ fileName: 'kept' }, undefined, { historyFile })
    expect(done.status).toBe('done')

    const restarted = new DownloadManager({ ...baseDeps, historyFile, onChange: () => {} })
    expect(restarted.list()).toMatchObject([{ id: done.id, status: 'done', filePath: join(outDir, 'kept.mp4'), title: 't' }])

    restarted.remove(done.id)
    expect(new DownloadManager({ ...baseDeps, historyFile, onChange: () => {} }).list()).toEqual([])
  })

  test('a download cut off by the app exiting comes back as failed, without retry', async () => {
    const historyFile = join(mkdtempSync(join(tmpdir(), 'vt-history-')), 'downloads.json')
    const manager = new DownloadManager({ ...baseDeps, historyFile, onChange: () => {} })
    const { id } = manager.enqueue({ ...baseRequest(), fileName: 'cut-off', source: { url: `${base}/trickle` } })
    await new Promise((r) => setTimeout(r, 300))

    const restarted = new DownloadManager({ ...baseDeps, historyFile, onChange: () => {} })
    await manager.shutdown()
    expect(restarted.list()).toMatchObject([{ id, status: 'failed', retryable: false, received: 0, speed: 0 }])
    restarted.retry(id)
    await new Promise((r) => setTimeout(r, 50))
    expect(restarted.list()[0]!.status).toBe('failed')
  })

  test('a damaged history file is ignored', () => {
    const historyFile = join(mkdtempSync(join(tmpdir(), 'vt-history-')), 'downloads.json')
    writeFileSync(historyFile, '{"oops"')
    expect(new DownloadManager({ ...baseDeps, historyFile, onChange: () => {} }).list()).toEqual([])
  })

  test('cancels an in-flight download', async () => {
    const task = await run({ fileName: 'hang', source: { url: `${base}/hang` } }, (manager, id) => {
      const timer = setInterval(() => {
        if (!hangRequests) return
        clearInterval(timer)
        manager.cancel(id)
      }, 20)
    })
    expect(task.status).toBe('cancelled')
    expect(readdirSync(outDir).filter((f) => f.startsWith('hang'))).toEqual([])
  })
})
