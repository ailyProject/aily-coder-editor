type Configuration = {
  inspect<T>(key: string): { globalValue?: T; workspaceValue?: T; workspaceFolderValue?: T; globalLanguageValue?: T; workspaceLanguageValue?: T; workspaceFolderLanguageValue?: T } | undefined
  update(key: string, value: unknown, target: number, overrideInLanguage?: boolean): Thenable<void> | Promise<void>
}

/** Change the effective override instead of writing a global value it masks. */
export async function updateAilyTabConfiguration(config: Configuration, key: string, value: unknown, targets: { Global: number; Workspace: number; WorkspaceFolder: number }): Promise<void> {
  const inspected = config.inspect(key)
  for (const [field, target, language] of [
    ['workspaceFolderLanguageValue', targets.WorkspaceFolder, true],
    ['workspaceLanguageValue', targets.Workspace, true],
    ['globalLanguageValue', targets.Global, true],
    ['workspaceFolderValue', targets.WorkspaceFolder, false],
    ['workspaceValue', targets.Workspace, false],
  ] as const) {
    if (inspected?.[field] !== undefined) { await config.update(key, value, target, language); return }
  }
  await config.update(key, value, targets.Global, false)
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
