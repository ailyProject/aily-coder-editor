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
  assert.equal(files.has('agent/tools.json'), true)
  assert.equal(files.has('skill/aily-coder-library/SKILL.md'), true)
  assert.deepEqual(metadata.bundled, [])
  assert.equal([...files].some(file => file.startsWith('node_modules/')), false)
  assert.equal([...files].some(file => file.startsWith('server/') && file.endsWith('.js')), false)

  const toolManifest = JSON.parse(await readFile(path.join(packageRoot, 'agent', 'tools.json'), 'utf8'))
  const localize = toolManifest.tools.find(tool => tool.name === 'coder_library_localize')
  assert.equal(localize?.rpc?.method, 'coder.library.localize')
  assert.equal(localize?.effects?.executionDomain, 'workspace-external-mutation')
})
