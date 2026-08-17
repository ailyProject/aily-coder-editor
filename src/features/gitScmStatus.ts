const SYSTEM_DIRECTORIES = new Set(['.aily', '.log', '.workspace-history'])

export type GitStatusEntry = {
  path: string
  originalPath?: string
  indexStatus: string
  workingTreeStatus: string
}

function normalizeRelativePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '')
}

function isSystemDirectoryPath(value: string): boolean {
  return normalizeRelativePath(value)
    .split('/')
    .some((segment) => SYSTEM_DIRECTORIES.has(segment.toLowerCase()))
}

/** 解析 `git status --porcelain=v1 -z`，保留包含空格和重命名的路径。 */
export function parseGitPorcelainZ(raw: string): GitStatusEntry[] {
  const tokens = raw.split('\0')
  const entries: GitStatusEntry[] = []

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]
    if (!token || token.length < 4 || token[2] !== ' ') {
      continue
    }

    const indexStatus = token[0] ?? ' '
    const workingTreeStatus = token[1] ?? ' '
    const path = normalizeRelativePath(token.slice(3))
    const isRenameOrCopy = indexStatus === 'R' || indexStatus === 'C'
    const originalPath = isRenameOrCopy
      ? normalizeRelativePath(tokens[++index] ?? '')
      : undefined

    if (!path || isSystemDirectoryPath(path)) {
      continue
    }

    entries.push({
      path,
      ...(originalPath ? { originalPath } : {}),
      indexStatus,
      workingTreeStatus
    })
  }

  return entries
}
