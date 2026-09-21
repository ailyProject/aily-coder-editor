import { lstat, readFile } from 'node:fs/promises'
import path from 'node:path'
import semver from 'semver'

/** Arduino uses named dependencies and boolean version constraints, not npm ranges. */
export function parseArduinoDependencies(value) {
  return String(value ?? '').split(',').map(part => part.trim()).filter(Boolean).map(raw => {
    const match = raw.match(/^([^()]+?)(?:\s*\((.*)\))?$/u)
    return match ? { name: match[1].trim(), constraint: (match[2] ?? '').trim() }
      : { name: raw, constraint: '', invalid: true }
  })
}

const normalizeVersion = value => semver.valid(/^\d+\.\d+$/u.test(value) ? `${value}.0` : value)

/** No eval, no guessed versions. null means the constraint could not be established. */
export function satisfiesArduinoVersion(version, constraint) {
  if (!constraint) return true
  const actual = normalizeVersion(version)
  if (!actual || constraint.length > 1024) return null
  const tokens = constraint.match(/>=|<=|!=|&&|\|\||[!()=<>]|\d+\.\d+(?:\.\d+)?(?:-[\w.-]+)?(?:\+[\w.-]+)?/gu) ?? []
  if (tokens.length > 256 || tokens.join('') !== constraint.replace(/\s/gu, '')) return null
  let index = 0
  const take = token => tokens[index] === token && (++index > 0)
  const atom = (depth = 0) => {
    if (depth > 32) throw new Error('Constraint nesting limit')
    if (take('!')) return !atom(depth + 1)
    if (take('(')) {
      const value = expression(depth + 1)
      if (!take(')')) throw new Error('Missing closing group')
      return value
    }
    const op = /^(>=|<=|!=|=|>|<)$/u.test(tokens[index] ?? '') ? tokens[index++] : '='
    const expected = normalizeVersion(tokens[index++] ?? '')
    if (!expected) throw new Error('Invalid version')
    return semver.cmp(actual, op, expected)
  }
  const conjunction = depth => {
    let result = atom(depth)
    while (take('&&')) { const right = atom(depth); result = result && right }
    return result
  }
  const expression = depth => {
    let result = conjunction(depth)
    while (take('||')) { const right = conjunction(depth); result = result || right }
    return result
  }
  try {
    const result = expression(0)
    return index === tokens.length ? result : null
  } catch { return null }
}

export async function readArduinoDependencyMetadata(root) {
  const file = path.join(root, 'library.properties')
  const info = await lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error })
  if (!info) return null // Legacy Arduino libraries need not have metadata.
  if (!info.isFile() || info.isSymbolicLink() || info.size > 65536) throw new Error(`Invalid library metadata: ${file}`)
  const text = (await readFile(file, 'utf8')).replace(/^\uFEFF/u, '').replace(/\\\r?\n/gu, '')
  const properties = Object.fromEntries(text.split(/\r?\n/u).filter(line => !line.trim().startsWith('#'))
    .map(line => line.match(/^\s*([^=]+?)\s*=(.*)$/u)).filter(Boolean)
    .map(match => [match[1].toLowerCase(), match[2].trim()]))
  return { root, name: properties.name ?? '', version: properties.version ?? '',
    dependencies: parseArduinoDependencies(properties.depends) }
}

/** Walk only the requested dependency graph; unrelated installed libraries cannot block an install. */
export function checkArduinoDependencies(requiredRoots, available) {
  const byRoot = new Map(available.filter(Boolean).map(item => [item.root, item]))
  const issues = [], visited = new Set()
  let unknown = false
  const visit = root => {
    if (visited.has(root)) return
    visited.add(root)
    const library = byRoot.get(root)
    if (!library) { unknown = true; return }
    for (const dependency of library.dependencies) {
      const candidates = [...byRoot.values()].filter(item => item.name.toLowerCase() === dependency.name.toLowerCase())
      const satisfied = candidates.filter(item => satisfiesArduinoVersion(item.version, dependency.constraint) === true)
      const reason = dependency.invalid ? 'invalid-declaration'
        : !candidates.length ? 'missing'
          : candidates.length > 1 ? 'ambiguous'
            : !satisfied.length ? (satisfiesArduinoVersion(candidates[0].version, dependency.constraint) === null
              ? 'unsupported-constraint' : 'version-mismatch') : null
      if (reason) issues.push({ requiredBy: library.name, source: path.join(root, 'library.properties'),
        ...dependency, reason, installedVersions: candidates.map(item => item.version),
        lookup: { query: dependency.name, source: 'registry' } })
      else visit(satisfied[0].root)
    }
  }
  requiredRoots.forEach(visit)
  return { dependencyStatus: issues.length ? 'incomplete' : unknown ? 'unknown' : 'verified',
    dependenciesReady: issues.length ? false : unknown ? null : true, dependencyIssues: issues }
}
