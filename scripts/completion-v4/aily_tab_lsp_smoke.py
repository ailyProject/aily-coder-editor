"""Real clangd + built editor: missing header, atomic code/import, undo and disk compilation.

Run fixture_server.py and the localhost LSP proxy on port 3031 first.
"""
import argparse
import json
import sys
import tempfile
from pathlib import Path
import subprocess
from playwright.sync_api import sync_playwright, expect

parser = argparse.ArgumentParser()
parser.add_argument('--base-url', default='http://127.0.0.1:8019')
parser.add_argument('--browser-executable')
parser.add_argument('--shortcut-platform', choices=['mac', 'windows', 'linux'],
                    default='mac' if sys.platform == 'darwin' else 'windows' if sys.platform == 'win32' else 'linux')
args = parser.parse_args()
output = Path(tempfile.gettempdir()) / 'aily-tab-lsp-evidence'
output.mkdir(exist_ok=True)
with sync_playwright() as p:
    executable = args.browser_executable
    mac_chrome = Path('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    if not executable and mac_chrome.exists(): executable = str(mac_chrome)
    browser = p.chromium.launch(headless=True, **({'executable_path': executable} if executable else {}))
    page = browser.new_page(viewport={'width': 1440, 'height': 1000})
    primary = 'Meta' if args.shortcut_platform == 'mac' else 'Control'
    palette = primary + '+p'; save_key = primary + '+s'; undo = primary + '+z'
    redo = 'Meta+Shift+z' if args.shortcut_platform == 'mac' else 'Control+Y'
    partial_word = primary + '+ArrowRight'
    partial_line = 'Control+Meta+ArrowRight' if args.shortcut_platform == 'mac' else 'Control+Alt+ArrowRight'
    page.goto(args.base_url); page.wait_for_load_state('networkidle')
    root = Path(page.evaluate('window.fixtureRoot'))
    diagnostic_source = '#include <string>\nint main() { std::vector<int> values; return values.size(); }\n'
    completion_source = '#include <string>\nint main() {\n  std::vec\n}\n'
    (root / 'imports.cpp').write_text(diagnostic_source)
    (root / 'imports-completion.cpp').write_text(completion_source)
    (root / 'compile_flags.txt').write_text('-std=c++17\n')
    page.locator('iframe').evaluate("el => el.src += '&lspWs=' + encodeURIComponent('ws://127.0.0.1:3031')")
    page.wait_for_load_state('networkidle')
    frame = page.frame_locator('iframe')
    expect(frame.locator('.monaco-workbench')).to_be_visible(timeout=20000)
    frame.locator('.monaco-workbench').click(position={'x': 800, 'y': 450})
    quick = frame.locator('.quick-input-widget input')
    def access(text):
        page.keyboard.press(palette); expect(quick).to_be_visible(); quick.fill(text)
        page.wait_for_timeout(350); page.keyboard.press('Enter'); expect(quick).not_to_be_visible()
    def command(text): access('>' + text)
    def save(name):
        page.keyboard.press(save_key); page.wait_for_timeout(500); return (root / name).read_text()
    def scenario(value): page.request.post(args.base_url + '/fixture/scenario', data={'scenario': value})
    checks = []
    def check(label, condition):
        assert condition, label
        checks.append(label); print('PASS', label, flush=True)
    try:
        scenario('empty'); access(str(root / 'imports.cpp')); page.wait_for_timeout(3000)
        access(':2:25'); command('Aily: 触发 Aily Tab')
        expect(frame.locator('.aily-next-edit-preview')).to_be_visible(timeout=15000)
        check('clangd missing-header fix is previewed', '#include <vector>' in frame.locator('.aily-next-edit-preview').inner_text())
        page.screenshot(path=str(output / '01-diagnostic-import.png'))
        page.keyboard.press('Tab'); expect(frame.locator('.aily-next-edit-preview')).not_to_be_attached(timeout=10000)
        text = save('imports.cpp')
        check('verified include is inserted once', text.count('#include <vector>') == 1 and '#include <string>' in text)
        expect(frame.locator('.monaco-editor .squiggly-error')).to_have_count(0, timeout=10000)
        check('clangd errors clear after accepting the fix', True)
        page.keyboard.press(undo); check('one undo restores missing-header source', save('imports.cpp') == diagnostic_source)
        scenario('empty'); access(str(root / 'imports-completion.cpp')); page.wait_for_timeout(2000)
        access(':3:11'); page.keyboard.press('Escape')
        scenario('import-completion'); command('Aily: 触发 Aily Tab')
        expect(frame.locator('.aily-next-edit-preview')).to_be_visible(timeout=15000)
        check('proposed symbol and its clangd include share one preview', 'tor<int> values;' in frame.locator('.aily-next-edit-preview').inner_text() and '#include <vector>' in frame.locator('.aily-next-edit-preview').inner_text())
        page.screenshot(path=str(output / '02-atomic-code-import.png'))
        page.keyboard.press('Tab'); expect(frame.locator('.aily-next-edit-preview')).not_to_be_attached(timeout=10000)
        text = save('imports-completion.cpp')
        check('one acceptance inserts code and include', 'std::vector<int> values;' in text and text.count('#include <vector>') == 1)
        build = subprocess.run(['clang++', '-std=c++17', '-fsyntax-only', str(root / 'imports-completion.cpp')], capture_output=True, text=True)
        check('saved imported-symbol source compiles', build.returncode == 0)
        page.keyboard.press(undo); check('one undo removes both code and include', save('imports-completion.cpp') == completion_source)
        page.keyboard.press(redo); check('one redo restores code and include', save('imports-completion.cpp') == text)
        page.screenshot(path=str(output / '03-saved-import.png'))
        page.keyboard.press(undo); save('imports-completion.cpp')
        access(':3:11'); command('Aily: 触发 Aily Tab')
        expect(frame.locator('.aily-next-edit-preview')).to_be_visible(timeout=15000)
        expect(frame.locator('.aily-next-edit-preview button').filter(has_text='逐词')).to_be_visible()
        page.keyboard.press(partial_word)
        expect(frame.locator('.aily-next-edit-added').last).to_contain_text('<int> values;', timeout=10000)
        partial = save('imports-completion.cpp')
        check('word acceptance adds the import only when vector is complete', 'std::vector\n' in partial and 'values;' not in partial and partial.count('#include <vector>') == 1)
        page.screenshot(path=str(output / '04-partial-import.png'))
        page.keyboard.press(undo); check('partial word and its import undo together', save('imports-completion.cpp') == completion_source)
        access(':3:11'); command('Aily: 触发 Aily Tab')
        expect(frame.locator('.aily-next-edit-preview')).to_be_visible(timeout=15000)
        page.keyboard.press(partial_word)
        expect(frame.locator('.aily-next-edit-added').last).to_contain_text('<int> values;', timeout=10000)
        page.keyboard.press(partial_line)
        expect(frame.locator('.aily-next-edit-preview')).not_to_be_attached(timeout=10000)
        check('remaining line uses rebased coordinates without duplicate imports', save('imports-completion.cpp') == text)
        state = page.request.get(args.base_url + '/fixture/state').json()
        check('partial import acceptance reports cumulative source characters', any(item['event'] == 'partially_accepted' and item.get('acceptedCharacters') == 3 for item in state['feedback']) and any(item['event'] == 'applied' and item.get('acceptedCharacters') == len('tor<int> values;') for item in state['feedback']))
        (output / 'result.json').write_text(json.dumps({'checks': checks, 'shortcutPlatform': args.shortcut_platform,
            'workspace': str(root), 'boundary': 'actual clangd, built editor and host bridge; deterministic model/auth/Redis'}, ensure_ascii=False, indent=2))
    except Exception:
        page.screenshot(path=str(output / 'failure.png')); raise
    finally:
        scenario('empty'); browser.close()
