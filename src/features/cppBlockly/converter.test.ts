import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Language, Parser } from 'web-tree-sitter'
import { convertCpp } from './converter.js'
import { generateCpp, indexBlocks, mergeScope } from './generator.js'
import { applySource } from './applySource.js'
import { applyCppSession, cppSourceChangeAction, createCppSession, loadCppSession, sessionCode } from './editorSession.js'
import { cppToolbox } from './toolbox.js'
import { Blockly, registerCppPreviewBlocks } from './blocks.js'
import { cppTypeOptions, declarationText } from './declarationTypes.js'
import { blockAtPosition } from './sourceSelection.js'
import { cppQuickActions } from './quickItems.js'
import { codeOptions } from './beginnerCatalog.js'
import { filterCppCategories } from './libraryToolbox.js'
import { fieldSourceLocation } from './fieldLocation.js'
import { rebaseProjection } from './rebaseProjection.js'
import { renameCppVariable } from './variables.js'
import { cppVariableCategory } from './variableToolbox.js'
import { cppBlocklyPreviewEnabled } from './devGate.js'
import { isCppPreviewFile, MAX_SOURCE_LENGTH, type CppPreview, type PreviewBlock } from './types.js'

let parser: Parser
before(async () => {
  await Parser.init()
  parser = new Parser()
  parser.setLanguage(await Language.load(createRequire(import.meta.url).resolve('tree-sitter-cpp/tree-sitter-cpp.wasm')))
  registerCppPreviewBlocks()
})
after(() => parser.delete())

test('Blockly conversion preview is available only in development', () => {
  assert.equal(cppBlocklyPreviewEnabled('', false, false), false)
  assert.equal(cppBlocklyPreviewEnabled('?blocklyPreviewDev=false', false, false), false)
  assert.equal(cppBlocklyPreviewEnabled('?blocklyPreviewDev=true', false, false), true)
  assert.equal(cppBlocklyPreviewEnabled('', true, false), true)
  assert.equal(cppBlocklyPreviewEnabled('', false, true), true)
})

test('function signature fields expose qualifiers, return type, name and parameters with exact source spans', () => {
  const source = 'static String escJson(const char* s) { return s; }'
  const result = convertCpp(parser, source)
  const functionBlock = result.blocks.blocks[0]!
  assert.equal(functionBlock.type, 'cpp_preview_function')
  assert.deepEqual(Object.fromEntries(['QUALIFIERS', 'TYPE', 'NAME', 'PARAMETERS'].map(key => [key, functionBlock.fields?.[key]])),
    { QUALIFIERS: 'static', TYPE: 'String', NAME: 'escJson', PARAMETERS: 'const char* s' })
  assert.equal(fieldSourceLocation(source, result, functionBlock.id, 'TYPE')?.text, 'String')
  assert.equal(fieldSourceLocation(source, result, functionBlock.id, 'PARAMETERS')?.text, 'const char* s')
  const workspace = new Blockly.Workspace()
  try {
    Blockly.serialization.workspaces.load({ blocks: result.blocks }, workspace)
    const block = workspace.getBlockById(functionBlock.id)!
    assert.ok(block.getField('TYPE') instanceof Blockly.FieldDropdown)
    block.getField('QUALIFIERS')!.setValue('const static')
    block.getField('TYPE')!.setValue('char*')
    block.getField('NAME')!.setValue('escape')
    block.getField('PARAMETERS')!.setValue('const char* s, int size')
    const code = generateCpp(source, result, Blockly.serialization.workspaces.save(workspace).blocks!.blocks as PreviewBlock[])
    assert.equal(code, 'const static char* escape(const char* s, int size) { return s; }')
    assert.equal(convertCpp(parser, code).status, 'ready')
  } finally { workspace.dispose() }
})

test('source variables populate draggable toolbox entries and scoped batch rename changes only their references', () => {
  const source = 'int count = 1;\nvoid f(int count) { int next = count; { int count = next; count += 1; } count += next; }\nvoid g() { count += 2; const char* text = "count"; }\n'
  const result = convertCpp(parser, source)
  const variables = result.variables ?? []
  const counts = variables.filter(variable => variable.name === 'count')
  assert.equal(counts.length, 3)
  const global = counts.find(variable => variable.scopeKind === 'global')!
  const parameter = counts.find(variable => variable.scopeKind === 'parameter')!
  const inner = counts.find(variable => variable.scopeKind === 'local')!
  assert.equal(global.references.length, 2)
  assert.equal(parameter.references.length, 3)
  assert.equal(inner.references.length, 2)
  const renamedParameter = renameCppVariable(source, variables, parameter.id, 'index')
  assert.equal(renamedParameter, source.replace('void f(int count) { int next = count;', 'void f(int index) { int next = index;').replace('} count += next; }', '} index += next; }'))
  const renamedGlobal = renameCppVariable(source, variables, global.id, 'total')
  assert.equal(renamedGlobal, source.replace('int count = 1;', 'int total = 1;').replace('void g() { count += 2;', 'void g() { total += 2;'))
  assert.equal(renameCppVariable(source, variables, inner.id, 'countInner').includes('int countInner = next; countInner += 1;'), true)
  assert.throws(() => renameCppVariable(source, variables, global.id, 'next'), /已存在/)
  assert.throws(() => renameCppVariable(source, variables, global.id, 'for'), /有效/)
  const category = ((cppToolbox as Blockly.utils.toolbox.ToolboxInfo).contents as Blockly.utils.toolbox.StaticCategoryInfo[]).find(item => item.name === '变量')!
  const flyout = cppVariableCategory(category, variables)
  assert.ok(flyout.contents.some(item => item.kind === 'block' && (item as Blockly.utils.toolbox.BlockInfo).type === 'cpp_preview_variable' && (item as Blockly.utils.toolbox.BlockInfo).fields?.NAME === 'count'))
  assert.ok(flyout.contents.some(item => item.kind === 'button' && (item as Blockly.utils.toolbox.ButtonInfo).callbackkey === `cpp-rename:${parameter.id}`))
  assert.ok(flyout.contents.some(item => item.kind === 'label' && (item as Blockly.utils.toolbox.LabelInfo).text.includes('const char*')))
  const mutableSetter = flyout.contents.find(item => item.kind === 'block' && (item as Blockly.utils.toolbox.BlockInfo).type === 'cpp_preview_statement') as Blockly.utils.toolbox.BlockInfo
  assert.ok(mutableSetter)
  const setterWorkspace = new Blockly.Workspace()
  try {
    Blockly.serialization.workspaces.load({ blocks: { languageVersion: 0, blocks: [{ ...mutableSetter, id: 'setter' }] } }, setterWorkspace)
    const setter = Blockly.serialization.workspaces.save(setterWorkspace).blocks!.blocks as PreviewBlock[]
    assert.match(generateCpp('', convertCpp(parser, ''), setter), /count\s*=\s*1/)
  } finally { setterWorkspace.dispose() }
  const textLabel = flyout.contents.findIndex(item => item.kind === 'label' && (item as Blockly.utils.toolbox.LabelInfo).text.startsWith('text ·'))
  assert.ok(textLabel > 0)
  assert.equal(flyout.contents.slice(textLabel + 1).some(item => item.kind === 'block' && (item as Blockly.utils.toolbox.BlockInfo).type === 'cpp_preview_statement'), false)
  const workspace = new Blockly.Workspace()
  try {
    Blockly.serialization.workspaces.load({ blocks: result.blocks }, workspace)
    assert.ok(workspace.getAllBlocks(false).some(block => block.type === 'cpp_preview_variable'))
    assert.equal(generateCpp(source, result, Blockly.serialization.workspaces.save(workspace).blocks!.blocks as PreviewBlock[]), source)
  } finally { workspace.dispose() }
})

test('range loop and structured binding variables are available without stealing the range expression', () => {
  const source = 'int item = 4;\nvoid f() { auto [first, second] = pair(); for (const auto& item : items(item)) { use(item, first, second); } use(item); }\n'
  const variables = convertCpp(parser, source).variables ?? []
  const range = variables.find(variable => variable.name === 'item' && variable.scopeKind === 'local')!
  const global = variables.find(variable => variable.name === 'item' && variable.scopeKind === 'global')!
  const first = variables.find(variable => variable.name === 'first')!
  const second = variables.find(variable => variable.name === 'second')!
  assert.ok(range)
  assert.ok(first)
  assert.ok(second)
  assert.equal(range.dataType, 'const auto&')
  assert.equal(first.dataType, 'auto')
  assert.equal(second.dataType, 'auto')
  assert.equal(range.references.length, 2)
  assert.equal(global.references.length, 3)
  assert.equal(renameCppVariable(source, variables, range.id, 'element').includes('for (const auto& element : items(item)) { use(element, first, second); }'), true)
  assert.equal(renameCppVariable(source, variables, first.id, 'one').includes('auto [one, second] = pair(); for'), true)
})

test('batch rename includes explicitly qualified global and namespace references', () => {
  const source = 'int count = 0; namespace ns { int count = 1; } void f() { ++::count; ++ns::count; }'
  const variables = convertCpp(parser, source).variables ?? []
  const global = variables.find(variable => variable.scope === '全局' && variable.name === 'count')!
  const namespaced = variables.find(variable => variable.scope === '命名空间 ns' && variable.name === 'count')!
  assert.equal(global.references.length, 2)
  assert.equal(namespaced.references.length, 2)
  assert.match(renameCppVariable(source, variables, global.id, 'total'), /\+\+::total; \+\+ns::count;/)
  assert.match(renameCppVariable(source, variables, namespaced.id, 'total'), /\+\+::count; \+\+ns::total;/)
})

test('saved field edits rebase visible block ids onto the new source without rebuilding', () => {
  const source = '#include <Arduino.h>\nstatic String stayJson(const char* s) { return String(s); }\nvoid setup() { Demo.begin(); Demo.write(1); }\nvoid loop() {}\n'
  const initial = convertCpp(parser, source)
  const workspace = new Blockly.Workspace()
  try {
    Blockly.serialization.workspaces.load({ blocks: initial.blocks }, workspace)
    const functionId = initial.blocks.blocks.find(block => block.type === 'cpp_preview_function')!.id
    workspace.getBlockById(functionId)!.getField('NAME')!.setValue('remainJson')
    const visible = Blockly.serialization.workspaces.save(workspace).blocks!.blocks as PreviewBlock[]
    const code = generateCpp(source, initial, visible)
    const saved = convertCpp(parser, code)
    const rebased = rebaseProjection(visible, saved.blocks.blocks)
    assert.ok(rebased)
    assert.equal(generateCpp(code, saved, rebased.view), code)
    assert.equal(rebased.sourceIds.get(functionId), saved.blocks.blocks.find(block => block.type === 'cpp_preview_function')!.id)
    rebased.view.find(block => block.type === 'cpp_preview_function')!.fields!.NAME = 'againJson'
    assert.equal(generateCpp(code, saved, rebased.view), code.replace('remainJson', 'againJson'))
  } finally { workspace.dispose() }
})

const settleEvents = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 15))
function quick(block: Blockly.Block, id: string): void {
  const action = cppQuickActions(block).find(a => a.id === id)
  assert.ok(action?.enabled, `quick action ${id} is enabled`)
  action.run()
}

function flatten(result: CppPreview): PreviewBlock[] {
  const list: PreviewBlock[] = []
  const visit = (b: PreviewBlock): void => { list.push(b); Object.values(b.inputs ?? {}).forEach(i => visit(i.block)); if (b.next) visit(b.next.block) }
  result.blocks.blocks.forEach(visit)
  return list
}

function assertLoads(result: CppPreview): void {
  const ws = new Blockly.Workspace()
  try {
    Blockly.serialization.workspaces.load({ blocks: result.blocks }, ws)
    assert.equal(ws.getAllBlocks(false).length, result.blockCount)
  } finally { ws.dispose() }
}

test('Blink creates connected Blockly blocks without ABS or implicit initialization', () => {
  const source = '#include <Arduino.h>\nconst int LED = 13;\nvoid setup() { pinMode(LED, OUTPUT); }\nvoid loop() { digitalWrite(LED, HIGH); delay(500); digitalWrite(LED, LOW); delay(500); }'
  const result = convertCpp(parser, source)
  assert.equal(result.status, 'ready')
  const calls = flatten(result).filter(b => b.type === 'cpp_preview_action')
  assert.deepEqual(calls.map(b => b.fields?.NAME), ['pinMode', 'digitalWrite', 'delay', 'digitalWrite', 'delay'])
  assert.equal(flatten(result).length, result.blockCount)
  const workspace = new Blockly.Workspace()
  try {
    Blockly.serialization.workspaces.load({ blocks: result.blocks }, workspace)
    assert.equal(workspace.getAllBlocks(false).length, result.blockCount)
    assert.equal(workspace.getBlockById(calls[0]!.id)?.getInputTargetBlock('ARG1')?.getFieldValue('TEXT'), 'OUTPUT')
    assert.equal(workspace.getTopBlocks(false).length, 3)
  } finally { workspace.dispose() }
})

test('keeps nested conditionals, calls, expression precedence and else chains', () => {
  const result = convertCpp(parser, 'void loop(){ if ((a + b) * c > 10 && ready()) { run(1, f(2, 3)); } else if (x) { stop(); } else { x++; } }')
  assert.equal(result.status, 'ready')
  assert.equal(flatten(result).filter(b => b.type === 'cpp_preview_if').length, 2)
  const ws = new Blockly.Workspace()
  try { Blockly.serialization.workspaces.load({ blocks: result.blocks }, ws); assert.equal(ws.getAllBlocks(false).length, result.blockCount) }
  finally { ws.dispose() }
})

test('loops retain exact comparison, dynamic step, types and do-while suffix', () => {
  const source = 'void loop(){ for(unsigned long i=0;i<=n;i+=step()) { work(i); } do { x++; } while(x<4); while(ready()) break; }'
  const result = convertCpp(parser, source)
  const loops = flatten(result).filter(b => b.type === 'cpp_preview_loop')
  assert.equal(result.status, 'ready')
  assert.equal(loops[0]?.fields?.HEADER, 'for(unsigned long i=0;i<=n;i+=step())')
  assert.deepEqual(flatten(result).filter(b => b.type === 'cpp_preview_while').map(b => b.fields?.MODE), ['do', 'while'])
  assert.equal(generateCpp(source, result, serialized(result)), source)
})

test('classes, templates, lambdas and conditional compilation expose nested executable blocks', () => {
  const units = ['template<typename T> T square(T x){return x*x;}', '#if defined(ESP32)\nint pin=1;\n#else\nint pin=2;\n#endif', 'class Sensor { public: void read() {} };']
  const result = convertCpp(parser, units.join('\n'))
  assert.equal(result.status, 'ready')
  assert.equal(result.preservedCount, 0)
  for (const unit of units) assert.ok(Object.values(result.locations).some(d => d.text.trim() === unit))
  assert.equal(flatten(result).filter(b => b.type === 'cpp_preview_function').length, 2)
  assert.ok(flatten(result).some(b => b.fields?.HEADER === '#else'))
  assertLoads(result)
  const lambda = convertCpp(parser, 'void setup(){ auto f = [](){ return 1; }; }')
  assert.equal(lambda.status, 'ready')
  const callback = flatten(lambda).find(b => b.type === 'cpp_preview_lambda')!
  assert.equal(callback.inputs?.BODY?.block.type, 'cpp_preview_return')
  assert.equal(lambda.locations[callback.id]?.text, '[](){ return 1; }')
  assertLoads(lambda)
})

test('keeps volatile, uninitialized declarations and direct initialization distinct', () => {
  const result = convertCpp(parser, 'volatile unsigned long ticks;\nint count = 0;\nWidget widget(42);\nint values[]{1,2};')
  const declarations = flatten(result).filter(b => b.type === 'cpp_preview_declaration')
  assert.equal(result.status, 'ready')
  assert.ok(flatten(result).some(b => declarationText(b.fields, 'TEXT') === 'volatile unsigned long ticks'))
  assert.equal(declarations[0]?.fields?.INIT, '=')
  assert.equal(declarations[1]?.fields?.INIT, '')
  assert.equal(declarations[1]?.inputs?.VALUE?.block.fields?.OPEN, '(')
  assert.equal(declarations[2]?.inputs?.VALUE?.block.fields?.OPEN, '{')
  assertLoads(result)
})

test('malformed source never shows a misleading partial success or stale blocks', () => {
  for (const text of ['void loop() { if (x {', 'void setup(){ delay(42) }']) {
    const result = convertCpp(parser, text)
    assert.equal(result.status, 'error'); assert.equal(result.blockCount, 0)
    assert.deepEqual(result.blocks.blocks, []); assert.ok(result.diagnostics.length)
  }
  assert.equal(convertCpp(parser, 'void loop(){}').status, 'ready')
})

test('Unicode, CRLF, comments, escaping and HTML remain source text, with accurate lines', () => {
  const source = '// 中文🙂\r\nvoid loop(){\r\n  Serial.println("<script> & \\"hi\\"");\r\n}\r\n'
  const result = convertCpp(parser, source)
  assert.equal(result.status, 'ready')
  const call = flatten(result).find(b => b.type === 'cpp_preview_action')!
  assert.equal(result.locations[call.id]?.line, 3)
  assert.equal(result.locations[call.id]?.column, 3)
  const literal = flatten(result).find(b => b.fields?.TEXT?.includes('<script>'))!
  assert.equal(literal.fields?.TEXT, '<script> & "hi"')
  assert.equal(generateCpp(source, result, serialized(result)), source)
})

test('inline comments and if-init are preserved instead of silently lost', () => {
  for (const source of ['void f(){ if (x) /* important */ run(); }', 'void f(){ if (auto x = read(); x) run(); }', 'void f(){ int x /* type */ = 1; }']) {
    const result = convertCpp(parser, source)
    assert.notEqual(result.status, 'error')
    assert.ok(Object.values(result.locations).some(d => d.text === source))
    if (source.includes('important') || source.includes('if (auto')) { assert.equal(result.status, 'partial'); assert.ok(result.preservedCount) }
  }
})

test('only supported file extensions expose the entry and resource limits fail explicitly', () => {
  for (const name of ['a.cpp', 'a.CPP', 'a.cc', 'a.cxx', 'a.ino', 'a.h', 'a.hpp', 'a.hxx', 'a.hh']) assert.ok(isCppPreviewFile(name))
  for (const name of ['readme.md', 'project.abi', 'a.cpp.bak', 'a.json']) assert.ok(!isCppPreviewFile(name))
  assert.equal(convertCpp(parser, '').blockCount, 0)
  assert.equal(convertCpp(parser, ' '.repeat(MAX_SOURCE_LENGTH + 1)).status, 'error')
  assert.equal(convertCpp(parser, `void f(){${'delay(1);'.repeat(700)}}`).status, 'error')
})

test('PROGMEM declarations retain raw strings and storage annotations without masking source errors', () => {
  const source = '// 中文\nstatic const char PAGE[] PROGMEM = R"HTML(<script>PROGMEM [] =</script>)HTML";\nint PROGMEM = 1;\nvoid setup(){ send(PAGE); }'
  const result = convertCpp(parser, source)
  assert.equal(result.status, 'ready')
  assert.equal(result.dataCount, 1)
  const declaration = flatten(result).find(b => b.fields?.DECL?.includes('PAGE'))!
  assert.equal(declarationText(declaration.fields, 'DECL'), 'static const char PAGE[] PROGMEM')
  const data = declaration.inputs!.VALUE!.block
  assert.equal(result.locations[data.id]?.text, 'R"HTML(<script>PROGMEM [] =</script>)HTML"')
  assert.equal(result.locations[declaration.id]?.line, 2)
  assert.ok(flatten(result).some(b => declarationText(b.fields, 'DECL') === 'int PROGMEM'))
  assertLoads(result)
  assert.equal(convertCpp(parser, 'const char x[] PROGMEM = "x";\nvoid f(){oops(}').status, 'error')
})

test('route callbacks retain captures, branches, casts and chained method arguments', () => {
  const result = convertCpp(parser, 'void routes(){ server.on("/wall", HTTP_POST, [this, &state](int fallback) mutable { int id = server.arg("id").toInt(); if(id < 0) return bad(); state = (uint8_t)id; draw(state); }); }')
  assert.equal(result.status, 'ready')
  const all = flatten(result)
  const route = all.find(b => b.fields?.NAME === 'server.on')!
  const callback = route.inputs?.ARG2?.block
  assert.equal(callback?.type, 'cpp_preview_lambda')
  assert.equal(callback?.fields?.SIGNATURE, '[this, &state](int fallback) mutable')
  assert.ok(all.some(b => b.type === 'cpp_preview_if'))
  assert.ok(all.some(b => b.fields?.NAME === 'server.arg'))
  assert.ok(all.some(b => b.fields?.BEFORE === '(uint8_t)'))
  assertLoads(result)
})

test('namespaces, class members, templates and arrays retain their children and values', () => {
  const source = 'namespace UI { class Screen { public: static constexpr int RED = 0xF800; template<typename T> static void draw(T& d){ d.begin(); do{ d.paint(); }while(d.next()); } }; int values[][2] = {{1,2},{3,4}}; int pick(int i){ return values[i][0] ? values[i][1] : (int)sizeof(values); } }'
  const result = convertCpp(parser, source)
  assert.equal(result.status, 'ready')
  const all = flatten(result)
  assert.ok(all.some(b => declarationText(b.fields, 'DECL') === 'static constexpr int RED' && b.inputs?.VALUE?.block.fields?.TEXT === '0xF800'))
  assert.equal(all.filter(b => b.type === 'cpp_preview_subscript').length, 4)
  assert.equal(all.filter(b => b.type === 'cpp_preview_function').length, 2)
  assert.ok(all.some(b => b.type === 'cpp_preview_ternary'))
  assertLoads(result)
})

test('large bitmap constants fold into inspectable data while executable initializer calls stay expanded', () => {
  const bitmap = `static const unsigned char BM[] PROGMEM = {${Array.from({length:3000}, (_, i) => `0x${(i % 256).toString(16)}`).join(',')}};`
  const result = convertCpp(parser, bitmap)
  assert.equal(result.status, 'ready'); assert.equal(result.dataCount, 1); assert.equal(result.blockCount, 2)
  const data = flatten(result).find(b => b.type === 'cpp_preview_data')!
  assert.ok(result.locations[data.id]?.text.includes('0xff'))
  assert.equal(result.locations[data.id]?.text, bitmap.slice(bitmap.indexOf('{'), -1))
  const dynamic = convertCpp(parser, `int values[] = {${'read(),'.repeat(30)}0};`)
  assert.equal(flatten(dynamic).filter(b => b.type === 'cpp_preview_call').length, 30)
  assertLoads(result); assertLoads(dynamic)
})

test('unsupported syntax remains explicit instead of being silently discarded', () => {
  const result = convertCpp(parser, 'void f(){ try { work(); } catch(...) { recover(); } }')
  assert.equal(result.status, 'partial')
  assert.ok(result.diagnostics.some(d => d.text === 'try { work(); } catch(...) { recover(); }'))
})

test('real Guwen project files all convert and load, with callbacks and data accounted for', { skip: !process.env.CPP_BLOCKLY_PROJECT }, () => {
  const root = process.env.CPP_BLOCKLY_PROJECT!
  for (const name of ['sketch/src/main.cpp', 'sketch/libraries/GuwenUI/src/GuwenUI.cpp', 'sketch/libraries/GuwenUI/src/GuwenUI.h', 'sketch/libraries/GuwenUI/src/GuwenAssets.h']) {
    const source = readFileSync(join(root, name), 'utf8')
    const result = convertCpp(parser, source)
    assert.equal(result.status, 'ready', `${name}: ${JSON.stringify(result.diagnostics)}`)
    assert.equal(result.preservedCount, 0)
    assertLoads(result)
    const all = flatten(result)
    if (name === 'sketch/src/main.cpp') {
      assert.equal(all.filter(b => b.type === 'cpp_preview_lambda').length, 5)
      assert.equal(all.filter(b => b.type === 'cpp_preview_function').length, 10)
      assert.ok(all.some(b => b.fields?.NAME === 'prefs.putUInt'))
      assert.ok(all.some(b => b.type === 'cpp_preview_data' && result.locations[b.id]?.text.includes('<!DOCTYPE html>')))
    }
    if (name.endsWith('GuwenUI.cpp')) assert.equal(all.filter(b => b.type === 'cpp_preview_function').length, 12)
    if (name.endsWith('GuwenAssets.h')) assert.ok((result.dataCount ?? 0) >= 20)
  }
})

function serialized(result: CppPreview): PreviewBlock[] {
  const ws = new Blockly.Workspace()
  try { Blockly.serialization.workspaces.load({ blocks: result.blocks }, ws); return Blockly.serialization.workspaces.save(ws).blocks.blocks as PreviewBlock[] }
  finally { ws.dispose() }
}

test('editable workspace serialization round-trips C++ byte for byte, including trivia and complex containers', () => {
  const samples = [
    '\ufeff// 中文🙂\r\nvoid f(){ if (x) run(1); else if(y) stop(); else {end();} }\r\n',
    'namespace UI { class S { public: int n=1; template<typename T> void f(T t){t.begin();} }; }\n',
    'int a=1, *b=nullptr, c[2]={2,3}; enum E { A=1, B, C=3, };\n',
    '#if ESP32\nint pin=1;\n#elif AVR\nint pin=2;\n#else\nint pin=3;\n#endif\n',
    'void f(){for(int i=0;i<2;i++) x++; do {run();} while(x<2); switch(x){case 1: run(); break; default: break;} return;}',
    'const char x[] PROGMEM = R"HTML(<p>long  text\n中文</p>)HTML";\nvoid f(){call(/* first */ 1, /* second */ [](){run();}); try{x();}catch(...){y();}}',
    `const char x[]="${' a  b '.repeat(60)}";\nvoid f(){return;}`,
    'int a[40] = {' + Array.from({length:40}, (_,i) => i).join(', ') + '};'
  ]
  for (const source of samples) {
    const result = convertCpp(parser, source)
    assert.notEqual(result.status, 'error', JSON.stringify(result.diagnostics))
    assert.equal(generateCpp(source, result, serialized(result)), source)
  }
})

test('field editing changes only the requested value and keeps raw data, comments and PROGMEM intact', () => {
  const source = 'const char PAGE[] PROGMEM = R"HTML(<h1> hello  world </h1>)HTML";\r\nvoid f(){\r\n // keep me\r\n delay(500);\r\n send(PAGE);\r\n}\r\n'
  const result = convertCpp(parser, source), roots = serialized(result)
  const value = [...indexBlocks(roots).values()].find(b => b.fields?.TEXT === '500')!
  value.fields!.TEXT = '750'
  assert.equal(generateCpp(source, result, roots), source.replace('delay(500)', 'delay(750)'))
})

test('adding, deleting and reordering statements preserves neighboring functions', () => {
  const source = 'void f(){\n  first();\n  second();\n}\nvoid g(){untouched();}\n'
  const result = convertCpp(parser, source), roots = serialized(result), fn = roots[0]!
  const first = fn.inputs!.BODY!.block, second = first.next!.block
  second.next = { block: { type: 'cpp_preview_statement', id: 'new', inputs: { VALUE: { block: {type:'cpp_preview_call', id:'call', fields:{NAME:'delay'}, extraState:{count:1}, inputs:{ARG0:{block:{type:'cpp_preview_value',id:'v',fields:{TEXT:'1000'}}}}} } } } }
  fn.inputs!.BODY!.block = second
  const code = generateCpp(source, result, roots)
  assert.match(code, /second\(\);\s+delay\(1000\);/)
  assert.ok(!code.includes('first()')); assert.ok(code.endsWith('void g(){untouched();}\n'))
  assert.equal(convertCpp(parser, code).status, 'ready')
})

test('unbraced bodies become braced when extended and operator edits preserve grouping', () => {
  const source = 'void f(){ if(x) first(); int y = a + b * c; }'
  const result = convertCpp(parser, source), roots = serialized(result), all = [...indexBlocks(roots).values()]
  const condition = all.find(b => b.type === 'cpp_preview_if')!
  condition.inputs!.THEN!.block.next = {block:{type:'cpp_preview_raw', id:'new', fields:{TEXT:'second();'}}}
  all.find(b => b.fields?.OP === '*')!.fields!.OP = '+'
  const code = generateCpp(source, result, roots)
  assert.match(code, /if\(x\) \{[\s\S]*first\(\);[\s\S]*second\(\);[\s\S]*\}/)
  assert.ok(code.includes('a + (b + c)')); assert.equal(convertCpp(parser, code).status, 'ready')
})

test('scope merge retains the complete file, and rejects detached new blocks', () => {
  const source = 'void a(){run(1);}\nvoid b(){run(2);}'
  const result = convertCpp(parser, source), roots = serialized(result)
  const scoped = structuredClone(roots[1]!); delete scoped.next
  scoped.fields!.SIGNATURE = 'void renamed()'
  const merged = mergeScope(roots, scoped.id, [scoped])
  assert.equal(generateCpp(source, result, merged), source.replace('void b()', 'void renamed()'))
  assert.throws(() => mergeScope(roots, scoped.id, [scoped, { type: 'cpp_preview_value', id:'orphan', fields:{TEXT:'3'} }]), /连接/)
})

test('dynamic argument and else shapes survive save/load, resize and undo events', () => {
  const source = 'void f(){if(x){run(1,2,3);}else{stop();}}'
  const result = convertCpp(parser, source), ws = new Blockly.Workspace()
  try {
    Blockly.serialization.workspaces.load({blocks:result.blocks}, ws)
    const call = ws.getAllBlocks(false).find(b => b.getFieldValue('NAME') === 'run')!
    const oldState = call.saveExtraState!(), before = JSON.stringify(oldState)
    call.loadExtraState!({count:4}); call.loadExtraState!({count:4})
    assert.ok(call.getInput('ARG3')); assert.equal(call.inputList.filter(i => i.name === 'ARG3').length, 1)
    const event = new Blockly.Events.BlockChange(call, 'mutation', null, before, JSON.stringify({count:4}))
    event.run(false); assert.equal(call.getInput('ARG3'), null)
    assert.equal(call.getInputTargetBlock('ARG2')?.getFieldValue('TEXT'), '3')
    assert.equal(generateCpp(source, result, Blockly.serialization.workspaces.save(ws).blocks.blocks), source)
  } finally {ws.dispose()}
})

test('real project editing round-trips all four files and can edit inside lambda without touching HTML/assets', { skip: !process.env.CPP_BLOCKLY_PROJECT }, () => {
  for (const name of ['sketch/src/main.cpp','sketch/libraries/GuwenUI/src/GuwenUI.cpp','sketch/libraries/GuwenUI/src/GuwenUI.h','sketch/libraries/GuwenUI/src/GuwenAssets.h']) {
    const source = readFileSync(join(process.env.CPP_BLOCKLY_PROJECT!, name), 'utf8'), result = convertCpp(parser, source), roots = serialized(result)
    assert.equal(generateCpp(source, result, roots), source, name)
    const callback = name === 'sketch/src/main.cpp' ? [...indexBlocks(roots).values()].find(b => b.type === 'cpp_preview_lambda' && [...indexBlocks([b]).values()].some(child => child.type === 'cpp_preview_value' && child.fields?.TEXT === '0')) : undefined
    const value = [...indexBlocks(callback ? [callback] : roots).values()].find(b => b.type === 'cpp_preview_value' && b.fields?.TEXT === '0')
    if (name === 'sketch/src/main.cpp') assert.ok(value, 'edit a value inside the callback')
    if (value) {
      const range = result.recipes![value.id]!
      value.fields!.TEXT = '1'
      assert.equal(generateCpp(source, result, roots), source.slice(0,range.start)+'1'+source.slice(range.end), name)
    }
  }
})

test('applying rejects stale source versions and uses one undoable synchronous transaction', () => {
  let text = 'old', version = 4, boundaries = 0, writes = 0
  const model = { getValue: () => text, getVersionId: () => version, isDisposed: () => false, pushStackElement: () => { boundaries++ }, getFullModelRange: () => ({startLineNumber:1,startColumn:1,endLineNumber:1,endColumn:4}), pushEditOperations: (_before: null, edits: Array<{text:string}>) => { writes++; text = edits[0]!.text; version++ } }
  assert.throws(() => applySource(model, {text:'old',version:3,dirty:false}, 'new'), /源码已变化/)
  assert.throws(() => applySource(model, {text:'different',version:4,dirty:false}, 'new'), /源码已变化/)
  assert.equal(writes, 0)
  applySource(model, {text:'old',version:4,dirty:false}, 'new')
  assert.equal(text, 'new'); assert.equal(boundaries, 2); assert.equal(writes, 1)
})

test('session drafts survive view disposal, validate before write, and reject edits arriving during validation', async () => {
  const source = 'void f(){delay(500);}', session = createCppSession()
  loadCppSession(session, {text:source,version:1,dirty:false}, convertCpp(parser, source))
  session.view = serialized(session.original!)
  const value = [...indexBlocks(session.view).values()].find(b => b.fields?.TEXT === '500')!
  value.fields!.TEXT = '750'; session.dirty = true
  assert.equal(sessionCode(session), source.replace('500','750'))
  let writes = 0
  const write = async (code: string) => { writes++; return {text:code,version:2,dirty:true} }
  await assert.rejects(applyCppSession(session, async code => { session.revision++; return convertCpp(parser,code) }, write), /继续变化/)
  assert.equal(writes,0); assert.equal(session.dirty,true)
  value.fields!.TEXT = 'broken('
  await assert.rejects(applyCppSession(session, async code => convertCpp(parser,code), write), /语法检查/)
  assert.equal(writes,0)
  value.fields!.TEXT = '750'
  await applyCppSession(session, async code => convertCpp(parser,code), write)
  assert.equal(writes,1); assert.equal(session.dirty,false); assert.equal(session.source!.text,source.replace('500','750'))
})

test('undoing a synchronized source diff reloads Blockly while an unsynchronized block draft stays protected', () => {
  const source = 'void f() { int value = 1; }'
  const expanded = 'void f() { int value = 1; value++; }'
  const session = createCppSession()
  loadCppSession(session, { text: source, version: 1, dirty: false }, convertCpp(parser, source))
  session.dirty = true
  const projected = { text: expanded, version: 2, dirty: true }
  const undone = { text: source, version: 3, dirty: true }
  assert.equal(cppSourceChangeAction(session, projected, true, true), 'synced')
  assert.equal(cppSourceChangeAction(session, undone, false, true), 'reload')
  assert.equal(cppSourceChangeAction(session, undone, false, false), 'conflict')
  loadCppSession(session, undone, convertCpp(parser, undone.text))
  assert.equal(session.dirty, false)
  assert.equal(sessionCode(session), source)
  assert.equal(cppSourceChangeAction(session, projected, false, false), 'reload')
})

test('every toolbox template loads with editable fields and connected default values', () => {
  const ws = new Blockly.Workspace()
  try {
    for (const category of (cppToolbox as {contents:Array<{contents:Blockly.serialization.blocks.State[]}>}).contents) for (const item of category.contents) {
      if (!item.type) continue
      const b = Blockly.serialization.blocks.append(item,ws)
      assert.ok(b); assert.ok(b.isEditable())
      if (b.type === 'cpp_preview_call') assert.equal(b.getField('NAME')?.isCurrentlyEditable(), true)
    }
  } finally {ws.dispose()}
})

test('math and text toolbox operations generate parseable C++ for every dropdown choice', () => {
  const categories = (cppToolbox as { contents: Array<{ name: string; contents: Blockly.serialization.blocks.State[] }> }).contents
  const types = new Set(['text_char', 'text_concat', 'text_unary', 'text_binary', 'text_slice', 'text_replace', 'text_code', 'number_base', 'math_unary', 'math_constant', 'math_property', 'math_random_int', 'math_random_float', 'math_atan2', 'math_round_decimal', 'math_bit_not', 'math_bit', 'math_bit_write', 'math_extract_bits', 'math_combine_bits'])
  const original = convertCpp(parser, '')
  for (const category of categories.filter(item => ['数学', '文字'].includes(item.name))) {
    const templates = category.contents.filter(item => types.has(item.type?.replace('cpp_preview_', '') ?? ''))
    assert.ok(templates.length >= 15, `${category.name} should expose a useful range of operations`)
    for (const template of templates) {
      const workspace = new Blockly.Workspace()
      try {
        const block = Blockly.serialization.blocks.append(template, workspace)!
        const choices = (['OP', 'CONST', 'BASE'].find(name => block.getField(name)) ? block.getField(['OP', 'CONST', 'BASE'].find(name => block.getField(name))!) as Blockly.FieldDropdown : undefined)?.getOptions(false).map(([, value]) => String(value)) ?? ['']
        for (const choice of choices) {
          const field = ['OP', 'CONST', 'BASE'].find(name => block.getField(name))
          if (field) block.setFieldValue(choice, field)
          if (field === 'BASE') block.setFieldValue({ DEC: '42', HEX: '2A', BIN: '101010' }[choice]!, 'DIGITS')
          const expression = Blockly.serialization.blocks.save(block) as PreviewBlock
          const roots: PreviewBlock[] = [{ type: 'cpp_preview_function', id: 'test-function', fields: { MODE: 'structured', TYPE: 'void', NAME: 'setup', PARAMETERS: '' }, inputs: { BODY: { block: { type: 'cpp_preview_declaration', id: 'test-variable', fields: { TYPE: 'auto', DECL: 'sample', INIT: '=' }, inputs: { VALUE: { block: expression } } } } } }]
          const code = generateCpp('', original, roots)
          assert.equal(convertCpp(parser, code).status, 'ready', `${category.name}/${block.type}/${choice}: ${code}`)
        }
      } finally { workspace.dispose() }
    }
  }
})

test('new math and text blocks update existing source through the Blockly projection', () => {
  const source = '#include <Arduino.h>\nvoid setup() { int sample = 0; String message = "x"; }\n'
  const original = convertCpp(parser, source), roots = serialized(original)
  const values = [...indexBlocks(roots).values()].filter(block => block.type === 'cpp_preview_declaration')
  assert.equal(values.length, 2)
  values[0]!.inputs!.VALUE = { block: { type: 'cpp_preview_math_unary', id: 'math-added', fields: { OP: 'ROOT' }, inputs: { NUM: { block: { type: 'cpp_preview_value', id: 'nine', fields: { TEXT: '9' } } } } } }
  values[1]!.inputs!.VALUE = { block: { type: 'cpp_preview_text_concat', id: 'text-added', inputs: { LEFT: { block: { type: 'cpp_preview_text', id: 'hello', fields: { TEXT: 'Hello' } } }, RIGHT: { block: { type: 'cpp_preview_text', id: 'world', fields: { TEXT: ' world' } } } } } }
  const code = generateCpp(source, original, roots)
  assert.match(code, /int sample = sqrt\(9\);/)
  assert.match(code, /String message = \(String\("Hello"\) \+ String\(" world"\)\);/)
  assert.equal(convertCpp(parser, code).status, 'ready')
})

test('reparented and copied expressions preserve C++ precedence', () => {
  const source = 'void f(){int x = a + b; int y = c * d;}'
  const result = convertCpp(parser, source), roots = serialized(result), all = [...indexBlocks(roots).values()]
  const addition = all.find(b => b.fields?.OP === '+')!, multiplication = all.find(b => b.fields?.OP === '*')!
  multiplication.inputs!.RIGHT = {block:structuredClone(addition)}
  const code = generateCpp(source, result, roots)
  assert.match(code, /c \* \(a \+ b\)/)
  assert.equal(convertCpp(parser,code).status,'ready')
})

test('statement reorder, parameter changes and opaque source edits regenerate safely', () => {
  const source = 'void f(){\n  first();\n  second();\n  third();\n  call(1,2);\n  try{run();}catch(...){stop();}\n}'
  const result = convertCpp(parser,source), roots = serialized(result), fn = roots[0]!
  const first = fn.inputs!.BODY!.block, second = first.next!.block, third = second.next!.block
  first.next = {block:third}; second.next = {block:first}; fn.inputs!.BODY!.block = second
  const blocks = [...indexBlocks(roots).values()], call = blocks.find(b=>b.fields?.NAME==='call')!
  call.extraState = {count:1}; delete call.inputs!.ARG1
  const opaque = blocks.find(b=>b.type==='cpp_preview_raw')!
  opaque.fields!.TEXT = 'try{runAgain();}catch(...){stop();}'
  const code = generateCpp(source,result,roots)
  assert.match(code,/second\(\);\s+first\(\);\s+third\(\);/)
  assert.ok(code.includes('call(1);')); assert.ok(code.includes('runAgain();'))
  assert.equal(convertCpp(parser,code).status,'partial')
})

test('class access labels keep their colon when members are added and new comments do not swallow braces', () => {
  for (const source of ['class S { public: int x; };', 'void f(){}']) {
    const result = convertCpp(parser,source), roots = serialized(result), owner = roots[0]!
    const comment: PreviewBlock = {type:'cpp_preview_comment',id:'comment',fields:{TEXT:'// added comment'}}
    if (owner.inputs?.BODY) { let end = owner.inputs.BODY.block; while (end.next) end = end.next.block; end.next = {block:comment} }
    else owner.inputs = {BODY:{block:comment}}
    const code = generateCpp(source,result,roots)
    assert.equal(convertCpp(parser,code).status,'ready',code)
    if (source.startsWith('class')) assert.ok(code.includes('public:'))
  }
})

test('quick else-if insertion keeps the old else, repeated branches, and single-step undo/redo', async () => {
  const source = 'void f(){ if(x) first(); else if(y) second(); else { /* retained */ last(); } after(); }'
  const result = convertCpp(parser, source), ws = new Blockly.Workspace()
  const code = () => generateCpp(source, result, Blockly.serialization.workspaces.save(ws).blocks.blocks)
  try {
    Blockly.serialization.workspaces.load({blocks:result.blocks}, ws)
    await settleEvents(); ws.clearUndo()
    const owner = ws.getAllBlocks(false).find(b => b.type === 'cpp_preview_if')!
    assert.equal(cppQuickActions(owner).find(a => a.id === 'else')?.enabled, false)
    quick(owner, 'else-if'); await settleEvents()
    const generated = code()
    assert.match(generated, /else if \(false\)/)
    assert.ok(generated.includes('/* retained */ last();'))
    assert.ok(generated.endsWith('after(); }'))
    assert.equal(convertCpp(parser, generated).status, 'ready')
    ws.undo(false); await settleEvents(); assert.equal(code(), source)
    ws.undo(true); await settleEvents(); assert.equal(code(), generated)
    quick(owner, 'else-if'); await settleEvents()
    assert.equal((code().match(/else if \(false\)/g) ?? []).length, 2)
    const saved = Blockly.serialization.workspaces.save(ws)
    const restored = new Blockly.Workspace()
    try {
      Blockly.serialization.workspaces.load(saved, restored)
      assert.equal(generateCpp(source, result, Blockly.serialization.workspaces.save(restored).blocks.blocks), code())
    } finally {restored.dispose()}
  } finally {ws.dispose()}
})

test('quick else mutation is undoable and never removes a populated alternative', async () => {
  const source = 'void f(){if(x){run();}}', result = convertCpp(parser, source), ws = new Blockly.Workspace()
  try {
    Blockly.serialization.workspaces.load({blocks:result.blocks}, ws)
    await settleEvents(); ws.clearUndo()
    const owner = ws.getAllBlocks(false).find(b => b.type === 'cpp_preview_if')!
    quick(owner, 'else'); await settleEvents()
    assert.ok(owner.getInput('ELSE'))
    assert.equal(cppQuickActions(owner).find(a => a.id === 'else')?.enabled, false)
    quick(owner, 'remove-else'); await settleEvents(); assert.equal(owner.getInput('ELSE'), null)
    ws.undo(false); await settleEvents(); assert.ok(owner.getInput('ELSE'))
    const body = Blockly.serialization.blocks.append({type:'cpp_preview_flow',fields:{TEXT:'return;'}}, ws)
    owner.getInput('ELSE')!.connection!.connect(body.previousConnection!)
    const remove = cppQuickActions(owner).find(a => a.id === 'remove-else')!
    assert.equal(remove.enabled, false); remove.run()
    assert.equal(owner.getInputTargetBlock('ELSE'), body)
  } finally {ws.dispose()}
})

test('quick switch branches preserve fallthrough/default order and restore byte-for-byte on undo', async () => {
  const source = 'void f(int x){switch(x){case 0x0: a(); case 01: b(); default: /* keep */ c();} after();}'
  const result = convertCpp(parser, source), ws = new Blockly.Workspace()
  const code = () => generateCpp(source, result, Blockly.serialization.workspaces.save(ws).blocks.blocks)
  try {
    Blockly.serialization.workspaces.load({blocks:result.blocks}, ws)
    await settleEvents(); ws.clearUndo()
    const owner = ws.getAllBlocks(false).find(b => b.type === 'cpp_preview_switch')!
    quick(owner, 'case'); await settleEvents()
    const generated = code()
    assert.ok(generated.includes('case 0x0: a(); case 01: b(); default: /* keep */ c();'))
    assert.match(generated, /c\(\);\s*case 2:\s*break;/)
    assert.equal(cppQuickActions(owner).find(a => a.id === 'default')?.enabled, false)
    cppQuickActions(owner).find(a => a.id === 'default')!.run()
    assert.equal(code(), generated)
    assert.equal(convertCpp(parser, generated).status, 'ready')
    ws.undo(false); await settleEvents(); assert.equal(code(), source)
    ws.undo(true); await settleEvents(); assert.equal(code(), generated)
    quick(owner, 'case'); await settleEvents(); assert.ok(code().includes('case 3:'))
  } finally {ws.dispose()}
})

test('default belongs to the nearest switch and nested labels cannot bypass duplicate prevention', () => {
  for (const source of ['void f(){switch(x){case 1: switch(y){default: break;}}}', 'void f(){switch(x){case 1: {default: break;}}}']) {
    const result = convertCpp(parser, source), ws = new Blockly.Workspace()
    try {
      Blockly.serialization.workspaces.load({blocks:result.blocks}, ws)
      const owner = ws.getAllBlocks(false).find(b => b.type === 'cpp_preview_switch')!
      const add = cppQuickActions(owner).find(a => a.id === 'default')!
      assert.equal(add.enabled, source.includes('switch(y)'))
      if (add.enabled) {
        add.run()
        assert.equal(cppQuickActions(owner).find(a => a.id === 'default')?.enabled, false)
        assert.equal(convertCpp(parser, generateCpp(source, result, Blockly.serialization.workspaces.save(ws).blocks.blocks)).status, 'ready')
      }
    } finally {ws.dispose()}
  }
})

test('quick argument/list items come connected and undo removes the entire addition', async () => {
  const source = 'void f(){run(1); int xs[]={2,3};}', result = convertCpp(parser, source), ws = new Blockly.Workspace()
  const code = () => generateCpp(source, result, Blockly.serialization.workspaces.save(ws).blocks.blocks)
  try {
    Blockly.serialization.workspaces.load({blocks:result.blocks}, ws)
    await settleEvents(); ws.clearUndo()
    for (const type of ['cpp_preview_call', 'cpp_preview_list']) {
      const owner = ws.getAllBlocks(false).find(b => b.type === type)!
      const count = owner.saveExtraState!().count
      quick(owner, 'argument'); await settleEvents()
      assert.equal(owner.getInputTargetBlock(`ARG${count}`)?.getFieldValue('TEXT'), '0')
      assert.equal(ws.getTopBlocks(false).length, 1)
      assert.equal(convertCpp(parser, code()).status, 'ready')
      ws.undo(false); await settleEvents(); assert.equal(code(), source)
    }
  } finally {ws.dispose()}
})

test('new switch/case blocks generate complete C++ and detached case labels are rejected', () => {
  const source = 'void f(){}', result = convertCpp(parser, source), roots = serialized(result)
  const label: PreviewBlock = {type:'cpp_preview_case',id:'case',fields:{HEADER:'case 1:'},inputs:{BODY:{block:{type:'cpp_preview_flow',id:'break',fields:{TEXT:'break;'}}}}}
  roots[0]!.inputs = {BODY:{block:{type:'cpp_preview_switch',id:'switch',fields:{HEADER:'switch (value)',FOOTER:''},inputs:{BODY:{block:label}}}}}
  assert.equal(convertCpp(parser, generateCpp(source, result, roots)).status, 'ready')
  roots[0]!.inputs = {BODY:{block:label}}
  assert.throws(() => generateCpp(source, result, roots), /必须放在 switch/)
})

test('type dropdown keeps canonical values and edits only the AST type span', async () => {
  const source = 'static const char* page = "hi";\r\nvolatile unsigned long ticks;\r\nuint8_t bytes[2] PROGMEM = {1,2};\r\nDevice::Value item{42};\r\nstd::array<int, 2> data;'
  const original = convertCpp(parser, source)
  assert.equal(original.status, 'ready')
  const ws = new Blockly.Workspace()
  try {
    Blockly.serialization.workspaces.load({ blocks: original.blocks }, ws)
    const save = () => Blockly.serialization.workspaces.save(ws).blocks!.blocks as PreviewBlock[]
    assert.equal(generateCpp(source, original, save()), source)
    const page = ws.getAllBlocks(false).find(b => b.getFieldValue('DECL') === 'page')!
    assert.ok(page.getField('TYPE') instanceof Blockly.FieldDropdown)
    assert.equal(page.getFieldValue('TYPE'), 'char*')
    assert.equal(page.getFieldValue('QUALIFIERS'), 'static const')
    assert.deepEqual(page.inputList[0]!.fieldRow.filter(field => field.name).map(field => field.name), ['QUALIFIERS', 'TYPE', 'DECL'])
    const custom = ws.getAllBlocks(false).find(b => b.getFieldValue('TYPE') === 'Device::Value')!
    assert.equal(custom.getField('TYPE')!.getText(), '源码类型 (Device::Value)')
    assert.ok((custom.getField('TYPE') as Blockly.FieldDropdown).getOptions(false).some(o => Array.isArray(o) && o[1] === 'Device::Value'))
    assert.ok(ws.getAllBlocks(false).some(b => b.getFieldValue('TYPE') === 'std::array<int, 2>'))
    await settleEvents(); ws.clearUndo()
    page.setFieldValue('uint8_t*', 'TYPE')
    await settleEvents()
    assert.equal(generateCpp(source, original, save()), source.replace('char*', 'uint8_t*'))
    ws.undo(false); await settleEvents()
    assert.equal(generateCpp(source, original, save()), source)
    ws.undo(true); await settleEvents()
    assert.equal(page.getFieldValue('TYPE'), 'uint8_t*')
    const bytes = ws.getAllBlocks(false).find(b => b.getFieldValue('DECL') === 'bytes[2] PROGMEM')!
    bytes.setFieldValue('uint16_t', 'TYPE')
    const ticks = ws.getAllBlocks(false).find(b => b.getFieldValue('TEXT') === 'ticks')!
    ticks.setFieldValue('uint32_t', 'TYPE')
    const expected = source.replace('char*', 'uint8_t*').replace('unsigned long ticks', 'uint32_t ticks').replace('uint8_t bytes', 'uint16_t bytes')
    assert.equal(generateCpp(source, original, save()), expected)
    assert.equal(convertCpp(parser, expected).status, 'ready')
    assert.equal(new Set(cppTypeOptions.map(o => o[1])).size, cppTypeOptions.length)
    assert.ok(cppTypeOptions.every(([, value]) => /^[\w *]+$/.test(value)))
  } finally { ws.dispose() }
})

test('qualifier dropdown translates common combinations without changing C++ values', () => {
  assert.deepEqual(codeOptions('qualifiers', 'static const').find(([, value]) => value === 'static const'), ['静态常量', 'static const'])
  assert.deepEqual(codeOptions('qualifiers', 'const static').find(([, value]) => value === 'const static'), ['常量静态存储', 'const static'])
  assert.deepEqual(codeOptions('qualifiers', 'thread_local const').find(([, value]) => value === 'thread_local const'), ['线程局部存储 · 常量 (thread_local const)', 'thread_local const'])
})

test('pointer type and edited fields can repeatedly update the source buffer without losing the baseline', () => {
  const source = 'static const char* page = "old";\nint untouched = 1;'
  const original = convertCpp(parser, source)
  const ws = new Blockly.Workspace()
  let text = source, version = 1
  const model = { getValue: () => text, getVersionId: () => version, isDisposed: () => false, pushStackElement: () => {}, getFullModelRange: () => ({ startLineNumber: 1, startColumn: 1, endLineNumber: 2, endColumn: 19 }), pushEditOperations: (_before: null, edits: Array<{text:string}>) => { text = edits[0]!.text; version++ } }
  try {
    Blockly.serialization.workspaces.load({ blocks: original.blocks }, ws)
    const page = ws.getAllBlocks(false).find(block => block.getFieldValue('DECL') === 'page')!
    const code = () => generateCpp(source, original, Blockly.serialization.workspaces.save(ws).blocks!.blocks as PreviewBlock[])
    const sync = () => { const expected = { text, version, dirty: true }; applySource(model, expected, code()); assert.equal(convertCpp(parser, text).status, 'ready') }
    assert.equal(page.getFieldValue('TYPE'), 'char*')
    page.setFieldValue('uint8_t*', 'TYPE'); sync()
    assert.equal(text, source.replace('char* page', 'uint8_t* page'))
    page.setFieldValue('buffer', 'DECL'); sync()
    assert.equal(text, source.replace('char* page', 'uint8_t* buffer'))
    page.getInputTargetBlock('VALUE')!.setFieldValue('new', 'TEXT'); sync()
    assert.equal(text, 'static const uint8_t* buffer = "new";\nint untouched = 1;')
    page.setFieldValue('char', 'TYPE'); sync()
    assert.equal(text, 'static const char buffer = "new";\nint untouched = 1;')
    const stale = { text, version, dirty: true }
    const externalEdit = () => { text += '\n// external'; version++ }
    externalEdit()
    assert.throws(() => applySource(model, stale, code()), /源码已变化/)
  } finally { ws.dispose() }
})

test('declaration types preserve references, function pointers, multiple declarators and whitespace', () => {
  const source = 'int a=1, *b=nullptr;\nint &ref = a;\nvoid (*handler)(int);\nunsigned   long time = 0;\nconst int\n count = 2;'
  const result = convertCpp(parser, source)
  assert.equal(result.status, 'ready')
  const roots = serialized(result)
  assert.equal(generateCpp(source, result, roots), source)
  const ref = [...indexBlocks(roots).values()].find(b => b.fields?.DECL === '&ref')!
  ref.fields!.TYPE = 'long'
  assert.equal(generateCpp(source, result, roots), source.replace('int &ref', 'long &ref'))
  const spaced = 'char * page;'
  const pointer = convertCpp(parser, spaced), pointerRoots = serialized(pointer)
  assert.equal(pointerRoots[0]?.fields?.TYPE, 'char*')
  assert.equal(pointerRoots[0]?.fields?.TEXT, 'page')
  pointerRoots[0]!.fields!.TYPE = 'void*'
  assert.equal(generateCpp(spaced, pointer, pointerRoots), 'void* page;')
})

test('source focus resolves innermost blocks and does not cross into the next line', () => {
  const source = 'void f(){\n  delay(10); delay(20);\n}\n\nvoid g(){\n  digitalWrite(2, HIGH);\n}'
  const result = convertCpp(parser, source)
  const locate = (line: number, column: number) => result.locations[blockAtPosition(result.locations, {line,column}) ?? '']?.text
  assert.equal(locate(2, 9), '10')
  assert.equal(locate(2, 1), 'delay(10)')
  assert.equal(locate(2, 16), 'delay(20)')
  assert.equal(locate(6, 3), 'digitalWrite(2, HIGH)')
  assert.equal(locate(4, 1), undefined)
  assert.equal(locate(20, 1), undefined)
})

test('base categories use C++ templates without Blockly-mode generator side effects', () => {
  const categories = (cppToolbox as {contents:Array<{name:string;contents:Blockly.serialization.blocks.State[]}>}).contents
  assert.deepEqual(categories.map(c => c.name), ['逻辑','循环','数学','文字','数组','变量','自定义函数','I/O引脚','时间','串口','中断','自定义代码'])
  const empty = convertCpp(parser, '')
  for (const name of ['I/O引脚', '时间', '串口', '中断', '变量', '数组']) {
    for (const template of categories.find(c => c.name === name)!.contents) {
      if (!template.type) continue
      const ws = new Blockly.Workspace()
      try {
        const block = Blockly.serialization.blocks.append(template, ws)
        if (!block.previousConnection || block.type === 'cpp_preview_value') continue
        const roots = Blockly.serialization.workspaces.save(ws).blocks!.blocks as PreviewBlock[]
        const code = generateCpp('', empty, roots)
        assert.equal(convertCpp(parser, `void f(){${code}}`).status, 'ready', code)
        if (name === 'I/O引脚' && code.includes('digitalWrite')) assert.ok(!code.includes('pinMode'))
        if (name === '串口' && code.includes('Serial.print')) assert.ok(!code.includes('Serial.begin'))
      } finally { ws.dispose() }
    }
  }
})

test('beginner dropdowns preserve C++ values, update labels, and undo the actual source edits', async () => {
  const source = 'void setup(){pinMode(2, OUTPUT);}\nvoid loop(){if(count < 10 && true){digitalWrite(2,HIGH);delay(500);Serial.println("hi");}}'
  const result = convertCpp(parser, source), ws = new Blockly.Workspace()
  try {
    Blockly.serialization.workspaces.load({ blocks: result.blocks }, ws)
    const blocks = ws.getAllBlocks(false), code = () => generateCpp(source, result, Blockly.serialization.workspaces.save(ws).blocks!.blocks as PreviewBlock[])
    const setup = blocks.find(block => block.getFieldValue('SIGNATURE') === 'void setup()')!
    assert.equal(setup.getField('SIGNATURE')!.getText(), '开机时执行一次')
    const delay = blocks.find(block => block.getFieldValue('NAME') === 'delay')!
    assert.equal(delay.getField('NAME')!.getText(), '等待（毫秒）')
    assert.equal(delay.getFieldValue('LABEL0'), '时长')
    assert.equal(delay.getFieldValue('SUFFIX'), '毫秒')
    assert.equal(code(), source)
    await settleEvents(); ws.clearUndo()
    Blockly.Events.setGroup(true)
    blocks.find(block => block.getFieldValue('TEXT') === 'OUTPUT')!.setFieldValue('INPUT_PULLUP', 'TEXT')
    blocks.find(block => block.getFieldValue('TEXT') === 'HIGH')!.setFieldValue('LOW', 'TEXT')
    blocks.find(block => block.getFieldValue('OP') === '<')!.setFieldValue('>=', 'OP')
    delay.setFieldValue('delayMicroseconds', 'NAME')
    Blockly.Events.setGroup(false)
    await settleEvents()
    assert.equal(delay.getFieldValue('SUFFIX'), '微秒')
    assert.equal(delay.getField('NAME')!.getText(), '等待（微秒）')
    assert.match(code(), /pinMode\(2, INPUT_PULLUP\)/)
    assert.match(code(), /digitalWrite\(2,LOW\)/)
    assert.match(code(), /count >= 10/)
    assert.match(code(), /delayMicroseconds\(500\)/)
    assert.equal(convertCpp(parser, code()).status, 'ready')
    ws.undo(false); await settleEvents()
    assert.equal(code(), source)
    assert.equal(delay.getFieldValue('SUFFIX'), '毫秒')
    ws.undo(true); await settleEvents()
    assert.match(code(), /delayMicroseconds\(500\)/)
  } finally { Blockly.Events.setGroup(false); ws.dispose() }
})

test('repeat blocks edit only exact counting loops; other iterator semantics remain advanced', () => {
  const source = 'void f(){for(int index=0; index<10; ++index) { use(index); }\nfor(unsigned long i=0;i<10;i++)use(i);\nfor(int j=1;j<=10;j+=2)use(j);}'
  const result = convertCpp(parser, source), roots = serialized(result), blocks = [...indexBlocks(roots).values()]
  const repeat = blocks.find(block => block.type === 'cpp_preview_repeat')!
  assert.ok(repeat)
  assert.equal(repeat.fields?.COUNTER, 'index')
  assert.equal(blocks.filter(block => block.type === 'cpp_preview_repeat').length, 1)
  assert.equal(blocks.filter(block => block.type === 'cpp_preview_loop').length, 2)
  assert.equal(generateCpp(source, result, roots), source)
  repeat.inputs!.TIMES!.block.fields!.TEXT = '4'
  assert.equal(generateCpp(source, result, roots), source.replace('index<10', 'index<4'))
})

test('condition loop modes preserve bodies and produce while, until and do-while semantics', () => {
  const source = 'void f(){while (ready()) { /* keep */ run(); } after();}'
  const result = convertCpp(parser, source), roots = serialized(result)
  const loop = [...indexBlocks(roots).values()].find(block => block.type === 'cpp_preview_while')!
  assert.equal(generateCpp(source, result, roots), source)
  loop.fields!.MODE = 'until'
  const until = generateCpp(source, result, roots)
  assert.match(until, /while \(!\(/)
  assert.ok(until.includes('/* keep */'))
  assert.ok(until.endsWith(' after();}'))
  assert.equal(convertCpp(parser, until).status, 'ready')
  loop.fields!.MODE = 'do'
  const once = generateCpp(source, result, roots)
  assert.match(once, /do \{/)
  assert.match(once, /\} while \(/)
  assert.equal(convertCpp(parser, once).status, 'ready')
  const declaration = convertCpp(parser, 'void f(){while (int x = read()) use(x);}')
  assert.ok(!flatten(declaration).some(block => block.type === 'cpp_preview_while'))
})

test('plain text blocks escape quotes, backslashes and control characters when generating C++', () => {
  const source = 'void loop(){Serial.println("hello");}'
  const result = convertCpp(parser, source), roots = serialized(result)
  const text = [...indexBlocks(roots).values()].find(block => block.type === 'cpp_preview_text')!
  assert.equal(text.fields?.TEXT, 'hello')
  text.fields!.TEXT = '中文 "quoted" \\ path\n\u0000f'
  const code = generateCpp(source, result, roots)
  assert.ok(code.includes('"中文 \\"quoted\\" \\\\ path\\012\\000f"'), code)
  assert.equal(convertCpp(parser, code).status, 'ready')
  const advanced = 'const char* a=u8"hello"; const char* b="\\x41\\0";'
  const parsed = convertCpp(parser, advanced)
  assert.equal(generateCpp(advanced, parsed, serialized(parsed)), advanced)
})

test('Chinese toolbox search finds beginner operations and connected templates generate valid C++', () => {
  const categories = (cppToolbox as Blockly.utils.toolbox.ToolboxInfo).contents as Blockly.utils.toolbox.StaticCategoryInfo[]
  assert.ok(filterCppCategories(categories, '等待').some(category => category.name === '时间'))
  assert.ok(filterCppCategories(categories, '重复').some(category => category.name === '循环'))
  assert.ok(filterCppCategories(categories, '换行').some(category => category.name === '串口'))
  const original = convertCpp(parser, 'void loop(){}'), ws = new Blockly.Workspace()
  try {
    for (const category of categories) for (const item of category.contents) {
      if (item.kind !== 'block' || !('type' in item) || typeof item.type !== 'string' || !['cpp_preview_repeat', 'cpp_preview_while'].includes(item.type)) continue
      Blockly.serialization.workspaces.load({ blocks: original.blocks }, ws)
      const loop = Blockly.serialization.blocks.append(item as Blockly.serialization.blocks.State, ws)
      const body = Blockly.serialization.blocks.append({ type: 'cpp_preview_statement', inputs: { VALUE: { block: { type: 'cpp_preview_action', fields: { NAME: 'delay' }, extraState: { count: 1 }, inputs: { ARG0: { block: { type: 'cpp_preview_value', fields: { TEXT: '100' } } } } } } } }, ws)
      ws.getBlockById(original.blocks.blocks[0]!.id)!.getInput('BODY')!.connection!.connect(loop.previousConnection!)
      loop.getInput('BODY')!.connection!.connect(body.previousConnection!)
      const code = generateCpp('void loop(){}', original, Blockly.serialization.workspaces.save(ws).blocks!.blocks as PreviewBlock[])
      assert.ok(code.includes('delay(100);'))
      assert.equal(convertCpp(parser, code).status, 'ready', code)
      ws.clear()
    }
  } finally { ws.dispose() }
})
