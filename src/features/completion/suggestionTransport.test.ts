import assert from 'node:assert/strict'
import test from 'node:test'
import { ParentSuggestionTransport } from './suggestionTransport'
import { SUGGESTION_EVENT_CHANNEL, parseSuggestionRequest } from './suggestionProtocol'
import fixture from './fixtures/v4-contract.json'
import { CompletionCoordinator } from './completionState'

function harness() {
  const events = new EventTarget()
  const sent: Array<Record<string, unknown>> = []
  const parent = { postMessage: (message: Record<string, unknown>) => sent.push(message) }
  const host = Object.assign(events, { parent }) as unknown as Window
  const transport = new ParentSuggestionTransport(host, new CompletionCoordinator())
  const emit = (data: object, source: unknown = parent) => events.dispatchEvent(Object.assign(new Event('message'), { data: { channel: SUGGESTION_EVENT_CHANNEL, ...data }, source }))
  const request = () => { const value = structuredClone(fixture.request); value.requestId = value.opportunityId = crypto.randomUUID(); return parseSuggestionRequest(value) }
  return { transport, sent, emit, request }
}
test('v4 ignores foreign frames and accepts only its pending result', async () => {
  const { transport, sent, emit, request } = harness(); const input = request()
  const pending = transport.suggest(input)
  const result = { protocolVersion: 2, requestId: input.requestId, opportunityId: input.opportunityId, completionId: `sug_${'a'.repeat(32)}`, suggestions: [], expiresInMs: 15000, finishReason: 'no-suggestion' }
  emit({ type: 'result', requestId: input.requestId, result }, {})
  assert.equal(sent.length, 1)
  emit({ type: 'result', requestId: input.requestId, result })
  assert.equal((await pending).finishReason, 'no-suggestion'); transport.dispose()
})
test('unsupported service and quota errors never negotiate a legacy provider', async () => {
  for (const status of [404, 405, 402, 429]) {
    const { transport, sent, emit } = harness(); const pending = transport.capabilities()
    emit({ type: 'error', requestId: sent[0]!['requestId'], status, code: 'test' })
    await assert.rejects(pending, error => (error as { status: number }).status === status)
    assert.equal(sent.length, 1)
    transport.dispose()
  }
})
test('old host without ack is detected without waiting 14 seconds', async () => {
  const { transport } = harness(); await assert.rejects(transport.capabilities(), { code: 'SUGGESTION_OLD_HOST', status: 426 }); transport.dispose()
})
test('consumer cancellation immediately cancels host inference and ignores late output', async () => {
  const { transport, sent, emit, request } = harness(); const input = request(); const controller = new AbortController()
  const pending = transport.suggest(input, controller.signal); controller.abort()
  await assert.rejects(pending, { name: 'AbortError' })
  assert.ok(sent.some(message => message['operation'] === 'cancel' && message['requestId'] === input.requestId))
  emit({ type: 'result', requestId: input.requestId, result: {} }); transport.dispose()
})
test('quota errors cool down requests and account change clears outstanding work', async () => {
  const { transport, sent, emit, request } = harness(); const input = request()
  const pending = transport.suggest(input)
  emit({ type: 'error', requestId: input.requestId, status: 429, code: 'rate', headers: { 'retry-after': '30' } })
  await assert.rejects(pending)
  await assert.rejects(transport.suggest(request()), error => (error as { code: string }).code === 'SUGGESTION_COOLDOWN')
  assert.equal(sent.filter(message => message['operation'] === 'suggest').length, 1)
  let changes = 0; transport.onSessionChanged = () => { changes++ }
  emit({ type: 'session-changed' }); assert.equal(changes, 1)
  const next = transport.suggest(request()); emit({ type: 'session-changed' })
  await assert.rejects(next, { name: 'AbortError' }); transport.dispose()
})
test('429 honors Retry-After and wakes the provider without another keystroke or reconnect', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] })
  const { transport, sent, emit, request } = harness(); const input = request()
  let wakes = 0; transport.onAvailabilityChanged = () => { if (!transport.unavailable) wakes++ }
  const pending = transport.suggest(input)
  emit({ type: 'error', requestId: input.requestId, status: 429, code: 'CODE_COMPLETION_DEVICE_CONCURRENCY_LIMITED', headers: { 'retry-after': '1' } })
  await assert.rejects(pending, { retryAfterMs: 1000 })
  t.mock.timers.tick(999)
  await assert.rejects(transport.suggest(request()), { code: 'SUGGESTION_COOLDOWN' })
  assert.equal(sent.filter(x => x['operation'] === 'suggest').length, 1)
  t.mock.timers.tick(1); assert.equal(wakes, 1); assert.equal(transport.unavailable, undefined)
  const nextInput = request(); const next = transport.suggest(nextInput)
  emit({ type: 'result', requestId: nextInput.requestId, result: { protocolVersion: 2, requestId: nextInput.requestId, opportunityId: nextInput.requestId, completionId: `sug_${'a'.repeat(32)}`, suggestions: [], expiresInMs: 15000, finishReason: 'no-suggestion' } })
  await next; assert.equal(sent.filter(x => x['operation'] === 'suggest').length, 2); transport.dispose()
})
test('HTTP-date Retry-After is preserved and entitlement failures do not auto-retry', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_700_000_000_000 })
  const { transport, sent, emit, request } = harness(); const input = request(); const pending = transport.suggest(input)
  emit({ type: 'error', requestId: input.requestId, status: 429, code: 'rate', headers: { 'retry-after': new Date(Date.now() + 120_000).toUTCString() } })
  await assert.rejects(pending, { retryAfterMs: 120_000 })
  t.mock.timers.tick(119_999); assert.ok(transport.unavailable)
  t.mock.timers.tick(1); assert.equal(transport.unavailable, undefined)
  const capability = transport.capabilities(); const id = sent.at(-1)!['requestId']
  emit({ type: 'error', requestId: id, status: 403, code: 'CODE_COMPLETION_NOT_ENTITLED' }); await assert.rejects(capability)
  t.mock.timers.tick(300_000); assert.equal((transport.unavailable as { status: number } | undefined)?.status, 403); transport.dispose()
})
test('provider SSE unavailable error cools down and wakes the latest opportunity', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] })
  const { transport, sent, emit, request } = harness(); const input = request()
  let wakes = 0; transport.onAvailabilityChanged = () => { if (!transport.unavailable) wakes++ }
  const pending = transport.suggest(input)
  emit({ type: 'error', requestId: input.requestId, status: 502, code: 'CODE_SUGGESTION_UNAVAILABLE' })
  await assert.rejects(pending, { code: 'CODE_SUGGESTION_UNAVAILABLE', status: 502, retryAfterMs: 2000 })
  await assert.rejects(transport.suggest(request()), { code: 'SUGGESTION_COOLDOWN' })
  assert.equal(sent.filter(x => x['operation'] === 'suggest').length, 1)
  t.mock.timers.tick(1999); assert.ok(transport.unavailable)
  t.mock.timers.tick(1); assert.equal(wakes, 1); assert.equal(transport.unavailable, undefined)
  transport.dispose()
})
test('invalid provider output does not schedule an automatic retry', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] })
  const { transport, emit, request } = harness(); const input = request()
  let wakes = 0; transport.onAvailabilityChanged = () => { wakes++ }
  const pending = transport.suggest(input)
  emit({ type: 'error', requestId: input.requestId, status: 502, code: 'INVALID_SUGGESTION_EDIT' })
  await assert.rejects(pending, { code: 'INVALID_SUGGESTION_EDIT', status: 502, retryAfterMs: 0 })
  assert.equal(transport.unavailable, undefined)
  t.mock.timers.tick(10_000); assert.equal(wakes, 0)
  transport.dispose()
})
