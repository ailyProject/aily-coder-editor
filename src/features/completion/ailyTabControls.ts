export type AilyTabSnoozePreset = {
  label: string
  detail: string
  durationMs: number
}

export const AILY_TAB_SNOOZE_PRESETS: readonly AilyTabSnoozePreset[] = Object.freeze([
  { label: '5 分钟', detail: '短暂专注，之后自动恢复', durationMs: 5 * 60_000 },
  { label: '30 分钟', detail: '暂停半小时', durationMs: 30 * 60_000 },
  { label: '1 小时', detail: '暂停一小时', durationMs: 60 * 60_000 },
  { label: '8 小时', detail: '暂停到当前工作日结束', durationMs: 8 * 60 * 60_000 },
])

export function ailyTabSnoozeDeadline(now: number, durationMs: number): number {
  if (!Number.isFinite(now) || !AILY_TAB_SNOOZE_PRESETS.some(item => item.durationMs === durationMs)) {
    throw new Error('Invalid Aily Tab snooze duration')
  }
  return now + durationMs
}

export function ailyTabSnoozeRemaining(until: number, now = Date.now()): string {
  const remaining = Math.max(0, until - now)
  if (remaining < 60_000) return `${Math.max(1, Math.ceil(remaining / 1000))} 秒`
  if (remaining < 60 * 60_000) return `${Math.ceil(remaining / 60_000)} 分钟`
  const hours = Math.floor(remaining / (60 * 60_000))
  const minutes = Math.ceil((remaining - hours * 60 * 60_000) / 60_000)
  return minutes ? `${hours} 小时 ${minutes} 分钟` : `${hours} 小时`
}

export function ailyTabInteractionBlocked(state: { isComposing?: unknown; inSnippetMode?: unknown; suggestWidgetVisible?: unknown }): boolean {
  return Boolean(state.isComposing || state.inSnippetMode || state.suggestWidgetVisible)
}

const EDITOR_SAFE = 'editorTextFocus && !suggestWidgetVisible && !inSnippetMode && !isComposing'

/** Keep all custom completion shortcuts out of IME, snippets and IntelliSense. */
export const AILY_TAB_KEYBINDINGS = [
  { key: 'alt+\\', mac: 'alt+\\', command: 'aily.completion.trigger', when: EDITOR_SAFE },
  { key: 'ctrl+alt+right', mac: 'ctrl+cmd+right', command: 'aily.completion.acceptLine', when: `${EDITOR_SAFE} && inlineSuggestionVisible` },
  { key: 'ctrl+right', mac: 'cmd+right', command: 'aily.completion.acceptEditWord', when: `${EDITOR_SAFE} && ailyPartialEditAvailable && !inlineSuggestionVisible` },
  { key: 'ctrl+alt+right', mac: 'ctrl+cmd+right', command: 'aily.completion.acceptEditLine', when: `${EDITOR_SAFE} && ailyPartialEditAvailable && !inlineSuggestionVisible` },
  { key: 'tab', command: 'aily.completion.acceptEdit', when: `${EDITOR_SAFE} && ailyNextEditAvailable && !inlineSuggestionVisible && !editorTabMovesFocus` },
  { key: 'escape', command: 'aily.completion.rejectEdit', when: `${EDITOR_SAFE} && ailyNextEditAvailable` },
] as const
