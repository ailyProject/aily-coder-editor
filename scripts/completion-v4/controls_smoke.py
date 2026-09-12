"""Real Workbench controls and persistence; run against the isolated v4 fixture."""
import argparse
import json
import sys
import tempfile
import time
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

parser = argparse.ArgumentParser()
parser.add_argument('--url', default='http://127.0.0.1:8019')
parser.add_argument('--browser-executable')
parser.add_argument('--cdp')
args = parser.parse_args()
output = Path(tempfile.gettempdir()) / ('aily-tab-controls-evidence' + ('-electron' if args.cdp else ''))
output.mkdir(exist_ok=True)
checks = []
with sync_playwright() as p:
    executable = args.browser_executable
    chrome = Path('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    if not executable and chrome.exists(): executable = str(chrome)
    browser = p.chromium.connect_over_cdp(args.cdp) if args.cdp else p.chromium.launch(
        headless=True, **({'executable_path': executable} if executable else {}))
    page = browser.contexts[0].pages[0] if args.cdp else browser.new_page(viewport={'width': 1440, 'height': 1000})
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    primary = 'Meta' if sys.platform == 'darwin' else 'Control'
    try:
        root = page.request.get(args.url + '/fixture/state').json()['root']
        config_path = Path(root, '.vscode', 'settings.json')
        config_path.parent.mkdir(exist_ok=True)
        config_path.write_text('{}')
        page.goto(args.url)
        page.wait_for_load_state('networkidle')
        frame = page.frame_locator('iframe[title="Aily Coder v4 verification"]')
        expect(frame.locator('.monaco-workbench')).to_be_visible(timeout=15000)
        root = page.evaluate('window.fixtureRoot')
        filename = 'controls-ux.cpp'
        Path(root, filename).write_text('int main() {\n  \n}\n')
        page.request.post(args.url + '/fixture/scenario', data={'scenario': 'empty'})
        frame.locator('.monaco-workbench').click(position={'x': 800, 'y': 450})
        quick = frame.locator('.quick-input-widget input')

        def access(text):
            page.keyboard.press(primary + '+p')
            expect(quick).to_be_visible()
            quick.fill(text)
            page.wait_for_timeout(350)
            page.keyboard.press('Enter')

        def command(text): access('>' + text)

        def choose(label):
            expect(quick).to_be_visible()
            quick.fill(label)
            row = frame.locator('.quick-input-list .monaco-list-row').filter(has_text=label).first
            expect(row).to_be_visible()
            page.keyboard.press('Enter')

        def menu(label):
            command('Aily: 自动补全设置')
            choose(label)

        def check(name, condition=True):
            assert condition, name
            checks.append(name)
            print('PASS', name, flush=True)

        def saved_config(matches):
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                value = json.loads(config_path.read_text())
                if matches(value): return True
                page.wait_for_timeout(50)
            return False

        def save():
            page.keyboard.press(primary + '+s')
            page.wait_for_timeout(500)

        def reload_file():
            page.reload()
            page.wait_for_load_state('networkidle')
            expect(frame.locator('.monaco-workbench')).to_be_visible(timeout=15000)
            frame.locator('.monaco-workbench').click(position={'x': 800, 'y': 450})
            access(str(Path(root, filename)))
            expect(quick).not_to_be_visible()

        access(str(Path(root, filename)))
        expect(quick).not_to_be_visible()
        command('Aily: 选择自动补全暂停时长')
        choose('30 分钟')
        paused = frame.get_by_role('button', name='Aily Tab 已暂停', exact=True)
        expect(paused).to_be_visible()
        check('pause reports its real state')
        reload_file()
        expect(paused).to_be_visible()
        check('pause survives a real page reload')
        before = page.request.get(args.url + '/fixture/state').json()['providerCalls']
        access(':2:3')
        page.keyboard.type(' ')
        page.wait_for_timeout(1500)
        check('reloaded pause blocks inference', page.request.get(args.url + '/fixture/state').json()['providerCalls'] == before)
        save()
        menu('恢复自动补全')
        expect(paused).not_to_be_visible()
        reload_file()
        expect(paused).not_to_be_visible()
        check('explicit resume remains resumed after reload')
        config_path = Path(root, '.vscode', 'settings.json')
        config_path.parent.mkdir(exist_ok=True)
        config_path.write_text(json.dumps({
            'aily.completion.enabled': False,
            'aily.completion.excludedExtensions': ['CPP', '.Cpp'],
            '[cpp]': {'editor.inlineSuggest.enabled': False},
        }))
        reload_file()
        expect(frame.get_by_role('button', name='Aily Tab 已关闭', exact=True)).to_be_visible()
        menu('启用自动补全')
        expect(frame.get_by_role('button', name='Aily Tab 当前文件已关闭', exact=True)).to_be_visible()
        check('enable updates an existing workspace override', saved_config(lambda value: value['aily.completion.enabled'] is True))
        menu('启用 .cpp 文件补全')
        check('extension resume removes every equivalent spelling', saved_config(lambda value: value['aily.completion.excludedExtensions'] == []))
        menu('启用编辑器行内建议')
        expect(frame.get_by_role('button', name='Aily Tab 当前文件已关闭', exact=True)).not_to_be_visible()
        check('native inline suggestions resume in their existing language override',
              saved_config(lambda value: value['[cpp]']['editor.inlineSuggest.enabled'] is True))
        menu('关闭 .cpp 文件补全')
        expect(frame.get_by_role('button', name='Aily Tab 当前文件已关闭', exact=True)).to_be_visible()
        command('Aily: 自动补全设置')
        check('disabled file names the extension and offers the reverse action',
              '.cpp' in (quick.get_attribute('placeholder') or ''))
        choose('启用 .cpp 文件补全')
        expect(frame.get_by_role('button', name='Aily Tab 当前文件已关闭', exact=True)).not_to_be_visible()
        check('extension can be disabled and enabled from the same menu')
        menu('关闭 cpp 语言补全')
        expect(frame.get_by_role('button', name='Aily Tab 当前文件已关闭', exact=True)).to_be_visible()
        menu('启用 cpp 语言补全')
        expect(frame.get_by_role('button', name='Aily Tab 当前文件已关闭', exact=True)).not_to_be_visible()
        check('language can be disabled and enabled from the same menu')
        menu('设置建议频率')
        choose('较少')
        menu('设置建议频率')
        check('frequency choices are readable and identify the current value',
              '当前' in frame.locator('.quick-input-list .monaco-list-row').filter(has_text='较少').inner_text())
        choose('标准')
        # Use a failed capability response to verify state priority, not a model.
        page.route('**/api/v4/code/capabilities', lambda route: route.fulfill(
            status=503, content_type='application/json', body=json.dumps({'detail': 'fixture unavailable'})))
        command('Aily: 选择自动补全暂停时长')
        choose('5 分钟')
        command('Aily: 重新连接补全服务')
        page.wait_for_timeout(1000)
        expect(paused).to_be_visible()
        check('service errors do not cover a deliberate pause')
        menu('关闭自动补全')
        expect(frame.get_by_role('button', name='Aily Tab 已关闭', exact=True)).to_be_visible()
        check('disabled state takes priority over pause and service failure')
        page.screenshot(path=str(output / '01-disabled.png'))
        page.unroute('**/api/v4/code/capabilities')
        menu('启用自动补全')
        command('Aily: 重新连接补全服务')
        expect(paused).not_to_be_visible()
        expect(frame.get_by_role('button', name='Aily Tab 已关闭', exact=True)).not_to_be_visible()
        check('enable clears a forgotten pause')
        page.request.post(args.url + '/fixture/scenario', data={'scenario': 'completion'})
        access(':2:3')
        page.keyboard.type(' ')
        expect(frame.locator('.ghost-text-decoration').first).to_be_visible(timeout=10000)
        page.keyboard.press('Tab')
        save()
        check('resumed editor still accepts and saves a real inline suggestion', 'return 0;' in Path(root, filename).read_text())
        page.keyboard.press(primary + '+z')
        save()
        check('one undo restores the code before acceptance', 'return 0;' not in Path(root, filename).read_text())
        command('Aily: 自动补全设置')
        page.screenshot(path=str(output / '02-settings.png'))
        page.keyboard.press('Escape')
        meaningful = [error for error in errors if 'lock() must be called from a primary top-level' not in error]
        check('no new runtime errors', not meaningful)
        (output / 'result.json').write_text(json.dumps({'checks': checks, 'errors': errors,
            'boundary': 'real built Workbench and host bridge; fixture auth, Redis, model, isolated temporary files'}, ensure_ascii=False, indent=2))
    except Exception:
        page.screenshot(path=str(output / 'failure.png'))
        print('FAILURE STATE', json.dumps({'errors': errors, 'completionButtons':
            frame.locator('[data-action-id="completion"]').evaluate_all('(nodes) => nodes.map(node => ({label: node.getAttribute("aria-label"), title: node.title}))')}, ensure_ascii=False), flush=True)
        raise
    finally:
        if not args.cdp: page.close()
        browser.close()
