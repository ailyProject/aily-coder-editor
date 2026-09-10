import { coderUseEmbedHostNativeFsBridge } from './coderEmbedEnv.js'
import {
  MenuId,
  MenuRegistry,
  isIMenuItem
} from '@codingame/monaco-vscode-api/vscode/vs/platform/actions/common/actions'
import { removeEmbedCommandPaletteKeybindings, SHOW_COMMANDS } from './embedCommandPalettePatch'

const hiddenEmptyGroupCommands = new Set([
  'workbench.action.newEmptyEditorWindow',
  'workbench.action.toggleEditorGroupLock'
])

const hiddenTabsBarCommands = new Set([
  'workbench.action.moveEditorGroupToNewWindow',
  'workbench.action.copyEditorGroupToNewWindow',
  'workbench.action.configureEditorTabs'
])

const hiddenTabsBarSubmenus = new Set([
  MenuId.EditorTabsBarShowTabsSubmenu,
  MenuId.EditorTabsBarShowTabsZenModeSubmenu,
  MenuId.EditorActionsPositionSubmenu
])

let installed = false

/** Install before Workbench initialization, before menu services cache their entries. */
export function installEmbedEditorContextMenus(): void {
  if (installed) return
  installed = true

  removeEmbedCommandPaletteKeybindings()

  // Filter on read so late registrations also follow the embedded editor's menu policy.
  // Hide the disabled Command Palette in every menu, including the editor context menu.
  // Other commands remain limited to the two editor-group context menus.
  const getMenuItems = MenuRegistry.getMenuItems.bind(MenuRegistry)
  MenuRegistry.getMenuItems = menuId => {
    const items = getMenuItems(menuId).filter(item => !isIMenuItem(item) || item.command.id !== SHOW_COMMANDS)
    if (coderUseEmbedHostNativeFsBridge && menuId === MenuId.ExplorerContext) {
      return items.filter(item => !isIMenuItem(item) || !['workbench.action.addRootFolder', 'workbench.action.removeRootFolder'].includes(item.command.id))
    }
    if (menuId === MenuId.EmptyEditorGroupContext) {
      return items.filter(item => !isIMenuItem(item) || !hiddenEmptyGroupCommands.has(item.command.id))
    }
    if (menuId === MenuId.EditorTabsBarContext) {
      return items.filter(item => isIMenuItem(item)
        ? !hiddenTabsBarCommands.has(item.command.id)
        : !hiddenTabsBarSubmenus.has(item.submenu))
    }
    return items
  }
}
