import fs from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

const owningRoot = path.resolve(fileURLToPath(new URL('../', import.meta.url)))
const within = (parent, child) => {
  const relative = path.relative(parent, child)
  return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

/** Emit the normal Browser workbench once, inside the caller's resource guard.
 * This does not run or claim SDK type checking, lint, Native Runtime, asset
 * assembly, authorization, or a successful browser acceptance. */
export async function buildBrowserUI({ sourceRoot, outputDirectory, cacheDirectory }) {
  for (const [name, value] of Object.entries({ sourceRoot, outputDirectory, cacheDirectory })) {
    if (typeof value !== 'string' || !path.isAbsolute(value)) throw new TypeError(`${name} must be an explicit absolute path.`)
  }
  const source = path.resolve(sourceRoot)
  const output = path.resolve(outputDirectory)
  const cache = path.resolve(cacheDirectory)
  if (source !== owningRoot || within(source, output) || within(source, cache)
    || within(output, source) || within(cache, source)
    || within(output, cache) || within(cache, output)) {
    throw new TypeError('Use this source tree and separate output/cache directories outside the source tree.')
  }
  await fs.mkdir(output, { recursive: true })
  if ((await fs.readdir(output)).length) throw new Error('The independent Browser output directory must be empty.')
  await fs.mkdir(cache, { recursive: true })
  const requireSource = createRequire(path.join(source, 'package.json'))
  const { build } = await import(pathToFileURL(requireSource.resolve('vite')).href)
  const input = path.join(source, 'browser/index.html')
  const emitted = await build({
    configFile: path.join(source, 'vite.config.ts'),
    configLoader: 'runner',
    root: path.join(source, 'browser'),
    cacheDir: cache,
    base: './',
    build: {
      outDir: output,
      emptyOutDir: false,
      sourcemap: false,
      manifest: true,
      rollupOptions: { input }
    }
  })
  // Return bounded metadata, rather than retaining generated code/maps. The
  // caller binds emitted members, source/dependency pins and bridge separately.
  const results = Array.isArray(emitted) ? emitted : [emitted]
  const members = results.flatMap(result => result.output ?? []).map(member => ({
    fileName: member.fileName,
    kind: member.type,
    bytes: Buffer.byteLength(member.type === 'chunk' ? member.code : member.source),
    ...(member.type === 'chunk' ? { entry: member.isEntry, imports: member.imports, dynamicImports: member.dynamicImports } : {})
  }))
  return { sourceRoot: source, outputDirectory: output, cacheDirectory: cache, input,
    sdkTypecheckPerformed: false, browserAccepted: false, members }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: {
    'source-root': { type: 'string' }, output: { type: 'string' }, cache: { type: 'string' }
  }, allowPositionals: false })
  const result = await buildBrowserUI({ sourceRoot: values['source-root'], outputDirectory: values.output, cacheDirectory: values.cache })
  console.log(JSON.stringify(result))
}
