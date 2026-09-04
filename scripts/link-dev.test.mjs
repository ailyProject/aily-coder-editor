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

  assert.equal((await lstat(packagePath)).isSymbolicLink(), true)
  const installPackage = JSON.parse(await readFile(path.join(installRoot, 'package.json'), 'utf8'))
  assert.equal(installPackage.dependencies[packageName], `file:${packageRoot}`)
  const developmentIndex = JSON.parse(await readFile(indexPath, 'utf8'))
  assert.equal(developmentIndex.dev, true)
  assert.equal(developmentIndex['remote-only'].id, 'remote-only')
  assert.equal(developmentIndex['aily-coder-editor'].package, packageName)
  assert.equal(developmentIndex['aily-coder-editor'].only, 'aily coder')
  assert.equal(developmentIndex['aily-coder-editor'].app.extension, true)
  assert.equal(developmentIndex['aily-coder-editor'].i18n.locales.zh_cn.TITLE, 'Aily Coder Editor')

  runLink(['--app-root', installRoot, '--unlink'])

  assert.equal(existsSync(packagePath), false)
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
