import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Language, Parser } from 'web-tree-sitter'
import { convertCpp } from './converter.js'
import { generateCpp, indexBlocks, mergeScope } from './generator.js'
import { applySource } from './applySource.js'
import { applyCppSession, createCppSession, loadCppSession, sessionCode } from './editorSession.js'
import { cppToolbox } from './toolbox.js'
import { Blockly, registerCppPreviewBlocks } from './blocks.js'
import { isCppPreviewFile, MAX_SOURCE_LENGTH, type CppPreview, type PreviewBlock } from './types.js'

let parser: Parser
before(async () => {
  await Parser.init()
  parser = new Parser()
  parser.setLanguage(await Language.load(createRequire(import.meta.url).resolve('tree-sitter-cpp/tree-sitter-cpp.wasm')))
  registerCppPreviewBlocks()
})
after(() => parser.delete())

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
  const calls = flatten(result).filter(b => b.type === 'cpp_preview_call')
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
  const result = convertCpp(parser, 'void loop(){ for(unsigned long i=0;i<=n;i+=step()) { work(i); } do { x++; } while(x<4); while(ready()) break; }')
  const loops = flatten(result).filter(b => b.type === 'cpp_preview_loop')
  assert.equal(result.status, 'ready')
  assert.equal(loops[0]?.fields?.HEADER, 'for(unsigned long i=0;i<=n;i+=step())')
  assert.equal(loops[1]?.fields?.FOOTER, 'while(x<4);')
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
  assert.ok(flatten(result).some(b => b.fields?.TEXT === 'volatile unsigned long ticks'))
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
  const call = flatten(result).find(b => b.type === 'cpp_preview_call')!
  assert.equal(result.locations[call.id]?.line, 3)
  assert.equal(result.locations[call.id]?.column, 3)
  const literal = flatten(result).find(b => b.fields?.TEXT?.includes('<script>'))!
  assert.equal(literal.fields?.TEXT, '"<script> & \\"hi\\""')
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
  assert.equal(declaration.fields?.DECL, 'static const char PAGE[] PROGMEM')
  const data = declaration.inputs!.VALUE!.block
  assert.equal(result.locations[data.id]?.text, 'R"HTML(<script>PROGMEM [] =</script>)HTML"')
  assert.equal(result.locations[declaration.id]?.line, 2)
  assert.ok(flatten(result).some(b => b.fields?.DECL === 'int PROGMEM'))
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
  assert.ok(all.some(b => b.fields?.DECL === 'static constexpr int RED' && b.inputs?.VALUE?.block.fields?.TEXT === '0xF800'))
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

test('every toolbox template loads with editable fields and connected default values', () => {
  const ws = new Blockly.Workspace()
  try {
    for (const category of (cppToolbox as {contents:Array<{contents:Blockly.serialization.blocks.State[]}>}).contents) for (const item of category.contents) {
      const b = Blockly.serialization.blocks.append(item,ws)
      assert.ok(b); assert.ok(b.isEditable())
      if (b.type === 'cpp_preview_call') assert.equal(b.getField('NAME')?.isCurrentlyEditable(), true)
    }
  } finally {ws.dispose()}
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
