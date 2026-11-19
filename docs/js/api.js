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

function getLocalCache(key, maxAgeMs) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (Date.now() - parsed.savedAt > maxAgeMs) {
      localStorage.removeItem(key);
      return null;
    }
    return parsed.value;
  } catch {
    return null;
  }
}

function setLocalCache(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify({ savedAt: Date.now(), value }));
  } catch {
    // Ignore storage quota errors
  }
}

export function getArgentinaNow() {
  return new Date(Date.now() - 3 * 3600 * 1000);
}

export function getArgentinaTodayTipo() {
  const dow = getArgentinaNow().getUTCDay();
  return dow === 0 ? 'domingo' : dow === 6 ? 'sabado' : 'habil';
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
  recorridos: async (codLinea) => {
    const cacheKey = `dgps_rec_v1_${codLinea}`;
    const cached = getLocalCache(cacheKey, 24 * 60 * 60 * 1000);
    if (cached) return { data: cached, source: 'local-cache', cached: true };
    const res = await apiGet(`/api/recorridos?codLinea=${encodeURIComponent(codLinea)}`, () =>
      staticRecorridos(codLinea)
    );
    if (Array.isArray(res?.data) && res.data.length > 0 && res.source !== 'simulation') {
      setLocalCache(cacheKey, res.data);
    }
    return res;
  },
  banderas: (idParada) =>
    apiGet(`/api/banderas?idParada=${encodeURIComponent(idParada)}`, () => ({ data: [], source: 'fallback' })),
  horarios: async (idParada, codLinea, tipoDia = 'auto') => {
    const cleanStop = String(idParada).toUpperCase();
    const resolvedTipo = tipoDia === 'auto' ? getArgentinaTodayTipo() : tipoDia;
    const cacheKey = `dgps_hor_v2_${cleanStop}_${codLinea}_${resolvedTipo}`;

    // Persistent 14-day cache per day-type (habil / sabado / domingo) — full 24h schedules never expire daily!
    const cached = getLocalCache(cacheKey, 14 * 24 * 60 * 60 * 1000);
    if (cached && cached.available && !cached.partial && cached.horarios?.length > 0) {
      return { data: cached, source: 'local-cache', cached: true };
    }

    const res = await apiGet(
      `/api/horarios?idParada=${encodeURIComponent(cleanStop)}&codLinea=${encodeURIComponent(codLinea)}&tipoDia=${encodeURIComponent(resolvedTipo)}`
    );
    const data = res?.data;
    if (data?.available && !data.partial && data.horarios?.length > 0) {
      setLocalCache(cacheKey, data);
    }
    return res;
  },
  arribos: (idParada, codLinea = '000') => {
    const code = !codLinea || codLinea === '0' ? '000' : String(codLinea);
    return apiGet(`/api/arribos?idParada=${encodeURIComponent(idParada)}&codLinea=${encodeURIComponent(code)}`);
  },
  arribosLineaCompleto: (idParada, codLinea) =>
    apiGet(`/api/arribos-linea?idParada=${encodeURIComponent(idParada)}&codLinea=${encodeURIComponent(codLinea)}`)
};

export function parseDesvioHorario(raw = '') {
  const clean = String(raw || '').trim();
  if (!clean) {
    return { raw: '', status: 'none', label: 'Sin desvío', shortLabel: '—', sign: '', minutes: 0 };
  }
  const normalized = clean.replace(/\s+/g, '');
  if (normalized === '00:00' || normalized === '+00:00' || normalized === '-00:00' || normalized === '0') {
    return { raw: clean, status: 'ontime', label: 'En horario', shortLabel: '00:00', sign: '=', minutes: 0 };
  }
  const m = normalized.match(/^([+-])(\d{1,2}):(\d{2})$/);
  const signedMin = m ? (m[1] === '+' ? 1 : -1) * (parseInt(m[2], 10) + parseInt(m[3], 10) / 60) : 0;

  if (normalized.startsWith('+')) {
    return {
      raw: clean,
      status: 'ahead',
      label: `Adelantado ${normalized}`,
      shortLabel: `+${normalized.slice(1)}`,
      sign: '+',
      minutes: signedMin
    };
  }
  if (normalized.startsWith('-')) {
    return {
      raw: clean,
      status: 'late',
      label: `Atrasado ${normalized}`,
      shortLabel: `-${normalized.slice(1)}`,
      sign: '-',
      minutes: signedMin
    };
  }
  return { raw: clean, status: 'ontime', label: clean, shortLabel: clean, sign: '', minutes: 0 };
}

/**
 * Cross-matches live buses against official scheduled pass times (Horarios Programados).
 * Formula: ExpectedScheduledPass = Now + ETA + Desvio (ahead '+' -> scheduled later; late '-' -> scheduled earlier).
 */
export function matchBusesWithHorarios(buses = [], horarios = []) {
  const slotToBus = new Map(); // hora ('17:05') -> bus
  if (!Array.isArray(horarios) || horarios.length === 0) return slotToBus;

  const nowArt = getArgentinaNow();
  const nowMin = nowArt.getUTCHours() * 60 + nowArt.getUTCMinutes() + nowArt.getUTCSeconds() / 60;
  const usedSlots = new Set();

  for (const bus of buses) {
    if (!bus.eta || bus.eta.minutes >= 99) continue;
    const desvioMin = bus.desvio?.minutes || 0;
    const expectedSchedMin = (nowMin + bus.eta.minutes + desvioMin) % 1440;

    let bestSlot = null;
    let bestDiff = 9; // max tolerance ±9 min
    for (const slot of horarios) {
      if (usedSlots.has(slot.hora)) continue;
      let diff = Math.abs(slot.minuteOfDay - expectedSchedMin);
      if (diff > 720) diff = 1440 - diff; // midnight wrap
      if (diff < bestDiff) {
        bestDiff = diff;
        bestSlot = slot;
      }
    }

    if (bestSlot) {
      usedSlots.add(bestSlot.hora);
      bus.turnoProgramado = bestSlot.hora;
      slotToBus.set(bestSlot.hora, bus);
    } else {
      bus.turnoProgramado = null;
    }
  }
  return slotToBus;
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
    const pct = 100 - (Math.min(meters, 6000) / 6000) * 90;
    return Math.round(Math.max(8, Math.min(98, pct)));
  }
  const pct = 100 - (Math.min(etaMinutes, 35) / 35) * 88;
  return Math.round(Math.max(10, Math.min(95, pct)));
}
