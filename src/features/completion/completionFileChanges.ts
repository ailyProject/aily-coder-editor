import { isCompletionSource } from './completionState'

const normalize = (path: string) => path.replace(/\\/g, '/').replace(/\/$/, '')
const TRANSIENT = /(?:^|\/)(?:\.log|logs?|\.git|\.aily|\.cache|\.history|\.build|\.pio|build|dist|target|generated)(?:\/|$)/i
const CONTEXT_CONFIG = /(?:^|\/)(?:package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|compile_commands\.json|compile_flags\.txt|coder-embed-hints\.json|platformio\.ini|library\.properties|CMakeLists\.txt)$/i

/** Host logging and build output are not edits. Captured dependencies always win. */
export function affectsCompletionContext(path: string, workspaceRoot: string | undefined, dependencyPaths: readonly string[]): boolean {
  const normalized = normalize(path)
  if (dependencyPaths.some(dependency => normalize(dependency) === normalized)) return true
  if (!workspaceRoot) return false
  const root = normalize(workspaceRoot)
  if (!normalized.startsWith(`${root}/`)) return false
  const relative = normalized.slice(root.length + 1)
  return !TRANSIENT.test(relative) && (isCompletionSource(relative) || CONTEXT_CONFIG.test(relative))
}
