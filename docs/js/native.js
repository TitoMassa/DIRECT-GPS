// ============================================================================
// DIRECT GPS · Web / PWA Platform Layer
// ----------------------------------------------------------------------------
// Pure standard Web & PWA APIs (Geolocation, Web Share, Vibration, Notifications,
// Screen Wake Lock, and beforeinstallprompt install prompt).
// ============================================================================

export const isNative = false;
export const platform = 'web';

export const PUBLIC_WEB_URL = 'https://titomassa.github.io/DIRECT-GPS/';

let wakeLockSentinel = null;
let deferredInstallPrompt = null;
const installListeners = new Set();

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    for (const fn of installListeners) {
      try {
        fn(true);
      } catch {
        // ignore listener errors
      }
    }
  });
  window.addEventListener('appinstalled', () => {
    deferredInstallPrompt = null;
    for (const fn of installListeners) {
      try {
        fn(false);
      } catch {
        // ignore
      }
    }
  });
}

export function onPwaInstallAvailable(cb) {
  if (typeof cb === 'function') {
    installListeners.add(cb);
    if (deferredInstallPrompt) cb(true);
  }
  return () => installListeners.delete(cb);
}

export async function promptPwaInstall() {
  if (!deferredInstallPrompt) return 'unavailable';
  try {
    deferredInstallPrompt.prompt();
    const res = await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    return res?.outcome === 'accepted' ? 'accepted' : 'dismissed';
  } catch {
    return 'failed';
  }
}

export function isPwaInstalled() {
  if (typeof window === 'undefined') return false;
  return Boolean(
    window.matchMedia?.('(display-mode: standalone)')?.matches ||
      window.navigator?.standalone === true
  );
}

const safe = async (fn, fallback = null) => {
  try {
    return await fn();
  } catch {
    return fallback;
  }
};

export function parseDeepLink(rawUrl) {
  if (!rawUrl) return null;
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  const out = { stopId: '', codLinea: '000', tab: '', action: '' };
  const qp = url.searchParams;
  out.stopId = (qp.get('idParada') || qp.get('parada') || '').trim().toUpperCase();
  out.codLinea = qp.get('codLinea') || '000';
  out.tab = (qp.get('tab') || '').trim().toLowerCase();

  if (!out.stopId && !out.tab && !out.action) return null;
  return out;
}

export function buildShareUrl(stopId, codLinea = '000') {
  const base =
    typeof window !== 'undefined' && window.location?.origin && window.location.origin !== 'null'
      ? `${window.location.origin}${window.location.pathname}`
      : PUBLIC_WEB_URL;
  const url = new URL(base);
  url.searchParams.set('idParada', stopId);
  if (codLinea && codLinea !== '000') url.searchParams.set('codLinea', codLinea);
  return url.toString();
}

export async function initNative() {
  if (typeof document !== 'undefined') {
    document.documentElement.classList.add('is-web', 'platform-web');
  }
  return null;
}

export function hideSplash() {}
export function minimizeApp() {}

export function setSystemBarsTheme(theme) {
  if (typeof document === 'undefined') return;
  const meta = document.getElementById('meta-theme-color');
  if (meta) meta.setAttribute('content', theme === 'light' ? '#f4f5f7' : '#0b0d10');
}

export async function setKeepAwake(enabled) {
  if (typeof navigator === 'undefined' || !navigator.wakeLock) return;
  if (enabled) {
    if (!wakeLockSentinel) {
      wakeLockSentinel = await safe(() => navigator.wakeLock.request('screen'), null);
      if (wakeLockSentinel) {
        wakeLockSentinel.addEventListener?.('release', () => {
          wakeLockSentinel = null;
        });
      }
    }
  } else if (wakeLockSentinel) {
    await safe(() => wakeLockSentinel.release());
    wakeLockSentinel = null;
  }
}

export async function getCurrentPosition({ enableHighAccuracy = true, timeout = 9000 } = {}) {
  if (!navigator.geolocation) {
    const err = new Error('Geolocalización no disponible');
    err.code = 2;
    throw err;
  }
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition((p) => resolve(p.coords), reject, {
      enableHighAccuracy,
      timeout,
      maximumAge: 15000
    });
  });
}

export async function shareStop({ id, nombre, codLinea = '000' }) {
  const url = buildShareUrl(id, codLinea);
  const title = `Parada ${id} · DIRECT GPS`;
  const text = `${nombre || `Parada ${id}`} — arribos en vivo en Corrientes`;

  if (navigator.share) {
    try {
      await navigator.share({ title, text, url });
      return 'shared';
    } catch (e) {
      if (e?.name === 'AbortError') return 'cancelled';
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    return 'copied';
  } catch {
    return 'failed';
  }
}

export function haptic(kind = 'light') {
  if (typeof navigator !== 'undefined' && navigator.vibrate && kind !== 'light') {
    navigator.vibrate(kind === 'success' ? [40, 60, 40] : 25);
  }
}

export async function ensureNotificationPermission() {
  if (typeof Notification === 'undefined') return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  return (await safe(() => Notification.requestPermission(), 'denied')) === 'granted';
}

export async function notifyArrival({ title, body }) {
  haptic('success');
  if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
    safe(() => new Notification(title, { body, icon: './icon.svg' }));
  }
}
