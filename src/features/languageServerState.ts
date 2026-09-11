export type LanguageServerState = 'waiting' | 'connecting' | 'ready' | 'unavailable'
let state: LanguageServerState = 'waiting'
let compilationDatabase: boolean | undefined
const listeners = new Set<() => void>()
export const getLanguageServerState = () => state
export const hasLanguageServerCompilationDatabase = () => compilationDatabase
export function setLanguageServerState(value: LanguageServerState, hasDatabase?: boolean): void {
  if (state === value && compilationDatabase === hasDatabase) return
  compilationDatabase = hasDatabase
  state = value; for (const listener of listeners) listener()
}
export function onLanguageServerStateChanged(listener: () => void): () => void {
  listeners.add(listener); return () => listeners.delete(listener)
}
