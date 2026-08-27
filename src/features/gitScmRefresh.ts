/** 合并并发刷新请求：当前任务完成后最多再执行一次尾随刷新。 */
export function createTrailingSingleFlight(
  task: () => Promise<void>
): () => Promise<void> {
  let requested = false
  let active: Promise<void> | undefined

  return () => {
    requested = true
    if (active == null) {
      active = (async () => {
        while (requested) {
          requested = false
          await task()
        }
      })().finally(() => {
        active = undefined
      })
    }
    return active
  }
}
