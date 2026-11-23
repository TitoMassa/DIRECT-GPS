#!/usr/bin/env node
// DIRECT GPS · Escaneo automático de horarios programados (todas las líneas × todas las paradas).
//
// Recorre SmartMovePro y guarda la grilla completa (00:00–23:59) de cada parada y línea para
// cada tipo de día (habil / sabado / domingo) en docs/data/horarios/<codLinea>.json.
// Lo ejecuta GitHub Actions todas las noches (.github/workflows/horarios.yml) y el resultado
// queda versionado en el repo, así los horarios sobreviven a cualquier borrado de caché.
//
// Reglas de fusión (nunca se pierde información):
//   · Un tipo de día de una parada solo se reemplaza si el escaneo de sus 12 ventanas salió completo
//     y devolvió al menos un horario. Ante errores o respuestas vacías se conserva lo anterior.
//
// Uso: node scripts/scan-horarios.mjs [--offsets=1,2] [--lineas=350,94] [--concurrency=10]

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SOAP_ENDPOINT = 'http://clsw.smartmovepro.net/ModuloParadas/SWParadas.asmx';
const SOAP_NS = 'http://clsw.smartmovepro.net/';
const SOAP_USER = 'WEB.UPLATENSE';
const SOAP_PASS = 'PAR.SW.UPLATENSE';
const EMPTY_MSG = /no se encuentran horarios/i;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'docs', 'data', 'horarios');

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v = 'true'] = a.replace(/^--/, '').split('=');
    return [k, v];
  })
);
const OFFSETS = String(args.offsets || process.env.SCAN_OFFSETS || '1,2')
  .split(',')
  .map((n) => Number(n.trim()))
  .filter((n) => Number.isInteger(n) && n >= 0);
const ONLY_LINES = args.lineas ? new Set(String(args.lineas).split(',').map(Number)) : null;
const CONCURRENCY = Math.max(1, Number(args.concurrency || process.env.SCAN_CONCURRENCY || 10));
const TIPOS = ['habil', 'sabado', 'domingo'];

const pad = (n) => String(n).padStart(2, '0');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getTipo = (dow) => (dow === 0 ? 'domingo' : dow === 6 ? 'sabado' : 'habil');

function unescapeXml(str) {
  return String(str ?? '')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function escapeXml(val) {
  return String(val ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

let requestCount = 0;
async function soapOnce(method, inner) {
  const envelope = `<?xml version="1.0" encoding="utf-8"?>
<v:Envelope xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns:d="http://www.w3.org/2001/XMLSchema" xmlns:c="http://schemas.xmlsoap.org/soap/encoding/" xmlns:v="http://schemas.xmlsoap.org/soap/envelope/">
  <v:Header />
  <v:Body>
    <${method} xmlns="${SOAP_NS}" id="o0" c:root="1">
      <usuario i:type="d:string">${SOAP_USER}</usuario>
      <clave i:type="d:string">${SOAP_PASS}</clave>
      ${inner}
    </${method}>
  </v:Body>
</v:Envelope>`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25000);
  try {
    requestCount++;
    const res = await fetch(SOAP_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: `"${SOAP_NS}${method}"` },
      body: envelope,
      signal: ctrl.signal
    });
    const xml = await res.text();
    if (!res.ok) throw new Error(`HTTP_${res.status}`);
    const m = xml.match(new RegExp(`<${method}Result>([\\s\\S]*?)</${method}Result>`));
    if (!m) throw new Error('EMPTY_RESULT');
    return JSON.parse(unescapeXml(m[1]));
  } finally {
    clearTimeout(timer);
  }
}

async function soap(method, inner, attempts = 4) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await soapOnce(method, inner);
    } catch (err) {
      lastErr = err;
      await sleep(600 * (i + 1) ** 2);
    }
  }
  throw lastErr;
}

async function pool(items, worker, limit) {
  let idx = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (idx < items.length) {
      const i = idx++;
      await worker(items[i], i);
    }
  });
  await Promise.all(runners);
}

const REMOVED_LINE_CODES = new Set([517, 607, 608, 744, 851, 853, 854]);
const LINE_NAME_OVERRIDES = { 852: '902', 433: '103D', 705: '109C' };

async function getLineas() {
  const res = await soap(
    'RecuperarLineaPorLocalidad',
    `<localidad i:type="d:string">CORRIENTES</localidad>
     <provincia i:type="d:string">CORRIENTES</provincia>
     <pais i:type="d:string">ARGENTINA</pais>
     <isSublinea i:type="d:boolean">false</isSublinea>`
  );
  const seen = new Map();
  for (const item of res?.lineas || []) {
    const cod = Number(item.CodigoLineaParada);
    if (cod && !REMOVED_LINE_CODES.has(cod) && !seen.has(cod)) {
      seen.set(cod, LINE_NAME_OVERRIDES[cod] || String(item.Descripcion || '').trim());
    }
  }
  return [...seen.entries()].map(([codigo, descripcion]) => ({ codigo, descripcion }));
}

async function getParadasLinea(codLinea) {
  const res = await soap(
    'RecuperarParadasCompletoPorLinea',
    `<codigoLineaParada i:type="d:int">${codLinea}</codigoLineaParada>
     <isSublinea i:type="d:boolean">false</isSublinea>
     <isInteligente i:type="d:boolean">false</isInteligente>`
  );
  const ids = new Set();
  for (const list of Object.values(res?.paradas || {})) {
    for (const s of list || []) {
      const id = String(s.Identificador || '').trim().toUpperCase();
      if (id) ids.add(id);
    }
  }
  return [...ids].sort();
}

function horaToSec(hora = '') {
  const m = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(String(hora || '').trim());
  if (!m) return -1;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3] || 0);
}

/**
 * Returns { ok, partial, coveredRanges: [[fromSec, toSec]], items:[{hora:'HH:MM:SS', bandera}] }
 * for one stop/line/date, strictly respecting SmartMovePro's [now+2m, now+47.5h] horizon.
 */
async function scanStopDay(stopId, codLinea, dateIso, validStartArtMs, validEndArtMs) {
  const mDate = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateIso);
  if (!mDate) return { ok: false, partial: true, coveredRanges: [], items: [] };
  const baseDayMs = Date.UTC(Number(mDate[1]), Number(mDate[2]) - 1, Number(mDate[3]), 0, 0, 0);

  const items = [];
  const seen = new Set();
  const coveredRanges = [];
  let partial = false;

  for (let h = 0; h < 24; h += 2) {
    const winStartMs = baseDayMs + h * 3600 * 1000;
    const winEndMs = baseDayMs + (h + 1) * 3600 * 1000 + 59 * 60 * 1000 + 59 * 1000;

    // Skip windows outside SmartMovePro's [now, +48h] publish range without treating them as empty
    if (winEndMs <= validStartArtMs + 60 * 1000 || winStartMs >= validEndArtMs - 60 * 1000) {
      partial = true;
      continue;
    }

    const desdeMs = Math.max(winStartMs, validStartArtMs);
    const hastaMs = Math.min(winEndMs, validEndArtMs, desdeMs + 119 * 60 * 1000 + 59 * 1000);
    if (hastaMs - desdeMs < 120 * 1000) {
      partial = true;
      continue;
    }
    if (desdeMs > winStartMs + 60 * 1000 || hastaMs < winEndMs - 60 * 1000) {
      partial = true;
    }

    const dDesde = new Date(desdeMs);
    const dHasta = new Date(hastaMs);
    const desdeIso = `${dateIso}T${pad(dDesde.getUTCHours())}:${pad(dDesde.getUTCMinutes())}:${pad(dDesde.getUTCSeconds())}`;
    const hastaIso = `${dateIso}T${pad(dHasta.getUTCHours())}:${pad(dHasta.getUTCMinutes())}:${pad(dHasta.getUTCSeconds())}`;

    let res;
    try {
      res = await soap(
        'RecuperarHorariosProgramadosPorLineaParada',
        `<identificadorParada i:type="d:string">${escapeXml(stopId)}</identificadorParada>
         <codigoLineaParada i:type="d:int">${codLinea}</codigoLineaParada>
         <fechaHoraDesde i:type="d:dateTime">${desdeIso}</fechaHoraDesde>
         <fechaHoraHasta i:type="d:dateTime">${hastaIso}</fechaHoraHasta>`
      );
    } catch {
      return { ok: false, partial: true, coveredRanges: [], items: [] };
    }
    const list = Array.isArray(res?.HorariossProgramados)
      ? res.HorariossProgramados
      : Array.isArray(res?.HorariosProgramados)
        ? res.HorariosProgramados
        : null;
    if (!list) {
      if (Number(res?.CodigoEstado) === -1 && EMPTY_MSG.test(String(res?.MensajeEstado || ''))) {
        coveredRanges.push([Math.floor((desdeMs - baseDayMs) / 1000), Math.floor((hastaMs - baseDayMs) / 1000)]);
        continue;
      }
      return { ok: false, partial: true, coveredRanges: [], items: [] };
    }
    coveredRanges.push([Math.floor((desdeMs - baseDayMs) / 1000), Math.floor((hastaMs - baseDayMs) / 1000)]);
    for (const it of list) {
      const raw = String(it.HoraPaso || '').trim();
      const hora = (raw.split(' ')[1] || '').trim().slice(0, 8);
      if (!/^\d{2}:\d{2}(:\d{2})?$/.test(hora)) continue;
      const bandera = String(it.DescripcionBandera || '').trim();
      const key = `${hora}|${bandera}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({ hora: hora.length === 5 ? `${hora}:00` : hora, bandera });
    }
  }
  items.sort((a, b) => a.hora.localeCompare(b.hora) || a.bandera.localeCompare(b.bandera));
  return { ok: true, partial, coveredRanges, items };
}

/**
 * Non-destructive merge: preserves previously stored times outside covered windows
 * (so elapsed morning times or evening times beyond +48h are NEVER erased).
 */
function mergeScheduleItems(prevList = [], freshResult) {
  const prev = Array.isArray(prevList) ? prevList : [];
  const fresh = Array.isArray(freshResult?.items) ? freshResult.items : [];
  if (!fresh.length) return prev;

  // Safety guard: never allow a sudden half-day truncation to wipe out evening trips
  const prevLastSec = prev.reduce((mx, it) => Math.max(mx, horaToSec(it.hora)), -1);
  const freshLastSec = fresh.reduce((mx, it) => Math.max(mx, horaToSec(it.hora)), -1);
  const looksTruncated = prev.length >= 6 && prevLastSec >= 19 * 3600 && freshLastSec < 17 * 3600;

  if (!freshResult.partial && !looksTruncated) {
    return fresh;
  }

  const ranges = freshResult.coveredRanges || [];
  const isCovered = (sec) => ranges.some(([from, to]) => sec >= from && sec <= to);

  const merged = [];
  const seen = new Set();
  for (const it of prev) {
    const sec = horaToSec(it.hora);
    // Keep anything outside covered ranges, OR anything after freshLastSec if truncated
    if (!isCovered(sec) || (looksTruncated && sec > freshLastSec + 60)) {
      const k = `${it.hora}|${it.bandera}`;
      if (!seen.has(k)) {
        seen.add(k);
        merged.push(it);
      }
    }
  }
  for (const it of fresh) {
    const k = `${it.hora}|${it.bandera}`;
    if (!seen.has(k)) {
      seen.add(k);
      merged.push(it);
    }
  }
  merged.sort((a, b) => a.hora.localeCompare(b.hora) || a.bandera.localeCompare(b.bandera));
  return merged;
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** Decode stored line file into Map(stopId -> {tipo -> items[]}) */
function decodeLineFile(file) {
  const banderas = Array.isArray(file?.banderas) ? file.banderas : [];
  const out = new Map();
  for (const [stopId, tipos] of Object.entries(file?.paradas || {})) {
    const entry = {};
    for (const [tipo, list] of Object.entries(tipos || {})) {
      entry[tipo] = (list || []).map((s) => {
        const [hora, idx = '0'] = String(s).split('|');
        return { hora, bandera: banderas[Number(idx)] || '' };
      });
    }
    out.set(stopId, entry);
  }
  return out;
}

/** Stable, diff-friendly serialization: one stop per line, sorted keys. */
function encodeLineFile(linea, stopsMap) {
  const banderaSet = new Set();
  for (const tipos of stopsMap.values()) {
    for (const list of Object.values(tipos)) for (const it of list) banderaSet.add(it.bandera);
  }
  const banderas = [...banderaSet].sort();
  const bIdx = new Map(banderas.map((b, i) => [b, i]));
  const stopLines = [...stopsMap.keys()]
    .sort()
    .map((stopId) => {
      const tipos = stopsMap.get(stopId);
      const obj = {};
      for (const tipo of TIPOS) {
        if (!tipos[tipo]?.length) continue;
        obj[tipo] = tipos[tipo].map((it) => (bIdx.get(it.bandera) ? `${it.hora}|${bIdx.get(it.bandera)}` : it.hora));
      }
      return Object.keys(obj).length ? `    ${JSON.stringify(stopId)}: ${JSON.stringify(obj)}` : null;
    })
    .filter(Boolean);
  return (
    '{\n' +
    `  "codigoLinea": ${linea.codigo},\n` +
    `  "descripcion": ${JSON.stringify(linea.descripcion)},\n` +
    `  "banderas": ${JSON.stringify(banderas)},\n` +
    '  "paradas": {\n' +
    stopLines.join(',\n') +
    (stopLines.length ? '\n' : '') +
    '  }\n' +
    '}\n'
  );
}

async function getFeriados(years) {
  const set = new Set();
  for (const y of years) {
    try {
      const res = await fetch(`https://api.argentinadatos.com/v1/feriados/${y}`, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) continue;
      for (const f of await res.json()) if (f?.fecha) set.add(String(f.fecha).slice(0, 10));
    } catch {
      // Sin acceso a la lista de feriados: se escanea igual.
    }
  }
  return set;
}

async function main() {
  const t0 = Date.now();
  const nowArtMs = Date.now() - 3 * 3600 * 1000;
  const nowArt = new Date(nowArtMs);
  const validStartArtMs = nowArtMs + 2 * 60 * 1000;
  const validEndArtMs = nowArtMs + 47.5 * 3600 * 1000;
  const dayStartUtcMs = Date.UTC(nowArt.getUTCFullYear(), nowArt.getUTCMonth(), nowArt.getUTCDate());

  const candidates = OFFSETS.map((off) => {
    const d = new Date(dayStartUtcMs + off * 86400000);
    return {
      off,
      iso: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`,
      tipo: getTipo(d.getUTCDay())
    };
  });
  const feriados = await getFeriados([...new Set(candidates.map((c) => c.iso.slice(0, 4)))]);
  const targets = [];
  for (const c of candidates) {
    if (feriados.has(c.iso)) {
      console.log(`· ${c.iso} es feriado: se omite (su grilla no representa un ${c.tipo} normal).`);
      continue;
    }
    if (targets.some((t) => t.tipo === c.tipo)) continue;
    targets.push(c);
  }
  if (!targets.length) {
    console.log('Nada para escanear.');
    return;
  }
  console.log(`Escaneando: ${targets.map((t) => `${t.tipo} (${t.iso})`).join(', ')} · concurrencia ${CONCURRENCY}`);

  await mkdir(OUT_DIR, { recursive: true });
  const indexFile = path.join(OUT_DIR, 'index.json');
  const index = await readJson(indexFile, { version: 1, lineas: {} });
  index.version = 1;
  index.lineas ||= {};

  let lineas = await getLineas();
  if (ONLY_LINES) lineas = lineas.filter((l) => ONLY_LINES.has(l.codigo));
  console.log(`${lineas.length} líneas.`);

  const totals = { updated: 0, kept: 0, failed: 0, empty: 0 };

  for (const linea of lineas) {
    let stops;
    try {
      stops = await getParadasLinea(linea.codigo);
    } catch (err) {
      console.log(`✗ ${linea.descripcion} (${linea.codigo}): no se pudieron leer sus paradas (${err.message}).`);
      continue;
    }
    const lineFile = path.join(OUT_DIR, `${linea.codigo}.json`);
    const stored = decodeLineFile(await readJson(lineFile, null));

    const jobs = [];
    for (const stopId of stops) for (const t of targets) jobs.push({ stopId, t });
    const stat = { updated: 0, kept: 0, failed: 0, empty: 0 };
    const okTipos = new Set();

    await pool(
      jobs,
      async ({ stopId, t }) => {
        const r = await scanStopDay(stopId, linea.codigo, t.iso, validStartArtMs, validEndArtMs);
        const prev = stored.get(stopId) || {};
        if (!r.ok) {
          stat.failed++;
          return;
        }
        okTipos.add(t.tipo);
        if (!r.items.length) {
          stat.empty++;
          return;
        }
        const before = JSON.stringify(prev[t.tipo] || []);
        const merged = mergeScheduleItems(prev[t.tipo], r);
        prev[t.tipo] = merged;
        stored.set(stopId, prev);
        if (before === JSON.stringify(merged)) stat.kept++;
        else stat.updated++;
      },
      CONCURRENCY
    );

    await writeFile(lineFile, encodeLineFile(linea, stored));
    const meta = (index.lineas[String(linea.codigo)] ||= { tipos: {} });
    meta.descripcion = linea.descripcion;
    meta.paradas = [...stored.values()].filter((v) => Object.keys(v).length).length;
    meta.tipos ||= {};
    for (const t of targets) if (okTipos.has(t.tipo) && stat.failed < jobs.length) meta.tipos[t.tipo] = t.iso;
    for (const k of Object.keys(totals)) totals[k] += stat[k];
    console.log(
      `✓ ${linea.descripcion.padEnd(18)} paradas ${String(stops.length).padStart(3)} · nuevos/cambiados ${stat.updated} · sin cambios ${stat.kept} · sin horarios ${stat.empty} · fallidos ${stat.failed}`
    );
  }

  index.updatedAt = new Date().toISOString();
  const sortedLineas = Object.fromEntries(
    Object.entries(index.lineas).sort((a, b) => Number(a[0]) - Number(b[0]))
  );
  index.lineas = sortedLineas;
  await writeFile(indexFile, JSON.stringify(index, null, 2) + '\n');

  console.log(
    `\nListo en ${Math.round((Date.now() - t0) / 1000)} s · ${requestCount} consultas · ` +
      `actualizados ${totals.updated} · sin cambios ${totals.kept} · vacíos ${totals.empty} · fallidos ${totals.failed}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
