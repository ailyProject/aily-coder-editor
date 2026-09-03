import { IEditorService, StandaloneServices } from '@codingame/monaco-vscode-api'

export const HOST_LIFECYCLE_REQUEST_CHANNEL = 'aily-coder-editor-host-lifecycle-request'
export const HOST_LIFECYCLE_RESPONSE_CHANNEL = 'aily-coder-editor-host-lifecycle-response'

type HostLifecycleAction = 'status' | 'save-all'

type HostLifecycleRequest = {
  channel?: string
  requestId?: string
  action?: HostLifecycleAction
}

let installed = false

export function installHostLifecycleBridge(): void {
  if (installed || typeof window === 'undefined') {
    return
  }
  installed = true

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
}> {
  try {
    const editorService = StandaloneServices.get(IEditorService)
    const dirtyBefore = countDirtyEditors(editorService)

    if (request.action === 'status') {
      return { ok: true, dirtyBefore, dirtyAfter: dirtyBefore }
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
