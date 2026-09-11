
export type CompletionTrigger = 'automatic' | 'invoke'

/** A default IntelliSense item is not intent; only show a prediction that really extends it. */
export function extendSelectedCompletion(
  text: string,
  alreadyTyped: string,
  selectedText: string
): string {
  if (!selectedText.startsWith(alreadyTyped)) return ''
  const insertion = text.startsWith(selectedText) ? text : alreadyTyped + text
  return insertion.startsWith(selectedText) && insertion.length > selectedText.length ? insertion : ''
}

export function shouldRequestInlineCompletion(
  prefix: string,
  suffix: string,
  trigger: CompletionTrigger
): boolean {
  if (trigger === 'invoke') return true
  if (prefix.trim().length === 0) return false
  const line = prefix.slice(prefix.lastIndexOf('\n') + 1)
  if (/^\s*[\w$]$/.test(line)) return false
  // A finished statement or closing delimiter is a poor place to append more code.
  // Pressing Enter opens a new opportunity, including below an intent comment.
  const openParentheses = (line.match(/\(/g)?.length ?? 0) - (line.match(/\)/g)?.length ?? 0)
  if (/^\s*[\]});,]+\s*$/.test(line) ||
    (openParentheses <= 0 && /[;}][ \t]*$/.test(line))) return false
  // Avoid inserting into an existing identifier. Explicit invocation is still available.
  if (/[\w$]$/.test(line) && /^[\w$]/.test(suffix)) return false
  return true
}

export function completionDebounceMs(prefix: string, baseMs: number): number {
  const line = prefix.slice(prefix.lastIndexOf('\n') + 1)
  return line.trim().length === 0 ? baseMs + 150 : baseMs
}

/** Small, bounded editor history: navigation, deletion, paste and undo are not typing intent. */
export class InlineCompletionTriggerTracker {
  private readonly documents = new Map<string, { version: number; offset?: number; suppress: boolean }>()

  changed(key: string, version: number, suppress: boolean): void {
    this.documents.delete(key)
    this.documents.set(key, { version, suppress })
    if (this.documents.size > 100) this.documents.delete(this.documents.keys().next().value!)
  }

  allow(key: string, version: number, offset: number, trigger: CompletionTrigger): boolean {
    const previous = this.documents.get(key)
    if (trigger === 'automatic' && previous?.version === version) {
      if (previous.suppress || (previous.offset != null && previous.offset !== offset)) return false
    }
    this.changed(key, version, previous?.version === version ? previous.suppress : false)
    this.documents.get(key)!.offset = offset
    return true
  }

  close(key: string): void {
    this.documents.delete(key)
  }
}

function unmatchedClosingPositions(text: string): Set<number> {
  const unmatched = new Set<number>()
  const stack: string[] = []
  const pairs: Record<string, string> = { ')': '(', ']': '[', '}': '{' }
  // Ignore literal/comment contents when checking which brackets belong to generated code.
  const masked = text.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
    value => ' '.repeat(value.length))
  for (let index = 0; index < masked.length; index += 1) {
    const character = masked[index]!
    if ('([{'.includes(character)) stack.push(character)
    else if (pairs[character]) {
      if (stack.at(-1) === pairs[character]) stack.pop()
      else unmatched.add(index)
    }
  }
  return unmatched
}

function trimSuffixOverlap(text: string, suffix: string): string {
  const unmatched = unmatchedClosingPositions(text)
  for (let length = Math.min(text.length, suffix.length); length > 0; length -= 1) {
    const overlap = suffix.slice(0, length)
    if (!text.endsWith(overlap) || !overlap.trim()) continue
    const splitsIdentifier = /[\w$]/.test(overlap.at(-1) ?? '') && /^[\w$]/.test(suffix.slice(length))
    // A closing bracket in a generated nested call belongs to that call, even when
    // the outer call already has the same bracket after the caret.
    const closesGeneratedCode = overlap.split('').some((character, index) =>
      ')]}'.includes(character) && !unmatched.has(text.length - length + index))
    if (!splitsIdentifier && !closesGeneratedCode &&
      (length >= 3 || /^[\s\])};,]+$/.test(overlap))) return text.slice(0, -length)
  }
  return text
}

/** Return only new code. Keep indentation and valid short expression completions intact. */
export function prepareInlineCompletion(input: {
  raw: string
  prefix: string
  suffix: string
  trigger: CompletionTrigger
}): string {
  const prefix = input.prefix.replace(/\r\n/g, '\n')
  const suffix = input.suffix.replace(/\r\n/g, '\n')
  let text = sanitizeInlineCompletionOutput(input.raw).replace(/\r\n/g, '\n')
  text = text.split(/<｜fim▁(?:begin|hole|end)｜>|<\|(?:fim_prefix|fim_suffix|fim_middle|endoftext|im_end)\|>/)[0] ?? ''
  if (!text.trim() || /^\s*(?:Here(?: is|'s)|Sure[,!]|The following|以下是|这是)[ \t\S]/i.test(text)) return ''

  const line = prefix.slice(prefix.lastIndexOf('\n') + 1)
  if (prefix.length >= 3 && text.startsWith(prefix)) {
    text = text.slice(prefix.length)
  } else if (line.trim().length >= 3 && text.startsWith(line)) {
    text = text.slice(line.length)
  } else if (line.trim().length >= 3 && text.startsWith(line.trimStart())) {
    text = text.slice(line.trimStart().length)
  } else {
    // Models sometimes echo a partially typed identifier (std::ve + vector).
    // Strip it once, before resolving imports or constructing an accept edit.
    const partial = /[A-Za-z_$][\w$]*$/.exec(line)?.[0]
    if (partial && text.startsWith(partial) && /[\w$]/.test(text.charAt(partial.length))) text = text.slice(partial.length)
  }
  if (text.trim().length >= 3 && suffix.startsWith(text)) return ''
  text = trimSuffixOverlap(text, suffix)
  if (!text.trim()) return ''
  const nonEmptyLines = text.trim().split('\n').filter(value => value.trim())
  if (nonEmptyLines.length === 1 && text.trim() === suffix.trimStart().split('\n')[0]?.trim()) return ''

  if (input.trigger === 'automatic') {
    if (/^[\s\p{P}\p{S}]+$/u.test(text)) return ''
    if (!line.trim()) {
      const lines = text.trim().split('\n').map(value => value.trim())
      const previous = prefix.trimEnd().split('\n').slice(-lines.length).map(value => value.trim())
      if (text.trim().length >= 8 && lines.join('\n') === previous.join('\n')) return ''
    }
  }
  return input.prefix.includes('\r\n') || input.suffix.includes('\r\n')
    ? text.replace(/\n/g, '\r\n')
    : text
}

function sanitizeInlineCompletionOutput(raw: string): string {
  const openingFence = /^[ \t]*```[\w-]*\r?\n/.exec(raw)
  if (openingFence == null) {
    return raw
  }
  const text = raw.slice(openingFence[0].length)
  const closingFence = /\r?\n```[ \t]*(?:\r?\n)?$/.exec(text)
  if (closingFence?.index != null) {
    return text.slice(0, closingFence.index)
  }
  return text
}
