import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, open, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'
import { defaultAilyAppDataPath } from './componentLibraryService.js'
import { CLANGD_RELEASES, ESP_CLANGD_VERSION } from './clangdReleases.js'

const run = promisify(execFile)
const installations = new Map()
const executableName = platform => platform === 'win32' ? 'clangd.exe' : 'clangd'

async function executableWorks(command, runCommand, env) {
  try {
    const { stdout } = await runCommand(command, ['--version'], { env, timeout: 5000, maxBuffer: 8192, windowsHide: true })
    return /clangd version/i.test(stdout)
  } catch { return false }
}

async function downloadArchive(release, archive, fetchImpl) {
  // Espressif's official mirror is reachable without a GitHub connection.
  const urls = [release.url.replace('https://github.com/', 'https://dl.espressif.com/github_assets/'), release.url]
  let lastError
  for (const url of urls) {
    let file
    try {
      const response = await fetchImpl(url, { signal: globalThis.AbortSignal.timeout(90_000) })
      if (!response.ok || !response.body) {
        await response.body?.cancel()
        throw new Error(`clangd download failed (${response.status})`)
      }
      file = await open(archive, 'w')
      const hash = createHash('sha256'); let size = 0
      for await (const chunk of response.body) {
        size += chunk.length
        if (size > release.size) throw new Error('clangd archive exceeds its expected size')
        hash.update(chunk)
        await file.writeFile(chunk)
      }
      if (size !== release.size || hash.digest('hex') !== release.sha256) throw new Error('clangd archive checksum mismatch')
      return
    } catch (error) { lastError = error }
    finally { await file?.close() }
  }
  throw lastError
}

/** Install only a pinned, verified tool into app data; never require global LLVM. */
export async function installManagedClangd({ appDataPath, platform = process.platform, arch = process.arch,
  env = process.env, fetchImpl = globalThis.fetch, runCommand = run, release = CLANGD_RELEASES[`${platform}-${arch}`] }) {
  if (!release) throw new Error(`No managed clangd release for ${platform}/${arch}`)
  const toolsRoot = path.resolve(appDataPath, 'tools')
  const target = path.join(toolsRoot, `esp-clangd@${ESP_CLANGD_VERSION}`)
  const command = path.join(target, 'bin', executableName(platform))
  if (installations.has(target)) return installations.get(target)
  const pending = (async () => {
    if (await executableWorks(command, runCommand, env)) return command
    await mkdir(toolsRoot, { recursive: true })
    const staging = await mkdtemp(path.join(toolsRoot, '.clangd-install-'))
    try {
      const archive = path.join(staging, 'clangd.tar.xz')
      await downloadArchive(release, archive, fetchImpl)
      const extracted = path.join(staging, 'extracted')
      await mkdir(extracted)
      // Windows 10/11 ships bsdtar with xz support. Use the system executable,
      // including on a fresh machine whose PATH contains no developer tools.
      const tar = platform === 'win32' ? path.join(env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : '/usr/bin/tar'
      await runCommand(tar, ['-xf', archive, '-C', extracted], { env, timeout: 60_000, maxBuffer: 8192, windowsHide: true })
      const source = path.join(extracted, 'esp-clangd')
      const stagedCommand = path.join(source, 'bin', executableName(platform))
      if (!await executableWorks(stagedCommand, runCommand, env)) throw new Error('Downloaded clangd could not start')
      try { await rename(source, target) }
      catch (error) {
        // A second runtime may have finished the same installation meanwhile.
        if (!await executableWorks(command, runCommand, env)) throw error
      }
      return command
    } finally { await rm(staging, { recursive: true, force: true }) }
  })()
  installations.set(target, pending)
  try { return await pending }
  finally { if (installations.get(target) === pending) installations.delete(target) }
}

export async function resolveCoderLanguageCommand(options = {}) {
  const env = options.env || process.env
  if (options.command || env.AILY_CLANGD_PATH) return options.command || env.AILY_CLANGD_PATH
  const appDataPath = options.appDataPath || defaultAilyAppDataPath()
  const platform = options.platform || process.platform
  const managed = path.join(appDataPath, 'tools', `esp-clangd@${ESP_CLANGD_VERSION}`, 'bin', executableName(platform))
  const runCommand = options.runCommand || run
  if (await stat(managed).then(value => value.isFile(), () => false) && await executableWorks(managed, runCommand, env)) return managed
  const system = executableName(platform)
  if (await executableWorks(system, runCommand, env)) return system
  // Lack of a project/build database must never prevent tool provisioning.
  return installManagedClangd({ ...options, appDataPath, platform, env, runCommand })
}
