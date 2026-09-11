"""Real-provider Aily Tab acceptance with an isolated test gateway/account/filesystem.

Run fixture_server.py --real-model --port 8020 first. No provider keys enter the browser.
"""
import argparse
import json
import sys
import tempfile
from pathlib import Path
import subprocess
from playwright.sync_api import sync_playwright, expect

parser = argparse.ArgumentParser()
parser.add_argument('--base-url', default='http://127.0.0.1:8020')
parser.add_argument('--cdp')
parser.add_argument('--browser-executable')
parser.add_argument('--shortcut-platform', choices=['mac', 'windows', 'linux'],
                    default='mac' if sys.platform == 'darwin' else 'windows' if sys.platform == 'win32' else 'linux')
args = parser.parse_args()
output = Path(tempfile.gettempdir()) / 'aily-tab-real-evidence'
output.mkdir(exist_ok=True)
with sync_playwright() as p:
    executable = args.browser_executable
    mac_chrome = Path('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    if not executable and mac_chrome.exists(): executable = str(mac_chrome)
    browser = p.chromium.connect_over_cdp(args.cdp) if args.cdp else p.chromium.launch(
        headless=True, **({'executable_path': executable} if executable else {}))
    page = browser.contexts[0].pages[0] if args.cdp else browser.new_page()
    primary = 'Meta' if args.shortcut_platform == 'mac' else 'Control'
    palette = primary + '+p'; save_key = primary + '+s'; select_all = primary + '+a'
    undo = primary + '+z'; redo = 'Meta+Shift+z' if args.shortcut_platform == 'mac' else 'Control+Y'
    page.set_viewport_size({'width': 1440, 'height': 1000})
    errors = []; page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(args.base_url); page.wait_for_load_state('networkidle')
    frame = page.frame_locator('iframe[title="Aily Coder v4 verification"]')
    expect(frame.locator('.monaco-workbench')).to_be_visible(timeout=20000)
    page.screenshot(path=str(output / '01-workbench.png'))
    root = Path(page.evaluate('window.fixtureRoot'))
    frame.locator('.monaco-workbench').click(position={'x': 800, 'y': 450})
    quick = frame.locator('.quick-input-widget input')
    def access(text):
        page.keyboard.press(palette); expect(quick).to_be_visible(); quick.fill(text)
        page.wait_for_timeout(350); page.keyboard.press('Enter'); expect(quick).not_to_be_visible()
    def command(text): access('>' + text)
    def snooze(label='5 分钟'):
        page.keyboard.press(palette); expect(quick).to_be_visible(); quick.fill('>Aily: 选择自动补全暂停时长')
        page.wait_for_timeout(350); page.keyboard.press('Enter'); expect(quick).to_be_visible(); quick.fill(label)
        page.wait_for_timeout(100); page.keyboard.press('Enter'); expect(quick).not_to_be_visible()
    def save():
        page.keyboard.press(save_key); page.wait_for_timeout(350)
    checks = []
    def check(label, condition):
        assert condition, label
        checks.append(label); print('PASS', label, flush=True)
    try:
        snooze('5 分钟')
        header = 'struct Sensor { int read(); };\n'
        implementation = '#include "Sensor.h"\nint Sensor::read() { return 1; }\n'
        caller = '#include "Sensor.h"\nint main() { Sensor sensor; return sensor.read(); }\n'
        (root / 'Sensor.h').write_text(header)
        (root / 'Sensor.cpp').write_text(implementation)
        (root / 'Caller.cpp').write_text(caller)
        access(str(root / 'Sensor.h'))
        frame.locator('.monaco-editor .view-lines').click()
        page.keyboard.press(select_all); page.keyboard.insert_text('struct Sensor { int read(int scale); };\n'); save()
        command('Aily: 恢复自动补全'); command('Aily: 触发 Aily Tab')
        expect(frame.locator('.aily-tab-portal')).to_be_visible(timeout=20000)
        page.screenshot(path=str(output / '02-real-cross-file.png'))
        originals = {'Sensor.cpp': implementation, 'Caller.cpp': caller}
        changed = []
        for step in range(2):
            if step:
                expect(frame.locator('.aily-tab-portal')).to_be_visible(timeout=20000)
            portal = frame.locator('.aily-tab-portal').inner_text()
            target = next((name for name in originals if name in portal), None)
            check(f'prediction {step + 1} identifies a remaining related source', target is not None and target not in changed)
            page.screenshot(path=str(output / f'0{2 + step * 2}-real-portal.png'))
            page.keyboard.press('Tab')
            expect(frame.locator('.aily-tab-portal')).not_to_be_attached(timeout=15000)
            expect(frame.get_by_role('tab', name=target, exact=True)).to_have_attribute('aria-selected', 'true')
            expect(frame.locator('.aily-next-edit-preview')).to_be_visible(timeout=15000)
            check(f'first Tab for {target} navigates without writing', (root / target).read_text() == originals[target])
            page.screenshot(path=str(output / f'0{3 + step * 2}-real-preview.png'))
            page.keyboard.press('Tab'); expect(frame.locator('.aily-next-edit-preview')).not_to_be_attached(timeout=15000); save()
            updated = (root / target).read_text()
            check(f'second Tab applies the required edit to {target}', 'Sensor::read(int scale)' in updated if target == 'Sensor.cpp' else 'sensor.read()' not in updated)
            changed.append(target)
        built = subprocess.run(['clang++', '-std=c++17', '-fsyntax-only', str(root / 'Sensor.cpp'), str(root / 'Caller.cpp')], capture_output=True, text=True)
        check('saved three-file C++ source compiles', built.returncode == 0)
        page.keyboard.press(undo); save()
        check('one undo restores only the last accepted file', (root / changed[-1]).read_text() == originals[changed[-1]] and (root / changed[0]).read_text() != originals[changed[0]])
        page.keyboard.press(redo); save()
        page.screenshot(path=str(output / '05-real-saved.png'))
        snooze('5 分钟')
        state = page.request.get(args.base_url + '/fixture/state').json()
        check('real-model feedback distinguishes jump and application', all(any(item['event'] == event for item in state['feedback']) for event in ['jump_shown', 'jumped', 'applied']))
        (output / 'result.json').write_text(json.dumps({'checks': checks, 'metrics': state.get('metrics', []), 'feedback': state['feedback'], 'errors': errors,
            'boundary': 'actual built editor/host bridge/backend/real configured model; isolated auth, benefits and Redis; clang++ disk validation',
            'shortcutPlatform': args.shortcut_platform, 'workspace': str(root), 'predictionOrder': changed}, ensure_ascii=False, indent=2))
    except Exception:
        page.screenshot(path=str(output / 'failure.png'))
        (output / 'failure.json').write_text(json.dumps({'checks': checks, 'errors': errors, 'state': page.request.get(args.base_url + '/fixture/state').json()}, ensure_ascii=False, indent=2))
        raise
    finally:
        browser.close()
