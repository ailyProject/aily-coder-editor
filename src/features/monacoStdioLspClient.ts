import {
  CloseAction,
  ErrorAction,
  Trace
} from 'vscode-languageclient/browser'
import * as vscode from 'vscode'
import { waitServicesReady } from '@codingame/monaco-vscode-api/lifecycle'
import { MonacoLanguageClient } from 'monaco-languageclient'
import {
  WebSocketMessageReader,
  WebSocketMessageWriter,
  toSocket
} from 'vscode-ws-jsonrpc'

/**
 * 直连 stdio LSP 的 WebSocket 桥：`MonacoLanguageClient` 构造时会访问全局 `vscode` 代理，
 * 须先 `waitServicesReady()`。
 *
 * Query：
 *   `lspWs` 完整 WS URL（兼容 `clangdWs`）；否则 `ws(s)://当前 host:lspWsPort`（`lspWsPort` 默认 3030，兼容 `clangdWsPort`）。
 *   `lspLanguages` 逗号分隔的 Monaco language id，默认 C/C++/CUDA/ObjC。
 *   `lspClientId` / `lspClientName` / `lspDiagnostics`（诊断集合名）可覆写客户端元数据。
 */
const params = new URLSearchParams(window.location.search)
const lspWsParam = params.get('lspWs') ?? params.get('clangdWs')
const lspWsPortParam =
  params.get('lspWsPort') ?? params.get('clangdWsPort') ?? '3030'
const lspWs =
  lspWsParam ??
  `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.hostname}:${lspWsPortParam}`

const defaultLanguages = ['cpp', 'c', 'cuda-cpp', 'objective-cpp'] as const

function parseDocumentSelector(): { language: string }[] {
  const raw = params.get('lspLanguages')
  if (raw == null || raw.trim() === '') {
    return defaultLanguages.map((language) => ({ language }))
  }
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((language) => ({ language }))
}

function buildClientOptions() {
  const traceTitle =
    params.get('lspTraceChannel') ?? 'LSP (stdio) Trace'
  let traceChannel: vscode.OutputChannel | undefined
  try {
    traceChannel = vscode.window.createOutputChannel(traceTitle)
  } catch {
    traceChannel = undefined
  }

  const diagnosticCollectionName =
    params.get('lspDiagnostics') ?? 'lsp-stdio'

  return {
    documentSelector: parseDocumentSelector(),
    diagnosticCollectionName,
    workspaceFolder: {
      uri: vscode.Uri.file('/workspace'),
      name: 'workspace',
      index: 0
    },
    traceOutputChannel: traceChannel,
    trace: Trace.Verbose,
    errorHandler: {
      error() {
        return { action: ErrorAction.Continue }
      },
      closed() {
        return { action: CloseAction.DoNotRestart }
      }
    }
  }
}

if (lspWs != null && lspWs.length > 0) {
  void (async () => {
    await waitServicesReady()

    const ws = new WebSocket(lspWs)

    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => {
        resolve()
      }
      ws.onerror = () => {
        reject(new Error(`WebSocket failed to connect: ${lspWs}`))
      }
    })

    const iFace = toSocket(ws)
    const messageTransports = {
      reader: new WebSocketMessageReader(iFace),
      writer: new WebSocketMessageWriter(iFace)
    }

    const clientId = params.get('lspClientId') ?? 'stdio-lsp'
    const clientName = params.get('lspClientName') ?? 'LSP (stdio)'

    const client = new MonacoLanguageClient({
      id: clientId,
      name: clientName,
      clientOptions: buildClientOptions(),
      messageTransports
    })

    messageTransports.reader.onClose(async () => {
      await client.dispose()
    })

    try {
      await client.start()
    } catch (e: unknown) {
      console.error('[lsp] MonacoLanguageClient.start 失败:', e)
    }
  })().catch((e: unknown) => {
    console.error('[lsp] bootstrap 异常:', e)
  })
}
