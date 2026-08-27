import { normalizeLibraryLanguage } from './ailyComponentLibraryModel.js'

export type SidebarStrings = {
  readonly toolbar: string
  readonly explorer: string
  readonly search: string
  readonly sourceControl: string
}

export type GitScmStrings = {
  readonly initCommand: string
  readonly commitCommand: string
  readonly openChangeCommand: string
  readonly refreshCommand: string
  readonly changes: string
  readonly added: string
  readonly deleted: string
  readonly renamed: string
  readonly copied: string
  readonly conflict: string
  readonly modified: string
  readonly commitPlaceholder: string
  readonly firstCommitPlaceholder: string
  readonly unavailablePlaceholder: string
  readonly commit: string
  readonly initializeAndCommit: string
  readonly firstCommit: string
  readonly openChange: string
  readonly tags: string
  readonly remoteBranches: string
  readonly branches: string
  readonly repositoryInitialized: string
  readonly temporarilyUnavailable: string
  readonly enterCommitMessage: string
  readonly commitSucceeded: string
  diffTitle(path: string): string
  initFailed(detail: string): string
  commitFailed(detail: string): string
}

export type AilyViewStrings = {
  readonly userView: string
  readonly config: string
  readonly library: string
  readonly noExternalLibraries: string
  readonly noProjectLibraries: string
  readonly noPlatformPackages: string
}

export type WorkbenchUiStrings = {
  readonly sidebar: SidebarStrings
  readonly git: GitScmStrings
  readonly ailyView: AilyViewStrings
}

const EN_SIDEBAR: SidebarStrings = {
  toolbar: 'Sidebar views',
  explorer: 'Explorer',
  search: 'Search',
  sourceControl: 'Source Control'
}

const EN_GIT: GitScmStrings = {
  initCommand: 'Git: Initialize Repository',
  commitCommand: 'Git: Commit',
  openChangeCommand: 'Git: Open Changes',
  refreshCommand: 'Git: Refresh',
  changes: 'Changes',
  added: 'Added',
  deleted: 'Deleted',
  renamed: 'Renamed',
  copied: 'Copied',
  conflict: 'Conflict',
  modified: 'Modified',
  commitPlaceholder: 'Message (press Ctrl/Cmd+Enter to commit)',
  firstCommitPlaceholder: 'First commit message (initializes the Git repository on commit)',
  unavailablePlaceholder: 'Git is temporarily unavailable',
  commit: 'Commit',
  initializeAndCommit: 'Initialize and Commit',
  firstCommit: 'First Commit',
  openChange: 'Open Changes',
  tags: 'Tags',
  remoteBranches: 'Remote Branches',
  branches: 'Branches',
  repositoryInitialized: 'Git repository initialized',
  temporarilyUnavailable: 'Git is temporarily unavailable. Refresh and try again.',
  enterCommitMessage: 'Enter a commit message',
  commitSucceeded: 'Git commit succeeded',
  diffTitle: path => `${path} (Git Changes)`,
  initFailed: detail => `Failed to initialize Git: ${detail}`,
  commitFailed: detail => `Git commit failed: ${detail}`
}

const EN_AILY_VIEW: AilyViewStrings = {
  userView: 'User View',
  config: 'Config',
  library: 'Library',
  noExternalLibraries: 'No external libraries installed yet.',
  noProjectLibraries: 'No project libraries yet.',
  noPlatformPackages: 'No platform packages resolved yet.'
}

const ZH_CN: WorkbenchUiStrings = {
  sidebar: {
    toolbar: '侧栏视图',
    explorer: '资源管理器',
    search: '搜索',
    sourceControl: '源代码管理'
  },
  git: {
    initCommand: 'Git：初始化仓库',
    commitCommand: 'Git：提交',
    openChangeCommand: 'Git：打开更改',
    refreshCommand: 'Git：刷新',
    changes: '更改',
    added: '新增',
    deleted: '删除',
    renamed: '重命名',
    copied: '复制',
    conflict: '冲突',
    modified: '修改',
    commitPlaceholder: '提交消息（按 Ctrl/Cmd+Enter 提交）',
    firstCommitPlaceholder: '首次提交消息（提交时自动初始化 Git 仓库）',
    unavailablePlaceholder: 'Git 暂不可用',
    commit: '提交',
    initializeAndCommit: '初始化并提交',
    firstCommit: '首次提交',
    openChange: '打开更改',
    tags: '标签',
    remoteBranches: '远程分支',
    branches: '分支',
    repositoryInitialized: 'Git 仓库初始化成功',
    temporarilyUnavailable: 'Git 暂不可用，请刷新后重试',
    enterCommitMessage: '请输入提交消息',
    commitSucceeded: 'Git 提交成功',
    diffTitle: path => `${path}（Git 更改）`,
    initFailed: detail => `Git 初始化失败：${detail}`,
    commitFailed: detail => `Git 提交失败：${detail}`
  },
  ailyView: {
    userView: '用户视图',
    config: '配置',
    library: '库',
    noExternalLibraries: '尚未安装外部库。',
    noProjectLibraries: '暂无项目库。',
    noPlatformPackages: '尚未解析平台软件包。'
  }
}

const ZH_HK: WorkbenchUiStrings = {
  sidebar: {
    toolbar: '側欄檢視',
    explorer: '檔案總管',
    search: '搜尋',
    sourceControl: '原始碼控制'
  },
  git: {
    initCommand: 'Git：初始化儲存庫',
    commitCommand: 'Git：提交',
    openChangeCommand: 'Git：開啟變更',
    refreshCommand: 'Git：重新整理',
    changes: '變更',
    added: '新增',
    deleted: '刪除',
    renamed: '重新命名',
    copied: '複製',
    conflict: '衝突',
    modified: '修改',
    commitPlaceholder: '提交訊息（按 Ctrl/Cmd+Enter 提交）',
    firstCommitPlaceholder: '首次提交訊息（提交時自動初始化 Git 儲存庫）',
    unavailablePlaceholder: 'Git 暫時無法使用',
    commit: '提交',
    initializeAndCommit: '初始化並提交',
    firstCommit: '首次提交',
    openChange: '開啟變更',
    tags: '標籤',
    remoteBranches: '遠端分支',
    branches: '分支',
    repositoryInitialized: 'Git 儲存庫初始化成功',
    temporarilyUnavailable: 'Git 暫時無法使用，請重新整理後再試',
    enterCommitMessage: '請輸入提交訊息',
    commitSucceeded: 'Git 提交成功',
    diffTitle: path => `${path}（Git 變更）`,
    initFailed: detail => `Git 初始化失敗：${detail}`,
    commitFailed: detail => `Git 提交失敗：${detail}`
  },
  ailyView: {
    userView: '使用者檢視',
    config: '設定',
    library: '程式庫',
    noExternalLibraries: '尚未安裝外部程式庫。',
    noProjectLibraries: '暫無專案程式庫。',
    noPlatformPackages: '尚未解析平台套件。'
  }
}

const LOCALIZED_SIDEBARS: Readonly<Record<string, SidebarStrings>> = {
  ja: { toolbar: 'サイドバービュー', explorer: 'エクスプローラー', search: '検索', sourceControl: 'ソース管理' },
  ko: { toolbar: '사이드바 보기', explorer: '탐색기', search: '검색', sourceControl: '소스 제어' },
  de: { toolbar: 'Seitenleistenansichten', explorer: 'Explorer', search: 'Suche', sourceControl: 'Quellcodeverwaltung' },
  fr: { toolbar: 'Vues de la barre latérale', explorer: 'Explorateur', search: 'Rechercher', sourceControl: 'Contrôle de code source' },
  es: { toolbar: 'Vistas de la barra lateral', explorer: 'Explorador', search: 'Buscar', sourceControl: 'Control de código fuente' },
  pt: { toolbar: 'Exibições da barra lateral', explorer: 'Explorador', search: 'Pesquisar', sourceControl: 'Controle do código-fonte' },
  ru: { toolbar: 'Представления боковой панели', explorer: 'Проводник', search: 'Поиск', sourceControl: 'Система управления версиями' },
  ar: { toolbar: 'طرق عرض الشريط الجانبي', explorer: 'المستكشف', search: 'بحث', sourceControl: 'التحكم بالمصدر' }
}

const LOCALIZED_AILY_VIEWS: Readonly<Record<string, AilyViewStrings>> = {
  ja: {
    userView: 'ユーザービュー', config: '設定', library: 'ライブラリ',
    noExternalLibraries: '外部ライブラリはまだインストールされていません。',
    noProjectLibraries: 'プロジェクトライブラリはまだありません。',
    noPlatformPackages: 'プラットフォームパッケージはまだ解決されていません。'
  },
  ko: {
    userView: '사용자 보기', config: '구성', library: '라이브러리',
    noExternalLibraries: '설치된 외부 라이브러리가 없습니다.',
    noProjectLibraries: '프로젝트 라이브러리가 없습니다.',
    noPlatformPackages: '확인된 플랫폼 패키지가 없습니다.'
  },
  de: {
    userView: 'Benutzeransicht', config: 'Konfiguration', library: 'Bibliothek',
    noExternalLibraries: 'Noch keine externen Bibliotheken installiert.',
    noProjectLibraries: 'Noch keine Projektbibliotheken vorhanden.',
    noPlatformPackages: 'Noch keine Plattformpakete aufgelöst.'
  },
  fr: {
    userView: 'Vue utilisateur', config: 'Configuration', library: 'Bibliothèque',
    noExternalLibraries: 'Aucune bibliothèque externe installée.',
    noProjectLibraries: 'Aucune bibliothèque de projet.',
    noPlatformPackages: 'Aucun paquet de plateforme résolu.'
  },
  es: {
    userView: 'Vista de usuario', config: 'Configuración', library: 'Biblioteca',
    noExternalLibraries: 'Aún no hay bibliotecas externas instaladas.',
    noProjectLibraries: 'Aún no hay bibliotecas del proyecto.',
    noPlatformPackages: 'Aún no hay paquetes de plataforma resueltos.'
  },
  pt: {
    userView: 'Vista do usuário', config: 'Configuração', library: 'Biblioteca',
    noExternalLibraries: 'Ainda não há bibliotecas externas instaladas.',
    noProjectLibraries: 'Ainda não há bibliotecas do projeto.',
    noPlatformPackages: 'Ainda não há pacotes de plataforma resolvidos.'
  },
  ru: {
    userView: 'Пользовательское представление', config: 'Конфигурация', library: 'Библиотека',
    noExternalLibraries: 'Внешние библиотеки пока не установлены.',
    noProjectLibraries: 'Библиотеки проекта пока отсутствуют.',
    noPlatformPackages: 'Пакеты платформы пока не определены.'
  },
  ar: {
    userView: 'عرض المستخدم', config: 'الإعدادات', library: 'المكتبة',
    noExternalLibraries: 'لم يتم تثبيت مكتبات خارجية بعد.',
    noProjectLibraries: 'لا توجد مكتبات للمشروع بعد.',
    noPlatformPackages: 'لم يتم تحديد حزم المنصة بعد.'
  }
}

export function initialHostLanguage(): string {
  if (typeof window !== 'undefined') {
    return new URLSearchParams(window.location.search).get('lang') || navigator.language || 'en'
  }
  return 'en'
}

export function workbenchUiStrings(language: unknown): WorkbenchUiStrings {
  const normalized = normalizeLibraryLanguage(language)
  if (normalized === 'zh_cn') return ZH_CN
  if (normalized === 'zh_hk') return ZH_HK
  return {
    sidebar: LOCALIZED_SIDEBARS[normalized] ?? EN_SIDEBAR,
    // The custom Git provider falls back to English until a dedicated translation is present.
    // This avoids the previous behavior where every non-Chinese locale displayed Chinese copy.
    git: EN_GIT,
    ailyView: LOCALIZED_AILY_VIEWS[normalized] ?? EN_AILY_VIEW
  }
}
