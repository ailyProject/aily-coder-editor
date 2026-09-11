import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { WebSocket } from 'ws'
import { attachCoderAgentRpcServer } from '../server/agentRpcServer.js'
import { attachCoderLanguageServer } from '../server/languageServer.js'

test('managed runtime authenticates clangd, returns fresh diagnostics and definitions, releases sessions', { timeout: 20000 }, async t => {
  if (spawnSync('clangd', ['--version']).status !== 0) { t.skip('clangd is not installed on this test host'); return }
  const root = await mkdtemp(path.join(tmpdir(), 'aily-clangd-runtime-'))
  const file = path.join(root, 'probe.cpp'); const uri = pathToFileURL(file).toString()
  const text = 'int add(int a, int b) { return a + b; }\nint main() { return add(1); }\n'
  await writeFile(file, text)
  const http = createServer(); const rpc = attachCoderAgentRpcServer(http, { additionalUpgradePaths: ['/lsp'] })
  const lsp = attachCoderLanguageServer(http, rpc.token)
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve))
  const base = `ws://127.0.0.1:${http.address().port}/lsp?root=${encodeURIComponent(root)}`
  let socket
  try {
    const refused = await new Promise(resolve => {
      const invalid = new WebSocket(base + '&token=invalid')
      invalid.on('unexpected-response', (_req, response) => { response.resume(); invalid.terminate(); resolve(response.statusCode) })
      invalid.on('error', () => {})
    })
    assert.equal(refused, 403); assert.equal(lsp.activeCount, 0)
    socket = new WebSocket(base + '&token=' + rpc.token)
    const messages = []; const waiters = new Set()
    socket.on('message', data => { messages.push(JSON.parse(data.toString())); for (const wake of waiters) wake() })
    const until = predicate => new Promise((resolve, reject) => {
      const timer = setTimeout(() => { waiters.delete(check); reject(new Error('language response timeout')) }, 12000)
      function check() { const result = messages.find(predicate); if (result) { clearTimeout(timer); waiters.delete(check); resolve(result) } }
      waiters.add(check); check()
    })
    const send = message => socket.send(JSON.stringify({ jsonrpc: '2.0', ...message }))
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
    send({ id: 1, method: 'initialize', params: { processId: null, rootUri: pathToFileURL(root).toString(), capabilities: {} } })
    assert.ok((await until(message => message.id === 1)).result.capabilities.definitionProvider)
    send({ method: 'initialized', params: {} })
    send({ method: 'textDocument/didOpen', params: { textDocument: { uri, languageId: 'cpp', version: 1, text } } })
    const diagnostics = await until(message => message.method === 'textDocument/publishDiagnostics' && message.params.uri === uri && message.params.diagnostics.length)
    assert.match(diagnostics.params.diagnostics[0].message, /argument|matching function/i)
    send({ id: 2, method: 'textDocument/definition', params: { textDocument: { uri }, position: { line: 1, character: 20 } } })
    assert.equal((await until(message => message.id === 2)).result[0].range.start.line, 0)
    send({ method: 'textDocument/didChange', params: { textDocument: { uri, version: 2 }, contentChanges: [{ text: text.replace('add(1)', 'add(1, 2)') }] } })
    await until(message => message.method === 'textDocument/publishDiagnostics' && message.params.uri === uri && message.params.version === 2 && !message.params.diagnostics.length)
    await new Promise(resolve => { socket.once('close', resolve); socket.close() })
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(lsp.activeCount, 0)
  } finally {
    socket?.terminate(); await lsp.close(); await rpc.close()
    await new Promise(resolve => http.close(resolve)); await rm(root, { recursive: true, force: true })
  }
})
