import { completionRuntime } from './completion/completionRuntime'
import { isCompletionSource } from './completion/completionState'
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
  type InlineCompletionRequestPolicy
} from './aiInlineCompletionTransport'
import { isFileInlineCompletionDocument } from './aiInlineCompletionScope'
import { buildInlineCompletionContext } from './aiInlineCompletionContext'
import {
  completionDebounceMs,
  extendSelectedCompletion,
  InlineCompletionTriggerTracker,
  prepareInlineCompletion,
  shouldRequestInlineCompletion
} from './aiInlineCompletionPolicy'

const inlineCompletionDocumentSelector: vscode.DocumentSelector = [{ scheme: 'file' }]
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

export function resolveProvider(): InlineCompletionProvider {
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
  return parseBoundedInteger('VITE_AI_INLINE_HOST_DEBOUNCE_MS', 0, 0, 10_000)
}

function parseProviderDebounceDelayMs(): number {
  return parseBoundedInteger('VITE_AI_INLINE_DEBOUNCE_MS', 300, 0, 10_000)
}

function parseCloudRequestPolicy(): {
  minRequestIntervalMs: number
  rateLimitCooldownMs: number
} {
  return {
    minRequestIntervalMs: parseBoundedInteger(
      'VITE_AI_INLINE_MIN_REQUEST_INTERVAL_MS',
      500,
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

function parsePromptCharCaps(): { beforeMax: number; afterMax: number } {
  return {
    beforeMax: parseBoundedInteger('VITE_AI_INLINE_MAX_BEFORE_CHARS', 12_000, 1024, 131_072),
    afterMax: parseBoundedInteger('VITE_AI_INLINE_MAX_AFTER_CHARS', 4000, 512, 65_536)
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

function localFimPrompt(prefix: string, suffix: string): string {
  return `${DEEPSEEK_FIM_BEGIN}${prefix}${DEEPSEEK_FIM_HOLE}${suffix}${DEEPSEEK_FIM_END}`
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

function waitForDebounce(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
  }
  if (ms <= 0) {
    return Promise.resolve()
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timeout)
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
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
          createInlineCompletionSessionId(),
          parseCloudRequestPolicy()
        )
      : undefined
  const metadata = new WeakMap<vscode.InlineCompletionItem, CompletionMetadata>()
  const shown = new WeakSet<vscode.InlineCompletionItem>()
  const terminal = new WeakSet<vscode.InlineCompletionItem>()
  const triggers = new InlineCompletionTriggerTracker()
  let latestEpoch = 0
  let localAbort: AbortController | undefined

  api.workspace.onDidChangeTextDocument(event => {
    if (event.contentChanges.length === 0) return
    const suppress = event.reason != null || event.contentChanges.length > 1 ||
      event.contentChanges.some(change =>
        (change.text.length === 0 && change.rangeLength > 0) || change.text.length > 128
      )
    triggers.changed(event.document.uri.toString(), event.document.version, suppress)
  })
  api.workspace.onDidCloseTextDocument(document => triggers.close(document.uri.toString()))

  const completionProvider: vscode.InlineCompletionItemProvider = {
    async provideInlineCompletionItems(document, position, context, token) {
      if (token.isCancellationRequested || !isFileInlineCompletionDocument(document) || !isCompletionSource(document.uri.toString())) {
        return []
      }
      const v4 = await completionRuntime?.provide(document, position, context, token)
      if (v4 !== undefined) return v4
      const epoch = ++latestEpoch
      const version = document.version
      const selected = context.selectedCompletionInfo
      const completionTriggerKind = triggerKind(api, context)
      const documentKey = document.uri.toString()
      const offset = document.offsetAt(position)
      const fullText = document.getText()
      const before = fullText.slice(0, offset)
      const after = fullText.slice(offset)
      const editor = api.window.activeTextEditor
      if (
        editor == null || editor.document !== document || !editor.selection.isEmpty ||
        editor.selections.length !== 1 || !editor.selection.active.isEqual(position) ||
        !triggers.allow(documentKey, version, offset, completionTriggerKind) ||
        !shouldRequestInlineCompletion(before, after, completionTriggerKind)
      ) return []
      // The suggest widget's default item is often alphabetical, not user intent.
      // Predict against the real buffer, then enforce its replacement contract on the result.
      if (selected != null && (
        !selected.range.isSingleLine || !selected.range.contains(position) ||
        !selected.range.end.isEqual(position) || selected.text.includes('\n')
      )) return []
      const cancellation = cancellationSignal(token)

      try {
        await waitForDebounce(
          completionTriggerKind === 'invoke' ? 0 : completionDebounceMs(before, parseProviderDebounceDelayMs()),
          cancellation.signal
        )
        if (token.isCancellationRequested || epoch !== latestEpoch || document.version !== version) {
          return []
        }

        const relativePath = workspaceRelativePath(api, document)
        const folder = api.workspace.getWorkspaceFolder(document.uri)?.uri.toString()
        const { prefix, suffix, context: relatedContext } = buildInlineCompletionContext({
          active: { uri: documentKey, languageId: document.languageId, relativePath, text: fullText, offset },
          documents: folder == null ? [] : api.workspace.textDocuments
            .filter(other => other !== document && isFileInlineCompletionDocument(other) &&
              api.workspace.getWorkspaceFolder(other.uri)?.uri.toString() === folder && other.getText().length <= 300_000)
            .slice(-20)
            .reverse()
            .map(other => ({ uri: other.uri.toString(), languageId: other.languageId,
              relativePath: workspaceRelativePath(api, other), text: other.getText() })),
          ...parsePromptCharCaps()
        })
        let result: CloudCompletionResult | undefined
        let insertText: string
        if (cloudClient != null) {
          result = await cloudClient.complete(
            {
              documentKey,
              documentPrefix: before,
              opportunityId: validOpportunityId(context.requestUuid),
              triggerKind: completionTriggerKind,
              document: {
                languageId: document.languageId || 'plaintext',
                ...(relativePath != null ? { relativePath } : {}),
                version
              },
              position: { line: position.line, character: position.character },
              prefix,
              suffix,
              context: relatedContext,
              ...(selected != null ? { selectedCompletionKey: JSON.stringify([selected.range.start, selected.text]) } : {})
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
          const requestAbort = new AbortController()
          localAbort = requestAbort
          const onCancellation = () => requestAbort.abort()
          cancellation.signal.addEventListener('abort', onCancellation, { once: true })
          try {
            insertText = await fetchLmStudioFimInlineCompletion({
              prompt: localFimPrompt(prefix, suffix),
              apiBaseUrl,
              apiKey: readViteEnv('VITE_AI_INLINE_COMPLETION_KEY'),
              model: readViteEnv('VITE_AI_INLINE_COMPLETION_MODEL'),
              signal: requestAbort.signal,
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
          !insertText || api.window.activeTextEditor !== editor ||
          !editor.selection.isEmpty || !editor.selection.active.isEqual(position)
        ) {
          return []
        }
        insertText = prepareInlineCompletion({ raw: insertText, prefix, suffix, trigger: completionTriggerKind })

        const range = selected?.range ?? new api.Range(position, position)
        if (selected != null) {
          insertText = extendSelectedCompletion(insertText, fullText.slice(document.offsetAt(selected.range.start), offset), selected.text)
        }
        if (!insertText) {
          if (result != null) cloudClient?.discardCompletion(result.completionId)
          return []
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
          if (error.code !== 'CODE_COMPLETION_COOLDOWN') {
            console.debug('[ai-inline-completion]', error.code, error.status)
          }
        } else {
          console.warn('[ai-inline-completion]', error)
        }
        return []
      } finally {
        cancellation.dispose()
      }
    },

    handleDidShowCompletionItem(item) {
      if (completionRuntime?.shown(item)) return
      const value = metadata.get(item)
      if (cloudClient == null || value == null || shown.has(item)) {
        return
      }
      shown.add(item)
      cloudClient.feedback(value.completionId, value.opportunityId, 'shown')
    },

    handleDidPartiallyAcceptCompletionItem(item, info) {
      if (completionRuntime?.partial(item, typeof info === 'number' ? info : info.acceptedLength)) return
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
      if (completionRuntime?.ended(item, reason)) return
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
