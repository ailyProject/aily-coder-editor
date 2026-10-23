import assert from 'node:assert/strict'
import test from 'node:test'
import { createBrowserWorkspaceActivation, type BrowserWorkspaceSnapshot } from './browserWorkspaceActivation.js'

/** Structural doubles verify activation boundaries only. These are not real
 * Browser picker/permission, Workbench, filesystem or account acceptance. */
function fixture() {
  const owner = new AbortController()
  let workspace: BrowserWorkspaceSnapshot = { id: 'empty', folders: [] }
  let dirty = 0, pickerCalls = 0, initialized = 0
  let selected: string | undefined = 'file:///project'
  let pick: (() => Promise<string | undefined>) | null = null
  const listeners = new Set<() => void>()
  const selection = createBrowserWorkspaceActivation({
    owner: owner.signal,
    readWorkspace: () => workspace,
    onWorkspaceChange(listener) { listeners.add(listener); return { dispose() { listeners.delete(listener) } } },
    countDirtyEditors: () => dirty,
    pickDirectory() { pickerCalls++; return pick ? pick() : Promise.resolve(selected) },
    async initializeFolder(uri) {
      initialized++
      workspace = { id: uri, folders: [uri] }
      for (const listener of listeners) listener()
    }
  })
  return { owner, selection, listeners,
    setDirty(value: number) { dirty = value },
    setSelected(value: string | undefined) { selected = value },
    setPicker(value: () => Promise<string | undefined>) { pick = value },
    changeWorkspace(value: BrowserWorkspaceSnapshot) {
      workspace = value
      for (const listener of listeners) listener()
    },
    counters: () => ({ pickerCalls, initialized }) }
}

test('empty workspace cannot grant activation; selection binds the original single folder', async () => {
  const f = fixture()
  assert.equal(f.selection.port.captureCurrentProjectActivation(), null)
  assert.equal(await f.selection.openFolder(), 'opened')
  const captured = f.selection.port.captureCurrentProjectActivation()!
  assert.equal(captured.path, 'file:///project')
  captured.requireCurrent()
  f.selection.close()
  assert.equal(captured.signal.aborted, true)
  assert.equal(f.listeners.size, 0)
})

test('picker cancellation keeps the current generation and does not initialize another workspace', async () => {
  const f = fixture()
  await f.selection.openFolder()
  const captured = f.selection.port.captureCurrentProjectActivation()!
  f.setSelected(undefined)
  assert.equal(await f.selection.openFolder(), 'cancelled')
  assert.equal(f.selection.port.captureCurrentProjectActivation(), captured)
  assert.equal(captured.signal.aborted, false)
  assert.equal(f.counters().initialized, 1)
  f.selection.close()
})

test('dirty editors reject before the picker and changes while picking reject before activation', async () => {
  const f = fixture()
  f.setDirty(1)
  await assert.rejects(f.selection.openFolder(), /unsaved/)
  assert.equal(f.counters().pickerCalls, 0)
  f.setDirty(0)
  await f.selection.openFolder()
  const captured = f.selection.port.captureCurrentProjectActivation()!
  f.setPicker(async () => { f.setDirty(1); return 'file:///other' })
  await assert.rejects(f.selection.openFolder(), /changed while/)
  assert.equal(f.selection.port.captureCurrentProjectActivation(), captured)
  assert.equal(captured.signal.aborted, false)
  f.selection.close()
})

test('same-folder reopen revokes the old generation even without a URI change', async () => {
  const f = fixture()
  await f.selection.openFolder()
  const before = f.selection.port.captureCurrentProjectActivation()!
  await f.selection.openFolder()
  const after = f.selection.port.captureCurrentProjectActivation()!
  assert.equal(before.signal.aborted, true)
  assert.throws(() => before.requireCurrent(), /changed|current/)
  assert.equal(after.path, before.path)
  assert.notEqual(after.projectSessionId, before.projectSessionId)
  after.requireCurrent()
  f.selection.close()
})

test('original workspace change immediately revokes and never silently selects an external folder', async () => {
  const f = fixture()
  await f.selection.openFolder()
  const captured = f.selection.port.captureCurrentProjectActivation()!
  f.changeWorkspace({ id: 'external', folders: ['file:///other'] })
  assert.equal(captured.signal.aborted, true)
  assert.equal(f.selection.port.captureCurrentProjectActivation(), null)
  f.selection.close()
})

test('owner close with a late picker result cannot activate and removes owned subscriptions', async () => {
  const f = fixture()
  let resolve: (uri: string | undefined) => void = () => { throw new Error('picker not started') }
  f.setPicker(() => new Promise(done => { resolve = done }))
  const opening = f.selection.openFolder()
  const subscription = f.selection.port.projectActivation$.subscribe(() => {})
  f.owner.abort()
  assert.equal(f.listeners.size, 0)
  assert.equal(f.selection.snapshot().subscriptions, 0)
  assert.equal(f.selection.snapshot().retainedPendingSelection, true)
  resolve('file:///late')
  await assert.rejects(opening, /abort|closed/i)
  assert.equal(f.counters().initialized, 0)
  assert.equal(f.selection.snapshot().retainedPendingSelection, false)
  subscription.unsubscribe()
})

test('concurrent opens reject without creating a second picker or activation', async () => {
  const f = fixture()
  let resolve: (uri: string | undefined) => void = () => { throw new Error('picker not started') }
  f.setPicker(() => new Promise(done => { resolve = done }))
  const opening = f.selection.openFolder()
  await assert.rejects(f.selection.openFolder(), /already pending/)
  assert.equal(f.counters().pickerCalls, 1)
  resolve('file:///project')
  await opening
  assert.equal(f.counters().initialized, 1)
  f.selection.close()
})

test('closeAndWait retains the original pending picker until its late result settles without activation', async () => {
  const f = fixture()
  let resolve: (uri: string | undefined) => void = () => { throw new Error('picker not started') }
  f.setPicker(() => new Promise(done => { resolve = done }))
  const opening = f.selection.openFolder()
  const closing = f.selection.closeAndWait()
  assert.equal(f.selection.closeAndWait(), closing)
  let settled = false
  const observedClose = closing.then(() => { settled = true })
  await assert.rejects(f.selection.openFolder(), /pending|closed/i)
  assert.equal(settled, false)
  assert.equal(f.selection.snapshot().closing, true)
  assert.equal(f.selection.snapshot().retainedPendingSelection, true)
  assert.equal(f.selection.snapshot().retainedCleanupResponsibility, true)
  assert.equal(f.listeners.size, 0)
  resolve('file:///late')
  await assert.rejects(opening, /abort|closed/i)
  await observedClose
  assert.equal(f.counters().initialized, 0)
  assert.equal(f.selection.port.captureCurrentProjectActivation(), null)
  assert.equal(f.selection.snapshot().closing, false)
  assert.equal(f.selection.snapshot().retainedCleanupResponsibility, false)
})
