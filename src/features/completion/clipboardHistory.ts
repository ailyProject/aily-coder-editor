import { isCompletionSource } from './completionState'
import { CLIPBOARD_HISTORY_LIMIT, CLIPBOARD_MAX_AGE_MS, CLIPBOARD_TEXT_LIMIT, CLIPBOARD_TOTAL_LIMIT, type ClipboardContext } from './suggestionProtocol'

type Entry = Omit<ClipboardContext, 'ageMs'> & { workspace: string; at: number }

/** Session memory only. Captured editor code is reference material, never an edit target. */
export class ClipboardHistoryStore {
  private entries: Entry[] = []
  add(workspace: string, relativePath: string, languageId: string, text: string, operation: ClipboardContext['operation'], now = Date.now()): boolean {
    const path = relativePath.replace(/\\/g, '/')
    if (!workspace || !languageId || languageId.length > 64 || path.length > 1024 || /^(?:\/|[a-z]:)/i.test(path) || path.split('/').includes('..') || !isCompletionSource(path) || !text.trim() || text.includes('\0')) return false
    // Retain a bounded excerpt without splitting CRLF or a UTF-16 surrogate pair.
    text = text.slice(0, CLIPBOARD_TEXT_LIMIT)
    if (/[\uD800-\uDBFF\r]$/.test(text)) text = text.slice(0, -1)
    if (!text.trim()) return false
    this.entries = this.entries.filter(item => now - item.at <= CLIPBOARD_MAX_AGE_MS && !(item.workspace === workspace && item.relativePath === path && item.text === text))
    this.entries.push({ workspace, relativePath: path, languageId, text, operation, at: now })
    this.entries = this.entries.slice(-CLIPBOARD_HISTORY_LIMIT)
    while (this.entries.reduce((sum, item) => sum + item.text.length, 0) > CLIPBOARD_TOTAL_LIMIT) this.entries.shift()
    return true
  }
  read(workspace: string, now = Date.now()): ClipboardContext[] {
    this.entries = this.entries.filter(item => now >= item.at && now - item.at <= CLIPBOARD_MAX_AGE_MS)
    return this.entries.filter(item => item.workspace === workspace).slice().reverse()
      .map(({ workspace: _workspace, at, ...item }) => ({ ...item, ageMs: now - at }))
  }
  clear(): void { this.entries = [] }
}
