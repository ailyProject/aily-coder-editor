// Loopback-only editor acceptance fixture. All writes are confined to a temporary
// project; language-service and source-reader code are the production modules.
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, writeFile, readdir, realpath, stat, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { attachCoderLanguageServer } from '../server/languageServer.js'
import { insideLanguageRoot } from '../server/languageServerEnvironment.js'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const base = await realpath(await mkdtemp(path.join(tmpdir(), 'aily-navigation-ui-')))
const root = path.join(base, 'project'); const appData = path.join(base, 'global')
const sdk = path.join(appData, 'sdk', 'probe_1.0.0'); const core = path.join(sdk, 'cores', 'probe')
const library = path.join(root, 'node_modules', '@aily-project', 'lib-probe', 'src')
const environment = path.join(base, 'environment')
const board = path.join(root, 'node_modules', '@aily-project', 'board-probe')
for (const folder of [core, library, environment, board]) await mkdir(folder, { recursive: true })
const source = '#include <SDK.h>\n#include <Probe.h>\n#include <Environment.h>\nProbe probe;\nint run() { return probe.read() + probe.read() + sdkRead() + globalDevice.value + ENV_GLOBAL; }\n'
for (const [file, content] of [
  [path.join(root, 'main.cpp'), source],
  [path.join(root, 'package.json'), JSON.stringify({ board: 'Probe board', dependencies: { '@aily-project/board-probe': '1.0.0', '@aily-project/lib-probe': '1.0.0' }, boardDependencies: { '@aily-project/sdk-probe': '1.0.0' } })],
  [path.join(board, 'package.json'), '{}'], [path.join(board, 'board.json'), '{"compilerParam":"compile -b probe:probe:probe"}'],
  [path.join(sdk, 'platform.txt'), 'recipe.cpp.o.pattern="clang++" -std=c++17 -DSDK_GLOBAL=7 {includes} "{source_file}" -o "{object_file}"\n'],
  [path.join(sdk, 'boards.txt'), 'probe.build.core=probe\n'],
  [path.join(core, 'SDK.h'), '#pragma once\nstruct SDKType { int value; };\nextern SDKType globalDevice;\nint sdkRead();\n'],
  [path.join(core, 'SDK.cpp'), '#include "SDK.h"\nSDKType globalDevice{7};\nint sdkRead() { return SDK_GLOBAL; }\n'],
  [path.join(library, 'Probe.h'), '#pragma once\nstruct Probe { int read(); };\n'],
  [path.join(library, 'Probe.cpp'), '#include "Probe.h"\nint Probe::read() { return 42; }\n'],
  [path.join(environment, 'Environment.h'), '#pragma once\n#define ENV_GLOBAL 11\n'],
]) await writeFile(file, content)

const token = 'navigation-fixture-only'; const port = Number(process.env.AILY_NAVIGATION_PORT || 8018)
const url = `http://127.0.0.1:${port}`
const lspUrl = `ws://127.0.0.1:${port}/lsp?root=${encodeURIComponent(root)}&token=${token}`
const childUrl = `/coder?mode=full-workbench&nativeFsBridge=true&folder=${encodeURIComponent(root)}&theme=dark&lang=zh-cn&lspWs=${encodeURIComponent(lspUrl)}`
const html = `<!doctype html><meta charset="utf-8"><title>Coder language navigation acceptance</title>
<style>html,body{margin:0;height:100%;background:#181818}iframe{width:100%;height:100%;border:0}</style>
<script>window.fixture=${JSON.stringify({ root, core, library, environment, source })};
window.addEventListener('message',async event=>{
 const message=event.data;if(event.source!==document.querySelector('iframe')?.contentWindow)return;
 if(message.channel==='aily-coder-editor-host-context-request')event.source.postMessage({channel:'aily-coder-editor-host-context',payload:{v:1,workspaceRoot:fixture.root,appDataPath:${JSON.stringify(appData)}}},location.origin);
 if(message.channel!=='aily-coder-editor-native-fs')return;
 const response=await fetch('/fixture/fs',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(message)}).then(r=>r.json());
 event.source.postMessage({channel:'aily-coder-editor-native-fs-reply',id:message.id,...response},location.origin);
});</script><iframe src="${childUrl}"></iframe>`
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' }
const server = createServer(async (request, response) => {
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
  response.setHeader('Cross-Origin-Embedder-Policy', 'credentialless')
  try {
    if (request.url === '/fixture/fs' && request.method === 'POST') {
      const chunks = []; for await (const chunk of request) chunks.push(chunk)
      const message = JSON.parse(Buffer.concat(chunks).toString()); const file = path.resolve(message.payload?.path || root)
      if (!insideLanguageRoot(root, file)) throw new Error('Outside fixture workspace')
      let result
      if (message.op === 'nativeFsStat') { const info = await stat(file).catch(() => null); result = { exists: Boolean(info), _isDirectory: info?.isDirectory(), _isFile: info?.isFile(), size: info?.size || 0, mtimeMs: info?.mtimeMs || 0 } }
      else if (message.op === 'nativeFsReadBinary') result = { base64: (await readFile(file)).toString('base64') }
      else if (message.op === 'nativeFsReaddir') result = (await readdir(file, { withFileTypes: true })).map(entry => ({ name: entry.name, _isDirectory: entry.isDirectory(), _isFile: entry.isFile() }))
      else if (message.op === 'nativeFsWriteBinary') { await writeFile(file, Buffer.from(message.payload.base64, 'base64')); result = {} }
      else if (/Watch/.test(message.op)) result = { watchId: message.id }
      else throw new Error('Fixture capability unavailable')
      response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ result })); return
    }
    if (request.url === '/') { response.setHeader('Content-Type', 'text/html'); response.end(html); return }
    const pathname = new URL(request.url, url).pathname
    const file = pathname === '/coder' ? path.join(packageRoot, 'ui', 'index.html') : path.join(packageRoot, 'ui', pathname)
    if (!insideLanguageRoot(path.join(packageRoot, 'ui'), file)) throw new Error('Invalid fixture resource')
    response.setHeader('Content-Type', mime[path.extname(file)] || 'application/octet-stream'); response.end(await readFile(file))
  } catch (error) {
    response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ error: error.message }))
  }
})
const lsp = attachCoderLanguageServer(server, token, { appDataPath: appData, env: { ...process.env, CPATH: environment } })
await new Promise(resolve => server.listen(port, '127.0.0.1', resolve))
console.log(JSON.stringify({ url, root }))
async function stop() { await lsp.close(); server.close(); await rm(base, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); process.exit(0) }
process.once('SIGTERM', () => void stop()); process.once('SIGINT', () => void stop())
