import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Language, Parser } from 'web-tree-sitter'
import { discoverProjectLibraries, readLibraryHeaders, type LibraryFileSystem, type ProjectLibrary } from './libraryCatalog.js'
import { extractLibraryApi } from './libraryApi.js'
import { addLibraryIncludes, libraryBlockInfo, libraryCategory, libraryExportBlock, filterCppCategories } from './libraryToolbox.js'
import { Blockly, registerCppPreviewBlocks } from './blocks.js'
import { convertCpp } from './converter.js'
import { generateCpp } from './generator.js'
import { annotateLibraryCalls, libraryMethodKey, setLibraryEntries } from './librarySelection.js'
import { fieldSourceLocation, parsedBlockId } from './fieldLocation.js'
import type { PreviewBlock } from './types.js'

let parser: Parser
before(async () => {
  await Parser.init(); parser = new Parser()
  parser.setLanguage(await Language.load(createRequire(import.meta.url).resolve('tree-sitter-cpp/tree-sitter-cpp.wasm')))
  registerCppPreviewBlocks()
})
after(() => parser.delete())

function filesystem(files: Record<string, string>): LibraryFileSystem {
  return { readText: async path => files[path], async readDirectory(path) {
    const entries = new Map<string, boolean>()
    for (const name of Object.keys(files).filter(name => name.startsWith(path + '/'))) {
      const [child, ...rest] = name.slice(path.length + 1).split('/')
      entries.set(child!, !!rest.length)
    }
    return [...entries].map(([name, isDirectory]) => ({ name, isDirectory }))
  } }
}
const library: ProjectLibrary = { id: 'sketch/libraries/Demo', roots: ['sketch/libraries/Demo'], name: '示例传感器', version: '1.2.3' }
const header = `#ifndef SENSOR_H
#define SENSOR_H
#include <stdint.h>
namespace api {
enum class Mode { Off, On };
class Sensor {
  void hidden();
public:
  Sensor(int pin = 2);
  void begin(Mode mode = Mode::On);
  int read(int channel);
  int read() const;
  static bool available();
  static constexpr int LIMIT = 12;
  void removed() = delete;
protected: void protectedMethod();
private: class Private { public: void leak(); };
};
extern Sensor Device;
void write(uint8_t value);
int read(uint8_t pin = 2);
template<class T> void consume(T& value);
template<class T> class Box { public: Box(T value); T get(); };
#if defined(ESP32)
void espOnly();
#endif
namespace detail { void implementation(); }
}
#endif`
const api = () => extractLibraryApi(parser, [{ include: 'Sensor.h', path: 'Sensor.h', source: header }])

test('library and method dropdowns update the call, arguments and header; imported calls keep source mapping', async () => {
  const first = api()
  const other: ProjectLibrary = { id: 'sketch/libraries/Other', roots: ['sketch/libraries/Other'], name: '另一库', version: '1' }
  const otherApi = extractLibraryApi(parser, [{ include: 'Other.h', path: 'Other.h', source: 'void other(int value);' }])
  const workspace = new Blockly.Workspace()
  setLibraryEntries(workspace, [{ library, api: first }, { library: other, api: otherApi }])
  try {
    const initial = first.exports.find(item => item.name === 'api::read')!
    const template = libraryExportBlock(library, initial)
    const call = Blockly.serialization.blocks.append(template, workspace)
    assert.equal(call.type, 'cpp_preview_library_call')
    assert.ok(call.getField('LIBRARY') instanceof Blockly.FieldDropdown)
    assert.ok(call.getField('METHOD') instanceof Blockly.FieldDropdown)
    const write = first.exports.find(item => item.name === 'api::write')!
    call.getField('METHOD')!.setValue(libraryMethodKey(write))
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(call.getFieldValue('NAME'), 'api::write')
    assert.equal(call.getInputTargetBlock('ARG0')?.getFieldValue('TEXT'), '0')
    call.getField('LIBRARY')!.setValue(other.id)
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(call.getFieldValue('NAME'), 'other')
    assert.equal(libraryBlockInfo(call.data)?.header, 'Other.h')
    const source = '#include <Sensor.h>\nvoid loop(){api::write(1);}'
    const original = convertCpp(parser, source)
    const roots = structuredClone(original.blocks.blocks)
    assert.ok(annotateLibraryCalls(original.blocks.blocks, source, [{ library, api: first }]))
    assert.ok(annotateLibraryCalls(roots, source, [{ library, api: first }]))
    assert.equal(generateCpp(source, original, roots), source)
    const imported = roots[1]!.inputs!.BODY!.block.inputs!.VALUE!.block
    assert.equal(imported.type, 'cpp_preview_library_call')
    assert.equal(libraryBlockInfo(imported.data)?.header, 'Sensor.h')
  } finally { workspace.dispose() }
})

test('imported optional arguments survive catalog loading and method changes undo argument removal', async () => {
  const first = api(), workspace = new Blockly.Workspace()
  setLibraryEntries(workspace, [{ library, api: first }])
  const source = '#include <Sensor.h>\nvoid loop(){api::Device.begin(api::Mode::Off);}'
  const original = convertCpp(parser, source)
  annotateLibraryCalls(original.blocks.blocks, source, [{ library, api: first }])
  try {
    Blockly.serialization.workspaces.load({ blocks: original.blocks }, workspace)
    await new Promise(resolve => setTimeout(resolve, 20))
    const code = () => generateCpp(source, original, Blockly.serialization.workspaces.save(workspace).blocks!.blocks as PreviewBlock[])
    const call = workspace.getAllBlocks(false).find(block => block.type === 'cpp_preview_library_call')!
    assert.equal(call.getInputTargetBlock('ARG0')?.getFieldValue('TEXT'), 'api::Mode::Off')
    assert.equal(code(), source)
    workspace.clearUndo()
    const noArgs = first.exports.find(item => item.name === 'api::Sensor::available')!
    call.getField('METHOD')!.setValue(libraryMethodKey(noArgs))
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.match(code(), /api::Sensor::available\(\);/)
    const generated = code(), parsed = convertCpp(parser, generated)
    const draft = Blockly.serialization.workspaces.save(workspace).blocks!.blocks as PreviewBlock[]
    const mapped = parsedBlockId(draft, parsed.blocks.blocks, call.id)!
    assert.equal(fieldSourceLocation(generated, parsed, mapped, 'METHOD')?.text, 'api::Sensor::available')
    workspace.undo(false)
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(code(), source)
    workspace.undo(true)
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.match(code(), /api::Sensor::available\(\);/)
  } finally { workspace.dispose() }
})

test('catalog follows active installed npm dependencies and deduplicates materialized Coder sources', async () => {
  const pkg = 'node_modules/@aily-project/lib-sensor'
  const files = {
    'package.json': JSON.stringify({ dependencies: { '@aily-project/lib-sensor': '1', '@aily-project/lib-missing': '1' } }),
    [`${pkg}/package.json`]: JSON.stringify({ name: '@aily-project/lib-sensor', nickname: '传感器', version: '1', dependencies: { '@aily-project/lib-support': '2' } }),
    [`${pkg}/src/src/Sensor/library.properties`]: 'name=Sensor\nversion=1',
    [`${pkg}/src/src/Sensor/src/Sensor.h`]: header,
    'node_modules/@aily-project/lib-support/package.json': JSON.stringify({ name: '@aily-project/lib-support', version: '2' }),
    'node_modules/@aily-project/lib-support/src/Support.h': 'void support();',
    'node_modules/@aily-project/lib-stale/package.json': JSON.stringify({ name: '@aily-project/lib-stale' }),
    'sketch/libraries/Sensor/library.properties': 'name=Sensor\nversion=1',
    'sketch/libraries/Sensor/.aily-blockly-library.json': JSON.stringify({ source: 'blockly-library', packageName: '@aily-project/lib-sensor' }),
    'sketch/libraries/Sensor/src/Sensor.h': header,
    'sketch/libraries/Local/library.properties': 'name=Local\nversion=3',
    'sketch/libraries/Local/src/Local.h': 'void local();'
  }
  const before = await discoverProjectLibraries(filesystem(files))
  assert.equal(before.length, 3)
  assert.deepEqual(before.find(lib => lib.name === '传感器')?.roots, ['sketch/libraries/Sensor'])
  assert.ok(before.some(lib => lib.packageName === '@aily-project/lib-support'))
  assert.ok(!before.some(lib => /stale|missing/.test(lib.id)))
  files['package.json'] = '{}'
  const after = await discoverProjectLibraries(filesystem(files))
  assert.equal(after.length, 2)
  assert.ok(after.every(lib => lib.id.startsWith('sketch/libraries/')))
})

test('header discovery honors public includes, wrapper paths, comments and the library boundary', async () => {
  const fs = filesystem({
    'sketch/libraries/Demo/library.properties': 'name=Demo\nincludes=Public.h',
    'sketch/libraries/Demo/src/Public.h': '#include "detail/Api.h"\n#include "../outside.h"\n/* #include "Private.h" */\nvoid publicApi();',
    'sketch/libraries/Demo/src/detail/Api.h': 'int read();\n#include "../Public.h"',
    'sketch/libraries/Demo/src/Private.h': 'void privateApi();',
    'sketch/libraries/Demo/outside.h': 'void outside();'
  })
  const result = await readLibraryHeaders(fs, library)
  assert.equal(result.headers.length, 2)
  assert.ok(result.headers.every(h => h.include === 'Public.h'))
  assert.ok(!result.headers.some(h => /Private|outside/.test(h.path)))
  assert.deepEqual(result.notices, [])
  const empty = await readLibraryHeaders(filesystem({}), library)
  assert.match(empty.notices[0]!, /未找到/)
})

test('unseen libraries generate callable blocks across root, src, include and nested layouts, and refresh after replacement', async () => {
  const layouts = [
    { base: '', include: 'Api.h' },
    { base: 'src/', include: 'Api.hh' },
    { base: 'include/', include: 'Api.hpp' },
    { base: 'src/include/', include: 'Api.hxx' },
    { base: 'src/', include: 'vendor/nested/Api.hpp' },
    { base: 'include/', include: 'vendor/nested/Api.hpp' }
  ]
  for (const installation of ['npm', 'local']) for (const layout of layouts) {
    const token = randomBytes(6).toString('hex'), name = `Library${token}`, scope = `api${token}`, fn = `send${token}`, className = `Device${token}`
    const packageName = `@aily-project-coder/lib-${token}`
    const root = installation === 'npm' ? `node_modules/${packageName}` : `sketch/libraries/${name}`
    const include = layout.include.replace('Api', name), path = `${root}/${layout.base}${include}`
    const files: Record<string, string> = {
      'package.json': JSON.stringify({ dependencies: installation === 'npm' ? { [packageName]: '1' } : {} }),
      ...(installation === 'npm' ? { [`${root}/package.json`]: JSON.stringify({ name: packageName, nickname: name, version: '1' }) } : {}),
      [path]: `namespace ${scope} {
        class ${className} { public: ${className}(); void start(bool enabled = true); private: void hidden(); };
        extern ${className} Current;
        enum class State { Ready, Stopped };
        void ${fn}(unsigned int i, bool enabled = true);
      }`
    }
    const fs = filesystem(files)
    const libraries = await discoverProjectLibraries(fs)
    assert.equal(libraries.length, 1, `${installation}/${layout.base}/${include}`)
    const found = libraries[0]!, headers = await readLibraryHeaders(fs, found), extracted = extractLibraryApi(parser, headers.headers)
    assert.deepEqual(headers.notices, [])
    assert.ok(headers.headers.every(header => header.include === include), `${path}: ${JSON.stringify(headers.headers.map(header => header.include))}`)
    assert.ok(extracted.exports.some(item => item.kind === 'constructor' && item.name === `${scope}::${className}`))
    assert.equal(extracted.exports.find(item => item.name === 'start')?.receiver, `${scope}::Current`)
    assert.ok(extracted.exports.some(item => item.name === `${scope}::State::Ready`))
    assert.ok(!extracted.exports.some(item => item.name === 'hidden'))
    const call = extracted.exports.find(item => item.name === `${scope}::${fn}`)!
    assert.equal(call.parameters[0]?.type, 'unsigned int')
    const workspace = new Blockly.Workspace()
    try {
      const source = 'void loop() {}', original = convertCpp(parser, source)
      Blockly.serialization.workspaces.load({ blocks: original.blocks }, workspace)
      const constructor = Blockly.serialization.blocks.append(libraryExportBlock(found, extracted.exports.find(item => item.kind === 'constructor')!), workspace)
      assert.equal(constructor.getFieldValue('TYPE'), `${scope}::${className}`)
      assert.ok(constructor.getField('TYPE')!.getText().includes(`${scope}::${className}`))
      const block = Blockly.serialization.blocks.append(libraryExportBlock(found, call), workspace)
      workspace.getBlockById(original.blocks.blocks[0]!.id)!.getInput('BODY')!.connection!.connect(constructor.previousConnection!)
      constructor.nextConnection!.connect(block.previousConnection!)
      const code = generateCpp(source, original, Blockly.serialization.workspaces.save(workspace).blocks!.blocks as PreviewBlock[])
      assert.ok(code.includes(`#include <${include}>`), code)
      assert.ok(code.includes(`${scope}::${className} device${token};`), code)
      assert.ok(code.includes(`${scope}::${fn}(0);`), code)
      assert.notEqual(convertCpp(parser, code).status, 'error', code)
    } finally { workspace.dispose() }
    // Same catalog, different header and API; no adapter or registration changed.
    delete files[path]
    const replacement = `replace${randomBytes(6).toString('hex')}`
    files[path.replace(/\.[^.]+$/, '.h')] = `void ${replacement}();`
    const refreshed = extractLibraryApi(parser, (await readLibraryHeaders(fs, (await discoverProjectLibraries(fs))[0]!)).headers)
    assert.deepEqual(refreshed.exports.map(item => item.name), [replacement])
    delete files[path.replace(/\.[^.]+$/, '.h')]
    assert.equal((await readLibraryHeaders(fs, found)).headers.length, 0)
  }
})

test('recursive public discovery excludes implementation folders, handles empty includes and retains umbrella includes', async () => {
  const root = library.roots[0]!
  const headers = await readLibraryHeaders(filesystem({
    [`${root}/library.properties`]: 'name=Demo\nincludes= ',
    [`${root}/include/Public.h`]: '#include "vendor/Api.hpp"\n#include "detail/Referenced.h"',
    [`${root}/include/vendor/Api.hpp`]: 'void nested();',
    [`${root}/include/detail/Referenced.h`]: 'void referenced();',
    [`${root}/include/detail/Hidden.h`]: 'void hidden();',
    [`${root}/include/examples/Example.h`]: 'void example();',
    [`${root}/include/private/Private.h`]: 'void privateApi();',
    [`${root}/src/Implementation.h`]: 'void implementation();'
  }), library)
  assert.deepEqual(headers.notices, [])
  assert.equal(headers.headers.length, 3)
  assert.ok(headers.headers.every(header => header.include === 'Public.h'))
  assert.deepEqual(extractLibraryApi(parser, headers.headers).exports.map(item => item.name).sort(), ['nested', 'referenced'])
})

test('parameter types use AST spans even when names also appear inside types', () => {
  const result = extractLibraryApi(parser, [{ path: 'Api.h', include: 'Api.h', source: 'void send(unsigned int i, device_type device, const char* c);' }])
  assert.deepEqual(result.exports[0]!.parameters.map(parameter => parameter.type), ['unsigned int', 'device_type', 'const char*'])
})

test('public API extraction keeps overloads, defaults, namespaces, static calls, constants and singleton receivers', () => {
  const result = api()
  assert.equal(result.exports.filter(e => e.owner === 'api::Sensor' && e.name === 'read').length, 2)
  const begin = result.exports.find(e => e.name === 'begin')!
  assert.equal(begin.receiver, 'api::Device')
  assert.equal(begin.parameters[0]?.defaultValue, 'Mode::On')
  assert.equal(begin.returnsVoid, true)
  assert.equal(begin.conditional, false)
  assert.ok(result.exports.some(e => e.name === 'api::Mode::On'))
  assert.ok(result.exports.some(e => e.name === 'api::Sensor::LIMIT'))
  assert.equal(result.exports.find(e => e.name === 'api::Sensor::available')?.kind, 'function')
  assert.ok(result.exports.some(e => e.kind === 'constructor' && e.name === 'api::Sensor'))
  assert.ok(!result.exports.some(e => /hidden|protectedMethod|removed|leak|implementation/.test(e.name)))
  assert.ok(!result.exports.some(e => e.kind === 'constructor' && e.owner === 'api::Box'))
  assert.ok(result.exports.some(e => e.kind === 'method' && e.owner === 'api::Box'))
  assert.equal(result.exports.find(e => e.name === 'api::espOnly')?.conditional, true)
})

test('every exported template loads in Blockly and preserves library metadata through serialization', () => {
  const workspace = new Blockly.Workspace()
  try {
    for (const item of api().exports) {
      const template = libraryExportBlock(library, item)
      const block = Blockly.serialization.blocks.append(template, workspace)
      const saved = Blockly.serialization.blocks.save(block)!
      const call = block.type === 'cpp_preview_call' ? block : block.getInputTargetBlock('VALUE')
      const parameters = item.parameters.filter(parameter => parameter.defaultValue === undefined)
      if (call?.type === 'cpp_preview_call' && parameters.length) assert.equal(call.getFieldValue('LABEL0'), `参数 ${parameters[0]!.name}`)
      const metadata = libraryBlockInfo(saved.data ?? saved.inputs?.VALUE?.block?.data)
      assert.equal(metadata?.header, 'Sensor.h')
      const source = 'void loop() {}'
      const original = convertCpp(parser, source)
      const roots = structuredClone(original.blocks.blocks)
      roots[0]!.inputs = { BODY: { block: (block.outputConnection
        ? { id: 'exec', type: 'cpp_preview_statement', inputs: { VALUE: { block: saved } } }
        : saved) as PreviewBlock } }
      const code = generateCpp(source, original, roots)
      assert.equal((code.match(/#include <Sensor.h>/g) ?? []).length, 1)
      assert.notEqual(convertCpp(parser, code).status, 'error', `${item.signature}\n${code}`)
      block.dispose()
    }
  } finally { workspace.dispose() }
})

test('dragged calls generate only selected library code and required headers; undo restores the original exactly', async () => {
  const source = '// untouched\r\nvoid loop() {\r\n}\r\n'
  const original = convertCpp(parser, source)
  const workspace = new Blockly.Workspace()
  try {
    Blockly.serialization.workspaces.load({ blocks: original.blocks }, workspace)
    const template = libraryExportBlock(library, api().exports.find(item => item.name === 'api::write')!)
    Blockly.Events.setGroup(true)
    const call = Blockly.serialization.blocks.append(template, workspace, { recordUndo: true })
    workspace.getBlockById(original.blocks.blocks.find(block => block.type === 'cpp_preview_function')!.id)!.getInput('BODY')!.connection!.connect(call.previousConnection!)
    Blockly.Events.setGroup(false)
    await new Promise(resolve => setTimeout(resolve, 15))
    const code = () => generateCpp(source, original, Blockly.serialization.workspaces.save(workspace).blocks!.blocks as PreviewBlock[])
    const generated = code()
    assert.match(generated, /^#include <Sensor.h>\r\n\/\/ untouched/)
    assert.match(generated, /api::write\(0\);/)
    assert.ok(!/Serial\.begin|pinMode|setup\(/.test(generated))
    workspace.undo(false)
    assert.equal(code(), source)
    workspace.undo(true)
    assert.equal(code(), generated)
  } finally { Blockly.Events.setGroup(false); workspace.dispose() }
})

test('include insertion ignores raw text and comments, respects existing includes and validates header metadata', () => {
  const block = libraryExportBlock(library, api().exports.find(e => e.name === 'api::read')!) as PreviewBlock
  for (const code of ['#include "Sensor.h"\nvoid loop(){}', '#define SENSOR_HEADER <Sensor.h>\n#include SENSOR_HEADER\nvoid loop(){}']) assert.equal(addLibraryIncludes(code, [block]), code)
  for (const code of ['/*\n#include <Sensor.h>\n*/\nvoid loop(){}', 'const char* html=R"html(\n#include <Sensor.h>\n)html";\nvoid loop(){}', '#if BOARD\n#include <Sensor.h>\n#endif\nvoid loop(){}']) assert.ok(addLibraryIncludes(code, [block]).startsWith('#include <Sensor.h>\n'))
  assert.equal(libraryBlockInfo('cpp-library-v1:{"header":"../Private.h","signature":"bad","library":"bad"}'), undefined)
})

test('library search matches API signatures and retains the correct block, library name and empty state', () => {
  const category = libraryCategory(library, api())
  const filtered = filterCppCategories([category], 'available')
  assert.equal(filtered.length, 1)
  assert.ok(filtered[0]!.contents.some(item => item.kind === 'block'))
  assert.ok(filtered[0]!.contents.every(item => JSON.stringify(item).includes('available')))
  assert.deepEqual(filterCppCategories([category], '示例传感器'), [category])
  assert.deepEqual(filterCppCategories([category], 'nonexistentApi'), [])
  assert.ok(libraryCategory(library, { exports: [], notices: [] }).contents.some(item => 'text' in item && /没有/.test(item.text as string)))
})

test('real GuwenUI public header exposes drawFrame and constants without loading its implementation', { skip: !process.env.CPP_BLOCKLY_PROJECT }, () => {
  const source = readFileSync(join(process.env.CPP_BLOCKLY_PROJECT!, 'sketch/libraries/GuwenUI/src/GuwenUI.h'), 'utf8')
  const result = extractLibraryApi(parser, [{ path: 'GuwenUI.h', include: 'GuwenUI.h', source }])
  assert.equal(result.exports.length, 10)
  assert.ok(result.exports.some(item => item.name === 'GuwenUI::drawFrame' && item.returnsVoid))
  assert.ok(result.exports.some(item => item.name === 'GuwenUI::COLOR_RED'))
})
