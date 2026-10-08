import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { WebSocket } from 'ws'
import { attachCoderLanguageServer } from '../server/languageServer.js'
import { resolveCoderLanguageConfig } from '../server/languageServerConfig.js'
import { readLanguageFile } from '../server/languageServerFiles.js'

async function fixture(t) {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), 'aily-navigation-')))
  t.after(() => rm(base, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }))
  const root = path.join(base, 'project'); const appData = path.join(base, 'global'); const sdk = path.join(appData, 'sdk', 'probe_1.0.0')
  const core = path.join(sdk, 'cores', 'probe'); const library = path.join(root, 'node_modules', '@aily-project', 'lib-probe', 'src')
  const environment = path.join(base, 'environment headers')
  for (const folder of [root, core, library, environment]) await mkdir(folder, { recursive: true })
  const files = {
    [path.join(root, 'package.json')]: JSON.stringify({ boardDependencies: { '@aily-project/sdk-probe': '1.0.0' }, dependencies: { '@aily-project/lib-probe': '1.0.0' } }),
    [path.join(root, '.aily', 'coder-embed-hints.json')]: JSON.stringify({ platformPackages: [{ kind: 'sdk', absolutePath: sdk, packageName: '@aily-project/sdk-probe' }] }),
    [path.join(sdk, 'platform.txt')]: `recipe.cpp.o.pattern="clang++" "@${sdk}/cpp-flags.rsp" {includes} "{source_file}" -o "{object_file}"\n`,
    [path.join(sdk, 'cpp-flags.rsp')]: '-std=c++17 -DSDK_GLOBAL=7 -fno-tree-switch-conversion\n',
    [path.join(sdk, 'boards.txt')]: '',
    [path.join(core, 'SDK.h')]: '#pragma once\nstruct SDKType { int value; };\nextern SDKType globalDevice;\nint sdkRead();\n',
    [path.join(core, 'SDK.cpp')]: '#include "SDK.h"\nSDKType globalDevice{7};\nint sdkRead() { return SDK_GLOBAL; }\n',
    [path.join(library, 'Probe.h')]: '#pragma once\nstruct Probe { int read(); };\n',
    [path.join(library, 'Probe.cpp')]: '#include "Probe.h"\nint Probe::read() { return 42; }\n',
    [path.join(environment, 'Environment.h')]: '#pragma once\n#define ENV_GLOBAL 11\n',
    [path.join(root, 'main.cpp')]: '#include <SDK.h>\n#include <Probe.h>\n#include <Environment.h>\nProbe probe;\nint run() { return probe.read() + sdkRead() + globalDevice.value + ENV_GLOBAL; }\n',
  }
  for (const [file, content] of Object.entries(files)) { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, content) }
  // Host-selected core is normally obtained from board.json/FQBN.
  const board = path.join(root, 'node_modules', '@aily-project', 'board-probe')
  await mkdir(board, { recursive: true })
  await writeFile(path.join(board, 'package.json'), '{}')
  await writeFile(path.join(board, 'board.json'), JSON.stringify({ compilerParam: 'compile -b probe:probe:probe' }))
  await writeFile(path.join(sdk, 'boards.txt'), 'probe.build.core=probe\n')
  const manifest = JSON.parse(files[path.join(root, 'package.json')]); manifest.board = '@aily-project/board-probe'
  await writeFile(path.join(root, 'package.json'), JSON.stringify(manifest))
  return { base, root, appData, core, library, environment, files, env: { ...process.env, CPATH: environment } }
}

test('navigation database includes SDK, installed library implementations and global include environment before the first build', async t => {
  const f = await fixture(t)
  const config = await resolveCoderLanguageConfig(f.root, { command: 'clangd', appDataPath: f.appData, env: f.env })
  assert.equal(config.compilationDatabase, false)
  const rows = JSON.parse(await readFile(path.join(config.database, 'compile_commands.json'), 'utf8'))
  for (const name of [path.join(f.core, 'SDK.cpp'), path.join(f.library, 'Probe.cpp'), path.join(f.root, 'main.cpp')]) {
    const row = rows.find(row => row.file === name)
    assert.ok(row, name); assert.ok(row.arguments.includes('-DSDK_GLOBAL=7'))
    assert.ok(!row.arguments.includes('-fno-tree-switch-conversion'))
    for (const folder of [f.core, f.library, f.environment]) assert.ok(row.arguments.includes(folder), folder)
  }
  assert.ok(config.readableRoots.includes(f.core) || config.readableRoots.some(root => f.core.startsWith(root + path.sep)))
  assert.ok(config.readableRoots.includes(f.environment))
})

test('source reader denies mutation, traversal and symlink escapes, returns bounded real source bytes', async t => {
  const f = await fixture(t)
  const file = path.join(f.core, 'SDK.h')
  assert.equal(Buffer.from((await readLanguageFile('aily/fs/readFile', { path: file }, [f.core])).base64, 'base64').toString(), f.files[file])
  await assert.rejects(readLanguageFile('aily/fs/writeFile', { path: file }, [f.core]))
  await assert.rejects(readLanguageFile('aily/fs/readFile', { path: path.join(f.root, 'main.cpp') }, [f.core]))
  if (process.platform !== 'win32') {
    const link = path.join(f.core, 'escape.h'); await symlink(path.join(f.root, 'main.cpp'), link)
    await assert.rejects(readLanguageFile('aily/fs/readFile', { path: link }, [f.core]))
  }
  const large = path.join(f.core, 'large.h'); await writeFile(large, Buffer.alloc(4 * 1024 * 1024 + 1))
  await assert.rejects(readLanguageFile('aily/fs/readFile', { path: large }, [f.core]))
})

test('host global build database stays authoritative and custom include/response paths open read-only without rewriting build records', async t => {
  const f = await fixture(t)
  const bucket = path.join(f.base, 'builder-projects'); const build = path.join(bucket, 'main-hash')
  const custom = path.join(f.base, 'custom includes')
  await mkdir(build, { recursive: true }); await mkdir(custom)
  await writeFile(path.join(custom, 'Custom.h'), 'extern int customGlobal;\n')
  const responseFile = path.join(f.root, 'board-flags.rsp')
  await writeFile(responseFile, `"-I${custom}" -DREAL_BUILD_CONFIG=1 -fstrict-volatile-bitfields`)
  const original = JSON.stringify([{ directory: f.root, file: path.join(f.root, 'main.cpp'), arguments: ['custom-not-executed-g++', `@${responseFile}`, '-std=c++20', path.join(f.root, 'main.cpp')] }])
  const databaseFile = path.join(build, 'compile_commands.json')
  await writeFile(databaseFile, original)
  await writeFile(path.join(f.root, '.aily', 'coder-embed-hints.json'), JSON.stringify({ buildPath: build }))
  const config = await resolveCoderLanguageConfig(f.root, { command: 'configured-clangd', appDataPath: f.appData, builderBuildPath: bucket, env: f.env })
  assert.equal(config.compilationDatabase, true)
  const rows = JSON.parse(await readFile(path.join(config.database, 'compile_commands.json'), 'utf8'))
  const main = rows.find(row => row.file.endsWith('/main.cpp'))
  assert.equal(main.arguments[0], 'custom-not-executed-g++')
  assert.ok(main.arguments.includes('-std=c++20'))
  assert.ok(main.arguments.includes('-DREAL_BUILD_CONFIG=1'))
  assert.ok(!main.arguments.includes('-fstrict-volatile-bitfields'))
  assert.ok(config.readableRoots.includes(custom))
  assert.equal(await readFile(databaseFile, 'utf8'), original)
  assert.equal(Buffer.from((await readLanguageFile('aily/fs/readFile', { path: path.join(custom, 'Custom.h') }, config.readableRoots)).base64, 'base64').toString(), 'extern int customGlobal;\n')
})

for (const built of [false, true]) test(`real clangd navigates library/SDK/environment definitions, type, references, rename and call hierarchy (${built ? 'build' : 'first open'})`, { timeout: 30000 }, async t => {
  if (spawnSync('clangd', ['--version']).status !== 0) { t.skip('clangd is not installed'); return }
  const f = await fixture(t); const file = path.join(f.root, 'main.cpp'); const uri = pathToFileURL(file).toString()
  if (built) await writeFile(path.join(f.root, 'compile_commands.json'), JSON.stringify([{ directory: f.root, file, arguments: ['clang++', '-std=c++17', '-DSDK_GLOBAL=7', file] }]))
  const http = createServer(); const lsp = attachCoderLanguageServer(http, 'navigation-test-only', { appDataPath: f.appData, env: f.env })
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve))
  const socket = new WebSocket(`ws://127.0.0.1:${http.address().port}/lsp?root=${encodeURIComponent(f.root)}&token=navigation-test-only`)
  let sequence = 0; const responses = new Map(); const notices = []; const waiters = new Set()
  socket.on('message', data => { const message = JSON.parse(data.toString()); if (message.id) responses.set(message.id, message); else notices.push(message); for (const wake of waiters) wake() })
  const until = predicate => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { waiters.delete(check); reject(new Error('Navigation response timeout')) }, 15000)
    function check() { const value = predicate(); if (value) { clearTimeout(timer); waiters.delete(check); resolve(value) } }
    waiters.add(check); check()
  })
  const request = async (method, params) => {
    const id = ++sequence; socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    const response = await until(() => responses.get(id)); if (response.error) throw new Error(response.error.message); return response.result
  }
  const send = (method, params) => socket.send(JSON.stringify({ jsonrpc: '2.0', method, params }))
  const location = word => ({ textDocument: { uri }, position: { line: 4, character: f.files[file].split('\n')[4].indexOf(word) + 1 } })
  const targets = result => result.map(item => fileURLToPath(item.uri || item.targetUri))
  try {
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
    const init = await request('initialize', { processId: null, rootUri: pathToFileURL(f.root).toString(), capabilities: {} })
    assert.equal(init.capabilities.experimental.ailyCompilationDatabase, built)
    for (const capability of ['declarationProvider', 'definitionProvider', 'implementationProvider', 'typeDefinitionProvider', 'referencesProvider', 'renameProvider', 'callHierarchyProvider', 'documentSymbolProvider']) assert.ok(init.capabilities[capability], capability)
    send('initialized', {})
    send('textDocument/didOpen', { textDocument: { uri, languageId: 'cpp', version: 1, text: f.files[file] } })
    const diagnostics = await until(() => notices.find(message => message.method === 'textDocument/publishDiagnostics' && message.params.uri === uri))
    assert.deepEqual(diagnostics.params.diagnostics, [])
    const header = await request('textDocument/definition', location('globalDevice'))
    assert.ok(targets(header).some(target => /SDK\.(?:h|cpp)$/.test(target)))
    const macro = await request('textDocument/definition', location('ENV_GLOBAL'))
    assert.deepEqual(targets(macro), [path.join(f.environment, 'Environment.h')])
    const type = await request('textDocument/typeDefinition', location('probe'))
    assert.deepEqual(targets(type), [path.join(f.library, 'Probe.h')])
    const references = await request('textDocument/references', { ...location('probe'), context: { includeDeclaration: true } })
    assert.ok(references.length >= 2)
    const rename = await request('textDocument/rename', { ...location('probe'), newName: 'sensor' })
    assert.equal(Object.values(rename.changes)[0].length, 2)
    const hierarchy = await request('textDocument/prepareCallHierarchy', location('run'))
    const calls = await request('callHierarchy/outgoingCalls', { item: hierarchy[0] })
    assert.ok(calls.some(call => call.to.name.includes('read')))
    const symbols = await request('textDocument/documentSymbol', { textDocument: { uri } })
    assert.ok(symbols.some(symbol => symbol.name.includes('run')))
    // Retry while background indexing is finishing the external implementation.
    let definition
    for (let attempt = 0; attempt < 40; attempt++) {
      definition = await request('textDocument/definition', location('read'))
      if (targets(definition).some(target => target.endsWith('/Probe.cpp'))) break
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.ok(targets(definition).some(target => target.endsWith('/Probe.cpp')), JSON.stringify(definition))
    const declaration = await request('textDocument/declaration', location('read'))
    assert.deepEqual(targets(declaration), [path.join(f.library, 'Probe.h')])
    const implementation = await request('textDocument/implementation', location('read'))
    assert.ok(targets(implementation).some(target => target.endsWith('/Probe.cpp')))
    const source = await request('aily/fs/readFile', { path: path.join(f.core, 'SDK.h') })
    assert.equal(Buffer.from(source.base64, 'base64').toString(), f.files[path.join(f.core, 'SDK.h')])
    await assert.rejects(request('aily/fs/readFile', { path: path.join(f.base, 'not-authorized') }))
    // Opening an external header keeps the board environment for further jumps.
    const headerUri = pathToFileURL(path.join(f.core, 'SDK.h')).toString()
    send('textDocument/didOpen', { textDocument: { uri: headerUri, languageId: 'cpp', version: 1, text: f.files[path.join(f.core, 'SDK.h')] } })
    const sdkType = await request('textDocument/typeDefinition', { textDocument: { uri: headerUri }, position: { line: 2, character: 20 } })
    assert.ok(targets(sdkType).some(target => target === path.join(f.core, 'SDK.h')))
  } finally { socket.terminate(); await lsp.close(); await new Promise(resolve => http.close(resolve)) }
})
