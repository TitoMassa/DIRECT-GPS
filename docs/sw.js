const CACHE_NAME = 'direct-gps-v98';
const DATA_CACHE = 'direct-gps-data-v5';
const TILE_CACHE = 'direct-gps-tiles-v2';
const MAX_TILES = 2500;

const SHELL_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
  './css/styles.css',
  './vendor/leaflet/leaflet.css',
  './vendor/leaflet/leaflet.js',
  './js/config.js',
  './js/native.js',
  './js/audio.js',
  './js/tts.js',
  './js/static-data.js',
  './js/api.js',
  './js/trajectory.js',
  './js/predictor.js',
  './js/simulator.js',
  './js/holidays.js',
  './js/schedule-image.js',
  './js/telemetry.js',
  './js/ride-mode.js',
  './js/ui-extras.js',
  './js/map.js',
  './js/app.js',
  './data/catalogo.json',
  './data/horarios/index.json'
];

const TILE_HOSTS = ['tile.openstreetmap.org'];

function canonicalTileKey(url) {
  return `https://tile.openstreetmap.org${url.pathname}`;
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_ASSETS.map((u) => new Request(u, { cache: 'reload' }))))
      .catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  const keep = new Set([CACHE_NAME, DATA_CACHE, TILE_CACHE]);
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => !keep.has(k)).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('message', (event) => {
  if (event?.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// ── Native Android Push & Notification Action Handlers (Subir / Bajar / Detener) ──
self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { title: 'DIRECT GPS', body: event.data?.text?.() || 'Actualización de arribo' };
  }
  const title = String(payload.title || 'DIRECT GPS');
  const body = String(payload.body || '');
  const tag = String(payload.tag || 'direct-gps-live-track');
  const silent = Boolean(payload.silent);
  const options = {
    body,
    icon: './icons/icon-192.png',
    badge: './icons/icon-192.png',
    tag,
    silent,
    renotify: !silent,
    vibrate: silent ? undefined : [140, 80, 140],
    actions: Array.isArray(payload.actions) ? payload.actions.slice(0, 2) : undefined,
    data: payload.data || {}
  };

  event.waitUntil(
    Promise.all([
      self.registration.showNotification(title, options),
      payload.speechText
        ? self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
            for (const c of clients) {
              c.postMessage({
                type: 'DIRECT_GPS_NOTIF_ACTION',
                action: 'speak',
                data: { text: payload.speechText }
              });
            }
          })
        : Promise.resolve()
    ])
  );
});

self.addEventListener('notificationclick', (event) => {
  const action = String(event.action || '').trim();
  const data = event.notification?.data || {};

  // Actions from Android notification shade: Subir / Ya subí / Bajar / Detener
  if (action === 'board' || action === 'board-now' || action === 'alight' || action === 'stop-track') {
    if (action === 'alight' || action === 'stop-track') {
      event.notification.close();
    }
    event.waitUntil(
      self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
        if (clients.length > 0) {
          for (const client of clients) {
            client.postMessage({
              type: 'DIRECT_GPS_NOTIF_ACTION',
              action,
              data
            });
          }
          return;
        }
        // If user closed the app and tapped Subir/Bajar on a lingering notification, open the app with action
        if (action === 'board' || action === 'board-now') {
          const url = new URL('./', self.registration.scope);
          if (data.stopId) url.searchParams.set('idParada', data.stopId);
          url.searchParams.set('action', action);
          return self.clients.openWindow(url.toString());
        }
      })
    );
    return;
  }

  // Tapping notification body focuses existing PWA window or opens stop deep-link
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ('focus' in client) return client.focus();
      }
      const url = new URL('./', self.registration.scope);
      if (data.stopId) url.searchParams.set('idParada', data.stopId);
      return self.clients.openWindow(url.toString());
    })
  );
});

async function trimCache(cacheName, maxEntries) {
  try {
    const cache = await caches.open(cacheName);
    const keys = await cache.keys();
    if (keys.length > maxEntries) {
      const excess = keys.slice(0, keys.length - maxEntries);
      await Promise.all(excess.map((k) => cache.delete(k)));
    }
  } catch {
    // ignore
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Never intercept live telemetry APIs in SW (app handles offline prediction & IndexedDB cache directly)
  if (url.pathname.includes('/api/')) return;

  // 1) Map tiles (OSM): cache-first with subdomain-normalized key (a/b/c share the same cached tile offline!)
  if (TILE_HOSTS.some((h) => url.hostname.endsWith(h))) {
    const tileKey = canonicalTileKey(url);
    event.respondWith(
      caches.open(TILE_CACHE).then(async (cache) => {
        const hit = (await cache.match(tileKey)) || (await cache.match(req));
        if (hit) return hit;
        try {
          const res = await fetch(req);
          if (res && (res.ok || res.type === 'opaque')) {
            cache.put(tileKey, res.clone());
            if (Math.random() < 0.04) trimCache(TILE_CACHE, MAX_TILES);
          }
          return res;
        } catch {
          return new Response('', { status: 504 });
        }
      })
    );
    return;
  }

  // 2) Static route/schedule archives (docs/data/**): stale-while-revalidate for instant offline & online
  //    (horarios/index.json uses network-first below so updatedAt version checks are immediate)
  if (
    url.origin === self.location.origin &&
    url.pathname.includes('/data/') &&
    !url.pathname.endsWith('/horarios/index.json')
  ) {
    event.respondWith(
      caches.open(DATA_CACHE).then(async (cache) => {
        const cached = await cache.match(req);
        const netPromise = fetch(req)
          .then((res) => {
            if (res && res.ok) cache.put(req, res.clone());
            return res;
          })
          .catch(() => null);
        if (cached) {
          event.waitUntil(netPromise);
          return cached;
        }
        const net = await netPromise;
        if (net) return net;
        const anyCached = await cache.match(req, { ignoreSearch: true });
        return anyCached || new Response('{"error":"offline"}', { status: 503, headers: { 'Content-Type': 'application/json' } });
      })
    );
    return;
  }

  // 3) App shell (same-origin): network-first with cache fallback (and index.html fallback for navigations)
  if (url.origin === self.location.origin) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(async () => {
          const cached = await caches.match(req, { ignoreSearch: req.mode === 'navigate' });
          if (cached) return cached;
          if (req.mode === 'navigate') return caches.match('./index.html');
          return new Response('', { status: 503 });
        })
    );
  }
});
