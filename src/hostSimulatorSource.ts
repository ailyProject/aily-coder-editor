export const HOST_SIMULATOR_SOURCE_REQUEST = 'aily-coder-editor-simulator-source-request'
export const HOST_SIMULATOR_SOURCE_RESPONSE = 'aily-coder-editor-simulator-source-response'
export const MAX_SIMULATOR_SOURCE_BYTES = 2 * 1024 * 1024

interface RequestIdentity {
  requestId: string
  sequence: number
}

export interface SimulatorSourceShow extends RequestIdentity {
  action: 'show'
  path: string
  line: number
  sha256: string
  focus: boolean
}

type SimulatorSourceCommand = SimulatorSourceShow | (RequestIdentity & { action: 'clear' })
type SimulatorSourceRequest = SimulatorSourceCommand | { action: 'probe'; requestId: string }
type Status = 'applied' | 'ignored'

export function readSimulatorSourceHostOrigin(value: string | null): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.origin === value ? value : null
  } catch { return null }
}

export function readSimulatorSourceRequest(value: unknown): SimulatorSourceRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const { channel, v, requestId, sequence, action, path, line, sha256, focus } = value as Record<string, unknown>
  if (channel !== HOST_SIMULATOR_SOURCE_REQUEST || v !== 1
    || typeof requestId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(requestId)) return null
  const hasLocation = path !== undefined || line !== undefined || sha256 !== undefined || focus !== undefined
  if (action === 'probe') {
    return sequence === undefined && !hasLocation && /^simulator-source-probe-[1-9][0-9]*$/.test(requestId)
      ? { requestId, action } : null
  }
  if (typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || sequence < 1) return null
  if (action === 'clear') {
    return !hasLocation ? { requestId, sequence, action } : null
  }
  if (action !== 'show' || typeof path !== 'string' || path.length > 512 || /[\\:\p{Cc}]/u.test(path)
    || path.split('/').some(segment => !segment || segment.startsWith('.'))
    || !/\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx|ino|inc|s)$/i.test(path)
    || typeof line !== 'number' || !Number.isSafeInteger(line) || line < 1
    || typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256)
    || typeof focus !== 'boolean') return null
  return { requestId, sequence, action, path, line, sha256, focus }
}

export function normalizeSimulatorSourceText(text: string): string {
  return text.replace(/\r\n|\r/g, '\n')
}

interface SimulatorSourcePort {
  read(path: string): Promise<Uint8Array>
  show(request: SimulatorSourceShow, text: string, isCurrent: () => boolean): Promise<(() => void) | null>
}

export function createSimulatorSourceReceiver(port: SimulatorSourcePort) {
  let sequence = 0
  let closed = false
  let clearStop: (() => void) | undefined

  function clear() {
    clearStop?.()
    clearStop = undefined
  }

  return {
    async receive(request: SimulatorSourceCommand): Promise<Status> {
      if (closed || request.sequence <= sequence) return 'ignored'
      sequence = request.sequence
      const isCurrent = () => !closed && request.sequence === sequence
      clear()
      if (request.action === 'clear') return 'applied'
      try {
        const bytes = await port.read(request.path)
        if (!isCurrent() || bytes.byteLength > MAX_SIMULATOR_SOURCE_BYTES) return 'ignored'
        const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice()))
        if (!isCurrent() || Array.from(hash, byte => byte.toString(16).padStart(2, '0')).join('') !== request.sha256) return 'ignored'
        const text = normalizeSimulatorSourceText(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
        if (request.line > text.split('\n').length) return 'ignored'
        const dispose = await port.show(request, text, isCurrent)
        if (!dispose) return 'ignored'
        if (!isCurrent()) { dispose(); return 'ignored' }
        clearStop = dispose
        return 'applied'
      } catch { return 'ignored' }
    },
    close() {
      closed = true
      clear()
    }
  }
}
