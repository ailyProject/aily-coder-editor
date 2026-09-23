import { Blockly, registerCppPreviewBlocks } from './blocks.js'
import { previewError, type CppPreview, type PreviewBlock, type SourceLocation } from './types.js'
import previewCss from './preview.css?inline'

export interface PreviewDocument { text: string; version: number; dirty: boolean }
export interface PreviewHost {
  name: string
  read(): Promise<PreviewDocument>
  reveal(location?: SourceLocation): Promise<void>
  onChange(refresh: () => void): { dispose(): void }
}

export function mountCppPreview(container: HTMLElement, host: PreviewHost): { dispose(): void } {
  registerCppPreviewBlocks()
  container.replaceChildren()
  container.classList.add('cpp-blockly-preview')
  const element = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] => {
    const node = document.createElement(tag); node.className = className; node.textContent = text; return node
  }
  // The Workbench lives inside a shadow root; global Vite CSS cannot reach it.
  const style = element('style', '', previewCss)
  container.append(style)
  const toolbar = element('div', 'cpp-blockly-toolbar')
  toolbar.append(element('strong', '', `${host.name} · Blockly`), element('span', 'cpp-blockly-badge', '只读预览'))
  const scope = element('select', 'cpp-blockly-scope')
  scope.setAttribute('aria-label', '查看函数或整个文件')
  scope.disabled = true
  toolbar.append(scope)
  const actions = element('div', 'cpp-blockly-actions'); toolbar.append(actions)
  const status = element('div', 'cpp-blockly-status', '正在解析 C++…')
  status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite')
  const canvas = element('div', 'cpp-blockly-canvas')
  canvas.setAttribute('aria-label', 'C++ 转换的 Blockly 积木画布')
  const inspector = element('div', 'cpp-blockly-inspector')
  const diagnostics = element('ul', 'cpp-blockly-diagnostics')
  const details = element('details')
  const summary = element('summary', '', '源码定位与积木列表')
  const outline = element('div', 'cpp-blockly-outline')
  const snippet = element('pre')
  details.append(summary, outline, snippet); inspector.append(diagnostics, details)
  container.append(toolbar, status, canvas, inspector)

  const computed = getComputedStyle(container)
  const theme = Blockly.Theme.defineTheme('cpp-preview', {
    name: 'cpp-preview', base: Blockly.Themes.Classic,
    componentStyles: {
      workspaceBackgroundColour: computed.backgroundColor,
      scrollbarColour: '#777777', scrollbarOpacity: 0.45,
      flyoutBackgroundColour: computed.backgroundColor
    }, fontStyle: { family: computed.fontFamily, size: 11 }
  })
  const workspace = Blockly.inject(canvas, {
    readOnly: true, renderer: 'zelos', theme,
    scrollbars: true, sounds: false,
    move: { drag: true, wheel: true, scrollbars: true },
    zoom: { controls: false, wheel: true, startScale: 0.85, maxScale: 1.5, minScale: 0.25, scaleSpeed: 1.15 }
  })
  let disposed = false, revision = 0, timer: ReturnType<typeof setTimeout> | undefined
  let timeout: ReturnType<typeof setTimeout> | undefined, worker: Worker | undefined
  let documentVersion = 0, dirty = false
  let lastResult: CppPreview | undefined
  let selectedUnit = ''
  let selectedLocation: SourceLocation | undefined
  let hasSelectedScope = false
  const indexed = new Map<string, PreviewBlock>()
  const button = (parent: HTMLElement, text: string, run: () => void): HTMLButtonElement => {
    const b = element('button', '', text); b.type = 'button'; b.onclick = run; parent.append(b); return b
  }
  const reveal = (location?: SourceLocation): void => {
    void host.reveal(location).catch(error => { status.textContent = `无法打开源码：${String(error)}` })
  }
  button(actions, '返回源码', () => reveal())
  button(actions, '刷新', () => { void refresh() })
  button(actions, '适应画布', () => { Blockly.svgResize(workspace); workspace.zoomToFit() })
  button(actions, '−', () => workspace.zoomCenter(-1)).setAttribute('aria-label', '缩小积木')
  button(actions, '+', () => workspace.zoomCenter(1)).setAttribute('aria-label', '放大积木')
  const stopWorker = (): void => {
    if (timeout) clearTimeout(timeout)
    timeout = undefined; worker?.terminate(); worker = undefined
  }
  const show = (result: CppPreview, changingScope = false): void => {
    if (disposed) return
    workspace.clear(); diagnostics.replaceChildren(); outline.replaceChildren(); snippet.textContent = ''
    if (!changingScope) {
      const previous = indexed.get(selectedUnit)
      const previousLocation = selectedLocation
      lastResult = result; indexed.clear(); scope.replaceChildren()
      const option = (id: string, label: string): void => { const o = element('option', '', label); o.value = id; scope.append(o) }
      option('', '整个文件')
      const units: PreviewBlock[] = []
      const visit = (b: PreviewBlock): void => {
        indexed.set(b.id, b)
        if (b.type === 'cpp_preview_function' || b.type === 'cpp_preview_lambda' ||
            (b.type === 'cpp_preview_container' && /^(namespace|class|struct|template)\b/.test(b.fields?.HEADER ?? ''))) units.push(b)
        for (const child of Object.values(b.inputs ?? {})) visit(child.block)
        if (b.next) visit(b.next.block)
      }
      result.blocks.blocks.forEach(visit)
      for (const b of units) option(b.id, `L${result.locations[b.id]?.line ?? 1} · ${b.type === 'cpp_preview_lambda' ? '回调 ' : ''}${b.fields?.SIGNATURE ?? b.fields?.HEADER ?? ''}`)
      if (previous) {
        const candidates = units.filter(b => b.type === previous.type && (b.fields?.SIGNATURE ?? b.fields?.HEADER) === (previous.fields?.SIGNATURE ?? previous.fields?.HEADER))
        // Several callbacks commonly share [](). Preserve the same callback
        // after refresh or edits elsewhere, rather than selecting the first.
        const sameSource = candidates.find(b => result.locations[b.id]?.text === previousLocation?.text)
        const nearest = candidates.sort((a, b) => Math.abs((result.locations[a.id]?.line ?? 0) - (previousLocation?.line ?? 0)) - Math.abs((result.locations[b.id]?.line ?? 0) - (previousLocation?.line ?? 0)))[0]
        selectedUnit = (sameSource ?? nearest)?.id ?? ''
      }
      if (!hasSelectedScope && result.blockCount > 250) selectedUnit = (units.find(b => /\bsetup\s*\(/.test(b.fields?.SIGNATURE ?? '')) ?? units.find(b => b.type === 'cpp_preview_function'))?.id ?? ''
      if (result.status !== 'error') hasSelectedScope = true
      scope.value = selectedUnit; scope.disabled = result.status === 'error' || !units.length
    }
    status.dataset.state = result.status
    if (result.status === 'error') {
      status.textContent = '暂时无法转换。请修正下方问题后重试。'
    } else {
      const selected = indexed.get(scope.value)
      selectedLocation = selected ? result.locations[selected.id] : undefined
      const roots = selected ? [{ ...selected, next: undefined }] : result.blocks.blocks
      Blockly.serialization.workspaces.load({ blocks: { ...result.blocks, blocks: roots } }, workspace)
      // Stack top-level units vertically in original source order, not by the
      // default block IDs or workspace heuristics.
      let y = 24
      for (const state of roots) {
        const block = workspace.getBlockById(state.id)
        if (block) { block.moveBy(24 - block.getRelativeToSurfaceXY().x, y - block.getRelativeToSurfaceXY().y); y += block.getHeightWidth().height + 36 }
      }
      for (const block of workspace.getAllBlocks(false)) {
        const location = result.locations[block.id]
        if (!location) continue
        block.setTooltip(`第 ${location.line} 行\n${location.text}`)
        // Exact source stays available even when a label is shortened.
        const svg = block.getSvgRoot()
        svg?.addEventListener('dblclick', event => {
          event.stopPropagation()
          reveal(location)
        })
      }
      status.textContent = result.blockCount
        ? `${result.blockCount} 个积木${selected ? ` · 当前视图 ${workspace.getAllBlocks(false).length} 个` : ''}${result.dataCount ? ` · ${result.dataCount} 处数据折叠` : ''}${result.preservedCount ? ` · ${result.preservedCount} 处复杂语法保留原文` : ''} · ${dirty ? '包含未保存修改' : '当前源码'} · v${documentVersion}。双击积木定位源码。`
        : '文件为空，暂无可预览的积木。'
      status.textContent += ' 仅展示 C++ 结构，不改写源码或验证编译。'
      for (const state of roots) {
        const loc = result.locations[state.id]
        if (loc) button(outline, `L${loc.line} ${loc.text.split('\n')[0]?.slice(0, 70) ?? ''}`, () => {
          snippet.textContent = loc.text; workspace.centerOnBlock(state.id); workspace.highlightBlock(state.id)
        })
      }
      Blockly.svgResize(workspace)
      workspace.zoomToFit()
      // Long programs open at the beginning at a readable scale; short ones
      // fit entirely instead of centering only their first block.
      if (workspace.scale < 0.65) { workspace.setScale(0.85); workspace.scroll(0, 0) }
    }
    for (const item of result.diagnostics) {
      const row = element('li')
      button(row, `L${item.line}:${item.column} · ${item.message}`, () => { snippet.textContent = item.text; details.open = true; reveal(item) })
      diagnostics.append(row)
    }
  }
  scope.onchange = () => { selectedUnit = scope.value; if (lastResult) show(lastResult, true) }
  async function refresh(): Promise<void> {
    const id = ++revision
    stopWorker()
    scope.disabled = true; lastResult = undefined
    workspace.clear(); diagnostics.replaceChildren(); outline.replaceChildren(); snippet.textContent = ''
    status.textContent = '正在解析 C++…'; status.dataset.state = 'loading'
    try {
      const source = await host.read()
      if (disposed || revision !== id) return
      documentVersion = source.version; dirty = source.dirty
      worker = new Worker(new URL('./parser.worker.ts', import.meta.url), { type: 'module' })
      worker.onmessage = (event: MessageEvent<{ id: number; result: CppPreview }>) => {
        if (disposed || revision !== id || event.data.id !== id) return
        stopWorker()
        try { show(event.data.result) }
        catch (error) { show(previewError(`积木预览加载失败：${String(error)}`)) }
      }
      worker.onerror = () => { if (!disposed && revision === id) { stopWorker(); show(previewError('解析器启动失败，请刷新后重试。')) } }
      timeout = setTimeout(() => { if (!disposed && revision === id) { stopWorker(); show(previewError('解析超时，请缩小文件后重试。')) } }, 15_000)
      worker.postMessage({ id, source: source.text })
    } catch (error) { if (!disposed && revision === id) show(previewError(`无法读取源码：${String(error)}`)) }
  }
  const subscription = host.onChange(() => {
    ++revision; stopWorker(); workspace.clear()
    scope.disabled = true; lastResult = undefined
    status.textContent = '源码已变化，正在更新预览…'; status.dataset.state = 'loading'
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => { void refresh() }, 350)
  })
  const resize = new ResizeObserver(() => { if (!disposed) Blockly.svgResize(workspace) })
  resize.observe(canvas)
  void refresh()
  return { dispose() {
    disposed = true; ++revision; if (timer) clearTimeout(timer)
    stopWorker(); subscription.dispose(); resize.disconnect(); workspace.dispose()
    container.replaceChildren()
  } }
}
