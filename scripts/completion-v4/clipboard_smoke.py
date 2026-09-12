"""Native copy/cut through built Workbench, host, v4 router and provider prompt."""
import argparse
import json
import sys
import tempfile
import time
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

parser = argparse.ArgumentParser()
parser.add_argument('--url', default='http://127.0.0.1:8019')
parser.add_argument('--cdp')
parser.add_argument('--browser-executable')
args = parser.parse_args()
output = Path(tempfile.gettempdir()) / ('aily-tab-clipboard-evidence' + ('-electron' if args.cdp else ''))
output.mkdir(exist_ok=True)
checks = []
with sync_playwright() as p:
    chrome = Path('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    executable = args.browser_executable or (str(chrome) if chrome.exists() else None)
    browser = p.chromium.connect_over_cdp(args.cdp) if args.cdp else p.chromium.launch(
        headless=True, **({'executable_path': executable} if executable else {}))
    page = browser.contexts[0].pages[0] if args.cdp else browser.new_page(viewport={'width': 1440, 'height': 1000})
    primary = 'Meta' if sys.platform == 'darwin' else 'Control'
    errors = []
    error_stacks = []
    page.on('pageerror', lambda error: (errors.append(str(error)), error_stacks.append(error.stack)))
    def state(): return page.request.get(args.url + '/fixture/state').json()
    def scenario(value): page.request.post(args.url + '/fixture/scenario', data={'scenario': value})
    root = state()['root']
    source = Path(root, 'clipboard-source.cpp')
    target = Path(root, 'clipboard-target.cpp')
    settings = Path(root, '.vscode', 'settings.json')
    settings.parent.mkdir(exist_ok=True)
    settings.write_text('{}')
    source.write_text('int copiedLimit = 42;\nvoid source() {\n  int movedCount = 7;\n}\n')
    target.write_text('extern int copiedLimit;\nint target() {\n  return \n}\nvoid destination() {\n  \n}\n')
    scenario('empty')
    try:
        page.goto(args.url)
        page.wait_for_load_state('networkidle')
        frame = page.frame_locator('iframe[title="Aily Coder v4 verification"]')
        expect(frame.locator('.monaco-workbench')).to_be_visible(timeout=15000)
        frame.locator('.monaco-workbench').click(position={'x': 800, 'y': 450})
        quick = frame.locator('.quick-input-widget input')
        def access(text, nested=False):
            page.keyboard.press(primary + '+p')
            expect(quick).to_be_visible()
            quick.fill(text)
            page.wait_for_timeout(350)
            page.keyboard.press('Enter')
            if not nested: expect(quick).not_to_be_visible()
            if text.startswith(root + '/'):
                expect(frame.get_by_role('tab', name=Path(text).name, exact=True)).to_have_attribute('aria-selected', 'true')
                expect(frame.locator('.monaco-editor.focused .view-lines')).to_be_visible()
        def command(text): access('>' + text)
        def menu(label):
            access('>Aily: 自动补全设置', nested=True)
            expect(quick).to_be_visible()
            quick.fill(label)
            expect(frame.locator('.quick-input-list .monaco-list-row').filter(has_text=label).first).to_be_visible()
            page.keyboard.press('Enter')
            expect(quick).not_to_be_visible()
        def check(name, condition=True):
            assert condition, name
            checks.append(name)
            print('PASS', name, flush=True)
        def save():
            page.keyboard.press(primary + '+s')
            page.wait_for_timeout(500)
        def select(position, length):
            access(position)
            page.keyboard.down('Shift')
            for _ in range(length): page.keyboard.press('ArrowRight')
            page.keyboard.up('Shift')
        def copy_identifier():
            scenario('empty')
            access(str(source))
            select(':1:5', len('copiedLimit'))
            page.keyboard.press(primary + '+c')
        def wait_request(after):
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                current = state()
                if len(current['requests']) > after: return current['requests'][-1]
                page.wait_for_timeout(100)
            raise AssertionError('No new suggestion request')
        def predict(position, provider_scenario='clipboard'):
            access(str(target))
            access(position)
            scenario(provider_scenario)
            before = len(state()['requests'])
            command('Aily: 触发 Aily Tab')
            return wait_request(before)

        command('Aily: 恢复自动补全')
        copy_identifier()
        original_source = source.read_text()
        request = predict(':3:10')
        ghost = frame.locator('.ghost-text-decoration').first
        expect(ghost).to_be_visible(timeout=10000)
        check('native copy reaches completion context with exact text and source',
              request['mode'] == 'completion' and request['clipboardHistory'][0]['text'] == 'copiedLimit' and
              request['clipboardHistory'][0]['operation'] == 'copy' and request['clipboardHistory'][0]['relativePath'] == source.name)
        check('provider prompt receives copied code', state()['clipboardProviderInputs'][-1][0]['text'] == 'copiedLimit')
        page.screenshot(path=str(output / '01-copy-completion.png'))
        scenario('empty')
        page.keyboard.press('Tab')
        save()
        check('Tab accepts copied symbol and leaves its source intact',
              'return copiedLimit;' in target.read_text() and source.read_text() == original_source)
        page.keyboard.press(primary + '+z')
        save()
        check('one undo removes only the accepted copied symbol', 'return copiedLimit;' not in target.read_text())
        predict(':3:10')
        expect(ghost).to_be_visible(timeout=10000)
        scenario('empty')
        page.keyboard.press('Tab')
        save()
        # A click at the closing brace is an explicit next-edit opportunity.
        access(':4:1')
        scenario('clipboard')
        before = len(state()['requests'])
        frame.locator('.monaco-editor.focused .view-line').nth(3).click(position={'x': 4, 'y': 8})
        request = wait_request(before)
        preview = frame.locator('.aily-next-edit-preview, .aily-next-edit-inline').first
        expect(preview).to_be_visible(timeout=10000)
        check('native cursor prediction also includes clipboard history', request['mode'] == 'next-edit' and
              request['clipboardHistory'][0]['text'] == 'copiedLimit' and state()['clipboardProviderInputs'][-1][0]['operation'] == 'copy')
        scenario('empty')
        page.keyboard.press('Tab')
        save()
        check('clipboard-informed next edit still uses ordinary Tab acceptance', 'return copiedLimit + 1;' in target.read_text())
        page.keyboard.press(primary + '+z')
        save()
        check('next edit remains a single undo step', 'return copiedLimit;' in target.read_text())

        access(str(source))
        select(':3:3', len('int movedCount = 7;'))
        page.keyboard.press(primary + '+x')
        save()
        check('native cut really removes the selected source code', 'movedCount' not in source.read_text())
        request = predict(':6:3')
        expect(ghost).to_be_visible(timeout=10000)
        history = request['clipboardHistory']
        check('cut history is newest and preserves earlier copy history', len(history) == 2 and
              history[0]['operation'] == 'cut' and history[0]['text'] == 'int movedCount = 7;' and history[1]['operation'] == 'copy')
        check('cut context reaches provider without authorizing source edits', state()['clipboardProviderInputs'][-1] == history and
              all('permission' not in item for item in history))
        page.screenshot(path=str(output / '02-cut-completion.png'))
        scenario('empty')
        page.keyboard.press('Tab')
        save()
        check('Tab moves cut code into the destination without restoring its source',
              'int movedCount = 7;' in target.read_text() and 'movedCount' not in source.read_text())
        page.keyboard.press(primary + '+z')
        save()
        check('undo at destination leaves the original cut unchanged', 'movedCount' not in target.read_text() and 'movedCount' not in source.read_text())

        command('Aily: 清空剪切复制历史')
        request = predict(':6:3')
        check('clear immediately removes clipboard context from subsequent requests', not request.get('clipboardHistory'))
        expect(ghost).not_to_be_visible()
        menu('关闭剪切复制联想')
        copy_identifier()
        request = predict(':6:3')
        check('disabled clipboard context ignores new native copies', not request.get('clipboardHistory'))
        menu('启用剪切复制联想')
        copy_identifier()
        request = predict(':6:3')
        expect(ghost).to_be_visible(timeout=10000)
        check('reenabling captures fresh copies', request['clipboardHistory'][0]['text'] == 'copiedLimit')
        page.keyboard.press('Escape')
        scenario('empty')
        page.reload()
        page.wait_for_load_state('networkidle')
        expect(frame.locator('.monaco-workbench')).to_be_visible(timeout=15000)
        frame.locator('.monaco-workbench').click(position={'x': 800, 'y': 450})
        request = predict(':6:3')
        check('clipboard history does not survive a real editor reload', not request.get('clipboardHistory'))
        scenario('empty')
        access(str(source))
        access(':1:5')
        page.keyboard.press(primary + '+c')
        request = predict(':6:3')
        expect(ghost).to_be_visible(timeout=10000)
        check('copy without a selection uses the actual whole-line clipboard payload',
              request['clipboardHistory'][0]['text'] == 'int copiedLimit = 42;\n')
        page.keyboard.press('Escape')
        scenario('empty')
        command('Aily: 清空剪切复制历史')
        multicursor = Path(root, 'clipboard-multicursor.cpp')
        multicursor.write_bytes(b'int alpha = 1;\r\nint bravo = 2;\r\n')
        access(str(multicursor))
        select(':1:5', len('alpha'))
        page.keyboard.press(primary + '+Alt+ArrowDown')
        page.keyboard.press(primary + '+x')
        save()
        request = predict(':6:3')
        check('multicursor cut retains selection order, CRLF and a single history entry',
              len(request['clipboardHistory']) == 1 and request['clipboardHistory'][0]['operation'] == 'cut' and
              request['clipboardHistory'][0]['text'] == 'alpha\r\nbravo' and
              'alpha' not in multicursor.read_text() and 'bravo' not in multicursor.read_text())
        page.keyboard.press('Escape')
        scenario('empty')
        def old_capabilities(route):
            response = route.fetch()
            capabilities = response.json()
            capabilities['features'].pop('clipboardContext', None)
            route.fulfill(response=response, body=json.dumps(capabilities))
        page.route('**/api/v4/code/capabilities', old_capabilities)
        command('Aily: 重新连接补全服务')
        copy_identifier()
        request = predict(':6:3', 'completion')
        expect(ghost).to_be_visible(timeout=10000)
        check('older services retain ordinary completion without unsupported clipboard fields',
              not request.get('clipboardHistory') and 'return' in ghost.inner_text())
        page.keyboard.press('Escape')
        page.unroute('**/api/v4/code/capabilities')
        scenario('empty')
        # The pinned Workbench can reject its own animation/observable token
        # with Canceled when a visible inline hint is replaced or dismissed.
        # Keep those raw errors in evidence, distinguish them from app failures.
        meaningful = [error for error, stack in zip(errors, error_stacks)
            if 'lock() must be called from a primary top-level' not in error and
            not (error == 'Canceled' and '/assets/extensions-' in stack and '.cancel (' in stack)]
        check('no runtime errors beyond Workbench hint cancellation', not meaningful)
        (output / 'result.json').write_text(json.dumps({'checks': checks, 'errors': errors,
            'errorStacks': error_stacks,
            'boundary': 'real native keyboard, built Workbench, host bridge, v4 router and prompt; fixture auth, Redis and deterministic provider'}, ensure_ascii=False, indent=2))
    except Exception:
        page.screenshot(path=str(output / 'failure.png'))
        (output / 'failure.json').write_text(json.dumps({'checks': checks, 'errors': errors, 'errorStacks': error_stacks, 'state': state()}, ensure_ascii=False, indent=2))
        raise
    finally:
        if not args.cdp: page.close()
        browser.close()
