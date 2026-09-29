import * as Blockly from 'blockly'
import { cppTypeOptions } from './declarationTypes.js'
import { focusCppField } from './fieldFocus.js'
import { prepareCppDropdown } from './dropdownUi.js'

export class CppTypeField extends Blockly.FieldDropdown {
  constructor() {
    super(function(this: Blockly.FieldDropdown) {
      const current = this.getValue()
      return current && !cppTypeOptions.some(([, value]) => value === current)
        ? [[`源码类型 (${current})`, current], ...cppTypeOptions]
        : current === '' ? [['原文 / 沿用外层类型', ''], ...cppTypeOptions] : cppTypeOptions
    })
    this.setValue('')
  }
  // Importing an arbitrary C++ typedef must not coerce it to the first option.
  protected override showEditor_(e?: MouseEvent): void { super.showEditor_(e); prepareCppDropdown(this); focusCppField(this) }
  protected override doClassValidation_(value: string): string | null {
    return typeof value === 'string' && value !== '---' ? value : null
  }
  protected override doValueUpdate_(value: string): void {
    // Blockly caches generated options. Refresh against the incoming type before
    // it selects the display label, including arbitrary types from new libraries.
    this.value_ = value
    this.getOptions(false)
    super.doValueUpdate_(value)
    // A comma-separated declaration shares its outer type; do not offer a
    // second type inside one declarator (which would produce invalid C++).
    this.setVisible(value !== '')
  }
  static override fromJson(): CppTypeField { return new CppTypeField() }
}
