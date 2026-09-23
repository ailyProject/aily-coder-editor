import type { LibraryTreeSource } from './ailyLibrarySource.js'

const SOURCE_DIRECTORY_NAME = 'src'
const LIBRARY_PACKAGE = /^@aily-project(?:-coder)?\/lib-[A-Za-z0-9][A-Za-z0-9._-]*$/u

export type ProjectDirectoryEntry = {
  readonly name: string
  readonly isDirectory: boolean
}

export type AilyLibraryProjection = {
  readonly label: string
  readonly relPath: string
  readonly packageName: string
  readonly source: LibraryTreeSource
  readonly description?: string
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

type PackageManifest = {
  readonly name?: string
  readonly version?: string
  readonly dependencies?: Record<string, string>
  readonly devDependencies?: Record<string, string>
  readonly optionalDependencies?: Record<string, string>
}

type ReadProjectTextFile = (relPath: string) => Promise<string | undefined>

/** Map the current dependency graph; stale node_modules left by a board switch are not active libraries. */
export async function listAilyLibraryProjections(
  readDirectory: ReadProjectDirectory,
  readTextFile: ReadProjectTextFile
): Promise<AilyLibraryProjection[]> {
  const manifests = new Map<string, Promise<PackageManifest | undefined>>()
  const readManifest = (relPath: string): Promise<PackageManifest | undefined> => {
    let pending = manifests.get(relPath)
    if (!pending) {
      pending = readTextFile(relPath).then(content => {
        try {
          const parsed: unknown = JSON.parse(content ?? '')
          return parsed != null && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed as PackageManifest : undefined
        } catch { return undefined }
      })
      manifests.set(relPath, pending)
    }
    return pending
  }
  const project = await readManifest('package.json')
  if (!project) return []
  const dependencies = { ...project.dependencies, ...project.devDependencies, ...project.optionalDependencies }
  const pending = Object.keys(dependencies).filter(name => LIBRARY_PACKAGE.test(name))
    .map(name => ({ name, relPath: `node_modules/${name}` }))
  const projections: AilyLibraryProjection[] = []
  const visitedPackages = new Set<string>()
  for (let index = 0; index < pending.length && visitedPackages.size < 200; index++) {
    const item = pending[index]!
    if (visitedPackages.has(item.relPath)) continue
    visitedPackages.add(item.relPath)
    const manifest = await readManifest(`${item.relPath}/package.json`)
    if (!manifest || manifest.name !== item.name) continue
    const source = item.name.startsWith('@aily-project-coder/') ? 'arduino' : 'aily'
    for (const root of await sourceRoots(readDirectory, item.relPath, item.name.split('/').at(-1)!)) {
      projections.push({ ...root, packageName: item.name, source })
    }
    for (const name of Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies })) {
      if (!LIBRARY_PACKAGE.test(name)) continue
      // Follow npm nearest-parent resolution instead of scanning every nested package.
      let parent = item.relPath
      while (true) {
        const relPath = parent ? `${parent}/node_modules/${name}` : `node_modules/${name}`
        if ((await readManifest(`${relPath}/package.json`))?.name === name) {
          pending.push({ name, relPath })
          break
        }
        if (!parent) break
        parent = parent.includes('/') ? parent.slice(0, parent.lastIndexOf('/')) : ''
      }
    }
  }
  const labelCounts = new Map<string, number>()
  for (const projection of projections) {
    labelCounts.set(projection.label, (labelCounts.get(projection.label) ?? 0) + 1)
  }
  projections.sort((left, right) => {
    const labelOrder = left.label.localeCompare(right.label)
    return labelOrder === 0 ? left.relPath.localeCompare(right.relPath) : labelOrder
  })
  // Distinct packages may intentionally supply the same library name. Keep both
  // real sources accessible and explain their ownership instead of hiding one.
  return projections.map(projection => {
    if ((labelCounts.get(projection.label) ?? 0) <= 1) return projection
    const samePackageRoots = projections.filter(item => item.label === projection.label && item.packageName === projection.packageName)
    return { ...projection, description: samePackageRoots.length > 1
      ? `${projection.packageName} · ${projection.relPath}` : projection.packageName }
  })
}
