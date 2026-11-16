import { useEffect, useState } from 'react'
import type { AppInfo, Settings } from '@shared/types'
import styles from './SettingsWindow.module.css'

export function SettingsWindow() {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [info, setInfo] = useState<AppInfo | null>(null)
  useEffect(() => {
    void window.api.settings.get().then(setSettings)
    void window.api.appInfo().then(setInfo)
  }, [])

  return (
    <div className={styles.window}>
      <header className={`${styles.titlebar} drag`}>
        <h1>设置</h1>
      </header>
      <main className={styles.body}>
        <section className={styles.row} aria-labelledby="settings-dir">
          <h2 id="settings-dir" className={styles.control}>
            保存位置
          </h2>
          <div>
            <div className={styles.dir}>
              <p className={styles.path} title={settings?.downloadDir}>
                <bdi>{settings?.downloadDir}</bdi>
              </p>
              <button className="btn" onClick={() => void window.api.settings.chooseDownloadDir().then(setSettings)}>
                更改…
              </button>
              <button className="btn" onClick={() => void window.api.settings.openDownloadDir()}>
                打开文件夹
              </button>
            </div>
            <p className={styles.hint}>视频直接保存在这个文件夹，一组图片保存在以标题命名的子文件夹里</p>
          </div>
        </section>
        <section className={styles.row} aria-labelledby="settings-about">
          <h2 id="settings-about">关于</h2>
          <div>
            <p>
              {info?.name} <span className={styles.version}>{info?.version}</span>
            </p>
            <p className={styles.hint}>解析和下载都在这台电脑上完成，不经过第三方服务器</p>
          </div>
        </section>
      </main>
    </div>
  )
}
