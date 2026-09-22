import * as vscode from 'vscode'
import { resolveStyleHost } from './embedWorkbenchStyles'
import {
  getHostCoderEditorUpdateState,
  getHostEmbedContext,
  onHostCoderEditorUpdateStateChanged,
  onHostEmbedContextChanged,
  requestHostCoderEditorUpdate
} from './hostEmbedContext.js'
import { initialHostLanguage, workbenchUiStrings } from './features/ailyWorkbenchI18n.js'
import { getCompletionStatus, onCompletionStatusChanged } from './features/completion/completionStatus'

/** 避免热重载重复挂载 */
const SIDEBAR_NAV_ATTR = 'data-aily-embed-sidebar-nav'

/** 与 VS Code Activity Bar 等价的视图切换命令 */
const SIDEBAR_NAV_ITEMS = [
  {
    id: 'explorer',
    command: 'workbench.view.explorer',
    icon: 'codicon-files',
    titleKey: 'explorer'
  },
  {
    id: 'search',
    command: 'workbench.view.search',
    icon: 'codicon-search',
    titleKey: 'search'
  },
  {
    id: 'scm',
    command: 'workbench.view.scm',
    icon: 'codicon-source-control',
    titleKey: 'sourceControl'
  }
] as const

type SidebarNavId = (typeof SIDEBAR_NAV_ITEMS)[number]['id']

/** 等待 workbench 侧栏 DOM 就绪的最大轮询次数 */
const SIDEBAR_POLL_MAX = 150
const SIDEBAR_POLL_MS = 80

let sidebarNavInstalled = false
let mountedSidebarNav: HTMLElement | null = null

function updateButtonCopy(language: unknown): {
  update: string
  updating: string
  preparing: string
  restart: string
  retry: string
} {
  const normalized = String(language ?? '').trim().toLowerCase().replace(/-/g, '_')
  if (normalized === 'zh_cn' || normalized === 'zh_hans' || normalized.startsWith('zh_cn_')) {
    return { update: '更新', updating: '更新中', preparing: '准备更新', restart: '重启更新', retry: '重试更新' }
  }
  if (normalized === 'zh_hk' || normalized === 'zh_tw' || normalized === 'zh_hant') {
    return { update: '更新', updating: '更新中', preparing: '準備更新', restart: '重啟更新', retry: '重試更新' }
  }
  return { update: 'Update', updating: 'Updating', preparing: 'Preparing', restart: 'Restart update', retry: 'Retry update' }
}

function updateSidebarNavLabels(nav: HTMLElement): void {
  const copy = workbenchUiStrings(
    getHostEmbedContext()?.meta?.lang ?? initialHostLanguage()
  ).sidebar
  nav.setAttribute('aria-label', copy.toolbar)
  for (const item of SIDEBAR_NAV_ITEMS) {
    const button = nav.querySelector<HTMLButtonElement>(`[data-view-id="${item.id}"]`)
    if (button == null) continue
    const title = copy[item.titleKey]
    button.title = title
    button.setAttribute('aria-label', title)
  }
  const completion = nav.querySelector<HTMLButtonElement>('[data-action-id="completion"]')
  if (completion != null) {
    const status = getCompletionStatus()
    const title = status.text.replace(/\$\([^)]*\)\s*/g, '')
    completion.title = `${title}\n${status.detail}`
    completion.setAttribute('aria-label', title)
    const icon = completion.querySelector('span')
    if (icon) icon.className = `codicon codicon-${status.text.match(/\$\(([^)~]+)/)?.[1] ?? 'sparkle'}`
  }
  const update = nav.querySelector<HTMLButtonElement>('[data-action-id="update"]')
  if (update != null) {
    const state = getHostCoderEditorUpdateState()
    const labels = updateButtonCopy(getHostEmbedContext()?.meta?.lang ?? initialHostLanguage())
    update.hidden = state?.visible !== true
    update.disabled = state == null || !state.actionable
    update.classList.toggle('is-busy', state?.busy === true)
    const label = state?.state === 'restart-required'
      ? labels.restart
      : state?.state === 'failed'
        ? labels.retry
        : state?.busy
          ? (state.state === 'available' || state.state === 'downloading'
              ? labels.preparing
              : labels.updating)
          : labels.update
    const version = state?.availableVersion ? ` v${state.availableVersion}` : ''
    update.title = `${label}${version}`
    update.setAttribute('aria-label', `${label}${version}`)
    const text = update.querySelector<HTMLElement>('.aily-embed-sidebar-update__label')
    if (text) text.textContent = state?.progress ? `${label} ${state.progress}%` : label
    const icon = update.querySelector<HTMLElement>('.codicon')
    if (icon) {
      icon.className = state?.busy
        ? 'codicon codicon-loading codicon-modifier-spin'
        : state?.state === 'restart-required'
          ? 'codicon codicon-refresh'
          : 'codicon codicon-cloud-download'
    }
  }
}

onHostEmbedContextChanged(() => {
  if (mountedSidebarNav != null) updateSidebarNavLabels(mountedSidebarNav)
})
onCompletionStatusChanged(() => { if (mountedSidebarNav) updateSidebarNavLabels(mountedSidebarNav) })
onHostCoderEditorUpdateStateChanged(() => {
  if (mountedSidebarNav) updateSidebarNavLabels(mountedSidebarNav)
})

/**
 * 在 shadowRoot / workbench 内查找侧栏 Part。
 */
function findSidebarPart(host: ParentNode): HTMLElement | null {
  const el = host.querySelector('.monaco-workbench .part.sidebar')
  return el instanceof HTMLElement ? el : null
}

/**
 * 轮询直到侧栏渲染完成（initialize 后异步生成 DOM）。
 */
async function waitForSidebarPart(host: ParentNode): Promise<HTMLElement | null> {
  for (let i = 0; i < SIDEBAR_POLL_MAX; i++) {
    const sidebar = findSidebarPart(host)
    if (sidebar) {
      return sidebar
    }
    await new Promise((r) => setTimeout(r, SIDEBAR_POLL_MS))
  }
  return null
}

/**
 * 创建单个视图切换按钮（使用 VS Code codicon，与内置图标一致）。
 */
function createNavButton(
  item: (typeof SIDEBAR_NAV_ITEMS)[number],
  onSelect: (id: SidebarNavId) => void
): HTMLButtonElement {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'aily-embed-sidebar-nav__btn'
  btn.dataset.viewId = item.id

  const icon = document.createElement('span')
  icon.className = `codicon ${item.icon}`
  icon.setAttribute('aria-hidden', 'true')
  btn.append(icon)

  btn.addEventListener('click', () => {
    void (async () => {
      try {
        await vscode.commands.executeCommand(item.command)
        onSelect(item.id)
      } catch (err) {
        console.warn('[aily-coder-editor] sidebar nav command failed:', item.command, err)
      }
    })()
  })

  return btn
}

/**
 * 更新当前激活按钮样式（Cursor 式圆角底）。
 */
function setActiveNavButton(nav: HTMLElement, activeId: SidebarNavId): void {
  nav.querySelectorAll<HTMLButtonElement>('.aily-embed-sidebar-nav__btn').forEach((btn) => {
    const isActive = btn.dataset.viewId === activeId
    btn.classList.toggle('is-active', isActive)
    btn.setAttribute('aria-pressed', isActive ? 'true' : 'false')
  })
}

/**
 * 构建并插入 Cursor 式横向顶栏（文件 / 搜索 / Git）。
 */
function mountSidebarNav(sidebar: HTMLElement): void {
  if (sidebar.querySelector(`[${SIDEBAR_NAV_ATTR}]`)) {
    return
  }

  const nav = document.createElement('div')
  nav.className = 'aily-embed-sidebar-nav'
  nav.setAttribute(SIDEBAR_NAV_ATTR, 'true')
  nav.setAttribute('role', 'toolbar')

  let activeId: SidebarNavId = 'explorer'
  const onSelect = (id: SidebarNavId) => {
    activeId = id
    setActiveNavButton(nav, activeId)
  }

  for (const item of SIDEBAR_NAV_ITEMS) {
    nav.append(createNavButton(item, onSelect))
  }

  const completion = document.createElement('button')
  completion.type = 'button'
  completion.className = 'aily-embed-sidebar-nav__btn'
  completion.dataset.actionId = 'completion'
  const completionIcon = document.createElement('span')
  completionIcon.className = 'codicon codicon-sparkle'
  completionIcon.setAttribute('aria-hidden', 'true')
  completion.append(completionIcon)
  completion.addEventListener('click', () => {
    void (async () => {
      try {
        await vscode.commands.executeCommand('aily.completion.settings')
      } catch (err) {
        console.warn('[aily-coder-editor] advanced completion menu failed:', err)
      }
    })()
  })
  nav.append(completion)

  const update = document.createElement('button')
  update.type = 'button'
  update.className = 'aily-embed-sidebar-update'
  update.dataset.actionId = 'update'
  update.hidden = true
  const updateIcon = document.createElement('span')
  updateIcon.className = 'codicon codicon-cloud-download'
  updateIcon.setAttribute('aria-hidden', 'true')
  const updateLabel = document.createElement('span')
  updateLabel.className = 'aily-embed-sidebar-update__label'
  update.append(updateIcon, updateLabel)
  update.addEventListener('click', () => {
    if (!update.disabled) requestHostCoderEditorUpdate()
  })
  nav.append(update)

  mountedSidebarNav = nav
  updateSidebarNavLabels(nav)
  setActiveNavButton(nav, activeId)
  sidebar.insertBefore(nav, sidebar.firstChild)
}

/**
 * 安装嵌入侧栏顶栏：在 `.part.sidebar` 顶部注入视图切换条。
 * 依赖 `embedWorkbenchStyles` 隐藏 Activity Bar 与 Part 级 `.title`。
 */
export async function installEmbedSidebarTopBar(container: ParentNode): Promise<void> {
  if (sidebarNavInstalled) {
    return
  }

  const host = resolveStyleHost(container)
  const sidebar = await waitForSidebarPart(host)
  if (!sidebar) {
    console.warn('[aily-coder-editor] sidebar part not found; skip custom top bar')
    return
  }

  mountSidebarNav(sidebar)
  sidebarNavInstalled = true

  // 默认打开资源管理器，与 Cursor 首次进入一致
  try {
    await vscode.commands.executeCommand('workbench.view.explorer')
  } catch {
    /* ignore */
  }
}
