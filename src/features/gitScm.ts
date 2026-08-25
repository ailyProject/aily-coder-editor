import {
  ExtensionHostKind,
  registerExtension,
  type IExtensionManifest
} from '@codingame/monaco-vscode-api/extensions'
import * as vscode from 'vscode'
import {
  commitNativeGitChanges,
  readNativeGitHeadFile,
  readNativeGitStatus
} from '../parentBackedNativeFs.js'
import {
  parseGitPorcelainZ,
  type GitStatusEntry
} from './gitScmStatus.js'

const BASELINE_SCHEME = 'aily-git-baseline'
const EMPTY_SCHEME = 'aily-git-empty'
const baselineContentByUri = new Map<string, string>()

function normalizeRelativePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '')
}

function dominantStatus(entry: GitStatusEntry): string {
  if (entry.indexStatus === '?' && entry.workingTreeStatus === '?') {
    return '?'
  }
  return entry.workingTreeStatus !== ' ' ? entry.workingTreeStatus : entry.indexStatus
}

function statusPresentation(entry: GitStatusEntry): {
  label: string
  icon: string
  strikeThrough?: boolean
} {
  switch (dominantStatus(entry)) {
    case '?':
    case 'A':
      return { label: '新增', icon: 'diff-added' }
    case 'D':
      return { label: '删除', icon: 'diff-removed', strikeThrough: true }
    case 'R':
      return { label: '重命名', icon: 'diff-renamed' }
    case 'C':
      return { label: '复制', icon: 'diff-added' }
    case 'U':
      return { label: '冲突', icon: 'warning' }
    default:
      return { label: '修改', icon: 'diff-modified' }
  }
}

function workspaceFileUri(root: vscode.Uri, relativePath: string): vscode.Uri {
  return vscode.Uri.joinPath(root, ...normalizeRelativePath(relativePath).split('/'))
}

function virtualUri(scheme: string, relativePath: string): vscode.Uri {
  return vscode.Uri.from({
    scheme,
    path: `/${normalizeRelativePath(relativePath)}`,
    query: `v=${Date.now()}-${Math.random().toString(36).slice(2)}`
  })
}

function isDeleted(entry: GitStatusEntry): boolean {
  return entry.indexStatus === 'D' || entry.workingTreeStatus === 'D'
}

const manifest = {
  name: 'aily-git-scm',
  publisher: 'aily',
  version: '0.0.1',
  engines: { vscode: '*' },
  activationEvents: ['*'],
  enabledApiProposals: ['scmActionButton'],
  contributes: {
    commands: [
      { command: 'aily.git.commit', title: 'Git: 提交' },
      { command: 'aily.git.openDiff', title: 'Git: 打开更改' },
      { command: 'aily.git.refresh', title: 'Git: 刷新' }
    ]
  }
} as unknown as IExtensionManifest

const { getApi } = registerExtension(manifest, ExtensionHostKind.LocalProcess, { system: true })

void getApi().then((api) => {
  const workspaceFolder = api.workspace.workspaceFolders?.[0]
  if (!workspaceFolder || workspaceFolder.uri.scheme !== 'file') {
    return
  }

  const workspaceRoot = workspaceFolder.uri.fsPath
  const sourceControl = api.scm.createSourceControl('aily-git', 'Git', workspaceFolder.uri)
  const changes = sourceControl.createResourceGroup('changes', '更改')
  changes.hideWhenEmpty = true
  sourceControl.inputBox.placeholder = '提交消息（按 Ctrl/Cmd+Enter 提交）'
  sourceControl.acceptInputCommand = {
    command: 'aily.git.commit',
    title: '提交'
  }

  const updateCommitButton = (enabled: boolean) => {
    sourceControl.actionButton = {
      command: {
        command: 'aily.git.commit',
        title: '提交',
        shortTitle: '提交'
      },
      enabled
    }
  }
  updateCommitButton(false)

  api.workspace.registerTextDocumentContentProvider(BASELINE_SCHEME, {
    provideTextDocumentContent(uri: vscode.Uri): string {
      return baselineContentByUri.get(uri.toString()) ?? ''
    }
  })
  api.workspace.registerTextDocumentContentProvider(EMPTY_SCHEME, {
    provideTextDocumentContent(): string {
      return ''
    }
  })

  let refreshTimer: number | undefined
  let refreshGeneration = 0
  const scheduleRefresh = (delayMs = 120) => {
    if (refreshTimer != null) {
      window.clearTimeout(refreshTimer)
    }
    refreshTimer = window.setTimeout(() => {
      refreshTimer = undefined
      void refresh()
    }, delayMs)
  }

  const openDiff = async (entry: GitStatusEntry): Promise<void> => {
    const baselinePath = entry.originalPath || entry.path
    const baselineUri = virtualUri(BASELINE_SCHEME, baselinePath)
    try {
      const result = await readNativeGitHeadFile(workspaceRoot, baselinePath)
      baselineContentByUri.set(baselineUri.toString(), result.content)
    } catch {
      baselineContentByUri.set(baselineUri.toString(), '')
    }

    const modifiedUri = isDeleted(entry)
      ? virtualUri(EMPTY_SCHEME, entry.path)
      : workspaceFileUri(workspaceFolder.uri, entry.path)
    const title = `${entry.path}（Git 更改）`
    await api.commands.executeCommand('vscode.diff', baselineUri, modifiedUri, title, {
      preview: false,
      preserveFocus: false
    })
  }

  const refresh = async (): Promise<void> => {
    const generation = ++refreshGeneration
    try {
      const result = await readNativeGitStatus(workspaceRoot)
      const entries = parseGitPorcelainZ(result.status)
      if (generation !== refreshGeneration) {
        return
      }
      changes.resourceStates = entries.map((entry) => {
        const presentation = statusPresentation(entry)
        return {
          resourceUri: workspaceFileUri(workspaceFolder.uri, entry.path),
          command: {
            command: 'aily.git.openDiff',
            title: '打开更改',
            arguments: [entry]
          },
          contextValue: 'ailyGitDiffable',
          decorations: {
            tooltip: presentation.label,
            iconPath: new api.ThemeIcon(presentation.icon),
            ...(presentation.strikeThrough ? { strikeThrough: true } : {})
          }
        }
      })
      sourceControl.count = entries.length
      updateCommitButton(entries.length > 0)
    } catch {
      if (generation !== refreshGeneration) {
        return
      }
      changes.resourceStates = []
      sourceControl.count = 0
      updateCommitButton(false)
    }
  }

  api.commands.registerCommand('aily.git.openDiff', async (entry: GitStatusEntry) => {
    await openDiff(entry)
  })

  api.commands.registerCommand('aily.git.refresh', async () => {
    await refresh()
  })

  api.commands.registerCommand('aily.git.commit', async () => {
    const message = sourceControl.inputBox.value.trim()
    if (!message) {
      await api.window.showWarningMessage('请输入提交消息')
      return
    }

    await api.workspace.saveAll(false)
    try {
      const result = await commitNativeGitChanges(workspaceRoot, message)
      sourceControl.inputBox.value = ''
      await refresh()
      void api.window.showInformationMessage(result.summary || 'Git 提交成功')
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      await api.window.showErrorMessage(`Git 提交失败：${detail}`)
    }
  })

  const watcher = api.workspace.createFileSystemWatcher('**/*')
  watcher.onDidCreate(() => scheduleRefresh())
  watcher.onDidChange(() => scheduleRefresh())
  watcher.onDidDelete(() => scheduleRefresh())
  api.workspace.onDidSaveTextDocument(() => scheduleRefresh())

  void refresh()
})
