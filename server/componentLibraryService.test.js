import assert from 'node:assert/strict'
import { gzip } from 'node:zlib'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  findArduinoLibraryRelease,
  parseArduinoLibraryIndex,
  searchArduinoLibraryRegistry,
} from './arduinoLibraryRegistry.js'
import {
  installComponentLibrary,
  parseArduinoLibraryProperties,
  removeArduinoComponentLibrary,
  scanComponentLibraries,
  searchArduinoComponentLibraries,
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

  const after = await scanComponentLibraries({ workspaceRoot, appDataPath })
  assert.equal(after[0].installed, true)
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
