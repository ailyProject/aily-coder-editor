import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync, existsSync } from 'node:fs'
import fixture from './fixtures/v4-contract.json'
import { parseSuggestionRequest, validateSuggestionResult, SuggestionSseDecoder, type SuggestionResult, type Suggestion } from './suggestionProtocol'
import { CompletionCoordinator, RecentEditStore, isCompletionSource } from './completionState'
const request = () => parseSuggestionRequest(structuredClone(fixture.request))
function response(input = request()): SuggestionResult {
  const window = input.documents[0]!.windows[0]!
  return { protocolVersion: 2, requestId: input.requestId, opportunityId: input.opportunityId, completionId: fixture.completionId,
    suggestions: [{ candidateId: `${fixture.completionId}_0`, fileId: 'main', snapshotId: 'snapshot-1', kind: 'edit',
      primary: { range: window.range, expectedText: window.text, newText: fixture.model.suggestions[0]!.newText },
      additionalEdits: [] }], expiresInMs: 15000, finishReason: 'complete' }
}
const sse = (type: string, value: object) => `event: ${type}\r\ndata: ${JSON.stringify({ type, ...value })}\r\n\r\n`

test('shared host contract is byte-identical when sibling workspace is present', () => {
  const host = '/Users/downey/Projects/OutSource/aily--blockly/src/app/editors/code-editor-pro/services/code-suggestion-protocol.ts'
  if (existsSync(host)) assert.equal(readFileSync(host, 'utf8'), readFileSync(new URL('./suggestionProtocol.ts', import.meta.url), 'utf8'))
})
test('preserves global coordinates, CRLF and UTF-16 in a server-owned result', () => {
  const input = request(); assert.equal(input.documents[0]!.windows[0]!.range.start.line, 100)
  assert.equal(validateSuggestionResult(response(input), input).suggestions[0]!.primary.expectedText, 'const char* label = "😀";\r\n')
})
for (const [name, mutate] of Object.entries({
  'unknown fields': (v: typeof fixture.request & { endpoint?: string }) => { v.endpoint = 'https://example.com' },
  'workspace escape': (v: typeof fixture.request & { endpoint?: string }) => { v.documents[0]!.relativePath = '../secret.cpp' },
  'absolute path': (v: typeof fixture.request & { endpoint?: string }) => { v.documents[0]!.relativePath = 'C:\\private.cpp' },
  'unknown active snapshot': (v: typeof fixture.request & { endpoint?: string }) => { v.active.snapshotId = 'old' },
  'duplicate window': (v: typeof fixture.request & { endpoint?: string }) => { v.documents[0]!.windows.push(v.documents[0]!.windows[0]!) },
  'UTF-16 range mismatch': (v: typeof fixture.request & { endpoint?: string }) => { v.documents[0]!.windows[0]!.range.end.character = 1 },
  'cross-file opt in': (v: typeof fixture.request & { endpoint?: string }) => { v.options.crossFile = true },
  'too many candidates': (v: typeof fixture.request & { endpoint?: string }) => { v.options.maxCandidates = 4 },
  'mismatched ID': (v: typeof fixture.request & { endpoint?: string }) => { v.opportunityId = crypto.randomUUID() },
  'active is read-only': (v: typeof fixture.request & { endpoint?: string }) => { v.documents[0]!.permission = 'context-only' },
})) test(`request rejects ${name}`, () => { const value = structuredClone(fixture.request); mutate(value); assert.throws(() => parseSuggestionRequest(value)) })
for (const [name, mutate] of Object.entries({
  'stale target': (v: SuggestionResult & { suggestions: Array<Suggestion & { command?: string }> }) => { v.suggestions[0]!.snapshotId = 'old' },
  'invented source': (v: SuggestionResult & { suggestions: Array<Suggestion & { command?: string }> }) => { v.suggestions[0]!.fileId = 'other' },
  'incorrect expected text': (v: SuggestionResult & { suggestions: Array<Suggestion & { command?: string }> }) => { v.suggestions[0]!.primary.expectedText = 'other' },
  'new range': (v: SuggestionResult & { suggestions: Array<Suggestion & { command?: string }> }) => { v.suggestions[0]!.primary.range.start.line = 0 },
  'model command': (v: SuggestionResult & { suggestions: Array<Suggestion & { command?: string }> }) => { v.suggestions[0]!.command = 'run' },
  'wrong kind': (v: SuggestionResult & { suggestions: Array<Suggestion & { command?: string }> }) => { v.suggestions[0]!.kind = 'insert' },
  'foreign completion': (v: SuggestionResult & { suggestions: Array<Suggestion & { command?: string }> }) => { v.suggestions[0]!.candidateId = 'cmp_invalid' },
  'duplicate result': (v: SuggestionResult & { suggestions: Array<Suggestion & { command?: string }> }) => { v.suggestions.push(v.suggestions[0]!) },
  'no-op': (v: SuggestionResult & { suggestions: Array<Suggestion & { command?: string }> }) => { v.suggestions[0]!.primary.newText = v.suggestions[0]!.primary.expectedText },
})) test(`result rejects ${name}`, () => { const value = response(); mutate(value); assert.throws(() => validateSuggestionResult(value, request())) })
test('deletion is a real edit, and no-suggestion is a separate successful result', () => {
  const value = response(); value.suggestions[0]!.primary.newText = ''; assert.equal(validateSuggestionResult(value, request()).suggestions.length, 1)
  value.suggestions = []; value.finishReason = 'no-suggestion'; assert.equal(validateSuggestionResult(value, request()).suggestions.length, 0)
})
test('additional imports require an exact locally authorized text and non-overlapping window', () => {
  const input = request(); const value = response(input); const window = input.documents[0]!.windows[1]!
  value.suggestions[0]!.additionalEdits = [{ range: window.range, expectedText: '', newText: window.allowedNewText![0]! }]
  assert.equal(validateSuggestionResult(value, input).suggestions[0]!.additionalEdits.length, 1)
  value.suggestions[0]!.additionalEdits[0]!.newText = '#include <Imaginary.h>\n'
  assert.throws(() => validateSuggestionResult(value, input))
})
test('v4 SSE needs meta, one valid result and matching done, even across every split point', () => {
  const input = request(); const result = response(input); const identity = { protocolVersion: 2, requestId: input.requestId, opportunityId: input.opportunityId, completionId: result.completionId }
  const stream = sse('meta', identity) + sse('result', result) + sse('done', identity)
  for (let split = 0; split <= stream.length; split++) { const decoder = new SuggestionSseDecoder(input); decoder.push(stream.slice(0, split)); decoder.push(stream.slice(split)); assert.equal(decoder.finish().completionId, result.completionId) }
  for (const invalid of [sse('result', result), sse('meta', identity) + sse('result', result), sse('meta', identity) + sse('done', identity), sse('meta', identity) + sse('result', result) + sse('result', result), stream + sse('done', identity)]) {
    assert.throws(() => { const decoder = new SuggestionSseDecoder(input); decoder.push(invalid); decoder.finish() })
  }
})
test('server error after a plausible result cannot become an accepted edit', () => {
  const input = request(); const value = response(input); const identity = { protocolVersion: 2, requestId: input.requestId, opportunityId: input.opportunityId, completionId: value.completionId }
  const decoder = new SuggestionSseDecoder(input)
  assert.throws(() => decoder.push(sse('meta', identity) + sse('result', value) + sse('error', { ...identity, code: 'FAILED' })))
})
test('meta cannot introduce a different completion identity', () => {
  const input = request(); const value = response(input)
  const decoder = new SuggestionSseDecoder(input)
  assert.throws(() => decoder.push(sse('meta', { ...value, completionId: `sug_${'a'.repeat(32)}` }) + sse('result', value)))
})
test('coordinator cancels background work and admits only the latest queued input', async () => {
  const coordinator = new CompletionCoordinator(); const calls: string[] = []; let release!: () => void
  const first = coordinator.run(1, async signal => { calls.push('nes'); await new Promise<void>(resolve => { release = resolve }); assert.equal(signal.aborted, true); return 'old' })
  const second = coordinator.run(2, async () => { calls.push('obsolete'); return 2 }).catch(error => error.name)
  const third = coordinator.run(3, async () => { calls.push('manual'); return 3 })
  release(); assert.equal(await first, 'old'); assert.equal(await second, 'AbortError'); assert.equal(await third, 3); assert.deepEqual(calls, ['nes', 'manual'])
})
test('history stays bounded and never replays undo as a new intent', () => {
  const store = new RecentEditStore(); for (let i = 0; i < 40; i++) store.add('file', '', String(i), 'typing', i)
  store.add('file', 'x', '', 'undo', 50); assert.equal(store.read(100).length, 19); assert.equal(store.read(400_000).length, 0)
  store.clear(); assert.equal(store.read().length, 0)
})
test('adjacent typing retains the original replacement intent across keystrokes', () => {
  const store = new RecentEditStore(); store.add('file', 'oldName', 'n', 'typing', 1, 4)
  for (const [index, text] of [...'ewName'].entries()) store.add('file', '', text, 'typing', index + 2, index + 5)
  assert.deepEqual(store.read(100), [{ fileId: 'file', before: 'oldName', after: 'newName', origin: 'typing', ageMs: 93 }])
  store.add('file', '', 'x', 'typing', 110, 100); assert.equal(store.read(120).length, 2)
})
test('active source excludes credentials, generated code and dependency trees', () => {
  for (const file of ['/workspace/main.cpp', '/workspace/main.ino', '/workspace/test.ts']) assert.equal(isCompletionSource(file), true)
  for (const file of ['/workspace/.env.cpp', '/workspace/secrets.cpp', '/workspace/node_modules/a.ts', '/workspace/generated/main.cpp']) assert.equal(isCompletionSource(file), false)
})
