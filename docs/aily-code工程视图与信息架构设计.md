# Aily Coder 工程视图规范

> 当前实现基线：2026-09-20。本文档定义 Coder 新工程结构下的 Aily View。工程源码与可编辑本地库保存在 `sketch/`；npm 库从包内最终 `src` 根映射展示和编译。

## 1. 视图结构

Aily View 只显示三个顶层入口，名称和顺序固定：

```text
Aily View
├── User View
│   └── sketch/src/**
├── Config
│   └── package.json
└── Library
    ├── sketch/libraries/**
    └── node_modules/@aily-project{,-coder}/lib-*/src/**（映射库根）
```

| 顶层节点 | 节点类型 | 数据源 | 默认状态 |
|---|---|---|---|
| `User View` | 真实目录 | `sketch/src/` | 展开 |
| `Config` | 配置分组 | 根 `package.json` | 展开 |
| `Library` | 合并目录 | `sketch/libraries/` + Aily/Arduino npm 包最终 `src` 库根 | 展开 |

Aily View 的三个直属节点默认展开；`User View` 与 `Library` 内更深层的真实目录仍默认折叠。

`Start Here`、`Project Config`、`Board`、`Dependencies`、`Build Outputs` 和 `Generated` 不再属于当前 Aily View 顶层信息架构。主板、外部包、编译产物等信息由宿主对应功能界面负责。

## 2. 路径契约

Coder 工程的持久化目录同时是编译目录：

```text
<project>/
├── package.json
└── sketch/
    ├── src/
    │   └── main.cpp
    └── libraries/
```

- `package.json.entry` 相对 `sketch/` 存储，默认值为 `src/main.cpp`。
- 编辑器打开和 Aily View 展示的真实文件是 `sketch/src/main.cpp`。
- 本地库只在 `sketch/libraries/` 中编辑和保存；npm 包源码不可直接修改。
- npm 包的 `src.7z` 解压到归属包内同级 `src/`；连续且唯一的 `src` 包装层会被剥离，只映射最终层自身或其直接子库目录。
- 只有需要修改已安装库自身源码时，才复制所选库根到真实 `sketch/libraries/`；同名本地根在视图和构建中优先。
- 不创建根 `src/` 或根 `components/`；`.temp/libraries/` 仅是构建时可重建映射，不是持久化源码。

## 3. 交互规则

### User View

- 递归读取 `sketch/src/` 内的真实文件和目录，不限于 `.cpp`。
- 目录排在文件之前，同类节点按名称排序；隐藏点开头条目。
- 文件单击直接打开；目录递归展开，真实文件和子目录保留现有右键操作入口。
- `sketch/src/` 中的 `.cpp` 文件可设为主入口，写回 `package.json.entry` 时自动去掉 `sketch/` 前缀。

### Config

- 固定展示工程根 `package.json`。
- 单击节点打开真实文件；Coder 类型、入口、框架、主板及依赖配置均在该文件维护。

### Library

- 合并读取 `sketch/libraries/` 本地根与 `@aily-project/lib-*`、`@aily-project-coder/lib-*` 包内映射根。
- `sketch/libraries/` 的每个直接子目录作为一份可编辑本地库；同名本地库覆盖 npm 映射。
- npm 映射节点打开真实包内文件，但提示词与工具契约要求先本地化再修改。
- 目录为空或不存在时显示 `No project libraries yet.`。
- `Library` 行右侧的库列表图标始终显示，点击展开或收起右侧库列表。
- 一级库根的右键菜单提供“卸载库”；内部文件和目录不提供该项。未受库列表管理的本地库显示禁用项。
- 卸载按包或安装凭据定位库列表中的精确条目，读取实际安装版本并复用列表卸载流程，不依赖列表是否打开、当前来源或筛选结果。保留宿主日志、成功/失败反馈和重复提交保护；成功后刷新整个 Library 分组（同包的多个映射根一起移除）。
- 两个卸载入口都先检查 `sketch/` 内 C/C++/Arduino 源码与头文件中的引用，打开的编辑器缓冲优先于磁盘（包含未保存改动）。匹配实际安装库根提供的头文件，忽略注释和库自身源码，并保留本地头文件替代关系。
- 检测到引用时，确认窗口列出文件、行号和引用头文件，提供“取消 / 仍然卸载”。取消、Esc 或关闭不发送卸载请求；确认后才执行原有卸载及宿主日志流程。未检测到引用时直接卸载，读取或扫描失败则停止卸载。
- 使用检查是静态头文件引用检查，支持同文件直接头文件宏；条件编译分支保守处理，不代替编译器预处理、跨文件宏展开或完整依赖调用图分析。

## 4. 刷新与数据一致性

- 监听 `sketch/src/**`，新建、删除、修改或重命名后定向刷新 `User View`。
- 监听 `sketch/libraries/**`，变更后定向刷新 `Library`。
- 监听 `node_modules/**`，依赖安装、移除或包内 `src` 准备完成后刷新 npm 库映射。
- 嵌入 Electron 时同时接收宿主原生文件系统 watch 事件，保证系统级复制、删除和移动也能刷新视图。

## 5. 验收标准

1. Aily View 顶层严格只有 `User View`、`Config`、`Library`，且顺序一致。
2. `User View` 的内容与 `sketch/src/` 磁盘结构一致。
3. `Config` 可打开根 `package.json`。
4. `Library` 正确合并本地库和两个 npm 作用域的最终 `src` 库根，同名时只显示本地根。
5. Aily View 不再显示硬件平台、Board、Dependencies 或 Build Outputs 节点。

### 2026-09-20 库菜单验证

- 完整构建（含 ESLint、TypeScript）通过；库树/来源、库模型/宿主反馈和工作台文案测试共 16 项通过。
- 使用当前开发链接产物，在 1440×900 Chrome 无头浏览器中运行隔离工程；测试宿主提供文件系统桥，库搜索与卸载调用真实运行时 API。核对图标非悬停/非选中可见、一级菜单与内层排除、本地库禁用、列表未打开、HTTP 503 后重试、两个来源的真实 npm 卸载、package.json/磁盘后读、同包多根刷新。
- 截图和请求/反馈记录保存在本机 `tmp/library-menu-qa-20260920/`（忽略提交）。测试宿主有既有 iframe Keyboard.lock 提示；注入的 HTTP 503 用于失败恢复验证。该验证不替代完整 Electron 宿主通知验收。

### 2026-09-20 卸载前使用检查验证

- 完整构建（含 ESLint、TypeScript）通过；库树/来源/使用检查与库模型/宿主反馈测试共 20 项通过。新增用例覆盖注释/原始字符串/续行、同文件头文件宏、多库根、自身源码排除、未保存引用增删、本地头文件替代、旧 ZIP 库与读取失败。
- 在同一开发产物的浏览器隔离工程中实测：引用确认显示文件与行号，取消和 Esc 均无卸载请求/开始日志，确认后调用真实 npm 卸载，失败可再次确认重试；库列表也检测到未保存引用，取消后保留库；未引用库直接卸载。
- 截图、完整脚本、请求和宿主反馈记录位于本机 `tmp/library-uninstall-usage-qa-20260920/`。这是浏览器隔离宿主与真实库运行时 API 验证；未单独验收 Electron 宿主顶部通知。Blockly 工程无文件改动。
