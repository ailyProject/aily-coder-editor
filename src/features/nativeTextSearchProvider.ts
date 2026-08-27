import { getService } from '@codingame/monaco-vscode-api'
import { CancellationToken } from '@codingame/monaco-vscode-api/vscode/vs/base/common/cancellation'
import { URI } from '@codingame/monaco-vscode-api/vscode/vs/base/common/uri'
import {
  FileMatch,
  QueryGlobTester,
  SearchCompletionExitCode,
  SearchError,
  SearchErrorCode,
  SearchProviderType
} from '@codingame/monaco-vscode-api/vscode/vs/workbench/services/search/common/search'
import type {
  IFileQuery,
  IFolderQuery,
  ISearchComplete,
  ISearchProgressItem,
  ISearchResultProvider,
  ITextQuery,
  ITextSearchMatch
} from '@codingame/monaco-vscode-api/vscode/vs/workbench/services/search/common/search'
import { ISearchService } from '@codingame/monaco-vscode-api/vscode/vs/workbench/services/search/common/search.service'
import {
  cancelNativeTextSearch,
  hasNativeTextSearchCapability,
  searchNativeText
} from '../parentBackedNativeFs.js'
import type {
  NativeSearchRange,
  NativeTextSearchMatch
} from '../parentBackedNativeFs.js'
import {
  AILY_CODER_SEARCH_MAX_RESULTS,
  HOST_SEARCH_MAX_RESULTS,
  boundedPositiveInteger,
  createNativeTextSearchRequest,
  normalizeNativeSearchResultPath
} from './nativeTextSearchQuery.js'

let nativeSearchSequence = 0

function nextNativeSearchRequestId(): string {
  nativeSearchSequence += 1
  return `aily-coder-search-${Date.now().toString(36)}-${nativeSearchSequence.toString(36)}`
}

function isValidRange(range: NativeSearchRange | undefined): range is NativeSearchRange {
  if (range == null) return false
  const values = [
    range.startLineNumber,
    range.startColumn,
    range.endLineNumber,
    range.endColumn
  ]
  return values.every((value) => Number.isInteger(value) && value >= 0)
}

function toTextSearchMatch(match: NativeTextSearchMatch): ITextSearchMatch | undefined {
  if (
    typeof match.previewText !== 'string'
    || !isValidRange(match.sourceRange)
    || !isValidRange(match.previewRange)
  ) {
    return undefined
  }
  return {
    previewText: match.previewText,
    rangeLocations: [{
      source: match.sourceRange,
      preview: match.previewRange
    }]
  }
}

function basename(path: string): string {
  const index = path.lastIndexOf('/')
  return index < 0 ? path : path.slice(index + 1)
}

function groupNativeMatches(
  folderQuery: IFolderQuery,
  query: ITextQuery,
  nativeMatches: NativeTextSearchMatch[]
): { fileMatches: FileMatch[]; acceptedMatchCount: number } {
  const globTester = new QueryGlobTester(query, folderQuery)
  const fileMatchesByPath = new Map<string, FileMatch>()
  let acceptedMatchCount = 0

  for (const nativeMatch of nativeMatches) {
    const relativePath = normalizeNativeSearchResultPath(nativeMatch.file)
    if (relativePath == null || !globTester.includedInQuerySync(relativePath, basename(relativePath))) {
      continue
    }
    const textMatch = toTextSearchMatch(nativeMatch)
    if (textMatch == null) continue

    let fileMatch = fileMatchesByPath.get(relativePath)
    if (fileMatch == null) {
      fileMatch = new FileMatch(URI.joinPath(folderQuery.folder, ...relativePath.split('/')))
      fileMatchesByPath.set(relativePath, fileMatch)
    }
    fileMatch.results.push(textMatch)
    acceptedMatchCount += 1
  }

  return { fileMatches: [...fileMatchesByPath.values()], acceptedMatchCount }
}

class NativeTextSearchProvider implements ISearchResultProvider {
  async getAIName(): Promise<string | undefined> {
    return undefined
  }

  async textSearch(
    query: ITextQuery,
    onProgress?: (progress: ISearchProgressItem) => void,
    token?: CancellationToken
  ): Promise<ISearchComplete> {
    const configuredLimit = boundedPositiveInteger(
      query.maxResults,
      AILY_CODER_SEARCH_MAX_RESULTS,
      HOST_SEARCH_MAX_RESULTS
    )
    const fileMatches: FileMatch[] = []
    let remainingResults = configuredLimit
    let limitHit = false

    for (let folderIndex = 0; folderIndex < query.folderQueries.length; folderIndex += 1) {
      if (token?.isCancellationRequested) {
        return {
          results: fileMatches,
          limitHit,
          messages: [],
          exit: SearchCompletionExitCode.NewSearchStarted
        }
      }

      const folderQuery = query.folderQueries[folderIndex]
      if (folderQuery == null || folderQuery.folder.scheme !== 'file') continue
      const requestId = nextNativeSearchRequestId()
      const cancellation = token?.onCancellationRequested(() => {
        void cancelNativeTextSearch(requestId).catch(() => {})
      })

      try {
        const result = await searchNativeText(
          createNativeTextSearchRequest(query, folderQuery, requestId, remainingResults)
        )
        if (result.cancelled || token?.isCancellationRequested) {
          return {
            results: fileMatches,
            limitHit,
            messages: [],
            exit: SearchCompletionExitCode.NewSearchStarted
          }
        }
        if (!result.success) {
          throw new SearchError(
            result.error || 'Electron ripgrep search failed',
            SearchErrorCode.rgProcessError
          )
        }

        const grouped = groupNativeMatches(folderQuery, query, result.matches ?? [])
        fileMatches.push(...grouped.fileMatches)
        grouped.fileMatches.forEach((fileMatch) => onProgress?.(fileMatch))
        remainingResults = Math.max(0, remainingResults - grouped.acceptedMatchCount)
        limitHit ||= result.limitHit === true

        if (remainingResults === 0) {
          limitHit ||= folderIndex < query.folderQueries.length - 1
          break
        }
      } finally {
        cancellation?.dispose()
      }
    }

    return {
      results: fileMatches,
      limitHit,
      messages: [],
      stats: { type: 'textSearchProvider' },
      exit: SearchCompletionExitCode.Normal
    }
  }

  async fileSearch(_query: IFileQuery, _token?: CancellationToken): Promise<ISearchComplete> {
    return { results: [], limitHit: false, messages: [] }
  }

  async clearCache(_cacheKey: string): Promise<void> {}
}

/**
 * 只在新宿主声明原生搜索能力后替换文本 Provider。
 * 旧宿主或独立浏览器预览继续使用 @codingame 自带的浏览器 Provider。
 */
export async function installNativeTextSearchProvider(): Promise<boolean> {
  if (!(await hasNativeTextSearchCapability())) return false
  const searchService = await getService(ISearchService)
  searchService.registerSearchResultProvider(
    'file',
    SearchProviderType.text,
    new NativeTextSearchProvider()
  )
  return true
}
