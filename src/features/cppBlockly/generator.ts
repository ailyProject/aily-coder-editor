import type { CppPreview, PreviewBlock, SourceRecipe, SourceSlot, SourceSpan } from './types.js'

export function indexBlocks(roots: PreviewBlock[]): Map<string, PreviewBlock> {
  const result = new Map<string, PreviewBlock>()
  const visit = (b: PreviewBlock): void => {
    result.set(b.id, b)
    Object.values(b.inputs ?? {}).forEach(i => visit(i.block))
    if (b.next) visit(b.next.block)
  }
  roots.forEach(visit)
  return result
}
export function chainBlocks(first?: PreviewBlock): PreviewBlock[] {
  const list: PreviewBlock[] = []
  for (let b = first; b; b = b.next?.block) list.push(b)
  return list
}
const expressions = new Set(['binary', 'group', 'unary', 'value', 'raw_value', 'call', 'invoke', 'list', 'lambda', 'data', 'annotation', 'member', 'subscript', 'ternary'])
const kind = (b: PreviewBlock): string => b.type.replace('cpp_preview_', '')

/** Merge a scoped canvas back into the file without touching surrounding units. */
export function mergeScope(roots: PreviewBlock[], scopeId: string, view: PreviewBlock[]): PreviewBlock[] {
  if (!scopeId) return structuredClone(view)
  if (view.length !== 1 || view[0]?.id !== scopeId) throw new Error('请把新增积木连接到当前函数或容器，再切换范围或应用。')
  const merged = structuredClone(roots)
  const old = indexBlocks(merged).get(scopeId)
  if (!old) throw new Error('当前范围已不存在，请重新载入源码。')
  const next = old.next
  Object.assign(old, structuredClone(view[0]))
  old.inputs = structuredClone(view[0].inputs)
  old.next = next
  return merged
}

export function generateCpp(source: string, original: CppPreview, roots: PreviewBlock[]): string {
  if (original.status === 'error') throw new Error('源码尚未成功转换。')
  const baseline = indexBlocks(original.blocks.blocks)
  const byOrigin = new Map([...baseline.values()].filter(b => b.data).map(b => [b.data!, b]))
  const origin = (b: PreviewBlock): PreviewBlock | undefined => b.data ? byOrigin.get(b.data) : undefined
  const recipe = (b: PreviewBlock): SourceRecipe | undefined => { const o = origin(b); return o && original.recipes?.[o.id] }
  const text = (s: SourceSpan): string => source.slice(s.start, s.end)
  const newline = source.includes('\r\n') ? '\r\n' : '\n'
  const patch = (range: SourceSpan, edits: Array<SourceSpan & { value: string }>): string => {
    let cursor = range.start, result = ''
    for (const e of edits.sort((a, b) => a.start - b.start || a.end - b.end)) {
      if (e.start < cursor || e.end > range.end || e.start > e.end) throw new Error('源码映射重叠，已停止回写。请通过源码编辑此结构。')
      result += source.slice(cursor, e.start) + e.value; cursor = e.end
    }
    return result + source.slice(cursor, range.end)
  }
  const required = (b: PreviewBlock, name: string): string => {
    const child = b.inputs?.[name]?.block
    if (!child) throw new Error(`“${b.fields?.NAME ?? b.fields?.SIGNATURE ?? kind(b)}”的 ${name} 插槽为空，请连接积木。`)
    return expression(child)
  }
  const expression = (b: PreviewBlock): string => ['binary', 'unary', 'ternary', 'raw_value'].includes(kind(b)) ? `(${node(b)})` : node(b)
  const body = (b: PreviewBlock, name: string): string => chainBlocks(b.inputs?.[name]?.block).map(node).join(newline)
  const braces = (code: string): string => `{${newline}${code.split(/\r?\n/).map(l => l ? `  ${l}` : '').join(newline)}${newline}}`
  const argumentsOf = (b: PreviewBlock): string => Array.from({ length: b.extraState?.count ?? 0 }, (_, i) => required(b, `ARG${i}`)).join(', ')
  const atom = (value: string): string => /^(?:[\w:$]+|0[xX][\da-fA-F]+|\d+(?:\.\d*)?(?:[eE][+-]?\d+)?[uUlLfF]*|(?:u8|u|U|L)?"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')$/.test(value.trim()) ? value : `(${value})`
  const canonical = (b: PreviewBlock): string => {
    const f = (name: string): string => b.fields?.[name] ?? ''
    const v = (name: string): string => required(b, name)
    const type = kind(b)
    switch (type) {
      case 'value': return recipe(b)?.syntax === 'type_descriptor' ? f('TEXT') : atom(f('TEXT'))
      case 'raw_value': case 'raw': case 'directive': case 'comment': case 'flow': return f('TEXT')
      case 'data': if (!f('CODE')) throw new Error('数据块缺少完整原文。'); return f('CODE')
      case 'definition': return f('TEXT').replace(/;?\s*$/, ';')
      case 'declaration': return `${f('DECL')} ${f('INIT')} ${v('VALUE')};`
      case 'statement': return `${v('VALUE')};`
      case 'return': return `return${b.inputs?.VALUE ? ` ${v('VALUE')}` : ''};`
      case 'function': case 'lambda': return `${f('SIGNATURE')} ${braces(body(b, 'BODY'))}`
      case 'scope': return braces(body(b, 'BODY'))
      case 'loop': return `${f('HEADER')} ${braces(body(b, 'BODY'))}${f('FOOTER') ? ` ${f('FOOTER')}` : ''}`
      case 'if': return `if (${v('CONDITION')}) ${braces(body(b, 'THEN'))}${b.extraState?.count ? ` else ${braces(body(b, 'ELSE'))}` : ''}`
      case 'binary': return `(${v('LEFT')} ${f('OP')} ${v('RIGHT')})`
      case 'group': return `(${v('VALUE')})`
      case 'unary': return `(${f('BEFORE')}${v('VALUE')}${f('AFTER')})`
      case 'ternary': return `(${v('CONDITION')} ? ${v('THEN')} : ${v('ELSE')})`
      case 'member': return `${v('OBJECT')}${f('MEMBER')}`
      case 'subscript': return `${v('OBJECT')}${v('INDEX')}`
      case 'call': return `${f('NAME')}(${argumentsOf(b)})`
      case 'invoke': return `${v('FUNCTION')}(${argumentsOf(b)})`
      case 'list': return `${f('OPEN')}${argumentsOf(b)}${f('CLOSE')}`
      case 'annotation': return `${f('TEXT')}${newline}${v('VALUE')}`
      default: throw new Error('该容器缺少源码映射，请从当前文件复制容器或通过源码新增。')
    }
  }
  const sequence = (current: PreviewBlock[], old: PreviewBlock[], range: SourceSpan, separator?: string): string => {
    if (current.length === old.length && current.every((b, i) => origin(b)?.id === old[i]!.id)) {
      return patch(range, current.map((b, i) => ({ ...recipe(old[i]!)!, value: node(b) })))
    }
    const spans = old.map(b => recipe(b)!)
    if (spans.some(s => !s)) throw new Error('缺少源码顺序映射。')
    const gaps = spans.map((s, i) => source.slice(i ? spans[i - 1]!.end : range.start, s.start))
    gaps.push(source.slice(spans.at(-1)?.end ?? range.start, range.end))
    if (gaps.some(g => !/^[\s,]*$/.test(g))) throw new Error('此结构含有未映射的注释或标点，请通过源码调整顺序。')
    const prefix = gaps[0] ?? '', suffix = old.length ? gaps.at(-1)! : ''
    if (!current.length) return prefix.replace(/,/g, '') + suffix.replace(/,/g, '')
    const values = current.map(b => {
      const s = node(b)
      // Declarator and enumerator sequences are comma-separated, not statements.
      return separator ? s.replace(/;\s*$/, '') : s
    })
    let output = prefix.replace(/,/g, '')
    values.forEach((v, i) => {
      if (i) {
        const a = recipe(current[i - 1]!), b = recipe(current[i]!)
        const gap = a && b && a.end <= b.start ? source.slice(a.end, b.start) : ''
        const indent = prefix.match(/(?:\r?\n)([ \t]*)$/)?.[1] ?? '  '
        output += gap && /^[\s,]*$/.test(gap) && (!separator || gap.includes(',')) ? gap : separator ?? `${newline}${range.start === 0 ? '' : indent}`
      }
      output += v
    })
    // A newly inserted line comment must not swallow the enclosing brace.
    const lastLine = values.at(-1)?.split(/\r?\n/).at(-1) ?? ''
    return output + (!separator && !suffix.includes('\n') && lastLine.includes('//') ? newline : '') + suffix
  }
  const node = (b: PreviewBlock): string => {
    const old = origin(b), r = recipe(b)
    if (!old || !r || old.type !== b.type) return canonical(b)
    const edits: Array<SourceSpan & { value: string }> = []
    const type = kind(b)
    const fieldChanges = Object.entries(b.fields ?? {}).filter(([key, value]) => old.fields?.[key] !== value)
    // Parentheses preserve the block tree if a new operator changes precedence.
    if ((type === 'binary' || type === 'unary' || type === 'value') && fieldChanges.length) return canonical(b)
    if (type === 'if' && b.extraState?.count !== old.extraState?.count) return canonical(b)
    for (const [key, value] of fieldChanges) {
      const slot = r.fields[key]
      if (!slot) return canonical(b)
      edits.push({ ...slot, value })
    }
    const countChanged = r.arguments && b.extraState?.count !== old.extraState?.count
    if (countChanged) {
      const oldArgs = Object.entries(old.inputs ?? {}).filter(([key]) => key.startsWith('ARG')).map(([, i]) => i.block)
      const residue = patch(r.arguments!, oldArgs.map(arg => ({ ...recipe(arg)!, value: '' })))
      if (!/^[\s,]*$/.test(residue)) throw new Error('参数之间含有注释，请通过源码调整参数数量。')
      edits.push({ ...r.arguments!, value: argumentsOf(b) })
    }
    for (const name of new Set([...Object.keys(old.inputs ?? {}), ...Object.keys(b.inputs ?? {}), ...Object.keys(r.inputs)])) {
      if (countChanged && name.startsWith('ARG')) continue
      const before = old.inputs?.[name]?.block, after = b.inputs?.[name]?.block, slot = r.inputs[name]
      if (!slot) { if (after || before) return canonical(b); continue }
      let value: string
      if (slot.kind === 'value') {
        if (!after) {
          if (type === 'return') return canonical(b)
          throw new Error(`“${b.fields?.NAME ?? type}”的 ${name} 插槽为空，请连接积木。`)
        }
        value = origin(after)?.id === before?.id ? node(after) : expression(after)
      } else {
        const current = chainBlocks(after), prior = chainBlocks(before)
        value = sequence(current, prior, slot, slot.separator)
        if (slot.kind === 'body' && (current.length !== 1 || origin(current[0]!)?.id !== prior[0]?.id)) value = braces(value)
      }
      if (value !== text(slot)) edits.push({ ...slot, value })
    }
    return patch(r, edits)
  }
  const current = roots.flatMap(b => chainBlocks(b))
  if (current.some(b => expressions.has(kind(b)))) throw new Error('画布上有未连接的表达式，请把它连接到语句或参数插槽后再应用。')
  return sequence(current, original.blocks.blocks.flatMap(b => chainBlocks(b)), { start: 0, end: source.length })
}
