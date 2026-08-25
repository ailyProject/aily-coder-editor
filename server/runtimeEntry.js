import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import path from 'node:path'
import process from 'node:process'
import { setTimeout } from 'node:timers'
import { fileURLToPath, URL } from 'node:url'
import { attachCoderAgentRpcServer } from './agentRpcServer.js'
import { handleComponentLibraryApiRequest } from './componentLibraryApi.js'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const uiRoot = path.join(packageRoot, 'ui')
const indexPath = path.join(uiRoot, 'index.html')

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function parseArgs(argv) {
  const [command = 'help', ...rest] = argv
  const options = {}
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index]
    if (!arg.startsWith('--')) continue
    const key = arg.slice(2)
    const next = rest[index + 1]
    options[key] = next && !next.startsWith('--') ? rest[++index] : true
  }
  return { command, options }
}

function mimeType(filePath) {
  const extension = path.extname(filePath).toLowerCase()
  return {
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.ico': 'image/x-icon',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.ttf': 'font/ttf',
    '.wasm': 'application/wasm',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
  }[extension] || 'application/octet-stream'
}

function resolveUiFile(requestUrl) {
  const parsed = new URL(requestUrl || '/', 'http://127.0.0.1')
  const pathname = decodeURIComponent(parsed.pathname)
  if (pathname.includes('\0')) {
    throw new Error('Invalid request path')
  }
  const relativePath = path.posix.normalize(`/${pathname.replaceAll('\\', '/')}`)
    .replace(/^\/+/, '')
  const candidate = path.resolve(uiRoot, relativePath || 'index.html')
  const relative = path.relative(uiRoot, candidate)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Request path escapes the Coder UI root')
  }
  if (existsSync(candidate) && statSync(candidate).isFile()) {
    return candidate
  }
  return indexPath
}

function serveFile(request, response, filePath) {
  const headers = {
    'Cache-Control': filePath === indexPath ? 'no-cache' : 'public, max-age=31536000, immutable',
    'Content-Type': mimeType(filePath),
    'Cross-Origin-Embedder-Policy': 'credentialless',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'cross-origin',
  }
  response.writeHead(200, headers)
  if (request.method === 'HEAD') {
    response.end()
    return
  }
  if (filePath === indexPath) {
    const markerPath = path.join(packageRoot, '.aily-dev.json')
    try {
      const marker = JSON.parse(readFileSync(markerPath, 'utf8'))
      const reloadUrl = new URL(String(marker.reloadUrl || ''))
      if (reloadUrl.hostname === '127.0.0.1' || reloadUrl.hostname === 'localhost') {
        const reloadScript = `<script>new EventSource(${JSON.stringify(reloadUrl.toString())}).addEventListener('reload',()=>location.reload())</script>`
        const html = readFileSync(indexPath, 'utf8').replace(/<\/body>/i, `${reloadScript}</body>`)
        response.end(html)
        return
      }
    } catch {
      // Production and one-shot links do not have a development marker.
    }
  }
  createReadStream(filePath)
    .once('error', () => {
      if (!response.headersSent) response.writeHead(500)
      response.end()
    })
    .pipe(response)
}

async function startServeMode(options) {
  if (!existsSync(indexPath)) {
    throw new Error(`Coder UI has not been built: ${indexPath}`)
  }

  const host = typeof options.host === 'string' ? options.host : '127.0.0.1'
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
    throw new Error('Aily Coder Runtime must listen on a loopback host')
  }
  const requestedPort = Number(options.port ?? 0)
  const port = Number.isInteger(requestedPort) && requestedPort >= 0 ? requestedPort : 0
  let shuttingDown = false

  const server = createServer((request, response) => {
    void handleComponentLibraryApiRequest(request, response).then(handled => {
      if (handled) return
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.writeHead(405, { Allow: 'GET, HEAD' })
        response.end()
        return
      }
      try {
        serveFile(request, response, resolveUiFile(request.url))
      } catch (error) {
        response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' })
        response.end(error instanceof Error ? error.message : String(error))
      }
    }).catch(error => {
      if (!response.headersSent) {
        response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
      }
      response.end(error instanceof Error ? error.message : String(error))
    })
  })
  const agentRpc = attachCoderAgentRpcServer(server)

  const shutdown = () => {
    if (shuttingDown) return
    shuttingDown = true
    void agentRpc.close().finally(() => {
      server.close(() => process.exit(0))
    })
    setTimeout(() => process.exit(0), 2000).unref()
  }

  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, resolve)
  })

  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Coder server did not expose a TCP address')
  }
  const originHost = host === '::1' ? '[::1]' : host
  const origin = `http://${originHost}:${address.port}`
  write({
    event: 'ready',
    data: {
      mode: 'serve',
      url: `${origin}/`,
      origin,
      wsUrl: `ws://${originHost}:${address.port}${agentRpc.wsPath}`,
      port: address.port,
      pid: process.pid,
    },
  })
}

const { command, options } = parseArgs(process.argv.slice(2))
if (command === 'serve') {
  startServeMode(options).catch((error) => {
    write({
      event: 'fatal',
      data: { message: error instanceof Error ? error.message : String(error) },
    })
    process.exit(1)
  })
} else {
  process.stderr.write('Usage: node index.js serve [--host 127.0.0.1] [--port 0]\n')
  process.exitCode = 1
}
