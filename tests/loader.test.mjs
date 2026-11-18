// Runs the oaks sign-in loader against a tiny fake DOM and stub fetch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import path from 'node:path';
import { tempDir, buildOk, read, readApps, writeAppsFixture, SECRET } from './helpers.mjs';

const PAGE = 'https://explore-new.odinz.net/catalog?x=1';

function classTokens(n) {
  const raw = [n.className, n.attributes && n.attributes.class].filter(Boolean).join(' ');
  return raw.split(/\s+/).filter(Boolean);
}

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
      if (sel.startsWith('.') ? classTokens(n).includes(sel.slice(1)) : n.tagName === sel) return n;
    }
    return null;
  }
}
class FakeText { constructor(t) { this.textContent = String(t); this.parentNode = null; } }

function makeDom() {
  const root = new FakeNode('html');
  const body = root.appendChild(new FakeNode('body'));
  const hero = body.appendChild(new FakeNode('div'));
  hero.className = 'hero';
  const footer = body.appendChild(new FakeNode('footer'));
  return {
    hero,
    footer,
    body,
    document: {
      body,
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

function loginHref(provider) {
  return 'https://auth.odinz.net/oauth/login/' + provider + '?rd=' + encodeURIComponent(PAGE);
}

function byClass(node, cls) {
  return [...node.walk()].filter(n => classTokens(n).includes(cls));
}

function pawnOf(res) {
  const header = res.body.childNodes[0];
  assert.equal(header.tagName, 'header', 'pawn sits in a header');
  assert.equal(header.className, 'explore-pawn');
  assert.equal(res.body.childNodes[1], res.hero, 'header is just above the hero');
  const pawn = header.querySelector('.id-anchor');
  assert.ok(pawn, 'pawn is in the header');
  assert.equal(pawn.tagName, 'details');
  assert.equal(pawn.attributes['data-pawn'], '');
  assert.equal(res.footer.querySelector('.sso-bar'), null, 'no footer sign-in bar');
  assert.equal([...res.footer.walk()].some(n => n.tagName === 'a' && n.href === '/private/'), false);
  return pawn;
}

async function runLoader(js, fetchImpl) {
  const dom = makeDom();
  const calls = [];
  const errors = [];
  const sandbox = {
    document: dom.document,
    location: { href: PAGE },
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

function assertSignedOutPawn(pawn) {
  assert.equal(pawn.attributes['data-state'], 'signed-out');
  const summary = pawn.querySelector('summary');
  assert.equal(summary.className, 'pawn-btn');
  assert.equal(summary.attributes['aria-label'], 'Sign in');
  assert.equal(summary.attributes['aria-expanded'], 'false');
  assert.equal(summary.attributes['aria-haspopup'], 'dialog');
  assert.equal(summary.attributes['aria-controls'], 'pawn-menu');
  assert.ok(summary.querySelector('.pawn-chip'));
  assert.ok(summary.querySelector('.pawn-icon'), 'empty pawn chip');
  assert.equal(summary.querySelector('.pawn-face-filled'), null);
  assert.equal(summary.querySelector('.pawn-label'), null);
  const links = byClass(pawn, 'provider-btn');
  assert.equal(links.length, 2);
  assert.equal(links[0].tagName, 'a');
  assert.equal(links[0].textContent, 'Sign in with Microsoft');
  assert.equal(links[0].href, loginHref('microsoft'));
  assert.equal(links[1].textContent, 'Sign in with Google');
  assert.equal(links[1].href, loginHref('google'));
  assert.equal(pawn.querySelector('form'), null);
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
    if (url === '/_sso/me') {
      return jsonResponse(200, {
        signed_in: true, email: 'a@example.com', name: 'Ada Lovelace',
        provider: 'microsoft', csrf: 'tok123',
      });
    }
    if (url === '/private/tiles.json') return jsonResponse(200, tiles);
    return jsonResponse(404, null);
  });
  assert.deepEqual(res.calls.map(c => c.url), ['/_sso/me', '/private/tiles.json']);
  for (const c of res.calls) {
    assert.equal(c.opts.credentials, 'same-origin');
    assert.equal(c.opts.headers.Accept, 'application/json');
  }
  const pawn = pawnOf(res);
  assert.equal(pawn.attributes['data-state'], 'signed-in');
  const summary = pawn.querySelector('summary');
  assert.equal(summary.attributes['aria-label'], 'Account menu, signed in as Ada Lovelace');
  assert.equal(summary.attributes['aria-haspopup'], 'dialog');
  assert.equal(summary.querySelector('.pawn-face-filled').textContent, 'AL');
  assert.equal(summary.querySelector('.pawn-label').textContent, 'Ada Lovelace');
  assert.equal(summary.querySelector('.pawn-icon'), null);
  assert.equal(pawn.querySelector('.account-name').textContent, 'Ada Lovelace');
  assert.equal(pawn.querySelector('.account-email').textContent, 'a@example.com');
  assert.equal(pawn.querySelector('.account-provider').textContent, 'Signed in with Microsoft');
  const form = pawn.querySelector('form');
  assert.equal(form.className, 'account-signout');
  assert.equal(form.method, 'post');
  assert.equal(form.action, '/_sso/logout');
  const csrf = form.querySelector('input');
  assert.equal(csrf.name, 'csrf');
  assert.equal(csrf.value, 'tok123');
  const btn = form.querySelector('button');
  assert.equal(btn.className, 'signout-btn');
  assert.equal(btn.type, 'submit');
  assert.equal(btn.textContent, 'Sign out');
  assert.equal(pawn.textContent.includes('everywhere'), false);
  assert.equal(/signed in to/i.test(pawn.textContent), false);
  assert.equal(res.footer.querySelector('.sso-bar'), null);

  const section = res.root.querySelector('section');
  assert.ok(section, 'private section inserted');
  assert.match(section.textContent, /Private/);
  const cards = [...section.walk()].filter(n => n.className === 'card');
  assert.equal(cards.length, 1, 'the javascript: tile is dropped');
  assert.equal(cards[0].querySelector('.card-title').textContent, '<img src=x onerror=alert(1)>');
  assert.equal(cards[0].querySelector('.card-link').href, SECRET.url);
  assert.deepEqual(res.errors, []);
});

test('loader: signed out shows the pawn with hub provider links, and no private tiles', async t => {
  const js = loader(t, [...readApps().apps, SECRET]);
  const res = await runLoader(js, async () => jsonResponse(200, { signed_in: false }));
  assert.deepEqual(res.calls.map(c => c.url), ['/_sso/me']);
  assertSignedOutPawn(pawnOf(res));
  assert.equal(res.root.querySelector('section'), null);
  assert.deepEqual(res.errors, []);
});

test('loader: hub missing or failing stays on the signed-out pawn', async t => {
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
    assertSignedOutPawn(pawnOf(res));
  }
});

test('loader: pawn stays when the build has no private tiles', async t => {
  const js = loader(t); // the real apps.json: no private tiles today
  const signedOut = await runLoader(js, async () => jsonResponse(401, null));
  assert.deepEqual(signedOut.calls.map(c => c.url), ['/_sso/me']);
  assertSignedOutPawn(pawnOf(signedOut));
  assert.equal(signedOut.root.querySelector('section'), null);
  assert.deepEqual(signedOut.errors, []);

  const signedIn = await runLoader(js, async () => jsonResponse(200, {
    signed_in: true, email: 'a@example.com', name: 'Ada Lovelace',
    provider: 'microsoft', csrf: 'tok123',
  }));
  assert.deepEqual(signedIn.calls.map(c => c.url), ['/_sso/me'], 'no tile fetch without private tiles');
  const pawn = pawnOf(signedIn);
  assert.equal(pawn.attributes['data-state'], 'signed-in');
  assert.equal(pawn.querySelector('.pawn-face-filled').textContent, 'AL');
  assert.equal(signedIn.root.querySelector('section'), null);
  assert.deepEqual(signedIn.errors, []);
});

test('loader: signed in but not allowed (403) keeps the signed-in pawn and skips private tiles', async t => {
  const js = loader(t, [...readApps().apps, SECRET]);
  const res = await runLoader(js, async url => (url === '/_sso/me'
    ? jsonResponse(200, {
      signed_in: true, email: 'b@example.com', name: 'Bea Example',
      provider: 'google', csrf: 'c',
    })
    : jsonResponse(403, null)));
  const pawn = pawnOf(res);
  assert.equal(pawn.attributes['data-state'], 'signed-in');
  assert.equal(pawn.querySelector('.pawn-face-filled').textContent, 'BE');
  assert.equal(pawn.querySelector('.account-name').textContent, 'Bea Example');
  assert.equal(pawn.querySelector('.account-email').textContent, 'b@example.com');
  assert.equal(pawn.querySelector('.account-provider').textContent, 'Signed in with Google');
  assert.equal(pawn.querySelector('button').textContent, 'Sign out');
  assert.equal(res.root.querySelector('section'), null);
});

test('loader: initials come from the name, else the email local part', async t => {
  const js = loader(t);
  const cases = [
    [{ name: 'Ada Lovelace', email: 'x@y.z', provider: 'microsoft' }, 'AL', 'Ada Lovelace', 'Signed in with Microsoft'],
    [{ name: 'Pat', email: 'pat@example.com', provider: 'google' }, 'PA', 'Pat', 'Signed in with Google'],
    [{ name: '', email: 'ada.lovelace@example.com', provider: 'microsoft' }, 'AL', 'ada.lovelace', 'Signed in with Microsoft'],
    [{ name: '', email: 'a@example.com', provider: '' }, 'A', 'a', 'Signed in'],
  ];
  for (const [me, ini, label, via] of cases) {
    const res = await runLoader(js, async () => jsonResponse(200, { signed_in: true, csrf: 't', ...me }));
    const pawn = pawnOf(res);
    assert.equal(pawn.querySelector('.pawn-face-filled').textContent, ini);
    assert.equal(pawn.querySelector('.pawn-label').textContent, label);
    assert.equal(pawn.querySelector('.account-name').textContent, label);
    assert.equal(pawn.querySelector('.account-email').textContent, me.email);
    assert.equal(pawn.querySelector('.account-provider').textContent, via);
    assert.equal(res.root.querySelector('section'), null);
  }
});
