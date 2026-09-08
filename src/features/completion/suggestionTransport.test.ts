import assert from 'node:assert/strict'
import test from 'node:test'
import { ParentSuggestionTransport } from './suggestionTransport'
import { SUGGESTION_EVENT_CHANNEL, parseSuggestionRequest } from './suggestionProtocol'
import fixture from './fixtures/v4-contract.json'

function harness() {
  const events = new EventTarget()
  const sent: Array<Record<string, unknown>> = []
  const parent = { postMessage: (message: Record<string, unknown>) => sent.push(message) }
  const host = Object.assign(events, { parent }) as unknown as Window
  const transport = new ParentSuggestionTransport(host)
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
test('explicit 404 negotiates legacy but 402 does not', async () => {
  for (const status of [404, 402]) {
    const { transport, sent, emit } = harness(); const pending = transport.capabilities()
    emit({ type: 'error', requestId: sent[0]!['requestId'], status, code: 'test' })
    if (status === 404) assert.equal(await pending, null)
    else await assert.rejects(pending, error => (error as { status: number }).status === 402)
    transport.dispose()
  }
})
test('old host without ack is detected without waiting 14 seconds', async () => {
  const { transport } = harness(); assert.equal(await transport.capabilities(), null); transport.dispose()
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
