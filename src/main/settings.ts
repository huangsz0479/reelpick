import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Settings } from '@shared/types'

export class SettingsStore {
  private current: Settings

  constructor(
    private file: string,
    defaults: Settings
  ) {
    let saved: Partial<Settings> = {}
    try {
      saved = JSON.parse(readFileSync(file, 'utf8')) as Partial<Settings>
    } catch {
      // 首次启动或文件损坏时使用默认值
    }
    this.current = { ...defaults, ...saved }
  }

  get(): Settings {
    return { ...this.current }
  }

  update(patch: Partial<Settings>): Settings {
    this.current = { ...this.current, ...patch }
    mkdirSync(dirname(this.file), { recursive: true })
    writeFileSync(this.file, JSON.stringify(this.current, null, 2))
    return this.get()
  }
}
