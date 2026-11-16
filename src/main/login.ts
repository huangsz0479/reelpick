import { BrowserWindow, session } from 'electron'
import { loginLabel, type Platform } from '@shared/types'
import { CAPTURE_PARTITION } from './browser-capture'

const LOGIN_PAGES: Partial<Record<Platform, string>> = {
  bilibili: 'https://passport.bilibili.com/login',
  xiaohongshu: 'https://www.xiaohongshu.com/explore',
  douyin: 'https://www.douyin.com/'
}
const COOKIE_URLS: Partial<Record<Platform, string>> = { bilibili: 'https://api.bilibili.com/' }

/** 打开平台自己的登录页，用户关闭窗口后返回。登录状态保存在抓取页面用的同一个会话里 */
export function openLoginWindow(platform: Platform, parent: BrowserWindow | null): Promise<void> {
  const page = LOGIN_PAGES[platform]
  if (!page) return Promise.resolve()
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      parent: parent ?? undefined,
      width: 1040,
      height: 760,
      title: `${loginLabel(platform)}，完成后关闭这个窗口`,
      autoHideMenuBar: true,
      webPreferences: { partition: CAPTURE_PARTITION }
    })
    // 保留上面的窗口标题，不让页面标题覆盖
    win.on('page-title-updated', (event) => event.preventDefault())
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//.test(url)) void win.loadURL(url)
      return { action: 'deny' }
    })
    win.on('closed', () => resolve())
    void win.loadURL(page).catch(() => {})
  })
}

/** 直接请求接口的平台需要把登录 Cookie 放进请求头；靠页面抓取的平台不需要 */
export async function loginCookies(): Promise<Partial<Record<Platform, string>>> {
  const cookies = session.fromPartition(CAPTURE_PARTITION).cookies
  const entries = await Promise.all(
    Object.entries(COOKIE_URLS).map(async ([platform, url]) => {
      const header = (await cookies.get({ url })).map((c) => `${c.name}=${c.value}`).join('; ')
      return [platform, header] as const
    })
  )
  return Object.fromEntries(entries.filter(([, header]) => header))
}
