import type { Position, Suggestion, TextEdit } from './suggestionProtocol'

export type ImportBinding = { symbol: string; edits: TextEdit[] }
export function partialLength(text: string, unit: 'word' | 'line'): number {
  if (unit === 'line') { const end = text.indexOf('\n'); return end < 0 ? text.length : end + 1 }
  return text.match(/^\s*(?:[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]+)/u)?.[0].length ?? text.length
}
function offsetAt(text: string, position: Position): number {
  const lines = text.split('\n')
  if (position.line >= lines.length || position.character > lines[position.line]!.replace(/\r$/, '').length) throw new Error('Invalid partial edit position')
  return lines.slice(0, position.line).reduce((size, line) => size + line.length + 1, 0) + position.character
}
function positionAt(text: string, offset: number): Position {
  const parts = text.slice(0, offset).split('\n')
  return { line: parts.length - 1, character: parts.at(-1)!.length }
}
/** Plan one prefix and only the imports whose complete symbols are now present. All offsets are UTF-16. */
export function planPartialImportAcceptance(text: string, candidate: Suggestion, bindings: ImportBinding[], count: number) {
  if (candidate.kind !== 'insert' || candidate.primary.expectedText || count <= 0 || count > candidate.primary.newText.length) throw new Error('Not a partial insertion')
  const cursor = offsetAt(text, candidate.primary.range.start)
  const prefix = candidate.primary.newText.slice(0, count)
  const completed = (text.slice(0, cursor).match(/[A-Za-z_]\w*$/)?.[0] ?? '') + prefix
  const selected = bindings.filter(binding => new RegExp(`\\b${binding.symbol}\\b`).test(completed))
  const signature = (edit: TextEdit) => JSON.stringify(edit)
  const selectedEdits = new Set(selected.flatMap(binding => binding.edits.map(signature)))
  const imports = candidate.additionalEdits.filter(edit => selectedEdits.has(signature(edit)))
  const primary = { ...candidate.primary, newText: prefix }
  const operations = [primary, ...imports].map(edit => ({ edit, start: offsetAt(text, edit.range.start), end: offsetAt(text, edit.range.end) })).sort((a, b) => a.start - b.start)
  for (let index = 0; index < operations.length; index++) {
    const operation = operations[index]!
    if (text.slice(operation.start, operation.end) !== operation.edit.expectedText || (index > 0 && operations[index - 1]!.end >= operation.start)) throw new Error('Ambiguous partial import edits')
  }
  let updated = text
  for (const operation of [...operations].reverse()) updated = updated.slice(0, operation.start) + operation.edit.newText + updated.slice(operation.end)
  const shift = (offset: number) => offset + operations.filter(operation => operation.end <= offset).reduce((total, operation) => total + operation.edit.newText.length - operation.end + operation.start, 0)
  const rebase = (edit: TextEdit): TextEdit => ({ ...edit, range: { start: positionAt(updated, shift(offsetAt(text, edit.range.start))), end: positionAt(updated, shift(offsetAt(text, edit.range.end))) } })
  const remainingImports = candidate.additionalEdits.filter(edit => !selectedEdits.has(signature(edit))).map(rebase)
  const remainingBindings = bindings.filter(binding => !selected.includes(binding)).map(binding => ({ ...binding, edits: binding.edits.map(rebase) }))
  const point = positionAt(updated, shift(cursor))
  return { text: updated, offset: shift(cursor), point, applied: { ...candidate, primary, additionalEdits: imports }, bindings: remainingBindings,
    remaining: { ...candidate, primary: { range: { start: point, end: point }, expectedText: '', newText: candidate.primary.newText.slice(count) }, additionalEdits: remainingImports } }
}
