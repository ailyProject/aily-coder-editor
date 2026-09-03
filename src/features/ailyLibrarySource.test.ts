import assert from 'node:assert/strict'
import test from 'node:test'
import {
  classifyWorkspaceLibrarySource,
  iconForLibraryTreeSource
} from './ailyLibrarySource.js'

test('managed Aily and Arduino provenance wins over the Aily Chat package marker', () => {
  const packageJson = JSON.stringify({
    name: '@aily-project/lib-example',
    version: '1.0.0',
    source: 'aily-chat'
  })

  assert.equal(classifyWorkspaceLibrarySource({
    ailyReceipt: JSON.stringify({ source: 'blockly-library' }),
    packageJson
  }), 'aily')
  assert.equal(classifyWorkspaceLibrarySource({
    arduinoReceipt: JSON.stringify({ source: 'aily-coder-index' }),
    packageJson
  }), 'aily')
  assert.equal(classifyWorkspaceLibrarySource({
    arduinoReceipt: JSON.stringify({ source: 'arduino-library-manager' }),
    packageJson
  }), 'arduino')
  assert.equal(classifyWorkspaceLibrarySource({
    arduinoReceipt: JSON.stringify({ source: 'arduino-platform' }),
    packageJson
  }), 'arduino')
})

test('recognizes only the exact Aily Chat package source as a local generated library', () => {
  assert.equal(classifyWorkspaceLibrarySource({
    packageJson: JSON.stringify({
      name: '@aily-project/lib-local-sensor',
      version: '1.0.0',
      source: 'aily-chat'
    })
  }), 'aily-chat')
  assert.equal(classifyWorkspaceLibrarySource({
    packageJson: JSON.stringify({ source: 'other' })
  }), 'unknown')
})

test('uses unknown for copied, missing, or malformed library metadata', () => {
  assert.equal(classifyWorkspaceLibrarySource({}), 'unknown')
  assert.equal(classifyWorkspaceLibrarySource({ packageJson: '{invalid' }), 'unknown')
  assert.equal(classifyWorkspaceLibrarySource({
    ailyReceipt: '{invalid',
    arduinoReceipt: JSON.stringify({ source: 'unrecognized' }),
    packageJson: JSON.stringify({ name: 'copied-library', version: '1.0.0' })
  }), 'unknown')
})

test('maps every library source to a distinct tree icon', () => {
  assert.deepEqual({
    aily: iconForLibraryTreeSource('aily'),
    arduino: iconForLibraryTreeSource('arduino'),
    ailyChat: iconForLibraryTreeSource('aily-chat'),
    unknown: iconForLibraryTreeSource('unknown')
  }, {
    aily: 'sparkle',
    arduino: 'circuit-board',
    ailyChat: 'chat-sparkle',
    unknown: 'question'
  })
})
