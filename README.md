# DIRECT GPS · Corrientes

Rework inmersivo y en tiempo real de Cuando Llega Corrientes con mapa libre **Leaflet + OpenStreetMap** (sin API keys ni mapas satelitales pagos) y conexión directa en vivo al servicio SOAP `SWParadas.asmx` a través de **Cloudflare Workers**.

🌐 **Aplicación en vivo (GitHub Pages):** https://titomassa.github.io/DIRECT-GPS/

## Características principales

- **Inicio limpio**: Abre directamente sobre la vista general de Corrientes Capital sin cargar ninguna parada hasta que el usuario busque un código (ej. `CT31498`), navegue por **Líneas** (`Línea → Calle → Intersección → Parada`) o explore **Paradas Cercanas**.
- **Mapas 100% libres con Leaflet + OpenStreetMap**: Tres estilos sin API key (**OSM Nocturno**, **OSM Clásico** y **OSM Urbano HOT**).
- **Telemetría SOAP en vivo (`codigoLineaParada = 000`)**:
  - **Desvío horario (`+` / `-`)**: Adelantado (`▲ +`), atrasado (`▼ -`) o en horario (`00:00`).
  - **Número de coche (`IdentificadorCoche`)**, **Chofer** y **ID / Legajo** (`IdentificadorChofer`).
  - **Cartel LED**, **última señal GPS**, distancia real y cuadras aproximadas.
- **Modo Simulación por Interpolación SOAP**: En lugar de datos ficticios, toma las unidades reales devueltas por `SWParadas.asmx` y sus recorridos reales (`RecuperarRecorridoParaMapaAbrevYAmpliPorEntidadYLinea`), interpolando su avance segundo a segundo sobre las calles reales de Corrientes entre cada refresco SOAP.
- **Red completa de Corrientes (33 líneas)**, recorridos interactivos, alertas sonoras (`≤ 3 min`) y favoritas guardadas localmente.

## Arquitectura

- **Frontend estático (GitHub Pages)**: [docs/](docs/) conectado por defecto a `https://direct-gps-proxy.tecladotropical.workers.dev` ([`DEFAULT_API_BASE`](docs/js/config.js)).
- **Proxy SOAP en el borde (Cloudflare Workers)**: [cloudflare-worker/worker.js](cloudflare-worker/worker.js).
- **Servidor Node.js local opcional**: `npm start` ([server.js](server.js) + [lib/smartmove.js](lib/smartmove.js)).
