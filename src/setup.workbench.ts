import {
  ConfigurationTarget,
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
import { BrowserStorageService } from '@codingame/monaco-vscode-storage-service-override'
import { ExtensionHostKind } from '@codingame/monaco-vscode-extensions-service-override'
import { registerExtension } from '@codingame/monaco-vscode-api/extensions'
import {
  getUserConfiguration,
  updateUserConfiguration
} from '@codingame/monaco-vscode-configuration-service-override'
import './features/customView.workbench'
import {
  coderEmbedThemeQueryPresent,
  coderEmbedThemeScheme,
  coderWorkbenchColorThemeForScheme,
  commonServices,
  constructOptions,
  envOptions,
  remoteAuthority,
  userDataProvider,
  disableShadowDom
} from './setup.common'

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
  container.style.height = '100vh'

  document.body.replaceChildren(container)

  if (!disableShadowDom) {
    const shadowRoot = container.attachShadow({
      mode: 'open'
    })

    const workbenchElement = document.createElement('div')
    workbenchElement.style.height = '100vh'
    shadowRoot.appendChild(workbenchElement)
    container = workbenchElement
  }
}

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
