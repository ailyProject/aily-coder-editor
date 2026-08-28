export const NODE_MODULES_GLOB = '**/node_modules'

export type UserConfigurationMigration = {
  configuration: Record<string, unknown>
  changed: boolean
}

/**
 * 旧版把 node_modules 写入持久化的 files.exclude；仅修改新默认值不能让已有用户看到目录。
 * 迁移只处理 Explorer 配置，search.exclude 以及其他用户设置保持不变。
 */
export function showNodeModulesInExplorer(
  configuration: Record<string, unknown>
): UserConfigurationMigration {
  const filesExclude = configuration['files.exclude']
  if (
    filesExclude == null
    || typeof filesExclude !== 'object'
    || Array.isArray(filesExclude)
    || (filesExclude as Record<string, unknown>)[NODE_MODULES_GLOB] !== true
  ) {
    return { configuration, changed: false }
  }

  const nextFilesExclude = { ...filesExclude as Record<string, unknown> }
  delete nextFilesExclude[NODE_MODULES_GLOB]

  return {
    configuration: {
      ...configuration,
      'files.exclude': nextFilesExclude
    },
    changed: true
  }
}
