import assert from 'node:assert/strict'
import test from 'node:test'
import {
  extendSelectedCompletion,
  InlineCompletionTriggerTracker,
  prepareInlineCompletion,
  shouldRequestInlineCompletion
} from './ailyTabPolicy'

test('partial identifier echo is removed once while real continuation remains intact', () => {
  const prepare = (raw: string, prefix: string) => prepareInlineCompletion({ raw, prefix, suffix: '\n}', trigger: 'invoke' })
  assert.equal(prepare('vector<int> distances;', '    std::ve'), 'ctor<int> distances;')
  assert.equal(prepare('ctor<int> distances;', '    std::ve'), 'ctor<int> distances;')
  assert.equal(prepare('foofoo()', 'foo'), 'foo()')
})

test('infers code at a function body, expression or after an intent comment', () => {
  for (const prefix of ['void setup() {\n  ', '// Read the sensor and print its value\n', 'const value = ', 'Serial.', 'for (int i = 0;', 'for (let i = 0;']) {
    assert.equal(shouldRequestInlineCompletion(prefix, '\n}', 'automatic'), true, prefix)
  }
  for (const prefix of ['', '   ', 'x', '  }', '  delay(1000);']) {
    assert.equal(shouldRequestInlineCompletion(prefix, '', 'automatic'), false, prefix)
    assert.equal(shouldRequestInlineCompletion(prefix, '', 'invoke'), true, prefix)
  }
  assert.equal(shouldRequestInlineCompletion('digitalW', 'rite()', 'automatic'), false)
})

test('only extends IntelliSense when the independent prediction matches it', () => {
  assert.equal(extendSelectedCompletion('gin(9600);', 'be', 'begin'), 'begin(9600);')
  assert.equal(extendSelectedCompletion('begin(9600);', 'be', 'begin'), 'begin(9600);')
  assert.equal(extendSelectedCompletion('println("hello");', 'be', 'begin'), '')
  assert.equal(extendSelectedCompletion('(9600);', 'be', 'begin'), '')
  assert.equal(extendSelectedCompletion('gin', 'be', 'begin'), '')
})

test('deduplicates the existing line and suffix while preserving new arguments', () => {
  assert.equal(prepareInlineCompletion({ raw: '  Serial.begin(9600);', prefix: '  Serial.begin(', suffix: ');', trigger: 'automatic' }), '9600')
  assert.equal(prepareInlineCompletion({ raw: '  digitalWrite(LED_BUILTIN, HIGH);\n}', prefix: 'void loop() {\n', suffix: '\n}', trigger: 'automatic' }), '  digitalWrite(LED_BUILTIN, HIGH);')
  assert.equal(prepareInlineCompletion({ raw: '\n  delay(1000);\n}', prefix: 'void loop() {\n', suffix: '\n  delay(1000);\n}', trigger: 'automatic' }), '')
  assert.equal(prepareInlineCompletion({ raw: 'delay(1000);', prefix: 'void loop() {\n  ', suffix: '\n  delay(1000);\n}', trigger: 'automatic' }), '')
})

test('keeps brackets belonging to generated calls, subscripts and nested blocks', () => {
  assert.equal(prepareInlineCompletion({ raw: 'readSensor()', prefix: 'consume(', suffix: ')', trigger: 'automatic' }), 'readSensor()')
  assert.equal(prepareInlineCompletion({ raw: 'indices[i]', prefix: 'matrix[', suffix: ']', trigger: 'automatic' }), 'indices[i]')
  assert.equal(prepareInlineCompletion({ raw: 'readSensor());', prefix: 'consume(', suffix: ');', trigger: 'automatic' }), 'readSensor()')
  assert.equal(prepareInlineCompletion({ raw: 'if (ready) {\n  readSensor();\n}', prefix: 'void loop() {\n', suffix: '\n}', trigger: 'automatic' }), 'if (ready) {\n  readSensor();\n}')
})

test('suppresses automatic punctuation, whitespace and repeated statements but keeps useful short values', () => {
  const input = { prefix: 'void loop() {\n  delay(1000);\n  ', suffix: '\n}', trigger: 'automatic' as const }
  for (const raw of ['  ', ';', '\n}', 'delay(1000);']) assert.equal(prepareInlineCompletion({ ...input, raw }), '', raw)
  assert.equal(prepareInlineCompletion({ ...input, raw: 'delay(1000);', trigger: 'invoke' }), 'delay(1000);')
  assert.equal(prepareInlineCompletion({ raw: '0;', prefix: 'return ', suffix: '', trigger: 'automatic' }), '0;')
  assert.equal(prepareInlineCompletion({ raw: 'i', prefix: 'values[', suffix: ']', trigger: 'automatic' }), 'i')
})

test('does not strip a repeated identifier that is part of a new expression', () => {
  assert.equal(prepareInlineCompletion({ raw: 'sensor + offset', prefix: 'const value = sensor', suffix: ';', trigger: 'automatic' }), 'sensor + offset')
})

test('removes fences and model control tokens and preserves CRLF indentation', () => {
  assert.equal(prepareInlineCompletion({ raw: '```cpp\n  readSensor();\n  printValue();\n```', prefix: 'void loop() {\r\n', suffix: '\r\n}', trigger: 'automatic' }), '  readSensor();\r\n  printValue();')
  assert.equal(prepareInlineCompletion({ raw: 'readSensor();<｜fim▁end｜>junk', prefix: '  ', suffix: '', trigger: 'automatic' }), 'readSensor();')
})

test('navigation, deletion and undo do not automatically revive a suggestion', () => {
  const tracker = new InlineCompletionTriggerTracker()
  assert.equal(tracker.allow('main.cpp', 1, 10, 'automatic'), true)
  assert.equal(tracker.allow('main.cpp', 1, 5, 'automatic'), false)
  tracker.changed('main.cpp', 2, true)
  assert.equal(tracker.allow('main.cpp', 2, 9, 'automatic'), false)
  assert.equal(tracker.allow('main.cpp', 2, 9, 'invoke'), true)
  tracker.changed('main.cpp', 3, false)
  assert.equal(tracker.allow('main.cpp', 3, 10, 'automatic'), true)
  tracker.close('main.cpp')
  assert.equal(tracker.allow('main.cpp', 1, 5, 'automatic'), true)
})
