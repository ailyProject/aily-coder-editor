// Test shell: bundles the production Angular bridge; only DI/auth and the FS adapter are fixtures.
import { build } from 'esbuild'
import { resolve } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
const hostRoot = resolve(process.argv[2])
const output = resolve(process.argv[3])
await mkdir(output, { recursive: true })
await build({ stdin: { contents: `
import { CodeSuggestionHostBridgeService } from ${JSON.stringify(hostRoot + '/src/app/editors/code-editor-pro/services/code-suggestion-host-bridge.service.ts')};
import { setServerUrl } from ${JSON.stringify(hostRoot + '/src/app/configs/api.config.ts')};
setServerUrl(location.origin);
const listeners = new Set();
const auth = { isSessionInvalidating: false, getToken2: async () => 'v4-local-fixture-only', refreshAuthToken: async () => false,
 userInfo$: { subscribe(callback) { listeners.add(callback); callback({id:'fixture-user'}); return {unsubscribe(){listeners.delete(callback)}}; } } };
const bridge = new CodeSuggestionHostBridgeService(auth);
window.fixtureMessages=[];
const frame=document.createElement('iframe'); frame.title='Aily Coder v4 verification';
frame.src='/coder?mode=full-workbench&nativeFsBridge=true&locale=zh-hans&folder='+encodeURIComponent(window.fixtureRoot);
document.body.append(frame); bridge.registerFrame(frame.contentWindow);
window.addEventListener('message', async event => {
 if (event.source!==frame.contentWindow) return;
 const message=event.data;
 if (typeof message?.channel==='string' && /suggestion|completion/.test(message.channel)) window.fixtureMessages.push(message);
 if (bridge.handleMessage(event)) return;
 if (message?.channel==='aily-coder-editor-native-fs') {
   let response; try { response=await (await fetch('/fixture/fs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(message)})).json(); }
   catch {response={error:'Fixture FS unavailable'};}
   frame.contentWindow.postMessage({channel:'aily-coder-editor-native-fs-reply',id:message.id,...response},'*');
 }
});
window.fixtureSignOut=()=>{auth.isSessionInvalidating=true; for(const callback of listeners) callback(null);};
window.addEventListener('beforeunload',()=>bridge.dispose());
`, resolveDir: hostRoot, loader: 'ts' }, bundle: true, format: 'esm', platform: 'browser', outfile: output + '/host.js',
 plugins: [{ name: 'fixture-angular-di', setup(build) {
   build.onResolve({ filter: /^@angular\/core$|^@core\/auth\/public-api$/ }, args => ({ path: args.path, namespace: 'fixture' }))
   build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export const Injectable=()=>target=>target; export class AuthService {}', loader: 'js' }))
 } }], tsconfigRaw: { compilerOptions: { experimentalDecorators: true } } })
await writeFile(output + '/boundary.txt', 'Production bridge + production Coder bundle + actual FastAPI v4 routes/admission/provider adapter. Test-only auth, Redis, model and disk sandbox. No production/Kong/real-model acceptance.\n')
console.log('Compiled production host bridge for the isolated v4 shell.')
