import * as Blockly from 'blockly'
import type { LibraryApi, LibraryExport } from './libraryApi.js'
import type { ProjectLibrary } from './libraryCatalog.js'
import { focusCppField } from './fieldFocus.js'
import { CppTextField } from './fieldFocus.js'
import { literalBlock } from './beginnerCatalog.js'
import type { PreviewBlock } from './types.js'
import { sourceIncludes } from '../ailyLibraryUsage.js'
import { prepareCppDropdown } from './dropdownUi.js'

export interface LibraryEntry { library: ProjectLibrary; api?: LibraryApi }
const catalogs = new WeakMap<Blockly.Workspace, LibraryEntry[]>()

export function setLibraryEntries(workspace: Blockly.Workspace, entries: LibraryEntry[]): void { catalogs.set(workspace, entries) }
export function libraryEntries(workspace: Blockly.Workspace): LibraryEntry[] {
  const svg = workspace as Blockly.WorkspaceSvg
  return catalogs.get(svg.targetWorkspace ?? workspace) ?? []
}
export function libraryMethodKey(item: LibraryExport): string { return `${item.header}\u0001${item.kind}\u0001${item.owner ?? ''}\u0001${item.signature}` }
export function libraryCallName(item: LibraryExport, receiver?: string): string {
  if (item.kind !== 'method') return item.name
  const owner = item.owner?.split('::').at(-1) ?? 'device'
  return `${receiver || item.receiver || owner[0]!.toLowerCase() + owner.slice(1)}.${item.name}`
}
export function libraryParameterValue(parameter: LibraryExport['parameters'][number]): string {
  const type = parameter.type.replace(/\b(?:const|volatile)\b/g, '').trim()
  if (/char\s*\*/.test(type) && /\bconst\b/.test(parameter.type)) return '""'
  if (/[&[(*]/.test(type)) return parameter.name
  if (type === 'bool') return 'false'
  if (/^(?:unsigned\s+|signed\s+)?(?:int|short|long(?:\s+long)?|char|size_t|u?int\d+_t|byte|word)$/.test(type)) return '0'
  if (/^(?:float|double)$/.test(type)) return '0.0'
  return parameter.name
}
export function libraryMethod(workspace: Blockly.Workspace, libraryId: string, key: string): LibraryExport | undefined {
  return libraryEntries(workspace).find(entry => entry.library.id === libraryId)?.api?.exports.find(item => libraryMethodKey(item) === key)
}
export function libraryBlockData(library: ProjectLibrary, item: LibraryExport, prior?: string | null): string {
  const origin = prior && !prior.startsWith('cpp-library-v1:') ? prior.split('\ncpp-library-v1:')[0] + '\n' : ''
  return origin + 'cpp-library-v1:' + JSON.stringify({ library: library.name, header: item.header, signature: item.signature })
}
export function annotateLibraryCalls(roots: PreviewBlock[], source: string, entries: LibraryEntry[]): boolean {
  const headers = new Set(sourceIncludes(source).map(include => include.header))
  let changed = false
  const visit = (block: PreviewBlock): void => {
    if (block.type === 'cpp_preview_call' && block.fields?.NAME) {
      const count = block.extraState?.count ?? 0
      const candidates = entries.flatMap(entry => (entry.api?.exports ?? []).filter(item =>
        (item.kind === 'function' || item.kind === 'method') && headers.has(item.header) && libraryCallName(item) === block.fields?.NAME &&
        item.parameters.filter(p => p.defaultValue === undefined).length <= count && count <= item.parameters.length
      ).map(item => ({ entry, item })))
      if (candidates.length === 1) {
        const { entry, item } = candidates[0]!
        block.type = 'cpp_preview_library_call'
        block.fields = { ...block.fields, LIBRARY: entry.library.id, METHOD: libraryMethodKey(item), RECEIVER: item.kind === 'method' ? block.fields.NAME.replace(/\.[^.]+$/, '') : '' }
        block.data = libraryBlockData(entry.library, item, block.data)
        changed = true
      }
    }
    for (const input of Object.values(block.inputs ?? {})) visit(input.block)
    if (block.next) visit(block.next.block)
  }
  roots.forEach(visit)
  return changed
}
function updateLibraryCall(block: Blockly.Block): void {
  if (block.type !== 'cpp_preview_library_call' || block.workspace.getBlockById(block.id) !== block) return
  const id = String(block.getFieldValue('LIBRARY') ?? '')
  const entry = libraryEntries(block.workspace).find(candidate => candidate.library.id === id)
  const methods = entry?.api?.exports.filter(item => item.kind === 'function' || item.kind === 'method') ?? []
  let item = methods.find(method => libraryMethodKey(method) === block.getFieldValue('METHOD'))
  if (!item && methods.length) { item = methods[0]; block.getField('METHOD')?.setValue(libraryMethodKey(item!)); return }
  if (!item || !entry) return
  const priorMetadata = block.data?.split('cpp-library-v1:').at(-1)
  let changedMethod = false
  if (priorMetadata) {
    try {
      const previous = JSON.parse(priorMetadata)
      changedMethod = previous.library !== entry.library.name || previous.header !== item.header || previous.signature !== item.signature
    } catch { /* Older projections may only contain their source identity. */ }
  }
  const receiverField = block.getField('RECEIVER')
  const receiverVisible = item.kind === 'method'
  const visibilityChanged = receiverField?.isVisible() !== receiverVisible
  receiverField?.setVisible(receiverVisible)
  block.getField('RECEIVER_LABEL')?.setVisible(receiverVisible)
  if (receiverVisible && !receiverField?.getValue()) receiverField?.setValue(libraryCallName(item).replace(/\.[^.]+$/, ''))
  const name = libraryCallName(item, receiverVisible ? String(receiverField?.getValue() ?? '') : undefined)
  block.getField('NAME')?.setValue(name)
  block.data = libraryBlockData(entry.library, item, block.data)
  const dynamic = block as Blockly.Block & { argumentCount?: number; parameterLabels?: string[] }
  const priorCount = dynamic.argumentCount ?? 0
  // Loading a known call must preserve explicitly supplied optional arguments.
  const required = item.parameters.filter(parameter => parameter.defaultValue === undefined).length
  const count = changedMethod ? Math.max(required, Math.min(priorCount, item.parameters.length)) : priorCount
  const labels = item.parameters.slice(0, count).map(parameter => parameter.name)
  if (count !== priorCount || JSON.stringify(labels) !== JSON.stringify(dynamic.parameterLabels)) {
    const oldState = JSON.stringify(block.saveExtraState?.())
    // Removed arguments are part of the same undoable method change, never loose roots.
    for (let i = count; i < priorCount; i++) block.getInputTargetBlock(`ARG${i}`)?.dispose(false)
    block.loadExtraState?.({ count, parameters: labels })
    const newState = JSON.stringify(block.saveExtraState?.())
    if (changedMethod && oldState !== newState) Blockly.Events.fire(new Blockly.Events.BlockChange(block, 'mutation', null, oldState, newState))
    for (let i = priorCount; i < count; i++) {
      const connection = block.getInput(`ARG${i}`)?.connection
      if (connection && !connection.targetBlock()) {
        const child = Blockly.serialization.blocks.append(literalBlock(libraryParameterValue(item.parameters[i]!)), block.workspace, { recordUndo: true })
        connection.connect(child.outputConnection!)
      }
    }
  }
  if (visibilityChanged && (block as Blockly.BlockSvg).rendered) (block as Blockly.BlockSvg).render()
}

function scheduleLibraryUpdate(block: Blockly.Block): void {
  const group = Blockly.Events.getGroup(), recordUndo = Blockly.Events.getRecordUndo()
  queueMicrotask(() => {
    const previous = Blockly.Events.getGroup(), previousUndo = Blockly.Events.getRecordUndo()
    Blockly.Events.setGroup(group); Blockly.Events.setRecordUndo(recordUndo)
    try { updateLibraryCall(block) } finally { Blockly.Events.setGroup(previous); Blockly.Events.setRecordUndo(previousUndo) }
  })
}

class LibraryDropdown extends Blockly.FieldDropdown {
  override setValue(value: string, fireChangeEvent?: boolean): void {
    const previous = Blockly.Events.getGroup()
    Blockly.Events.setGroup(previous || true)
    try { super.setValue(value, fireChangeEvent) } finally { Blockly.Events.setGroup(previous) }
  }

}

export class CppLibraryField extends LibraryDropdown {
  constructor() {
    super(function(this: Blockly.FieldDropdown) {
      const block = this.getSourceBlock()
      const choices = (block ? libraryEntries(block.workspace) : []).map(entry => [entry.library.name, entry.library.id] as [string, string])
      const current = this.getValue()
      if (current && !choices.some(([, id]) => id === current)) choices.unshift([current, current])
      return choices.length ? choices : [['选择项目库', current || '']]
    })
  }
  protected override doClassValidation_(value: string): string | null { return typeof value === 'string' ? value : null }
  protected override showEditor_(e?: MouseEvent): void { super.showEditor_(e); prepareCppDropdown(this); focusCppField(this) }
  protected override doValueUpdate_(value: string): void { this.value_ = value; this.getOptions(false); super.doValueUpdate_(value); const block = this.getSourceBlock(); if (block) scheduleLibraryUpdate(block) }
}

export class CppLibraryMethodField extends LibraryDropdown {
  constructor() {
    super(function(this: Blockly.FieldDropdown) {
      const block = this.getSourceBlock()
      const library = String(block?.getFieldValue('LIBRARY') ?? '')
      const methods = block ? libraryEntries(block.workspace).find(entry => entry.library.id === library)?.api?.exports.filter(item => item.kind === 'function' || item.kind === 'method') ?? [] : []
      const choices = methods.map(item => [item.signature.replace(/\s+/g, ' ').slice(0, 100), libraryMethodKey(item)] as [string, string])
      const current = this.getValue()
      if (current && !choices.some(([, key]) => key === current)) choices.unshift([String(block?.getFieldValue('NAME') ?? current), current])
      return choices.length ? choices : [['选择方法', current || '']]
    })
  }
  protected override doClassValidation_(value: string): string | null { return typeof value === 'string' ? value : null }
  protected override showEditor_(e?: MouseEvent): void { super.showEditor_(e); prepareCppDropdown(this); focusCppField(this) }
  protected override doValueUpdate_(value: string): void { this.value_ = value; this.getOptions(false); super.doValueUpdate_(value); const block = this.getSourceBlock(); if (block) scheduleLibraryUpdate(block) }
}

export class CppLibraryReceiverField extends CppTextField {
  protected override doValueUpdate_(value: string): void {
    super.doValueUpdate_(value)
    const block = this.getSourceBlock()
    if (block) scheduleLibraryUpdate(block)
  }
}
