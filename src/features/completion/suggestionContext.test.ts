import assert from 'node:assert/strict'
import test from 'node:test'
import type * as vscode from 'vscode'
import { SuggestionContextResolver, suggestionContextBudget } from './suggestionContext'
import { RecentEditStore, contentHash } from './completionState'
import { parseSuggestionRequest } from './suggestionProtocol'
import { prepareInlineCompletion } from './ailyTabPolicy'

class Position { constructor(public line: number, public character: number) {} }
class Range {
  start: Position; end: Position
  constructor(a: number, b: number, c: number, d: number) { this.start = new Position(a, b); this.end = new Position(c, d) }
}
class Uri {
  scheme = 'file'
  constructor(public path: string) {}
  get fsPath() { return this.path }
  toString() { return `file://${this.path}` }
  with(value: { path: string }) { return new Uri(value.path) }
}
class Document {
  version = 1; uri: Uri
  constructor(public text: string, path = '/workspace/main.cpp', public languageId = 'cpp') { this.uri = new Uri(path) }
  get lineCount() { return this.text.split('\n').length }
  getText(range?: Range) { return range ? this.text.slice(this.offsetAt(range.start), this.offsetAt(range.end)) : this.text }
  offsetAt(point: Position) {
    const lines = this.text.split('\n'); const line = Math.min(point.line, lines.length - 1)
    return lines.slice(0, line).reduce((n, value) => n + value.length + 1, 0) + Math.min(point.character, lines[line]!.replace(/\r$/, '').length)
  }
  positionAt(offset: number) {
    const prefix = this.text.slice(0, offset).split('\n'); return new Position(prefix.length - 1, prefix.at(-1)!.replace(/\r$/, '').length)
  }
}
function setup(text: string, path = '/workspace/main.cpp', languageId = 'cpp') {
  const document = new Document(text, path, languageId); const opened = [document]; const files = new Map<string, string>()
  const history = new RecentEditStore()
  let definitions: unknown[] = []; let actions: unknown[] = []; let diagnostics: unknown[] = []; let completions: unknown[] = []
  const api = { Position, Range, DiagnosticSeverity: { Error: 0, Warning: 1 },
    workspace: { textDocuments: opened, getWorkspaceFolder: (uri: Uri) => uri.path.startsWith('/workspace/') ? { uri: new Uri('/workspace') } : undefined,
      asRelativePath: (uri: Uri) => uri.path.slice('/workspace/'.length), findFiles: async () => [...files.keys()].map(path => new Uri(path)),
      openTextDocument: async (uri: Uri) => { const old = opened.find(doc => doc.uri.path === uri.path); if (old) return old; const doc = new Document(files.get(uri.path) ?? '', uri.path,
        /\.tsx?$/.test(uri.path) ? 'typescript' : /\.py$/.test(uri.path) ? 'python' : 'cpp'); opened.push(doc); return doc },
      fs: { readFile: async (uri: Uri) => new TextEncoder().encode(files.get(uri.path) ?? '') } },
    commands: { executeCommand: async (command: string) => command.includes('Definition') ? definitions : command.includes('CodeAction') ? actions : command.includes('CompletionItem') ? { items: completions } : [] },
    languages: { getDiagnostics: () => diagnostics },
  } as unknown as typeof vscode
  const resolver = new SuggestionContextResolver(api, 'test-session', history, '0.1.6')
  return { api, document, opened, files, history, resolver, doc: document as unknown as vscode.TextDocument, setCompletions: (value: unknown[]) => { completions = value },
    setDefinitions: (value: unknown[]) => { definitions = value }, setActions: (value: unknown[]) => { actions = value }, setDiagnostics: (value: unknown[]) => { diagnostics = value } }
}
test('context uses global UTF-16 coordinates and reads unsaved related headers', async () => {
  const h = setup('#include "local.h"\r\n// 😀 intent\r\n  ')
  const header = new Document('int unsaved();\r\n', '/workspace/local.h'); h.opened.push(header, new Document('private unrelated', '/workspace/unrelated.cpp'))
  const snapshot = await h.resolver.collect(h.doc, new Position(2, 2) as vscode.Position, 'completion', 'typing', false)
  assert.doesNotThrow(() => parseSuggestionRequest(snapshot.request))
  assert.equal(snapshot.request.documents.length, 2); assert.equal(snapshot.request.documents[1]!.windows[0]!.text, header.text)
  assert.equal(await h.resolver.isCurrent(snapshot), true)
  header.text += 'int changed();'; header.version++
  assert.equal(await h.resolver.isCurrent(snapshot), false)
})
test('Aily Tab discovers unopened related sources, carries cross-file history, and verifies navigation against dirty buffers', async () => {
  const h = setup('#include "Sensor.h"\nint main() { return sensor.read(); }\n')
  h.files.set('/workspace/Sensor.h', 'struct Sensor { int read(int scale); };\n')
  h.files.set('/workspace/Sensor.cpp', '#include "Sensor.h"\nint Sensor::read() { return 1; }\n')
  h.files.set('/workspace/unrelated.cpp', 'int other;\n')
  h.history.add(`f-${contentHash('file:///workspace/Sensor.h')}`, 'read()', 'read(int scale)', 'typing')
  const snapshot = await h.resolver.collect(h.doc, new Position(1, 20) as vscode.Position, 'next-edit', 'manual', true, false, true)
  assert.doesNotThrow(() => parseSuggestionRequest(snapshot.request))
  const target = snapshot.request.documents.find(doc => doc.relativePath === 'Sensor.cpp')!
  assert.equal(target.permission, 'edit'); assert.equal(snapshot.request.recentEdits.length, 1)
  assert.ok(!snapshot.request.documents.some(doc => doc.relativePath === 'unrelated.cpp'))
  const window = target.windows[0]!
  const candidate = { candidateId: 'local', fileId: target.fileId, snapshotId: target.snapshotId, kind: 'edit' as const, primary: { range: window.range, expectedText: window.text, newText: window.text.replace('read()', 'read(int scale)') }, additionalEdits: [] }
  const opened = await h.resolver.openTarget(snapshot, candidate)
  assert.equal(opened?.document.uri.path, '/workspace/Sensor.cpp')
  assert.equal(opened?.request.active.fileId, snapshot.request.active.fileId)
  h.opened.find(doc => doc.uri.path === '/workspace/Sensor.cpp')!.text += '// unsaved\n'
  assert.equal(await h.resolver.isCurrent(opened!), false)
  assert.equal(await h.resolver.openTarget(snapshot, candidate), undefined)
})
test('extensionless TypeScript imports remain explicit editable cross-file relationships', async () => {
  const h = setup("import { Sensor } from './Sensor'\nconst sensor = new Sensor()\n", '/workspace/src/main.ts', 'typescript')
  h.files.set('/workspace/src/Sensor.ts', 'export class Sensor { read() { return 1 } }\n')
  const snapshot = await h.resolver.collect(h.doc, new Position(1, 20) as vscode.Position, 'next-edit', 'manual', true, false, true)
  const target = snapshot.request.documents.find(doc => doc.relativePath === 'src/Sensor.ts')
  assert.equal(target?.permission, 'edit')
  assert.equal(target?.languageId, 'typescript')
})
test('Python relative imports remain explicit editable cross-file relationships', async () => {
  const h = setup('from .helpers import parse\nvalue = parse("1")\n', '/workspace/pkg/main.py', 'python')
  h.files.set('/workspace/pkg/helpers.py', 'def parse(value: str) -> int:\n    return int(value)\n')
  const snapshot = await h.resolver.collect(h.doc, new Position(1, 10) as vscode.Position, 'next-edit', 'manual', true, false, true)
  const target = snapshot.request.documents.find(doc => doc.relativePath === 'pkg/helpers.py')
  assert.equal(target?.permission, 'edit')
  assert.equal(target?.languageId, 'python')
})
test('Aily Tab disabled keeps related files read-only and settings/index changes invalidate snapshots', async () => {
  const h = setup('#include "Sensor.h"\n')
  h.files.set('/workspace/Sensor.h', 'int read();\n')
  const snapshot = await h.resolver.collect(h.doc, new Position(0, 0) as vscode.Position, 'next-edit', 'manual', true, false, false)
  assert.equal(snapshot.request.documents[1]!.permission, 'context-only')
  h.resolver.invalidate(); assert.equal(await h.resolver.isCurrent(snapshot), false)
})
test('new symbols use only unambiguous language-service imports without modifying the buffer', async () => {
  const h = setup('// use device\n  ')
  const snapshot = await h.resolver.collect(h.doc, new Position(1, 2) as vscode.Position, 'completion', 'manual', false)
  const candidate = { candidateId: 'local', ...snapshot.request.active, kind: 'insert' as const, primary: { range: { start: { line: 1, character: 2 }, end: { line: 1, character: 2 } }, expectedText: '', newText: 'Sensor sensor;' }, additionalEdits: [] }
  const item = (header: string) => ({ label: 'Sensor', additionalTextEdits: [{ range: new Range(0, 0, 0, 0), newText: header }] })
  h.setCompletions([item('#include "Sensor.h"\n')])
  assert.equal((await h.resolver.withImports(snapshot, candidate)).additionalEdits.length, 1)
  assert.equal(h.document.text, snapshot.text)
  h.setCompletions([item('#include "Sensor.h"\n'), item('#include "Other.h"\n')])
  assert.equal((await h.resolver.withImports(snapshot, candidate)).additionalEdits.length, 0)
  h.setCompletions([{ ...item('#include "Sensor.h"\n'), command: { command: 'execute' } }])
  assert.equal((await h.resolver.withImports(snapshot, candidate)).additionalEdits.length, 0)
})

test('normalized partial symbol and its language-service import form the same candidate', async () => {
  const h = setup('    std::ve')
  const snapshot = await h.resolver.collect(h.doc, new Position(0, 11) as vscode.Position, 'completion', 'manual', false)
  h.setCompletions([{ filterText: 'vector', label: 'vector<class T>', additionalTextEdits: [{ range: new Range(0, 0, 0, 0), newText: '#include <vector>\n' }] }])
  const newText = prepareInlineCompletion({ raw: 'vector<int> distances;', prefix: snapshot.text, suffix: '', trigger: 'invoke' })
  const candidate = { candidateId: 'local', ...snapshot.request.active, kind: 'insert' as const,
    primary: { range: { start: { line: 0, character: 11 }, end: { line: 0, character: 11 } }, expectedText: '', newText }, additionalEdits: [] }
  const enriched = await h.resolver.withImports(snapshot, candidate)
  assert.equal(snapshot.text + enriched.primary.newText, '    std::vector<int> distances;')
  assert.equal(enriched.additionalEdits[0]?.newText, '#include <vector>\n')
  assert.equal(h.document.text, '    std::ve')
})
test('diagnostics are withheld after text changes until a fresh observation arrives', async () => {
  const h = setup('missing();')
  h.setDiagnostics([{ range: new Range(0, 0, 0, 7), severity: 0, message: 'unknown symbol' }])
  h.resolver.documentChanged(h.doc.uri)
  const collect = () => h.resolver.collect(h.doc, new Position(0, 0) as vscode.Position, 'next-edit', 'diagnostic', false)
  assert.equal((await collect()).request.diagnostics.length, 0)
  h.resolver.diagnosticsObserved(h.doc.uri)
  assert.equal((await collect()).request.diagnostics.length, 1)
})
test('clangd template labels resolve missing headers through completion filterText', async () => {
  const h = setup('#include <string>\nstd::vector<int> values;\n')
  h.setDiagnostics([{ range: new Range(1, 5, 1, 11), severity: 0, message: 'No member named vector' }])
  h.setCompletions([{ label: '•vector<class Tp, class Alloc>', filterText: 'vector', additionalTextEdits: [{ range: new Range(1, 0, 1, 0), newText: '#include <vector>\n' }] }])
  const snapshot = await h.resolver.collect(h.doc, new Position(1, 11) as vscode.Position, 'next-edit', 'manual', false, true)
  assert.equal(snapshot.request.options.autoImports, true)
  assert.deepEqual(snapshot.request.documents[0]!.windows.find(window => window.purpose === 'import')!.allowedNewText, ['#include <vector>\n'])
})
test('SDK declarations use only the host reader, stay read-only, and expire on SDK revision changes', async () => {
  const h = setup('device.read();\n'); const sdk = new Uri('/installed/sdk/Device.h')
  h.setDefinitions([{ uri: sdk, range: new Range(1, 0, 1, 4) }])
  let revision = 'one'
  const resolver = new SuggestionContextResolver(h.api, 'test-session', h.history, '0.1.7', async path => path === sdk.path ? { text: '// library\nint read();\n', relativePath: '@sdk/device/Device.h', snapshotId: revision } : undefined)
  const snapshot = await resolver.collect(h.doc, new Position(0, 7) as vscode.Position, 'next-edit', 'manual', true, false, true)
  assert.equal(snapshot.request.documents[1]!.permission, 'context-only')
  assert.ok(!JSON.stringify(snapshot.request).includes('/installed'))
  assert.equal(await resolver.isCurrent(snapshot), true)
  revision = 'two'; assert.equal(await resolver.isCurrent(snapshot), false)
  snapshot.request.documents[1]!.permission = 'edit'; assert.throws(() => parseSuggestionRequest(snapshot.request))
})
test('mode-specific budgets keep automatic completion smaller than advanced edits', () => {
  const completion = suggestionContextBudget('completion')
  const nextEdit = suggestionContextBudget('next-edit')
  assert.ok(completion.relatedCharacters < nextEdit.relatedCharacters)
  assert.equal(completion.completionWindows, 1)
  assert.ok(nextEdit.completionWindows > completion.completionWindows)
})

test('slow language and file discovery share one soft budget and reuse completed background work', async () => {
  const h = setup('#include "Sensor.h"\nint main() { return read(); }\n')
  h.history.add(`f-${contentHash(h.doc.uri.toString())}`, 'read()', 'read(int scale)', 'typing')
  const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
  const definitions = deferred<unknown[]>(); const references = deferred<unknown[]>(); const paths = deferred<Uri[]>()
  const calls: string[] = []
  h.api.commands.executeCommand = ((command: string) => { calls.push(command); return command.includes('Definition') ? definitions.promise : references.promise }) as typeof h.api.commands.executeCommand
  h.api.workspace.findFiles = (() => { calls.push('findFiles'); return paths.promise }) as unknown as typeof h.api.workspace.findFiles
  const collect = () => h.resolver.collect(h.doc, new Position(1, 20) as vscode.Position, 'next-edit', 'manual', true, false, true)
  const start = Date.now(); const first = await collect()
  assert.ok(Date.now() - start < 350, 'discovery must not add sequential 180 + 180 + 150 ms waits')
  assert.equal(calls.length, 3); assert.equal(first.request.documents.length, 1)
  h.files.set('/workspace/Sensor.h', 'int read();\n')
  h.files.set('/workspace/Sensor.cpp', '#include "Sensor.h"\nint read() { return 1; }\n')
  definitions.resolve([{ uri: new Uri('/workspace/Sensor.h'), range: new Range(0, 0, 0, 3) }])
  references.resolve([]); paths.resolve([new Uri('/workspace/Sensor.cpp')])
  await new Promise(resolve => setTimeout(resolve, 0))
  const second = await collect()
  assert.equal(calls.length, 3, 'same snapshot reuses all completed discovery work')
  assert.ok(second.request.documents.some(document => document.relativePath === 'Sensor.cpp'))
  h.resolver.invalidate(); await collect()
  assert.equal(calls.length, 6, 'project/dependency changes invalidate discovery caches')
})
test('snapshot remains current across identical-content editor version drift', async () => {
  const h = setup('int value = 1;\n')
  const snapshot = await h.resolver.collect(h.doc, new Position(0, 14) as vscode.Position, 'next-edit', 'manual', false)
  h.document.version++
  assert.equal(await h.resolver.isCurrent(snapshot), true)
  h.document.text = 'int value = 2;\n'
  assert.equal(await h.resolver.isCurrent(snapshot), false)
})
test('active preview remains current while a webview temporarily owns focus', async () => {
  const h = setup('int value = 1;\n')
  const snapshot = await h.resolver.collect(h.doc, new Position(0, 14) as vscode.Position, 'next-edit', 'manual', false)
  h.opened.splice(0, 1)
  assert.equal(await h.resolver.isCurrent(snapshot), true)
  h.document.text = 'int value = 2;\n'
  assert.equal(await h.resolver.isCurrent(snapshot), false)
})
test('dependency files are context-only and outside workspace definitions are not read', async () => {
  const h = setup('Serial.println();')
  const dependency = new Uri('/workspace/sketch/libraries/Serial/Serial.h')
  h.files.set(dependency.path, 'void println();\n'); h.files.set('/private/sdk.h', 'secret')
  h.setDefinitions([{ uri: dependency, range: new Range(0, 0, 0, 4) }, { uri: new Uri('/private/sdk.h'), range: new Range(0, 0, 0, 4) }])
  const snapshot = await h.resolver.collect(h.doc, new Position(0, 7) as vscode.Position, 'completion', 'manual', false)
  assert.equal(snapshot.request.documents.length, 2); assert.equal(snapshot.request.documents[1]!.permission, 'context-only')
  h.files.set(dependency.path, 'void println(int);\n')
  assert.equal(await h.resolver.isCurrent(snapshot), false)
})
test('recent replacement intent finds a distant same-file window', async () => {
  const h = setup('int newName = 1;\n' + '// spacer\n'.repeat(20) + 'int value = oldName;\n')
  h.history.add(`f-${contentHash(h.document.uri.toString())}`, 'oldName', 'newName', 'typing')
  const snapshot = await h.resolver.collect(h.doc, new Position(0, 11) as vscode.Position, 'next-edit', 'manual', true)
  assert.ok(snapshot.request.documents[0]!.windows.some(window => window.purpose === 'completion' && window.range.start.line === 21))
  assert.doesNotThrow(() => parseSuggestionRequest(snapshot.request))
})
test('imports require one unique text-only LSP action; ambiguous/resource actions are excluded', async () => {
  const h = setup('Serial.println();\n')
  h.setDiagnostics([{ range: new Range(0, 0, 0, 6), severity: 0, message: 'unknown Serial' }])
  const action = (text: string, type = 2) => ({ edit: { entries: () => [[h.document.uri, [{ range: new Range(0, 0, 0, 0), newText: text }]]], _allEntries: () => [{ _type: type }] } })
  h.setActions([action('#include <Arduino.h>\n')])
  const collect = () => h.resolver.collect(h.doc, new Position(0, 7) as vscode.Position, 'next-edit', 'diagnostic', false, true)
  let snapshot = await collect(); assert.equal(snapshot.request.options.autoImports, true)
  assert.deepEqual(snapshot.request.documents[0]!.windows.find(window => window.purpose === 'import')!.allowedNewText, ['#include <Arduino.h>\n'])
  h.setActions([action('#include <Arduino.h>\n'), action('#include <Other.h>\n')]); snapshot = await collect(); assert.equal(snapshot.request.options.autoImports, false)
  h.setActions([action('#include <Arduino.h>\n', 1)]); snapshot = await collect(); assert.equal(snapshot.request.options.autoImports, false)
})
