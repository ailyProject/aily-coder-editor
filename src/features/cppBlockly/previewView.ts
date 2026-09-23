import { Blockly, registerCppPreviewBlocks, resizeCppInputs } from './blocks.js'
import { indexBlocks, mergeScope } from './generator.js'
import { loadCppSession, parseCppAsync, sessionCode, type CppEditSession, type PreviewDocument } from './editorSession.js'
import { previewError, type PreviewBlock, type SourceLocation } from './types.js'
import { cppToolbox } from './toolbox.js'
import previewCss from './preview.css?inline'

export interface PreviewHost {
  name: string
  session: CppEditSession
  read(): Promise<PreviewDocument>
  apply(): Promise<void>
  changed(dirty: boolean): void
  reveal(location?: SourceLocation): Promise<void>
  onChange(refresh: () => void): { dispose(): void }
  onReset(refresh: () => void): { dispose(): void }
}

export function mountCppPreview(container: HTMLElement, host: PreviewHost): { dispose(): void } {
  registerCppPreviewBlocks()
  const session = host.session
  container.replaceChildren(); container.classList.add('cpp-blockly-preview')
  const element = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] => {
    const node = document.createElement(tag); node.className = className; node.textContent = text; return node
  }
  const button = (parent: HTMLElement, text: string, run: () => void): HTMLButtonElement => {
    const b = element('button', '', text); b.type = 'button'; b.onclick = run; parent.append(b); return b
  }
  const toolbar = element('div', 'cpp-blockly-toolbar')
  const badge = element('span', 'cpp-blockly-badge', '可编辑')
  toolbar.append(element('strong', '', `${host.name} · Blockly`), badge)
  const scope = element('select', 'cpp-blockly-scope'); scope.setAttribute('aria-label', '查看函数或整个文件'); scope.disabled = true
  toolbar.append(scope)
  const actions = element('div', 'cpp-blockly-actions'); toolbar.append(actions)
  const status = element('div', 'cpp-blockly-status', '正在解析 C++…'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite')
  const canvas = element('div', 'cpp-blockly-canvas'); canvas.setAttribute('aria-label', '可编辑 C++ Blockly 积木画布')
  const inspector = element('div', 'cpp-blockly-inspector')
  const properties = element('details'); properties.append(element('summary', '', '积木属性 · 选中积木后编辑完整内容'))
  const fields = element('div', 'cpp-blockly-fields'); properties.append(fields)
  const generated = element('details'); generated.append(element('summary', '', '生成的 C++ · 应用后可在源码中撤销、保存'))
  const code = element('textarea', 'cpp-blockly-code'); code.readOnly = true; code.setAttribute('aria-label', '生成的 C++ 源码'); generated.append(code)
  const diagnostics = element('div', 'cpp-blockly-diagnostics')
  inspector.append(diagnostics, properties, generated)
  container.append(element('style', '', previewCss), toolbar, status, canvas, inspector)
  const computed = getComputedStyle(container)
  const theme = Blockly.Theme.defineTheme('cpp-editor', {
    name: 'cpp-editor', base: Blockly.Themes.Classic,
    componentStyles: { workspaceBackgroundColour: computed.backgroundColor, toolboxBackgroundColour: computed.backgroundColor, toolboxForegroundColour: computed.color, flyoutBackgroundColour: computed.backgroundColor, flyoutForegroundColour: computed.color, flyoutOpacity: 0.95, scrollbarColour: '#777777', scrollbarOpacity: 0.45 },
    fontStyle: { family: computed.fontFamily, size: 11 }
  })
  const workspace = Blockly.inject(canvas, {
    readOnly: false, toolbox: cppToolbox, trashcan: true, comments: false, disable: false,
    renderer: 'zelos', theme, scrollbars: true, sounds: false,
    move: { drag: true, wheel: true, scrollbars: true },
    zoom: { controls: false, wheel: true, startScale: 0.85, maxScale: 1.5, minScale: 0.25, scaleSpeed: 1.15 }
  })
  let disposed = false, loading = false, applying = false, conflict = false, revision = 0
  let parse: ReturnType<typeof parseCppAsync> | undefined, timer: ReturnType<typeof setTimeout> | undefined
  let selectedId: string | undefined, shownScope = session.scope, firstLoad = !session.original
  const fail = (error: unknown): void => { status.dataset.state = 'error'; status.textContent = error instanceof Error ? error.message : String(error) }
  const reveal = (location?: SourceLocation): void => { void host.reveal(location).catch(fail) }
  const summary = (): void => {
    const result = session.original
    badge.textContent = session.dirty ? '未应用修改' : '可编辑'
    apply.disabled = loading || applying || conflict || !session.dirty || result?.status === 'error'
    if (conflict) { fail('源码已变化，当前积木草稿已保留。可查看并复制生成代码，或重新载入源码。'); return }
    status.dataset.state = result?.status ?? 'loading'
    status.textContent = result?.status === 'error' ? '无法转换，请修正下方源码问题。' : `${result?.blockCount ?? 0} 个积木 · 当前视图 ${workspace.getAllBlocks(false).length} 个${result?.dataCount ? ` · ${result.dataCount} 处数据折叠` : ''}${session.dirty ? ' · 草稿尚未应用' : session.source?.dirty ? ' · 源码未保存' : ''}。从左侧拖入积木，点击字段编辑；复杂原文在下方属性中编辑。`
  }
  const capture = (): void => {
    if (loading || disposed || !session.original) return
    const state = Blockly.serialization.workspaces.save(workspace)
    session.view = (state.blocks?.blocks ?? []) as PreviewBlock[]
    // Scope roots are pinned only for navigation, never persisted as immutable.
    if (session.scope && session.view[0]) { delete (session.view[0] as PreviewBlock & {movable?: boolean}).movable; delete (session.view[0] as PreviewBlock & {deletable?: boolean}).deletable }
    session.revision++
    try { session.dirty = sessionCode(session) !== session.source?.text }
    catch { session.dirty = true }
    host.changed(session.dirty); summary()
    if (generated.open) previewCode()
  }
  const previewCode = (): void => {
    try { code.value = sessionCode(session); code.classList.remove('cpp-blockly-code-error') }
    catch (error) { code.value = error instanceof Error ? error.message : String(error); code.classList.add('cpp-blockly-code-error') }
  }
  button(actions, '返回源码', () => { capture(); reveal() })
  button(actions, '重新载入', () => {
    if (!session.dirty) { void refresh(); return }
    // Inline, explicit discard action protects the draft without native dialogs.
    discard.hidden = false; fail('重新载入将放弃未应用的积木修改。点击“放弃草稿并载入”继续，或继续编辑。')
  })
  const discard = button(actions, '放弃草稿并载入', () => { discard.hidden = true; session.dirty = false; session.view = undefined; host.changed(false); void refresh() }); discard.hidden = true
  button(actions, '撤销', () => workspace.undo(false))
  button(actions, '重做', () => workspace.undo(true))
  button(actions, '适应画布', () => { Blockly.svgResize(workspace); workspace.zoomToFit() })
  button(actions, '生成 C++', () => { capture(); generated.open = true; properties.open = false; previewCode(); Blockly.svgResize(workspace) })
  const apply = button(actions, '应用到源码', () => {
    capture(); applying = true; summary()
    void host.apply().then(() => { if (!disposed) { conflict = false; status.textContent = '已应用到源码缓冲区；可返回源码撤销，按 ⌘S 保存。' } }).catch(fail).finally(() => { applying = false; apply.disabled = !session.dirty || conflict })
  }); apply.classList.add('cpp-blockly-primary'); apply.disabled = true

  const showProperties = (block?: Blockly.Block): void => {
    fields.replaceChildren(); selectedId = block?.id
    if (!block) return
    const location = session.original?.locations[block.id]
    if (location) button(fields, `定位源码 L${location.line}`, () => reveal(location))
    const names: Record<string, string> = { TEXT: '值 / 原文', NAME: '函数名', SIGNATURE: '函数签名', DECL: '声明', INIT: '初始化符号', OP: '运算符', BEFORE: '前缀', AFTER: '后缀', HEADER: '头部 C++', FOOTER: '尾部 C++', CODE: '完整数据', MEMBER: '成员', OPEN: '开始符号', CLOSE: '结束符号' }
    for (const input of block.inputList) for (const field of input.fieldRow) {
      if (!field.name || (block.type === 'cpp_preview_data' && field.name === 'TEXT')) continue
      const label = element('label', '', names[field.name] ?? field.name)
      const edit = element('textarea'); edit.value = String(field.getValue() ?? ''); edit.rows = edit.value.includes('\n') ? 3 : 1; edit.spellcheck = false
      edit.setAttribute('aria-label', names[field.name] ?? field.name)
      edit.oninput = () => { field.setValue(edit.value); capture() }
      label.append(edit); fields.append(label)
    }
    if (['cpp_preview_call', 'cpp_preview_invoke', 'cpp_preview_list', 'cpp_preview_if'].includes(block.type)) {
      const count = (): number => (block.saveExtraState?.() as {count: number})?.count ?? 0
      if (block.type === 'cpp_preview_if') button(fields, count() ? '移除否则分支' : '添加否则分支', () => { resizeCppInputs(block, 1 - count()); capture(); showProperties(block) })
      else {
        button(fields, '添加参数', () => { resizeCppInputs(block, count() + 1); capture() })
        button(fields, '移除最后参数', () => { resizeCppInputs(block, Math.max(0, count() - 1)); capture() })
      }
    }
  }
  const populateScopes = (): void => {
    const current = indexBlocks(session.roots)
    scope.replaceChildren()
    const option = (id: string, label: string): void => { const o = element('option', '', label); o.value = id; scope.append(o) }
    option('', '整个文件')
    const units = [...current.values()].filter(b => b.type === 'cpp_preview_function' || b.type === 'cpp_preview_lambda' || (b.type === 'cpp_preview_container' && /^(namespace|class|struct|template)\b/.test(b.fields?.HEADER ?? '')))
    for (const b of units) option(b.id, `L${session.original?.locations[b.id]?.line ?? '新'} · ${b.type === 'cpp_preview_lambda' ? '回调 ' : ''}${(b.fields?.SIGNATURE ?? b.fields?.HEADER ?? '').replace(/\s+/g, ' ').slice(0, 100)}`)
    if (firstLoad && (session.original?.blockCount ?? 0) > 250) session.scope = (units.find(b => /\bsetup\s*\(/.test(b.fields?.SIGNATURE ?? '')) ?? units.find(b => b.type === 'cpp_preview_function'))?.id ?? ''
    firstLoad = false
    if (session.scope && !current.has(session.scope)) session.scope = ''
    scope.value = session.scope; scope.disabled = session.original?.status === 'error'
  }
  const show = (): void => {
    loading = true
    try {
      Blockly.Events.disable()
      workspace.clear(); workspace.clearUndo(); fields.replaceChildren(); diagnostics.replaceChildren()
      populateScopes(); shownScope = session.scope
      const selected = indexBlocks(session.roots).get(session.scope)
      const roots = session.view ?? (selected ? [{ ...selected, next: undefined }] : session.roots)
      Blockly.serialization.workspaces.load({blocks: { languageVersion: 0, blocks: roots }}, workspace)
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
      showProperties(id ? workspace.getBlockById(id) ?? undefined : undefined)
    } else if (!event.isUiEvent) {
      capture()
      // Inline field edits also refresh the complete-value inspector.
      if (event.type === Blockly.Events.BLOCK_CHANGE && selectedId && !fields.contains(container.getRootNode() instanceof ShadowRoot ? (container.getRootNode() as ShadowRoot).activeElement : document.activeElement)) showProperties(workspace.getBlockById(selectedId) ?? undefined)
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
      loadCppSession(session, source, result); conflict = false; host.changed(false)
      if (old) {
        const matches = [...indexBlocks(session.roots).values()].filter(b => b.type === old.type && (b.fields?.SIGNATURE ?? b.fields?.HEADER) === (old.fields?.SIGNATURE ?? old.fields?.HEADER))
        session.scope = (matches.find(b => result.locations[b.id]?.text === oldLocation?.text) ?? matches.sort((a,b) => Math.abs((result.locations[a.id]?.line ?? 0) - (oldLocation?.line ?? 0)) - Math.abs((result.locations[b.id]?.line ?? 0) - (oldLocation?.line ?? 0)))[0])?.id ?? ''
      }
      show()
    } catch(error) { if (!disposed && revision === id) { loadCppSession(session, {text:'',version:0,dirty:false}, previewError(String(error))); show() } }
    finally { if (revision === id) loading = false }
  }
  const subscription = host.onChange(() => {
    if (applying || disposed) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      void host.read().then(current => {
        if (disposed) return
        if (session.dirty) { conflict = current.text !== session.source?.text || current.version !== session.source?.version; summary() }
        else if (current.text !== session.source?.text) void refresh()
        else { session.source = current; summary() }
      }).catch(fail)
    }, 200)
  })
  const reset = host.onReset(() => { if (disposed) return; conflict = false; if (session.original) show(); else void refresh() })
  const resize = new ResizeObserver(() => { if (!disposed) Blockly.svgResize(workspace) }); resize.observe(canvas)
  if (session.original) {
    show()
    void host.read().then(current => {
      if (disposed) return
      if (session.dirty) { conflict = current.text !== session.source?.text || current.version !== session.source?.version; summary() }
      else if (current.text !== session.source?.text) void refresh()
      else session.source = current
    }).catch(fail)
  } else void refresh()
  return { dispose() {
    capture(); disposed = true; ++revision; parse?.cancel(); if (timer) clearTimeout(timer)
    subscription.dispose(); reset.dispose(); resize.disconnect(); workspace.dispose(); container.replaceChildren()
  } }
}
