import * as Blockly from 'blockly'

const prefix = 'cpp_preview_'
let registered = false

// Dedicated projection blocks deliberately do not reuse Aily library generators:
// an arbitrary C++ call must not acquire implicit pinMode/Serial.begin behavior.
export function registerCppPreviewBlocks(): void {
  if (registered) return
  registered = true
  const label = (name: string, text = '') => ({ type: 'field_label_serializable', name, text })
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
    { type: 'raw_value', message0: 'C++ %1', args0: [label('TEXT')], output: null, colour: '#ad7530' },
    { type: 'raw', message0: '保留 C++ %1', args0: [label('TEXT')], colour: '#ad7530', ...statement },
    { type: 'comment', message0: '%1', args0: [label('TEXT')], colour: '#66747b', ...statement },
    { type: 'directive', message0: '%1', args0: [label('TEXT')], colour: '#66747b', ...statement },
    { type: 'loop', message0: '%1', args0: [label('HEADER')], message1: '%1', args1: [body('BODY')], message2: '%1', args2: [label('FOOTER')], colour: '#498570', ...statement },
    { type: 'scope', message0: '作用域 { %1 }', args0: [body('BODY')], colour: '#498570', ...statement },
    { type: 'return', message0: '返回 %1', args0: [value('VALUE')], colour: '#9254b8', ...statement },
    { type: 'flow', message0: '%1', args0: [label('TEXT')], colour: '#498570', ...statement },
    { type: 'definition', message0: '声明 %1', args0: [label('TEXT')], colour: '#b16a37', ...statement },
    { type: 'container', message0: '%1', args0: [label('HEADER')], message1: '%1', args1: [body('BODY')], message2: '%1', args2: [label('FOOTER')], colour: '#75619e', ...statement },
    { type: 'lambda', message0: '回调 %1', args0: [label('SIGNATURE')], message1: '%1', args1: [body('BODY')], colour: '#9254b8', output: null },
    { type: 'data', message0: '%1', args0: [label('TEXT')], colour: '#687e45', output: null },
    { type: 'annotation', message0: '%1 %2', args0: [label('TEXT'), value('VALUE')], colour: '#66747b', output: null },
    { type: 'member', message0: '%1 %2', args0: [value('OBJECT'), label('MEMBER')], colour: '#367eae', inputsInline: true, output: null },
    { type: 'subscript', message0: '%1 %2', args0: [value('OBJECT'), value('INDEX')], colour: '#557da7', inputsInline: true, output: null },
    { type: 'ternary', message0: '%1 ? %2 : %3', args0: [value('CONDITION'), value('THEN'), value('ELSE')], colour: '#8872ae', inputsInline: true, output: null }
  ]
  Blockly.common.defineBlocksWithJsonArray(definitions.map(d => ({ ...d, type: prefix + d.type })))
  Blockly.Blocks[prefix + 'call'] = {
    init(this: Blockly.Block) {
      this.appendDummyInput().appendField('调用').appendField(new Blockly.FieldLabelSerializable(''), 'NAME')
      this.setOutput(true)
      this.setColour('#367eae')
      this.setInputsInline(true)
    },
    loadExtraState(this: Blockly.Block, state: { count: number }) {
      for (let i = 0; i < state.count; i++) this.appendValueInput(`ARG${i}`).appendField(i === 0 ? '(' : ',')
      this.appendDummyInput().appendField(state.count ? ')' : '()')
    }
  }
  Blockly.Blocks[prefix + 'if'] = {
    init(this: Blockly.Block) {
      this.appendValueInput('CONDITION').appendField('如果')
      this.appendStatementInput('THEN').appendField('那么')
      this.setPreviousStatement(true); this.setNextStatement(true)
      this.setColour('#8872ae')
    },
    loadExtraState(this: Blockly.Block, state: { count: number }) {
      if (state.count) this.appendStatementInput('ELSE').appendField('否则')
    }
  }
  for (const type of ['list', 'invoke']) Blockly.Blocks[prefix + type] = {
    init(this: Blockly.Block) {
      if (type === 'invoke') this.appendValueInput('FUNCTION').appendField('调用')
      else this.appendDummyInput().appendField(new Blockly.FieldLabelSerializable(''), 'OPEN')
      this.setOutput(true); this.setColour(type === 'list' ? '#54835e' : '#367eae'); this.setInputsInline(true)
    },
    loadExtraState(this: Blockly.Block, state: { count: number }) {
      for (let i = 0; i < state.count; i++) this.appendValueInput(`ARG${i}`).appendField(i ? ',' : type === 'invoke' ? '(' : '')
      const end = this.appendDummyInput()
      if (type === 'list') end.appendField(new Blockly.FieldLabelSerializable(''), 'CLOSE')
      else end.appendField(state.count ? ')' : '()')
    }
  }
}

export { Blockly }
