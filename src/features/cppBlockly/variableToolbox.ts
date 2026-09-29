import type { utils } from 'blockly'
import type { CppVariable } from './types.js'

const previewBlock = (type: string, fields: Record<string, string> = {}, inputs: Record<string, unknown> = {}) => ({ kind: 'block', type: `cpp_preview_${type}`, fields, inputs })

/** Source bindings extend the existing Coder variable category without borrowing Arduino generators. */
export function cppVariableCategory(base: utils.toolbox.StaticCategoryInfo, variables: readonly CppVariable[]): utils.toolbox.StaticCategoryInfo {
  if (!variables.length) return { ...base, contents: [...base.contents, { kind: 'label', text: '源码中尚未识别到变量' } as utils.toolbox.LabelInfo] }
  const contents: utils.toolbox.FlyoutItemInfo[] = [...base.contents, { kind: 'label', text: `源码变量 · ${variables.length} 个 · 拖动读取或赋值积木` } as utils.toolbox.LabelInfo]
  for (const variable of variables) {
    const uses = Math.max(0, variable.references.length - 1)
    contents.push({ kind: 'label', text: `${variable.name} · ${variable.dataType || '自动类型'} · ${variable.scope} · ${uses} 处使用` } as utils.toolbox.LabelInfo)
    const getter = previewBlock('variable', { NAME: variable.name })
    contents.push(getter as utils.toolbox.BlockInfo)
    if (!/\bconst\b|\bconstexpr\b/.test(variable.dataType)) contents.push(previewBlock('statement', {}, {
      VALUE: { block: previewBlock('binary', { OP: '=' }, {
        LEFT: { block: previewBlock('variable', { NAME: variable.name }) },
        RIGHT: { block: previewBlock('value', { TEXT: '1' }) }
      }) }
    }) as utils.toolbox.BlockInfo)
    contents.push({ kind: 'button', text: `重命名 ${variable.name} 的全部引用`, callbackkey: `cpp-rename:${variable.id}` } as utils.toolbox.ButtonInfo)
  }
  return { ...base, id: 'cpp-variables', contents }
}
