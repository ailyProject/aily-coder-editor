import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CloudCompletionError,
  CloudInlineCompletionClient,
  type CloudCompletionFeedback,
  type CloudCompletionInput,
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

function input(prefix: string, suffix: string): CloudCompletionInput {
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

test('isolates reuse by document, language, selected suggestion, and related context', async () => {
  const transport = new RecordingTransport()
  const client = new CloudInlineCompletionClient(transport, '0.1.5', 'session-1', {
    minRequestIntervalMs: 0
  })
  const base = { ...input('same prefix', 'same suffix'), documentKey: 'file:///one/main.cpp' }
  const initial = await client.complete(base)
  assert.equal((await client.complete({ ...base, document: { ...base.document, version: 2 } })).text, initial.text)
  const variants: CloudCompletionInput[] = [
    { ...base, documentKey: 'file:///two/main.cpp' },
    { ...base, document: { ...base.document, languageId: 'typescript' } },
    { ...base, document: { ...base.document, relativePath: 'other.cpp' } },
    { ...base, selectedCompletionInfo: { text: 'println' } },
    { ...base, selectedCompletionKey: '[[0,0,0,4],"println"]' },
    { ...base, context: [{ kind: 'snippet', languageId: 'cpp', relativePath: 'sensor.h', text: 'int readSensor();' }] }
  ]
  for (const variant of variants) {
    assert.notEqual((await client.complete(variant)).text, initial.text)
  }
  assert.equal(transport.startedAt.length, 7)
  client.dispose()
})

test('does not share an in-flight completion across documents or send local identity to the host', async () => {
  const pending = deferred<CloudCompletionResult>()
  const requests: CloudCompletionRequest[] = []
  const transport: CloudCompletionTransport = {
    complete(request) {
      requests.push(request)
      return requests.length === 1 ? pending.promise : Promise.resolve({
        text: 'second document', completionId: 'second', opportunityId: request.opportunityId
      })
    },
    feedback() {}
  }
  const client = new CloudInlineCompletionClient(transport, '0.1.5', 'session-1', { minRequestIntervalMs: 0 })
  const first = client.complete({ ...input('same', ''), documentKey: 'file:///one.cpp', selectedCompletionKey: '[[0,0,0,4],"same"]' })
  await waitFor(() => requests.length === 1)
  const second = client.complete({ ...input('same', ''), documentKey: 'file:///two.cpp' })
  pending.resolve({ text: 'first document', completionId: 'first', opportunityId: requests[0]!.opportunityId })
  assert.equal((await first).text, 'first document')
  assert.equal((await second).text, 'second document')
  assert.equal(requests.length, 2)
  assert.ok(requests.every(request => !('documentKey' in request)))
  assert.ok(requests.every(request => !('selectedCompletionKey' in request)))
  client.dispose()
})

test('expires cached suggestions while preserving reuse along matching typed text', async () => {
  let now = 1_000
  const transport = new RecordingTransport()
  const client = new CloudInlineCompletionClient(transport, '0.1.5', 'session-1', {
    now: () => now, minRequestIntervalMs: 0, cacheTtlMs: 100
  })
  await client.complete(input('prefix', 'suffix'))
  now = 1_099
  assert.equal((await client.complete(input('prefixcomp', 'suffix'))).text, 'letion-1')
  now = 1_100
  assert.equal((await client.complete(input('prefix', 'suffix'))).text, 'completion-2')
  assert.equal(transport.startedAt.length, 2)
  client.dispose()
})

test('reuses one cached completion while the 12000-character prompt window slides with matching typing', async () => {
  const requests: CloudCompletionRequest[] = []
  const transport: CloudCompletionTransport = {
    complete(request) {
      requests.push(request)
      return Promise.resolve({ text: 'println(value);', completionId: 'long-file', opportunityId: request.opportunityId })
    },
    feedback() {}
  }
  const client = new CloudInlineCompletionClient(transport, '0.1.5', 'session-1', { minRequestIntervalMs: 0 })
  const initialPrefix = `${'// preceding source\n'.repeat(800)}Serial.`
  const completionInput = (typed: string): CloudCompletionInput => {
    const documentPrefix = initialPrefix + typed
    return { ...input(documentPrefix.slice(-12_000), ''), documentPrefix }
  }
  assert.ok(initialPrefix.length > 12_000)
  const first = await client.complete(completionInput(''))
  for (const typed of ['p', 'pr', 'print']) {
    assert.equal((await client.complete(completionInput(typed))).text, first.text.slice(typed.length))
  }
  assert.equal(requests.length, 1)
  assert.equal(requests[0]?.prefix, initialPrefix.slice(-12_000))
  client.dispose()
})

test('shares an in-flight completion across a sliding prompt window using the full local prefix', async () => {
  const pending = deferred<CloudCompletionResult>()
  const requests: CloudCompletionRequest[] = []
  const transport: CloudCompletionTransport = {
    complete(request, options) {
      requests.push(request)
      options.onDelta?.('print')
      return pending.promise
    },
    feedback() {}
  }
  const client = new CloudInlineCompletionClient(transport, '0.1.5', 'session-1', { minRequestIntervalMs: 0 })
  const documentPrefix = `${'// preceding source\n'.repeat(800)}Serial.`
  const first = client.complete({ ...input(documentPrefix.slice(-12_000), ''), documentPrefix })
  await waitFor(() => requests.length === 1)
  const typedPrefix = `${documentPrefix}p`
  const second = client.complete({ ...input(typedPrefix.slice(-12_000), ''), documentPrefix: typedPrefix })
  pending.resolve({ text: 'println(value);', completionId: 'long-in-flight', opportunityId: requests[0]!.opportunityId })
  assert.equal((await first).text, 'println(value);')
  assert.equal((await second).text, 'rintln(value);')
  assert.equal(requests.length, 1)
  client.dispose()
})

test('keeps full local prefixes out of the wire request and invalidates reuse for edits before the prompt window', async () => {
  const requests: CloudCompletionRequest[] = []
  const transport: CloudCompletionTransport = {
    complete(request) {
      requests.push(request)
      return Promise.resolve({ text: 'println(value);', completionId: `wire-${requests.length}`, opportunityId: request.opportunityId })
    },
    feedback() {}
  }
  const client = new CloudInlineCompletionClient(transport, '0.1.5', 'session-1', { minRequestIntervalMs: 0 })
  const hiddenHeader = '// FULL_LOCAL_PREFIX_ANCHOR\n'
  const documentPrefix = `${hiddenHeader}${'// preceding source\n'.repeat(800)}Serial.`
  const prefix = documentPrefix.slice(-12_000)
  await client.complete({ ...input(prefix, ''), documentPrefix })
  await client.complete({ ...input(prefix, ''), documentPrefix: documentPrefix.replace(hiddenHeader, '// changed global declaration\n') })
  assert.equal(requests.length, 2)
  assert.ok(requests.every(request => request.prefix === prefix))
  assert.ok(requests.every(request => !('documentPrefix' in request)))
  assert.ok(!JSON.stringify(requests).includes('FULL_LOCAL_PREFIX_ANCHOR'))
  client.dispose()
})

test('briefly caches empty results and lets explicit invocation retry immediately', async () => {
  let now = 1_000
  let count = 0
  const transport: CloudCompletionTransport = {
    complete(request) {
      count += 1
      return Promise.resolve({ text: '', completionId: `empty-${count}`, opportunityId: request.opportunityId })
    },
    feedback() {}
  }
  const client = new CloudInlineCompletionClient(transport, '0.1.5', 'session-1', {
    now: () => now, minRequestIntervalMs: 0, emptyResultTtlMs: 100
  })
  await client.complete(input('prefix', 'suffix'))
  await client.complete(input('prefix', 'suffix'))
  assert.equal(count, 1)
  await client.complete({ ...input('prefix', 'suffix'), triggerKind: 'invoke' })
  assert.equal(count, 2)
  now = 1_100
  await client.complete(input('prefix', 'suffix'))
  assert.equal(count, 3)
  client.dispose()
})

test('suppresses rejected context until expiry and allows an explicit invocation', async () => {
  let now = 1_000
  const transport = new RecordingTransport()
  const client = new CloudInlineCompletionClient(transport, '0.1.5', 'session-1', {
    now: () => now, minRequestIntervalMs: 0, rejectionTtlMs: 100
  })
  const candidate = await client.complete(input('prefix', 'suffix'))
  client.feedback(candidate.completionId, candidate.opportunityId, 'rejected')
  assert.equal((await client.complete(input('prefix', 'suffix'))).text, '')
  assert.equal(transport.startedAt.length, 1)
  assert.equal((await client.complete({ ...input('prefix', 'suffix'), triggerKind: 'invoke' })).text, 'completion-2')
  assert.equal((await client.complete(input('prefix', 'suffix'))).text, '')
  now = 1_100
  assert.equal((await client.complete(input('prefix', 'suffix'))).text, 'completion-2')
  client.dispose()
})

test('filters regenerated rejected text after matching typing without suppressing another document', async () => {
  let count = 0
  const transport: CloudCompletionTransport = {
    complete(request) {
      count += 1
      return Promise.resolve({
        text: request.prefix === 'Serial.p' ? 'rintln(value);' : 'println(value);',
        completionId: `result-${count}`, opportunityId: request.opportunityId
      })
    },
    feedback() {}
  }
  const client = new CloudInlineCompletionClient(transport, '0.1.5', 'session-1', { minRequestIntervalMs: 0 })
  const base = { ...input('Serial.', ''), documentKey: 'file:///main.cpp' }
  const candidate = await client.complete(base)
  client.feedback(candidate.completionId, candidate.opportunityId, 'ignored')
  assert.equal((await client.complete({ ...base, prefix: 'Serial.p' })).text, '')
  assert.equal(count, 2)
  assert.equal((await client.complete({ ...base, documentKey: 'file:///other.cpp' })).text, 'println(value);')
  assert.equal(count, 3)
  client.dispose()
})

test('suppresses rejected suggestions in long files after the prompt window changes or matching text is typed', async () => {
  let count = 0
  const transport: CloudCompletionTransport = {
    complete(request) {
      count += 1
      return Promise.resolve({
        text: request.prefix.endsWith('Serial.p') ? 'rintln(value);' : 'println(value);',
        completionId: `long-rejected-${count}`, opportunityId: request.opportunityId
      })
    },
    feedback() {}
  }
  const client = new CloudInlineCompletionClient(transport, '0.1.5', 'session-1', { minRequestIntervalMs: 0 })
  const documentPrefix = `${'// preceding source\n'.repeat(800)}Serial.`
  const base = { ...input(documentPrefix.slice(-12_000), ''), documentPrefix }
  const candidate = await client.complete(base)
  client.feedback(candidate.completionId, candidate.opportunityId, 'rejected')
  assert.equal((await client.complete({ ...base, prefix: documentPrefix.slice(-6000) })).text, '')
  assert.equal(count, 1)
  const typedPrefix = `${documentPrefix}p`
  assert.equal((await client.complete({ ...base, prefix: typedPrefix.slice(-12_000), documentPrefix: typedPrefix })).text, '')
  assert.equal(count, 2)
  assert.equal((await client.complete({ ...base, prefix: typedPrefix.slice(-12_000), documentPrefix: typedPrefix, triggerKind: 'invoke' })).text, 'rintln(value);')
  client.dispose()
})

test('discarding a low-quality cached result permits a fresh request without rejection suppression', async () => {
  const transport = new RecordingTransport()
  const client = new CloudInlineCompletionClient(transport, '0.1.5', 'session-1', { minRequestIntervalMs: 0 })
  const candidate = await client.complete(input('prefix', 'suffix'))
  client.discardCompletion(candidate.completionId)
  assert.equal((await client.complete(input('prefix', 'suffix'))).text, 'completion-2')
  assert.equal(transport.startedAt.length, 2)
  client.dispose()
})
