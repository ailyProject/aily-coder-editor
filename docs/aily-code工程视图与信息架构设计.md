# Aily Coder 工程视图规范

> 当前实现基线：2026-08-20。本文档定义 Coder 新工程结构下的 Aily View，以 `sketch/` 为唯一源码和编译目录。

## 1. 视图结构

Aily View 只显示三个顶层入口，名称和顺序固定：

```text
Aily View
├── User View
│   └── sketch/src/**
├── Config
│   ├── project.aci
│   └── package.json
└── Library
    └── sketch/libraries/**
```

| 顶层节点 | 节点类型 | 数据源 | 默认状态 |
|---|---|---|---|
| `User View` | 真实目录 | `sketch/src/` | 展开 |
| `Config` | 配置分组 | 根 `project.aci`、根 `package.json` | 折叠 |
| `Library` | 真实目录 | `sketch/libraries/` | 折叠 |

`Start Here`、`Project Config`、`Board`、`Dependencies`、`Build Outputs` 和 `Generated` 不再属于当前 Aily View 顶层信息架构。主板、外部包、编译产物等信息由宿主对应功能界面负责。

## 2. 路径契约

Coder 工程的持久化目录同时是编译目录：

```text
<project>/
├── package.json
├── project.aci
└── sketch/
    ├── src/
    │   └── main.cpp
    └── libraries/
```

- `project.aci.entry` 相对 `sketch/` 存储，默认值为 `src/main.cpp`。
- 编辑器打开和 Aily View 展示的真实文件是 `sketch/src/main.cpp`。
- 本地库只在 `sketch/libraries/` 中编辑和保存。
- 不创建、不投影根 `src/`、根 `components/` 或 `.temp/` 源码副本。

## 3. 交互规则

### User View

- 递归读取 `sketch/src/` 内的真实文件和目录，不限于 `.cpp`。
- 目录排在文件之前，同类节点按名称排序；隐藏点开头条目。
- 文件单击直接打开；目录递归展开，真实文件和子目录保留现有右键操作入口。
- `sketch/src/` 中的 `.cpp` 文件可设为主入口，写回 `project.aci.entry` 时自动去掉 `sketch/` 前缀。

### Config

- 固定展示 `project.aci` 和 `package.json`，两者均位于工程根目录。
- 单击节点打开真实文件；`project.aci` 保留配置相关操作入口。

### Library

- 递归读取 `sketch/libraries/` 内的真实库源码。
- 每个直接子目录作为一份项目本地库展示。
- 目录为空或不存在时显示 `No project libraries yet.`。

## 4. 刷新与数据一致性

- 监听 `sketch/src/**`，新建、删除、修改或重命名后定向刷新 `User View`。
- 监听 `sketch/libraries/**`，变更后定向刷新 `Library`。
- 嵌入 Electron 时同时接收宿主原生文件系统 watch 事件，保证系统级复制、删除和移动也能刷新视图。

## 5. 验收标准

1. Aily View 顶层严格只有 `User View`、`Config`、`Library`，且顺序一致。
2. `User View` 的内容与 `sketch/src/` 磁盘结构一致。
3. `Config` 可打开根 `project.aci` 与根 `package.json`。
4. `Library` 的内容与 `sketch/libraries/` 磁盘结构一致。
5. Aily View 不再显示硬件平台、Board、Dependencies 或 Build Outputs 节点。
