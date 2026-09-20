import assert from 'node:assert/strict'
import test from 'node:test'
import { findLibraryUsage, sourceIncludes, type LibraryUsageFileSystem } from './ailyLibraryUsage.js'

const ROOT = 'node_modules/@aily-project/lib-servo/src/Servo'
function fixture(files: Record<string, string>, documents: Record<string, string> = {}): LibraryUsageFileSystem {
  return {
    documents: new Map(Object.entries(documents)),
    async readDirectory(path) {
      const entries = new Map<string, { name: string; isDirectory: boolean }>()
      for (const file of Object.keys(files)) {
        if (!file.startsWith(`${path}/`)) continue
        const parts = file.slice(path.length + 1).split('/')
        entries.set(parts[0]!, { name: parts[0]!, isDirectory: parts.length > 1 })
      }
      if (!entries.size) throw new Error(`Cannot read ${path}`)
      return [...entries.values()]
    },
    async readFile(path) {
      if (!(path in files)) throw new Error(`Cannot read ${path}`)
      return files[path]!
    }
  }
}

test('parses include directives, continuations and local macros while ignoring comments and raw strings', () => {
  assert.deepEqual(sourceIncludes([
    '// #include <Servo.h>',
    '/*', '#include "Servo.h"', '*/',
    'auto text = R"tag(', '#include <Servo.h>', ')tag";',
    '# include /* note */ <Servo.h>',
    '#include \\', '  "driver/Extra.hpp"',
    '#define LIB_HEADER <Macro.h>', '#include LIB_HEADER',
    '#undef LIB_HEADER', '#include LIB_HEADER',
    'const char* text2 = "#include <Servo.h>";'
  ].join('\n')), [
    { line: 8, header: 'Servo.h' }, { line: 9, header: 'driver/Extra.hpp' }, { line: 12, header: 'Macro.h' }
  ])
})

test('finds references across source and local libraries, excluding the removed library itself', async () => {
  const roots = [ROOT, 'sketch/libraries/Managed']
  const fs = fixture({
    [`${ROOT}/src/Servo.h`]: '#include <Servo.h>',
    [`${ROOT}/src/driver/Extra.hpp`]: '',
    'sketch/libraries/Managed/Managed.h': '#include <Servo.h>',
    'sketch/src/main.cpp': '#include <Servo.h>\n#include "driver/Extra.hpp"',
    'sketch/libraries/Wrapper/src/Wrapper.h': '#include <Managed.h>',
    'sketch/src/not-code.json': '"#include <Servo.h>"'
  })
  assert.deepEqual(await findLibraryUsage(fs, { libraryRoots: roots }), [
    { file: 'sketch/libraries/Wrapper/src/Wrapper.h', line: 1, header: 'Managed.h' },
    { file: 'sketch/src/main.cpp', line: 1, header: 'Servo.h' },
    { file: 'sketch/src/main.cpp', line: 2, header: 'driver/Extra.hpp' }
  ])
})

test('uses unsaved editor content for both added and removed references, including new buffers', async () => {
  const files = { [`${ROOT}/Servo.h`]: '', 'sketch/src/main.cpp': '#include <Servo.h>' }
  assert.deepEqual(await findLibraryUsage(fixture(files, { 'sketch/src/main.cpp': '// removed include' }), { libraryRoots: [ROOT] }), [])
  assert.deepEqual(await findLibraryUsage(fixture(files, {
    'sketch/src/main.cpp': '// removed include', 'sketch/src/new.cpp': '#include <Servo.h>'
  }), { libraryRoots: [ROOT] }), [{ file: 'sketch/src/new.cpp', line: 1, header: 'Servo.h' }])
})

test('ignores names in comments and respects project-local header replacements', async () => {
  const fs = fixture({
    [`${ROOT}/Servo.h`]: '',
    'sketch/src/main.cpp': '// Servo library\n/* #include <Servo.h> */\n#include <Servo.h>',
    'sketch/libraries/Servo/src/Servo.h': '// local replacement',
    'sketch/libraries/Servo/src/Servo.cpp': '#include "Servo.h"'
  })
  assert.deepEqual(await findLibraryUsage(fs, { libraryRoots: [ROOT] }), [])
})

test('checks old managed ZIP libraries and rejects incomplete checks instead of treating them as unused', async () => {
  const fs = fixture({ 'sketch/libraries/Legacy/Legacy.h': '', 'sketch/src/main.ino': '#include <Legacy.h>' })
  assert.equal((await findLibraryUsage(fs, { folderName: 'Legacy' })).length, 1)
  await assert.rejects(findLibraryUsage(fs, { libraryRoots: ['node_modules/missing/src'] }), /Cannot read/u)
  await assert.rejects(findLibraryUsage(fs, {}), /Cannot locate/u)
  await assert.rejects(findLibraryUsage({ ...fs, readFile: async () => { throw new Error('Permission denied') } }, { folderName: 'Legacy' }), /Permission denied/u)
})


test('scans nested project test/example sources and ignores continued line comments', async () => {
  assert.deepEqual(sourceIncludes('// ignore next line \\\n#include <Servo.h>'), [])
  const fs = fixture({ [`${ROOT}/Servo.h`]: '', 'sketch/src/examples/example.cpp': '#include <Servo.h>' })
  assert.equal((await findLibraryUsage(fs, { libraryRoots: [ROOT] }))[0]?.file, 'sketch/src/examples/example.cpp')
})
