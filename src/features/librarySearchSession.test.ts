import assert from 'node:assert/strict'
import test from 'node:test'
import { LibrarySearchSession, libraryContextKey } from './librarySearchSession'

test('three startup replays share one search and ready uses the completed page', async () => {
  const session = new LibrarySearchSession<string[]>(); let calls = 0; let finish!: (value: string[]) => void
  const search = () => { calls++; return new Promise<string[]>(resolve => { finish = resolve }) }
  const pages = [session.load('project/query/0', search), session.load('project/query/0', search), session.load('project/query/0', search)]
  assert.equal(calls, 1); finish(['library'])
  assert.deepEqual(await Promise.all(pages), [['library'], ['library'], ['library']])
  assert.deepEqual(await session.load('project/query/0', search), ['library']); assert.equal(calls, 1)
  const refreshed = session.load('project/query/0', search, true); assert.equal(calls, 2); finish(['new']); await refreshed
})
test('failed requests can retry and query/project changes do not share pages', async () => {
  const session = new LibrarySearchSession<number>(); let calls = 0
  await assert.rejects(session.load('first', async () => { throw new Error('offline') }))
  assert.equal(await session.load('first', async () => ++calls), 1)
  assert.equal(await session.load('second', async () => ++calls), 2)
  session.invalidate(); assert.equal(await session.load('second', async () => ++calls), 3)
})
test('only catalog-relevant host changes refresh searches', () => {
  assert.equal(libraryContextKey({ v: 1, workspaceRoot: '/a', meta: { theme: 'dark' } }), libraryContextKey({ v: 1, workspaceRoot: '/a', meta: { theme: 'light' } }))
  assert.notEqual(libraryContextKey({ v: 1, workspaceRoot: '/a' }), libraryContextKey({ v: 1, workspaceRoot: '/b' }))
})
test('old project response cannot repopulate a newly invalidated search cache', async () => {
  const session = new LibrarySearchSession<string>(); let finish!: (value: string) => void
  const old = session.load('same-query', () => new Promise(resolve => { finish = resolve }))
  session.invalidate()
  assert.equal(await session.load('same-query', async () => 'new-project'), 'new-project')
  finish('old-project'); await old
  assert.equal(await session.load('same-query', async () => 'unexpected-request'), 'new-project')
})
