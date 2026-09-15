#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createServer } from 'node:http'
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const packageJson = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'))
const subapp = packageJson.ailySubapp || {}
const packageName = String(subapp.package || packageJson.name || '').trim()
const catalogId = String(subapp.id || 'aily-coder-editor').trim()
const markerPath = path.join(packageRoot, '.aily-dev.json')
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const booleanOptions = new Set(['help', 'skip-build', 'unlink', 'watch'])
const versionStoreSchema = 2

function parseArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!arg.startsWith('--')) continue
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

function packagePath(installRoot, name) {
  return path.join(installRoot, 'node_modules', ...name.split('/'))
}

function storeKeyForPackage(name) {
  return String(name).split('/').at(-1)
}

function developmentVersion(version) {
  return `${version}-dev`
}

function developmentStorePaths(installRoot) {
  const storeRoot = path.join(installRoot, 'store', storeKeyForPackage(packageName))
  const version = developmentVersion(packageJson.version)
  const versionRoot = path.join(storeRoot, version)
  return {
    storeRoot,
    version,
    versionRoot,
    sourceRoot: path.join(versionRoot, 'source'),
    readyPath: path.join(versionRoot, 'ready.json'),
    activePath: path.join(storeRoot, 'active.json'),
    activeBackupPath: path.join(storeRoot, 'active.json.aily-dev-backup'),
  }
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
  const temporaryPath = `${filePath}.${process.pid}.tmp`
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(temporaryPath, filePath)
}

async function ensureInstallProject(installRoot) {
  await mkdir(installRoot, { recursive: true })
  const packageJsonPath = path.join(installRoot, 'package.json')
  if (existsSync(packageJsonPath)) return
  await writeJsonAtomic(packageJsonPath, {
    name: 'aily-installed-subapps',
    private: true,
    version: '1.0.0',
    description: 'Aily Blockly user-installed child applications',
    dependencies: {},
  })
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: packageRoot,
      env: { ...process.env },
      shell: process.platform === 'win32',
      stdio: 'inherit',
      windowsHide: true,
    })
    child.once('error', reject)
    child.once('exit', code => {
      if (code === 0) resolve()
      else reject(new Error(`${command} ${args.join(' ')} exited with code ${code}`))
    })
  })
}

async function cleanupLegacyDevelopmentLink(installRoot) {
  const linkPath = packagePath(installRoot, packageName)
  const backupPath = `${linkPath}.aily-dev-backup`
  const current = await statPath(linkPath)
  if (current) {
    if (current.isSymbolicLink()) {
      const resolved = await realpath(linkPath).catch(() => '')
      if (resolved && resolved !== await realpath(packageRoot)) {
        throw new Error(`A different legacy development link still overrides the version store: ${linkPath} -> ${resolved}`)
      }
      await unlink(linkPath)
    }
  }
  if (await statPath(backupPath)) {
    if (await statPath(linkPath)) {
      throw new Error(`Cannot restore legacy development backup while ${linkPath} exists`)
    }
    await rename(backupPath, linkPath)
  }
}

function dependencyBackupPath(installRoot) {
  return path.join(installRoot, '.aily-dev-dependency-backup.json')
}

async function updateDevelopmentDependency(installRoot, unlinking) {
  const installPackagePath = path.join(installRoot, 'package.json')
  const installPackage = await readJson(installPackagePath)
  const dependencies = installPackage.dependencies && typeof installPackage.dependencies === 'object'
    ? { ...installPackage.dependencies }
    : {}
  const localSpecifier = `file:${packageRoot.replaceAll('\\', '/')}`
  const backupFile = dependencyBackupPath(installRoot)
  const backup = existsSync(backupFile) ? await readJson(backupFile) : {}

  if (!unlinking) {
    if (dependencies[packageName] && dependencies[packageName] !== localSpecifier && backup[packageName] === undefined) {
      backup[packageName] = dependencies[packageName]
    }
    dependencies[packageName] = localSpecifier
  } else if (dependencies[packageName] === localSpecifier) {
    if (typeof backup[packageName] === 'string' && backup[packageName].trim()) {
      dependencies[packageName] = backup[packageName]
    } else {
      delete dependencies[packageName]
    }
    delete backup[packageName]
  }

  installPackage.dependencies = dependencies
  await writeJsonAtomic(installPackagePath, installPackage)
  if (Object.keys(backup).length) await writeJsonAtomic(backupFile, backup)
  else await rm(backupFile, { force: true })
}

async function mirrorDevelopmentPackage(sourceRoot) {
  await mkdir(sourceRoot, { recursive: true })
  for (const entry of await readdir(packageRoot, { withFileTypes: true })) {
    if (['.git', '.aily-dev.json', '.aily-dev-reload.json', 'package.json'].includes(entry.name)) continue
    const source = path.join(packageRoot, entry.name)
    const destination = path.join(sourceRoot, entry.name)
    if (entry.isDirectory()) {
      await symlink(source, destination, process.platform === 'win32' ? 'junction' : 'dir')
    } else if (entry.isSymbolicLink()) {
      const resolved = await realpath(source)
      const resolvedStat = await lstat(resolved)
      if (resolvedStat.isDirectory()) {
        await symlink(source, destination, process.platform === 'win32' ? 'junction' : 'dir')
      } else {
        await copyFile(source, destination)
      }
    } else if (entry.isFile()) {
      await copyFile(source, destination)
    }
  }
  await writeJsonAtomic(path.join(sourceRoot, 'package.json'), {
    ...packageJson,
    name: packageName,
    version: developmentVersion(packageJson.version),
    private: true,
  })
}

async function createDevelopmentGeneration(installRoot) {
  const paths = developmentStorePaths(installRoot)
  await mkdir(paths.storeRoot, { recursive: true })
  const currentActive = existsSync(paths.activePath) ? await readJson(paths.activePath) : null
  if (!existsSync(paths.activeBackupPath)) {
    if (await isDevelopmentLocator(paths.storeRoot, currentActive, packageName)) {
      if (currentActive.previous) {
        await writeJsonAtomic(paths.activeBackupPath, {
          ...currentActive,
          mode: 'auto',
          selected: currentActive.previous,
          previous: null,
        })
      } else {
        await writeJsonAtomic(paths.activeBackupPath, { devActiveOriginallyMissing: true })
      }
    } else if (currentActive) {
      await copyFile(paths.activePath, paths.activeBackupPath)
    } else {
      await writeJsonAtomic(paths.activeBackupPath, { devActiveOriginallyMissing: true })
    }
  }

  await rm(paths.versionRoot, { recursive: true, force: true })
  await mirrorDevelopmentPackage(paths.sourceRoot)
  const locator = { version: paths.version, path: `${paths.version}/source` }
  await writeJsonAtomic(paths.readyPath, {
    schemaVersion: versionStoreSchema,
    complete: true,
    packageName,
    storeKey: storeKeyForPackage(packageName),
    version: paths.version,
    path: locator.path,
    distribution: null,
    installMode: 'development',
    installedAt: new Date().toISOString(),
  })
  await writeJsonAtomic(paths.activePath, {
    schemaVersion: versionStoreSchema,
    packageName,
    storeKey: storeKeyForPackage(packageName),
    disabled: false,
    mode: 'pinned',
    selected: locator,
    previous: await isDevelopmentLocator(paths.storeRoot, currentActive, packageName)
      ? currentActive.previous || null
      : currentActive?.selected || null,
    activatedAt: new Date().toISOString(),
  })
  await removeDevelopmentGenerations(paths.storeRoot, paths.version)
  return paths
}

async function restoreDevelopmentGeneration(installRoot) {
  const paths = developmentStorePaths(installRoot)
  const currentActive = existsSync(paths.activePath) ? await readJson(paths.activePath) : null
  if (await isDevelopmentLocator(paths.storeRoot, currentActive, packageName)) {
    const backup = existsSync(paths.activeBackupPath) ? await readJson(paths.activeBackupPath) : null
    if (backup?.devActiveOriginallyMissing === true) await rm(paths.activePath, { force: true })
    else if (backup) await copyFile(paths.activeBackupPath, paths.activePath)
    else await rm(paths.activePath, { force: true })
  }
  await rm(paths.activeBackupPath, { force: true })
  await removeDevelopmentGenerations(paths.storeRoot)
  return paths
}

async function hasVersionedDevelopmentPackage(installRoot, name) {
  const storeRoot = path.join(installRoot, 'store', storeKeyForPackage(name))
  const activePath = path.join(storeRoot, 'active.json')
  if (!existsSync(activePath)) return false
  try {
    return await isDevelopmentLocator(storeRoot, await readJson(activePath), name)
  } catch {
    return false
  }
}

async function hasVersionedLocalPackage(installRoot, name) {
  if (await hasVersionedDevelopmentPackage(installRoot, name)) return true
  const storeRoot = path.join(installRoot, 'store', storeKeyForPackage(name))
  const activePath = path.join(storeRoot, 'active.json')
  if (!existsSync(activePath)) return false
  try {
    const active = await readJson(activePath)
    const version = active?.selected?.version
    if (active?.mode !== 'pinned' || typeof version !== 'string') return false
    const ready = await readJson(path.join(storeRoot, version, 'ready.json'))
    return ready?.complete === true && ready?.installMode === 'next' && ready?.packageName === name
  } catch {
    return false
  }
}

async function readLocatorMode(storeRoot, active, name) {
  const version = active?.selected?.version
  if (active?.mode !== 'pinned' || typeof version !== 'string') return ''
  try {
    const ready = await readJson(path.join(storeRoot, version, 'ready.json'))
    return ready?.complete === true && ready?.packageName === name
      ? String(ready.installMode || '')
      : ''
  } catch {
    return ''
  }
}

async function isDevelopmentLocator(storeRoot, active, name) {
  const version = active?.selected?.version
  if (active?.mode !== 'pinned' || typeof version !== 'string' || !version.endsWith('-dev')) return false
  try {
    const ready = await readJson(path.join(storeRoot, version, 'ready.json'))
    return ready?.complete === true && ready?.installMode === 'development' && ready?.packageName === name
  } catch {
    return false
  }
}

async function removeDevelopmentGenerations(storeRoot, keepVersion = '') {
  if (!existsSync(storeRoot)) return
  for (const entry of await readdir(storeRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === keepVersion) continue
    const versionRoot = path.join(storeRoot, entry.name)
    try {
      const ready = await readJson(path.join(versionRoot, 'ready.json'))
      if (ready?.installMode === 'development') {
        await rm(versionRoot, { recursive: true, force: true })
      }
    } catch {
      // Never remove an unverified version-store generation.
    }
  }
}

async function loadCatalogLocales() {
  const i18nDir = path.join(packageRoot, 'i18n')
  const locales = {}
  for (const entry of await readdir(i18nDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    const locale = path.basename(entry.name, '.json').toLowerCase().replaceAll('-', '_')
    const translation = await readJson(path.join(i18nDir, entry.name))
    const copy = translation[subapp.namespace]
    if (copy && typeof copy === 'object') {
      locales[locale] = {
        TITLE: String(copy.TITLE || ''),
        DESCRIPTION: String(copy.DESCRIPTION || ''),
      }
    }
  }
  if (!locales.en?.TITLE || !locales.en?.DESCRIPTION) {
    throw new Error('i18n/en.json must define AILY_CODER_EDITOR.TITLE and AILY_CODER_EDITOR.DESCRIPTION')
  }
  return locales
}

async function createCatalogEntry() {
  return {
    id: catalogId,
    role: 'dependency',
    only: typeof packageJson.only === 'string' && packageJson.only.trim()
      ? packageJson.only.trim().toLowerCase()
      : 'all',
    titleKey: subapp.titleKey,
    namespace: subapp.namespace,
    app: { ...subapp.app },
    package: packageName,
    version: packageJson.version,
    i18n: {
      defaultLocale: 'en',
      locales: await loadCatalogLocales(),
    },
  }
}

async function mergeDevelopmentIndex(installRoot) {
  const indexPath = path.join(installRoot, 'subapp-index.json')
  const backupPath = `${indexPath}.aily-dev-backup`
  const current = existsSync(indexPath) ? await readJson(indexPath) : {}
  if (!existsSync(backupPath)) {
    if (existsSync(indexPath)) await copyFile(indexPath, backupPath)
    else await writeJsonAtomic(backupPath, { devIndexOriginallyMissing: true })
  }
  await writeJsonAtomic(indexPath, {
    ...current,
    [catalogId]: await createCatalogEntry(),
    dev: true,
  })
  console.log(`Merged ${catalogId} into the development subapp index at ${indexPath}`)
}

async function hasDevelopmentCatalogPackage(installRoot, index) {
  for (const [id, entry] of Object.entries(index)) {
    if (id === 'dev' || !entry || typeof entry !== 'object') continue
    const name = typeof entry.package === 'string' ? entry.package : ''
    if (!name) continue
    if ((await statPath(packagePath(installRoot, name)))?.isSymbolicLink()) return true
    if (await hasVersionedLocalPackage(installRoot, name)) return true
  }
  return false
}

async function removeDevelopmentIndexEntry(installRoot) {
  const indexPath = path.join(installRoot, 'subapp-index.json')
  const backupPath = `${indexPath}.aily-dev-backup`
  if (!existsSync(indexPath)) return
  const current = await readJson(indexPath)
  const storeRoot = path.join(installRoot, 'store', storeKeyForPackage(packageName))
  const activePath = path.join(storeRoot, 'active.json')
  const active = existsSync(activePath) ? await readJson(activePath) : null
  if (await readLocatorMode(storeRoot, active, packageName) === 'next'
    && current[catalogId]?.package === packageName) {
    current[catalogId] = { ...current[catalogId], version: active.selected.version }
    await writeJsonAtomic(indexPath, { ...current, dev: true })
    return
  }
  if (current[catalogId]?.package === packageName) delete current[catalogId]

  if (await hasDevelopmentCatalogPackage(installRoot, current)) {
    await writeJsonAtomic(indexPath, { ...current, dev: true })
    return
  }
  if (!existsSync(backupPath)) {
    delete current.dev
    await writeJsonAtomic(indexPath, current)
    return
  }
  const backup = await readJson(backupPath)
  if (backup.devIndexOriginallyMissing === true && Object.keys(backup).length === 1) {
    await rm(indexPath, { force: true })
  } else {
    await copyFile(backupPath, indexPath)
  }
  await rm(backupPath, { force: true })
  console.log(`Restored the pre-development subapp index at ${indexPath}`)
}

function assertRunnablePackage() {
  for (const file of [
    'index.js',
    path.join('runtime', 'index.js'),
    path.join('ui', 'index.html'),
    path.join('i18n', 'en.json'),
  ]) {
    if (!existsSync(path.join(packageRoot, file))) {
      throw new Error(`Coder development package is missing ${file}`)
    }
  }
}

function printHelp() {
  console.log(`Usage: npm run dev -- [options]
       npm run dev:link -- [options]

Build Aily Coder Editor into a pinned <version>-dev generation in the same
multi-version subapp store used in production. npm run dev also watches the
Vite build and reloads the iframe.

Options:
  --app-root <path>  Override the npm-global/app target
  --skip-build       Reuse the existing ui/ build
  --watch            Watch source and reload the development iframe
  --unlink           Remove <version>-dev and restore the prior active version
  --help             Show this help`)
}

async function startReloadServer() {
  const clients = new Set()
  const server = createServer((request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1')
    if (url.pathname === '/health') {
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify({ ok: true }))
      return
    }
    if (url.pathname !== '/events') {
      response.writeHead(404)
      response.end('Not found')
      return
    }
    response.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Content-Type': 'text/event-stream; charset=utf-8',
    })
    response.write(': connected\n\n')
    clients.add(response)
    request.on('close', () => clients.delete(response))
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return {
    url: `http://127.0.0.1:${port}/events`,
    broadcast() {
      for (const client of clients) client.write('event: reload\ndata: {}\n\n')
    },
    close() {
      for (const client of clients) client.end()
      clients.clear()
      return new Promise(resolve => server.close(resolve))
    },
  }
}

async function startWatchMode(developmentSourceRoot) {
  const reload = await startReloadServer()
  const developmentMarkerPath = path.join(developmentSourceRoot, '.aily-dev.json')
  await writeJsonAtomic(markerPath, { reloadUrl: reload.url })
  await writeJsonAtomic(developmentMarkerPath, { reloadUrl: reload.url })
  const builder = spawn(npmCommand, ['run', 'build:watch'], {
    cwd: packageRoot,
    env: { ...process.env },
    shell: process.platform === 'win32',
    stdio: ['inherit', 'pipe', 'inherit'],
    windowsHide: true,
  })
  // File notifications also fire while Vite is emptying/writing ui/. Only a
  // completed build is a reload opportunity; otherwise an empty index can stick.
  let output = ''
  builder.stdout.on('data', chunk => {
    process.stdout.write(chunk)
    output += chunk.toString()
    const lines = output.split(/\r?\n/); output = lines.pop() || ''
    for (const line of lines) if (/built in \d[\d.]*\s*(?:ms|s)/.test(line)) reload.broadcast()
  })

  console.log(`Coder dev reload bus: ${reload.url}`)
  console.log('Vite rebuilds ui/ on source changes; the linked iframe reloads automatically.')

  let stopping = false
  const stop = async (signal) => {
    if (stopping) return
    stopping = true
    await rm(markerPath, { force: true })
    await rm(developmentMarkerPath, { force: true })
    builder.kill(signal === 'SIGTERM' ? 'SIGTERM' : 'SIGINT')
    await reload.close()
  }
  process.once('SIGINT', () => void stop('SIGINT'))
  process.once('SIGTERM', () => void stop('SIGTERM'))
  try {
    await new Promise((resolve, reject) => {
      builder.once('error', reject)
      builder.once('exit', code => code === 0 || stopping
        ? resolve()
        : reject(new Error(`Coder Vite watcher exited with code ${code}`)))
    })
  } finally {
    await stop('SIGTERM')
  }
}

if (!packageName || !catalogId || !subapp.namespace || !subapp.titleKey) {
  throw new Error('package.json is missing aily-coder-editor subapp metadata')
}

const options = parseArgs(process.argv.slice(2))
if (options.help) {
  printHelp()
  process.exit(0)
}

const installRoot = resolveInstallRoot(options)
await ensureInstallProject(installRoot)

if (options.unlink) {
  await cleanupLegacyDevelopmentLink(installRoot)
  await updateDevelopmentDependency(installRoot, true)
  const paths = await restoreDevelopmentGeneration(installRoot)
  await removeDevelopmentIndexEntry(installRoot)
  await rm(markerPath, { force: true })
  console.log(`Removed ${packageName}@${paths.version} and restored the prior active version`)
  process.exit(0)
}

if (!options['skip-build']) await run(npmCommand, ['run', 'build:subapp'])
assertRunnablePackage()
await cleanupLegacyDevelopmentLink(installRoot)
await updateDevelopmentDependency(installRoot, true)
const paths = await createDevelopmentGeneration(installRoot)
await mergeDevelopmentIndex(installRoot)
console.log(`Activated ${packageName}@${paths.version}: ${paths.sourceRoot}`)
console.log('Host starts package-root index.js + ui/index.html from the pinned development generation.')

if (options.watch) await startWatchMode(paths.sourceRoot)
