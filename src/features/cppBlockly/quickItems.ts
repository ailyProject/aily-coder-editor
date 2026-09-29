import * as Blockly from 'blockly'

export interface CppQuickAction { id: string; label: string; enabled: boolean; run(): void }
const prefix = 'cpp_preview_'
const plusIcon = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><rect x="1" y="1" width="22" height="22" rx="6" fill="white" fill-opacity=".18"/><path d="M12 6v12M6 12h12" stroke="white" stroke-width="2" stroke-linecap="round"/></svg>')}`

class QuickItemsField extends Blockly.FieldImage {
  override getScaledBBox(): Blockly.utils.Rect {
    // FieldImage has no border rect, so Blockly's default measures the entire
    // parent block. Anchor to the small icon even on very tall if/switch blocks.
    const rect = this.getSvgRoot()!.getBoundingClientRect()
    return new Blockly.utils.Rect(rect.top + window.scrollY, rect.bottom + window.scrollY, rect.left + window.scrollX, rect.right + window.scrollX)
  }
}

function grouped(run: () => void): void {
  const previous = Blockly.Events.getGroup()
  Blockly.Events.setGroup(previous || true)
  try { run() } finally { Blockly.Events.setGroup(previous) }
}

export function resizeCppInputs(block: Blockly.Block, count: number): void {
  if (!block.loadExtraState || !block.saveExtraState) return
  const old = JSON.stringify(block.saveExtraState())
  grouped(() => {
    block.loadExtraState!({ count })
    const next = JSON.stringify(block.saveExtraState!())
    if (old !== next) Blockly.Events.fire(new Blockly.Events.BlockChange(block, 'mutation', null, old, next))
  })
}

function lastIf(block: Blockly.Block): Blockly.Block {
  let tail = block
  for (;;) {
    const child = tail.getInputTargetBlock('ELSE')
    if (child?.type !== prefix + 'if' || child.getNextBlock()) return tail
    tail = child
  }
}

function addElseIf(block: Blockly.Block): void {
  grouped(() => {
    const tail = lastIf(block), alternative = tail.getInputTargetBlock('ELSE')
    resizeCppInputs(tail, 1)
    alternative?.previousConnection?.disconnect()
    const branch = Blockly.serialization.blocks.append({
      type: prefix + 'if', extraState: { count: alternative ? 1 : 0 },
      inputs: { CONDITION: { block: { type: prefix + 'value', fields: { TEXT: 'false' } } } }
    }, block.workspace, { recordUndo: true })
    tail.getInput('ELSE')!.connection!.connect(branch.previousConnection!)
    if (alternative) branch.getInput('ELSE')!.connection!.connect(alternative.previousConnection!)
  })
}

function switchItems(block: Blockly.Block): Blockly.Block[] {
  const items: Blockly.Block[] = []
  for (let child = block.getInputTargetBlock('BODY'); child; child = child.getNextBlock()) items.push(child)
  return items
}

function switchLabels(block: Blockly.Block): Blockly.Block[] {
  const labels: Blockly.Block[] = []
  const visit = (child: Blockly.Block): void => {
    // Labels in another switch (or a nested function) belong to that construct.
    if ([prefix + 'switch', prefix + 'function', prefix + 'lambda'].includes(child.type)) return
    if (/^(case\s|default\s*:)/.test(String(child.getFieldValue('HEADER')))) labels.push(child)
    for (const input of child.inputList) {
      for (let nested = input.connection?.targetBlock(); nested; nested = nested.getNextBlock()) visit(nested)
    }
  }
  switchItems(block).forEach(visit)
  return labels
}

function nextCaseValue(block: Blockly.Block): number {
  const used = new Set<number>()
  for (const item of switchLabels(block)) {
    const match = String(item.getFieldValue('HEADER') ?? '').match(/^case\s+(0[xX][\da-fA-F]+|0[bB][01]+|\d+)[uUlL]*\s*:/)
    if (match) used.add(/^0[0-7]+$/.test(match[1]!) ? parseInt(match[1]!, 8) : Number(match[1]))
  }
  let value = 0
  while (used.has(value)) value++
  return value
}

function addSwitchItem(block: Blockly.Block, isDefault: boolean): void {
  grouped(() => {
    const items = switchItems(block)
    const branch = Blockly.serialization.blocks.append({
      type: prefix + 'case', fields: { HEADER: isDefault ? 'default:' : `case ${nextCaseValue(block)}:` },
      inputs: { BODY: { block: { type: prefix + 'flow', fields: { TEXT: 'break;' } } } }
    }, block.workspace, { recordUndo: true })
    // Append at the end, including after a middle default. Inserting before an
    // existing label could interrupt an intentional fallthrough with our break.
    const connection = items.at(-1)?.nextConnection ?? block.getInput('BODY')!.connection!
    connection.connect(branch.previousConnection!)
  })
}

export function cppQuickActions(block: Blockly.Block): CppQuickAction[] {
  const editable = block.isEditable() && !block.isInFlyout
  const action = (id: string, label: string, run: () => void, enabled = true): CppQuickAction => ({
    id, label, enabled: editable && enabled,
    run() { if (editable && enabled && !block.isDisposed()) run() }
  })
  if (block.type === prefix + 'if') {
    const tail = lastIf(block), hasElse = !!tail.getInput('ELSE')
    return [
      action('else-if', '添加“否则，如果…”', () => addElseIf(block)),
      action('else', '添加“否则执行”', () => resizeCppInputs(lastIf(block), 1), !hasElse),
      action('remove-else', '移除空的“否则”', () => resizeCppInputs(lastIf(block), 0), hasElse && !tail.getInputTargetBlock('ELSE'))
    ]
  }
  if (block.type === prefix + 'switch') {
    const hasDefault = switchLabels(block).some(b => /^default\s*:/.test(String(b.getFieldValue('HEADER'))))
    return [
      action('case', '添加一种情况', () => addSwitchItem(block, false)),
      action('default', '添加其他情况', () => addSwitchItem(block, true), !hasDefault)
    ]
  }
  if ([prefix + 'call', prefix + 'invoke', prefix + 'list'].includes(block.type)) {
    const count = (block.saveExtraState?.() as { count: number }).count
    return [
      action('argument', block.type === prefix + 'list' ? '添加列表项' : '添加参数', () => grouped(() => {
        resizeCppInputs(block, count + 1)
        const value = Blockly.serialization.blocks.append({ type: prefix + 'value', fields: { TEXT: '0' } }, block.workspace, { recordUndo: true })
        block.getInput(`ARG${count}`)!.connection!.connect(value.outputConnection!)
      }), count < 2000),
      action('remove-argument', '移除末尾空插槽', () => resizeCppInputs(block, count - 1), count > 0 && !block.getInputTargetBlock(`ARG${count - 1}`))
    ]
  }
  return []
}

export function registerCppQuickItems(): void {
  Blockly.Extensions.register('cpp_quick_items', function(this: Blockly.Block) {
    const field = new QuickItemsField(plusIcon, 22, 22, '扩展项', image => {
      if (!this.isEditable() || this.isInFlyout) return
      Blockly.DropDownDiv.hideWithoutAnimation(); Blockly.DropDownDiv.clearContent()
      const content = Blockly.DropDownDiv.getContentDiv()
      const menu = document.createElement('div')
      menu.className = 'cpp-blockly-quick-menu'
      menu.style.cssText = 'min-width:180px;padding:4px;display:flex;flex-direction:column;gap:3px;color:var(--vscode-foreground,#ddd);font:13px var(--vscode-font-family,sans-serif)'
      menu.setAttribute('role', 'group'); menu.setAttribute('aria-label', '积木扩展项')
      for (const action of cppQuickActions(this)) {
        const button = document.createElement('button')
        button.textContent = action.label; button.disabled = !action.enabled; button.type = 'button'
        button.style.cssText = 'text-align:left;padding:8px 10px;border:0;border-radius:4px;background:transparent;color:inherit;font:inherit;cursor:pointer'
        if (button.disabled) button.style.opacity = '.4'
        button.onmouseenter = () => { if (!button.disabled) button.style.background = 'var(--vscode-toolbar-hoverBackground,#8883)' }
        button.onmouseleave = () => { button.style.background = 'transparent' }
        button.onclick = () => { action.run(); Blockly.DropDownDiv.hideWithoutAnimation() }
        menu.append(button)
      }
      menu.onkeydown = event => {
        event.stopPropagation()
        if (event.key === 'Escape') Blockly.DropDownDiv.hideWithoutAnimation()
      }
      content.append(menu)
      Blockly.DropDownDiv.setColour('var(--vscode-editorWidget-background,#252526)', 'var(--vscode-widget-border,#555)')
      Blockly.DropDownDiv.showPositionedByField(image)
      menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
    })
    field.setTooltip('扩展项：快速添加分支或参数')
    this.inputList[0]!.appendField(field)
    ;(this as Blockly.BlockSvg).customContextMenu = options => {
      for (const action of cppQuickActions(this)) options.push({ text: action.label, enabled: action.enabled, callback: action.run })
    }
  })
}
