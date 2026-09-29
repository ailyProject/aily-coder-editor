import type { Node } from 'web-tree-sitter'
import type { SourceSpan } from './types.js'

export interface FunctionSignature {
  fields: Record<'QUALIFIERS' | 'TYPE' | 'NAME' | 'PARAMETERS' | 'SUFFIX', string>
  spans: Record<'QUALIFIERS' | 'TYPE' | 'NAME' | 'PARAMETERS' | 'SUFFIX', SourceSpan>
}

/** Split only declarators whose spelling can be edited independently. */
export function functionSignature(node: Node, source: string): FunctionSignature | undefined {
  const type = node.childForFieldName('type')
  const body = node.childForFieldName('body')
  let declarator = node.childForFieldName('declarator')
  if (!type || !body || !declarator) return undefined
  while (declarator && (declarator.type === 'pointer_declarator' || declarator.type === 'reference_declarator')) declarator = declarator.childForFieldName('declarator') ?? declarator.namedChildren.at(-1) ?? null
  if (declarator?.type !== 'function_declarator') return undefined
  const name = declarator.childForFieldName('declarator')
  const parameters = declarator.childForFieldName('parameters')
  if (!name || !parameters || !['identifier', 'field_identifier', 'qualified_identifier'].includes(name.type)) return undefined
  const trim = (start: number, end: number): SourceSpan => {
    while (start < end && /\s/.test(source[start]!)) start++
    while (end > start && /\s/.test(source[end - 1]!)) end--
    return { start, end }
  }
  const spans = {
    QUALIFIERS: trim(node.startIndex, type.startIndex),
    TYPE: trim(type.startIndex, name.startIndex),
    NAME: { start: name.startIndex, end: name.endIndex },
    PARAMETERS: { start: parameters.startIndex + 1, end: parameters.endIndex - 1 },
    SUFFIX: trim(parameters.endIndex, body.startIndex)
  }
  if (Object.values(spans).some(span => /\/\*|\/\//.test(source.slice(span.start, span.end)))) return undefined
  const fields = Object.fromEntries(Object.entries(spans).map(([key, span]) => [key, source.slice(span.start, span.end)])) as FunctionSignature['fields']
  return { fields, spans }
}
