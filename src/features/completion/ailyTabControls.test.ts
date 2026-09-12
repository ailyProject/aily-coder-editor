import assert from 'node:assert/strict'
import test from 'node:test'
import { AILY_TAB_KEYBINDINGS, AILY_TAB_SNOOZE_PRESETS, ailyTabInteractionBlocked, ailyTabSnoozeDeadline, ailyTabSnoozeRemaining, normalizeCompletionExtensions, toggleCompletionExtension } from './ailyTabControls'

test('pause presets are bounded, unique and render a useful remaining duration', () => {
  const durations = AILY_TAB_SNOOZE_PRESETS.map(item => item.durationMs)
  assert.deepEqual(durations, [300_000, 1_800_000, 3_600_000, 28_800_000])
  assert.equal(new Set(durations).size, durations.length)
  assert.equal(ailyTabSnoozeDeadline(1_000, durations[1]!), 1_801_000)
  assert.equal(ailyTabSnoozeRemaining(3_601_000, 1_000), '1 小时')
  assert.equal(ailyTabSnoozeRemaining(5_501_000, 1_000), '1 小时 32 分钟')
  assert.equal(ailyTabSnoozeRemaining(7_199_000, 0), '2 小时')
  assert.equal(ailyTabSnoozeRemaining(0, 1_000), '0 秒')
  assert.throws(() => ailyTabSnoozeDeadline(0, 1234), /Invalid/)
})

test('extension toggles restore disabled files despite case, dots or duplicates', () => {
  assert.deepEqual(normalizeCompletionExtensions(['CPP', '.Cpp', ' cpp ', '.py', '']), ['.cpp', '.py'])
  assert.deepEqual(toggleCompletionExtension(['CPP', '.Cpp', '.py'], '.cpp'), ['.py'])
  assert.deepEqual(toggleCompletionExtension(['.py'], 'CPP'), ['.py', '.cpp'])
  assert.deepEqual(toggleCompletionExtension(['.py'], ''), ['.py'])
})

test('custom keybindings never take ownership from IME, snippets or IntelliSense', () => {
  assert.ok(AILY_TAB_KEYBINDINGS.length >= 6)
  for (const binding of AILY_TAB_KEYBINDINGS) {
    assert.match(binding.when, /editorTextFocus/)
    assert.match(binding.when, /!isComposing/)
    assert.match(binding.when, /!inSnippetMode/)
    assert.match(binding.when, /!suggestWidgetVisible/)
  }
  assert.match(AILY_TAB_KEYBINDINGS.find(item => item.key === 'tab')!.when, /!editorTabMovesFocus/)
  assert.match(AILY_TAB_KEYBINDINGS.find(item => item.command === 'aily.completion.acceptLine')!.when, /inlineSuggestionVisible/)
  for (const key of ['isComposing', 'inSnippetMode', 'suggestWidgetVisible'] as const) {
    assert.equal(ailyTabInteractionBlocked({ [key]: true }), true, key)
  }
  assert.equal(ailyTabInteractionBlocked({}), false)
})
