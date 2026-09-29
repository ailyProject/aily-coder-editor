import * as Blockly from 'blockly'

const handlers = new WeakMap<Blockly.Workspace, (block: Blockly.Block, field: string) => void>()

export function onCppFieldFocus(workspace: Blockly.Workspace, handler: (block: Blockly.Block, field: string) => void): () => void {
  handlers.set(workspace, handler)
  return () => handlers.delete(workspace)
}

export function focusCppField(field: Blockly.Field): void {
  const block = field.getSourceBlock()
  if (block && field.name) handlers.get(block.workspace)?.(block, field.name)
}

export class CppTextField extends Blockly.FieldTextInput {
  protected override showEditor_(e?: Event, quietInput?: boolean, manageEphemeralFocus?: boolean): void {
    super.showEditor_(e, quietInput, manageEphemeralFocus)
    focusCppField(this)
  }
  static override fromJson(options: Blockly.FieldTextInputFromJsonConfig): CppTextField { return new CppTextField(options.text ?? '') }
}
