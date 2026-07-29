# Board Manifest / Resolver Schema Draft

## 1. 文档目标

本文档用于起草 Aily 新一代板卡描述模型，解决当前 `board.json` 与 `package.json` 职责混杂的问题，并为以下目标提供统一合同：

1. 第一阶段兼容 Arduino 生态。
2. 后续扩展到 ESP-IDF、STM32、RP2040 等不同开发方式。
3. 让板卡描述、依赖解析、构建上传三层职责解耦。
4. 让 `project.aci` 只保存用户意图，不直接暴露底层 npm/xPack/CLI 细节。
5. 统一当前 Arduino 阶段 `board / platform / toolchain / tool / library` 资产的语义边界与命名方式。

本文档同时回答两个问题：

1. 现有 `board.json` 和 `package.json` 应该如何拆字段。
2. Arduino 的 package/platform/board 方案可以借鉴到什么程度。

---

## 2. 核心结论

新的模型建议拆成四层文件职责：

| 文件 | 角色 | 是否面向用户 | 主要职责 |
|------|------|--------------|----------|
| `info.json` | 检索元数据 | 否 | 搜索、筛选、展示，不参与构建解析 |
| `board-manifest.json` | 板卡语义描述 | 否 | 描述板卡身份、能力、引脚、总线、可支持框架 |
| `resolver.json` | 框架/平台解析规则 | 否 | 把 `board + framework + version` 解析为具体 platform 包、工具链、上传工具、构建驱动 |
| `package.json` | 发布元数据 | 否 | 仅服务 npm/xPack 发布，不再承载板卡构建语义 |

对应关系如下：

1. `project.aci` 保存用户意图，例如 `board=esp32`、`framework=arduino`、`platform=esp32`。
2. `board-manifest.json` 告诉系统这块板子是什么、支持哪些框架、有哪些引脚和能力。
3. `resolver.json` 告诉系统某个框架版本下应该安装哪些包、走什么构建/上传链路。
4. `aily.lock.json` 保存最终解析结果，保证跨机器复现。

此外，按当前 Arduino 阶段的现有仓库与包形态，建议先做如下重新归类：

| 当前来源 | 当前典型内容 | 在新模型中的语义角色 |
|----------|--------------|----------------------|
| `aily-blockly-boards` | `board.json`、`info.json`、模板目录 | board catalog、board manifest source、board preset source |
| `aily-project-sdks` | `@aily-project/sdk-*` | Arduino platform package 的一期兼容工件 |
| `aily-project-compilers` | `@aily-project/compiler-*` | toolchain package 的一期兼容工件 |
| `aily-project-tools` | `@aily-project/tool-*` | tool package |
| `aily-blockly-libraries` | 当前 Arduino/C++ 库包与索引 | library package / library catalog |
| `aily-builder` | 编译、上传 CLI | build/upload driver，不属于包分发层 |

这张表的意义是：当前这些资产虽然都来自 Arduino 阶段，但在新模型里不应继续混在一个 `board.json` 或单个 `package.json` 里，而应分别落到 board、platform、toolchain、tool、library 五类角色上。

---

## 3. 是否参考 Arduino package 方案

可以参考，但不能原样照搬。

### 3.1 应该借鉴的部分

Arduino 方案里最值得保留的是三层分离：

1. `platform/core` 表示一个平台发布单元，例如 `esp32:esp32`。
2. `board` 表示平台内部的具体开发板，例如 `esp32`、`esp32s3`。
3. `toolsDependencies` 表示该平台版本依赖的编译器、烧录器、辅助工具。

这和我们要做的事高度一致：

1. 板子不是工具链。
2. 板子不是 SDK。
3. 一个平台版本下可以支持很多板子。
4. 工具链和上传工具应版本化、可独立升级。

### 3.2 不应该照搬的部分

Arduino 方案里不适合直接成为我们主合同的内容有三类：

1. FQBN 和原始命令字符串，如 `esp32:esp32:esp32`、`compile -v -b ...`。
2. `platform.txt` / `boards.txt` 风格的大量 recipe 文本拼接。
3. 强绑定 Arduino CLI 的参数表达方式。

这些内容在我们体系里应该降级为：

1. 可推导字段。
2. 某个 framework adapter 的实现细节。
3. resolver 输出的一部分，而不是 board 主描述。

### 3.3 Aily 对 Arduino 模式的映射建议

| Arduino 概念 | Aily 对应层 |
|--------------|-------------|
| package index / platform release | `resolver.json` |
| board definition | `board-manifest.json` |
| toolsDependencies | `resolver.packages.tools` / `resolver.packages.toolchain` |
| FQBN | `frameworkProfiles.arduino.platformRef` 推导结果 |
| boards.txt 菜单项 | `frameworkProfiles.arduino.menus` |
| platform.txt recipes | `resolver.build` / `resolver.upload` 的结构化规则 |

结论：

1. 可以参考 Arduino 的“平台 + 板子 + 工具依赖”模型。
2. 不建议继续把 Arduino 风格命令行字符串作为系统主真相源。

### 3.4 双安装入口建议

建议同时支持两种用户入口，而不是二选一。

#### 模式 A：直接安装某块开发板

用户执行：

```bash
xpm install @aily-project/board-xxx
```

这个模式适合：

1. 用户明确知道自己要用哪一块板子。
2. 希望安装完成后立刻具备“可编译、可烧录、带板载器件默认库”的体验。
3. 适合作为新手入口和模板工程入口。

此时 `@aily-project/board-xxx` 应被定义为一个 **thin preset package**，它本身不是 platform 包、toolchain 包或普通 library 包，而是一个方便安装的板级预设包。它建议具备以下特征：

1. 依赖对应的 platform package。
2. 通过 platform package 间接获得当前 framework 所需的 toolchain 和 tools。
3. 可选带上该板子的默认库集合，例如板载 IMU、屏幕、传感器等。
4. 如果需要附带板级模板、示例或元数据，可作为 board package 自身内容，不必强制再拆出独立板级运行时包。
5. 自身尽量薄，主要由 manifest/resolver 自动生成，而不是手工长期维护。

#### 模式 B：先安装 platform package，再选择板子

用户执行：

```bash
xpm install @aily-project/platform-esp32-arduino
```

然后在项目设置或 `project.aci` 中选择具体板子，例如：

```json
{
  "target": {
    "platform": "esp32",
    "framework": "arduino",
    "board": "esp32dev"
  }
}
```

这个模式适合：

1. Arduino 风格用户心智。
2. 同一平台下频繁切换板型。
3. 希望项目依赖更精简，不在安装阶段自动带很多板级附加库。

此时 `@aily-project/platform-esp32-arduino` 应承担的职责是：

1. 提供该平台/框架版本的 resolver。
2. 提供 board catalog，使 IDE 可以下拉选择平台内的板子。
3. 安装该平台所需的基础 platform/Arduino Core、toolchain、upload/debug tools。
4. 不默认带入某个具体板子的附加业务库。

#### 推荐结论

建议两个模式都保留，但分工不同：

| 安装入口 | 角色 | 自动安装内容 |
|----------|------|--------------|
| `@aily-project/platform-*` | 平台级入口 | 平台基础依赖 |
| `@aily-project/board-*` | 板级快捷入口 | 平台基础依赖 + 默认板载库 + 可选板级模板/示例资源 |

这意味着：

1. 平台包是主干模型，贴近 Arduino package 思路。
2. 板级包是便捷入口，贴近当前按板安装的用户习惯。
3. 两者不冲突，且可以由同一套源数据生成。

### 3.5 `sdk` 还是 `platform` 的命名建议

建议把这个问题分成两个层次：

#### 语义层

schema 和 resolver 的主语义建议统一使用 `platform`，不再把主槽位命名为 `sdk`。

原因是：

1. 现有 `@aily-project/sdk-esp32` 实际上更接近 Arduino platform/core 分发，而不是狭义 SDK。
2. 后续会出现 `esp32 + arduino`、`esp32 + esp-idf`、`stm32 + stm32cube` 这样的多框架组合，`sdk` 会越来越歧义。
3. 对 Arduino 兼容阶段来说，最稳定的抽象其实就是 platform。

因此逻辑合同里建议统一叫：

1. `packages.platform`
2. `resolvedTarget.packages.platform`
3. `target.platform`

#### 发布包名层

第一期不建议立刻废弃现有 `@aily-project/sdk-xxx` 包名。

原因是：

1. 现有 boards 仓库和 blockly 依赖已经普遍使用 `sdk-xxx`。
2. `aily-builder` 当前 CLI 也明确使用 `--sdk-path` 这一术语。
3. coder 第一阶段只支持 Arduino，此时立即全量改名收益不高，迁移噪音很大。

因此建议采用过渡策略：

1. schema/resolver 的语义统一叫 `platform`。
2. 第一期 `packages.platform.id` 仍然允许指向现有 `@aily-project/sdk-xxx` 包名。
3. 第二期如果要彻底规范化，再引入如 `@aily-project/platform-esp32-arduino` 的 canonical 名字，并让 `sdk-esp32` 成为兼容别名或 wrapper。

一句话总结：

> 语义上叫 `platform`，一期工件名可以暂时仍叫 `sdk-xxx`。

### 3.6 xpm 工件名、源码仓库名、用户可见产品名要分层

当体系开始以 xpm 为主时，不建议再让新生成的工件继续带 `aily-blockly-*` 前缀。

建议明确分成三层：

#### 分发工件层

面向 xpm/npm 解析、锁文件、依赖安装的工件，统一使用 `@aily-project/*` 命名。

推荐规则：

1. platform 包：`@aily-project/platform-esp32-arduino`
2. board preset 包：`@aily-project/board-esp32dev`
3. toolchain 包：第一阶段可沿用 `@aily-project/compiler-esp-x32`
4. tool 包：`@aily-project/tool-esptool`
5. library 包：`@aily-project/lib-lvgl`
6. 应用或工作台：`aily-coder`
7. 第一阶段历史兼容：允许继续存在 `@aily-project/sdk-esp32`、`@aily-project/compiler-esp-x32` 这类工件名，但只作为过渡名字，不再作为新体系的推荐前缀。

这里的关键约束是：

1. xpm 工件名不要再出现 `aily-blockly-*`。
2. xpm 工件名优先表达“项目基础设施/平台资产”，因此更适合放在 `@aily-project/*` 命名空间下。

按当前 Arduino 阶段的现有资产，可以先这样理解：

1. 现有 `aily-project-sdks` 对应新语义里的 `platform`。
2. 现有 `aily-project-compilers` 对应新语义里的 `toolchain`。
3. 现有 `aily-project-tools` 对应新语义里的 `tool`。
4. 现有 `aily-blockly-libraries` 对应新语义里的 `library`。
5. 现有 `aily-blockly-boards` 对应新语义里的 board catalog / board preset source。

#### 源码仓库层

源码仓库名可以与分发工件名不同步，不必强行一一对应。

也就是说：

1. 当前仓库短期内即使仍叫 `aily-blockly-boards`，也不代表未来 xpm 工件必须继续叫 `aily-blockly-*`。
2. 如果后续逐步收敛仓库命名，建议向 `aily-project-boards`、`aily-project-tools`、`aily-project-sdks` 或更中性的 catalog/repo 名称演进。
3. 仓库名是研发组织问题，工件名是产品分发合同问题，二者不要绑死。

#### 用户可见产品层

用户在 coder 侧主要感知的不是包管理本身，而是：

1. 对话
2. 调试
3. 仿真
4. 烧录/运行
5. 开发板与运行环境选择

因此用户可见的产品名和页面信息更适合收敛到 `aily-coder`，而不是暴露 `aily-blockly-*` 或大量包 ID。

建议 UI/产品层遵循：

1. 应用或工作台层面用 `aily-coder`。
2. 页面/面板层面用“对话”“调试”“仿真”“设备”“环境”等能力名称。
3. 只有在诊断页、开发者工具页、锁文件或日志中，才显示 `@aily-project/*` 这类真实工件 ID。
4. Agent 运行时仍然操作代码、工具链、工程文件和命令，但这些实现细节默认不作为主要用户可见概念。

一句话总结：

> xpm 分发层用 `@aily-project/*`，产品层用 `aily-coder`，不要再把 `aily-blockly-*` 作为未来纯代码体系的对外命名。

---

## 4. 推荐目录结构

建议在 boards 仓库内逐步演进到如下结构：

```text
aily-project-boards/
├── BOARD_INFO_SCHEMA.md
├── BOARD_MANIFEST_RESOLVER_SCHEMA_DRAFT.md
├── resolvers/
│   ├── esp32/
│   │   ├── arduino/
│   │   │   └── 3.3.1.json
│   │   └── esp-idf/
│   │       └── 5.1.2.json
│   ├── stm32/
│   │   ├── arduino/
│   │   └── stm32cube/
│   └── rp2040/
│       └── arduino/
├── esp32/
│   ├── info.json
│   ├── board-manifest.json
│   ├── package.json
│   └── template/
└── ...
```

说明：

1. `info.json` 继续只承担检索角色。
2. `board-manifest.json` 作为每块板子的语义描述入口。
3. `resolvers/` 作为按 `family/framework/version` 组织的解析规则库。
4. `package.json` 如果继续保留，只作为分发层元数据，不再是构建语义真相源。
5. 这里的目录名表示推荐的未来源码组织名，不要求与现有 legacy 仓库名完全一致。
6. 即使源码仓库暂时仍在 `aily-blockly-boards`，xpm/npm 生成工件也不应继续使用 `aily-blockly-*` 前缀。

### 4.1 当前 Arduino 资产的分仓建议

如果继续维持分仓模式，建议按资产角色理解为：

| 推荐仓库角色 | 当前仓库现状 | 主要产物 |
|--------------|--------------|----------|
| boards catalog repo | `aily-blockly-boards` | `info.json`、`board-manifest.json`、resolver 源、board preset 源 |
| platform repo | `aily-project-sdks` | Arduino platform package 的一期兼容工件 |
| toolchain repo | `aily-project-compilers` | compiler/toolchain 包 |
| tools repo | `aily-project-tools` | upload/debug/辅助工具包 |
| libraries repo | `aily-blockly-libraries` | Arduino/C++ 库包和索引 |
| build driver repo | `aily-builder` | `aily-builder` CLI 本体 |

这样处理之后，文档里的 `board-manifest` 和 `resolver` 就只负责板卡描述与环境解析，不再隐式承载“库包目录长什么样”“工具包怎么命名”这类分发层历史问题。

---

## 5. Board Manifest Schema Draft

`board-manifest.json` 的职责是表达“这块板子是什么”，而不是“怎么执行某条具体命令”。

### 5.1 顶层结构建议

```json
{
  "$schema": "https://schemas.aily.dev/boards/board-manifest/v1.json",
  "schemaVersion": "1.0",
  "id": "esp32",
  "displayName": "ESP32 board",
  "vendor": {
    "id": "espressif",
    "name": "Espressif"
  },
  "kind": "board",
  "family": "esp32",
  "formFactor": "development-board",
  "summary": "Generic ESP32 development board",
  "mcu": {},
  "memory": {},
  "connectivity": [],
  "interfaces": [],
  "support": {},
  "pins": {},
  "buses": {},
  "onboard": {},
  "monitor": {},
  "frameworkProfiles": {},
  "templates": {},
  "extensions": {}
}
```

### 5.2 字段定义

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `$schema` | string | 是 | schema 地址 |
| `schemaVersion` | string | 是 | manifest 合同版本 |
| `id` | string | 是 | 稳定板卡 ID，建议与目录名一致 |
| `displayName` | string | 是 | UI 展示名称 |
| `vendor` | object | 是 | 厂商标识，不再散落在 `package.json` |
| `kind` | enum | 是 | `board` 或 `series` |
| `family` | string | 是 | 目标族，如 `esp32`、`stm32f4`、`rp2040` |
| `formFactor` | string | 否 | 形态，例如开发板、模组、系列 |
| `summary` | string | 否 | 简短说明 |
| `mcu` | object | 是 | MCU/SoC 描述 |
| `memory` | object | 否 | Flash/SRAM/PSRAM |
| `connectivity` | string[] | 否 | Wi-Fi、BLE、Ethernet 等 |
| `interfaces` | string[] | 否 | UART/I2C/SPI/CAN/USB 等 |
| `support` | object | 是 | 支持的框架、上传方式、调试方式 |
| `pins` | object | 否 | 引脚分组、别名、能力标记 |
| `buses` | object | 否 | I2C/SPI/UART 等总线实例与默认引脚 |
| `onboard` | object | 否 | 板载器件、默认外设、推荐库映射 |
| `monitor` | object | 否 | 串口监视器默认值 |
| `frameworkProfiles` | object | 是 | 各框架下的板级输入参数和覆盖项 |
| `templates` | object | 否 | 项目模板、默认依赖、推荐依赖 |
| `extensions` | object | 否 | 厂商私有扩展区 |

### 5.3 推荐的 `support` 结构

```json
"support": {
  "frameworks": ["arduino", "esp-idf"],
  "uploadTransports": ["serial", "usb", "network"],
  "debugTransports": ["jtag", "cmsis-dap"],
  "monitorTransports": ["serial"]
}
```

### 5.4 推荐的 `pins` 结构

```json
"pins": {
  "groups": {
    "digital": ["0", "1", "2"],
    "analog": ["32", "33", "34"],
    "pwm": ["2", "4", "5"],
    "interrupt": ["2", "4", "5"]
  },
  "aliases": {
    "builtinLed": "2",
    "defaultI2cSda": "21",
    "defaultI2cScl": "22"
  },
  "capabilities": {
    "touch": ["4", "12", "13"],
    "dac": ["25", "26"]
  }
}
```

### 5.5 推荐的 `buses` 结构

```json
"buses": {
  "uart": [
    {
      "id": "Serial",
      "tx": "1",
      "rx": "3"
    }
  ],
  "i2c": [
    {
      "id": "Wire",
      "sda": "21",
      "scl": "22",
      "supportedSpeeds": [100000, 400000]
    }
  ],
  "spi": [
    {
      "id": "SPI",
      "mosi": "23",
      "miso": "19",
      "sck": "18"
    }
  ]
}
```

### 5.6 推荐的 `frameworkProfiles` 结构

`frameworkProfiles` 只表达“某个框架下，这块板子需要提供哪些解析输入或板级覆盖”，不直接表达工具链下载细节。

```json
"frameworkProfiles": {
  "arduino": {
    "resolverRef": "esp32/arduino/3.x",
    "platformRef": {
      "package": "esp32",
      "architecture": "esp32",
      "boardId": "esp32"
    },
    "rawSources": {
      "variantFiles": ["variants/esp32/pins_arduino.h"],
      "boardFiles": ["boards.txt"]
    },
    "menus": {},
    "buildProperties": {},
    "upload": {
      "transport": "serial"
    }
  },
  "esp-idf": {
    "resolverRef": "esp32/esp-idf/5.1.x",
    "target": "esp32",
    "sdkconfigDefaults": ["sdkconfig.defaults"],
    "partitionTable": "partitions.csv"
  }
}
```

### 5.7 推荐的 `onboard` 结构

`onboard` 用于描述板载器件与它们推荐使用的库，而不是描述整个依赖树。

```json
"onboard": {
  "devices": [
    {
      "id": "imu",
      "kind": "sensor",
      "model": "BMI270",
      "bus": "i2c",
      "address": "0x68",
      "library": {
        "id": "@aily-project/lib-bmi270",
        "version": "^1.0.0"
      }
    }
  ]
}
```

### 5.8 推荐的 `templates` 结构

建议把当前 Arduino/Blockly 阶段 `template/package.json` 中的默认库信息提升到 manifest 的显式字段，避免以后仍靠模板里的 npm 文件做主真相源。

```json
"templates": {
  "project": "template/",
  "defaultDependencies": [
    {
      "id": "@aily-project/lib-bmi270",
      "version": "^1.0.0",
      "reason": "onboard-device"
    }
  ],
  "recommendedDependencies": [
    {
      "id": "@aily-project/lib-lvgl",
      "version": "^8.3.0",
      "reason": "display-stack"
    }
  ]
}
```

建议规则：

1. `defaultDependencies` 用于“新建项目时默认带上”或“直接安装 board package 时自动带上”。
2. `recommendedDependencies` 只用于推荐，不应在切换板子时强制安装。
3. 平台安装模式下，只有在用户选择具体板子并创建项目时，才考虑应用 `defaultDependencies`。
4. 这里表达的是项目库依赖，不是 `resolver.packages` 里的 platform/toolchain/tools 环境资产。

### 5.9 非 Blockly 场景下的 `pins` / `buses` 保留策略

即使转向 C++ + LLM，也仍然建议保留一层 **归一化、轻量化** 的 pins/buses 元数据，不建议完全依赖 framework 的 `variant` 文件。

原因有三点：

1. `variant` 文件是框架私有实现细节，不同框架格式不同，LLM 每次临时解析成本高。
2. 板级别名、默认 I2C/SPI/UART、板载 LED、默认监视器参数，都是高频信息，值得结构化保留。
3. 后续 IDE、代码生成、诊断、提示词构建、模板生成，都需要稳定且统一的板级能力来源。

因此建议分三层：

1. **必须保留的最小层**：`pins.aliases`、`pins.groups`、`buses`、`monitor`。
2. **可选保留的增强层**：部分引脚能力，如 PWM、ADC、Touch、DAC。
3. **不必在 manifest 完整保留的深层细节**：完整 pin mux、所有 alternate functions、底层寄存器信息。这些可在需要时通过 `rawSources.variantFiles` 指到 framework 原始文件。

换句话说：

1. 不建议继续保留 Blockly 那种“为了下拉框而列出所有 UI 值”的重模型。
2. 也不建议完全删除引脚/总线信息。
3. 建议改为“最小可用板级能力模型 + 指向 variant/raw source 的引用”。

### 5.10 ESP32 示例

```json
{
  "$schema": "https://schemas.aily.dev/boards/board-manifest/v1.json",
  "schemaVersion": "1.0",
  "id": "esp32",
  "displayName": "ESP32 board",
  "vendor": {
    "id": "espressif",
    "name": "Espressif"
  },
  "kind": "board",
  "family": "esp32",
  "formFactor": "development-board",
  "summary": "Generic ESP32 development board",
  "mcu": {
    "model": "ESP32",
    "architecture": "xtensa-lx6",
    "cores": 2,
    "frequency": {
      "value": 240,
      "unit": "MHz"
    }
  },
  "memory": {
    "flash": {
      "value": 4096,
      "unit": "KB"
    },
    "sram": {
      "value": 520,
      "unit": "KB"
    }
  },
  "connectivity": ["wifi", "ble", "bluetooth-classic"],
  "interfaces": ["uart", "i2c", "spi", "i2s", "adc", "dac", "touch", "sd-card"],
  "support": {
    "frameworks": ["arduino", "esp-idf"],
    "uploadTransports": ["serial"],
    "debugTransports": ["jtag"],
    "monitorTransports": ["serial"]
  },
  "pins": {
    "groups": {
      "digital": ["0", "1", "2", "3", "4", "5", "12", "13", "14", "15", "16", "17", "18", "19", "21", "22", "23", "25", "26", "27", "32", "33", "34", "35", "36", "39"],
      "analog": ["36", "39", "32", "33", "34", "35", "4", "0", "2", "15", "13", "12", "14", "27", "25", "26"],
      "pwm": ["0", "2", "4", "5", "12", "13", "14", "15", "16", "17", "18", "19", "21", "22", "23", "25", "26", "27", "32", "33"]
    },
    "aliases": {
      "defaultI2cSda": "21",
      "defaultI2cScl": "22"
    }
  },
  "buses": {
    "uart": [{ "id": "Serial", "tx": "1", "rx": "3" }],
    "i2c": [{ "id": "Wire", "sda": "21", "scl": "22", "supportedSpeeds": [100000, 400000] }],
    "spi": [{ "id": "SPI", "mosi": "23", "miso": "19", "sck": "18" }]
  },
  "onboard": {
    "devices": []
  },
  "monitor": {
    "defaultBaud": 115200,
    "supportedBaudRates": [1200, 9600, 19200, 38400, 57600, 115200]
  },
  "frameworkProfiles": {
    "arduino": {
      "resolverRef": "esp32/arduino/3.x",
      "platformRef": {
        "package": "esp32",
        "architecture": "esp32",
        "boardId": "esp32"
      },
      "rawSources": {
        "variantFiles": ["variants/esp32/pins_arduino.h"],
        "boardFiles": ["boards.txt"]
      },
      "menus": {},
      "buildProperties": {}
    },
    "esp-idf": {
      "resolverRef": "esp32/esp-idf/5.1.x",
      "target": "esp32"
    }
  },
  "templates": {
    "project": "template/",
    "defaultDependencies": [],
    "recommendedDependencies": []
  }
}
```

---

## 6. Resolver Schema Draft

resolver 的职责是表达“在某个框架版本下，如何把板卡逻辑坐标解析成具体可安装、可执行、可构建的实体”。

### 6.1 为什么要单独做 resolver

因为同一块板子在不同开发方式下依赖完全不同：

1. `esp32 + arduino` 需要 Arduino Core、esptool、xtensa 工具链。
2. `esp32 + esp-idf` 需要 ESP-IDF、cmake、ninja、idf toolchain、不同的 flash/debug 规则。
3. `stm32f4 + arduino` 和 `stm32f4 + stm32cube` 的包图也不同。
4. 当前 Arduino 阶段已有的 boards/tools/libraries 也必须分别落到 `board-manifest`、`resolver.packages`、`templates/project dependencies` 三层，而不是继续揉在一个 legacy `package.json` 里。

所以 resolver 必须独立于 board manifest。

### 6.2 顶层结构建议

```json
{
  "$schema": "https://schemas.aily.dev/boards/resolver/v1.json",
  "schemaVersion": "1.0",
  "id": "esp32-arduino",
  "family": "esp32",
  "framework": "arduino",
  "release": {
    "version": "3.3.1"
  },
  "match": {},
  "packages": {},
  "build": {},
  "upload": {},
  "monitor": {},
  "debug": {},
  "extensions": {}
}
```

### 6.3 字段定义

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `$schema` | string | 是 | schema 地址 |
| `schemaVersion` | string | 是 | resolver 合同版本 |
| `id` | string | 是 | resolver 稳定 ID |
| `family` | string | 是 | 目标族，例如 `esp32` |
| `framework` | string | 是 | `arduino`、`esp-idf`、`stm32cube` 等 |
| `release.version` | string | 是 | 框架解析版本 |
| `match` | object | 是 | 适用的板卡/MCU/变体范围 |
| `packages` | object | 是 | 需要安装的 platform、toolchain、tools 等框架运行资产 |
| `build` | object | 是 | 构建驱动、属性映射、产物规则 |
| `upload` | object | 否 | 烧录规则 |
| `monitor` | object | 否 | 监视器规则 |
| `debug` | object | 否 | 调试器规则 |
| `extensions` | object | 否 | 扩展字段 |

### 6.4 推荐的 `packages` 结构

```json
"packages": {
  "platform": {
    "id": "@aily-project/sdk-esp32",
    "version": "3.3.1",
    "source": "xpack",
    "artifactRole": "platform"
  },
  "toolchain": {
    "id": "@aily-project/compiler-esp-x32",
    "version": "14.2.0",
    "source": "xpack",
    "artifactRole": "toolchain"
  },
  "tools": [
    {
      "id": "@aily-project/tool-esptool_py",
      "version": "5.1.0",
      "source": "xpack"
    },
    {
      "id": "@aily-project/tool-ctags",
      "version": "5.8.0",
      "source": "xpack"
    }
  ]
}
```

补充说明：

1. 这里的语义字段叫 `platform`。
2. 但第一期 `id` 仍可直接指向现有 `@aily-project/sdk-esp32` 这类包名。
3. `toolchain` 语义第一期也可以直接指向现有 `@aily-project/compiler-*` 包名。
4. `packages` 主要承载 framework runtime 环境资产；普通项目库应进入 `templates.defaultDependencies`、`templates.recommendedDependencies` 或项目级依赖清单。

### 6.5 推荐的 `build` 结构

```json
"build": {
  "driver": "aily-builder",
  "driverMode": "arduino-compatible",
  "entry": "src/main.cpp",
  "platformRef": {
    "package": "esp32",
    "architecture": "esp32"
  },
  "boardRef": {
    "fqbn": "esp32:esp32:esp32"
  },
  "driverInputs": {
    "sdkPathFrom": "packages.platform",
    "toolsPathFrom": "tool-store",
    "toolVersionsFrom": ["packages.toolchain", "packages.tools"],
    "boardOptions": {},
    "buildProperties": {}
  },
  "artifactMap": {
    "application": "build/app.bin",
    "bootloader": "build/bootloader.bin",
    "partitions": "build/partitions.bin",
    "bootApp0": "build/boot_app0.bin"
  },
  "env": {}
}
```

第一期如果 coder 只支持 Arduino，建议明确把 `aily-builder` 作为唯一 canonical build driver。

这样 resolver 至少要能稳定产出这些输入：

1. `boardRef.fqbn`，供 `aily-builder --board` 使用。
2. `packages.platform.id`，供运行时解析出 `--sdk-path`。
3. `packages.toolchain` 与 `packages.tools`，供生成 `--tool-versions`。
4. `driverInputs.boardOptions`，供透传 `--board-options`。
5. `driverInputs.buildProperties`，供透传 `--build-property`。

也就是说，一期不需要把 blockly 时代所有命令行字符串直接保留下来，但必须保留足够的信息，能无损映射到 `aily-builder` 当前 CLI 合同。

### 6.6 推荐的 `upload` 结构

```json
"upload": {
  "driver": "aily-builder",
  "driverMode": "arduino-compatible",
  "transport": "serial",
  "portParam": "--port",
  "fileParam": "--file",
  "buildProperties": {},
  "legacyCommandTemplate": null
}
```

说明：

1. 第一阶段优先通过 `aily-builder upload` 驱动上传。
2. 如果少数板子在过渡期还存在特殊上传 recipe，可临时放在 `legacyCommandTemplate` 中，但不建议再把它升级为长期主合同。

### 6.7 推荐的 `monitor` 结构

```json
"monitor": {
  "transport": "serial",
  "defaultBaud": 115200
}
```

### 6.8 Arduino-ESP32 resolver 示例

```json
{
  "$schema": "https://schemas.aily.dev/boards/resolver/v1.json",
  "schemaVersion": "1.0",
  "id": "esp32-arduino",
  "family": "esp32",
  "framework": "arduino",
  "release": {
    "version": "3.3.1"
  },
  "match": {
    "boards": ["esp32", "esp32dev", "wifiduino32"],
    "mcu": ["esp32"]
  },
  "packages": {
    "platform": {
      "id": "@aily-project/sdk-esp32",
      "version": "3.3.1",
      "source": "xpack",
      "artifactRole": "platform"
    },
    "toolchain": {
      "id": "@aily-project/compiler-esp-x32",
      "version": "14.2.0",
      "source": "xpack",
      "artifactRole": "toolchain"
    },
    "tools": [
      {
        "id": "@aily-project/tool-esptool_py",
        "version": "5.1.0",
        "source": "xpack"
      },
      {
        "id": "@aily-project/tool-ctags",
        "version": "5.8.0",
        "source": "xpack"
      }
    ]
  },
  "build": {
    "driver": "aily-builder",
    "driverMode": "arduino-compatible",
    "entry": "src/main.cpp",
    "platformRef": {
      "package": "esp32",
      "architecture": "esp32"
    },
    "boardRef": {
      "fqbn": "esp32:esp32:esp32"
    },
    "driverInputs": {
      "sdkPathFrom": "packages.platform",
      "toolsPathFrom": "tool-store",
      "toolVersionsFrom": ["packages.toolchain", "packages.tools"],
      "boardOptions": {},
      "buildProperties": {}
    },
    "artifactMap": {
      "application": "build/app.bin",
      "bootloader": "build/bootloader.bin",
      "partitions": "build/partitions.bin",
      "bootApp0": "build/boot_app0.bin"
    }
  },
  "upload": {
    "driver": "aily-builder",
    "driverMode": "arduino-compatible",
    "transport": "serial",
    "portParam": "--port",
    "fileParam": "--file",
    "buildProperties": {},
    "legacyCommandTemplate": null
  },
  "monitor": {
    "transport": "serial",
    "defaultBaud": 115200
  }
}
```

---

## 7. 解析结果快照建议

resolver 结果最终应写入 `aily.lock.json`，而不是回写到 `project.aci`。

建议结构：

```json
{
  "resolvedTarget": {
    "board": "esp32",
    "framework": "arduino",
    "boardManifest": {
      "id": "esp32",
      "schemaVersion": "1.0"
    },
    "resolver": {
      "id": "esp32-arduino",
      "version": "3.3.1"
    },
    "packages": {
      "platform": "@aily-project/sdk-esp32@3.3.1",
      "toolchain": "@aily-project/compiler-esp-x32@14.2.0",
      "tools": [
        "@aily-project/tool-esptool_py@5.1.0",
        "@aily-project/tool-ctags@5.8.0"
      ]
    },
    "projectDependencies": {
      "libraries": ["@aily-project/lib-bmi270@^1.0.0"]
    },
    "build": {},
    "upload": {},
    "monitor": {}
  }
}
```

这样可以保证：

1. `project.aci` 只保存用户意图。
2. 锁文件保存确定后的解析结果。
3. xPack bridge 文件只是派生产物，不是主配置合同。
4. 如果项目是通过 platform package 安装后再选择 board，锁文件里也能保存最终选中的 board 及其默认库依赖应用结果。

---

## 8. 现有 `board.json` 字段迁移表

### 8.1 应迁入 `board-manifest.json` 的字段

| 当前字段 | 新位置 | 说明 |
|----------|--------|------|
| `name` | `displayName` | UI 名称 |
| `description` | `summary` | 简短说明 |
| `mode` | `support.frameworks` | 支持的开发方式 |
| `analogPins` | `pins.groups.analog` | 引脚分组 |
| `digitalPins` | `pins.groups.digital` | 引脚分组 |
| `pwmPins` | `pins.groups.pwm` | 引脚分组 |
| `interruptPins` | `pins.groups.interrupt` | 引脚能力 |
| `builtinLed` | `pins.aliases.builtinLed` | 板级别名 |
| `serialPort` | `buses.uart[]` | 总线实例 |
| `serialSpeed` | `monitor.supportedBaudRates` | 监视器默认值 |
| `spi` | `buses.spi[]` | SPI 实例 |
| `spiPins` | `buses.spi[]` | SPI 引脚映射 |
| `spiClockDivide` | `frameworkProfiles.arduino.spi` 或 `extensions` | 框架特有默认值 |
| `i2c` | `buses.i2c[]` | I2C 实例 |
| `i2cPins` | `buses.i2c[]` | I2C 引脚映射 |
| `i2cSpeed` | `buses.i2c[].supportedSpeeds` | I2C 能力 |
| `core` | `frameworkProfiles.<framework>.platformRef` | 不再保留为模糊字符串 |
| `type` | `frameworkProfiles.arduino.platformRef.boardId` 等 | 不再保留为单一字符串 |

补充迁移：

| 当前来源 | 新位置 | 说明 |
|----------|--------|------|
| `template/package.json.dependencies` | `templates.defaultDependencies` | 当前默认库集合可以直接迁移 |
| 板载器件事实（如果已知） | `onboard.devices` | 便于 direct install 和模板生成 |

### 8.2 不应再作为 `board-manifest.json` 主字段保留的内容

| 当前字段 | 新位置 | 原因 |
|----------|--------|------|
| `version` | 不建议作为 board manifest 语义字段 | 板卡描述版本不应等于 platform 版本 |
| `compilerTool` | `resolver.build.driver` | 这是执行层选择，不是板卡身份 |
| `compilerParam` | `resolver.build.*` | 不应再用命令字符串作为主真相源 |
| `uploadParam` | `resolver.upload.*` | 应拆成结构化上传规则 |

---

## 9. 现有 `package.json` 字段迁移表

### 9.1 `package.json` 建议保留为发布元数据

| 当前字段 | 建议去向 | 说明 |
|----------|----------|------|
| `name` | `package.json` | 包发布名，可继续保留 |
| `version` | `package.json` | 包发布版本，可独立于 SDK 版本 |
| `license` | `package.json` | 发布元数据 |
| `author` | `package.json` | 发布元数据 |
| `description*` | `package.json` 或由 manifest/info 生成 | 建议不要再作为解析真相源 |
| `brand` | `board-manifest.json.vendor` | 应回归板卡语义层 |

### 9.2 必须迁出的字段

| 当前字段 | 新位置 | 原因 |
|----------|--------|------|
| `boardDependencies` | `resolver.packages` | 这是框架解析结果，不是发布元数据 |

如果保留 `@aily-project/board-xxx` 这种板级快捷安装包，建议它的依赖由脚本根据以下三类输入自动生成：

1. `resolver.packages` 中的 platform/toolchain/tools 环境依赖。
2. `templates.defaultDependencies` 中声明的默认板载库。
3. 板级模板、示例、metadata 等随 board package 本体一起分发的资源。

### 9.3 版本策略建议

现有规范要求“板卡包版本等于 SDK/Arduino Core 版本”，这个规则不建议继续沿用。

建议改为：

1. `board-manifest.json` 描述板卡语义，不和某个 platform/Arduino Core 版本绑定。
2. `resolver.release.version` 描述某个框架解析版本，例如 `arduino@3.3.1`。
3. `package.json.version` 只表示这个发布工件本身的版本，可以跟随 manifest 变更或仓库发布节奏。

如果按本文建议收敛语义，建议进一步理解为：

1. 一期现有 `sdk-xxx` 工件名可以继续沿用。
2. 但它在逻辑上应被看作 Arduino `platform package`。
3. 后续多框架阶段不再继续新增语义混乱的 `sdk-*` 名字。

这更接近 Arduino 的思路：

1. 平台版本是平台版本。
2. 板子 ID 是稳定的板子 ID。
3. 板子不需要和平台版本一一绑死。

---

## 10. 第一阶段落地建议

### 10.1 Arduino 兼容阶段

目标是先把现有 Arduino/ESP32 跑通，但不再扩大旧格式债务。

建议做法：

1. `info.json` 保持不变。
2. 新增 `board-manifest.json`，把 `board.json` 里的板卡语义字段迁入。
3. 新增 `resolvers/<family>/arduino/<version>.json`。
4. 把现有 `aily-project-sdks` 先视为 `platform package` 的一期兼容来源。
5. 把现有 `aily-project-compilers` / `aily-project-tools` 先视为 `toolchain` / `tool` 的一期兼容来源。
6. 把现有 `aily-blockly-libraries` 先视为 `library package / library catalog` 的一期兼容来源。
7. `board.json` 暂时保留为 legacy 兼容层，可由新结构生成。
8. `package.json.boardDependencies` 不再新增新字段，后续逐步废弃。

### 10.2 ESP-IDF 阶段

在同一份 `board-manifest.json` 下增加：

1. `frameworkProfiles.esp-idf`。
2. `resolvers/esp32/esp-idf/<version>.json`。
3. 构建驱动切换为 `cmake + ninja`。
4. 上传/分区表/sdkconfig 转为结构化字段。

### 10.3 STM32 / RP2040 阶段

建议按“族 + 框架 + 版本”做 resolver：

1. `resolvers/stm32/arduino/*.json`
2. `resolvers/stm32/stm32cube/*.json`
3. `resolvers/rp2040/arduino/*.json`

如果后续需要支持系列型目标，例如 `STM32F4` 系列而非单块开发板，可在 `board-manifest.json` 中允许 `kind=series` 并引入 `variants`。

### 10.4 自动迁移脚本建议

你的判断是对的，大部分当前 blockly 侧数据都可以复用，而且非常适合做一键迁移。

建议做一个 `migrate-board-package` 脚本，输入当前板卡目录，输出新结构，并尽量保留 legacy 兼容文件。

推荐输入来源：

1. `board.json`
2. `package.json`
3. `info.json`
4. `template/package.json`
5. `template/project.abi`

推荐输出：

1. `board-manifest.json`
2. `resolvers/<family>/<framework>/<version>.json` 中所需的局部条目或 patch
3. 生成型 `@aily-project/board-xxx` 包定义
4. `platform/toolchain/tool/library` 角色映射结果或 catalog 条目
5. 生成型 `@aily-project/platform-xxx-yyy` catalog 或 board index 条目
6. 可选保留 legacy `board.json`

推荐迁移规则：

1. `board.json` 的引脚/总线/别名迁到 `board-manifest.json`。
2. `package.json.boardDependencies` 中的 `sdk/compiler/tool` 依赖分别迁到 `resolver.packages.platform`、`resolver.packages.toolchain`、`resolver.packages.tools`。
3. `template/package.json.dependencies` 中的库依赖迁到 `templates.defaultDependencies`。
4. 如果检测到板载器件特征，可生成 `onboard.devices`。
5. `compilerParam` / `uploadParam` 先进入 legacy 区，后续再由脚本拆成结构化字段。

推荐实施策略：

1. 第一期允许脚本生成 `legacy.compilerParam`、`legacy.uploadParam` 作为过渡。
2. 第二期再把它们拆到 `resolver.build` 和 `resolver.upload`。
3. 库依赖与环境依赖从第一期起就分开落地，不要再混到同一个依赖数组里。
4. 这样可以先批量迁移，再逐步提升结构化程度。

---

## 11. 推荐实施顺序

1. 先冻结 `board-manifest.json` 顶层字段和字段命名。
2. 再冻结 `resolver.json` 的 `packages/build/upload/monitor/debug` 五个主块。
3. 同步冻结 `platform/toolchain/tool/library` 四类分发工件的命名与角色约束。
4. 补上 `platform package` 与 `board package` 的双入口生成规则。
5. 用 `esp32 + arduino` 做第一条完整样板。
6. 让 IDE 先支持从 `project.aci -> board-manifest + resolver -> aily.lock.json` 的解析链。
7. 最后再决定旧 `board.json` 是否完全废弃，还是保留生成兼容层。

---

## 12. 最终建议

如果只保留一句话作为方向约束，建议是：

> `board-manifest.json` 只描述板子，`resolver.json` 只描述框架解析，`package.json` 只描述发布，`project.aci` 只描述用户意图。

进一步展开就是：

1. `board` 资产只回答“板子是什么”。
2. `platform/toolchain/tool` 资产只回答“运行环境怎么装”。
3. `library` 资产只回答“项目代码依赖什么库”。
4. `aily-builder` 只回答“怎么编译/上传”。

这套边界既能兼容 Arduino 的心智模型，也不会把未来的 ESP-IDF、STM32、xPack、CMake 全部压回到一个 `board.json` 字符串配置里。