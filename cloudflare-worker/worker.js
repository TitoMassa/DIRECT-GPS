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
    if (seen.has(cod)) continue;
    seen.add(cod);
    normalized.push({
      codigo: cod,
      descripcion: String(item.Descripcion || '').trim(),
      codigoEntidad: item.CodigoEntidad,
      codigoEmpresa: item.CodigoEmpresa
    });
  }
  return normalized;
}

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const { pathname, searchParams } = url;

    try {
      if (pathname === '/' || pathname === '/api/health') {
        return jsonResponse({ ok: true, service: 'DIRECT GPS · Cloudflare SOAP Proxy', timestamp: Date.now() });
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

      if (pathname === '/api/arribos') {
        const stopId = String(searchParams.get('idParada') || PILOT_STOP.id).trim().toUpperCase();
        const rawCode = String(searchParams.get('codLinea') || '000').trim();
        const lineCode = !rawCode || rawCode === '0' ? '000' : rawCode;

        const raw = await soapRequest(
          'RecuperarProximosArribos',
          `<identificadorParada i:type="d:string">${escapeXml(stopId)}</identificadorParada>
           <codigoLineaParada i:type="d:int">${escapeXml(lineCode)}</codigoLineaParada>
           <codigoAplicacion i:type="d:int">${SOAP_APP_CODE}</codigoAplicacion>
           <localidad i:type="d:string">${escapeXml(SOAP_LOCALIDAD)}</localidad>
           <usuario i:type="d:string">${SOAP_USER}</usuario>
           <clave i:type="d:string">${SOAP_PASS}</clave>`
        );

        const rawArribos = Array.isArray(raw?.arribos) ? raw.arribos : [];
        let stopLat = null;
        let stopLng = null;
        for (const a of rawArribos) {
          if (a.LatitudParada && a.LongitudParada) {
            stopLat = parseFloat(a.LatitudParada);
            stopLng = parseFloat(a.LongitudParada);
            break;
          }
        }
        const known = QUICK_STOPS.find((s) => s.id === stopId);
        if ((stopLat === null || Number.isNaN(stopLat)) && known) {
          stopLat = known.lat;
          stopLng = known.lng;
        }

        const arribos = rawArribos.map((a) => {
          const chofer = parseChofer(a.IdentificadorChofer);
          return {
            codigoLinea: Number(a.CodigoLineaParada) || 0,
            tiempoRestanteArribo: String(a.Arribo || '').trim(),
            descripcionLinea: String(a.DescripcionLinea || '').trim(),
            descripcionBandera: String(a.DescripcionBandera || '').trim(),
            descripcionCortaBandera: String(a.DescripcionCortaBandera || '').trim(),
            descripcionCartelBandera: String(a.DescripcionCartelBandera || '').trim(),
            esAdaptado: String(a.EsAdaptado || '').toLowerCase() === 'true',
            latitud: String(a.Latitud || ''),
            longitud: String(a.Longitud || ''),
            latitudParada: String(a.LatitudParada || (stopLat ?? '')),
            longitudParada: String(a.LongitudParada || (stopLng ?? '')),
            esLleno: false,
            identificadorCoche: String(a.IdentificadorCoche || '').trim(),
            identificadorChofer: chofer.choferRaw,
            choferNombre: chofer.choferNombre,
            choferLegajo: chofer.choferLegajo,
            desvioHorario: String(a.DesvioHorario || '').trim(),
            ultimaFechaHoraGPS: String(a.UltimaFechaHoraGPS || '').trim(),
            mensajeError: String(a.MensajeError || '').trim()
          };
        });

        return jsonResponse({
          data: {
            arribos,
            idParada: stopId,
            codLinea: lineCode,
            stopCoords: stopLat !== null && stopLng !== null ? { lat: stopLat, lng: stopLng } : null,
            knownStop: known || null,
            codigoEstado: raw?.CodigoEstado ?? 0,
            mensaje: raw?.MensajeEstado || null
          },
          source: 'smartmovepro-soap',
          savedAt: Date.now()
        });
      }

      return jsonResponse({ error: 'Endpoint no encontrado' }, 404);
    } catch (err) {
      return jsonResponse({ error: 'Error conectando con SWParadas.asmx', detail: err.message }, 502);
    }
  }
};
