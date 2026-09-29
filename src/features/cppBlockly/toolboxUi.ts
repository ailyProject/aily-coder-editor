import { Blockly } from './blocks.js'
import { cppIcon, type CppIcon } from './icons.js'
import { cppToolbox } from './toolbox.js'
import { filterCppCategories } from './libraryToolbox.js'

const categoryIcons: Record<string, CppIcon> = { 逻辑: 'control', 循环: 'refresh', 数学: 'math', 文字: 'text', 数组: 'array', 变量: 'variable', 自定义函数: 'function', 'I/O引脚': 'chip', 时间: 'time', 串口: 'serial', 中断: 'flag', 自定义代码: 'source' }
let registered = false
export function registerCppToolbox(): void {
  if (registered) return
  registered = true
  class CppCategory extends Blockly.ToolboxCategory {
    protected override createIconDom_(): Element {
      const icon = document.createElement('span'); icon.className = 'cpp-toolbox-icon'
      icon.append(cppIcon(categoryIcons[this.name_] ?? 'blocks')); return icon
    }
    protected override addColourBorder_(): void { /* Aily uses icons and full-row selection. */ }
  }
  Blockly.registry.register(Blockly.registry.Type.TOOLBOX_ITEM, 'cppCategory', CppCategory)
}

export function mountToolboxSearch(canvas: HTMLElement, workspace: Blockly.WorkspaceSvg): { update(categories: Blockly.utils.toolbox.StaticCategoryInfo[]): void; dispose(): void } {
  const parent = canvas.querySelector('.blocklyToolbox')
  if (!parent) return { update() {}, dispose() {} }
  const base = (cppToolbox as Blockly.utils.toolbox.ToolboxInfo).contents as Blockly.utils.toolbox.StaticCategoryInfo[]
  let categories = base, timer: ReturnType<typeof setTimeout> | undefined, disposed = false
  const pages = new Map<string, number>()
  const label = document.createElement('label'); label.className = 'cpp-toolbox-search'
  label.append(cppIcon('search'))
  const input = document.createElement('input'); input.type = 'search'; input.placeholder = '搜索积木'
  input.setAttribute('aria-label', '搜索积木'); label.append(input)
  // Keep text input outside Blockly's focus tree; v13 redirects descendants
  // of the toolbox back to its selected category when they receive focus.
  canvas.append(label)
  const empty = document.createElement('div'); empty.className = 'cpp-toolbox-empty'; empty.textContent = '没有匹配的积木'; empty.hidden = true; parent.append(empty)
  input.onkeydown = event => { event.stopPropagation(); if (event.key === 'Escape') { input.value = ''; input.dispatchEvent(new Event('input')) } }
  const render = (fromSearch = false): void => {
    if (disposed) return
    if (workspace.isDragging() || Blockly.WidgetDiv.isVisible() || Blockly.DropDownDiv.getOwner()) { clearTimeout(timer); timer = setTimeout(() => render(fromSearch), 100); return }
    const query = input.value.trim().toLowerCase()
    const contents = filterCppCategories(categories, query).map(category => {
      if (!category.id?.startsWith('cpp-library:')) return category
      // Build at most 40 SVG blocks in one flyout. Search still covers every API.
      const groups: Blockly.utils.toolbox.ToolboxItemInfo[][] = [], prefix: Blockly.utils.toolbox.ToolboxItemInfo[] = []
      let pending: Blockly.utils.toolbox.ToolboxItemInfo[] = []
      for (const item of category.contents) {
        pending.push(item)
        if (item.kind === 'block') { groups.push(pending); pending = [] }
      }
      if (groups.length <= 40) return category
      const page = Math.min(pages.get(category.id) ?? 0, Math.floor((groups.length - 1) / 40))
      const button = (name: string, delta: number): void => {
        const key = `${category.id}:${delta}`
        workspace.registerButtonCallback(key, () => { pages.set(category.id!, page + delta); render() })
        prefix.push({ kind: 'button', text: name, callbackkey: key })
      }
      prefix.push({ kind: 'label', text: `${category.name} · ${page * 40 + 1}–${Math.min((page + 1) * 40, groups.length)} / ${groups.length} 个积木 · 可搜索全部接口` } as Blockly.utils.toolbox.LabelInfo)
      if (page) button('上一页', -1)
      if ((page + 1) * 40 < groups.length) button('下一页', 1)
      return { ...category, contents: [...prefix, ...groups.slice(page * 40, (page + 1) * 40).flat(), ...pending] }
    })
    const selectedItem = workspace.getToolbox()?.getSelectedItem()
    const selected = selectedItem?.getId(), selectedName = selectedItem instanceof Blockly.ToolboxCategory ? selectedItem.getName() : undefined
    const scrollTop = parent.scrollTop
    workspace.updateToolbox({ kind: 'categoryToolbox', contents })
    empty.hidden = contents.length > 0
    const toolbox = workspace.getToolbox()
    const previous = toolbox?.getToolboxItems().find(item => item.getId() === selected || item instanceof Blockly.ToolboxCategory && item.getName() === selectedName)
    // Async library completion must not switch away from the user's category.
    toolbox?.setSelectedItem((!fromSearch && previous || query && toolbox.getToolboxItems()[0] || null) as Blockly.ISelectableToolboxItem | null)
    parent.scrollTop = scrollTop
  }
  input.oninput = () => { pages.clear(); render(true) }
  return { update(libraries) { categories = [...base, ...libraries]; render() }, dispose() { disposed = true; clearTimeout(timer); label.remove(); empty.remove() } }
}
