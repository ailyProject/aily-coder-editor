import path from 'node:path'
import {
  installArduinoComponentLibrary,
  removeArduinoComponentLibrary,
  searchArduinoComponentLibraries,
} from './componentLibraryService.js'

const METHODS = new Set([
  'coder.library.arduino.search',
  'coder.library.arduino.install',
  'coder.library.arduino.remove',
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

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed)) return fallback
  return Math.min(maximum, Math.max(minimum, parsed))
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

function searchParams(params) {
  return {
    query: nonEmptyText(params.query).slice(0, 256),
    category: nonEmptyText(params.category).slice(0, 128),
    type: nonEmptyText(params.type).slice(0, 128),
    offset: boundedInteger(params.offset, 0, 0, Number.MAX_SAFE_INTEGER),
    limit: boundedInteger(params.limit, 25, 1, 50),
    forceRefresh: params.forceRefresh === true,
  }
}

function mutationParams(params) {
  return {
    libraryId: requiredText(params, 'libraryId', 128),
    version: requiredText(params, 'version', 64),
  }
}

function classifyError(error) {
  if (error instanceof CoderAgentRpcError) return error
  const message = error instanceof Error ? error.message : String(error)
  const declaredCode = nonEmptyText(error?.code)
  if (declaredCode) return new CoderAgentRpcError(declaredCode, message, error?.details)

  const rules = [
    [/Workspace root .*does not exist|not an Aily Coder project/iu, 'CODER_PROJECT_REQUIRED'],
    [/version was not found/iu, 'ARDUINO_LIBRARY_NOT_FOUND'],
    [/not compatible with the active Coder architecture/iu, 'ARDUINO_LIBRARY_INCOMPATIBLE'],
    [/already exists/iu, 'COMPONENT_PATH_CONFLICT'],
    [/no Coder Arduino installation metadata/iu, 'COMPONENT_PROVENANCE_REQUIRED'],
    [/invalid Arduino library provenance metadata|conflicting Arduino library provenance metadata/iu, 'COMPONENT_PROVENANCE_CONFLICT'],
  ]
  const matched = rules.find(([pattern]) => pattern.test(message))
  return new CoderAgentRpcError(matched?.[1] ?? 'CODER_COMPONENT_LIBRARY_FAILED', message)
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
  const search = operations.search ?? searchArduinoComponentLibraries
  const install = operations.install ?? installArduinoComponentLibrary
  const remove = operations.remove ?? removeArduinoComponentLibrary

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
        if (method === 'coder.library.arduino.search') {
          const result = await search({ workspaceRoot, ...searchParams(params), signal })
          signal?.throwIfAborted()
          return {
            ok: true,
            ...result,
            libraries: Array.isArray(result?.libraries) ? result.libraries.map(publicLibrary) : [],
          }
        }
        if (method === 'coder.library.arduino.install') {
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
