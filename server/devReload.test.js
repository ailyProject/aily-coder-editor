import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { activeDevReloadUrl } from './devReload.js'

test('dev reload is injected only while its local bus is reachable', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'aily-coder-reload-'))
  const markerPath = path.join(directory, '.aily-dev.json')
  const server = createServer((request, response) => {
    response.writeHead(request.url === '/health' ? 200 : 404)
    response.end()
  })
  t.after(() => rm(directory, { recursive: true, force: true }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const reloadUrl = `http://127.0.0.1:${port}/events`
  try {
    await writeFile(markerPath, JSON.stringify({ reloadUrl }))
    assert.equal(await activeDevReloadUrl(markerPath), reloadUrl)
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
  assert.equal(await activeDevReloadUrl(markerPath), '')
  await writeFile(markerPath, JSON.stringify({ reloadUrl: 'https://example.com/events' }))
  assert.equal(await activeDevReloadUrl(markerPath), '')
})
