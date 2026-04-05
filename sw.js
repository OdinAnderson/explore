/* explore.odinz.net — Service Worker
 *
 * Strategy:
 *   Landing page + shell assets → Cache-first, refresh in background (stale-while-revalidate)
 *   Experiment pages (/apps/*)  → Network-first, fall back to cache
 *   Everything else              → Network-first, fall back to cache
 *   Offline                      → Serve cached landing page if available
 */

const CACHE   = 'explore-v2';
const SHELL   = [
  '/',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

// ── Install: pre-cache the shell ──────────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll(SHELL))
  );
  self.skipWaiting();
});

// ── Activate: clean up old caches ────────────────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// ── Fetch ─────────────────────────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Only handle same-origin GET requests
  if (request.method !== 'GET' || url.origin !== location.origin) return;

  // Shell / landing page → stale-while-revalidate
  if (url.pathname === '/' || SHELL.includes(url.pathname)) {
    event.respondWith(staleWhileRevalidate(request));
    return;
  }

  // Experiment pages → network-first with cache fallback
  event.respondWith(networkFirst(request));
});

// ── Strategies ────────────────────────────────────────────────────────────────
async function staleWhileRevalidate(request) {
  const cache    = await caches.open(CACHE);
  const cached   = await cache.match(request);
  const fetchPromise = fetch(request).then(response => {
    if (response.ok) cache.put(request, response.clone());
    return response;
  }).catch(() => null);

  return cached ?? await fetchPromise ?? offlineFallback();
}

async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch {
    return (await cache.match(request)) ?? offlineFallback();
  }
}

function offlineFallback() {
  return caches.match('/').then(r => r ?? new Response(
    '<html><body style="background:#000;color:#e040a0;font-family:monospace;text-align:center;padding:4rem">'
    + '<h1 style="font-size:2rem">explore</h1>'
    + '<p style="margin-top:1rem;letter-spacing:.2em;text-transform:uppercase">You\'re offline</p>'
    + '</body></html>',
    { headers: { 'Content-Type': 'text/html' } }
  ));
}
