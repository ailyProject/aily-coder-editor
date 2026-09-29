import type { utils } from 'blockly'
import { coreCall, literalBlock } from './beginnerCatalog.js'
const value = (text: string) => ({ block: literalBlock(text) })
const note = (text: string) => ({ kind: 'label', text })
const block = (type: string, fields = {}, inputs = {}, extraState?: { count: number }) => ({ kind: 'block', type: `cpp_preview_${type}`, fields, inputs, ...(extraState ? { extraState } : {}) })
const callBlock = (name: string, args: string[]) => block(coreCall(name, args.length) ? 'action' : 'call', { NAME: name }, Object.fromEntries(args.map((arg, i) => [`ARG${i}`, value(arg)])), { count: args.length })
const call = (name: string, args: string[]) => block('statement', {}, { VALUE: { block: callBlock(name, args) } })
const binary = (OP: string, left = '0', right = '1') => block('binary', { OP }, { LEFT: value(left), RIGHT: value(right) })
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
      note('数值可以直接修改；加减乘除用下拉框选择'),
      block('value', { TEXT: '0' }), binary('+'),
      block('group', {}, { VALUE: value('0') }),
      callBlock('abs', ['-1']), callBlock('min', ['0', '1']), callBlock('max', ['0', '1']),
      callBlock('constrain', ['value', '0', '255']), callBlock('map', ['value', '0', '1023', '0', '255']), callBlock('random', ['0', '100'])
    ] },
    { kind: 'cppCategory', name: '文字', colour: '#54835e', contents: [
      note('直接输入文字，不用自己加引号'),
      block('text', { TEXT: '你好' }),
      callBlock('String', ['123']), binary('+', 'String("Hello")', '" world"'),
      note('字符及 String 对象方法（进阶）'), block('value', { TEXT: "'a'" }),
      callBlock('text.length', []), callBlock('text.substring', ['0', '3']), callBlock('text.toInt', [])
    ] },
    { kind: 'cppCategory', name: '数组', colour: '#03a9f4', contents: [
      note('数组保存一组数据；下标从 0 开始'),
      block('declaration', { TYPE: 'int', DECL: 'values[]', INIT: '=' }, { VALUE: { block: block('list', { OPEN: '{', CLOSE: '}' }, { ARG0: value('0') }, { count: 1 }) } }),
      block('list', { OPEN: '{', CLOSE: '}' }, { ARG0: value('0') }, { count: 1 }),
      block('subscript', {}, { OBJECT: value('values'), INDEX: { block: block('list', { OPEN: '[', CLOSE: ']' }, { ARG0: value('0') }, { count: 1 }) } })
    ] },
    { kind: 'cppCategory', name: '变量', colour: '#b16a37', contents: [
      note('先创建变量；之后可读取、设值或增加数值'),
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
