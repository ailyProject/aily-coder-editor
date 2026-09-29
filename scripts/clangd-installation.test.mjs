import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { installManagedClangd, resolveCoderLanguageCommand } from '../server/clangdInstallation.js'
import { resolveCoderLanguageConfig } from '../server/languageServerConfig.js'
import { CLANGD_RELEASES, ESP_CLANGD_VERSION } from '../server/clangdReleases.js'

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'aily clangd-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const archive = Buffer.from('verified test archive')
  const calls = []; const requests = []
  const options = {
    appDataPath: path.join(root, 'new computer'), platform: 'win32', arch: 'x64',
    env: { PATH: '', SystemRoot: 'C:\\Windows' },
    release: { url: 'https://github.com/espressif/llvm-project/releases/download/test/clangd.tar.xz',
      sha256: createHash('sha256').update(archive).digest('hex'), size: archive.length },
    fetchImpl: async url => { requests.push(url); return new Response(archive) },
    runCommand: async (command, args, config) => {
      calls.push({ command, args, config })
      assert.equal(config.env.PATH, '')
      assert.equal(config.windowsHide, true)
      if (args[0] === '-xf') {
        assert.deepEqual(await readFile(args[1]), archive)
        const bin = path.join(args[3], 'esp-clangd', 'bin')
        await mkdir(bin, { recursive: true })
        await writeFile(path.join(bin, 'clangd.exe'), 'binary')
        await writeFile(path.join(bin, 'libwinpthread-1.dll'), 'runtime dependency')
        return { stdout: '' }
      }
      if (path.isAbsolute(command) && await stat(command).catch(() => null)) return { stdout: 'clangd version 21.1.3' }
      throw Object.assign(new Error('not installed'), { code: 'ENOENT' })
    },
  }
  return { root, options, calls, requests }
}

test('fresh Windows install coalesces requests, keeps runtime DLLs and reuses the offline tool', async t => {
  const { options, calls, requests } = await fixture(t)
  const commands = await Promise.all([resolveCoderLanguageCommand(options), resolveCoderLanguageCommand(options)])
  assert.equal(commands[0], commands[1])
  assert.equal(path.basename(commands[0]), 'clangd.exe')
  assert.equal(requests.length, 1)
  assert.match(requests[0], /^https:\/\/dl\.espressif\.com\/github_assets\//)
  const extraction = calls.filter(call => call.args[0] === '-xf')
  assert.equal(extraction.length, 1)
  assert.equal(extraction[0].command, path.join('C:\\Windows', 'System32', 'tar.exe'))
  assert.equal(await readFile(path.join(path.dirname(commands[0]), 'libwinpthread-1.dll'), 'utf8'), 'runtime dependency')
  assert.equal(await resolveCoderLanguageCommand({ ...options, fetchImpl: () => { throw Error('offline') } }), commands[0])
  assert.deepEqual(await readdir(path.join(options.appDataPath, 'tools')), [`esp-clangd@${ESP_CLANGD_VERSION}`])
})

test('missing build and explicit compile database both select the installed tool without PATH', async t => {
  const { root, options } = await fixture(t)
  const missing = await resolveCoderLanguageConfig(root, options)
  assert.ok(path.isAbsolute(missing.command)); assert.equal(missing.database, undefined)
  await writeFile(path.join(root, 'compile_commands.json'), '[]')
  const explicit = await resolveCoderLanguageConfig(root, options)
  assert.equal(explicit.command, missing.command); assert.equal(explicit.database, root)
})

test('configured commands and working system installations do not trigger downloads', async t => {
  const { options, requests } = await fixture(t)
  assert.equal(await resolveCoderLanguageCommand({ ...options, command: 'D:\\SDK path\\clangd.exe' }), 'D:\\SDK path\\clangd.exe')
  assert.equal(await resolveCoderLanguageCommand({ ...options, env: { AILY_CLANGD_PATH: 'custom-clangd' } }), 'custom-clangd')
  assert.equal(await resolveCoderLanguageCommand({ ...options, runCommand: async () => ({ stdout: 'clangd version 21' }) }), 'clangd.exe')
  assert.equal(requests.length, 0)
})

test('corrupted download is never extracted or published and a later retry succeeds', async t => {
  const { options, calls } = await fixture(t)
  await assert.rejects(installManagedClangd({ ...options, fetchImpl: async () => new Response('corrupted') }), /checksum/)
  assert.equal(calls.some(call => call.args[0] === '-xf'), false)
  assert.deepEqual(await readdir(path.join(options.appDataPath, 'tools')), [])
  assert.ok(await installManagedClangd(options))
})

test('mirror failure falls back to the verified upstream archive', async t => {
  const { options } = await fixture(t)
  const urls = []
  const fetchImpl = async url => {
    urls.push(url)
    return urls.length === 1 ? new Response('', { status: 503 }) : options.fetchImpl(url)
  }
  await installManagedClangd({ ...options, fetchImpl })
  assert.equal(urls.length, 2); assert.equal(urls[1], options.release.url)
})

test('unstartable staged executable leaves no partial installation', async t => {
  const { options } = await fixture(t)
  await assert.rejects(installManagedClangd({ ...options, runCommand: async (command, args, config) => {
    if (args[0] === '--version') throw Error('DLL missing')
    return options.runCommand(command, args, config)
  } }), /could not start/)
  assert.deepEqual(await readdir(path.join(options.appDataPath, 'tools')), [])
})

test('all supported desktop targets have pinned official hashes, including Windows ARM64 emulation', () => {
  for (const platform of ['darwin', 'win32', 'linux']) for (const arch of ['x64', 'arm64']) {
    const release = CLANGD_RELEASES[`${platform}-${arch}`]
    assert.match(release.sha256, /^[a-f0-9]{64}$/)
    assert.ok(release.size > 1_000_000)
    assert.match(release.url, /^https:\/\/github\.com\/espressif\/llvm-project\/releases\/download\//)
  }
  assert.deepEqual(CLANGD_RELEASES['win32-arm64'], CLANGD_RELEASES['win32-x64'])
})
