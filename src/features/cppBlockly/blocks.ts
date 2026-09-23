import * as Blockly from 'blockly'

const prefix = 'cpp_preview_'
let registered = false

// Dedicated projection blocks deliberately do not reuse Aily library generators:
// an arbitrary C++ call must not acquire implicit pinMode/Serial.begin behavior.
export function registerCppPreviewBlocks(): void {
  if (registered) return
  registered = true
  const label = (name: string, text = '') => ({ type: 'field_input', name, text, spellcheck: false })
  const rawLabel = (name: string) => ({ type: 'field_label_serializable', name, text: '' })
  const value = (name: string) => ({ type: 'input_value', name })
  const body = (name: string) => ({ type: 'input_statement', name })
  const statement = { previousStatement: null, nextStatement: null }
  const definitions = [
    { type: 'function', message0: '函数 %1', args0: [label('SIGNATURE')], message1: '%1', args1: [body('BODY')], colour: '#9254b8', ...statement },
    { type: 'declaration', message0: '声明 %1 %2 %3', args0: [label('DECL'), label('INIT'), value('VALUE')], colour: '#b16a37', ...statement },
    { type: 'statement', message0: '执行 %1', args0: [value('VALUE')], colour: '#367eae', ...statement },
    { type: 'binary', message0: '%1 %2 %3', args0: [value('LEFT'), label('OP'), value('RIGHT')], inputsInline: true, output: null, colour: '#557da7' },
    { type: 'group', message0: '( %1 )', args0: [value('VALUE')], output: null, colour: '#557da7' },
    { type: 'unary', message0: '%1 %2 %3', args0: [label('BEFORE'), value('VALUE'), label('AFTER')], inputsInline: true, output: null, colour: '#557da7' },
    { type: 'value', message0: '%1', args0: [label('TEXT')], output: null, colour: '#54835e' },
    { type: 'raw_value', message0: 'C++ %1', args0: [rawLabel('TEXT')], output: null, colour: '#ad7530' },
    { type: 'raw', message0: '保留 C++ %1', args0: [rawLabel('TEXT')], colour: '#ad7530', ...statement },
    { type: 'comment', message0: '%1', args0: [rawLabel('TEXT')], colour: '#66747b', ...statement },
    { type: 'directive', message0: '%1', args0: [rawLabel('TEXT')], colour: '#66747b', ...statement },
    { type: 'loop', message0: '%1', args0: [label('HEADER')], message1: '%1', args1: [body('BODY')], message2: '%1', args2: [label('FOOTER')], colour: '#498570', ...statement },
    { type: 'scope', message0: '作用域 { %1 }', args0: [body('BODY')], colour: '#498570', ...statement },
    { type: 'return', message0: '返回 %1', args0: [value('VALUE')], colour: '#9254b8', ...statement },
    { type: 'flow', message0: '%1', args0: [label('TEXT')], colour: '#498570', ...statement },
    { type: 'definition', message0: '声明 %1', args0: [label('TEXT')], colour: '#b16a37', ...statement },
    { type: 'container', message0: '%1', args0: [label('HEADER')], message1: '%1', args1: [body('BODY')], message2: '%1', args2: [label('FOOTER')], colour: '#75619e', ...statement },
    { type: 'lambda', message0: '回调 %1', args0: [label('SIGNATURE')], message1: '%1', args1: [body('BODY')], colour: '#9254b8', output: null },
    { type: 'data', message0: '%1 %2', args0: [rawLabel('TEXT'), rawLabel('CODE')], colour: '#687e45', output: null },
    { type: 'annotation', message0: '%1 %2', args0: [label('TEXT'), value('VALUE')], colour: '#66747b', output: null },
    { type: 'member', message0: '%1 %2', args0: [value('OBJECT'), label('MEMBER')], colour: '#367eae', inputsInline: true, output: null },
    { type: 'subscript', message0: '%1 %2', args0: [value('OBJECT'), value('INDEX')], colour: '#557da7', inputsInline: true, output: null },
    { type: 'ternary', message0: '%1 ? %2 : %3', args0: [value('CONDITION'), value('THEN'), value('ELSE')], colour: '#8872ae', inputsInline: true, output: null }
  ]
  Blockly.Extensions.register('cpp_source_fields', function(this: Blockly.Block) {
    for (const input of this.inputList) for (const field of input.fieldRow) field.maxDisplayLength = 64
    this.getField('CODE')?.setVisible(false)
  })
  Blockly.common.defineBlocksWithJsonArray(definitions.map(d => ({ ...d, type: prefix + d.type, extensions: ['cpp_source_fields'] })))
  for (const type of ['call', 'invoke', 'list', 'if']) Blockly.Blocks[prefix + type] = {
    init(this: DynamicBlock) {
      this.argumentCount = 0
      if (type === 'if') {
        this.appendValueInput('CONDITION').appendField('如果')
        this.appendStatementInput('THEN').appendField('那么')
        this.setPreviousStatement(true); this.setNextStatement(true); this.setColour('#8872ae')
      } else {
        if (type === 'call') this.appendDummyInput().appendField('调用').appendField(new Blockly.FieldTextInput('functionName'), 'NAME')
        if (type === 'invoke') this.appendValueInput('FUNCTION').appendField('调用')
        if (type === 'list') this.appendDummyInput().appendField(new Blockly.FieldTextInput('{'), 'OPEN')
        this.setOutput(true); this.setColour(type === 'list' ? '#54835e' : '#367eae'); this.setInputsInline(true)
      }
      this.loadExtraState!({ count: 0 })
    },
    saveExtraState(this: DynamicBlock) { return { count: this.argumentCount } },
    loadExtraState(this: DynamicBlock, state: { count: number }) {
      const count = Math.max(0, Math.min(type === 'if' ? 1 : 2000, Math.trunc(state.count || 0)))
      if (type === 'if') {
        if (count && !this.getInput('ELSE')) this.appendStatementInput('ELSE').appendField('否则')
        if (!count && this.getInput('ELSE')) this.removeInput('ELSE')
      } else {
        const close = this.getFieldValue('CLOSE') || '}'
        this.removeInput('END', true)
        for (let i = this.argumentCount; i > count; i--) this.removeInput(`ARG${i - 1}`, true)
        for (let i = 0; i < count; i++) if (!this.getInput(`ARG${i}`)) this.appendValueInput(`ARG${i}`).appendField(i ? ',' : type === 'list' ? '' : '(')
        const end = this.appendDummyInput('END')
        if (type === 'list') end.appendField(new Blockly.FieldTextInput(close), 'CLOSE')
        else end.appendField(count ? ')' : '()')
      }
      this.argumentCount = count
    },
    customContextMenu(this: DynamicBlock, options: Blockly.ContextMenuRegistry.LegacyContextMenuOption[]) {
      const count = this.argumentCount
      options.push({ text: type === 'if' ? (count ? '移除否则分支' : '添加否则分支') : '添加参数', enabled: true, callback: () => resizeCppInputs(this, type === 'if' ? 1 - count : count + 1) })
      if (type !== 'if') options.push({ text: '移除最后一个参数', enabled: count > 0, callback: () => resizeCppInputs(this, count - 1) })
    }
  }
}

interface DynamicBlock extends Blockly.Block { argumentCount: number }
export function resizeCppInputs(block: Blockly.Block, count: number): void {
  if (!block.loadExtraState || !block.saveExtraState) return
  const old = JSON.stringify(block.saveExtraState())
  Blockly.Events.setGroup(true)
  try {
    block.loadExtraState({ count })
    Blockly.Events.fire(new Blockly.Events.BlockChange(block, 'mutation', null, old, JSON.stringify(block.saveExtraState())))
  } finally { Blockly.Events.setGroup(false) }
}

export { Blockly }
