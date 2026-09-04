/** Coder-owned Aily/Arduino library browser shown in the right secondary side bar. */
import type * as vscode from 'vscode'
import { IWorkbenchLayoutService, StandaloneServices } from '@codingame/monaco-vscode-api'
import { Codicon } from '@codingame/monaco-vscode-api/vscode/vs/base/common/codicons'
import { MenuId, MenuRegistry } from '@codingame/monaco-vscode-api/vscode/vs/platform/actions/common/actions'
import { ContextKeyExpr } from '@codingame/monaco-vscode-api/vscode/vs/platform/contextkey/common/contextkey'
import { Parts } from '@codingame/monaco-vscode-workbench-service-override'
import { IViewsService } from '@codingame/monaco-vscode-api/vscode/vs/workbench/services/views/common/viewsService.service'
import {
  getHostEmbedContext,
  onHostEmbedContextChanged,
} from '../hostEmbedContext.js'
import {
  normalizeLibraryLanguage,
} from './ailyComponentLibraryModel.js'
import {
  libraryStrings,
  type LibrarySource,
  type UiStrings
} from './ailyComponentLibraryI18n.js'

export const AILY_COMPONENT_LIBRARY_CONTAINER_ID = 'ailyComponentLibraries'
export const AILY_COMPONENT_LIBRARY_VIEW_ID = 'aily.componentLibraries'
const AILY_COMPONENT_LIBRARY_PANE_COMPOSITE_ID = `workbench.view.extension.${AILY_COMPONENT_LIBRARY_CONTAINER_ID}`

type LibraryEntry = {
  readonly id: string
  readonly source: LibrarySource
  readonly packageName?: string
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
  readonly compatibility?: CompatibilityDetails
  readonly installed: boolean
  readonly installedVersion?: string
  readonly managed?: boolean
}

type CompatibleAlternative = {
  readonly name?: string
  readonly version?: string
}

type CompatibilityDetails = {
  readonly supportedArchitectures?: readonly string[]
  readonly activeArchitectures?: readonly string[]
  readonly compatibleAlternatives?: readonly CompatibleAlternative[]
}

type ApiResponse = {
  readonly ok?: boolean
  readonly error?: string
  readonly errorCode?: string
  readonly details?: CompatibilityDetails
  readonly libraries?: readonly LibraryEntry[]
  readonly library?: Partial<LibraryEntry>
  readonly total?: number
  readonly categories?: readonly string[]
  readonly types?: readonly string[]
}

class ComponentLibraryApiError extends Error {
  constructor(
    message: string,
    readonly errorCode = '',
    readonly details?: CompatibilityDetails,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'ComponentLibraryApiError'
  }
}

async function callApi(
  action: 'search' | 'install' | 'remove',
  body: Record<string, unknown>
): Promise<ApiResponse> {
  const response = await fetch(`/api/component-libraries/${action}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  })
  const responseText = await response.text()
  let payload: ApiResponse = {}
  try {
    payload = JSON.parse(responseText) as ApiResponse
  } catch {
    payload = {}
  }
  if (!response.ok || payload.ok !== true) {
    const readableBody = responseText.trim().replace(/\s+/gu, ' ').slice(0, 500)
    const errorCode = payload.errorCode?.trim() ?? ''
    const diagnostics = [response.status ? `HTTP ${response.status}` : '', errorCode].filter(Boolean)
    const detail = payload.error?.trim()
      || readableBody
      || `${action} failed`
    throw new ComponentLibraryApiError(
      `${diagnostics.length > 0 ? `[${diagnostics.join(' / ')}] ` : ''}${detail}`,
      errorCode,
      payload.details,
      response.status,
    )
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

function webviewHtml(webview: vscode.Webview, copy: UiStrings, language: string): string {
  const scriptNonce = nonce()
  const serializedCopy = JSON.stringify(copy).replace(/</gu, '\\u003c')
  const normalizedLanguage = normalizeLibraryLanguage(language)
  const direction = normalizedLanguage === 'ar' ? 'rtl' : 'ltr'
  return `<!doctype html>
<html lang="${normalizedLanguage.replace('_', '-')}" dir="${direction}"><head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${scriptNonce}';">
  <style>
    *{box-sizing:border-box}[hidden]{display:none!important}body{--panel-gutter:0px;margin:0;color:var(--vscode-foreground);background:var(--vscode-sideBar-background);font:13px/1.45 var(--vscode-font-family)}
    .source-tabs{position:sticky;z-index:4;top:0;display:grid;grid-template-columns:1fr 1fr;padding:6px 0 0;border-bottom:1px solid var(--vscode-panel-border);background:var(--vscode-sideBar-background,#1f1f1f)}.source-tab{position:relative;display:flex;align-items:center;justify-content:center;gap:6px;min-width:0;padding:7px var(--panel-gutter) 8px;border:0;border-radius:0;color:var(--vscode-descriptionForeground);background:transparent;font-weight:600;white-space:nowrap}.source-tab:hover{color:var(--vscode-foreground);background:var(--vscode-list-hoverBackground)}.source-tab[aria-selected="true"]{color:var(--vscode-foreground)}.source-tab[aria-selected="true"]::after{position:absolute;right:0;bottom:-1px;left:0;height:2px;content:'';background:var(--vscode-focusBorder)}.tab-icon{width:14px;height:14px;flex:none;fill:none;stroke:currentColor;stroke-linecap:round;stroke-linejoin:round;stroke-width:1.35}.tab-icon.aily{fill:currentColor;stroke:none}
    .toolbar{position:sticky;z-index:3;top:35px;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:6px;padding:8px var(--panel-gutter);border-bottom:1px solid var(--vscode-panel-border);background:var(--vscode-sideBar-background,#1f1f1f)}
    .filters{grid-column:1/-1;display:grid;grid-template-columns:1fr 1fr;gap:6px}input,select{min-width:0;height:28px;padding:3px 7px;border:1px solid var(--vscode-input-border,transparent);outline:none;color:var(--vscode-input-foreground);background:var(--vscode-input-background);font:inherit}input:focus,select:focus{border-color:var(--vscode-focusBorder)}
    button{min-height:28px;padding:3px 9px;border:1px solid var(--vscode-button-border,transparent);border-radius:2px;color:var(--vscode-button-foreground);background:var(--vscode-button-background);font:inherit;cursor:pointer}button:hover:not(:disabled){background:var(--vscode-button-hoverBackground)}button:disabled{cursor:default;opacity:.62}button.secondary{color:var(--vscode-button-secondaryForeground);background:var(--vscode-button-secondaryBackground)}
    .notice{margin:0;padding:8px var(--panel-gutter);border-bottom:1px solid var(--vscode-panel-border);color:var(--vscode-notificationsInfoIcon-foreground);font-size:11px}.notice.error{color:var(--vscode-errorForeground)}
    .section-title{display:flex;justify-content:space-between;gap:8px;padding:7px var(--panel-gutter);border-bottom:1px solid var(--vscode-panel-border);color:var(--vscode-sideBarSectionHeader-foreground,var(--vscode-foreground));background:var(--vscode-sideBar-background,#1f1f1f);font-size:11px;font-weight:600;text-transform:uppercase}
    .list{display:grid;gap:8px;padding:8px var(--panel-gutter) 12px}.card{min-width:0;padding:10px;border:1px solid var(--vscode-panel-border);border-radius:4px;background:var(--vscode-editorWidget-background,var(--vscode-editor-background))}.card.installed{border-color:var(--vscode-testing-iconPassed)}
    .title-row,.footer{display:flex;align-items:center;gap:7px}.title-row{justify-content:space-between}.title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}.version-select{width:auto;min-width:70px;max-width:104px;height:24px;padding:1px 22px 1px 6px;border-color:var(--vscode-dropdown-border,var(--vscode-input-border));color:var(--vscode-dropdown-foreground,var(--vscode-input-foreground));background:var(--vscode-dropdown-background,var(--vscode-input-background));font-size:11px;cursor:pointer}.version-select:disabled{cursor:default;opacity:.72}.meta{color:var(--vscode-descriptionForeground);font-size:11px}.description{display:-webkit-box;overflow:hidden;margin:7px 0;-webkit-box-orient:vertical;-webkit-line-clamp:3;font-size:12px}
    .chips{display:flex;flex-wrap:wrap;gap:4px;margin-bottom:8px}.chip{padding:1px 5px;border-radius:999px;color:var(--vscode-badge-foreground);background:var(--vscode-badge-background);font-size:10px}.chip.compatible{color:var(--vscode-testing-iconPassed);background:color-mix(in srgb,var(--vscode-testing-iconPassed) 14%,transparent)}.chip.incompatible{color:var(--vscode-descriptionForeground);background:transparent;border:1px solid var(--vscode-panel-border)}
    .footer{justify-content:space-between;padding-top:8px;border-top:1px solid var(--vscode-panel-border)}.actions{display:flex;flex:none;align-items:center;gap:4px;margin-inline-start:auto}a{padding:4px;color:var(--vscode-textLink-foreground);cursor:pointer}.empty{padding:38px 12px;color:var(--vscode-descriptionForeground);text-align:center}.more{display:block;margin:0 auto 12px}.paging-status{display:flex;align-items:center;gap:8px;margin:0 var(--panel-gutter) 12px;color:var(--vscode-descriptionForeground);font-size:11px;text-align:center}.paging-status::before,.paging-status::after{height:1px;content:'';background:var(--vscode-panel-border);flex:1}
  </style>
</head><body>
  <nav class="source-tabs">
    <button id="aily-tab" class="source-tab" type="button"><svg class="tab-icon aily" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.25 9.45 5.55 13.75 7 9.45 8.45 8 12.75 6.55 8.45 2.25 7l4.3-1.45L8 1.25Z"/><path d="m12.25 11 .55 1.7 1.7.55-1.7.55-.55 1.7-.55-1.7-1.7-.55 1.7-.55.55-1.7Z"/></svg><span id="aily-tab-label"></span></button>
    <button id="arduino-tab" class="source-tab" type="button"><svg class="tab-icon" viewBox="0 0 16 16" aria-hidden="true"><rect x="1.75" y="3.25" width="12.5" height="9.5" rx="2"/><path d="M4.25 8h3.5m-1.75-1.75v3.5M9.5 6.75h2.25m-2.25 2.5h2.25"/></svg><span id="arduino-tab-label"></span></button>
  </nav>
  <header class="toolbar"><input id="search" type="search"><button id="refresh" class="secondary" type="button"></button><div id="filters" class="filters"><select id="type"></select><select id="category"></select></div></header>
  <p id="notice" class="notice" hidden></p>
  <section><div class="section-title"><span id="section-title"></span><span id="library-count"></span></div><div id="library-list" class="list"></div><button id="more" class="secondary more" type="button" hidden></button><div id="paging-status" class="paging-status" hidden></div></section>
  <script nonce="${scriptNonce}">
    const vscode=acquireVsCodeApi(),copy=${serializedCopy};
    const sourceTabs=document.querySelector('.source-tabs'),ailyTab=document.getElementById('aily-tab'),arduinoTab=document.getElementById('arduino-tab'),ailyTabLabel=document.getElementById('aily-tab-label'),arduinoTabLabel=document.getElementById('arduino-tab-label'),search=document.getElementById('search'),refresh=document.getElementById('refresh'),filters=document.getElementById('filters'),type=document.getElementById('type'),category=document.getElementById('category'),notice=document.getElementById('notice'),sectionTitle=document.getElementById('section-title'),libraryList=document.getElementById('library-list'),libraryCount=document.getElementById('library-count'),more=document.getElementById('more'),pagingStatus=document.getElementById('paging-status');
    let state={activeSource:'aily',query:'',libraries:[],total:0,categories:[],types:[],loading:true,loadingMore:false,hasMore:false,installing:[],removing:[],notice:null},searchTimer;
    sourceTabs.setAttribute('aria-label',copy.sourceTabsLabel);ailyTabLabel.textContent=copy.ailyTab;arduinoTabLabel.textContent=copy.arduinoTab;refresh.textContent=copy.refresh;more.textContent=copy.loadMore;pagingStatus.textContent=copy.endOfResults;
    const text=(tag,className,value)=>{const element=document.createElement(tag);element.className=className;element.textContent=value;return element};
    function setOptions(select,values,allLabel){const selected=select.value;select.replaceChildren();const all=document.createElement('option');all.value='';all.textContent=allLabel;select.appendChild(all);for(const value of values){const option=document.createElement('option');option.value=value;option.textContent=value;select.appendChild(option)}select.value=values.includes(selected)?selected:''}
    function card(library){
      const card=document.createElement('article');card.className='card'+(library.installed?' installed':'');
      const titleRow=document.createElement('div');titleRow.className='title-row';const title=text('div','title',library.name||library.folderName);title.title=library.name||library.folderName;
      const versions=library.versions?.length?library.versions:[library.version||(library.source==='aily'?'latest':'Arduino')],version=document.createElement('select'),displayVersion=library.installedVersion||library.version;version.className='version-select';version.setAttribute('aria-label',(library.name||library.folderName)+' '+copy.versionLabel);for(const item of versions){const option=document.createElement('option');option.value=item;option.textContent=item;option.selected=item===displayVersion;version.appendChild(option)}const installing=state.installing.includes(library.id),removing=state.removing.includes(library.id),mutating=installing||removing;version.disabled=library.installed||mutating||versions.length<2;version.addEventListener('change',()=>vscode.postMessage({type:'selectVersion',libraryId:library.id,version:version.value}));titleRow.append(title,version);
      card.appendChild(titleRow);const metadata=library.author||library.maintainer;if(metadata)card.appendChild(text('div','meta',metadata));card.appendChild(text('p','description',library.sentence||library.paragraph||library.packageName||library.folderName));
      const chips=document.createElement('div');chips.className='chips';if(typeof library.compatible==='boolean')chips.appendChild(text('span','chip '+(library.compatible?'compatible':'incompatible'),library.compatible?copy.compatible:copy.otherArchitecture));for(const value of [library.category,...(library.architectures||[])].filter(Boolean).slice(0,5))chips.appendChild(text('span','chip',value));if(chips.childElementCount>0)card.appendChild(chips);
      const footer=document.createElement('footer');footer.className='footer';if(/^https?:\\/\\//iu.test(library.url)){const docs=text('a','',copy.docs);docs.tabIndex=0;docs.addEventListener('click',()=>vscode.postMessage({type:'openUrl',url:library.url}));footer.appendChild(docs)}const actions=document.createElement('div');actions.className='actions';const installedLabel=library.installedVersion?copy.installed+' '+library.installedVersion:copy.installed;if(library.installed&&library.managed){const remove=text('button','secondary',removing?copy.removing:copy.remove);remove.type='button';remove.disabled=mutating;remove.addEventListener('click',()=>vscode.postMessage({type:'remove',libraryId:library.id,source:library.source,version:library.installedVersion||version.value}));actions.appendChild(remove)}else{const install=text('button',library.installed?'secondary':'',library.installed?installedLabel:installing?copy.adding:copy.add);install.type='button';install.disabled=library.installed||mutating;install.addEventListener('click',()=>vscode.postMessage({type:'install',libraryId:library.id,source:library.source,version:version.value}));actions.appendChild(install)}footer.appendChild(actions);card.appendChild(footer);return card;
    }
    function render(){
      const isAily=state.activeSource==='aily',busy=state.loading||state.loadingMore;ailyTab.setAttribute('aria-selected',String(isAily));arduinoTab.setAttribute('aria-selected',String(!isAily));search.placeholder=isAily?copy.searchAily:copy.searchArduino;if(document.activeElement!==search)search.value=state.query||'';filters.hidden=isAily;sectionTitle.textContent=isAily?copy.ailySection:copy.arduinoSection;refresh.disabled=busy;notice.hidden=!state.notice;notice.classList.toggle('error',state.notice?.error===true);notice.textContent=state.notice?.text||'';setOptions(type,state.types,copy.allTypes);setOptions(category,state.categories,copy.allTopics);
      libraryCount.textContent=state.libraries.length+' / '+state.total+' '+copy.resultUnit;libraryList.replaceChildren();if(state.loading&&state.libraries.length===0)libraryList.appendChild(text('div','empty',isAily?copy.loadingAily:copy.loadingArduino));else if(state.libraries.length===0)libraryList.appendChild(text('div','empty',isAily?copy.emptyAily:copy.emptyArduino));else for(const library of state.libraries)libraryList.appendChild(card(library));more.hidden=!state.hasMore&&!state.loadingMore;more.disabled=busy;more.textContent=state.loadingMore?copy.loadingMore:copy.loadMore;pagingStatus.hidden=busy||state.libraries.length===0||state.hasMore;
    }
    function requestSearch(){more.hidden=true;pagingStatus.hidden=true;clearTimeout(searchTimer);searchTimer=setTimeout(()=>vscode.postMessage({type:'search',query:search.value,category:category.value,libraryType:type.value}),250)}
    function selectSource(source){if(source===state.activeSource)return;clearTimeout(searchTimer);type.value='';category.value='';vscode.postMessage({type:'selectSource',source,query:search.value})}
    ailyTab.addEventListener('click',()=>selectSource('aily'));arduinoTab.addEventListener('click',()=>selectSource('registry'));search.addEventListener('input',requestSearch);type.addEventListener('change',requestSearch);category.addEventListener('change',requestSearch);refresh.addEventListener('click',()=>vscode.postMessage({type:'refresh'}));more.addEventListener('click',()=>vscode.postMessage({type:'loadMore'}));window.addEventListener('message',event=>{if(event.data?.type==='state'){state=event.data.state;render()}});render();vscode.postMessage({type:'ready'});
  </script>
</body></html>`
}

type ViewState = {
  readonly activeSource: LibrarySource
  readonly query: string
  readonly libraries: readonly LibraryEntry[]
  readonly total: number
  readonly categories: readonly string[]
  readonly types: readonly string[]
  readonly loading: boolean
  readonly loadingMore: boolean
  readonly hasMore: boolean
  readonly installing: readonly string[]
  readonly removing: readonly string[]
  readonly notice: { readonly text: string; readonly error?: boolean } | null
}

type WebviewMessage =
  | { readonly type: 'ready' | 'refresh' | 'loadMore' }
  | { readonly type: 'selectSource'; readonly source?: LibrarySource; readonly query?: string }
  | { readonly type: 'search'; readonly query?: string; readonly category?: string; readonly libraryType?: string }
  | { readonly type: 'selectVersion'; readonly libraryId?: string; readonly version?: string }
  | { readonly type: 'install'; readonly libraryId?: string; readonly source?: LibrarySource; readonly version?: string }
  | { readonly type: 'remove'; readonly libraryId?: string; readonly source?: LibrarySource; readonly version?: string }
  | { readonly type: 'openUrl'; readonly url?: string }

class ComponentLibraryViewProvider implements vscode.WebviewViewProvider {
  #view?: vscode.WebviewView
  #activeSource: LibrarySource = 'aily'
  #libraries: readonly LibraryEntry[] = []
  #total = 0
  #categories: readonly string[] = []
  #types: readonly string[] = []
  #loading = false
  #loadingMore = false
  #hasMore = false
  #installing = new Set<string>()
  #removing = new Set<string>()
  #notice: ViewState['notice'] = null
  #query = ''
  #category = ''
  #libraryType = ''
  #searchGeneration = 0
  #language: string
  readonly #hostContextUnsubscribe: () => void

  constructor(private readonly vscodeApi: typeof vscode) {
    this.#language = this.#currentLanguage()
    this.#hostContextUnsubscribe = onHostEmbedContextChanged(() => {
      const nextLanguage = this.#currentLanguage()
      const languageChanged = nextLanguage !== this.#language
      this.#language = nextLanguage
      if (languageChanged && this.#view != null) {
        this.#view.title = this.#copy().panelTitle
        this.#renderWebviewHtml()
        return
      }
      if (this.#activeSource === 'aily') {
        void this.#searchLibraries(true)
      }
    })
  }

  #currentLanguage(): string {
    const hostLanguage = getHostEmbedContext()?.meta?.lang
    return typeof hostLanguage === 'string' && hostLanguage.trim()
      ? hostLanguage
      : this.vscodeApi.env.language
  }

  #copy(): UiStrings {
    return libraryStrings(this.#currentLanguage())
  }

  #renderWebviewHtml(): void {
    if (this.#view == null) return
    this.#view.webview.html = webviewHtml(this.#view.webview, this.#copy(), this.#language)
  }

  dispose(): void {
    this.#hostContextUnsubscribe()
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.#view = view
    view.title = this.#copy().panelTitle
    view.webview.options = { enableScripts: true }
    this.#renderWebviewHtml()
    view.webview.onDidReceiveMessage((message: WebviewMessage) => {
      if (message.type === 'ready' || message.type === 'refresh') void this.refresh(message.type === 'refresh')
      else if (message.type === 'selectSource' && (message.source === 'aily' || message.source === 'registry')) {
        this.#activeSource = message.source
        this.#query = message.query?.trim() ?? ''
        this.#category = ''
        this.#libraryType = ''
        this.#notice = null
        void this.#searchLibraries(true)
      } else if (message.type === 'search') {
        this.#query = message.query?.trim() ?? ''
        this.#category = this.#activeSource === 'registry' ? message.category?.trim() ?? '' : ''
        this.#libraryType = this.#activeSource === 'registry' ? message.libraryType?.trim() ?? '' : ''
        void this.#searchLibraries(true)
      } else if (message.type === 'loadMore') void this.#searchLibraries(false)
      else if (message.type === 'selectVersion' && message.libraryId && message.version) {
        this.#libraries = this.#libraries.map(item => item.id === message.libraryId && item.versions.includes(message.version!) ? { ...item, version: message.version! } : item)
      } else if (message.type === 'install' && message.libraryId && message.source && message.version) void this.#install(message.libraryId, message.source, message.version)
      else if (message.type === 'remove' && message.libraryId && message.source && message.version) void this.#remove(message.libraryId, message.source, message.version)
      else if (message.type === 'openUrl' && /^https?:\/\//iu.test(message.url ?? '')) void this.vscodeApi.env.openExternal(this.vscodeApi.Uri.parse(message.url!))
    })
  }

  #sendState(): void {
    void this.#view?.webview.postMessage({ type: 'state', state: {
      activeSource: this.#activeSource,
      query: this.#query,
      libraries: this.#libraries,
      total: this.#total,
      categories: this.#categories,
      types: this.#types,
      loading: this.#loading,
      loadingMore: this.#loadingMore,
      hasMore: this.#hasMore,
      installing: [...this.#installing],
      removing: [...this.#removing],
      notice: this.#notice
    } satisfies ViewState })
  }

  async refresh(forceRefresh = false): Promise<void> {
    const root = workspaceRoot(this.vscodeApi)
    if (!root) {
      this.#libraries = []
      this.#notice = { text: this.#copy().unavailable, error: true }
      this.#sendState()
      return
    }
    this.#notice = null
    this.#sendState()
    await this.#searchLibraries(true, forceRefresh)
  }

  async #searchLibraries(reset: boolean, forceRefresh = false): Promise<void> {
    const root = workspaceRoot(this.vscodeApi)
    if (!root || (this.#loadingMore && !reset)) return
    const generation = ++this.#searchGeneration
    const source = this.#activeSource
    const offset = reset ? 0 : this.#libraries.length
    this.#loading = reset
    this.#loadingMore = !reset
    if (reset) {
      this.#libraries = []
      this.#total = 0
      this.#hasMore = false
      if (source === 'aily') {
        this.#categories = []
        this.#types = []
      }
    }
    this.#notice = null
    this.#sendState()
    try {
      const response = await callApi('search', {
        source,
        workspaceRoot: root,
        query: this.#query,
        category: source === 'registry' ? this.#category : '',
        type: source === 'registry' ? this.#libraryType : '',
        offset,
        limit: 50,
        forceRefresh
      })
      if (generation !== this.#searchGeneration || source !== this.#activeSource) return
      const page = response.libraries ?? []
      this.#libraries = reset ? page : [...this.#libraries, ...page]
      this.#total = response.total ?? this.#libraries.length
      this.#hasMore = page.length > 0 && this.#libraries.length < this.#total
      this.#categories = response.categories ?? this.#categories
      this.#types = response.types ?? this.#types
    } catch (error) {
      if (generation !== this.#searchGeneration || source !== this.#activeSource) return
      if (reset) this.#libraries = []
      this.#notice = {
        text: this.#copy().failed(
          'load',
          source,
          error instanceof Error ? error.message : String(error)
        ),
        error: true
      }
    } finally {
      if (generation === this.#searchGeneration && source === this.#activeSource) {
        this.#loading = false
        this.#loadingMore = false
        this.#sendState()
      }
    }
  }

  async #install(libraryId: string, source: LibrarySource, version: string): Promise<void> {
    const root = workspaceRoot(this.vscodeApi)
    const library = this.#libraries.find(item => item.id === libraryId && item.source === source)
    if (!root || !library || library.installed || this.#installing.has(libraryId) || this.#removing.has(libraryId)) return
    this.#installing.add(libraryId)
    this.#notice = null
    this.#sendState()
    try {
      let response: ApiResponse
      try {
        response = await callApi('install', { workspaceRoot: root, libraryId, source, version })
      } catch (error) {
        if (
          !(error instanceof ComponentLibraryApiError)
          || !['CODER_LIBRARY_INCOMPATIBLE', 'ARDUINO_LIBRARY_INCOMPATIBLE'].includes(error.errorCode)
        ) throw error

        const shouldContinue = await this.#confirmIncompatibleInstall(library, error.details)
        if (!shouldContinue) return
        response = await callApi('install', {
          workspaceRoot: root,
          libraryId,
          source,
          version,
          allowIncompatible: true,
        })
      }
      const update = (item: LibraryEntry): LibraryEntry => item.id === libraryId
        ? { ...item, ...response.library, source, installed: true, installedVersion: response.library?.installedVersion ?? version }
        : item
      this.#libraries = this.#libraries.map(update)
      this.#notice = { text: this.#copy().added(library.name || library.folderName, source) }
    } catch (error) {
      this.#notice = {
        text: this.#copy().failed(
          'install',
          source,
          error instanceof Error ? error.message : String(error)
        ),
        error: true
      }
      void Promise.resolve(this.vscodeApi.window.showErrorMessage(this.#notice.text)).catch(() => undefined)
    } finally {
      this.#installing.delete(libraryId)
      this.#sendState()
    }
  }

  async #confirmIncompatibleInstall(
    library: LibraryEntry,
    details?: CompatibilityDetails,
  ): Promise<boolean> {
    const copy = this.#copy()
    const supported = details?.supportedArchitectures ?? library.architectures
    const active = details?.activeArchitectures ?? library.compatibility?.activeArchitectures ?? []
    const alternatives = details?.compatibleAlternatives?.flatMap(item => item.name ? [item.name] : []) ?? []
    const choice = await this.vscodeApi.window.showWarningMessage(
      copy.incompatibleTitle(library.name || library.folderName),
      {
        modal: true,
        detail: copy.incompatibleDetail(supported, active, alternatives),
      },
      copy.continueInstall,
    )
    return choice === copy.continueInstall
  }

  async #remove(libraryId: string, source: LibrarySource, version: string): Promise<void> {
    const root = workspaceRoot(this.vscodeApi)
    const library = this.#libraries.find(item => item.id === libraryId && item.source === source)
    const installedVersion = library?.installedVersion?.trim() || version.trim()
    if (
      !root
      || !library?.installed
      || library.managed !== true
      || !installedVersion
      || this.#installing.has(libraryId)
      || this.#removing.has(libraryId)
    ) return
    this.#removing.add(libraryId)
    this.#notice = null
    this.#sendState()
    try {
      await callApi('remove', { workspaceRoot: root, libraryId, source, version: installedVersion })
      this.#libraries = this.#libraries.map(item => item.id === libraryId
        ? { ...item, installed: false, installedVersion: '', managed: false, folderName: '' }
        : item)
      this.#notice = { text: this.#copy().removed(library.name || library.folderName, source) }
    } catch (error) {
      this.#notice = {
        text: this.#copy().failed(
          'remove',
          source,
          error instanceof Error ? error.message : String(error)
        ),
        error: true
      }
    } finally {
      this.#removing.delete(libraryId)
      this.#sendState()
    }
  }
}

export type ComponentLibraryViewRegistration = vscode.Disposable & { refresh(): Promise<void> }

export function registerAilyComponentLibraryView(vscodeApi: typeof vscode): ComponentLibraryViewRegistration {
  const provider = new ComponentLibraryViewProvider(vscodeApi)
  const registration = vscodeApi.window.registerWebviewViewProvider(AILY_COMPONENT_LIBRARY_VIEW_ID, provider, { webviewOptions: { retainContextWhenHidden: true } })
  const registerCloseMenuItem = () => MenuRegistry.appendMenuItem(MenuId.AuxiliaryBarTitle, {
    command: {
      id: 'workbench.action.closeAuxiliaryBar',
      title: libraryStrings(getHostEmbedContext()?.meta?.lang ?? vscodeApi.env.language).close,
      icon: Codicon.close
    },
    group: 'navigation',
    order: 2,
    when: ContextKeyExpr.and(
      ContextKeyExpr.equals('activeAuxiliary', AILY_COMPONENT_LIBRARY_PANE_COMPOSITE_ID),
      ContextKeyExpr.notEquals('config.workbench.activityBar.location', 'default')
    )
  })
  let closeMenuItem = registerCloseMenuItem()
  let closeTitle = libraryStrings(getHostEmbedContext()?.meta?.lang ?? vscodeApi.env.language).close
  const unsubscribeCloseTitle = onHostEmbedContextChanged(() => {
    const nextTitle = libraryStrings(getHostEmbedContext()?.meta?.lang ?? vscodeApi.env.language).close
    if (nextTitle === closeTitle) return
    closeTitle = nextTitle
    closeMenuItem.dispose()
    closeMenuItem = registerCloseMenuItem()
  })
  return {
    dispose: () => { provider.dispose(); registration.dispose(); closeMenuItem.dispose(); unsubscribeCloseTitle() },
    refresh: () => provider.refresh()
  }
}

export async function openAilyComponentLibraryPanel(): Promise<void> {
  StandaloneServices.get(IWorkbenchLayoutService).setPartHidden(false, Parts.AUXILIARYBAR_PART)
  await StandaloneServices.get(IViewsService).openView(AILY_COMPONENT_LIBRARY_VIEW_ID, true)
}

export async function toggleAilyComponentLibraryPanel(): Promise<void> {
  const layoutService = StandaloneServices.get(IWorkbenchLayoutService)
  if (layoutService.isVisible(Parts.AUXILIARYBAR_PART, window)) {
    layoutService.setPartHidden(true, Parts.AUXILIARYBAR_PART)
    return
  }
  await openAilyComponentLibraryPanel()
}
