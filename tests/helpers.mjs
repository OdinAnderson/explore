// Shared helpers for the build tests. Zero dependencies: node:test + node:fs.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const BUILD = path.join(ROOT, 'scripts', 'build.mjs');

export function tempDir(t, prefix = 'explore-test-') {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Runs scripts/build.mjs with a clean EXPLORE_* environment.
export function runBuild(args = [], env = {}) {
  const base = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith('EXPLORE_')));
  const r = spawnSync(process.execPath, [BUILD, ...args], {
    cwd: ROOT,
    env: { ...base, ...env },
    encoding: 'utf8',
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

export function buildOk(t, args = [], env = {}) {
  const r = runBuild(args, env);
  if (r.status !== 0) {
    t.diagnostic(r.stderr);
    throw new Error(`build failed (${r.status}): ${r.stderr}`);
  }
  return r;
}

// Relative paths (forward slashes) of every file under dir.
export function listFiles(dir) {
  return readdirSync(dir, { recursive: true })
    .map(p => String(p))
    .filter(p => statSync(path.join(dir, p)).isFile())
    .map(p => p.split(path.sep).join('/'))
    .sort();
}

export function read(dir, rel) {
  return readFileSync(path.join(dir, ...rel.split('/')), 'utf8');
}

export function readApps() {
  return JSON.parse(readFileSync(path.join(ROOT, 'apps.json'), 'utf8'));
}

export function writeAppsFixture(dir, apps) {
  const file = path.join(dir, 'apps.json');
  writeFileSync(file, JSON.stringify({ version: 1, apps }, null, 2));
  return file;
}

// A live, private tile with distinctive strings to grep for.
export const SECRET = {
  id: 'secret-garden',
  name: 'Secret Garden Zq7x',
  description: 'Hidden tool zq7x <b>not</b> for the public page.',
  url: 'https://secret-zq7x.example.net/tool/',
  repo: 'OdinAnderson/secret-zq7x',
  icon: { emoji: '🗝️', favicon: 'auto' },
  tags: ['private'],
  status: 'live',
  visibility: 'authenticated',
  added: '2026-11-01',
  updated: '2026-11-01',
};

// The card titles and hrefs rendered into an index.html, in order.
export function cardsOf(html) {
  const cards = [];
  const re = /<div class="(card[^"]*)"[^>]*>\s*<a class="card-link" href="([^"]*)"[\s\S]*?<div class="card-title">([^<]*)<\/div>/g;
  let m;
  while ((m = re.exec(html))) cards.push({ cls: m[1], href: m[2], title: m[3] });
  return cards;
}

export function unescapeHtml(s) {
  return s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}
