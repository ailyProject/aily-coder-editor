import { Language, Parser } from 'web-tree-sitter'
import runtimeUrl from 'web-tree-sitter/web-tree-sitter.wasm?url'
import languageUrl from 'tree-sitter-cpp/tree-sitter-cpp.wasm?url'
import { convertCpp } from './converter.js'
import { previewError } from './types.js'

let parserPromise: Promise<Parser> | undefined
function parser(): Promise<Parser> {
  parserPromise ??= (async () => {
    await Parser.init({ locateFile: () => runtimeUrl })
    const language = await Language.load(languageUrl)
    const instance = new Parser()
    instance.setLanguage(language)
    return instance
  })().catch(error => { parserPromise = undefined; throw error })
  return parserPromise
}

self.onmessage = async (event: MessageEvent<{ id: number; source: string }>) => {
  const { id, source } = event.data
  try { self.postMessage({ id, result: convertCpp(await parser(), source) }) }
  catch (error) { self.postMessage({ id, result: previewError(`无法加载 C++ 解析器：${String(error)}`) }) }
}
