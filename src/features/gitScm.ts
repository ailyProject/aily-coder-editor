import {
  ExtensionHostKind,
  registerExtension,
  type IExtensionManifest
} from '@codingame/monaco-vscode-api/extensions'
import * as vscode from 'vscode'
import {
  commitNativeGitChanges,
  initializeNativeGitRepository,
  readNativeGitHistoryItemChanges,
  readNativeGitHistoryItems,
  readNativeGitHistoryRefs,
  readNativeGitHeadFile,
  readNativeGitRevisionFile,
  resolveNativeGitHistoryCommonAncestor,
  type NativeGitHistoryRef,
  readNativeGitStatus
} from '../parentBackedNativeFs.js'
import {
  parseGitPorcelainZ,
  shouldRefreshGitScmForPath,
  type GitStatusEntry
} from './gitScmStatus.js'
import {
  historyRefsByRevision,
  parseGitHistoryItemChanges,
  parseGitHistoryItems,
  type GitHistoryItem
} from './gitScmHistory.js'
import { createTrailingSingleFlight } from './gitScmRefresh.js'
import { initialHostLanguage, workbenchUiStrings } from './ailyWorkbenchI18n.js'

const BASELINE_SCHEME = 'aily-git-baseline'
const EMPTY_SCHEME = 'aily-git-empty'
const REVISION_SCHEME = 'aily-git-revision'
const baselineContentByUri = new Map<string, string>()
const copy = workbenchUiStrings(initialHostLanguage()).git

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
      return { label: copy.added, icon: 'diff-added' }
    case 'D':
      return { label: copy.deleted, icon: 'diff-removed', strikeThrough: true }
    case 'R':
      return { label: copy.renamed, icon: 'diff-renamed' }
    case 'C':
      return { label: copy.copied, icon: 'diff-added' }
    case 'U':
      return { label: copy.conflict, icon: 'warning' }
    default:
      return { label: copy.modified, icon: 'diff-modified' }
  }
}

function workspaceFileUri(root: vscode.Uri, relativePath: string): vscode.Uri {
  return vscode.Uri.joinPath(root, ...normalizeRelativePath(relativePath).split('/'))
}

function virtualUri(scheme: string, relativePath: string): vscode.Uri {
  return vscode.Uri.from({
    scheme,
    path: `/${normalizeRelativePath(relativePath)}`
  })
}

function revisionUri(revision: string, relativePath: string): vscode.Uri {
  return vscode.Uri.from({
    scheme: REVISION_SCHEME,
    path: `/${normalizeRelativePath(relativePath)}`,
    query: new URLSearchParams({ revision }).toString()
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
  enabledApiProposals: ['scmActionButton', 'scmHistoryProvider'],
  contributes: {
    commands: [
      { command: 'aily.git.init', title: copy.initCommand },
      { command: 'aily.git.commit', title: copy.commitCommand },
      { command: 'aily.git.openDiff', title: copy.openChangeCommand },
      { command: 'aily.git.refresh', title: copy.refreshCommand }
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
  const changes = sourceControl.createResourceGroup('changes', copy.changes)
  changes.hideWhenEmpty = true
  sourceControl.inputBox.placeholder = copy.commitPlaceholder
  sourceControl.acceptInputCommand = {
    command: 'aily.git.commit',
    title: copy.commit
  }

  let repositoryInitialized: boolean | undefined
  let nativeHistoryRefs: NativeGitHistoryRef[] = []
  let currentHistoryItemRef: vscode.SourceControlHistoryItemRef | undefined
  let currentHistoryItemRemoteRef: vscode.SourceControlHistoryItemRef | undefined
  const currentHistoryRefsEmitter = new api.EventEmitter<void>()
  const historyItemRefsEmitter = new api.EventEmitter<vscode.SourceControlHistoryItemRefsChangeEvent>()
  const baselineContentChangeEmitter = new api.EventEmitter<vscode.Uri>()

  const toHistoryItemRef = (ref: NativeGitHistoryRef): vscode.SourceControlHistoryItemRef => ({
    id: ref.id,
    name: ref.name,
    revision: ref.revision,
    category: ref.category === 'tag'
      ? copy.tags
      : ref.category === 'remote'
        ? copy.remoteBranches
        : copy.branches,
    icon: new api.ThemeIcon(ref.category === 'tag' ? 'tag' : 'git-branch')
  })

  const refreshHistoryRefs = async (silent: boolean): Promise<void> => {
    const previous = new Map(nativeHistoryRefs.map((ref) => [ref.id, ref]))
    try {
      const result = await readNativeGitHistoryRefs(workspaceRoot)
      nativeHistoryRefs = result.refs
      currentHistoryItemRef = result.current ? toHistoryItemRef(result.current) : undefined
      currentHistoryItemRemoteRef = result.remote ? toHistoryItemRef(result.remote) : undefined

      const next = new Map(nativeHistoryRefs.map((ref) => [ref.id, ref]))
      const added = nativeHistoryRefs
        .filter((ref) => !previous.has(ref.id))
        .map(toHistoryItemRef)
      const removed = [...previous.values()]
        .filter((ref) => !next.has(ref.id))
        .map(toHistoryItemRef)
      const modified = nativeHistoryRefs
        .filter((ref) => {
          const old = previous.get(ref.id)
          return old != null && (old.revision !== ref.revision || old.name !== ref.name)
        })
        .map(toHistoryItemRef)

      currentHistoryRefsEmitter.fire()
      historyItemRefsEmitter.fire({ added, removed, modified, silent })
    } catch {
      nativeHistoryRefs = []
      currentHistoryItemRef = undefined
      currentHistoryItemRemoteRef = undefined
      currentHistoryRefsEmitter.fire()
    }
  }

  const loadHistoryItems = async (
    revisions: readonly string[] | undefined,
    skip = 0,
    limit = 50,
    filterText?: string
  ): Promise<vscode.SourceControlHistoryItem[]> => {
    const result = await readNativeGitHistoryItems(workspaceRoot, {
      revisions: revisions == null ? undefined : [...new Set(revisions)],
      skip,
      limit,
      filterText
    })
    const refsByRevision = historyRefsByRevision(nativeHistoryRefs)
    return parseGitHistoryItems(result.history).map((item: GitHistoryItem) => ({
      id: item.id,
      parentIds: item.parentIds,
      subject: item.subject,
      message: item.message,
      displayId: item.id.slice(0, 7),
      author: item.author,
      authorEmail: item.authorEmail,
      timestamp: item.timestamp,
      references: refsByRevision.get(item.id)?.map(toHistoryItemRef),
      tooltip: new api.MarkdownString(
        `**${item.subject}**\n\n${item.author} <${item.authorEmail}>\n\n${item.message}`
      )
    }))
  }

  const historyProvider: vscode.SourceControlHistoryProvider = {
    get currentHistoryItemRef() {
      return currentHistoryItemRef
    },
    get currentHistoryItemRemoteRef() {
      return currentHistoryItemRemoteRef
    },
    get currentHistoryItemBaseRef() {
      return undefined
    },
    onDidChangeCurrentHistoryItemRefs: currentHistoryRefsEmitter.event,
    onDidChangeHistoryItemRefs: historyItemRefsEmitter.event,
    async provideHistoryItemRefs(historyItemRefs) {
      const refs = nativeHistoryRefs.map(toHistoryItemRef)
      return historyItemRefs == null
        ? refs
        : refs.filter((ref) => historyItemRefs.includes(ref.id))
    },
    async provideHistoryItems(options) {
      const limit = typeof options.limit === 'number' ? options.limit : 50
      return loadHistoryItems(options.historyItemRefs, options.skip, limit, options.filterText)
    },
    async provideHistoryItemChanges(historyItemId, historyItemParentId) {
      const result = await readNativeGitHistoryItemChanges(
        workspaceRoot,
        historyItemId,
        historyItemParentId
      )
      return parseGitHistoryItemChanges(result.changes).map((change) => {
        const status = change.status[0]
        const originalPath = change.originalPath ?? change.path
        return {
          uri: workspaceFileUri(workspaceFolder.uri, change.path),
          originalUri: status === 'A'
            ? undefined
            : historyItemParentId
              ? revisionUri(historyItemParentId, originalPath)
              : undefined,
          modifiedUri: status === 'D'
            ? undefined
            : revisionUri(historyItemId, change.path)
        }
      })
    },
    async resolveHistoryItem(historyItemId) {
      return (await loadHistoryItems([historyItemId], 0, 1))[0]
    },
    async resolveHistoryItemChatContext(historyItemId) {
      return (await loadHistoryItems([historyItemId], 0, 1))[0]?.message ?? ''
    },
    async resolveHistoryItemChangeRangeChatContext() {
      return ''
    },
    async resolveHistoryItemRefsCommonAncestor(historyItemRefs) {
      const revisions = historyItemRefs
        .map((value) => nativeHistoryRefs.find((ref) => ref.id === value || ref.name === value)?.revision ?? value)
        .filter((value) => /^[0-9a-f]{40,64}$/iu.test(value))
      if (revisions.length < 2) {
        return undefined
      }
      return (await resolveNativeGitHistoryCommonAncestor(workspaceRoot, revisions)).revision
    }
  }
  sourceControl.historyProvider = historyProvider

  const updateScmPresentation = (
    state: 'loading' | 'ready' | 'uninitialized' | 'error',
    hasChanges = false
  ) => {
    const initialized = state === 'ready'
    sourceControl.inputBox.enabled = initialized || state === 'uninitialized'
    sourceControl.inputBox.placeholder = initialized
      ? copy.commitPlaceholder
      : state === 'uninitialized'
        ? copy.firstCommitPlaceholder
        : copy.unavailablePlaceholder
    sourceControl.acceptInputCommand = {
      command: 'aily.git.commit',
      title: state === 'uninitialized' ? copy.initializeAndCommit : copy.commit
    }
    sourceControl.actionButton = {
      command: {
        command: 'aily.git.commit',
        title: state === 'uninitialized' ? copy.initializeAndCommit : copy.commit,
        shortTitle: state === 'uninitialized' ? copy.firstCommit : copy.commit
      },
      enabled: state === 'uninitialized' || (initialized && hasChanges)
    }
  }
  updateScmPresentation('loading')

  api.workspace.registerTextDocumentContentProvider(BASELINE_SCHEME, {
    onDidChange: baselineContentChangeEmitter.event,
    provideTextDocumentContent(uri: vscode.Uri): string {
      return baselineContentByUri.get(uri.toString()) ?? ''
    }
  })
  api.workspace.registerTextDocumentContentProvider(EMPTY_SCHEME, {
    provideTextDocumentContent(): string {
      return ''
    }
  })
  api.workspace.registerTextDocumentContentProvider(REVISION_SCHEME, {
    async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
      const revision = new URLSearchParams(uri.query).get('revision') ?? ''
      const relativePath = uri.path.replace(/^\/+/, '')
      if (!revision || !relativePath) {
        return ''
      }
      try {
        return (await readNativeGitRevisionFile(workspaceRoot, revision, relativePath)).content
      } catch {
        return ''
      }
    }
  })

  const openDiff = async (entry: GitStatusEntry): Promise<void> => {
    const baselinePath = entry.originalPath || entry.path
    const baselineUri = virtualUri(BASELINE_SCHEME, baselinePath)
    let baselineContent = ''
    try {
      const result = await readNativeGitHeadFile(workspaceRoot, baselinePath)
      baselineContent = result.content
    } catch {
      // 新增文件或无 HEAD 时，以空内容作为比较基线。
    }
    const baselineKey = baselineUri.toString()
    if (baselineContentByUri.get(baselineKey) !== baselineContent) {
      baselineContentByUri.set(baselineKey, baselineContent)
      baselineContentChangeEmitter.fire(baselineUri)
    }

    const modifiedUri = isDeleted(entry)
      ? virtualUri(EMPTY_SCHEME, entry.path)
      : workspaceFileUri(workspaceFolder.uri, entry.path)
    const title = copy.diffTitle(entry.path)
    await api.commands.executeCommand('vscode.diff', baselineUri, modifiedUri, title, {
      preview: true,
      preserveFocus: false
    })
  }

  const refresh = createTrailingSingleFlight(async () => {
    try {
      const result = await readNativeGitStatus(workspaceRoot)
      const initialized = result.initialized !== false
      repositoryInitialized = initialized
      if (!initialized) {
        changes.resourceStates = []
        sourceControl.count = 0
        updateScmPresentation('uninitialized')
        return
      }
      const entries = parseGitPorcelainZ(result.status)
      changes.resourceStates = entries.map((entry) => {
        const presentation = statusPresentation(entry)
        return {
          resourceUri: workspaceFileUri(workspaceFolder.uri, entry.path),
          command: {
            command: 'aily.git.openDiff',
            title: copy.openChange,
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
      updateScmPresentation('ready', entries.length > 0)
    } catch {
      changes.resourceStates = []
      sourceControl.count = 0
      repositoryInitialized = undefined
      updateScmPresentation('error')
    }
  })

  let refreshTimer: number | undefined
  const scheduleRefresh = (delayMs = 120) => {
    if (refreshTimer != null) {
      window.clearTimeout(refreshTimer)
    }
    refreshTimer = window.setTimeout(() => {
      refreshTimer = undefined
      void refresh()
    }, delayMs)
  }

  api.commands.registerCommand('aily.git.openDiff', async (entry: GitStatusEntry) => {
    await openDiff(entry)
  })

  api.commands.registerCommand('aily.git.refresh', async () => {
    await Promise.all([refresh(), refreshHistoryRefs(false)])
  })

  api.commands.registerCommand('aily.git.init', async () => {
    try {
      const result = await initializeNativeGitRepository(workspaceRoot)
      await Promise.all([refresh(), refreshHistoryRefs(false)])
      void api.window.showInformationMessage(result.summary || copy.repositoryInitialized)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      await api.window.showErrorMessage(copy.initFailed(detail))
    }
  })

  api.commands.registerCommand('aily.git.commit', async () => {
    if (repositoryInitialized == null) {
      await api.window.showWarningMessage(copy.temporarilyUnavailable)
      return
    }
    const message = sourceControl.inputBox.value.trim()
    if (!message) {
      await api.window.showWarningMessage(copy.enterCommitMessage)
      return
    }

    await api.workspace.saveAll(false)
    try {
      const result = await commitNativeGitChanges(workspaceRoot, message)
      sourceControl.inputBox.value = ''
      await Promise.all([refresh(), refreshHistoryRefs(false)])
      void api.window.showInformationMessage(result.summary || copy.commitSucceeded)
    } catch (error) {
      await refresh()
      const detail = error instanceof Error ? error.message : String(error)
      await api.window.showErrorMessage(copy.commitFailed(detail))
    }
  })

  const watcher = api.workspace.createFileSystemWatcher('**/*')
  const scheduleRefreshForUri = (uri: vscode.Uri) => {
    if (
      uri.scheme !== 'file' ||
      api.workspace.getWorkspaceFolder(uri)?.uri.toString() !== workspaceFolder.uri.toString() ||
      uri.toString() === workspaceFolder.uri.toString()
    ) {
      return
    }
    const relativePath = api.workspace.asRelativePath(uri, false)
    if (shouldRefreshGitScmForPath(relativePath, repositoryInitialized)) {
      scheduleRefresh()
    }
  }
  watcher.onDidCreate(scheduleRefreshForUri)
  watcher.onDidChange(scheduleRefreshForUri)
  watcher.onDidDelete(scheduleRefreshForUri)
  // 保存会由文件服务 watcher 上报；再监听 onDidSaveTextDocument 会让一次写盘刷新两次。

  void refresh()
  void refreshHistoryRefs(false)
})
