import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const scriptPath = path.join(scriptDir, 'deploy-next.mjs')
const packageRoot = path.resolve(scriptDir, '..')
const sourceManifest = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'))
const packageName = sourceManifest.name
const catalogId = sourceManifest.ailySubapp.id

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`)
}

test('deploy:next invokes build:subapp by default', { skip: process.platform === 'win32' }, async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'aily-coder-deploy-build-test-'))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  const commandDir = path.join(temporary, 'bin')
  const markerPath = path.join(temporary, 'build-command.txt')
  const fakeNpm = path.join(commandDir, 'npm')
  await mkdir(commandDir, { recursive: true })
  await writeFile(fakeNpm, '#!/bin/sh\nprintf "%s\\n" "$*" > "$AILY_BUILD_MARKER"\nexit 23\n')
  await chmod(fakeNpm, 0o755)

  await assert.rejects(execFileAsync(process.execPath, [
    scriptPath,
    '--app-root', path.join(temporary, 'install'),
  ], {
    env: {
      ...process.env,
      AILY_BUILD_MARKER: markerPath,
      PATH: `${commandDir}${path.delimiter}${process.env.PATH || ''}`,
    },
  }), /exited with code 23/)
  assert.equal((await readFile(markerPath, 'utf8')).trim(), 'run build:subapp')
})

test('deploys the packed Coder build as version-next without source files', async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'aily-coder-deploy-next-test-'))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  const artifactRoot = path.join(temporary, 'artifact')
  const installRoot = path.join(temporary, 'Aily Data', 'npm-global', 'app')
  const catalogPath = path.join(temporary, 'catalog.json')
  const next = `${sourceManifest.version}-next`
  const storeRoot = path.join(installRoot, 'store', 'subapp-aily-coder-editor')

  await writeJson(path.join(artifactRoot, 'package.json'), {
    name: packageName,
    version: sourceManifest.version,
    type: 'module',
    main: 'index.js',
    aily: { uiIndex: 'ui/index.html' },
    files: ['index.js', 'runtime', 'ui', 'i18n'],
    dependencies: {},
  })
  await writeJson(catalogPath, {
    [catalogId]: { id: catalogId, package: packageName, version: sourceManifest.version },
  })
  await mkdir(path.join(artifactRoot, 'runtime'), { recursive: true })
  await mkdir(path.join(artifactRoot, 'ui'), { recursive: true })
  await mkdir(path.join(artifactRoot, 'i18n'), { recursive: true })
  await mkdir(path.join(artifactRoot, 'src'), { recursive: true })
  await writeFile(path.join(artifactRoot, 'index.js'), 'import "./runtime/index.js"\n')
  await writeFile(path.join(artifactRoot, 'runtime', 'index.js'), 'export {}\n')
  await writeFile(path.join(artifactRoot, 'ui', 'index.html'), '<main>packed coder</main>\n')
  await writeFile(path.join(artifactRoot, 'i18n', 'en.json'), '{}\n')
  await writeFile(path.join(artifactRoot, 'src', 'not-packaged.ts'), 'throw new Error()\n')

  const deployArgs = [
    scriptPath,
    '--app-root', installRoot,
    '--artifact-root', artifactRoot,
    '--catalog-path', catalogPath,
    '--skip-build',
    '--skip-catalog-generate',
  ]
  await execFileAsync(process.execPath, deployArgs)

  const sourceRoot = path.join(storeRoot, next, 'source')
  const ready = JSON.parse(await readFile(path.join(storeRoot, next, 'ready.json'), 'utf8'))
  const active = JSON.parse(await readFile(path.join(storeRoot, 'active.json'), 'utf8'))
  const installedCatalog = JSON.parse(await readFile(path.join(installRoot, 'subapp-index.json'), 'utf8'))
  assert.equal(JSON.parse(await readFile(path.join(sourceRoot, 'package.json'), 'utf8')).version, next)
  assert.equal(ready.installMode, 'next')
  assert.equal(active.selected.integrity, ready.integrity)
  assert.equal(active.selected.version, next)
  assert.equal(active.previous, null)
  assert.equal(installedCatalog[catalogId].version, next)
  assert.equal(installedCatalog.dev, true)
  assert.equal(existsSync(path.join(sourceRoot, 'src')), false)

  await execFileAsync(process.execPath, [scriptPath, '--app-root', installRoot, '--unlink'])
  assert.equal(existsSync(path.join(storeRoot, next)), false)
  assert.equal(existsSync(path.join(storeRoot, 'active.json')), false)
  assert.equal(existsSync(path.join(installRoot, 'subapp-index.json')), false)

  await execFileAsync(process.execPath, deployArgs)
  const nextActive = JSON.parse(await readFile(path.join(storeRoot, 'active.json'), 'utf8'))
  const development = `${sourceManifest.version}-dev`
  await writeJson(path.join(storeRoot, development, 'ready.json'), {
    schemaVersion: 2,
    complete: true,
    packageName,
    storeKey: 'subapp-aily-coder-editor',
    version: development,
    path: `${development}/source`,
    distribution: null,
    installMode: 'development',
    installedAt: new Date().toISOString(),
  })
  await writeJson(path.join(storeRoot, 'active.json.aily-dev-backup'), nextActive)
  await writeJson(path.join(storeRoot, 'active.json'), {
    ...nextActive,
    selected: { version: development, path: `${development}/source` },
    previous: nextActive.selected,
  })

  await execFileAsync(process.execPath, deployArgs)
  const developmentActive = JSON.parse(await readFile(path.join(storeRoot, 'active.json'), 'utf8'))
  assert.equal(developmentActive.selected.version, development)
  assert.equal(developmentActive.previous.version, next)

  await execFileAsync(process.execPath, [scriptPath, '--app-root', installRoot, '--unlink'])
  const developmentAfterNextUnlink = JSON.parse(await readFile(path.join(storeRoot, 'active.json'), 'utf8'))
  assert.equal(developmentAfterNextUnlink.selected.version, development)
  assert.equal(developmentAfterNextUnlink.previous, null)
  assert.equal(existsSync(path.join(storeRoot, 'active.json.aily-dev-backup')), false)
  assert.equal(existsSync(path.join(storeRoot, next)), false)
  assert.equal(JSON.parse(await readFile(path.join(installRoot, 'subapp-index.json'), 'utf8'))[catalogId].version, development)
})
