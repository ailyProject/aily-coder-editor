import { spawn } from 'node:child_process'
import { Buffer } from 'node:buffer'
import { timingSafeEqual } from 'node:crypto'
import { realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import { setTimeout, clearTimeout } from 'node:timers'
import { WebSocket, WebSocketServer } from 'ws'
import { resolveCoderLanguageConfig } from './languageServerConfig.js'

const MAX_BYTES = 8 * 1024 * 1024
export function attachCoderLanguageServer(server, token, options = {}) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_BYTES })
  const clients = new Map()
  let preparing = 0
  const onUpgrade = async (request, socket, head) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1')
    if (url.pathname !== '/lsp') return
    const actual = Buffer.from(url.searchParams.get('token') || '')
    const expected = Buffer.from(token)
    let root
    try {
      const requested = url.searchParams.get('root') || ''
      if (!path.isAbsolute(requested)) throw new Error('absolute workspace required')
      root = realpathSync(requested)
      if (!statSync(root).isDirectory()) throw new Error('workspace directory required')
    } catch { root = undefined }
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected) || !root || clients.size + preparing >= 6) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return
    }
    preparing++
    try {
      const config = await resolveCoderLanguageConfig(root, options)
      if (!socket.destroyed) wss.handleUpgrade(request, socket, head, client => wss.emit('connection', client, root, config))
    } catch { socket.destroy() }
    finally { preparing-- }
  }
  wss.on('connection', (socket, root, { command, database, queryDrivers }) => {
    const args = ['--background-index', '--header-insertion=iwyu', '--pch-storage=memory', '--limit-results=40',
      ...(database ? [`--compile-commands-dir=${database}`] : []),
      ...(queryDrivers.length ? [`--query-driver=${queryDrivers.join(',')}`] : [])]
    const child = spawn(command, args, { cwd: root, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    clients.set(socket, child)
    let data = Buffer.alloc(0); let initialized = false; let initializeId
    const stop = () => {
      if (!clients.delete(socket)) return
      child.kill('SIGTERM')
      const timer = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL') }, 1000)
      timer.unref(); child.once('exit', () => clearTimeout(timer))
    }
    socket.on('close', stop)
    socket.on('error', stop)
    child.on('error', () => { socket.close(1011, 'clangd unavailable'); stop() })
    child.on('exit', () => { socket.close(1011, 'clangd stopped'); stop() })
    child.stdin.on('error', () => { socket.close(1011, 'clangd input closed'); stop() })
    // Drain diagnostics from stderr, but never mix them into the JSON-RPC stream.
    child.stderr.on('data', () => {})
    child.stdout.on('data', chunk => {
      data = Buffer.concat([data, chunk])
      if (data.length > MAX_BYTES) { socket.close(1009, 'language response too large'); stop(); return }
      for (;;) {
        const end = data.indexOf('\r\n\r\n'); if (end < 0) return
        const length = Number(/(?:^|\r\n)Content-Length:\s*(\d+)/i.exec(data.subarray(0, end).toString())?.[1])
        if (!Number.isSafeInteger(length) || length <= 0 || length > MAX_BYTES) { socket.close(1002, 'invalid language response'); stop(); return }
        if (data.length < end + 4 + length) return
        let message
        try { message = JSON.parse(data.subarray(end + 4, end + 4 + length).toString('utf8')) }
        catch { socket.close(1002, 'invalid language response'); stop(); return }
        if (message.id === initializeId && message.result?.capabilities) {
          message.result.capabilities.experimental = { ...message.result.capabilities.experimental, ailyCompilationDatabase: Boolean(database) }
        }
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message))
        data = data.subarray(end + 4 + length)
      }
    })
    socket.on('message', raw => {
      try {
        const message = JSON.parse(raw.toString())
        if (!initialized) {
          if (message.method !== 'initialize' || realpathSync(fileURLToPath(message.params?.rootUri)) !== root) throw new Error('workspace mismatch')
          initialized = true
          initializeId = message.id
        }
        const body = Buffer.from(JSON.stringify(message))
        child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`); child.stdin.write(body)
      } catch { socket.close(1008, 'invalid language request'); stop() }
    })
  })
  server.on('upgrade', onUpgrade)
  return {
    get activeCount() { return clients.size },
    async close() {
      server.off('upgrade', onUpgrade)
      for (const socket of clients.keys()) socket.terminate()
      await new Promise(resolve => wss.close(resolve))
    },
  }
}
