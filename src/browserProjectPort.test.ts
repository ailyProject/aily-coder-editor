import assert from 'node:assert/strict'
import test from 'node:test'
import { BROWSER_PROJECT_PORT_KIND, BROWSER_PROJECT_PORT_LIMITS, createBrowserProjectPortClient,
  installBrowserProjectPort, type BrowserProjectPortArtifactSnapshot, type BrowserProjectPortSnapshotProvider } from './browserProjectPort.js'
import { createBrowserWorkspaceActivation, type BrowserWorkspaceSnapshot } from './browserWorkspaceActivation.js'

// Explicit structural Window/picker/file/snapshot doubles with real Node
// MessageChannels. These cases do not accept a Browser, Workbench, original
// Artifact schema, filesystem, deployment, subscription or business ACK.
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
const turn = () => new Promise<void>(resolve => setImmediate(resolve))
function windows() {
  const parentListeners = new Map<string, Set<(event: any) => void>>()
  const childListeners = new Map<string, Set<(event: any) => void>>()
  function eventTarget(listeners: Map<string, Set<(event: any) => void>>) {
    return { addEventListener(type: string, listener: (event: any) => void) {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type)!.add(listener)
    }, removeEventListener(type: string, listener: (event: any) => void) { listeners.get(type)?.delete(listener) } }
  }
  const expectedOrigin = 'https://project-port.invalid'
  let lastConnect: Record<string, unknown> | null = null
  const parent: any = { ...eventTarget(parentListeners) }, child: any = { ...eventTarget(childListeners), parent }
  parent.parent = parent
  const emitParent = (event: any) => { for (const listener of parentListeners.get('message') ?? []) listener(event) }
  const emitChild = (event: any) => { for (const listener of childListeners.get('message') ?? []) listener(event) }
  parent.postMessage = (data: unknown, target: string, ports: MessagePort[] = []) => {
    assert.equal(target, expectedOrigin)
    queueMicrotask(() => emitParent({ data, origin: expectedOrigin, source: child, ports }))
  }
  child.postMessage = (data: unknown, target: string, ports: MessagePort[] = []) => {
    assert.equal(target, expectedOrigin)
    if (data && typeof data === 'object' && (data as Record<string, unknown>).type === 'connect') lastConnect = data as Record<string, unknown>
    queueMicrotask(() => emitChild({ data, origin: expectedOrigin, source: parent, ports }))
  }
  return { parent: parent as Window, child: child as Window, expectedOrigin, emitParent, emitChild,
    getConnect() { assert(lastConnect); return lastConnect },
    childPagehide() { for (const listener of childListeners.get('pagehide') ?? []) listener({ persisted: false }) } }
}
function snapshot(bytes = new Uint8Array([1, 2, 3])) {
  let closes = 0, closeFailures = 0, reads = 0
  const value: BrowserProjectPortArtifactSnapshot = {
    metadata: { artifact: { explicitValidatorDouble: true }, artifactId: '0'.repeat(64), scope: { projectIdentity: 'test-project', artifactRevision: '0'.repeat(64) },
      manifest: { sizeBytes: 2, sha256: '0'.repeat(64) }, members: [{ path: 'sketch.hex', role: 'firmware', sizeBytes: bytes.length, sha256: '1'.repeat(64) }] },
    async readRange(path, offset, length, signal) { signal.throwIfAborted(); reads++; return path === 'aily-artifact-manifest.json'
      ? new Uint8Array([123, 125]).slice(offset, offset + length) : bytes.slice(offset, offset + length) },
    async close() { closes++; if (closeFailures) { closeFailures--; throw new Error('Original snapshot close failed.') } },
  }
  return { value, failCloseOnce() { closeFailures = 1 }, get closes() { return closes }, get reads() { return reads } }
}
async function fixture(provider: BrowserProjectPortSnapshotProvider | null = null, selected = true) {
  const windowPair = windows(), owner = new AbortController(), changes = new Set<() => void>()
  let workspace: BrowserWorkspaceSnapshot = { id: 'empty', folders: [] }, headReads = 0, originalCapture = 0
  const selection = createBrowserWorkspaceActivation({ owner: owner.signal, readWorkspace: () => workspace,
    onWorkspaceChange(listener) { changes.add(listener); return { dispose() { changes.delete(listener) } } }, countDirtyEditors: () => 0,
    pickDirectory: () => Promise.resolve('file:///original-selected-folder'), async initializeFolder(uri) {
      workspace = { id: 'original-Workbench-generation', folders: [uri] }; for (const listener of changes) listener()
    } })
  if (selected) await selection.openFolder()
  const server = installBrowserProjectPort({ window: windowPair.child, expectedParentOrigin: windowPair.expectedOrigin,
    activation: { ...selection.port, captureCurrentProjectActivation() { originalCapture++; return selection.port.captureCurrentProjectActivation() } },
    files: { async readFile(captured, path, maximumBytes, signal) {
      captured.requireCurrent(); signal.throwIfAborted(); assert.equal(path, '.aily/simulator/scene-network-v2.json')
      assert.equal(maximumBytes, BROWSER_PROJECT_PORT_LIMITS.headBytes); headReads++
      return new TextEncoder().encode('{"explicitHeadDouble":true}')
    } }, readArtifactSnapshot: provider })
  // The child ready notification is deliberately lost before client creation.
  await turn()
  let parentPort!: MessagePort
  const client = createBrowserProjectPortClient({ window: windowPair.parent, childWindow: windowPair.child,
    expectedChildOrigin: windowPair.expectedOrigin, createMessageChannel() { const channel = new MessageChannel(); parentPort = channel.port1; return channel } })
  await client.ready
  return { ...windowPair, owner, selection, server, client, get parentPort() { return parentPort },
    get headReads() { return headReads }, get originalCapture() { return originalCapture },
    changeWorkspace() { workspace = { id: 'another-original-workspace', folders: ['file:///other'] }; for (const listener of changes) listener() },
    async close() { try { await client.close() } finally { await server.closeAndWait(); await selection.closeAndWait(); owner.abort(); parentPort.close() } } }
}

test('late parent connects through exact-origin discovery and mirrors only the original selected generation', async () => {
  const f = await fixture(null, false)
  try {
    assert.equal(f.client.activation.captureCurrentProjectActivation(), null)
    assert.equal(f.client.snapshot().pending, 0)
    await f.selection.openFolder(); await f.client.capture()
    const captured = f.client.activation.captureCurrentProjectActivation(); assert(captured)
    assert.equal(captured.projectSessionId, f.selection.port.captureCurrentProjectActivation()!.projectSessionId)
    assert.match(captured.path, /^browser-project-port:/)
    assert(!captured.path.includes('file:///'))
    f.changeWorkspace(); await f.client.capture()
    assert.equal(captured.signal.aborted, true); assert.equal(f.client.activation.captureCurrentProjectActivation(), null)
    assert(f.originalCapture > 0)
  } finally { await f.close() }
})

test('handshake rejects other origin/source, extra fields, duplicate connections and transferred-port count', async () => {
  const f = await fixture()
  try {
    const before = f.server.snapshot().rejectedMessages
    const base = { kind: BROWSER_PROJECT_PORT_KIND, type: 'connect', documentId: f.server.documentId, connectionNonce: crypto.randomUUID() }
    for (const value of [
      { data: base, origin: 'https://other.invalid', source: f.parent, ports: [] },
      { data: base, origin: f.expectedOrigin, source: {}, ports: [] },
      { data: { ...base, arbitrary: true }, origin: f.expectedOrigin, source: f.parent, ports: [] },
      { data: base, origin: f.expectedOrigin, source: f.parent, ports: [] },
    ]) f.emitChild(value)
    const a = new MessageChannel(), b = new MessageChannel()
    f.emitChild({ data: base, origin: f.expectedOrigin, source: f.parent, ports: [a.port2, b.port2] })
    a.port1.close(); b.port1.close()
    assert.equal(f.server.snapshot().rejectedMessages - before, 5)
    const captured = await f.client.capture(); assert(captured)
  } finally { await f.close() }
})

test('more than 64 cumulative requests retain bounded terminal history and no lifetime request cap', async () => {
  const f = await fixture()
  try {
    for (let index = 0; index < 80; index++) assert(await f.client.capture())
    assert.equal(f.client.snapshot().totalRequests, 80)
    assert.equal(f.client.snapshot().terminalHistory, 64); assert.equal(f.server.snapshot().terminalHistory, 64)
    assert.equal(f.client.snapshot().pending, 0)
  } finally { await f.close() }
})

test('bound document/nonce, exact request keys and monotonic sequence reject replay without advancing authority', async () => {
  const f = await fixture()
  try {
    const connection = f.getConnect(), before = f.server.snapshot().rejectedMessages
    const base = { kind: BROWSER_PROJECT_PORT_KIND, documentId: connection.documentId, connectionNonce: connection.connectionNonce, seq: 1, op: 'capture' }
    f.parentPort.postMessage({ ...base, unknownField: true }); await turn()
    assert(await f.client.capture())
    f.parentPort.postMessage(base)
    f.parentPort.postMessage({ ...base, seq: 2, connectionNonce: crypto.randomUUID() })
    f.parentPort.postMessage({ ...base, seq: 2, documentId: crypto.randomUUID() })
    f.parentPort.postMessage({ ...base, seq: 2, op: 'toString' })
    await turn()
    assert(await f.client.capture())
    assert.equal(f.server.snapshot().rejectedMessages - before, 5)
    assert.equal(f.server.snapshot().lastRequestSeq, 2)
  } finally { await f.close() }
})

test('sealed snapshot range exposes only normal manifest and admitted members, with original close ownership', async () => {
  const original = snapshot(), f = await fixture(async () => original.value)
  try {
    const head = await f.client.readSceneHead(); assert.equal(new TextDecoder().decode(head), '{"explicitHeadDouble":true}')
    const artifact = await f.client.openArtifact()
    assert.deepEqual(artifact.metadata.artifact, { explicitValidatorDouble: true })
    assert.deepEqual(await artifact.readRange('sketch.hex', 0, 3), new Uint8Array([1, 2, 3]))
    assert.deepEqual(await artifact.readRange('aily-artifact-manifest.json', 0, 2), new Uint8Array([123, 125]))
    for (const path of ['.build/sketch.hex', '../sketch.hex', 'other.hex', '.aily/simulator/scene-network-v2.json']) {
      await assert.rejects(artifact.readRange(path, 0, 0), { code: 'invalid-range' })
    }
    await assert.rejects(artifact.readRange('sketch.hex', 0, 65537), { code: 'invalid-range' })
    await artifact.close(); await artifact.close(); assert.equal(original.closes, 1)
    assert.equal(f.server.snapshot().retainedSnapshots, 0)
  } finally { await f.close() }
})

test('missing snapshot provider is unavailable without inventing an Artifact or reading project files', async () => {
  const f = await fixture()
  try {
    await assert.rejects(f.client.openArtifact(), { code: 'unavailable' })
    assert.equal(f.headReads, 0); assert.equal(f.server.snapshot().retainedSnapshots, 0)
  } finally { await f.close() }
})

test('cancelled original work retains its pending slot and document dispose waits for late snapshot cleanup', async () => {
  const started = deferred<void>(), late = deferred<BrowserProjectPortArtifactSnapshot>(), original = snapshot()
  const f = await fixture(async () => { started.resolve(); return late.promise })
  try {
    const cancellation = new AbortController(), opening = f.client.openArtifact(cancellation.signal)
    const originalOutcome = assert.rejects(opening)
    await started.promise; cancellation.abort(new DOMException('Caller cancelled.', 'AbortError')); await originalOutcome
    assert.equal(f.client.snapshot().pending, 1); assert.equal(f.client.snapshot().cancelledAwaitingOriginalSettlement, 1)
    assert.equal(f.server.snapshot().pending, 1)
    let closeSettled = false
    const closing = f.client.close().then(() => { closeSettled = true })
    await turn(); assert.equal(closeSettled, false); assert.equal(f.client.snapshot().cleanupAcknowledged, false)
    late.resolve(original.value); await closing
    assert.equal(original.closes, 1); assert.equal(f.server.snapshot().pending, 0)
    assert.equal(f.server.snapshot().retainedSnapshots, 0); assert.equal(f.client.snapshot().cleanupAcknowledged, true)
    assert.equal(f.client.snapshot().NodeBusinessACK, false); assert.equal(f.client.snapshot().WorkerPhysicalExitConfirmed, false)
  } finally { await f.close() }
})

test('failed original snapshot close remains owned and the same handle can retry', async () => {
  const original = snapshot(), f = await fixture(async () => original.value)
  try {
    const artifact = await f.client.openArtifact(); original.failCloseOnce()
    await assert.rejects(artifact.close())
    assert.equal(f.server.snapshot().retainedSnapshots, 1); assert.equal(f.server.snapshot().retainedCleanupResponsibility, true)
    await artifact.close(); assert.equal(original.closes, 2); assert.equal(f.server.snapshot().retainedSnapshots, 0)
  } finally { await f.close() }
})

test('four original range operations bound concurrency, including a cancelled caller awaiting real settlement', async () => {
  const original = snapshot(), allStarted = deferred<void>(), release = deferred<void>()
  let reads = 0
  const f = await fixture(async () => ({ ...original.value, async readRange() {
    if (++reads === 4) allStarted.resolve()
    await release.promise
    return new Uint8Array([1])
  } }))
  try {
    const artifact = await f.client.openArtifact(), cancellation = new AbortController()
    const tasks = [artifact.readRange('sketch.hex', 0, 1, cancellation.signal),
      ...Array.from({ length: 3 }, () => artifact.readRange('sketch.hex', 0, 1))]
    const outcomes = Promise.allSettled(tasks)
    await allStarted.promise
    await assert.rejects(artifact.readRange('sketch.hex', 0, 1), { code: 'capacity-reached' })
    cancellation.abort(new DOMException('Caller cancelled.', 'AbortError'))
    assert.equal(f.client.snapshot().pending, 4)
    await assert.rejects(artifact.readRange('sketch.hex', 0, 1), { code: 'capacity-reached' })
    release.resolve(); const settled = await outcomes
    assert.equal(settled.filter(value => value.status === 'fulfilled').length, 3)
    await f.client.capture(); assert.equal(f.client.snapshot().pending, 0)
    assert.equal(reads, 4); await artifact.close()
  } finally { release.resolve(); await f.close() }
})

test('trusted navigation intent revokes the selected proxy; physical port close alone does not become a cleanup ACK', async () => {
  const f = await fixture()
  const captured = f.client.activation.captureCurrentProjectActivation(); assert(captured)
  f.childPagehide(); await f.server.closeAndWait(); await turn()
  assert.equal(f.server.snapshot().physicalPortClosed, true)
  assert.equal(f.client.snapshot().cleanupAcknowledged, false)
  const unconfirmed = f.client.close(); void unconfirmed.catch(() => undefined)
  assert.equal(captured.signal.aborted, true)
  f.parentPort.close() // Explicit physical fixture cleanup, never a business ACK.
  await f.selection.closeAndWait(); f.owner.abort()
  assert.equal(f.client.snapshot().retainedCleanupResponsibility, true)
  assert.equal(f.client.snapshot().NodeBusinessACK, false); assert.equal(f.client.snapshot().MainBusinessACK, false)
})
