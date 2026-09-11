import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, realpath, stat, mkdir, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import process from 'node:process'
import { defaultAilyAppDataPath } from './componentLibraryService.js'

const run = promisify(execFile)
const exists = async file => { try { return (await stat(file)).isFile() } catch { return false } }
const inside = (root, file) => { const relative = path.relative(root, file); return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)) }
const COMPILATION_RULES = ['cpp_compile', 'c_compile', 'core_cpp_compile', 'core_c_compile']
const ESP_CLANGD_VERSION = '21.1.3_20260408'

/** Parse compiler arguments, never execute a shell command from build.ninja. */
export function splitCompilerArguments(value) {
  const result = []; let token = ''; let quote = ''; let started = false
  for (let index = 0; index < value.length; index++) {
    const char = value[index]
    if (char === '\\' && quote !== "'" && index + 1 < value.length && (quote !== '"' || ['"', '\\', '$', '`'].includes(value[index + 1]))) {
      token += value[++index]; started = true
    } else if (quote) { if (char === quote) quote = ''; else token += char }
    else if (char === '"' || char === "'") { quote = char; started = true }
    else if (/\s/.test(char)) { if (started) { result.push(token); token = ''; started = false } }
    else { token += char; started = true }
  }
  if (quote) throw new Error('Incomplete compiler arguments')
  if (started) result.push(token)
  return result
}

export function clangdCompatibleArguments(args) {
  // GCC code-generation options unsupported by Espressif's clang parser. All
  // defines, include directories and language flags remain the real build ones.
  return args.filter(arg => !/^(?:-mlongcalls|-mdisable-hardware-atomics|-mfix-esp32-psram-cache-issue|-mfix-esp32-psram-cache-strategy=.*|-fstrict-volatile-bitfields|-fno-tree-switch-conversion)$/.test(arg))
}

export function buildConfigurationCurrent(packageTime, ninjaTime, lastBuildTime, sameConfiguration = false) {
  // A successful build itself updates package.json (buildInfo/codeHash) after
  // writing Ninja. That metadata write must not invalidate its own configuration.
  return sameConfiguration || packageTime <= ninjaTime ||
    (Number.isFinite(lastBuildTime) && lastBuildTime >= ninjaTime && Math.abs(packageTime - lastBuildTime) < 1500)
}

async function boundedRead(file, roots, maximum = 1024 * 1024) {
  const canonical = await realpath(file)
  if (!roots.some(root => inside(root, canonical)) || (await stat(canonical)).size > maximum) throw new Error('Compiler input is outside installed/project roots or too large')
  return readFile(canonical, 'utf8')
}

/** Derive a language-service database from the builder's real, read-only Ninja
 * compilation records. It never changes the build database or build flags. */
export async function resolveCoderLanguageConfig(root, options = {}) {
  const fallback = { command: options.command || process.env.AILY_CLANGD_PATH || 'clangd', database: undefined, queryDrivers: [] }
  for (const directory of [path.join(root, '.build'), path.join(root, 'build'), root]) {
    if (await exists(path.join(directory, 'compile_commands.json'))) return { ...fallback, database: directory }
  }
  try {
    const appData = await realpath(options.appDataPath || defaultAilyAppDataPath())
    const toolsRoot = await realpath(path.join(appData, 'tools'))
    const build = await realpath(path.join(root, '.build'))
    if (!inside(root, build)) return fallback
    const packageFile = path.join(root, 'package.json')
    const packageTime = await stat(packageFile).then(value => value.mtimeMs, () => 0)
    const project = JSON.parse(await readFile(packageFile, 'utf8').catch(() => '{}'))
    const ninjaTime = (await stat(path.join(build, 'build.ninja'))).mtimeMs
    const signature = JSON.stringify([project.board, project.boardDependencies, project.dependencies,
      project.framework, project.devmode, project.boardConfig, project.boardOptions, project.compilerOptions, project.buildOptions])
    const stampFile = path.join(build, '.aily-clangd', 'configuration.json')
    const stamp = JSON.parse(await readFile(stampFile, 'utf8').catch(() => '{}'))
    if (!buildConfigurationCurrent(packageTime, ninjaTime, Date.parse(project.buildInfo?.lastBuildTime), stamp.signature === signature && stamp.ninjaTime === ninjaTime)) return fallback
    const ninjaText = await boundedRead(path.join(build, 'build.ninja'), [root])
    const variable = name => new RegExp(`^${name} = (.*)$`, 'm').exec(ninjaText)?.[1]?.trim().replace(/\$([ $:])/g, '$1')
    if (!/^(?:xtensa|riscv32)-.*-g\+\+(?:\.exe)?$/.test(variable('cpp_compiler') || '')) return fallback
    const compilerDirectory = await realpath(variable('compiler_path') || '')
    if (!inside(toolsRoot, compilerDirectory)) return fallback
    const managed = path.join(toolsRoot, `esp-clangd@${ESP_CLANGD_VERSION}`, 'bin', process.platform === 'win32' ? 'clangd.exe' : 'clangd')
    const command = options.command || process.env.AILY_CLANGD_PATH || managed
    if (!await exists(command)) return fallback
    const executable = process.platform === 'win32' ? 'ninja.exe' : 'ninja'
    const ninjas = ['lib/node_modules', 'node_modules'].map(directory => path.join(appData, 'npm-global', directory, '@aily-project/aily-builder/ninja', executable))
    const ninja = (await Promise.all(ninjas.map(async file => await exists(file) ? file : undefined))).find(Boolean)
    if (!ninja) return fallback
    const { stdout } = await run(ninja, ['-C', build, '-t', 'compdb', ...COMPILATION_RULES], { timeout: 3000, maxBuffer: 8 * 1024 * 1024, windowsHide: true })
    const rows = JSON.parse(stdout)
    if (!Array.isArray(rows) || !rows.length || rows.length > 4096) return fallback
    const roots = [root, appData]; const responseFiles = new Map(); const drivers = new Map()
    const expand = async (args, cwd, depth = 0) => {
      if (depth > 4 || args.length > 4096) throw new Error('Compiler response nesting exceeds budget')
      const result = []
      for (const arg of args) {
        if (!arg.startsWith('@')) { result.push(arg); continue }
        const file = path.resolve(cwd, arg.slice(1))
        if (!responseFiles.has(file)) responseFiles.set(file, boundedRead(file, roots))
        result.push(...await expand(splitCompilerArguments(await responseFiles.get(file)), cwd, depth + 1))
      }
      return result
    }
    for (const row of rows) {
      if (typeof row.command !== 'string' || typeof row.file !== 'string' || row.directory !== build) throw new Error('Invalid builder compilation record')
      let args = await expand(splitCompilerArguments(row.command), build)
      const name = args[0]
      if (!name || path.basename(name) !== name || !/^(?:xtensa|riscv32)-.*-g(?:\+\+|cc)(?:\.exe)?$/.test(name)) throw new Error('Unsupported compiler')
      const compiler = path.join(compilerDirectory, name)
      if (!inside(toolsRoot, await realpath(compiler)) || compiler.includes(',')) throw new Error('Compiler outside installed tools')
      if (!drivers.has(compiler)) {
        const result = await run(compiler, ['-print-file-name=include'], { timeout: 1500, maxBuffer: 8192, windowsHide: true })
        const include = await realpath(result.stdout.trim())
        if (!inside(toolsRoot, include)) throw new Error('Compiler headers outside installed tools')
        drivers.set(compiler, include)
      }
      args[0] = compiler
      args = clangdCompatibleArguments(args)
      args.splice(1, 0, '-isystem', drivers.get(compiler))
      const generated = path.resolve(build, row.file)
      const source = path.join(variable('sketch_dir_path') || '', path.basename(row.file))
      if (path.dirname(generated) === build && inside(root, source) && await exists(source)) {
        args = args.map(arg => path.resolve(build, arg) === generated ? source : arg)
        row.file = source
      }
      delete row.command; row.arguments = args
    }
    const database = path.join(build, '.aily-clangd')
    await mkdir(database, { recursive: true })
    if (!inside(root, await realpath(database))) throw new Error('Language database outside workspace')
    const file = path.join(database, 'compile_commands.json'); const content = JSON.stringify(rows)
    if (await readFile(file, 'utf8').catch(() => '') !== content) {
      const temporary = path.join(database, `compile_commands.${randomUUID()}.tmp`)
      await writeFile(temporary, content); await rename(temporary, file)
    }
    await writeFile(stampFile, JSON.stringify({ signature, ninjaTime }))
    return { command, database, queryDrivers: [...drivers.keys()] }
  } catch {
    // A missing/unfinished build or tool installation never blocks basic code
    // completion. The client reports missing compilation configuration.
    return fallback
  }
}
