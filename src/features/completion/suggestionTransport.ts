import { completionCoordinator, abortError } from './completionState'
import {
  SUGGESTION_REQUEST_CHANNEL, SUGGESTION_EVENT_CHANNEL, SuggestionError,
  parseSuggestionRequest, validateSuggestionResult,
  type SuggestionCapabilities, type SuggestionRequest, type SuggestionResult, type SuggestionFeedback,
} from './suggestionProtocol'

type Host = Pick<Window, 'addEventListener' | 'removeEventListener' | 'parent'>
type Pending = { resolve: (value: unknown) => void; reject: (error: unknown) => void; timer: ReturnType<typeof setTimeout>; cleanup: () => void; acknowledged: boolean }
export class ParentSuggestionTransport {
  onSessionChanged?: () => void
  private pending = new Map<string, Pending>()
  private cooldownUntil = 0
  private onMessage = (event: MessageEvent) => {
    if (event.source !== this.host.parent || event.data?.channel !== SUGGESTION_EVENT_CHANNEL) return
    if (event.data.type === 'session-changed') {
      for (const id of [...this.pending.keys()]) { this.cancelHost(id); this.finish(id, undefined, abortError()) }
      this.cooldownUntil = 0; this.onSessionChanged?.(); return
    }
    const message = event.data; const pending = this.pending.get(message.requestId)
    if (!pending) return
    if (message.type === 'ack') { pending.acknowledged = true; return }
    if (message.type === 'error') {
      const status = Number(message.status) || 502
      const retry = message.headers?.['retry-after']
      const retryMs = /^\d+$/.test(retry ?? '') ? Number(retry) * 1000 : Math.max(0, Date.parse(retry ?? '') - Date.now())
      if ([401, 402, 403, 429, 503].includes(status)) this.cooldownUntil = Date.now() + Math.max(30_000, retryMs || 0)
      this.finish(message.requestId, undefined, new SuggestionError(String(message.code), this.errorMessage(status), status, retryMs || 0))
    } else if (message.type === 'capabilities') this.finish(message.requestId, message.capabilities)
    else if (message.type === 'result') this.finish(message.requestId, message.result)
  }
  constructor(private readonly host: Host = window) { host.addEventListener('message', this.onMessage) }
  async capabilities(): Promise<SuggestionCapabilities | null> {
    const id = crypto.randomUUID()
    try { return await this.send(id, 'capabilities', undefined, undefined, 8000) as SuggestionCapabilities }
    catch (error) {
      if (error instanceof SuggestionError && [404, 405].includes(error.status)) return null
      throw error
    }
  }
  async suggest(request: SuggestionRequest, signal?: AbortSignal): Promise<SuggestionResult> {
    parseSuggestionRequest(request)
    if (Date.now() < this.cooldownUntil) throw new SuggestionError('SUGGESTION_COOLDOWN', '编辑建议处于服务冷却期。', 429)
    return completionCoordinator.run(request.trigger === 'manual' ? 3 : request.mode === 'completion' ? 2 : 1, async inner => {
      const result = await this.send(request.requestId, 'suggest', request, inner, 14_000)
      return validateSuggestionResult(result, request)
    }, signal)
  }
  feedback(completionId: string, payload: SuggestionFeedback): void {
    this.host.parent.postMessage({ channel: SUGGESTION_REQUEST_CHANNEL, operation: 'feedback', requestId: crypto.randomUUID(), completionId, payload }, '*')
  }
  dispose(): void {
    this.host.removeEventListener('message', this.onMessage)
    for (const id of [...this.pending.keys()]) { this.cancelHost(id); this.finish(id, undefined, abortError()) }
  }
  private send(id: string, operation: string, payload?: unknown, signal?: AbortSignal, timeout = 14_000): Promise<unknown> {
    if (signal?.aborted) return Promise.reject(abortError())
    return new Promise((resolve, reject) => {
      const onAbort = () => { this.cancelHost(id); this.finish(id, undefined, abortError()) }
      const legacyTimer = operation === 'capabilities' ? setTimeout(() => {
        if (!this.pending.get(id)?.acknowledged) { this.cancelHost(id); this.finish(id, undefined, new SuggestionError('SUGGESTION_OLD_HOST', undefined, 404)) }
      }, 800) : undefined
      const timer = setTimeout(() => { this.cancelHost(id); this.finish(id, undefined, new SuggestionError('SUGGESTION_TIMEOUT', '编辑建议响应超时。', 504)) }, timeout)
      this.pending.set(id, { resolve, reject, timer, acknowledged: false, cleanup: () => { clearTimeout(legacyTimer); signal?.removeEventListener('abort', onAbort) } })
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
    if (status === 401) return '请登录后使用编辑建议。'
    if (status === 402 || status === 403) return '当前账户额度或权限不足。'
    if (status === 429) return '编辑建议请求过于频繁，稍后重试。'
    return '编辑建议服务暂时不可用。'
  }
}
