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
  parseCoderEmbedThemeParam,
  remoteAuthority
} from './setup.workbench'
import { CustomEditorInput } from './features/customView.workbench'
import { announceAilyCoderWorkbenchReady } from './embedLifecycle'
import { getHostEmbedContext, onHostEmbedContextChanged } from './hostEmbedContext'
import { installHostLifecycleBridge } from './hostLifecycle'
import './main.common'

if (remoteAuthority != null) {
  void import('./features/remoteExtension')
}

installHostLifecycleBridge()

let appliedHostTheme = parseCoderEmbedThemeParam(new URLSearchParams(window.location.search).get('theme'))

async function syncHostTheme(): Promise<void> {
  const requestedTheme = getHostEmbedContext()?.meta?.theme
  if ((requestedTheme !== 'dark' && requestedTheme !== 'light') || requestedTheme === appliedHostTheme) {
    return
  }
  appliedHostTheme = requestedTheme
  const colorTheme = coderWorkbenchColorThemeForScheme(requestedTheme)
  const themeService = await getService(IWorkbenchThemeService)
  await themeService.setColorTheme(colorTheme, ConfigurationTarget.USER)
}

onHostEmbedContextChanged(() => {
  void syncHostTheme()
})
void syncHostTheme()

await announceAilyCoderWorkbenchReady()

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
