import { open, readdir, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { insideLanguageRoot } from './languageServerEnvironment.js'

/** Read-only source access uses the same authenticated workspace session as LSP.
 * Canonical paths prevent a symlink under an include root from granting access
 * to unrelated files. No mutation operation is exposed. */
export async function readLanguageFile(method, params, roots) {
  if (!['aily/fs/stat', 'aily/fs/readFile', 'aily/fs/readDirectory'].includes(method)) throw new Error('Unsupported source operation')
  if (typeof params?.path !== 'string' || !path.isAbsolute(params.path)) throw new Error('Absolute source path required')
  const file = await realpath(params.path)
  if (!roots.some(root => insideLanguageRoot(root, file))) throw new Error('Source outside language environment')
  const info = await stat(file)
  if (method === 'aily/fs/stat') return { type: info.isDirectory() ? 2 : 1, size: info.size, ctime: info.ctimeMs, mtime: info.mtimeMs }
  if (method === 'aily/fs/readDirectory') return (await readdir(file, { withFileTypes: true })).filter(entry => !entry.isSymbolicLink()).map(entry => [entry.name, entry.isDirectory() ? 2 : 1])
  if (!info.isFile() || info.size > 4 * 1024 * 1024) throw new Error('Source is not a bounded regular file')
  const handle = await open(file, 'r')
  try {
    const current = await handle.stat()
    if (!current.isFile() || current.size > 4 * 1024 * 1024) throw new Error('Source is not a bounded regular file')
    return { base64: (await handle.readFile()).toString('base64') }
  } finally { await handle.close() }
}
