import type { IWorkbenchLayoutService } from '@codingame/monaco-vscode-api'
import { Parts } from '@codingame/monaco-vscode-workbench-service-override'

/** 宿主 → iframe：请求重排 workbench（右侧面板开关导致 iframe 变窄时） */
export const CODER_HOST_LAYOUT_REFRESH_CHANNEL = 'aily-coder-editor-host-layout-refresh'

function runLayoutRefresh(layoutService: IWorkbenchLayoutService): void {
  try {
    layoutService.layout()
  } catch {
    /* workbench 未就绪时忽略 */
  }
  window.dispatchEvent(new Event('resize'))
}

/**
 * iframe 尺寸变化或宿主右侧面板开关时重排 workbench。
 */
export function installEmbedLayoutSync(layoutService: IWorkbenchLayoutService): void {
  try {
    layoutService.setPartHidden(true, Parts.AUXILIARYBAR_PART)
  } catch {
    /* ignore */
  }

  document.documentElement.style.height = '100%'
  document.documentElement.style.width = '100%'
  document.documentElement.style.overflow = 'hidden'
  document.body.style.height = '100%'
  document.body.style.width = '100%'
  document.body.style.margin = '0'
  document.body.style.overflow = 'hidden'

  const vc = (window as Window & { vscodeContainer?: HTMLElement }).vscodeContainer
  if (vc) {
    vc.style.width = '100%'
    vc.style.height = '100%'
    vc.style.overflow = 'hidden'
  }

  const refresh = () => runLayoutRefresh(layoutService)

  const ro = new ResizeObserver(() => refresh())
  ro.observe(document.documentElement)

  window.addEventListener('message', (ev: MessageEvent) => {
    if (!window.parent || ev.source !== window.parent) {
      return
    }
    if ((ev.data as { channel?: string })?.channel === CODER_HOST_LAYOUT_REFRESH_CHANNEL) {
      refresh()
    }
  })
}
