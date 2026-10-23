import type { BrowserCapturedWorkspaceActivation, BrowserWorkspaceActivationPort } from './browserWorkspaceActivation.js'

export const BROWSER_PROJECT_PORT_KIND = 'aily-browser-project-port-v1'
export const BROWSER_PROJECT_PORT_LIMITS = Object.freeze({ pending: 4, terminalHistory: 64, chunkBytes: 64 * 1024,
  headBytes: 4 * 1024 * 1024, metadataBytes: 1024 * 1024, members: 63 })
const HEAD = '.aily/simulator/scene-network-v2.json'
const MANIFEST = 'aily-artifact-manifest.json'
const unavailable = () => new BrowserProjectPortError('unavailable')

export class BrowserProjectPortError extends Error {
  constructor(readonly code: 'unavailable' | 'closed' | 'invalid-message' | 'capacity-reached' | 'stale-generation'
    | 'invalid-range' | 'cleanup-unconfirmed' | 'operation-failed') { super(code); this.name = 'BrowserProjectPortError' }
}
export interface BrowserProjectPortArtifactMetadata {
  /** Original DTOs remain subject to the consuming Simulator's validators. */
  readonly artifact: unknown
  readonly artifactId: string
  readonly scope: { readonly projectIdentity: string, readonly artifactRevision: string }
  readonly manifest: { readonly sizeBytes: number, readonly sha256: string }
  readonly members: readonly { readonly path: string, readonly role: string, readonly sizeBytes: number, readonly sha256: string }[]
  readonly scene?: unknown
  readonly sceneEnvelope?: unknown
}
export interface BrowserProjectPortArtifactSnapshot {
  readonly metadata: BrowserProjectPortArtifactMetadata
  readRange(path: string, offset: number, length: number, signal: AbortSignal): Promise<Uint8Array>
  close(): Promise<void>
}
export type BrowserProjectPortSnapshotProvider = (captured: BrowserCapturedWorkspaceActivation,
  signal: AbortSignal) => Promise<BrowserProjectPortArtifactSnapshot>
export interface BrowserProjectPortServerOptions {
  readonly window: Window
  readonly expectedParentOrigin: string
  readonly activation: BrowserWorkspaceActivationPort
  readonly files: { readFile(captured: BrowserCapturedWorkspaceActivation, path: string, maximumBytes: number, signal: AbortSignal): Promise<Uint8Array> }
  readonly readArtifactSnapshot: BrowserProjectPortSnapshotProvider | null
}
export interface BrowserProjectPortClientOptions {
  readonly window: Window
  readonly childWindow: Window
  readonly expectedChildOrigin: string
  /** Optional original channel constructor, also permitting structural tests. */
  readonly createMessageChannel?: () => MessageChannel
}

type RecordValue = Record<string, unknown>
const record = (value: unknown): value is RecordValue => !!value && typeof value === 'object' && !Array.isArray(value)
const keys = (value: RecordValue, expected: string[]) => Object.keys(value).sort().join(',') === [...expected].sort().join(',')
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,256}$/.test(value)
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
function origin(value: string): string {
  const parsed = new URL(value)
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== value || parsed.username || parsed.password) throw new TypeError('An explicit exact HTTP(S) origin is required.')
  return value
}
function relative(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 1024 && !/[\\%\x00-\x1f\x7f]/.test(value)
    && !value.startsWith('/') && !/^[a-z][a-z0-9+.-]*:/i.test(value)
    && value.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..')
}
function range(offset: unknown, length: unknown, size: number): asserts offset is number {
  if (!integer(offset) || !integer(length) || length > BROWSER_PROJECT_PORT_LIMITS.chunkBytes
    || offset > size || length > size - offset) throw new BrowserProjectPortError('invalid-range')
}
function terminalRing() {
  const values: number[] = []
  return { add(value: number) { values.push(value); if (values.length > BROWSER_PROJECT_PORT_LIMITS.terminalHistory) values.shift() },
    has(value: number) { return values.includes(value) }, get size() { return values.length } }
}
/** Resource and path checks only, not Artifact schema or account admission. */
function captureMetadata(value: BrowserProjectPortArtifactMetadata) {
  const metadata = structuredClone(value)
  if (new TextEncoder().encode(JSON.stringify(metadata)).byteLength > BROWSER_PROJECT_PORT_LIMITS.metadataBytes
    || typeof metadata.artifactId !== 'string' || !record(metadata.scope)
    || metadata.artifactId !== metadata.scope.artifactRevision
    || !Array.isArray(metadata.members) || metadata.members.length < 1 || metadata.members.length > BROWSER_PROJECT_PORT_LIMITS.members
    || !metadata.manifest || !integer(metadata.manifest.sizeBytes) || metadata.manifest.sizeBytes < 1
    || metadata.manifest.sizeBytes > BROWSER_PROJECT_PORT_LIMITS.metadataBytes) throw new BrowserProjectPortError('invalid-message')
  const members = new Map<string, number>([[MANIFEST, metadata.manifest.sizeBytes]])
  for (const member of metadata.members) {
    if (!relative(member.path) || members.has(member.path) || !integer(member.sizeBytes)) throw new BrowserProjectPortError('invalid-message')
    members.set(member.path, member.sizeBytes)
  }
  return { metadata, members }
}
function closeReceived(ports: readonly MessagePort[]) { for (const port of ports) try { port.close() } catch { /* No authority was accepted. */ } }

/** Installs one document owner. The original selected Workbench activation is
 * the authority; this bridge retains only its original work and handles. */
export function installBrowserProjectPort(options: BrowserProjectPortServerOptions) {
  const expectedOrigin = origin(options.expectedParentOrigin), parent = options.window.parent
  if (parent === options.window) throw new TypeError('A separate parent Window is required.')
  const documentId = crypto.randomUUID(), lifetime = new AbortController(), terminals = terminalRing()
  let port: MessagePort | null = null, connectionNonce: string | null = null
  let acceptedConnection = false, closed = false, physicalPortClosed = false, protocolFault = false
  let lastRequestSeq = 0, outgoingSeq = 0, revision = 0, rejectedMessages = 0, cancelledRequests = 0
  let observed: BrowserCapturedWorkspaceActivation | null = null, openingArtifact = false
  let closing: Promise<void> | null = null, originalCloseFailures = 0
  let disposeReply: number | null = null
  const pending = new Map<number, { controller: AbortController, task: Promise<void>, op: string }>()
  const handles = new Map<string, { snapshot: BrowserProjectPortArtifactSnapshot, members: Map<string, number>,
    metadata: BrowserProjectPortArtifactMetadata, captured: BrowserCapturedWorkspaceActivation, closeTask: Promise<void> | null }>()
  const subscriptions: { unsubscribe(): void }[] = []
  const send = (type: string, value: RecordValue = {}) => {
    if (!port || physicalPortClosed) return
    port.postMessage({ kind: BROWSER_PROJECT_PORT_KIND, documentId, connectionNonce, messageSeq: ++outgoingSeq, type, ...value })
  }
  const closeHandle = (handleId: string): Promise<void> => {
    const owned = handles.get(handleId)
    if (!owned) return Promise.resolve()
    if (!owned.closeTask) {
      const task = Promise.resolve().then(() => owned.snapshot.close()).then(() => { handles.delete(handleId) }, error => {
        originalCloseFailures++; if (owned.closeTask === task) owned.closeTask = null; throw error
      })
      owned.closeTask = task
      void task.catch(() => { /* Keep this exact original handle for a retry. */ })
    }
    return owned.closeTask
  }
  function readCurrent(): BrowserCapturedWorkspaceActivation | null {
    if (closed) return null
    const captured = options.activation.captureCurrentProjectActivation()
    captured?.requireCurrent()
    return captured
  }
  function selectionChanged() {
    if (closed) return
    let current: BrowserCapturedWorkspaceActivation | null
    try { current = readCurrent() } catch { current = null }
    if (current === observed) return
    observed = current; revision++
    for (const [handleId, owned] of handles) if (owned.captured !== current) void closeHandle(handleId).catch(() => undefined)
    send('activation', { revision, selection: current ? { generation: current.projectSessionId } : null })
  }
  function capturedFor(generation: unknown) {
    const captured = readCurrent()
    if (!captured || captured.projectSessionId !== generation) throw new BrowserProjectPortError('stale-generation')
    return captured
  }
  const requireCaptured = (captured: BrowserCapturedWorkspaceActivation, signal: AbortSignal) => {
    signal.throwIfAborted(); captured.requireCurrent()
    if (options.activation.captureCurrentProjectActivation() !== captured) throw new BrowserProjectPortError('stale-generation')
  }
  async function perform(message: RecordValue, controller: AbortController): Promise<unknown> {
    if (message.op === 'capture') {
      const captured = readCurrent()
      return { revision, selection: captured ? { generation: captured.projectSessionId } : null }
    }
    const captured = capturedFor(message.generation)
    const signal = AbortSignal.any([controller.signal, lifetime.signal, captured.signal])
    requireCaptured(captured, signal)
    if (message.op === 'readHead') {
      const bytes = await options.files.readFile(captured, HEAD, BROWSER_PROJECT_PORT_LIMITS.headBytes, signal)
      requireCaptured(captured, signal)
      if (!(bytes instanceof Uint8Array) || bytes.length > BROWSER_PROJECT_PORT_LIMITS.headBytes) throw new BrowserProjectPortError('invalid-range')
      range(message.offset, message.length, bytes.length)
      return { bytes: bytes.slice(message.offset, message.offset + (message.length as number)), totalBytes: bytes.length }
    }
    if (message.op === 'openArtifact') {
      if (!options.readArtifactSnapshot) throw unavailable()
      if (openingArtifact || handles.size !== 0) throw new BrowserProjectPortError('capacity-reached')
      openingArtifact = true
      let adopted: string | null = null
      try {
        const snapshot = await options.readArtifactSnapshot(captured, signal)
        if (!snapshot || typeof snapshot.close !== 'function' || typeof snapshot.readRange !== 'function') {
          protocolFault = true; throw new BrowserProjectPortError('cleanup-unconfirmed')
        }
        const handleId = crypto.randomUUID()
        // Adopt the original late handle before checking cancellation or DTOs.
        const owned = { snapshot, members: new Map<string, number>(), metadata: snapshot.metadata, captured, closeTask: null as Promise<void> | null }
        handles.set(handleId, owned); adopted = handleId
        requireCaptured(captured, signal)
        const admitted = captureMetadata(snapshot.metadata)
        owned.members = admitted.members; owned.metadata = admitted.metadata
        return { handleId, metadata: admitted.metadata }
      } catch (error) {
        if (adopted) try { await closeHandle(adopted) } catch (cleanup) { throw new AggregateError([error, cleanup], 'Original snapshot cleanup remains unconfirmed.') }
        throw error
      } finally { openingArtifact = false }
    }
    const owned = typeof message.handleId === 'string' ? handles.get(message.handleId) : undefined
    if (!owned || owned.captured !== captured) throw new BrowserProjectPortError('stale-generation')
    if (message.op === 'readRange') {
      const size = typeof message.path === 'string' ? owned.members.get(message.path) : undefined
      if (size === undefined) throw new BrowserProjectPortError('invalid-range')
      range(message.offset, message.length, size)
      const bytes = await owned.snapshot.readRange(message.path as string, message.offset, message.length as number, signal)
      requireCaptured(captured, signal)
      if (!(bytes instanceof Uint8Array) || bytes.length !== message.length) throw new BrowserProjectPortError('invalid-range')
      return { bytes: bytes.slice() }
    }
    if (message.op === 'disposeArtifact') { await closeHandle(message.handleId as string); return { originalSnapshotCloseAcknowledged: true } }
    throw new BrowserProjectPortError('invalid-message')
  }
  function beginClose(): Promise<void> {
    if (closing) return closing
    closed = true; lifetime.abort(new BrowserProjectPortError('closed'))
    send('activation', { revision: ++revision, selection: null })
    options.window.removeEventListener('message', handshake)
    options.window.removeEventListener('pagehide', pagehide)
    for (const subscription of [...subscriptions]) {
      try { subscription.unsubscribe(); subscriptions.splice(subscriptions.indexOf(subscription), 1) }
      catch { originalCloseFailures++ }
    }
    const task = Promise.resolve().then(async () => {
      await Promise.allSettled([...pending.values()].map(item => item.task))
      const outcomes = await Promise.allSettled([...handles.keys()].map(closeHandle))
      if (outcomes.some(outcome => outcome.status === 'rejected') || handles.size !== 0 || subscriptions.length !== 0 || protocolFault) throw new BrowserProjectPortError('cleanup-unconfirmed')
    }).finally(() => { if (closing === task) closing = null })
    closing = task; void task.catch(() => { /* The owning document retains pending or failed original cleanup. */ })
    return task
  }
  const messageKeys: Record<string, string[]> = {
    capture: [], openArtifact: ['generation'], readHead: ['generation', 'offset', 'length'],
    readRange: ['generation', 'handleId', 'path', 'offset', 'length'], disposeArtifact: ['generation', 'handleId'],
    cancel: ['target'], dispose: [],
  }
  function receive(event: MessageEvent) {
    if (event.ports.length) { rejectedMessages++; closeReceived(event.ports); return }
    const message = event.data
    if (!record(message) || message.kind !== BROWSER_PROJECT_PORT_KIND || message.documentId !== documentId
      || message.connectionNonce !== connectionNonce || !id(message.op) || !Object.hasOwn(messageKeys, message.op)
      || !keys(message, ['kind', 'documentId', 'connectionNonce', 'seq', 'op', ...messageKeys[message.op]!])
      || !integer(message.seq) || message.seq !== lastRequestSeq + 1) { rejectedMessages++; return }
    lastRequestSeq = message.seq
    const seq = message.seq
    if (message.op === 'cancel') {
      if (integer(message.target)) { const original = pending.get(message.target); if (original) { cancelledRequests++; original.controller.abort(new DOMException('Caller cancelled.', 'AbortError')) } }
      terminals.add(seq); return
    }
    if (message.op === 'dispose') {
      if (disposeReply !== null) { terminals.add(seq); send('result', { replyTo: seq, status: 'error', error: 'capacity-reached' }); return }
      disposeReply = seq
      void beginClose().then(() => {
        terminals.add(seq); send('result', { replyTo: seq, status: 'ok', value: { originalWorkSettled: true, originalSnapshotsClosed: true,
          WorkerPhysicalExitConfirmed: false, NodeBusinessACK: false, MainBusinessACK: false } })
        port?.close(); physicalPortClosed = true; disposeReply = null
      }, () => { terminals.add(seq); send('result', { replyTo: seq, status: 'error', error: 'cleanup-unconfirmed' }); disposeReply = null })
      return
    }
    if (closed || pending.size >= BROWSER_PROJECT_PORT_LIMITS.pending) {
      terminals.add(seq); send('result', { replyTo: seq, status: 'error', error: closed ? 'closed' : 'capacity-reached' }); return
    }
    if ((message.op === 'readHead' || message.op === 'readRange') && (!integer(message.offset) || !integer(message.length)
      || message.length > BROWSER_PROJECT_PORT_LIMITS.chunkBytes)) {
      terminals.add(seq); send('result', { replyTo: seq, status: 'error', error: 'invalid-range' }); return
    }
    const controller = new AbortController()
    const task = Promise.resolve().then(() => perform(message, controller)).then(value => {
      terminals.add(seq); send('result', { replyTo: seq, status: 'ok', value })
    }, error => {
      terminals.add(seq); send('result', { replyTo: seq, status: 'error', error: error instanceof BrowserProjectPortError ? error.code
        : error instanceof DOMException && error.name === 'AbortError' ? 'closed' : 'operation-failed' })
    }).finally(() => { pending.delete(seq) })
    pending.set(seq, { controller, task, op: message.op })
  }
  function handshake(event: MessageEvent) {
    if (!record(event.data) || event.data.kind !== BROWSER_PROJECT_PORT_KIND) return
    if (event.source !== parent || event.origin !== expectedOrigin) { rejectedMessages++; closeReceived(event.ports); return }
    const message = event.data
    if (keys(message, ['kind', 'type']) && message.type === 'discover' && event.ports.length === 0) {
      if (!acceptedConnection && !closed) parent.postMessage({ kind: BROWSER_PROJECT_PORT_KIND, type: 'ready', documentId }, expectedOrigin)
      return
    }
    if (!keys(message, ['kind', 'type', 'documentId', 'connectionNonce']) || message.type !== 'connect'
      || message.documentId !== documentId || !id(message.connectionNonce) || event.ports.length !== 1 || acceptedConnection || closed) {
      rejectedMessages++; closeReceived(event.ports); return
    }
    acceptedConnection = true; connectionNonce = message.connectionNonce; port = event.ports[0]!
    port.onmessage = receive; port.onmessageerror = () => { protocolFault = true; void beginClose().catch(() => undefined) }; port.start()
    observed = readCurrent()
    send('connected', { revision, selection: observed ? { generation: observed.projectSessionId } : null })
    try {
      subscriptions.push(options.activation.projectActivation$.subscribe(selectionChanged))
      subscriptions.push(options.activation.currentProjectPath$.subscribe(selectionChanged))
      selectionChanged()
    } catch { protocolFault = true; void beginClose().catch(() => undefined) }
  }
  function pagehide() { void closeAndWait().catch(() => { /* Navigation is not an original cleanup ACK. */ }) }
  function closeAndWait(): Promise<void> {
    return beginClose().then(() => { port?.close(); physicalPortClosed = true })
  }
  options.window.addEventListener('message', handshake); options.window.addEventListener('pagehide', pagehide)
  parent.postMessage({ kind: BROWSER_PROJECT_PORT_KIND, type: 'ready', documentId }, expectedOrigin)
  return Object.freeze({ documentId, close: closeAndWait, closeAndWait, snapshot() {
    return { documentId, connected: acceptedConnection, closed, physicalPortClosed, pending: pending.size,
      retainedSnapshots: handles.size, openingArtifact, subscriptions: subscriptions.length, terminalHistory: terminals.size,
      lastRequestSeq, rejectedMessages, cancelledRequests, originalCloseFailures, protocolFault,
      retainedCleanupResponsibility: pending.size !== 0 || handles.size !== 0 || subscriptions.length !== 0 || protocolFault,
      WorkerPhysicalExitConfirmed: false, NodeBusinessACK: false, MainBusinessACK: false }
  } })
}

/** Parent proxy. A captured activation is only this document/connection's
 * selected-generation capability and conveys no account or subscription grant. */
export function createBrowserProjectPortClient(options: BrowserProjectPortClientOptions) {
  const childOrigin = origin(options.expectedChildOrigin), terminals = terminalRing(), lifetime = new AbortController()
  let documentId: string | null = null, connectionNonce: string | null = null, port: MessagePort | null = null
  let seq = 0, messageSeq = 0, revision = -1, closed = false, connected = false, physicalPortClosed = false
  let cleanupAcknowledged = false, cleanupUnconfirmed = false, rejectedMessages = 0, callerCancellations = 0
  let current: BrowserCapturedWorkspaceActivation | null = null, currentRevoke: AbortController | null = null
  let resolveReady!: () => void, rejectReady!: (error: unknown) => void, closing: Promise<void> | null = null
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
  void ready.catch(() => { /* The original caller retains readiness failure. */ })
  const activationListeners = new Set<(value: unknown) => void>(), pathListeners = new Set<(value: string) => void>()
  const pending = new Map<number, { resolve(value: unknown): void, reject(error: unknown): void,
    removeAbort(): void, callerSettled: boolean, op: string, fields: RecordValue }>()
  let disposeRecord: { seq: number, resolve(value: unknown): void, reject(error: unknown): void } | null = null
  const send = (op: string, fields: RecordValue = {}) => {
    if (!port || physicalPortClosed || seq >= Number.MAX_SAFE_INTEGER) throw new BrowserProjectPortError('closed')
    const requestSeq = ++seq
    port.postMessage({ kind: BROWSER_PROJECT_PORT_KIND, documentId, connectionNonce, seq: requestSeq, op, ...fields })
    return requestSeq
  }
  function revoke(reason = new BrowserProjectPortError('stale-generation')) {
    currentRevoke?.abort(reason); currentRevoke = null; current = null
    for (const listener of pathListeners) try { listener('') } catch { /* An observer cannot veto revocation. */ }
    for (const listener of activationListeners) try { listener(null) } catch { /* An observer cannot veto revocation. */ }
  }
  function select(value: unknown, nextRevision: unknown) {
    if (!integer(nextRevision) || nextRevision < revision || !(value === null || record(value) && keys(value, ['generation']) && id(value.generation))) throw new BrowserProjectPortError('invalid-message')
    if (nextRevision === revision) return
    revision = nextRevision; revoke()
    if (value !== null && !closed) {
      const generation = (value as RecordValue).generation as string, revokeGeneration = new AbortController()
      currentRevoke = revokeGeneration
      const captured: BrowserCapturedWorkspaceActivation = Object.freeze({ path: `browser-project-port:${documentId}:${generation}`,
        projectSessionId: generation, signal: AbortSignal.any([lifetime.signal, revokeGeneration.signal]),
        requireCurrent() { captured.signal.throwIfAborted(); if (!connected || closed || current !== captured) throw new BrowserProjectPortError('stale-generation') } })
      current = captured
      for (const listener of pathListeners) try { listener(captured.path) } catch { /* Observer only. */ }
      for (const listener of activationListeners) try { listener(captured) } catch { /* Observer only. */ }
    }
  }
  function fault() {
    cleanupUnconfirmed = true; connected = false; revoke(new BrowserProjectPortError('cleanup-unconfirmed'))
    rejectReady(new BrowserProjectPortError('cleanup-unconfirmed'))
    for (const item of pending.values()) if (!item.callerSettled) { item.callerSettled = true; item.removeAbort(); item.reject(new BrowserProjectPortError('cleanup-unconfirmed')) }
    disposeRecord?.reject(new BrowserProjectPortError('cleanup-unconfirmed'))
  }
  function request(op: string, fields: RecordValue = {}, signal?: AbortSignal): Promise<unknown> {
    try {
      signal?.throwIfAborted()
      if (!connected || closed) throw new BrowserProjectPortError('closed')
      if (pending.size >= BROWSER_PROJECT_PORT_LIMITS.pending) throw new BrowserProjectPortError('capacity-reached')
      return new Promise((resolve, reject) => {
        const requestSeq = seq + 1
        const item = { resolve, reject, removeAbort: () => signal?.removeEventListener('abort', aborted), callerSettled: false, op, fields }
        const aborted = () => {
          if (item.callerSettled) return
          item.callerSettled = true; item.removeAbort(); callerCancellations++
          try { send('cancel', { target: requestSeq }) } catch { cleanupUnconfirmed = true }
          reject(signal?.reason ?? new DOMException('Caller cancelled.', 'AbortError'))
          // The original wire slot remains occupied until its real result.
        }
        pending.set(requestSeq, item)
        signal?.addEventListener('abort', aborted, { once: true })
        try { send(op, fields) } catch (error) { pending.delete(requestSeq); item.removeAbort(); reject(error) }
      })
    } catch (error) { return Promise.reject(error) }
  }
  function receive(event: MessageEvent) {
    if (event.ports.length) { rejectedMessages++; closeReceived(event.ports); return }
    const message = event.data
    if (!record(message) || message.kind !== BROWSER_PROJECT_PORT_KIND || message.documentId !== documentId
      || message.connectionNonce !== connectionNonce || !integer(message.messageSeq) || message.messageSeq !== messageSeq + 1) { rejectedMessages++; return }
    if (message.type === 'connected' || message.type === 'activation') {
      if (!keys(message, ['kind', 'documentId', 'connectionNonce', 'messageSeq', 'type', 'revision', 'selection']) || message.type === 'connected' && connected) { rejectedMessages++; return }
      if (message.type === 'connected') connected = true
      try { select(message.selection, message.revision) } catch { rejectedMessages++; fault(); return }
      messageSeq = message.messageSeq
      if (message.type === 'connected') resolveReady()
      return
    }
    if (message.type !== 'result' || !integer(message.replyTo) || !['ok', 'error'].includes(message.status as string)
      || !keys(message, ['kind', 'documentId', 'connectionNonce', 'messageSeq', 'type', 'replyTo', 'status', message.status === 'ok' ? 'value' : 'error'])) { rejectedMessages++; return }
    messageSeq = message.messageSeq
    const replyTo = message.replyTo
    if (terminals.has(replyTo)) { rejectedMessages++; return }
    if (disposeRecord?.seq === replyTo) {
      const original = disposeRecord; disposeRecord = null; terminals.add(replyTo)
      if (message.status === 'ok' && record(message.value)
        && keys(message.value, ['originalWorkSettled', 'originalSnapshotsClosed', 'WorkerPhysicalExitConfirmed', 'NodeBusinessACK', 'MainBusinessACK'])
        && message.value.originalWorkSettled === true && message.value.originalSnapshotsClosed === true
        && message.value.WorkerPhysicalExitConfirmed === false && message.value.NodeBusinessACK === false && message.value.MainBusinessACK === false) {
        cleanupAcknowledged = true; cleanupUnconfirmed = false
        for (const item of pending.values()) { item.removeAbort(); if (!item.callerSettled) item.reject(new BrowserProjectPortError('closed')) }
        pending.clear(); original.resolve(message.value)
      } else { cleanupUnconfirmed = true; original.reject(new BrowserProjectPortError('cleanup-unconfirmed')) }
      return
    }
    const item = pending.get(replyTo)
    if (!item) { rejectedMessages++; return }
    pending.delete(replyTo); terminals.add(replyTo); item.removeAbort()
    if (!item.callerSettled) {
      item.callerSettled = true
      if (message.status === 'ok') item.resolve(message.value)
      else item.reject(new BrowserProjectPortError(['unavailable', 'closed', 'capacity-reached', 'stale-generation', 'invalid-range', 'cleanup-unconfirmed'].includes(message.error as string)
        ? message.error as BrowserProjectPortError['code'] : 'operation-failed'))
    } else if (item.op === 'openArtifact' && message.status === 'ok' && record(message.value) && id(message.value.handleId) && !closed) {
      // A caller can cancel after the original open result was posted. Adopt
      // its late handle for cleanup rather than silently orphaning it.
      void request('disposeArtifact', { generation: item.fields.generation, handleId: message.value.handleId })
        .catch(() => { cleanupUnconfirmed = true })
    }
  }
  function handshake(event: MessageEvent) {
    if (!record(event.data) || event.data.kind !== BROWSER_PROJECT_PORT_KIND) return
    if (event.source !== options.childWindow || event.origin !== childOrigin) { rejectedMessages++; closeReceived(event.ports); return }
    const message = event.data
    if (!keys(message, ['kind', 'type', 'documentId']) || message.type !== 'ready' || !id(message.documentId) || event.ports.length !== 0) {
      rejectedMessages++; closeReceived(event.ports); return
    }
    if (documentId !== null) {
      if (message.documentId !== documentId) { fault(); void close().catch(() => undefined) }
      else rejectedMessages++
      return
    }
    if (closed) return
    documentId = message.documentId; connectionNonce = crypto.randomUUID()
    const channel = options.createMessageChannel?.() ?? new MessageChannel()
    port = channel.port1; port.onmessage = receive; port.onmessageerror = fault; port.start()
    options.childWindow.postMessage({ kind: BROWSER_PROJECT_PORT_KIND, type: 'connect', documentId, connectionNonce }, childOrigin, [channel.port2])
  }
  function close(): Promise<void> {
    if (closing) return closing
    if (cleanupAcknowledged) return Promise.resolve()
    closed = true; lifetime.abort(new BrowserProjectPortError('closed')); revoke(new BrowserProjectPortError('closed'))
    for (const item of pending.values()) if (!item.callerSettled) {
      item.callerSettled = true; item.removeAbort(); item.reject(new BrowserProjectPortError('closed'))
    }
    options.window.removeEventListener('message', handshake); options.window.removeEventListener('pagehide', pagehide)
    activationListeners.clear(); pathListeners.clear()
    if (!port || !connected) {
      if (documentId !== null) cleanupUnconfirmed = true
      port?.close(); physicalPortClosed = true; rejectReady(new BrowserProjectPortError('closed'))
      return cleanupUnconfirmed ? Promise.reject(new BrowserProjectPortError('cleanup-unconfirmed')) : Promise.resolve()
    }
    const task = new Promise<void>((resolve, reject) => {
      const requestSeq = seq + 1; disposeRecord = { seq: requestSeq, resolve: () => resolve(), reject }
      try { send('dispose') } catch (error) { cleanupUnconfirmed = true; disposeRecord = null; reject(error) }
    }).then(() => { port?.close(); physicalPortClosed = true; connected = false })
      .finally(() => { if (closing === task) closing = null })
    closing = task; void task.catch(() => { /* Caller owns any original unconfirmed server cleanup. */ }); return task
  }
  function pagehide() { void close().catch(() => undefined) }
  const activation: BrowserWorkspaceActivationPort = Object.freeze({
    captureCurrentProjectActivation() { if (!connected || closed) return null; current?.requireCurrent(); return current },
    currentProjectPath$: { subscribe(listener: (value: string) => void) {
      if (closed) throw new BrowserProjectPortError('closed'); pathListeners.add(listener)
      try { listener(current?.path ?? '') } catch (error) { pathListeners.delete(listener); throw error }
      return { unsubscribe() { pathListeners.delete(listener) } }
    } },
    projectActivation$: { subscribe(listener: (value: unknown) => void) {
      if (closed) throw new BrowserProjectPortError('closed'); activationListeners.add(listener)
      return { unsubscribe() { activationListeners.delete(listener) } }
    } },
  })
  options.window.addEventListener('message', handshake); options.window.addEventListener('pagehide', pagehide)
  options.childWindow.postMessage({ kind: BROWSER_PROJECT_PORT_KIND, type: 'discover' }, childOrigin)
  return Object.freeze({ ready, activation,
    async capture(signal?: AbortSignal) { const result = await request('capture', {}, signal) as RecordValue; select(result.selection, result.revision); return activation.captureCurrentProjectActivation() },
    async readSceneHead(signal?: AbortSignal) {
      const captured = activation.captureCurrentProjectActivation(); if (!captured) throw unavailable()
      const generation = captured.projectSessionId, combined = AbortSignal.any([captured.signal, ...(signal ? [signal] : [])])
      // First read is zero-length to learn only the fixed HEAD's bounded size.
      const first = await request('readHead', { generation, offset: 0, length: 0 }, combined) as { totalBytes: number, bytes: Uint8Array }
      if (!integer(first.totalBytes) || first.totalBytes > BROWSER_PROJECT_PORT_LIMITS.headBytes) throw new BrowserProjectPortError('invalid-range')
      const result = new Uint8Array(first.totalBytes)
      for (let offset = 0; offset < result.length; offset += BROWSER_PROJECT_PORT_LIMITS.chunkBytes) {
        const length = Math.min(BROWSER_PROJECT_PORT_LIMITS.chunkBytes, result.length - offset)
        const chunk = await request('readHead', { generation, offset, length }, combined) as { totalBytes: number, bytes: Uint8Array }
        captured.requireCurrent()
        if (chunk.totalBytes !== result.length || !(chunk.bytes instanceof Uint8Array) || chunk.bytes.length !== length) throw new BrowserProjectPortError('invalid-range')
        result.set(chunk.bytes, offset)
      }
      captured.requireCurrent(); return result
    },
    async openArtifact(signal?: AbortSignal) {
      const captured = activation.captureCurrentProjectActivation(); if (!captured) throw unavailable()
      const generation = captured.projectSessionId, combined = AbortSignal.any([captured.signal, ...(signal ? [signal] : [])])
      const result = await request('openArtifact', { generation }, combined) as { handleId: string, metadata: BrowserProjectPortArtifactMetadata }
      captured.requireCurrent()
      if (!id(result.handleId)) throw new BrowserProjectPortError('invalid-message')
      const admitted = captureMetadata(result.metadata), handleId = result.handleId
      let disposed = false, disposeTask: Promise<void> | null = null
      return Object.freeze({ metadata: admitted.metadata,
        async readRange(path: string, offset: number, length: number, readSignal?: AbortSignal) {
          captured.requireCurrent(); if (disposed) throw new BrowserProjectPortError('closed')
          const size = admitted.members.get(path); if (size === undefined) throw new BrowserProjectPortError('invalid-range')
          range(offset, length, size)
          const currentSignal = AbortSignal.any([captured.signal, ...(readSignal ? [readSignal] : [])])
          const chunk = await request('readRange', { generation, handleId, path, offset, length }, currentSignal) as { bytes: Uint8Array }
          captured.requireCurrent()
          if (!(chunk.bytes instanceof Uint8Array) || chunk.bytes.length !== length) throw new BrowserProjectPortError('invalid-range')
          return chunk.bytes.slice()
        },
        close(): Promise<void> {
          if (disposeTask) return disposeTask
          disposed = true
          const task = request('disposeArtifact', { generation, handleId }).then(() => undefined)
            .catch(error => { if (disposeTask === task) disposeTask = null; throw error })
          disposeTask = task; void task.catch(() => { /* Original server handle may still be retained. */ }); return task
        },
      })
    }, close, snapshot() {
      return { documentId, connected, closed, physicalPortClosed, cleanupAcknowledged, cleanupUnconfirmed,
        pending: pending.size, cancelledAwaitingOriginalSettlement: [...pending.values()].filter(item => item.callerSettled).length,
        disposePending: disposeRecord !== null, terminalHistory: terminals.size, totalRequests: seq,
        subscriptions: activationListeners.size + pathListeners.size, rejectedMessages, callerCancellations,
        retainedCleanupResponsibility: pending.size !== 0 || disposeRecord !== null || cleanupUnconfirmed || connected && !cleanupAcknowledged,
        productionAuthorizationAccepted: false, WorkerPhysicalExitConfirmed: false, NodeBusinessACK: false, MainBusinessACK: false }
    },
  })
}
