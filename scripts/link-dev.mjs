#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { existsSync, watch as watchFs } from 'node:fs'
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
const catalogId = String(subapp.id || 'aily-coder').trim()
const markerPath = path.join(packageRoot, '.aily-dev.json')
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const booleanOptions = new Set(['help', 'skip-build', 'unlink', 'watch'])

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
    : path.join(defaultAppDataPath(), 'npm-global', 'app')
}

function packagePath(installRoot, name) {
  return path.join(installRoot, 'node_modules', ...name.split('/'))
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

async function linkPackage(installRoot) {
  const linkPath = packagePath(installRoot, packageName)
  const backupPath = `${linkPath}.aily-dev-backup`
  await mkdir(path.dirname(linkPath), { recursive: true })
  const current = await statPath(linkPath)

  if (current?.isSymbolicLink() && await realpath(linkPath).catch(() => '') === await realpath(packageRoot)) {
    return { linkPath, replaced: Boolean(await statPath(backupPath)) }
  }
  if (current) {
    if (await statPath(backupPath)) {
      throw new Error(`Cannot replace ${linkPath}: backup already exists at ${backupPath}`)
    }
    await rename(linkPath, backupPath)
  }

  try {
    await symlink(packageRoot, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    if (current && await statPath(backupPath) && !(await statPath(linkPath))) {
      await rename(backupPath, linkPath)
    }
    throw error
  }
  if (await realpath(linkPath) !== await realpath(packageRoot)) {
    throw new Error(`Unexpected development link target: ${await realpath(linkPath)}`)
  }
  return { linkPath, replaced: Boolean(current) }
}

async function unlinkPackage(installRoot) {
  const linkPath = packagePath(installRoot, packageName)
  const backupPath = `${linkPath}.aily-dev-backup`
  const current = await statPath(linkPath)
  if (current) {
    if (!current.isSymbolicLink()) {
      throw new Error(`Refusing to unlink a non-symlink package: ${linkPath}`)
    }
    const resolved = await realpath(linkPath).catch(() => '')
    if (resolved && resolved !== await realpath(packageRoot)) {
      throw new Error(`Refusing to unlink a different source package: ${linkPath} -> ${resolved}`)
    }
    await unlink(linkPath)
  }
  if (await statPath(backupPath)) {
    await rename(backupPath, linkPath)
    return { linkPath, restored: true }
  }
  return { linkPath, restored: false }
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
    throw new Error('i18n/en.json must define AILY_CODER.TITLE and AILY_CODER.DESCRIPTION')
  }
  return locales
}

async function createCatalogEntry() {
  return {
    id: catalogId,
    role: 'dependency',
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

async function hasLinkedCatalogPackage(installRoot, index) {
  for (const [id, entry] of Object.entries(index)) {
    if (id === 'dev' || !entry || typeof entry !== 'object') continue
    const name = typeof entry.package === 'string' ? entry.package : ''
    if (name && (await statPath(packagePath(installRoot, name)))?.isSymbolicLink()) return true
  }
  return false
}

async function removeDevelopmentIndexEntry(installRoot) {
  const indexPath = path.join(installRoot, 'subapp-index.json')
  const backupPath = `${indexPath}.aily-dev-backup`
  if (!existsSync(indexPath)) return
  const current = await readJson(indexPath)
  if (current[catalogId]?.package === packageName) delete current[catalogId]

  if (await hasLinkedCatalogPackage(installRoot, current)) {
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

Build and link Aily Coder into the same user-level npm subapp directory used in
production. npm run dev also watches the Vite build and reloads the iframe.

Options:
  --app-root <path>  Override the npm-global/app target
  --skip-build       Reuse the existing ui/ build
  --watch            Watch source and reload the linked iframe
  --unlink           Remove the link and restore replaced state
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

async function startWatchMode() {
  const reload = await startReloadServer()
  await writeJsonAtomic(markerPath, { reloadUrl: reload.url })
  let timer
  const watcher = watchFs(path.join(packageRoot, 'ui'), { recursive: true }, () => {
    clearTimeout(timer)
    timer = setTimeout(() => reload.broadcast(), 250)
  })
  const builder = spawn(npmCommand, ['run', 'build:watch'], {
    cwd: packageRoot,
    env: { ...process.env },
    shell: process.platform === 'win32',
    stdio: 'inherit',
    windowsHide: true,
  })

  console.log(`Coder dev reload bus: ${reload.url}`)
  console.log('Vite rebuilds ui/ on source changes; the linked iframe reloads automatically.')

  let stopping = false
  const stop = async (signal) => {
    if (stopping) return
    stopping = true
    clearTimeout(timer)
    watcher.close()
    await rm(markerPath, { force: true })
    builder.kill(signal === 'SIGTERM' ? 'SIGTERM' : 'SIGINT')
    await reload.close()
  }
  process.once('SIGINT', () => void stop('SIGINT'))
  process.once('SIGTERM', () => void stop('SIGTERM'))
  await new Promise((resolve, reject) => {
    builder.once('error', reject)
    builder.once('exit', code => code === 0 || stopping
      ? resolve()
      : reject(new Error(`Coder Vite watcher exited with code ${code}`)))
  })
  await stop('SIGTERM')
}

if (!packageName || !catalogId || !subapp.namespace || !subapp.titleKey) {
  throw new Error('package.json is missing aily-coder subapp metadata')
}

const options = parseArgs(process.argv.slice(2))
if (options.help) {
  printHelp()
  process.exit(0)
}

const installRoot = resolveInstallRoot(options)
await ensureInstallProject(installRoot)

if (options.unlink) {
  const result = await unlinkPackage(installRoot)
  await updateDevelopmentDependency(installRoot, true)
  await removeDevelopmentIndexEntry(installRoot)
  await rm(markerPath, { force: true })
  console.log(`Unlinked ${packageName} from ${installRoot}${result.restored ? ' and restored the installed package' : ''}`)
  process.exit(0)
}

if (!options['skip-build']) await run(npmCommand, ['run', 'build:subapp'])
assertRunnablePackage()
const result = await linkPackage(installRoot)
await updateDevelopmentDependency(installRoot, false)
await mergeDevelopmentIndex(installRoot)
console.log(`Linked ${packageName}: ${result.linkPath} -> ${packageRoot}${result.replaced ? ' (installed package backed up)' : ''}`)
console.log('Host starts package-root index.js + ui/index.html from the linked source package.')

if (options.watch) await startWatchMode()
