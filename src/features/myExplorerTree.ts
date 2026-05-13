import type * as vscode from 'vscode'
import { ExtensionHostKind, registerExtension } from '@codingame/monaco-vscode-api/extensions'

type ExplorerVirtualNode = {
  readonly kind: 'virtual'
  readonly id: string
  readonly label: string
  readonly tooltip?: string
}

type ExplorerFolderNode = {
  readonly kind: 'folder'
  readonly uri: vscode.Uri
}

type ExplorerFileNode = {
  readonly kind: 'file'
  readonly uri: vscode.Uri
}

type ExplorerTreeElement = ExplorerVirtualNode | ExplorerFolderNode | ExplorerFileNode

const AI_ROOT_ID = 'myExplorer.ai-root'
const DEVICES_ROOT_ID = 'myExplorer.devices-root'
const API_ROOT_ID = 'myExplorer.api-root'

function sortDirectoryEntries(
  vs: typeof vscode,
  entries: [string, vscode.FileType][]
): [string, vscode.FileType][] {
  const dirs = entries.filter(([, t]) => (t & vs.FileType.Directory) !== 0)
  const files = entries.filter(([, t]) => (t & vs.FileType.Directory) === 0)
  const cmp = (a: [string, vscode.FileType], b: [string, vscode.FileType]) =>
    a[0].localeCompare(b[0], undefined, { sensitivity: 'base' })
  dirs.sort(cmp)
  files.sort(cmp)
  return [...dirs, ...files]
}

function sortRoots(nodes: ExplorerTreeElement[]): ExplorerTreeElement[] {
  const order = [AI_ROOT_ID, DEVICES_ROOT_ID, API_ROOT_ID]
  const virtualMap = new Map(
    nodes
      .filter((n): n is ExplorerVirtualNode => n.kind === 'virtual')
      .map((n) => [n.id, n] as const)
  )
  const orderedVirtual: ExplorerVirtualNode[] = []
  for (const id of order) {
    const v = virtualMap.get(id)
    if (v != null) {
      orderedVirtual.push(v)
    }
  }
  const folders = nodes.filter((n): n is ExplorerFolderNode => n.kind === 'folder')
  folders.sort((a, b) => a.uri.fsPath.localeCompare(b.uri.fsPath, undefined, { sensitivity: 'base' }))
  return [...orderedVirtual, ...folders]
}

class MyExplorerProvider implements vscode.TreeDataProvider<ExplorerTreeElement> {
  readonly #vscode: typeof vscode
  readonly #onDidChangeTreeData: vscode.EventEmitter<ExplorerTreeElement | undefined | void>
  readonly onDidChangeTreeData: vscode.Event<ExplorerTreeElement | undefined | void>

  constructor(vscodeApi: typeof vscode) {
    this.#vscode = vscodeApi
    this.#onDidChangeTreeData = new vscodeApi.EventEmitter()
    this.onDidChangeTreeData = this.#onDidChangeTreeData.event
  }

  refresh(node?: ExplorerTreeElement): void {
    this.#onDidChangeTreeData.fire(node)
  }

  getTreeItem(element: ExplorerTreeElement): vscode.TreeItem {
    const vs = this.#vscode
    if (element.kind === 'virtual') {
      const item = new vs.TreeItem(element.label, vs.TreeItemCollapsibleState.Collapsed)
      item.id = element.id
      item.tooltip = element.tooltip ?? element.label
      if (
        element.id !== AI_ROOT_ID &&
        element.id !== DEVICES_ROOT_ID &&
        element.id !== API_ROOT_ID
      ) {
        item.collapsibleState = vs.TreeItemCollapsibleState.None
        item.command = {
          command: 'myExplorer.virtualClick',
          title: 'Open',
          arguments: [element.id, element.label]
        }
      }
      return item
    }

    if (element.kind === 'folder') {
      const base = element.uri.path.split('/').filter(Boolean).pop() ?? element.uri.path
      const item = new vs.TreeItem(base, vs.TreeItemCollapsibleState.Collapsed)
      item.resourceUri = element.uri
      item.id = `folder:${element.uri.toString()}`
      return item
    }

    const base = element.uri.path.split('/').filter(Boolean).pop() ?? element.uri.path
    const item = new vs.TreeItem(base, vs.TreeItemCollapsibleState.None)
    item.resourceUri = element.uri
    item.id = `file:${element.uri.toString()}`
    item.command = {
      command: 'vscode.open',
      title: 'Open',
      arguments: [element.uri]
    }
    return item
  }

  async getChildren(element?: ExplorerTreeElement): Promise<ExplorerTreeElement[]> {
    const vs = this.#vscode

    if (element == null) {
      const roots: ExplorerTreeElement[] = [
        {
          kind: 'virtual',
          id: AI_ROOT_ID,
          label: '🤖 AI',
          tooltip: '虚拟 AI 分组'
        },
        {
          kind: 'virtual',
          id: DEVICES_ROOT_ID,
          label: '🔌 设备',
          tooltip: '虚拟设备分组'
        },
        {
          kind: 'virtual',
          id: API_ROOT_ID,
          label: '🌐 API',
          tooltip: '虚拟 API 分组'
        }
      ]
      for (const folder of vs.workspace.workspaceFolders ?? []) {
        roots.push({ kind: 'folder', uri: folder.uri })
      }
      return sortRoots(roots)
    }

    if (element.kind === 'virtual') {
      switch (element.id) {
        case AI_ROOT_ID:
          return [
            {
              kind: 'virtual',
              id: 'myExplorer.ai-generated',
              label: '🤖 AI 生成节点',
              tooltip: '示例虚拟节点'
            }
          ]
        case DEVICES_ROOT_ID:
          return [
            {
              kind: 'virtual',
              id: 'myExplorer.device-demo',
              label: '🔌 示例设备',
              tooltip: '示例设备节点'
            }
          ]
        case API_ROOT_ID:
          return [
            {
              kind: 'virtual',
              id: 'myExplorer.api-demo',
              label: '🌐 示例 API',
              tooltip: '示例 API 节点'
            }
          ]
        default:
          return []
      }
    }

    if (element.kind === 'folder') {
      try {
        const raw = await vs.workspace.fs.readDirectory(element.uri)
        const sorted = sortDirectoryEntries(vs, raw)
        return sorted.map(([name, type]) => {
          const uri = vs.Uri.joinPath(element.uri, name)
          return (type & vs.FileType.Directory) !== 0
            ? { kind: 'folder' as const, uri }
            : { kind: 'file' as const, uri }
        })
      } catch {
        return []
      }
    }

    return []
  }
}

const { getApi } = registerExtension(
  {
    name: 'my-explorer-tree',
    publisher: 'codingame',
    version: '1.0.0',
    engines: {
      vscode: '*'
    },
    contributes: {
      views: {
        explorer: [
          {
            id: 'myExplorer',
            name: 'My Explorer',
            visibility: 'visible'
          }
        ]
      },
      commands: [
        {
          command: 'myExplorer.virtualClick',
          title: 'My Explorer: virtual item'
        }
      ]
    }
  },
  ExtensionHostKind.LocalProcess
)

void getApi().then((vscode) => {
  vscode.commands.registerCommand(
    'myExplorer.virtualClick',
    async (id: string, label: string) => {
      await vscode.window.showInformationMessage(`虚拟节点: ${label} (${id})`)
    }
  )

  const provider = new MyExplorerProvider(vscode)
  vscode.window.createTreeView('myExplorer', {
    treeDataProvider: provider,
    showCollapseAll: true
  })

  vscode.workspace.onDidChangeWorkspaceFolders(() => {
    provider.refresh()
  })
})
