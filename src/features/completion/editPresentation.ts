import * as monaco from 'monaco-editor'
import { IContextKeyService, StandaloneServices } from '@codingame/monaco-vscode-api'
import { EditSources } from '@codingame/monaco-vscode-api/vscode/vs/editor/common/textModelEditSource'
import type { TextModel } from '@codingame/monaco-vscode-api/vscode/vs/editor/common/model/textModel'
import type { EditorSnapshot } from './suggestionContext'
import type { Suggestion, TextEdit } from './suggestionProtocol'
import { comparePosition } from './suggestionProtocol'
import { contentHash } from './completionState'
import styles from './completion.css?inline'
import { describeEditPreview, type PreviewHighlight } from './editPreview'
import { ailyTabInteractionBlocked } from './ailyTabControls'

const nativeRange = (edit: TextEdit) => new monaco.Range(edit.range.start.line + 1, edit.range.start.character + 1, edit.range.end.line + 1, edit.range.end.character + 1)
function markTextRanges(root: HTMLElement, ranges: readonly Omit<PreviewHighlight, 'line'>[]): void {
  const document = root.ownerDocument
  const showText = document.defaultView?.NodeFilter.SHOW_TEXT ?? 4
  for (const range of [...ranges].sort((a, b) => b.start - a.start)) {
    const walker = document.createTreeWalker(root, showText)
    let offset = 0; let node: Text | null
    while ((node = walker.nextNode() as Text | null)) {
      const next = offset + node.data.length
      if (range.start >= offset && range.end <= next) {
        if (range.end < next) node.splitText(range.end - offset)
        const selected = range.start > offset ? node.splitText(range.start - offset) : node
        const mark = document.createElement('span'); mark.className = 'aily-next-edit-added-token'
        selected.parentNode?.replaceChild(mark, selected); mark.append(selected)
        break
      }
      offset = next
    }
  }
}
/** Read editor-scoped state, including the Workbench's IME/snippet guards. */
export function editorSuggestionBlocked(uri: string, requireFocus = false): boolean {
  const editor = monaco.editor.getEditors().find(item => item.getModel()?.uri.toString() === uri && item.hasTextFocus())
    ?? monaco.editor.getEditors().find(item => item.getModel()?.uri.toString() === uri)
  const node = editor?.getDomNode()
  if (!editor || !node || (requireFocus && !editor.hasTextFocus())) return true
  const context = StandaloneServices.get(IContextKeyService).getContext(node)
  return ailyTabInteractionBlocked({
    isComposing: context.getValue('isComposing'),
    inSnippetMode: context.getValue('inSnippetMode'),
    suggestWidgetVisible: context.getValue('suggestWidgetVisible'),
  })
}
/** Synchronous model-level transaction: no await between checks and pushEditOperations. */
export function applySuggestion(snapshot: EditorSnapshot, candidate: Suggestion): boolean {
  const target = snapshot.request.documents?.find(doc => doc.fileId === candidate.fileId && doc.snapshotId === candidate.snapshotId && doc.permission === 'edit')
  if (!target || candidate.fileId !== `f-${contentHash(snapshot.document.uri.toString())}`) return false
  if (candidate.fileId !== snapshot.request.active.fileId && (!snapshot.request.options.crossFile || snapshot.request.mode !== 'next-edit')) return false
  const model = monaco.editor.getModels().find(item => item.uri.toString() === snapshot.document.uri.toString())
  if (!model || model.isDisposed() || model.getValue() !== snapshot.text || snapshot.document.getText() !== snapshot.text) return false
  if (monaco.editor.getEditors().some(editor => editor.getModel() === model && editor.getOption(monaco.editor.EditorOption.readOnly))) return false
  // Recheck every live dependency synchronously after the async filesystem check.
  for (const dependency of snapshot.dependencies) {
    const current = monaco.editor.getModels().find(item => item.uri.toString() === dependency.uri.toString())
    if (current && current.getValue() !== dependency.text) return false
  }
  const edits = [candidate.primary, ...candidate.additionalEdits]
  const sorted = [...edits].sort((a, b) => comparePosition(a.range.start, b.range.start))
  for (let index = 1; index < sorted.length; index++) {
    if (comparePosition(sorted[index - 1]!.range.end, sorted[index]!.range.start) >= 0) return false
  }
  for (const edit of edits) {
    const range = nativeRange(edit)
    if (!model.validateRange(range).equalsRange(range) || model.getValueInRange(range) !== edit.expectedText) return false
  }
  model.pushStackElement()
  // Preserve provenance through the asynchronous extension-host change event.
  // A controller boolean alone expires before that event can be delivered.
  const source = EditSources.inlineCompletionAccept({ nes: true, requestUuid: snapshot.request.requestId,
    languageId: snapshot.document.languageId, correlationId: candidate.candidateId })
  ;(model as unknown as TextModel).pushEditOperations(null,
    edits.map(edit => ({ range: nativeRange(edit), text: edit.newText, forceMoveMarkers: true })), () => null, undefined, source)
  model.pushStackElement()
  return true
}

/**
 * Pinned Workbench fallback for guarded edits. Its native inline-edit accept
 * path calls editor.edit before InlineCompletionItem.command, and its extension
 * bridge omits additionalTextEdits. A Tab binding alone cannot protect toolbar
 * acceptance, so all edit actions here share the synchronous transaction above.
 * Plain insert completions still use the native inline completion provider.
 */
export class EditPresentation {
  private editor?: monaco.editor.ICodeEditor
  private decorations?: monaco.editor.IEditorDecorationsCollection
  private zone?: string
  private portal?: monaco.editor.IOverlayWidget
  private content?: monaco.editor.IContentWidget
  private listeners: monaco.IDisposable[] = []
  private style?: HTMLStyleElement
  clear(): void {
    this.listeners.forEach(listener => listener.dispose()); this.listeners = []
    if (this.content && this.editor) this.editor.removeContentWidget(this.content)
    this.content = undefined
    if (this.portal && this.editor) this.editor.removeOverlayWidget(this.portal)
    this.portal = undefined
    this.decorations?.clear(); this.decorations = undefined
    if (this.zone && this.editor) { const zone = this.zone; this.editor.changeViewZones(accessor => accessor.removeZone(zone)) }
    this.zone = undefined; this.editor = undefined
    this.style?.remove(); this.style = undefined
  }
  show(snapshot: EditorSnapshot, candidate: Suggestion, collapsed: boolean, accept: () => void, reject: () => void, chooseImports?: () => void, partial?: { word: () => void; line: () => void }): void {
    this.clear()
    const editor = monaco.editor.getEditors().find(item => item.getModel()?.uri.toString() === snapshot.document.uri.toString() && item.hasTextFocus())
      ?? monaco.editor.getEditors().find(item => item.getModel()?.uri.toString() === snapshot.document.uri.toString())
    if (!editor) return
    this.editor = editor
    const target = snapshot.request.documents.find(doc => doc.fileId === candidate.fileId)
    const crossFile = candidate.fileId !== `f-${contentHash(snapshot.document.uri.toString())}`
    const targetText = crossFile ? snapshot.dependencies.find(dep => `f-${contentHash(dep.uri.toString())}` === candidate.fileId)?.text : snapshot.text
    const preview = describeEditPreview(targetText ?? candidate.primary.expectedText, candidate.primary)
    const portal = crossFile || collapsed
    const single = preview.singleLine && !candidate.additionalEdits.length && !chooseImports
    const tree = editor.getDomNode()?.getRootNode()
    this.style = document.createElement('style'); this.style.textContent = styles
    ;(tree instanceof ShadowRoot ? tree : document.head).appendChild(this.style)
    const font = editor.getOption(monaco.editor.EditorOption.fontInfo)
    const lineHeight = editor.getOption(monaco.editor.EditorOption.lineHeight)
    const root = document.createElement('div')
    root.className = `aily-next-edit-preview ${portal ? 'aily-tab-portal' : 'aily-next-edit-inline'} ${single ? 'aily-next-edit-single' : 'aily-next-edit-multiline'}`
    root.style.fontFamily = font.fontFamily; root.style.fontSize = `${font.fontSize}px`; root.style.lineHeight = `${lineHeight}px`
    root.setAttribute('role', 'region'); root.setAttribute('aria-label', `Aily Tab ${target?.relativePath ?? ''}:${candidate.primary.range.start.line + 1}`)
    const controls = document.createElement('div'); controls.className = 'aily-next-edit-actions'
    const button = (label: string, title: string, action: () => void) => {
      const node = document.createElement('button'); node.textContent = label; node.title = title; node.setAttribute('aria-label', title)
      node.onmousedown = event => event.preventDefault()
      node.onclick = event => { event.stopPropagation(); action() }; controls.append(node)
    }
    button(portal ? 'Tab ↗' : 'Tab', portal ? '跳转并预览修改' : '接受修改 (Tab)', accept)
    button('×', '拒绝修改 (Esc)', reject)
    if (chooseImports) button('选择来源', '选择导入来源', chooseImports)
    if (partial) { button('逐词', '接受下一个词', partial.word); button('逐行', '接受下一行', partial.line) }
    if (portal) {
      const header = document.createElement('div'); header.className = 'aily-next-edit-location'
      const label = document.createElement('span'); label.textContent = `${target?.relativePath ?? ''}:${candidate.primary.range.start.line + 1}`
      header.append(label, controls); root.append(header)
    }
    const body = document.createElement('div'); body.className = 'aily-next-edit-body'
    const code = document.createElement('pre'); code.className = 'aily-next-edit-code'
    const previewText = preview.after || '（删除此行）'
    // Use the current editor's tokenization/theme; "ghost" describes an
    // unaccepted edit, not a monochrome foreground color.
    const colorize = (node: HTMLElement, text: string) => {
      void monaco.editor.colorize(text, target?.languageId ?? snapshot.document.languageId,
        { tabSize: editor.getModel()!.getOptions().tabSize }).then(html => {
        if (node.isConnected && this.editor === editor) node.innerHTML = html.replace(/<br\s*\/?>(?:\s*)$/, '')
      }).catch(() => { /* Plain source remains readable if a grammar is unavailable. */ })
    }
    const renderCode = (node: HTMLElement, text: string, highlights: readonly PreviewHighlight[]) => {
      node.replaceChildren()
      for (const [line, value] of text.split('\n').entries()) {
        const row = document.createElement('span'); row.className = 'aily-next-edit-code-line'
        row.textContent = value || '\u200b'; node.append(row)
        if (value) void monaco.editor.colorize(value, target?.languageId ?? snapshot.document.languageId,
          { tabSize: editor.getModel()!.getOptions().tabSize }).then(html => {
            if (!row.isConnected || this.editor !== editor) return
            row.innerHTML = html.replace(/<br\s*\/?>(?:\s*)$/, '')
            markTextRanges(row, highlights.filter(item => item.line === line))
          }).catch(() => { markTextRanges(row, highlights.filter(item => item.line === line)) })
      }
    }
    renderCode(code, previewText, preview.after ? preview.afterHighlights : [{ line: 0, start: 0, end: previewText.length }])
    body.append(code)
    if (!portal) body.append(controls)
    root.append(body)
    if (candidate.additionalEdits.length) {
      const imports = document.createElement('pre'); imports.className = 'aily-next-edit-imports'
      imports.textContent = candidate.additionalEdits.map(edit => edit.newText.trimEnd() || '（删除）').join('\n')
      colorize(imports, imports.textContent)
      root.append(imports)
    }
    if (!crossFile) {
      const startLine = candidate.primary.range.start.line
      this.decorations = editor.createDecorationsCollection([
        { range: new monaco.Range(startLine + 1, 1, startLine + 1, 1), options: {
          linesDecorationsClassName: 'aily-next-edit-gutter', hoverMessage: { value: 'Tab 接受修改，Esc 拒绝。' },
        } },
        ...preview.beforeHighlights.map(highlight => ({
          range: new monaco.Range(startLine + highlight.line + 1, highlight.start + 1, startLine + highlight.line + 1, highlight.end + 1),
          options: { className: 'aily-next-edit-deleted-token', hoverMessage: { value: 'Tab 接受修改，Esc 拒绝。' } },
        })),
      ])
    }
    if (portal) {
      this.portal = { getId: () => 'aily.tab.portal', getDomNode: () => root,
        getPosition: () => ({ preference: monaco.editor.OverlayWidgetPositionPreference.BOTTOM_RIGHT_CORNER }) }
      editor.addOverlayWidget(this.portal)
    } else {
      const model = editor.getModel()!
      const position = new monaco.Position(candidate.primary.range.start.line + 1, 1)
      const proposedWidth = Math.min(620, Math.max(140, ...previewText.split('\n').map(line => line.length * font.typicalHalfwidthCharacterWidth + 16)))
      const geometry = () => {
        const layout = editor.getLayoutInfo(); const anchor = editor.getScrolledVisiblePosition(position)
        if (!anchor) return undefined
        let right = anchor.left
        for (let line = candidate.primary.range.start.line + 1; line <= preview.lastLine + 1; line++) {
          const point = editor.getScrolledVisiblePosition(new monaco.Position(line, model.getLineMaxColumn(line)))
          if (point) right = Math.max(right, point.left)
        }
        const available = layout.contentLeft + layout.contentWidth - right - 12
        return { offset: Math.max(font.typicalHalfwidthCharacterWidth * 2, right - anchor.left + font.typicalHalfwidthCharacterWidth * 2), available }
      }
      const initial = geometry()
      const inline = !!initial && initial.available >= Math.min(220, proposedWidth)
      if (inline) {
        root.style.width = `${Math.min(proposedWidth, initial.available)}px`
        root.style.transform = `translate(${initial.offset}px, -1px)`
        this.content = { getId: () => 'aily.tab.inlineEdit', getDomNode: () => root, suppressMouseDown: true,
          getPosition: () => ({ position, preference: [monaco.editor.ContentWidgetPositionPreference.EXACT] }),
          beforeRender: () => {
            const current = geometry()
            if (current) {
              root.style.width = `${Math.min(proposedWidth, current.available)}px`
              root.style.transform = `translate(${current.offset}px, -1px)`
            }
            return null
          } }
        editor.addContentWidget(this.content)
        this.listeners.push(editor.onDidLayoutChange(() => { if (this.content) editor.layoutContentWidget(this.content) }))
      } else {
        root.classList.remove('aily-next-edit-inline'); root.classList.add('aily-next-edit-stacked')
        const lines = previewText.split('\n').length + candidate.additionalEdits.reduce((total, edit) => total + edit.newText.trimEnd().split('\n').length, 0)
        editor.changeViewZones(accessor => { this.zone = accessor.addZone({ afterLineNumber: preview.lastLine + 1,
          heightInPx: lines * lineHeight + 8 + (candidate.additionalEdits.length ? 8 : 0), domNode: root, suppressMouseDown: true }) })
      }
    }
  }
}
