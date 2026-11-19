const fs = require('fs');
const path = require('path');
const {
  SEED_LINEAS,
  QUICK_STOPS,
  getFallbackCalles,
  getFallbackIntersecciones,
  getFallbackParadas,
  getFallbackRecorridos,
  generateSimulatedArribos
} = require('./seed-data');

const BASE_URL = 'https://cuandollega.smartmovepro.net/corrientes';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

const CACHE_DIR = path.join(__dirname, '..', '.cache');
const CACHE_FILE = path.join(CACHE_DIR, 'smartmove-cache.json');

class SmartMoveClient {
  constructor() {
    this.sessions = new Map();
    this.cache = new Map();
    this.queue = Promise.resolve();
    this.lastRequestAt = 0;
    this.minGapMs = 450;
    this.cooldownUntil = 0;

    this._loadPersistentCache();
  }

  _loadPersistentCache() {
    try {
      if (fs.existsSync(CACHE_FILE)) {
        const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
        for (const [key, entry] of Object.entries(raw)) {
          this.cache.set(key, entry);
        }
      }
    } catch {
      // Ignore corrupt cache file
    }
  }

  _savePersistentCache() {
    try {
      if (!fs.existsSync(CACHE_DIR)) {
        fs.mkdirSync(CACHE_DIR, { recursive: true });
      }
      const serializable = {};
      for (const [key, entry] of this.cache.entries()) {
        if (!key.startsWith('arribos:')) {
          serializable[key] = entry;
        }
      }
      fs.writeFileSync(CACHE_FILE, JSON.stringify(serializable));
    } catch {
      // Non-fatal
    }
  }

  _triggerCooldown(seconds = 60) {
    this.cooldownUntil = Date.now() + seconds * 1000;
  }

  _checkCooldown() {
    if (Date.now() < this.cooldownUntil) {
      const err = new Error('RATE_LIMITED_COOLDOWN');
      err.status = 429;
      throw err;
    }
  }

  _enqueue(fn) {
    const task = this.queue.then(async () => {
      const wait = Math.max(0, this.minGapMs - (Date.now() - this.lastRequestAt));
      if (wait > 0) {
        await new Promise((r) => setTimeout(r, wait));
      }
      this.lastRequestAt = Date.now();
      return fn();
    });
    this.queue = task.catch(() => {});
    return task;
  }

  _mergeCookies(cookieMap, setCookieHeaders) {
    if (!Array.isArray(setCookieHeaders)) return;
    for (const raw of setCookieHeaders) {
      const pair = raw.split(';')[0];
      const eq = pair.indexOf('=');
      if (eq > 0) {
        const k = pair.slice(0, eq).trim();
        const v = pair.slice(eq + 1).trim();
        cookieMap.set(k, v);
      }
    }
  }

  _cookieHeader(cookieMap) {
    return Array.from(cookieMap.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }

  _extractToken(html) {
    const m1 = html.match(/name="CSRF-TOKEN-CL-FORM"[^>]*value="([^"]+)"/i);
    if (m1) return m1[1];
    const m2 = html.match(/value="([^"]+)"[^>]*name="CSRF-TOKEN-CL-FORM"/i);
    return m2 ? m2[1] : null;
  }

  async _getSession(pageUrl, sessionKey, forceRefresh = false) {
    this._checkCooldown();
    const existing = this.sessions.get(sessionKey);
    const maxAgeMs = 15 * 60 * 1000;
    if (!forceRefresh && existing && Date.now() - existing.fetchedAt < maxAgeMs) {
      return existing;
    }

    const res = await fetch(pageUrl, {
      method: 'GET',
      headers: {
        'User-Agent': USER_AGENT,
        'Accept-Language': 'es-AR,es;q=0.9'
      },
      signal: AbortSignal.timeout(12000)
    });

    if (res.status === 429 || res.status === 403) {
      this._triggerCooldown(60);
      const err = new Error('RATE_LIMITED');
      err.status = 429;
      throw err;
    }

    const html = await res.text();
    const token = this._extractToken(html);
    if (!token) {
      const err = new Error('CSRF_TOKEN_MISSING');
      err.status = res.status;
      throw err;
    }

    const cookies = new Map();
    if (typeof res.headers.getSetCookie === 'function') {
      this._mergeCookies(cookies, res.headers.getSetCookie());
    }

    const session = { cookies, token, fetchedAt: Date.now() };
    this.sessions.set(sessionKey, session);
    return session;
  }

  async _postSmartMove(pageUrl, postUrl, sessionKey, bodyPayload = null) {
    return this._enqueue(async () => {
      this._checkCooldown();
      for (let attempt = 0; attempt < 2; attempt++) {
        const session = await this._getSession(pageUrl, sessionKey, attempt > 0);
        const headers = {
          'User-Agent': USER_AGENT,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/plain, */*',
          RequestVerificationToken: session.token,
          Cookie: this._cookieHeader(session.cookies),
          Origin: 'https://cuandollega.smartmovepro.net',
          Referer: pageUrl
        };

        const res = await fetch(postUrl, {
          method: 'POST',
          headers,
          body: bodyPayload !== null ? JSON.stringify(bodyPayload) : '',
          signal: AbortSignal.timeout(12000)
        });

        if (typeof res.headers.getSetCookie === 'function') {
          this._mergeCookies(session.cookies, res.headers.getSetCookie());
        }

        if (res.status === 429) {
          this._triggerCooldown(60);
          const err = new Error('RATE_LIMITED');
          err.status = 429;
          throw err;
        }

        if (res.status === 403) {
          const text = await res.text();
          if (text.toLowerCase().includes('acceso denegado')) {
            this._triggerCooldown(60);
            const err = new Error('RATE_LIMITED');
            err.status = 429;
            throw err;
          }
          if (attempt === 0) {
            this.sessions.delete(sessionKey);
            continue;
          }
        }

        if (res.status === 400 && attempt === 0) {
          this.sessions.delete(sessionKey);
          continue;
        }

        const text = await res.text();
        if (!res.ok) {
          const err = new Error(`UPSTREAM_${res.status}: ${text.slice(0, 120)}`);
          err.status = res.status;
          throw err;
        }

        try {
          return JSON.parse(text);
        } catch {
          const err = new Error('INVALID_JSON_UPSTREAM');
          err.status = 502;
          throw err;
        }
      }
      throw new Error('RETRY_EXHAUSTED');
    });
  }

  async _cached(key, ttlMs, fetcher, fallbackFn = null) {
    const now = Date.now();
    const hit = this.cache.get(key);
    if (hit && hit.expiresAt > now) {
      return { data: hit.data, cached: true, stale: false, source: 'smartmovepro', savedAt: hit.savedAt };
    }

    try {
      const data = await fetcher();
      this.cache.set(key, { data, expiresAt: now + ttlMs, savedAt: now });
      if (!key.startsWith('arribos:')) {
        this._savePersistentCache();
      }
      return { data, cached: false, stale: false, source: 'smartmovepro', savedAt: now };
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
      12 * 60 * 60 * 1000,
      async () => {
        const url = `${BASE_URL}/lineas`;
        const data = await this._postSmartMove(url, url, 'lineas', null);
        return Array.isArray(data) && data.length > 0 ? data : SEED_LINEAS;
      },
      () => SEED_LINEAS
    );
  }

  async getCalles(codLinea) {
    const clean = encodeURIComponent(String(codLinea));
    return this._cached(
      `calles:${clean}`,
      6 * 60 * 60 * 1000,
      async () => {
        const url = `${BASE_URL}/calles/?codLinea=${clean}`;
        return this._postSmartMove(url, url, `calles:${clean}`, null);
      },
      () => getFallbackCalles(codLinea)
    );
  }

  async getIntersecciones(codLinea, codCalle) {
    const l = encodeURIComponent(String(codLinea));
    const c = encodeURIComponent(String(codCalle));
    return this._cached(
      `inter:${l}:${c}`,
      6 * 60 * 60 * 1000,
      async () => {
        const url = `${BASE_URL}/intersecciones/?codLinea=${l}&codCalle=${c}`;
        return this._postSmartMove(url, url, `inter:${l}:${c}`, { codCalle: c, codLinea: l });
      },
      () => getFallbackIntersecciones(codCalle)
    );
  }

  async getParadas(codLinea, codCalle, codInterseccion) {
    const l = encodeURIComponent(String(codLinea));
    const c = encodeURIComponent(String(codCalle));
    const i = encodeURIComponent(String(codInterseccion));
    return this._cached(
      `paradas:${l}:${c}:${i}`,
      6 * 60 * 60 * 1000,
      async () => {
        const url = `${BASE_URL}/paradas/?codLinea=${l}&codCalle=${c}&codInterseccion=${i}`;
        return this._postSmartMove(url, url, `paradas:${l}:${c}:${i}`, {
          codCalle: c,
          codLinea: l,
          codInterseccion: i
        });
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
        const url = `${BASE_URL}/paradascercanas`;
        return this._postSmartMove(url, url, 'paradascercanas', {
          latitud: Number(lat),
          longitud: Number(lng)
        });
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
    const clean = String(codLinea);
    return this._cached(
      `recorridos:${clean}`,
      24 * 60 * 60 * 1000,
      async () => {
        const pageUrl = `${BASE_URL}/recorridos`;
        const postUrl = `${BASE_URL}/recorridos?handler=RecuperarRecorridos`;
        return this._postSmartMove(pageUrl, postUrl, 'recorridos', { codigoLinea: clean });
      },
      () => getFallbackRecorridos(clean)
    );
  }

  async getArribos(idParada, codLinea = '0', forceSimulate = false) {
    const stopId = String(idParada || 'CT31498').trim().toUpperCase();
    const lineCode = String(codLinea ?? '0').trim();

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

    return this._cached(
      `arribos:${stopId}:${lineCode}`,
      14 * 1000,
      async () => {
        const pageUrl = `${BASE_URL}/arribos/?codLinea=${encodeURIComponent(lineCode)}&idParada=${encodeURIComponent(stopId)}`;
        const raw = await this._postSmartMove(pageUrl, pageUrl, `arribos:${stopId}:${lineCode}`, {
          codLinea: lineCode,
          idParada: stopId
        });

        const arribos = Array.isArray(raw?.arribos) ? raw.arribos : [];
        let stopLat = null;
        let stopLng = null;
        for (const a of arribos) {
          if (a.latitudParada && a.longitudParada) {
            stopLat = parseFloat(a.latitudParada);
            stopLng = parseFloat(a.longitudParada);
            break;
          }
        }
        const known = QUICK_STOPS.find((s) => s.id === stopId);
        if ((stopLat === null || Number.isNaN(stopLat)) && known) {
          stopLat = known.lat;
          stopLng = known.lng;
        }

        return {
          arribos,
          idParada: stopId,
          codLinea: lineCode,
          stopCoords: stopLat !== null && stopLng !== null ? { lat: stopLat, lng: stopLng } : null,
          knownStop: known || null,
          mensaje: raw?.mensaje || null
        };
      },
      () => generateSimulatedArribos(stopId, lineCode)
    );
  }
}

module.exports = new SmartMoveClient();
