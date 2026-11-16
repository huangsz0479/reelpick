import type { ReactNode } from 'react'
import type { DownloadTask } from '@shared/types'
import { isActive } from '../lib/downloads'
import { AlertCircleIcon, CheckCircleIcon, DownloadIcon, GlobeIcon, LinkIcon, ProgressIcon, SlidersIcon } from './icons'
import styles from './Sidebar.module.css'

export type Filter = 'all' | 'active' | 'done' | 'failed'
/** 右侧显示的页面：解析页、浏览网页，或某个筛选条件下的下载列表 */
export type View = 'parse' | 'browse' | Filter

export interface FilterDef {
  id: Filter
  label: string
  match: (t: DownloadTask) => boolean
}

export const FILTERS: FilterDef[] = [
  { id: 'all', label: '全部', match: () => true },
  { id: 'active', label: '进行中', match: isActive },
  { id: 'done', label: '已完成', match: (t) => t.status === 'done' },
  { id: 'failed', label: '失败', match: (t) => t.status === 'failed' }
]

const ICONS: Record<View, ReactNode> = {
  parse: <LinkIcon />,
  browse: <GlobeIcon />,
  all: <DownloadIcon />,
  active: <ProgressIcon />,
  done: <CheckCircleIcon />,
  failed: <AlertCircleIcon />
}

const SETTINGS_KEYS = window.api.platform === 'darwin' ? '⌘,' : 'Ctrl+,'

interface Props {
  tasks: DownloadTask[]
  view: View
  onView: (view: View) => void
}

export function Sidebar({ tasks, view, onView }: Props) {
  const item = (id: View, label: string, count = 0) => (
    <button key={id} className={styles.item} aria-current={view === id ? 'page' : undefined} onClick={() => onView(id)}>
      {ICONS[id]}
      {label}
      {count > 0 && <span className={styles.aside}>{count}</span>}
    </button>
  )

  return (
    <aside className={styles.sidebar}>
      <div className={`${styles.titlebar} drag`} />
      <nav className={styles.nav} aria-label="主导航">
        {item('parse', '解析链接')}
        {item('browse', '浏览网页')}
        <h2 className={styles.heading}>下载</h2>
        {FILTERS.map((f) => item(f.id, f.label, tasks.filter(f.match).length))}
      </nav>
      <button className={`${styles.item} ${styles.settings}`} onClick={() => void window.api.settings.openWindow()}>
        <SlidersIcon />
        设置
        <span className={styles.aside} aria-hidden="true">
          {SETTINGS_KEYS}
        </span>
      </button>
    </aside>
  )
}
