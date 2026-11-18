#!/usr/bin/env node
// Zero-dependency build: renders apps.json into index.html's card markers,
// sets the service worker's cache name from a hash of the shell sources, and
// assembles the static site into an output directory (dist/ by default).
//
// Targets:
//   azure (default)  What the Azure Static Web App deploys. Public data only:
//                    no private tiles, no sign-in loader, no private/ dir.
//   oaks             The self-hosted copy behind Caddy on oaks. Adds the
//                    sign-in loader to index.html and writes private tiles to
//                    private/tiles.json (served only behind forward_auth).
//                    Writes VERSION when a version tag is given.
//
// Usage:
//   node scripts/build.mjs [--target azure|oaks] [--out <dir>] [--apps <file>]
//                          [--version-tag <tag>] [--version-commit <sha>]
// Environment equivalents: EXPLORE_TARGET, EXPLORE_OUT, EXPLORE_APPS,
//   EXPLORE_VERSION_TAG, EXPLORE_VERSION_COMMIT, EXPLORE_VERSION_BUILT_AT.
// Flags win over environment variables.
import { readFileSync, writeFileSync, mkdirSync, cpSync, existsSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TARGETS = ['azure', 'oaks'];

const REPO_SVG = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>`;

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Options ───────────────────────────────────────────────────────────────────
function readOptions(argv, env) {
  const { values } = parseArgs({
    args: argv,
    options: {
      target: { type: 'string' },
      out: { type: 'string' },
      apps: { type: 'string' },
      'version-tag': { type: 'string' },
      'version-commit': { type: 'string' },
    },
    strict: true,
    allowPositionals: false,
  });
  const target = values.target ?? env.EXPLORE_TARGET ?? 'azure';
  if (!TARGETS.includes(target)) {
    throw new Error(`unknown target "${target}" (expected ${TARGETS.join(' or ')})`);
  }
  const versionTag = values['version-tag'] ?? env.EXPLORE_VERSION_TAG ?? '';
  const versionCommit = values['version-commit'] ?? env.EXPLORE_VERSION_COMMIT ?? '';
  if (versionTag && /[^A-Za-z0-9._-]/.test(versionTag)) {
    throw new Error(`version tag "${versionTag}" has unexpected characters`);
  }
  if (versionCommit && !/^[0-9a-f]{7,64}$/i.test(versionCommit)) {
    throw new Error(`version commit "${versionCommit}" is not a hex commit id`);
  }
  return {
    target,
    out: path.resolve(values.out ?? env.EXPLORE_OUT ?? path.join(ROOT, 'dist')),
    apps: path.resolve(values.apps ?? env.EXPLORE_APPS ?? path.join(ROOT, 'apps.json')),
    versionTag,
    versionCommit,
    builtAt: env.EXPLORE_VERSION_BUILT_AT || new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  };
}

// ── Minimal hand-rolled validation (zero-dependency, no ajv) ────────────────
function validate(data) {
  const errors = [];
  const req = (cond, msg) => { if (!cond) errors.push(msg); };

  req(data && typeof data === 'object' && !Array.isArray(data), 'root must be an object');
  if (errors.length) {
    throw new Error('apps.json failed validation:\n' + errors.map(e => `  - ${e}`).join('\n'));
  }
  req(data.version === 1, 'version must be 1');
  req(Array.isArray(data.apps), 'apps must be an array');

  const seenIds = new Set();
  for (const [i, app] of (Array.isArray(data.apps) ? data.apps : []).entries()) {
    const at = `apps[${i}] (${app?.id ?? '?'})`;
    if (!app || typeof app !== 'object') { errors.push(`${at}: must be an object`); continue; }
    req(typeof app.id === 'string' && /^[a-z0-9-]+$/.test(app.id), `${at}: invalid id`);
    req(!seenIds.has(app.id), `${at}: duplicate id`);
    seenIds.add(app.id);
    req(typeof app.name === 'string' && app.name.length > 0, `${at}: missing name`);
    req(typeof app.description === 'string' && app.description.length > 0, `${at}: missing description`);
    req(typeof app.url === 'string' && app.url.length > 0, `${at}: missing url`);
    // Anything that renders as a working link must be http(s) or a site path,
    // never javascript: or data:. Coming-soon placeholders are never linked.
    if (app.status !== 'coming-soon' && typeof app.url === 'string') {
      req(/^https?:\/\//i.test(app.url) || /^\/(?!\/)/.test(app.url),
        `${at}: url must start with https://, http:// or / unless status is coming-soon`);
    }
    req(app.repo === null || (typeof app.repo === 'string' && /^[^/]+\/[^/]+$/.test(app.repo)), `${at}: invalid repo`);
    req(app.icon && typeof app.icon.emoji === 'string', `${at}: missing icon.emoji`);
    req(['auto', 'never'].includes(app.icon?.favicon), `${at}: icon.favicon must be "auto" or "never"`);
    req(Array.isArray(app.tags), `${at}: tags must be an array`);
    req(['live', 'coming-soon', 'archived'].includes(app.status), `${at}: invalid status`);
    req(['public', 'authenticated'].includes(app.visibility), `${at}: invalid visibility`);
    req(/^\d{4}-\d{2}-\d{2}$/.test(app.added ?? ''), `${at}: invalid added date`);
    req(/^\d{4}-\d{2}-\d{2}$/.test(app.updated ?? ''), `${at}: invalid updated date`);
  }

  if (errors.length) {
    throw new Error('apps.json failed validation:\n' + errors.map(e => `  - ${e}`).join('\n'));
  }
}

// A private tile is a real (live or archived) app that needs sign-in. Coming-soon
// placeholders render publicly whatever their visibility: they carry no data.
const isPrivate = app => app.visibility === 'authenticated' && app.status !== 'coming-soon';

// ── Render one card ──────────────────────────────────────────────────────────
function renderCard(app) {
  const comingSoon = app.status === 'coming-soon';
  const keepEmoji = app.icon.favicon === 'never';
  const cardClass = comingSoon ? 'card coming-soon' : 'card';
  const keepEmojiAttr = keepEmoji ? ' data-keep-emoji' : '';
  const linkAttrs = comingSoon
    ? `href="#" aria-label="Coming soon"`
    : `href="${escapeHtml(app.url)}" target="_blank" rel="noopener"`;
  const tagClass = app.visibility === 'authenticated' ? 'tag-auth' : 'tag-public';
  const tagLabel = app.visibility === 'authenticated' ? 'Sign-in required' : 'Public';
  const wipTag = comingSoon
    ? `\n          <span class="tag tag-wip">Coming Soon</span>`
    : '';
  const repoLink = app.repo
    ? `\n          <a class="card-repo" href="https://github.com/${app.repo}" target="_blank" rel="noopener" aria-label="View source on GitHub">\n            ${REPO_SVG}\n            Repo\n          </a>`
    : '';

  return `      <div class="${cardClass}"${keepEmojiAttr}>
        <a class="card-link" ${linkAttrs}>
          <div class="card-icon"><span class="card-icon-emoji">${escapeHtml(app.icon.emoji)}</span></div>
          <div class="card-title">${escapeHtml(app.name)}</div>
          <div class="card-desc">${escapeHtml(app.description)}</div>
        </a>
        <div class="card-footer">
          <span class="tag ${tagClass}">${tagLabel}</span>${wipTag}${repoLink}
          <span class="card-arrow">→</span>
        </div>
      </div>`;
}

function renderSection(apps) {
  return apps.map(renderCard).join('\n\n');
}

// The card fields the oaks loader needs. Raw values: the loader renders them
// with textContent / setAttribute only, never innerHTML.
function privateTile(app) {
  return {
    id: app.id,
    name: app.name,
    description: app.description,
    url: app.url,
    repo: app.repo,
    icon: { emoji: app.icon.emoji, favicon: app.icon.favicon },
    tags: app.tags,
    status: app.status,
  };
}

// ── Oaks-only sign-in loader (inlined into index.html for --target oaks) ─────
function renderOaksLoader(hasPrivate) {
  return `  <style>
    .sso-bar { margin-top: 0.6rem; font-size: 0.72rem; color: var(--muted); }
    .sso-bar a, .sso-bar button {
      color: var(--muted); text-decoration: none; background: none; border: 0;
      font: inherit; cursor: pointer; padding: 0;
    }
    .sso-bar a:hover, .sso-bar button:hover { color: var(--accent); }
    .sso-bar form { display: inline; }
  </style>
  <script id="explore-sso-loader">
  // Oaks build only. Asks the sign-in hub who is signed in (/_sso/me) and, if
  // allowed, renders the private tiles from /private/tiles.json (behind
  // forward_auth). Fails quietly: on any error the page stays as it is.
  (function () {
    var HAS_PRIVATE = ${hasPrivate ? 'true' : 'false'};
    var REPO_PATH = 'M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z';

    function el(tag, cls, text) {
      var n = document.createElement(tag);
      if (cls) n.className = cls;
      if (text != null) n.textContent = String(text);
      return n;
    }
    function str(v) { return typeof v === 'string' ? v : ''; }
    function safeUrl(u) {
      u = str(u);
      return (/^https?:\\/\\//i.test(u) || /^\\/(?!\\/)/.test(u)) ? u : null;
    }
    function getJson(url) {
      return fetch(url, {
        credentials: 'same-origin',
        cache: 'no-store',
        redirect: 'error',
        headers: { 'Accept': 'application/json' }
      }).then(function (r) {
        var ct = r.headers.get('content-type') || '';
        if (!r.ok || ct.indexOf('json') === -1) return null;
        return r.json();
      });
    }
    function footer() { return document.querySelector('footer'); }
    function bar() {
      var f = footer();
      if (!f) return null;
      var b = f.querySelector('.sso-bar');
      if (!b) { b = el('p', 'sso-bar'); f.appendChild(b); }
      while (b.firstChild) b.removeChild(b.firstChild);
      return b;
    }
    function showSignIn() {
      if (!HAS_PRIVATE) return;
      var b = bar();
      if (!b) return;
      var a = el('a', null, 'Sign in');
      a.href = '/private/';
      b.appendChild(a);
    }
    function showSignedIn(me) {
      var b = bar();
      if (!b) return;
      b.appendChild(document.createTextNode('Signed in as ' + (str(me.email) || str(me.name) || 'you') + ' \\u2013 '));
      var form = el('form');
      form.method = 'post';
      form.action = '/_sso/logout';
      var csrf = el('input');
      csrf.type = 'hidden';
      csrf.name = 'csrf';
      csrf.value = str(me.csrf);
      form.appendChild(csrf);
      var btn = el('button', null, 'Sign out');
      btn.type = 'submit';
      form.appendChild(btn);
      b.appendChild(form);
    }
    function card(t) {
      var url = safeUrl(t.url);
      if (!url || !t.icon) return null;
      var c = el('div', 'card');
      c.setAttribute('data-keep-emoji', '');
      var link = el('a', 'card-link');
      link.href = url;
      link.target = '_blank';
      link.rel = 'noopener';
      var icon = el('div', 'card-icon');
      icon.appendChild(el('span', 'card-icon-emoji', str(t.icon.emoji)));
      link.appendChild(icon);
      link.appendChild(el('div', 'card-title', str(t.name)));
      link.appendChild(el('div', 'card-desc', str(t.description)));
      c.appendChild(link);
      var foot = el('div', 'card-footer');
      foot.appendChild(el('span', 'tag tag-auth', 'Sign-in required'));
      if (typeof t.repo === 'string' && /^[^\\/]+\\/[^\\/]+$/.test(t.repo)) {
        var repo = el('a', 'card-repo');
        repo.href = 'https://github.com/' + t.repo.split('/').map(encodeURIComponent).join('/');
        repo.target = '_blank';
        repo.rel = 'noopener';
        repo.setAttribute('aria-label', 'View source on GitHub');
        var NS = 'http://www.w3.org/2000/svg';
        var svg = document.createElementNS(NS, 'svg');
        svg.setAttribute('viewBox', '0 0 16 16');
        svg.setAttribute('aria-hidden', 'true');
        var p = document.createElementNS(NS, 'path');
        p.setAttribute('d', REPO_PATH);
        svg.appendChild(p);
        repo.appendChild(svg);
        repo.appendChild(document.createTextNode(' Repo'));
        foot.appendChild(repo);
      }
      foot.appendChild(el('span', 'card-arrow', '\\u2192'));
      c.appendChild(foot);
      return c;
    }
    function showTiles(data) {
      var tiles = data && Array.isArray(data.tiles) ? data.tiles : [];
      var cards = tiles.map(card).filter(Boolean);
      if (!cards.length) return;
      var f = footer();
      if (!f || !f.parentNode) return;
      var section = el('section');
      section.id = 'private-apps';
      section.appendChild(el('h2', null, '\\ud83d\\udd12 Private'));
      var grid = el('div', 'grid');
      cards.forEach(function (c) { grid.appendChild(c); });
      section.appendChild(grid);
      f.parentNode.insertBefore(section, f);
    }

    if (typeof fetch !== 'function') return;
    getJson('/_sso/me').then(function (me) {
      if (!me || me.signed_in !== true) { showSignIn(); return; }
      showSignedIn(me);
      if (!HAS_PRIVATE) return;
      return getJson('/private/tiles.json').then(showTiles);
    }).catch(function () {
      try { if (!document.querySelector('.sso-bar')) showSignIn(); } catch (e) { /* quiet */ }
    });
  }());
  </script>
`;
}

const PRIVATE_INDEX = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="refresh" content="0; url=/" />
  <title>Signed in</title>
</head>
<body>
  <p>Signed in. <a href="/">Back to explore</a></p>
  <script>location.replace('/');</script>
</body>
</html>
`;

// ── Main ──────────────────────────────────────────────────────────────────────
function build(opts) {
  const appsJsonRaw = readFileSync(opts.apps, 'utf8');
  const data = JSON.parse(appsJsonRaw);
  validate(data);

  const oaks = opts.target === 'oaks';
  const publicApps = data.apps.filter(a => a.visibility === 'public');
  // Authenticated placeholders (coming-soon) still render in the public page.
  const authPlaceholders = data.apps.filter(a => a.visibility === 'authenticated' && !isPrivate(a));
  const privateApps = data.apps.filter(isPrivate);

  const template = readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  let html = template;
  if (!html.includes('<!--APPS:PUBLIC-->') || !html.includes('<!--APPS:AUTH-->')) {
    throw new Error('index.html is missing the <!--APPS:PUBLIC--> / <!--APPS:AUTH--> markers');
  }
  const loaderMarker = /^[ \t]*<!--OAKS:LOADER-->[ \t]*\r?\n/m;
  if (!loaderMarker.test(html)) {
    throw new Error('index.html is missing the <!--OAKS:LOADER--> marker line');
  }
  html = html.replace('<!--APPS:PUBLIC-->', () => renderSection(publicApps));
  html = html.replace('<!--APPS:AUTH-->', () => renderSection(authPlaceholders));
  html = html.replace(loaderMarker, () => (oaks ? renderOaksLoader(privateApps.length > 0) : ''));

  const out = opts.out;
  mkdirSync(out, { recursive: true });
  // Files this build owns but may not emit this time: never leave a stale
  // private dir or VERSION behind from an earlier oaks build into the same dir.
  rmSync(path.join(out, 'private'), { recursive: true, force: true });
  rmSync(path.join(out, 'VERSION'), { force: true });

  writeFileSync(path.join(out, 'index.html'), html);

  // Static assets. staticwebapp.config.json is Azure's routing file; oaks uses
  // Caddy instead, so it is not shipped there.
  const assets = oaks ? ['manifest.json'] : ['manifest.json', 'staticwebapp.config.json'];
  if (oaks) rmSync(path.join(out, 'staticwebapp.config.json'), { force: true });
  for (const f of assets) {
    cpSync(path.join(ROOT, f), path.join(out, f));
  }
  if (existsSync(path.join(ROOT, 'icons'))) {
    cpSync(path.join(ROOT, 'icons'), path.join(out, 'icons'), { recursive: true });
  }

  // Service worker: name the cache from a hash of everything in the shell, so
  // any content change invalidates old caches without a hand-edited version.
  const swTemplate = readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
  const hasher = createHash('sha256').update(appsJsonRaw).update('\0').update(template)
    .update('\0').update(swTemplate).update('\0').update(readFileSync(path.join(ROOT, 'manifest.json')));
  if (oaks) hasher.update('\0oaks');
  const hash = hasher.digest('hex').slice(0, 8);
  const swCacheLine = /const CACHE\s*=\s*'[^']*';/;
  if (!swCacheLine.test(swTemplate)) {
    throw new Error("sw.js is missing the expected \"const CACHE = '...'\" line");
  }
  const sw = swTemplate.replace(swCacheLine, `const CACHE   = 'explore-${hash}';`);
  writeFileSync(path.join(out, 'sw.js'), sw);

  if (oaks) {
    mkdirSync(path.join(out, 'private'), { recursive: true });
    writeFileSync(path.join(out, 'private', 'tiles.json'),
      JSON.stringify({ version: 1, tiles: privateApps.map(privateTile) }, null, 2) + '\n');
    writeFileSync(path.join(out, 'private', 'index.html'), PRIVATE_INDEX);

    if (opts.versionTag) {
      writeFileSync(path.join(out, 'VERSION'),
        `tag=${opts.versionTag}\ncommit=${opts.versionCommit || 'unknown'}\nbuilt_at=${opts.builtAt}\n`);
    }
  } else if (opts.versionTag) {
    console.warn('build: VERSION is only written for --target oaks; ignoring the version tag');
  }

  const relOut = path.relative(process.cwd(), out);
  const shown = !relOut ? '.' : (relOut.startsWith('..') || path.isAbsolute(relOut) ? out : relOut);
  console.log(`Built ${shown}/ (target ${opts.target}) — ${publicApps.length} public app(s), `
    + `${authPlaceholders.length} sign-in placeholder(s), `
    + `${oaks ? `${privateApps.length} private` : `${privateApps.length} private omitted`}, cache explore-${hash}`
    + (oaks && opts.versionTag ? `, VERSION ${opts.versionTag}` : ''));
}

try {
  build(readOptions(process.argv.slice(2), process.env));
} catch (err) {
  console.error(`build: ${err.message}`);
  process.exit(1);
}
