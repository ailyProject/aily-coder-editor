/** Library-manager single selects. Keeps the native select and replaces the OS popup. */

export const librarySelectCss = `
html.aily-selects select:not([multiple]):not([size]),
html.aily-selects select[size="1"]:not([multiple]) {
  appearance: none;
  field-sizing: content;
  display: inline-block;
  flex: 0 1 auto;
  justify-self: start;
  align-self: center;
  width: auto;
  min-width: 0;
  max-width: min(100%, var(--select-max-width, 240px));
  height: 28px;
  min-height: 28px;
  box-sizing: border-box;
  margin: 0;
  padding: 0 26px 0 10px;
  overflow: hidden;
  border: 0;
  outline: none;
  box-shadow: none;
  border-radius: 2px;
  color: var(--vscode-dropdown-foreground, var(--vscode-foreground, #cccccc));
  background-color: var(--vscode-dropdown-background, var(--vscode-input-background, #3c3c3c));
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath d='m4.5 2.5 3.5 3.5-3.5 3.5' fill='none' stroke='%238c8c8c' stroke-width='1.3' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
  background-position: right 7px center;
  background-repeat: no-repeat;
  font: inherit;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
}
html.aily-selects select.version-select {
  height: 24px;
  min-height: 24px;
  font-size: 11px;
}
html.aily-selects select[aria-expanded="true"] {
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath d='m2.5 4.5 3.5 3.5 3.5-3.5' fill='none' stroke='%238c8c8c' stroke-width='1.3' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
}
html.aily-selects select:focus,
html.aily-selects select:focus-visible,
html.aily-selects select[aria-expanded="true"] {
  border: 0;
  outline: none;
  box-shadow: none;
}
html.aily-selects select:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.aily-select-menu {
  position: fixed;
  inset: auto;
  z-index: 10000;
  box-sizing: border-box;
  width: max-content;
  min-width: 0;
  max-width: min(320px, calc(100vw - 16px));
  max-height: 260px;
  margin: 0;
  padding: 4px;
  overflow: auto;
  overscroll-behavior: contain;
  border: 1px solid var(--vscode-dropdown-border, var(--vscode-widget-border, #454545));
  border-radius: 5px;
  color: var(--vscode-dropdown-foreground, var(--vscode-foreground, #cccccc));
  background: var(--vscode-dropdown-background, var(--vscode-editorWidget-background, #252526));
  box-shadow: 0 8px 20px rgb(0 0 0 / 24%);
}
.aily-select-option,
.aily-select-group {
  position: relative;
  box-sizing: border-box;
  min-height: 28px;
  padding: 4px 26px 4px 8px;
  border-radius: 3px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  line-height: 20px;
  text-align: left;
}
.aily-select-option { cursor: pointer; }
.aily-select-option.is-active { background: var(--vscode-list-hoverBackground, var(--vscode-toolbar-hoverBackground)); }
.aily-select-option[aria-selected="true"]::after {
  content: '✓';
  position: absolute;
  right: 8px;
}
.aily-select-option[aria-disabled="true"],
.aily-select-group {
  color: var(--vscode-disabledForeground, var(--vscode-descriptionForeground));
  cursor: default;
}
.aily-select-option[aria-disabled="true"] { opacity: 0.5; }
.aily-select-group { font-size: 0.9em; }
`

/** Installed into the library webview. Native values and change/input events stay intact. */
export const librarySelectScript = `(() => {
  if (globalThis.__ailyLibrarySelect) return;
  globalThis.__ailyLibrarySelect = true;
  document.documentElement.classList.add('aily-selects');
  let active = null;
  let sequence = 0;
  const attributes = ['aria-expanded', 'aria-controls', 'aria-activedescendant'];
  const eligible = target => target instanceof HTMLSelectElement && !target.multiple && target.size <= 1 && !target.matches(':disabled');
  const enabled = option => !option.disabled && !option.hidden && !(option.parentElement instanceof HTMLOptGroupElement && option.parentElement.disabled);
  function close() {
    if (!active) return;
    const current = active;
    active = null;
    current.observer.disconnect();
    current.resize.disconnect();
    cancelAnimationFrame(current.frame);
    current.menu.remove();
    for (const name of attributes) {
      if (current.saved[name] === null) current.select.removeAttribute(name);
      else current.select.setAttribute(name, current.saved[name]);
    }
  }
  function position() {
    if (!active) return;
    const select = active.select;
    const menu = active.menu;
    if (!select.isConnected || !eligible(select) || !select.getClientRects().length) return close();
    const rect = select.getBoundingClientRect();
    const viewport = window.visualViewport;
    const width = viewport ? viewport.width : innerWidth;
    const height = viewport ? viewport.height : innerHeight;
    const offsetX = viewport ? viewport.offsetLeft : 0;
    const offsetY = viewport ? viewport.offsetTop : 0;
    const below = height + offsetY - rect.bottom - 12;
    const above = rect.top - offsetY - 12;
    const upwards = below < Math.min(260, menu.scrollHeight) && above > below;
    menu.style.maxWidth = Math.max(0, Math.min(320, width - 16)) + 'px';
    menu.style.maxHeight = Math.max(0, Math.min(260, upwards ? above : below)) + 'px';
    menu.style.left = Math.max(offsetX + 8, Math.min(rect.left, offsetX + width - menu.offsetWidth - 8)) + 'px';
    menu.style.top = (upwards ? rect.top - menu.offsetHeight - 4 : rect.bottom + 4) + 'px';
  }
  function highlight(index, scroll) {
    if (!active) return;
    active.index = index;
    for (const entry of active.rows) entry[1].classList.toggle('is-active', entry[0] === index);
    const row = active.rows.get(index);
    if (row) {
      active.select.setAttribute('aria-activedescendant', row.id);
      if (scroll !== false) row.scrollIntoView({ block: 'nearest' });
    } else active.select.removeAttribute('aria-activedescendant');
  }
  function choose(index) {
    if (!active) return;
    const select = active.select;
    const option = select.options[index];
    if (!eligible(select) || !option || !enabled(option)) return;
    const changed = select.selectedIndex !== index;
    close();
    select.focus({ preventScroll: true });
    if (!changed) return;
    select.selectedIndex = index;
    select.dispatchEvent(new Event('input', { bubbles: true }));
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function render() {
    if (!active) return;
    const select = active.select;
    const menu = active.menu;
    if (!eligible(select)) return close();
    active.rows.clear();
    menu.replaceChildren();
    let lastGroup = null;
    Array.from(select.options).forEach((option, index) => {
      const group = option.parentElement instanceof HTMLOptGroupElement ? option.parentElement : null;
      if (option.hidden || (group && group.hidden)) return;
      if (group && group !== lastGroup) {
        const heading = document.createElement('div');
        heading.className = 'aily-select-group';
        heading.textContent = group.label;
        heading.setAttribute('role', 'presentation');
        menu.append(heading);
      }
      lastGroup = group;
      const row = document.createElement('div');
      row.id = menu.id + '-' + index;
      row.className = 'aily-select-option';
      row.setAttribute('role', 'option');
      row.setAttribute('aria-label', option.label);
      row.setAttribute('aria-selected', String(index === select.selectedIndex));
      row.setAttribute('aria-disabled', String(!enabled(option)));
      row.textContent = option.label;
      row.title = option.label;
      row.addEventListener('pointermove', () => { if (enabled(option)) highlight(index, false); });
      row.addEventListener('click', () => choose(index));
      active.rows.set(index, row);
      menu.append(row);
    });
    position();
    if (!active) return;
    highlight(active.rows.has(select.selectedIndex) ? select.selectedIndex : active.rows.keys().next().value);
  }
  function open(select) {
    close();
    if (!eligible(select) || !select.options.length) return;
    select.focus({ preventScroll: true });
    const menu = document.createElement('div');
    menu.id = 'aily-select-menu-' + (++sequence);
    menu.className = 'aily-select-menu';
    menu.setAttribute('role', 'listbox');
    menu.setAttribute('popover', 'manual');
    const labels = Array.from(select.labels || [], label => {
      const clone = label.cloneNode(true);
      clone.querySelectorAll('select').forEach(node => node.remove());
      return clone.textContent.trim();
    }).join(' ');
    menu.setAttribute('aria-label', select.getAttribute('aria-label') || labels || 'Options');
    menu.style.font = getComputedStyle(select).font;
    menu.addEventListener('pointerdown', event => event.preventDefault());
    const saved = {};
    for (const name of attributes) saved[name] = select.getAttribute(name);
    const observer = new MutationObserver(render);
    const resize = new ResizeObserver(position);
    active = { select, menu, saved, observer, resize, rows: new Map(), index: select.selectedIndex, frame: 0, search: '', searchAt: 0 };
    document.body.append(menu);
    if (typeof menu.showPopover === 'function') menu.showPopover();
    select.setAttribute('aria-expanded', 'true');
    select.setAttribute('aria-controls', menu.id);
    render();
    observer.observe(select, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['disabled', 'hidden', 'label', 'selected', 'value'] });
    resize.observe(select);
    const checkAttached = () => {
      if (!active || active.select !== select) return;
      if (!select.isConnected || !eligible(select)) return close();
      active.frame = requestAnimationFrame(checkAttached);
    };
    active.frame = requestAnimationFrame(checkAttached);
  }
  document.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    const select = event.target;
    if (eligible(select)) {
      event.preventDefault();
      if (active && active.select === select) close();
      else open(select);
    } else if (active && !active.menu.contains(event.target)) close();
  }, true);
  document.addEventListener('click', event => {
    if (!eligible(event.target)) return;
    event.preventDefault();
    if (event.detail === 0) {
      if (active && active.select === event.target) close();
      else open(event.target);
    }
  }, true);
  document.addEventListener('keydown', event => {
    const select = event.target;
    if (!eligible(select)) return;
    const key = event.key;
    if (key === 'Tab' || key === 'Escape') {
      if (key === 'Escape' && active) event.preventDefault();
      close();
      return;
    }
    if (event.ctrlKey || event.metaKey) return;
    const navigation = ['ArrowDown', 'ArrowUp', 'Home', 'End', 'PageDown', 'PageUp'];
    if (!navigation.includes(key) && key !== 'Enter' && key !== ' ' && key.length !== 1) return;
    event.preventDefault();
    const wasOpen = !!(active && active.select === select);
    if (!wasOpen) open(select);
    if (!active) return;
    const indices = Array.from(active.rows.keys()).filter(index => enabled(select.options[index]));
    if (key === 'Enter' || (key === ' ' && !active.search)) {
      if (wasOpen) choose(active.index);
      return;
    }
    if (navigation.includes(key)) {
      const current = indices.indexOf(active.index);
      const delta = key === 'ArrowDown' ? 1 : key === 'ArrowUp' ? -1 : key === 'PageDown' ? 10 : key === 'PageUp' ? -10 : 0;
      const next = key === 'Home' ? 0 : key === 'End' ? indices.length - 1 : current + delta;
      highlight(indices[Math.max(0, Math.min(indices.length - 1, next))]);
    } else {
      const now = Date.now();
      active.search = (now - active.searchAt < 700 ? active.search : '') + key.toLocaleLowerCase();
      active.searchAt = now;
      const query = new Set(active.search).size === 1 ? key.toLocaleLowerCase() : active.search;
      const start = indices.indexOf(active.index) + (query.length === 1 ? 1 : 0);
      const ordered = indices.slice(start).concat(indices.slice(0, start));
      const match = ordered.find(index => select.options[index].label.toLocaleLowerCase().startsWith(query));
      if (match !== undefined) highlight(match);
    }
  }, true);
  document.addEventListener('focusin', event => { if (active && event.target !== active.select) close(); });
  document.addEventListener('change', event => { if (event.target === (active && active.select)) close(); });
  document.addEventListener('scroll', event => { if (active && !active.menu.contains(event.target)) position(); }, true);
  window.addEventListener('resize', position);
  window.addEventListener('blur', close);
  if (window.visualViewport) window.visualViewport.addEventListener('resize', position);
})();`
