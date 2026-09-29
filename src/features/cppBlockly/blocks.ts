import * as Blockly from 'blockly'
import { registerCppQuickItems } from './quickItems.js'
import { CppTypeField } from './typeField.js'
import { libraryBlockTooltip } from './libraryToolbox.js'
import { CppOptionsField, CppSignatureField, updateActionLabels } from './beginnerFields.js'
import { blockHelp } from './beginnerCatalog.js'
import { CppTextField } from './fieldFocus.js'
import { CppLibraryField, CppLibraryMethodField, CppLibraryReceiverField } from './librarySelection.js'
export { resizeCppInputs } from './quickItems.js'

const prefix = 'cpp_preview_'
let registered = false

// Dedicated projection blocks deliberately do not reuse Aily library generators:
// an arbitrary C++ call must not acquire implicit pinMode/Serial.begin behavior.
export function registerCppPreviewBlocks(): void {
  if (registered) return
  registered = true
  registerCppQuickItems()
  Blockly.fieldRegistry.register('field_cpp_type', CppTypeField)
  Blockly.fieldRegistry.register('field_cpp_options', CppOptionsField)
  Blockly.fieldRegistry.register('field_cpp_signature', CppSignatureField)
  Blockly.fieldRegistry.register('field_cpp_text', CppTextField)
  const choice = (name: string, cppKind: string) => ({ type: 'field_cpp_options', name, cppKind })
  const label = (name: string, text = '') => ({ type: 'field_cpp_text', name, text, spellcheck: false })
  const rawLabel = (name: string) => ({ type: 'field_label_serializable', name, text: '' })
  const value = (name: string) => ({ type: 'input_value', name })
  const body = (name: string) => ({ type: 'input_statement', name })
  const statement = { previousStatement: null, nextStatement: null }
  const definitions = [
    { type: 'declaration', message0: '创建 %1 %2 变量 %3', args0: [choice('QUALIFIERS', 'qualifiers'), { type: 'field_cpp_type', name: 'TYPE' }, label('DECL')], message1: '初始值 %1 %2', args1: [rawLabel('INIT'), value('VALUE')], colour: '#b16a37', ...statement },
    { type: 'statement', message0: '执行 %1', args0: [value('VALUE')], colour: '#367eae', ...statement },
    { type: 'binary', message0: '%1 %2 %3', args0: [value('LEFT'), choice('OP', 'operator'), value('RIGHT')], inputsInline: true, output: null, colour: '#557da7' },
    { type: 'group', message0: '( %1 )', args0: [value('VALUE')], output: null, colour: '#557da7' },
    { type: 'unary', message0: '%1 %2 %3', args0: [label('BEFORE'), value('VALUE'), label('AFTER')], inputsInline: true, output: null, colour: '#557da7' },
    { type: 'value', message0: '%1', args0: [label('TEXT')], output: null, colour: '#54835e' },
    { type: 'choice', message0: '%1', args0: [choice('TEXT', 'constant')], output: null, colour: '#8872ae' },
    { type: 'text', message0: '文字 %1', args0: [label('TEXT')], output: null, colour: '#54835e' },
    { type: 'not', message0: '条件不成立 %1', args0: [value('VALUE')], output: null, colour: '#8872ae' },
    { type: 'raw_value', message0: 'C++ %1', args0: [rawLabel('TEXT')], output: null, colour: '#ad7530' },
    { type: 'raw', message0: '保留 C++ %1', args0: [rawLabel('TEXT')], colour: '#ad7530', ...statement },
    { type: 'comment', message0: '%1', args0: [rawLabel('TEXT')], colour: '#66747b', ...statement },
    { type: 'directive', message0: '%1', args0: [rawLabel('TEXT')], colour: '#66747b', ...statement },
    { type: 'repeat', message0: '重复 %1 次 %2', args0: [value('TIMES'), { type: 'input_end_row' }], message1: '计数变量 %1 从 0 开始 %2', args1: [label('COUNTER', 'i'), { type: 'input_end_row' }], message2: '每次执行 %1', args2: [body('BODY')], inputsInline: true, colour: '#498570', ...statement },
    { type: 'while', message0: '%1 %2', args0: [choice('MODE', 'while'), value('CONDITION')], message1: '每次执行 %1', args1: [body('BODY')], colour: '#498570', ...statement },
    { type: 'loop', message0: '循环规则 %1', args0: [label('HEADER')], message1: '每次执行 %1', args1: [body('BODY')], message2: '%1', args2: [label('FOOTER')], colour: '#498570', ...statement },
    { type: 'switch', message0: '%1', args0: [label('HEADER')], message1: '%1', args1: [body('BODY')], message2: '%1', args2: [label('FOOTER')], colour: '#498570', ...statement },
    { type: 'case', message0: '%1', args0: [label('HEADER')], message1: '%1', args1: [body('BODY')], colour: '#498570', ...statement },
    { type: 'scope', message0: '作用域 { %1 }', args0: [body('BODY')], colour: '#498570', ...statement },
    { type: 'return', message0: '结束函数，返回 %1', args0: [value('VALUE')], colour: '#9254b8', ...statement },
    { type: 'flow', message0: '%1', args0: [choice('TEXT', 'flow')], colour: '#498570', ...statement },
    { type: 'definition', message0: '创建 %1 %2 变量 / 对象 %3', args0: [choice('QUALIFIERS', 'qualifiers'), { type: 'field_cpp_type', name: 'TYPE' }, label('TEXT')], colour: '#b16a37', ...statement },
    { type: 'container', message0: '%1', args0: [label('HEADER')], message1: '%1', args1: [body('BODY')], message2: '%1', args2: [label('FOOTER')], colour: '#75619e', ...statement },
    { type: 'lambda', message0: '回调 %1', args0: [label('SIGNATURE')], message1: '%1', args1: [body('BODY')], colour: '#9254b8', output: null },
    { type: 'data', message0: '%1 %2', args0: [rawLabel('TEXT'), rawLabel('CODE')], colour: '#687e45', output: null },
    { type: 'annotation', message0: '%1 %2', args0: [label('TEXT'), value('VALUE')], colour: '#66747b', output: null },
    { type: 'member', message0: '%1 %2', args0: [value('OBJECT'), label('MEMBER')], colour: '#367eae', inputsInline: true, output: null },
    { type: 'subscript', message0: '%1 %2', args0: [value('OBJECT'), value('INDEX')], colour: '#557da7', inputsInline: true, output: null },
    { type: 'ternary', message0: '如果 %1', args0: [value('CONDITION')], message1: '成立时取 %1', args1: [value('THEN')], message2: '否则取 %1', args2: [value('ELSE')], colour: '#8872ae', output: null }
  ]
  Blockly.Extensions.register('cpp_source_fields', function(this: Blockly.Block) {
    for (const input of this.inputList) for (const field of input.fieldRow) field.maxDisplayLength = 64
    this.getField('CODE')?.setVisible(false)
    this.getField('INIT')?.setVisible(false)
    this.setTooltip(() => libraryBlockTooltip(this.data) || blockHelp[this.type.slice(prefix.length)] || '连接积木来编辑 C++；点击字段可以修改。')
  })
  Blockly.common.defineBlocksWithJsonArray(definitions.map(d => ({ ...d, type: prefix + d.type, extensions: ['cpp_source_fields', ...(d.type === 'switch' ? ['cpp_quick_items'] : [])] })))
  Blockly.Blocks[prefix + 'function'] = {
    init(this: Blockly.Block) {
      this.appendDummyInput('RAW').appendField(new CppSignatureField('void myFunction()'), 'SIGNATURE')
      this.appendDummyInput('STRUCTURED').appendField('定义')
        .appendField(new CppOptionsField('qualifiers'), 'QUALIFIERS')
        .appendField(new CppTypeField(), 'TYPE')
        .appendField('函数').appendField(new CppTextField('myFunction'), 'NAME')
        .appendField('(').appendField(new CppTextField(''), 'PARAMETERS')
        .appendField(')').appendField(new CppTextField(''), 'SUFFIX')
      this.appendDummyInput('MODE_ROW').appendField(new Blockly.FieldLabelSerializable('structured'), 'MODE')
      this.appendStatementInput('BODY').appendField('按顺序执行')
      this.setPreviousStatement(true); this.setNextStatement(true); this.setColour('#9254b8')
      this.getInput('MODE_ROW')?.setVisible(false)
      this.getInput('RAW')?.setVisible(false)
      this.getField('TYPE')?.setValue('void')
      this.setTooltip(blockHelp.function ?? '')
    }
  }
  for (const type of ['call', 'library_call', 'action', 'invoke', 'list', 'if']) Blockly.Blocks[prefix + type] = {
    init(this: DynamicBlock) {
      this.argumentCount = 0
      this.parameterLabels = []
      this.setTooltip(() => libraryBlockTooltip(this.data) || blockHelp[type] || '')
      if (type === 'if') {
        this.appendValueInput('CONDITION').appendField('如果')
        this.appendStatementInput('THEN').appendField('成立时执行')
        this.setPreviousStatement(true); this.setNextStatement(true); this.setColour('#8872ae')
      } else {
        if (type === 'call') this.appendDummyInput().appendField('调用').appendField(new CppTextField('functionName'), 'NAME')
        if (type === 'library_call') this.appendDummyInput().appendField('库').appendField(new CppLibraryField(), 'LIBRARY').appendField('方法').appendField(new CppLibraryMethodField(), 'METHOD').appendField(new Blockly.FieldLabel('对象'), 'RECEIVER_LABEL').appendField(new CppLibraryReceiverField(''), 'RECEIVER').appendField(new Blockly.FieldLabelSerializable(''), 'NAME')
        if (type === 'library_call') this.getField('NAME')?.setVisible(false)
        if (type === 'library_call') { this.getField('RECEIVER')?.setVisible(false); this.getField('RECEIVER_LABEL')?.setVisible(false) }
        if (type === 'action') this.appendDummyInput().appendField(new CppOptionsField('action'), 'NAME')
        if (type === 'invoke') this.appendValueInput('FUNCTION').appendField('调用')
        if (type === 'list') this.appendDummyInput().appendField(new CppTextField('{'), 'OPEN')
        this.setOutput(true); this.setColour(type === 'list' ? '#54835e' : '#367eae'); this.setInputsInline(true)
      }
      this.loadExtraState!({ count: 0 })
      if (type !== 'action') Blockly.Extensions.apply('cpp_quick_items', this, false)
    },
    saveExtraState(this: DynamicBlock) { return { count: this.argumentCount, ...(this.parameterLabels.length ? { parameters: this.parameterLabels } : {}) } },
    loadExtraState(this: DynamicBlock, state: { count: number; parameters?: string[] }) {
      const count = Math.max(0, Math.min(type === 'if' ? 1 : 2000, Math.trunc(state.count || 0)))
      this.parameterLabels = (state.parameters ?? this.parameterLabels).slice(0, count)
      if (type === 'if') {
        if (count && !this.getInput('ELSE')) this.appendStatementInput('ELSE').appendField('否则')
        if (!count && this.getInput('ELSE')) this.removeInput('ELSE')
      } else {
        const close = this.getFieldValue('CLOSE') || '}'
        this.removeInput('END', true)
        for (let i = this.argumentCount; i > count; i--) this.removeInput(`ARG${i - 1}`, true)
        for (let i = 0; i < count; i++) if (!this.getInput(`ARG${i}`)) {
          const input = this.appendValueInput(`ARG${i}`)
          if (type === 'action') input.appendField(new Blockly.FieldLabel(`参数 ${i + 1}`), `LABEL${i}`)
          else if (type === 'list') input.appendField(i ? ',' : '')
          else input.appendField(new Blockly.FieldLabel(`参数 ${i + 1}`), `LABEL${i}`)
        }
        if (type !== 'action' && type !== 'list') for (let i = 0; i < count; i++) this.getField(`LABEL${i}`)?.setValue(this.parameterLabels[i] ? `参数 ${this.parameterLabels[i]}` : `参数 ${i + 1}`)
        const end = this.appendDummyInput('END')
        if (type === 'list') end.appendField(new CppTextField(close), 'CLOSE')
        else if (type === 'action') { end.appendField(new Blockly.FieldLabel(''), 'SUFFIX'); updateActionLabels(this) }
      }
      this.argumentCount = count
    }
  }
}

interface DynamicBlock extends Blockly.Block { argumentCount: number; parameterLabels: string[] }

export { Blockly }

export function updateFunctionDisplay(block: Blockly.Block): void {
  if (block.type !== 'cpp_preview_function') return
  const raw = block.getFieldValue('MODE') === 'raw'
  block.getInput('RAW')?.setVisible(raw)
  block.getInput('STRUCTURED')?.setVisible(!raw)
}
