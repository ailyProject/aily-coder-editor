# Aily Coder Aily Tab

Coder 的自动补全统一使用 Aily Tab。交互能力曾参考同类编辑器的 Tab 补全设计，通过 Aily 自有模型服务实现；没有调用第三方编辑器内部 API，也不宣称模型准确率或延迟与第三方产品相同。

## 操作

- 输入后自动显示当前位置续写或下一处修改；接受后继续预测关联位置。
- Tab 接受建议；远处或跨文件建议先 Tab 定位并审阅，再 Tab 接受；Esc 拒绝并停止当前预测链。
- macOS 用 Cmd+Right 逐词接受，Ctrl+Cmd+Right 逐行接受。Windows 对应 Ctrl+Right、Ctrl+Alt+Right。
- 带导入的纯插入也支持逐词/逐行接受：接受到完整符号时加入经过语言服务验证的 import/include，该步一起撤销；替换/删除只支持整条接受。
- Alt+反斜杠或命令“Aily: 触发 Aily Tab”立即预测。左侧顶部 Aily Tab 按钮可选择暂停时长、恢复、按语言/扩展名关闭和调整建议频率。
- 多个导入来源需要用户选择；库、SDK、生成文件只作为上下文，不接受补全修改。

## 设置

| 设置 | 默认值 | 作用 |
|---|---|---|
| `aily.completion.enabled` | true | 全局启用 |
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

## 实现与联调

入口 `src/main.common.ts` 只加载 `features/completion/completionFeature.ts`，由它直接注册唯一的行内 provider。`completion` 和 `next-edit` 是统一控制器内两种结构化操作，不是用户可切换的补全产品模式。每次最多一条建议。

链路为编辑器上下文/快照 → `CodeSuggestionHostBridgeService` → `/api/v4/code` → 受 windowId 约束的模型输出 → 完整 SSE 校验 → 目标缓冲区原子编辑 → 保存。宿主与服务端同时升级；共享服务的旧 v3 路由保留给其他客户端，Coder 不再连接它。

SDK 声明由 Electron preload 的 `readCodeDeclaration` 按宿主解析的安装根目录读取；只允许头文件、realpath 检查和大小限制，发往服务端的路径为 `@sdk/...`。新增 preload 方法需要重启主软件。编辑器构建用 `npm run build`，开发链接用 `node scripts/link-dev.mjs --skip-build`，撤销链接用 `npm run dev:unlink`。

执行 `npm run test:aily-tab` 验证协议、上下文、权限、历史、配置迁移、撤销事务与带导入部分接受。`scripts/completion-v4/` 提供浏览器/Electron、真实模型和真实 clangd 联调脚本；后端须按 harness 帮助启动。此目录名保留 HTTP v4 含义。

2026-09-10 验证：70 个 Coder 测试、16 个宿主桥接/生命周期测试、33 个后端测试、1 个 SDK 文件边界测试通过；Chrome 和独立 Electron 各 25 项，真实模型三文件联动 9 项，真实 clangd 13 项通过。源码保存到磁盘后通过 clang++ 语法编译。鉴权/权益/Redis 在独立 harness 中替换，真实模型测试只替换网关与状态设施；生产登录链、Windows 实机和 Arduino 主板构建/烧录不属于这些通过项。
