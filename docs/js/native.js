// ============================================================================
// DIRECT GPS · Native Android bridge (Capacitor)
// ----------------------------------------------------------------------------
// Single integration layer between the web app and the Android system.
// Every helper degrades gracefully to standard Web APIs when the app runs as a
// regular website / PWA (GitHub Pages), so app.js never needs to branch on the
// platform itself.
// ============================================================================
import { Capacitor, registerPlugin } from '../vendor/capacitor/core.js';

export const isNative = Capacitor.isNativePlatform();
export const platform = Capacitor.getPlatform();

// Public, shareable home of the web version (used for share links & deep links)
export const PUBLIC_WEB_URL = 'https://titomassa.github.io/DIRECT-GPS/';
export const APP_SCHEME = 'directgps';

const ARRIVALS_CHANNEL = 'arribos';

// Plugin proxies (only resolved on native; calls are routed to the Android side)
const App = isNative ? registerPlugin('App') : null;
const Geolocation = isNative ? registerPlugin('Geolocation') : null;
const StatusBar = isNative ? registerPlugin('StatusBar') : null;
const SplashScreen = isNative ? registerPlugin('SplashScreen') : null;
const Haptics = isNative ? registerPlugin('Haptics') : null;
const LocalNotifications = isNative ? registerPlugin('LocalNotifications') : null;
const Share = isNative ? registerPlugin('Share') : null;
const Keyboard = isNative ? registerPlugin('Keyboard') : null;
const SystemUi = isNative ? registerPlugin('SystemUi') : null; // custom, see SystemUiPlugin.java

let notifPermission = null; // 'granted' | 'denied' | null (unknown)
let notifSeq = 1000;

const safe = async (fn, fallback = null) => {
  try {
    return await fn();
  } catch {
    return fallback;
  }
};

// ---------------------------------------------------------------------------
// Deep links: directgps://parada/CT31498 · directgps://tab/cercanas ·
// https://titomassa.github.io/DIRECT-GPS/?idParada=CT31498&codLinea=000
// ---------------------------------------------------------------------------
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

  if (url.protocol === `${APP_SCHEME}:`) {
    // For custom schemes the "host" is the first segment: directgps://parada/CT31498
    const segments = [url.hostname, ...url.pathname.split('/')].filter(Boolean);
    const [kind, value] = segments;
    if (kind === 'parada' && value) out.stopId = decodeURIComponent(value).trim().toUpperCase();
    else if (kind === 'tab' && value) out.tab = value.toLowerCase();
    else if (kind === 'gps' || kind === 'cercanas') out.action = 'locate';
    else if (kind === 'favoritas') out.tab = 'favoritas';
    else if (kind === 'lineas') out.tab = 'lineas';
  }

  if (!out.stopId && !out.tab && !out.action) return null;
  return out;
}

export function buildShareUrl(stopId, codLinea = '000') {
  const url = new URL(PUBLIC_WEB_URL);
  url.searchParams.set('idParada', stopId);
  if (codLinea && codLinea !== '000') url.searchParams.set('codLinea', codLinea);
  return url.toString();
}

// ---------------------------------------------------------------------------
// Lifecycle & system events
// ---------------------------------------------------------------------------
/**
 * @param {{
 *   onBack?: () => boolean | Promise<boolean>,   // return true if handled
 *   onResume?: () => void,
 *   onPause?: () => void,
 *   onDeepLink?: (link: ReturnType<typeof parseDeepLink>) => void,
 *   onKeyboard?: (open: boolean, height: number) => void,
 * }} handlers
 * @returns {Promise<ReturnType<typeof parseDeepLink>>} launch deep link, if any
 */
export async function initNative(handlers = {}) {
  const root = document.documentElement;
  root.classList.add(isNative ? 'is-native' : 'is-web', `platform-${platform}`);

  if (!isNative) return null;

  App.addListener('backButton', async () => {
    const handled = handlers.onBack ? await handlers.onBack() : false;
    if (!handled) safe(() => App.minimizeApp());
  });

  App.addListener('appStateChange', ({ isActive }) => {
    root.classList.toggle('app-paused', !isActive);
    if (isActive) handlers.onResume?.();
    else handlers.onPause?.();
  });

  App.addListener('appUrlOpen', ({ url }) => {
    const link = parseDeepLink(url);
    if (link) handlers.onDeepLink?.(link);
  });

  // Tapping an arrival notification brings the user to that stop
  LocalNotifications.addListener('localNotificationActionPerformed', ({ notification }) => {
    const stopId = notification?.extra?.stopId;
    if (stopId) handlers.onDeepLink?.({ stopId, codLinea: '000', tab: '', action: '' });
  });

  Keyboard.addListener('keyboardWillShow', ({ keyboardHeight }) => {
    root.classList.add('keyboard-open');
    root.style.setProperty('--keyboard-h', `${keyboardHeight || 0}px`);
    handlers.onKeyboard?.(true, keyboardHeight || 0);
  });
  Keyboard.addListener('keyboardWillHide', () => {
    root.classList.remove('keyboard-open');
    root.style.setProperty('--keyboard-h', '0px');
    handlers.onKeyboard?.(false, 0);
  });

  // Dedicated high-importance channel so arrival alerts can pop up as heads-up
  safe(() =>
    LocalNotifications.createChannel({
      id: ARRIVALS_CHANNEL,
      name: 'Arribos de colectivos',
      description: 'Avisos cuando una línea está a 3 minutos o menos de tu parada',
      importance: 5,
      visibility: 1,
      vibration: true,
      lights: true,
      lightColor: '#10b981'
    })
  );

  const launch = await safe(() => App.getLaunchUrl());
  return parseDeepLink(launch?.url);
}

export function hideSplash() {
  if (isNative) safe(() => SplashScreen.hide({ fadeOutDuration: 250 }));
}

export function minimizeApp() {
  if (isNative) safe(() => App.minimizeApp());
}

// ---------------------------------------------------------------------------
// System bars follow the in-app theme (status bar + navigation bar)
// ---------------------------------------------------------------------------
export function setSystemBarsTheme(theme) {
  if (!isNative) return;
  const isLight = theme === 'light';
  const color = isLight ? '#e5ebf2' : '#0f141b';
  // StatusBar "DARK" style = light icons (for dark backgrounds)
  safe(() => StatusBar.setStyle({ style: isLight ? 'LIGHT' : 'DARK' }));
  safe(() => StatusBar.setBackgroundColor({ color }));
  safe(() => SystemUi.setNavigationBar({ color: isLight ? '#ffffff' : '#10151c', lightButtons: isLight }));
}

export function setKeepAwake(enabled) {
  if (isNative) safe(() => SystemUi.setKeepAwake({ enabled: Boolean(enabled) }));
}

// ---------------------------------------------------------------------------
// Location (native permission flow on Android, Web Geolocation elsewhere)
// ---------------------------------------------------------------------------
export async function getCurrentPosition({ enableHighAccuracy = true, timeout = 9000 } = {}) {
  if (isNative) {
    let perm = await safe(() => Geolocation.checkPermissions());
    if (!perm || (perm.location !== 'granted' && perm.coarseLocation !== 'granted')) {
      perm = await safe(() => Geolocation.requestPermissions({ permissions: ['location', 'coarseLocation'] }));
    }
    if (!perm || (perm.location !== 'granted' && perm.coarseLocation !== 'granted')) {
      const err = new Error('Permiso de ubicación denegado');
      err.code = 1;
      throw err;
    }
    const pos = await Geolocation.getCurrentPosition({ enableHighAccuracy, timeout, maximumAge: 15000 });
    return pos.coords;
  }

  if (!navigator.geolocation) {
    const err = new Error('Geolocalización no disponible');
    err.code = 2;
    throw err;
  }
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition((p) => resolve(p.coords), reject, {
      enableHighAccuracy,
      timeout
    });
  });
}

// ---------------------------------------------------------------------------
// Share sheet (Android intent chooser / Web Share / clipboard fallback)
// ---------------------------------------------------------------------------
/** @returns {Promise<'shared' | 'copied' | 'cancelled' | 'failed'>} */
export async function shareStop({ id, nombre, codLinea = '000' }) {
  const url = buildShareUrl(id, codLinea);
  const title = `Parada ${id} · DIRECT GPS`;
  const text = `${nombre || `Parada ${id}`} — arribos en vivo en Corrientes`;

  if (isNative) {
    try {
      await Share.share({ title, text, url, dialogTitle: 'Compartir parada' });
      return 'shared';
    } catch (e) {
      return /cancel/i.test(String(e?.message || e)) ? 'cancelled' : 'failed';
    }
  }

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

// ---------------------------------------------------------------------------
// Haptics
// ---------------------------------------------------------------------------
export function haptic(kind = 'light') {
  if (isNative) {
    if (kind === 'success' || kind === 'warning') {
      safe(() => Haptics.notification({ type: kind === 'success' ? 'SUCCESS' : 'WARNING' }));
    } else {
      safe(() => Haptics.impact({ style: kind === 'medium' ? 'MEDIUM' : 'LIGHT' }));
    }
    return;
  }
  if (navigator.vibrate && kind !== 'light') navigator.vibrate(kind === 'success' ? [40, 60, 40] : 25);
}

// ---------------------------------------------------------------------------
// Arrival notifications (Android notification shade / heads-up)
// ---------------------------------------------------------------------------
export async function ensureNotificationPermission() {
  if (!isNative) {
    if (typeof Notification === 'undefined') return false;
    if (Notification.permission === 'granted') return true;
    if (Notification.permission === 'denied') return false;
    return (await safe(() => Notification.requestPermission(), 'denied')) === 'granted';
  }
  if (notifPermission === 'granted') return true;
  let perm = await safe(() => LocalNotifications.checkPermissions());
  if (perm?.display !== 'granted') perm = await safe(() => LocalNotifications.requestPermissions());
  notifPermission = perm?.display === 'granted' ? 'granted' : 'denied';
  return notifPermission === 'granted';
}

export async function notifyArrival({ title, body, stopId = '' }) {
  haptic('success');
  if (isNative) {
    if (!(await ensureNotificationPermission())) return;
    notifSeq = (notifSeq % 100000) + 1;
    safe(() =>
      LocalNotifications.schedule({
        notifications: [
          {
            id: notifSeq,
            title,
            body,
            channelId: ARRIVALS_CHANNEL,
            smallIcon: 'ic_stat_directgps',
            iconColor: '#10b981',
            autoCancel: true,
            extra: { stopId }
          }
        ]
      })
    );
    return;
  }
  // Web: only surface a system notification if the tab is in the background
  if (document.hidden && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
    safe(() => new Notification(title, { body, icon: './icon.svg', tag: `arribo-${stopId}` }));
  }
}
