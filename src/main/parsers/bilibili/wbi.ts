import { createHash } from 'node:crypto'

const MIXIN_TABLE = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38,
  41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
  20, 34, 44, 52
]

export function mixinKey(imgKey: string, subKey: string): string {
  const raw = imgKey + subKey
  return MIXIN_TABLE.map((i) => raw[i])
    .join('')
    .slice(0, 32)
}

/** 从 nav 接口返回的图片地址里取出 key，例如 .../wbi/7cd0...077c.png → 7cd0...077c */
export function keyFromUrl(url: string): string {
  return url.slice(url.lastIndexOf('/') + 1).split('.')[0] ?? ''
}

export function signWbi(params: Record<string, string | number>, key: string, wts: number): string {
  const all: Record<string, string | number> = { ...params, wts }
  const query = Object.keys(all)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(all[k]).replace(/[!'()*]/g, ''))}`)
    .join('&')
  return `${query}&w_rid=${createHash('md5').update(query + key).digest('hex')}`
}
