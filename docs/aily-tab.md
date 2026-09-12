# Aily Coder Aily Tab

Coder 的自动补全统一使用 Aily Tab。交互能力曾参考同类编辑器的 Tab 补全设计，通过 Aily 自有模型服务实现；没有调用第三方编辑器内部 API，也不宣称模型准确率或延迟与第三方产品相同。

## 操作

- 输入后自动显示当前位置续写；代码替换后停顿会查找后续一致性修改，鼠标点击代码附近或选中单词/语段也会触发下一处修改预测。
- 手动将一个词改名后，鼠标单击同文件另一处完整旧词或双击选中它，会优先显示相同替换；按 Tab 只接受当前词，Esc 拒绝。此类明确意图在编辑器本地匹配，不等待模型，也不会自动批量重命名。支持逐字慢速输入、局部词尾修改和先删除再输入；不匹配更长标识符里的子串。
- 在当前项目的代码编辑器中剪切、复制后，后续续写和下一处修改会参考这些代码、来源文件和操作类型。复制可辅助符号及代码模式复用，剪切可辅助在新位置继续编辑；是否给出建议仍由模型根据当前位置判断。
- 接受任一建议后继续预测下一项，单条预测链最多 5 步；没有足够依据时不显示建议。
- Tab 接受建议；远处或跨文件建议先 Tab 定位并审阅，再 Tab 接受；Esc 拒绝并停止当前预测链。
- macOS 用 Cmd+Right 逐词接受，Ctrl+Cmd+Right 逐行接受。Windows 对应 Ctrl+Right、Ctrl+Alt+Right。
- 带导入的纯插入也支持逐词/逐行接受：接受到完整符号时加入经过语言服务验证的 import/include，该步一起撤销；替换/删除只支持整条接受。
- Alt+反斜杠或命令“Aily: 触发 Aily Tab”立即预测。左侧顶部 Aily Tab 按钮可选择暂停时长、恢复、按语言/扩展名关闭和调整建议频率。
- 暂停可选 5 分钟、30 分钟、1 小时、8 小时；同一编辑器配置中的页面重载保留原截止时间，恢复操作也会持久化。暂停不会因重载重新计时，到期只恢复后续建议，不重放旧请求。
- 设置菜单直接显示“启用/关闭 .cpp 文件补全”等当前可执行操作；`cpp`、`CPP`、`.Cpp` 视为同一扩展名。状态提示说明全局、暂停、文件类型、语言或编辑器行内建议的关闭原因。
- 设置操作修改当前生效的用户、工作区或语言配置；建议频率显示“较少/标准/更多”，并标记当前值。菜单提供自定义快捷键入口。
- 多个导入来源需要用户选择；库、SDK、生成文件只作为上下文，不接受补全修改。

## 设置

| 设置 | 默认值 | 作用 |
|---|---|---|
| `aily.completion.enabled` | true | 全局启用 |
| `aily.completion.clipboardContext` | true | 使用当前项目最近剪切、复制的代码作为补全上下文 |
| `aily.completion.crossFile` | true | 允许关联源码预测 |
| `aily.completion.autoImports` | true | 使用经过 LSP 验证的导入 |
| `aily.completion.languages` | `*`: true，plaintext/markdown: false | 按语言控制 |
| `aily.completion.excludedExtensions` | `[]` | 按扩展名关闭 |
| `aily.completion.suggestInComments` | true | 注释内部建议 |
| `aily.completion.debounceMs` | 300 | 自动续写等待时间 |
| `aily.completion.eagerness` | standard | less / standard / more |
| `aily.completion.nextEdit.fixes` | true | 诊断感知修复 |
| `aily.completion.nextEdit.extendedRange` | true | 远处实现与引用 |
| `aily.completion.nextEdit.showCollapsed` | false | 先折叠展示位置 |

`editor.inlineSuggest.enabled` 同样生效，手动触发不能绕过关闭。旧 `mode=insert` 和 `nextEdit.enabled=false` 迁移到统一流程；旧 `mode=off` 在没有显式 enabled 设置时迁移为 enabled=false。已取消仅续写模式、候选比较面板、上下候选快捷键、本地 FIM、旧 v3 客户端和旧宿主桥接。服务不兼容时显示不可用，不回退其他 provider。

服务报错不覆盖用户主动暂停或关闭的状态。若原生行内建议被关闭，补全设置中会出现对应启用入口。主动重新启用自动补全会清除此前暂停；按语言、扩展名的独立关闭仍然有效。

剪切复制历史仅来自当前项目中可参与补全的源码编辑器，不读取系统剪贴板或其他应用。编辑器内存最多保留最近 5 分钟的 5 条记录，每条最多 2048 个 UTF-16 单元，总计最多 4096；按最近操作优先，同文件同内容去重。内容在后续补全请求中发往补全服务，剪切／复制操作本身不会直接发起模型请求。重载、切换项目或账号会清空；设置菜单可关闭“剪切复制联想”或“清空剪切复制历史”，命令面板也提供清空命令。关闭会清除旧内容，再次启用只记录新的操作。

同词替换意图与剪切复制历史分别维护：仅记住最近 60 秒内的人工单词修改，最多 8 个文件、每文件 8 条，单词最多 256 个 UTF-16 单元。剪切、AI 接受和外部修改不产生人工替换意图；AI 修改其他出现位置可保留先前意图，改动原源词则使它失效。撤销／重做或外部修改清除该文件意图，关闭文档、项目／账号切换和重载也会清除。停用、暂停、注释设置、只读接受保护和 Esc 后 30 秒同位置拒绝规则继续生效。

## 实现与联调

入口 `src/main.common.ts` 只加载 `features/completion/completionFeature.ts`，由它直接注册唯一的行内 provider。`completion` 和 `next-edit` 是统一控制器内两种结构化操作，不是用户可切换的补全产品模式。每次最多一条建议。

链路为编辑器上下文/快照 → `CodeSuggestionHostBridgeService` → `/api/v4/code` → 受 windowId 约束的模型输出 → 完整 SSE 校验 → 目标缓冲区原子编辑 → 保存。光标处 `completion` 可由服务端优先路由到 DeepSeek FIM（原生 prefix/suffix），服务端再封装为相同的 v4 校验结果；`next-edit` 继续使用结构化 Chat 模型，并区分 `edit`、`accept`、`cursor`、`selection` 等机会来源。选区作为 `active.selection` 传递，且必须精确对应一个已授权可编辑窗口；光标移动和选区变化不能放宽文件、范围或快照校验。局部重命名会在同一个受控代码窗口内组合明确的剩余引用，以左右内联差异一次预览、一次 Tab 原子接受；远距离或跨文件目标仍保持逐位置预测以及先跳转再接受。模型地址、选择与密钥始终只在服务端，Coder 不恢复本地 provider。宿主与服务端同时升级；共享服务的旧 v3 路由保留给其他客户端，Coder 不再连接它。

可选 `clipboardHistory` 同时由 Coder、宿主与服务端校验。它只包含操作、代码摘录、相对路径、语言和时间差，不添加可编辑文件或窗口。Chat 提示词将其作为参考数据；FIM 在原始 prefix 前追加注释编码的参考，原始 prefix 尾部、suffix、插入位置和结果校验保持原语义。编辑器和宿主须配套升级，客户端仅在服务声明 `features.clipboardContext=true` 时发送历史；旧服务继续使用原补全请求，菜单说明升级服务后生效。

SDK 声明由 Electron preload 的 `readCodeDeclaration` 按宿主解析的安装根目录读取；只允许头文件、realpath 检查和大小限制，发往服务端的路径为 `@sdk/...`。新增 preload 方法需要重启主软件。编辑器构建用 `npm run build`，开发链接用 `node scripts/link-dev.mjs --skip-build`，撤销链接用 `npm run dev:unlink`。

执行 `npm run test:aily-tab` 验证协议、上下文、权限、历史、配置迁移、撤销事务与带导入部分接受。`scripts/completion-v4/` 提供浏览器/Electron、真实模型和真实 clangd 联调脚本；后端须按 harness 帮助启动。此目录名保留 HTTP v4 含义。

2026-09-10 验证：70 个 Coder 测试、16 个宿主桥接/生命周期测试、33 个后端测试、1 个 SDK 文件边界测试通过；Chrome 和独立 Electron 各 25 项，真实模型三文件联动 9 项，真实 clangd 13 项通过。源码保存到磁盘后通过 clang++ 语法编译。鉴权/权益/Redis 在独立 harness 中替换，真实模型测试只替换网关与状态设施；生产登录链、Windows 实机和 Arduino 主板构建/烧录不属于这些通过项。

2026-09-11 增量验证：101 个 Coder 测试、13 个宿主桥接聚焦测试、37 个后端 v4 测试通过；生产构建在 Chrome 和独立 Electron 中各完成 37 项交互检查，覆盖修改停顿、Tab 后续链、鼠标光标机会、选区边界、撤销和过期目标拒绝。该轮 UI 联调使用固定鉴权/Redis/模型响应，不等同于生产账号和真实模型效果验收。

2026-09-11 控制体验增量：107 个 Coder 测试及 lint/typecheck 通过；Chrome 与独立 Electron 均通过 17 项暂停、重载、恢复、设置落盘和错误状态检查，并通过 37 项原有补全交互回归。使用开发构建和隔离 fixture；本轮未重测真实模型、生产环境或 Windows 实机。

2026-09-11 剪切复制增量：112 个 Coder 测试、14 个宿主桥接测试、49 个服务端 v4 测试及 lint/typecheck 通过；Chrome 与独立 Electron 各通过 20 项剪切复制专项、37 项补全回归和 17 项控制体验回归。专项覆盖原生多光标 CRLF、整行复制、两个模型上下文通道、单次撤销、开关／清空／重载及旧服务能力协商。固定模型验证真实链路，未发布生产或重测真实模型质量；原始 Keyboard Lock／Workbench 取消记录保留在证据中。

2026-09-12 同词替换增量：140 个 Coder 测试及 lint/typecheck 通过；Chrome 与独立 Electron 各通过 16 项原生鼠标同词替换专项、37 项原有补全回归和 20 项剪切复制回归。专项让模型返回空建议，验证慢速输入、词尾修改、先删后输后的本地联想，以及 Tab 单词接受、撤销、Esc 和词边界。使用当前开发构建和隔离 fixture，未发布生产或重测真实模型质量；保留原始 Keyboard Lock／Workbench 取消记录。
