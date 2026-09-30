import { URI } from '@codingame/monaco-vscode-api/vscode/vs/base/common/uri'
import { dirname, extUri, extUriIgnorePathCase } from '@codingame/monaco-vscode-api/vscode/vs/base/common/resources'
import { isCaseSensitiveNativeFsRoot } from '../nativeFsWatchEvent.js'

/** Capture entries during the drop event, before the browser protects DataTransfer. */
export function captureDroppedEntries(transfer: DataTransfer): FileSystemEntry[] {
  const entries: FileSystemEntry[] = []
  for (const item of Array.from(transfer.items)) {
    if (item.kind !== 'file') continue
    const entry = item.webkitGetAsEntry?.()
    if (entry) {
      entries.push(entry)
    } else {
      const file = item.getAsFile()
      if (file) entries.push(fileEntry(file))
    }
  }
  if (entries.length === 0) {
    for (const file of Array.from(transfer.files)) entries.push(fileEntry(file))
  }
  return entries
}

/** Retain a DragEvent shape for VS Code's uploader without retaining protected data. */
export function snapshotFileDrop(event: DragEvent): DragEvent {
  if (!event.dataTransfer) return event
  const entries = captureDroppedEntries(event.dataTransfer)
  const snapshot = new DragEvent('drop')
  Object.defineProperty(snapshot, 'dataTransfer', {
    value: {
      types: ['Files'],
      files: [],
      items: entries.map(entry => ({ kind: 'file', webkitGetAsEntry: () => entry }))
    }
  })
  return snapshot
}

function fileEntry(file: File): FileSystemFileEntry {
  // BrowserFileUpload consumes the same minimal entry shape for file-picker input.
  return {
    name: file.name,
    isFile: true,
    isDirectory: false,
    file: (resolve: FileCallback) => resolve(file)
  } as FileSystemFileEntry
}

export function isFileTransfer(transfer: DataTransfer | null): boolean {
  return transfer != null && Array.from(transfer.types).some(type => type.toLowerCase() === 'files')
}

export type AilyDropTarget = {
  contextValue?: string
  resourceUri?: URI
}

/** Virtual groups map to their backing directories; unrelated virtual nodes reject drops. */
export function resolveAilyDropDirectory(root: URI, target?: AilyDropTarget): URI | undefined {
  if (!target) return URI.joinPath(root, 'sketch/src')
  const context = target.contextValue ?? ''
  if (context === 'aily.group:config') return root
  if (context === 'aily.status:component-libraries-empty') return URI.joinPath(root, 'sketch/libraries')
  const resource = target.resourceUri
  if (!resource || !/^aily\.(directory|file):/.test(context)) return undefined
  const paths = isCaseSensitiveNativeFsRoot(root.fsPath) ? extUri : extUriIgnorePathCase
  if (!paths.isEqualOrParent(resource, root)) return undefined
  return context.startsWith('aily.directory:') ? resource : dirname(resource)
}
