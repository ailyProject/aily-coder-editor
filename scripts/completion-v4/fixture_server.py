"""Loopback-only v4 integration harness. NEVER import this module into production.

Runs the real router, quota Lua, provider HTTP adapter and validator. Authentication,
benefits, Redis storage and model outputs are explicit deterministic test fixtures.
"""
import argparse
import asyncio
import base64
from contextlib import asynccontextmanager
from dataclasses import replace
import json
import os
from pathlib import Path
import re
import sys
import tempfile

parser = argparse.ArgumentParser()
parser.add_argument('--services', required=True)
parser.add_argument('--coder', required=True)
parser.add_argument('--host-bundle', required=True)
parser.add_argument('--port', type=int, default=8019)
parser.add_argument('--real-model', action='store_true', help='Use the server-side provider; auth, benefits and Redis remain isolated fixtures')
args = parser.parse_args()
sys.path.insert(0, str(Path(args.services) / 'services/ai'))
if args.real_model:
    from dotenv import load_dotenv
    load_dotenv(Path(args.services) / 'services/ai/.env')
os.environ.update(POSTGRES_SERVER='localhost', POSTGRES_USER='fixture', POSTGRES_PASSWORD='fixture',
    POSTGRES_DB='fixture', POSTGRES_PORT='5432', SQLALCHEMY_DATABASE_URI='postgresql://fixture:fixture@localhost:5432/fixture',
    FREE_MAX_CONCURRENCY='10', PRO_MAX_CONCURRENCY='30', PRO_PLUS_MAX_CONCURRENCY='100', AILY_INTERACTION_STATE_BACKEND='memory')
import fakeredis.aioredis
from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, FileResponse, StreamingResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
import uvicorn
from src.api.code_suggestions import router, get_code_suggestion_service
from src.code_completion_config import load_code_completion_settings, CodeCompletionEndpoint
from src.modules.code_completion_admission import CodeCompletionAdmission
from src.services.code_suggestion_service import CodeSuggestionService, SuggestionAdapter, SuggestionUsageStore

root = Path(tempfile.mkdtemp(prefix='aily-v4-workspace-')).resolve()
(root / 'main.cpp').write_text('int main() {\n  \n}\n')
(root / 'rename.cpp').write_text('int oldName = 1;\n' + '// spacer\n' * 20 + 'int value = oldName;\n')
(root / 'rename-local.js').write_text('function nominalZoneOf(distTb) {\n  if (distTb > 3000) return 0;\n  if (distTb > 2000) return 1;\n  if (distTb > 1000) return 2;\n\n  console.log("distTb", distTb);\n  return 3;\n}\n')
(root / 'delete.cpp').write_text('int unused = 1;\nint main() { return 0; }\n')
state = {'scenario': 'completion', 'requests': [], 'providerCalls': 0, 'feedback': []}
redis = fakeredis.aioredis.FakeRedis(decode_responses=True)
class Benefits:
    async def get(self, _user): return True, 10000
    async def close(self): pass
endpoint = CodeCompletionEndpoint('v4-local-fixture', f'http://127.0.0.1:{args.port}/fixture/provider',
    'fixture-only', 'fixture', 'chat', 1, 20, 1200, '', '', '')
configured = load_code_completion_settings(section_name='code_suggestions')
settings = replace(configured, enabled=True, endpoints=configured.endpoints if args.real_model else (endpoint,),
    requests_per_minute=1000, burst=100, admission_timeout_seconds=1, redis_operation_timeout_seconds=1)
service = CodeSuggestionService(settings=settings, admission=CodeCompletionAdmission(redis, settings), benefits=Benefits(),
    usage=SuggestionUsageStore(redis), adapter=SuggestionAdapter())
@asynccontextmanager
async def lifespan(_app):
    yield
    await service.close(); await redis.aclose()
app = FastAPI(lifespan=lifespan)
app.include_router(router)
app.dependency_overrides[get_code_suggestion_service] = lambda: service
@app.middleware('http')
async def fixture_auth(request: Request, call_next):
    if request.url.path.startswith('/api/v4/code/'):
        # This shim is the test gateway boundary. It does not assert real JWT verification.
        headers = [(key, value) for key, value in request.scope['headers'] if key not in {b'x-jwt-verified', b'x-user-info'}]
        valid = request.headers.get('authorization') == 'Bearer v4-local-fixture-only'
        headers += [(b'x-jwt-verified', b'true' if valid else b'false'), (b'x-user-info', base64.b64encode(b'{"id":"fixture-user"}'))]
        request.scope['headers'] = headers
        if request.url.path.endswith('/feedback'):
            state['feedback'].append(await request.json())
        elif request.url.path.endswith('/suggestions'):
            state['requests'].append(await request.json())
            if args.real_model: state['providerCalls'] += 1
    response = await call_next(request)
    response.headers['Cross-Origin-Opener-Policy'] = 'same-origin'
    response.headers['Cross-Origin-Embedder-Policy'] = 'credentialless'
    return response
@app.get('/')
async def index():
    return HTMLResponse('<!doctype html><meta charset="utf-8"><title>Aily v4 local verification</title>'
        '<style>html,body{margin:0;height:100%;background:#181818}iframe{width:100%;height:100%;border:0}</style>'
        f'<script>window.fixtureRoot={json.dumps(str(root))}</script><script type="module" src="/fixture/host.js"></script>')
@app.get('/coder')
async def coder(): return FileResponse(Path(args.coder) / 'ui/index.html')
@app.get('/fixture/host.js')
async def host(): return FileResponse(Path(args.host_bundle) / 'host.js')
@app.get('/fixture/state')
async def stats():
    return {**state, 'root': str(root), 'quota': await service.quota('fixture-user'),
        'metrics': [fields for _, fields in await redis.xrange('cc:events') if fields.get('type') == 'suggestion'],
        'realModel': args.real_model}
@app.post('/fixture/scenario')
async def scenario(request: Request):
    value = await request.json(); state['scenario'] = value['scenario']; return {'ok': True}
@app.post('/fixture/provider')
async def provider(request: Request):
    payload = await request.json(); data = json.loads(payload['messages'][1]['content'])
    state['providerCalls'] += 1
    windows = ([w for w in data['documents'][0]['windows'] if w['purpose'] == 'completion']
               if data['mode'] == 'next-edit' else [dict(windowId=data['cursorWindowId'])])
    scenario = state['scenario']
    if scenario == 'aily-tab' and data['mode'] == 'next-edit':
        suggestions = []
        active_text = '\n'.join(window['text'] for window in data['documents'][0]['windows'])
        parameter_match = re.search(r'\bread\(int\s+([A-Za-z_]\w*)\)', active_text)
        parameter = parameter_match.group(1) if parameter_match else 'scale'
        for doc in data['documents'][1:]:
            if doc['permission'] != 'edit': continue
            window = next((w for w in doc['windows'] if w['purpose'] == 'completion' and ('Sensor::read()' in w['text'] or 'sensor.read()' in w['text'])), None)
            if window:
                text = window['text'].replace('Sensor::read() { return 1; }', f'Sensor::read(int {parameter}) {{ return {parameter}; }}').replace('sensor.read()', 'sensor.read(2)')
                if text != window['text']:
                    suggestions = [dict(windowId=window['windowId'], newText=text, additionalEdits=[])]
                    break
    elif scenario == 'empty' or (data['mode'] == 'next-edit' and scenario == 'completion'):
        suggestions = []
    elif data['mode'] != 'next-edit':
        values = (['tor<int> values;'] if scenario == 'import-completion' else ['int result = 0;\n  return result;'] if scenario == 'multiline' else ['return 0;'])
        suggestions = [dict(windowId=windows[0]['windowId'], newText=value, additionalEdits=[]) for value in values]
    else:
        window = next((w for w in windows if w['range']['start']['line'] > 10 and 'oldName' in w['text']), windows[0]) if scenario == 'rename' else windows[0]
        text = (window['text'].replace('oldName', 'newName') if scenario == 'rename' else
            window['text'].replace('distTb', 'AC') if scenario == 'rename-local' else
            window['text'].replace('int unused = 1;\n', ''))
        suggestions = [dict(windowId=window['windowId'], newText=text, additionalEdits=[])] if text != window['text'] else []
    raw = json.dumps({'suggestions': suggestions}, ensure_ascii=False)
    async def stream():
        for index in range(0, len(raw), 7):
            yield 'data: ' + json.dumps({'choices': [{'delta': {'content': raw[index:index+7]}}]}) + '\n\n'
            await asyncio.sleep(0.005)
        yield 'data: ' + json.dumps({'choices': [{'delta': {}, 'finish_reason': 'stop'}], 'usage': {'prompt_tokens': 10, 'completion_tokens': 20}}) + '\n\n'
        yield 'data: [DONE]\n\n'
    return StreamingResponse(stream(), media_type='text/event-stream')
@app.post('/fixture/fs')
async def filesystem(request: Request):
    data = await request.json(); op = data['op']; payload = data.get('payload', {})
    path = Path(payload.get('path', str(root))).resolve()
    if not path.is_relative_to(root): return {'error': 'Outside fixture root'}
    try:
        if op == 'nativeFsStat':
            result = {'exists': path.exists(), '_isDirectory': path.is_dir(), '_isFile': path.is_file(),
                'size': path.stat().st_size if path.exists() else 0, 'mtimeMs': path.stat().st_mtime * 1000 if path.exists() else 0}
        elif op == 'nativeFsReaddir': result = [{'name': item.name, '_isDirectory': item.is_dir()} for item in path.iterdir()]
        elif op == 'nativeFsReadBinary': result = {'base64': base64.b64encode(path.read_bytes()).decode()}
        elif op == 'nativeFsWriteBinary': path.write_bytes(base64.b64decode(payload['base64'])); result = {'ok': True}
        elif 'Watch' in op: result = {'watchId': data['id'], 'ok': True}
        else: return {'error': 'Unsupported fixture FS operation: ' + op}
        return {'result': result}
    except Exception as error: return {'error': type(error).__name__}
app.mount('/assets', StaticFiles(directory=Path(args.coder) / 'ui/assets'), name='assets')
if __name__ == '__main__': uvicorn.run(app, host='127.0.0.1', port=args.port, access_log=False, log_level='warning')
