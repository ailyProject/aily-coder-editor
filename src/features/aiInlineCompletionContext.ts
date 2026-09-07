import type { CloudCompletionRequest } from './aiInlineCompletionCloudTransport'

export interface InlineCompletionContextDocument {
  uri: string
  languageId: string
  relativePath?: string
  text: string
}

export interface InlineCompletionContextInput {
  active: InlineCompletionContextDocument & { offset: number }
  documents: readonly InlineCompletionContextDocument[]
  beforeMax?: number
  afterMax?: number
}

const SNIPPET_MAX = 2000
const CONTEXT_COUNT_MAX = 3
const DOCUMENT_MAX = 300_000
const SOURCE_EXTENSIONS = /\.(?:[cm]?[jt]sx?|[ch](?:pp|xx|\+\+)?|cc|hh|ino|py|rs|go|java|kt|kts|cs|swift|m|mm|php|rb|lua|dart|vue|svelte|gd|glsl|hlsl|vert|frag|sh|bash|zsh)$/i
const EXCLUDED_PATH = /(?:^|\/)(?:node_modules|libraries|vendor|dist|build|target|generated|\.build|\.pio|\.git|\.cache|\.venv|venv|__pycache__)(?:\/|$)|(?:^|\/)(?:\.env(?:\.|$)|credentials(?:\.|$)|secrets?(?:\.|$)|id_rsa(?:\.|$))|(?:\.min|\.generated)\.[^/]+$/i
const COMMON_WORDS = new Set(`abstract and any argument arguments as assert async auto await bool boolean break byte case catch char class const constructor continue constexpr default def delete do double else end enum error except export extends false final finally float for from function get if implements import in include int interface is let long namespace new none not null nullptr number object of or override package pass print private protected public raise readonly register return self set short signed sizeof static string struct super switch template this throw true try typedef typename typeof undefined union unsigned using var virtual void volatile while with yield setup loop arduino serial pinmode digitalwrite digitalread analogread analogwrite delay println begin end data value values result results state options config context input output name length index count args temp test log read write`.split(/\s+/))

function normalizedPath(document: InlineCompletionContextDocument): string {
  const value = document.relativePath ?? document.uri.replace(/^file:\/\/(?:localhost)?/i, '')
  try {
    return decodeURIComponent(value).replace(/\\/g, '/').replace(/^\.\//, '')
  } catch {
    return value.replace(/\\/g, '/').replace(/^\.\//, '')
  }
}

function isSource(document: InlineCompletionContextDocument): boolean {
  const path = normalizedPath(document)
  return /^file:\/\//i.test(document.uri)
    && SOURCE_EXTENSIONS.test(path)
    && !EXCLUDED_PATH.test(path)
    && document.text.length <= DOCUMENT_MAX
    && !document.text.includes('\0')
}

function languageFamily(languageId: string): string {
  if (['c', 'cpp', 'objective-c', 'objective-cpp', 'arduino'].includes(languageId)) return 'c'
  if (['javascript', 'javascriptreact', 'typescript', 'typescriptreact', 'vue', 'svelte'].includes(languageId)) return 'javascript'
  return languageId
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

function stem(path: string): string {
  return path.replace(/\.[^/.]+$/, '')
}

function pathWithoutParents(path: string): string {
  const parts: string[] = []
  for (const part of path.split('/')) {
    if (part === '..') parts.pop()
    else if (part && part !== '.') parts.push(part)
  }
  return parts.join('/')
}

function importedPaths(text: string): string[] {
  const paths: string[] = []
  const imports = /#\s*include\s*[<"]([^>"\r\n]+)[>"]|\b(?:from|import)\s*['"]([^'"\r\n]+)['"]|\b(?:require|import)\s*\(\s*['"]([^'"\r\n]+)['"]\s*\)/g
  for (const match of text.matchAll(imports)) {
    const path = match[1] ?? match[2] ?? match[3]
    if (path) paths.push(path.replace(/\\/g, '/'))
  }
  return paths
}

function isImported(candidatePath: string, activePath: string, imports: readonly string[]): boolean {
  const candidate = stem(pathWithoutParents(candidatePath))
  const activeDirectory = activePath.slice(0, activePath.lastIndexOf('/') + 1)
  return imports.some((path) => {
    const imported = stem(pathWithoutParents(path.startsWith('.') ? `${activeDirectory}${path}` : path))
    return candidate === imported || candidate.endsWith(`/${imported}`)
  })
}

function cursorSymbols(text: string, offset: number): Map<string, number> {
  const start = Math.max(0, offset - 1800)
  const nearby = text.slice(start, offset + 600)
  const symbols = new Map<string, number>()
  for (const match of nearby.matchAll(/[A-Za-z_$][\w$]*/g)) {
    const symbol = match[0].toLowerCase()
    if (symbol.length < 3 || COMMON_WORDS.has(symbol)) continue
    const distance = Math.abs(start + match.index - offset)
    const weight = distance <= 400 ? 3 : 1
    symbols.set(symbol, Math.max(symbols.get(symbol) ?? 0, weight))
  }
  return symbols
}

type SymbolMatch = { offset: number; symbol: string; weight: number }

function lineStart(text: string, offset: number): number {
  if (offset <= 0) return 0
  const start = text.lastIndexOf('\n', offset - 1) + 1
  // A very long source line must not pull a distant matching symbol out of the window.
  return offset - start <= 500 ? start : offset
}

function snippetAt(text: string, start: number, maximum: number): string {
  const end = Math.min(text.length, start + maximum)
  // Retain complete lines when possible, without changing their indentation.
  const newline = text.lastIndexOf('\n', end - 1)
  return text.slice(start, end < text.length && newline > start ? newline + 1 : end)
}

function bestWindow(text: string, symbols: ReadonlyMap<string, number>): { text: string; score: number; overlaps: number; strongOverlap: boolean } {
  const matches: SymbolMatch[] = []
  for (const match of text.matchAll(/[A-Za-z_$][\w$]*/g)) {
    const symbol = match[0].toLowerCase()
    const weight = symbols.get(symbol)
    if (weight) matches.push({ offset: match.index, symbol, weight })
  }

  // Starts are monotonic, so the moving window visits every match at most twice.
  const starts = new Set([0, ...matches.map((match) => lineStart(text, Math.max(0, match.offset - 500)))])
  let left = 0
  let right = 0
  const counts = new Map<string, number>()
  let score = 0
  let best = { text: snippetAt(text, 0, SNIPPET_MAX), score: 0, overlaps: 0, strongOverlap: false }
  for (const start of starts) {
    const snippet = snippetAt(text, start, SNIPPET_MAX)
    const end = start + snippet.length
    while (right < matches.length && matches[right]!.offset < end) {
      const match = matches[right++]!
      const count = counts.get(match.symbol) ?? 0
      if (count === 0) score += match.weight
      counts.set(match.symbol, count + 1)
    }
    while (left < right && matches[left]!.offset < start) {
      const match = matches[left++]!
      const count = counts.get(match.symbol)! - 1
      if (count === 0) {
        counts.delete(match.symbol)
        score -= match.weight
      } else counts.set(match.symbol, count)
    }
    if (score > best.score) {
      best = { text: snippet, score, overlaps: counts.size, strongOverlap: [...counts.keys()].some((symbol) => symbol.length >= 5) }
    }
  }
  return best
}

function budget(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : fallback
}

function headerSnippet(text: string): string {
  // Large license banners should not displace imports and global declarations.
  const trivia = /\s+|\/\/[^\r\n]*(?:\r?\n|$)|\/\*[\s\S]*?\*\//y
  let start = 0
  while (start < text.length) {
    trivia.lastIndex = start
    if (!trivia.exec(text)) break
    start = trivia.lastIndex
  }
  const beginningOfLine = text.lastIndexOf('\n', start - 1) + 1
  if (!text.slice(beginningOfLine, start).trim()) start = beginningOfLine
  return snippetAt(text, start, SNIPPET_MAX)
}

/** Select actual code relevant to the cursor; all returned text is an unchanged document slice. */
export function buildInlineCompletionContext(input: InlineCompletionContextInput): Pick<CloudCompletionRequest, 'prefix' | 'suffix' | 'context'> {
  const { active } = input
  const offset = Math.min(active.text.length, budget(active.offset, 0))
  const prefixStart = Math.max(0, offset - budget(input.beforeMax, 12_000))
  const prefix = active.text.slice(prefixStart, offset)
  const suffix = active.text.slice(offset, offset + budget(input.afterMax, 4000))
  const context: CloudCompletionRequest['context'] = []
  const symbols = cursorSymbols(active.text, offset)
  const activePath = normalizedPath(active)

  if (prefixStart > 0 && isSource(active)) {
    // Imports and global declarations are otherwise lost when a large file's prefix is clipped.
    const header = headerSnippet(active.text.slice(0, prefixStart))
    if (/\w/.test(header)) context.push({ kind: 'snippet', languageId: active.languageId, relativePath: active.relativePath, text: header })
  }

  const imports = importedPaths(`${active.text.slice(0, 12_000)}\n${prefix}`)
  const seen = new Set([active.uri])
  const candidates: Array<{ document: InlineCompletionContextDocument; text: string; score: number; order: number }> = []
  for (const [order, document] of input.documents.entries()) {
    if (seen.has(document.uri) || !isSource(document)) continue
    seen.add(document.uri)
    const path = normalizedPath(document)
    const imported = isImported(path, activePath, imports)
    const sameLanguage = languageFamily(document.languageId) === languageFamily(active.languageId)
    if (!imported && !sameLanguage) continue
    const pairedHeader = sameLanguage && /\.(?:h|hh|hpp|hxx)$/i.test(path) && stem(basename(path)) === stem(basename(activePath))
    const window = bestWindow(document.text, symbols)
    if (!imported && !pairedHeader && window.overlaps < 2 && !window.strongOverlap) continue
    if (!window.text.trim()) continue
    candidates.push({ document, text: window.text, score: (imported ? 100 : 0) + (pairedHeader ? 60 : 0) + window.score, order })
  }
  candidates.sort((a, b) => b.score - a.score || a.order - b.order)
  for (const candidate of candidates.slice(0, CONTEXT_COUNT_MAX - context.length)) {
    context.push({ kind: 'snippet', languageId: candidate.document.languageId, relativePath: candidate.document.relativePath, text: candidate.text })
  }
  return { prefix, suffix, context }
}
