import assert from 'node:assert/strict'
import test from 'node:test'
import { AilyTabSnooze } from './ailyTabSnooze'

test('reload retains the original pause deadline and expiry clears persistence', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000_000 })
  let saved: unknown
  let updates = 0
  const store = { read: () => saved, write: (until: number) => { saved = until || undefined } }
  const first = new AilyTabSnooze(store, () => updates++)
  await first.pause(300_000)
  t.mock.timers.tick(120_000)
  first.dispose()
  const restored = new AilyTabSnooze(store, () => updates++)
  assert.equal(restored.until, 1_300_000)
  t.mock.timers.tick(179_000)
  assert.equal(restored.until, 1_300_000)
  t.mock.timers.tick(1000)
  assert.equal(restored.until, 0)
  assert.equal(saved, undefined)
  assert.ok(updates > 3, 'remaining time updates while paused')
  restored.dispose()
})

test('resume and changed duration cancel the previous deadline', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000_000 })
  let saved: unknown
  const store = { read: () => saved, write: (until: number) => { saved = until || undefined } }
  const snooze = new AilyTabSnooze(store, () => {})
  await snooze.pause(300_000)
  await snooze.pause(1_800_000)
  t.mock.timers.tick(300_000)
  assert.equal(snooze.until, 2_800_000)
  await snooze.resume()
  assert.equal(saved, undefined)
  snooze.dispose()
  const restored = new AilyTabSnooze(store, () => {})
  assert.equal(restored.until, 0)
  restored.dispose()
})

test('expired, malformed and out-of-range saved pauses never disable suggestions', t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000_000 })
  for (const value of [undefined, 0, -1, '1300000', NaN, Infinity, 999_999, 1_000_000 + 8 * 60 * 60_000 + 1]) {
    let saved = value
    const snooze = new AilyTabSnooze({ read: () => saved, write: () => { saved = undefined } }, () => {})
    assert.equal(snooze.until, 0, String(value))
    snooze.dispose()
  }
})

test('pause and resume wait for durable storage before reporting completion', async () => {
  let saved: unknown
  let finish!: () => void
  let updates = 0
  const snooze = new AilyTabSnooze({
    read: () => saved,
    write: until => { saved = until },
    flush: () => new Promise<void>(resolve => { finish = resolve }),
  }, () => updates++)
  updates = 0
  const pausing = snooze.pause(300_000)
  assert.equal(updates, 0)
  finish()
  await pausing
  assert.equal(updates, 1)
  const resuming = snooze.resume()
  assert.equal(updates, 1)
  finish()
  await resuming
  assert.equal(updates, 2)
  snooze.dispose()
})
