import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { WebSocket } from 'ws'
import { attachCoderLanguageServer } from '../server/languageServer.js'
import { defaultAilyAppDataPath } from '../server/componentLibraryService.js'

// This acceptance test uses the installed ESP32 SDK/toolchain, not fake Arduino
// declarations. CI without these packages skips explicitly; developers can set
// AILY_ESP32_TEST_APPDATA and AILY_ESP32_TEST_VERSION to their installed versions.
for (const extension of ['cpp', 'ino']) test(`real installed ESP32 SDK resolves inherited and overloaded members in .${extension}`, { timeout: 90000 }, async t => {
  const appData = process.env.AILY_ESP32_TEST_APPDATA || defaultAilyAppDataPath()
  const version = process.env.AILY_ESP32_TEST_VERSION || '3.3.10'
  const sdk = path.join(appData, 'sdk', `esp32_${version}`)
  try { await readFile(path.join(sdk, 'cores', 'esp32', 'Print.h')) }
  catch { t.skip(`ESP32 ${version} SDK is not installed at ${appData}`); return }
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'aily-esp32-members-')))
  const board = '@aily-project/board-esp32'; const boardRoot = path.join(root, 'node_modules', board)
  await mkdir(boardRoot, { recursive: true })
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ board, dependencies: { [board]: version } }))
  await writeFile(path.join(boardRoot, 'package.json'), JSON.stringify({ boardDependencies: {
    '@aily-project/sdk-esp32': version, '@aily-project/compiler-esp-x32': '14.2.0', '@aily-project/tool-esp32-libs': version,
  } }))
  await writeFile(path.join(boardRoot, 'board.json'), JSON.stringify({ compilerParam: 'compile -b esp32:esp32:esp32' }))
  const source = `#include <Arduino.h>
#include <Wire.h>
#include <WiFi.h>
void setup() {
  Serial.begin(115200);
  Serial.printf("number=%d\\n", 1);
  Serial.printf(F("flash=%d\\n"), 1);
  Serial.print(1);
  Serial.println(1);
  Serial.write(static_cast<uint8_t>(65));
  Serial.available();
  Wire.begin();
  WiFi.begin("ssid", "password");
  Print &output = Serial; output.printf("base=%d", 1);
  Stream &input = Serial; input.readString();
  String text("hello"); text.length();
}
void loop() {}
`
  const file = path.join(root, `main.${extension}`); const uri = pathToFileURL(file).toString()
  await writeFile(file, source)
  const http = createServer(); const lsp = attachCoderLanguageServer(http, 'esp32-test-only', { appDataPath: appData })
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve))
  const socket = new WebSocket(`ws://127.0.0.1:${http.address().port}/lsp?root=${encodeURIComponent(root)}&token=esp32-test-only`)
  let sequence = 0; const pending = new Map(); const diagnostics = []
  socket.on('message', raw => {
    const message = JSON.parse(raw.toString())
    if (pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id) }
    if (message.method === 'textDocument/publishDiagnostics' && message.params.uri === uri) diagnostics.push(message.params)
  })
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++sequence
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)) }, 20000)
    pending.set(id, message => { clearTimeout(timer); message.error ? reject(new Error(message.error.message)) : resolve(message.result) })
    socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
  })
  const send = (method, params) => socket.send(JSON.stringify({ jsonrpc: '2.0', method, params }))
  const at = (line, word) => ({ textDocument: { uri }, position: { line, character: source.split('\n')[line].indexOf(word) + 1 } })
  const files = locations => (locations || []).map(location => fileURLToPath(location.uri || location.targetUri))
  try {
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
    await request('initialize', { processId: null, rootUri: pathToFileURL(root).toString(), capabilities: {} })
    send('initialized', {}); send('textDocument/didOpen', { textDocument: { uri, languageId: 'cpp', version: 1, text: source } })
    for (const [line, word, target] of [
      [5, 'Serial', 'HardwareSerial.h'], [4, 'begin', 'HardwareSerial'], [5, 'printf', 'Print'], [6, 'printf', 'Print'],
      [7, 'print', 'Print'], [8, 'println', 'Print'], [9, 'write', 'HardwareSerial'], [10, 'available', 'HardwareSerial'],
      [11, 'begin', 'Wire'], [12, 'begin', 'WiFiSTA'], [13, 'printf', 'Print'], [14, 'readString', 'Stream'], [15, 'length', 'WString'],
    ]) {
      const result = await request('textDocument/definition', at(line, word))
      assert.ok(files(result).some(file => path.basename(file).startsWith(target)), `${word}: ${JSON.stringify(result)}`)
      for (const destination of new Set(files(result))) {
        const data = await request('aily/fs/readFile', { path: destination })
        assert.ok(Buffer.from(data.base64, 'base64').length > 0, destination)
      }
    }
    const plain = await request('textDocument/declaration', at(5, 'printf'))
    const flash = await request('textDocument/declaration', at(6, 'printf'))
    assert.equal(plain.length, 1); assert.equal(flash.length, 1)
    assert.notDeepEqual(plain[0].range, flash[0].range, 'printf overloads must resolve to distinct signatures')
    // Declaration navigation works immediately. Definition navigation must also
    // reach the actual inherited method body once background indexing finishes.
    let body
    // ESP32 brings hundreds of SDK translation units; a cold index is slower
    // than the small synthetic navigation fixture, especially on Windows.
    for (let attempt = 0; attempt < 600; attempt++) {
      body = await request('textDocument/definition', at(5, 'printf'))
      if (files(body).some(file => path.basename(file) === 'Print.cpp')) break
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.ok(files(body).some(file => path.basename(file) === 'Print.cpp'), JSON.stringify(body))
    const implementation = await request('textDocument/implementation', at(5, 'printf'))
    assert.ok(files(implementation).some(file => path.basename(file) === 'Print.cpp'), JSON.stringify(implementation))
    const mainCommand = JSON.parse(await readFile(path.join(root, '.aily', 'lsp', 'compile_commands.json'), 'utf8')).find(row => row.file === file)
    assert.match(mainCommand.arguments[0], /xtensa-esp32-elf-g\+\+(?:\.exe)?$/)
    const last = diagnostics.at(-1)
    assert.ok(last, 'real clangd must publish diagnostics')
    assert.deepEqual(last.diagnostics.filter(item => item.severity === 1), [], JSON.stringify(last.diagnostics))
  } finally {
    socket.terminate(); await lsp.close(); await new Promise(resolve => http.close(resolve))
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 })
  }
})
