import { completionCoordinator, CompletionCoordinator, abortError } from './completionState'
import {
  SUGGESTION_REQUEST_CHANNEL, SUGGESTION_EVENT_CHANNEL, SuggestionError,
  parseSuggestionRequest, validateSuggestionResult,
  type SuggestionCapabilities, type SuggestionRequest, type SuggestionResult, type SuggestionFeedback,
} from './suggestionProtocol'

type Host = Pick<Window, 'addEventListener' | 'removeEventListener' | 'parent'>
type Pending = { resolve: (value: unknown) => void; reject: (error: unknown) => void; timer: ReturnType<typeof setTimeout>; cleanup: () => void; acknowledged: boolean }
export class ParentSuggestionTransport {
  onSessionChanged?: () => void
  onAvailabilityChanged?: () => void
  private pending = new Map<string, Pending>()
  private cooldown?: { status: number; code: string; until: number }
  private cooldownTimer?: ReturnType<typeof setTimeout>
  get unavailable(): { status: number; code: string; retryAfterMs: number } | undefined {
    return this.cooldown && this.cooldown.until > Date.now()
      ? { status: this.cooldown.status, code: this.cooldown.code, retryAfterMs: this.cooldown.until - Date.now() } : undefined
  }
  private onMessage = (event: MessageEvent) => {
    if (event.source !== this.host.parent || event.data?.channel !== SUGGESTION_EVENT_CHANNEL) return
    if (event.data.type === 'session-changed') {
      for (const id of [...this.pending.keys()]) { this.cancelHost(id); this.finish(id, undefined, abortError()) }
      this.clearCooldown(); this.onSessionChanged?.(); return
    }
    const message = event.data; const pending = this.pending.get(message.requestId)
    if (!pending) return
    if (message.type === 'ack') { pending.acknowledged = true; return }
    if (message.type === 'error') {
      const status = Number(message.status) || 502
      const code = String(message.code)
      const retry = message.headers?.['retry-after']
      const retryMs = /^\d+$/.test(retry ?? '') ? Number(retry) * 1000 : Math.max(0, Date.parse(retry ?? '') - Date.now())
      const delay = Number.isFinite(retryMs) && retryMs > 0 ? retryMs : status === 429 ? 1000 : 2000
      const transient = [429, 503, 504].includes(status) ||
        ['CODE_SUGGESTION_UNAVAILABLE', 'CODE_SUGGESTION_NETWORK_ERROR', 'CODE_SUGGESTION_TIMEOUT'].includes(code)
      if ([401, 402, 403].includes(status) || transient) {
        this.clearCooldown()
        // Entitlement/auth failures need a session change or explicit reconnect;
        // throttling and explicit provider/network failures have a bounded retry
        // time and never permanently disable the latest completion opportunity.
        const reset = Date.parse(message.headers?.['x-completion-quota-reset'] ?? '')
        const until = status === 402 && reset > Date.now() ? reset : [401, 402, 403].includes(status) ? Infinity : Date.now() + delay
        this.cooldown = { status, code, until }
        if (Number.isFinite(until)) this.armCooldown()
        this.onAvailabilityChanged?.()
      }
      this.finish(message.requestId, undefined, new SuggestionError(code, this.errorMessage(status), status, this.unavailable?.retryAfterMs ?? 0))
    } else if (message.type === 'capabilities') this.finish(message.requestId, message.capabilities)
    else if (message.type === 'declaration') this.finish(message.requestId, message.declaration)
    else if (message.type === 'result') this.finish(message.requestId, message.result)
  }
  constructor(private readonly host: Host = window, private readonly coordinator: CompletionCoordinator = completionCoordinator) { host.addEventListener('message', this.onMessage) }
  async capabilities(): Promise<SuggestionCapabilities> {
    const result = await this.send(crypto.randomUUID(), 'capabilities', undefined, undefined, 8000) as SuggestionCapabilities
    if (result.quota?.allowed && this.cooldown && [401, 402, 403].includes(this.cooldown.status)) this.clearCooldown()
    return result
  }
  async suggest(request: SuggestionRequest, signal?: AbortSignal): Promise<SuggestionResult> {
    parseSuggestionRequest(request)
    this.checkAvailable()
    return this.coordinator.run(request.trigger === 'manual' ? 3 : request.mode === 'completion' ? 2 : 1, async inner => {
      this.checkAvailable()
      const result = await this.send(request.requestId, 'suggest', request, inner, 14_000)
      return validateSuggestionResult(result, request)
    }, signal)
  }
  async declaration(path: string): Promise<{ text: string; relativePath: string; snapshotId: string } | undefined> {
    try {
      const value = await this.send(crypto.randomUUID(), 'declaration', { path }, undefined, 800) as { text?: unknown; relativePath?: unknown; snapshotId?: unknown } | null
      if (!value || typeof value.text !== 'string' || value.text.length > 300_000 || typeof value.relativePath !== 'string' || !value.relativePath.startsWith('@sdk/') || typeof value.snapshotId !== 'string') return undefined
      return value as { text: string; relativePath: string; snapshotId: string }
    } catch { return undefined }
  }
  feedback(completionId: string, payload: SuggestionFeedback): void {
    this.host.parent.postMessage({ channel: SUGGESTION_REQUEST_CHANNEL, operation: 'feedback', requestId: crypto.randomUUID(), completionId, payload }, '*')
  }
  dispose(): void {
    this.clearCooldown()
    this.host.removeEventListener('message', this.onMessage)
    for (const id of [...this.pending.keys()]) { this.cancelHost(id); this.finish(id, undefined, abortError()) }
  }
  private clearCooldown(): void { clearTimeout(this.cooldownTimer); this.cooldownTimer = undefined; this.cooldown = undefined }
  private armCooldown(): void {
    if (!this.cooldown) return
    const remaining = this.cooldown.until - Date.now()
    if (remaining <= 0) { this.clearCooldown(); this.onAvailabilityChanged?.(); return }
    this.cooldownTimer = setTimeout(() => this.armCooldown(), Math.min(2_147_483_647, remaining))
  }
  private checkAvailable(): void {
    const state = this.unavailable
    if (state) throw new SuggestionError('SUGGESTION_COOLDOWN', this.errorMessage(state.status), state.status, state.retryAfterMs)
  }
  private send(id: string, operation: string, payload?: unknown, signal?: AbortSignal, timeout = 14_000): Promise<unknown> {
    if (signal?.aborted) return Promise.reject(abortError())
    return new Promise((resolve, reject) => {
      const onAbort = () => { this.cancelHost(id); this.finish(id, undefined, abortError()) }
      const ackTimer = operation === 'capabilities' ? setTimeout(() => {
        if (!this.pending.get(id)?.acknowledged) { this.cancelHost(id); this.finish(id, undefined, new SuggestionError('SUGGESTION_OLD_HOST', '当前宿主不支持 Aily Tab，请更新并重启主软件。', 426)) }
      }, 800) : undefined
      const timer = setTimeout(() => { this.cancelHost(id); this.finish(id, undefined, new SuggestionError('SUGGESTION_TIMEOUT', '编辑建议响应超时。', 504)) }, timeout)
      this.pending.set(id, { resolve, reject, timer, acknowledged: false, cleanup: () => { clearTimeout(ackTimer); signal?.removeEventListener('abort', onAbort) } })
      signal?.addEventListener('abort', onAbort, { once: true })
      this.host.parent.postMessage({ channel: SUGGESTION_REQUEST_CHANNEL, operation, requestId: id, payload }, '*')
    })
  }
  private finish(id: string, value?: unknown, error?: unknown): void {
    const pending = this.pending.get(id); if (!pending) return
    this.pending.delete(id); clearTimeout(pending.timer); pending.cleanup()
    if (error) pending.reject(error); else pending.resolve(value)
  }
  private cancelHost(id: string): void { this.host.parent.postMessage({ channel: SUGGESTION_REQUEST_CHANNEL, operation: 'cancel', requestId: id }, '*') }
  private errorMessage(status: number): string {
    if ([404, 405, 426].includes(status)) return '当前服务不支持 Aily Tab，请更新宿主和补全服务。'
    if (status === 401) return '请登录后使用编辑建议。'
    if (status === 402 || status === 403) return '当前账户额度或权限不足。'
    if (status === 429) return '编辑建议请求过于频繁，稍后重试。'
    return '编辑建议服务暂时不可用。'
  }
}
