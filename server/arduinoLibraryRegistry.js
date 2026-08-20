import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { pipeline } from 'node:stream/promises'
import { URL } from 'node:url'
import { gunzip } from 'node:zlib'
import { promisify } from 'node:util'
import yauzl from 'yauzl'

const ARDUINO_LIBRARY_INDEX_URL = 'https://downloads.arduino.cc/libraries/library_index.json.gz'
const CACHE_MAX_AGE_MS = 60 * 60 * 1000
const MAX_INDEX_DOWNLOAD_BYTES = 32 * 1024 * 1024
const MAX_INDEX_JSON_BYTES = 256 * 1024 * 1024
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024
const MAX_ARCHIVE_ENTRIES = 20_000
const versionCollator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' })
const gunzipAsync = promisify(gunzip)
const memoryCache = new Map()
const pendingLoads = new Map()

function registryId(name) {
  return `arduino:${createHash('sha256').update(name).digest('hex').slice(0, 24)}`
}

function normalizedStrings(value) {
  return Array.isArray(value)
    ? [...new Set(value.map(item => String(item ?? '').trim()).filter(Boolean))]
    : []
}

function normalizeRelease(value) {
  const name = String(value?.name ?? '').trim()
  const version = String(value?.version ?? '').trim()
  const downloadUrl = String(value?.url ?? '').trim()
  const checksum = String(value?.checksum ?? '').trim()
  if (!name || !version || !downloadUrl || !/^SHA-256:[a-f0-9]{64}$/iu.test(checksum)) {
    return null
  }
  let parsedUrl
  try {
    parsedUrl = new URL(downloadUrl)
  } catch {
    return null
  }
  if (
    parsedUrl.protocol !== 'https:'
    || parsedUrl.hostname !== 'downloads.arduino.cc'
    || !parsedUrl.pathname.startsWith('/libraries/')
  ) {
    return null
  }
  return {
    name,
    version,
    author: String(value?.author ?? '').trim(),
    maintainer: String(value?.maintainer ?? '').trim(),
    sentence: String(value?.sentence ?? '').trim(),
    paragraph: String(value?.paragraph ?? '').trim(),
    website: String(value?.website ?? '').trim(),
    repository: String(value?.repository ?? '').trim(),
    category: String(value?.category ?? '').trim(),
    architectures: normalizedStrings(value?.architectures),
    types: normalizedStrings(value?.types),
    archiveFileName: String(value?.archiveFileName ?? '').trim(),
    downloadUrl,
    size: Number.isSafeInteger(Number(value?.size)) ? Number(value.size) : 0,
    checksum,
  }
}

export function parseArduinoLibraryIndex(payload, updatedAt = new Date().toISOString()) {
  const releases = Array.isArray(payload?.libraries) ? payload.libraries : null
  if (!releases) {
    throw new Error('Arduino Library Manager index is invalid')
  }

  const grouped = new Map()
  for (const rawRelease of releases) {
    const release = normalizeRelease(rawRelease)
    if (!release) continue
    let library = grouped.get(release.name)
    if (!library) {
      library = { id: registryId(release.name), name: release.name, releases: new Map() }
      grouped.set(release.name, library)
    }
    library.releases.set(release.version, release)
  }

  const libraries = [...grouped.values()].map(library => {
    const versions = [...library.releases.values()].sort((left, right) => (
      versionCollator.compare(right.version, left.version)
    ))
    return {
      id: library.id,
      name: library.name,
      versions,
      searchText: versions.map(release => [
        release.name,
        release.author,
        release.maintainer,
        release.sentence,
        release.paragraph,
        release.category,
        ...release.architectures,
        ...release.types,
      ].join('\n').toLocaleLowerCase('en')).join('\n'),
    }
  }).sort((left, right) => left.name.localeCompare(right.name, 'en', {
    numeric: true,
    sensitivity: 'base',
  }))

  const categories = new Set()
  const types = new Set()
  const byId = new Map()
  for (const library of libraries) {
    byId.set(library.id, library)
    for (const release of library.versions) {
      if (release.category) categories.add(release.category)
      for (const type of release.types) types.add(type)
    }
  }

  return {
    libraries,
    byId,
    categories: [...categories].sort((left, right) => left.localeCompare(right, 'en')),
    types: [...types].sort((left, right) => left.localeCompare(right, 'en')),
    updatedAt,
  }
}

async function downloadIndex(cacheFile) {
  const response = await globalThis.fetch(ARDUINO_LIBRARY_INDEX_URL, {
    headers: { 'User-Agent': 'Aily-Coder-Arduino-Library-Manager/1' },
    signal: globalThis.AbortSignal.timeout(120_000),
  })
  if (!response.ok) {
    throw new Error(`Arduino Library Manager index download failed (${response.status})`)
  }
  const contentLength = Number(response.headers.get('content-length') ?? 0)
  if (contentLength > MAX_INDEX_DOWNLOAD_BYTES) {
    throw new Error('Arduino Library Manager index is unexpectedly large')
  }
  const compressed = Buffer.from(await response.arrayBuffer())
  if (
    compressed.byteLength === 0
    || compressed.byteLength > MAX_INDEX_DOWNLOAD_BYTES
    || compressed[0] !== 0x1f
    || compressed[1] !== 0x8b
  ) {
    throw new Error('Arduino Library Manager index download is invalid')
  }
  const temporary = `${cacheFile}.${process.pid}.${Date.now()}.tmp`
  try {
    await writeFile(temporary, compressed, { flag: 'wx' })
    await rename(temporary, cacheFile)
  } finally {
    await rm(temporary, { force: true })
  }
  return compressed
}

async function parseCompressedIndex(compressed, updatedAt) {
  const json = await gunzipAsync(compressed, { maxOutputLength: MAX_INDEX_JSON_BYTES })
  return parseArduinoLibraryIndex(JSON.parse(json.toString('utf8')), updatedAt)
}

async function loadRegistryUncached(cacheRoot, forceRefresh) {
  const cacheDirectory = path.join(cacheRoot, 'cache', 'arduino-library-manager')
  const cacheFile = path.join(cacheDirectory, 'library_index.json.gz')
  await mkdir(cacheDirectory, { recursive: true })

  const cachedStat = await stat(cacheFile).catch(() => null)
  let compressed
  let downloaded = false
  if (!forceRefresh && cachedStat && Date.now() - cachedStat.mtimeMs < CACHE_MAX_AGE_MS) {
    compressed = await readFile(cacheFile)
  } else {
    try {
      compressed = await downloadIndex(cacheFile)
      downloaded = true
    } catch (error) {
      if (!cachedStat) throw error
      compressed = await readFile(cacheFile)
    }
  }

  const fileStat = await stat(cacheFile).catch(() => cachedStat)
  const updatedAt = new Date(fileStat?.mtimeMs || Date.now()).toISOString()
  const registry = await parseCompressedIndex(compressed, updatedAt)
  return {
    ...registry,
    stale: !downloaded && Boolean(cachedStat && Date.now() - cachedStat.mtimeMs >= CACHE_MAX_AGE_MS),
  }
}

export async function loadArduinoLibraryRegistry({ cacheRoot, forceRefresh = false }) {
  const key = path.resolve(cacheRoot)
  if (!forceRefresh && memoryCache.has(key)) {
    return memoryCache.get(key)
  }
  if (!forceRefresh && pendingLoads.has(key)) {
    return pendingLoads.get(key)
  }
  const promise = loadRegistryUncached(key, forceRefresh)
    .then(registry => {
      memoryCache.set(key, registry)
      return registry
    })
    .finally(() => pendingLoads.delete(key))
  pendingLoads.set(key, promise)
  return promise
}

export function searchArduinoLibraryRegistry(registry, {
  query = '',
  category = '',
  type = '',
  offset = 0,
  limit = 50,
} = {}) {
  const normalizedQuery = String(query ?? '').trim().toLocaleLowerCase('en')
  const normalizedCategory = String(category ?? '').trim()
  const normalizedType = String(type ?? '').trim()
  const safeOffset = Math.max(0, Math.floor(Number(offset) || 0))
  const safeLimit = Math.max(1, Math.min(100, Math.floor(Number(limit) || 50)))
  const matched = registry.libraries.filter(library => {
    if (normalizedQuery && !library.searchText.includes(normalizedQuery)) return false
    if (normalizedCategory && !library.versions.some(item => item.category === normalizedCategory)) return false
    if (normalizedType && !library.versions.some(item => item.types.includes(normalizedType))) return false
    return true
  })
  return {
    libraries: matched.slice(safeOffset, safeOffset + safeLimit),
    total: matched.length,
    offset: safeOffset,
    limit: safeLimit,
  }
}

export function findArduinoLibraryRelease(registry, libraryId, version) {
  const library = registry.byId.get(String(libraryId ?? ''))
  if (!library) return null
  const release = library.versions.find(item => item.version === String(version ?? ''))
  return release ? { library, release } : null
}

export async function downloadArduinoLibraryArchive(release, targetFile) {
  const parsedUrl = new URL(release.downloadUrl)
  if (
    parsedUrl.protocol !== 'https:'
    || parsedUrl.hostname !== 'downloads.arduino.cc'
    || !parsedUrl.pathname.startsWith('/libraries/')
  ) {
    throw new Error('Arduino library download URL is not trusted')
  }
  const response = await globalThis.fetch(parsedUrl, {
    headers: { 'User-Agent': 'Aily-Coder-Arduino-Library-Manager/1' },
    signal: globalThis.AbortSignal.timeout(120_000),
  })
  if (!response.ok || !response.body) {
    throw new Error(`Arduino library download failed (${response.status})`)
  }

  const expectedSize = Number(release.size) || 0
  if (expectedSize > MAX_ARCHIVE_BYTES) {
    throw new Error('Arduino library archive is too large')
  }
  const handle = await open(targetFile, 'wx')
  const hash = createHash('sha256')
  let received = 0
  try {
    for await (const chunk of response.body) {
      received += chunk.byteLength
      if (received > MAX_ARCHIVE_BYTES || (expectedSize && received > expectedSize)) {
        throw new Error('Arduino library archive size does not match the registry')
      }
      hash.update(chunk)
      let offset = 0
      while (offset < chunk.byteLength) {
        const { bytesWritten } = await handle.write(
          chunk,
          offset,
          chunk.byteLength - offset,
        )
        offset += bytesWritten
      }
    }
  } finally {
    await handle.close()
  }
  if (expectedSize && received !== expectedSize) {
    throw new Error('Arduino library archive size does not match the registry')
  }
  const expectedHash = release.checksum.replace(/^SHA-256:/iu, '').toLowerCase()
  if (hash.digest('hex') !== expectedHash) {
    throw new Error('Arduino library archive checksum does not match the registry')
  }
}

function isUnsafeArchivePath(fileName) {
  if (!fileName || fileName.includes('\\') || fileName.includes('\0')) return true
  if (fileName.startsWith('/') || /^[A-Za-z]:/u.test(fileName)) return true
  const parts = fileName.split('/').filter(Boolean)
  return parts.some(part => part === '.' || part === '..')
}

async function openZip(zipPath) {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, {
      autoClose: false,
      decodeStrings: true,
      lazyEntries: true,
      strictFileNames: true,
      validateEntrySizes: true,
    }, (error, zipFile) => error ? reject(error) : resolve(zipFile))
  })
}

async function openZipEntry(zipFile, entry) {
  return new Promise((resolve, reject) => {
    zipFile.openReadStream(entry, (error, stream) => error ? reject(error) : resolve(stream))
  })
}

export async function extractArduinoLibraryArchive(zipPath, destination) {
  await mkdir(destination, { recursive: false })
  const zipFile = await openZip(zipPath)
  let entryCount = 0
  let totalSize = 0
  try {
    await new Promise((resolve, reject) => {
      const fail = error => reject(error)
      zipFile.on('error', fail)
      zipFile.on('end', resolve)
      zipFile.on('entry', entry => {
        void (async () => {
          entryCount += 1
          totalSize += entry.uncompressedSize
          if (
            entryCount > MAX_ARCHIVE_ENTRIES
            || totalSize > MAX_ARCHIVE_BYTES
            || isUnsafeArchivePath(entry.fileName)
          ) {
            throw new Error('Arduino library archive contains unsafe entries')
          }
          const unixMode = (entry.externalFileAttributes >>> 16) & 0o170000
          if (unixMode === 0o120000) {
            throw new Error('Symbolic links are not allowed in Arduino libraries')
          }
          const outputPath = path.resolve(destination, ...entry.fileName.split('/').filter(Boolean))
          const relative = path.relative(destination, outputPath)
          if (relative.startsWith('..') || path.isAbsolute(relative)) {
            throw new Error('Arduino library archive entry escapes the destination')
          }
          if (entry.fileName.endsWith('/')) {
            await mkdir(outputPath, { recursive: true })
          } else {
            await mkdir(path.dirname(outputPath), { recursive: true })
            const input = await openZipEntry(zipFile, entry)
            await pipeline(input, createWriteStream(outputPath, { flags: 'wx' }))
          }
          zipFile.readEntry()
        })().catch(fail)
      })
      zipFile.readEntry()
    })
  } finally {
    zipFile.close()
  }
}

export async function findExtractedArduinoLibraryRoot(destination) {
  const directProperties = path.join(destination, 'library.properties')
  if ((await lstat(directProperties).catch(() => null))?.isFile()) {
    return destination
  }
  const candidates = []
  for (const entry of await readdir(destination, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue
    const candidate = path.join(destination, entry.name)
    const properties = await lstat(path.join(candidate, 'library.properties')).catch(() => null)
    if (properties?.isFile() && !properties.isSymbolicLink()) candidates.push(candidate)
  }
  if (candidates.length !== 1) {
    throw new Error('Arduino library archive does not contain one library root')
  }
  return candidates[0]
}
