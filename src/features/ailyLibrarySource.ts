export const AILY_LIBRARY_RECEIPT_FILE = '.aily-blockly-library.json'
export const ARDUINO_LIBRARY_RECEIPT_FILE = '.aily-component-library.json'
export const CODER_LOCAL_LIBRARY_RECEIPT_FILE = '.aily-coder-local-library.json'
export const LOCAL_LIBRARY_PACKAGE_FILE = 'package.json'

export type LibraryTreeSource = 'aily' | 'arduino' | 'aily-chat' | 'unknown'

/** Identity used to resolve the same installed entry as the library list. */
export type LibraryRemovalTarget = {
  readonly id: string
  readonly source: 'aily' | 'registry'
  readonly query: string
}

export function packageLibraryRemovalTarget(packageName: string): LibraryRemovalTarget | undefined {
  if (!/^@aily-project(?:-coder)?\/lib-[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(packageName)) return undefined
  const official = packageName.startsWith('@aily-project-coder/')
  return { id: `${official ? 'coder' : 'blockly'}:${packageName}`, source: official ? 'registry' : 'aily', query: packageName }
}

export function workspaceLibraryRemovalTarget(input: {
  readonly ailyReceipt?: string
  readonly arduinoReceipt?: string
}): LibraryRemovalTarget | undefined {
  const aily = parseJsonObject(input.ailyReceipt)
  if (aily?.source === 'blockly-library' && typeof aily.packageName === 'string') {
    return packageLibraryRemovalTarget(aily.packageName)
  }
  const receipt = parseJsonObject(input.arduinoReceipt)
  if (typeof receipt?.name !== 'string' || !receipt.name.trim() || typeof receipt.libraryId !== 'string') return undefined
  if (receipt.source === 'aily-coder-index' && /^coder:[a-f0-9]{24}$/u.test(receipt.libraryId)) {
    return { id: receipt.libraryId, source: 'aily', query: receipt.name }
  }
  if (receipt.source === 'arduino-library-manager' && /^arduino:.+$/u.test(receipt.libraryId)) {
    return { id: receipt.libraryId, source: 'registry', query: receipt.name }
  }
  return undefined
}

type JsonObject = Record<string, unknown>

function parseJsonObject(content: string | undefined): JsonObject | undefined {
  if (content == null || content.trim().length === 0) {
    return undefined
  }
  try {
    const value: unknown = JSON.parse(content)
    return value != null && typeof value === 'object' && !Array.isArray(value)
      ? value as JsonObject
      : undefined
  } catch {
    return undefined
  }
}

function sourceFrom(content: string | undefined): string | undefined {
  const source = parseJsonObject(content)?.source
  return typeof source === 'string' ? source.trim() : undefined
}

/**
 * Classify one direct child of sketch/libraries without guessing from its name
 * or Arduino-compatible source layout. Managed Aily/Arduino provenance wins over
 * the package marker so an uploaded Aily Chat library adopts its installed source.
 */
export function classifyWorkspaceLibrarySource(input: {
  readonly ailyReceipt?: string
  readonly arduinoReceipt?: string
  readonly packageJson?: string
  readonly localReceipt?: string
}): LibraryTreeSource {
  if (sourceFrom(input.ailyReceipt) === 'blockly-library') {
    const packageName = parseJsonObject(input.ailyReceipt)?.packageName
    if (typeof packageName === 'string' && packageName.startsWith('@aily-project-coder/lib-')) return 'arduino'
    return 'aily'
  }

  const arduinoSource = sourceFrom(input.arduinoReceipt)
  if (arduinoSource === 'aily-coder-index') {
    return 'aily'
  }
  if (
    arduinoSource === 'arduino-library-manager' ||
    arduinoSource === 'arduino-platform' ||
    arduinoSource === 'platform'
  ) {
    return 'arduino'
  }

  if (sourceFrom(input.localReceipt) === 'aily-chat' || sourceFrom(input.packageJson) === 'aily-chat') {
    return 'aily-chat'
  }

  return 'unknown'
}

export function iconForLibraryTreeSource(source: LibraryTreeSource): string {
  switch (source) {
    case 'aily':
      return 'sparkle'
    case 'arduino':
      return 'circuit-board'
    case 'aily-chat':
      return 'chat-sparkle'
    case 'unknown':
      return 'question'
  }
}
