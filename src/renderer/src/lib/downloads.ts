import { useSyncExternalStore } from 'react'
import type { DownloadTask } from '@shared/types'

let tasks: DownloadTask[] = []
const listeners = new Set<() => void>()

function set(next: DownloadTask[]): void {
  tasks = next
  for (const listener of listeners) listener()
}

window.api.downloads.onChange(set)
void window.api.downloads.list().then(set)

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export const useDownloads = (): DownloadTask[] => useSyncExternalStore(subscribe, () => tasks)

export const isActive = (t: DownloadTask) =>
  t.status === 'queued' || t.status === 'downloading' || t.status === 'merging'
