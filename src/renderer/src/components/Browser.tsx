import { useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react'
import { BROWSER_PANEL, type SniffedResource } from '@shared/browser'
import type { DownloadTask, VideoVariant } from '@shared/types'
import { useBrowserState } from '../lib/browser'
import { useDownloads } from '../lib/downloads'
import { formatBytes, formatDuration, hangsLeft } from '../lib/format'
import styles from './Browser.module.css'
import { ChevronLeftIcon, ChevronRightIcon, CloseIcon, DownloadIcon, GlobeIcon, PanelRightIcon, RetryIcon } from './icons'

/** 清晰度太多时只列最高的几个 */
const MAX_VARIANTS = 4
// 网页由主进程摆在界面留出的空位上，右边这一栏的宽度两边要一致
const LAYOUT = { '--panel': `${BROWSER_PANEL}px` } as CSSProperties

interface ToolbarProps {
  className: string
  fieldClassName: string
  panelOpen: boolean
  onTogglePanel: () => void
}

/** 「浏览网页」页面的工具栏：后退、前进、重新载入、地址栏，以及展开或收起「找到的视频」 */
export function BrowserToolbar({ className, fieldClassName, panelOpen, onTogglePanel }: ToolbarProps) {
  const { browser } = window.api
  const state = useBrowserState()
  // 地址栏平时显示当前网页的地址，获得焦点后才是用户正在输入的内容
  const [draft, setDraft] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)

  function submit(e: FormEvent) {
    e.preventDefault()
    if (!draft?.trim()) return
    void browser.navigate(draft)
    input.current?.blur()
  }

  return (
    <form className={className} onSubmit={submit}>
      <div className={`${styles.nav} no-drag`}>
        <button type="button" className="icon-btn" onClick={() => void browser.back()} disabled={!state.canGoBack} aria-label="后退" title="后退">
          <ChevronLeftIcon />
        </button>
        <button type="button" className="icon-btn" onClick={() => void browser.forward()} disabled={!state.canGoForward} aria-label="前进" title="前进">
          <ChevronRightIcon />
        </button>
        {state.loading ? (
          <button type="button" className="icon-btn" onClick={() => void browser.stop()} aria-label="停止载入" title="停止载入">
            <CloseIcon />
          </button>
        ) : (
          <button type="button" className="icon-btn" onClick={() => void browser.reload()} disabled={!state.url} aria-label="重新载入" title="重新载入">
            <RetryIcon />
          </button>
        )}
      </div>
      <label className={fieldClassName}>
        <GlobeIcon />
        <input
          ref={input}
          value={draft ?? state.url}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={(e) => {
            setDraft(state.url)
            e.target.select()
          }}
          onBlur={() => setDraft(null)}
          placeholder="输入网址或搜索词"
          aria-label="网址"
          spellCheck={false}
          autoFocus
        />
      </label>
      {/* 收起时数量还在按钮上，新找到视频能看出来 */}
      <button
        type="button"
        className={`btn no-drag ${styles.toggle}`}
        onClick={onTogglePanel}
        aria-pressed={panelOpen}
        aria-label={`${panelOpen ? '收起' : '展开'}找到的视频，共 ${state.resources.length} 个`}
        title={panelOpen ? '收起找到的视频' : '展开找到的视频'}
      >
        <PanelRightIcon />
        {state.resources.length > 0 && <span>{state.resources.length}</span>}
      </button>
    </form>
  )
}

/** 「浏览网页」页面：左边是网页（主进程叠上来的），右边是找到的视频 */
export function BrowserPage({ panelOpen }: { panelOpen: boolean }) {
  const { browser } = window.api
  const state = useBrowserState()
  const tasks = useDownloads()
  // 「视频 id/清晰度 id」到下载任务 id：点过下载的清晰度显示任务的进度
  const [started, setStarted] = useState<Record<string, string>>({})

  async function download(resource: SniffedResource, variant: VideoVariant) {
    const id = await browser.download(resource.id, variant.id)
    if (id) setStarted((map) => ({ ...map, [`${resource.id}/${variant.id}`]: id }))
  }

  return (
    <div className={styles.browser} style={LAYOUT} data-panel={panelOpen ? 'open' : 'closed'}>
      <section className={styles.page} aria-label="网页">
        {state.error ? (
          <p className={styles.error} role="alert">
            {state.error}
          </p>
        ) : (
          !state.url && (
            <>
              <h1>在这里打开有视频的网页</h1>
              <p>在上面输入网址，像平时一样播放视频，找到的视频会列在右边</p>
            </>
          )
        )}
      </section>

      <aside className={styles.panel} aria-label="找到的视频" hidden={!panelOpen}>
        <header className={styles.head}>
          <h2>找到的视频</h2>
          <span className={styles.count}>{state.resources.length || ''}</span>
          {state.resources.length > 0 && (
            <>
              <button className="btn" onClick={() => void browser.clear()}>
                清空
              </button>
            </>
          )}
        </header>
        {state.resources.length === 0 ? (
          <div className={styles.empty}>
            <h3>还没有找到视频</h3>
            <p>播放一下网页里的视频，找到的会列在这里</p>
          </div>
        ) : (
          <ul className={styles.list}>
            {state.resources.map((resource) => (
              <li key={resource.id} className={styles.row}>
                <p className={styles.title} title={resource.title} data-hang={hangsLeft(resource.title) || undefined}>
                  {resource.title}
                </p>
                <p className={`${styles.meta} truncate`} title={resource.url}>
                  {describe(resource)}
                </p>
                {resource.error ? (
                  <p className={styles.meta} data-status="failed">
                    {resource.error}
                  </p>
                ) : (
                  <div className={styles.variants}>
                    {resource.variants.slice(0, MAX_VARIANTS).map((variant) => (
                      <Variant
                        key={variant.id}
                        variant={variant}
                        task={tasks.find((t) => t.id === started[`${resource.id}/${variant.id}`])}
                        onDownload={() => void download(resource, variant)}
                      />
                    ))}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </aside>
    </div>
  )
}

function describe(resource: SniffedResource): string {
  const size = resource.kind === 'file' ? resource.variants[0]?.size : undefined
  return [
    resource.kind === 'hls' ? '视频流' : resource.ext.toUpperCase(),
    resource.duration && formatDuration(resource.duration),
    size && formatBytes(size),
    new URL(resource.url).hostname
  ]
    .filter(Boolean)
    .join(' · ')
}

function Variant({ variant, task, onDownload }: { variant: VideoVariant; task?: DownloadTask; onDownload: () => void }) {
  const size = variant.size ? `${variant.sizeIsEstimate ? '约 ' : ''}${formatBytes(variant.size)}` : undefined
  // 没下载过、取消了或失败了，都可以（再）点下载
  if (!task || task.status === 'cancelled' || task.status === 'failed')
    return (
      <>
        <button className="btn" onClick={onDownload} aria-label={`下载 ${variant.label}`} title={size}>
          <DownloadIcon />
          {variant.label}
        </button>
        {task?.status === 'failed' && (
          <span className={styles.status} data-status="failed" title={task.error}>
            下载失败
          </span>
        )}
      </>
    )
  return (
    <span className={styles.status}>
      {variant.label} · {progress(task)}
    </span>
  )
}

function progress(task: DownloadTask): ReactNode {
  switch (task.status) {
    case 'queued':
      return '等待中'
    case 'downloading':
      return task.total ? `${Math.floor(Math.min(100, (task.received / task.total) * 100))}%` : formatBytes(task.received)
    case 'merging':
      return '正在合成视频文件'
    case 'done':
      return <span data-status="done">已保存</span>
    default:
      return null
  }
}
