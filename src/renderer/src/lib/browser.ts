import { useSyncExternalStore } from 'react'
import type { BrowserState } from '@shared/browser'

let state: BrowserState = { url: '', title: '', loading: false, canGoBack: false, canGoForward: false, resources: [] }
const listeners = new Set<() => void>()

function set(next: BrowserState): void {
  state = next
  for (const listener of listeners) listener()
}

window.api.browser.onChange(set)
void window.api.browser.state().then(set)

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export const useBrowserState = (): BrowserState => useSyncExternalStore(subscribe, () => state)
