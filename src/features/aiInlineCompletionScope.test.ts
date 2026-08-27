import assert from 'node:assert/strict'
import test from 'node:test'
import { isFileInlineCompletionDocument } from './aiInlineCompletionScope'

test('allows normal file editor documents', () => {
  assert.equal(
    isFileInlineCompletionDocument({ uri: { scheme: 'file' }, languageId: 'cpp' }),
    true
  )
  assert.equal(
    isFileInlineCompletionDocument({ uri: { scheme: 'file' }, languageId: 'plaintext' }),
    true
  )
})

test('rejects SCM input and non-file virtual documents', () => {
  assert.equal(
    isFileInlineCompletionDocument({ uri: { scheme: 'vscode-scm' }, languageId: 'scminput' }),
    false
  )
  assert.equal(
    isFileInlineCompletionDocument({ uri: { scheme: 'aily-git-revision' }, languageId: 'cpp' }),
    false
  )
  assert.equal(
    isFileInlineCompletionDocument({ uri: { scheme: 'untitled' }, languageId: 'cpp' }),
    false
  )
})
