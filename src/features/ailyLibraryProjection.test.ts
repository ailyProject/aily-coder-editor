import assert from 'node:assert/strict'
import test from 'node:test'
import {
  listAilyLibraryProjections,
  type ProjectDirectoryEntry
} from './ailyLibraryProjection.js'

function manifests(packages: Record<string, { name?: string; version?: string; dependencies?: Record<string, string> }>) {
  return async (path: string): Promise<string | undefined> => {
    const value = packages[path.replace(/\/package\.json$/u, '')]
    return value ? JSON.stringify(value) : undefined
  }
}

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
  const result = await listAilyLibraryProjections(async path => tree.get(path) ?? [], manifests({
    'package.json': { dependencies: { '@aily-project/lib-meta': '1', '@aily-project/lib-sensor': '1', '@aily-project-coder/lib-display': '1' } },
    'node_modules/@aily-project/lib-meta': { name: '@aily-project/lib-meta', dependencies: { '@aily-project/lib-nested': '1' } },
    'node_modules/@aily-project/lib-sensor': { name: '@aily-project/lib-sensor' },
    'node_modules/@aily-project-coder/lib-display': { name: '@aily-project-coder/lib-display' },
    'node_modules/@aily-project/lib-meta/node_modules/@aily-project/lib-nested': { name: '@aily-project/lib-nested' }
  }))
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
  assert.deepEqual(await listAilyLibraryProjections(async path => tree.get(path) ?? [], manifests({
    'package.json': { dependencies: { '@aily-project/lib-direct': '1' } },
    'node_modules/@aily-project/lib-direct': { name: '@aily-project/lib-direct' }
  })), [{
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
  assert.deepEqual(await listAilyLibraryProjections(async path => tree.get(path) ?? [], manifests({
    'package.json': { dependencies: { '@aily-project/lib-no-src': '1' } },
    'node_modules/@aily-project/lib-no-src': { name: '@aily-project/lib-no-src' }
  })), [])
})


test('board switches stop projecting orphan packages even while old node_modules are still on disk', async () => {
  const tree = new Map<string, ProjectDirectoryEntry[]>([
    ['node_modules/@aily-project', directory(['lib-onebutton', 'lib-linkbit_onebutton'])],
    ['node_modules/@aily-project/lib-onebutton/src', directory(['OneButton'])],
    ['node_modules/@aily-project/lib-linkbit_onebutton/src', directory(['OneButton'])]
  ])
  let selected = '@aily-project/lib-onebutton'
  const read = async (path: string) => path === 'package.json'
    ? JSON.stringify({ dependencies: { [selected]: '1' } })
    : JSON.stringify({ name: path.replace(/^node_modules\//u, '').replace(/\/package\.json$/u, ''), version: '1' })
  const before = await listAilyLibraryProjections(async path => tree.get(path) ?? [], read)
  selected = '@aily-project/lib-linkbit_onebutton'
  const after = await listAilyLibraryProjections(async path => tree.get(path) ?? [], read)
  assert.deepEqual(before.map(item => item.packageName), ['@aily-project/lib-onebutton'])
  assert.deepEqual(after.map(item => item.packageName), ['@aily-project/lib-linkbit_onebutton'])
})

test('resolves hoisted dependencies and retains different physical roots of the same release', async () => {
  const source = 'node_modules/@aily-project/lib-button'
  const facade = 'node_modules/@aily-project/lib-controls'
  const nested = `${facade}/node_modules/@aily-project/lib-button`
  const tree = new Map<string, ProjectDirectoryEntry[]>([
    [`${source}/src`, directory(['OneButton'])],
    [`${nested}/src`, directory(['OneButton'])]
  ])
  const read = manifests({
    'package.json': { dependencies: { '@aily-project/lib-controls': '1', '@aily-project/lib-button': '1' } },
    [facade]: { name: '@aily-project/lib-controls', dependencies: { '@aily-project/lib-button': '1' } },
    [source]: { name: '@aily-project/lib-button', version: '1.2.0' },
    [nested]: { name: '@aily-project/lib-button', version: '1.2.0' }
  })
  const result = await listAilyLibraryProjections(async path => tree.get(path) ?? [], read)
  assert.deepEqual(new Set(result.map(item => item.relPath)), new Set([`${source}/src/OneButton`, `${nested}/src/OneButton`]))
  assert.equal(new Set(result.map(item => item.description)).size, 2)
  assert.ok(result.every(item => item.description?.includes(item.relPath)))

  const hoistedOnly = manifests({
    'package.json': { dependencies: { '@aily-project/lib-controls': '1' } },
    [facade]: { name: '@aily-project/lib-controls', dependencies: { '@aily-project/lib-button': '1' } },
    [source]: { name: '@aily-project/lib-button', version: '1.2.0', dependencies: { '@aily-project/lib-controls': '1' } }
  })
  assert.deepEqual((await listAilyLibraryProjections(async path => tree.get(path) ?? [], hoistedOnly))
    .map(item => item.relPath), [`${source}/src/OneButton`])
})

test('keeps distinct same-named libraries accessible with package ownership', async () => {
  const names = ['@aily-project/lib-onebutton', '@aily-project/lib-linkbit_onebutton']
  const result = await listAilyLibraryProjections(async path => names.some(name => path === `node_modules/${name}/src`)
    ? directory(['OneButton']) : [], manifests({
    'package.json': { dependencies: Object.fromEntries(names.map(name => [name, '1'])) },
    ...Object.fromEntries(names.map(name => [`node_modules/${name}`, { name, version: '1' }]))
  }))
  assert.equal(result.length, 2)
  assert.deepEqual(new Set(result.map(item => item.description)), new Set(names))
})

test('does not expose undeclared packages when the project manifest is missing or invalid', async () => {
  assert.deepEqual(await listAilyLibraryProjections(async () => directory(['OneButton']), async () => undefined), [])
  assert.deepEqual(await listAilyLibraryProjections(async () => directory(['OneButton']), async () => '{'), [])
})
