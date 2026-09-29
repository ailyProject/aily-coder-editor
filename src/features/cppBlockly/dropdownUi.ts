import * as Blockly from 'blockly'

/** Blockly recreates the popup on every open, so initialize its scroller then. */
export function prepareCppDropdown(field: Blockly.Field): void {
  if (Blockly.DropDownDiv.getOwner() !== field) return
  const content = Blockly.DropDownDiv.getContentDiv()
  const menu = content.querySelector<HTMLElement>('.blocklyMenu')
  const block = field.getSourceBlock() as Blockly.BlockSvg | null
  if (!menu || !block) return
  content.parentElement?.classList.add('cpp-blockly-dropdown')
  const workspace = block.workspace.targetWorkspace ?? block.workspace
  const bounds = workspace.getInjectionDiv().getBoundingClientRect()
  const fieldBounds = field.getScaledBBox()
  const available = Math.max(fieldBounds.top - bounds.top, bounds.bottom - fieldBounds.bottom) - 28
  const height = Math.max(80, Math.min(300, available, menu.scrollHeight))
  content.style.height = `${height}px`
  content.style.maxHeight = `${height}px`
  menu.style.maxHeight = `${height}px`
  menu.style.overflowY = 'auto'
  menu.style.overflowX = 'hidden'
  menu.addEventListener('wheel', event => {
    const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 24 : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? menu.clientHeight : 1
    menu.scrollTop += (event.deltaY || event.deltaX) * unit
    event.preventDefault()
    event.stopPropagation()
  }, { passive: false })
  Blockly.DropDownDiv.setColour('var(--vscode-dropdown-background, #252526)', 'var(--vscode-dropdown-border, #454545)')
  Blockly.DropDownDiv.repositionForWindowResize()
}
