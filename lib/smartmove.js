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

const DRIVER_NAME_OVERRIDES = {
  '14172': 'BARRIOS CARLOS SEBASTIAN',
  '12360': 'PUCHETA NELSON HERNAN',
  '10304': 'DABRIO JUAN',
  '98535': 'GIMENEZ MARCOS ANTONIO',
  '98514': 'GIMENEZ ARNALDO JAVIER',
  '10242': 'GIMENEZ MARIO JOSE',
  '10880': 'ESCALANTE ADOLFO GUSTAVO',
  '13347': 'GALVEZ ALAN GASTON',
  '10413': 'PARRAS EDGARDO JUAN',
  '12222': 'VILLALBA DAMIAN EMANUEL',
  '10903': 'ACEVEDO NESTOR DAMIAN',
  '98534': 'MIRANDA MARCOS CESAR',
  '98513': 'BENITEZ JOSE LUIS',
  '10830': 'ARCE ROBERTO CARLOS',
  '12359': 'PORTO LISANDRO LUCAS',
  '98540': 'IBARRA MAXIMILIANO ARIEL',
  '13337': 'VILLAR MATIAS DANIEL',
  '13177': 'ACEVEDO GUSTAVO ADOLFO',
  '98512': 'ORTIZ ANIBAL OSCAR',
  '10853': 'GOMEZ ROBERTO WALDEMAR',
  '14128': 'LANNUZZI HECTOR MIGUEL',
  '12109': 'BARRIOS CLAUDIO ANDRES',
  '10231': 'CANTERO TERENCIO DE JESUS',
  '19060': 'TRIPIER JUAN LUIS',
  '10164': 'MACIEL JUAN MANUEL',
  '10128': 'ESTIGARRIBIA RAMON TOMAS',
  '10246': 'MAIDANA JORGE OSVALDO',
  '10340': 'MARINILLI JULIO CESAR',
  '14034': 'PINTOS DANIEL ALEJANDRO',
  '10463': 'DUARTE ANTONIO REGINO',
  '10043': 'SOSA CHRISTIAN HUGO',
  '19020': 'CANTEROS JUAN RAMON',
  '10139': 'RIOS LEONARDO RAMON',
  '10159': 'SANCHEZ FLORENCIO NICOLAS',
  '10477': 'ENRIQUEZ CLAUDIO SEBASTIAN',
  '10131': 'LOPEZ JUAN DOMINGO',
  '12127': 'OLIVERA VICTOR RAFAEL',
  '19034': 'ESPINOSA JORGE EULICES',
  '12040': 'NOVACK ADELAIDA AGNES',
  '12318': 'VALDEZ GASTON NERY',
  '19093': 'ROCH LUCAS MATIAS',
  '10469': 'FLORES ENZO RENE',
  '14104': 'BAZET RODRIGO SEBASTIAN',
  '12314': 'LENCINA JOSE ROLANDO',
  '10162': 'LENCINA RAUL EDUARDO',
  '14103': 'LENCINA LEON JESUS',
  '19125': 'LENCINAS CLAUDIO DANIEL',
  '10803': 'LENCINAS DIEGO WALTER',
  '98510': 'BUIATTI PABLO ANTONIO',
  '13121': 'TONIANES MANUEL ALEJANDRO',
  '19083': 'GOMES RAMON SERGIO',
  '10232': 'CARDOZO DIEGO',
  '10007': 'CARDOZO OSVALDO LUIS',
  '10405': 'CARDOZO MARIO ROBERTO',
  '14141': 'CARDOZO GERARDO DAVID',
  '13182': 'SOTO DIEGO RAMON',
  '12351': 'SOTO GERONIMO DE JESUS',
  '13082': 'SOTO HECTOR JOSE',
  '13037': 'SOTO JOSE GUSTAVO',
  '13155': 'RODRIGUEZ MAURO GABRIEL',
  '12353': 'AGUIRRE PEDRO OMAR',
  '10838': 'AQUINO MIGUEL ANGEL',
  '13012': 'FRETE JOSE RICARDO',
  '12196': 'LEZCANO PABLO LISANDRO',
  '13053': 'ACEVEDO HECTOR GERARDO',
  '13145': 'GONZALEZ JUAN ANTONIO',
  '14183': 'BERNAL PEDRO ARMANDO',
  '13075': 'ROBLEDO WALTER AMILCAR',
  '19105': 'MOLINA RODRIGO BELEN',
  '10181': 'ARAUJO CARLOS DANIEL',
  '10354': 'GONZALEZ CLAUDIO MARIA',
  '10132': 'MEDINA RAMON ALBERTO',
  '19146': 'LEZCANO LUIS ALBERTO',
  '12114': 'BARRIOS JOSE ANTONIO',
  '12163': 'GOMEZ RAMON ANIBAL',
  '12119': 'BILLORDO EDUARDO MIGUEL',
  '12218': 'TORREZ NESTOR JAVIER',
  '12293': 'ORTIZ JULIAN ABEL',
  '13078': 'GAUNA CARLOS ADRIAN',
  '10241': 'GAUNA OSCAR ENRIQUE',
  '12338': 'GUTIERREZ RAMON ALFREDO',
  '10400': 'FIGUEROA ALFREDO AGUSTIN',
  '12311': 'SAUCEDO MATIAS SEBASTIAN',
  '14164': 'BAEZ JOSE ANTONIO',
  '12270': 'ALARCON DIEGO ESTEBAN',
  '10248': 'PALOMO RAMON DE JESUS',
  '12297': 'ESTIGARRIBIA WILLIAM MARTIN',
  '12156': 'ESTIGARRIBIA MARTIN CIRIACO',
  '13058': 'GAMBOA HECTOR LUIS',
  '13111': 'MORALES VICENTE JAVIER',
  '10495': 'ROMERO ABEL',
  '13110': 'QUIROGA ANTONIO OCTAVIO',
  '19144': 'ERMOSI GONZALO ADRIAN',
  '10907': 'ESCOBAR JESUS EMANUEL',
  '19084': 'ESCOBAR ESTEBAN SIXTO',
  '10002': 'AGUILAR BERNARDINO',
  '19059': 'AGUILAR JOSE CARLOS',
  '98508': 'GONZALEZ RUBEN OSCAR',
  '13336': 'GOMEZ JUAN ALBERTO',
  '13181': 'SANCHEZ PABLO MARTIN',
  '98518': 'SANCHEZ RODRIGO ANTONIO',
  '12333': 'CABRAL JONATHAN OMAR',
  '12117': 'CABRAL RAFAEL FRANCISCO',
  '14009': 'BRAUVANO OSVALDO LUIS',
  '12313': 'ENCINAS VICTOR SERGIO',
  '10177': 'BAZANTI RICARDO DANIEL'
};

function resolveDriverDisplayInfo(choferLegajo = '', choferNombre = '', choferRaw = '') {
  let leg = String(choferLegajo || '').trim();
  const nom = String(choferNombre || '').trim();
  const raw = String(choferRaw || '').trim();

  if (!leg && raw) {
    const rm = raw.match(/\(\s*([^)]+)\s*\)\s*$/);
    if (rm) leg = rm[1].trim();
  }

  const lookupOverride = (candidate) => {
    const clean = String(candidate || '').trim();
    if (!clean) return null;
    if (DRIVER_NAME_OVERRIDES[clean]) return { leg: clean, nombre: DRIVER_NAME_OVERRIDES[clean] };
    const noZero = clean.replace(/^0+/, '');
    if (noZero && DRIVER_NAME_OVERRIDES[noZero]) return { leg: noZero, nombre: DRIVER_NAME_OVERRIDES[noZero] };
    return null;
  };

  const byLeg = lookupOverride(leg);
  if (byLeg) return { nombre: byLeg.nombre, legajo: leg || byLeg.leg };

  if (nom) {
    const m = nom.match(/^(?:Legajo\s+)?0*(\d+)$/i) || nom.match(/\(\s*0*(\d+)\s*\)\s*$/);
    if (m) {
      const byNameId = lookupOverride(m[1]);
      if (byNameId) return { nombre: byNameId.nombre, legajo: leg || byNameId.leg };
    }
  }

  if (raw && !nom) {
    const m = raw.match(/^(?:Legajo\s+)?0*(\d+)$/i) || raw.match(/\(\s*0*(\d+)\s*\)\s*$/);
    if (m) {
      const byRawId = lookupOverride(m[1]);
      if (byRawId) return { nombre: byRawId.nombre, legajo: leg || byRawId.leg };
    }
  }

  return { nombre: nom, legajo: leg };
}

function parseChofer(raw = '') {
  const clean = String(raw || '').trim();
  if (!clean) return { choferNombre: '', choferLegajo: '', choferRaw: '' };
  const m = clean.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
  if (m) {
    const resolved = resolveDriverDisplayInfo(m[2].trim(), m[1].trim(), clean);
    return {
      choferNombre: resolved.nombre,
      choferLegajo: resolved.legajo,
      choferRaw: clean
    };
  }
  const resolved = resolveDriverDisplayInfo('', clean, clean);
  return { choferNombre: resolved.nombre, choferLegajo: resolved.legajo, choferRaw: clean };
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

        // Deduplicate by CodigoLineaParada, filter removed lines, and normalize public line names
        const REMOVED_CODES = new Set([517, 607, 608, 744, 851, 853, 854]);
        const NAME_OVERRIDES = { 433: '103D', 705: '109C', 852: '902' };
        const seen = new Set();
        const normalized = [];
        for (const item of list) {
          const cod = Number(item.CodigoLineaParada);
          if (!cod || REMOVED_CODES.has(cod) || seen.has(cod)) continue;
          seen.add(cod);
          normalized.push({
            codigo: cod,
            descripcion: NAME_OVERRIDES[cod] || String(item.Descripcion || '').trim(),
            codigoEntidad: item.CodigoEntidad,
            codigoEmpresa: item.CodigoEmpresa
          });
        }
        return normalized.sort((a, b) => a.descripcion.localeCompare(b.descripcion, 'es', { numeric: true }));
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

        if (routes.length === 0) {
          return { ...basePayload, corridorFleet: baseArribos, corridorProbeCount: 0, extendedCount: 0, fullFleet: true };
        }

        const stopBranches = routes.filter((r) =>
          (r.paradas || []).some((p) => String(p.identificador).toUpperCase() === stopId)
        );
        const stopBranch = stopBranches[0] || routes[0];
        const oppBranch = routes.find((r) => !stopBranches.includes(r) && (r.paradas || []).length >= 5);

        const sStops = stopBranch?.paradas || [];
        const oStops = oppBranch?.paradas || [];
        const idx = sStops.findIndex((p) => String(p.identificador).toUpperCase() === stopId);

        const probes = [];
        const seenIds = new Set([stopId]);
        const pushProbe = (st, zone) => {
          const id = String(st?.identificador || '').trim().toUpperCase();
          if (!id || seenIds.has(id)) return;
          seenIds.add(id);
          probes.push({ stop: st, stopId: id, zone });
        };

        if (idx >= 0) {
          const after = sStops.slice(idx + 1);
          if (after.length <= 3) {
            for (const st of after) pushProbe(st, 'downstream');
          } else {
            for (const f of [0.3, 0.7, 1.0]) {
              pushProbe(after[Math.min(after.length - 1, Math.round(f * (after.length - 1)))], 'downstream');
            }
          }
          for (let b = 1; b < stopBranches.length && probes.filter((p) => p.zone === 'downstream').length < 4; b++) {
            const sec = stopBranches[b].paradas || [];
            const sIdx = sec.findIndex((p) => String(p.identificador).toUpperCase() === stopId);
            if (sIdx >= 0 && sec.length - 1 > sIdx) pushProbe(sec[sec.length - 1], 'downstream');
          }
          const before = sStops.slice(0, idx);
          if (before.length <= 3) {
            for (const st of before) pushProbe(st, 'upstream');
          } else {
            for (const f of [0.2, 0.55, 0.85]) {
              pushProbe(before[Math.min(before.length - 1, Math.round(f * (before.length - 1)))], 'upstream');
            }
          }
        }
        if (oStops.length >= 5) {
          for (const f of [0.5, 0.92]) {
            pushProbe(oStops[Math.min(oStops.length - 1, Math.round(f * (oStops.length - 1)))], 'opposite');
          }
        }

        const probeResults = await Promise.all(
          probes.map(async (p) => {
            try {
              const r = await this._cached(`probe:${p.stopId}:${lineNum}`, 18 * 1000, async () => {
                const res = await this.getArribos(p.stopId, String(lineNum));
                return res.data?.arribos || [];
              });
              return { stop: p.stop, stopId: p.stopId, zone: p.zone, arribos: r.data || [] };
            } catch {
              return { stop: p.stop, stopId: p.stopId, zone: p.zone, arribos: [] };
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
        const extraNextLaps = [];
        const sortedBase = [...baseArribos].sort(
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
            return { stop: pr.stop, stopId: pr.stopId, items: Array.from(byCid.entries()) };
          });

        // Fixed-point anchor propagation across approaching probe stops
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

        // Deduplicated corridorFleet across base + all probes (downstream, upstream, opposite)
        const byUnit = new Map();
        const ingest = (list, zone) => {
          for (const a of list || []) {
            const cod = Number(a.codigoLinea) || 0;
            const coche = String(a.identificadorCoche || '').trim();
            if (!cod || !coche) continue;
            const k = `${cod}:${coche}`;
            if (!byUnit.has(k)) {
              byUnit.set(k, { ...a, probeZone: zone });
            }
          }
        };
        ingest(merged, 'base');
        for (const pr of probeResults) ingest(pr.arribos, pr.zone);

        return {
          ...basePayload,
          arribos: merged,
          corridorFleet: Array.from(byUnit.values()),
          corridorProbeCount: probes.length,
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

        const REMOVED_CODES = new Set([517, 607, 608, 744, 851, 853, 854]);
        const NAME_OVERRIDES = { 433: '103D', 705: '109C', 852: '902' };

        const arribos = rawArribos
          .filter((a) => !REMOVED_CODES.has(Number(a.CodigoLineaParada)))
          .map((a) => {
            const cod = Number(a.CodigoLineaParada) || 0;
            const chofer = parseChofer(a.IdentificadorChofer);
            return {
              codigoLinea: cod,
              tiempoRestanteArribo: String(a.Arribo || '').trim(),
              descripcionLinea: NAME_OVERRIDES[cod] || String(a.DescripcionLinea || '').trim(),
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

const client = new SmartMoveSoapClient();
client.DRIVER_NAME_OVERRIDES = DRIVER_NAME_OVERRIDES;
client.resolveDriverDisplayInfo = resolveDriverDisplayInfo;
module.exports = client;
