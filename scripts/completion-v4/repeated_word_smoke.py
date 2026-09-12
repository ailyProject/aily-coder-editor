"""Verify clicked-word replacement with native input and an always-empty provider.

Run against fixture_server.py only. The fixture supplies the real v4 capability
and host path, but never supplies an edit: every preview below must come from
the user's recent manual word edit. No editor state or business event is injected.
"""
import argparse
import json
import sys
import tempfile
from pathlib import Path

from playwright.sync_api import expect, sync_playwright


parser = argparse.ArgumentParser()
parser.add_argument('--url', default='http://127.0.0.1:8019')
parser.add_argument('--cdp')
parser.add_argument('--browser-executable')
args = parser.parse_args()
output = Path(tempfile.gettempdir()) / ('aily-tab-repeated-word-evidence' + ('-electron' if args.cdp else ''))
output.mkdir(exist_ok=True)
checks = []
pointer_evidence = []
boundary = ('Built Workbench, native keyboard and mouse, real host bridge and v4 capability path; '
            'isolated filesystem/auth/Redis and scenario=empty provider. Local clicked-word behavior '
            'is verified; AI/external edit-origin isolation is covered by unit tests, not this UI script.')

with sync_playwright() as p:
    chrome = Path('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    executable = args.browser_executable or (str(chrome) if chrome.exists() else None)
    browser = p.chromium.connect_over_cdp(args.cdp) if args.cdp else p.chromium.launch(
        headless=True, **({'executable_path': executable} if executable else {}))
    page = browser.contexts[0].pages[0] if args.cdp else browser.new_page(viewport={'width': 1440, 'height': 1000})
    page.set_viewport_size({'width': 1440, 'height': 1000})
    primary = 'Meta' if sys.platform == 'darwin' else 'Control'
    errors = []
    error_stacks = []
    page.on('pageerror', lambda error: (errors.append(str(error)), error_stacks.append(error.stack)))

    def state():
        response = page.request.get(args.url + '/fixture/state')
        assert response.ok, 'fixture state must be available'
        return response.json()

    fixture = state()
    assert not fixture.get('realModel'), 'This test requires the isolated deterministic fixture'
    root = fixture['root']
    settings = Path(root, '.vscode', 'settings.json')
    settings.parent.mkdir(exist_ok=True)
    settings.write_text('{}')
    source = Path(root, 'repeated-word-slow.cpp')
    original = ('int oldWord = 1;\n'
                'int second = oldWord;\n'
                'int third = oldWord;\n'
                'int oldWordSuffix = 2;\n'
                'int unrelated = 3;\n')
    source.write_text(original)
    pointer_source = Path(root, 'repeated-word-pointer.cpp')
    pointer_source.write_text(original)
    suffix = Path(root, 'repeated-word-suffix.cpp')
    suffix.write_text('int speedCount = 1;\nint next = speedCount;\n')
    deleted = Path(root, 'repeated-word-delete-insert.cpp')
    deleted.write_text('int previousFlag = 1;\nint next = previousFlag;\n')
    empty = Path(root, 'repeated-word-empty.cpp')
    empty.write_text('int spareWord = 1;\nint next = spareWord;\n')
    response = page.request.post(args.url + '/fixture/scenario', data={'scenario': 'empty'})
    assert response.ok

    try:
        page.goto(args.url)
        page.wait_for_load_state('networkidle')
        frame = page.frame_locator('iframe[title="Aily Coder v4 verification"]')
        expect(frame.locator('.monaco-workbench')).to_be_visible(timeout=15000)
        page.screenshot(path=str(output / '00-workbench.png'))
        # Reconnaissance above confirms a real Workbench before using Quick Access.
        frame.locator('.monaco-workbench').click(position={'x': 800, 'y': 450})
        quick = frame.locator('.quick-input-widget input')
        preview = frame.locator('.aily-next-edit-preview, .aily-next-edit-inline').first

        def access(text):
            page.keyboard.press(primary + '+p')
            expect(quick).to_be_visible()
            quick.fill(text)
            page.wait_for_timeout(350)
            page.keyboard.press('Enter')
            expect(quick).not_to_be_visible()
            if text.startswith(root + '/'):
                expect(frame.get_by_role('tab', name=Path(text).name, exact=True)).to_have_attribute('aria-selected', 'true')
                expect(frame.locator('.monaco-editor.focused .view-lines')).to_be_visible()

        def check(name, condition=True):
            assert condition, name
            checks.append(name)
            print('PASS', name, flush=True)

        def save(path):
            page.keyboard.press(primary + '+s')
            page.wait_for_timeout(500)
            return path.read_text()

        def select(position, length):
            access(position)
            page.keyboard.down('Shift')
            for _ in range(length):
                page.keyboard.press('ArrowRight')
            page.keyboard.up('Shift')

        def pointer(line_number, word, clicks=1):
            """Read DOM glyph geometry, then issue an actual platform mouse click."""
            line = frame.locator('.monaco-editor.focused .view-lines > .view-line').nth(line_number - 1)
            expect(line).to_be_visible()
            geometry = line.evaluate('''(element, word) => {
                const text = element.textContent || '';
                const index = text.indexOf(word);
                if (index < 0) throw new Error('Visible line does not contain ' + word + ': ' + text);
                const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
                const nodes = [];
                let node;
                while (node = walker.nextNode()) nodes.push(node);
                let offset = 0;
                let start;
                let end;
                for (const current of nodes) {
                    const length = current.textContent.length;
                    if (!start && index < offset + length) start = [current, index - offset];
                    if (!end && index + word.length <= offset + length) end = [current, index + word.length - offset];
                    offset += length;
                }
                if (!start || !end) throw new Error('Unable to locate visible word glyphs');
                const range = document.createRange();
                range.setStart(...start);
                range.setEnd(...end);
                const rect = range.getBoundingClientRect();
                const outer = element.getBoundingClientRect();
                return {text, x: rect.x - outer.x + rect.width / 2,
                    y: rect.y - outer.y + rect.height / 2, width: rect.width};
            }''', word)
            bounds = line.bounding_box()
            assert bounds and geometry['width'] > 0, 'Target must have visible native glyphs'
            pointer_evidence.append({'line': line_number, 'word': word, 'clicks': clicks, **geometry})
            page.mouse.click(bounds['x'] + geometry['x'], bounds['y'] + geometry['y'], click_count=clicks)

        def no_preview():
            # Wait beyond both the prediction debounce and deterministic request.
            page.wait_for_timeout(1600)
            expect(preview).not_to_be_visible()

        access('>Aily: 恢复自动补全')
        access(str(source))
        select(':1:5', len('oldWord'))
        # A pause longer than the old history grouping threshold occurs after
        # every key. The eventual suggestion must use newWord, never just "n".
        page.keyboard.type('newWord', delay=900)
        page.wait_for_timeout(900)
        manually_changed = original.replace('int oldWord =', 'int newWord =', 1)
        check('slow native typing completes the manual source edit', save(source) == manually_changed)
        pointer(2, 'oldWord')
        expect(preview).to_be_visible(timeout=10000)
        check('single mouse click recalls the complete replacement after long typing pauses', 'newWord' in preview.inner_text())
        page.screenshot(path=str(output / '01-single-click.png'))
        page.keyboard.press('Tab')
        accepted = manually_changed.replace('int second = oldWord;', 'int second = newWord;')
        check('Tab changes only the clicked occurrence and preserves other occurrences and substrings', save(source) == accepted)
        page.keyboard.press('Escape')
        page.keyboard.press(primary + '+z')
        check('one undo restores only the accepted occurrence', save(source) == manually_changed)

        # Undo clears this document's intent conservatively. Start a fresh
        # manual edit in another file before testing further pointer actions.
        access(str(pointer_source))
        select(':1:5', len('oldWord'))
        page.keyboard.type('newWord', delay=80)
        page.wait_for_timeout(900)
        pointer(5, 'unrelated')
        no_preview()
        check('clicking an unrelated word does not force a replacement')
        pointer(4, 'oldWordSuffix')
        no_preview()
        check('a longer identifier containing the old word is not a whole-word match')
        pointer(3, 'oldWord', clicks=2)
        expect(preview).to_be_visible(timeout=10000)
        check('native double click also previews the complete matching word', 'newWord' in preview.inner_text())
        page.screenshot(path=str(output / '02-double-click.png'))
        page.keyboard.press('Escape')
        no_preview()
        check('Escape dismisses the replacement without modifying source', save(pointer_source) == manually_changed)
        # A new pointer opportunity after dismissal can still match another word.
        pointer(5, 'unrelated')
        pointer(2, 'oldWord', clicks=2)
        expect(preview).to_be_visible(timeout=10000)
        page.keyboard.press('Tab')
        check('double-click selection accepts one exact occurrence', save(pointer_source) == accepted)

        access(str(suffix))
        select(':1:10', len('Count'))
        page.keyboard.type('Limit', delay=80)
        page.wait_for_timeout(900)
        pointer(2, 'speedCount')
        expect(preview).to_be_visible(timeout=10000)
        check('editing only a word suffix remembers the full old and new identifiers', 'speedLimit' in preview.inner_text())
        page.screenshot(path=str(output / '03-suffix-edit.png'))
        page.keyboard.press('Tab')
        check('suffix-derived suggestion replaces the entire clicked identifier',
              save(suffix) == 'int speedLimit = 1;\nint next = speedLimit;\n')

        access(str(deleted))
        select(':1:5', len('previousFlag'))
        page.keyboard.press('Backspace')
        page.wait_for_timeout(900)
        page.keyboard.type('activeFlag', delay=80)
        page.wait_for_timeout(900)
        pointer(2, 'previousFlag')
        expect(preview).to_be_visible(timeout=10000)
        check('delete then type at the same position preserves the complete replacement intent', 'activeFlag' in preview.inner_text())
        page.screenshot(path=str(output / '04-delete-then-type.png'))
        page.keyboard.press('Tab')
        check('delete-then-type suggestion changes only its clicked destination',
              save(deleted) == 'int activeFlag = 1;\nint next = activeFlag;\n')

        access(str(empty))
        select(':1:5', len('spareWord'))
        page.keyboard.press('Backspace')
        page.wait_for_timeout(900)
        pointer(2, 'spareWord')
        no_preview()
        check('a plain deletion never offers an empty-word replacement',
              save(empty) == 'int  = 1;\nint next = spareWord;\n')
        check('all previews were obtained while the model returned no suggestions', state()['scenario'] == 'empty')
        meaningful = [error for error, stack in zip(errors, error_stacks)
            if 'lock() must be called from a primary top-level' not in error and
            not (error == 'Canceled' and '/assets/extensions-' in stack and '.cancel (' in stack)]
        check('no runtime errors beyond Workbench hint cancellation', not meaningful)
        (output / 'result.json').write_text(json.dumps({'checks': checks, 'errors': errors,
            'errorStacks': error_stacks, 'pointerEvidence': pointer_evidence,
            'boundary': boundary}, ensure_ascii=False, indent=2))
    except Exception:
        page.screenshot(path=str(output / 'failure.png'))
        preview_diagnostics = frame.locator('.aily-next-edit-preview, .aily-next-edit-inline').evaluate_all('''elements =>
            elements.map(element => ({html: element.outerHTML, ancestors: Array.from((function* () {
                for (let node = element; node && node.nodeType === 1; node = node.parentElement) {
                    const style = getComputedStyle(node);
                    const rect = node.getBoundingClientRect();
                    yield {className: node.className, display: style.display, visibility: style.visibility,
                        width: rect.width, height: rect.height, x: rect.x, y: rect.y};
                }
            })())}))''')
        (output / 'failure.json').write_text(json.dumps({'checks': checks, 'errors': errors,
            'errorStacks': error_stacks, 'pointerEvidence': pointer_evidence, 'state': state(),
            'previewDiagnostics': preview_diagnostics, 'boundary': boundary}, ensure_ascii=False, indent=2))
        raise
    finally:
        if not args.cdp:
            page.close()
        browser.close()
