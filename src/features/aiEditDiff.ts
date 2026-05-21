import {
  ExtensionHostKind,
  registerExtension,
  type IExtensionManifest
} from '@codingame/monaco-vscode-api/extensions'
import * as vscode from 'vscode'
import {
  AILY_CODER_AI_EDIT_DIFF_RESULT_CHANNEL,
  type AiEditDiffFilePayload,
  type AiEditDiffOpenPayload,
  type AiEditDiffResultAction
} from '../aiEditDiffChannels.js'

const BASELINE_SCHEME = 'aily-ai-baseline'
const MODIFIED_SCHEME = 'aily-ai-modified'

const baselineContentByKey = new Map<string, string>()
const modifiedContentByKey = new Map<string, string>()
const previewFilesById = new Map<string, readonly AiEditDiffFilePayload[]>()
let activePreviewId: string | null = null

function baselineStoreKey(previewId: string, filePath: string): string {
  return `${previewId}\0${filePath}`
}

function normalizeFsPath(filePath: string): string {
  return filePath.replace(/\\/g, '/')
}

function createBaselineUri(previewId: string, filePath: string): vscode.Uri {
  const normalized = normalizeFsPath(filePath)
  return vscode.Uri.from({
    scheme: BASELINE_SCHEME,
    path: normalized.startsWith('/') ? normalized : `/${normalized}`,
    query: `previewId=${encodeURIComponent(previewId)}`
  })
}

function createModifiedUri(previewId: string, file: AiEditDiffFilePayload): vscode.Uri {
  if (file.type === 'delete') {
    const normalized = normalizeFsPath(file.filePath)
    modifiedContentByKey.set(
      baselineStoreKey(previewId, file.filePath),
      file.currentContent ?? ''
    )
    return vscode.Uri.from({
      scheme: MODIFIED_SCHEME,
      path: normalized.startsWith('/') ? normalized : `/${normalized}`,
      query: `previewId=${encodeURIComponent(previewId)}`
    })
  }
  return vscode.Uri.file(file.filePath)
}

function lookupBaselineContent(previewId: string, uri: vscode.Uri): string {
  const candidates = [uri.fsPath, uri.path, decodeURIComponent(uri.path)].filter(Boolean)
  for (const candidate of candidates) {
    const hit = baselineContentByKey.get(baselineStoreKey(previewId, candidate))
    if (hit != null) {
      return hit
    }
  }
  return ''
}

function lookupModifiedContent(previewId: string, uri: vscode.Uri): string {
  const candidates = [uri.fsPath, uri.path, decodeURIComponent(uri.path)].filter(Boolean)
  for (const candidate of candidates) {
    const hit = modifiedContentByKey.get(baselineStoreKey(previewId, candidate))
    if (hit != null) {
      return hit
    }
  }
  return ''
}

function basename(filePath: string): string {
  const parts = normalizeFsPath(filePath).split('/')
  return parts[parts.length - 1] || filePath
}

function postResultToHost(
  previewId: string,
  action: AiEditDiffResultAction,
  filePath?: string
): void {
  if (window.parent == null || window.parent === window) {
    return
  }
  window.parent.postMessage(
    {
      channel: AILY_CODER_AI_EDIT_DIFF_RESULT_CHANNEL,
      previewId,
      action,
      ...(filePath ? { filePath } : {})
    },
    '*'
  )
}

async function openSingleFileDiff(
  previewId: string,
  file: AiEditDiffFilePayload,
  title?: string
): Promise<void> {
  const originalUri = createBaselineUri(previewId, file.filePath)
  const modifiedUri = createModifiedUri(previewId, file)
  const label = title ?? `${basename(file.filePath)} (AI 编辑)`
  await vscode.commands.executeCommand(
    'vscode.diff',
    originalUri,
    modifiedUri,
    label,
    { preview: false, preserveFocus: false }
  )
}

async function openMultiFileDiff(previewId: string, title: string, files: readonly AiEditDiffFilePayload[]): Promise<void> {
  const resources: [vscode.Uri, vscode.Uri, vscode.Uri][] = files.map((file) => {
    const label = vscode.Uri.file(file.filePath)
    const original = createBaselineUri(previewId, file.filePath)
    const modified = createModifiedUri(previewId, file)
    return [label, original, modified]
  })
  await vscode.commands.executeCommand('vscode.changes', title, resources)
}

export async function openAiEditDiffPreview(payload: AiEditDiffOpenPayload): Promise<void> {
  const files = payload.files.filter((file) => file.filePath.trim().length > 0)
  if (files.length === 0) {
    return
  }

  for (const file of files) {
    baselineContentByKey.set(
      baselineStoreKey(payload.previewId, file.filePath),
      file.baselineContent ?? ''
    )
  }

  previewFilesById.set(payload.previewId, files)
  activePreviewId = payload.previewId

  const title = payload.title.trim() || 'AI 编辑预览'

  if (payload.focusFilePath) {
    const focus = files.find((file) => file.filePath === payload.focusFilePath)
    if (focus) {
      await openSingleFileDiff(payload.previewId, focus, `${basename(focus.filePath)} (AI 编辑)`)
      return
    }
  }

  if (files.length === 1) {
    await openSingleFileDiff(payload.previewId, files[0]!, title)
    return
  }

  await openMultiFileDiff(payload.previewId, title, files)
}

export async function closeAiEditDiffPreview(previewId?: string): Promise<void> {
  const targetId = previewId ?? activePreviewId
  if (!targetId) {
    return
  }

  const files = previewFilesById.get(targetId) ?? []
  for (const file of files) {
    baselineContentByKey.delete(baselineStoreKey(targetId, file.filePath))
    modifiedContentByKey.delete(baselineStoreKey(targetId, file.filePath))
  }
  previewFilesById.delete(targetId)

  if (activePreviewId === targetId) {
    activePreviewId = null
  }

  try {
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor')
  } catch {
    /* ignore */
  }
}

const aiEditDiffManifest = {
  name: 'aily-ai-edit-diff',
  publisher: 'aily',
  version: '0.0.1',
  engines: {
    vscode: '*'
  },
  activationEvents: ['*'],
  contributes: {
    commands: [
      {
        command: 'aily.aiEditDiff.acceptAll',
        title: '接受全部 AI 编辑',
        icon: '$(check-all)'
      },
      {
        command: 'aily.aiEditDiff.rejectAll',
        title: '拒绝全部 AI 编辑',
        icon: '$(discard)'
      }
    ]
  }
} as unknown as IExtensionManifest

const { getApi } = registerExtension(aiEditDiffManifest, ExtensionHostKind.LocalProcess, {
  system: true
})

void getApi().then((api) => {
  api.workspace.registerTextDocumentContentProvider(BASELINE_SCHEME, {
    provideTextDocumentContent(uri: vscode.Uri): string {
      const previewId = new URLSearchParams(uri.query).get('previewId') ?? ''
      return lookupBaselineContent(previewId, uri)
    }
  })

  api.workspace.registerTextDocumentContentProvider(MODIFIED_SCHEME, {
    provideTextDocumentContent(uri: vscode.Uri): string {
      const previewId = new URLSearchParams(uri.query).get('previewId') ?? ''
      return lookupModifiedContent(previewId, uri)
    }
  })

  api.commands.registerCommand('aily.aiEditDiff.acceptAll', async () => {
    if (!activePreviewId) {
      return
    }
    postResultToHost(activePreviewId, 'acceptAll')
    await closeAiEditDiffPreview(activePreviewId)
  })

  api.commands.registerCommand('aily.aiEditDiff.rejectAll', async () => {
    if (!activePreviewId) {
      return
    }
    postResultToHost(activePreviewId, 'rejectAll')
    await closeAiEditDiffPreview(activePreviewId)
  })
})
