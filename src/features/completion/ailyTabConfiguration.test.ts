import assert from 'node:assert/strict'
import test from 'node:test'
import { migrateAilyTabConfiguration, updateAilyTabConfiguration } from './ailyTabConfiguration'

test('old insert and disabled NES settings migrate to the sole Aily Tab flow', async () => {
  const data: Record<string, { globalValue?: unknown; workspaceValue?: unknown; workspaceFolderValue?: unknown }> = {
    mode: { globalValue: 'insert', workspaceValue: 'off' },
    'nextEdit.enabled': { globalValue: false },
  }
  const writes: unknown[][] = []
  await migrateAilyTabConfiguration({
    inspect: <T>(key: string) => data[key] as { globalValue?: T; workspaceValue?: T; workspaceFolderValue?: T } | undefined,
    update: async (...args) => { writes.push(args) },
  }, { Global: 1, Workspace: 2, WorkspaceFolder: 3 })
  assert.deepEqual(writes, [
    ['mode', undefined, 1], ['nextEdit.enabled', undefined, 1], ['enabled', false, 2], ['mode', undefined, 2],
  ])
})

test('migration preserves an explicit enable and does not write unchanged scopes', async () => {
  const writes: unknown[][] = []
  await migrateAilyTabConfiguration({
    inspect: <T>(key: string) => ({ globalValue: (key === 'mode' ? 'off' : key === 'enabled' ? true : undefined) as T }),
    update: async (...args) => { writes.push(args) },
  }, { Global: 1, Workspace: 2, WorkspaceFolder: 3 })
  assert.deepEqual(writes, [['mode', undefined, 1]])
})

test('menu updates the effective project or language override instead of a masked global value', async () => {
  const cases = [
    { inspected: undefined, target: 1, language: false },
    { inspected: { globalValue: false, workspaceValue: false }, target: 2, language: false },
    { inspected: { workspaceValue: false, workspaceFolderValue: false }, target: 3, language: false },
    { inspected: { workspaceFolderValue: true, globalLanguageValue: false }, target: 1, language: true },
    { inspected: { globalLanguageValue: false, workspaceLanguageValue: false }, target: 2, language: true },
    { inspected: { workspaceLanguageValue: true, workspaceFolderLanguageValue: false }, target: 3, language: true },
  ]
  for (const item of cases) {
    const writes: unknown[][] = []
    await updateAilyTabConfiguration({
      inspect: <T>() => item.inspected as { globalValue?: T; workspaceValue?: T; workspaceFolderValue?: T; globalLanguageValue?: T; workspaceLanguageValue?: T; workspaceFolderLanguageValue?: T } | undefined,
      update: async (...args) => { writes.push(args) },
    }, 'enabled', true, { Global: 1, Workspace: 2, WorkspaceFolder: 3 })
    assert.deepEqual(writes, [['enabled', true, item.target, item.language]])
  }
})
