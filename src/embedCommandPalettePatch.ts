import { CommandsRegistry } from '@codingame/monaco-vscode-api/vscode/vs/platform/commands/common/commands'
import { KeyCode, KeyMod } from '@codingame/monaco-vscode-api/vscode/vs/base/common/keyCodes'
import { KeybindingsRegistry, KeybindingWeight } from '@codingame/monaco-vscode-api/vscode/vs/platform/keybinding/common/keybindingsRegistry'

/** 全局 Quick Pick / Command Palette（Ctrl/Cmd+Shift+P）对应命令 id */
export const SHOW_COMMANDS = 'workbench.action.showCommands'

/** Remove default bindings before initialization so the empty-editor watermark omits this command. */
export function removeEmbedCommandPaletteKeybindings(): void {
  KeybindingsRegistry.registerKeybindingRule({
    id: `-${SHOW_COMMANDS}`,
    weight: KeybindingWeight.WorkbenchContrib,
    primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyP,
    secondary: [KeyCode.F1]
  })
}

/** 防止热重载或重复 initialize 时多次 register */
let embedCommandPaletteBlockInstalled = false

/**
 * 在 `@codingame/monaco-vscode-api` 的 `initialize` 完成之后调用。
 *
 * 对 `executeCommand` / 原型做 monkey patch 在本环境下会被实例自有方法挡住快捷键路径；
 * 改为对同一 id 再注册一层 handler：`CommandsRegistry` 用链表 unshift，`getCommand`
 * 取到的第一个即本 no-op，从而不会执行内置的 QuickAccess.show。
 */
export function installEmbedCommandPaletteBlock(): void {
  if (embedCommandPaletteBlockInstalled) {
    return
  }
  embedCommandPaletteBlockInstalled = true

  // 覆盖列表头：优先于 Workbench 已注册的 ShowAllCommandsAction
  CommandsRegistry.registerCommand(SHOW_COMMANDS, () => {
    console.warn('[aily-coder-editor] Command Palette disabled:', SHOW_COMMANDS)
  })
}
