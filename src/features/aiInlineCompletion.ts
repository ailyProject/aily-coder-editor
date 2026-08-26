import type * as vscode from 'vscode'
import {
  ExtensionHostKind,
  registerExtension,
  type IExtensionManifest
} from '@codingame/monaco-vscode-api/extensions'
import packageMetadata from '../../package.json'
import {
  CloudCompletionError,
  CloudInlineCompletionClient,
  ParentCodeCompletionTransport,
  createInlineCompletionSessionId,
  type CloudCompletionResult
} from './aiInlineCompletionCloudTransport'
import {
  DEEPSEEK_FIM_BEGIN,
  DEEPSEEK_FIM_END,
  DEEPSEEK_FIM_HOLE,
  fetchLmStudioFimInlineCompletion,
  sanitizeInlineCompletionOutput,
  type InlineCompletionRequestPolicy
} from './aiInlineCompletionTransport'

const inlineCompletionDocumentSelector: vscode.DocumentSelector = '*'
const DEFAULT_STOP_SEQUENCES = ['\n\n', '```']

type InlineCompletionProvider = 'cloud' | 'lmstudio-fim' | 'off'

function readViteEnv(key: string): string | undefined {
  return (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.[key]
}

function parseProvider(raw: string | null | undefined): InlineCompletionProvider | undefined {
  const normalized = raw?.trim().toLowerCase()
  if (normalized === 'cloud' || normalized === 'lmstudio-fim' || normalized === 'off') {
    return normalized
  }
  return undefined
}

function resolveProvider(): InlineCompletionProvider {
  const params = typeof location !== 'undefined' ? new URLSearchParams(location.search) : null
  const configured =
    parseProvider(params?.get('aiInlineProvider')) ??
    parseProvider(readViteEnv('VITE_AI_INLINE_PROVIDER'))
  if (configured != null) {
    return configured
  }
  if (typeof window !== 'undefined' && window.parent !== window) {
    return 'cloud'
  }
  return readViteEnv('VITE_AI_INLINE_COMPLETION_URL') ? 'lmstudio-fim' : 'off'
}

function parseBoundedInteger(
  key: string,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const parsed = Number.parseInt(readViteEnv(key) ?? '', 10)
  if (!Number.isFinite(parsed)) {
    return fallback
  }
  return Math.min(maximum, Math.max(minimum, parsed))
}

function parseHostDebounceDelayMs(): number {
  return parseBoundedInteger('VITE_AI_INLINE_HOST_DEBOUNCE_MS', 250, 0, 10_000)
}

function parsePromptCharCaps(): { beforeMax: number; afterMax: number } {
  return {
    beforeMax: parseBoundedInteger('VITE_AI_INLINE_MAX_BEFORE_CHARS', 96_000, 4096, 131_072),
    afterMax: parseBoundedInteger('VITE_AI_INLINE_MAX_AFTER_CHARS', 32_000, 1024, 65_536)
  }
}

function parseLocalRequestPolicy(): InlineCompletionRequestPolicy {
  return {
    timeoutMs: parseBoundedInteger('VITE_AI_INLINE_TIMEOUT_MS', 8_000, 1_000, 60_000),
    minRequestIntervalMs: parseBoundedInteger(
      'VITE_AI_INLINE_MIN_REQUEST_INTERVAL_MS',
      250,
      0,
      10_000
    ),
    rateLimitCooldownMs: parseBoundedInteger(
      'VITE_AI_INLINE_RATE_LIMIT_COOLDOWN_MS',
      30_000,
      1_000,
      300_000
    )
  }
}

function parseLocalInference(): {
  maxTokens: number
  temperature: number
  topP: number
  stop: string[]
} {
  const maxTokens = Number.parseInt(readViteEnv('VITE_AI_INLINE_MAX_TOKENS') ?? '', 10)
  const temperature = Number.parseFloat(readViteEnv('VITE_AI_INLINE_TEMPERATURE') ?? '')
  const topP = Number.parseFloat(readViteEnv('VITE_AI_INLINE_TOP_P') ?? '')
  return {
    maxTokens: Number.isFinite(maxTokens) && maxTokens > 0 ? Math.min(maxTokens, 256) : 64,
    temperature: Number.isFinite(temperature) ? temperature : 0.15,
    topP: Number.isFinite(topP) ? topP : 0.9,
    stop: DEFAULT_STOP_SEQUENCES
  }
}

function splitPrefixSuffix(document: vscode.TextDocument, position: vscode.Position): {
  prefix: string
  suffix: string
} {
  const full = document.getText()
  const offset = document.offsetAt(position)
  const { beforeMax, afterMax } = parsePromptCharCaps()
  return {
    prefix: full.slice(Math.max(0, offset - beforeMax), offset),
    suffix: full.slice(offset, offset + afterMax)
  }
}

function localFimPrompt(prefix: string, suffix: string): string {
  return `${DEEPSEEK_FIM_BEGIN}${prefix}${DEEPSEEK_FIM_HOLE}${suffix}${DEEPSEEK_FIM_END}`
}

function mergeInsertExtendingSelected(text: string, selectedText: string): string {
  return selectedText.length === 0 || text.startsWith(selectedText) ? text : selectedText + text
}

function workspaceRelativePath(api: typeof vscode, document: vscode.TextDocument): string | undefined {
  const value = api.workspace.asRelativePath(document.uri, false).replace(/\\/g, '/')
  if (!value || value.startsWith('/') || /^[A-Za-z]:\//.test(value) || value.split('/').includes('..')) {
    return undefined
  }
  return value
}

function triggerKind(api: typeof vscode, context: vscode.InlineCompletionContext): 'automatic' | 'invoke' {
  return context.triggerKind === api.InlineCompletionTriggerKind.Invoke ? 'invoke' : 'automatic'
}

function validOpportunityId(value: string | undefined): string | undefined {
  return value != null && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value
    : undefined
}

function cancellationSignal(token: vscode.CancellationToken): {
  signal: AbortSignal
  dispose: () => void
} {
  const controller = new AbortController()
  if (token.isCancellationRequested) {
    controller.abort()
    return { signal: controller.signal, dispose: () => undefined }
  }
  const subscription = token.onCancellationRequested(() => controller.abort())
  return { signal: controller.signal, dispose: () => subscription.dispose() }
}

type CompletionMetadata = CloudCompletionResult & {
  insertTextLength: number
}

const aiInlineManifest = {
  name: 'ai-inline-completion',
  publisher: 'aily',
  version: packageMetadata.version,
  engines: { vscode: '*' },
  enabledApiProposals: ['inlineCompletionsAdditions']
} as unknown as IExtensionManifest

const { getApi } = registerExtension(aiInlineManifest, ExtensionHostKind.LocalProcess, {
  system: true
})

void getApi().then(api => {
  const provider = resolveProvider()
  if (provider === 'off') {
    return
  }

  const cloudClient =
    provider === 'cloud'
      ? new CloudInlineCompletionClient(
          new ParentCodeCompletionTransport(),
          packageMetadata.version,
          createInlineCompletionSessionId()
        )
      : undefined
  const metadata = new WeakMap<vscode.InlineCompletionItem, CompletionMetadata>()
  const shown = new WeakSet<vscode.InlineCompletionItem>()
  const terminal = new WeakSet<vscode.InlineCompletionItem>()
  let latestEpoch = 0
  let localAbort: AbortController | undefined

  const completionProvider: vscode.InlineCompletionItemProvider = {
    async provideInlineCompletionItems(document, position, context, token) {
      if (token.isCancellationRequested) {
        return []
      }
      const epoch = ++latestEpoch
      const version = document.version
      const { prefix, suffix } = splitPrefixSuffix(document, position)
      const selected = context.selectedCompletionInfo
      const cancellation = cancellationSignal(token)

      try {
        let result: CloudCompletionResult | undefined
        let insertText: string
        if (cloudClient != null) {
          const relativePath = workspaceRelativePath(api, document)
          result = await cloudClient.complete(
            {
              opportunityId: validOpportunityId(context.requestUuid),
              triggerKind: triggerKind(api, context),
              document: {
                languageId: document.languageId || 'plaintext',
                ...(relativePath != null ? { relativePath } : {}),
                version
              },
              position: { line: position.line, character: position.character },
              prefix,
              suffix,
              ...(selected != null ? { selectedCompletionInfo: { text: selected.text } } : {})
            },
            cancellation.signal
          )
          insertText = result.text
        } else {
          const apiBaseUrl = readViteEnv('VITE_AI_INLINE_COMPLETION_URL')
          if (!apiBaseUrl) {
            return []
          }
          localAbort?.abort()
          localAbort = new AbortController()
          const onCancellation = () => localAbort?.abort()
          cancellation.signal.addEventListener('abort', onCancellation, { once: true })
          try {
            insertText = await fetchLmStudioFimInlineCompletion({
              prompt: localFimPrompt(prefix, suffix),
              apiBaseUrl,
              apiKey: readViteEnv('VITE_AI_INLINE_COMPLETION_KEY'),
              model: readViteEnv('VITE_AI_INLINE_COMPLETION_MODEL'),
              signal: localAbort.signal,
              ...parseLocalInference(),
              ...parseLocalRequestPolicy()
            })
          } finally {
            cancellation.signal.removeEventListener('abort', onCancellation)
          }
        }

        if (
          token.isCancellationRequested ||
          epoch !== latestEpoch ||
          document.version !== version ||
          !insertText
        ) {
          return []
        }
        insertText = sanitizeInlineCompletionOutput(insertText)
        if (!insertText) {
          return []
        }

        const range = selected?.range ?? new api.Range(position, position)
        if (selected != null) {
          insertText = mergeInsertExtendingSelected(insertText, selected.text)
        }
        const item = new api.InlineCompletionItem(insertText, range)
        item.filterText = insertText
        if (result != null) {
          item.correlationId = result.completionId
          metadata.set(item, { ...result, insertTextLength: insertText.length })
        }
        const list = new api.InlineCompletionList([item])
        list.enableForwardStability = true
        return list
      } catch (error) {
        if (
          token.isCancellationRequested ||
          (error instanceof DOMException && error.name === 'AbortError')
        ) {
          return []
        }
        if (error instanceof CloudCompletionError) {
          console.debug('[ai-inline-completion]', error.code, error.status)
        } else {
          console.warn('[ai-inline-completion]', error)
        }
        return []
      } finally {
        cancellation.dispose()
      }
    },

    handleDidShowCompletionItem(item) {
      const value = metadata.get(item)
      if (cloudClient == null || value == null || shown.has(item)) {
        return
      }
      shown.add(item)
      cloudClient.feedback(value.completionId, value.opportunityId, 'shown')
    },

    handleDidPartiallyAcceptCompletionItem(item, info) {
      const value = metadata.get(item)
      if (cloudClient == null || value == null) {
        return
      }
      const acceptedLength = typeof info === 'number' ? info : info.acceptedLength
      cloudClient.feedback(
        value.completionId,
        value.opportunityId,
        'partially_accepted',
        acceptedLength
      )
    },

    handleEndOfLifetime(item, reason) {
      const value = metadata.get(item)
      if (cloudClient == null || value == null || terminal.has(item)) {
        return
      }
      if (reason.kind === api.InlineCompletionEndOfLifeReasonKind.Ignored) {
        const next = reason.supersededBy != null ? metadata.get(reason.supersededBy) : undefined
        if (next?.completionId === value.completionId) {
          return
        }
        terminal.add(item)
        cloudClient.feedback(
          value.completionId,
          value.opportunityId,
          next != null ? 'superseded' : 'ignored'
        )
        return
      }
      terminal.add(item)
      if (reason.kind === api.InlineCompletionEndOfLifeReasonKind.Accepted) {
        cloudClient.feedback(
          value.completionId,
          value.opportunityId,
          'accepted',
          value.insertTextLength
        )
      } else {
        cloudClient.feedback(value.completionId, value.opportunityId, 'rejected')
      }
    }
  }

  api.languages.registerInlineCompletionItemProvider(
    inlineCompletionDocumentSelector,
    completionProvider,
    {
      debounceDelayMs: parseHostDebounceDelayMs(),
      displayName: 'Aily AI'
    }
  )

  if (cloudClient != null && typeof window !== 'undefined') {
    window.addEventListener('beforeunload', () => cloudClient.dispose(), { once: true })
  }
})
