import type * as vscode from 'vscode'
import { registerExtension, ExtensionHostKind, type IExtensionManifest } from '@codingame/monaco-vscode-api/extensions'
import metadata from '../../../package.json'
import { ParentSuggestionTransport } from './suggestionTransport'
import { SuggestionContextResolver, type EditorSnapshot } from './suggestionContext'
import { RecentEditStore, contentHash, isCompletionSource, completionCoordinator, abortError, completionReconnectDelay } from './completionState'
import { SuggestionError, type Suggestion, type SuggestionResult, type SuggestionCapabilities, type FeedbackEvent, type SuggestionRequest } from './suggestionProtocol'
import { migrateAilyTabConfiguration } from './ailyTabConfiguration'
import { EditPresentation, applySuggestion, editorSuggestionBlocked } from './editPresentation'
import { InlineCompletionTriggerTracker, shouldRequestInlineCompletion, prepareInlineCompletion, extendSelectedCompletion, completionDebounceMs } from './ailyTabPolicy'
import { getHostEmbedContext, onHostEmbedContextChanged } from '../../hostEmbedContext'
import { setCompletionStatus } from './completionStatus'
import { partialLength, planPartialImportAcceptance } from './partialImportAcceptance'
import { affectsCompletionContext } from './completionFileChanges'
import { editOrigin, hasRecentReplacement, isTypedLineBreak, minimalEdit, MAX_PREDICTION_CHAIN } from './ailyTabOpportunity'
import { getLanguageServerState, hasLanguageServerCompilationDatabase, onLanguageServerStateChanged } from '../languageServerState'
import { AILY_TAB_KEYBINDINGS, AILY_TAB_SNOOZE_PRESETS, ailyTabSnoozeDeadline, ailyTabSnoozeRemaining } from './ailyTabControls'

const commands = [
  ['aily.completion.settings', 'Aily: 自动补全设置'], ['aily.completion.snooze', 'Aily: 选择自动补全暂停时长'], ['aily.completion.resume', 'Aily: 恢复自动补全'],
  ['aily.completion.trigger', 'Aily: 触发 Aily Tab'],
  ['aily.completion.acceptEdit', 'Aily: 定位或接受编辑建议'], ['aily.completion.rejectEdit', 'Aily: 拒绝编辑建议'],
  ['aily.completion.acceptLine', 'Aily: 接受下一行补全'], ['aily.completion.reconnect', 'Aily: 重新连接补全服务'],
  ['aily.completion.acceptEditWord', 'Aily: 接受编辑建议的下一个词'], ['aily.completion.acceptEditLine', 'Aily: 接受编辑建议的下一行'],
].map(([command, title]) => ({ command, title }))
const manifest = {
  name: 'code-suggestions-v4', publisher: 'aily', version: metadata.version, engines: { vscode: '*' },
  enabledApiProposals: ['inlineCompletionsAdditions', 'textDocumentChangeReason'], contributes: {
    commands,
    configuration: { title: 'Aily Tab', properties: {
      'aily.completion.enabled': { type: 'boolean', default: true, description: '启用代码自动补全。' },
      'aily.completion.crossFile': { type: 'boolean', default: true, description: '预测关联源码中的下一处修改；Tab 先跳转，再按 Tab 接受。' },
      'aily.completion.excludedExtensions': { type: 'array', items: { type: 'string' }, default: [], description: '禁用补全的文件扩展名，例如 .md、.json。' },
      'aily.completion.suggestInComments': { type: 'boolean', default: true, description: '允许在注释内部提供建议。' },
      'aily.completion.debounceMs': { type: 'number', default: 300, minimum: 100, maximum: 2000, description: '自动续写等待时间（毫秒）。' },
      'aily.completion.languages': { type: 'object', default: { '*': true, plaintext: false, markdown: false }, additionalProperties: { type: 'boolean' }, description: '按语言启用补全。' },
      'aily.completion.autoImports': { type: 'boolean', default: true, description: '仅使用语言服务验证且来源唯一的导入建议。' },
      'aily.completion.nextEdit.fixes': { type: 'boolean', default: true, description: '根据语言服务诊断建议修复。' },
      'aily.completion.nextEdit.extendedRange': { type: 'boolean', default: true, description: '预测较远的引用、实现和调用位置。' },
      'aily.completion.nextEdit.showCollapsed': { type: 'boolean', default: false, description: '先显示编辑位置，按 Tab 后展开差异。' },
      'aily.completion.eagerness': { type: 'string', enum: ['less', 'standard', 'more'], default: 'standard', description: '自动建议频率。' },
    } },
    keybindings: AILY_TAB_KEYBINDINGS,
  },
} as unknown as IExtensionManifest

const { getApi } = registerExtension(manifest, ExtensionHostKind.LocalProcess, { system: true })
void getApi().then(async api => {
  await migrateAilyTabConfiguration(api.workspace.getConfiguration('aily.completion'), api.ConfigurationTarget)
  const controller = new CompletionFeature(api)
  // beforeunload can be vetoed by the Workbench. Dispose only after navigation
  // commits, otherwise a cancelled refresh silently disables future suggestions.
  if (typeof window !== 'undefined') window.addEventListener('pagehide', () => controller.dispose(), { once: true })
})

type CandidateCache = { snapshot: EditorSnapshot; result: SuggestionResult; selectedKey: string; bases: Map<string, number> }
type ItemMetadata = { result: SuggestionResult; candidate: Suggestion; length: number; base: number }
type PendingEdit = { snapshot: EditorSnapshot; target?: EditorSnapshot; result: SuggestionResult; candidate: Suggestion; navigated: boolean; expiresAt: number; partialAllowed?: boolean; acceptedBase?: number }
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(abortError()); return }
    const aborted = () => { clearTimeout(timer); reject(abortError()) }
    const timer = setTimeout(() => { signal.removeEventListener('abort', aborted); resolve() }, ms)
    signal.addEventListener('abort', aborted, { once: true })
  })
}

export class CompletionFeature {
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
  private capabilities: SuggestionCapabilities | undefined
  private capabilityError = ''
  private cache?: CandidateCache
  private pendingEdit?: PendingEdit
  private request?: AbortController
  private requestSnapshot?: { controller: AbortController; snapshot: EditorSnapshot }
  private timer?: ReturnType<typeof setTimeout>
  private expiry?: ReturnType<typeof setTimeout>
  private snoozeUntil = 0
  private epoch = 0
  private connectionEpoch = 0
  private reconnectAttempt = 0
  private reconnectTimer?: ReturnType<typeof setTimeout>
  private applying = false
  private accepting = false
  private navigation?: { plan: PendingEdit; uri: string }
  private snoozeTimer?: ReturnType<typeof setTimeout>
  private chain = new Set<string>()
  private chainSteps = 0
  private lastTyping = 0
  private lastNes = 0
  private manualOperation = ''
  private manualEditor?: vscode.TextEditor
  private readonly inlineChanged: vscode.EventEmitter<void>
  private recovery?: 'inline' | 'edit' | 'accept' | 'diagnostic'
  private recoveryAttempts = 0
  private recoveringInline = false
  private providerRegistration?: vscode.Disposable
  private predictionVersion?: { uri: string; version: number }
  private lineBreak?: { uri: string; version: number; line: number }
  private lineBreakTimer?: ReturnType<typeof setTimeout>
  constructor(private readonly api: typeof vscode) {
    this.inlineChanged = new api.EventEmitter<void>()
    this.subscriptions.push(this.inlineChanged)
    this.transport.onAvailabilityChanged = () => {
      this.updateStatus()
      if (this.transport.unavailable || !this.recovery || this.recoveryAttempts >= 3) return
      const recovery = this.recovery; this.recovery = undefined; this.recoveryAttempts++
      this.capabilityError = ''; this.updateStatus()
      const editor = api.window.activeTextEditor
      if (!editor || !this.enabled(editor.document) || editorSuggestionBlocked(editor.document.uri.toString(), true)) return
      // Rebuild from the current buffer; never replay a throttled request body.
      if (recovery === 'inline') {
        this.triggers.close(editor.document.uri.toString())
        // The pinned Workbench caches an empty result by provider/position/version;
        // hide has a visible-item precondition and cannot clear it after an error.
        // Replace the single registration through the public API to invalidate that
        // cache without changing the user's buffer, selection or editor settings.
        this.recoveringInline = true
        this.registerInlineProvider()
        void Promise.resolve(api.commands.executeCommand('editor.action.inlineSuggest.trigger', { explicit: true }))
          .catch(error => this.handleError(error)).finally(() => { this.recoveringInline = false })
      }
      else this.schedule(recovery)
    }
    this.transport.onSessionChanged = () => { this.invalidate('stale'); this.reconnectAttempt = 0; void this.connect() }
    this.resolver = new SuggestionContextResolver(api, crypto.randomUUID(), this.history, metadata.version,
      path => this.transport.declaration(path), (uri, languageId) => this.allowedFile(uri, languageId), document => this.diagnosticsAvailable(document))
    this.status = api.window.createStatusBarItem(api.StatusBarAlignment.Right, 50)
    this.status.command = 'aily.completion.settings'; this.status.show()
    this.subscriptions.push({ dispose: onLanguageServerStateChanged(() => {
      this.resolver.invalidate(); this.invalidate('stale'); this.updateStatus()
    }) })
    let hostContext = this.dependencyContextKey()
    this.subscriptions.push({ dispose: onHostEmbedContextChanged(() => {
      const next = this.dependencyContextKey()
      if (next !== hostContext) { hostContext = next; this.resolver.invalidate(); this.history.clear(); this.invalidate('stale') }
    }) })
    const watcher = api.workspace.createFileSystemWatcher('**/*')
    const treeChanged = (uri: vscode.Uri) => {
      if (!this.relevantFileChange(uri)) return
      this.resolver.invalidate(); this.invalidate('stale')
    }
    this.subscriptions.push(watcher, watcher.onDidChange(uri => { void this.diskChanged(uri) }), watcher.onDidCreate(treeChanged), watcher.onDidDelete(treeChanged))
    for (const document of api.workspace.textDocuments) this.texts.set(document.uri.toString(), document.getText())
    this.subscriptions.push(
      api.workspace.onDidOpenTextDocument(doc => this.texts.set(doc.uri.toString(), doc.getText())),
      api.workspace.onDidCloseTextDocument(doc => { this.texts.delete(doc.uri.toString()); this.invalidate('stale'); this.triggers.close(doc.uri.toString()) }),
      api.workspace.onDidChangeTextDocument(event => this.changed(event)),
      api.workspace.onDidChangeWorkspaceFolders(() => { this.history.clear(); this.resolver.invalidate(); this.invalidate('stale'); void this.connect() }),
      api.workspace.onDidChangeConfiguration(event => { if (event.affectsConfiguration('aily.completion') || event.affectsConfiguration('editor.inlineSuggest')) { this.invalidate('stale'); this.updateStatus() } }),
      api.window.onDidChangeActiveTextEditor(editor => {
        // Opening/closing an import-source quick pick can briefly
        // report no active editor. Keep the explicit manual request alive as
        // long as the user did not switch to another source editor.
        if (this.manualOperation && (!editor || editor.document.uri.toString() === this.manualEditor?.document.uri.toString())) { this.updateStatus(); return }
        if (this.navigation && (!editor || editor.document.uri.toString() === this.navigation.uri)) { this.updateStatus(); return }
        this.navigation = undefined
        this.recovery = undefined
        this.lineBreak = undefined; clearTimeout(this.lineBreakTimer)
        this.clearEdit('stale'); this.request?.abort(); this.epoch++; clearTimeout(this.timer)
        this.updateStatus()
      }),
      api.window.onDidChangeTextEditorSelection(event => {
        if ((this.navigation?.uri === event.textEditor.document.uri.toString()) || this.applying) return
        // Applying the previous edit can emit an unclassified selection event
        // after the synchronous transaction returns. Keep the accepted rename
        // chain alive; real keyboard/mouse navigation still cancels it below.
        if (this.timer && this.chainSteps > 0 && event.kind == null) return
        if (this.pendingEdit) {
          const target = this.pendingEdit.candidate.primary.range.start
          const expectedNavigation = this.pendingEdit.navigated && event.textEditor.document.uri.toString() === (this.pendingEdit.target ?? this.pendingEdit.snapshot).document.uri.toString() && event.selections.length === 1 && event.selections[0]!.isEmpty &&
            event.selections[0]!.active.line === target.line && event.selections[0]!.active.character === target.character
          if (expectedNavigation) return
          this.clearEdit('stale')
        }
        if (Date.now() - this.lastTyping > 150) { this.recovery = undefined; clearTimeout(this.timer); this.request?.abort(); this.epoch++ }
      }),
      api.languages.onDidChangeDiagnostics(event => {
        for (const uri of event.uris) this.resolver.diagnosticsObserved(uri)
        if (this.pendingEdit?.snapshot.request.diagnostics.length && event.uris.some(uri => this.pendingEdit?.snapshot.dependencies.some(dep => dep.uri.toString() === uri.toString()))) this.clearEdit('stale')
        const doc = api.window.activeTextEditor?.document
        if (doc && !this.isLineBreakDocument(doc) && this.diagnosticsAvailable(doc) && event.uris.some(uri => uri.toString() === doc.uri.toString()) && this.config('nextEdit.fixes', true) && Date.now() - this.lastTyping < 5000) this.schedule('diagnostic')
      }),
    )
    const register = (name: string, callback: () => unknown) => this.subscriptions.push(api.commands.registerCommand(name, callback))
    register('aily.completion.settings', () => this.settings())
    register('aily.completion.snooze', () => this.snooze())
    register('aily.completion.resume', () => { clearTimeout(this.snoozeTimer); this.snoozeUntil = 0; this.invalidate('stale'); this.updateStatus() })
    register('aily.completion.reconnect', () => { this.reconnectAttempt = 0; return this.connect() })
    register('aily.completion.trigger', () => this.runManual('Aily Tab 正在预测…', async () => {
      const editor = api.window.activeTextEditor
      if (!editor || !this.enabled(editor.document)) return false
      const text = editor.document.getText(); const offset = editor.document.offsetAt(editor.selection.active)
      if ((!this.isLineBreakDocument(editor.document) && hasRecentReplacement(this.history.read(), `f-${contentHash(editor.document.uri.toString())}`)) || !shouldRequestInlineCompletion(text.slice(0, offset), text.slice(offset), 'automatic')) await this.predict('manual')
      else await api.commands.executeCommand('editor.action.inlineSuggest.trigger')
      return true
    }))
    register('aily.completion.acceptEdit', () => this.acceptEdit())
    register('aily.completion.acceptEditWord', () => this.acceptPartial('word'))
    register('aily.completion.acceptEditLine', () => this.acceptPartial('line'))
    register('aily.completion.rejectEdit', () => this.clearEdit('rejected'))
    register('aily.completion.acceptLine', () => api.commands.executeCommand('editor.action.inlineSuggest.acceptNextLine'))
    this.registerInlineProvider()
    this.subscriptions.push({ dispose: () => this.providerRegistration?.dispose() })
    void this.connect()
  }
  private registerInlineProvider(): void {
    const api = this.api
    this.providerRegistration?.dispose()
    this.providerRegistration = api.languages.registerInlineCompletionItemProvider([{ scheme: 'file' }], {
      onDidChange: this.inlineChanged.event,
      provideInlineCompletionItems: (document, position, context, token) => this.provide(document, position, context, token),
      handleDidShowCompletionItem: item => { this.shown(item) },
      handleDidPartiallyAcceptCompletionItem: (item, info) => { this.partial(item, typeof info === 'number' ? info : info.acceptedLength) },
      handleEndOfLifetime: (item, reason) => { this.ended(item, reason) },
    }, { debounceDelayMs: 0, displayName: 'Aily Tab' })
  }
  private config<T>(key: string, fallback: T): T { return this.api.workspace.getConfiguration('aily.completion').get(key, fallback) }
  private diagnosticsAvailable(document: vscode.TextDocument): boolean {
    return !['c', 'cpp', 'cuda-cpp', 'objective-cpp'].includes(document.languageId) ||
      (getLanguageServerState() === 'ready' && hasLanguageServerCompilationDatabase() !== false)
  }
  private dependencyContextKey(): string { const context = getHostEmbedContext(); return JSON.stringify([context?.workspaceRoot, context?.platformPackages, context?.boardProfile]) }
  private relevantFileChange(uri: vscode.Uri): boolean {
    const snapshots = [this.pendingEdit?.target, this.pendingEdit?.snapshot, this.requestSnapshot?.snapshot, this.cache?.snapshot]
    const dependencies = snapshots.flatMap(snapshot => snapshot?.dependencies.map(dep => dep.uri.path) ?? [])
    const root = this.api.workspace.workspaceFolders?.[0]?.uri.path ?? getHostEmbedContext()?.workspaceRoot
    return affectsCompletionContext(uri.path, root, dependencies)
  }
  private async diskChanged(uri: vscode.Uri): Promise<void> {
    if (!this.relevantFileChange(uri)) return
    const snapshot = this.pendingEdit?.target ?? this.pendingEdit?.snapshot ?? this.requestSnapshot?.snapshot ?? this.cache?.snapshot
    const dependency = snapshot?.dependencies.find(dep => dep.uri.toString() === uri.toString())
    if (dependency) {
      try {
        const text = new TextDecoder().decode(await this.api.workspace.fs.readFile(uri))
        // Saving an already captured buffer is not a new edit or a new context.
        if (text === dependency.text) return
      } catch { /* Missing source also invalidates its snapshot. */ }
    }
    this.resolver.invalidate(); this.invalidate('stale')
  }
  private enabled(document: vscode.TextDocument): boolean {
    return this.config('enabled', true) && Date.now() >= this.snoozeUntil && this.allowedFile(document.uri, document.languageId)
  }
  private allowedFile(uri: vscode.Uri, languageId: string): boolean {
    const languages = this.config<Record<string, boolean>>('languages', { '*': true })
    const extension = uri.path.match(/\.[^/.]+$/)?.[0]?.toLowerCase() ?? ''
    const excluded = this.config<string[]>('excludedExtensions', []).some(value => (value.startsWith('.') ? value : `.${value}`).toLowerCase() === extension)
    return !excluded && this.api.workspace.getConfiguration('editor', { uri, languageId }).get('inlineSuggest.enabled', true) &&
      (languages[languageId] ?? languages['*'] ?? true) && uri.scheme === 'file' && isCompletionSource(uri.path)
  }
  private async connect(): Promise<void> {
    clearTimeout(this.reconnectTimer); this.reconnectTimer = undefined
    const epoch = ++this.connectionEpoch
    this.capabilities = undefined; this.capabilityError = ''; this.updateStatus()
    try {
      const capabilities = await this.transport.capabilities()
      if (epoch !== this.connectionEpoch) return
      this.reconnectAttempt = 0
      this.capabilities = capabilities; this.capabilityError = capabilities?.quota && !capabilities.quota.allowed ? '当前账户额度或权限不足。' : ''
    } catch (error) {
      if (epoch !== this.connectionEpoch) return
      this.capabilityError = error instanceof Error ? error.message : '服务不可用'
      if (error instanceof SuggestionError && [404, 405, 426, 429, 502, 503, 504].includes(error.status)) this.scheduleReconnect(error.retryAfterMs)
    }
    this.updateStatus()
  }
  private scheduleReconnect(retryAfterMs = 0): void {
    clearTimeout(this.reconnectTimer)
    const delay = completionReconnectDelay(this.reconnectAttempt++, retryAfterMs)
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = undefined; void this.connect() }, delay)
  }
  async provide(document: vscode.TextDocument, position: vscode.Position, context: vscode.InlineCompletionContext, token: vscode.CancellationToken): Promise<vscode.InlineCompletionList | []> {
    if (!this.enabled(document) || editorSuggestionBlocked(document.uri.toString())) return []
    if (context.triggerKind !== this.api.InlineCompletionTriggerKind.Invoke && this.predictionVersion?.uri === document.uri.toString() && this.predictionVersion.version === document.version) return []
    if (this.transport.unavailable) { this.recovery = 'inline'; return [] }
    // A manual Aily Tab request owns the inference lane until it
    // completes. Background inline requests must not advance the shared epoch
    // and discard the explicit user action. Manual inline invoke remains valid.
    if (this.manualOperation && context.triggerKind !== this.api.InlineCompletionTriggerKind.Invoke) return []
    if (!this.capabilities || !this.capabilities.modes.includes('completion') || this.pendingEdit || token.isCancellationRequested) return []
    if (this.capabilities.quota && !this.capabilities.quota.allowed) return []
    const api = this.api; const editor = api.window.activeTextEditor; const offset = document.offsetAt(position); const text = document.getText()
    const trigger = context.triggerKind === api.InlineCompletionTriggerKind.Invoke && !this.recoveringInline ? 'invoke' : 'automatic'
    if (!this.config('suggestInComments', true) && isInsideComment(text.slice(0, offset))) return []
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
      await sleep(trigger === 'invoke' ? 0 : completionDebounceMs(text.slice(0, offset), Math.min(2000, Math.max(100, this.config('debounceMs', 300)))), controller.signal)
      const snapshot = await this.resolver.collect(document, position, 'completion', trigger === 'invoke' ? 'manual' : 'typing', false)
      if (controller.signal.aborted || epoch !== this.epoch) return []
      this.requestSnapshot = { controller, snapshot }
      const result = await this.transport.suggest(snapshot.request, controller.signal)
      if (controller.signal.aborted || epoch !== this.epoch || !editor.selection.active.isEqual(position) || !await this.resolver.isCurrent(snapshot)) return []
      result.suggestions = result.suggestions.flatMap(candidate => {
        const newText = prepareInlineCompletion({ raw: candidate.primary.newText, prefix: snapshot.text.slice(0, snapshot.offset), suffix: snapshot.text.slice(snapshot.offset), trigger })
        return newText ? [{ ...candidate, primary: { ...candidate.primary, newText } }] : []
      })
      const candidate = result.suggestions[0]
      if (candidate && !selected && this.config('autoImports', true) && this.capabilities.features.atomicAdditionalEdits) {
        const enriched = await this.resolver.withImports(snapshot, candidate)
        if (controller.signal.aborted || epoch !== this.epoch || !await this.resolver.isCurrent(snapshot)) return []
        if (enriched.additionalEdits.length || snapshot.importChoices?.length) {
          this.pendingEdit = { snapshot, candidate: enriched, result, navigated: false, expiresAt: Date.now() + result.expiresInMs }
          this.renderEdit(); this.feedback(result, enriched, 'shown'); this.expiry = setTimeout(() => this.clearEdit('stale'), result.expiresInMs)
          return []
        }
      }
      this.cache = { snapshot, result: result.suggestions.length ? result : { ...result, expiresInMs: 1500 }, selectedKey, bases: new Map() }; this.recoveryAttempts = 0; this.capabilityError = ''; this.updateStatus()
      return this.makeItems(this.cache, position, selected)
    } catch (error) { if (this.transport.unavailable) this.recovery = 'inline'; this.handleError(error); return [] }
    finally { subscription.dispose(); if (this.request === controller) this.request = undefined; if (this.requestSnapshot?.controller === controller) this.requestSnapshot = undefined }
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
      let text = candidate.primary.newText
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
    this.recoveryAttempts = 0; this.predictionVersion = undefined
    this.resolver.documentChanged(event.document.uri)
    const detail = (event as vscode.TextDocumentChangeEvent & { detailedReason?: { source: string; metadata?: Record<string, unknown> } }).detailedReason
    const origin = event.reason === this.api.TextDocumentChangeReason.Undo ? 'undo' : event.reason === this.api.TextDocumentChangeReason.Redo ? 'redo' : this.applying ? 'completion' : editOrigin(detail)
    clearTimeout(this.lineBreakTimer)
    this.lineBreak = isTypedLineBreak(event.contentChanges, origin)
      ? { uri, version: event.document.version, line: event.contentChanges[0]!.range.start.line + 1 } : undefined
    if (origin !== 'completion') { this.chain.clear(); this.chainSteps = 0 }
    if (event.reason) this.history.clear()
    const suppress = origin !== 'typing' || event.contentChanges.length > 1 || event.contentChanges.some(change => !change.text || change.text.length > 128)
    this.triggers.changed(uri, event.document.version, suppress)
    this.epoch++; this.request?.abort(); this.clearEdit(origin === 'completion' ? undefined : 'stale')
    if (!isCompletionSource(event.document.uri.path)) return
    for (const change of event.contentChanges) this.history.add(`f-${contentHash(uri)}`, previous.slice(change.rangeOffset, change.rangeOffset + change.rangeLength), change.text,
      origin, Date.now(), change.rangeOffset)
    if (origin === 'typing' || origin === 'paste') this.lastTyping = Date.now()
    if (this.lineBreak) {
      // v3 treated an indented new line as a fresh continuation. Recent rename
      // history and fresh incomplete-code diagnostics must not steal this lane.
      clearTimeout(this.timer)
      const opportunity = this.lineBreak
      this.lineBreakTimer = setTimeout(() => { void this.wakeLineBreak(opportunity) }, 350)
      return
    }
    if (!event.reason && !this.applying && !suppress && hasRecentReplacement(this.history.read(), `f-${contentHash(uri)}`) && this.api.window.activeTextEditor?.document === event.document) {
      this.predictionVersion = { uri, version: event.document.version }; this.schedule('edit')
    }
  }
  private isLineBreakDocument(document: vscode.TextDocument): boolean {
    return this.lineBreak?.uri === document.uri.toString() && this.lineBreak.version === document.version
  }
  private async wakeLineBreak(opportunity: NonNullable<CompletionFeature['lineBreak']>): Promise<void> {
    const editor = this.api.window.activeTextEditor
    if (this.lineBreak !== opportunity || !editor || !this.isLineBreakDocument(editor.document) ||
      editor.selection.active.line !== opportunity.line || !editor.selection.isEmpty || editor.selections.length !== 1 ||
      !this.enabled(editor.document) || editorSuggestionBlocked(opportunity.uri, true) || this.manualOperation ||
      this.pendingEdit || this.visibleItems.size || (this.request && !this.request.signal.aborted) ||
      (this.cache?.snapshot.document === editor.document && this.cache.snapshot.version === editor.document.version)) return
    if (this.transport.unavailable) { this.recovery = 'inline'; return }
    // One fallback per physical Enter, after selection/indentation settles. The
    // normal provider owns in-flight requests; never retry a completed empty result.
    this.registerInlineProvider()
    try { await this.api.commands.executeCommand('editor.action.inlineSuggest.trigger', { explicit: false }) }
    catch (error) { this.handleError(error) }
  }
  private schedule(trigger: 'edit' | 'accept' | 'diagnostic'): void {
    clearTimeout(this.timer)
    if (!this.capabilities?.modes.includes('next-edit') || this.chainSteps >= MAX_PREDICTION_CHAIN) return
    if (this.transport.unavailable) { this.recovery = trigger; return }
    const eagerness = this.config<string>('eagerness', 'standard'); const delay = eagerness === 'less' ? 1600 : eagerness === 'more' ? 650 : 1000
    this.timer = setTimeout(() => { void this.predict(trigger) }, Math.max(delay, 1500 - (Date.now() - this.lastNes)))
  }
  private async predict(trigger: SuggestionRequest['trigger']): Promise<boolean> {
    if (this.transport.unavailable) { this.recovery = trigger === 'accept' || trigger === 'diagnostic' ? trigger : 'edit'; return false }
    if (trigger !== 'manual' && this.manualOperation) return false
    if (trigger !== 'manual' && (this.visibleItems.size || this.request || this.pendingEdit)) return false
    clearTimeout(this.timer)
    const api = this.api; const editor = api.window.activeTextEditor
    if (!editor || !this.enabled(editor.document) || editorSuggestionBlocked(editor.document.uri.toString(), true) || !this.capabilities?.modes.includes('next-edit') || editor.selections.length !== 1 || !editor.selection.isEmpty || this.applying) return false
    if (!this.config('suggestInComments', true) && isInsideComment(editor.document.getText().slice(0, editor.document.offsetAt(editor.selection.active)))) return false
    if (this.capabilities.quota && !this.capabilities.quota.allowed) return false
    this.clearEdit('superseded'); this.cache = undefined; const epoch = ++this.epoch
    this.request?.abort(); const controller = new AbortController(); this.request = controller; this.lastNes = Date.now()
    try {
      const snapshot = await this.resolver.collect(editor.document, editor.selection.active, 'next-edit', trigger,
        this.config('nextEdit.extendedRange', true) && this.capabilities.features.extendedRange,
        this.config('autoImports', true) && this.capabilities.features.atomicAdditionalEdits,
        this.config('crossFile', true) && this.capabilities.features.crossFile)
      if (controller.signal.aborted || epoch !== this.epoch) return false
      this.requestSnapshot = { controller, snapshot }
      const importWindows = snapshot.request.documents[0]!.windows.filter(window => window.purpose === 'import' && window.allowedNewText?.length === 1)
      let result: SuggestionResult
      if ((trigger === 'diagnostic' || trigger === 'manual') && importWindows.length) {
        const edits = importWindows.map(window => ({ range: window.range, expectedText: window.text, newText: window.allowedNewText![0]! }))
        const primary = edits[0]!
        result = { protocolVersion: 2, requestId: snapshot.request.requestId, opportunityId: snapshot.request.opportunityId, completionId: 'local',
          suggestions: [{ candidateId: `local-${crypto.randomUUID()}`, fileId: snapshot.request.active.fileId, snapshotId: snapshot.request.active.snapshotId,
            kind: primary.expectedText ? 'edit' : 'insert', primary, additionalEdits: edits.slice(1) }], expiresInMs: 15_000, finishReason: 'complete' }
      } else result = await this.transport.suggest(snapshot.request, controller.signal)
      if (controller.signal.aborted || epoch !== this.epoch || api.window.activeTextEditor !== editor || !await this.resolver.isCurrent(snapshot)) return false
      this.recoveryAttempts = 0; this.capabilityError = ''; this.updateStatus()
      let candidate = result.suggestions[0]; if (!candidate) return false
      // Keep one model-approved local window as one atomic edit. In particular,
      // repeated references from an unambiguous rename should be previewed and
      // accepted together instead of forcing a distracting one-line chain.
      candidate = { ...candidate, primary: minimalEdit(candidate.primary) }
      if (result.completionId !== 'local' && this.config('autoImports', true) && this.capabilities.features.atomicAdditionalEdits) candidate = await this.resolver.withImports(snapshot, candidate)
      if (controller.signal.aborted || epoch !== this.epoch || !await this.resolver.isCurrent(snapshot)) return false
      const signature = this.signature(candidate)
      if (this.chain.has(signature) || (trigger !== 'manual' && (this.rejections.get(signature) ?? 0) > Date.now())) return false
      await api.commands.executeCommand('editor.action.inlineSuggest.hide')
      if (controller.signal.aborted || epoch !== this.epoch || !await this.resolver.isCurrent(snapshot)) return false
      this.pendingEdit = { snapshot, result, candidate, navigated: false, expiresAt: Date.now() + result.expiresInMs }
      this.renderEdit(); this.feedback(result, candidate, 'shown')
      this.expiry = setTimeout(() => this.clearEdit('stale'), result.expiresInMs)
      return true
    } catch (error) { if (this.transport.unavailable) this.recovery = trigger === 'accept' || trigger === 'diagnostic' ? trigger : 'edit'; this.handleError(error); return false }
    finally { if (this.request === controller) this.request = undefined; if (this.requestSnapshot?.controller === controller) this.requestSnapshot = undefined }
  }
  private renderEdit(): void {
    const plan = this.pendingEdit; if (!plan) return
    const editor = this.api.window.activeTextEditor
    const target = plan.target ?? plan.snapshot
    const crossFile = plan.candidate.fileId !== plan.snapshot.request.active.fileId && !plan.navigated
    const far = crossFile || editor?.document.uri.toString() !== target.document.uri.toString() || Math.abs((editor?.selection.active.line ?? 0) - plan.candidate.primary.range.start.line) > 5
    const collapsed = !plan.navigated && (far || this.config('nextEdit.showCollapsed', false))
    plan.partialAllowed ??= plan.candidate.kind === 'insert' && !!plan.snapshot.importBindings?.length &&
      !plan.snapshot.importChoices?.length && plan.snapshot.request.options.partialInsertAccept &&
      this.capabilities?.features.partialInsertAccept === true && this.capabilities.features.partialAcceptWithImports === true
    this.presentation.show(target, plan.candidate, collapsed, () => { void this.acceptEdit() }, () => this.clearEdit('rejected'),
      plan.snapshot.importChoices?.length ? () => { void this.chooseImport() } : undefined,
      plan.partialAllowed ? { word: () => { void this.acceptPartial('word') }, line: () => { void this.acceptPartial('line') } } : undefined)
    void this.api.commands.executeCommand('setContext', 'ailyNextEditAvailable', true)
    void this.api.commands.executeCommand('setContext', 'ailyPartialEditAvailable', plan.partialAllowed)
    if (far) this.feedback(plan.result, plan.candidate, 'jump_shown')
    this.updateStatus()
  }
  private async acceptEdit(): Promise<void> {
    if (this.accepting || this.navigation || this.applying) return
    this.accepting = true
    try { await this.performAcceptEdit() } finally { this.accepting = false }
  }
  private async performAcceptEdit(): Promise<void> {
    const plan = this.pendingEdit
    const snapshot = plan?.target ?? plan?.snapshot
    if (!plan || !snapshot || Date.now() > plan.expiresAt || !this.enabled(plan.snapshot.document) ||
      editorSuggestionBlocked(snapshot.document.uri.toString(), true) || !await this.resolver.isCurrent(snapshot) || this.pendingEdit !== plan) {
      this.clearEdit('stale'); return
    }
    const api = this.api; const editor = api.window.activeTextEditor
    const crossFile = plan.candidate.fileId !== plan.snapshot.request.active.fileId
    const far = (crossFile && !plan.navigated) || editor?.document.uri.toString() !== (plan.target ?? plan.snapshot).document.uri.toString() || Math.abs((editor?.selection.active.line ?? 0) - plan.candidate.primary.range.start.line) > 5
    if (!plan.navigated && (far || this.config('nextEdit.showCollapsed', false))) {
      const dependency = plan.snapshot.dependencies.find(dep => `f-${contentHash(dep.uri.toString())}` === plan.candidate.fileId)
      if (!dependency) { this.clearEdit('stale'); return }
      const navigation = { plan, uri: dependency.uri.toString() }; this.navigation = navigation
      try {
        const snapshot = crossFile ? await this.resolver.openTarget(plan.snapshot, plan.candidate) : plan.snapshot
        if (!snapshot || this.navigation !== navigation || this.pendingEdit !== plan || !this.enabled(snapshot.document)) { this.clearEdit('stale'); return }
        const target = await api.window.showTextDocument(snapshot.document, { preview: false })
        if (this.navigation !== navigation || this.pendingEdit !== plan || Date.now() > plan.expiresAt || !await this.resolver.isCurrent(snapshot)) { this.clearEdit('stale'); return }
        const start = new api.Position(plan.candidate.primary.range.start.line, plan.candidate.primary.range.start.character)
        target.selection = new api.Selection(start, start); target.revealRange(new api.Range(start, start), api.TextEditorRevealType.InCenterIfOutsideViewport)
        plan.target = snapshot; plan.navigated = true; this.feedback(plan.result, plan.candidate, 'jumped'); this.renderEdit()
      } catch (error) { console.debug('[aily-coder-editor] Aily Tab navigation cancelled:', error instanceof Error ? error.name : 'unavailable'); this.clearEdit('stale') }
      finally { setTimeout(() => { if (this.navigation === navigation) this.navigation = undefined }, 0) }
      return
    }
    this.applying = true
    try {
      const applied = applySuggestion(plan.target ?? plan.snapshot, plan.candidate)
      this.feedback(plan.result, plan.candidate, applied ? 'applied' : 'apply_failed', applied ? (plan.acceptedBase ?? 0) + plan.candidate.primary.newText.length : 0)
      this.clearEdit(); if (applied) { this.chain.add(this.signature(plan.candidate)); this.chainSteps++; this.schedule('accept') }
    } finally { this.applying = false }
  }
  private async acceptPartial(unit: 'word' | 'line'): Promise<void> {
    if (this.accepting || this.navigation || this.applying) return
    this.accepting = true
    try { await this.performPartialAccept(unit) } finally { this.accepting = false }
  }
  private async performPartialAccept(unit: 'word' | 'line'): Promise<void> {
    const plan = this.pendingEdit
    if (!plan?.partialAllowed || this.navigation || this.applying) return
    const snapshot = plan.target ?? plan.snapshot
    if (Date.now() > plan.expiresAt || !this.enabled(snapshot.document) || editorSuggestionBlocked(snapshot.document.uri.toString(), true) ||
      !await this.resolver.isCurrent(snapshot) || this.pendingEdit !== plan) { this.clearEdit('stale'); return }
    const count = partialLength(plan.candidate.primary.newText, unit)
    if (count === plan.candidate.primary.newText.length) { await this.performAcceptEdit(); return }
    const partial = planPartialImportAcceptance(snapshot.text, plan.candidate, snapshot.importBindings ?? [], count)
    this.applying = true
    try {
      if (!applySuggestion(snapshot, partial.applied)) { this.clearEdit('apply_failed'); return }
      const acceptedBase = (plan.acceptedBase ?? 0) + count
      this.feedback(plan.result, plan.candidate, 'partially_accepted', acceptedBase)
      const version = snapshot.document.version; const snapshotId = `${version}-${contentHash(partial.text)}`
      const candidate = { ...partial.remaining, snapshotId }
      const request = { ...snapshot.request,
        active: { ...snapshot.request.active, snapshotId, position: partial.point }, diagnostics: [],
        documents: snapshot.request.documents.map(doc => doc.fileId !== candidate.fileId ? doc : { ...doc, version, snapshotId,
          windows: [{ windowId: 'partial-active', purpose: 'completion' as const, range: candidate.primary.range, text: '' }] }) }
      const next: EditorSnapshot = { ...snapshot, request, version, text: partial.text, offset: partial.offset,
        importBindings: partial.bindings, diagnosticGenerations: [],
        dependencies: snapshot.dependencies.map(dep => dep.uri.toString() === snapshot.document.uri.toString() ? { ...dep, text: partial.text, version } : dep) }
      this.pendingEdit = { ...plan, snapshot: next, target: undefined, candidate, partialAllowed: true, acceptedBase }
      this.renderEdit(); this.expiry = setTimeout(() => this.clearEdit('stale'), Math.max(0, plan.expiresAt - Date.now()))
    } finally { this.applying = false }
  }
  private async chooseImport(): Promise<void> {
    const plan = this.pendingEdit
    if (!plan?.snapshot.importChoices?.length) return
    await this.runManual('选择导入来源…', async () => {
      const selected = await this.api.window.showQuickPick(plan.snapshot.importChoices!, { placeHolder: '语言服务发现多个来源，请选择工程中要使用的声明。' })
      if (!selected || this.pendingEdit !== plan || !await this.resolver.isCurrent(plan.snapshot)) return false
      const edits = [...plan.candidate.additionalEdits, ...selected.edits]
      if (edits.length > 2) return false
      plan.candidate = { ...plan.candidate, additionalEdits: edits }
      plan.snapshot.importBindings = [...(plan.snapshot.importBindings ?? []), { symbol: selected.symbol, edits: selected.edits }]
      plan.snapshot.importChoices = plan.snapshot.importChoices!.filter(choice => choice.symbol !== selected.symbol)
      plan.partialAllowed = undefined
      this.renderEdit(); return true
    })
  }
  private clearEdit(event?: FeedbackEvent): void {
    clearTimeout(this.expiry)
    if (this.pendingEdit && event) {
      this.feedback(this.pendingEdit.result, this.pendingEdit.candidate, event)
      if (event === 'rejected') { this.rejections.set(this.signature(this.pendingEdit.candidate), Date.now() + 30_000); clearTimeout(this.timer); this.chainSteps = MAX_PREDICTION_CHAIN }
    }
    this.pendingEdit = undefined; this.navigation = undefined; this.presentation.clear()
    void this.api.commands.executeCommand('setContext', 'ailyNextEditAvailable', false); this.updateStatus()
    void this.api.commands.executeCommand('setContext', 'ailyPartialEditAvailable', false)
  }
  private signature(candidate: Suggestion): string { return `${candidate.fileId}:${contentHash(JSON.stringify(candidate.primary))}` }
  private async runManual(label: string, operation: () => Promise<boolean>, emptyMessage?: string): Promise<void> {
    if (this.manualOperation) return
    clearTimeout(this.timer)
    this.request?.abort()
    completionCoordinator.cancel()
    this.epoch++
    this.manualEditor = this.api.window.activeTextEditor
    this.manualOperation = label; this.updateStatus()
    try {
      const completed = await operation()
      if (!completed && emptyMessage) await this.api.window.showInformationMessage(emptyMessage)
    } finally {
      this.manualOperation = ''; this.manualEditor = undefined; this.updateStatus()
    }
  }
  private async settings(): Promise<void> {
    const language = this.api.window.activeTextEditor?.document.languageId
    const selected = await this.api.window.showQuickPick([
      { label: '$(sparkle) 触发 Aily Tab', detail: 'Alt+\\；关联文件先按 Tab 跳转，再按 Tab 接受', action: 'trigger' },
      { label: this.config('crossFile', true) ? '关闭跨文件预测' : '启用跨文件预测', action: 'crossFile' },
      { label: '切换当前扩展名补全', action: 'extension' },
      { label: this.config('enabled', true) ? '关闭自动补全' : '启用自动补全', action: 'toggle' },
      { label: '选择暂停时长…', action: 'snooze' }, { label: '恢复自动补全', action: 'resume' },
      { label: `切换当前语言补全${language ? ` (${language})` : ''}`, action: 'language' },
      { label: '设置建议频率', action: 'frequency' }, { label: '更多设置', action: 'settings' }, { label: '重新连接服务', action: 'reconnect' },
    ], { placeHolder: 'Aily Tab · 续写、修改与关联文件预测' })
    if (!selected) return
    const config = this.api.workspace.getConfiguration('aily.completion'); const global = this.api.ConfigurationTarget.Global
    if (selected.action === 'toggle') await config.update('enabled', !this.config('enabled', true), global)
    else if (selected.action === 'crossFile') await config.update('crossFile', !this.config('crossFile', true), global)
    else if (selected.action === 'extension') {
      const extension = this.api.window.activeTextEditor?.document.uri.path.match(/\.[^/.]+$/)?.[0]?.toLowerCase()
      if (extension) { const values = this.config<string[]>('excludedExtensions', []); await config.update('excludedExtensions', values.includes(extension) ? values.filter(value => value !== extension) : [...values, extension], global) }
    }
    else if (selected.action === 'language' && language) { const languages = this.config<Record<string, boolean>>('languages', { '*': true }); await config.update('languages', { ...languages, [language]: !(languages[language] ?? languages['*'] ?? true) }, global) }
    else if (selected.action === 'frequency') { const frequency = await this.api.window.showQuickPick(['less', 'standard', 'more'], { placeHolder: '建议频率：少 / 标准 / 多' }); if (frequency) await config.update('eagerness', frequency, global) }
    else if (selected.action === 'settings') await this.api.commands.executeCommand('workbench.action.openSettings', 'aily.completion')
    else await this.api.commands.executeCommand(`aily.completion.${selected.action}`)
  }
  private async snooze(): Promise<void> {
    const selected = await this.api.window.showQuickPick([...AILY_TAB_SNOOZE_PRESETS], { placeHolder: '暂停 Aily Tab 多久？' })
    if (!selected) return
    const now = Date.now()
    this.snoozeUntil = ailyTabSnoozeDeadline(now, selected.durationMs)
    clearTimeout(this.snoozeTimer)
    this.snoozeTimer = setTimeout(() => { this.snoozeUntil = 0; this.updateStatus() }, selected.durationMs)
    this.invalidate('ignored'); this.updateStatus()
  }
  private handleError(error: unknown): void {
    if (error instanceof DOMException && error.name === 'AbortError') return
    this.capabilityError = error instanceof SuggestionError ? error.message : '编辑建议暂时不可用。'; this.updateStatus()
  }
  private invalidate(event: FeedbackEvent): void {
    this.recovery = undefined; this.predictionVersion = undefined
    this.lineBreak = undefined; clearTimeout(this.lineBreakTimer)
    this.visibleItems.clear()
    this.epoch++; this.request?.abort(); completionCoordinator.cancel(); clearTimeout(this.timer); this.cache = undefined; this.clearEdit(event)
    void this.api.commands.executeCommand('editor.action.inlineSuggest.hide')
  }
  private updateStatus(): void {
    if (!this.status) return
    try { this.renderStatus() } finally { setCompletionStatus(this.status.text, typeof this.status.tooltip === 'string' ? this.status.tooltip : '') }
  }
  private renderStatus(): void {
    const unavailable = this.transport.unavailable
    if (unavailable) {
      this.status.text = unavailable.status === 429 ? '$(watch) Aily Tab 稍后继续' : unavailable.status === 401 ? '$(account) Aily Tab 需登录' : unavailable.status === 402 || unavailable.status === 403 ? '$(lock) Aily Tab 额度或权限不足' : '$(watch) Aily Tab 正在恢复'
      this.status.tooltip = Number.isFinite(unavailable.retryAfterMs) ? `服务暂不可用，约 ${Math.ceil(unavailable.retryAfterMs / 1000)} 秒后自动继续最新补全。` : '请检查账户权限或额度后重新连接。'
      return
    }
    if (this.manualOperation) { this.status.text = `$(sync~spin) ${this.manualOperation}`; this.status.tooltip = '手动请求优先于后台预测，可继续输入以取消。'; return }
    if (this.pendingEdit) { const path = this.pendingEdit.snapshot.request.documents.find(doc => doc.fileId === this.pendingEdit!.candidate.fileId)?.relativePath ?? ''; this.status.text = `$(arrow-right) Tab → ${path}:${this.pendingEdit.candidate.primary.range.start.line + 1}`; this.status.tooltip = '定位并审阅下一处编辑建议，再按 Tab 接受。'; return }
    const document = this.api.window.activeTextEditor?.document
    if (Date.now() < this.snoozeUntil) {
      this.status.text = '$(debug-pause) Aily Tab 已暂停'
      this.status.tooltip = `约 ${ailyTabSnoozeRemaining(this.snoozeUntil)}后自动恢复；点击可更改暂停时长或立即恢复。`
      return
    }
    this.status.text = !this.config('enabled', true) || (document && !this.enabled(document)) ? '$(circle-slash) Aily Tab 已关闭' : this.capabilityError ? '$(warning) Aily Tab 不可用' : this.capabilities ? '$(sparkle) Aily Tab' : '$(sync~spin) Aily Tab 连接中'
    this.status.tooltip = this.capabilityError || (this.capabilities?.model
      ? `服务端模型：${this.capabilities.model.id}\nTab 接受 · Esc 拒绝 · 关联文件先跳转再接受`
      : '点击设置 Aily Tab：跨文件预测、按类型关闭和暂停')
    if (document && ['c', 'cpp', 'cuda-cpp', 'objective-cpp'].includes(document.languageId)) {
      const connected = getLanguageServerState() === 'ready'
      this.status.tooltip += connected ? (hasLanguageServerCompilationDatabase() === false ? '\nC/C++ 语言服务已连接；缺少工程编译配置，暂停自动诊断修复。' : '\nC/C++ 语言服务已连接。') : '\nC/C++ 语言服务未连接，诊断修复和来源验证暂不可用。'
      if (!connected && this.capabilities && !this.capabilityError && this.enabled(document)) this.status.text += ' · 语言服务未连接'
    }
  }
  dispose(): void { this.connectionEpoch++; clearTimeout(this.reconnectTimer); clearTimeout(this.snoozeTimer); this.invalidate('ignored'); this.transport.dispose(); this.status.dispose(); this.subscriptions.forEach(item => item.dispose()) }
}

function isInsideComment(prefix: string): boolean {
  const line = prefix.slice(prefix.lastIndexOf('\n') + 1)
  return /^\s*(?:\/\/|#(?!\s*(?:include|define|if|else|endif|pragma)\b))/.test(line) || prefix.lastIndexOf('/*') > prefix.lastIndexOf('*/')
}
