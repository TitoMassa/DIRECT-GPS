import {
  staticBootstrap,
  staticCalles,
  staticIntersecciones,
  staticParadas,
  staticParadasCercanas,
  staticRecorridos,
  staticArribos
} from './static-data.js';

// Supports optional custom backend proxy via ?api=https://mi-proxy.onrender.com
function resolveApiBase() {
  const params = new URLSearchParams(window.location.search);
  const custom = params.get('api');
  if (custom) {
    const clean = custom.replace(/\/+$/, '');
    localStorage.setItem('direct_gps_api_base', clean);
    return clean;
  }
  const saved = localStorage.getItem('direct_gps_api_base');
  if (saved) return saved;
  return '';
}

const API_BASE = resolveApiBase();
let staticModeDetected = null; // null = unknown, true = GitHub Pages static mode, false = Node proxy active

async function apiGetWithFallback(path, fallbackFn) {
  if (staticModeDetected === true) {
    return fallbackFn();
  }

  try {
    const res = await fetch(`${API_BASE}${path}`, { headers: { Accept: 'application/json' } });
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('application/json')) {
      // GitHub Pages returns HTML 404 for /api/* -> seamlessly engage static mode
      staticModeDetected = true;
      return fallbackFn();
    }
    const json = await res.json();
    if (!res.ok) {
      throw new Error(json.error || `Error ${res.status}`);
    }
    staticModeDetected = false;
    return json;
  } catch {
    if (staticModeDetected === null) {
      staticModeDetected = true;
    }
    return fallbackFn();
  }
}

export function isStaticHostingMode() {
  return staticModeDetected === true;
}

export const api = {
  bootstrap: () => apiGetWithFallback('/api/bootstrap', () => staticBootstrap()),
  lineas: () => apiGetWithFallback('/api/lineas', () => ({ data: staticBootstrap().lineas, source: 'simulation' })),
  calles: (codLinea) =>
    apiGetWithFallback(`/api/calles?codLinea=${encodeURIComponent(codLinea)}`, () => staticCalles()),
  intersecciones: (codLinea, codCalle) =>
    apiGetWithFallback(
      `/api/intersecciones?codLinea=${encodeURIComponent(codLinea)}&codCalle=${encodeURIComponent(codCalle)}`,
      () => staticIntersecciones(codCalle)
    ),
  paradas: (codLinea, codCalle, codInterseccion) =>
    apiGetWithFallback(
      `/api/paradas?codLinea=${encodeURIComponent(codLinea)}&codCalle=${encodeURIComponent(codCalle)}&codInterseccion=${encodeURIComponent(codInterseccion)}`,
      () => staticParadas(codCalle, codInterseccion)
    ),
  paradasCercanas: (lat, lng) =>
    apiGetWithFallback(
      `/api/paradas-cercanas?lat=${encodeURIComponent(lat)}&lng=${encodeURIComponent(lng)}`,
      () => staticParadasCercanas()
    ),
  recorridos: (codLinea) =>
    apiGetWithFallback(`/api/recorridos?codLinea=${encodeURIComponent(codLinea)}`, () =>
      staticRecorridos(codLinea)
    ),
  arribos: (idParada, codLinea = '0', simulate = false) => {
    if (simulate) {
      return Promise.resolve(staticArribos(idParada, codLinea));
    }
    return apiGetWithFallback(
      `/api/arribos?idParada=${encodeURIComponent(idParada)}&codLinea=${encodeURIComponent(codLinea)}`,
      () => staticArribos(idParada, codLinea)
    );
  }
};

// Haversine distance in meters
export function distanceMeters(lat1, lng1, lat2, lng2) {
  if ([lat1, lng1, lat2, lng2].some((v) => typeof v !== 'number' || Number.isNaN(v))) {
    return null;
  }
  const R = 6371000;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function formatDistance(meters) {
  if (meters === null || meters === undefined) return 'GPS s/d';
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(2)} km`;
}

export function formatBlocks(meters) {
  if (meters === null || meters === undefined) return '—';
  const blocks = Math.max(1, Math.round(meters / 100));
  return `~${blocks}`;
}

export function formatWalkMin(meters) {
  if (meters === null || meters === undefined) return '';
  const mins = Math.max(1, Math.round(meters / 75));
  return `${mins} min a pie`;
}

export function parseEtaMinutes(rawText = '') {
  const lower = String(rawText).trim().toLowerCase();
  if (!lower) return { minutes: 99, display: '—', unit: '', urgency: 'later' };
  if (lower.includes('llegando') || lower.includes('arribando') || lower === '0' || lower.startsWith('0 ')) {
    return { minutes: 0, display: 'YA', unit: 'Llegando', urgency: 'now' };
  }
  const m = lower.match(/(\d+)/);
  if (m) {
    const mins = parseInt(m[1], 10);
    const urgency = mins <= 3 ? 'now' : mins <= 9 ? 'soon' : 'later';
    return { minutes: mins, display: `${mins}`, unit: 'min', urgency };
  }
  return { minutes: 99, display: rawText, unit: '', urgency: 'later' };
}

export function computeProximityPercent(etaMinutes, meters) {
  if (etaMinutes <= 1) return 96;
  if (typeof meters === 'number' && !Number.isNaN(meters)) {
    const pct = 100 - (Math.min(meters, 4000) / 4000) * 90;
    return Math.round(Math.max(8, Math.min(98, pct)));
  }
  const pct = 100 - (Math.min(etaMinutes, 30) / 30) * 88;
  return Math.round(Math.max(10, Math.min(95, pct)));
}
