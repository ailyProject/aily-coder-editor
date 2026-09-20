/** Coder source references checked before the shared library uninstall flow. */
export type LibraryUsage = { readonly file: string; readonly line: number; readonly header: string }
export type LibraryUsageSource = {
  readonly libraryRoots?: readonly string[]
  readonly sourceDirectory?: string
  readonly folderName?: string
}
export type LibraryUsageFileSystem = {
  readDirectory(path: string): Promise<readonly { name: string; isDirectory: boolean }[]>
  readFile(path: string): Promise<string>
  /** Open editor buffers, including unsaved changes, take precedence over disk. */
  readonly documents?: ReadonlyMap<string, string>
}

const SKETCH_ROOT = 'sketch'
const LOCAL_LIBRARIES_ROOT = `${SKETCH_ROOT}/libraries`
const SOURCE_FILE = /\.(?:c|cc|cpp|cxx|c\+\+|h|hh|hpp|hxx|h\+\+|ino|ipp|tpp|inc)$/iu
const HEADER_FILE = /\.(?:h|hh|hpp|hxx|h\+\+|ipp|tpp|inc)$/iu
const IGNORED_DIRECTORIES = new Set(['node_modules', 'build', 'dist'])
const MAX_ENTRIES = 20_000

function normalize(path: string): string {
  const parts: string[] = []
  for (const part of path.replace(/\\/gu, '/').split('/')) {
    if (!part || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return parts.join('/')
}

function within(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`)
}

function withoutComments(code: string): string {
  // Keep quoted include operands, but mask comments and multiline raw strings.
  return code.replace(/R"([^ ()\\\t\r\n]{0,16})\([\s\S]*?\)\1"|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\/\*[\s\S]*?(?:\*\/|$)|\/\/(?:\\\r?\n|[^\r\n])*/gu,
    token => token.startsWith('/') || token.startsWith('R"') ? token.replace(/[^\r\n]/gu, ' ') : token)
}

/** Literal includes and same-file object macros; conditional branches are conservative. */
export function sourceIncludes(code: string): Omit<LibraryUsage, 'file'>[] {
  const lines = withoutComments(code).split(/\r?\n/u)
  const macros = new Map<string, string>()
  const includes: Omit<LibraryUsage, 'file'>[] = []
  for (let index = 0; index < lines.length; index++) {
    const line = index + 1
    let text = lines[index] ?? ''
    while (/\\\s*$/u.test(text) && index + 1 < lines.length) {
      text = text.replace(/\\\s*$/u, '') + (lines[++index] ?? '')
    }
    const define = /^\s*#\s*define\s+(\w+)\s+([<"][^>"]+[>"])\s*$/u.exec(text)
    if (define) macros.set(define[1]!, define[2]!)
    const undef = /^\s*#\s*undef\s+(\w+)/u.exec(text)
    if (undef) macros.delete(undef[1]!)
    const include = /^\s*#\s*(?:include|include_next|import)\s*(.+?)\s*$/u.exec(text)
    if (!include) continue
    const operand = macros.get(include[1]!) ?? include[1]!
    const header = /^[<"]([^>"]+)[>"]/u.exec(operand)?.[1]
    if (header) includes.push({ line, header: header.replace(/\\/gu, '/') })
  }
  return includes
}

export async function findLibraryUsage(fs: LibraryUsageFileSystem, library: LibraryUsageSource): Promise<LibraryUsage[]> {
  const roots = [...new Set((library.libraryRoots?.length ? library.libraryRoots
    : library.sourceDirectory ? [library.sourceDirectory]
      : library.folderName ? [`${LOCAL_LIBRARIES_ROOT}/${library.folderName}`] : []).map(normalize))]
  if (!roots.length) throw new Error('Cannot locate the installed library source')
  const documents = fs.documents ?? new Map<string, string>()
  let entryCount = 0
  const walk = async (path: string, files: Set<string>, excluded: readonly string[] = []): Promise<void> => {
    if (excluded.some(root => within(path, root))) return
    for (const entry of await fs.readDirectory(path)) {
      if (++entryCount > MAX_ENTRIES) throw new Error('Too many source entries to complete the library usage check')
      if (entry.name.startsWith('.')) continue
      const child = `${path}/${entry.name}`
      if (entry.isDirectory) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) await walk(child, files, excluded)
      } else if (SOURCE_FILE.test(entry.name) && !excluded.some(root => within(child, root))) {
        files.add(child)
      }
    }
  }
  const projectFiles = new Set<string>()
  await walk(SKETCH_ROOT, projectFiles, roots.filter(root => within(root, SKETCH_ROOT)))
  for (const path of documents.keys()) {
    if (within(path, SKETCH_ROOT) && SOURCE_FILE.test(path) && !roots.some(root => within(path, root))) projectFiles.add(path)
  }

  const localHeaders = new Set<string>()
  for (const path of projectFiles) {
    if (!within(path, LOCAL_LIBRARIES_ROOT) || !HEADER_FILE.test(path)) continue
    const relative = path.slice(LOCAL_LIBRARIES_ROOT.length + 1).split('/').slice(1).join('/')
    localHeaders.add(relative)
    if (relative.startsWith('src/')) localHeaders.add(relative.slice(4))
  }
  const headers = new Set<string>()
  const targetFiles = new Set<string>()
  for (const root of roots) {
    const files = new Set<string>()
    await walk(root, files)
    for (const path of files) {
      if (!HEADER_FILE.test(path)) continue
      targetFiles.add(path)
      const relative = path.slice(root.length + 1)
      headers.add(relative)
      if (relative.startsWith('src/')) headers.add(relative.slice(4))
    }
  }
  const uses: LibraryUsage[] = []
  for (const file of [...projectFiles].sort()) {
    const content = documents.get(file) ?? await fs.readFile(file)
    for (const include of sourceIncludes(content)) {
      const relativeTarget = normalize(`${file.slice(0, file.lastIndexOf('/'))}/${include.header}`)
      // Project-local headers can shadow installed library headers.
      if (projectFiles.has(relativeTarget) || projectFiles.has(`${SKETCH_ROOT}/src/${include.header}`)
        || projectFiles.has(`${SKETCH_ROOT}/include/${include.header}`)) continue
      if (targetFiles.has(relativeTarget) || (headers.has(normalize(include.header)) && !localHeaders.has(normalize(include.header)))) uses.push({ file, ...include })
    }
  }
  return uses
}
