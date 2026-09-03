import {
  AILY_CODER_EDITOR_AI_EDIT_DIFF_CHANNEL,
  type AiEditDiffHostMessage
} from './aiEditDiffChannels.js'
import { closeAiEditDiffPreview, openAiEditDiffPreview } from './features/aiEditDiff.js'

function isAiEditDiffHostMessage(data: unknown): data is AiEditDiffHostMessage {
  if (typeof data !== 'object' || data == null) {
    return false
  }
  const msg = data as { channel?: string; op?: string }
  return msg.channel === AILY_CODER_EDITOR_AI_EDIT_DIFF_CHANNEL && typeof msg.op === 'string'
}

export function installAiEditDiffBridgeListener(): void {
  installAiEditDiffBridgeListenerImpl()
}

function installAiEditDiffBridgeListenerImpl(): void {
  window.addEventListener('message', (ev: MessageEvent) => {
    if (ev.source !== window.parent) {
      return
    }
    if (!isAiEditDiffHostMessage(ev.data)) {
      return
    }

    const msg = ev.data
    if (msg.op === 'open') {
      void openAiEditDiffPreview(msg.payload)
      return
    }
    if (msg.op === 'close') {
      void closeAiEditDiffPreview(msg.payload?.previewId)
    }
  })
}

installAiEditDiffBridgeListener()
