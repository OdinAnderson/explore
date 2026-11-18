// Runs the oaks sign-in loader against a tiny fake DOM and stub fetch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import path from 'node:path';
import { tempDir, buildOk, read, readApps, writeAppsFixture, SECRET } from './helpers.mjs';

class FakeNode {
  constructor(tag) {
    this.tagName = tag;
    this.childNodes = [];
    this.attributes = {};
    this.className = '';
    this.parentNode = null;
    this._text = '';
  }
  get firstChild() { return this.childNodes[0] ?? null; }
  set textContent(v) { this.childNodes = []; this._text = String(v); }
  get textContent() { return this._text + this.childNodes.map(c => c.textContent).join(''); }
  set innerHTML(v) { throw new Error('innerHTML must not be used'); }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  appendChild(c) { c.parentNode = this; this.childNodes.push(c); return c; }
  removeChild(c) { this.childNodes = this.childNodes.filter(x => x !== c); c.parentNode = null; return c; }
  insertBefore(c, ref) {
    c.parentNode = this;
    const i = this.childNodes.indexOf(ref);
    this.childNodes.splice(i < 0 ? this.childNodes.length : i, 0, c);
    return c;
  }
  *walk() { for (const c of this.childNodes) { yield c; if (c.walk) yield* c.walk(); } }
  querySelector(sel) {
    for (const n of this.walk()) {
      if (sel.startsWith('.') ? (n.className || '').split(' ').includes(sel.slice(1)) : n.tagName === sel) return n;
    }
    return null;
  }
}
class FakeText { constructor(t) { this.textContent = String(t); this.parentNode = null; } }

function makeDom() {
  const root = new FakeNode('html');
  const body = root.appendChild(new FakeNode('div'));
  const footer = body.appendChild(new FakeNode('footer'));
  return {
    footer,
    document: {
      createElement: t => new FakeNode(t),
      createElementNS: (_ns, t) => new FakeNode(t),
      createTextNode: t => new FakeText(t),
      querySelector: sel => root.querySelector(sel),
    },
    root,
  };
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: k => (k.toLowerCase() === 'content-type' ? 'application/json' : null) },
    json: async () => body,
  };
}

async function runLoader(js, fetchImpl) {
  const dom = makeDom();
  const calls = [];
  const errors = [];
  const sandbox = {
    document: dom.document,
    console: { error: (...a) => errors.push(a), warn: (...a) => errors.push(a), log() {} },
    fetch: (url, opts) => { calls.push({ url, opts }); return fetchImpl(url, opts); },
  };
  vm.runInNewContext(js, sandbox);
  for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r));
  return { ...dom, calls, errors };
}

function loader(t, apps) {
  const dir = tempDir(t);
  const out = path.join(dir, 'out');
  const args = ['--out', out, '--target', 'oaks'];
  if (apps) args.push('--apps', writeAppsFixture(dir, apps));
  buildOk(t, args);
  return read(out, 'index.html').match(/<script id="explore-sso-loader">([\s\S]*?)<\/script>/)[1];
}

test('loader: signed in renders private cards with textContent and a sign-out form', async t => {
  const js = loader(t, [...readApps().apps, SECRET]);
  // The build already rejects javascript: urls; this payload checks the
  // client-side guard and escaping on their own.
  const tiles = { version: 1, tiles: [
    { ...SECRET, name: '<img src=x onerror=alert(1)>' },
    { ...SECRET, id: 'evil', url: 'javascript:alert(1)' },
  ] };
  const res = await runLoader(js, async url => {
    if (url === '/_sso/me') return jsonResponse(200, { signed_in: true, email: 'a@example.com', csrf: 'tok123' });
    if (url === '/private/tiles.json') return jsonResponse(200, tiles);
    return jsonResponse(404, null);
  });
  assert.deepEqual(res.calls.map(c => c.url), ['/_sso/me', '/private/tiles.json']);
  for (const c of res.calls) {
    assert.equal(c.opts.credentials, 'same-origin');
    assert.equal(c.opts.headers.Accept, 'application/json');
  }
  const barNode = res.footer.querySelector('.sso-bar');
  assert.match(barNode.textContent, /Signed in as a@example\.com/);
  assert.match(barNode.textContent, /Sign out/);
  const form = barNode.querySelector('form');
  assert.equal(form.method, 'post');
  assert.equal(form.action, '/_sso/logout');
  const csrf = form.querySelector('input');
  assert.equal(csrf.name, 'csrf');
  assert.equal(csrf.value, 'tok123');

  const section = res.root.querySelector('section');
  assert.ok(section, 'private section inserted');
  assert.match(section.textContent, /Private/);
  const cards = [...section.walk()].filter(n => n.className === 'card');
  assert.equal(cards.length, 1, 'the javascript: tile is dropped');
  assert.equal(cards[0].querySelector('.card-title').textContent, '<img src=x onerror=alert(1)>');
  assert.equal(cards[0].querySelector('.card-link').href, SECRET.url);
  assert.deepEqual(res.errors, []);
});

test('loader: signed out shows a Sign in link to /private/ when there are private tiles', async t => {
  const js = loader(t, [...readApps().apps, SECRET]);
  const res = await runLoader(js, async () => jsonResponse(200, { signed_in: false }));
  assert.deepEqual(res.calls.map(c => c.url), ['/_sso/me']);
  const a = res.footer.querySelector('a');
  assert.equal(a.textContent, 'Sign in');
  assert.equal(a.href, '/private/');
  assert.equal(res.root.querySelector('section'), null);
});

test('loader: hub missing or failing is quiet', async t => {
  const js = loader(t, [...readApps().apps, SECRET]);
  const failures = [
    async () => { throw new TypeError('Failed to fetch'); },
    async () => jsonResponse(404, null),
    async () => ({ ok: true, status: 200, headers: { get: () => 'text/html' }, json: async () => { throw new SyntaxError('html'); } }),
  ];
  for (const f of failures) {
    const res = await runLoader(js, f);
    assert.deepEqual(res.errors, []);
    assert.equal(res.root.querySelector('section'), null);
    assert.equal(res.footer.querySelector('a').href, '/private/', 'falls back to the Sign in link');
  }
});

test('loader: no Sign in link when the build has no private tiles', async t => {
  const js = loader(t); // the real apps.json: no private tiles today
  const res = await runLoader(js, async () => jsonResponse(401, null));
  assert.equal(res.footer.querySelector('.sso-bar'), null);
  assert.deepEqual(res.errors, []);
});

test('loader: signed in but not allowed (403) shows no private section', async t => {
  const js = loader(t, [...readApps().apps, SECRET]);
  const res = await runLoader(js, async url => (url === '/_sso/me'
    ? jsonResponse(200, { signed_in: true, email: 'b@example.com', csrf: 'c' })
    : jsonResponse(403, null)));
  assert.match(res.footer.querySelector('.sso-bar').textContent, /Signed in as b@example\.com/);
  assert.equal(res.root.querySelector('section'), null);
});
