# v4 completion integration checks

This harness exercises the production Coder build, the production Angular bridge
class, and the actual `aily-services` v4 router/service/provider HTTP adapter.
DI/auth, benefits, Redis and model replies are explicit test fixtures. File writes
are restricted to a generated temporary workspace. It does not certify production
JWT/Kong, a real model, Windows, or the Angular host's Arduino build lifecycle.

Prerequisites: Node, Python 3.12+, Chrome, the sibling host/services repositories.
In a Python virtualenv, install the server's `services/ai/requirements-test-v4.txt`
and `playwright`. Scripts currently use the installed macOS Chrome executable.

From this Coder repo:

```sh
npm run build
npm run test:completion-v4
node scripts/completion-v4/build-host.mjs <host-repo> /tmp/aily-v4-host
python scripts/completion-v4/fixture_server.py --services <services-repo> --coder "$PWD" --host-bundle /tmp/aily-v4-host
```

In another terminal, run `python scripts/completion-v4/browser_smoke.py`.
Evidence is written to `/tmp/aily-v4-evidence`.

For isolated Electron testing, from the host repository run:

```sh
node node_modules/electron/cli.js <coder-repo>/scripts/completion-v4/electron-shell.cjs
```

Then from Coder run `python scripts/completion-v4/browser_smoke.py --cdp http://127.0.0.1:9255`.
This uses temporary Electron userData, a hidden window and no user credentials.
Evidence is written to `/tmp/aily-v4-evidence-electron`. Run UI suites sequentially;
they share the fixture filesystem. Stop both servers with Ctrl+C when finished.
