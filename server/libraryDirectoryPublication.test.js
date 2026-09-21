import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { publishLibraryDirectory } from './libraryDirectoryPublication.js'

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aily-publish-library-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = path.join(root, 'staging'), target = path.join(root, 'src')
  await mkdir(source)
  await writeFile(path.join(source, 'Driver.h'), 'real source')
  return { source, target }
}

test('retries only publication on transient filesystem failures', async t => {
  const { source, target } = await fixture(t)
  const waits = [], codes = ['EPERM', 'EBUSY', 'EACCES']
  let calls = 0
  await publishLibraryDirectory(source, target, {
    renameDirectory: async (...args) => {
      const code = codes[calls++]
      if (code) throw Object.assign(new Error('unavailable'), { code })
      await rename(...args)
    },
    wait: async ms => { waits.push(ms) },
  })
  assert.equal(calls, 4)
  assert.deepEqual(waits, [80, 200, 500])
  assert.equal(await readFile(path.join(target, 'Driver.h'), 'utf8'), 'real source')
})

test('preserves the filesystem cause after a bounded retry budget', async t => {
  const { source, target } = await fixture(t)
  let calls = 0
  await assert.rejects(publishLibraryDirectory(source, target, {
    renameDirectory: async () => { calls++; throw Object.assign(new Error('denied'), { code: 'EPERM' }) },
    wait: async () => {},
  }), error => error.code === 'EPERM' && error.details.publication.attempts === 4
    && error.details.publication.automaticRetryExhausted)
  assert.equal(calls, 4)
  assert.equal(await readFile(path.join(source, 'Driver.h'), 'utf8'), 'real source')
})

test('does not retry unrelated errors or overwrite a competing destination', async t => {
  const { source, target } = await fixture(t)
  await assert.rejects(publishLibraryDirectory(source, target, {
    renameDirectory: async () => { throw Object.assign(new Error('no space'), { code: 'ENOSPC' }) },
    wait: async () => assert.fail('must not wait'),
  }), { code: 'ENOSPC' })
  let calls = 0
  await assert.rejects(publishLibraryDirectory(source, target, {
    renameDirectory: async () => { calls++; throw Object.assign(new Error('busy'), { code: 'EBUSY' }) },
    wait: async () => { await mkdir(target); await writeFile(path.join(target, 'Owner.h'), 'other writer') },
  }), { code: 'BLOCKLY_LIBRARY_PATH_CONFLICT' })
  assert.equal(calls, 1)
  assert.equal(await readFile(path.join(target, 'Owner.h'), 'utf8'), 'other writer')
})

test('cancellation interrupts backoff without publishing source', async t => {
  const { source, target } = await fixture(t)
  const controller = new globalThis.AbortController()
  let calls = 0
  await assert.rejects(publishLibraryDirectory(source, target, {
    signal: controller.signal,
    renameDirectory: async () => {
      calls++; controller.abort()
      throw Object.assign(new Error('busy'), { code: 'EBUSY' })
    },
  }), { name: 'AbortError' })
  assert.equal(calls, 1)
})
