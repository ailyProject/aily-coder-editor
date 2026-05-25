import type * as vscode from 'vscode'
import { ExtensionHostKind, registerExtension } from '@codingame/monaco-vscode-api/extensions'
import { coderUseEmbedHostNativeFsBridge } from '../coderEmbedEnv.js'
import {
  getHostEmbedContext,
  mergeBoardProfileIntoSnapshot,
  onHostEmbedContextChanged,
  requestHostCloseLibraryManager,
  requestHostClipboardWriteText,
  requestHostOpenBoardSelector,
  requestHostOpenLibraryManager,
  type HostBoardProfileV1,
  type HostEmbedContextV1,
  type HostPlatformPackageV1
} from '../hostEmbedContext.js'
import {
  buildBoardListSpecFromHost,
  openAilyBoardListEditor
} from './ailyBoardListEditor.workbench.js'
import {
  startVirtualTreeInlineRename,
  validateRenameEntryName
} from './ailyViewInlineRename.js'
import {
  shouldRefreshFrameworkBuildOutputsNativeWatch,
  shouldRefreshStartHereNativeWatch,
  startWorkspaceNativeWatch,
  statAbsolutePathViaHost
} from '../parentBackedNativeFs.js'

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

/** 单条编译产物（虚拟树节点） */
type BuildArtifactEntry = {
  readonly label: string
  readonly abs?: string
  readonly rel?: string
}

/** Angular 写入的 hints 与宿主 postMessage 共用形状 */
type BuildOutputsHint = {
  buildPath?: string
  artifacts: BuildArtifactEntry[]
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

/** 合并宿主 postMessage 与 hints 中的产物列表（按绝对路径去重，保持写入顺序） */
function mergeBuildArtifactsFromHostAndHint(
  hostCtx: HostEmbedContextV1 | null,
  hint: BuildOutputsHint
): BuildArtifactEntry[] {
  const out: BuildArtifactEntry[] = []
  const seen = new Set<string>()

  const push = (label: string, abs?: string, rel?: string): void => {
    const absTrim = abs?.trim()
    const relTrim = rel?.trim()
    const key = absTrim ?? relTrim
    if (!key || !label.trim() || seen.has(key)) {
      return
    }
    seen.add(key)
    out.push({
      label: label.trim(),
      ...(absTrim ? { abs: absTrim } : {}),
      ...(relTrim ? { rel: relTrim.replace(/\\/g, '/') } : {})
    })
  }

  const fromHost = hostCtx?.buildArtifacts
  if (fromHost != null) {
    for (const a of fromHost) {
      push(a.label, a.absPath, a.relPath)
    }
  }
  if (hostCtx?.mainHexAbsPath?.trim()) {
    push('main.hex', hostCtx.mainHexAbsPath, hostCtx.mainHexRelPath)
  }

  for (const a of hint.artifacts) {
    push(a.label, a.abs, a.rel)
  }

  return out
}

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
  // MCU：单击请求宿主打开切换开发板弹窗
  openBoardSelector: 'ailyView.openBoardSelector',
  /** 虚拟 Board：在内嵌编辑区打开「列表」型自定义面板 */
  openBoardProperty: 'ailyView.openBoardProperty',
  // 内部占位：其余 property / status 节点的默认单击行为
  showNodeInfo: 'ailyView.showNodeInfo'
} as const

/** MCU 虚拟属性节点：单击打开切换开发板弹窗（Board 仅展示，不触发切换） */
const BOARD_SELECTOR_PROPERTY_IDS = new Set(['mcu'])

function isBoardSelectorPropertyNode(node: ProjectTreeNode | undefined): boolean {
  return node?.type === 'property' && BOARD_SELECTOR_PROPERTY_IDS.has(node.id)
}

/** 虚拟 Board：单击打开列表型自定义编辑器（非切换弹窗） */
function isBoardListNode(node: ProjectTreeNode | undefined): boolean {
  return node?.type === 'property' && node.id === 'board'
}

/** 将宿主 boardProfile 合并进树节点 description（仅 Board） */
function withHostBoardDescription(node: ProjectTreeNode): ProjectTreeNode {
  if (!isBoardListNode(node)) {
    return node
  }
  const bp = getHostEmbedContext()?.boardProfile
  const desc = bp?.boardNickname?.trim() || bp?.boardName?.trim()
  if (desc == null || desc.length === 0) {
    return node
  }
  return { ...node, description: desc }
}

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
      // src/*.cpp 由 getChildren('start-here') 按磁盘动态注入，见 listSrcCppRelPaths
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
    id: 'project-config',
    type: 'group',
    label: 'Project Config',
    icon: 'settings-gear',
    expandable: true,
    expandedByDefault: false,
    visible: true,
    children: [
      // project.aci 仅在 Start Here > project-entry，避免与配置索引重复
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
  // 按当前对齐选择：默认可见但折叠，便于直观呈现完整 6 组结构（不含 Project Files） // 临时注释
  /* {
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
  } */
]

/** 工程根下 node_modules 相对路径 */
const NODE_MODULES_REL = 'node_modules'

/** Start Here 下镜像的源码目录（仅展示该目录内全部 .cpp） */
const SRC_REL = 'src'

/** Start Here 动态 .cpp 节点 id 前缀：`entry-src-<path-with-slashes-as-dashes>` */
const ENTRY_SRC_NODE_PREFIX = 'entry-src-'

/** Installed Libraries 无依赖时的占位节点 id（§9.4） */
const INSTALLED_LIBRARIES_EMPTY_ID = 'installed-libraries-empty'

/** Platform Packages 未解析到主板平台依赖时的占位节点 id（§9.4） */
const PLATFORM_PACKAGES_EMPTY_ID = 'platform-packages-empty'

/** Platform Packages 动态子节点 id 前缀 */
const PLATFORM_PKG_NODE_PREFIX = 'platform-pkg-'

/** node_modules 顶层扫描时跳过的目录 */
const NODE_MODULES_SKIP = new Set(['.bin', '.cache'])

/** §9.4 Installed Libraries 空状态文案 */
const INSTALLED_LIBRARIES_EMPTY: ProjectTreeNode = {
  id: INSTALLED_LIBRARIES_EMPTY_ID,
  type: 'status',
  label: 'No external libraries installed yet.',
  icon: 'info',
  description: NODE_MODULES_REL,
  expandable: false,
  expandedByDefault: false,
  visible: true
}

/** §9.4 Platform Packages 空状态文案 */
const PLATFORM_PACKAGES_EMPTY: ProjectTreeNode = {
  id: PLATFORM_PACKAGES_EMPTY_ID,
  type: 'status',
  label: 'No platform packages resolved yet.',
  icon: 'info',
  description: 'sdk / compiler / tools',
  expandable: false,
  expandedByDefault: false,
  visible: true
}

/** 平台包节点 codicon：与 Board & Platform 语义区分 */
function iconForPlatformPackageKind(kind: HostPlatformPackageV1['kind']): string {
  if (kind === 'sdk') {
    return 'server-process'
  }
  if (kind === 'compiler') {
    return 'tools'
  }
  return 'wrench'
}

/** 树标题：tool-ctags@5.8.0（与 Angular platform-packages.utils 一致） */
function formatPlatformPackageTreeLabel(entry: HostPlatformPackageV1): string {
  const shortName = entry.packageName.replace(/^@aily-project\//, '')
  const ver = entry.version?.trim()
  if (ver) {
    return `${shortName}@${ver}`
  }
  return entry.label?.trim() || shortName
}

function isPlatformPackageProjectNode(node: ProjectTreeNode | undefined): boolean {
  return node?.id.startsWith(PLATFORM_PKG_NODE_PREFIX) === true
}

function isRenameTargetDirectory(element: ExplorerTreeElement | undefined): boolean {
  if (element?.kind === 'fs') {
    return element.isDirectory
  }
  if (element?.kind === 'project') {
    return element.node.type === 'directory'
  }
  return false
}

/** 平台包条目：左键仅选中，右键 Open Folder 才在系统中打开真实目录 */
function platformPackageToTreeNode(entry: HostPlatformPackageV1): ProjectTreeNode {
  const displayLabel = formatPlatformPackageTreeLabel(entry)
  const diskHint = entry.diskDirName?.trim()
  return {
    id: `${PLATFORM_PKG_NODE_PREFIX}${entry.id}`,
    type: 'directory',
    label: displayLabel,
    icon: iconForPlatformPackageKind(entry.kind),
    description: diskHint && diskHint.length > 0 ? diskHint : undefined,
    absolutePath: entry.absolutePath,
    expandable: false,
    expandedByDefault: false,
    visible: true
  }
}

/** 来自磁盘 node_modules 的动态子节点（挂在 Installed Libraries 或包目录下） */
type FsTreeElement = {
  readonly kind: 'fs'
  /** 相对工程根的路径，如 node_modules/@aily-project/lib-dht */
  readonly relPath: string
  readonly label: string
  readonly isDirectory: boolean
  /** 是否为 Installed Libraries 下的顶层包（用于 package 图标） */
  readonly isTopLevelPackage: boolean
}

// 提供给 TreeDataProvider：蓝图静态节点 + node_modules 动态节点
type ExplorerTreeElement =
  | { readonly kind: 'project'; readonly node: ProjectTreeNode }
  | FsTreeElement

/** 蓝图静态文件节点重命名后的运行时覆盖（label + path） */
const blueprintPathOverrides = new Map<string, { label: string; path: string }>()

/** Start Here 下由 src/ 扫描得到的 .cpp 节点（id → 节点） */
const dynamicSrcCppEntryNodes = new Map<string, ProjectTreeNode>()

function entryNodeIdForRelPath(relPath: string): string {
  return `${ENTRY_SRC_NODE_PREFIX}${fsContextSuffix(relPath)}`
}

function isSrcCppEntryNodeId(id: string): boolean {
  return id.startsWith(ENTRY_SRC_NODE_PREFIX)
}

/** 读取 project.aci 中的默认编译入口（相对工程根） */
async function readProjectAciEntry(vscodeApi: typeof vscode): Promise<string | undefined> {
  const root = vscodeApi.workspace.workspaceFolders?.[0]?.uri
  if (root == null) {
    return undefined
  }
  try {
    const uri = vscodeApi.Uri.joinPath(root, 'project.aci')
    const raw = await vscodeApi.workspace.fs.readFile(uri)
    const doc = JSON.parse(new TextDecoder('utf-8').decode(raw)) as { entry?: string }
    const entry = doc.entry?.trim()
    return entry != null && entry.length > 0 ? entry.replace(/\\/g, '/') : undefined
  } catch {
    return undefined
  }
}

/** 递归列出 src/ 下全部 .cpp（相对工程根，如 src/main.cpp） */
async function listSrcCppRelPaths(vscodeApi: typeof vscode): Promise<string[]> {
  const root = vscodeApi.workspace.workspaceFolders?.[0]?.uri
  if (root == null) {
    return []
  }

  const out: string[] = []

  const walk = async (relDir: string): Promise<void> => {
    const segments = relDir.split('/').filter((s) => s.length > 0)
    const dirUri = vscodeApi.Uri.joinPath(root, ...segments)
    let entries: [string, vscode.FileType][]
    try {
      entries = await vscodeApi.workspace.fs.readDirectory(dirUri)
    } catch {
      return
    }
    for (const [name, fileType] of entries) {
      if (name.startsWith('.')) {
        continue
      }
      const childRel = relDir.length > 0 ? `${relDir}/${name}` : name
      if (isFsDirectory(vscodeApi, fileType)) {
        await walk(childRel)
      } else if (name.toLowerCase().endsWith('.cpp')) {
        out.push(childRel.replace(/\\/g, '/'))
      }
    }
  }

  await walk(SRC_REL)
  return out
}

function sortCppEntryRelPaths(paths: readonly string[], mainEntry?: string): string[] {
  const main = mainEntry?.replace(/\\/g, '/')
  return [...paths].sort((a, b) => {
    if (main != null && main.length > 0) {
      if (a === main) {
        return -1
      }
      if (b === main) {
        return 1
      }
    }
    return a.localeCompare(b)
  })
}

function buildSrcCppEntryNode(relPath: string, mainEntry?: string): ProjectTreeNode {
  const norm = relPath.replace(/\\/g, '/')
  const label = norm.split('/').pop() ?? norm
  const isMain = mainEntry != null && norm === mainEntry.replace(/\\/g, '/')
  return {
    id: entryNodeIdForRelPath(norm),
    type: 'file',
    label,
    icon: 'file-code',
    path: norm,
    expandable: false,
    expandedByDefault: false,
    visible: true,
    ...(isMain
      ? {
          badges: [
            {
              id: 'main-entry',
              text: 'Entry',
              tone: 'info' as BadgeTone,
              priority: 10
            }
          ]
        }
      : {})
  }
}

async function buildStartHereCppEntryNodes(vscodeApi: typeof vscode): Promise<ProjectTreeNode[]> {
  const mainEntry = await readProjectAciEntry(vscodeApi)
  const rawPaths = await listSrcCppRelPaths(vscodeApi)
  const paths = sortCppEntryRelPaths(rawPaths, mainEntry)
  dynamicSrcCppEntryNodes.clear()
  const nodes: ProjectTreeNode[] = []
  for (const rel of paths) {
    const node = buildSrcCppEntryNode(rel, mainEntry)
    dynamicSrcCppEntryNodes.set(node.id, node)
    nodes.push(node)
  }
  return nodes
}

function resolveBlueprintNode(node: ProjectTreeNode): ProjectTreeNode {
  const o = blueprintPathOverrides.get(node.id)
  if (o == null) {
    return node
  }
  return { ...node, label: o.label, path: o.path }
}

function wrap(node: ProjectTreeNode): ExplorerTreeElement {
  return { kind: 'project', node: resolveBlueprintNode(node) }
}

/**
 * 与 getChildren 根层返回同一 ExplorerTreeElement 引用；
 * TreeDataProvider.refresh(element) 依赖引用相等，否则子树不会重新拉取。
 */
const stableBlueprintElements = new Map<string, ExplorerTreeElement>()

function getStableBlueprintElement(nodeId: string): ExplorerTreeElement | undefined {
  let el = stableBlueprintElements.get(nodeId)
  if (el != null) {
    return el
  }
  const node = findBlueprintNode(nodeId)
  if (node == null) {
    return undefined
  }
  el = wrap(node)
  stableBlueprintElements.set(nodeId, el)
  return el
}

/** Installed Libraries 顶层分组节点（展开/折叠时同步宿主库管理侧栏） */
function isInstalledLibrariesGroup(
  element: ExplorerTreeElement | undefined
): boolean {
  return element?.kind === 'project' && element.node.id === 'installed-libraries'
}

/** 在蓝图树中按 id 查找节点（用于定向 refresh，避免全树 refresh 与自定义编辑器打开竞态） */
function findBlueprintNode(id: string): ProjectTreeNode | undefined {
  const dynamic = dynamicSrcCppEntryNodes.get(id)
  if (dynamic != null) {
    return resolveBlueprintNode(dynamic)
  }
  const walk = (nodes: readonly ProjectTreeNode[]): ProjectTreeNode | undefined => {
    for (const n of nodes) {
      if (n.id === id) {
        return n
      }
      if (n.children != null) {
        const hit = walk(n.children)
        if (hit != null) {
          return hit
        }
      }
    }
    return undefined
  }
  return walk(ailyViewBlueprint)
}

/** 按相对工程根路径查找蓝图节点 id（含运行时 override） */
function findBlueprintNodeIdByRelPath(relPath: string): string | undefined {
  const norm = relPath.replace(/\\/g, '/')
  for (const [id, o] of blueprintPathOverrides) {
    if (o.path.replace(/\\/g, '/') === norm) {
      return id
    }
  }
  const walk = (nodes: readonly ProjectTreeNode[]): string | undefined => {
    for (const n of nodes) {
      if (n.path?.replace(/\\/g, '/') === norm) {
        return n.id
      }
      if (n.children != null) {
        const hit = walk(n.children)
        if (hit != null) {
          return hit
        }
      }
    }
    return undefined
  }
  const hit = walk(ailyViewBlueprint)
  if (hit != null) {
    return hit
  }
  for (const [, node] of dynamicSrcCppEntryNodes) {
    const resolved = resolveBlueprintNode(node)
    if (resolved.path?.replace(/\\/g, '/') === norm) {
      return resolved.id
    }
  }
  return undefined
}

/** 宿主上下文 / 动态子树变更时刷新的蓝图节点（勿 refresh(undefined)） */
const DYNAMIC_REFRESH_BLUEPRINT_IDS = [
  'start-here',
  'board-platform',
  'build-outputs',
  'framework',
  'platform-packages',
  'installed-libraries'
] as const

function refreshDynamicBlueprintSections(provider: AilyExplorerProvider): void {
  for (const id of DYNAMIC_REFRESH_BLUEPRINT_IDS) {
    const el = getStableBlueprintElement(id)
    if (el != null) {
      provider.refresh(el)
    }
  }
}

/** 蓝图静态节点：与 getChildren 返回同一 ExplorerTreeElement 引用，refresh 才能命中子树 */
function wrapBlueprintChild(node: ProjectTreeNode): ExplorerTreeElement {
  return getStableBlueprintElement(node.id) ?? wrap(node)
}

/** 将相对路径转为可用于 contextValue 的安全片段 */
function fsContextSuffix(relPath: string): string {
  return relPath.replace(/\//g, '-')
}

/** 按扩展名选择文件 codicon */
function iconForFsEntry(name: string, isDirectory: boolean, isTopLevelPackage: boolean): string {
  if (isDirectory) {
    return isTopLevelPackage ? 'package' : 'folder'
  }
  const lower = name.toLowerCase()
  if (lower.endsWith('.json')) {
    return 'json'
  }
  if (lower.endsWith('.md')) {
    return 'markdown'
  }
  if (lower.endsWith('.h') || lower.endsWith('.hpp')) {
    return 'file-code'
  }
  if (lower.endsWith('.cpp') || lower.endsWith('.c') || lower.endsWith('.ino')) {
    return 'file-code'
  }
  return 'file'
}

/** 兼容 monaco-vscode-api：readDirectory 返回的 FileType 可能与 vscode.FileType 非同一引用 */
function isFsDirectory(
  vscodeApi: typeof vscode,
  fileType: vscode.FileType
): boolean {
  const dir = vscodeApi.FileType.Directory
  return fileType === dir || Number(fileType) === Number(dir)
}

/** 列出目录真实子项；在 node_modules 下展示全部条目（含点文件），仅顶层跳过 .bin/.cache */
async function listFsDirectoryChildren(
  vscodeApi: typeof vscode,
  relPath: string
): Promise<FsTreeElement[]> {
  const root = vscodeApi.workspace.workspaceFolders?.[0]?.uri
  if (root == null) {
    return []
  }
  const segments = relPath.split('/').filter((s) => s.length > 0)
  const dirUri = vscodeApi.Uri.joinPath(root, ...segments)
  const underNodeModules =
    relPath === NODE_MODULES_REL || relPath.startsWith(`${NODE_MODULES_REL}/`)
  let entries: [string, vscode.FileType][]
  try {
    entries = await vscodeApi.workspace.fs.readDirectory(dirUri)
  } catch {
    entries = []
  }

  const out: FsTreeElement[] = []
  for (const [name, fileType] of entries) {
    if (!underNodeModules && name.startsWith('.')) {
      continue
    }
    if (underNodeModules && relPath === NODE_MODULES_REL && NODE_MODULES_SKIP.has(name)) {
      continue
    }
    const childRel = `${relPath}/${name}`
    const isDirectory = isFsDirectory(vscodeApi, fileType)
    out.push({
      kind: 'fs',
      relPath: childRel,
      label: name,
      isDirectory,
      isTopLevelPackage: relPath === NODE_MODULES_REL && isDirectory
    })
  }

  out.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) {
      return a.isDirectory ? -1 : 1
    }
    return a.label.localeCompare(b.label)
  })

  return out
}

class AilyExplorerProvider implements vscode.TreeDataProvider<ExplorerTreeElement> {
  readonly #vscode: typeof vscode
  /** 读 `.aily/coder-embed-hints.json` 与宿主 postMessage（仅真实产物，不回退 project.aci） */
  readonly #loadBuildOutputs: () => Promise<BuildOutputsHint>
  /** 主板 boardDependencies → appdata 下 sdk/tools 等平台包目录 */
  readonly #loadPlatformPackages: () => Promise<readonly HostPlatformPackageV1[]>
  readonly #onDidChangeTreeData: vscode.EventEmitter<ExplorerTreeElement | undefined | void>
  readonly onDidChangeTreeData: vscode.Event<ExplorerTreeElement | undefined | void>

  constructor(
    vscodeApi: typeof vscode,
    loadBuildOutputs: () => Promise<BuildOutputsHint>,
    loadPlatformPackages: () => Promise<readonly HostPlatformPackageV1[]>
  ) {
    this.#vscode = vscodeApi
    this.#loadBuildOutputs = loadBuildOutputs
    this.#loadPlatformPackages = loadPlatformPackages
    this.#onDidChangeTreeData = new vscodeApi.EventEmitter()
    this.onDidChangeTreeData = this.#onDidChangeTreeData.event
  }

  refresh(element?: ExplorerTreeElement): void {
    this.#onDidChangeTreeData.fire(element)
  }

  /** 为 Framework 节点注入编译产物虚拟文件（Build Outputs 暂仅保留 debug/release/simulator 分组） */
  async #injectFrameworkBuildArtifactChildren(): Promise<ExplorerTreeElement[]> {
    const hostCtx = getHostEmbedContext()
    const hint = await this.#loadBuildOutputs()
    const buildDesc = hostCtx?.buildPath ?? hint.buildPath
    const artifactNodes: ExplorerTreeElement[] = []
    const merged = mergeBuildArtifactsFromHostAndHint(hostCtx, hint)

    for (const art of merged) {
      let abs = art.abs?.trim() || undefined
      const rel = art.rel?.trim() || undefined

      if (!abs && rel) {
        const root = this.#vscode.workspace.workspaceFolders?.[0]?.uri
        if (root != null) {
          const segments = rel.split('/').filter((s) => s.length > 0)
          abs = this.#vscode.Uri.joinPath(root, ...segments).fsPath
        }
      }

      if (!(await this.#artifactExistsOnDisk(abs, rel))) {
        continue
      }

      const safeId = art.label.replace(/[^a-zA-Z0-9._-]+/g, '-')
      const artifactNode: ProjectTreeNode = {
        id: `framework-artifact-${safeId}`,
        type: 'virtual-file',
        label: art.label,
        icon: 'file-binary',
        path: rel,
        absolutePath: abs,
        expandable: false,
        expandedByDefault: false,
        visible: true,
        description: buildDesc ? `构建目录: ${buildDesc}` : undefined
      }
      artifactNodes.push(wrap(artifactNode))
    }

    return artifactNodes
  }

  /** 绝对路径是否落在当前 VS Code 工作区根下 */
  #isAbsPathUnderWorkspace(absPath: string): boolean {
    const root = this.#vscode.workspace.workspaceFolders?.[0]?.uri
    if (root == null) {
      return false
    }
    const r = root.fsPath.replace(/\\/g, '/').toLowerCase()
    const u = absPath.replace(/\\/g, '/').toLowerCase()
    return u === r || u.startsWith(`${r}/`)
  }

  /**
   * 仅当产物在磁盘上真实存在时才展示虚拟节点。
   * 工作区外路径（如 aily-builder 缓存）经宿主 nativeFsStat 校验，避免删除后仍展示 stale 节点。
   */
  async #artifactExistsOnDisk(abs?: string, rel?: string): Promise<boolean> {
    const vs = this.#vscode
    const absTrim = abs?.trim()
    if (absTrim) {
      if (!this.#isAbsPathUnderWorkspace(absTrim)) {
        const hostStat = await statAbsolutePathViaHost(absTrim)
        return hostStat.exists && hostStat.isFile
      }
      try {
        const stat = await vs.workspace.fs.stat(vs.Uri.file(absTrim))
        return stat.type === vs.FileType.File
      } catch {
        return false
      }
    }
    const relTrim = rel?.trim()
    if (!relTrim) {
      return false
    }
    const root = vs.workspace.workspaceFolders?.[0]?.uri
    if (root == null) {
      return false
    }
    const segments = relTrim.split('/').filter((s) => s.length > 0)
    try {
      const uri = vs.Uri.joinPath(root, ...segments)
      const stat = await vs.workspace.fs.stat(uri)
      return stat.type === vs.FileType.File
    } catch {
      return false
    }
  }

  /** node_modules 动态节点：映射真实磁盘路径，支持打开与 Files View 定位 */
  #getFsTreeItem(element: FsTreeElement): vscode.TreeItem {
    const vs = this.#vscode
    const collapsibleState = element.isDirectory
      ? vs.TreeItemCollapsibleState.Collapsed
      : vs.TreeItemCollapsibleState.None

    const item = new vs.TreeItem(element.label, collapsibleState)
    item.id = `ailyView:fs:${element.relPath}`
    item.iconPath = new vs.ThemeIcon(
      iconForFsEntry(element.label, element.isDirectory, element.isTopLevelPackage)
    )
    const nodeType = element.isDirectory ? 'directory' : 'file'
    item.contextValue = `aily.${nodeType}:fs-${fsContextSuffix(element.relPath)}`
    item.tooltip = [element.label, element.relPath].join('\n')

    const root = vs.workspace.workspaceFolders?.[0]?.uri
    if (root != null) {
      const segments = element.relPath.split('/').filter((s) => s.length > 0)
      item.resourceUri = vs.Uri.joinPath(root, ...segments)
    }

    if (!element.isDirectory) {
      item.command = {
        command: COMMANDS.open,
        title: 'Open',
        arguments: [element]
      }
    }
    return item
  }

  getTreeItem(element: ExplorerTreeElement): vscode.TreeItem {
    if (element.kind === 'fs') {
      return this.#getFsTreeItem(element)
    }

    const vs = this.#vscode
    const node = withHostBoardDescription(element.node)

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

    // §9.3 tooltip：平台包为「标题 + 磁盘目录名 + 绝对路径」各一行，不重复绝对路径
    const absFs = node.absolutePath?.trim()
    if (isPlatformPackageProjectNode(node)) {
      const tooltipParts: string[] = [node.label]
      if (node.description != null && node.description.trim()) {
        tooltipParts.push(node.description.trim())
      }
      if (absFs) {
        tooltipParts.push(absFs)
      }
      item.tooltip = tooltipParts.join('\n')
    } else {
      const tooltipParts: string[] = [node.label]
      if (node.description != null) {
        tooltipParts.push(node.description)
      }
      if (absFs) {
        tooltipParts.push(absFs)
      } else if (node.path != null) {
        tooltipParts.push(node.path)
      }
      item.tooltip = tooltipParts.join('\n')
    }

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
    // file / virtual-file → 打开真实文件（Platform Packages 除外，仅右键打开目录）
    // MCU → 请求宿主打开切换开发板弹窗；Board → 打开列表型自定义编辑器
    // group / directory / Platform Packages → 不挂 command，左键仅选中
    if (
      (node.type === 'file' || node.type === 'virtual-file') &&
      !isPlatformPackageProjectNode(node)
    ) {
      item.command = {
        command: COMMANDS.open,
        title: 'Open',
        arguments: [element]
      }
    } else if (isBoardSelectorPropertyNode(node)) {
      item.command = {
        command: COMMANDS.openBoardSelector,
        title: 'Change Board',
        arguments: [element]
      }
    } else if (isBoardListNode(node)) {
      item.command = {
        command: COMMANDS.openBoardProperty,
        title: 'Open Board Types',
        arguments: [element]
      }
    } else if (
      (node.type === 'property' || node.type === 'status') &&
      node.id !== INSTALLED_LIBRARIES_EMPTY_ID &&
      node.id !== PLATFORM_PACKAGES_EMPTY_ID
    ) {
      item.command = {
        command: COMMANDS.showNodeInfo,
        title: 'Show Node Info',
        arguments: [element]
      }
    }

    return item
  }

  async getChildren(element?: ExplorerTreeElement): Promise<ExplorerTreeElement[]> {
    if (element == null) {
      return ailyViewBlueprint.filter((nd) => nd.visible).map((nd) => wrapBlueprintChild(nd))
    }

    // node_modules 内目录：递归列出真实子文件/子目录
    if (element.kind === 'fs') {
      if (!element.isDirectory) {
        return []
      }
      return listFsDirectoryChildren(this.#vscode, element.relPath)
    }

    const node = element.node

    // Installed Libraries：直接镜像工程根 node_modules 目录（不做包名过滤）
    if (node.id === 'installed-libraries') {
      const items = await listFsDirectoryChildren(this.#vscode, NODE_MODULES_REL)
      if (items.length === 0) {
        return [wrap(INSTALLED_LIBRARIES_EMPTY)]
      }
      return items
    }

    // Platform Packages：主板 boardDependencies 中的 sdk / compiler / tool（appdata/aily-project 下真实目录）
    if (node.id === 'platform-packages') {
      const packages = await this.#loadPlatformPackages()
      if (packages.length === 0) {
        return [wrap(PLATFORM_PACKAGES_EMPTY)]
      }
      return packages.map((entry) => wrap(platformPackageToTreeNode(entry)))
    }

    if (node.id === 'start-here') {
      const cppNodes = await buildStartHereCppEntryNodes(this.#vscode)
      const staticChildren = (node.children ?? []).filter((nd) => nd.visible).map(wrap)
      return [...cppNodes.map(wrap), ...staticChildren]
    }

    const children = node.children ?? []
    let out = children.filter((nd) => nd.visible).map((nd) => wrapBlueprintChild(nd))
    if (element.node.id === 'framework') {
      const artifactNodes = await this.#injectFrameworkBuildArtifactChildren()
      if (artifactNodes.length > 0) {
        out = [...artifactNodes, ...out]
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
/** 可重命名：src 下 .cpp 入口、工作区目录（不含 Platform Packages）、node_modules 动态文件 */
const WHEN_RENAMEABLE = `${WHEN_VIEW} && (viewItem =~ /^aily\\.file:entry-src-/ || (viewItem =~ /^aily\\.directory:/ && viewItem !~ /platform-pkg-/) || viewItem =~ /^aily\\.file:fs-/)`
const WHEN_PLATFORM_PKG = `${WHEN_VIEW} && viewItem =~ /^aily\\.directory:platform-pkg-/`
/** Start Here 下 src 镜像的 .cpp 文件 */
const WHEN_SRC_CPP_ENTRY = `${WHEN_VIEW} && viewItem =~ /^aily\\.file:entry-src-/`
const WHEN_PROJECT_ACI = `${WHEN_VIEW} && viewItem == aily.file:project-entry`
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
        { command: COMMANDS.openBoardSelector, title: 'Change Board' },
        { command: COMMANDS.openBoardProperty, title: 'Open Board Types' },
        { command: COMMANDS.showNodeInfo, title: 'Show Node Info' }
      ],
      menus: {
        'view/item/context': [
          // 通用 - file / virtual-file → Open
          { command: COMMANDS.open, when: WHEN_FILE_LIKE, group: 'navigation@10' },
          // Platform Packages：仅右键 Open Folder，走 Electron 打开 appdata 真实目录
          { command: COMMANDS.openFolder, when: WHEN_PLATFORM_PKG, group: 'navigation@11' },
          // 通用 - directory → Open Folder
          { command: COMMANDS.openFolder, when: WHEN_DIRECTORY, group: 'navigation@10' },
          // 通用 - Reveal / Copy
          { command: COMMANDS.revealInFilesView, when: WHEN_REVEALABLE, group: 'navigation@20' },
          { command: COMMANDS.copyRelativePath, when: WHEN_REVEALABLE, group: 'navigation@30' },

          // src/*.cpp 入口
          { command: COMMANDS.setAsMainEntry, when: WHEN_SRC_CPP_ENTRY, group: '1_main@10' },

          // 真实目录额外
          { command: COMMANDS.newFile, when: WHEN_DIRECTORY, group: '1_directory@10' },
          { command: COMMANDS.newFolder, when: WHEN_DIRECTORY, group: '1_directory@20' },
          // 单条 Rename：避免同一 command 在多个 group 重复出现
          { command: COMMANDS.rename, when: WHEN_RENAMEABLE, group: '7_modification@20' },

          // project.aci（仅 Start Here > project-entry）
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
  let buildOutputsCache: BuildOutputsHint | null | undefined
  let buildOutputsInflight: Promise<BuildOutputsHint> | null = null

  /** 仅读宿主写入的 hints；无产物时不推导虚拟路径 */
  const loadBuildOutputsFromWorkspace = async (): Promise<BuildOutputsHint> => {
    if (buildOutputsCache != null) {
      return buildOutputsCache
    }
    if (buildOutputsInflight != null) {
      return buildOutputsInflight
    }
    buildOutputsInflight = (async (): Promise<BuildOutputsHint> => {
      try {
        const root = vscode.workspace.workspaceFolders?.[0]?.uri
        const empty: BuildOutputsHint = { artifacts: [] }
        if (root == null) {
          buildOutputsCache = empty
          return empty
        }
        try {
          const hintsUri = vscode.Uri.joinPath(root, '.aily', 'coder-embed-hints.json')
          const hbuf = await vscode.workspace.fs.readFile(hintsUri)
          const h = JSON.parse(new TextDecoder('utf-8').decode(hbuf)) as {
            buildPath?: string
            buildArtifacts?: Array<{ label?: string; abs?: string; rel?: string }>
            mainHexAbs?: string
            mainHexRelPath?: string
          }
          const out: BuildOutputsHint = { artifacts: [] }
          if (typeof h.buildPath === 'string' && h.buildPath.trim()) {
            out.buildPath = h.buildPath.trim()
          }
          if (Array.isArray(h.buildArtifacts)) {
            for (const row of h.buildArtifacts) {
              const label = typeof row.label === 'string' ? row.label.trim() : ''
              const abs = typeof row.abs === 'string' ? row.abs.trim() : ''
              if (!label || !abs) {
                continue
              }
              const rel =
                typeof row.rel === 'string' && row.rel.trim()
                  ? row.rel.trim().replace(/\\/g, '/')
                  : undefined
              out.artifacts.push({ label, abs, ...(rel ? { rel } : {}) })
            }
          }
          if (typeof h.mainHexAbs === 'string' && h.mainHexAbs.trim()) {
            const hexAbs = h.mainHexAbs.trim()
            if (!out.artifacts.some((a) => a.abs === hexAbs)) {
              const rel =
                typeof h.mainHexRelPath === 'string' && h.mainHexRelPath.trim()
                  ? h.mainHexRelPath.trim().replace(/\\/g, '/')
                  : undefined
              out.artifacts.unshift({
                label: 'main.hex',
                abs: hexAbs,
                ...(rel ? { rel } : {})
              })
            }
          }
          if (out.artifacts.length > 0) {
            buildOutputsCache = out
            return out
          }
        } catch {
          /* 无 hints */
        }
        buildOutputsCache = empty
        return empty
      } catch {
        buildOutputsCache = { artifacts: [] }
        return { artifacts: [] }
      } finally {
        buildOutputsInflight = null
      }
    })()
    return buildOutputsInflight
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

  /** 蓝图节点与 node_modules 动态节点统一解析为可打开的 URI */
  const resolveUriForElement = (element?: ExplorerTreeElement): vscode.Uri | undefined => {
    if (element == null) {
      return undefined
    }
    if (element.kind === 'fs') {
      return resolveProjectUri(element.relPath)
    }
    return resolveUriForTreeNode(element.node)
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
  /** Platform Packages / main.hex 等工作区外路径：仅通过 postMessage → Electron 打开 */
  const revealPlatformPathInHostOs = (element: ExplorerTreeElement | undefined): boolean => {
    const uri = resolveUriForElement(element)
    if (uri == null) {
      return false
    }
    return revealInHostOsIfEmbedded(uri.fsPath)
  }

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
  const elementLabel = (element?: ExplorerTreeElement): string => {
    if (element == null) {
      return '(未指定节点)'
    }
    return element.kind === 'fs' ? element.label : element.node.label
  }

  const placeholder =
    (actionLabel: string) =>
    async (element?: ExplorerTreeElement): Promise<void> => {
      await vscode.window.showInformationMessage(
        `[Aily View] ${actionLabel}（占位）：${elementLabel(element)}`
      )
    }

  /**
   * 复制文本到剪贴板。
   * 内嵌 Electron 优先 postMessage → 宿主 electron.clipboard，避免 iframe Permissions-Policy 报错。
   */
  const copyTextToClipboard = async (text: string): Promise<void> => {
    if (requestHostClipboardWriteText(text)) {
      return
    }
    if (typeof document !== 'undefined') {
      try {
        const ta = document.createElement('textarea')
        ta.value = text
        ta.setAttribute('readonly', '')
        ta.style.position = 'fixed'
        ta.style.left = '-9999px'
        document.body.appendChild(ta)
        ta.select()
        const ok = document.execCommand('copy')
        document.body.removeChild(ta)
        if (ok) {
          return
        }
      } catch {
        /* 继续尝试 vscode.env.clipboard */
      }
    }
    await vscode.env.clipboard.writeText(text)
  }

  // 通用菜单（§7.1）
  vscode.commands.registerCommand(COMMANDS.open, async (element?: ExplorerTreeElement) => {
    const label =
      element?.kind === 'fs' ? element.label : (element?.node.label ?? 'Unknown')
    if (element?.kind === 'project' && isPlatformPackageProjectNode(element.node)) {
      if (revealPlatformPathInHostOs(element)) {
        return
      }
      await vscode.window.showWarningMessage(`无法在系统中打开 ${label}：未连接到 Electron 宿主。`)
      return
    }
    const uri = resolveUriForElement(element)
    if (uri == null) {
      await vscode.window.showWarningMessage(
        `无法打开 ${label}：当前没有工作区或未配置真实路径。`
      )
      return
    }
    const abs = uri.fsPath
    if (!isUriUnderWorkspace(uri) && revealInHostOsIfEmbedded(abs)) {
      return
    }
    try {
      await vscode.commands.executeCommand('vscode.open', uri)
    } catch (err) {
      if (revealInHostOsIfEmbedded(abs)) {
        return
      }
      await vscode.window.showErrorMessage(`打开 ${label} 失败：${String(err)}`)
    }
  })
  vscode.commands.registerCommand(COMMANDS.openFolder, async (element?: ExplorerTreeElement) => {
    const label =
      element?.kind === 'fs' ? element.label : (element?.node.label ?? 'Unknown')
    if (element?.kind === 'project' && isPlatformPackageProjectNode(element.node)) {
      if (revealPlatformPathInHostOs(element)) {
        return
      }
      await vscode.window.showWarningMessage(`无法在系统中打开 ${label}：未连接到 Electron 宿主。`)
      return
    }
    const uri = resolveUriForElement(element)
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
      const label =
        element?.kind === 'fs' ? element.label : (element?.node.label ?? 'Unknown')
      if (element?.kind === 'project' && isPlatformPackageProjectNode(element.node)) {
        if (revealPlatformPathInHostOs(element)) {
          return
        }
        await vscode.window.showWarningMessage(`无法在系统中定位 ${label}：未连接到 Electron 宿主。`)
        return
      }
      const uri = resolveUriForElement(element)
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
      const uri = resolveUriForElement(element)
      const label =
        element?.kind === 'fs' ? element.label : (element?.node.label ?? '该节点')
      if (uri == null) {
        await vscode.window.showWarningMessage(`${label} 没有可复制的相对路径。`)
        return
      }
      const text = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/')
      try {
        await copyTextToClipboard(text)
        await vscode.window.showInformationMessage(`已复制相对路径：${text}`)
      } catch (err) {
        await vscode.window.showErrorMessage(`复制相对路径失败：${String(err)}`)
      }
    }
  )

  // 真实目录（§7.2）
  vscode.commands.registerCommand(COMMANDS.newFile, placeholder('New File'))
  vscode.commands.registerCommand(COMMANDS.newFolder, placeholder('New Folder'))

  // project.aci（§7.2）
  // Open as JSON 可立即落地，复用 path；其余先占位
  vscode.commands.registerCommand(COMMANDS.openVisualConfig, placeholder('Open Visual Config'))
  vscode.commands.registerCommand(COMMANDS.openAsJson, async (element?: ExplorerTreeElement) => {
    if (element?.kind !== 'project') {
      return
    }
    await openByPath(element.node.path, element.node.label ?? 'project.aci')
  })
  vscode.commands.registerCommand(COMMANDS.validateConfig, placeholder('Validate Config'))
  vscode.commands.registerCommand(COMMANDS.regenerateLockFile, placeholder('Regenerate Lock File'))

  // property 节点（§7.2）
  vscode.commands.registerCommand(COMMANDS.openSettings, placeholder('Open Settings'))
  vscode.commands.registerCommand(COMMANDS.openBoardSelector, () => {
    requestHostOpenBoardSelector()
  })
  const loadBoardProfileFromWorkspace = async (): Promise<HostBoardProfileV1 | undefined> => {
    const fromHost = getHostEmbedContext()?.boardProfile
    if (fromHost?.frameworkModes != null && fromHost.frameworkModes.length > 0) {
      return fromHost
    }
    try {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri
      if (root == null) {
        return undefined
      }
      const hintsUri = vscode.Uri.joinPath(root, '.aily', 'coder-embed-hints.json')
      const hbuf = await vscode.workspace.fs.readFile(hintsUri)
      const h = JSON.parse(new TextDecoder('utf-8').decode(hbuf)) as {
        boardProfile?: HostBoardProfileV1
      }
      const bp = h.boardProfile
      if (bp?.frameworkModes != null && bp.frameworkModes.length > 0) {
        mergeBoardProfileIntoSnapshot(bp)
      }
      return bp
    } catch {
      return undefined
    }
  }

  vscode.commands.registerCommand(COMMANDS.openBoardProperty, async () => {
    let spec = buildBoardListSpecFromHost()
    if (spec == null) {
      const bp = await loadBoardProfileFromWorkspace()
      const items = bp?.frameworkModes
      if (bp != null && items != null && items.length > 0) {
        spec = {
          title: 'Board',
          subtitle: bp.boardNickname?.trim() || bp.boardName?.trim() || undefined,
          items
        }
      }
    }
    await openAilyBoardListEditor(spec, 'board')
  })
  vscode.commands.registerCommand(COMMANDS.changeValue, async (element?: ExplorerTreeElement) => {
    if (element?.kind === 'project' && isBoardSelectorPropertyNode(element.node)) {
      requestHostOpenBoardSelector()
      return
    }
    await placeholder('Change Value')(element)
  })
  vscode.commands.registerCommand(
    COMMANDS.revealBackingConfig,
    placeholder('Reveal Backing Config')
  )

  // Dependencies 分组（§7.2）
  vscode.commands.registerCommand(COMMANDS.addDependency, () => {
    requestHostOpenLibraryManager()
  })
  vscode.commands.registerCommand(COMMANDS.openDependencyPanel, () => {
    requestHostOpenLibraryManager()
  })

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
      if (element?.kind !== 'project') {
        await vscode.window.showInformationMessage('Aily 节点：未选中')
        return
      }
      const n = element.node
      await vscode.window.showInformationMessage(`Aily 节点：${n.label} (${n.type}/${n.id})`)
    }
  )

  /** 优先宿主 postMessage 的 platformPackages，其次读 `.aily/coder-embed-hints.json` */
  const loadPlatformPackagesFromWorkspace = async (): Promise<readonly HostPlatformPackageV1[]> => {
    const fromHost = getHostEmbedContext()?.platformPackages
    if (fromHost != null && fromHost.length > 0) {
      return fromHost
    }
    try {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri
      if (root == null) {
        return []
      }
      const hintsUri = vscode.Uri.joinPath(root, '.aily', 'coder-embed-hints.json')
      const hbuf = await vscode.workspace.fs.readFile(hintsUri)
      const h = JSON.parse(new TextDecoder('utf-8').decode(hbuf)) as {
        platformPackages?: HostPlatformPackageV1[]
      }
      const list = Array.isArray(h.platformPackages) ? h.platformPackages : []
      return list
    } catch {
      return []
    }
  }

  const provider = new AilyExplorerProvider(
    vscode,
    loadBuildOutputsFromWorkspace,
    loadPlatformPackagesFromWorkspace
  )

  const basenameOfUri = (uri: vscode.Uri): string => {
    const normalized = uri.fsPath.replace(/\\/g, '/')
    const idx = normalized.lastIndexOf('/')
    return idx >= 0 ? normalized.slice(idx + 1) : normalized
  }

  const syncProjectAciEntry = async (entryRel: string): Promise<void> => {
    const aciUri = resolveProjectUri('project.aci')
    if (aciUri == null) {
      return
    }
    try {
      const raw = await vscode.workspace.fs.readFile(aciUri)
      const doc = JSON.parse(new TextDecoder('utf-8').decode(raw)) as { entry?: string }
      doc.entry = entryRel.replace(/\\/g, '/')
      const out = `${JSON.stringify(doc, null, 2)}\n`
      await vscode.workspace.fs.writeFile(aciUri, new TextEncoder().encode(out))
    } catch {
      /* 非致命：磁盘已重命名，aci 可稍后手动修复 */
    }
  }

  // src/*.cpp：写入 project.aci entry（§7.2）
  vscode.commands.registerCommand(COMMANDS.setAsMainEntry, async (element?: ExplorerTreeElement) => {
    if (element?.kind !== 'project' || !isSrcCppEntryNodeId(element.node.id)) {
      return
    }
    const rel = element.node.path?.trim()
    if (rel == null || rel.length === 0) {
      await vscode.window.showWarningMessage('无法设为入口：未找到文件路径。')
      return
    }
    await syncProjectAciEntry(rel)
    const startHereEl = getStableBlueprintElement('start-here')
    if (startHereEl != null) {
      provider.refresh(startHereEl)
    } else {
      provider.refresh()
    }
    await vscode.window.showInformationMessage(`已将编译入口设为：${rel.replace(/\\/g, '/')}`)
  })

  /** 原生 Explorer 重命名完成后，同步 Aily View 蓝图节点与 project.aci */
  vscode.workspace.onDidRenameFiles((event) => {
    for (const { oldUri, newUri } of event.files) {
      const oldRel = vscode.workspace.asRelativePath(oldUri, false).replace(/\\/g, '/')
      const newRel = vscode.workspace.asRelativePath(newUri, false).replace(/\\/g, '/')
      const newLabel = basenameOfUri(newUri)
      const nodeId = findBlueprintNodeIdByRelPath(oldRel)

      if (nodeId == null) {
        if (
          shouldRefreshStartHereNativeWatch(oldRel) ||
          shouldRefreshStartHereNativeWatch(newRel)
        ) {
          refreshStartHereGroup()
        } else {
          provider.refresh()
        }
        continue
      }

      if (isSrcCppEntryNodeId(nodeId)) {
        void (async () => {
          const mainEntry = await readProjectAciEntry(vscode)
          if (mainEntry != null && oldRel.replace(/\\/g, '/') === mainEntry) {
            await syncProjectAciEntry(newRel)
          }
        })()
        const startHereEl = getStableBlueprintElement('start-here')
        if (startHereEl != null) {
          provider.refresh(startHereEl)
        } else {
          provider.refresh()
        }
        continue
      }

      blueprintPathOverrides.set(nodeId, { label: newLabel, path: newRel })
      provider.refresh()
    }
  })

  vscode.commands.registerCommand(COMMANDS.refreshPackages, async () => {
    provider.refresh()
  })

  const treeView = vscode.window.createTreeView(AILY_VIEW_ID, {
    treeDataProvider: provider,
    showCollapseAll: true
  })

  vscode.commands.registerCommand(COMMANDS.rename, async (element?: ExplorerTreeElement) => {
    const label = elementLabel(element)

    if (element?.kind === 'project' && isPlatformPackageProjectNode(element.node)) {
      await vscode.window.showWarningMessage(`无法重命名 ${label}：平台包目录为只读。`)
      return
    }

    const uri = resolveUriForElement(element)

    if (uri == null) {
      await vscode.window.showWarningMessage(`无法重命名 ${label}：未找到磁盘路径。`)
      return
    }
    if (!isUriUnderWorkspace(uri)) {
      await vscode.window.showWarningMessage(`无法重命名 ${label}：仅支持工作区内路径。`)
      return
    }

    const currentName =
      element?.kind === 'fs' ? element.label : basenameOfUri(uri)

    const result = await startVirtualTreeInlineRename({
      treeView,
      element,
      currentName,
      isDirectory: isRenameTargetDirectory(element),
      validateName: validateRenameEntryName,
      onCommit: async (newName) => {
        const targetUri = vscode.Uri.joinPath(vscode.Uri.joinPath(uri, '..'), newName)
        try {
          await vscode.workspace.fs.stat(targetUri)
          throw new Error(`「${newName}」已存在`)
        } catch (err) {
          if (err instanceof Error && err.message.includes('已存在')) {
            throw err
          }
          /* 目标不存在，可继续 */
        }
        await vscode.workspace.fs.rename(uri, targetUri, { overwrite: false })
      }
    }).catch(async (err: unknown) => {
      if (err instanceof Error && err.message.length > 0) {
        await vscode.window.showErrorMessage(`重命名 ${label} 失败：${err.message}`)
      }
      return 'cancelled' as const
    })

    if (result === 'unavailable') {
      await vscode.window.showWarningMessage(
        `无法在 Aily View 中开启内联重命名：${label}。请确认节点已选中后重试。`
      )
    }
  })

  /** Installed Libraries 树节点展开/折叠 ↔ 宿主右上角库管理侧栏 */
  treeView.onDidExpandElement((ev) => {
    if (isInstalledLibrariesGroup(ev.element)) {
      requestHostOpenLibraryManager()
    }
  })
  treeView.onDidCollapseElement((ev) => {
    if (isInstalledLibrariesGroup(ev.element)) {
      requestHostCloseLibraryManager()
    }
  })

  /** node_modules 变更时刷新 Installed Libraries 子树 */
  let nodeModulesWatcher: vscode.FileSystemWatcher | undefined
  const setupNodeModulesWatcher = (): void => {
    nodeModulesWatcher?.dispose()
    nodeModulesWatcher = undefined
    const root = vscode.workspace.workspaceFolders?.[0]
    if (root == null) {
      return
    }
    nodeModulesWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(root, `${NODE_MODULES_REL}/**`)
    )
    const bump = (): void => {
      provider.refresh()
    }
    nodeModulesWatcher.onDidCreate(bump)
    nodeModulesWatcher.onDidDelete(bump)
    nodeModulesWatcher.onDidChange(bump)
  }
  setupNodeModulesWatcher()

  const refreshStartHereGroup = (): void => {
    const startHereEl = getStableBlueprintElement('start-here')
    if (startHereEl != null) {
      provider.refresh(startHereEl)
    } else {
      provider.refresh()
    }
  }

  /** Framework 下编译产物虚拟节点：失效 hints 缓存并定向刷新 framework 子树 */
  const refreshFrameworkBuildOutputs = (): void => {
    buildOutputsCache = undefined
    const frameworkEl = getStableBlueprintElement('framework')
    if (frameworkEl != null) {
      provider.refresh(frameworkEl)
    } else {
      refreshDynamicBlueprintSections(provider)
    }
  }

  const bumpFrameworkBuildOutputsFromUri = (uri?: vscode.Uri): void => {
    const fsPath = uri?.fsPath?.replace(/\\/g, '/') ?? ''
    if (fsPath.length > 0 && !shouldRefreshFrameworkBuildOutputsNativeWatch(fsPath)) {
      return
    }
    refreshFrameworkBuildOutputs()
  }

  const bumpStartHereFromUri = (uri?: vscode.Uri): void => {
    const fsPath = uri?.fsPath?.replace(/\\/g, '/') ?? ''
    if (fsPath.length > 0 && !shouldRefreshStartHereNativeWatch(fsPath)) {
      return
    }
    refreshStartHereGroup()
  }

  /** src/ 下 .cpp 增删时刷新 Start Here（非嵌入模式兜底） */
  let srcWatcher: vscode.FileSystemWatcher | undefined
  const setupSrcWatcher = (): void => {
    srcWatcher?.dispose()
    srcWatcher = undefined
    const root = vscode.workspace.workspaceFolders?.[0]
    if (root == null) {
      return
    }
    srcWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(root, `${SRC_REL}/**`)
    )
    srcWatcher.onDidCreate((uri) => bumpStartHereFromUri(uri))
    srcWatcher.onDidDelete((uri) => bumpStartHereFromUri(uri))
    srcWatcher.onDidChange((uri) => bumpStartHereFromUri(uri))
  }
  setupSrcWatcher()

  /** .aily/build 与 coder-embed-hints 变更时刷新 Framework 产物虚拟节点（非嵌入模式兜底） */
  let buildOutputsWatcher: vscode.FileSystemWatcher | undefined
  const setupBuildOutputsWatcher = (): void => {
    buildOutputsWatcher?.dispose()
    buildOutputsWatcher = undefined
    const root = vscode.workspace.workspaceFolders?.[0]
    if (root == null) {
      return
    }
    buildOutputsWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(root, '.aily/{build/**,coder-embed-hints.json}')
    )
    buildOutputsWatcher.onDidCreate((uri) => bumpFrameworkBuildOutputsFromUri(uri))
    buildOutputsWatcher.onDidDelete((uri) => bumpFrameworkBuildOutputsFromUri(uri))
    buildOutputsWatcher.onDidChange((uri) => bumpFrameworkBuildOutputsFromUri(uri))
  }
  setupBuildOutputsWatcher()

  /** 嵌入 Electron：系统级复制/删除/移动走宿主 fs.watch */
  let disposeEmbedSrcWatch: (() => void) | undefined
  const setupEmbedSrcNativeWatcher = (): void => {
    disposeEmbedSrcWatch?.()
    disposeEmbedSrcWatch = undefined
    if (!coderUseEmbedHostNativeFsBridge) {
      return
    }
    const root = vscode.workspace.workspaceFolders?.[0]
    if (root == null) {
      return
    }
    void startWorkspaceNativeWatch(root.uri.fsPath, (ev) => {
      if (shouldRefreshStartHereNativeWatch(ev.filename)) {
        refreshStartHereGroup()
      }
      if (shouldRefreshFrameworkBuildOutputsNativeWatch(ev.filename)) {
        refreshFrameworkBuildOutputs()
      }
    })
      .then((dispose) => {
        disposeEmbedSrcWatch = dispose
      })
      .catch(() => {})
  }
  setupEmbedSrcNativeWatcher()

  let projectAciWatcher: vscode.FileSystemWatcher | undefined
  const setupProjectAciWatcher = (): void => {
    projectAciWatcher?.dispose()
    projectAciWatcher = undefined
    const root = vscode.workspace.workspaceFolders?.[0]
    if (root == null) {
      return
    }
    projectAciWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(root, 'project.aci')
    )
    projectAciWatcher.onDidChange(() => refreshStartHereGroup())
  }
  setupProjectAciWatcher()

  /** VS Code 工作区内删除文件（嵌入模式补充） */
  if (typeof vscode.workspace.onDidDeleteFiles === 'function') {
    vscode.workspace.onDidDeleteFiles((event) => {
      for (const uri of event.files) {
        bumpStartHereFromUri(uri)
      }
    })
  }

  vscode.workspace.onDidChangeWorkspaceFolders(() => {
    buildOutputsCache = undefined
    setupNodeModulesWatcher()
    setupSrcWatcher()
    setupBuildOutputsWatcher()
    setupEmbedSrcNativeWatcher()
    setupProjectAciWatcher()
    provider.refresh()
  })

  onHostEmbedContextChanged(() => {
    // 宿主推送新上下文时，让 hint 兜底也走一次盘上读取，避免编译完成后仍用旧路径
    buildOutputsCache = undefined
    // 定向刷新动态分组，避免 refresh(undefined) 与 Board 自定义编辑器打开竞态导致同级节点 UI 消失
    refreshDynamicBlueprintSections(provider)
    if ((getHostEmbedContext()?.boardProfile?.frameworkModes?.length ?? 0) === 0) {
      void loadBoardProfileFromWorkspace()
    }
  })
})
