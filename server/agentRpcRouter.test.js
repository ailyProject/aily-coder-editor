import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { URL } from 'node:url'
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

test('declares package install and remove as external workspace mutations', async () => {
  const manifest = JSON.parse(
    await readFile(new URL('../agent/tools.json', import.meta.url), 'utf8'),
  )

  for (const name of ['coder_library_install', 'coder_library_remove']) {
    const tool = manifest.tools.find(candidate => candidate.name === name)
    assert.equal(tool?.effects?.executionDomain, 'workspace-external-mutation')
  }
})

test('rejects a Coder library call outside Coder mode', async () => {
  const router = createCoderAgentRpcRouter({ install: async () => ({}) })
  await assert.rejects(
    router.execute({
      method: 'coder.library.install',
      params: { libraryRef: 'blockly:@aily-project/lib-arduinojson' },
      context: { ...context, developmentMode: 'blockly' },
    }),
    error => error instanceof CoderAgentRpcError && error.code === 'CODER_MODE_REQUIRED',
  )
})

test('routes unified searches and mutations by exact library reference', async () => {
  const calls = []
  const operation = name => async input => {
    calls.push({ name, input })
    return { libraryRef: input.libraryRef, sourcePath: '/private/source' }
  }
  const router = createCoderAgentRpcRouter({
    search: async input => ({
      tier: input.candidates ? 'candidate' : 'preferred',
      libraries: [{ libraryRef: 'blockly:@aily-project/lib-arduinojson', sourcePath: '/private/index' }],
    }),
    install: operation('install'),
    remove: operation('remove'),
  })

  const search = await router.execute({
    method: 'coder.library.search',
    params: { query: 'json', candidates: false },
    context,
  })
  const install = await router.execute({
    method: 'coder.library.install',
    params: { libraryRef: 'blockly:@aily-project/lib-arduinojson', version: '1.0.0' },
    context,
  })
  const remove = await router.execute({
    method: 'coder.library.remove',
    params: { libraryRef: 'blockly:@aily-project/lib-arduinojson', version: '1.0.0' },
    context,
  })

  assert.equal(search.tier, 'preferred')
  assert.equal(search.libraries[0].sourcePath, undefined)
  assert.deepEqual(calls.map(call => call.name), ['install', 'remove'])
  assert.equal(calls[0].input.workspaceRoot, context.workspaceRoot)
  assert.equal(calls[0].input.libraryRef, 'blockly:@aily-project/lib-arduinojson')
  assert.equal(calls[0].input.version, '1.0.0')
  assert.equal(install.library.sourcePath, undefined)
  assert.equal(remove.library.sourcePath, undefined)
})

test('requires the authenticated generic host Agent context', async () => {
  const router = createCoderAgentRpcRouter({ install: async () => ({}) })
  await assert.rejects(
    router.execute({
      method: 'coder.library.install',
      params: { libraryRef: 'blockly:@aily-project/lib-arduinojson' },
      context: { ...context, actorId: 'model-supplied' },
    }),
    error => error instanceof CoderAgentRpcError && error.code === 'SUBAPP_AGENT_CONTEXT_REQUIRED',
  )
})
