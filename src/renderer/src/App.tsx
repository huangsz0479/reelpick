import { useEffect, useRef, useState, type FormEvent } from 'react'
import { loginLabel, type AppError, type MediaResult, type Platform } from '@shared/types'
import styles from './App.module.css'
import { BrowserPage, BrowserToolbar } from './components/Browser'
import { DownloadList } from './components/DownloadList'
import { FolderIcon, LinkIcon } from './components/icons'
import { ParseIntro, ResultPanel, ResultSkeleton } from './components/ResultPanel'
import { FILTERS, Sidebar, type View } from './components/Sidebar'
import { isActive, useDownloads } from './lib/downloads'

type ParseState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; error: AppError }
  | { status: 'result'; result: MediaResult }

export function App() {
  const tasks = useDownloads()
  const [view, setView] = useState<View>('parse')
  const [text, setText] = useState('')
  const [parse, setParse] = useState<ParseState>({ status: 'idle' })
  // 每次解析的序号。只采用最后一次的结果：登录窗口开着的时候用户可以继续解析别的链接
  const latest = useRef(0)
  // 网页是主进程叠在界面上的一层，只在「浏览网页」页面上显示
  const [panelOpen, setPanelOpen] = useState(true)
  useEffect(() => void window.api.browser.show(view === 'browse', panelOpen), [view, panelOpen])

  async function run(input: string, options?: { manual?: boolean }) {
    if (!input.trim()) return
    const id = ++latest.current
    setParse({ status: 'loading' })
    const res = await window.api.parse(input, options)
    if (id !== latest.current) return
    setParse(res.ok ? { status: 'result', result: res.value } : { status: 'error', error: res.error })
  }

  // 登录窗口关闭后用同一条链接重新解析；这期间用户解析过别的链接，就不再打断
  async function login(platform: Platform) {
    const id = latest.current
    await window.api.login(platform)
    if (id === latest.current) void run(text)
  }

  function submit(e: FormEvent) {
    e.preventDefault()
    void run(text)
  }

  async function pasteAndParse() {
    const clip = await window.api.readClipboard()
    setText(clip)
    if (clip.trim()) void run(clip)
    else setParse({ status: 'error', error: { code: 'no_url', message: '剪贴板是空的，请先复制作品的分享链接' } })
  }

  const loading = parse.status === 'loading'
  const filter = FILTERS.find((f) => f.id === view)

  return (
    <div className={styles.app}>
      <Sidebar tasks={tasks} view={view} onView={setView} />
      <div className={styles.main}>
        {view === 'parse' ? (
          <form className={`${styles.toolbar} drag`} onSubmit={submit}>
            <label className={`${styles.field} no-drag`}>
              <LinkIcon />
              <input
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="粘贴分享链接或视频地址"
                aria-label="分享链接"
                spellCheck={false}
                autoFocus
              />
            </label>
            <button type="button" className="btn no-drag" onClick={pasteAndParse} disabled={loading}>
              粘贴
            </button>
            <button type="submit" className="btn no-drag" disabled={loading || !text.trim()}>
              {loading ? '解析中…' : '解析'}
            </button>
          </form>
        ) : view === 'browse' ? (
          <BrowserToolbar
            className={`${styles.toolbar} drag`}
            fieldClassName={`${styles.field} no-drag`}
            panelOpen={panelOpen}
            onTogglePanel={() => setPanelOpen((open) => !open)}
          />
        ) : (
          <header className={`${styles.toolbar} drag`}>
            <h1 className={styles.heading}>{view === 'all' ? '全部下载' : filter?.label}</h1>
            <button className="btn no-drag" onClick={() => void window.api.settings.openDownloadDir()}>
              <FolderIcon />
              打开文件夹
            </button>
            {tasks.some((t) => !isActive(t)) && (
              <button
                className="btn no-drag"
                onClick={() => void window.api.downloads.clearFinished()}
                title="清除已完成、失败和已取消的记录，不删除文件"
              >
                清除记录
              </button>
            )}
          </header>
        )}

        {/* 几个页面都保持挂载，切换导航时不丢失解析结果和选中的清晰度 */}
        <div className={`${styles.page} ${styles.scroll}`} hidden={view !== 'parse'}>
          {parse.status === 'error' && (
            <div className={styles.error} role="alert">
              <p>{parse.error.message}</p>
              {parse.error.code === 'no_stream' && (
                <button className="btn" onClick={() => void run(text, { manual: true })}>
                  打开网页
                </button>
              )}
              {parse.error.code === 'login_required' && parse.error.platform && (
                <button className="btn" onClick={() => void login(parse.error.platform!)}>
                  {loginLabel(parse.error.platform)}
                </button>
              )}
            </div>
          )}
          {loading && <ResultSkeleton />}
          {parse.status === 'result' && (
            <ResultPanel
              key={parse.result.id}
              result={parse.result}
              onLogin={() => void login(parse.result.platform)}
              onClose={() => setParse({ status: 'idle' })}
              onShowDownloads={() => setView('all')}
            />
          )}
          {(parse.status === 'idle' || parse.status === 'error') && <ParseIntro onPaste={() => void pasteAndParse()} />}
        </div>
        <div className={styles.page} hidden={view !== 'browse'}>
          <BrowserPage panelOpen={panelOpen} />
        </div>
        <div className={`${styles.page} ${styles.scroll}`} hidden={view === 'parse' || view === 'browse'}>
          {filter && <DownloadList tasks={tasks} filter={filter} onGoParse={() => setView('parse')} />}
        </div>
      </div>
    </div>
  )
}
