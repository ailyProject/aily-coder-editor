import { Buffer } from 'node:buffer'
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
import {
  parseCoderLibraryIndex,
  resolveCoderLibraryIndexUrl,
} from './coderLibraryRegistry.js'

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
      version: '1.3.0',
      author: 'Arduino',
      sentence: 'Servo library',
      category: 'Device Control',
      architectures: ['avr'],
      types: ['Arduino'],
      url: 'https://downloads.arduino.cc/libraries/Servo-1.3.0.zip',
      archiveFileName: 'Servo-1.3.0.zip',
      size: 124,
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
  assert.equal(unmanagedSearch.libraries[0].version, '1.3.0')
  assert.equal(unmanagedSearch.libraries[0].installedVersion, '1.2.0')
  assert.equal(unmanagedSearch.libraries[0].managed, false)

  const ignored = await removeArduinoComponentLibrary({
    workspaceRoot,
    libraryId,
    version: '1.2.0',
  })
  assert.equal(ignored.alreadyRemoved, true)
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
    libraryId,
    version: '1.2.0',
  })
  assert.equal(removed.removed, true)
  assert.equal(removed.folderName, 'Servo')

  const repeated = await removeArduinoComponentLibrary({
    workspaceRoot,
    libraryId,
    version: '1.2.0',
  })
  assert.equal(repeated.alreadyRemoved, true)
})

test('removes managed Aily and Arduino libraries from local receipts without loading a catalog', async t => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'aily-coder-offline-remove-'))
  t.after(() => rm(tempRoot, { recursive: true, force: true }))
  const workspaceRoot = path.join(tempRoot, 'project')
  const librariesRoot = path.join(workspaceRoot, 'sketch', 'libraries')
  const ailyRoot = path.join(librariesRoot, 'Offline_Aily')
  const arduinoRoot = path.join(librariesRoot, 'Offline_Arduino')
  const ailyRef = 'coder:0123456789abcdef01234567'
  const arduinoId = 'arduino:offline-library'

  await mkdir(ailyRoot, { recursive: true })
  await mkdir(arduinoRoot, { recursive: true })
  await writeFile(path.join(workspaceRoot, 'package.json'), JSON.stringify({
    name: 'offline-remove-test',
    type: 'coder',
    framework: 'arduino',
  }))
  await writeFile(path.join(ailyRoot, 'library.properties'), 'name=Offline Aily\nversion=1.0.0\n')
  await writeFile(path.join(ailyRoot, '.aily-component-library.json'), JSON.stringify({
    source: 'aily-coder-index',
    libraryId: ailyRef,
    name: 'Offline Aily',
    version: '1.0.0',
  }))
  await writeFile(path.join(arduinoRoot, 'library.properties'), 'name=Offline Arduino\nversion=2.0.0\n')
  await writeFile(path.join(arduinoRoot, '.aily-component-library.json'), JSON.stringify({
    source: 'arduino-library-manager',
    libraryId: arduinoId,
    name: 'Offline Arduino',
    version: '2.0.0',
  }))

  await assert.rejects(
    removeCoderLibrary({ workspaceRoot, libraryRef: ailyRef, version: '1.0.1' }),
    error => error?.code === 'CODER_LIBRARY_PROVENANCE_CONFLICT',
  )
  assert.match(await readFile(path.join(ailyRoot, 'library.properties'), 'utf8'), /Offline Aily/u)

  const ailyRemoved = await removeCoderLibrary({
    workspaceRoot,
    libraryRef: ailyRef,
    version: '1.0.0',
  })
  const arduinoRemoved = await removeArduinoComponentLibrary({
    workspaceRoot,
    libraryId: arduinoId,
    version: '2.0.0',
  })
  assert.equal(ailyRemoved.removed, true)
  assert.equal(arduinoRemoved.removed, true)
  await assert.rejects(readFile(path.join(ailyRoot, 'library.properties')))
  await assert.rejects(readFile(path.join(arduinoRoot, 'library.properties')))
})

test('selects the Coder index from the active main-application region', async t => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'aily-coder-region-index-'))
  t.after(() => rm(tempRoot, { recursive: true, force: true }))
  const appDataPath = path.join(tempRoot, 'appdata')
  await mkdir(appDataPath, { recursive: true })
  await writeFile(path.join(appDataPath, 'config.json'), JSON.stringify({
    region: 'cn',
    regions: {
      cn: { resource: 'https://blockly.yiyu.pro/' },
      eu: { resource: 'https://rs1.aily.pro/' },
    },
  }))
  assert.equal(
    await resolveCoderLibraryIndexUrl({ cacheRoot: appDataPath }),
    'https://blockly.yiyu.pro/libraries-coder-index.json',
  )

  await writeFile(path.join(appDataPath, 'config.json'), JSON.stringify({
    region: 'eu',
    regions: {
      cn: { resource: 'https://blockly.yiyu.pro/' },
      eu: { resource: 'https://rs1.aily.pro/' },
    },
  }))
  assert.equal(
    await resolveCoderLibraryIndexUrl({ cacheRoot: appDataPath }),
    'https://rs1.aily.pro/libraries-coder-index.json',
  )
})

test('rejects Coder index archives that can escape the staging directory', () => {
  assert.throws(() => parseCoderLibraryIndex({
    libraries: [{
      name: 'Unsafe Archive',
      version: '1.0.0',
      url: 'https://archives.example/unsafe.zip',
      archiveFileName: '../unsafe.zip',
      size: 10,
      checksum: `SHA-256:${'0'.repeat(64)}`,
    }],
  }), /contains no valid libraries/)
})

test('searches the regional Coder index and installs its ZIP under sketch/libraries', async t => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'aily-coder-index-library-'))
  t.after(() => rm(tempRoot, { recursive: true, force: true }))
  const workspaceRoot = path.join(tempRoot, 'project')
  const appDataPath = path.join(tempRoot, 'appdata')
  const archive = Buffer.from(
    'UEsDBBQAAAAIAO9YI110vtPEQwAAAEMAAAAiAAAAQWlseV9UZXN0LTEuMi4zL2xpYnJhcnkucHJvcGVydGllc8tLzE21dczMqVQISS0u4SpLLSrOzM+zNdQz0jPmSixKzsgsSU0uKS1KLbbV4ipOzStJzUtOtQWpVcjJTCpKLKrkAgBQSwMEFAAAAAgA71gjXXgcNZYPAAAADQAAAB4AAABBaWx5X1Rlc3QtMS4yLjMvc3JjL0FpbHlUZXN0LmhTLihKTM9NVMjPS07lAgBQSwECFAMUAAAACADvWCNddL7TxEMAAABDAAAAIgAAAAAAAAAAAAAAgAEAAAAAQWlseV9UZXN0LTEuMi4zL2xpYnJhcnkucHJvcGVydGllc1BLAQIUAxQAAAAIAO9YI114HDWWDwAAAA0AAAAeAAAAAAAAAAAAAACAAYMAAABBaWx5X1Rlc3QtMS4yLjMvc3JjL0FpbHlUZXN0LmhQSwUGAAAAAAIAAgCcAAAAzgAAAAAA',
    'base64',
  )
  const indexPayload = {
    libraries: [{
      name: 'Aily Test',
      version: '1.2.3',
      author: 'Aily',
      sentence: 'A regional Coder library',
      category: 'Device Control',
      architectures: ['*'],
      types: ['Arduino'],
      dependencies: [{ name: 'Dependency Test' }],
      providesIncludes: ['AilyTest.h'],
      url: 'https://archives.example/Aily_Test-1.2.3.zip',
      archiveFileName: 'Aily_Test-1.2.3.zip',
      size: archive.byteLength,
      checksum: 'SHA-256:e4aeda77c147a3218cd38908d2d1c88b58ddd13c35f090c3f1cf9240326a319f',
    }],
  }
  const indexUrl = 'https://catalog.example/libraries-coder-index.json'
  const fetched = []
  const fetchImpl = async url => {
    fetched.push(String(url))
    if (String(url) === indexUrl) {
      return new globalThis.Response(JSON.stringify(indexPayload), {
        headers: { 'Content-Type': 'application/json' },
      })
    }
    if (String(url) === indexPayload.libraries[0].url) {
      return new globalThis.Response(archive, {
        headers: { 'Content-Length': String(archive.byteLength) },
      })
    }
    return new globalThis.Response('', { status: 404 })
  }

  await mkdir(path.join(workspaceRoot, 'sketch', 'src'), { recursive: true })
  await mkdir(path.join(appDataPath, 'sdk', 'test_1.0.0'), { recursive: true })
  await writeFile(path.join(workspaceRoot, 'package.json'), JSON.stringify({
    name: 'coder-index-test',
    type: 'coder',
    entry: 'src/main.cpp',
    dependencies: {},
    boardDependencies: { '@aily-project/sdk-test': '1.0.0' },
  }))

  const search = await searchCoderLibraries({
    workspaceRoot,
    appDataPath,
    indexUrl,
    fetchImpl,
    query: 'AilyTest Dependency',
  })
  assert.equal(search.tier, 'preferred')
  assert.equal(search.indexUrl, indexUrl)
  assert.equal(search.libraries.length, 1)
  assert.match(search.libraries[0].libraryRef, /^coder:[a-f0-9]{24}$/u)
  assert.deepEqual(search.libraries[0].providesIncludes, ['AilyTest.h'])
  assert.deepEqual(search.libraries[0].dependencies, [{ name: 'Dependency Test' }])

  const installed = await installCoderLibrary({
    workspaceRoot,
    appDataPath,
    indexUrl,
    fetchImpl,
    libraryRef: search.libraries[0].libraryRef,
    version: '1.2.3',
  })
  assert.equal(installed.ready, true)
  assert.equal(installed.sourceDirectory, 'sketch/libraries/Aily_Test')
  assert.deepEqual(installed.libraryRoots, ['sketch/libraries/Aily_Test'])
  assert.equal(
    await readFile(path.join(workspaceRoot, 'sketch', 'libraries', 'Aily_Test', 'src', 'AilyTest.h'), 'utf8'),
    '#pragma once\n',
  )
  const receipt = JSON.parse(await readFile(
    path.join(workspaceRoot, 'sketch', 'libraries', 'Aily_Test', '.aily-component-library.json'),
    'utf8',
  ))
  assert.equal(receipt.source, 'aily-coder-index')
  assert.equal(receipt.indexUrl, indexUrl)
  assert.deepEqual(
    JSON.parse(await readFile(path.join(workspaceRoot, 'package.json'), 'utf8')).dependencies,
    {},
  )
  assert.equal(fetched.includes(indexPayload.libraries[0].url), true)

  await assert.rejects(
    installCoderLibrary({
      workspaceRoot,
      appDataPath,
      indexUrl,
      fetchImpl,
      libraryRef: 'blockly:@aily-project/lib-aily-test',
      version: '1.2.3',
    }),
    error => error?.code === 'CODER_LIBRARY_REF_INVALID',
  )

  const removed = await removeCoderLibrary({
    workspaceRoot,
    appDataPath,
    indexUrl,
    fetchImpl,
    libraryRef: search.libraries[0].libraryRef,
    version: '1.2.3',
  })
  assert.equal(removed.removed, true)
  await assert.rejects(readFile(
    path.join(workspaceRoot, 'sketch', 'libraries', 'Aily_Test', 'library.properties'),
  ))
})
