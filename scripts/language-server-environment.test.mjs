import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { parseLanguageProperties, resolveInstalledLanguageCompiler } from '../server/languageServerEnvironment.js'
import { resolveCoderLanguageConfig } from '../server/languageServerConfig.js'

test('Arduino host properties and local overrides select Windows recipes without changing other hosts', () => {
  const base = 'compiler.cpp.cmd=generic-g++\ncompiler.cpp.cmd.windows=windows-g++\ncompiler.cpp.cmd.macosx=mac-g++\nrecipe.cpp.o.pattern=base\nrecipe.cpp.o.pattern.windows=windows\n'
  assert.equal(parseLanguageProperties(base, 'win32')['compiler.cpp.cmd'], 'windows-g++')
  assert.equal(parseLanguageProperties(base, 'darwin')['compiler.cpp.cmd'], 'mac-g++')
  assert.equal(parseLanguageProperties(base, 'linux')['compiler.cpp.cmd'], 'generic-g++')
  assert.equal(parseLanguageProperties(base, 'win32')['recipe.cpp.o.pattern'], 'windows')
  const merged = { ...parseLanguageProperties(base, 'win32'), ...parseLanguageProperties('compiler.cpp.cmd.windows=local-g++\n', 'win32') }
  assert.equal(merged['compiler.cpp.cmd'], 'local-g++')
})

async function fixture(t) {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'aily-windows-language-')))
  t.after(() => rm(base, { recursive: true, force: true }))
  const root = path.join(base, 'project'); const appData = path.join(base, 'app data')
  const sdk = path.join(appData, 'sdk', 'probe_1.0.0'); const compiler = path.join(appData, 'compiler', 'probe@1.0.0')
  const include = path.join(base, 'environment headers'); const secondInclude = path.join(base, 'second headers')
  for (const folder of [root, sdk, path.join(compiler, 'bin'), include, secondInclude]) await mkdir(folder, { recursive: true })
  return { base, root, appData, sdk, compiler, include, secondInclude }
}

test('Windows resolves installed .exe drivers but rejects directories and links outside installed roots', async t => {
  const f = await fixture(t); const file = path.join(f.compiler, 'bin', 'probe-g++')
  await writeFile(file + '.exe', '')
  assert.equal(await resolveInstalledLanguageCompiler(file, [f.compiler], 'win32'), file + '.exe')
  assert.equal(await resolveInstalledLanguageCompiler(file + '.exe', [f.compiler], 'win32'), file + '.exe')
  assert.equal(await resolveInstalledLanguageCompiler(file, [f.compiler], 'linux'), undefined)
  assert.equal(await resolveInstalledLanguageCompiler(f.compiler, [f.compiler], 'win32'), undefined)
  if (process.platform !== 'win32') {
    const outside = path.join(f.base, 'outside.exe'); await writeFile(outside, '')
    const link = path.join(f.compiler, 'bin', 'escape.exe'); await symlink(outside, link)
    assert.equal(await resolveInstalledLanguageCompiler(link, [f.compiler], 'win32'), undefined)
  }
})

test('first-open Windows database keeps real .exe drivers, response paths and host-specific board flags', async t => {
  const f = await fixture(t)
  await writeFile(path.join(f.root, 'package.json'), JSON.stringify({ boardDependencies: { '@aily-project/sdk-probe': '1.0.0', '@aily-project/compiler-probe': '1.0.0' } }))
  for (const name of ['probe-g++', 'probe-gcc']) await writeFile(path.join(f.compiler, 'bin', name + '.exe'), '')
  await writeFile(path.join(f.sdk, 'platform.txt'), 'compiler.path={runtime.tools.probe.path}/bin/\ncompiler.cpp.cmd=wrong-g++\ncompiler.cpp.cmd.windows=probe-g++\ncompiler.c.cmd=probe-gcc\nrecipe.cpp.o.pattern="{compiler.path}{compiler.cpp.cmd}" -DWRONG_HOST {includes} "{source_file}"\nrecipe.cpp.o.pattern.windows="{compiler.path}{compiler.cpp.cmd}" "@{runtime.platform.path}/cpp flags.rsp" -DWINDOWS_HOST {includes} "{source_file}"\n')
  await writeFile(path.join(f.sdk, 'cpp flags.rsp'), String.raw`-IC:\SDK\headers -DRESPONSE_FLAG=1`)
  const file = path.join(f.root, 'main.cpp'); await writeFile(file, 'int main() {}\n')
  const config = await resolveCoderLanguageConfig(f.root, { command: 'test-clangd', platform: 'win32', appDataPath: f.appData, env: { PATH: '', CPATH: `${f.include};${f.secondInclude}` } })
  const rows = JSON.parse(await readFile(path.join(config.database, 'compile_commands.json'), 'utf8'))
  const args = rows.find(row => row.file === file).arguments
  assert.equal(args[0], path.join(f.compiler, 'bin', 'probe-g++.exe'))
  assert.ok(args.includes('-DWINDOWS_HOST')); assert.ok(!args.includes('-DWRONG_HOST'))
  assert.ok(args.includes(String.raw`-IC:\SDK\headers`)); assert.ok(args.includes('-DRESPONSE_FLAG=1'))
  assert.ok(args.includes(f.include)); assert.ok(args.includes(f.secondInclude))
  assert.ok(config.queryDrivers.includes(args[0]))
  assert.equal(config.compilationDatabase, false)
})
