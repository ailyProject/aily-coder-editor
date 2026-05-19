import * as vscode from 'vscode'
import { resolveStyleHost } from './embedWorkbenchStyles'

/** 避免热重载重复挂载 */
const SIDEBAR_NAV_ATTR = 'data-aily-embed-sidebar-nav'

/** 与 VS Code Activity Bar 等价的视图切换命令 */
const SIDEBAR_NAV_ITEMS = [
  {
    id: 'explorer',
    command: 'workbench.view.explorer',
    icon: 'codicon-files',
    title: '资源管理器'
  },
  {
    id: 'search',
    command: 'workbench.view.search',
    icon: 'codicon-search',
    title: '搜索'
  },
  {
    id: 'scm',
    command: 'workbench.view.scm',
    icon: 'codicon-source-control',
    title: '源代码管理'
  }
] as const

type SidebarNavId = (typeof SIDEBAR_NAV_ITEMS)[number]['id']

/** 等待 workbench 侧栏 DOM 就绪的最大轮询次数 */
const SIDEBAR_POLL_MAX = 150
const SIDEBAR_POLL_MS = 80

let sidebarNavInstalled = false

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
  btn.title = item.title
  btn.setAttribute('aria-label', item.title)
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
        console.warn('[aily-coder] sidebar nav command failed:', item.command, err)
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
 * 构建并插入 Cursor 式横向顶栏（文件 / 搜索 / 分支）。
 */
function mountSidebarNav(sidebar: HTMLElement): void {
  if (sidebar.querySelector(`[${SIDEBAR_NAV_ATTR}]`)) {
    return
  }

  const nav = document.createElement('div')
  nav.className = 'aily-embed-sidebar-nav'
  nav.setAttribute(SIDEBAR_NAV_ATTR, 'true')
  nav.setAttribute('role', 'toolbar')
  nav.setAttribute('aria-label', '侧栏视图')

  let activeId: SidebarNavId = 'explorer'
  const onSelect = (id: SidebarNavId) => {
    activeId = id
    setActiveNavButton(nav, activeId)
  }

  for (const item of SIDEBAR_NAV_ITEMS) {
    nav.append(createNavButton(item, onSelect))
  }

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
    console.warn('[aily-coder] sidebar part not found; skip custom top bar')
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
