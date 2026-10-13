import { Buffer } from 'node:buffer'
import { URL } from 'node:url'
import { withHostLibraryTransaction, withManualLibraryRequest } from './hostLibrarySession.js'
import {
  installCoderLibrary,
  materializeCoderProjectLibraries,
  installArduinoComponentLibrary,
  installComponentLibrary,
  removeCoderLibrary,
  removeArduinoComponentLibrary,
  scanComponentLibraries,
  searchCoderLibraries,
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
  return withManualLibraryRequest(() => handleRequest(request, response))
}

async function handleRequest(request, response) {
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
    const execute = () => handleAction(url, body)
    let result
    if (['install', 'remove'].some(action => url.pathname === `${API_PREFIX}${action}`)) {
      const prepareSources = () => materializeCoderProjectLibraries({ workspaceRoot: body.workspaceRoot })
      result = await withHostLibraryTransaction(body.workspaceRoot, async () => {
        const result = await execute()
        // npm can replace another pending package while reconciling the full
        // unsaved tree. Restore every package-local archive, not just this one.
        await prepareSources()
        return result
      }, false, prepareSources)
    } else result = await execute()
    sendJson(response, result.ok ? 200 : 404, result)
  } catch (error) {
    sendJson(response, 400, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      ...(typeof error?.code === 'string' ? { errorCode: error.code } : {}),
      ...(error?.details !== undefined ? { details: error.details } : {}),
    })
  }
  return true
}

async function handleAction(url, body) {
  if (url.pathname === `${API_PREFIX}scan`) {
    const libraries = await scanComponentLibraries({ workspaceRoot: body.workspaceRoot })
    return {
      ok: true,
      libraries: libraries.map(toClientLibrary),
    }
  }
  if (url.pathname === `${API_PREFIX}search`) {
    const search = body.source === 'aily' ? searchCoderLibraries : searchArduinoComponentLibraries
    const result = await search({
      workspaceRoot: body.workspaceRoot,
      query: body.query,
      category: body.category,
      type: body.type,
      offset: body.offset,
      limit: body.limit,
      forceRefresh: body.forceRefresh === true,
    })
    return {
      ok: true,
      ...result,
      libraries: result.libraries.map(toClientLibrary),
    }
  }
  if (url.pathname === `${API_PREFIX}install`) {
    if (body.source === 'aily') {
      const library = await installCoderLibrary({
        workspaceRoot: body.workspaceRoot,
        libraryRef: body.libraryId,
        version: body.version,
        allowIncompatible: body.allowIncompatible === true,
      })
      return {
        ok: true,
        library: toClientLibrary(library),
      }
    }
    const library = body.source === 'registry'
      ? await installArduinoComponentLibrary({
        workspaceRoot: body.workspaceRoot,
        libraryId: body.libraryId,
        version: body.version,
        allowIncompatible: body.allowIncompatible === true,
      })
      : await installComponentLibrary({
        workspaceRoot: body.workspaceRoot,
        libraryId: body.libraryId,
      })
    return {
      ok: true,
      library: toClientLibrary(library),
    }
  }
  if (url.pathname === `${API_PREFIX}remove`) {
    const library = body.source === 'aily'
      ? await removeCoderLibrary({
        workspaceRoot: body.workspaceRoot,
        libraryRef: body.libraryId,
        version: body.version,
      })
      : await removeArduinoComponentLibrary({
        workspaceRoot: body.workspaceRoot,
        libraryId: body.libraryId,
        version: body.version,
      })
    return {
      ok: true,
      library: toClientLibrary(library),
    }
  }
  return { ok: false, error: 'Unknown component library API route' }
}
