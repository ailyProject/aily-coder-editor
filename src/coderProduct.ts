/** Shared product identity for the original loader and the Browser workbench.
 * This is presentation configuration, never a project or account authority. */
export function initializeCoderProduct(): void {
  window._VSCODE_PRODUCT_JSON = {
    defaultChatAgent: {
      chatExtensionId: 'codingame.aiDemo',
      extensionId: '',
      completionsEnablementSetting: 'codingameAICompletionsEnabled',
      nextEditSuggestionsSetting: 'codingameNextEditSuggestionsEnabled',
      provider: {
        default: { id: 'codingame', name: 'Codingame' },
        apple: { id: 'codingame', name: 'Codingame' },
        enterprise: { id: 'codingame', name: 'Codingame' },
        google: { id: 'codingame', name: 'Codingame' }
      }
    }
  }
}

declare global {
  interface Window {
    _VSCODE_PRODUCT_JSON: object
  }
}
