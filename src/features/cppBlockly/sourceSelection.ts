import type { SourceLocation } from './types.js'

export interface SourcePosition { line: number; column: number }

/** Prefer the innermost source span, falling back to the focused line for indent. */
export function blockAtPosition(locations: Record<string, SourceLocation>, position: SourcePosition): string | undefined {
  const onLine = Object.entries(locations).filter(([, span]) => position.line >= span.line && position.line <= span.endLine)
  const height = (span: SourceLocation): number => span.endLine - span.line
  const minimumHeight = Math.min(...onLine.map(([, span]) => height(span)))
  const local = onLine.filter(([, span]) => height(span) === minimumHeight)
  const exact = local.filter(([, span]) =>
    (position.line > span.line || position.column >= span.column) &&
    (position.line < span.endLine || position.column < span.endColumn))
  return (exact.length ? exact : local).sort(([, a], [, b]) =>
    (exact.length ? 0 : Math.abs(a.column - position.column) - Math.abs(b.column - position.column)) || a.text.length - b.text.length)[0]?.[0]
}
