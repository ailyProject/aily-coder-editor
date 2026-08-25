const AILY_LIBRARY_SCOPE_REL = 'node_modules/@aily-project'
const AILY_LIBRARY_PACKAGE_PREFIX = 'lib-'
const SOURCE_DIRECTORY_NAME = 'src'

export type ProjectDirectoryEntry = {
  readonly name: string
  readonly isDirectory: boolean
}

export type AilyLibraryProjection = {
  readonly label: string
  readonly relPath: string
}

type ReadProjectDirectory = (
  relPath: string
) => Promise<readonly ProjectDirectoryEntry[]>

function childPath(parent: string, name: string): string {
  return `${parent}/${name}`
}

async function findDeepestSourceDirectory(
  readDirectory: ReadProjectDirectory,
  packageRelPath: string
): Promise<{ readonly relPath: string; readonly entries: readonly ProjectDirectoryEntry[] } | undefined> {
  let currentPath = packageRelPath
  let entries = await readDirectory(currentPath)
  let sourceEntry = entries.find(
    (entry) => entry.name === SOURCE_DIRECTORY_NAME && entry.isDirectory
  )
  if (sourceEntry == null) {
    return undefined
  }

  do {
    currentPath = childPath(currentPath, SOURCE_DIRECTORY_NAME)
    entries = await readDirectory(currentPath)
    sourceEntry = entries.find(
      (entry) => entry.name === SOURCE_DIRECTORY_NAME && entry.isDirectory
    )
  } while (sourceEntry != null)

  return { relPath: currentPath, entries }
}

/**
 * 将已安装的 @aily-project/lib-* 包映射为 Aily View / Library 的直属库节点。
 * 只沿包根下连续的 src/src/... 向内查找，并采用最深 src 的直属目录；
 * 不含 src 的包以及最深 src 下的文件都不会成为库节点。
 */
export async function listAilyLibraryProjections(
  readDirectory: ReadProjectDirectory
): Promise<AilyLibraryProjection[]> {
  const scopeEntries = await readDirectory(AILY_LIBRARY_SCOPE_REL)
  const packageEntries = scopeEntries.filter(
    (entry) => entry.isDirectory && entry.name.startsWith(AILY_LIBRARY_PACKAGE_PREFIX)
  )
  const perPackage = await Promise.all(packageEntries.map(async (packageEntry) => {
    const packageRelPath = childPath(AILY_LIBRARY_SCOPE_REL, packageEntry.name)
    const source = await findDeepestSourceDirectory(readDirectory, packageRelPath)
    if (source == null) {
      return []
    }
    return source.entries
      .filter((entry) => (
        entry.isDirectory &&
        entry.name !== SOURCE_DIRECTORY_NAME &&
        !entry.name.startsWith('.')
      ))
      .map((entry) => ({
        label: entry.name,
        relPath: childPath(source.relPath, entry.name)
      }))
  }))
  const projections = perPackage.flat()

  projections.sort((left, right) => {
    const labelOrder = left.label.localeCompare(right.label)
    return labelOrder === 0 ? left.relPath.localeCompare(right.relPath) : labelOrder
  })
  return projections
}
