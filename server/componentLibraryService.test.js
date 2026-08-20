import assert from 'node:assert/strict'
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
  scanComponentLibraries,
} from './componentLibraryService.js'

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
  await writeFile(path.join(workspaceRoot, 'project.aci'), JSON.stringify({
    target: { platform: platformPackage },
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
    await readFile(path.join(workspaceRoot, 'components', 'AilyTimer', 'src', 'AilyTimer.h'), 'utf8'),
    '#pragma once\n',
  )

  const after = await scanComponentLibraries({ workspaceRoot, appDataPath })
  assert.equal(after[0].installed, true)
})
