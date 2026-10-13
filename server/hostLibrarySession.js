import { AsyncLocalStorage } from 'node:async_hooks'
import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

const manualRequests = new AsyncLocalStorage()

export function hasHostLibrarySession() {
  return /^\d+$/u.test(process.env.AILY_LIBRARY_HOST_PID ?? '')
}

export function isManualLibraryRequest() {
  return hasHostLibrarySession() && !!manualRequests.getStore() && !manualRequests.getStore()?.persisted
}

// Only the editor HTTP API opts in. Agent RPC keeps its persisted/history semantics.
export function withManualLibraryRequest(task) {
  return manualRequests.run(true, task)
}

export async function hostLibraryRequest(operation, projectPath, request) {
  const pid = process.env.AILY_LIBRARY_HOST_PID
  if (!hasHostLibrarySession()) throw new Error('Aily library host is unavailable')
  const bridge = JSON.parse(await readFile(path.join(os.homedir(), '.aily-blockly', 'cli-bridge', `${pid}.json`), 'utf8'))
  if (bridge.pid !== Number(pid) || !Number.isInteger(bridge.port) || !bridge.token) throw new Error('Invalid Aily library host')
  const response = await globalThis.fetch(`http://127.0.0.1:${bridge.port}/command`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: bridge.token, action: 'library-dependencies', operation, projectPath, request,
      transaction: manualRequests.getStore()?.transaction }),
  })
  const result = await response.json()
  if (!response.ok || !result.ok) throw new Error(result.message || 'Aily library operation failed')
  return result
}

export async function withHostLibraryTransaction(projectRoot, task, persisted = false, recover) {
  if (!hasHostLibrarySession()) return task()
  if (persisted) await assertSavedLibrarySession(projectRoot)
  let transaction
  try { ({ transaction } = await hostLibraryRequest('begin', projectRoot, { requireClean: persisted })) }
  catch (error) {
    if (error.message.includes('LIBRARY_CHANGES_UNSAVED')) error.code = 'LIBRARY_CHANGES_UNSAVED'
    throw error
  }
  return manualRequests.run({ transaction, persisted }, async () => {
    try {
      const result = await task()
      await hostLibraryRequest('end', projectRoot)
      return result
    } catch (error) {
      try {
        await hostLibraryRequest('abort', projectRoot)
        await recover?.()
      }
      catch (rollback) { throw new AggregateError([error, rollback], `${error.message}; 库还原失败: ${rollback.message}`) }
      throw error
    }
  })
}

export async function readProjectManifest(projectRoot) {
  if (hasHostLibrarySession()) return (await hostLibraryRequest('status', projectRoot)).manifest
  return JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'))
}

export async function assertSavedLibrarySession(projectRoot) {
  if (!hasHostLibrarySession() || isManualLibraryRequest() || manualRequests.getStore()?.persisted) return
  const status = await hostLibraryRequest('status', projectRoot)
  if (status.dirty || status.busy) {
    const error = new Error('请先保存或放弃手动库变更，再使用 Aily Chat 修改项目库。')
    error.code = 'LIBRARY_CHANGES_UNSAVED'
    throw error
  }
}
