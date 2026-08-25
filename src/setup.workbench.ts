import {
  ConfigurationTarget,
  IEditorService,
  IFileService,
  IStorageService,
  IWorkbenchLayoutService,
  IWorkbenchThemeService,
  getService,
  initialize as initializeMonacoService
} from '@codingame/monaco-vscode-api'
import getWorkbenchServiceOverride, {
  Parts
} from '@codingame/monaco-vscode-workbench-service-override'
import getQuickAccessServiceOverride from '@codingame/monaco-vscode-quickaccess-service-override'
import {
  BrowserStorageService,
  StorageScope
} from '@codingame/monaco-vscode-storage-service-override'
import { URI } from '@codingame/monaco-vscode-api/vscode/vs/base/common/uri'
import { StorageTarget } from '@codingame/monaco-vscode-api/vscode/vs/platform/storage/common/storage'
import { ExtensionHostKind } from '@codingame/monaco-vscode-extensions-service-override'
import { registerExtension } from '@codingame/monaco-vscode-api/extensions'
import {
  getUserConfiguration,
  updateUserConfiguration
} from '@codingame/monaco-vscode-configuration-service-override'
// 自定义底部面板
// import './features/customView.workbench'
import {
  coderEmbedThemeQueryPresent,
  coderEmbedThemeScheme,
  coderWorkbenchColorThemeForScheme,
  commonServices,
  constructOptions,
  embedFolderAbsolute,
  envOptions,
  remoteAuthority,
  userDataProvider,
  disableShadowDom,
  useEmbedHostLocalFolder
} from './setup.common'
import { installEmbedCommandPaletteBlock } from './embedCommandPalettePatch'
import { installEmbedLayoutSync } from './embedLayoutSync'
import { installEmbedWorkbenchStyles } from './embedWorkbenchStyles'
import { installEmbedSidebarTopBar } from './embedSidebarTopBar'
import { setCoderWorkbenchQueryRoot } from './coderWorkbenchDom.js'
import { installAilyViewInlineRenameHost } from './features/ailyViewInlineRename.js'

/** 与宿主 `?theme=` 共用：dark→Default Dark+、light→Default Light Modern（见 setup.common.ts） */
export type { CoderEmbedThemeScheme } from './setup.common'
export {
  CODER_EMBED_SCHEME_TO_WORKBENCH_COLOR_THEME,
  CODER_EMBED_THEME_QUERY_PARAM,
  coderEmbedThemeQueryPresent,
  coderWorkbenchColorThemeForScheme,
  parseCoderEmbedThemeParam
} from './setup.common'

let container = window.vscodeContainer

if (container == null) {
  container = document.createElement('div')
  container.style.height = '100%'
  container.style.width = '100%'

  document.body.replaceChildren(container)

  if (!disableShadowDom) {
    const shadowRoot = container.attachShadow({
      mode: 'open'
    })

    const workbenchElement = document.createElement('div')
    workbenchElement.style.height = '100%'
    workbenchElement.style.width = '100%'
    shadowRoot.appendChild(workbenchElement)
    container = workbenchElement
  }
}

setCoderWorkbenchQueryRoot(container)
installAilyViewInlineRenameHost()

// const buttons = document.createElement('div')
// buttons.innerHTML = `
// <button id="toggleHTMLFileSystemProvider">Toggle HTML filesystem provider</button>
// <button id="toggleShadowDom">Toggle Shadow Dom usage</button>
// <button id="customEditorPanel">Open custom editor panel</button>
// <button id="clearStorage">Clear user data</button>
// <button id="resetLayout">Reset layout</button>
// <button id="toggleFullWorkbench">Switch to custom rendering mode</button>
// <br />
// <button id="togglePanel">Toggle Panel</button>
// <button id="toggleAuxiliary">Toggle Secondary Panel</button>
// <button id="toggleSandbox">Switch to sandbox rendering mode</button>
// `
// document.body.append(buttons)

// Override services
await initializeMonacoService(
  {
    ...commonServices,
    ...getWorkbenchServiceOverride(),
    ...getQuickAccessServiceOverride({
      isKeybindingConfigurationVisible: () => true,
      shouldUseGlobalPicker: () => true
    })
  },
  container,
  constructOptions,
  envOptions
)

const CODER_WORKSPACE_OPENED_KEY = 'ailyCoder.workspaceOpened'
const CODER_LAST_ACTIVE_FILE_KEY = 'ailyCoder.lastActiveFile'

function workspaceRelativeFilePath(resource: URI, root: URI): string | undefined {
  if (resource.scheme !== 'file') {
    return undefined
  }
  const rootPath = root.path.replace(/\/$/, '')
  const filePath = resource.path
  const prefix = `${rootPath}/`
  if (!filePath.toLowerCase().startsWith(prefix.toLowerCase())) {
    return undefined
  }
  return filePath.slice(prefix.length)
}

/** 首次显示 main.cpp；之后恢复该工程最后一次显示的源码文件。 */
async function restoreCoderActiveEditor(): Promise<void> {
  if (!useEmbedHostLocalFolder || !embedFolderAbsolute) {
    return
  }

  const storageService = await getService(IStorageService)
  const editorService = await getService(IEditorService)
  const workspaceRoot = URI.file(embedFolderAbsolute)

  const rememberActiveFile = (): void => {
    const resource = editorService.activeEditor?.resource
    if (resource == null) {
      return
    }
    const relativePath = workspaceRelativeFilePath(resource, workspaceRoot)
    if (relativePath == null) {
      return
    }
    storageService.store(
      CODER_LAST_ACTIVE_FILE_KEY,
      relativePath,
      StorageScope.WORKSPACE,
      StorageTarget.MACHINE
    )
  }
  editorService.onDidActiveEditorChange(rememberActiveFile)

  const hasOpened = storageService.getBoolean(
    CODER_WORKSPACE_OPENED_KEY,
    StorageScope.WORKSPACE,
    false
  )
  storageService.store(
    CODER_WORKSPACE_OPENED_KEY,
    true,
    StorageScope.WORKSPACE,
    StorageTarget.MACHINE
  )

  const rememberedPath = storageService.get(
    CODER_LAST_ACTIVE_FILE_KEY,
    StorageScope.WORKSPACE
  )
  const targetUri = hasOpened
    ? rememberedPath
      ? URI.joinPath(workspaceRoot, rememberedPath)
      : undefined
    : URI.joinPath(workspaceRoot, 'sketch', 'src', 'main.cpp')
  if (targetUri == null || workspaceRelativeFilePath(targetUri, workspaceRoot) == null) {
    return
  }

  const fileService = await getService(IFileService)
  if (!(await fileService.exists(targetUri))) {
    return
  }

  await editorService.openEditor({
    resource: targetUri,
    options: { pinned: true }
  })
}

await restoreCoderActiveEditor()

// 嵌入壳：拦截命令面板，避免 Ctrl/Cmd+Shift+P 弹出 VS Code 全局命令列表
installEmbedCommandPaletteBlock()

// 嵌入壳：Activity Bar 隐藏 + Cursor 式侧栏顶栏（文件/搜索）
installEmbedWorkbenchStyles(container)
void installEmbedSidebarTopBar(container)

if (coderEmbedThemeQueryPresent) {
  const nextColorTheme = coderWorkbenchColorThemeForScheme(coderEmbedThemeScheme)
  try {
    let settings: Record<string, unknown>
    try {
      settings = JSON.parse(await getUserConfiguration()) as Record<string, unknown>
    } catch {
      settings = {}
    }
    settings['workbench.colorTheme'] = nextColorTheme
    await updateUserConfiguration(JSON.stringify(settings, null, 4))

    const themeSvc = await getService(IWorkbenchThemeService)
    await themeSvc.setColorTheme(nextColorTheme, ConfigurationTarget.USER)
  } catch {
    /* ignore */
  }
}

const layoutService = await getService(IWorkbenchLayoutService)
installEmbedLayoutSync(layoutService)
// document.querySelector('#togglePanel')!.addEventListener('click', async () => {
//   layoutService.setPartHidden(layoutService.isVisible(Parts.PANEL_PART, window), Parts.PANEL_PART)
// })

// document.querySelector('#toggleAuxiliary')!.addEventListener('click', async () => {
//   layoutService.setPartHidden(
//     layoutService.isVisible(Parts.AUXILIARYBAR_PART, window),
//     Parts.AUXILIARYBAR_PART
//   )
// })

// document.querySelector('#toggleSandbox')!.addEventListener('click', async () => {
//   const url = new URL(window.location.href)
//   url.search = ''
//   url.searchParams.append('sandbox', '')
//   window.location.href = url.toString()
// })

export async function clearStorage(): Promise<void> {
  await userDataProvider.reset()
  await ((await getService(IStorageService)) as BrowserStorageService).clear()
}

// await registerExtension(
//   {
//     name: 'demo',
//     publisher: 'codingame',
//     version: '1.0.0',
//     engines: {
//       vscode: '*'
//     }
//   },
//   ExtensionHostKind.LocalProcess
// ).setAsDefaultApi()

export { remoteAuthority }
