import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { readUiState, updateUiState } from './uiStateApi.js'

test('persists only the library panel width and keeps it at least 350px', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aily-coder-ui-state-'))
  const filePath = path.join(root, 'aily-coder', 'ui-state.json')
  try {
    assert.deepEqual(await readUiState(filePath), {})
    assert.deepEqual(await updateUiState({ componentLibraryPanelWidth: 512.4, unknown: 1 }, filePath), { componentLibraryPanelWidth: 512 })
    assert.deepEqual(JSON.parse(await readFile(filePath, 'utf8')), { componentLibraryPanelWidth: 512 })
    assert.deepEqual(await updateUiState({ componentLibraryPanelWidth: 120 }, filePath), { componentLibraryPanelWidth: 350 })
    assert.deepEqual(await updateUiState({ componentLibraryPanelWidth: 'wide' }, filePath), { componentLibraryPanelWidth: 350 })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
