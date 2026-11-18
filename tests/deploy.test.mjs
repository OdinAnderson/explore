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

  // Current + 3 previous. Fail if "newest 5 plus current" / `-le 5` returns.
  assert.match(src, /plus the 3 most recent other releases/);
  assert.match(src, /Never prune current/);
  assert.doesNotMatch(src, /newest 5/);
  assert.doesNotMatch(src, /-le 5/);
  assert.ok(
    src.includes("find \"$releases\" -mindepth 1 -maxdepth 1 -type d ! -name '.*' -printf '%T@ %f\\n'"),
    'still orders releases by install/use mtime',
  );
  assert.ok(src.includes('sudo -n rm -rf -- "$releases/$name"'));
  assert.ok(src.includes('sudo -n rm -f -- "$manifests/$name.SHA256SUMS"'));
  assert.ok(src.includes([
    'if [ "$name" = "$keep_current" ]; then continue; fi',
    '    others=$((others + 1))',
    '    if [ "$others" -le 3 ]; then continue; fi',
  ].join('\n')), 'current does not consume one of the 3 previous slots');
});

// Runs the prune loop from deploy.sh against local dirs. No ssh, no sudo.
test('prune keeps current plus the 3 most recent other releases', { skip: !BASH && 'bash not available' }, () => {
  const src = readFileSync(path.join(ROOT, SCRIPT), 'utf8');
  const marker = '# Keep the release `current` points at, plus the 3 most recent other releases';
  const start = src.indexOf(marker);
  assert.ok(start >= 0, 'prune block missing');
  const end = src.indexOf('\ndone\n', start);
  assert.ok(end >= 0, 'prune loop did not end');
  const block = src.slice(start, end + '\ndone\n'.length);

  // age is seconds older than now (0 = newest). manifest:false omits the sums file.
  // These sets are wrong under "newest 5 plus current" and under "top 4 including current".
  const cases = [
    {
      id: 'current-newest-of-six',
      current: 'v6',
      rels: [
        { name: 'v6', age: 0 },
        { name: 'v5', age: 10 },
        { name: 'v4', age: 20 },
        { name: 'v3', age: 30 },
        { name: 'v2', age: 40 },
        { name: 'v1', age: 50, manifest: false },
      ],
      keep: ['v6', 'v5', 'v4', 'v3'],
    },
    {
      id: 'current-oldest-of-six',
      current: 'v1',
      rels: [
        { name: 'v6', age: 0 },
        { name: 'v5', age: 10 },
        { name: 'v4', age: 20 },
        { name: 'v3', age: 30 },
        { name: 'v2', age: 40 },
        { name: 'v1', age: 50 },
      ],
      keep: ['v6', 'v5', 'v4', 'v1'],
    },
    {
      id: 'current-fifth-of-seven',
      current: 'v3',
      rels: [
        { name: 'v7', age: 0 },
        { name: 'v6', age: 10 },
        { name: 'v5', age: 20 },
        { name: 'v4', age: 30 },
        { name: 'v3', age: 40 },
        { name: 'v2', age: 50 },
        { name: 'v1', age: 60 },
      ],
      keep: ['v7', 'v6', 'v5', 'v3'],
    },
    {
      id: 'current-second-of-five',
      current: 'v4',
      rels: [
        { name: 'v5', age: 0 },
        { name: 'v4', age: 10 },
        { name: 'v3', age: 20 },
        { name: 'v2', age: 30 },
        { name: 'v1', age: 40 },
      ],
      keep: ['v5', 'v4', 'v3', 'v2'],
    },
    {
      id: 'under-four',
      current: 'v2',
      rels: [
        { name: 'v3', age: 0 },
        { name: 'v2', age: 10 },
        { name: 'v1', age: 20 },
      ],
      keep: ['v3', 'v2', 'v1'],
    },
    {
      id: 'only-current',
      current: 'v1',
      rels: [{ name: 'v1', age: 0 }],
      keep: ['v1'],
    },
    {
      id: 'exactly-four-current-oldest',
      current: 'v1',
      rels: [
        { name: 'v4', age: 0 },
        { name: 'v3', age: 10 },
        { name: 'v2', age: 20 },
        { name: 'v1', age: 30 },
      ],
      keep: ['v4', 'v3', 'v2', 'v1'],
    },
  ];

  const calls = cases.map(c => {
    const specs = c.rels.map(r => `${r.name}:${r.age}${r.manifest === false ? ':no' : ''}`);
    return `run_case ${c.id} ${c.current} ${specs.join(' ')}`;
  });
  const script = [
    'set -euo pipefail',
    'sudo() {',
    '  if [ "${1:-}" = "-n" ]; then shift; fi',
    '  "$@"',
    '}',
    // Git Bash on Windows cannot make real symlinks: `ln -sfn` copies the dir
    // and `readlink` prints nothing, so keep_current would be empty. Answer for
    // the test\'s $current link exactly as Linux readlink would; defer otherwise.
    'readlink() {',
    '  if [ "$#" -eq 1 ] && [ -n "${current:-}" ] && [ "$1" = "$current" ]; then',
    '    printf \'%s\\n\' "$releases/$current_name"',
    '  else',
    '    command readlink "$@"',
    '  fi',
    '}',
    'run_case() {',
    '  local id="$1"',
    '  local current_name="$2"',
    '  shift 2',
    '  local base releases manifests current now spec name rest age manifest ts d m',
    '  base="$(mktemp -d)"',
    '  releases="$base/releases"',
    '  manifests="$base/manifests"',
    '  current="$base/current"',
    '  mkdir -p "$releases" "$manifests" "$releases/.incoming.test"',
    '  echo hidden > "$releases/.incoming.test/marker"',
    '  now="$(date +%s)"',
    '  touch -d "@$((now + 60))" "$releases/.incoming.test"',
    '  : > "$manifests/orphan.SHA256SUMS"',
    '  for spec in "$@"; do',
    '    name="${spec%%:*}"',
    '    rest="${spec#*:}"',
    '    age="${rest%%:*}"',
    '    case "$rest" in',
    '      *:no) manifest=no ;;',
    '      *) manifest=yes ;;',
    '    esac',
    '    mkdir -p "$releases/$name"',
    '    echo x > "$releases/$name/VERSION"',
    '    if [ "$manifest" = yes ]; then echo sum > "$manifests/$name.SHA256SUMS"; fi',
    '    ts=$((now - age))',
    '    touch -d "@$ts" "$releases/$name"',
    '  done',
    '  ln -sfn "$releases/$current_name" "$current"',
    '  echo "BEGIN $id"',
    block.trimEnd(),
    '  echo "LINK $(basename "$(readlink "$current")")"',
    '  for d in "$releases"/*; do',
    '    [ -d "$d" ] || continue',
    '    case "$(basename "$d")" in',
    '      .*) ;;',
    '      *) echo "KEPT $(basename "$d")" ;;',
    '    esac',
    '  done',
    '  if [ -d "$releases/.incoming.test" ] && [ -f "$releases/.incoming.test/marker" ]; then',
    '    echo "HIDDEN yes"',
    '  else',
    '    echo "HIDDEN no"',
    '  fi',
    '  for m in "$manifests"/*; do',
    '    [ -f "$m" ] || continue',
    '    echo "MANIFEST $(basename "$m")"',
    '  done',
    '  echo "END"',
    '  rm -rf "$base"',
    '}',
    ...calls,
    'echo ALL_DONE',
    '',
  ].join('\n');

  const r = spawnSync(BASH, ['-s'], { cwd: ROOT, encoding: 'utf8', input: script });
  assert.equal(r.status, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.match(r.stdout, /ALL_DONE/);

  const got = new Map();
  let cur = null;
  for (const line of r.stdout.split('\n')) {
    if (line.startsWith('BEGIN ')) {
      cur = { kept: [], manifests: [], pruned: [], hidden: '', link: '' };
      got.set(line.slice(6), cur);
    } else if (line === 'END') {
      cur = null;
    } else if (line === 'ALL_DONE' || line === '') {
      continue;
    } else if (!cur) {
      assert.fail(`unexpected output: ${line}`);
    } else if (line.startsWith('KEPT ')) {
      cur.kept.push(line.slice(5));
    } else if (line.startsWith('MANIFEST ')) {
      cur.manifests.push(line.slice(9));
    } else if (line.startsWith('HIDDEN ')) {
      cur.hidden = line.slice(7);
    } else if (line.startsWith('LINK ')) {
      cur.link = line.slice(5);
    } else if (line.startsWith('remote: pruning release ')) {
      cur.pruned.push(line.slice('remote: pruning release '.length));
    } else {
      assert.fail(`unexpected line: ${line}`);
    }
  }

  const sorted = xs => [...xs].sort();
  for (const c of cases) {
    const g = got.get(c.id);
    assert.ok(g, `missing case ${c.id}`);
    const prune = c.rels.map(rel => rel.name).filter(name => !c.keep.includes(name));
    const pruneNewestFirst = c.rels
      .filter(rel => prune.includes(rel.name))
      .sort((a, b) => a.age - b.age)
      .map(rel => rel.name);
    assert.deepEqual(sorted(g.kept), sorted(c.keep), `${c.id} kept`);
    assert.deepEqual(g.pruned, pruneNewestFirst, `${c.id} prune order`);
    assert.equal(g.link, c.current, `${c.id} current symlink`);
    assert.equal(g.hidden, 'yes', `${c.id} hidden staging dir`);
    const manifests = ['orphan.SHA256SUMS'];
    for (const rel of c.rels) {
      if (rel.manifest === false) continue;
      if (prune.includes(rel.name)) continue;
      manifests.push(`${rel.name}.SHA256SUMS`);
    }
    assert.deepEqual(sorted(g.manifests), sorted(manifests), `${c.id} manifests`);
  }
});
