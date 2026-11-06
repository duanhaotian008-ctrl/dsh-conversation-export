import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// Exercise the shipped ModuleLoader entry, not a second implementation.
// This is a controlled Client contract test, not a real-browser download test.
const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
const MENU = 'sidebar.workspaces.session.menu.item';
const OVERLAY = 'shell.overlay';
const tick = () => new Promise(resolve => setImmediate(resolve));

function setup(fetchImpl = async () => new Response('{}')) {
  let entry;
  let getSnapshot;
  let nextId = 0;
  const registrations = new Map();
  const locales = new Map();
  const cleanups = [];
  const frames = new Map();
  const revoked = [];
  const blobs = [];
  const requests = [];
  const React = {
    Fragment: Symbol('Fragment'),
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }),
    useRef: () => ({ current: null }),
    useId: () => 'test-dialog',
    useEffect() {},
    useLayoutEffect() {},
    useSyncExternalStore(_subscribe, get) { getSnapshot = get; return get(); },
  };
  class BlobURL extends URL {
    static createObjectURL(blob) { blobs.push(blob); return `blob:fixture-${blobs.length}`; }
    static revokeObjectURL(url) { revoked.push(url); }
  }
  const window = {
    __ModuleLoader__: { load(value) { entry = value; } },
    requestAnimationFrame(callback) { const id = ++nextId; frames.set(id, callback); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
    setTimeout: () => ++nextId,
    clearTimeout() {},
  };
  vm.runInNewContext(source, {
    window, URL: BlobURL, URLSearchParams, AbortController,
    fetch(url, options) { requests.push({ url, options }); return fetchImpl(url, options); },
  }, { filename: 'client.js' });
  assert.equal(entry.id, '@local/dsh-conversation-export');
  const plugin = entry.factory(name => { assert.equal(name, 'react'); return React; });
  assert.deepEqual(Array.from(plugin.inject), ['slots', 'locale']);
  plugin.apply({
    effect(fn) { const cleanup = fn(); if (typeof cleanup === 'function') cleanups.push(cleanup); },
    locale: { register(ns, language, dict) {
      assert.equal(ns, 'local.conversation-export');
      locales.set(language, dict);
      return () => locales.delete(language);
    } },
    slots: {
      inject(name, callback) { assert.ok([MENU, OVERLAY].includes(name)); cleanups.push(callback()); },
      register(options, component) {
        registrations.set(options.name, { options, component });
        return () => registrations.delete(options.name);
      },
    },
  });
  const t = key => locales.get('en')[key] || key;
  function overlay() { return registrations.get(OVERLAY).component({ t }); }
  overlay();
  function find(node, predicate) {
    if (!node || typeof node !== 'object') return undefined;
    if (predicate(node)) return node;
    for (const child of node.children || []) {
      const found = find(child, predicate);
      if (found) return found;
    }
  }
  function dialog() {
    const node = find(overlay(), item => typeof item.type === 'function');
    assert.ok(node, 'dialog is mounted');
    return node.type(node.props);
  }
  function flushFrames() {
    while (frames.size) {
      const callbacks = [...frames.values()];
      frames.clear();
      callbacks.forEach(callback => callback());
    }
  }
  function open(sessionId = 'row-session', displayTitle = '中文标题') {
    let dismissed = false;
    let stopped = false;
    const props = { sessionId, displayTitle, t, useMenuOpenState: () => [true, value => { dismissed = !value; }] };
    const tree = registrations.get(MENU).component(props);
    const button = find(tree, item => item.props.role === 'menuitem');
    button.props.onClick({
      stopPropagation() { stopped = true; },
      currentTarget: { ownerDocument: { activeElement: null } },
    });
    props.sessionId = 'later-selection';
    flushFrames();
    assert.ok(dismissed && stopped);
  }
  function submit() {
    find(dialog(), node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  }
  function cancel() {
    find(dialog(), node => node.type === 'button' && node.children.includes(t('cancel'))).props.onClick();
    flushFrames();
  }
  function setFormat(value) {
    find(dialog(), node => node.type === 'input' && node.props.value === value).props.onChange();
  }
  function setTools(value) {
    find(dialog(), node => node.type === 'input' && node.props.type === 'checkbox').props.onChange({ target: { checked: value } });
  }
  return {
    registrations, locales, requests, blobs, revoked, open, submit, cancel, setFormat, setTools,
    state: () => getSnapshot(),
    dispose() { for (const cleanup of cleanups.reverse()) cleanup?.(); },
  };
}

test('client registers the retained DSH menu/overlay slots and owns cleanup', () => {
  const env = setup();
  assert.equal(env.registrations.size, 2);
  assert.equal(env.registrations.get(MENU).options.order, 500);
  assert.equal(env.registrations.get(OVERLAY).options.locale, 'local.conversation-export');
  assert.deepEqual([...env.locales.keys()], ['zh', 'en']);
  assert.equal(env.state(), null);
  env.dispose();
  assert.equal(env.registrations.size, 0);
  assert.equal(env.locales.size, 0);
});

test('menu captures its row owner and starts with private Markdown defaults', () => {
  const env = setup();
  env.open('noncurrent-session', '未打开的会话');
  assert.equal(env.state().sessionId, 'noncurrent-session');
  assert.equal(env.state().displayTitle, '未打开的会话');
  assert.equal(env.state().format, 'markdown');
  assert.equal(env.state().includeTools, false);
  env.dispose();
});

test('client fetches the captured row with same-origin credentials and consumes download headers', async () => {
  const env = setup(async () => new Response('{"messages":[]}', { headers: {
    'Content-Disposition': "attachment; filename=conversation.json; filename*=UTF-8''%E4%B8%AD%E6%96%87.json",
    'X-DSH-Export-Messages': '0', 'X-DSH-Export-Warnings': '1',
  } }));
  env.open('row / 中文?');
  env.setFormat('json');
  env.setTools(true);
  env.submit();
  await tick();
  const { url, options } = env.requests[0];
  const query = new URL(url, 'https://fixture.test/').searchParams;
  assert.equal(query.get('sessionId'), 'row / 中文?');
  assert.equal(query.get('format'), 'json');
  assert.equal(query.get('includeTools'), 'true');
  assert.equal(options.credentials, 'same-origin');
  assert.equal(options.mode, 'same-origin');
  assert.equal(options.redirect, 'error');
  assert.equal(options.cache, 'no-store');
  assert.equal(env.state().phase, 'ready');
  assert.equal(env.state().download.filename, '中文.json');
  assert.equal(env.state().messageCount, 0);
  assert.equal(env.state().warnings, true);
  assert.equal(await env.blobs[0].text(), '{"messages":[]}');
  env.dispose();
  assert.deepEqual(env.revoked, ['blob:fixture-1']);
});

test('closing cancels in-flight requests and ignores their late results', async () => {
  let resolve;
  const env = setup(() => new Promise(done => { resolve = done; }));
  env.open();
  env.submit();
  assert.equal(env.state().phase, 'loading');
  env.cancel();
  assert.equal(env.requests[0].options.signal.aborted, true);
  resolve(new Response('late private conversation'));
  await tick();
  assert.equal(env.state(), null);
  assert.equal(env.blobs.length, 0);
  env.dispose();
});

test('reopening another row resets options and cannot reuse an earlier response', async () => {
  let resolve;
  const env = setup(() => new Promise(done => { resolve = done; }));
  env.open('first');
  env.setFormat('json');
  env.setTools(true);
  env.submit();
  env.open('second');
  resolve(new Response('first conversation'));
  await tick();
  assert.equal(env.requests[0].options.signal.aborted, true);
  assert.equal(env.state().sessionId, 'second');
  assert.equal(env.state().format, 'markdown');
  assert.equal(env.state().includeTools, false);
  assert.equal(env.state().phase, 'idle');
  assert.equal(env.blobs.length, 0);
  env.dispose();
});

test('HTTP errors use localized keys instead of exposing backend messages', async () => {
  for (const [status, code, expected] of [
    [401, 'UNAUTHORIZED', 'unauthorizedError'],
    [403, 'UNAUTHORIZED', 'forbiddenError'],
    [413, 'EXPORT_TOO_LARGE', 'tooLargeError'],
    [422, 'INVALID_OBSERVATION', 'invalidObservationError'],
    [503, 'HISTORY_UNAVAILABLE', 'historyError'],
  ]) {
    const env = setup(async () => Response.json({ error: { code, message: 'SECRET_BACKEND_PATH' } }, { status }));
    env.open();
    env.submit();
    await tick();
    assert.equal(env.state().phase, 'error');
    assert.equal(env.state().error, expected);
    assert.ok(!JSON.stringify(env.state()).includes('SECRET_BACKEND_PATH'));
    assert.equal(env.blobs.length, 0);
    env.dispose();
  }
});

test('unloading aborts an active download and removes all client contributions', async () => {
  let resolve;
  const env = setup(() => new Promise(done => { resolve = done; }));
  env.open();
  env.submit();
  env.dispose();
  resolve(new Response('private conversation'));
  await tick();
  assert.equal(env.requests[0].options.signal.aborted, true);
  assert.equal(env.state(), null);
  assert.equal(env.blobs.length, 0);
  assert.equal(env.registrations.size, 0);
});
