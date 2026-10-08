import { spawn } from 'node:child_process'
import { Buffer } from 'node:buffer'
import { timingSafeEqual } from 'node:crypto'
import { realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, URL } from 'node:url'
import { setTimeout, clearTimeout } from 'node:timers'
import { WebSocket, WebSocketServer } from 'ws'
import { resolveCoderLanguageConfig, resolveInoCompileCommand } from './languageServerConfig.js'
import { readLanguageFile } from './languageServerFiles.js'

const MAX_BYTES = 8 * 1024 * 1024

/** realpath keeps the requested drive-letter case on Windows, so `C:\` and `c:\` are the same workspace. */
export function sameWorkspace(left, right) {
  return path.relative(left, right) === ''
}

export function attachCoderLanguageServer(server, token, options = {}) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_BYTES })
  const clients = new Map()
  const preparingSockets = new Set()
  let closed = false
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
    preparingSockets.add(socket)
    try {
      const config = await resolveCoderLanguageConfig(root, options)
      if (!closed && !socket.destroyed) wss.handleUpgrade(request, socket, head, client => wss.emit('connection', client, root, config))
      else socket.destroy()
    } catch (error) {
      process.stderr.write(`[Coder LSP] Failed to prepare clangd: ${error.message}\n`)
      socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n')
    }
    finally { preparing--; preparingSockets.delete(socket) }
  }
  wss.on('connection', (socket, root, { command, database, compilationDatabase, queryDrivers, readableRoots = [root] }) => {
    const args = ['--background-index', '--header-insertion=iwyu', '--pch-storage=memory', '--limit-results=40',
      ...(database ? [`--compile-commands-dir=${database}`] : []),
      ...(queryDrivers.length ? [`--query-driver=${queryDrivers.join(',')}`] : [])]
    const child = spawn(command, args, { cwd: root, env: options.env || process.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    clients.set(socket, child)
    let data = Buffer.alloc(0); let initialized = false; let initializeId
    const implementations = new Map()
    const stop = () => {
      if (!clients.delete(socket)) return
      child.kill('SIGTERM')
      const timer = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL') }, 1000)
      timer.unref(); child.once('exit', () => clearTimeout(timer))
    }
    socket.on('close', stop)
    socket.on('error', stop)
    child.on('error', error => {
      process.stderr.write(`[Coder LSP] Cannot start ${command}: ${error.code || error.message}\n`)
      socket.close(1011, 'clangd unavailable'); stop()
    })
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
          message.result.capabilities.experimental = { ...message.result.capabilities.experimental, ailyCompilationDatabase: compilationDatabase, ailySourceFileAccess: true }
        }
        const implementation = implementations.get(message.id)
        if (implementation) {
          implementations.delete(message.id)
          // clangd's implementation request primarily finds subclasses and
          // virtual overrides. For a normal function, use its indexed body when
          // there are no overrides, keeping native nonempty results intact.
          if (!message.error && (!message.result || Array.isArray(message.result) && !message.result.length)) {
            send({ ...implementation, method: 'textDocument/definition' })
            data = data.subarray(end + 4 + length)
            continue
          }
        }
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message))
        data = data.subarray(end + 4 + length)
      }
    })
    const send = message => {
      const body = Buffer.from(JSON.stringify(message))
      child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`); child.stdin.write(body)
    }
    let forwarding = Promise.resolve()
    socket.on('message', raw => {
      // Keep didOpen/configuration/didChange ordered while reading build flags.
      forwarding = forwarding.then(async () => {
        if (!clients.has(socket)) return
        const message = JSON.parse(raw.toString())
        if (!initialized) {
          const requested = realpathSync(fileURLToPath(message.params?.rootUri))
          if (message.method !== 'initialize' || !sameWorkspace(requested, root)) throw new Error('workspace mismatch')
          initialized = true
          initializeId = message.id
        }
        if (message.method?.startsWith('aily/fs/')) {
          try {
            const result = await readLanguageFile(message.method, message.params, readableRoots)
            if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
          } catch (error) {
            if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32602, message: error.code === 'ENOENT' ? 'Source not found' : 'Source access denied' } }))
          }
          return
        }
        if (message.method === 'textDocument/implementation') implementations.set(message.id, message)
        if (message.method === 'textDocument/didOpen' && message.params?.textDocument?.uri?.startsWith('file:')) {
          const file = fileURLToPath(message.params.textDocument.uri)
          const command = await resolveInoCompileCommand(file, root, database)
          if (!clients.has(socket)) return
          if (command) send({ jsonrpc: '2.0', method: 'workspace/didChangeConfiguration', params: {
            settings: { compilationDatabaseChanges: { [file]: command } },
          } })
        }
        send(message)
      }).catch(() => { socket.close(1008, 'invalid language request'); stop() })
    })
  })
  server.on('upgrade', onUpgrade)
  return {
    get activeCount() { return clients.size },
    async close() {
      closed = true
      server.off('upgrade', onUpgrade)
      for (const socket of preparingSockets) socket.destroy()
      for (const socket of clients.keys()) socket.terminate()
      await new Promise(resolve => wss.close(resolve))
    },
  }
}
