/** 标记已注入的 embed workbench 样式节点，避免热重载重复插入 */

const EMBED_WORKBENCH_STYLES_ATTR = 'data-aily-embed-workbench-styles'



/** 嵌入壳对 Monaco Workbench 的 DOM 覆写（须注入 Shadow Root 内才生效） */

const EMBED_WORKBENCH_CSS = `

/* Activity Bar 已在配置中 hidden，DOM 仍可能存在，彻底不占位 */

.monaco-workbench .part.activitybar {

  display: none !important;

}



/* Part 级标题（原 Activity Bar 横条位），由自定义顶栏替代 */

.monaco-workbench .part.sidebar > .title {

  display: none !important;

}



/* 侧栏：自定义导航 + 下方 pane（含 composite.title 与文件树） */

.monaco-workbench .part.sidebar {

  display: flex !important;

  flex-direction: column !important;

  min-height: 0;

}



.monaco-workbench .part.sidebar > .content {

  flex: 1 1 auto;

  min-height: 0;

  overflow: hidden;

}



/* Cursor 式横向视图切换条 */

.aily-embed-sidebar-nav {

  flex: none;

  display: flex;

  align-items: center;

  gap: 2px;

  padding: 2px 8px 2px;

  min-height: 35px;

  box-sizing: border-box;

  background: var(--vscode-sideBar-background, #252526);

  border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border, rgba(255, 255, 255, 0.1));

}



.aily-embed-sidebar-nav__btn {

  display: inline-flex;

  align-items: center;

  justify-content: center;

  width: 28px;

  height: 28px;

  margin: 0;

  padding: 0;

  border: none;

  border-radius: 6px;

  cursor: pointer;

  color: var(--vscode-sideBar-foreground, #cccccc);

  background: transparent;

  opacity: 0.72;

  transition: background 0.15s ease, opacity 0.15s ease, color 0.15s ease;

}



.aily-embed-sidebar-nav__btn .codicon {

  font-size: 18px;

}



.aily-embed-sidebar-nav__btn:hover {

  opacity: 1;

  background: var(--vscode-list-hoverBackground, #2a2d2e);

}



.aily-embed-sidebar-nav__btn.is-active {

  opacity: 1;

  color: var(--vscode-foreground, #fff);

  background: var(--vscode-list-inactiveSelectionBackground, #3a3c3f);

}



.aily-embed-sidebar-nav__btn:focus-visible {

  outline: 1px solid var(--vscode-focusBorder, #007acc);

  outline-offset: 1px;

}

`



/**

 * 解析样式挂载点：workbench 在 Shadow DOM 内时，须挂到 shadowRoot 而非外层 document。

 */

export function resolveStyleHost(container: ParentNode): ParentNode {

  const root = container.getRootNode()

  if (root instanceof ShadowRoot) {

    return root

  }

  if (container instanceof HTMLElement && container.shadowRoot) {

    return container.shadowRoot

  }

  return container

}



/**

 * 向 workbench 容器注入覆写样式。

 * 在 `initializeMonacoService` 之后、与 `container` 同一节点调用。

 */

export function installEmbedWorkbenchStyles(container: ParentNode): void {

  const host = resolveStyleHost(container)

  const marker = `style[${EMBED_WORKBENCH_STYLES_ATTR}]`

  if (host instanceof ShadowRoot || host instanceof HTMLElement) {

    if (host.querySelector(marker)) {

      return

    }

  }



  const style = document.createElement('style')

  style.setAttribute(EMBED_WORKBENCH_STYLES_ATTR, 'true')

  style.textContent = EMBED_WORKBENCH_CSS

  host.appendChild(style)

}


