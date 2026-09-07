export const HOST_CODE_COMPLETION_REQUEST_CHANNEL = 'aily-coder-editor-code-completion-request'
export const HOST_CODE_COMPLETION_EVENT_CHANNEL = 'aily-coder-editor-code-completion-event'

export type CloudCompletionTriggerKind = 'automatic' | 'invoke'
export type CloudCompletionFeedbackEvent =
  | 'shown'
  | 'partially_accepted'
  | 'accepted'
  | 'rejected'
  | 'ignored'
  | 'superseded'

export interface CloudCompletionRequest {
  opportunityId: string
  triggerKind: CloudCompletionTriggerKind
  document: {
    languageId: string
    relativePath?: string
    version: number
  }
  position: {
    line: number
    character: number
  }
  prefix: string
  suffix: string
  selectedCompletionInfo?: {
    text: string
  }
  context: Array<{
    kind: 'snippet'
    languageId: string
    relativePath?: string
    text: string
  }>
  capabilities: {
    stream: true
    partialAccept: boolean
  }
  client: {
    name: 'aily-coder-editor'
    version: string
    sessionId: string
  }
}

export interface CloudCompletionFeedback {
  event: CloudCompletionFeedbackEvent
  acceptedCharacters?: number
  opportunityId: string
}

export interface CloudCompletionResult {
  text: string
  completionId: string
  opportunityId: string
}

export interface CloudCompletionInput {
  /** Local document identity for reuse isolation; never forwarded to the host. */
  documentKey?: string
  /** Full local prefix for reuse/rejection anchors when the wire prefix is a sliding window. */
  documentPrefix?: string
  /** Local selected-suggestion identity, including its replacement range. */
  selectedCompletionKey?: string
  opportunityId?: string
  triggerKind: CloudCompletionTriggerKind
  document: CloudCompletionRequest['document']
  position: CloudCompletionRequest['position']
  prefix: string
  suffix: string
  selectedCompletionInfo?: CloudCompletionRequest['selectedCompletionInfo']
  context?: CloudCompletionRequest['context']
}

export interface CloudCompletionTransport {
  complete(
    request: CloudCompletionRequest,
    options: {
      signal?: AbortSignal
      onDelta?: (accumulatedText: string) => void
    }
  ): Promise<CloudCompletionResult>
  feedback(completionId: string, feedback: CloudCompletionFeedback): void
}

export class CloudCompletionError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfterMs?: number,
    readonly quotaResetAt?: number
  ) {
    super(message)
    this.name = 'CloudCompletionError'
  }
}

type CompletionRequestMessage = {
  channel: typeof HOST_CODE_COMPLETION_REQUEST_CHANNEL
  operation: 'complete'
  requestId: string
  payload: CloudCompletionRequest
}

type FeedbackRequestMessage = {
  channel: typeof HOST_CODE_COMPLETION_REQUEST_CHANNEL
  operation: 'feedback'
  requestId: string
  completionId: string
  payload: CloudCompletionFeedback
}

type CancelRequestMessage = {
  channel: typeof HOST_CODE_COMPLETION_REQUEST_CHANNEL
  operation: 'cancel'
  requestId: string
}

export type HostCodeCompletionRequestMessage =
  | CompletionRequestMessage
  | FeedbackRequestMessage
  | CancelRequestMessage

export type HostCodeCompletionEventMessage = {
  channel: typeof HOST_CODE_COMPLETION_EVENT_CHANNEL
  requestId: string
  type: 'response' | 'chunk' | 'end' | 'error'
  status?: number
  headers?: Record<string, string>
  chunk?: string
  code?: string
  message?: string
}

type MessageTarget = {
  postMessage(message: unknown, targetOrigin: string): void
}

type MessageHost = {
  parent: MessageTarget
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void
}

type PendingRequest = {
  decoder: TextCompletionSseDecoder
  headers: Record<string, string>
  timeout: ReturnType<typeof setTimeout>
  signal?: AbortSignal
  onAbort?: () => void
  onDelta?: (accumulatedText: string) => void
  resolve: (result: CloudCompletionResult) => void
  reject: (error: unknown) => void
}

function abortError(signal?: AbortSignal): unknown {
  return signal?.reason ?? new DOMException('Aborted', 'AbortError')
}

function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(abortError(signal))
  }
  if (ms <= 0) {
    return Promise.resolve()
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timeout)
      reject(abortError(signal))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function parseRetryAfterMs(value: string | undefined, now = Date.now()): number | undefined {
  if (value == null || value.trim() === '') {
    return undefined
  }
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds * 1000)
  }
  const retryAt = Date.parse(value)
  return Number.isFinite(retryAt) ? Math.max(0, retryAt - now) : undefined
}

function parseTimestamp(value: string | undefined): number | undefined {
  if (value == null || value.trim() === '') {
    return undefined
  }
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function normalizedHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers ?? {})) {
    result[key.toLowerCase()] = value
  }
  return result
}

function newId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

export class TextCompletionSseDecoder {
  private buffer = ''
  private accumulatedText = ''
  private completionId = ''
  private done = false

  push(chunk: string): string {
    this.buffer += chunk
    while (true) {
      const match = /\r?\n\r?\n/.exec(this.buffer)
      if (match?.index == null) {
        break
      }
      const frame = this.buffer.slice(0, match.index)
      this.buffer = this.buffer.slice(match.index + match[0].length)
      this.consumeFrame(frame)
    }
    return this.accumulatedText
  }

  finish(): { text: string; completionId: string; done: boolean } {
    if (this.buffer.trim()) {
      this.consumeFrame(this.buffer)
      this.buffer = ''
    }
    return {
      text: this.accumulatedText,
      completionId: this.completionId,
      done: this.done
    }
  }

  private consumeFrame(frame: string): void {
    const data = frame
      .split(/\r?\n/)
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trimStart())
      .join('\n')
    if (!data) {
      return
    }
    if (data === '[DONE]') {
      this.done = true
      return
    }

    let payload: {
      id?: unknown
      choices?: Array<{ text?: unknown }>
      error?: { code?: unknown; message?: unknown }
    }
    try {
      payload = JSON.parse(data) as typeof payload
    } catch {
      throw new CloudCompletionError(502, 'INVALID_COMPLETION_STREAM', '代码补全流格式无效。')
    }
    if (payload.error != null) {
      throw new CloudCompletionError(
        502,
        typeof payload.error.code === 'string' ? payload.error.code : 'CODE_COMPLETION_UNAVAILABLE',
        typeof payload.error.message === 'string' ? payload.error.message : '代码补全服务暂时不可用。'
      )
    }
    if (typeof payload.id === 'string') {
      this.completionId = payload.id
    }
    const text = payload.choices?.[0]?.text
    if (typeof text === 'string') {
      this.accumulatedText += text
    }
  }
}

export class ParentCodeCompletionTransport implements CloudCompletionTransport {
  private readonly pending = new Map<string, PendingRequest>()
  private readonly onMessage = (event: MessageEvent) => this.handleMessage(event)

  constructor(
    private readonly host: MessageHost = window,
    private readonly timeoutMs = 15_000
  ) {
    this.host.addEventListener('message', this.onMessage)
  }

  complete(
    request: CloudCompletionRequest,
    options: { signal?: AbortSignal; onDelta?: (accumulatedText: string) => void }
  ): Promise<CloudCompletionResult> {
    if (options.signal?.aborted) {
      return Promise.reject(abortError(options.signal))
    }

    return new Promise((resolve, reject) => {
      const requestId = request.opportunityId
      const timeout = setTimeout(() => {
        this.host.parent.postMessage(
          { channel: HOST_CODE_COMPLETION_REQUEST_CHANNEL, operation: 'cancel', requestId },
          '*'
        )
        this.finishPending(
          requestId,
          undefined,
          new CloudCompletionError(504, 'CODE_COMPLETION_TIMEOUT', '代码补全响应超时。')
        )
      }, this.timeoutMs)
      const onAbort = () => {
        this.host.parent.postMessage(
          { channel: HOST_CODE_COMPLETION_REQUEST_CHANNEL, operation: 'cancel', requestId },
          '*'
        )
        this.finishPending(requestId, undefined, abortError(options.signal))
      }
      options.signal?.addEventListener('abort', onAbort, { once: true })
      this.pending.set(requestId, {
        decoder: new TextCompletionSseDecoder(),
        headers: {},
        timeout,
        signal: options.signal,
        onAbort,
        onDelta: options.onDelta,
        resolve,
        reject
      })
      const message: CompletionRequestMessage = {
        channel: HOST_CODE_COMPLETION_REQUEST_CHANNEL,
        operation: 'complete',
        requestId,
        payload: request
      }
      this.host.parent.postMessage(message, '*')
    })
  }

  feedback(completionId: string, feedback: CloudCompletionFeedback): void {
    const message: FeedbackRequestMessage = {
      channel: HOST_CODE_COMPLETION_REQUEST_CHANNEL,
      operation: 'feedback',
      requestId: newId(),
      completionId,
      payload: feedback
    }
    this.host.parent.postMessage(message, '*')
  }

  dispose(): void {
    this.host.removeEventListener('message', this.onMessage)
    for (const requestId of [...this.pending.keys()]) {
      this.finishPending(requestId, undefined, new DOMException('Disposed', 'AbortError'))
    }
  }

  private handleMessage(event: MessageEvent): void {
    if (event.source !== this.host.parent) {
      return
    }
    const message = event.data as HostCodeCompletionEventMessage
    if (message?.channel !== HOST_CODE_COMPLETION_EVENT_CHANNEL) {
      return
    }
    const pending = this.pending.get(message.requestId)
    if (pending == null) {
      return
    }

    if (message.type === 'response') {
      pending.headers = normalizedHeaders(message.headers)
      return
    }
    if (message.type === 'chunk') {
      try {
        const text = pending.decoder.push(message.chunk ?? '')
        pending.onDelta?.(text)
      } catch (error) {
        this.finishPending(message.requestId, undefined, error)
      }
      return
    }
    if (message.type === 'error') {
      const headers = normalizedHeaders(message.headers)
      this.finishPending(
        message.requestId,
        undefined,
        new CloudCompletionError(
          message.status ?? 500,
          message.code ?? 'CODE_COMPLETION_UNAVAILABLE',
          message.message ?? '代码补全服务暂时不可用。',
          parseRetryAfterMs(headers['retry-after']),
          parseTimestamp(headers['x-completion-quota-reset'])
        )
      )
      return
    }
    if (message.type === 'end') {
      try {
        const result = pending.decoder.finish()
        const completionId =
          pending.headers['x-aily-completion-id'] ?? result.completionId
        if (!completionId) {
          throw new CloudCompletionError(502, 'INVALID_COMPLETION_STREAM', '代码补全响应缺少标识。')
        }
        this.finishPending(message.requestId, {
          text: result.text,
          completionId,
          opportunityId: message.requestId
        })
      } catch (error) {
        this.finishPending(message.requestId, undefined, error)
      }
    }
  }

  private finishPending(
    requestId: string,
    result?: CloudCompletionResult,
    error?: unknown
  ): void {
    const pending = this.pending.get(requestId)
    if (pending == null) {
      return
    }
    this.pending.delete(requestId)
    clearTimeout(pending.timeout)
    if (pending.onAbort != null) {
      pending.signal?.removeEventListener('abort', pending.onAbort)
    }
    if (error != null) {
      pending.reject(error)
    } else if (result != null) {
      pending.resolve(result)
    }
  }
}

type CacheEntry = CloudCompletionResult & {
  scope: string
  prefix: string
  suffix: string
  expiresAt: number
}

class CopilotStyleCompletionCache {
  private entries: CacheEntry[] = []

  constructor(private readonly capacity = 100) {}

  find(scope: string, prefix: string, suffix: string, now: number, allowEmpty: boolean): CloudCompletionResult | undefined {
    this.entries = this.entries.filter(entry => entry.expiresAt > now)
    const index = this.entries.findIndex(entry => {
      if (entry.scope !== scope || entry.suffix !== suffix || !prefix.startsWith(entry.prefix)) {
        return false
      }
      const remainingPrefix = prefix.slice(entry.prefix.length)
      if (entry.text === '') {
        return allowEmpty && remainingPrefix === ''
      }
      return entry.text.startsWith(remainingPrefix) && entry.text.length > remainingPrefix.length
    })
    if (index < 0) {
      return undefined
    }
    const entry = this.entries[index]
    if (entry == null) {
      return undefined
    }
    this.entries.splice(index, 1)
    this.entries.unshift(entry)
    const remainingPrefix = prefix.slice(entry.prefix.length)
    return {
      text: entry.text.slice(remainingPrefix.length),
      completionId: entry.completionId,
      opportunityId: entry.opportunityId
    }
  }

  append(entry: CacheEntry): void {
    this.entries = this.entries.filter(
      cached => !(cached.scope === entry.scope && cached.prefix === entry.prefix && cached.suffix === entry.suffix)
    )
    this.entries.unshift(entry)
    if (this.entries.length > this.capacity) {
      this.entries.length = this.capacity
    }
  }

  deleteCompletion(completionId: string): void {
    this.entries = this.entries.filter(entry => entry.completionId !== completionId)
  }
}

type InFlightCompletion = {
  scope: string
  prefix: string
  suffix: string
  partialText?: string
  activeConsumers: number
  started: boolean
  controller: AbortController
  promise: Promise<CloudCompletionResult>
}

function raceWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal == null) {
    return promise
  }
  if (signal.aborted) {
    return Promise.reject(abortError(signal))
  }
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', onAbort)
    const onAbort = () => {
      cleanup()
      reject(abortError(signal))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      value => {
        cleanup()
        resolve(value)
      },
      error => {
        cleanup()
        reject(error)
      }
    )
  })
}

function completionCandidate(
  scope: string,
  prefix: string,
  suffix: string,
  request: InFlightCompletion
): boolean {
  if (request.scope !== scope || request.suffix !== suffix || !prefix.startsWith(request.prefix)) {
    return false
  }
  const remainingPrefix = prefix.slice(request.prefix.length)
  return request.partialText == null || request.partialText.startsWith(remainingPrefix)
}

function completionScope(input: CloudCompletionInput): string {
  return JSON.stringify([
    input.documentKey ?? '',
    input.document.languageId,
    input.document.relativePath ?? '',
    input.selectedCompletionKey ?? '',
    input.selectedCompletionInfo?.text ?? '',
    (input.context ?? []).map(snippet => [
      snippet.kind,
      snippet.languageId,
      snippet.relativePath ?? '',
      snippet.text
    ])
  ])
}

export class CloudInlineCompletionClient {
  private readonly cache = new CopilotStyleCompletionCache(100)
  private readonly inFlight = new Map<string, InFlightCompletion>()
  private readonly now: () => number
  private readonly minRequestIntervalMs: number
  private readonly rateLimitCooldownMs: number
  private readonly cacheTtlMs: number
  private readonly emptyResultTtlMs: number
  private readonly rejectionTtlMs: number
  private readonly recentCompletions = new Map<string, CacheEntry>()
  private rejectedCompletions: CacheEntry[] = []
  private requestTail: Promise<void> = Promise.resolve()
  private nextRequestAt = 0
  private blockedUntil = 0

  constructor(
    private readonly transport: CloudCompletionTransport,
    private readonly clientVersion: string,
    private readonly sessionId: string,
    options: {
      now?: () => number
      minRequestIntervalMs?: number
      rateLimitCooldownMs?: number
      cacheTtlMs?: number
      emptyResultTtlMs?: number
      rejectionTtlMs?: number
    } = {}
  ) {
    this.now = options.now ?? Date.now
    this.minRequestIntervalMs = Math.max(0, options.minRequestIntervalMs ?? 500)
    this.rateLimitCooldownMs = Math.max(1_000, options.rateLimitCooldownMs ?? 30_000)
    this.cacheTtlMs = Math.max(0, options.cacheTtlMs ?? 30_000)
    this.emptyResultTtlMs = Math.max(0, options.emptyResultTtlMs ?? 1_500)
    this.rejectionTtlMs = Math.max(0, options.rejectionTtlMs ?? 30_000)
  }

  async complete(input: CloudCompletionInput, signal?: AbortSignal): Promise<CloudCompletionResult> {
    if (signal?.aborted) {
      throw abortError(signal)
    }
    const scope = completionScope(input)
    const documentPrefix = input.documentPrefix ?? input.prefix
    this.rejectedCompletions = this.rejectedCompletions.filter(entry => entry.expiresAt > this.now())
    if (input.triggerKind === 'automatic') {
      const rejected = this.rejectedCompletions.find(entry =>
        entry.scope === scope && entry.prefix === documentPrefix && entry.suffix === input.suffix
      )
      if (rejected != null) {
        return { text: '', completionId: rejected.completionId, opportunityId: rejected.opportunityId }
      }
    }
    const cached = this.cache.find(scope, documentPrefix, input.suffix, this.now(), input.triggerKind === 'automatic')
    if (cached != null) {
      return this.prepareResult(input, scope, cached)
    }

    const candidate = [...this.inFlight.values()].find(
      request =>
        !request.controller.signal.aborted &&
        completionCandidate(scope, documentPrefix, input.suffix, request)
    )
    if (candidate != null) {
      const result = await this.consume(candidate, signal)
      const remainingPrefix = documentPrefix.slice(candidate.prefix.length)
      if (result.text.startsWith(remainingPrefix) && result.text.length > remainingPrefix.length) {
        return this.prepareResult(input, scope, { ...result, text: result.text.slice(remainingPrefix.length) })
      }
      if (remainingPrefix === '' && result.text === '') {
        return this.prepareResult(input, scope, result)
      }
    }

    if (this.now() < this.blockedUntil) {
      throw new CloudCompletionError(
        429,
        'CODE_COMPLETION_COOLDOWN',
        '代码补全暂时处于冷却状态。',
        this.blockedUntil - this.now(),
        this.blockedUntil
      )
    }

    for (const request of this.inFlight.values()) {
      if (!request.started && !completionCandidate(scope, documentPrefix, input.suffix, request)) {
        request.controller.abort()
      }
    }

    const opportunityId = input.opportunityId ?? newId()
    const controller = new AbortController()
    const request: CloudCompletionRequest = {
      opportunityId,
      triggerKind: input.triggerKind,
      document: input.document,
      position: input.position,
      prefix: input.prefix,
      suffix: input.suffix,
      ...(input.selectedCompletionInfo != null
        ? { selectedCompletionInfo: input.selectedCompletionInfo }
        : {}),
      context: input.context ?? [],
      capabilities: { stream: true, partialAccept: true },
      client: {
        name: 'aily-coder-editor',
        version: this.clientVersion,
        sessionId: this.sessionId
      }
    }
    const inFlight: InFlightCompletion = {
      scope,
      prefix: documentPrefix,
      suffix: input.suffix,
      activeConsumers: 0,
      started: false,
      controller,
      promise: Promise.resolve({ text: '', completionId: '', opportunityId })
    }
    const promise = this.scheduleRequest(request, inFlight)
      .then(result => {
        this.cache.append({
          scope,
          prefix: documentPrefix,
          suffix: input.suffix,
          ...result,
          expiresAt: this.now() + (result.text === '' ? this.emptyResultTtlMs : this.cacheTtlMs)
        })
        return result
      })
      .finally(() => {
        this.inFlight.delete(opportunityId)
      })
    inFlight.promise = promise
    this.inFlight.set(opportunityId, inFlight)

    return this.prepareResult(input, scope, await this.consume(inFlight, signal))
  }

  feedback(
    completionId: string,
    opportunityId: string,
    event: CloudCompletionFeedbackEvent,
    acceptedCharacters?: number
  ): void {
    this.transport.feedback(completionId, {
      event,
      ...(acceptedCharacters != null ? { acceptedCharacters } : {}),
      opportunityId
    })
    if (event === 'accepted' || event === 'rejected' || event === 'ignored' || event === 'superseded') {
      const recent = this.recentCompletions.get(completionId)
      if ((event === 'rejected' || event === 'ignored') && recent != null && recent.text !== '') {
        this.rejectedCompletions = this.rejectedCompletions.filter(entry =>
          entry.expiresAt > this.now() && entry.completionId !== completionId
        )
        this.rejectedCompletions.unshift({ ...recent, expiresAt: this.now() + this.rejectionTtlMs })
        this.rejectedCompletions.length = Math.min(this.rejectedCompletions.length, 100)
      }
      this.cache.deleteCompletion(completionId)
      this.recentCompletions.delete(completionId)
    }
  }

  /** Drop a filtered candidate without treating it as an explicit user rejection. */
  discardCompletion(completionId: string): void {
    this.cache.deleteCompletion(completionId)
  }

  private prepareResult(input: CloudCompletionInput, scope: string, result: CloudCompletionResult): CloudCompletionResult {
    const documentPrefix = input.documentPrefix ?? input.prefix
    if (input.triggerKind === 'automatic' && this.rejectedCompletions.some(entry => {
      if (entry.expiresAt <= this.now() || entry.scope !== scope || entry.suffix !== input.suffix || !documentPrefix.startsWith(entry.prefix)) {
        return false
      }
      const typed = documentPrefix.slice(entry.prefix.length)
      return entry.text.startsWith(typed) && entry.text.slice(typed.length) === result.text
    })) {
      return { ...result, text: '' }
    }
    if (result.text !== '') {
      for (const [completionId, entry] of this.recentCompletions) {
        if (entry.expiresAt <= this.now()) {
          this.recentCompletions.delete(completionId)
        }
      }
      this.recentCompletions.delete(result.completionId)
      this.recentCompletions.set(result.completionId, {
        ...result, scope, prefix: documentPrefix, suffix: input.suffix,
        expiresAt: this.now() + Math.max(this.cacheTtlMs, this.rejectionTtlMs)
      })
      if (this.recentCompletions.size > 100) {
        const oldest = this.recentCompletions.keys().next().value
        if (oldest != null) {
          this.recentCompletions.delete(oldest)
        }
      }
    }
    return result
  }

  dispose(): void {
    for (const request of this.inFlight.values()) {
      request.controller.abort()
    }
    this.inFlight.clear()
    if (this.transport instanceof ParentCodeCompletionTransport) {
      this.transport.dispose()
    }
  }

  private scheduleRequest(
    request: CloudCompletionRequest,
    inFlight: InFlightCompletion
  ): Promise<CloudCompletionResult> {
    const scheduled = this.requestTail.then(async () => {
      await sleepWithAbort(Math.max(0, this.nextRequestAt - this.now()), inFlight.controller.signal)
      if (inFlight.controller.signal.aborted) {
        throw abortError(inFlight.controller.signal)
      }
      if (this.now() < this.blockedUntil) {
        throw new CloudCompletionError(
          429,
          'CODE_COMPLETION_COOLDOWN',
          '代码补全暂时处于冷却状态。',
          this.blockedUntil - this.now(),
          this.blockedUntil
        )
      }

      inFlight.started = true
      this.nextRequestAt = this.now() + this.minRequestIntervalMs
      try {
        return await this.transport.complete(request, {
          signal: inFlight.controller.signal,
          onDelta: text => {
            inFlight.partialText = text
          }
        })
      } finally {
        this.nextRequestAt = Math.max(
          this.nextRequestAt,
          this.now() + this.minRequestIntervalMs
        )
      }
    })
    const tracked = scheduled.catch(error => {
      this.applyBlockedUntil(error)
      throw error
    })
    this.requestTail = tracked.then(
      () => undefined,
      () => undefined
    )
    return tracked
  }

  private applyBlockedUntil(error: unknown): void {
    if (!(error instanceof CloudCompletionError)) {
      return
    }
    if (error.status === 402 && error.quotaResetAt != null) {
      this.blockedUntil = Math.max(this.blockedUntil, error.quotaResetAt)
    } else if (error.status === 429) {
      this.blockedUntil = Math.max(
        this.blockedUntil,
        this.now() + (error.retryAfterMs ?? this.rateLimitCooldownMs)
      )
    }
  }

  private async consume(
    request: InFlightCompletion,
    signal?: AbortSignal
  ): Promise<CloudCompletionResult> {
    request.activeConsumers += 1
    try {
      return await raceWithAbort(request.promise, signal)
    } finally {
      request.activeConsumers -= 1
      if (signal?.aborted && !request.started) {
        setTimeout(() => {
          if (
            !request.started &&
            request.activeConsumers === 0 &&
            !request.controller.signal.aborted
          ) {
            request.controller.abort()
          }
        }, 0)
      }
    }
  }
}

export function createInlineCompletionSessionId(): string {
  const key = 'aily-coder-editor-inline-completion-session-id'
  try {
    const existing = globalThis.localStorage?.getItem(key)
    if (existing != null && existing.length >= 8) {
      return existing
    }
    const created = newId()
    globalThis.localStorage?.setItem(key, created)
    return created
  } catch {
    return newId()
  }
}
