import assert from 'node:assert/strict'
import test, { afterEach } from 'node:test'
import {
  DEEPSEEK_FIM_BEGIN,
  DEEPSEEK_FIM_END,
  DEEPSEEK_FIM_HOLE,
  InlineCompletionHttpError,
  fetchLmStudioFimInlineCompletion,
  fetchZhipuChatInlineCompletion,
  normalizeLmStudioFimBaseUrl,
  parseRetryAfterMs,
  resetInlineCompletionRateLimitsForTests,
  resolveInlineCompletionProvider
} from './aiInlineCompletionTransport'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  resetInlineCompletionRateLimitsForTests()
})

const baseRequest = {
  prompt: 'complete this code',
  apiBaseUrl: 'http://127.0.0.1:1234/api/v1',
  model: 'test-model',
  maxTokens: 64,
  temperature: 0.15,
  topP: 0.9,
  stop: ['\n\n', '```'],
  timeoutMs: 1_000,
  minRequestIntervalMs: 0,
  rateLimitCooldownMs: 1_000
}

test('auto provider distinguishes BigModel from LM Studio/OpenAI-compatible FIM', () => {
  assert.equal(
    resolveInlineCompletionProvider('https://open.bigmodel.cn/api/paas/v4'),
    'zhipu-chat'
  )
  assert.equal(
    resolveInlineCompletionProvider('https://open.bigmodel.cn/api/coding/paas/v4'),
    'zhipu-chat'
  )
  assert.equal(resolveInlineCompletionProvider('http://127.0.0.1:1234/api/v1'), 'lmstudio-fim')
  assert.equal(
    resolveInlineCompletionProvider('https://open.bigmodel.cn/api/paas/v4', 'lmstudio-fim'),
    'lmstudio-fim'
  )
})

test('normalizes LM Studio native v1 URLs to the OpenAI-compatible FIM base', () => {
  assert.equal(normalizeLmStudioFimBaseUrl('http://127.0.0.1:1234'), 'http://127.0.0.1:1234/v1')
  assert.equal(
    normalizeLmStudioFimBaseUrl('http://127.0.0.1:1234/api/v1'),
    'http://127.0.0.1:1234/v1'
  )
  assert.equal(
    normalizeLmStudioFimBaseUrl('http://127.0.0.1:1234/v1/completions'),
    'http://127.0.0.1:1234/v1'
  )
})

test('LM Studio adapter posts a DeepSeek FIM completion request', async () => {
  let requestedUrl = ''
  let requestedBody: Record<string, unknown> = {}
  globalThis.fetch = async (input, init) => {
    requestedUrl = String(input)
    requestedBody = JSON.parse(String(init?.body)) as Record<string, unknown>
    return new Response(JSON.stringify({ choices: [{ text: '  a + b\n\nignored' }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    })
  }

  const completion = await fetchLmStudioFimInlineCompletion(baseRequest)

  assert.equal(requestedUrl, 'http://127.0.0.1:1234/v1/completions')
  assert.equal(requestedBody.prompt, baseRequest.prompt)
  assert.equal(requestedBody.stream, false)
  assert.deepEqual(requestedBody.stop, [
    '\n\n',
    '```',
    DEEPSEEK_FIM_BEGIN,
    DEEPSEEK_FIM_HOLE,
    DEEPSEEK_FIM_END
  ])
  assert.equal(completion, 'a + b')
})

test('Zhipu adapter uses chat completions with thinking and sampling disabled', async () => {
  let requestedUrl = ''
  let requestedBody: Record<string, unknown> = {}
  globalThis.fetch = async (input, init) => {
    requestedUrl = String(input)
    requestedBody = JSON.parse(String(init?.body)) as Record<string, unknown>
    return new Response(
      JSON.stringify({ choices: [{ message: { content: '```ts\na + b\n```' } }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )
  }

  const completion = await fetchZhipuChatInlineCompletion({
    ...baseRequest,
    apiBaseUrl: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    model: 'glm-4.7-flash'
  })

  assert.equal(requestedUrl, 'https://open.bigmodel.cn/api/paas/v4/chat/completions')
  assert.equal(requestedBody.model, 'glm-4.7-flash')
  assert.deepEqual(requestedBody.thinking, { type: 'disabled' })
  assert.equal(requestedBody.do_sample, false)
  assert.equal(requestedBody.stream, false)
  assert.deepEqual(requestedBody.messages, [{ role: 'user', content: baseRequest.prompt }])
  assert.equal(completion, 'a + b')
})

test('request timeout aborts a stalled completion', async () => {
  globalThis.fetch = async (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal
      signal?.addEventListener(
        'abort',
        () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError')),
        { once: true }
      )
    })

  await assert.rejects(
    fetchZhipuChatInlineCompletion({
      ...baseRequest,
      apiBaseUrl: 'https://timeout.example/v4',
      timeoutMs: 15
    }),
    { name: 'InlineCompletionTimeoutError' }
  )
})

test('429 blocks the same origin for the configured cooldown', async () => {
  let requestCount = 0
  globalThis.fetch = async () => {
    requestCount += 1
    if (requestCount === 1) {
      return new Response(JSON.stringify({ error: { message: 'limited' } }), { status: 429 })
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    })
  }

  const request = {
    ...baseRequest,
    apiBaseUrl: 'https://limited.example/v4',
    rateLimitCooldownMs: 25
  }
  await assert.rejects(fetchZhipuChatInlineCompletion(request), InlineCompletionHttpError)

  const startedAt = Date.now()
  assert.equal(await fetchZhipuChatInlineCompletion(request), 'ok')
  assert.ok(Date.now() - startedAt >= 15)
  assert.equal(requestCount, 2)
})

test('parses Retry-After seconds and HTTP dates', () => {
  assert.equal(parseRetryAfterMs('1.5', 0), 1_500)
  assert.equal(parseRetryAfterMs('Thu, 01 Jan 1970 00:00:02 GMT', 1_000), 1_000)
  assert.equal(parseRetryAfterMs('invalid', 0), undefined)
})
