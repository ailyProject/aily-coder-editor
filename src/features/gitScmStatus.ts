/** Coder 生成或依赖目录：不进入默认搜索、SCM 状态和提交。 */
const SYSTEM_DIRECTORIES = new Set([
  '.aily',
  '.build',
  '.log',
  '.workspace-history',
  'node_modules'
])

export type GitStatusEntry = {
  path: string
  originalPath?: string
  indexStatus: string
  workingTreeStatus: string
}

function normalizeRelativePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '')
}

function isExcludedDirectoryPath(value: string): boolean {
  return normalizeRelativePath(value)
    .split('/')
    .some((segment) => SYSTEM_DIRECTORIES.has(segment.toLowerCase()))
}

function isTransientGitLockPath(value: string): boolean {
  const segments = normalizeRelativePath(value).split('/')
  const gitIndex = segments.findIndex((segment) => segment.toLowerCase() === '.git')
  return gitIndex >= 0 && segments.at(-1)?.toLowerCase().endsWith('.lock') === true
}

/**
 * 判断工作区文件事件是否需要刷新 SCM。
 *
 * 生成目录会持续写日志或构建产物，不能反向触发 Git 命令；未初始化仓库时，
 * 仅关注外部创建的 `.git`，其余源码变更无需反复执行仓库探测。
 */
export function shouldRefreshGitScmForPath(
  value: string,
  repositoryInitialized: boolean | undefined
): boolean {
  const normalized = normalizeRelativePath(value)
  if (!normalized || normalized === '.') {
    // 递归 native watcher 可能只报告工作区根；该事件无法判断真实来源，且会被
    // Git 命令写入 `.log` 反向触发。具体源码和 `.git` 事件仍会单独上报。
    return false
  }
  if (isExcludedDirectoryPath(normalized)) {
    return false
  }
  if (isTransientGitLockPath(normalized)) {
    // `git status` 本身可能短暂创建 `.git/index.lock`。若把锁文件事件再次用于
    // 刷新 SCM，会形成 status -> index.lock -> status 的自激循环。
    return false
  }
  if (repositoryInitialized === false) {
    return normalized.split('/')[0]?.toLowerCase() === '.git'
  }
  return true
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

    if (!path || isExcludedDirectoryPath(path)) {
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
