import assert from 'node:assert/strict'
import test from 'node:test'
import { RepeatedWordHistory, type RepeatedWordChange, type RepeatedWordOrigin } from './repeatedWordHistory'

function editor(initial: string, file = 'main.cpp') {
  const history = new RepeatedWordHistory()
  let text = initial
  let now = 1_000
  return {
    history,
    get text() { return text },
    edit(offset: number, length: number, replacement: string, origin: RepeatedWordOrigin = 'typing', pause = 10) {
      const after = text.slice(0, offset) + replacement + text.slice(offset + length)
      now += pause
      history.observe(file, text, after, [{ rangeOffset: offset, rangeLength: length, text: replacement }], origin, now)
      text = after
    },
    suggest(offset: number, selection?: { start: number; end: number }, delay = 0) {
      return history.suggest(file, text, offset, selection, now + delay)
    },
  }
}

test('selected whole-word replacement aggregates each typed letter, including pauses', () => {
  const state = editor('oldWord + oldWord + oldWord')
  state.edit(0, 7, 'n')
  state.edit(1, 0, 'e', 'typing', 5_000)
  state.edit(2, 0, 'w', 'typing', 15_000)
  state.edit(3, 0, 'W')
  state.edit(4, 0, 'o')
  state.edit(5, 0, 'r')
  state.edit(6, 0, 'd')
  assert.deepEqual(state.suggest(state.text.indexOf('oldWord') + 3), {
    rangeOffset: 10, rangeLength: 7, expectedText: 'oldWord', newText: 'newWord',
  })
})

test('partial middle and suffix edits preserve the original whole word', () => {
  const state = editor('colour + colour')
  state.edit(4, 1, '')
  assert.equal(state.suggest(state.text.lastIndexOf('colour'))?.newText, 'color')
  state.edit(5, 0, 'Value')
  assert.deepEqual(state.suggest(state.text.lastIndexOf('colour')), {
    rangeOffset: 13, rangeLength: 6, expectedText: 'colour', newText: 'colorValue',
  })
})

test('backspacing to an empty replacement never suggests deletion, then learns the full new word', () => {
  const state = editor('value + value')
  for (let offset = 4; offset >= 0; offset--) state.edit(offset, 1, '')
  assert.equal(state.suggest(state.text.indexOf('value')), undefined)
  state.edit(0, 0, 'c', 'typing', 10_000)
  state.edit(1, 0, 'ount')
  assert.equal(state.suggest(state.text.lastIndexOf('value'))?.newText, 'count')
})

test('whole selected deletion followed by typing restores the pending original word', () => {
  const state = editor('first + first')
  state.edit(0, 5, '')
  assert.equal(state.suggest(state.text.lastIndexOf('first')), undefined)
  state.edit(0, 0, 'second')
  assert.equal(state.suggest(state.text.lastIndexOf('first'))?.newText, 'second')
})

test('typing a separator after deleting a word cancels the pending rename', () => {
  const state = editor('first + first')
  state.edit(0, 5, '')
  state.edit(0, 0, ' ')
  state.edit(1, 0, 'second')
  assert.equal(state.suggest(state.text.lastIndexOf('first')), undefined)
})

test('word start, interior, end and exact selection hit only the clicked occurrence', () => {
  const state = editor('old + old + old')
  state.edit(0, 3, 'longReplacement')
  const start = state.text.indexOf('old')
  for (const offset of [start, start + 1, start + 3]) {
    assert.equal(state.suggest(offset)?.rangeOffset, start)
    assert.equal(state.suggest(offset, { start, end: start + 3 })?.newText, 'longReplacement')
  }
  assert.equal(state.suggest(start + 1, { start, end: start + 2 }), undefined)
  assert.equal(state.suggest(start + 1, { start, end: state.text.length }), undefined)
  assert.equal(state.suggest(start + 1, { start: -1, end: 5 }), undefined)
  assert.equal(state.suggest(start + 4), undefined)
  assert.equal(state.suggest(state.text.lastIndexOf('old'))?.rangeOffset, state.text.lastIndexOf('old'))
})

test('only complete original words match, including identifiers with Unicode and dollar prefixes', () => {
  for (const original of ['name', '_name2', '$name', '变量', '𐐀name']) {
    const state = editor(`${original} ${original} ${original}Suffix prefix${original}`)
    state.edit(0, original.length, 'replacement')
    assert.equal(state.suggest(state.text.indexOf(original))?.newText, 'replacement', original)
    assert.equal(state.suggest(state.text.indexOf(`${original}Suffix`) + 1), undefined, original)
    assert.equal(state.suggest(state.text.indexOf(`prefix${original}`) + 6), undefined, original)
  }
})

test('UTF-16 positions stay exact after emoji and astral word characters', () => {
  const state = editor('😀 𐐀count 𐐀count')
  state.edit(3, 7, '𐐀total')
  assert.deepEqual(state.suggest(13), { rangeOffset: 11, rangeLength: 7, expectedText: '𐐀count', newText: '𐐀total' })
})

test('typing separators around the source shifts its anchor without changing the replacement', () => {
  const state = editor('old + old')
  state.edit(0, 3, 'new')
  state.edit(0, 0, '(')
  state.edit(4, 0, ')')
  state.edit(4, 0, 'Value')
  assert.equal(state.suggest(state.text.lastIndexOf('old'))?.newText, 'newValue')
})

test('source position updates when edits occur before it', () => {
  const state = editor('prefix old + old')
  state.edit(7, 3, 'new')
  state.edit(0, 0, '// comment\n')
  state.edit(state.text.indexOf('new') + 3, 0, 'Value')
  assert.equal(state.suggest(state.text.lastIndexOf('old'))?.newText, 'newValue')
})

test('the latest manual replacement of another original occurrence supersedes the earlier intent', () => {
  const state = editor('old + old + old')
  state.edit(0, 3, 'first')
  state.edit(state.text.indexOf('old'), 3, 'second')
  assert.equal(state.suggest(state.text.lastIndexOf('old'))?.newText, 'second')
})

test('manually restoring the original source cancels the intention', () => {
  const state = editor('old + old')
  state.edit(0, 3, 'new')
  state.edit(0, 3, 'old')
  assert.equal(state.suggest(state.text.lastIndexOf('old')), undefined)
})

test('accepting a second occurrence as an AI completion preserves the manual mapping for the third', () => {
  const state = editor('old + old + old')
  state.edit(0, 3, 'newWord')
  state.edit(state.text.indexOf('old'), 3, 'newWord', 'completion')
  assert.deepEqual(state.suggest(state.text.lastIndexOf('old')), {
    rangeOffset: 20, rangeLength: 3, expectedText: 'old', newText: 'newWord',
  })
})

test('AI-only edits never teach a new mapping and changing the manual source invalidates its intention', () => {
  const state = editor('old + old + generated')
  state.edit(0, 3, 'new')
  state.edit(0, 3, 'generated', 'completion')
  assert.equal(state.suggest(state.text.indexOf('old')), undefined)
  assert.equal(state.suggest(state.text.lastIndexOf('generated')), undefined)
  const aiOnly = editor('old + old')
  aiOnly.edit(0, 3, 'new', 'completion')
  assert.equal(aiOnly.suggest(aiOnly.text.lastIndexOf('old')), undefined)
})

test('cut does not teach a replacement and invalidates a cut manual source', () => {
  const state = editor('old + old')
  state.edit(0, 3, '', 'cut')
  state.edit(0, 0, 'new')
  assert.equal(state.suggest(state.text.lastIndexOf('old')), undefined)
  const renamed = editor('old + old')
  renamed.edit(0, 3, 'new')
  renamed.edit(0, 3, '', 'cut')
  assert.equal(renamed.suggest(renamed.text.lastIndexOf('old')), undefined)
})

for (const origin of ['undo', 'redo', 'external'] as const) {
  test(`${origin} clears file intent without learning the change`, () => {
    const state = editor('old + old')
    state.edit(0, 3, 'new')
    state.edit(0, 3, 'other', origin)
    assert.equal(state.suggest(state.text.lastIndexOf('old')), undefined)
  })
}

test('pasting an explicit single-word replacement teaches it; ordinary insertion does not', () => {
  const replacement = editor('old + old')
  replacement.edit(0, 3, 'new', 'paste')
  assert.equal(replacement.suggest(replacement.text.lastIndexOf('old'))?.newText, 'new')
  const insertion = editor('old + old')
  insertion.edit(0, 0, 'new', 'paste')
  assert.equal(insertion.suggest(insertion.text.lastIndexOf('old')), undefined)
})

test('numbers, punctuation, whitespace and multi-word replacement are excluded', () => {
  for (const [before, after] of [['123', '456'], ['_', '__'], ['old', ' '], ['old', '42'], ['old', 'two words'], ['old', 'new\nline'], ['two words', 'single'], ['old', 'word-name']]) {
    const state = editor(`${before} + ${before}`)
    state.edit(0, before!.length, after!)
    assert.equal(state.suggest(state.text.lastIndexOf(before!)), undefined, `${before} => ${after}`)
  }
})

test('multi-range edits update source offsets without manufacturing rename mappings', () => {
  const history = new RepeatedWordHistory()
  history.observe('file', 'a old old z', 'a new old z', [{ rangeOffset: 2, rangeLength: 3, text: 'new' }], 'typing', 10)
  const changes: RepeatedWordChange[] = [{ rangeOffset: 10, rangeLength: 1, text: 'suffix' }, { rangeOffset: 0, rangeLength: 1, text: 'prefix' }]
  history.observe('file', 'a new old z', 'prefix new old suffix', changes, 'typing', 20)
  assert.equal(history.suggest('file', 'prefix new old suffix', 11, undefined, 30)?.newText, 'new')
  assert.equal(history.suggest('file', 'prefix new old suffix', 0, undefined, 30), undefined)
})

test('file scope, expiry, clock rollback, document close and session clear isolate intents', () => {
  const history = new RepeatedWordHistory()
  const learn = (file: string, at: number) => history.observe(file, 'old old', 'new old', [{ rangeOffset: 0, rangeLength: 3, text: 'new' }], 'typing', at)
  learn('a', 100)
  assert.equal(history.suggest('b', 'new old', 4, undefined, 101), undefined)
  assert.equal(history.suggest('a', 'new old', 4, undefined, 60_100)?.newText, 'new')
  assert.equal(history.suggest('a', 'new old', 4, undefined, 60_101), undefined)
  learn('a', 100)
  assert.equal(history.suggest('a', 'new old', 4, undefined, 99), undefined)
  learn('a', 100)
  learn('b', 101)
  history.forget('a')
  assert.equal(history.suggest('a', 'new old', 4, undefined, 102), undefined)
  assert.equal(history.suggest('b', 'new old', 4, undefined, 102)?.newText, 'new')
  history.clear()
  assert.equal(history.suggest('b', 'new old', 4, undefined, 103), undefined)
})

test('accepted AI edits do not extend the lifetime of a manual intention', () => {
  const state = editor('old old old')
  state.edit(0, 3, 'new')
  state.edit(4, 3, 'new', 'completion', 59_000)
  assert.equal(state.suggest(8, undefined, 1_001), undefined)
})

test('memory is bounded by recent files, intents and word length', () => {
  const history = new RepeatedWordHistory()
  for (let index = 0; index < 9; index++) history.observe(`file${index}`, 'old old', 'new old', [{ rangeOffset: 0, rangeLength: 3, text: 'new' }], 'typing', index)
  assert.equal(history.suggest('file0', 'new old', 4, undefined, 10), undefined)
  assert.equal(history.suggest('file8', 'new old', 4, undefined, 10)?.newText, 'new')
  const state = editor(Array.from({ length: 9 }, (_, index) => `word${index} word${index}`).join('\n'))
  for (let index = 0; index < 9; index++) state.edit(state.text.indexOf(`word${index}`), 5, `next${index}`)
  assert.equal(state.suggest(state.text.indexOf('word0')), undefined)
  assert.equal(state.suggest(state.text.indexOf('word8'))?.newText, 'next8')
  const oversized = editor('old old')
  oversized.edit(0, 3, 'n'.repeat(257))
  assert.equal(oversized.suggest(oversized.text.lastIndexOf('old')), undefined)
})

test('invalid change metadata or an unobserved source change cannot return stale partial text', () => {
  const history = new RepeatedWordHistory()
  history.observe('file', 'old old', 'n old', [{ rangeOffset: 0, rangeLength: 3, text: 'n' }], 'typing', 1)
  assert.equal(history.suggest('file', 'new old', 4, undefined, 2), undefined)
  assert.equal(history.suggest('file', 'n old', 2, undefined, 2), undefined)
  history.observe('file', 'n old', 'new old', [{ rangeOffset: -1, rangeLength: 0, text: 'ew' }], 'typing', 3)
  assert.equal(history.suggest('file', 'new old', 4, undefined, 4), undefined)
})
