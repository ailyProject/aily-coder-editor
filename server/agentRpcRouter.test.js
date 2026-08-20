import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CoderAgentRpcError,
  createCoderAgentRpcRouter,
} from './agentRpcRouter.js'

const context = {
  actor: 'agent',
  actorId: 'subapp-agent-host',
  workspaceRoot: '/tmp/aily-coder-rpc-project',
  developmentMode: 'coder',
}

test('routes official Arduino searches with host-injected workspace context', async () => {
  let received
  const router = createCoderAgentRpcRouter({
    search: async input => {
      received = input
      return {
        total: 1,
        offset: input.offset,
        limit: input.limit,
        stale: false,
        libraries: [{ id: 'arduino:servo', name: 'Servo', sourcePath: '/private/sdk/Servo' }],
      }
    },
  })

  const result = await router.execute({
    method: 'coder.library.arduino.search',
    params: { query: 'servo', limit: 500 },
    context,
  })

  assert.equal(received.workspaceRoot, context.workspaceRoot)
  assert.equal(received.query, 'servo')
  assert.equal(received.limit, 50)
  assert.equal(result.ok, true)
  assert.equal(result.libraries[0].sourcePath, undefined)
})

test('rejects a Coder library call outside Coder mode', async () => {
  const router = createCoderAgentRpcRouter({ search: async () => ({ libraries: [] }) })
  await assert.rejects(
    router.execute({
      method: 'coder.library.arduino.search',
      params: {},
      context: { ...context, developmentMode: 'blockly' },
    }),
    error => error instanceof CoderAgentRpcError && error.code === 'CODER_MODE_REQUIRED',
  )
})

test('routes install and remove by opaque id and exact version only', async () => {
  const calls = []
  const operation = name => async input => {
    calls.push({ name, input })
    return { id: input.libraryId, version: input.version, sourcePath: '/private/source' }
  }
  const router = createCoderAgentRpcRouter({
    install: operation('install'),
    remove: operation('remove'),
  })

  const install = await router.execute({
    method: 'coder.library.arduino.install',
    params: { libraryId: 'arduino:servo', version: '1.2.0' },
    context,
  })
  const remove = await router.execute({
    method: 'coder.library.arduino.remove',
    params: { libraryId: 'arduino:servo', version: '1.2.0' },
    context,
  })

  assert.deepEqual(calls.map(call => call.name), ['install', 'remove'])
  assert.equal(calls[0].input.workspaceRoot, context.workspaceRoot)
  assert.equal(install.library.sourcePath, undefined)
  assert.equal(remove.library.sourcePath, undefined)
})

test('requires the authenticated generic host Agent context', async () => {
  const router = createCoderAgentRpcRouter({ search: async () => ({ libraries: [] }) })
  await assert.rejects(
    router.execute({
      method: 'coder.library.arduino.search',
      params: {},
      context: { ...context, actorId: 'model-supplied' },
    }),
    error => error instanceof CoderAgentRpcError && error.code === 'SUBAPP_AGENT_CONTEXT_REQUIRED',
  )
})
