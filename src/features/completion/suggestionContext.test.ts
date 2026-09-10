import assert from 'node:assert/strict'
import test from 'node:test'
import type * as vscode from 'vscode'
import { SuggestionContextResolver, suggestionContextBudget } from './suggestionContext'
import { RecentEditStore, contentHash } from './completionState'
import { parseSuggestionRequest } from './suggestionProtocol'

class Position { constructor(public line: number, public character: number) {} }
class Range {
  start: Position; end: Position
  constructor(a: number, b: number, c: number, d: number) { this.start = new Position(a, b); this.end = new Position(c, d) }
}
class Uri {
  scheme = 'file'
  constructor(public path: string) {}
  toString() { return `file://${this.path}` }
  with(value: { path: string }) { return new Uri(value.path) }
}
class Document {
  version = 1; languageId = 'cpp'; uri: Uri
  constructor(public text: string, path = '/workspace/main.cpp') { this.uri = new Uri(path) }
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
function setup(text: string) {
  const document = new Document(text); const opened = [document]; const files = new Map<string, string>()
  const history = new RecentEditStore()
  let definitions: unknown[] = []; let actions: unknown[] = []; let diagnostics: unknown[] = []
  const api = { Position, Range, DiagnosticSeverity: { Error: 0, Warning: 1 },
    workspace: { textDocuments: opened, getWorkspaceFolder: (uri: Uri) => uri.path.startsWith('/workspace/') ? { uri: new Uri('/workspace') } : undefined,
      asRelativePath: (uri: Uri) => uri.path.slice('/workspace/'.length), fs: { readFile: async (uri: Uri) => new TextEncoder().encode(files.get(uri.path) ?? '') } },
    commands: { executeCommand: async (command: string) => command.includes('Definition') ? definitions : command.includes('CodeAction') ? actions : [] },
    languages: { getDiagnostics: () => diagnostics },
  } as unknown as typeof vscode
  const resolver = new SuggestionContextResolver(api, 'test-session', history, '0.1.6')
  return { document, opened, files, history, resolver, doc: document as unknown as vscode.TextDocument,
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
test('mode-specific budgets keep automatic completion smaller than advanced edits', () => {
  const completion = suggestionContextBudget('completion')
  const alternatives = suggestionContextBudget('alternatives')
  const nextEdit = suggestionContextBudget('next-edit')
  assert.ok(completion.beforeCharacters < alternatives.beforeCharacters)
  assert.ok(completion.relatedCharacters < nextEdit.relatedCharacters)
  assert.equal(completion.completionWindows, 1)
  assert.ok(nextEdit.completionWindows > completion.completionWindows)
})
test('snapshot remains current across identical-content editor version drift', async () => {
  const h = setup('int value = 1;\n')
  const snapshot = await h.resolver.collect(h.doc, new Position(0, 14) as vscode.Position, 'alternatives', 'manual', false)
  h.document.version++
  assert.equal(await h.resolver.isCurrent(snapshot), true)
  h.document.text = 'int value = 2;\n'
  assert.equal(await h.resolver.isCurrent(snapshot), false)
})
test('active preview remains current while a webview temporarily owns focus', async () => {
  const h = setup('int value = 1;\n')
  const snapshot = await h.resolver.collect(h.doc, new Position(0, 14) as vscode.Position, 'alternatives', 'manual', false)
  h.opened.splice(0, 1)
  assert.equal(await h.resolver.isCurrent(snapshot), true)
  h.document.text = 'int value = 2;\n'
  assert.equal(await h.resolver.isCurrent(snapshot), false)
})
test('dependency files are context-only and outside workspace definitions are not read', async () => {
  const h = setup('Serial.println();')
  const dependency = new Uri('/workspace/sketch/libraries/Serial/Serial.h')
  h.files.set(dependency.path, 'void println();\n'); h.files.set('/private/sdk.h', 'secret')
  h.setDefinitions([{ uri: dependency }, { uri: new Uri('/private/sdk.h') }])
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
