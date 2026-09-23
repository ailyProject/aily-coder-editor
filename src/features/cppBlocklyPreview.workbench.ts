import { createInstance, EditorInput, IEditorService, StandaloneServices, type IEditorGroup } from '@codingame/monaco-vscode-api'
import { URI } from '@codingame/monaco-vscode-api/vscode/vs/base/common/uri'
import { ExtensionHostKind, registerExtension } from '@codingame/monaco-vscode-api/extensions'
import { registerEditorPane, SimpleEditorInput, SimpleEditorPane } from '@codingame/monaco-vscode-workbench-service-override'
import type * as vscode from 'vscode'
import { isCppPreviewFile, type SourceLocation } from './cppBlockly/types.js'

const COMMAND = 'aily.cpp.showBlocklyPreview'
const { getApi } = registerExtension({
  name: 'aily-cpp-blockly-preview', publisher: 'aily', version: '1.0.0', engines: { vscode: '*' },
  contributes: {
    commands: [{ command: COMMAND, title: 'C++：打开 Blockly 转换预览', icon: '$(open-preview)' }],
    menus: {
      'editor/title': [{ command: COMMAND, when: "resourceExtname =~ /\\.(cpp|cc|cxx|ino|h|hpp|hh|hxx)$/i && resourceScheme != aily-cpp-preview && !isInDiffEditor", group: 'navigation@1' }],
      commandPalette: [{ command: COMMAND, when: "resourceExtname =~ /\\.(cpp|cc|cxx|ino|h|hpp|hh|hxx)$/i && resourceScheme != aily-cpp-preview" }]
    }
  }
}, ExtensionHostKind.LocalProcess, { system: true })

class CppPreviewInput extends SimpleEditorInput {
  constructor(readonly source: URI) {
    super(URI.from({ scheme: 'aily-cpp-preview', path: source.path, query: source.toString() }))
    this.setName(`Blockly · ${source.path.split('/').pop() ?? 'C++'}`)
    this.setTitle(`Blockly 转换预览 — ${source.path}`)
  }
  get typeId(): string { return CppPreviewPane.ID }
  override matches(other: EditorInput): boolean {
    return other instanceof CppPreviewInput && other.source.toString() === this.source.toString()
  }
}

class CppPreviewPane extends SimpleEditorPane {
  static readonly ID = 'workbench.editors.ailyCppBlocklyPreview'
  constructor(group: IEditorGroup) { super(CppPreviewPane.ID, group) }
  initialize(): HTMLElement {
    const node = document.createElement('div')
    node.style.height = '100%'; node.style.width = '100%'
    return node
  }
  async renderInput(input: EditorInput, _options: unknown, _context: unknown, token: { isCancellationRequested: boolean }): Promise<{ dispose(): void }> {
    if (!(input instanceof CppPreviewInput)) return { dispose() {} }
    const [api, { mountCppPreview }] = await Promise.all([getApi(), import('./cppBlockly/previewView.js')])
    if (token.isCancellationRequested) return { dispose() {} }
    const uri = api.Uri.parse(input.source.toString())
    const read = () => api.workspace.openTextDocument(uri)
    const reveal = async (location?: SourceLocation): Promise<void> => {
      const doc = await read()
      const selection = location ? new api.Range(location.line - 1, location.column - 1, location.endLine - 1, location.endColumn - 1) : undefined
      await api.window.showTextDocument(doc, { preview: false, ...(selection ? { selection } : {}) })
    }
    const root = document.createElement('div')
    this.container.replaceChildren(root)
    const view = mountCppPreview(root, {
      name: uri.path.split('/').pop() ?? 'C++',
      async read() { const doc = await read(); return { text: doc.getText(), version: doc.version, dirty: doc.isDirty } },
      reveal,
      onChange(refresh) {
        const changed = api.workspace.onDidChangeTextDocument(event => { if (event.document.uri.toString() === uri.toString()) refresh() })
        const saved = api.workspace.onDidSaveTextDocument(doc => { if (doc.uri.toString() === uri.toString()) refresh() })
        return { dispose() { changed.dispose(); saved.dispose() } }
      }
    })
    return { dispose() { view.dispose(); root.remove() } }
  }
}

registerEditorPane('aily-cpp-blockly-preview-pane', 'Blockly 转换预览', CppPreviewPane, [CppPreviewInput])

void getApi().then(api => {
  api.commands.registerCommand(COMMAND, async (resource?: vscode.Uri) => {
    const source = resource?.scheme ? resource : api.window.activeTextEditor?.document.uri
    if (!source || !isCppPreviewFile(source.path)) {
      await api.window.showInformationMessage('请先打开一个 C++ 源文件或头文件（.cpp、.cc、.cxx、.ino、.h、.hpp、.hh、.hxx）。')
      return
    }
    try {
      const editorService = StandaloneServices.get(IEditorService)
      const existing = editorService.editors.find(editor => editor instanceof CppPreviewInput && editor.source.toString() === source.toString())
      const input = existing ?? await createInstance(CppPreviewInput, URI.parse(source.toString()))
      await editorService.openEditor(input, { pinned: true })
    } catch (error) { await api.window.showErrorMessage(`无法打开 Blockly 预览：${String(error)}`) }
  })
})
