import type * as vscode from 'vscode'
import { contentHash, isCompletionSource, type RecentEditStore } from './completionState'
import type { CandidateDocument, CodeWindow, DiagnosticContext, SuggestionRequest, Range, Suggestion, TextEdit } from './suggestionProtocol'
import type { ImportBinding } from './partialImportAcceptance'
import { relatedSourcePaths } from './relatedSourcePaths'

export type SnapshotDependency = { uri: vscode.Uri; text: string; version?: number; read?: () => Promise<string | undefined> }
export type EditorSnapshot = {
  request: SuggestionRequest; document: vscode.TextDocument; text: string; version: number
  offset: number; dependencies: SnapshotDependency[]; createdAt: number
  contextGeneration?: number
  diagnosticGenerations?: Array<{ uri: string; generation: number }>
  importChoices?: Array<{ symbol: string; label: string; edits: TextEdit[] }>
  importBindings?: ImportBinding[]
}
export type SuggestionContextBudget = {
  beforeCharacters: number
  afterCharacters: number
  relatedCharacters: number
  relatedDocuments: number
  completionWindows: number
}
export function suggestionContextBudget(mode: SuggestionRequest['mode']): SuggestionContextBudget {
  if (mode === 'next-edit') return { beforeCharacters: 4000, afterCharacters: 1500, relatedCharacters: 12_000, relatedDocuments: 5, completionWindows: 6 }
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
  private paths?: { root: string; at: number; values: vscode.Uri[] }
  private pathScan?: { root: string; generation: number; promise: Promise<void> }
  private languageQueries = new Map<string, Promise<unknown>>()
  private generation = 0
  private dirtyDiagnostics = new Set<string>()
  private diagnosticGenerations = new Map<string, number>()
  invalidate(): void { this.paths = undefined; this.languageQueries.clear(); this.generation++ }
  documentChanged(uri: vscode.Uri): void { this.languageQueries.clear(); this.dirtyDiagnostics.add(uri.toString()) }
  diagnosticsObserved(uri: vscode.Uri): void { const key = uri.toString(); this.dirtyDiagnostics.delete(key); this.diagnosticGenerations.set(key, (this.diagnosticGenerations.get(key) ?? 0) + 1) }
  constructor(private readonly api: typeof vscode, private readonly session: string, private readonly history: RecentEditStore, private readonly version: string,
    private readonly readDeclaration?: (path: string) => Promise<{ text: string; relativePath: string; snapshotId: string } | undefined>,
    private readonly canEditRelated?: (uri: vscode.Uri, languageId: string) => boolean,
    private readonly diagnosticsAvailable: (document: vscode.TextDocument) => boolean = () => true) {}
  async collect(document: vscode.TextDocument, position: vscode.Position, mode: SuggestionRequest['mode'], trigger: SuggestionRequest['trigger'], extendedRange: boolean, allowImports = false, crossFile = false): Promise<EditorSnapshot> {
    const discoveryDeadline = Date.now() + 150
    const discoveryTimeLeft = () => Math.max(0, discoveryDeadline - Date.now())
    const api = this.api; const text = document.getText(); const version = document.version
    const generation = this.generation
    const diagnosticGeneration = this.diagnosticGenerations.get(document.uri.toString()) ?? 0
    crossFile = crossFile && mode === 'next-edit'
    const budget = suggestionContextBudget(mode)
    const root = api.workspace.getWorkspaceFolder(document.uri)
    if (!root || !isCompletionSource(document.uri.path) || text.length > 300_000) throw new Error('Unsupported completion source')
    const query = <T>(command: string): Promise<T[]> => {
      const key = `${document.uri}:${version}:${position.line}:${position.character}:${command}`
      let pending = this.languageQueries.get(key)
      if (!pending) {
        pending = Promise.resolve(api.commands.executeCommand<T[]>(command, document.uri, position)).catch(() => [])
        this.languageQueries.set(key, pending)
        if (this.languageQueries.size > 32) this.languageQueries.delete(this.languageQueries.keys().next().value!)
      }
      return pending as Promise<T[]>
    }
    // Start discovery together. Slow results remain cached for the next real
    // opportunity; they never trigger a model call on their own.
    const definitionQuery = query<vscode.Location | vscode.LocationLink>('vscode.executeDefinitionProvider')
    const referenceQuery = mode === 'next-edit' && extendedRange ? query<vscode.Location>('vscode.executeReferenceProvider') : Promise.resolve([])
    const rootKey = root.uri.toString()
    if (crossFile && typeof api.workspace.findFiles === 'function' && (!this.paths || this.paths.root !== rootKey || Date.now() - this.paths.at > 30_000)) {
      if (this.pathScan?.root !== rootKey || this.pathScan.generation !== generation) {
        const promise: Promise<void> = Promise.resolve(api.workspace.findFiles('**/*.{h,hpp,c,cc,cpp,cxx,ino,ts,tsx,js,jsx,py}', '**/{node_modules,libraries,vendor,build,dist,.git,.pio}/**', 256))
          .then(paths => { if (generation === this.generation) this.paths = { root: rootKey, at: Date.now(), values: paths } }, () => {})
          .finally(() => { if (this.pathScan?.promise === promise) this.pathScan = undefined })
        this.pathScan = { root: rootKey, generation, promise }
      }
    }
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
    // A compact function-sized window lets the model group a local rename or
    // coherent rewrite into the single edit that Aily Tab presents. Distant
    // references remain separate windows and retain the jump-before-apply flow.
    if (mode === 'next-edit') lineWindow(position.line, 8)
    else makeWindow(offset, offset, 'completion')
    // Context windows retain true document coordinates; only completion windows are writable.
    const beforeStart = Math.max(0, offset - budget.beforeCharacters)
    makeWindow(document.offsetAt(new api.Position(document.positionAt(beforeStart).line + (beforeStart > 0 ? 1 : 0), 0)), offset, 'context')
    const afterEnd = Math.min(text.length, offset + budget.afterCharacters)
    makeWindow(offset, afterEnd === text.length ? afterEnd : document.offsetAt(new api.Position(document.positionAt(afterEnd).line, 0)), 'context')
    const history = this.history.read()
    const recentEdits = history.filter(edit => edit.fileId === fileId)
    const related = new Map<string, { uri: vscode.Uri; line?: number; explicit?: boolean }>()
    const diagnostics: DiagnosticContext[] = (this.dirtyDiagnostics.has(document.uri.toString()) || !this.diagnosticsAvailable(document) ? [] : api.languages.getDiagnostics(document.uri))
      .filter(diag => diag.severity <= api.DiagnosticSeverity.Warning).sort((a, b) => a.severity - b.severity).slice(0, 10).map(diag => ({
        fileId, snapshotId, range: toRange(diag.range), message: diag.message.slice(0, 400), severity: diag.severity === api.DiagnosticSeverity.Error ? 'error' : 'warning',
        ...(diag.code == null ? {} : { code: String(typeof diag.code === 'object' ? diag.code.value : diag.code).slice(0, 128) }), freshness: 'observed-current',
      }))
    if (mode === 'next-edit') {
      for (const diag of diagnostics) { if (windows.filter(w => w.purpose === 'completion').length >= Math.min(3, budget.completionWindows)) break; lineWindow(diag.range.start.line, 1) }
      if (extendedRange) {
        const refs = await bounded(referenceQuery, discoveryTimeLeft(), [])
        for (const ref of refs ?? []) {
          if (ref.uri.toString() !== document.uri.toString()) related.set(ref.uri.toString(), { uri: ref.uri, line: ref.range.start.line })
          else if (windows.filter(w => w.purpose === 'completion').length < Math.min(5, budget.completionWindows)) lineWindow(ref.range.start.line)
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
    const definitions = await bounded(definitionQuery, discoveryTimeLeft(), [])
    for (const definition of definitions ?? []) {
      const uri = 'targetUri' in definition ? definition.targetUri : definition.uri
      related.set(uri.toString(), { uri, line: ('targetRange' in definition ? definition.targetRange : definition.range).start.line })
    }
    for (const path of relatedSourcePaths(document.uri.path, text)) {
      const uri = document.uri.with({ path })
      related.set(uri.toString(), { uri, explicit: true })
    }
    for (const other of api.workspace.textDocuments.slice(-20).reverse()) {
      if (other !== document && (text.includes(other.uri.path.split('/').at(-1)!) || history.some(edit => edit.fileId === `f-${contentHash(other.uri.toString())}`))) related.set(other.uri.toString(), { uri: other.uri })
    }
    if (crossFile) {
      const stem = document.uri.path.replace(/\.[^/.]+$/, '')
      for (const extension of /\.(?:h|hpp|c|cc|cpp|cxx|ino)$/i.test(document.uri.path) ? ['.h', '.hpp', '.cpp', '.cc', '.c'] : []) {
        const uri = document.uri.with({ path: stem + extension })
        if (!related.has(uri.toString())) related.set(uri.toString(), { uri })
      }
    }
    if (crossFile && typeof api.workspace.findFiles === 'function') {
      if (this.pathScan?.root === rootKey) await bounded(this.pathScan.promise, discoveryTimeLeft(), undefined)
      const stem = document.uri.path.replace(/\.[^/.]+$/, '')
      const directory = stem.slice(0, stem.lastIndexOf('/') + 1)
      const score = (uri: vscode.Uri) => uri.path.replace(/\.[^/.]+$/, '') === stem ? 0 : uri.path.startsWith(directory) ? 1 : 2
      for (const uri of [...(this.paths?.values ?? [])].sort((a, b) => score(a) - score(b))) {
        if (uri.toString() !== document.uri.toString() && !related.has(uri.toString())) related.set(uri.toString(), { uri })
      }
    }
    let contextBytes = 0
    const words = new Set(history.slice(-6).flatMap(edit => `${edit.before} ${edit.after}`.match(/[A-Za-z_]\w{2,}/g) ?? []).filter(word => !['int', 'void', 'const', 'return', 'auto', 'float', 'double', 'include'].includes(word)))
    const candidates = [...related.values()].filter(({ uri }) => uri.toString() !== document.uri.toString() && uri.scheme === 'file' && api.workspace.getWorkspaceFolder(uri)?.uri.toString() === root.uri.toString() &&
      (isCompletionSource(uri.path) || (uri.path.includes('/sketch/libraries/') && /\.(h|hpp)$/.test(uri.path)))).slice(0, 8)
    const contents: Array<{ uri: vscode.Uri; line?: number; explicit?: boolean; open?: vscode.TextDocument; content: string }> = []
    for (let index = 0; index < candidates.length; index += 2) {
      contents.push(...await Promise.all(candidates.slice(index, index + 2).map(async candidate => {
        const open = api.workspace.textDocuments.find(item => item.uri.toString() === candidate.uri.toString())
        const content = open?.getText() ?? await bounded(api.workspace.fs.readFile(candidate.uri).then(bytes => new TextDecoder().decode(bytes)), 150, '')
        return { ...candidate, open, content: content ?? '' }
      })))
    }
    for (const { uri, line, explicit, open, content } of contents) {
      if (documents.length >= budget.relatedDocuments + 1 || contextBytes >= budget.relatedCharacters) break
      if (!content || content.length > 300_000 || content.includes('\0')) continue
      const sourceLines = content.match(/[^\n]*\n|[^\n]+$/g) ?? []
      const relatedWindows: CodeWindow[] = []
      const anchor = line ?? sourceLines.findIndex(value => [...words].some(word => new RegExp(`\\b${word}\\b`).test(value)))
      const linked = explicit || line != null || anchor >= 0 || text.includes(uri.path.split('/').at(-1)!) || content.includes(document.uri.path.split('/').at(-1)!) || uri.path.replace(/\.[^/.]+$/, '') === document.uri.path.replace(/\.[^/.]+$/, '')
      if (crossFile && !linked) continue
      const writable = crossFile && isCompletionSource(uri.path) && (this.canEditRelated?.(uri, open?.languageId ?? document.languageId) ?? true)
      const starts = writable ? [...new Set([Math.max(0, anchor - 1), 0])] : [Math.max(0, (line ?? 0) - 1)]
      for (const start of starts) {
        let snippet = ''
        for (const value of sourceLines.slice(start, start + (writable ? 5 : 60))) {
          if (snippet.length + value.length > Math.min(2000, budget.relatedCharacters - contextBytes)) break
          snippet += value
        }
        if (!snippet) continue
        const lines = snippet.split('\n')
        relatedWindows.push({ windowId: `related-${documents.length}-${relatedWindows.length}`, text: snippet, purpose: writable ? 'completion' : 'context',
          range: { start: { line: start, character: 0 }, end: { line: start + lines.length - 1, character: lines.at(-1)!.length } } })
        contextBytes += snippet.length
      }
      if (!relatedWindows.length) continue
      const id = `f-${contentHash(uri.toString())}`
      documents.push({ fileId: id, snapshotId: `${open?.version ?? 0}-${contentHash(content)}`, relativePath: api.workspace.asRelativePath(uri, false).replace(/\\/g, '/'), languageId: open?.languageId ?? document.languageId,
        version: open?.version ?? 0, permission: writable ? 'edit' : 'context-only', windows: relatedWindows })
      dependencies.push({ uri, text: content, ...(open ? { version: open.version } : {}) })
    }
    // External SDK declarations only pass through the host's installed-root reader.
    if (this.readDeclaration && documents.length < 7 && contextBytes < budget.relatedCharacters) {
      const external = [...related.values()].filter(({ uri }) => uri.scheme === 'file' && api.workspace.getWorkspaceFolder(uri)?.uri.toString() !== root.uri.toString()).slice(0, 2)
      for (const { uri, line } of external) {
        const declaration = await this.readDeclaration(uri.fsPath)
        if (!declaration) continue
        const lines = declaration.text.split('\n'); const start = Math.max(0, (line ?? 0) - 2)
        let snippet = lines.slice(start, start + 30).join('\n').slice(0, Math.min(2000, budget.relatedCharacters - contextBytes))
        if (snippet.endsWith('\r')) snippet = snippet.slice(0, -1)
        if (!snippet) continue
        const parts = snippet.split('\n')
        documents.push({ fileId: `sdk-${contentHash(uri.toString())}`, snapshotId: declaration.snapshotId,
          relativePath: declaration.relativePath, languageId: document.languageId, version: 0, permission: 'context-only',
          windows: [{ windowId: `sdk-${documents.length}`, purpose: 'context', text: snippet,
            range: { start: { line: start, character: 0 }, end: { line: start + parts.length - 1, character: parts.at(-1)!.length } } }] })
        dependencies.push({ uri, text: declaration.text, read: async () => {
          const current = await this.readDeclaration!(uri.fsPath)
          return current?.snapshotId === declaration.snapshotId ? current.text : undefined
        } }); contextBytes += snippet.length
      }
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
      if (!choices.size) {
        // clangd exposes many missing-header fixes as completion additionalTextEdits,
        // not quickfix actions. filterText is the symbol; its UI label may contain • and templates.
        const symbol = document.getText(range)
        if (/^[A-Za-z_]\w*$/.test(symbol)) {
          const list = await bounded(api.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', document.uri, range.end, undefined, 16), 180, undefined)
          for (const item of list?.items ?? []) {
            const name = item.filterText ?? (typeof item.insertText === 'string' ? item.insertText : typeof item.label === 'string' ? item.label : item.label.label)
            const edits = item.additionalTextEdits
            if (name !== symbol || item.command || !edits?.length || edits.length > 2 || !edits.every(edit =>
              /^(?:\s*(?:#\s*include\s*[<"][^>"\r\n]+[>"]|import\s+[^\r\n]+|from\s+[^\r\n]+\s+import\s+[^\r\n]+)\s*)+$/.test(edit.newText) &&
              edit.newText.length <= 4096 && document.getText(edit.range).trim() === '' && !text.includes(edit.newText.trim()))) continue
            choices.set(JSON.stringify(edits.map(edit => [toRange(edit.range), edit.newText])), edits)
          }
        }
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
    if (generation !== this.generation) throw new Error('Completion context changed')
    const id = crypto.randomUUID()
    return { document, text, version, offset, createdAt: Date.now(), contextGeneration: generation,
      diagnosticGenerations: diagnostics.length ? [{ uri: document.uri.toString(), generation: diagnosticGeneration }] : [], dependencies, request: {
      protocolVersion: 2, requestId: id, opportunityId: id, workspaceSessionId: `${this.session}-${contentHash(root.uri.toString())}`,
      client: { name: 'aily-coder-editor', version: this.version, sessionId: this.session }, mode, trigger,
      active: { fileId, snapshotId, position: wirePoint(position) }, documents, recentEdits: history.filter(edit => documents.some(doc => doc.fileId === edit.fileId)), diagnostics,
      options: { crossFile, autoImports: documents[0]!.windows.some(window => window.purpose === 'import'), partialInsertAccept: true, maxCandidates: 1 },
    } }
  }
  /** Resolve proposed symbols without temporarily inserting prediction text into the user's buffer. */
  async withImports(snapshot: EditorSnapshot, candidate: Suggestion): Promise<Suggestion> {
    if (candidate.additionalEdits.length || candidate.fileId !== snapshot.request.active.fileId) return candidate
    const api = this.api
    const position = snapshot.document.positionAt(snapshot.offset)
    const completions = await bounded(api.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', snapshot.document.uri, position, undefined, 16), 180, undefined)
    if (!completions?.items || !await this.isCurrent(snapshot)) return candidate
    const choices = new Map<string, Map<string, vscode.TextEdit[]>>()
    const primaryStart = snapshot.document.offsetAt(new api.Position(candidate.primary.range.start.line, candidate.primary.range.start.character))
    const completedText = (snapshot.text.slice(0, primaryStart).match(/[A-Za-z_]\w*$/)?.[0] ?? '') + candidate.primary.newText
    for (const item of completions.items) {
      const symbol = item.filterText ?? (typeof item.insertText === 'string' ? item.insertText : typeof item.label === 'string' ? item.label : item.label.label)
      if (!/^[A-Za-z_]\w*$/.test(symbol) || !new RegExp(`\\b${symbol}\\b`).test(completedText) || new RegExp(`\\b${symbol}\\b`).test(candidate.primary.expectedText) || item.command || !item.additionalTextEdits?.length || item.additionalTextEdits.length > 2) continue
      const edits = item.additionalTextEdits
      if (!edits.every(edit => /^(?:\s*(?:#\s*include\s*[<"][^>"\r\n]+[>"]|import\s+[^\r\n]+|from\s+[^\r\n]+\s+import\s+[^\r\n]+)\s*)+$/.test(edit.newText) &&
        !snapshot.text.includes(edit.newText.trim()) && !candidate.primary.newText.includes(edit.newText.trim()) && edit.newText.length <= 4096 &&
        (snapshot.document.getText(edit.range).trim() === '' || /^(?:\s*(?:#\s*include|import|from)\b[^\r\n]*\s*)+$/.test(snapshot.document.getText(edit.range))))) continue
      const sources = choices.get(symbol) ?? new Map<string, vscode.TextEdit[]>()
      sources.set(JSON.stringify(edits.map(edit => [toRange(edit.range), edit.newText])), edits); choices.set(symbol, sources)
    }
    // Keep ambiguity local and reviewable; the model never chooses an import source.
    snapshot.importChoices = [...choices].filter(([, sources]) => sources.size > 1).flatMap(([symbol, sources]) => [...sources.values()].map(edits => ({ symbol,
      label: `${symbol} · ${edits.map(edit => edit.newText.trim()).join(' ')}`, edits: edits.map(edit => ({ range: toRange(edit.range), expectedText: snapshot.document.getText(edit.range), newText: edit.newText })) }))).slice(0, 8)
    const edits = [...choices.values()].filter(sources => sources.size === 1).flatMap(sources => [...sources.values()][0]!)
    const unique = [...new Map(edits.map(edit => [JSON.stringify([toRange(edit.range), edit.newText]), edit])).values()]
    if (!unique.length || unique.length > 2) return candidate
    snapshot.importBindings = [...choices].filter(([, sources]) => sources.size === 1).map(([symbol, sources]) => ({ symbol,
      edits: [...sources.values()][0]!.map(edit => ({ range: toRange(edit.range), expectedText: snapshot.document.getText(edit.range), newText: edit.newText })) }))
    return { ...candidate, additionalEdits: unique.map(edit => ({ range: toRange(edit.range), expectedText: snapshot.document.getText(edit.range), newText: edit.newText })) }
  }
  /** Navigation only binds a verified source snapshot; it never widens the wire permissions. */
  async openTarget(snapshot: EditorSnapshot, candidate: Suggestion): Promise<EditorSnapshot | undefined> {
    const ref = snapshot.request.documents.find(doc => doc.fileId === candidate.fileId && doc.snapshotId === candidate.snapshotId && doc.permission === 'edit')
    const dependency = snapshot.dependencies.find(dep => `f-${contentHash(dep.uri.toString())}` === candidate.fileId)
    if (!ref || !dependency || !await this.isCurrent(snapshot)) return undefined
    const document = await this.api.workspace.openTextDocument(dependency.uri)
    if (document.getText() !== dependency.text || !await this.isCurrent(snapshot)) return undefined
    return { ...snapshot, document, text: dependency.text, version: document.version,
      offset: document.offsetAt(new this.api.Position(candidate.primary.range.start.line, candidate.primary.range.start.character)),
      dependencies: snapshot.dependencies.map(dep => dep === dependency ? { ...dep, version: document.version } : dep) }
  }
  async staleReason(snapshot: EditorSnapshot): Promise<'active-content' | 'context-content' | 'context-closed' | undefined> {
    if (snapshot.contextGeneration != null && snapshot.contextGeneration !== this.generation) return 'context-content'
    if (snapshot.diagnosticGenerations?.some(dep => (this.diagnosticGenerations.get(dep.uri) ?? 0) !== dep.generation)) return 'context-content'
    for (const dependency of snapshot.dependencies) {
      if (dependency.read) { if (await dependency.read() !== dependency.text) return 'context-content'; continue }
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
