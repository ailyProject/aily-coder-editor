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

Run `python scripts/completion-v4/controls_smoke.py` for pause/reload/resume,
effective workspace and language settings, extension normalization, status
priority during service failures, and resumed acceptance/save/undo. It uses only
the fixture workspace and records results/screenshots in the platform temporary
directory under `aily-tab-controls-evidence`. With the isolated Electron shell,
pass `--cdp http://127.0.0.1:9255`; evidence uses the `-electron` suffix.

For isolated Electron testing, from the host repository run:

```sh
node node_modules/electron/cli.js <coder-repo>/scripts/completion-v4/electron-shell.cjs
```

Then from Coder run `python scripts/completion-v4/browser_smoke.py --cdp http://127.0.0.1:9255`.
This uses temporary Electron userData, a hidden window and no user credentials.
Evidence is written to `/tmp/aily-v4-evidence-electron`. Run UI suites sequentially;
they share the fixture filesystem. Stop both servers with Ctrl+C when finished.
## 剪切复制上下文专项

在本文的隔离 fixture 启动后执行 `python scripts/completion-v4/clipboard_smoke.py`；
独立 Electron 使用 `--cdp http://127.0.0.1:9255`。脚本调用真实编辑器快捷键，验证
复制、剪切、多光标 CRLF、空选区整行复制、两类请求的模型输入、Tab、撤销、清空、
关闭／重开以及页面重载。输出在系统临时目录的 `aily-tab-clipboard-evidence` 或
`aily-tab-clipboard-evidence-electron`，包括截图、结果和原始运行时错误。
固定模型只根据收到的剪切复制上下文返回建议，用于证明真实协议与交互链路；不证明真实模型效果。

## 鼠标同词替换专项

`python scripts/completion-v4/repeated_word_smoke.py` 使用真实键鼠验证手动更名后点击另一处旧词的局部建议。
可加 `--cdp http://127.0.0.1:9255` 验证独立 Electron。全程使用 `scenario=empty`，
模型始终不提供建议，以验证本地完整词匹配、预览、Tab、撤销、Esc、词尾修改、先删后输和子串排除。
证据位于系统临时目录 `aily-tab-repeated-word-evidence[-electron]`，包括原生点击坐标、截图和运行时记录。
