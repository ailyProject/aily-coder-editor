import type { TextEdit } from './suggestionProtocol'

export type PreviewHighlight = { line: number; start: number; end: number }
export type EditPreview = {
  before: string
  after: string
  lastLine: number
  singleLine: boolean
  beforeHighlights: PreviewHighlight[]
  afterHighlights: PreviewHighlight[]
}

type Token = { value: string; start: number; end: number }
function tokens(text: string): Token[] {
  const result: Token[] = []
  for (const match of text.matchAll(/\s+|[A-Za-z_$][A-Za-z0-9_$]*|\d+(?:\.\d+)?|./gu)) {
    const start = match.index
    result.push({ value: match[0], start, end: start + match[0].length })
  }
  return result
}
function trimWhitespace(text: string, start: number, end: number): { start: number; end: number } | undefined {
  while (start < end && /\s/.test(text[start]!)) start++
  while (end > start && /\s/.test(text[end - 1]!)) end--
  return end > start ? { start, end } : undefined
}
function coalesceUnmatched(text: string, values: Token[], matched: Set<number>): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = []
  let start = -1; let end = -1
  for (let index = 0; index < values.length; index++) {
    if (matched.has(index)) {
      const range = start >= 0 ? trimWhitespace(text, start, end) : undefined
      if (range) ranges.push(range)
      start = end = -1
    } else {
      if (start < 0) start = values[index]!.start
      end = values[index]!.end
    }
  }
  const range = start >= 0 ? trimWhitespace(text, start, end) : undefined
  if (range) ranges.push(range)
  return ranges
}
function fallbackHighlights(before: string, after: string): [Array<{ start: number; end: number }>, Array<{ start: number; end: number }>] {
  let prefix = 0
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++
  let suffix = 0
  while (suffix < before.length - prefix && suffix < after.length - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++
  const oldRange = trimWhitespace(before, prefix, before.length - suffix)
  const newRange = trimWhitespace(after, prefix, after.length - suffix)
  return [oldRange ? [oldRange] : [], newRange ? [newRange] : []]
}
/** Token-level LCS gives the same compact red/green emphasis as an inline diff:
 * repeated identifiers on one line remain separate from unchanged punctuation. */
function lineHighlights(before: string, after: string): [Array<{ start: number; end: number }>, Array<{ start: number; end: number }>] {
  if (before === after) return [[], []]
  const oldTokens = tokens(before); const newTokens = tokens(after)
  if (!oldTokens.length || !newTokens.length || oldTokens.length * newTokens.length > 4096) return fallbackHighlights(before, after)
  const width = newTokens.length + 1
  const table = new Uint16Array((oldTokens.length + 1) * width)
  for (let oldIndex = oldTokens.length - 1; oldIndex >= 0; oldIndex--) {
    for (let newIndex = newTokens.length - 1; newIndex >= 0; newIndex--) {
      const at = oldIndex * width + newIndex
      table[at] = oldTokens[oldIndex]!.value === newTokens[newIndex]!.value
        ? table[(oldIndex + 1) * width + newIndex + 1]! + 1
        : Math.max(table[(oldIndex + 1) * width + newIndex]!, table[oldIndex * width + newIndex + 1]!)
    }
  }
  const oldMatched = new Set<number>(); const newMatched = new Set<number>()
  let oldIndex = 0; let newIndex = 0
  while (oldIndex < oldTokens.length && newIndex < newTokens.length) {
    if (oldTokens[oldIndex]!.value === newTokens[newIndex]!.value) {
      oldMatched.add(oldIndex++); newMatched.add(newIndex++)
    } else if (table[(oldIndex + 1) * width + newIndex]! >= table[oldIndex * width + newIndex + 1]!) oldIndex++
    else newIndex++
  }
  const oldRanges = coalesceUnmatched(before, oldTokens, oldMatched)
  const newRanges = coalesceUnmatched(after, newTokens, newMatched)
  // Refine a one-token correction (prinln -> println) down to the actual
  // inserted/deleted characters while keeping full identifier renames clear.
  if (oldRanges.length === 1 && newRanges.length === 1) {
    const oldRange = oldRanges[0]!; const newRange = newRanges[0]!
    const [oldInner, newInner] = fallbackHighlights(before.slice(oldRange.start, oldRange.end), after.slice(newRange.start, newRange.end))
    if (oldInner.length || newInner.length) return [
      oldInner.map(range => ({ start: range.start + oldRange.start, end: range.end + oldRange.start })),
      newInner.map(range => ({ start: range.start + newRange.start, end: range.end + newRange.start })),
    ]
  }
  return [oldRanges, newRanges]
}

/** Render the resulting source lines, not an isolated model token such as "t".
 * This projection never changes the edit coordinates used by the transaction. */
export function describeEditPreview(text: string, edit: TextEdit): EditPreview {
  const lines = text.split(/\r?\n/)
  const { start, end } = edit.range
  const endsAtNextLine = end.line > start.line && end.character === 0
  const lastLine = endsAtNextLine ? end.line - 1 : end.line
  const before = lines.slice(start.line, lastLine + 1).join('\n')
  let after = (lines[start.line] ?? '').slice(0, start.character) + edit.newText.replace(/\r\n/g, '\n') +
    (endsAtNextLine ? '' : (lines[end.line] ?? '').slice(end.character))
  if (endsAtNextLine && after.endsWith('\n')) after = after.slice(0, -1)
  const beforeHighlights: PreviewHighlight[] = []; const afterHighlights: PreviewHighlight[] = []
  const beforeLines = before.split('\n'); const afterLines = after.split('\n')
  const count = Math.max(beforeLines.length, afterLines.length)
  for (let line = 0; line < count; line++) {
    const [oldRanges, newRanges] = lineHighlights(beforeLines[line] ?? '', afterLines[line] ?? '')
    beforeHighlights.push(...oldRanges.map(range => ({ line, ...range })))
    afterHighlights.push(...newRanges.map(range => ({ line, ...range })))
  }
  return { before, after, lastLine, singleLine: start.line === end.line && !/[\r\n]/.test(edit.newText), beforeHighlights, afterHighlights }
}
