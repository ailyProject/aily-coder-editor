import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { resolveCoderLibraryIndexUrl } from './coderLibraryRegistry.js'

export const CODER_LIBRARY_PACKAGE = /^@aily-project-coder\/lib-[A-Za-z0-9][A-Za-z0-9._-]*$/u
const MAX_INDEX_BYTES = 32 * 1024 * 1024

function parseCatalog(payload) {
  if (!Array.isArray(payload?.libraries)) throw new Error('Invalid Coder npm library catalog')
  const libraries = payload.libraries.filter(item => CODER_LIBRARY_PACKAGE.test(item?.name)
    && /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?$/u.test(item?.version))
  if (payload.libraries.length && !libraries.length) throw new Error('Coder catalog contains no valid npm libraries')
  return libraries
}

/** Cache each regional source separately; never serve another region's catalog. */
export async function loadCoderPackageCatalog(cacheRoot, { indexUrl, forceRefresh, fetchImpl = globalThis.fetch, signal } = {}) {
  const url = await resolveCoderLibraryIndexUrl({ cacheRoot, indexUrl })
  const key = createHash('sha256').update(url).digest('hex')
  const directory = path.join(cacheRoot, 'cache', 'coder-package-libraries')
  const file = path.join(directory, `${key}.json`)
  const cached = await readFile(file, 'utf8').then(JSON.parse).then(parseCatalog).catch(() => null)
  const info = cached && await stat(file).catch(() => null)
  if (!forceRefresh && info && Date.now() - info.mtimeMs < 60 * 60 * 1000) {
    return { libraries: cached, indexUrl: url, stale: false }
  }
  try {
    const response = await fetchImpl(url, {
      signal: globalThis.AbortSignal.any([signal, globalThis.AbortSignal.timeout(30_000)].filter(Boolean)),
    })
    if (!response.ok) throw new Error(`Coder npm library catalog download failed (${response.status})`)
    if (Number(response.headers.get('content-length')) > MAX_INDEX_BYTES) throw new Error('Coder catalog is too large')
    const body = await response.text()
    if (Buffer.byteLength(body) > MAX_INDEX_BYTES) throw new Error('Coder catalog is too large')
    const libraries = parseCatalog(JSON.parse(body))
    await mkdir(directory, { recursive: true })
    const temporary = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
    try {
      await writeFile(temporary, JSON.stringify({ libraries }), { flag: 'wx' })
      await rename(temporary, file)
    } finally {
      await rm(temporary, { force: true })
    }
    return { libraries, indexUrl: url, stale: false }
  } catch (error) {
    signal?.throwIfAborted()
    if (cached) return { libraries: cached, indexUrl: url, stale: true }
    throw error
  }
}
