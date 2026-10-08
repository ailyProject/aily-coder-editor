import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, realpath, stat, mkdir, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import process from 'node:process'
import os from 'node:os'
import { defaultAilyAppDataPath } from './componentLibraryService.js'
import { resolveCoderLanguageCommand } from './clangdInstallation.js'
import { resolveLanguageEnvironment, languageSources, insideLanguageRoot } from './languageServerEnvironment.js'

const run = promisify(execFile)
const exists = async file => { try { return (await stat(file)).isFile() } catch { return false } }
const inside = (root, file) => { const relative = path.relative(root, file); return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)) }
const COMPILATION_RULES = ['cpp_compile', 'c_compile', 'core_cpp_compile', 'core_c_compile']

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

/** clangd ignores didOpen.languageId when choosing compiler input language.
 * Supply an in-memory command for sketches without changing project/build files. */
export async function resolveInoCompileCommand(file, root, database) {
  if (!/\.ino$/i.test(file) || !inside(root, file)) return undefined
  const directories = []
  for (let directory = path.dirname(file); inside(root, directory); directory = path.dirname(directory)) {
    directories.push(directory)
    if (directory === root) break
  }
  const candidates = database ? [database] : directories.flatMap(directory => [directory, path.join(directory, 'build')])
  for (const directory of candidates) {
    let rows
    try { rows = JSON.parse(await readFile(path.join(directory, 'compile_commands.json'), 'utf8')) }
    catch { continue }
    if (!Array.isArray(rows)) continue
    const sourcePath = row => path.resolve(row.directory || directory, row.file)
    const valid = rows.filter(row => typeof row?.file === 'string' &&
      (Array.isArray(row.arguments) && row.arguments.every(arg => typeof arg === 'string') || typeof row.command === 'string'))
    const cppRows = valid.filter(row => /\.(?:ino|cpp|cc|cxx|c\+\+)$/i.test(row.file))
    const row = valid.find(row => sourcePath(row) === file) ||
      cppRows.find(row => path.basename(row.file) === path.basename(file) + '.cpp') ||
      cppRows.find(row => path.basename(row.file) === path.basename(file).replace(/\.ino$/i, '.cpp')) ||
      cppRows.find(row => path.dirname(sourcePath(row)) === path.dirname(file)) || cppRows[0]
    if (!row) continue
    const workingDirectory = row.directory || directory
    let args
    try { args = row.arguments || splitCompilerArguments(row.command) }
    catch { continue }
    if (!args.length) continue
    // Preserve board includes, defines, response files and the compiler driver.
    // Replace only the input file; put -x before it (and before any -- separator).
    args = args.filter((arg, index) => index === 0 || path.resolve(workingDirectory, arg) !== sourcePath(row))
    const separator = args.indexOf('--')
    args.splice(separator < 0 ? args.length : separator, 0, '-x', 'c++')
    args.push(file)
    return { workingDirectory, compilationCommand: args }
  }
  // Respect a simple project's compile_flags.txt as well as the no-build case.
  for (const directory of database ? [...new Set([database, ...directories])] : directories) {
    try {
      const flags = (await readFile(path.join(directory, 'compile_flags.txt'), 'utf8')).split(/\r?\n/).map(line => line.trim()).filter(Boolean)
      return { workingDirectory: directory, compilationCommand: ['clang', ...flags, '-x', 'c++', file] }
    } catch { /* Try the parent directory. */ }
  }
  return { workingDirectory: path.dirname(file), compilationCommand: ['clang', '-x', 'c++', file] }
}

async function boundedRead(file, roots, maximum = 1024 * 1024) {
  const canonical = await realpath(file)
  if (!roots.some(root => inside(root, canonical)) || (await stat(canonical)).size > maximum) throw new Error('Compiler input is outside installed/project roots or too large')
  return readFile(canonical, 'utf8')
}

async function expandCompilerResponses(args, cwd, roots, cache = new Map(), depth = 0) {
  if (depth > 4 || args.length > 4096) throw new Error('Compiler response nesting exceeds budget')
  const result = []
  for (const arg of args) {
    if (!arg.startsWith('@')) { result.push(arg); continue }
    const file = path.resolve(cwd, arg.slice(1))
    if (!cache.has(file)) cache.set(file, boundedRead(file, roots).then(splitCompilerArguments))
    result.push(...await expandCompilerResponses(await cache.get(file), cwd, roots, cache, depth + 1))
    if (result.length > 4096) throw new Error('Compiler response arguments exceed budget')
  }
  return result
}

/** Derive a language-service database from the builder's real, read-only Ninja
 * compilation records. It never changes the build database or build flags. */
async function resolveBuildLanguageConfig(root, options = {}) {
  const command = await resolveCoderLanguageCommand(options)
  const fallback = { command, database: undefined, queryDrivers: [] }
  const appData = await realpath(options.appDataPath || defaultAilyAppDataPath()).catch(() => path.resolve(options.appDataPath || defaultAilyAppDataPath()))
  const hints = await readFile(path.join(root, '.aily', 'coder-embed-hints.json'), 'utf8').then(JSON.parse).then(value => value || {}).catch(() => ({}))
  const builderRoot = options.builderBuildPath || path.join(os.homedir(), ...(process.platform === 'win32' ? ['AppData', 'Local'] : ['Library']), 'aily-builder', 'project')
  const allowedRoots = await Promise.all([root, appData, builderRoot].map(folder => realpath(folder).catch(() => folder)))
  const hinted = typeof hints.buildPath === 'string' && path.isAbsolute(hints.buildPath) ? await realpath(hints.buildPath).catch(() => '') : ''
  const directories = [path.join(root, '.build'), path.join(root, '.aily', 'build'), path.join(root, 'build'), root,
    ...(hinted && allowedRoots.some(folder => insideLanguageRoot(folder, hinted)) ? [hinted] : [])]
  for (const directory of directories) {
    if (await exists(path.join(directory, 'compile_commands.json'))) return { ...fallback, database: directory }
  }
  try {
    const compilerRoots = (await Promise.all(['tools', 'compiler'].map(name => realpath(path.join(appData, name)).catch(() => '')))).filter(Boolean)
    const compilerAllowed = file => compilerRoots.some(folder => insideLanguageRoot(folder, file))
    const buildCandidate = (await Promise.all(directories.map(async folder => await exists(path.join(folder, 'build.ninja')) ? folder : undefined))).find(Boolean)
    if (!buildCandidate) return fallback
    const build = await realpath(buildCandidate)
    if (!allowedRoots.some(folder => insideLanguageRoot(folder, build))) return fallback
    const packageFile = path.join(root, 'package.json')
    const packageTime = await stat(packageFile).then(value => value.mtimeMs, () => 0)
    const project = JSON.parse(await readFile(packageFile, 'utf8').catch(() => '{}'))
    const ninjaTime = (await stat(path.join(build, 'build.ninja'))).mtimeMs
    const signature = JSON.stringify([project.board, project.boardDependencies, project.dependencies,
      project.framework, project.devmode, project.boardConfig, project.boardOptions, project.projectConfig, project.macros, project.MACROS, project.compilerOptions, project.buildOptions])
    const stampFile = path.join(build, '.aily-clangd', 'configuration.json')
    const stamp = JSON.parse(await readFile(stampFile, 'utf8').catch(() => '{}'))
    if (!buildConfigurationCurrent(packageTime, ninjaTime, Date.parse(project.buildInfo?.lastBuildTime), stamp.signature === signature && stamp.ninjaTime === ninjaTime)) return fallback
    const ninjaText = await boundedRead(path.join(build, 'build.ninja'), [root, build])
    const variable = name => new RegExp(`^${name} = (.*)$`, 'm').exec(ninjaText)?.[1]?.trim().replace(/\$([ $:])/g, '$1')
    if (!/^(?:[\w.-]*g\+\+|clang\+\+)(?:\.exe)?$/.test(variable('cpp_compiler') || '')) return fallback
    const compilerDirectory = await realpath(variable('compiler_path') || '')
    if (!compilerAllowed(compilerDirectory)) return fallback
    const executable = process.platform === 'win32' ? 'ninja.exe' : 'ninja'
    const ninjas = ['lib/node_modules', 'node_modules'].map(directory => path.join(appData, 'npm-global', directory, '@aily-project/aily-builder/ninja', executable))
    const ninja = (await Promise.all(ninjas.map(async file => await exists(file) ? file : undefined))).find(Boolean)
    if (!ninja) return fallback
    const { stdout } = await run(ninja, ['-C', build, '-t', 'compdb', ...COMPILATION_RULES], { timeout: 3000, maxBuffer: 8 * 1024 * 1024, windowsHide: true })
    const rows = JSON.parse(stdout)
    if (!Array.isArray(rows) || !rows.length || rows.length > 4096) return fallback
    const roots = [root, appData, build]; const responseFiles = new Map(); const drivers = new Map()
    for (const row of rows) {
      if (typeof row.command !== 'string' || typeof row.file !== 'string' || row.directory !== build) throw new Error('Invalid builder compilation record')
      let args = await expandCompilerResponses(splitCompilerArguments(row.command), build, roots, responseFiles)
      const name = args[0]
      if (!name || path.basename(name) !== name || !/^(?:[\w.-]*g(?:\+\+|cc)|clang\+\+|clang)(?:\.exe)?$/.test(name)) throw new Error('Unsupported compiler')
      const compiler = path.join(compilerDirectory, name)
      if (!compilerAllowed(await realpath(compiler)) || compiler.includes(',')) throw new Error('Compiler outside installed tools')
      if (!drivers.has(compiler)) {
        const result = await run(compiler, ['-print-file-name=include'], { timeout: 1500, maxBuffer: 8192, windowsHide: true })
        const include = await realpath(result.stdout.trim())
        if (!compilerAllowed(include)) throw new Error('Compiler headers outside installed tools')
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
    if (!insideLanguageRoot(build, await realpath(database))) throw new Error('Language database outside build directory')
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

/** Use real build commands where available, and add index entries for installed
 * library/SDK implementations. Navigation can work before the first build while
 * diagnostics still distinguish that approximate environment from build proof. */
export async function resolveCoderLanguageConfig(root, options = {}) {
  root = await realpath(root)
  const base = await resolveBuildLanguageConfig(root, options)
  const env = options.env || process.env
  const appData = await realpath(options.appDataPath || defaultAilyAppDataPath()).catch(() => path.resolve(options.appDataPath || defaultAilyAppDataPath()))
  const environment = await resolveLanguageEnvironment(root, appData, env, splitCompilerArguments)
  const readableRoots = new Set(environment.readableRoots)
  const languageBinary = await realpath(base.command).catch(() => '')
  if (languageBinary && insideLanguageRoot(appData, languageBinary)) readableRoots.add(path.dirname(path.dirname(languageBinary)))
  const queryDrivers = new Set([...base.queryDrivers, ...environment.queryDrivers])
  let rows = []
  if (base.database) {
    try { rows = JSON.parse(await readFile(path.join(base.database, 'compile_commands.json'), 'utf8')) } catch { /* Keep navigation fallback. */ }
  }
  if (!Array.isArray(rows)) rows = []
  let flags = []
  if (!base.database) {
    for (const folder of [path.join(root, '.build'), path.join(root, 'build'), root]) {
      try { flags = (await readFile(path.join(folder, 'compile_flags.txt'), 'utf8')).split(/\r?\n/).map(line => line.trim()).filter(Boolean); break } catch { /* Try the next directory. */ }
    }
  }
  const canonicalRows = []; const known = new Set()
  const includeFlags = [...environment.includes.flatMap(folder => ['-I', folder]), ...environment.systemIncludes.flatMap(folder => ['-isystem', folder])]
  const responseRoots = [root, appData, ...readableRoots, ...(base.database ? [base.database] : [])]
  const responseArguments = new Map()
  const compatible = async (args, cwd) => {
    // Filter GCC-only flags after expanding response files as well. The owned
    // language database changes; the builder's original records stay untouched.
    try { args = await expandCompilerResponses(args, cwd, responseRoots, responseArguments) } catch { /* Preserve an unavailable response file. */ }
    return clangdCompatibleArguments(args)
  }
  for (const row of rows.slice(0, 4096)) {
    if (typeof row?.file !== 'string' || typeof row.directory !== 'string') continue
    let args
    try { args = row.arguments || splitCompilerArguments(row.command) } catch { continue }
    if (!Array.isArray(args) || !args.length || !args.every(arg => typeof arg === 'string')) continue
    const file = path.resolve(row.directory, row.file)
    args = await compatible(args, row.directory)
    const separator = args.indexOf('--')
    args.splice(separator < 0 ? args.length : separator, 0, ...includeFlags)
    canonicalRows.push({ directory: row.directory, file, arguments: args }); known.add(file)
    // Explicit SDK/library sources in the database may live outside the project.
    if (!insideLanguageRoot(root, file)) readableRoots.add(path.dirname(file))
  }
  const sources = await languageSources([root, ...environment.sourceRoots])
  const cppTemplate = canonicalRows.find(row => /\.(?:cpp|cc|cxx|ino)$/i.test(row.file))
  const cTemplate = canonicalRows.find(row => /\.c$/i.test(row.file))
  const cppFallback = await compatible([environment.cppDriver, ...(flags.length ? flags : environment.cppFlags), ...includeFlags], root)
  const cFallback = await compatible([environment.cDriver, ...(flags.length ? flags : environment.cFlags), ...includeFlags], root)
  for (const file of sources) {
    if (known.has(file) || canonicalRows.length >= 4096) continue
    const isC = /\.c$/i.test(file); const template = isC ? cTemplate : cppTemplate
    let args; let workingDirectory = root
    if (template) {
      workingDirectory = template.directory
      args = template.arguments.filter((arg, index) => index === 0 || path.resolve(workingDirectory, arg) !== template.file)
      // Output and dependency filenames are unrelated to the indexed source.
      args = args.filter((arg, index, all) => !['-o', '-MF', '-MT', '-MQ'].includes(arg) && !['-o', '-MF', '-MT', '-MQ'].includes(all[index - 1]))
    } else args = [...(isC ? cFallback : cppFallback)]
    const separator = args.indexOf('--')
    args.splice(separator < 0 ? args.length : separator, 0, '-x', isC ? 'c' : 'c++')
    args.push(file)
    canonicalRows.push({ directory: workingDirectory, file, arguments: args }); known.add(file)
  }
  // Includes from build records, compile_flags.txt and response files are valid
  // source destinations. Reading these records never executes their compiler.
  const responseCache = new Map(); const includeCache = new Map()
  const collectIncludes = async (args, cwd, depth = 0) => {
    if (depth > 4 || args.length > 4096) return
    for (let index = 0; index < args.length; index++) {
      const arg = args[index]
      if (arg.startsWith('@')) {
        const file = path.resolve(cwd, arg.slice(1))
        if (!responseCache.has(file)) responseCache.set(file, boundedRead(file, [root, appData, ...readableRoots]).then(splitCompilerArguments).catch(() => []))
        await collectIncludes(await responseCache.get(file), cwd, depth + 1)
      }
      const paired = ['-I', '-isystem', '-iquote', '-idirafter', '--sysroot', '-isysroot', '-F', '-iframework', '-include'].includes(arg)
      let value = paired ? args[++index] : /^(?:-I|-isystem|-iquote|-idirafter|-F|--sysroot=)(.+)$/.exec(arg)?.[1]
      if (value) {
        if (arg === '-include') value = path.dirname(value)
        const location = path.resolve(cwd, value)
        if (!includeCache.has(location)) includeCache.set(location, realpath(location).catch(() => ''))
        const folder = await includeCache.get(location)
        if (folder) readableRoots.add(folder)
      }
    }
  }
  for (const row of canonicalRows) await collectIncludes(row.arguments.slice(1), row.directory)
  if (!canonicalRows.length) return { ...base, compilationDatabase: Boolean(base.database), readableRoots: [...readableRoots] }
  const database = path.join(root, '.aily', 'lsp')
  await mkdir(database, { recursive: true })
  if (!insideLanguageRoot(root, await realpath(database))) throw new Error('Language database outside workspace')
  const file = path.join(database, 'compile_commands.json'); const content = JSON.stringify(canonicalRows)
  if (await readFile(file, 'utf8').catch(() => '') !== content) {
    const temporary = path.join(database, `compile_commands.${randomUUID()}.tmp`)
    await writeFile(temporary, content); await rename(temporary, file)
  }
  return { ...base, database, compilationDatabase: Boolean(base.database || flags.length), queryDrivers: [...queryDrivers], readableRoots: [...readableRoots] }
}
