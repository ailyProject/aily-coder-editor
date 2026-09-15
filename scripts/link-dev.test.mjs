import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const scriptPath = path.join(packageRoot, 'scripts', 'link-dev.mjs')
const packageName = '@aily-project/subapp-aily-coder-editor'
const packageVersion = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8')).version

function runLink(args) {
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: packageRoot,
    encoding: 'utf8',
    windowsHide: true,
  })
  assert.equal(result.status, 0, result.stderr || result.stdout)
}

test('dev link registers, discovers, and cleanly restores Aily Coder Editor', async (t) => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'aily-coder-editor-link-'))
  const installRoot = path.join(fixtureRoot, 'npm-global', 'app')
  const packagePath = path.join(installRoot, 'node_modules', '@aily-project', 'subapp-aily-coder-editor')
  const storeRoot = path.join(installRoot, 'store', 'subapp-aily-coder-editor')
  const devRoot = path.join(storeRoot, '0.1.9-dev')
  const indexPath = path.join(installRoot, 'subapp-index.json')
  const originalIndex = {
    'remote-only': {
      id: 'remote-only',
      package: '@aily-project/subapp-remote-only',
    },
  }
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }))

  await mkdir(installRoot, { recursive: true })
  await writeFile(path.join(installRoot, 'package.json'), `${JSON.stringify({
    name: 'aily-installed-subapps',
    private: true,
    version: '1.0.0',
    dependencies: { [packageName]: '0.1.0' },
  }, null, 2)}\n`)
  await writeFile(indexPath, `${JSON.stringify(originalIndex, null, 2)}\n`)

  runLink(['--app-root', installRoot, '--skip-build'])

  assert.equal(existsSync(packagePath), false)
  const installPackage = JSON.parse(await readFile(path.join(installRoot, 'package.json'), 'utf8'))
  assert.equal(installPackage.dependencies[packageName], '0.1.0')
  const active = JSON.parse(await readFile(path.join(storeRoot, 'active.json'), 'utf8'))
  assert.equal(active.mode, 'pinned')
  assert.deepEqual(active.selected, { version: '0.1.9-dev', path: '0.1.9-dev/source' })
  assert.equal(JSON.parse(await readFile(path.join(devRoot, 'ready.json'), 'utf8')).installMode, 'development')
  const devPackage = JSON.parse(await readFile(path.join(devRoot, 'source', 'package.json'), 'utf8'))
  assert.equal(devPackage.name, packageName)
  assert.equal(devPackage.version, '0.1.9-dev')
  const developmentIndex = JSON.parse(await readFile(indexPath, 'utf8'))
  assert.equal(developmentIndex.dev, true)
  assert.equal(developmentIndex['remote-only'].id, 'remote-only')
  assert.equal(developmentIndex['aily-coder-editor'].package, packageName)
  assert.equal(developmentIndex['aily-coder-editor'].only, 'aily coder')
  assert.equal(developmentIndex['aily-coder-editor'].app.extension, true)
  assert.equal(developmentIndex['aily-coder-editor'].i18n.locales.zh_cn.TITLE, 'Aily Coder Editor')

  runLink(['--app-root', installRoot, '--unlink'])

  assert.equal(existsSync(packagePath), false)
  assert.equal(existsSync(devRoot), false)
  const restoredPackage = JSON.parse(await readFile(path.join(installRoot, 'package.json'), 'utf8'))
  assert.equal(restoredPackage.dependencies[packageName], '0.1.0')
  assert.deepEqual(JSON.parse(await readFile(indexPath, 'utf8')), originalIndex)
  assert.equal(existsSync(`${indexPath}.aily-dev-backup`), false)
  assert.equal(existsSync(path.join(installRoot, '.aily-dev-dependency-backup.json')), false)
})

test('dev unlink preserves another repository development link and shared index backup', async (t) => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'aily-coder-editor-coexist-'))
  const installRoot = path.join(fixtureRoot, 'npm-global', 'app')
  const otherSource = path.join(fixtureRoot, 'other-source')
  const otherPackage = '@aily-project/subapp-other'
  const otherLink = path.join(installRoot, 'node_modules', '@aily-project', 'subapp-other')
  const indexPath = path.join(installRoot, 'subapp-index.json')
  const originalIndex = {
    'remote-only': { id: 'remote-only', package: '@aily-project/subapp-remote-only' },
  }
  const otherDevelopmentIndex = {
    dev: true,
    ...originalIndex,
    other: { id: 'other', package: otherPackage },
  }
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }))

  await mkdir(path.dirname(otherLink), { recursive: true })
  await mkdir(otherSource, { recursive: true })
  await symlink(otherSource, otherLink, process.platform === 'win32' ? 'junction' : 'dir')
  await writeFile(path.join(installRoot, 'package.json'), `${JSON.stringify({
    name: 'aily-installed-subapps',
    private: true,
    version: '1.0.0',
    dependencies: {},
  }, null, 2)}\n`)
  await writeFile(indexPath, `${JSON.stringify(otherDevelopmentIndex, null, 2)}\n`)
  await writeFile(`${indexPath}.aily-dev-backup`, `${JSON.stringify(originalIndex, null, 2)}\n`)

  runLink(['--app-root', installRoot, '--skip-build'])
  runLink(['--app-root', installRoot, '--unlink'])

  const retainedIndex = JSON.parse(await readFile(indexPath, 'utf8'))
  assert.equal(retainedIndex.dev, true)
  assert.deepEqual(retainedIndex.other, otherDevelopmentIndex.other)
  assert.equal(retainedIndex['aily-coder-editor'], undefined)
  assert.equal(existsSync(`${indexPath}.aily-dev-backup`), true)
  assert.equal((await lstat(otherLink)).isSymbolicLink(), true)
})

test('dev unlink preserves another packaged version-next and the shared local index', async (t) => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'aily-coder-editor-next-coexist-'))
  const installRoot = path.join(fixtureRoot, 'npm-global', 'app')
  const otherPackage = '@aily-project/subapp-other'
  const otherStore = path.join(installRoot, 'store', 'subapp-other')
  const otherVersion = '1.2.3-next'
  const indexPath = path.join(installRoot, 'subapp-index.json')
  const originalIndex = {
    'remote-only': { id: 'remote-only', package: '@aily-project/subapp-remote-only' },
  }
  const localIndex = {
    ...originalIndex,
    other: { id: 'other', package: otherPackage, version: otherVersion },
    dev: true,
  }
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }))

  await mkdir(path.join(otherStore, otherVersion, 'source'), { recursive: true })
  await writeFile(path.join(installRoot, 'package.json'), `${JSON.stringify({
    name: 'aily-installed-subapps', private: true, version: '1.0.0', dependencies: {},
  }, null, 2)}\n`)
  await writeFile(indexPath, `${JSON.stringify(localIndex, null, 2)}\n`)
  await writeFile(`${indexPath}.aily-dev-backup`, `${JSON.stringify(originalIndex, null, 2)}\n`)
  await writeFile(path.join(otherStore, otherVersion, 'ready.json'), `${JSON.stringify({
    schemaVersion: 2,
    complete: true,
    packageName: otherPackage,
    storeKey: 'subapp-other',
    version: otherVersion,
    path: `${otherVersion}/source`,
    distribution: null,
    installMode: 'next',
    installedAt: new Date().toISOString(),
  }, null, 2)}\n`)
  await writeFile(path.join(otherStore, 'active.json'), `${JSON.stringify({
    schemaVersion: 2,
    packageName: otherPackage,
    storeKey: 'subapp-other',
    disabled: false,
    mode: 'pinned',
    selected: { version: otherVersion, path: `${otherVersion}/source` },
    previous: null,
  }, null, 2)}\n`)

  runLink(['--app-root', installRoot, '--skip-build'])
  runLink(['--app-root', installRoot, '--unlink'])

  const retainedIndex = JSON.parse(await readFile(indexPath, 'utf8'))
  assert.equal(retainedIndex.dev, true)
  assert.deepEqual(retainedIndex.other, localIndex.other)
  assert.equal(retainedIndex['aily-coder-editor'], undefined)
  assert.equal(existsSync(`${indexPath}.aily-dev-backup`), true)
  assert.equal(existsSync(path.join(otherStore, otherVersion, 'ready.json')), true)
})

test('dev has priority over next and dev unlink returns to next', async (t) => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'aily-coder-dev-next-priority-'))
  const installRoot = path.join(fixtureRoot, 'npm-global', 'app')
  const storeRoot = path.join(installRoot, 'store', 'subapp-aily-coder-editor')
  const next = `${packageVersion}-next`
  const development = `${packageVersion}-dev`
  const indexPath = path.join(installRoot, 'subapp-index.json')
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }))

  await mkdir(path.join(storeRoot, next), { recursive: true })
  await writeFile(path.join(installRoot, 'package.json'), `${JSON.stringify({
    name: 'aily-installed-subapps', private: true, version: '1.0.0', dependencies: {},
  }, null, 2)}\n`)
  await writeFile(path.join(storeRoot, next, 'ready.json'), `${JSON.stringify({
    schemaVersion: 2,
    complete: true,
    packageName,
    storeKey: 'subapp-aily-coder-editor',
    version: next,
    path: `${next}/source`,
    distribution: null,
    installMode: 'next',
    installedAt: new Date().toISOString(),
  }, null, 2)}\n`)
  const nextActive = {
    schemaVersion: 2,
    packageName,
    storeKey: 'subapp-aily-coder-editor',
    disabled: false,
    mode: 'pinned',
    selected: { version: next, path: `${next}/source` },
    previous: null,
  }
  await writeFile(path.join(storeRoot, 'active.json'), `${JSON.stringify(nextActive, null, 2)}\n`)
  await writeFile(indexPath, `${JSON.stringify({
    'aily-coder-editor': { id: 'aily-coder-editor', package: packageName, version: next },
    dev: true,
  }, null, 2)}\n`)
  await writeFile(`${indexPath}.aily-dev-backup`, '{}\n')

  runLink(['--app-root', installRoot, '--skip-build'])
  assert.equal(JSON.parse(await readFile(path.join(storeRoot, 'active.json'), 'utf8')).selected.version, development)

  runLink(['--app-root', installRoot, '--unlink'])
  assert.equal(JSON.parse(await readFile(path.join(storeRoot, 'active.json'), 'utf8')).selected.version, next)
  assert.equal(existsSync(path.join(storeRoot, development)), false)
  assert.equal(JSON.parse(await readFile(indexPath, 'utf8'))['aily-coder-editor'].version, next)
})
