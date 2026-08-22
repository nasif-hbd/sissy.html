/**
 * Lexio service worker.
 *
 *  · Offline: caches the app shell, serves cache-first for our own assets so
 *    the deck is reviewable on a plane or a bad connection.
 *  · Notifications: raises reminders (asked for by the page, or pushed by the
 *    proxy) and routes the click back into the app.
 *
 * Bump CACHE when you change any shell file — the old cache is dropped on
 * activate.
 */
const CACHE = 'lexio-v3';
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './manifest.webmanifest',
  './js/app.js',
  './js/config.js',
  './js/store.js',
  './js/srs.js',
  './js/stats.js',
  './js/ui.js',
  './js/ai.js',
  './js/notify.js',
  './js/data/seed.js',
  './fonts/space-grotesk.woff2',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
      .catch((err) => console.warn('[sw] precache failed', err))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;   // never cache the AI proxy
  if (url.pathname.startsWith('/api/')) return;

  /*
   * Network-first for the app itself, cache as the fallback.
   *
   * This used to be cache-first, which is faster but means a deployed change
   * is invisible until the second load — and if the worker never re-activates,
   * indefinitely. For an app that ships often, a stale shell is a worse bug
   * than a few hundred milliseconds; fonts and other immutable assets stay
   * cache-first below, so the common case is still instant.
   */
  const immutable = /\.(woff2|png|jpg|svg|ico)$/.test(url.pathname);

  if (immutable) {
    event.respondWith(
      caches.match(request).then((hit) => hit || fetchAndStore(request))
    );
    return;
  }

  event.respondWith(
    fetchAndStore(request).catch(() => caches.match(request))
  );
});

function fetchAndStore(request) {
  return fetch(request).then((res) => {
    if (res.ok) {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(request, copy));
    }
    return res;
  });
}

// ── notifications ──────────────────────────────────────────────────────────

/** The page asks for a reminder through postMessage when it prefers to. */
self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'notify') {
    self.registration.showNotification(data.title || 'Lexio', data.options || {});
  } else if (data.type === 'skip-waiting') {
    self.skipWaiting();
  }
});

/** Web Push from the proxy: { title, body, view } */
self.addEventListener('push', (event) => {
  let payload = { title: 'Lexio', body: 'Time to review your words.' };
  try {
    if (event.data) payload = { ...payload, ...event.data.json() };
  } catch {
    if (event.data) payload.body = event.data.text();
  }

  event.waitUntil(self.registration.showNotification(payload.title, {
    body: payload.body,
    tag: payload.tag || 'lexio-reminder',
    renotify: true,
    data: { view: payload.view || 'learn' },
    actions: [
      { action: 'review', title: 'Review now' },
      { action: 'snooze', title: 'In 1 hour' },
    ],
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  if (event.action === 'snooze') {
    // Re-raise in an hour. Only survives while the worker is alive, so the
    // proxy schedules the real thing when push is enabled.
    event.waitUntil(new Promise((resolve) => {
      setTimeout(() => {
        self.registration.showNotification('Lexio', {
          body: 'Snoozed reminder — your words are still waiting.',
          tag: 'lexio-reminder',
        }).then(resolve);
      }, 60 * 60 * 1000);
    }));
    return;
  }

  const view = event.notification.data?.view || 'learn';
  event.waitUntil((async () => {
    const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clientList) {
      if (client.url.includes(self.registration.scope)) {
        client.postMessage({ type: 'navigate', view });
        return client.focus();
      }
    }
    return self.clients.openWindow(`./#${view}`);
  })());
});

/** Chrome-only: a periodic nudge even when no tab is open. */
self.addEventListener('periodicsync', (event) => {
  if (event.tag !== 'lexio-reminder') return;
  event.waitUntil(self.registration.showNotification('Lexio', {
    body: 'A few words are due for review.',
    tag: 'lexio-reminder',
    data: { view: 'learn' },
  }));
});
