import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { JSDOM } from 'jsdom'
import { librarySelectCss, librarySelectScript } from './librarySelectUi.ts'

function boot(body: string) {
  const dom = new JSDOM(`<!doctype html><html class="aily-selects"><head><style>${librarySelectCss}</style></head><body>${body}</body></html>`, {
    url: 'http://library-manager.test/',
    pretendToBeVisual: true,
    runScripts: 'dangerously',
  })
  const { window } = dom
  window.requestAnimationFrame = () => 1
  window.cancelAnimationFrame = () => undefined
  window.HTMLElement.prototype.scrollIntoView = () => undefined
  if (typeof window.ResizeObserver !== 'function') {
    window.ResizeObserver = class {
      observe(): void { /* layout stub */ }
      disconnect(): void { /* layout stub */ }
    } as typeof ResizeObserver
  }
  Object.defineProperty(window, 'visualViewport', { configurable: true, value: null })
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 400 })
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 600 })
  Object.defineProperty(window.HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get() { return this.classList.contains('aily-select-menu') ? 280 : 120 },
  })
  Object.defineProperty(window.HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get() { return this.classList.contains('aily-select-menu') ? 180 : 28 },
  })
  Object.defineProperty(window.HTMLElement.prototype, 'scrollHeight', {
    configurable: true,
    get() { return this.classList.contains('aily-select-menu') ? 180 : 0 },
  })
  const script = window.document.createElement('script')
  script.textContent = librarySelectScript
  window.document.body.append(script)
  return { dom, window }
}

function place(select: HTMLSelectElement, rect: { top: number; left: number; bottom: number; right: number; width: number; height: number }) {
  const box = { ...rect, x: rect.left, y: rect.top, toJSON: () => box }
  select.getBoundingClientRect = () => box
  select.getClientRects = () => ({ length: 1, item: () => box }) as unknown as DOMRectList
}

function pointer(window: JSDOM['window'], target: EventTarget) {
  target.dispatchEvent(new window.PointerEvent('pointerdown', { button: 0, bubbles: true, cancelable: true }))
}

function key(window: JSDOM['window'], target: EventTarget, value: string) {
  target.dispatchEvent(new window.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }))
}

function menu(window: JSDOM['window']): HTMLElement | null {
  return window.document.querySelector('.aily-select-menu')
}

test('library manager ships the shared select rules and keeps native select nodes', () => {
  assert.match(librarySelectCss, /field-sizing:\s*content/)
  assert.match(librarySelectCss, /max-width:\s*min\(100%,\s*var\(--select-max-width,\s*240px\)\)/)
  assert.match(librarySelectCss, /max-width:\s*min\(320px/)
  assert.match(librarySelectCss, /max-height:\s*260px/)
  assert.match(librarySelectCss, /border:\s*0/)
  assert.match(librarySelectCss, /outline:\s*none/)
  assert.match(librarySelectCss, /box-shadow:\s*none/)
  assert.match(librarySelectCss, /content:\s*'✓'/)
  const source = readFileSync(new URL('./ailyComponentLibraryView.ts', import.meta.url), 'utf8')
  assert.match(source, /librarySelectCss/)
  assert.match(source, /librarySelectScript/)
  assert.match(source, /<select id="type">/)
  assert.match(source, /<select id="category">/)
  assert.match(source, /document\.createElement\('select'\)/)
})

test('closed, focused and expanded selects have no border, outline or shadow', () => {
  const { window } = boot('<select id="type" aria-label="类型"><option>Communication</option><option>Signal Input/Output</option></select>')
  const select = window.document.querySelector('select')!
  const paint = () => window.getComputedStyle(select)
  assert.equal(paint().borderTopWidth, '0px')
  assert.equal(paint().outlineStyle, 'none')
  assert.equal(paint().boxShadow, 'none')
  select.focus()
  assert.equal(paint().borderTopWidth, '0px')
  assert.equal(paint().outlineStyle, 'none')
  assert.equal(paint().boxShadow, 'none')
  place(select, { top: 40, left: 24, bottom: 68, right: 180, width: 156, height: 28 })
  pointer(window, select)
  assert.equal(select.getAttribute('aria-expanded'), 'true')
  assert.equal(paint().borderTopWidth, '0px')
  assert.equal(paint().outlineStyle, 'none')
  assert.equal(paint().boxShadow, 'none')
})

test('mouse, keyboard, escape, tab, disabled options and dynamic options keep the native value', async () => {
  const { window } = boot(`<select id="category" aria-label="主题">
    <option value="">主题：全部</option>
    <option value="Communication">Communication</option>
    <option value="Device Control" disabled>Device Control</option>
    <optgroup label="Sensors"><option value="Sensors">Sensors</option></optgroup>
  </select>`)
  const select = window.document.querySelector('select')!
  const changes: string[] = []
  select.addEventListener('change', () => changes.push(select.value))
  place(select, { top: 40, left: 24, bottom: 68, right: 180, width: 156, height: 28 })
  pointer(window, select)
  const opened = menu(window)!
  assert.equal(opened.getAttribute('aria-label'), '主题')
  assert.equal(opened.querySelector('.aily-select-group')?.textContent, 'Sensors')
  assert.equal(opened.querySelector('[aria-selected="true"]')?.textContent, '主题：全部')
  assert.equal(parseFloat(opened.style.left), 24)
  const row = [...opened.querySelectorAll<HTMLElement>('.aily-select-option')].find(item => item.textContent === 'Communication')!
  assert.equal(row.title, 'Communication')
  row.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  assert.equal(select.value, 'Communication')
  assert.deepEqual(changes, ['Communication'])
  assert.equal(menu(window), null)

  select.focus()
  key(window, select, 'ArrowDown')
  assert.equal(select.value, 'Communication')
  key(window, select, 'Enter')
  assert.equal(select.value, 'Sensors')
  key(window, select, 'ArrowUp')
  key(window, select, 'Escape')
  assert.equal(select.value, 'Sensors')
  assert.equal(menu(window), null)
  key(window, select, 'Home')
  key(window, select, 'Tab')
  assert.equal(menu(window), null)
  assert.equal(select.value, 'Sensors')

  select.value = ''
  key(window, select, 's')
  const highlighted = window.document.getElementById(select.getAttribute('aria-activedescendant')!)
  assert.equal(highlighted?.textContent, 'Sensors')
  key(window, select, 'Escape')

  pointer(window, select)
  const added = window.document.createElement('option')
  added.value = 'Zigbee'
  added.textContent = 'Zigbee'
  select.append(added)
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal([...menu(window)!.querySelectorAll('.aily-select-option')].some(item => item.textContent === 'Zigbee'), true)

  select.disabled = true
  pointer(window, select)
  assert.equal(menu(window), null)
  const list = window.document.createElement('select')
  list.multiple = true
  list.innerHTML = '<option>A</option>'
  window.document.body.append(list)
  const nativeEvent = new window.PointerEvent('pointerdown', { button: 0, bubbles: true, cancelable: true })
  list.dispatchEvent(nativeEvent)
  assert.equal(nativeEvent.defaultPrevented, false)
  assert.equal(menu(window), null)
})

test('the menu aligns to the select and flips upward at the viewport edge', () => {
  const { window } = boot('<select aria-label="版本"><option>1.0.0</option><option>2.0.0</option></select>')
  const select = window.document.querySelector('select')!
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 120 })
  place(select, { top: 80, left: 300, bottom: 108, right: 390, width: 90, height: 28 })
  pointer(window, select)
  const opened = menu(window)!
  assert.ok(parseFloat(opened.style.top) < 80)
  assert.equal(parseFloat(opened.style.left), 112)
  assert.equal(opened.style.maxWidth, '320px')
  assert.equal(opened.style.maxHeight, '68px')
})
