import test from 'node:test'
import assert from 'node:assert/strict'
import { captureProjectCopy, type CopyTextModel } from './projectCopySnapshot.js'

test('captures all dirty documents without modifying source text or versions', async () => {
  const models: CopyTextModel[] = [{ path: '/A/main.cpp', version: 3, encoding: 'utf16le', text: '中文\r\n' },
    { path: '/A/lib.h', version: 8, encoding: 'utf8bom', text: 'header' }]
  const before = structuredClone(models)
  const snapshot = await captureProjectCopy(() => models, async model => Buffer.from(model.text, model.encoding === 'utf16le' ? 'utf16le' : 'utf8'))
  assert.deepEqual(models, before)
  assert.equal(Buffer.from(snapshot.files[0]!.bytes).toString('utf16le'), '中文\r\n')
  assert.equal(snapshot.files.length, 2)
  snapshot.assertCurrent()
  models[1]!.text = 'new edit'
  assert.throws(snapshot.assertCurrent, /changed/)
})

test('detects a new dirty document after an asynchronous encode', async () => {
  const models: CopyTextModel[] = [{ path: '/A/main.cpp', version: 1, encoding: 'utf8', text: 'one' }]
  await assert.rejects(captureProjectCopy(() => models, async () => {
    models.push({ path: '/A/new.h', version: 1, encoding: 'utf8', text: 'two' })
    return new Uint8Array([1])
  }), /changed/)
})

test('detects encoding/version changes even when text is identical', async () => {
  const model = { path: '/A/main.cpp', version: 1, encoding: 'utf8', text: 'one' }
  const snapshot = await captureProjectCopy(() => [model], async () => new Uint8Array([1]))
  model.encoding = 'utf16le'
  assert.throws(snapshot.assertCurrent, /changed/)
  model.encoding = 'utf8'; model.version++
  assert.throws(snapshot.assertCurrent, /changed/)
})

test('a clean project is still guarded against later edits', async () => {
  const models: CopyTextModel[] = []
  const snapshot = await captureProjectCopy(() => models, async () => new Uint8Array())
  assert.deepEqual(snapshot.files, [])
  models.push({ path: '/A/main.cpp', version: 1, encoding: 'utf8', text: 'new' })
  assert.throws(snapshot.assertCurrent, /changed/)
})
