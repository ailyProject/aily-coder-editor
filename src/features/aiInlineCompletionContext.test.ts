import assert from 'node:assert/strict'
import test from 'node:test'
import { buildInlineCompletionContext, type InlineCompletionContextDocument } from './aiInlineCompletionContext'

function document(relativePath: string, text: string, languageId = 'cpp'): InlineCompletionContextDocument {
  return { uri: `file:///workspace/${relativePath}`, relativePath, languageId, text }
}

function active(text: string, relativePath = 'src/main.cpp', languageId = 'cpp') {
  const marker = text.indexOf('|')
  assert.notEqual(marker, -1)
  return { ...document(relativePath, text.slice(0, marker) + text.slice(marker + 1), languageId), offset: marker }
}

test('keeps exact prefix and suffix slices including indentation and CRLF', () => {
  const source = active('void loop() {\r\n\t  motor.|\r\n}\r\n')
  const result = buildInlineCompletionContext({ active: source, documents: [], beforeMax: 11, afterMax: 5 })
  assert.equal(result.prefix, source.text.slice(source.offset - 11, source.offset))
  assert.equal(result.suffix, '\r\n}\r\n')
  assert.ok(result.prefix.endsWith('\t  motor.'))
})

test('prioritizes an included header and selects the relevant declaration window deep in that header', () => {
  const header = document('include/MotorController.h', `${'// unrelated introductory detail\n'.repeat(200)}class MotorController {\n public:\n  void moveTo(int position);\n  bool isMoving() const;\n};\n${'// other methods\n'.repeat(200)}`)
  const competing = document('src/diagnostics.cpp', 'void inspectMotorController(MotorController& motor) { motor.moveTo(0); }')
  const result = buildInlineCompletionContext({
    active: active('#include "MotorController.h"\nMotorController motor;\nvoid loop() { motor.moveTo(|); }'),
    documents: [competing, header]
  })
  assert.equal(result.context[0]?.relativePath, 'include/MotorController.h')
  assert.ok(result.context[0]?.text.includes('bool isMoving() const;'))
  assert.ok(result.context[0]!.text.length <= 2000)
  assert.ok(header.text.includes(result.context[0]!.text))
})

test('does not add unrelated documents merely because their language matches', () => {
  const result = buildInlineCompletionContext({
    active: active('void setup() {}\nvoid loop() {\n  temperatureSensor.|\n}'),
    documents: [
      document('src/blink.cpp', 'void setup() { pinMode(13, OUTPUT); }\nvoid loop() { digitalWrite(13, HIGH); delay(1000); }'),
      document('src/math.cpp', 'int sum(int value, int count) { return value + count; }')
    ]
  })
  assert.deepEqual(result.context, [])
})

test('uses significant cursor symbols and stable document order to rank relevant source files', () => {
  const result = buildInlineCompletionContext({
    active: active('void sample() { temperatureSensor.| }'),
    documents: [
      document('src/first.cpp', 'void sampleTemperature(TemperatureSensor& temperatureSensor);'),
      document('src/second.cpp', 'void initializeTemperature(TemperatureSensor& temperatureSensor);')
    ]
  })
  assert.deepEqual(result.context.map((snippet) => snippet.relativePath), ['src/first.cpp', 'src/second.cpp'])
})

test('resolves relative imports across JavaScript and TypeScript documents', () => {
  const result = buildInlineCompletionContext({
    active: active('import { resolvePort } from "../device/ports";\nresolvePort(|)', 'src/editor/main.js', 'javascript'),
    documents: [document('src/device/ports.ts', 'export function resolvePort(address: string): number { return 42; }', 'typescript')]
  })
  assert.equal(result.context[0]?.relativePath, 'src/device/ports.ts')
})

test('includes a same-name header even before a specific member has been typed', () => {
  const result = buildInlineCompletionContext({
    active: active('void initialize() {\n  |\n}', 'src/controller.cpp'),
    documents: [document('include/controller.h', 'class Controller { public: void initialize(); };', 'c')]
  })
  assert.equal(result.context[0]?.relativePath, 'include/controller.h')
})

test('retains global declarations outside a clipped prefix without inventing code or duplicating visible text', () => {
  const globals = '#include "Sensor.h"\nconstexpr int SENSOR_PIN = 4;\nSensor temperatureSensor(SENSOR_PIN);\n'
  const source = active(`${globals}${'// spacer\n'.repeat(1500)}void loop() { temperatureSensor.| }`)
  const result = buildInlineCompletionContext({ active: source, documents: [source] })
  assert.equal(result.prefix.length, 12_000)
  assert.ok(!result.prefix.includes('constexpr int SENSOR_PIN'))
  assert.ok(result.context[0]?.text.includes('constexpr int SENSOR_PIN = 4;'))
  assert.equal(result.context[0]?.relativePath, 'src/main.cpp')
  assert.ok(source.text.startsWith(result.context[0]!.text))
  assert.equal(result.context.length, 1)
})

test('keeps declarations after a large license banner in the active file', () => {
  const globals = '#include "Sensor.h"\nconstexpr int SENSOR_PIN = 4;\n'
  const source = active(`/* ${'License terms. '.repeat(300)} */\n${globals}${'// spacer\n'.repeat(1500)}void loop() { temperatureSensor.| }`)
  const result = buildInlineCompletionContext({ active: source, documents: [] })
  assert.ok(result.context[0]?.text.startsWith(globals))
  assert.ok(source.text.includes(result.context[0]!.text))
})

test('finds a relevant symbol on a source line longer than the snippet budget', () => {
  const header = document('include/Sensor.h', `${' '.repeat(5000)}class TemperatureSensor { public: int measure(); };\n`)
  const result = buildInlineCompletionContext({ active: active('TemperatureSensor temperatureSensor;\ntemperatureSensor.|'), documents: [header] })
  assert.ok(result.context[0]?.text.includes('int measure();'))
  assert.ok(result.context[0]!.text.length <= 2000)
})

test('uses bounded default suffix and prefix budgets', () => {
  const source = active(`${'a'.repeat(15_000)}|${'b'.repeat(6000)}`)
  const result = buildInlineCompletionContext({ active: source, documents: [] })
  assert.equal(result.prefix, 'a'.repeat(12_000))
  assert.equal(result.suffix, 'b'.repeat(4000))
})

test('limits total context to three source snippets and 6000 characters', () => {
  const source = active(`${'// context\n'.repeat(1500)}TemperatureSensor temperatureSensor;\nvoid loop() { temperatureSensor.| }`)
  const result = buildInlineCompletionContext({
    active: source,
    documents: Array.from({ length: 8 }, (_, i) => document(`src/sensor${i}.cpp`, `${'TemperatureSensor temperatureSensor;\n'.repeat(150)}`))
  })
  assert.equal(result.context.length, 3)
  assert.ok(result.context.every((snippet) => snippet.text.length <= 2000))
  assert.ok(result.context.reduce((sum, snippet) => sum + snippet.text.length, 0) <= 6000)
})

test('excludes unrelated languages even when a coincidental identifier overlaps', () => {
  const result = buildInlineCompletionContext({
    active: active('TemperatureSensor temperatureSensor;\nvoid loop() { temperatureSensor.| }'),
    documents: [document('scripts/generate.py', 'temperatureSensor = "different workflow"\nprint(temperatureSensor)', 'python')]
  })
  assert.deepEqual(result.context, [])
})

test('excludes configuration, credentials, dependencies, generated files, and virtual documents', () => {
  const text = 'TemperatureSensor temperatureSensor;'
  const result = buildInlineCompletionContext({
    active: active('TemperatureSensor temperatureSensor;\nvoid loop() { temperatureSensor.| }'),
    documents: [
      document('.env', text), document('secrets.cpp', text), document('settings.json', text),
      document('node_modules/sensor/index.ts', text), document('sketch/libraries/Sensor/Sensor.h', text),
      document('.build/main.cpp', text), document('src/generated/sensor.cpp', text),
      document('src/sensor.generated.cpp', text), document('src/sensor.min.js', text),
      { ...document('src/sensor.cpp', text), uri: 'git:///workspace/src/sensor.cpp' }
    ]
  })
  assert.deepEqual(result.context, [])
})

test('ignores duplicate documents and respects zero context budgets', () => {
  const sensor = document('include/Sensor.h', 'class TemperatureSensor { public: int measure(); };')
  const source = active('#include "Sensor.h"\nTemperatureSensor temperatureSensor;\ntemperatureSensor.|')
  const result = buildInlineCompletionContext({ active: source, documents: [source, sensor, sensor], beforeMax: 0, afterMax: 0 })
  assert.equal(result.prefix, '')
  assert.equal(result.suffix, '')
  assert.deepEqual(result.context.map((snippet) => snippet.relativePath), ['src/main.cpp', 'include/Sensor.h'])
})
