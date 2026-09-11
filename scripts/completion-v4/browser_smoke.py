"""Exercise the built Coder UI using real keyboard/DOM actions against fixture_server.py."""
import json
import argparse
import sys
import tempfile
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

parser = argparse.ArgumentParser()
parser.add_argument('--cdp')
parser.add_argument('--browser-executable')
parser.add_argument('--shortcut-platform', choices=['mac', 'windows', 'linux'],
                    default='mac' if sys.platform == 'darwin' else 'windows' if sys.platform == 'win32' else 'linux')
args = parser.parse_args()
output = Path(tempfile.gettempdir()) / ('aily-v4-evidence' + ('-electron' if args.cdp else ''))
output.mkdir(exist_ok=True)
with sync_playwright() as p:
    executable = args.browser_executable
    mac_chrome = Path('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    if not executable and mac_chrome.exists(): executable = str(mac_chrome)
    browser = p.chromium.connect_over_cdp(args.cdp) if args.cdp else p.chromium.launch(
        headless=True, **({'executable_path': executable} if executable else {}))
    page = browser.contexts[0].pages[0] if args.cdp else browser.new_page()
    primary = 'Meta' if args.shortcut_platform == 'mac' else 'Control'
    palette = primary + '+p'; save_key = primary + '+s'; undo = primary + '+z'
    select_all = primary + '+a'; partial_word = primary + '+ArrowRight'
    partial_line = 'Control+Meta+ArrowRight' if args.shortcut_platform == 'mac' else 'Control+Alt+ArrowRight'
    page.set_viewport_size({'width': 1440, 'height': 1000})
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto('http://127.0.0.1:8019/')
    page.wait_for_load_state('networkidle')
    frame = page.frame_locator('iframe[title="Aily Coder v4 verification"]')
    expect(frame.locator('.monaco-workbench')).to_be_visible(timeout=15000)
    page.screenshot(path=str(output / '01-workbench.png'))
    checks = []
    # Reconnaissance above confirms the Workbench quick access entry.
    frame.locator('.monaco-workbench').click(position={'x': 800, 'y': 450})
    quick = frame.locator('.quick-input-widget input')
    root = page.evaluate('window.fixtureRoot')
    Path(root, 'main.cpp').write_text('int main() {\n  \n}\n')
    Path(root, 'rename.cpp').write_text('int oldName = 1;\n' + '// spacer\n' * 20 + 'int value = oldName;\n')
    Path(root, 'delete.cpp').write_text('int unused = 1;\nint main() { return 0; }\n')
    Path(root, 'multiline.cpp').write_text('int main() {\n  \n}\n')
    baseline = page.request.get('http://127.0.0.1:8019/fixture/state').json()
    def access(text):
        page.keyboard.press(palette); expect(quick).to_be_visible(); quick.fill(text)
        page.wait_for_timeout(350); page.keyboard.press('Enter'); expect(quick).not_to_be_visible()
    def command(text): access('>' + text)
    def snooze(label='5 分钟'):
        page.keyboard.press(palette); expect(quick).to_be_visible(); quick.fill('>Aily: 选择自动补全暂停时长')
        page.wait_for_timeout(350); page.keyboard.press('Enter'); expect(quick).to_be_visible(); quick.fill(label)
        page.wait_for_timeout(100); page.keyboard.press('Enter'); expect(quick).not_to_be_visible()
    def scenario(value): page.request.post('http://127.0.0.1:8019/fixture/scenario', data={'scenario': value})
    def disk(name):
        page.keyboard.press(save_key); page.wait_for_timeout(750)
        return Path(root, name).read_text()
    def check(name, condition):
        assert condition, name
        checks.append(name); print('PASS', name, flush=True)
    scenario('completion'); access(root + '/main.cpp')
    expect(frame.locator('.monaco-editor .view-lines')).to_be_visible(timeout=10000)
    access(':2:3'); page.keyboard.type(' ')
    expect(frame.locator('.ghost-text-decoration').first).to_be_visible(timeout=10000)
    page.screenshot(path=str(output / '02-completion.png'))
    page.keyboard.press('Tab')
    check('typing ghost -> native Tab -> saved disk', 'return 0;' in disk('main.cpp'))
    page.keyboard.press(undo)
    check('one undo removes accepted completion', 'return' not in disk('main.cpp'))
    scenario('empty'); page.keyboard.press('Escape')
    snooze('5 分钟')
    expect(frame.get_by_role('button', name='Aily Tab 已暂停', exact=True)).to_be_visible()
    before = page.request.get('http://127.0.0.1:8019/fixture/state').json()['providerCalls']
    page.keyboard.type(' '); page.wait_for_timeout(1700)
    check('snooze blocks network inference', page.request.get('http://127.0.0.1:8019/fixture/state').json()['providerCalls'] == before)
    command('Aily: 恢复自动补全')
    # A distant candidate comes from edit history + a real same-file lexical window.
    scenario('rename'); access(root + '/rename.cpp'); access(':1:5')
    page.keyboard.down('Shift')
    for _ in range(7): page.keyboard.press('ArrowRight')
    page.keyboard.up('Shift'); page.keyboard.insert_text('newName')
    page.keyboard.press('Escape')
    command('Aily: 触发 Aily Tab')
    expect(frame.locator('.aily-next-edit-preview')).to_be_attached(timeout=10000)
    original = disk('rename.cpp')
    page.keyboard.press('Tab')
    check('first Tab navigates without applying', disk('rename.cpp') == original)
    expect(frame.locator('.aily-next-edit-preview')).to_be_visible()
    page.screenshot(path=str(output / '03-distant-edit.png'))
    page.keyboard.press('Tab')
    check('second Tab applies distant edit', 'int value = newName;' in disk('rename.cpp'))
    page.keyboard.press(undo)
    check('one undo restores distant edit only', disk('rename.cpp') == original)
    # Whole-window deletion uses an empty replacement segment and remains undoable.
    scenario('delete'); access(root + '/delete.cpp'); access(':1:1')
    command('Aily: 触发 Aily Tab')
    expect(frame.locator('.aily-next-edit-preview')).to_be_visible(timeout=10000)
    page.screenshot(path=str(output / '04-deletion.png'))
    page.keyboard.press('Tab')
    check('deletion applies', 'unused' not in disk('delete.cpp'))
    page.keyboard.press(undo)
    check('one undo restores deletion', 'int unused = 1;' in disk('delete.cpp'))
    # Changing the source invalidates the shown edit; Tab cannot apply stale source.
    command('Aily: 触发 Aily Tab')
    expect(frame.locator('.aily-next-edit-preview')).to_be_visible(timeout=10000)
    page.keyboard.type(' ')
    expect(frame.locator('.aily-next-edit-preview')).not_to_be_attached()
    check('source edit invalidates preview', 'unused' in disk('delete.cpp'))
    scenario('completion'); access(root + '/main.cpp'); access(':2:3')
    # Partial acceptance uses the native model transaction and emits cumulative feedback.
    access(':2:3'); page.keyboard.type(' ')
    expect(frame.locator('.ghost-text-decoration').first).to_be_visible(timeout=10000)
    page.keyboard.press(partial_word)
    partially = disk('main.cpp')
    check('native partial word acceptance changes only a prefix', 'return' in partially and 'return 0;' not in partially)
    expect(frame.locator('.ghost-text-decoration').first).to_be_visible(timeout=10000)
    page.keyboard.press('Tab')
    check('remaining completion stays acceptable after a partial word', 'return 0;' in disk('main.cpp'))
    scenario('multiline'); access(root + '/multiline.cpp'); access(':2:3'); page.keyboard.type(' ')
    expect(frame.locator('.ghost-text-decoration').first).to_be_visible(timeout=10000)
    page.keyboard.press(partial_line)
    partially = disk('multiline.cpp')
    check('accept next line inserts only the first line', 'int result = 0;' in partially and 'return result;' not in partially)
    page.wait_for_timeout(1500)
    expect(frame.locator('.ghost-text-decoration').first).to_be_visible(timeout=10000)
    page.keyboard.press('Tab')
    check('remaining multiline completion is accepted', 'return result;' in disk('multiline.cpp'))
    # Aily Tab cross-file portal: the target begins unopened and each Tab has one job.
    scenario('empty')
    Path(root, 'Sensor.h').write_text('struct Sensor { int read(); };\n')
    Path(root, 'Sensor.cpp').write_text('#include "Sensor.h"\nint Sensor::read() { return 1; }\n')
    Path(root, 'Caller.cpp').write_text('#include "Sensor.h"\nint main() { Sensor sensor; return sensor.read(); }\n')
    access(root + '/Sensor.h')
    frame.locator('.monaco-editor .view-lines').click()
    page.keyboard.press(select_all); page.keyboard.insert_text('struct Sensor { int read(int scale); };\n')
    page.keyboard.press('Escape')
    check('source header is saved before cross-file prediction', 'read(int scale)' in disk('Sensor.h'))
    scenario('aily-tab'); command('Aily: 触发 Aily Tab')
    expect(frame.locator('.aily-tab-portal')).to_be_visible(timeout=15000)
    check('cross-file portal identifies unopened implementation', 'Sensor.cpp' in frame.locator('.aily-tab-portal').inner_text())
    page.screenshot(path=str(output / '06-aily-tab-cross-file.png'))
    original_target = Path(root, 'Sensor.cpp').read_text()
    page.keyboard.press('Tab')
    expect(frame.locator('.aily-tab-portal')).not_to_be_attached(timeout=10000)
    expect(frame.get_by_role('tab', name='Sensor.cpp', exact=True)).to_have_attribute('aria-selected', 'true')
    expect(frame.locator('.aily-next-edit-preview')).to_be_visible(timeout=10000)
    check('cross-file first Tab only opens target', Path(root, 'Sensor.cpp').read_text() == original_target)
    page.keyboard.press('Tab')
    expect(frame.locator('.aily-next-edit-preview')).not_to_be_attached(timeout=10000)
    check('cross-file second Tab applies verified target', 'read(int scale)' in disk('Sensor.cpp'))
    page.screenshot(path=str(output / '07-aily-tab-applied.png'))
    page.keyboard.press(undo)
    check('cross-file one undo leaves source change intact', disk('Sensor.cpp') == original_target and 'read(int scale)' in Path(root, 'Sensor.h').read_text())
    # Rejecting a portal stops the chain, without modifying the target.
    scenario('empty'); access(root + '/Sensor.h')
    frame.locator('.monaco-editor .view-lines').click()
    page.keyboard.press(select_all); page.keyboard.insert_text('struct Sensor { int read(int factor); };\n'); disk('Sensor.h')
    scenario('aily-tab'); command('Aily: 触发 Aily Tab')
    expect(frame.locator('.aily-tab-portal')).to_be_visible(timeout=15000)
    page.keyboard.press('Escape')
    expect(frame.locator('.aily-tab-portal')).not_to_be_attached()
    before_reject = page.request.get('http://127.0.0.1:8019/fixture/state').json()['providerCalls']
    page.wait_for_timeout(1700)
    check('Escape stops the prediction chain', page.request.get('http://127.0.0.1:8019/fixture/state').json()['providerCalls'] == before_reject)
    # A disk edit after preview must be re-read and cannot be overwritten by Tab.
    frame.locator('.monaco-editor .view-lines').click()
    page.keyboard.press(select_all); page.keyboard.insert_text('struct Sensor { int read(int multiplier); };\n')
    check('fresh source rename is saved before stale-target test', 'read(int multiplier)' in disk('Sensor.h'))
    command('Aily: 触发 Aily Tab')
    expect(frame.locator('.aily-tab-portal')).to_be_visible(timeout=15000)
    Path(root, 'Sensor.cpp').write_text('// external change\n' + original_target)
    page.keyboard.press('Tab')
    expect(frame.locator('.aily-next-edit-preview')).not_to_be_attached(timeout=10000)
    check('changed target is rejected before navigation/application', Path(root, 'Sensor.cpp').read_text().startswith('// external change'))
    page.evaluate('window.fixtureSignOut()')
    expect(frame.get_by_role('button', name='Aily Tab 需登录', exact=True)).to_be_visible(timeout=10000)
    check('account invalidation clears suggestions', frame.locator('.ghost-text-decoration').count() == 0)
    stats = page.request.get('http://127.0.0.1:8019/fixture/state').json()
    stats['requests'] = stats['requests'][len(baseline['requests']):]
    stats['feedback'] = stats['feedback'][len(baseline['feedback']):]
    check('Aily Tab requests one suggestion and never alternatives', bool(stats['requests']) and all(item['mode'] in ['completion', 'next-edit'] and item['options']['maxCandidates'] == 1 for item in stats['requests']))
    messages = page.evaluate('window.fixtureMessages')
    check('no legacy completion transport is used', not any(message.get('channel') == 'aily-coder-editor-code-completion-request' for message in messages))
    check('native feedback reaches actual server', any(item['event'] == 'accepted' for item in stats['feedback']))
    check('navigation and apply feedback are distinct', all(any(item['event'] == event for item in stats['feedback']) for event in ['jumped', 'applied']))
    meaningful = [error for error in errors if "lock() must be called from a primary top-level" not in error]
    check('no completion runtime errors', not meaningful)
    (output / 'browser-result.json').write_text(json.dumps({'checks': checks, 'errors': errors, 'providerCalls': stats['providerCalls'],
        'feedbackEvents': [item['event'] for item in stats['feedback']], 'workspace': root,
        'runtime': 'isolated Electron shell' if args.cdp else f'ChromeHeadless ({args.shortcut_platform} shortcuts)',
        'boundary': 'real built editor + real bridge + real backend/provider HTTP adapter; fixture auth/Redis/model'}, ensure_ascii=False, indent=2))
    browser.close()
