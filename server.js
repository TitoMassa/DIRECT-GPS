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

function getArgentinaDayKey(nowMs = Date.now()) {
  const d = new Date(nowMs - 3 * 3600 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function parseDesvioSeconds(raw = '') {
  const clean = String(raw || '').replace(/\s+/g, '');
  const m = clean.match(/^([+-])(\d{1,2}):(\d{2})$/);
  if (!m) return 0;
  return (m[1] === '+' ? 1 : -1) * (parseInt(m[2], 10) * 60 + parseInt(m[3], 10));
}

function loadFleetStore() {
  try {
    const parsed = JSON.parse(fs.readFileSync(FLEET_STORE_FILE, 'utf8'));
    return { trips: parsed.trips || {}, units: parsed.units || {} };
  } catch {
    return { trips: {}, units: {} };
  }
}

const fleetStore = loadFleetStore();
let fleetSaveTimer = null;

function scheduleFleetStoreSave() {
  if (fleetSaveTimer) return;
  fleetSaveTimer = setTimeout(() => {
    fleetSaveTimer = null;
    try {
      const cutoffTrips = Date.now() - 4 * 86400 * 1000;
      const cutoffUnits = Date.now() - 14 * 86400 * 1000;
      for (const [k, v] of Object.entries(fleetStore.trips)) {
        if ((v.updatedAt || 0) < cutoffTrips) delete fleetStore.trips[k];
      }
      for (const [k, v] of Object.entries(fleetStore.units)) {
        if ((v.updatedAt || 0) < cutoffUnits) delete fleetStore.units[k];
      }
      fs.mkdirSync(path.dirname(FLEET_STORE_FILE), { recursive: true });
      fs.writeFileSync(FLEET_STORE_FILE, JSON.stringify(fleetStore));
    } catch {
      // Ignore disk write errors
    }
  }, 1500);
}

function recordFleetUnitsLocal(arribos = [], stopId = '') {
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
    fleetStore.units[key] = {
      codigoLinea: cod,
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
    fleetStore.units[`${cod}:${coche}`] = { ...rec, bandera: String(e.bandera || '').trim() };
    count++;
  }
  if (count > 0) scheduleFleetStoreSave();
  return count;
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
        version: '2.0',
        service: 'DIRECT GPS · Corrientes',
        fleetMemory: 'disk-json',
        timestamp: Date.now()
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
        (t) => t.dayKey === dayKey && (filterSet.size === 0 || filterSet.has(t.codigoLinea))
      );
      const units = Object.values(fleetStore.units).filter(
        (u) => nowMs - (u.updatedAt || 0) < 24 * 3600 * 1000 && (filterSet.size === 0 || filterSet.has(u.codigoLinea))
      );
      return sendJson(res, 200, { data: { dayKey, trips, units }, source: 'fleet-memory-disk', savedAt: nowMs });
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
      recordFleetUnitsLocal(result?.data?.arribos, idParada);
      return sendJson(res, 200, result);
    }

    if (pathname === '/api/arribos') {
      const idParada = searchParams.get('idParada') || PILOT_STOP.id;
      const codLinea = searchParams.get('codLinea') || '000';
      const simulate = searchParams.get('simulate') === '1';
      const result = await smartmove.getArribos(idParada, codLinea, simulate);
      recordFleetUnitsLocal(result?.data?.arribos, idParada);
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
});
