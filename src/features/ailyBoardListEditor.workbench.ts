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
  type HostEmbedContextV1,
  type HostPlatformPackageV1
} from '../hostEmbedContext.js'
import { readNativeFsBinary } from '../parentBackedNativeFs.js'

/** boards.txt：`yun.name=Arduino Yún` */
const BOARD_NAME_LINE_RE = /^(\w+)\.name=(.+)$/

type BoardsTxtEntry = { readonly id: string; readonly label: string }

/** 从 boards.txt 文本解析全部 `*.name=` 主板类型 */
function parseBoardTypesFromBoardsTxt(text: string): BoardsTxtEntry[] {
  const seen = new Set<string>()
  const out: BoardsTxtEntry[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) {
      continue
    }
    const m = line.match(BOARD_NAME_LINE_RE)
    if (!m) {
      continue
    }
    const id = m[1]
    const label = (m[2] ?? '').trim()
    if (!id || seen.has(id)) {
      continue
    }
    seen.add(id)
    out.push({ id, label: label || id })
  }
  return out
}

function resolveSdkPackagePath(
  platformPackages?: readonly HostPlatformPackageV1[]
): string | undefined {
  const fromCtx = getHostEmbedContext()?.platformPackages
  const list = platformPackages ?? fromCtx
  if (list == null || list.length === 0) {
    return undefined
  }
  const sdk = list.find((p) => p.kind === 'sdk' && p.absolutePath?.trim())
  return sdk?.absolutePath?.trim() || undefined
}

function joinFsPath(base: string, ...segments: string[]): string {
  const sep = base.includes('\\') ? '\\' : '/'
  return [base.replace(/[/\\]+$/, ''), ...segments].join(sep)
}

/** 读取 SDK 根目录 boards.txt */
async function loadBoardTypesFromSdkBoardsTxt(
  platformPackages?: readonly HostPlatformPackageV1[]
): Promise<BoardsTxtEntry[] | null> {
  const sdkRoot = resolveSdkPackagePath(platformPackages)
  if (!sdkRoot) {
    return null
  }
  const boardsPath = joinFsPath(sdkRoot, 'boards.txt')
  const bytes = await readNativeFsBinary(boardsPath)
  if (bytes == null) {
    return null
  }
  const text = new TextDecoder('utf-8').decode(bytes)
  const entries = parseBoardTypesFromBoardsTxt(text)
  return entries.length > 0 ? entries : null
}

function inferSelectedBoardTypeId(
  boardProfile: HostBoardProfileV1 | undefined,
  entries: readonly BoardsTxtEntry[]
): string | undefined {
  if (entries.length === 0) {
    return undefined
  }
  const selectedMode = boardProfile?.frameworkModes?.find((m) => m.selected)
  if (selectedMode?.id) {
    const byId = entries.find((e) => e.id === selectedMode.id)
    if (byId) {
      return byId.id
    }
    const byLabel = entries.find(
      (e) => e.label.toLowerCase() === selectedMode.label?.trim().toLowerCase()
    )
    if (byLabel) {
      return byLabel.id
    }
  }
  const boardName = boardProfile?.boardName?.trim()
  if (boardName) {
    const exact = entries.find((e) => e.id === boardName)
    if (exact) {
      return exact.id
    }
    const ci = entries.find((e) => e.label.toLowerCase() === boardName.toLowerCase())
    if (ci) {
      return ci.id
    }
  }
  return entries[0]?.id
}

function boardsTxtEntriesToListItems(
  entries: readonly BoardsTxtEntry[],
  boardProfile?: HostBoardProfileV1
): HostBoardListItemV1[] {
  const selectedId = inferSelectedBoardTypeId(boardProfile, entries)
  return entries.map((e) => ({
    id: e.id,
    label: e.label,
    selected: e.id === selectedId
  }))
}

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

type CoderEmbedHintsPayload = {
  boardProfile?: HostBoardProfileV1
  platformPackages?: readonly HostPlatformPackageV1[]
}

/** 从 `.aily/coder-embed-hints.json` 读取嵌入提示（经宿主 native-fs 桥） */
async function loadCoderEmbedHints(): Promise<CoderEmbedHintsPayload | null> {
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
    return JSON.parse(text) as CoderEmbedHintsPayload
  } catch {
    return null
  }
}

/** 从 hints 文件读取 boardProfile */
async function loadBoardSpecFromHintsFile(): Promise<AilyBoardListSpec | null> {
  const hints = await loadCoderEmbedHints()
  const bp = hints?.boardProfile
  if (bp == null) {
    return null
  }
  return boardProfileToListSpec(bp)
}

/** 优先用 SDK boards.txt 的 `*.name=` 列表；否则回退 Blockly frameworkModes */
async function resolveBoardListSpec(resourceKey: string): Promise<AilyBoardListSpec | null> {
  const cached = getAilyBoardListSpec(resourceKey)
  const ctx = getHostEmbedContext()
  // 始终读取 hints，避免仅有 Blockly 缓存时丢失 platformPackages（SDK 路径）
  const hints = await loadCoderEmbedHints()
  const boardProfile = ctx?.boardProfile ?? hints?.boardProfile
  const platformPackages = ctx?.platformPackages ?? hints?.platformPackages

  const boardsEntries = await loadBoardTypesFromSdkBoardsTxt(platformPackages)
  if (boardsEntries != null && boardsEntries.length > 0) {
    const items = boardsTxtEntriesToListItems(boardsEntries, boardProfile)
    return {
      title: 'Board',
      subtitle:
        boardProfile?.boardNickname?.trim() ||
        boardProfile?.boardName?.trim() ||
        undefined,
      items
    }
  }

  if (cached != null) {
    return cached
  }
  const fromHost = buildBoardListSpecFromHost()
  if (fromHost != null) {
    return fromHost
  }
  return boardProfile != null ? boardProfileToListSpec(boardProfile) : null
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
    ? '正在从 SDK boards.txt 加载主板类型…'
    : '未找到 SDK boards.txt 或主板类型列表为空。'
  container.appendChild(p)
}

/** 挂到 document.body 的下拉层，避免被编辑器 overflow 裁剪 */
type BoardSelectPortalState = {
  panel: HTMLElement
  trigger: HTMLElement
  wrap: HTMLElement
}

let boardSelectPortal: BoardSelectPortalState | null = null
let boardSelectOutsideListener: ((ev: MouseEvent) => void) | null = null
let boardSelectRepositionListener: (() => void) | null = null

/** 从 workbench 同步到 portal 面板的 VS Code 主题变量 */
const VSCODE_THEME_VARS_FOR_PORTAL = [
  '--vscode-dropdown-background',
  '--vscode-dropdown-foreground',
  '--vscode-editor-background',
  '--vscode-editor-foreground',
  '--vscode-panel-border',
  '--vscode-input-border',
  '--vscode-list-hoverBackground',
  '--vscode-list-activeSelectionBackground',
  '--vscode-list-activeSelectionForeground',
  '--vscode-focusBorder',
  '--vscode-descriptionForeground',
  '--vscode-scrollbarSlider-background',
  '--vscode-scrollbarSlider-hoverBackground',
  '--vscode-widget-shadow'
] as const

function resolveBoardEditorThemeRoot(anchor: HTMLElement): HTMLElement {
  return (
    anchor.closest('.aily-board-list-editor') ??
    anchor.closest('.monaco-workbench') ??
    document.body ??
    document.documentElement
  )
}

/** portal 在 body 上，须把当前明暗主题的 CSS 变量写到面板根节点 */
function applyPortalPanelTheme(panel: HTMLElement, themeAnchor: HTMLElement): void {
  const themeRoot = resolveBoardEditorThemeRoot(themeAnchor)
  const cs = getComputedStyle(themeRoot)
  const docCs = getComputedStyle(document.documentElement)
  for (const name of VSCODE_THEME_VARS_FOR_PORTAL) {
    const v = cs.getPropertyValue(name).trim() || docCs.getPropertyValue(name).trim()
    if (v) {
      panel.style.setProperty(name, v)
    }
  }
  const isLight =
    document.body.classList.contains('vscode-light') ||
    document.documentElement.classList.contains('vscode-light') ||
    themeRoot.classList.contains('vscode-light')
  panel.style.colorScheme = isLight ? 'light' : 'dark'
}

function positionBoardSelectPanel(panel: HTMLElement, trigger: HTMLElement): void {
  const rect = trigger.getBoundingClientRect()
  const gap = 4
  const maxH = Math.min(320, Math.max(120, window.innerHeight - rect.bottom - gap - 12))
  panel.style.left = `${rect.left}px`
  panel.style.top = `${rect.bottom + gap}px`
  panel.style.width = `${Math.max(rect.width, 280)}px`
  panel.style.maxHeight = `${maxH}px`
  panel.style.minHeight = '80px'
  panel.style.zIndex = '100000'
}

function detachBoardSelectRepositionListener(): void {
  if (boardSelectRepositionListener != null) {
    window.removeEventListener('resize', boardSelectRepositionListener)
    window.removeEventListener('scroll', boardSelectRepositionListener, true)
    boardSelectRepositionListener = null
  }
}

function closeBoardSelectPanel(): void {
  if (boardSelectPortal != null) {
    boardSelectPortal.panel.remove()
    boardSelectPortal.wrap.classList.remove('is-open')
    boardSelectPortal.trigger.setAttribute('aria-expanded', 'false')
    boardSelectPortal = null
  }
  if (boardSelectOutsideListener != null) {
    document.removeEventListener('mousedown', boardSelectOutsideListener, true)
    boardSelectOutsideListener = null
  }
  detachBoardSelectRepositionListener()
}

function applyBoardTypeSelection(
  item: AilyBoardListItem,
  triggerText: HTMLElement,
  outputEl: HTMLElement,
  panel: HTMLElement
): void {
  const label = item.label?.trim() || item.id
  triggerText.textContent = label
  outputEl.textContent = `已选择：${label}（${item.id}）`
  console.log('[AilyBoardListEditor] board type selected:', { id: item.id, label })

  for (const row of panel.querySelectorAll('.aily-board-select__option')) {
    const el = row as HTMLElement
    const isSel = el.dataset.boardId === item.id
    el.classList.toggle('is-selected', isSel)
    el.setAttribute('aria-selected', isSel ? 'true' : 'false')
  }

  closeBoardSelectPanel()
}

function renderBoardTypeDropdown(container: HTMLElement, spec: AilyBoardListSpec): void {
  let currentSelectedId =
    spec.items.find((i) => i.selected)?.id ?? spec.items[0]?.id ?? ''
  const selected =
    spec.items.find((i) => i.id === currentSelectedId) ?? spec.items[0]

  const field = document.createElement('div')
  field.className = 'aily-board-list-editor__field'

  const fieldLabel = document.createElement('label')
  fieldLabel.className = 'aily-board-list-editor__field-label'
  fieldLabel.textContent = '主板类型'
  field.appendChild(fieldLabel)

  const wrap = document.createElement('div')
  wrap.className = 'aily-board-select'

  const trigger = document.createElement('button')
  trigger.type = 'button'
  trigger.className = 'aily-board-select__trigger'
  trigger.setAttribute('aria-haspopup', 'listbox')
  trigger.setAttribute('aria-expanded', 'false')

  const triggerText = document.createElement('span')
  triggerText.className = 'aily-board-select__trigger-text'
  triggerText.textContent = selected?.label?.trim() || selected?.id || '—'
  trigger.appendChild(triggerText)

  const chevron = document.createElement('span')
  chevron.className = 'aily-board-select__chevron'
  chevron.setAttribute('aria-hidden', 'true')
  chevron.textContent = '▾'
  trigger.appendChild(chevron)

  const outputEl = document.createElement('div')
  outputEl.className = 'aily-board-list-editor__selection-output vsfont'
  if (selected != null) {
    const label = selected.label?.trim() || selected.id
    outputEl.textContent = `已选择：${label}（${selected.id}）`
  }

  const openPanel = (): void => {
    ensureBoardSelectPortalStyles()
    closeBoardSelectPanel()
    const panel = document.createElement('ul')
    panel.className = 'aily-board-select__panel aily-board-select__panel--portal'
    panel.setAttribute('role', 'listbox')
    panel.setAttribute('aria-label', '主板类型列表')

    for (const item of spec.items) {
      const opt = document.createElement('li')
      opt.className = 'aily-board-select__option'
      opt.dataset.boardId = item.id
      opt.setAttribute('role', 'option')
      opt.setAttribute('aria-selected', item.id === currentSelectedId ? 'true' : 'false')
      if (item.id === currentSelectedId) {
        opt.classList.add('is-selected')
      }

      const optLabel = document.createElement('span')
      optLabel.className = 'aily-board-select__option-label'
      optLabel.textContent = item.label?.trim() || item.id
      opt.appendChild(optLabel)

      const optId = document.createElement('span')
      optId.className = 'aily-board-select__option-id'
      optId.textContent = item.id
      opt.appendChild(optId)

      opt.addEventListener('mousedown', (ev) => {
        ev.preventDefault()
        ev.stopPropagation()
      })
      opt.addEventListener('click', (ev) => {
        ev.preventDefault()
        ev.stopPropagation()
        currentSelectedId = item.id
        applyBoardTypeSelection(item, triggerText, outputEl, panel)
      })

      panel.appendChild(opt)
    }

    panel.addEventListener('wheel', (ev) => {
      ev.stopPropagation()
    }, { passive: true })

    applyPortalPanelTheme(panel, container)
    positionBoardSelectPanel(panel, trigger)
    document.body.appendChild(panel)
    wrap.classList.add('is-open')
    trigger.setAttribute('aria-expanded', 'true')
    boardSelectPortal = { panel, trigger, wrap }

    boardSelectRepositionListener = () => {
      if (boardSelectPortal?.panel === panel) {
        applyPortalPanelTheme(panel, container)
        positionBoardSelectPanel(panel, trigger)
      }
    }
    window.addEventListener('resize', boardSelectRepositionListener)
    window.addEventListener('scroll', boardSelectRepositionListener, true)

    boardSelectOutsideListener = (ev: MouseEvent) => {
      const t = ev.target as Node
      if (panel.contains(t) || trigger.contains(t) || wrap.contains(t)) {
        return
      }
      closeBoardSelectPanel()
    }
    document.addEventListener('mousedown', boardSelectOutsideListener, true)
  }

  trigger.addEventListener('click', (ev) => {
    ev.stopPropagation()
    if (boardSelectPortal != null) {
      closeBoardSelectPanel()
      return
    }
    openPanel()
  })

  wrap.appendChild(trigger)
  field.appendChild(wrap)
  field.appendChild(outputEl)

  const meta = document.createElement('p')
  meta.className = 'aily-board-list-editor__meta'
  meta.textContent = `共 ${spec.items.length} 种主板类型 · 数据来自 SDK boards.txt`
  field.appendChild(meta)

  container.appendChild(field)
}

function renderListDom(container: HTMLElement, spec: AilyBoardListSpec): void {
  closeBoardSelectPanel()
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
  hint.textContent = 'SDK 主板包支持的主板类型（boards.txt）'
  header.appendChild(hint)

  container.appendChild(header)
  renderBoardTypeDropdown(container, spec)
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
  .aily-board-list-editor__field {
    max-width: 520px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .aily-board-list-editor__field-label {
    font-size: 12px;
    font-weight: 500;
    color: var(--vscode-descriptionForeground, #a5a5a5);
    letter-spacing: 0.02em;
  }
  .aily-board-list-editor__meta {
    margin: 0;
    font-size: 11px;
    color: var(--vscode-descriptionForeground, #777);
  }
  .aily-board-list-editor__selection-output {
    margin: 0;
    padding: 8px 10px;
    border-radius: 4px;
    background: var(--vscode-textCodeBlock-background, #1e1e1e);
    border: 1px solid var(--vscode-panel-border, #3c3c3c);
    font-size: 12px;
    color: var(--vscode-editor-foreground, #d4d4d4);
    word-break: break-all;
  }
  .aily-board-select {
    position: relative;
    width: 100%;
  }
  .aily-board-select__trigger {
    box-sizing: border-box;
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 8px 12px;
    border: 1px solid var(--vscode-input-border, #4a4c4f);
    border-radius: 5px;
    background: var(--vscode-input-background, #3a3c3f);
    color: var(--vscode-input-foreground, #d4d4d4);
    font: inherit;
    cursor: pointer;
    transition: border-color 0.2s, box-shadow 0.2s, background 0.2s;
  }
  .aily-board-select__trigger:hover {
    border-color: var(--vscode-inputOption-hoverBackground, #5a5c5f);
    background: var(--vscode-list-hoverBackground, #3f3f3f);
  }
  .aily-board-select.is-open .aily-board-select__trigger,
  .aily-board-select__trigger:focus-visible {
    outline: none;
    border-color: var(--vscode-focusBorder, #007acc);
    box-shadow: 0 0 0 2px rgba(0, 122, 204, 0.25);
  }
  .aily-board-select__trigger-text {
    flex: 1;
    min-width: 0;
    text-align: left;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 500;
  }
  .aily-board-select__chevron {
    flex-shrink: 0;
    font-size: 12px;
    color: var(--vscode-descriptionForeground, #999);
    transition: transform 0.2s;
  }
  .aily-board-select.is-open .aily-board-select__chevron {
    transform: rotate(180deg);
    color: var(--vscode-focusBorder, #007acc);
  }
  .aily-board-select__option {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
    padding: 8px 12px;
    cursor: pointer;
    transition: background 0.15s;
  }
  .aily-board-select__option:hover {
    background: var(--vscode-list-hoverBackground, #2a2d2e);
  }
  .aily-board-select__option.is-selected {
    background: var(--vscode-list-activeSelectionBackground, rgba(24, 144, 255, 0.12));
  }
  .aily-board-select__option.is-selected .aily-board-select__option-label {
    color: var(--vscode-focusBorder, #3794ff);
  }
  .aily-board-select__option-label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .aily-board-select__option-id {
    flex-shrink: 0;
    font-size: 11px;
    font-family: Consolas, "Courier New", monospace;
    color: var(--vscode-descriptionForeground, #888);
  }
  .aily-board-list-editor__empty {
    margin: 0;
    color: var(--vscode-descriptionForeground, #999);
  }
`

/**
 * Portal 下拉挂到 document.body：样式使用 VS Code 变量（由 applyPortalPanelTheme 注入），
 * fallback 覆盖暗色 / 亮色默认。
 */
const BOARD_SELECT_PORTAL_STYLE_CSS = `
  ul.aily-board-select__panel.aily-board-select__panel--portal {
    box-sizing: border-box;
    display: block;
    position: fixed;
    margin: 0;
    padding: 4px 0;
    list-style: none;
    overflow-x: hidden;
    overflow-y: auto;
    overscroll-behavior: contain;
    -webkit-overflow-scrolling: touch;
    border: 1px solid var(--vscode-panel-border, #3c3c3c);
    border-radius: 5px;
    background-color: var(--vscode-dropdown-background, #2d2d2d);
    color: var(--vscode-dropdown-foreground, var(--vscode-editor-foreground, #d4d4d4));
    font-family: "MiSans Regular", -apple-system, BlinkMacSystemFont, sans-serif;
    font-size: 14px;
    line-height: 1.4;
    box-shadow: 0 6px 16px var(--vscode-widget-shadow, rgba(0, 0, 0, 0.36));
    scrollbar-width: thin;
    scrollbar-color: var(--vscode-scrollbarSlider-background, rgba(121, 121, 121, 0.4))
      var(--vscode-dropdown-background, #2d2d2d);
    pointer-events: auto;
    isolation: isolate;
  }
  ul.aily-board-select__panel.aily-board-select__panel--portal::-webkit-scrollbar {
    width: 8px;
  }
  ul.aily-board-select__panel.aily-board-select__panel--portal::-webkit-scrollbar-track {
    background: var(--vscode-dropdown-background, #2d2d2d);
    border-radius: 4px;
  }
  ul.aily-board-select__panel.aily-board-select__panel--portal::-webkit-scrollbar-thumb {
    background: var(--vscode-scrollbarSlider-background, rgba(121, 121, 121, 0.4));
    border-radius: 4px;
    border: 2px solid var(--vscode-dropdown-background, #2d2d2d);
  }
  ul.aily-board-select__panel.aily-board-select__panel--portal::-webkit-scrollbar-thumb:hover {
    background: var(--vscode-scrollbarSlider-hoverBackground, rgba(100, 100, 100, 0.7));
  }
  ul.aily-board-select__panel.aily-board-select__panel--portal > li.aily-board-select__option {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
    padding: 8px 12px;
    margin: 0;
    cursor: pointer;
    background: transparent;
    color: var(--vscode-dropdown-foreground, var(--vscode-editor-foreground, #d4d4d4));
    transition: background 0.15s, color 0.15s;
  }
  ul.aily-board-select__panel.aily-board-select__panel--portal > li.aily-board-select__option:hover {
    background: var(--vscode-list-hoverBackground, #2a2d2e);
  }
  ul.aily-board-select__panel.aily-board-select__panel--portal > li.aily-board-select__option.is-selected {
    background: var(--vscode-list-activeSelectionBackground, rgba(24, 144, 255, 0.12));
    color: var(--vscode-list-activeSelectionForeground, var(--vscode-focusBorder, #3794ff));
  }
  ul.aily-board-select__panel.aily-board-select__panel--portal > li.aily-board-select__option.is-selected .aily-board-select__option-label {
    color: inherit;
  }
  ul.aily-board-select__panel.aily-board-select__panel--portal .aily-board-select__option-label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  ul.aily-board-select__panel.aily-board-select__panel--portal .aily-board-select__option-id {
    flex-shrink: 0;
    font-size: 11px;
    font-family: Consolas, "Courier New", monospace;
    color: var(--vscode-descriptionForeground, #888);
  }
  @media (prefers-color-scheme: light) {
    ul.aily-board-select__panel.aily-board-select__panel--portal:not([style*="--vscode-dropdown-background"]) {
      background-color: #ffffff;
      color: #333333;
      border-color: #cecece;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
      scrollbar-color: rgba(0, 0, 0, 0.25) #ffffff;
    }
  }
`

function ensureBoardSelectPortalStyles(): void {
  if (document.head.querySelector('style[data-aily-board-select-portal]')) {
    return
  }
  const style = document.createElement('style')
  style.setAttribute('data-aily-board-select-portal', 'true')
  style.textContent = BOARD_SELECT_PORTAL_STYLE_CSS
  document.head.appendChild(style)
}

function ensureListEditorStyles(container: HTMLElement): void {
  ensureBoardSelectPortalStyles()
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
        closeBoardSelectPanel()
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
