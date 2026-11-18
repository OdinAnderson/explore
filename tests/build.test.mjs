import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {
  tempDir, runBuild, buildOk, listFiles, read, readApps, writeAppsFixture,
  SECRET, cardsOf, unescapeHtml,
} from './helpers.mjs';

const SECRET_STRINGS = [SECRET.name, SECRET.url, 'zq7x'];
const HUB_MARKERS = ['/_sso/', 'auth.odinz.net', 'pawn.js', 'pawn.css'];
const FLOCK_NAME = 'Flock Dashboard';
const FLOCK_URL = 'https://dash.flock.odinz.net';
const PARLEY_NAME = 'Parley';
const PARLEY_URL = 'https://github.com/BeachMonkey-AI/parley';
const WODIN_URL = 'https://github.com/BeachMonkey-AI/WODin';
// Every real private tile's name and url. None may appear outside private/tiles.json.
const REAL_PRIVATE_STRINGS = [FLOCK_NAME, FLOCK_URL, PARLEY_NAME, PARLEY_URL];

function privateLive(apps) {
  return apps.filter(a => a.visibility === 'authenticated' && a.status !== 'coming-soon');
}

function cardClass(app) {
  return [
    'card',
    app.status === 'coming-soon' ? 'coming-soon' : '',
    app.status === 'coming-soon' && app.visibility === 'authenticated' ? 'private-placeholder' : '',
  ].filter(Boolean).join(' ');
}

function assertNoRealPrivate(dir, files, label) {
  for (const f of files) {
    if (f.endsWith('.png')) continue;
    const body = read(dir, f);
    for (const s of REAL_PRIVATE_STRINGS) {
      assert.ok(!body.includes(s), `${label}: ${f} must not contain "${s}"`);
    }
  }
}

function assertNoSecrets(dir, files, label) {
  for (const f of files) {
    const body = read(dir, f);
    for (const s of SECRET_STRINGS) {
      assert.ok(!body.includes(s), `${label}: ${f} must not contain "${s}"`);
    }
  }
}

function assertNoHub(dir, files, label) {
  for (const f of files) {
    if (f.endsWith('.png')) continue;
    const body = read(dir, f);
    // sw.js keeps its network-only rule for /_sso/*. That path is not an identity URL.
    const markers = f === 'sw.js'
      ? HUB_MARKERS.filter(s => s !== '/_sso/')
      : HUB_MARKERS;
    for (const s of markers) {
      assert.ok(!body.includes(s), `${label}: ${f} must not contain "${s}"`);
    }
  }
}

// The page has one "🔒 Private" section heading, it wraps the Private Tool
// placeholder, and no section is headed "Sign-in Required". The placeholder's
// footer tag "Sign-in required" (lower-case r) is a tag, not a heading, and stays.
function assertOnePrivateSection(html, label) {
  const headings = [...html.matchAll(/<h2>([^<]*)<\/h2>/g)].map(m => m[1].trim());
  assert.deepEqual(headings, ['🌐 Public', '🔒 Private'], `${label}: section headings`);
  assert.ok(!html.includes('Sign-in Required'), `${label}: no "Sign-in Required" heading`);
  assert.equal(html.match(/<section class="private-apps"/g)?.length, 1, `${label}: one Private section`);
  const m = html.match(/<section class="private-apps" id="private-apps">\s*<h2>🔒 Private<\/h2>\s*<div class="grid">([\s\S]*?)<\/div>\s*<\/section>/);
  assert.ok(m, `${label}: Private section has the heading and a grid`);
  assert.match(m[1], /data-app-id="private-tool"/, `${label}: placeholder sits in the Private section`);
  assert.match(m[1], /class="card coming-soon private-placeholder"/);
  assert.match(m[1], /<span class="tag tag-auth">Sign-in required<\/span>/, `${label}: placeholder tag unchanged`);
}

function loaderScript(html) {
  const m = html.match(/<script id="explore-sso-loader">([\s\S]*?)<\/script>/);
  return m ? m[1] : null;
}

test('default build: public cards and placeholders exactly as apps.json lists them', t => {
  const out = tempDir(t);
  buildOk(t, ['--out', out]);
  const html = read(out, 'index.html');

  const expected = readApps().apps
    .filter(a => a.visibility === 'public' || a.status === 'coming-soon')
    // Public section first, then the sign-in section's placeholders.
    .sort((a, b) => (a.visibility === 'public' ? 0 : 1) - (b.visibility === 'public' ? 0 : 1))
    .map(a => ({
      cls: cardClass(a),
      href: a.status === 'coming-soon' ? '#' : a.url,
      title: a.name,
    }));
  const got = cardsOf(html).map(c => ({ ...c, href: unescapeHtml(c.href), title: unescapeHtml(c.title) }));
  assert.deepEqual(got, expected);
  assert.ok(!html.includes('<!--APPS:'), 'card markers are replaced');
  assert.ok(!html.includes('<!--OAKS:'), 'loader marker is removed');
});

test('default build: no private dir, no VERSION, ships the SWA config', t => {
  const out = tempDir(t);
  buildOk(t, ['--out', out]);
  const files = listFiles(out);
  assert.ok(!files.some(f => f.startsWith('private/')), 'no private/ files');
  assert.ok(!existsSync(path.join(out, 'private')), 'no private dir');
  assert.ok(!files.includes('VERSION'));
  for (const f of ['index.html', 'sw.js', 'manifest.json', 'staticwebapp.config.json',
    'icons/icon-192.png', 'icons/icon-512.png']) {
    assert.ok(files.includes(f), `${f} is emitted`);
  }
  assertNoHub(out, files, 'default build');
  assertNoRealPrivate(out, files, 'default build');
  assert.equal(loaderScript(read(out, 'index.html')), null);
  assert.match(read(out, 'index.html'), /data-app-id="private-tool"/);
  assert.match(read(out, 'index.html'), /class="card coming-soon private-placeholder"/);
});

test('default build with a live private tile: no private data in any file', t => {
  const dir = tempDir(t);
  const out = path.join(dir, 'out');
  const catalog = [...readApps().apps, SECRET];
  const apps = writeAppsFixture(dir, catalog);
  const r = buildOk(t, ['--out', out, '--apps', apps]);
  assert.match(r.stdout, new RegExp(`${privateLive(catalog).length} private omitted`));

  const files = listFiles(out);
  assert.ok(!existsSync(path.join(out, 'private')), 'no private dir');
  assertNoSecrets(out, files.filter(f => !f.endsWith('.png')), 'default build');
  assertNoRealPrivate(out, files, 'default build');
  assertNoHub(out, files, 'default build');
  // The visible cards are unchanged by adding a private tile.
  const plain = path.join(dir, 'plain');
  buildOk(t, ['--out', plain]);
  assert.deepEqual(cardsOf(read(out, 'index.html')), cardsOf(read(plain, 'index.html')));
});

test('a default build into a dir that held an oaks build removes private data', t => {
  const dir = tempDir(t);
  const out = path.join(dir, 'out');
  const apps = writeAppsFixture(dir, [...readApps().apps, SECRET]);
  buildOk(t, ['--out', out, '--apps', apps, '--target', 'oaks', '--version-tag', 'v1']);
  assert.ok(existsSync(path.join(out, 'private', 'tiles.json')));
  buildOk(t, ['--out', out, '--apps', apps]);
  assert.ok(!existsSync(path.join(out, 'private')));
  assert.ok(!existsSync(path.join(out, 'VERSION')));
  assertNoSecrets(out, listFiles(out).filter(f => !f.endsWith('.png')), 'rebuilt default');
  assertNoHub(out, listFiles(out), 'rebuilt default');
});

test('oaks build: the private tile is only in private/tiles.json', t => {
  const dir = tempDir(t);
  const out = path.join(dir, 'out');
  const apps = writeAppsFixture(dir, [...readApps().apps, SECRET]);
  const r = buildOk(t, ['--out', out, '--apps', apps], { EXPLORE_TARGET: 'oaks' });
  assert.match(r.stdout, /target oaks/);

  const files = listFiles(out);
  assert.ok(files.includes('private/tiles.json'));
  assert.ok(files.includes('private/index.html'));
  assert.ok(!files.includes('staticwebapp.config.json'), 'Azure routing file is not shipped to oaks');

  const tiles = JSON.parse(read(out, 'private/tiles.json'));
  assert.equal(tiles.version, 1);
  assert.equal(tiles.tiles.length, privateLive(readApps().apps).length + 1);
  assert.deepEqual(tiles.tiles.find(tile => tile.id === SECRET.id), {
    id: SECRET.id, name: SECRET.name, description: SECRET.description, url: SECRET.url,
    repo: SECRET.repo, icon: SECRET.icon, tags: SECRET.tags, status: SECRET.status,
  });
  assert.equal(tiles.tiles.find(tile => tile.id === 'flock-dashboard').url, FLOCK_URL);
  assert.equal(tiles.tiles.find(tile => tile.id === 'parley').url, PARLEY_URL);

  const html = read(out, 'index.html');
  assert.ok(!html.includes(SECRET.name), 'index.html has no private name');
  assert.ok(!html.includes(SECRET.url), 'index.html has no private url');
  for (const s of REAL_PRIVATE_STRINGS) {
    assert.ok(!html.includes(s), `index.html has no "${s}"`);
  }
  assertNoSecrets(out, files.filter(f => f !== 'private/tiles.json' && !f.endsWith('.png')), 'oaks build');

  // Public cards are the same as the default build's.
  const plain = path.join(dir, 'plain');
  buildOk(t, ['--out', plain]);
  assert.deepEqual(cardsOf(html), cardsOf(read(plain, 'index.html')));

  const landing = read(out, 'private/index.html');
  assert.match(landing, /url=\//);
  assert.match(landing, /location\.replace\('\/'\)/);
});

test('--target flag works like EXPLORE_TARGET and unknown targets fail', t => {
  const out = tempDir(t);
  buildOk(t, ['--out', out, '--target', 'oaks']);
  assert.ok(existsSync(path.join(out, 'private', 'tiles.json')));
  const bad = runBuild(['--out', out, '--target', 'mars']);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /unknown target "mars"/);
});

test('oaks index includes the sign-in loader; the default index does not', t => {
  const dir = tempDir(t);
  const oaks = path.join(dir, 'oaks');
  const def = path.join(dir, 'def');
  buildOk(t, ['--out', oaks, '--target', 'oaks']);
  buildOk(t, ['--out', def]);

  const defHtml = read(def, 'index.html');
  assert.equal(loaderScript(defHtml), null);
  assert.ok(!defHtml.includes('/_sso/'), 'default index never mentions the hub');
  assert.ok(!defHtml.includes('auth.odinz.net'), 'default index never mentions the hub');
  assert.ok(!defHtml.includes('pawn.js') && !defHtml.includes('pawn.css'));
  assert.ok(!defHtml.includes('/private/'), 'default index never mentions /private/');
  assert.ok(!defHtml.includes('sso-bar'));

  const oaksHtml = read(oaks, 'index.html');
  assert.match(oaksHtml, /href="https:\/\/auth\.odinz\.net\/static\/pawn\.css"/);
  assert.match(oaksHtml, /src="https:\/\/auth\.odinz\.net\/static\/pawn\.js" defer/);
  assert.ok(!oaksHtml.includes('sso-bar'));
  const js = loaderScript(oaksHtml);
  assert.ok(js, 'loader present');
  assert.doesNotThrow(() => new vm.Script(js), 'loader parses');
  assert.match(js, /\/_sso\/me/);
  assert.match(js, /\/private\/tiles\.json/);
  assert.match(js, /\/_sso\/logout/);
  assert.match(js, /name = 'csrf'/);
  assert.match(js, /credentials: 'same-origin'/);
  assert.match(js, /'Accept': 'application\/json'/);
  assert.match(js, /data-pawn/);
  assert.match(js, /aria-haspopup', 'dialog'/);
  assert.match(js, /\/oauth\/login\/' \+ key/);
  const microsoft = js.indexOf("providerLink('microsoft', 'Microsoft')");
  const google = js.indexOf("providerLink('google', 'Google')");
  assert.ok(microsoft !== -1 && google !== -1 && microsoft < google, 'Microsoft is offered first');
  assert.match(js, /Sign in with '/);
  assert.match(js, /'Sign out'/);
  assert.ok(!/innerHTML/.test(js), 'loader never uses innerHTML');
  assert.ok(!js.includes('sso-bar'));
  assert.ok(!js.includes('everywhere'));
  assert.ok(!js.includes("'/private/'"), 'no footer sign-in link to /private/');
  // The real catalog's private tiles are Flock Dashboard and Parley, so the pawn loader
  // knows there is something to fetch after /_sso/me.
  assert.match(js, /var HAS_PRIVATE = true;/);
  assert.match(js, /setAttribute\('viewBox', '0 0 24 24'\)/);
  assert.match(js, /svgEl\('circle'\)/);
  assert.match(js, /M5\.4 19\.2c\.4-3\.15 3\.15-5\.4 6\.6-5\.4s6\.2 2\.25 6\.6 5\.4/);
  assert.ok(!js.includes('M22.5 9c-2.21'), 'chess pawn glyph is gone');
  assert.match(js, /querySelectorAll\('\.private-placeholder'\)/);
  for (const s of REAL_PRIVATE_STRINGS) {
    assert.ok(!oaksHtml.includes(s), `oaks index.html has no "${s}"`);
  }
});

test('oaks pawn CSS draws one accent circle, not a double ring; azure has none', t => {
  const dir = tempDir(t);
  const oaks = path.join(dir, 'oaks');
  const azure = path.join(dir, 'azure');
  buildOk(t, ['--out', oaks, '--target', 'oaks']);
  buildOk(t, ['--out', azure, '--target', 'azure']);

  const oaksHtml = read(oaks, 'index.html');
  const css = (oaksHtml.match(/<link rel="stylesheet" href="https:\/\/auth\.odinz\.net\/static\/pawn\.css">\s*<style>([\s\S]*?)<\/style>/) || [])[1];
  assert.ok(css, 'oaks inlines the .explore-pawn override block after pawn.css');
  const rule = sel => {
    const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = css.match(new RegExp(`(?:^|[},/]\\s*|\\*/\\s*)${esc}\\s*(?:,[^{]*)?\\{([^}]*)\\}`, 'm'));
    return m ? m[1] : null;
  };
  // The outer button draws no visible ring, idle or hovered.
  const btn = rule('.explore-pawn .id-anchor > .pawn-btn');
  assert.ok(btn, 'override for the outer .pawn-btn');
  assert.match(btn, /border-color: transparent/);
  assert.match(btn, /background: transparent/);
  assert.match(css, /\.explore-pawn \.id-anchor > \.pawn-btn:hover,/, 'hover keeps the outer ring hidden');
  // The remaining .pawn-chip circle uses the accent color.
  assert.match(rule('.explore-pawn .id-anchor > .pawn-btn .pawn-chip') || '', /border-color: var\(--accent\)/);
  // Hover moved onto the chip: dimmed accent border, text color.
  assert.match(rule('.explore-pawn .id-anchor > .pawn-btn:hover .pawn-chip') || '', /border-color: var\(--accent-dim\)/);
  assert.match(css, /\.explore-pawn \.id-anchor > \.pawn-btn:hover \{ color: var\(--text\); \}/);
  // Keyboard focus stays visible on the interactive element.
  assert.match(rule('.explore-pawn .id-anchor > .pawn-btn:focus-visible') || '', /outline: 2px solid var\(--accent\)/);
  // Person-outline glyph is untouched.
  const js = loaderScript(oaksHtml);
  assert.match(js, /setAttribute\('viewBox', '0 0 24 24'\)/);
  assert.match(js, /svgEl\('circle'\)/);
  assert.match(js, /M5\.4 19\.2c\.4-3\.15/);
  assert.ok(!js.includes('M22.5 9c-2.21'));

  const azureHtml = read(azure, 'index.html');
  assert.equal(loaderScript(azureHtml), null, 'azure has no pawn loader');
  assert.ok(!azureHtml.includes('pawn'), 'azure never mentions the pawn');
});

const SILENT_MARKERS = ['login?silent=1', 'edgeauth-sso-checked', 'sso=none', 'replaceState'];

test('oaks loader includes the silent hub hop; the Azure build does not', t => {
  const dir = tempDir(t);
  const oaks = path.join(dir, 'oaks');
  const azure = path.join(dir, 'azure');
  buildOk(t, ['--out', oaks, '--target', 'oaks']);
  buildOk(t, ['--out', azure]);

  const js = loaderScript(read(oaks, 'index.html'));
  assert.ok(js, 'loader present');
  for (const s of SILENT_MARKERS) {
    assert.ok(js.includes(s), `oaks loader contains ${s}`);
  }

  for (const f of listFiles(azure)) {
    if (f.endsWith('.png')) continue;
    const body = read(azure, f);
    for (const s of SILENT_MARKERS) {
      assert.ok(!body.includes(s), `azure ${f} must not contain "${s}"`);
    }
  }
});

test('oaks loader: HAS_PRIVATE reflects whether the build has private tiles', t => {
  const dir = tempDir(t);
  const apps = writeAppsFixture(dir, [...readApps().apps, SECRET]);
  const out = path.join(dir, 'out');
  buildOk(t, ['--out', out, '--target', 'oaks', '--apps', apps]);
  assert.match(loaderScript(read(out, 'index.html')), /var HAS_PRIVATE = true;/);

  const noneDir = path.join(dir, 'none');
  mkdirSync(noneDir);
  const noneApps = writeAppsFixture(noneDir, readApps().apps.filter(a => !privateLive([a]).length));
  const noneOut = path.join(dir, 'none-out');
  buildOk(t, ['--out', noneOut, '--target', 'oaks', '--apps', noneApps]);
  assert.match(loaderScript(read(noneOut, 'index.html')), /var HAS_PRIVATE = false;/);
});

test('coming-soon placeholders render publicly whatever their visibility', t => {
  const dir = tempDir(t);
  const placeholder = { ...SECRET, id: 'soon', name: 'Soon Thing', url: '#', status: 'coming-soon' };
  const apps = writeAppsFixture(dir, [placeholder]);
  for (const target of ['azure', 'oaks']) {
    const out = path.join(dir, target);
    buildOk(t, ['--out', out, '--apps', apps, '--target', target]);
    const cards = cardsOf(read(out, 'index.html'));
    assert.deepEqual(cards, [{ cls: 'card coming-soon private-placeholder', href: '#', title: 'Soon Thing' }]);
    assert.match(read(out, 'index.html'), /data-app-id="soon"/);
    if (target === 'oaks') {
      assert.deepEqual(JSON.parse(read(out, 'private/tiles.json')).tiles, []);
    }
  }
});

test('real catalog: Flock Dashboard and Parley are private, WODin and Private Tool are public', t => {
  const dir = tempDir(t);
  const azure = path.join(dir, 'azure');
  const oaks = path.join(dir, 'oaks');
  buildOk(t, ['--out', azure]);
  buildOk(t, ['--out', oaks, '--target', 'oaks']);

  for (const out of [azure, oaks]) {
    const html = read(out, 'index.html');
    const cards = cardsOf(html).map(c => ({ ...c, href: unescapeHtml(c.href), title: unescapeHtml(c.title) }));
    for (const name of ['DeepR', 'Ruin', 'Spacecraft Flight Simulator', 'Galactic Colonization Simulator', 'VRP Offer Modeler']) {
      assert.ok(cards.some(c => c.title === name && c.cls === 'card'), `${name} is a public live card`);
    }
    assert.ok(cards.some(c => c.title === 'WODin' && c.cls === 'card' && c.href === WODIN_URL), 'WODin links to its GitHub repo');
    assert.ok(cards.some(c => c.title === 'Private Tool' && c.cls === 'card coming-soon private-placeholder' && c.href === '#'));
    assert.ok(!cards.some(c => c.title === FLOCK_NAME));
    assert.ok(!cards.some(c => c.title === PARLEY_NAME));
    for (const s of REAL_PRIVATE_STRINGS) {
      assert.ok(!html.includes(s), `index.html must not contain "${s}"`);
    }
    assertOnePrivateSection(html, out);
  }

  assertNoRealPrivate(azure, listFiles(azure), 'azure');
  assert.ok(!existsSync(path.join(azure, 'private')));
  assert.equal(loaderScript(read(azure, 'index.html')), null);

  const tiles = JSON.parse(read(oaks, 'private/tiles.json'));
  assert.deepEqual(tiles.tiles.map(tile => tile.id), ['flock-dashboard', 'parley']);
  const flock = tiles.tiles[0];
  assert.equal(flock.name, FLOCK_NAME);
  assert.equal(flock.description, 'Shared Flock dashboards: backlog, snapshots, and more.');
  assert.equal(flock.url, FLOCK_URL);
  assert.equal(flock.repo, 'OdinAnderson/edge-dashboard');
  assert.deepEqual(flock.icon, { emoji: '📊', favicon: 'never' });
  assert.deepEqual(flock.tags, ['dashboard']);
  assert.equal(flock.status, 'live');
  const parley = tiles.tiles[1];
  assert.equal(parley.name, PARLEY_NAME);
  assert.equal(parley.description, 'The page where an agent hands a plan to a person and gets a structured done signal back.');
  assert.equal(parley.url, PARLEY_URL);
  assert.equal(parley.repo, 'BeachMonkey-AI/parley');
  assert.deepEqual(parley.icon, { emoji: '🤝', favicon: 'never' });
  assert.deepEqual(parley.tags, ['handoff']);
  assert.equal(parley.status, 'live');
  assert.match(loaderScript(read(oaks, 'index.html')), /var HAS_PRIVATE = true;/);
  for (const f of listFiles(oaks)) {
    if (f === 'private/tiles.json' || f.endsWith('.png')) continue;
    const body = read(oaks, f);
    for (const s of REAL_PRIVATE_STRINGS) {
      assert.ok(!body.includes(s), `oaks ${f} must not contain "${s}"`);
    }
  }
});

test('archived private tiles are private too', t => {
  const dir = tempDir(t);
  const apps = writeAppsFixture(dir, [{ ...SECRET, status: 'archived' }]);
  const out = path.join(dir, 'out');
  buildOk(t, ['--out', out, '--apps', apps, '--target', 'oaks']);
  assert.ok(!read(out, 'index.html').includes(SECRET.name));
  assert.equal(JSON.parse(read(out, 'private/tiles.json')).tiles[0].status, 'archived');
});

test('sw.js: cache name is replaced, different per target', t => {
  const dir = tempDir(t);
  const def = path.join(dir, 'def');
  const oaks = path.join(dir, 'oaks');
  buildOk(t, ['--out', def]);
  buildOk(t, ['--out', oaks, '--target', 'oaks']);
  const a = read(def, 'sw.js').match(/const CACHE\s*=\s*'([^']*)';/)[1];
  const b = read(oaks, 'sw.js').match(/const CACHE\s*=\s*'([^']*)';/)[1];
  assert.match(a, /^explore-[0-9a-f]{8}$/);
  assert.match(b, /^explore-[0-9a-f]{8}$/);
  assert.notEqual(a, 'explore-v2');
  assert.notEqual(a, b);
});

test('VERSION is written only for an oaks build that asks for it', t => {
  const dir = tempDir(t);

  const plain = path.join(dir, 'oaks-plain');
  buildOk(t, ['--out', plain, '--target', 'oaks']);
  assert.ok(!existsSync(path.join(plain, 'VERSION')));

  const flags = path.join(dir, 'oaks-flags');
  buildOk(t, ['--out', flags, '--target', 'oaks', '--version-tag', 'v2026.11.18-1',
    '--version-commit', 'c7cea6c0123456789abcdef0123456789abcdef0']);
  const v = read(flags, 'VERSION');
  assert.match(v, /^tag=v2026\.11\.18-1\n/);
  assert.match(v, /\ncommit=c7cea6c0123456789abcdef0123456789abcdef0\n/);
  assert.match(v, /\nbuilt_at=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\n$/);

  const envOut = path.join(dir, 'oaks-env');
  buildOk(t, ['--out', envOut], {
    EXPLORE_TARGET: 'oaks', EXPLORE_VERSION_TAG: 'v9', EXPLORE_VERSION_COMMIT: 'abcdef1',
    EXPLORE_VERSION_BUILT_AT: '2026-11-18T00:00:00Z',
  });
  assert.equal(read(envOut, 'VERSION'), 'tag=v9\ncommit=abcdef1\nbuilt_at=2026-11-18T00:00:00Z\n');

  const def = path.join(dir, 'default');
  buildOk(t, ['--out', def], { EXPLORE_VERSION_TAG: 'v9' });
  assert.ok(!existsSync(path.join(def, 'VERSION')), 'the Azure build never writes VERSION');

  const bad = runBuild(['--out', path.join(dir, 'bad'), '--target', 'oaks', '--version-tag', 'v1\nx=1']);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /unexpected characters/);
});

test('schema validation rejects bad entries', async t => {
  const good = readApps().apps[0];
  const cases = [
    ['bad id', [{ ...good, id: 'Bad Id' }], /invalid id/],
    ['duplicate id', [good, { ...good }], /duplicate id/],
    ['missing name', [{ ...good, name: '' }], /missing name/],
    ['javascript url', [{ ...good, url: 'javascript:alert(1)' }], /url must start with/],
    ['protocol-relative url', [{ ...good, url: '//evil.example/' }], /url must start with/],
    ['bad status', [{ ...good, status: 'beta' }], /invalid status/],
    ['bad visibility', [{ ...good, visibility: 'secret' }], /invalid visibility/],
    ['bad favicon', [{ ...good, icon: { emoji: 'x', favicon: 'maybe' } }], /icon\.favicon/],
    ['bad repo', [{ ...good, repo: 'no-slash' }], /invalid repo/],
    ['bad date', [{ ...good, added: '2026/01/01' }], /invalid added date/],
    ['null entry', [null], /must be an object/],
  ];
  for (const [name, apps, re] of cases) {
    await t.test(name, st => {
      const dir = tempDir(st);
      const file = writeAppsFixture(dir, apps);
      const r = runBuild(['--out', path.join(dir, 'out'), '--apps', file]);
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, re);
      assert.ok(!existsSync(path.join(dir, 'out')), 'nothing is written on failure');
    });
  }
  await t.test('wrong version', st => {
    const dir = tempDir(st);
    const file = path.join(dir, 'apps.json');
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify({ version: 2, apps: [] }));
    const r = runBuild(['--out', path.join(dir, 'out'), '--apps', file]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /version must be 1/);
  });
});
