#!/usr/bin/env node
// Zero-dependency build: renders apps.json into index.html's card markers,
// bumps the service worker's cache name from a hash of apps.json, and
// assembles everything Azure needs to deploy into dist/.
import { readFileSync, writeFileSync, mkdirSync, cpSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DIST = path.join(ROOT, 'dist');

const REPO_SVG = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>`;

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Minimal hand-rolled validation (zero-dependency, no ajv) ────────────────
function validate(data) {
  const errors = [];
  const req = (cond, msg) => { if (!cond) errors.push(msg); };

  req(data && typeof data === 'object', 'root must be an object');
  req(data.version === 1, 'version must be 1');
  req(Array.isArray(data.apps), 'apps must be an array');

  const seenIds = new Set();
  for (const [i, app] of (data.apps ?? []).entries()) {
    const at = `apps[${i}] (${app?.id ?? '?'})`;
    req(typeof app.id === 'string' && /^[a-z0-9-]+$/.test(app.id), `${at}: invalid id`);
    req(!seenIds.has(app.id), `${at}: duplicate id`);
    seenIds.add(app.id);
    req(typeof app.name === 'string' && app.name.length > 0, `${at}: missing name`);
    req(typeof app.description === 'string' && app.description.length > 0, `${at}: missing description`);
    req(typeof app.url === 'string' && app.url.length > 0, `${at}: missing url`);
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

// ── Main ──────────────────────────────────────────────────────────────────────
function build() {
  const appsJsonRaw = readFileSync(path.join(ROOT, 'apps.json'), 'utf8');
  const data = JSON.parse(appsJsonRaw);
  validate(data);

  const publicApps = data.apps.filter(a => a.visibility === 'public');
  const authApps = data.apps.filter(a => a.visibility === 'authenticated');

  let html = readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  if (!html.includes('<!--APPS:PUBLIC-->') || !html.includes('<!--APPS:AUTH-->')) {
    throw new Error('index.html is missing the <!--APPS:PUBLIC--> / <!--APPS:AUTH--> markers');
  }
  html = html.replace('<!--APPS:PUBLIC-->', renderSection(publicApps));
  html = html.replace('<!--APPS:AUTH-->', renderSection(authApps));

  mkdirSync(DIST, { recursive: true });
  writeFileSync(path.join(DIST, 'index.html'), html);

  // Static assets Azure needs to see in app_location
  for (const f of ['manifest.json', 'staticwebapp.config.json']) {
    cpSync(path.join(ROOT, f), path.join(DIST, f));
  }
  if (existsSync(path.join(ROOT, 'icons'))) {
    cpSync(path.join(ROOT, 'icons'), path.join(DIST, 'icons'), { recursive: true });
  }

  // Service worker: bump the cache name from a hash of apps.json so a content
  // change always invalidates old caches, without hand-editing a version number.
  const hash = createHash('sha256').update(appsJsonRaw).digest('hex').slice(0, 8);
  let sw = readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
  const swCacheLine = /const CACHE\s*=\s*'[^']*';/;
  if (!swCacheLine.test(sw)) {
    throw new Error("sw.js is missing the expected \"const CACHE = '...'\" line");
  }
  sw = sw.replace(swCacheLine, `const CACHE   = 'explore-${hash}';`);
  writeFileSync(path.join(DIST, 'sw.js'), sw);

  console.log(`Built dist/ — ${publicApps.length} public app(s), ${authApps.length} authenticated, cache explore-${hash}`);
}

build();
