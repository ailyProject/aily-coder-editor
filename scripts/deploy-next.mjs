#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { cp, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const defaultArtifactRoot = packageRoot
const defaultCatalogPath = path.join(packageRoot, 'dist', 'subapp-index.json')
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const booleanOptions = new Set(['help', 'skip-build', 'skip-catalog-generate', 'unlink'])
const versionStoreSchema = 2

function parseArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--') continue
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg}`)
    const equalIndex = arg.indexOf('=')
    const key = equalIndex >= 0 ? arg.slice(2, equalIndex) : arg.slice(2)
    let value = equalIndex >= 0 ? arg.slice(equalIndex + 1) : true
    if (!booleanOptions.has(key) && equalIndex < 0 && argv[index + 1] && !argv[index + 1].startsWith('--')) {
      value = argv[++index]
    }
    options[key] = value
  }
  return options
}

function defaultAppDataPath() {
  if (process.env.AILY_APPDATA_PATH) return path.resolve(process.env.AILY_APPDATA_PATH)
  if (process.platform === 'win32') return path.join(os.homedir(), 'AppData', 'Local', 'aily-project')
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'aily-project')
  return path.join(os.homedir(), '.config', 'aily-project')
}

function resolveInstallRoot(options) {
  const configured = options['app-root'] || process.env.AILY_SUBAPP_INSTALL_ROOT
  return configured
    ? path.resolve(String(configured))
    : path.join(process.env.AILY_NPM_PREFIX
      ? path.resolve(process.env.AILY_NPM_PREFIX)
      : path.join(defaultAppDataPath(), 'npm-global'), 'app')
}

function nextVersion(version) {
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`Cannot create a local next version from ${String(version)}`)
  }
  return version.endsWith('-next') ? version : `${version}-next`
}

function storeKeyForPackage(packageName) {
  const value = String(packageName || '').split('/').at(-1)
  if (!value || !/^[a-z0-9][a-z0-9._-]*$/.test(value)) {
    throw new Error(`Invalid subapp package name: ${packageName}`)
  }
  return value
}

function packagePath(installRoot, packageName) {
  return path.join(installRoot, 'node_modules', ...packageName.split('/'))
}

async function statPath(filePath) {
  try {
    return await lstat(filePath)
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'))
}

async function writeJsonAtomic(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true })
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
  await rename(temporaryPath, filePath)
}

function sanitizedEnv() {
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (key.toLowerCase().replaceAll('-', '_') === 'npm_config_manage_package_manager_versions') delete env[key]
  }
  return env
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || packageRoot,
      env: sanitizedEnv(),
      shell: process.platform === 'win32',
      stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    if (options.capture) {
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', chunk => { stdout += chunk })
      child.stderr.on('data', chunk => { stderr += chunk })
    }
    child.once('error', reject)
    child.once('exit', code => {
      if (code === 0) resolve({ stdout, stderr })
      else reject(new Error(`${command} ${args.join(' ')} exited with code ${code}${stderr ? `\n${stderr}` : ''}`))
    })
  })
}

async function ensureInstallProject(installRoot) {
  await mkdir(installRoot, { recursive: true })
  const manifestPath = path.join(installRoot, 'package.json')
  if (!existsSync(manifestPath)) {
    await writeJsonAtomic(manifestPath, {
      name: 'aily-installed-subapps',
      private: true,
      version: '1.0.0',
      description: 'Aily Blockly user-installed child applications',
      dependencies: {},
    })
  }
}

async function npmPack(root, destination) {
  await mkdir(destination, { recursive: true })
  const result = await run(npmCommand, [
    'pack', root, '--ignore-scripts', '--json', '--pack-destination', destination,
  ], { capture: true })
  let summaries
  try {
    summaries = JSON.parse(result.stdout)
  } catch {
    throw new Error(`npm pack did not return JSON for ${root}\n${result.stdout}\n${result.stderr}`)
  }
  const fileName = summaries?.[0]?.filename
  if (typeof fileName !== 'string' || !fileName.endsWith('.tgz')) {
    throw new Error(`npm pack did not produce a tarball for ${root}`)
  }
  return path.join(destination, path.basename(fileName))
}

async function npmInstallTarball(tarball, consumerRoot, packageName) {
  await mkdir(consumerRoot, { recursive: true })
  await writeJsonAtomic(path.join(consumerRoot, 'package.json'), {
    name: 'aily-next-package-consumer', version: '0.0.0', private: true,
  })
  await run(npmCommand, [
    'install', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', tarball,
  ], { cwd: consumerRoot, capture: true })
  const installedRoot = path.join(consumerRoot, 'node_modules', ...packageName.split('/'))
  if (!existsSync(path.join(installedRoot, 'package.json'))) {
    throw new Error(`npm did not install ${packageName} from ${tarball}`)
  }
  return installedRoot
}

function assertSelfContained(manifest) {
  const runtimeDependencies = { ...manifest.dependencies, ...manifest.optionalDependencies }
  if (Object.keys(runtimeDependencies).length) {
    throw new Error('deploy:next requires the self-contained build:subapp artifact; runtime dependencies were found')
  }
}

async function materializeNextPackage(artifactRoot, packageName, sourceVersion, workRoot) {
  const sourceTarball = await npmPack(artifactRoot, path.join(workRoot, 'source-pack'))
  const sourceInstall = await npmInstallTarball(sourceTarball, path.join(workRoot, 'source-install'), packageName)
  const sourceManifestPath = path.join(sourceInstall, 'package.json')
  const sourceManifest = await readJson(sourceManifestPath)
  if (sourceManifest.name !== packageName || sourceManifest.version !== sourceVersion) {
    throw new Error(`Built artifact identity does not match ${packageName}@${sourceVersion}`)
  }
  assertSelfContained(sourceManifest)

  const version = nextVersion(sourceVersion)
  await writeJsonAtomic(sourceManifestPath, { ...sourceManifest, version })
  const nextTarball = await npmPack(sourceInstall, path.join(workRoot, 'next-pack'))
  const installedRoot = await npmInstallTarball(nextTarball, path.join(workRoot, 'next-install'), packageName)
  const installedManifest = await readJson(path.join(installedRoot, 'package.json'))
  if (installedManifest.name !== packageName || installedManifest.version !== version) {
    throw new Error(`Local next tarball identity does not match ${packageName}@${version}`)
  }
  const integrity = `sha512-${createHash('sha512').update(await readFile(nextTarball)).digest('base64')}`
  return { installedRoot, integrity, version }
}

async function readLocatorMode(storeRoot, active, packageName) {
  const version = active?.selected?.version
  if (active?.mode !== 'pinned' || typeof version !== 'string') return ''
  try {
    const ready = await readJson(path.join(storeRoot, version, 'ready.json'))
    return ready?.complete === true && ready?.packageName === packageName ? String(ready.installMode || '') : ''
  } catch {
    return ''
  }
}

async function removeGenerations(storeRoot, installMode, keepVersion = '') {
  if (!existsSync(storeRoot)) return
  for (const entry of await readdir(storeRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === keepVersion || entry.name.startsWith('.')) continue
    try {
      const ready = await readJson(path.join(storeRoot, entry.name, 'ready.json'))
      if (ready?.complete === true && ready?.installMode === installMode) {
        await rm(path.join(storeRoot, entry.name), { recursive: true, force: true })
      }
    } catch {
      // Never remove a generation without a valid receipt for the requested mode.
    }
  }
}

async function publishNextGeneration(installRoot, packageName, sourceVersion, materialized) {
  const storeKey = storeKeyForPackage(packageName)
  const storeRoot = path.join(installRoot, 'store', storeKey)
  const version = materialized.version
  const versionRoot = path.join(storeRoot, version)
  const activePath = path.join(storeRoot, 'active.json')
  const activeBackupPath = path.join(storeRoot, 'active.json.aily-next-backup')
  const developmentBackupPath = path.join(storeRoot, 'active.json.aily-dev-backup')
  await mkdir(storeRoot, { recursive: true })
  const currentActive = existsSync(activePath) ? await readJson(activePath) : null
  const currentMode = await readLocatorMode(storeRoot, currentActive, packageName)
  let lowerPriorityActive = currentActive
  if (currentMode === 'development') {
    const developmentBackup = existsSync(developmentBackupPath)
      ? await readJson(developmentBackupPath)
      : null
    lowerPriorityActive = developmentBackup?.devActiveOriginallyMissing === true
      ? null
      : developmentBackup || (currentActive?.previous
        ? { ...currentActive, mode: 'auto', selected: currentActive.previous, previous: null }
        : null)
  }

  if (!existsSync(activeBackupPath)) {
    if (await readLocatorMode(storeRoot, lowerPriorityActive, packageName) === 'next') {
      if (lowerPriorityActive.previous) {
        await writeJsonAtomic(activeBackupPath, {
          ...lowerPriorityActive, mode: 'auto', selected: lowerPriorityActive.previous, previous: null,
        })
      } else {
        await writeJsonAtomic(activeBackupPath, { nextActiveOriginallyMissing: true })
      }
    } else if (lowerPriorityActive) {
      await writeJsonAtomic(activeBackupPath, lowerPriorityActive)
    } else {
      await writeJsonAtomic(activeBackupPath, { nextActiveOriginallyMissing: true })
    }
  }

  const candidateRoot = path.join(storeRoot, `.staging-${version}-${randomUUID()}`)
  const candidateSource = path.join(candidateRoot, 'source')
  await cp(materialized.installedRoot, candidateSource, { recursive: true })
  const manifest = await readJson(path.join(candidateSource, 'package.json'))
  const uiIndex = manifest.aily?.uiIndex || 'ui/index.html'
  const mainEntry = manifest.main || 'index.js'
  if (!existsSync(path.join(candidateSource, mainEntry)) || !existsSync(path.join(candidateSource, uiIndex))) {
    await rm(candidateRoot, { recursive: true, force: true })
    throw new Error(`Packed artifact is not host-runnable: ${mainEntry} + ${uiIndex}`)
  }
  const locator = { version, path: `${version}/source`, integrity: materialized.integrity }
  await writeJsonAtomic(path.join(candidateRoot, 'ready.json'), {
    schemaVersion: versionStoreSchema,
    complete: true,
    packageName,
    storeKey,
    version,
    path: locator.path,
    integrity: materialized.integrity,
    distribution: null,
    installMode: 'next',
    sourceVersion,
    installedAt: new Date().toISOString(),
  })

  const replacedRoot = path.join(storeRoot, `.replaced-${version}-${randomUUID()}`)
  let replaced = false
  try {
    if (existsSync(versionRoot)) {
      await rename(versionRoot, replacedRoot)
      replaced = true
    }
    await rename(candidateRoot, versionRoot)
    if (replaced) await rm(replacedRoot, { recursive: true, force: true })
  } catch (error) {
    await rm(candidateRoot, { recursive: true, force: true })
    if (!existsSync(versionRoot) && replaced && existsSync(replacedRoot)) await rename(replacedRoot, versionRoot)
    throw error
  }

  const lowerPriorityMode = await readLocatorMode(storeRoot, lowerPriorityActive, packageName)
  const nextActive = {
    schemaVersion: versionStoreSchema,
    packageName,
    storeKey,
    disabled: false,
    mode: 'pinned',
    selected: locator,
    previous: lowerPriorityMode === 'next'
      ? lowerPriorityActive.previous || null
      : lowerPriorityActive?.selected || null,
    activatedAt: new Date().toISOString(),
  }
  if (currentMode === 'development') {
    await writeJsonAtomic(developmentBackupPath, nextActive)
    await writeJsonAtomic(activePath, { ...currentActive, previous: locator })
  } else {
    await writeJsonAtomic(activePath, nextActive)
  }
  await removeGenerations(storeRoot, 'next', version)
  return { sourceRoot: path.join(versionRoot, 'source'), version }
}

async function hasLocalCatalogPackage(installRoot, index) {
  for (const [id, entry] of Object.entries(index || {})) {
    if (id === 'dev' || typeof entry?.package !== 'string') continue
    if ((await statPath(packagePath(installRoot, entry.package)))?.isSymbolicLink()) return true
    const storeRoot = path.join(installRoot, 'store', storeKeyForPackage(entry.package))
    const activePath = path.join(storeRoot, 'active.json')
    if (!existsSync(activePath)) continue
    const mode = await readLocatorMode(storeRoot, await readJson(activePath), entry.package)
    if (mode === 'development' || mode === 'next') return true
  }
  return false
}

async function mergeLocalCatalog(installRoot, catalogId, packageName, entry) {
  const indexPath = path.join(installRoot, 'subapp-index.json')
  const backupPath = `${indexPath}.aily-dev-backup`
  const current = existsSync(indexPath) ? await readJson(indexPath) : {}
  if (!existsSync(backupPath)) {
    if (existsSync(indexPath)) await copyFile(indexPath, backupPath)
    else await writeJsonAtomic(backupPath, { devIndexOriginallyMissing: true })
  }
  await writeJsonAtomic(indexPath, { ...current, [catalogId]: entry, dev: true })
  console.log(`Merged ${catalogId} into the local subapp index at ${indexPath}`)
}

async function restoreLocalCatalog(installRoot, catalogId, packageName) {
  const indexPath = path.join(installRoot, 'subapp-index.json')
  const backupPath = `${indexPath}.aily-dev-backup`
  if (!existsSync(indexPath)) return
  const current = await readJson(indexPath)
  const backup = existsSync(backupPath) ? await readJson(backupPath) : null
  const storeRoot = path.join(installRoot, 'store', storeKeyForPackage(packageName))
  const activePath = path.join(storeRoot, 'active.json')
  const active = existsSync(activePath) ? await readJson(activePath) : null
  if (await readLocatorMode(storeRoot, active, packageName) === 'development'
    && current[catalogId]?.package === packageName) {
    current[catalogId] = { ...current[catalogId], version: active.selected.version }
    await writeJsonAtomic(indexPath, { ...current, dev: true })
    return
  }
  if (current[catalogId]?.package === packageName) {
    if (backup?.[catalogId]) current[catalogId] = backup[catalogId]
    else delete current[catalogId]
  }
  if (await hasLocalCatalogPackage(installRoot, current)) {
    await writeJsonAtomic(indexPath, { ...current, dev: true })
    return
  }
  if (backup?.devIndexOriginallyMissing === true && Object.keys(backup).length === 1) {
    await rm(indexPath, { force: true })
  } else if (backup) {
    await copyFile(backupPath, indexPath)
  } else {
    delete current.dev
    await writeJsonAtomic(indexPath, current)
  }
  await rm(backupPath, { force: true })
}

async function removeNextGeneration(installRoot, packageName) {
  const storeRoot = path.join(installRoot, 'store', storeKeyForPackage(packageName))
  const activePath = path.join(storeRoot, 'active.json')
  const backupPath = path.join(storeRoot, 'active.json.aily-next-backup')
  const developmentBackupPath = path.join(storeRoot, 'active.json.aily-dev-backup')
  const current = existsSync(activePath) ? await readJson(activePath) : null
  const currentMode = await readLocatorMode(storeRoot, current, packageName)
  const backup = existsSync(backupPath) ? await readJson(backupPath) : null
  if (currentMode === 'next') {
    if (backup?.nextActiveOriginallyMissing === true) await rm(activePath, { force: true })
    else if (backup) await copyFile(backupPath, activePath)
    else await rm(activePath, { force: true })
  } else if (currentMode === 'development' && existsSync(developmentBackupPath)) {
    const developmentBackup = await readJson(developmentBackupPath)
    if (await readLocatorMode(storeRoot, developmentBackup, packageName) === 'next') {
      if (backup?.nextActiveOriginallyMissing === true || !backup) {
        await rm(developmentBackupPath, { force: true })
        await writeJsonAtomic(activePath, { ...current, previous: null })
      } else {
        await writeJsonAtomic(developmentBackupPath, backup)
        await writeJsonAtomic(activePath, { ...current, previous: backup.selected || null })
      }
    }
  }
  await rm(backupPath, { force: true })
  await removeGenerations(storeRoot, 'next')
}

function printHelp() {
  console.log(`Usage: npm run deploy:next -- [options]

Build Aily Coder Editor, then deploy its npm artifact into the local
multi-version store as <version>-next. Active dev always keeps priority.

Options:
  --app-root <path>          Override the npm-global/app target
  --unlink                   Remove local next and restore the prior version
  --skip-build               Reuse an existing build:subapp artifact
  --artifact-root <path>     Override the built package root
  --catalog-path <path>      Override the generated catalog path
  --skip-catalog-generate    Reuse the catalog path without regenerating it
  --help                     Show this help`)
}

const options = parseArgs(process.argv.slice(2))
if (options.help) {
  printHelp()
  process.exit(0)
}

const sourceManifest = await readJson(path.join(packageRoot, 'package.json'))
const packageName = String(sourceManifest.ailySubapp?.package || sourceManifest.name || '').trim()
const catalogId = String(sourceManifest.ailySubapp?.id || 'aily-coder-editor').trim()
if (!packageName || !catalogId) throw new Error('Aily Coder package metadata is incomplete')
const installRoot = resolveInstallRoot(options)
await ensureInstallProject(installRoot)

if (options.unlink) {
  await removeNextGeneration(installRoot, packageName)
  await restoreLocalCatalog(installRoot, catalogId, packageName)
  console.log(`Removed local ${packageName}@<version>-next and restored the prior active version`)
  process.exit(0)
}

if (!options['skip-build']) await run(npmCommand, ['run', 'build:subapp'])

const artifactRoot = path.resolve(String(options['artifact-root'] || defaultArtifactRoot))
const catalogPath = path.resolve(String(options['catalog-path'] || defaultCatalogPath))
if (!existsSync(path.join(artifactRoot, 'package.json'))) {
  throw new Error(`build:subapp artifact not found at ${artifactRoot}; run npm run build:subapp first`)
}
if (!options['skip-catalog-generate']) {
  await run(process.execPath, [path.join(packageRoot, 'scripts', 'generate-subapp-index.mjs')])
}
const catalog = await readJson(catalogPath)
const catalogEntry = catalog[catalogId]
if (!catalogEntry || catalogEntry.package !== packageName) {
  throw new Error(`Catalog ${catalogPath} does not contain ${catalogId} (${packageName})`)
}
const artifactManifest = await readJson(path.join(artifactRoot, 'package.json'))
if (artifactManifest.name !== packageName || artifactManifest.version !== sourceManifest.version) {
  throw new Error(`build:subapp artifact is stale or invalid: expected ${packageName}@${sourceManifest.version}`)
}

for (const required of ['index.js', path.join('runtime', 'index.js'), path.join('ui', 'index.html')]) {
  if (!existsSync(path.join(artifactRoot, required))) {
    throw new Error(`build:subapp artifact is incomplete (${required}); run npm run build:subapp first`)
  }
}
const workRoot = await mkdtemp(path.join(os.tmpdir(), 'aily-next-coder-'))
try {
  const materialized = await materializeNextPackage(
    artifactRoot, packageName, sourceManifest.version, workRoot,
  )
  const deployed = await publishNextGeneration(
    installRoot, packageName, sourceManifest.version, materialized,
  )
  await mergeLocalCatalog(installRoot, catalogId, packageName, {
    ...catalogEntry,
    version: deployed.version,
  })
  console.log(`Activated packaged ${packageName}@${deployed.version}: ${deployed.sourceRoot}`)
  console.log('Restart Aily Coder Editor in the host to validate the exact npm-packed build output.')
} finally {
  await rm(workRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
