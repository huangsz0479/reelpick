import { expect, test } from 'vitest'
import { readSegmentIndex } from './mp4'

const box = (type: string, payload: number[]): number[] => {
  const size = 8 + payload.length
  return [size >>> 24, (size >>> 16) & 255, (size >>> 8) & 255, size & 255, ...[...type].map((c) => c.charCodeAt(0)), ...payload]
}
const u16 = (n: number) => [(n >>> 8) & 255, n & 255]
const u32 = (n: number) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]
const u64 = (n: number) => [...u32(Math.floor(n / 2 ** 32)), ...u32(n >>> 0)]
const bytes = (...parts: number[][]) => new Uint8Array(parts.flat()).buffer

/** refs: [字节数, 时长]；时间单位是 timescale 分之一秒 */
const sidx = (version: 0 | 1, timescale: number, earliest: number, firstOffset: number, refs: [number, number][]) =>
  box('sidx', [
    version, 0, 0, 0,
    ...u32(1),
    ...u32(timescale),
    ...(version === 0 ? [...u32(earliest), ...u32(firstOffset)] : [...u64(earliest), ...u64(firstOffset)]),
    ...u16(0),
    ...u16(refs.length),
    ...refs.flatMap(([size, duration]) => [...u32(size), ...u32(duration), ...u32(0x90000000)])
  ])

const ftyp = box('ftyp', new Array<number>(8).fill(0))
const free = box('free', [])
const moov = box('moov', new Array<number>(20).fill(0))

test('reads the init size and segment positions from a file laid out like Bilibili DASH', () => {
  const index = sidx(0, 1000, 0, 0, [[100, 5000], [250, 4500]])
  const head = bytes(ftyp, free, moov, index, box('moof', [1, 2, 3]))
  const initSize = ftyp.length + free.length + moov.length
  const first = initSize + index.length

  expect(readSegmentIndex(head)).toEqual({
    initSize,
    segments: [
      { start: first, end: first + 99, time: 0, duration: 5 },
      { start: first + 100, end: first + 349, time: 5, duration: 4.5 }
    ]
  })
})

test('applies the first offset and the earliest presentation time, in a version 1 index', () => {
  const index = sidx(1, 48000, 96000, 32, [[10, 48000]])
  const head = bytes(ftyp, moov, index)
  const result = readSegmentIndex(head)
  const first = ftyp.length + moov.length + index.length + 32

  expect(result).toMatchObject({ segments: [{ start: first, end: first + 9, time: 2, duration: 1 }] })
})

test('asks for more bytes when the index is cut off', () => {
  const index = sidx(0, 1000, 0, 0, [[100, 5000], [250, 4500]])
  const full = new Uint8Array(bytes(ftyp, moov, index))
  const indexEnd = ftyp.length + moov.length + index.length

  expect(readSegmentIndex(full.slice(0, indexEnd - 5).buffer)).toEqual({ need: indexEnd })
  expect(readSegmentIndex(full.slice(0, ftyp.length + 4).buffer)).toHaveProperty('need')
})

test('rejects files without a segment index before the media data', () => {
  expect(() => readSegmentIndex(bytes(ftyp, moov, box('mdat', new Array<number>(16).fill(0))))).toThrow()
  // 指向下一级索引的 sidx 不支持
  const nested = sidx(0, 1000, 0, 0, [[100, 5000]])
  nested[nested.length - 12] = 0x80
  expect(() => readSegmentIndex(bytes(ftyp, moov, nested))).toThrow()
})
