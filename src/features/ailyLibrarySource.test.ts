import assert from 'node:assert/strict'
import test from 'node:test'
import {
  classifyWorkspaceLibrarySource,
  iconForLibraryTreeSource,
  packageLibraryRemovalTarget,
  workspaceLibraryRemovalTarget
} from './ailyLibrarySource.js'

test('library roots resolve exact package identities for both list sources', () => {
  assert.deepEqual(packageLibraryRemovalTarget('@aily-project/lib-servo'), {
    id: 'blockly:@aily-project/lib-servo', source: 'aily', query: '@aily-project/lib-servo'
  })
  assert.deepEqual(packageLibraryRemovalTarget('@aily-project-coder/lib-servo'), {
    id: 'coder:@aily-project-coder/lib-servo', source: 'registry', query: '@aily-project-coder/lib-servo'
  })
  assert.equal(packageLibraryRemovalTarget('@aily-project/board-servo'), undefined)
})

test('managed local roots use receipt identities rather than folder or display names', () => {
  assert.deepEqual(workspaceLibraryRemovalTarget({
    ailyReceipt: JSON.stringify({ source: 'blockly-library', packageName: '@aily-project/lib-servo' })
  }), packageLibraryRemovalTarget('@aily-project/lib-servo'))
  for (const [source, id, expectedSource] of [
    ['aily-coder-index', `coder:${'a'.repeat(24)}`, 'aily'],
    ['arduino-library-manager', 'arduino:Servo', 'registry']
  ]) {
    assert.deepEqual(workspaceLibraryRemovalTarget({
      arduinoReceipt: JSON.stringify({ source, libraryId: id, name: 'Servo Library' })
    }), { id, source: expectedSource, query: 'Servo Library' })
  }
  for (const receipt of [undefined, '{bad json', JSON.stringify({ source: 'aily-chat' }),
    JSON.stringify({ source: 'arduino-platform', libraryId: 'arduino:Servo', name: 'Servo' })]) {
    assert.equal(workspaceLibraryRemovalTarget({ arduinoReceipt: receipt }), undefined)
  }
})

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
    ailyReceipt: JSON.stringify({ source: 'blockly-library', packageName: '@aily-project-coder/lib-demo' }),
    packageJson
  }), 'arduino')
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

test('recognizes an npm library localized by Aily Chat', () => {
  assert.equal(classifyWorkspaceLibrarySource({
    localReceipt: JSON.stringify({
      source: 'aily-chat',
      sourcePackage: '@aily-project/lib-local-sensor'
    })
  }), 'aily-chat')
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
