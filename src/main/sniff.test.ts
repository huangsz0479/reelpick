import { describe, expect, it } from 'vitest'
import { addressToUrl, classifyResponse, resourceKey } from './sniff'

const MB = 1024 * 1024

describe('classifyResponse', () => {
  it('按地址或响应类型认出 m3u8', () => {
    expect(classifyResponse('https://a.com/v/index.m3u8?t=1', 200, { 'Content-Type': ['text/plain'] })).toEqual({ kind: 'hls' })
    expect(classifyResponse('https://a.com/play?id=1', 200, { 'content-type': ['application/vnd.apple.mpegurl'] })).toEqual({ kind: 'hls' })
    expect(classifyResponse('https://a.com/play?id=1', 200, { 'Content-Type': ['application/x-mpegURL; charset=utf-8'] })).toEqual({ kind: 'hls' })
  })

  it('地址是 m3u8 但返回网页的不算', () => {
    expect(classifyResponse('https://a.com/index.m3u8', 200, { 'Content-Type': ['text/html; charset=utf-8'] })).toBeNull()
  })

  it('认出视频文件，大小取自整个文件而不是这次请求的一段', () => {
    const headers = { 'Content-Type': ['video/mp4'], 'Content-Range': [`bytes 0-1023/${50 * MB}`], 'Content-Length': ['1024'] }
    expect(classifyResponse('https://cdn.a.com/v?id=9', 206, headers)).toEqual({ kind: 'file', ext: 'mp4', size: 50 * MB })
    expect(classifyResponse('https://cdn.a.com/a.webm', 200, { 'Content-Type': ['video/webm'], 'Content-Length': [String(3 * MB)] })).toEqual({
      kind: 'file',
      ext: 'webm',
      size: 3 * MB
    })
  })

  it('服务器没说明类型时看扩展名', () => {
    expect(classifyResponse('https://cdn.a.com/a.flv', 200, { 'Content-Type': ['application/octet-stream'] })).toEqual({ kind: 'file', ext: 'flv', size: undefined })
    expect(classifyResponse('https://cdn.a.com/a.zip', 200, { 'Content-Type': ['application/octet-stream'] })).toBeNull()
  })

  it('大小未知的视频文件照样列出', () => {
    expect(classifyResponse('https://cdn.a.com/a.mp4', 206, { 'Content-Type': ['video/mp4'], 'Content-Range': ['bytes 0-99/*'] })).toEqual({
      kind: 'file',
      ext: 'mp4',
      size: undefined
    })
  })

  it('不列出分片、过小的文件、失败的响应和不是视频的内容', () => {
    expect(classifyResponse('https://a.com/seg-1.ts', 200, { 'Content-Type': ['video/mp2t'] })).toBeNull()
    expect(classifyResponse('https://a.com/seg-1.m4s', 200, { 'Content-Type': ['video/mp4'] })).toBeNull()
    expect(classifyResponse('https://a.com/videoplayback?range=0-999', 200, { 'Content-Type': ['video/mp4'] })).toBeNull()
    expect(classifyResponse('https://a.com/ad.mp4', 200, { 'Content-Type': ['video/mp4'], 'Content-Length': ['20000'] })).toBeNull()
    expect(classifyResponse('https://a.com/a.mp4', 403, { 'Content-Type': ['video/mp4'] })).toBeNull()
    expect(classifyResponse('https://a.com/a.mp4', 200, { 'Content-Type': ['text/html'] })).toBeNull()
    expect(classifyResponse('https://a.com/app.js', 200, { 'Content-Type': ['text/javascript'] })).toBeNull()
    expect(classifyResponse('blob:https://a.com/1', 200, { 'Content-Type': ['video/mp4'] })).toBeNull()
  })
})

describe('resourceKey', () => {
  it('视频文件忽略查询参数，m3u8 保留', () => {
    expect(resourceKey('https://a.com/v.mp4?token=1', 'file')).toBe(resourceKey('https://a.com/v.mp4?token=2', 'file'))
    expect(resourceKey('https://a.com/v.m3u8?q=720', 'hls')).not.toBe(resourceKey('https://a.com/v.m3u8?q=1080', 'hls'))
  })
})

describe('addressToUrl', () => {
  it('链接原样打开，分享文案里的链接取出来', () => {
    expect(addressToUrl(' https://a.com/watch?v=1 ')).toBe('https://a.com/watch?v=1')
    expect(addressToUrl('快来看 https://a.com/x 复制打开')).toBe('https://a.com/x')
  })

  it('不带协议的域名补上协议', () => {
    expect(addressToUrl('a.com/watch')).toBe('https://a.com/watch')
    expect(addressToUrl('localhost:8080/x')).toBe('http://localhost:8080/x')
    expect(addressToUrl('127.0.0.1:3000')).toBe('http://127.0.0.1:3000')
  })

  it('其余内容当作搜索词，空内容不打开', () => {
    expect(addressToUrl('猫 视频')).toBe(`https://www.bing.com/search?q=${encodeURIComponent('猫 视频')}`)
    expect(addressToUrl('   ')).toBeNull()
  })
})
