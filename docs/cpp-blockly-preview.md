# Coder 的 C++ → Blockly 转换预览

在 `.cpp`、`.cc`、`.cxx`、`.ino` 及 `.h`、`.hpp`、`.hh`、`.hxx` 文件编辑器右上角点击 **C++：打开 Blockly 转换预览**，同一编辑器组打开对应的 Blockly 预览标签页。重复点击复用该文件的预览。点击 **返回源码** 恢复源文件，双击积木定位其源码。转换读取当前编辑器缓冲区，包含未保存修改。

## 实现范围

- 路径为 `C++ → Tree-sitter C++ / WASM → 预览积木数据 → Blockly workspace`，无需 ABS、联网转换或 AI 服务。
- 函数、命名空间、类/结构体、模板、lambda 回调、条件编译分支、switch/case、指针/数组/多变量声明、构造与列表初始化、下标、三元表达式、类型转换、成员访问和链式调用均有结构化表示。循环头与尾保留 C++ 文本，避免错误简化比较符、类型、步长等。
- 支持数组声明后的 Arduino `PROGMEM` 标记：仅在解析副本中以等长空白适配，积木与源码定位始终使用原文。不会在注释/字符串中替换，也不会删除名为 `PROGMEM` 的普通变量。
- 长原始字符串和超过 24 项的纯字面量数组转为数据积木，显示字符/行数或元素数量；完整原文保存在源码映射中，双击可定位。包含函数调用等表达式的数组继续展开，不隐藏执行逻辑。
- 未覆盖语法（如当前的 try/catch）仍以橙色原文积木保留，并提供定位诊断。长标签仅作显示截断。
- 语法错误显示诊断及空画布；空文件显示空状态。解析在 Worker 内运行，有 15 秒超时、200,000 字符和 2,000 积木限制。源码改变、重新转换、关闭预览时取消旧任务，避免旧结果覆盖新内容。
- 提供刷新、缩放、适应画布和源码列表。范围选择器支持整个文件、函数、类/命名空间、模板和单独回调；较大程序默认显示 `setup` 或首个函数。整个文件视图仍可查看全部积木。刷新保持查看范围，签名相同的多个 lambda 通过源码内容及位置区分。

这是只读的 **C++ 结构预览**，采用专用 `cpp_preview_*` 积木。它不自动匹配 Aily 硬件库积木，不生成可编辑 `.abi`，不运行 Arduino 代码生成器，也不承诺编译或运行行为等价。预览不会保存、更改或执行源码。后续可编辑导入需要额外的语义映射和生成验证。

## 代码入口

- `src/features/cppBlocklyPreview.workbench.ts`：编辑器按钮、预览页、文档缓冲区和源码定位。
- `src/features/cppBlockly/`：转换器、Worker、积木定义、画布和测试。
- `src/main.common.ts`：注册预览功能。
- `src/embedWorkbenchStyles.ts`：移除隐藏整个编辑器操作栏的旧规则，同时恢复 Markdown 的已有预览入口。

Blockly 和解析器在打开预览后按需加载，与主软件原有 Blockly/ABS 工作区隔离。入口位于 Coder 子应用，没有修改 Angular 主软件代码。

## 验证记录（2026-09-23）

自动检查：原有回归加复杂语法测试共 15 项（包含通过环境变量启用的真实工程检查）通过；覆盖真实 Blockly workspace 装载、调用顺序、类/模板/lambda 内部结构、循环边界、错误输入、Unicode/CRLF、PROGMEM、3,000 项数组折叠和资源限制。`npm run build` 包含 lint、类型检查、运行时与前端打包并通过；`git diff --check` 通过。

通过 Computer Use 在实际 Electron 主软件的 **Coder 模式**创建独立工程 `cpp-blockly-preview-qa`，通过本地开发子应用 `0.1.13-dev` 和 native filesystem bridge 验证：

| 场景 | 实际结果 |
| --- | --- |
| 右侧预览图标 → Blockly | `preview-demo.cpp` 成功渲染 40 个真实积木，包含 `setup`、`loop`、条件分支和调用参数 |
| 返回源码、重复打开 | 正确返回原文件并复用同一预览标签 |
| 双击积木 | 双击 `delay(500)` 精确选中该调用；修复了嵌套 SVG 事件冒泡导致父函数覆盖选区的问题 |
| 手动刷新 | 重新转换后仍显示 40 个积木，源码保持不变 |
| 未保存源码 | 插入测试注释后预览显示 41 个积木、注释原文及“包含未保存修改”；磁盘源码未变化，测试编辑已撤销 |
| 错误文件 | 空画布显示 `L2:11 缺少 )`、`L4:2 缺少 }`，点击诊断返回源码 |
| 空文件 | 显示“文件为空，暂无可预览的积木” |
| Markdown 回归 | `.md` 显示原有侧边预览图标，没有 C++ 按钮；点击后正常分栏渲染 |
| 最终构建刷新 | 正常加载 WASM，完整展示示例积木，无需重启主程序 |

验证工程位于 `/Users/downey/Documents/aily-code-project/cpp-blockly-preview-qa`。该目录内的多个 CPP 是独立预览样例，包含故意的语法错误及重复函数，不能作为整工程编译测试。未做生产发布、硬件上传或可编辑 Blockly 导入验收。

## 复杂工程专项：linkbit-eink-guwen

真实工程：`/Users/downey/Documents/aily-project/古文/linkbit-eink-guwen`。扩展前通过 Computer Use 复现 `main.cpp` 在 L42:31 报“缺少 ;”、整个画布为空，原因是 `PROGMEM`；本地库实现和点阵头文件也有相同问题。

扩展后通过主软件最近项目入口、实际 Coder 子应用和 native filesystem bridge 验证以下 4 个文件：

| 文件 | 积木总数 | 未覆盖语法原文回退 | 实际界面验证 |
| --- | ---: | ---: | --- |
| `sketch/src/main.cpp` | 719 | 0 | 整个文件、`setup` 的 100 个积木、5 个 lambda 选项；L281 壁纸路由回调的 35 个积木包含链式调用、分支、强制转换与保存/重绘调用；HTML 为 1 个数据块 |
| `sketch/libraries/GuwenUI/src/GuwenUI.cpp` | 912 | 0 | 命名空间内的绘图函数可选择；`blitLabel` 独立显示 23 个积木，参数中的坐标运算保留嵌套结构 |
| `sketch/libraries/GuwenUI/src/GuwenUI.h` | 64 | 0 | 类成员及常量可见；模板范围显示 32 个积木，包括 `drawFrame`、条件校验、分页 do-while 与关断调用 |
| `sketch/libraries/GuwenUI/src/GuwenAssets.h` | 208 | 0 | 22 处点阵常量数据折叠，数组声明保留 `PROGMEM`，显示元素数量及数据片段 |

四份源文件 SHA-256 在操作前后相同。该专项验证覆盖项目入口和自有 GuwenUI 库，未逐个验收 Adafruit/GxEPD2 的全部第三方源码。积木数衡量显示结构，不代表编译或行为等价。

最终版本额外验证：选择 L309 自动轮换 lambda（45 个积木）后点击刷新，范围与内容保持 L309，未跳到第一个同为 `[]()` 的回调；整个文件模式的刷新也保持原范围。

可重复运行的真实文件回归：

```sh
CPP_BLOCKLY_PROJECT='/Users/downey/Documents/aily-project/古文/linkbit-eink-guwen' npm run test:cpp-blockly
```

不设置环境变量时，运行 14 项可移植回归，跳过真实工程文件检查。测试只读取工程文件，不写入或编译工程。
