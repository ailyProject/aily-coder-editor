import type { utils } from 'blockly'
const value = (text: string) => ({ block: { type: 'cpp_preview_value', fields: { TEXT: text } } })
const block = (type: string, fields = {}, inputs = {}, extraState?: { count: number }) => ({ kind: 'block', type: `cpp_preview_${type}`, fields, inputs, ...(extraState ? { extraState } : {}) })
const call = (name: string, args: string[]) => ({ block: block('call', { NAME: name }, Object.fromEntries(args.map((arg, i) => [`ARG${i}`, value(arg)])), { count: args.length }) })
export const cppToolbox: utils.toolbox.ToolboxDefinition = {
  kind: 'categoryToolbox', contents: [
    { kind: 'category', name: '调用', colour: '#367eae', contents: [
      block('statement', {}, { VALUE: call('delay', ['1000']) }),
      block('statement', {}, { VALUE: call('digitalWrite', ['LED_BUILTIN', 'HIGH']) }),
      block('statement', {}, { VALUE: call('Serial.println', ['"Hello"']) }),
      block('statement', {}, { VALUE: call('functionName', []) }),
      block('call', { NAME: 'functionName' }, { ARG0: value('0') }, { count: 1 }), block('statement')
    ] },
    { kind: 'category', name: '控制', colour: '#498570', contents: [
      block('if', {}, { CONDITION: value('true') }, { count: 0 }),
      block('if', {}, { CONDITION: value('true') }, { count: 1 }),
      block('loop', { HEADER: 'for (int i = 0; i < 10; i++)', FOOTER: '' }),
      block('loop', { HEADER: 'while (true)', FOOTER: '' }),
      block('loop', { HEADER: 'do', FOOTER: 'while (true);' }),
      block('flow', { TEXT: 'break;' }), block('flow', { TEXT: 'continue;' }), block('scope')
    ] },
    { kind: 'category', name: '变量', colour: '#b16a37', contents: [
      block('declaration', { DECL: 'int count', INIT: '=' }, { VALUE: value('0') }),
      block('definition', { TEXT: 'int count' }), block('value', { TEXT: 'count' }), block('value', { TEXT: '0' }), block('value', { TEXT: '"text"' }),
      block('statement', {}, { VALUE: { block: block('binary', { OP: '=' }, { LEFT: value('count'), RIGHT: value('1') }) } })
    ] },
    { kind: 'category', name: '运算', colour: '#557da7', contents: [
      ...['+', '-', '*', '/', '==', '<', '&&', '||'].map(OP => block('binary', { OP }, { LEFT: value('0'), RIGHT: value('1') })),
      block('unary', { BEFORE: '!', AFTER: '' }, { VALUE: value('true') }),
      block('group', {}, { VALUE: value('0') }),
      block('ternary', {}, { CONDITION: value('true'), THEN: value('1'), ELSE: value('0') }),
      block('list', { OPEN: '{', CLOSE: '}' }, { ARG0: value('0') }, { count: 1 }),
      block('member', { MEMBER: '.value' }, { OBJECT: value('object') })
    ] },
    { kind: 'category', name: '函数', colour: '#9254b8', contents: [
      block('function', { SIGNATURE: 'void myFunction()' }), block('lambda', { SIGNATURE: '[]()' }), block('return'), block('return', {}, { VALUE: value('0') })
    ] },
    { kind: 'category', name: 'C++ 原文', colour: '#ad7530', contents: [
      block('comment', { TEXT: '// 注释' }), block('directive', { TEXT: '#include <Arduino.h>' }),
      block('raw', { TEXT: '/* 在下方属性中编辑完整 C++ */' }), block('raw_value', { TEXT: '0' })
    ] }
  ]
}
