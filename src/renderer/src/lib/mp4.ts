export interface Segment {
  /** 在文件里的字节范围，含两端 */
  start: number
  end: number
  /** 开始时间和时长，单位是秒 */
  time: number
  duration: number
}

export interface SegmentIndex {
  /** 初始化段是文件开头的这么多字节，到 moov 结束 */
  initSize: number
  segments: Segment[]
}

/**
 * 从分片 MP4 开头的一段数据里读出初始化段的长度和各分片的位置（sidx）。
 * 数据不够时返回需要读到第几个字节；文件不是这种结构时抛出错误。
 */
export function readSegmentIndex(head: ArrayBuffer): SegmentIndex | { need: number } {
  const view = new DataView(head)
  let offset = 0
  let initSize = 0
  for (;;) {
    // box 的头最长 16 字节：长度是 1 时，真正的长度在后面的 8 个字节里
    if (offset + 16 > view.byteLength) return { need: offset + 16 }
    const type = String.fromCharCode(...new Uint8Array(head, offset + 4, 4))
    const size32 = view.getUint32(offset)
    const size = size32 === 1 ? Number(view.getBigUint64(offset + 8)) : size32
    if (size < 8 || type === 'moof' || type === 'mdat') throw new Error('文件里没有分片索引')
    if (type === 'moov') initSize = offset + size
    if (type === 'sidx') {
      if (!initSize) throw new Error('分片索引在初始化段之前')
      if (offset + size > view.byteLength) return { need: offset + size }
      return { initSize, segments: readSidx(view, offset, size) }
    }
    offset += size
  }
}

function readSidx(view: DataView, offset: number, size: number): Segment[] {
  const version = view.getUint8(offset + 8)
  const timescale = view.getUint32(offset + 16)
  let at = offset + 20
  let time: number
  let firstOffset: number
  if (version === 0) {
    time = view.getUint32(at)
    firstOffset = view.getUint32(at + 4)
    at += 8
  } else {
    time = Number(view.getBigUint64(at))
    firstOffset = Number(view.getBigUint64(at + 8))
    at += 16
  }
  const count = view.getUint16(at + 2)
  at += 4

  // 分片的位置从 sidx 之后算起
  let start = offset + size + firstOffset
  const segments: Segment[] = []
  for (let i = 0; i < count; i++, at += 12) {
    const reference = view.getUint32(at)
    if (reference >>> 31) throw new Error('不支持多级分片索引')
    const duration = view.getUint32(at + 4)
    segments.push({ start, end: start + reference - 1, time: time / timescale, duration: duration / timescale })
    start += reference
    time += duration
  }
  return segments
}
