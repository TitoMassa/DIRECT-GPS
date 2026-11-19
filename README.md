# DIRECT GPS · Corrientes

Rework inmersivo y en tiempo real de Cuando Llega Corrientes con mapa interactivo **Leaflet** a pantalla completa y conexión directa al servicio SOAP `SWParadas.asmx` (sin límite de consultas).

🌐 **GitHub Pages:** https://titomassa.github.io/DIRECT-GPS/?idParada=CT31498&codLinea=000

## Telemetría en tiempo real (`SWParadas.asmx` + `codigoLineaParada = 000`)

Cada unidad entrante muestra información operativa completa en las tarjetas de arribos, en los marcadores de **Leaflet** y en el inspector flotante de unidad:

- **Desvío horario (`+` / `-`)**: Indica exactamente cuánto está **adelantado (`+`)**, **atrasado (`-`)** o **en horario (`00:00`)** cada colectivo.
- **Chofer e ID / Legajo**: Nombre del conductor y su número de identificación (`IdentificadorChofer`).
- **Número de coche / interno**: Identificación del vehículo (`IdentificadorCoche`, ej. `#2967`) visible en la tarjeta y directamente sobre el pin del mapa.
- **Cartel LED y última señal GPS**: Cartel frontal (`DescripcionCartelBandera`), marca temporal GPS (`UltimaFechaHoraGPS`), distancia real y cuadras aproximadas.
- **Todas las líneas con código `000`**: Abre por defecto en la parada piloto **`CT31498 · AV. PEDRO FERRÉ - BRASIL IDA`** con `codigoLineaParada=000`.
- **Red completa de Corrientes (33 líneas)**: Navegación `Línea → Calle → Intersección → Parada`, trazado de recorridos reales con paradas clickeables en Leaflet, paradas cercanas por GPS/centro del mapa, favoritas con etiquetas, alertas sonoras (`≤ 3 min`) y temas **Nocturno / Día / Satélite**.

## Cómo ejecutar con telemetría SOAP en vivo

Requiere Node.js 20 o superior (sin dependencias externas):

```bash
npm start
```

El servidor ([server.js](server.js) + [lib/smartmove.js](lib/smartmove.js)) realiza las consultas SOAP server-side contra `http://clsw.smartmovepro.net/ModuloParadas/SWParadas.asmx` (evitando bloqueos de CORS / Mixed Content del navegador) y sirve la interfaz desde `docs/`.

También podés conectar una instancia desplegada de `server.js` (por ejemplo en Render o Railway) directamente a GitHub Pages pasando el parámetro `?api=`:

```text
https://titomassa.github.io/DIRECT-GPS/?idParada=CT31498&codLinea=000&api=https://tu-backend.onrender.com
```
