import { constants as fsConstants } from 'node:fs'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  access,
  copyFile,
  cp,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { URL } from 'node:url'
import {
  extractArduinoLibraryArchive,
  findExtractedArduinoLibraryRoot,
} from './arduinoLibraryRegistry.js'
import {
  downloadCoderLibraryArchive,
  findCoderLibraryRelease,
  loadCoderLibraryRegistry,
  searchCoderLibraryRegistry,
} from './coderLibraryRegistry.js'

import { CODER_LIBRARY_PACKAGE, loadCoderPackageCatalog } from './coderPackageCatalog.js'

const SAFE_LIBRARY_DIRECTORY = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u
const COMPONENT_LIBRARY_RECEIPT = '.aily-component-library.json'
const BLOCKLY_LIBRARY_RECEIPT = '.aily-blockly-library.json'
const CODER_LOCAL_LIBRARY_RECEIPT = '.aily-coder-local-library.json'
const BLOCKLY_LIBRARY_SOURCE_LAYOUT_VERSION = 2
const BLOCKLY_LIBRARY_PACKAGE = /^@aily-project\/lib-[A-Za-z0-9][A-Za-z0-9._-]*$/u
const MAX_ARCHIVE_ENTRIES = 20_000
const MAX_EXTRACTED_BYTES = 256 * 1024 * 1024
const workspaceMutationLocks = new Map()

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

/** The Arduino tab uses the regional Coder npm catalog and the shared package lifecycle. */
export async function searchArduinoComponentLibraries(options) {
  return searchBlocklyLibraryPackages({ ...options, source: 'registry' })
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

export async function installArduinoComponentLibrary(options) {
  const libraryRef = options.libraryId
  if (!String(libraryRef).startsWith('coder:@aily-project-coder/')) {
    throw new ComponentLibraryError('CODER_LIBRARY_REF_INVALID', 'Use the exact official library ref from the regional Coder catalog')
  }
  return installCoderLibrary({ ...options, libraryRef })
}

export async function removeArduinoComponentLibrary(options) {
  const { workspaceRoot, libraryId, version } = options
  if (String(libraryId).startsWith('coder:@aily-project-coder/')) {
    return removeCoderLibrary({ ...options, libraryRef: libraryId })
  }
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

export async function searchCoderLibraries(options) {
  return searchBlocklyLibraryPackages(options)
}

function parseCoderLibraryRef(libraryRef) {
  const value = String(libraryRef ?? '').trim()
  if (value.startsWith('blockly:') && BLOCKLY_LIBRARY_PACKAGE.test(value.slice(8))) {
    return { packageName: value.slice(8) }
  }
  if (value.startsWith('coder:') && CODER_LIBRARY_PACKAGE.test(value.slice(6))) {
    return { packageName: value.slice(6) }
  }
  if (value.startsWith('arduino:')) return { arduinoId: value }
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
  if (ref.packageName) return installBlocklyLibraryPackage({ ...options, packageName: ref.packageName })
  if (ref.arduinoId) throw new ComponentLibraryError('CODER_LIBRARY_REF_INVALID', 'Search the regional Coder catalog to install an official library')
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
  if (ref.packageName) return removeBlocklyLibraryPackage({ ...options, packageName: ref.packageName })
  if (ref.arduinoId) return removeArduinoComponentLibrary({ ...options, libraryId: ref.arduinoId })
  return removeCoderIndexLibrary({
    ...options,
    libraryId: ref.libraryId,
  })
}

export function isSafeBlocklyLibraryPackageName(value) {
  return BLOCKLY_LIBRARY_PACKAGE.test(String(value ?? '')) || CODER_LIBRARY_PACKAGE.test(String(value ?? ''))
}

function packageLibraryIdentity(packageName) {
  const official = CODER_LIBRARY_PACKAGE.test(packageName)
  const libraryRef = `${official ? 'coder' : 'blockly'}:${packageName}`
  return { id: libraryRef, libraryRef, source: official ? 'registry' : 'aily' }
}

function directDependencySpec(manifest, packageName) {
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    const value = manifest?.[field]?.[packageName]
    if (typeof value === 'string' && value.trim()) {
      return { field, value: value.trim() }
    }
  }
  return null
}

function npmExecutable() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm'
}

async function ailyNpmEnvironment(appDataPath) {
  const env = { ...process.env }
  const appNpmrcPath = path.join(appDataPath || defaultAilyAppDataPath(), '.npmrc')
  if (!String(env.NPM_CONFIG_USERCONFIG ?? '').trim() && await pathExists(appNpmrcPath)) {
    env.NPM_CONFIG_USERCONFIG = appNpmrcPath
  }
  if (!String(env.AILY_NPM_REGISTRY ?? '').trim() && await pathExists(appNpmrcPath)) {
    const npmrc = await readFile(appNpmrcPath, 'utf8').catch(() => '')
    const scopedRegistry = npmrc.match(/^@aily-project:registry\s*=\s*(\S+)\s*$/imu)?.[1]
    if (scopedRegistry) env.AILY_NPM_REGISTRY = scopedRegistry
  }
  const config = await readJson(path.join(appDataPath || defaultAilyAppDataPath(), 'config.json'), 'config').catch(() => null)
  const registry = config?.regions?.[config?.region]?.npm_registry || env.AILY_NPM_REGISTRY
  if (registry) {
    env.AILY_NPM_REGISTRY = registry
    env.npm_config_registry = registry
  }
  const region = String(config?.region || env.AILY_REGION || 'cn').toLowerCase()
  const regionConfig = config?.regions?.[region]
  const international = regionConfig?.resource
    ? new URL(regionConfig.resource).hostname === 'rs1.aily.pro'
    : !['cn', 'dev-china', 'localhost'].includes(region)
  env.AILY_NPM_REGISTRY_CODER = regionConfig?.npm_registry_coder
    || (!config?.region && env.AILY_NPM_REGISTRY_CODER)
    || (international ? 'https://cregistry.aily.pro' : 'https://cregistry.yiyu.pro')
  return env
}

function sevenZipExecutable(explicitPath) {
  const configured = String(explicitPath ?? process.env.AILY_7ZA_PATH ?? '').trim()
  if (configured) return configured
  return process.platform === 'win32' ? '7za.exe' : '7zz'
}

function runProcess(command, args, { cwd, signal, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      signal,
      shell: process.platform === 'win32' && command.toLowerCase().endsWith('.cmd'),
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    const append = (current, chunk) => {
      const next = current + String(chunk)
      return next.length > 2_000_000 ? next.slice(-2_000_000) : next
    }
    child.stdout?.on('data', chunk => { stdout = append(stdout, chunk) })
    child.stderr?.on('data', chunk => { stderr = append(stderr, chunk) })
    child.once('error', reject)
    child.once('close', code => {
      if (code === 0) {
        resolve({ stdout, stderr })
        return
      }
      reject(new ComponentLibraryError(
        'BLOCKLY_LIBRARY_COMMAND_FAILED',
        `${path.basename(command)} exited with code ${code}: ${(stderr || stdout).trim() || 'no output'}`,
        { command: path.basename(command), exitCode: code },
      ))
    })
  })
}

async function runNpmLibraryCommand(projectRoot, args, { signal, runNpmCommand, appDataPath } = {}) {
  const env = await ailyNpmEnvironment(appDataPath)
  if (runNpmCommand) {
    return runNpmCommand({ projectRoot, args, signal, env })
  }
  return runProcess(npmExecutable(), [...args, `--@aily-project-coder:registry=${env.AILY_NPM_REGISTRY_CODER}`], {
    cwd: projectRoot,
    signal,
    env,
  })
}

async function withWorkspaceMutationLock(workspaceRoot, task) {
  const key = path.resolve(workspaceRoot)
  const previous = workspaceMutationLocks.get(key) ?? Promise.resolve()
  const current = previous.catch(() => undefined).then(task)
  workspaceMutationLocks.set(key, current)
  try {
    return await current
  } finally {
    if (workspaceMutationLocks.get(key) === current) {
      workspaceMutationLocks.delete(key)
    }
  }
}

function parseSevenZipEntries(output) {
  return String(output ?? '')
    .split(/\r?\n\s*\r?\n/u)
    .map(recordText => Object.fromEntries(
      recordText.split(/\r?\n/u).flatMap(line => {
        const separator = line.indexOf(' = ')
        return separator > 0 ? [[line.slice(0, separator), line.slice(separator + 3)]] : []
      }),
    ))
    .filter(record => typeof record.Path === 'string')
}

function validateArchiveEntry(record) {
  const raw = String(record.Path ?? '')
  const normalized = raw.replace(/\\/gu, '/')
  const segments = normalized.split('/')
  if (
    !normalized
    || normalized.length > 1024
    || normalized.startsWith('/')
    || normalized.includes(':')
    || [...normalized].some(character => character.charCodeAt(0) < 32)
    || segments.some(segment => !segment || segment === '.' || segment === '..')
  ) {
    throw new ComponentLibraryError(
      'BLOCKLY_LIBRARY_ARCHIVE_UNSAFE',
      `src.7z contains an unsafe path: ${raw || '(empty)'}`,
    )
  }
  if (String(record.Encrypted ?? '') === '+') {
    throw new ComponentLibraryError(
      'BLOCKLY_LIBRARY_ARCHIVE_UNSAFE',
      `src.7z contains an encrypted entry: ${raw}`,
    )
  }
  if (record['Symbolic Link'] || record['Hard Link'] || /(^|\s)l[rwx-]{9}|\bL\b/u.test(String(record.Attributes ?? ''))) {
    throw new ComponentLibraryError(
      'BLOCKLY_LIBRARY_ARCHIVE_UNSAFE',
      `src.7z contains a symbolic link: ${raw}`,
    )
  }
}

async function extractBlocklyLibraryArchive(archivePath, destination, options = {}) {
  const executable = sevenZipExecutable(options.sevenZipPath)
  const listing = await runProcess(executable, ['l', '-slt', '-ba', archivePath], {
    signal: options.signal,
  })
  const entries = parseSevenZipEntries(listing.stdout)
  if (entries.length === 0 || entries.length > MAX_ARCHIVE_ENTRIES) {
    throw new ComponentLibraryError(
      'BLOCKLY_LIBRARY_ARCHIVE_INVALID',
      `src.7z must contain between 1 and ${MAX_ARCHIVE_ENTRIES} entries`,
    )
  }
  entries.forEach(validateArchiveEntry)
  if (entries.reduce((total, entry) => total + Number(entry.Size || 0), 0) > MAX_EXTRACTED_BYTES) {
    throw new ComponentLibraryError('BLOCKLY_LIBRARY_ARCHIVE_INVALID', 'src.7z expands beyond 256 MiB')
  }
  await mkdir(destination, { recursive: true })
  await runProcess(executable, ['x', '-y', `-o${destination}`, archivePath], {
    signal: options.signal,
  })
}

async function validateExtractedTree(root) {
  let entries = 0
  let totalBytes = 0
  async function visit(current) {
    const currentStat = await lstat(current)
    if (currentStat.isSymbolicLink()) {
      throw new ComponentLibraryError(
        'BLOCKLY_LIBRARY_ARCHIVE_UNSAFE',
        'src.7z extracted a symbolic link',
      )
    }
    entries += 1
    if (entries > MAX_ARCHIVE_ENTRIES) {
      throw new ComponentLibraryError('BLOCKLY_LIBRARY_ARCHIVE_INVALID', 'src.7z contains too many entries')
    }
    if (currentStat.isFile()) {
      totalBytes += currentStat.size
      if (totalBytes > MAX_EXTRACTED_BYTES) {
        throw new ComponentLibraryError('BLOCKLY_LIBRARY_ARCHIVE_INVALID', 'src.7z expands beyond 256 MiB')
      }
      return
    }
    if (!currentStat.isDirectory()) {
      throw new ComponentLibraryError('BLOCKLY_LIBRARY_ARCHIVE_UNSAFE', 'src.7z contains an unsupported entry')
    }
    for (const entry of await readdir(current)) {
      await visit(path.join(current, entry))
    }
  }
  await visit(root)
}

function fallbackLibraryRootName(packageManifest) {
  const packageRoot = String(packageManifest?.name ?? '').split('/').at(-1)
  if (isSafeComponentLibraryDirectoryName(packageRoot)) return packageRoot
  for (const value of [packageManifest?.nickname, packageManifest?.displayName]) {
    const candidate = String(value ?? '').trim().replace(/\s+/gu, '_')
    if (isSafeComponentLibraryDirectoryName(candidate)) return candidate
  }
  const candidate = String(packageManifest?.name ?? '')
    .replace(/^@aily-project\/lib-/u, '')
    .replace(/[^A-Za-z0-9_.-]+/gu, '_')
  if (isSafeComponentLibraryDirectoryName(candidate)) return candidate
  throw new ComponentLibraryError('BLOCKLY_LIBRARY_ARCHIVE_INVALID', 'Cannot derive a safe Coder library directory name')
}

async function resolveBlocklyArchiveRoots(extractionRoot, packageManifest, relativeBase = 'src') {
  await validateExtractedTree(extractionRoot)
  let sourceRoot = extractionRoot
  let sourceRelativePath = relativeBase
  let entries = (await readdir(sourceRoot, { withFileTypes: true }))
    .filter(entry => !entry.name.startsWith('.'))
  // Packages may wrap library roots in src/src/...; stop before each library's own src.
  while (entries.length === 1 && entries[0].name === 'src') {
    if (!entries[0].isDirectory()) {
      throw new ComponentLibraryError('BLOCKLY_LIBRARY_ARCHIVE_INVALID', 'src must be a directory')
    }
    sourceRoot = path.join(sourceRoot, 'src')
    sourceRelativePath = path.posix.join(sourceRelativePath, 'src')
    entries = (await readdir(sourceRoot, { withFileTypes: true }))
      .filter(entry => !entry.name.startsWith('.'))
  }
  if (entries.length === 0) {
    throw new ComponentLibraryError('BLOCKLY_LIBRARY_ARCHIVE_INVALID', 'src.7z contains an empty src directory')
  }
  const directFiles = entries.filter(entry => !entry.isDirectory())
  if (directFiles.length > 0) {
    return [{
      folderName: fallbackLibraryRootName(packageManifest),
      relativePath: sourceRelativePath,
      sourcePath: sourceRoot,
    }]
  }
  return entries.map(entry => {
    if (!isSafeComponentLibraryDirectoryName(entry.name)) {
      throw new ComponentLibraryError(
        'BLOCKLY_LIBRARY_ARCHIVE_INVALID',
        `src.7z contains an invalid library root: ${entry.name}`,
      )
    }
    return {
      folderName: entry.name,
      relativePath: path.posix.join(sourceRelativePath, entry.name),
      sourcePath: path.join(sourceRoot, entry.name),
    }
  })
}

async function fingerprintLibraryTree(root, ignoredNames = new Set()) {
  const rootRealPath = await realpath(root)
  const activeDirectories = new Set()
  const hash = createHash('sha256')

  async function visit(currentPath, relativePath) {
    const realPath = await realpath(currentPath)
    if (!isPathInside(rootRealPath, realPath)) {
      throw new ComponentLibraryError(
        'BLOCKLY_LIBRARY_PROVENANCE_CONFLICT',
        `Library source link escapes its root: ${currentPath}`,
      )
    }
    const currentStat = await stat(currentPath)
    const normalizedPath = relativePath.split(path.sep).join('/')
    if (currentStat.isDirectory()) {
      if (activeDirectories.has(realPath)) {
        throw new ComponentLibraryError(
          'BLOCKLY_LIBRARY_PROVENANCE_CONFLICT',
          `Library source contains a directory link cycle: ${currentPath}`,
        )
      }
      hash.update(`directory\0${normalizedPath}\0`)
      activeDirectories.add(realPath)
      const entries = (await readdir(currentPath))
        .filter(entry => !ignoredNames.has(entry))
        .sort((left, right) => left.localeCompare(right))
      for (const entry of entries) {
        await visit(path.join(currentPath, entry), path.join(relativePath, entry))
      }
      activeDirectories.delete(realPath)
      return
    }
    if (currentStat.isFile()) {
      const content = await readFile(currentPath)
      hash.update(`file\0${normalizedPath}\0${content.length}\0`)
      hash.update(content)
      hash.update('\0')
      return
    }
    hash.update(`other\0${normalizedPath}\0`)
  }

  await visit(root, '')
  return `sha256:${hash.digest('hex')}`
}

function normalizeCatalogArray(payload) {
  if (Array.isArray(payload)) return payload
  if (Array.isArray(payload?.libraries)) return payload.libraries
  return []
}

async function readOptionalCatalog(filePath) {
  try {
    return normalizeCatalogArray(JSON.parse(await readFile(filePath, 'utf8')))
  } catch {
    return []
  }
}

function toBlocklyPackageName(value) {
  const raw = String(value ?? '').trim()
  const packageName = raw.startsWith('@') ? raw : `@aily-project/${raw}`
  return isSafeBlocklyLibraryPackageName(packageName) ? packageName : ''
}

function catalogMatchesWordBoundary(text, query) {
  const delimiters = ' \t\r\n-_/@:.,;()[]{},。！？；：、【】《》（）'
  let index = 0
  while ((index = text.indexOf(query, index)) !== -1) {
    const beforeMatches = index === 0 || delimiters.includes(text[index - 1])
    const afterIndex = index + query.length
    const afterMatches = afterIndex === text.length || delimiters.includes(text[afterIndex])
    if (beforeMatches && afterMatches) return true
    index += 1
  }
  return false
}

function catalogTextScore(value, token, weights, exactOnly = false) {
  const scoreOne = item => {
    const text = String(item ?? '').toLocaleLowerCase('en')
    if (text === token) return weights[0]
    if (exactOnly) return 0
    if (weights[1] > 0 && catalogMatchesWordBoundary(text, token)) return weights[1]
    if (weights[2] > 0 && text.includes(token)) return weights[2]
    return 0
  }
  return Array.isArray(value)
    ? value.reduce((total, item) => total + scoreOne(item), 0)
    : scoreOne(value)
}

function scoreCatalogItem(item, tokens, fields) {
  let totalScore = 0
  const matchedFields = []
  const matchedQueries = []
  for (const token of tokens) {
    let queryScore = 0
    for (const field of fields) {
      const fieldScore = catalogTextScore(
        field.value(item),
        token,
        field.weights,
        field.exactOnly === true,
      )
      if (fieldScore > 0) {
        queryScore += fieldScore
        if (!matchedFields.includes(field.name)) matchedFields.push(field.name)
      }
    }
    if (queryScore > 0) {
      totalScore += queryScore
      matchedQueries.push(token)
    }
  }
  if (tokens.length > 1 && matchedQueries.length > 1) {
    totalScore *= matchedQueries.length === tokens.length
      ? 1.5
      : 1 + 0.2 * (matchedQueries.length - 1)
  }
  return { totalScore, matchedFields, matchedQueries }
}

const BLOCKLY_INDEX_LIBRARY_FIELDS = [
  { name: 'keywords', value: item => item?.keywords, weights: [20, 15, 10] },
  { name: 'tags', value: item => item?.tags, weights: [18, 12, 8] },
  { name: 'displayName', value: item => item?.displayName, weights: [15, 10, 7] },
  { name: 'name', value: item => item?.name, weights: [15, 10, 6] },
  { name: 'hardwareType', value: item => item?.hardwareType, weights: [15, 12, 12] },
  { name: 'description', value: item => item?.description, weights: [5, 5, 3] },
  { name: 'category', value: item => item?.category, weights: [8, 0, 0] },
  { name: 'communication', value: item => item?.communication, weights: [8, 0, 0], exactOnly: true },
  { name: 'supportedCores', value: item => item?.supportedCores, weights: [6, 6, 6] },
  { name: 'compatibleHardware', value: item => item?.compatibleHardware, weights: [6, 6, 6] },
]

const BLOCKLY_LEGACY_LIBRARY_FIELDS = [
  { name: 'keywords', value: item => item?.keywords, weights: [20, 15, 10] },
  { name: 'nickname', value: item => item?.nickname, weights: [18, 12, 8] },
  { name: 'description', value: item => item?.description, weights: [9, 9, 5] },
  { name: 'core', value: item => item?.compatibility?.core, weights: [10, 5, 5] },
  { name: 'author', value: item => item?.author, weights: [6, 3, 3] },
  { name: 'name', value: item => item?.name, weights: [8, 8, 0] },
]

async function sharedBlocklyCatalog(appDataRoot, { forceRefresh, fetchImpl = globalThis.fetch, signal } = {}) {
  const names = ['libraries-index.json', 'libraries.json']
  const cached = await Promise.all(names.map(name => readOptionalCatalog(path.join(appDataRoot, name))))
  if (!forceRefresh && cached[1].length) return cached
  const config = await readJson(path.join(appDataRoot, 'config.json'), 'config').catch(() => null)
  const region = config?.region || process.env.AILY_REGION || 'cn'
  const resource = config?.regions?.[region]?.resource
    || (region === 'cn' ? 'https://blockly.yiyu.pro' : 'https://rs1.aily.pro')
  return Promise.all(names.map(async (name, index) => {
    try {
      const response = await fetchImpl(`${resource.replace(/\/+$/u, '')}/${name}`, {
        signal: globalThis.AbortSignal.any([signal, globalThis.AbortSignal.timeout(30_000)].filter(Boolean)),
      })
      if (!response.ok) throw new Error(`Blockly catalog download failed (${response.status})`)
      const catalog = normalizeCatalogArray(await response.json())
      if (!catalog.length) throw new Error(`Invalid Blockly catalog: ${name}`)
      const temporary = await mkdtemp(path.join(appDataRoot, '.aily-library-catalog-'))
      try {
        const staged = path.join(temporary, name)
        await writeFile(staged, JSON.stringify(index === 0 ? { libraries: catalog } : catalog))
        await rename(staged, path.join(appDataRoot, name))
      } finally {
        await rm(temporary, { recursive: true, force: true })
      }
      return catalog
    } catch (error) {
      signal?.throwIfAborted()
      if (cached[index].length || index === 0) return cached[index]
      throw error
    }
  }))
}

async function managedBlocklyRoots(projectRoot, packageName) {
  const root = path.join(projectRoot, 'sketch', 'libraries')
  // Read paths only within the persistent project, including for status/removal.
  if (await pathExists(root) && await realpath(root) !== root) {
    throw new ComponentLibraryError('BLOCKLY_LIBRARY_PATH_CONFLICT', 'sketch/libraries must not be a symbolic link')
  }
  const roots = []
  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() || !isSafeComponentLibraryDirectoryName(entry.name)) continue
    const directory = path.join(root, entry.name)
    const receiptFile = path.join(directory, BLOCKLY_LIBRARY_RECEIPT)
    const receiptStat = await lstat(receiptFile).catch(() => null)
    if (!receiptStat?.isFile() || receiptStat.isSymbolicLink()) continue
    const receipt = await readJson(receiptFile, 'library receipt').catch(() => null)
    if (receipt?.source !== 'blockly-library' || !isSafeBlocklyLibraryPackageName(receipt.packageName)
      || (packageName && receipt.packageName !== packageName)) continue
    if (receipt.libraryRoot !== entry.name || !Array.isArray(receipt.libraryRoots)
      || !receipt.libraryRoots.includes(entry.name) || !receipt.version || !receipt.fingerprint) {
      if (!packageName) continue
      throw new ComponentLibraryError('BLOCKLY_LIBRARY_PROVENANCE_CONFLICT', `Invalid library receipt: ${entry.name}`)
    }
    roots.push({ folderName: entry.name, directory, receipt })
  }
  return roots
}

function hasLegacyBlocklySourceWrapper(root) {
  return root.folderName === 'src' && root.receipt.sourceLayoutVersion !== BLOCKLY_LIBRARY_SOURCE_LAYOUT_VERSION
}

function completeBlocklyRoots(roots, version, allRoots = roots, requireCurrentLayout = false) {
  const names = roots.map(root => root.folderName).sort()
  return names.length > 0 && roots.every(root => root.receipt.version === version
    && (!requireCurrentLayout || !hasLegacyBlocklySourceWrapper(root))
    && JSON.stringify([...root.receipt.libraryRoots].sort()) === JSON.stringify(names)
    && (root.receipt.dependencyLibraries ?? []).every(dependency => {
      const dependencyRoots = allRoots.filter(item => item.receipt.packageName === dependency.packageName)
      return dependencyRoots.length > 0 && dependencyRoots.every(item => item.receipt.version === dependency.version
        && (!requireCurrentLayout || !hasLegacyBlocklySourceWrapper(item)))
        && JSON.stringify(dependencyRoots.map(item => item.folderName).sort()) === JSON.stringify([...dependency.libraryRoots].sort())
    }))
}

async function assertUnmodifiedBlocklyRoots(roots) {
  for (const root of roots) {
    const fingerprint = await fingerprintLibraryTree(root.directory, new Set([BLOCKLY_LIBRARY_RECEIPT]))
    if (fingerprint !== root.receipt.fingerprint) {
      throw new ComponentLibraryError('BLOCKLY_LIBRARY_PROVENANCE_CONFLICT',
        `sketch/libraries/${root.folderName} has local changes; preserve them before replacing or removing the library`)
    }
  }
}

async function inspectPackageInstallation(projectRoot, projectManifest, packageName) {
  const dependency = directDependencySpec(projectManifest, packageName)
  if (!dependency) return { managed: false, ready: false, version: '', roots: [] }
  const directory = packagePath(projectRoot, packageName)
  const installed = await readJson(path.join(directory, 'package.json'), 'library package').catch(() => null)
  if (installed?.name !== packageName || !installed.version) {
    return { managed: false, ready: false, version: '', roots: [] }
  }
  const sourcePackages = await collectBlocklySourcePackages(projectRoot, directory, installed, false).catch(() => [])
  const roots = []
  for (const sourcePackage of sourcePackages) {
    if (!await pathExists(sourcePackage.sourceDirectory)) continue
    const resolved = await packageLocalRoots(projectRoot, sourcePackage, {}, false).catch(() => ({ roots: [] }))
    roots.push(...resolved.roots)
  }
  return { managed: true, ready: roots.length > 0, version: installed.version, roots }
}

export async function searchBlocklyLibraryPackages(options) {
  const official = options.source === 'registry'
  const matchesSource = name => (official ? CODER_LIBRARY_PACKAGE : BLOCKLY_LIBRARY_PACKAGE).test(name)
  const projectRoot = await resolveWorkspaceRoot(options.workspaceRoot)
  const appDataRoot = await resolveAppDataRoot(options.appDataPath)
  const projectManifest = await readJson(path.join(projectRoot, 'package.json'), 'package.json')
  const declaredPackages = { ...projectManifest.dependencies, ...projectManifest.devDependencies, ...projectManifest.optionalDependencies }
  const allRoots = await managedBlocklyRoots(projectRoot)
  const legacyInstalled = await listInstalledComponentLibraries(path.join(projectRoot, 'sketch', 'libraries'))
  let catalogState = {}
  const [[index, legacy], sdkRoots] = await Promise.all([
    (official
      ? loadCoderPackageCatalog(appDataRoot, options).then(result => {
        catalogState = { indexUrl: result.indexUrl, stale: result.stale }
        return [[], result.libraries]
      })
      : sharedBlocklyCatalog(appDataRoot, options)).catch(error => {
      options.signal?.throwIfAborted()
      if (Object.keys(declaredPackages).some(matchesSource)
        || allRoots.some(root => matchesSource(root.receipt.packageName)) || [...legacyInstalled.values()]
        .some(item => item.receipt?.source === (official ? 'arduino-library-manager' : 'aily-coder-index'))) {
        catalogState = { stale: true }
        return [[], []]
      }
      throw error
    }),
    resolveSdkRoots(projectRoot, appDataRoot).catch(() => []),
  ])
  const activeArchitectures = activeArduinoArchitectures(sdkRoots)
  const boardPackage = findBoardPackageName(projectManifest)
  const board = boardPackage
    ? await readJson(path.join(packagePath(projectRoot, boardPackage), 'board.json'), 'board.json').catch(() => null) : null
  // Blockly compatibility.core contains platform IDs and sometimes full board IDs.
  // Preserve their specificity instead of reducing every entry to an architecture.
  for (const value of [board?.core, board?.type, projectManifest.fqbn]) {
    if (typeof value !== 'string' || !value.includes(':')) continue
    const normalized = value.toLocaleLowerCase('en')
    activeArchitectures.add(normalized)
    activeArchitectures.add(normalized.split(':').slice(0, 2).join(':'))
  }
  const catalog = [...legacy]
  const known = new Set(catalog.map(item => toBlocklyPackageName(item.name)))
  for (const root of allRoots) {
    if (!matchesSource(root.receipt.packageName)) continue
    if (known.has(root.receipt.packageName)) continue
    known.add(root.receipt.packageName)
    catalog.push({ name: root.receipt.packageName, nickname: root.receipt.name || root.folderName, version: root.receipt.version })
  }
  for (const packageName of Object.keys(declaredPackages).filter(matchesSource)) {
    if (known.has(packageName)) continue
    const installed = await readJson(path.join(packagePath(projectRoot, packageName), 'package.json'), 'library package').catch(() => null)
    if (installed?.name !== packageName || !installed.version) continue
    known.add(packageName)
    catalog.push({ name: packageName, nickname: installed.nickname || packageName, version: installed.version })
  }
  const indexed = new Map(index.map(item => [toBlocklyPackageName(item.name), item]))
  const tokens = String(options.query ?? '').normalize('NFKC').trim().toLocaleLowerCase('en').split(/[\s,，]+/u).filter(Boolean)
  const libraries = []
  for (const item of catalog) {
    const packageName = toBlocklyPackageName(item.name)
    if (!packageName || !matchesSource(packageName) || !item.version) continue
    const metadata = indexed.get(packageName) ?? {}
    const scored = scoreCatalogItem({ ...item, ...metadata }, tokens,
      [...BLOCKLY_INDEX_LIBRARY_FIELDS, ...BLOCKLY_LEGACY_LIBRARY_FIELDS])
    const identity = packageLibraryIdentity(packageName)
    const exactPackage = tokens.length === 1 && [packageName.toLocaleLowerCase('en'), identity.libraryRef.toLocaleLowerCase('en')].includes(tokens[0])
    if (exactPackage) scored.totalScore += 1000
    const architectures = metadata.supportedCores ?? item.architectures ?? item.compatibility?.core ?? []
    const compatibility = compatibilityDetails({ architectures }, activeArchitectures)
    const packageState = await inspectPackageInstallation(projectRoot, projectManifest, packageName)
    const roots = packageState.roots
    const installedVersion = packageState.version
    const installed = packageState.managed
    const description = String(item.description ?? metadata.description ?? '')
    libraries.push({
      ...identity, packageName,
      tier: 'preferred', name: item.nickname || metadata.displayName || packageName,
      version: String(item.version), versions: [...new Set([installedVersion, String(item.version)].filter(Boolean))],
      description, sentence: description, paragraph: '', author: typeof item.author === 'string' ? item.author : item.author?.name || '',
      category: metadata.category || item.category || '',
      url: item.homepage || item.url || (typeof item.repository === 'string' ? item.repository : item.repository?.url) || '',
      architectures, types: item.types ?? [], license: item.license || '',
      dependencies: item.dependencies ?? {}, providesIncludes: item.providesIncludes ?? [],
      compatible: compatibility.compatible, compatibility,
      installed, ready: packageState.ready, installedVersion, managed: packageState.managed,
      folderName: roots[0]?.folderName ?? '',
      sourceDirectory: packageSourceDirectory(projectRoot, packageName, roots),
      libraryRoots: roots.map(root => relativeProjectPath(projectRoot, root.sourcePath)),
      localRoots: await localizedLibraryRoots(projectRoot, packageName),
      score: scored.totalScore,
    })
  }
  // Existing ZIP installations remain discoverable/removable after the source switch, even offline.
  for (const [name, installed] of legacyInstalled) {
    const receipt = installed.receipt
    if (receipt?.source !== (official ? 'arduino-library-manager' : 'aily-coder-index') || receipt.version !== installed.version
      || receipt.name?.toLocaleLowerCase('en') !== name
      || !(official ? /^arduino:.+$/u : /^coder:[a-f0-9]{24}$/u).test(receipt.libraryId)) continue
    if (tokens.length && !tokens.some(token => name.includes(token))) continue
    libraries.push({ id: receipt.libraryId, libraryRef: receipt.libraryId, source: official ? 'registry' : 'aily', tier: 'preferred',
      name: receipt.name, version: installed.version, versions: [installed.version], installedVersion: installed.version,
      installed: true, managed: true, folderName: installed.folderName, architectures: [], score: 1 })
  }
  libraries.sort((a, b) => Number(b.installed) - Number(a.installed) || b.score - a.score || a.name.localeCompare(b.name))
  const offset = Math.max(0, Number(options.offset) || 0)
  const limit = Math.min(50, Math.max(1, Number(options.limit) || 25))
  const exact = libraries.find(item => [item.name, item.packageName, item.libraryRef].some(value => value?.toLocaleLowerCase('en') === String(options.query ?? '').trim().toLocaleLowerCase('en')))
  const compatibleAlternatives = exact?.compatible === false
    ? libraries.filter(item => item.compatible && item.id !== exact.id && item.category === exact.category).slice(0, 3) : []
  const matched = libraries.filter(item => (!tokens.length || item.score > 0)
    && (!options.category || item.category === options.category)
    && (!options.type || item.types?.includes(options.type)))
  return { tier: 'preferred', libraries: matched.slice(offset, offset + limit), total: matched.length,
    offset, limit, activeArchitectures: [...activeArchitectures], compatibleAlternatives, ...catalogState,
    categories: [...new Set(libraries.map(item => item.category).filter(Boolean))].sort(),
    types: [...new Set(libraries.flatMap(item => item.types ?? []))].sort() }
}

async function ensureProjectDirectory(projectRoot, segments) {
  let directory = projectRoot
  for (const segment of segments) {
    directory = path.join(directory, segment)
    await mkdir(directory).catch(error => { if (error.code !== 'EEXIST') throw error })
    const info = await lstat(directory)
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new ComponentLibraryError('BLOCKLY_LIBRARY_PATH_CONFLICT', `Library path must be a real directory: ${directory}`)
    }
  }
  return directory
}

async function withBlocklyPackageTransaction(projectRoot, packageName, task) {
  await ensureProjectDirectory(projectRoot, ['node_modules', packageName.split('/')[0]])
  const packageRoot = packagePath(projectRoot, packageName)
  const temporaryRoot = await mkdtemp(path.join(projectRoot, '.aily-library-transaction-'))
  const snapshots = await Promise.all(['package.json', 'package-lock.json', 'npm-shrinkwrap.json', path.join('node_modules', '.package-lock.json')]
    .map(async name => ({ name, content: await readFile(path.join(projectRoot, name)).catch(error => {
      if (error.code === 'ENOENT') return null
      throw error
    }) })))
  const previous = await lstat(packageRoot).catch(() => null)
  try {
    if (previous?.isSymbolicLink()) {
      throw new ComponentLibraryError('BLOCKLY_LIBRARY_PATH_CONFLICT', 'A linked library package must be unlinked before installation')
    }
    if (previous) await cp(packageRoot, path.join(temporaryRoot, 'package'), { recursive: true })
    try {
      return await task(packageRoot)
    } catch (error) {
      await rm(packageRoot, { recursive: true, force: true })
      if (previous) await rename(path.join(temporaryRoot, 'package'), packageRoot)
      for (const snapshot of snapshots) {
        const target = path.join(projectRoot, snapshot.name)
        if (snapshot.content === null) await rm(target, { force: true })
        else await writeFile(target, snapshot.content)
      }
      throw error
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
}

function relativeProjectPath(projectRoot, target) {
  return path.relative(projectRoot, target).split(path.sep).join('/')
}

function packageSourceDirectory(projectRoot, packageName, roots) {
  const ownRoots = roots.filter(root => root.packageName === packageName)
  if (ownRoots.length === 1) return relativeProjectPath(projectRoot, ownRoots[0].sourcePath)
  if (ownRoots.length > 1) return path.posix.join('node_modules', packageName, 'src')
  if (roots.length === 1) return relativeProjectPath(projectRoot, roots[0].sourcePath)
  return ''
}

function blocklyInstallResult(projectRoot, packageName, version, roots, compatibility, alreadyInstalled) {
  const libraryRoots = roots.map(root => relativeProjectPath(projectRoot, root.sourcePath))
  const packageRoots = roots.filter(root => root.packageName === packageName)
  const packageDirectory = path.posix.join('node_modules', packageName)
  return { ...packageLibraryIdentity(packageName), packageName,
    version, installedVersion: version, installed: true, managed: true, ready: libraryRoots.length > 0, alreadyInstalled,
    packageJsonLinked: true, packageDirectory, archive: 'src.7z', sourceLayout: 'package-local',
    sourceDirectory: packageSourceDirectory(projectRoot, packageName, roots),
    libraryRoots, folderName: packageRoots[0]?.folderName ?? roots[0]?.folderName ?? '',
    localizable: true, compatible: compatibility.compatible, compatibility,
    compatibilityOverride: !compatibility.compatible,
    ...(!compatibility.compatible ? { compatibilityWarning: 'Installed despite an incompatible active Coder architecture' } : {}) }
}

/** Follow npm's nearest package resolution for both Aily and official Coder packages. */
async function collectBlocklySourcePackages(projectRoot, packageRoot, packageManifest, requireSource = true) {
  const packages = new Map()
  async function visit(directory, manifest, required) {
    const known = packages.get(manifest.name)
    if (known) {
      if (known.manifest.version !== manifest.version) {
        throw new ComponentLibraryError('BLOCKLY_LIBRARY_PATH_CONFLICT', `Multiple versions of ${manifest.name} cannot share one Coder library directory`)
      }
      return
    }
    if (packages.size >= 100) throw new ComponentLibraryError('BLOCKLY_LIBRARY_PACKAGE_INVALID', 'Too many Aily library dependencies')
    const archivePath = path.join(directory, 'src.7z')
    const sourceDirectory = path.join(directory, 'src')
    const hasArchive = await pathExists(archivePath)
    const sourceStat = await lstat(sourceDirectory).catch(() => null)
    if (sourceStat && (!sourceStat.isDirectory() || sourceStat.isSymbolicLink())) {
      throw new ComponentLibraryError('BLOCKLY_LIBRARY_PATH_CONFLICT', `${manifest.name} src must be a real directory`)
    }
    const hasSource = Boolean(sourceStat)
    if (required && !hasArchive && !hasSource) {
      throw new ComponentLibraryError('BLOCKLY_LIBRARY_ARCHIVE_MISSING', `${manifest.name} does not contain src or src.7z`)
    }
    packages.set(manifest.name, { directory, manifest, archivePath, sourceDirectory, hasArchive, hasSource })
    for (const name of Object.keys(manifest.dependencies ?? {})) {
      if (!isSafeBlocklyLibraryPackageName(name)) continue
      let parent = directory, resolved
      while (isPathInside(projectRoot, parent)) {
        const candidate = packagePath(parent, name)
        const dependency = await readJson(path.join(candidate, 'package.json'), 'library dependency').catch(() => null)
        if (dependency?.name === name) {
          const realDirectory = await realpath(candidate)
          if (!isPathInside(projectRoot, realDirectory)) {
            throw new ComponentLibraryError('BLOCKLY_LIBRARY_PATH_CONFLICT', `Library dependency escapes the project: ${name}`)
          }
          resolved = { directory: realDirectory, manifest: dependency }
          break
        }
        if (parent === projectRoot) break
        parent = path.dirname(parent)
      }
      if (!resolved) throw new ComponentLibraryError('BLOCKLY_LIBRARY_PACKAGE_INVALID', `Aily library dependency is not installed: ${name}`)
      await visit(resolved.directory, resolved.manifest, false)
    }
  }
  await visit(packageRoot, packageManifest, requireSource)
  return [...packages.values()].filter(item => item.hasArchive || item.hasSource)
}

/** Extract one package archive beside src.7z, atomically creating package-root/src. */
async function preparePackageLocalSource(sourcePackage, options) {
  const { archivePath, sourceDirectory, hasArchive } = sourcePackage
  if (await pathExists(sourceDirectory)) return false
  if (!hasArchive) return false
  const staging = await mkdtemp(path.join(sourcePackage.directory, '.aily-src-extract-'))
  try {
    if (options.extractArchive) await options.extractArchive({ archivePath, destination: staging, signal: options.signal })
    else await extractBlocklyLibraryArchive(archivePath, staging, options)
    await validateExtractedTree(staging)
    const entries = (await readdir(staging, { withFileTypes: true }))
      .filter(entry => !entry.name.startsWith('.'))
    if (entries.length === 0) {
      throw new ComponentLibraryError('BLOCKLY_LIBRARY_ARCHIVE_INVALID', 'src.7z contains no source files')
    }
    const nestedSource = entries.length === 1 && entries[0].name === 'src' && entries[0].isDirectory()
      ? path.join(staging, 'src')
      : staging
    options.signal?.throwIfAborted()
    await rename(nestedSource, sourceDirectory)
    return true
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

async function packageLocalRoots(projectRoot, sourcePackage, options, prepare) {
  const extracted = prepare ? await preparePackageLocalSource(sourcePackage, options) : false
  if (!await pathExists(sourcePackage.sourceDirectory)) return { extracted, roots: [] }
  const roots = await resolveBlocklyArchiveRoots(sourcePackage.sourceDirectory, sourcePackage.manifest, 'src')
  return { extracted, roots: roots.map(root => ({
    ...root,
    packageName: sourcePackage.manifest.name,
    version: sourcePackage.manifest.version,
  })) }
}

/** Prepare package-local sources for explicit installs and template dependencies. */
async function materializeBlocklyLibraryPackage(projectRoot, packageRoot, packageManifest, library, options) {
  const { name: packageName, version } = packageManifest
  // A package may be a catalog facade whose nested Aily dependency owns src.7z.
  const sourcePackages = await collectBlocklySourcePackages(projectRoot, packageRoot, packageManifest, false)
  const roots = []
  let extracted = false
  for (const sourcePackage of sourcePackages) {
    options.signal?.throwIfAborted()
    const prepared = await packageLocalRoots(projectRoot, sourcePackage, options, true)
    extracted ||= prepared.extracted
    roots.push(...prepared.roots)
  }
  if (roots.length === 0) {
    throw new ComponentLibraryError('BLOCKLY_LIBRARY_ARCHIVE_MISSING', `${packageName} has no compilable src or src.7z`)
  }
  const names = new Set()
  for (const root of roots) {
    if (names.has(root.folderName)) {
      throw new ComponentLibraryError('BLOCKLY_LIBRARY_PATH_CONFLICT', `Multiple npm libraries map to ${root.folderName}`)
    }
    names.add(root.folderName)
  }
  return blocklyInstallResult(projectRoot, packageName, version, roots, library.compatibility, !extracted)
}

/** Materialize already-installed template libraries without npm or catalog resolution. */
export async function materializeCoderProjectLibraries(options) {
  const projectRoot = await resolveWorkspaceRoot(options.workspaceRoot)
  return withWorkspaceMutationLock(projectRoot, async () => {
    const manifest = await readJson(path.join(projectRoot, 'package.json'), 'package.json')
    const dependencies = { ...manifest.dependencies, ...manifest.devDependencies, ...manifest.optionalDependencies }
    const packages = new Map()
    for (const name of Object.keys(dependencies).filter(isSafeBlocklyLibraryPackageName)) {
      const directory = packagePath(projectRoot, name)
      if (!await pathExists(directory) && name in (manifest.optionalDependencies ?? {})) continue
      const realDirectory = await realpath(directory)
      if (!isPathInside(projectRoot, realDirectory)) {
        throw new ComponentLibraryError('BLOCKLY_LIBRARY_PATH_CONFLICT', `Library dependency escapes the project: ${name}`)
      }
      const installed = await readJson(path.join(realDirectory, 'package.json'), 'library package')
      if (installed.name !== name || !installed.version) {
        throw new ComponentLibraryError('BLOCKLY_LIBRARY_PACKAGE_INVALID', `Installed library identity/version is invalid: ${name}`)
      }
      // Packages without source may still depend on packages that contain Coder source.
      for (const item of await collectBlocklySourcePackages(projectRoot, realDirectory, installed, false)) {
        const previous = packages.get(item.manifest.name)
        if (previous && previous.manifest.version !== item.manifest.version) {
          throw new ComponentLibraryError('BLOCKLY_LIBRARY_PATH_CONFLICT', `Multiple versions of ${item.manifest.name} cannot share one Coder library directory`)
        }
        packages.set(item.manifest.name, item)
      }
    }
    const libraries = []
    for (const item of packages.values()) {
      options.signal?.throwIfAborted()
      libraries.push(await materializeBlocklyLibraryPackage(projectRoot, item.directory, item.manifest, {
        name: item.manifest.nickname || item.manifest.name,
        compatibility: { compatible: true },
      }, options))
    }
    return { ready: true, libraries, libraryRoots: [...new Set(libraries.flatMap(item => item.libraryRoots))] }
  })
}

export async function installBlocklyLibraryPackage(options) {
  const { packageName, version } = options
  if (!isSafeBlocklyLibraryPackageName(packageName) || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?$/u.test(version)) {
    throw new ComponentLibraryError('CODER_LIBRARY_REF_INVALID', 'Use the exact package and version from coder_library_search')
  }
  const projectRoot = await resolveWorkspaceRoot(options.workspaceRoot)
  return withWorkspaceMutationLock(projectRoot, async () => {
    const appDataPath = await resolveAppDataRoot(options.appDataPath)
    const search = await searchBlocklyLibraryPackages({ ...options, source: packageLibraryIdentity(packageName).source, query: packageName, appDataPath })
    const library = search.libraries.find(item => item.packageName === packageName && item.versions.includes(version))
    if (!library) throw new ComponentLibraryError('CODER_LIBRARY_NOT_FOUND', 'Library version was not found in its regional package catalog')
    if (!library.compatible && !options.allowIncompatible) {
      throw new ComponentLibraryError('CODER_LIBRARY_INCOMPATIBLE', `${library.name} is not compatible with the active Coder architecture`,
        { ...library.compatibility, compatibleAlternatives: search.compatibleAlternatives })
    }
    const manifest = await readJson(path.join(projectRoot, 'package.json'), 'package.json')
    const installedPackage = await readJson(path.join(packagePath(projectRoot, packageName), 'package.json'), 'library package').catch(() => null)
    if (installedPackage?.name === packageName && installedPackage.version === version && directDependencySpec(manifest, packageName)) {
      return materializeBlocklyLibraryPackage(projectRoot, packagePath(projectRoot, packageName), installedPackage, library, options)
    }
    return withBlocklyPackageTransaction(projectRoot, packageName, async packageRoot => {
      await runNpmLibraryCommand(projectRoot, ['install', `${packageName}@${version}`, '--save', '--save-exact',
        '--ignore-scripts', '--no-audit', '--no-fund'], { ...options, appDataPath })
      const packageManifest = await readJson(path.join(packageRoot, 'package.json'), 'library package')
      const linked = await readJson(path.join(projectRoot, 'package.json'), 'package.json')
      if (packageManifest.name !== packageName || packageManifest.version !== version || !directDependencySpec(linked, packageName)) {
        throw new ComponentLibraryError('BLOCKLY_LIBRARY_PACKAGE_INVALID', 'Installed package identity/version or root dependency does not match the request')
      }
      return materializeBlocklyLibraryPackage(projectRoot, packageRoot, packageManifest, library, options)
    })
  })
}

export async function removeBlocklyLibraryPackage(options) {
  const { packageName, version } = options
  const projectRoot = await resolveWorkspaceRoot(options.workspaceRoot)
  return withWorkspaceMutationLock(projectRoot, async () => {
    const manifest = await readJson(path.join(projectRoot, 'package.json'), 'package.json')
    const installedPackage = await readJson(path.join(packagePath(projectRoot, packageName), 'package.json'), 'library package').catch(() => null)
    const allRoots = await managedBlocklyRoots(projectRoot)
    const roots = allRoots.filter(root => root.receipt.packageName === packageName)
    if (!directDependencySpec(manifest, packageName) || installedPackage?.name !== packageName || installedPackage.version !== version) {
      // Preserve removal compatibility for installations created by the old sketch/libraries materializer.
      if (!completeBlocklyRoots(roots.map(root => ({ ...root, receipt: { ...root.receipt, dependencyLibraries: [] } })), version)) {
        throw new ComponentLibraryError('BLOCKLY_LIBRARY_PROVENANCE_CONFLICT', 'Removal requires the exact installed package version')
      }
    }
    if (installedPackage?.version && installedPackage.version !== version) {
      throw new ComponentLibraryError('BLOCKLY_LIBRARY_PROVENANCE_CONFLICT', 'Removal requires the exact installed version and all managed source roots')
    }
    await assertUnmodifiedBlocklyRoots(roots)
    const staging = await mkdtemp(path.join(projectRoot, '.aily-library-remove-'))
    const moved = []
    try {
      await withBlocklyPackageTransaction(projectRoot, packageName, async () => {
        for (const root of roots) {
          const backup = path.join(staging, root.folderName)
          await rename(root.directory, backup)
          moved.push({ original: root.directory, backup })
        }
        await runNpmLibraryCommand(projectRoot, ['uninstall', packageName, '--ignore-scripts', '--no-audit', '--no-fund'], options)
      })
      return { ...packageLibraryIdentity(packageName), packageName, version,
        removed: true, installed: false, managed: false, installedVersion: '',
        libraryRoots: [], preservedLocalRoots: await localizedLibraryRoots(projectRoot, packageName) }
    } catch (error) {
      for (const backup of moved) await rename(backup.backup, backup.original)
      throw error
    } finally {
      await rm(staging, { recursive: true, force: true })
    }
  })
}

async function localizedLibraryRoots(projectRoot, packageName) {
  const librariesRoot = path.join(projectRoot, 'sketch', 'libraries')
  const roots = []
  for (const entry of await readdir(librariesRoot, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue
    const receipt = await readJson(path.join(librariesRoot, entry.name, CODER_LOCAL_LIBRARY_RECEIPT), 'local library receipt').catch(() => null)
    if (receipt?.sourcePackage === packageName || receipt?.ownerPackage === packageName) {
      roots.push(path.posix.join('sketch', 'libraries', entry.name))
    }
  }
  return roots.sort()
}

export async function localizeCoderLibrary(options) {
  const ref = parseCoderLibraryRef(options.libraryRef)
  if (!ref.packageName) {
    throw new ComponentLibraryError('CODER_LIBRARY_REF_INVALID', 'Only npm-backed Aily and Arduino official libraries can be localized')
  }
  const packageName = ref.packageName
  const version = String(options.version ?? '').trim()
  const projectRoot = await resolveWorkspaceRoot(options.workspaceRoot)
  return withWorkspaceMutationLock(projectRoot, async () => {
    const manifest = await readJson(path.join(projectRoot, 'package.json'), 'package.json')
    const packageRoot = packagePath(projectRoot, packageName)
    const packageManifest = await readJson(path.join(packageRoot, 'package.json'), 'library package')
    if (!directDependencySpec(manifest, packageName) || packageManifest.name !== packageName || packageManifest.version !== version) {
      throw new ComponentLibraryError('BLOCKLY_LIBRARY_PROVENANCE_CONFLICT', 'Localization requires the exact installed package version')
    }
    const prepared = await materializeBlocklyLibraryPackage(projectRoot, packageRoot, packageManifest, {
      name: packageManifest.nickname || packageName,
      compatibility: { compatible: true },
    }, options)
    const sourcePackages = await collectBlocklySourcePackages(projectRoot, packageRoot, packageManifest, false)
    const roots = []
    for (const sourcePackage of sourcePackages) {
      roots.push(...(await packageLocalRoots(projectRoot, sourcePackage, options, false)).roots)
    }
    const requestedRoot = String(options.libraryRoot ?? '').trim().replace(/\\/gu, '/')
    const selected = requestedRoot
      ? roots.filter(root => relativeProjectPath(projectRoot, root.sourcePath) === requestedRoot)
      : roots.length === 1 ? roots : []
    if (selected.length === 0) {
      throw new ComponentLibraryError('CODER_LIBRARY_ROOT_INVALID', roots.length > 1
        ? 'libraryRoot is required when the installed package exposes multiple libraryRoots'
        : 'libraryRoot must be copied exactly from the installed libraryRoots')
    }
    const librariesRoot = await ensureProjectDirectory(projectRoot, ['sketch', 'libraries'])
    const localRoots = []
    for (const root of selected) {
      const target = path.join(librariesRoot, root.folderName)
      const existing = await lstat(target).catch(() => null)
      if (existing) {
        const oldReceipt = await readJson(path.join(target, BLOCKLY_LIBRARY_RECEIPT), 'legacy library receipt').catch(() => null)
        const localReceipt = await readJson(path.join(target, CODER_LOCAL_LIBRARY_RECEIPT), 'local library receipt').catch(() => null)
        if (localReceipt?.sourcePackage === root.packageName) {
          localRoots.push(path.posix.join('sketch', 'libraries', root.folderName))
          continue
        }
        if (oldReceipt?.packageName === root.packageName) {
          await rm(path.join(target, BLOCKLY_LIBRARY_RECEIPT), { force: true })
          await writeFile(path.join(target, CODER_LOCAL_LIBRARY_RECEIPT), JSON.stringify({
            source: 'aily-chat', ownerPackage: packageName, sourcePackage: root.packageName,
            sourceVersion: oldReceipt.version || root.version,
            sourceLibraryRoot: relativeProjectPath(projectRoot, root.sourcePath),
          }, null, 2))
          localRoots.push(path.posix.join('sketch', 'libraries', root.folderName))
          continue
        }
        throw new ComponentLibraryError('BLOCKLY_LIBRARY_PATH_CONFLICT', `sketch/libraries/${root.folderName} already exists as an independent local library`)
      }
      const staging = await mkdtemp(path.join(librariesRoot, '.aily-localize-'))
      const stagedRoot = path.join(staging, root.folderName)
      try {
        await copyDirectoryWithoutLinks(root.sourcePath, stagedRoot)
        await writeFile(path.join(stagedRoot, CODER_LOCAL_LIBRARY_RECEIPT), JSON.stringify({
          source: 'aily-chat', ownerPackage: packageName, sourcePackage: root.packageName, sourceVersion: root.version,
          sourceLibraryRoot: relativeProjectPath(projectRoot, root.sourcePath),
        }, null, 2))
        options.signal?.throwIfAborted()
        await rename(stagedRoot, target)
      } finally {
        await rm(staging, { recursive: true, force: true })
      }
      localRoots.push(path.posix.join('sketch', 'libraries', root.folderName))
    }
    return { ...prepared, localized: true, localRoots, libraryRoot: requestedRoot || undefined }
  })
}
