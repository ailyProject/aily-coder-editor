import assert from 'node:assert/strict'
import { gzip } from 'node:zlib'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  findArduinoLibraryRelease,
  parseArduinoLibraryIndex,
  searchArduinoLibraryRegistry,
} from './arduinoLibraryRegistry.js'
import {
  installCoderLibrary,
  installComponentLibrary,
  parseArduinoLibraryProperties,
  removeArduinoComponentLibrary,
  removeCoderLibrary,
  scanComponentLibraries,
  searchArduinoComponentLibraries,
  searchCoderLibraries,
} from './componentLibraryService.js'

const gzipAsync = promisify(gzip)

test('parses Arduino library.properties metadata', () => {
  assert.deepEqual(
    parseArduinoLibraryProperties(`name=Aily Timer\narchitectures=avr, esp32\nsentence=Timer \\\nlibrary\n`),
    {
      name: 'Aily Timer',
      version: '',
      author: '',
      maintainer: '',
      sentence: 'Timer library',
      paragraph: '',
      category: '',
      url: '',
      architectures: ['avr', 'esp32'],
    },
  )
})

test('groups the Arduino Library Manager index by library and keeps every version searchable', () => {
  const checksum = `SHA-256:${'a'.repeat(64)}`
  const release = (name, version, overrides = {}) => ({
    name,
    version,
    author: 'Arduino',
    sentence: `${name} library`,
    category: 'Device Control',
    architectures: ['avr'],
    types: ['Arduino'],
    url: `https://downloads.arduino.cc/libraries/${name}-${version}.zip`,
    archiveFileName: `${name}-${version}.zip`,
    size: 123,
    checksum,
    ...overrides,
  })
  const registry = parseArduinoLibraryIndex({ libraries: [
    release('Servo', '1.2.0'),
    release('Servo', '1.10.0'),
    release('WiFi', '2.0.0', { architectures: ['samd'] }),
  ] }, '2026-08-20T00:00:00.000Z')

  assert.equal(registry.libraries.length, 2)
  assert.deepEqual(registry.libraries[0].versions.map(item => item.version), ['1.10.0', '1.2.0'])
  const search = searchArduinoLibraryRegistry(registry, {
    query: 'servo',
    type: 'Arduino',
    category: 'Device Control',
    limit: 1,
  })
  assert.equal(search.total, 1)
  assert.equal(search.libraries[0].name, 'Servo')
  assert.equal(
    findArduinoLibraryRelease(registry, search.libraries[0].id, '1.2.0')?.release.version,
    '1.2.0',
  )
})

test('scans SDK libraries and installs a complete component atomically', async t => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'aily-coder-components-'))
  t.after(async () => {
    const { rm } = await import('node:fs/promises')
    await rm(tempRoot, { recursive: true, force: true })
  })

  const appDataPath = path.join(tempRoot, 'appdata')
  const sdkRoot = path.join(appDataPath, 'sdk', 'arduino-avr_1.0.0')
  const libraryRoot = path.join(sdkRoot, 'libraries', 'AilyTimer')
  const workspaceRoot = path.join(tempRoot, 'project')
  await mkdir(path.join(libraryRoot, 'src'), { recursive: true })
  await mkdir(workspaceRoot, { recursive: true })
  const platformPackage = '@aily-project/platform-avr-arduino'
  const platformRoot = path.join(
    appDataPath,
    'node_modules',
    '@aily-project',
    'platform-avr-arduino',
  )
  await mkdir(platformRoot, { recursive: true })
  await writeFile(path.join(workspaceRoot, 'package.json'), JSON.stringify({
    name: 'test-project',
    type: 'coder',
    platform: platformPackage,
  }))
  await writeFile(path.join(platformRoot, 'platform.json'), JSON.stringify({
    runtimeDependencies: [{
      role: 'sdk',
      package: '@aily-project/sdk-arduino-avr',
      version: '1.0.0',
    }],
  }))
  await writeFile(
    path.join(libraryRoot, 'library.properties'),
    'name=Aily Timer\nversion=1.2.3\narchitectures=avr\n',
  )
  await writeFile(path.join(libraryRoot, 'src', 'AilyTimer.h'), '#pragma once\n')

  const before = await scanComponentLibraries({ workspaceRoot, appDataPath })
  assert.equal(before.length, 1)
  assert.equal(before[0].installed, false)
  assert.equal(before[0].version, '1.2.3')

  const installed = await installComponentLibrary({
    workspaceRoot,
    appDataPath,
    libraryId: before[0].id,
  })
  assert.equal(installed.installed, true)
  assert.equal(installed.alreadyInstalled, false)
  assert.equal(
    await readFile(path.join(workspaceRoot, 'sketch', 'libraries', 'AilyTimer', 'src', 'AilyTimer.h'), 'utf8'),
    '#pragma once\n',
  )
  assert.deepEqual(
    JSON.parse(await readFile(
      path.join(workspaceRoot, 'sketch', 'libraries', 'AilyTimer', '.aily-component-library.json'),
      'utf8',
    )),
    {
      source: 'arduino-platform',
      libraryId: before[0].id,
      name: 'Aily Timer',
      version: '1.2.3',
    },
  )

  const after = await scanComponentLibraries({ workspaceRoot, appDataPath })
  assert.equal(after[0].installed, true)
})

test('resolves the active SDK from current boardDependencies without platform metadata', async t => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'aily-coder-board-sdk-'))
  t.after(() => rm(tempRoot, { recursive: true, force: true }))

  const workspaceRoot = path.join(tempRoot, 'project')
  const appDataPath = path.join(tempRoot, 'appdata')
  const boardPackage = '@aily-project/board-xiao_esp32s3'
  const boardPackageRoot = path.join(
    workspaceRoot,
    'node_modules',
    '@aily-project',
    'board-xiao_esp32s3',
  )
  const sdkLibraryRoot = path.join(
    appDataPath,
    'sdk',
    'esp32_3.3.1',
    'libraries',
    'WiFi',
  )
  await mkdir(path.join(workspaceRoot, 'sketch', 'libraries'), { recursive: true })
  await mkdir(boardPackageRoot, { recursive: true })
  await mkdir(path.join(sdkLibraryRoot, 'src'), { recursive: true })
  await writeFile(path.join(workspaceRoot, 'package.json'), JSON.stringify({
    name: 'xiao-esp32s3-test',
    type: 'coder',
    board: 'XIAO ESP32S3',
    framework: 'arduino',
    dependencies: { [boardPackage]: '^3.3.1' },
    boardDependencies: { [boardPackage]: '^3.3.1' },
  }))
  await writeFile(path.join(boardPackageRoot, 'package.json'), JSON.stringify({
    name: boardPackage,
    version: '3.3.1',
    boardDependencies: {
      '@aily-project/compiler-esp-x32': '14.2.0',
      '@aily-project/sdk-esp32': '3.3.1',
    },
  }))
  await writeFile(
    path.join(sdkLibraryRoot, 'library.properties'),
    'name=WiFi\nversion=3.3.1\narchitectures=esp32\n',
  )
  await writeFile(path.join(sdkLibraryRoot, 'src', 'WiFi.h'), '#pragma once\n')

  const libraries = await scanComponentLibraries({ workspaceRoot, appDataPath })
  assert.equal(libraries.length, 1)
  assert.equal(libraries[0].name, 'WiFi')
  assert.equal(libraries[0].sdkLabel, 'sdk-esp32@3.3.1')
})

test('removes only an exact Coder-managed Arduino registry library version', async t => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'aily-coder-arduino-remove-'))
  t.after(async () => {
    const { rm } = await import('node:fs/promises')
    await rm(tempRoot, { recursive: true, force: true })
  })

  const workspaceRoot = path.join(tempRoot, 'project')
  const appDataPath = path.join(tempRoot, 'appdata')
  const componentRoot = path.join(workspaceRoot, 'sketch', 'libraries', 'Servo')
  const cacheRoot = path.join(appDataPath, 'cache', 'arduino-library-manager')
  const checksum = `SHA-256:${'a'.repeat(64)}`
  const indexPayload = {
    libraries: [{
      name: 'Servo',
      version: '1.2.0',
      author: 'Arduino',
      sentence: 'Servo library',
      category: 'Device Control',
      architectures: ['avr'],
      types: ['Arduino'],
      url: 'https://downloads.arduino.cc/libraries/Servo-1.2.0.zip',
      archiveFileName: 'Servo-1.2.0.zip',
      size: 123,
      checksum,
    }],
  }
  const registry = parseArduinoLibraryIndex(indexPayload)
  const libraryId = registry.libraries[0].id

  await mkdir(componentRoot, { recursive: true })
  await mkdir(cacheRoot, { recursive: true })
  await writeFile(path.join(workspaceRoot, 'package.json'), JSON.stringify({
    name: 'test-project',
    type: 'coder',
    framework: 'arduino',
  }))
  await writeFile(
    path.join(componentRoot, 'library.properties'),
    'name=Servo\nversion=1.2.0\narchitectures=avr\n',
  )
  await writeFile(
    path.join(cacheRoot, 'library_index.json.gz'),
    await gzipAsync(JSON.stringify(indexPayload)),
  )

  const unmanagedSearch = await searchArduinoComponentLibraries({
    workspaceRoot,
    appDataPath,
    query: 'Servo',
  })
  assert.equal(unmanagedSearch.libraries[0].installed, true)
  assert.equal(unmanagedSearch.libraries[0].managed, false)

  await assert.rejects(
    removeArduinoComponentLibrary({
      workspaceRoot,
      appDataPath,
      libraryId,
      version: '1.2.0',
    }),
    /no Coder Arduino installation metadata/u,
  )
  assert.match(await readFile(path.join(componentRoot, 'library.properties'), 'utf8'), /name=Servo/u)
  await writeFile(
    path.join(componentRoot, '.aily-component-library.json'),
    JSON.stringify({
      source: 'arduino-library-manager',
      libraryId,
      name: 'Servo',
      version: '1.2.0',
    }),
  )
  const managedSearch = await searchArduinoComponentLibraries({
    workspaceRoot,
    appDataPath,
    query: 'Servo',
  })
  assert.equal(managedSearch.libraries[0].managed, true)

  const removed = await removeArduinoComponentLibrary({
    workspaceRoot,
    appDataPath,
    libraryId,
    version: '1.2.0',
  })
  assert.equal(removed.removed, true)
  assert.equal(removed.folderName, 'Servo')

  const repeated = await removeArduinoComponentLibrary({
    workspaceRoot,
    appDataPath,
    libraryId,
    version: '1.2.0',
  })
  assert.equal(repeated.alreadyRemoved, true)
})

test('prefers the shared Blockly catalog and expands src.7z inside the npm package', async t => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'aily-coder-blockly-library-'))
  t.after(() => rm(tempRoot, { recursive: true, force: true }))
  const workspaceRoot = path.join(tempRoot, 'project')
  const appDataPath = path.join(tempRoot, 'appdata')
  const packageName = '@aily-project/lib-arduinojson'
  await mkdir(path.join(workspaceRoot, 'sketch', 'src'), { recursive: true })
  await mkdir(appDataPath, { recursive: true })
  await writeFile(path.join(workspaceRoot, 'package.json'), JSON.stringify({
    name: 'coder-json-test',
    type: 'coder',
    entry: 'src/main.cpp',
    dependencies: {},
  }))
  await writeFile(path.join(appDataPath, 'libraries-index.json'), JSON.stringify({
    libraries: [{
      name: 'lib-arduinojson',
      displayName: 'ArduinoJson',
      category: 'protocol',
      tags: ['ArduinoJson', 'json'],
    }],
  }))
  await writeFile(path.join(appDataPath, 'libraries.json'), JSON.stringify([{
    name: packageName,
    nickname: 'ArduinoJson',
    version: '1.0.0',
    description: 'JSON support',
  }]))
  await mkdir(path.join(workspaceRoot, 'sketch', 'libraries', 'ArduinoJson'), { recursive: true })
  await writeFile(
    path.join(workspaceRoot, 'sketch', 'libraries', 'ArduinoJson', 'ArduinoJson.h'),
    '#pragma once\n',
  )
  await writeFile(path.join(workspaceRoot, 'sketch', 'library-cache.json'), JSON.stringify({
    [packageName]: {
      schemaVersion: 2,
      sourceFingerprint: 'sha256:legacy',
      targetNames: ['ArduinoJson'],
    },
  }))

  const preferred = await searchCoderLibraries({
    workspaceRoot,
    appDataPath,
    query: 'ArduinoJson JSON parse',
  })
  assert.equal(preferred.tier, 'preferred')
  assert.equal(preferred.libraries[0].libraryRef, `blockly:${packageName}`)
  assert.equal(preferred.libraries[0].version, '1.0.0')
  assert.deepEqual(preferred.libraries[0].matchedQueries, ['arduinojson', 'json'])
  assert.ok(preferred.libraries[0].score > 0)

  const runNpmCommand = async ({ projectRoot, args }) => {
    const manifestPath = path.join(projectRoot, 'package.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    if (args[0] === 'install') {
      assert.ok(args.includes('--save-exact'))
      manifest.dependencies[packageName] = '1.0.0'
      const packageRoot = path.join(projectRoot, 'node_modules', '@aily-project', 'lib-arduinojson')
      await mkdir(packageRoot, { recursive: true })
      await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({
        name: packageName,
        nickname: 'ArduinoJson',
        version: '1.0.0',
      }))
      await writeFile(path.join(packageRoot, 'src.7z'), 'test archive')
    } else {
      delete manifest.dependencies[packageName]
      await rm(path.join(projectRoot, 'node_modules', '@aily-project', 'lib-arduinojson'), {
        recursive: true,
        force: true,
      })
    }
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2))
    return { stdout: '', stderr: '' }
  }
  const extractArchive = async ({ destination }) => {
    const libraryRoot = path.join(destination, 'src', 'ArduinoJson')
    await mkdir(libraryRoot, { recursive: true })
    await writeFile(path.join(libraryRoot, 'ArduinoJson.h'), '#pragma once\n')
  }

  const installed = await installCoderLibrary({
    workspaceRoot,
    libraryRef: `blockly:${packageName}`,
    version: '1.0.0',
    runNpmCommand,
    extractArchive,
  })
  assert.equal(installed.packageJsonLinked, true)
  assert.equal(installed.ready, true)
  assert.equal(installed.archive, 'src.7z')
  assert.equal(installed.packageDirectory, 'node_modules/@aily-project/lib-arduinojson')
  assert.equal(installed.sourceDirectory, 'node_modules/@aily-project/lib-arduinojson/src')
  assert.deepEqual(installed.libraryRoots, [
    'node_modules/@aily-project/lib-arduinojson/src/ArduinoJson',
  ])
  assert.deepEqual(installed.removedLegacyRoots, ['ArduinoJson'])
  assert.equal(
    await readFile(path.join(
      workspaceRoot,
      'node_modules',
      '@aily-project',
      'lib-arduinojson',
      'src',
      'ArduinoJson',
      'ArduinoJson.h',
    ), 'utf8'),
    '#pragma once\n',
  )
  assert.equal(
    JSON.parse(await readFile(path.join(workspaceRoot, 'package.json'), 'utf8')).dependencies[packageName],
    '1.0.0',
  )
  await assert.rejects(readFile(path.join(workspaceRoot, 'sketch', 'libraries', 'ArduinoJson', 'ArduinoJson.h')))
  assert.equal(
    JSON.parse(await readFile(path.join(workspaceRoot, 'sketch', 'library-cache.json'), 'utf8'))[packageName],
    undefined,
  )

  const removed = await removeCoderLibrary({
    workspaceRoot,
    libraryRef: `blockly:${packageName}`,
    version: '1.0.0',
    runNpmCommand,
  })
  assert.equal(removed.removed, true)
  assert.deepEqual(removed.libraryRoots, [
    'node_modules/@aily-project/lib-arduinojson/src/ArduinoJson',
  ])
  assert.deepEqual(removed.removedLegacyRoots, [])
  assert.equal(removed.cacheCleaned, true)
  assert.equal(
    JSON.parse(await readFile(path.join(workspaceRoot, 'package.json'), 'utf8')).dependencies[packageName],
    undefined,
  )
  await assert.rejects(readFile(path.join(
    workspaceRoot,
    'node_modules',
    '@aily-project',
    'lib-arduinojson',
    'src',
    'ArduinoJson',
    'ArduinoJson.h',
  )))
})
