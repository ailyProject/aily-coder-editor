import type { RecentEdit, TextEdit } from './suggestionProtocol'

export const MAX_PREDICTION_CHAIN = 5
/** Enter may include indentation and the second newline inserted between braces.
 * Only a real typing event qualifies; paste/undo/external writes never wake AI. */
export function isTypedLineBreak(changes: readonly { text: string; rangeLength: number }[], origin: RecentEdit['origin']): boolean {
  return origin === 'typing' && changes.length === 1 && changes[0]!.rangeLength <= 128 &&
    /^\r?\n[\t ]*(?:\r?\n[\t ]*)?$/.test(changes[0]!.text)
}
/** The pinned Workbench supplies real edit provenance. Unknown writes are never
 * inferred to be typing from focus, text length or the active document. */
export function editOrigin(reason: { source: string; metadata?: Record<string, unknown> } | undefined): RecentEdit['origin'] {
  if (!reason) return 'external'
  if (reason.source === 'inlineCompletionAccept' || reason.source === 'inlineCompletionPartialAccept') return 'completion'
  if (reason.source !== 'cursor') return 'external'
  if (reason.metadata?.['kind'] === 'paste') return 'paste'
  if (['type', 'compositionType', 'compositionEnd', 'cut'].includes(String(reason.metadata?.['kind']))) return 'typing'
  return reason.metadata?.['detailedSource'] === 'keyboard' ? 'typing' : 'external'
}
export function hasRecentReplacement(edits: readonly RecentEdit[], fileId: string): boolean {
  return edits.some(edit => edit.fileId === fileId && edit.origin === 'typing' && edit.ageMs <= 2000 && !!edit.before.trim() && !!edit.after.trim() && edit.after.length <= 128)
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/
const identifierCharacter = (value: string | undefined): boolean => !!value && /[A-Za-z0-9_$]/.test(value)
function renameIdentifier(line: string, before: string, after: string): string {
  let result = ''; let offset = 0
  while (offset < line.length) {
    const found = line.indexOf(before, offset)
    if (found < 0) return result + line.slice(offset)
    const end = found + before.length
    if (!identifierCharacter(line[found - 1]) && !identifierCharacter(line[end])) {
      result += line.slice(offset, found) + after; offset = end
    } else { result += line.slice(offset, end); offset = end }
  }
  return result
}

/** Aily Tab presents a rename as a chain of local edits: accept the nearest
 * reference, then predict the next one. Keep genuine multi-line rewrites intact. */
export function focusFirstRenameReference(edit: TextEdit, recentEdits: readonly RecentEdit[], maxAgeMs = 2000): TextEdit {
  const rename = [...recentEdits].reverse().find(item => item.origin === 'typing' && item.ageMs <= maxAgeMs &&
    IDENTIFIER.test(item.before) && IDENTIFIER.test(item.after) && item.before !== item.after)
  if (!rename) return edit
  const terminalBreak = edit.expectedText.endsWith('\r\n') ? '\r\n' : edit.expectedText.endsWith('\n') ? '\n' : ''
  // Providers occasionally omit the completion window's terminal newline
  // while changing only an identifier. Compare the intended rename with that
  // boundary restored so accepting a reference can never join source lines.
  const proposed = terminalBreak && !edit.newText.endsWith('\n') ? edit.newText + terminalBreak : edit.newText
  const beforeLines = edit.expectedText.replace(/\r\n/g, '\n').split('\n')
  const afterLines = proposed.replace(/\r\n/g, '\n').split('\n')
  if (beforeLines.length !== afterLines.length) return edit
  const changed = beforeLines.map((line, index) => line === afterLines[index] ? -1 : index).filter(index => index >= 0)
  if (!changed.length || changed.some(index => renameIdentifier(beforeLines[index]!, rename.before, rename.after) !== afterLines[index])) return edit
  const index = changed[0]!
  const character = index === 0 ? edit.range.start.character : 0
  return {
    range: { start: { line: edit.range.start.line + index, character },
      end: { line: edit.range.start.line + index, character: character + beforeLines[index]!.length } },
    expectedText: beforeLines[index]!, newText: afterLines[index]!,
  }
}

/** Keep the exact edit, but remove context that the model left unchanged. */
export function minimalEdit(edit: TextEdit): TextEdit {
  const before = edit.expectedText; const after = edit.newText
  let prefix = 0
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++
  // Never split a surrogate pair or a CRLF boundary.
  if (prefix && /[\uD800-\uDBFF\r]/.test(before[prefix - 1]!)) prefix--
  let suffix = 0
  while (suffix < before.length - prefix && suffix < after.length - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++
  if (suffix && /[\uDC00-\uDFFF\n]/.test(before[before.length - suffix]!)) suffix--
  const advance = (text: string) => {
    const lines = text.split('\n')
    return lines.length > 1 ? { line: edit.range.start.line + lines.length - 1, character: lines.at(-1)!.length }
      : { line: edit.range.start.line, character: edit.range.start.character + text.length }
  }
  return { range: { start: advance(before.slice(0, prefix)), end: advance(before.slice(0, before.length - suffix)) },
    expectedText: before.slice(prefix, before.length - suffix), newText: after.slice(prefix, after.length - suffix) }
}
