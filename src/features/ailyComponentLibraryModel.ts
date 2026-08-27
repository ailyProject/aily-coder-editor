import type { HostAilyLibraryV1 } from '../hostEmbedContext.js'

export type SupportedLibraryLanguage =
  | 'zh_cn' | 'zh_hk' | 'en' | 'ja' | 'ko' | 'de' | 'fr' | 'es' | 'pt' | 'ru' | 'ar'

export type AilyLibraryEntry = {
  readonly id: string
  readonly source: 'aily'
  readonly packageName: string
  readonly folderName: string
  readonly sdkLabel: string
  readonly name: string
  readonly version: string
  readonly versions: readonly string[]
  readonly author: string
  readonly maintainer: string
  readonly sentence: string
  readonly paragraph: string
  readonly category: string
  readonly url: string
  readonly architectures: readonly string[]
  readonly installed: boolean
  readonly installedVersion?: string
}

export function normalizeLibraryLanguage(value: unknown): SupportedLibraryLanguage {
  const language = String(value ?? '').trim().toLowerCase().replace(/-/gu, '_')
  if (language === 'zh' || language.startsWith('zh_cn') || language.includes('hans')) return 'zh_cn'
  if (
    language.startsWith('zh_hk')
    || language.startsWith('zh_tw')
    || language.includes('hant')
  ) return 'zh_hk'
  if (language.startsWith('pt')) return 'pt'
  const base = language.split('_')[0]
  return ['en', 'ja', 'ko', 'de', 'fr', 'es', 'ru', 'ar'].includes(base ?? '')
    ? base as SupportedLibraryLanguage
    : 'en'
}

function searchable(value: unknown): string {
  return String(value ?? '').normalize('NFKC').toLocaleLowerCase('en')
}

function installedVersion(value: unknown): string {
  return String(value ?? '').trim().replace(/^[~^<>=\s]+/u, '')
}

/**
 * Search/paginate the exact host Library Manager snapshot without reading a second catalog.
 * Source ordering is preserved to match the main application.
 */
export function createHostAilyLibraryPage(
  catalog: readonly HostAilyLibraryV1[],
  dependencies: Readonly<Record<string, unknown>>,
  query: string,
  offset: number,
  limit: number,
): { total: number; libraries: AilyLibraryEntry[] } {
  const tokens = searchable(query).split(/[\s,，]+/u).filter(Boolean)
  const matched = catalog.filter((library) => {
    if (tokens.length === 0) return true
    const haystack = searchable([
      library.name,
      library.packageName,
      library.description,
      library.author,
      ...library.keywords,
    ].join(' '))
    return tokens.every(token => haystack.includes(token))
  })
  const start = Math.max(0, Number.isFinite(offset) ? Math.trunc(offset) : 0)
  const pageSize = Math.min(50, Math.max(1, Number.isFinite(limit) ? Math.trunc(limit) : 50))
  return {
    total: matched.length,
    libraries: matched.slice(start, start + pageSize).map((library) => {
      const declaredVersion = installedVersion(dependencies[library.packageName])
        || library.installedVersion
      return {
        id: `blockly:${library.packageName}`,
        source: 'aily',
        packageName: library.packageName,
        folderName: library.packageName,
        sdkLabel: 'Aily',
        name: library.name || library.packageName,
        version: library.version,
        versions: library.version ? [library.version] : [],
        author: library.author,
        maintainer: '',
        sentence: library.description,
        paragraph: '',
        category: '',
        url: library.url,
        architectures: library.architectures,
        installed: library.installed || declaredVersion !== '',
        ...(declaredVersion ? { installedVersion: declaredVersion } : {}),
      }
    }),
  }
}
