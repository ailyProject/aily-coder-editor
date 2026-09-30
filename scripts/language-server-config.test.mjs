import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { splitCompilerArguments, clangdCompatibleArguments, resolveCoderLanguageConfig, resolveInoCompileCommand, buildConfigurationCurrent } from '../server/languageServerConfig.js'

test('compiler argument parsing preserves quoted paths and macro quotes without shell evaluation', () => {
  assert.deepEqual(splitCompilerArguments('g++ "-I/path with space" "-DBOARD=\\\"ESP32\\\"" "@/flags with space"'),
    ['g++', '-I/path with space', '-DBOARD="ESP32"', '@/flags with space'])
  assert.deepEqual(splitCompilerArguments('g++ "-IC:\\SDK path\\include" "$(not-executed)"'), ['g++', '-IC:\\SDK path\\include', '$(not-executed)'])
  assert.throws(() => splitCompilerArguments('g++ "unfinished'))
})

test('clangd adaptation removes only known unsupported GCC flags', () => {
  assert.deepEqual(clangdCompatibleArguments(['g++', '-mlongcalls', '-fstrict-volatile-bitfields', '-mfix-esp32-psram-cache-strategy=memw', '-std=gnu++17', '-DARDUINO_ARCH_ESP32', '-I/sdk', '-fno-rtti']),
    ['g++', '-std=gnu++17', '-DARDUINO_ARCH_ESP32', '-I/sdk', '-fno-rtti'])
})

test('build metadata writes retain diagnostics, later compilation changes require a new build', () => {
  assert.equal(buildConfigurationCurrent(30_001, 1_000, 30_000), true)
  assert.equal(buildConfigurationCurrent(90_000, 1_000, 30_000), false)
  assert.equal(buildConfigurationCurrent(90_000, 1_000, 30_000, true), true)
  assert.equal(buildConfigurationCurrent(1_000, 2_000, NaN), true)
})

test('missing build configuration degrades, explicit compilation database remains authoritative', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'aily-language-config-'))
  try {
    const missing = await resolveCoderLanguageConfig(root, { command: 'configured-clangd' })
    assert.equal(missing.command, 'configured-clangd'); assert.equal(missing.database, undefined)
    await writeFile(path.join(root, 'compile_commands.json'), '[]')
    assert.equal((await resolveCoderLanguageConfig(root, { command: 'configured-clangd' })).database, root)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('sketch parsing uses C++ only for ino and preserves compile_flags.txt', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'aily-ino-config-'))
  const file = path.join(root, 'Blink.INO')
  try {
    assert.equal(await resolveInoCompileCommand(path.join(root, 'main.c'), root), undefined)
    assert.equal(await resolveInoCompileCommand(path.join(root, '..', 'outside.ino'), root), undefined)
    assert.deepEqual((await resolveInoCompileCommand(file, root)).compilationCommand, ['clang', '-x', 'c++', file])
    await writeFile(path.join(root, 'compile_flags.txt'), '-std=gnu++17\n-I./sdk headers\n-DBOARD=1\n')
    assert.deepEqual((await resolveInoCompileCommand(file, root)).compilationCommand,
      ['clang', '-std=gnu++17', '-I./sdk headers', '-DBOARD=1', '-x', 'c++', file])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('sketch commands reuse exact, generated and sibling C++ build flags without rewriting the database', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'aily-ino-database-'))
  const file = path.join(root, 'Blink.ino'); const database = path.join(root, '.build')
  await mkdir(database)
  const dbFile = path.join(database, 'compile_commands.json')
  try {
    for (const input of [file, path.join(database, 'Blink.ino.cpp'), path.join(database, 'Blink.cpp'), path.join(root, 'helper.cpp')]) {
      const rows = [{ directory: root, file: 'other.c', arguments: ['cc', '-DC_ONLY', 'other.c'] },
        { directory: root, file: input, arguments: ['board-g++', '@board-flags', '-I/sdk headers', '-DBOARD=1', '-c', input, '-o', 'sketch.o'] }]
      const original = JSON.stringify(rows)
      await writeFile(dbFile, original)
      const command = await resolveInoCompileCommand(file, root, database)
      assert.deepEqual(command, { workingDirectory: root, compilationCommand:
        ['board-g++', '@board-flags', '-I/sdk headers', '-DBOARD=1', '-c', '-o', 'sketch.o', '-x', 'c++', file] })
      assert.equal(await readFile(dbFile, 'utf8'), original)
    }
    await writeFile(dbFile, JSON.stringify([{ directory: root, file: 'Blink.ino', command: 'clang++ -DKEEP -- Blink.ino' }]))
    assert.deepEqual((await resolveInoCompileCommand(file, root, database)).compilationCommand,
      ['clang++', '-DKEEP', '-x', 'c++', '--', file])
  } finally { await rm(root, { recursive: true, force: true }) }
})
