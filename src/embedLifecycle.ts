export const AILY_CODER_READY_PROTOCOL_CHANNEL = 'aily-coder-ready-protocol'
export const AILY_CODER_READY_CHANNEL = 'aily-coder-ready'

const LIFECYCLE_PROTOCOL_VERSION = 1

function postLifecycleMessage(channel: string): void {
  if (window.parent === window) {
    return
  }
  window.parent.postMessage(
    {
      channel,
      version: LIFECYCLE_PROTOCOL_VERSION
    },
    '*'
  )
}

/**
 * 尽早通知宿主：当前 Coder 会在真实 workbench 首帧完成后再发送 ready。
 * 宿主据此取消旧版本的 iframe-load 定时兜底。
 */
export function announceAilyCoderReadyProtocol(): void {
  postLifecycleMessage(AILY_CODER_READY_PROTOCOL_CHANNEL)
}

/**
 * Monaco 初始化完成后再等待两帧，确保首屏布局已经提交到 iframe。
 */
export async function announceAilyCoderWorkbenchReady(): Promise<void> {
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  })
  postLifecycleMessage(AILY_CODER_READY_CHANNEL)
}
