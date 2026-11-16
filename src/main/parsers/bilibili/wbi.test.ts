import { expect, test } from 'vitest'
import { keyFromUrl, mixinKey, signWbi } from './wbi'

test('signs params with the mixin key', () => {
  const key = mixinKey(
    keyFromUrl('https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png'),
    keyFromUrl('https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png')
  )
  expect(signWbi({ foo: '114', bar: '514', zab: 1919810 }, key, 1702204169)).toBe(
    'bar=514&foo=114&wts=1702204169&zab=1919810&w_rid=8f6f2b5b3d485fe1886cec6a0be8c5d4'
  )
})

test('strips characters the server ignores', () => {
  expect(signWbi({ a: "x!'()*y" }, 'k', 1)).toMatch(/^a=xy&wts=1&w_rid=[0-9a-f]{32}$/)
})
