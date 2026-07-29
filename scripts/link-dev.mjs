#!/usr/bin/env node

import { existsSync } from 'node:fs'
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const packageJson = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'))

function defaultAppDataPath() {
  if (process.env.AILY_APPDATA_PATH) return path.resolve(process.env.AILY_APPDATA_PATH)
  if (process.platform === 'win32') {
    return path.join(os.homedir(), 'AppData', 'Local', 'aily-project')
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'aily-project')
  }
  return path.join(os.homedir(), '.config', 'aily-project')
}

function parseArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!arg.startsWith('--')) continue
    const key = arg.slice(2)
    const next = argv[index + 1]
    options[key] = next && !next.startsWith('--') ? argv[++index] : true
  }
  return options
}

async function statPath(filePath) {
  try {
    return await lstat(filePath)
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

async function ensureInstallProject(installRoot) {
  await mkdir(installRoot, { recursive: true })
  const packageJsonPath = path.join(installRoot, 'package.json')
  if (existsSync(packageJsonPath)) return
  await writeFile(packageJsonPath, `${JSON.stringify({
    name: 'aily-installed-subapps',
    private: true,
    version: '1.0.0',
    dependencies: {},
  }, null, 2)}\n`)
}

const options = parseArgs(process.argv.slice(2))
const installRoot = path.resolve(String(
  options['app-root']
  || process.env.AILY_SUBAPP_INSTALL_ROOT
  || path.join(defaultAppDataPath(), 'npm-global', 'app'),
))
const linkPath = path.join(installRoot, 'node_modules', ...packageJson.name.split('/'))
const backupPath = `${linkPath}.aily-dev-backup`

await ensureInstallProject(installRoot)
await mkdir(path.dirname(linkPath), { recursive: true })

if (options.unlink) {
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
    console.log(`Unlinked ${packageJson.name} and restored the installed package`)
  } else {
    console.log(`Unlinked ${packageJson.name}`)
  }
  process.exit(0)
}

if (!existsSync(path.join(packageRoot, 'dist', 'index.html'))) {
  throw new Error('Coder UI is missing. Run npm run build:subapp before dev:link.')
}

const current = await statPath(linkPath)
if (current?.isSymbolicLink()) {
  const resolved = await realpath(linkPath).catch(() => '')
  if (resolved === await realpath(packageRoot)) {
    console.log(`${packageJson.name} is already linked at ${linkPath}`)
    process.exit(0)
  }
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

const resolved = await realpath(linkPath)
if (resolved !== await realpath(packageRoot)) {
  throw new Error(`Unexpected development link target: ${resolved}`)
}
console.log(`Linked ${packageJson.name}: ${linkPath} -> ${packageRoot}`)
