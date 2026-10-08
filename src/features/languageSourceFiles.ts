import { Event } from '@codingame/monaco-vscode-api/vscode/vs/base/common/event'
import type { URI } from '@codingame/monaco-vscode-api/vscode/vs/base/common/uri'
import {
  FileSystemProviderCapabilities,
  FilePermission,
  FileSystemProviderErrorCode,
  createFileSystemProviderError
} from '@codingame/monaco-vscode-api/vscode/vs/platform/files/common/files'

export type LanguageSourceRequest = <T>(method: string, params: { path: string }) => Promise<T>

/** Keep file: URIs from clangd unchanged so F12, peek, references and subsequent
 * navigation inside SDK headers all use the same model and language client. */
export class LanguageSourceFileProvider {
  readonly capabilities = FileSystemProviderCapabilities.FileReadWrite | FileSystemProviderCapabilities.Readonly
  readonly onDidChangeCapabilities = Event.None
  readonly onDidChangeFile = Event.None

  constructor(private readonly request: LanguageSourceRequest, private readonly isWorkspaceResource: (resource: URI) => boolean = () => false) {}

  private async call<T>(method: string, resource: URI): Promise<T> {
    if (resource.scheme !== 'file' || this.isWorkspaceResource(resource)) throw createFileSystemProviderError('Not an external source file', FileSystemProviderErrorCode.FileNotFound)
    try { return await this.request<T>(method, { path: resource.fsPath }) }
    catch (error) {
      throw createFileSystemProviderError(error instanceof Error ? error.message : 'Source unavailable',
        error instanceof Error && error.message === 'Source not found' ? FileSystemProviderErrorCode.FileNotFound : FileSystemProviderErrorCode.NoPermissions)
    }
  }

  async stat(resource: URI) {
    return { ...await this.call<{ type: number; size: number; ctime: number; mtime: number }>('aily/fs/stat', resource), permissions: FilePermission.Readonly }
  }

  readdir(resource: URI): Promise<[string, number][]> {
    return this.call('aily/fs/readDirectory', resource)
  }

  async readFile(resource: URI): Promise<Uint8Array> {
    const { base64 } = await this.call<{ base64: string }>('aily/fs/readFile', resource)
    return Uint8Array.from(atob(base64), character => character.charCodeAt(0))
  }

  watch() { return { dispose() {} } }
  private denied(): never { throw createFileSystemProviderError('Library and SDK sources are read-only', FileSystemProviderErrorCode.NoPermissions) }
  writeFile(): never { return this.denied() }
  mkdir(): never { return this.denied() }
  delete(): never { return this.denied() }
  rename(): never { return this.denied() }
}
