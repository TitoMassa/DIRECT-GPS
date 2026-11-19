const {
  SEED_LINEAS,
  QUICK_STOPS,
  getFallbackCalles,
  getFallbackIntersecciones,
  getFallbackParadas,
  getFallbackRecorridos,
  generateSimulatedArribos
} = require('./seed-data');

const SOAP_ENDPOINT = 'http://clsw.smartmovepro.net/ModuloParadas/SWParadas.asmx';
const SOAP_NS = 'http://clsw.smartmovepro.net/';
const SOAP_USER = process.env.SMP_USER || 'WEB.UPLATENSE';
const SOAP_PASS = process.env.SMP_PASS || 'PAR.SW.UPLATENSE';
const SOAP_APP_CODE = Number(process.env.SMP_APP_CODE) || 24;
const SOAP_LOCALIDAD = process.env.SMP_LOCALIDAD || 'CONTINENTAL';
const CORRIENTES_EMPRESAS = '358;666;266';

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
  if (m) {
    return {
      choferNombre: m[1].trim(),
      choferLegajo: m[2].trim(),
      choferRaw: clean
    };
  }
  return { choferNombre: clean, choferLegajo: '', choferRaw: clean };
}

class SmartMoveSoapClient {
  constructor() {
    this.cache = new Map(); // cacheKey -> { data, expiresAt, savedAt }
  }

  async _soapRequest(method, bodyInnerXml) {
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
      body: envelope,
      signal: AbortSignal.timeout(12000)
    });

    const xml = await res.text();
    if (!res.ok) {
      const err = new Error(`SOAP_HTTP_${res.status}`);
      err.status = res.status;
      throw err;
    }

    const regex = new RegExp(`<${method}Result>([\\s\\S]*?)</${method}Result>`);
    const match = xml.match(regex);
    if (!match) {
      const err = new Error('SOAP_EMPTY_RESULT');
      err.status = 502;
      throw err;
    }

    const jsonText = unescapeXml(match[1]);
    try {
      return JSON.parse(jsonText);
    } catch {
      const err = new Error('SOAP_INVALID_JSON');
      err.status = 502;
      throw err;
    }
  }

  async _cached(key, ttlMs, fetcher, fallbackFn = null) {
    const now = Date.now();
    const hit = this.cache.get(key);
    if (ttlMs > 0 && hit && hit.expiresAt > now) {
      return { data: hit.data, cached: true, stale: false, source: 'smartmovepro-soap', savedAt: hit.savedAt };
    }

    try {
      const data = await fetcher();
      if (ttlMs > 0) {
        this.cache.set(key, { data, expiresAt: now + ttlMs, savedAt: now });
      }
      return { data, cached: false, stale: false, source: 'smartmovepro-soap', savedAt: now };
    } catch (err) {
      if (hit) {
        return {
          data: hit.data,
          cached: true,
          stale: true,
          source: 'smartmovepro-cache',
          savedAt: hit.savedAt,
          warning: err.message
        };
      }
      if (fallbackFn) {
        return {
          data: fallbackFn(err),
          cached: false,
          stale: true,
          source: 'fallback',
          savedAt: now,
          warning: err.message
        };
      }
      throw err;
    }
  }

  async getLineas() {
    return this._cached(
      'lineas',
      6 * 60 * 60 * 1000,
      async () => {
        const res = await this._soapRequest(
          'RecuperarLineaPorLocalidad',
          `<usuario i:type="d:string">${escapeXml(SOAP_USER)}</usuario>
           <clave i:type="d:string">${escapeXml(SOAP_PASS)}</clave>
           <localidad i:type="d:string">CORRIENTES</localidad>
           <provincia i:type="d:string">CORRIENTES</provincia>
           <pais i:type="d:string">ARGENTINA</pais>
           <isSublinea i:type="d:boolean">false</isSublinea>`
        );
        const list = Array.isArray(res?.lineas) ? res.lineas : [];
        if (list.length === 0) return SEED_LINEAS;

        // Deduplicate by CodigoLineaParada and normalize shape
        const seen = new Set();
        const normalized = [];
        for (const item of list) {
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
      },
      () => SEED_LINEAS
    );
  }

  async getCalles(codLinea) {
    const clean = Number(codLinea);
    return this._cached(
      `calles:${clean}`,
      6 * 60 * 60 * 1000,
      async () => {
        const res = await this._soapRequest(
          'RecuperarCallesPrincipalPorLinea',
          `<usuario i:type="d:string">${escapeXml(SOAP_USER)}</usuario>
           <clave i:type="d:string">${escapeXml(SOAP_PASS)}</clave>
           <codigoLineaParada i:type="d:int">${clean}</codigoLineaParada>
           <isSubLinea i:type="d:boolean">false</isSubLinea>`
        );
        const list = Array.isArray(res?.calles) ? res.calles : [];
        return list.map((c) => ({
          codigo: Number(c.Codigo),
          descripcion: String(c.Descripcion || '').trim()
        }));
      },
      () => getFallbackCalles(codLinea)
    );
  }

  async getIntersecciones(codLinea, codCalle) {
    const l = Number(codLinea);
    const c = Number(codCalle);
    return this._cached(
      `inter:${l}:${c}`,
      6 * 60 * 60 * 1000,
      async () => {
        const res = await this._soapRequest(
          'RecuperarInterseccionPorLineaYCalle',
          `<usuario i:type="d:string">${escapeXml(SOAP_USER)}</usuario>
           <clave i:type="d:string">${escapeXml(SOAP_PASS)}</clave>
           <codigoLineaParada i:type="d:int">${l}</codigoLineaParada>
           <codigoCalle i:type="d:int">${c}</codigoCalle>
           <isSubLinea i:type="d:boolean">false</isSubLinea>`
        );
        const list = Array.isArray(res?.calles) ? res.calles : [];
        return list.map((i) => ({
          codigo: Number(i.Codigo),
          descripcion: String(i.Descripcion || '').trim()
        }));
      },
      () => getFallbackIntersecciones(codCalle)
    );
  }

  async getParadas(codLinea, codCalle, codInterseccion) {
    const l = Number(codLinea);
    const c = Number(codCalle);
    const i = Number(codInterseccion);
    return this._cached(
      `paradas:${l}:${c}:${i}`,
      6 * 60 * 60 * 1000,
      async () => {
        const res = await this._soapRequest(
          'RecuperarParadasPorLineaCalleEInterseccion',
          `<usuario i:type="d:string">${escapeXml(SOAP_USER)}</usuario>
           <clave i:type="d:string">${escapeXml(SOAP_PASS)}</clave>
           <codigoLinea i:type="d:int">${l}</codigoLinea>
           <codigoCalle i:type="d:int">${c}</codigoCalle>
           <codigoInterseccion i:type="d:int">${i}</codigoInterseccion>
           <isSublinea i:type="d:boolean">false</isSublinea>
           <isInteligente i:type="d:boolean">false</isInteligente>`
        );
        const list = Array.isArray(res?.paradas) ? res.paradas : [];
        return list.map((p) => ({
          codigo: String(p.Codigo || ''),
          identificador: String(p.Identificador || '').trim(),
          descripcion: String(p.Descripcion || '').trim(),
          callePrincipal: p.CallePrincipal || '',
          calleInterseccion: p.CalleInterseccion || '',
          latitud: p.Latitud || null,
          longitud: p.Longitud || null,
          lineas: p.Lineas || ''
        }));
      },
      () => getFallbackParadas(codCalle, codInterseccion)
    );
  }

  async getParadasCercanas(lat, lng) {
    const rLat = Number(lat).toFixed(4);
    const rLng = Number(lng).toFixed(4);
    return this._cached(
      `cercanas:${rLat}:${rLng}`,
      10 * 60 * 1000,
      async () => {
        const res = await this._soapRequest(
          'RecuperarParadasMasCercanasPorLocalidadProvinciaPais',
          `<usuario i:type="d:string">${escapeXml(SOAP_USER)}</usuario>
           <clave i:type="d:string">${escapeXml(SOAP_PASS)}</clave>
           <latitud i:type="d:double">${Number(lat)}</latitud>
           <longitud i:type="d:double">${Number(lng)}</longitud>
           <listaCodigosEmpresa i:type="d:string">${CORRIENTES_EMPRESAS}</listaCodigosEmpresa>
           <descripcionProvincia i:type="d:string">CORRIENTES</descripcionProvincia>
           <descripcionPais i:type="d:string">ARGENTINA</descripcionPais>
           <isInteligente i:type="d:boolean">false</isInteligente>`
        );
        const list = Array.isArray(res?.paradas) ? res.paradas : [];
        return list.map((p) => ({
          codigo: String(p.Codigo || ''),
          identificador: String(p.Identificador || '').trim(),
          descripcion: String(p.Descripcion || '').trim(),
          callePrincipal: p.CallePrincipal || '',
          calleInterseccion: p.CalleInterseccion || '',
          latitud: p.Latitud ? String(p.Latitud) : null,
          longitud: p.Longitud ? String(p.Longitud) : null,
          lineas: p.Lineas || ''
        }));
      },
      () =>
        QUICK_STOPS.map((s) => ({
          codigo: s.codigo,
          identificador: s.id,
          descripcion: s.nombre,
          callePrincipal: s.callePrincipal,
          calleInterseccion: s.calleInterseccion,
          latitud: String(s.lat),
          longitud: String(s.lng),
          lineas: `Líneas: ${s.lineas.join(', ')}`
        }))
    );
  }

  async getRecorridos(codLinea) {
    const clean = Number(codLinea);
    return this._cached(
      `recorridos:${clean}`,
      12 * 60 * 60 * 1000,
      async () => {
        const [recRes, stopsRes] = await Promise.all([
          this._soapRequest(
            'RecuperarRecorridoParaMapaAbrevYAmpliPorEntidadYLinea',
            `<usuario i:type="d:string">${escapeXml(SOAP_USER)}</usuario>
             <clave i:type="d:string">${escapeXml(SOAP_PASS)}</clave>
             <codigoLineaParada i:type="d:int">${clean}</codigoLineaParada>
             <isSublinea i:type="d:boolean">false</isSublinea>`
          ),
          this._soapRequest(
            'RecuperarParadasCompletoPorLinea',
            `<usuario i:type="d:string">${escapeXml(SOAP_USER)}</usuario>
             <clave i:type="d:string">${escapeXml(SOAP_PASS)}</clave>
             <codigoLineaParada i:type="d:int">${clean}</codigoLineaParada>
             <isSublinea i:type="d:boolean">false</isSublinea>
             <isInteligente i:type="d:boolean">false</isInteligente>`
          ).catch(() => ({ paradas: {} }))
        ]);

        const puntos = Array.isArray(recRes?.puntos) ? recRes.puntos : [];
        const paradasByGit = stopsRes?.paradas && typeof stopsRes.paradas === 'object' ? stopsRes.paradas : {};

        // Group polyline points by AbreviaturaBanderaSMP
        const grouped = new Map();
        for (const pt of puntos) {
          const key = pt.AbreviaturaBanderaSMP || pt.Descripcion || 'RUTA';
          if (!grouped.has(key)) {
            const descParts = String(pt.Descripcion || '').split(';');
            grouped.set(key, {
              abreviaturaBanderaSMP: descParts[2] || descParts[1] || key,
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

        // Attach matching stops per branch
        for (const [gitKey, routeObj] of grouped.entries()) {
          const rawStops = Array.isArray(paradasByGit[gitKey]) ? paradasByGit[gitKey] : [];
          routeObj.paradas = rawStops.map((s) => ({
            codigo: s.Codigo,
            identificador: s.Identificador,
            descripcion: s.Descripcion,
            abreviaturaBandera: s.AbreviaturaBandera,
            latitudParada: s.LatitudParada,
            longitudParada: s.LongitudParada
          }));
        }

        return Array.from(grouped.values());
      },
      () => getFallbackRecorridos(codLinea)
    );
  }

  async getBanderasParada(idParada) {
    const stopId = String(idParada || 'CT31498').trim().toUpperCase();
    return this._cached(
      `banderas:${stopId}`,
      30 * 60 * 1000,
      async () => {
        const res = await this._soapRequest(
          'RecuperarBanderasAsociadasAParada',
          `<usuario i:type="d:string">${escapeXml(SOAP_USER)}</usuario>
           <clave i:type="d:string">${escapeXml(SOAP_PASS)}</clave>
           <identificadorParada i:type="d:string">${escapeXml(stopId)}</identificadorParada>
           <codigoAplicacion i:type="d:int">${SOAP_APP_CODE}</codigoAplicacion>`
        );
        return Array.isArray(res?.banderas) ? res.banderas : [];
      },
      () => []
    );
  }

  async getArribos(idParada, codLinea = '000', forceSimulate = false) {
    const stopId = String(idParada || 'CT31498').trim().toUpperCase();
    // Normalize "0" or empty to "000" (all lines, richer SOAP results)
    const rawCode = String(codLinea ?? '000').trim();
    const lineCode = !rawCode || rawCode === '0' ? '000' : rawCode;

    if (forceSimulate) {
      const sim = generateSimulatedArribos(stopId, lineCode);
      return {
        data: sim,
        cached: false,
        stale: false,
        source: 'simulation',
        savedAt: Date.now()
      };
    }

    // No rate limit on SWParadas.asmx! Minimal 3s dedup cache to keep responses instant & real-time.
    return this._cached(
      `arribos:${stopId}:${lineCode}`,
      3 * 1000,
      async () => {
        const raw = await this._soapRequest(
          'RecuperarProximosArribos',
          `<identificadorParada i:type="d:string">${escapeXml(stopId)}</identificadorParada>
           <codigoLineaParada i:type="d:int">${escapeXml(lineCode)}</codigoLineaParada>
           <codigoAplicacion i:type="d:int">${SOAP_APP_CODE}</codigoAplicacion>
           <localidad i:type="d:string">${escapeXml(SOAP_LOCALIDAD)}</localidad>
           <usuario i:type="d:string">${escapeXml(SOAP_USER)}</usuario>
           <clave i:type="d:string">${escapeXml(SOAP_PASS)}</clave>`
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
            // Rich SOAP telemetry fields
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
          idParada: stopId,
          codLinea: lineCode,
          stopCoords: stopLat !== null && stopLng !== null ? { lat: stopLat, lng: stopLng } : null,
          knownStop: known || null,
          codigoEstado: raw?.CodigoEstado ?? 0,
          mensaje: raw?.MensajeEstado || null
        };
      },
      () => generateSimulatedArribos(stopId, lineCode)
    );
  }
}

module.exports = new SmartMoveSoapClient();
