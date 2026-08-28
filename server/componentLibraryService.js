import { constants as fsConstants } from 'node:fs'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
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
  stat,
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
const BLOCKLY_LIBRARY_RECEIPT = '.aily-blockly-library.json'
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

export function isSafeBlocklyLibraryPackageName(value) {
  return BLOCKLY_LIBRARY_PACKAGE.test(String(value ?? ''))
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

async function ailyNpmEnvironment() {
  const env = { ...process.env }
  const appNpmrcPath = path.join(defaultAilyAppDataPath(), '.npmrc')
  if (!String(env.NPM_CONFIG_USERCONFIG ?? '').trim() && await pathExists(appNpmrcPath)) {
    env.NPM_CONFIG_USERCONFIG = appNpmrcPath
  }
  if (!String(env.AILY_NPM_REGISTRY ?? '').trim() && await pathExists(appNpmrcPath)) {
    const npmrc = await readFile(appNpmrcPath, 'utf8').catch(() => '')
    const scopedRegistry = npmrc.match(/^@aily-project:registry\s*=\s*(\S+)\s*$/imu)?.[1]
    if (scopedRegistry) env.AILY_NPM_REGISTRY = scopedRegistry
  }
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

async function runNpmLibraryCommand(projectRoot, args, { signal, runNpmCommand } = {}) {
  if (runNpmCommand) {
    return runNpmCommand({ projectRoot, args, signal })
  }
  return runProcess(npmExecutable(), args, {
    cwd: projectRoot,
    signal,
    env: await ailyNpmEnvironment(),
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
    || /^[A-Za-z]:\//u.test(normalized)
    || segments.some(segment => !segment || segment === '.' || segment === '..')
    || (segments[0] !== 'src')
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
  if (/\bL\b/u.test(String(record.Attributes ?? ''))) {
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

async function resolveBlocklyArchiveRoots(extractionRoot, packageManifest) {
  const sourceRoot = path.join(extractionRoot, 'src')
  const sourceStat = await lstat(sourceRoot).catch(() => null)
  if (!sourceStat?.isDirectory() || sourceStat.isSymbolicLink()) {
    throw new ComponentLibraryError(
      'BLOCKLY_LIBRARY_ARCHIVE_INVALID',
      'src.7z must contain a top-level src directory',
    )
  }
  await validateExtractedTree(sourceRoot)
  const entries = await readdir(sourceRoot, { withFileTypes: true })
  if (entries.length === 0) {
    throw new ComponentLibraryError('BLOCKLY_LIBRARY_ARCHIVE_INVALID', 'src.7z contains an empty src directory')
  }
  const directFiles = entries.filter(entry => !entry.isDirectory())
  if (directFiles.length > 0) {
    return [{
      folderName: fallbackLibraryRootName(packageManifest),
      relativePath: 'src',
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
      relativePath: path.posix.join('src', entry.name),
      sourcePath: path.join(sourceRoot, entry.name),
    }
  })
}

async function readBlocklyLibraryReceipt(directory) {
  const receiptPath = path.join(directory, BLOCKLY_LIBRARY_RECEIPT)
  if (!await pathExists(receiptPath)) return null
  try {
    return JSON.parse(await readFile(receiptPath, 'utf8'))
  } catch {
    throw new ComponentLibraryError(
      'BLOCKLY_LIBRARY_PROVENANCE_CONFLICT',
      `${path.basename(directory)} has invalid Blockly library provenance metadata`,
    )
  }
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

async function resolvedBlocklySourceRoot(projectRoot, packageName) {
  let sourceRoot = path.join(packagePath(projectRoot, packageName), 'src')
  const sourceStat = await stat(sourceRoot).catch(() => null)
  if (!sourceStat?.isDirectory()) return ''
  const entries = await readdir(sourceRoot, { withFileTypes: true })
  if (entries.length === 1 && entries[0].name === 'src' && entries[0].isDirectory()) {
    sourceRoot = path.join(sourceRoot, 'src')
  }
  return sourceRoot
}

async function readBlocklyLibraryCache(projectRoot) {
  const cachePath = path.join(projectRoot, 'sketch', 'library-cache.json')
  if (!await pathExists(cachePath)) return { cachePath, cache: {} }
  try {
    const cache = JSON.parse(await readFile(cachePath, 'utf8'))
    if (!cache || Array.isArray(cache) || typeof cache !== 'object') throw new Error('invalid cache')
    return { cachePath, cache }
  } catch {
    throw new ComponentLibraryError(
      'BLOCKLY_LIBRARY_PROVENANCE_CONFLICT',
      'sketch/library-cache.json has invalid Blockly library provenance metadata',
    )
  }
}

async function cachedBlocklyLibraryRoots(projectRoot, packageName) {
  const { cache } = await readBlocklyLibraryCache(projectRoot)
  const cached = cache[packageName]
  if (!cached) return new Set()
  if (!Array.isArray(cached.targetNames)) {
    throw new ComponentLibraryError(
      'BLOCKLY_LIBRARY_PROVENANCE_CONFLICT',
      `${packageName} has invalid library-cache target metadata`,
    )
  }
  const targetNames = [...new Set(cached.targetNames)]
  if (targetNames.some(name => !isSafeComponentLibraryDirectoryName(name))) {
    throw new ComponentLibraryError(
      'BLOCKLY_LIBRARY_PROVENANCE_CONFLICT',
      `${packageName} has an unsafe library-cache target`,
    )
  }
  const sourceRoot = await resolvedBlocklySourceRoot(projectRoot, packageName)
  const librariesRoot = path.join(projectRoot, 'sketch', 'libraries')
  const packageFolderName = packageName.split('/').at(-1)
  const managed = new Set()
  for (const targetName of targetNames) {
    const targetPath = path.join(librariesRoot, targetName)
    const targetStat = await stat(targetPath).catch(() => null)
    if (!targetStat?.isDirectory()) continue
    if (!sourceRoot) {
      throw new ComponentLibraryError(
        'BLOCKLY_LIBRARY_PROVENANCE_CONFLICT',
        `Cannot verify sketch/libraries/${targetName} against ${packageName}`,
      )
    }
    const nestedSource = path.join(sourceRoot, targetName)
    const nestedStat = await stat(nestedSource).catch(() => null)
    const sourcePath = nestedStat?.isDirectory()
      ? nestedSource
      : targetName === packageFolderName
        ? sourceRoot
        : ''
    if (!sourcePath) {
      throw new ComponentLibraryError(
        'BLOCKLY_LIBRARY_PROVENANCE_CONFLICT',
        `sketch/libraries/${targetName} does not match ${packageName} source layout`,
      )
    }
    const [sourceFingerprint, targetFingerprint] = await Promise.all([
      fingerprintLibraryTree(sourcePath),
      fingerprintLibraryTree(targetPath, new Set([BLOCKLY_LIBRARY_RECEIPT])),
    ])
    if (sourceFingerprint !== targetFingerprint) {
      throw new ComponentLibraryError(
        'BLOCKLY_LIBRARY_PROVENANCE_CONFLICT',
        `sketch/libraries/${targetName} differs from ${packageName}; refusing to replace or remove it`,
      )
    }
    managed.add(targetName)
  }
  return managed
}

async function collectManagedBlocklyLibraryRoots(projectRoot, packageName) {
  const librariesRoot = path.join(projectRoot, 'sketch', 'libraries')
  const managed = await cachedBlocklyLibraryRoots(projectRoot, packageName)
  for (const entry of await readdir(librariesRoot, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() || !isSafeComponentLibraryDirectoryName(entry.name)) continue
    const receipt = await readBlocklyLibraryReceipt(path.join(librariesRoot, entry.name))
    if (!receipt || receipt.packageName !== packageName) continue
    if (receipt.source !== 'blockly-library' || receipt.libraryRoot !== entry.name) {
      throw new ComponentLibraryError(
        'BLOCKLY_LIBRARY_PROVENANCE_CONFLICT',
        `sketch/libraries/${entry.name} has conflicting Blockly library provenance metadata`,
      )
    }
    managed.add(entry.name)
  }
  return managed
}

async function removeBlocklyLibraryCacheEntry(projectRoot, packageName) {
  const { cachePath, cache } = await readBlocklyLibraryCache(projectRoot)
  if (!Object.hasOwn(cache, packageName)) return
  delete cache[packageName]
  const temporaryPath = `${cachePath}.aily-${process.pid}-${Date.now()}`
  await writeFile(temporaryPath, `${JSON.stringify(cache, null, 2)}\n`)
  await rename(temporaryPath, cachePath)
}

function workspaceRelativePath(projectRoot, targetPath) {
  return path.relative(projectRoot, targetPath).split(path.sep).join('/')
}

async function installBlocklyPackageSource({
  packageRoot,
  packageManifest,
  archivePath,
  signal,
  sevenZipPath,
  extractArchive,
}) {
  const temporaryRoot = await mkdtemp(path.join(packageRoot, '.aily-src-install-'))
  const targetSourceRoot = path.join(packageRoot, 'src')
  let backupSourceRoot = ''
  try {
    const extractionRoot = path.join(temporaryRoot, 'extracted')
    if (extractArchive) {
      await extractArchive({ archivePath, destination: extractionRoot, signal })
    } else {
      await extractBlocklyLibraryArchive(archivePath, extractionRoot, { signal, sevenZipPath })
    }
    const roots = await resolveBlocklyArchiveRoots(extractionRoot, packageManifest)
    const extractedSourceRoot = path.join(extractionRoot, 'src')
    if (await pathExists(targetSourceRoot)) {
      backupSourceRoot = path.join(temporaryRoot, 'previous-src')
      await rename(targetSourceRoot, backupSourceRoot)
    }
    try {
      await rename(extractedSourceRoot, targetSourceRoot)
    } catch (error) {
      if (backupSourceRoot && await pathExists(backupSourceRoot)) {
        await rename(backupSourceRoot, targetSourceRoot)
        backupSourceRoot = ''
      }
      throw error
    }
    if (backupSourceRoot) {
      await rm(backupSourceRoot, { recursive: true, force: true })
      backupSourceRoot = ''
    }
    return roots
  } finally {
    if (backupSourceRoot && !await pathExists(targetSourceRoot) && await pathExists(backupSourceRoot)) {
      await rename(backupSourceRoot, targetSourceRoot).catch(() => undefined)
    }
    await rm(temporaryRoot, { recursive: true, force: true })
  }
}

async function removeLegacyBlocklyLibraryProjection(projectRoot, packageName) {
  const librariesRoot = path.join(projectRoot, 'sketch', 'libraries')
  const managedRoots = [...await collectManagedBlocklyLibraryRoots(projectRoot, packageName)]
    .sort((left, right) => left.localeCompare(right))
  for (const folderName of managedRoots) {
    await rm(path.join(librariesRoot, folderName), { recursive: true, force: false })
  }
  await removeBlocklyLibraryCacheEntry(projectRoot, packageName)
  return managedRoots
}

export async function installBlocklyLibraryPackage({
  workspaceRoot,
  packageName,
  version,
  signal,
  sevenZipPath,
  runNpmCommand,
  extractArchive,
}) {
  if (!isSafeBlocklyLibraryPackageName(packageName)) {
    throw new ComponentLibraryError(
      'BLOCKLY_LIBRARY_PACKAGE_INVALID',
      'packageName must be an exact @aily-project/lib-* result from coder_library_search',
    )
  }
  return withWorkspaceMutationLock(workspaceRoot, async () => {
    const projectRoot = await resolveWorkspaceRoot(workspaceRoot)
    const projectManifest = await readJson(path.join(projectRoot, 'package.json'), 'package.json')
    const previousDependency = directDependencySpec(projectManifest, packageName)
    const previousInstalledManifest = previousDependency
      ? await readJson(
        path.join(packagePath(projectRoot, packageName), 'package.json'),
        `${packageName} package.json`,
      ).catch(() => null)
      : null
    let npmInstalled = false
    try {
      await runNpmLibraryCommand(
        projectRoot,
        [
          'install',
          version ? `${packageName}@${version}` : packageName,
          '--save',
          '--save-exact',
          '--ignore-scripts',
          '--no-audit',
          '--no-fund',
        ],
        { signal, runNpmCommand },
      )
      npmInstalled = true
      const packageRoot = packagePath(projectRoot, packageName)
      const packageManifest = await readJson(path.join(packageRoot, 'package.json'), `${packageName} package.json`)
      if (packageManifest.name !== packageName || !String(packageManifest.version ?? '').trim()) {
        throw new ComponentLibraryError('BLOCKLY_LIBRARY_PACKAGE_INVALID', `${packageName} has invalid package metadata`)
      }
      const archivePath = path.join(packageRoot, 'src.7z')
      if (!await pathExists(archivePath)) {
        throw new ComponentLibraryError('BLOCKLY_LIBRARY_ARCHIVE_MISSING', `${packageName} does not contain src.7z`)
      }
      const linkedManifest = await readJson(path.join(projectRoot, 'package.json'), 'package.json')
      if (!directDependencySpec(linkedManifest, packageName)) {
        throw new ComponentLibraryError(
          'BLOCKLY_LIBRARY_PACKAGE_INVALID',
          `${packageName} was installed without linking the root package.json dependency`,
        )
      }
      const roots = await installBlocklyPackageSource({
        packageRoot,
        packageManifest,
        archivePath,
        signal,
        sevenZipPath,
        extractArchive,
      })
      const removedLegacyRoots = await removeLegacyBlocklyLibraryProjection(projectRoot, packageName)
      const packageDirectory = workspaceRelativePath(projectRoot, packageRoot)
      const sourceDirectory = path.posix.join(packageDirectory, 'src')
      return {
        source: 'blockly-library',
        packageName,
        version: packageManifest.version,
        installed: true,
        ready: true,
        packageJsonLinked: true,
        packageDirectory,
        sourceDirectory,
        archive: 'src.7z',
        libraryRoots: roots.map(root => path.posix.join(packageDirectory, root.relativePath)),
        removedLegacyRoots,
        alreadyInstalled: previousInstalledManifest?.version === packageManifest.version,
      }
    } catch (error) {
      if (npmInstalled && !previousDependency) {
        await runNpmLibraryCommand(
          projectRoot,
          ['uninstall', packageName, '--ignore-scripts'],
          { runNpmCommand },
        ).catch(() => undefined)
      }
      throw error
    }
  })
}

export async function removeBlocklyLibraryPackage({
  workspaceRoot,
  packageName,
  signal,
  runNpmCommand,
}) {
  if (!isSafeBlocklyLibraryPackageName(packageName)) {
    throw new ComponentLibraryError(
      'BLOCKLY_LIBRARY_PACKAGE_INVALID',
      'packageName must be an exact @aily-project/lib-* package name',
    )
  }
  return withWorkspaceMutationLock(workspaceRoot, async () => {
    const projectRoot = await resolveWorkspaceRoot(workspaceRoot)
    const projectManifest = await readJson(path.join(projectRoot, 'package.json'), 'package.json')
    const dependency = directDependencySpec(projectManifest, packageName)
    if (!dependency) {
      return {
        source: 'blockly-library',
        packageName,
        removed: false,
        alreadyRemoved: true,
        packageJsonLinked: false,
        libraryRoots: [],
      }
    }

    const librariesRoot = path.join(projectRoot, 'sketch', 'libraries')
    await mkdir(librariesRoot, { recursive: true })
    const managedRoots = await collectManagedBlocklyLibraryRoots(projectRoot, packageName)
    const packageRoot = packagePath(projectRoot, packageName)
    const packageManifest = await readJson(
      path.join(packageRoot, 'package.json'),
      `${packageName} package.json`,
    ).catch(() => ({ name: packageName }))
    const packageRoots = await resolveBlocklyArchiveRoots(packageRoot, packageManifest).catch(() => [])
    const packageDirectory = workspaceRelativePath(projectRoot, packageRoot)
    const sourceDirectory = path.posix.join(packageDirectory, 'src')
    const candidates = [...managedRoots]
      .sort((left, right) => left.localeCompare(right))
      .map(folderName => ({
        folderName,
        targetPath: path.join(librariesRoot, folderName),
      }))

    const temporaryRoot = await mkdtemp(path.join(librariesRoot, '.aily-blockly-remove-'))
    const staged = []
    try {
      for (const candidate of candidates) {
        const stagedPath = path.join(temporaryRoot, candidate.folderName)
        await rename(candidate.targetPath, stagedPath)
        staged.push({ ...candidate, stagedPath })
      }
      try {
        await runNpmLibraryCommand(
          projectRoot,
          ['uninstall', packageName, '--ignore-scripts'],
          { signal, runNpmCommand },
        )
      } catch (error) {
        for (const candidate of staged.reverse()) {
          await rename(candidate.stagedPath, candidate.targetPath)
        }
        throw error
      }
      const cacheCleaned = await removeBlocklyLibraryCacheEntry(projectRoot, packageName)
        .then(() => true, () => false)
      return {
        source: 'blockly-library',
        packageName,
        removed: true,
        alreadyRemoved: false,
        packageJsonLinked: false,
        packageDirectory,
        sourceDirectory,
        libraryRoots: packageRoots.map(root => path.posix.join(packageDirectory, root.relativePath)),
        removedLegacyRoots: candidates.map(candidate => candidate.folderName),
        cacheCleaned,
      }
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true })
    }
  })
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
  const packageName = raw.startsWith('@aily-project/') ? raw : `@aily-project/${raw}`
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

export async function searchBlocklyLibraryPackages({
  workspaceRoot,
  appDataPath,
  query,
  offset = 0,
  limit = 25,
}) {
  const projectRoot = await resolveWorkspaceRoot(workspaceRoot)
  const appDataRoot = await resolveAppDataRoot(appDataPath)
  const [index, legacy] = await Promise.all([
    readOptionalCatalog(path.join(appDataRoot, 'libraries-index.json')),
    readOptionalCatalog(path.join(appDataRoot, 'libraries.json')),
  ])
  const legacyByPackage = new Map(legacy.flatMap(item => {
    const packageName = toBlocklyPackageName(item?.name)
    return packageName ? [[packageName, item]] : []
  }))
  const tokens = String(query ?? '')
    .trim()
    .toLocaleLowerCase('en')
    .split(/[\s,，]+/u)
    .filter(Boolean)
  if (tokens.length === 0) {
    throw new ComponentLibraryError('BLOCKLY_LIBRARY_QUERY_REQUIRED', 'Search libraries requires a query')
  }
  const projectManifest = await readJson(path.join(projectRoot, 'package.json'), 'package.json')
  const results = []
  const useIndex = index.length > 0
  for (const item of useIndex ? index : legacy) {
    const packageName = toBlocklyPackageName(item?.name)
    if (!packageName) continue
    const legacyItem = legacyByPackage.get(packageName) ?? item
    const scored = scoreCatalogItem(
      item,
      tokens,
      useIndex ? BLOCKLY_INDEX_LIBRARY_FIELDS : BLOCKLY_LEGACY_LIBRARY_FIELDS,
    )
    const minimumScore = useIndex ? Number.EPSILON : scored.matchedQueries.length * 10
    if (scored.matchedQueries.length === 0 || scored.totalScore < minimumScore) continue
    const installedManifest = await readJson(
      path.join(packagePath(projectRoot, packageName), 'package.json'),
      `${packageName} package.json`,
    ).catch(() => null)
    results.push({
      id: `blockly:${packageName}`,
      libraryRef: `blockly:${packageName}`,
      tier: 'preferred',
      name: String(item?.displayName ?? legacyItem?.nickname ?? packageName),
      packageName,
      version: String(legacyItem?.version ?? installedManifest?.version ?? ''),
      description: String(item?.description ?? legacyItem?.description ?? ''),
      category: String(item?.category ?? ''),
      supportedCores: Array.isArray(item?.supportedCores) ? item.supportedCores : [],
      installed: Boolean(directDependencySpec(projectManifest, packageName)),
      installedVersion: String(installedManifest?.version ?? ''),
      score: scored.totalScore,
      matchedFields: scored.matchedFields,
      matchedQueries: scored.matchedQueries,
    })
  }
  results.sort((left, right) => (
    Number(right.installed) - Number(left.installed)
    || right.score - left.score
    || left.name.localeCompare(right.name)
  ))
  const normalizedOffset = Math.max(0, Number.isInteger(Number(offset)) ? Number(offset) : 0)
  const normalizedLimit = Math.min(50, Math.max(1, Number.isInteger(Number(limit)) ? Number(limit) : 25))
  return {
    tier: 'preferred',
    total: results.length,
    offset: normalizedOffset,
    limit: normalizedLimit,
    libraries: results.slice(normalizedOffset, normalizedOffset + normalizedLimit),
  }
}

export async function searchCoderLibraries({
  workspaceRoot,
  appDataPath,
  query,
  candidates = false,
  offset,
  limit,
  forceRefresh,
}) {
  if (!candidates) {
    return searchBlocklyLibraryPackages({ workspaceRoot, appDataPath, query, offset, limit })
  }
  const result = await searchArduinoComponentLibraries({
    workspaceRoot,
    appDataPath,
    query,
    offset,
    limit,
    forceRefresh,
  })
  const normalizedQuery = String(query ?? '').trim().toLocaleLowerCase('en')
  const libraries = result.libraries.map(library => ({
    ...library,
    libraryRef: library.id,
    tier: 'candidate',
  })).sort((left, right) => {
    const score = library => {
      const name = String(library.name ?? '').toLocaleLowerCase('en')
      if (name === normalizedQuery) return 300
      if (name.startsWith(normalizedQuery)) return 200
      if (name.includes(normalizedQuery)) return 100
      return 0
    }
    return Number(right.installed) - Number(left.installed)
      || Number(right.compatible) - Number(left.compatible)
      || score(right) - score(left)
      || String(left.name ?? '').localeCompare(String(right.name ?? ''))
  })
  return {
    ...result,
    tier: 'candidate',
    libraries,
  }
}

function parseCoderLibraryRef(libraryRef) {
  const value = String(libraryRef ?? '').trim()
  if (value.startsWith('blockly:')) {
    const packageName = value.slice('blockly:'.length)
    if (isSafeBlocklyLibraryPackageName(packageName)) return { source: 'blockly', packageName }
  }
  if (value.startsWith('arduino:') && value.length <= 160) {
    return { source: 'arduino', libraryId: value }
  }
  throw new ComponentLibraryError(
    'CODER_LIBRARY_REF_INVALID',
    'libraryRef must be copied exactly from coder_library_search',
  )
}

export async function installCoderLibrary(options) {
  const ref = parseCoderLibraryRef(options.libraryRef)
  if (ref.source === 'blockly') {
    return installBlocklyLibraryPackage({
      ...options,
      packageName: ref.packageName,
    })
  }
  if (!String(options.version ?? '').trim()) {
    throw new ComponentLibraryError('CODER_LIBRARY_VERSION_REQUIRED', 'Official Arduino candidates require an exact version')
  }
  return installArduinoComponentLibrary({
    workspaceRoot: options.workspaceRoot,
    appDataPath: options.appDataPath,
    libraryId: ref.libraryId,
    version: options.version,
  })
}

export async function removeCoderLibrary(options) {
  const ref = parseCoderLibraryRef(options.libraryRef)
  if (ref.source === 'blockly') {
    return removeBlocklyLibraryPackage({
      ...options,
      packageName: ref.packageName,
    })
  }
  if (!String(options.version ?? '').trim()) {
    throw new ComponentLibraryError('CODER_LIBRARY_VERSION_REQUIRED', 'Official Arduino candidates require an exact version')
  }
  return removeArduinoComponentLibrary({
    workspaceRoot: options.workspaceRoot,
    appDataPath: options.appDataPath,
    libraryId: ref.libraryId,
    version: options.version,
  })
}
