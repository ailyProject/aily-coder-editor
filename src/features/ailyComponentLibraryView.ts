/** Coder-owned Arduino library browser shown in the right secondary side bar. */
import type * as vscode from 'vscode'
import { IWorkbenchLayoutService, StandaloneServices } from '@codingame/monaco-vscode-api'
import { Codicon } from '@codingame/monaco-vscode-api/vscode/vs/base/common/codicons'
import { MenuId, MenuRegistry } from '@codingame/monaco-vscode-api/vscode/vs/platform/actions/common/actions'
import { ContextKeyExpr } from '@codingame/monaco-vscode-api/vscode/vs/platform/contextkey/common/contextkey'
import { Parts } from '@codingame/monaco-vscode-workbench-service-override'
import { IViewsService } from '@codingame/monaco-vscode-api/vscode/vs/workbench/services/views/common/viewsService.service'

export const AILY_COMPONENT_LIBRARY_CONTAINER_ID = 'ailyComponentLibraries'
export const AILY_COMPONENT_LIBRARY_VIEW_ID = 'aily.componentLibraries'
const AILY_COMPONENT_LIBRARY_PANE_COMPOSITE_ID = `workbench.view.extension.${AILY_COMPONENT_LIBRARY_CONTAINER_ID}`

type LibrarySource = 'registry'
type LibraryEntry = {
  readonly id: string
  readonly source: LibrarySource
  readonly folderName: string
  readonly sdkLabel: string
  readonly name: string
  readonly version: string
  readonly versions: readonly string[]
  readonly author: string
  readonly maintainer: string
  readonly sentence: string
  readonly paragraph: string
  readonly category: string
  readonly url: string
  readonly architectures: readonly string[]
  readonly types?: readonly string[]
  readonly compatible?: boolean
  readonly installed: boolean
  readonly installedVersion?: string
}

type ApiResponse = {
  readonly ok?: boolean
  readonly error?: string
  readonly libraries?: readonly LibraryEntry[]
  readonly library?: LibraryEntry
  readonly total?: number
  readonly categories?: readonly string[]
  readonly types?: readonly string[]
}

type UiStrings = {
  readonly search: string
  readonly refresh: string
  readonly hint: string
  readonly add: string
  readonly adding: string
  readonly installed: string
  readonly loading: string
  readonly empty: string
  readonly unavailable: string
  readonly docs: string
  readonly registrySection: string
  readonly close: string
  readonly allTypes: string
  readonly allTopics: string
  readonly loadMore: string
  readonly loadingMore: string
  readonly compatible: string
  readonly otherArchitecture: string
  readonly registrySource: string
  readonly resultUnit: string
  readonly endOfResults: string
  added(name: string): string
  failed(action: 'load' | 'install', detail: string): string
}

const EN: UiStrings = {
  search: 'Search all Arduino libraries',
  refresh: 'Refresh',
  hint: 'The complete official Arduino Library Manager index. Installs are project-local under sketch/libraries.',
  add: 'Install', adding: 'Installing…', installed: 'In Project',
  loading: 'Loading Arduino libraries…', empty: 'No matching Arduino libraries',
  unavailable: 'The active Coder project is not ready.', docs: 'More info',
  registrySection: 'Arduino Library Manager', close: 'Close library manager',
  allTypes: 'Type: All', allTopics: 'Topic: All', loadMore: 'Load more', loadingMore: 'Loading…',
  compatible: 'Compatible', otherArchitecture: 'Other architecture',
  registrySource: 'Arduino Library Manager', resultUnit: 'libraries', endOfResults: 'All matching libraries are shown',
  added: name => `${name} was installed under sketch/libraries`,
  failed: (action, detail) => `${action === 'load' ? 'Failed to load Arduino libraries' : 'Failed to install the library'}: ${detail}`
}

const ZH_CN: UiStrings = {
  search: '搜索全部 Arduino 公共库', refresh: '刷新',
  hint: 'Arduino Library Manager 官方完整索引；安装由 Coder 写入当前工程 sketch/libraries。',
  add: '安装', adding: '正在安装…', installed: '已在工程中',
  loading: '正在加载 Arduino 公共库…', empty: '没有匹配的 Arduino 公共库',
  unavailable: '当前 Coder 工程尚未就绪。', docs: '更多信息',
  registrySection: 'Arduino Library Manager', close: '关闭公共库面板',
  allTypes: '类型：全部', allTopics: '主题：全部', loadMore: '加载更多', loadingMore: '加载中…',
  compatible: '兼容当前平台', otherArchitecture: '其他架构',
  registrySource: 'Arduino Library Manager', resultUnit: '个库', endOfResults: '已显示全部匹配库',
  added: name => `${name} 已安装到 sketch/libraries`,
  failed: (action, detail) => `${action === 'load' ? '加载 Arduino 公共库失败' : '安装公共库失败'}：${detail}`
}

function strings(language: string): UiStrings {
  return language.toLowerCase().startsWith('zh') ? ZH_CN : EN
}

async function callApi(
  action: 'search' | 'install',
  body: Record<string, unknown>
): Promise<ApiResponse> {
  const response = await fetch(`/api/component-libraries/${action}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  })
  const payload = (await response.json().catch(() => ({}))) as ApiResponse
  if (!response.ok || payload.ok !== true) {
    throw new Error(payload.error?.trim() || `${action} failed`)
  }
  return payload
}

function workspaceRoot(vscodeApi: typeof vscode): string | undefined {
  const workspacePath = vscodeApi.workspace.workspaceFolders?.[0]?.uri.fsPath.trim()
  if (workspacePath) return workspacePath
  try {
    return new URL(window.location.href).searchParams.get('folder')?.trim() || undefined
  } catch {
    return undefined
  }
}

function nonce(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  return [...crypto.getRandomValues(new Uint8Array(24))]
    .map(value => alphabet[value % alphabet.length]).join('')
}

function webviewHtml(webview: vscode.Webview, copy: UiStrings): string {
  const scriptNonce = nonce()
  const serializedCopy = JSON.stringify(copy).replace(/</gu, '\\u003c')
  return `<!doctype html>
<html lang="en"><head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${scriptNonce}';">
  <style>
    *{box-sizing:border-box}[hidden]{display:none!important}body{margin:0;color:var(--vscode-foreground);background:var(--vscode-sideBar-background);font:13px/1.45 var(--vscode-font-family)}
    .toolbar{position:sticky;z-index:3;top:0;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:6px;padding:10px;border-bottom:1px solid var(--vscode-panel-border);background:var(--vscode-sideBar-background,#1f1f1f)}
    .filters{grid-column:1/-1;display:grid;grid-template-columns:1fr 1fr;gap:6px} input,select{min-width:0;height:28px;padding:3px 7px;border:1px solid var(--vscode-input-border,transparent);outline:none;color:var(--vscode-input-foreground);background:var(--vscode-input-background);font:inherit} input:focus,select:focus{border-color:var(--vscode-focusBorder)}
    button{min-height:28px;padding:3px 9px;border:1px solid var(--vscode-button-border,transparent);border-radius:2px;color:var(--vscode-button-foreground);background:var(--vscode-button-background);font:inherit;cursor:pointer} button:hover:not(:disabled){background:var(--vscode-button-hoverBackground)} button:disabled{cursor:default;opacity:.62} button.secondary{color:var(--vscode-button-secondaryForeground);background:var(--vscode-button-secondaryBackground)}
    .hint,.notice{margin:0;padding:8px 10px;border-bottom:1px solid var(--vscode-panel-border);color:var(--vscode-descriptionForeground);font-size:11px}.notice{color:var(--vscode-notificationsInfoIcon-foreground)}.notice.error{color:var(--vscode-errorForeground)}
    .section-title{position:sticky;z-index:2;top:85px;display:flex;justify-content:space-between;gap:8px;padding:7px 10px;border-block:1px solid var(--vscode-panel-border);box-shadow:0 2px 5px rgba(0,0,0,.24);color:var(--vscode-sideBarSectionHeader-foreground,var(--vscode-foreground));background:var(--vscode-sideBar-background,#1f1f1f);font-size:11px;font-weight:600;text-transform:uppercase;isolation:isolate}
    .list{display:grid;gap:8px;padding:8px 10px 12px}.card{min-width:0;padding:10px;border:1px solid var(--vscode-panel-border);border-radius:4px;background:var(--vscode-editorWidget-background,var(--vscode-editor-background))}.card.installed{border-color:var(--vscode-testing-iconPassed)}
    .title-row,.footer{display:flex;align-items:center;justify-content:space-between;gap:7px}.title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}.version-select{width:auto;min-width:70px;max-width:104px;height:24px;padding:1px 22px 1px 6px;border-color:var(--vscode-dropdown-border,var(--vscode-input-border));color:var(--vscode-dropdown-foreground,var(--vscode-input-foreground));background:var(--vscode-dropdown-background,var(--vscode-input-background));font-size:11px;cursor:pointer}.version-select:disabled{cursor:default;opacity:.72}.meta,.source{color:var(--vscode-descriptionForeground);font-size:11px}.description{display:-webkit-box;overflow:hidden;margin:7px 0;-webkit-box-orient:vertical;-webkit-line-clamp:3;font-size:12px}
    .chips{display:flex;flex-wrap:wrap;gap:4px;margin-bottom:8px}.chip{padding:1px 5px;border-radius:999px;color:var(--vscode-badge-foreground);background:var(--vscode-badge-background);font-size:10px}.chip.compatible{color:var(--vscode-testing-iconPassed);background:color-mix(in srgb,var(--vscode-testing-iconPassed) 14%,transparent)}.chip.incompatible{color:var(--vscode-descriptionForeground);background:transparent;border:1px solid var(--vscode-panel-border)}
    .footer{padding-top:8px;border-top:1px solid var(--vscode-panel-border)}.source{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.actions{display:flex;flex:none;align-items:center;gap:4px}a{padding:4px;color:var(--vscode-textLink-foreground);cursor:pointer}.empty{padding:38px 12px;color:var(--vscode-descriptionForeground);text-align:center}.more{display:block;margin:0 auto 12px}.paging-status{display:flex;align-items:center;gap:8px;margin:0 10px 12px;color:var(--vscode-descriptionForeground);font-size:11px;text-align:center}.paging-status::before,.paging-status::after{height:1px;content:'';background:var(--vscode-panel-border);flex:1}
  </style>
</head><body>
  <header class="toolbar"><input id="search" type="search"><button id="refresh" class="secondary" type="button"></button><div class="filters"><select id="type"></select><select id="category"></select></div></header>
  <p id="hint" class="hint"></p><p id="notice" class="notice" hidden></p>
  <section><div class="section-title"><span id="registry-title"></span><span id="registry-count"></span></div><div id="registry-list" class="list"></div><button id="more" class="secondary more" type="button" hidden></button><div id="paging-status" class="paging-status" hidden></div></section>
  <script nonce="${scriptNonce}">
    const vscode=acquireVsCodeApi(),copy=${serializedCopy};
    const search=document.getElementById('search'),refresh=document.getElementById('refresh'),type=document.getElementById('type'),category=document.getElementById('category'),notice=document.getElementById('notice'),registryList=document.getElementById('registry-list'),registryCount=document.getElementById('registry-count'),more=document.getElementById('more'),pagingStatus=document.getElementById('paging-status');
    let state={registryLibraries:[],total:0,categories:[],types:[],loadingRegistry:true,loadingMore:false,hasMore:false,installing:[],notice:null},searchTimer;
    search.placeholder=copy.search;refresh.textContent=copy.refresh;document.getElementById('hint').textContent=copy.hint;document.getElementById('registry-title').textContent=copy.registrySection;more.textContent=copy.loadMore;pagingStatus.textContent=copy.endOfResults;
    const text=(tag,className,value)=>{const element=document.createElement(tag);element.className=className;element.textContent=value;return element};
    function setOptions(select,values,allLabel){const selected=select.value;select.replaceChildren();const all=document.createElement('option');all.value='';all.textContent=allLabel;select.appendChild(all);for(const value of values){const option=document.createElement('option');option.value=value;option.textContent=value;select.appendChild(option)}select.value=values.includes(selected)?selected:''}
    function card(library){
      const card=document.createElement('article');card.className='card'+(library.installed?' installed':'');
      const titleRow=document.createElement('div');titleRow.className='title-row';const title=text('div','title',library.name||library.folderName);title.title=library.name||library.folderName;
      const version=document.createElement('select');version.className='version-select';version.setAttribute('aria-label',(library.name||library.folderName)+' version');for(const item of library.versions.length?library.versions:[library.version||'Arduino']){const option=document.createElement('option');option.value=item;option.textContent=item;option.selected=item===library.version;version.appendChild(option)}version.disabled=library.versions.length<2;version.addEventListener('change',()=>vscode.postMessage({type:'selectVersion',libraryId:library.id,version:version.value}));titleRow.append(title,version);
      card.append(titleRow,text('div','meta',library.author||library.maintainer||library.sdkLabel),text('p','description',library.sentence||library.paragraph||library.folderName));
      const chips=document.createElement('div');chips.className='chips';if(library.source==='registry')chips.appendChild(text('span','chip '+(library.compatible?'compatible':'incompatible'),library.compatible?copy.compatible:copy.otherArchitecture));for(const value of [library.category,...library.architectures].filter(Boolean).slice(0,5))chips.appendChild(text('span','chip',value));card.appendChild(chips);
      const footer=document.createElement('footer');footer.className='footer';footer.appendChild(text('code','source',library.folderName?'sketch/libraries/'+library.folderName:copy.registrySource));const actions=document.createElement('div');actions.className='actions';if(/^https?:\\/\\//iu.test(library.url)){const docs=text('a','',copy.docs);docs.tabIndex=0;docs.addEventListener('click',()=>vscode.postMessage({type:'openUrl',url:library.url}));actions.appendChild(docs)}const installing=state.installing.includes(library.id),installedLabel=library.installedVersion?copy.installed+' '+library.installedVersion:copy.installed,install=text('button',library.installed?'secondary':'',library.installed?installedLabel:installing?copy.adding:copy.add);install.type='button';install.disabled=library.installed||installing;install.addEventListener('click',()=>vscode.postMessage({type:'install',libraryId:library.id,source:library.source,version:version.value}));actions.appendChild(install);footer.appendChild(actions);card.appendChild(footer);return card;
    }
    function render(){
      const busy=state.loadingRegistry||state.loadingMore,filtered=Boolean(search.value.trim()||type.value||category.value);refresh.disabled=busy;notice.hidden=!state.notice;notice.classList.toggle('error',state.notice?.error===true);notice.textContent=state.notice?.text||'';setOptions(type,state.types,copy.allTypes);setOptions(category,state.categories,copy.allTopics);
      registryCount.textContent=state.registryLibraries.length+' / '+state.total+' '+copy.resultUnit;registryList.replaceChildren();if(state.loadingRegistry&&state.registryLibraries.length===0)registryList.appendChild(text('div','empty',copy.loading));else if(state.registryLibraries.length===0)registryList.appendChild(text('div','empty',copy.empty));else for(const library of state.registryLibraries)registryList.appendChild(card(library));more.hidden=!state.hasMore&&!state.loadingMore;more.disabled=busy;more.textContent=state.loadingMore?copy.loadingMore:copy.loadMore;pagingStatus.hidden=busy||!filtered||state.registryLibraries.length===0||state.hasMore;
    }
    function requestSearch(){more.hidden=true;pagingStatus.hidden=true;clearTimeout(searchTimer);searchTimer=setTimeout(()=>vscode.postMessage({type:'search',query:search.value,category:category.value,libraryType:type.value}),250)}
    search.addEventListener('input',requestSearch);type.addEventListener('change',requestSearch);category.addEventListener('change',requestSearch);refresh.addEventListener('click',()=>vscode.postMessage({type:'refresh'}));more.addEventListener('click',()=>vscode.postMessage({type:'loadMore'}));window.addEventListener('message',event=>{if(event.data?.type==='state'){state=event.data.state;render()}});render();vscode.postMessage({type:'ready'});
  </script>
</body></html>`
}

type ViewState = {
  readonly registryLibraries: readonly LibraryEntry[]
  readonly total: number
  readonly categories: readonly string[]
  readonly types: readonly string[]
  readonly loadingRegistry: boolean
  readonly loadingMore: boolean
  readonly hasMore: boolean
  readonly installing: readonly string[]
  readonly notice: { readonly text: string; readonly error?: boolean } | null
}

type WebviewMessage =
  | { readonly type: 'ready' | 'refresh' | 'loadMore' }
  | { readonly type: 'search'; readonly query?: string; readonly category?: string; readonly libraryType?: string }
  | { readonly type: 'selectVersion'; readonly libraryId?: string; readonly version?: string }
  | { readonly type: 'install'; readonly libraryId?: string; readonly source?: LibrarySource; readonly version?: string }
  | { readonly type: 'openUrl'; readonly url?: string }

class ComponentLibraryViewProvider implements vscode.WebviewViewProvider {
  #view?: vscode.WebviewView
  #registryLibraries: readonly LibraryEntry[] = []
  #total = 0
  #categories: readonly string[] = []
  #types: readonly string[] = []
  #loadingRegistry = false
  #loadingMore = false
  #hasMore = false
  #installing = new Set<string>()
  #notice: ViewState['notice'] = null
  #query = ''
  #category = ''
  #libraryType = ''
  #searchGeneration = 0

  constructor(private readonly vscodeApi: typeof vscode) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.#view = view
    view.webview.options = { enableScripts: true }
    view.webview.html = webviewHtml(view.webview, strings(this.vscodeApi.env.language))
    view.webview.onDidReceiveMessage((message: WebviewMessage) => {
      if (message.type === 'ready' || message.type === 'refresh') void this.refresh(message.type === 'refresh')
      else if (message.type === 'search') {
        this.#query = message.query?.trim() ?? ''
        this.#category = message.category?.trim() ?? ''
        this.#libraryType = message.libraryType?.trim() ?? ''
        void this.#searchRegistry(true)
      } else if (message.type === 'loadMore') void this.#searchRegistry(false)
      else if (message.type === 'selectVersion' && message.libraryId && message.version) {
        this.#registryLibraries = this.#registryLibraries.map(item => item.id === message.libraryId && item.versions.includes(message.version!) ? { ...item, version: message.version! } : item)
      } else if (message.type === 'install' && message.libraryId && message.source && message.version) void this.#install(message.libraryId, message.source, message.version)
      else if (message.type === 'openUrl' && /^https?:\/\//iu.test(message.url ?? '')) void this.vscodeApi.env.openExternal(this.vscodeApi.Uri.parse(message.url!))
    })
  }

  #sendState(): void {
    void this.#view?.webview.postMessage({ type: 'state', state: {
      registryLibraries: this.#registryLibraries,
      total: this.#total, categories: this.#categories, types: this.#types,
      loadingRegistry: this.#loadingRegistry,
      loadingMore: this.#loadingMore, hasMore: this.#hasMore,
      installing: [...this.#installing], notice: this.#notice
    } satisfies ViewState })
  }

  async refresh(forceRefresh = false): Promise<void> {
    const root = workspaceRoot(this.vscodeApi)
    if (!root) {
      this.#registryLibraries = []
      this.#notice = { text: strings(this.vscodeApi.env.language).unavailable, error: true }
      this.#sendState(); return
    }
    this.#notice = null; this.#sendState()
    await this.#searchRegistry(true, forceRefresh)
  }

  async #searchRegistry(reset: boolean, forceRefresh = false): Promise<void> {
    const root = workspaceRoot(this.vscodeApi)
    if (!root || (this.#loadingMore && !reset)) return
    const generation = ++this.#searchGeneration
    const offset = reset ? 0 : this.#registryLibraries.length
    this.#loadingRegistry = reset
    this.#loadingMore = !reset
    if (reset) { this.#registryLibraries = []; this.#hasMore = false }
    this.#sendState()
    try {
      const response = await callApi('search', { workspaceRoot: root, query: this.#query, category: this.#category, type: this.#libraryType, offset, limit: 50, forceRefresh })
      if (generation !== this.#searchGeneration) return
      const page = response.libraries ?? []
      this.#registryLibraries = reset ? page : [...this.#registryLibraries, ...page]
      this.#total = response.total ?? this.#registryLibraries.length
      this.#hasMore = page.length > 0 && this.#registryLibraries.length < this.#total
      this.#categories = response.categories ?? this.#categories
      this.#types = response.types ?? this.#types
    } catch (error) {
      if (generation !== this.#searchGeneration) return
      if (reset) this.#registryLibraries = []
      this.#notice = { text: strings(this.vscodeApi.env.language).failed('load', error instanceof Error ? error.message : String(error)), error: true }
    } finally {
      if (generation === this.#searchGeneration) { this.#loadingRegistry = false; this.#loadingMore = false; this.#sendState() }
    }
  }

  async #install(libraryId: string, source: LibrarySource, version: string): Promise<void> {
    const root = workspaceRoot(this.vscodeApi)
    const library = this.#registryLibraries.find(item => item.id === libraryId)
    if (!root || !library || library.installed || this.#installing.has(libraryId)) return
    this.#installing.add(libraryId); this.#notice = null; this.#sendState()
    try {
      const response = await callApi('install', { workspaceRoot: root, libraryId, source, version })
      const update = (item: LibraryEntry): LibraryEntry => item.id === libraryId ? { ...item, ...response.library, installed: true, installedVersion: version } : item
      this.#registryLibraries = this.#registryLibraries.map(update)
      this.#notice = { text: strings(this.vscodeApi.env.language).added(library.name || library.folderName) }
    } catch (error) {
      this.#notice = { text: strings(this.vscodeApi.env.language).failed('install', error instanceof Error ? error.message : String(error)), error: true }
    } finally {
      this.#installing.delete(libraryId); this.#sendState()
    }
  }
}

export type ComponentLibraryViewRegistration = vscode.Disposable & { refresh(): Promise<void> }

export function registerAilyComponentLibraryView(vscodeApi: typeof vscode): ComponentLibraryViewRegistration {
  const provider = new ComponentLibraryViewProvider(vscodeApi)
  const registration = vscodeApi.window.registerWebviewViewProvider(AILY_COMPONENT_LIBRARY_VIEW_ID, provider, { webviewOptions: { retainContextWhenHidden: true } })
  const closeMenuItem = MenuRegistry.appendMenuItem(MenuId.AuxiliaryBarTitle, {
    command: {
      id: 'workbench.action.closeAuxiliaryBar',
      title: strings(vscodeApi.env.language).close,
      icon: Codicon.close
    },
    group: 'navigation',
    order: 2,
    when: ContextKeyExpr.and(
      ContextKeyExpr.equals('activeAuxiliary', AILY_COMPONENT_LIBRARY_PANE_COMPOSITE_ID),
      ContextKeyExpr.notEquals('config.workbench.activityBar.location', 'default')
    )
  })
  return { dispose: () => { registration.dispose(); closeMenuItem.dispose() }, refresh: () => provider.refresh() }
}

export async function openAilyComponentLibraryPanel(): Promise<void> {
  StandaloneServices.get(IWorkbenchLayoutService).setPartHidden(false, Parts.AUXILIARYBAR_PART)
  await StandaloneServices.get(IViewsService).openView(AILY_COMPONENT_LIBRARY_VIEW_ID, true)
}
