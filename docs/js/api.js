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

function isBrowserOffline() {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function apiGet(path, fallbackFn = null, timeoutMs = 8000) {
  if (isBrowserOffline()) {
    const offlineErr = new Error('Sin conexión a internet');
    offlineErr.isOffline = true;
    if (fallbackFn) return fallbackFn(offlineErr);
    throw offlineErr;
  }
  try {
    const res = await fetchWithTimeout(
      `${API_BASE}${path}`,
      { headers: { Accept: 'application/json' } },
      timeoutMs
    );
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

// ── IndexedDB read-only mirror of central system FleetMemory (for offline flights/tunnels) ──
const IDB_NAME = 'direct_gps_system_mirror';
const IDB_STORE = 'snapshots';

function openMirrorDb() {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(IDB_STORE)) {
          req.result.createObjectStore(IDB_STORE);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function saveFleetMirror(snapshot) {
  const db = await openMirrorDb();
  if (!db) return;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(snapshot, 'fleet_memory');
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

async function readFleetMirror() {
  const db = await openMirrorDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).get('fleet_memory');
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

// ── Permanent static archives (docs/data/catalogo.json, recorridos/, horarios/) ──
let catalogoPromise = null;
const archiveHorariosByLine = new Map(); // codLinea -> Promise<file|null>
const archiveRecorridosByLine = new Map(); // codLinea -> Promise<branches|null>

function loadCatalogo() {
  if (!catalogoPromise) {
    const url = new URL('../data/catalogo.json', import.meta.url);
    catalogoPromise = fetch(url)
      .then((res) => (res.ok ? res.json() : null))
      .catch(() => null)
      .then((cat) => {
        if (!cat) {
          catalogoPromise = null;
          return null;
        }
        const stopById = new Map();
        const lineByCode = new Map();
        for (const l of cat.lineas || []) lineByCode.set(Number(l.codigo), l);
        for (const p of cat.paradas || []) stopById.set(String(p.id).toUpperCase(), p);
        return { ...cat, stopById, lineByCode };
      });
  }
  return catalogoPromise;
}

function loadArchiveRecorrido(codLinea) {
  const key = String(Number(codLinea));
  if (!archiveRecorridosByLine.has(key)) {
    const url = new URL(`../data/recorridos/${key}.json`, import.meta.url);
    const p = fetch(url)
      .then((res) => (res.ok ? res.json() : null))
      .catch(() => null)
      .then((data) => {
        if (!Array.isArray(data) || data.length === 0) {
          archiveRecorridosByLine.delete(key);
          return null;
        }
        return data;
      });
    archiveRecorridosByLine.set(key, p);
  }
  return archiveRecorridosByLine.get(key);
}

function loadArchiveLine(codLinea) {
  const key = String(Number(codLinea));
  if (!archiveHorariosByLine.has(key)) {
    const url = new URL(`../data/horarios/${key}.json`, import.meta.url);
    const p = fetch(url, { cache: 'no-cache' })
      .then((res) => (res.ok ? res.json() : null))
      .catch(() => null)
      .then((file) => {
        if (!file) archiveHorariosByLine.delete(key);
        return file;
      });
    archiveHorariosByLine.set(key, p);
  }
  return archiveHorariosByLine.get(key);
}

function splitStopStreet(desc = '') {
  const clean = String(desc || '')
    .replace(/\s+(IDA|VTA|VUELTA)\s*$/i, '')
    .trim();
  if (!clean) return { calle: 'OTRAS', inter: 'PARADA' };
  const parts = clean.split(/\s*[-–]\s*|\s+Y\s+/i).map((s) => s.trim()).filter(Boolean);
  if (parts.length >= 2) {
    return { calle: parts[0], inter: parts.slice(1).join(' - ') };
  }
  return { calle: clean, inter: clean };
}

async function buildOfflineDrillIndex(codLinea) {
  const rec = await loadArchiveRecorrido(codLinea);
  if (!Array.isArray(rec) || rec.length === 0) return null;
  const streetMap = new Map(); // calle -> Map(inter -> stops[])
  const seenStop = new Set();

  for (const branch of rec) {
    for (const s of branch.paradas || []) {
      const id = String(s.identificador || '').trim().toUpperCase();
      if (!id || seenStop.has(id)) continue;
      seenStop.add(id);
      const { calle, inter } = splitStopStreet(s.descripcion || id);
      if (!streetMap.has(calle)) streetMap.set(calle, new Map());
      const interMap = streetMap.get(calle);
      if (!interMap.has(inter)) interMap.set(inter, []);
      interMap.get(inter).push({
        codigo: String(s.codigo || id),
        identificador: id,
        descripcion: s.descripcion || id,
        callePrincipal: calle,
        calleInterseccion: inter,
        latitud: s.latitudParada || null,
        longitud: s.longitudParada || null,
        lineas: ''
      });
    }
  }
  const calles = [...streetMap.keys()].sort((a, b) => a.localeCompare(b));
  return { calles, streetMap };
}

async function getArchivedHorarios(stopId, codLinea, tipoDia) {
  const file = await loadArchiveLine(codLinea);
  const list = file?.paradas?.[stopId]?.[tipoDia];
  if (!Array.isArray(list) || list.length === 0) return null;
  const banderas = Array.isArray(file.banderas) ? file.banderas : [];

  const horarios = list
    .map((s) => {
      const [time, idx = '0'] = String(s).split('|');
      const hora = time.slice(0, 5);
      const [hh = '0', mm = '0'] = hora.split(':');
      return {
        codigoLinea: Number(codLinea),
        identificadorParada: stopId,
        bandera: banderas[Number(idx)] || '',
        horaPaso: time,
        hora,
        minuteOfDay: parseInt(hh, 10) * 60 + parseInt(mm, 10)
      };
    })
    .sort((a, b) => a.minuteOfDay - b.minuteOfDay);

  const diffs = [];
  for (let i = 1; i < horarios.length; i++) {
    const d = horarios[i].minuteOfDay - horarios[i - 1].minuteOfDay;
    if (d >= 2 && d <= 90) diffs.push(d);
  }
  diffs.sort((a, b) => a - b);

  return {
    idParada: stopId,
    codigoLinea: Number(codLinea),
    tipoDia,
    available: true,
    partial: false,
    horarios,
    frecuenciaMin: diffs.length ? diffs[Math.floor(diffs.length / 2)] : null
  };
}

// Deduplicate POST /api/fleet-seen writes per session
const reportedTripSigs = new Map(); // `${dayKey}:${codLinea}:${tripKey}` -> { sig, ts }

export function getArgentinaNow() {
  return new Date(Date.now() - 3 * 3600 * 1000);
}

export function getArgentinaTodayTipo() {
  const dow = getArgentinaNow().getUTCDay();
  return dow === 0 ? 'domingo' : dow === 6 ? 'sabado' : 'habil';
}

export const api = {
  catalogo: () => loadCatalogo(),
  horariosLineArchive: (codLinea) => loadArchiveLine(codLinea),

  bootstrap: () =>
    apiGet('/api/bootstrap', async () => {
      const base = staticBootstrap();
      const cat = await loadCatalogo();
      if (cat?.lineas?.length) {
        return { ...base, lineas: cat.lineas, source: 'archivo' };
      }
      return base;
    }),

  lineas: () =>
    apiGet('/api/lineas', async () => {
      const cat = await loadCatalogo();
      return { data: cat?.lineas?.length ? cat.lineas : staticBootstrap().lineas, source: 'archivo' };
    }),

  calles: (codLinea) =>
    apiGet(`/api/calles?codLinea=${encodeURIComponent(codLinea)}`, async () => {
      const idx = await buildOfflineDrillIndex(codLinea);
      if (idx && idx.calles.length > 0) {
        return {
          data: idx.calles.map((desc, i) => ({ codigo: i + 1, descripcion: desc })),
          source: 'archivo'
        };
      }
      return staticCalles();
    }),

  intersecciones: (codLinea, codCalle) =>
    apiGet(
      `/api/intersecciones?codLinea=${encodeURIComponent(codLinea)}&codCalle=${encodeURIComponent(codCalle)}`,
      async () => {
        const idx = await buildOfflineDrillIndex(codLinea);
        const calleName = idx?.calles?.[Number(codCalle) - 1];
        if (calleName && idx.streetMap.has(calleName)) {
          const inters = [...idx.streetMap.get(calleName).keys()].sort((a, b) => a.localeCompare(b));
          return {
            data: inters.map((desc, i) => ({ codigo: i + 1, descripcion: desc })),
            source: 'archivo'
          };
        }
        return staticIntersecciones(codCalle);
      }
    ),

  paradas: (codLinea, codCalle, codInterseccion) =>
    apiGet(
      `/api/paradas?codLinea=${encodeURIComponent(codLinea)}&codCalle=${encodeURIComponent(codCalle)}&codInterseccion=${encodeURIComponent(codInterseccion)}`,
      async () => {
        const idx = await buildOfflineDrillIndex(codLinea);
        const calleName = idx?.calles?.[Number(codCalle) - 1];
        if (calleName && idx.streetMap.has(calleName)) {
          const interMap = idx.streetMap.get(calleName);
          const inters = [...interMap.keys()].sort((a, b) => a.localeCompare(b));
          const interName = inters[Number(codInterseccion) - 1];
          if (interName && interMap.has(interName)) {
            return { data: interMap.get(interName), source: 'archivo' };
          }
        }
        return staticParadas(codCalle, codInterseccion);
      }
    ),

  paradasCercanas: (lat, lng) =>
    apiGet(`/api/paradas-cercanas?lat=${encodeURIComponent(lat)}&lng=${encodeURIComponent(lng)}`, async () => {
      const cat = await loadCatalogo();
      if (cat?.paradas?.length) {
        const nLat = Number(lat);
        const nLng = Number(lng);
        const ranked = cat.paradas
          .filter((p) => typeof p.lat === 'number' && typeof p.lng === 'number')
          .map((p) => ({ p, d: distanceMeters(nLat, nLng, p.lat, p.lng) ?? Infinity }))
          .sort((a, b) => a.d - b.d)
          .slice(0, 20)
          .map(({ p }) => {
            const { calle, inter } = splitStopStreet(p.nombre);
            const lineNames = (p.lineas || [])
              .map((c) => cat.lineByCode.get(Number(c))?.descripcion)
              .filter(Boolean)
              .join(', ');
            return {
              codigo: p.id,
              identificador: p.id,
              descripcion: p.nombre,
              callePrincipal: calle,
              calleInterseccion: inter,
              latitud: String(p.lat),
              longitud: String(p.lng),
              lineas: lineNames
            };
          });
        return { data: ranked, source: 'archivo' };
      }
      return staticParadasCercanas();
    }),

  recorridos: async (codLinea) => {
    // 1) Permanent archived polylines + stops (blazing fast & 100% offline!)
    const archived = await loadArchiveRecorrido(codLinea);
    if (archived) return { data: archived, source: 'archivo', archived: true };

    // 2) LocalStorage 24h fallback
    const cacheKey = `dgps_rec_v1_${codLinea}`;
    const cached = getLocalCache(cacheKey, 24 * 60 * 60 * 1000);
    if (cached) return { data: cached, source: 'local-cache', cached: true };

    // 3) Live API
    const res = await apiGet(`/api/recorridos?codLinea=${encodeURIComponent(codLinea)}`, () =>
      staticRecorridos(codLinea)
    );
    if (Array.isArray(res?.data) && res.data.length > 0 && res.source !== 'simulation') {
      setLocalCache(cacheKey, res.data);
    }
    return res;
  },

  banderas: (idParada) =>
    apiGet(`/api/banderas?idParada=${encodeURIComponent(idParada)}`, async () => {
      const cat = await loadCatalogo();
      const st = cat?.stopById?.get(String(idParada || '').trim().toUpperCase());
      if (st?.lineas?.length) {
        return {
          data: st.lineas
            .map((c) => {
              const l = cat.lineByCode.get(Number(c));
              return l ? { CodigoLinea: l.codigo, DescripcionLinea: l.descripcion } : null;
            })
            .filter(Boolean),
          source: 'archivo'
        };
      }
      return { data: [], source: 'fallback' };
    }),

  horarios: async (idParada, codLinea, tipoDia = 'auto') => {
    const cleanStop = String(idParada).toUpperCase();
    const resolvedTipo = tipoDia === 'auto' ? getArgentinaTodayTipo() : tipoDia;
    const cacheKey = `dgps_hor_v2_${cleanStop}_${codLinea}_${resolvedTipo}`;

    // 1) Permanent shared archive (scanned nightly by GitHub Actions, survives any cache clearing).
    const archived = await getArchivedHorarios(cleanStop, codLinea, resolvedTipo);
    if (archived) return { data: archived, source: 'archivo', archived: true };

    // 2) Persistent 14-day cache per day-type (habil / sabado / domingo)
    const cached = getLocalCache(cacheKey, 14 * 24 * 60 * 60 * 1000);
    if (cached && cached.available && !cached.partial && cached.horarios?.length > 0) {
      return { data: cached, source: 'local-cache', cached: true };
    }

    // 3) Live SmartMovePro (or offline fallback if no connection)
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
    apiGet(`/api/arribos-linea?idParada=${encodeURIComponent(idParada)}&codLinea=${encodeURIComponent(codLinea)}`, null, 11000),

  // ── Central System FleetMemory (Cloudflare Durable Object SQLite + offline read mirror) ──
  getFleetMemory: async (lineCodes = [], stopId = '') => {
    const cleanStop = String(stopId || '').trim().toUpperCase();
    const params = new URLSearchParams();
    if (Array.isArray(lineCodes) && lineCodes.length > 0) params.set('lineas', lineCodes.join(','));
    if (cleanStop) params.set('idParada', cleanStop);
    const qs = params.toString() ? `?${params.toString()}` : '';
    try {
      const res = await apiGet(`/api/fleet-memory${qs}`, null, 5500);
      if (res?.data) {
        // Merge into read-only offline mirror so airplane mode retains latest system assignments & stop arrivals
        readFleetMirror().then((existing) => {
          const mergedTrips = new Map();
          const mergedUnits = new Map();
          const mergedStops = { ...(existing?.stops || {}) };
          for (const t of existing?.trips || []) {
            mergedTrips.set(`${t.codigoLinea}:${t.tripKey}`, t);
          }
          for (const t of res.data.trips || []) {
            mergedTrips.set(`${t.codigoLinea}:${t.tripKey}`, t);
          }
          for (const u of existing?.units || []) {
            mergedUnits.set(`${u.codigoLinea}:${u.coche}`, u);
          }
          for (const u of res.data.units || []) {
            mergedUnits.set(`${u.codigoLinea}:${u.coche}`, u);
          }
          if (res.data.stopSnapshot?.idParada) {
            mergedStops[res.data.stopSnapshot.idParada] = res.data.stopSnapshot;
          }
          saveFleetMirror({
            dayKey: res.data.dayKey,
            trips: [...mergedTrips.values()],
            units: [...mergedUnits.values()],
            stops: mergedStops,
            syncedAt: Date.now()
          });
        });
        return res.data;
      }
    } catch {
      // Offline: return last synced snapshot from central system mirror
    }
    const mirrored = await readFleetMirror();
    if (!mirrored) return { dayKey: '', stopSnapshot: null, trips: [], units: [] };
    return {
      ...mirrored,
      stopSnapshot: cleanStop && mirrored.stops ? mirrored.stops[cleanStop] || null : null
    };
  },

  reportFleetSeen: async (entries = [], dayKey = '') => {
    if (isBrowserOffline() || !Array.isArray(entries) || entries.length === 0) return;
    const nowMs = Date.now();
    const toSend = [];

    for (const e of entries) {
      if (!e.codigoLinea || !e.tripKey || !e.coche) continue;
      const key = `${dayKey}:${e.codigoLinea}:${e.tripKey}`;
      // Round desvio to 30s bucket to avoid noisy writes on every 10s poll
      const desvioBucket = Math.round((e.desvioSec || 0) / 30);
      const sig = `${e.coche}|${e.choferNombre || ''}|${e.choferLegajo || ''}|${desvioBucket}`;
      const prev = reportedTripSigs.get(key);
      if (prev && prev.sig === sig && nowMs - prev.ts < 240000) continue;
      reportedTripSigs.set(key, { sig, ts: nowMs });
      toSend.push(e);
    }

    if (toSend.length === 0) return;

    try {
      await fetchWithTimeout(
        `${API_BASE}/api/fleet-seen`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dayKey, entries: toSend })
        },
        6000
      );
    } catch {
      // Ignore network errors while offline; next online poll will report
    }
  }
};

/**
 * Politely warms the Service Worker cache with all 33 Corrientes routes + 24h schedules
 * in the background while online (~500 KB gzipped total once), so ANY line & stop works
 * seamlessly even if the user later turns on airplane mode without having visited it first.
 */
let warmStarted = false;
export async function warmOfflineArchive() {
  if (warmStarted || isBrowserOffline()) return;
  if (typeof navigator !== 'undefined' && navigator.connection?.saveData) return;
  warmStarted = true;

  try {
    const cat = await loadCatalogo();
    if (!cat?.lineas?.length) return;

    const urls = [];
    for (const l of cat.lineas) {
      urls.push(new URL(`../data/recorridos/${l.codigo}.json`, import.meta.url).toString());
      urls.push(new URL(`../data/horarios/${l.codigo}.json`, import.meta.url).toString());
    }

    const hasCacheApi = typeof caches !== 'undefined';
    let idx = 0;
    const worker = async () => {
      while (idx < urls.length) {
        if (isBrowserOffline()) return;
        const u = urls[idx++];
        try {
          if (hasCacheApi) {
            const hit = await caches.match(u);
            if (hit) continue;
          }
          await fetch(u, { priority: 'low' }).catch(() => {});
        } catch {
          // ignore
        }
      }
    };
    await Promise.all([worker(), worker()]);
  } catch {
    // Non-fatal
  }
}

export function parseDesvioHorario(raw = '') {
  const clean = String(raw || '').trim();
  if (!clean) {
    return { raw: '', status: 'none', label: '', shortLabel: '', sign: '', minutes: 0, seconds: 0 };
  }
  const normalized = clean.replace(/\s+/g, '');
  if (normalized === '00:00' || normalized === '+00:00' || normalized === '-00:00' || normalized === '0') {
    return { raw: clean, status: 'ok', label: '00:00', shortLabel: '00:00', sign: '=', minutes: 0, seconds: 0 };
  }

  const m = normalized.match(/^([+-])(\d{1,2}):(\d{2})$/);
  if (!m) {
    return { raw: clean, status: 'ok', label: normalized, shortLabel: normalized, sign: '', minutes: 0, seconds: 0 };
  }

  const sign = m[1];
  const mins = parseInt(m[2], 10);
  const secs = parseInt(m[3], 10);
  const signedSec = (sign === '+' ? 1 : -1) * (mins * 60 + secs);
  const signedMin = signedSec / 60;

  // Thresholds:
  // -03:00 .. +03:00 (|sec| <= 180) -> 'ok' (green)
  // +03:01 or more  (sec > 180)     -> 'ahead' (blue)
  // -03:01 or more  (sec < -180)    -> 'late' (red)
  let status = 'ok';
  if (signedSec > 180) status = 'ahead';
  else if (signedSec < -180) status = 'late';

  return {
    raw: clean,
    status,
    label: normalized,
    shortLabel: normalized,
    sign,
    minutes: signedMin,
    seconds: signedSec
  };
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

  const ordered = [...buses].sort((a, b) => (a.eta?.minutes ?? 999) - (b.eta?.minutes ?? 999));

  for (const bus of ordered) {
    // Prefer canonical turnoProgramado already matched by the space-time predictor (including Sig. vuelta & extreme early/late)
    if (bus.turnoProgramado) {
      const exactSlot = horarios.find((s) => s.hora === bus.turnoProgramado && !usedSlots.has(s.hora));
      if (exactSlot) {
        usedSlots.add(exactSlot.hora);
        slotToBus.set(exactSlot.hora, bus);
        continue;
      }
    }

    if (!bus.eta || bus.eta.valid === false || typeof bus.eta.minutes !== 'number' || bus.eta.minutes > 240) {
      if (!bus.turnoProgramado) bus.turnoProgramado = null;
      continue;
    }
    const desvioMin = bus.desvio?.minutes || 0;
    const expectedSchedMin = (nowMin + bus.eta.minutes + desvioMin) % 1440;

    let bestSlot = null;
    let bestDiff = bus.esExtendido ? 14 : 10;
    for (const slot of horarios) {
      if (usedSlots.has(slot.hora)) continue;
      let diff = Math.abs(slot.minuteOfDay - expectedSchedMin);
      if (diff > 720) diff = 1440 - diff;
      if (diff < bestDiff) {
        bestDiff = diff;
        bestSlot = slot;
      }
    }

    if (bestSlot) {
      usedSlots.add(bestSlot.hora);
      bus.turnoProgramado = bestSlot.hora;
      slotToBus.set(bestSlot.hora, bus);
    } else if (!bus.turnoProgramado) {
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
  if (!lower) return { minutes: 999, valid: false, display: '—', unit: '', urgency: 'later' };
  if (lower.includes('llegando') || lower.includes('arribando') || lower === '0' || lower.startsWith('0 ')) {
    return { minutes: 0, valid: true, display: 'YA', unit: 'Arribando', urgency: 'now' };
  }
  const m = lower.match(/(\d+)/);
  if (m) {
    const mins = parseInt(m[1], 10);
    const urgency = mins <= 3 ? 'now' : mins <= 9 ? 'soon' : 'later';
    return { minutes: mins, valid: true, display: `${mins}`, unit: 'min', urgency };
  }
  return { minutes: 999, valid: false, display: rawText, unit: '', urgency: 'later' };
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
