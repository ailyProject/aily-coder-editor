import type { PreviewBlock } from './types.js'

export interface RebasedProjection {
  view: PreviewBlock[]
  sourceIds: Map<string, string>
}

/** Reattach a saved source projection without recreating the visible blocks. */
export function rebaseProjection(visible: PreviewBlock[], parsed: PreviewBlock[]): RebasedProjection | undefined {
  const view = structuredClone(visible)
  const sourceIds = new Map<string, string>()
  const chain = (block?: PreviewBlock): PreviewBlock[] => {
    const result: PreviewBlock[] = []
    for (let item = block; item; item = item.next?.block) result.push(item)
    return result
  }
  const match = (left: PreviewBlock[], right: PreviewBlock[]): boolean => {
    if (left.length !== right.length) return false
    for (let i = 0; i < left.length; i++) {
      const current = left[i]!, source = right[i]!
      const pendingLibrary = current.type === 'cpp_preview_library_call' && source.type === 'cpp_preview_call' && current.fields?.NAME === source.fields?.NAME
      if ((!pendingLibrary && current.type !== source.type) || current.extraState?.count !== source.extraState?.count) return false
      const inputs = Object.keys(current.inputs ?? {}).sort()
      if (JSON.stringify(inputs) !== JSON.stringify(Object.keys(source.inputs ?? {}).sort())) return false
      const fields = Object.keys(current.fields ?? {}).sort()
      if (!pendingLibrary && JSON.stringify(fields) !== JSON.stringify(Object.keys(source.fields ?? {}).sort())) return false
      sourceIds.set(current.id, source.id)
      if (pendingLibrary) {
        const marker = current.data?.indexOf('cpp-library-v1:') ?? -1
        const metadata = marker < 0 ? '' : current.data!.slice(marker)
        current.data = metadata ? source.data ? `${source.data}\n${metadata}` : metadata : source.data
      } else {
        current.data = source.data
        current.fields = source.fields ? {...source.fields} : undefined
      }
      for (const name of inputs) {
        if (!match(chain(current.inputs![name]!.block), chain(source.inputs![name]!.block))) return false
      }
    }
    return true
  }
  return match(view.flatMap(chain), parsed.flatMap(chain)) ? { view, sourceIds } : undefined
}
