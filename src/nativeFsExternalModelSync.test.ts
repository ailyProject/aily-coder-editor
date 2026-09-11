import assert from 'node:assert/strict'
import test from 'node:test'
import {
  NativeFsExternalModelSync,
  selectNativeFsOpenModelsToRefresh,
  type NativeFsExternalModelSyncBridge,
  type NativeFsExternalModelSyncTimers
} from './nativeFsExternalModelSync.js'

test('reconciles all clean open models when Windows omits the changed filename', () => {
  assert.deepEqual(
    selectNativeFsOpenModelsToRefresh('C:\\work\\device-a', { eventType: 'change' }, [
      { path: 'c:\\work\\device-a\\sketch\\src\\main.cpp', dirty: false },
      { path: 'C:\\work\\device-a\\include\\config.h', dirty: true },
      { path: 'C:\\work\\device-b\\sketch\\src\\main.cpp', dirty: false }
    ]),
    ['c:/work/device-a/sketch/src/main.cpp']
  )
})

test('refreshes the exact changed model without touching clean siblings', () => {
  assert.deepEqual(
    selectNativeFsOpenModelsToRefresh('/work/device-a', {
      eventType: 'change',
      filename: 'sketch/src/main.cpp'
    }, [
      { path: '/work/device-a/sketch/src/main.cpp', dirty: false },
      { path: '/work/device-a/sketch/src/other.cpp', dirty: false }
    ]),
    ['/work/device-a/sketch/src/main.cpp']
  )
})

test('coalesces watcher bursts, retries a transient reload, and renders after success', async () => {
  const scheduled = new Map<number, () => void>()
  let timerSequence = 0
  const timers: NativeFsExternalModelSyncTimers = {
    setTimeout(callback) {
      const id = ++timerSequence
      scheduled.set(id, callback)
      return id as unknown as ReturnType<typeof setTimeout>
    },
    clearTimeout(handle) {
      scheduled.delete(handle as unknown as number)
    }
  }
  let reloads = 0
  let renders = 0
  const bridge: NativeFsExternalModelSyncBridge = {
    listOpenModels: () => [{ path: 'C:/work/device-a/sketch/src/main.cpp', dirty: false }],
    async reloadCleanModel() {
      reloads++
      if (reloads === 1) throw new Error('atomic replacement is not readable yet')
    },
    renderVisibleEditors() {
      renders++
    }
  }
  const sync = new NativeFsExternalModelSync(bridge, timers)
  const runNextTimer = () => {
    const next = scheduled.entries().next().value as [number, () => void] | undefined
    assert.ok(next)
    scheduled.delete(next[0])
    next[1]()
  }
  const event = { eventType: 'rename', filename: 'sketch\\src\\main.cpp' }
  sync.handle('C:\\work\\device-a', event)
  sync.handle('C:\\work\\device-a', event)
  assert.equal(scheduled.size, 1)

  runNextTimer()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(reloads, 1)
  assert.equal(scheduled.size, 1)
  assert.equal(renders, 0)

  runNextTimer()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(reloads, 2)
  assert.equal(renders, 1)
  sync.dispose()
})
