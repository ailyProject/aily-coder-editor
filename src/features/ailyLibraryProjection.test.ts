import assert from 'node:assert/strict'
import test from 'node:test'
import {
  listAilyLibraryProjections,
  type ProjectDirectoryEntry
} from './ailyLibraryProjection.js'

function directory(names: readonly string[], files: readonly string[] = []): ProjectDirectoryEntry[] {
  return [
    ...names.map(name => ({ name, isDirectory: true })),
    ...files.map(name => ({ name, isDirectory: false }))
  ]
}

test('maps Aily and official npm roots below the final unambiguous src wrapper', async () => {
  const tree = new Map<string, ProjectDirectoryEntry[]>([
    ['node_modules/@aily-project', directory(['lib-meta', 'lib-sensor'])],
    ['node_modules/@aily-project/lib-sensor/src', directory(['src'], ['.DS_Store'])],
    ['node_modules/@aily-project/lib-sensor/src/src', directory(['Sensor', 'Support'])],
    ['node_modules/@aily-project-coder', directory(['lib-display'])],
    ['node_modules/@aily-project-coder/lib-display/src', directory(['Display'])],
    ['node_modules/@aily-project/lib-meta/node_modules/@aily-project', directory(['lib-nested'])],
    ['node_modules/@aily-project/lib-meta/node_modules/@aily-project/lib-nested/src', directory(['Nested'])]
  ])
  const result = await listAilyLibraryProjections(async path => tree.get(path) ?? [])
  assert.deepEqual(result, [
    {
      label: 'Display',
      relPath: 'node_modules/@aily-project-coder/lib-display/src/Display',
      packageName: '@aily-project-coder/lib-display',
      source: 'arduino'
    },
    {
      label: 'Nested',
      relPath: 'node_modules/@aily-project/lib-meta/node_modules/@aily-project/lib-nested/src/Nested',
      packageName: '@aily-project/lib-nested',
      source: 'aily'
    },
    {
      label: 'Sensor',
      relPath: 'node_modules/@aily-project/lib-sensor/src/src/Sensor',
      packageName: '@aily-project/lib-sensor',
      source: 'aily'
    },
    {
      label: 'Support',
      relPath: 'node_modules/@aily-project/lib-sensor/src/src/Support',
      packageName: '@aily-project/lib-sensor',
      source: 'aily'
    }
  ])
})

test('maps a final src containing files as one package library root', async () => {
  const tree = new Map<string, ProjectDirectoryEntry[]>([
    ['node_modules/@aily-project', directory(['lib-direct'])],
    ['node_modules/@aily-project/lib-direct/src', directory(['src'])],
    ['node_modules/@aily-project/lib-direct/src/src', directory([], ['Direct.h', 'Direct.cpp'])]
  ])
  assert.deepEqual(await listAilyLibraryProjections(async path => tree.get(path) ?? []), [{
    label: 'lib-direct',
    relPath: 'node_modules/@aily-project/lib-direct/src/src',
    packageName: '@aily-project/lib-direct',
    source: 'aily'
  }])
})

test('ignores packages whose archive has not produced a src directory', async () => {
  const tree = new Map<string, ProjectDirectoryEntry[]>([
    ['node_modules/@aily-project', directory(['lib-no-src'])]
  ])
  assert.deepEqual(await listAilyLibraryProjections(async path => tree.get(path) ?? []), [])
})
