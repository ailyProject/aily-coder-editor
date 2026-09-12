export type RepeatedWordChange = { rangeOffset: number; rangeLength: number; text: string }
export type RepeatedWordOrigin = 'typing' | 'paste' | 'completion' | 'undo' | 'redo' | 'external' | 'cut'
export type RepeatedWordSuggestion = { rangeOffset: number; rangeLength: number; expectedText: string; newText: string }

const MAX_AGE_MS = 60_000
const MAX_FILES = 8
const MAX_INTENTS = 8
const MAX_WORD_LENGTH = 256
const wordPart = /^[\p{L}\p{N}\p{M}_$]$/u
const wholeWord = /^[\p{L}_$][\p{L}\p{N}\p{M}_$]*$/u

type Word = { start: number; end: number; text: string }
type Intent = { original: string; target: string; start: number; end: number; at: number }

function isWord(text: string): boolean {
  return text.length <= MAX_WORD_LENGTH && wholeWord.test(text) && /\p{L}/u.test(text)
}

function previousCharacter(text: string, offset: number): number {
  const previous = offset - 1
  return previous > 0 && /[\uDC00-\uDFFF]/.test(text[previous]!) && /[\uD800-\uDBFF]/.test(text[previous - 1]!) ? previous - 1 : previous
}

function characterEnd(text: string, offset: number): number {
  return offset + ((text.codePointAt(offset) ?? 0) > 0xFFFF ? 2 : 1)
}

/** Offsets are editor UTF-16 offsets, including when a word contains astral letters. */
function wordAt(text: string, offset: number): Word | undefined {
  if (!Number.isInteger(offset) || offset < 0 || offset > text.length) return undefined
  if (offset > 0 && offset < text.length && /[\uDC00-\uDFFF]/.test(text[offset]!) && /[\uD800-\uDBFF]/.test(text[offset - 1]!)) offset--
  let start = offset
  let end = offset
  while (start > 0) {
    const previous = previousCharacter(text, start)
    if (!wordPart.test(text.slice(previous, start))) break
    start = previous
    if (offset - start > MAX_WORD_LENGTH) return undefined
  }
  while (end < text.length) {
    const next = characterEnd(text, end)
    if (!wordPart.test(text.slice(end, next))) break
    end = next
    if (end - start > MAX_WORD_LENGTH) return undefined
  }
  const word = text.slice(start, end)
  return isWord(word) ? { start, end, text: word } : undefined
}

function validChanges(before: string, after: string, changes: readonly RepeatedWordChange[]): boolean {
  let previousEnd = -1
  let delta = 0
  for (const change of changes) {
    const end = change.rangeOffset + change.rangeLength
    if (!Number.isInteger(change.rangeOffset) || !Number.isInteger(change.rangeLength) || change.rangeOffset < 0 || change.rangeLength < 0 || end > before.length || change.rangeOffset < previousEnd) return false
    const startAfter = change.rangeOffset + delta
    if (after.slice(startAfter, startAfter + change.text.length) !== change.text) return false
    previousEnd = end
    delta += change.text.length - change.rangeLength
  }
  return before.length + delta === after.length
}

function matchesSource(text: string, intent: Intent): boolean {
  if (text.slice(intent.start, intent.end) !== intent.target) return false
  const current = wordAt(text, intent.start)
  return intent.target ? current?.start === intent.start && current.end === intent.end && current.text === intent.target : !current
}

/** Short-lived, local manual-edit intent. It never renames a document or learns AI edits. */
export class RepeatedWordHistory {
  private files = new Map<string, Intent[]>()

  observe(fileId: string, before: string, after: string, changes: readonly RepeatedWordChange[], origin: RepeatedWordOrigin, at = Date.now()): void {
    this.expire(at)
    if (!fileId || fileId.length > 4096) return
    if (origin === 'undo' || origin === 'redo' || origin === 'external') {
      this.files.delete(fileId)
      return
    }
    if (!changes.length || before === after) return
    const ordered = [...changes].sort((left, right) => left.rangeOffset - right.rangeOffset)
    if (!validChanges(before, after, ordered)) {
      this.files.delete(fileId)
      return
    }
    const manual = origin === 'typing' || origin === 'paste'
    const single = ordered.length === 1 ? ordered[0] : undefined
    let consumed = false
    const entries: Intent[] = []
    for (const originalIntent of this.files.get(fileId) ?? []) {
      const intent = { ...originalIntent }
      if (!matchesSource(before, intent)) continue

      // Keep the original whole word while successive edits evolve its replacement.
      if (manual && single && single.rangeOffset >= intent.start && single.rangeOffset + single.rangeLength <= intent.end) {
        const next = intent.target.slice(0, single.rangeOffset - intent.start) + single.text + intent.target.slice(single.rangeOffset + single.rangeLength - intent.start)
        if (!next || isWord(next)) {
          consumed = true
          intent.target = next
          intent.end += single.text.length - single.rangeLength
          intent.at = at
          if (intent.target !== intent.original) entries.push(intent)
          continue
        }
        if (!intent.target) continue
      }

      let shift = 0
      let touched = false
      for (const change of ordered) {
        const end = change.rangeOffset + change.rangeLength
        // Boundary insertions that are not part of the replacement are ordinary surrounding edits.
        if (end <= intent.start) shift += change.text.length - change.rangeLength
        else if (change.rangeOffset < intent.end || (intent.start === intent.end && change.rangeOffset === intent.start)) touched = true
      }
      // AI acceptance elsewhere preserves the intention; changing its source invalidates it.
      if (touched) continue
      intent.start += shift
      intent.end += shift
      if (matchesSource(after, intent)) entries.push(intent)
    }

    if (manual && single && !consumed && (origin !== 'paste' || single.rangeLength > 0)) {
      const source = wordAt(before, single.rangeOffset)
      if (source && single.rangeOffset >= source.start && single.rangeOffset + single.rangeLength <= source.end) {
        const end = source.end + single.text.length - single.rangeLength
        const target = after.slice(source.start, end)
        if ((!target || isWord(target)) && target !== source.text) {
          entries.push({ original: source.text, target, start: source.start, end, at })
        }
      }
    }
    // The latest edit of an original word supersedes its older replacement, including an empty pending edit.
    const unique = entries.filter((entry, index) => !entries.slice(index + 1).some(later => later.original === entry.original)).slice(-MAX_INTENTS)
    this.files.delete(fileId)
    if (unique.length) this.files.set(fileId, unique)
    while (this.files.size > MAX_FILES) this.files.delete(this.files.keys().next().value!)
  }

  suggest(fileId: string, text: string, offset: number, selection?: { start: number; end: number }, at = Date.now()): RepeatedWordSuggestion | undefined {
    this.expire(at)
    const word = wordAt(text, offset)
    if (!word) return undefined
    if (selection && (!Number.isInteger(selection.start) || !Number.isInteger(selection.end) || selection.start < 0 || selection.end < selection.start || selection.end > text.length)) return undefined
    if (selection && selection.start !== selection.end && (selection.start !== word.start || selection.end !== word.end)) return undefined
    const entries = (this.files.get(fileId) ?? []).filter(intent => matchesSource(text, intent))
    if (!entries.length) { this.files.delete(fileId); return undefined }
    this.files.set(fileId, entries)
    for (let index = entries.length - 1; index >= 0; index--) {
      const intent = entries[index]!
      if (intent.original !== word.text || !intent.target || intent.target === word.text) continue
      return { rangeOffset: word.start, rangeLength: word.end - word.start, expectedText: word.text, newText: intent.target }
    }
    return undefined
  }

  clear(): void { this.files.clear() }

  forget(fileId: string): void { this.files.delete(fileId) }

  private expire(at: number): void {
    for (const [fileId, entries] of this.files) {
      const recent = entries.filter(entry => at >= entry.at && at - entry.at <= MAX_AGE_MS)
      if (recent.length) this.files.set(fileId, recent)
      else this.files.delete(fileId)
    }
  }
}
