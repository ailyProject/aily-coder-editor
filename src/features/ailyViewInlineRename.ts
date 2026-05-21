import type * as vscode from 'vscode'
import { getCoderWorkbenchQueryRoot } from '../coderWorkbenchDom.js'

/** Worker Extension Host → iframe 主线程：虚拟树行内重命名 UI */
export const AILY_VIEW_INLINE_RENAME_CHANNEL = 'aily-view-inline-rename'

type UiResult =
  | { result: 'committed'; newName: string }
  | { result: 'cancelled' }
  | { result: 'unavailable' }

export type VirtualTreeInlineRenameResult = 'committed' | 'cancelled' | 'unavailable'

export type VirtualTreeInlineRenameOptions = {
  treeView: vscode.TreeView<unknown>
  element: unknown
  currentName: string
  isDirectory: boolean
  validateName: (name: string) => string | undefined
  onCommit: (newName: string) => Promise<void>
}

let activeCleanup: (() => void) | null = null
let bridgeReqSeq = 0

function cancelActiveUi(): void {
  activeCleanup?.()
  activeCleanup = null
}

export function validateRenameEntryName(name: string): string | undefined {
  const trimmed = name.trim()
  if (!trimmed) {
    return '名称不能为空'
  }
  if (/[<>:"/\\|?*]/.test(trimmed)) {
    return '名称包含非法字符: < > : " / \\ | ? *'
  }
  const reserved = new Set([
    'CON', 'PRN', 'AUX', 'NUL',
    'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
    'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9'
  ])
  if (reserved.has(trimmed.toUpperCase())) {
    return '不能使用系统保留名称'
  }
  return undefined
}

function canUseLocalDom(): boolean {
  try {
    return typeof document !== 'undefined' && getCoderWorkbenchQueryRoot().querySelector('.customview-tree') != null
  } catch {
    return false
  }
}

const LABEL_SEL =
  '.label-name, .monaco-highlighted-label, .custom-view-tree-node-item-resourceLabel .monaco-icon-name-container'
const ROW_SELS = [
  '.monaco-list-row.selected.focused',
  '.monaco-list-row.selected',
  '.monaco-list-row.focused',
  '.monaco-list-row[aria-selected="true"]',
  '.monaco-list-row'
]

function findTreeLabel(nameHint: string): HTMLElement | null {
  const hint = nameHint.trim()
  const root = getCoderWorkbenchQueryRoot()
  for (const tree of root.querySelectorAll('.customview-tree')) {
    for (const rowSel of ROW_SELS) {
      for (const row of tree.querySelectorAll(rowSel)) {
        for (const node of row.querySelectorAll(LABEL_SEL)) {
          if (!(node instanceof HTMLElement)) {
            continue
          }
          const text = node.textContent?.trim() ?? ''
          if (text === hint || text.endsWith(hint)) {
            return node
          }
        }
      }
    }
  }
  return null
}

async function waitForTreeLabel(nameHint: string, maxFrames = 24): Promise<HTMLElement | null> {
  for (let i = 0; i < maxFrames; i++) {
    const label = findTreeLabel(nameHint)
    if (label != null) {
      return label
    }
    await new Promise<void>((r) => requestAnimationFrame(() => r()))
  }
  return null
}

/** 在主线程 DOM 上挂载行内重命名输入框（仅 UI，不做磁盘写入） */
async function runDomUi(options: { currentName: string; isDirectory: boolean }): Promise<UiResult> {
  cancelActiveUi()
  if (typeof document === 'undefined') {
    return { result: 'unavailable' }
  }

  await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
  const labelEl = await waitForTreeLabel(options.currentName)
  if (labelEl == null) {
    return { result: 'unavailable' }
  }

  const itemContainer =
    labelEl.closest('.custom-view-tree-node-item') ??
    labelEl.closest('.monaco-list-row') ??
    labelEl.parentElement
  if (itemContainer == null) {
    return { result: 'unavailable' }
  }

  const resourceLabel = itemContainer.querySelector('.custom-view-tree-node-item-resourceLabel')
  const labelHost = resourceLabel instanceof HTMLElement ? resourceLabel : itemContainer

  return new Promise<UiResult>((resolve) => {
    let finished = false
    let allowBlurCommit = false
    const hidden: Array<[HTMLElement, string]> = []
    const hide = (el: HTMLElement | null | undefined): void => {
      if (el == null) {
        return
      }
      hidden.push([el, el.style.display])
      el.style.display = 'none'
    }

    const input = document.createElement('input')
    input.type = 'text'
    input.className = 'aily-view-inline-rename-input'
    input.value = options.currentName
    input.setAttribute('aria-label', '重命名')
    input.style.cssText =
      'font:inherit;color:var(--vscode-input-foreground);background:var(--vscode-input-background);' +
      'border:1px solid var(--vscode-focusBorder);outline:none;padding:0 2px;height:22px;min-width:120px;' +
      'width:calc(100% - 4px);box-sizing:border-box;margin-left:2px'

    hide(labelEl)
    if (resourceLabel instanceof HTMLElement && resourceLabel !== labelEl) {
      for (const child of resourceLabel.children) {
        if (child instanceof HTMLElement && !child.classList.contains('actions')) {
          hide(child)
        }
      }
    }
    labelHost.appendChild(input)

    const lastDot = options.currentName.lastIndexOf('.')
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        input.focus()
        if (!options.isDirectory && lastDot > 0) {
          input.setSelectionRange(0, lastDot)
        } else {
          input.select()
        }
        allowBlurCommit = true
      })
    )

    const cleanup = (result: UiResult): void => {
      if (finished) {
        return
      }
      finished = true
      input.remove()
      for (const [el, display] of hidden) {
        el.style.display = display
      }
      activeCleanup = null
      resolve(result)
    }
    activeCleanup = () => cleanup({ result: 'cancelled' })

    const tryCommit = (): void => {
      const trimmed = input.value.trim()
      cleanup(
        !trimmed || trimmed === options.currentName
          ? { result: 'cancelled' }
          : { result: 'committed', newName: trimmed }
      )
    }

    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault()
        ev.stopPropagation()
        tryCommit()
      } else if (ev.key === 'Escape') {
        ev.preventDefault()
        ev.stopPropagation()
        cleanup({ result: 'cancelled' })
      }
    })
    input.addEventListener('mousedown', (ev) => ev.stopPropagation())
    input.addEventListener('blur', () => {
      if (!allowBlurCommit) {
        return
      }
      requestAnimationFrame(() => {
        if (document.activeElement !== input) {
          tryCommit()
        }
      })
    })
  })
}

function requestUiViaBridge(options: { currentName: string; isDirectory: boolean }): Promise<UiResult> {
  if (typeof BroadcastChannel === 'undefined') {
    return Promise.resolve({ result: 'unavailable' })
  }
  const reqId = ++bridgeReqSeq
  return new Promise<UiResult>((resolve) => {
    const ch = new BroadcastChannel(AILY_VIEW_INLINE_RENAME_CHANNEL)
    const timer = setTimeout(() => {
      cleanup()
      resolve({ result: 'unavailable' })
    }, 30000)

    const onMessage = (ev: MessageEvent<{ reqId?: number; result?: string; newName?: string }>): void => {
      const data = ev.data
      if (data?.reqId !== reqId) {
        return
      }
      cleanup()
      if (data.result === 'committed' && typeof data.newName === 'string') {
        resolve({ result: 'committed', newName: data.newName })
      } else if (data.result === 'cancelled') {
        resolve({ result: 'cancelled' })
      } else {
        resolve({ result: 'unavailable' })
      }
    }

    const cleanup = (): void => {
      clearTimeout(timer)
      ch.removeEventListener('message', onMessage)
      try {
        ch.close()
      } catch {
        /* ignore */
      }
    }

    ch.addEventListener('message', onMessage)
    ch.postMessage({
      reqId,
      op: 'start',
      currentName: options.currentName,
      isDirectory: options.isDirectory
    })
  })
}

async function requestUi(options: { currentName: string; isDirectory: boolean }): Promise<UiResult> {
  return canUseLocalDom() ? runDomUi(options) : requestUiViaBridge(options)
}

/** 在虚拟目录树当前行注入内联输入框（对齐 Explorer F2 rename，不跳转真实 Explorer） */
export async function startVirtualTreeInlineRename(
  options: VirtualTreeInlineRenameOptions
): Promise<VirtualTreeInlineRenameResult> {
  cancelActiveUi()
  void Promise.resolve(options.treeView.reveal(options.element, { select: true, focus: true, expand: true })).catch(
    () => {}
  )

  const ui = await requestUi({
    currentName: options.currentName,
    isDirectory: options.isDirectory
  })
  if (ui.result !== 'committed') {
    return ui.result
  }

  const validationError = options.validateName(ui.newName)
  if (validationError != null) {
    throw new Error(validationError)
  }
  await options.onCommit(ui.newName)
  return 'committed'
}

/** 在 iframe 主线程安装 BroadcastChannel 监听，供 Worker 扩展触发 DOM 内联重命名 */
export function installAilyViewInlineRenameHost(): void {
  if (typeof BroadcastChannel === 'undefined') {
    return
  }
  try {
    const ch = new BroadcastChannel(AILY_VIEW_INLINE_RENAME_CHANNEL)
    ch.addEventListener(
      'message',
      (ev: MessageEvent<{ reqId?: number; op?: string; currentName?: string; isDirectory?: boolean }>) => {
        const data = ev.data
        if (data?.op !== 'start' || typeof data.reqId !== 'number') {
          return
        }
        void (async (): Promise<void> => {
          cancelActiveUi()
          const ui = await runDomUi({
            currentName: data.currentName ?? '',
            isDirectory: data.isDirectory ?? false
          })
          ch.postMessage({
            reqId: data.reqId,
            result: ui.result,
            ...(ui.result === 'committed' ? { newName: ui.newName } : {})
          })
        })()
      }
    )
  } catch {
    /* ignore */
  }
}
