import type { Node, Parser } from 'web-tree-sitter'
import type { LibraryHeader } from './libraryCatalog.js'

export interface LibraryParameter { name: string; type: string; defaultValue?: string }
export interface LibraryExport {
  kind: 'function' | 'method' | 'constructor' | 'value'
  name: string
  owner?: string
  receiver?: string
  header: string
  signature: string
  parameters: LibraryParameter[]
  returnsVoid?: boolean
  conditional?: boolean
}
export interface LibraryApi { exports: LibraryExport[]; notices: string[] }
interface Context { scope: string[]; owner?: string; public: boolean; templateClass?: boolean; abstract?: boolean; conditional?: boolean }
const simpleName = /^[A-Za-z_]\w*$/
const qualify = (scope: string[], name: string): string => [...scope, name].join('::')

function declaratorName(node: Node | null): Node | null {
  if (!node) return null
  if (['identifier', 'field_identifier', 'type_identifier', 'qualified_identifier'].includes(node.type)) return node
  return declaratorName(node.childForFieldName('declarator') ?? (node.type === 'reference_declarator' ? node.namedChildren.at(-1) ?? null : null))
}
function callable(node: Node | null): Node | null {
  if (!node) return null
  if (node.type === 'function_declarator') return node
  if (['pointer_declarator', 'reference_declarator', 'attributed_declarator'].includes(node.type)) return callable(node.childForFieldName('declarator') ?? node.namedChildren.at(-1) ?? null)
  return null
}

/** Read declarations, never function bodies or executable library generators. */
export function extractLibraryApi(parser: Parser, headers: LibraryHeader[]): LibraryApi {
  const exports: LibraryExport[] = [], notices = new Set<string>(), seen = new Set<string>()
  const singletons = new Map<string, string>()
  const add = (item: LibraryExport): void => {
    const key = `${item.kind}:${item.owner ?? ''}:${item.signature}`
    if (!seen.has(key) && exports.length < 5000) { seen.add(key); exports.push(item) }
  }
  for (const header of headers) {
    const tree = parser.parse(header.source)
    if (!tree) { notices.add(`未能解析 ${header.include}`); continue }
    try {
      const walk = (node: Node, context: Context): void => {
        const field = (name: string): Node | null => node.childForFieldName(name)
        if (node.type === 'namespace_definition') {
          const name = field('name')?.text
          if (!name || /(?:^|::)(?:detail|internal|impl)(?:$|::)/i.test(name)) return
          if (field('body')) walk(field('body')!, { ...context, scope: [...context.scope, name] })
          return
        }
        if (['class_specifier', 'struct_specifier'].includes(node.type)) {
          const name = field('name')?.text
          if (!context.public || !name || !simpleName.test(name) || !field('body')) return
          const body = field('body')!
          walk(body, { ...context, scope: [...context.scope, name], owner: qualify(context.scope, name), public: node.type === 'struct_specifier', abstract: /\)\s*(?:const\s*)?=\s*0\s*;/.test(body.text) })
          return
        }
        if (node.type === 'template_declaration') {
          const children = node.namedChildren.filter(child => child.type !== 'template_parameter_list')
          for (const child of children) walk(child, { ...context, templateClass: ['class_specifier', 'struct_specifier'].includes(child.type) || context.templateClass })
          return
        }
        if (node.type === 'enum_specifier') {
          if (!context.public || context.templateClass) return
          const name = field('name')?.text
          const scoped = /^enum\s+(?:class|struct)\b/.test(node.text)
          if (scoped && (!name || !simpleName.test(name))) return
          for (const entry of field('body')?.namedChildren ?? []) {
            const value = entry.childForFieldName('name')?.text
            if (!value || !simpleName.test(value)) continue
            const qualified = qualify(scoped ? [...context.scope, name!] : context.scope, value)
            add({ kind: 'value', name: qualified, header: header.include, signature: qualified, parameters: [], conditional: context.conditional })
          }
          return
        }
        if (['declaration', 'field_declaration', 'function_definition'].includes(node.type)) {
          if (!context.public || node.hasError || /\bfriend\b/.test(node.text.slice(0, 50))) return
          // Declarations can wrap an inline type definition.
          const type = field('type')
          if (type && ['class_specifier', 'struct_specifier', 'enum_specifier'].includes(type.type)) { walk(type, context); return }
          for (const declarator of node.childrenForFieldName('declarator')) {
            const fn = callable(declarator)
            if (!fn) {
              const name = declaratorName(declarator.type === 'init_declarator' ? declarator.childForFieldName('declarator') : declarator)?.text
              if (!name || !simpleName.test(name)) continue
              if (!context.owner && /\bextern\b/.test(node.text) && type) singletons.set(qualify(context.scope, type.text), qualify(context.scope, name))
              if (!context.templateClass && /\b(?:const|constexpr)\b/.test(node.text) && (!context.owner || /\b(?:static|constexpr)\b/.test(node.text))) {
                const qualified = qualify(context.scope, name)
                add({ kind: 'value', name: qualified, header: header.include, signature: `${type?.text ?? ''} ${qualified}`, parameters: [], conditional: context.conditional })
              }
              continue
            }
            const nameNode = fn.childForFieldName('declarator'), name = nameNode?.text
            // Function pointers, operators, destructors and out-of-class definitions
            // are not ordinary named calls (the class declaration supplies methods).
            if (!name || !simpleName.test(name) || /\bdelete\s*;/.test(node.text)) continue
            const constructor = context.owner?.split('::').at(-1) === name
            if (constructor && (context.templateClass || context.abstract)) continue
            const parameterList = fn.childForFieldName('parameters')
            if (!parameterList || parameterList.hasError || parameterList.text.includes('...')) continue
            const parameters: LibraryParameter[] = []
            for (const parameter of parameterList.namedChildren.filter(n => n.type !== 'comment')) {
              if (parameter.text === 'void') continue
              const parameterName = declaratorName(parameter.childForFieldName('declarator'))
              const defaultValue = parameter.childForFieldName('default_value')
              const spelling = parameter.text.slice(0, defaultValue ? defaultValue.startIndex - parameter.startIndex : undefined).replace(/=\s*$/, '').trim()
              const nameOffset = parameterName ? parameterName.startIndex - parameter.startIndex : -1
              const parameterType = parameterName ? (spelling.slice(0, nameOffset) + spelling.slice(nameOffset + parameterName.text.length)).trim() : spelling
              parameters.push({ name: parameterName?.text ?? `arg${parameters.length + 1}`, type: parameterType, ...(defaultValue ? { defaultValue: defaultValue.text } : {}) })
            }
            const isStatic = !context.templateClass && /\bstatic\b/.test(node.text.slice(0, nameNode!.startIndex - node.startIndex))
            const qualified = constructor ? context.owner! : context.owner && !isStatic ? name : qualify(context.scope, name)
            const returnType = node.text.slice(0, nameNode!.startIndex - node.startIndex).replace(/\b(?:static|inline|virtual|constexpr|explicit|extern)\b/g, '').trim()
            add({ kind: constructor ? 'constructor' : context.owner && !isStatic ? 'method' : 'function', name: qualified, owner: context.owner,
              header: header.include, signature: `${constructor ? '' : `${returnType} `}${qualify(context.scope, name)}${parameterList.text}`,
              parameters, returnsVoid: returnType === 'void', conditional: context.conditional })
          }
          return
        }
        if (['translation_unit', 'declaration_list', 'field_declaration_list', 'linkage_specification'].includes(node.type) || /^preproc_(?:if|ifdef|else|elif)$/.test(node.type)) {
          const guard = node.type === 'preproc_ifdef' && node.parent?.type === 'translation_unit' && /^#\s*ifndef\b/.test(node.text)
            && node.namedChildren.some(child => child.type === 'preproc_def' && child.childForFieldName('name')?.text === node.childForFieldName('name')?.text)
          const nested = { ...context, conditional: context.conditional || /^preproc_/.test(node.type) && !guard }
          for (const child of node.namedChildren) {
            if (child.type === 'access_specifier') nested.public = child.text === 'public'
            else walk(child, nested)
          }
        }
      }
      walk(tree.rootNode, { scope: [], public: true })
      if (tree.rootNode.hasError) notices.add(`${header.include} 含宏或未识别语法，仅列出可解析声明`)
    } finally { tree.delete() }
  }
  for (const item of exports) if (item.kind === 'method' && item.owner) item.receiver = singletons.get(item.owner)
  if (exports.length >= 5000) notices.add('接口较多，已显示前 5000 项')
  return { exports, notices: [...notices] }
}
