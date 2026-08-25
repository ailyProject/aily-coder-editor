#!/usr/bin/env node

import { readFile, rm } from 'node:fs/promises'
import { builtinModules } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const runtimeRoot = path.join(packageRoot, 'runtime')
const outputPath = path.join(runtimeRoot, 'index.js')
const nodeBuiltins = new Set([
  ...builtinModules,
  ...builtinModules.map(moduleName => `node:${moduleName}`),
])

await rm(runtimeRoot, { recursive: true, force: true })

const result = await build({
  entryPoints: [path.join(packageRoot, 'server', 'runtimeEntry.js')],
  outfile: outputPath,
  bundle: true,
  define: {
    'process.env.WS_NO_BUFFER_UTIL': '"1"',
    'process.env.WS_NO_UTF_8_VALIDATE': '"1"',
  },
  format: 'esm',
  platform: 'node',
  target: 'node20',
  minify: true,
  legalComments: 'none',
  sourcemap: false,
  treeShaking: true,
  metafile: true,
  banner: {
    js: [
      "import { createRequire as __createRequire } from 'node:module';",
      'const require = __createRequire(import.meta.url);',
    ].join('\n'),
  },
})

const externalPackages = new Set()
for (const output of Object.values(result.metafile.outputs)) {
  for (const dependency of output.imports) {
    if (dependency.external && !nodeBuiltins.has(dependency.path)) {
      externalPackages.add(dependency.path)
    }
  }
}
if (externalPackages.size > 0) {
  throw new Error(`Aily Coder Runtime still has external dependencies: ${[...externalPackages].join(', ')}`)
}

const output = await readFile(outputPath, 'utf8')
if (output.includes(packageRoot) || output.includes('node_modules/')) {
  throw new Error('Aily Coder Runtime bundle leaks a build-machine dependency path')
}

console.log(`Built self-contained Aily Coder Runtime -> ${outputPath}`)
