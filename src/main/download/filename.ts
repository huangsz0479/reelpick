import { existsSync } from 'node:fs'
import { join } from 'node:path'

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i
const MAX_LENGTH = 60

/** 生成在 macOS 和 Windows 上都合法的文件名（不含扩展名） */
export function sanitizeFileName(name: string): string {
  const cleaned = [...name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ')]
    .slice(0, MAX_LENGTH)
    .join('')
    // 结尾的点和空格在 Windows 上不合法；开头的点在 macOS 上会让文件变成隐藏文件
    .replace(/^[. ]+|[. ]+$/g, '')
  if (!cleaned) return '未命名'
  return RESERVED.test(cleaned) ? `_${cleaned}` : cleaned
}

/** 扩展名由渲染进程传来，只接受字母和数字，这样拼不出保存位置之外的路径 */
export function sanitizeExt(ext: string): string {
  return /^[a-z0-9]{1,8}$/i.test(ext) ? ext : 'bin'
}

/** 返回一个不与现有文件、也不与 taken 中路径冲突的保存路径 */
export function uniquePath(dir: string, base: string, ext: string, taken: ReadonlySet<string>): string {
  for (let n = 0; ; n++) {
    const candidate = join(dir, `${base}${n ? ` (${n})` : ''}.${ext}`)
    if (!existsSync(candidate) && !taken.has(candidate)) return candidate
  }
}
