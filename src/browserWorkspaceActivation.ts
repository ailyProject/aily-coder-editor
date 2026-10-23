/** The Browser owns only an activation of the original Workbench workspace.
 * Directory handles and files remain owned by the existing HTML FS provider. */
export interface BrowserWorkspaceSnapshot {
  readonly id: string
  readonly folders: readonly string[]
}

export interface BrowserCapturedWorkspaceActivation {
  readonly path: string
  readonly projectSessionId: string
  readonly signal: AbortSignal
  requireCurrent(): void
}

export interface BrowserWorkspaceActivationPort {
  captureCurrentProjectActivation(): BrowserCapturedWorkspaceActivation | null
  readonly projectActivation$: { subscribe(listener: (event: unknown) => void): { unsubscribe(): void } }
  readonly currentProjectPath$: { subscribe(listener: (path: string) => void): { unsubscribe(): void } }
}

export interface BrowserWorkspaceActivationOptions {
  readonly owner: AbortSignal
  readWorkspace(): BrowserWorkspaceSnapshot
  onWorkspaceChange(listener: () => void): { dispose(): void }
  countDirtyEditors(): number
  /** Called directly from the user action; no asynchronous setup before picker. */
  pickDirectory(): Promise<string | undefined>
  initializeFolder(uri: string): Promise<void>
}

export function createBrowserWorkspaceActivation(options: BrowserWorkspaceActivationOptions) {
  const activationListeners = new Set<(event: unknown) => void>()
  const pathListeners = new Set<(path: string) => void>()
  const lifetime = new AbortController()
  const instanceId = crypto.randomUUID()
  let generation = 0
  let current: { captured: BrowserCapturedWorkspaceActivation, workspaceId: string, revoke: AbortController } | null = null
  let opening: Promise<'opened' | 'cancelled'> | null = null
  let closing: Promise<void> | null = null
  let closeFailures = 0
  let closed = false

  function requireOwner(): void {
    lifetime.signal.throwIfAborted()
    options.owner.throwIfAborted()
  }

  function matchesCurrent(): boolean {
    if (!current) return false
    const workspace = options.readWorkspace()
    return workspace.id === current.workspaceId && workspace.folders.length === 1
      && workspace.folders[0] === current.captured.path
  }

  function notify(): void {
    // Observers cannot veto revocation or keep another observer alive.
    for (const listener of pathListeners) {
      try { listener(current?.captured.path ?? '') } catch (error) { console.error(error) }
    }
    for (const listener of activationListeners) {
      try { listener(current?.captured ?? null) } catch (error) { console.error(error) }
    }
  }

  function revoke(): void {
    const previous = current
    current = null
    previous?.revoke.abort(new DOMException('The selected Browser workspace changed.', 'AbortError'))
    notify()
  }

  const workspaceSubscription = options.onWorkspaceChange(revoke)
  let workspaceSubscriptionActive = true
  const ownerClosed = () => close()
  options.owner.addEventListener('abort', ownerClosed, { once: true })

  function close(): void {
    if (!closed) {
      closed = true
      lifetime.abort(new DOMException('The Browser workspace owner closed.', 'AbortError'))
      revoke()
      options.owner.removeEventListener('abort', ownerClosed)
      activationListeners.clear()
      pathListeners.clear()
    }
    if (workspaceSubscriptionActive) {
      try {
        workspaceSubscription.dispose()
        workspaceSubscriptionActive = false
      } catch (error) { closeFailures++; throw error }
    }
  }

  /** Closing cannot cancel a system picker or Workbench initialization. Retain
   * their original promise until it settles, then retry the owned subscription
   * cleanup once. The caller supplies any deadline and keeps unconfirmed work. */
  function closeAndWait(): Promise<void> {
    if (closing) return closing
    let resolveTask!: () => void
    let rejectTask!: (error: unknown) => void
    const task = new Promise<void>((resolve, reject) => { resolveTask = resolve; rejectTask = reject })
    closing = task
    try { close() } catch { /* Retry after the original opening has settled. */ }
    const originalOpening = opening
    void Promise.resolve().then(async () => {
      if (originalOpening) await Promise.allSettled([originalOpening])
      close()
    }).then(resolveTask, rejectTask)
    const settled = () => { if (closing === task) closing = null }
    void task.then(settled, settled)
    return task
  }

  if (options.owner.aborted) close()

  function captureCurrentProjectActivation(): BrowserCapturedWorkspaceActivation | null {
    if (closed || options.owner.aborted || !current) return null
    if (!matchesCurrent()) { revoke(); return null }
    return current.captured
  }

  function openFolder(): Promise<'opened' | 'cancelled'> {
    if (opening) return Promise.reject(new Error('A Browser directory selection is already pending.'))
    try {
      requireOwner()
      if (options.countDirtyEditors() !== 0) throw new Error('Save or revert unsaved editors before opening another folder.')
    } catch (error) { return Promise.reject(error) }

    // Invoke the real picker synchronously in this click stack. User activation
    // must not depend on a prior network request or lazy service initialization.
    let selection: Promise<string | undefined>
    try { selection = options.pickDirectory() }
    catch (error) { return Promise.reject(error) }
    const task = selection.then(async uri => {
      requireOwner()
      if (!uri) return 'cancelled' as const
      if (options.countDirtyEditors() !== 0) throw new Error('An editor changed while the directory picker was open. Save or revert it first.')
      // Same-folder reopen is a new generation even when the original
      // Workbench emits no folder-change event for equal URI lists.
      revoke()
      await options.initializeFolder(uri)
      requireOwner()
      const workspace = options.readWorkspace()
      if (workspace.folders.length !== 1 || workspace.folders[0] !== uri) {
        throw new Error('The Workbench did not activate the selected single folder.')
      }
      const revokeGeneration = new AbortController()
      const captured: BrowserCapturedWorkspaceActivation = Object.freeze({
        path: uri,
        projectSessionId: `browser-workspace:${instanceId}:${++generation}`,
        signal: AbortSignal.any([options.owner, lifetime.signal, revokeGeneration.signal]),
        requireCurrent() {
          requireOwner()
          revokeGeneration.signal.throwIfAborted()
          if (current?.captured !== captured || !matchesCurrent()) {
            if (current?.captured === captured) revoke()
            throw new DOMException('The Browser workspace activation is no longer current.', 'AbortError')
          }
        }
      })
      current = { captured, workspaceId: workspace.id, revoke: revokeGeneration }
      notify()
      return 'opened' as const
    }).finally(() => { if (opening === task) opening = null })
    opening = task
    void task.catch(() => { /* The original caller retains the failure. */ })
    return task
  }

  const port: BrowserWorkspaceActivationPort = Object.freeze({
    captureCurrentProjectActivation,
    projectActivation$: { subscribe(listener: (event: unknown) => void) {
      if (closed) throw new Error('The Browser workspace owner is closed.')
      activationListeners.add(listener)
      return { unsubscribe() { activationListeners.delete(listener) } }
    } },
    currentProjectPath$: { subscribe(listener: (path: string) => void) {
      if (closed) throw new Error('The Browser workspace owner is closed.')
      pathListeners.add(listener)
      try { listener(current?.captured.path ?? '') }
      catch (error) { pathListeners.delete(listener); throw error }
      return { unsubscribe() { pathListeners.delete(listener) } }
    } }
  })

  return Object.freeze({ port, openFolder, close, closeAndWait, snapshot() {
    return { closed, opening: opening !== null, closing: closing !== null, closeFailures, selected: current !== null,
      subscriptions: activationListeners.size + pathListeners.size,
      workspaceSubscriptionActive, retainedPendingSelection: opening !== null,
      retainedCleanupResponsibility: opening !== null || workspaceSubscriptionActive }
  } })
}
