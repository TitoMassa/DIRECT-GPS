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

  async getHorariosProgramados(idParada, codLinea, tipoDia = 'auto') {
    const stopId = String(idParada || '').trim().toUpperCase();
    const lineNum = Number(codLinea);
    if (!stopId || !lineNum) {
      return { data: { horarios: [], frecuenciaMin: null, available: false }, source: 'smartmovepro-soap', savedAt: Date.now() };
    }

    // Argentina time (UTC-3, no DST)
    const nowArt = new Date(Date.now() - 3 * 3600 * 1000);
    const pad = (n) => String(n).padStart(2, '0');
    const getTipo = (dow) => (dow === 0 ? 'domingo' : dow === 6 ? 'sabado' : 'habil');
    const dayStartUtcMs = Date.UTC(nowArt.getUTCFullYear(), nowArt.getUTCMonth(), nowArt.getUTCDate(), 0, 0, 0);

    const todayDow = nowArt.getUTCDay();
    const todayTipo = getTipo(todayDow);
    const requestedTipo = tipoDia === 'auto' ? todayTipo : tipoDia;

    // SmartMovePro publishes schedules for D+0 (from now..23:59), D+1 (00:00..23:59), D+2 (00:00..23:59).
    // NEVER mix two different calendar days!
    let targetOffset = null; // 0 = today remaining, 1 = D+1 full 24h, 2 = D+2 full 24h
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
      // If requestedTipo is today's type and neither D+1 nor D+2 matches (e.g. Friday asking for 'habil',
      // Saturday asking for 'sabado', Sunday asking for 'domingo'), return today's clean remaining hours.
      if (targetOffset === null && requestedTipo === todayTipo) {
        targetOffset = 0;
      }
    }

    if (targetOffset === null) {
      const labelMap = { habil: 'Lun–Vie', sabado: 'Sábado', domingo: 'Domingo' };
      return {
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
      };
    }

    const targetDate = new Date(dayStartUtcMs + targetOffset * 86400 * 1000);
    const dateIsoPrefix = `${targetDate.getUTCFullYear()}-${pad(targetDate.getUTCMonth() + 1)}-${pad(targetDate.getUTCDate())}`;
    const cacheKey = `horarios:${stopId}:${lineNum}:${requestedTipo}:${dateIsoPrefix}:${targetOffset === 0 ? Math.floor(nowArt.getUTCHours() / 2) : 'full'}`;

    return this._cached(
      cacheKey,
      targetOffset === 0 ? 30 * 60 * 1000 : 12 * 60 * 60 * 1000,
      async () => {
        const windows = [];
        if (targetOffset === 0) {
          // Strictly today from now+2m up to 23:59:59 (never crossing midnight)
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
          // Full 24h clean single day (00:00:00 -> 23:59:59) in 12 exact 2-hour windows
          for (let h = 0; h < 24; h += 2) {
            const endH = h + 1;
            windows.push([
              `${dateIsoPrefix}T${pad(h)}:00:00`,
              `${dateIsoPrefix}T${pad(endH)}:59:59`
            ]);
          }
        }

        const results = await Promise.all(
          windows.map(([desde, hasta]) =>
            this._soapRequest(
              'RecuperarHorariosProgramadosPorLineaParada',
              `<usuario i:type="d:string">${escapeXml(SOAP_USER)}</usuario>
               <clave i:type="d:string">${escapeXml(SOAP_PASS)}</clave>
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
            const minuteOfDay = parseInt(hh, 10) * 60 + parseInt(mm, 10);
            horarios.push({
              codigoLinea: Number(item.CodigoLinea) || lineNum,
              identificadorParada: item.IdentificadorParada || stopId,
              bandera: String(item.DescripcionBandera || '').trim(),
              horaPaso: rawPaso,
              hora: hhmm,
              minuteOfDay
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

        return {
          idParada: stopId,
          codigoLinea: lineNum,
          tipoDia: requestedTipo === 'hoy' ? todayTipo : requestedTipo,
          fechaConsultada: dateIsoPrefix,
          available: true,
          partial: targetOffset === 0,
          horarios,
          frecuenciaMin
        };
      },
      () => ({
        idParada: stopId,
        codigoLinea: lineNum,
        tipoDia: requestedTipo,
        available: false,
        partial: false,
        horarios: [],
        frecuenciaMin: null
      })
    );
  }

  /**
   * Discovers the ENTIRE active fleet of a single line approaching `idParada`
   * (overcoming SmartMovePro's 3-arrival cap) by probing upstream stops in parallel
   * and propagating exact arrival times via overlapping anchor cars.
   */
  async getArribosLineaCompleto(idParada, codLinea) {
    const stopId = String(idParada || '').trim().toUpperCase();
    const lineNum = Number(codLinea);
    if (!stopId || !lineNum) {
      return this.getArribos(stopId, '000');
    }

    return this._cached(
      `arribos-full:${stopId}:${lineNum}`,
      4 * 1000,
      async () => {
        const [baseRes, recRes] = await Promise.all([
          this.getArribos(stopId, String(lineNum)),
          this.getRecorridos(lineNum)
        ]);

        const basePayload = baseRes.data || {};
        const baseArribos = Array.isArray(basePayload.arribos) ? basePayload.arribos : [];
        const routes = Array.isArray(recRes.data) ? recRes.data : [];

        // If < 3 direct arrivals, no hidden cars behind them
        if (baseArribos.length < 3 || routes.length === 0) {
          return { ...basePayload, extendedCount: 0, fullFleet: true };
        }

        const stopBranch =
          routes.find((r) => (r.paradas || []).some((p) => String(p.identificador).toUpperCase() === stopId)) ||
          routes[0];
        const oppBranch = routes.find((r) => r !== stopBranch && (r.paradas || []).length >= 5);

        const sStops = stopBranch?.paradas || [];
        const oStops = oppBranch?.paradas || [];
        const idx = sStops.findIndex((p) => String(p.identificador).toUpperCase() === stopId);

        const upstream = [];
        if (idx >= 0) {
          for (let i = idx - 1; i >= 0; i--) upstream.push(sStops[i]);
          for (let i = oStops.length - 1; i >= 0; i--) upstream.push(oStops[i]);
          for (let i = sStops.length - 1; i > idx; i--) upstream.push(sStops[i]);
        }

        const probes = [];
        const numProbes = Math.min(6, upstream.length);
        for (let k = 1; k <= numProbes; k++) {
          const pIdx = Math.min(upstream.length - 1, Math.floor((k * upstream.length) / (numProbes + 1)));
          const st = upstream[pIdx];
          if (st && st.identificador && !probes.some((p) => p.identificador === st.identificador)) {
            probes.push(st);
          }
        }

        const probeResults = await Promise.all(
          probes.map(async (st) => {
            try {
              const r = await this.getArribos(st.identificador, String(lineNum));
              return { stop: st, arribos: r.data?.arribos || [] };
            } catch {
              return { stop: st, arribos: [] };
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
        for (const a of baseArribos) {
          const cid = a.identificadorCoche || `${a.latitud},${a.longitud}`;
          fleet.set(cid, {
            arribo: { ...a, esExtendido: false, viaParada: null },
            etaMin: parseMin(a.tiempoRestanteArribo)
          });
        }

        // Fixed-point anchor propagation across probe stops
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
                    descripcionBandera: baseArribos[0]?.descripcionBandera || a.descripcionBandera,
                    latitudParada: String(basePayload.stopCoords?.lat ?? ''),
                    longitudParada: String(basePayload.stopCoords?.lng ?? ''),
                    esExtendido: true,
                    viaParada: pr.stop.identificador
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

        return {
          ...basePayload,
          arribos: merged,
          extendedCount: merged.filter((x) => x.esExtendido).length,
          fullFleet: true
        };
      }
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
