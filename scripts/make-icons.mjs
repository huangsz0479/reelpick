// 把 build/icon.svg 导出成各平台的图标文件。用法：pnpm icons
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app, BrowserWindow } from 'electron'

const dir = join(import.meta.dirname, '../build')
const svg = readFileSync(join(dir, 'icon.svg'), 'utf8')

// 截图按屏幕的缩放倍数出图，固定成 1 倍才能得到正好 1024 像素
app.commandLine.appendSwitch('force-device-scale-factor', '1')
app.on('window-all-closed', () => {})

/** 把图标画成 1024 见方的透明底图片；css 作用在 svg 元素上 */
async function render(css) {
  const win = new BrowserWindow({ width: 1024, height: 1024, show: false, frame: false, transparent: true, enableLargerThanScreen: true, webPreferences: { offscreen: true } })
  const html = `<style>body{margin:0;overflow:hidden}svg{display:block;width:1024px;height:1024px;${css}}</style>${svg}`
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
  // 等模糊滤镜画完
  await new Promise((resolve) => setTimeout(resolve, 500))
  const image = await win.webContents.capturePage()
  win.destroy()
  if (image.getSize().width !== 1024) throw new Error(`截图尺寸不对：${JSON.stringify(image.getSize())}`)
  return image
}

const png = (image, size) => image.resize({ width: size, height: size, quality: 'best' }).toPNG()

/** ICO 文件：6 字节文件头，每张图 16 字节目录项，后面依次是各张 PNG */
function ico(image, sizes) {
  const images = sizes.map((size) => png(image, size))
  const header = Buffer.alloc(6 + 16 * sizes.length)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(sizes.length, 4)
  let offset = header.length
  sizes.forEach((size, i) => {
    const at = 6 + 16 * i
    // 宽高各占一个字节，256 写成 0
    header.writeUInt8(size % 256, at)
    header.writeUInt8(size % 256, at + 1)
    header.writeUInt16LE(1, at + 4)
    header.writeUInt16LE(32, at + 6)
    header.writeUInt32LE(images[i].length, at + 8)
    header.writeUInt32LE(offset, at + 12)
    offset += images[i].length
  })
  return Buffer.concat([header, ...images])
}

async function main() {
  // macOS：图形外留一圈空白，带系统图标惯用的投影
  const mac = await render('filter:drop-shadow(0 10px 12px rgb(0 0 0 / 0.3))')
  writeFileSync(join(dir, 'icon.png'), mac.toPNG())
  if (process.platform === 'darwin') {
    const iconset = join(mkdtempSync(join(tmpdir(), 'icon-')), 'icon.iconset')
    mkdirSync(iconset)
    for (const size of [16, 32, 128, 256, 512]) {
      writeFileSync(join(iconset, `icon_${size}x${size}.png`), png(mac, size))
      writeFileSync(join(iconset, `icon_${size}x${size}@2x.png`), png(mac, size * 2))
    }
    execFileSync('iconutil', ['-c', 'icns', iconset, '-o', join(dir, 'icon.icns')])
    rmSync(join(iconset, '..'), { recursive: true })
  }

  // Windows 不留空白也不加投影，图形撑满整个方块
  const win = await render('transform:scale(1.21)')
  writeFileSync(join(dir, 'icon.ico'), ico(win, [16, 24, 32, 48, 64, 128, 256]))
}

// 不能在模块顶层 await：Electron 要等入口模块执行完才触发 ready，两边会互相等
void app.whenReady().then(async () => {
  try {
    await main()
    app.exit(0)
  } catch (e) {
    console.error(e)
    app.exit(1)
  }
})
