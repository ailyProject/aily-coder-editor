/**
 * WebSocket ⇄ stdin/stdout：把浏览器里的 LSP JSON-RPC 桥到本机任意支持 stdio 的语言服务器。
 *
 * 用法：
 *   npm run lsp-proxy
 *   npm run lsp-proxy -- --compile-commands-dir=/path/to/build   # 传给子进程的可选参数
 *
 * 环境变量：
 *   LSP_WS_HOST（兼容 CLANGD_WS_HOST）默认 0.0.0.0
 *   LSP_WS_PORT（兼容 CLANGD_WS_PORT）默认 3030
 *   LSP_SERVER_COMMAND 可执行文件，默认 clangd
 *   LSP_SERVER_LABEL 日志里的名称，默认可执行文件名
 *
 * 前端 URL：`lspWs` / `lspWsPort`；仍兼容 `clangdWs` / `clangdWsPort`。
 */
import * as http from 'node:http'
import * as path from 'node:path'
import { WebSocketServer, type RawData, type WebSocket as NodeWebSocket } from 'ws'
import {
  createWebSocketConnection,
  createServerProcess,
  forward
} from 'vscode-ws-jsonrpc/server'

import type { IWebSocket } from 'vscode-ws-jsonrpc/socket'

const portArg = Number.parseInt(
  process.env.LSP_WS_PORT ?? process.env.CLANGD_WS_PORT ?? '',
  10
)
const port = Number.isFinite(portArg) && portArg > 0 ? portArg : 3030
const bindHost =
  process.env.LSP_WS_HOST ?? process.env.CLANGD_WS_HOST ?? '0.0.0.0'

const serverCommand =
  process.env.LSP_SERVER_COMMAND?.trim() || 'clangd'
const serverLabel =
  process.env.LSP_SERVER_LABEL?.trim() ||
  path.basename(serverCommand, path.extname(serverCommand))

const serverArgv = (() => {
  const sep = process.argv.indexOf('--')
  if (sep !== -1) {
    return process.argv.slice(sep + 1)
  }
  return []
})()

function nodeWsToRwSocket(ws: NodeWebSocket): IWebSocket {
  return {
    send: (content: string) => {
      ws.send(content)
    },
    onMessage: (cb: (message: unknown) => void) => {
      ws.on('message', (data: RawData) => {
        cb(typeof data === 'string' ? data : data.toString('utf8'))
      })
    },
    onError: (cb: (reason: unknown) => void) => {
      ws.on('error', cb)
    },
    onClose: (cb: (code: number, reason: string) => void) => {
      ws.on('close', (code, reason) => {
        cb(code, reason.toString('utf8'))
      })
    },
    dispose: () => {
      ws.close()
    }
  }
}

const httpServer = http.createServer()
const wss = new WebSocketServer({ server: httpServer })

wss.on('connection', (socket) => {
  const lsp = createServerProcess(serverLabel, serverCommand, serverArgv, {
    cwd: process.cwd(),
    env: process.env
  })

  if (lsp === undefined) {
    socket.close(1011, 'language server stdio unavailable')
    return
  }

  const socketConn = createWebSocketConnection(nodeWsToRwSocket(socket))
  forward(socketConn, lsp)

  socket.on('close', () => {
    lsp.dispose()
  })
})

httpServer.listen(port, bindHost, () => {
  const human =
    bindHost === '0.0.0.0' ? `ws://127.0.0.1:${port} (listen ${bindHost})` : `ws://${bindHost}:${port}`
  console.log(
    `LSP WebSocket proxy (${serverLabel} ← ${serverCommand}) listening on ${human}`
  )
})
