import assert from 'node:assert/strict'
import test from 'node:test'
import {
  NODE_MODULES_GLOB,
  showNodeModulesInExplorer
} from './coderDirectoryVisibility.js'

test('removes the legacy Explorer exclusion without changing Search exclusions', () => {
  const searchExclude = {
    [NODE_MODULES_GLOB]: true,
    '**/.build': true
  }
  const result = showNodeModulesInExplorer({
    'files.exclude': {
      [NODE_MODULES_GLOB]: true,
      '**/.aily': true
    },
    'search.exclude': searchExclude,
    'search.searchOnType': true
  })

  assert.equal(result.changed, true)
  assert.deepEqual(result.configuration['files.exclude'], {
    '**/.aily': true
  })
  assert.equal(result.configuration['search.exclude'], searchExclude)
  assert.equal(result.configuration['search.searchOnType'], true)
})

test('preserves an explicit visible setting and configurations without the legacy value', () => {
  const visibleConfiguration = {
    'files.exclude': {
      [NODE_MODULES_GLOB]: false
    }
  }
  const visibleResult = showNodeModulesInExplorer(visibleConfiguration)
  assert.equal(visibleResult.changed, false)
  assert.equal(visibleResult.configuration, visibleConfiguration)

  const emptyConfiguration = { 'search.exclude': { [NODE_MODULES_GLOB]: true } }
  const emptyResult = showNodeModulesInExplorer(emptyConfiguration)
  assert.equal(emptyResult.changed, false)
  assert.equal(emptyResult.configuration, emptyConfiguration)
})
