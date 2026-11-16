import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './tokens.css'

document.documentElement.dataset.platform = window.api.platform

// 设置窗口加载的是同一份页面，用查询参数区分。按需引入，设置窗口就不会去订阅下载列表
const isSettings = new URLSearchParams(location.search).get('window') === 'settings'
if (isSettings) document.title = '设置'
const Root = isSettings ? (await import('./SettingsWindow')).SettingsWindow : (await import('./App')).App

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>
)
