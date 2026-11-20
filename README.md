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
- **Archivo permanente de horarios programados**: [scripts/scan-horarios.mjs](scripts/scan-horarios.mjs) escanea todas las líneas × todas las paradas y guarda la grilla completa (Lun–Vie, Sábado, Domingo) en [docs/data/horarios/](docs/data/horarios/). Lo ejecuta GitHub Actions todas las noches a las 03:30 ([horarios.yml](.github/workflows/horarios.yml)); también se puede lanzar a mano desde la pestaña **Actions → Archivo de horarios programados → Run workflow**. Nunca borra datos: si SmartMovePro falla o devuelve vacío, se conserva la última grilla conocida. La app consulta primero este archivo, luego la caché local y por último SmartMovePro en vivo.
- **Aplicación nativa Android (APK)**: Proyecto Capacitor 6 en [android/](android/) ([capacitor.config.json](capacitor.config.json)) con puente nativo en [docs/js/native.js](docs/js/native.js) y plugin local [`SystemUiPlugin`](android/app/src/main/java/ar/corrientes/directgps/SystemUiPlugin.java).

## Aplicación Android (APK)

### Integración con el sistema Android
- **Barras de sistema sincronizadas**: Barra de estado y barra de navegación adaptadas automáticamente al tema Nocturno/Claro, siguiendo la preferencia del sistema en el primer inicio.
- **Botón/gesto Atrás jerárquico**: Cierra modales, búsqueda, inspector de coche, horarios, colapsa el panel, retrocede en el árbol de líneas o vuelve al inicio antes de minimizar la app.
- **GPS nativo y permisos en tiempo de ejecución**: Flujo nativo de ubicación (`ACCESS_FINE_LOCATION` / `ACCESS_COARSE_LOCATION`) accesible tanto desde *Cercanas* como desde el botón rápido de ubicación en el mapa.
- **Notificaciones de arribo (`≤ 3 min`) + pantalla activa**: Canal dedicado de alta prioridad (`arribos`) con vibración y tap directo a la parada; mantiene la pantalla encendida mientras hay alertas armadas.
- **Compartir nativo y Deep Links**: Comparte enlaces públicos desde el selector nativo de Android y abre enlaces `https://titomassa.github.io/DIRECT-GPS/?idParada=...` o `directgps://parada/CT31498` directamente en la app.
- **Atajos del lanzador (App Shortcuts)**: Manteniendo presionado el ícono se accede directo a *Paradas cercanas (GPS)*, *Favoritas* o *Líneas*.
- **Íconos adaptativos (Android 8–14+ con ícono monocromo Material You) y SplashScreen nativo**.
- **Diseño responsivo y fluido**: Hoja inferior arrastrable en tiempo real con inercia en vertical, riel lateral automático en horizontal y tablets, áreas seguras (`safe-area-inset`), respuesta háptica y pausa automática de animaciones/polling en segundo plano.

### Compilar el APK localmente

Requisitos: **Node.js ≥ 20**, **JDK 17** y **Android SDK (API 34)**.

```bash
npm install
npm run android:debug      # genera android/app/build/outputs/apk/debug/app-debug.apk
npm run android:release    # genera android/app/build/outputs/apk/release/app-release.apk
```

También se compila automáticamente mediante GitHub Actions ([android-apk.yml](.github/workflows/android-apk.yml)) publicando los APK listos para instalar en la pestaña **Actions → Build Android APK**. Para firmar el release con tu propio keystore en CI, definí los secrets `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` y `ANDROID_KEY_PASSWORD`.

