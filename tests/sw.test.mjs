// Runs the built sw.js in a vm sandbox with stub caches/fetch and checks which
// requests it takes over (respondWith) and what it deletes on activate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import path from 'node:path';
import { tempDir, buildOk, read } from './helpers.mjs';

const ORIGIN = 'https://explore-new.odinz.net';

function loadSw(source, cacheState) {
  const listeners = {};
  const deleted = { caches: [], entries: [] };
  const makeCache = name => ({
    keys: async () => (cacheState[name] ?? []).map(p => ({ url: ORIGIN + p })),
    delete: async req => { deleted.entries.push(new URL(req.url).pathname); return true; },
    match: async () => undefined,
    put: async () => {},
    addAll: async () => {},
  });
  const sandbox = {
    URL,
    Response: class {},
    Promise,
    location: { origin: ORIGIN },
    fetch: async () => ({ ok: true, clone() { return this; } }),
    caches: {
      keys: async () => Object.keys(cacheState),
      delete: async k => { deleted.caches.push(k); return true; },
      open: async name => makeCache(name),
      match: async () => undefined,
    },
    self: {
      addEventListener: (type, fn) => { listeners[type] = fn; },
      skipWaiting() {},
      clients: { claim() {} },
    },
  };
  vm.runInNewContext(source, sandbox);
  return { listeners, deleted };
}

function handles(listeners, pathname, method = 'GET') {
  let responded = false;
  listeners.fetch({
    request: { url: ORIGIN + pathname, method },
    respondWith(p) { responded = true; Promise.resolve(p).catch(() => {}); },
  });
  return responded;
}

function builtSw(t) {
  const out = tempDir(t);
  buildOk(t, ['--out', path.join(out, 'site'), '--target', 'oaks']);
  return read(path.join(out, 'site'), 'sw.js');
}

test('sw.js: /private/*, /_sso/*, /healthz and /VERSION are network-only', t => {
  const { listeners } = loadSw(builtSw(t), {});
  for (const p of ['/private/', '/private/tiles.json', '/private', '/_sso/me', '/_sso/callback?x=1',
    '/healthz', '/VERSION']) {
    assert.equal(handles(listeners, p), false, `${p} goes straight to the network`);
  }
  for (const p of ['/', '/manifest.json', '/icons/icon-192.png', '/apps/x/']) {
    assert.equal(handles(listeners, p), true, `${p} is handled by the worker as before`);
  }
  assert.equal(handles(listeners, '/', 'POST'), false, 'non-GET is untouched');
  // Prefix matching is by path segment, not substring.
  assert.equal(handles(listeners, '/privateer'), true);
});

test('sw.js: activate deletes old caches and cached private/sign-in entries', async t => {
  const source = builtSw(t);
  const cacheName = source.match(/const CACHE\s*=\s*'([^']*)';/)[1];
  const { listeners, deleted } = loadSw(source, {
    'explore-old': ['/'],
    [cacheName]: ['/', '/manifest.json', '/private/tiles.json', '/_sso/me', '/apps/x/'],
  });
  let done;
  listeners.activate({ waitUntil(p) { done = p; } });
  await done;
  assert.deepEqual(deleted.caches, ['explore-old']);
  assert.deepEqual(deleted.entries.sort(), ['/_sso/me', '/private/tiles.json']);
});
