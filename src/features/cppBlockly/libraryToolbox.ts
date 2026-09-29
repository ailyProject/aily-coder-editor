import type { utils } from 'blockly'
import type { LibraryApi, LibraryExport } from './libraryApi.js'
import type { ProjectLibrary } from './libraryCatalog.js'
import type { PreviewBlock } from './types.js'
import { maskCppComments, sourceIncludes } from '../ailyLibraryUsage.js'
import { beginnerSearchText, literalBlock } from './beginnerCatalog.js'
import { libraryBlockData, libraryCallName, libraryMethodKey, libraryParameterValue } from './librarySelection.js'

const metadataPrefix = 'cpp-library-v1:'
interface LibraryBlockInfo { library: string; header: string; signature: string }
export function libraryBlockInfo(data?: string | null): LibraryBlockInfo | undefined {
  const start = data?.indexOf(metadataPrefix) ?? -1
  if (start < 0) return undefined
  try {
    const value: unknown = JSON.parse(data!.slice(start + metadataPrefix.length))
    if (value && typeof value === 'object' && 'header' in value && typeof value.header === 'string'
      && /^[\w.+/-]+$/.test(value.header) && !value.header.startsWith('/') && !value.header.split('/').includes('..')
      && 'signature' in value && typeof value.signature === 'string' && 'library' in value && typeof value.library === 'string') return value as LibraryBlockInfo
  } catch { /* Ignore unrelated or malformed block metadata. */ }
  return undefined
}
export function libraryBlockTooltip(data?: string | null): string {
  const info = libraryBlockInfo(data)
  return info ? `${info.library}\n${info.signature}\n使用时自动补齐 #include <${info.header}>；对象名和参数可编辑。` : ''
}
const value = (text: string) => ({ block: literalBlock(text) })
export function libraryExportBlock(library: ProjectLibrary, item: LibraryExport): utils.toolbox.BlockInfo & { type: string } {
  const data = libraryBlockData(library, item)
  const parameters = item.parameters.filter(parameter => parameter.defaultValue === undefined)
  if (item.kind === 'value') return { kind: 'block', type: 'cpp_preview_value', fields: { TEXT: item.name }, data }
  const ownerName = item.owner?.split('::').at(-1) ?? 'device'
  const receiver = item.receiver ?? ownerName[0]!.toLowerCase() + ownerName.slice(1)
  if (item.kind === 'constructor') {
    const args = parameters.map(libraryParameterValue).join(', ')
    return { kind: 'block', type: 'cpp_preview_definition', fields: { TYPE: item.name, TEXT: args ? `${receiver}(${args})` : receiver }, data }
  }
  const call = { type: 'cpp_preview_library_call', data, fields: { LIBRARY: library.id, METHOD: libraryMethodKey(item), NAME: libraryCallName(item), RECEIVER: item.kind === 'method' ? libraryCallName(item).replace(/\.[^.]+$/, '') : '' },
    extraState: { count: parameters.length, parameters: parameters.map(parameter => parameter.name) }, inputs: Object.fromEntries(parameters.map((parameter, i) => [`ARG${i}`, value(libraryParameterValue(parameter))])) }
  return item.returnsVoid ? { kind: 'block', type: 'cpp_preview_statement', inputs: { VALUE: { block: call } } } : { kind: 'block', ...call }
}

export function libraryCategory(library: ProjectLibrary, api?: LibraryApi, notices: string[] = []): utils.toolbox.StaticCategoryInfo {
  const contents: utils.toolbox.FlyoutItemInfo[] = []
  const label = (text: string): void => { contents.push({ kind: 'label', text } as utils.toolbox.LabelInfo) }
  label(`${library.name}${library.version ? ` · ${library.version}` : ''}`)
  if (!api) label(notices.length ? notices.join('；') : '正在读取库的公开接口…')
  else {
    label(`${api.exports.length} 个接口 · 在积木中选择库和方法`)
    for (const header of new Set(api.exports.map(item => item.header))) contents.push({ kind: 'block', type: 'cpp_preview_directive', fields: { TEXT: `#include <${header}>` } })
    if (!api.exports.length) label('该库没有可转换的公开接口')
    for (const notice of [...new Set([...notices, ...api.notices])]) label(notice)
    for (const item of api.exports) {
      const signature = item.signature.replace(/\s+/g, ' ')
      label(`${item.conditional ? '[条件编译] ' : ''}${signature.length > 85 ? signature.slice(0, 82) + '…' : signature}`)
      contents.push(libraryExportBlock(library, item))
    }
  }
  return { kind: 'cppCategory', id: `cpp-library:${library.id}`, name: library.name, colour: '#54835e', contents } as utils.toolbox.StaticCategoryInfo
}

export function filterCppCategories(categories: utils.toolbox.StaticCategoryInfo[], query: string): utils.toolbox.StaticCategoryInfo[] {
  const search = query.trim().toLowerCase()
  if (!search) return categories
  return categories.map(category => {
    if (category.name.toLowerCase().includes(search)) return category
    const matches = (item: utils.toolbox.ToolboxItemInfo): boolean => `${JSON.stringify(item)} ${beginnerSearchText(item)}`.toLowerCase().includes(search)
    return { ...category, contents: category.contents.filter((item, i) => matches(item) || item.kind === 'label' && !!category.contents[i + 1] && matches(category.contents[i + 1]!)) }
  }).filter(category => category.contents.some(item => item.kind === 'block'))
}

/** Include only dependencies of blocks still present; undoing a drag removes them. */
export function addLibraryIncludes(code: string, roots: PreviewBlock[]): string {
  const needed = new Set<string>()
  const visit = (block: PreviewBlock): void => {
    const info = libraryBlockInfo(block.data)
    if (info) needed.add(info.header)
    for (const input of Object.values(block.inputs ?? {})) visit(input.block)
    if (block.next) visit(block.next.block)
  }
  roots.forEach(visit)
  if (!needed.size) return code
  // Includes inside a conditional do not make an unguarded call available.
  let depth = 0
  const includes = new Map(sourceIncludes(code).map(include => [include.line, include.header]))
  for (const [index, line] of maskCppComments(code).split(/\r?\n/).entries()) {
    if (/^\s*#\s*(?:if|ifdef|ifndef)\b/.test(line)) depth++
    else if (/^\s*#\s*endif\b/.test(line)) depth = Math.max(0, depth - 1)
    else if (!depth && includes.has(index + 1)) needed.delete(includes.get(index + 1)!)
  }
  if (!needed.size) return code
  const newline = code.includes('\r\n') ? '\r\n' : '\n'
  const prefix = [...needed].map(header => `#include <${header}>`).join(newline) + newline
  return code.startsWith('\uFEFF') ? '\uFEFF' + prefix + code.slice(1) : prefix + code
}
