import type * as vscode from 'vscode'
import { contentHash, isCompletionSource, type RecentEditStore } from './completionState'
import type { CandidateDocument, CodeWindow, DiagnosticContext, SuggestionRequest, Range } from './suggestionProtocol'

export type SnapshotDependency = { uri: vscode.Uri; text: string; version?: number }
export type EditorSnapshot = {
  request: SuggestionRequest; document: vscode.TextDocument; text: string; version: number
  offset: number; dependencies: SnapshotDependency[]; createdAt: number
}
export type SuggestionContextBudget = {
  beforeCharacters: number
  afterCharacters: number
  relatedCharacters: number
  relatedDocuments: number
  completionWindows: number
}
export function suggestionContextBudget(mode: SuggestionRequest['mode']): SuggestionContextBudget {
  if (mode === 'next-edit') return { beforeCharacters: 4000, afterCharacters: 1500, relatedCharacters: 4096, relatedDocuments: 3, completionWindows: 6 }
  if (mode === 'alternatives') return { beforeCharacters: 6000, afterCharacters: 2000, relatedCharacters: 4096, relatedDocuments: 3, completionWindows: 1 }
  return { beforeCharacters: 5000, afterCharacters: 1500, relatedCharacters: 3072, relatedDocuments: 2, completionWindows: 1 }
}
function bounded<T>(promise: Thenable<T>, timeout: number, fallback: T): Promise<T> {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(fallback), timeout)
    void Promise.resolve(promise).then(value => { clearTimeout(timer); resolve(value) }, () => { clearTimeout(timer); resolve(fallback) })
  })
}
export const toRange = (range: vscode.Range): Range => ({ start: { line: range.start.line, character: range.start.character }, end: { line: range.end.line, character: range.end.character } })
const wirePoint = (point: vscode.Position) => ({ line: point.line, character: point.character })
export class SuggestionContextResolver {
  constructor(private readonly api: typeof vscode, private readonly session: string, private readonly history: RecentEditStore, private readonly version: string) {}
  async collect(document: vscode.TextDocument, position: vscode.Position, mode: SuggestionRequest['mode'], trigger: SuggestionRequest['trigger'], extendedRange: boolean, allowImports = false): Promise<EditorSnapshot> {
    const api = this.api; const text = document.getText(); const version = document.version
    const budget = suggestionContextBudget(mode)
    const root = api.workspace.getWorkspaceFolder(document.uri)
    if (!root || !isCompletionSource(document.uri.path) || text.length > 300_000) throw new Error('Unsupported completion source')
    const fileId = `f-${contentHash(document.uri.toString())}`
    const snapshotId = `${version}-${contentHash(text)}`; const offset = document.offsetAt(position)
    const windows: CodeWindow[] = []
    const makeWindow = (from: number, to: number, purpose: CodeWindow['purpose']) => {
      if (to < from) return
      const start = document.positionAt(from); const end = document.positionAt(to)
      const content = text.slice(document.offsetAt(start), document.offsetAt(end))
      if (content.length > 16_384) return
      if (windows.some(w => w.purpose === purpose && w.range.start.line === start.line && w.range.start.character === start.character && w.range.end.line === end.line && w.range.end.character === end.character)) return
      windows.push({ windowId: `w-${windows.length}`, range: { start: wirePoint(start), end: wirePoint(end) }, text: content, purpose })
    }
    const lineWindow = (line: number, around = 0) => {
      const start = Math.max(0, line - around); const end = Math.min(document.lineCount, line + around + 1)
      const from = document.offsetAt(new api.Position(start, 0))
      const to = end === document.lineCount ? text.length : document.offsetAt(new api.Position(end, 0))
      if (to - from <= 4096) makeWindow(from, to, 'completion')
    }
    if (mode === 'next-edit') lineWindow(position.line, 2)
    else makeWindow(offset, offset, 'completion')
    // Context windows retain true document coordinates; only completion windows are writable.
    const beforeStart = Math.max(0, offset - budget.beforeCharacters)
    makeWindow(document.offsetAt(new api.Position(document.positionAt(beforeStart).line + (beforeStart > 0 ? 1 : 0), 0)), offset, 'context')
    const afterEnd = Math.min(text.length, offset + budget.afterCharacters)
    makeWindow(offset, afterEnd === text.length ? afterEnd : document.offsetAt(new api.Position(document.positionAt(afterEnd).line, 0)), 'context')
    const recentEdits = this.history.read().filter(edit => edit.fileId === fileId)
    const diagnostics: DiagnosticContext[] = api.languages.getDiagnostics(document.uri)
      .filter(diag => diag.severity <= api.DiagnosticSeverity.Warning).slice(0, 20).map(diag => ({
        fileId, snapshotId, range: toRange(diag.range), message: diag.message.slice(0, 2048), severity: diag.severity === api.DiagnosticSeverity.Error ? 'error' : 'warning',
        ...(diag.code == null ? {} : { code: String(typeof diag.code === 'object' ? diag.code.value : diag.code).slice(0, 128) }), freshness: 'observed-current',
      }))
    if (mode === 'next-edit') {
      for (const diag of diagnostics) { if (windows.filter(w => w.purpose === 'completion').length >= Math.min(3, budget.completionWindows)) break; lineWindow(diag.range.start.line, 1) }
      if (extendedRange) {
        const refs = await bounded(api.commands.executeCommand<vscode.Location[]>('vscode.executeReferenceProvider', document.uri, position), 180, [])
        for (const ref of refs ?? []) {
          if (windows.filter(w => w.purpose === 'completion').length >= Math.min(5, budget.completionWindows)) break
          if (ref.uri.toString() === document.uri.toString()) lineWindow(ref.range.start.line)
        }
        // Lexical matches are location candidates, never a semantic rename operation.
        const words = new Set(recentEdits.slice(-4).flatMap(edit => `${edit.before} ${edit.after}`.match(/[A-Za-z_]\w{2,}/g) ?? []))
        for (const match of text.matchAll(/[A-Za-z_]\w{2,}/g)) {
          if (windows.filter(w => w.purpose === 'completion').length >= budget.completionWindows) break
          if (words.has(match[0]) && Math.abs(match.index - offset) > 200) lineWindow(document.positionAt(match.index).line)
        }
      }
    }
    const documents: CandidateDocument[] = [{ fileId, snapshotId, relativePath: api.workspace.asRelativePath(document.uri, false).replace(/\\/g, '/'), languageId: document.languageId, version, permission: 'edit', windows: windows.slice(0, 10) }]
    const dependencies: SnapshotDependency[] = [{ uri: document.uri, text, version }]
    const related = new Map<string, vscode.Uri>()
    const definitions = await bounded(api.commands.executeCommand<Array<vscode.Location | vscode.LocationLink>>('vscode.executeDefinitionProvider', document.uri, position), 180, [])
    for (const definition of definitions ?? []) {
      const uri = 'targetUri' in definition ? definition.targetUri : definition.uri
      related.set(uri.toString(), uri)
    }
    for (const match of text.matchAll(/#\s*include\s*"([^"\r\n]+)"|\bfrom\s*['"](\.[^'"\r\n]+)['"]/g)) {
      const relative = match[1] ?? match[2]
      if (relative && !relative.split('/').includes('..')) {
        const base = document.uri.with({ path: document.uri.path.slice(0, document.uri.path.lastIndexOf('/') + 1) + relative })
        related.set(base.toString(), base)
        if (!/\.[a-z]+$/i.test(relative)) for (const extension of ['.ts', '.js']) related.set(base.toString() + extension, base.with({ path: base.path + extension }))
      }
    }
    for (const other of api.workspace.textDocuments.slice(-20).reverse()) {
      if (other !== document && text.includes(other.uri.path.split('/').at(-1)!)) related.set(other.uri.toString(), other.uri)
    }
    let contextBytes = 0
    for (const uri of [...related.values()].slice(0, budget.relatedDocuments * 2)) {
      if (documents.length >= budget.relatedDocuments + 1 || contextBytes >= budget.relatedCharacters) break
      if (uri.toString() === document.uri.toString() || uri.scheme !== 'file' || api.workspace.getWorkspaceFolder(uri)?.uri.toString() !== root.uri.toString()) continue
      // LSP-resolved installed headers may be read as declarations, never edited.
      if (!isCompletionSource(uri.path) && !(uri.path.includes('/sketch/libraries/') && /\.(h|hpp)$/.test(uri.path))) continue
      const open = api.workspace.textDocuments.find(item => item.uri.toString() === uri.toString())
      const content = open?.getText() ?? await bounded(api.workspace.fs.readFile(uri).then(bytes => new TextDecoder().decode(bytes)), 150, '')
      if (!content || content.length > 300_000 || content.includes('\0')) continue
      let snippet = content.slice(0, Math.min(2000, budget.relatedCharacters - contextBytes))
      if (snippet.length < content.length) snippet = snippet.slice(0, Math.max(0, snippet.lastIndexOf('\n') + 1))
      if (!snippet) continue
      const lines = snippet.split('\n'); const id = `f-${contentHash(uri.toString())}`
      documents.push({ fileId: id, snapshotId: `${open?.version ?? 0}-${contentHash(content)}`, relativePath: api.workspace.asRelativePath(uri, false).replace(/\\/g, '/'), languageId: open?.languageId ?? document.languageId,
        version: open?.version ?? 0, permission: 'context-only', windows: [{ windowId: `ctx-${documents.length}`, text: snippet, purpose: 'context', range: { start: { line: 0, character: 0 }, end: { line: lines.length - 1, character: lines.at(-1)!.length } } }] })
      dependencies.push({ uri, text: content, ...(open ? { version: open.version } : {}) }); contextBytes += snippet.length
    }
    if (allowImports && mode === 'next-edit' && diagnostics.length) {
      const diag = diagnostics[0]!
      const range = new api.Range(diag.range.start.line, diag.range.start.character, diag.range.end.line, diag.range.end.character)
      const actions = await bounded(api.commands.executeCommand<Array<vscode.CodeAction | vscode.Command>>('vscode.executeCodeActionProvider', document.uri, range, 'quickfix', 8), 250, [])
      const choices = new Map<string, Array<vscode.TextEdit>>()
      for (const action of actions ?? []) {
        if (!('edit' in action) || !action.edit || action.command || action.disabled) continue
        // The pinned Monaco API exposes the full edit list; entries() hides resource/snippet edits.
        const full = action.edit as vscode.WorkspaceEdit & { _allEntries?: () => Array<{ _type: number }> }
        if (!full._allEntries || full._allEntries().some(entry => entry._type !== 2)) continue
        const entries = action.edit.entries()
        if (entries.length !== 1 || entries[0]![0].toString() !== document.uri.toString()) continue
        const edits = entries[0]![1]
        if (edits.length < 1 || edits.length > 2) continue
        // Only language-service supplied imports; do not execute command/resource actions.
        if (!edits.every(edit => /^(?:\s*(?:#\s*include\s*[<"][^>"\r\n]+[>"]|import\s+[^\r\n]+)\s*)+$/.test(edit.newText) &&
          (document.getText(edit.range).trim() === '' || /^(?:\s*(?:#\s*include|import)\b[^\r\n]*\s*)+$/.test(document.getText(edit.range))) &&
          !text.includes(edit.newText.trim()))) continue
        choices.set(JSON.stringify(edits.map(edit => [toRange(edit.range), edit.newText])), edits)
      }
      // Multiple possible headers/sources are ambiguous: do not choose on the model's behalf.
      if (choices.size === 1 && document.version === version && document.getText() === text) {
        const edits = [...choices.values()][0]!
        const active = documents[0]!
        active.windows = active.windows.slice(0, 10 - edits.length)
        for (const [index, edit] of edits.entries()) active.windows.push({ windowId: `import-${index}`, range: toRange(edit.range),
          text: document.getText(edit.range), purpose: 'import', allowedNewText: [edit.newText] })
      }
    }
    const id = crypto.randomUUID()
    return { document, text, version, offset, createdAt: Date.now(), dependencies, request: {
      protocolVersion: 2, requestId: id, opportunityId: id, workspaceSessionId: `${this.session}-${contentHash(root.uri.toString())}`,
      client: { name: 'aily-coder-editor', version: this.version, sessionId: this.session }, mode, trigger,
      active: { fileId, snapshotId, position: wirePoint(position) }, documents, recentEdits, diagnostics,
      options: { crossFile: false, autoImports: documents[0]!.windows.some(window => window.purpose === 'import'), partialInsertAccept: true, maxCandidates: mode === 'alternatives' ? 3 : 1 },
    } }
  }
  async staleReason(snapshot: EditorSnapshot): Promise<'active-content' | 'context-content' | 'context-closed' | undefined> {
    for (const dependency of snapshot.dependencies) {
      // A preview document can temporarily disappear from workspace.textDocuments
      // while the candidate webview has focus. Validate the retained active
      // TextDocument directly below instead of treating it as a closed dependency.
      if (dependency.uri.toString() === snapshot.document.uri.toString()) continue
      const open = this.api.workspace.textDocuments.find(doc => doc.uri.toString() === dependency.uri.toString())
      if (open) { if (open.getText() !== dependency.text) return 'context-content' }
      else {
        if (dependency.version != null) return 'context-closed'
        const text = await bounded(this.api.workspace.fs.readFile(dependency.uri).then(bytes => new TextDecoder().decode(bytes)), 150, '')
        if (text !== dependency.text) return 'context-content'
      }
    }
    // Embedded Monaco may advance TextDocument.version without changing bytes.
    // Content equality is the useful concurrency boundary; applySuggestion also
    // checks the Monaco model and every target range synchronously.
    return snapshot.document.getText() === snapshot.text ? undefined : 'active-content'
  }
  async isCurrent(snapshot: EditorSnapshot): Promise<boolean> {
    return await this.staleReason(snapshot) === undefined
  }
}
