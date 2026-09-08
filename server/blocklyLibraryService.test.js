import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { installCoderLibrary, materializeCoderProjectLibraries, removeCoderLibrary, searchCoderLibraries } from './componentLibraryService.js'
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

test('editor catalog and AI RPC share npm installation and persistent multi-root sources', async t => {
  const f = await fixture(t)
  const page = await searchCoderLibraries({ ...f.options, query: '' })
  assert.equal(page.total, 1)
  assert.equal(page.libraries[0].source, 'aily')
  assert.equal(page.libraries[0].libraryRef, libraryRef)
  assert.equal(page.libraries[0].installed, false)
  const router = createCoderAgentRpcRouter({ install: input => installCoderLibrary({ ...f.options, ...input }) })
  const result = await router.execute({ method: 'coder.library.install', params: { libraryRef, version: '1.0.0' },
    context: { actor: 'agent', actorId: 'subapp-agent-host', developmentMode: 'coder', workspaceRoot: f.workspaceRoot } })
  assert.equal(result.library.ready, true)
  assert.deepEqual(result.library.libraryRoots, ['sketch/libraries/Demo', 'sketch/libraries/Support'])
  assert.equal(JSON.parse(await readFile(f.manifestPath, 'utf8')).dependencies[packageName], '1.0.0')
  assert.equal(await readFile(path.join(f.packageRoot, 'src.7z'), 'utf8'), 'archive fixture')
  await assert.rejects(readFile(path.join(f.packageRoot, 'src', 'Demo', 'Demo.h')))
  assert.equal(await readFile(path.join(f.workspaceRoot, 'sketch/libraries/Demo/Demo.h'), 'utf8'), '#pragma once\n')
  const installed = (await searchCoderLibraries({ ...f.options, query: 'Demo' })).libraries[0]
  assert.equal(installed.installed, true)
  assert.equal(installed.managed, true)
  assert.equal(installed.installedVersion, '1.0.0')
  assert.equal((await installCoderLibrary(f.options)).alreadyInstalled, true)
  assert.equal(f.commands.length, 1)
  const removed = await removeCoderLibrary(f.options)
  assert.equal(removed.removed, true)
  assert.deepEqual(await readdir(path.join(f.workspaceRoot, 'sketch/libraries')), [])
  assert.deepEqual(JSON.parse(await readFile(f.manifestPath, 'utf8')).dependencies, {})
})

test('an npm-only package is not installed until Coder materializes its sources', async t => {
  const f = await fixture(t)
  await f.options.runNpmCommand({ args: ['install', `${packageName}@1.0.0`] })
  assert.equal((await searchCoderLibraries({ ...f.options, query: 'Demo' })).libraries[0].installed, false)
  assert.equal((await installCoderLibrary(f.options)).ready, true)
})

test('template dependencies materialize offline through host RPC without changing npm dependencies', async t => {
  const f = await fixture(t)
  await f.options.runNpmCommand({ args: ['install', `${packageName}@1.0.0`] })
  const manifest = JSON.parse(await readFile(f.manifestPath, 'utf8'))
  manifest.dependencies[packageName] = '^1.0.0'
  const noSourceName = '@aily-project/lib-blocks-only'
  manifest.dependencies[noSourceName] = '~2.0.0'
  await writeFile(f.manifestPath, JSON.stringify(manifest))
  const noSourceRoot = path.join(f.workspaceRoot, 'node_modules', noSourceName)
  await mkdir(noSourceRoot, { recursive: true })
  await writeFile(path.join(noSourceRoot, 'package.json'), JSON.stringify({ name: noSourceName, version: '2.0.0' }))
  const lockPath = path.join(f.workspaceRoot, 'package-lock.json')
  await writeFile(lockPath, 'existing lockfile')
  await rm(path.join(f.appDataPath, 'libraries.json'))
  const before = await readFile(f.manifestPath, 'utf8')
  f.commands.length = 0
  const router = createCoderAgentRpcRouter({ materialize: input => materializeCoderProjectLibraries({ ...f.options, ...input }) })
  const result = await router.execute({ method: 'coder.library.materialize', params: { workspaceRoot: '/ignored' },
    context: { actor: 'agent', actorId: 'subapp-agent-host', developmentMode: 'coder', workspaceRoot: f.workspaceRoot } })
  assert.equal(result.ready, true)
  assert.deepEqual(result.libraryRoots, ['sketch/libraries/Demo', 'sketch/libraries/Support'])
  assert.equal(result.libraries.length, 1)
  assert.equal(await readFile(path.join(f.workspaceRoot, 'sketch/libraries/Demo/Demo.h'), 'utf8'), '#pragma once\n')
  assert.equal(await readFile(f.manifestPath, 'utf8'), before)
  assert.equal(await readFile(lockPath, 'utf8'), 'existing lockfile')
  assert.deepEqual(f.commands, [])
  // A second dependency check must preserve edited sources, without re-extracting.
  await writeFile(path.join(f.workspaceRoot, 'sketch/libraries/Demo/Demo.h'), 'local edit')
  const again = await materializeCoderProjectLibraries({ ...f.options, extractArchive: () => { throw new Error('unexpected extraction') } })
  assert.equal(again.libraries[0].alreadyInstalled, true)
  assert.equal(await readFile(path.join(f.workspaceRoot, 'sketch/libraries/Demo/Demo.h'), 'utf8'), 'local edit')
})

test('template packages without src.7z still materialize nested source dependencies', async t => {
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
  const receipt = JSON.parse(await readFile(path.join(f.workspaceRoot, 'sketch/libraries/Demo/.aily-blockly-library.json'), 'utf8'))
  assert.equal(receipt.packageName, dependencyName)
})

test('automatic extraction preserves local conflicts and can retry after an archive failure', async t => {
  const f = await fixture(t)
  await f.options.runNpmCommand({ args: ['install', `${packageName}@1.0.0`] })
  const local = path.join(f.workspaceRoot, 'sketch/libraries/Support')
  await mkdir(local, { recursive: true })
  await writeFile(path.join(local, 'Local.h'), 'local code')
  await assert.rejects(materializeCoderProjectLibraries(f.options), { code: 'BLOCKLY_LIBRARY_PATH_CONFLICT' })
  assert.equal(await readFile(path.join(local, 'Local.h'), 'utf8'), 'local code')
  assert.deepEqual(await readdir(path.dirname(local)), ['Support'])
  await rm(local, { recursive: true })
  await assert.rejects(materializeCoderProjectLibraries({ ...f.options, extractArchive: () => { throw new Error('archive failed') } }), /archive failed/u)
  assert.deepEqual(await readdir(path.dirname(local)), [])
  assert.equal((await materializeCoderProjectLibraries(f.options)).ready, true)
})

test('a short package name in the search index resolves the exact scoped install identity', async t => {
  const f = await fixture(t)
  await writeFile(path.join(f.appDataPath, 'libraries-index.json'), JSON.stringify({ libraries: [{ name: 'lib-demo', displayName: 'Demo' }] }))
  assert.equal((await searchCoderLibraries({ ...f.options, query: packageName })).libraries[0].libraryRef, libraryRef)
  assert.equal((await installCoderLibrary(f.options)).ready, true)
})

test('uses Blockly core and board IDs without marking another board compatible', async t => {
  const f = await fixture(t)
  const boardRoot = path.join(f.workspaceRoot, 'node_modules', '@aily-project', 'board-demo')
  await mkdir(boardRoot, { recursive: true })
  await writeFile(path.join(boardRoot, 'board.json'), JSON.stringify({ core: 'esp32:esp32', type: 'esp32:esp32:board-a' }))
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

test('managed libraries remain searchable and removable after the shared catalog is unavailable', async t => {
  const f = await fixture(t)
  await installCoderLibrary(f.options)
  await rm(path.join(f.appDataPath, 'libraries.json'))
  const search = await searchCoderLibraries({ ...f.options, query: 'Demo', fetchImpl: async () => { throw new Error('offline') } })
  assert.equal(search.libraries[0].installed, true)
  assert.equal(search.libraries[0].managed, true)
  assert.equal(search.libraries[0].installedVersion, '1.0.0')
  assert.equal((await removeCoderLibrary(f.options)).removed, true)
})

test('normalizes consecutive src wrappers while preserving each library internal src', async t => {
  for (const [layout, expected] of [
    ['Library/Header.h', 'Library/Header.h'],
    ['src/Header.h', 'lib-demo/Header.h'],
    ['src/src/bq27220/Header.h', 'bq27220/Header.h'],
    ['src/src/src/bq27220/src/Header.h', 'bq27220/src/Header.h'],
    ['src/src/src/Header.h', 'lib-demo/Header.h'],
  ]) {
    await t.test(layout, async t => {
      const f = await fixture(t)
      const installed = await installCoderLibrary({ ...f.options, extractArchive: async ({ destination }) => {
        const file = path.join(destination, layout)
        await mkdir(path.dirname(file), { recursive: true })
        await writeFile(file, '#pragma once\n')
      } })
      assert.equal(installed.sourceDirectory, `sketch/libraries/${expected.split('/')[0]}`)
      assert.equal(await readFile(path.join(f.workspaceRoot, 'sketch/libraries', expected), 'utf8'), '#pragma once\n')
    })
  }
})

test('automatic dependency installation flattens multiple libraries below the last src wrapper', async t => {
  const f = await fixture(t)
  await f.options.runNpmCommand({ args: ['install', `${packageName}@1.0.0`] })
  f.commands.length = 0
  const result = await materializeCoderProjectLibraries({ ...f.options, extractArchive: async ({ destination }) => {
    for (const name of ['bq27220', 'Support']) {
      const directory = path.join(destination, 'src/src/src', name)
      await mkdir(directory, { recursive: true })
      await writeFile(path.join(directory, 'Header.h'), '#pragma once\n')
    }
  } })
  assert.deepEqual([...result.libraryRoots].sort(), ['sketch/libraries/Support', 'sketch/libraries/bq27220'])
  assert.deepEqual(f.commands, [])
  await assert.rejects(readFile(path.join(f.workspaceRoot, 'sketch/libraries/src')), { code: 'ENOENT' })
})

async function legacySourceWrapperFixture(t) {
  const f = await fixture(t)
  const extractArchive = async ({ destination }) => {
    const directory = path.join(destination, 'src/LegacyWrapper/bq27220')
    await mkdir(directory, { recursive: true })
    await writeFile(path.join(directory, 'Header.h'), '#pragma once\n')
  }
  await installCoderLibrary({ ...f.options, extractArchive })
  const root = path.join(f.workspaceRoot, 'sketch/libraries/src')
  await rename(path.join(f.workspaceRoot, 'sketch/libraries/LegacyWrapper'), root)
  const receiptPath = path.join(root, '.aily-blockly-library.json')
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8'))
  delete receipt.sourceLayoutVersion
  receipt.libraryRoot = 'src'
  receipt.libraryRoots = ['src']
  await writeFile(receiptPath, JSON.stringify(receipt))
  f.options.extractArchive = async ({ destination }) => {
    const directory = path.join(destination, 'src/src/bq27220')
    await mkdir(directory, { recursive: true })
    await writeFile(path.join(directory, 'Header.h'), '#pragma once\n')
  }
  return { ...f, root }
}

test('repairs old managed src roots at the same version and then remains idempotent', async t => {
  const f = await legacySourceWrapperFixture(t)
  const manifest = await readFile(f.manifestPath, 'utf8')
  const result = await materializeCoderProjectLibraries(f.options)
  assert.deepEqual(result.libraryRoots, ['sketch/libraries/bq27220'])
  assert.equal(result.libraries[0].alreadyInstalled, false)
  await assert.rejects(readdir(f.root), { code: 'ENOENT' })
  assert.equal(await readFile(path.join(f.workspaceRoot, 'sketch/libraries/bq27220/Header.h'), 'utf8'), '#pragma once\n')
  assert.equal(await readFile(f.manifestPath, 'utf8'), manifest)
  const again = await materializeCoderProjectLibraries({ ...f.options, extractArchive: () => { throw new Error('unexpected extraction') } })
  assert.equal(again.libraries[0].alreadyInstalled, true)
})

test('old src layout repair preserves local edits and conflicting target libraries', async t => {
  const f = await legacySourceWrapperFixture(t)
  const header = path.join(f.root, 'bq27220/Header.h')
  await writeFile(header, 'user edit')
  await assert.rejects(materializeCoderProjectLibraries(f.options), { code: 'BLOCKLY_LIBRARY_PROVENANCE_CONFLICT' })
  assert.equal(await readFile(header, 'utf8'), 'user edit')
  await writeFile(header, '#pragma once\n')
  const target = path.join(f.workspaceRoot, 'sketch/libraries/bq27220')
  await mkdir(target)
  await writeFile(path.join(target, 'Local.h'), 'user library')
  await assert.rejects(materializeCoderProjectLibraries(f.options), { code: 'BLOCKLY_LIBRARY_PATH_CONFLICT' })
  assert.equal(await readFile(header, 'utf8'), '#pragma once\n')
  assert.equal(await readFile(path.join(target, 'Local.h'), 'utf8'), 'user library')
})

test('source conflicts and archive failures restore package metadata and preserve local files', async t => {
  const f = await fixture(t)
  const local = path.join(f.workspaceRoot, 'sketch/libraries/Support')
  await mkdir(local, { recursive: true })
  await writeFile(path.join(local, 'Local.h'), 'local code')
  const before = await readFile(f.manifestPath, 'utf8')
  await assert.rejects(installCoderLibrary(f.options), error => error.code === 'BLOCKLY_LIBRARY_PATH_CONFLICT')
  assert.equal(await readFile(f.manifestPath, 'utf8'), before)
  assert.equal(await readFile(path.join(local, 'Local.h'), 'utf8'), 'local code')
  await assert.rejects(readFile(path.join(f.packageRoot, 'package.json')))
  await assert.rejects(readFile(path.join(f.workspaceRoot, 'sketch/libraries/Demo/Demo.h')))
  await assert.rejects(installCoderLibrary({ ...f.options, extractArchive: async () => { throw new Error('bad archive') } }), /bad archive/)
  assert.equal(await readFile(f.manifestPath, 'utf8'), before)
})

test('rejects archive symlinks and restores a previous package/source version on failed upgrade', async t => {
  const f = await fixture(t)
  await installCoderLibrary(f.options)
  f.catalog[0].version = '2.0.0'
  await f.writeCatalog()
  await assert.rejects(installCoderLibrary({ ...f.options, version: '2.0.0', extractArchive: async ({ destination }) => {
    await mkdir(path.join(destination, 'src'), { recursive: true })
    await symlink(f.manifestPath, path.join(destination, 'src', 'Escape.h'))
  } }), error => error.code === 'BLOCKLY_LIBRARY_ARCHIVE_UNSAFE')
  assert.equal(JSON.parse(await readFile(path.join(f.packageRoot, 'package.json'), 'utf8')).version, '1.0.0')
  assert.equal(JSON.parse(await readFile(f.manifestPath, 'utf8')).dependencies[packageName], '1.0.0')
  assert.equal(await readFile(path.join(f.workspaceRoot, 'sketch/libraries/Demo/Demo.h'), 'utf8'), '#pragma once\n')
})

test('upgrades all managed roots, removes obsolete roots, and refuses modified source removal', async t => {
  const f = await fixture(t)
  await installCoderLibrary(f.options)
  f.catalog[0].version = '2.0.0'
  await f.writeCatalog()
  const upgraded = await installCoderLibrary({ ...f.options, version: '2.0.0', extractArchive: async ({ destination }) => {
    await mkdir(path.join(destination, 'src', 'Demo'), { recursive: true })
    await writeFile(path.join(destination, 'src', 'Demo', 'Demo.h'), '#pragma once\n// v2\n')
  } })
  assert.deepEqual(upgraded.libraryRoots, ['sketch/libraries/Demo'])
  assert.deepEqual(await readdir(path.join(f.workspaceRoot, 'sketch/libraries')), ['Demo'])
  await assert.rejects(removeCoderLibrary(f.options), error => error.code === 'BLOCKLY_LIBRARY_PROVENANCE_CONFLICT')
  await writeFile(path.join(f.workspaceRoot, 'sketch/libraries/Demo/Demo.h'), 'custom changes')
  await assert.rejects(removeCoderLibrary({ ...f.options, version: '2.0.0' }), error => error.code === 'BLOCKLY_LIBRARY_PROVENANCE_CONFLICT')
  assert.equal(await readFile(path.join(f.workspaceRoot, 'sketch/libraries/Demo/Demo.h'), 'utf8'), 'custom changes')
})

test('failed npm removal restores all source roots and the original npm association', async t => {
  const f = await fixture(t)
  await installCoderLibrary(f.options)
  await assert.rejects(removeCoderLibrary({ ...f.options, runNpmCommand: async input => {
    await f.options.runNpmCommand(input)
    throw new Error('npm failed')
  } }), /npm failed/)
  assert.equal(JSON.parse(await readFile(f.manifestPath, 'utf8')).dependencies[packageName], '1.0.0')
  assert.equal((await searchCoderLibraries({ ...f.options, query: 'Demo' })).libraries[0].installed, true)
})

test('rejects incompatible shared Aily packages before npm unless explicitly overridden', async t => {
  const f = await fixture(t)
  f.catalog[0].compatibility.core = ['esp32']
  await f.writeCatalog()
  await assert.rejects(installCoderLibrary(f.options), error => error.code === 'CODER_LIBRARY_INCOMPATIBLE')
  assert.equal(f.commands.length, 0)
  const installed = await installCoderLibrary({ ...f.options, allowIncompatible: true })
  assert.equal(installed.compatibilityOverride, true)
  assert.equal(installed.ready, true)
})

test('refreshes only the shared Blockly catalogs using the selected regional resource', async t => {
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

test('materializes npm library dependencies, shares matching sources, and protects dependencies still in use', async t => {
  const f = await fixture(t)
  const shared = '@aily-project/lib-shared'
  const second = '@aily-project/lib-second'
  f.catalog.push({ name: shared, nickname: 'Shared', version: '1.0.0' }, { name: second, nickname: 'Second', version: '1.0.0' })
  await f.writeCatalog()
  const packageDirectory = name => path.join(f.workspaceRoot, 'node_modules', ...name.split('/'))
  const writePackage = async (name, version) => {
    const directory = packageDirectory(name)
    await mkdir(directory, { recursive: true })
    await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name, version,
      dependencies: name === shared ? {} : { [shared]: '1.0.0' } }))
    await writeFile(path.join(directory, 'src.7z'), 'archive fixture')
  }
  const runNpmCommand = async ({ args }) => {
    const manifest = JSON.parse(await readFile(f.manifestPath, 'utf8'))
    if (args[0] === 'install') {
      const at = args[1].lastIndexOf('@'), name = args[1].slice(0, at), version = args[1].slice(at + 1)
      await writePackage(name, version)
      if (name !== shared) await writePackage(shared, '1.0.0')
      manifest.dependencies[name] = version
    } else {
      delete manifest.dependencies[args[1]]
      await rm(packageDirectory(args[1]), { recursive: true, force: true })
    }
    await writeFile(f.manifestPath, JSON.stringify(manifest))
  }
  const extractArchive = async ({ archivePath, destination }) => {
    const name = archivePath.includes('lib-shared') ? 'Shared' : archivePath.includes('lib-second') ? 'Second' : 'Demo'
    await mkdir(path.join(destination, 'src', name), { recursive: true })
    await writeFile(path.join(destination, 'src', name, `${name}.h`), '#pragma once\n')
  }
  const options = { ...f.options, runNpmCommand, extractArchive }
  const installed = await installCoderLibrary(options)
  assert.deepEqual(installed.libraryRoots, ['sketch/libraries/Demo', 'sketch/libraries/Shared'])
  assert.equal((await searchCoderLibraries({ ...options, query: 'Shared' })).libraries[0].installed, true)
  // A parent installed by the old layout must also repair its dependency's wrapper root.
  const sources = path.join(f.workspaceRoot, 'sketch/libraries')
  await rename(path.join(sources, 'Shared'), path.join(sources, 'src'))
  const sharedReceiptPath = path.join(sources, 'src/.aily-blockly-library.json')
  const sharedReceipt = JSON.parse(await readFile(sharedReceiptPath, 'utf8'))
  delete sharedReceipt.sourceLayoutVersion
  sharedReceipt.libraryRoot = 'src'
  sharedReceipt.libraryRoots = ['src']
  await writeFile(sharedReceiptPath, JSON.stringify(sharedReceipt))
  const parentReceiptPath = path.join(sources, 'Demo/.aily-blockly-library.json')
  const parentReceipt = JSON.parse(await readFile(parentReceiptPath, 'utf8'))
  parentReceipt.dependencyLibraries[0].libraryRoots = ['src']
  await writeFile(parentReceiptPath, JSON.stringify(parentReceipt))
  assert.deepEqual((await materializeCoderProjectLibraries(options)).libraryRoots, ['sketch/libraries/Demo', 'sketch/libraries/Shared'])
  assert.deepEqual(await readdir(sources), ['Demo', 'Shared'])
  await installCoderLibrary({ ...options, libraryRef: `blockly:${second}` })
  assert.deepEqual(await readdir(path.join(f.workspaceRoot, 'sketch/libraries')), ['Demo', 'Second', 'Shared'])
  await removeCoderLibrary(options)
  await assert.rejects(removeCoderLibrary({ ...options, libraryRef: `blockly:${shared}` }), error => error.code === 'BLOCKLY_LIBRARY_IN_USE')
  await removeCoderLibrary({ ...options, libraryRef: `blockly:${second}` })
  await removeCoderLibrary({ ...options, libraryRef: `blockly:${shared}` })
  assert.deepEqual(await readdir(path.join(f.workspaceRoot, 'sketch/libraries')), [])
})
