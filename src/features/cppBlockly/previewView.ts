import { Blockly, registerCppPreviewBlocks, updateFunctionDisplay } from './blocks.js'
import { indexBlocks, mergeScope } from './generator.js'
import { cppSourceChangeAction, loadCppSession, parseCppAsync, sessionCode, sessionRoots, type CppEditSession, type CppViewport, type PreviewDocument } from './editorSession.js'
import { previewError, type CppPreview, type CppVariable, type PreviewBlock, type SourceLocation } from './types.js'
import { cppQuickActions } from './quickItems.js'
import { cppToolbox } from './toolbox.js'
import { registerCppToolbox, mountToolboxSearch } from './toolboxUi.js'
import { cppIcon, type CppIcon } from './icons.js'
import { blockAtPosition, type SourcePosition } from './sourceSelection.js'
import previewCss from './preview.css?inline'
import { libraryCategory } from './libraryToolbox.js'
import { parseLibraryAsync } from './libraryWorker.js'
import type { ProjectLibrary, LibraryHeaders } from './libraryCatalog.js'
import { signatureLabel } from './beginnerCatalog.js'
import { onCppFieldFocus } from './fieldFocus.js'
import { fieldSourceLocation, parsedBlockId } from './fieldLocation.js'
import { annotateLibraryCalls, setLibraryEntries, type LibraryEntry } from './librarySelection.js'
import { rebaseProjection } from './rebaseProjection.js'
import { renameCppVariable, variableAtSpan } from './variables.js'

export interface PreviewHost {
  name: string
  session: CppEditSession
  read(): Promise<PreviewDocument>
  apply(): Promise<void>
  save(): Promise<boolean>
  syncDraft(code: string, revision: number): Promise<CppPreview | undefined>
  isSyncedDraft(document: PreviewDocument): boolean
  resetDraft(): void
  changed(dirty: boolean): void
  reveal(location?: SourceLocation): Promise<void>
  highlight(location?: SourceLocation): void
  onCursor(select: (position: SourcePosition) => void): { dispose(): void }
  onChange(refresh: () => void): { dispose(): void }
  onReset(refresh: () => void): { dispose(): void }
  libraries(): Promise<ProjectLibrary[]>
  libraryHeaders(library: ProjectLibrary): Promise<LibraryHeaders>
  onLibrariesChange(refresh: () => void): { dispose(): void }
}

let focusedPreviewWidget: HTMLElement | undefined

export function mountCppPreview(container: HTMLElement, host: PreviewHost): { dispose(): void } {
  registerCppPreviewBlocks(); registerCppToolbox()
  const session = host.session
  container.replaceChildren(); container.classList.add('cpp-blockly-preview')
  const element = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] => {
    const node = document.createElement(tag); node.className = className; node.textContent = text; return node
  }
  const button = (parent: HTMLElement, text: string, run: () => void): HTMLButtonElement => {
    const b = element('button', '', text); b.type = 'button'; b.onclick = run; parent.append(b); return b
  }
  const iconButton = (parent: HTMLElement, label: string, icon: CppIcon, run: () => void): HTMLButtonElement => {
    const b = button(parent, '', run); b.className = 'cpp-blockly-icon-button'; b.title = label
    b.setAttribute('aria-label', label); b.append(cppIcon(icon)); return b
  }
  const toolbar = element('div', 'cpp-blockly-toolbar')
  const identity = element('div', 'cpp-blockly-identity'); identity.append(cppIcon('blocks'))
  const filename = element('strong', '', host.name); filename.title = `${host.name} · Blockly`
  const badge = element('span', 'cpp-blockly-badge'); badge.setAttribute('role', 'img')
  identity.append(filename, badge); toolbar.append(identity)
  const scope = element('select', 'cpp-blockly-scope'); scope.setAttribute('aria-label', '查看函数或整个文件'); scope.title = '查看函数或整个文件'; scope.disabled = true
  toolbar.append(scope)
  const actions = element('div', 'cpp-blockly-actions'); actions.setAttribute('role', 'toolbar'); actions.setAttribute('aria-label', 'Blockly 编辑操作'); toolbar.append(actions)
  const navigation = element('div', 'cpp-blockly-action-group'), editing = element('div', 'cpp-blockly-action-group'), output = element('div', 'cpp-blockly-action-group')
  actions.append(navigation, editing, output)
  const status = element('div', 'cpp-blockly-status', '正在解析 C++…'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite')
  const canvas = element('div', 'cpp-blockly-canvas'); canvas.setAttribute('aria-label', '可编辑 C++ Blockly 积木画布')
  const inspector = element('div', 'cpp-blockly-inspector')
  const properties = element('details'); properties.append(element('summary', '', '积木属性'))
  const fields = element('div', 'cpp-blockly-fields'); properties.append(fields)
  const generated = element('details'); generated.append(element('summary', '', 'C++ 代码'))
  const code = element('textarea', 'cpp-blockly-code'); code.readOnly = true; code.setAttribute('aria-label', '生成的 C++ 源码'); generated.append(code)
  const diagnostics = element('div', 'cpp-blockly-diagnostics')
  inspector.append(diagnostics, properties, generated)
  container.append(element('style', '', previewCss), toolbar, canvas, status, inspector)
  const computed = getComputedStyle(container)
  const channels = computed.backgroundColor.match(/[\d.]+/g)?.slice(0, 3).map(Number) ?? [30, 30, 30]
  container.dataset.theme = channels.reduce((a, b) => a + b, 0) / 3 > 128 ? 'light' : 'dark'
  const uiColor = (name: string): string => computed.getPropertyValue(name).trim()
  const theme = Blockly.Theme.defineTheme('cpp-editor', {
    name: 'cpp-editor', base: Blockly.Themes.Classic,
    componentStyles: { workspaceBackgroundColour: uiColor('--cpp-workspace-bg'), toolboxBackgroundColour: uiColor('--cpp-toolbox-bg'), toolboxForegroundColour: computed.color, flyoutBackgroundColour: uiColor('--cpp-flyout-bg'), flyoutForegroundColour: computed.color, flyoutOpacity: 1, scrollbarColour: '#777777', scrollbarOpacity: 0.45 },
    fontStyle: { family: computed.fontFamily, size: 11 }
  })
  const workspace = Blockly.inject(canvas, {
    readOnly: false, toolbox: cppToolbox, trashcan: true, comments: false, disable: false,
    renderer: 'zelos', theme, scrollbars: true, sounds: false,
    move: { drag: true, wheel: true, scrollbars: true },
    zoom: { controls: false, wheel: true, startScale: 0.85, maxScale: 1.5, minScale: 0.25, scaleSpeed: 1.15 }
  })
  const toolboxSearch = mountToolboxSearch(canvas, workspace, variable => openVariableRename(variable))
  const renameForm = element('form', 'cpp-blockly-variable-rename'); renameForm.hidden = true
  const renameTitle = element('strong')
  const renameInput = element('input'); renameInput.type = 'text'; renameInput.setAttribute('aria-label', '新变量名'); renameInput.spellcheck = false
  const renameActions = element('div')
  const renameCancel = button(renameActions, '取消', () => { renameForm.hidden = true }); renameCancel.type = 'button'
  const renameConfirm = button(renameActions, '重命名全部引用', () => {}); renameConfirm.type = 'submit'
  renameActions.append(renameCancel, renameConfirm); renameForm.append(renameTitle, renameInput, renameActions); container.append(renameForm)
  let renameTarget: CppVariable | undefined
  function openVariableRename(variable: CppVariable): void {
    if (loading || conflict) return
    Blockly.hideChaff()
    renameTarget = variable; renameTitle.textContent = `${variable.scope} · ${variable.name} · ${Math.max(0, variable.references.length - 1)} 处使用`
    renameInput.value = variable.name; renameForm.hidden = false; renameInput.focus(); renameInput.select()
  }
  renameForm.onkeydown = event => {
    if (event.metaKey || event.ctrlKey) return
    event.stopPropagation()
    if (event.key === 'Escape') { renameForm.hidden = true; event.preventDefault() }
  }
  let disposed = false, loading = false, applying = false, conflict = false, revision = 0, liveSynced = false, syncedCode: string | undefined
  let libraryRevision = 0, libraryParse: ReturnType<typeof parseLibraryAsync> | undefined, libraryTimer: ReturnType<typeof setTimeout> | undefined
  let annotationTimer: ReturnType<typeof setTimeout> | undefined
  let currentLibraryEntries: LibraryEntry[] = session.libraryEntries ?? []
  setLibraryEntries(workspace, currentLibraryEntries)
  const annotateCalls = (): void => {
    clearTimeout(annotationTimer)
    if (disposed || !session.original || !session.source || session.dirty || !currentLibraryEntries.length) return
    if (workspace.isDragging() || Blockly.WidgetDiv.isVisible() || Blockly.DropDownDiv.getOwner()) { annotationTimer = setTimeout(annotateCalls, 150); return }
    const baseline = annotateLibraryCalls(session.original.blocks.blocks, session.source.text, currentLibraryEntries)
    const roots = annotateLibraryCalls(session.roots, session.source.text, currentLibraryEntries)
    if (baseline || roots) show(captureViewport())
  }
  const librariesNotice = (text: string): Blockly.utils.toolbox.StaticCategoryInfo => ({ kind: 'cppCategory', id: 'cpp-libraries', name: '项目库', contents: [{ kind: 'label', text }] } as Blockly.utils.toolbox.StaticCategoryInfo)
  async function refreshLibraries(): Promise<void> {
    const id = ++libraryRevision
    libraryParse?.cancel()
    const current = (): boolean => !disposed && id === libraryRevision
    try {
      const libraries = await host.libraries()
      if (!current()) return
      const entries: LibraryEntry[] = libraries.map(library => {
        const previous = currentLibraryEntries.find(entry => entry.library.id === library.id && entry.library.version === library.version)
        return { library, api: previous?.api }
      })
      currentLibraryEntries = entries
      session.libraryEntries = entries
      setLibraryEntries(workspace, entries)
      const categories = entries.map(entry => libraryCategory(entry.library, entry.api))
      toolboxSearch.update(categories.length ? categories : [librariesNotice('当前项目暂无已安装的库')])
      // One parser at a time keeps large library sets from flooding the UI thread.
      for (const [index, library] of libraries.entries()) {
        try {
          const headers = await host.libraryHeaders(library)
          if (!current()) return
          libraryParse = parseLibraryAsync(headers.headers)
          const api = await libraryParse.promise
          if (!current()) return
          entries[index] = { library, api }
          currentLibraryEntries = entries
          session.libraryEntries = entries
          setLibraryEntries(workspace, entries)
          categories[index] = libraryCategory(library, api, headers.notices)
          annotateCalls()
        } catch (error) {
          if (!current()) return
          categories[index] = libraryCategory(library, undefined, [`读取失败：${String(error)}；可点击“刷新项目库”重试`])
        }
        toolboxSearch.update(categories)
      }
    } catch (error) { if (current()) toolboxSearch.update([librariesNotice(`读取项目库失败：${String(error)}；请刷新重试`)]) }
  }
  iconButton(navigation, '刷新项目库', 'blocks', () => { void refreshLibraries() })
  toolboxSearch.update([librariesNotice('正在读取当前项目已安装的库…')])
  const librarySubscription = host.onLibrariesChange(() => {
    clearTimeout(libraryTimer)
    libraryTimer = setTimeout(() => { if (!disposed) void refreshLibraries() }, 400)
  })
  void refreshLibraries()
  let parse: ReturnType<typeof parseCppAsync> | undefined, timer: ReturnType<typeof setTimeout> | undefined, syncTimer: ReturnType<typeof setTimeout> | undefined
  let selectedId: string | undefined, shownScope = session.scope
  let activeField: { blockId: string; name: string } | undefined
  let fieldParse: ReturnType<typeof parseCppAsync> | undefined, fieldFocusRevision = 0
  let lastCapturedCode: string | undefined
  let sourceCursor: SourcePosition | undefined
  let selectedLocation: SourceLocation | undefined
  let sourceIds = new Map<string, string>()
  let workspaceIds = new Map<string, string>()
  const sourceId = (id: string): string => sourceIds.get(id) ?? id
  const workspaceId = (id: string): string => workspaceIds.get(id) ?? id
  const highlightField = (block: Blockly.Block, name: string): void => {
    focusedPreviewWidget = container
    activeField = { blockId: block.id, name }
    const focus = ++fieldFocusRevision
    fieldParse?.cancel()
    if (conflict || !session.source || !session.original) return
    let currentCode: string
    try { currentCode = sessionCode(session) } catch { host.highlight(fieldSourceLocation(session.source.text, session.original, sourceId(block.id), name)); return }
    if (currentCode === session.source.text) { host.highlight(fieldSourceLocation(session.source.text, session.original, sourceId(block.id), name)); return }
    host.highlight()
    fieldParse = parseCppAsync(currentCode)
    void fieldParse.promise.then(result => {
      if (!disposed && focus === fieldFocusRevision) {
        const id = parsedBlockId(sessionRoots(session), result.blocks.blocks, block.id)
        host.highlight(id ? fieldSourceLocation(currentCode, result, id, name) : undefined)
      }
    }).catch(() => { /* A newer field focus or incomplete draft superseded this parse. */ })
  }
  const stopFieldFocus = onCppFieldFocus(workspace, highlightField)
  const fail = (error: unknown): void => { status.dataset.state = 'error'; status.textContent = error instanceof Error ? error.message : String(error) }
  const reveal = (location?: SourceLocation): void => { void host.reveal(location).catch(fail) }
  const summary = (): void => {
    const result = session.original
    badge.dataset.dirty = String(session.dirty)
    badge.title = session.dirty ? liveSynced ? '字段已同步到源码缓冲区；可继续编辑或保存' : '有未应用的积木修改' : '可编辑 · 已与源码同步'
    badge.setAttribute('aria-label', badge.title)
    undo.disabled = !workspace.getUndoStack().length
    redo.disabled = !workspace.getRedoStack().length
    apply.disabled = loading || applying || conflict || !session.dirty || result?.status === 'error'
    if (conflict) { fail('源码已变化，当前积木草稿已保留。可查看并复制生成代码，或重新载入源码。'); return }
    status.dataset.state = result?.status ?? 'loading'
    const visibleCount = workspace.getAllBlocks(false).length
    status.textContent = result?.status === 'error' ? '无法转换，请修正下方源码问题。' : `${session.scope ? result?.blockCount ?? 0 : visibleCount} 个积木${session.scope ? ` · 当前 ${visibleCount} 个` : ' · 整个文件'}${result?.dataCount ? ` · ${result.dataCount} 处数据折叠` : ''}${session.dirty ? liveSynced ? ' · 已同步到左侧源码缓冲区' : ' · 草稿尚未应用' : session.source?.dirty ? ' · 源码未保存' : ''}`
    status.title = '从 toolbox 拖入积木；点击字段编辑，复杂原文可在积木属性中编辑。'
  }
  const capture = (): void => {
    if (loading || disposed || !session.original) return
    let previousCode = lastCapturedCode
    if (previousCode === undefined) { try { previousCode = sessionCode(session) } catch { /* An incomplete draft has no prior code. */ } }
    const state = Blockly.serialization.workspaces.save(workspace)
    session.view = (state.blocks?.blocks ?? []) as PreviewBlock[]
    // Scope roots are pinned only for navigation, never persisted as immutable.
    if (session.scope && session.view[0]) { delete (session.view[0] as PreviewBlock & {movable?: boolean}).movable; delete (session.view[0] as PreviewBlock & {deletable?: boolean}).deletable }
    try {
      const currentCode = sessionCode(session)
      if (currentCode !== previousCode) session.revision++
      lastCapturedCode = currentCode
      session.dirty = currentCode !== session.source?.text; liveSynced = currentCode === syncedCode
    } catch { session.revision++; lastCapturedCode = undefined; session.dirty = true; liveSynced = false }
    host.changed(session.dirty); summary()
    if (generated.open) previewCode()
  }
  const previewCode = (): void => {
    try { code.value = sessionCode(session); code.classList.remove('cpp-blockly-code-error') }
    catch (error) { code.value = error instanceof Error ? error.message : String(error); code.classList.add('cpp-blockly-code-error') }
  }
  let shortcutSaving = false, saveTimer: ReturnType<typeof setTimeout> | undefined
  const saveShortcut = (event: KeyboardEvent): void => {
    if (event.key.toLowerCase() !== 's' || !(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return
    const widget = Blockly.WidgetDiv.getDiv()
    const path = event.composedPath()
    const editingBlockField = !!widget && path.includes(widget) && focusedPreviewWidget === container
    if (!path.includes(container) && !editingBlockField) return
    event.preventDefault(); event.stopImmediatePropagation()
    if (shortcutSaving) return
    shortcutSaving = true
    if (editingBlockField) Blockly.WidgetDiv.hide()
    if (syncTimer) { clearTimeout(syncTimer); syncTimer = undefined }
    // Blockly queues the final field-change event when its editor closes.
    saveTimer = setTimeout(() => {
      saveTimer = undefined
      if (disposed) return
      capture()
      void host.save().then(saved => { if (!saved) fail('保存未完成，请重试。') }).catch(fail).finally(() => { shortcutSaving = false })
    }, 0)
  }
  window.addEventListener('keydown', saveShortcut, true)
  const syncField = (): void => {
    if (loading || disposed || conflict || !session.original) return
    if (syncTimer) clearTimeout(syncTimer)
    const currentRevision = session.revision
    let currentCode: string
    try { currentCode = sessionCode(session) } catch(error) { fail(error); return }
    syncTimer = setTimeout(() => {
      syncTimer = undefined
      void host.syncDraft(currentCode, currentRevision).then(result => {
        if (!disposed && currentRevision === session.revision && result) { syncedCode = currentCode; liveSynced = true; toolboxSearch.updateVariables(result.variables ?? []); summary(); const focused = activeField && workspace.getBlockById(activeField.blockId); if (focused && activeField) highlightField(focused, activeField.name) }
      }).catch(error => { if (!disposed && currentRevision === session.revision) fail(error) })
    }, 150)
  }
  iconButton(navigation, '返回源码', 'source', () => { capture(); reveal() })
  iconButton(navigation, '重新载入', 'refresh', () => {
    if (!session.dirty || liveSynced) { void refresh(); return }
    // Inline, explicit discard action protects the draft without native dialogs.
    discard.hidden = false; fail('重新载入将放弃未应用的积木修改。点击“放弃草稿并载入”继续，或继续编辑。')
  })
  const discard = button(inspector, '放弃草稿并载入', () => { discard.hidden = true; session.dirty = false; session.view = undefined; host.changed(false); void refresh() }); discard.hidden = true
  const undo = iconButton(editing, '撤销', 'undo', () => workspace.undo(false))
  const redo = iconButton(editing, '重做', 'redo', () => workspace.undo(true))
  iconButton(editing, '适应画布', 'fit', () => { Blockly.svgResize(workspace); workspace.zoomToFit() })
  iconButton(output, '生成 C++', 'preview', () => { capture(); generated.open = true; properties.open = false; previewCode(); Blockly.svgResize(workspace) })
  const apply = iconButton(output, '应用到源码', 'apply', () => {
    if (syncTimer) clearTimeout(syncTimer)
    capture(); applying = true; summary()
    void host.apply().then(() => { if (!disposed) { conflict = false; status.textContent = '已应用到源码缓冲区；可返回源码撤销，按 ⌘S 保存。' } }).catch(fail).finally(() => { applying = false; apply.disabled = !session.dirty || conflict })
  }); apply.classList.add('cpp-blockly-primary'); apply.disabled = true

  const showProperties = (block?: Blockly.Block): void => {
    if (selectedId && selectedId !== block?.id) workspace.getBlockById(selectedId)?.removeSelect()
    fields.replaceChildren(); selectedId = block?.id
    selectedLocation = block && session.original?.locations[sourceId(block.id)]
    if (!block) return
    const help = block.getTooltip()
    if (help) fields.append(element('p', 'cpp-blockly-field-help', help))
    const location = session.original?.locations[sourceId(block.id)]
    if (location) button(fields, `定位源码 L${location.line}`, () => reveal(location))
    const names: Record<string, string> = { TYPE: block.type === 'cpp_preview_function' ? '返回类型' : '数据类型', QUALIFIERS: block.type === 'cpp_preview_function' ? '函数修饰符' : '变量用途', TEXT: block.type === 'cpp_preview_text' ? '文字内容' : '值 / 原文', NAME: block.type === 'cpp_preview_action' ? '操作方式' : '函数名', LIBRARY: '项目库', METHOD: '调用方法', RECEIVER: '对象名', SIGNATURE: '函数定义', PARAMETERS: '函数参数', SUFFIX: '函数后缀', DECL: '变量名称 / 数组', OP: '运算方式', MODE: '循环方式', COUNTER: '计数变量', BEFORE: '前缀', AFTER: '后缀', HEADER: '完整 C++ 规则', FOOTER: '结束规则', CODE: '完整数据', MEMBER: '成员', OPEN: '开始符号', CLOSE: '结束符号' }
    for (const input of block.inputList) for (const field of input.fieldRow) {
      if (!field.name || !field.SERIALIZABLE || field.name === 'INIT' || (field.name === 'TYPE' && !field.getValue()) || (block.type === 'cpp_preview_data' && field.name === 'TEXT') || (block.type === 'cpp_preview_library_call' && (field.name === 'NAME' || field.name === 'RECEIVER' && !field.isVisible())) || (block.type === 'cpp_preview_function' && (field.name === 'MODE' || (block.getFieldValue('MODE') === 'raw') !== (field.name === 'SIGNATURE')))) continue
      const label = element('label', '', names[field.name] ?? field.name)
      if (field instanceof Blockly.FieldDropdown) {
        const edit = element('select'); edit.setAttribute('aria-label', names[field.name] ?? field.name)
        for (const option of field.getOptions(false)) {
          if (typeof option === 'string') continue
          const item = element('option', '', typeof option[0] === 'string' ? option[0] : option[1]); item.value = option[1]; edit.append(item)
        }
        edit.value = String(field.getValue() ?? '')
        edit.onfocus = () => highlightField(block, field.name!)
        edit.onchange = () => { field.setValue(edit.value); capture(); syncField(); highlightField(block, field.name!) }
        label.append(edit); fields.append(label); continue
      }
      const edit = element('textarea'); edit.value = String(field.getValue() ?? ''); edit.rows = edit.value.includes('\n') ? 3 : 1; edit.spellcheck = false
      edit.setAttribute('aria-label', names[field.name] ?? field.name)
      edit.onfocus = () => highlightField(block, field.name!)
      edit.oninput = () => { field.setValue(edit.value); capture(); syncField(); highlightField(block, field.name!) }
      label.append(edit); fields.append(label)
    }
    for (const action of cppQuickActions(block)) {
      const control = button(fields, action.label, () => { action.run(); capture(); showProperties(block) })
      control.disabled = !action.enabled
    }
    if (block.type === 'cpp_preview_variable') {
      const recipe = session.original?.recipes?.[sourceId(block.id)]
      const variable = recipe && variableAtSpan(session.original?.variables ?? [], recipe)
      if (variable) button(fields, `批量重命名 ${variable.name}`, () => openVariableRename(variable))
    }
  }
  const highlightBlock = (block?: Blockly.Block): void => {
    if (!block || block.id !== activeField?.blockId) activeField = undefined
    if (block && activeField?.blockId === block.id) { highlightField(block, activeField.name); return }
    if (conflict) { host.highlight(); return }
    // New draft blocks have no source yet; show their nearest mapped container.
    let location: SourceLocation | undefined
    for (let current = block; current && !location; current = current.getSurroundParent() ?? undefined) location = session.original?.locations[sourceId(current.id)]
    host.highlight(location)
  }
  const selectSource = (position: SourcePosition): void => {
    sourceCursor = position
    activeField = undefined; ++fieldFocusRevision; fieldParse?.cancel()
    if (disposed || loading || conflict || !session.original) return
    const id = blockAtPosition(session.original.locations, position)
    let block = id ? workspace.getBlockById(workspaceId(id)) : null
    if (id && !block && session.scope) {
      try {
        capture(); session.roots = mergeScope(session.roots, shownScope, session.view ?? [])
        session.scope = ''; session.view = undefined; show(); block = workspace.getBlockById(id)
      } catch { return }
    }
    Blockly.Events.disable()
    try {
      if (block) { block.select(); workspace.scrollBoundsIntoView(block.getBoundingRectangleWithoutChildren(), 28) }
      else workspace.getBlockById(selectedId ?? '')?.unselect()
      showProperties(block ?? undefined)
    } finally { Blockly.Events.enable() }
  }
  const populateScopes = (): void => {
    const current = indexBlocks(session.roots)
    scope.replaceChildren()
    const option = (id: string, label: string): void => { const o = element('option', '', label); o.value = id; scope.append(o) }
    option('', '整个文件')
    const units = [...current.values()].filter(b => b.type === 'cpp_preview_function' || b.type === 'cpp_preview_lambda' || (b.type === 'cpp_preview_container' && /^(namespace|class|struct|template)\b/.test(b.fields?.HEADER ?? '')))
    for (const b of units) option(b.id, `L${session.original?.locations[b.id]?.line ?? '新'} · ${b.type === 'cpp_preview_lambda' ? '回调 ' : ''}${signatureLabel(b.fields?.MODE === 'structured' ? `${b.fields?.TYPE} ${b.fields?.NAME}(${b.fields?.PARAMETERS ?? ''})` : b.fields?.SIGNATURE ?? b.fields?.HEADER ?? '').replace(/\s+/g, ' ').slice(0, 100)}`)
    if (session.scope && !current.has(session.scope)) session.scope = ''
    scope.value = session.scope; scope.disabled = session.original?.status === 'error'
  }
  const captureViewport = (): CppViewport => ({
    scale: workspace.scale, x: workspace.scrollX, y: workspace.scrollY,
    roots: workspace.getTopBlocks(false).map(block => block.getRelativeToSurfaceXY())
  })
  const show = (viewport?: CppViewport): void => {
    activeField = undefined; ++fieldFocusRevision; fieldParse?.cancel()
    lastCapturedCode = undefined
    selectedId = undefined; selectedLocation = undefined
    sourceIds.clear(); workspaceIds.clear()
    host.highlight()
    loading = true
    try {
      if (session.original && session.source && !session.dirty) {
        annotateLibraryCalls(session.original.blocks.blocks, session.source.text, currentLibraryEntries)
        annotateLibraryCalls(session.roots, session.source.text, currentLibraryEntries)
      }
      Blockly.Events.disable()
      workspace.clear(); workspace.clearUndo(); fields.replaceChildren(); diagnostics.replaceChildren()
      populateScopes(); shownScope = session.scope
      const selected = indexBlocks(session.roots).get(session.scope)
      const roots = session.view ?? (selected ? [{ ...selected, next: undefined }] : session.roots)
      Blockly.serialization.workspaces.load({blocks: { languageVersion: 0, blocks: roots }}, workspace)
      for (const block of workspace.getAllBlocks(false)) updateFunctionDisplay(block)
      if (selected) { const block = workspace.getBlockById(selected.id); block?.setDeletable(false); block?.setMovable(false) }
      if (viewport || !session.view) {
        let y = 24
        for (const [index, root] of roots.entries()) {
          const block = workspace.getBlockById(root.id)
          if (block) {
            const position = block.getRelativeToSurfaceXY()
            const target = viewport?.roots[index] ?? {x: 24, y}
            block.moveBy(target.x - position.x, target.y - position.y)
            y += block.getHeightWidth().height + 36
          }
        }
      }
      for (const b of workspace.getAllBlocks(false)) {
        const loc = session.original?.locations[b.id]
        if (loc) b.setTooltip(`第 ${loc.line} 行 · 在下方属性中查看完整值或定位源码`)
      }
      for (const item of session.original?.diagnostics ?? []) button(diagnostics, `L${item.line}:${item.column} · ${item.message}`, () => reveal(item))
    } catch(error) { fail(error) }
    finally { Blockly.Events.enable(); loading = false }
    Blockly.svgResize(workspace)
    if (viewport) { workspace.setScale(viewport.scale); workspace.scroll(viewport.x, viewport.y) }
    else if (!session.view) { workspace.zoomToFit(); if (workspace.scale < 0.65) { workspace.setScale(0.85); workspace.scroll(0, 0) } }
    toolboxSearch.updateVariables(session.original?.status === 'error' ? [] : session.original?.variables ?? [])
    summary(); if (generated.open) previewCode()
  }
  const rebaseVisible = (): boolean => {
    if (!session.original || !session.source || session.scope || session.original.status === 'error') return false
    annotateLibraryCalls(session.original.blocks.blocks, session.source.text, currentLibraryEntries)
    annotateLibraryCalls(session.roots, session.source.text, currentLibraryEntries)
    const visible = Blockly.serialization.workspaces.save(workspace).blocks?.blocks as PreviewBlock[] | undefined
    const rebased = visible && rebaseProjection(visible, session.original.blocks.blocks)
    if (!rebased) return false
    try {
      if (sessionCode({...session, view: rebased.view}) !== session.source.text) return false
    } catch { return false }
    const rebasedBlocks = indexBlocks(rebased.view)
    Blockly.Events.disable()
    try {
      for (const [id, source] of rebased.sourceIds) {
        const block = workspace.getBlockById(id)
        if (block) {
          const updated = rebasedBlocks.get(id)
          block.data = updated?.data ?? null
          for (const [name, value] of Object.entries(updated?.fields ?? {})) {
            const field = block.getField(name)
            if (field && field.getValue() !== value) field.setValue(value)
          }
          const location = session.original.locations[source]
          if (location) block.setTooltip(`第 ${location.line} 行 · 在下方属性中查看完整值或定位源码`)
        }
      }
    } finally { Blockly.Events.enable() }
    sourceIds = rebased.sourceIds
    workspaceIds = new Map([...sourceIds].map(([id, source]) => [source, id]))
    session.view = rebased.view
    lastCapturedCode = session.source.text
    workspace.clearUndo()
    if (selectedId) selectedLocation = session.original.locations[sourceId(selectedId)]
    toolboxSearch.updateVariables(session.original.variables ?? [])
    summary(); if (generated.open) previewCode()
    const selected = selectedId && workspace.getBlockById(selectedId)
    const focused = activeField && workspace.getBlockById(activeField.blockId)
    if (focused && activeField) highlightField(focused, activeField.name)
    else if (selected) highlightBlock(selected)
    else host.highlight()
    return true
  }
  workspace.addChangeListener(event => {
    if (disposed || loading) return
    if (event.type === Blockly.Events.SELECTED) {
      const id = (event as Blockly.Events.Selected).newElementId
      const selected = id ? workspace.getBlockById(id) ?? undefined : undefined
      // Blockly deselects the block when focus moves into its field editor.
      if (!selected && activeField && (Blockly.WidgetDiv.isVisible() || Blockly.DropDownDiv.getOwner())) return
      showProperties(selected)
      highlightBlock(selected)
    } else if (!event.isUiEvent) {
      capture()
      // Method selection can also resize arguments; sync the final event revision.
      syncField()
      // Deserialization and async library annotation change fields too. Only an
      // explicit selection or field focus should paint the source editor.
      const selected = selectedId ? workspace.getBlockById(selectedId) : null
      if (selected) highlightBlock(selected)
      // Inline field edits also refresh the complete-value inspector.
      if (selectedId && !fields.contains(container.getRootNode() instanceof ShadowRoot ? (container.getRootNode() as ShadowRoot).activeElement : document.activeElement)) showProperties(workspace.getBlockById(selectedId) ?? undefined)
    }
  })
  scope.onchange = () => {
    const target = scope.value
    try {
      capture()
      session.roots = mergeScope(session.roots, shownScope, session.view ?? [])
      session.view = undefined; session.scope = target; show()
    } catch(error) { scope.value = shownScope; fail(error) }
  }
  async function refresh(): Promise<void> {
    const id = ++revision
    const viewport = session.original ? captureViewport() : undefined
    parse?.cancel(); loading = true; scope.disabled = true; apply.disabled = true
    status.textContent = '正在解析 C++…'; status.dataset.state = 'loading'
    const old = indexBlocks(session.roots).get(session.scope)
    const oldLocation = old && session.original?.locations[old.id]
    try {
      const source = await host.read()
      if (disposed || revision !== id) return
      parse = parseCppAsync(source.text)
      const result = await parse.promise
      if (disposed || revision !== id) return
      loadCppSession(session, source, result); host.resetDraft(); conflict = false; liveSynced = false; syncedCode = undefined; host.changed(false)
      annotateLibraryCalls(session.original!.blocks.blocks, source.text, currentLibraryEntries)
      annotateLibraryCalls(session.roots, source.text, currentLibraryEntries)
      if (old) {
        const matches = [...indexBlocks(session.roots).values()].filter(b => b.type === old.type && (b.fields?.SIGNATURE ?? b.fields?.HEADER) === (old.fields?.SIGNATURE ?? old.fields?.HEADER))
        session.scope = (matches.find(b => result.locations[b.id]?.text === oldLocation?.text) ?? matches.sort((a,b) => Math.abs((result.locations[a.id]?.line ?? 0) - (oldLocation?.line ?? 0)) - Math.abs((result.locations[b.id]?.line ?? 0) - (oldLocation?.line ?? 0)))[0])?.id ?? ''
      }
      show(viewport)
      if (sourceCursor) selectSource(sourceCursor)
    } catch(error) { if (!disposed && revision === id) { loadCppSession(session, {text:'',version:0,dirty:false}, previewError(String(error))); show() } }
    finally { if (revision === id) loading = false }
  }
  renameForm.onsubmit = event => {
    event.preventDefault(); event.stopPropagation()
    const target = renameTarget, nextName = renameInput.value.trim()
    if (!target || renameConfirm.disabled) return
    renameConfirm.disabled = true
    void (async () => {
      if (syncTimer) { clearTimeout(syncTimer); syncTimer = undefined }
      capture()
      const currentRevision = ++session.revision
      const currentCode = sessionCode(session)
      const current = currentCode === session.source?.text ? session.original! : await parseCppAsync(currentCode).promise
      if (current.status === 'error') throw new Error('当前积木尚未生成有效的 C++，请先修正后重命名。')
      const direct = currentCode === session.source?.text ? current.variables?.find(variable => variable.id === target.id && variable.name === target.name && variable.scope === target.scope) : undefined
      const candidates = current.variables?.filter(variable => variable.name === target.name && variable.scope === target.scope && variable.scopeKind === target.scopeKind) ?? []
      const variable = direct ?? (candidates.length === 1 ? candidates[0] : undefined)
      if (!variable) throw new Error('无法确认当前变量的作用域，请先应用更改后重试。')
      const renamed = renameCppVariable(currentCode, current.variables ?? [], variable.id, nextName)
      if (renamed === currentCode) { renameForm.hidden = true; return }
      const checked = await parseCppAsync(renamed).promise
      if (checked.status === 'error') throw new Error('重命名后的 C++ 语法检查未通过，源码未修改。')
      if (session.revision !== currentRevision) throw new Error('积木在重命名期间发生变化，请重试。')
      const updated = await host.syncDraft(renamed, currentRevision)
      if (!updated) throw new Error('积木在重命名期间发生变化，请重试。')
      renameForm.hidden = true
      await refresh()
    })().catch(fail).finally(() => { renameConfirm.disabled = false })
  }
  const subscription = host.onChange(() => {
    if (applying || disposed) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      void host.read().then(current => {
        if (disposed) return
        const action = cppSourceChangeAction(session, current, host.isSyncedDraft(current), liveSynced)
        if (action === 'synced') { conflict = false; summary(); return }
        if (action === 'reload') {
          if (syncTimer) { clearTimeout(syncTimer); syncTimer = undefined }
          session.revision++
          conflict = false
          void refresh()
          return
        }
        if (action === 'conflict') { conflict = true; host.highlight(); summary(); return }
        session.source = current; summary()
      }).catch(fail)
    }, 200)
  })
  const reset = host.onReset(() => {
    if (disposed) return
    const location = selectedLocation
    const viewport = captureViewport()
    conflict = false; liveSynced = false; syncedCode = undefined
    if (session.original) {
      if (rebaseVisible()) return
      show(viewport)
      if (location) {
        const id = blockAtPosition(session.original.locations, location)
        const block = id && workspace.getBlockById(id)
        if (block) { block.select(); showProperties(block); highlightBlock(block) }
      }
    }
    else void refresh()
  })
  const resize = new ResizeObserver(() => { if (!disposed) Blockly.svgResize(workspace) }); resize.observe(canvas)
  if (session.original) {
    show(session.viewport)
    void host.read().then(current => {
      if (disposed) return
      if (session.dirty) { conflict = !host.isSyncedDraft(current) && (current.text !== session.source?.text || current.version !== session.source?.version); summary() }
      else if (current.text !== session.source?.text) void refresh()
      else session.source = current
    }).catch(fail)
  } else void refresh()
  const cursor = host.onCursor(selectSource)
  return { dispose() {
    session.viewport = captureViewport()
    capture(); disposed = true; ++revision; parse?.cancel(); fieldParse?.cancel(); stopFieldFocus(); if (timer) clearTimeout(timer); if (syncTimer) clearTimeout(syncTimer)
    if (saveTimer) clearTimeout(saveTimer)
    if (focusedPreviewWidget === container) focusedPreviewWidget = undefined
    window.removeEventListener('keydown', saveShortcut, true)
    ++libraryRevision; libraryParse?.cancel(); clearTimeout(libraryTimer); clearTimeout(annotationTimer); librarySubscription.dispose(); toolboxSearch.dispose()
    host.highlight(); cursor.dispose(); subscription.dispose(); reset.dispose(); resize.disconnect(); workspace.dispose(); container.replaceChildren()
  } }
}
