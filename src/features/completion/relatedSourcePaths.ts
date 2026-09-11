const SCRIPT_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte'] as const

function directory(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  const index = normalized.lastIndexOf('/')
  return index <= 0 ? '/' : normalized.slice(0, index)
}

function resolvePath(base: string, relative: string): string | undefined {
  if (!relative || relative.includes('\0') || relative.startsWith('/') || /^[A-Za-z]:[\\/]/.test(relative)) return undefined
  const parts = `${base}/${relative.replace(/\\/g, '/')}`.split('/')
  const resolved: string[] = []
  for (const part of parts) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (!resolved.length) return undefined
      resolved.pop()
    } else resolved.push(part)
  }
  return `/${resolved.join('/')}`
}

function addModuleCandidates(targets: Set<string>, base: string, extensions: readonly string[]): void {
  if (/\.[A-Za-z0-9]+$/.test(base)) {
    targets.add(base)
    return
  }
  for (const extension of extensions) targets.add(base + extension)
  for (const extension of extensions) targets.add(`${base}/index${extension}`)
}

/** Infer only explicit local source relationships. Workspace ownership is checked later. */
export function relatedSourcePaths(sourcePath: string, text: string): string[] {
  const targets = new Set<string>()
  const sourceDirectory = directory(sourcePath)

  for (const match of text.matchAll(/^\s*#\s*include\s*"([^"\r\n]+)"/gm)) {
    const resolved = resolvePath(sourceDirectory, match[1]!)
    if (resolved) targets.add(resolved)
  }

  const scriptImports = /(?:\bfrom\s*|\b(?:import|require)\s*\(\s*|\bimport\s*)['"](\.[^'"\r\n]+)['"]/g
  for (const match of text.matchAll(scriptImports)) {
    const resolved = resolvePath(sourceDirectory, match[1]!)
    if (resolved) addModuleCandidates(targets, resolved, SCRIPT_EXTENSIONS)
  }

  for (const match of text.matchAll(/^\s*from\s+(\.+)([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)?\s+import\s+([A-Za-z_]\w*)/gm)) {
    let base = sourceDirectory
    for (let level = 1; level < match[1]!.length; level++) base = directory(base)
    const module = match[2]?.replace(/\./g, '/') || match[3]!
    const resolved = resolvePath(base, module)
    if (resolved) addModuleCandidates(targets, resolved, ['.py'])
  }

  return [...targets].slice(0, 64)
}
