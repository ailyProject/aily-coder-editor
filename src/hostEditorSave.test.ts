import test from 'node:test'
import assert from 'node:assert/strict'
import { createHostEditorSaver } from './hostEditorSave.js'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

test('keyboard save participants finish before the host saves other dirty editors', async () => {
  const keyboard = deferred()
  let pending = [keyboard.promise]
  let participantRunning = true
  let saves = 0
  const save = createHostEditorSaver(() => pending, async () => {
    assert.equal(participantRunning, false, 'a reentrant save would be rejected')
    saves++
    return { success: true }
  })
  const first = save()
  const second = save()
  assert.equal(first, second, 'overlapping host requests share one save')
  assert.equal(saves, 0)
  participantRunning = false
  pending = []
  keyboard.resolve()
  assert.deepEqual(await first, { success: true })
  assert.equal(saves, 1)
})

test('waits for a newer save queued while the original save was pending', async () => {
  const original = deferred(), queued = deferred()
  let pending = [original.promise]
  let saves = 0
  const save = createHostEditorSaver(() => pending, async () => { saves++; return true })
  const result = save()
  pending = [queued.promise]
  original.resolve()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(saves, 0)
  pending = []
  queued.resolve()
  assert.equal(await result, true)
  assert.equal(saves, 1)
})

test('keeps a real save failure and allows a later retry', async () => {
  let attempts = 0
  const save = createHostEditorSaver(() => [], async () => ({ success: ++attempts > 1 }))
  assert.deepEqual(await save(), { success: false })
  assert.deepEqual(await save(), { success: true })
})

test('does not hide a rejected save or block the next request', async () => {
  let attempts = 0
  const save = createHostEditorSaver(() => [], async () => {
    if (++attempts === 1) throw new Error('disk is read-only')
    return { success: true }
  })
  await assert.rejects(save(), /disk is read-only/)
  assert.deepEqual(await save(), { success: true })
})
