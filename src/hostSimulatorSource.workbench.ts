import { getService, IEditorService, IFileService, ITextFileService } from '@codingame/monaco-vscode-api'
import { URI } from '@codingame/monaco-vscode-api/vscode/vs/base/common/uri'
import * as monaco from 'monaco-editor'
import {
  createSimulatorSourceReceiver,
  HOST_SIMULATOR_SOURCE_RESPONSE,
  MAX_SIMULATOR_SOURCE_BYTES,
  normalizeSimulatorSourceText,
  readSimulatorSourceHostOrigin,
  readSimulatorSourceRequest
} from './hostSimulatorSource'

export function installHostSimulatorSourceBridge(workspaceRoot: string): void {
  const parent = window.parent
  const origin = readSimulatorSourceHostOrigin(new URL(window.location.href).searchParams.get('simulatorSourceHostOrigin'))
  if (parent === window || !origin) return

  const root = URI.file(workspaceRoot)
  const resourceFor = (path: string) => URI.joinPath(root, path)
  const receiver = createSimulatorSourceReceiver({
    async read(path) {
      const files = await getService(IFileService)
      return (await files.readFile(resourceFor(path), { limits: { size: MAX_SIMULATOR_SOURCE_BYTES } })).value.buffer
    },
    async show(request, sourceText, isCurrent) {
      const resource = resourceFor(request.path)
      const [editors, textFiles] = await Promise.all([getService(IEditorService), getService(ITextFileService)])
      const reference = await monaco.editor.createModelReference(resource)
      try {
        const model = reference.object.textEditorModel
        if (!model) return null
        const matches = () => isCurrent() && !model.isDisposed() && !textFiles.isDirty(resource)
          && request.line <= model.getLineCount() && normalizeSimulatorSourceText(model.getValue()) === sourceText
        if (!matches()) return null

        const pane = await editors.openEditor({ resource, options: { pinned: true, preserveFocus: !request.focus } })
        const editor = monaco.editor.getEditors().find(candidate => candidate === pane?.getControl() && candidate.getModel() === model)
        if (!editor || !matches()) return null

        const range = new monaco.Range(request.line, 1, request.line, 1)
        const decoration = editor.createDecorationsCollection([{
          range, options: {
            isWholeLine: true,
            className: 'aily-simulator-source-stop',
            linesDecorationsClassName: 'aily-simulator-source-stop-gutter'
          }
        }])
        const change = model.onDidChangeContent(clear)
        const detach = editor.onDidChangeModel(clear)
        const dispose = editor.onDidDispose(clear)
        function clear() {
          decoration.clear()
          change.dispose()
          detach.dispose()
          dispose.dispose()
        }
        editor.revealLineInCenterIfOutsideViewport(request.line)
        return clear
      } finally {
        reference.dispose()
      }
    }
  })

  let probed = false
  const onMessage = (event: MessageEvent) => {
    if (event.source !== parent || event.origin !== origin) return
    const request = readSimulatorSourceRequest(event.data)
    if (!request) return
    if (request.action === 'probe') {
      probed = true
      parent.postMessage({ channel: HOST_SIMULATOR_SOURCE_RESPONSE, v: 1,
        action: 'ready', requestId: request.requestId }, origin)
      return
    }
    if (!probed) return
    void receiver.receive(request).then(status => {
      parent.postMessage({ channel: HOST_SIMULATOR_SOURCE_RESPONSE, v: 1,
        requestId: request.requestId, sequence: request.sequence, status }, origin)
    })
  }
  window.addEventListener('message', onMessage)
  window.addEventListener('pagehide', () => {
    window.removeEventListener('message', onMessage)
    receiver.close()
  }, { once: true })
}
