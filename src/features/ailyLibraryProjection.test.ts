import assert from 'node:assert/strict'
import test from 'node:test'
import {
  listAilyLibraryProjections,
  type ProjectDirectoryEntry
} from './ailyLibraryProjection.js'

function directory(
  directories: readonly string[] = [],
  files: readonly string[] = []
): ProjectDirectoryEntry[] {
  return [
    ...directories.map((name) => ({ name, isDirectory: true })),
    ...files.map((name) => ({ name, isDirectory: false }))
  ]
}

test('maps only direct libraries under the deepest consecutive src directory', async () => {
  const tree = new Map<string, ProjectDirectoryEntry[]>([
    ['node_modules/@aily-project', directory([
      'lib-single-src',
      'lib-deep-src',
      'lib-without-src',
      'not-an-aily-library'
    ])],
    ['node_modules/@aily-project/lib-single-src', directory(['src'])],
    ['node_modules/@aily-project/lib-single-src/src', directory(
      ['FirstLibrary', 'SecondLibrary', '.ignored-metadata'],
      ['README.md']
    )],
    ['node_modules/@aily-project/lib-deep-src', directory(['src'])],
    ['node_modules/@aily-project/lib-deep-src/src', directory(['src', 'IgnoredShallowLibrary'])],
    ['node_modules/@aily-project/lib-deep-src/src/src', directory(['src'])],
    ['node_modules/@aily-project/lib-deep-src/src/src/src', directory(
      ['DeepLibrary'],
      ['library.properties']
    )],
    ['node_modules/@aily-project/lib-without-src', directory(['assets'])],
    ['node_modules/@aily-project/not-an-aily-library', directory(['src'])],
    ['node_modules/@aily-project/not-an-aily-library/src', directory(['IgnoredPackage'])]
  ])

  const projections = await listAilyLibraryProjections(async (relPath) => tree.get(relPath) ?? [])

  assert.deepEqual(projections, [
    {
      label: 'DeepLibrary',
      relPath: 'node_modules/@aily-project/lib-deep-src/src/src/src/DeepLibrary'
    },
    {
      label: 'FirstLibrary',
      relPath: 'node_modules/@aily-project/lib-single-src/src/FirstLibrary'
    },
    {
      label: 'SecondLibrary',
      relPath: 'node_modules/@aily-project/lib-single-src/src/SecondLibrary'
    }
  ])
})

test('returns no projections when packages have no src-backed library directory', async () => {
  const tree = new Map<string, ProjectDirectoryEntry[]>([
    ['node_modules/@aily-project', directory(['lib-no-src', 'lib-empty-src'])],
    ['node_modules/@aily-project/lib-no-src', directory(['assets'])],
    ['node_modules/@aily-project/lib-empty-src', directory(['src'])],
    ['node_modules/@aily-project/lib-empty-src/src', directory([], ['single-header.h'])]
  ])

  const projections = await listAilyLibraryProjections(async (relPath) => tree.get(relPath) ?? [])

  assert.deepEqual(projections, [])
})
