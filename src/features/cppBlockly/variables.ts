import type { Node } from 'web-tree-sitter'
import type { CppVariable, SourceSpan } from './types.js'

const scopeTypes = new Set(['translation_unit', 'namespace_definition', 'function_definition', 'lambda_expression', 'compound_statement', 'for_statement', 'for_range_loop', 'if_statement', 'while_statement', 'switch_statement'])
const cppKeywords = new Set('alignas alignof and and_eq asm auto bitand bitor bool break case catch char char8_t char16_t char32_t class compl concept const consteval constexpr constinit const_cast continue co_await co_return co_yield decltype default delete do double dynamic_cast else enum explicit export extern false float for friend goto if inline int long mutable namespace new noexcept not not_eq nullptr operator or or_eq private protected public register reinterpret_cast requires return short signed sizeof static static_assert static_cast struct switch template this thread_local throw true try typedef typeid typename union unsigned using virtual void volatile wchar_t while xor xor_eq'.split(' '))

function enclosingScope(node: Node, parameter: boolean): Node | undefined {
  for (let current = node.parent; current; current = current.parent) {
    if (parameter) {
      if (current.type === 'function_definition' || current.type === 'lambda_expression') return current
      if (current.type === 'translation_unit') return undefined
    } else if (scopeTypes.has(current.type)) return current
  }
  return undefined
}

function nameNodes(node: Node | null): Node[] {
  if (!node) return []
  if (node.type === 'identifier') return [node]
  if (node.type === 'structured_binding_declarator') return node.namedChildren.filter(child => child.type === 'identifier')
  if (node.type === 'function_declarator' || node.type === 'qualified_identifier') return []
  return nameNodes(node.childForFieldName('declarator') ?? node.namedChildren.find(child => child.type === 'identifier' || child.type.endsWith('declarator')) ?? null)
}

function functionName(node: Node): string {
  const declarator = node.childForFieldName('declarator')
  if (!declarator) return '回调'
  const name = declarator.childForFieldName('declarator')
  return name?.text ?? '回调'
}

function displayScope(node: Node, kind: CppVariable['scopeKind']): string {
  if (kind === 'global') return node.type === 'namespace_definition' ? `命名空间 ${node.childForFieldName('name')?.text ?? ''}` : '全局'
  for (let current: Node | null = node; current; current = current.parent) {
    if (current.type === 'function_definition') return `函数 ${functionName(current)}`
    if (current.type === 'lambda_expression') return '回调'
  }
  return '局部'
}

function isWithin(node: Node, ancestor: Node): boolean {
  for (let current: Node | null = node; current; current = current.parent) if (current.id === ancestor.id) return true
  return false
}

function isReference(node: Node): boolean {
  for (let current = node.parent; current; current = current.parent) {
    if (current.type.startsWith('preproc_')) return false
    if (current.type === 'qualified_identifier' && current.childForFieldName('name')?.id !== node.id) return false
    if (current.type === 'function_declarator' && current.childForFieldName('declarator')?.id === node.id) return false
    if (current.type === 'call_expression' && current.childForFieldName('function')?.id === node.id) return false
    if (current.type === 'enumerator' && current.namedChildren[0]?.id === node.id) return false
    if (current.type === 'translation_unit') break
  }
  return true
}

function namespacePath(scope: Node): string {
  const parts: string[] = []
  for (let current: Node | null = scope; current; current = current.parent) {
    if (current.type === 'namespace_definition') parts.unshift(current.childForFieldName('name')?.text ?? '')
  }
  return parts.filter(Boolean).join('::')
}

/** C++ lexical bindings used only by this source projection, never by hardware Blockly. */
export function collectCppVariables(root: Node, source: string): { variables: CppVariable[]; bindings: Map<number, string> } {
  const variables: CppVariable[] = []
  const scopes = new Map<string, Node>()
  const names = new Map<string, Node>()
  const identifiers: Node[] = []
  const stack = [root]
  while (stack.length) {
    const node = stack.pop()!
    if (node.type === 'identifier') identifiers.push(node)
    if (node.type === 'declaration' || node.type === 'parameter_declaration' || node.type === 'for_range_loop') {
      const parameter = node.type === 'parameter_declaration'
      const rangeLoop = node.type === 'for_range_loop'
      const scope = rangeLoop ? node : enclosingScope(node, parameter)
      if (scope) {
        const declarators = parameter || rangeLoop ? [node.childForFieldName('declarator')].filter((item): item is Node => !!item) : node.childrenForFieldName('declarator')
        for (const declarator of declarators) {
          for (const name of nameNodes(declarator)) {
            const structured = declarator.text.trimStart().startsWith('[')
            const prefix = (rangeLoop ? source.slice(source.indexOf('(', node.startIndex) + 1, name.startIndex)
              : structured ? source.slice(node.startIndex, declarator.startIndex)
              : declarator === declarators[0]
                ? source.slice(node.startIndex, name.startIndex)
                : source.slice(node.startIndex, declarators[0]!.startIndex) + source.slice(declarator.startIndex, name.startIndex)).trim().replace(/\s+/g, ' ')
            const kind: CppVariable['scopeKind'] = parameter ? 'parameter' : scope.type === 'translation_unit' || scope.type === 'namespace_definition' ? 'global' : 'local'
            const id = `cpp-var-${name.startIndex}`
            variables.push({ id, name: name.text, dataType: prefix, scope: displayScope(scope, kind), scopeKind: kind, scopeStart: scope.startIndex, scopeEnd: scope.endIndex,
              declaration: { start: name.startIndex, end: name.endIndex }, references: [] })
            scopes.set(id, scope); names.set(id, name)
          }
        }
      }
    }
    for (let i = node.namedChildren.length - 1; i >= 0; i--) stack.push(node.namedChildren[i]!)
  }
  const bindings = new Map<number, string>()
  const byName = new Map<string, CppVariable[]>()
  for (const variable of variables) byName.set(variable.name, [...(byName.get(variable.name) ?? []), variable])
  for (const node of identifiers) {
    if (!isReference(node)) continue
    const candidates = (byName.get(node.text) ?? []).filter(variable => {
      const scope = scopes.get(variable.id)!
      const qualifier = node.parent?.type === 'qualified_identifier' ? node.parent.childForFieldName('scope')?.text?.replace(/^::/, '') ?? '' : undefined
      if (qualifier !== undefined) return variable.scopeKind === 'global' && variable.declaration.start <= node.startIndex && namespacePath(scope) === qualifier
      if (variable.declaration.start > node.startIndex || !isWithin(node, scope)) return false
      // A range expression sees the enclosing bindings, not the new loop variable.
      const range = scope.type === 'for_range_loop' ? scope.childForFieldName('right') : null
      return !range || !isWithin(node, range)
    })
    candidates.sort((left, right) => {
      const a = scopes.get(left.id)!, b = scopes.get(right.id)!
      if (a.id !== b.id) return isWithin(a, b) ? -1 : isWithin(b, a) ? 1 : 0
      return right.declaration.start - left.declaration.start
    })
    const match = candidates[0]
    if (!match) continue
    const declarationNode = names.get(match.id)!
    if (node.startIndex !== declarationNode.startIndex && node.parent?.type === 'init_declarator' && node.parent.childForFieldName('declarator')?.id === node.id) continue
    match.references.push({ start: node.startIndex, end: node.endIndex })
    bindings.set(node.startIndex, match.id)
  }
  return { variables, bindings }
}

export function renameCppVariable(source: string, variables: readonly CppVariable[], id: string, nextName: string): string {
  const variable = variables.find(item => item.id === id)
  if (!variable) throw new Error('变量已变化，请重新载入源码后重试。')
  if (!/^[A-Za-z_]\w*$/.test(nextName) || cppKeywords.has(nextName) || /^__|^_[A-Z]/.test(nextName)) throw new Error('请输入有效的 C++ 变量名。')
  if (nextName === variable.name) return source
  if (variables.some(item => item.id !== id && item.name === nextName && item.scopeStart < variable.scopeEnd && variable.scopeStart < item.scopeEnd)) throw new Error(`变量“${nextName}”已存在，请使用其他名称。`)
  if (variables.some(item => item.id !== id && item.name === variable.name && item.scopeStart === variable.scopeStart)) throw new Error('同一作用域有重复声明，请通过源码完成重命名。')
  const ranges = [...variable.references].sort((a, b) => b.start - a.start)
  if (!ranges.some(range => range.start === variable.declaration.start)) throw new Error('无法确认变量声明位置，请通过源码重命名。')
  let result = source
  for (const range of ranges) {
    if (source.slice(range.start, range.end) !== variable.name) throw new Error('源码已变化，请重新载入后重试。')
    result = result.slice(0, range.start) + nextName + result.slice(range.end)
  }
  return result
}

export function variableAtSpan(variables: readonly CppVariable[], span: SourceSpan): CppVariable | undefined {
  return variables.find(variable => variable.references.some(reference => reference.start === span.start && reference.end === span.end))
}
