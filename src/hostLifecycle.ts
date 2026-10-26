import { ICommandService, IEditorService, ITextFileService, StandaloneServices, getService } from '@codingame/monaco-vscode-api'
import { VSBuffer, readableToBuffer } from '@codingame/monaco-vscode-api/vscode/vs/base/common/buffer'
import { captureProjectCopy } from './projectCopySnapshot'

export const HOST_LIFECYCLE_REQUEST_CHANNEL = 'aily-coder-editor-host-lifecycle-request'
export const HOST_LIFECYCLE_RESPONSE_CHANNEL = 'aily-coder-editor-host-lifecycle-response'
export const HOST_LIFECYCLE_SAVE_CHANNEL = 'aily-coder-editor-project-save'

export function requestHostProjectSave(): void {
  if (typeof window !== 'undefined' && window.parent !== window) {
    window.parent.postMessage({ channel: HOST_LIFECYCLE_SAVE_CHANNEL }, '*')
  }
}

type HostLifecycleAction = 'status' | 'save-all' | 'copy-snapshot' | 'check-copy-snapshot' | 'complete-copy-snapshot'

type HostLifecycleRequest = {
  channel?: string
  requestId?: string
  action?: HostLifecycleAction
  snapshotToken?: string
}

let installed = false
let copySnapshot: { token: string; assertCurrent(): void; complete(): Promise<void> } | undefined

export function installHostLifecycleBridge(): void {
  if (installed || typeof window === 'undefined') {
    return
  }
  installed = true

  // Monaco owns editor/menu shortcuts inside the iframe. An explicit Save also
  // commits pending project libraries; host saveAll calls the editor service
  // directly, so this command listener cannot recurse or react to auto-save.
  const saveCommands = new Set(['workbench.action.files.save', 'saveAll',
    'workbench.action.files.saveWithoutFormatting', 'workbench.files.action.saveAllInGroup',
    'workbench.action.files.saveFiles'])
  void getService(ICommandService).then(commands => commands.onDidExecuteCommand(event => {
    if (saveCommands.has(event.commandId)) requestHostProjectSave()
  }))

  window.addEventListener('message', event => {
    const request = event.data as HostLifecycleRequest
    if (
      event.source !== window.parent ||
      request?.channel !== HOST_LIFECYCLE_REQUEST_CHANNEL ||
      typeof request.requestId !== 'string' ||
      !request.requestId
    ) {
      return
    }

    void handleHostLifecycleRequest(request).then(response => {
      window.parent.postMessage(
        {
          channel: HOST_LIFECYCLE_RESPONSE_CHANNEL,
          requestId: request.requestId,
          action: request.action,
          ...response
        },
        '*'
      )
    })
  })
}

async function handleHostLifecycleRequest(request: HostLifecycleRequest): Promise<{
  ok: boolean
  dirtyBefore: number
  dirtyAfter: number
  message?: string
  snapshotToken?: string
  files?: Array<{ path: string; bytes: Uint8Array }>
}> {
  try {
    const editorService = StandaloneServices.get(IEditorService)
    const dirtyBefore = countDirtyEditors(editorService)

    if (request.action === 'status') {
      return { ok: true, dirtyBefore, dirtyAfter: dirtyBefore }
    }
    if (request.action === 'check-copy-snapshot' || request.action === 'complete-copy-snapshot') {
      if (!copySnapshot || request.snapshotToken !== copySnapshot.token) throw new Error('Save As snapshot expired')
      copySnapshot.assertCurrent()
      if (request.action === 'complete-copy-snapshot') {
        await copySnapshot.complete()
        copySnapshot = undefined
      }
      return { ok: true, dirtyBefore, dirtyAfter: dirtyBefore }
    }
    if (request.action === 'copy-snapshot') {
      const textFiles = StandaloneServices.get(ITextFileService)
      const read = () => {
        const models = textFiles.files.models.filter(model => model.isDirty())
        if (editorService.editors.some(editor => editor.isDirty() &&
          !models.some(model => model.resource.toString() === editor.resource?.toString()))) {
          throw new Error('Save named text files before copying this project; an untitled or custom editor has unsaved changes.')
        }
        return models.map(model => {
          if (model.resource.scheme !== 'file' || !model.isResolved()) throw new Error('Unsupported dirty editor in project copy')
          return { path: model.resource.fsPath, version: model.textEditorModel.getVersionId(),
            encoding: model.getEncoding(), text: model.textEditorModel.getValue() }
        }).sort((a, b) => a.path.localeCompare(b.path))
      }
      const snapshot = await captureProjectCopy(read, async value => {
        const model = textFiles.files.models.find(model => model.resource.fsPath === value.path)!
        const encoded = await textFiles.getEncodedReadable(model.resource, value.text, { encoding: value.encoding })
        return (encoded instanceof VSBuffer ? encoded : readableToBuffer(encoded)).buffer.slice()
      })
      const token = crypto.randomUUID()
      const sources = textFiles.files.models.filter(model => snapshot.files.some(file => file.path === model.resource.fsPath))
        .map(model => ({ model, version: model.isResolved() ? model.textEditorModel.getVersionId() : -1 }))
      copySnapshot = { token, assertCurrent: snapshot.assertCurrent, complete: async () => {
        snapshot.assertCurrent()
        for (const { model, version } of sources) {
          // Check each source again after previous asynchronous reverts. Preserve any new edit.
          if (!model.isResolved() || model.textEditorModel.getVersionId() !== version) {
            throw new Error('The copy is saved. New edits in the original editor were preserved.')
          }
          await model.revert()
        }
      } }
      return { ok: true, dirtyBefore, dirtyAfter: dirtyBefore, snapshotToken: token, files: snapshot.files }
    }
    if (request.action !== 'save-all') {
      return {
        ok: false,
        dirtyBefore,
        dirtyAfter: dirtyBefore,
        message: `Unsupported host lifecycle action: ${String(request.action || '')}`
      }
    }

    const result = await editorService.saveAll({ includeUntitled: false })
    const dirtyAfter = countDirtyEditors(editorService)
    return result.success && dirtyAfter === 0
      ? { ok: true, dirtyBefore, dirtyAfter }
      : {
          ok: false,
          dirtyBefore,
          dirtyAfter,
          message: 'Some code editors could not be saved'
        }
  } catch (error) {
    return {
      ok: false,
      dirtyBefore: 0,
      dirtyAfter: 0,
      message: error instanceof Error ? error.message : String(error)
    }
  }
}

function countDirtyEditors(editorService: IEditorService): number {
  return editorService.editors.filter(editor => editor.isDirty()).length
}
