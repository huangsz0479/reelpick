import type { AppError, ParseErrorCode, Platform } from '@shared/types'

export class ParseError extends Error {
  constructor(
    readonly code: ParseErrorCode,
    message: string,
    readonly platform?: Platform
  ) {
    super(message)
  }
}

export function toAppError(e: unknown): AppError {
  if (e instanceof ParseError) return { code: e.code, message: e.message, platform: e.platform }
  return { code: 'internal', message: `解析时出现意外错误：${e instanceof Error ? e.message : String(e)}` }
}
