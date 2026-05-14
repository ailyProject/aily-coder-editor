import type * as vscode from 'vscode'
import {
  ExtensionHostKind,
  registerExtension,
  type IExtensionManifest
} from '@codingame/monaco-vscode-api/extensions'

/** 不限定语言：所有已注册的文本模型均可获得行间补全 */
const inlineCompletionDocumentSelector: vscode.DocumentSelector = '*'

/** OpenAI 兼容：`POST {apiBaseUrl}/chat/completions` */
export interface ModelInlineCompletionRequest {
  prompt: string
  /** 例如 `https://api.openai.com/v1` */
  apiBaseUrl: string
  apiKey?: string
  model?: string
  signal?: AbortSignal
}

function readViteEnv(key: string): string | undefined {
  return (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.[key]
}


function resolveInlineCompletionConfig(): {
  apiBaseUrl: string | undefined
  apiKey: string | undefined
  model: string | undefined
} {
  const params = typeof location !== 'undefined' ? new URLSearchParams(location.search) : null
  return {
    apiBaseUrl:
      params?.get('aiInlineUrl') ??
      readViteEnv('VITE_AI_INLINE_COMPLETION_URL') ??
      readViteEnv('VITE_OPENAI_BASE_URL'),
    apiKey: readViteEnv('VITE_AI_INLINE_COMPLETION_KEY') ?? readViteEnv('VITE_OPENAI_API_KEY'),
    model: readViteEnv('VITE_AI_INLINE_COMPLETION_MODEL') ?? undefined
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

/**
 * 仅延迟，不监听 `CancellationToken`。宿主在新一次行间补全时会使上一轮 token 报错取消，
 * 若在此阶段 reject，防抖永远跑不完（日志里大量 `debounce aborted`）。
 */
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

/**
 * 调用兼容 OpenAI 的 Chat Completions 接口，解析首条 assistant 文本为插入内容（脚本/单测可复用）。
 */
export async function fetchModelInlineCompletion(req: ModelInlineCompletionRequest): Promise<string> {
  const base = req.apiBaseUrl.replace(/\/$/, '')
  const url = `${base}/chat/completions`
  const model = req.model ?? 'gpt-4o-mini'

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
      temperature: 0.2
    }),
    signal: req.signal
  })

  if (!res.ok) {
    const t = await res.text()
    throw new Error(`inline completion: HTTP ${res.status} ${t.slice(0, 400)}`)
  }

  const json: unknown = await res.json()
  return parseChatCompletionContent(json)
}

function buildPrompt(document: vscode.TextDocument, position: vscode.Position): string {
  const full = document.getText()
  const offset = document.offsetAt(position)
  let before = full.slice(0, offset)
  let after = full.slice(offset)
  const { beforeMax, afterMax } = parsePromptCharCaps()
  if (before.length > beforeMax) {
    before = before.slice(-beforeMax)
  }
  if (after.length > afterMax) {
    after = after.slice(0, afterMax)
  }
  const langHint =
    document.languageId && document.languageId.length > 0
      ? `You complete ${document.languageId} code at the cursor. `
      : 'You complete code at the cursor. '
  return [
    langHint +
      'Output ONLY the raw code to insert at the cursor — no markdown fences, no explanation.',
    '',
    '--- text before cursor ---',
    before,
    '--- text after cursor ---',
    after
  ].join('\n')
}

/**
 * {@link vscode.InlineCompletionContext.selectedCompletionInfo} 存在时：`insertText` 必须以所选补全条目 `text`
 * 为前缀，且 `range` 须与该条目一致，宿主才会渲染灰字（见 vscode.d.ts 文档示例）。
 */
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
          const { apiBaseUrl, apiKey, model } = resolveInlineCompletionConfig()
          let prompt = buildPrompt(document, position)
          if (selected != null) {
            prompt = augmentPromptWhenSuggestSelected(prompt, selected)
          }

          /** 仅在即将发网络请求时顶替上一轮：`ESC`/抖动若在防抖内只会抬升 epoch，不会误 abort 未完成 fetch */
          inlineLatestFetchAbort?.abort()
          const myFetchAbort = new AbortController()
          inlineLatestFetchAbort = myFetchAbort
          const fetchSignal = myFetchAbort.signal

          let insertText: string
          const useApi = apiBaseUrl != null && apiBaseUrl.length > 0
          if (useApi) {
            insertText = await fetchModelInlineCompletion({
              prompt,
              apiBaseUrl,
              apiKey,
              model,
              signal: fetchSignal
            })
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

          // range: cursor → line end（prompt 要求在光标处插入，range.start 不应退到词首）
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
