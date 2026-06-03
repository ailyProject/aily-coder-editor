import type * as vscode from 'vscode'
import {
  ExtensionHostKind,
  registerExtension,
  type IExtensionManifest
} from '@codingame/monaco-vscode-api/extensions'

/** 不限定语言：所有已注册的文本模型均可获得行间补全 */
const inlineCompletionDocumentSelector: vscode.DocumentSelector = '*'

/** DeepSeek Coder base 模型原生 FIM 特殊 token（勿改为普通 ASCII 占位符） */
export const DEEPSEEK_FIM_BEGIN = '<｜fim▁begin｜>'
export const DEEPSEEK_FIM_HOLE = '<｜fim▁hole｜>'
export const DEEPSEEK_FIM_END = '<｜fim▁end｜>'

const DEFAULT_STOP_SEQUENCES = ['\n\n', '```']

/** LM Studio `/api/v1` 等原生 URL 归一化为 OpenAI 兼容 `/v1`（FIM 必须走 `/completions`） */
export function normalizeOpenAiCompatBaseUrl(apiBaseUrl: string): string {
  const trimmed = apiBaseUrl.replace(/\/$/, '')
  if (/^https?:\/\/[^/]+$/i.test(trimmed)) {
    return `${trimmed}/v1`
  }
  if (/\/api\/v\d+$/i.test(trimmed)) {
    return trimmed.replace(/\/api\/v\d+$/i, '/v1')
  }
  if (/\/api\/v\d+\//i.test(trimmed)) {
    return trimmed.replace(/\/api\/v\d+/i, '/v1')
  }
  return trimmed.replace(/\/(completions|chat\/completions|chat)$/, '')
}

/** OpenAI 兼容：`POST {apiBaseUrl}/chat/completions`（legacy chat 模式） */
export interface ModelInlineCompletionRequest {
  prompt: string
  apiBaseUrl: string
  apiKey?: string
  model?: string
  signal?: AbortSignal
}

/** FIM：`POST {apiBaseUrl}/completions` */
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

export type InlineCompletionMode = 'fim' | 'chat'

/** LM Studio 原生 `/api/v1/chat` | OpenAI 兼容 `/v1/completions` */
export type InlineCompletionApiKind = 'lmstudio-v1' | 'openai-compat'

function readViteEnv(key: string): string | undefined {
  return (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.[key]
}

function parseInlineMode(): InlineCompletionMode {
  const raw = readViteEnv('VITE_AI_INLINE_MODE')?.trim().toLowerCase()
  return raw === 'chat' ? 'chat' : 'fim'
}

/** 根据 URL 或 `VITE_AI_INLINE_API` 选择 LM Studio v1 或 OpenAI 兼容端点 */
export function resolveInlineCompletionApiKind(apiBaseUrl: string): InlineCompletionApiKind {
  const raw = readViteEnv('VITE_AI_INLINE_API')?.trim().toLowerCase()
  if (raw === 'lmstudio-v1' || raw === 'v1' || raw === 'native') {
    return 'lmstudio-v1'
  }
  if (raw === 'openai-compat' || raw === 'openai') {
    return 'openai-compat'
  }
  const normalized = apiBaseUrl.replace(/\/$/, '').toLowerCase()
  if (normalized.endsWith('/api/v1') || normalized.includes('/api/v1/')) {
    return 'lmstudio-v1'
  }
  return 'openai-compat'
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
  mode: InlineCompletionMode
} {
  const params = typeof location !== 'undefined' ? new URLSearchParams(location.search) : null
  const modeParam = params?.get('aiInlineMode')?.trim().toLowerCase()
  return {
    apiBaseUrl:
      params?.get('aiInlineUrl') ??
      readViteEnv('VITE_AI_INLINE_COMPLETION_URL') ??
      readViteEnv('VITE_OPENAI_BASE_URL'),
    apiKey: readViteEnv('VITE_AI_INLINE_COMPLETION_KEY') ?? readViteEnv('VITE_OPENAI_API_KEY'),
    model: readViteEnv('VITE_AI_INLINE_COMPLETION_MODEL') ?? undefined,
    mode: modeParam === 'chat' ? 'chat' : modeParam === 'fim' ? 'fim' : parseInlineMode()
  }
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

function parseChatCompletionContent(json: unknown): string {
  if (typeof json !== 'object' || json === null) {
    return ''
  }
  const o = json as {
    choices?: Array<{ message?: { content?: unknown } }>
  }
  const raw = o.choices?.[0]?.message?.content
  return typeof raw === 'string' ? raw.trimEnd() : ''
}

function parseCompletionText(json: unknown): string {
  if (typeof json !== 'object' || json === null) {
    return ''
  }
  const o = json as { choices?: Array<{ text?: unknown }> }
  const raw = o.choices?.[0]?.text
  return typeof raw === 'string' ? raw : ''
}

/** LM Studio 原生 v1：`POST /api/v1/chat` → `output[].content` */
function parseLmStudioV1ChatOutput(json: unknown): string {
  if (typeof json !== 'object' || json === null) {
    return ''
  }
  const output = (json as { output?: Array<{ type?: unknown; content?: unknown }> }).output
  if (!Array.isArray(output)) {
    return ''
  }
  const parts: string[] = []
  for (const item of output) {
    if (item?.type === 'message' && typeof item.content === 'string') {
      parts.push(item.content)
    }
  }
  return parts.join('')
}

/** 去掉模型偶发的 markdown / 多余空行，与 stop 序列形成双保险 */
export function sanitizeInlineCompletionOutput(raw: string): string {
  let t = raw.trimStart()
  if (t.startsWith('```')) {
    t = t.replace(/^```[\w-]*\n?/, '')
    const fenceEnd = t.indexOf('\n```')
    if (fenceEnd !== -1) {
      t = t.slice(0, fenceEnd)
    } else {
      t = t.replace(/```[\s\S]*$/, '')
    }
  }
  const doubleNl = t.indexOf('\n\n')
  if (doubleNl !== -1) {
    t = t.slice(0, doubleNl)
  }
  return t.trimEnd()
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

/**
 * LM Studio 原生 REST API v1：`POST /api/v1/chat`。
 * FIM / chat 均将完整 prompt 放入 `input`（v1 无独立 /completions）。
 */
async function fetchLmStudioV1InlineCompletion(req: FimInlineCompletionRequest): Promise<string> {
  const base = req.apiBaseUrl.replace(/\/$/, '')
  const url = `${base}/chat`
  const model = req.model ?? 'deepseek-coder-1.3b-base'
  const defaults = parseInferenceParams()

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(req.apiKey != null && req.apiKey.length > 0
        ? { Authorization: `Bearer ${req.apiKey}` }
        : {})
    },
    body: JSON.stringify({
      model,
      input: req.prompt,
      max_output_tokens: req.maxTokens ?? defaults.maxTokens,
      temperature: req.temperature ?? defaults.temperature,
      top_p: req.topP ?? defaults.topP,
      stream: false,
      store: false
    }),
    signal: req.signal
  })

  if (!res.ok) {
    const t = await res.text()
    throw new Error(`inline completion (lmstudio-v1): HTTP ${res.status} ${t.slice(0, 400)}`)
  }

  const json: unknown = await res.json()
  return sanitizeInlineCompletionOutput(parseLmStudioV1ChatOutput(json))
}

/**
 * OpenAI 兼容 FIM：`POST /v1/completions`（LM Studio 旧端点）。
 */
async function fetchOpenAiCompatFimInlineCompletion(req: FimInlineCompletionRequest): Promise<string> {
  const base = req.apiBaseUrl.replace(/\/$/, '')
  const url = `${base}/completions`
  const model = req.model ?? 'deepseek-coder-1.3b-base'
  const defaults = parseInferenceParams()

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(req.apiKey != null && req.apiKey.length > 0
        ? { Authorization: `Bearer ${req.apiKey}` }
        : {})
    },
    body: JSON.stringify({
      model,
      prompt: req.prompt,
      max_tokens: req.maxTokens ?? defaults.maxTokens,
      temperature: req.temperature ?? defaults.temperature,
      top_p: req.topP ?? defaults.topP,
      stop: req.stop ?? defaults.stop,
      stream: false
    }),
    signal: req.signal
  })

  if (!res.ok) {
    const t = await res.text()
    throw new Error(`inline completion (fim): HTTP ${res.status} ${t.slice(0, 400)}`)
  }

  const json: unknown = await res.json()
  return sanitizeInlineCompletionOutput(parseCompletionText(json))
}

/**
 * FIM 模式：始终走 OpenAI 兼容 `POST /v1/completions`。
 * LM Studio `/api/v1/chat` 会把 FIM prompt 当对话输入，base 模型会输出 markdown / 无关片段。
 */
export async function fetchFimInlineCompletion(req: FimInlineCompletionRequest): Promise<string> {
  const fimMarkers = resolveFimMarkers()
  const compatBase = normalizeOpenAiCompatBaseUrl(req.apiBaseUrl)
  const defaults = parseInferenceParams()
  const stop = [
    ...new Set([
      ...(req.stop ?? defaults.stop),
      fimMarkers.begin,
      fimMarkers.hole,
      fimMarkers.end
    ])
  ]
  return fetchOpenAiCompatFimInlineCompletion({
    ...req,
    apiBaseUrl: compatBase,
    stop
  })
}

/**
 * Chat 模式（legacy）：LM Studio v1 走 `/api/v1/chat`，否则 OpenAI `/v1/chat/completions`。
 */
export async function fetchModelInlineCompletion(req: ModelInlineCompletionRequest): Promise<string> {
  if (resolveInlineCompletionApiKind(req.apiBaseUrl) === 'lmstudio-v1') {
    return fetchLmStudioV1InlineCompletion(req)
  }

  const base = req.apiBaseUrl.replace(/\/$/, '')
  const url = `${base}/chat/completions`
  const model = req.model ?? 'gpt-4o-mini'
  const defaults = parseInferenceParams()

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(req.apiKey != null && req.apiKey.length > 0
        ? { Authorization: `Bearer ${req.apiKey}` }
        : {})
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: req.prompt }],
      temperature: defaults.temperature,
      max_tokens: defaults.maxTokens,
      stop: defaults.stop
    }),
    signal: req.signal
  })

  if (!res.ok) {
    const t = await res.text()
    throw new Error(`inline completion (chat): HTTP ${res.status} ${t.slice(0, 400)}`)
  }

  const json: unknown = await res.json()
  return sanitizeInlineCompletionOutput(parseChatCompletionContent(json))
}

/** legacy chat prompt（`VITE_AI_INLINE_MODE=chat`） */
function buildChatPrompt(document: vscode.TextDocument, position: vscode.Position): string {
  const { prefix, suffix } = splitPrefixSuffix(document, position)
  const langHint =
    document.languageId && document.languageId.length > 0
      ? `You complete ${document.languageId} code at the cursor. `
      : 'You complete code at the cursor. '
  return [
    langHint +
      'Output ONLY the raw code to insert at the cursor — no markdown fences, no explanation.',
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
          const { apiBaseUrl, apiKey, model, mode } = resolveInlineCompletionConfig()
          const { prefix, suffix } = splitPrefixSuffix(document, position)
          const visibleSymbols = await collectVisibleSymbols(api.commands, document)

          let prompt: string
          if (mode === 'fim') {
            prompt = buildFimPrompt({
              prefix,
              suffix,
              filePath: document.uri.fsPath || document.fileName,
              languageId: document.languageId,
              visibleSymbols,
              ...fimMarkers
            })
          } else {
            prompt = buildChatPrompt(document, position)
          }

          if (selected != null) {
            prompt = augmentPromptWhenSuggestSelected(prompt, selected)
          }

          inlineLatestFetchAbort?.abort()
          const myFetchAbort = new AbortController()
          inlineLatestFetchAbort = myFetchAbort
          const fetchSignal = myFetchAbort.signal

          let insertText: string
          const useApi = apiBaseUrl != null && apiBaseUrl.length > 0
          if (useApi) {
            if (mode === 'fim') {
              insertText = await fetchFimInlineCompletion({
                prompt,
                apiBaseUrl,
                apiKey,
                model,
                signal: fetchSignal,
                ...inference
              })
            } else {
              insertText = await fetchModelInlineCompletion({
                prompt,
                apiBaseUrl,
                apiKey,
                model,
                signal: fetchSignal
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
