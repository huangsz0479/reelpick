import { expect, test } from 'vitest'
import { DownloadError, describeFailure, httpFailure } from './failure'

test.each([
  [httpFailure(403), 'expired', false],
  [httpFailure(503), 'server', true],
  [Object.assign(new Error('write'), { code: 'ENOSPC' }), 'disk_full', true],
  [Object.assign(new Error('open'), { code: 'EACCES' }), 'permission', false],
  [new TypeError('fetch failed'), 'network', true],
  [new Error('net::ERR_INTERNET_DISCONNECTED'), 'network', true],
  [new DownloadError('merge', '音视频合并失败：x'), 'merge', false],
  [new Error('boom'), 'unknown', true]
])('%s → %s', (error, code, retryable) => {
  expect(describeFailure(error)).toMatchObject({ code, retryable })
})

test('does not leak the address into unknown failures it classifies', () => {
  expect(describeFailure(new TypeError('fetch failed')).message).toBe('网络中断，请检查网络后重试')
})
