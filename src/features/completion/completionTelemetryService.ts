import { SyncDescriptor } from '@codingame/monaco-vscode-api/vscode/vs/platform/instantiation/common/descriptors'
import { EditSuggestionId } from '@codingame/monaco-vscode-api/vscode/vs/editor/common/textModelEditSource'
import { IAiEditTelemetryService } from '@codingame/monaco-vscode-api/vscode/vs/workbench/contrib/editTelemetry/browser/telemetry/aiEditTelemetry/aiEditTelemetryService.service'

/** Monaco 31 needs an edit identity before it delivers native shown/accepted callbacks.
 * Aily's feedback transport owns analytics; this adapter supplies local model identities only.
 */
class CompletionTelemetryService implements IAiEditTelemetryService {
  declare readonly _serviceBrand: undefined
  createSuggestionId(): EditSuggestionId { return EditSuggestionId.newId(namespace => `${namespace}-${crypto.randomUUID()}`) }
  handleCodeAccepted(): void { /* Recorded once by the Aily provider lifetime callback. */ }
}
export const completionTelemetryService = {
  [IAiEditTelemetryService.toString()]: new SyncDescriptor(CompletionTelemetryService),
}
