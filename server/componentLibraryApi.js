import { Buffer } from 'node:buffer'
import { URL } from 'node:url'
import {
  installArduinoComponentLibrary,
  installComponentLibrary,
  scanComponentLibraries,
  searchArduinoComponentLibraries,
} from './componentLibraryService.js'

const API_PREFIX = '/api/component-libraries/'
const MAX_BODY_BYTES = 1024 * 1024

function sendJson(response, status, payload) {
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
  })
  response.end(JSON.stringify(payload))
}

async function readJsonBody(request) {
  const contentType = String(request.headers['content-type'] ?? '').toLowerCase()
  if (!contentType.startsWith('application/json')) {
    throw new Error('Content-Type must be application/json')
  }
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) {
      throw new Error('Request body is too large')
    }
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
}

/** Keep SDK paths server-side; the UI installs by opaque library id only. */
function toClientLibrary(library) {
  const clientLibrary = { ...library }
  Reflect.deleteProperty(clientLibrary, 'sourcePath')
  return clientLibrary
}

export async function handleComponentLibraryApiRequest(request, response) {
  const url = new URL(request.url || '/', 'http://127.0.0.1')
  if (!url.pathname.startsWith(API_PREFIX)) {
    return false
  }
  if (request.method !== 'POST') {
    response.writeHead(405, { Allow: 'POST' })
    response.end()
    return true
  }

  try {
    const body = await readJsonBody(request)
    if (url.pathname === `${API_PREFIX}scan`) {
      const libraries = await scanComponentLibraries({ workspaceRoot: body.workspaceRoot })
      sendJson(response, 200, {
        ok: true,
        libraries: libraries.map(toClientLibrary),
      })
      return true
    }
    if (url.pathname === `${API_PREFIX}search`) {
      const result = await searchArduinoComponentLibraries({
        workspaceRoot: body.workspaceRoot,
        query: body.query,
        category: body.category,
        type: body.type,
        offset: body.offset,
        limit: body.limit,
        forceRefresh: body.forceRefresh === true,
      })
      sendJson(response, 200, {
        ok: true,
        ...result,
        libraries: result.libraries.map(toClientLibrary),
      })
      return true
    }
    if (url.pathname === `${API_PREFIX}install`) {
      const library = body.source === 'registry'
        ? await installArduinoComponentLibrary({
          workspaceRoot: body.workspaceRoot,
          libraryId: body.libraryId,
          version: body.version,
        })
        : await installComponentLibrary({
          workspaceRoot: body.workspaceRoot,
          libraryId: body.libraryId,
        })
      sendJson(response, 200, {
        ok: true,
        library: toClientLibrary(library),
      })
      return true
    }
    sendJson(response, 404, { ok: false, error: 'Unknown component library API route' })
  } catch (error) {
    sendJson(response, 400, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    })
  }
  return true
}
