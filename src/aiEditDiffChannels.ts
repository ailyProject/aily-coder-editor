/** 宿主 Angular ↔ 内嵌 aily-coder iframe：AI 编辑 Diff 预览通道 */

export const AILY_CODER_AI_EDIT_DIFF_CHANNEL = 'aily-coder-ai-edit-diff'
export const AILY_CODER_AI_EDIT_DIFF_RESULT_CHANNEL = 'aily-coder-ai-edit-diff-result'

export type AiEditDiffFileType = 'create' | 'modify' | 'delete'

export interface AiEditDiffFilePayload {
  filePath: string
  baselineContent: string
  /** 磁盘当前内容；省略时 iframe 侧读 modified URI */
  currentContent?: string
  type: AiEditDiffFileType
}

export interface AiEditDiffOpenPayload {
  previewId: string
  title: string
  files: readonly AiEditDiffFilePayload[]
  /** 单文件预览时聚焦该路径 */
  focusFilePath?: string
}

export type AiEditDiffHostMessage =
  | { channel: typeof AILY_CODER_AI_EDIT_DIFF_CHANNEL; op: 'open'; payload: AiEditDiffOpenPayload }
  | { channel: typeof AILY_CODER_AI_EDIT_DIFF_CHANNEL; op: 'close'; payload?: { previewId?: string } }

export type AiEditDiffResultAction = 'acceptFile' | 'rejectFile' | 'acceptAll' | 'rejectAll'

export interface AiEditDiffResultPayload {
  channel: typeof AILY_CODER_AI_EDIT_DIFF_RESULT_CHANNEL
  previewId: string
  action: AiEditDiffResultAction
  filePath?: string
}
