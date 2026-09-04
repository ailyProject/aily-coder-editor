import path from 'node:path'
import {
  installCoderLibrary,
  removeCoderLibrary,
  searchCoderLibraries,
} from './componentLibraryService.js'

const METHODS = new Set([
  'coder.library.search',
  'coder.library.install',
  'coder.library.remove',
])

export class CoderAgentRpcError extends Error {
  constructor(code, message, details) {
    super(message)
    this.name = 'CoderAgentRpcError'
    this.code = code
    this.details = details
  }
}

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function nonEmptyText(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function requireWorkspaceContext(context) {
  if (context.developmentMode !== 'coder') {
    throw new CoderAgentRpcError(
      'CODER_MODE_REQUIRED',
      'Aily Coder library tools are available only in Coder mode',
    )
  }
  const workspaceRoot = nonEmptyText(context.workspaceRoot)
  if (!workspaceRoot || !path.isAbsolute(workspaceRoot)) {
    throw new CoderAgentRpcError(
      'CODER_PROJECT_REQUIRED',
      'The host did not provide an absolute Aily Coder workspace root',
    )
  }
  return workspaceRoot
}

function publicLibrary(library) {
  const result = { ...record(library) }
  Reflect.deleteProperty(result, 'sourcePath')
  return result
}

function requiredText(params, key, maximum) {
  const value = nonEmptyText(params[key])
  if (!value || value.length > maximum) {
    throw new CoderAgentRpcError(
      'SUBAPP_TOOL_INPUT_INVALID',
      `${key} must be a non-empty string no longer than ${maximum} characters`,
      { field: key },
    )
  }
  return value
}

function mutationParams(params) {
  return {
    libraryRef: requiredText(params, 'libraryRef', 160),
    version: nonEmptyText(params.version).slice(0, 64),
    allowIncompatible: params.allowIncompatible === true,
  }
}

function searchParams(params) {
  return {
    query: requiredText(params, 'query', 256),
    offset: boundedInteger(params.offset, 0, 0, Number.MAX_SAFE_INTEGER),
    limit: boundedInteger(params.limit, 25, 1, 50),
    forceRefresh: params.forceRefresh === true,
  }
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed)) return fallback
  return Math.min(maximum, Math.max(minimum, parsed))
}

function classifyError(error) {
  if (error instanceof CoderAgentRpcError) return error
  const message = error instanceof Error ? error.message : String(error)
  const declaredCode = nonEmptyText(error?.code)
  if (declaredCode) return new CoderAgentRpcError(declaredCode, message, error?.details)

  const rules = [
    [/Workspace root .*does not exist|not an Aily Coder project/iu, 'CODER_PROJECT_REQUIRED'],
    [/must be copied exactly from coder_library_search/iu, 'CODER_LIBRARY_REF_INVALID'],
    [/Aily Coder libraries require an exact version/iu, 'CODER_LIBRARY_VERSION_REQUIRED'],
    [/archive checksum|archive size|archive contains unsafe|Symbolic links|archive entry escapes|does not contain one library root|library metadata|library version/iu, 'CODER_LIBRARY_ARCHIVE_INVALID'],
    [/not a managed Aily Coder library/iu, 'CODER_LIBRARY_PROVENANCE_REQUIRED'],
    [/conflicting Aily Coder library provenance|Multiple sketch\/libraries entries/iu, 'CODER_LIBRARY_PROVENANCE_CONFLICT'],
    [/already exists and is not this managed Aily Coder library/iu, 'CODER_LIBRARY_PATH_CONFLICT'],
  ]
  const matched = rules.find(([pattern]) => pattern.test(message))
  return new CoderAgentRpcError(matched?.[1] ?? 'CODER_LIBRARY_FAILED', message)
}

export function serializeCoderAgentRpcError(error) {
  const normalized = classifyError(error)
  return {
    message: normalized.message,
    errorCode: normalized.code,
    ...(normalized.details !== undefined ? { details: normalized.details } : {}),
  }
}

export function createCoderAgentRpcRouter(operations = {}) {
  const search = operations.search ?? searchCoderLibraries
  const install = operations.install ?? installCoderLibrary
  const remove = operations.remove ?? removeCoderLibrary

  return {
    async execute(message, { signal } = {}) {
      const method = nonEmptyText(message?.method)
      if (!METHODS.has(method)) {
        throw new CoderAgentRpcError(
          'SUBAPP_TOOL_METHOD_NOT_FOUND',
          `Unknown Aily Coder Agent method: ${method || '(missing)'}`,
          { method },
        )
      }
      const context = record(message?.context)
      if (context.actor !== 'agent' || context.actorId !== 'subapp-agent-host') {
        throw new CoderAgentRpcError(
          'SUBAPP_AGENT_CONTEXT_REQUIRED',
          'Aily Coder Agent RPC requires the authenticated host Agent context',
        )
      }
      const workspaceRoot = requireWorkspaceContext(context)
      const params = record(message?.params)
      signal?.throwIfAborted()

      try {
        if (method === 'coder.library.search') {
          const result = await search({ workspaceRoot, ...searchParams(params), signal })
          signal?.throwIfAborted()
          return {
            ok: true,
            ...result,
            libraries: Array.isArray(result?.libraries) ? result.libraries.map(publicLibrary) : [],
          }
        }
        if (method === 'coder.library.install') {
          const library = await install({ workspaceRoot, ...mutationParams(params), signal })
          signal?.throwIfAborted()
          return { ok: true, library: publicLibrary(library) }
        }
        const library = await remove({ workspaceRoot, ...mutationParams(params), signal })
        signal?.throwIfAborted()
        return { ok: true, library: publicLibrary(library) }
      } catch (error) {
        if (signal?.aborted) {
          throw new CoderAgentRpcError('SUBAPP_RPC_CANCELLED', 'Aily Coder Agent request was cancelled')
        }
        throw classifyError(error)
      }
    },
  }
}
