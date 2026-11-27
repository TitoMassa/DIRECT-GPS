// ============================================================================
// DIRECT GPS · Web / PWA & Android Native Notification Platform Layer
// ----------------------------------------------------------------------------
// Pure standard Web & PWA APIs:
//  - Geolocation, Web Share, Vibration, Screen Wake Lock, beforeinstallprompt
//  - Android-native ServiceWorkerRegistration.showNotification() with phone's
//    own notification ringtone (timbre), live Uber-style status bar updates,
//    and direct action buttons (Subir / Bajar / Detener)
//  - MediaSession + silent PCM WAV keep-alive so active alerts, live tracking,
//    and A Bordo voice announcements keep running when minimized/screen locked.
// ============================================================================

export const isNative = Boolean(
  typeof window !== 'undefined' && window.Capacitor?.isNativePlatform?.()
);
export const platform = isNative
  ? (typeof window !== 'undefined' && window.Capacitor?.getPlatform?.()) || 'android'
  : 'web';

export function getDirectGpsNativePlugin() {
  if (typeof window === 'undefined') return null;
  if (!window.Capacitor?.isNativePlatform?.()) return null;
  return window.Capacitor?.Plugins?.DirectGpsNative || null;
}

export const PUBLIC_WEB_URL = 'https://titomassa.github.io/DIRECT-GPS/';

let wakeLockSentinel = null;
let deferredInstallPrompt = null;
let cachedNativeNotifPerm = 'prompt';
const installListeners = new Set();
const swNotifActionListeners = new Set();

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
  if (typeof navigator !== 'undefined' && navigator.serviceWorker) {
    navigator.serviceWorker.addEventListener('message', (event) => {
      const msg = event?.data;
      if (!msg || msg.type !== 'DIRECT_GPS_NOTIF_ACTION') return;
      for (const fn of swNotifActionListeners) {
        try {
          fn(msg.action, msg.data || {});
        } catch {
          // ignore
        }
      }
    });
  }
}

export function onPwaInstallAvailable(cb) {
  if (typeof cb === 'function') {
    installListeners.add(cb);
    if (deferredInstallPrompt) cb(true);
  }
  return () => installListeners.delete(cb);
}

export function onSwNotificationAction(cb) {
  if (typeof cb === 'function') swNotifActionListeners.add(cb);
  return () => swNotifActionListeners.delete(cb);
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
  if (isNative) return true;
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
  out.action = (qp.get('action') || '').trim().toLowerCase();

  if (!out.stopId && !out.tab && !out.action) return null;
  return out;
}

export function buildShareUrl(stopId, codLinea = '000') {
  const base =
    !isNative &&
    typeof window !== 'undefined' &&
    window.location?.origin &&
    window.location.origin !== 'null'
      ? `${window.location.origin}${window.location.pathname}`
      : PUBLIC_WEB_URL;
  const url = new URL(base);
  url.searchParams.set('idParada', stopId);
  if (codLinea && codLinea !== '000') url.searchParams.set('codLinea', codLinea);
  return url.toString();
}

export async function initNative() {
  if (typeof document !== 'undefined') {
    document.documentElement.classList.add(isNative ? 'is-native' : 'is-web', `platform-${platform}`);
  }
  const plugin = getDirectGpsNativePlugin();
  if (plugin) {
    const status = await safe(() => plugin.getPermissionsStatus(), null);
    if (status?.notifications) cachedNativeNotifPerm = status.notifications;
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

// ── Android-Native (Capacitor Foreground Service / Service Worker) Notifications ──

export function getNotificationPermissionState() {
  if (getDirectGpsNativePlugin()) {
    return cachedNativeNotifPerm === 'granted' ? 'granted' : 'default';
  }
  if (typeof Notification === 'undefined') return 'unsupported';
  return Notification.permission || 'default';
}

export async function ensureNotificationPermission() {
  const plugin = getDirectGpsNativePlugin();
  if (plugin) {
    const res = await safe(() => plugin.requestAllPermissions(), null);
    cachedNativeNotifPerm = res?.notifications || 'prompt';
    return cachedNativeNotifPerm === 'granted';
  }
  if (typeof Notification === 'undefined') return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  return (await safe(() => Notification.requestPermission(), 'denied')) === 'granted';
}

export async function openAndroidBatterySettings() {
  const plugin = getDirectGpsNativePlugin();
  if (!plugin) return false;
  await safe(() => plugin.openBatteryOptimizationSettings());
  return true;
}

export async function speakViaNativeAndroid(text, { delayMs = 0 } = {}) {
  const plugin = getDirectGpsNativePlugin();
  if (!plugin || !text) return false;
  await safe(() => plugin.speakNative({ text: String(text), delayMs: Number(delayMs) || 0 }));
  return true;
}

export async function upsertNativeWatchAlert(payload = {}) {
  const plugin = getDirectGpsNativePlugin();
  if (!plugin?.upsertWatchAlert) return false;
  await safe(() => plugin.upsertWatchAlert(payload));
  return true;
}

export async function removeNativeWatchAlert(key = '') {
  const plugin = getDirectGpsNativePlugin();
  if (!plugin?.removeWatchAlert || !key) return false;
  await safe(() => plugin.removeWatchAlert({ key: String(key) }));
  return true;
}

export async function clearNativeWatchAlerts() {
  const plugin = getDirectGpsNativePlugin();
  if (!plugin?.clearWatchAlerts) return false;
  await safe(() => plugin.clearWatchAlerts());
  return true;
}

export async function getNativeWatchedAlerts() {
  const plugin = getDirectGpsNativePlugin();
  if (!plugin?.getWatchedAlerts) return null;
  const res = await safe(() => plugin.getWatchedAlerts(), null);
  return Array.isArray(res?.alerts) ? res.alerts : [];
}

export function onNativeWatchedAlertsChanged(cb) {
  const plugin = getDirectGpsNativePlugin();
  if (!plugin?.addListener || typeof cb !== 'function') return () => {};
  let handle = null;
  try {
    const p = plugin.addListener('watchedAlertsChanged', (ev) => {
      try {
        cb(Array.isArray(ev?.alerts) ? ev.alerts : []);
      } catch {
        // ignore
      }
    });
    if (p && typeof p.then === 'function') {
      p.then((h) => {
        handle = h;
      }).catch(() => {});
    } else {
      handle = p;
    }
  } catch {
    // ignore
  }
  return () => {
    try {
      handle?.remove?.();
    } catch {
      // ignore
    }
  };
}

async function getActiveSwRegistration() {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;
  try {
    const reg = (await navigator.serviceWorker.getRegistration?.()) || (await navigator.serviceWorker.ready);
    return reg && typeof reg.showNotification === 'function' ? reg : null;
  } catch {
    return null;
  }
}

export async function showSystemNotification({
  title,
  body,
  tag = 'direct-gps-alert',
  silent = false,
  renotify = true,
  requireInteraction = false,
  vibrate = null,
  actions = null,
  data = {},
  speechText = '',
  speakAfterChime = false
} = {}) {
  const plugin = getDirectGpsNativePlugin();
  if (plugin) {
    const res = await safe(
      () =>
        plugin.sendAlertNotification({
          title: String(title || 'DIRECT GPS'),
          body: String(body || ''),
          tag: String(tag || 'direct-gps-alert'),
          playSound: !silent,
          speechText: String(speechText || ''),
          speakAfterChime: Boolean(speakAfterChime && speechText)
        }),
      null
    );
    return { delivered: Boolean(res?.delivered), usedNativeSw: true, handledSpeechNatively: Boolean(speakAfterChime && speechText) };
  }

  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') {
    return { delivered: false, usedNativeSw: false, handledSpeechNatively: false };
  }

  const options = {
    body: String(body || ''),
    icon: './icons/icon-192.png',
    badge: './icons/icon-192.png',
    tag,
    silent: Boolean(silent),
    renotify: Boolean(!silent && renotify),
    requireInteraction: Boolean(requireInteraction),
    timestamp: Date.now(),
    data: { ...data, tag }
  };

  if (!silent && Array.isArray(vibrate) && vibrate.length > 0) {
    options.vibrate = vibrate;
  }
  if (Array.isArray(actions) && actions.length > 0) {
    options.actions = actions.slice(0, 2);
  }

  const reg = await getActiveSwRegistration();
  if (reg) {
    try {
      await reg.showNotification(String(title || 'DIRECT GPS'), options);
      return { delivered: true, usedNativeSw: true, handledSpeechNatively: false };
    } catch {
      try {
        const { actions: _a, ...basicOpts } = options;
        await reg.showNotification(String(title || 'DIRECT GPS'), basicOpts);
        return { delivered: true, usedNativeSw: true, handledSpeechNatively: false };
      } catch {
        // Fall through to desktop Notification API
      }
    }
  }

  try {
    new Notification(String(title || 'DIRECT GPS'), {
      body: options.body,
      icon: options.icon,
      tag: options.tag,
      silent: options.silent
    });
    return { delivered: true, usedNativeSw: false, handledSpeechNatively: false };
  } catch {
    return { delivered: false, usedNativeSw: false, handledSpeechNatively: false };
  }
}

export async function closeSystemNotification(tag = 'direct-gps-live-track') {
  const plugin = getDirectGpsNativePlugin();
  if (plugin) {
    await safe(() => plugin.stopTrip({ silent: true }));
    return;
  }
  const reg = await getActiveSwRegistration();
  if (!reg || typeof reg.getNotifications !== 'function') return;
  try {
    const list = await reg.getNotifications({ tag });
    for (const n of list) {
      try {
        n.close();
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }
}

export async function notifyArrival({
  title,
  body,
  stopId = '',
  tag = 'direct-gps-arrival',
  silent = false,
  renotify = true,
  actions = null,
  data = {},
  speechText = '',
  speakAfterChime = false
} = {}) {
  if (!silent) haptic('success');
  return showSystemNotification({
    title,
    body,
    tag,
    silent,
    renotify,
    vibrate: silent ? null : [140, 80, 140],
    actions,
    data: { stopId, ...data },
    speechText,
    speakAfterChime
  });
}

// ── Background Keep-Alive for Minimized / Screen-Locked Android Sessions ────
// Uses a 100% silent in-memory PCM WAV loop + MediaSession metadata while an
// active alert, Uber live tracker, or A Bordo session is running so Android
// Chrome keeps timers, GPS polling, notifications, and TTS alive in background.

let keepAliveAudio = null;
let keepAliveUrl = null;
let keepAliveActive = false;

function buildSilentWavBlobUrl(durationSec = 2, sampleRate = 8000) {
  const numSamples = sampleRate * durationSec;
  const buffer = new ArrayBuffer(44 + numSamples);
  const view = new DataView(buffer);
  const writeStr = (off, s) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + numSamples, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, 1, true); // Mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate, true); // byte rate (8-bit mono)
  view.setUint16(32, 1, true); // block align
  view.setUint16(34, 8, true); // bits per sample
  writeStr(36, 'data');
  view.setUint32(40, numSamples, true);
  // 8-bit unsigned PCM silence = 128
  new Uint8Array(buffer, 44).fill(128);
  const blob = new Blob([buffer], { type: 'audio/wav' });
  return URL.createObjectURL(blob);
}

export function startBackgroundKeepAlive({ title = 'DIRECT GPS · Seguimiento activo', artist = 'Corrientes en vivo', onStop = null } = {}) {
  if (typeof window === 'undefined' || typeof Audio === 'undefined') return false;
  try {
    if (!keepAliveUrl) {
      keepAliveUrl = buildSilentWavBlobUrl(2, 8000);
    }
    if (!keepAliveAudio) {
      keepAliveAudio = new Audio(keepAliveUrl);
      keepAliveAudio.loop = true;
      keepAliveAudio.volume = 0.001;
      keepAliveAudio.setAttribute?.('playsinline', 'true');
    }
    keepAliveActive = true;
    keepAliveAudio.play?.().catch(() => {});
    updateBackgroundSessionMetadata({ title, artist, onStop });
    return true;
  } catch {
    return false;
  }
}

export function updateBackgroundSessionMetadata({ title = 'DIRECT GPS', artist = 'Seguimiento en vivo', onStop = null } = {}) {
  if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
  try {
    if (typeof MediaMetadata !== 'undefined') {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: String(title || 'DIRECT GPS'),
        artist: String(artist || 'Seguimiento en vivo'),
        album: 'DIRECT GPS · Corrientes',
        artwork: [
          { src: './icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: './icons/icon-512.png', sizes: '512x512', type: 'image/png' }
        ]
      });
    }
    navigator.mediaSession.playbackState = keepAliveActive ? 'playing' : 'none';
    if (typeof onStop === 'function') {
      try {
        navigator.mediaSession.setActionHandler('stop', () => onStop());
      } catch {
        // ignore unsupported action
      }
    }
  } catch {
    // ignore
  }
}

export function stopBackgroundKeepAlive() {
  keepAliveActive = false;
  if (keepAliveAudio) {
    try {
      keepAliveAudio.pause();
      keepAliveAudio.currentTime = 0;
    } catch {
      // ignore
    }
  }
  if (typeof navigator !== 'undefined' && 'mediaSession' in navigator) {
    try {
      navigator.mediaSession.playbackState = 'none';
      navigator.mediaSession.metadata = null;
    } catch {
      // ignore
    }
  }
}
