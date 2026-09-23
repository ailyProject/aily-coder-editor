import type { Node } from 'web-tree-sitter'
import type { CppPreview, PreviewBlock, SourceRecipe, SourceSlot, SourceSpan } from './types.js'

// Recipes describe editable slots in the ORIGINAL source, including whitespace,
// delimiters and comments. They are separate from the lossy visual layout.
export function attachSourceRecipes(result: CppPreview, source: string, nodes: Map<string, Node>): void {
  const recipes: Record<string, SourceRecipe> = result.recipes = {}
  const origin = crypto.randomUUID()
  const span = (n: Node): SourceSpan => ({ start: n.startIndex, end: n.endIndex })
  const trim = (start: number, end: number): SourceSpan => {
    while (start < end && /\s/.test(source[start]!)) start++
    while (end > start && /\s/.test(source[end - 1]!)) end--
    return { start, end }
  }
  const visit = (b: PreviewBlock): void => {
    const n = nodes.get(b.id)!
    b.data = `${origin}:${b.id}`
    const r: SourceRecipe = { ...span(n), syntax: n.type, fields: {}, inputs: {} }
    recipes[b.id] = r
    if (n.type === 'access_specifier' && n.nextSibling?.type === ':') r.end = n.nextSibling.endIndex
    if (['class_specifier', 'struct_specifier', 'union_specifier', 'enum_specifier'].includes(n.type) && n.nextSibling?.type === ';') r.end = n.nextSibling.endIndex
    for (const child of Object.values(b.inputs ?? {})) visit(child.block)
    if (b.next) visit(b.next.block)
    const type = b.type.replace('cpp_preview_', '')
    const field = (name: string): Node | null => n.childForFieldName(name)
    const content = field('body')
    const bodySlot = (node: Node): SourceSlot => node.type === 'compound_statement'
      ? { start: node.startIndex + 1, end: node.endIndex - 1, kind: 'sequence' }
      : { ...span(node), kind: 'body' }
    // Values occupy exactly their expression, never the following semicolon.
    for (const [name, child] of Object.entries(b.inputs ?? {})) {
      const childRange = recipes[child.block.id]!
      r.inputs[name] = { start: childRange.start, end: childRange.end, kind: 'value' }
    }
    if (['value', 'raw_value', 'raw', 'comment', 'directive', 'flow'].includes(type)) r.fields.TEXT = { start: r.start, end: r.end }
    if (type === 'data') r.fields.CODE = span(n)
    if (type === 'definition') {
      const spelling = b.fields?.TEXT ?? ''
      r.fields.TEXT = { start: n.startIndex, end: n.startIndex + spelling.length }
    }
    if (type === 'function' || type === 'lambda') {
      r.fields.SIGNATURE = trim(n.startIndex, content!.startIndex)
      r.inputs.BODY = bodySlot(content!)
    }
    if (type === 'scope') r.inputs.BODY = bodySlot(n)
    if (type === 'loop') {
      r.fields.HEADER = trim(n.startIndex, content!.startIndex)
      r.fields.FOOTER = trim(content!.endIndex, n.endIndex)
      r.inputs.BODY = bodySlot(content!)
    }
    if (type === 'binary') {
      const left = field('left')!, right = field('right')!
      r.fields.OP = trim(left.endIndex, right.startIndex)
    }
    if (type === 'unary') {
      const value = b.inputs?.VALUE?.block
      const v = value && recipes[value.id]
      if (v) { r.fields.BEFORE = { start: n.startIndex, end: v.start }; r.fields.AFTER = { start: v.end, end: n.endIndex } }
    }
    if (type === 'member') r.fields.MEMBER = { start: field('argument')!.endIndex, end: n.endIndex }
    if (type === 'declaration') {
      const value = recipes[b.inputs!.VALUE!.block.id]!
      const before = source.slice(n.startIndex, value.start).trimEnd()
      const init = before.endsWith('=') ? n.startIndex + before.length - 1 : value.start
      r.fields.DECL = trim(n.startIndex, init)
      r.fields.INIT = { start: init, end: before.endsWith('=') ? init + 1 : init }
    }
    if (type === 'annotation') {
      const comment = b.fields!.TEXT!
      r.start = source.lastIndexOf(comment, n.startIndex)
      if (r.start < 0) throw new Error('无法定位调用参数注释。')
      r.fields.TEXT = { start: r.start, end: r.start + comment.length }
    }
    if (type === 'call' || type === 'invoke' || type === 'list') {
      const args = type === 'list' ? n : field('arguments')!
      r.arguments = { start: args.startIndex + 1, end: args.endIndex - 1 }
      if (type === 'call') r.fields.NAME = span(field('function')!)
      if (type === 'list') { r.fields.OPEN = { start: n.startIndex, end: n.startIndex + 1 }; r.fields.CLOSE = { start: n.endIndex - 1, end: n.endIndex } }
    }
    if (type === 'if') {
      r.inputs.THEN = bodySlot(field('consequence')!)
      const alternative = field('alternative')
      if (alternative) r.inputs.ELSE = { ...trim(alternative.startIndex + 4, alternative.endIndex), kind: 'body' }
    }
    if (type === 'container') {
      if (content) {
        r.fields.HEADER = trim(n.startIndex, content.startIndex)
        r.fields.FOOTER = trim(content.endIndex, n.endIndex)
        r.inputs.BODY = { start: content.startIndex + 1, end: content.endIndex - 1, kind: 'sequence', ...(n.type === 'enum_specifier' ? { separator: ', ' } : {}) }
      } else if (n.type === 'template_declaration') {
        const parameters = field('parameters')!
        r.fields.HEADER = trim(n.startIndex, parameters.endIndex)
        r.inputs.BODY = { start: parameters.endIndex, end: n.endIndex, kind: 'sequence' }
      } else if (n.type.startsWith('preproc_')) {
        const start = source.indexOf('\n', n.startIndex) + 1
        const end = b.fields?.FOOTER ? source.lastIndexOf('#endif', n.endIndex) : n.endIndex
        r.fields.HEADER = trim(n.startIndex, start)
        r.fields.FOOTER = trim(end, n.endIndex)
        r.inputs.BODY = { start, end, kind: 'sequence' }
      } else if (n.type === 'case_statement') {
        const colon = n.children.find(c => c.type === ':')!
        r.fields.HEADER = { start: n.startIndex, end: colon.endIndex }
        r.inputs.BODY = { start: colon.endIndex, end: n.endIndex, kind: 'sequence' }
      } else if (n.type === 'declaration' || n.type === 'field_declaration') {
        const declarations = n.childrenForFieldName('declarator')
        r.fields.HEADER = trim(n.startIndex, declarations[0]!.startIndex)
        r.inputs.BODY = { start: declarations[0]!.startIndex, end: declarations.at(-1)!.endIndex, kind: 'sequence', separator: ', ' }
      }
    }
  }
  result.blocks.blocks.forEach(visit)
}
