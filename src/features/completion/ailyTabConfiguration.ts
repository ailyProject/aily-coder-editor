type Configuration = {
  inspect<T>(key: string): { globalValue?: T; workspaceValue?: T; workspaceFolderValue?: T } | undefined
  update(key: string, value: unknown, target: number): Thenable<void> | Promise<void>
}

/** Preserve an explicit disable while retiring the old insert/predict mode split. */
export async function migrateAilyTabConfiguration(config: Configuration, targets: { Global: number; Workspace: number; WorkspaceFolder: number }): Promise<void> {
  for (const [field, target] of [
    ['globalValue', targets.Global], ['workspaceValue', targets.Workspace], ['workspaceFolderValue', targets.WorkspaceFolder],
  ] as const) {
    const mode = config.inspect<string>('mode')?.[field]
    if (mode === 'off' && config.inspect<boolean>('enabled')?.[field] === undefined) await config.update('enabled', false, target)
    if (mode !== undefined) await config.update('mode', undefined, target)
    if (config.inspect<boolean>('nextEdit.enabled')?.[field] !== undefined) await config.update('nextEdit.enabled', undefined, target)
  }
}
