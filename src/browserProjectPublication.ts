import type { BrowserCapturedWorkspaceActivation, BrowserWorkspaceActivationPort } from './browserWorkspaceActivation.js'

export const BROWSER_PROJECT_PUBLICATION_LIMITS = Object.freeze({
  members: 63, artifactBytes: 1024 * 1024, totalArtifactBytes: 64 * 1024 * 1024, sceneBytes: 4 * 1024 * 1024,
})
const HEAD = '.aily/simulator/scene-network-v2.json'
const MANIFEST = 'aily-artifact-manifest.json'
const SHA256 = /^[a-f0-9]{64}$/

export interface BrowserPublicationMember {
  readonly path: string
  readonly role: string
  readonly sizeBytes: number
  readonly sha256: string
}
export interface BrowserPublicationArtifact {
  readonly artifactId: string
  readonly files: readonly BrowserPublicationMember[]
  readonly build: { readonly graph?: { readonly graphSemanticRevision: string } }
}
export interface BrowserPublicationSceneDescriptor {
  readonly projectIdentity: string
  readonly sceneId: string
  readonly storageRevision: string
  readonly document: { readonly sceneId: string, readonly graphSemanticRevision: string }
}
export interface BrowserArtifactPublicationBinding {
  readonly scope: { readonly projectIdentity: string, readonly artifactRevision: string }
  readonly artifactId: string
  readonly trustedOrigin: string
  readonly baseURL: string
  readonly manifest: { readonly sizeBytes: number, readonly sha256: string }
  readonly members: readonly BrowserPublicationMember[]
  readonly requestTimeoutMs?: number
}
export interface BrowserProjectPublicationValidators {
  /** Compose these with the existing Simulator protocol/Scene implementations;
   * no package installation or alternate schema policy belongs in this module. */
  validateSimulationArtifact(value: unknown): BrowserPublicationArtifact
  validateProjectSceneNetworkDescriptorV2(value: unknown): Promise<BrowserPublicationSceneDescriptor>
  createProjectSceneEnvelopeV2(document: BrowserPublicationSceneDescriptor['document'], transactionId: string): Promise<unknown>
  validateArtifactSourceBinding(value: BrowserArtifactPublicationBinding): void
  sha256(bytes: Uint8Array): string | Promise<string>
}
export interface BrowserPublicationFiles {
  readFile(captured: BrowserCapturedWorkspaceActivation, relativePath: string, maximumBytes: number, signal: AbortSignal): Promise<Uint8Array>
}
export interface BrowserArtifactPublicationInput {
  readonly activation: { readonly path: string, readonly projectSessionId: string }
  readonly scene: BrowserPublicationSceneDescriptor
  readonly sceneEnvelope: unknown
  readonly binding: BrowserArtifactPublicationBinding
  /** Returns copies of this snapshot's bounded immutable input, never a root,
   * OS path, future file version or authority to enumerate arbitrary files. */
  readFile(relativePath: string): Uint8Array
}
export interface BrowserArtifactPublicationHandle {
  readonly binding: BrowserArtifactPublicationBinding
  close(): Promise<void>
}
export interface BrowserArtifactPublicationTransport {
  /** The owning application supplies a real same-origin HTTP publication.
   * A rejected publication must retain its own unconfirmed cleanup; it is not
   * evidence that no public resource or remote operation was created. */
  publish(input: BrowserArtifactPublicationInput, signal: AbortSignal): Promise<BrowserArtifactPublicationHandle>
}
export interface BrowserProjectPublicationOptions {
  readonly activation: BrowserWorkspaceActivationPort
  readonly files: BrowserPublicationFiles
  readonly validators: BrowserProjectPublicationValidators
  readonly resources: { readonly trustedOrigin: string, readonly artifactBaseURL: string }
  readonly transport: BrowserArtifactPublicationTransport | null
}

export class BrowserProjectPublicationError extends Error {
  constructor(readonly code: 'publication-unavailable' | 'closed' | 'busy' | 'invalid-input'
    | 'integrity-failed' | 'scope-mismatch' | 'cleanup-unconfirmed') {
    super(code)
    this.name = 'BrowserProjectPublicationError'
  }
}
const fail = (code: BrowserProjectPublicationError['code']): never => { throw new BrowserProjectPublicationError(code) }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid-input')
  return value as Record<string, unknown>
}
function immutable<T>(value: T): T {
  const copy = structuredClone(value)
  const freeze = (item: unknown): void => {
    if (item && typeof item === 'object') { Object.values(item).forEach(freeze); Object.freeze(item) }
  }
  freeze(copy)
  return copy
}
function json(bytes: Uint8Array): unknown { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }
function sameMembers(left: readonly BrowserPublicationMember[], right: readonly BrowserPublicationMember[]): boolean {
  return left.length === right.length && left.every((item, index) => {
    const other = right[index]
    return other && item.path === other.path && item.role === other.role
      && item.sizeBytes === other.sizeBytes && item.sha256 === other.sha256
  })
}

/** Captures input and owns only its real publication handles. The original
 * Workbench owns folders, original validators own schemas, and the original
 * Simulator owns Artifact admission, Scene persistence, Sessions and leases. */
export function createBrowserProjectPublication(options: BrowserProjectPublicationOptions) {
  const capture = options.activation.captureCurrentProjectActivation.bind(options.activation)
  const read = options.files.readFile.bind(options.files)
  const validateArtifact = options.validators.validateSimulationArtifact.bind(options.validators)
  const validateScene = options.validators.validateProjectSceneNetworkDescriptorV2.bind(options.validators)
  const envelope = options.validators.createProjectSceneEnvelopeV2.bind(options.validators)
  const validateBinding = options.validators.validateArtifactSourceBinding.bind(options.validators)
  const hash = options.validators.sha256.bind(options.validators)
  const resources = immutable(options.resources)
  const publish = options.transport?.publish.bind(options.transport)
  const lifetime = new AbortController()
  const retained = new Set<{ close(): Promise<void> }>()
  let pending: Promise<unknown> | null = null
  let closed = false, closing: Promise<void> | null = null
  let publicationOutcomeUnconfirmed = false

  function readPublication(captured: BrowserCapturedWorkspaceActivation, signal: AbortSignal) {
    if (closed) return Promise.reject(new BrowserProjectPublicationError('closed'))
    if (!publish) return Promise.reject(new BrowserProjectPublicationError('publication-unavailable'))
    if (publicationOutcomeUnconfirmed) return Promise.reject(new BrowserProjectPublicationError('cleanup-unconfirmed'))
    if (pending || retained.size) return Promise.reject(new BrowserProjectPublicationError('busy'))
    const requireCaptured = captured.requireCurrent.bind(captured)
    const current = AbortSignal.any([signal, captured.signal, lifetime.signal])
    const requireCurrent = () => {
      current.throwIfAborted(); requireCaptured()
      if (capture() !== captured) throw new DOMException('The Browser workspace activation changed.', 'AbortError')
    }
    const digest = async (bytes: Uint8Array): Promise<string> => {
      requireCurrent(); const result = await hash(bytes); requireCurrent()
      if (!SHA256.test(result)) fail('integrity-failed')
      return result
    }
    const bytesAt = async (path: string, maximumBytes: number): Promise<Uint8Array> => {
      requireCurrent(); const bytes = await read(captured, path, maximumBytes, current); requireCurrent()
      if (!(bytes instanceof Uint8Array) || bytes.byteLength > maximumBytes) fail('integrity-failed')
      return bytes.slice()
    }
    let adopted: { close(): Promise<void> } | null = null
    const task = Promise.resolve().then(async () => {
      requireCurrent()
      const headBytes = await bytesAt(HEAD, BROWSER_PROJECT_PUBLICATION_LIMITS.sceneBytes)
      const head = record(json(headBytes))
      if (head.schemaVersion !== 1 || head.kind !== 'aily-blockly-simulator-project-scene-head') fail('invalid-input')
      const scene = immutable(await validateScene(head.descriptor)); requireCurrent()
      const manifestBytes = await bytesAt('.build/' + MANIFEST, BROWSER_PROJECT_PUBLICATION_LIMITS.artifactBytes)
      const artifact = immutable(validateArtifact(json(manifestBytes)))
      if (artifact.files.length < 1 || artifact.files.length > BROWSER_PROJECT_PUBLICATION_LIMITS.members) fail('invalid-input')
      if (scene.sceneId !== scene.document.sceneId || artifact.build.graph?.graphSemanticRevision !== scene.document.graphSemanticRevision) fail('scope-mismatch')
      let total = manifestBytes.byteLength
      for (const file of artifact.files) {
        if (!Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 0) fail('invalid-input')
        total += file.sizeBytes
        if (!Number.isSafeInteger(total) || total > BROWSER_PROJECT_PUBLICATION_LIMITS.totalArtifactBytes) fail('invalid-input')
      }
      const expected = immutable<BrowserArtifactPublicationBinding>({
        scope: { projectIdentity: scene.projectIdentity, artifactRevision: artifact.artifactId },
        artifactId: artifact.artifactId, trustedOrigin: resources.trustedOrigin, baseURL: resources.artifactBaseURL,
        manifest: { sizeBytes: manifestBytes.byteLength, sha256: await digest(manifestBytes) }, members: artifact.files,
      })
      // This is the existing WebArtifactSource constructor validation, supplied
      // by the actual application. It must run before any member path is used.
      validateBinding(expected); requireCurrent()
      const headHash = await digest(headBytes)
      const content = new Map<string, Uint8Array>([[MANIFEST, manifestBytes]])
      for (const file of expected.members) {
        const bytes = await bytesAt('.build/' + file.path, file.sizeBytes)
        if (bytes.byteLength !== file.sizeBytes || await digest(bytes) !== file.sha256) fail('integrity-failed')
        content.set(file.path, bytes)
      }
      const sceneEnvelope = immutable(await envelope(scene.document, 'browser-publication:' + crypto.randomUUID()))
      requireCurrent()
      async function recheck(): Promise<void> {
        if (await digest(await bytesAt(HEAD, headBytes.byteLength)) !== headHash
          || await digest(await bytesAt('.build/' + MANIFEST, manifestBytes.byteLength)) !== expected.manifest.sha256) fail('integrity-failed')
        for (const file of expected.members) {
          const bytes = await bytesAt('.build/' + file.path, file.sizeBytes)
          if (bytes.byteLength !== file.sizeBytes || await digest(bytes) !== file.sha256) fail('integrity-failed')
        }
      }
      await recheck()
      let retired = false
      const input: BrowserArtifactPublicationInput = Object.freeze({
        activation: immutable({ path: captured.path, projectSessionId: captured.projectSessionId }),
        scene, sceneEnvelope, binding: expected,
        readFile(path: string) {
          requireCurrent()
          if (retired) fail('closed')
          const bytes = content.get(path)
          if (!bytes) return fail('invalid-input')
          return bytes.slice()
        },
      })
      let handle: BrowserArtifactPublicationHandle
      // The final bookend awaited file/digest work. Recheck before invoking an
      // external publisher, outside its unknown-outcome responsibility scope.
      requireCurrent()
      try { handle = await publish(input, current) }
      catch (error) { publicationOutcomeUnconfirmed = true; throw error }
      // Adopt the exact late result before checking cancellation or its DTO.
      // A timeout/abort never turns a still-owned publication into a close ACK.
      if (!handle || typeof handle.close !== 'function') {
        publicationOutcomeUnconfirmed = true; fail('cleanup-unconfirmed')
      }
      const originalClose = handle.close.bind(handle)
      let originalTask: Promise<void> | null = null
      const revoke = () => { void owned.close().catch(() => { /* Retain the original failed close. */ }) }
      const owned = Object.freeze({ close(): Promise<void> {
        retired = true
        if (!originalTask) {
          const task = Promise.resolve().then(originalClose).then(() => { retained.delete(owned); content.clear() }, error => {
            if (originalTask === task) originalTask = null
            throw error
          })
          originalTask = task
          void task.catch(() => { /* A rejected original close retains this exact publication for retry. */ })
          current.removeEventListener('abort', revoke)
        }
        return originalTask
      } })
      adopted = owned; retained.add(owned)
      current.addEventListener('abort', revoke, { once: true })
      requireCurrent()
      const binding = immutable(handle.binding)
      validateBinding(binding)
      if (Object.keys(binding).sort().join(',') !== Object.keys(expected).sort().join(',')
        || binding.trustedOrigin !== expected.trustedOrigin || binding.baseURL !== expected.baseURL
        || binding.scope.projectIdentity !== expected.scope.projectIdentity || binding.scope.artifactRevision !== expected.scope.artifactRevision
        || binding.artifactId !== expected.artifactId || binding.manifest.sizeBytes !== expected.manifest.sizeBytes
        || binding.manifest.sha256 !== expected.manifest.sha256 || !sameMembers(binding.members, expected.members)) fail('scope-mismatch')
      await recheck(); requireCurrent()
      return Object.freeze({ activation: captured, scene, sceneEnvelope, artifact: binding, close: owned.close })
    }).catch(async error => {
      if (adopted) try { await adopted.close() }
      catch (cleanup) { throw new AggregateError([error, cleanup], 'Publication and original cleanup remain unconfirmed.') }
      throw error
    }).finally(() => { if (pending === task) pending = null })
    pending = task
    void task.catch(() => { /* The owning caller retains the original outcome. */ })
    return task
  }

  function close(): Promise<void> {
    if (closing) return closing
    closed = true; lifetime.abort(new DOMException('The Browser publication owner closed.', 'AbortError'))
    const task = Promise.resolve().then(async () => {
      await pending?.catch(() => undefined)
      const results = await Promise.allSettled([...retained].map(handle => handle.close()))
      const errors = results.filter((value): value is PromiseRejectedResult => value.status === 'rejected').map(value => value.reason)
      if (publicationOutcomeUnconfirmed) errors.push(new BrowserProjectPublicationError('cleanup-unconfirmed'))
      if (errors.length) throw new AggregateError(errors, 'Original publication cleanup remains unconfirmed.')
    }).finally(() => { if (closing === task) closing = null })
    closing = task; void task.catch(() => { /* Retain handles and unconfirmed transport outcome. */ })
    return task
  }
  return Object.freeze({ readPublication, close, snapshot() {
    return { closed, pendingPublication: pending !== null, retainedPublications: retained.size, publicationOutcomeUnconfirmed,
      retainedCleanupResponsibility: pending !== null || retained.size !== 0 || publicationOutcomeUnconfirmed,
      productionAuthorizationAccepted: false, WorkerPhysicalExitConfirmed: false, NodeBusinessACK: false, MainBusinessACK: false }
  } })
}
