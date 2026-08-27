export interface InlineCompletionDocumentIdentity {
  uri: {
    scheme: string
  }
  languageId: string
}

/** 行内补全仅用于真实文件编辑器；SCM、历史版本和其它虚拟输入均不参与。 */
export function isFileInlineCompletionDocument(
  document: InlineCompletionDocumentIdentity
): boolean {
  return document.uri.scheme === 'file' && document.languageId !== 'scminput'
}
