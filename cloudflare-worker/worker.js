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
        for (const r of results) {
          const list = Array.isArray(r?.HorariossProgramados)
            ? r.HorariossProgramados
            : Array.isArray(r?.HorariosProgramados)
              ? r.HorariosProgramados
              : [];
          for (const item of list) {
            const rawPaso = String(item.HoraPaso || '').trim();
            if (!rawPaso || seen.has(rawPaso)) continue;
            seen.add(rawPaso);
            const timePart = (rawPaso.split(' ')[1] || '').trim();
            const hhmm = timePart.slice(0, 5);
            const [hh = '0', mm = '0'] = hhmm.split(':');
            horarios.push({
              codigoLinea: Number(item.CodigoLinea) || lineNum,
              identificadorParada: item.IdentificadorParada || stopId,
              bandera: String(item.DescripcionBandera || '').trim(),
              horaPaso: rawPaso,
              hora: hhmm,
              minuteOfDay: parseInt(hh, 10) * 60 + parseInt(mm, 10)
            });
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
            partial: targetOffset === 0,
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

        const fetchOneStop = async (sid, lcode) => {
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
            };
          });
          return {
            arribos,
            idParada: sid,
            codLinea: lcode,
            stopCoords: sLat !== null && sLng !== null ? { lat: sLat, lng: sLng } : null,
            knownStop: known || null,
            codigoEstado: raw?.CodigoEstado ?? 0,
            mensaje: raw?.MensajeEstado || null
          };
        };

        const basePayload = await fetchOneStop(stopId, lineCode);

        // Full-fleet upstream anchor discovery when /api/arribos-linea is requested for a specific line
        if (pathname === '/api/arribos-linea' && lineCode !== '000' && basePayload.arribos.length >= 3) {
          const lineNum = Number(lineCode);
          const stopsRes = await soapRequest(
            'RecuperarParadasCompletoPorLinea',
            `<usuario i:type="d:string">${SOAP_USER}</usuario>
             <clave i:type="d:string">${SOAP_PASS}</clave>
             <codigoLineaParada i:type="d:int">${lineNum}</codigoLineaParada>
             <isSublinea i:type="d:boolean">false</isSublinea>
             <isInteligente i:type="d:boolean">false</isInteligente>`
          ).catch(() => ({ paradas: {} }));

          const branches = Object.values(stopsRes?.paradas || {}).filter((arr) => Array.isArray(arr) && arr.length > 0);
          const stopBranch =
            branches.find((arr) => arr.some((p) => String(p.Identificador).toUpperCase() === stopId)) || branches[0] || [];
          const oppBranch = branches.find((arr) => arr !== stopBranch && arr.length >= 5) || [];
          const idx = stopBranch.findIndex((p) => String(p.Identificador).toUpperCase() === stopId);

          const upstream = [];
          if (idx >= 0) {
            for (let i = idx - 1; i >= 0; i--) upstream.push(stopBranch[i]);
            for (let i = oppBranch.length - 1; i >= 0; i--) upstream.push(oppBranch[i]);
            for (let i = stopBranch.length - 1; i > idx; i--) upstream.push(stopBranch[i]);
          }

          const probes = [];
          const numProbes = Math.min(6, upstream.length);
          for (let k = 1; k <= numProbes; k++) {
            const pIdx = Math.min(upstream.length - 1, Math.floor((k * upstream.length) / (numProbes + 1)));
            const st = upstream[pIdx];
            if (st?.Identificador && !probes.some((p) => p.Identificador === st.Identificador)) {
              probes.push(st);
            }
          }

          const probeResults = await Promise.all(
            probes.map(async (st) => {
              try {
                const r = await fetchOneStop(String(st.Identificador).toUpperCase(), lineCode);
                return { stopId: String(st.Identificador).toUpperCase(), arribos: r.arribos || [] };
              } catch {
                return { stopId: String(st.Identificador).toUpperCase(), arribos: [] };
              }
            })
          );

          const parseMin = (txt) => {
            const l = String(txt || '').toLowerCase();
            if (l.includes('arriband') || l.includes('llegand')) return 0.5;
            const m = l.match(/(\d+)/);
            return m ? parseInt(m[1], 10) : null;
          };

          const fleet = new Map();
          for (const a of basePayload.arribos) {
            const cid = a.identificadorCoche || `${a.latitud},${a.longitud}`;
            fleet.set(cid, {
              arribo: { ...a, esExtendido: false, viaParada: null },
              etaMin: parseMin(a.tiempoRestanteArribo)
            });
          }

          for (let pass = 0; pass < 4; pass++) {
            let added = false;
            for (const pr of probeResults) {
              const deltas = [];
              for (const a of pr.arribos) {
                const cid = a.identificadorCoche || `${a.latitud},${a.longitud}`;
                const pMin = parseMin(a.tiempoRestanteArribo);
                if (fleet.has(cid) && pMin !== null && fleet.get(cid).etaMin !== null) {
                  const d = fleet.get(cid).etaMin - pMin;
                  if (d >= 0 && d <= 100) deltas.push(d);
                }
              }
              if (deltas.length === 0) continue;
              deltas.sort((a, b) => a - b);
              const travelDelta = deltas[Math.floor(deltas.length / 2)];

              for (const a of pr.arribos) {
                const cid = a.identificadorCoche || `${a.latitud},${a.longitud}`;
                const pMin = parseMin(a.tiempoRestanteArribo);
                if (!fleet.has(cid) && pMin !== null) {
                  const estMin = Math.max(1, Math.round(pMin + travelDelta));
                  fleet.set(cid, {
                    arribo: {
                      ...a,
                      tiempoRestanteArribo: `${estMin} min. est.`,
                      descripcionBandera: basePayload.arribos[0]?.descripcionBandera || a.descripcionBandera,
                      latitudParada: String(basePayload.stopCoords?.lat ?? ''),
                      longitudParada: String(basePayload.stopCoords?.lng ?? ''),
                      esExtendido: true,
                      viaParada: pr.stopId
                    },
                    etaMin: estMin
                  });
                  added = true;
                }
              }
            }
            if (!added) break;
          }

          const merged = Array.from(fleet.values())
            .sort((a, b) => (a.etaMin ?? 999) - (b.etaMin ?? 999))
            .map((x) => x.arribo);

          return jsonResponse({
            data: {
              ...basePayload,
              arribos: merged,
              extendedCount: merged.filter((x) => x.esExtendido).length,
              fullFleet: true
            },
            source: 'smartmovepro-soap',
            savedAt: Date.now()
          });
        }

        return jsonResponse({ data: basePayload, source: 'smartmovepro-soap', savedAt: Date.now() });
      }

      return jsonResponse({ error: 'Endpoint no encontrado' }, 404);
    } catch (err) {
      return jsonResponse({ error: 'Error conectando con SWParadas.asmx', detail: err.message }, 502);
    }
  }
};
