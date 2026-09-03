import { normalizeLibraryLanguage } from './ailyComponentLibraryModel.js'

export type LibrarySource = 'aily' | 'registry'

export type UiStrings = {
  readonly panelTitle: string
  readonly ailyTab: string
  readonly arduinoTab: string
  readonly searchAily: string
  readonly searchArduino: string
  readonly refresh: string
  readonly add: string
  readonly adding: string
  readonly remove: string
  readonly removing: string
  readonly installed: string
  readonly loadingAily: string
  readonly loadingArduino: string
  readonly emptyAily: string
  readonly emptyArduino: string
  readonly unavailable: string
  readonly docs: string
  readonly ailySection: string
  readonly arduinoSection: string
  readonly close: string
  readonly toggle: string
  readonly allTypes: string
  readonly allTopics: string
  readonly loadMore: string
  readonly loadingMore: string
  readonly compatible: string
  readonly otherArchitecture: string
  readonly resultUnit: string
  readonly endOfResults: string
  readonly sourceTabsLabel: string
  readonly versionLabel: string
  added(name: string, source: LibrarySource): string
  removed(name: string, source: LibrarySource): string
  failed(action: 'load' | 'install' | 'remove', source: LibrarySource, detail: string): string
}

const EN: UiStrings = {
  panelTitle: 'Library Manager', ailyTab: 'Aily Libraries', arduinoTab: 'Arduino Official',
  searchAily: 'Search Aily libraries', searchArduino: 'Search Arduino official libraries', refresh: 'Refresh',
  add: 'Install', adding: 'Installing…', remove: 'Uninstall', removing: 'Uninstalling…', installed: 'In Project',
  loadingAily: 'Loading Aily libraries…', loadingArduino: 'Loading Arduino libraries…',
  emptyAily: 'No matching Aily libraries', emptyArduino: 'No matching Arduino libraries',
  unavailable: 'The active Coder project is not ready.',
  docs: 'More info', ailySection: 'Aily Libraries', arduinoSection: 'Arduino Official Libraries',
  close: 'Close library list', toggle: 'Expand or collapse library list', allTypes: 'Type: All', allTopics: 'Topic: All',
  loadMore: 'Load more', loadingMore: 'Loading…', compatible: 'Compatible',
  otherArchitecture: 'Other architecture',
  resultUnit: 'libraries',
  endOfResults: 'All matching libraries are shown', sourceTabsLabel: 'Library source', versionLabel: 'version',
  added: (name, source) => source === 'aily'
    ? `${name} was installed from Aily Library Manager`
    : `${name} was installed under sketch/libraries`,
  removed: name => `${name} was uninstalled from the current project`,
  failed: (action, source, detail) => `${action === 'load'
    ? `Failed to load ${source === 'aily' ? 'Aily' : 'Arduino'} libraries`
    : action === 'remove' ? 'Failed to uninstall the library' : 'Failed to install the library'}: ${detail}`,
}

const ZH_CN: UiStrings = {
  panelTitle: '库管理', ailyTab: 'Aily 库', arduinoTab: 'Arduino 官方库',
  searchAily: '搜索 Aily 库', searchArduino: '搜索 Arduino 官方库', refresh: '刷新',
  add: '安装', adding: '正在安装…', remove: '卸载', removing: '正在卸载…', installed: '已安装',
  loadingAily: '正在加载 Aily 库…', loadingArduino: '正在加载 Arduino 官方库…',
  emptyAily: '没有匹配的 Aily 库', emptyArduino: '没有匹配的 Arduino 官方库',
  unavailable: '当前 Coder 工程尚未就绪。',
  docs: '更多信息', ailySection: 'Aily 库', arduinoSection: 'Arduino 官方库', close: '收起库列表', toggle: '展开或收起库列表',
  allTypes: '类型：全部', allTopics: '主题：全部', loadMore: '加载更多', loadingMore: '加载中…',
  compatible: '兼容当前平台', otherArchitecture: '其他架构',
  resultUnit: '个库', endOfResults: '已显示全部匹配库',
  sourceTabsLabel: '库来源', versionLabel: '版本',
  added: (name, source) => source === 'aily'
    ? `${name} 已从 Aily 库安装到当前工程`
    : `${name} 已安装到 sketch/libraries`,
  removed: name => `${name} 已从当前工程卸载`,
  failed: (action, source, detail) => `${action === 'load'
    ? `加载${source === 'aily' ? ' Aily' : ' Arduino 官方'}库失败`
    : action === 'remove' ? '卸载库失败' : '安装库失败'}：${detail}`,
}

const ZH_HK: UiStrings = {
  panelTitle: '函式庫管理', ailyTab: 'Aily 函式庫', arduinoTab: 'Arduino 官方函式庫',
  searchAily: '搜尋 Aily 函式庫', searchArduino: '搜尋 Arduino 官方函式庫', refresh: '重新整理',
  add: '安裝', adding: '正在安裝…', remove: '解除安裝', removing: '正在解除安裝…', installed: '已在專案中',
  loadingAily: '正在載入 Aily 函式庫…', loadingArduino: '正在載入 Arduino 官方函式庫…',
  emptyAily: '找不到相符的 Aily 函式庫', emptyArduino: '找不到相符的 Arduino 官方函式庫',
  unavailable: '目前的 Coder 專案尚未就緒。',
  docs: '更多資訊', ailySection: 'Aily 函式庫', arduinoSection: 'Arduino 官方函式庫', close: '收起函式庫清單', toggle: '展開或收起函式庫清單',
  allTypes: '類型：全部', allTopics: '主題：全部', loadMore: '載入更多', loadingMore: '載入中…',
  compatible: '相容目前平台', otherArchitecture: '其他架構',
  resultUnit: '個函式庫', endOfResults: '已顯示所有相符函式庫',
  sourceTabsLabel: '函式庫來源', versionLabel: '版本',
  added: (name, source) => source === 'aily'
    ? `${name} 已從 Aily 函式庫安裝到目前專案`
    : `${name} 已安裝到 sketch/libraries`,
  removed: name => `${name} 已從目前專案解除安裝`,
  failed: (action, source, detail) => `${action === 'load'
    ? `載入${source === 'aily' ? ' Aily' : ' Arduino 官方'}函式庫失敗`
    : action === 'remove' ? '解除安裝函式庫失敗' : '安裝函式庫失敗'}：${detail}`,
}

function localized(
  overrides: Partial<Omit<UiStrings, 'added' | 'removed' | 'failed'>>,
  messages: Pick<UiStrings, 'added' | 'removed' | 'failed'>,
): UiStrings {
  return { ...EN, ...overrides, ...messages }
}

const JA = localized({
  panelTitle: 'ライブラリ管理', ailyTab: 'Aily ライブラリ', arduinoTab: 'Arduino 公式',
  searchAily: 'Aily ライブラリを検索', searchArduino: 'Arduino 公式ライブラリを検索', refresh: '更新',
  add: 'インストール', adding: 'インストール中…', remove: 'アンインストール', removing: 'アンインストール中…', installed: 'プロジェクト内',
  loadingAily: 'Aily ライブラリを読み込み中…', loadingArduino: 'Arduino 公式ライブラリを読み込み中…',
  emptyAily: '一致する Aily ライブラリがありません', emptyArduino: '一致する Arduino ライブラリがありません',
  unavailable: 'Coder プロジェクトの準備ができていません。',
  docs: '詳細', ailySection: 'Aily ライブラリ', arduinoSection: 'Arduino 公式ライブラリ', close: 'ライブラリ一覧を閉じる', toggle: 'ライブラリ一覧を開閉',
  allTypes: '種類：すべて', allTopics: 'トピック：すべて', loadMore: 'さらに読み込む', loadingMore: '読み込み中…',
  compatible: '互換', otherArchitecture: '別のアーキテクチャ',
  resultUnit: '件', endOfResults: '一致するライブラリをすべて表示しました', sourceTabsLabel: 'ライブラリの提供元', versionLabel: 'バージョン',
}, {
  added: (name, source) => source === 'aily' ? `${name} を Aily ライブラリからインストールしました` : `${name} を sketch/libraries にインストールしました`,
  removed: name => `${name} をプロジェクトからアンインストールしました`,
  failed: (action, source, detail) => `${action === 'load' ? `${source === 'aily' ? 'Aily' : 'Arduino'} ライブラリの読み込みに失敗しました` : action === 'remove' ? 'ライブラリのアンインストールに失敗しました' : 'ライブラリのインストールに失敗しました'}：${detail}`,
})

const KO = localized({
  panelTitle: '라이브러리 관리', ailyTab: 'Aily 라이브러리', arduinoTab: 'Arduino 공식',
  searchAily: 'Aily 라이브러리 검색', searchArduino: 'Arduino 공식 라이브러리 검색', refresh: '새로고침',
  add: '설치', adding: '설치 중…', remove: '제거', removing: '제거 중…', installed: '프로젝트에 있음',
  loadingAily: 'Aily 라이브러리 로드 중…', loadingArduino: 'Arduino 공식 라이브러리 로드 중…',
  emptyAily: '일치하는 Aily 라이브러리가 없습니다', emptyArduino: '일치하는 Arduino 라이브러리가 없습니다',
  unavailable: 'Coder 프로젝트가 준비되지 않았습니다.',
  docs: '자세히', ailySection: 'Aily 라이브러리', arduinoSection: 'Arduino 공식 라이브러리', close: '라이브러리 목록 닫기', toggle: '라이브러리 목록 펼치기 또는 접기',
  allTypes: '유형: 전체', allTopics: '주제: 전체', loadMore: '더 보기', loadingMore: '로드 중…',
  compatible: '호환됨', otherArchitecture: '다른 아키텍처',
  resultUnit: '개', endOfResults: '일치하는 라이브러리를 모두 표시했습니다', sourceTabsLabel: '라이브러리 소스', versionLabel: '버전',
}, {
  added: (name, source) => source === 'aily' ? `${name} 라이브러리를 Aily에서 설치했습니다` : `${name} 라이브러리를 sketch/libraries에 설치했습니다`,
  removed: name => `${name} 라이브러리를 프로젝트에서 제거했습니다`,
  failed: (action, source, detail) => `${action === 'load' ? `${source === 'aily' ? 'Aily' : 'Arduino'} 라이브러리를 불러오지 못했습니다` : action === 'remove' ? '라이브러리를 제거하지 못했습니다' : '라이브러리를 설치하지 못했습니다'}: ${detail}`,
})

const DE = localized({
  panelTitle: 'Bibliotheksverwaltung', ailyTab: 'Aily-Bibliotheken', arduinoTab: 'Arduino offiziell',
  searchAily: 'Aily-Bibliotheken durchsuchen', searchArduino: 'Offizielle Arduino-Bibliotheken durchsuchen', refresh: 'Aktualisieren',
  add: 'Installieren', adding: 'Wird installiert…', remove: 'Deinstallieren', removing: 'Wird deinstalliert…', installed: 'Im Projekt',
  loadingAily: 'Aily-Bibliotheken werden geladen…', loadingArduino: 'Arduino-Bibliotheken werden geladen…',
  emptyAily: 'Keine passenden Aily-Bibliotheken', emptyArduino: 'Keine passenden Arduino-Bibliotheken',
  unavailable: 'Das Coder-Projekt ist noch nicht bereit.', toggle: 'Bibliotheksliste ein- oder ausblenden',
  docs: 'Mehr Infos', ailySection: 'Aily-Bibliotheken', arduinoSection: 'Offizielle Arduino-Bibliotheken', close: 'Bibliotheksliste schließen',
  allTypes: 'Typ: Alle', allTopics: 'Thema: Alle', loadMore: 'Mehr laden', loadingMore: 'Wird geladen…',
  compatible: 'Kompatibel', otherArchitecture: 'Andere Architektur',
  resultUnit: 'Bibliotheken', endOfResults: 'Alle passenden Bibliotheken werden angezeigt', sourceTabsLabel: 'Bibliotheksquelle', versionLabel: 'Version',
}, {
  added: (name, source) => source === 'aily' ? `${name} wurde aus der Aily-Bibliothek installiert` : `${name} wurde unter sketch/libraries installiert`,
  removed: name => `${name} wurde aus dem Projekt deinstalliert`,
  failed: (action, source, detail) => `${action === 'load' ? `${source === 'aily' ? 'Aily' : 'Arduino'}-Bibliotheken konnten nicht geladen werden` : action === 'remove' ? 'Die Bibliothek konnte nicht deinstalliert werden' : 'Die Bibliothek konnte nicht installiert werden'}: ${detail}`,
})

const FR = localized({
  panelTitle: 'Gestionnaire de bibliothèques', ailyTab: 'Bibliothèques Aily', arduinoTab: 'Arduino officiel',
  searchAily: 'Rechercher dans les bibliothèques Aily', searchArduino: 'Rechercher dans les bibliothèques Arduino officielles', refresh: 'Actualiser',
  add: 'Installer', adding: 'Installation…', remove: 'Désinstaller', removing: 'Désinstallation…', installed: 'Dans le projet',
  loadingAily: 'Chargement des bibliothèques Aily…', loadingArduino: 'Chargement des bibliothèques Arduino…',
  emptyAily: 'Aucune bibliothèque Aily correspondante', emptyArduino: 'Aucune bibliothèque Arduino correspondante',
  unavailable: 'Le projet Coder n’est pas prêt.', toggle: 'Développer ou réduire la liste des bibliothèques',
  docs: 'Plus d’infos', ailySection: 'Bibliothèques Aily', arduinoSection: 'Bibliothèques Arduino officielles', close: 'Fermer la liste des bibliothèques',
  allTypes: 'Type : tous', allTopics: 'Sujet : tous', loadMore: 'Charger plus', loadingMore: 'Chargement…',
  compatible: 'Compatible', otherArchitecture: 'Autre architecture',
  resultUnit: 'bibliothèques', endOfResults: 'Toutes les bibliothèques correspondantes sont affichées', sourceTabsLabel: 'Source de la bibliothèque', versionLabel: 'version',
}, {
  added: (name, source) => source === 'aily' ? `${name} a été installée depuis Aily` : `${name} a été installée dans sketch/libraries`,
  removed: name => `${name} a été désinstallée du projet`,
  failed: (action, source, detail) => `${action === 'load' ? `Échec du chargement des bibliothèques ${source === 'aily' ? 'Aily' : 'Arduino'}` : action === 'remove' ? 'Échec de la désinstallation de la bibliothèque' : 'Échec de l’installation de la bibliothèque'} : ${detail}`,
})

const ES = localized({
  panelTitle: 'Gestor de bibliotecas', ailyTab: 'Bibliotecas Aily', arduinoTab: 'Arduino oficial',
  searchAily: 'Buscar bibliotecas Aily', searchArduino: 'Buscar bibliotecas oficiales de Arduino', refresh: 'Actualizar',
  add: 'Instalar', adding: 'Instalando…', remove: 'Desinstalar', removing: 'Desinstalando…', installed: 'En el proyecto',
  loadingAily: 'Cargando bibliotecas Aily…', loadingArduino: 'Cargando bibliotecas Arduino…',
  emptyAily: 'No hay bibliotecas Aily coincidentes', emptyArduino: 'No hay bibliotecas Arduino coincidentes',
  unavailable: 'El proyecto Coder aún no está listo.', toggle: 'Expandir o contraer la lista de bibliotecas',
  docs: 'Más información', ailySection: 'Bibliotecas Aily', arduinoSection: 'Bibliotecas oficiales de Arduino', close: 'Cerrar lista de bibliotecas',
  allTypes: 'Tipo: todos', allTopics: 'Tema: todos', loadMore: 'Cargar más', loadingMore: 'Cargando…',
  compatible: 'Compatible', otherArchitecture: 'Otra arquitectura',
  resultUnit: 'bibliotecas', endOfResults: 'Se muestran todas las bibliotecas coincidentes', sourceTabsLabel: 'Origen de la biblioteca', versionLabel: 'versión',
}, {
  added: (name, source) => source === 'aily' ? `${name} se instaló desde Aily` : `${name} se instaló en sketch/libraries`,
  removed: name => `${name} se desinstaló del proyecto`,
  failed: (action, source, detail) => `${action === 'load' ? `No se pudieron cargar las bibliotecas ${source === 'aily' ? 'Aily' : 'Arduino'}` : action === 'remove' ? 'No se pudo desinstalar la biblioteca' : 'No se pudo instalar la biblioteca'}: ${detail}`,
})

const PT = localized({
  panelTitle: 'Gerenciador de bibliotecas', ailyTab: 'Bibliotecas Aily', arduinoTab: 'Arduino oficial',
  searchAily: 'Pesquisar bibliotecas Aily', searchArduino: 'Pesquisar bibliotecas oficiais do Arduino', refresh: 'Atualizar',
  add: 'Instalar', adding: 'Instalando…', remove: 'Desinstalar', removing: 'Desinstalando…', installed: 'No projeto',
  loadingAily: 'Carregando bibliotecas Aily…', loadingArduino: 'Carregando bibliotecas Arduino…',
  emptyAily: 'Nenhuma biblioteca Aily correspondente', emptyArduino: 'Nenhuma biblioteca Arduino correspondente',
  unavailable: 'O projeto Coder ainda não está pronto.', toggle: 'Expandir ou recolher a lista de bibliotecas',
  docs: 'Mais informações', ailySection: 'Bibliotecas Aily', arduinoSection: 'Bibliotecas oficiais do Arduino', close: 'Fechar lista de bibliotecas',
  allTypes: 'Tipo: todos', allTopics: 'Tópico: todos', loadMore: 'Carregar mais', loadingMore: 'Carregando…',
  compatible: 'Compatível', otherArchitecture: 'Outra arquitetura',
  resultUnit: 'bibliotecas', endOfResults: 'Todas as bibliotecas correspondentes foram exibidas', sourceTabsLabel: 'Origem da biblioteca', versionLabel: 'versão',
}, {
  added: (name, source) => source === 'aily' ? `${name} foi instalada pela Aily` : `${name} foi instalada em sketch/libraries`,
  removed: name => `${name} foi desinstalada do projeto`,
  failed: (action, source, detail) => `${action === 'load' ? `Falha ao carregar bibliotecas ${source === 'aily' ? 'Aily' : 'Arduino'}` : action === 'remove' ? 'Falha ao desinstalar a biblioteca' : 'Falha ao instalar a biblioteca'}: ${detail}`,
})

const RU = localized({
  panelTitle: 'Менеджер библиотек', ailyTab: 'Библиотеки Aily', arduinoTab: 'Официальные Arduino',
  searchAily: 'Поиск библиотек Aily', searchArduino: 'Поиск официальных библиотек Arduino', refresh: 'Обновить',
  add: 'Установить', adding: 'Установка…', remove: 'Удалить', removing: 'Удаление…', installed: 'В проекте',
  loadingAily: 'Загрузка библиотек Aily…', loadingArduino: 'Загрузка библиотек Arduino…',
  emptyAily: 'Подходящие библиотеки Aily не найдены', emptyArduino: 'Подходящие библиотеки Arduino не найдены',
  unavailable: 'Проект Coder ещё не готов.', toggle: 'Развернуть или свернуть список библиотек',
  docs: 'Подробнее', ailySection: 'Библиотеки Aily', arduinoSection: 'Официальные библиотеки Arduino', close: 'Закрыть список библиотек',
  allTypes: 'Тип: все', allTopics: 'Тема: все', loadMore: 'Загрузить ещё', loadingMore: 'Загрузка…',
  compatible: 'Совместима', otherArchitecture: 'Другая архитектура',
  resultUnit: 'библиотек', endOfResults: 'Показаны все подходящие библиотеки', sourceTabsLabel: 'Источник библиотеки', versionLabel: 'версия',
}, {
  added: (name, source) => source === 'aily' ? `${name} установлена из Aily` : `${name} установлена в sketch/libraries`,
  removed: name => `${name} удалена из проекта`,
  failed: (action, source, detail) => `${action === 'load' ? `Не удалось загрузить библиотеки ${source === 'aily' ? 'Aily' : 'Arduino'}` : action === 'remove' ? 'Не удалось удалить библиотеку' : 'Не удалось установить библиотеку'}: ${detail}`,
})

const AR = localized({
  panelTitle: 'مدير المكتبات', ailyTab: 'مكتبات Aily', arduinoTab: 'Arduino الرسمية',
  searchAily: 'البحث في مكتبات Aily', searchArduino: 'البحث في مكتبات Arduino الرسمية', refresh: 'تحديث',
  add: 'تثبيت', adding: 'جارٍ التثبيت…', remove: 'إزالة', removing: 'جارٍ الإزالة…', installed: 'في المشروع',
  loadingAily: 'جارٍ تحميل مكتبات Aily…', loadingArduino: 'جارٍ تحميل مكتبات Arduino…',
  emptyAily: 'لا توجد مكتبات Aily مطابقة', emptyArduino: 'لا توجد مكتبات Arduino مطابقة',
  unavailable: 'مشروع Coder غير جاهز بعد.', toggle: 'توسيع قائمة المكتبات أو طيها',
  docs: 'مزيد من المعلومات', ailySection: 'مكتبات Aily', arduinoSection: 'مكتبات Arduino الرسمية', close: 'إغلاق قائمة المكتبات',
  allTypes: 'النوع: الكل', allTopics: 'الموضوع: الكل', loadMore: 'تحميل المزيد', loadingMore: 'جارٍ التحميل…',
  compatible: 'متوافقة', otherArchitecture: 'بنية أخرى',
  resultUnit: 'مكتبة', endOfResults: 'تم عرض جميع المكتبات المطابقة', sourceTabsLabel: 'مصدر المكتبة', versionLabel: 'الإصدار',
}, {
  added: (name, source) => source === 'aily' ? `تم تثبيت ${name} من Aily` : `تم تثبيت ${name} في sketch/libraries`,
  removed: name => `تمت إزالة ${name} من المشروع`,
  failed: (action, source, detail) => `${action === 'load' ? `تعذر تحميل مكتبات ${source === 'aily' ? 'Aily' : 'Arduino'}` : action === 'remove' ? 'تعذرت إزالة المكتبة' : 'تعذر تثبيت المكتبة'}: ${detail}`,
})

export function libraryStrings(language: unknown): UiStrings {
  switch (normalizeLibraryLanguage(language)) {
    case 'zh_cn': return ZH_CN
    case 'zh_hk': return ZH_HK
    case 'ja': return JA
    case 'ko': return KO
    case 'de': return DE
    case 'fr': return FR
    case 'es': return ES
    case 'pt': return PT
    case 'ru': return RU
    case 'ar': return AR
    default: return EN
  }
}
