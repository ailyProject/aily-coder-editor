import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
test('npm package contains a self-contained Node runtime without node_modules', async () => {
  const packageJson = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'))
  assert.deepEqual(packageJson.dependencies ?? {}, {})
  assert.equal(packageJson.bundledDependencies, undefined)

  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const result = spawnSync(
    npmCommand,
    ['pack', '--dry-run', '--ignore-scripts', '--json'],
    {
      cwd: packageRoot,
      encoding: 'utf8',
      shell: process.platform === 'win32',
      windowsHide: true,
    },
  )
  assert.equal(result.status, 0, result.stderr || result.stdout)

  const metadata = JSON.parse(result.stdout)[0]
  const files = new Set(metadata.files.map(file => file.path))
  assert.equal(files.has('runtime/index.js'), true)
  assert.deepEqual(metadata.bundled, [])
  assert.equal([...files].some(file => file.startsWith('node_modules/')), false)
  assert.equal([...files].some(file => file.startsWith('server/') && file.endsWith('.js')), false)
})
