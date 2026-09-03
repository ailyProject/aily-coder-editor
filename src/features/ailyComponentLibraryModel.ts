export type SupportedLibraryLanguage =
  | 'zh_cn' | 'zh_hk' | 'en' | 'ja' | 'ko' | 'de' | 'fr' | 'es' | 'pt' | 'ru' | 'ar'

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
