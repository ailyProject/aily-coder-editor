# Aily Code 最终目录与生命周期设计

> **当前实现覆盖（2026-08-21）**：项目根 `package.json` 保存全部 Coder 工程配置，源码和库统一放入持久化 `sketch/` 编译工作区。Coder 新建复制共享 `board-*` 主板包的 `template_arduino/package.json`，并将保持原始内容的源码模板 `template_arduino/project.aci` 复制为 `sketch/src/main.cpp`；项目库位于 `sketch/libraries/`，不再合成独立硬件平台。下文根 `project.aci` 等旧目录示意仅保留为设计历史。

## 1. 文档目标

本文档用于沉淀 Aily Code 第一版工程模型的定稿建议，服务于以下目标：

1. 统一项目目录结构，避免后续功能扩展时反复改工程模型。
2. 明确“项目内文件”和“全局环境文件”的边界，避免 xpm 与 IDE 内部实现泄漏到用户心智中。
3. 给产品、前端、内核、编译、烧录、语言服务模块提供统一的实现参考。

本文档关注两件事：

1. 最终项目目录结构。
2. 项目从创建、打开、索引、构建到烧录的完整生命周期。

本文档不再承担以下内容：

1. 左侧工程树节点命名与交互细节。
2. 图标、badge、右键菜单、默认展开等前端规格。
3. 跨产品、前端、核心服务、构建链的实施排期。

这些内容分别以 [docs/aily-code工程视图与信息架构设计.md](docs/aily-code工程视图与信息架构设计.md) 和 [docs/aily-code-MVP实施清单.md](docs/aily-code-MVP实施清单.md) 为准。

---

## 2. 定稿原则

### 2.1 一个唯一真相源

项目根目录必须只有一个用户可维护的项目主配置文件，作为工程语义的唯一真相源。

这个文件负责描述：

1. 项目类型。
2. 目标板卡与芯片。
3. 框架与 SDK 版本。
4. 构建 profile。
5. 依赖声明。
6. 烧录与监视器配置。

xpm、CMake、Ninja、clangd 相关桥接文件都不应成为用户主心智的一部分。

### 2.2 用户项目与运行环境分离

项目目录只保留“可协作、可版本化、可复现”的内容。

用户机器上的 AppData 目录只保留：

1. SDK 包缓存。
2. 工具链缓存。
3. xpm 下载缓存。
4. IDE 全局索引与元数据。
5. 用户偏好和设备历史。

### 2.3 构建影子层必须可重建

所有生成物、缓存、桥接文件和临时中间件必须进入隐藏工作区，并保证删除后可以完整重建。

### 2.4 IDE 语义优先，xpm 作为环境编排器

Aily Code 的工程模型不应直接暴露为 xpm 工程模型。xpm 在这里是：

1. 依赖分发器。
2. 工具链获取器。
3. SDK 解析器。
4. PATH 注入与执行入口提供者。

它不应成为用户直接编辑的项目配置中心。

---

## 3. 推荐最终目录结构

### 3.1 项目目录

```text
MyProject/
├── project.aci               # 项目唯一真相源，也是文件系统发现入口
├── package.json             # 
├── .gitignore
├── README.md
├── src/                       # 应用源码与辅助原生源码
│   └── main.cpp               # 默认源码入口
├── components/                # 项目本地模块
├── include/                   # 公共头文件
├── assets/                    # 图片、字库、资源文件
├── scripts/                   # 可选：项目级辅助脚本
└── .aily/                     # IDE 隐藏工作区
    ├── generated/             # 从 .aci 转换后的影子源码
    │   ├── cpp/
    │   ├── headers/
    │   └── source-map.json
    ├── bridge/                # IDE 生成的桥接层
    │   ├── xpm/
    │   │   ├── package.json
    │   │   └── xpacks/
    │   ├── cmake/
    │   └── compile_commands.json
    ├── build/
    │   ├── debug/
    │   ├── release/
    │   └── simulator/
    ├── cache/
    │   ├── index/
    │   ├── downloads/
    │   └── fingerprints/
    ├── logs/
    └── state/
        ├── workspace.json
        ├── device-history.json
        └── last-session.json
```

### 3.2 全局环境目录

Windows 下建议使用如下逻辑结构：

```text
%AppData%/AilyCode/
├── sdk-store/                 # 各类 SDK 包实体
├── toolchains/                # gcc/clang/openocd/esptool 等工具链实体
├── xpm-store/                 # xpm 包仓与缓存
├── registries/                # registry 索引、镜像配置、解析缓存
├── templates/                 # 工程模板
├── logs/                      # 全局日志
└── settings/
    ├── user-preferences.json
    ├── device-profiles.json
    └── accounts.json
```

### 3.3 为什么要这样分层

根目录保留用户可理解的项目模型，隐藏以下内容：

1. xpm 生成文件。
2. 编译缓存。
3. 影子 C/C++ 工作区。
4. clangd 索引产物。
5. 设备与窗口状态。

这样做有四个直接收益：

1. Git 历史干净。
2. 用户不会误编辑桥接文件。
3. 出问题时可以通过清理 .aily 完整重建。
4. 后续支持多框架时不需要推翻项目目录模型。

### 3.4 入口可见性与默认工程视图

根目录 `project.aci` 适合承担“用户从系统文件管理器一眼看到并双击进入项目”的职责，但它仍然不应直接决定 IDE 的默认导航体验。

也就是说：

1. 根目录 `project.aci` 负责文件系统入口可见性。
2. IDE 默认展示层不应直接等同于真实文件树。

如果默认直接显示原始 Project 目录树，会出现几个问题：

1. 用户第一眼看不到主入口。
2. `src`、`components`、`include`、`assets`、`.aily`、桥接文件会混在一起，信息密度过高。
3. 对初学者来说，目录是“技术实现细节”，不是“工作任务入口”。

因此，Aily Code 更适合采用双视图策略：

1. 默认使用逻辑工程视图。
2. 可选提供 `Files View` 显示真实物理结构，供高级用户使用。

在模型层，本项目只冻结三个结论：

1. `project.aci` 必须始终是文件系统可见的项目入口。
2. `src/main.cpp` 必须始终是默认源码入口。
3. 外部依赖必须与项目本地模块分开表达，不能再混成单一 `lib` 心智。

具体的左侧树分组、节点模型、图标、badge、右键菜单和默认展开规则，统一以 [docs/aily-code工程视图与信息架构设计.md](docs/aily-code工程视图与信息架构设计.md) 为准。

结论是：

1. 根目录 `project.aci` 用于文件系统入口是合理的。
2. 真正需要设计的是默认工程视图，而不是把真实目录直接当成用户心智模型。

---

## 4. 核心文件职责定义

### 4.1 project.aci

这是唯一需要用户理解和维护的工程主配置文件。

职责：

1. 定义项目身份。
2. 定义 target、board、framework、sdk。
3. 定义入口文件与源码根目录。
4. 定义 build profile。
5. 定义依赖。
6. 定义上传方式与监视器参数。

不应在其中直接写入本机 AppData 绝对路径。

### 4.2 aily.lock.json

这是解析结果快照，用于保证跨机器一致性。

职责：

1. 记录最终解析出的包版本。
2. 记录工具链版本与来源。
3. 记录依赖树指纹。
4. 记录 target profile 对应的解析结果。

锁文件应纳入版本控制。

### 4.3 src/main.cpp

这是默认业务源码入口，但它不再承担文件系统层的项目发现职责。

这样设计的好处是：

1. `main.cpp` 回到 `src/` 后，源码结构与常见 C/C++ 嵌入式工程更一致。
2. 默认源码入口仍然明确。
3. 后续可扩展为多文件工程。
4. 入口位置仍可以在配置中切换。

在 UI 呈现上，建议遵循一条额外规则：

1. `project.aci` 应继续作为文件系统可见的项目入口。
2. 用户打开项目后，应能无需层层展开源码目录就直接进入 `src/main.cpp`。

### 4.4 src/

`src/` 用于承载应用源码与辅助原生源码，并承载默认源码入口 `main.cpp`。

它更适合存放：

1. 应用内部的 `.c`、`.cpp`、`.cc` 文件。
2. 与 `.aci` 共存的原生实现文件。
3. 后续扩展出的业务子目录。

### 4.5 components/

`components/` 用于承载项目本地模块。

这里的“本地模块”指：

1. 由当前项目自己维护的可复用功能块。
2. 以真实 `.h/.c/.cpp` 形式存在的本地模块代码。
3. 需要随项目一起版本控制的模块。

它不应用来承载 xpm 安装的外部依赖。

### 4.6 .aily/generated

这是语言服务和构建系统面向的影子工作区。

职责：

1. 保存从 .aci 转换后的 C/C++ 文件。
2. 保存自动注入的头文件。
3. 保存源映射信息。

### 4.7 .aily/bridge

这是 IDE 与外部工具系统之间的粘合层。

职责：

1. 生成 xpm package.json。
2. 生成 CMake 桥接文件。
3. 生成 compile_commands.json。
4. 为 clangd 和构建系统提供稳定入口。

这部分必须被 IDE 接管，不应让用户手工编辑。

---

## 5. 最终生命周期设计

下述生命周期不是 UI 流程图，而是工程系统真正发生的状态流转。

### 5.1 生命周期总览

```text
创建或打开项目
    ↓
解析 project.aci
    ↓
检查 aily.lock.json 与本机环境
    ↓
解析全局 SDK/工具链/xpm 包
    ↓
生成 .aily/bridge
    ↓
生成 .aily/generated 影子源码
    ↓
生成 compile_commands.json 并启动索引
    ↓
用户编辑 src/main.cpp / src / components / include
    ↓
增量重建影子工作区
    ↓
执行 Build / Flash / Monitor
    ↓
更新状态与日志
```

---

## 6. 关键生命周期详解

### 6.1 创建项目

触发方式：

1. 新建空白嵌入式项目。
2. 从模板创建项目。
3. 从示例工程克隆项目。

系统动作：

1. 创建根目录骨架。
2. 写入初始 project.aci。
3. 写入默认 aily.lock.json。
4. 创建 `src/main.cpp`。
5. 初始化 .gitignore。

产物要求：

1. 项目可以立即打开。
2. 即使尚未安装工具链，也能先进行编辑。
3. 第一次真正构建时再触发缺失依赖安装。

### 6.2 打开项目

触发方式：

1. 打开项目目录。
2. 双击 .aci 文件。

系统动作：

1. 识别工程根目录。
2. 读取 project.aci。
3. 读取锁文件并计算当前环境是否满足。
4. 恢复上次会话状态。
5. 检查 .aily 是否可复用，否则重建。

建议策略：

1. 双击根目录 `project.aci` 时直接进入项目；双击其他源码文件时可向上搜索工程根目录。
2. 如果找不到主配置文件，则引导创建新项目或以单文件草稿模式打开。

### 6.3 环境解析

目标：把逻辑配置转换为当前机器可执行的构建环境。

系统动作：

1. 根据项目配置确定所需框架、SDK、编译器、烧录工具。
2. 在 AppData 中查询本机是否已有对应版本。
3. 若缺失，则通过 xpm 或其他分发器安装到全局缓存。
4. 生成当前项目的 bridge 层入口。

关键约束：

1. 项目内不保存真实安装路径。
2. bridge 层可以保存本机映射，但必须可重建。

### 6.4 影子工作区生成

目标：让 .aci 对用户友好，让 C/C++ 工具链对系统友好。

系统动作：

1. 将 .aci 转换或编织为 C/C++ 影子文件。
2. 注入必要头文件和运行时 glue code。
3. 生成 source-map.json。
4. 为每个 profile 生成独立构建输入。

这是整个 IDE 体验的关键层，因为后续：

1. 编译错误映射依赖它。
2. 跳转与补全依赖它。
3. AI 辅助修改也依赖它。

### 6.5 语言服务索引

系统动作：

1. 使用 .aily/bridge/compile_commands.json 启动 clangd。
2. 将 SDK 头文件、工具链内建头、项目 `include`、`src` 和 `components` 路径纳入索引。
3. 将诊断结果映射回 .aci 源文件。

关键要求：

1. 报错位置必须回到 .aci，而不是只停留在生成的 cpp 上。
2. 用户点击诊断、跳转定义、代码补全时不应暴露影子目录。

### 6.6 构建

系统动作：

1. 选择 profile。
2. 校验环境是否已准备完成。
3. 增量刷新 generated 和 bridge。
4. 调用构建后端执行编译。
5. 输出 elf、bin、map、size 报告。

建议产物位置：

1. 所有构建输出都进入 .aily/build/<profile>。
2. 用户需要导出时，再明确执行 export 动作。

### 6.7 烧录与监视器

系统动作：

1. 根据 target 和 board 解析默认烧录方式。
2. 读取项目配置中的端口、波特率、探针或 openocd profile。
3. 调用对应 uploader 工具。
4. 监视器输出与 IDE 控制台联动。

建议策略：

1. 设备发现和上次端口记忆放在用户级 settings，而不是项目级配置。
2. 项目级只保存可共享的默认烧录方案。

### 6.8 清理与恢复

建议支持两级清理：

1. 清理项目缓存：删除 .aily/build、.aily/cache、.aily/generated。
2. 清理全局缓存：删除 AppData 中未被任何项目引用的 SDK 和工具链缓存。

恢复原则：

1. 删除 .aily 后项目仍能重新打开。
2. 锁文件存在时，环境可以自动恢复到相同版本。

---

## 7. 状态机建议

为方便实现，建议把工程状态抽象为以下阶段：

1. Draft：只有源码，尚未解析 target。
2. Resolved：项目配置已解析，工具链需求已确定。
3. Prepared：bridge 和 generated 已生成。
4. Indexed：语言服务可用。
5. Buildable：可以执行编译。
6. Flashable：设备和烧录工具已就绪。
7. Dirty：源码或配置有变更，等待增量刷新。
8. Broken：环境缺失、索引失败或桥接损坏。

这样做的价值是：

1. UI 可以准确显示当前工程状态。
2. 后端服务可以做最小增量刷新。
3. 问题排查时更容易定位卡在哪一层。

---

## 8. 推荐模块分工

### 8.1 ProjectService

负责：

1. 工程创建。
2. 工程打开。
3. 主配置和锁文件读写。
4. 根目录识别。

### 8.2 EnvironmentResolver

负责：

1. 解析 target、board、framework、sdk。
2. 查询本机缓存。
3. 驱动 xpm 或其他包管理器安装。
4. 产出环境解析结果。

### 8.3 ShadowWorkspaceService

负责：

1. .aci 到 C/C++ 的影子生成。
2. source map 生成。
3. 增量刷新。

### 8.4 ToolchainBridgeService

负责：

1. 生成 xpm package.json。
2. 生成 cmake bridge。
3. 生成 compile_commands.json。
4. 注入运行 PATH。

### 8.5 LanguageServiceHost

负责：

1. clangd 生命周期。
2. 诊断转发。
3. 定义跳转与补全。
4. 源文件位置映射。

### 8.6 BuildService

负责：

1. profile 构建。
2. size 报告。
3. 增量编译。
4. 构建日志输出。

### 8.7 FlashService

负责：

1. 设备发现。
2. 烧录。
3. 串口监视器。
4. 调试入口。

---

## 9. 产品侧关键取舍建议

### 9.1 不建议长期把 package.json 放在项目根目录

原因：

1. 它会让用户误以为这是主要配置文件。
2. 它会把 xpm 语义直接暴露给用户。
3. 它会制造双配置源问题。

更稳的做法是把它放在 .aily/bridge/xpm/package.json。

### 9.2 不建议把本机绝对路径写入项目主配置

原因：

1. 无法跨机器协作。
2. 不利于版本控制。
3. 后续迁移缓存位置会非常痛苦。

### 9.3 不建议把 main.cpp 作为唯一项目锚点

更稳妥的模式是：

1. 用 `project.aci` 标识工程。
2. 用 `src/main.cpp` 作为默认源码入口。
3. 双击 `project.aci` 或任意项目内源码文件时向上回溯工程根。

### 9.4 必须从第一版开始支持 source map

这不是锦上添花，而是文本 DSL 能否成立的基础能力。

没有 source map，会直接影响：

1. 编译报错体验。
2. 跳转定义体验。
3. 调试断点体验。
4. AI 辅助编辑体验。

---

## 10. 第一版建议落地范围

如果要控制第一版复杂度，建议先锁定以下范围：

1. 单框架支持，例如先只支持 ESP-IDF 或 Arduino for ESP32。
2. 单平台优先支持 Windows。
3. 单主入口，保留多文件扩展能力。
4. 先做 Build、Flash、Monitor 三件核心事。
5. 先把 xpm 桥接放进 .aily/bridge，不暴露给用户。

第一版就应该定下来的基础设施有：

1. project.aci。
2. aily.lock.json。
3. components/。
4. .aily/generated。
5. .aily/bridge。
6. source-map.json。

---

## 11. 一句话结论

建议把 Aily Code 的工程模型定为：

“项目根目录只保存用户语义和可复现信息，AppData 保存全局工具链与缓存，.aily 负责所有桥接、生成、构建和索引中间层。”

这样既保留了 `.aci` 的轻量心智，又能支撑接近 PlatformIO 级别的工业化构建能力。
