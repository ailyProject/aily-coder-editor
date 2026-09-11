import assert from 'node:assert/strict'
import test from 'node:test'
import { relatedSourcePaths } from './relatedSourcePaths'

test('discovers local C/C++ and TypeScript modules without widening package imports', () => {
  assert.deepEqual(relatedSourcePaths('/workspace/src/main.cpp', '#include "../include/Sensor.h"\n#include <vector>\n'), [
    '/workspace/include/Sensor.h',
  ])
  const paths = relatedSourcePaths('/workspace/src/main.ts', `
    import { Sensor } from './Sensor'
    export { Caller } from '../shared/Caller.js'
    const lazy = import('./lazy')
    const legacy = require('./legacy')
    import React from 'react'
  `)
  assert.ok(paths.includes('/workspace/src/Sensor.ts'))
  assert.ok(paths.includes('/workspace/shared/Caller.js'))
  assert.ok(paths.includes('/workspace/src/lazy/index.ts'))
  assert.ok(paths.includes('/workspace/src/legacy.js'))
  assert.ok(!paths.some(path => path.includes('react')))
})

test('discovers Python relative modules and never resolves beyond the filesystem root', () => {
  const paths = relatedSourcePaths('/workspace/pkg/views/main.py', `
    from .helpers import parse
    from ..models.sensor import Sensor
    from . import constants
    from external import ignored
  `)
  assert.ok(paths.includes('/workspace/pkg/views/helpers.py'))
  assert.ok(paths.includes('/workspace/pkg/models/sensor.py'))
  assert.ok(paths.includes('/workspace/pkg/views/constants.py'))
  assert.ok(!paths.some(path => path.includes('external')))
  assert.deepEqual(relatedSourcePaths('/main.ts', `import '../../../../secret'`), [])
})
