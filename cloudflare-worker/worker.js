// DIRECT GPS · Corrientes — Cloudflare Worker SOAP Proxy (100% gratis, 0ms cold start)
// Desplegalo en Cloudflare Workers (Dashboard -> Workers & Pages -> Create Worker -> pegar este código)
// o conectando el repositorio GitHub TitoMassa/DIRECT-GPS (directorio raíz: cloudflare-worker).

const SOAP_ENDPOINT = 'http://clsw.smartmovepro.net/ModuloParadas/SWParadas.asmx';
const SOAP_NS = 'http://clsw.smartmovepro.net/';
const SOAP_USER = 'WEB.UPLATENSE';
const SOAP_PASS = 'PAR.SW.UPLATENSE';
const SOAP_APP_CODE = 24;
const SOAP_LOCALIDAD = 'CONTINENTAL';
const CORRIENTES_EMPRESAS = '358;666;266';

const PILOT_STOP = {
  id: 'CT31498',
  codigo: '20129',
  nombre: 'AV. PEDRO FERRÉ - BRASIL IDA',
  nombreCorto: 'Av. Ferré y Brasil (Ida)',
  callePrincipal: 'AVENIDA PEDRO FERRÉ',
  calleInterseccion: 'BRASIL',
  lat: -27.476965,
  lng: -58.825184,
  lineas: ['102A', '102B', '102C', '106A', '106B', '106C', '904A'],
  esPiloto: true
};

const QUICK_STOPS = [
  PILOT_STOP,
  {
    id: 'CT31942',
    codigo: '21770',
    nombre: 'AV. PEDRO FERRÉ - BRASIL VTA',
    callePrincipal: 'AVENIDA PEDRO FERRÉ',
    calleInterseccion: 'BRASIL',
    lat: -27.477427,
    lng: -58.824951,
    lineas: ['102B', '102C', '106A', '106B', '106C']
  },
  {
    id: 'CT31941',
    codigo: '21769',
    nombre: 'AV. PEDRO FERRÉ - PARAGUAY VTA',
    callePrincipal: 'AVENIDA PEDRO FERRÉ',
    calleInterseccion: 'PARAGUAY',
    lat: -27.477142,
    lng: -58.827352,
    lineas: ['102B', '102C', '106A', '106B', '106C']
  },
  {
    id: 'CT31581',
    codigo: '20145',
    nombre: '9 DE JULIO - CÓRDOBA',
    callePrincipal: '9 DE JULIO',
    calleInterseccion: 'CÓRDOBA',
    lat: -27.46858,
    lng: -58.83424,
    lineas: ['102B', '103A', '104A', '105A']
  }
];

const CORRIENTES_HUBS = [
  { name: 'Av. Ferré y Brasil (Piloto)', lat: -27.476965, lng: -58.825184, stopId: 'CT31498' },
  { name: 'Plaza 25 de Mayo / Centro', lat: -27.46485, lng: -58.83962 },
  { name: 'Puerto de Corrientes', lat: -27.46221, lng: -58.84274 },
  { name: 'Terminal de Ómnibus', lat: -27.48881, lng: -58.81722 },
  { name: 'Campus Deodoro Roca (UNNE)', lat: -27.46664, lng: -58.78241 },
  { name: 'Hospital Escuela', lat: -27.47582, lng: -58.83461 }
];

// Central Fleet & Driver Roster configuration (rolling 7-day retention + daily 03:00 ART view)
const ROSTER_RETENTION_DAYS = 7;
const ROSTER_RETENTION_MS = ROSTER_RETENTION_DAYS * 86400 * 1000;
const CRON_SCAN_INTERVAL_MIN = 5;
const CRON_BATCH_SIZE = 18; // <= 18 SOAP + 2 DO = 20 subrequests/tick (Cloudflare Free limit: 50)
const CRON_CONCURRENCY = 3; // Gentle waves to stay well under SmartMovePro rate limits

const REMOVED_LINE_CODES = new Set([517, 607, 608, 744, 851, 853, 854]);
const REMOVED_LINE_SQL_LIST = '517, 607, 608, 744, 851, 853, 854';
const LINE_NAME_OVERRIDES = {
  433: '103D',
  705: '109C',
  852: '902'
};

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

function resolvePublicLineName(cod, fallback = '') {
  const n = Number(cod);
  if (LINE_NAME_OVERRIDES[n]) return LINE_NAME_OVERRIDES[n];
  return String(fallback || LINE_NAMES_BY_CODE[n] || '').trim() || (n ? `L${n}` : '');
}

// Strategic downstream (~85% along each Ida & Vuelta branch) + 6 multi-line city hub probes (cod=0 -> '000').
const FLEET_SCAN_TARGETS = [
  [94, 'CT31939'], [94, 'CT31409'],
  [97, 'CT31507'], [97, 'CT31254'],
  [96, 'CT31210'], [96, 'CT32204'],
  [132, 'CT31507'], [132, 'CT31572V'],
  [133, 'CT31766'], [133, 'CT32257'],
  [134, 'CT31764'], [134, 'CT32257'],
  [433, 'CT31373'], [433, 'RCH010'],
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
  [852, 'CH490'], [852, 'CH455'], [852, 'CH430'],
  [1037, 'CT31648'], [1037, 'CH326'],
  [1038, 'L9041075'], [1038, 'L9041098'],
  [1039, 'L9041057'], [1039, 'CT31212'],
  [705, 'CT31392B'], [705, 'CT31363'],
  [0, 'CT31180'], [0, 'CT31181'], [0, 'CT31498'], [0, 'CT31942'], [0, 'CT31581'], [0, 'CT31350']
];
const CRON_FULL_CYCLE_MIN = Math.ceil(FLEET_SCAN_TARGETS.length / CRON_BATCH_SIZE) * CRON_SCAN_INTERVAL_MIN;

// Continuous automatic SOAP timetable scanner (every 10 min across all 25 scheduled lines,
// plus full-day lookahead across all 53 unique branch anchor stops; past times are NEVER deleted).
// Tuple: [codigoLinea, stopId, isPrimary]
const HORARIOS_ANCHOR_STOPS = [
  [94, 'CT31217', 1], [94, 'CT31181', 0],
  [96, 'CT315075', 1], [96, 'CT302', 0],
  [97, 'CT31154', 1], [97, 'CT31181', 0],
  [113, 'CT31448', 1], [113, 'CT31529', 0], [113, 'CT1398', 0],
  [114, 'CT31211', 1], [114, 'CT31172', 0],
  [115, 'CT31573', 1], [115, 'CT31193', 0],
  [118, 'CT31210', 1], [118, 'CT1398', 0],
  [132, 'CT31282', 1], [132, 'CT1398', 0],
  [133, 'CT32255', 1], [133, 'CT1398V', 0],
  [134, 'CT32246', 1], [134, 'CT32031', 0], [134, 'CT31944', 0],
  [342, 'CT31211', 1], [342, 'CT13988V', 0],
  [346, 'CT31436', 1], [346, 'CT31181', 0],
  [347, 'CT31982', 1], [347, 'CT1398', 0],
  [348, 'CT31172', 1], [348, 'CT1398', 0],
  [350, 'CT31885', 1], [350, 'CT31181', 0],
  [351, 'CT314422', 1], [351, 'CT31181', 0],
  [352, 'CT32217', 1], [352, 'CT302', 0],
  [353, 'CT31350', 1], [353, 'CT13988V', 0], [353, 'CT31171A', 0],
  [356, 'CT31134', 1], [356, 'CT31187', 0],
  [357, 'CT31134', 1], [357, 'CT311642', 0],
  [433, 'RCH001', 1], [433, 'CT31181', 0],
  [705, 'CT31292 VTA', 1], [705, 'CT13988V', 0],
  [1037, 'CH485', 1], [1037, 'L9041001', 0],
  [1038, 'CT131640', 1], [1038, 'CT224', 0],
  [1039, 'CT131640', 1], [1039, 'CH115', 0]
];
const HORARIOS_PRIMARY_STOPS = HORARIOS_ANCHOR_STOPS.filter((a) => a[2] === 1);
const HORARIOS_LIVE_INTERVAL_MIN = 10;
const HORARIOS_DAY_SOAP_BUDGET = 22; // +20 fleet +2 DO = 44 <= 50 CF Free limit
const HORARIOS_NIGHT_SOAP_BUDGET = 40; // fleet scan sleeps 01:30-04:30 ART -> 42 <= 50
const HORARIOS_SCAN_CONCURRENCY = 4;
const HORARIOS_WINDOW_ORDER = [8, 10, 12, 6, 14, 16, 18, 20, 4, 22, 0, 2];
const HORARIOS_EMPTY_MSG_RE = /no se encuentran horarios/i;

function shiftCalendarDayIso(dayIso, deltaDays) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dayIso || ''));
  if (!m) return dayIso;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + Number(deltaDays || 0)));
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function getArgentinaCalendarDayIso(nowMs = Date.now()) {
  const art = new Date(nowMs - 3 * 3600 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${art.getUTCFullYear()}-${pad(art.getUTCMonth() + 1)}-${pad(art.getUTCDate())}`;
}

function formatArtIsoDateTime(artMs) {
  const d = new Date(artMs);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

/**
 * Parses SmartMovePro HoraPaso ("DD/MM/YYYY HH:MM:SS" or "YYYY-MM-DD HH:MM:SS") into
 * { dayKey (03:00 ART service day), horaPaso ('HH:MM:SS') }.
 */
function parseSoapHoraPasoToServiceEntry(raw = '', fallbackDateIso = '') {
  const clean = String(raw || '').trim();
  if (!clean) return null;
  let calDate = fallbackDateIso;
  let hh = 0;
  let mm = 0;
  let ss = 0;
  const dmY = clean.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (dmY) {
    calDate = `${dmY[3]}-${String(dmY[2]).padStart(2, '0')}-${String(dmY[1]).padStart(2, '0')}`;
    hh = parseInt(dmY[4], 10);
    mm = parseInt(dmY[5], 10);
    ss = parseInt(dmY[6] || '0', 10);
  } else {
    const iso = clean.match(/^(\d{4})-(\d{2})-(\d{2})[T\s]+(\d{2}):(\d{2})(?::(\d{2}))?/);
    if (iso) {
      calDate = `${iso[1]}-${iso[2]}-${iso[3]}`;
      hh = parseInt(iso[4], 10);
      mm = parseInt(iso[5], 10);
      ss = parseInt(iso[6] || '0', 10);
    } else {
      const hm = clean.match(/(\d{2}):(\d{2})(?::(\d{2}))?/);
      if (!hm || !calDate) return null;
      hh = parseInt(hm[1], 10);
      mm = parseInt(hm[2], 10);
      ss = parseInt(hm[3] || '0', 10);
    }
  }
  if (!calDate || hh > 23 || mm > 59 || ss > 59) return null;
  const pad = (n) => String(n).padStart(2, '0');
  const dayKey = hh < 3 ? shiftCalendarDayIso(calDate, -1) : calDate;
  return {
    dayKey,
    horaPaso: `${pad(hh)}:${pad(mm)}:${pad(ss)}`
  };
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept'
};

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...CORS_HEADERS
    }
  });
}

function escapeXml(val) {
  return String(val ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function unescapeXml(str) {
  return String(str ?? '')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function parseChofer(raw = '') {
  const clean = String(raw || '').trim();
  if (!clean) return { choferNombre: '', choferLegajo: '', choferRaw: '' };
  const m = clean.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
  if (m) return { choferNombre: m[1].trim(), choferLegajo: m[2].trim(), choferRaw: clean };
  return { choferNombre: clean, choferLegajo: '', choferRaw: clean };
}

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
    const parsed = parseChofer(raw);
    nombre = parsed.choferNombre;
    legajo = parsed.choferLegajo;
  }
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

function resolveObservationTime(ultimaGps, nowMs) {
  const gpsMs = parseGpsStampMs(ultimaGps);
  // If SmartMovePro returns a frozen GPS fix older than 18 hours, credit it to its actual GPS timestamp
  if (gpsMs > 0 && nowMs - gpsMs > 18 * 3600 * 1000 && gpsMs <= nowMs + 600000) {
    return { obsMs: gpsMs, obsDayKey: getArgentinaDayKey(gpsMs) };
  }
  return { obsMs: nowMs, obsDayKey: getArgentinaDayKey(nowMs) };
}

function compareCocheIds(a, b) {
  const na = Number(String(a || '').replace(/\D+/g, ''));
  const nb = Number(String(b || '').replace(/\D+/g, ''));
  if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
  return String(a || '').localeCompare(String(b || ''));
}

// Isolate-level caches to make parallel corridor radar probes ultra-fast & SmartMovePro rate-limit safe
const LINE_STOPS_CACHE = new Map(); // lineNum -> { ts, branches }
const PROBE_ARRIBOS_CACHE = new Map(); // `${stopId}:${lineCode}` -> { ts, arribos }
const LINE_STOPS_TTL_MS = 6 * 3600 * 1000;
const PROBE_ARRIBOS_TTL_MS = 18 * 1000;

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

/**
 * Picks up to 8 strategically spaced probe stops across 3 corridor zones (without hitting
 * Cloudflare's 50-subrequest limit or SmartMovePro's 429 rate limit):
 *  - downstream (up to 3 stops AFTER stopId up to terminal): instantly spots early-passed buses!
 *  - upstream (up to 3 stops BEFORE stopId): discovers full approaching fleet & cabecera pull-outs!
 *  - opposite (up to 2 stops on return branch): tracks buses approaching turnaround for next trip!
 */
function selectStrategicCorridorProbes(branches = [], stopId = '', { maxDown = 3, maxUp = 3, maxOpp = 2 } = {}) {
  const stopBranches = branches.filter((arr) =>
    arr.some((p) => String(p.Identificador || '').toUpperCase() === stopId)
  );
  const primaryBranch = stopBranches[0] || branches[0] || [];
  const oppBranch = branches.find((arr) => !stopBranches.includes(arr) && arr.length >= 5) || [];
  const idx = primaryBranch.findIndex((p) => String(p.Identificador || '').toUpperCase() === stopId);

  const probes = [];
  const seen = new Set([stopId]);
  const pushStop = (st, zone) => {
    const id = String(st?.Identificador || '').trim().toUpperCase();
    if (!id || seen.has(id)) return;
    seen.add(id);
    probes.push({ stopId: id, zone });
  };

  if (idx >= 0) {
    // 1) Downstream (paradas siguientes en el mismo sentido, incluyendo la última parada del ramal)
    const after = primaryBranch.slice(idx + 1);
    if (after.length > 0 && maxDown > 0) {
      if (after.length <= maxDown) {
        for (const st of after) pushStop(st, 'downstream');
      } else if (maxDown === 1) {
        pushStop(after[Math.min(after.length - 1, Math.max(4, Math.floor(after.length * 0.45)))], 'downstream');
      } else {
        const fracs = maxDown === 2 ? [0.4, 1.0] : [0.3, 0.7, 1.0];
        for (const f of fracs) {
          const i = Math.min(after.length - 1, Math.max(0, Math.round(f * (after.length - 1))));
          pushStop(after[i], 'downstream');
        }
      }
    }

    // Also include final stop of any secondary branch sharing `stopId` (e.g. 104A, 105C diverging legs)
    if (stopBranches.length > 1 && maxDown >= 2) {
      for (let b = 1; b < stopBranches.length && probes.filter((p) => p.zone === 'downstream').length < maxDown + 1; b++) {
        const sec = stopBranches[b];
        const sIdx = sec.findIndex((p) => String(p.Identificador || '').toUpperCase() === stopId);
        if (sIdx >= 0 && sec.length - 1 > sIdx) {
          pushStop(sec[sec.length - 1], 'downstream');
        }
      }
    }

    // 2) Upstream (paradas anteriores en el mismo sentido)
    const before = primaryBranch.slice(0, idx);
    if (before.length > 0 && maxUp > 0) {
      if (before.length <= maxUp) {
        for (const st of before) pushStop(st, 'upstream');
      } else if (maxUp === 1) {
        pushStop(before[Math.max(0, before.length - Math.min(before.length, 6))], 'upstream');
      } else {
        const fracs = maxUp === 2 ? [0.3, 0.75] : [0.2, 0.55, 0.85];
        for (const f of fracs) {
          const i = Math.min(before.length - 1, Math.max(0, Math.round(f * (before.length - 1))));
          pushStop(before[i], 'upstream');
        }
      }
    }
  }

  // 3) Opposite return branch (colectivos acercándose a la cabecera de giro)
  if (oppBranch.length >= 5 && maxOpp > 0) {
    const fracs = maxOpp === 1 ? [0.85] : [0.5, 0.92];
    for (const f of fracs) {
      const i = Math.min(oppBranch.length - 1, Math.max(0, Math.round(f * (oppBranch.length - 1))));
      pushStop(oppBranch[i], 'opposite');
    }
  }

  return probes;
}

/**
 * Merges every unique live bus seen across base + upstream/downstream/opposite corridor probes,
 * retaining the freshest GPS fix per `(codigoLinea, identificadorCoche)`.
 */
function buildCorridorFleet(baseArribos = [], probeResults = []) {
  const byUnit = new Map();
  const ingest = (list, zone) => {
    for (const a of list || []) {
      const cod = Number(a.codigoLinea) || 0;
      const coche = String(a.identificadorCoche || '').trim();
      const lat = parseFloat(a.latitud);
      const lng = parseFloat(a.longitud);
      if (!cod || !coche || Number.isNaN(lat) || Number.isNaN(lng) || (lat === 0 && lng === 0)) continue;
      const uKey = `${cod}:${coche}`;
      const stampMs = parseGpsStampMs(a.ultimaFechaHoraGPS);
      const prev = byUnit.get(uKey);
      if (!prev || stampMs > prev._stampMs || (stampMs === prev._stampMs && prev.probeZone === 'opposite' && zone !== 'opposite')) {
        byUnit.set(uKey, {
          codigoLinea: cod,
          descripcionLinea: a.descripcionLinea || '',
          identificadorCoche: coche,
          identificadorChofer: a.identificadorChofer || '',
          choferNombre: a.choferNombre || '',
          choferLegajo: a.choferLegajo || '',
          esAdaptado: Boolean(a.esAdaptado),
          descripcionBandera: a.descripcionBandera || '',
          latitud: String(lat),
          longitud: String(lng),
          desvioHorario: a.desvioHorario || '',
          ultimaFechaHoraGPS: a.ultimaFechaHoraGPS || '',
          probeZone: zone,
          _stampMs: stampMs
        });
      }
    }
  };
  ingest(baseArribos, 'base');
  for (const pr of probeResults) {
    ingest(pr.arribos, pr.zone || 'corridor');
  }
  return Array.from(byUnit.values()).map(({ _stampMs, ...clean }) => clean);
}

async function soapRequest(method, bodyInnerXml) {
  const envelope = `<?xml version="1.0" encoding="utf-8"?>
<v:Envelope xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns:d="http://www.w3.org/2001/XMLSchema" xmlns:c="http://schemas.xmlsoap.org/soap/encoding/" xmlns:v="http://schemas.xmlsoap.org/soap/envelope/">
  <v:Header />
  <v:Body>
    <${method} xmlns="${SOAP_NS}" id="o0" c:root="1">
      ${bodyInnerXml}
    </${method}>
  </v:Body>
</v:Envelope>`;

  const res = await fetch(SOAP_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/xml; charset=utf-8',
      SOAPAction: `"${SOAP_NS}${method}"`
    },
    body: envelope
  });

  const xml = await res.text();
  if (!res.ok) throw new Error(`SOAP_HTTP_${res.status}`);

  const match = xml.match(new RegExp(`<${method}Result>([\\s\\S]*?)</${method}Result>`));
  if (!match) throw new Error('SOAP_EMPTY_RESULT');
  return JSON.parse(unescapeXml(match[1]));
}

async function fetchHorariosWindowSoap(stopId, codLinea, desdeIso, hastaIso) {
  const cleanStop = String(stopId || '').trim().toUpperCase();
  const lineNum = Number(codLinea);
  if (!cleanStop || !lineNum || REMOVED_LINE_CODES.has(lineNum)) {
    return { ok: false, empty: true, items: [] };
  }
  const fallbackDate = String(desdeIso || '').slice(0, 10);
  const res = await soapRequest(
    'RecuperarHorariosProgramadosPorLineaParada',
    `<usuario i:type="d:string">${SOAP_USER}</usuario>
     <clave i:type="d:string">${SOAP_PASS}</clave>
     <identificadorParada i:type="d:string">${escapeXml(cleanStop)}</identificadorParada>
     <codigoLineaParada i:type="d:int">${lineNum}</codigoLineaParada>
     <fechaHoraDesde i:type="d:dateTime">${escapeXml(desdeIso)}</fechaHoraDesde>
     <fechaHoraHasta i:type="d:dateTime">${escapeXml(hastaIso)}</fechaHoraHasta>`
  );
  const list = Array.isArray(res?.HorariossProgramados)
    ? res.HorariossProgramados
    : Array.isArray(res?.HorariosProgramados)
      ? res.HorariosProgramados
      : null;
  if (!list) {
    if (Number(res?.CodigoEstado) === -1 && HORARIOS_EMPTY_MSG_RE.test(String(res?.MensajeEstado || ''))) {
      return { ok: true, empty: true, items: [] };
    }
    return { ok: false, empty: false, items: [] };
  }
  const seen = new Set();
  const items = [];
  for (const it of list) {
    const parsed = parseSoapHoraPasoToServiceEntry(it?.HoraPaso, fallbackDate);
    if (!parsed) continue;
    const bandera = String(it?.DescripcionBandera || '').trim();
    const k = `${parsed.dayKey}|${parsed.horaPaso}|${bandera}`;
    if (seen.has(k)) continue;
    seen.add(k);
    items.push({
      dayKey: parsed.dayKey,
      codigoLinea: lineNum,
      stopId: cleanStop,
      horaPaso: parsed.horaPaso,
      bandera
    });
  }
  return { ok: true, empty: items.length === 0, items };
}

async function getLineas() {
  const res = await soapRequest(
    'RecuperarLineaPorLocalidad',
    `<usuario i:type="d:string">${SOAP_USER}</usuario>
     <clave i:type="d:string">${SOAP_PASS}</clave>
     <localidad i:type="d:string">CORRIENTES</localidad>
     <provincia i:type="d:string">CORRIENTES</provincia>
     <pais i:type="d:string">ARGENTINA</pais>
     <isSublinea i:type="d:boolean">false</isSublinea>`
  );
  const seen = new Set();
  const normalized = [];
  for (const item of res?.lineas || []) {
    const cod = Number(item.CodigoLineaParada);
    if (!cod || REMOVED_LINE_CODES.has(cod) || seen.has(cod)) continue;
    seen.add(cod);
    normalized.push({
      codigo: cod,
      descripcion: resolvePublicLineName(cod, item.Descripcion),
      codigoEntidad: item.CodigoEntidad,
      codigoEmpresa: item.CodigoEmpresa
    });
  }
  return normalized.sort((a, b) => a.descripcion.localeCompare(b.descripcion, 'es', { numeric: true }));
}

async function fetchOneStop(sid, lcode) {
  if (lcode && lcode !== '000' && REMOVED_LINE_CODES.has(Number(lcode))) {
    const known = QUICK_STOPS.find((s) => s.id === sid);
    return {
      arribos: [],
      idParada: sid,
      codLinea: lcode,
      stopCoords: known ? { lat: known.lat, lng: known.lng } : null,
      knownStop: known || null,
      codigoEstado: 0,
      mensajeEstado: ''
    };
  }
  const raw = await soapRequest(
    'RecuperarProximosArribos',
    `<identificadorParada i:type="d:string">${escapeXml(sid)}</identificadorParada>
     <codigoLineaParada i:type="d:int">${escapeXml(lcode)}</codigoLineaParada>
     <codigoAplicacion i:type="d:int">${SOAP_APP_CODE}</codigoAplicacion>
     <localidad i:type="d:string">${escapeXml(SOAP_LOCALIDAD)}</localidad>
     <usuario i:type="d:string">${SOAP_USER}</usuario>
     <clave i:type="d:string">${SOAP_PASS}</clave>`
  );
  const rawArribos = Array.isArray(raw?.arribos) ? raw.arribos : [];
  let sLat = null;
  let sLng = null;
  for (const a of rawArribos) {
    if (a.LatitudParada && a.LongitudParada) {
      sLat = parseFloat(a.LatitudParada);
      sLng = parseFloat(a.LongitudParada);
      break;
    }
  }
  const known = QUICK_STOPS.find((s) => s.id === sid);
  if ((sLat === null || Number.isNaN(sLat)) && known) {
    sLat = known.lat;
    sLng = known.lng;
  }
  const arribos = [];
  for (const a of rawArribos) {
    const cod = Number(a.CodigoLineaParada) || 0;
    if (REMOVED_LINE_CODES.has(cod)) continue;
    const chofer = parseChofer(a.IdentificadorChofer);
    arribos.push({
      codigoLinea: cod,
      tiempoRestanteArribo: String(a.Arribo || '').trim(),
      descripcionLinea: resolvePublicLineName(cod, a.DescripcionLinea),
      descripcionBandera: String(a.DescripcionBandera || '').trim(),
      descripcionCortaBandera: String(a.DescripcionCortaBandera || '').trim(),
      descripcionCartelBandera: String(a.DescripcionCartelBandera || '').trim(),
      esAdaptado: String(a.EsAdaptado || '').toLowerCase() === 'true',
      latitud: String(a.Latitud || ''),
      longitud: String(a.Longitud || ''),
      latitudParada: String(a.LatitudParada || (sLat ?? '')),
      longitudParada: String(a.LongitudParada || (sLng ?? '')),
      esLleno: false,
      identificadorCoche: String(a.IdentificadorCoche || '').trim(),
      identificadorChofer: chofer.choferRaw,
      choferNombre: chofer.choferNombre,
      choferLegajo: chofer.choferLegajo,
      desvioHorario: String(a.DesvioHorario || '').trim(),
      ultimaFechaHoraGPS: String(a.UltimaFechaHoraGPS || '').trim(),
      mensajeError: String(a.MensajeError || '').trim()
    });
  }
  return {
    arribos,
    idParada: sid,
    codLinea: lcode,
    stopCoords: sLat !== null && sLng !== null ? { lat: sLat, lng: sLng } : null,
    knownStop: known || null,
    codigoEstado: raw?.CodigoEstado ?? 0,
    mensaje: raw?.MensajeEstado || null
  };
}

function getArgentinaDayKey(nowMs = Date.now()) {
  // Service day rolls over at 03:00 AM ART (UTC-6 shift) so 05:00 AM starts fresh with zero previous-day cars
  const d = new Date(nowMs - 6 * 3600 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function getArgentinaServiceTipo(nowMs = Date.now()) {
  const d = new Date(nowMs - 6 * 3600 * 1000);
  const dow = d.getUTCDay();
  if (dow === 0) return 'domingo';
  if (dow === 6) return 'sabado';
  return 'habil';
}

const SIMULTANEOUS_ACTIVE_WINDOW_MS = 38 * 60 * 1000; // 38 min covers full 20-min Cron cycle + cabecera layover
const CAPACITY_HISTORY_RETENTION_MS = 28 * 86400 * 1000; // 4 weeks of day-type capacity learning

function parseDesvioSeconds(raw = '') {
  const clean = String(raw || '').replace(/\s+/g, '');
  const m = clean.match(/^([+-])(\d{1,2}):(\d{2})$/);
  if (!m) return 0;
  return (m[1] === '+' ? 1 : -1) * (parseInt(m[2], 10) * 60 + parseInt(m[3], 10));
}

// Persistent SQLite-backed Durable Object (Workers Free tier): stores last-seen online
// vehicle/driver/turn assignments AND the automated central fleet + driver rosters per line.
export class FleetMemory {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.sql = ctx.storage.sql;
    this._ready = false;
  }

  _ensureSchema() {
    if (this._ready) return;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS trip_assignments (
        day_key TEXT NOT NULL,
        codigo_linea INTEGER NOT NULL,
        trip_key TEXT NOT NULL,
        turno_hora TEXT DEFAULT '',
        coche TEXT NOT NULL,
        chofer_nombre TEXT DEFAULT '',
        chofer_legajo TEXT DEFAULT '',
        chofer_raw TEXT DEFAULT '',
        es_adaptado INTEGER DEFAULT 0,
        desvio_sec INTEGER DEFAULT 0,
        desvio_raw TEXT DEFAULT '',
        ultima_gps TEXT DEFAULT '',
        lat REAL,
        lng REAL,
        stop_id TEXT DEFAULT '',
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (day_key, codigo_linea, trip_key)
      );
      CREATE INDEX IF NOT EXISTS idx_trip_day_line ON trip_assignments (day_key, codigo_linea);

      CREATE TABLE IF NOT EXISTS unit_last_seen (
        codigo_linea INTEGER NOT NULL,
        coche TEXT NOT NULL,
        day_key TEXT NOT NULL,
        trip_key TEXT DEFAULT '',
        chofer_nombre TEXT DEFAULT '',
        chofer_legajo TEXT DEFAULT '',
        chofer_raw TEXT DEFAULT '',
        es_adaptado INTEGER DEFAULT 0,
        desvio_sec INTEGER DEFAULT 0,
        desvio_raw TEXT DEFAULT '',
        bandera TEXT DEFAULT '',
        ultima_gps TEXT DEFAULT '',
        lat REAL,
        lng REAL,
        stop_id TEXT DEFAULT '',
        gps_trail TEXT DEFAULT '',
        dir_bandera TEXT DEFAULT '',
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (codigo_linea, coche)
      );
      CREATE INDEX IF NOT EXISTS idx_unit_line ON unit_last_seen (codigo_linea);

      CREATE TABLE IF NOT EXISTS stop_last_arribos (
        stop_id TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS fleet_cars (
        codigo_linea INTEGER NOT NULL,
        coche TEXT NOT NULL,
        descripcion_linea TEXT DEFAULT '',
        es_adaptado INTEGER DEFAULT 0,
        last_chofer_nombre TEXT DEFAULT '',
        last_chofer_legajo TEXT DEFAULT '',
        last_chofer_raw TEXT DEFAULT '',
        last_bandera TEXT DEFAULT '',
        last_gps TEXT DEFAULT '',
        last_stop_id TEXT DEFAULT '',
        first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        last_day_key TEXT NOT NULL,
        seen_count INTEGER DEFAULT 1,
        PRIMARY KEY (codigo_linea, coche)
      );
      CREATE INDEX IF NOT EXISTS idx_fleet_cars_line ON fleet_cars (codigo_linea, last_seen_at DESC);

      CREATE TABLE IF NOT EXISTS fleet_drivers (
        codigo_linea INTEGER NOT NULL,
        driver_key TEXT NOT NULL,
        descripcion_linea TEXT DEFAULT '',
        chofer_nombre TEXT NOT NULL,
        chofer_legajo TEXT DEFAULT '',
        chofer_raw TEXT DEFAULT '',
        last_coche TEXT NOT NULL,
        last_es_adaptado INTEGER DEFAULT 0,
        last_bandera TEXT DEFAULT '',
        last_gps TEXT DEFAULT '',
        last_stop_id TEXT DEFAULT '',
        first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        last_day_key TEXT NOT NULL,
        seen_count INTEGER DEFAULT 1,
        PRIMARY KEY (codigo_linea, driver_key)
      );
      CREATE INDEX IF NOT EXISTS idx_fleet_drivers_line ON fleet_drivers (codigo_linea, last_seen_at DESC);

      CREATE TABLE IF NOT EXISTS fleet_capacity_daily (
        day_key TEXT NOT NULL,
        codigo_linea INTEGER NOT NULL,
        tipo_dia TEXT NOT NULL,
        peak_simultaneous INTEGER DEFAULT 0,
        peak_at INTEGER DEFAULT 0,
        active_now INTEGER DEFAULT 0,
        total_unique_cars INTEGER DEFAULT 0,
        samples_count INTEGER DEFAULT 0,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (day_key, codigo_linea)
      );
      CREATE INDEX IF NOT EXISTS idx_cap_line_tipo ON fleet_capacity_daily (codigo_linea, tipo_dia, updated_at DESC);

      CREATE TABLE IF NOT EXISTS learned_shift_transitions (
        codigo_linea INTEGER NOT NULL,
        tipo_dia TEXT NOT NULL,
        from_trip_key TEXT NOT NULL,
        to_trip_key TEXT NOT NULL,
        same_shift_count INTEGER DEFAULT 0,
        relevo_count INTEGER DEFAULT 0,
        last_coche TEXT DEFAULT '',
        last_chofer TEXT DEFAULT '',
        last_day_key TEXT DEFAULT '',
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (codigo_linea, tipo_dia, from_trip_key, to_trip_key)
      );
      CREATE INDEX IF NOT EXISTS idx_learned_shift_line ON learned_shift_transitions (codigo_linea, tipo_dia);

      CREATE TABLE IF NOT EXISTS fleet_daily_obs (
        day_key TEXT NOT NULL,
        codigo_linea INTEGER NOT NULL,
        coche TEXT NOT NULL,
        driver_key TEXT NOT NULL,
        chofer_nombre TEXT DEFAULT '',
        chofer_legajo TEXT DEFAULT '',
        es_adaptado INTEGER DEFAULT 0,
        last_bandera TEXT DEFAULT '',
        last_gps TEXT DEFAULT '',
        last_stop_id TEXT DEFAULT '',
        last_lat REAL,
        last_lng REAL,
        last_desvio_sec INTEGER DEFAULT 0,
        last_desvio_raw TEXT DEFAULT '',
        last_trip_key TEXT DEFAULT '',
        last_service_num INTEGER DEFAULT 0,
        last_turno_idx INTEGER DEFAULT 0,
        first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        seen_count INTEGER DEFAULT 1,
        PRIMARY KEY (day_key, codigo_linea, coche, driver_key)
      );
      CREATE INDEX IF NOT EXISTS idx_daily_obs_day_line ON fleet_daily_obs (day_key, codigo_linea);

      CREATE TABLE IF NOT EXISTS roster_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS live_horarios_daily (
        day_key TEXT NOT NULL,
        codigo_linea INTEGER NOT NULL,
        stop_id TEXT NOT NULL,
        hora_paso TEXT NOT NULL,
        bandera TEXT NOT NULL DEFAULT '',
        first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        PRIMARY KEY (day_key, codigo_linea, stop_id, hora_paso, bandera)
      );
      CREATE INDEX IF NOT EXISTS idx_live_hor_day_line ON live_horarios_daily (day_key, codigo_linea);

      CREATE TABLE IF NOT EXISTS live_horarios_windows (
        day_key TEXT NOT NULL,
        codigo_linea INTEGER NOT NULL,
        stop_id TEXT NOT NULL,
        window_hour INTEGER NOT NULL,
        items_count INTEGER DEFAULT 0,
        scanned_at INTEGER NOT NULL,
        PRIMARY KEY (day_key, codigo_linea, stop_id, window_hour)
      );
      CREATE INDEX IF NOT EXISTS idx_live_hor_win_day ON live_horarios_windows (day_key, codigo_linea);
    `);

    // Idempotent schema migrations for existing Durable Object instances
    const migrations = [
      "ALTER TABLE unit_last_seen ADD COLUMN gps_trail TEXT DEFAULT ''",
      "ALTER TABLE unit_last_seen ADD COLUMN dir_bandera TEXT DEFAULT ''",
      'ALTER TABLE fleet_cars ADD COLUMN last_lat REAL',
      'ALTER TABLE fleet_cars ADD COLUMN last_lng REAL',
      'ALTER TABLE fleet_cars ADD COLUMN last_desvio_sec INTEGER DEFAULT 0',
      "ALTER TABLE fleet_cars ADD COLUMN last_desvio_raw TEXT DEFAULT ''",
      "ALTER TABLE fleet_cars ADD COLUMN last_trip_key TEXT DEFAULT ''",
      'ALTER TABLE fleet_cars ADD COLUMN last_service_num INTEGER DEFAULT 0',
      'ALTER TABLE fleet_cars ADD COLUMN last_turno_idx INTEGER DEFAULT 0',
      "ALTER TABLE fleet_cars ADD COLUMN last_turno_start TEXT DEFAULT ''",
      "ALTER TABLE fleet_cars ADD COLUMN last_turno_end TEXT DEFAULT ''",
      'ALTER TABLE fleet_cars ADD COLUMN last_lap_num REAL DEFAULT 0',
      'ALTER TABLE fleet_cars ADD COLUMN last_shift_laps REAL DEFAULT 0',
      'ALTER TABLE fleet_drivers ADD COLUMN last_lat REAL',
      'ALTER TABLE fleet_drivers ADD COLUMN last_lng REAL',
      'ALTER TABLE fleet_drivers ADD COLUMN last_desvio_sec INTEGER DEFAULT 0',
      "ALTER TABLE fleet_drivers ADD COLUMN last_desvio_raw TEXT DEFAULT ''",
      "ALTER TABLE fleet_drivers ADD COLUMN last_trip_key TEXT DEFAULT ''",
      'ALTER TABLE fleet_drivers ADD COLUMN last_service_num INTEGER DEFAULT 0',
      'ALTER TABLE fleet_drivers ADD COLUMN last_turno_idx INTEGER DEFAULT 0',
      "ALTER TABLE fleet_drivers ADD COLUMN last_turno_start TEXT DEFAULT ''",
      "ALTER TABLE fleet_drivers ADD COLUMN last_turno_end TEXT DEFAULT ''",
      'ALTER TABLE fleet_drivers ADD COLUMN last_lap_num REAL DEFAULT 0',
      'ALTER TABLE fleet_drivers ADD COLUMN last_shift_laps REAL DEFAULT 0'
    ];
    for (const stmt of migrations) {
      try {
        this.sql.exec(stmt);
      } catch {
        // Column already exists
      }
    }

    // One-time backfill from existing unit_last_seen rows (last 7 days) so production rosters start populated
    try {
      const hasCars = this.sql.exec('SELECT 1 AS ok FROM fleet_cars LIMIT 1').toArray().length > 0;
      if (!hasCars) {
        const nowMs = Date.now();
        const minTs = nowMs - ROSTER_RETENTION_MS;
        const legacy = this.sql
          .exec(
            `SELECT codigo_linea, coche, day_key, chofer_nombre, chofer_legajo, chofer_raw,
                    es_adaptado, bandera, ultima_gps, stop_id, updated_at
             FROM unit_last_seen WHERE updated_at >= ?`,
            minTs
          )
          .toArray();
        for (const row of legacy) {
          this._upsertRosterUnit(
            {
              codigoLinea: row.codigo_linea,
              coche: row.coche,
              descripcionLinea: LINE_NAMES_BY_CODE[row.codigo_linea] || '',
              choferNombre: row.chofer_nombre,
              choferLegajo: row.chofer_legajo,
              choferRaw: row.chofer_raw,
              esAdaptado: Boolean(row.es_adaptado),
              bandera: row.bandera,
              ultimaGps: row.ultima_gps,
              stopId: row.stop_id
            },
            row.updated_at || nowMs,
            row.day_key || getArgentinaDayKey(row.updated_at || nowMs)
          );
        }
      }
    } catch {
      // Non-fatal backfill guard
    }

    // Purge any legacy rows belonging to removed non-working lines and apply permanent renames (852 -> 902, 433 -> 103D, 705 -> 109C)
    try {
      const purgeVer = Number(this._getMeta('removed_lines_purge_v', 0)) || 0;
      if (purgeVer < 2) {
        const tables = [
          'fleet_cars',
          'fleet_drivers',
          'unit_last_seen',
          'trip_assignments',
          'fleet_daily_obs',
          'fleet_capacity_daily',
          'learned_shift_transitions'
        ];
        for (const tbl of tables) {
          this.sql.exec(`DELETE FROM ${tbl} WHERE codigo_linea IN (${REMOVED_LINE_SQL_LIST})`);
        }
        this.sql.exec(`UPDATE fleet_cars SET descripcion_linea = '902' WHERE codigo_linea = 852`);
        this.sql.exec(`UPDATE fleet_cars SET descripcion_linea = '103D' WHERE codigo_linea = 433`);
        this.sql.exec(`UPDATE fleet_cars SET descripcion_linea = '109C' WHERE codigo_linea = 705`);
        this.sql.exec(`UPDATE fleet_drivers SET descripcion_linea = '902' WHERE codigo_linea = 852`);
        this.sql.exec(`UPDATE fleet_drivers SET descripcion_linea = '103D' WHERE codigo_linea = 433`);
        this.sql.exec(`UPDATE fleet_drivers SET descripcion_linea = '109C' WHERE codigo_linea = 705`);
        this._setMeta('removed_lines_purge_v', 2);
      }
    } catch {
      // Non-fatal purge guard
    }

    this._ready = true;
  }

  _parseGpsTrail(rawJson) {
    if (!rawJson) return [];
    try {
      const parsed = JSON.parse(rawJson);
      if (!Array.isArray(parsed)) return [];
      const out = [];
      for (const pt of parsed) {
        const lat = Number(Array.isArray(pt) ? pt[0] : pt?.lat);
        const lng = Number(Array.isArray(pt) ? pt[1] : pt?.lng);
        const gpsMs = Number(Array.isArray(pt) ? pt[2] : pt?.gpsMs) || 0;
        if (Number.isFinite(lat) && Number.isFinite(lng) && (lat !== 0 || lng !== 0)) {
          out.push([lat, lng, gpsMs]);
        }
      }
      return out;
    } catch {
      return [];
    }
  }

  _mergeUnitTrail(cod, coche, incomingTrail, lat, lng, ultimaGps, nowMs) {
    const existingRows = this.sql
      .exec('SELECT gps_trail FROM unit_last_seen WHERE codigo_linea = ? AND coche = ?', cod, coche)
      .toArray();
    const rawList = existingRows.length > 0 ? this._parseGpsTrail(existingRows[0].gps_trail) : [];

    if (Array.isArray(incomingTrail)) {
      for (const pt of incomingTrail) {
        const pLat = Number(Array.isArray(pt) ? pt[0] : pt?.lat);
        const pLng = Number(Array.isArray(pt) ? pt[1] : pt?.lng);
        const pMs = Number(Array.isArray(pt) ? pt[2] : pt?.gpsMs) || 0;
        if (Number.isFinite(pLat) && Number.isFinite(pLng) && (pLat !== 0 || pLng !== 0)) {
          rawList.push([Number(pLat.toFixed(6)), Number(pLng.toFixed(6)), pMs || nowMs]);
        }
      }
    }

    if (Number.isFinite(lat) && Number.isFinite(lng) && (lat !== 0 || lng !== 0)) {
      const obsMs = parseGpsStampMs(ultimaGps) || nowMs;
      rawList.push([Number(lat.toFixed(6)), Number(lng.toFixed(6)), obsMs]);
    }

    if (rawList.length === 0) return '';

    rawList.sort((a, b) => (a[2] || 0) - (b[2] || 0));
    const latestMs = rawList[rawList.length - 1][2] || nowMs;
    const minMs = latestMs - 15 * 60 * 1000;

    // Compact stationary points (< ~10 m) in place so traffic-light waits never flush moving history
    const compacted = [];
    for (const pt of rawList) {
      if (pt[2] && pt[2] < minMs) continue;
      const prev = compacted[compacted.length - 1];
      if (!prev) {
        compacted.push(pt);
        continue;
      }
      const dLat = (pt[0] - prev[0]) * 110850;
      const dLng = (pt[1] - prev[1]) * 111320 * Math.cos((pt[0] * Math.PI) / 180);
      const dist = Math.hypot(dLat, dLng);
      if (dist < 10) {
        if ((pt[2] || 0) >= (prev[2] || 0)) {
          compacted[compacted.length - 1] = [prev[0], prev[1], pt[2] || prev[2]];
        }
      } else {
        compacted.push(pt);
      }
    }

    const trimmed = compacted.slice(-6);
    return trimmed.length > 0 ? JSON.stringify(trimmed) : '';
  }

  _getMeta(key, fallback = null) {
    const rows = this.sql.exec('SELECT value FROM roster_meta WHERE key = ?', key).toArray();
    if (!rows.length) return fallback;
    try {
      return JSON.parse(rows[0].value);
    } catch {
      return rows[0].value;
    }
  }

  _setMeta(key, value) {
    this.sql.exec(
      `INSERT INTO roster_meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      key,
      JSON.stringify(value)
    );
  }

  _getRosterMetaSummary() {
    const lastCronAt = Number(this._getMeta('last_cron_at', 0)) || null;
    const lastLiveAt = Number(this._getMeta('last_live_at', 0)) || lastCronAt || null;
    return {
      lastCronAt,
      lastLiveAt,
      lastCycleAt: Number(this._getMeta('last_cycle_at', 0)) || null,
      totalSweeps: Number(this._getMeta('total_sweeps', 0)) || 0,
      lastBatchUnits: Number(this._getMeta('last_batch_units', 0)) || 0,
      scanIntervalMin: CRON_SCAN_INTERVAL_MIN,
      fullCycleMin: CRON_FULL_CYCLE_MIN,
      retentionDays: ROSTER_RETENTION_DAYS
    };
  }

  _upsertRosterUnit(u, nowMs, explicitDayKey = '') {
    const cod = Number(u.codigoLinea);
    const coche = String(u.coche || u.identificadorCoche || '').trim();
    if (!cod || !coche || REMOVED_LINE_CODES.has(cod)) return;

    const ultimaGps = String(u.ultimaGps || u.ultimaFechaHoraGPS || '').trim();
    const { obsMs, obsDayKey } = resolveObservationTime(ultimaGps, nowMs);
    const effectiveDayKey = explicitDayKey && obsMs === nowMs ? explicitDayKey : obsDayKey;
    if (obsMs < nowMs - ROSTER_RETENTION_MS) return;

    const descLinea = resolvePublicLineName(cod, u.descripcionLinea);
    const bandera = String(u.bandera || u.descripcionBandera || '').trim();
    const stopId = String(u.stopId || '').trim().toUpperCase();
    const esAdaptado = u.esAdaptado ? 1 : 0;
    const rawLat = Number(u.lat ?? u.latitud);
    const rawLng = Number(u.lng ?? u.longitud);
    const lat = Number.isFinite(rawLat) && rawLat !== 0 ? rawLat : null;
    const lng = Number.isFinite(rawLng) && rawLng !== 0 ? rawLng : null;
    const desvioSec = Number.isFinite(Number(u.desvioSec)) ? Math.round(Number(u.desvioSec)) : 0;
    const desvioRaw = String(u.desvioRaw || u.desvioHorario || '').trim();
    const tripKey = String(u.tripKey || '').trim();
    const serviceNum = Number(u.serviceNumber) > 0 ? Math.round(Number(u.serviceNumber)) : 0;
    const turnoIdx = Number(u.turnoIndex) > 0 ? Math.round(Number(u.turnoIndex)) : 0;
    const turnoStart = String(u.turnoStart || '').trim();
    const turnoEnd = String(u.turnoEnd || '').trim();
    const lapNum = Number(u.lapNumber) > 0 ? Number(u.lapNumber) : 0;
    const shiftLaps = Number(u.shiftLaps) > 0 ? Number(u.shiftLaps) : 0;

    const driver = normalizeDriverRecord(
      u.choferNombre || '',
      u.choferLegajo || '',
      u.choferRaw || u.identificadorChofer || ''
    );
    const dNombre = driver ? driver.nombre : '';
    const dLegajo = driver ? driver.legajo : '';
    const dRaw = driver ? driver.raw : '';

    this.sql.exec(
      `INSERT INTO fleet_cars (
        codigo_linea, coche, descripcion_linea, es_adaptado,
        last_chofer_nombre, last_chofer_legajo, last_chofer_raw,
        last_bandera, last_gps, last_stop_id,
        last_lat, last_lng, last_desvio_sec, last_desvio_raw,
        last_trip_key, last_service_num, last_turno_idx, last_turno_start, last_turno_end, last_lap_num, last_shift_laps,
        first_seen_at, last_seen_at, last_day_key, seen_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT(codigo_linea, coche) DO UPDATE SET
        descripcion_linea = CASE WHEN excluded.descripcion_linea != '' THEN excluded.descripcion_linea ELSE fleet_cars.descripcion_linea END,
        es_adaptado = MAX(fleet_cars.es_adaptado, excluded.es_adaptado),
        last_chofer_nombre = CASE WHEN excluded.last_seen_at >= fleet_cars.last_seen_at AND excluded.last_chofer_nombre != '' THEN excluded.last_chofer_nombre ELSE fleet_cars.last_chofer_nombre END,
        last_chofer_legajo = CASE WHEN excluded.last_seen_at >= fleet_cars.last_seen_at AND excluded.last_chofer_legajo != '' THEN excluded.last_chofer_legajo ELSE fleet_cars.last_chofer_legajo END,
        last_chofer_raw = CASE WHEN excluded.last_seen_at >= fleet_cars.last_seen_at AND excluded.last_chofer_raw != '' THEN excluded.last_chofer_raw ELSE fleet_cars.last_chofer_raw END,
        last_bandera = CASE WHEN excluded.last_seen_at >= fleet_cars.last_seen_at AND excluded.last_bandera != '' THEN excluded.last_bandera ELSE fleet_cars.last_bandera END,
        last_gps = CASE WHEN excluded.last_seen_at >= fleet_cars.last_seen_at AND excluded.last_gps != '' THEN excluded.last_gps ELSE fleet_cars.last_gps END,
        last_stop_id = CASE WHEN excluded.last_seen_at >= fleet_cars.last_seen_at AND excluded.last_stop_id != '' THEN excluded.last_stop_id ELSE fleet_cars.last_stop_id END,
        last_lat = CASE WHEN excluded.last_seen_at >= fleet_cars.last_seen_at AND excluded.last_lat IS NOT NULL THEN excluded.last_lat ELSE COALESCE(fleet_cars.last_lat, excluded.last_lat) END,
        last_lng = CASE WHEN excluded.last_seen_at >= fleet_cars.last_seen_at AND excluded.last_lng IS NOT NULL THEN excluded.last_lng ELSE COALESCE(fleet_cars.last_lng, excluded.last_lng) END,
        last_desvio_sec = CASE WHEN excluded.last_seen_at >= fleet_cars.last_seen_at AND excluded.last_desvio_raw != '' THEN excluded.last_desvio_sec ELSE fleet_cars.last_desvio_sec END,
        last_desvio_raw = CASE WHEN excluded.last_seen_at >= fleet_cars.last_seen_at AND excluded.last_desvio_raw != '' THEN excluded.last_desvio_raw ELSE fleet_cars.last_desvio_raw END,
        last_trip_key = CASE
          WHEN excluded.last_trip_key != '' THEN excluded.last_trip_key
          WHEN excluded.last_seen_at >= fleet_cars.last_seen_at AND (
            excluded.last_day_key != fleet_cars.last_day_key OR
            (excluded.last_chofer_nombre != '' AND fleet_cars.last_chofer_nombre != '' AND excluded.last_chofer_nombre != fleet_cars.last_chofer_nombre)
          ) THEN ''
          ELSE fleet_cars.last_trip_key
        END,
        last_service_num = CASE
          WHEN excluded.last_service_num > 0 THEN excluded.last_service_num
          WHEN excluded.last_seen_at >= fleet_cars.last_seen_at AND (
            excluded.last_day_key != fleet_cars.last_day_key OR
            (excluded.last_chofer_nombre != '' AND fleet_cars.last_chofer_nombre != '' AND excluded.last_chofer_nombre != fleet_cars.last_chofer_nombre)
          ) THEN 0
          ELSE fleet_cars.last_service_num
        END,
        last_turno_idx = CASE
          WHEN excluded.last_service_num > 0 THEN excluded.last_turno_idx
          WHEN excluded.last_seen_at >= fleet_cars.last_seen_at AND (
            excluded.last_day_key != fleet_cars.last_day_key OR
            (excluded.last_chofer_nombre != '' AND fleet_cars.last_chofer_nombre != '' AND excluded.last_chofer_nombre != fleet_cars.last_chofer_nombre)
          ) THEN 0
          ELSE fleet_cars.last_turno_idx
        END,
        last_turno_start = CASE
          WHEN excluded.last_turno_start != '' THEN excluded.last_turno_start
          WHEN excluded.last_seen_at >= fleet_cars.last_seen_at AND (
            excluded.last_day_key != fleet_cars.last_day_key OR
            (excluded.last_chofer_nombre != '' AND fleet_cars.last_chofer_nombre != '' AND excluded.last_chofer_nombre != fleet_cars.last_chofer_nombre)
          ) THEN ''
          ELSE fleet_cars.last_turno_start
        END,
        last_turno_end = CASE
          WHEN excluded.last_turno_end != '' THEN excluded.last_turno_end
          WHEN excluded.last_seen_at >= fleet_cars.last_seen_at AND (
            excluded.last_day_key != fleet_cars.last_day_key OR
            (excluded.last_chofer_nombre != '' AND fleet_cars.last_chofer_nombre != '' AND excluded.last_chofer_nombre != fleet_cars.last_chofer_nombre)
          ) THEN ''
          ELSE fleet_cars.last_turno_end
        END,
        last_lap_num = CASE
          WHEN excluded.last_lap_num > 0 THEN excluded.last_lap_num
          WHEN excluded.last_seen_at >= fleet_cars.last_seen_at AND (
            excluded.last_day_key != fleet_cars.last_day_key OR
            (excluded.last_chofer_nombre != '' AND fleet_cars.last_chofer_nombre != '' AND excluded.last_chofer_nombre != fleet_cars.last_chofer_nombre)
          ) THEN 0
          ELSE fleet_cars.last_lap_num
        END,
        last_shift_laps = CASE
          WHEN excluded.last_shift_laps > 0 THEN excluded.last_shift_laps
          WHEN excluded.last_seen_at >= fleet_cars.last_seen_at AND (
            excluded.last_day_key != fleet_cars.last_day_key OR
            (excluded.last_chofer_nombre != '' AND fleet_cars.last_chofer_nombre != '' AND excluded.last_chofer_nombre != fleet_cars.last_chofer_nombre)
          ) THEN 0
          ELSE fleet_cars.last_shift_laps
        END,
        first_seen_at = MIN(fleet_cars.first_seen_at, excluded.first_seen_at),
        last_day_key = CASE WHEN excluded.last_seen_at >= fleet_cars.last_seen_at THEN excluded.last_day_key ELSE fleet_cars.last_day_key END,
        last_seen_at = MAX(fleet_cars.last_seen_at, excluded.last_seen_at),
        seen_count = fleet_cars.seen_count + 1`,
      cod,
      coche,
      descLinea,
      esAdaptado,
      dNombre,
      dLegajo,
      dRaw,
      bandera,
      ultimaGps,
      stopId,
      lat,
      lng,
      desvioSec,
      desvioRaw,
      tripKey,
      serviceNum,
      turnoIdx,
      turnoStart,
      turnoEnd,
      lapNum,
      shiftLaps,
      obsMs,
      obsMs,
      effectiveDayKey
    );

    if (driver) {
      let mergedFirst = obsMs;
      let mergedCount = 1;
      // If this driver was previously indexed by name only and now arrives with legajo, deduplicate cleanly
      if (driver.legacyNameKey) {
        const legacyRows = this.sql
          .exec(
            'SELECT first_seen_at, seen_count FROM fleet_drivers WHERE codigo_linea = ? AND driver_key = ?',
            cod,
            driver.legacyNameKey
          )
          .toArray();
        if (legacyRows.length > 0) {
          mergedFirst = Math.min(obsMs, Number(legacyRows[0].first_seen_at) || obsMs);
          mergedCount = (Number(legacyRows[0].seen_count) || 0) + 1;
          this.sql.exec(
            'DELETE FROM fleet_drivers WHERE codigo_linea = ? AND driver_key = ?',
            cod,
            driver.legacyNameKey
          );
        }
      }

      this.sql.exec(
        `INSERT INTO fleet_drivers (
          codigo_linea, driver_key, descripcion_linea, chofer_nombre, chofer_legajo, chofer_raw,
          last_coche, last_es_adaptado, last_bandera, last_gps, last_stop_id,
          last_lat, last_lng, last_desvio_sec, last_desvio_raw,
          last_trip_key, last_service_num, last_turno_idx, last_turno_start, last_turno_end, last_lap_num, last_shift_laps,
          first_seen_at, last_seen_at, last_day_key, seen_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(codigo_linea, driver_key) DO UPDATE SET
          descripcion_linea = CASE WHEN excluded.descripcion_linea != '' THEN excluded.descripcion_linea ELSE fleet_drivers.descripcion_linea END,
          chofer_nombre = CASE WHEN excluded.chofer_nombre != '' AND excluded.chofer_nombre NOT LIKE 'Legajo %' THEN excluded.chofer_nombre ELSE fleet_drivers.chofer_nombre END,
          chofer_legajo = CASE WHEN excluded.chofer_legajo != '' THEN excluded.chofer_legajo ELSE fleet_drivers.chofer_legajo END,
          chofer_raw = CASE WHEN excluded.chofer_raw != '' THEN excluded.chofer_raw ELSE fleet_drivers.chofer_raw END,
          last_coche = CASE WHEN excluded.last_seen_at >= fleet_drivers.last_seen_at THEN excluded.last_coche ELSE fleet_drivers.last_coche END,
          last_es_adaptado = CASE WHEN excluded.last_seen_at >= fleet_drivers.last_seen_at THEN excluded.last_es_adaptado ELSE fleet_drivers.last_es_adaptado END,
          last_bandera = CASE WHEN excluded.last_seen_at >= fleet_drivers.last_seen_at AND excluded.last_bandera != '' THEN excluded.last_bandera ELSE fleet_drivers.last_bandera END,
          last_gps = CASE WHEN excluded.last_seen_at >= fleet_drivers.last_seen_at AND excluded.last_gps != '' THEN excluded.last_gps ELSE fleet_drivers.last_gps END,
          last_stop_id = CASE WHEN excluded.last_seen_at >= fleet_drivers.last_seen_at AND excluded.last_stop_id != '' THEN excluded.last_stop_id ELSE fleet_drivers.last_stop_id END,
          last_lat = CASE WHEN excluded.last_seen_at >= fleet_drivers.last_seen_at AND excluded.last_lat IS NOT NULL THEN excluded.last_lat ELSE COALESCE(fleet_drivers.last_lat, excluded.last_lat) END,
          last_lng = CASE WHEN excluded.last_seen_at >= fleet_drivers.last_seen_at AND excluded.last_lng IS NOT NULL THEN excluded.last_lng ELSE COALESCE(fleet_drivers.last_lng, excluded.last_lng) END,
          last_desvio_sec = CASE WHEN excluded.last_seen_at >= fleet_drivers.last_seen_at AND excluded.last_desvio_raw != '' THEN excluded.last_desvio_sec ELSE fleet_drivers.last_desvio_sec END,
          last_desvio_raw = CASE WHEN excluded.last_seen_at >= fleet_drivers.last_seen_at AND excluded.last_desvio_raw != '' THEN excluded.last_desvio_raw ELSE fleet_drivers.last_desvio_raw END,
          last_trip_key = CASE WHEN excluded.last_trip_key != '' THEN excluded.last_trip_key ELSE fleet_drivers.last_trip_key END,
          last_service_num = CASE WHEN excluded.last_service_num > 0 THEN excluded.last_service_num ELSE fleet_drivers.last_service_num END,
          last_turno_idx = CASE WHEN excluded.last_service_num > 0 THEN excluded.last_turno_idx ELSE fleet_drivers.last_turno_idx END,
          last_turno_start = CASE WHEN excluded.last_turno_start != '' THEN excluded.last_turno_start ELSE fleet_drivers.last_turno_start END,
          last_turno_end = CASE WHEN excluded.last_turno_end != '' THEN excluded.last_turno_end ELSE fleet_drivers.last_turno_end END,
          last_lap_num = CASE WHEN excluded.last_lap_num > 0 THEN excluded.last_lap_num ELSE fleet_drivers.last_lap_num END,
          last_shift_laps = CASE WHEN excluded.last_shift_laps > 0 THEN excluded.last_shift_laps ELSE fleet_drivers.last_shift_laps END,
          first_seen_at = MIN(fleet_drivers.first_seen_at, excluded.first_seen_at),
          last_day_key = CASE WHEN excluded.last_seen_at >= fleet_drivers.last_seen_at THEN excluded.last_day_key ELSE fleet_drivers.last_day_key END,
          last_seen_at = MAX(fleet_drivers.last_seen_at, excluded.last_seen_at),
          seen_count = fleet_drivers.seen_count + 1`,
        cod,
        driver.driverKey,
        descLinea,
        driver.nombre,
        driver.legajo,
        driver.raw,
        coche,
        esAdaptado,
        bandera,
        ultimaGps,
        stopId,
        lat,
        lng,
        desvioSec,
        desvioRaw,
        tripKey,
        serviceNum,
        turnoIdx,
        turnoStart,
        turnoEnd,
        lapNum,
        shiftLaps,
        mergedFirst,
        obsMs,
        effectiveDayKey,
        mergedCount
      );
    }

    // Preserve daily per-(coche, driver) shift history for the 7-day Servicios timeline
    const obsDriverKey = String(driver?.driverKey || '_car');
    try {
      this.sql.exec(
        `INSERT INTO fleet_daily_obs (
          day_key, codigo_linea, coche, driver_key,
          chofer_nombre, chofer_legajo, es_adaptado,
          last_bandera, last_gps, last_stop_id,
          last_lat, last_lng, last_desvio_sec, last_desvio_raw,
          last_trip_key, last_service_num, last_turno_idx,
          first_seen_at, last_seen_at, seen_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
        ON CONFLICT(day_key, codigo_linea, coche, driver_key) DO UPDATE SET
          chofer_nombre = CASE WHEN excluded.chofer_nombre != '' THEN excluded.chofer_nombre ELSE fleet_daily_obs.chofer_nombre END,
          chofer_legajo = CASE WHEN excluded.chofer_legajo != '' THEN excluded.chofer_legajo ELSE fleet_daily_obs.chofer_legajo END,
          es_adaptado = MAX(fleet_daily_obs.es_adaptado, excluded.es_adaptado),
          last_bandera = CASE WHEN excluded.last_seen_at >= fleet_daily_obs.last_seen_at AND excluded.last_bandera != '' THEN excluded.last_bandera ELSE fleet_daily_obs.last_bandera END,
          last_gps = CASE WHEN excluded.last_seen_at >= fleet_daily_obs.last_seen_at AND excluded.last_gps != '' THEN excluded.last_gps ELSE fleet_daily_obs.last_gps END,
          last_stop_id = CASE WHEN excluded.last_seen_at >= fleet_daily_obs.last_seen_at AND excluded.last_stop_id != '' THEN excluded.last_stop_id ELSE fleet_daily_obs.last_stop_id END,
          last_lat = CASE WHEN excluded.last_seen_at >= fleet_daily_obs.last_seen_at AND excluded.last_lat IS NOT NULL THEN excluded.last_lat ELSE COALESCE(fleet_daily_obs.last_lat, excluded.last_lat) END,
          last_lng = CASE WHEN excluded.last_seen_at >= fleet_daily_obs.last_seen_at AND excluded.last_lng IS NOT NULL THEN excluded.last_lng ELSE COALESCE(fleet_daily_obs.last_lng, excluded.last_lng) END,
          last_desvio_sec = CASE WHEN excluded.last_seen_at >= fleet_daily_obs.last_seen_at AND excluded.last_desvio_raw != '' THEN excluded.last_desvio_sec ELSE fleet_daily_obs.last_desvio_sec END,
          last_desvio_raw = CASE WHEN excluded.last_seen_at >= fleet_daily_obs.last_seen_at AND excluded.last_desvio_raw != '' THEN excluded.last_desvio_raw ELSE fleet_daily_obs.last_desvio_raw END,
          last_trip_key = CASE WHEN excluded.last_trip_key != '' THEN excluded.last_trip_key ELSE fleet_daily_obs.last_trip_key END,
          last_service_num = CASE WHEN excluded.last_service_num > 0 THEN excluded.last_service_num ELSE fleet_daily_obs.last_service_num END,
          last_turno_idx = CASE WHEN excluded.last_service_num > 0 THEN excluded.last_turno_idx ELSE fleet_daily_obs.last_turno_idx END,
          first_seen_at = MIN(fleet_daily_obs.first_seen_at, excluded.first_seen_at),
          last_seen_at = MAX(fleet_daily_obs.last_seen_at, excluded.last_seen_at),
          seen_count = fleet_daily_obs.seen_count + 1`,
        effectiveDayKey,
        cod,
        coche,
        obsDriverKey,
        dNombre,
        dLegajo,
        esAdaptado,
        bandera,
        ultimaGps,
        stopId,
        lat,
        lng,
        desvioSec,
        desvioRaw,
        tripKey,
        serviceNum,
        turnoIdx,
        obsMs,
        obsMs
      );
    } catch {
      // Non-fatal: never abort batch roster/cron updates if daily history write fails
    }
  }

  /**
   * Recomputes and records real-time simultaneous fleet capacity for `touchedLineCodes` (or all lines).
   * Distinguishes:
   *  - `activeNow`: cars with a fresh GPS observation within the last 38 min on the current service day
   *  - `peakSimultaneous`: highest concurrent active car count observed today (real active services!)
   *  - `totalUniqueCars`: total distinct car numbers seen today (if `totalUniqueCars > peakSimultaneous`,
   *    the difference is the exact number of broken-down / relief vehicle swaps today!)
   */
  _updateLiveCapacity(nowMs, todayKey, touchedLineCodes = null) {
    const tipoDia = getArgentinaServiceTipo(nowMs);
    const activeCutoff = nowMs - SIMULTANEOUS_ACTIVE_WINDOW_MS;
    const codes =
      Array.isArray(touchedLineCodes) && touchedLineCodes.length > 0
        ? Array.from(new Set(touchedLineCodes.map(Number).filter(Boolean)))
        : [];

    let rows;
    if (codes.length > 0) {
      const ph = codes.map(() => '?').join(',');
      rows = this.sql
        .exec(
          `SELECT codigo_linea,
                  COUNT(*) AS total_today,
                  SUM(CASE WHEN last_seen_at >= ? THEN 1 ELSE 0 END) AS active_now
           FROM fleet_cars
           WHERE last_day_key = ? AND codigo_linea IN (${ph})
           GROUP BY codigo_linea`,
          activeCutoff,
          todayKey,
          ...codes
        )
        .toArray();
    } else {
      rows = this.sql
        .exec(
          `SELECT codigo_linea,
                  COUNT(*) AS total_today,
                  SUM(CASE WHEN last_seen_at >= ? THEN 1 ELSE 0 END) AS active_now
           FROM fleet_cars
           WHERE last_day_key = ?
           GROUP BY codigo_linea`,
          activeCutoff,
          todayKey
        )
        .toArray();
    }

    for (const r of rows) {
      const cod = Number(r.codigo_linea);
      const totalUnique = Number(r.total_today) || 0;
      const activeNow = Number(r.active_now) || 0;
      if (!cod || totalUnique <= 0) continue;

      this.sql.exec(
        `INSERT INTO fleet_capacity_daily (
          day_key, codigo_linea, tipo_dia, peak_simultaneous, peak_at,
          active_now, total_unique_cars, samples_count, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
        ON CONFLICT(day_key, codigo_linea) DO UPDATE SET
          tipo_dia = excluded.tipo_dia,
          peak_at = CASE WHEN excluded.peak_simultaneous > fleet_capacity_daily.peak_simultaneous THEN excluded.peak_at ELSE fleet_capacity_daily.peak_at END,
          peak_simultaneous = MAX(fleet_capacity_daily.peak_simultaneous, excluded.peak_simultaneous),
          active_now = excluded.active_now,
          total_unique_cars = MAX(fleet_capacity_daily.total_unique_cars, excluded.total_unique_cars),
          samples_count = fleet_capacity_daily.samples_count + 1,
          updated_at = excluded.updated_at`,
        todayKey,
        cod,
        tipoDia,
        activeNow,
        nowMs,
        activeNow,
        totalUnique,
        nowMs
      );
    }
  }

  /**
   * Computes live & learned operational fleet capacity for one line (`codLineaParam`) or all lines.
   * Learns typical active services per day-type (`habil` / `sabado` / `domingo`) via the 75th-percentile
   * of recent daily simultaneous peaks (robust against partial early-morning days AND single-day replacement outliers).
   */
  _getCapacityByLine(nowMs, todayKey, codLineaParam = null) {
    const todayTipo = getArgentinaServiceTipo(nowMs);
    const activeCutoff = nowMs - SIMULTANEOUS_ACTIVE_WINDOW_MS;
    const minHistTs = nowMs - CAPACITY_HISTORY_RETENTION_MS;

    const liveRows = codLineaParam
      ? this.sql
          .exec(
            `SELECT codigo_linea,
                    COUNT(*) AS total_today,
                    SUM(CASE WHEN last_seen_at >= ? THEN 1 ELSE 0 END) AS active_now
             FROM fleet_cars
             WHERE last_day_key = ? AND codigo_linea = ?
             GROUP BY codigo_linea`,
            activeCutoff,
            todayKey,
            Number(codLineaParam)
          )
          .toArray()
      : this.sql
          .exec(
            `SELECT codigo_linea,
                    COUNT(*) AS total_today,
                    SUM(CASE WHEN last_seen_at >= ? THEN 1 ELSE 0 END) AS active_now
             FROM fleet_cars
             WHERE last_day_key = ?
             GROUP BY codigo_linea`,
            activeCutoff,
            todayKey
          )
          .toArray();

    const capRows = codLineaParam
      ? this.sql
          .exec(
            `SELECT day_key, codigo_linea, tipo_dia, peak_simultaneous, peak_at,
                    active_now, total_unique_cars, samples_count, updated_at
             FROM fleet_capacity_daily
             WHERE codigo_linea = ? AND updated_at >= ?
             ORDER BY day_key DESC`,
            Number(codLineaParam),
            minHistTs
          )
          .toArray()
      : this.sql
          .exec(
            `SELECT day_key, codigo_linea, tipo_dia, peak_simultaneous, peak_at,
                    active_now, total_unique_cars, samples_count, updated_at
             FROM fleet_capacity_daily
             WHERE updated_at >= ?
             ORDER BY day_key DESC`,
            minHistTs
          )
          .toArray();

    const liveByLine = new Map();
    for (const r of liveRows) {
      liveByLine.set(Number(r.codigo_linea), {
        activeNow: Number(r.active_now) || 0,
        totalToday: Number(r.total_today) || 0
      });
    }

    const histByLine = new Map();
    for (const r of capRows) {
      const cod = Number(r.codigo_linea);
      if (!histByLine.has(cod)) histByLine.set(cod, []);
      histByLine.get(cod).push(r);
    }

    const allCodes = new Set([...liveByLine.keys(), ...histByLine.keys()]);
    if (codLineaParam) allCodes.add(Number(codLineaParam));

    const computeQuantile75 = (vals) => {
      const clean = vals.filter((v) => v > 0).sort((a, b) => a - b);
      if (clean.length === 0) return 0;
      const idx = Math.min(clean.length - 1, Math.floor((clean.length - 1) * 0.75));
      return clean[idx];
    };

    const result = new Map();
    for (const cod of allCodes) {
      const live = liveByLine.get(cod) || { activeNow: 0, totalToday: 0 };
      const rows = histByLine.get(cod) || [];
      const todayRow = rows.find((r) => r.day_key === todayKey) || null;

      const activeNow = live.activeNow;
      const totalUniqueToday = Math.max(live.totalToday, Number(todayRow?.total_unique_cars) || 0);
      const peakSimultaneousToday = Math.max(activeNow, Number(todayRow?.peak_simultaneous) || 0);
      const peakAtToday =
        activeNow > (Number(todayRow?.peak_simultaneous) || 0)
          ? nowMs
          : Number(todayRow?.peak_at) || null;
      const replacementSwapsToday = Math.max(0, totalUniqueToday - peakSimultaneousToday);

      const byTipo = { habil: [], sabado: [], domingo: [] };
      for (const r of rows) {
        const t = r.tipo_dia;
        const p =
          r.day_key === todayKey
            ? Math.max(peakSimultaneousToday, Number(r.peak_simultaneous) || 0)
            : Number(r.peak_simultaneous) || 0;
        if (byTipo[t] && p > 0) {
          byTipo[t].push(p);
        }
      }
      if (!todayRow && peakSimultaneousToday > 0 && byTipo[todayTipo]) {
        byTipo[todayTipo].push(peakSimultaneousToday);
      }

      const learnedByTipo = {
        habil: computeQuantile75(byTipo.habil),
        sabado: computeQuantile75(byTipo.sabado),
        domingo: computeQuantile75(byTipo.domingo)
      };
      const learnedTypicalToday = learnedByTipo[todayTipo] || peakSimultaneousToday || 0;
      const sampleDaysForTipo = byTipo[todayTipo]?.length || 0;

      result.set(cod, {
        tipoDia: todayTipo,
        activeNow,
        peakSimultaneousToday,
        peakAtToday,
        totalUniqueToday,
        replacementSwapsToday,
        learnedTypicalToday,
        sampleDaysForTipo,
        learnedByTipo
      });
    }

    return result;
  }

  _parseTripKeyStartSec(tripKey) {
    const idx = String(tripKey || '').lastIndexOf('@');
    if (idx < 0) return null;
    const m = String(tripKey)
      .slice(idx + 1)
      .trim()
      .match(/^(\d{1,2}):(\d{2})/);
    if (!m) return null;
    return parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60;
  }

  _recordShiftTransition(cod, dayKey, fromTripKey, toTripKey, prevChofer, curChofer, coche, nowMs) {
    if (!cod || !fromTripKey || !toTripKey || fromTripKey === toTripKey) return;
    const fromSec = this._parseTripKeyStartSec(fromTripKey);
    let toSec = this._parseTripKeyStartSec(toTripKey);
    if (fromSec === null || toSec === null) return;
    if (fromSec >= 20 * 3600 && toSec < 4 * 3600) toSec += 86400;
    const dt = toSec - fromSec;
    if (dt < 20 * 60 || dt > 140 * 60) return;

    const tipoDia = getArgentinaServiceTipo(nowMs);
    const existing = this.sql
      .exec(
        `SELECT last_day_key, last_coche FROM learned_shift_transitions
         WHERE codigo_linea = ? AND tipo_dia = ? AND from_trip_key = ? AND to_trip_key = ?`,
        cod,
        tipoDia,
        fromTripKey,
        toTripKey
      )
      .toArray();
    if (existing.length > 0 && existing[0].last_day_key === dayKey && existing[0].last_coche === coche) {
      return;
    }

    const isRelevo = Boolean(prevChofer && curChofer && prevChofer !== curChofer);
    const sameDelta = isRelevo ? 0 : 1;
    const relevoDelta = isRelevo ? 1 : 0;

    this.sql.exec(
      `INSERT INTO learned_shift_transitions (
        codigo_linea, tipo_dia, from_trip_key, to_trip_key,
        same_shift_count, relevo_count, last_coche, last_chofer, last_day_key, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(codigo_linea, tipo_dia, from_trip_key, to_trip_key) DO UPDATE SET
        same_shift_count = learned_shift_transitions.same_shift_count + excluded.same_shift_count,
        relevo_count = learned_shift_transitions.relevo_count + excluded.relevo_count,
        last_coche = excluded.last_coche,
        last_chofer = CASE WHEN excluded.last_chofer != '' THEN excluded.last_chofer ELSE learned_shift_transitions.last_chofer END,
        last_day_key = excluded.last_day_key,
        updated_at = excluded.updated_at`,
      cod,
      tipoDia,
      fromTripKey,
      toTripKey,
      sameDelta,
      relevoDelta,
      coche,
      curChofer || prevChofer || '',
      dayKey,
      nowMs
    );
  }

  _getLearnedTransitions(lineCodes = []) {
    const codes = Array.isArray(lineCodes) ? lineCodes.map(Number).filter(Boolean) : [];
    const rows =
      codes.length > 0
        ? this.sql
            .exec(
              `SELECT codigo_linea, tipo_dia, from_trip_key, to_trip_key,
                      same_shift_count, relevo_count, last_coche, last_chofer, updated_at
               FROM learned_shift_transitions
               WHERE codigo_linea IN (${codes.map(() => '?').join(',')})
               ORDER BY updated_at DESC LIMIT 400`,
              ...codes
            )
            .toArray()
        : this.sql
            .exec(
              `SELECT codigo_linea, tipo_dia, from_trip_key, to_trip_key,
                      same_shift_count, relevo_count, last_coche, last_chofer, updated_at
               FROM learned_shift_transitions
               ORDER BY updated_at DESC LIMIT 400`
            )
            .toArray();
    return rows.map((r) => ({
      codigoLinea: r.codigo_linea,
      dayType: r.tipo_dia,
      fromTripKey: r.from_trip_key,
      toTripKey: r.to_trip_key,
      sameShiftCount: r.same_shift_count,
      relevoCount: r.relevo_count,
      lastCoche: r.last_coche,
      lastChofer: r.last_chofer,
      updatedAt: r.updated_at
    }));
  }

  _buildLiveHorariosPayload(dayKeys = [], codLineaFilter = 0, stopIdFilter = '') {
    const cleanDays = Array.from(new Set((dayKeys || []).map((d) => String(d || '').trim()).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))));
    const cleanLine = Number(codLineaFilter) || 0;
    const cleanStop = String(stopIdFilter || '').trim().toUpperCase();

    const availRows = this.sql
      .exec(
        `SELECT DISTINCT day_key FROM (
           SELECT day_key FROM live_horarios_daily
           UNION
           SELECT day_key FROM live_horarios_windows
         ) ORDER BY day_key DESC LIMIT 14`
      )
      .toArray();
    const availableDays = availRows.map((r) => r.day_key);

    const targetDays = cleanDays.length > 0 ? cleanDays : availableDays;
    const days = {};
    if (targetDays.length > 0) {
      const ph = targetDays.map(() => '?').join(',');
      const itemParams = [...targetDays];
      let itemSql = `SELECT day_key, codigo_linea, stop_id, hora_paso, bandera, last_seen_at
                     FROM live_horarios_daily
                     WHERE day_key IN (${ph})`;
      if (cleanLine) {
        itemSql += ' AND codigo_linea = ?';
        itemParams.push(cleanLine);
      }
      if (cleanStop) {
        itemSql += ' AND stop_id = ?';
        itemParams.push(cleanStop);
      }
      itemSql += ' ORDER BY day_key, codigo_linea, stop_id, hora_paso';

      const winParams = [...targetDays];
      let winSql = `SELECT day_key, codigo_linea, stop_id, window_hour, items_count, scanned_at
                    FROM live_horarios_windows
                    WHERE day_key IN (${ph})`;
      if (cleanLine) {
        winSql += ' AND codigo_linea = ?';
        winParams.push(cleanLine);
      }
      if (cleanStop) {
        winSql += ' AND stop_id = ?';
        winParams.push(cleanStop);
      }

      const ensureLine = (dayKey, cod) => {
        if (!days[dayKey]) days[dayKey] = { updatedAt: 0, lineas: {} };
        const key = String(cod);
        if (!days[dayKey].lineas[key]) {
          days[dayKey].lineas[key] = { stops: {}, windowsScanned: 0, windowHours: [], lastScanAt: 0 };
        }
        return days[dayKey].lineas[key];
      };

      const itemRows = this.sql.exec(itemSql, ...itemParams).toArray();
      for (const r of itemRows) {
        const cod = Number(r.codigo_linea);
        if (!cod || REMOVED_LINE_CODES.has(cod)) continue;
        const lineObj = ensureLine(r.day_key, cod);
        if (!lineObj.stops[r.stop_id]) lineObj.stops[r.stop_id] = [];
        const val = r.bandera ? `${r.hora_paso}|${r.bandera}` : r.hora_paso;
        lineObj.stops[r.stop_id].push(val);
        const ts = Number(r.last_seen_at) || 0;
        if (ts > lineObj.lastScanAt) lineObj.lastScanAt = ts;
        if (ts > days[r.day_key].updatedAt) days[r.day_key].updatedAt = ts;
      }

      const winHourSets = new Map();
      const winRows = this.sql.exec(winSql, ...winParams).toArray();
      for (const r of winRows) {
        const cod = Number(r.codigo_linea);
        if (!cod || REMOVED_LINE_CODES.has(cod)) continue;
        const lineObj = ensureLine(r.day_key, cod);
        lineObj.windowsScanned += 1;
        const sKey = `${r.day_key}:${cod}`;
        if (!winHourSets.has(sKey)) winHourSets.set(sKey, new Set());
        winHourSets.get(sKey).add(Number(r.window_hour));
        const ts = Number(r.scanned_at) || 0;
        if (ts > lineObj.lastScanAt) lineObj.lastScanAt = ts;
        if (ts > days[r.day_key].updatedAt) days[r.day_key].updatedAt = ts;
      }
      for (const [sKey, hSet] of winHourSets.entries()) {
        const [dk, cod] = sKey.split(':');
        if (days[dk]?.lineas?.[cod]) {
          days[dk].lineas[cod].windowHours = Array.from(hSet).sort((a, b) => a - b);
        }
      }
    }

    return {
      availableDays,
      days,
      meta: {
        lastHorariosScanAt: Number(this._getMeta('last_horarios_scan_at', 0)) || 0,
        totalHorariosScans: Number(this._getMeta('total_horarios_scans', 0)) || 0,
        intervalMin: HORARIOS_LIVE_INTERVAL_MIN,
        anchorStops: HORARIOS_ANCHOR_STOPS.length
      }
    };
  }

  _pruneOld(nowMs) {
    const historyCutoff = nowMs - (ROSTER_RETENTION_DAYS + 1) * 86400 * 1000;
    const rosterCutoff = nowMs - ROSTER_RETENTION_MS;
    const cutoffDayKey = shiftCalendarDayIso(getArgentinaDayKey(nowMs), -(ROSTER_RETENTION_DAYS + 1));
    this.sql.exec('DELETE FROM trip_assignments WHERE updated_at < ?', historyCutoff);
    this.sql.exec('DELETE FROM fleet_daily_obs WHERE last_seen_at < ?', historyCutoff);
    this.sql.exec('DELETE FROM unit_last_seen WHERE updated_at < ?', nowMs - 14 * 86400 * 1000);
    this.sql.exec('DELETE FROM stop_last_arribos WHERE updated_at < ?', nowMs - 14 * 86400 * 1000);
    this.sql.exec('DELETE FROM fleet_cars WHERE last_seen_at < ?', rosterCutoff);
    this.sql.exec('DELETE FROM fleet_drivers WHERE last_seen_at < ?', rosterCutoff);
    this.sql.exec('DELETE FROM fleet_capacity_daily WHERE updated_at < ?', nowMs - CAPACITY_HISTORY_RETENTION_MS);
    this.sql.exec('DELETE FROM learned_shift_transitions WHERE updated_at < ?', nowMs - CAPACITY_HISTORY_RETENTION_MS);
    // Keep 7+ days of history + today + future (+1/+2) live SOAP schedules; never delete today's passed times!
    this.sql.exec('DELETE FROM live_horarios_daily WHERE day_key < ?', cutoffDayKey);
    this.sql.exec('DELETE FROM live_horarios_windows WHERE day_key < ?', cutoffDayKey);
  }

  async fetch(request) {
    this._ensureSchema();
    const url = new URL(request.url);
    const nowMs = Date.now();
    const todayKey = getArgentinaDayKey(nowMs);

    if (request.method === 'GET' && url.pathname === '/cron-state') {
      return Response.json({
        scanCursor: Number(this._getMeta('scan_cursor', 0)) || 0,
        lastCronAt: Number(this._getMeta('last_cron_at', 0)) || 0,
        lastCycleAt: Number(this._getMeta('last_cycle_at', 0)) || 0,
        lastPruneDay: String(this._getMeta('last_prune_day', '') || ''),
        totalSweeps: Number(this._getMeta('total_sweeps', 0)) || 0
      });
    }

    if (request.method === 'GET' && url.pathname === '/horarios-scan-state') {
      const calToday = getArgentinaCalendarDayIso(nowMs);
      const calTomorrow = shiftCalendarDayIso(calToday, 1);
      const rows = this.sql
        .exec(
          `SELECT day_key, codigo_linea, stop_id, window_hour, scanned_at
           FROM live_horarios_windows
           WHERE day_key IN (?, ?, ?)`,
          todayKey,
          calToday,
          calTomorrow
        )
        .toArray();
      return Response.json({
        liveCursor: Number(this._getMeta('horarios_live_cursor', 0)) || 0,
        lastHorariosScanAt: Number(this._getMeta('last_horarios_scan_at', 0)) || 0,
        scannedWindows: rows.map((r) => [r.day_key, r.codigo_linea, r.stop_id, r.window_hour, r.scanned_at])
      });
    }

    if (request.method === 'POST' && url.pathname === '/horarios-ingest') {
      const body = await request.json().catch(() => ({}));
      const entries = Array.isArray(body.entries) ? body.entries : [];
      const windows = Array.isArray(body.windows) ? body.windows : [];
      const ts = Number(body.scannedAt) || nowMs;
      let inserted = 0;

      // Strictly additive non-destructive UPSERT: passed SOAP times are NEVER removed!
      for (const e of entries) {
        const dk = String(e.dayKey || '').trim();
        const cod = Number(e.codigoLinea);
        const stopId = String(e.stopId || '').trim().toUpperCase();
        const horaPaso = String(e.horaPaso || '').trim();
        const bandera = String(e.bandera || '').trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dk) || !cod || REMOVED_LINE_CODES.has(cod) || !stopId || !/^\d{2}:\d{2}:\d{2}$/.test(horaPaso)) {
          continue;
        }
        this.sql.exec(
          `INSERT INTO live_horarios_daily (
            day_key, codigo_linea, stop_id, hora_paso, bandera, first_seen_at, last_seen_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(day_key, codigo_linea, stop_id, hora_paso, bandera) DO UPDATE SET
            last_seen_at = excluded.last_seen_at`,
          dk,
          cod,
          stopId,
          horaPaso,
          bandera,
          ts,
          ts
        );
        inserted++;
      }

      for (const w of windows) {
        const dk = String(w.dayKey || '').trim();
        const cod = Number(w.codigoLinea);
        const stopId = String(w.stopId || '').trim().toUpperCase();
        const wh = Number(w.windowHour);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dk) || !cod || REMOVED_LINE_CODES.has(cod) || !stopId || !Number.isInteger(wh) || wh < 0 || wh > 23) {
          continue;
        }
        this.sql.exec(
          `INSERT INTO live_horarios_windows (
            day_key, codigo_linea, stop_id, window_hour, items_count, scanned_at
          ) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(day_key, codigo_linea, stop_id, window_hour) DO UPDATE SET
            items_count = MAX(live_horarios_windows.items_count, excluded.items_count),
            scanned_at = excluded.scanned_at`,
          dk,
          cod,
          stopId,
          wh,
          Math.max(0, Number(w.itemsCount) || 0),
          ts
        );
      }

      if (Number.isInteger(body.nextLiveCursor)) {
        this._setMeta('horarios_live_cursor', body.nextLiveCursor);
      }
      if (!body.passiveOnly) {
        this._setMeta('last_horarios_scan_at', ts);
        const prevScans = Number(this._getMeta('total_horarios_scans', 0)) || 0;
        this._setMeta('total_horarios_scans', prevScans + 1);
      }

      return Response.json({ ok: true, inserted, windowsUpdated: windows.length, scannedAt: ts });
    }

    if (request.method === 'GET' && url.pathname === '/horarios-live') {
      const rawDay = String(url.searchParams.get('dayKey') || '').trim();
      const rawDays = String(url.searchParams.get('days') || '').trim();
      const codLinea = Number(url.searchParams.get('codLinea')) || 0;
      const stopId = String(url.searchParams.get('idParada') || '').trim().toUpperCase();
      let dayKeys = [];
      if (rawDay && /^\d{4}-\d{2}-\d{2}$/.test(rawDay)) {
        dayKeys = [rawDay];
      } else if (rawDays === 'all') {
        dayKeys = [];
      } else {
        const calToday = getArgentinaCalendarDayIso(nowMs);
        const calTomorrow = shiftCalendarDayIso(calToday, 1);
        dayKeys = [todayKey, calToday, calTomorrow];
      }
      const payload = this._buildLiveHorariosPayload(dayKeys, codLinea, stopId);
      return Response.json({
        dayKey: todayKey,
        calendarToday: getArgentinaCalendarDayIso(nowMs),
        ...payload
      });
    }

    if (request.method === 'POST' && url.pathname === '/cron-ingest') {
      const body = await request.json().catch(() => ({}));
      const units = Array.isArray(body.units) ? body.units : [];
      let count = 0;
      const touchedLines = new Set();

      if (!body.pruneOnly) {
        for (const u of units) {
          const cod = Number(u.codigoLinea);
          const coche = String(u.coche || u.identificadorCoche || '').trim();
          if (!cod || !coche || REMOVED_LINE_CODES.has(cod)) continue;
          const lat = Number.isFinite(Number(u.lat)) ? Number(u.lat) : null;
          const lng = Number.isFinite(Number(u.lng)) ? Number(u.lng) : null;
          const ultimaGps = String(u.ultimaGps || '').trim();
          const mergedTrail = this._mergeUnitTrail(cod, coche, u.gpsTrail, lat, lng, ultimaGps, nowMs);
          this.sql.exec(
            `INSERT INTO unit_last_seen (
              codigo_linea, coche, day_key, trip_key, chofer_nombre, chofer_legajo, chofer_raw,
              es_adaptado, desvio_sec, desvio_raw, bandera, ultima_gps, lat, lng, stop_id, gps_trail, updated_at
            ) VALUES (?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(codigo_linea, coche) DO UPDATE SET
              day_key = excluded.day_key,
              chofer_nombre = CASE WHEN excluded.chofer_nombre != '' THEN excluded.chofer_nombre ELSE unit_last_seen.chofer_nombre END,
              chofer_legajo = CASE WHEN excluded.chofer_legajo != '' THEN excluded.chofer_legajo ELSE unit_last_seen.chofer_legajo END,
              chofer_raw = CASE WHEN excluded.chofer_raw != '' THEN excluded.chofer_raw ELSE unit_last_seen.chofer_raw END,
              es_adaptado = MAX(unit_last_seen.es_adaptado, excluded.es_adaptado),
              desvio_sec = excluded.desvio_sec,
              desvio_raw = CASE WHEN excluded.desvio_raw != '' THEN excluded.desvio_raw ELSE unit_last_seen.desvio_raw END,
              bandera = CASE WHEN excluded.bandera != '' THEN excluded.bandera ELSE unit_last_seen.bandera END,
              ultima_gps = CASE WHEN excluded.ultima_gps != '' THEN excluded.ultima_gps ELSE unit_last_seen.ultima_gps END,
              lat = COALESCE(excluded.lat, unit_last_seen.lat),
              lng = COALESCE(excluded.lng, unit_last_seen.lng),
              stop_id = CASE WHEN excluded.stop_id != '' THEN excluded.stop_id ELSE unit_last_seen.stop_id END,
              gps_trail = CASE WHEN excluded.gps_trail != '' THEN excluded.gps_trail ELSE unit_last_seen.gps_trail END,
              updated_at = excluded.updated_at`,
            cod,
            coche,
            todayKey,
            String(u.choferNombre || '').trim(),
            String(u.choferLegajo || '').trim(),
            String(u.choferRaw || '').trim(),
            u.esAdaptado ? 1 : 0,
            Number.isFinite(u.desvioSec) ? Math.round(u.desvioSec) : 0,
            String(u.desvioRaw || '').trim(),
            String(u.bandera || '').trim(),
            ultimaGps,
            lat,
            lng,
            String(u.stopId || '').trim().toUpperCase(),
            mergedTrail,
            nowMs
          );
          this._upsertRosterUnit(u, nowMs, todayKey);
          touchedLines.add(cod);
          count++;
        }

        // Measure and update live simultaneous capacity across all lines on cycle completion (or touched lines per tick)
        this._updateLiveCapacity(nowMs, todayKey, body.cycleCompleted ? null : Array.from(touchedLines));

        if (Number.isInteger(body.nextCursor)) {
          this._setMeta('scan_cursor', body.nextCursor);
        }
        this._setMeta('last_cron_at', nowMs);
        this._setMeta('last_live_at', nowMs);
        this._setMeta('last_batch_units', count);
        if (body.cycleCompleted) {
          this._setMeta('last_cycle_at', nowMs);
          const prevSweeps = Number(this._getMeta('total_sweeps', 0)) || 0;
          this._setMeta('total_sweeps', prevSweeps + 1);
          this._pruneOld(nowMs);
        }
      }

      const lastPruneDay = String(this._getMeta('last_prune_day', '') || '');
      if (body.pruneOnly || lastPruneDay !== todayKey) {
        this._pruneOld(nowMs);
        this._setMeta('last_prune_day', todayKey);
      }

      return Response.json({
        ok: true,
        count,
        dayKey: todayKey,
        meta: this._getRosterMetaSummary()
      });
    }

    if (request.method === 'GET' && url.pathname === '/flota-resumen') {
      const minTs = nowMs - ROSTER_RETENTION_MS;
      const carRows = this.sql
        .exec(
          `SELECT codigo_linea,
                  MAX(descripcion_linea) AS descripcion_linea,
                  COUNT(*) AS coches_semana,
                  SUM(CASE WHEN last_day_key = ? THEN 1 ELSE 0 END) AS coches_hoy,
                  MAX(last_seen_at) AS last_seen_at
           FROM fleet_cars
           WHERE last_seen_at >= ?
           GROUP BY codigo_linea`,
          todayKey,
          minTs
        )
        .toArray();
      const drvRows = this.sql
        .exec(
          `SELECT codigo_linea,
                  MAX(descripcion_linea) AS descripcion_linea,
                  COUNT(*) AS choferes_semana,
                  SUM(CASE WHEN last_day_key = ? THEN 1 ELSE 0 END) AS choferes_hoy,
                  MAX(last_seen_at) AS last_seen_at
           FROM fleet_drivers
           WHERE last_seen_at >= ?
           GROUP BY codigo_linea`,
          todayKey,
          minTs
        )
        .toArray();

      const capByLine = this._getCapacityByLine(nowMs, todayKey);
      const byLine = new Map();
      const ensureLine = (cod, desc) => {
        if (!byLine.has(cod)) {
          const cap = capByLine.get(cod) || null;
          byLine.set(cod, {
            codigoLinea: cod,
            descripcionLinea: desc || LINE_NAMES_BY_CODE[cod] || `L${cod}`,
            cochesHoy: 0,
            cochesSemana: 0,
            choferesHoy: 0,
            choferesSemana: 0,
            activeNow: cap?.activeNow || 0,
            peakSimultaneousToday: cap?.peakSimultaneousToday || 0,
            replacementSwapsToday: cap?.replacementSwapsToday || 0,
            learnedTypicalToday: cap?.learnedTypicalToday || 0,
            lastSeenAt: 0
          });
        }
        return byLine.get(cod);
      };

      for (const r of carRows) {
        const entry = ensureLine(Number(r.codigo_linea), r.descripcion_linea);
        entry.cochesHoy = Number(r.coches_hoy) || 0;
        entry.cochesSemana = Number(r.coches_semana) || 0;
        entry.lastSeenAt = Math.max(entry.lastSeenAt, Number(r.last_seen_at) || 0);
      }
      for (const r of drvRows) {
        const entry = ensureLine(Number(r.codigo_linea), r.descripcion_linea);
        entry.choferesHoy = Number(r.choferes_hoy) || 0;
        entry.choferesSemana = Number(r.choferes_semana) || 0;
        entry.lastSeenAt = Math.max(entry.lastSeenAt, Number(r.last_seen_at) || 0);
      }

      const lineas = Array.from(byLine.values()).sort((a, b) =>
        a.descripcionLinea.localeCompare(b.descripcionLinea, 'es', { numeric: true })
      );

      return Response.json({
        dayKey: todayKey,
        retentionDays: ROSTER_RETENTION_DAYS,
        meta: this._getRosterMetaSummary(),
        lineas
      });
    }

    if (request.method === 'GET' && url.pathname === '/flota') {
      const codLinea = Number(url.searchParams.get('codLinea'));
      if (!codLinea) return Response.json({ error: 'Falta codLinea' }, { status: 400 });
      const minTs = nowMs - ROSTER_RETENTION_MS;

      const carRows = this.sql
        .exec(
          `SELECT codigo_linea, coche, descripcion_linea, es_adaptado,
                  last_chofer_nombre, last_chofer_legajo, last_chofer_raw,
                  last_bandera, last_gps, last_stop_id,
                  last_lat, last_lng, last_desvio_sec, last_desvio_raw,
                  last_trip_key, last_service_num, last_turno_idx, last_turno_start, last_turno_end,
                  last_lap_num, last_shift_laps,
                  first_seen_at, last_seen_at, last_day_key, seen_count
           FROM fleet_cars
           WHERE codigo_linea = ? AND last_seen_at >= ?
           ORDER BY last_seen_at DESC`,
          codLinea,
          minTs
        )
        .toArray();

      const drvRows = this.sql
        .exec(
          `SELECT codigo_linea, driver_key, descripcion_linea, chofer_nombre, chofer_legajo, chofer_raw,
                  last_coche, last_es_adaptado, last_bandera, last_gps, last_stop_id,
                  last_lat, last_lng, last_desvio_sec, last_desvio_raw,
                  last_trip_key, last_service_num, last_turno_idx, last_turno_start, last_turno_end,
                  last_lap_num, last_shift_laps,
                  first_seen_at, last_seen_at, last_day_key, seen_count
           FROM fleet_drivers
           WHERE codigo_linea = ? AND last_seen_at >= ?
           ORDER BY last_seen_at DESC`,
          codLinea,
          minTs
        )
        .toArray();

      // Join fresh unit_last_seen coordinates/tripKey/desvio so legacy rows without last_lat still map cleanly
      const unitRows = this.sql
        .exec(
          `SELECT coche, day_key, trip_key, desvio_sec, desvio_raw, lat, lng, gps_trail, dir_bandera, updated_at
           FROM unit_last_seen
           WHERE codigo_linea = ?`,
          codLinea
        )
        .toArray();
      const unitByCoche = new Map();
      for (const u of unitRows) unitByCoche.set(u.coche, u);

      const rawDayParam = String(url.searchParams.get('dayKey') || '').trim();
      const selectedDayKey = /^\d{4}-\d{2}-\d{2}$/.test(rawDayParam) ? rawDayParam : todayKey;

      const todayTripRows = this.sql
        .exec(
          `SELECT trip_key, turno_hora, coche, chofer_nombre, chofer_legajo, es_adaptado,
                  desvio_sec, desvio_raw, ultima_gps, lat, lng, stop_id, updated_at
           FROM trip_assignments
           WHERE day_key = ? AND codigo_linea = ?
           ORDER BY updated_at DESC`,
          todayKey,
          codLinea
        )
        .toArray();

      const dayTripRows =
        selectedDayKey === todayKey
          ? todayTripRows
          : this.sql
              .exec(
                `SELECT trip_key, turno_hora, coche, chofer_nombre, chofer_legajo, es_adaptado,
                        desvio_sec, desvio_raw, ultima_gps, lat, lng, stop_id, updated_at
                 FROM trip_assignments
                 WHERE day_key = ? AND codigo_linea = ?
                 ORDER BY updated_at DESC`,
                selectedDayKey,
                codLinea
              )
              .toArray();

      const dayObsRows = this.sql
        .exec(
          `SELECT day_key, coche, driver_key, chofer_nombre, chofer_legajo, es_adaptado,
                  last_bandera, last_gps, last_stop_id, last_lat, last_lng,
                  last_desvio_sec, last_desvio_raw, last_trip_key, last_service_num, last_turno_idx,
                  first_seen_at, last_seen_at, seen_count
           FROM fleet_daily_obs
           WHERE day_key = ? AND codigo_linea = ?
           ORDER BY last_seen_at DESC`,
          selectedDayKey,
          codLinea
        )
        .toArray();

      const daysSet = new Set([todayKey]);
      for (const r of this.sql
        .exec(
          `SELECT DISTINCT day_key FROM trip_assignments WHERE codigo_linea = ? AND updated_at >= ?`,
          codLinea,
          minTs
        )
        .toArray()) {
        if (r.day_key) daysSet.add(r.day_key);
      }
      for (const r of this.sql
        .exec(
          `SELECT DISTINCT day_key FROM fleet_daily_obs WHERE codigo_linea = ? AND last_seen_at >= ?`,
          codLinea,
          minTs
        )
        .toArray()) {
        if (r.day_key) daysSet.add(r.day_key);
      }
      for (const r of carRows) {
        if (r.last_day_key) daysSet.add(r.last_day_key);
      }
      for (const r of drvRows) {
        if (r.last_day_key) daysSet.add(r.last_day_key);
      }
      const daysWithData = Array.from(daysSet).sort().reverse();

      const sameDriverLoose = (legA, nameA, legB, nameB) => {
        const lA = String(legA || '').trim().toUpperCase();
        const lB = String(legB || '').trim().toUpperCase();
        if (lA && lB) return lA === lB;
        const nA = String(nameA || '').trim().replace(/\.+$/, '').toUpperCase();
        const nB = String(nameB || '').trim().replace(/\.+$/, '').toUpperCase();
        return !nA || !nB || nA === nB;
      };

      const activeCutoff = nowMs - SIMULTANEOUS_ACTIVE_WINDOW_MS;
      const coches = carRows
        .map((r) => {
          const u = unitByCoche.get(r.coche) || null;
          const uFreshForCar = Boolean(
            u &&
              u.day_key === r.last_day_key &&
              Math.abs((u.updated_at || 0) - (r.last_seen_at || 0)) <= 25 * 60 * 1000 &&
              sameDriverLoose(u.chofer_legajo, u.chofer_nombre, r.last_chofer_legajo, r.last_chofer_nombre)
          );
          const lat = r.last_lat ?? (uFreshForCar ? u?.lat : null) ?? null;
          const lng = r.last_lng ?? (uFreshForCar ? u?.lng : null) ?? null;
          const tripKey = r.last_trip_key || (uFreshForCar ? u.trip_key : '') || '';
          const desvioSec = r.last_desvio_raw ? r.last_desvio_sec : uFreshForCar ? u?.desvio_sec || 0 : 0;
          const desvioRaw = r.last_desvio_raw || (uFreshForCar ? u?.desvio_raw : '') || '';
          return {
            coche: r.coche,
            esAdaptado: Boolean(r.es_adaptado),
            vistoHoy: r.last_day_key === todayKey,
            enLineaAhora: r.last_day_key === todayKey && Number(r.last_seen_at) >= activeCutoff,
            lastChoferNombre: r.last_chofer_nombre || '',
            lastChoferLegajo: r.last_chofer_legajo || '',
            lastBandera: r.last_bandera || '',
            lastGps: r.last_gps || '',
            lastStopId: r.last_stop_id || '',
            lastLat: Number.isFinite(Number(lat)) ? Number(lat) : null,
            lastLng: Number.isFinite(Number(lng)) ? Number(lng) : null,
            lastDesvioSec: Number(desvioSec) || 0,
            lastDesvioRaw: desvioRaw,
            lastTripKey: tripKey,
            lastServiceNum: Number(r.last_service_num) || 0,
            lastTurnoIdx: Number(r.last_turno_idx) || 0,
            lastTurnoStart: r.last_turno_start || '',
            lastTurnoEnd: r.last_turno_end || '',
            lastLapNum: Number(r.last_lap_num) || 0,
            lastShiftLaps: Number(r.last_shift_laps) || 0,
            dirBandera: u?.dir_bandera || '',
            firstSeenAt: r.first_seen_at,
            lastSeenAt: r.last_seen_at,
            lastDayKey: r.last_day_key,
            seenCount: r.seen_count || 1
          };
        })
        .sort((a, b) => {
          if (a.enLineaAhora !== b.enLineaAhora) return a.enLineaAhora ? -1 : 1;
          if (a.vistoHoy !== b.vistoHoy) return a.vistoHoy ? -1 : 1;
          if (b.lastSeenAt !== a.lastSeenAt) return b.lastSeenAt - a.lastSeenAt;
          return compareCocheIds(a.coche, b.coche);
        });

      const choferes = drvRows
        .map((r) => {
          const u = r.last_coche ? unitByCoche.get(r.last_coche) : null;
          const isSameCarFresh = Boolean(
            u &&
              u.day_key === r.last_day_key &&
              Math.abs((u.updated_at || 0) - (r.last_seen_at || 0)) <= 25 * 60 * 1000 &&
              sameDriverLoose(u.chofer_legajo, u.chofer_nombre, r.chofer_legajo, r.chofer_nombre)
          );
          const lat = r.last_lat ?? (isSameCarFresh ? u?.lat : null) ?? null;
          const lng = r.last_lng ?? (isSameCarFresh ? u?.lng : null) ?? null;
          const tripKey = r.last_trip_key || (isSameCarFresh ? u?.trip_key : '') || '';
          const desvioSec = r.last_desvio_raw ? r.last_desvio_sec : isSameCarFresh ? u?.desvio_sec || 0 : 0;
          const desvioRaw = r.last_desvio_raw || (isSameCarFresh ? u?.desvio_raw : '') || '';
          return {
            driverKey: r.driver_key,
            choferNombre: r.chofer_nombre,
            choferLegajo: r.chofer_legajo || '',
            lastCoche: r.last_coche || '',
            lastEsAdaptado: Boolean(r.last_es_adaptado),
            vistoHoy: r.last_day_key === todayKey,
            enLineaAhora: r.last_day_key === todayKey && Number(r.last_seen_at) >= activeCutoff,
            lastBandera: r.last_bandera || '',
            lastGps: r.last_gps || '',
            lastStopId: r.last_stop_id || '',
            lastLat: Number.isFinite(Number(lat)) ? Number(lat) : null,
            lastLng: Number.isFinite(Number(lng)) ? Number(lng) : null,
            lastDesvioSec: Number(desvioSec) || 0,
            lastDesvioRaw: desvioRaw,
            lastTripKey: tripKey,
            lastServiceNum: Number(r.last_service_num) || 0,
            lastTurnoIdx: Number(r.last_turno_idx) || 0,
            lastTurnoStart: r.last_turno_start || '',
            lastTurnoEnd: r.last_turno_end || '',
            lastLapNum: Number(r.last_lap_num) || 0,
            lastShiftLaps: Number(r.last_shift_laps) || 0,
            firstSeenAt: r.first_seen_at,
            lastSeenAt: r.last_seen_at,
            lastDayKey: r.last_day_key,
            seenCount: r.seen_count || 1
          };
        })
        .sort((a, b) => {
          if (a.enLineaAhora !== b.enLineaAhora) return a.enLineaAhora ? -1 : 1;
          if (a.vistoHoy !== b.vistoHoy) return a.vistoHoy ? -1 : 1;
          if (b.lastSeenAt !== a.lastSeenAt) return b.lastSeenAt - a.lastSeenAt;
          return a.choferNombre.localeCompare(b.choferNombre, 'es');
        });

      const mapTripRow = (t) => ({
        tripKey: t.trip_key,
        turnoHora: t.turno_hora,
        coche: t.coche,
        choferNombre: t.chofer_nombre || '',
        choferLegajo: t.chofer_legajo || '',
        esAdaptado: Boolean(t.es_adaptado),
        desvioSec: t.desvio_sec || 0,
        desvioRaw: t.desvio_raw || '',
        ultimaGps: t.ultima_gps || '',
        lat: t.lat,
        lng: t.lng,
        stopId: t.stop_id || '',
        updatedAt: t.updated_at
      });
      const todayTrips = todayTripRows.map(mapTripRow);
      const dayTrips = selectedDayKey === todayKey ? todayTrips : dayTripRows.map(mapTripRow);
      const dayObs = dayObsRows.map((o) => ({
        dayKey: o.day_key,
        coche: o.coche,
        driverKey: o.driver_key,
        choferNombre: o.chofer_nombre || '',
        choferLegajo: o.chofer_legajo || '',
        esAdaptado: Boolean(o.es_adaptado),
        lastBandera: o.last_bandera || '',
        lastGps: o.last_gps || '',
        lastStopId: o.last_stop_id || '',
        lastLat: Number.isFinite(Number(o.last_lat)) ? Number(o.last_lat) : null,
        lastLng: Number.isFinite(Number(o.last_lng)) ? Number(o.last_lng) : null,
        lastDesvioSec: Number(o.last_desvio_sec) || 0,
        lastDesvioRaw: o.last_desvio_raw || '',
        lastTripKey: o.last_trip_key || '',
        lastServiceNum: Number(o.last_service_num) || 0,
        lastTurnoIdx: Number(o.last_turno_idx) || 0,
        firstSeenAt: o.first_seen_at,
        lastSeenAt: o.last_seen_at,
        seenCount: o.seen_count || 1
      }));

      const descripcionLinea = resolvePublicLineName(
        codLinea,
        carRows[0]?.descripcion_linea || drvRows[0]?.descripcion_linea
      );
      const capacity = this._getCapacityByLine(nowMs, todayKey, codLinea).get(codLinea) || null;

      return Response.json({
        codigoLinea: codLinea,
        descripcionLinea,
        dayKey: todayKey,
        selectedDayKey,
        isHistoricalDay: selectedDayKey !== todayKey,
        retentionDays: ROSTER_RETENTION_DAYS,
        daysWithData,
        meta: this._getRosterMetaSummary(),
        capacity,
        learnedTransitions: [],
        todayTrips,
        dayTrips,
        dayObs,
        coches,
        choferes
      });
    }

    if (request.method === 'GET' && url.pathname === '/flota-activa') {
      const activeCutoff = nowMs - SIMULTANEOUS_ACTIVE_WINDOW_MS;
      const carRows = this.sql
        .exec(
          `SELECT codigo_linea, coche, descripcion_linea, es_adaptado,
                  last_chofer_nombre, last_chofer_legajo,
                  last_bandera, last_gps, last_stop_id,
                  last_lat, last_lng, last_desvio_sec, last_desvio_raw,
                  last_trip_key, last_service_num, last_turno_idx, last_turno_start, last_turno_end,
                  last_lap_num, last_shift_laps,
                  last_seen_at, last_day_key
           FROM fleet_cars
           WHERE last_day_key = ? AND last_seen_at >= ?
           ORDER BY codigo_linea ASC, last_seen_at DESC`,
          todayKey,
          activeCutoff
        )
        .toArray();

      const unitRows = this.sql
        .exec(
          `SELECT codigo_linea, coche, day_key, trip_key, lat, lng, desvio_sec, desvio_raw, bandera, dir_bandera, ultima_gps, gps_trail, updated_at
           FROM unit_last_seen
           WHERE updated_at >= ?`,
          activeCutoff
        )
        .toArray();
      const unitMap = new Map();
      for (const u of unitRows) unitMap.set(`${u.codigo_linea}:${u.coche}`, u);

      const byKey = new Map();
      for (const r of carRows) {
        if (REMOVED_LINE_CODES.has(Number(r.codigo_linea))) continue;
        const key = `${r.codigo_linea}:${r.coche}`;
        const u = unitMap.get(key) || null;
        const rGpsMs = parseGpsStampMs(r.last_gps) || 0;
        const uGpsMs = parseGpsStampMs(u?.ultima_gps) || 0;
        const useUnitGps = Boolean(u && uGpsMs > rGpsMs && Number.isFinite(Number(u.lat)) && Number.isFinite(Number(u.lng)) && (Number(u.lat) !== 0 || Number(u.lng) !== 0));
        const lat = Number(useUnitGps ? u.lat : (r.last_lat ?? u?.lat));
        const lng = Number(useUnitGps ? u.lng : (r.last_lng ?? u?.lng));
        if (!Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0)) continue;
        byKey.set(key, {
          codigoLinea: Number(r.codigo_linea),
          descripcionLinea: resolvePublicLineName(r.codigo_linea, r.descripcion_linea),
          coche: r.coche,
          choferNombre: r.last_chofer_nombre || '',
          choferLegajo: r.last_chofer_legajo || '',
          esAdaptado: Boolean(r.es_adaptado),
          bandera: (useUnitGps ? u?.bandera : r.last_bandera) || r.last_bandera || u?.bandera || '',
          dirBandera: u?.dir_bandera || '',
          lat,
          lng,
          desvioSec: Number(useUnitGps ? u?.desvio_sec : (r.last_desvio_raw ? r.last_desvio_sec : u?.desvio_sec)) || 0,
          desvioRaw: (useUnitGps ? u?.desvio_raw : r.last_desvio_raw) || r.last_desvio_raw || u?.desvio_raw || '',
          ultimaGps: (useUnitGps ? u?.ultima_gps : r.last_gps) || r.last_gps || u?.ultima_gps || '',
          gpsTrail: u?.gps_trail ? this._parseGpsTrail(u.gps_trail) : [],
          lastStopId: r.last_stop_id || '',
          lastTripKey: r.last_trip_key || (u?.day_key === todayKey ? u.trip_key : '') || '',
          lastServiceNum: Number(r.last_service_num) || 0,
          lastTurnoIdx: Number(r.last_turno_idx) || 0,
          lastTurnoStart: r.last_turno_start || '',
          lastTurnoEnd: r.last_turno_end || '',
          lastLapNum: Number(r.last_lap_num) || 0,
          lastShiftLaps: Number(r.last_shift_laps) || 0,
          lastSeenAt: Math.max(Number(r.last_seen_at) || 0, Number(u?.updated_at) || 0),
          enLineaAhora: true
        });
      }

      return Response.json({
        dayKey: todayKey,
        activeWindowMin: Math.round(SIMULTANEOUS_ACTIVE_WINDOW_MS / 60000),
        meta: this._getRosterMetaSummary(),
        units: Array.from(byKey.values())
      });
    }

    if (request.method === 'GET' && url.pathname === '/offline-bundle') {
      const minTs = nowMs - ROSTER_RETENTION_MS;
      const activeCutoff = nowMs - SIMULTANEOUS_ACTIVE_WINDOW_MS;
      const metaSummary = this._getRosterMetaSummary();

      const carRows = this.sql
        .exec(
          `SELECT codigo_linea, coche, descripcion_linea, es_adaptado,
                  last_chofer_nombre, last_chofer_legajo, last_chofer_raw,
                  last_bandera, last_gps, last_stop_id,
                  last_lat, last_lng, last_desvio_sec, last_desvio_raw,
                  last_trip_key, last_service_num, last_turno_idx, last_turno_start, last_turno_end,
                  last_lap_num, last_shift_laps,
                  first_seen_at, last_seen_at, last_day_key, seen_count
           FROM fleet_cars
           WHERE last_seen_at >= ?
           ORDER BY last_seen_at DESC`,
          minTs
        )
        .toArray();

      const drvRows = this.sql
        .exec(
          `SELECT codigo_linea, driver_key, descripcion_linea, chofer_nombre, chofer_legajo, chofer_raw,
                  last_coche, last_es_adaptado, last_bandera, last_gps, last_stop_id,
                  last_lat, last_lng, last_desvio_sec, last_desvio_raw,
                  last_trip_key, last_service_num, last_turno_idx, last_turno_start, last_turno_end,
                  last_lap_num, last_shift_laps,
                  first_seen_at, last_seen_at, last_day_key, seen_count
           FROM fleet_drivers
           WHERE last_seen_at >= ?
           ORDER BY last_seen_at DESC`,
          minTs
        )
        .toArray();

      const unitRows = this.sql
        .exec(
          `SELECT codigo_linea, coche, day_key, trip_key, desvio_sec, desvio_raw,
                  bandera, dir_bandera, ultima_gps, lat, lng, gps_trail, updated_at
           FROM unit_last_seen
           WHERE updated_at >= ?`,
          minTs
        )
        .toArray();

      const tripRows = this.sql
        .exec(
          `SELECT day_key, codigo_linea, trip_key, turno_hora, coche, chofer_nombre, chofer_legajo,
                  es_adaptado, desvio_sec, desvio_raw, ultima_gps, lat, lng, stop_id, updated_at
           FROM trip_assignments
           WHERE updated_at >= ?
           ORDER BY updated_at DESC`,
          minTs
        )
        .toArray();

      const obsRows = this.sql
        .exec(
          `SELECT day_key, codigo_linea, coche, driver_key, chofer_nombre, chofer_legajo, es_adaptado,
                  last_bandera, last_gps, last_stop_id, last_lat, last_lng,
                  last_desvio_sec, last_desvio_raw, last_trip_key, last_service_num, last_turno_idx,
                  first_seen_at, last_seen_at, seen_count
           FROM fleet_daily_obs
           WHERE last_seen_at >= ?
           ORDER BY last_seen_at DESC`,
          minTs
        )
        .toArray();

      const capByLine = this._getCapacityByLine(nowMs, todayKey);
      const unitMap = new Map();
      for (const u of unitRows) {
        if (REMOVED_LINE_CODES.has(Number(u.codigo_linea))) continue;
        unitMap.set(`${u.codigo_linea}:${u.coche}`, u);
      }

      const sameDriverLoose = (legA, nameA, legB, nameB) => {
        const lA = String(legA || '').trim().toUpperCase();
        const lB = String(legB || '').trim().toUpperCase();
        if (lA && lB) return lA === lB;
        const nA = String(nameA || '').trim().replace(/\.+$/, '').toUpperCase();
        const nB = String(nameB || '').trim().replace(/\.+$/, '').toUpperCase();
        return !nA || !nB || nA === nB;
      };

      const linesMap = new Map();
      const ensureLineBucket = (cod, desc) => {
        if (!linesMap.has(cod)) {
          linesMap.set(cod, {
            codigoLinea: cod,
            descripcionLinea: resolvePublicLineName(cod, desc),
            capacity: capByLine.get(cod) || null,
            daysSet: new Set([todayKey]),
            coches: [],
            choferes: [],
            dayTripsByDay: {},
            dayObsByDay: {},
            lastSeenAt: 0
          });
        }
        return linesMap.get(cod);
      };

      const activeUnits = [];
      for (const r of carRows) {
        const cod = Number(r.codigo_linea);
        if (!cod || REMOVED_LINE_CODES.has(cod)) continue;
        const bucket = ensureLineBucket(cod, r.descripcion_linea);
        if (r.last_day_key) bucket.daysSet.add(r.last_day_key);
        bucket.lastSeenAt = Math.max(bucket.lastSeenAt, Number(r.last_seen_at) || 0);

        const u = unitMap.get(`${cod}:${r.coche}`) || null;
        const uFreshForCar = Boolean(
          u &&
            u.day_key === r.last_day_key &&
            Math.abs((u.updated_at || 0) - (r.last_seen_at || 0)) <= 25 * 60 * 1000 &&
            sameDriverLoose(u.chofer_legajo, u.chofer_nombre, r.last_chofer_legajo, r.last_chofer_nombre)
        );
        const lat = r.last_lat ?? (uFreshForCar ? u?.lat : null) ?? null;
        const lng = r.last_lng ?? (uFreshForCar ? u?.lng : null) ?? null;
        const tripKey = r.last_trip_key || (uFreshForCar ? u.trip_key : '') || '';
        const desvioSec = r.last_desvio_raw ? r.last_desvio_sec : uFreshForCar ? u?.desvio_sec || 0 : 0;
        const desvioRaw = r.last_desvio_raw || (uFreshForCar ? u?.desvio_raw : '') || '';
        const enLineaAhora = r.last_day_key === todayKey && Number(r.last_seen_at) >= activeCutoff;

        bucket.coches.push({
          coche: r.coche,
          esAdaptado: Boolean(r.es_adaptado),
          vistoHoy: r.last_day_key === todayKey,
          enLineaAhora,
          lastChoferNombre: r.last_chofer_nombre || '',
          lastChoferLegajo: r.last_chofer_legajo || '',
          lastBandera: r.last_bandera || '',
          lastGps: r.last_gps || '',
          lastStopId: r.last_stop_id || '',
          lastLat: Number.isFinite(Number(lat)) ? Number(lat) : null,
          lastLng: Number.isFinite(Number(lng)) ? Number(lng) : null,
          lastDesvioSec: Number(desvioSec) || 0,
          lastDesvioRaw: desvioRaw,
          lastTripKey: tripKey,
          lastServiceNum: Number(r.last_service_num) || 0,
          lastTurnoIdx: Number(r.last_turno_idx) || 0,
          lastTurnoStart: r.last_turno_start || '',
          lastTurnoEnd: r.last_turno_end || '',
          lastLapNum: Number(r.last_lap_num) || 0,
          lastShiftLaps: Number(r.last_shift_laps) || 0,
          dirBandera: u?.dir_bandera || '',
          firstSeenAt: r.first_seen_at,
          lastSeenAt: r.last_seen_at,
          lastDayKey: r.last_day_key,
          seenCount: r.seen_count || 1
        });

        if (enLineaAhora) {
          const rGpsMs = parseGpsStampMs(r.last_gps) || 0;
          const uGpsMs = parseGpsStampMs(u?.ultima_gps) || 0;
          const useUnitGps = Boolean(
            u &&
              uGpsMs > rGpsMs &&
              Number.isFinite(Number(u.lat)) &&
              Number.isFinite(Number(u.lng)) &&
              (Number(u.lat) !== 0 || Number(u.lng) !== 0)
          );
          const aLat = Number(useUnitGps ? u.lat : (r.last_lat ?? u?.lat));
          const aLng = Number(useUnitGps ? u.lng : (r.last_lng ?? u?.lng));
          if (Number.isFinite(aLat) && Number.isFinite(aLng) && (aLat !== 0 || aLng !== 0)) {
            activeUnits.push({
              codigoLinea: cod,
              descripcionLinea: bucket.descripcionLinea,
              coche: r.coche,
              choferNombre: r.last_chofer_nombre || '',
              choferLegajo: r.last_chofer_legajo || '',
              esAdaptado: Boolean(r.es_adaptado),
              bandera: (useUnitGps ? u?.bandera : r.last_bandera) || r.last_bandera || u?.bandera || '',
              dirBandera: u?.dir_bandera || '',
              lat: aLat,
              lng: aLng,
              desvioSec: Number(useUnitGps ? u?.desvio_sec : (r.last_desvio_raw ? r.last_desvio_sec : u?.desvio_sec)) || 0,
              desvioRaw: (useUnitGps ? u?.desvio_raw : r.last_desvio_raw) || r.last_desvio_raw || u?.desvio_raw || '',
              ultimaGps: (useUnitGps ? u?.ultima_gps : r.last_gps) || r.last_gps || u?.ultima_gps || '',
              gpsTrail: u?.gps_trail ? this._parseGpsTrail(u.gps_trail) : [],
              lastStopId: r.last_stop_id || '',
              lastTripKey: r.last_trip_key || (u?.day_key === todayKey ? u.trip_key : '') || '',
              lastServiceNum: Number(r.last_service_num) || 0,
              lastTurnoIdx: Number(r.last_turno_idx) || 0,
              lastTurnoStart: r.last_turno_start || '',
              lastTurnoEnd: r.last_turno_end || '',
              lastLapNum: Number(r.last_lap_num) || 0,
              lastShiftLaps: Number(r.last_shift_laps) || 0,
              lastSeenAt: Math.max(Number(r.last_seen_at) || 0, Number(u?.updated_at) || 0),
              enLineaAhora: true
            });
          }
        }
      }

      for (const r of drvRows) {
        const cod = Number(r.codigo_linea);
        if (!cod || REMOVED_LINE_CODES.has(cod)) continue;
        const bucket = ensureLineBucket(cod, r.descripcion_linea);
        if (r.last_day_key) bucket.daysSet.add(r.last_day_key);
        bucket.lastSeenAt = Math.max(bucket.lastSeenAt, Number(r.last_seen_at) || 0);

        const u = r.last_coche ? unitMap.get(`${cod}:${r.last_coche}`) : null;
        const isSameCarFresh = Boolean(
          u &&
            u.day_key === r.last_day_key &&
            Math.abs((u.updated_at || 0) - (r.last_seen_at || 0)) <= 25 * 60 * 1000 &&
            sameDriverLoose(u.chofer_legajo, u.chofer_nombre, r.chofer_legajo, r.chofer_nombre)
        );
        const lat = r.last_lat ?? (isSameCarFresh ? u?.lat : null) ?? null;
        const lng = r.last_lng ?? (isSameCarFresh ? u?.lng : null) ?? null;
        const tripKey = r.last_trip_key || (isSameCarFresh ? u?.trip_key : '') || '';
        const desvioSec = r.last_desvio_raw ? r.last_desvio_sec : isSameCarFresh ? u?.desvio_sec || 0 : 0;
        const desvioRaw = r.last_desvio_raw || (isSameCarFresh ? u?.desvio_raw : '') || '';

        bucket.choferes.push({
          driverKey: r.driver_key,
          choferNombre: r.chofer_nombre,
          choferLegajo: r.chofer_legajo || '',
          lastCoche: r.last_coche || '',
          lastEsAdaptado: Boolean(r.last_es_adaptado),
          vistoHoy: r.last_day_key === todayKey,
          enLineaAhora: r.last_day_key === todayKey && Number(r.last_seen_at) >= activeCutoff,
          lastBandera: r.last_bandera || '',
          lastGps: r.last_gps || '',
          lastStopId: r.last_stop_id || '',
          lastLat: Number.isFinite(Number(lat)) ? Number(lat) : null,
          lastLng: Number.isFinite(Number(lng)) ? Number(lng) : null,
          lastDesvioSec: Number(desvioSec) || 0,
          lastDesvioRaw: desvioRaw,
          lastTripKey: tripKey,
          lastServiceNum: Number(r.last_service_num) || 0,
          lastTurnoIdx: Number(r.last_turno_idx) || 0,
          lastTurnoStart: r.last_turno_start || '',
          lastTurnoEnd: r.last_turno_end || '',
          lastLapNum: Number(r.last_lap_num) || 0,
          lastShiftLaps: Number(r.last_shift_laps) || 0,
          firstSeenAt: r.first_seen_at,
          lastSeenAt: r.last_seen_at,
          lastDayKey: r.last_day_key,
          seenCount: r.seen_count || 1
        });
      }

      for (const t of tripRows) {
        const cod = Number(t.codigo_linea);
        if (!cod || REMOVED_LINE_CODES.has(cod) || !t.day_key) continue;
        const bucket = ensureLineBucket(cod, '');
        bucket.daysSet.add(t.day_key);
        if (!bucket.dayTripsByDay[t.day_key]) bucket.dayTripsByDay[t.day_key] = [];
        bucket.dayTripsByDay[t.day_key].push({
          tripKey: t.trip_key,
          turnoHora: t.turno_hora,
          coche: t.coche,
          choferNombre: t.chofer_nombre || '',
          choferLegajo: t.chofer_legajo || '',
          esAdaptado: Boolean(t.es_adaptado),
          desvioSec: t.desvio_sec || 0,
          desvioRaw: t.desvio_raw || '',
          ultimaGps: t.ultima_gps || '',
          lat: t.lat,
          lng: t.lng,
          stopId: t.stop_id || '',
          updatedAt: t.updated_at
        });
      }

      for (const o of obsRows) {
        const cod = Number(o.codigo_linea);
        if (!cod || REMOVED_LINE_CODES.has(cod) || !o.day_key) continue;
        const bucket = ensureLineBucket(cod, '');
        bucket.daysSet.add(o.day_key);
        if (!bucket.dayObsByDay[o.day_key]) bucket.dayObsByDay[o.day_key] = [];
        bucket.dayObsByDay[o.day_key].push({
          dayKey: o.day_key,
          coche: o.coche,
          driverKey: o.driver_key,
          choferNombre: o.chofer_nombre || '',
          choferLegajo: o.chofer_legajo || '',
          esAdaptado: Boolean(o.es_adaptado),
          lastBandera: o.last_bandera || '',
          lastGps: o.last_gps || '',
          lastStopId: o.last_stop_id || '',
          lastLat: Number.isFinite(Number(o.last_lat)) ? Number(o.last_lat) : null,
          lastLng: Number.isFinite(Number(o.last_lng)) ? Number(o.last_lng) : null,
          lastDesvioSec: Number(o.last_desvio_sec) || 0,
          lastDesvioRaw: o.last_desvio_raw || '',
          lastTripKey: o.last_trip_key || '',
          lastServiceNum: Number(o.last_service_num) || 0,
          lastTurnoIdx: Number(o.last_turno_idx) || 0,
          firstSeenAt: o.first_seen_at,
          lastSeenAt: o.last_seen_at,
          seenCount: o.seen_count || 1
        });
      }

      const resumenLineas = [];
      const lines = {};
      for (const bucket of linesMap.values()) {
        bucket.coches.sort((a, b) => {
          if (a.enLineaAhora !== b.enLineaAhora) return a.enLineaAhora ? -1 : 1;
          if (a.vistoHoy !== b.vistoHoy) return a.vistoHoy ? -1 : 1;
          if (b.lastSeenAt !== a.lastSeenAt) return b.lastSeenAt - a.lastSeenAt;
          return compareCocheIds(a.coche, b.coche);
        });
        bucket.choferes.sort((a, b) => {
          if (a.enLineaAhora !== b.enLineaAhora) return a.enLineaAhora ? -1 : 1;
          if (a.vistoHoy !== b.vistoHoy) return a.vistoHoy ? -1 : 1;
          if (b.lastSeenAt !== a.lastSeenAt) return b.lastSeenAt - a.lastSeenAt;
          return a.choferNombre.localeCompare(b.choferNombre, 'es');
        });
        const cap = bucket.capacity;
        resumenLineas.push({
          codigoLinea: bucket.codigoLinea,
          descripcionLinea: bucket.descripcionLinea,
          cochesHoy: bucket.coches.filter((c) => c.vistoHoy).length,
          cochesSemana: bucket.coches.length,
          choferesHoy: bucket.choferes.filter((d) => d.vistoHoy).length,
          choferesSemana: bucket.choferes.length,
          activeNow: cap?.activeNow || 0,
          peakSimultaneousToday: cap?.peakSimultaneousToday || 0,
          replacementSwapsToday: cap?.replacementSwapsToday || 0,
          learnedTypicalToday: cap?.learnedTypicalToday || 0,
          lastSeenAt: bucket.lastSeenAt
        });
        lines[String(bucket.codigoLinea)] = {
          codigoLinea: bucket.codigoLinea,
          descripcionLinea: bucket.descripcionLinea,
          capacity: cap,
          daysWithData: Array.from(bucket.daysSet).sort().reverse(),
          coches: bucket.coches,
          choferes: bucket.choferes,
          dayTripsByDay: bucket.dayTripsByDay,
          dayObsByDay: bucket.dayObsByDay
        };
      }

      resumenLineas.sort((a, b) =>
        a.descripcionLinea.localeCompare(b.descripcionLinea, 'es', { numeric: true })
      );

      const liveHorarios = this._buildLiveHorariosPayload([], 0, '');

      return Response.json({
        dayKey: todayKey,
        retentionDays: ROSTER_RETENTION_DAYS,
        activeWindowMin: Math.round(SIMULTANEOUS_ACTIVE_WINDOW_MS / 60000),
        meta: metaSummary,
        resumen: {
          dayKey: todayKey,
          retentionDays: ROSTER_RETENTION_DAYS,
          meta: metaSummary,
          lineas: resumenLineas
        },
        activeUnits,
        lines,
        liveHorarios
      });
    }

    if (request.method === 'POST' && url.pathname === '/live-city-ingest') {
      const body = await request.json().catch(() => ({}));
      const units = Array.isArray(body.units) ? body.units : [];
      const touchedLines = new Set();
      let count = 0;
      for (const u of units) {
        const cod = Number(u.codigoLinea);
        const coche = String(u.coche || u.identificadorCoche || '').trim();
        if (!cod || !coche || REMOVED_LINE_CODES.has(cod)) continue;
        const lat = Number.isFinite(Number(u.lat)) ? Number(u.lat) : null;
        const lng = Number.isFinite(Number(u.lng)) ? Number(u.lng) : null;
        const ultimaGps = String(u.ultimaGps || '').trim();
        const mergedTrail = this._mergeUnitTrail(cod, coche, u.gpsTrail, lat, lng, ultimaGps, nowMs);
        this.sql.exec(
          `INSERT INTO unit_last_seen (
            codigo_linea, coche, day_key, trip_key, chofer_nombre, chofer_legajo, chofer_raw,
            es_adaptado, desvio_sec, desvio_raw, bandera, ultima_gps, lat, lng, stop_id, gps_trail, updated_at
          ) VALUES (?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(codigo_linea, coche) DO UPDATE SET
            day_key = excluded.day_key,
            chofer_nombre = CASE WHEN excluded.chofer_nombre != '' THEN excluded.chofer_nombre ELSE unit_last_seen.chofer_nombre END,
            chofer_legajo = CASE WHEN excluded.chofer_legajo != '' THEN excluded.chofer_legajo ELSE unit_last_seen.chofer_legajo END,
            chofer_raw = CASE WHEN excluded.chofer_raw != '' THEN excluded.chofer_raw ELSE unit_last_seen.chofer_raw END,
            es_adaptado = MAX(unit_last_seen.es_adaptado, excluded.es_adaptado),
            desvio_sec = excluded.desvio_sec,
            desvio_raw = CASE WHEN excluded.desvio_raw != '' THEN excluded.desvio_raw ELSE unit_last_seen.desvio_raw END,
            bandera = CASE WHEN excluded.bandera != '' THEN excluded.bandera ELSE unit_last_seen.bandera END,
            ultima_gps = CASE WHEN excluded.ultima_gps != '' THEN excluded.ultima_gps ELSE unit_last_seen.ultima_gps END,
            lat = COALESCE(excluded.lat, unit_last_seen.lat),
            lng = COALESCE(excluded.lng, unit_last_seen.lng),
            stop_id = CASE WHEN excluded.stop_id != '' THEN excluded.stop_id ELSE unit_last_seen.stop_id END,
            gps_trail = CASE WHEN excluded.gps_trail != '' THEN excluded.gps_trail ELSE unit_last_seen.gps_trail END,
            updated_at = excluded.updated_at`,
          cod,
          coche,
          todayKey,
          String(u.choferNombre || '').trim(),
          String(u.choferLegajo || '').trim(),
          String(u.choferRaw || '').trim(),
          u.esAdaptado ? 1 : 0,
          Number.isFinite(u.desvioSec) ? Math.round(u.desvioSec) : 0,
          String(u.desvioRaw || '').trim(),
          String(u.bandera || '').trim(),
          ultimaGps,
          lat,
          lng,
          String(u.stopId || '').trim().toUpperCase(),
          mergedTrail,
          nowMs
        );
        this._upsertRosterUnit(u, nowMs);
        touchedLines.add(cod);
        count++;
      }
      if (touchedLines.size > 0) {
        this._updateLiveCapacity(nowMs, todayKey, Array.from(touchedLines));
      }
      this._setMeta('last_live_at', nowMs);
      return Response.json({ ok: true, count, lastLiveAt: nowMs });
    }

    if (request.method === 'GET' && url.pathname === '/flota-buscar') {
      const rawQ = String(url.searchParams.get('q') || '').trim();
      const normQ = normalizeDriverNameKey(rawQ);
      if (normQ.length < 2) {
        return Response.json({ dayKey: todayKey, results: [] });
      }
      const minTs = nowMs - ROSTER_RETENTION_MS;
      const activeCutoff = nowMs - SIMULTANEOUS_ACTIVE_WINDOW_MS;

      const carRows = this.sql
        .exec(
          `SELECT codigo_linea, coche, descripcion_linea, es_adaptado,
                  last_chofer_nombre, last_chofer_legajo,
                  last_bandera, last_gps, last_stop_id,
                  last_lat, last_lng, last_desvio_sec, last_desvio_raw,
                  last_trip_key, last_service_num, last_turno_idx, last_turno_start, last_turno_end,
                  last_lap_num, last_shift_laps,
                  last_seen_at, last_day_key
           FROM fleet_cars
           WHERE last_seen_at >= ?
           ORDER BY last_seen_at DESC`,
          minTs
        )
        .toArray();

      const drvRows = this.sql
        .exec(
          `SELECT codigo_linea, driver_key, descripcion_linea, chofer_nombre, chofer_legajo,
                  last_coche, last_es_adaptado, last_bandera, last_gps, last_stop_id,
                  last_lat, last_lng, last_desvio_sec, last_desvio_raw,
                  last_trip_key, last_service_num, last_turno_idx, last_turno_start, last_turno_end,
                  last_lap_num, last_shift_laps,
                  last_seen_at, last_day_key
           FROM fleet_drivers
           WHERE last_seen_at >= ?
           ORDER BY last_seen_at DESC`,
          minTs
        )
        .toArray();

      const unitRows = this.sql
        .exec('SELECT codigo_linea, coche, day_key, trip_key, lat, lng, desvio_sec, desvio_raw FROM unit_last_seen')
        .toArray();
      const unitMap = new Map();
      for (const u of unitRows) unitMap.set(`${u.codigo_linea}:${u.coche}`, u);

      const matches = [];
      for (const r of carRows) {
        const hay = normalizeDriverNameKey(`${r.coche} ${r.descripcion_linea || LINE_NAMES_BY_CODE[r.codigo_linea] || ''}`);
        if (!hay.includes(normQ) && !String(r.coche || '').toUpperCase().includes(rawQ.toUpperCase())) continue;
        const u = unitMap.get(`${r.codigo_linea}:${r.coche}`) || null;
        const lat = r.last_lat ?? u?.lat ?? null;
        const lng = r.last_lng ?? u?.lng ?? null;
        const enLineaAhora = r.last_day_key === todayKey && Number(r.last_seen_at) >= activeCutoff;
        matches.push({
          type: 'coche',
          codigoLinea: r.codigo_linea,
          descripcionLinea: r.descripcion_linea || LINE_NAMES_BY_CODE[r.codigo_linea] || `L${r.codigo_linea}`,
          coche: r.coche,
          choferNombre: r.last_chofer_nombre || '',
          choferLegajo: r.last_chofer_legajo || '',
          esAdaptado: Boolean(r.es_adaptado),
          vistoHoy: r.last_day_key === todayKey,
          enLineaAhora,
          lastBandera: r.last_bandera || '',
          lastGps: r.last_gps || '',
          lastStopId: r.last_stop_id || '',
          lastLat: Number.isFinite(Number(lat)) ? Number(lat) : null,
          lastLng: Number.isFinite(Number(lng)) ? Number(lng) : null,
          lastDesvioSec: Number(r.last_desvio_raw ? r.last_desvio_sec : u?.desvio_sec) || 0,
          lastDesvioRaw: r.last_desvio_raw || u?.desvio_raw || '',
          lastTripKey: r.last_trip_key || (u?.day_key === r.last_day_key ? u.trip_key : '') || '',
          lastServiceNum: Number(r.last_service_num) || 0,
          lastTurnoIdx: Number(r.last_turno_idx) || 0,
          lastTurnoStart: r.last_turno_start || '',
          lastTurnoEnd: r.last_turno_end || '',
          lastLapNum: Number(r.last_lap_num) || 0,
          lastShiftLaps: Number(r.last_shift_laps) || 0,
          lastSeenAt: r.last_seen_at,
          lastDayKey: r.last_day_key
        });
      }

      for (const r of drvRows) {
        const hay = normalizeDriverNameKey(`${r.chofer_nombre} ${r.chofer_legajo || ''}`);
        if (!hay.includes(normQ)) continue;
        const u = r.last_coche ? unitMap.get(`${r.codigo_linea}:${r.last_coche}`) : null;
        const lat = r.last_lat ?? u?.lat ?? null;
        const lng = r.last_lng ?? u?.lng ?? null;
        const enLineaAhora = r.last_day_key === todayKey && Number(r.last_seen_at) >= activeCutoff;
        matches.push({
          type: 'chofer',
          driverKey: r.driver_key,
          codigoLinea: r.codigo_linea,
          descripcionLinea: r.descripcion_linea || LINE_NAMES_BY_CODE[r.codigo_linea] || `L${r.codigo_linea}`,
          coche: r.last_coche || '',
          choferNombre: r.chofer_nombre,
          choferLegajo: r.chofer_legajo || '',
          esAdaptado: Boolean(r.last_es_adaptado),
          vistoHoy: r.last_day_key === todayKey,
          enLineaAhora,
          lastBandera: r.last_bandera || '',
          lastGps: r.last_gps || '',
          lastStopId: r.last_stop_id || '',
          lastLat: Number.isFinite(Number(lat)) ? Number(lat) : null,
          lastLng: Number.isFinite(Number(lng)) ? Number(lng) : null,
          lastDesvioSec: Number(r.last_desvio_raw ? r.last_desvio_sec : u?.desvio_sec) || 0,
          lastDesvioRaw: r.last_desvio_raw || u?.desvio_raw || '',
          lastTripKey: r.last_trip_key || (u?.day_key === r.last_day_key ? u.trip_key : '') || '',
          lastServiceNum: Number(r.last_service_num) || 0,
          lastTurnoIdx: Number(r.last_turno_idx) || 0,
          lastTurnoStart: r.last_turno_start || '',
          lastTurnoEnd: r.last_turno_end || '',
          lastLapNum: Number(r.last_lap_num) || 0,
          lastShiftLaps: Number(r.last_shift_laps) || 0,
          lastSeenAt: r.last_seen_at,
          lastDayKey: r.last_day_key
        });
      }

      matches.sort((a, b) => {
        if (a.enLineaAhora !== b.enLineaAhora) return a.enLineaAhora ? -1 : 1;
        if (a.vistoHoy !== b.vistoHoy) return a.vistoHoy ? -1 : 1;
        return (b.lastSeenAt || 0) - (a.lastSeenAt || 0);
      });

      return Response.json({
        dayKey: todayKey,
        results: matches.slice(0, 12)
      });
    }

    if (request.method === 'POST' && url.pathname === '/record-units') {
      const body = await request.json().catch(() => ({}));
      const units = Array.isArray(body.units) ? body.units : [];
      let count = 0;
      const touchedLines = new Set();
      for (const u of units) {
        const cod = Number(u.codigoLinea);
        const coche = String(u.coche || '').trim();
        if (!cod || !coche || REMOVED_LINE_CODES.has(cod)) continue;
        const lat = Number.isFinite(u.lat) ? u.lat : null;
        const lng = Number.isFinite(u.lng) ? u.lng : null;
        const ultimaGps = String(u.ultimaGps || '').trim();
        const mergedTrail = this._mergeUnitTrail(cod, coche, u.gpsTrail, lat, lng, ultimaGps, nowMs);
        this.sql.exec(
          `INSERT INTO unit_last_seen (
            codigo_linea, coche, day_key, trip_key, chofer_nombre, chofer_legajo, chofer_raw,
            es_adaptado, desvio_sec, desvio_raw, bandera, ultima_gps, lat, lng, stop_id, gps_trail, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(codigo_linea, coche) DO UPDATE SET
            day_key = excluded.day_key,
            trip_key = CASE WHEN excluded.trip_key != '' THEN excluded.trip_key ELSE unit_last_seen.trip_key END,
            chofer_nombre = CASE WHEN excluded.chofer_nombre != '' THEN excluded.chofer_nombre ELSE unit_last_seen.chofer_nombre END,
            chofer_legajo = CASE WHEN excluded.chofer_legajo != '' THEN excluded.chofer_legajo ELSE unit_last_seen.chofer_legajo END,
            chofer_raw = CASE WHEN excluded.chofer_raw != '' THEN excluded.chofer_raw ELSE unit_last_seen.chofer_raw END,
            es_adaptado = excluded.es_adaptado,
            desvio_sec = excluded.desvio_sec,
            desvio_raw = CASE WHEN excluded.desvio_raw != '' THEN excluded.desvio_raw ELSE unit_last_seen.desvio_raw END,
            bandera = CASE WHEN excluded.bandera != '' THEN excluded.bandera ELSE unit_last_seen.bandera END,
            ultima_gps = CASE WHEN excluded.ultima_gps != '' THEN excluded.ultima_gps ELSE unit_last_seen.ultima_gps END,
            lat = COALESCE(excluded.lat, unit_last_seen.lat),
            lng = COALESCE(excluded.lng, unit_last_seen.lng),
            stop_id = CASE WHEN excluded.stop_id != '' THEN excluded.stop_id ELSE unit_last_seen.stop_id END,
            gps_trail = CASE WHEN excluded.gps_trail != '' THEN excluded.gps_trail ELSE unit_last_seen.gps_trail END,
            updated_at = excluded.updated_at`,
          cod,
          coche,
          todayKey,
          String(u.tripKey || '').trim(),
          String(u.choferNombre || '').trim(),
          String(u.choferLegajo || '').trim(),
          String(u.choferRaw || '').trim(),
          u.esAdaptado ? 1 : 0,
          Number.isFinite(u.desvioSec) ? Math.round(u.desvioSec) : 0,
          String(u.desvioRaw || '').trim(),
          String(u.bandera || '').trim(),
          ultimaGps,
          lat,
          lng,
          String(u.stopId || '').trim().toUpperCase(),
          mergedTrail,
          nowMs
        );
        this._upsertRosterUnit(u, nowMs, todayKey);
        touchedLines.add(cod);
        count++;
      }
      if (touchedLines.size > 0) {
        this._updateLiveCapacity(nowMs, todayKey, Array.from(touchedLines));
      }
      if (body.stopSnapshot && body.stopSnapshot.idParada) {
        const sid = String(body.stopSnapshot.idParada).trim().toUpperCase();
        this.sql.exec(
          `INSERT INTO stop_last_arribos (stop_id, payload_json, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT(stop_id) DO UPDATE SET
             payload_json = excluded.payload_json,
             updated_at = excluded.updated_at`,
          sid,
          JSON.stringify(body.stopSnapshot),
          nowMs
        );
      }
      return Response.json({ ok: true, count });
    }

    if (request.method === 'POST' && url.pathname === '/record-trips') {
      const body = await request.json().catch(() => ({}));
      const entries = Array.isArray(body.entries) ? body.entries : [];
      const dayKey = String(body.dayKey || todayKey).slice(0, 10);
      let count = 0;
      const touchedLines = new Set();

      for (const e of entries) {
        const cod = Number(e.codigoLinea ?? body.codigoLinea);
        const tripKey = String(e.tripKey || '').trim();
        const coche = String(e.coche || '').trim();
        if (!cod || !tripKey || !coche || REMOVED_LINE_CODES.has(cod)) continue;

        const lat = Number.isFinite(Number(e.lat)) ? Number(e.lat) : null;
        const lng = Number.isFinite(Number(e.lng)) ? Number(e.lng) : null;
        const desvioSec = Number.isFinite(Number(e.desvioSec)) ? Math.round(Number(e.desvioSec)) : 0;
        const ultimaGps = String(e.ultimaGps || '').trim();
        const dirBandera = String(e.dirBandera || '').trim();
        const supersededTripKey = String(e.supersededTripKey || '').trim();
        const mergedTrail = this._mergeUnitTrail(cod, coche, e.gpsTrail, lat, lng, ultimaGps, nowMs);

        // Self-correction cleanup: if global matching moved this car off an earlier misassigned service,
        // remove the stale trip_assignments row if it still points to this same car!
        if (supersededTripKey && supersededTripKey !== tripKey) {
          this.sql.exec(
            'DELETE FROM trip_assignments WHERE day_key = ? AND codigo_linea = ? AND trip_key = ? AND coche = ?',
            dayKey,
            cod,
            supersededTripKey,
            coche
          );
        }

        this.sql.exec(
          `INSERT INTO trip_assignments (
            day_key, codigo_linea, trip_key, turno_hora, coche, chofer_nombre, chofer_legajo,
            chofer_raw, es_adaptado, desvio_sec, desvio_raw, ultima_gps, lat, lng, stop_id, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(day_key, codigo_linea, trip_key) DO UPDATE SET
            turno_hora = CASE WHEN excluded.turno_hora != '' THEN excluded.turno_hora ELSE trip_assignments.turno_hora END,
            coche = excluded.coche,
            chofer_nombre = CASE WHEN excluded.chofer_nombre != '' THEN excluded.chofer_nombre ELSE trip_assignments.chofer_nombre END,
            chofer_legajo = CASE WHEN excluded.chofer_legajo != '' THEN excluded.chofer_legajo ELSE trip_assignments.chofer_legajo END,
            chofer_raw = CASE WHEN excluded.chofer_raw != '' THEN excluded.chofer_raw ELSE trip_assignments.chofer_raw END,
            es_adaptado = excluded.es_adaptado,
            desvio_sec = excluded.desvio_sec,
            desvio_raw = CASE WHEN excluded.desvio_raw != '' THEN excluded.desvio_raw ELSE trip_assignments.desvio_raw END,
            ultima_gps = CASE WHEN excluded.ultima_gps != '' THEN excluded.ultima_gps ELSE trip_assignments.ultima_gps END,
            lat = COALESCE(excluded.lat, trip_assignments.lat),
            lng = COALESCE(excluded.lng, trip_assignments.lng),
            stop_id = CASE WHEN excluded.stop_id != '' THEN excluded.stop_id ELSE trip_assignments.stop_id END,
            updated_at = excluded.updated_at`,
          dayKey,
          cod,
          tripKey,
          String(e.turnoHora || '').trim(),
          coche,
          String(e.choferNombre || '').trim(),
          String(e.choferLegajo || '').trim(),
          String(e.choferRaw || '').trim(),
          e.esAdaptado ? 1 : 0,
          desvioSec,
          String(e.desvioRaw || '').trim(),
          ultimaGps,
          lat,
          lng,
          String(e.stopId || '').trim().toUpperCase(),
          nowMs
        );

        this.sql.exec(
          `INSERT INTO unit_last_seen (
            codigo_linea, coche, day_key, trip_key, chofer_nombre, chofer_legajo, chofer_raw,
            es_adaptado, desvio_sec, desvio_raw, bandera, ultima_gps, lat, lng, stop_id, gps_trail, dir_bandera, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(codigo_linea, coche) DO UPDATE SET
            day_key = excluded.day_key,
            trip_key = excluded.trip_key,
            chofer_nombre = CASE WHEN excluded.chofer_nombre != '' THEN excluded.chofer_nombre ELSE unit_last_seen.chofer_nombre END,
            chofer_legajo = CASE WHEN excluded.chofer_legajo != '' THEN excluded.chofer_legajo ELSE unit_last_seen.chofer_legajo END,
            chofer_raw = CASE WHEN excluded.chofer_raw != '' THEN excluded.chofer_raw ELSE unit_last_seen.chofer_raw END,
            es_adaptado = excluded.es_adaptado,
            desvio_sec = excluded.desvio_sec,
            desvio_raw = CASE WHEN excluded.desvio_raw != '' THEN excluded.desvio_raw ELSE unit_last_seen.desvio_raw END,
            bandera = CASE WHEN excluded.bandera != '' THEN excluded.bandera ELSE unit_last_seen.bandera END,
            ultima_gps = CASE WHEN excluded.ultima_gps != '' THEN excluded.ultima_gps ELSE unit_last_seen.ultima_gps END,
            lat = COALESCE(excluded.lat, unit_last_seen.lat),
            lng = COALESCE(excluded.lng, unit_last_seen.lng),
            stop_id = CASE WHEN excluded.stop_id != '' THEN excluded.stop_id ELSE unit_last_seen.stop_id END,
            gps_trail = CASE WHEN excluded.gps_trail != '' THEN excluded.gps_trail ELSE unit_last_seen.gps_trail END,
            dir_bandera = CASE WHEN excluded.dir_bandera != '' THEN excluded.dir_bandera ELSE unit_last_seen.dir_bandera END,
            updated_at = excluded.updated_at`,
          cod,
          coche,
          dayKey,
          tripKey,
          String(e.choferNombre || '').trim(),
          String(e.choferLegajo || '').trim(),
          String(e.choferRaw || '').trim(),
          e.esAdaptado ? 1 : 0,
          desvioSec,
          String(e.desvioRaw || '').trim(),
          String(e.bandera || '').trim(),
          ultimaGps,
          lat,
          lng,
          String(e.stopId || '').trim().toUpperCase(),
          mergedTrail,
          dirBandera,
          nowMs
        );
        this._upsertRosterUnit({ ...e, codigoLinea: cod, coche }, nowMs, dayKey);
        touchedLines.add(cod);
        count++;
      }

      if (touchedLines.size > 0) {
        this._updateLiveCapacity(nowMs, dayKey, Array.from(touchedLines));
      }
      if (Math.random() < 0.05) this._pruneOld(nowMs);
      return Response.json({ ok: true, count, dayKey });
    }

    if (request.method === 'GET' && url.pathname === '/query') {
      const rawLineas = url.searchParams.get('lineas') || url.searchParams.get('codLinea') || '';
      const lineCodes = rawLineas
        .split(',')
        .map((n) => Number(n.trim()))
        .filter((n) => Number.isInteger(n) && n > 0);
      const dayKey = String(url.searchParams.get('dayKey') || todayKey).slice(0, 10);

      let tripRows;
      let unitRows;
      if (lineCodes.length > 0) {
        const ph = lineCodes.map(() => '?').join(',');
        tripRows = this.sql
          .exec(
            `SELECT codigo_linea, trip_key, turno_hora, coche, chofer_nombre, chofer_legajo, chofer_raw,
                    es_adaptado, desvio_sec, desvio_raw, ultima_gps, lat, lng, stop_id, updated_at
             FROM trip_assignments
             WHERE (day_key = ? OR updated_at > ?) AND codigo_linea IN (${ph})
             ORDER BY updated_at DESC`,
            dayKey,
            nowMs - 4 * 3600 * 1000,
            ...lineCodes
          )
          .toArray();
        unitRows = this.sql
          .exec(
            `SELECT codigo_linea, coche, day_key, trip_key, chofer_nombre, chofer_legajo, chofer_raw,
                    es_adaptado, desvio_sec, desvio_raw, bandera, ultima_gps, lat, lng, stop_id, gps_trail, dir_bandera, updated_at
             FROM unit_last_seen
             WHERE codigo_linea IN (${ph}) AND updated_at > ?
             ORDER BY updated_at DESC`,
            ...lineCodes,
            nowMs - 24 * 3600 * 1000
          )
          .toArray();
      } else {
        tripRows = this.sql
          .exec(
            `SELECT codigo_linea, trip_key, turno_hora, coche, chofer_nombre, chofer_legajo, chofer_raw,
                    es_adaptado, desvio_sec, desvio_raw, ultima_gps, lat, lng, stop_id, updated_at
             FROM trip_assignments
             WHERE day_key = ? OR updated_at > ?
             ORDER BY updated_at DESC LIMIT 600`,
            dayKey,
            nowMs - 4 * 3600 * 1000
          )
          .toArray();
        unitRows = this.sql
          .exec(
            `SELECT codigo_linea, coche, day_key, trip_key, chofer_nombre, chofer_legajo, chofer_raw,
                    es_adaptado, desvio_sec, desvio_raw, bandera, ultima_gps, lat, lng, stop_id, gps_trail, dir_bandera, updated_at
             FROM unit_last_seen
             WHERE updated_at > ?
             ORDER BY updated_at DESC LIMIT 600`,
            nowMs - 24 * 3600 * 1000
          )
          .toArray();
      }

      const stopIdParam = String(url.searchParams.get('idParada') || '').trim().toUpperCase();
      let stopSnapshot = null;
      if (stopIdParam) {
        const sRows = this.sql
          .exec('SELECT payload_json, updated_at FROM stop_last_arribos WHERE stop_id = ?', stopIdParam)
          .toArray();
        if (sRows.length > 0) {
          try {
            stopSnapshot = { ...JSON.parse(sRows[0].payload_json), savedAt: sRows[0].updated_at };
          } catch {
            stopSnapshot = null;
          }
        }
      }

      return Response.json({
        dayKey,
        stopSnapshot,
        learnedTransitions: [],
        trips: tripRows.map((r) => ({
          codigoLinea: r.codigo_linea,
          tripKey: r.trip_key,
          turnoHora: r.turno_hora,
          coche: r.coche,
          choferNombre: r.chofer_nombre,
          choferLegajo: r.chofer_legajo,
          choferRaw: r.chofer_raw,
          esAdaptado: Boolean(r.es_adaptado),
          desvioSec: r.desvio_sec,
          desvioRaw: r.desvio_raw,
          ultimaGps: r.ultima_gps,
          lat: r.lat,
          lng: r.lng,
          stopId: r.stop_id,
          updatedAt: r.updated_at
        })),
        units: unitRows.map((r) => ({
          codigoLinea: r.codigo_linea,
          coche: r.coche,
          dayKey: r.day_key,
          tripKey: r.trip_key,
          choferNombre: r.chofer_nombre,
          choferLegajo: r.chofer_legajo,
          choferRaw: r.chofer_raw,
          esAdaptado: Boolean(r.es_adaptado),
          desvioSec: r.desvio_sec,
          desvioRaw: r.desvio_raw,
          bandera: r.bandera,
          dirBandera: r.dir_bandera || '',
          gpsTrail: this._parseGpsTrail(r.gps_trail).map(([la, ln, ms]) => ({ lat: la, lng: ln, gpsMs: ms })),
          ultimaGps: r.ultima_gps,
          lat: r.lat,
          lng: r.lng,
          stopId: r.stop_id,
          updatedAt: r.updated_at
        }))
      });
    }

    return Response.json({ error: 'Not found' }, { status: 404 });
  }
}

// Isolate-level throttle & fallback store when Durable Object isn't bound
const isolateWriteThrottle = new Map(); // `${cod}:${coche}` -> { ts, sig }
const stopSnapThrottle = new Map(); // stopId -> ts
const fallbackTrips = new Map();
const fallbackUnits = new Map();
const fallbackStops = new Map();
const fallbackRosterCars = new Map(); // `${cod}:${coche}` -> car row
const fallbackRosterDrivers = new Map(); // `${cod}:${driverKey}` -> driver row
const fallbackRosterMeta = {
  scanCursor: 0,
  lastCronAt: null,
  lastCycleAt: null,
  totalSweeps: 0,
  lastBatchUnits: 0
};

function upsertFallbackRosterUnit(u, nowMs = Date.now(), explicitDayKey = '') {
  const cod = Number(u.codigoLinea);
  const coche = String(u.coche || u.identificadorCoche || '').trim();
  if (!cod || !coche) return;
  const ultimaGps = String(u.ultimaGps || u.ultimaFechaHoraGPS || '').trim();
  const { obsMs, obsDayKey } = resolveObservationTime(ultimaGps, nowMs);
  const effectiveDayKey = explicitDayKey && obsMs === nowMs ? explicitDayKey : obsDayKey;
  if (obsMs < nowMs - ROSTER_RETENTION_MS) return;

  const descLinea = String(u.descripcionLinea || LINE_NAMES_BY_CODE[cod] || '').trim();
  const bandera = String(u.bandera || u.descripcionBandera || '').trim();
  const stopId = String(u.stopId || '').trim().toUpperCase();
  const esAdaptado = Boolean(u.esAdaptado);
  const driver = normalizeDriverRecord(
    u.choferNombre || '',
    u.choferLegajo || '',
    u.choferRaw || u.identificadorChofer || ''
  );

  const carKey = `${cod}:${coche}`;
  const prevCar = fallbackRosterCars.get(carKey);
  const isNewerCar = !prevCar || obsMs >= prevCar.lastSeenAt;
  fallbackRosterCars.set(carKey, {
    codigoLinea: cod,
    descripcionLinea: descLinea || prevCar?.descripcionLinea || LINE_NAMES_BY_CODE[cod] || `L${cod}`,
    coche,
    esAdaptado: esAdaptado || Boolean(prevCar?.esAdaptado),
    lastChoferNombre: (isNewerCar && driver?.nombre) || prevCar?.lastChoferNombre || '',
    lastChoferLegajo: (isNewerCar && driver?.legajo) || prevCar?.lastChoferLegajo || '',
    lastBandera: (isNewerCar && bandera) || prevCar?.lastBandera || '',
    lastGps: (isNewerCar && ultimaGps) || prevCar?.lastGps || '',
    lastStopId: (isNewerCar && stopId) || prevCar?.lastStopId || '',
    firstSeenAt: prevCar ? Math.min(prevCar.firstSeenAt, obsMs) : obsMs,
    lastSeenAt: prevCar ? Math.max(prevCar.lastSeenAt, obsMs) : obsMs,
    lastDayKey: isNewerCar ? effectiveDayKey : prevCar.lastDayKey,
    seenCount: (prevCar?.seenCount || 0) + 1
  });

  if (driver) {
    let prevDrv = fallbackRosterDrivers.get(`${cod}:${driver.driverKey}`);
    if (driver.legacyNameKey && fallbackRosterDrivers.has(`${cod}:${driver.legacyNameKey}`)) {
      const legacy = fallbackRosterDrivers.get(`${cod}:${driver.legacyNameKey}`);
      fallbackRosterDrivers.delete(`${cod}:${driver.legacyNameKey}`);
      if (!prevDrv) prevDrv = legacy;
    }
    const isNewerDrv = !prevDrv || obsMs >= prevDrv.lastSeenAt;
    fallbackRosterDrivers.set(`${cod}:${driver.driverKey}`, {
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
      firstSeenAt: prevDrv ? Math.min(prevDrv.firstSeenAt, obsMs) : obsMs,
      lastSeenAt: prevDrv ? Math.max(prevDrv.lastSeenAt, obsMs) : obsMs,
      lastDayKey: isNewerDrv ? effectiveDayKey : prevDrv.lastDayKey,
      seenCount: (prevDrv?.seenCount || 0) + 1
    });
  }
}

function getFleetStub(env) {
  if (!env?.FLEET_MEMORY) return null;
  return env.FLEET_MEMORY.get(env.FLEET_MEMORY.idFromName('corrientes-v1'));
}

async function recordObservedUnits(env, arribos = [], stopId = '', stopCoords = null) {
  if (!Array.isArray(arribos) || arribos.length === 0) return;
  const nowMs = Date.now();
  const batch = [];
  for (const a of arribos) {
    const cod = Number(a.codigoLinea);
    const coche = String(a.identificadorCoche || '').trim();
    if (!cod || !coche) continue;
    const sig = `${a.choferNombre || ''}|${a.choferLegajo || ''}|${a.desvioHorario || ''}|${a.ultimaFechaHoraGPS || ''}`;
    const k = `${cod}:${coche}`;
    const prev = isolateWriteThrottle.get(k);
    if (prev && prev.sig === sig && nowMs - prev.ts < 60000) continue;
    isolateWriteThrottle.set(k, { ts: nowMs, sig });
    const lat = parseFloat(a.latitud);
    const lng = parseFloat(a.longitud);
    const item = {
      codigoLinea: cod,
      descripcionLinea: String(a.descripcionLinea || LINE_NAMES_BY_CODE[cod] || '').trim(),
      coche,
      choferNombre: a.choferNombre || '',
      choferLegajo: a.choferLegajo || '',
      choferRaw: a.identificadorChofer || '',
      esAdaptado: Boolean(a.esAdaptado),
      desvioSec: parseDesvioSeconds(a.desvioHorario),
      desvioRaw: a.desvioHorario || '',
      bandera: a.descripcionBandera || '',
      ultimaGps: a.ultimaFechaHoraGPS || '',
      lat: !Number.isNaN(lat) && lat !== 0 ? lat : null,
      lng: !Number.isNaN(lng) && lng !== 0 ? lng : null,
      stopId,
      updatedAt: nowMs
    };
    batch.push(item);
    fallbackUnits.set(k, { ...item, dayKey: getArgentinaDayKey(nowMs), tripKey: '' });
    upsertFallbackRosterUnit(item, nowMs);
  }

  let stopSnapshot = null;
  const cleanStop = String(stopId || '').trim().toUpperCase();
  if (cleanStop) {
    const lastSnapTs = stopSnapThrottle.get(cleanStop) || 0;
    if (nowMs - lastSnapTs >= 45000) {
      stopSnapThrottle.set(cleanStop, nowMs);
      stopSnapshot = {
        idParada: cleanStop,
        stopCoords: stopCoords || null,
        arribos: arribos.slice(0, 30),
        savedAt: nowMs
      };
      fallbackStops.set(cleanStop, stopSnapshot);
    }
  }

  if (batch.length === 0 && !stopSnapshot) return;
  const stub = getFleetStub(env);
  if (!stub) return;
  try {
    await stub.fetch('https://fleet-memory/record-units', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ units: batch, stopSnapshot })
    });
  } catch {
    // Non-fatal: never block live arrivals
  }
}

/**
 * Automated background fleet & driver scanner (executed by Cloudflare Cron Trigger every 5 min).
 * Rotates through FLEET_SCAN_TARGETS in gentle batches of 18 probes (<= 20 subrequests/run,
 * safely under Cloudflare Workers Free 50-subrequest limit), sweeping ALL 33 Corrientes lines
 * every 20 minutes even when zero users are using the app.
 */
export async function runScheduledFleetScan(env, nowMs = Date.now(), fetchStopFn = fetchOneStop) {
  // Argentina local time (UTC-3, no DST)
  const art = new Date(nowMs - 3 * 3600 * 1000);
  const artMinOfDay = art.getUTCHours() * 60 + art.getUTCMinutes();
  const stub = getFleetStub(env);

  // Dead-night quiet window: 01:30–04:30 ART -> skip heavy SOAP scanning, run daily retention prune at 03:00 ART
  if (artMinOfDay >= 90 && artMinOfDay < 270) {
    if (artMinOfDay >= 180 && artMinOfDay < 195 && stub) {
      try {
        await stub.fetch('https://fleet-memory/cron-ingest', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pruneOnly: true })
        });
      } catch {
        // Non-fatal
      }
    }
    return { skipped: true, reason: 'night-quiet-window', artMinOfDay, probesRun: 0, unitsFound: 0 };
  }

  let scanCursor = fallbackRosterMeta.scanCursor || 0;
  if (stub) {
    try {
      const stateRes = await stub.fetch('https://fleet-memory/cron-state');
      const stateJson = await stateRes.json();
      if (Number.isInteger(stateJson?.scanCursor)) {
        scanCursor = stateJson.scanCursor;
      }
    } catch {
      // Fall back to 0 if DO state read fails
    }
  }

  const total = FLEET_SCAN_TARGETS.length;
  const start = ((scanCursor % total) + total) % total;
  const end = Math.min(total, start + CRON_BATCH_SIZE);
  const batchTargets = FLEET_SCAN_TARGETS.slice(start, end);
  const cycleCompleted = end >= total;
  const nextCursor = cycleCompleted ? 0 : end;

  // Deduplicate units discovered in this batch, keeping freshest GPS per (codigoLinea, coche)
  const byUnit = new Map();
  let probesSucceeded = 0;

  for (let i = 0; i < batchTargets.length; i += CRON_CONCURRENCY) {
    const wave = batchTargets.slice(i, i + CRON_CONCURRENCY);
    const waveRes = await Promise.all(
      wave.map(([cod, stopId]) =>
        fetchStopFn(stopId, cod === 0 ? '000' : String(cod))
          .then((r) => ({ ok: true, stopId, arribos: r?.arribos || [] }))
          .catch(() => ({ ok: false, stopId, arribos: [] }))
      )
    );

    for (const r of waveRes) {
      if (r.ok) probesSucceeded++;
      for (const a of r.arribos) {
        const cod = Number(a.codigoLinea);
        const coche = String(a.identificadorCoche || '').trim();
        if (!cod || !coche) continue;
        const key = `${cod}:${coche}`;
        const gpsMs = parseGpsStampMs(a.ultimaFechaHoraGPS);
        const prev = byUnit.get(key);
        const hasChofer = Boolean(String(a.choferNombre || a.choferLegajo || a.identificadorChofer || '').trim());
        const prevHasChofer = Boolean(prev && (prev.choferNombre || prev.choferLegajo || prev.choferRaw));
        if (!prev || gpsMs > prev._gpsMs || (gpsMs === prev._gpsMs && hasChofer && !prevHasChofer)) {
          const lat = parseFloat(a.latitud);
          const lng = parseFloat(a.longitud);
          byUnit.set(key, {
            codigoLinea: cod,
            descripcionLinea: String(a.descripcionLinea || LINE_NAMES_BY_CODE[cod] || '').trim(),
            coche,
            choferNombre: a.choferNombre || prev?.choferNombre || '',
            choferLegajo: a.choferLegajo || prev?.choferLegajo || '',
            choferRaw: a.identificadorChofer || prev?.choferRaw || '',
            esAdaptado: Boolean(a.esAdaptado || prev?.esAdaptado),
            desvioSec: parseDesvioSeconds(a.desvioHorario),
            desvioRaw: a.desvioHorario || prev?.desvioRaw || '',
            bandera: a.descripcionBandera || prev?.bandera || '',
            ultimaGps: a.ultimaFechaHoraGPS || prev?.ultimaGps || '',
            lat: !Number.isNaN(lat) && lat !== 0 ? lat : prev?.lat ?? null,
            lng: !Number.isNaN(lng) && lng !== 0 ? lng : prev?.lng ?? null,
            stopId: r.stopId,
            _gpsMs: gpsMs
          });
        }
      }
    }
  }

  const units = Array.from(byUnit.values()).map(({ _gpsMs, ...clean }) => clean);

  // Update isolate fallback too
  fallbackRosterMeta.scanCursor = nextCursor;
  fallbackRosterMeta.lastCronAt = nowMs;
  fallbackRosterMeta.lastBatchUnits = units.length;
  if (cycleCompleted) {
    fallbackRosterMeta.lastCycleAt = nowMs;
    fallbackRosterMeta.totalSweeps += 1;
  }
  for (const u of units) upsertFallbackRosterUnit(u, nowMs);

  if (stub) {
    try {
      await stub.fetch('https://fleet-memory/cron-ingest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          units,
          nextCursor,
          cycleCompleted
        })
      });
    } catch {
      // Non-fatal
    }
  }

  return {
    skipped: false,
    start,
    end,
    nextCursor,
    cycleCompleted,
    probesRun: batchTargets.length,
    probesSucceeded,
    unitsFound: units.length
  };
}

const LIVE_HORARIOS_TTL_MS = 55000;
const liveHorariosCache = new Map(); // cacheKey -> { ts, data }

/**
 * Continuous automatic SOAP timetable scanner (runs on every 5-min Cloudflare Cron tick).
 * - Priority 1 (every 10 min): scans ALL 25 scheduled lines' primary anchor stop for [now+2m, now+2h01m].
 * - Priority 2 (background catch-up): fills ALL 53 branch anchor stops across all future 2h windows
 *   for today & tomorrow (round-robin by peak daytime windows first, then full-day sweep).
 * - Strictly additive: NEVER deletes passed times that SOAP stops returning!
 * - Stays safely under Cloudflare Workers Free 50-subrequest limit (<= 44 daytime, <= 43 night).
 */
export async function runScheduledHorariosScan(env, nowMs = Date.now(), fetchWindowFn = fetchHorariosWindowSoap) {
  const stub = getFleetStub(env);
  if (!stub) {
    return { skipped: true, reason: 'no-durable-object', soapCalls: 0, entriesFound: 0 };
  }

  const artMs = nowMs - 3 * 3600 * 1000;
  const art = new Date(artMs);
  const artMinOfDay = art.getUTCHours() * 60 + art.getUTCMinutes();
  const isNightQuiet = artMinOfDay >= 90 && artMinOfDay < 270;
  const soapBudget = isNightQuiet ? HORARIOS_NIGHT_SOAP_BUDGET : HORARIOS_DAY_SOAP_BUDGET;

  let liveCursor = 0;
  const scannedMap = new Map();
  try {
    const stRes = await stub.fetch('https://fleet-memory/horarios-scan-state');
    if (stRes.ok) {
      const st = await stRes.json();
      if (Number.isInteger(st?.liveCursor)) liveCursor = st.liveCursor;
      for (const row of st?.scannedWindows || []) {
        if (!Array.isArray(row) || row.length < 5) continue;
        scannedMap.set(`${row[0]}|${row[1]}|${row[2]}|${row[3]}`, Number(row[4]) || 0);
      }
    }
  } catch {
    // Non-fatal: proceed with cursor 0
  }

  const safeStartArtMs = artMs + 2 * 60 * 1000;
  const safeHorizonArtMs = artMs + 47.5 * 3600 * 1000;
  const calToday = getArgentinaCalendarDayIso(nowMs);
  const calTomorrow = shiftCalendarDayIso(calToday, 1);

  const jobs = [];
  const jobKeys = new Set();

  // Priority 1: Live 10-minute rolling sweep across ALL 25 scheduled lines (13 on tick 0, 12 on tick 1)
  const half = Math.ceil(HORARIOS_PRIMARY_STOPS.length / 2);
  const normCursor = liveCursor % 2 === 1 ? 1 : 0;
  const nextLiveCursor = normCursor === 0 ? 1 : 0;
  const p1Slice =
    normCursor === 0
      ? HORARIOS_PRIMARY_STOPS.slice(0, half)
      : HORARIOS_PRIMARY_STOPS.slice(half);

  let p1StartMs = safeStartArtMs;
  const p1StartDate = new Date(p1StartMs);
  const p1DayEndMs = Date.UTC(
    p1StartDate.getUTCFullYear(),
    p1StartDate.getUTCMonth(),
    p1StartDate.getUTCDate(),
    23,
    59,
    59
  );
  let p1EndMs = Math.min(p1DayEndMs, p1StartMs + 119 * 60 * 1000);
  if (p1EndMs - p1StartMs < 3 * 60 * 1000) {
    p1StartMs = p1DayEndMs + 1000;
    p1EndMs = p1StartMs + 119 * 60 * 1000;
  }
  const p1DesdeIso = formatArtIsoDateTime(p1StartMs);
  const p1HastaIso = formatArtIsoDateTime(p1EndMs);

  for (const [cod, stopId] of p1Slice) {
    const jk = `${cod}|${stopId}|${p1DesdeIso}|${p1HastaIso}`;
    if (jobKeys.has(jk)) continue;
    jobKeys.add(jk);
    jobs.push({
      cod,
      stopId,
      desdeIso: p1DesdeIso,
      hastaIso: p1HastaIso,
      recordWindow: null
    });
  }

  // Priority 2: Full-day lookahead + return branches across all 53 anchor stops (today + tomorrow)
  const remaining = Math.max(0, soapBudget - jobs.length);
  if (remaining > 0) {
    const buckets = {
      unscannedTodayPrimary: [],
      unscannedTodaySecondary: [],
      unscannedTomorrowPrimary: [],
      unscannedTomorrowSecondary: [],
      staleToday: [],
      staleTomorrow: []
    };

    const orderedAnchors = [
      ...HORARIOS_ANCHOR_STOPS.filter((a) => a[2] === 1),
      ...HORARIOS_ANCHOR_STOPS.filter((a) => a[2] !== 1)
    ];

    for (const calDate of [calToday, calTomorrow]) {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(calDate);
      if (!m) continue;
      const baseDayMs = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0);
      const isTodayCal = calDate === calToday;

      for (const h of HORARIOS_WINDOW_ORDER) {
        const winStartMs = baseDayMs + h * 3600 * 1000;
        const winEndMs = baseDayMs + (h + 1) * 3600 * 1000 + 59 * 60 * 1000 + 59 * 1000;
        if (winEndMs <= safeStartArtMs + 120 * 1000) continue; // Already passed
        if (winStartMs >= safeHorizonArtMs - 120 * 1000) continue; // Beyond SmartMovePro 48h horizon

        const desdeMs = Math.max(winStartMs, safeStartArtMs);
        const hastaMs = Math.min(winEndMs, safeHorizonArtMs, desdeMs + 119 * 60 * 1000);
        if (hastaMs - desdeMs < 120 * 1000) continue;

        // Only mark the 2-hour window fully covered if it reaches the end of the 2-hour block
        const fullEndCovered = hastaMs >= winEndMs - 120 * 1000;
        const windowDayKey = h < 3 ? shiftCalendarDayIso(calDate, -1) : calDate;
        const desdeIso = formatArtIsoDateTime(desdeMs);
        const hastaIso = formatArtIsoDateTime(hastaMs);

        for (const [cod, stopId, isPrimary] of orderedAnchors) {
          const wKey = `${windowDayKey}|${cod}|${stopId}|${h}`;
          const scannedAt = scannedMap.get(wKey) || 0;
          const item = {
            cod,
            stopId,
            desdeIso,
            hastaIso,
            scannedAt,
            recordWindow: fullEndCovered ? { dayKey: windowDayKey, codigoLinea: cod, stopId, windowHour: h } : null
          };

          if (!scannedAt) {
            if (isTodayCal) {
              if (isPrimary) buckets.unscannedTodayPrimary.push(item);
              else buckets.unscannedTodaySecondary.push(item);
            } else if (fullEndCovered) {
              if (isPrimary) buckets.unscannedTomorrowPrimary.push(item);
              else buckets.unscannedTomorrowSecondary.push(item);
            }
          } else if (isTodayCal && nowMs - scannedAt >= 55 * 60 * 1000) {
            buckets.staleToday.push(item);
          } else if (!isTodayCal && fullEndCovered && nowMs - scannedAt >= 180 * 60 * 1000) {
            buckets.staleTomorrow.push(item);
          }
        }
      }
    }

    buckets.staleToday.sort((a, b) => a.scannedAt - b.scannedAt);
    buckets.staleTomorrow.sort((a, b) => a.scannedAt - b.scannedAt);

    const queue = [
      ...buckets.unscannedTodayPrimary,
      ...buckets.unscannedTodaySecondary,
      ...buckets.unscannedTomorrowPrimary,
      ...buckets.unscannedTomorrowSecondary,
      ...buckets.staleToday,
      ...buckets.staleTomorrow
    ];

    for (const q of queue) {
      if (jobs.length >= soapBudget) break;
      const jk = `${q.cod}|${q.stopId}|${q.desdeIso}|${q.hastaIso}`;
      if (jobKeys.has(jk)) continue;
      jobKeys.add(jk);
      jobs.push(q);
    }
  }

  const entryMap = new Map();
  const recordedWindows = [];
  let succeeded = 0;

  for (let i = 0; i < jobs.length; i += HORARIOS_SCAN_CONCURRENCY) {
    const wave = jobs.slice(i, i + HORARIOS_SCAN_CONCURRENCY);
    const results = await Promise.all(
      wave.map((job) =>
        fetchWindowFn(job.stopId, job.cod, job.desdeIso, job.hastaIso)
          .then((r) => ({ job, r }))
          .catch(() => ({ job, r: { ok: false, empty: false, items: [] } }))
      )
    );
    for (const { job, r } of results) {
      if (!r?.ok) continue;
      succeeded++;
      for (const it of r.items || []) {
        const ek = `${it.dayKey}|${it.codigoLinea}|${it.stopId}|${it.horaPaso}|${it.bandera}`;
        if (!entryMap.has(ek)) entryMap.set(ek, it);
      }
      if (job.recordWindow) {
        recordedWindows.push({
          ...job.recordWindow,
          itemsCount: (r.items || []).length
        });
      }
    }
  }

  const entries = Array.from(entryMap.values());
  try {
    await stub.fetch('https://fleet-memory/horarios-ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        entries,
        windows: recordedWindows,
        nextLiveCursor,
        scannedAt: nowMs
      })
    });
    liveHorariosCache.clear();
    offlineBundleCache = { ts: 0, data: null };
  } catch {
    // Non-fatal
  }

  return {
    skipped: false,
    isNightQuiet,
    soapCalls: jobs.length,
    succeeded,
    entriesFound: entries.length,
    windowsRecorded: recordedWindows.length,
    nextLiveCursor
  };
}

// 22 directed multi-line hub stops (codLinea='000') covering ALL 26 active Corrientes + Chaco-Corrientes
// lines in BOTH Ida & Vuelta directions (< 25 subrequests, safely under Cloudflare Workers Free cap).
const LIVE_CITY_HUB_STOPS = [
  'CT31218', 'CT31213', 'CT31604', 'CT31338',
  'CT1398', 'CT31631', 'CT313032', 'CT31337',
  'CT31475', 'CT31368', 'CT31610', 'CT31831',
  'CT32070', 'CT31363', 'CT31648', 'L9041027',
  'L9041046', 'CH469', 'CH426', 'CH444',
  'CH1018', 'CH115'
];
const LIVE_CITY_SWEEP_TTL_MS = 8500;
let liveCitySweepCache = { ts: 0, units: [] };
let liveCitySweepInFlight = null;

const OFFLINE_BUNDLE_TTL_MS = 45000;
let offlineBundleCache = { ts: 0, data: null };
let offlineBundleInFlight = null;

export async function runLiveCityHubSweep(env, ctx, nowMs = Date.now(), fetchStopFn = fetchOneStop) {
  if (nowMs - liveCitySweepCache.ts < LIVE_CITY_SWEEP_TTL_MS && liveCitySweepCache.units.length > 0) {
    return liveCitySweepCache.units;
  }
  if (liveCitySweepInFlight) return liveCitySweepInFlight;

  liveCitySweepInFlight = (async () => {
    const byUnit = new Map();
    const waveSize = 8;
    for (let i = 0; i < LIVE_CITY_HUB_STOPS.length; i += waveSize) {
      const wave = LIVE_CITY_HUB_STOPS.slice(i, i + waveSize);
      const waveRes = await Promise.all(
        wave.map((stopId) =>
          fetchStopFn(stopId, '000')
            .then((r) => ({ ok: true, stopId, arribos: r?.arribos || [] }))
            .catch(() => ({ ok: false, stopId, arribos: [] }))
        )
      );
      for (const r of waveRes) {
        for (const a of r.arribos) {
          const cod = Number(a.codigoLinea);
          const coche = String(a.identificadorCoche || '').trim();
          const lat = parseFloat(a.latitud);
          const lng = parseFloat(a.longitud);
          if (!cod || !coche || REMOVED_LINE_CODES.has(cod) || Number.isNaN(lat) || Number.isNaN(lng) || (lat === 0 && lng === 0)) continue;
          const key = `${cod}:${coche}`;
          const gpsMs = parseGpsStampMs(a.ultimaFechaHoraGPS);
          const prev = byUnit.get(key);
          const hasChofer = Boolean(String(a.choferNombre || a.choferLegajo || a.identificadorChofer || '').trim());
          const prevHasChofer = Boolean(prev && (prev.choferNombre || prev.choferLegajo || prev.choferRaw));
          if (!prev || gpsMs > prev._gpsMs || (gpsMs === prev._gpsMs && hasChofer && !prevHasChofer)) {
            byUnit.set(key, {
              codigoLinea: cod,
              descripcionLinea: resolvePublicLineName(cod, a.descripcionLinea),
              coche,
              choferNombre: a.choferNombre || prev?.choferNombre || '',
              choferLegajo: a.choferLegajo || prev?.choferLegajo || '',
              choferRaw: a.identificadorChofer || prev?.choferRaw || '',
              esAdaptado: Boolean(a.esAdaptado || prev?.esAdaptado),
              desvioSec: parseDesvioSeconds(a.desvioHorario),
              desvioRaw: a.desvioHorario || prev?.desvioRaw || '',
              bandera: a.descripcionBandera || prev?.bandera || '',
              ultimaGps: a.ultimaFechaHoraGPS || prev?.ultimaGps || '',
              lat,
              lng,
              stopId: r.stopId,
              lastStopId: r.stopId,
              lastSeenAt: gpsMs || Date.now(),
              enLineaAhora: true,
              _gpsMs: gpsMs || 0
            });
          }
        }
      }
    }

    const doneMs = Date.now();
    const units = Array.from(byUnit.values()).map(({ _gpsMs, ...clean }) => clean);
    if (units.length > 0) {
      liveCitySweepCache = { ts: doneMs, units };
      for (const u of units) upsertFallbackRosterUnit(u, doneMs);
      const stub = getFleetStub(env);
      if (stub) {
        const ingestPromise = stub
          .fetch('https://fleet-memory/live-city-ingest', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ units })
          })
          .catch(() => {});
        if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(ingestPromise);
      }
    }
    return units;
  })();

  try {
    return await liveCitySweepInFlight;
  } finally {
    liveCitySweepInFlight = null;
  }
}

const LINE_LIVE_SWEEP_TTL_MS = 8500;
const lineLiveSweepCache = new Map();
const lineLiveSweepInFlight = new Map();

/**
 * Fast live SOAP probe for a single line's strategic targets (2–4 stops in parallel).
 * Throttled per line to ~8.5s so 10-second auto-refresh across all clients gets real-time
 * GPS, driver, bandera & desvío updates directly from SmartMovePro and persists them to DO SQLite.
 */
export async function runLiveLineSweep(env, codLinea, nowMs = Date.now(), fetchStopFn = fetchOneStop) {
  const cod = Number(codLinea);
  if (!cod || REMOVED_LINE_CODES.has(cod)) return [];
  const cached = lineLiveSweepCache.get(cod);
  if (cached && nowMs - cached.ts < LINE_LIVE_SWEEP_TTL_MS) {
    return cached.units;
  }
  if (lineLiveSweepInFlight.has(cod)) {
    return lineLiveSweepInFlight.get(cod);
  }

  const targets = FLEET_SCAN_TARGETS.filter(([c]) => c === cod).map(([, stopId]) => stopId);
  if (targets.length === 0) return [];

  const job = (async () => {
    const byUnit = new Map();
    const resList = await Promise.all(
      targets.map((stopId) =>
        fetchStopFn(stopId, String(cod))
          .then((r) => ({ ok: true, stopId, arribos: r?.arribos || [] }))
          .catch(() => ({ ok: false, stopId, arribos: [] }))
      )
    );

    for (const r of resList) {
      for (const a of r.arribos) {
        const aCod = Number(a.codigoLinea);
        const coche = String(a.identificadorCoche || '').trim();
        if (!aCod || !coche || REMOVED_LINE_CODES.has(aCod)) continue;
        const key = `${aCod}:${coche}`;
        const gpsMs = parseGpsStampMs(a.ultimaFechaHoraGPS);
        const prev = byUnit.get(key);
        const hasChofer = Boolean(String(a.choferNombre || a.choferLegajo || a.identificadorChofer || '').trim());
        const prevHasChofer = Boolean(prev && (prev.choferNombre || prev.choferLegajo || prev.choferRaw));
        if (!prev || gpsMs > prev._gpsMs || (gpsMs === prev._gpsMs && hasChofer && !prevHasChofer)) {
          const lat = parseFloat(a.latitud);
          const lng = parseFloat(a.longitud);
          byUnit.set(key, {
            codigoLinea: aCod,
            descripcionLinea: resolvePublicLineName(aCod, a.descripcionLinea),
            coche,
            choferNombre: a.choferNombre || prev?.choferNombre || '',
            choferLegajo: a.choferLegajo || prev?.choferLegajo || '',
            choferRaw: a.identificadorChofer || prev?.choferRaw || '',
            esAdaptado: Boolean(a.esAdaptado || prev?.esAdaptado),
            desvioSec: parseDesvioSeconds(a.desvioHorario),
            desvioRaw: a.desvioHorario || prev?.desvioRaw || '',
            bandera: a.descripcionBandera || prev?.bandera || '',
            ultimaGps: a.ultimaFechaHoraGPS || prev?.ultimaGps || '',
            lat: !Number.isNaN(lat) && lat !== 0 ? lat : prev?.lat ?? null,
            lng: !Number.isNaN(lng) && lng !== 0 ? lng : prev?.lng ?? null,
            stopId: r.stopId,
            _gpsMs: gpsMs || 0
          });
        }
      }
    }

    const doneMs = Date.now();
    const units = Array.from(byUnit.values()).map(({ _gpsMs, ...clean }) => clean);
    lineLiveSweepCache.set(cod, { ts: doneMs, units });
    for (const u of units) upsertFallbackRosterUnit(u, doneMs);
    fallbackRosterMeta.lastLiveAt = doneMs;

    const stub = getFleetStub(env);
    if (stub) {
      try {
        await stub.fetch('https://fleet-memory/live-city-ingest', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ units })
        });
      } catch {
        // Non-fatal
      }
    }
    return units;
  })();

  lineLiveSweepInFlight.set(cod, job);
  try {
    return await job;
  } finally {
    lineLiveSweepInFlight.delete(cod);
  }
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const { pathname, searchParams } = url;

    try {
      if (pathname === '/' || pathname === '/api/health') {
        return jsonResponse({
          ok: true,
          version: '2.3',
          service: 'DIRECT GPS · Cloudflare SOAP Proxy',
          fleetMemory: env?.FLEET_MEMORY ? 'durable-object-sqlite' : 'memory',
          autoFleetScan: {
            intervalMin: CRON_SCAN_INTERVAL_MIN,
            fullCycleMin: CRON_FULL_CYCLE_MIN,
            retentionDays: ROSTER_RETENTION_DAYS,
            targets: FLEET_SCAN_TARGETS.length
          },
          autoHorariosScan: {
            intervalMin: HORARIOS_LIVE_INTERVAL_MIN,
            primaryLines: HORARIOS_PRIMARY_STOPS.length,
            anchorStops: HORARIOS_ANCHOR_STOPS.length,
            nonDestructive: true
          },
          timestamp: Date.now()
        });
      }

      if (pathname === '/api/horarios-live' && request.method === 'GET') {
        const nowMs = Date.now();
        const cacheKey = url.search || '?default';
        const hit = liveHorariosCache.get(cacheKey);
        if (hit && nowMs - hit.ts < LIVE_HORARIOS_TTL_MS) {
          return jsonResponse({
            data: hit.data,
            source: 'live-horarios-edge',
            savedAt: hit.ts
          });
        }
        const stub = getFleetStub(env);
        if (stub) {
          try {
            const doRes = await stub.fetch(`https://fleet-memory/horarios-live${url.search}`);
            if (doRes.ok) {
              const data = await doRes.json();
              liveHorariosCache.set(cacheKey, { ts: nowMs, data });
              if (liveHorariosCache.size > 24) {
                const firstKey = liveHorariosCache.keys().next().value;
                if (firstKey) liveHorariosCache.delete(firstKey);
              }
              return jsonResponse({
                data,
                source: 'live-horarios-do',
                savedAt: nowMs
              });
            }
          } catch {
            // Fall through to empty payload
          }
        }
        return jsonResponse({
          data: {
            dayKey: getArgentinaDayKey(nowMs),
            calendarToday: getArgentinaCalendarDayIso(nowMs),
            availableDays: [],
            days: {},
            meta: {
              lastHorariosScanAt: 0,
              totalHorariosScans: 0,
              intervalMin: HORARIOS_LIVE_INTERVAL_MIN,
              anchorStops: HORARIOS_ANCHOR_STOPS.length
            }
          },
          source: 'live-horarios-empty',
          savedAt: nowMs
        });
      }

      if (pathname === '/api/flota-resumen' && request.method === 'GET') {
        const nowMs = Date.now();
        const wantLive = searchParams.get('live') === '1';
        if (wantLive) {
          await Promise.race([
            runLiveCityHubSweep(env, ctx, nowMs).catch(() => []),
            new Promise((r) => setTimeout(r, 1800))
          ]);
        }
        const stub = getFleetStub(env);
        if (stub) {
          try {
            const doRes = await stub.fetch('https://fleet-memory/flota-resumen');
            const data = await doRes.json();
            return jsonResponse({ data, source: 'fleet-memory-do', savedAt: Date.now() });
          } catch {
            // Fall through to in-memory fallback
          }
        }
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
        for (const c of fallbackRosterCars.values()) {
          if (c.lastSeenAt < minTs) continue;
          const entry = ensureLine(c.codigoLinea, c.descripcionLinea);
          entry.cochesSemana += 1;
          if (c.lastDayKey === todayKey) entry.cochesHoy += 1;
          entry.lastSeenAt = Math.max(entry.lastSeenAt, c.lastSeenAt);
        }
        for (const d of fallbackRosterDrivers.values()) {
          if (d.lastSeenAt < minTs) continue;
          const entry = ensureLine(d.codigoLinea, d.descripcionLinea);
          entry.choferesSemana += 1;
          if (d.lastDayKey === todayKey) entry.choferesHoy += 1;
          entry.lastSeenAt = Math.max(entry.lastSeenAt, d.lastSeenAt);
        }
        const lineas = Array.from(byLine.values()).sort((a, b) =>
          a.descripcionLinea.localeCompare(b.descripcionLinea, 'es', { numeric: true })
        );
        return jsonResponse({
          data: {
            dayKey: todayKey,
            retentionDays: ROSTER_RETENTION_DAYS,
            meta: {
              ...fallbackRosterMeta,
              scanIntervalMin: CRON_SCAN_INTERVAL_MIN,
              fullCycleMin: CRON_FULL_CYCLE_MIN,
              retentionDays: ROSTER_RETENTION_DAYS
            },
            lineas
          },
          source: 'fleet-memory-mem',
          savedAt: nowMs
        });
      }

      if (pathname === '/api/flota' && request.method === 'GET') {
        const codLinea = Number(searchParams.get('codLinea'));
        if (!codLinea) return jsonResponse({ error: 'Falta codLinea' }, 400);
        const nowMs = Date.now();
        const todayKey = getArgentinaDayKey(nowMs);
        const dayKeyParam = String(searchParams.get('dayKey') || '').trim();
        const isTodayQuery = !dayKeyParam || dayKeyParam === todayKey;
        const wantLive = searchParams.get('live') !== '0' && isTodayQuery;

        if (wantLive) {
          await Promise.race([
            runLiveLineSweep(env, codLinea, nowMs).catch(() => []),
            new Promise((r) => setTimeout(r, 2800))
          ]);
        }

        const stub = getFleetStub(env);
        if (stub) {
          try {
            const qs = `codLinea=${encodeURIComponent(codLinea)}${
              /^\d{4}-\d{2}-\d{2}$/.test(dayKeyParam) ? `&dayKey=${encodeURIComponent(dayKeyParam)}` : ''
            }`;
            const doRes = await stub.fetch(`https://fleet-memory/flota?${qs}`);
            const data = await doRes.json();
            return jsonResponse({ data, source: 'fleet-memory-do', savedAt: Date.now() });
          } catch {
            // Fall through to in-memory fallback
          }
        }
        const minTs = nowMs - ROSTER_RETENTION_MS;
        const coches = Array.from(fallbackRosterCars.values())
          .filter((c) => c.codigoLinea === codLinea && c.lastSeenAt >= minTs)
          .map((c) => ({ ...c, vistoHoy: c.lastDayKey === todayKey }))
          .sort((a, b) => {
            if (a.vistoHoy !== b.vistoHoy) return a.vistoHoy ? -1 : 1;
            if (b.lastSeenAt !== a.lastSeenAt) return b.lastSeenAt - a.lastSeenAt;
            return compareCocheIds(a.coche, b.coche);
          });
        const choferes = Array.from(fallbackRosterDrivers.values())
          .filter((d) => d.codigoLinea === codLinea && d.lastSeenAt >= minTs)
          .map((d) => ({ ...d, vistoHoy: d.lastDayKey === todayKey }))
          .sort((a, b) => {
            if (a.vistoHoy !== b.vistoHoy) return a.vistoHoy ? -1 : 1;
            if (b.lastSeenAt !== a.lastSeenAt) return b.lastSeenAt - a.lastSeenAt;
            return a.choferNombre.localeCompare(b.choferNombre, 'es');
          });
        return jsonResponse({
          data: {
            codigoLinea: codLinea,
            descripcionLinea: LINE_NAMES_BY_CODE[codLinea] || `L${codLinea}`,
            dayKey: todayKey,
            retentionDays: ROSTER_RETENTION_DAYS,
            meta: {
              ...fallbackRosterMeta,
              scanIntervalMin: CRON_SCAN_INTERVAL_MIN,
              fullCycleMin: CRON_FULL_CYCLE_MIN,
              retentionDays: ROSTER_RETENTION_DAYS
            },
            coches,
            choferes
          },
          source: 'fleet-memory-mem',
          savedAt: nowMs
        });
      }

      if (pathname === '/api/flota-buscar' && request.method === 'GET') {
        const q = String(searchParams.get('q') || '').trim();
        if (q.length < 2) {
          return jsonResponse({ data: { dayKey: getArgentinaDayKey(), results: [] }, source: 'fleet-memory-do', savedAt: Date.now() });
        }
        const stub = getFleetStub(env);
        if (stub) {
          try {
            const doRes = await stub.fetch(`https://fleet-memory/flota-buscar?q=${encodeURIComponent(q)}`);
            const data = await doRes.json();
            return jsonResponse({ data, source: 'fleet-memory-do', savedAt: Date.now() });
          } catch {
            // Fall through to in-memory fallback
          }
        }
        const nowMs = Date.now();
        const todayKey = getArgentinaDayKey(nowMs);
        const normQ = normalizeDriverNameKey(q);
        const results = [];
        for (const c of fallbackRosterCars.values()) {
          if (normalizeDriverNameKey(`${c.coche} ${c.descripcionLinea}`).includes(normQ)) {
            results.push({ type: 'coche', ...c, choferNombre: c.lastChoferNombre, choferLegajo: c.lastChoferLegajo, vistoHoy: c.lastDayKey === todayKey, enLineaAhora: c.lastDayKey === todayKey && nowMs - c.lastSeenAt < SIMULTANEOUS_ACTIVE_WINDOW_MS });
          }
        }
        for (const d of fallbackRosterDrivers.values()) {
          if (normalizeDriverNameKey(`${d.choferNombre} ${d.choferLegajo}`).includes(normQ)) {
            results.push({ type: 'chofer', ...d, coche: d.lastCoche, vistoHoy: d.lastDayKey === todayKey, enLineaAhora: d.lastDayKey === todayKey && nowMs - d.lastSeenAt < SIMULTANEOUS_ACTIVE_WINDOW_MS });
          }
        }
        return jsonResponse({ data: { dayKey: todayKey, results: results.slice(0, 12) }, source: 'fleet-memory-mem', savedAt: nowMs });
      }

      if (pathname === '/api/flota-activa' && request.method === 'GET') {
        const nowMs = Date.now();
        const todayKey = getArgentinaDayKey(nowMs);
        const wantLive = searchParams.get('live') !== '0';
        const stub = getFleetStub(env);

        const [liveUnits, doData] = await Promise.all([
          wantLive ? runLiveCityHubSweep(env, ctx, nowMs).catch(() => []) : Promise.resolve([]),
          stub
            ? stub
                .fetch('https://fleet-memory/flota-activa')
                .then((r) => (r.ok ? r.json() : null))
                .catch(() => null)
            : Promise.resolve(null)
        ]);

        const mergedByKey = new Map();
        const baseUnits = Array.isArray(doData?.units) ? doData.units : [];
        for (const u of baseUnits) {
          if (!u?.codigoLinea || !u?.coche) continue;
          mergedByKey.set(`${u.codigoLinea}:${u.coche}`, u);
        }

        // In-memory fallback if DO was unavailable
        if (baseUnits.length === 0 && !doData) {
          const activeCutoff = nowMs - SIMULTANEOUS_ACTIVE_WINDOW_MS;
          for (const u of fallbackUnits.values()) {
            if ((u.updatedAt || 0) < activeCutoff) continue;
            const lat = Number(u.lat);
            const lng = Number(u.lng);
            if (!Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0)) continue;
            mergedByKey.set(`${u.codigoLinea}:${u.coche}`, {
              codigoLinea: Number(u.codigoLinea),
              descripcionLinea: u.descripcionLinea || LINE_NAMES_BY_CODE[u.codigoLinea] || `L${u.codigoLinea}`,
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
              lastSeenAt: u.updatedAt || nowMs,
              enLineaAhora: true
            });
          }
        }

        // Overlay brand-new live hub SOAP positions (keeping fresher GPS timestamp & full gpsTrail per unit!)
        for (const lu of liveUnits) {
          const k = `${lu.codigoLinea}:${lu.coche}`;
          const prev = mergedByKey.get(k);
          const luGpsMs = parseGpsStampMs(lu.ultimaGps) || lu.lastSeenAt || 0;
          const prevGpsMs = prev ? parseGpsStampMs(prev.ultimaGps) || prev.lastSeenAt || 0 : 0;
          if (!prev || luGpsMs >= prevGpsMs) {
            const baseTrail = Array.isArray(prev?.gpsTrail) ? [...prev.gpsTrail] : [];
            if (Number.isFinite(lu.lat) && Number.isFinite(lu.lng) && luGpsMs > 0) {
              const lastPt = baseTrail[baseTrail.length - 1];
              if (!lastPt || luGpsMs > (Number(lastPt[2]) || 0)) {
                baseTrail.push([Number(lu.lat.toFixed(6)), Number(lu.lng.toFixed(6)), luGpsMs]);
              }
            }
            mergedByKey.set(k, {
              ...(prev || {}),
              ...lu,
              choferNombre: lu.choferNombre || prev?.choferNombre || '',
              choferLegajo: lu.choferLegajo || prev?.choferLegajo || '',
              esAdaptado: Boolean(lu.esAdaptado || prev?.esAdaptado),
              bandera: lu.bandera || prev?.bandera || '',
              desvioRaw: lu.desvioRaw || prev?.desvioRaw || '',
              desvioSec: lu.desvioRaw ? lu.desvioSec : prev?.desvioSec || 0,
              gpsTrail: baseTrail.slice(-6),
              liveFresh: true
            });
          }
        }

        // When live bidirectional 22-hub sweep succeeded, prune stale DO ghost buses whose real GPS > 15 min old
        const staleGhostCutoffMs = nowMs - 15 * 60 * 1000;
        const units = Array.from(mergedByKey.values())
          .filter((u) => {
            if (u.liveFresh || liveUnits.length === 0) return true;
            const gpsMs = parseGpsStampMs(u.ultimaGps) || 0;
            const refMs = gpsMs || Number(u.lastSeenAt) || 0;
            return refMs >= staleGhostCutoffMs;
          })
          .sort((a, b) => a.codigoLinea - b.codigoLinea || (b.lastSeenAt || 0) - (a.lastSeenAt || 0));
        return jsonResponse({
          data: {
            dayKey: doData?.dayKey || todayKey,
            activeWindowMin: doData?.activeWindowMin || Math.round(SIMULTANEOUS_ACTIVE_WINDOW_MS / 60000),
            meta: doData?.meta || null,
            liveFreshCount: liveUnits.length,
            units
          },
          source: liveUnits.length > 0 ? (doData ? 'live-hubs+do' : 'live-hubs') : doData ? 'fleet-memory-do' : 'fleet-memory-mem',
          savedAt: Date.now()
        });
      }

      if (pathname === '/api/offline-bundle' && request.method === 'GET') {
        const nowMs = Date.now();
        if (offlineBundleCache.data && nowMs - offlineBundleCache.ts < OFFLINE_BUNDLE_TTL_MS) {
          return jsonResponse({
            data: offlineBundleCache.data,
            source: 'offline-bundle-edge',
            savedAt: offlineBundleCache.ts
          });
        }
        const stub = getFleetStub(env);
        if (stub) {
          try {
            if (!offlineBundleInFlight) {
              offlineBundleInFlight = stub
                .fetch('https://fleet-memory/offline-bundle')
                .then((r) => (r.ok ? r.json() : null))
                .finally(() => {
                  offlineBundleInFlight = null;
                });
            }
            const bundle = await offlineBundleInFlight;
            if (bundle) {
              offlineBundleCache = { ts: Date.now(), data: bundle };
              return jsonResponse({
                data: bundle,
                source: 'offline-bundle-do',
                savedAt: offlineBundleCache.ts
              });
            }
          } catch {
            // Fall through to empty fallback
          }
        }
        const todayKey = getArgentinaDayKey(nowMs);
        return jsonResponse({
          data: {
            dayKey: todayKey,
            retentionDays: ROSTER_RETENTION_DAYS,
            activeWindowMin: Math.round(SIMULTANEOUS_ACTIVE_WINDOW_MS / 60000),
            meta: null,
            resumen: { dayKey: todayKey, retentionDays: ROSTER_RETENTION_DAYS, meta: null, lineas: [] },
            activeUnits: [],
            lines: {}
          },
          source: 'offline-bundle-empty',
          savedAt: nowMs
        });
      }

      if (pathname === '/api/fleet-memory' && request.method === 'GET') {
        const stub = getFleetStub(env);
        if (stub) {
          try {
            const doRes = await stub.fetch(`https://fleet-memory/query${url.search}`);
            const data = await doRes.json();
            return jsonResponse({ data, source: 'fleet-memory-do', savedAt: Date.now() });
          } catch {
            // Fall through to in-memory fallback
          }
        }
        const dayKey = getArgentinaDayKey();
        const rawLineas = searchParams.get('lineas') || searchParams.get('codLinea') || '';
        const filterSet = new Set(
          rawLineas
            .split(',')
            .map((n) => Number(n.trim()))
            .filter((n) => Number.isInteger(n) && n > 0)
        );
        const trips = Array.from(fallbackTrips.values()).filter(
          (t) => t.dayKey === dayKey && (filterSet.size === 0 || filterSet.has(t.codigoLinea))
        );
        const units = Array.from(fallbackUnits.values()).filter(
          (u) => filterSet.size === 0 || filterSet.has(u.codigoLinea)
        );
        const stopIdParam = String(searchParams.get('idParada') || '').trim().toUpperCase();
        const stopSnapshot = stopIdParam ? fallbackStops.get(stopIdParam) || null : null;
        return jsonResponse({
          data: { dayKey, stopSnapshot, trips, units },
          source: 'fleet-memory-mem',
          savedAt: Date.now()
        });
      }

      if (pathname === '/api/fleet-seen' && request.method === 'POST') {
        const body = await request.json().catch(() => ({}));
        const entries = Array.isArray(body.entries) ? body.entries.slice(0, 60) : [];
        const dayKey = String(body.dayKey || getArgentinaDayKey()).slice(0, 10);
        const nowMs = Date.now();

        for (const e of entries) {
          const cod = Number(e.codigoLinea ?? body.codigoLinea);
          const tripKey = String(e.tripKey || '').trim();
          const coche = String(e.coche || '').trim();
          if (!cod || !tripKey || !coche) continue;
          const rec = {
            dayKey,
            codigoLinea: cod,
            tripKey,
            turnoHora: String(e.turnoHora || '').trim(),
            coche,
            choferNombre: String(e.choferNombre || '').trim(),
            choferLegajo: String(e.choferLegajo || '').trim(),
            choferRaw: String(e.choferRaw || '').trim(),
            esAdaptado: Boolean(e.esAdaptado),
            desvioSec: Number.isFinite(Number(e.desvioSec)) ? Math.round(Number(e.desvioSec)) : 0,
            desvioRaw: String(e.desvioRaw || '').trim(),
            ultimaGps: String(e.ultimaGps || '').trim(),
            lat: Number.isFinite(Number(e.lat)) ? Number(e.lat) : null,
            lng: Number.isFinite(Number(e.lng)) ? Number(e.lng) : null,
            stopId: String(e.stopId || '').trim().toUpperCase(),
            updatedAt: nowMs
          };
          fallbackTrips.set(`${dayKey}:${cod}:${tripKey}`, rec);
          fallbackUnits.set(`${cod}:${coche}`, { ...rec, bandera: String(e.bandera || '').trim() });
          upsertFallbackRosterUnit({ ...rec, bandera: String(e.bandera || '').trim() }, nowMs, dayKey);
        }

        const stub = getFleetStub(env);
        if (stub && entries.length > 0) {
          try {
            const doRes = await stub.fetch('https://fleet-memory/record-trips', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ dayKey, codigoLinea: body.codigoLinea, entries })
            });
            const saved = await doRes.json();
            return jsonResponse({ ok: true, ...saved, storage: 'durable-object-sqlite' });
          } catch (err) {
            return jsonResponse({ ok: true, count: entries.length, storage: 'memory', warn: err.message });
          }
        }
        return jsonResponse({ ok: true, count: entries.length, storage: 'memory' });
      }

      if (pathname === '/api/bootstrap') {
        const lineas = await getLineas();
        return jsonResponse({
          pilotStop: PILOT_STOP,
          quickStops: QUICK_STOPS,
          hubs: CORRIENTES_HUBS,
          lineas,
          source: 'smartmovepro-soap'
        });
      }

      if (pathname === '/api/lineas') {
        const data = await getLineas();
        return jsonResponse({ data, source: 'smartmovepro-soap', savedAt: Date.now() });
      }

      if (pathname === '/api/calles') {
        const codLinea = Number(searchParams.get('codLinea'));
        if (!codLinea) return jsonResponse({ error: 'Falta codLinea' }, 400);
        const res = await soapRequest(
          'RecuperarCallesPrincipalPorLinea',
          `<usuario i:type="d:string">${SOAP_USER}</usuario>
           <clave i:type="d:string">${SOAP_PASS}</clave>
           <codigoLineaParada i:type="d:int">${codLinea}</codigoLineaParada>
           <isSubLinea i:type="d:boolean">false</isSubLinea>`
        );
        const data = (res?.calles || []).map((c) => ({
          codigo: Number(c.Codigo),
          descripcion: String(c.Descripcion || '').trim()
        }));
        return jsonResponse({ data, source: 'smartmovepro-soap', savedAt: Date.now() });
      }

      if (pathname === '/api/intersecciones') {
        const codLinea = Number(searchParams.get('codLinea'));
        const codCalle = Number(searchParams.get('codCalle'));
        if (!codLinea || !codCalle) return jsonResponse({ error: 'Faltan parámetros' }, 400);
        const res = await soapRequest(
          'RecuperarInterseccionPorLineaYCalle',
          `<usuario i:type="d:string">${SOAP_USER}</usuario>
           <clave i:type="d:string">${SOAP_PASS}</clave>
           <codigoLineaParada i:type="d:int">${codLinea}</codigoLineaParada>
           <codigoCalle i:type="d:int">${codCalle}</codigoCalle>
           <isSubLinea i:type="d:boolean">false</isSubLinea>`
        );
        const data = (res?.calles || []).map((i) => ({
          codigo: Number(i.Codigo),
          descripcion: String(i.Descripcion || '').trim()
        }));
        return jsonResponse({ data, source: 'smartmovepro-soap', savedAt: Date.now() });
      }

      if (pathname === '/api/paradas') {
        const codLinea = Number(searchParams.get('codLinea'));
        const codCalle = Number(searchParams.get('codCalle'));
        const codInterseccion = Number(searchParams.get('codInterseccion'));
        if (!codLinea || !codCalle || !codInterseccion) return jsonResponse({ error: 'Faltan parámetros' }, 400);
        const res = await soapRequest(
          'RecuperarParadasPorLineaCalleEInterseccion',
          `<usuario i:type="d:string">${SOAP_USER}</usuario>
           <clave i:type="d:string">${SOAP_PASS}</clave>
           <codigoLinea i:type="d:int">${codLinea}</codigoLinea>
           <codigoCalle i:type="d:int">${codCalle}</codigoCalle>
           <codigoInterseccion i:type="d:int">${codInterseccion}</codigoInterseccion>
           <isSublinea i:type="d:boolean">false</isSublinea>
           <isInteligente i:type="d:boolean">false</isInteligente>`
        );
        const data = (res?.paradas || []).map((p) => ({
          codigo: String(p.Codigo || ''),
          identificador: String(p.Identificador || '').trim(),
          descripcion: String(p.Descripcion || '').trim(),
          callePrincipal: p.CallePrincipal || '',
          calleInterseccion: p.CalleInterseccion || '',
          latitud: p.Latitud || null,
          longitud: p.Longitud || null,
          lineas: p.Lineas || ''
        }));
        return jsonResponse({ data, source: 'smartmovepro-soap', savedAt: Date.now() });
      }

      if (pathname === '/api/paradas-cercanas') {
        const lat = Number(searchParams.get('lat'));
        const lng = Number(searchParams.get('lng'));
        if (Number.isNaN(lat) || Number.isNaN(lng)) return jsonResponse({ error: 'Faltan lat/lng' }, 400);
        const res = await soapRequest(
          'RecuperarParadasMasCercanasPorLocalidadProvinciaPais',
          `<usuario i:type="d:string">${SOAP_USER}</usuario>
           <clave i:type="d:string">${SOAP_PASS}</clave>
           <latitud i:type="d:double">${lat}</latitud>
           <longitud i:type="d:double">${lng}</longitud>
           <listaCodigosEmpresa i:type="d:string">${CORRIENTES_EMPRESAS}</listaCodigosEmpresa>
           <descripcionProvincia i:type="d:string">CORRIENTES</descripcionProvincia>
           <descripcionPais i:type="d:string">ARGENTINA</descripcionPais>
           <isInteligente i:type="d:boolean">false</isInteligente>`
        );
        const data = (res?.paradas || []).map((p) => ({
          codigo: String(p.Codigo || ''),
          identificador: String(p.Identificador || '').trim(),
          descripcion: String(p.Descripcion || '').trim(),
          callePrincipal: p.CallePrincipal || '',
          calleInterseccion: p.CalleInterseccion || '',
          latitud: p.Latitud ? String(p.Latitud) : null,
          longitud: p.Longitud ? String(p.Longitud) : null,
          lineas: p.Lineas || ''
        }));
        return jsonResponse({ data, source: 'smartmovepro-soap', savedAt: Date.now() });
      }

      if (pathname === '/api/recorridos') {
        const codLinea = Number(searchParams.get('codLinea'));
        if (!codLinea) return jsonResponse({ error: 'Falta codLinea' }, 400);
        const [recRes, stopsRes] = await Promise.all([
          soapRequest(
            'RecuperarRecorridoParaMapaAbrevYAmpliPorEntidadYLinea',
            `<usuario i:type="d:string">${SOAP_USER}</usuario>
             <clave i:type="d:string">${SOAP_PASS}</clave>
             <codigoLineaParada i:type="d:int">${codLinea}</codigoLineaParada>
             <isSublinea i:type="d:boolean">false</isSublinea>`
          ),
          soapRequest(
            'RecuperarParadasCompletoPorLinea',
            `<usuario i:type="d:string">${SOAP_USER}</usuario>
             <clave i:type="d:string">${SOAP_PASS}</clave>
             <codigoLineaParada i:type="d:int">${codLinea}</codigoLineaParada>
             <isSublinea i:type="d:boolean">false</isSublinea>
             <isInteligente i:type="d:boolean">false</isInteligente>`
          ).catch(() => ({ paradas: {} }))
        ]);

        const grouped = new Map();
        for (const pt of recRes?.puntos || []) {
          const key = pt.AbreviaturaBanderaSMP || pt.Descripcion || 'RUTA';
          if (!grouped.has(key)) {
            const parts = String(pt.Descripcion || '').split(';');
            grouped.set(key, {
              abreviaturaBanderaSMP: parts[2] || parts[1] || key,
              abreviaturaGit: key,
              descripcion: pt.Descripcion || key,
              puntos: [],
              paradas: []
            });
          }
          grouped.get(key).puntos.push({
            latitud: pt.Latitud,
            longitud: pt.Longitud,
            isPuntoDePaso: Boolean(pt.IsPuntoPaso)
          });
        }
        const paradasByGit = stopsRes?.paradas || {};
        for (const [gitKey, routeObj] of grouped.entries()) {
          routeObj.paradas = (paradasByGit[gitKey] || []).map((s) => ({
            codigo: s.Codigo,
            identificador: s.Identificador,
            descripcion: s.Descripcion,
            abreviaturaBandera: s.AbreviaturaBandera,
            latitudParada: s.LatitudParada,
            longitudParada: s.LongitudParada
          }));
        }
        return jsonResponse({ data: Array.from(grouped.values()), source: 'smartmovepro-soap', savedAt: Date.now() });
      }

      if (pathname === '/api/banderas') {
        const idParada = String(searchParams.get('idParada') || PILOT_STOP.id).trim().toUpperCase();
        const res = await soapRequest(
          'RecuperarBanderasAsociadasAParada',
          `<usuario i:type="d:string">${SOAP_USER}</usuario>
           <clave i:type="d:string">${SOAP_PASS}</clave>
           <identificadorParada i:type="d:string">${escapeXml(idParada)}</identificadorParada>
           <codigoAplicacion i:type="d:int">${SOAP_APP_CODE}</codigoAplicacion>`
        );
        return jsonResponse({ data: res?.banderas || [], source: 'smartmovepro-soap', savedAt: Date.now() });
      }

      if (pathname === '/api/horarios') {
        const stopId = String(searchParams.get('idParada') || '').trim().toUpperCase();
        const lineNum = Number(searchParams.get('codLinea'));
        const tipoDia = String(searchParams.get('tipoDia') || 'auto').trim().toLowerCase();
        if (!stopId || !lineNum) {
          return jsonResponse({ error: 'Faltan parámetros idParada o codLinea' }, 400);
        }

        const nowArt = new Date(Date.now() - 3 * 3600 * 1000);
        const pad = (n) => String(n).padStart(2, '0');
        const getTipo = (dow) => (dow === 0 ? 'domingo' : dow === 6 ? 'sabado' : 'habil');
        const dayStartUtcMs = Date.UTC(nowArt.getUTCFullYear(), nowArt.getUTCMonth(), nowArt.getUTCDate(), 0, 0, 0);
        const todayTipo = getTipo(nowArt.getUTCDay());
        const requestedTipo = tipoDia === 'auto' ? todayTipo : tipoDia;

        let targetOffset = null;
        if (requestedTipo === 'hoy') {
          targetOffset = 0;
        } else {
          for (const offset of [1, 2]) {
            const d = new Date(dayStartUtcMs + offset * 86400 * 1000);
            if (getTipo(d.getUTCDay()) === requestedTipo) {
              targetOffset = offset;
              break;
            }
          }
          if (targetOffset === null && requestedTipo === todayTipo) {
            targetOffset = 0;
          }
        }

        if (targetOffset === null) {
          const labelMap = { habil: 'Lun–Vie', sabado: 'Sábado', domingo: 'Domingo' };
          return jsonResponse({
            data: {
              idParada: stopId,
              codigoLinea: lineNum,
              tipoDia: requestedTipo,
              available: false,
              partial: false,
              horarios: [],
              frecuenciaMin: null,
              mensaje: `SmartMovePro habilita la programación de ${labelMap[requestedTipo] || requestedTipo} con hasta 48h de anticipación.`
            },
            source: 'smartmovepro-soap',
            savedAt: Date.now()
          });
        }

        const targetDate = new Date(dayStartUtcMs + targetOffset * 86400 * 1000);
        const dateIsoPrefix = `${targetDate.getUTCFullYear()}-${pad(targetDate.getUTCMonth() + 1)}-${pad(targetDate.getUTCDate())}`;

        const windows = [];
        if (targetOffset === 0) {
          let curMs = nowArt.getTime() + 2 * 60 * 1000;
          const endOfTodayMs = dayStartUtcMs + 23 * 3600 * 1000 + 59 * 60 * 1000 + 59 * 1000;
          while (curMs < endOfTodayMs) {
            const nextMs = Math.min(endOfTodayMs, curMs + 119 * 60 * 1000);
            const s = new Date(curMs);
            const e = new Date(nextMs);
            windows.push([
              `${dateIsoPrefix}T${pad(s.getUTCHours())}:${pad(s.getUTCMinutes())}:${pad(s.getUTCSeconds())}`,
              `${dateIsoPrefix}T${pad(e.getUTCHours())}:${pad(e.getUTCMinutes())}:${pad(e.getUTCSeconds())}`
            ]);
            curMs = nextMs + 1000;
          }
        } else {
          for (let h = 0; h < 24; h += 2) {
            windows.push([`${dateIsoPrefix}T${pad(h)}:00:00`, `${dateIsoPrefix}T${pad(h + 1)}:59:59`]);
          }
        }

        const results = await Promise.all(
          windows.map(([desde, hasta]) =>
            soapRequest(
              'RecuperarHorariosProgramadosPorLineaParada',
              `<usuario i:type="d:string">${SOAP_USER}</usuario>
               <clave i:type="d:string">${SOAP_PASS}</clave>
               <identificadorParada i:type="d:string">${escapeXml(stopId)}</identificadorParada>
               <codigoLineaParada i:type="d:int">${lineNum}</codigoLineaParada>
               <fechaHoraDesde i:type="d:dateTime">${desde}</fechaHoraDesde>
               <fechaHoraHasta i:type="d:dateTime">${hasta}</fechaHoraHasta>`
            ).catch(() => null)
          )
        );

        const seen = new Set();
        const horarios = [];
        const ingestEntries = [];
        for (const r of results) {
          const list = Array.isArray(r?.HorariossProgramados)
            ? r.HorariossProgramados
            : Array.isArray(r?.HorariosProgramados)
              ? r.HorariosProgramados
              : [];
          for (const item of list) {
            const rawPaso = String(item.HoraPaso || '').trim();
            const parsed = parseSoapHoraPasoToServiceEntry(rawPaso, dateIsoPrefix);
            if (!parsed) continue;
            const bandera = String(item.DescripcionBandera || '').trim();
            const dedupKey = `${parsed.horaPaso}|${bandera}`;
            if (seen.has(dedupKey)) continue;
            seen.add(dedupKey);
            const hhmm = parsed.horaPaso.slice(0, 5);
            const [hh = '0', mm = '0'] = hhmm.split(':');
            horarios.push({
              codigoLinea: Number(item.CodigoLinea) || lineNum,
              identificadorParada: item.IdentificadorParada || stopId,
              bandera,
              horaPaso: rawPaso || `${dateIsoPrefix} ${parsed.horaPaso}`,
              hora: hhmm,
              minuteOfDay: parseInt(hh, 10) * 60 + parseInt(mm, 10)
            });
            ingestEntries.push({
              dayKey: parsed.dayKey,
              codigoLinea: lineNum,
              stopId,
              horaPaso: parsed.horaPaso,
              bandera
            });
          }
        }

        // Preserve earlier schedules from the same day that SOAP no longer returns once elapsed
        const stub = getFleetStub(env);
        if (stub) {
          if (targetOffset === 0) {
            try {
              const histRes = await stub.fetch(
                `https://fleet-memory/horarios-live?dayKey=${encodeURIComponent(dateIsoPrefix)}&codLinea=${lineNum}&idParada=${encodeURIComponent(stopId)}`
              );
              if (histRes.ok) {
                const histJson = await histRes.json();
                const storedList = histJson?.days?.[dateIsoPrefix]?.lineas?.[String(lineNum)]?.stops?.[stopId] || [];
                for (const raw of storedList) {
                  const [horaPaso, ...bandParts] = String(raw).split('|');
                  const bandera = bandParts.join('|');
                  const dedupKey = `${horaPaso}|${bandera}`;
                  if (!horaPaso || seen.has(dedupKey)) continue;
                  seen.add(dedupKey);
                  const hhmm = horaPaso.slice(0, 5);
                  const [hh = '0', mm = '0'] = hhmm.split(':');
                  horarios.push({
                    codigoLinea: lineNum,
                    identificadorParada: stopId,
                    bandera,
                    horaPaso: `${dateIsoPrefix} ${horaPaso}`,
                    hora: hhmm,
                    minuteOfDay: parseInt(hh, 10) * 60 + parseInt(mm, 10)
                  });
                }
              }
            } catch {
              // Non-fatal
            }
          }
          if (ingestEntries.length > 0) {
            const persistTask = stub
              .fetch('https://fleet-memory/horarios-ingest', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  entries: ingestEntries,
                  windows: [],
                  passiveOnly: true,
                  scannedAt: Date.now()
                })
              })
              .catch(() => null);
            if (ctx?.waitUntil) ctx.waitUntil(persistTask);
            else await persistTask;
          }
        }

        horarios.sort((a, b) => a.minuteOfDay - b.minuteOfDay);

        const diffs = [];
        for (let i = 1; i < horarios.length; i++) {
          const d = horarios[i].minuteOfDay - horarios[i - 1].minuteOfDay;
          if (d >= 2 && d <= 90) diffs.push(d);
        }
        diffs.sort((a, b) => a - b);
        const frecuenciaMin = diffs.length > 0 ? diffs[Math.floor(diffs.length / 2)] : null;

        return jsonResponse({
          data: {
            idParada: stopId,
            codigoLinea: lineNum,
            tipoDia: requestedTipo === 'hoy' ? todayTipo : requestedTipo,
            fechaConsultada: dateIsoPrefix,
            available: true,
            partial: targetOffset === 0 && horarios.length === 0,
            horarios,
            frecuenciaMin
          },
          source: 'smartmovepro-soap',
          savedAt: Date.now()
        });
      }

      if (pathname === '/api/arribos' || pathname === '/api/arribos-linea') {
        const stopId = String(searchParams.get('idParada') || PILOT_STOP.id).trim().toUpperCase();
        const rawCode = String(searchParams.get('codLinea') || '000').trim();
        const lineCode = !rawCode || rawCode === '0' ? '000' : rawCode;

        const skipCorridor = searchParams.get('skipCorridor') === '1';
        const hintLinea = Number(searchParams.get('hintLinea')) || 0;

        const getCachedLineBranches = async (lineNum) => {
          if (!lineNum) return [];
          const now = Date.now();
          const hit = LINE_STOPS_CACHE.get(lineNum);
          if (hit && now - hit.ts < LINE_STOPS_TTL_MS) return hit.branches;
          const stopsRes = await soapRequest(
            'RecuperarParadasCompletoPorLinea',
            `<usuario i:type="d:string">${SOAP_USER}</usuario>
             <clave i:type="d:string">${SOAP_PASS}</clave>
             <codigoLineaParada i:type="d:int">${lineNum}</codigoLineaParada>
             <isSublinea i:type="d:boolean">false</isSublinea>
             <isInteligente i:type="d:boolean">false</isInteligente>`
          ).catch(() => ({ paradas: {} }));
          const branches = Object.values(stopsRes?.paradas || {}).filter((arr) => Array.isArray(arr) && arr.length > 0);
          if (branches.length > 0) {
            if (LINE_STOPS_CACHE.size > 60) LINE_STOPS_CACHE.delete(LINE_STOPS_CACHE.keys().next().value);
            LINE_STOPS_CACHE.set(lineNum, { ts: now, branches });
          }
          return branches;
        };

        const fetchProbeStopCached = async (sid, lcode, zone) => {
          const pKey = `${sid}:${lcode}`;
          const now = Date.now();
          const hit = PROBE_ARRIBOS_CACHE.get(pKey);
          if (hit && now - hit.ts < PROBE_ARRIBOS_TTL_MS) {
            return { stopId: sid, zone, arribos: hit.arribos, cached: true };
          }
          try {
            const r = await fetchOneStop(sid, lcode);
            const arr = r.arribos || [];
            if (PROBE_ARRIBOS_CACHE.size > 250) PROBE_ARRIBOS_CACHE.delete(PROBE_ARRIBOS_CACHE.keys().next().value);
            PROBE_ARRIBOS_CACHE.set(pKey, { ts: Date.now(), arribos: arr });
            return { stopId: sid, zone, arribos: arr, cached: false };
          } catch {
            return { stopId: sid, zone, arribos: [], cached: false };
          }
        };

        // ── Mode 1: Single-line full Corridor Radar (/api/arribos-linea) ──
        // ALWAYS probes strategic stops BEFORE (upstream), AFTER (downstream up to cabecera),
        // and OPPOSITE leg in parallel (<= 8 probes, 18s edge-cached) regardless of base arribo count!
        if (pathname === '/api/arribos-linea' && lineCode !== '000' && !skipCorridor) {
          const lineNum = Number(lineCode);
          const [basePayload, branches] = await Promise.all([
            fetchOneStop(stopId, lineCode),
            getCachedLineBranches(lineNum)
          ]);

          const probes = selectStrategicCorridorProbes(branches, stopId, { maxDown: 3, maxUp: 3, maxOpp: 2 });
          const probeResults = await Promise.all(
            probes.map((p) => fetchProbeStopCached(p.stopId, lineCode, p.zone))
          );

          const parseMin = (txt) => {
            const l = String(txt || '').toLowerCase();
            if (l.includes('arriband') || l.includes('llegand')) return 0.5;
            const m = l.match(/(\d+)/);
            return m ? parseInt(m[1], 10) : null;
          };

          // Keep the EARLIEST arrival per coche in `fleet` for accurate probe delta propagation,
          // and preserve genuine later-lap entries from SmartMovePro (`esSiguienteVuelta: true`)
          // so a 2nd lap NEVER overwrites or erases the imminent 1st arrival of the same bus!
          const fleet = new Map();
          const extraNextLaps = [];
          const sortedBase = [...basePayload.arribos].sort(
            (a, b) => (parseMin(a.tiempoRestanteArribo) ?? 999) - (parseMin(b.tiempoRestanteArribo) ?? 999)
          );
          for (const a of sortedBase) {
            const cid = a.identificadorCoche || `${a.latitud},${a.longitud}`;
            const etaMin = parseMin(a.tiempoRestanteArribo);
            if (!fleet.has(cid)) {
              fleet.set(cid, {
                arribo: { ...a, esExtendido: false, viaParada: null, esSiguienteVuelta: false },
                etaMin
              });
            } else {
              const prevEta = fleet.get(cid).etaMin;
              if (etaMin !== null && prevEta !== null && etaMin - prevEta >= 20) {
                extraNextLaps.push({
                  arribo: { ...a, esExtendido: false, viaParada: null, esSiguienteVuelta: true },
                  etaMin
                });
              }
            }
          }

          // Use ONLY upstream + opposite probes for `esExtendido` approaching-fleet discovery
          // (downstream probes are strictly for early-passed ghost suppression & corridorFleet X-ray!)
          const approachingProbes = probeResults
            .filter((pr) => pr.zone === 'upstream' || pr.zone === 'opposite')
            .map((pr) => {
              const byCid = new Map();
              for (const a of pr.arribos) {
                const cid = a.identificadorCoche || `${a.latitud},${a.longitud}`;
                const pMin = parseMin(a.tiempoRestanteArribo);
                const cur = byCid.get(cid);
                if (!cur || (pMin !== null && (cur.pMin === null || pMin < cur.pMin))) {
                  byCid.set(cid, { arribo: a, pMin });
                }
              }
              return { stopId: pr.stopId, items: Array.from(byCid.entries()) };
            });

          for (let pass = 0; pass < 4; pass++) {
            let added = false;
            for (const pr of approachingProbes) {
              const deltas = [];
              for (const [cid, { pMin }] of pr.items) {
                if (fleet.has(cid) && pMin !== null && fleet.get(cid).etaMin !== null) {
                  const d = fleet.get(cid).etaMin - pMin;
                  if (d >= 0 && d <= 100) deltas.push(d);
                }
              }
              if (deltas.length === 0) continue;
              deltas.sort((a, b) => a - b);
              const travelDelta = deltas[Math.floor(deltas.length / 2)];

              for (const [cid, { arribo: a, pMin }] of pr.items) {
                if (!fleet.has(cid) && pMin !== null) {
                  const estMin = Math.max(1, Math.round(pMin + travelDelta));
                  fleet.set(cid, {
                    arribo: {
                      ...a,
                      tiempoRestanteArribo: `${estMin} min. est.`,
                      descripcionBandera: sortedBase[0]?.descripcionBandera || a.descripcionBandera,
                      latitudParada: String(basePayload.stopCoords?.lat ?? ''),
                      longitudParada: String(basePayload.stopCoords?.lng ?? ''),
                      esExtendido: true,
                      viaParada: pr.stopId,
                      esSiguienteVuelta: false
                    },
                    etaMin: estMin
                  });
                  added = true;
                }
              }
            }
            if (!added) break;
          }

          const merged = [...fleet.values(), ...extraNextLaps]
            .sort((a, b) => (a.etaMin ?? 999) - (b.etaMin ?? 999))
            .map((x) => x.arribo);

          // Full corridor X-ray: every unique live unit seen upstream, at stopId, downstream, or opposite leg
          const corridorFleet = buildCorridorFleet(merged, probeResults);

          if (ctx?.waitUntil) {
            ctx.waitUntil(recordObservedUnits(env, corridorFleet.length > 0 ? corridorFleet : merged, stopId, basePayload.stopCoords));
          }
          return jsonResponse({
            data: {
              ...basePayload,
              arribos: merged,
              corridorFleet,
              corridorProbeCount: probes.length,
              extendedCount: merged.filter((x) => x.esExtendido).length,
              fullFleet: true
            },
            source: 'smartmovepro-soap',
            savedAt: Date.now()
          });
        }

        // ── Mode 2: Multi-line ("Todas") Corridor Radar (/api/arribos?codLinea=000) ──
        // Fires 2 lightweight parallel probes (1 anterior + 1 siguiente along the avenue with codLinea=000,
        // 18s cached) giving instant upstream/downstream X-ray for ALL lines sharing this stop at once!
        const basePayload = await fetchOneStop(stopId, lineCode);
        let corridorFleet = [];
        let corridorProbeCount = 0;

        if (!skipCorridor && lineCode === '000') {
          const anchorLine = hintLinea || Number(basePayload.arribos[0]?.codigoLinea) || 0;
          if (anchorLine > 0) {
            const branches = await getCachedLineBranches(anchorLine);
            const probes = selectStrategicCorridorProbes(branches, stopId, { maxDown: 1, maxUp: 1, maxOpp: 0 });
            if (probes.length > 0) {
              const probeResults = await Promise.all(
                probes.map((p) => fetchProbeStopCached(p.stopId, '000', p.zone))
              );
              corridorFleet = buildCorridorFleet(basePayload.arribos, probeResults);
              corridorProbeCount = probes.length;
            }
          }
        }

        if (ctx?.waitUntil) {
          const toRecord = corridorFleet.length > 0 ? corridorFleet : basePayload.arribos;
          ctx.waitUntil(recordObservedUnits(env, toRecord, stopId, basePayload.stopCoords));
        }
        return jsonResponse({
          data: {
            ...basePayload,
            corridorFleet,
            corridorProbeCount
          },
          source: 'smartmovepro-soap',
          savedAt: Date.now()
        });
      }

      return jsonResponse({ error: 'Endpoint no encontrado' }, 404);
    } catch (err) {
      return jsonResponse({ error: 'Error conectando con SWParadas.asmx', detail: err.message }, 502);
    }
  },

  async scheduled(event, env, ctx) {
    const ts = event?.scheduledTime || Date.now();
    const task = (async () => {
      try {
        await runScheduledFleetScan(env, ts);
      } catch {
        // Non-fatal: always continue to live SOAP timetable scanner
      }
      try {
        await runScheduledHorariosScan(env, ts);
      } catch {
        // Non-fatal
      }
    })();
    if (ctx?.waitUntil) {
      ctx.waitUntil(task);
    } else {
      await task;
    }
  }
};
