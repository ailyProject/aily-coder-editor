import type { LibraryTreeSource } from './ailyLibrarySource.js'

const SOURCE_DIRECTORY_NAME = 'src'
const PACKAGE_SCOPES = [
  { name: '@aily-project', prefix: 'lib-', source: 'aily' as const },
  { name: '@aily-project-coder', prefix: 'lib-', source: 'arduino' as const }
]

export type ProjectDirectoryEntry = {
  readonly name: string
  readonly isDirectory: boolean
}

export type AilyLibraryProjection = {
  readonly label: string
  readonly relPath: string
  readonly packageName: string
  readonly source: LibraryTreeSource
}

type ReadProjectDirectory = (
  relPath: string
) => Promise<readonly ProjectDirectoryEntry[]>

function childPath(parent: string, name: string): string {
  return `${parent}/${name}`
}

async function sourceRoots(
  readDirectory: ReadProjectDirectory,
  packageRelPath: string,
  fallbackLabel: string
): Promise<readonly { readonly label: string; readonly relPath: string }[]> {
  let currentPath = childPath(packageRelPath, SOURCE_DIRECTORY_NAME)
  let entries = (await readDirectory(currentPath))
    .filter(entry => !entry.name.startsWith('.'))
  if (entries.length === 0) return []

  // Peel only continuous, unambiguous src wrappers. The final library's own
  // src directory is preserved as soon as files or sibling directories exist.
  while (
    entries.length === 1 &&
    entries[0]?.name === SOURCE_DIRECTORY_NAME &&
    entries[0]?.isDirectory === true
  ) {
    currentPath = childPath(currentPath, SOURCE_DIRECTORY_NAME)
    entries = (await readDirectory(currentPath))
      .filter(entry => !entry.name.startsWith('.'))
    if (entries.length === 0) return []
  }

  if (entries.some(entry => !entry.isDirectory)) {
    return [{ label: fallbackLabel, relPath: currentPath }]
  }
  return entries
    .filter(entry => entry.isDirectory && !entry.name.startsWith('.'))
    .map(entry => ({ label: entry.name, relPath: childPath(currentPath, entry.name) }))
}

/** Map package-local Coder sources without copying them into sketch/libraries. */
export async function listAilyLibraryProjections(
  readDirectory: ReadProjectDirectory
): Promise<AilyLibraryProjection[]> {
  const projections: AilyLibraryProjection[] = []
  const visitedPackages = new Set<string>()
  const visitNodeModules = async (nodeModulesRelPath: string): Promise<void> => {
    for (const scope of PACKAGE_SCOPES) {
      const scopeRelPath = childPath(nodeModulesRelPath, scope.name)
      const packages = (await readDirectory(scopeRelPath))
        .filter(entry => entry.isDirectory && entry.name.startsWith(scope.prefix))
      for (const packageEntry of packages) {
        const packageRelPath = childPath(scopeRelPath, packageEntry.name)
        if (visitedPackages.has(packageRelPath) || visitedPackages.size >= 200) continue
        visitedPackages.add(packageRelPath)
        const packageName = `${scope.name}/${packageEntry.name}`
        for (const root of await sourceRoots(readDirectory, packageRelPath, packageEntry.name)) {
          projections.push({ ...root, packageName, source: scope.source })
        }
        await visitNodeModules(childPath(packageRelPath, 'node_modules'))
      }
    }
  }
  await visitNodeModules('node_modules')
  projections.sort((left, right) => {
    const labelOrder = left.label.localeCompare(right.label)
    return labelOrder === 0 ? left.relPath.localeCompare(right.relPath) : labelOrder
  })
  return projections
}
