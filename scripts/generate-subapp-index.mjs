#!/usr/bin/env node

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outputPath = path.join(repoRoot, 'dist', 'subapp-index.json')
const fallbackLocale = 'en'
const fallbackIcon = 'fa-light fa-puzzle-piece'

async function readJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'))
  } catch (error) {
    throw new Error(`Failed to read JSON ${path.relative(repoRoot, filePath)}: ${error.message}`)
  }
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function requireString(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`)
  }
  return value.trim()
}

function normalizeLocale(value) {
  return path.basename(String(value), '.json').trim().toLowerCase().replace(/-/g, '_')
}

function firstNamespace(translation) {
  const namespace = Object.keys(translation).find(key => isObject(translation[key]))
  if (!namespace) {
    throw new Error('i18n/en.json must contain a top-level translation namespace')
  }
  return namespace
}

function relativeTranslationKey(fullKey, namespace, label) {
  const prefix = `${namespace}.`
  if (!fullKey.startsWith(prefix) || fullKey.length === prefix.length) {
    throw new Error(`${label} must be inside namespace ${namespace}`)
  }
  return fullKey.slice(prefix.length)
}

function getNestedValue(source, relativeKey) {
  return relativeKey.split('.').reduce((value, key) => (isObject(value) ? value[key] : undefined), source)
}

function setNestedValue(target, relativeKey, value) {
  const segments = relativeKey.split('.')
  let cursor = target

  for (const segment of segments.slice(0, -1)) {
    if (!isObject(cursor[segment])) cursor[segment] = {}
    cursor = cursor[segment]
  }

  cursor[segments.at(-1)] = value
}

function sortLocales(locales, defaultLocale) {
  return [...locales].sort((left, right) => {
    if (left === defaultLocale) return -1
    if (right === defaultLocale) return 1
    return left.localeCompare(right)
  })
}

async function loadTranslations(metadata) {
  const i18nDir = path.join(repoRoot, metadata.i18nDir)
  const files = (await readdir(i18nDir, { withFileTypes: true })).filter(
    entry => entry.isFile() && entry.name.toLowerCase().endsWith('.json')
  )
  const fileByLocale = new Map()

  for (const file of files) {
    const locale = normalizeLocale(file.name)
    if (fileByLocale.has(locale)) {
      throw new Error(`Duplicate i18n locale: ${locale}`)
    }
    fileByLocale.set(locale, path.join(i18nDir, file.name))
  }

  if (!fileByLocale.has(metadata.defaultLocale)) {
    throw new Error(`Missing ${metadata.i18nDir}/${metadata.defaultLocale}.json`)
  }

  const defaultData = await readJson(fileByLocale.get(metadata.defaultLocale))
  const defaultNamespaceData = defaultData[metadata.namespace]
  if (!isObject(defaultNamespaceData)) {
    throw new Error(`Default locale is missing namespace ${metadata.namespace}`)
  }

  const defaultTitle = requireString(
    getNestedValue(defaultNamespaceData, metadata.relativeTitleKey),
    metadata.titleKey
  )
  const defaultDescription = requireString(
    getNestedValue(defaultNamespaceData, metadata.relativeDescriptionKey),
    metadata.descriptionKey
  )
  const locales = {}

  for (const locale of sortLocales(fileByLocale.keys(), metadata.defaultLocale)) {
    const data = await readJson(fileByLocale.get(locale))
    const namespaceData = data[metadata.namespace]
    if (!isObject(namespaceData)) {
      throw new Error(`Locale ${locale} is missing namespace ${metadata.namespace}`)
    }

    const title = requireString(
      getNestedValue(namespaceData, metadata.relativeTitleKey) ?? defaultTitle,
      `${locale} ${metadata.titleKey}`
    )
    const description = requireString(
      getNestedValue(namespaceData, metadata.relativeDescriptionKey) ?? defaultDescription,
      `${locale} ${metadata.descriptionKey}`
    )
    const summary = {}
    setNestedValue(summary, metadata.relativeTitleKey, title)
    setNestedValue(summary, metadata.relativeDescriptionKey, description)
    locales[locale] = summary
  }

  return locales
}

async function generateIndex() {
  const packageJson = await readJson(path.join(repoRoot, 'package.json'))
  if (packageJson.hide === true) {
    return {}
  }

  const subapp = isObject(packageJson.ailySubapp) ? packageJson.ailySubapp : {}
  const id = requireString(subapp.id || path.basename(repoRoot), 'subapp id')
  const packageName = requireString(subapp.package || packageJson.name, 'published package name')
  const packageVersion = requireString(packageJson.version, 'published package version')
  const i18nDir = requireString(subapp.i18n?.dir || 'i18n', 'i18n directory')
  const defaultLocale = normalizeLocale(subapp.i18n?.defaultLocale || fallbackLocale)
  const defaultTranslation = await readJson(path.join(repoRoot, i18nDir, `${defaultLocale}.json`))
  const namespace = requireString(subapp.namespace || firstNamespace(defaultTranslation), 'i18n namespace')
  const titleKey = requireString(subapp.titleKey || `${namespace}.TITLE`, 'titleKey')
  const descriptionKey = requireString(subapp.descriptionKey || `${namespace}.DESCRIPTION`, 'descriptionKey')
  const metadata = {
    defaultLocale,
    descriptionKey,
    i18nDir,
    namespace,
    relativeDescriptionKey: relativeTranslationKey(descriptionKey, namespace, 'descriptionKey'),
    relativeTitleKey: relativeTranslationKey(titleKey, namespace, 'titleKey'),
    titleKey
  }
  const locales = await loadTranslations(metadata)
  const appMetadata = isObject(subapp.app) ? subapp.app : {}
  // Spread all ailySubapp fields first (runtime, extension, compatibility, …),
  // then overwrite with computed index fields so generation config cannot leak.
  const entry = {
    ...subapp,
    id,
    only: typeof packageJson.only === 'string' && packageJson.only.trim()
      ? packageJson.only.trim().toLowerCase()
      : 'all',
    titleKey,
    namespace,
    app: {
      ...appMetadata,
      name: titleKey,
      description: descriptionKey,
      icon: appMetadata.icon || fallbackIcon,
      enabled: appMetadata.enabled ?? true
    },
    package: packageName,
    version: packageVersion,
    i18n: {
      defaultLocale,
      locales
    }
  }

  return { [id]: entry }
}

async function main() {
  const index = await generateIndex()
  await mkdir(path.dirname(outputPath), { recursive: true })
  await writeFile(outputPath, `${JSON.stringify(index, null, 2)}\n`, 'utf8')
  console.log(`Generated ${path.relative(repoRoot, outputPath)} with ${Object.keys(index).length} subapp.`)
}

main().catch(error => {
  console.error(error?.stack || error)
  process.exit(1)
})
