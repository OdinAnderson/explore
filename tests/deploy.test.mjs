// Static checks of deploy/deploy.sh. Never contacts a server: the only runs
// below fail argument validation before any git, ssh or build step.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from './helpers.mjs';

const SCRIPT = 'deploy/deploy.sh';

// Prefer Git Bash on Windows: plain `bash` there may be WSL's launcher.
function findBash() {
  const candidates = process.platform === 'win32'
    ? [process.env.EXPLORE_TEST_BASH, 'C:\\Program Files\\Git\\bin\\bash.exe', 'bash']
    : [process.env.EXPLORE_TEST_BASH, 'bash'];
  for (const c of candidates.filter(Boolean)) {
    if (c.includes('\\') && !existsSync(c)) continue;
    const r = spawnSync(c, ['-c', 'echo ok'], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim() === 'ok') return c;
  }
  return null;
}
const BASH = findBash();
const run = args => spawnSync(BASH, args, { cwd: ROOT, encoding: 'utf8' });

test('deploy.sh is LF-only and starts with a bash shebang', () => {
  const src = readFileSync(path.join(ROOT, SCRIPT), 'utf8');
  assert.ok(src.startsWith('#!/usr/bin/env bash\n'));
  assert.ok(!src.includes('\r'), 'no CR characters (bash would choke)');
});

test('deploy.sh passes bash -n', { skip: !BASH && 'bash not available' }, () => {
  const r = run(['-n', SCRIPT]);
  assert.equal(r.status, 0, r.stderr);
});

test('deploy.sh rejects a missing or unsafe tag before doing anything', { skip: !BASH && 'bash not available' }, () => {
  let r = run([SCRIPT]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /usage: bash deploy\/deploy\.sh <tag>/);
  for (const bad of ['v1;rm -rf /', '-v1', '../v1', 'v1 x', '$(id)']) {
    r = run([SCRIPT, bad]);
    assert.equal(r.status, 1, `rejects ${JSON.stringify(bad)}`);
    assert.match(r.stderr, /unexpected characters/);
  }
});

test('deploy.sh keeps the documented contract', () => {
  const src = readFileSync(path.join(ROOT, SCRIPT), 'utf8');
  assert.match(src, /HOST="\$\{EXPLORE_DEPLOY_HOST:-oaks\}"/);
  assert.match(src, /EXPLORE_HOSTNAME:-explore-new\.odinz\.net/);
  assert.match(src, /EXPLORE_TARGET=oaks/);
  assert.match(src, /git -c core\.autocrlf=false -c core\.eol=lf archive/);
  assert.match(src, /sudo -n true 2>\/dev\/null \|\| fail "sudo needs a password/);
  assert.match(src, /--resolve "\$site:443:127\.0\.0\.1" "https:\/\/\$site\/VERSION"/);
  assert.match(src, /mv -T "\$tmp_link" "\$current"/);
  assert.match(src, /no Caddy site block for \$site/);
  assert.ok(!/systemctl/.test(src), 'static site: no service restarts');
});
