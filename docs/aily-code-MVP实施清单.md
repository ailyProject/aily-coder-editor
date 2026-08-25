# Aily Code MVP 实施清单

> **当前实现覆盖（2026-08-21）**：Coder 由宿主新建表单选择，和 Blockly 共用 `board-*` 主板源；创建时复制主板包 `template_arduino/package.json`，Coder 配置均保存在该文件，并将保持原始内容的源码模板 `template_arduino/project.aci` 复制为 `sketch/src/main.cpp`。本地库为 `sketch/libraries/`。下文出现的根 `project.aci`、根 `src/`、根 `components/` 和手写骨架均为早期规划，不再作为当前验收口径。

## 1. 文档目标

本文档把以下三份设计文档收束为一份可执行的 MVP 任务清单：

1. [docs/aily-code最终目录与生命周期设计.md](docs/aily-code最终目录与生命周期设计.md)
2. [docs/aily-code项目清单与配置规范.md](docs/aily-code项目清单与配置规范.md)
3. [docs/aily-code工程视图与信息架构设计.md](docs/aily-code工程视图与信息架构设计.md)

清单按四条线拆分：

1. 产品。
2. 前端。
3. 核心服务。
4. 构建链。

目标不是列概念，而是列出可以排期、可以验收、可以串联依赖的任务。

---

## 2. MVP 范围定义

MVP 只覆盖以下最小闭环：

1. 创建或打开一个以根目录 `project.aci` 为入口、以 `src/main.cpp` 为默认源码入口的项目。
2. 正确识别 `src/`、`components/`、`include/`、`assets/` 的项目语义。
3. 能展示 `Aily View` 与 `Files View`。
4. 能读取 `project.aci` 和 `aily.lock.json`。
5. 能完成依赖解析、影子工作区生成、语言服务启动。
6. 能执行 `Build / Flash / Monitor` 的最小链路。

MVP 暂不要求：

1. 多 target 工作区。
2. 复杂 workspace 级联工程。
3. 高级调试器集成。
4. 多分发器并存。
5. 深度自定义视图编排。

---

## 3. 里程碑切分

建议按四个阶段推进：

1. `M0`：模型定稿与接口冻结。
2. `M1`：创建、打开、展示项目。
3. `M2`：解析依赖、生成影子工作区、启动索引。
4. `M3`：完成构建、烧录、监视器闭环。

---

## 4. 产品线任务

### 4.1 M0

| ID | 任务 | 结果物 | 依赖 | 验收标准 |
|----|------|--------|------|----------|
| P-01 | 冻结 MVP 项目模型 | 统一术语表 | 无 | 团队统一使用 `project.aci`、`src/main.cpp`、`Project Files`、`Dependencies`、`components` |
| P-02 | 冻结左侧工程视图命名 | 导航命名表 | P-01 | 不再混用 `Libraries`、`Local Components`、`Installed Packages` 等旧词 |
| P-03 | 冻结首屏默认行为 | 交互规则 | P-01 | 新项目首次打开必定进入 `src/main.cpp`，且首屏可见 `project.aci` |

### 4.2 M1

| ID | 任务 | 结果物 | 依赖 | 验收标准 |
|----|------|--------|------|----------|
| P-04 | 定义新建工程模板 | 模板清单 | P-01 | 模板包含 `project.aci`、`src/main.cpp`、`src/`、`components/` |
| P-05 | 定义创建/打开失败提示 | 错误文案表 | P-03 | 缺配置、缺依赖、单文件草稿等场景有统一文案 |

### 4.3 M2

| ID | 任务 | 结果物 | 依赖 | 验收标准 |
|----|------|--------|------|----------|
| P-06 | 定义依赖状态集合 | 状态枚举 | P-02 | 至少有 `resolved`、`missing`、`downloading`、`conflict` |
| P-07 | 定义构建状态集合 | 状态枚举 | P-02 | 至少有 `idle`、`building`、`success`、`failed` |

### 4.4 M3

| ID | 任务 | 结果物 | 依赖 | 验收标准 |
|----|------|--------|------|----------|
| P-08 | 冻结 Build / Flash / Monitor 用户路径 | 流程图 | P-07 | 三个动作入口、执行中状态、失败反馈一致 |
| P-09 | 定义 MVP 不做项 | scope 边界表 | 全部 | 团队不再把调试器、多 target、复杂包源并入当前迭代 |

---

## 5. 前端线任务

### 5.1 M0

| ID | 任务 | 结果物 | 依赖 | 验收标准 |
|----|------|--------|------|----------|
| FE-01 | 建立左侧树节点类型模型 | TS 类型定义 | P-01 | 支持 `group/file/directory/property/status/artifact-group/virtual-file` |
| FE-02 | 建立图标与 badge 渲染规范 | UI token 映射 | P-02 | 可渲染图标、description、最多 2 个 badge |
| FE-03 | 建立树节点动作分发协议 | action dispatcher | FE-01 | 右键菜单动作可按 `nodeId + actionId` 分发 |

### 5.2 M1

| ID | 任务 | 结果物 | 依赖 | 验收标准 |
|----|------|--------|------|----------|
| FE-04 | 实现 `Aily View` 树渲染 | 左侧导航组件 | FE-01 | 顶层顺序与规格一致 |
| FE-05 | 实现 `Files View` 切换 | 视图切换器 | FE-04 | 默认打开 `Aily View`，支持切到真实文件树 |
| FE-06 | 实现首次打开默认展开规则 | 树状态管理 | FE-04 | 首次打开自动聚焦 `src/main.cpp` |
| FE-07 | 实现 `Project Files` 与 `Dependencies` 分层 | 节点分组逻辑 | FE-04 | `components/` 源码归属项目文件；依赖区仅显示 `Component Libraries` 快捷投影与安装入口 |

### 5.3 M2

| ID | 任务 | 结果物 | 依赖 | 验收标准 |
|----|------|--------|------|----------|
| FE-08 | 实现 `Board & Platform` 属性节点面板 | 详情面板 | FE-04 | 点击 `Board`、`MCU`、`Framework` 可查看当前值 |
| FE-09 | 实现依赖状态展示 | 状态面板 | FE-02, P-06 | `Dependencies` 可显示状态 badge 和空状态 |
| FE-10 | 实现构建产物区展示 | 产物面板 | FE-02, P-07 | `Build Outputs` 支持 `idle/building/success/failed` |
| FE-11 | 实现 Generated 高级模式显示 | 高级模式开关 | FE-04 | 新手模式隐藏，切换高级模式后可见 |

### 5.4 M3

| ID | 任务 | 结果物 | 依赖 | 验收标准 |
|----|------|--------|------|----------|
| FE-12 | 接入 Build / Flash / Monitor 入口动作 | 命令按钮和树菜单 | FE-10, P-08 | 三个动作可从树或顶部入口触发 |
| FE-13 | 接入错误与日志联动 | 错误跳转链路 | FE-09, FE-10 | 失败状态可跳转到对应日志或详情面板 |

---

## 6. 核心服务线任务

### 6.1 M0

| ID | 任务 | 结果物 | 依赖 | 验收标准 |
|----|------|--------|------|----------|
| CORE-01 | 建立项目根识别规则 | ProjectService 规则 | P-01 | 能识别含 `project.aci` 的工程根，并定位 `src/main.cpp` 默认入口 |
| CORE-02 | 建立统一工程树投影接口 | Tree projection service | P-02 | 可输出 `Aily View` 所需节点模型 |
| CORE-03 | 建立配置读取接口 | Config service | CORE-01 | 能读取并校验 `project.aci`、`aily.lock.json` |

### 6.2 M1

| ID | 任务 | 结果物 | 依赖 | 验收标准 |
|----|------|--------|------|----------|
| CORE-04 | 实现新建工程骨架生成 | Project template service | CORE-01, P-04 | 自动生成 `project.aci`、`src/main.cpp` 和目录骨架 |
| CORE-05 | 实现打开工程与状态恢复 | Session restore | CORE-01 | 再次打开时可恢复上次选中文件和展开状态 |
| CORE-06 | 输出 `Files View` 投影 | 文件树接口 | CORE-01 | 支持物理目录树输出，`.aily` 可控隐藏 |

### 6.3 M2

| ID | 任务 | 结果物 | 依赖 | 验收标准 |
|----|------|--------|------|----------|
| CORE-07 | 实现依赖解析状态服务 | Dependency status service | CORE-03, P-06 | 能输出 `resolved/missing/downloading/conflict` |
| CORE-08 | 实现影子工作区生成调度 | Shadow workspace service | CORE-03 | 能生成 `.aily/generated` 和 source map |
| CORE-09 | 实现 bridge 层生成调度 | Bridge service | CORE-03 | 能生成 `.aily/bridge` 和 compile_commands |
| CORE-10 | 实现语言服务宿主启动 | Language service host | CORE-08, CORE-09 | 可拉起 clangd 并建立诊断回传 |

### 6.4 M3

| ID | 任务 | 结果物 | 依赖 | 验收标准 |
|----|------|--------|------|----------|
| CORE-11 | 实现构建状态汇总接口 | Build status service | P-07 | 可输出 `idle/building/success/failed` |
| CORE-12 | 实现烧录和监视器任务状态接口 | Device task service | CORE-11 | 可把 flash 和 monitor 状态反馈给前端 |
| CORE-13 | 实现树动作执行接口 | Action router | FE-03, CORE-02 | `nodeId + actionId` 可被正确分发到服务层 |

---

## 7. 构建链任务

### 7.1 M0

| ID | 任务 | 结果物 | 依赖 | 验收标准 |
|----|------|--------|------|----------|
| BUILD-01 | 冻结 bridge 输出结构 | 目录约定 | P-01 | `.aily/bridge`、`.aily/generated`、`.aily/build` 结构不再漂移 |
| BUILD-02 | 冻结 profile 命名 | profile 约定 | P-07 | 默认支持 `debug`、`release`、`simulator` |

### 7.2 M1

| ID | 任务 | 结果物 | 依赖 | 验收标准 |
|----|------|--------|------|----------|
| BUILD-03 | 支持从 `project.aci` 解析 target | 解析器 | BUILD-01 | 可解析 board、mcu、framework、sdk |
| BUILD-04 | 支持锁文件生成与刷新 | lock 生成器 | BUILD-03 | `Regenerate Lock File` 可产出稳定结果 |

### 7.3 M2

| ID | 任务 | 结果物 | 依赖 | 验收标准 |
|----|------|--------|------|----------|
| BUILD-05 | 接入依赖下载与缓存查询 | package resolver | BUILD-03 | 缺失依赖时可查缓存或触发下载 |
| BUILD-06 | 生成 compile_commands.json | 编译数据库生成器 | BUILD-01, BUILD-05 | clangd 可直接消费 |
| BUILD-07 | 生成影子源码和 source map | 生成器 | BUILD-01 | `.aci` 报错可映射回源文件 |

### 7.4 M3

| ID | 任务 | 结果物 | 依赖 | 验收标准 |
|----|------|--------|------|----------|
| BUILD-08 | 接通 Build | 构建执行器 | BUILD-05, BUILD-07 | 输出进入 `.aily/build/<profile>` |
| BUILD-09 | 接通 Flash | 烧录执行器 | BUILD-08 | 可基于 target 和 upload 配置执行烧录 |
| BUILD-10 | 接通 Monitor | 监视器执行器 | BUILD-09 | 可显示串口输出并回传状态 |

---

## 8. 跨线依赖关系

关键依赖顺序如下：

1. `P-01 ~ P-03` 完成后，前端和核心服务才能冻结命名与树模型。
2. `CORE-02` 是 `FE-04` 的前提，因为前端不应自己扫描目录拼逻辑树。
3. `BUILD-05 ~ BUILD-07` 是 `CORE-07 ~ CORE-10` 的前提，因为依赖状态、影子工作区和语言服务都依赖构建链结果。
4. `CORE-11` 和 `BUILD-08 ~ BUILD-10` 完成后，前端才能稳定接入 `Build Outputs` 和 `Build / Flash / Monitor`。

---

## 9. MVP 完成定义

当以下条件全部满足时，可以认为 Aily Code 的工程模型 MVP 已闭环：

1. 可以新建并打开一个以根目录 `project.aci` 为入口、以 `src/main.cpp` 为默认源码入口的项目。
2. 左侧 `Aily View` 能稳定展示 `Project Files`、`Project Config`、`Board & Platform`、`Dependencies`、`Build Outputs`。
3. `components/` 被稳定识别为项目本地模块，而不是 installed libraries。
4. `project.aci`、`aily.lock.json` 可以被读取、校验和刷新。
5. 依赖可解析，bridge 与 generated 可生成，clangd 可启动。
6. 至少一条 target 构建链可以跑通 `Build / Flash / Monitor`。

---

## 10. 当前迭代建议

如果只排最近一轮迭代，建议优先做这 12 项：

1. `P-01` 冻结术语表。
2. `P-02` 冻结左侧视图命名。
3. `FE-01` 建立左侧树节点类型模型。
4. `FE-04` 实现 `Aily View` 树渲染。
5. `FE-07` 实现 `Project Files` 与 `Dependencies` 分层。
6. `CORE-01` 建立项目根识别规则。
7. `CORE-02` 建立统一工程树投影接口。
8. `CORE-04` 实现新建工程骨架生成。
9. `BUILD-03` 支持从配置解析 target。
10. `BUILD-05` 接入依赖下载与缓存查询。
11. `BUILD-07` 生成影子源码和 source map。
12. `BUILD-08` 接通 Build。

---

## 11. 一句话结论

MVP 不应再围绕“目录怎么摆”展开，而应围绕“工程模型能否形成创建、展示、解析、索引、构建、烧录的最小闭环”展开；这份清单的作用，就是把三份设计文档压缩成四条线都能直接开工的任务列表。
