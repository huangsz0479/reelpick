export function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 KB'
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`
}

export function formatDuration(seconds: number): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`
}

/** 以全角开括号开头的标题向左悬挂半个字：括号左半边是空白，不悬挂的话标题看起来像缩进了 */
export const hangsLeft = (text: string): boolean => /^[「『【《（〔]/.test(text)

/** 片格编号：一组图片里第几张。界面上显示的编号和保存时的文件名是同一个 */
export const frameNumber = (index: number): string => String(index + 1).padStart(2, '0')
