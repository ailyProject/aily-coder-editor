import type { Node, Parser } from 'web-tree-sitter'
import { MAX_BLOCKS, MAX_SOURCE_LENGTH, previewError, type CppPreview, type PreviewBlock, type SourceLocation } from './types.js'

// This is a read-only C++ syntax projection. Calls retain their actual spelling;
// no hardware-library identity is guessed and no Arduino generator is executed.
export function convertCpp(parser: Parser, source: string): CppPreview {
  if (source.length > MAX_SOURCE_LENGTH) return previewError('文件过大，请预览不超过 200,000 字符的 C++ 文件。')
  let tree = parser.parse(source)
  if (!tree) return previewError('C++ 解析未完成，请重试。')
  // Arduino's storage annotation is not part of ISO C++. Mask only suffix
  // PROGMEM identifiers following an array declarator, never strings/comments
  // or a variable named PROGMEM. Equal-length spaces preserve source offsets.
  const annotations: Array<[number, number]> = []
  const nodes = [tree.rootNode]
  while (nodes.length) {
    const n = nodes.pop()!
    if (n.type === 'identifier' && n.text === 'PROGMEM' &&
        ((n.parent?.type === 'assignment_expression' && n.parent.childForFieldName('left')?.id === n.id) ||
         (n.parent?.type === 'init_declarator' && n.parent.childForFieldName('declarator')?.id === n.id)) &&
        /\]\s*$/.test(source.slice(Math.max(0, n.startIndex - 100), n.startIndex))) annotations.push([n.startIndex, n.endIndex])
    else if (n.type !== 'raw_string_literal' && n.type !== 'string_literal' && n.type !== 'comment') nodes.push(...n.namedChildren)
  }
  if (annotations.length) {
    let normalized = source
    for (const [start, end] of annotations) normalized = normalized.slice(0, start) + ' '.repeat(end - start) + normalized.slice(end)
    tree.delete(); tree = parser.parse(normalized)
    if (!tree) return previewError('C++ 解析未完成，请重试。')
  }
  const result: CppPreview = {
    status: 'ready', blocks: { languageVersion: 0, blocks: [] }, locations: {},
    diagnostics: [], blockCount: 0, preservedCount: 0, dataCount: 0
  }
  const location = (n: Node): SourceLocation => {
    // The grammar places class/enum terminators outside their named node.
    const end = n.nextSibling?.type === ';' ? n.nextSibling : n
    return {
      line: n.startPosition.row + 1, column: n.startPosition.column + 1,
      endLine: end.endPosition.row + 1, endColumn: end.endPosition.column + 1,
      text: source.slice(n.startIndex, end.endIndex)
    }
  }
  const field = (n: Node, name: string): Node | null => n.childForFieldName(name)
  const raw = (n: Node): string => source.slice(n.startIndex, n.endIndex)
  const children = (n: Node): Node[] => n.namedChildren.filter(c => c.type !== 'comment')
  const compact = (text: string): string => {
    const line = text.replace(/\s+/g, ' ').trim()
    return line.length > 110 ? `${line.slice(0, 107)}…` : line
  }
  const block = (n: Node, type: string, fields: Record<string, string> = {}): PreviewBlock => {
    if (++result.blockCount > MAX_BLOCKS) throw new Error('积木数量超过 2,000，请缩小文件后预览。')
    const id = `cpp-${result.blockCount}`
    result.locations[id] = location(n)
    return { type: `cpp_preview_${type}`, id, fields }
  }
  const input = (b: PreviewBlock, name: string, child: PreviewBlock | undefined): void => {
    if (child) (b.inputs ??= {})[name] = { block: child }
  }
  const preserved = (n: Node, value = false): PreviewBlock => {
    result.preservedCount++
    result.diagnostics.push({ ...location(n), severity: 'preserved', message: `${n.type} 暂以原始 C++ 保留` })
    return block(n, value ? 'raw_value' : 'raw', { TEXT: compact(location(n).text) })
  }
  const expression = (n: Node | null, depth = 0): PreviewBlock | undefined => {
    if (!n) return undefined
    if (depth > 70) return preserved(n, true)
    if (['identifier', 'number_literal', 'string_literal', 'char_literal', 'true', 'false', 'null', 'nullptr', 'qualified_identifier', 'this', 'concatenated_string'].includes(n.type)) {
      return block(n, 'value', { TEXT: compact(raw(n)) })
    }
    if (n.type === 'raw_string_literal') {
      result.dataCount!++
      return block(n, 'data', { TEXT: `原始字符串 · ${raw(n).length.toLocaleString('en-US')} 字符 · ${n.endPosition.row - n.startPosition.row + 1} 行` })
    }
    if (n.type === 'initializer_list' || n.type === 'argument_list' || n.type === 'subscript_argument_list') {
      const items = children(n)
      // Bitmap/resource arrays remain a typed data value, not thousands of
      // independently rendered number blocks. Non-literal expressions expand.
      if (n.type === 'initializer_list' && items.length > 24 && items.every(c => ['number_literal', 'string_literal', 'char_literal', 'true', 'false'].includes(c.type))) {
        result.dataCount!++
        return block(n, 'data', { TEXT: `常量数组 · ${items.length} 项 · ${compact(items.slice(0, 4).map(raw).join(', '))} …` })
      }
      const b = block(n, 'list', { OPEN: raw(n).slice(0, 1), CLOSE: raw(n).slice(-1) })
      b.extraState = { count: items.length }
      items.forEach((item, i) => input(b, `ARG${i}`, expression(item, depth + 1)))
      return b
    }
    if (n.type === 'lambda_expression') {
      const content = field(n, 'body')
      if (!content) return preserved(n, true)
      const b = block(n, 'lambda', { SIGNATURE: compact(source.slice(n.startIndex, content.startIndex)) })
      input(b, 'BODY', body(content, depth + 1))
      return b
    }
    if (n.type === 'field_expression') {
      const object = field(n, 'argument'), member = field(n, 'field')
      if (!object || !member) return preserved(n, true)
      const b = block(n, 'member', { MEMBER: source.slice(object.endIndex, n.endIndex) })
      input(b, 'OBJECT', expression(object, depth + 1)); return b
    }
    if (n.type === 'subscript_expression') {
      const b = block(n, 'subscript')
      input(b, 'OBJECT', expression(field(n, 'argument'), depth + 1))
      input(b, 'INDEX', expression(field(n, 'indices'), depth + 1)); return b
    }
    if (n.type === 'cast_expression' || n.type === 'sizeof_expression') {
      const value = field(n, 'value') ?? children(n).at(-1) ?? null
      if (!value) return preserved(n, true)
      const b = block(n, 'unary', { BEFORE: source.slice(n.startIndex, value.startIndex), AFTER: source.slice(value.endIndex, n.endIndex) })
      input(b, 'VALUE', expression(value, depth + 1)); return b
    }
    if (n.type === 'type_descriptor') return block(n, 'value', { TEXT: raw(n) })
    if (n.type === 'conditional_expression') {
      const b = block(n, 'ternary')
      input(b, 'CONDITION', expression(field(n, 'condition'), depth + 1))
      input(b, 'THEN', expression(field(n, 'consequence'), depth + 1))
      input(b, 'ELSE', expression(field(n, 'alternative'), depth + 1)); return b
    }
    if (n.type === 'parenthesized_expression' || n.type === 'condition_clause') {
      const value = field(n, 'value') ?? n.namedChildren[0] ?? null
      if (value?.type === 'declaration' || n.namedChildren.length !== 1) return preserved(n, true)
      const b = block(n, 'group')
      input(b, 'VALUE', expression(value, depth + 1))
      return b
    }
    if (n.type === 'binary_expression' || n.type === 'assignment_expression') {
      const left = field(n, 'left'), right = field(n, 'right')
      if (!left || !right) return preserved(n, true)
      const operator = field(n, 'operator')?.text ?? source.slice(left.endIndex, right.startIndex).trim()
      const b = block(n, 'binary', { OP: operator })
      input(b, 'LEFT', expression(left, depth + 1)); input(b, 'RIGHT', expression(right, depth + 1))
      return b
    }
    if (n.type === 'call_expression') {
      const args = field(n, 'arguments')
      const fn = field(n, 'function')
      if (!args || !fn) return preserved(n, true)
      const simpleName = ['identifier', 'qualified_identifier', 'template_function'].includes(fn.type) ||
        (fn.type === 'field_expression' && field(fn, 'argument')?.type === 'identifier')
      const b = block(n, simpleName ? 'call' : 'invoke', simpleName ? { NAME: compact(raw(fn)) } : {})
      if (!simpleName) input(b, 'FUNCTION', expression(fn, depth + 1))
      const argsWithoutComments = children(args)
      b.extraState = { count: argsWithoutComments.length }
      argsWithoutComments.forEach((arg, i) => {
        const comments = args.namedChildren.filter(c => c.type === 'comment' && c.startIndex >= (argsWithoutComments[i - 1]?.endIndex ?? args.startIndex) && c.endIndex <= arg.startIndex)
        const value = expression(arg, depth + 1)
        if (comments.length) {
          const annotated = block(arg, 'annotation', { TEXT: comments.map(raw).join(' ') })
          input(annotated, 'VALUE', value); input(b, `ARG${i}`, annotated)
        } else input(b, `ARG${i}`, value)
      })
      return b
    }
    if (n.type === 'unary_expression' || n.type === 'update_expression' || n.type === 'pointer_expression') {
      const arg = field(n, 'argument')
      if (!arg) return preserved(n, true)
      const b = block(n, 'unary', {
        BEFORE: source.slice(n.startIndex, arg.startIndex), AFTER: source.slice(arg.endIndex, n.endIndex)
      })
      input(b, 'VALUE', expression(arg, depth + 1))
      return b
    }
    return preserved(n, true)
  }
  const chain = (nodes: readonly Node[], depth: number): PreviewBlock | undefined => {
    let first: PreviewBlock | undefined, last: PreviewBlock | undefined
    for (const n of nodes) {
      const b = statement(n, depth + 1)
      if (!first) first = b
      if (last) last.next = { block: b }
      last = b
    }
    return first
  }
  const body = (n: Node | null, depth: number): PreviewBlock | undefined => {
    if (!n) return undefined
    return n.type === 'compound_statement' ? chain(n.namedChildren, depth) : statement(n, depth + 1)
  }
  const statement = (n: Node, depth: number): PreviewBlock => {
    if (depth > 70) return preserved(n)
    if (!['compound_statement', 'namespace_definition', 'class_specifier', 'struct_specifier', 'union_specifier', 'enum_specifier', 'template_declaration', 'preproc_if', 'preproc_ifdef', 'preproc_elif', 'preproc_else', 'case_statement'].includes(n.type) && n.namedChildren.some(c => c.type === 'comment')) return preserved(n)
    if (n.type === 'comment') return block(n, 'comment', { TEXT: compact(n.text) })
    if (['preproc_include', 'preproc_def', 'preproc_function_def', 'preproc_call', 'alias_declaration', 'using_declaration', 'access_specifier'].includes(n.type)) return block(n, 'directive', { TEXT: compact(raw(n)) })
    if (['namespace_definition', 'class_specifier', 'struct_specifier', 'union_specifier', 'enum_specifier'].includes(n.type)) {
      const content = field(n, 'body')
      if (!content) return block(n, 'definition', { TEXT: compact(location(n).text) })
      const b = block(n, 'container', { HEADER: compact(source.slice(n.startIndex, content.startIndex)), FOOTER: compact(source.slice(content.endIndex, n.endIndex)) })
      input(b, 'BODY', chain(content.namedChildren, depth + 1)); return b
    }
    if (n.type === 'template_declaration') {
      const parameters = field(n, 'parameters')
      if (!parameters) return preserved(n)
      const b = block(n, 'container', { HEADER: compact(source.slice(n.startIndex, parameters.endIndex)), FOOTER: '' })
      input(b, 'BODY', chain(n.namedChildren.filter(c => c.startIndex >= parameters.endIndex), depth + 1)); return b
    }
    if (['preproc_if', 'preproc_ifdef', 'preproc_elif', 'preproc_else'].includes(n.type)) {
      const startOfBody = source.indexOf('\n', n.startIndex) + 1
      if (!startOfBody) return preserved(n)
      const alternative = field(n, 'alternative')
      const b = block(n, 'container', { HEADER: compact(source.slice(n.startIndex, startOfBody)), FOOTER: n.type === 'preproc_if' || n.type === 'preproc_ifdef' ? '#endif' : '' })
      input(b, 'BODY', chain(n.namedChildren.filter(c => c.startIndex >= startOfBody && c.id !== alternative?.id), depth + 1))
      if (alternative) {
        let last = b.inputs?.BODY?.block
        if (last) { while (last.next) last = last.next.block; last.next = { block: statement(alternative, depth + 1) } }
        else input(b, 'BODY', statement(alternative, depth + 1))
      }
      return b
    }
    if (n.type === 'function_definition') {
      const content = field(n, 'body')
      if (!content || content.type !== 'compound_statement') return preserved(n)
      const b = block(n, 'function', { SIGNATURE: compact(source.slice(n.startIndex, content.startIndex)) })
      input(b, 'BODY', body(content, depth + 1))
      return b
    }
    if (n.type === 'declaration' || n.type === 'field_declaration') {
      const decls = n.childrenForFieldName('declarator')
      const d = decls[0]
      if (!d) return preserved(n)
      const binding = (declarator: Node, first: boolean): PreviewBlock => {
        const value = field(declarator, 'value') ?? (decls.length === 1 ? field(n, 'default_value') : null)
        const start = first ? n.startIndex : declarator.startIndex
        if (!value) return block(decls.length === 1 ? n : declarator, 'definition', { TEXT: compact(source.slice(start, declarator.endIndex)) })
        const before = source.slice(start, value.startIndex).trimEnd()
        const b = block(decls.length === 1 ? n : declarator, 'declaration', { DECL: compact(before.replace(/=\s*$/, '')), INIT: before.endsWith('=') ? '=' : '' })
        input(b, 'VALUE', expression(value, depth + 1)); return b
      }
      if (decls.length === 1) return binding(d, true)
      const b = block(n, 'container', { HEADER: `声明 ${compact(source.slice(n.startIndex, d.startIndex))}`, FOOTER: '' })
      let last: PreviewBlock | undefined
      for (const item of decls) { const child = binding(item, false); if (last) last.next = { block: child }; else input(b, 'BODY', child); last = child }
      return b
    }
    if (n.type === 'expression_statement') {
      if (n.namedChildCount !== 1) return preserved(n)
      const b = block(n, 'statement')
      input(b, 'VALUE', expression(n.namedChildren[0] ?? null))
      return b
    }
    if (n.type === 'if_statement') {
      // C++17 if-init / constexpr needs more than a simple condition block.
      const condition = field(n, 'condition')
      if (!condition || condition.namedChildCount !== 1 || n.children.some(c => c.text === 'constexpr')) return preserved(n)
      const b = block(n, 'if')
      input(b, 'CONDITION', expression(condition))
      input(b, 'THEN', body(field(n, 'consequence'), depth + 1))
      const alternative = field(n, 'alternative')
      b.extraState = { count: alternative ? 1 : 0 }
      input(b, 'ELSE', alternative ? chain(alternative.namedChildren, depth + 1) : undefined)
      return b
    }
    if (['for_statement', 'for_range_loop', 'while_statement', 'do_statement', 'switch_statement'].includes(n.type)) {
      const content = field(n, 'body')
      if (!content) return preserved(n)
      const b = block(n, 'loop', {
        HEADER: compact(source.slice(n.startIndex, content.startIndex)),
        FOOTER: compact(source.slice(content.endIndex, n.endIndex))
      })
      input(b, 'BODY', body(content, depth + 1))
      return b
    }
    if (n.type === 'compound_statement') {
      const b = block(n, 'scope')
      input(b, 'BODY', chain(n.namedChildren, depth + 1))
      return b
    }
    if (n.type === 'return_statement') {
      if (n.namedChildCount > 1) return preserved(n)
      const b = block(n, 'return')
      input(b, 'VALUE', expression(n.namedChildren[0] ?? null))
      return b
    }
    if (n.type === 'case_statement') {
      const colon = n.children.find(c => c.type === ':')
      if (!colon) return preserved(n)
      const b = block(n, 'container', { HEADER: compact(source.slice(n.startIndex, colon.endIndex)), FOOTER: '' })
      input(b, 'BODY', chain(n.namedChildren.filter(c => c.startIndex >= colon.endIndex), depth + 1)); return b
    }
    if (n.type === 'enumerator') return block(n, 'definition', { TEXT: raw(n) })
    if (['break_statement', 'continue_statement'].includes(n.type)) {
      return block(n, 'flow', { TEXT: compact(n.text) })
    }
    return preserved(n)
  }
  try {
    if (tree.rootNode.hasError) {
      const stack = [tree.rootNode]
      while (stack.length && result.diagnostics.length < 30) {
        const n = stack.pop()!
        if (n.type === 'ERROR' || n.isMissing) {
          result.diagnostics.push({ ...location(n), severity: 'error', message: n.isMissing ? `缺少 ${n.type}` : 'C++ 语法不完整或无法解析，请先修正此处。' })
        } else for (const child of [...n.children].reverse()) if (child.hasError || child.isMissing) stack.push(child)
      }
      result.status = 'error'
      return result
    }
    let globals: Node[] = []
    const flushGlobals = (): void => {
      const root = chain(globals, 0)
      if (root) result.blocks.blocks.push(root)
      globals = []
    }
    for (const n of tree.rootNode.namedChildren) {
      if (n.type === 'function_definition') { flushGlobals(); result.blocks.blocks.push(statement(n, 0)) }
      else globals.push(n)
    }
    flushGlobals()
    result.status = result.preservedCount ? 'partial' : 'ready'
    return result
  } catch (error) {
    return previewError(error instanceof Error ? error.message : String(error))
  } finally { tree.delete() }
}
