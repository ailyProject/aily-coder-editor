import type { utils } from 'blockly'
import { coreCall, literalBlock } from './beginnerCatalog.js'
const value = (text: string) => ({ block: literalBlock(text) })
const note = (text: string) => ({ kind: 'label', text })
const block = (type: string, fields = {}, inputs = {}, extraState?: { count: number }) => ({ kind: 'block', type: `cpp_preview_${type}`, fields, inputs, ...(extraState ? { extraState } : {}) })
const callBlock = (name: string, args: string[]) => block(coreCall(name, args.length) ? 'action' : 'call', { NAME: name }, Object.fromEntries(args.map((arg, i) => [`ARG${i}`, value(arg)])), { count: args.length })
const call = (name: string, args: string[]) => block('statement', {}, { VALUE: { block: callBlock(name, args) } })
const binary = (OP: string, left = '0', right = '1') => block('binary', { OP }, { LEFT: value(left), RIGHT: value(right) })
const operation = (type: string, fields: Record<string, string>, inputs: Record<string, string> = {}) => block(type, fields, Object.fromEntries(Object.entries(inputs).map(([name, text]) => [name, value(text)])))
// Names follow lib-core-*/toolbox.json and i18n/zh_cn.json. Templates use only
// C++ projection blocks: no Blockly-mode generator or implicit initialization.
export const cppToolbox: utils.toolbox.ToolboxDefinition = {
  kind: 'categoryToolbox', contents: [
    { kind: 'cppCategory', name: '逻辑', colour: '#8872ae', contents: [
      note('满足条件才执行；点积木上的 + 添加其他情况'),
      block('if', {}, { CONDITION: value('true') }, { count: 0 }),
      block('if', {}, { CONDITION: value('true') }, { count: 1 }),
      note('比较或组合条件；运算方式可用下拉框更换'),
      binary('=='), binary('&&', 'true', 'false'),
      block('not', {}, { VALUE: value('true') }), block('choice', { TEXT: 'true' }),
      block('ternary', {}, { CONDITION: value('true'), THEN: value('1'), ELSE: value('0') }),
      note('多个情况的选择（进阶）'),
      block('switch', { HEADER: 'switch (value)', FOOTER: '' }, { BODY: { block: block('case', { HEADER: 'case 0:' }, { BODY: { block: block('flow', { TEXT: 'break;' }) } }) } }),
      block('case', { HEADER: 'case 0:' }, { BODY: { block: block('flow', { TEXT: 'break;' }) } }),
      block('case', { HEADER: 'default:' }, { BODY: { block: block('flow', { TEXT: 'break;' }) } })
    ] },
    { kind: 'cppCategory', name: '循环', colour: '#498570', contents: [
      note('程序入口：开机执行一次，然后不断重复'),
      block('function', { MODE: 'structured', TYPE: 'void', NAME: 'setup', PARAMETERS: '', SUFFIX: '', SIGNATURE: 'void setup()' }), block('function', { MODE: 'structured', TYPE: 'void', NAME: 'loop', PARAMETERS: '', SUFFIX: '', SIGNATURE: 'void loop()' }),
      note('把要重复的操作放进循环内部'),
      block('repeat', { COUNTER: 'i' }, { TIMES: value('10') }),
      block('while', { MODE: 'while' }, { CONDITION: value('true') }),
      block('flow', { TEXT: 'break;' }),
      note('完整 C++ 循环规则（进阶）'),
      block('loop', { HEADER: 'for (int i = 0; i < 10; i++)', FOOTER: '' }),
      block('scope')
    ] },
    { kind: 'cppCategory', name: '数学', colour: '#557da7', contents: [
      note('数字与运算'),
      block('value', { TEXT: '0' }), operation('number_base', { BASE: 'HEX', DIGITS: 'FF' }),
      operation('number_base', { BASE: 'BIN', DIGITS: '1010' }),
      binary('+'), binary('-', '5', '3'), binary('*', '6', '7'), binary('/', '8', '2'), binary('%', '7', '3'),
      callBlock('pow', ['2', '3']), block('group', {}, { VALUE: value('0') }),
      note('数值处理与比较'),
      operation('math_unary', { OP: 'ABS' }, { NUM: '-1' }),
      operation('math_unary', { OP: 'ROOT' }, { NUM: '9' }),
      operation('math_unary', { OP: 'ROUND' }, { NUM: '3.6' }),
      operation('math_round_decimal', {}, { NUM: '3.14159', DECIMALS: '2' }),
      callBlock('min', ['0', '1']), callBlock('max', ['0', '1']),
      callBlock('constrain', ['value', '0', '255']), callBlock('map', ['value', '0', '1023', '0', '255']),
      operation('math_property', { OP: 'EVEN' }, { NUM: '4', DIVISOR: '2' }),
      operation('math_property', { OP: 'PRIME' }, { NUM: '7', DIVISOR: '2' }),
      note('角度、常量与随机数'),
      operation('math_unary', { OP: 'SIN' }, { NUM: '90' }),
      operation('math_atan2', {}, { X: '1', Y: '1' }),
      operation('math_constant', { CONST: 'PI' }),
      operation('math_random_int', {}, { FROM: '0', TO: '99' }),
      operation('math_random_float', {}),
      note('位运算'),
      operation('math_bit_not', {}, { NUM: '0' }),
      binary('&', '5', '3'), binary('|', '5', '3'), binary('^', '5', '3'),
      binary('<<', '8', '2'), binary('>>', '8', '2'),
      operation('math_bit', { OP: 'READ' }, { NUM: '5', BIT: '1' }),
      operation('math_bit_write', {}, { NUM: '5', BIT: '1', VALUE: '1' }),
      operation('math_extract_bits', { OP: 'HIGH_BYTE' }, { NUM: '1234' }),
      operation('math_combine_bits', { OP: 'MAKE_WORD' }, { HIGH: '4', LOW: '210' })
    ] },
    { kind: 'cppCategory', name: '文字', colour: '#54835e', contents: [
      note('文字、字符与拼接'),
      block('text', { TEXT: '你好' }), block('text_char', { CHAR: 'A' }),
      operation('text_concat', {}, { LEFT: '"Hello"', RIGHT: '" world"' }),
      callBlock('String', ['123']),
      operation('text_code', { OP: 'CHAR' }, { INPUT: '65' }),
      operation('text_code', { OP: 'ASCII' }, { INPUT: "'A'" }),
      operation('text_code', { OP: 'STRING' }, { INPUT: '123' }),
      note('长度、查找与截取'),
      operation('text_unary', { OP: 'LENGTH' }, { TEXT: '"Hello"' }),
      operation('text_unary', { OP: 'EMPTY' }, { TEXT: '"Hello"' }),
      operation('text_binary', { OP: 'STARTS' }, { TEXT: '"Hello"', ARG: '"He"' }),
      operation('text_binary', { OP: 'ENDS' }, { TEXT: '"Hello"', ARG: '"lo"' }),
      operation('text_binary', { OP: 'INDEX' }, { TEXT: '"Hello"', ARG: '"l"' }),
      operation('text_binary', { OP: 'CHAR_AT' }, { TEXT: '"Hello"', ARG: '0' }),
      operation('text_binary', { OP: 'COUNT' }, { TEXT: '"Hello"', ARG: '"l"' }),
      operation('text_slice', {}, { TEXT: '"Hello"', START: '0', END: '3' }),
      note('转换与修改文字'),
      operation('text_unary', { OP: 'TO_INT' }, { TEXT: '"123"' }),
      operation('text_unary', { OP: 'TO_FLOAT' }, { TEXT: '"3.14"' }),
      operation('text_unary', { OP: 'UPPER' }, { TEXT: '"Hello"' }),
      operation('text_unary', { OP: 'LOWER' }, { TEXT: '"Hello"' }),
      operation('text_unary', { OP: 'TRIM' }, { TEXT: '" Hello "' }),
      operation('text_unary', { OP: 'REVERSE' }, { TEXT: '"Hello"' }),
      operation('text_replace', {}, { TEXT: '"Hello"', FROM: '"l"', TO: '"r"' })
    ] },
    { kind: 'cppCategory', name: '数组', colour: '#03a9f4', contents: [
      note('数组保存一组数据；下标从 0 开始'),
      block('declaration', { TYPE: 'int', DECL: 'values[]', INIT: '=' }, { VALUE: { block: block('list', { OPEN: '{', CLOSE: '}' }, { ARG0: value('0') }, { count: 1 }) } }),
      block('list', { OPEN: '{', CLOSE: '}' }, { ARG0: value('0') }, { count: 1 }),
      block('subscript', {}, { OBJECT: value('values'), INDEX: { block: block('list', { OPEN: '[', CLOSE: ']' }, { ARG0: value('0') }, { count: 1 }) } })
    ] },
    { kind: 'cppCategory', name: '变量', colour: '#b16a37', contents: [
      note('可创建新变量；源码中的变量会自动列在下方'),
      block('declaration', { TYPE: 'int', DECL: 'count', INIT: '=' }, { VALUE: value('0') }),
      block('definition', { TYPE: 'int', TEXT: 'count' }), block('value', { TEXT: 'count' }),
      block('statement', {}, { VALUE: { block: binary('=', 'count', '1') } }),
      block('member', { MEMBER: '.value' }, { OBJECT: value('object') })
    ] },
    { kind: 'cppCategory', name: '自定义函数', colour: '#9254b8', contents: [
      note('把一组操作命名为函数，之后可以重复调用'),
      block('function', { MODE: 'structured', TYPE: 'void', NAME: 'myFunction', PARAMETERS: '', SUFFIX: '', SIGNATURE: 'void myFunction()' }), block('lambda', { SIGNATURE: '[]()' }),
      block('return'), block('return', {}, { VALUE: value('0') }),
      call('functionName', []), callBlock('functionName', ['0']), block('statement')
    ] },
    { kind: 'cppCategory', name: 'I/O引脚', colour: '#367eae', contents: [
      note('先设置模式，再读取或输出；引脚按开发板填写'),
      call('pinMode', ['LED_BUILTIN', 'OUTPUT']), call('digitalWrite', ['LED_BUILTIN', 'HIGH']),
      block('choice', { TEXT: 'OUTPUT' }), block('choice', { TEXT: 'HIGH' }),
      callBlock('digitalRead', ['2']), callBlock('analogRead', ['A0']), call('analogWrite', ['3', '128'])
    ] },
    { kind: 'cppCategory', name: '时间', colour: '#498570', contents: [
      note('1000 毫秒 = 1 秒；下拉可切换为微秒'),
      call('delay', ['1000']), note('获取设备启动后经过的时间'), callBlock('millis', [])
    ] },
    { kind: 'cppCategory', name: '串口', colour: '#367eae', contents: [
      note('先启动串口；输出方式可选择是否换行'),
      call('Serial.begin', ['115200']), call('Serial.println', ['"你好"']),
      callBlock('Serial.available', []), callBlock('Serial.read', []), call('Serial.write', ['0']), call('Serial.flush', [])
    ] },
    { kind: 'cppCategory', name: '中断', colour: '#ad7530', contents: [
      note('信号发生变化时调用函数；需要开发板支持'),
      call('attachInterrupt', ['digitalPinToInterrupt(2)', 'onInterrupt', 'CHANGE']),
      call('detachInterrupt', ['digitalPinToInterrupt(2)']), call('interrupts', []), call('noInterrupts', [])
    ] },
    { kind: 'cppCategory', name: '自定义代码', colour: '#ad7530', contents: [
      note('这里可以保留注释、引用和复杂 C++ 原文'),
      block('comment', { TEXT: '// 注释' }), block('directive', { TEXT: '#include <Arduino.h>' }),
      block('raw', { TEXT: '/* 在下方属性中编辑完整 C++ */' }), block('raw_value', { TEXT: '0' })
    ] }
  ]
}
