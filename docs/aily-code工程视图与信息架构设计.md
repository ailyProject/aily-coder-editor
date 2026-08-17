# Aily Code 工程视图前端交互规格

## 1. 文档目标

本文档用于把 Aily Code 的工程视图定义为一份可直接交给前端实现的交互规格。

本文档覆盖以下实现对象：

1. 左侧工程树节点模型。
2. 默认视图层级与排序。
3. 节点图标、状态 badge、默认展开规则。
4. 单击、双击、右键菜单与空状态行为。
5. MVP 阶段需要实现的数据字段和前端边界。

本文档不负责定义：

1. 编译链内部实现。
2. 配置文件 schema 细节。
3. bridge、generated、lock 文件的后端生成过程。

以上内容分别以 [docs/aily-code最终目录与生命周期设计.md](docs/aily-code最终目录与生命周期设计.md) 和 [docs/aily-code项目清单与配置规范.md](docs/aily-code项目清单与配置规范.md) 为准。

---

## 2. MVP 视图原则

### 2.1 默认显示逻辑视图，不显示真实文件树

MVP 默认打开 `Aily View`，而不是直接打开物理目录树。

原因：

1. 用户需要先看到入口和任务对象，而不是实现目录。
2. `src/`、`components/`、`include/`、`assets/`、`.aily/` 不应该直接挤在第一屏。
3. 外部依赖和项目本地文件必须分层表达。

### 2.2 两类对象必须分开

左侧树里必须明确区分两类对象：

1. `Project Files`：项目自己拥有、自己维护、随仓库一起提交的文件和目录。
2. `Dependencies`：通过配置声明、由解析器安装和维护的外部依赖结果。

`components/` 的源码所有权仍属于 `Project Files`。`Dependencies` 下可提供
`Component Libraries` 只读投影与安装入口，但不得把这些目录误标为包管理器维护的外部依赖。

### 2.3 project.aci 与 main.cpp 角色分离

根目录 `project.aci` 是文件系统入口，`src/main.cpp` 是默认源码入口。

因此：

1. `Start Here` 必须排在树的第一组。
2. `project.aci` 和 `src/main.cpp` 都必须支持一跳打开。
3. 新项目首次打开时默认聚焦 `src/main.cpp`。

---

## 3. 视图总结构

### 3.1 默认视图结构

```text
Aily View
├── Start Here
│   ├── main.cpp
│   └── project.aci
├── Project Files          // AI 代码及库资源文件夹
│   ├── Application Code
│   │   └── src/
│   ├── Headers
│   │   └── include/
│   ├── Local Modules
│   │   └── components/
│   └── Assets
│       └── assets/
├── Project Config
│   └── aily.lock.json
├── Board
├── Dependencies
│   ├── Component Libraries      // components/ 的快捷投影与平台公共库入口
│   ├── Installed Libraries
│   ├── Platform Packages
│   └── Package Status
├── Build Outputs
│   ├── debug
│   ├── release
│   │   └── 编译产物
│   └── simulator
└── Generated
    ├── Generated Sources
    ├── Bridge Files
    └── Compile Commands
```

### 3.2 辅助视图结构

`Files View` 保留为次级入口，用于高级用户查看真实文件树。

MVP 中：

1. `Aily View` 为默认视图。
2. `Files View` 不作为首次打开视图。
3. `.aily/` 在 `Files View` 中默认隐藏。

---

## 4. 左侧树节点模型

### 4.1 节点类型

前端树节点必须支持以下类型：

| `type` | 含义 | 是否映射真实文件 | 示例 |
|------|------|------------------|------|
| `group` | 逻辑分组节点 | 否 | `Project Files` |
| `file` | 真实文件节点 | 是 | `main.cpp` |
| `directory` | 真实目录节点 | 是 | `src/` |
| `property` | 平台/配置属性节点 | 否 | `Board` |
| `status` | 状态汇总节点 | 否 | `Package Status` |
| `artifact-group` | 构建产物分组节点 | 否 | `debug` |
| `virtual-file` | 逻辑映射文件入口 | 否 | `Compile Commands` |

### 4.2 前端节点数据结构

MVP 建议以前端状态模型统一渲染：

```ts
type TreeNodeType =
  | 'group'
  | 'file'
  | 'directory'
  | 'property'
  | 'status'
  | 'artifact-group'
  | 'virtual-file';

type BadgeTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

interface TreeBadge {
  id: string;
  text: string;
  tone: BadgeTone;
  priority: number;
}

interface TreeAction {
  id: string;
  label: string;
  enabled: boolean;
  danger?: boolean;
}

interface ProjectTreeNode {
  id: string;
  type: TreeNodeType;
  label: string;
  description?: string;
  icon: string;
  path?: string;
  expandable: boolean;
  expandedByDefault: boolean;
  visible: boolean;
  badges?: TreeBadge[];
  children?: ProjectTreeNode[];
  actions?: TreeAction[];
  payload?: Record<string, unknown>;
}
```

### 4.3 顶层节点定义

| 顺序 | `id` | 标题 | `type` | 图标 | 默认展开 | 默认可见 | 数据来源 |
|------|------|------|--------|------|----------|----------|----------|
| 1 | `start-here` | `Start Here` | `group` | `home` | 是 | 是 | 固定结构 |
| 2 | `project-files` | `Project Files` | `group` | `files` | 是 | 是 | 固定结构 |
| 3 | `project-config` | `Project Config` | `group` | `settings-gear` | 否 | 是 | 配置索引 |
| 4 | `board` | `Board` | `property` | `circuit-board` | - | 是 | target 配置 |
| 5 | `dependencies` | `Dependencies` | `group` | `package` | 否 | 是 | 依赖解析结果 |
| 6 | `build-outputs` | `Build Outputs` | `group` | `tools` | 否 | 是 | 构建状态服务 |
| 7 | `generated` | `Generated` | `group` | `layers` | 否 | 条件显示 | bridge/generated 索引 |

### 4.4 子节点定义

#### Start Here

| `id` | 标题 | `type` | 图标 | 行为 |
|------|------|--------|------|------|
| `entry-main` | `main.cpp` | `file` | `file-code` | 打开默认源码入口 |
| `project-entry` | `project.aci` | `file` | `json` | 打开项目配置入口 |

#### Project Files

| `id` | 标题 | `type` | 图标 | 真实路径 |
|------|------|--------|------|----------|
| `application-code` | `Application Code` | `group` | `symbol-module` | - |
| `headers` | `Headers` | `group` | `symbol-key` | - |
| `local-modules` | `Local Modules` | `group` | `repo` | - |
| `assets` | `Assets` | `group` | `device-camera` | - |
| `src-root` | `src/` | `directory` | `folder` | `src` |
| `include-root` | `include/` | `directory` | `folder` | `include` |
| `components-root` | `components/` | `directory` | `folder-library` | `components` |
| `assets-root` | `assets/` | `directory` | `folder` | `assets` |

#### Project Config

| `id` | 标题 | `type` | 图标 | 行为 |
|------|------|--------|------|------|
| `project-config-file` | `project.aci` | `file` | `json` | 打开可视化配置页，支持切换文本 |
| `lock-json` | `aily.lock.json` | `file` | `lock` | 打开锁文件或只读详情面板 |

#### Board

| `id` | 标题 | `type` | 图标 | `description` 来源 |
|------|------|--------|------|--------------------|
| `board` | `Board` | `property` | `circuit-board` | `target.board` |

#### Dependencies

| `id` | 标题 | `type` | 图标 | 说明 |
|------|------|--------|------|------|
| `component-libraries` | `Component Libraries` | `group` | `library` | 映射 `components/` 一级库目录；展开时打开平台公共 Arduino 库列表 |
| `installed-libraries` | `Installed Libraries` | `group` | `package` | 外部通用库依赖 |
| `platform-packages` | `Platform Packages` | `group` | `package` | SDK、框架附加包、工具包 |
| `package-status` | `Package Status` | `status` | `pulse` | 依赖解析状态汇总 |

#### Build Outputs

| `id` | 标题 | `type` | 图标 | 说明 |
|------|------|--------|------|------|
| `build-debug` | `debug` | `artifact-group` | `play-circle` | debug 构建产物 |
| `build-release` | `release` | `artifact-group` | `rocket` | release 构建产物 |
| `build-simulator` | `simulator` | `artifact-group` | `vm` | simulator 构建产物 |

#### Generated

| `id` | 标题 | `type` | 图标 | 说明 |
|------|------|--------|------|------|
| `generated-sources` | `Generated Sources` | `group` | `file-symlink-file` | 影子源码 |
| `bridge-files` | `Bridge Files` | `group` | `link` | bridge 生成文件 |
| `compile-commands` | `Compile Commands` | `virtual-file` | `list-tree` | 编译数据库入口 |

---

## 5. 图标规格

### 5.1 图标来源

MVP 直接使用 VS Code 风格 icon token 或 codicon 风格命名，不自定义一套新图标语义。

### 5.2 图标映射规则

| 节点 | 图标 token |
|------|------------|
| `Start Here` | `home` |
| `main.cpp` | `file-code` |
| `Project Files` | `files` |
| `Application Code` | `symbol-module` |
| `Headers` | `symbol-key` |
| `Local Modules` | `repo` |
| `components/` | `folder-library` |
| `Assets` | `device-camera` |
| `Project Config` | `settings-gear` |
| `project.aci` | `json` |
| `aily.lock.json` | `lock` |
| `Board` | `circuit-board` |
| `Dependencies` | `package` |
| `Package Status` | `pulse` |
| `Build Outputs` | `tools` |
| `Generated` | `layers` |

### 5.3 图标颜色规则

MVP 只允许三档颜色语义：

1. 默认节点使用中性色。
2. 可执行或当前活跃节点可使用强调色。
3. 错误或缺失状态不改图标，只通过 badge 和 description 表达。

---

## 6. 默认展开与可见性规则

### 6.1 新项目首次打开

默认状态：

1. 自动选中 `Start Here > main.cpp`。
2. `Start Here` 展开。
3. `Project Files` 展开。
4. `Application Code` 展开到 `src/`。
5. `Project Config` 可见但默认折叠。
6. 一级 `Board` 节点可见。
7. `Dependencies` 可见但默认折叠。
8. `Build Outputs` 折叠。
9. `Generated` 默认隐藏。

### 6.2 老项目再次打开

优先级规则：

1. 先恢复上次展开状态。
2. 若无恢复状态，则退回首次打开规则。
3. 无论恢复结果如何，`main.cpp` 和 `project.aci` 都必须在首屏区域快速看到。

### 6.3 高级模式

高级模式新增：

1. `Generated` 默认显示但折叠。
2. `Build Outputs` 可展示更细的产物子节点。
3. `Files View` 切换入口更显著。

---

## 7. 右键菜单规格

### 7.1 通用菜单项

以下动作适用于所有真实文件和真实目录节点：

1. `Open`
2. `Reveal in Files View`
3. `Copy Relative Path`

### 7.2 节点级菜单

#### main.cpp

1. `Open`
2. `Reveal in Files View`
3. `Set as Main Entry`
4. `Rename`

#### src/、include/、components/、assets/

1. `Open Folder`
2. `New File`
3. `New Folder`
4. `Reveal in Files View`

#### project.aci

1. `Open Visual Config`
2. `Open as JSON`
3. `Validate Config`
4. `Regenerate Lock File`

#### Board

1. `Open Settings`
2. `Change Value`
3. `Reveal Backing Config`

#### Installed Libraries / Platform Packages

1. `Add Dependency`
2. `Refresh Packages`
3. `Open Dependency Panel`

#### Package Status

1. `Retry Resolve`
2. `Show Resolution Log`
3. `Open Lock File`

#### Build Outputs

1. `Build Debug`
2. `Build Release`
3. `Build Simulator`
4. `Clean`

#### Generated

1. `Reveal Generated Sources`
2. `Reveal Bridge Files`
3. `Open Compile Commands`

---

## 8. 状态 badge 规格

### 8.1 badge 位置

badge 统一放在节点标题右侧，不放在图标左侧。

### 8.2 badge 优先级

同一节点最多显示 2 个 badge，按优先级从高到低截断：

1. `danger`
2. `warning`
3. `info`
4. `success`
5. `neutral`

### 8.3 badge 类型

| badge | `tone` | 适用节点 | 含义 |
|------|--------|----------|------|
| `Missing` | `danger` | `Package Status`、`Board` | 缺少依赖或关键配置 |
| `Dirty` | `warning` | `project.aci`、`main.cpp` | 有未同步更改 |
| `Outdated` | `warning` | `Installed Libraries` | 依赖可更新 |
| `Ready` | `success` | `Package Status`、`Build Outputs` | 当前状态可执行 |
| `Building` | `info` | `Build Outputs` | 构建进行中 |
| `New` | `info` | `main.cpp`、新建目录 | 首次创建或未打开 |
| `Hidden` | `neutral` | `Generated` | 节点默认不展示 |

### 8.4 节点状态示例

1. `Package Status`：`Missing`、`Ready`、`Outdated`。
2. `Build Outputs`：`Building`、`Ready`、`Missing`。
3. `project.aci`：`Dirty`。
4. `Generated`：高级模式关闭时不显示，高级模式开启后可显示 `Hidden`。

---

## 9. 交互行为规格

### 9.1 单击

1. 单击真实文件节点时，在编辑器中预览打开。
2. 单击真实目录节点时，仅展开或折叠，不自动打开目录。
3. 单击属性节点时，在右侧面板显示详情。
4. 单击状态节点时，在右侧面板显示状态摘要。

### 9.2 双击

1. 双击真实文件节点时正式打开文件。
2. 双击属性节点时进入对应设置页。
3. 双击 `Build Outputs` 子节点时进入产物详情页或输出面板。

### 9.3 Hover

hover 必须支持工具提示，最少显示：

1. 节点标题。
2. 对应真实路径或逻辑说明。
3. 当前状态摘要。

### 9.4 空状态

以下节点需要空状态文案：

1. `Installed Libraries`：`No external libraries installed yet.`
2. `Platform Packages`：`No platform packages resolved yet.`
3. `Build Outputs`：`No build artifacts yet.`
4. `Generated`：`Generated files will appear after resolve or build.`

### 9.5 错误状态

树节点不直接渲染大段报错文本。

MVP 只允许：

1. 节点 description 显示简短摘要。
2. 节点 badge 标记错误级别。
3. 详细信息进入侧边面板或日志面板。

---

## 10. 前端实现边界

### 10.1 前端必须实现

1. 左侧树的固定分组顺序。
2. 节点类型渲染。
3. 图标映射。
4. 默认展开规则。
5. 右键菜单渲染。
6. badge 渲染与优先级。
7. 空状态、加载状态、错误状态。

### 10.2 前端暂不负责

1. 真实依赖解析。
2. build 产物生成。
3. generated/bridge 内容计算。
4. source map 映射。

前端只消费统一投影后的树节点数据。

### 10.3 建议接口边界

前端不自行扫描目录拼树，MVP 建议由上层服务一次性提供：

1. `getAilyViewTree(projectId)`
2. `getFilesViewTree(projectId)`
3. `performTreeAction(nodeId, actionId)`

---

## 11. MVP 验收标准

满足以下条件即可认为前端工程视图 MVP 可交付：

1. 新项目首次打开时能直接看到并打开 `main.cpp`，并能同时看到 `project.aci`。
2. `Project Files` 和 `Dependencies` 语义清晰分离。
3. `components/` 在 `Component Libraries` 中可快捷访问，但不被误解为 installed libraries。
4. 一级 `Board` 节点能展示当前值并打开 Board 列表。
5. `Dependencies` 能显示已安装库、平台包和状态汇总。
6. `Build Outputs` 和 `Generated` 支持折叠与空状态。
7. 关键节点具备可用的右键菜单和 badge 提示。

---

## 12. 一句话结论

Aily Code 的左侧工程树在 MVP 中应被实现为一棵“逻辑工程树”，其中根目录 `project.aci` 是项目发现入口，`src/main.cpp` 是默认源码入口，`Project Files` 表示项目自有代码与资源，`Dependencies` 表示外部依赖结果并提供 `components/` 的组件库快捷投影，前端只负责稳定渲染这套投影后的节点模型，而不改变源码所有权。
