import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import test from 'node:test'
import { WebSocket } from 'ws'
import { attachCoderAgentRpcServer } from './agentRpcServer.js'

async function listen(server) {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return server.address().port
}

async function closeServer(server) {
  if (!server.listening) return
  await new Promise(resolve => server.close(() => resolve()))
}

function nextJson(socket) {
  return once(socket, 'message').then(([data]) => JSON.parse(String(data)))
}

function nextJsonMessages(socket, count) {
  return new Promise(resolve => {
    const messages = []
    const onMessage = data => {
      messages.push(JSON.parse(String(data)))
      if (messages.length !== count) return
      socket.off('message', onMessage)
      resolve(messages)
    }
    socket.on('message', onMessage)
  })
}

function rejectedUpgradeStatus(port) {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1')
    let response = ''
    socket.setEncoding('utf8')
    socket.once('error', reject)
    socket.on('data', chunk => {
      response += chunk
      if (!response.includes('\r\n')) return
      socket.destroy()
      resolve(Number(response.match(/^HTTP\/1\.1 (\d{3})/u)?.[1] || 0))
    })
    socket.once('connect', () => {
      socket.write([
        'GET /ws?token=wrong HTTP/1.1',
        `Host: 127.0.0.1:${port}`,
        'Connection: Upgrade',
        'Upgrade: websocket',
        'Sec-WebSocket-Version: 13',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        '',
        '',
      ].join('\r\n'))
    })
  })
}

test('serves token-protected Aily child RPC on the shared HTTP server', async t => {
  const server = createServer((_request, response) => {
    response.writeHead(200)
    response.end('ok')
  })
  const rpc = attachCoderAgentRpcServer(server, {
    token: 'a'.repeat(64),
    router: {
      execute: async message => ({ method: message.method, workspaceRoot: message.context.workspaceRoot }),
    },
  })
  const port = await listen(server)
  t.after(async () => {
    await rpc.close()
    await closeServer(server)
  })

  assert.equal(await rejectedUpgradeStatus(port), 403)

  const socket = new WebSocket(`ws://127.0.0.1:${port}${rpc.wsPath}`)
  const readyMessage = nextJson(socket)
  await once(socket, 'open')
  const ready = await readyMessage
  assert.equal(ready.event, 'ready')

  socket.send(JSON.stringify({
    id: 'request-1',
    method: 'coder.library.arduino.search',
    params: { query: 'servo' },
    context: {
      actor: 'agent',
      actorId: 'subapp-agent-host',
      workspaceRoot: '/tmp/project',
      developmentMode: 'coder',
    },
  }))
  const result = await nextJson(socket)
  assert.equal(result.id, 'request-1')
  assert.equal(result.ok, true)
  assert.equal(result.result.workspaceRoot, '/tmp/project')
  socket.close()
})

test('cancels an active RPC request by request id', async t => {
  const server = createServer()
  const rpc = attachCoderAgentRpcServer(server, {
    token: 'b'.repeat(64),
    router: {
      execute: (_message, { signal }) => new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), {
          code: 'SUBAPP_RPC_CANCELLED',
        })), { once: true })
      }),
    },
  })
  const port = await listen(server)
  t.after(async () => {
    await rpc.close()
    await closeServer(server)
  })

  const socket = new WebSocket(`ws://127.0.0.1:${port}${rpc.wsPath}`)
  const readyMessage = nextJson(socket)
  await once(socket, 'open')
  await readyMessage
  const responseMessages = nextJsonMessages(socket, 2)
  socket.send(JSON.stringify({ id: 'slow', method: 'slow', params: {}, context: {} }))
  socket.send(JSON.stringify({
    id: 'cancel-slow',
    method: 'runtime.request.cancel',
    params: { requestId: 'slow' },
  }))

  const messages = await responseMessages
  const cancelled = messages.find(message => message.id === 'cancel-slow')
  const slow = messages.find(message => message.id === 'slow')
  assert.equal(cancelled.result.cancelled, true)
  assert.equal(slow.errorCode, 'SUBAPP_RPC_CANCELLED')
  socket.close()
})
