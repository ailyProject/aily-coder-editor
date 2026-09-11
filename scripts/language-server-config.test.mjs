import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { splitCompilerArguments, clangdCompatibleArguments, resolveCoderLanguageConfig, buildConfigurationCurrent } from '../server/languageServerConfig.js'

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
