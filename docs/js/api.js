import {
  DEFAULT_API_BASE,
  REMOVED_LINE_CODES,
  normalizePublicLineName,
  resolveDriverDisplayInfo
} from './config.js';
import {
  staticBootstrap,
  staticCalles,
  staticIntersecciones,
  staticParadas,
  staticParadasCercanas,
  staticRecorridos
} from './static-data.js';

function sanitizeDriverFields(item) {
  if (!item || typeof item !== 'object') return item;
  if (
    item.choferNombre !== undefined ||
    item.choferLegajo !== undefined ||
    item.identificadorChofer !== undefined
  ) {
    const resolved = resolveDriverDisplayInfo(
      item.choferLegajo,
      item.choferNombre,
      item.identificadorChofer || item.choferRaw || ''
    );
    if (item.choferNombre !== undefined || resolved.nombre) {
      item.choferNombre = resolved.nombre;
    }
    if (resolved.legajo && !item.choferLegajo) {
      item.choferLegajo = resolved.legajo;
    }
  }
  if (item.lastChoferNombre !== undefined || item.lastChoferLegajo !== undefined) {
    const resolved = resolveDriverDisplayInfo(item.lastChoferLegajo, item.lastChoferNombre);
    if (item.lastChoferNombre !== undefined || resolved.nombre) {
      item.lastChoferNombre = resolved.nombre;
    }
    if (resolved.legajo && !item.lastChoferLegajo) {
      item.lastChoferLegajo = resolved.legajo;
    }
  }
  return item;
}

function sanitizeLineItem(item) {
  if (!item || typeof item !== 'object') return item;
  sanitizeDriverFields(item);
  const cod = Number(item.codigoLinea ?? item.codigo);
  if (!cod) return item;
  if (item.descripcionLinea !== undefined) {
    item.descripcionLinea = normalizePublicLineName(cod, item.descripcionLinea);
  }
  if (item.descripcion !== undefined && item.codigo !== undefined) {
    item.descripcion = normalizePublicLineName(cod, item.descripcion);
  }
  return item;
}

function sanitizeLineArray(arr) {
  if (!Array.isArray(arr)) return arr;
  return arr
    .filter((item) => {
      const cod = Number(item?.codigoLinea ?? item?.codigo);
      return !cod || !REMOVED_LINE_CODES.has(cod);
    })
    .map(sanitizeLineItem);
}

function sanitizeDriverArray(arr) {
  if (!Array.isArray(arr)) return arr;
  for (const item of arr) sanitizeDriverFields(item);
  return arr;
}

function sanitizeApiPayload(json) {
  if (!json || typeof json !== 'object') return json;
  const targets = [json, json.data].filter((o) => o && typeof o === 'object');
  for (const obj of targets) {
    if (Array.isArray(obj.lineas)) {
      obj.lineas = sanitizeLineArray(obj.lineas).sort((a, b) =>
        String(a.descripcion || a.descripcionLinea || '').localeCompare(
          String(b.descripcion || b.descripcionLinea || ''),
          'es',
          { numeric: true }
        )
      );
    }
    if (Array.isArray(obj.arribos)) obj.arribos = sanitizeLineArray(obj.arribos);
    if (Array.isArray(obj.corridorFleet)) obj.corridorFleet = sanitizeLineArray(obj.corridorFleet);
    if (Array.isArray(obj.units)) obj.units = sanitizeLineArray(obj.units);
    if (Array.isArray(obj.activeUnits)) obj.activeUnits = sanitizeLineArray(obj.activeUnits);
    if (Array.isArray(obj.trips)) obj.trips = sanitizeLineArray(obj.trips);
    if (Array.isArray(obj.todayTrips)) obj.todayTrips = sanitizeDriverArray(obj.todayTrips);
    if (Array.isArray(obj.dayTrips)) obj.dayTrips = sanitizeDriverArray(obj.dayTrips);
    if (Array.isArray(obj.dayObs)) obj.dayObs = sanitizeDriverArray(obj.dayObs);
    if (Array.isArray(obj.coches)) obj.coches = sanitizeDriverArray(obj.coches);
    if (Array.isArray(obj.choferes)) obj.choferes = sanitizeDriverArray(obj.choferes);
    if (Array.isArray(obj.results)) obj.results = sanitizeLineArray(obj.results);
    if (obj.stopSnapshot && Array.isArray(obj.stopSnapshot.arribos)) {
      obj.stopSnapshot.arribos = sanitizeLineArray(obj.stopSnapshot.arribos);
    }
    if (obj.lines && typeof obj.lines === 'object' && !Array.isArray(obj.lines)) {
      for (const lineObj of Object.values(obj.lines)) {
        if (!lineObj || typeof lineObj !== 'object') continue;
        if (Array.isArray(lineObj.coches)) sanitizeDriverArray(lineObj.coches);
        if (Array.isArray(lineObj.choferes)) sanitizeDriverArray(lineObj.choferes);
        if (lineObj.dayTripsByDay && typeof lineObj.dayTripsByDay === 'object') {
          for (const arr of Object.values(lineObj.dayTripsByDay)) sanitizeDriverArray(arr);
        }
        if (lineObj.dayObsByDay && typeof lineObj.dayObsByDay === 'object') {
          for (const arr of Object.values(lineObj.dayObsByDay)) sanitizeDriverArray(arr);
        }
      }
    }
    if (obj.codigoLinea && obj.descripcionLinea !== undefined) {
      obj.descripcionLinea = normalizePublicLineName(obj.codigoLinea, obj.descripcionLinea);
    }
  }
  return json;
}

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

  const isCapNative = Boolean(typeof window !== 'undefined' && window.Capacitor?.isNativePlatform?.());
  const host = window.location.hostname;
  if (!isCapNative && (host === 'localhost' || host === '127.0.0.1')) {
    return '';
  }
  return (DEFAULT_API_BASE || '').replace(/\/+$/, '');
}

const API_BASE = resolveApiBase();

export function getApiBase() {
  return API_BASE || (DEFAULT_API_BASE || '').replace(/\/+$/, '');
}

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
      { headers: { Accept: 'application/json' }, cache: 'no-store' },
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
    return sanitizeApiPayload(json);
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

let mirrorDbPromise = null;

function openMirrorDb() {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  if (mirrorDbPromise) return mirrorDbPromise;
  mirrorDbPromise = new Promise((resolve) => {
    try {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(IDB_STORE)) {
          req.result.createObjectStore(IDB_STORE);
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => {
          db.close();
          mirrorDbPromise = null;
        };
        db.onclose = () => {
          mirrorDbPromise = null;
        };
        resolve(db);
      };
      req.onerror = () => {
        mirrorDbPromise = null;
        resolve(null);
      };
    } catch {
      mirrorDbPromise = null;
      resolve(null);
    }
  });
  return mirrorDbPromise;
}

async function saveIdbValue(key, value) {
  const db = await openMirrorDb();
  if (!db) return;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

async function readIdbValue(key) {
  const db = await openMirrorDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function saveFleetMirror(snapshot) {
  return saveIdbValue('fleet_memory', snapshot);
}

async function readFleetMirror() {
  return readIdbValue('fleet_memory');
}

// ── Permanent static archives (docs/data/catalogo.json, recorridos/, horarios/) + OTA sync ──
const REMOTE_DATA_BASE = 'https://titomassa.github.io/DIRECT-GPS/data';
let catalogoPromise = null;
const archiveHorariosByLine = new Map(); // codLinea -> Promise<file|null>
const archiveRecorridosByLine = new Map(); // codLinea -> Promise<branches|null>
let localHorariosUpdatedAt = '';
let remoteHorariosUpdatedAt = '';
let otaIndexChecked = false;
let otaSyncPromise = null;

async function ensureOtaHorariosIndex() {
  if (otaIndexChecked) return remoteHorariosUpdatedAt;
  if (!otaSyncPromise) {
    otaSyncPromise = (async () => {
      try {
        const localUrl = new URL('../data/horarios/index.json', import.meta.url);
        const localIdx = await fetch(localUrl, { cache: 'no-cache' })
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null);
        localHorariosUpdatedAt = String(localIdx?.updatedAt || '');

        const savedMeta = await readIdbValue('ota_horarios_meta');
        if (savedMeta?.updatedAt && savedMeta.updatedAt > localHorariosUpdatedAt) {
          remoteHorariosUpdatedAt = String(savedMeta.updatedAt);
        }

        if (!isBrowserOffline()) {
          const remoteIdx = await fetchWithTimeout(
            `${REMOTE_DATA_BASE}/horarios/index.json`,
            { cache: 'no-store' },
            5000
          )
            .then((r) => (r.ok ? r.json() : null))
            .catch(() => null);
          const remAt = String(remoteIdx?.updatedAt || '');
          if (remAt && remAt > localHorariosUpdatedAt && remAt >= remoteHorariosUpdatedAt) {
            const changed = remAt !== remoteHorariosUpdatedAt;
            remoteHorariosUpdatedAt = remAt;
            await saveIdbValue('ota_horarios_meta', { updatedAt: remAt, syncedAt: Date.now() });
            if (changed) archiveHorariosByLine.clear();
          }
        }
      } catch {
        // Non-fatal: bundled archive remains available offline
      } finally {
        otaIndexChecked = true;
      }
      return remoteHorariosUpdatedAt;
    })();
  }
  return otaSyncPromise;
}

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
        const lineas = sanitizeLineArray(cat.lineas || []).sort((a, b) =>
          String(a.descripcion || '').localeCompare(String(b.descripcion || ''), 'es', { numeric: true })
        );
        const paradas = (cat.paradas || [])
          .map((p) => ({
            ...p,
            lineas: (p.lineas || []).filter((c) => !REMOVED_LINE_CODES.has(Number(c)))
          }))
          .filter((p) => p.lineas.length > 0);
        const stopById = new Map();
        const lineByCode = new Map();
        for (const l of lineas) lineByCode.set(Number(l.codigo), l);
        for (const p of paradas) stopById.set(String(p.id).toUpperCase(), p);
        return { ...cat, lineas, paradas, stopById, lineByCode };
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
    const p = (async () => {
      // Trigger non-blocking OTA index check once per session
      await ensureOtaHorariosIndex();

      // 1) If GitHub Pages has a newer archive than the bundled APK/cache, use/fetch OTA copy
      if (remoteHorariosUpdatedAt && remoteHorariosUpdatedAt > localHorariosUpdatedAt) {
        const otaKey = `ota_horarios:${key}`;
        const cachedOta = await readIdbValue(otaKey);
        if (cachedOta?.updatedAt === remoteHorariosUpdatedAt && cachedOta?.file) {
          return cachedOta.file;
        }
        if (!isBrowserOffline()) {
          const remoteFile = await fetchWithTimeout(
            `${REMOTE_DATA_BASE}/horarios/${key}.json`,
            { cache: 'no-store' },
            6500
          )
            .then((r) => (r.ok ? r.json() : null))
            .catch(() => null);
          if (remoteFile?.paradas) {
            saveIdbValue(otaKey, { updatedAt: remoteHorariosUpdatedAt, file: remoteFile });
            return remoteFile;
          }
        }
        if (cachedOta?.file) return cachedOta.file;
      }

      // 2) Bundled local static archive (cache-busted by index updatedAt so updates apply on first load)
      const verSuffix = localHorariosUpdatedAt ? `?v=${encodeURIComponent(localHorariosUpdatedAt)}` : '';
      const url = new URL(`../data/horarios/${key}.json${verSuffix}`, import.meta.url);
      const file = await fetch(url, { cache: 'no-cache' })
        .then((res) => (res.ok ? res.json() : null))
        .catch(() => null);
      if (!file) archiveHorariosByLine.delete(key);
      return file;
    })();
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

function formatArchivedHorariosFromFile(file, stopId, codLinea, tipoDia) {
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

async function getArchivedHorarios(stopId, codLinea, tipoDia) {
  const file = await loadArchiveLine(codLinea);
  return formatArchivedHorariosFromFile(file, stopId, codLinea, tipoDia);
}

// Non-destructive client cache of Worker's accumulated live SOAP schedules (never drops passed times)
const liveHorariosState = {
  days: {},
  availableDays: [],
  meta: null,
  savedAt: 0
};

function mergeLiveHorariosPayload(payload, savedAt = Date.now()) {
  if (!payload || typeof payload !== 'object') return liveHorariosState;
  const incomingDays = payload.days && typeof payload.days === 'object' ? payload.days : {};
  for (const [dk, dayObj] of Object.entries(incomingDays)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dk) || !dayObj || typeof dayObj !== 'object') continue;
    const prevDay = liveHorariosState.days[dk] || { updatedAt: 0, lineas: {} };
    const nextLineas = { ...prevDay.lineas };
    for (const [cod, lObj] of Object.entries(dayObj.lineas || {})) {
      const prevLine = nextLineas[cod] || { stops: {}, windowsScanned: 0, windowHours: [], lastScanAt: 0 };
      const nextStops = { ...prevLine.stops };
      for (const [sid, list] of Object.entries(lObj?.stops || {})) {
        const union = new Set(Array.isArray(nextStops[sid]) ? nextStops[sid] : []);
        for (const it of Array.isArray(list) ? list : []) union.add(it);
        nextStops[sid] = Array.from(union).sort();
      }
      const winSet = new Set([
        ...(Array.isArray(prevLine.windowHours) ? prevLine.windowHours : []),
        ...(Array.isArray(lObj?.windowHours) ? lObj.windowHours : [])
      ]);
      nextLineas[cod] = {
        stops: nextStops,
        windowsScanned: Math.max(Number(prevLine.windowsScanned) || 0, Number(lObj?.windowsScanned) || 0),
        windowHours: Array.from(winSet).sort((a, b) => a - b),
        lastScanAt: Math.max(Number(prevLine.lastScanAt) || 0, Number(lObj?.lastScanAt) || 0)
      };
    }
    liveHorariosState.days[dk] = {
      updatedAt: Math.max(Number(prevDay.updatedAt) || 0, Number(dayObj.updatedAt) || 0),
      lineas: nextLineas
    };
  }
  const availSet = new Set([
    ...Object.keys(liveHorariosState.days),
    ...(Array.isArray(payload.availableDays) ? payload.availableDays : [])
  ]);
  liveHorariosState.availableDays = Array.from(availSet).sort().reverse().slice(0, 14);
  if (payload.meta) liveHorariosState.meta = payload.meta;
  liveHorariosState.savedAt = Math.max(liveHorariosState.savedAt, Number(savedAt) || Date.now());
  return liveHorariosState;
}

// Deduplicate POST /api/fleet-seen writes per session
const reportedTripSigs = new Map(); // `${dayKey}:${codLinea}:${tripKey}` -> { sig, ts }

export function getArgentinaNow() {
  return new Date(Date.now() - 3 * 3600 * 1000);
}

export function getArgentinaTodayTipo() {
  // Service day cuts over at 03:00 AM ART so 00:00-02:59 stays in the prior service day
  const serviceArt = new Date(Date.now() - 6 * 3600 * 1000);
  const dow = serviceArt.getUTCDay();
  return dow === 0 ? 'domingo' : dow === 6 ? 'sabado' : 'habil';
}

export const api = {
  health: () => apiGet('/api/health', null, 5000),
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

  horariosLive: async ({ dayKey = '', all = true } = {}) => {
    const params = [];
    if (dayKey) params.push(`dayKey=${encodeURIComponent(dayKey)}`);
    else if (all) params.push('days=all');
    const qs = params.length ? `?${params.join('&')}` : '';

    // Always hydrate from IDB first so previously accumulated passed times are preserved
    if (liveHorariosState.savedAt === 0) {
      const cached = await readIdbValue('live_horarios_all');
      if (cached?.data) mergeLiveHorariosPayload(cached.data, cached.savedAt || Date.now());
    }

    if (!isBrowserOffline()) {
      try {
        const res = await apiGet(`/api/horarios-live${qs}`, null, 8000);
        if (res?.data) {
          const savedAt = Number(res.savedAt) || Date.now();
          mergeLiveHorariosPayload(res.data, savedAt);
          await saveIdbValue('live_horarios_all', {
            savedAt: liveHorariosState.savedAt,
            data: {
              days: liveHorariosState.days,
              availableDays: liveHorariosState.availableDays,
              meta: liveHorariosState.meta
            }
          });
          return { data: liveHorariosState, source: res.source || 'live-horarios', savedAt };
        }
      } catch {
        // Fall back to accumulated IDB/in-memory cache
      }
    }
    return {
      data: liveHorariosState,
      source: 'live-horarios-cache',
      savedAt: liveHorariosState.savedAt,
      isOfflineCache: true
    };
  },

  getLiveHorariosCached: async () => {
    if (liveHorariosState.savedAt === 0) {
      const cached = await readIdbValue('live_horarios_all');
      if (cached?.data) mergeLiveHorariosPayload(cached.data, cached.savedAt || Date.now());
    }
    return liveHorariosState;
  },

  horarios: async (idParada, codLinea, tipoDia = 'auto', { resolvedFile = null, resolvedTipoOverride = null } = {}) => {
    const cleanStop = String(idParada).toUpperCase();
    const resolvedTipo = resolvedTipoOverride || (tipoDia === 'auto' ? getArgentinaTodayTipo() : tipoDia);
    const cacheKey = `dgps_hor_v2_${cleanStop}_${codLinea}_${resolvedTipo}`;

    // 0) If caller resolved a live-SOAP timetable file (e.g. holiday or custom schedule), use it first
    if (resolvedFile) {
      const fromLive = formatArchivedHorariosFromFile(resolvedFile, cleanStop, codLinea, resolvedTipo);
      if (fromLive) return { data: fromLive, source: 'live-soap-resolved', archived: true };
    }

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

  arribos: (idParada, codLinea = '000', { hintLinea = null, skipCorridor = false } = {}) => {
    const code = !codLinea || codLinea === '0' ? '000' : String(codLinea);
    const extra = [];
    if (hintLinea) extra.push(`hintLinea=${encodeURIComponent(hintLinea)}`);
    if (skipCorridor) extra.push('skipCorridor=1');
    const tail = extra.length ? `&${extra.join('&')}` : '';
    return apiGet(`/api/arribos?idParada=${encodeURIComponent(idParada)}&codLinea=${encodeURIComponent(code)}${tail}`);
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
          const sameDay = existing?.dayKey === res.data.dayKey;
          const mergedTrips = new Map();
          const mergedUnits = new Map();
          const rawStops = sameDay ? { ...(existing?.stops || {}) } : {};
          if (sameDay) {
            for (const t of existing?.trips || []) {
              if (!t.dayKey || t.dayKey === res.data.dayKey) {
                mergedTrips.set(`${t.codigoLinea}:${t.tripKey}`, t);
              }
            }
            for (const u of existing?.units || []) {
              if (!u.dayKey || u.dayKey === res.data.dayKey) {
                mergedUnits.set(`${u.codigoLinea}:${u.coche}`, u);
              }
            }
          }
          for (const t of res.data.trips || []) {
            mergedTrips.set(`${t.codigoLinea}:${t.tripKey}`, t);
          }
          for (const u of res.data.units || []) {
            mergedUnits.set(`${u.codigoLinea}:${u.coche}`, u);
          }
          if (res.data.stopSnapshot?.idParada) {
            rawStops[res.data.stopSnapshot.idParada] = {
              ...res.data.stopSnapshot,
              _savedAt: Date.now()
            };
          }
          const stopEntries = Object.entries(rawStops);
          const mergedStops =
            stopEntries.length > 60
              ? Object.fromEntries(
                  stopEntries
                    .sort((a, b) => (Number(b[1]?._savedAt || b[1]?.ts) || 0) - (Number(a[1]?._savedAt || a[1]?.ts) || 0))
                    .slice(0, 60)
                )
              : rawStops;
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
    return sanitizeApiPayload({
      ...mirrored,
      stopSnapshot: cleanStop && mirrored.stops ? mirrored.stops[cleanStop] || null : null
    });
  },

  reportFleetSeen: async (entries = [], dayKey = '') => {
    if (isBrowserOffline() || !Array.isArray(entries) || entries.length === 0) return;
    const nowMs = Date.now();
    if (dayKey && reportedTripSigs.size > 0) {
      const dayPrefix = `${dayKey}:`;
      for (const k of reportedTripSigs.keys()) {
        if (!k.startsWith(dayPrefix)) reportedTripSigs.delete(k);
      }
    }
    const toSend = [];

    for (const e of entries) {
      if (!e.codigoLinea || !e.tripKey || !e.coche) continue;
      const key = `${dayKey}:${e.codigoLinea}:${e.tripKey}`;
      // Round desvio to 30s bucket to avoid noisy writes on every 10s poll
      const desvioBucket = Math.round((e.desvioSec || 0) / 30);
      const trailLen = Array.isArray(e.gpsTrail) ? e.gpsTrail.length : 0;
      const sig = `${e.coche}|${e.choferNombre || ''}|${e.choferLegajo || ''}|${desvioBucket}|${e.dirBandera || ''}|${trailLen >= 2 ? 1 : 0}`;
      const prev = reportedTripSigs.get(key);
      // Always transmit immediately when an assignment was auto-corrected (supersededTripKey)
      if (!e.supersededTripKey && prev && prev.sig === sig && nowMs - prev.ts < 180000) continue;
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
  },

  // ── Central System Fleet & Drivers Roster (server-side Durable Object SQLite + live 10s SOAP + full IndexedDB offline cache) ──
  offlineBundle: async () => {
    const res = await apiGet('/api/offline-bundle', null, 15000);
    if (res?.data) {
      const savedAt = Number(res.savedAt) || Date.now();
      await persistOfflineBundleSnapshot(res.data, savedAt);
    }
    return res;
  },

  getOfflineBundleCached: async ({ maxAgeMs = 25000, force = false } = {}) => {
    const now = Date.now();
    if (!force && lastBundleMemSnap?.data && (isBrowserOffline() || now - lastBundleMemSnap.savedAt < maxAgeMs)) {
      return {
        data: lastBundleMemSnap.data,
        savedAt: lastBundleMemSnap.savedAt,
        isOfflineCache: isBrowserOffline()
      };
    }

    let idbSnap = null;
    if (!force || isBrowserOffline()) {
      idbSnap = await readIdbValue('offline_bundle');
      const idbTs = Number(idbSnap?.savedAt) || 0;
      if (!force && idbSnap?.data && (isBrowserOffline() || now - idbTs < maxAgeMs)) {
        sanitizeApiPayload(idbSnap.data);
        lastBundleMemSnap = { savedAt: idbTs, data: idbSnap.data };
        return {
          data: idbSnap.data,
          savedAt: idbTs,
          isOfflineCache: isBrowserOffline()
        };
      }
    }

    if (!isBrowserOffline()) {
      try {
        const res = await apiGet('/api/offline-bundle', null, 15000);
        if (res?.data) {
          const savedAt = Number(res.savedAt) || Date.now();
          lastBundleMemSnap = { savedAt, data: res.data };
          if (res.data.liveHorarios && typeof res.data.liveHorarios === 'object') {
            mergeLiveHorariosPayload(res.data.liveHorarios, savedAt);
          }
          // Throttle heavy multi-store IndexedDB writes to once every 45s during 10s live polling
          if (now - lastBundleIdbPersistMs >= 45000 || !idbSnap) {
            lastBundleIdbPersistMs = now;
            persistOfflineBundleSnapshot(res.data, savedAt).catch(() => {});
          }
          return { data: res.data, savedAt, isOfflineCache: false };
        }
      } catch {
        // Fall back to memory/IDB snapshot below
      }
    }

    if (lastBundleMemSnap?.data) {
      return { data: lastBundleMemSnap.data, savedAt: lastBundleMemSnap.savedAt, isOfflineCache: true };
    }
    if (!idbSnap) idbSnap = await readIdbValue('offline_bundle');
    if (idbSnap?.data) {
      const idbTs = Number(idbSnap.savedAt) || 0;
      sanitizeApiPayload(idbSnap.data);
      lastBundleMemSnap = { savedAt: idbTs, data: idbSnap.data };
      return { data: idbSnap.data, savedAt: idbTs, isOfflineCache: true };
    }
    return { data: null, savedAt: 0, isOfflineCache: isBrowserOffline() };
  },

  flotaResumen: async ({ live = true } = {}) => {
    try {
      const res = await apiGet(`/api/flota-resumen${live ? '?live=1' : ''}`, null, 9000);
      if (res?.data && Array.isArray(res.data.lineas)) {
        saveIdbValue('flota_resumen', { savedAt: Number(res.savedAt) || Date.now(), data: res.data });
      }
      return res;
    } catch (err) {
      const cached = await readOfflineFlotaResumen();
      if (cached) return cached;
      throw err;
    }
  },

  flotaLinea: async (codLinea, dayKey = '', { live = true } = {}) => {
    const cleanCod = Number(codLinea);
    const cleanDay = String(dayKey || '').trim();
    const params = [`codLinea=${encodeURIComponent(codLinea)}`];
    if (cleanDay) params.push(`dayKey=${encodeURIComponent(cleanDay)}`);
    params.push(live && !cleanDay ? 'live=1' : 'live=0');
    try {
      const res = await apiGet(`/api/flota?${params.join('&')}`, null, 9000);
      if (res?.data && cleanCod) {
        const cacheKey = `flota_line:${cleanCod}:${cleanDay || 'today'}`;
        saveIdbValue(cacheKey, { savedAt: Number(res.savedAt) || Date.now(), data: res.data });
      }
      return res;
    } catch (err) {
      const cached = await readOfflineFlotaLinea(cleanCod, cleanDay);
      if (cached) return cached;
      throw err;
    }
  },

  flotaBuscar: async (q) => {
    try {
      return await apiGet(`/api/flota-buscar?q=${encodeURIComponent(q)}`, null, 5000);
    } catch (err) {
      const cached = await searchOfflineFlotaBundle(q);
      if (cached) return cached;
      throw err;
    }
  },

  flotaActiva: async ({ live = true } = {}) => {
    if (!isBrowserOffline()) {
      try {
        const qs = live ? '?live=1' : '?live=0';
        const res = await apiGet(`/api/flota-activa${qs}`, null, 10000);
        if (Array.isArray(res?.data?.units)) {
          saveIdbValue('flota_activa', { savedAt: Number(res.savedAt) || Date.now(), data: res.data });
          return res;
        }
      } catch {
        // Fall through to fleet-memory or offline cache
      }
      try {
        const mem = await apiGet('/api/fleet-memory', null, 7500);
        const cat = await loadCatalogo();
        const nowMs = Date.now();
        const activeCutoff = nowMs - 38 * 60 * 1000;
        const todayKey = mem?.data?.dayKey || '';
        const units = [];
        for (const u of mem?.data?.units || []) {
          const lat = Number(u.lat);
          const lng = Number(u.lng);
          if (!Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0)) continue;
          if (todayKey && u.dayKey && u.dayKey !== todayKey) continue;
          if (u.updatedAt && u.updatedAt < activeCutoff) continue;
          const lineObj = cat?.lineByCode?.get(Number(u.codigoLinea));
          units.push({
            codigoLinea: Number(u.codigoLinea),
            descripcionLinea: lineObj?.descripcion || `L${u.codigoLinea}`,
            coche: String(u.coche || '').trim(),
            choferNombre: u.choferNombre || '',
            choferLegajo: u.choferLegajo || '',
            esAdaptado: Boolean(u.esAdaptado),
            bandera: u.bandera || '',
            dirBandera: u.dirBandera || '',
            lat,
            lng,
            desvioSec: Number(u.desvioSec) || 0,
            desvioRaw: u.desvioRaw || '',
            ultimaGps: u.ultimaGps || '',
            lastStopId: u.stopId || '',
            lastTripKey: u.tripKey || '',
            lastSeenAt: u.updatedAt || nowMs,
            enLineaAhora: true
          });
        }
        const payload = {
          data: { dayKey: todayKey, activeWindowMin: 38, units },
          source: 'fleet-memory-fallback',
          savedAt: nowMs
        };
        if (units.length > 0) {
          saveIdbValue('flota_activa', { savedAt: nowMs, data: payload.data });
        }
        return payload;
      } catch {
        // Fall through to IndexedDB offline snapshot
      }
    }
    const cached = await readOfflineFlotaActiva();
    if (cached) return cached;
    const offlineErr = new Error('Sin conexión a internet');
    offlineErr.isOffline = true;
    throw offlineErr;
  }
};

// ── Full-Offline IndexedDB Snapshot Helpers (Resumen, Flota 7d, Búsqueda, Modo Libre) ──
function getArgentinaDayKeyLocal(nowMs = Date.now()) {
  const d = new Date(nowMs - 6 * 3600 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function normalizeOfflineSearchText(str = '') {
  return String(str || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();
}

let lastBundleMemSnap = null;
let lastBundleIdbPersistMs = 0;

export function getCachedOfflineBundle() {
  return lastBundleMemSnap?.data || null;
}

async function persistOfflineBundleSnapshot(bundleData, savedAt = Date.now()) {
  if (!bundleData || typeof bundleData !== 'object') return;
  lastBundleMemSnap = { savedAt, data: bundleData };
  lastBundleIdbPersistMs = Date.now();
  await saveIdbValue('offline_bundle', { savedAt, data: bundleData });

  if (bundleData.liveHorarios && typeof bundleData.liveHorarios === 'object') {
    mergeLiveHorariosPayload(bundleData.liveHorarios, savedAt);
    await saveIdbValue('live_horarios_all', {
      savedAt: liveHorariosState.savedAt,
      data: {
        days: liveHorariosState.days,
        availableDays: liveHorariosState.availableDays,
        meta: liveHorariosState.meta
      }
    });
  }

  if (bundleData.resumen && Array.isArray(bundleData.resumen.lineas)) {
    const prevResumen = await readIdbValue('flota_resumen');
    if (!prevResumen || savedAt >= (Number(prevResumen.savedAt) || 0)) {
      await saveIdbValue('flota_resumen', { savedAt, data: bundleData.resumen });
    }
  }

  if (Array.isArray(bundleData.activeUnits)) {
    const prevActiva = await readIdbValue('flota_activa');
    if (!prevActiva || savedAt >= (Number(prevActiva.savedAt) || 0)) {
      await saveIdbValue('flota_activa', {
        savedAt,
        data: {
          dayKey: bundleData.dayKey || getArgentinaDayKeyLocal(savedAt),
          activeWindowMin: bundleData.activeWindowMin || 38,
          meta: bundleData.meta || null,
          units: bundleData.activeUnits
        }
      });
    }
  }

  // Also seed fleet_memory mirror if empty so offline Stop Radar has last known trips/units immediately
  try {
    const prevMirror = await readFleetMirror();
    const dayKey = bundleData.dayKey || getArgentinaDayKeyLocal(savedAt);
    if (!prevMirror || prevMirror.dayKey !== dayKey || savedAt - (Number(prevMirror.syncedAt) || 0) > 10 * 60 * 1000) {
      const trips = [];
      const units = [];
      for (const line of Object.values(bundleData.lines || {})) {
        const cod = Number(line?.codigoLinea);
        if (!cod) continue;
        for (const t of line.dayTripsByDay?.[dayKey] || []) {
          trips.push({ ...t, dayKey, codigoLinea: cod });
        }
      }
      for (const u of bundleData.activeUnits || []) {
        units.push({
          codigoLinea: Number(u.codigoLinea),
          coche: u.coche,
          dayKey,
          tripKey: u.lastTripKey || '',
          choferNombre: u.choferNombre || '',
          choferLegajo: u.choferLegajo || '',
          esAdaptado: Boolean(u.esAdaptado),
          desvioSec: Number(u.desvioSec) || 0,
          desvioRaw: u.desvioRaw || '',
          bandera: u.bandera || '',
          dirBandera: u.dirBandera || '',
          ultimaGps: u.ultimaGps || '',
          lat: u.lat,
          lng: u.lng,
          stopId: u.lastStopId || '',
          gpsTrail: Array.isArray(u.gpsTrail) ? u.gpsTrail : [],
          updatedAt: u.lastSeenAt || savedAt
        });
      }
      if (trips.length > 0 || units.length > 0) {
        await saveFleetMirror({
          dayKey,
          trips,
          units,
          stops: prevMirror?.stops || {},
          syncedAt: savedAt
        });
      }
    }
  } catch {
    // Non-fatal
  }
}

async function readOfflineFlotaResumen() {
  const [resSnap, bundleSnap] = await Promise.all([
    readIdbValue('flota_resumen'),
    readIdbValue('offline_bundle')
  ]);
  const resTs = Number(resSnap?.savedAt) || 0;
  const bunTs = Number(bundleSnap?.savedAt) || 0;
  const useBundle = Boolean(bundleSnap?.data?.resumen && bunTs >= resTs);
  const data = useBundle ? bundleSnap.data.resumen : resSnap?.data || bundleSnap?.data?.resumen || null;
  if (!data) return null;
  const savedAt = useBundle ? bunTs : resTs || bunTs || Date.now();
  return sanitizeApiPayload({
    data,
    source: 'offline-cache',
    isOfflineCache: true,
    savedAt
  });
}

async function readOfflineFlotaLinea(codLinea, dayKey = '') {
  if (!codLinea) return null;
  const cleanDay = String(dayKey || '').trim();
  const [lineSnap, bundleSnap, cat] = await Promise.all([
    readIdbValue(`flota_line:${codLinea}:${cleanDay || 'today'}`),
    readIdbValue('offline_bundle'),
    loadCatalogo().catch(() => null)
  ]);

  const lineTs = Number(lineSnap?.savedAt) || 0;
  const bunTs = Number(bundleSnap?.savedAt) || 0;

  if (lineSnap?.data && lineTs >= bunTs) {
    return sanitizeApiPayload({
      data: lineSnap.data,
      source: 'offline-cache',
      isOfflineCache: true,
      savedAt: lineTs
    });
  }

  if (bundleSnap?.data) {
    const b = bundleSnap.data;
    const bundleToday = b.dayKey || getArgentinaDayKeyLocal(bunTs);
    const selectedDayKey = /^\d{4}-\d{2}-\d{2}$/.test(cleanDay) ? cleanDay : bundleToday;
    const lineObj = b.lines?.[String(codLinea)] || null;
    const catLine = cat?.lineByCode?.get(Number(codLinea)) || null;
    const descripcionLinea = normalizePublicLineName(
      codLinea,
      lineObj?.descripcionLinea || catLine?.descripcion || `L${codLinea}`
    );
    const todayTrips = Array.isArray(lineObj?.dayTripsByDay?.[bundleToday])
      ? lineObj.dayTripsByDay[bundleToday]
      : [];
    const dayTrips =
      selectedDayKey === bundleToday
        ? todayTrips
        : Array.isArray(lineObj?.dayTripsByDay?.[selectedDayKey])
          ? lineObj.dayTripsByDay[selectedDayKey]
          : [];
    const dayObs = Array.isArray(lineObj?.dayObsByDay?.[selectedDayKey])
      ? lineObj.dayObsByDay[selectedDayKey]
      : [];

    return sanitizeApiPayload({
      data: {
        codigoLinea: Number(codLinea),
        descripcionLinea,
        dayKey: bundleToday,
        selectedDayKey,
        isHistoricalDay: selectedDayKey !== bundleToday,
        retentionDays: b.retentionDays || 7,
        daysWithData: Array.isArray(lineObj?.daysWithData) ? lineObj.daysWithData : [bundleToday],
        meta: b.meta || {},
        capacity: lineObj?.capacity || null,
        learnedTransitions: [],
        todayTrips,
        dayTrips,
        dayObs,
        coches: Array.isArray(lineObj?.coches) ? lineObj.coches : [],
        choferes: Array.isArray(lineObj?.choferes) ? lineObj.choferes : []
      },
      source: 'offline-cache',
      isOfflineCache: true,
      savedAt: bunTs || Date.now()
    });
  }

  if (lineSnap?.data) {
    return sanitizeApiPayload({
      data: lineSnap.data,
      source: 'offline-cache',
      isOfflineCache: true,
      savedAt: lineTs || Date.now()
    });
  }
  return null;
}

async function searchOfflineFlotaBundle(rawQ = '') {
  const q = String(rawQ || '').trim();
  const normQ = normalizeOfflineSearchText(q);
  if (normQ.length < 2) {
    return { data: { dayKey: getArgentinaDayKeyLocal(), results: [] }, source: 'offline-cache', isOfflineCache: true, savedAt: Date.now() };
  }
  const bundleSnap = await readIdbValue('offline_bundle');
  if (!bundleSnap?.data?.lines) return null;
  const b = sanitizeApiPayload(bundleSnap.data);
  const todayKey = b.dayKey || getArgentinaDayKeyLocal(bundleSnap.savedAt);
  const matches = [];

  for (const line of Object.values(b.lines)) {
    const cod = Number(line?.codigoLinea);
    if (!cod || REMOVED_LINE_CODES.has(cod)) continue;
    const desc = normalizePublicLineName(cod, line.descripcionLinea);

    for (const c of line.coches || []) {
      const hay = normalizeOfflineSearchText(`${c.coche} ${desc}`);
      if (!hay.includes(normQ) && !String(c.coche || '').toUpperCase().includes(q.toUpperCase())) continue;
      matches.push({
        type: 'coche',
        codigoLinea: cod,
        descripcionLinea: desc,
        coche: c.coche,
        choferNombre: c.lastChoferNombre || '',
        choferLegajo: c.lastChoferLegajo || '',
        esAdaptado: Boolean(c.esAdaptado),
        vistoHoy: Boolean(c.vistoHoy),
        enLineaAhora: Boolean(c.enLineaAhora),
        lastBandera: c.lastBandera || '',
        lastGps: c.lastGps || '',
        lastStopId: c.lastStopId || '',
        lastLat: c.lastLat ?? null,
        lastLng: c.lastLng ?? null,
        lastDesvioSec: Number(c.lastDesvioSec) || 0,
        lastDesvioRaw: c.lastDesvioRaw || '',
        lastTripKey: c.lastTripKey || '',
        lastServiceNum: Number(c.lastServiceNum) || 0,
        lastTurnoIdx: Number(c.lastTurnoIdx) || 0,
        lastTurnoStart: c.lastTurnoStart || '',
        lastTurnoEnd: c.lastTurnoEnd || '',
        lastLapNum: Number(c.lastLapNum) || 0,
        lastShiftLaps: Number(c.lastShiftLaps) || 0,
        lastSeenAt: c.lastSeenAt || 0,
        lastDayKey: c.lastDayKey || ''
      });
    }

    for (const d of line.choferes || []) {
      const hay = normalizeOfflineSearchText(`${d.choferNombre} ${d.choferLegajo || ''}`);
      if (!hay.includes(normQ)) continue;
      matches.push({
        type: 'chofer',
        driverKey: d.driverKey || '',
        codigoLinea: cod,
        descripcionLinea: desc,
        coche: d.lastCoche || '',
        choferNombre: d.choferNombre || '',
        choferLegajo: d.choferLegajo || '',
        esAdaptado: Boolean(d.lastEsAdaptado),
        vistoHoy: Boolean(d.vistoHoy),
        enLineaAhora: Boolean(d.enLineaAhora),
        lastBandera: d.lastBandera || '',
        lastGps: d.lastGps || '',
        lastStopId: d.lastStopId || '',
        lastLat: d.lastLat ?? null,
        lastLng: d.lastLng ?? null,
        lastDesvioSec: Number(d.lastDesvioSec) || 0,
        lastDesvioRaw: d.lastDesvioRaw || '',
        lastTripKey: d.lastTripKey || '',
        lastServiceNum: Number(d.lastServiceNum) || 0,
        lastTurnoIdx: Number(d.lastTurnoIdx) || 0,
        lastTurnoStart: d.lastTurnoStart || '',
        lastTurnoEnd: d.lastTurnoEnd || '',
        lastLapNum: Number(d.lastLapNum) || 0,
        lastShiftLaps: Number(d.lastShiftLaps) || 0,
        lastSeenAt: d.lastSeenAt || 0,
        lastDayKey: d.lastDayKey || ''
      });
    }
  }

  matches.sort((a, b) => {
    if (a.enLineaAhora !== b.enLineaAhora) return a.enLineaAhora ? -1 : 1;
    if (a.vistoHoy !== b.vistoHoy) return a.vistoHoy ? -1 : 1;
    return (b.lastSeenAt || 0) - (a.lastSeenAt || 0);
  });

  return sanitizeApiPayload({
    data: { dayKey: todayKey, results: matches.slice(0, 12) },
    source: 'offline-cache',
    isOfflineCache: true,
    savedAt: Number(bundleSnap.savedAt) || Date.now()
  });
}

async function readOfflineFlotaActiva() {
  const [actSnap, bundleSnap] = await Promise.all([
    readIdbValue('flota_activa'),
    readIdbValue('offline_bundle')
  ]);
  const actTs = Number(actSnap?.savedAt) || 0;
  const bunTs = Number(bundleSnap?.savedAt) || 0;

  if (actSnap?.data && Array.isArray(actSnap.data.units) && actTs >= bunTs) {
    return sanitizeApiPayload({
      data: actSnap.data,
      source: 'offline-cache',
      isOfflineCache: true,
      savedAt: actTs
    });
  }
  if (bundleSnap?.data && Array.isArray(bundleSnap.data.activeUnits)) {
    return sanitizeApiPayload({
      data: {
        dayKey: bundleSnap.data.dayKey || getArgentinaDayKeyLocal(bunTs),
        activeWindowMin: bundleSnap.data.activeWindowMin || 38,
        meta: bundleSnap.data.meta || null,
        units: bundleSnap.data.activeUnits
      },
      source: 'offline-cache',
      isOfflineCache: true,
      savedAt: bunTs || Date.now()
    });
  }
  if (actSnap?.data) {
    return sanitizeApiPayload({
      data: actSnap.data,
      source: 'offline-cache',
      isOfflineCache: true,
      savedAt: actTs || Date.now()
    });
  }
  return null;
}

// ── Automatic Full-Offline Startup Sync (Routes, Schedules, 7-day Fleet Bundle & Corrientes OSM Map Tiles) ──
const SW_DATA_CACHE_NAME = 'direct-gps-data-v7';
const SW_TILE_CACHE_NAME = 'direct-gps-tiles-v2';
const OFFLINE_BUNDLE_REFRESH_MIN_MS = 5 * 60 * 1000;

function llToOsmTile(lat, lng, z) {
  const n = 2 ** z;
  const x = Math.floor(((lng + 180) / 360) * n);
  const rad = (lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n);
  return { x, y };
}

function buildCorrientesOfflineTileList() {
  // Metro box covers Corrientes Capital + Puente Belgrano + Barranqueras/Resistencia + Santa Ana/Laguna Brava (92 tiles z12-z14)
  // City core box adds z15 street detail across downtown & main Corrientes avenues (63 tiles) -> 155 tiles total (~2.5 MB once)
  const metro = { latMin: -27.54, latMax: -27.43, lngMin: -58.92, lngMax: -58.74 };
  const city = { latMin: -27.515, latMax: -27.452, lngMin: -58.855, lngMax: -58.775 };
  const centerLat = -27.479;
  const centerLng = -58.834;
  const specs = [
    { z: 12, box: metro },
    { z: 13, box: metro },
    { z: 14, box: metro },
    { z: 15, box: city }
  ];

  const out = [];
  for (const { z, box } of specs) {
    const tl = llToOsmTile(box.latMax, box.lngMin, z);
    const br = llToOsmTile(box.latMin, box.lngMax, z);
    const center = llToOsmTile(centerLat, centerLng, z);
    const layerTiles = [];
    for (let x = tl.x; x <= br.x; x++) {
      for (let y = tl.y; y <= br.y; y++) {
        const distSq = (x - center.x) ** 2 + (y - center.y) ** 2;
        layerTiles.push({ z, x, y, distSq });
      }
    }
    layerTiles.sort((a, b) => a.distSq - b.distSq);
    for (const t of layerTiles) out.push(t);
  }
  return out;
}

let offlineBundleSyncInFlight = null;
export async function refreshOfflineBundleSilent({ force = false } = {}) {
  if (isBrowserOffline()) return false;
  if (offlineBundleSyncInFlight) return offlineBundleSyncInFlight;
  offlineBundleSyncInFlight = (async () => {
    try {
      if (!force) {
        const existing = await readIdbValue('offline_bundle');
        if (existing?.savedAt && Date.now() - Number(existing.savedAt) < OFFLINE_BUNDLE_REFRESH_MIN_MS) {
          return true;
        }
      }
      await api.offlineBundle();
      return true;
    } catch {
      return false;
    } finally {
      offlineBundleSyncInFlight = null;
    }
  })();
  return offlineBundleSyncInFlight;
}

let warmInFlight = false;
let warmStaticDone = false;
let warmTilesDone = false;

/**
 * Automatically caches EVERYTHING needed for full offline PWA usage on startup (zero manual action):
 * 1) Persistent storage request (prevents mobile cache eviction)
 * 2) All 26 Corrientes routes (recorridos/*.json), 24h schedules (horarios/*.json), catalogo & OTA index
 * 3) Complete 7-day fleet snapshot (/api/offline-bundle: coches, choferes, servicios, historial 7d, Modo Libre)
 * 4) Corrientes Capital + Puente + Resistencia OSM map tiles (z12–z15, cached once, polite background pacing)
 */
export async function warmOfflineArchive({ forceBundle = false } = {}) {
  if (isBrowserOffline() || warmInFlight) return;
  if (typeof navigator !== 'undefined' && navigator.connection?.saveData) {
    // Even in Data Saver mode, sync the tiny JSON fleet bundle so Flota/Servicios work offline
    await refreshOfflineBundleSilent({ force: forceBundle });
    return;
  }
  warmInFlight = true;

  const waitIdle = (delayMs = 80) =>
    new Promise((resolve) => {
      setTimeout(() => {
        if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
          window.requestIdleCallback(() => resolve(), { timeout: 500 });
        } else {
          resolve();
        }
      }, delayMs);
    });

  try {
    if (typeof navigator !== 'undefined' && navigator.storage?.persist) {
      navigator.storage.persist().catch(() => {});
    }

    // Kick off the single-shot 7-day fleet/cars/drivers/services/activeUnits offline bundle immediately
    const bundleTask = refreshOfflineBundleSilent({ force: forceBundle });

    // Step 1: Ensure catalogo, OTA horarios index, and all 26 routes + 24h schedules are cached
    const hasCacheApi = typeof caches !== 'undefined';
    if (!warmStaticDone) {
      await ensureOtaHorariosIndex().catch(() => {});
      const cat = await loadCatalogo().catch(() => null);
      if (cat?.lineas?.length) {
        const dataCache = hasCacheApi ? await caches.open(SW_DATA_CACHE_NAME).catch(() => null) : null;
        const urls = [
          new URL('../data/catalogo.json', import.meta.url).toString(),
          new URL('../data/horarios/index.json', import.meta.url).toString()
        ];
        for (const l of cat.lineas) {
          urls.push(new URL(`../data/recorridos/${l.codigo}.json`, import.meta.url).toString());
          urls.push(new URL(`../data/horarios/${l.codigo}.json`, import.meta.url).toString());
        }

        let allStaticCached = true;
        for (const u of urls) {
          if (isBrowserOffline()) {
            allStaticCached = false;
            break;
          }
          try {
            if (dataCache) {
              const hit = await dataCache.match(u);
              if (hit) continue;
            }
            await waitIdle(25);
            const res = await fetch(u, { priority: 'low' }).catch(() => null);
            if (res && res.ok && dataCache) {
              await dataCache.put(u, res.clone()).catch(() => {});
            } else if (!res || !res.ok) {
              allStaticCached = false;
            }
          } catch {
            allStaticCached = false;
          }
        }
        if (allStaticCached) warmStaticDone = true;
      }
    }

    await bundleTask;

    // Step 2: Gently pre-cache Corrientes Capital + Puente + Resistencia OSM map tiles (cached once!)
    if (!warmTilesDone && hasCacheApi && !isBrowserOffline()) {
      const tileCache = await caches.open(SW_TILE_CACHE_NAME).catch(() => null);
      if (tileCache) {
        const tiles = buildCorrientesOfflineTileList();
        const subs = ['a', 'b', 'c'];
        let allTilesCached = true;
        let fetchedCount = 0;

        for (let i = 0; i < tiles.length; i++) {
          if (isBrowserOffline()) {
            allTilesCached = false;
            break;
          }
          const { z, x, y } = tiles[i];
          const canonicalUrl = `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;
          try {
            const hit = await tileCache.match(canonicalUrl);
            if (hit) continue;

            // Respectful background pacing so OSM tiles & 60fps UI stay completely smooth
            await waitIdle(fetchedCount === 0 ? 120 : 150);
            if (isBrowserOffline()) {
              allTilesCached = false;
              break;
            }

            const fetchUrl = `https://${subs[i % subs.length]}.tile.openstreetmap.org/${z}/${x}/${y}.png`;
            let res = await fetch(fetchUrl, { priority: 'low' }).catch(() => null);
            if (!res) {
              res = await fetch(fetchUrl, { mode: 'no-cors', priority: 'low' }).catch(() => null);
            }
            if (res && (res.ok || res.type === 'opaque')) {
              await tileCache.put(canonicalUrl, res.clone()).catch(() => {});
              fetchedCount++;
            } else {
              allTilesCached = false;
            }
          } catch {
            allTilesCached = false;
          }
        }
        if (allTilesCached) warmTilesDone = true;
      }
    }
  } catch {
    // Non-fatal: app keeps operating seamlessly
  } finally {
    warmInFlight = false;
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

  const m = normalized.match(/^([+-])(\d{1,4}):(\d{2})$/);
  if (!m) {
    return { raw: clean, status: 'none', label: normalized, shortLabel: normalized, sign: '', minutes: 0, seconds: 0 };
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
    const expectedSchedMin = (((nowMin + bus.eta.minutes + desvioMin) % 1440) + 1440) % 1440;

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
    const resolved = resolveDriverDisplayInfo(existingLegajo, existingNombre, raw);
    return {
      nombre: resolved.nombre,
      legajo: resolved.legajo,
      raw: raw || (resolved.legajo ? `${resolved.nombre} (${resolved.legajo})` : resolved.nombre)
    };
  }
  const clean = String(raw || '').trim();
  if (!clean) return { nombre: '', legajo: '', raw: '' };
  const m = clean.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
  if (m) {
    const resolved = resolveDriverDisplayInfo(m[2].trim(), m[1].trim(), clean);
    return { nombre: resolved.nombre, legajo: resolved.legajo, raw: clean };
  }
  const resolved = resolveDriverDisplayInfo('', clean, clean);
  return { nombre: resolved.nombre, legajo: resolved.legajo, raw: clean };
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
