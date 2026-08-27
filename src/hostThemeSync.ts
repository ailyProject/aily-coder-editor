import type { CoderEmbedThemeScheme } from './setup.common.js'

export type HostThemeApplier = (theme: CoderEmbedThemeScheme) => Promise<void>

/**
 * Applies only the latest requested host theme and serializes async Workbench theme changes.
 * A failed apply is not marked successful, so a later host-context snapshot can retry it.
 */
export function createHostThemeSynchronizer(
  apply: HostThemeApplier,
  onError: (error: unknown, theme: CoderEmbedThemeScheme) => void = () => undefined
): { sync(theme: CoderEmbedThemeScheme): Promise<void> } {
  let applied: CoderEmbedThemeScheme | null = null
  let pending: CoderEmbedThemeScheme | null = null
  let running: Promise<void> | null = null

  const flush = async (): Promise<void> => {
    while (pending != null) {
      const requested = pending
      pending = null
      if (requested === applied) continue
      try {
        await apply(requested)
        applied = requested
      } catch (error) {
        onError(error, requested)
      }
    }
  }

  const sync = (theme: CoderEmbedThemeScheme): Promise<void> => {
    pending = theme
    if (running == null) {
      running = flush().finally(() => {
        running = null
        // A request can arrive between the loop ending and the finalizer running.
        const missed = pending
        if (missed != null) void sync(missed)
      })
    }
    return running
  }

  return { sync }
}
