import assert from 'node:assert/strict'
import test from 'node:test'
import { URI } from '@codingame/monaco-vscode-api/vscode/vs/base/common/uri'
import { captureDroppedEntries, isFileTransfer, resolveAilyDropDirectory } from './fileDrop.js'

test('captures files and directory handles before the native transfer becomes protected', async () => {
  const directory = { name: '目录', isDirectory: true, isFile: false } as FileSystemDirectoryEntry
  const file = new File([new Uint8Array([0, 255, 128, 13])], '图像.bin')
  const transfer = {
    types: ['Files'],
    items: [
      { kind: 'file', webkitGetAsEntry: () => directory },
      { kind: 'string', getAsFile: () => { throw new Error('not a file') } },
      { kind: 'file', webkitGetAsEntry: () => null, getAsFile: () => file }
    ],
    files: [file]
  }
  const entries = captureDroppedEntries(transfer as unknown as DataTransfer)
  transfer.items.length = 0
  transfer.files.length = 0
  assert.equal(entries.length, 2)
  assert.equal(entries[0], directory)
  const capturedFile = await new Promise<File>(resolve => (entries[1] as FileSystemFileEntry).file(resolve))
  assert.deepEqual(new Uint8Array(await capturedFile.arrayBuffer()), new Uint8Array([0, 255, 128, 13]))
})

test('supports a FileList fallback and rejects text-only drags', () => {
  const file = new File(['hello'], 'a.txt')
  const transfer = { types: ['Files'], items: [], files: [file] } as unknown as DataTransfer
  assert.equal(captureDroppedEntries(transfer)[0]?.name, 'a.txt')
  assert.equal(isFileTransfer(transfer), true)
  assert.equal(isFileTransfer({ types: ['text/plain'] } as unknown as DataTransfer), false)
  assert.equal(isFileTransfer(null), false)
})

test('resolves Aily View blank space, folders, files and virtual groups to disk directories', () => {
  const root = URI.file('/work/project')
  assert.equal(resolveAilyDropDirectory(root)?.path, '/work/project/sketch/src')
  assert.equal(resolveAilyDropDirectory(root, { contextValue: 'aily.group:config' })?.path, '/work/project')
  assert.equal(resolveAilyDropDirectory(root, { contextValue: 'aily.status:component-libraries-empty' })?.path,
    '/work/project/sketch/libraries')
  assert.equal(resolveAilyDropDirectory(root, {
    contextValue: 'aily.directory:fs-deep', resourceUri: URI.joinPath(root, 'sketch/src/deep')
  })?.path, '/work/project/sketch/src/deep')
  assert.equal(resolveAilyDropDirectory(root, {
    contextValue: 'aily.file:fs-main', resourceUri: URI.joinPath(root, 'sketch/src/deep/main.cpp')
  })?.path, '/work/project/sketch/src/deep')
})

test('rejects unrelated virtual nodes and paths outside the workspace', () => {
  const root = URI.file('/work/project')
  for (const resourceUri of [URI.file('/work/project-other/src'), URI.file('/work/global-sdk'), URI.parse('https://example.com/work/project')]) {
    assert.equal(resolveAilyDropDirectory(root, { contextValue: 'aily.directory:fs-lib', resourceUri }), undefined)
  }
  assert.equal(resolveAilyDropDirectory(root, { contextValue: 'aily.property:board' }), undefined)
  assert.equal(resolveAilyDropDirectory(root, {
    contextValue: 'aily.virtual-file:artifact', resourceUri: URI.joinPath(root, 'output.bin')
  }), undefined)
})

test('uses case-insensitive workspace boundaries for Windows drive paths', () => {
  const root = URI.file('C:/Work/Project')
  assert.equal(resolveAilyDropDirectory(root, {
    contextValue: 'aily.directory:fs-src', resourceUri: URI.file('c:/work/project/sketch/src')
  })?.path.toLowerCase(), '/c:/work/project/sketch/src')
  assert.equal(resolveAilyDropDirectory(root, {
    contextValue: 'aily.directory:fs-src', resourceUri: URI.file('C:/Work/Project-two/sketch/src')
  }), undefined)
})
