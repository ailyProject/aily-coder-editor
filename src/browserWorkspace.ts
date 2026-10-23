import { getService, IEditorService, IFileDialogService, IWorkspaceContextService } from '@codingame/monaco-vscode-api'
import { reinitializeWorkspace } from '@codingame/monaco-vscode-configuration-service-override'
import { URI } from '@codingame/monaco-vscode-api/vscode/vs/base/common/uri'
import { getSingleFolderWorkspaceIdentifier } from '@codingame/monaco-vscode-api/vscode/vs/workbench/services/workspaces/browser/workspaces'
import * as vscode from 'vscode'
import { createBrowserWorkspaceActivation, type BrowserCapturedWorkspaceActivation, type BrowserWorkspaceActivationPort } from './browserWorkspaceActivation.js'
import { BrowserProjectPublicationError, createBrowserProjectPublication, type BrowserProjectPublicationOptions } from './browserProjectPublication.js'
import { BrowserProjectPortError, installBrowserProjectPort, type BrowserProjectPortArtifactSnapshot } from './browserProjectPort.js'

export type { BrowserCapturedWorkspaceActivation, BrowserWorkspaceActivationPort } from './browserWorkspaceActivation.js'

export interface BrowserWorkspaceProjectFiles {
  readFile(captured: BrowserCapturedWorkspaceActivation, relativePath: string, maximumBytes: number, signal: AbortSignal): Promise<Uint8Array>
}
export interface BrowserWorkspaceProjectPortConfiguration {
  /** Explicit trusted composition; never derived from query/referrer. */
  readonly expectedParentOrigin: string
  readonly snapshotModuleURL: string | null
}

let installed: ReturnType<typeof createBrowserWorkspaceActivation> | null = null
let installing: Promise<void> | null = null
// Cleanup ownership only: retired activations cannot select or publish a
// project. Keep each original object until its real pending work has settled.
const cleanupRetirements = new Set<ReturnType<typeof createBrowserWorkspaceActivation>>()
const projectPortOwners = new Map<ReturnType<typeof createBrowserWorkspaceActivation>, ReturnType<typeof installBrowserProjectPort>>()

function retire(selection: ReturnType<typeof createBrowserWorkspaceActivation>): Promise<void> {
  cleanupRetirements.add(selection)
  const bridge = projectPortOwners.get(selection)
  return Promise.allSettled([selection.closeAndWait(), ...(bridge ? [bridge.closeAndWait()] : [])]).then(outcomes => {
    const errors = outcomes.filter((value): value is PromiseRejectedResult => value.status === 'rejected').map(value => value.reason)
    if (errors.length) throw new AggregateError(errors, 'Original workspace/ProjectPort cleanup remains unconfirmed.')
    cleanupRetirements.delete(selection); projectPortOwners.delete(selection)
  })
}

export function getBrowserWorkspaceLifecycleSnapshot() {
  const retired = [...cleanupRetirements].map(selection => ({ ...selection.snapshot(), projectPort: projectPortOwners.get(selection)?.snapshot() ?? null }))
  return Object.freeze({ activeOwner: installed !== null, installing: installing !== null, retiredOwners: retired.length,
    pendingSelections: retired.filter(item => item.retainedPendingSelection).length,
    pendingCleanup: retired.filter(item => item.closing).length,
    unconfirmedSubscriptions: retired.filter(item => item.workspaceSubscriptionActive).length,
    retainedCleanupResponsibility: retired.length !== 0,
    projectPort: installed ? projectPortOwners.get(installed)?.snapshot() ?? null : null,
    retired: Object.freeze(retired) })
}

/** A trusted same-document application import, never a window/query authority. */
export function getBrowserWorkspaceActivationPort(): BrowserWorkspaceActivationPort | null {
  return installed?.port ?? null
}

/** Owning application composition: use the actual installed workspace/files,
 * while deployment, original validators and HTTP publisher stay explicit.
 * Missing transport never becomes a file, Blob or inferred server fallback. */
export function createBrowserWorkspacePublication(
  configuration: Omit<BrowserProjectPublicationOptions, 'activation' | 'files'>,
) {
  const activation = getBrowserWorkspaceActivationPort()
  const files = getBrowserWorkspaceProjectFiles()
  if (!activation || !files) throw new BrowserProjectPublicationError('publication-unavailable')
  return createBrowserProjectPublication({ ...configuration, activation, files })
}

/** Uses only the selected generation's original provider, without an OS path or
 * a caller-selectable root. Publication supplies member identity separately. */
export function getBrowserWorkspaceProjectFiles(): BrowserWorkspaceProjectFiles | null {
  const selected = installed
  if (!selected) return null
  return Object.freeze({ async readFile(captured: BrowserCapturedWorkspaceActivation, relativePath: string, maximumBytes: number, signal: AbortSignal) {
    if (typeof relativePath !== 'string' || !relativePath || /[\\%\x00-\x1f\x7f]/.test(relativePath)
      || relativePath.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(relativePath)
      || relativePath.split('/').some(segment => !segment || segment === '.' || segment === '..')) {
      throw new TypeError('A canonical relative workspace member path is required.')
    }
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) throw new TypeError('A non-negative bounded member size is required.')
    const requireCurrent = () => {
      signal.throwIfAborted()
      captured.requireCurrent()
      if (installed !== selected || selected.port.captureCurrentProjectActivation() !== captured) {
        throw new DOMException('The selected Browser workspace generation changed.', 'AbortError')
      }
    }
    requireCurrent()
    const resource = vscode.Uri.joinPath(vscode.Uri.parse(captured.path), ...relativePath.split('/'))
    const metadata = await vscode.workspace.fs.stat(resource)
    requireCurrent()
    if (metadata.type !== vscode.FileType.File || !Number.isSafeInteger(metadata.size)
      || metadata.size < 0 || metadata.size > maximumBytes) throw new Error('Workspace member exceeds its file/size boundary.')
    const bytes = await vscode.workspace.fs.readFile(resource)
    requireCurrent()
    const after = await vscode.workspace.fs.stat(resource)
    requireCurrent()
    if (after.type !== vscode.FileType.File || after.size !== metadata.size || after.mtime !== metadata.mtime
      || bytes.byteLength > maximumBytes || bytes.byteLength !== metadata.size) {
      throw new Error('Workspace member changed while being read.')
    }
    return bytes
  } })
}

export function installBrowserWorkspace(container: HTMLElement, configuration: BrowserWorkspaceProjectPortConfiguration): Promise<void> {
  if (installed) return Promise.resolve()
  if (installing) return installing
  const task = initializeBrowserWorkspace(container, configuration).finally(() => { if (installing === task) installing = null })
  installing = task
  void task.catch(() => { /* The caller keeps failed installation/cleanup responsibility. */ })
  return task
}

async function initializeBrowserWorkspace(container: HTMLElement, configuration: BrowserWorkspaceProjectPortConfiguration): Promise<void> {
  const trustedConfiguration = Object.freeze({ ...configuration })
  const snapshotURL = trustedConfiguration.snapshotModuleURL === null ? null : new URL(trustedConfiguration.snapshotModuleURL)
  if (snapshotURL && (snapshotURL.origin !== window.location.origin || snapshotURL.search || snapshotURL.hash
    || !snapshotURL.pathname.endsWith('/browser-project-port.mjs'))) throw new TypeError('The ProjectPort snapshot module must be an explicit same-origin release member.')
  // BFCache restoration cannot revive an old owner or discard its cleanup.
  // A pending system picker remains pending; no synthetic cancellation ACK.
  await Promise.all([...cleanupRetirements].map(retire))
  const [workspace, dialogs, editors] = await Promise.all([
    getService(IWorkspaceContextService), getService(IFileDialogService), getService(IEditorService)
  ])
  const owner = new AbortController()
  const selection = createBrowserWorkspaceActivation({
    owner: owner.signal,
    readWorkspace: () => {
      const current = workspace.getWorkspace()
      return { id: current.id, folders: current.folders.map(folder => folder.uri.toString()) }
    },
    onWorkspaceChange: listener => workspace.onDidChangeWorkspaceFolders(listener),
    countDirtyEditors: () => editors.editors.filter(editor => editor.isDirty()).length,
    pickDirectory: async () => {
      const selected = await dialogs.showOpenDialog({
        canSelectFiles: false, canSelectFolders: true, canSelectMany: false,
        openLabel: 'Open Folder'
      })
      if (!selected) return undefined
      if (selected.length !== 1 || selected[0]?.scheme !== 'file') throw new Error('Select one Browser directory.')
      return selected[0].toString()
    },
    initializeFolder: async uri => reinitializeWorkspace(getSingleFolderWorkspaceIdentifier(URI.parse(uri)))
  })
  installed = selection
  try { if (window.parent !== window) {
    const files = getBrowserWorkspaceProjectFiles()!
    let loadedSnapshotModule: Promise<{ captureBrowserWorkspaceArtifact: (input: {
      requireCurrent(): void, readFile(path: string, maximumBytes: number, signal: AbortSignal): Promise<Uint8Array>
    }, signal: AbortSignal) => Promise<BrowserProjectPortArtifactSnapshot> }> | null = null
    const bridge = installBrowserProjectPort({ window, expectedParentOrigin: trustedConfiguration.expectedParentOrigin,
      activation: selection.port, files,
      readArtifactSnapshot: snapshotURL ? async (captured, signal) => {
        signal.throwIfAborted(); captured.requireCurrent()
        if (!loadedSnapshotModule) loadedSnapshotModule = import(/* @vite-ignore */ snapshotURL.href).then(module => {
          if (typeof module.captureBrowserWorkspaceArtifact !== 'function') throw new BrowserProjectPortError('unavailable')
          return module as Awaited<NonNullable<typeof loadedSnapshotModule>>
        }).catch(() => { throw new BrowserProjectPortError('unavailable') })
        const module = await loadedSnapshotModule
        signal.throwIfAborted(); captured.requireCurrent()
        return module.captureBrowserWorkspaceArtifact({ requireCurrent: () => captured.requireCurrent(),
          readFile: (path, maximumBytes, current) => files.readFile(captured, path, maximumBytes, current) }, signal)
      } : null })
    projectPortOwners.set(selection, bridge)
  } } catch (error) {
    if (installed === selection) installed = null
    try { await retire(selection) } catch (cleanup) { throw new AggregateError([error, cleanup], 'ProjectPort installation and original cleanup failed.') }
    finally { owner.abort(new DOMException('Browser ProjectPort installation failed.', 'AbortError')) }
    throw error
  }
  const controls = document.createElement('div')
  controls.dataset.ailyBrowserWorkspace = 'true'
  Object.assign(controls.style, { position: 'absolute', top: '6px', right: '12px', zIndex: '100' })
  const open = document.createElement('button')
  open.type = 'button'
  open.textContent = 'Open Folder…'
  const status = document.createElement('span')
  status.setAttribute('role', 'status')
  status.setAttribute('aria-live', 'polite')
  open.addEventListener('click', () => {
    open.disabled = true
    status.textContent = ''
    void selection.openFolder().then(result => {
      if (result === 'opened') status.textContent = 'Folder opened'
    }, error => { status.textContent = error instanceof Error ? error.message : String(error) })
      .finally(() => { open.disabled = owner.signal.aborted })
  })
  controls.append(open, status)
  container.append(controls)
  window.addEventListener('pagehide', event => {
    // Adopt before closing. closeAndWait applies the close intent synchronously
    // and removes the abort listener before the original owner is aborted.
    const cleanup = retire(selection)
    owner.abort(new DOMException('The owning Browser document was hidden.', 'AbortError'))
    controls.remove()
    if (installed === selection) installed = null
    void cleanup.catch(error => console.error('[aily-coder-editor] Browser workspace cleanup remains unconfirmed', error))
    if (event.persisted) {
      // BFCache restores this same document without rerunning setup. Create a
      // fresh owner and require a fresh user selection; the old grant stays dead.
      window.addEventListener('pageshow', () => {
        void installBrowserWorkspace(container, trustedConfiguration).catch(error => console.error('[aily-coder-editor] Browser workspace restore failed', error))
      }, { once: true })
    }
  }, { once: true })
}
