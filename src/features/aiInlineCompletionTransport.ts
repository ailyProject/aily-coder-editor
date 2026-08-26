export const DEEPSEEK_FIM_BEGIN = '<｜fim▁begin｜>'
export const DEEPSEEK_FIM_HOLE = '<｜fim▁hole｜>'
export const DEEPSEEK_FIM_END = '<｜fim▁end｜>'

export interface InlineCompletionRequestPolicy {
  timeoutMs: number
  minRequestIntervalMs: number
  rateLimitCooldownMs: number
}

interface InlineCompletionRequestBase extends InlineCompletionRequestPolicy {
  prompt: string
  apiBaseUrl: string
  apiKey?: string
  model?: string
  signal?: AbortSignal
  maxTokens: number
  temperature: number
  topP: number
  stop: string[]
}

export interface FimInlineCompletionRequest extends InlineCompletionRequestBase {
  fimMarkers?: {
    begin: string
    hole: string
    end: string
  }
}

interface RateLimitState {
  nextRequestAt: number
  blockedUntil: number
}

const rateLimitsByOrigin = new Map<string, RateLimitState>()

export class InlineCompletionHttpError extends Error {
  readonly status: number
  readonly retryAfterMs?: number

  constructor(status: number, retryAfterMs?: number) {
    super(`local inline completion: HTTP ${status}`)
    this.name = 'InlineCompletionHttpError'
    this.status = status
    this.retryAfterMs = retryAfterMs
  }
}

export class InlineCompletionTimeoutError extends Error {
  readonly timeoutMs: number

  constructor(timeoutMs: number) {
    super(`inline completion request timed out after ${timeoutMs}ms`)
    this.name = 'InlineCompletionTimeoutError'
    this.timeoutMs = timeoutMs
  }
}

function stripEndpointSuffix(apiBaseUrl: string): string {
  return apiBaseUrl
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/(?:chat\/completions|completions|chat)$/i, '')
}

/** LM Studio `/api/v1` 原生 URL 归一化为支持 FIM 的 OpenAI 兼容 `/v1`。 */
export function normalizeLmStudioFimBaseUrl(apiBaseUrl: string): string {
  const trimmed = stripEndpointSuffix(apiBaseUrl)
  if (/^https?:\/\/[^/]+$/i.test(trimmed)) {
    return `${trimmed}/v1`
  }
  if (/\/api\/v\d+$/i.test(trimmed)) {
    return trimmed.replace(/\/api\/v\d+$/i, '/v1')
  }
  if (/\/api\/v\d+\//i.test(trimmed)) {
    return trimmed.replace(/\/api\/v\d+/i, '/v1')
  }
  return trimmed
}

export function parseRetryAfterMs(value: string | null, now = Date.now()): number | undefined {
  if (value == null || value.trim() === '') {
    return undefined
  }

  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds * 1000)
  }

  const retryAt = Date.parse(value)
  if (!Number.isFinite(retryAt)) {
    return undefined
  }
  return Math.max(0, retryAt - now)
}

function requestOrigin(apiBaseUrl: string): string {
  try {
    return new URL(apiBaseUrl).origin
  } catch {
    return apiBaseUrl
  }
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('Aborted', 'AbortError')
}

function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(abortError(signal))
  }
  if (ms <= 0) {
    return Promise.resolve()
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal == null ? new DOMException('Aborted', 'AbortError') : abortError(signal))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

async function acquireRequestSlot(
  apiBaseUrl: string,
  minRequestIntervalMs: number,
  signal?: AbortSignal
): Promise<void> {
  const key = requestOrigin(apiBaseUrl)
  while (true) {
    const state = rateLimitsByOrigin.get(key) ?? { nextRequestAt: 0, blockedUntil: 0 }
    const now = Date.now()
    const waitMs = Math.max(state.nextRequestAt, state.blockedUntil) - now
    if (waitMs <= 0) {
      state.nextRequestAt = now + minRequestIntervalMs
      rateLimitsByOrigin.set(key, state)
      return
    }
    await sleepWithAbort(waitMs, signal)
  }
}

function blockRateLimitedOrigin(apiBaseUrl: string, cooldownMs: number): void {
  const key = requestOrigin(apiBaseUrl)
  const state = rateLimitsByOrigin.get(key) ?? { nextRequestAt: 0, blockedUntil: 0 }
  state.blockedUntil = Math.max(state.blockedUntil, Date.now() + cooldownMs)
  rateLimitsByOrigin.set(key, state)
}

async function runWithTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  externalSignal?: AbortSignal
): Promise<T> {
  if (externalSignal?.aborted) {
    throw abortError(externalSignal)
  }

  const controller = new AbortController()
  let timedOut = false
  const onExternalAbort = () => controller.abort(externalSignal?.reason)
  externalSignal?.addEventListener('abort', onExternalAbort, { once: true })
  const timeout = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)

  try {
    return await operation(controller.signal)
  } catch (error) {
    if (timedOut) {
      throw new InlineCompletionTimeoutError(timeoutMs)
    }
    throw error
  } finally {
    clearTimeout(timeout)
    externalSignal?.removeEventListener('abort', onExternalAbort)
  }
}

async function postJson(
  apiBaseUrl: string,
  url: string,
  apiKey: string | undefined,
  body: unknown,
  policy: InlineCompletionRequestPolicy,
  signal?: AbortSignal
): Promise<unknown> {
  await acquireRequestSlot(apiBaseUrl, policy.minRequestIntervalMs, signal)
  return runWithTimeout(
    async (requestSignal) => {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey != null && apiKey.length > 0 ? { Authorization: `Bearer ${apiKey}` } : {})
        },
        body: JSON.stringify(body),
        signal: requestSignal
      })

      if (!response.ok) {
        const retryAfterMs = parseRetryAfterMs(response.headers.get('Retry-After'))
        if (response.status === 429) {
          blockRateLimitedOrigin(apiBaseUrl, retryAfterMs ?? policy.rateLimitCooldownMs)
        }
        throw new InlineCompletionHttpError(response.status, retryAfterMs)
      }

      return response.json() as Promise<unknown>
    },
    policy.timeoutMs,
    signal
  )
}

function parseCompletionText(json: unknown): string {
  if (typeof json !== 'object' || json === null) {
    return ''
  }
  const raw = (json as { choices?: Array<{ text?: unknown }> }).choices?.[0]?.text
  return typeof raw === 'string' ? raw : ''
}

/** 仅剥离模型偶发的 markdown fence；代码缩进、换行和尾随空白均属于补全内容。 */
export function sanitizeInlineCompletionOutput(raw: string): string {
  const openingFence = /^[ \t]*```[\w-]*\r?\n/.exec(raw)
  if (openingFence == null) {
    return raw
  }
  const text = raw.slice(openingFence[0].length)
  const closingFence = /\r?\n```[ \t]*(?:\r?\n)?$/.exec(text)
  if (closingFence?.index != null) {
    return text.slice(0, closingFence.index)
  }
  return text
}

export async function fetchLmStudioFimInlineCompletion(
  request: FimInlineCompletionRequest
): Promise<string> {
  const base = normalizeLmStudioFimBaseUrl(request.apiBaseUrl)
  const markers = request.fimMarkers ?? {
    begin: DEEPSEEK_FIM_BEGIN,
    hole: DEEPSEEK_FIM_HOLE,
    end: DEEPSEEK_FIM_END
  }
  const stop = [...new Set([...request.stop, markers.begin, markers.hole, markers.end])]
  const json = await postJson(
    request.apiBaseUrl,
    `${base}/completions`,
    request.apiKey,
    {
      model: request.model ?? 'deepseek-coder-1.3b-base',
      prompt: request.prompt,
      max_tokens: request.maxTokens,
      temperature: request.temperature,
      top_p: request.topP,
      stop,
      stream: false
    },
    request,
    request.signal
  )
  return sanitizeInlineCompletionOutput(parseCompletionText(json))
}

/** 仅用于单元测试，避免前一用例的 origin 冷却污染后续用例。 */
export function resetInlineCompletionRateLimitsForTests(): void {
  rateLimitsByOrigin.clear()
}
