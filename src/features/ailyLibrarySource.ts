export const AILY_LIBRARY_RECEIPT_FILE = '.aily-blockly-library.json'
export const ARDUINO_LIBRARY_RECEIPT_FILE = '.aily-component-library.json'
export const LOCAL_LIBRARY_PACKAGE_FILE = 'package.json'

export type LibraryTreeSource = 'aily' | 'arduino' | 'aily-chat' | 'unknown'

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
}): LibraryTreeSource {
  if (sourceFrom(input.ailyReceipt) === 'blockly-library') {
    return 'aily'
  }

  const arduinoSource = sourceFrom(input.arduinoReceipt)
  if (
    arduinoSource === 'arduino-library-manager' ||
    arduinoSource === 'arduino-platform' ||
    arduinoSource === 'platform'
  ) {
    return 'arduino'
  }

  if (sourceFrom(input.packageJson) === 'aily-chat') {
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
