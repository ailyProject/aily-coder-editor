#!/usr/bin/env node

import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const packageRoot = path.dirname(fileURLToPath(import.meta.url))
const developmentEntry = path.join(packageRoot, 'server', 'runtimeEntry.js')
const productionEntry = path.join(packageRoot, 'runtime', 'index.js')
const entryPath = existsSync(developmentEntry)
  ? developmentEntry
  : productionEntry

if (!existsSync(entryPath)) {
  throw new Error(`Aily Coder Runtime has not been built: ${entryPath}`)
}

await import(pathToFileURL(entryPath).href)
