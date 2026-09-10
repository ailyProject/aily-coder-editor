/** Library-operation feedback projected by the embedded Coder into the main app. */
export const HOST_LIBRARY_OPERATION_FEEDBACK_CHANNEL = 'aily-coder-editor-library-operation-feedback'

export type HostLibraryOperationFeedbackState = 'loading' | 'success' | 'error'

export type HostLibraryOperationFeedbackAction = 'install' | 'uninstall'

export type HostLibraryOperationFeedback = {
  readonly state: HostLibraryOperationFeedbackState
  readonly action: HostLibraryOperationFeedbackAction
  readonly libraryName: string
  readonly command: string
  readonly error?: string
}

type HostMessageTarget = {
  postMessage(message: unknown, targetOrigin: string): void
}

type HostWindow = HostMessageTarget & {
  readonly parent?: HostMessageTarget | null
}

function bounded(value: unknown, maximum: number): string {
  return String(value ?? '').trim().slice(0, maximum)
}

/**
 * Sends one semantic operation update to the Angular host. The return value is
 * false for standalone/browser-preview Coder so callers can keep a local
 * notification fallback without duplicating messages in the embedded app.
 */
export function reportHostLibraryOperationFeedback(
  feedback: HostLibraryOperationFeedback,
  host: HostWindow | undefined = typeof window === 'undefined' ? undefined : window,
): boolean {
  const parent = host?.parent
  if (host == null || parent == null || parent === host) return false

  const libraryName = bounded(feedback.libraryName, 240)
  const command = bounded(feedback.command, 16_000)
  const error = bounded(feedback.error, 2_000)
  if (!libraryName || !command || (feedback.state === 'error' && !error)) return false

  try {
    parent.postMessage({
      channel: HOST_LIBRARY_OPERATION_FEEDBACK_CHANNEL,
      state: feedback.state,
      action: feedback.action,
      libraryName,
      command,
      ...(error ? { error } : {}),
    }, '*')
    return true
  } catch {
    return false
  }
}
