import { listInstalledAilyLibraryPackages, type ProjectDirectoryEntry } from '../ailyLibraryProjection.js'
import { sourceIncludes } from '../ailyLibraryUsage.js'

export interface LibraryFileSystem {
  readDirectory(path: string): Promise<readonly ProjectDirectoryEntry[]>
  readText(path: string): Promise<string | undefined>
}
export interface ProjectLibrary {
  id: string
  name: string
  version: string
  roots: string[]
  packageName?: string
}
export interface LibraryHeader { path: string; include: string; source: string }
export interface LibraryHeaders { headers: LibraryHeader[]; notices: string[] }

function object(text?: string): Record<string, unknown> {
  try { const value: unknown = JSON.parse(text ?? ''); return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {} }
  catch { return {} }
}
const string = (value: unknown): string => typeof value === 'string' ? value : ''
export function libraryProperties(text?: string): Record<string, string> {
  return Object.fromEntries((text ?? '').split(/\r?\n/).filter(line => /^\s*[^#!\s][^=]*=/.test(line)).map(line => {
    const at = line.indexOf('='); return [line.slice(0, at).trim(), line.slice(at + 1).trim()]
  }))
}

const headerName = (name: string): boolean => /\.(?:h|hh|hpp|hxx)$/i.test(name)
const publicEntry = (name: string): boolean => !/^[._]/.test(name) && !/^(?:detail|details|internal|private|impl|examples?|tests?|testing|docs?|extras?|tools?|build|dist|node_modules)$/i.test(name)
const hasDirectory = (entries: readonly ProjectDirectoryEntry[], name: string): boolean => entries.some(entry => entry.isDirectory && entry.name === name)
const hasLibraryLayout = (entries: readonly ProjectDirectoryEntry[]): boolean => entries.some(entry => !entry.isDirectory && entry.name === 'library.properties') || hasDirectory(entries, 'include')

/** Keep namespace folders in include paths; split bundles only at library boundaries. */
async function packageSourceRoots(fs: LibraryFileSystem, packageRoot: string): Promise<string[]> {
  let root = packageRoot, entries = await fs.readDirectory(root)
  if (hasLibraryLayout(entries) || entries.some(entry => !entry.isDirectory && headerName(entry.name))) return [root]
  if (hasDirectory(entries, 'src')) { root += '/src'; entries = await fs.readDirectory(root) }
  entries = entries.filter(entry => publicEntry(entry.name))
  while (entries.length === 1 && hasDirectory(entries, 'src')) {
    root += '/src'; entries = (await fs.readDirectory(root)).filter(entry => publicEntry(entry.name))
  }
  if (!entries.length || entries.some(entry => !entry.isDirectory) || hasLibraryLayout(entries)) return [root]
  const children = await Promise.all(entries.map(async entry => ({ root: `${root}/${entry.name}`, entries: await fs.readDirectory(`${root}/${entry.name}`) })))
  return children.every(child => hasLibraryLayout(child.entries) || hasDirectory(child.entries, 'src')) ? children.map(child => child.root) : [root]
}

/** The same active npm graph as Aily View, plus libraries actually on the Coder build path. */
export async function discoverProjectLibraries(fs: LibraryFileSystem): Promise<ProjectLibrary[]> {
  const [packages, directories] = await Promise.all([
    listInstalledAilyLibraryPackages(fs.readText),
    fs.readDirectory('sketch/libraries')
  ])
  const result: ProjectLibrary[] = await Promise.all(packages.map(async ({ relPath, manifest }) => ({
    id: relPath, name: manifest.nickname_zh_cn || manifest.nickname || manifest.name.split('/').at(-1)!,
    version: manifest.version ?? '', packageName: manifest.name,
    roots: await packageSourceRoots(fs, relPath)
  })))
  for (const directory of directories.filter(entry => entry.isDirectory && !entry.name.startsWith('.'))) {
    const root = `sketch/libraries/${directory.name}`
    const [propsText, packageText, receiptText] = await Promise.all([
      fs.readText(`${root}/library.properties`), fs.readText(`${root}/package.json`), fs.readText(`${root}/.aily-blockly-library.json`)
    ])
    const props = libraryProperties(propsText), pkg = object(packageText), receipt = object(receiptText)
    const packageName = receipt.source === 'blockly-library' ? string(receipt.packageName) : ''
    const owner = result.find(lib => lib.packageName === packageName)
    if (owner) {
      // Materialized copies are what the Coder compiler consumes. Replace only
      // the matching source root; packages may bundle several Arduino libraries.
      const name = props.name || directory.name
      const matching = await Promise.all(owner.roots.map(async path => ({ path, name: libraryProperties(await fs.readText(`${path}/library.properties`)).name || path.split('/').at(-1)! })))
      owner.roots = owner.roots.filter(path => !matching.some(entry => entry.path === path && entry.name === name))
      owner.roots.push(root)
    } else {
      result.push({ id: root, name: props.name || string(pkg.nickname_zh_cn) || string(pkg.nickname) || directory.name, version: props.version || string(pkg.version), roots: [root] })
    }
  }
  return result.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
}

/** Resolve include paths within one library; never walk out to another package. */
function within(root: string, relative: string): string | undefined {
  if (relative.startsWith('/') || relative.includes('\\')) return undefined
  const segments: string[] = []
  for (const part of relative.split('/')) {
    if (part === '..') { if (!segments.length) return undefined; segments.pop() }
    else if (part && part !== '.') segments.push(part)
  }
  return `${root}/${segments.join('/')}`
}

async function publicHeaders(fs: LibraryFileSystem, base: string, notices: string[]): Promise<string[]> {
  const headers: string[] = [], directories = [{ relative: '', depth: 0 }]
  for (let index = 0; index < directories.length; index++) {
    if (index >= 256) { notices.push('目录较多，已达到本次公开头文件扫描上限（256 个目录）'); break }
    const { relative, depth } = directories[index]!
    const entries = [...await fs.readDirectory(relative ? `${base}/${relative}` : base)].sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (!publicEntry(entry.name)) continue
      const path = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.isDirectory) {
        if (depth < 12) directories.push({ relative: path, depth: depth + 1 })
        else notices.push('目录较深，已达到本次公开头文件扫描上限（12 层）')
      } else if (headerName(entry.name)) {
        headers.push(path)
        if (headers.length >= 128) { notices.push('接口较多，已达到本次索引上限（128 个头文件 / 2 MB）'); return headers }
      }
    }
  }
  return headers
}

/** Public entry headers and their local includes, bounded for interactive use. */
export async function readLibraryHeaders(fs: LibraryFileSystem, library: ProjectLibrary): Promise<LibraryHeaders> {
  const headers: LibraryHeader[] = [], notices: string[] = []
  const visited = new Set<string>()
  let size = 0
  for (const root of library.roots) {
    const props = libraryProperties(await fs.readText(`${root}/library.properties`))
    const entries = await fs.readDirectory(root)
    let base = hasDirectory(entries, 'include') ? `${root}/include` : hasDirectory(entries, 'src') ? `${root}/src` : root
    if (base.endsWith('/src') && hasDirectory(await fs.readDirectory(base), 'include')) base += '/include'
    const explicit = props.includes?.split(',').map(s => s.trim()).filter(Boolean)
    const includes = explicit?.length ? explicit : await publicHeaders(fs, base, notices)
    const queue = includes.map(include => ({ path: within(base, include), include, entry: true }))
    for (let index = 0; index < queue.length; index++) {
      const item = queue[index]!
      if (!item.path || visited.has(item.path)) continue
      visited.add(item.path)
      if (headers.length >= 128 || size >= 2_000_000) { notices.push('接口较多，已达到本次索引上限（128 个头文件 / 2 MB）'); break }
      const source = await fs.readText(item.path)
      if (source === undefined) { if (item.entry) notices.push(`无法读取公开头文件 ${item.include}`); continue }
      if (source.length > 250_000 || size + source.length > 2_000_000) { notices.push(`头文件过大，未索引 ${item.path.split('/').at(-1)}`); continue }
      size += source.length
      headers.push({ path: item.path, include: item.include, source })
      // Follow declarations from internal headers through their public umbrella.
      const referenced: typeof queue = []
      for (const { header: include } of sourceIncludes(source)) {
        if (!headerName(include)) continue
        const relative = item.path.slice(base.length + 1).split('/').slice(0, -1).concat(include).join('/')
        const local = within(base, relative), absolute = within(base, include)
        let path = local
        if (!path || await fs.readText(path) === undefined) path = absolute
        if (path && !visited.has(path) && await fs.readText(path) !== undefined) referenced.push({ path, include: item.include, entry: false })
      }
      // Visit the umbrella's dependencies first, so nested declarations retain
      // its public include even when the directory scan also found that file.
      queue.splice(index + 1, 0, ...referenced)
    }
  }
  if (!headers.length && !notices.length) notices.push('未找到可读取的 C++ 公开头文件')
  return { headers, notices: [...new Set(notices)] }
}
