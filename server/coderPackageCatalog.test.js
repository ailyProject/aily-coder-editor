import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { loadCoderPackageCatalog } from './coderPackageCatalog.js'
import { createCoderAgentRpcRouter } from './agentRpcRouter.js'
import {
  installArduinoComponentLibrary, installCoderLibrary, localizeCoderLibrary, materializeCoderProjectLibraries,
  removeArduinoComponentLibrary, removeCoderLibrary, searchArduinoComponentLibraries, searchCoderLibraries,
} from './componentLibraryService.js'

const packageName = '@aily-project-coder/lib-demo'
const libraryRef = `coder:${packageName}`

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aily-official-npm-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const workspaceRoot = path.join(root, 'project'), appDataPath = path.join(root, 'appdata')
  await mkdir(workspaceRoot); await mkdir(appDataPath)
  const manifestPath = path.join(workspaceRoot, 'package.json')
  const packageRoot = path.join(workspaceRoot, 'node_modules', packageName)
  await writeFile(manifestPath, JSON.stringify({ name: 'test', type: 'coder', dependencies: {} }))
  await writeFile(path.join(appDataPath, 'libraries.json'), JSON.stringify([{ name: '@aily-project/lib-other', nickname: 'Other', version: '1.0.0' }]))
  const catalog = [{ name: packageName, nickname: 'Official Demo', version: '1.0.0', description: 'Stepper motor control',
    category: 'Device Control', architectures: ['*'], author: 'Arduino Author', homepage: 'https://example.com/demo',
    providesIncludes: ['Demo.h'], license: 'MIT' }]
  const requests = [], commands = []
  const fetchImpl = async url => { requests.push(url); return new globalThis.Response(JSON.stringify({ libraries: catalog })) }
  const runNpmCommand = async ({ args, env }) => {
    commands.push({ args, env })
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    if (args[0] === 'install') {
      const version = args[1].split('@').at(-1)
      await mkdir(packageRoot, { recursive: true })
      await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ name: packageName, version }))
      await writeFile(path.join(packageRoot, 'src.7z'), 'archive')
      manifest.dependencies[packageName] = version
    } else {
      delete manifest.dependencies[packageName]
      await rm(packageRoot, { recursive: true, force: true })
    }
    await writeFile(manifestPath, JSON.stringify(manifest))
  }
  const extractArchive = async ({ destination }) => {
    await mkdir(path.join(destination, 'src/Demo/src'), { recursive: true })
    await writeFile(path.join(destination, 'src/Demo/src/Demo.h'), '#pragma once\n')
    await writeFile(path.join(destination, 'src/Demo/library.properties'), 'name=Official Demo\nversion=1.0.0\n')
  }
  const options = { workspaceRoot, appDataPath, fetchImpl, runNpmCommand, extractArchive, libraryRef, version: '1.0.0' }
  return { options, appDataPath, workspaceRoot, manifestPath, packageRoot, catalog, requests, commands }
}

test('install, search and materialize report missing Arduino dependencies before compilation', async t => {
  const f = await fixture(t)
  const options = { ...f.options, extractArchive: async args => {
    await f.options.extractArchive(args)
    await writeFile(path.join(args.destination, 'src/Demo/library.properties'),
      'name=Official Demo\nversion=1.0.0\ndepends=Adafruit Unified Sensor (>=1.1.0)\n')
  } }
  const installed = await installCoderLibrary(options)
  assert.equal(installed.sourceReady, true)
  assert.equal(installed.ready, false)
  assert.equal(installed.dependenciesReady, false)
  assert.equal(installed.dependencyIssues[0].name, 'Adafruit Unified Sensor')
  assert.equal((await searchCoderLibraries({ ...options, source: 'registry', query: 'Official Demo' })).libraries[0].ready, false)
  assert.equal((await materializeCoderProjectLibraries(options)).ready, false)
  // A local library can satisfy the same contract. No special DHT/package-name mapping.
  const sensor = path.join(f.workspaceRoot, 'sketch/libraries/Sensor')
  await mkdir(sensor, { recursive: true })
  await writeFile(path.join(sensor, 'library.properties'), 'name=Adafruit Unified Sensor\nversion=1.1.15\n')
  const ready = await installCoderLibrary(options)
  assert.equal(ready.ready, true)
  assert.equal(ready.dependenciesReady, true)
  assert.equal(f.commands.length, 1, 'readiness recheck must not reinstall the selected package')
})

test('exact official name outranks installed broad matches; Agent projects summaries without trimming descriptions', async t => {
  const f = await fixture(t)
  f.catalog.push({ name: '@aily-project-coder/lib-target', nickname: 'Adafruit Unified Sensor', version: '2.0.0',
    architectures: ['*'], description: 'accurate '.repeat(100), customMetadata: { keep: true } })
  f.catalog[0].description = 'Adafruit Unified Sensor compatible adapter'
  await installCoderLibrary(f.options)
  const options = { ...f.options, source: 'registry', query: 'Adafruit Unified Sensor', forceRefresh: true }
  const result = await searchCoderLibraries(options)
  assert.equal(result.libraries[0].packageName, '@aily-project-coder/lib-target')
  const router = createCoderAgentRpcRouter({ search: input => searchCoderLibraries({ ...f.options, ...input }) })
  const context = { actor: 'agent', actorId: 'subapp-agent-host', developmentMode: 'coder', workspaceRoot: f.workspaceRoot }
  const summary = await router.execute({ method: 'coder.library.search', context, params: { query: options.query, source: 'registry', limit: 1 } })
  assert.equal(summary.detail, 'summary')
  assert.equal(summary.categories, undefined)
  assert.equal(summary.libraries[0].description, f.catalog[1].description)
  assert.equal(summary.libraries[0].sentence, undefined)
  assert.equal(summary.nextOffset, 1)
  const full = await router.execute({ method: 'coder.library.search', context, params: { query: options.query, source: 'registry', detail: 'full', limit: 1, offset: 1 } })
  assert.ok(Array.isArray(full.categories))
  assert.equal(full.libraries[0].packageName, packageName)
  assert.equal(full.nextOffset, null)
})

test('official editor list and Agent use regional npm packages and the Aily install/remove lifecycle', async t => {
  const f = await fixture(t)
  const page = await searchArduinoComponentLibraries({ ...f.options, query: 'motor', category: 'Device Control' })
  assert.deepEqual(f.requests, ['https://blockly.yiyu.pro/libraries-coder-index.json'])
  const library = page.libraries[0]
  assert.equal(library.libraryRef, libraryRef)
  assert.equal(library.source, 'registry')
  assert.equal(library.name, 'Official Demo')
  assert.equal(library.url, 'https://example.com/demo')
  assert.equal(library.license, 'MIT')
  assert.deepEqual(library.providesIncludes, ['Demo.h'])
  assert.deepEqual(page.categories, ['Device Control'])
  assert.equal((await searchArduinoComponentLibraries({ ...f.options, category: 'Display' })).total, 0)
  const router = createCoderAgentRpcRouter({ search: input => searchCoderLibraries({ ...f.options, ...input }),
    install: input => installCoderLibrary({ ...f.options, ...input }), remove: input => removeCoderLibrary({ ...f.options, ...input }) })
  const context = { actor: 'agent', actorId: 'subapp-agent-host', developmentMode: 'coder', workspaceRoot: f.workspaceRoot }
  const search = await router.execute({ method: 'coder.library.search', context, params: { query: 'motor', source: 'registry' } })
  assert.equal(search.libraries[0].libraryRef, libraryRef)
  const installed = await router.execute({ method: 'coder.library.install', context, params: { libraryRef, version: '1.0.0' } })
  assert.equal(installed.library.source, 'registry')
  assert.equal(installed.library.ready, true)
  assert.equal(installed.library.packageJsonLinked, true)
  assert.deepEqual(installed.library.libraryRoots, ['node_modules/@aily-project-coder/lib-demo/src/Demo'])
  assert.equal(JSON.parse(await readFile(f.manifestPath, 'utf8')).dependencies[packageName], '1.0.0')
  assert.equal(await readFile(path.join(f.packageRoot, 'src.7z'), 'utf8'), 'archive')
  assert.equal(await readFile(path.join(f.packageRoot, 'src/Demo/src/Demo.h'), 'utf8'), '#pragma once\n')
  const templateManifest = JSON.parse(await readFile(f.manifestPath, 'utf8'))
  templateManifest.coderBoardTemplateDependencies = { schemaVersion: 1, boardPackageName: '@aily-project/board-demo', dependencies: { [packageName]: '1.0.0' } }
  await writeFile(f.manifestPath, JSON.stringify(templateManifest))
  assert.equal((await installArduinoComponentLibrary({ ...f.options, libraryId: libraryRef })).alreadyInstalled, true)
  assert.deepEqual(JSON.parse(await readFile(f.manifestPath, 'utf8')).coderBoardTemplateDependencies.dependencies, {})
  assert.equal(f.commands.length, 1)
  assert.equal((await searchCoderLibraries({ ...f.options, query: '' })).libraries.some(item => item.packageName === packageName), false)
  const state = (await searchArduinoComponentLibraries({ ...f.options, query: 'Official' })).libraries[0]
  assert.equal(state.installed, true); assert.equal(state.managed, true)
  await assert.rejects(removeArduinoComponentLibrary({ ...f.options, libraryId: libraryRef, version: '2.0.0' }), { code: 'BLOCKLY_LIBRARY_PROVENANCE_CONFLICT' })
  const removed = await router.execute({ method: 'coder.library.remove', context, params: { libraryRef, version: state.installedVersion } })
  assert.equal(removed.library.removed, true)
  assert.deepEqual(JSON.parse(await readFile(f.manifestPath, 'utf8')).dependencies, {})
  await assert.rejects(readdir(path.join(f.workspaceRoot, 'sketch/libraries')), { code: 'ENOENT' })
})

test('regional catalog caches and official npm registries stay isolated when the host region changes', async t => {
  const f = await fixture(t)
  const config = { region: 'cn', regions: { cn: { resource: 'https://blockly.yiyu.pro', npm_registry_coder: 'https://custom-cn.example' },
    eu: { resource: 'https://rs1.aily.pro', npm_registry_coder: 'https://cregistry.aily.pro' } } }
  const saveConfig = () => writeFile(path.join(f.appDataPath, 'config.json'), JSON.stringify(config))
  await saveConfig()
  await installCoderLibrary(f.options)
  assert.equal(f.commands[0].env.AILY_NPM_REGISTRY_CODER, 'https://custom-cn.example')
  await removeCoderLibrary(f.options)
  config.region = 'eu'; await saveConfig()
  await assert.rejects(loadCoderPackageCatalog(f.appDataPath, { fetchImpl: async () => { throw new Error('offline international') } }), /offline international/u)
  await installCoderLibrary(f.options)
  assert.equal(f.requests.at(-1), 'https://rs1.aily.pro/libraries-coder-index.json')
  assert.equal(f.commands.at(-1).env.AILY_NPM_REGISTRY_CODER, 'https://cregistry.aily.pro')
  await removeCoderLibrary(f.options)
  delete config.regions.eu.npm_registry_coder; await saveConfig()
  await installCoderLibrary(f.options)
  assert.equal(f.commands.at(-1).env.AILY_NPM_REGISTRY_CODER, 'https://cregistry.aily.pro')
  const cached = await loadCoderPackageCatalog(f.appDataPath, { forceRefresh: true, fetchImpl: async () => { throw new Error('offline') } })
  assert.equal(cached.stale, true); assert.equal(cached.indexUrl, 'https://rs1.aily.pro/libraries-coder-index.json')
})

test('official packages preserve compatibility, rollback, localization and offline template preparation', async t => {
  const f = await fixture(t)
  f.catalog[0].architectures = ['avr']
  await assert.rejects(installCoderLibrary(f.options), { code: 'CODER_LIBRARY_INCOMPATIBLE' })
  assert.equal(f.commands.length, 0)
  await assert.rejects(installCoderLibrary({ ...f.options, allowIncompatible: true,
    extractArchive: async () => { throw new Error('archive failed') } }), /archive failed/u)
  assert.deepEqual(JSON.parse(await readFile(f.manifestPath, 'utf8')).dependencies, {})
  await f.options.runNpmCommand({ args: ['install', `${packageName}@1.0.0`], env: {} })
  const result = await materializeCoderProjectLibraries(f.options)
  assert.equal(result.ready, true); assert.equal(result.libraries[0].source, 'registry')
  const localized = await localizeCoderLibrary({ ...f.options, libraryRoot: result.libraryRoots[0] })
  assert.deepEqual(localized.localRoots, ['sketch/libraries/Demo'])
  const header = path.join(f.workspaceRoot, 'sketch/libraries/Demo/src/Demo.h')
  await writeFile(header, 'local edit')
  const removed = await removeCoderLibrary(f.options)
  assert.deepEqual(removed.preservedLocalRoots, ['sketch/libraries/Demo'])
  assert.equal(await readFile(header, 'utf8'), 'local edit')
})
