const HEIGHTS = [2160, 1440, 1080, 720, 540, 480, 360]

/** 取短边最接近的标准档位，例如 576x1024 → 540P */
export function qualityLabel(width?: number, height?: number): string {
  const short = Math.min(width ?? 0, height ?? 0)
  if (!short) return '原画'
  const nearest = HEIGHTS.reduce((best, h) => (Math.abs(h - short) < Math.abs(best - short) ? h : best))
  return `${nearest}P`
}
