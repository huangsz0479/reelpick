import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'

const shared = { '@shared': resolve('src/shared') }

// 开发模式下 Vite 需要内联脚本和 WebSocket，因此只在构建产物里加 CSP
const csp: Plugin = {
  name: 'inject-csp',
  apply: 'build',
  transformIndexHtml: (html) =>
    html.replace(
      '<meta name="referrer"',
      `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; img-src 'self' https: data:; media-src vt-media: blob:; connect-src 'self' vt-media:; style-src 'self' 'unsafe-inline'" />\n    <meta name="referrer"`
    )
}

export default defineConfig({
  main: { resolve: { alias: shared } },
  preload: {
    resolve: { alias: shared },
    build: { rollupOptions: { output: { format: 'cjs', entryFileNames: '[name].cjs' } } }
  },
  renderer: { resolve: { alias: shared }, plugins: [react(), csp] }
})
