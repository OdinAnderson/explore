#!/usr/bin/env node
// Zero-dependency build: renders apps.json into index.html's card markers,
// sets the service worker's cache name from a hash of the shell sources, and
// assembles the static site into an output directory (dist/ by default).
//
// Targets:
//   azure (default)  The public, catalog-only build (`npm run build`, CI).
//                    Public data only: no private tiles, no sign-in loader,
//                    no private/ dir. (The name is historical.)
//   oaks             The live site behind Caddy on oaks (deploy/deploy.sh). Adds the
//                    header pawn and sign-in loader to index.html and writes
//                    private tiles to private/tiles.json (served only behind
//                    forward_auth). Writes VERSION when a version tag is given.
//
// Usage:
//   node scripts/build.mjs [--target azure|oaks] [--out <dir>] [--apps <file>]
//                          [--version-tag <tag>] [--version-commit <sha>]
// Environment equivalents: EXPLORE_TARGET, EXPLORE_OUT, EXPLORE_APPS,
//   EXPLORE_VERSION_TAG, EXPLORE_VERSION_COMMIT, EXPLORE_VERSION_BUILT_AT.
// Flags win over environment variables.
import { readFileSync, writeFileSync, mkdirSync, cpSync, existsSync, rmSync, statSync } from 'node:fs';
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
// icon.src is an optional vendored, same-origin card image: a path under
// /icons/ naming a file that exists in the repo's icons/ directory. External
// URLs, "..", queries and hashes are rejected. Returns an error or null.
function iconSrcError(src) {
  if (typeof src !== 'string' || !src.startsWith('/icons/')) return 'must be a path starting with /icons/';
  if (src.includes('..')) return 'must not contain ".."';
  if (/[?#]/.test(src)) return 'must not have a query or hash';
  if (/[\\\0]|\/\//.test(src)) return 'must be a plain /icons/ path';
  const iconsDir = path.join(ROOT, 'icons');
  const file = path.join(iconsDir, ...src.slice('/icons/'.length).split('/'));
  if (!file.startsWith(iconsDir + path.sep) || !existsSync(file) || !statSync(file).isFile()) {
    return `names no file under icons/ (${src})`;
  }
  return null;
}

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
    if (app.icon && app.icon.src !== undefined) {
      const err = iconSrcError(app.icon.src);
      req(!err, `${at}: icon.src ${err}`);
    }
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
  // Authenticated coming-soon cards are the public placeholder for private
  // tiles. The oaks loader hides .private-placeholder only after those tiles
  // have actually rendered.
  const privatePlaceholder = comingSoon && app.visibility === 'authenticated';
  // A vendored icon.src replaces the emoji and must never be favicon-swapped.
  const iconSrc = app.icon.src;
  const keepEmoji = app.icon.favicon === 'never' || Boolean(iconSrc);
  const iconInner = iconSrc
    ? `<img class="card-favicon" src="${escapeHtml(iconSrc)}" alt="">`
    : `<span class="card-icon-emoji">${escapeHtml(app.icon.emoji)}</span>`;
  const cardClass = ['card', comingSoon && 'coming-soon', privatePlaceholder && 'private-placeholder']
    .filter(Boolean)
    .join(' ');
  const keepEmojiAttr = keepEmoji ? ' data-keep-emoji' : '';
  const appIdAttr = privatePlaceholder ? ` data-app-id="${escapeHtml(app.id)}"` : '';
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

  return `      <div class="${cardClass}"${keepEmojiAttr}${appIdAttr}>
        <a class="card-link" ${linkAttrs}>
          <div class="card-icon">${iconInner}</div>
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

// ── Oaks-only header pawn + sign-in loader (inlined for --target oaks) ───────
// Class names, data-pawn, pawn.css and pawn.js match the hub's pawn control.
// The signed-out face is the hub's person-outline silhouette (head and
// shoulders). pawn.js, loaded from the hub, only opens and closes the
// <details data-pawn> this loader renders.
function renderOaksLoader(hasPrivate) {
  return `  <link rel="stylesheet" href="https://auth.odinz.net/static/pawn.css">
  <style>
    .explore-pawn {
      position: relative;
      z-index: 40;
      display: flex;
      justify-content: flex-end;
      align-items: center;
      min-height: 2.75rem;
      padding: 0.55rem 1rem 0.2rem;
      background: #000;
    }
    .explore-pawn + .hero { padding-top: 0.6rem; }
    /* pawn.css paints initials #1a1404 for Dash's gold accent. Explore's accent is purple. */
    .explore-pawn .id-anchor[data-state="signed-in"] .pawn-chip,
    .explore-pawn .profile-avatar { color: #fff; }
    .explore-pawn .provider-btn:hover { background: rgba(124, 106, 247, 0.08); }
    /* One circle only: the button draws no ring of its own; the smaller
       .pawn-chip circle carries Explore's accent and the hover reaction. */
    .explore-pawn .id-anchor > .pawn-btn,
    .explore-pawn .id-anchor > .pawn-btn:hover,
    .explore-pawn .id-anchor[open] > .pawn-btn {
      background: transparent;
      border-color: transparent;
      box-shadow: none;
    }
    .explore-pawn .id-anchor > .pawn-btn:hover { color: var(--text); }
    .explore-pawn .id-anchor > .pawn-btn:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
    }
    .explore-pawn .id-anchor > .pawn-btn .pawn-chip { border-color: var(--accent); }
    .explore-pawn .id-anchor > .pawn-btn:hover .pawn-chip { border-color: var(--accent-dim); }
  </style>
  <script id="explore-sso-loader">
  // Oaks build only. Paints the shared pawn in the header (signed-out face is
  // a person-outline silhouette), asks the sign-in hub who is signed in
  // (/_sso/me) and, if allowed, renders the private tiles from
  // /private/tiles.json (behind forward_auth). Once those tiles are on the
  // page, authenticated coming-soon placeholders are hidden. Fails quietly:
  // on any /_sso/me error the page stays on the signed-out pawn and the
  // public tiles, including the placeholder. A successful signed-out answer
  // may hop once to the hub's silent login so a session from another site
  // shows up here. A failed /_sso/me does not hop.
  (function () {
    var HAS_PRIVATE = ${hasPrivate ? 'true' : 'false'};
    var HUB = 'https://auth.odinz.net';
    var SVGNS = 'http://www.w3.org/2000/svg';
    var PERSON_PATH = 'M5.4 19.2c.4-3.15 3.15-5.4 6.6-5.4s6.2 2.25 6.6 5.4';
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
    function svgEl(tag) { return document.createElementNS(SVGNS, tag); }
    function pageHref() {
      try {
        if (typeof location !== 'undefined' && location && typeof location.href === 'string') return location.href;
      } catch (e) { /* quiet */ }
      return '';
    }
    // Drop query parameter sso=none. The hub appends it when there is no
    // session; a return URL that still carries it would look already answered.
    // Plain string parsing, no URL global: works wherever location.href does.
    // Other parameters and the hash are kept as they were.
    function withoutSsoNone(href) {
      if (typeof href !== 'string' || !href) return '';
      var hashAt = href.indexOf('#');
      var hash = hashAt >= 0 ? href.slice(hashAt) : '';
      var rest = hashAt >= 0 ? href.slice(0, hashAt) : href;
      var qAt = rest.indexOf('?');
      if (qAt < 0) return href;
      var parts = rest.slice(qAt + 1).split('&');
      var kept = [];
      var found = false;
      for (var i = 0; i < parts.length; i++) {
        if (parts[i] === 'sso=none') found = true;
        else if (parts[i] !== '') kept.push(parts[i]);
      }
      if (!found) return href;
      return rest.slice(0, qAt) + (kept.length ? '?' + kept.join('&') : '') + hash;
    }
    function currentUrl() {
      return withoutSsoNone(pageHref());
    }
    function hasSsoNone() {
      var href = pageHref();
      return !!href && withoutSsoNone(href) !== href;
    }
    function stripSsoNone() {
      try {
        history.replaceState(history.state, '', withoutSsoNone(pageHref()));
      } catch (e) { /* keep the current URL */ }
    }
    function stampIsFresh(stored, now) {
      if (stored == null || stored === '') return false;
      var stamped = Number(stored);
      if (stamped !== stamped) return false;
      return (now - stamped) < 10 * 60 * 1000;
    }
    // Loop safety: write edgeauth-sso-checked before the silent hop. If
    // sessionStorage is missing or throws, stay here. A hub that shows its
    // sign-in page instead of bouncing back must not reload forever.
    // sso=none, or a stamp under 10 minutes old, also stays.
    function considerSilentHub() {
      var key = 'edgeauth-sso-checked';
      var stored = null;
      var storageOk = false;
      try {
        stored = sessionStorage.getItem(key);
        storageOk = true;
      } catch (e) {
        storageOk = false;
      }
      var now = Date.now();
      if (hasSsoNone()) {
        if (storageOk) {
          try { sessionStorage.setItem(key, String(now)); } catch (e) { /* do not hop */ }
        }
        stripSsoNone();
        return;
      }
      if (!storageOk) return;
      if (stampIsFresh(stored, now)) return;
      try {
        sessionStorage.setItem(key, String(now));
      } catch (e) {
        return;
      }
      try {
        location.replace(HUB + '/login?silent=1&rd=' + encodeURIComponent(currentUrl()));
      } catch (e) { /* stay signed out */ }
    }
    // Two letters from the name, else the email's local part. Upper case.
    // Same split as the hub's pawn.py initials().
    function initials(name, email) {
      var source = str(name).trim();
      if (!source) source = str(email).split('@')[0];
      var parts = source.split(/[\\s._+-]+/).filter(function (p) { return p; });
      var letters;
      if (parts.length >= 2) letters = parts[0].charAt(0) + parts[1].charAt(0);
      else if (parts.length && parts[0].length >= 2) letters = parts[0].slice(0, 2);
      else if (parts.length) letters = parts[0].charAt(0);
      else letters = '?';
      return letters.toUpperCase();
    }
    function visibleName(name, email) {
      var n = str(name).trim();
      if (n) return n;
      var local = str(email).split('@')[0];
      return local || str(email);
    }
    function providerLine(provider) {
      var key = str(provider).toLowerCase();
      if (key === 'microsoft') return 'Signed in with Microsoft';
      if (key === 'google') return 'Signed in with Google';
      return 'Signed in';
    }
    function pawnIcon() {
      var s = svgEl('svg');
      s.setAttribute('class', 'pawn-icon');
      s.setAttribute('viewBox', '0 0 24 24');
      s.setAttribute('aria-hidden', 'true');
      s.setAttribute('focusable', 'false');
      var c = svgEl('circle');
      c.setAttribute('cx', '12');
      c.setAttribute('cy', '8');
      c.setAttribute('r', '3.6');
      c.setAttribute('fill', 'none');
      c.setAttribute('stroke', 'currentColor');
      c.setAttribute('stroke-width', '1.8');
      s.appendChild(c);
      var p = svgEl('path');
      p.setAttribute('fill', 'none');
      p.setAttribute('stroke', 'currentColor');
      p.setAttribute('stroke-width', '1.8');
      p.setAttribute('stroke-linecap', 'round');
      p.setAttribute('stroke-linejoin', 'round');
      p.setAttribute('d', PERSON_PATH);
      s.appendChild(p);
      return s;
    }
    function microsoftLogo() {
      var s = svgEl('svg');
      s.setAttribute('viewBox', '0 0 21 21');
      s.setAttribute('aria-hidden', 'true');
      s.setAttribute('focusable', 'false');
      [['1', '1', '#f25022'], ['11', '1', '#7fba00'], ['1', '11', '#00a4ef'], ['11', '11', '#ffb900']].forEach(function (r) {
        var n = svgEl('rect');
        n.setAttribute('x', r[0]);
        n.setAttribute('y', r[1]);
        n.setAttribute('width', '9');
        n.setAttribute('height', '9');
        n.setAttribute('fill', r[2]);
        s.appendChild(n);
      });
      return s;
    }
    function googleLogo() {
      var s = svgEl('svg');
      s.setAttribute('viewBox', '0 0 48 48');
      s.setAttribute('aria-hidden', 'true');
      s.setAttribute('focusable', 'false');
      [
        ['#EA4335', 'M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z'],
        ['#4285F4', 'M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z'],
        ['#FBBC05', 'M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z'],
        ['#34A853', 'M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z']
      ].forEach(function (pair) {
        var p = svgEl('path');
        p.setAttribute('fill', pair[0]);
        p.setAttribute('d', pair[1]);
        s.appendChild(p);
      });
      return s;
    }
    function providerLink(key, label) {
      var a = el('a', 'provider-btn');
      a.href = HUB + '/oauth/login/' + key + '?rd=' + encodeURIComponent(currentUrl());
      a.appendChild(key === 'google' ? googleLogo() : microsoftLogo());
      a.appendChild(el('span', null, 'Sign in with ' + label));
      return a;
    }
    function buildSignedOut() {
      var details = el('details', 'id-anchor');
      details.setAttribute('data-pawn', '');
      details.setAttribute('data-state', 'signed-out');
      var summary = el('summary', 'pawn-btn');
      summary.setAttribute('aria-label', 'Sign in');
      summary.setAttribute('aria-expanded', 'false');
      summary.setAttribute('aria-haspopup', 'dialog');
      summary.setAttribute('aria-controls', 'pawn-menu');
      var chip = el('span', 'pawn-chip');
      var face = el('span', 'pawn-face-empty');
      face.appendChild(pawnIcon());
      chip.appendChild(face);
      summary.appendChild(chip);
      details.appendChild(summary);
      var card = el('div', 'id-card');
      card.id = 'pawn-menu';
      card.setAttribute('role', 'dialog');
      card.setAttribute('aria-modal', 'false');
      var signin = el('div', 'id-signin');
      signin.appendChild(el('p', 'popover-title', 'Sign in'));
      var list = el('div', 'provider-list');
      list.appendChild(providerLink('microsoft', 'Microsoft'));
      list.appendChild(providerLink('google', 'Google'));
      signin.appendChild(list);
      card.appendChild(signin);
      details.appendChild(card);
      return details;
    }
    // Keep the same <details> and <summary> pawn.js already bound. Swap the chip
    // and the card only.
    function applySignedIn(details, me) {
      var email = str(me.email).trim();
      var name = visibleName(me.name, email);
      var ini = initials(me.name, email);
      details.setAttribute('data-state', 'signed-in');
      var summary = details.querySelector('summary');
      if (!summary) return;
      summary.setAttribute('aria-label', 'Account menu, signed in as ' + name);
      var chip = summary.querySelector('.pawn-chip');
      if (chip) {
        while (chip.firstChild) chip.removeChild(chip.firstChild);
        chip.appendChild(el('span', 'pawn-face-filled', ini));
      }
      var label = summary.querySelector('.pawn-label');
      if (!label) summary.appendChild(el('span', 'pawn-label', name));
      else label.textContent = name;
      var card = details.querySelector('.id-card');
      if (!card) return;
      while (card.firstChild) card.removeChild(card.firstChild);
      var profile = el('div', 'id-profile');
      var who = el('div', 'profile-who');
      var avatar = el('div', 'profile-avatar', ini);
      avatar.setAttribute('aria-hidden', 'true');
      who.appendChild(avatar);
      var text = el('div');
      text.appendChild(el('p', 'account-name', name));
      text.appendChild(el('p', 'account-email', email));
      text.appendChild(el('p', 'account-provider', providerLine(me.provider)));
      who.appendChild(text);
      profile.appendChild(who);
      profile.appendChild(el('hr', 'popover-rule'));
      var form = el('form', 'account-signout');
      form.method = 'post';
      form.action = '/_sso/logout';
      var csrf = el('input');
      csrf.type = 'hidden';
      csrf.name = 'csrf';
      csrf.value = str(me.csrf);
      form.appendChild(csrf);
      var btn = el('button', 'signout-btn', 'Sign out');
      btn.type = 'submit';
      form.appendChild(btn);
      profile.appendChild(form);
      card.appendChild(profile);
    }
    function mount() {
      var existing = document.querySelector('.id-anchor');
      if (existing) return existing;
      var details = buildSignedOut();
      var header = el('header', 'explore-pawn');
      header.appendChild(details);
      var hero = document.querySelector('.hero');
      if (hero && hero.parentNode) hero.parentNode.insertBefore(header, hero);
      else {
        var foot = document.querySelector('footer');
        if (foot && foot.parentNode) foot.parentNode.insertBefore(header, foot);
      }
      return details;
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
    function hidePrivatePlaceholders() {
      var nodes = document.querySelectorAll('.private-placeholder');
      for (var i = 0; i < nodes.length; i++) nodes[i].style.display = 'none';
    }
    function showTiles(data) {
      var tiles = data && Array.isArray(data.tiles) ? data.tiles : [];
      var cards = tiles.map(card).filter(Boolean);
      if (!cards.length) return;
      // Reuse the page's one Private section (it already holds the
      // placeholder). Only build a section if the page lacks one.
      var section = document.querySelector('.private-apps');
      if (!section) {
        var f = footer();
        if (!f || !f.parentNode) return;
        section = el('section', 'private-apps');
        section.id = 'private-apps';
        section.appendChild(el('h2', null, '\\ud83d\\udd12 Private'));
        f.parentNode.insertBefore(section, f);
      }
      var grid = section.querySelector('.grid');
      if (!grid) {
        grid = el('div', 'grid');
        section.appendChild(grid);
      }
      cards.forEach(function (c) { grid.appendChild(c); });
      hidePrivatePlaceholders();
    }

    var pawn = mount();
    if (typeof fetch !== 'function' || !pawn) return;
    getJson('/_sso/me').then(function (me) {
      if (me && me.signed_in === true) {
        applySignedIn(pawn, me);
        if (!HAS_PRIVATE) return;
        return getJson('/private/tiles.json').then(showTiles);
      }
      // HTTP errors and non-JSON become null in getJson. Only a real
      // signed-out answer may hop.
      if (me && me.signed_in === false) considerSilentHub();
    }).catch(function () { /* stay on the signed-out pawn; do not hop */ });
  }());
  </script>
  <script src="https://auth.odinz.net/static/pawn.js" defer></script>
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
