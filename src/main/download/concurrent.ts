/** 任何一个失败就取消其余的，等全部结束（文件都已关闭）后抛出最先发生的那个错误 */
export async function allOrAbort(jobs: Promise<void>[], abort: AbortController): Promise<void> {
  let first: { error: unknown } | undefined
  await Promise.all(
    jobs.map((job) =>
      job.catch((error: unknown) => {
        first ??= { error }
        abort.abort()
      })
    )
  )
  if (first) throw first.error
}
