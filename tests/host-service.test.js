import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createExport, ExportError } from '../export-core.js';
import {
  ConversationExportService, createDownloadHandler, createExportTool,
  validateConfig, publicError, EXPORT_PATH,
} from '../host-service.js';
import { apply, Config, inject } from '../index.js';

const NOW = Date.parse('2026-11-03T09:00:00Z');
const owner = { kind: 'browser-owner' };
const agentAuthority = { kind: 'agent', sessionId: 'self', cwd: 'D:\\workspace' };
const options = { sessionId: 'self', format: 'json', includeTools: false };
function observation(id = 'self', overrides = {}) {
  let disposed = 0;
  return {
    header: { id, createdAt: NOW - 1000, cwd: 'D:\\workspace' },
    events: [
      { seq: 0, time: NOW - 800, type: 'session/title', data: { title: '中文 <标题> "测试"' } },
      { seq: 1, time: NOW - 500, type: 'user/message', surfaceOp: 'append', data: {
        id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '你好 👋\n```js\nconst x = 1;\n```' }],
      } },
      { seq: 2, time: NOW - 100, type: 'assistant/message', surfaceOp: 'append', data: { message: {
        id: 'a1', role: 'assistant', source: { kind: 'model', provider: 'fixture', model: 'fixture', replayState: 'DO_NOT_EXPORT' },
        content: [{ type: 'text', text: '**答复**\n完整正文。' }],
      } } },
    ],
    cursor: 2, inheritedEventCount: 0, source: 'prepared',
    ...overrides,
    get disposed() { return disposed; },
    [Symbol.dispose]() { disposed++; },
  };
}
function setup(obs = observation(), extras = {}) {
  const calls = [];
  const query = {
    async observeSession(id, readOptions) { calls.push({ id, ...readOptions }); return obs; },
    async filterSessions(filters) { return [{ header: { ...obs.header, id: filters[0].values[0] } }]; },
    ...extras,
  };
  return { query, calls, obs, service: new ConversationExportService(query, {}, () => NOW) };
}
function request(query = 'sessionId=self&format=json&includeTools=false', init) {
  return new Request(`http://127.0.0.1:5467${EXPORT_PATH}?${query}`, init);
}
function execution(overrides = {}) {
  return {
    agent: { session: { id: 'self', header: { id: 'self', cwd: 'D:\\workspace' } } },
    callId: 'export-call', signal: new AbortController().signal,
    ...overrides,
  };
}

test('config defaults, bounds and dependency-free Standard Schema', () => {
  assert.equal(validateConfig(undefined).maxExportBytes, 67108864);
  assert.equal(Config['~standard'].validate({ maxExportBytes: 12 }).value.maxExportBytes, 12);
  for (const value of [0, -1, 1.5, Infinity, '64', 1073741825]) {
    assert.throws(() => validateConfig({ maxExportBytes: value }));
    assert.ok(Config['~standard'].validate({ maxExportBytes: value }).issues);
  }
  assert.throws(() => validateConfig({ unknown: 1 }));
  assert.throws(() => validateConfig([]));
  assert.deepEqual(inject, ['connection', 'sessionQuery']);
});

test('owner reads one point snapshot, without mutations or projections, and releases it', async () => {
  const env = setup();
  const before = JSON.stringify(env.obs.events);
  const result = await env.service.exportConversation(options, owner);
  assert.equal(result.messageCount, 2);
  assert.equal(env.calls.length, 1);
  assert.equal(env.calls[0].projectionMode, 'none');
  assert.ok(env.calls[0].signal instanceof AbortSignal);
  assert.equal(env.obs.disposed, 1);
  assert.equal(JSON.stringify(env.obs.events), before);
  assert.ok(!result.content.includes('DO_NOT_EXPORT'));
});

test('owner may export a noncurrent workspace conversation', async () => {
  const obs = observation('other', { header: { id: 'other', createdAt: NOW, cwd: 'E:\\other' } });
  const env = setup(obs);
  const result = await env.service.exportConversation({ ...options, sessionId: 'other' }, owner);
  assert.equal(JSON.parse(result.content).session.id, 'other');
});

test('agent same-workspace target passes metadata precheck and exact header recheck', async () => {
  let filters;
  const obs = observation('other');
  const env = setup(obs, { async filterSessions(input) { filters = input; return [{ header: obs.header }]; } });
  await env.service.exportConversation({ ...options, sessionId: 'other' }, agentAuthority);
  assert.deepEqual(filters, [{ kind: 'id', values: ['other'] }, { kind: 'cwd', values: ['D:\\workspace'] }]);
  assert.equal(env.obs.disposed, 1);
});

test('cross-workspace and unknown ids both fail before event body reads', async () => {
  for (const result of [[], [{ header: { id: 'other', cwd: 'E:\\secret' } }]]) {
    const env = setup(observation('other'), { async filterSessions() { return result; } });
    await assert.rejects(env.service.exportConversation({ ...options, sessionId: 'other' }, agentAuthority), { code: 'UNAUTHORIZED' });
    assert.equal(env.calls.length, 0);
  }
});

test('agent without cwd cannot target another session; missing identity is rejected', async () => {
  const env = setup();
  for (const auth of [{ kind: 'agent', sessionId: 'self' }, {}, null]) {
    await assert.rejects(env.service.exportConversation({ ...options, sessionId: 'other' }, auth), { code: 'UNAUTHORIZED' });
  }
  assert.equal(env.calls.length, 0);
});

test('exact self header cwd and target identity are rechecked; rejected lease is disposed', async () => {
  for (const header of [
    { id: 'self', cwd: 'D:\\changed', createdAt: NOW },
    { id: 'wrong', cwd: 'D:\\workspace', createdAt: NOW },
  ]) {
    const env = setup(observation('self', { header }));
    await assert.rejects(env.service.exportConversation(options, agentAuthority), { code: 'UNAUTHORIZED' });
    assert.equal(env.obs.disposed, 1);
  }
});

test('owner also refuses a mismatched observation rather than exporting another session', async () => {
  const env = setup(observation('wrong'));
  await assert.rejects(env.service.exportConversation(options, owner), { code: 'INVALID_OBSERVATION' });
  assert.equal(env.obs.disposed, 1);
});

test('normalization failures release observation leases', async () => {
  const env = setup(observation('self', { inheritedEventCount: -1 }));
  await assert.rejects(env.service.exportConversation(options, owner), { code: 'INVALID_OBSERVATION' });
  assert.equal(env.obs.disposed, 1);
});

test('already aborted caller starts no read', async () => {
  const env = setup();
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(env.service.exportConversation(options, owner, abort.signal), { name: 'AbortError' });
  assert.equal(env.calls.length, 0);
});

test('cancellation after read finishes still releases its lease and yields no file', async () => {
  const abort = new AbortController();
  const obs = observation();
  const env = setup(obs, { async observeSession() { abort.abort(); return obs; } });
  await assert.rejects(env.service.exportConversation(options, owner, abort.signal), { name: 'AbortError' });
  assert.equal(obs.disposed, 1);
});

test('plugin shutdown cancels in-flight reads, drains and refuses later operations', async () => {
  const env = setup(undefined, {
    observeSession(_id, { signal }) {
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    },
  });
  const operation = env.service.exportConversation(options, owner);
  const rejection = assert.rejects(operation, { name: 'AbortError' });
  await env.service.dispose();
  await rejection;
  assert.equal(env.service.active.size, 0);
  await assert.rejects(env.service.exportConversation(options, owner), { name: 'AbortError' });
});

test('successful GET has correct bytes, MIME, private headers and encoded Unicode filename', async () => {
  const env = setup();
  const response = await createDownloadHandler(env.service)(request());
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^application\/json; charset=utf-8$/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('x-dsh-export-messages'), '2');
  assert.match(response.headers.get('content-disposition'), /filename\*=UTF-8''/);
  assert.ok(!/[\r\n]/.test(response.headers.get('content-disposition')));
  const content = await response.text();
  assert.equal(Buffer.byteLength(content), Number(response.headers.get('content-length')));
  assert.deepEqual(JSON.parse(content), JSON.parse(createExport(observation(), options, { now: NOW }).content));
});

test('Markdown GET and JSON GET use identical transcript policy', async () => {
  const env = setup();
  const response = await createDownloadHandler(env.service)(request('sessionId=self&format=markdown'));
  assert.match(response.headers.get('content-type'), /^text\/markdown/);
  assert.equal(response.headers.get('x-dsh-export-messages'), '2');
  const content = await response.text();
  assert.match(content, /你好 👋/);
  assert.match(content, /\*\*答复\*\*/);
  assert.match(content, /```js\nconst x = 1;\n```/);
});

test('malformed, repeated, unknown and authority injection params never read a session', async () => {
  const env = setup();
  const handler = createDownloadHandler(env.service);
  for (const query of [
    '', 'format=json', 'sessionId=self', 'sessionId=self&format=xml',
    'sessionId=self&format=json&includeTools=1', 'sessionId=self&format=json&includeTools=',
    'sessionId=self&format=json&sessionId=other', 'sessionId=self&format=json&authority=owner',
    'sessionId=self&format=json&__proto__=x', 'sessionId=%00&format=json',
  ]) {
    const response = await handler(request(query));
    assert.equal(response.status, 400, query);
    assert.equal((await response.json()).error.code, 'INVALID_PARAMS');
  }
  assert.equal(env.calls.length, 0);
});

test('non-GET methods are rejected', async () => {
  const env = setup();
  const response = await createDownloadHandler(env.service)(request(undefined, { method: 'POST' }));
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('allow'), 'GET');
  assert.equal(env.calls.length, 0);
});

test('backend failures expose stable codes but not backend paths, stacks or secrets', async () => {
  for (const [code, status, publicCode] of [
    ['SESSION_QUERY_SESSION_NOT_FOUND', 404, 'SESSION_NOT_FOUND'],
    ['SESSION_QUERY_PERSISTENCE_FAILED', 503, 'HISTORY_UNAVAILABLE'],
    ['SESSION_QUERY_CORRUPT_SESSION', 422, 'INVALID_OBSERVATION'],
    ['SESSION_FORMAT_UNSUPPORTED', 422, 'UNSUPPORTED_HISTORY'],
    ['ANY_OTHER_ERROR', 500, 'EXPORT_FAILED'],
  ]) {
    const env = setup(undefined, { async observeSession() { throw Object.assign(new Error('C:\\SECRET\\token'), { code }); } });
    const response = await createDownloadHandler(env.service)(request());
    assert.equal(response.status, status);
    const body = await response.text();
    assert.equal(JSON.parse(body).error.code, publicCode);
    assert.ok(!body.includes('SECRET'));
  }
});

test('oversized exports return 413, never a truncated successful download', async () => {
  const env = setup();
  env.service = new ConversationExportService(env.query, { maxExportBytes: 20 }, () => NOW);
  const response = await createDownloadHandler(env.service)(request());
  assert.equal(response.status, 413);
  assert.equal((await response.json()).error.code, 'EXPORT_TOO_LARGE');
  assert.equal(env.obs.disposed, 1);
});

test('tool uses same serializer, saves complete private artifact and returns bounded metadata', async () => {
  const env = setup();
  let savedInput;
  const tool = createExportTool(env.service, { async saveText(input) {
    savedInput = input;
    return { locator: 'fixture://private/file.json', bytes: Buffer.byteLength(input.content), retrievalHint: 'Fixture artifact.' };
  } });
  const value = await tool.execute({ format: 'json' }, execution());
  assert.equal(savedInput.content, createExport(observation(), options, { now: NOW }).content);
  assert.deepEqual(savedInput.owner, { sessionId: 'self' });
  assert.deepEqual(savedInput.source, { kind: 'tool', toolName: 'export_conversation', callId: 'export-call', label: 'Conversation export' });
  assert.equal(value.temporary, true);
  assert.equal(value.messageCount, 2);
  assert.equal(value.capturedThroughSeq, 2);
  assert.ok(!Object.hasOwn(value, 'content'));
  assert.ok(!JSON.stringify(value).includes('完整正文'));
  const rendered = tool.output.render({}, value);
  assert.deepEqual(JSON.parse(rendered[0].text), value);
});

test('tool storage names stay short after DSH spill encoding while preserving the friendly filename', async () => {
  for (const format of ['json', 'markdown']) {
    for (const title of ['中'.repeat(40), '🧪'.repeat(30)]) {
      const obs = observation('session-12345678-1234-1234-1234-123456789abc');
      obs.events[0].data.title = title;
      const env = setup(obs);
      const tool = createExportTool(env.service, { async saveText(input) {
        // dsh-spill-local 0.2.2-rc.1 encodes each non-ASCII UTF-16 code unit
        // as ~XXXX, then prepends 12 hex characters and a hyphen.
        const encoded = input.suggestedName.split('').map(ch => /^[A-Za-z0-9._-]$/.test(ch)
          ? ch : '~' + ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')).join('');
        assert.ok(encoded.length + 13 <= 255, 'encoded basename must fit a filesystem component');
        assert.equal(input.suggestedName, `conversation.${format === 'json' ? 'json' : 'md'}`);
        return { locator: 'fixture://private/' + encoded, bytes: Buffer.byteLength(input.content), retrievalHint: 'Fixture.' };
      } });
      const result = await tool.execute({ format }, execution({
        agent: { session: { id: obs.header.id, header: obs.header } },
      }));
      assert.equal(result.filename, createExport(obs, { ...options, sessionId: obs.header.id, format }, { now: NOW }).filename);
      assert.ok(result.filename.startsWith(title));
      assert.equal(obs.disposed, 1);
    }
  }
});

test('tool missing caller, malformed args or injected authority never save an artifact', async () => {
  const env = setup();
  let saves = 0;
  const tool = createExportTool(env.service, { async saveText() { saves++; } });
  await assert.rejects(tool.execute({ format: 'json' }, execution({ agent: undefined })), { code: 'UNAUTHORIZED' });
  for (const args of [{ format: 'json', authority: 'owner' }, { format: 'json', include_tools: 'false' }, {}]) {
    await assert.rejects(tool.execute(args, execution()), { code: 'INVALID_PARAMS' });
  }
  assert.equal(saves, 0);
  assert.equal(env.calls.length, 0);
});

test('spill failure is explicit, sanitized, and not mistaken for successful export', async () => {
  const env = setup();
  const tool = createExportTool(env.service, { async saveText() { throw new Error('private storage C:\\Secret'); } });
  await assert.rejects(tool.execute({ format: 'markdown' }, execution()), error => {
    assert.equal(error.code, 'EXPORT_FAILED');
    assert.ok(!error.message.includes('Secret'));
    return true;
  });
});

test('cancellation and custom export errors keep explicit public status', () => {
  assert.equal(publicError(new DOMException('private', 'AbortError')).code, 'ABORTED');
  const failure = new ExportError('EXPORT_TOO_LARGE', 'Too large.', 413);
  assert.equal(publicError(failure), failure);
});

test('apply registers exactly owned service/route/tool; disposal removes resources', async () => {
  const env = setup();
  const disposers = [];
  const installed = new Map();
  const ctx = {
    sessionQuery: env.query,
    tools: { register(value) { installed.set('tool', value); return () => installed.delete('tool'); } },
    spillStore: {},
    connection: { fetch: { register(value) { installed.set('route', value); return () => installed.delete('route'); } } },
    provide(key, value) { installed.set(key, value); return () => installed.delete(key); },
    effect(callback) { const cleanup = callback(); disposers.push(cleanup); return cleanup; },
    inject(_deps, callback) { callback(ctx); },
  };
  apply(ctx, {});
  assert.equal(installed.get('route').path, EXPORT_PATH);
  assert.deepEqual(installed.get('route').methods, ['GET']);
  assert.equal(installed.get('route').requestBody, 'buffered');
  assert.equal(installed.get('tool').name, 'export_conversation');
  const retained = installed.get('conversationExport');
  // Cordis unloads independent effects concurrently, not sequentially.
  await Promise.all(disposers.map(dispose => dispose()));
  assert.equal(installed.size, 0);
  await assert.rejects(retained.exportConversation(options, owner), { name: 'AbortError' });
});
