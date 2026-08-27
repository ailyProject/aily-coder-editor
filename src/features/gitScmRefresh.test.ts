import assert from 'node:assert/strict'
import test from 'node:test'
import { createTrailingSingleFlight } from './gitScmRefresh.js'

test('coalesces concurrent refresh requests into one trailing run', async () => {
  let calls = 0
  let releaseFirst!: () => void
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve
  })
  const refresh = createTrailingSingleFlight(async () => {
    calls += 1
    if (calls === 1) {
      await firstGate
    }
  })

  const first = refresh()
  const second = refresh()
  const third = refresh()
  assert.equal(first, second)
  assert.equal(second, third)
  assert.equal(calls, 1)

  releaseFirst()
  await first
  assert.equal(calls, 2)
})

test('starts cleanly again after a failed run', async () => {
  let calls = 0
  const refresh = createTrailingSingleFlight(async () => {
    calls += 1
    if (calls === 1) throw new Error('first run failed')
  })

  await assert.rejects(refresh(), /first run failed/)
  await refresh()
  assert.equal(calls, 2)
})
