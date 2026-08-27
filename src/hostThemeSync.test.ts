import assert from 'node:assert/strict'
import test from 'node:test'
import { createHostThemeSynchronizer } from './hostThemeSync.js'

test('serializes host theme changes and applies the latest pending value', async () => {
  const applied: string[] = []
  let releaseFirst!: () => void
  const first = new Promise<void>(resolve => { releaseFirst = resolve })
  const sync = createHostThemeSynchronizer(async theme => {
    applied.push(theme)
    if (applied.length === 1) await first
  })

  const pending = sync.sync('light')
  void sync.sync('dark')
  releaseFirst()
  await pending

  assert.deepEqual(applied, ['light', 'dark'])
})

test('retries a theme after an apply failure', async () => {
  let attempts = 0
  const sync = createHostThemeSynchronizer(async () => {
    attempts += 1
    if (attempts === 1) throw new Error('temporary failure')
  })

  await sync.sync('light')
  await sync.sync('light')
  assert.equal(attempts, 2)
})
