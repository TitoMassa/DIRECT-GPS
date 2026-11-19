import { DEFAULT_API_BASE } from './config.js';
import {
  staticBootstrap,
  staticCalles,
  staticIntersecciones,
  staticParadas,
  staticParadasCercanas,
  staticRecorridos
} from './static-data.js';

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

  // On localhost, prefer local Node server.js; on GitHub Pages / remote hosting, use Cloudflare Worker
  const host = window.location.hostname;
  if (host === 'localhost' || host === '127.0.0.1') {
    return '';
  }
  return (DEFAULT_API_BASE || '').replace(/\/+$/, '');
}

const API_BASE = resolveApiBase();

async function apiGet(path, fallbackFn = null) {
  try {
    const res = await fetch(`${API_BASE}${path}`, { headers: { Accept: 'application/json' } });
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('application/json')) {
      throw new Error(`Respuesta no JSON (${res.status})`);
    }
    const json = await res.json();
    if (!res.ok) {
      throw new Error(json.error || `Error ${res.status}`);
    }
    return json;
  } catch (err) {
    if (fallbackFn) return fallbackFn(err);
    throw err;
  }
}

export function getActiveApiBase() {
  return API_BASE || window.location.origin;
}

export const api = {
  bootstrap: () => apiGet('/api/bootstrap', () => staticBootstrap()),
  lineas: () => apiGet('/api/lineas', () => ({ data: staticBootstrap().lineas, source: 'fallback' })),
  calles: (codLinea) =>
    apiGet(`/api/calles?codLinea=${encodeURIComponent(codLinea)}`, () => staticCalles()),
  intersecciones: (codLinea, codCalle) =>
    apiGet(
      `/api/intersecciones?codLinea=${encodeURIComponent(codLinea)}&codCalle=${encodeURIComponent(codCalle)}`,
      () => staticIntersecciones(codCalle)
    ),
  paradas: (codLinea, codCalle, codInterseccion) =>
    apiGet(
      `/api/paradas?codLinea=${encodeURIComponent(codLinea)}&codCalle=${encodeURIComponent(codCalle)}&codInterseccion=${encodeURIComponent(codInterseccion)}`,
      () => staticParadas(codCalle, codInterseccion)
    ),
  paradasCercanas: (lat, lng) =>
    apiGet(
      `/api/paradas-cercanas?lat=${encodeURIComponent(lat)}&lng=${encodeURIComponent(lng)}`,
      () => staticParadasCercanas()
    ),
  recorridos: (codLinea) =>
    apiGet(`/api/recorridos?codLinea=${encodeURIComponent(codLinea)}`, () =>
      staticRecorridos(codLinea)
    ),
  banderas: (idParada) =>
    apiGet(`/api/banderas?idParada=${encodeURIComponent(idParada)}`, () => ({ data: [], source: 'fallback' })),
  arribos: (idParada, codLinea = '000') => {
    const code = !codLinea || codLinea === '0' ? '000' : String(codLinea);
    return apiGet(`/api/arribos?idParada=${encodeURIComponent(idParada)}&codLinea=${encodeURIComponent(code)}`);
  }
};

export function parseDesvioHorario(raw = '') {
  const clean = String(raw || '').trim();
  if (!clean) {
    return { raw: '', status: 'none', label: 'Sin desvío', shortLabel: '—', sign: '' };
  }
  const normalized = clean.replace(/\s+/g, '');
  if (normalized === '00:00' || normalized === '+00:00' || normalized === '-00:00' || normalized === '0') {
    return { raw: clean, status: 'ontime', label: 'En horario (00:00)', shortLabel: 'En horario', sign: '=' };
  }
  if (normalized.startsWith('+')) {
    return {
      raw: clean,
      status: 'ahead',
      label: `Adelantado ${normalized}`,
      shortLabel: `▲ ${normalized}`,
      sign: '+'
    };
  }
  if (normalized.startsWith('-')) {
    return {
      raw: clean,
      status: 'late',
      label: `Atrasado ${normalized}`,
      shortLabel: `▼ ${normalized}`,
      sign: '-'
    };
  }
  return { raw: clean, status: 'ontime', label: clean, shortLabel: clean, sign: '' };
}

export function parseChoferInfo(raw = '', existingNombre = '', existingLegajo = '') {
  if (existingNombre || existingLegajo) {
    return { nombre: existingNombre, legajo: existingLegajo, raw: raw || `${existingNombre} (${existingLegajo})` };
  }
  const clean = String(raw || '').trim();
  if (!clean) return { nombre: '', legajo: '', raw: '' };
  const m = clean.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
  if (m) {
    return { nombre: m[1].trim(), legajo: m[2].trim(), raw: clean };
  }
  return { nombre: clean, legajo: '', raw: clean };
}

export function formatGpsTimeOnly(rawStamp = '') {
  const clean = String(rawStamp || '').trim();
  if (!clean) return '';
  const parts = clean.split(' ');
  return parts.length > 1 ? parts[1] : clean;
}

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
    return { minutes: 0, display: 'YA', unit: 'Arribando', urgency: 'now' };
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

// ============================================================================
// SOAP-Driven Trajectory & Polyline Interpolation Helpers
// Uses real SOAP GPS fixes & real SOAP route polylines for smooth simulation
// ============================================================================
function projectOnSegment(pLat, pLng, aLat, aLng, bLat, bLng) {
  const dx = bLat - aLat;
  const dy = bLng - aLng;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return { lat: aLat, lng: aLng, t: 0 };
  const t = Math.max(0, Math.min(1, ((pLat - aLat) * dx + (pLng - aLng) * dy) / lenSq));
  return { lat: aLat + dx * t, lng: aLng + dy * t, t };
}

function findClosestOnPolyline(pts, targetLat, targetLng) {
  let best = { segIdx: 0, t: 0, lat: pts[0][0], lng: pts[0][1], dist: Infinity };
  for (let i = 0; i < pts.length - 1; i++) {
    const proj = projectOnSegment(targetLat, targetLng, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]);
    const d = distanceMeters(targetLat, targetLng, proj.lat, proj.lng);
    if (d !== null && d < best.dist) {
      best = { segIdx: i, t: proj.t, lat: proj.lat, lng: proj.lng, dist: d };
    }
  }
  return best;
}

export function extractRoutePolylines(recorridos = []) {
  return recorridos
    .map((r) => ({
      bandera: String(r.abreviaturaBanderaSMP || r.descripcion || '').toUpperCase(),
      pts: (r.puntos || [])
        .map((p) => [parseFloat(p.latitud), parseFloat(p.longitud)])
        .filter(([la, ln]) => !Number.isNaN(la) && !Number.isNaN(ln))
    }))
    .filter((r) => r.pts.length > 2);
}

/**
 * Advances a real SOAP bus along its matching real SOAP route polyline (or straight
 * vector toward the stop if no route polyline is loaded yet) by `stepMeters`.
 */
export function interpolateSoapBusStep(bus, stopCoords, stepMeters, polylines = []) {
  if (!stopCoords || typeof bus.lat !== 'number' || typeof bus.lng !== 'number') {
    return { lat: bus.lat, lng: bus.lng, arrived: false };
  }

  // Try matching a real SOAP polyline for this line where both bus and stop lie reasonably near
  let chosenPath = null;
  let busProj = null;
  let stopProj = null;

  for (const poly of polylines) {
    const bp = findClosestOnPolyline(poly.pts, bus.lat, bus.lng);
    const sp = findClosestOnPolyline(poly.pts, stopCoords.lat, stopCoords.lng);
    // Bus must be behind the stop along the polyline direction and within ~450m of the route
    const busOrder = bp.segIdx + bp.t;
    const stopOrder = sp.segIdx + sp.t;
    if (bp.dist < 450 && sp.dist < 450 && busOrder < stopOrder) {
      chosenPath = poly.pts;
      busProj = bp;
      stopProj = sp;
      break;
    }
  }

  if (chosenPath && busProj && stopProj) {
    // Walk forward along the real street polyline from busProj toward stopProj by stepMeters
    let remaining = stepMeters;
    let curLat = busProj.lat;
    let curLng = busProj.lng;
    let idx = busProj.segIdx;

    while (remaining > 0 && idx < chosenPath.length - 1) {
      const nextIsStop = idx === stopProj.segIdx;
      const targetLat = nextIsStop ? stopProj.lat : chosenPath[idx + 1][0];
      const targetLng = nextIsStop ? stopProj.lng : chosenPath[idx + 1][1];
      const segDist = distanceMeters(curLat, curLng, targetLat, targetLng) || 0;

      if (segDist <= 1) {
        if (nextIsStop) return { lat: stopCoords.lat, lng: stopCoords.lng, arrived: true };
        idx++;
        continue;
      }

      if (remaining < segDist) {
        const frac = remaining / segDist;
        return {
          lat: curLat + (targetLat - curLat) * frac,
          lng: curLng + (targetLng - curLng) * frac,
          arrived: false
        };
      }

      remaining -= segDist;
      curLat = targetLat;
      curLng = targetLng;
      if (nextIsStop) return { lat: stopCoords.lat, lng: stopCoords.lng, arrived: true };
      idx++;
    }
    return { lat: curLat, lng: curLng, arrived: false };
  }

  // Fallback: direct interpolation from real SOAP bus position toward real SOAP stop position
  const distToStop = distanceMeters(bus.lat, bus.lng, stopCoords.lat, stopCoords.lng) || 0;
  if (distToStop <= Math.max(15, stepMeters)) {
    return { lat: stopCoords.lat, lng: stopCoords.lng, arrived: true };
  }
  const frac = stepMeters / distToStop;
  return {
    lat: bus.lat + (stopCoords.lat - bus.lat) * frac,
    lng: bus.lng + (stopCoords.lng - bus.lng) * frac,
    arrived: false
  };
}
