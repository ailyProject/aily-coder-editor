import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import { build } from 'esbuild'
import type { CloudCompletionInput, CloudCompletionResult } from './aiInlineCompletionCloudTransport'

// Provider contract smoke: execute the real registration, policy, and context builder.
// Only the extension host and cloud network boundary are replaced; no browser is implied.
const bundledProvider = build({
  entryPoints: [fileURLToPath(new URL('./aiInlineCompletion.ts', import.meta.url))],
  bundle: true,
  write: false,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  define: { 'import.meta': '{"env":{"VITE_AI_INLINE_DEBOUNCE_MS":"0"}}' },
  plugins: [{
    name: 'provider-contract-boundaries',
    setup(builder) {
      builder.onResolve({ filter: /^@codingame\/monaco-vscode-api\/extensions$/ }, () => ({ path: 'extension', namespace: 'contract' }))
      builder.onResolve({ filter: /\/aiInlineCompletionCloudTransport$/ }, () => ({ path: 'cloud', namespace: 'contract' }))
      builder.onLoad({ filter: /.*/, namespace: 'contract' }, args => ({
        loader: 'js',
        contents: args.path === 'extension' ? `
          export const ExtensionHostKind = { LocalProcess: 1 };
          export function registerExtension() { return { getApi: async () => globalThis.__testApi }; }
        ` : `
          export class CloudCompletionError extends Error {}
          export class ParentCodeCompletionTransport {}
          export const createInlineCompletionSessionId = () => 'provider-contract-session';
          export class CloudInlineCompletionClient {
            complete(input, signal) { return globalThis.__cloud.complete(input, signal); }
            feedback(...args) { globalThis.__cloud.feedback(...args); }
            discardCompletion(id) { globalThis.__cloud.discardCompletion(id); }
            dispose() {}
          }
        `
      }))
    }
  }]
}).then(result => result.outputFiles[0]!.text)

class Position {
  constructor(readonly line: number, readonly character: number) {}
  isEqual(other: Position): boolean { return this.line === other.line && this.character === other.character }
}

class Range {
  constructor(readonly start: Position, readonly end: Position) {}
  get isSingleLine(): boolean { return this.start.line === this.end.line }
  contains(position: Position): boolean {
    return position.line >= this.start.line && position.line <= this.end.line &&
      (position.line !== this.start.line || position.character >= this.start.character) &&
      (position.line !== this.end.line || position.character <= this.end.character)
  }
}

class Document {
  version = 1
  readonly languageId = 'cpp'
  readonly uri: { scheme: string; toString(): string }
  constructor(readonly path: string, public text: string) {
    this.uri = { scheme: 'file', toString: () => `file:///workspace/${path}` }
  }
  getText(): string { return this.text }
  offsetAt(position: Position): number {
    const lines = this.text.split('\n')
    return lines.slice(0, position.line).reduce((total, line) => total + line.length + 1, 0) + position.character
  }
  positionAt(offset: number): Position {
    const lines = this.text.slice(0, offset).split('\n')
    return new Position(lines.length - 1, lines.at(-1)!.length)
  }
}

class Item {
  filterText?: string
  correlationId?: string
  constructor(readonly insertText: string, readonly range: Range) {}
}
class ItemList {
  enableForwardStability?: boolean
  constructor(readonly items: Item[]) {}
}
type InlineContext = { triggerKind: number; selectedCompletionInfo?: { text: string; range: Range } }
type ChangeEvent = { document: Document; reason?: number; contentChanges: Array<{ text: string; rangeLength: number }> }
type Provider = {
  provideInlineCompletionItems(document: Document, position: Position, context: InlineContext, cancellation: typeof token): Promise<ItemList | Item[]>
  handleDidShowCompletionItem(item: Item): void
  handleDidPartiallyAcceptCompletionItem(item: Item, info: { acceptedLength: number }): void
  handleEndOfLifetime(item: Item, reason: { kind: number; supersededBy?: Item }): void
}
const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) }

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  throw new Error('Provider did not reach the expected boundary')
}

async function harness(source: string, response: string | ((request: CloudCompletionInput) => Promise<CloudCompletionResult>), offset = source.length) {
  const document = new Document('src/main.cpp', source)
  const documents = [document]
  let position = document.positionAt(offset)
  const selection = { isEmpty: true, active: position }
  const editor = { document, selection, selections: [selection] }
  const requests: CloudCompletionInput[] = []
  const feedback: unknown[][] = []
  const discarded: string[] = []
  const changes: Array<(event: ChangeEvent) => void> = []
  const registered = deferred<Provider>()
  const api = {
    Range, InlineCompletionItem: Item, InlineCompletionList: ItemList,
    InlineCompletionTriggerKind: { Invoke: 0, Automatic: 1 },
    InlineCompletionEndOfLifeReasonKind: { Accepted: 0, Rejected: 1, Ignored: 2 },
    window: { activeTextEditor: editor },
    workspace: {
      textDocuments: documents,
      onDidChangeTextDocument(listener: (event: ChangeEvent) => void) { changes.push(listener) },
      onDidCloseTextDocument() {},
      asRelativePath(uri: Document['uri']) { return uri.toString().replace('file:///workspace/', '') },
      getWorkspaceFolder() { return { uri: { toString: () => 'file:///workspace' } } }
    },
    languages: {
      registerInlineCompletionItemProvider(_selector: unknown, provider: Provider) { registered.resolve(provider) }
    }
  }
  runInNewContext(await bundledProvider, {
    __testApi: api,
    __cloud: {
      complete(request: CloudCompletionInput) {
        requests.push(request)
        return typeof response === 'function' ? response(request) : Promise.resolve({
          text: response, completionId: `candidate-${requests.length}`, opportunityId: 'opportunity-1'
        })
      },
      feedback(...args: unknown[]) { feedback.push(args) },
      discardCompletion(id: string) { discarded.push(id) }
    },
    location: { search: '?aiInlineProvider=cloud' },
    window: { parent: {}, addEventListener() {} },
    URLSearchParams, AbortController, DOMException, setTimeout, clearTimeout, console
  }, { filename: 'aily-inline-provider-contract.js' })
  const provider = await registered.promise
  return {
    document, documents, editor, requests, feedback, discarded, provider,
    move(offset: number) {
      position = document.positionAt(offset)
      editor.selection.active = position
    },
    changed(text: string, rangeLength = 0, reason?: number) {
      document.version += 1
      for (const listener of changes) listener({ document, contentChanges: [{ text, rangeLength }], reason })
    },
    async complete(context: InlineContext = { triggerKind: 1 }): Promise<Item[]> {
      const result = await provider.provideInlineCompletionItems(document, position, context, token)
      return Array.isArray(result) ? result : result.items
    }
  }
}

test('provider sends the current buffer and relevant open code after an automatic edit, without forcing the selected symbol', async () => {
  const source = '#include "sensor.h"\nvoid loop() {\n  rea'
  const run = await harness(source, 'dSensor();')
  run.documents.push(new Document('include/sensor.h', 'int readSensor();'))
  run.documents.push(new Document('src/unrelated.cpp', 'void unrelatedHelper() {}'))
  run.changed('a')
  const end = run.document.positionAt(source.length)
  const range = new Range(new Position(end.line, end.character - 3), end)
  assert.equal((await run.complete({ triggerKind: 1, selectedCompletionInfo: { text: 'readAnalog', range } })).length, 0)
  assert.equal(run.requests.length, 1)
  const request = run.requests[0]!
  assert.equal(request.triggerKind, 'automatic')
  assert.equal(request.prefix, source)
  assert.equal(request.suffix, '')
  assert.equal(request.document.version, run.document.version)
  assert.equal(request.documentKey, 'file:///workspace/src/main.cpp')
  assert.equal(request.selectedCompletionInfo, undefined)
  assert.ok(request.selectedCompletionKey?.includes('readAnalog'))
  assert.equal(request.context?.length, 1)
  assert.equal(request.context?.[0]?.text, 'int readSensor();')
  assert.deepEqual(run.discarded, ['candidate-1'])
})

test('provider suppresses deletion, paste, and undo events before reaching the cloud', async t => {
  for (const [name, text, rangeLength, reason] of [
    ['deletion', '', 1, undefined],
    ['paste', 'x'.repeat(129), 0, undefined],
    ['undo', 'a', 0, 1]
  ] as const) {
    await t.test(name, async () => {
      const run = await harness('int sensor = ', 'readSensor();')
      run.changed(text, rangeLength, reason)
      assert.equal((await run.complete()).length, 0)
      assert.equal(run.requests.length, 0)
      assert.equal((await run.complete({ triggerKind: 0 })).length, 1)
      assert.equal(run.requests.length, 1)
    })
  }
})

test('provider discards a repeated previous statement and an exact suffix echo', async t => {
  await t.test('repeated previous statement', async () => {
    const run = await harness('Serial.println(value);\n  ', 'Serial.println(value);')
    assert.equal((await run.complete()).length, 0)
    assert.deepEqual(run.discarded, ['candidate-1'])
  })
  await t.test('existing suffix', async () => {
    const run = await harness('readSensor(value);', 'value);', 'readSensor('.length)
    assert.equal((await run.complete()).length, 0)
    assert.deepEqual(run.discarded, ['candidate-1'])
  })
})

test('provider drops asynchronous results after a cursor move or document change', async t => {
  for (const change of ['cursor', 'version'] as const) {
    await t.test(change, async () => {
      const response = deferred<CloudCompletionResult>()
      const run = await harness('int sensor = ', () => response.promise)
      const pending = run.complete({ triggerKind: 0 })
      await waitFor(() => run.requests.length === 1)
      if (change === 'cursor') run.move(3)
      else run.changed('a')
      response.resolve({ text: 'readSensor();', completionId: 'late', opportunityId: 'late-opportunity' })
      assert.equal((await pending).length, 0)
    })
  }
})

test('provider extends a compatible selected suggestion using its exact replacement range', async () => {
  const source = '  Serial.pri'
  const run = await harness(source, 'ntln(value);')
  const range = new Range(new Position(0, 9), new Position(0, source.length))
  const items = await run.complete({ triggerKind: 1, selectedCompletionInfo: { text: 'println', range } })
  assert.equal(items.length, 1)
  assert.equal(items[0]!.insertText, 'println(value);')
  assert.equal(items[0]!.filterText, 'println(value);')
  assert.equal(items[0]!.range, range)
  assert.equal(run.requests[0]!.prefix, source)
  assert.equal(run.requests[0]!.selectedCompletionInfo, undefined)
})

test('provider forwards shown, partial acceptance, and rejection lifecycle once', async () => {
  const run = await harness('int sensor = ', 'readSensor();')
  const item = (await run.complete())[0]!
  assert.ok(item)
  run.provider.handleDidShowCompletionItem(item)
  run.provider.handleDidShowCompletionItem(item)
  run.provider.handleDidPartiallyAcceptCompletionItem(item, { acceptedLength: 4 })
  run.provider.handleEndOfLifetime(item, { kind: 1 })
  run.provider.handleEndOfLifetime(item, { kind: 1 })
  assert.deepEqual(run.feedback, [
    ['candidate-1', 'opportunity-1', 'shown'],
    ['candidate-1', 'opportunity-1', 'partially_accepted', 4],
    ['candidate-1', 'opportunity-1', 'rejected']
  ])
})
