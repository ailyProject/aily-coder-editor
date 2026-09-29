import * as Blockly from 'blockly'
import { codeOptions, coreCall, signatureLabel } from './beginnerCatalog.js'
import { focusCppField } from './fieldFocus.js'
import { prepareCppDropdown } from './dropdownUi.js'

export class CppOptionsField extends Blockly.FieldDropdown {
  constructor(kind: string) {
    super(function(this: Blockly.FieldDropdown) { return codeOptions(kind, this.getValue() ?? '') })
  }
  protected override doClassValidation_(value: string): string | null { return typeof value === 'string' ? value : null }
  protected override showEditor_(e?: MouseEvent): void { super.showEditor_(e); prepareCppDropdown(this); focusCppField(this) }
  protected override doValueUpdate_(value: string): void {
    this.value_ = value; this.getOptions(false); super.doValueUpdate_(value)
    const block = this.getSourceBlock()
    if (block?.type === 'cpp_preview_action') updateActionLabels(block, value)
  }
  static override fromJson(options: Blockly.FieldDropdownFromJsonConfig & { cppKind?: string }): CppOptionsField {
    return new CppOptionsField(options.cppKind ?? 'operator')
  }
}

export class CppSignatureField extends Blockly.FieldTextInput {
  protected override showEditor_(e?: Event, quietInput?: boolean, manageEphemeralFocus?: boolean): void {
    super.showEditor_(e, quietInput, manageEphemeralFocus); focusCppField(this)
  }
  protected override getText_(): string { return signatureLabel(this.getValue() ?? '') }
  static override fromJson(options: Blockly.FieldTextInputFromJsonConfig): CppSignatureField { return new CppSignatureField(options.text ?? '') }
}

export function updateActionLabels(block: Blockly.Block, name = String(block.getFieldValue('NAME'))): void {
  const spec = coreCall(name)
  for (const input of block.inputList) {
    const index = /^ARG(\d+)$/.exec(input.name)?.[1]
    if (index !== undefined) block.getField(`LABEL${index}`)?.setValue(spec?.parameters[Number(index)] ?? `参数 ${Number(index) + 1}`)
  }
  block.getField('SUFFIX')?.setValue(spec?.suffix ?? '')
  block.setTooltip(spec ? `${spec.help}\nC++：${spec.name}` : `调用 ${name}`)
}
