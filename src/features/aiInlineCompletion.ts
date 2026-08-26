import type * as vscode from 'vscode'
import {
  ExtensionHostKind,
  registerExtension,
  type IExtensionManifest
} from '@codingame/monaco-vscode-api/extensions'
import {
  DEEPSEEK_FIM_BEGIN,
  DEEPSEEK_FIM_END,
  DEEPSEEK_FIM_HOLE,
  fetchLmStudioFimInlineCompletion,
  fetchZhipuChatInlineCompletion,
  normalizeLmStudioFimBaseUrl,
  resolveInlineCompletionProvider,
  sanitizeInlineCompletionOutput,
  type InlineCompletionProvider,
  type InlineCompletionProviderSetting,
  type InlineCompletionRequestPolicy
} from './aiInlineCompletionTransport'

export { DEEPSEEK_FIM_BEGIN, DEEPSEEK_FIM_END, DEEPSEEK_FIM_HOLE }
export { sanitizeInlineCompletionOutput }
export { normalizeLmStudioFimBaseUrl as normalizeOpenAiCompatBaseUrl }

/** 不限定语言：所有已注册的文本模型均可获得行间补全 */
const inlineCompletionDocumentSelector: vscode.DocumentSelector = '*'

const DEFAULT_STOP_SEQUENCES = ['\n\n', '```']

/** @deprecated 请使用 `InlineCompletionProvider`。 */
export type InlineCompletionMode = 'fim' | 'chat'

/** 兼容旧的直接 FIM 调用入口。 */
export interface FimInlineCompletionRequest {
  prompt: string
  apiBaseUrl: string
  apiKey?: string
  model?: string
  signal?: AbortSignal
  maxTokens?: number
  temperature?: number
  topP?: number
  stop?: string[]
}

/** 兼容旧的 Chat 调用入口，现由智谱 Chat 适配器实现。 */
export interface ModelInlineCompletionRequest {
  prompt: string
  apiBaseUrl: string
  apiKey?: string
  model?: string
  signal?: AbortSignal
}

function readViteEnv(key: string): string | undefined {
  return (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.[key]
}

function parseProviderSetting(raw: string | null | undefined): InlineCompletionProviderSetting | undefined {
  const normalized = raw?.trim().toLowerCase()
  if (normalized === 'auto' || normalized === 'lmstudio-fim' || normalized === 'zhipu-chat') {
    return normalized
  }
  return undefined
}

function parseLegacyModeProvider(raw: string | null | undefined): InlineCompletionProvider | undefined {
  const normalized = raw?.trim().toLowerCase()
  if (normalized === 'fim') {
    return 'lmstudio-fim'
  }
  if (normalized === 'chat') {
    return 'zhipu-chat'
  }
  return undefined
}

function parseInferenceParams(): {
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

function resolveFimMarkers(): { begin: string; hole: string; end: string } {
  return {
    begin: readViteEnv('VITE_AI_INLINE_FIM_BEGIN') ?? DEEPSEEK_FIM_BEGIN,
    hole: readViteEnv('VITE_AI_INLINE_FIM_HOLE') ?? DEEPSEEK_FIM_HOLE,
    end: readViteEnv('VITE_AI_INLINE_FIM_END') ?? DEEPSEEK_FIM_END
  }
}

function resolveInlineCompletionConfig(): {
  apiBaseUrl: string | undefined
  apiKey: string | undefined
  model: string | undefined
  providerSetting: InlineCompletionProviderSetting
} {
  const params = typeof location !== 'undefined' ? new URLSearchParams(location.search) : null
  const providerSetting =
    parseProviderSetting(params?.get('aiInlineProvider')) ??
    parseProviderSetting(readViteEnv('VITE_AI_INLINE_PROVIDER')) ??
    parseLegacyModeProvider(params?.get('aiInlineMode')) ??
    parseLegacyModeProvider(readViteEnv('VITE_AI_INLINE_MODE')) ??
    'auto'
  return {
    apiBaseUrl:
      params?.get('aiInlineUrl') ??
      readViteEnv('VITE_AI_INLINE_COMPLETION_URL') ??
      readViteEnv('VITE_OPENAI_BASE_URL'),
    apiKey: readViteEnv('VITE_AI_INLINE_COMPLETION_KEY') ?? readViteEnv('VITE_OPENAI_API_KEY'),
    model: readViteEnv('VITE_AI_INLINE_COMPLETION_MODEL') ?? undefined,
    providerSetting
  }
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

function resolveRequestPolicy(provider: InlineCompletionProvider): InlineCompletionRequestPolicy {
  const isRemote = provider === 'zhipu-chat'
  return {
    timeoutMs: parseBoundedInteger('VITE_AI_INLINE_TIMEOUT_MS', isRemote ? 12_000 : 8_000, 1_000, 60_000),
    minRequestIntervalMs: parseBoundedInteger(
      'VITE_AI_INLINE_MIN_REQUEST_INTERVAL_MS',
      isRemote ? 1_500 : 250,
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

/** @deprecated provider 注册流程已直接调用 `fetchLmStudioFimInlineCompletion`。 */
export async function fetchFimInlineCompletion(request: FimInlineCompletionRequest): Promise<string> {
  const inference = parseInferenceParams()
  return fetchLmStudioFimInlineCompletion({
    ...request,
    maxTokens: request.maxTokens ?? inference.maxTokens,
    temperature: request.temperature ?? inference.temperature,
    topP: request.topP ?? inference.topP,
    stop: request.stop ?? inference.stop,
    ...resolveRequestPolicy('lmstudio-fim'),
    fimMarkers: resolveFimMarkers()
  })
}

/** @deprecated provider 注册流程已直接调用 `fetchZhipuChatInlineCompletion`。 */
export async function fetchModelInlineCompletion(
  request: ModelInlineCompletionRequest
): Promise<string> {
  const inference = parseInferenceParams()
  return fetchZhipuChatInlineCompletion({
    ...request,
    ...inference,
    ...resolveRequestPolicy('zhipu-chat')
  })
}

/** 每次 `provideInlineCompletionItems` 调用自增，用于防抖结束后丢弃过期调用 */
let inlineDebounceEpoch = 0

/** 新一轮将要发起 HTTP 前中止上一轮 in-flight fetch（防抖阶段不 abort，避免 ESC/连击误杀） */
let inlineLatestFetchAbort: AbortController | undefined

function parseHostDebounceDelayMs(): number {
  const raw = readViteEnv('VITE_AI_INLINE_HOST_DEBOUNCE_MS')
  if (raw == null || raw === '') {
    return 900
  }
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n) || n < 0) {
    return 900
  }
  return Math.min(n, 10_000)
}

function parsePromptCharCaps(): { beforeMax: number; afterMax: number } {
  const defB = 3500
  const defA = 1500
  const b = Number.parseInt(readViteEnv('VITE_AI_INLINE_MAX_BEFORE_CHARS') ?? '', 10)
  const a = Number.parseInt(readViteEnv('VITE_AI_INLINE_MAX_AFTER_CHARS') ?? '', 10)
  return {
    beforeMax: Number.isFinite(b) && b > 0 ? Math.min(b, 50_000) : defB,
    afterMax: Number.isFinite(a) && a > 0 ? Math.min(a, 50_000) : defA
  }
}

function parseDebounceMs(): number {
  const raw = readViteEnv('VITE_AI_INLINE_DEBOUNCE_MS')
  if (raw == null || raw === '') {
    return 450
  }
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n) || n < 0) {
    return 450
  }
  return Math.min(n, 10_000)
}

function sleepDebounceMs(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

export function buildFimPrompt(params: {
  prefix: string
  suffix: string
  filePath: string
  languageId: string
  visibleSymbols: string
  fimBegin?: string
  fimHole?: string
  fimEnd?: string
}): string {
  const markers = {
    begin: params.fimBegin ?? DEEPSEEK_FIM_BEGIN,
    hole: params.fimHole ?? DEEPSEEK_FIM_HOLE,
    end: params.fimEnd ?? DEEPSEEK_FIM_END
  }
  // base 模型 FIM：仅原生 token 块，勿加 chat 式 system rules（会触发 instruct 式乱续写）
  return [markers.begin, params.prefix, markers.hole, params.suffix, markers.end].join('')
}

function splitPrefixSuffix(document: vscode.TextDocument, position: vscode.Position): {
  prefix: string
  suffix: string
} {
  const full = document.getText()
  const offset = document.offsetAt(position)
  let prefix = full.slice(0, offset)
  let suffix = full.slice(offset)
  const { beforeMax, afterMax } = parsePromptCharCaps()
  if (prefix.length > beforeMax) {
    prefix = prefix.slice(-beforeMax)
  }
  if (suffix.length > afterMax) {
    suffix = suffix.slice(0, afterMax)
  }
  return { prefix, suffix }
}

async function collectVisibleSymbols(
  commands: typeof vscode.commands,
  document: vscode.TextDocument
): Promise<string> {
  try {
    const syms = await commands.executeCommand<vscode.DocumentSymbol[]>(
      'vscode.executeDocumentSymbolProvider',
      document.uri
    )
    if (!Array.isArray(syms) || syms.length === 0) {
      return '(none)'
    }
    const names: string[] = []
    const walk = (items: vscode.DocumentSymbol[], depth: number) => {
      for (const s of items) {
        if (depth < 3 && s.name.length > 0) {
          names.push(s.name)
        }
        if (s.children?.length) {
          walk(s.children, depth + 1)
        }
      }
    }
    walk(syms, 0)
    const unique = [...new Set(names)]
    return unique.length > 0 ? unique.slice(0, 48).join(', ') : '(none)'
  } catch {
    return '(none)'
  }
}

/** 智谱 Chat Completions prompt（`zhipu-chat`） */
function buildChatPrompt(
  document: vscode.TextDocument,
  position: vscode.Position,
  visibleSymbols: string
): string {
  const { prefix, suffix } = splitPrefixSuffix(document, position)
  const langHint =
    document.languageId && document.languageId.length > 0
      ? `You complete ${document.languageId} code at the cursor. `
      : 'You complete code at the cursor. '
  return [
    langHint +
      'Output ONLY the raw code to insert at the cursor — no markdown fences, no explanation.',
    `Visible symbols in this file: ${visibleSymbols}`,
    '',
    '--- text before cursor ---',
    prefix,
    '--- text after cursor ---',
    suffix
  ].join('\n')
}

function mergeInsertExtendingSelected(ai: string, selectedText: string): string {
  if (selectedText.length === 0 || ai.startsWith(selectedText)) {
    return ai
  }
  return selectedText + ai
}

function augmentPromptWhenSuggestSelected(base: string, selected: vscode.SelectedCompletionInfo): string {
  return [
    base,
    '',
    `The autocomplete list is open. Output MUST be a SINGLE replacement string that STARTS WITH this exact prefix (then continue after it):`,
    selected.text,
    'Do not repeat the prefix incorrectly; extend it with new code only if the model omits it, your output still must begin with that prefix verbatim.'
  ].join('\n')
}

async function mockInlineText(signal: AbortSignal | undefined): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, 120)
    const onAbort = () => {
      clearTimeout(t)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    if (signal?.aborted) {
      onAbort()
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
  return '[AI inline placeholder]\n'
}

const aiInlineManifest = {
  name: 'ai-inline-completion',
  publisher: 'aily',
  version: '0.0.1',
  engines: {
    vscode: '*'
  },
  enabledApiProposals: ['inlineCompletionsAdditions']
} as unknown as IExtensionManifest

const { getApi } = registerExtension(aiInlineManifest, ExtensionHostKind.LocalProcess, {
  system: true
})

void getApi().then((api) => {
  const hostDebounce = parseHostDebounceDelayMs()
  const fimMarkers = resolveFimMarkers()
  const inference = parseInferenceParams()

  api.languages.registerInlineCompletionItemProvider(
    inlineCompletionDocumentSelector,
    {
      async provideInlineCompletionItems(document, position, ctx, token) {
        if (token.isCancellationRequested) {
          return []
        }

        const selected = ctx.selectedCompletionInfo

        const myEpoch = ++inlineDebounceEpoch
        const versionAtInvoke = document.version
        const debounceMs = parseDebounceMs()

        await sleepDebounceMs(debounceMs)

        if (myEpoch !== inlineDebounceEpoch) {
          return []
        }
        if (document.version !== versionAtInvoke) {
          return []
        }

        try {
          const { apiBaseUrl, apiKey, model, providerSetting } = resolveInlineCompletionConfig()
          const useApi = apiBaseUrl != null && apiBaseUrl.length > 0
          const provider = useApi
            ? resolveInlineCompletionProvider(apiBaseUrl, providerSetting)
            : 'lmstudio-fim'
          const { prefix, suffix } = splitPrefixSuffix(document, position)
          const visibleSymbols = await collectVisibleSymbols(api.commands, document)

          let prompt: string
          if (provider === 'lmstudio-fim') {
            prompt = buildFimPrompt({
              prefix,
              suffix,
              filePath: document.uri.fsPath || document.fileName,
              languageId: document.languageId,
              visibleSymbols,
              ...fimMarkers
            })
          } else {
            prompt = buildChatPrompt(document, position, visibleSymbols)
          }

          if (selected != null && provider === 'zhipu-chat') {
            prompt = augmentPromptWhenSuggestSelected(prompt, selected)
          }

          inlineLatestFetchAbort?.abort()
          const myFetchAbort = new AbortController()
          inlineLatestFetchAbort = myFetchAbort
          const fetchSignal = myFetchAbort.signal

          let insertText: string
          if (useApi) {
            const requestPolicy = resolveRequestPolicy(provider)
            if (provider === 'lmstudio-fim') {
              insertText = await fetchLmStudioFimInlineCompletion({
                prompt,
                apiBaseUrl,
                apiKey,
                model,
                signal: fetchSignal,
                ...inference,
                ...requestPolicy,
                fimMarkers
              })
            } else {
              insertText = await fetchZhipuChatInlineCompletion({
                prompt,
                apiBaseUrl,
                apiKey,
                model,
                signal: fetchSignal,
                ...inference,
                ...requestPolicy
              })
            }
          } else {
            insertText = await mockInlineText(fetchSignal)
          }

          if (myEpoch !== inlineDebounceEpoch || document.version !== versionAtInvoke) {
            return []
          }
          if (fetchSignal.aborted) {
            return []
          }

          if (insertText.length === 0) {
            return []
          }

          if (selected != null) {
            insertText = mergeInsertExtendingSelected(insertText, selected.text)
            const item = new api.InlineCompletionItem(insertText, selected.range)
            item.filterText = insertText
            const list = new api.InlineCompletionList([item])
            list.enableForwardStability = true
            return list
          }

          const lineEndCol = Math.max(document.lineAt(position.line).range.end.character, position.character + 1)
          const replaceRange = new api.Range(position.line, position.character, position.line, lineEndCol)
          const item = new api.InlineCompletionItem(insertText, replaceRange)
          const list = new api.InlineCompletionList([item])
          list.enableForwardStability = true
          return list
        } catch (e) {
          if (e instanceof DOMException && e.name === 'AbortError') {
            return []
          }
          console.warn('[ai-inline-completion]', e)
          return []
        }
      }
    },
    {
      debounceDelayMs: hostDebounce,
      displayName: 'aily AI'
    }
  )
})
