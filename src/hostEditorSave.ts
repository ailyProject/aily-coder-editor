/** Join an iframe command's save before starting the host's save-all. */
export function createHostEditorSaver<T>(
  pendingSaves: () => readonly Promise<void>[],
  saveAll: () => Promise<T>,
): () => Promise<T> {
  let inFlight: Promise<T> | undefined
  return () => {
    if (!inFlight) {
      inFlight = (async () => {
        // A newer save can be queued while the previous version is being saved.
        for (let pending = pendingSaves(); pending.length; pending = pendingSaves()) {
          await Promise.all(pending)
        }
        return saveAll()
      })().finally(() => { inFlight = undefined })
    }
    return inFlight
  }
}
