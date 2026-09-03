import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { URL } from 'node:url'

const CN_CODER_LIBRARY_INDEX_URL = 'https://blockly.yiyu.pro/libraries-coder-index.json'
const GLOBAL_CODER_LIBRARY_INDEX_URL = 'https://rs1.aily.pro/libraries-coder-index.json'
const CACHE_MAX_AGE_MS = 60 * 60 * 1000
const MAX_INDEX_BYTES = 32 * 1024 * 1024
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024
const versionCollator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' })
const memoryCache = new Map()
const pendingLoads = new Map()

function coderLibraryId(name) {
  return `coder:${createHash('sha256').update(name).digest('hex').slice(0, 24)}`
}

function normalizedStrings(value) {
  return Array.isArray(value)
    ? [...new Set(value.map(item => String(item ?? '').trim()).filter(Boolean))]
    : []
}

function normalizedDependencies(value) {
  if (!Array.isArray(value)) return []
  return value.flatMap(item => {
    const name = String(item?.name ?? '').trim()
    if (!name) return []
    const version = String(item?.version ?? '').trim()
    return [{ name, ...(version ? { version } : {}) }]
  })
}

function isAllowedNetworkUrl(value) {
  let parsed
  try {
    parsed = new URL(String(value ?? ''))
  } catch {
    return false
  }
  if (parsed.protocol === 'https:') return true
  return parsed.protocol === 'http:'
    && ['127.0.0.1', '::1', 'localhost'].includes(parsed.hostname.toLocaleLowerCase('en'))
}

function normalizeRelease(value) {
  const name = String(value?.name ?? '').trim()
  const version = String(value?.version ?? '').trim()
  const downloadUrl = String(value?.url ?? '').trim()
  const checksum = String(value?.checksum ?? '').trim()
  const archiveFileName = String(value?.archiveFileName ?? '').trim()
  const size = Number(value?.size)
  const safeArchiveFileName = archiveFileName.length <= 255
    && /^[A-Za-z0-9][A-Za-z0-9._+() -]*\.zip$/iu.test(archiveFileName)
    && path.basename(archiveFileName) === archiveFileName
    && path.win32.basename(archiveFileName) === archiveFileName
  if (
    !name
    || !version
    || !safeArchiveFileName
    || !isAllowedNetworkUrl(downloadUrl)
    || !/^SHA-256:[a-f0-9]{64}$/iu.test(checksum)
    || !Number.isSafeInteger(size)
    || size <= 0
    || size > MAX_ARCHIVE_BYTES
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
    dependencies: normalizedDependencies(value?.dependencies),
    providesIncludes: normalizedStrings(value?.providesIncludes),
    archiveFileName,
    downloadUrl,
    size,
    checksum,
  }
}

export function parseCoderLibraryIndex(payload, updatedAt = new Date().toISOString()) {
  const releases = Array.isArray(payload?.libraries) ? payload.libraries : null
  if (!releases) {
    throw new Error('Aily Coder library index is invalid')
  }

  const grouped = new Map()
  for (const rawRelease of releases) {
    const release = normalizeRelease(rawRelease)
    if (!release) continue
    let library = grouped.get(release.name)
    if (!library) {
      library = { id: coderLibraryId(release.name), name: release.name, releases: new Map() }
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
        release.repository,
        release.website,
        ...release.architectures,
        ...release.types,
        ...release.providesIncludes,
        ...release.dependencies.map(item => item.name),
      ].join('\n').normalize('NFKC').toLocaleLowerCase('en')).join('\n'),
    }
  }).filter(library => library.versions.length > 0).sort((left, right) => (
    left.name.localeCompare(right.name, 'en', { numeric: true, sensitivity: 'base' })
  ))
  if (libraries.length === 0) {
    throw new Error('Aily Coder library index contains no valid libraries')
  }

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

function resourceIndexUrl(resourceUrl) {
  const normalized = String(resourceUrl ?? '').trim().replace(/\/+$/u, '')
  const candidate = normalized ? `${normalized}/libraries-coder-index.json` : ''
  return isAllowedNetworkUrl(candidate) ? candidate : ''
}

export async function resolveCoderLibraryIndexUrl({
  cacheRoot,
  indexUrl,
  env = process.env,
} = {}) {
  const explicit = String(indexUrl ?? '').trim()
  if (explicit) {
    if (!isAllowedNetworkUrl(explicit)) throw new Error('Aily Coder library index URL is invalid')
    return explicit
  }

  const config = await readFile(path.join(String(cacheRoot ?? ''), 'config.json'), 'utf8')
    .then(value => JSON.parse(value))
    .catch(() => null)
  const region = String(config?.region ?? env.AILY_REGION ?? 'cn').trim().toLocaleLowerCase('en')
  const configured = resourceIndexUrl(config?.regions?.[region]?.resource)
  if (configured) return configured

  const inherited = String(env.AILY_CODER_LIBRARY_INDEX_URL ?? '').trim()
  if (inherited) {
    if (!isAllowedNetworkUrl(inherited)) throw new Error('Aily Coder library index URL is invalid')
    return inherited
  }
  return region === 'cn' ? CN_CODER_LIBRARY_INDEX_URL : GLOBAL_CODER_LIBRARY_INDEX_URL
}

function requestSignal(signal, timeoutMs) {
  const timeoutSignal = globalThis.AbortSignal.timeout(timeoutMs)
  return signal && typeof globalThis.AbortSignal.any === 'function'
    ? globalThis.AbortSignal.any([signal, timeoutSignal])
    : signal ?? timeoutSignal
}

async function readSourceCache(cacheRoot, indexUrl) {
  const cacheDirectory = path.join(cacheRoot, 'cache', 'coder-library-manager')
  const cacheFile = path.join(cacheDirectory, 'libraries-coder-index.json')
  const metaFile = path.join(cacheDirectory, 'libraries-coder-index.meta.json')
  const [cacheStat, meta] = await Promise.all([
    stat(cacheFile).catch(() => null),
    readFile(metaFile, 'utf8').then(value => JSON.parse(value)).catch(() => null),
  ])
  if (!cacheStat || meta?.indexUrl !== indexUrl) {
    return { cacheDirectory, cacheFile, metaFile, cacheStat: null, payload: null }
  }
  const payload = await readFile(cacheFile).catch(() => null)
  return { cacheDirectory, cacheFile, metaFile, cacheStat, payload }
}

async function fetchIndex(indexUrl, fetchImpl, signal) {
  const response = await fetchImpl(indexUrl, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'Aily-Coder-Library-Manager/1',
    },
    signal: requestSignal(signal, 120_000),
  })
  if (!response.ok) {
    throw new Error(`Aily Coder library index download failed (${response.status})`)
  }
  const contentLength = Number(response.headers.get('content-length') ?? 0)
  if (contentLength > MAX_INDEX_BYTES) {
    throw new Error('Aily Coder library index is unexpectedly large')
  }
  const payload = Buffer.from(await response.arrayBuffer())
  if (payload.byteLength === 0 || payload.byteLength > MAX_INDEX_BYTES) {
    throw new Error('Aily Coder library index download is invalid')
  }
  const updatedAt = response.headers.get('last-modified') || new Date().toISOString()
  const registry = parseCoderLibraryIndex(JSON.parse(payload.toString('utf8')), updatedAt)
  return { payload, registry }
}

async function writeSourceCache(cache, indexUrl, payload) {
  await mkdir(cache.cacheDirectory, { recursive: true })
  const suffix = `${process.pid}.${Date.now()}.tmp`
  const cacheTemp = `${cache.cacheFile}.${suffix}`
  const metaTemp = `${cache.metaFile}.${suffix}`
  try {
    await Promise.all([
      writeFile(cacheTemp, payload, { flag: 'wx' }),
      writeFile(metaTemp, JSON.stringify({ indexUrl }), { flag: 'wx' }),
    ])
    await rename(cacheTemp, cache.cacheFile)
    await rename(metaTemp, cache.metaFile)
  } finally {
    await Promise.all([
      rm(cacheTemp, { force: true }),
      rm(metaTemp, { force: true }),
    ])
  }
}

async function loadRegistryUncached({ cacheRoot, indexUrl, forceRefresh, fetchImpl, signal }) {
  const cache = await readSourceCache(cacheRoot, indexUrl)
  const cacheFresh = cache.cacheStat && Date.now() - cache.cacheStat.mtimeMs < CACHE_MAX_AGE_MS
  if (!forceRefresh && cacheFresh && cache.payload) {
    return {
      ...parseCoderLibraryIndex(
        JSON.parse(cache.payload.toString('utf8')),
        new Date(cache.cacheStat.mtimeMs).toISOString(),
      ),
      indexUrl,
      stale: false,
    }
  }

  try {
    const downloaded = await fetchIndex(indexUrl, fetchImpl, signal)
    await writeSourceCache(cache, indexUrl, downloaded.payload)
    return { ...downloaded.registry, indexUrl, stale: false }
  } catch (error) {
    if (!cache.payload || !cache.cacheStat) throw error
    return {
      ...parseCoderLibraryIndex(
        JSON.parse(cache.payload.toString('utf8')),
        new Date(cache.cacheStat.mtimeMs).toISOString(),
      ),
      indexUrl,
      stale: true,
    }
  }
}

export async function loadCoderLibraryRegistry({
  cacheRoot,
  indexUrl,
  forceRefresh = false,
  fetchImpl = globalThis.fetch,
  signal,
} = {}) {
  const resolvedRoot = path.resolve(String(cacheRoot ?? ''))
  const resolvedUrl = await resolveCoderLibraryIndexUrl({ cacheRoot: resolvedRoot, indexUrl })
  const key = `${resolvedRoot}\0${resolvedUrl}`
  if (!forceRefresh && memoryCache.has(key)) return memoryCache.get(key)
  if (!forceRefresh && pendingLoads.has(key)) return pendingLoads.get(key)
  const promise = loadRegistryUncached({
    cacheRoot: resolvedRoot,
    indexUrl: resolvedUrl,
    forceRefresh,
    fetchImpl,
    signal,
  }).then(registry => {
    memoryCache.set(key, registry)
    return registry
  }).finally(() => pendingLoads.delete(key))
  pendingLoads.set(key, promise)
  return promise
}

export function searchCoderLibraryRegistry(registry, {
  query = '',
  category = '',
  type = '',
  offset = 0,
  limit = 50,
} = {}) {
  const normalizedQuery = String(query ?? '').normalize('NFKC').trim().toLocaleLowerCase('en')
  const tokens = normalizedQuery.split(/[\s,，]+/u).filter(Boolean)
  const normalizedCategory = String(category ?? '').trim()
  const normalizedType = String(type ?? '').trim()
  const safeOffset = Math.max(0, Math.floor(Number(offset) || 0))
  const safeLimit = Math.max(1, Math.min(100, Math.floor(Number(limit) || 50)))
  const matched = registry.libraries.filter(library => {
    if (tokens.some(token => !library.searchText.includes(token))) return false
    if (normalizedCategory && !library.versions.some(item => item.category === normalizedCategory)) return false
    if (normalizedType && !library.versions.some(item => item.types.includes(normalizedType))) return false
    return true
  })
  if (normalizedQuery) {
    matched.sort((left, right) => {
      const rank = library => {
        const name = String(library.name ?? '').normalize('NFKC').toLocaleLowerCase('en')
        if (name === normalizedQuery) return 3
        if (name.startsWith(normalizedQuery)) return 2
        if (name.includes(normalizedQuery)) return 1
        return 0
      }
      return rank(right) - rank(left) || left.name.localeCompare(right.name)
    })
  }
  return {
    libraries: matched.slice(safeOffset, safeOffset + safeLimit),
    total: matched.length,
    offset: safeOffset,
    limit: safeLimit,
  }
}

export function findCoderLibraryRelease(registry, libraryId, version) {
  const library = registry.byId.get(String(libraryId ?? ''))
  if (!library) return null
  const requestedVersion = String(version ?? '').trim()
  const release = requestedVersion
    ? library.versions.find(item => item.version === requestedVersion)
    : library.versions[0]
  return release ? { library, release } : null
}

export async function downloadCoderLibraryArchive(release, targetFile, {
  fetchImpl = globalThis.fetch,
  signal,
} = {}) {
  if (!isAllowedNetworkUrl(release?.downloadUrl)) {
    throw new Error('Aily Coder library download URL is not trusted')
  }
  const response = await fetchImpl(release.downloadUrl, {
    headers: { 'User-Agent': 'Aily-Coder-Library-Manager/1' },
    signal: requestSignal(signal, 120_000),
  })
  if (!response.ok || !response.body) {
    throw new Error(`Aily Coder library download failed (${response.status})`)
  }

  const expectedSize = Number(release.size) || 0
  const contentLength = Number(response.headers.get('content-length') ?? 0)
  if (
    expectedSize <= 0
    || expectedSize > MAX_ARCHIVE_BYTES
    || contentLength > MAX_ARCHIVE_BYTES
    || (contentLength && contentLength !== expectedSize)
  ) {
    throw new Error('Aily Coder library archive size does not match the index')
  }

  const handle = await open(targetFile, 'wx')
  const hash = createHash('sha256')
  let received = 0
  try {
    for await (const chunk of response.body) {
      received += chunk.byteLength
      if (received > MAX_ARCHIVE_BYTES || received > expectedSize) {
        throw new Error('Aily Coder library archive size does not match the index')
      }
      hash.update(chunk)
      let offset = 0
      while (offset < chunk.byteLength) {
        const { bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset)
        offset += bytesWritten
      }
    }
  } finally {
    await handle.close()
  }
  if (received !== expectedSize) {
    throw new Error('Aily Coder library archive size does not match the index')
  }
  const expectedHash = release.checksum.replace(/^SHA-256:/iu, '').toLocaleLowerCase('en')
  if (hash.digest('hex') !== expectedHash) {
    throw new Error('Aily Coder library archive checksum does not match the index')
  }
}
