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
  const dropdown = (name: string, options: Array<[string, string]>) => ({ type: 'field_dropdown', name, options })
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
    { type: 'variable', message0: '变量 %1', args0: [label('NAME', 'count')], output: null, colour: '#b16a37' },
    { type: 'choice', message0: '%1', args0: [choice('TEXT', 'constant')], output: null, colour: '#8872ae' },
    { type: 'text', message0: '文字 %1', args0: [label('TEXT')], output: null, colour: '#54835e' },
    { type: 'text_char', message0: '字符 %1', args0: [label('CHAR', 'A')], output: null, colour: '#54835e' },
    { type: 'text_concat', message0: '拼接文字 %1 和 %2', args0: [value('LEFT'), value('RIGHT')], inputsInline: true, output: null, colour: '#54835e' },
    { type: 'text_unary', message0: '文字 %1 内容 %2', args0: [dropdown('OP', [['长度', 'LENGTH'], ['是否为空', 'EMPTY'], ['转整数', 'TO_INT'], ['转长整数', 'TO_LONG'], ['转小数', 'TO_FLOAT'], ['转双精度', 'TO_DOUBLE'], ['第一个字符', 'FIRST'], ['最后一个字符', 'LAST'], ['转大写', 'UPPER'], ['转小写', 'LOWER'], ['去两端空格', 'TRIM'], ['反转', 'REVERSE']]), value('TEXT')], output: null, colour: '#54835e' },
    { type: 'text_binary', message0: '文字 %1 内容 %2 参数 %3', args0: [dropdown('OP', [['以此开头', 'STARTS'], ['以此结尾', 'ENDS'], ['首次出现位置', 'INDEX'], ['末次出现位置', 'LAST_INDEX'], ['取指定字符', 'CHAR_AT'], ['出现次数', 'COUNT']]), value('TEXT'), value('ARG')], inputsInline: true, output: null, colour: '#54835e' },
    { type: 'text_slice', message0: '截取文字 %1', args0: [value('TEXT')], message1: '从 %1 到 %2（不含）', args1: [value('START'), value('END')], inputsInline: true, output: null, colour: '#54835e' },
    { type: 'text_replace', message0: '替换文字 %1', args0: [value('TEXT')], message1: '查找 %1 替换成 %2', args1: [value('FROM'), value('TO')], inputsInline: true, output: null, colour: '#54835e' },
    { type: 'text_code', message0: '转换 %1 内容 %2', args0: [dropdown('OP', [['编码转字符', 'CHAR'], ['字符转编码', 'ASCII'], ['数字转文字', 'STRING']]), value('INPUT')], output: null, colour: '#54835e' },
    { type: 'number_base', message0: '进制 %1 数字 %2', args0: [dropdown('BASE', [['十进制', 'DEC'], ['十六进制', 'HEX'], ['二进制', 'BIN']]), label('DIGITS', '42')], output: null, colour: '#557da7' },
    { type: 'math_unary', message0: '数学 %1 数值 %2', args0: [dropdown('OP', [['绝对值', 'ABS'], ['取负', 'NEG'], ['平方根', 'ROOT'], ['自然对数', 'LN'], ['常用对数', 'LOG10'], ['指数 e 的幂', 'EXP'], ['10 的幂', 'POW10'], ['四舍五入', 'ROUND'], ['向上取整', 'CEIL'], ['向下取整', 'FLOOR'], ['正弦（角度）', 'SIN'], ['余弦（角度）', 'COS'], ['正切（角度）', 'TAN'], ['反正弦（角度）', 'ASIN'], ['反余弦（角度）', 'ACOS'], ['反正切（角度）', 'ATAN']]), value('NUM')], output: null, colour: '#557da7' },
    { type: 'math_constant', message0: '数学常量 %1', args0: [dropdown('CONST', [['圆周率 π', 'PI'], ['自然常数 e', 'E'], ['黄金比例', 'GOLDEN'], ['根号 2', 'SQRT2'], ['二分之一根号 2', 'SQRT_HALF'], ['无穷大', 'INFINITY']])], output: null, colour: '#557da7' },
    { type: 'math_property', message0: '判断 %1 数值 %2', args0: [dropdown('OP', [['偶数', 'EVEN'], ['奇数', 'ODD'], ['整数', 'WHOLE'], ['正数', 'POSITIVE'], ['负数', 'NEGATIVE'], ['可整除', 'DIVISIBLE'], ['质数', 'PRIME']]), value('NUM')], message1: '除数（可整除时） %1', args1: [value('DIVISOR')], output: null, colour: '#557da7' },
    { type: 'math_random_int', message0: '随机整数 从 %1 到 %2（含）', args0: [value('FROM'), value('TO')], inputsInline: true, output: null, colour: '#557da7' },
    { type: 'math_random_float', message0: '随机小数 0 至 1', output: null, colour: '#557da7' },
    { type: 'math_atan2', message0: '两点夹角 X %1 Y %2（角度）', args0: [value('X'), value('Y')], inputsInline: true, output: null, colour: '#557da7' },
    { type: 'math_round_decimal', message0: '保留小数 数值 %1 位数 %2', args0: [value('NUM'), value('DECIMALS')], inputsInline: true, output: null, colour: '#557da7' },
    { type: 'math_bit_not', message0: '按位取反 %1', args0: [value('NUM')], output: null, colour: '#557da7' },
    { type: 'math_bit', message0: '位运算 %1 数值 %2 位 %3', args0: [dropdown('OP', [['读取', 'READ'], ['置为 1', 'SET'], ['清零', 'CLEAR']]), value('NUM'), value('BIT')], inputsInline: true, output: null, colour: '#557da7' },
    { type: 'math_bit_write', message0: '写入位 数值 %1 位 %2 值 %3', args0: [value('NUM'), value('BIT'), value('VALUE')], inputsInline: true, output: null, colour: '#557da7' },
    { type: 'math_extract_bits', message0: '提取 %1 数值 %2', args0: [dropdown('OP', [['高字节', 'HIGH_BYTE'], ['低字节', 'LOW_BYTE'], ['高 16 位', 'HIGH_WORD'], ['低 16 位', 'LOW_WORD']]), value('NUM')], output: null, colour: '#557da7' },
    { type: 'math_combine_bits', message0: '组合 %1 高位 %2 低位 %3', args0: [dropdown('OP', [['16 位', 'MAKE_WORD'], ['32 位', 'MAKE_DWORD']]), value('HIGH'), value('LOW')], inputsInline: true, output: null, colour: '#557da7' },
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
