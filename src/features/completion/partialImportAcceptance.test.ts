import assert from 'node:assert/strict'
import test from 'node:test'
import { partialLength, planPartialImportAcceptance } from './partialImportAcceptance'
import type { Suggestion } from './suggestionProtocol'

function fixture(newText = 'tor<int> values;') {
  const text = '// 😀\r\n  std::vec'
  const position = { line: 1, character: 10 }
  const extra = { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, expectedText: '', newText: '#include <vector>\r\n' }
  const candidate: Suggestion = { fileId: 'file', snapshotId: 'one', candidateId: 'candidate', kind: 'insert', primary: { range: { start: position, end: position }, expectedText: '', newText }, additionalEdits: [extra] }
  return { text, candidate, bindings: [{ symbol: 'vector', edits: [extra] }] }
}
test('partial symbol acceptance adds its import atomically and rebases the remaining UTF-16/CRLF cursor', () => {
  const h = fixture(); const plan = planPartialImportAcceptance(h.text, h.candidate, h.bindings, partialLength(h.candidate.primary.newText, 'word'))
  assert.equal(plan.text, '#include <vector>\r\n// 😀\r\n  std::vector')
  assert.equal(plan.applied.additionalEdits.length, 1)
  assert.deepEqual(plan.point, { line: 2, character: 13 })
  assert.equal(plan.remaining.primary.newText, '<int> values;'); assert.equal(plan.remaining.additionalEdits.length, 0)
  const next = planPartialImportAcceptance(plan.text, plan.remaining, plan.bindings, 1)
  assert.equal(next.text.match(/#include/g)?.length, 1)
})
test('prefix before a new symbol does not add the header prematurely', () => {
  const h = fixture('const vector<int> values;')
  h.text = '// vector is requested later 😀\r\n          '
  const first = planPartialImportAcceptance(h.text, h.candidate, h.bindings, partialLength(h.candidate.primary.newText, 'word'))
  assert.equal(first.applied.additionalEdits.length, 0); assert.ok(!first.text.includes('#include'))
  const second = planPartialImportAcceptance(first.text, first.remaining, first.bindings, partialLength(first.remaining.primary.newText, 'word'))
  assert.equal(second.applied.additionalEdits.length, 1); assert.ok(second.text.includes('#include <vector>'))
})
test('line acceptance includes one line and overlapping edits never form a transaction', () => {
  assert.equal(partialLength('one\r\ntwo', 'line'), 5)
  const h = fixture(); h.candidate.additionalEdits[0]!.range = h.candidate.primary.range
  assert.throws(() => planPartialImportAcceptance(h.text, h.candidate, h.bindings, 3))
})
