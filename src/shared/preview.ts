import type { StreamRef, VideoVariant } from './types'

/** 应用内预览媒体用的自定义协议。平台的媒体地址需要特定请求头，页面无法直接加载，由主进程代为请求。 */
export const PREVIEW_SCHEME = 'vt-media'

export interface PreviewTarget {
  urls: string[]
  headers: Record<string, string>
}

export function previewUrl(stream: StreamRef, headers: Record<string, string>): string {
  const target: PreviewTarget = { urls: [stream.url, ...(stream.backupUrls ?? [])], headers }
  return `${PREVIEW_SCHEME}://preview/?t=${encodeURIComponent(JSON.stringify(target))}`
}

export function parsePreviewUrl(url: string): PreviewTarget | null {
  try {
    const target = JSON.parse(new URL(url).searchParams.get('t') ?? '') as PreviewTarget
    const valid = Array.isArray(target.urls) && target.urls.length > 0 && target.urls.every((u) => /^https?:\/\//.test(u))
    return valid ? target : null
  } catch {
    return null
  }
}

/**
 * 应用内预览依次尝试的版本。所选的清晰度排第一，这样看到的就是要下载的；
 * 它播不了时退回其他版本：单个文件的在前，同类里 H.264 在前（各系统都能解码）。
 * 音视频分流的版本靠 MSE 播放，两路流都要带 MIME；m3u8 不能预览。
 */
export function previewCandidates(variants: VideoVariant[], selectedId: string | undefined): VideoVariant[] {
  const rank = (v: VideoVariant) => (v.id === selectedId ? 0 : (v.audio ? 2 : 0) + (v.codec === 'H.264' ? 1 : 2))
  return variants.filter((v) => !v.hls && (!v.audio || (v.video.mime && v.audio.mime))).sort((a, b) => rank(a) - rank(b))
}
