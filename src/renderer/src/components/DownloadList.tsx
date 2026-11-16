import { Progress } from '@base-ui/react/progress'
import { useState, type ReactNode } from 'react'
import type { DownloadTask } from '@shared/types'
import { isActive } from '../lib/downloads'
import { formatBytes, hangsLeft } from '../lib/format'
import styles from './DownloadList.module.css'
import { CloseIcon, FolderIcon, RetryIcon, StopIcon } from './icons'
import type { FilterDef } from './Sidebar'

const REVEAL_LABEL = window.api.platform === 'darwin' ? '在访达中显示' : '在资源管理器中显示'

interface Props {
  tasks: DownloadTask[]
  filter: FilterDef
  onGoParse: () => void
}

export function DownloadList({ tasks, filter, onGoParse }: Props) {
  const visible = tasks.filter(filter.match)

  if (tasks.length === 0)
    return (
      <div className={styles.empty}>
        <h2>还没有下载</h2>
        <p>解析一条链接后点「下载」，文件会列在这里</p>
        <button className="btn" onClick={onGoParse}>
          去解析链接
        </button>
      </div>
    )
  if (visible.length === 0)
    return (
      <div className={styles.empty}>
        <p>没有{filter.label}的下载</p>
      </div>
    )

  return (
    <ul className={styles.list} aria-label="下载列表">
      {visible.map((task) => (
        <Row key={task.id} task={task} />
      ))}
    </ul>
  )
}

function Row({ task }: { task: DownloadTask }) {
  const [missing, setMissing] = useState(false)
  const [coverFailed, setCoverFailed] = useState(false)
  const { downloads } = window.api
  const active = isActive(task)
  const percent = task.total ? Math.min(100, (task.received / task.total) * 100) : null
  const progress = task.status === 'downloading' ? percent : task.status === 'merging' ? 100 : 0
  const withFile = (action: (id: string) => Promise<boolean>) => () =>
    void action(task.id).then((found) => setMissing(!found))

  return (
    <li className={styles.row} onDoubleClick={task.status === 'done' ? withFile(downloads.open) : undefined}>
      <div className={styles.thumb}>
        {task.cover && !coverFailed && (
          <img src={task.cover} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setCoverFailed(true)} />
        )}
      </div>
      <div className={styles.body}>
        <p className="truncate" title={task.title} data-hang={hangsLeft(task.title) || undefined}>
          {task.title}
        </p>
        <p className={styles.meta}>
          {task.label && `${task.label} · `}
          {missing ? <span data-status="failed">文件已被移动或删除</span> : status(task, percent)}
        </p>
      </div>
      <div className={styles.actions}>
        {active && (
          <button className="icon-btn" onClick={() => void downloads.cancel(task.id)} aria-label="取消下载" title="取消下载">
            <StopIcon />
          </button>
        )}
        {task.status === 'done' && !missing && (
          <button className="icon-btn" onClick={withFile(downloads.reveal)} aria-label={REVEAL_LABEL} title={REVEAL_LABEL}>
            <FolderIcon />
          </button>
        )}
        {((task.status === 'cancelled' && task.retryable !== false) || (task.status === 'failed' && task.retryable)) && (
          <button className="icon-btn" onClick={() => void downloads.retry(task.id)} aria-label="重新下载" title="重新下载">
            <RetryIcon />
          </button>
        )}
        {!active && (
          <button className="icon-btn" onClick={() => void downloads.remove(task.id)} aria-label="从列表移除" title="从列表移除（不删除文件）">
            <CloseIcon />
          </button>
        )}
      </div>
      {active && (
        <Progress.Root className={styles.progress} value={progress} aria-label={`${task.title} 下载进度`}>
          <Progress.Track className={styles.track}>
            {/* 整条等宽，靠位移露出已完成的部分：进度变化时只动 transform，不触发布局 */}
            <Progress.Indicator
              className={styles.indicator}
              style={progress === null ? undefined : { width: '100%', transform: `translateX(${progress - 100}%)` }}
            />
          </Progress.Track>
        </Progress.Root>
      )}
    </li>
  )
}

function status(task: DownloadTask, percent: number | null): ReactNode {
  switch (task.status) {
    case 'queued':
      return '等待中'
    case 'downloading':
      return `${percent === null ? formatBytes(task.received) : `${Math.floor(percent)}%`} · ${formatBytes(task.speed)}/s`
    case 'merging':
      return '正在合成视频文件'
    case 'done':
      return (
        <>
          <span data-status="done">已保存</span> · {formatBytes(task.received)}
        </>
      )
    case 'cancelled':
      return '已取消'
    case 'failed':
      return <span data-status="failed">{task.error ?? '下载失败'}</span>
  }
}
