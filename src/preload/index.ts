import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { CHANNELS, type Api } from '@shared/api'
import type { BrowserState } from '@shared/browser'
import type { DownloadTask } from '@shared/types'

const api: Api = {
  platform: process.platform as Api['platform'],
  parse: (text, options) => ipcRenderer.invoke(CHANNELS.parse, text, options),
  login: (platform) => ipcRenderer.invoke(CHANNELS.login, platform),
  readClipboard: () => ipcRenderer.invoke(CHANNELS.readClipboard),
  appInfo: () => ipcRenderer.invoke(CHANNELS.appInfo),
  downloads: {
    list: () => ipcRenderer.invoke(CHANNELS.downloadsList),
    start: (request) => ipcRenderer.invoke(CHANNELS.downloadsStart, request),
    cancel: (id) => ipcRenderer.invoke(CHANNELS.downloadsCancel, id),
    retry: (id) => ipcRenderer.invoke(CHANNELS.downloadsRetry, id),
    remove: (id) => ipcRenderer.invoke(CHANNELS.downloadsRemove, id),
    clearFinished: () => ipcRenderer.invoke(CHANNELS.downloadsClear),
    reveal: (id) => ipcRenderer.invoke(CHANNELS.downloadsReveal, id),
    open: (id) => ipcRenderer.invoke(CHANNELS.downloadsOpen, id),
    onChange: (listener) => {
      const handler = (_e: IpcRendererEvent, tasks: DownloadTask[]) => listener(tasks)
      ipcRenderer.on(CHANNELS.downloadsChanged, handler)
      return () => ipcRenderer.off(CHANNELS.downloadsChanged, handler)
    }
  },
  settings: {
    get: () => ipcRenderer.invoke(CHANNELS.settingsGet),
    chooseDownloadDir: () => ipcRenderer.invoke(CHANNELS.settingsChooseDir),
    openDownloadDir: () => ipcRenderer.invoke(CHANNELS.settingsOpenDir),
    openWindow: () => ipcRenderer.invoke(CHANNELS.settingsOpenWindow)
  },
  browser: {
    show: (visible, panel) => ipcRenderer.invoke(CHANNELS.browserShow, visible, panel),
    navigate: (address) => ipcRenderer.invoke(CHANNELS.browserNavigate, address),
    back: () => ipcRenderer.invoke(CHANNELS.browserBack),
    forward: () => ipcRenderer.invoke(CHANNELS.browserForward),
    reload: () => ipcRenderer.invoke(CHANNELS.browserReload),
    stop: () => ipcRenderer.invoke(CHANNELS.browserStop),
    clear: () => ipcRenderer.invoke(CHANNELS.browserClear),
    download: (resourceId, variantId) => ipcRenderer.invoke(CHANNELS.browserDownload, resourceId, variantId),
    state: () => ipcRenderer.invoke(CHANNELS.browserState),
    onChange: (listener) => {
      const handler = (_e: IpcRendererEvent, state: BrowserState) => listener(state)
      ipcRenderer.on(CHANNELS.browserChanged, handler)
      return () => ipcRenderer.off(CHANNELS.browserChanged, handler)
    }
  }
}

contextBridge.exposeInMainWorld('api', api)
