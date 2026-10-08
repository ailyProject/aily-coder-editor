"""Verify active-file selection using the isolated language-navigation fixture.

Start language-navigation-fixture.mjs first. --cdp-url must belong to an isolated
Electron window, never the user's work window. All fixture edits are temporary.
"""
import argparse
import json
from pathlib import Path
import tempfile
from playwright.sync_api import sync_playwright, expect

parser = argparse.ArgumentParser()
parser.add_argument('--base-url', default='http://127.0.0.1:8018')
parser.add_argument('--cdp-url')
parser.add_argument('--output', default=str(Path(tempfile.gettempdir()) / 'aily-view-active-file-evidence'))
args = parser.parse_args()
output = Path(args.output); output.mkdir(parents=True, exist_ok=True)
checks = []

with sync_playwright() as p:
    browser = p.chromium.connect_over_cdp(args.cdp_url) if args.cdp_url else p.chromium.launch(
        headless=True, executable_path='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    page = browser.contexts[0].pages[0] if args.cdp_url else browser.new_page(viewport={'width': 1440, 'height': 1000})
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(args.base_url); page.wait_for_load_state('networkidle')
    data = page.evaluate('fixture'); root = Path(data['root'])
    assert root.parent.name.startswith('aily-navigation-ui-') and root.name == 'project'
    files = {
        'sketch/src/first.cpp': 'int first() { return 1; }\n',
        'sketch/src/nested/deep/helper.cpp': 'int helper() { return 2; }\n',
        'sketch/src/other/helper.cpp': 'int other_helper() { return 3; }\n',
        'sketch/libraries/LocalProbe/src/Local.cpp': 'int local_read() { return 4; }\n',
        'node_modules/@aily-project/lib-probe/package.json': json.dumps({'name': '@aily-project/lib-probe', 'version': '1.0.0'}),
    }
    for relative, content in files.items():
        file = root / relative; file.parent.mkdir(parents=True, exist_ok=True); file.write_text(content)
    page.reload(); page.wait_for_load_state('networkidle')
    frame = page.frames[1]
    expect(frame.locator('.monaco-workbench')).to_be_visible(timeout=20000)
    tree = frame.get_by_role('tree', name='Aily View', exact=True)
    expect(tree).to_be_visible()
    frame.locator('.monaco-workbench').click(position={'x': 800, 'y': 350})
    quick = frame.locator('.quick-input-widget input')

    def check(name, value=True):
        assert value, name
        checks.append(name); print('PASS', name, flush=True)

    def open_file(relative):
        page.keyboard.press('Meta+p'); expect(quick).to_be_visible()
        quick.fill(str(root / relative)); page.wait_for_timeout(350)
        page.keyboard.press('Enter'); expect(quick).not_to_be_visible()
        expect(frame.locator('.tab.active')).to_contain_text(Path(relative).name)

    def selected(relative):
        row = tree.locator('[role="treeitem"][aria-selected="true"]')
        expect(row).to_have_attribute('aria-label', f'{Path(relative).name}\n{relative}')
        return row

    try:
        open_file('sketch/src/first.cpp'); selected('sketch/src/first.cpp')
        check('opening a project file selects its Aily View node')
        page.keyboard.type('/*FOCUS_STAYS_IN_EDITOR*/')
        expect(frame.locator('.editor-instance .view-lines:visible').first).to_contain_text('FOCUS_STAYS_IN_EDITOR')
        page.keyboard.press('Meta+z')
        check('automatic tree selection preserves keyboard focus in the editor')

        open_file('sketch/src/nested/deep/helper.cpp'); selected('sketch/src/nested/deep/helper.cpp')
        for relative in ['sketch/src/nested', 'sketch/src/nested/deep']:
            expect(tree.get_by_role('treeitem', name=f'{Path(relative).name}\n{relative}', exact=True)).to_have_attribute('aria-expanded', 'true')
        check('a deeply nested file expands every parent directory')

        open_file('sketch/src/other/helper.cpp'); selected('sketch/src/other/helper.cpp')
        check('files with the same basename select their precise path')
        page.keyboard.press('Control+Tab'); page.keyboard.press('Escape')
        selected('sketch/src/nested/deep/helper.cpp')
        check('activating an already open tab updates the tree selection')

        open_file('package.json'); selected('package.json')
        check('project configuration selects the Config file node')
        open_file('sketch/libraries/LocalProbe/src/Local.cpp'); selected('sketch/libraries/LocalProbe/src/Local.cpp')
        check('local library files select their node under Library')
        open_file('node_modules/@aily-project/lib-probe/src/Probe.cpp'); selected('node_modules/@aily-project/lib-probe/src/Probe.cpp')
        check('npm library files select the projected Library node')

        previous = tree.locator('[role="treeitem"][aria-selected="true"]').get_attribute('aria-label')
        page.keyboard.press('Meta+p'); expect(quick).to_be_visible()
        quick.fill(str(Path(data['core']) / 'SDK.cpp')); page.wait_for_timeout(350)
        page.keyboard.press('Enter'); expect(frame.locator('.tab.active')).to_contain_text('SDK.cpp')
        page.wait_for_timeout(500)
        check('opening an external SDK source leaves Aily View selection unchanged',
              tree.locator('[role="treeitem"][aria-selected="true"]').get_attribute('aria-label') == previous)

        open_file('sketch/src/first.cpp'); selected('sketch/src/first.cpp')
        page.keyboard.press('Meta+b'); expect(tree).not_to_be_visible()
        open_file('sketch/src/other/helper.cpp')
        page.keyboard.press('Meta+b'); expect(tree).to_be_visible()
        selected('sketch/src/other/helper.cpp')
        check('showing the sidebar synchronizes the file activated while hidden')
        page.screenshot(path=str(output / 'active-file-selection.png'))
        check('no tree reveal or source access page errors', not [error for error in errors if 'lock() must be called' not in error])
        (output / 'result.json').write_text(json.dumps({'checks': checks, 'errors': errors}, ensure_ascii=False, indent=2))
    except Exception:
        page.screenshot(path=str(output / 'failure.png'))
        (output / 'failure.txt').write_text(frame.locator('.monaco-workbench').inner_text())
        raise
    finally:
        browser.close()
