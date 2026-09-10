# Aily Coder 工程视图规范

> 当前实现基线：2026-09-09。本文档定义 Coder 新工程结构下的 Aily View。工程源码与可编辑本地库保存在 `sketch/`；npm 库从包内最终 `src` 根映射展示和编译。

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
