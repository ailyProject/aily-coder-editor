import type * as vscode from 'vscode'
import { ExtensionHostKind, registerExtension } from '@codingame/monaco-vscode-api/extensions'
import { coderUseEmbedHostNativeFsBridge } from '../coderEmbedEnv.js'
import { getHostEmbedContext, onHostEmbedContextChanged } from '../hostEmbedContext.js'

// Aily View 节点模型
// 字段语义与 docs/aily-code工程视图与信息架构设计.md §4 完全一致
// 该文件仅负责按"蓝图"渲染逻辑工程树，不直接消费真实文件系统
// 当后端 getAilyViewTree(projectId) 就绪后，应替换 ailyViewBlueprint 为远端返回的节点模型

type TreeNodeType =
  | 'group'
  | 'file'
  | 'directory'
  | 'property'
  | 'status'
  | 'artifact-group'
  | 'virtual-file'

type BadgeTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'

interface TreeBadge {
  readonly id: string
  readonly text: string
  readonly tone: BadgeTone
  readonly priority: number
}

/** Angular 写入的 hints 与扩展回退解析共用形状 */
type MainHexArtifact = {
  rel?: string
  abs?: string
  buildPath?: string
}

interface ProjectTreeNode {
  readonly id: string
  readonly type: TreeNodeType
  readonly label: string
  // 节点辅助说明；用于 tooltip 与未来右侧详情面板
  readonly description?: string
  // codicon token，例如 `home`、`folder-library`
  readonly icon: string
  // 相对工程根的路径（仅 file / directory / virtual-file 有意义）
  readonly path?: string
  /** 磁盘绝对路径（固件等工作区外文件；打开/访达/复制时优先使用） */
  readonly absolutePath?: string
  readonly expandable: boolean
  readonly expandedByDefault: boolean
  // 顶层节点是否默认渲染；Generated 在 MVP 高级模式开启前不展示
  readonly visible: boolean
  readonly badges?: readonly TreeBadge[]
  readonly children?: readonly ProjectTreeNode[]
}

const AILY_VIEW_ID = 'ailyView'

/** 与 Angular code-editor-pro 中 AILY_EMBED_OS_REVEAL_CHANNEL 须一致（Worker 兜底用 BroadcastChannel） */
const AILY_EMBED_OS_REVEAL_CHANNEL = 'aily-embed-os-reveal'

/**
 * 与 setup.common 中转用的 postMessage 通道一致；
 * LocalProcess 扩展共享主线程 window，可直接 postMessage 给 Angular 父窗口，避免 BroadcastChannel 异步派发与 close 之间的竞b态。
 */
const AILY_CODER_REVEAL_IN_OS_PM = 'aily-coder-reveal-in-os'

// 命令清单：与 docs/aily-code工程视图与信息架构设计.md §7 严格对齐
// 命令 id 用前缀 `ailyView.`，未来切换到 performTreeAction(nodeId, actionId) 时按 actionId 平滑替换
const COMMANDS = {
  // §7.1 通用菜单
  open: 'ailyView.open',
  openFolder: 'ailyView.openFolder',
  revealInFilesView: 'ailyView.revealInFilesView',
  copyRelativePath: 'ailyView.copyRelativePath',
  // §7.2 main.cpp 额外
  setAsMainEntry: 'ailyView.setAsMainEntry',
  rename: 'ailyView.rename',
  // §7.2 真实目录额外
  newFile: 'ailyView.newFile',
  newFolder: 'ailyView.newFolder',
  // §7.2 project.aci
  openVisualConfig: 'ailyView.openVisualConfig',
  openAsJson: 'ailyView.openAsJson',
  validateConfig: 'ailyView.validateConfig',
  regenerateLockFile: 'ailyView.regenerateLockFile',
  // §7.2 property (Board / MCU / Framework / Upload / Monitor)
  openSettings: 'ailyView.openSettings',
  changeValue: 'ailyView.changeValue',
  revealBackingConfig: 'ailyView.revealBackingConfig',
  // §7.2 Installed Libraries / Platform Packages
  addDependency: 'ailyView.addDependency',
  refreshPackages: 'ailyView.refreshPackages',
  openDependencyPanel: 'ailyView.openDependencyPanel',
  // §7.2 Package Status
  retryResolve: 'ailyView.retryResolve',
  showResolutionLog: 'ailyView.showResolutionLog',
  openLockFile: 'ailyView.openLockFile',
  // §7.2 Build Outputs
  buildDebug: 'ailyView.buildDebug',
  buildRelease: 'ailyView.buildRelease',
  buildSimulator: 'ailyView.buildSimulator',
  clean: 'ailyView.clean',
  // §7.2 Generated
  revealGeneratedSources: 'ailyView.revealGeneratedSources',
  revealBridgeFiles: 'ailyView.revealBridgeFiles',
  openCompileCommands: 'ailyView.openCompileCommands',
  // 内部占位：property / status 节点的默认单击行为
  showNodeInfo: 'ailyView.showNodeInfo'
} as const

// 工程视图节点蓝图
// 严格对照 docs/aily-code工程视图与信息架构设计.md §3.1 §4.3 §4.4 §6.1
const ailyViewBlueprint: readonly ProjectTreeNode[] = [
  {
    id: 'start-here',
    type: 'group',
    label: 'Start Here',
    icon: 'home',
    expandable: true,
    expandedByDefault: true,
    visible: true,
    children: [
      {
        id: 'entry-main',
        type: 'file',
        label: 'main.cpp',
        icon: 'file-code',
        path: 'src/main.cpp',
        expandable: false,
        expandedByDefault: false,
        visible: true
      },
      {
        id: 'project-entry',
        type: 'file',
        label: 'project.aci',
        icon: 'json',
        path: 'project.aci',
        expandable: false,
        expandedByDefault: false,
        visible: true
      }
    ]
  },
  {
    id: 'project-files',
    type: 'group',
    label: 'Project Files',
    icon: 'files',
    expandable: true,
    expandedByDefault: true,
    visible: true,
    children: [
      {
        id: 'application-code',
        type: 'group',
        label: 'Application Code',
        icon: 'symbol-module',
        expandable: true,
        expandedByDefault: true,
        visible: true,
        children: [
          {
            id: 'src-root',
            type: 'directory',
            label: 'src',
            icon: 'folder',
            path: 'src',
            expandable: true,
            expandedByDefault: false,
            visible: true
          }
        ]
      },
      {
        id: 'headers',
        type: 'group',
        label: 'Headers',
        icon: 'symbol-key',
        expandable: true,
        expandedByDefault: false,
        visible: true,
        children: [
          {
            id: 'include-root',
            type: 'directory',
            label: 'include',
            icon: 'folder',
            path: 'include',
            expandable: true,
            expandedByDefault: false,
            visible: true
          }
        ]
      },
      {
        id: 'local-modules',
        type: 'group',
        label: 'Local Modules',
        icon: 'repo',
        expandable: true,
        expandedByDefault: false,
        visible: true,
        children: [
          {
            id: 'components-root',
            type: 'directory',
            label: 'components',
            icon: 'folder-library',
            path: 'components',
            expandable: true,
            expandedByDefault: false,
            visible: true
          }
        ]
      },
      {
        id: 'assets',
        type: 'group',
        label: 'Assets',
        icon: 'device-camera',
        expandable: true,
        expandedByDefault: false,
        visible: true,
        children: [
          {
            id: 'assets-root',
            type: 'directory',
            label: 'assets',
            icon: 'folder',
            path: 'assets',
            expandable: true,
            expandedByDefault: false,
            visible: true
          }
        ]
      }
    ]
  },
  {
    id: 'project-config',
    type: 'group',
    label: 'Project Config',
    icon: 'settings-gear',
    expandable: true,
    expandedByDefault: false,
    visible: true,
    children: [
      {
        id: 'project-config-file',
        type: 'file',
        label: 'project.aci',
        icon: 'json',
        path: 'project.aci',
        expandable: false,
        expandedByDefault: false,
        visible: true
      },
      {
        id: 'lock-json',
        type: 'file',
        label: 'aily.lock.json',
        icon: 'lock',
        path: 'aily.lock.json',
        expandable: false,
        expandedByDefault: false,
        visible: true
      }
    ]
  },
  {
    id: 'board-platform',
    type: 'group',
    label: 'Board & Platform',
    icon: 'chip',
    expandable: true,
    expandedByDefault: false,
    visible: true,
    children: [
      {
        id: 'board',
        type: 'property',
        label: 'Board',
        icon: 'circuit-board',
        expandable: false,
        expandedByDefault: false,
        visible: true
      },
      {
        id: 'mcu',
        type: 'property',
        label: 'MCU',
        icon: 'chip',
        expandable: false,
        expandedByDefault: false,
        visible: true
      },
      {
        id: 'framework',
        type: 'property',
        label: 'Framework',
        icon: 'server-process',
        expandable: true,
        expandedByDefault: false,
        visible: true
      },
      {
        id: 'upload',
        type: 'property',
        label: 'Upload',
        icon: 'arrow-up',
        expandable: false,
        expandedByDefault: false,
        visible: true
      },
      {
        id: 'monitor',
        type: 'property',
        label: 'Monitor',
        icon: 'terminal',
        expandable: false,
        expandedByDefault: false,
        visible: true
      }
    ]
  },
  {
    id: 'dependencies',
    type: 'group',
    label: 'Dependencies',
    icon: 'package',
    expandable: true,
    expandedByDefault: false,
    visible: true,
    children: [
      {
        id: 'installed-libraries',
        type: 'group',
        label: 'Installed Libraries',
        icon: 'package',
        expandable: true,
        expandedByDefault: false,
        visible: true
      },
      {
        id: 'platform-packages',
        type: 'group',
        label: 'Platform Packages',
        icon: 'package',
        expandable: true,
        expandedByDefault: false,
        visible: true
      },
      {
        id: 'package-status',
        type: 'status',
        label: 'Package Status',
        icon: 'pulse',
        expandable: false,
        expandedByDefault: false,
        visible: true
      }
    ]
  },
  {
    id: 'build-outputs',
    type: 'group',
    label: 'Build Outputs',
    icon: 'tools',
    expandable: true,
    expandedByDefault: false,
    visible: true,
    children: [
      {
        id: 'build-debug',
        type: 'artifact-group',
        label: 'debug',
        icon: 'play-circle',
        expandable: true,
        expandedByDefault: false,
        visible: true
      },
      {
        id: 'build-release',
        type: 'artifact-group',
        label: 'release',
        icon: 'rocket',
        expandable: true,
        expandedByDefault: false,
        visible: true
      },
      {
        id: 'build-simulator',
        type: 'artifact-group',
        label: 'simulator',
        icon: 'vm',
        expandable: true,
        expandedByDefault: false,
        visible: true
      }
    ]
  },
  // Generated：§4.3 标记为"条件显示"，§6.3 高级模式才展开
  // 按当前对齐选择：默认可见但折叠，便于直观呈现完整 7 组结构
  {
    id: 'generated',
    type: 'group',
    label: 'Generated',
    icon: 'layers',
    expandable: true,
    expandedByDefault: false,
    visible: true,
    children: [
      {
        id: 'generated-sources',
        type: 'group',
        label: 'Generated Sources',
        icon: 'file-symlink-file',
        path: '.aily/generated',
        expandable: true,
        expandedByDefault: false,
        visible: true
      },
      {
        id: 'bridge-files',
        type: 'group',
        label: 'Bridge Files',
        icon: 'link',
        path: '.aily/bridge',
        expandable: true,
        expandedByDefault: false,
        visible: true
      },
      {
        id: 'compile-commands',
        type: 'virtual-file',
        label: 'Compile Commands',
        icon: 'list-tree',
        path: '.aily/bridge/compile_commands.json',
        expandable: false,
        expandedByDefault: false,
        visible: true
      }
    ]
  }
]

// 提供给 TreeDataProvider 渲染的运行时节点（仅包装 blueprint 节点引用）
type ExplorerTreeElement = {
  readonly kind: 'project'
  readonly node: ProjectTreeNode
}

function wrap(node: ProjectTreeNode): ExplorerTreeElement {
  return { kind: 'project', node }
}

class AilyExplorerProvider implements vscode.TreeDataProvider<ExplorerTreeElement> {
  readonly #vscode: typeof vscode
  /** 读 `.aily/coder-embed-hints.json`（与 Angular getBuildPath 一致）或回退 project.aci */
  readonly #loadMainHexArtifact: () => Promise<MainHexArtifact>
  readonly #onDidChangeTreeData: vscode.EventEmitter<ExplorerTreeElement | undefined | void>
  readonly onDidChangeTreeData: vscode.Event<ExplorerTreeElement | undefined | void>

  constructor(
    vscodeApi: typeof vscode,
    loadMainHexArtifact: () => Promise<MainHexArtifact>
  ) {
    this.#vscode = vscodeApi
    this.#loadMainHexArtifact = loadMainHexArtifact
    this.#onDidChangeTreeData = new vscodeApi.EventEmitter()
    this.onDidChangeTreeData = this.#onDidChangeTreeData.event
  }

  refresh(element?: ExplorerTreeElement): void {
    this.#onDidChangeTreeData.fire(element)
  }

  getTreeItem(element: ExplorerTreeElement): vscode.TreeItem {
    const vs = this.#vscode
    const node = element.node

    // §4.3 expandable + expandedByDefault → VS Code 三态
    const collapsibleState = !node.expandable
      ? vs.TreeItemCollapsibleState.None
      : node.expandedByDefault
        ? vs.TreeItemCollapsibleState.Expanded
        : vs.TreeItemCollapsibleState.Collapsed

    const item = new vs.TreeItem(node.label, collapsibleState)
    item.id = `ailyView:${node.id}`
    item.iconPath = new vs.ThemeIcon(node.icon)
    // contextValue = `aily.<type>:<id>`，便于菜单 when 子句通过 viewItem 精确或前缀匹配（§7）
    item.contextValue = `aily.${node.type}:${node.id}`

    // §9.3 tooltip 至少展示：节点标题 + 路径 / 描述
    const tooltipParts: string[] = [node.label]
    if (node.description != null) {
      tooltipParts.push(node.description)
    }
    const absFs = node.absolutePath?.trim()
    if (absFs) {
      tooltipParts.push(absFs)
    } else if (node.path != null) {
      tooltipParts.push(node.path)
    }
    item.tooltip = tooltipParts.join('\n')

    if (absFs) {
      item.resourceUri = vs.Uri.file(absFs)
    } else if (node.path != null) {
      // 工作区内真实路径用 file URI，避免内置「复制路径」得到 aily-virtual: 协议
      const root = vs.workspace.workspaceFolders?.[0]?.uri
      const useWorkspaceFileUri =
        root != null &&
        (node.type === 'file' || node.type === 'virtual-file' || node.type === 'directory')
      if (useWorkspaceFileUri) {
        const segments = node.path.split('/').filter((s) => s.length > 0)
        item.resourceUri = vs.Uri.joinPath(root, ...segments)
      } else {
        item.resourceUri = vs.Uri.parse(`aily-virtual:/${node.path}`)
      }
    }

    // 单击行为：§9.1
    // file / virtual-file → 打开真实文件
    // property / status → 弹占位提示（待右侧详情面板就绪后替换）
    // group / directory / artifact-group → 不挂 command，沿用 TreeItem 默认展开/折叠
    if (node.type === 'file' || node.type === 'virtual-file') {
      item.command = {
        command: COMMANDS.open,
        title: 'Open',
        arguments: [element]
      }
    } else if (node.type === 'property' || node.type === 'status') {
      item.command = {
        command: COMMANDS.showNodeInfo,
        title: 'Show Node Info',
        arguments: [element]
      }
    }

    return item
  }

  // MVP 阶段不读真实 FS：directory 与所有 group 都从蓝图静态推导
  // 后端服务接入后，仅需把 ailyViewBlueprint 替换为远端拉取结果
  async getChildren(element?: ExplorerTreeElement): Promise<ExplorerTreeElement[]> {
    if (element == null) {
      return ailyViewBlueprint.filter((nd) => nd.visible).map(wrap)
    }
    const children = element.node.children ?? []
    let out = children.filter((nd) => nd.visible).map(wrap)
    const injectHexParent = element.node.id === 'build-outputs' || element.node.id === 'framework'
    if (injectHexParent) {
      const hostCtx = getHostEmbedContext()
      const hint = await this.#loadMainHexArtifact()
      let abs = hostCtx?.mainHexAbsPath?.trim() || hint.abs?.trim() || undefined
      const rel = hostCtx?.mainHexRelPath?.trim() || hint.rel?.trim() || undefined
      const buildDesc = hostCtx?.buildPath ?? hint.buildPath

      // abs 缺失但 rel 存在时基于 workspace 兜底，保证 Reveal in Finder / Copy Path 总能拿到绝对路径
      if (!abs && rel) {
        const root = this.#vscode.workspace.workspaceFolders?.[0]?.uri
        if (root != null) {
          const segments = rel.split('/').filter((s) => s.length > 0)
          abs = this.#vscode.Uri.joinPath(root, ...segments).fsPath
        }
      }

      if (abs || rel) {
        const hexId =
          element.node.id === 'framework' ? 'framework-artifact-main-hex' : 'build-artifact-main-hex'
        const hexNode: ProjectTreeNode = {
          id: hexId,
          type: 'virtual-file',
          label: 'main.hex',
          icon: 'file-binary',
          path: rel,
          absolutePath: abs,
          expandable: false,
          expandedByDefault: false,
          visible: true,
          description: buildDesc ? `构建目录: ${buildDesc}` : undefined
        }
        out = [wrap(hexNode), ...out]
      }
    }
    return out
  }
}

// 菜单 when 子句的可复用片段
// 注意：在 manifest 字符串内 `\.` 需要写为 `\\.`
const WHEN_VIEW = 'view == ailyView'
const WHEN_FILE_LIKE = `${WHEN_VIEW} && viewItem =~ /^aily\\.(file|virtual-file):/`
const WHEN_DIRECTORY = `${WHEN_VIEW} && viewItem =~ /^aily\\.directory:/`
const WHEN_REVEALABLE = `${WHEN_VIEW} && viewItem =~ /^aily\\.(file|directory|virtual-file):/`
const WHEN_MAIN_CPP = `${WHEN_VIEW} && viewItem == aily.file:entry-main`
const WHEN_PROJECT_ACI = `${WHEN_VIEW} && viewItem =~ /^aily\\.file:project-(entry|config-file)$/`
const WHEN_PROPERTY = `${WHEN_VIEW} && viewItem =~ /^aily\\.property:/`
const WHEN_DEPS_GROUP =
  `${WHEN_VIEW} && (viewItem == aily.group:installed-libraries || viewItem == aily.group:platform-packages)`
const WHEN_PACKAGE_STATUS = `${WHEN_VIEW} && viewItem == aily.status:package-status`
// §7.2 Build Outputs 的四个动作仅挂在 Build Outputs 顶层；子节点 debug/release/simulator 不再重复
const WHEN_BUILD = `${WHEN_VIEW} && viewItem == aily.group:build-outputs`
// §7.2 Generated 三个动作仅挂在 Generated 顶层；compile-commands 节点自身依靠通用 Open 即可
const WHEN_GENERATED_GROUP = `${WHEN_VIEW} && viewItem == aily.group:generated`

const { getApi } = registerExtension(
  {
    name: 'aily-project-view',
    publisher: 'aily',
    version: '1.0.0',
    engines: {
      vscode: '*'
    },
    contributes: {
      views: {
        explorer: [
          {
            id: AILY_VIEW_ID,
            name: 'Aily View',
            visibility: 'visible'
          }
        ]
      },
      commands: [
        { command: COMMANDS.open, title: 'Open' },
        { command: COMMANDS.openFolder, title: 'Open Folder' },
        { command: COMMANDS.revealInFilesView, title: 'Reveal in Files View' },
        { command: COMMANDS.copyRelativePath, title: 'Copy Relative Path' },
        { command: COMMANDS.setAsMainEntry, title: 'Set as Main Entry' },
        { command: COMMANDS.rename, title: 'Rename' },
        { command: COMMANDS.newFile, title: 'New File' },
        { command: COMMANDS.newFolder, title: 'New Folder' },
        { command: COMMANDS.openVisualConfig, title: 'Open Visual Config' },
        { command: COMMANDS.openAsJson, title: 'Open as JSON' },
        { command: COMMANDS.validateConfig, title: 'Validate Config' },
        { command: COMMANDS.regenerateLockFile, title: 'Regenerate Lock File' },
        { command: COMMANDS.openSettings, title: 'Open Settings' },
        { command: COMMANDS.changeValue, title: 'Change Value' },
        { command: COMMANDS.revealBackingConfig, title: 'Reveal Backing Config' },
        { command: COMMANDS.addDependency, title: 'Add Dependency' },
        { command: COMMANDS.refreshPackages, title: 'Refresh Packages' },
        { command: COMMANDS.openDependencyPanel, title: 'Open Dependency Panel' },
        { command: COMMANDS.retryResolve, title: 'Retry Resolve' },
        { command: COMMANDS.showResolutionLog, title: 'Show Resolution Log' },
        { command: COMMANDS.openLockFile, title: 'Open Lock File' },
        { command: COMMANDS.buildDebug, title: 'Build Debug' },
        { command: COMMANDS.buildRelease, title: 'Build Release' },
        { command: COMMANDS.buildSimulator, title: 'Build Simulator' },
        { command: COMMANDS.clean, title: 'Clean' },
        { command: COMMANDS.revealGeneratedSources, title: 'Reveal Generated Sources' },
        { command: COMMANDS.revealBridgeFiles, title: 'Reveal Bridge Files' },
        { command: COMMANDS.openCompileCommands, title: 'Open Compile Commands' },
        { command: COMMANDS.showNodeInfo, title: 'Show Node Info' }
      ],
      menus: {
        'view/item/context': [
          // 通用 - file / virtual-file → Open
          { command: COMMANDS.open, when: WHEN_FILE_LIKE, group: 'navigation@10' },
          // 通用 - directory → Open Folder
          { command: COMMANDS.openFolder, when: WHEN_DIRECTORY, group: 'navigation@10' },
          // 通用 - Reveal / Copy
          { command: COMMANDS.revealInFilesView, when: WHEN_REVEALABLE, group: 'navigation@20' },
          { command: COMMANDS.copyRelativePath, when: WHEN_REVEALABLE, group: 'navigation@30' },

          // main.cpp 额外
          { command: COMMANDS.setAsMainEntry, when: WHEN_MAIN_CPP, group: '1_main@10' },
          { command: COMMANDS.rename, when: WHEN_MAIN_CPP, group: '1_main@20' },

          // 真实目录额外
          { command: COMMANDS.newFile, when: WHEN_DIRECTORY, group: '1_directory@10' },
          { command: COMMANDS.newFolder, when: WHEN_DIRECTORY, group: '1_directory@20' },

          // project.aci（Start Here / Project Config 两处）
          { command: COMMANDS.openVisualConfig, when: WHEN_PROJECT_ACI, group: '1_config@10' },
          { command: COMMANDS.openAsJson, when: WHEN_PROJECT_ACI, group: '1_config@20' },
          { command: COMMANDS.validateConfig, when: WHEN_PROJECT_ACI, group: '1_config@30' },
          { command: COMMANDS.regenerateLockFile, when: WHEN_PROJECT_ACI, group: '1_config@40' },

          // Board / MCU / Framework / Upload / Monitor
          { command: COMMANDS.openSettings, when: WHEN_PROPERTY, group: '1_property@10' },
          { command: COMMANDS.changeValue, when: WHEN_PROPERTY, group: '1_property@20' },
          { command: COMMANDS.revealBackingConfig, when: WHEN_PROPERTY, group: '1_property@30' },

          // Installed Libraries / Platform Packages
          { command: COMMANDS.addDependency, when: WHEN_DEPS_GROUP, group: '1_deps@10' },
          { command: COMMANDS.refreshPackages, when: WHEN_DEPS_GROUP, group: '1_deps@20' },
          { command: COMMANDS.openDependencyPanel, when: WHEN_DEPS_GROUP, group: '1_deps@30' },

          // Package Status
          { command: COMMANDS.retryResolve, when: WHEN_PACKAGE_STATUS, group: '1_status@10' },
          { command: COMMANDS.showResolutionLog, when: WHEN_PACKAGE_STATUS, group: '1_status@20' },
          { command: COMMANDS.openLockFile, when: WHEN_PACKAGE_STATUS, group: '1_status@30' },

          // Build Outputs（顶层 + 子节点都生效）
          { command: COMMANDS.buildDebug, when: WHEN_BUILD, group: '1_build@10' },
          { command: COMMANDS.buildRelease, when: WHEN_BUILD, group: '1_build@20' },
          { command: COMMANDS.buildSimulator, when: WHEN_BUILD, group: '1_build@30' },
          { command: COMMANDS.clean, when: WHEN_BUILD, group: '1_build@40' },

          // Generated
          {
            command: COMMANDS.revealGeneratedSources,
            when: WHEN_GENERATED_GROUP,
            group: '1_generated@10'
          },
          {
            command: COMMANDS.revealBridgeFiles,
            when: WHEN_GENERATED_GROUP,
            group: '1_generated@20'
          },
          {
            command: COMMANDS.openCompileCommands,
            when: WHEN_GENERATED_GROUP,
            group: '1_generated@30'
          }
        ]
      }
    }
  },
  ExtensionHostKind.LocalProcess
)

void getApi().then((vscode) => {
  let mainHexArtifactCache: MainHexArtifact | null | undefined
  let mainHexArtifactInflight: Promise<MainHexArtifact> | null = null

  /** 优先读 `.aily/coder-embed-hints.json`（与 Angular getBuildPath 一致），否则 project.aci 推导 */
  const loadMainHexArtifactFromWorkspace = async (): Promise<MainHexArtifact> => {
    if (mainHexArtifactCache != null) {
      return mainHexArtifactCache
    }
    if (mainHexArtifactInflight != null) {
      return mainHexArtifactInflight
    }
    mainHexArtifactInflight = (async (): Promise<MainHexArtifact> => {
      try {
        const root = vscode.workspace.workspaceFolders?.[0]?.uri
        const empty: MainHexArtifact = {}
        if (root == null) {
          mainHexArtifactCache = empty
          return empty
        }
        try {
          const hintsUri = vscode.Uri.joinPath(root, '.aily', 'coder-embed-hints.json')
          const hbuf = await vscode.workspace.fs.readFile(hintsUri)
          const h = JSON.parse(new TextDecoder('utf-8').decode(hbuf)) as {
            mainHexAbs?: string
            mainHexRelPath?: string
            buildPath?: string
          }
          const out: MainHexArtifact = {}
          if (typeof h.mainHexAbs === 'string' && h.mainHexAbs.trim()) {
            out.abs = h.mainHexAbs.trim()
          }
          if (typeof h.mainHexRelPath === 'string' && h.mainHexRelPath.trim()) {
            out.rel = h.mainHexRelPath.trim().replace(/\\/g, '/')
          }
          if (typeof h.buildPath === 'string' && h.buildPath.trim()) {
            out.buildPath = h.buildPath.trim()
          }
          if (out.abs != null || out.rel != null) {
            mainHexArtifactCache = out
            return out
          }
        } catch {
          /* 无 hints */
        }
        const aciUri = vscode.Uri.joinPath(root, 'project.aci')
        const buf = await vscode.workspace.fs.readFile(aciUri)
        const text = new TextDecoder('utf-8').decode(buf)
        const aci = JSON.parse(text) as {
          target?: { framework?: string }
          devmode?: string
        }
        const frameworkRaw = aci?.target?.framework ?? aci?.devmode ?? 'arduino'
        const fw = String(frameworkRaw || 'arduino').trim() || 'arduino'
        const seg = fw.toLowerCase().replace(/[^a-z0-9_-]+/g, '_') || 'arduino'
        const rel = `.aily/build/${seg}/main.hex`
        mainHexArtifactCache = { rel }
        return { rel }
      } catch {
        mainHexArtifactCache = {}
        return {}
      } finally {
        mainHexArtifactInflight = null
      }
    })()
    return mainHexArtifactInflight
  }

  // 把 ProjectTreeNode.path 解析为当前工程根下的真实 URI
  // workspaceFolders[0] 视为工程根；MVP 单工作区
  const resolveProjectUri = (relPath: string | undefined): vscode.Uri | undefined => {
    if (relPath == null || relPath === '') {
      return undefined
    }
    const root = vscode.workspace.workspaceFolders?.[0]?.uri
    if (root == null) {
      return undefined
    }
    const segments = relPath.split('/').filter((s) => s.length > 0)
    return vscode.Uri.joinPath(root, ...segments)
  }

  const resolveUriForTreeNode = (node: ProjectTreeNode | undefined): vscode.Uri | undefined => {
    const abs = node?.absolutePath?.trim()
    if (abs) {
      return vscode.Uri.file(abs)
    }
    return resolveProjectUri(node?.path)
  }

  /** 目标 URI 是否落在当前工作区根下（用于决定能否用 Explorer 定位） */
  const isUriUnderWorkspace = (fileUri: vscode.Uri): boolean => {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri
    if (root == null) {
      return false
    }
    const r = root.fsPath.replace(/\\/g, '/').toLowerCase()
    const u = fileUri.fsPath.replace(/\\/g, '/').toLowerCase()
    return u === r || u.startsWith(r + '/')
  }

  /**
   * 委托 Electron 宿主 shell.showItemInFolder 在 Finder / Explorer 中高亮路径。
   * - LocalProcess 扩展共享主线程 window：直接 `window.parent.postMessage` 给 Angular，最稳；
   * - 兜底用 BroadcastChannel（Worker 场景或 parent 不可用），且延迟 close 避免 postMessage 异步派发被截断。
   */
  const revealInHostOsIfEmbedded = (absPath: string): boolean => {
    const trimmed = absPath?.trim()
    if (!trimmed) {
      return false
    }

    // 优先：主线程扩展直接告诉 Angular 父窗口，零中转、零竞b态
    if (
      typeof window !== 'undefined' &&
      window.parent != null &&
      window.parent !== window
    ) {
      try {
        window.parent.postMessage(
          { channel: AILY_CODER_REVEAL_IN_OS_PM, absPath: trimmed },
          '*'
        )
        return true
      } catch {
        /* 落到 BroadcastChannel 兜底 */
      }
    }

    if (!coderUseEmbedHostNativeFsBridge) {
      return false
    }
    if (typeof BroadcastChannel === 'undefined') {
      return false
    }
    try {
      const ch = new BroadcastChannel(AILY_EMBED_OS_REVEAL_CHANNEL)
      ch.postMessage({ absPath: trimmed })
      // 延迟关闭：BroadcastChannel.postMessage 是异步派发，立即 close 在某些时序下会截断消息
      setTimeout(() => {
        try {
          ch.close()
        } catch {
          /* ignore */
        }
      }, 1000)
      return true
    } catch {
      return false
    }
  }

  // 统一的"打开真实文件"实现，供 file / virtual-file / 各专属菜单复用
  const openByPath = async (relPath: string | undefined, fallbackLabel: string): Promise<void> => {
    const uri = resolveProjectUri(relPath)
    if (uri == null) {
      await vscode.window.showWarningMessage(
        `无法打开 ${fallbackLabel}：当前没有工作区或未配置真实路径。`
      )
      return
    }
    try {
      await vscode.commands.executeCommand('vscode.open', uri)
    } catch (err) {
      await vscode.window.showErrorMessage(`打开 ${fallbackLabel} 失败：${String(err)}`)
    }
  }

  // 在 Files View（原生 Explorer）中定位指定路径
  const revealByPath = async (
    relPath: string | undefined,
    fallbackLabel: string
  ): Promise<void> => {
    const uri = resolveProjectUri(relPath)
    if (uri == null) {
      await vscode.window.showWarningMessage(
        `无法定位 ${fallbackLabel}：当前没有工作区或未配置真实路径。`
      )
      return
    }
    try {
      await vscode.commands.executeCommand('revealInExplorer', uri)
    } catch (err) {
      await vscode.window.showErrorMessage(`在 Files View 中定位 ${fallbackLabel} 失败：${String(err)}`)
    }
  }

  // 占位命令工厂：MVP 阶段没法真实落地的动作统一用 information message 反馈
  // 后续接入 performTreeAction(nodeId, actionId) 时按 actionId 替换即可
  const placeholder =
    (actionLabel: string) =>
    async (element?: ExplorerTreeElement): Promise<void> => {
      const name = element?.node.label ?? '(未指定节点)'
      await vscode.window.showInformationMessage(`[Aily View] ${actionLabel}（占位）：${name}`)
    }

  // 通用菜单（§7.1）
  vscode.commands.registerCommand(COMMANDS.open, async (element?: ExplorerTreeElement) => {
    const uri = resolveUriForTreeNode(element?.node)
    if (uri == null) {
      await vscode.window.showWarningMessage(
        `无法打开 ${element?.node.label ?? 'Unknown'}：当前没有工作区或未配置真实路径。`
      )
      return
    }
    try {
      await vscode.commands.executeCommand('vscode.open', uri)
    } catch (err) {
      await vscode.window.showErrorMessage(
        `打开 ${element?.node.label ?? 'Unknown'} 失败：${String(err)}`
      )
    }
  })
  vscode.commands.registerCommand(COMMANDS.openFolder, async (element?: ExplorerTreeElement) => {
    const uri = resolveUriForTreeNode(element?.node)
    const label = element?.node.label ?? 'Unknown'
    if (uri == null) {
      await vscode.window.showWarningMessage(`无法打开文件夹 ${label}：当前没有工作区或未配置路径。`)
      return
    }
    if (!isUriUnderWorkspace(uri) && revealInHostOsIfEmbedded(uri.fsPath)) {
      return
    }
    try {
      await vscode.commands.executeCommand('revealInExplorer', uri)
    } catch (err) {
      if (revealInHostOsIfEmbedded(uri.fsPath)) {
        return
      }
      await vscode.window.showErrorMessage(`在 Files View 中打开 ${label} 失败：${String(err)}`)
    }
  })
  vscode.commands.registerCommand(
    COMMANDS.revealInFilesView,
    async (element?: ExplorerTreeElement) => {
      const uri = resolveUriForTreeNode(element?.node)
      const label = element?.node.label ?? 'Unknown'
      if (uri == null) {
        await vscode.window.showWarningMessage(`无法定位 ${label}：当前没有工作区或未配置路径。`)
        return
      }
      if (!isUriUnderWorkspace(uri) && revealInHostOsIfEmbedded(uri.fsPath)) {
        return
      }
      try {
        await vscode.commands.executeCommand('revealInExplorer', uri)
      } catch (err) {
        if (revealInHostOsIfEmbedded(uri.fsPath)) {
          return
        }
        await vscode.window.showErrorMessage(`在 Files View 中定位 ${label} 失败：${String(err)}`)
      }
    }
  )
  vscode.commands.registerCommand(
    COMMANDS.copyRelativePath,
    async (element?: ExplorerTreeElement) => {
      const uri = resolveUriForTreeNode(element?.node)
      if (uri == null) {
        await vscode.window.showWarningMessage(
          `${element?.node.label ?? '该节点'} 没有可复制的相对路径。`
        )
        return
      }
      let text = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/')
      await vscode.env.clipboard.writeText(text)
      await vscode.window.showInformationMessage(`已复制相对路径：${text}`)
    }
  )

  // main.cpp（§7.2）
  vscode.commands.registerCommand(COMMANDS.setAsMainEntry, placeholder('Set as Main Entry'))
  vscode.commands.registerCommand(COMMANDS.rename, placeholder('Rename'))

  // 真实目录（§7.2）
  vscode.commands.registerCommand(COMMANDS.newFile, placeholder('New File'))
  vscode.commands.registerCommand(COMMANDS.newFolder, placeholder('New Folder'))

  // project.aci（§7.2）
  // Open as JSON 可立即落地，复用 path；其余先占位
  vscode.commands.registerCommand(COMMANDS.openVisualConfig, placeholder('Open Visual Config'))
  vscode.commands.registerCommand(COMMANDS.openAsJson, async (element?: ExplorerTreeElement) => {
    await openByPath(element?.node.path, element?.node.label ?? 'project.aci')
  })
  vscode.commands.registerCommand(COMMANDS.validateConfig, placeholder('Validate Config'))
  vscode.commands.registerCommand(COMMANDS.regenerateLockFile, placeholder('Regenerate Lock File'))

  // property 节点（§7.2）
  vscode.commands.registerCommand(COMMANDS.openSettings, placeholder('Open Settings'))
  vscode.commands.registerCommand(COMMANDS.changeValue, placeholder('Change Value'))
  vscode.commands.registerCommand(
    COMMANDS.revealBackingConfig,
    placeholder('Reveal Backing Config')
  )

  // Dependencies 分组（§7.2）
  vscode.commands.registerCommand(COMMANDS.addDependency, placeholder('Add Dependency'))
  vscode.commands.registerCommand(COMMANDS.refreshPackages, placeholder('Refresh Packages'))
  vscode.commands.registerCommand(
    COMMANDS.openDependencyPanel,
    placeholder('Open Dependency Panel')
  )

  // Package Status（§7.2）
  // Open Lock File 直接打开根目录下的 aily.lock.json
  vscode.commands.registerCommand(COMMANDS.retryResolve, placeholder('Retry Resolve'))
  vscode.commands.registerCommand(COMMANDS.showResolutionLog, placeholder('Show Resolution Log'))
  vscode.commands.registerCommand(COMMANDS.openLockFile, async () => {
    await openByPath('aily.lock.json', 'aily.lock.json')
  })

  // Build Outputs（§7.2）
  vscode.commands.registerCommand(COMMANDS.buildDebug, placeholder('Build Debug'))
  vscode.commands.registerCommand(COMMANDS.buildRelease, placeholder('Build Release'))
  vscode.commands.registerCommand(COMMANDS.buildSimulator, placeholder('Build Simulator'))
  vscode.commands.registerCommand(COMMANDS.clean, placeholder('Clean'))

  // Generated（§7.2）
  vscode.commands.registerCommand(COMMANDS.revealGeneratedSources, async () => {
    await revealByPath('.aily/generated', '.aily/generated')
  })
  vscode.commands.registerCommand(COMMANDS.revealBridgeFiles, async () => {
    await revealByPath('.aily/bridge', '.aily/bridge')
  })
  vscode.commands.registerCommand(COMMANDS.openCompileCommands, async () => {
    await openByPath('.aily/bridge/compile_commands.json', 'compile_commands.json')
  })

  // 内部占位：property / status 节点单击时的提示
  vscode.commands.registerCommand(
    COMMANDS.showNodeInfo,
    async (element?: ExplorerTreeElement) => {
      const n = element?.node
      if (n == null) {
        await vscode.window.showInformationMessage('Aily 节点：未选中')
        return
      }
      await vscode.window.showInformationMessage(`Aily 节点：${n.label} (${n.type}/${n.id})`)
    }
  )

  const provider = new AilyExplorerProvider(vscode, loadMainHexArtifactFromWorkspace)
  vscode.window.createTreeView(AILY_VIEW_ID, {
    treeDataProvider: provider,
    showCollapseAll: true
  })

  vscode.workspace.onDidChangeWorkspaceFolders(() => {
    mainHexArtifactCache = undefined
    provider.refresh()
  })

  onHostEmbedContextChanged(() => {
    // 宿主推送新上下文时，让 hint 兜底也走一次盘上读取，避免编译完成后仍用旧路径
    mainHexArtifactCache = undefined
    provider.refresh()
  })
})
