import type { CppPreview, PreviewBlock, SourceLocation, SourceSpan } from './types.js'

function position(source: string, offset: number): { line: number; column: number } {
  const before = source.slice(0, offset)
  const line = (before.match(/\n/g) ?? []).length + 1
  return { line, column: offset - before.lastIndexOf('\n') }
}

export function sourceSpanLocation(source: string, span: SourceSpan): SourceLocation {
  const endOffset = span.end === span.start ? Math.min(source.length, span.end + 1) : span.end
  const start = position(source, span.start), end = position(source, endOffset)
  return { line: start.line, column: start.column, endLine: end.line, endColumn: end.column, text: source.slice(span.start, endOffset), precise: true }
}

export function fieldSourceLocation(source: string, preview: CppPreview, blockId: string, fieldName: string): SourceLocation | undefined {
  const fields = preview.recipes?.[blockId]?.fields
  let span = fields?.[fieldName] ?? (['LIBRARY', 'METHOD', 'RECEIVER'].includes(fieldName) ? fields?.NAME : undefined)
  if (span && (fieldName === 'METHOD' || fieldName === 'RECEIVER')) {
    const name = source.slice(span.start, span.end), dot = name.lastIndexOf('.')
    if (dot >= 0) span = fieldName === 'METHOD' ? { start: span.start + dot + 1, end: span.end } : { start: span.start, end: span.start + dot }
  }
  return span ? sourceSpanLocation(source, span) : preview.locations[blockId]
}

/** Match draft structure to the freshly parsed code; parser IDs shift after insertions. */
export function parsedBlockId(draft: PreviewBlock[], parsed: PreviewBlock[], id: string): string | undefined {
  const sequence = (roots: PreviewBlock[]): PreviewBlock[] => roots.flatMap(root => {
    const blocks: PreviewBlock[] = []
    for (let block: PreviewBlock | undefined = root; block; block = block.next?.block) blocks.push(block)
    return blocks
  })
  const current = sequence(draft), generated = sequence(parsed)
  for (let index = 0; index < current.length; index++) {
    const block = current[index]!, counterpart = generated[index]
    if (!counterpart) continue
    if (block.id === id) return counterpart.id
    for (const [name, input] of Object.entries(block.inputs ?? {})) {
      const target = counterpart.inputs?.[name]?.block
      if (target) {
        const found = parsedBlockId([input.block], [target], id)
        if (found) return found
      }
    }
  }
  return undefined
}
