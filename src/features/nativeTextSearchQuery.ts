import type {
  IFolderQuery,
  ITextQuery
} from '@codingame/monaco-vscode-api/vscode/vs/workbench/services/search/common/search'
import type { NativeTextSearchRequest } from '../parentBackedNativeFs.js'

export const AILY_CODER_EDITOR_SEARCH_MAX_RESULTS = 500
export const HOST_SEARCH_MAX_RESULTS = 1000
const DEFAULT_SEARCH_FILE_SIZE = 10 * 1024 * 1024
const HOST_SEARCH_MAX_FILE_SIZE = 20 * 1024 * 1024
const DEFAULT_PREVIEW_LENGTH = 500
const HOST_MAX_PREVIEW_LENGTH = 2000

export function boundedPositiveInteger(
  value: unknown,
  fallback: number,
  maximum: number
): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.min(maximum, Math.max(1, Math.trunc(parsed)))
}

export function enabledGlobPatterns(
  ...expressions: Array<Record<string, unknown> | undefined>
): string[] {
  const merged: Record<string, unknown> = {}
  for (const expression of expressions) {
    if (expression != null) Object.assign(merged, expression)
  }
  return Object.entries(merged)
    .filter(([, enabled]) => enabled === true)
    .map(([pattern]) => pattern)
}

export function normalizeNativeSearchResultPath(file: string): string | undefined {
  const normalized = file.trim().replace(/\\/g, '/').replace(/^\.\/+/, '')
  if (
    !normalized
    || normalized.startsWith('/')
    || /^[a-zA-Z]:\//.test(normalized)
    || normalized.split('/').some((segment) => segment === '..')
    || normalized.includes('\0')
  ) {
    return undefined
  }
  return normalized
}

function folderExcludePatterns(query: ITextQuery, folderQuery: IFolderQuery): string[] {
  const folderExpressions = folderQuery.excludePattern?.map((entry) => entry.pattern) ?? []
  if (folderExpressions.length === 0) {
    return enabledGlobPatterns(query.excludePattern)
  }
  const patterns = new Set<string>()
  for (const expression of folderExpressions) {
    for (const pattern of enabledGlobPatterns(query.excludePattern, expression)) {
      patterns.add(pattern)
    }
  }
  return [...patterns]
}

export function createNativeTextSearchRequest(
  query: ITextQuery,
  folderQuery: IFolderQuery,
  requestId: string,
  maxResults: number
): NativeTextSearchRequest {
  return {
    requestId,
    workspaceRoot: folderQuery.folder.fsPath,
    pattern: query.contentPattern.pattern,
    isRegex: query.contentPattern.isRegExp === true,
    isCaseSensitive: query.contentPattern.isCaseSensitive === true,
    isWordMatch: query.contentPattern.isWordMatch === true,
    isMultiline: query.contentPattern.isMultiline === true,
    usePCRE2: query.usePCRE2 === true,
    includeIgnoredFiles: (
      query.userDisabledExcludesAndIgnoreFiles === true
      || folderQuery.disregardIgnoreFiles === true
    ),
    includeHidden: true,
    includeGlobs: enabledGlobPatterns(query.includePattern, folderQuery.includePattern),
    excludeGlobs: folderExcludePatterns(query, folderQuery),
    maxResults: boundedPositiveInteger(maxResults, AILY_CODER_EDITOR_SEARCH_MAX_RESULTS, HOST_SEARCH_MAX_RESULTS),
    maxLineLength: boundedPositiveInteger(
      query.previewOptions?.charsPerLine,
      DEFAULT_PREVIEW_LENGTH,
      HOST_MAX_PREVIEW_LENGTH
    ),
    maxFileSize: boundedPositiveInteger(
      query.maxFileSize,
      DEFAULT_SEARCH_FILE_SIZE,
      HOST_SEARCH_MAX_FILE_SIZE
    )
  }
}
