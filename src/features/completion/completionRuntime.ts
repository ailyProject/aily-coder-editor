import type * as vscode from 'vscode'
export interface CompletionRuntime {
  provide(document: vscode.TextDocument, position: vscode.Position, context: vscode.InlineCompletionContext, token: vscode.CancellationToken): Promise<vscode.InlineCompletionList | [] | undefined>
  shown(item: vscode.InlineCompletionItem): boolean
  partial(item: vscode.InlineCompletionItem, accepted: number): boolean
  ended(item: vscode.InlineCompletionItem, reason: vscode.InlineCompletionEndOfLifeReason): boolean
}
export let completionRuntime: CompletionRuntime | undefined
export function setCompletionRuntime(runtime: CompletionRuntime): void { completionRuntime = runtime }
