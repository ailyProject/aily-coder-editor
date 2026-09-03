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
  workspaceRoot: '/tmp/aily-coder-editor-rpc-project',
  developmentMode: 'coder',
}

test('declares Coder ZIP install and remove as external workspace mutations', async () => {
  const manifest = JSON.parse(
    await readFile(new URL('../agent/tools.json', import.meta.url), 'utf8'),
  )

  for (const name of ['coder_library_install', 'coder_library_remove']) {
    const tool = manifest.tools.find(candidate => candidate.name === name)
    assert.equal(tool?.effects?.executionDomain, 'workspace-external-mutation')
  }
  const search = manifest.tools.find(candidate => candidate.name === 'coder_library_search')
  const remove = manifest.tools.find(candidate => candidate.name === 'coder_library_remove')
  assert.match(search?.description ?? '', /installedVersion/u)
  assert.match(search?.description ?? '', /managed/u)
  assert.match(remove?.description ?? '', /project-local managed receipt/u)
  assert.match(remove?.inputSchema?.properties?.version?.description ?? '', /installedVersion/u)
})

test('rejects a Coder library call outside Coder mode', async () => {
  const router = createCoderAgentRpcRouter({ install: async () => ({}) })
  await assert.rejects(
    router.execute({
      method: 'coder.library.install',
      params: { libraryRef: 'coder:0123456789abcdef01234567', version: '1.0.0' },
      context: { ...context, developmentMode: 'blockly' },
    }),
    error => error instanceof CoderAgentRpcError && error.code === 'CODER_MODE_REQUIRED',
  )
})

test('routes regional Coder searches and mutations by exact library reference', async () => {
  const calls = []
  const operation = name => async input => {
    calls.push({ name, input })
    return { libraryRef: input.libraryRef, sourcePath: '/private/source' }
  }
  const router = createCoderAgentRpcRouter({
    search: async () => ({
      tier: 'preferred',
      libraries: [{ libraryRef: 'coder:0123456789abcdef01234567', sourcePath: '/private/index' }],
    }),
    install: operation('install'),
    remove: operation('remove'),
  })

  const search = await router.execute({
    method: 'coder.library.search',
    params: { query: 'json' },
    context,
  })
  const install = await router.execute({
    method: 'coder.library.install',
    params: { libraryRef: 'coder:0123456789abcdef01234567', version: '1.0.0' },
    context,
  })
  const remove = await router.execute({
    method: 'coder.library.remove',
    params: { libraryRef: 'coder:0123456789abcdef01234567', version: '1.0.0' },
    context,
  })

  assert.equal(search.tier, 'preferred')
  assert.equal(search.libraries[0].sourcePath, undefined)
  assert.deepEqual(calls.map(call => call.name), ['install', 'remove'])
  assert.equal(calls[0].input.workspaceRoot, context.workspaceRoot)
  assert.equal(calls[0].input.libraryRef, 'coder:0123456789abcdef01234567')
  assert.equal(calls[0].input.version, '1.0.0')
  assert.equal(install.library.sourcePath, undefined)
  assert.equal(remove.library.sourcePath, undefined)
})

test('requires the authenticated generic host Agent context', async () => {
  const router = createCoderAgentRpcRouter({ install: async () => ({}) })
  await assert.rejects(
    router.execute({
      method: 'coder.library.install',
      params: { libraryRef: 'coder:0123456789abcdef01234567', version: '1.0.0' },
      context: { ...context, actorId: 'model-supplied' },
    }),
    error => error instanceof CoderAgentRpcError && error.code === 'SUBAPP_AGENT_CONTEXT_REQUIRED',
  )
})
