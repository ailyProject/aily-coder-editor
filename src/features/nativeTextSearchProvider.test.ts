import assert from 'node:assert/strict'
import test from 'node:test'
import { URI } from '@codingame/monaco-vscode-api/vscode/vs/base/common/uri'
import type {
  IFolderQuery,
  QueryType,
  ITextQuery
} from '@codingame/monaco-vscode-api/vscode/vs/workbench/services/search/common/search'
import {
  createNativeTextSearchRequest,
  enabledGlobPatterns,
  normalizeNativeSearchResultPath
} from './nativeTextSearchQuery.js'

test('keeps only enabled glob patterns and respects later overrides', () => {
  assert.deepEqual(
    enabledGlobPatterns(
      { '**/*.cpp': true, '**/*.json': true },
      { '**/*.json': false, '**/*.h': true }
    ),
    ['**/*.cpp', '**/*.h']
  )
})

test('rejects absolute and traversal paths returned by the host', () => {
  assert.equal(normalizeNativeSearchResultPath('./sketch/src/main.cpp'), 'sketch/src/main.cpp')
  assert.equal(normalizeNativeSearchResultPath('sketch\\src\\main.cpp'), 'sketch/src/main.cpp')
  assert.equal(normalizeNativeSearchResultPath('../outside.cpp'), undefined)
  assert.equal(normalizeNativeSearchResultPath('/tmp/outside.cpp'), undefined)
  assert.equal(normalizeNativeSearchResultPath('C:/outside.cpp'), undefined)
})

test('maps VS Code text query semantics into the bounded native search request', () => {
  const folderQuery: IFolderQuery = {
    folder: URI.file('/workspace/demo'),
    includePattern: { '**/*.cpp': true },
    excludePattern: [{ pattern: { '**/generated/**': true } }],
    disregardIgnoreFiles: false
  }
  const query: ITextQuery = {
    type: 2 as QueryType.Text,
    folderQueries: [folderQuery],
    contentPattern: {
      pattern: 'c+',
      isRegExp: true,
      isCaseSensitive: true,
      isWordMatch: true,
      isMultiline: true
    },
    includePattern: { '**/sketch/**': true },
    excludePattern: { '**/.build/**': true },
    previewOptions: { matchLines: 1, charsPerLine: 9000 },
    maxFileSize: 100 * 1024 * 1024,
    usePCRE2: true
  }

  const request = createNativeTextSearchRequest(query, folderQuery, 'search-1', 5000)

  assert.equal(request.workspaceRoot, '/workspace/demo')
  assert.equal(request.pattern, 'c+')
  assert.equal(request.isRegex, true)
  assert.equal(request.isCaseSensitive, true)
  assert.equal(request.isWordMatch, true)
  assert.equal(request.isMultiline, true)
  assert.equal(request.usePCRE2, true)
  assert.equal(request.maxResults, 1000)
  assert.equal(request.maxLineLength, 2000)
  assert.equal(request.maxFileSize, 20 * 1024 * 1024)
  assert.deepEqual(request.includeGlobs.sort(), ['**/*.cpp', '**/sketch/**'])
  assert.deepEqual(request.excludeGlobs.sort(), ['**/.build/**', '**/generated/**'])
})
