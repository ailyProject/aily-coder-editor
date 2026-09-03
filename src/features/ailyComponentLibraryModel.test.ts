import assert from 'node:assert/strict'
import test from 'node:test'
import {
  normalizeLibraryLanguage,
} from './ailyComponentLibraryModel.js'

test('normalizes the language codes used by the host and VS Code packs', () => {
  assert.equal(normalizeLibraryLanguage('zh_cn'), 'zh_cn')
  assert.equal(normalizeLibraryLanguage('zh-Hant'), 'zh_hk')
  assert.equal(normalizeLibraryLanguage('pt-BR'), 'pt')
  assert.equal(normalizeLibraryLanguage('ar'), 'ar')
  assert.equal(normalizeLibraryLanguage('unknown'), 'en')
})
