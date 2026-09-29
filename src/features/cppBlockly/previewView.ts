import { Blockly, registerCppPreviewBlocks, updateFunctionDisplay } from './blocks.js'
import { indexBlocks, mergeScope } from './generator.js'
import { loadCppSession, parseCppAsync, sessionCode, sessionRoots, type CppEditSession, type PreviewDocument } from './editorSession.js'
import { previewError, type PreviewBlock, type SourceLocation } from './types.js'
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

export interface PreviewHost {
  name: string
  session: CppEditSession
  read(): Promise<PreviewDocument>
  apply(): Promise<void>
  syncDraft(code: string, revision: number): Promise<void>
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
  const toolboxSearch = mountToolboxSearch(canvas, workspace)
  let disposed = false, loading = false, applying = false, conflict = false, revision = 0, liveSynced = false, syncedCode: string | undefined
  let libraryRevision = 0, libraryParse: ReturnType<typeof parseLibraryAsync> | undefined, libraryTimer: ReturnType<typeof setTimeout> | undefined
  let annotationTimer: ReturnType<typeof setTimeout> | undefined
  let currentLibraryEntries: LibraryEntry[] = []
  const annotateCalls = (): void => {
    clearTimeout(annotationTimer)
    if (disposed || !session.original || !session.source || session.dirty || !currentLibraryEntries.length) return
    if (workspace.isDragging() || Blockly.WidgetDiv.isVisible() || Blockly.DropDownDiv.getOwner()) { annotationTimer = setTimeout(annotateCalls, 150); return }
    const baseline = annotateLibraryCalls(session.original.blocks.blocks, session.source.text, currentLibraryEntries)
    const roots = annotateLibraryCalls(session.roots, session.source.text, currentLibraryEntries)
    if (baseline || roots) show()
  }
  const librariesNotice = (text: string): Blockly.utils.toolbox.StaticCategoryInfo => ({ kind: 'cppCategory', id: 'cpp-libraries', name: '项目库', contents: [{ kind: 'label', text }] } as Blockly.utils.toolbox.StaticCategoryInfo)
  async function refreshLibraries(): Promise<void> {
    const id = ++libraryRevision
    libraryParse?.cancel()
    const current = (): boolean => !disposed && id === libraryRevision
    try {
      const libraries = await host.libraries()
      if (!current()) return
      const entries: LibraryEntry[] = libraries.map(library => ({ library }))
      currentLibraryEntries = entries
      setLibraryEntries(workspace, entries)
      const categories = libraries.map(library => libraryCategory(library))
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
  let sourceCursor: SourcePosition | undefined
  let selectedLocation: SourceLocation | undefined
  const highlightField = (block: Blockly.Block, name: string): void => {
    activeField = { blockId: block.id, name }
    const focus = ++fieldFocusRevision
    fieldParse?.cancel()
    if (conflict || !session.source || !session.original) return
    let currentCode: string
    try { currentCode = sessionCode(session) } catch { host.highlight(fieldSourceLocation(session.source.text, session.original, block.id, name)); return }
    if (currentCode === session.source.text) { host.highlight(fieldSourceLocation(session.source.text, session.original, block.id, name)); return }
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
    const state = Blockly.serialization.workspaces.save(workspace)
    session.view = (state.blocks?.blocks ?? []) as PreviewBlock[]
    // Scope roots are pinned only for navigation, never persisted as immutable.
    if (session.scope && session.view[0]) { delete (session.view[0] as PreviewBlock & {movable?: boolean}).movable; delete (session.view[0] as PreviewBlock & {deletable?: boolean}).deletable }
    session.revision++
    try { const currentCode = sessionCode(session); session.dirty = currentCode !== session.source?.text; liveSynced = currentCode === syncedCode }
    catch { session.dirty = true; liveSynced = false }
    host.changed(session.dirty); summary()
    if (generated.open) previewCode()
  }
  const previewCode = (): void => {
    try { code.value = sessionCode(session); code.classList.remove('cpp-blockly-code-error') }
    catch (error) { code.value = error instanceof Error ? error.message : String(error); code.classList.add('cpp-blockly-code-error') }
  }
  const syncField = (): void => {
    if (loading || disposed || conflict || !session.original) return
    if (syncTimer) clearTimeout(syncTimer)
    const currentRevision = session.revision
    let currentCode: string
    try { currentCode = sessionCode(session) } catch(error) { fail(error); return }
    syncTimer = setTimeout(() => {
      syncTimer = undefined
      void host.syncDraft(currentCode, currentRevision).then(() => {
        if (!disposed && currentRevision === session.revision) { syncedCode = currentCode; liveSynced = true; summary(); const focused = activeField && workspace.getBlockById(activeField.blockId); if (focused && activeField) highlightField(focused, activeField.name) }
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
    selectedLocation = block && session.original?.locations[block.id]
    if (!block) return
    const help = block.getTooltip()
    if (help) fields.append(element('p', 'cpp-blockly-field-help', help))
    const location = session.original?.locations[block.id]
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
  }
  const highlightBlock = (block?: Blockly.Block): void => {
    if (!block || block.id !== activeField?.blockId) activeField = undefined
    if (block && activeField?.blockId === block.id) { highlightField(block, activeField.name); return }
    if (conflict) { host.highlight(); return }
    // New draft blocks have no source yet; show their nearest mapped container.
    let location: SourceLocation | undefined
    for (let current = block; current && !location; current = current.getSurroundParent() ?? undefined) location = session.original?.locations[current.id]
    host.highlight(location)
  }
  const selectSource = (position: SourcePosition): void => {
    sourceCursor = position
    if (disposed || loading || conflict || !session.original) return
    const id = blockAtPosition(session.original.locations, position)
    let block = id ? workspace.getBlockById(id) : null
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
  const show = (): void => {
    activeField = undefined; ++fieldFocusRevision; fieldParse?.cancel()
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
      if (!session.view) {
        let y = 24
        for (const root of roots) {
          const block = workspace.getBlockById(root.id)
          if (block) { block.moveBy(24 - block.getRelativeToSurfaceXY().x, y - block.getRelativeToSurfaceXY().y); y += block.getHeightWidth().height + 36 }
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
    if (!session.view) { workspace.zoomToFit(); if (workspace.scale < 0.65) { workspace.setScale(0.85); workspace.scroll(0, 0) } }
    summary(); if (generated.open) previewCode()
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
      const id = 'blockId' in event && typeof event.blockId === 'string' ? event.blockId : selectedId
      highlightBlock(id ? workspace.getBlockById(id) ?? undefined : undefined)
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
      show()
      if (sourceCursor) selectSource(sourceCursor)
    } catch(error) { if (!disposed && revision === id) { loadCppSession(session, {text:'',version:0,dirty:false}, previewError(String(error))); show() } }
    finally { if (revision === id) loading = false }
  }
  const subscription = host.onChange(() => {
    if (applying || disposed) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      void host.read().then(current => {
        if (disposed) return
        if (host.isSyncedDraft(current)) { conflict = false; summary(); return }
        if (session.dirty) { conflict = current.text !== session.source?.text || current.version !== session.source?.version; if (conflict) host.highlight(); summary() }
        else if (current.text !== session.source?.text) void refresh()
        else { session.source = current; summary() }
      }).catch(fail)
    }, 200)
  })
  const reset = host.onReset(() => {
    if (disposed) return
    const location = selectedLocation
    conflict = false; liveSynced = false; syncedCode = undefined
    host.highlight()
    if (session.original) { show(); if (location) { selectSource(location); highlightBlock(workspace.getBlockById(selectedId ?? '') ?? undefined) } }
    else void refresh()
  })
  const resize = new ResizeObserver(() => { if (!disposed) Blockly.svgResize(workspace) }); resize.observe(canvas)
  if (session.original) {
    show()
    void host.read().then(current => {
      if (disposed) return
      if (session.dirty) { conflict = !host.isSyncedDraft(current) && (current.text !== session.source?.text || current.version !== session.source?.version); summary() }
      else if (current.text !== session.source?.text) void refresh()
      else session.source = current
    }).catch(fail)
  } else void refresh()
  const cursor = host.onCursor(selectSource)
  return { dispose() {
    capture(); disposed = true; ++revision; parse?.cancel(); fieldParse?.cancel(); stopFieldFocus(); if (timer) clearTimeout(timer); if (syncTimer) clearTimeout(syncTimer)
    ++libraryRevision; libraryParse?.cancel(); clearTimeout(libraryTimer); clearTimeout(annotationTimer); librarySubscription.dispose(); toolboxSearch.dispose()
    host.highlight(); cursor.dispose(); subscription.dispose(); reset.dispose(); resize.disconnect(); workspace.dispose(); container.replaceChildren()
  } }
}
