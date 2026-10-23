import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import {
  createBrowserProjectPublication, type BrowserArtifactPublicationHandle, type BrowserArtifactPublicationInput,
  type BrowserArtifactPublicationTransport, type BrowserProjectPublicationOptions,
  type BrowserProjectPublicationValidators, type BrowserPublicationArtifact,
  type BrowserPublicationFiles, type BrowserPublicationSceneDescriptor,
} from './browserProjectPublication.js'
import type { BrowserCapturedWorkspaceActivation, BrowserWorkspaceActivationPort } from './browserWorkspaceActivation.js'

// Source-boundary tests use explicit schema-validator and transport doubles.
// They do not claim actual protocol validation, HTTP publication or a Browser.
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
function fixture() {
  const generation = new AbortController(), request = new AbortController()
  const counts = { reads: 0, publishes: 0, closes: 0, guards: 0, bindings: 0 }
  const graph = sha256(new Uint8Array([7])), content = new Uint8Array([1, 2, 3])
  const scene: BrowserPublicationSceneDescriptor = { projectIdentity: 'project-source-test', sceneId: 'main',
    storageRevision: 'original-storage', document: { sceneId: 'main', graphSemanticRevision: graph } }
  const artifact: BrowserPublicationArtifact = { artifactId: sha256(new Uint8Array([9])),
    files: [{ path: 'sketch.hex', role: 'hex', sizeBytes: content.byteLength, sha256: sha256(content) },
      { path: 'empty.map', role: 'map', sizeBytes: 0, sha256: sha256(new Uint8Array()) }],
    build: { graph: { graphSemanticRevision: graph } } }
  const values = new Map<string, Uint8Array>([
    ['.aily/simulator/scene-network-v2.json', encode({ schemaVersion: 1, kind: 'aily-blockly-simulator-project-scene-head', descriptor: scene })],
    ['.build/aily-artifact-manifest.json', encode(artifact)], ['.build/sketch.hex', content], ['.build/empty.map', new Uint8Array()],
  ])
  const captured: BrowserCapturedWorkspaceActivation = Object.freeze({ path: 'file:///selected/project',
    projectSessionId: 'source-test-generation', signal: generation.signal,
    requireCurrent() { assert.equal(this, captured); counts.guards++; generation.signal.throwIfAborted() } })
  let current: BrowserCapturedWorkspaceActivation | null = captured
  const activation: BrowserWorkspaceActivationPort = {
    captureCurrentProjectActivation() { assert.equal(this, activation); return current },
    projectActivation$: { subscribe: () => ({ unsubscribe() {} }) },
    currentProjectPath$: { subscribe: () => ({ unsubscribe() {} }) },
  }
  const files: BrowserPublicationFiles = { async readFile(selected, path, maximum, signal) {
    assert.equal(this, files); assert.equal(selected, captured); signal.throwIfAborted(); counts.reads++
    const bytes = values.get(path)
    if (!bytes) throw Error('Not a selected fixture member: ' + path)
    assert(bytes.byteLength <= maximum); return bytes.slice()
  } }
  const validators: BrowserProjectPublicationValidators = {
    validateSimulationArtifact(value) { assert.equal(this, validators); return value as BrowserPublicationArtifact },
    async validateProjectSceneNetworkDescriptorV2(value) { assert.equal(this, validators); return value as BrowserPublicationSceneDescriptor },
    async createProjectSceneEnvelopeV2(document, transactionId) {
      assert.equal(this, validators); return { schemaVersion: 2, kind: 'aily-project-scene', document, lastTransactionId: transactionId, extensions: {} }
    },
    validateArtifactSourceBinding() { assert.equal(this, validators); counts.bindings++ },
    sha256(bytes) { assert.equal(this, validators); return sha256(bytes) },
  }
  let input: BrowserArtifactPublicationInput | null = null
  const handle: BrowserArtifactPublicationHandle = { get binding() {
    if (!input) throw Error('Fixture publication not entered')
    return input.binding
  }, async close() { assert.equal(this, handle); counts.closes++ } }
  const transport: BrowserArtifactPublicationTransport = { async publish(snapshot, signal) {
    assert.equal(this, transport); signal.throwIfAborted(); counts.publishes++; input = snapshot; return handle
  } }
  const options: BrowserProjectPublicationOptions = { activation, files, validators, transport,
    resources: { trustedOrigin: 'https://host.example', artifactBaseURL: 'https://host.example/published/selected/artifact/' } }
  return { options, captured, request, generation, values, scene, artifact, counts, transport, handle,
    get input() { return input }, replaceCurrent() { current = null } }
}

test('absent transport is explicitly unavailable before workspace reads or publication', async () => {
  const f = fixture(), source = createBrowserProjectPublication({ ...f.options, transport: null })
  await assert.rejects(source.readPublication(f.captured, f.request.signal), { code: 'publication-unavailable' })
  assert.equal(f.counts.reads, 0); assert.equal(f.counts.publishes, 0)
  await source.close(); assert.equal(source.snapshot().retainedCleanupResponsibility, false)
})

test('one immutable snapshot preserves original receivers and supports an empty member', async () => {
  const f = fixture(), source = createBrowserProjectPublication(f.options)
  const published = await source.readPublication(f.captured, f.request.signal), input = f.input!
  assert.equal(published.activation, f.captured); assert.equal(published.scene.projectIdentity, f.scene.projectIdentity)
  assert.equal(f.counts.publishes, 1); assert.equal(f.counts.bindings, 2); assert(f.counts.guards > 0)
  assert(Object.isFrozen(input.binding)); assert(Object.isFrozen(input.binding.members)); assert(Object.isFrozen(input.scene.document))
  const copy = input.readFile('sketch.hex'); copy[0] = 99
  assert.equal(input.readFile('sketch.hex')[0], 1); assert.equal(input.readFile('empty.map').byteLength, 0)
  assert.throws(() => input.readFile('../outside'), { code: 'invalid-input' })
  await published.close(); assert.equal(f.counts.closes, 1)
  assert.throws(() => input.readFile('sketch.hex'), { code: 'closed' })
  await source.close(); assert.equal(source.snapshot().retainedCleanupResponsibility, false)
})

test('publisher scope, member and base changes are rejected after adopting its real close', async () => {
  for (const change of ['base', 'scope', 'member']) {
    const f = fixture(), originalPublish = f.transport.publish.bind(f.transport)
    f.transport.publish = async (input, signal) => {
      const handle = await originalPublish(input, signal), binding = structuredClone(input.binding)
      if (change === 'base') Object.assign(binding, { baseURL: 'https://host.example/other/' })
      if (change === 'scope') Object.assign(binding, { scope: { ...binding.scope, projectIdentity: 'foreign' } })
      if (change === 'member') Object.assign(binding, { members: [...binding.members].reverse() })
      return { binding, close: handle.close.bind(handle) }
    }
    const source = createBrowserProjectPublication(f.options)
    await assert.rejects(source.readPublication(f.captured, f.request.signal), { code: 'scope-mismatch' })
    assert.equal(f.counts.closes, 1); await source.close()
  }
})

test('bad member hashes, over-budget manifests and replaced generations cannot reach publication', async () => {
  for (const change of ['hash', 'count', 'generation']) {
    const f = fixture()
    if (change === 'hash') f.values.set('.build/sketch.hex', new Uint8Array([8, 8, 8]))
    if (change === 'count') f.values.set('.build/aily-artifact-manifest.json', encode({ ...f.artifact,
      files: Array.from({ length: 64 }, (_, index) => ({ path: `f${index}`, role: 'hex', sizeBytes: 0, sha256: sha256(new Uint8Array()) })) }))
    if (change === 'generation') f.replaceCurrent()
    const source = createBrowserProjectPublication(f.options)
    await assert.rejects(source.readPublication(f.captured, f.request.signal))
    assert.equal(f.counts.publishes, 0); await source.close()
  }
})

test('a same-generation member replacement during publication fails the final hash bookend', async () => {
  const f = fixture(), originalPublish = f.transport.publish.bind(f.transport)
  f.transport.publish = async (input, signal) => {
    const handle = await originalPublish(input, signal)
    f.values.set('.build/sketch.hex', new Uint8Array([3, 2, 1])); return handle
  }
  const source = createBrowserProjectPublication(f.options)
  await assert.rejects(source.readPublication(f.captured, f.request.signal), { code: 'integrity-failed' })
  assert.equal(f.counts.closes, 1); await source.close()
})

test('cancel joins a late real publication and closes the exact returned handle', async () => {
  const f = fixture(), originalPublish = f.transport.publish.bind(f.transport)
  const entered = deferred<void>(), late = deferred<BrowserArtifactPublicationHandle>()
  f.transport.publish = async (input, signal) => {
    await originalPublish(input, signal); entered.resolve(); return late.promise
  }
  const source = createBrowserProjectPublication(f.options), reading = source.readPublication(f.captured, f.request.signal)
  void reading.catch(() => undefined); await entered.promise
  f.request.abort(new DOMException('Original request ended', 'AbortError'))
  let closed = false; const closing = source.close().then(() => { closed = true })
  await Promise.resolve(); assert.equal(closed, false); assert.equal(f.counts.closes, 0)
  late.resolve(f.handle); await assert.rejects(reading, { name: 'AbortError' }); await closing
  assert.equal(f.counts.closes, 1); assert.equal(source.snapshot().retainedCleanupResponsibility, false)
})

test('failed original close keeps responsibility and an explicit retry calls the same handle', async () => {
  const f = fixture(), originalClose = f.handle.close.bind(f.handle)
  let attempts = 0
  f.handle.close = async () => { if (++attempts === 1) throw Error('Original close failed'); await originalClose() }
  const source = createBrowserProjectPublication(f.options), published = await source.readPublication(f.captured, f.request.signal)
  await assert.rejects(published.close(), /Original close failed/)
  assert.equal(source.snapshot().retainedPublications, 1); assert.equal(source.snapshot().retainedCleanupResponsibility, true)
  await source.close(); assert.equal(attempts, 2); assert.equal(f.counts.closes, 1)
  assert.equal(source.snapshot().retainedCleanupResponsibility, false)
})

test('a rejected transport outcome is not a cleanup ACK and blocks further publication', async () => {
  const f = fixture()
  f.transport.publish = async () => { f.counts.publishes++; throw Error('Transport outcome unknown') }
  const source = createBrowserProjectPublication(f.options)
  await assert.rejects(source.readPublication(f.captured, f.request.signal), /Transport outcome unknown/)
  const reads = f.counts.reads
  await assert.rejects(source.readPublication(f.captured, f.request.signal), { code: 'cleanup-unconfirmed' })
  assert.equal(f.counts.reads, reads); assert.equal(f.counts.publishes, 1)
  await assert.rejects(source.close(), /cleanup remains unconfirmed/)
  assert.equal(source.snapshot().publicationOutcomeUnconfirmed, true)
  assert.equal(source.snapshot().NodeBusinessACK, false)
})
