import { lstat, rename } from 'node:fs/promises'
import { setTimeout } from 'node:timers/promises'

const RETRY_DELAYS_MS = [80, 200, 500]
const RETRYABLE_CODES = new Set(['EPERM', 'EACCES', 'EBUSY'])

/** Publish validated staging with bounded retries and no destructive overwrite fallback. */
export async function publishLibraryDirectory(source, target, {
  signal, renameDirectory = rename, wait = setTimeout,
} = {}) {
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted()
    const existing = await lstat(target).catch(error => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (existing) {
      throw Object.assign(new Error(`Library destination already exists: ${target}`), {
        code: 'BLOCKLY_LIBRARY_PATH_CONFLICT',
      })
    }
    try {
      await renameDirectory(source, target)
      return
    } catch (error) {
      // These codes can also mean a persistent permissions problem. Retry only
      // this idempotent publication step, not npm, extraction or the whole tool.
      const retryable = RETRYABLE_CODES.has(error.code)
      if (!retryable || attempt === RETRY_DELAYS_MS.length) {
        error.details = { ...error.details, publication: {
          phase: 'publish-source', attempts: attempt + 1,
          filesystemCode: error.code, automaticRetryExhausted: retryable,
        } }
        throw error
      }
      await wait(RETRY_DELAYS_MS[attempt], undefined, { signal })
    }
  }
}
