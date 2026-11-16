import { expect, test } from 'vitest'
import { formatBytes, formatDuration, frameNumber, hangsLeft } from './format'

test.each([
  [0, '0 KB'],
  [1, '1 KB'],
  [1536, '2 KB'],
  [5.5 * 1024 * 1024, '5.5 MB'],
  [1.5 * 1024 ** 3, '1.50 GB']
])('formatBytes %d → %s', (bytes, expected) => {
  expect(formatBytes(bytes)).toBe(expected)
})

test.each([
  [75, '01:15'],
  [3725.9, '1:02:05']
])('formatDuration %d → %s', (seconds, expected) => {
  expect(formatDuration(seconds)).toBe(expected)
})

test.each([
  [0, '01'],
  [9, '10'],
  [99, '100']
])('frameNumber %d → %s', (index, expected) => {
  expect(frameNumber(index)).toBe(expected)
})

test.each([
  ['【官方 MV】Never Gonna Give You Up', true],
  ['《标题》', true],
  ['Never Gonna Give You Up', false],
  ['“画面解压又暖心！”', false],
  ['', false]
])('hangsLeft %s → %s', (text, expected) => {
  expect(hangsLeft(text)).toBe(expected)
})
