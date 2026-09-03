#!/usr/bin/env node
// Zero-dependency link checker. HEAD (falling back to GET on 405/network error)
// every live app's url. Non-2xx/3xx fails the run.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TIMEOUT_MS = 10_000;

async function check(url) {
  for (const method of ['HEAD', 'GET']) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, { method, redirect: 'follow', signal: controller.signal });
      clearTimeout(timer);
      if (res.ok) return { ok: true, status: res.status };
      // A 405/501 on HEAD is common even for perfectly live sites — retry with GET.
      if (method === 'HEAD' && (res.status === 405 || res.status === 501)) continue;
      return { ok: false, status: res.status };
    } catch (err) {
      clearTimeout(timer);
      if (method === 'HEAD') continue;
      return { ok: false, status: null, error: err.message };
    }
  }
  return { ok: false, status: null, error: 'exhausted retries' };
}

async function main() {
  const data = JSON.parse(readFileSync(path.join(ROOT, 'apps.json'), 'utf8'));
  const live = data.apps.filter(a => a.status === 'live' && /^https?:\/\//.test(a.url));

  console.log(`Checking ${live.length} live app URL(s)...`);
  const results = await Promise.all(live.map(async app => ({ app, result: await check(app.url) })));

  let failed = false;
  for (const { app, result } of results) {
    if (result.ok) {
      console.log(`  OK   ${result.status}  ${app.id}  ${app.url}`);
    } else {
      failed = true;
      console.log(`  FAIL ${result.status ?? 'ERR'}  ${app.id}  ${app.url}${result.error ? '  — ' + result.error : ''}`);
    }
  }

  if (failed) {
    console.error('\nOne or more app URLs are not reachable.');
    process.exit(1);
  }
  console.log('\nAll live app URLs OK.');
}

main();
