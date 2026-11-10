import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import {
  createSimulatorSourceReceiver,
  HOST_SIMULATOR_SOURCE_REQUEST,
  MAX_SIMULATOR_SOURCE_BYTES,
  readSimulatorSourceHostOrigin,
  readSimulatorSourceRequest,
  type SimulatorSourceShow
} from './hostSimulatorSource'

const text = 'void helper() {\r\n  const char* label = "电机";\r\n}\r\n'
const bytes = new TextEncoder().encode(text)
const hash = (data: Uint8Array) => createHash('sha256').update(data).digest('hex')
const show = (sequence: number, values: Partial<SimulatorSourceShow> = {}): SimulatorSourceShow => ({
  action: 'show', requestId: `req-${sequence}`, sequence, path: 'sketch/src/驱动/smoke.cpp',
  sha256: hash(bytes), line: 2, focus: false, ...values
})
const clear = (sequence: number) => ({ action: 'clear' as const, requestId: `req-${sequence}`, sequence })

test('frame accepts only exact configured web origins and portable project source requests', () => {
  assert.equal(readSimulatorSourceHostOrigin('http://127.0.0.1:4200'), 'http://127.0.0.1:4200')
  assert.equal(readSimulatorSourceHostOrigin('https://example.test'), 'https://example.test')
  for (const value of [null, 'null', '*', 'file:///x', 'https://example.test/path', 'https://a@example.test']) {
    assert.equal(readSimulatorSourceHostOrigin(value), null)
  }
  const envelope = { channel: HOST_SIMULATOR_SOURCE_REQUEST, v: 1 }
  assert.deepEqual(readSimulatorSourceRequest({ ...envelope, ...show(1) }), show(1))
  assert.deepEqual(readSimulatorSourceRequest({ ...envelope, ...clear(2) }), clear(2))
  for (const path of ['/src/main.cpp', '../main.cpp', 'src/../main.cpp', 'src//main.cpp', 'C:/main.cpp',
    'src\\main.cpp', '.aily/main.cpp', 'src/main.cpp\u0000', 'src/secret.json']) {
    assert.equal(readSimulatorSourceRequest({ ...envelope, ...show(1, { path }) }), null)
  }
  for (const change of [{ v: 2 }, { sequence: 0 }, { line: 0 }, { sha256: 'a'.repeat(63) }, { focus: 'false' }]) {
    assert.equal(readSimulatorSourceRequest({ ...envelope, ...show(1), ...change }), null)
  }
})

test('capability probes have a generation-specific ID and do not carry a navigation sequence or location', () => {
  const envelope = { channel: HOST_SIMULATOR_SOURCE_REQUEST, v: 1 }
  const probe = { action: 'probe', requestId: 'simulator-source-probe-21' }
  assert.deepEqual(readSimulatorSourceRequest({ ...envelope, ...probe }), probe)
  for (const change of [{ requestId: 'req-1' }, { sequence: 1 }, { requestId: 'simulator-source-probe-0' },
    { focus: false }, { path: 'sketch/src/main.cpp' }]) {
    assert.equal(readSimulatorSourceRequest({ ...envelope, ...probe, ...change }), null)
  }
})

test('secondary source exact bytes are checked before revealing the saved line', async () => {
  const applied: Array<{ path: string, line: number, source: string }> = []
  let removed = 0
  const receiver = createSimulatorSourceReceiver({
    async read(path) { assert.equal(path, show(1).path); return bytes },
    async show(request, source, current) {
      assert.equal(current(), true)
      applied.push({ path: request.path, line: request.line, source })
      return () => { removed++ }
    }
  })
  assert.equal(await receiver.receive(show(1)), 'applied')
  assert.deepEqual(applied, [{ path: show(1).path, line: 2, source: text.replaceAll('\r\n', '\n') }])
  assert.equal(await receiver.receive(clear(2)), 'applied')
  assert.equal(removed, 1)
  assert.equal(await receiver.receive(show(1)), 'ignored')
  assert.equal(await receiver.receive(show(3, { sha256: '0'.repeat(64) })), 'ignored')
  assert.equal(await receiver.receive(show(4, { line: 99 })), 'ignored')
  assert.equal(applied.length, 1)
})

test('bad UTF-8, oversized sources, and unavailable editor models never produce a marker', async () => {
  for (const badBytes of [Uint8Array.of(0xff), new Uint8Array(MAX_SIMULATOR_SOURCE_BYTES + 1)]) {
    const receiver = createSimulatorSourceReceiver({
      async read() { return badBytes },
      async show() { assert.fail('unverified sources must never open an editor') }
    })
    assert.equal(await receiver.receive(show(1, { sha256: hash(badBytes) })), 'ignored')
  }
  const receiver = createSimulatorSourceReceiver({ async read() { return bytes }, async show() { return null } })
  assert.equal(await receiver.receive(show(1)), 'ignored')
})

test('a clear during a source read prevents a stale stop from opening an editor', async () => {
  let finishRead!: (value: Uint8Array) => void
  const receiver = createSimulatorSourceReceiver({
    read: () => new Promise(resolve => { finishRead = resolve }),
    async show() { assert.fail('stale reads must never open an editor') }
  })
  const pending = receiver.receive(show(1))
  assert.equal(await receiver.receive(clear(2)), 'applied')
  finishRead(bytes)
  assert.equal(await pending, 'ignored')
})

test('a replacement stop or frame close discards late markers and disposes the current marker', async () => {
  let finishShow!: (dispose: () => void) => void
  let didEnter!: () => void
  const entered = new Promise<void>(resolve => { didEnter = resolve })
  const removals: number[] = []
  const receiver = createSimulatorSourceReceiver({
    async read() { return bytes },
    async show(request, _source, current) {
      if (request.sequence === 1) {
        didEnter()
        const dispose = await new Promise<() => void>(resolve => { finishShow = resolve })
        assert.equal(current(), false)
        return dispose
      }
      return () => { removals.push(request.sequence) }
    }
  })
  const pending = receiver.receive(show(1))
  await entered
  assert.equal(await receiver.receive(show(2)), 'applied')
  finishShow(() => { removals.push(1) })
  assert.equal(await pending, 'ignored')
  receiver.close()
  assert.deepEqual(removals, [1, 2])
  assert.equal(await receiver.receive(show(3)), 'ignored')
})
