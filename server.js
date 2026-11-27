const http = require('http');
const fs = require('fs');
const path = require('path');
const smartmove = require('./lib/smartmove');
const { PILOT_STOP, QUICK_STOPS, CORRIENTES_HUBS } = require('./lib/seed-data');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'docs');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp'
};

const FLEET_STORE_FILE = path.join(__dirname, '.cache', 'fleet-memory.json');
const ROSTER_RETENTION_DAYS = 7;
const ROSTER_RETENTION_MS = ROSTER_RETENTION_DAYS * 86400 * 1000;
const BG_SCAN_INTERVAL_MIN = 5;
const BG_SCAN_BATCH_SIZE = 18;
const BG_SCAN_CONCURRENCY = 3;

const REMOVED_LINE_CODES = new Set([517, 607, 608, 744, 851, 853, 854]);

const LINE_NAMES_BY_CODE = {
  94: '102A',
  96: '102C',
  97: '102B',
  113: '104A',
  114: '104C',
  115: '104B',
  118: '104D',
  132: '103A',
  133: '103B',
  134: '103C',
  342: '109A',
  346: '105A',
  347: '105B',
  348: '105C',
  350: '106A',
  351: '106B',
  352: '106C',
  353: '109B',
  356: '108A',
  357: '108C',
  433: '103D',
  705: '109C',
  852: '902',
  1037: '904A',
  1038: '904B',
  1039: '904C'
};

const FLEET_SCAN_TARGETS = [
  [94, 'CT31939'], [94, 'CT31409'],
  [97, 'CT31507'], [97, 'CT31254'],
  [96, 'CT31210'], [96, 'CT32204'],
  [132, 'CT31507'], [132, 'CT31572V'],
  [133, 'CT31766'], [133, 'CT32257'],
  [134, 'CT31764'], [134, 'CT32257'],
  [113, 'CT31518'], [113, 'CT31463'], [113, 'CT31196'],
  [115, 'CT31635'], [115, 'CT31466'],
  [114, 'CT31976'], [114, 'CT31568V'],
  [118, 'CT31775'], [118, 'CT32093'], [118, 'CT31861'],
  [346, 'CT31544'], [346, 'CT32222'],
  [347, 'CT31543'], [347, 'CT31991I'],
  [348, 'CT31361'], [348, 'CT31256B'], [348, 'CT31552'], [348, 'CT312792'],
  [350, 'CT31397'], [350, 'CT32070'],
  [351, 'CT31396'], [351, 'CT31974'],
  [352, 'CT31221'], [352, 'CT47849'],
  [356, 'CT31189'], [356, 'CT31267'],
  [357, 'CT31874'], [357, 'CT31143'],
  [342, 'CT31244B'], [342, 'CT31922'],
  [353, 'CT31244B'], [353, 'CT31340'],
  [1037, 'CT31648'], [1037, 'CH326'],
  [1038, 'L9041075'], [1038, 'L9041098'],
  [1039, 'L9041057'], [1039, 'CT31212'],
  [852, 'CH490'], [852, 'CH455'], [852, 'CH430'],
  [433, 'CT31373'], [433, 'RCH010'],
  [705, 'CT31392B'], [705, 'CT31363'],
  [0, 'CT31180'], [0, 'CT31181'], [0, 'CT31498'], [0, 'CT31942'], [0, 'CT31581'], [0, 'CT31350']
];
const BG_FULL_CYCLE_MIN = Math.ceil(FLEET_SCAN_TARGETS.length / BG_SCAN_BATCH_SIZE) * BG_SCAN_INTERVAL_MIN;

const INVALID_DRIVER_TOKENS = new Set([
  '',
  '-',
  '--',
  '—',
  '0',
  'S/D',
  'SD',
  'N/A',
  'SIN CHOFER',
  'NO ASIGNADO',
  'DESCONOCIDO',
  'SIN ASIGNAR',
  'NINGUNO',
  'NULL',
  'UNDEFINED'
]);

function getArgentinaDayKey(nowMs = Date.now()) {
  // Service day rolls over at 03:00 AM ART (UTC-6 shift) so 05:00 AM starts fresh with zero previous-day cars
  const d = new Date(nowMs - 6 * 3600 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function parseDesvioSeconds(raw = '') {
  const clean = String(raw || '').replace(/\s+/g, '');
  const m = clean.match(/^([+-])(\d{1,4}):(\d{2})$/);
  if (!m) return 0;
  return (m[1] === '+' ? 1 : -1) * (parseInt(m[2], 10) * 60 + parseInt(m[3], 10));
}

function parseGpsStampMs(raw = '') {
  const m = String(raw || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})$/);
  if (!m) return 0;
  return Date.UTC(
    parseInt(m[3], 10),
    parseInt(m[2], 10) - 1,
    parseInt(m[1], 10),
    parseInt(m[4], 10) + 3,
    parseInt(m[5], 10),
    parseInt(m[6], 10)
  );
}

function resolveObservationTime(ultimaGps, nowMs) {
  const gpsMs = parseGpsStampMs(ultimaGps);
  if (gpsMs > 0 && nowMs - gpsMs > 18 * 3600 * 1000 && gpsMs <= nowMs + 600000) {
    return { obsMs: gpsMs, obsDayKey: getArgentinaDayKey(gpsMs) };
  }
  return { obsMs: nowMs, obsDayKey: getArgentinaDayKey(nowMs) };
}

function normalizeDriverNameKey(nombre = '') {
  return String(nombre || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
}

function normalizeDriverRecord(choferNombre = '', choferLegajo = '', choferRaw = '') {
  let nombre = String(choferNombre || '').trim();
  let legajo = String(choferLegajo || '').trim();
  const raw = String(choferRaw || '').trim();
  if (!nombre && !legajo && raw) {
    const m = raw.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
    if (m) {
      nombre = m[1].trim();
      legajo = m[2].trim();
    } else {
      nombre = raw;
    }
  }
  const resolved = smartmove.resolveDriverDisplayInfo(legajo, nombre, raw);
  nombre = resolved.nombre;
  legajo = resolved.legajo;
  const cleanLeg = legajo.replace(/^0+$/, '').trim();
  const normName = normalizeDriverNameKey(nombre);
  const validName = normName && !INVALID_DRIVER_TOKENS.has(normName) && normName.length >= 2;
  const validLeg = cleanLeg && !INVALID_DRIVER_TOKENS.has(cleanLeg.toUpperCase());
  if (!validName && !validLeg) return null;

  const displayName = validName ? nombre : `Legajo ${cleanLeg}`;
  const driverKey = validLeg ? `leg:${cleanLeg.toUpperCase()}` : `name:${normName}`;
  const legacyNameKey = validLeg && validName ? `name:${normName}` : '';
  return {
    driverKey,
    legacyNameKey,
    nombre: displayName,
    legajo: validLeg ? cleanLeg : '',
    raw: raw || (validLeg ? `${displayName} (${cleanLeg})` : displayName)
  };
}

function compareCocheIds(a, b) {
  const na = Number(String(a || '').replace(/\D+/g, ''));
  const nb = Number(String(b || '').replace(/\D+/g, ''));
  if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
  return String(a || '').localeCompare(String(b || ''));
}

function loadFleetStore() {
  try {
    const parsed = JSON.parse(fs.readFileSync(FLEET_STORE_FILE, 'utf8'));
    return {
      trips: parsed.trips || {},
      units: parsed.units || {},
      stops: parsed.stops || {},
      rosterCars: parsed.rosterCars || {},
      rosterDrivers: parsed.rosterDrivers || {},
      rosterMeta: {
        scanCursor: 0,
        lastCronAt: null,
        lastCycleAt: null,
        totalSweeps: 0,
        lastBatchUnits: 0,
        ...(parsed.rosterMeta || {})
      }
    };
  } catch {
    return {
      trips: {},
      units: {},
      stops: {},
      rosterCars: {},
      rosterDrivers: {},
      rosterMeta: {
        scanCursor: 0,
        lastCronAt: null,
        lastCycleAt: null,
        totalSweeps: 0,
        lastBatchUnits: 0
      }
    };
  }
}

const fleetStore = loadFleetStore();
let fleetSaveTimer = null;

function upsertLocalRosterUnit(u, nowMs = Date.now(), explicitDayKey = '') {
  const cod = Number(u.codigoLinea);
  const coche = String(u.coche || u.identificadorCoche || '').trim();
  if (!cod || !coche) return false;

  const ultimaGps = String(u.ultimaGps || u.ultimaFechaHoraGPS || '').trim();
  const { obsMs, obsDayKey } = resolveObservationTime(ultimaGps, nowMs);
  const effectiveDayKey = explicitDayKey && obsMs === nowMs ? explicitDayKey : obsDayKey;
  if (obsMs < nowMs - ROSTER_RETENTION_MS) return false;

  const descLinea = String(u.descripcionLinea || LINE_NAMES_BY_CODE[cod] || '').trim();
  const bandera = String(u.bandera || u.descripcionBandera || '').trim();
  const stopId = String(u.stopId || '').trim().toUpperCase();
  const esAdaptado = Boolean(u.esAdaptado);
  const uLat = Number(u.lat ?? u.latitud);
  const uLng = Number(u.lng ?? u.longitud);
  const validCoords = Number.isFinite(uLat) && Number.isFinite(uLng) && (uLat !== 0 || uLng !== 0);
  const desvioRaw = String(u.desvioRaw || u.desvioHorario || '').trim();
  const desvioSec = Number.isFinite(Number(u.desvioSec)) ? Number(u.desvioSec) : parseDesvioSeconds(desvioRaw);
  const driver = normalizeDriverRecord(
    u.choferNombre || '',
    u.choferLegajo || '',
    u.choferRaw || u.identificadorChofer || ''
  );

  fleetStore.rosterCars ||= {};
  fleetStore.rosterDrivers ||= {};

  const carKey = `${cod}:${coche}`;
  const prevCar = fleetStore.rosterCars[carKey];
  const isNewerCar = !prevCar || obsMs >= prevCar.lastSeenAt;
  fleetStore.rosterCars[carKey] = {
    codigoLinea: cod,
    descripcionLinea: descLinea || prevCar?.descripcionLinea || LINE_NAMES_BY_CODE[cod] || `L${cod}`,
    coche,
    esAdaptado: esAdaptado || Boolean(prevCar?.esAdaptado),
    lastChoferNombre: (isNewerCar && driver?.nombre) || prevCar?.lastChoferNombre || '',
    lastChoferLegajo: (isNewerCar && driver?.legajo) || prevCar?.lastChoferLegajo || '',
    lastBandera: (isNewerCar && bandera) || prevCar?.lastBandera || '',
    lastGps: (isNewerCar && ultimaGps) || prevCar?.lastGps || '',
    lastStopId: (isNewerCar && stopId) || prevCar?.lastStopId || '',
    lastLat: isNewerCar && validCoords ? uLat : prevCar?.lastLat ?? null,
    lastLng: isNewerCar && validCoords ? uLng : prevCar?.lastLng ?? null,
    lastDesvioSec: isNewerCar ? desvioSec : prevCar?.lastDesvioSec || 0,
    lastDesvioRaw: (isNewerCar && desvioRaw) || prevCar?.lastDesvioRaw || '',
    firstSeenAt: prevCar ? Math.min(prevCar.firstSeenAt, obsMs) : obsMs,
    lastSeenAt: prevCar ? Math.max(prevCar.lastSeenAt, obsMs) : obsMs,
    lastDayKey: isNewerCar ? effectiveDayKey : prevCar.lastDayKey,
    seenCount: (prevCar?.seenCount || 0) + 1
  };

  if (driver) {
    const drvKey = `${cod}:${driver.driverKey}`;
    let prevDrv = fleetStore.rosterDrivers[drvKey];
    if (driver.legacyNameKey && fleetStore.rosterDrivers[`${cod}:${driver.legacyNameKey}`]) {
      const legacy = fleetStore.rosterDrivers[`${cod}:${driver.legacyNameKey}`];
      delete fleetStore.rosterDrivers[`${cod}:${driver.legacyNameKey}`];
      if (!prevDrv) prevDrv = legacy;
    }
    const isNewerDrv = !prevDrv || obsMs >= prevDrv.lastSeenAt;
    fleetStore.rosterDrivers[drvKey] = {
      codigoLinea: cod,
      descripcionLinea: descLinea || prevDrv?.descripcionLinea || LINE_NAMES_BY_CODE[cod] || `L${cod}`,
      driverKey: driver.driverKey,
      choferNombre: driver.nombre.startsWith('Legajo ') && prevDrv?.choferNombre ? prevDrv.choferNombre : driver.nombre,
      choferLegajo: driver.legajo || prevDrv?.choferLegajo || '',
      lastCoche: isNewerDrv ? coche : prevDrv.lastCoche,
      lastEsAdaptado: isNewerDrv ? esAdaptado : Boolean(prevDrv?.lastEsAdaptado),
      lastBandera: (isNewerDrv && bandera) || prevDrv?.lastBandera || '',
      lastGps: (isNewerDrv && ultimaGps) || prevDrv?.lastGps || '',
      lastStopId: (isNewerDrv && stopId) || prevDrv?.lastStopId || '',
      lastLat: isNewerDrv && validCoords ? uLat : prevDrv?.lastLat ?? null,
      lastLng: isNewerDrv && validCoords ? uLng : prevDrv?.lastLng ?? null,
      lastDesvioSec: isNewerDrv ? desvioSec : prevDrv?.lastDesvioSec || 0,
      lastDesvioRaw: (isNewerDrv && desvioRaw) || prevDrv?.lastDesvioRaw || '',
      firstSeenAt: prevDrv ? Math.min(prevDrv.firstSeenAt, obsMs) : obsMs,
      lastSeenAt: prevDrv ? Math.max(prevDrv.lastSeenAt, obsMs) : obsMs,
      lastDayKey: isNewerDrv ? effectiveDayKey : prevDrv.lastDayKey,
      seenCount: (prevDrv?.seenCount || 0) + 1
    };
  }
  return true;
}

// One-time backfill from existing units on disk if rosterCars is empty
if (Object.keys(fleetStore.rosterCars).length === 0 && Object.keys(fleetStore.units).length > 0) {
  const nowMs = Date.now();
  for (const u of Object.values(fleetStore.units)) {
    upsertLocalRosterUnit(u, u.updatedAt || nowMs, u.dayKey || '');
  }
}

function scheduleFleetStoreSave() {
  if (fleetSaveTimer) return;
  fleetSaveTimer = setTimeout(() => {
    fleetSaveTimer = null;
    try {
      const nowMs = Date.now();
      const cutoffTrips = nowMs - ROSTER_RETENTION_MS;
      const cutoffUnits = nowMs - ROSTER_RETENTION_MS;
      const cutoffRoster = nowMs - ROSTER_RETENTION_MS;
      for (const [k, v] of Object.entries(fleetStore.trips)) {
        if ((v.updatedAt || 0) < cutoffTrips) delete fleetStore.trips[k];
      }
      for (const [k, v] of Object.entries(fleetStore.units)) {
        if ((v.updatedAt || 0) < cutoffUnits) delete fleetStore.units[k];
      }
      for (const [k, v] of Object.entries(fleetStore.stops || {})) {
        if ((v.savedAt || 0) < cutoffUnits) delete fleetStore.stops[k];
      }
      for (const [k, v] of Object.entries(fleetStore.rosterCars || {})) {
        if ((v.lastSeenAt || 0) < cutoffRoster) delete fleetStore.rosterCars[k];
      }
      for (const [k, v] of Object.entries(fleetStore.rosterDrivers || {})) {
        if ((v.lastSeenAt || 0) < cutoffRoster) delete fleetStore.rosterDrivers[k];
      }
      fs.mkdirSync(path.dirname(FLEET_STORE_FILE), { recursive: true });
      fs.writeFileSync(FLEET_STORE_FILE, JSON.stringify(fleetStore));
    } catch {
      // Ignore disk write errors
    }
  }, 1500);
}

function recordFleetUnitsLocal(arribos = [], stopId = '', stopCoords = null) {
  if (!Array.isArray(arribos) || arribos.length === 0) return;
  const nowMs = Date.now();
  const dayKey = getArgentinaDayKey(nowMs);
  let dirty = false;
  for (const a of arribos) {
    const cod = Number(a.codigoLinea);
    const coche = String(a.identificadorCoche || '').trim();
    if (!cod || !coche) continue;
    const key = `${cod}:${coche}`;
    const prev = fleetStore.units[key] || {};
    const lat = parseFloat(a.latitud);
    const lng = parseFloat(a.longitud);
    const unitRec = {
      codigoLinea: cod,
      descripcionLinea: String(a.descripcionLinea || LINE_NAMES_BY_CODE[cod] || '').trim(),
      coche,
      dayKey,
      tripKey: prev.tripKey || '',
      choferNombre: a.choferNombre || prev.choferNombre || '',
      choferLegajo: a.choferLegajo || prev.choferLegajo || '',
      choferRaw: a.identificadorChofer || prev.choferRaw || '',
      esAdaptado: Boolean(a.esAdaptado),
      desvioSec: parseDesvioSeconds(a.desvioHorario),
      desvioRaw: a.desvioHorario || prev.desvioRaw || '',
      bandera: a.descripcionBandera || prev.bandera || '',
      ultimaGps: a.ultimaFechaHoraGPS || prev.ultimaGps || '',
      lat: !Number.isNaN(lat) && lat !== 0 ? lat : prev.lat ?? null,
      lng: !Number.isNaN(lng) && lng !== 0 ? lng : prev.lng ?? null,
      stopId: String(stopId || prev.stopId || '').toUpperCase(),
      updatedAt: nowMs
    };
    fleetStore.units[key] = unitRec;
    upsertLocalRosterUnit(unitRec, nowMs, dayKey);
    dirty = true;
  }
  const cleanStop = String(stopId || '').trim().toUpperCase();
  if (cleanStop) {
    fleetStore.stops ||= {};
    fleetStore.stops[cleanStop] = {
      idParada: cleanStop,
      stopCoords: stopCoords || null,
      arribos: arribos.slice(0, 30),
      savedAt: nowMs
    };
    dirty = true;
  }
  if (dirty) scheduleFleetStoreSave();
}

function recordFleetTripsLocal(entries = [], dayKey, defaultLine) {
  const nowMs = Date.now();
  let count = 0;
  for (const e of entries) {
    const cod = Number(e.codigoLinea ?? defaultLine);
    const tripKey = String(e.tripKey || '').trim();
    const coche = String(e.coche || '').trim();
    if (!cod || !tripKey || !coche) continue;
    const tKey = `${dayKey}:${cod}:${tripKey}`;
    const prevT = fleetStore.trips[tKey] || {};
    const lat = Number.isFinite(Number(e.lat)) ? Number(e.lat) : prevT.lat ?? null;
    const lng = Number.isFinite(Number(e.lng)) ? Number(e.lng) : prevT.lng ?? null;
    const rec = {
      dayKey,
      codigoLinea: cod,
      tripKey,
      turnoHora: String(e.turnoHora || prevT.turnoHora || '').trim(),
      coche,
      choferNombre: String(e.choferNombre || prevT.choferNombre || '').trim(),
      choferLegajo: String(e.choferLegajo || prevT.choferLegajo || '').trim(),
      choferRaw: String(e.choferRaw || prevT.choferRaw || '').trim(),
      esAdaptado: Boolean(e.esAdaptado),
      desvioSec: Number.isFinite(Number(e.desvioSec)) ? Math.round(Number(e.desvioSec)) : 0,
      desvioRaw: String(e.desvioRaw || prevT.desvioRaw || '').trim(),
      ultimaGps: String(e.ultimaGps || prevT.ultimaGps || '').trim(),
      lat,
      lng,
      stopId: String(e.stopId || prevT.stopId || '').trim().toUpperCase(),
      updatedAt: nowMs
    };
    fleetStore.trips[tKey] = rec;
    const unitRec = { ...rec, bandera: String(e.bandera || '').trim() };
    fleetStore.units[`${cod}:${coche}`] = unitRec;
    upsertLocalRosterUnit(unitRec, nowMs, dayKey);
    count++;
  }
  if (count > 0) scheduleFleetStoreSave();
  return count;
}

let bgScanInFlight = false;
async function runLocalFleetScanBatch() {
  if (bgScanInFlight) return;
  const nowMs = Date.now();
  const art = new Date(nowMs - 3 * 3600 * 1000);
  const artMinOfDay = art.getUTCHours() * 60 + art.getUTCMinutes();
  if (artMinOfDay >= 90 && artMinOfDay < 270) return; // Quiet dead-night window 01:30–04:30 ART

  bgScanInFlight = true;
  try {
    const total = FLEET_SCAN_TARGETS.length;
    const start = ((Number(fleetStore.rosterMeta.scanCursor) || 0) % total + total) % total;
    const end = Math.min(total, start + BG_SCAN_BATCH_SIZE);
    const batch = FLEET_SCAN_TARGETS.slice(start, end);
    const cycleCompleted = end >= total;
    let found = 0;

    for (let i = 0; i < batch.length; i += BG_SCAN_CONCURRENCY) {
      const wave = batch.slice(i, i + BG_SCAN_CONCURRENCY);
      const results = await Promise.all(
        wave.map(([cod, stopId]) =>
          smartmove
            .getArribos(stopId, cod === 0 ? '000' : String(cod), false)
            .then((r) => ({ stopId, arribos: r?.data?.arribos || [] }))
            .catch(() => ({ stopId, arribos: [] }))
        )
      );
      for (const r of results) {
        if (r.arribos.length > 0) {
          recordFleetUnitsLocal(r.arribos, r.stopId, null);
          found += r.arribos.length;
        }
      }
    }

    fleetStore.rosterMeta.scanCursor = cycleCompleted ? 0 : end;
    fleetStore.rosterMeta.lastCronAt = Date.now();
    fleetStore.rosterMeta.lastBatchUnits = found;
    if (cycleCompleted) {
      fleetStore.rosterMeta.lastCycleAt = Date.now();
      fleetStore.rosterMeta.totalSweeps = (Number(fleetStore.rosterMeta.totalSweeps) || 0) + 1;
    }
    scheduleFleetStoreSave();
  } finally {
    bgScanInFlight = false;
  }
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    let buf = '';
    req.on('data', (chunk) => {
      if (buf.length < 200000) buf += chunk;
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(buf || '{}'));
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(body);
}

function serveStatic(req, res, pathname) {
  let cleanPath = pathname === '/' ? '/index.html' : pathname;
  // Prevent directory traversal
  const resolved = path.normalize(path.join(PUBLIC_DIR, cleanPath));
  if (!resolved.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.stat(resolved, (err, stats) => {
    if (err || !stats.isFile()) {
      // Fallback to index.html for SPA routes
      const fallback = path.join(PUBLIC_DIR, 'index.html');
      fs.readFile(fallback, (e2, content) => {
        if (e2) {
          res.writeHead(404);
          res.end('Not Found');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(content);
      });
      return;
    }

    const ext = path.extname(resolved).toLowerCase();
    const mime = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': mime,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600'
    });
    fs.createReadStream(resolved).pipe(res);
  });
}

async function handleApi(req, res, urlObj) {
  const { pathname, searchParams } = urlObj;

  try {
    if (pathname === '/api/health') {
      return sendJson(res, 200, {
        ok: true,
        version: '2.1',
        service: 'DIRECT GPS · Corrientes',
        fleetMemory: 'disk-json',
        autoFleetScan: {
          intervalMin: BG_SCAN_INTERVAL_MIN,
          fullCycleMin: BG_FULL_CYCLE_MIN,
          retentionDays: ROSTER_RETENTION_DAYS,
          targets: FLEET_SCAN_TARGETS.length
        },
        timestamp: Date.now()
      });
    }

    if (pathname === '/api/flota-resumen' && req.method === 'GET') {
      const nowMs = Date.now();
      const todayKey = getArgentinaDayKey(nowMs);
      const minTs = nowMs - ROSTER_RETENTION_MS;
      const byLine = new Map();
      const ensureLine = (cod, desc) => {
        if (!byLine.has(cod)) {
          byLine.set(cod, {
            codigoLinea: cod,
            descripcionLinea: desc || LINE_NAMES_BY_CODE[cod] || `L${cod}`,
            cochesHoy: 0,
            cochesSemana: 0,
            choferesHoy: 0,
            choferesSemana: 0,
            lastSeenAt: 0
          });
        }
        return byLine.get(cod);
      };
      for (const c of Object.values(fleetStore.rosterCars || {})) {
        if ((c.lastSeenAt || 0) < minTs) continue;
        const entry = ensureLine(c.codigoLinea, c.descripcionLinea);
        entry.cochesSemana += 1;
        if (c.lastDayKey === todayKey) entry.cochesHoy += 1;
        entry.lastSeenAt = Math.max(entry.lastSeenAt, c.lastSeenAt || 0);
      }
      for (const d of Object.values(fleetStore.rosterDrivers || {})) {
        if ((d.lastSeenAt || 0) < minTs) continue;
        const entry = ensureLine(d.codigoLinea, d.descripcionLinea);
        entry.choferesSemana += 1;
        if (d.lastDayKey === todayKey) entry.choferesHoy += 1;
        entry.lastSeenAt = Math.max(entry.lastSeenAt, d.lastSeenAt || 0);
      }
      const lineas = Array.from(byLine.values()).sort((a, b) =>
        a.descripcionLinea.localeCompare(b.descripcionLinea, 'es', { numeric: true })
      );
      return sendJson(res, 200, {
        data: {
          dayKey: todayKey,
          retentionDays: ROSTER_RETENTION_DAYS,
          meta: {
            lastCronAt: fleetStore.rosterMeta?.lastCronAt || null,
            lastCycleAt: fleetStore.rosterMeta?.lastCycleAt || null,
            totalSweeps: fleetStore.rosterMeta?.totalSweeps || 0,
            lastBatchUnits: fleetStore.rosterMeta?.lastBatchUnits || 0,
            scanIntervalMin: BG_SCAN_INTERVAL_MIN,
            fullCycleMin: BG_FULL_CYCLE_MIN,
            retentionDays: ROSTER_RETENTION_DAYS
          },
          lineas
        },
        source: 'fleet-memory-disk',
        savedAt: nowMs
      });
    }

    if (pathname === '/api/flota' && req.method === 'GET') {
      const codLinea = Number(searchParams.get('codLinea'));
      if (!codLinea) return sendJson(res, 400, { error: 'Falta el parámetro codLinea' });
      const nowMs = Date.now();
      const todayKey = getArgentinaDayKey(nowMs);
      const minTs = nowMs - ROSTER_RETENTION_MS;
      const coches = Object.values(fleetStore.rosterCars || {})
        .filter((c) => c.codigoLinea === codLinea && (c.lastSeenAt || 0) >= minTs)
        .map((c) => ({ ...c, vistoHoy: c.lastDayKey === todayKey }))
        .sort((a, b) => {
          if (a.vistoHoy !== b.vistoHoy) return a.vistoHoy ? -1 : 1;
          if (b.lastSeenAt !== a.lastSeenAt) return b.lastSeenAt - a.lastSeenAt;
          return compareCocheIds(a.coche, b.coche);
        });
      const choferes = Object.values(fleetStore.rosterDrivers || {})
        .filter((d) => d.codigoLinea === codLinea && (d.lastSeenAt || 0) >= minTs)
        .map((d) => ({ ...d, vistoHoy: d.lastDayKey === todayKey }))
        .sort((a, b) => {
          if (a.vistoHoy !== b.vistoHoy) return a.vistoHoy ? -1 : 1;
          if (b.lastSeenAt !== a.lastSeenAt) return b.lastSeenAt - a.lastSeenAt;
          return a.choferNombre.localeCompare(b.choferNombre, 'es');
        });
      return sendJson(res, 200, {
        data: {
          codigoLinea: codLinea,
          descripcionLinea: LINE_NAMES_BY_CODE[codLinea] || `L${codLinea}`,
          dayKey: todayKey,
          retentionDays: ROSTER_RETENTION_DAYS,
          meta: {
            lastCronAt: fleetStore.rosterMeta?.lastCronAt || null,
            lastCycleAt: fleetStore.rosterMeta?.lastCycleAt || null,
            totalSweeps: fleetStore.rosterMeta?.totalSweeps || 0,
            lastBatchUnits: fleetStore.rosterMeta?.lastBatchUnits || 0,
            scanIntervalMin: BG_SCAN_INTERVAL_MIN,
            fullCycleMin: BG_FULL_CYCLE_MIN,
            retentionDays: ROSTER_RETENTION_DAYS
          },
          coches,
          choferes
        },
        source: 'fleet-memory-disk',
        savedAt: nowMs
      });
    }

    if (pathname === '/api/flota-activa' && req.method === 'GET') {
      const nowMs = Date.now();
      const todayKey = getArgentinaDayKey(nowMs);
      const activeCutoff = nowMs - 38 * 60 * 1000;
      const units = [];
      for (const u of Object.values(fleetStore.units || {})) {
        const cod = Number(u.codigoLinea);
        if (!cod || REMOVED_LINE_CODES.has(cod)) continue;
        if (u.dayKey && u.dayKey !== todayKey) continue;
        if ((u.updatedAt || 0) < activeCutoff) continue;
        const lat = Number(u.lat);
        const lng = Number(u.lng);
        if (!Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0)) continue;
        units.push({
          codigoLinea: cod,
          descripcionLinea: LINE_NAMES_BY_CODE[cod] || u.descripcionLinea || `L${cod}`,
          coche: u.coche,
          choferNombre: u.choferNombre || '',
          choferLegajo: u.choferLegajo || '',
          esAdaptado: Boolean(u.esAdaptado),
          bandera: u.bandera || '',
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
      return sendJson(res, 200, {
        data: { dayKey: todayKey, activeWindowMin: 38, units },
        source: 'fleet-memory-disk',
        savedAt: nowMs
      });
    }

    if (pathname === '/api/flota-buscar' && req.method === 'GET') {
      const nowMs = Date.now();
      const todayKey = getArgentinaDayKey(nowMs);
      const activeCutoff = nowMs - 38 * 60 * 1000;
      const q = String(searchParams.get('q') || '').trim().toUpperCase();
      const results = [];
      if (q.length >= 2) {
        for (const r of Object.values(fleetStore.rosterCars || {})) {
          const cod = Number(r.codigoLinea);
          if (!cod || REMOVED_LINE_CODES.has(cod)) continue;
          const desc = LINE_NAMES_BY_CODE[cod] || r.descripcionLinea || `L${cod}`;
          if (`${r.coche} ${desc}`.toUpperCase().includes(q)) {
            results.push({
              type: 'coche',
              codigoLinea: cod,
              descripcionLinea: desc,
              coche: r.coche,
              choferNombre: r.lastChoferNombre || '',
              choferLegajo: r.lastChoferLegajo || '',
              esAdaptado: Boolean(r.esAdaptado),
              enLineaAhora: r.lastDayKey === todayKey && (r.lastSeenAt || 0) >= activeCutoff,
              lastBandera: r.lastBandera || '',
              lastGps: r.lastGps || '',
              lastStopId: r.lastStopId || '',
              lastLat: r.lastLat ?? null,
              lastLng: r.lastLng ?? null,
              lastDesvioSec: r.lastDesvioSec || 0,
              lastDesvioRaw: r.lastDesvioRaw || '',
              lastSeenAt: r.lastSeenAt || 0,
              lastDayKey: r.lastDayKey || todayKey
            });
          }
        }
        for (const d of Object.values(fleetStore.rosterDrivers || {})) {
          const cod = Number(d.codigoLinea);
          if (!cod || REMOVED_LINE_CODES.has(cod)) continue;
          const desc = LINE_NAMES_BY_CODE[cod] || d.descripcionLinea || `L${cod}`;
          if (`${d.choferNombre} ${d.choferLegajo || ''}`.toUpperCase().includes(q)) {
            results.push({
              type: 'chofer',
              codigoLinea: cod,
              descripcionLinea: desc,
              coche: d.lastCoche || '',
              choferNombre: d.choferNombre || '',
              choferLegajo: d.choferLegajo || '',
              esAdaptado: Boolean(d.lastEsAdaptado),
              enLineaAhora: d.lastDayKey === todayKey && (d.lastSeenAt || 0) >= activeCutoff,
              lastBandera: d.lastBandera || '',
              lastGps: d.lastGps || '',
              lastStopId: d.lastStopId || '',
              lastLat: d.lastLat ?? null,
              lastLng: d.lastLng ?? null,
              lastDesvioSec: d.lastDesvioSec || 0,
              lastDesvioRaw: d.lastDesvioRaw || '',
              lastSeenAt: d.lastSeenAt || 0,
              lastDayKey: d.lastDayKey || todayKey
            });
          }
        }
      }
      return sendJson(res, 200, {
        data: { dayKey: todayKey, results: results.slice(0, 30) },
        source: 'fleet-memory-disk',
        savedAt: nowMs
      });
    }

    if (pathname === '/api/horarios-live' && req.method === 'GET') {
      const nowMs = Date.now();
      return sendJson(res, 200, {
        data: { days: {}, meta: { updatedAt: nowMs } },
        source: 'fleet-memory-disk',
        savedAt: nowMs
      });
    }

    if (pathname === '/api/offline-bundle' && req.method === 'GET') {
      const nowMs = Date.now();
      const todayKey = getArgentinaDayKey(nowMs);
      const activeCutoff = nowMs - 38 * 60 * 1000;
      const cars = Object.values(fleetStore.rosterCars || {}).filter((c) => !REMOVED_LINE_CODES.has(Number(c.codigoLinea)));
      const drivers = Object.values(fleetStore.rosterDrivers || {}).filter((d) => !REMOVED_LINE_CODES.has(Number(d.codigoLinea)));
      const units = Object.values(fleetStore.units || {}).filter(
        (u) =>
          !REMOVED_LINE_CODES.has(Number(u.codigoLinea)) &&
          (!u.dayKey || u.dayKey === todayKey) &&
          (u.updatedAt || 0) >= activeCutoff
      );
      return sendJson(res, 200, {
        data: {
          dayKey: todayKey,
          retentionDays: ROSTER_RETENTION_DAYS,
          cars,
          drivers,
          units,
          trips: Object.values(fleetStore.trips || {}).filter((t) => !REMOVED_LINE_CODES.has(Number(t.codigoLinea))),
          dayObs: [],
          capacityByLine: {},
          liveHorarios: { days: {}, meta: { updatedAt: nowMs } }
        },
        source: 'fleet-memory-disk',
        savedAt: nowMs
      });
    }

    if (pathname === '/api/fleet-memory' && req.method === 'GET') {
      const rawLineas = searchParams.get('lineas') || searchParams.get('codLinea') || '';
      const filterSet = new Set(
        rawLineas
          .split(',')
          .map((n) => Number(n.trim()))
          .filter((n) => Number.isInteger(n) && n > 0)
      );
      const dayKey = String(searchParams.get('dayKey') || getArgentinaDayKey()).slice(0, 10);
      const nowMs = Date.now();
      const trips = Object.values(fleetStore.trips).filter(
        (t) =>
          (t.dayKey === dayKey || nowMs - (t.updatedAt || 0) < 4 * 3600 * 1000) &&
          (filterSet.size === 0 || filterSet.has(t.codigoLinea))
      );
      const units = Object.values(fleetStore.units).filter(
        (u) => nowMs - (u.updatedAt || 0) < 24 * 3600 * 1000 && (filterSet.size === 0 || filterSet.has(u.codigoLinea))
      );
      const stopIdParam = String(searchParams.get('idParada') || '').trim().toUpperCase();
      const stopSnapshot = stopIdParam && fleetStore.stops ? fleetStore.stops[stopIdParam] || null : null;
      return sendJson(res, 200, {
        data: { dayKey, stopSnapshot, trips, units },
        source: 'fleet-memory-disk',
        savedAt: nowMs
      });
    }

    if (pathname === '/api/fleet-seen' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const entries = Array.isArray(body.entries) ? body.entries.slice(0, 60) : [];
      const dayKey = String(body.dayKey || getArgentinaDayKey()).slice(0, 10);
      const count = recordFleetTripsLocal(entries, dayKey, body.codigoLinea);
      return sendJson(res, 200, { ok: true, count, dayKey, storage: 'disk-json' });
    }

    if (pathname === '/api/bootstrap') {
      const lineasRes = await smartmove.getLineas();
      return sendJson(res, 200, {
        pilotStop: PILOT_STOP,
        quickStops: QUICK_STOPS,
        hubs: CORRIENTES_HUBS,
        lineas: lineasRes.data,
        source: lineasRes.source
      });
    }

    if (pathname === '/api/lineas') {
      const result = await smartmove.getLineas();
      return sendJson(res, 200, result);
    }

    if (pathname === '/api/calles') {
      const codLinea = searchParams.get('codLinea');
      if (!codLinea) return sendJson(res, 400, { error: 'Falta el parámetro codLinea' });
      const result = await smartmove.getCalles(codLinea);
      return sendJson(res, 200, result);
    }

    if (pathname === '/api/intersecciones') {
      const codLinea = searchParams.get('codLinea');
      const codCalle = searchParams.get('codCalle');
      if (!codLinea || !codCalle) {
        return sendJson(res, 400, { error: 'Faltan parámetros codLinea o codCalle' });
      }
      const result = await smartmove.getIntersecciones(codLinea, codCalle);
      return sendJson(res, 200, result);
    }

    if (pathname === '/api/paradas') {
      const codLinea = searchParams.get('codLinea');
      const codCalle = searchParams.get('codCalle');
      const codInterseccion = searchParams.get('codInterseccion');
      if (!codLinea || !codCalle || !codInterseccion) {
        return sendJson(res, 400, { error: 'Faltan parámetros codLinea, codCalle o codInterseccion' });
      }
      const result = await smartmove.getParadas(codLinea, codCalle, codInterseccion);
      return sendJson(res, 200, result);
    }

    if (pathname === '/api/paradas-cercanas') {
      const lat = searchParams.get('lat');
      const lng = searchParams.get('lng');
      if (!lat || !lng) {
        return sendJson(res, 400, { error: 'Faltan coordenadas lat y lng' });
      }
      const result = await smartmove.getParadasCercanas(lat, lng);
      return sendJson(res, 200, result);
    }

    if (pathname === '/api/recorridos') {
      const codLinea = searchParams.get('codLinea');
      if (!codLinea) return sendJson(res, 400, { error: 'Falta el parámetro codLinea' });
      const result = await smartmove.getRecorridos(codLinea);
      return sendJson(res, 200, result);
    }

    if (pathname === '/api/banderas') {
      const idParada = searchParams.get('idParada') || PILOT_STOP.id;
      const result = await smartmove.getBanderasParada(idParada);
      return sendJson(res, 200, result);
    }

    if (pathname === '/api/horarios') {
      const idParada = searchParams.get('idParada');
      const codLinea = searchParams.get('codLinea');
      const tipoDia = searchParams.get('tipoDia') || 'auto';
      if (!idParada || !codLinea) {
        return sendJson(res, 400, { error: 'Faltan parámetros idParada o codLinea' });
      }
      const result = await smartmove.getHorariosProgramados(idParada, codLinea, tipoDia);
      return sendJson(res, 200, result);
    }

    if (pathname === '/api/arribos-linea') {
      const idParada = searchParams.get('idParada');
      const codLinea = searchParams.get('codLinea');
      if (!idParada || !codLinea) {
        return sendJson(res, 400, { error: 'Faltan parámetros idParada o codLinea' });
      }
      const result = await smartmove.getArribosLineaCompleto(idParada, codLinea);
      const units = result?.data?.corridorFleet?.length ? result.data.corridorFleet : result?.data?.arribos;
      recordFleetUnitsLocal(units, idParada, result?.data?.stopCoords);
      return sendJson(res, 200, result);
    }

    if (pathname === '/api/arribos') {
      const idParada = searchParams.get('idParada') || PILOT_STOP.id;
      const codLinea = searchParams.get('codLinea') || '000';
      const simulate = searchParams.get('simulate') === '1';
      const result = await smartmove.getArribos(idParada, codLinea, simulate);
      const units = result?.data?.corridorFleet?.length ? result.data.corridorFleet : result?.data?.arribos;
      recordFleetUnitsLocal(units, idParada, result?.data?.stopCoords);
      return sendJson(res, 200, result);
    }

    return sendJson(res, 404, { error: 'Endpoint no encontrado' });
  } catch (err) {
    const status = err.status === 429 ? 429 : 502;
    return sendJson(res, status, {
      error:
        err.status === 429
          ? 'SmartMovePro limitó temporalmente las consultas. Reintentá en unos segundos.'
          : 'No se pudo conectar con SmartMovePro Corrientes.',
      code: err.message
    });
  }
}

const server = http.createServer((req, res) => {
  const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end();
    return;
  }

  if (urlObj.pathname.startsWith('/api/')) {
    handleApi(req, res, urlObj);
    return;
  }

  serveStatic(req, res, urlObj.pathname);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`DIRECT GPS · Corrientes activo en http://localhost:${PORT}`);
  if (process.env.DISABLE_BG_FLEET_SCAN !== '1') {
    setTimeout(() => runLocalFleetScanBatch().catch(() => {}), 8000).unref();
    setInterval(() => runLocalFleetScanBatch().catch(() => {}), BG_SCAN_INTERVAL_MIN * 60 * 1000).unref();
  }
});
