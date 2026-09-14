import { readFile } from 'node:fs/promises'

export async function activeDevReloadUrl(markerPath) {
  let reloadUrl
  try {
    const marker = JSON.parse(await readFile(markerPath, 'utf8'))
    reloadUrl = new URL(String(marker.reloadUrl || ''))
  } catch {
    return ''
  }

  if (reloadUrl.protocol !== 'http:' ||
      !['127.0.0.1', 'localhost'].includes(reloadUrl.hostname) ||
      reloadUrl.pathname !== '/events') return ''

  try {
    const response = await fetch(new URL('/health', reloadUrl), {
      signal: AbortSignal.timeout(300),
    })
    return response.ok ? reloadUrl.toString() : ''
  } catch {
    return ''
  }
}
