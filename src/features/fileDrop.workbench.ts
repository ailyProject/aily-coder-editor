import {
  createInstance,
  getService,
  IConfigurationService,
  IFileService
} from '@codingame/monaco-vscode-api'
import { Emitter } from '@codingame/monaco-vscode-api/vscode/vs/base/common/event'
import { URI } from '@codingame/monaco-vscode-api/vscode/vs/base/common/uri'
import { ListDragOverEffectType } from '@codingame/monaco-vscode-api/vscode/vs/base/browser/ui/list/list'
import { IDialogService } from '@codingame/monaco-vscode-api/vscode/vs/platform/dialogs/common/dialogs.service'
import { IWorkspaceContextService } from '@codingame/monaco-vscode-api/vscode/vs/platform/workspace/common/workspace.service'
import { CustomTreeViewDragAndDrop } from '@codingame/monaco-vscode-api/vscode/vs/workbench/browser/parts/views/treeView'
import { BrowserFileUpload } from '@codingame/monaco-vscode-api/vscode/vs/workbench/contrib/files/browser/fileImportExport'
import { IExplorerService } from '@codingame/monaco-vscode-api/vscode/vs/workbench/contrib/files/browser/files.service'
import { ExplorerItem } from '@codingame/monaco-vscode-api/vscode/vs/workbench/contrib/files/common/explorerModel'
import { IFilesConfigurationService } from '@codingame/monaco-vscode-api/vscode/vs/workbench/services/filesConfiguration/common/filesConfigurationService.service'
import type { ITreeItem } from '@codingame/monaco-vscode-api/vscode/vs/workbench/common/views'
import { snapshotFileDrop, isFileTransfer, resolveAilyDropDirectory } from './fileDrop.js'

const importedFiles = new Emitter<void>()
export const onDidImportDroppedFiles = importedFiles.event
let installed = false

/**
 * VS Code's extension DataTransfer flattens native directories into files. Keep
 * native entries at the workbench boundary and reuse its recursive uploader,
 * overwrite dialogs, cancellation and native-FS provider in both trees.
 */
export function installFileDrop(): void {
  if (installed) return
  installed = true

  const originalUpload = BrowserFileUpload.prototype.upload
  BrowserFileUpload.prototype.upload = async function (target, source) {
    // Snapshot synchronously: progress UI and extension-host RPC both yield.
    const snapshot = source instanceof DragEvent
      ? snapshotFileDrop(source)
      : source
    try {
      // Resolve children even when dropping onto a collapsed directory so the
      // uploader detects existing names before writing anything.
      const explorer = await getService(IExplorerService)
      target.forgetChildren()
      await target.fetchChildren(explorer.sortOrderConfiguration.sortOrder)
      await originalUpload.call(this, target, snapshot)
    } finally {
      importedFiles.fire()
    }
  }

  const treePrototype = CustomTreeViewDragAndDrop.prototype
  const originalDragOver = treePrototype.onDragOver
  const originalDrop = treePrototype.drop
  // treeId is private in the pinned VS Code types but is the stable runtime
  // identifier. Scope this adapter to Aily View; other custom trees keep their DnD.
  const isAilyView = (tree: CustomTreeViewDragAndDrop): boolean =>
    (tree as unknown as { treeId: string }).treeId === 'ailyView'

  let workspaceRoot: URI | undefined
  void getService(IWorkspaceContextService).then(context => {
    const updateRoot = (): void => { workspaceRoot = context.getWorkspace().folders[0]?.uri }
    updateRoot()
    context.onDidChangeWorkspaceFolders(updateRoot)
  })

  const directoryFor = (target?: ITreeItem): URI | undefined => workspaceRoot
    ? resolveAilyDropDirectory(workspaceRoot, target && {
        contextValue: target.contextValue,
        resourceUri: target.resourceUri ? URI.revive(target.resourceUri) : undefined
      })
    : undefined

  treePrototype.onDragOver = function (data, target, index, sector, event) {
    if (!isAilyView(this) || !isFileTransfer(event.dataTransfer)) {
      return originalDragOver.call(this, data, target, index, sector, event)
    }
    if (!directoryFor(target)) return false
    return { accept: true, autoExpand: true, effect: { type: ListDragOverEffectType.Copy } }
  }

  treePrototype.drop = async function (data, target, index, sector, event) {
    if (!isAilyView(this) || !isFileTransfer(event.dataTransfer)) {
      return originalDrop.call(this, data, target, index, sector, event)
    }
    const directory = directoryFor(target)
    if (!directory || !event.dataTransfer) return
    const snapshot = snapshotFileDrop(event)
    try {
      const [fs, configuration, filesConfiguration] = await Promise.all([
        getService(IFileService), getService(IConfigurationService), getService(IFilesConfigurationService)
      ])
      // User View and Library can exist in the logical tree before their disk directories.
      await fs.createFolder(directory)
      const item = ExplorerItem.create(fs, configuration, filesConfiguration, await fs.resolve(directory), undefined)
      if (item.isReadonly) return
      const upload = await createInstance(BrowserFileUpload)
      await upload.upload(item, snapshot)
    } catch (error) {
      const dialogs = await getService(IDialogService)
      await dialogs.error(error instanceof Error ? error.message : String(error))
    }
  }
}
