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
import { setLanguageServerState, hasLanguageServerCompilationDatabase } from './languageServerState'
import { getHostEmbedContext } from '../hostEmbedContext'

/** One language client per workbench, backed by its managed Coder runtime. */
const params = new URLSearchParams(window.location.search)
const explicitUrl = params.get('lspWs') ?? params.get('clangdWs')
const explicitPort = params.get('lspWsPort') ?? params.get('clangdWsPort')
const standaloneUrl = explicitUrl ?? (explicitPort ? `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.hostname}:${explicitPort}` : undefined)

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
    workspaceFolder: vscode.workspace.workspaceFolders?.[0],
    middleware: {
      handleDiagnostics(uri: vscode.Uri, diagnostics: vscode.Diagnostic[], next: (uri: vscode.Uri, diagnostics: vscode.Diagnostic[]) => void): void {
        // An Arduino board without its compiler flags produces misleading missing
        // SDK/type errors. Keep definitions/completions available without publishing
        // those fallback-parser errors as project diagnostics.
        next(uri, getHostEmbedContext()?.boardProfile && hasLanguageServerCompilationDatabase() === false ? [] : diagnostics)
      },
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

let endpoint: string | undefined
let generation = 0
let attempt = 0
let retry: ReturnType<typeof setTimeout> | undefined
let socket: WebSocket | undefined
let languageClient: MonacoLanguageClient | undefined
let disposed = false
async function connect(url: string): Promise<void> {
  const current = ++generation
  clearTimeout(retry)
  const previousSocket = socket; const previousClient = languageClient
  socket = undefined; languageClient = undefined
  await previousClient?.dispose(); previousSocket?.close()
  if (disposed || current !== generation) return
  setLanguageServerState('connecting')
  try {
    await waitServicesReady()
    if (disposed || current !== generation) return
    const ws = new WebSocket(url); socket = ws
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { ws.close(); reject(new Error('language server timeout')) }, 8000)
      ws.onopen = () => { clearTimeout(timer); resolve() }
      ws.onerror = ws.onclose = () => { clearTimeout(timer); reject(new Error('language server unavailable')) }
    })
    if (disposed || current !== generation) { ws.close(); return }
    const transports = { reader: new WebSocketMessageReader(toSocket(ws)), writer: new WebSocketMessageWriter(toSocket(ws)) }
    const client = new MonacoLanguageClient({ id: params.get('lspClientId') ?? 'stdio-lsp', name: params.get('lspClientName') ?? 'C/C++ language service', clientOptions: buildClientOptions(), messageTransports: transports })
    languageClient = client
    transports.reader.onClose(() => {
      if (current !== generation || disposed) return
      setLanguageServerState('unavailable'); scheduleRetry(url)
    })
    await client.start()
    if (current !== generation || disposed) return
    attempt = 0; setLanguageServerState('ready', client.initializeResult?.capabilities.experimental?.ailyCompilationDatabase)
  } catch {
    if (current !== generation || disposed) return
    setLanguageServerState('unavailable'); scheduleRetry(url)
  }
}
function scheduleRetry(url: string): void {
  clearTimeout(retry)
  retry = setTimeout(() => { void connect(url) }, Math.min(30_000, 2000 * 2 ** Math.min(4, attempt++)))
}
function receiveEndpoint(event: MessageEvent): void {
  if (event.source !== window.parent || event.data?.channel !== 'aily-coder-editor-language-server' || typeof event.data.url !== 'string' || standaloneUrl) return
  try {
    const url = new URL(event.data.url)
    if (url.host !== location.host || url.pathname !== '/lsp' || !['ws:', 'wss:'].includes(url.protocol) || !url.searchParams.get('token')) return
    if (endpoint === url.toString()) return
    endpoint = url.toString(); attempt = 0; void connect(endpoint)
  } catch { /* Invalid host endpoint is ignored without logging credentials. */ }
}
window.addEventListener('message', receiveEndpoint)
if (standaloneUrl) { endpoint = standaloneUrl; void connect(standaloneUrl) }
window.addEventListener('pagehide', () => {
  disposed = true; generation++; clearTimeout(retry); window.removeEventListener('message', receiveEndpoint)
  const previousSocket = socket
  void Promise.resolve(languageClient?.dispose()).finally(() => previousSocket?.close())
}, { once: true })
