"""Built Coder + real clangd UI acceptance in the isolated navigation fixture.

Start language-navigation-fixture.mjs first. Optionally connect to an isolated
Electron window with --cdp-url; never connect this test to a user's work window.
"""
import argparse
import json
import re
from pathlib import Path
import tempfile
from playwright.sync_api import sync_playwright, expect

parser = argparse.ArgumentParser()
parser.add_argument('--base-url', default='http://127.0.0.1:8018')
parser.add_argument('--browser-executable', default='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
parser.add_argument('--cdp-url')
parser.add_argument('--output', default=str(Path(tempfile.gettempdir()) / 'aily-navigation-evidence'))
args = parser.parse_args()
output = Path(args.output); output.mkdir(parents=True, exist_ok=True)
checks = []

with sync_playwright() as p:
    browser = p.chromium.connect_over_cdp(args.cdp_url) if args.cdp_url else p.chromium.launch(headless=True, executable_path=args.browser_executable)
    page = browser.contexts[0].pages[0] if args.cdp_url else browser.new_page(viewport={'width': 1440, 'height': 1000})
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(args.base_url); page.wait_for_load_state('networkidle')
    data = page.evaluate('fixture'); root = Path(data['root']); frame = page.frames[1]
    expect(frame.locator('.monaco-workbench')).to_be_visible(timeout=20000)
    frame.locator('.monaco-workbench').click(position={'x': 800, 'y': 350})
    quick = frame.locator('.quick-input-widget input')

    def check(name, value=True):
        assert value, name
        checks.append(name); print('PASS', name, flush=True)

    def go(text):
        page.keyboard.press('Meta+p'); expect(quick).to_be_visible()
        quick.fill(text); page.wait_for_timeout(400); page.keyboard.press('Enter'); expect(quick).not_to_be_visible()

    def source(word):
        page.keyboard.press('Escape')
        go(str(root / 'main.cpp'))
        go(f":5:{data['source'].splitlines()[4].index(word) + 2}")

    def content():
        return frame.locator('.editor-instance .view-lines:visible').first.inner_text().replace('\u00a0', ' ')

    def menu():
        page.keyboard.press('Shift+F10')
        expect(frame.locator('.monaco-menu')).to_be_visible()
        # VS Code deliberately arms menu mouse-up handlers after 100 ms.
        page.wait_for_timeout(180)
        return frame.locator('.monaco-menu')

    try:
        go(str(root / 'main.cpp')); page.wait_for_timeout(1800)
        check('project source has working C++ language navigation', 'Probe probe' in content())
        source('sdkRead'); page.keyboard.press('F12')
        expect(frame.locator('.tab.active')).to_contain_text('SDK.cpp', timeout=10000)
        expect(frame.locator('.editor-instance .view-lines:visible').first).to_contain_text('SDK_GLOBAL')
        check('F12 opens the actual external SDK implementation', 'return SDK_GLOBAL' in content())
        before = (Path(data['core']) / 'SDK.cpp').read_text()
        page.keyboard.type('SHOULD_NOT_WRITE'); page.keyboard.press('Meta+s'); page.wait_for_timeout(250)
        check('external SDK source rejects edits and stays unchanged', (Path(data['core']) / 'SDK.cpp').read_text() == before and 'SHOULD_NOT_WRITE' not in content())
        page.screenshot(path=str(output / '01-sdk-definition-readonly.png'))

        source('read'); m = menu()
        for label in ['Go to Definition', 'Go to Declaration', 'Go to Type Definition', 'Go to Implementations', 'Find All References', 'Show Call Hierarchy', 'Rename Symbol']:
            check(f'context menu exposes {label}', m.get_by_role('menuitem', name=label, exact=False).count() > 0)
        page.screenshot(path=str(output / '02-navigation-menu.png'))
        m.get_by_role('menuitem', name='Go to Declaration', exact=True).click()
        expect(frame.locator('.tab.active')).to_contain_text('Probe.h')
        check('declaration opens installed library header', 'struct Probe' in content())

        source('read'); menu().get_by_role('menuitem', name='Go to Implementations', exact=False).click()
        expect(frame.locator('.tab.active')).to_contain_text('Probe.cpp')
        check('implementation opens installed library body', 'Probe::read()' in content())

        source('ENV_GLOBAL'); page.keyboard.press('F12')
        expect(frame.locator('.tab.active')).to_contain_text('Environment.h')
        check('global include environment jumps outside project and SDK', '#define ENV_GLOBAL 11' in content())

        source('probe'); menu().get_by_role('menuitem', name='Go to Type Definition', exact=True).click()
        expect(frame.locator('.tab.active')).to_contain_text('Probe.h')
        check('type definition navigates to library type', 'struct Probe' in content())

        source('probe'); page.keyboard.press('Shift+F12')
        expect(frame.locator('.peekview-widget')).to_be_visible(timeout=10000)
        check('peek references renders the real source results', frame.locator('.peekview-widget').inner_text().count('probe') >= 1)
        page.screenshot(path=str(output / '03-peek-references.png'))
        page.keyboard.press('Escape')

        source('run'); menu().get_by_role('menuitem', name='Show Call Hierarchy', exact=False).click()
        hierarchy = frame.get_by_role('tree', name=re.compile('Callers Of|Calls From'))
        expect(hierarchy).to_be_visible(timeout=10000)
        check('call hierarchy opens its interactive view', 'run' in hierarchy.inner_text())
        hierarchy.get_by_role('button', name='Dismiss').click()

        source('probe'); page.keyboard.press('F2')
        rename = frame.locator('input.rename-input')
        expect(rename).to_be_visible(); rename.fill('sensor'); page.keyboard.press('Enter')
        expect(rename).not_to_be_visible()
        expect(frame.locator('.editor-instance .view-lines:visible').first).to_contain_text('sensor.read()')
        page.keyboard.press('Meta+s'); page.wait_for_timeout(500)
        changed = (root / 'main.cpp').read_text()
        check('rename updates declaration and usage and saves real file', 'Probe sensor;' in changed and 'sensor.read()' in changed and 'probe.read()' not in changed)
        page.keyboard.press('Meta+z')
        expect(frame.locator('.editor-instance .view-lines:visible').first).to_contain_text('probe.read()')
        page.keyboard.press('Meta+s'); page.wait_for_timeout(500)
        check('one undo restores and saves the original project source', (root / 'main.cpp').read_text() == data['source'])
        check('no language-source access or navigation page errors', not [error for error in errors if 'lock() must be called' not in error])
        (output / 'result.json').write_text(json.dumps({'checks': checks, 'errors': errors}, ensure_ascii=False, indent=2))
    except Exception:
        page.screenshot(path=str(output / 'failure.png'))
        (output / 'failure.txt').write_text(frame.locator('.monaco-workbench').inner_text())
        raise
    finally:
        browser.close()
