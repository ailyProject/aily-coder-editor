import { Buffer } from 'node:buffer'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import process from 'node:process'
import { URL } from 'node:url'
import { WebSocket, WebSocketServer } from 'ws'
import {
  createCoderAgentRpcRouter,
  serializeCoderAgentRpcError,
} from './agentRpcRouter.js'

const MAX_MESSAGE_BYTES = 1024 * 1024

function createToken() {
  return randomBytes(32).toString('hex')
}

function tokensMatch(actual, expected) {
  const left = Buffer.from(String(actual ?? ''))
  const right = Buffer.from(expected)
  return left.length === right.length && timingSafeEqual(left, right)
}

function response(id, ok, result = {}, error) {
  return {
    id,
    ok,
    result,
    ...(error
      ? {
        error: error.message,
        errorCode: error.errorCode,
        ...(error.details !== undefined ? { details: error.details } : {}),
      }
      : {}),
  }
}

function send(socket, payload) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload))
}

export function attachCoderAgentRpcServer(httpServer, options = {}) {
  const token = options.token || createToken()
  const router = options.router ?? createCoderAgentRpcRouter()
  const clients = new Set()
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES })
  let closed = false

  const onUpgrade = (request, socket, head) => {
    let requestUrl
    try {
      requestUrl = new URL(request.url || '/', 'http://127.0.0.1')
    } catch {
      socket.destroy()
      return
    }
    if (requestUrl.pathname !== '/ws' || !tokensMatch(requestUrl.searchParams.get('token'), token)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    wss.handleUpgrade(request, socket, head, client => wss.emit('connection', client, request))
  }

  wss.on('connection', socket => {
    clients.add(socket)
    const activeRequests = new Map()
    send(socket, { event: 'ready', data: { pid: process.pid, protocolVersion: 1 } })

    socket.on('message', data => {
      void (async () => {
        let message
        try {
          message = JSON.parse(String(data))
        } catch {
          send(socket, response(undefined, false, {}, {
            message: 'Aily Coder Agent RPC message is not valid JSON',
            errorCode: 'SUBAPP_RPC_MESSAGE_INVALID',
          }))
          return
        }

        const id = message?.id
        const method = String(message?.method || '')
        if (method === 'runtime.request.cancel') {
          const requestId = String(message?.params?.requestId || '')
          const controller = activeRequests.get(requestId)
          controller?.abort()
          send(socket, response(id, true, { requestId, cancelled: Boolean(controller) }))
          return
        }

        const requestId = String(id ?? '')
        if (!requestId) {
          send(socket, response(id, false, {}, {
            message: 'Aily Coder Agent RPC request id is required',
            errorCode: 'SUBAPP_RPC_REQUEST_ID_REQUIRED',
          }))
          return
        }
        const controller = new globalThis.AbortController()
        activeRequests.set(requestId, controller)
        try {
          const result = await router.execute(message, { signal: controller.signal })
          send(socket, response(id, true, result))
        } catch (error) {
          const serialized = serializeCoderAgentRpcError(error)
          send(socket, response(id, false, {}, serialized))
        } finally {
          if (activeRequests.get(requestId) === controller) activeRequests.delete(requestId)
        }
      })()
    })

    socket.on('close', () => {
      for (const controller of activeRequests.values()) controller.abort()
      activeRequests.clear()
      clients.delete(socket)
    })
  })

  httpServer.on('upgrade', onUpgrade)

  return {
    token,
    wsPath: `/ws?token=${encodeURIComponent(token)}`,
    async close() {
      if (closed) return
      closed = true
      httpServer.off('upgrade', onUpgrade)
      for (const client of clients) {
        client.close(1001, 'Aily Coder Runtime stopped')
        client.terminate()
      }
      clients.clear()
      await new Promise(resolve => wss.close(() => resolve()))
    },
  }
}
