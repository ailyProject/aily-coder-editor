import type { NativeGitHistoryRef } from '../parentBackedNativeFs.js'

export type GitHistoryItem = {
  id: string
  parentIds: string[]
  subject: string
  message: string
  author: string
  authorEmail: string
  timestamp: number
}

export type GitHistoryItemChange = {
  status: string
  path: string
  originalPath?: string
}

const HISTORY_FIELD_COUNT = 7

/** 解析宿主 `git log` 的 NUL 分隔字段；提交正文可以安全保留换行。 */
export function parseGitHistoryItems(raw: string): GitHistoryItem[] {
  const fields = raw.split('\0')
  const items: GitHistoryItem[] = []

  for (let index = 0; index + HISTORY_FIELD_COUNT - 1 < fields.length; index += HISTORY_FIELD_COUNT) {
    const id = (fields[index] ?? '').replace(/^\r?\n+/, '').trim()
    if (!/^[0-9a-f]{40,64}$/iu.test(id)) {
      continue
    }
    const timestampSeconds = Number(fields[index + 4] ?? 0)
    items.push({
      id,
      parentIds: (fields[index + 1] ?? '').trim().split(/\s+/u).filter(Boolean),
      author: fields[index + 2] ?? '',
      authorEmail: fields[index + 3] ?? '',
      timestamp: Number.isFinite(timestampSeconds) ? timestampSeconds * 1000 : 0,
      subject: fields[index + 5] ?? '',
      message: (fields[index + 6] ?? '').trimEnd()
    })
  }

  return items
}

/** 解析 `git diff --name-status -z`，包含重命名和复制的双路径记录。 */
export function parseGitHistoryItemChanges(raw: string): GitHistoryItemChange[] {
  const fields = raw.split('\0')
  const changes: GitHistoryItemChange[] = []

  for (let index = 0; index < fields.length;) {
    const status = fields[index++] ?? ''
    if (!status) {
      continue
    }
    if (status.startsWith('R') || status.startsWith('C')) {
      const originalPath = fields[index++] ?? ''
      const path = fields[index++] ?? ''
      if (originalPath && path) {
        changes.push({ status, originalPath, path })
      }
      continue
    }
    const path = fields[index++] ?? ''
    if (path) {
      changes.push({ status, path })
    }
  }

  return changes
}

export function historyRefsByRevision(
  refs: readonly NativeGitHistoryRef[]
): Map<string, NativeGitHistoryRef[]> {
  const result = new Map<string, NativeGitHistoryRef[]>()
  for (const ref of refs) {
    const list = result.get(ref.revision) ?? []
    list.push(ref)
    result.set(ref.revision, list)
  }
  return result
}
