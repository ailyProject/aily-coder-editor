import { createInstance, EditorInput, IEditorService, StandaloneServices, type IEditorGroup, type IInstantiationService } from '@codingame/monaco-vscode-api'
import { URI } from '@codingame/monaco-vscode-api/vscode/vs/base/common/uri'
import { ExtensionHostKind, registerExtension } from '@codingame/monaco-vscode-api/extensions'
import { registerEditorPane, registerEditorSerializer, SimpleEditorInput, SimpleEditorPane, type IEditorSerializer } from '@codingame/monaco-vscode-workbench-service-override'
import type * as vscode from 'vscode'
import * as monaco from 'monaco-editor'
import { Emitter } from '@codingame/monaco-vscode-api/vscode/vs/base/common/event'
import { applyCppSession, createCppSession, loadCppSession, parseCppAsync, type PreviewDocument } from './cppBlockly/editorSession.js'
import { applySource } from './cppBlockly/applySource.js'
import { isCppPreviewFile, type CppPreview, type SourceLocation } from './cppBlockly/types.js'
import { discoverProjectLibraries, readLibraryHeaders, type LibraryFileSystem } from './cppBlockly/libraryCatalog.js'
import { IEditorGroupsService, GroupDirection } from '@codingame/monaco-vscode-api/services'
import { cppBlocklyPreviewEnabled } from './cppBlockly/devGate.js'

const COMMAND = 'aily.cpp.showBlocklyPreview'
const viteDev = (import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV === true
const linkedDev = document.querySelector('meta[name="aily-coder-dev-runtime"]')?.getAttribute('content') === 'true'
const previewEnabled = cppBlocklyPreviewEnabled(window.location.search, viteDev, linkedDev)
const savedSnapshots = new Map<string, string>()
const savedSnapshotChanges = new Emitter<vscode.Uri>()
const extension = previewEnabled ? registerExtension({
  name: 'aily-cpp-blockly-preview', publisher: 'aily', version: '1.0.0', engines: { vscode: '*' },
  contributes: {
    commands: [{ command: COMMAND, title: 'C++：打开 Blockly 转换预览', icon: '$(open-preview)' }],
    menus: {
      'editor/title': [{ command: COMMAND, when: "resourceExtname =~ /\\.(cpp|cc|cxx|ino|h|hpp|hh|hxx)$/i && resourceScheme != aily-cpp-preview && !isInDiffEditor", group: 'navigation@1' }],
      commandPalette: [{ command: COMMAND, when: "resourceExtname =~ /\\.(cpp|cc|cxx|ino|h|hpp|hh|hxx)$/i && resourceScheme != aily-cpp-preview" }]
    }
  }
}, ExtensionHostKind.LocalProcess, { system: true }) : undefined
const getApi = () => {
  if (!extension) throw new Error('Blockly 转换预览仅在开发模式可用。')
  return extension.getApi()
}

class CppPreviewInput extends SimpleEditorInput {
  readonly session = createCppSession()
  readonly updates = this._register(new Emitter<void>())
  private applying = false
  private lastDraft?: PreviewDocument
  private lastDraftResult?: CppPreview
  private savedText?: string
  private diffInput?: EditorInput
  private diffOpening?: Promise<void>
  private diffEpoch = 0
  sourceGroupId?: number
  private get savedUri(): URI { return URI.from({ scheme: 'aily-cpp-saved', path: this.source.path, query: this.source.toString() }) }
  matchesSourceText(text: string): boolean { return text === this.session.source?.text || text === this.lastDraft?.text }
  isSyncedDraft(document: PreviewDocument): boolean {
    return this.lastDraft?.text === document.text && this.lastDraft.version === document.version
  }
  resetDraft(): void { this.lastDraft = undefined; this.lastDraftResult = undefined }
  private async closeDraftDiff(): Promise<void> {
    const diff = this.diffInput
    if (!diff) return
    this.diffInput = undefined
    const groups = StandaloneServices.get(IEditorGroupsService)
    const group = groups.groups.find(item => item.contains(diff))
    if (!group) return
    if (group.activeEditor === diff) await StandaloneServices.get(IEditorService).openEditor({ resource: this.source, options: { pinned: true, preserveFocus: true } }, group)
    await group.closeEditor(diff, { preserveFocus: true })
  }
  private async showDraftDiff(): Promise<void> {
    if (this.diffOpening) return this.diffOpening
    const epoch = this.diffEpoch
    this.diffOpening = (async () => {
      const api = await getApi()
      if (this.savedText === undefined) {
        try { this.savedText = new TextDecoder().decode(await api.workspace.fs.readFile(api.Uri.parse(this.source.toString()))) }
        catch (error) { if ((error as {code?: string}).code === 'FileNotFound' || (error as {code?: string}).code === 'ENOENT') this.savedText = ''; else throw error }
      }
      if (this.isDisposed() || epoch !== this.diffEpoch) return
      const current = await this.readDocument()
      if (current.text === this.savedText) { await this.closeDraftDiff(); return }
      savedSnapshots.set(this.savedUri.toString(), this.savedText)
      const groups = StandaloneServices.get(IEditorGroupsService)
      const previewGroup = groups.groups.find(group => group.contains(this))
      const group = this.sourceGroupId === undefined ? undefined : groups.getGroup(this.sourceGroupId)
      const target = group ?? (previewGroup ? groups.findGroup({ direction: GroupDirection.LEFT }, previewGroup) : undefined)
      if (!target) return
      if (this.diffInput && target.activeEditor === this.diffInput) return
      await api.workspace.openTextDocument(api.Uri.parse(this.savedUri.toString()))
      if (this.isDisposed() || epoch !== this.diffEpoch) return
      const pane = await StandaloneServices.get(IEditorService).openEditor({
        original: { resource: this.savedUri }, modified: { resource: this.source },
        label: `${this.source.path.split('/').pop() ?? 'C++'} · 未保存更改`,
        options: { pinned: true, preserveFocus: true }
      }, target)
      this.diffInput = pane?.input
      const control = pane?.getControl() as monaco.editor.IDiffEditor | undefined
      if (control && typeof control.getModifiedEditor === 'function') control.updateOptions({ renderSideBySide: false, originalEditable: false, renderIndicators: true })
      if (epoch !== this.diffEpoch) await this.closeDraftDiff()
    })().finally(() => { this.diffOpening = undefined })
    return this.diffOpening
  }
  async sourceSaved(document: vscode.TextDocument): Promise<void> {
    this.savedText = document.getText(); ++this.diffEpoch
    savedSnapshots.set(this.savedUri.toString(), this.savedText)
    savedSnapshotChanges.fire((await getApi()).Uri.parse(this.savedUri.toString()))
    if (this.lastDraft?.text === this.savedText && this.lastDraftResult) {
      loadCppSession(this.session, { ...this.lastDraft, dirty: false }, this.lastDraftResult)
      this.resetDraft(); this.setDirty(false); this.updates.fire()
    }
    const current = await this.readDocument()
    if (current.text === this.savedText) await this.closeDraftDiff()
  }
  async syncDraft(code: string, revision: number): Promise<CppPreview | undefined> {
    if (this.applying) return
    const result = await parseCppAsync(code).promise
    if (revision !== this.session.revision || this.applying) return
    if (result.status === 'error') throw new Error(`源码暂未同步：${result.diagnostics.map(item => `L${item.line}:${item.column} ${item.message}`).join('；')}`)
    const api = await getApi()
    const model = monaco.editor.getModels().find(item => item.uri.toString() === this.source.toString())
    if (!model || api.workspace.fs.isWritableFileSystem(this.source.scheme) === false || monaco.editor.getEditors().some(editor => editor.getModel() === model && editor.getOption(monaco.editor.EditorOption.readOnly))) throw new Error('源码当前不可编辑。')
    if (revision !== this.session.revision || this.applying) return
    applySource(model, this.lastDraft ?? this.session.source!, code)
    this.lastDraft = { text: model.getValue(), version: model.getVersionId(), dirty: true }
    this.lastDraftResult = result
    await this.showDraftDiff()
    return result
  }
  async readDocument(): Promise<PreviewDocument> {
    const api = await getApi(), doc = await api.workspace.openTextDocument(api.Uri.parse(this.source.toString()))
    const model = monaco.editor.getModels().find(m => m.uri.toString() === this.source.toString())
    return { text: model?.getValue() ?? doc.getText(), version: model?.getVersionId() ?? doc.version, dirty: doc.isDirty }
  }
  async apply(): Promise<void> {
    if (this.applying) throw new Error('正在应用，请稍候。')
    this.applying = true
    try {
      await applyCppSession(this.session, code => parseCppAsync(code).promise, async (code, expected, stillCurrent) => {
        const api = await getApi()
        await api.workspace.openTextDocument(api.Uri.parse(this.source.toString()))
        const model = monaco.editor.getModels().find(m => m.uri.toString() === this.source.toString())
        if (!model || api.workspace.fs.isWritableFileSystem(this.source.scheme) === false || monaco.editor.getEditors().some(e => e.getModel() === model && e.getOption(monaco.editor.EditorOption.readOnly))) throw new Error('源码当前不可编辑。')
        if (!stillCurrent()) throw new Error('积木已继续变化，请重新应用当前修改。')
        applySource(model, this.lastDraft ?? expected, code)
        return { text: model.getValue(), version: model.getVersionId(), dirty: true }
      })
      this.resetDraft()
      this.setDirty(false); this.updates.fire()
      await this.showDraftDiff()
    } finally { this.applying = false }
  }
  async saveFromPreview(): Promise<boolean> {
    if (this.session.dirty) await this.apply()
    const api = await getApi(), doc = await api.workspace.openTextDocument(api.Uri.parse(this.source.toString()))
    return doc.save()
  }
  override async save(): Promise<EditorInput | undefined> {
    try { return await this.saveFromPreview() ? this : undefined }
    catch (error) { (await getApi()).window.showErrorMessage(String(error)); return undefined }
  }
  override async revert(): Promise<void> {
    this.resetDraft()
    Object.assign(this.session, createCppSession()); this.setDirty(false); this.updates.fire()
  }
  constructor(readonly source: URI) {
    super(URI.from({ scheme: 'aily-cpp-preview', path: source.path, query: source.toString() }))
    this.setName(`Blockly · ${source.path.split('/').pop() ?? 'C++'}`)
    this.setTitle(`Blockly 转换预览 — ${source.path}`)
  }
  get typeId(): string { return CppPreviewPane.ID }
  override matches(other: EditorInput): boolean {
    return other instanceof CppPreviewInput && other.source.toString() === this.source.toString()
  }
  override dispose(): void {
    ++this.diffEpoch
    void this.closeDraftDiff().finally(() => savedSnapshots.delete(this.savedUri.toString()))
    super.dispose()
  }
}

class CppPreviewPane extends SimpleEditorPane {
  static readonly ID = 'workbench.editors.ailyCppBlocklyPreview'
  constructor(group: IEditorGroup) { super(CppPreviewPane.ID, group) }
  initialize(): HTMLElement {
    const node = document.createElement('div')
    node.style.height = '100%'; node.style.width = '100%'
    return node
  }
  async renderInput(input: EditorInput, _options: unknown, _context: unknown, token: { isCancellationRequested: boolean }): Promise<{ dispose(): void }> {
    if (!(input instanceof CppPreviewInput)) return { dispose() {} }
    const [api, { mountCppPreview }] = await Promise.all([getApi(), import('./cppBlockly/previewView.js')])
    if (token.isCancellationRequested) return { dispose() {} }
    const uri = api.Uri.parse(input.source.toString())
    // Resolve from this document, rather than an unrelated active editor/folder.
    const project = api.workspace.getWorkspaceFolder(uri)
    const libraryFs = (): LibraryFileSystem => {
      const texts = new Map<string, Promise<string | undefined>>()
      const readText = (path: string): Promise<string | undefined> => {
        let pending = texts.get(path)
        if (!pending) {
          pending = project ? Promise.resolve(api.workspace.fs.readFile(api.Uri.joinPath(project.uri, path))).then(bytes => new TextDecoder().decode(bytes), error => {
            if (error?.code === 'FileNotFound' || error?.code === 'ENOENT') return undefined
            throw error
          }) : Promise.resolve(undefined)
          texts.set(path, pending)
        }
        return pending
      }
      return { readText, async readDirectory(path) {
        if (!project) return []
        try { return (await api.workspace.fs.readDirectory(api.Uri.joinPath(project.uri, path))).map(([name, type]) => ({ name, isDirectory: !!(type & api.FileType.Directory) })) }
        catch (error) { if ((error as { code?: string }).code === 'FileNotFound' || (error as { code?: string }).code === 'ENOENT') return []; throw error }
      } }
    }
    const read = () => api.workspace.openTextDocument(uri)
    const decorations = new Map<monaco.editor.ICodeEditor, monaco.editor.IEditorDecorationsCollection>()
    const sourceEditors = (): monaco.editor.ICodeEditor[] => monaco.editor.getEditors().filter(editor => {
      const node = editor.getDomNode()
      return editor.getModel()?.uri.toString() === input.source.toString() && !!node?.isConnected && node.getBoundingClientRect().width > 0 && node.getBoundingClientRect().height > 0
    })
    const highlight = (location?: SourceLocation): void => {
      for (const decoration of decorations.values()) decoration.clear()
      if (!location) return
      const range = new monaco.Range(location.line, location.column, location.endLine, location.endColumn)
      for (const editor of sourceEditors()) {
        if (!editor.getModel() || !input.matchesSourceText(editor.getModel()!.getValue())) continue
        let decoration = decorations.get(editor)
        if (!decoration) { decoration = editor.createDecorationsCollection(); decorations.set(editor, decoration) }
        decoration.set([{ range, options: { isWholeLine: !location.precise, className: 'cpp-blockly-source-highlight', linesDecorationsClassName: 'cpp-blockly-source-gutter', stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges } }])
        editor.revealRangeInCenterIfOutsideViewport(range, monaco.editor.ScrollType.Smooth)
      }
    }
    const reveal = async (location?: SourceLocation): Promise<void> => {
      const doc = await read()
      const selection = location ? new api.Range(location.line - 1, location.column - 1, location.endLine - 1, location.endColumn - 1) : undefined
      const visible = api.window.visibleTextEditors.find(editor => editor.document.uri.toString() === uri.toString())
      await api.window.showTextDocument(doc, { preview: false, ...(visible?.viewColumn ? { viewColumn: visible.viewColumn } : {}), ...(selection ? { selection } : {}) })
    }
    const root = document.createElement('div')
    this.container.replaceChildren(root)
    const view = mountCppPreview(root, {
      name: uri.path.split('/').pop() ?? 'C++',
      session: input.session,
      read: () => input.readDocument(),
      changed: dirty => input.setDirty(dirty),
      apply: () => input.apply(),
      save: () => input.saveFromPreview(),
      syncDraft: (code, revision) => input.syncDraft(code, revision),
      isSyncedDraft: document => input.isSyncedDraft(document),
      resetDraft: () => input.resetDraft(),
      onReset: refresh => input.updates.event(refresh),
      libraries: () => discoverProjectLibraries(libraryFs()),
      libraryHeaders: library => readLibraryHeaders(libraryFs(), library),
      onLibrariesChange(refresh) {
        if (!project) return { dispose() {} }
        const watchers = ['package.json', 'package-lock.json', 'node_modules/**', 'sketch/libraries/**'].map(pattern => api.workspace.createFileSystemWatcher(new api.RelativePattern(project, pattern)))
        const subscriptions = watchers.flatMap(watcher => [watcher.onDidCreate(refresh), watcher.onDidChange(refresh), watcher.onDidDelete(refresh)])
        return { dispose() { subscriptions.forEach(item => item.dispose()); watchers.forEach(watcher => watcher.dispose()) } }
      },
      reveal,
      highlight,
      onCursor(select) {
        const listeners = new Map<monaco.editor.ICodeEditor, monaco.IDisposable[]>()
        const attach = (editor: monaco.editor.ICodeEditor): void => {
          const update = (): void => {
            if (!editor.hasTextFocus() || !sourceEditors().includes(editor) || !editor.getModel() || !input.matchesSourceText(editor.getModel()!.getValue())) return
            const position = editor.getPosition()
            if (position) { highlight(); select({ line: position.lineNumber, column: position.column }) }
          }
          listeners.set(editor, [editor.onDidChangeCursorPosition(update), editor.onDidFocusEditorText(update), editor.onDidDispose(() => {
            listeners.get(editor)?.forEach(listener => listener.dispose()); listeners.delete(editor); decorations.delete(editor)
          })])
          update()
        }
        monaco.editor.getEditors().forEach(attach)
        const created = monaco.editor.onDidCreateEditor(attach)
        return { dispose() { created.dispose(); for (const list of listeners.values()) list.forEach(listener => listener.dispose()); listeners.clear() } }
      },
      onChange(refresh) {
        const changed = api.workspace.onDidChangeTextDocument(event => { if (event.document.uri.toString() === uri.toString()) refresh() })
        const saved = api.workspace.onDidSaveTextDocument(doc => { if (doc.uri.toString() === uri.toString()) void input.sourceSaved(doc).then(refresh).catch(error => api.window.showErrorMessage(String(error))) })
        return { dispose() { changed.dispose(); saved.dispose() } }
      }
    })
    return { dispose() { view.dispose(); for (const decoration of decorations.values()) decoration.clear(); decorations.clear(); root.remove() } }
  }
}

if (previewEnabled) {
  registerEditorPane('aily-cpp-blockly-preview-pane', 'Blockly 转换预览', CppPreviewPane, [CppPreviewInput])
  registerEditorSerializer(CppPreviewPane.ID, class implements IEditorSerializer {
    canSerialize(editor: EditorInput): boolean { return editor instanceof CppPreviewInput }
    serialize(editor: CppPreviewInput): string { return JSON.stringify({ source: editor.source.toJSON() }) }
    deserialize(instantiationService: IInstantiationService, serializedEditor: string): EditorInput | undefined {
      try {
        const { source: serializedSource } = JSON.parse(serializedEditor) as { source?: ReturnType<URI['toJSON']> }
        const source = URI.revive(serializedSource)
        return source && isCppPreviewFile(source.path) ? instantiationService.createInstance(CppPreviewInput, source) : undefined
      } catch { return undefined }
    }
  })

  void getApi().then(api => {
    api.workspace.registerTextDocumentContentProvider('aily-cpp-saved', {
      onDidChange: savedSnapshotChanges.event,
      provideTextDocumentContent: uri => savedSnapshots.get(uri.toString()) ?? ''
    })
    api.commands.registerCommand(COMMAND, async (resource?: vscode.Uri) => {
      const source = resource?.scheme ? resource : api.window.activeTextEditor?.document.uri
      if (!source || !isCppPreviewFile(source.path)) {
        await api.window.showInformationMessage('请先打开一个 C++ 源文件或头文件（.cpp、.cc、.cxx、.ino、.h、.hpp、.hh、.hxx）。')
        return
      }
      try {
        const editorService = StandaloneServices.get(IEditorService)
        const groups = StandaloneServices.get(IEditorGroupsService)
        const existing = editorService.editors.find(editor => editor instanceof CppPreviewInput && editor.source.toString() === source.toString())
        const input = existing ?? await createInstance(CppPreviewInput, URI.parse(source.toString()))
        // Use explicit RIGHT rather than SIDE_GROUP, which follows the user's
        // unrelated split-down preference. Reopening reuses the existing pair.
        const previewGroup = existing && groups.groups.find(group => group.contains(existing))
        const visibleSource = editorService.visibleEditorPanes.find(pane => pane.input?.resource?.toString() === source.toString())?.group
        const activePreview = groups.activeGroup.activeEditor instanceof CppPreviewInput ? groups.activeGroup : undefined
        const leftOfPreview = previewGroup || activePreview
        const sourceGroup = visibleSource ?? (leftOfPreview ? groups.findGroup({ direction: GroupDirection.LEFT }, leftOfPreview) : undefined) ?? groups.activeGroup
        ;(input as CppPreviewInput).sourceGroupId = sourceGroup.id
        const right = groups.findGroup({ direction: GroupDirection.RIGHT }, sourceGroup)
        const target = right ?? groups.addGroup(sourceGroup, GroupDirection.RIGHT)
        await editorService.openEditor({ resource: URI.parse(source.toString()), options: { pinned: true, preserveFocus: true } }, sourceGroup)
        if (previewGroup && previewGroup.id !== target.id) previewGroup.moveEditor(input, target)
        await editorService.openEditor(input, { pinned: true }, target)
        if (!right) {
          const sourceSize = groups.getSize(sourceGroup), targetSize = groups.getSize(target)
          groups.setSize(sourceGroup, { width: Math.max(300, Math.round((sourceSize.width + targetSize.width) * 0.36)), height: sourceSize.height })
        }
      } catch (error) { await api.window.showErrorMessage(`无法打开 Blockly 预览：${String(error)}`) }
    })
  })
}
