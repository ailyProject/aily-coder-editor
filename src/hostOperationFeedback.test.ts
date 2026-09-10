import assert from 'node:assert/strict'
import test from 'node:test'
import {
  HOST_LIBRARY_OPERATION_FEEDBACK_CHANNEL,
  reportHostLibraryOperationFeedback,
} from './hostOperationFeedback.js'

test('posts bounded library feedback to an embedding host', () => {
  const sent: Array<{ message: Record<string, unknown>; origin: string }> = []
  const parent = {
    postMessage: (message: unknown, origin: string) => sent.push({
      message: message as Record<string, unknown>,
      origin,
    }),
  }
  const host = { parent, postMessage: () => undefined }

  assert.equal(reportHostLibraryOperationFeedback({
    state: 'success',
    action: 'install',
    libraryName: '  Sensor library  ',
    command: `  npm install ${'x'.repeat(20_000)}  `,
  }, host), true)
  assert.equal(sent.length, 1)
  assert.equal(sent[0]?.origin, '*')
  assert.equal(sent[0]?.message.channel, HOST_LIBRARY_OPERATION_FEEDBACK_CHANNEL)
  assert.equal(sent[0]?.message.action, 'install')
  assert.equal(sent[0]?.message.libraryName, 'Sensor library')
  assert.equal(String(sent[0]?.message.command).length, 16_000)
})

test('does not post feedback outside an embedding host', () => {
  type StandaloneWindow = {
    parent?: StandaloneWindow
    postMessage(message: unknown, targetOrigin: string): void
  }
  const standalone: StandaloneWindow = { postMessage: () => undefined }
  standalone.parent = standalone

  assert.equal(reportHostLibraryOperationFeedback({
    state: 'loading',
    action: 'uninstall',
    libraryName: 'Sensor library',
    command: 'npm uninstall @aily-project-coder/lib-sensor',
  }, standalone), false)
})

test('rejects error feedback without diagnostic output', () => {
  const parent = { postMessage: () => undefined }
  const host = { parent, postMessage: () => undefined }

  assert.equal(reportHostLibraryOperationFeedback({
    state: 'error',
    action: 'install',
    libraryName: 'Sensor library',
    command: 'npm install @aily-project-coder/lib-sensor@1.2.3',
  }, host), false)
})
