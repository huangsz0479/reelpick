import { expect, test } from 'vitest'
import { parsePreviewUrl, previewCandidates, previewUrl } from './preview'
import type { VideoVariant } from './types'

test('round-trips addresses and headers', () => {
  const url = previewUrl({ url: 'https://a.test/v?x=1&y=中', backupUrls: ['https://b.test/v'] }, { Referer: 'https://www.douyin.com/' })
  expect(url.startsWith('vt-media://preview/?t=')).toBe(true)
  expect(parsePreviewUrl(url)).toEqual({ urls: ['https://a.test/v?x=1&y=中', 'https://b.test/v'], headers: { Referer: 'https://www.douyin.com/' } })
})

test.each(['vt-media://preview/', 'vt-media://preview/?t=notjson', `vt-media://preview/?t=${encodeURIComponent('{"urls":["file:///etc/passwd"],"headers":{}}')}`])(
  'rejects %s',
  (url) => {
    expect(parsePreviewUrl(url)).toBeNull()
  }
)

const variant = (id: string, extra: Partial<VideoVariant> = {}): VideoVariant => ({ id, label: id, video: { url: `https://a.test/${id}` }, ...extra })
const ids = (variants: VideoVariant[]) => variants.map((v) => v.id)

test('previews the selected quality first, then H.264 before other codecs', () => {
  const variants = [variant('2160P', { codec: 'HEVC' }), variant('1440P', { codec: 'HEVC' }), variant('1080P', { codec: 'H.264' }), variant('720P', { codec: 'H.264' })]
  expect(ids(previewCandidates(variants, '2160P'))).toEqual(['2160P', '1080P', '720P', '1440P'])
  expect(ids(previewCandidates(variants, '720P'))).toEqual(['720P', '1080P', '2160P', '1440P'])
})

test('leaves out m3u8 and split streams that lack the MIME needed for MSE', () => {
  const audio = { url: 'https://a.test/audio' }
  const variants = [variant('1080P', { codec: 'H.264', audio }), variant('m3u8', { hls: true }), variant('720P', { codec: 'H.264' })]
  expect(ids(previewCandidates(variants, '1080P'))).toEqual(['720P'])
  expect(previewCandidates([variant('1080P', { audio })], '1080P')).toEqual([])
})

test('previews split streams that carry MIME types, falling back to single files first', () => {
  const split = (id: string, codec: string): VideoVariant => ({
    id,
    label: id,
    codec,
    video: { url: `https://a.test/${id}`, mime: 'video/mp4; codecs="x"' },
    audio: { url: 'https://a.test/audio', mime: 'audio/mp4; codecs="mp4a.40.2"' }
  })
  const variants = [split('4K', 'HEVC'), split('1080P', 'H.264'), variant('720P', { codec: 'H.264' }), split('480P', 'H.264')]
  expect(ids(previewCandidates(variants, '4K'))).toEqual(['4K', '720P', '1080P', '480P'])
  expect(ids(previewCandidates(variants, '480P'))).toEqual(['480P', '720P', '1080P', '4K'])
})
