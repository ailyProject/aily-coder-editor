import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CloudCompletionError,
  CloudInlineCompletionClient,
  type CloudCompletionFeedback,
  type CloudCompletionRequest,
  type CloudCompletionResult,
  type CloudCompletionTransport
} from './aiInlineCompletionCloudTransport'

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) {
      return
    }
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  throw new Error('Timed out waiting for condition')
}

class RecordingTransport implements CloudCompletionTransport {
  readonly startedAt: number[] = []

  async complete(
    request: CloudCompletionRequest,
    options: { signal?: AbortSignal }
  ): Promise<CloudCompletionResult> {
    if (options.signal?.aborted) {
      throw options.signal.reason ?? new DOMException('Aborted', 'AbortError')
    }
    this.startedAt.push(Date.now())
    return {
      text: `completion-${this.startedAt.length}`,
      completionId: `completion-${this.startedAt.length}`,
      opportunityId: request.opportunityId
    }
  }

  feedback(_completionId: string, _feedback: CloudCompletionFeedback): void {}
}

function input(prefix: string, suffix: string) {
  return {
    triggerKind: 'automatic' as const,
    document: { languageId: 'cpp', version: 1 },
    position: { line: 0, character: prefix.length },
    prefix,
    suffix
  }
}

test('paces cloud completion request starts', async () => {
  const transport = new RecordingTransport()
  const client = new CloudInlineCompletionClient(transport, '0.1.2', 'session-1', {
    minRequestIntervalMs: 40
  })

  await client.complete(input('first', ' suffix-1'))
  await client.complete(input('second', ' suffix-2'))

  assert.equal(transport.startedAt.length, 2)
  assert.ok(transport.startedAt[1]! - transport.startedAt[0]! >= 30)
  client.dispose()
})

test('does not send a request cancelled while waiting for the request slot', async () => {
  const transport = new RecordingTransport()
  const client = new CloudInlineCompletionClient(transport, '0.1.2', 'session-1', {
    minRequestIntervalMs: 50
  })

  await client.complete(input('first', ' suffix-1'))
  const controller = new AbortController()
  const pending = client.complete(input('second', ' suffix-2'), controller.signal)
  controller.abort()

  await assert.rejects(pending, { name: 'AbortError' })
  await new Promise(resolve => setTimeout(resolve, 60))
  assert.equal(transport.startedAt.length, 1)
  client.dispose()
})

test('keeps a dispatched request alive and serializes the next request after consumer cancellation', async () => {
  const firstResponse = deferred<CloudCompletionResult>()
  const signals: AbortSignal[] = []
  const started: string[] = []
  const transport: CloudCompletionTransport = {
    complete(request, options) {
      started.push(request.opportunityId)
      if (options.signal != null) {
        signals.push(options.signal)
      }
      if (started.length === 1) {
        return firstResponse.promise
      }
      return Promise.resolve({
        text: 'second completion',
        completionId: 'completion-2',
        opportunityId: request.opportunityId
      })
    },
    feedback() {}
  }
  const client = new CloudInlineCompletionClient(transport, '0.1.2', 'session-1', {
    minRequestIntervalMs: 0
  })
  const firstController = new AbortController()
  const first = client.complete(input('first', ' suffix-1'), firstController.signal)
  await waitFor(() => started.length === 1)

  firstController.abort()
  await assert.rejects(first, { name: 'AbortError' })
  assert.equal(signals[0]?.aborted, false)

  const second = client.complete(input('second', ' suffix-2'))
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(started.length, 1)

  firstResponse.resolve({
    text: 'first completion',
    completionId: 'completion-1',
    opportunityId: started[0]!
  })
  assert.equal((await second).text, 'second completion')
  assert.equal(started.length, 2)
  assert.equal(signals[0]?.aborted, false)
  client.dispose()
})

test('does not dispatch a queued request after the active request is rate limited', async () => {
  const firstResponse = deferred<CloudCompletionResult>()
  let requestCount = 0
  const transport: CloudCompletionTransport = {
    complete() {
      requestCount += 1
      return firstResponse.promise
    },
    feedback() {}
  }
  const client = new CloudInlineCompletionClient(transport, '0.1.2', 'session-1', {
    minRequestIntervalMs: 0
  })
  const first = client.complete(input('first', ' suffix-1'))
  await waitFor(() => requestCount === 1)
  const second = client.complete(input('second', ' suffix-2'))

  firstResponse.reject(
    new CloudCompletionError(429, 'CODE_COMPLETION_RATE_LIMITED', 'limited', 50)
  )

  await assert.rejects(first, { status: 429 })
  await assert.rejects(second, { code: 'CODE_COMPLETION_COOLDOWN' })
  assert.equal(requestCount, 1)
  client.dispose()
})

test('serves a compatible cached completion while new network requests are cooling down', async () => {
  let requestCount = 0
  const transport: CloudCompletionTransport = {
    complete(request) {
      requestCount += 1
      if (requestCount === 1) {
        return Promise.resolve({
          text: 'llo',
          completionId: 'completion-cached',
          opportunityId: request.opportunityId
        })
      }
      return Promise.reject(
        new CloudCompletionError(429, 'CODE_COMPLETION_RATE_LIMITED', 'limited', 50)
      )
    },
    feedback() {}
  }
  const client = new CloudInlineCompletionClient(transport, '0.1.2', 'session-1', {
    minRequestIntervalMs: 0
  })

  await client.complete(input('he', '!'))
  await assert.rejects(client.complete(input('unrelated', '?')), { status: 429 })
  const cached = await client.complete(input('hel', '!'))

  assert.equal(cached.text, 'lo')
  assert.equal(cached.completionId, 'completion-cached')
  assert.equal(requestCount, 2)
  client.dispose()
})

test('uses the configured fallback cooldown when 429 has no Retry-After', async () => {
  let now = 1_000
  let requestCount = 0
  const transport: CloudCompletionTransport = {
    complete(request) {
      requestCount += 1
      if (requestCount === 1) {
        return Promise.reject(
          new CloudCompletionError(429, 'CODE_COMPLETION_RATE_LIMITED', 'limited')
        )
      }
      return Promise.resolve({
        text: 'recovered',
        completionId: 'completion-recovered',
        opportunityId: request.opportunityId
      })
    },
    feedback() {}
  }
  const client = new CloudInlineCompletionClient(transport, '0.1.2', 'session-1', {
    now: () => now,
    minRequestIntervalMs: 0,
    rateLimitCooldownMs: 2_000
  })

  await assert.rejects(client.complete(input('first', '!')), { status: 429 })
  now = 2_999
  await assert.rejects(client.complete(input('second', '?')), {
    code: 'CODE_COMPLETION_COOLDOWN'
  })
  assert.equal(requestCount, 1)

  now = 3_000
  assert.equal((await client.complete(input('third', '.'))).text, 'recovered')
  assert.equal(requestCount, 2)
  client.dispose()
})
