import type * as vscode from 'vscode'

/** Project-relative Aily View descriptions, stored separately from source and build configuration. */
export class AilyViewFileNotes {
  readonly #vscode: typeof vscode
  readonly #directory: vscode.Uri
  readonly #file: vscode.Uri
  #notes = new Map<string, string>()
  #loading?: Promise<void>
  #pending = Promise.resolve()

  constructor(vscodeApi: typeof vscode, readonly root: vscode.Uri) {
    this.#vscode = vscodeApi
    this.#directory = vscodeApi.Uri.joinPath(root, '.aily')
    this.#file = vscodeApi.Uri.joinPath(this.#directory, 'file-notes.json')
  }

  get(path: string): string | undefined {
    return this.#notes.get(path)
  }

  load(): Promise<void> {
    return this.#loading ??= this.#read().then(notes => {
      this.#notes = notes
    }).catch(error => {
      this.#loading = undefined
      throw error
    })
  }

  async #read(): Promise<Map<string, string>> {
    const fs = this.#vscode.workspace.fs
    try {
      // Embedded native read errors do not preserve the filesystem error code.
      await fs.stat(this.#file)
    } catch (error) {
      if ((error as vscode.FileSystemError)?.code === 'FileNotFound') return new Map()
      throw error
    }
    const content = await fs.readFile(this.#file)
    const data: unknown = JSON.parse(new TextDecoder().decode(content))
    if (data == null || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error(this.#file.path)
    }
    const notes = new Map<string, string>()
    for (const [path, value] of Object.entries(data)) {
      if (typeof value === 'string' && value.trim()) notes.set(path, value.trim())
    }
    return notes
  }

  #update(change: (notes: Map<string, string>) => boolean): Promise<void> {
    const update = this.#pending.then(async () => {
      await this.#loading?.catch(() => {})
      const notes = await this.#read()
      if (change(notes)) {
        const fs = this.#vscode.workspace.fs
        await fs.createDirectory(this.#directory)
        const text = `${JSON.stringify(Object.fromEntries(notes), null, 2)}\n`
        await fs.writeFile(this.#file, new TextEncoder().encode(text))
      }
      this.#notes = notes
      this.#loading = Promise.resolve()
    })
    this.#pending = update.catch(() => {})
    return update
  }

  set(path: string, value: string): Promise<void> {
    const note = value.trim()
    return this.#update(notes => {
      if (!note) return notes.delete(path)
      if (notes.get(path) === note) return false
      notes.set(path, note)
      return true
    })
  }

  /** Also updates notes on descendants when a directory moves or is deleted. */
  updatePath(oldPath: string, newPath?: string): Promise<void> {
    return this.#update(notes => {
      const matches = [...notes].filter(([path]) => path === oldPath || path.startsWith(`${oldPath}/`))
      for (const [path, note] of matches) {
        notes.delete(path)
        if (newPath != null) notes.set(newPath + path.slice(oldPath.length), note)
      }
      return matches.length > 0
    })
  }
}
