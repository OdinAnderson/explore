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

function assertNoSecrets(dir, files, label) {
  for (const f of files) {
    const body = read(dir, f);
    for (const s of SECRET_STRINGS) {
      assert.ok(!body.includes(s), `${label}: ${f} must not contain "${s}"`);
    }
  }
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
      cls: a.status === 'coming-soon' ? 'card coming-soon' : 'card',
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
});

test('default build with a live private tile: no private data in any file', t => {
  const dir = tempDir(t);
  const out = path.join(dir, 'out');
  const apps = writeAppsFixture(dir, [...readApps().apps, SECRET]);
  const r = buildOk(t, ['--out', out, '--apps', apps]);
  assert.match(r.stdout, /1 private omitted/);

  const files = listFiles(out);
  assert.ok(!existsSync(path.join(out, 'private')), 'no private dir');
  assertNoSecrets(out, files.filter(f => !f.endsWith('.png')), 'default build');
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
  assert.equal(tiles.tiles.length, 1);
  assert.deepEqual(tiles.tiles[0], {
    id: SECRET.id, name: SECRET.name, description: SECRET.description, url: SECRET.url,
    repo: SECRET.repo, icon: SECRET.icon, tags: SECRET.tags, status: SECRET.status,
  });

  const html = read(out, 'index.html');
  assert.ok(!html.includes(SECRET.name), 'index.html has no private name');
  assert.ok(!html.includes(SECRET.url), 'index.html has no private url');
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
  assert.ok(!defHtml.includes('/private/'), 'default index never mentions /private/');

  const oaksHtml = read(oaks, 'index.html');
  const js = loaderScript(oaksHtml);
  assert.ok(js, 'loader present');
  assert.doesNotThrow(() => new vm.Script(js), 'loader parses');
  assert.match(js, /\/_sso\/me/);
  assert.match(js, /\/private\/tiles\.json/);
  assert.match(js, /\/_sso\/logout/);
  assert.match(js, /name = 'csrf'/);
  assert.match(js, /credentials: 'same-origin'/);
  assert.match(js, /'Accept': 'application\/json'/);
  assert.ok(!/innerHTML/.test(js), 'loader never uses innerHTML');
  // No private tiles in apps.json today: the Sign in link stays hidden.
  assert.match(js, /var HAS_PRIVATE = false;/);
});

test('oaks loader: HAS_PRIVATE reflects whether the build has private tiles', t => {
  const dir = tempDir(t);
  const apps = writeAppsFixture(dir, [...readApps().apps, SECRET]);
  const out = path.join(dir, 'out');
  buildOk(t, ['--out', out, '--target', 'oaks', '--apps', apps]);
  assert.match(loaderScript(read(out, 'index.html')), /var HAS_PRIVATE = true;/);
});

test('coming-soon placeholders render publicly whatever their visibility', t => {
  const dir = tempDir(t);
  const placeholder = { ...SECRET, id: 'soon', name: 'Soon Thing', url: '#', status: 'coming-soon' };
  const apps = writeAppsFixture(dir, [placeholder]);
  for (const target of ['azure', 'oaks']) {
    const out = path.join(dir, target);
    buildOk(t, ['--out', out, '--apps', apps, '--target', target]);
    const cards = cardsOf(read(out, 'index.html'));
    assert.deepEqual(cards, [{ cls: 'card coming-soon', href: '#', title: 'Soon Thing' }]);
    if (target === 'oaks') {
      assert.deepEqual(JSON.parse(read(out, 'private/tiles.json')).tiles, []);
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
