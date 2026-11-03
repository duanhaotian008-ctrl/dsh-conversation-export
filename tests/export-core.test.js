import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import {
  DEFAULT_MAX_EXPORT_BYTES, ExportError, normalizeOptions, createExport,
  makeFilename, escapeMarkdownMetadata,
} from '../export-core.js';

const NOW = Date.UTC(2026, 10, 3, 8, 51, 15, 123);
const SID = 'session-中文-0123456789';
const HASH = `sha256:${'a'.repeat(64)}`;
const text = value => ({ type: 'text', text: value });
const event = (seq, type, data, surfaceOp) => ({ seq, time: NOW + seq, type, data, ...(surfaceOp === undefined ? {} : { surfaceOp }) });
const user = (seq, value, extra = {}) => event(seq, 'user/message', {
  id: `u-${seq}`, role: 'user', source: { kind: 'user' }, content: [text(value)], ...extra,
}, 'append');
const assistant = (seq, content, extra = {}) => event(seq, 'assistant/message', {
  turn: 1, step: 1,
  message: { id: `a-${seq}`, role: 'assistant', source: { kind: 'model', provider: 'provider', model: 'model' }, content },
  stream: [], ...extra,
}, 'append');
const tool = (seq, callId, content, extra = {}) => event(seq, 'tool/result', {
  turn: 1, step: 1,
  message: { id: `t-${seq}`, role: 'tool', source: { kind: 'tool', callId }, toolCallId: callId, content, ...extra },
}, 'append');
const call = (seq, id, name, args) => event(seq, 'tool/call', { turn: 1, step: 1, callId: id, name, arguments: args });
const callBlock = (id, name, args) => ({ type: 'tool-call', id, name, arguments: args });
const observation = (events = [], extra = {}) => ({
  header: { id: SID, createdAt: NOW - 1000, version: 4, isSeeded: false, cwd: 'PRIVATE_CWD' },
  events,
  cursor: events.length ? Math.max(...events.map(item => item.seq)) : -1,
  inheritedEventCount: 0,
  source: 'prepared',
  ...extra,
});
const output = (source, options = {}, config = {}) => createExport(source, { sessionId: SID, format: 'json', ...options }, { now: NOW, ...config });
const document = (source, options, config) => JSON.parse(output(source, options, config).content);
const errorCode = (code, status) => error => error instanceof ExportError && error.code === code && error.status === status;
const qArgs = JSON.stringify({ questions: [{ id: 'mode', question: '  请选择模式：\n', header: '模式', options: [{ label: '简单', description: '快速完成' }, { label: '深入' }], multi_select: false }] });
const answers = (selected = ['简单'], custom) => JSON.stringify({ answers: [{ id: 'mode', selected, ...(custom === undefined ? {} : { custom }) }] });

function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}

test('required exports and strict option normalization', () => {
  assert.equal(DEFAULT_MAX_EXPORT_BYTES, 64 * 1024 * 1024);
  assert.deepEqual(normalizeOptions({ sessionId: SID, format: 'json' }), { sessionId: SID, format: 'json', includeTools: false });
  assert.deepEqual(normalizeOptions(Object.assign(Object.create(null), { sessionId: SID, format: 'markdown', includeTools: true })), { sessionId: SID, format: 'markdown', includeTools: true });
  const error = new ExportError('TEST', 'safe', 418);
  assert.equal(error.name, 'ExportError');
  assert.equal(error.message, 'safe');
  assert.equal(error.status, 418);
});

test('opaque session identities preserve punctuation, whitespace and Unicode without becoming filenames', () => {
  for (const sessionId of ['folder/id', '../opaque', 'a\\b', 'urn:session:abc?x#y', ' id with spaces ', '中文😀🧪', 'x'.repeat(512)]) {
    assert.equal(normalizeOptions({ sessionId, format: 'json' }).sessionId, sessionId);
    const source = observation([], { header: { id: sessionId, createdAt: NOW } });
    const result = output(source, { sessionId });
    assert.equal(JSON.parse(result.content).session.id, sessionId);
    assert.doesNotMatch(result.filename, /[<>:"/\\|?*\u0000-\u001f]/u);
    assert.ok(Buffer.byteLength(result.filename) <= 180);
  }
});

test('invalid, extra, inherited, accessor, and malicious options return 400', () => {
  const invalidValues = [null, undefined, [], 'json', {},
    { sessionId: SID }, { sessionId: SID, format: 'html' },
    ...['', '   ', 'a\r\nx', 'x'.repeat(513), ...[0, 0x85, 0x2028, 0x2029, 0xd800].map(code => `a${String.fromCharCode(code)}b`)].map(sessionId => ({ sessionId, format: 'json' })),
    ...['false', 0, null, undefined].map(includeTools => ({ sessionId: SID, format: 'json', includeTools })),
    { sessionId: SID, format: 'json', cwd: 'arbitrary' },
    { sessionId: SID, format: 'json', authority: 'owner' },
    Object.create({ sessionId: SID, format: 'json' }),
    { sessionId: SID, format: 'json', [Symbol('extra')]: true },
    JSON.parse(`{"sessionId":"${SID}","format":"json","__proto__":{}}`),
  ];
  let getterExecuted = false;
  invalidValues.push({ sessionId: SID, format: 'json', get includeTools() { getterExecuted = true; return false; } });
  for (const value of invalidValues) assert.throws(() => normalizeOptions(value), errorCode('INVALID_PARAMS', 400));
  assert.equal(getterExecuted, false);
});

test('empty session is valid, has null sequence, and stable schema', () => {
  const result = output(observation());
  const data = JSON.parse(result.content);
  assert.deepEqual(data, {
    schemaVersion: 1, exportedAt: new Date(NOW).toISOString(),
    session: { id: SID, title: 'conversation', createdAt: new Date(NOW - 1000).toISOString() },
    snapshot: { throughSeq: null, includeTools: false, inheritedEventCount: 0 },
    messages: [], warnings: [],
  });
  assert.equal(result.messageCount, 0);
  assert.equal(result.capturedThroughSeq, null);
  assert.equal(result.mimeType, 'application/json; charset=utf-8');
  assert.equal(result.content, `${JSON.stringify(data, null, 2)}\n`);
  assert.equal(result.bytes, Buffer.byteLength(result.content, 'utf8'));
  assert.match(result.filename, /^conversation_20261103T085115123Z_.+\.json$/u);
  const md = output(observation(), { format: 'markdown' });
  assert.match(md.content, /没有可导出的对话消息/);
  assert.equal(md.mimeType, 'text/markdown; charset=utf-8');
  assert.match(md.filename, /\.md$/);
});

test('plain text, CJK, emoji, whitespace and repeated text survive exactly', () => {
  const original = '  中文与 emoji 🧪😀\r\n\t尾部  \n';
  const events = [user(0, original), assistant(1, [text(original)]), user(2, original), assistant(3, [text(''), text('  '), text('\n')])];
  const data = document(observation(events));
  assert.deepEqual(data.messages.map(item => item.role), ['user', 'assistant', 'user', 'assistant']);
  assert.deepEqual(data.messages.slice(0, 3).map(item => item.content[0].text), [original, original, original]);
  assert.deepEqual(data.messages[3].content, [text(''), text('  '), text('\n')]);
  assert.equal(data.messages[0].time, new Date(NOW).toISOString());
  assert.equal(data.messages[0].id, 'u-0');
});

test('stable ascending seq and latest title are from only the captured prefix', () => {
  const source = observation([
    event(7, 'session/title', { title: '未来标题', secret: 'TITLE_FUTURE_PRIVATE' }),
    user(4, '第四条'),
    event(3, 'session/title', { title: '观察中的标题', source: { secret: 'TITLE_PRIVATE' } }),
    user(0, '第一条'), event(1, 'session/title', { title: '旧标题' }),
    assistant(5, [text('第五条')]),
  ], { cursor: 5 });
  const data = document(source);
  assert.equal(data.session.title, '观察中的标题');
  assert.deepEqual(data.messages.map(message => message.seq), [0, 4, 5]);
  assert.equal(data.snapshot.throughSeq, 5);
  assert.doesNotMatch(output(source).content, /TITLE_|未来标题/);
  assert.equal(document(observation([event(0, 'session/title', { title: '   ' })])).session.title, 'conversation');
});

test('only real human user sources export; system/developer/runtime and provider metadata never do', () => {
  const hidden = ['runtime-context', 'skill', 'agent', 'system-prompt', 'subagent', 'hook', undefined].map((kind, index) => user(index, `HIDDEN_USER_${index}`, { source: { kind } }));
  const a = assistant(20, [text('公开正文'), { type: 'reasoning', text: 'HIDDEN_REASONING' }, { type: 'tool-addition', toolName: 'HIDDEN_TOOL_SCHEMA' }, { type: 'tool-removal', toolName: 'HIDDEN_TOOL_REMOVE' }]);
  a.data.message.source.replayState = { secret: 'HIDDEN_REPLAY' };
  a.data.message.secret = 'HIDDEN_MESSAGE_EXTRA';
  a.data.stream = [{ type: 'text-chunks', texts: ['HIDDEN_STREAM'] }];
  a.data.usage = { secret: 'HIDDEN_USAGE' };
  const events = [...hidden, event(10, 'system/message', { message: { content: [text('HIDDEN_SYSTEM')] } }, 'append'),
    event(11, 'developer/message', { message: { content: [text('HIDDEN_DEVELOPER')] } }, 'append'),
    event(12, 'request/header', { secret: 'HIDDEN_HEADER' }), user(19, '真实用户'), a];
  for (const includeTools of [false, true]) {
    const result = output(observation(events), { includeTools });
    assert.doesNotMatch(result.content, /HIDDEN_|PRIVATE_CWD|replayState|provider|stream|usage/);
    assert.deepEqual(JSON.parse(result.content).messages.map(message => message.role), ['user', 'assistant']);
  }
});

test('compaction/replacement does not replace, duplicate, or introduce original dialogue', () => {
  const replacement = assistant(5, [text('HIDDEN_COMPACTION')]);
  replacement.surfaceOp = { op: 'replace', startSeq: 0, endSeq: 3 };
  const events = [user(0, '早期问题'), assistant(1, [text('早期答案')]), user(3, '后来问题'), replacement,
    { ...user(6, 'HIDDEN_REPLACEMENT'), surfaceOp: { op: 'replace', startSeq: 0, endSeq: 5 } },
    { ...assistant(7, [text('HIDDEN_NO_APPEND')]), surfaceOp: undefined }, assistant(8, [text('后来答案')])];
  const result = output(observation(events));
  assert.deepEqual(JSON.parse(result.content).messages.map(item => item.content[0].text), ['早期问题', '早期答案', '后来问题', '后来答案']);
  assert.doesNotMatch(result.content, /HIDDEN_/);
});

test('fork keeps inherited prefix once without reading parent or descendants', () => {
  const events = [user(0, '继承问题'), assistant(1, [text('继承答案')]), event(2, 'session/end-seed', {}), user(3, '分支问题'), assistant(4, [text('分支答案')])];
  const source = observation(events, { header: { id: SID, createdAt: NOW, parentSession: 'parent-id', isSeeded: true }, inheritedEventCount: 2 });
  const data = document(source);
  assert.equal(data.session.parentSessionId, 'parent-id');
  assert.equal(data.snapshot.inheritedEventCount, 2);
  assert.equal(data.messages.length, 4);
  assert.equal(data.messages.filter(item => item.content[0].text === '继承问题').length, 1);
  assert.ok(!Object.hasOwn(data.session, 'isSeeded'));
});

test('live running snapshot excludes uncommitted streams and attempts; interrupted flag stays', () => {
  const events = [user(0, '问题'), event(1, 'turn/start', { turn: 1 }), event(2, 'assistant/attempt', { stream: [{ text: 'HIDDEN_ATTEMPT' }] }),
    assistant(3, [text('已记录的部分答案')], { interrupted: true, stream: [{ text: 'HIDDEN_STREAM_TOKENS' }] }),
    event(4, 'request/stream', { text: 'HIDDEN_UNCOMMITTED' }), event(5, 'step/start', { step: 2 })];
  const result = output(observation(events, { source: 'live' }));
  const data = JSON.parse(result.content);
  assert.equal(data.messages[1].interrupted, true);
  assert.equal(data.snapshot.throughSeq, 5);
  assert.deepEqual(data.warnings.map(w => w.code), ['LIVE_SNAPSHOT']);
  assert.match(data.warnings[0].message, /未提交/);
  assert.doesNotMatch(result.content, /HIDDEN_|lossless|无损/);
  const md = output(observation(events, { source: 'live' }), { format: 'markdown' }).content;
  assert.match(md, /已中断/);
  assert.match(md, /未提交/);
});

test('tools are opt-in, allowlisted and deduplicated by call id rather than text', () => {
  const args = ' { "command": "echo hi" } \n';
  const a = assistant(1, [text('运行工具'), { ...callBlock('c1', 'shell', args), metadata: 'HIDDEN_CALL_META' }]);
  const resultEvent = tool(3, 'c1', [text('hi\n'), { type: 'reasoning', text: 'HIDDEN_REASONING' }], { isError: false, secret: 'HIDDEN_TOOL_EXTRA' });
  resultEvent.data.meta = { secret: 'HIDDEN_META' };
  resultEvent.data.error = { reason: 'HIDDEN_ERROR_META' };
  const source = observation([user(0, '执行'), a, call(2, 'c1', 'shell', args), resultEvent]);
  assert.deepEqual(document(source).messages.map(m => m.role), ['user', 'assistant']);
  assert.deepEqual(document(source).messages[1].content, [text('运行工具')]);
  const result = output(source, { includeTools: true });
  const data = JSON.parse(result.content);
  assert.equal(data.messages.length, 3);
  assert.deepEqual(data.messages[1].content[1], callBlock('c1', 'shell', args));
  assert.equal(data.messages[2].toolCallId, 'c1');
  assert.equal(data.messages[2].isError, false);
  assert.deepEqual(data.messages[2].content, [text('hi\n')]);
  assert.doesNotMatch(result.content, /HIDDEN_/);
});

test('standalone log calls and tool errors export safely only with tools enabled', () => {
  const source = observation([call(0, 'standalone', 'fetch', '{"url":"https://example.com"}'), tool(1, 'standalone', [text('明确失败')], { isError: true })]);
  assert.equal(document(source).messages.length, 0);
  const data = document(source, { includeTools: true });
  assert.deepEqual(data.messages.map(m => m.role), ['assistant', 'tool']);
  assert.equal(data.messages[0].content[0].name, 'fetch');
  assert.equal(data.messages[1].isError, true);
});

test('canonical tool/result data.error marks failure without copying error metadata', () => {
  for (const flag of [undefined, false]) {
    const failure = tool(1, 'failed', [text('公开的工具失败说明')], flag === undefined ? {} : { isError: flag });
    failure.data.error = { name: 'HarnessError', code: 'FAILED_TOOL', reason: 'HIDDEN_REASON', path: 'HIDDEN_PATH', stack: 'HIDDEN_STACK' };
    const source = observation([call(0, 'failed', 'read', '{}'), failure]);
    assert.equal(document(source).messages.length, 0);
    const result = output(source, { includeTools: true });
    const data = JSON.parse(result.content);
    assert.equal(data.messages[1].isError, true);
    assert.deepEqual(data.messages[1].content, [text('公开的工具失败说明')]);
    assert.doesNotMatch(result.content, /HIDDEN_|HarnessError|FAILED_TOOL/);
    assert.match(output(source, { format: 'markdown', includeTools: true }).content, /工具错误：是/);
  }
  const failedAnswer = tool(1, 'ask-failed', [text(answers(['不是用户回答']))]);
  failedAnswer.data.error = { name: 'HarnessError', code: 'FAILED_TOOL' };
  const source = observation([call(0, 'ask-failed', 'ask_user_question', qArgs), failedAnswer]);
  assert.equal(document(source).messages.filter(message => message.role === 'user').length, 0);
  assert.equal(document(source, { includeTools: true }).messages.at(-1).isError, true);
});

test('duplicate tool log appearing before assistant still prefers original assistant arguments', () => {
  const args = ' {"path":"x"}  ';
  const source = observation([call(0, 'same', 'read', args), assistant(1, [callBlock('same', 'read', args)]), tool(2, 'same', [text('x')])]);
  const data = document(source, { includeTools: true });
  assert.equal(data.messages.length, 2);
  assert.equal(data.messages[0].seq, 1);
  assert.equal(data.messages[0].id, 'a-1');
  assert.equal(data.messages[0].content[0].arguments, args);
});

test('different tool calls with identical arguments are not deduplicated by text', () => {
  const source = observation([assistant(0, [callBlock('one', 'read', '{}'), callBlock('two', 'read', '{}')]), call(1, 'one', 'read', '{}'), call(2, 'two', 'read', '{}')]);
  assert.deepEqual(document(source, { includeTools: true }).messages[0].content.map(block => block.id), ['one', 'two']);
});

test('ask_user_question normalizes questions and actual answers with or without tools', () => {
  const source = observation([assistant(0, [text('需要确认'), callBlock('ask-1', 'ask_user_question', qArgs)]), call(1, 'ask-1', 'ask_user_question', qArgs), tool(2, 'ask-1', [text(answers(['简单'], '  自定义🧪\n'))])]);
  for (const includeTools of [false, true]) {
    const data = document(source, { includeTools });
    assert.deepEqual(data.messages.map(m => m.role), ['assistant', 'assistant', 'user']);
    assert.equal(data.messages[1].id, 'qa:assistant:ask-1:0');
    assert.equal(data.messages[2].id, 'qa:user:ask-1:0');
    assert.deepEqual(data.messages[1].content, [text('  请选择模式：\n')]);
    assert.equal(data.messages[1].questionId, 'mode');
    assert.equal(data.messages[1].questionHeader, '模式');
    assert.deepEqual(data.messages[1].questionOptions, [{ label: '简单', description: '快速完成' }, { label: '深入' }]);
    assert.deepEqual(data.messages[2].content, [text('简单'), text('  自定义🧪\n')]);
    assert.equal(data.messages.some(m => m.role === 'tool'), false);
    assert.equal(data.messages.some(m => m.content.some(b => b.type === 'tool-call')), false);
  }
});

test('delayed answers use source.callId and suppress pending/result duplicates', () => {
  const delayed = user(3, answers(['深入'], '迟来的回答'), { source: { kind: 'user-question-reply', callId: 'later', secret: 'HIDDEN_LATE_SOURCE' } });
  const source = observation([call(0, 'later', 'ask_user_question', qArgs), tool(1, 'later', [text('{"pending":true,"callId":"later"}')]), assistant(2, [text('继续工作')]), delayed, tool(4, 'later', [text(answers(['深入'], '迟来的回答'))])]);
  for (const includeTools of [false, true]) {
    const data = document(source, { includeTools });
    assert.deepEqual(data.messages.map(m => m.role), ['assistant', 'assistant', 'user']);
    assert.equal(data.messages.at(-1).seq, 3);
    assert.deepEqual(data.messages.at(-1).content, [text('深入'), text('迟来的回答')]);
    assert.doesNotMatch(JSON.stringify(data), /pending|HIDDEN_/);
  }
});

test('same question id across different calls cannot misassociate answers', () => {
  const source = observation([call(0, 'first', 'ask_user_question', qArgs), call(1, 'second', 'ask_user_question', qArgs),
    tool(2, 'second', [text(answers(['第二个']))]), tool(3, 'first', [text(answers(['第一个']))]),
    user(4, answers(['HIDDEN_WRONG_CALL']), { source: { kind: 'user-question-reply', callId: 'missing' } })]);
  const data = document(source);
  assert.deepEqual(data.messages.filter(m => m.role === 'user').map(m => [m.id, m.content[0].text]), [['qa:user:second:0', '第二个'], ['qa:user:first:0', '第一个']]);
  assert.doesNotMatch(JSON.stringify(data.messages), /HIDDEN_WRONG_CALL/);
  assert.ok(data.warnings.some(w => w.code === 'UNMATCHED_QUESTION_ANSWER'));
});

test('answer metadata ignored; selected/custom strings preserved without execution', () => {
  const args = JSON.stringify({ questions: [{ id: 'a', question: '问题', private: 'HIDDEN_QUESTION_META', options: [{ label: '选择', description: '说明', private: 'HIDDEN_OPTION_META' }] }], runtime: 'HIDDEN_ARGS_META' });
  const answer = JSON.stringify({ answers: [{ id: 'a', selected: ['same', 'same'], custom: 'globalThis.__exportExecuted = true', private: 'HIDDEN_ANSWER_META' }], extra: 'HIDDEN_BATCH_META' });
  const source = observation([call(0, 'x', 'ask_user_question', args), tool(1, 'x', [text(answer)])]);
  const result = output(source, { includeTools: true });
  const data = JSON.parse(result.content);
  assert.deepEqual(data.messages[1].content.map(block => block.text), ['same', 'same', 'globalThis.__exportExecuted = true']);
  assert.equal(globalThis.__exportExecuted, undefined);
  assert.doesNotMatch(result.content, /HIDDEN_/);
});

test('malformed, mismatched, error, or future question association never fabricates user dialogue', () => {
  const unknownId = JSON.stringify({ answers: [{ id: 'wrong', selected: ['HIDDEN_UNKNOWN_ANSWER'] }] });
  const source = observation([tool(0, 'future', [text(answers(['HIDDEN_FUTURE']))]), call(1, 'broken', 'ask_user_question', 'NOT_JSON'),
    tool(2, 'broken', [text(answers(['HIDDEN_BROKEN']))]), call(3, 'future', 'ask_user_question', qArgs),
    tool(4, 'future', [text(unknownId)]), tool(5, 'future', [text(answers(['HIDDEN_ERROR']))], { isError: true }),
    user(6, '{"answers":[{"id":"mode","selected":"not an array"}]}', { source: { kind: 'user-question-reply', callId: 'future' } })]);
  const data = document(source);
  assert.equal(data.messages.filter(m => m.role === 'user').length, 0);
  assert.doesNotMatch(JSON.stringify(data), /HIDDEN_/);
  assert.ok(data.warnings.some(w => w.code === 'UNREADABLE_QUESTION'));
  assert.ok(data.warnings.some(w => w.code === 'UNMATCHED_QUESTION_ANSWER'));
});

test('ambiguous call ids and duplicate question ids do not infer answers', () => {
  const duplicateQuestions = JSON.stringify({ questions: [{ id: 'same', question: 'one' }, { id: 'same', question: 'two' }] });
  const source = observation([assistant(0, [callBlock('ambiguous', 'ask_user_question', qArgs)]), call(1, 'ambiguous', 'different_tool', qArgs),
    tool(2, 'ambiguous', [text(answers(['HIDDEN_AMBIGUOUS']))]), call(3, 'duplicate', 'ask_user_question', duplicateQuestions)]);
  const data = document(source);
  assert.equal(data.messages.length, 0);
  assert.deepEqual(data.warnings.map(w => w.code), ['AMBIGUOUS_TOOL_CALL', 'UNREADABLE_QUESTION']);
});

test('multiple questions and zero-choice actual answer get distinct stable role-specific IDs', () => {
  const args = JSON.stringify({ questions: [{ id: 'a', question: '甲' }, { id: 'b', question: '乙' }] });
  const answer = JSON.stringify({ answers: [{ id: 'b', selected: [] }, { id: 'a', selected: ['A'], custom: '' }] });
  const data = document(observation([call(0, 'multi/encoded', 'ask_user_question', args), tool(1, 'multi/encoded', [text(answer)])]));
  assert.deepEqual(data.messages.map(m => m.id), ['qa:assistant:multi%2Fencoded:0', 'qa:assistant:multi%2Fencoded:1', 'qa:user:multi%2Fencoded:1', 'qa:user:multi%2Fencoded:0']);
  assert.deepEqual(data.messages[2].content, [text('')]);
  assert.deepEqual(data.messages[3].content, [text('A'), text('')]);
});

test('attachment metadata allowlist never packages binary, path, URL, or unknown fields', () => {
  const file = { type: 'file', attachment: { attachmentId: HASH, name: '报告 [最终].pdf', bytes: 123, path: 'HIDDEN_PATH', url: 'HIDDEN_URL', data: 'HIDDEN_BINARY' }, secret: 'HIDDEN_BLOCK' };
  const image = { type: 'image', attachment: { attachmentId: HASH, name: '图😀.png', bytes: 456, mediaType: 'image/png', width: 640, height: 480, originalDimensions: { width: 1280, height: 960, secret: 'HIDDEN_DIMENSIONS' }, binary: 'HIDDEN_BINARY' }, offloaded: true };
  const source = observation([user(0, '', { content: [file, image] })]);
  const result = output(source);
  const data = JSON.parse(result.content);
  assert.deepEqual(data.messages[0].content, [
    { type: 'file', attachment: { attachmentId: HASH, bytes: 123, name: '报告 [最终].pdf' } },
    { type: 'image', attachment: { attachmentId: HASH, bytes: 456, mediaType: 'image/png', width: 640, height: 480, name: '图😀.png', originalDimensions: { width: 1280, height: 960 } } },
  ]);
  assert.deepEqual(data.warnings.map(w => w.code), ['ATTACHMENTS_NOT_PACKAGED']);
  assert.doesNotMatch(result.content, /HIDDEN_|offloaded/);
  const md = output(source, { format: 'markdown' }).content;
  assert.match(md, /二进制内容未打包/);
  assert.ok(md.includes('报告 \\[最终\\]\\.pdf'));
  assert.ok(!md.includes('!['));
});

test('unknown/malformed blocks produce safe placeholders, not arbitrary copies', () => {
  const source = observation([user(0, '', { content: [
    { type: 'future-secret-type', payload: 'HIDDEN_UNKNOWN', text: 'HIDDEN_TEXT' }, null,
    { type: 'text', text: { secret: 'HIDDEN_TEXT_OBJECT' } },
    { type: 'image', attachment: { attachmentId: 'file:///HIDDEN_PATH', data: 'HIDDEN_BINARY' } },
    { type: 'file', attachment: { attachmentId: HASH, bytes: -1, name: 'HIDDEN_INVALID' } },
  ] })]);
  const result = output(source, { includeTools: true });
  const data = JSON.parse(result.content);
  assert.equal(data.messages[0].content.length, 5);
  assert.ok(data.messages[0].content.every(block => block.type === 'unsupported'));
  assert.deepEqual(data.warnings.map(w => w.code), ['UNSUPPORTED_CONTENT']);
  assert.doesNotMatch(result.content, /HIDDEN_|future-secret-type/);
});

test('reasoning-only and metadata-only messages do not become empty dialogue', () => {
  const source = observation([assistant(0, [{ type: 'reasoning', text: 'hidden' }]), assistant(1, [{ type: 'tool-addition', toolName: 'hidden' }]), user(2, '', { content: [] })]);
  assert.equal(document(source).messages.length, 0);
});

test('Markdown keeps original fenced Markdown and escapes only generated metadata', () => {
  const body = '  # 原始标题\n\n```js\nconst x = "😀";\n```\n\n[原始链接](https://example.com)\n<script>source text</script>  \n';
  const title = '<img src=x onerror=alert(1)>\r\n# forged [link](javascript:bad)';
  const source = observation([event(0, 'session/title', { title }), user(1, body), assistant(2, [text(body)])]);
  const result = output(source, { format: 'markdown' });
  assert.equal(result.content.split(body).length - 1, 2);
  assert.ok(result.content.includes('&lt;img src=x onerror=alert\\(1\\)&gt;'));
  assert.ok(result.content.includes('\\# forged \\[link\\]\\(javascript:bad\\)'));
  assert.ok(!result.content.includes(title));
  assert.match(result.content, /^# 对话导出/);
  assert.equal(result.bytes, Buffer.byteLength(result.content));
  assert.equal(escapeMarkdownMetadata('a\r\nb <x> [z]'), 'a  b &lt;x&gt; \\[z\\]');
});

test('tool fences are longer than every embedded backtick run', () => {
  const args = '  {"payload":"``````\\n# attack"}\n';
  const response = 'tool output\n```\n~~~\n# text\n';
  const source = observation([assistant(0, [callBlock('c', '<unsafe>', args)]), tool(1, 'c', [text(response)])]);
  const md = output(source, { format: 'markdown', includeTools: true }).content;
  assert.ok(md.includes(`\`\`\`\`\`\`\`json\n${args}\`\`\`\`\`\`\`\n`));
  assert.ok(md.includes(`\`\`\`\`text\n${response}\`\`\`\`\n`));
  assert.ok(md.includes('&lt;unsafe&gt;'));
});

test('Q&A generated metadata is escaped while actual question/custom text is intact', () => {
  const question = '原文 **问题**\n';
  const args = JSON.stringify({ questions: [{ id: 'q', question, header: '<unsafe>\n# heading', options: [{ label: '[option](x)', description: '<b>description</b>' }], multi_select: true }] });
  const answer = JSON.stringify({ answers: [{ id: 'q', selected: ['[option](x)'], custom: '  **实际回答**\n' }] });
  const source = observation([call(0, 'ask', 'ask_user_question', args), tool(1, 'ask', [text(answer)])]);
  const md = output(source, { format: 'markdown' }).content;
  assert.ok(md.includes(question));
  assert.ok(md.includes('  **实际回答**\n'));
  assert.ok(md.includes('&lt;unsafe&gt; \\# heading'));
  assert.ok(md.includes('\\[option\\]\\(x\\)：&lt;b&gt;description&lt;/b&gt;'));
});

test('filenames protect traversal, CRLF, device names, Unicode, suffix and length', () => {
  for (const title of ['../..\\file\r\nInjected: yes', 'CON', 'con.txt', 'NUL.', 'LPT9', 'COM¹.foo', 'aux', ' a. ', '<>:"/\\|?*', '😀中文'.repeat(200)]) {
    const filename = makeFilename(title, SID, 'json', NOW);
    assert.doesNotMatch(filename, /[<>:"/\\|?*\u0000-\u001f\u007f]/u);
    assert.doesNotMatch(filename, /^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/iu);
    assert.ok(!filename.startsWith('.'));
    assert.ok(!/[. ]$/.test(filename));
    assert.ok(Buffer.byteLength(filename) <= 180);
    assert.match(filename, /_20261103T085115123Z_.+\.json$/u);
    assert.ok(!filename.includes('\uFFFD'));
  }
  assert.match(makeFilename('CON', 'id', 'markdown', NOW), /^_CON_/);
  assert.match(makeFilename(' . ', 'id', 'json', NOW), /^conversation_/);
  assert.match(makeFilename('e\u0301', 'id', 'json', NOW), /^é_/u);
  assert.match(makeFilename('保留😀标题', 'id', 'markdown', NOW), /^保留😀标题_/u);
});

test('byte cap is exact UTF-8 bytes with 413 failure and no partial export', () => {
  const source = observation([user(0, '🧪中文\n'.repeat(200))]);
  for (const format of ['json', 'markdown']) {
    const baseline = output(source, { format });
    assert.equal(output(source, { format }, { maxExportBytes: baseline.bytes }).content, baseline.content);
    assert.throws(() => output(source, { format }, { maxExportBytes: baseline.bytes - 1 }), errorCode('EXPORT_TOO_LARGE', 413));
    assert.throws(() => output(source, { format }, { maxExportBytes: 1 }), error => {
      assert.equal(error.code, 'EXPORT_TOO_LARGE');
      assert.equal(error.status, 413);
      assert.match(error.message, /未截断/);
      assert.ok(!Object.hasOwn(error, 'content'));
      return true;
    });
  }
});

test('JSON escaping is identical to JSON.stringify across chunk/surrogate boundaries', () => {
  const input = 'x'.repeat(8191) + '😀' + '\n\t"\\\u0000'.repeat(4000) + '\uD800' + 'x'.repeat(8190) + '🧪\uDC00';
  const result = output(observation([user(0, input)]));
  const data = JSON.parse(result.content);
  assert.equal(data.messages[0].content[0].text, input);
  assert.equal(result.content, `${JSON.stringify(data, null, 2)}\n`);
  assert.equal(result.bytes, Buffer.byteLength(result.content));
});

test('very long messages fail explicitly rather than truncate or leak omitted metadata', () => {
  const source = observation([user(0, '文'.repeat(100000)), assistant(1, [text('last message')])]);
  assert.throws(() => output(source, {}, { maxExportBytes: 2048 }), errorCode('EXPORT_TOO_LARGE', 413));
  const result = output(source, {}, { maxExportBytes: 400000 });
  assert.equal(JSON.parse(result.content).messages[0].content[0].text.length, 100000);
  assert.equal(JSON.parse(result.content).messages[1].content[0].text, 'last message');
});

test('invalid size/time/observation inputs have explicit bounded errors', () => {
  for (const maxExportBytes of [0, -1, 1.5, Infinity, NaN, '42']) {
    assert.throws(() => output(observation(), {}, { maxExportBytes }), errorCode('INVALID_PARAMS', 400));
  }
  for (const now of [NaN, Infinity, '2026-01-01', 1e30]) assert.throws(() => output(observation(), {}, { now }), errorCode('INVALID_PARAMS', 400));
  for (const source of [null, {}, observation([], { cursor: -2 }), observation([], { inheritedEventCount: -1 }),
    observation([], { header: { id: 'wrong', createdAt: NOW } }), observation([], { header: { id: SID, createdAt: 'yesterday' } }),
    observation([{ seq: '0' }]), observation([user(0, 'text')], { events: [{ ...user(0, 'text'), time: NaN }] })]) {
    assert.throws(() => output(source), errorCode('INVALID_OBSERVATION', 500));
  }
});

test('malformed Unicode metadata does not break filenames or synthetic question ids', () => {
  const filename = makeFilename('title\uD800😀', SID, 'json', NOW);
  assert.ok(!/\p{Surrogate}/u.test(filename));
  assert.doesNotThrow(() => encodeURIComponent(filename));
  const source = observation([call(0, 'id\uD800', 'ask_user_question', qArgs), tool(1, 'id\uD800', [text(answers())])]);
  const data = document(source);
  assert.equal(data.messages[0].id, 'qa:assistant:id%ud800:0');
  assert.equal(data.messages[1].id, 'qa:user:id%ud800:0');
});

test('attachment identifiers must be strings, never coerced objects', () => {
  let executed = false;
  const attachmentId = { secret: 'HIDDEN_OBJECT', toString() { executed = true; return HASH; } };
  const source = observation([user(0, '', { content: [{ type: 'file', attachment: { attachmentId, name: 'file', bytes: 1 } }] })]);
  const result = output(source);
  assert.equal(executed, false);
  assert.equal(JSON.parse(result.content).messages[0].content[0].type, 'unsupported');
  assert.doesNotMatch(result.content, /HIDDEN_OBJECT/);
});

test('normalization is pure and deterministic for a frozen observation', () => {
  const source = freeze(observation([user(0, 'hello'), assistant(1, [callBlock('q', 'ask_user_question', qArgs)]), tool(2, 'q', [text(answers())])]));
  const before = JSON.stringify(source);
  const first = output(source);
  const second = output(source);
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(source), before);
});
