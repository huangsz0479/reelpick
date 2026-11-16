import { spawn } from 'node:child_process'
import { DownloadError } from './failure'

export interface FfmpegExit {
  code: number | null
  /** 输出的最后一段，用来说明失败原因 */
  stderr: string
}

export interface FfmpegOutput {
  stdout?: (text: string) => void
  stderr?: (text: string) => void
}

/** 把分块到达的输出按行交给 handle */
export function byLine(handle: (line: string) => void): (text: string) => void {
  let pending = ''
  return (text) => {
    const lines = (pending + text).split('\n')
    pending = lines.pop() ?? ''
    for (const line of lines) handle(line)
  }
}

/**
 * 运行 ffmpeg，等进程真正退出后才返回：调用方接下来要删除或改名它的输出文件，
 * 而 Windows 不允许删除还被别的进程打开的文件。
 * 取消时直接杀掉进程，输出文件反正要删，不需要它收尾。
 */
export function runFfmpeg(
  ffmpegPath: string,
  args: string[],
  signal: AbortSignal,
  /** 启动失败时写进错误信息，说明哪件事没做成 */
  notDone: string,
  output: FfmpegOutput = {}
): Promise<FfmpegExit> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { signal, killSignal: 'SIGKILL', windowsHide: true })
    let stderr = ''
    let failure: Error | undefined
    child.stdout.on('data', (chunk: Buffer) => output.stdout?.(chunk.toString()))
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      stderr = (stderr + text).slice(-2000)
      output.stderr?.(text)
    })
    // 启动失败和被取消都先触发 error，进程结束后才触发 close
    child.on('error', (e) => (failure = e))
    child.on('close', (code) => {
      if (!failure) return resolve({ code, stderr })
      reject(signal.aborted ? failure : new DownloadError('merge', `无法启动 ffmpeg，${notDone}：${failure.message}`))
    })
  })
}

export async function mergeStreams(
  ffmpegPath: string,
  videoPath: string,
  audioPath: string,
  outPath: string,
  signal: AbortSignal
): Promise<void> {
  // 输出先写到带 .part 后缀的临时文件，ffmpeg 没法从扩展名判断格式，所以显式指定
  const args = ['-y', '-v', 'error', '-i', videoPath, '-i', audioPath, '-c', 'copy', '-movflags', '+faststart', '-f', 'mp4', outPath]
  const { code, stderr } = await runFfmpeg(ffmpegPath, args, signal, '音视频没有合并')
  if (code !== 0) throw new DownloadError('merge', `音视频合并失败：${stderr.trim() || `ffmpeg 退出码 ${code}`}`)
}
