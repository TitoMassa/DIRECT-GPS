#!/usr/bin/env node
// DIRECT GPS · Escaneo de recorridos, paradas y catálogo completo de Corrientes.
//
// Genera:
//   · docs/data/recorridos/<codLinea>.json — traza completa (puntos + paradas) de cada ramal.
//   · docs/data/catalogo.json — todas las líneas y todas las paradas únicas (para búsqueda,
//     paradas cercanas, banderas por parada y navegación 100% offline).
//
// Uso: node scripts/scan-recorridos.mjs

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SOAP_ENDPOINT = 'http://clsw.smartmovepro.net/ModuloParadas/SWParadas.asmx';
const SOAP_NS = 'http://clsw.smartmovepro.net/';
const SOAP_USER = 'WEB.UPLATENSE';
const SOAP_PASS = 'PAR.SW.UPLATENSE';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REC_DIR = path.join(ROOT, 'docs', 'data', 'recorridos');
const CATALOGO_FILE = path.join(ROOT, 'docs', 'data', 'catalogo.json');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function unescapeXml(str) {
  return String(str ?? '')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

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
  const res = await fetch(SOAP_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: `"${SOAP_NS}${method}"` },
    body: envelope,
    signal: AbortSignal.timeout(25000)
  });
  const xml = await res.text();
  if (!res.ok) throw new Error(`HTTP_${res.status}`);
  const m = xml.match(new RegExp(`<${method}Result>([\\s\\S]*?)</${method}Result>`));
  if (!m) throw new Error('EMPTY_RESULT');
  return JSON.parse(unescapeXml(m[1]));
}

async function soap(method, inner, attempts = 4) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await soapOnce(method, inner);
    } catch (err) {
      lastErr = err;
      await sleep(500 * (i + 1) ** 2);
    }
  }
  throw lastErr;
}

async function getLineas() {
  const res = await soap(
    'RecuperarLineaPorLocalidad',
    `<localidad i:type="d:string">CORRIENTES</localidad>
     <provincia i:type="d:string">CORRIENTES</provincia>
     <pais i:type="d:string">ARGENTINA</pais>
     <isSublinea i:type="d:boolean">false</isSublinea>`
  );
  const seen = new Set();
  const list = [];
  for (const item of res?.lineas || []) {
    const cod = Number(item.CodigoLineaParada);
    if (!cod || seen.has(cod)) continue;
    seen.add(cod);
    list.push({
      codigo: cod,
      descripcion: String(item.Descripcion || '').trim(),
      codigoEntidad: item.CodigoEntidad,
      codigoEmpresa: item.CodigoEmpresa
    });
  }
  return list;
}

function roundCoord(v) {
  const n = parseFloat(v);
  return Number.isNaN(n) ? null : Number(n.toFixed(6));
}

async function main() {
  const t0 = Date.now();
  await mkdir(REC_DIR, { recursive: true });

  const lineas = await getLineas();
  console.log(`Escaneando recorridos y paradas de ${lineas.length} líneas...`);

  const stopsCatalog = new Map(); // id -> { id, nombre, lat, lng, lineas: Set }

  for (const linea of lineas) {
    const [recRes, stopsRes] = await Promise.all([
      soap(
        'RecuperarRecorridoParaMapaAbrevYAmpliPorEntidadYLinea',
        `<codigoLineaParada i:type="d:int">${linea.codigo}</codigoLineaParada>
         <isSublinea i:type="d:boolean">false</isSublinea>`
      ).catch(() => ({ puntos: [] })),
      soap(
        'RecuperarParadasCompletoPorLinea',
        `<codigoLineaParada i:type="d:int">${linea.codigo}</codigoLineaParada>
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
          abreviaturaBanderaSMP: (parts[2] || parts[1] || key).trim(),
          abreviaturaGit: key,
          descripcion: pt.Descripcion || key,
          puntos: [],
          paradas: []
        });
      }
      const lat = roundCoord(pt.Latitud);
      const lng = roundCoord(pt.Longitud);
      if (lat !== null && lng !== null) {
        grouped.get(key).puntos.push({
          latitud: String(lat),
          longitud: String(lng),
          isPuntoDePaso: Boolean(pt.IsPuntoPaso)
        });
      }
    }

    const paradasByGit = stopsRes?.paradas || {};
    for (const [gitKey, routeObj] of grouped.entries()) {
      routeObj.paradas = (paradasByGit[gitKey] || []).map((s) => {
        const id = String(s.Identificador || '').trim().toUpperCase();
        const desc = String(s.Descripcion || '').trim();
        const lat = roundCoord(s.LatitudParada);
        const lng = roundCoord(s.LongitudParada);
        if (id) {
          let entry = stopsCatalog.get(id);
          if (!entry) {
            entry = { id, nombre: desc || `Parada ${id}`, lat, lng, lineas: new Set() };
            stopsCatalog.set(id, entry);
          } else {
            if (!entry.lat && lat) entry.lat = lat;
            if (!entry.lng && lng) entry.lng = lng;
            if ((!entry.nombre || entry.nombre === `Parada ${id}`) && desc) entry.nombre = desc;
          }
          entry.lineas.add(linea.codigo);
        }
        return {
          codigo: s.Codigo,
          identificador: id,
          descripcion: desc,
          abreviaturaBandera: String(s.AbreviaturaBandera || '').trim(),
          latitudParada: lat !== null ? String(lat) : '',
          longitudParada: lng !== null ? String(lng) : ''
        };
      });
    }

    // Also include any stops in stopsRes whose gitKey had no polyline points
    for (const [gitKey, list] of Object.entries(paradasByGit)) {
      if (grouped.has(gitKey)) continue;
      for (const s of list || []) {
        const id = String(s.Identificador || '').trim().toUpperCase();
        if (!id) continue;
        const lat = roundCoord(s.LatitudParada);
        const lng = roundCoord(s.LongitudParada);
        let entry = stopsCatalog.get(id);
        if (!entry) {
          entry = { id, nombre: String(s.Descripcion || '').trim() || `Parada ${id}`, lat, lng, lineas: new Set() };
          stopsCatalog.set(id, entry);
        }
        entry.lineas.add(linea.codigo);
      }
    }

    const branches = Array.from(grouped.values());
    await writeFile(path.join(REC_DIR, `${linea.codigo}.json`), JSON.stringify(branches));
    console.log(
      `✓ ${linea.descripcion.padEnd(18)} ramales ${branches.length} · paradas ${branches.reduce((a, b) => a + b.paradas.length, 0)}`
    );
  }

  const paradas = [...stopsCatalog.values()]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((s) => ({
      id: s.id,
      nombre: s.nombre,
      lat: s.lat,
      lng: s.lng,
      lineas: [...s.lineas].sort((a, b) => a - b)
    }));

  const catalogo = {
    version: 1,
    updatedAt: new Date().toISOString(),
    lineas,
    paradas
  };
  await writeFile(CATALOGO_FILE, JSON.stringify(catalogo));
  console.log(`\nListo en ${Math.round((Date.now() - t0) / 1000)} s · ${lineas.length} líneas · ${paradas.length} paradas únicas.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
