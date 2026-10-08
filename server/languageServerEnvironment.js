import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, readdir, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const run = promisify(execFile)
export const insideLanguageRoot = (root, file) => {
  const relative = path.relative(root, file)
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}
const json = file => readFile(file, 'utf8').then(JSON.parse).then(value => value && typeof value === 'object' && !Array.isArray(value) ? value : {}).catch(() => ({}))
const directory = async file => { try { return (await stat(file)).isDirectory() ? await realpath(file) : undefined } catch { return undefined } }
const properties = async file => Object.fromEntries((await readFile(file, 'utf8').catch(() => '')).split(/\r?\n/)
  .filter(line => !/^\s*[#!]/.test(line) && line.includes('='))
  .map(line => { const index = line.indexOf('='); return [line.slice(0, index).trim(), line.slice(index + 1).trim()] }))

/** Walk source trees, not caches, examples or dependency managers. Do not follow
 * directory symlinks: compilation-database files are added separately. */
export async function languageSources(roots) {
  const files = new Set(); let visited = 0
  const walk = async (folder, depth) => {
    if (depth > 24 || ++visited > 12000 || files.size >= 4096) return
    for (const entry of await readdir(folder, { withFileTypes: true }).catch(() => [])) {
      if (files.size >= 4096) break
      const file = path.join(folder, entry.name)
      if (entry.isDirectory() && !/^(?:\.|node_modules$|examples?$|tests?$|extras$|build$)/i.test(entry.name)) await walk(file, depth + 1)
      else if (entry.isFile() && /\.(?:c|cpp|cc|cxx|ino)$/i.test(entry.name)) files.add(file)
    }
  }
  for (const root of roots) await walk(root, 0)
  return [...files]
}

/** Only the selected board's installed packages contribute SDK and compiler
 * paths. Never mix all globally installed SDK versions into one translation unit. */
export async function resolveLanguageEnvironment(root, appData, env, split) {
  const project = await json(path.join(root, 'package.json'))
  const boardPattern = /^@aily-project\/(?:board|coder)-[\w.-]+$/
  const boardName = boardPattern.test(project.board || '') ? project.board
    : Object.keys({ ...project.boardDependencies, ...project.dependencies }).find(name => boardPattern.test(name))
  const boardDirectory = boardPattern.test(boardName || '') ? path.join(root, 'node_modules', boardName) : ''
  const board = await json(path.join(boardDirectory, 'package.json'))
  const boardConfig = await json(path.join(boardDirectory, 'board.json'))
  const hints = await json(path.join(root, '.aily', 'coder-embed-hints.json'))
  const dependencies = { ...board.boardDependencies, ...project.boardDependencies, ...project.dependencies }
  const sdkRoots = []; const compilerRoots = []; const toolRoots = new Map()
  for (const [name, rawVersion] of Object.entries(dependencies)) {
    const match = /^@aily-project\/(sdk|compiler|tool)-([\w.-]+)$/.exec(name)
    const version = String(rawVersion).replace(/^[~^]/, '')
    if (!match || !/^[\w.+-]+$/.test(version)) continue
    const [, kind, short] = match
    const folder = await directory(path.join(appData, kind === 'sdk' ? 'sdk' : kind === 'compiler' ? 'compiler' : 'tools', `${short}${kind === 'sdk' ? '_' : '@'}${version}`))
      || (kind === 'compiler' ? await directory(path.join(appData, 'tools', `${short}@${version}`)) : undefined)
    if (!folder || !insideLanguageRoot(appData, folder)) continue
    if (kind === 'sdk') sdkRoots.push(folder)
    if (kind === 'compiler') compilerRoots.push(folder)
    toolRoots.set(short, folder)
    if (short.startsWith('idf_')) toolRoots.set('esp32-arduino-libs', folder)
  }
  // The host has already resolved platform runtime overrides and on-disk names.
  for (const item of Array.isArray(hints.platformPackages) ? hints.platformPackages : []) {
    if (!['sdk', 'compiler', 'tool'].includes(item?.kind) || typeof item.absolutePath !== 'string') continue
    const folder = await directory(item.absolutePath)
    if (!folder || !insideLanguageRoot(appData, folder)) continue
    if (item.kind === 'sdk') {
      // Same-name host package overrides the manifest version.
      const short = String(item.packageName).replace(/^@aily-project\/sdk-/, '')
      for (let i = sdkRoots.length - 1; i >= 0; i--) if (path.basename(sdkRoots[i]).startsWith(`${short}_`)) sdkRoots.splice(i, 1)
      sdkRoots.push(folder)
    }
    if (item.kind === 'compiler') compilerRoots.push(folder)
    toolRoots.set(String(item.packageName).replace(/^@aily-project\/(?:compiler|tool)-/, ''), folder)
  }

  const includes = new Set(); const systemIncludes = new Set(); const sourceRoots = new Set(); const readableRoots = new Set([root])
  const addInclude = async folder => { const found = await directory(folder); if (found) { includes.add(found); readableRoots.add(found) } }
  const addLibrary = async folder => {
    const found = await directory(folder); if (!found) return
    readableRoots.add(found)
    const src = await directory(path.join(found, 'src'))
    sourceRoots.add(src || found); await addInclude(src || found)
    if (!src) await addInclude(path.join(found, 'utility'))
  }
  await addInclude(root)
  for (const name of ['src', 'include', 'sketch']) { await addInclude(path.join(root, name)); const folder = await directory(path.join(root, name)); if (folder) sourceRoots.add(folder) }
  for (const base of [path.join(root, 'sketch', 'libraries'), path.join(root, 'libraries')]) {
    for (const entry of await readdir(base, { withFileTypes: true }).catch(() => [])) if (entry.isDirectory()) await addLibrary(path.join(base, entry.name))
  }
  for (const name of Object.keys(dependencies).filter(name => /^@aily-project(?:-coder)?\/lib-[\w.-]+$/.test(name))) {
    const packageRoot = path.join(root, 'node_modules', name)
    const src = await directory(path.join(packageRoot, 'src'))
    if (!src) continue
    await addLibrary(packageRoot)
    // src.7z packages can contain several independent Arduino library roots.
    for (const entry of await readdir(src, { withFileTypes: true }).catch(() => [])) if (entry.isDirectory()) await addLibrary(path.join(src, entry.name))
  }
  for (const key of ['CPATH', 'CPLUS_INCLUDE_PATH', 'C_INCLUDE_PATH', 'INCLUDE']) {
    for (const value of String(env[key] || '').split(key === 'INCLUDE' ? ';' : path.delimiter).filter(Boolean)) {
      const folder = path.resolve(root, value); await addInclude(folder)
      const found = await directory(folder); if (found) sourceRoots.add(found)
    }
  }
  if (env.SDKROOT) await addInclude(path.join(env.SDKROOT, 'usr', 'include'))

  let cppFlags = []; let cFlags = []; let cppDriver = 'clang++'; let cDriver = 'clang'
  for (const sdk of new Set(sdkRoots)) {
    readableRoots.add(sdk)
    const platform = { ...await properties(path.join(sdk, 'platform.txt')), ...await properties(path.join(sdk, 'platform.local.txt')) }
    const boards = { ...await properties(path.join(sdk, 'boards.txt')), ...await properties(path.join(sdk, 'boards.local.txt')) }
    const fqbn = /(?:-b|--board)\s+([^\s]+)/.exec(boardConfig.compilerParam || '')?.[1] || boardConfig.type || ''
    const [, arch, id, menu = ''] = fqbn.split(':')
    const selected = {}
    for (const [key, value] of Object.entries(boards)) if (key.startsWith(`${id}.`) && !key.slice(id.length + 1).startsWith('menu.')) selected[key.slice(id.length + 1)] = value
    const choices = { ...Object.fromEntries(menu.split(',').filter(Boolean).map(choice => choice.split('='))), ...project.projectConfig, ...project.boardOptions, ...project.boardConfig }
    const menus = new Map()
    for (const key of Object.keys(boards)) {
      const match = new RegExp(`^${id}\\.menu\\.([^.]+)\\.([^.]+)$`).exec(key)
      if (match && !menus.has(match[1])) menus.set(match[1], match[2])
    }
    for (const [name, first] of menus) {
      const choice = choices[name] || first; const prefix = `${id}.menu.${name}.${choice}.`
      for (const [key, value] of Object.entries(boards)) if (key.startsWith(prefix)) selected[key.slice(prefix.length)] = value
    }
    const overrides = Object.fromEntries(Object.entries(project.projectConfig || {}).map(([key, value]) => [key.includes('.') ? key : `build.${key}`, value]))
    const values = { ...platform, ...selected, 'runtime.platform.path': sdk, 'runtime.ide.version': '10819', 'build.arch': arch?.toUpperCase() || path.basename(sdk).split('_')[0].toUpperCase(), ...overrides, ...project.compilerOptions }
    for (const [name, folder] of toolRoots) values[`runtime.tools.${name}.path`] = folder
    const expand = value => {
      let text = String(value || '')
      for (let pass = 0; pass < 10; pass++) { const next = text.replace(/\{([^{}]+)\}/g, (all, key) => values[key] ?? all); if (text === next) break; text = next }
      return text
    }
    for (const kind of ['core', 'variant']) {
      const name = expand(values[`build.${kind}`]).split(':').pop()
      if (name && !name.includes('{')) {
        const folder = await directory(path.join(sdk, kind === 'core' ? 'cores' : 'variants', name))
        if (folder && insideLanguageRoot(sdk, folder)) { await addInclude(folder); sourceRoots.add(folder) }
      }
    }
    for (const entry of await readdir(path.join(sdk, 'libraries'), { withFileTypes: true }).catch(() => [])) if (entry.isDirectory()) await addLibrary(path.join(sdk, 'libraries', entry.name))
    const recipeFlags = language => {
      const recipe = expand(platform[`recipe.${language}.o.pattern`] || '')
      let args
      try { args = split(recipe) } catch { return [] }
      // Output, source and {includes} belong to the managed database, not recipe.
      return args.slice(1).filter((arg, index, all) => !arg.includes('{') && !['-o', '-c', '-MMD', '-MD'].includes(arg) && all[index - 1] !== '-o')
    }
    cppFlags = recipeFlags('cpp'); cFlags = recipeFlags('c')
    const resolveDriver = async language => {
      const full = expand(`${values['compiler.path'] || ''}${values[`compiler.${language}.cmd`] || ''}`)
      const canonical = await realpath(full).catch(() => '')
      return canonical && [...compilerRoots, ...toolRoots.values()].some(folder => insideLanguageRoot(folder, canonical)) ? canonical : undefined
    }
    cppDriver = await resolveDriver('cpp') || cppDriver; cDriver = await resolveDriver('c') || cDriver
  }
  for (const folder of [...compilerRoots, ...toolRoots.values()]) readableRoots.add(folder)
  const queryDrivers = [...new Set([cppDriver, cDriver].filter(driver => path.isAbsolute(driver) && !driver.includes(',')))]
  // Compiler search paths include the C/C++ standard library and target headers.
  // Only query the resolved installed compiler, never an arbitrary project command.
  for (const driver of new Set([cppDriver, cDriver])) {
    try {
      const builtin = await run(driver, ['-print-file-name=include'], { env, timeout: 1500, maxBuffer: 8192, windowsHide: true })
      const folder = path.isAbsolute(builtin.stdout.trim()) ? await directory(builtin.stdout.trim()) : undefined
      if (folder) { systemIncludes.add(folder); readableRoots.add(folder) }
    } catch { /* Driver's default resource headers may already be available. */ }
    try {
      const { stderr } = await run(driver, ['-E', '-v', '-x', 'c++', process.platform === 'win32' ? 'NUL' : '/dev/null'], { env, timeout: 3000, maxBuffer: 128 * 1024, windowsHide: true })
      const block = /#include <\.\.\.> search starts here:([\s\S]*?)End of search list\./.exec(stderr)?.[1] || ''
      for (const line of block.split(/\r?\n/)) { const folder = await directory(line.trim().replace(/ \(framework directory\)$/, '')); if (folder) readableRoots.add(folder) }
    } catch { /* Explicit SDK/library includes remain available. */ }
  }
  const macros = project.macros || project.MACROS || project.projectConfig?.macros || []
  const macroFlags = (Array.isArray(macros) ? macros.flat() : []).filter(value => typeof value === 'string' && /^[A-Za-z_]\w*(?:=.*)?$/.test(value)).map(value => `-D${value}`)
  return { includes: [...includes], systemIncludes: [...systemIncludes], sourceRoots: [...sourceRoots], readableRoots: [...readableRoots], queryDrivers, cppDriver, cDriver, cppFlags: [...cppFlags, ...macroFlags], cFlags: [...cFlags, ...macroFlags] }
}
