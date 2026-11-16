import { expect, test } from 'vitest'
import { nextBatch } from './dash'
import type { Segment } from './mp4'

/** 每段 5 秒，共 20 段 */
const track = (bytes: number): Segment[] =>
  Array.from({ length: 20 }, (_, i) => ({ start: i * bytes, end: (i + 1) * bytes - 1, time: i * 5, duration: 5 }))
/** 视频：每段 600KB，两段就够一次请求 */
const video = track(600_000)
/** 音频：每段很小，预读范围内的可以一次取完 */
const audio = track(100_000)

test('fetches only the segment under the playhead while nothing is buffered there', () => {
  expect(nextBatch(video, [], 0)).toEqual([0, 0])
  expect(nextBatch(audio, [], 12)).toEqual([2, 2])
  // 跳到了缓冲范围之外
  expect(nextBatch(audio, [[0, 30]], 62)).toEqual([12, 12])
})

test('reads ahead in batches once the playhead has data', () => {
  expect(nextBatch(video, [[0, 5]], 0)).toEqual([1, 2])
  expect(nextBatch(video, [[0, 15]], 3)).toEqual([3, 4])
})

test('fetches small segments together, up to 30 seconds ahead of the playhead', () => {
  expect(nextBatch(audio, [[0, 5]], 0)).toEqual([1, 5])
  expect(nextBatch(audio, [[10, 15]], 12)).toEqual([3, 8])
  expect(nextBatch(audio, [[85, 95]], 92)).toEqual([19, 19])
})

test('fills a gap left by eviction without refetching what is still there', () => {
  expect(nextBatch(audio, [[0, 5], [10, 100]], 3)).toEqual([1, 1])
})

test('has nothing to fetch once 30 seconds ahead are buffered', () => {
  expect(nextBatch(video, [[0, 30]], 3)).toEqual([6, 6])
  expect(nextBatch(video, [[0, 35]], 3)).toBeNull()
  expect(nextBatch(video, [[0, 100]], 99)).toBeNull()
})
