/**
 * Aily Board 节点的「列表」自定义编辑器（内嵌 Workbench 主编辑区）。
 * 用于展示 Blockly 主板包 mode[] 等「一板多类型」只读列表。
 */
import {
  createInstance,
  EditorInput,
  IEditorGroup,
  IInstantiationService,
  IEditorService,
  StandaloneServices
} from '@codingame/monaco-vscode-api'
import { URI } from '@codingame/monaco-vscode-api/vscode/vs/base/common/uri'
import type { IEditorIdentifier } from '@codingame/monaco-vscode-api/vscode/vs/workbench/common/editor'
import {
  IEditorSerializer,
  registerEditor,
  registerEditorPane,
  registerEditorSerializer,
  RegisteredEditorPriority,
  SimpleEditorInput,
  SimpleEditorPane
} from '@codingame/monaco-vscode-workbench-service-override'
import * as monaco from 'monaco-editor'
import {
  boardProfileToListSpec,
  getHostEmbedContext,
  HOST_EMBED_CONTEXT_CHANNEL,
  onHostEmbedContextChanged,
  type HostBoardListItemV1,
  type HostBoardProfileV1,
  type HostEmbedContextV1
} from '../hostEmbedContext.js'
import { readNativeFsBinary } from '../parentBackedNativeFs.js'

/** Board 虚拟属性固定资源键，保证单例标签 */
export const BOARD_LIST_RESOURCE_KEY = 'board'

/** 列表行：与宿主 boardProfile.frameworkModes 对齐 */
export type AilyBoardListItem = HostBoardListItemV1

/** 打开编辑器前写入的展示契约 */
export type AilyBoardListSpec = {
  readonly title: string
  readonly subtitle?: string
  readonly items: readonly AilyBoardListItem[]
}

const SPEC_BY_RESOURCE_KEY = new Map<string, AilyBoardListSpec>()

/** 固定 VS Code URI（monaco.Uri 无法被 findEditors 识别，会导致重复开标签） */
export function boardListUri(resourceKey = BOARD_LIST_RESOURCE_KEY): URI {
  return URI.from({ scheme: 'aily-board', path: `/${resourceKey}` })
}

/** 供命令在 openEditor 前注册列表数据 */
export function setAilyBoardListSpec(resourceKey: string, spec: AilyBoardListSpec): void {
  SPEC_BY_RESOURCE_KEY.set(resourceKey, spec)
}

export function getAilyBoardListSpec(resourceKey: string): AilyBoardListSpec | undefined {
  return SPEC_BY_RESOURCE_KEY.get(resourceKey)
}

/** 从宿主上下文组装 Board 虚拟节点的列表 spec */
export function buildBoardListSpecFromHost(): AilyBoardListSpec | null {
  const bp = getHostEmbedContext()?.boardProfile
  if (bp == null) {
    return null
  }
  return boardProfileToListSpec(bp)
}

function getWorkspaceRootPath(): string | undefined {
  const fromCtx = getHostEmbedContext()?.workspaceRoot?.trim()
  if (fromCtx) {
    return fromCtx
  }
  try {
    const raw = new URL(document.location.href).searchParams.get('folder')
    if (!raw) {
      return undefined
    }
    try {
      return decodeURIComponent(raw)
    } catch {
      return raw
    }
  } catch {
    return undefined
  }
}

/** 从 `.aily/coder-embed-hints.json` 读取 boardProfile（经宿主 native-fs 桥，避免 IFileService 导入） */
async function loadBoardSpecFromHintsFile(): Promise<AilyBoardListSpec | null> {
  const root = getWorkspaceRootPath()
  if (!root) {
    return null
  }
  try {
    const sep = root.includes('\\') ? '\\' : '/'
    const hintsPath =
      root.replace(/[/\\]+$/, '') + sep + '.aily' + sep + 'coder-embed-hints.json'
    const bytes = await readNativeFsBinary(hintsPath)
    if (bytes == null) {
      return null
    }
    const text = new TextDecoder('utf-8').decode(bytes)
    const parsed = JSON.parse(text) as { boardProfile?: HostBoardProfileV1 }
    const bp = parsed.boardProfile
    if (bp == null) {
      return null
    }
    return boardProfileToListSpec(bp)
  } catch {
    return null
  }
}

async function resolveBoardListSpec(resourceKey: string): Promise<AilyBoardListSpec | null> {
  const cached = getAilyBoardListSpec(resourceKey)
  if (cached != null) {
    return cached
  }
  const fromHost = buildBoardListSpecFromHost()
  if (fromHost != null) {
    return fromHost
  }
  return await loadBoardSpecFromHintsFile()
}

function applyBoardProfilePayload(bp: HostBoardProfileV1 | undefined): void {
  const spec = bp != null ? boardProfileToListSpec(bp) : null
  if (spec != null) {
    setAilyBoardListSpec(BOARD_LIST_RESOURCE_KEY, spec)
  }
  void refreshBoardListEditorPanes(BOARD_LIST_RESOURCE_KEY)
}

/** 收集所有 Board 编辑器标签（URI + typeId，含旧 monaco.Uri 实例） */
function findAllBoardEditorIdentifiers(editorService: IEditorService): IEditorIdentifier[] {
  const uri = boardListUri()
  const out: IEditorIdentifier[] = []
  const seen = new Set<EditorInput>()
  for (const item of editorService.findEditors(uri)) {
    if (!seen.has(item.editor)) {
      seen.add(item.editor)
      out.push(item)
    }
  }
  for (const editor of editorService.editors) {
    if (editor.typeId !== AilyBoardListEditorPane.ID) {
      continue
    }
    for (const item of editorService.findEditors(editor)) {
      if (!seen.has(item.editor)) {
        seen.add(item.editor)
        out.push(item)
      }
    }
  }
  return out
}

/**
 * 打开或聚焦 Board 列表编辑器；同一 resource 仅一个标签。
 * spec 可为空：先展示加载态，宿主 boardProfile 就绪后由 Pane 订阅自动刷新。
 */
export async function openAilyBoardListEditor(
  spec: AilyBoardListSpec | null | undefined,
  resourceKey = BOARD_LIST_RESOURCE_KEY
): Promise<void> {
  if (spec != null) {
    setAilyBoardListSpec(resourceKey, spec)
  }
  const uri = boardListUri(resourceKey)
  const editorService = StandaloneServices.get(IEditorService)
  const allBoard = findAllBoardEditorIdentifiers(editorService)

  if (allBoard.length > 0) {
    const keep = allBoard[0]
    if (allBoard.length > 1) {
      await editorService.closeEditors(allBoard.slice(1))
    }
    await editorService.openEditor(keep.editor, { pinned: true })
    await refreshBoardListEditorPanes(resourceKey)
    return
  }

  await editorService.openEditor(
    {
      resource: uri,
      options: {
        override: AilyBoardListEditorPane.ID,
        pinned: true
      }
    }
  )
}

/** 已打开的 Board Pane 实例，用于聚焦时立即刷新 */
const boardListPanes = new Set<AilyBoardListEditorPane>()

async function refreshBoardListEditorPanes(resourceKey: string): Promise<void> {
  await Promise.all([...boardListPanes].map((pane) => pane.refreshContent(resourceKey)))
}

function renderEmptyState(container: HTMLElement, loading: boolean): void {
  container.className = 'aily-board-list-editor'
  container.innerHTML = ''
  ensureListEditorStyles(container)
  const p = document.createElement('p')
  p.className = 'aily-board-list-editor__empty'
  p.textContent = loading
    ? '正在加载开发板类型列表…'
    : '暂无开发板类型列表。'
  container.appendChild(p)
}

function renderListDom(container: HTMLElement, spec: AilyBoardListSpec): void {
  container.className = 'aily-board-list-editor'
  container.innerHTML = ''
  ensureListEditorStyles(container)

  const header = document.createElement('div')
  header.className = 'aily-board-list-editor__header'

  const titleEl = document.createElement('h2')
  titleEl.className = 'aily-board-list-editor__title'
  titleEl.textContent = spec.title
  header.appendChild(titleEl)

  if (spec.subtitle != null && spec.subtitle.trim().length > 0) {
    const sub = document.createElement('p')
    sub.className = 'aily-board-list-editor__subtitle'
    sub.textContent = spec.subtitle
    header.appendChild(sub)
  }

  const hint = document.createElement('p')
  hint.className = 'aily-board-list-editor__hint'
  hint.textContent = '当前开发板支持的框架 / 类型（与 Blockly 主板包 mode 一致）'
  header.appendChild(hint)

  container.appendChild(header)

  const list = document.createElement('ul')
  list.className = 'aily-board-list-editor__list'
  list.setAttribute('role', 'list')

  for (const item of spec.items) {
    const row = document.createElement('li')
    row.className = 'aily-board-list-editor__row'
    if (item.selected) {
      row.classList.add('is-selected')
    }

    const labelWrap = document.createElement('div')
    labelWrap.className = 'aily-board-list-editor__label-wrap'

    const label = document.createElement('span')
    label.className = 'aily-board-list-editor__label'
    label.textContent = item.label?.trim() || item.id
    labelWrap.appendChild(label)

    if (item.description != null && item.description.trim().length > 0) {
      const desc = document.createElement('span')
      desc.className = 'aily-board-list-editor__desc'
      desc.textContent = item.description
      labelWrap.appendChild(desc)
    }

    row.appendChild(labelWrap)

    if (item.selected) {
      const badge = document.createElement('span')
      badge.className = 'aily-board-list-editor__badge'
      badge.textContent = '当前'
      row.appendChild(badge)
    }

    list.appendChild(row)
  }

  container.appendChild(list)
}

const LIST_EDITOR_STYLE_CSS = `
  .aily-board-list-editor {
    box-sizing: border-box;
    height: 100%;
    overflow: auto;
    padding: 16px 20px;
    background: var(--vscode-editor-background, #1e1e1e);
    color: var(--vscode-editor-foreground, #d4d4d4);
    font-family: "MiSans Regular", -apple-system, BlinkMacSystemFont, sans-serif;
    font-size: 14px;
  }
  .aily-board-list-editor__header { margin-bottom: 12px; }
  .aily-board-list-editor__title {
    margin: 0 0 6px;
    font-size: 18px;
    font-weight: 600;
    line-height: 26px;
  }
  .aily-board-list-editor__subtitle {
    margin: 0 0 4px;
    color: var(--vscode-descriptionForeground, #a5a5a5);
  }
  .aily-board-list-editor__hint {
    margin: 0;
    font-size: 12px;
    color: var(--vscode-descriptionForeground, #888);
  }
  .aily-board-list-editor__list {
    list-style: none;
    margin: 0;
    padding: 0;
    border: 1px solid var(--vscode-panel-border, #3c3c3c);
    border-radius: 5px;
    overflow: hidden;
  }
  .aily-board-list-editor__row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 10px 12px;
    border-bottom: 1px solid var(--vscode-panel-border, #3c3c3c);
  }
  .aily-board-list-editor__row:last-child { border-bottom: none; }
  .aily-board-list-editor__row.is-selected {
    background: rgba(24, 144, 255, 0.1);
  }
  .aily-board-list-editor__label-wrap {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .aily-board-list-editor__label { font-weight: 500; }
  .aily-board-list-editor__desc {
    font-size: 12px;
    color: var(--vscode-descriptionForeground, #999);
  }
  .aily-board-list-editor__badge {
    flex-shrink: 0;
    font-size: 11px;
    padding: 2px 8px;
    border-radius: 4px;
    background: var(--vscode-badge-background, #007acc);
    color: var(--vscode-badge-foreground, #fff);
  }
  .aily-board-list-editor__empty {
    margin: 0;
    color: var(--vscode-descriptionForeground, #999);
  }
`

function ensureListEditorStyles(container: HTMLElement): void {
  if (container.querySelector(':scope > style[data-aily-board-list-editor]')) {
    return
  }
  const style = document.createElement('style')
  style.setAttribute('data-aily-board-list-editor', 'true')
  style.textContent = LIST_EDITOR_STYLE_CSS
  container.prepend(style)
}

class AilyBoardListEditorPane extends SimpleEditorPane {
  static readonly ID = 'workbench.editors.ailyBoardList'

  #resourceKey = BOARD_LIST_RESOURCE_KEY
  #hostCtxUnsub?: () => void

  constructor(group: IEditorGroup) {
    super(AilyBoardListEditorPane.ID, group)
  }

  initialize(): HTMLElement {
    return document.createElement('div')
  }

  /** 宿主 boardProfile 更新或再次聚焦时刷新 DOM */
  async refreshContent(resourceKey?: string): Promise<void> {
    if (resourceKey != null) {
      this.#resourceKey = resourceKey
    }
    const key = this.#resourceKey
    const spec = await resolveBoardListSpec(key)
    if (spec != null) {
      setAilyBoardListSpec(key, spec)
      renderListDom(this.container, spec)
    } else {
      renderEmptyState(this.container, true)
    }
  }

  async renderInput(input: EditorInput): Promise<monaco.IDisposable> {
    this.#resourceKey = input.resource?.path.replace(/^\//, '') ?? BOARD_LIST_RESOURCE_KEY
    boardListPanes.add(this)

    this.#hostCtxUnsub = onHostEmbedContextChanged(() => {
      void this.refreshContent()
    })

    await this.refreshContent()

    return {
      dispose: () => {
        boardListPanes.delete(this)
        this.#hostCtxUnsub?.()
        this.#hostCtxUnsub = undefined
      }
    }
  }
}

class AilyBoardListEditorInput extends SimpleEditorInput {
  constructor(resource: URI | undefined) {
    super(resource)
    this.applyTitleFromSpec()
  }

  private applyTitleFromSpec(): void {
    const key = this.resource?.path.replace(/^\//, '') ?? BOARD_LIST_RESOURCE_KEY
    const spec = getAilyBoardListSpec(key) ?? buildBoardListSpecFromHost()
    const title = spec?.subtitle != null ? `Board — ${spec.subtitle}` : 'Board'
    this.setName(title)
    this.setTitle(title)
  }

  get typeId(): string {
    return AilyBoardListEditorPane.ID
  }
}

registerEditorPane(
  'aily-board-list-pane',
  'Aily board list',
  AilyBoardListEditorPane,
  [AilyBoardListEditorInput]
)

registerEditor(
  'aily-board',
  {
    id: AilyBoardListEditorPane.ID,
    label: 'Aily board list',
    priority: RegisteredEditorPriority.default
  },
  {
    singlePerResource: true
  },
  {
    async createEditorInput(editorInput) {
      return {
        editor: await createInstance(AilyBoardListEditorInput, editorInput.resource)
      }
    }
  }
)

interface ISerializedAilyBoardListInput {
  resourceJSON?: ReturnType<URI['toJSON']>
}

registerEditorSerializer(
  AilyBoardListEditorPane.ID,
  class implements IEditorSerializer {
    canSerialize(): boolean {
      return true
    }

    serialize(editor: AilyBoardListEditorInput): string | undefined {
      const payload: ISerializedAilyBoardListInput = {
        resourceJSON: editor.resource?.toJSON()
      }
      return JSON.stringify(payload)
    }

    deserialize(
      instantiationService: IInstantiationService,
      serializedEditor: string
    ): EditorInput | undefined {
      const payload: ISerializedAilyBoardListInput = JSON.parse(serializedEditor)
      return instantiationService.createInstance(
        AilyBoardListEditorInput,
        URI.revive(payload.resourceJSON)
      )
    }
  }
)

/** 宿主上下文变化时始终刷新 Board 视图（含 boardProfile 晚到） */
onHostEmbedContextChanged(() => {
  const spec = buildBoardListSpecFromHost()
  if (spec != null) {
    setAilyBoardListSpec(BOARD_LIST_RESOURCE_KEY, spec)
  }
  void refreshBoardListEditorPanes(BOARD_LIST_RESOURCE_KEY)
})

/**
 * 直接监听宿主 postMessage，避免扩展包与 workbench 包各有一份 hostEmbedContext 快照不同步。
 */
function installBoardPaneDirectHostBridge(): void {
  if (typeof window === 'undefined') {
    return
  }
  window.addEventListener('message', (ev: MessageEvent) => {
    const d = ev.data as { channel?: string; payload?: HostEmbedContextV1 }
    if (d?.channel !== HOST_EMBED_CONTEXT_CHANNEL) {
      return
    }
    if (!window.parent || ev.source !== window.parent) {
      return
    }
    const p = d.payload
    if (p?.v !== 1) {
      return
    }
    applyBoardProfilePayload(p.boardProfile)
  })
}

installBoardPaneDirectHostBridge()
