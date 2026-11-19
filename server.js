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
      return sendJson(res, 200, { ok: true, service: 'DIRECT GPS · Corrientes', timestamp: Date.now() });
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
      return sendJson(res, 200, result);
    }

    if (pathname === '/api/arribos') {
      const idParada = searchParams.get('idParada') || PILOT_STOP.id;
      const codLinea = searchParams.get('codLinea') || '000';
      const simulate = searchParams.get('simulate') === '1';
      const result = await smartmove.getArribos(idParada, codLinea, simulate);
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
