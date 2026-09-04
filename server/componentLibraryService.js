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
import {
  downloadCoderLibraryArchive,
  findCoderLibraryRelease,
  loadCoderLibraryRegistry,
  searchCoderLibraryRegistry,
} from './coderLibraryRegistry.js'

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
  const projectConfig = path.join(root, 'package.json')
  const manifest = await readJson(projectConfig, 'package.json').catch(() => null)
  if (manifest?.type !== 'coder') {
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

function findBoardPackageName(project) {
  const dependencyNames = [
    ...Object.keys(project?.dependencies ?? {}),
    ...Object.keys(project?.boardDependencies ?? {}),
  ]
  return dependencyNames.find(name => (
    isSafeAilyPackageName(name, 'board-') || isSafeAilyPackageName(name, 'coder-')
  )) ?? ''
}

function selectLegacyPlatformPackage(project, boardManifest) {
  const framework = String(project?.framework ?? project?.devmode ?? '').trim()
  const boardId = String(project?.board ?? '').trim()
  const supported = Array.isArray(boardManifest?.aily?.supportedPlatforms)
    ? boardManifest.aily.supportedPlatforms
    : []
  const selected = supported.find(item => (
    (!framework || String(item?.framework ?? framework) === framework)
    && (!boardId || String(item?.boardId ?? '') === boardId)
  )) ?? supported[0]
  const packageName = String(selected?.platform ?? '').trim()
  return isSafeAilyPackageName(packageName, 'platform-') ? packageName : ''
}

function addSdkDependencies(target, dependencies) {
  for (const [packageName, declaredVersion] of Object.entries(dependencies ?? {})) {
    const version = normalizeDeclaredVersion(declaredVersion)
    if (isSafeAilyPackageName(packageName, 'sdk-') && version) {
      target.set(packageName, version)
    }
  }
}

async function resolveEffectiveSdkDependencies(projectRoot, appDataRoot) {
  const project = await readJson(path.join(projectRoot, 'package.json'), 'package.json')
  const boardPackageName = findBoardPackageName(project)
  const boardManifest = boardPackageName
    ? await readJson(
      path.join(packagePath(projectRoot, boardPackageName), 'package.json'),
      'Board package',
    )
    : null
  const sdkDependencies = new Map()

  // Match the host build contract: the board package's boardDependencies are
  // the baseline runtime dependencies. Current board packages do not have to
  // declare a separate platform or aily.supportedPlatforms entry.
  addSdkDependencies(sdkDependencies, boardManifest?.boardDependencies)
  addSdkDependencies(sdkDependencies, project?.boardDependencies)
  addSdkDependencies(sdkDependencies, project?.dependencies)

  const configuredPlatform = String(project?.platform ?? '').trim()
  const platformPackageName = isSafeAilyPackageName(configuredPlatform, 'platform-')
    ? configuredPlatform
    : selectLegacyPlatformPackage(project, boardManifest)
  if (platformPackageName) {
    const platformManifest = await readJson(
      path.join(packagePath(appDataRoot, platformPackageName), 'platform.json'),
      'Coder platform manifest',
    ).catch(() => null)
    const runtimeDependencies = Array.isArray(platformManifest?.runtimeDependencies)
      ? platformManifest.runtimeDependencies
      : []
    for (const item of runtimeDependencies) {
      const packageName = String(item?.package ?? '').trim()
      const version = normalizeDeclaredVersion(item?.version)
      if (
        (String(item?.role ?? '') === 'sdk' || packageName.startsWith('@aily-project/sdk-'))
        && isSafeAilyPackageName(packageName, 'sdk-')
        && version
      ) {
        // Platform runtimeDependencies override a same-name board dependency,
        // exactly as child/scripts/platform-runtime.js does for builds.
        sdkDependencies.set(packageName, version)
      }
    }
  }

  if (sdkDependencies.size === 0) {
    if (!boardPackageName && !platformPackageName) {
      throw new Error('package.json does not declare a valid board package or platform')
    }
    throw new Error('The active Coder board does not declare an SDK dependency')
  }
  return sdkDependencies
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
  const sdkDependencies = await resolveEffectiveSdkDependencies(projectRoot, appDataRoot)
  const sdkRoots = []
  for (const [packageName, version] of sdkDependencies) {
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

async function removeManagedComponentLibrary({
  workspaceRoot,
  libraryId,
  version,
  receiptSource,
  clientSource,
  versionErrorCode,
  provenanceConflictCode,
  includeLibraryRef = false,
}) {
  const requestedVersion = String(version ?? '').trim()
  if (!requestedVersion) {
    throw new ComponentLibraryError(versionErrorCode, 'A managed Coder library requires its exact installed version')
  }

  const projectRoot = await resolveWorkspaceRoot(workspaceRoot)
  const componentsRoot = path.join(projectRoot, 'sketch', 'libraries')
  const candidates = []
  for (const entry of await readdir(componentsRoot, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() || !isSafeComponentLibraryDirectoryName(entry.name)) continue
    const targetPath = path.join(componentsRoot, entry.name)
    const targetStat = await lstat(targetPath).catch(() => null)
    if (!targetStat?.isDirectory() || targetStat.isSymbolicLink()) continue

    const receiptPath = path.join(targetPath, COMPONENT_LIBRARY_RECEIPT)
    const receiptStat = await lstat(receiptPath).catch(() => null)
    if (!receiptStat?.isFile() || receiptStat.isSymbolicLink()) continue
    const receipt = await readFile(receiptPath, 'utf8')
      .then(value => JSON.parse(value)).catch(() => null)
    if (
      !receipt
      || receipt.source !== receiptSource
      || receipt.libraryId !== libraryId
    ) continue

    const propertiesPath = path.join(targetPath, 'library.properties')
    const propertiesStat = await lstat(propertiesPath).catch(() => null)
    const properties = propertiesStat?.isFile() && !propertiesStat.isSymbolicLink()
      ? await readFile(propertiesPath, 'utf8').then(parseArduinoLibraryProperties).catch(() => null)
      : null
    candidates.push({ folderName: entry.name, targetPath, properties, receipt })
  }

  const base = {
    id: libraryId,
    ...(includeLibraryRef ? { libraryRef: libraryId } : {}),
    source: clientSource,
    version: requestedVersion,
  }
  if (candidates.length === 0) {
    return { ...base, removed: false, alreadyRemoved: true }
  }
  if (candidates.length > 1) {
    throw new ComponentLibraryError(
      provenanceConflictCode,
      'Multiple managed sketch/libraries entries have the same library reference',
    )
  }

  const candidate = candidates[0]
  const receiptName = typeof candidate.receipt.name === 'string'
    ? candidate.receipt.name.trim()
    : ''
  if (
    !candidate.properties?.name
    || !receiptName
    || candidate.properties.name.toLocaleLowerCase('en') !== receiptName.toLocaleLowerCase('en')
    || candidate.properties.version !== candidate.receipt.version
    || candidate.receipt.version !== requestedVersion
  ) {
    throw new ComponentLibraryError(
      provenanceConflictCode,
      `sketch/libraries/${candidate.folderName} has conflicting managed library provenance`,
    )
  }

  await rm(candidate.targetPath, { recursive: true, force: false })
  return {
    ...base,
    name: receiptName,
    folderName: candidate.folderName,
    removed: true,
    alreadyRemoved: false,
    installed: false,
    installedVersion: '',
    managed: false,
  }
}

function activeArduinoArchitectures(sdkRoots) {
  const architectures = new Set()
  for (const sdk of sdkRoots) {
    const shortName = sdk.packageName.replace(/^@aily-project\/sdk-/u, '')
    architectures.add(shortName.toLocaleLowerCase('en'))
    const lastSegment = shortName.split('-').at(-1)
    if (lastSegment) architectures.add(lastSegment.toLocaleLowerCase('en'))
  }
  return architectures
}

function releaseIsCompatible(release, activeArchitectures) {
  return release.architectures.length === 0
    || release.architectures.includes('*')
    || release.architectures.some(item => activeArchitectures.has(item.toLocaleLowerCase('en')))
}

function compatibilityDetails(release, activeArchitectures, compatibleAlternatives = []) {
  return {
    compatible: releaseIsCompatible(release, activeArchitectures),
    supportedArchitectures: [...release.architectures],
    activeArchitectures: [...activeArchitectures].sort((left, right) => left.localeCompare(right, 'en')),
    compatibleAlternatives,
  }
}

function toRegistryClientLibrary(library, installed, activeArchitectures, selectedVersion) {
  const selected = library.versions.find(item => item.version === selectedVersion) ?? library.versions[0]
  const compatibility = compatibilityDetails(selected, activeArchitectures)
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
    versions: [...new Set([installed?.version, ...library.versions.map(item => item.version)].filter(Boolean))],
    author: selected.author,
    maintainer: selected.maintainer,
    sentence: selected.sentence,
    paragraph: selected.paragraph,
    category: selected.category,
    url: selected.website || selected.repository,
    architectures: selected.architectures,
    types: selected.types,
    compatible: compatibility.compatible,
    compatibility,
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
    await writeFile(
      path.join(stagingPath, COMPONENT_LIBRARY_RECEIPT),
      JSON.stringify({
        source: 'arduino-platform',
        libraryId: library.id,
        name: library.name || library.folderName,
        version: library.version,
      }, null, 2),
    )
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
  allowIncompatible = false,
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
  const activeArchitectures = activeArduinoArchitectures(sdkRoots)
  const compatibility = compatibilityDetails(match.release, activeArchitectures)
  if (!compatibility.compatible && !allowIncompatible) {
    throw new ComponentLibraryError(
      'ARDUINO_LIBRARY_INCOMPATIBLE',
      `${match.library.name} ${match.release.version} is not compatible with the active Coder architecture`,
      compatibility,
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
          }, activeArchitectures, match.release.version),
          alreadyInstalled: true,
          compatibilityOverride: !compatibility.compatible,
          ...(!compatibility.compatible
            ? { compatibilityWarning: 'Installed despite an incompatible active Coder architecture' }
            : {}),
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
      }, activeArchitectures, match.release.version),
      alreadyInstalled: false,
      compatibilityOverride: !compatibility.compatible,
      ...(!compatibility.compatible
        ? { compatibilityWarning: 'Installed despite an incompatible active Coder architecture' }
        : {}),
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
}

export async function removeArduinoComponentLibrary({
  workspaceRoot,
  libraryId,
  version,
}) {
  return removeManagedComponentLibrary({
    workspaceRoot,
    libraryId,
    version,
    receiptSource: 'arduino-library-manager',
    clientSource: 'registry',
    versionErrorCode: 'ARDUINO_LIBRARY_VERSION_REQUIRED',
    provenanceConflictCode: 'COMPONENT_PROVENANCE_CONFLICT',
  })
}

function toCoderIndexClientLibrary(library, installed, activeArchitectures, selectedVersion) {
  const selected = library.versions.find(item => item.version === selectedVersion) ?? library.versions[0]
  const compatibility = compatibilityDetails(selected, activeArchitectures)
  const managed = Boolean(
    installed?.receipt
    && installed.receipt.source === 'aily-coder-index'
    && installed.receipt.libraryId === library.id
    && installed.receipt.name === selected.name
    && installed.receipt.version === installed.version,
  )
  return {
    id: library.id,
    libraryRef: library.id,
    tier: 'preferred',
    source: 'aily',
    folderName: installed?.folderName ?? '',
    sdkLabel: 'Aily Coder Library',
    name: selected.name,
    version: selected.version,
    versions: [...new Set([installed?.version, ...library.versions.map(item => item.version)].filter(Boolean))],
    author: selected.author,
    maintainer: selected.maintainer,
    sentence: selected.sentence,
    paragraph: selected.paragraph,
    category: selected.category,
    url: selected.website || selected.repository,
    architectures: selected.architectures,
    types: selected.types,
    dependencies: selected.dependencies,
    providesIncludes: selected.providesIncludes,
    compatible: compatibility.compatible,
    compatibility,
    installed: Boolean(installed),
    installedVersion: installed?.version ?? '',
    managed,
  }
}

function similarityTokens(release) {
  const ignored = new Set(['aily', 'arduino', 'library', 'libraries', 'the', 'and', 'for', 'with'])
  return new Set([
    release.name,
    release.sentence,
    release.paragraph,
    ...release.providesIncludes,
  ].join(' ').normalize('NFKC').toLocaleLowerCase('en')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(token => token.length >= 3 && !ignored.has(token)))
}

function compatibleCoderAlternatives(registry, match, activeArchitectures, limit = 3) {
  const target = match.release
  const targetTokens = similarityTokens(target)
  const targetTypes = new Set(target.types)
  return registry.libraries.flatMap(library => {
    if (library.id === match.library.id) return []
    const release = library.versions.find(candidate => releaseIsCompatible(candidate, activeArchitectures))
    if (!release) return []

    const sharedTypes = release.types.filter(type => targetTypes.has(type))
    const sharedTokens = [...similarityTokens(release)].filter(token => targetTokens.has(token))
    const sameCategory = Boolean(target.category && release.category === target.category)
    const score = (sameCategory ? 8 : 0) + sharedTypes.length * 4 + Math.min(sharedTokens.length, 5)
    if (score === 0) return []
    return [{
      libraryRef: library.id,
      name: release.name,
      version: release.version,
      sentence: release.sentence,
      category: release.category,
      architectures: release.architectures,
      types: release.types,
      similarityReasons: [
        ...(sameCategory ? [`category:${release.category}`] : []),
        ...sharedTypes.map(type => `type:${type}`),
        ...sharedTokens.slice(0, 3).map(token => `keyword:${token}`),
      ],
      score,
    }]
  }).sort((left, right) => (
    right.score - left.score || left.name.localeCompare(right.name, 'en')
  )).slice(0, limit).map(item => {
    const library = { ...item }
    Reflect.deleteProperty(library, 'score')
    return library
  })
}

export async function searchCoderIndexLibraries({
  workspaceRoot,
  appDataPath,
  query,
  category,
  type,
  offset,
  limit,
  forceRefresh = false,
  indexUrl,
  fetchImpl,
  signal,
}) {
  const projectRoot = await resolveWorkspaceRoot(workspaceRoot)
  const appDataRoot = await resolveAppDataRoot(appDataPath)
  const componentsRoot = path.join(projectRoot, 'sketch', 'libraries')
  const [registry, installed, sdkRoots] = await Promise.all([
    loadCoderLibraryRegistry({
      cacheRoot: appDataRoot,
      indexUrl,
      forceRefresh,
      ...(fetchImpl ? { fetchImpl } : {}),
      signal,
    }),
    listInstalledComponentLibraries(componentsRoot),
    resolveSdkRoots(projectRoot, appDataRoot).catch(() => []),
  ])
  const activeArchitectures = activeArduinoArchitectures(sdkRoots)
  const result = searchCoderLibraryRegistry(registry, { query, category, type, offset, limit })
  const libraries = result.libraries.map(library => toCoderIndexClientLibrary(
    library,
    installed.get(library.name.toLocaleLowerCase('en')),
    activeArchitectures,
  ))
  const normalizedQuery = String(query ?? '').normalize('NFKC').trim().toLocaleLowerCase('en')
  const exactMatch = result.libraries.find(library => (
    library.name.normalize('NFKC').toLocaleLowerCase('en') === normalizedQuery
  ))
  const exactClientLibrary = exactMatch
    ? libraries.find(library => library.id === exactMatch.id)
    : null
  const matchedRelease = exactMatch
    ? findCoderLibraryRelease(registry, exactMatch.id, exactClientLibrary?.version)
    : null
  return {
    ...result,
    tier: 'preferred',
    libraries,
    activeArchitectures: [...activeArchitectures].sort((left, right) => left.localeCompare(right, 'en')),
    compatibleAlternatives: matchedRelease && exactClientLibrary?.compatible === false
      ? compatibleCoderAlternatives(registry, matchedRelease, activeArchitectures)
      : [],
    categories: registry.categories,
    types: registry.types,
    updatedAt: registry.updatedAt,
    stale: registry.stale,
    indexUrl: registry.indexUrl,
  }
}

function coderInstallResult(
  registry,
  match,
  installed,
  activeArchitectures,
  alreadyInstalled,
  compatibilityOverride,
) {
  const library = toCoderIndexClientLibrary(
    match.library,
    installed,
    activeArchitectures,
    match.release.version,
  )
  const sourceDirectory = path.posix.join('sketch', 'libraries', installed.folderName)
  return {
    ...library,
    ready: true,
    installed: true,
    alreadyInstalled,
    archive: match.release.archiveFileName,
    sourceDirectory,
    libraryRoots: [sourceDirectory],
    indexUrl: registry.indexUrl,
    compatibilityOverride,
    ...(compatibilityOverride
      ? { compatibilityWarning: 'Installed despite an incompatible active Coder architecture' }
      : {}),
  }
}

export async function installCoderIndexLibrary({
  workspaceRoot,
  appDataPath,
  libraryId,
  version,
  indexUrl,
  fetchImpl,
  signal,
  allowIncompatible = false,
}) {
  const projectRoot = await resolveWorkspaceRoot(workspaceRoot)
  const appDataRoot = await resolveAppDataRoot(appDataPath)
  const registry = await loadCoderLibraryRegistry({
    cacheRoot: appDataRoot,
    indexUrl,
    ...(fetchImpl ? { fetchImpl } : {}),
    signal,
  })
  const match = findCoderLibraryRelease(registry, libraryId, version)
  if (!match) {
    throw new ComponentLibraryError(
      'CODER_LIBRARY_NOT_FOUND',
      'Aily Coder library version was not found in libraries-coder-index.json',
    )
  }

  const sdkRoots = await resolveSdkRoots(projectRoot, appDataRoot)
  const activeArchitectures = activeArduinoArchitectures(sdkRoots)
  const isCompatible = releaseIsCompatible(match.release, activeArchitectures)
  const alternatives = isCompatible
    ? []
    : compatibleCoderAlternatives(registry, match, activeArchitectures)
  const compatibility = compatibilityDetails(match.release, activeArchitectures, alternatives)
  if (!compatibility.compatible && !allowIncompatible) {
    throw new ComponentLibraryError(
      'CODER_LIBRARY_INCOMPATIBLE',
      `${match.library.name} ${match.release.version} is not compatible with the active Coder architecture`,
      compatibility,
    )
  }
  const compatibilityOverride = !compatibility.compatible

  const librariesRoot = path.join(projectRoot, 'sketch', 'libraries')
  await mkdir(librariesRoot, { recursive: true })
  const temporaryRoot = await mkdtemp(path.join(librariesRoot, '.aily-coder-install-'))
  const archivePath = path.join(temporaryRoot, match.release.archiveFileName)
  const extractionRoot = path.join(temporaryRoot, 'extracted')
  try {
    await downloadCoderLibraryArchive(match.release, archivePath, {
      ...(fetchImpl ? { fetchImpl } : {}),
      signal,
    })
    await extractArduinoLibraryArchive(archivePath, extractionRoot)
    const libraryRoot = await findExtractedArduinoLibraryRoot(extractionRoot)
    const properties = parseArduinoLibraryProperties(
      await readFile(path.join(libraryRoot, 'library.properties'), 'utf8'),
    )
    if (properties.name.toLocaleLowerCase('en') !== match.library.name.toLocaleLowerCase('en')) {
      throw new ComponentLibraryError(
        'CODER_LIBRARY_ARCHIVE_INVALID',
        'Aily Coder library metadata does not match libraries-coder-index.json',
      )
    }
    if (properties.version && properties.version !== match.release.version) {
      throw new ComponentLibraryError(
        'CODER_LIBRARY_ARCHIVE_INVALID',
        'Aily Coder library version does not match libraries-coder-index.json',
      )
    }

    const receipt = {
      source: 'aily-coder-index',
      libraryId: match.library.id,
      name: match.library.name,
      version: match.release.version,
      indexUrl: registry.indexUrl,
      archiveUrl: match.release.downloadUrl,
      checksum: match.release.checksum,
    }
    await writeFile(
      path.join(libraryRoot, COMPONENT_LIBRARY_RECEIPT),
      JSON.stringify(receipt, null, 2),
    )

    const folderName = canonicalRegistryFolderName(match.release, libraryRoot, extractionRoot)
    const targetPath = path.join(librariesRoot, folderName)
    if (await pathExists(targetPath)) {
      const [existingProperties, existingReceipt] = await Promise.all([
        readFile(path.join(targetPath, 'library.properties'), 'utf8')
          .then(parseArduinoLibraryProperties).catch(() => null),
        readFile(path.join(targetPath, COMPONENT_LIBRARY_RECEIPT), 'utf8')
          .then(value => JSON.parse(value)).catch(() => null),
      ])
      if (
        existingProperties?.name.toLocaleLowerCase('en') === match.library.name.toLocaleLowerCase('en')
        && existingProperties?.version === match.release.version
        && existingReceipt?.source === 'aily-coder-index'
        && existingReceipt?.libraryId === match.library.id
        && existingReceipt?.version === match.release.version
      ) {
        return coderInstallResult(
          registry,
          match,
          { folderName, version: match.release.version, receipt: existingReceipt },
          activeArchitectures,
          true,
          compatibilityOverride,
        )
      }
      throw new ComponentLibraryError(
        'CODER_LIBRARY_PATH_CONFLICT',
        `sketch/libraries/${folderName} already exists and is not this managed Aily Coder library`,
      )
    }
    await rename(libraryRoot, targetPath)
    return coderInstallResult(
      registry,
      match,
      { folderName, version: match.release.version, receipt },
      activeArchitectures,
      false,
      compatibilityOverride,
    )
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
}

export async function removeCoderIndexLibrary({
  workspaceRoot,
  libraryId,
  version,
}) {
  return removeManagedComponentLibrary({
    workspaceRoot,
    libraryId,
    version,
    receiptSource: 'aily-coder-index',
    clientSource: 'aily',
    versionErrorCode: 'CODER_LIBRARY_VERSION_REQUIRED',
    provenanceConflictCode: 'CODER_LIBRARY_PROVENANCE_CONFLICT',
    includeLibraryRef: true,
  })
}

export async function searchCoderLibraries({
  workspaceRoot,
  appDataPath,
  query,
  category,
  type,
  offset,
  limit,
  forceRefresh,
  indexUrl,
  fetchImpl,
  signal,
}) {
  return searchCoderIndexLibraries({
    workspaceRoot,
    appDataPath,
    query,
    category,
    type,
    offset,
    limit,
    forceRefresh,
    indexUrl,
    fetchImpl,
    signal,
  })
}

function parseCoderLibraryRef(libraryRef) {
  const value = String(libraryRef ?? '').trim()
  if (/^coder:[a-f0-9]{24}$/u.test(value)) {
    return { libraryId: value }
  }
  throw new ComponentLibraryError(
    'CODER_LIBRARY_REF_INVALID',
    'libraryRef must be copied exactly from coder_library_search',
  )
}

export async function installCoderLibrary(options) {
  const ref = parseCoderLibraryRef(options.libraryRef)
  if (!String(options.version ?? '').trim()) {
    throw new ComponentLibraryError('CODER_LIBRARY_VERSION_REQUIRED', 'Aily Coder libraries require an exact version')
  }
  return installCoderIndexLibrary({
    ...options,
    libraryId: ref.libraryId,
  })
}

export async function removeCoderLibrary(options) {
  const ref = parseCoderLibraryRef(options.libraryRef)
  if (!String(options.version ?? '').trim()) {
    throw new ComponentLibraryError('CODER_LIBRARY_VERSION_REQUIRED', 'Aily Coder libraries require an exact version')
  }
  return removeCoderIndexLibrary({
    ...options,
    libraryId: ref.libraryId,
  })
}
