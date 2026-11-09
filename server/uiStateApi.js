import { Buffer } from 'node:buffer'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { URL } from 'node:url'
import { defaultAilyAppDataPath } from './componentLibraryService.js'

/** Workbench storage follows the iframe origin, whose runtime port changes on every launch. */
const API_PATH = '/api/ui-state'
const MAX_BODY_BYTES = 16 * 1024
const MIN_LIBRARY_PANEL_WIDTH = 350

function normalizeState(value) {
  const width = Number(value?.componentLibraryPanelWidth)
  return Number.isFinite(width)
    ? { componentLibraryPanelWidth: Math.max(MIN_LIBRARY_PANEL_WIDTH, Math.round(width)) }
    : {}
}

export function uiStateFilePath(appDataPath = defaultAilyAppDataPath()) {
  return path.join(appDataPath, 'aily-coder', 'ui-state.json')
}

export async function readUiState(filePath = uiStateFilePath()) {
  try {
    return normalizeState(JSON.parse(await readFile(filePath, 'utf8')))
  } catch {
    return {}
  }
}

export async function updateUiState(patch, filePath = uiStateFilePath()) {
  const next = { ...(await readUiState(filePath)), ...normalizeState(patch) }
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  return next
}

async function readJsonBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('Request body is too large')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
}

function sendJson(response, status, payload) {
  response.writeHead(status, { 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(payload))
}

export async function handleUiStateApiRequest(request, response, filePath = uiStateFilePath()) {
  if (new URL(request.url || '/', 'http://127.0.0.1').pathname !== API_PATH) return false
  try {
    if (request.method === 'GET') {
      sendJson(response, 200, { ok: true, state: await readUiState(filePath) })
    } else if (request.method === 'POST') {
      if (!String(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
        throw new Error('Content-Type must be application/json')
      }
      sendJson(response, 200, { ok: true, state: await updateUiState(await readJsonBody(request), filePath) })
    } else {
      response.writeHead(405, { Allow: 'GET, POST' })
      response.end()
    }
  } catch (error) {
    sendJson(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
  }
  return true
}
