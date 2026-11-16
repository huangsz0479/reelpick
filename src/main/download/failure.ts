import type { DownloadErrorCode } from '@shared/types'

export class DownloadError extends Error {
  constructor(
    readonly code: DownloadErrorCode,
    message: string
  ) {
    super(message)
  }
}

export interface DownloadFailure {
  code: DownloadErrorCode
  message: string
  retryable: boolean
}

const RETRYABLE: Record<DownloadErrorCode, boolean> = {
  expired: false,
  network: true,
  server: true,
  disk_full: true,
  permission: false,
  merge: false,
  unknown: true
}

export function httpFailure(status: number): DownloadError {
  return status === 429 || status >= 500
    ? new DownloadError('server', `平台服务器暂时出错（HTTP ${status}），请稍后重试`)
    : new DownloadError('expired', `下载地址已失效（HTTP ${status}），请重新解析链接后再下载`)
}

/** 把下载过程中的任意错误归类，给出用户能看懂的说明；不包含下载地址和请求头 */
export function describeFailure(e: unknown): DownloadFailure {
  const failure = (code: DownloadErrorCode, message: string) => ({ code, message, retryable: RETRYABLE[code] })
  if (e instanceof DownloadError) return failure(e.code, e.message)
  const fsCode = (e as NodeJS.ErrnoException | null)?.code
  if (fsCode === 'ENOSPC') return failure('disk_full', '磁盘空间不足，请清理空间后重试')
  if (fsCode === 'EACCES' || fsCode === 'EPERM' || fsCode === 'EROFS')
    return failure('permission', '没有权限写入保存位置，请在设置里更改保存位置后重新下载')
  const text = e instanceof Error ? `${e.name} ${e.message} ${String((e.cause as Error | undefined)?.message ?? '')}` : String(e)
  if (/fetch failed|net::ERR_|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket|terminated|network/i.test(text))
    return failure('network', '网络中断，请检查网络后重试')
  return failure('unknown', `下载失败：${e instanceof Error ? e.message : String(e)}`)
}
