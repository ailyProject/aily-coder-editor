import {
  ConfigurationTarget,
  IEditorService,
  IWorkbenchThemeService,
  StandaloneServices,
  createInstance,
  getService
} from '@codingame/monaco-vscode-api'
import {
  clearStorage,
  coderWorkbenchColorThemeForScheme,
  remoteAuthority
} from './setup.workbench'
import { CustomEditorInput } from './features/customView.workbench'
import { announceAilyCoderWorkbenchReady } from './embedLifecycle'
import { getHostEmbedContext, onHostEmbedContextChanged } from './hostEmbedContext'
import { installHostLifecycleBridge } from './hostLifecycle'
import { createHostThemeSynchronizer } from './hostThemeSync'
import './main.common'

if (remoteAuthority != null) {
  void import('./features/remoteExtension')
}

installHostLifecycleBridge()

const hostThemeSync = createHostThemeSynchronizer(async requestedTheme => {
  const colorTheme = coderWorkbenchColorThemeForScheme(requestedTheme)
  const themeService = await getService(IWorkbenchThemeService)
  const availableThemes = await themeService.getColorThemes()
  const requestedColorTheme = availableThemes.find(theme => theme.settingsId === colorTheme)
  const appliedTheme = await themeService.setColorTheme(
    requestedColorTheme ?? colorTheme,
    ConfigurationTarget.USER
  )
  if (appliedTheme == null) {
    throw new Error(`Workbench theme is unavailable: ${colorTheme}`)
  }
}, (error, requestedTheme) => {
  console.warn('[aily-coder] failed to synchronize host theme', requestedTheme, error)
})

function syncHostTheme(): void {
  const requestedTheme = getHostEmbedContext()?.meta?.theme
  if (requestedTheme !== 'dark' && requestedTheme !== 'light') {
    return
  }
  void hostThemeSync.sync(requestedTheme)
}

onHostEmbedContextChanged(() => {
  syncHostTheme()
})
syncHostTheme()

await announceAilyCoderWorkbenchReady()
// A host snapshot may arrive while the Workbench theme extensions are still registering.
// Re-run the latest request after the first committed Workbench frame so an early failed
// application (notably a combined language + theme change) is deterministically retried.
syncHostTheme()

// document.querySelector('#customEditorPanel')!.addEventListener('click', async () => {
//   const input = await createInstance(CustomEditorInput, undefined)
//   let toggle = false
//   const interval = window.setInterval(() => {
//     const title = toggle ? 'Awesome editor pane' : 'Incredible editor pane'
//     input.setTitle(title)
//     input.setName(title)
//     input.setDescription(title)
//     toggle = !toggle
//   }, 1000)
//   input.onWillDispose(() => {
//     window.clearInterval(interval)
//   })

//   await StandaloneServices.get(IEditorService).openEditor(input, {
//     pinned: true
//   })
// })

// document.querySelector('#clearStorage')!.addEventListener('click', async () => {
  // await clearStorage()
// })

// document.querySelector('#toggleShadowDom')!.addEventListener('click', async () => {
//   const url = new URL(window.location.href)
//   if (url.searchParams.has('disableShadowDom')) {
//     url.searchParams.delete('disableShadowDom')
//   } else {
//     url.searchParams.set('disableShadowDom', 'true')
//   }
//   window.location.href = url.toString()
// })
