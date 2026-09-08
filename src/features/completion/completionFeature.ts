import type * as vscode from 'vscode'
import { registerExtension, ExtensionHostKind, type IExtensionManifest } from '@codingame/monaco-vscode-api/extensions'
import metadata from '../../../package.json'
import { ParentSuggestionTransport } from './suggestionTransport'
import { SuggestionContextResolver, type EditorSnapshot } from './suggestionContext'
import { RecentEditStore, contentHash, isCompletionSource, completionCoordinator, abortError } from './completionState'
import { SuggestionError, type Suggestion, type SuggestionResult, type SuggestionCapabilities, type FeedbackEvent, type SuggestionRequest } from './suggestionProtocol'
import { setCompletionRuntime, type CompletionRuntime } from './completionRuntime'
import { EditPresentation, applySuggestion } from './editPresentation'
import { InlineCompletionTriggerTracker, shouldRequestInlineCompletion, prepareInlineCompletion, extendSelectedCompletion, completionDebounceMs } from '../aiInlineCompletionPolicy'
import { resolveProvider } from '../aiInlineCompletion'

const commands = [
  ['aily.completion.settings', 'Aily: 自动补全设置'], ['aily.completion.snooze', 'Aily: 暂停自动补全 5 分钟'], ['aily.completion.resume', 'Aily: 恢复自动补全'],
  ['aily.completion.next', 'Aily: 下一条补全候选'], ['aily.completion.previous', 'Aily: 上一条补全候选'], ['aily.completion.panel', 'Aily: 比较补全候选'],
  ['aily.completion.predict', 'Aily: 预测下一处编辑'], ['aily.completion.acceptEdit', 'Aily: 定位或接受编辑建议'], ['aily.completion.rejectEdit', 'Aily: 拒绝编辑建议'],
  ['aily.completion.acceptLine', 'Aily: 接受下一行补全'], ['aily.completion.reconnect', 'Aily: 重新连接补全服务'],
].map(([command, title]) => ({ command, title }))
const manifest = {
  name: 'code-suggestions-v4', publisher: 'aily', version: metadata.version, engines: { vscode: '*' },
  enabledApiProposals: ['inlineCompletionsAdditions'], contributes: {
    commands,
    configuration: { title: 'Aily 自动补全', properties: {
      'aily.completion.enabled': { type: 'boolean', default: true, description: '启用代码自动补全。' },
      'aily.completion.languages': { type: 'object', default: { '*': true, plaintext: false, markdown: false }, additionalProperties: { type: 'boolean' }, description: '按语言启用补全。' },
      'aily.completion.nextEdit.enabled': { type: 'boolean', default: true, description: '在服务端支持 v4 时预测下一处编辑。' },
      'aily.completion.autoImports': { type: 'boolean', default: true, description: '仅使用语言服务验证且来源唯一的导入建议。' },
      'aily.completion.nextEdit.fixes': { type: 'boolean', default: true, description: '根据语言服务诊断建议修复。' },
      'aily.completion.nextEdit.extendedRange': { type: 'boolean', default: true, description: '预测同文件较远位置的修改。' },
      'aily.completion.nextEdit.showCollapsed': { type: 'boolean', default: false, description: '先显示编辑位置，按 Tab 后展开差异。' },
      'aily.completion.eagerness': { type: 'string', enum: ['less', 'standard', 'more'], default: 'standard', description: '自动建议频率。' },
    } },
    keybindings: [
      { key: 'alt+]', mac: 'alt+]', command: 'aily.completion.next', when: 'editorTextFocus && !inSnippetMode' },
      { key: 'alt+[', mac: 'alt+[', command: 'aily.completion.previous', when: 'editorTextFocus && !inSnippetMode' },
      { key: 'ctrl+enter', command: 'aily.completion.panel', when: 'editorTextFocus && !suggestWidgetVisible && !inSnippetMode' },
      { key: 'ctrl+alt+right', mac: 'ctrl+cmd+right', command: 'aily.completion.acceptLine', when: 'editorTextFocus && inlineSuggestionVisible' },
      { key: 'tab', command: 'aily.completion.acceptEdit', when: 'editorTextFocus && ailyNextEditAvailable && !suggestWidgetVisible && !inSnippetMode && !inlineSuggestionVisible && !editorTabMovesFocus' },
      { key: 'escape', command: 'aily.completion.rejectEdit', when: 'editorTextFocus && ailyNextEditAvailable && !suggestWidgetVisible' },
    ],
  },
} as unknown as IExtensionManifest

const { getApi } = registerExtension(manifest, ExtensionHostKind.LocalProcess, { system: true })
void getApi().then(api => {
  const controller = new CompletionFeature(api)
  setCompletionRuntime(controller)
  if (typeof window !== 'undefined') window.addEventListener('beforeunload', () => controller.dispose(), { once: true })
})

type CandidateCache = { snapshot: EditorSnapshot; result: SuggestionResult; selectedKey: string; bases: Map<string, number> }
type ItemMetadata = { result: SuggestionResult; candidate: Suggestion; length: number; base: number }
type PendingEdit = { snapshot: EditorSnapshot; result: SuggestionResult; candidate: Suggestion; navigated: boolean; expiresAt: number; local?: boolean }
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(abortError()); return }
    const aborted = () => { clearTimeout(timer); reject(abortError()) }
    const timer = setTimeout(() => { signal.removeEventListener('abort', aborted); resolve() }, ms)
    signal.addEventListener('abort', aborted, { once: true })
  })
}

export class CompletionFeature implements CompletionRuntime {
  private readonly transport = new ParentSuggestionTransport()
  private readonly history = new RecentEditStore()
  private readonly resolver: SuggestionContextResolver
  private readonly presentation = new EditPresentation()
  private readonly subscriptions: vscode.Disposable[] = []
  private readonly texts = new Map<string, string>()
  private readonly triggers = new InlineCompletionTriggerTracker()
  private readonly items = new WeakMap<vscode.InlineCompletionItem, ItemMetadata>()
  private readonly visibleItems = new Set<vscode.InlineCompletionItem>()
  private readonly feedbackSeen = new Set<string>()
  private readonly rejections = new Map<string, number>()
  private readonly status: vscode.StatusBarItem
  private capabilities: SuggestionCapabilities | null | undefined
  private capabilityError = ''
  private cache?: CandidateCache
  private pendingEdit?: PendingEdit
  private request?: AbortController
  private timer?: ReturnType<typeof setTimeout>
  private expiry?: ReturnType<typeof setTimeout>
  private snoozeUntil = 0
  private epoch = 0
  private connectionEpoch = 0
  private applying = false
  private navigating = false
  private lastTyping = 0
  private lastNes = 0
  private panel?: vscode.WebviewPanel
  constructor(private readonly api: typeof vscode) {
    this.transport.onSessionChanged = () => { this.invalidate('stale'); void this.connect() }
    this.resolver = new SuggestionContextResolver(api, crypto.randomUUID(), this.history, metadata.version)
    this.status = api.window.createStatusBarItem(api.StatusBarAlignment.Right, 50)
    this.status.command = 'aily.completion.settings'; this.status.show()
    for (const document of api.workspace.textDocuments) this.texts.set(document.uri.toString(), document.getText())
    this.subscriptions.push(
      api.workspace.onDidOpenTextDocument(doc => this.texts.set(doc.uri.toString(), doc.getText())),
      api.workspace.onDidCloseTextDocument(doc => { this.texts.delete(doc.uri.toString()); this.invalidate('stale'); this.triggers.close(doc.uri.toString()) }),
      api.workspace.onDidChangeTextDocument(event => this.changed(event)),
      api.workspace.onDidChangeWorkspaceFolders(() => { this.history.clear(); this.invalidate('stale'); void this.connect() }),
      api.workspace.onDidChangeConfiguration(event => { if (event.affectsConfiguration('aily.completion')) { this.invalidate('stale'); this.updateStatus() } }),
      api.window.onDidChangeActiveTextEditor(() => { if (!this.navigating) { this.clearEdit('stale'); this.request?.abort(); this.epoch++; clearTimeout(this.timer) } this.updateStatus() }),
      api.window.onDidChangeTextEditorSelection(event => {
        if (this.navigating || this.applying) return
        if (this.pendingEdit && event.textEditor.document === this.pendingEdit.snapshot.document) this.clearEdit('stale')
        if (Date.now() - this.lastTyping > 150) { clearTimeout(this.timer); this.request?.abort(); this.epoch++ }
      }),
      api.languages.onDidChangeDiagnostics(event => {
        const doc = api.window.activeTextEditor?.document
        if (doc && event.uris.some(uri => uri.toString() === doc.uri.toString()) && this.config('nextEdit.fixes', true)) this.schedule('diagnostic')
      }),
    )
    const register = (name: string, callback: () => unknown) => this.subscriptions.push(api.commands.registerCommand(name, callback))
    register('aily.completion.settings', () => this.settings())
    register('aily.completion.snooze', () => { this.snoozeUntil = Math.max(Date.now(), this.snoozeUntil) + 300_000; this.invalidate('ignored'); this.updateStatus() })
    register('aily.completion.resume', () => { this.snoozeUntil = 0; this.invalidate('stale'); this.updateStatus() })
    register('aily.completion.reconnect', () => this.connect())
    register('aily.completion.next', () => this.cycle(1))
    register('aily.completion.previous', () => this.cycle(-1))
    register('aily.completion.panel', () => this.openPanel())
    register('aily.completion.predict', () => this.predict('manual'))
    register('aily.completion.acceptEdit', () => this.acceptEdit())
    register('aily.completion.rejectEdit', () => this.clearEdit('rejected'))
    register('aily.completion.acceptLine', () => api.commands.executeCommand('editor.action.inlineSuggest.acceptNextLine'))
    void this.connect()
  }
  private config<T>(key: string, fallback: T): T { return this.api.workspace.getConfiguration('aily.completion').get(key, fallback) }
  private enabled(document: vscode.TextDocument): boolean {
    const languages = this.config<Record<string, boolean>>('languages', { '*': true })
    return this.config('enabled', true) && Date.now() >= this.snoozeUntil && (languages[document.languageId] ?? languages['*'] ?? true) && document.uri.scheme === 'file' && isCompletionSource(document.uri.path)
  }
  private async connect(): Promise<void> {
    const epoch = ++this.connectionEpoch
    this.capabilities = undefined; this.capabilityError = ''; this.updateStatus()
    if (resolveProvider() !== 'cloud') { this.capabilities = null; this.updateStatus(); return }
    try {
      const capabilities = await this.transport.capabilities()
      if (epoch !== this.connectionEpoch) return
      this.capabilities = capabilities; this.capabilityError = capabilities?.quota && !capabilities.quota.allowed ? '当前账户额度或权限不足。' : ''
    } catch (error) {
      if (epoch !== this.connectionEpoch) return
      this.capabilityError = error instanceof Error ? error.message : '服务不可用'
    }
    this.updateStatus()
  }
  async provide(document: vscode.TextDocument, position: vscode.Position, context: vscode.InlineCompletionContext, token: vscode.CancellationToken): Promise<vscode.InlineCompletionList | [] | undefined> {
    if (!this.enabled(document)) return []
    if (this.capabilities === null) return undefined // Explicit old-host/404 fallback only.
    if (!this.capabilities || !this.capabilities.modes.includes('completion') || this.pendingEdit || token.isCancellationRequested) return []
    if (this.capabilities.quota && !this.capabilities.quota.allowed) return []
    const api = this.api; const editor = api.window.activeTextEditor; const offset = document.offsetAt(position); const text = document.getText()
    const trigger = context.triggerKind === api.InlineCompletionTriggerKind.Invoke ? 'invoke' : 'automatic'
    if (editor?.document !== document || editor.selections.length !== 1 || !editor.selection.isEmpty || !editor.selection.active.isEqual(position)) return []
    const selected = context.selectedCompletionInfo
    if (selected && (!selected.range.isSingleLine || !selected.range.end.isEqual(position) || !selected.range.contains(position) || selected.text.includes('\n'))) return []
    const selectedKey = selected ? JSON.stringify([selected.range.start, selected.text]) : ''
    const cache = this.reuse(document, offset, selectedKey)
    if (cache && await this.resolver.isCurrent(cache.snapshot)) return this.makeItems(cache, position, selected)
    // An already accepted prefix may end in ';' or be longer than a typing trigger.
    // Those filters govern new inference, not the verified remainder of this suggestion.
    if (!this.triggers.allow(document.uri.toString(), document.version, offset, trigger) || !shouldRequestInlineCompletion(text.slice(0, offset), text.slice(offset), trigger)) return []
    const controller = new AbortController(); this.request?.abort(); this.request = controller
    const subscription = token.onCancellationRequested(() => controller.abort()); const epoch = ++this.epoch
    try {
      await sleep(trigger === 'invoke' ? 0 : completionDebounceMs(text.slice(0, offset), 300), controller.signal)
      const snapshot = await this.resolver.collect(document, position, 'completion', trigger === 'invoke' ? 'manual' : 'typing', false)
      if (controller.signal.aborted || epoch !== this.epoch) return []
      const result = await this.transport.suggest(snapshot.request, controller.signal)
      if (controller.signal.aborted || epoch !== this.epoch || !editor.selection.active.isEqual(position) || !await this.resolver.isCurrent(snapshot)) return []
      this.cache = { snapshot, result, selectedKey, bases: new Map() }; this.capabilityError = ''; this.updateStatus()
      return this.makeItems(this.cache, position, selected)
    } catch (error) { this.handleError(error); return [] }
    finally { subscription.dispose(); if (this.request === controller) this.request = undefined }
  }
  private reuse(document: vscode.TextDocument, offset: number, selectedKey: string): CandidateCache | undefined {
    const cache = this.cache
    if (!cache || cache.snapshot.document !== document || selectedKey !== cache.selectedKey || Date.now() - cache.snapshot.createdAt > cache.result.expiresInMs) return undefined
    const text = document.getText(); const old = cache.snapshot; const inserted = offset - old.offset
    if (text === old.text && offset === old.offset && document.version === old.version) return cache
    if (selectedKey || inserted < 0 || text.slice(0, old.offset) !== old.text.slice(0, old.offset) || text.slice(offset) !== old.text.slice(old.offset)) return undefined
    const typed = text.slice(old.offset, offset)
    const suggestions = cache.result.suggestions.filter(item => !item.additionalEdits.length && item.kind === 'insert' && item.primary.newText.startsWith(typed) && item.primary.newText.length > typed.length)
    if (!suggestions.length) return undefined
    const position = document.positionAt(offset); const point = { line: position.line, character: position.character }
    const bases = new Map(cache.bases)
    for (const item of suggestions) bases.set(item.candidateId, (bases.get(item.candidateId) ?? 0) + typed.length)
    const updated: CandidateCache = { ...cache, bases, snapshot: { ...old, text, version: document.version, offset,
      dependencies: old.dependencies.map(dep => dep.uri.toString() === document.uri.toString() ? { ...dep, text, version: document.version } : dep) },
      result: { ...cache.result, suggestions: suggestions.map(item => ({ ...item, primary: { range: { start: point, end: point }, expectedText: '', newText: item.primary.newText.slice(typed.length) } })) } }
    this.cache = updated; return updated
  }
  private makeItems(cache: CandidateCache, position: vscode.Position, selected?: vscode.SelectedCompletionInfo): vscode.InlineCompletionList {
    const api = this.api; const items: vscode.InlineCompletionItem[] = []
    for (const candidate of cache.result.suggestions) {
      let text = prepareInlineCompletion({ raw: candidate.primary.newText, prefix: cache.snapshot.text.slice(0, cache.snapshot.offset), suffix: cache.snapshot.text.slice(cache.snapshot.offset), trigger: 'invoke' })
      if (selected) text = extendSelectedCompletion(text, cache.snapshot.text.slice(cache.snapshot.document.offsetAt(selected.range.start), cache.snapshot.offset), selected.text)
      if (!text) continue
      const item = new api.InlineCompletionItem(text, selected?.range ?? new api.Range(position, position)); item.filterText = text; item.correlationId = candidate.candidateId
      this.items.set(item, { result: cache.result, candidate, length: text.length, base: cache.bases.get(candidate.candidateId) ?? 0 }); items.push(item)
    }
    const result = new api.InlineCompletionList(items); result.enableForwardStability = true; return result
  }
  shown(item: vscode.InlineCompletionItem): boolean { const value = this.items.get(item); if (!value) return false; this.visibleItems.add(item); this.feedback(value.result, value.candidate, 'shown'); return true }
  partial(item: vscode.InlineCompletionItem, accepted: number): boolean { const value = this.items.get(item); if (!value) return false; this.feedback(value.result, value.candidate, 'partially_accepted', value.base + accepted); return true }
  ended(item: vscode.InlineCompletionItem, reason: vscode.InlineCompletionEndOfLifeReason): boolean {
    const value = this.items.get(item); if (!value) return false
    this.visibleItems.delete(item)
    const kind = this.api.InlineCompletionEndOfLifeReasonKind
    if (reason.kind === kind.Ignored && reason.supersededBy && this.items.get(reason.supersededBy)?.candidate.candidateId === value.candidate.candidateId) return true
    this.feedback(value.result, value.candidate, reason.kind === kind.Accepted ? 'accepted' : reason.kind === kind.Rejected ? 'rejected' : 'ignored', reason.kind === kind.Accepted ? value.base + value.length : 0)
    if (reason.kind === kind.Accepted) { this.cache = undefined; this.schedule('accept') }
    else if (reason.kind === kind.Rejected) this.cache = undefined
    return true
  }
  private feedback(result: SuggestionResult, candidate: Suggestion, event: FeedbackEvent, acceptedCharacters = 0): void {
    if (!candidate.candidateId.startsWith('sug_')) return
    const identity = `${candidate.candidateId}:${event}:${acceptedCharacters}`
    if (this.feedbackSeen.has(identity)) return
    this.feedbackSeen.add(identity); if (this.feedbackSeen.size > 2000) this.feedbackSeen.delete(this.feedbackSeen.values().next().value!)
    this.transport.feedback(result.completionId, { opportunityId: result.opportunityId, candidateId: candidate.candidateId, event, acceptedCharacters })
  }
  private changed(event: vscode.TextDocumentChangeEvent): void {
    const uri = event.document.uri.toString(); const previous = this.texts.get(uri) ?? ''; const current = event.document.getText(); this.texts.set(uri, current)
    if (!event.contentChanges.length) return
    const suppress = event.reason != null || event.contentChanges.length > 1 || event.contentChanges.some(change => !change.text || change.text.length > 128)
    this.triggers.changed(uri, event.document.version, suppress)
    this.epoch++; this.request?.abort(); this.clearEdit(this.applying ? undefined : 'stale')
    if (!isCompletionSource(event.document.uri.path)) return
    for (const change of event.contentChanges) this.history.add(`f-${contentHash(uri)}`, previous.slice(change.rangeOffset, change.rangeOffset + change.rangeLength), change.text,
      event.reason === this.api.TextDocumentChangeReason.Undo ? 'undo' : event.reason === this.api.TextDocumentChangeReason.Redo ? 'redo' : this.applying ? 'completion' : change.text.length > 128 ? 'paste' : 'typing', Date.now(), change.rangeOffset)
    this.lastTyping = Date.now()
    if (!event.reason && !this.applying && event.contentChanges.every(change => change.text.length <= 8192) && this.api.window.activeTextEditor?.document === event.document) this.schedule('edit')
  }
  private schedule(trigger: 'edit' | 'accept' | 'diagnostic'): void {
    clearTimeout(this.timer)
    if (!this.config('nextEdit.enabled', true) || !this.capabilities?.modes.includes('next-edit')) return
    const eagerness = this.config<string>('eagerness', 'standard'); const delay = eagerness === 'less' ? 1600 : eagerness === 'more' ? 650 : 1000
    this.timer = setTimeout(() => { void this.predict(trigger) }, Math.max(delay, 1500 - (Date.now() - this.lastNes)))
  }
  private async predict(trigger: SuggestionRequest['trigger']): Promise<void> {
    if (trigger !== 'manual' && (this.visibleItems.size || this.request || this.pendingEdit)) return
    clearTimeout(this.timer)
    const api = this.api; const editor = api.window.activeTextEditor
    if (!editor || !this.enabled(editor.document) || !this.capabilities?.modes.includes('next-edit') || editor.selections.length !== 1 || !editor.selection.isEmpty || this.applying) return
    if (this.capabilities.quota && !this.capabilities.quota.allowed) return
    this.clearEdit('superseded'); this.cache = undefined; const epoch = ++this.epoch
    this.request?.abort(); const controller = new AbortController(); this.request = controller; this.lastNes = Date.now()
    try {
      const snapshot = await this.resolver.collect(editor.document, editor.selection.active, 'next-edit', trigger,
        this.config('nextEdit.extendedRange', true) && this.capabilities.features.extendedRange,
        this.config('autoImports', true) && this.capabilities.features.atomicAdditionalEdits)
      if (controller.signal.aborted || epoch !== this.epoch) return
      const importWindows = snapshot.request.documents[0]!.windows.filter(window => window.purpose === 'import' && window.allowedNewText?.length === 1)
      let result: SuggestionResult
      if (trigger === 'diagnostic' && importWindows.length) {
        const edits = importWindows.map(window => ({ range: window.range, expectedText: window.text, newText: window.allowedNewText![0]! }))
        const primary = edits[0]!
        result = { protocolVersion: 2, requestId: snapshot.request.requestId, opportunityId: snapshot.request.opportunityId, completionId: 'local',
          suggestions: [{ candidateId: `local-${crypto.randomUUID()}`, fileId: snapshot.request.active.fileId, snapshotId: snapshot.request.active.snapshotId,
            kind: primary.expectedText ? 'edit' : 'insert', primary, additionalEdits: edits.slice(1) }], expiresInMs: 15_000, finishReason: 'complete' }
      } else result = await this.transport.suggest(snapshot.request, controller.signal)
      if (controller.signal.aborted || epoch !== this.epoch || api.window.activeTextEditor !== editor || !await this.resolver.isCurrent(snapshot)) return
      const candidate = result.suggestions[0]; if (!candidate) return
      const signature = this.signature(candidate)
      if ((this.rejections.get(signature) ?? 0) > Date.now()) return
      await api.commands.executeCommand('editor.action.inlineSuggest.hide')
      if (controller.signal.aborted || epoch !== this.epoch || !await this.resolver.isCurrent(snapshot)) return
      this.pendingEdit = { snapshot, result, candidate, navigated: false, expiresAt: Date.now() + result.expiresInMs }
      this.renderEdit(); this.feedback(result, candidate, 'shown')
      this.expiry = setTimeout(() => this.clearEdit('stale'), result.expiresInMs)
    } catch (error) { this.handleError(error) }
    finally { if (this.request === controller) this.request = undefined }
  }
  private renderEdit(): void {
    const plan = this.pendingEdit; if (!plan) return
    const editor = this.api.window.activeTextEditor
    const far = editor?.document !== plan.snapshot.document || Math.abs((editor?.selection.active.line ?? 0) - plan.candidate.primary.range.start.line) > 5
    const collapsed = !plan.navigated && (far || this.config('nextEdit.showCollapsed', false))
    this.presentation.show(plan.snapshot, plan.candidate, collapsed, () => { void this.acceptEdit() }, () => this.clearEdit('rejected'))
    void this.api.commands.executeCommand('setContext', 'ailyNextEditAvailable', true)
    if (far) this.feedback(plan.result, plan.candidate, 'jump_shown')
    this.updateStatus()
  }
  private async acceptEdit(): Promise<void> {
    const plan = this.pendingEdit
    if (!plan || Date.now() > plan.expiresAt || !await this.resolver.isCurrent(plan.snapshot) || this.pendingEdit !== plan) { this.clearEdit('stale'); return }
    const api = this.api; const editor = api.window.activeTextEditor
    const far = editor?.document !== plan.snapshot.document || Math.abs((editor?.selection.active.line ?? 0) - plan.candidate.primary.range.start.line) > 5
    if (!plan.navigated && (far || this.config('nextEdit.showCollapsed', false))) {
      this.navigating = true
      try {
        const target = await api.window.showTextDocument(plan.snapshot.document, { preview: false })
        if (this.pendingEdit !== plan || Date.now() > plan.expiresAt || !await this.resolver.isCurrent(plan.snapshot)) { this.clearEdit('stale'); return }
        const start = new api.Position(plan.candidate.primary.range.start.line, plan.candidate.primary.range.start.character)
        target.selection = new api.Selection(start, start); target.revealRange(new api.Range(start, start), api.TextEditorRevealType.InCenterIfOutsideViewport)
        plan.navigated = true; this.feedback(plan.result, plan.candidate, 'jumped'); this.renderEdit()
      } finally { setTimeout(() => { this.navigating = false }, 0) }
      return
    }
    this.applying = true
    try {
      const applied = applySuggestion(plan.snapshot, plan.candidate)
      this.feedback(plan.result, plan.candidate, applied ? 'applied' : 'apply_failed', applied ? plan.candidate.primary.newText.length : 0)
      this.clearEdit(); if (applied) this.schedule('accept')
    } finally { this.applying = false }
  }
  private clearEdit(event?: FeedbackEvent): void {
    clearTimeout(this.expiry)
    if (this.pendingEdit && event) {
      this.feedback(this.pendingEdit.result, this.pendingEdit.candidate, event)
      if (event === 'rejected') this.rejections.set(this.signature(this.pendingEdit.candidate), Date.now() + 30_000)
    }
    this.pendingEdit = undefined; this.presentation.clear()
    void this.api.commands.executeCommand('setContext', 'ailyNextEditAvailable', false); this.updateStatus()
  }
  private signature(candidate: Suggestion): string { return `${candidate.fileId}:${contentHash(JSON.stringify(candidate.primary))}` }
  private async alternatives(): Promise<CandidateCache | undefined> {
    const editor = this.api.window.activeTextEditor
    if (!editor || !this.enabled(editor.document) || !this.capabilities?.modes.includes('alternatives') || !editor.selection.isEmpty || editor.selections.length !== 1) return undefined
    const reusable = this.reuse(editor.document, editor.document.offsetAt(editor.selection.active), '')
    if (reusable && reusable.result.suggestions.length > 1 && await this.resolver.isCurrent(reusable.snapshot)) return reusable
    this.clearEdit('superseded'); const epoch = ++this.epoch; this.request?.abort(); const controller = new AbortController(); this.request = controller
    try {
      const snapshot = await this.resolver.collect(editor.document, editor.selection.active, 'alternatives', 'manual', false)
      snapshot.request.options.maxCandidates = Math.max(1, Math.min(snapshot.request.options.maxCandidates, this.capabilities.maxCandidates))
      const result = await this.transport.suggest(snapshot.request, controller.signal)
      if (controller.signal.aborted || epoch !== this.epoch || !await this.resolver.isCurrent(snapshot)) return undefined
      this.cache = { snapshot, result, selectedKey: '', bases: new Map() }
      return this.cache
    } catch (error) { this.handleError(error); return undefined }
    finally { if (this.request === controller) this.request = undefined }
  }
  private async cycle(direction: number): Promise<void> {
    if (!await this.alternatives()) return
    await this.api.commands.executeCommand('editor.action.inlineSuggest.trigger')
    await this.api.commands.executeCommand(direction > 0 ? 'editor.action.inlineSuggest.showNext' : 'editor.action.inlineSuggest.showPrevious')
  }
  private async openPanel(): Promise<void> {
    const cache = await this.alternatives(); if (!cache) return
    this.panel?.dispose()
    for (const candidate of cache.result.suggestions) this.feedback(cache.result, candidate, 'shown')
    const panel = this.api.window.createWebviewPanel('aily-completion-candidates', '补全候选', { viewColumn: this.api.ViewColumn.Beside, preserveFocus: true }, { enableScripts: true, localResourceRoots: [] })
    this.panel = panel
    const escape = (value: string) => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!)
    const nonce = crypto.randomUUID().replace(/-/g, '')
    panel.webview.html = `<!doctype html><html lang="zh"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'"><style>body{color:var(--vscode-foreground);background:var(--vscode-editor-background);font:13px sans-serif;padding:16px}pre{white-space:pre-wrap;background:var(--vscode-textCodeBlock-background);padding:12px}button{color:var(--vscode-button-foreground);background:var(--vscode-button-background);border:0;padding:7px 12px;cursor:pointer}section{margin-bottom:24px}</style></head><body><h2>比较补全候选</h2><p>原文件：${escape(cache.snapshot.request.documents[0]!.relativePath)} · 第 ${cache.snapshot.request.active.position.line + 1} 行</p>${cache.result.suggestions.length ? cache.result.suggestions.map((candidate, index) => `<section><h3>候选 ${index + 1}</h3><pre>${escape(candidate.primary.newText)}</pre><button data-candidate="${escape(candidate.candidateId)}">接受候选 ${index + 1}</button></section>`).join('') : '<p>当前没有其他建议。</p>'}<p id="status"></p><script nonce="${nonce}">const vscode=acquireVsCodeApi();document.querySelectorAll('button[data-candidate]').forEach(button=>button.addEventListener('click',()=>vscode.postMessage({candidateId:button.dataset.candidate})));window.addEventListener('message',event=>{document.getElementById('status').textContent=event.data.message||'';if(event.data.disable)document.querySelectorAll('button').forEach(button=>button.disabled=true);});</script></body></html>`
    const subscription = panel.webview.onDidReceiveMessage(async message => {
      const candidate = cache.result.suggestions.find(item => item.candidateId === message?.candidateId)
      if (!candidate) return
      if (!await this.resolver.isCurrent(cache.snapshot) || Date.now() - cache.snapshot.createdAt > cache.result.expiresInMs || !this.enabled(cache.snapshot.document)) {
        await panel.webview.postMessage({ message: '原文件或上下文已改变，请重新生成候选。', disable: true }); return
      }
      this.applying = true
      try {
        const applied = applySuggestion(cache.snapshot, candidate)
        this.feedback(cache.result, candidate, applied ? 'applied' : 'apply_failed', applied ? candidate.primary.newText.length : 0)
        if (applied) { this.cache = undefined; panel.dispose(); await this.api.window.showTextDocument(cache.snapshot.document); this.schedule('accept') }
      } finally { this.applying = false }
    })
    panel.onDidDispose(() => { subscription.dispose(); if (this.panel === panel) this.panel = undefined })
  }
  private async settings(): Promise<void> {
    const language = this.api.window.activeTextEditor?.document.languageId
    const selected = await this.api.window.showQuickPick([
      { label: this.config('enabled', true) ? '关闭自动补全' : '启用自动补全', action: 'toggle' },
      { label: '暂停 5 分钟', action: 'snooze' }, { label: '恢复自动补全', action: 'resume' },
      { label: `切换当前语言补全${language ? ` (${language})` : ''}`, action: 'language' },
      { label: this.config('nextEdit.enabled', true) ? '关闭下一处编辑建议' : '启用下一处编辑建议', action: 'nes' },
      { label: '设置建议频率', action: 'frequency' }, { label: '更多设置', action: 'settings' }, { label: '重新连接服务', action: 'reconnect' },
    ], { placeHolder: this.capabilities?.model ? `补全模型：${this.capabilities.model.id}（服务端选择）` : 'Aily 自动补全' })
    if (!selected) return
    const config = this.api.workspace.getConfiguration('aily.completion'); const global = this.api.ConfigurationTarget.Global
    if (selected.action === 'toggle') await config.update('enabled', !this.config('enabled', true), global)
    else if (selected.action === 'language' && language) { const languages = this.config<Record<string, boolean>>('languages', { '*': true }); await config.update('languages', { ...languages, [language]: !(languages[language] ?? languages['*'] ?? true) }, global) }
    else if (selected.action === 'nes') await config.update('nextEdit.enabled', !this.config('nextEdit.enabled', true), global)
    else if (selected.action === 'frequency') { const frequency = await this.api.window.showQuickPick(['less', 'standard', 'more'], { placeHolder: '建议频率：少 / 标准 / 多' }); if (frequency) await config.update('eagerness', frequency, global) }
    else if (selected.action === 'settings') await this.api.commands.executeCommand('workbench.action.openSettings', 'aily.completion')
    else await this.api.commands.executeCommand(`aily.completion.${selected.action}`)
  }
  private handleError(error: unknown): void {
    if (error instanceof DOMException && error.name === 'AbortError') return
    this.capabilityError = error instanceof SuggestionError ? error.message : '编辑建议暂时不可用。'; this.updateStatus()
  }
  private invalidate(event: FeedbackEvent): void {
    this.visibleItems.clear()
    this.epoch++; this.request?.abort(); completionCoordinator.cancel(); clearTimeout(this.timer); this.cache = undefined; this.clearEdit(event)
    void this.api.commands.executeCommand('editor.action.inlineSuggest.hide')
  }
  private updateStatus(): void {
    if (!this.status) return
    if (this.pendingEdit) { this.status.text = `$(arrow-right) Tab → 第 ${this.pendingEdit.candidate.primary.range.start.line + 1} 行`; this.status.tooltip = '定位并审阅下一处编辑建议，再按 Tab 接受。'; return }
    const document = this.api.window.activeTextEditor?.document
    this.status.text = Date.now() < this.snoozeUntil ? '$(debug-pause) Aily 补全已暂停' : !this.config('enabled', true) || (document && !this.enabled(document)) ? '$(circle-slash) Aily 补全已关闭' : this.capabilityError ? '$(warning) Aily 补全不可用' : this.capabilities === null ? '$(sparkle) Aily 续写 v3' : this.capabilities ? '$(sparkle) Aily 补全 v4' : '$(sync~spin) Aily 补全连接中'
    this.status.tooltip = this.capabilityError || (this.capabilities?.model ? `服务端模型：${this.capabilities.model.id}` : '自动补全设置')
    if (resolveProvider() === 'lmstudio-fim' && this.config('enabled', true) && Date.now() >= this.snoozeUntil && (!document || this.enabled(document))) this.status.text = '$(sparkle) Aily 本地续写'
    if (resolveProvider() === 'off') this.status.text = '$(circle-slash) Aily 补全已关闭'
  }
  dispose(): void { this.connectionEpoch++; this.invalidate('ignored'); this.transport.dispose(); this.panel?.dispose(); this.status.dispose(); this.subscriptions.forEach(item => item.dispose()) }
}
