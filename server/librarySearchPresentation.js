const SUMMARY_FIELDS = [
  'libraryRef', 'packageName', 'source', 'name', 'version', 'description', 'author', 'url',
  'category', 'compatible', 'compatibility', 'dependencies', 'dependencyStatus', 'dependenciesReady', 'dependencyIssues', 'providesIncludes',
  'installed', 'installedVersion', 'managed', 'ready', 'sourceReady', 'sourceDirectory', 'libraryRoots', 'localRoots',
]

/** Agent projection only. The editor continues to receive the complete catalog DTO. */
export function presentLibrarySearch(result, detail = 'summary') {
  const present = item => {
    const copy = { ...item }
    delete copy.sourcePath
    if (detail === 'full') return copy
    return Object.fromEntries(SUMMARY_FIELDS.filter(key => copy[key] !== undefined)
      .map(key => [key, copy[key]]))
  }
  if (detail === 'full') return { ...result, detail, libraries: (result.libraries ?? []).map(present) }
  const page = { ...result }
  delete page.categories
  delete page.types
  return { ...page, detail, libraries: (result.libraries ?? []).map(present),
    compatibleAlternatives: (result.compatibleAlternatives ?? []).map(present) }
}
