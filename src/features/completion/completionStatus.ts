let status = { text: '$(sparkle) Aily Tab', detail: 'Tab 接受 · Esc 拒绝' }
const listeners = new Set<() => void>()
export function getCompletionStatus() { return status }
export function setCompletionStatus(text: string, detail: string): void {
  status = { text, detail }; for (const listener of listeners) listener()
}
export function onCompletionStatusChanged(listener: () => void): () => void {
  listeners.add(listener); return () => listeners.delete(listener)
}
