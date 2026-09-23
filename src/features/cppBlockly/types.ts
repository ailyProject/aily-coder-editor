export interface PreviewBlock {
  type: string
  id: string
  fields?: Record<string, string>
  inputs?: Record<string, { block: PreviewBlock }>
  next?: { block: PreviewBlock }
  extraState?: { count: number }
  x?: number
  y?: number
}

export interface SourceLocation {
  line: number
  column: number
  endLine: number
  endColumn: number
  text: string
}

export interface PreviewDiagnostic extends SourceLocation {
  severity: 'error' | 'preserved'
  message: string
}

export interface CppPreview {
  status: 'ready' | 'partial' | 'error'
  blocks: { languageVersion: 0; blocks: PreviewBlock[] }
  locations: Record<string, SourceLocation>
  diagnostics: PreviewDiagnostic[]
  blockCount: number
  preservedCount: number
  dataCount?: number
}

export const MAX_SOURCE_LENGTH = 200_000
export const MAX_BLOCKS = 2_000

export function isCppPreviewFile(path: string): boolean {
  return /\.(cpp|cc|cxx|ino|h|hpp|hh|hxx)$/i.test(path)
}

export function previewError(message: string): CppPreview {
  return {
    status: 'error', blocks: { languageVersion: 0, blocks: [] }, locations: {},
    diagnostics: [{ severity: 'error', message, line: 1, column: 1, endLine: 1, endColumn: 1, text: '' }],
    blockCount: 0, preservedCount: 0
  }
}
