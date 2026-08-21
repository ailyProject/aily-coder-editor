import { constants as fsConstants } from 'node:fs'
import {
  access,
  copyFile,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import {
  downloadArduinoLibraryArchive,
  extractArduinoLibraryArchive,
  findArduinoLibraryRelease,
  findExtractedArduinoLibraryRoot,
  loadArduinoLibraryRegistry,
  searchArduinoLibraryRegistry,
} from './arduinoLibraryRegistry.js'

const SAFE_LIBRARY_DIRECTORY = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u
const COMPONENT_LIBRARY_RECEIPT = '.aily-component-library.json'

export class ComponentLibraryError extends Error {
  constructor(code, message, details) {
    super(message)
    this.name = 'ComponentLibraryError'
    this.code = code
    this.details = details
  }
}

export function defaultAilyAppDataPath() {
  if (process.env.AILY_APPDATA_PATH) {
    return path.resolve(process.env.AILY_APPDATA_PATH)
  }
  if (process.platform === 'win32') {
    return path.join(os.homedir(), 'AppData', 'Local', 'aily-project')
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'aily-project')
  }
  return path.join(os.homedir(), '.config', 'aily-project')
}

export function isSafeComponentLibraryDirectoryName(value) {
  return SAFE_LIBRARY_DIRECTORY.test(String(value ?? ''))
}

export function parseArduinoLibraryProperties(content) {
  const values = new Map()
  let pending = ''

  for (const rawLine of String(content ?? '').replace(/^\uFEFF/u, '').split(/\r?\n/u)) {
    const line = pending + rawLine
    if (line.endsWith('\\')) {
      pending = line.slice(0, -1)
      continue
    }
    pending = ''
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) {
      continue
    }
    const separator = trimmed.indexOf('=')
    if (separator <= 0) {
      continue
    }
    values.set(
      trimmed.slice(0, separator).trim().toLowerCase(),
      trimmed.slice(separator + 1).trim(),
    )
  }

  const get = key => values.get(key) ?? ''
  return {
    name: get('name'),
    version: get('version'),
    author: get('author'),
    maintainer: get('maintainer'),
    sentence: get('sentence'),
    paragraph: get('paragraph'),
    category: get('category'),
    url: get('url'),
    architectures: get('architectures')
      .split(',')
      .map(value => value.trim())
      .filter(Boolean),
  }
}

function isPathInside(root, candidate) {
  const relative = path.relative(root, candidate)
  if (relative === '') return true
  return !relative.startsWith('..') && !path.isAbsolute(relative)
}

async function existingRealDirectory(candidate, label) {
  const resolved = await realpath(path.resolve(String(candidate ?? ''))).catch(() => '')
  if (!resolved) {
    throw new Error(`${label} does not exist`)
  }
  const stat = await lstat(resolved)
  if (!stat.isDirectory()) {
    throw new Error(`${label} is not a directory`)
  }
  return resolved
}

async function pathExists(candidate) {
  try {
    await access(candidate, fsConstants.F_OK)
    return true
  } catch {
    return false
  }
}

async function resolveWorkspaceRoot(workspaceRoot) {
  const root = await existingRealDirectory(workspaceRoot, 'Workspace root')
  const projectConfig = path.join(root, 'project.aci')
  const configStat = await lstat(projectConfig).catch(() => null)
  if (!configStat?.isFile()) {
    throw new ComponentLibraryError(
      'CODER_PROJECT_REQUIRED',
      'Workspace root is not an Aily Coder project',
    )
  }
  return root
}

async function resolveAppDataRoot(appDataPath) {
  return existingRealDirectory(
    String(appDataPath ?? '').trim() || defaultAilyAppDataPath(),
    'Aily app data root',
  )
}

function isSafeAilyPackageName(value, prefix) {
  return new RegExp(`^@aily-project/${prefix}[A-Za-z0-9_.-]+$`, 'u').test(String(value ?? ''))
}

function normalizeDeclaredVersion(value) {
  const raw = String(value ?? '').trim().replace(/^[\^~>=\s]+/u, '')
  const match = raw.match(/\d+(?:\.\d+){0,2}(?:-[A-Za-z0-9.-]+)?/u)
  return match?.[0] ?? raw
}

function packagePath(root, packageName) {
  return path.join(root, 'node_modules', ...packageName.split('/'))
}

async function readJson(filePath, label) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'))
  } catch {
    throw new Error(`${label} is missing or invalid`)
  }
}

async function resolvePlatformPackageName(projectRoot) {
  const project = await readJson(path.join(projectRoot, 'project.aci'), 'project.aci')
  const configured = String(project?.target?.platform ?? '').trim()
  if (isSafeAilyPackageName(configured, 'platform-')) {
    return configured
  }

  const boardPackage = String(project?.target?.boardPackage ?? '').trim()
  if (!isSafeAilyPackageName(boardPackage, 'board-')
    && !isSafeAilyPackageName(boardPackage, 'coder-')) {
    throw new Error('project.aci does not declare a valid board package or platform')
  }
  const boardManifest = await readJson(
    path.join(packagePath(projectRoot, boardPackage), 'package.json'),
    'Board package',
  )
  const framework = String(project?.target?.framework ?? '').trim()
  const boardId = String(project?.target?.board ?? '').trim()
  const supported = Array.isArray(boardManifest?.aily?.supportedPlatforms)
    ? boardManifest.aily.supportedPlatforms
    : []
  const selected = supported.find(item => (
    (!framework || String(item?.framework ?? framework) === framework)
    && (!boardId || String(item?.boardId ?? '') === boardId)
  )) ?? supported[0]
  const fallback = String(selected?.platform ?? '').trim()
  if (!isSafeAilyPackageName(fallback, 'platform-')) {
    throw new Error('Board package does not declare a valid platform')
  }
  return fallback
}

async function resolveSdkDirectory(appDataRoot, packageName, version) {
  const sdkBase = path.join(appDataRoot, 'sdk')
  const shortName = packageName.replace(/^@aily-project\/sdk-/u, '')
  const normalizedVersion = normalizeDeclaredVersion(version)
  const canonical = path.join(sdkBase, `${shortName}_${normalizedVersion}`)
  const canonicalStat = await lstat(canonical).catch(() => null)
  if (canonicalStat?.isDirectory()) {
    return canonical
  }

  const entries = await readdir(sdkBase, { withFileTypes: true }).catch(() => [])
  const prefix = `${shortName}_`
  const candidates = entries
    .filter(entry => entry.isDirectory() && entry.name.startsWith(prefix))
    .map(entry => ({
      name: entry.name,
      version: entry.name.slice(prefix.length),
    }))
    .filter(entry => (
      entry.version === normalizedVersion
      || entry.version.startsWith(`${normalizedVersion}-`)
      || normalizeDeclaredVersion(entry.version) === normalizedVersion
    ))
    .sort((left, right) => right.name.localeCompare(left.name))
  return candidates[0] ? path.join(sdkBase, candidates[0].name) : null
}

async function resolveSdkRoots(projectRoot, appDataRoot) {
  const platformPackageName = await resolvePlatformPackageName(projectRoot)
  const platformManifest = await readJson(
    path.join(packagePath(appDataRoot, platformPackageName), 'platform.json'),
    'Coder platform manifest',
  )
  const runtimeDependencies = Array.isArray(platformManifest?.runtimeDependencies)
    ? platformManifest.runtimeDependencies
    : []
  const sdkRoots = []
  for (const item of runtimeDependencies) {
    const packageName = String(item?.package ?? '').trim()
    const version = normalizeDeclaredVersion(item?.version)
    if (
      (String(item?.role ?? '') !== 'sdk' && !packageName.startsWith('@aily-project/sdk-'))
      || !isSafeAilyPackageName(packageName, 'sdk-')
      || !version
    ) {
      continue
    }
    const resolved = await resolveSdkDirectory(appDataRoot, packageName, version)
    const sdkRoot = resolved ? await realpath(resolved).catch(() => '') : ''
    if (!sdkRoot || !isPathInside(appDataRoot, sdkRoot)) {
      continue
    }
    const stat = await lstat(sdkRoot).catch(() => null)
    if (!stat?.isDirectory()) {
      continue
    }
    sdkRoots.push({
      packageName,
      label: `${packageName.replace(/^@aily-project\//u, '')}@${version}`,
      sdkRoot,
    })
  }
  if (sdkRoots.length === 0) {
    throw new Error('The active Coder platform SDK is not installed')
  }
  return sdkRoots
}

async function listSdkLibraries(sdk, componentsRoot) {
  const librariesRoot = path.join(sdk.sdkRoot, 'libraries')
  const librariesRootStat = await lstat(librariesRoot).catch(() => null)
  if (!librariesRootStat?.isDirectory()) {
    return []
  }

  const entries = await readdir(librariesRoot, { withFileTypes: true })
  const libraries = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !isSafeComponentLibraryDirectoryName(entry.name)) {
      continue
    }
    const sourcePath = path.join(librariesRoot, entry.name)
    const sourceStat = await lstat(sourcePath).catch(() => null)
    if (!sourceStat?.isDirectory() || sourceStat.isSymbolicLink()) {
      continue
    }
    const propertiesPath = path.join(sourcePath, 'library.properties')
    const propertiesStat = await lstat(propertiesPath).catch(() => null)
    if (!propertiesStat?.isFile() || propertiesStat.isSymbolicLink()) {
      continue
    }
    const properties = parseArduinoLibraryProperties(await readFile(propertiesPath, 'utf8'))
    libraries.push({
      ...properties,
      id: `${sdk.packageName}:${entry.name}`,
      folderName: entry.name,
      sourcePath,
      sdkLabel: sdk.label,
      source: 'platform',
      versions: [properties.version].filter(Boolean),
      installed: await pathExists(path.join(componentsRoot, entry.name)),
    })
  }
  return libraries
}

async function listInstalledComponentLibraries(componentsRoot) {
  const installed = new Map()
  for (const entry of await readdir(componentsRoot, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() || !isSafeComponentLibraryDirectoryName(entry.name)) continue
    const propertiesPath = path.join(componentsRoot, entry.name, 'library.properties')
    const propertiesStat = await lstat(propertiesPath).catch(() => null)
    if (!propertiesStat?.isFile() || propertiesStat.isSymbolicLink()) continue
    const properties = parseArduinoLibraryProperties(await readFile(propertiesPath, 'utf8'))
    if (!properties.name) continue
    const receipt = await readFile(
      path.join(componentsRoot, entry.name, COMPONENT_LIBRARY_RECEIPT),
      'utf8',
    ).then(value => JSON.parse(value)).catch(() => null)
    installed.set(properties.name.toLocaleLowerCase('en'), {
      folderName: entry.name,
      version: properties.version,
      receipt,
    })
  }
  return installed
}

function activeArduinoArchitectures(sdkRoots) {
  const architectures = new Set()
  for (const sdk of sdkRoots) {
    const shortName = sdk.packageName.replace(/^@aily-project\/sdk-/u, '')
    architectures.add(shortName)
    const lastSegment = shortName.split('-').at(-1)
    if (lastSegment) architectures.add(lastSegment)
  }
  return architectures
}

function releaseIsCompatible(release, activeArchitectures) {
  return release.architectures.length === 0
    || release.architectures.includes('*')
    || release.architectures.some(item => activeArchitectures.has(item.toLocaleLowerCase('en')))
}

function toRegistryClientLibrary(library, installed, activeArchitectures, selectedVersion) {
  const selected = library.versions.find(item => item.version === selectedVersion) ?? library.versions[0]
  const managed = Boolean(
    installed?.receipt
    && installed.receipt.source === 'arduino-library-manager'
    && installed.receipt.libraryId === library.id
    && installed.receipt.name === selected.name
    && installed.receipt.version === installed.version,
  )
  return {
    id: library.id,
    source: 'registry',
    folderName: installed?.folderName ?? '',
    sdkLabel: 'Arduino Library Manager',
    name: selected.name,
    version: selected.version,
    versions: library.versions.map(item => item.version),
    author: selected.author,
    maintainer: selected.maintainer,
    sentence: selected.sentence,
    paragraph: selected.paragraph,
    category: selected.category,
    url: selected.website || selected.repository,
    architectures: selected.architectures,
    types: selected.types,
    compatible: releaseIsCompatible(selected, activeArchitectures),
    installed: Boolean(installed),
    installedVersion: installed?.version ?? '',
    managed,
  }
}

export async function searchArduinoComponentLibraries({
  workspaceRoot,
  appDataPath,
  query,
  category,
  type,
  offset,
  limit,
  forceRefresh = false,
}) {
  const projectRoot = await resolveWorkspaceRoot(workspaceRoot)
  const appDataRoot = await resolveAppDataRoot(appDataPath)
  const componentsRoot = path.join(projectRoot, 'sketch', 'libraries')
  const [registry, installed, sdkRoots] = await Promise.all([
    loadArduinoLibraryRegistry({ cacheRoot: appDataRoot, forceRefresh }),
    listInstalledComponentLibraries(componentsRoot),
    resolveSdkRoots(projectRoot, appDataRoot).catch(() => []),
  ])
  const activeArchitectures = activeArduinoArchitectures(sdkRoots)
  const result = searchArduinoLibraryRegistry(registry, {
    query,
    category,
    type,
    offset,
    limit,
  })
  return {
    ...result,
    libraries: result.libraries.map(library => toRegistryClientLibrary(
      library,
      installed.get(library.name.toLocaleLowerCase('en')),
      activeArchitectures,
    )),
    categories: registry.categories,
    types: registry.types,
    updatedAt: registry.updatedAt,
    stale: registry.stale,
  }
}

export async function scanComponentLibraries({
  workspaceRoot,
  appDataPath,
}) {
  const projectRoot = await resolveWorkspaceRoot(workspaceRoot)
  const appDataRoot = await resolveAppDataRoot(appDataPath)
  const sdkRoots = await resolveSdkRoots(projectRoot, appDataRoot)
  const componentsRoot = path.join(projectRoot, 'sketch', 'libraries')
  const found = new Map()

  for (const sdk of sdkRoots) {
    for (const library of await listSdkLibraries(sdk, componentsRoot)) {
      if (!found.has(library.id)) {
        found.set(library.id, library)
      }
    }
  }

  return [...found.values()].sort((left, right) => (
    Number(right.installed) - Number(left.installed)
    || (left.name || left.folderName).localeCompare(right.name || right.folderName)
  ))
}

async function copyDirectoryWithoutLinks(source, target) {
  const sourceStat = await lstat(source)
  if (sourceStat.isSymbolicLink()) {
    throw new Error('Symbolic links are not allowed in platform component libraries')
  }
  if (!sourceStat.isDirectory()) {
    throw new Error('Component library source is not a directory')
  }

  await mkdir(target, { recursive: false })
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const sourceEntry = path.join(source, entry.name)
    const targetEntry = path.join(target, entry.name)
    const entryStat = await lstat(sourceEntry)
    if (entryStat.isSymbolicLink()) {
      throw new Error(`Symbolic link is not allowed: ${entry.name}`)
    }
    if (entryStat.isDirectory()) {
      await copyDirectoryWithoutLinks(sourceEntry, targetEntry)
    } else if (entryStat.isFile()) {
      await copyFile(sourceEntry, targetEntry)
    } else {
      throw new Error(`Unsupported library entry: ${entry.name}`)
    }
  }
}

export async function installComponentLibrary({
  workspaceRoot,
  appDataPath,
  libraryId,
}) {
  const projectRoot = await resolveWorkspaceRoot(workspaceRoot)
  const libraries = await scanComponentLibraries({
    workspaceRoot: projectRoot,
    appDataPath,
  })
  const library = libraries.find(item => item.id === String(libraryId ?? ''))
  if (!library) {
    throw new Error('Platform component library was not found')
  }
  if (!isSafeComponentLibraryDirectoryName(library.folderName)) {
    throw new Error('Invalid component library directory name')
  }

  const componentsRoot = path.join(projectRoot, 'sketch', 'libraries')
  const targetPath = path.join(componentsRoot, library.folderName)
  await mkdir(componentsRoot, { recursive: true })
  if (await pathExists(targetPath)) {
    return { ...library, installed: true, alreadyInstalled: true }
  }

  const stagingPath = path.join(
    componentsRoot,
    `.${library.folderName}.aily-install-${process.pid}-${Date.now()}`,
  )
  try {
    await copyDirectoryWithoutLinks(library.sourcePath, stagingPath)
    if (await pathExists(targetPath)) {
      return { ...library, installed: true, alreadyInstalled: true }
    }
    await rename(stagingPath, targetPath)
    return { ...library, installed: true, alreadyInstalled: false }
  } finally {
    await rm(stagingPath, { recursive: true, force: true })
  }
}

function canonicalRegistryFolderName(release, libraryRoot, extractionRoot) {
  const extractedName = libraryRoot === extractionRoot ? '' : path.basename(libraryRoot)
  const suffix = `-${release.version}`
  const withoutVersion = extractedName.endsWith(suffix)
    ? extractedName.slice(0, -suffix.length)
    : extractedName
  if (isSafeComponentLibraryDirectoryName(withoutVersion)) return withoutVersion

  const archiveBase = release.archiveFileName.replace(/\.zip$/iu, '')
  const archiveWithoutVersion = archiveBase.endsWith(suffix)
    ? archiveBase.slice(0, -suffix.length)
    : archiveBase
  if (isSafeComponentLibraryDirectoryName(archiveWithoutVersion)) return archiveWithoutVersion

  const derived = release.name
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9_.-]+/gu, '_')
    .replace(/^[^A-Za-z0-9]+/u, '')
    .slice(0, 128)
  if (!isSafeComponentLibraryDirectoryName(derived)) {
    throw new Error('Arduino library does not have a safe component directory name')
  }
  return derived
}

export async function installArduinoComponentLibrary({
  workspaceRoot,
  appDataPath,
  libraryId,
  version,
}) {
  const projectRoot = await resolveWorkspaceRoot(workspaceRoot)
  const appDataRoot = await resolveAppDataRoot(appDataPath)
  const registry = await loadArduinoLibraryRegistry({ cacheRoot: appDataRoot })
  const match = findArduinoLibraryRelease(registry, libraryId, version)
  if (!match) {
    throw new ComponentLibraryError(
      'ARDUINO_LIBRARY_NOT_FOUND',
      'Arduino Library Manager version was not found',
    )
  }

  const sdkRoots = await resolveSdkRoots(projectRoot, appDataRoot)
  if (!releaseIsCompatible(match.release, activeArduinoArchitectures(sdkRoots))) {
    throw new ComponentLibraryError(
      'ARDUINO_LIBRARY_INCOMPATIBLE',
      `${match.library.name} ${match.release.version} is not compatible with the active Coder architecture`,
      { architectures: match.release.architectures },
    )
  }

  const componentsRoot = path.join(projectRoot, 'sketch', 'libraries')
  await mkdir(componentsRoot, { recursive: true })
  const temporaryRoot = await mkdtemp(path.join(componentsRoot, '.aily-arduino-install-'))
  const archivePath = path.join(temporaryRoot, 'library.zip')
  const extractionRoot = path.join(temporaryRoot, 'extracted')
  try {
    await downloadArduinoLibraryArchive(match.release, archivePath)
    await extractArduinoLibraryArchive(archivePath, extractionRoot)
    const libraryRoot = await findExtractedArduinoLibraryRoot(extractionRoot)
    const propertiesPath = path.join(libraryRoot, 'library.properties')
    const properties = parseArduinoLibraryProperties(await readFile(propertiesPath, 'utf8'))
    if (properties.name.toLocaleLowerCase('en') !== match.library.name.toLocaleLowerCase('en')) {
      throw new Error('Arduino library metadata does not match the registry')
    }
    if (properties.version && properties.version !== match.release.version) {
      throw new Error('Arduino library version does not match the registry')
    }

    const receipt = {
      source: 'arduino-library-manager',
      libraryId: match.library.id,
      name: match.library.name,
      version: match.release.version,
    }
    await writeFile(
      path.join(libraryRoot, COMPONENT_LIBRARY_RECEIPT),
      JSON.stringify(receipt, null, 2),
    )

    const folderName = canonicalRegistryFolderName(match.release, libraryRoot, extractionRoot)
    const targetPath = path.join(componentsRoot, folderName)
    if (await pathExists(targetPath)) {
      const existingProperties = await readFile(
        path.join(targetPath, 'library.properties'),
        'utf8',
      ).then(parseArduinoLibraryProperties).catch(() => null)
      if (
        existingProperties?.name.toLocaleLowerCase('en') === match.library.name.toLocaleLowerCase('en')
        && existingProperties?.version === match.release.version
      ) {
        const existingReceipt = await readFile(
          path.join(targetPath, COMPONENT_LIBRARY_RECEIPT),
          'utf8',
        ).then(value => JSON.parse(value)).catch(() => null)
        return {
          ...toRegistryClientLibrary(match.library, {
            folderName,
            version: match.release.version,
            receipt: existingReceipt,
          }, new Set(), match.release.version),
          alreadyInstalled: true,
        }
      }
      throw new ComponentLibraryError(
        'COMPONENT_PATH_CONFLICT',
        `sketch/libraries/${folderName} already exists; remove it before switching versions`,
      )
    }
    await rename(libraryRoot, targetPath)
    return {
      ...toRegistryClientLibrary(match.library, {
        folderName,
        version: match.release.version,
        receipt,
      }, new Set(), match.release.version),
      alreadyInstalled: false,
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
}

export async function removeArduinoComponentLibrary({
  workspaceRoot,
  appDataPath,
  libraryId,
  version,
}) {
  const projectRoot = await resolveWorkspaceRoot(workspaceRoot)
  const appDataRoot = await resolveAppDataRoot(appDataPath)
  const registry = await loadArduinoLibraryRegistry({ cacheRoot: appDataRoot })
  const match = findArduinoLibraryRelease(registry, libraryId, version)
  if (!match) {
    throw new ComponentLibraryError(
      'ARDUINO_LIBRARY_NOT_FOUND',
      'Arduino Library Manager version was not found',
    )
  }

  const componentsRoot = path.join(projectRoot, 'sketch', 'libraries')
  const candidates = []
  for (const entry of await readdir(componentsRoot, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() || !isSafeComponentLibraryDirectoryName(entry.name)) continue
    const targetPath = path.join(componentsRoot, entry.name)
    const targetStat = await lstat(targetPath).catch(() => null)
    if (!targetStat?.isDirectory() || targetStat.isSymbolicLink()) continue
    const propertiesPath = path.join(targetPath, 'library.properties')
    const propertiesStat = await lstat(propertiesPath).catch(() => null)
    if (!propertiesStat?.isFile() || propertiesStat.isSymbolicLink()) continue
    const properties = parseArduinoLibraryProperties(await readFile(propertiesPath, 'utf8'))
    if (properties.name.toLocaleLowerCase('en') === match.library.name.toLocaleLowerCase('en')) {
      candidates.push({ folderName: entry.name, targetPath, properties })
    }
  }

  if (candidates.length === 0) {
    return {
      id: match.library.id,
      source: 'registry',
      name: match.library.name,
      version: match.release.version,
      removed: false,
      alreadyRemoved: true,
    }
  }
  if (candidates.length > 1) {
    throw new Error(`Multiple components match Arduino library ${match.library.name}; remove the intended folder manually`)
  }

  const candidate = candidates[0]
  if (candidate.properties.version !== match.release.version) {
    throw new Error(
      `Installed ${match.library.name} version ${candidate.properties.version || '(unknown)'} does not match requested version ${match.release.version}`,
    )
  }

  const receiptPath = path.join(candidate.targetPath, COMPONENT_LIBRARY_RECEIPT)
  let receipt = null
  if (await pathExists(receiptPath)) {
    try {
      receipt = JSON.parse(await readFile(receiptPath, 'utf8'))
    } catch {
      throw new ComponentLibraryError(
        'COMPONENT_PROVENANCE_CONFLICT',
        `sketch/libraries/${candidate.folderName} has invalid Arduino library provenance metadata`,
      )
    }
  }
  if (!receipt) {
    throw new ComponentLibraryError(
      'COMPONENT_PROVENANCE_REQUIRED',
      `sketch/libraries/${candidate.folderName} has no Coder Arduino installation metadata; refusing to remove a possibly local library`,
    )
  }
  if (
    receipt.source !== 'arduino-library-manager'
    || receipt.libraryId !== match.library.id
    || receipt.name !== match.library.name
    || receipt.version !== match.release.version
  ) {
    throw new ComponentLibraryError(
      'COMPONENT_PROVENANCE_CONFLICT',
      `sketch/libraries/${candidate.folderName} has conflicting Arduino library provenance metadata`,
    )
  }

  await rm(candidate.targetPath, { recursive: true, force: false })
  return {
    id: match.library.id,
    source: 'registry',
    name: match.library.name,
    version: match.release.version,
    folderName: candidate.folderName,
    removed: true,
    alreadyRemoved: false,
  }
}
