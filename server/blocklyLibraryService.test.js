import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  installCoderLibrary,
  localizeCoderLibrary,
  materializeCoderProjectLibraries,
  removeCoderLibrary,
  searchCoderLibraries,
} from './componentLibraryService.js'
import { createCoderAgentRpcRouter } from './agentRpcRouter.js'

const packageName = '@aily-project/lib-demo'
const libraryRef = `blockly:${packageName}`

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'aily-shared-library-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const workspaceRoot = path.join(directory, 'project')
  const appDataPath = path.join(directory, 'appdata')
  await mkdir(workspaceRoot)
  await mkdir(appDataPath)
  const manifestPath = path.join(workspaceRoot, 'package.json')
  await writeFile(manifestPath, JSON.stringify({ name: 'test', type: 'coder', dependencies: {} }))
  const catalog = [{ name: packageName, nickname: 'Demo', version: '1.0.0', description: 'Timer demo', compatibility: { core: [] } }]
  const writeCatalog = () => writeFile(path.join(appDataPath, 'libraries.json'), JSON.stringify(catalog))
  await writeCatalog()
  const packageRoot = path.join(workspaceRoot, 'node_modules', '@aily-project', 'lib-demo')
  const commands = []
  const runNpmCommand = async ({ args }) => {
    commands.push(args)
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    if (args[0] === 'install') {
      const version = args[1].split('@').at(-1)
      await rm(packageRoot, { recursive: true, force: true })
      await mkdir(packageRoot, { recursive: true })
      await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ name: packageName, version }))
      await writeFile(path.join(packageRoot, 'src.7z'), 'archive fixture')
      manifest.dependencies[packageName] = version
    } else {
      delete manifest.dependencies[packageName]
      await rm(packageRoot, { recursive: true, force: true })
    }
    await writeFile(manifestPath, JSON.stringify(manifest))
  }
  const extractArchive = async ({ destination }) => {
    for (const name of ['Demo', 'Support']) {
      await mkdir(path.join(destination, 'src', name), { recursive: true })
      await writeFile(path.join(destination, 'src', name, `${name}.h`), '#pragma once\n')
    }
  }
  const options = { workspaceRoot, appDataPath, libraryRef, version: '1.0.0', runNpmCommand, extractArchive }
  return { options, workspaceRoot, appDataPath, manifestPath, packageRoot, commands, catalog, writeCatalog }
}

test('installs npm source beside src.7z and reports package-local library roots', async t => {
  const f = await fixture(t)
  const before = await searchCoderLibraries({ ...f.options, query: 'Demo' })
  assert.equal(before.libraries[0].installed, false)
  const router = createCoderAgentRpcRouter({ install: input => installCoderLibrary({ ...f.options, ...input }) })
  const result = await router.execute({ method: 'coder.library.install', params: { libraryRef, version: '1.0.0' },
    context: { actor: 'agent', actorId: 'subapp-agent-host', developmentMode: 'coder', workspaceRoot: f.workspaceRoot } })
  assert.equal(result.library.ready, true)
  assert.equal(result.library.sourceLayout, 'package-local')
  assert.deepEqual(result.library.libraryRoots, [
    'node_modules/@aily-project/lib-demo/src/Demo',
    'node_modules/@aily-project/lib-demo/src/Support',
  ])
  assert.equal(await readFile(path.join(f.packageRoot, 'src/Demo/Demo.h'), 'utf8'), '#pragma once\n')
  await assert.rejects(readdir(path.join(f.workspaceRoot, 'sketch/libraries')), { code: 'ENOENT' })
  const state = (await searchCoderLibraries({ ...f.options, query: 'Demo' })).libraries[0]
  assert.equal(state.installed, true)
  assert.equal(state.managed, true)
  assert.equal(state.ready, true)
  assert.equal((await installCoderLibrary(f.options)).alreadyInstalled, true)
  assert.equal(f.commands.length, 1)
  assert.equal((await removeCoderLibrary(f.options)).removed, true)
  assert.deepEqual(JSON.parse(await readFile(f.manifestPath, 'utf8')).dependencies, {})
})

test('prepares npm-installed template dependencies offline without changing manifests', async t => {
  const f = await fixture(t)
  await f.options.runNpmCommand({ args: ['install', `${packageName}@1.0.0`] })
  const unprepared = (await searchCoderLibraries({ ...f.options, query: 'Demo' })).libraries[0]
  assert.equal(unprepared.installed, true)
  assert.equal(unprepared.managed, true)
  assert.equal(unprepared.ready, false)
  const manifest = JSON.parse(await readFile(f.manifestPath, 'utf8'))
  manifest.dependencies[packageName] = '^1.0.0'
  await writeFile(f.manifestPath, JSON.stringify(manifest))
  const lockPath = path.join(f.workspaceRoot, 'package-lock.json')
  await writeFile(lockPath, 'existing lockfile')
  await rm(path.join(f.appDataPath, 'libraries.json'))
  const before = await readFile(f.manifestPath, 'utf8')
  f.commands.length = 0
  const router = createCoderAgentRpcRouter({ materialize: input => materializeCoderProjectLibraries({ ...f.options, ...input }) })
  const result = await router.execute({ method: 'coder.library.materialize', params: {},
    context: { actor: 'agent', actorId: 'subapp-agent-host', developmentMode: 'coder', workspaceRoot: f.workspaceRoot } })
  assert.equal(result.ready, true)
  assert.deepEqual(result.libraryRoots, [
    'node_modules/@aily-project/lib-demo/src/Demo',
    'node_modules/@aily-project/lib-demo/src/Support',
  ])
  assert.equal(await readFile(f.manifestPath, 'utf8'), before)
  assert.equal(await readFile(lockPath, 'utf8'), 'existing lockfile')
  assert.deepEqual(f.commands, [])
  const again = await materializeCoderProjectLibraries({ ...f.options, extractArchive: () => { throw new Error('unexpected extraction') } })
  assert.equal(again.libraries[0].alreadyInstalled, true)
})

test('packages without source still prepare nested Aily dependencies', async t => {
  const f = await fixture(t)
  await f.options.runNpmCommand({ args: ['install', `${packageName}@1.0.0`] })
  await rm(path.join(f.packageRoot, 'src.7z'))
  const dependencyName = '@aily-project/lib-nested'
  const dependencyRoot = path.join(f.packageRoot, 'node_modules', dependencyName)
  await mkdir(dependencyRoot, { recursive: true })
  await writeFile(path.join(f.packageRoot, 'package.json'), JSON.stringify({ name: packageName, version: '1.0.0', dependencies: { [dependencyName]: '^2.0.0' } }))
  await writeFile(path.join(dependencyRoot, 'package.json'), JSON.stringify({ name: dependencyName, version: '2.0.0' }))
  await writeFile(path.join(dependencyRoot, 'src.7z'), 'nested archive')
  const result = await materializeCoderProjectLibraries(f.options)
  assert.equal(result.ready, true)
  assert.equal(result.libraries[0].packageName, dependencyName)
  assert.equal(await readFile(path.join(dependencyRoot, 'src/Demo/Demo.h'), 'utf8'), '#pragma once\n')
  const state = (await searchCoderLibraries({ ...f.options, query: 'Demo' })).libraries[0]
  assert.equal(state.sourceDirectory, '')
  const localized = await localizeCoderLibrary({ ...f.options, libraryRoot: state.libraryRoots[0] })
  assert.deepEqual(localized.localRoots, ['sketch/libraries/Demo'])
  const removed = await removeCoderLibrary(f.options)
  assert.deepEqual(removed.preservedLocalRoots, ['sketch/libraries/Demo'])
  assert.equal(await readFile(path.join(f.workspaceRoot, 'sketch/libraries/Demo/Demo.h'), 'utf8'), '#pragma once\n')
})

test('normalizes consecutive src wrappers while preserving a library internal src', async t => {
  for (const [layout, expectedRoot, expectedFile] of [
    ['Library/Header.h', 'node_modules/@aily-project/lib-demo/src/Library', 'src/Library/Header.h'],
    ['src/Header.h', 'node_modules/@aily-project/lib-demo/src', 'src/Header.h'],
    ['src/src/bq27220/Header.h', 'node_modules/@aily-project/lib-demo/src/src/bq27220', 'src/src/bq27220/Header.h'],
    ['src/src/src/bq27220/src/Header.h', 'node_modules/@aily-project/lib-demo/src/src/src/bq27220', 'src/src/src/bq27220/src/Header.h'],
  ]) {
    await t.test(layout, async t => {
      const f = await fixture(t)
      const installed = await installCoderLibrary({ ...f.options, extractArchive: async ({ destination }) => {
        const file = path.join(destination, layout)
        await mkdir(path.dirname(file), { recursive: true })
        await writeFile(file, '#pragma once\n')
        await writeFile(path.join(destination, '.DS_Store'), 'ignored')
      } })
      assert.equal(installed.sourceDirectory, expectedRoot)
      assert.equal(await readFile(path.join(f.packageRoot, expectedFile), 'utf8'), '#pragma once\n')
    })
  }
})

test('localizes an exact package root for editing and npm removal preserves it', async t => {
  const f = await fixture(t)
  const installed = await installCoderLibrary(f.options)
  await assert.rejects(localizeCoderLibrary(f.options), { code: 'CODER_LIBRARY_ROOT_INVALID' })
  const sourceRoot = installed.libraryRoots[0]
  const localized = await localizeCoderLibrary({ ...f.options, libraryRoot: sourceRoot })
  assert.deepEqual(localized.localRoots, ['sketch/libraries/Demo'])
  const localHeader = path.join(f.workspaceRoot, 'sketch/libraries/Demo/Demo.h')
  await writeFile(localHeader, 'Aily Chat edit')
  const again = await localizeCoderLibrary({ ...f.options, libraryRoot: sourceRoot })
  assert.deepEqual(again.localRoots, ['sketch/libraries/Demo'])
  assert.equal(await readFile(localHeader, 'utf8'), 'Aily Chat edit')
  const receipt = JSON.parse(await readFile(path.join(f.workspaceRoot, 'sketch/libraries/Demo/.aily-coder-local-library.json'), 'utf8'))
  assert.equal(receipt.source, 'aily-chat')
  const removed = await removeCoderLibrary(f.options)
  assert.deepEqual(removed.preservedLocalRoots, ['sketch/libraries/Demo'])
  assert.equal(await readFile(localHeader, 'utf8'), 'Aily Chat edit')
})

test('localization never overwrites an independent local library', async t => {
  const f = await fixture(t)
  const installed = await installCoderLibrary(f.options)
  const target = path.join(f.workspaceRoot, 'sketch/libraries/Demo')
  await mkdir(target, { recursive: true })
  await writeFile(path.join(target, 'Local.h'), 'local code')
  await assert.rejects(localizeCoderLibrary({ ...f.options, libraryRoot: installed.libraryRoots[0] }), {
    code: 'BLOCKLY_LIBRARY_PATH_CONFLICT',
  })
  assert.equal(await readFile(path.join(target, 'Local.h'), 'utf8'), 'local code')
})

test('a short shared-index name resolves the exact scoped package identity', async t => {
  const f = await fixture(t)
  await writeFile(path.join(f.appDataPath, 'libraries-index.json'), JSON.stringify({
    libraries: [{ name: 'lib-demo', displayName: 'Demo' }],
  }))
  const result = await searchCoderLibraries({ ...f.options, query: packageName })
  assert.equal(result.libraries[0].libraryRef, libraryRef)
  assert.equal((await installCoderLibrary(f.options)).ready, true)
})

test('uses specific Blockly core and board IDs for package compatibility', async t => {
  const f = await fixture(t)
  const boardRoot = path.join(f.workspaceRoot, 'node_modules', '@aily-project', 'board-demo')
  await mkdir(boardRoot, { recursive: true })
  await writeFile(path.join(boardRoot, 'board.json'), JSON.stringify({
    core: 'esp32:esp32',
    type: 'esp32:esp32:board-a',
  }))
  const manifest = JSON.parse(await readFile(f.manifestPath, 'utf8'))
  manifest.dependencies['@aily-project/board-demo'] = '1.0.0'
  await writeFile(f.manifestPath, JSON.stringify(manifest))
  f.catalog[0].compatibility.core = ['esp32:esp32']
  await f.writeCatalog()
  assert.equal((await searchCoderLibraries({ ...f.options, query: 'Demo' })).libraries[0].compatible, true)
  f.catalog[0].compatibility.core = ['esp32:esp32:board-b']
  await f.writeCatalog()
  assert.equal((await searchCoderLibraries({ ...f.options, query: 'Demo' })).libraries[0].compatible, false)
})

test('prepared packages remain searchable and removable while the catalog is offline', async t => {
  const f = await fixture(t)
  await installCoderLibrary(f.options)
  await rm(path.join(f.appDataPath, 'libraries.json'))
  const search = await searchCoderLibraries({
    ...f.options,
    query: 'Demo',
    fetchImpl: async () => { throw new Error('offline') },
  })
  assert.equal(search.libraries[0].installed, true)
  assert.equal(search.libraries[0].managed, true)
  assert.equal(search.libraries[0].installedVersion, '1.0.0')
  assert.equal((await removeCoderLibrary(f.options)).removed, true)
})

test('archive validation failure rolls back npm metadata and previous package version', async t => {
  const f = await fixture(t)
  await installCoderLibrary(f.options)
  f.catalog[0].version = '2.0.0'
  await f.writeCatalog()
  await assert.rejects(installCoderLibrary({ ...f.options, version: '2.0.0', extractArchive: async ({ destination }) => {
    await mkdir(path.join(destination, 'src'), { recursive: true })
    await symlink(f.manifestPath, path.join(destination, 'src', 'Escape.h'))
  } }), { code: 'BLOCKLY_LIBRARY_ARCHIVE_UNSAFE' })
  assert.equal(JSON.parse(await readFile(path.join(f.packageRoot, 'package.json'), 'utf8')).version, '1.0.0')
  assert.equal(await readFile(path.join(f.packageRoot, 'src/Demo/Demo.h'), 'utf8'), '#pragma once\n')
})

test('a failed npm removal restores the package, prepared source and root dependency', async t => {
  const f = await fixture(t)
  await installCoderLibrary(f.options)
  await assert.rejects(removeCoderLibrary({ ...f.options, runNpmCommand: async input => {
    await f.options.runNpmCommand(input)
    throw new Error('npm failed')
  } }), /npm failed/u)
  assert.equal(JSON.parse(await readFile(f.manifestPath, 'utf8')).dependencies[packageName], '1.0.0')
  assert.equal(JSON.parse(await readFile(path.join(f.packageRoot, 'package.json'), 'utf8')).version, '1.0.0')
  assert.equal(await readFile(path.join(f.packageRoot, 'src/Demo/Demo.h'), 'utf8'), '#pragma once\n')
})

test('rejects incompatible libraries before npm unless explicitly overridden', async t => {
  const f = await fixture(t)
  f.catalog[0].compatibility.core = ['esp32']
  await f.writeCatalog()
  await assert.rejects(installCoderLibrary(f.options), { code: 'CODER_LIBRARY_INCOMPATIBLE' })
  assert.equal(f.commands.length, 0)
  assert.equal((await installCoderLibrary({ ...f.options, allowIncompatible: true })).compatibilityOverride, true)
})

test('refreshes the shared catalogs from the selected regional resource', async t => {
  const f = await fixture(t)
  await writeFile(path.join(f.appDataPath, 'config.json'), JSON.stringify({ region: 'eu', regions: { eu: { resource: 'https://example.test' } } }))
  const fetched = []
  const result = await searchCoderLibraries({ ...f.options, query: '', forceRefresh: true, fetchImpl: async url => {
    fetched.push(url)
    return new globalThis.Response(JSON.stringify(url.endsWith('libraries.json') ? f.catalog : { libraries: [{ name: 'lib-demo', displayName: 'Demo' }] }))
  } })
  assert.equal(result.total, 1)
  assert.deepEqual(fetched.sort(), ['https://example.test/libraries-index.json', 'https://example.test/libraries.json'])
})
