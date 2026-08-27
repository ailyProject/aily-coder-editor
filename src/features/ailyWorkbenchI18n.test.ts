import assert from 'node:assert/strict'
import test from 'node:test'
import { workbenchUiStrings } from './ailyWorkbenchI18n.js'

test('localizes custom sidebar and Git copy for simplified and traditional Chinese', () => {
  assert.equal(workbenchUiStrings('zh_cn').sidebar.search, '搜索')
  assert.equal(workbenchUiStrings('zh-HK').sidebar.sourceControl, '原始碼控制')
  assert.equal(workbenchUiStrings('zh_hk').git.changes, '變更')
  assert.equal(workbenchUiStrings('zh_hk').ailyView.library, '程式庫')
})

test('uses a localized sidebar and an English Git fallback for other host languages', () => {
  assert.equal(workbenchUiStrings('ja').sidebar.explorer, 'エクスプローラー')
  assert.equal(workbenchUiStrings('ja').ailyView.userView, 'ユーザービュー')
  assert.equal(workbenchUiStrings('fr').git.commit, 'Commit')
})
