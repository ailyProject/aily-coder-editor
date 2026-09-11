import type { TextEdit } from './suggestionProtocol'

/** Render the resulting source lines, not an isolated model token such as "t".
 * This projection never changes the edit coordinates used by the transaction. */
export function describeEditPreview(text: string, edit: TextEdit): { before: string; after: string; lastLine: number; singleLine: boolean } {
  const lines = text.split(/\r?\n/)
  const { start, end } = edit.range
  const endsAtNextLine = end.line > start.line && end.character === 0
  const lastLine = endsAtNextLine ? end.line - 1 : end.line
  const before = lines.slice(start.line, lastLine + 1).join('\n')
  let after = (lines[start.line] ?? '').slice(0, start.character) + edit.newText.replace(/\r\n/g, '\n') +
    (endsAtNextLine ? '' : (lines[end.line] ?? '').slice(end.character))
  if (endsAtNextLine && after.endsWith('\n')) after = after.slice(0, -1)
  return { before, after, lastLine, singleLine: start.line === end.line && !/[\r\n]/.test(edit.newText) }
}
