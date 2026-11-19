# DIRECT GPS · Corrientes

Rework inmersivo y en tiempo real de [Cuando Llega Corrientes](https://cuandollega.smartmovepro.net/corrientes), enfocado en telemetría satelital en vivo sobre un mapa interactivo a pantalla completa.

🌐 **GitHub Pages:** https://titomassa.github.io/DIRECT-GPS/

## Características principales

- **Radar en Vivo sobre Mapa Full-Screen**: Seguimiento satelital con interpolación suave de colectivos en movimiento, baliza pulsante en la parada activa, vector de distancia en metros y cuadras, y recarga automática con anillo regresivo cada 25 segundos.
- **Parada Piloto lista al instante**: Abre directamente en **`CT31498 · AV. PEDRO FERRÉ - BRASIL IDA`** con `codLinea=0` (mostrando todas las líneas que pasan por la parada: `102A`, `102B`, `102C`, `106A`, `106B`, `106C`, `904A`, etc.).
- **Red completa de Corrientes Capital (26 líneas)**: Navegación completa `Línea → Calle → Intersección → Parada` y trazado de recorridos con paradas clickeables sobre el mapa.
- **Paradas Cercanas & Explorador por Zona**: Búsqueda por GPS del dispositivo, búsqueda por centro del mapa y accesos rápidos a puntos clave de Corrientes (Av. Ferré y Brasil, Plaza 25 de Mayo, Puerto, Terminal, Campus UNNE, Hospital Escuela).
- **Alertas de Proximidad**: Campana de aviso sonoro (Web Audio API) cuando la línea elegida llega a ≤ 3 minutos.
- **Favoritas con Etiquetas**: Guardado local en el navegador con soporte para alias personalizados.
- **Tema Nocturno, Día y Satélite**: Cambio instantáneo entre cartografía nocturna, diurna y vista satelital.
- **Modo Híbrido (GitHub Pages + Proxy SmartMovePro en vivo)**:
  - En **GitHub Pages** (`docs/`) funciona de forma 100% estática con telemetría interactiva lista para probar al instante.
  - Al ejecutar `node server.js` (local o desplegado en Render/Railway/Fly.io), el proxy integrado se conecta en vivo a los endpoints oficiales de SmartMovePro Corrientes gestionando sesiones CSRF, cola anti-saturación y caché. También podés conectar tu propio backend desplegado pasando `?api=https://tu-backend.onrender.com` en la URL de GitHub Pages.

## Cómo ejecutar con telemetría SmartMovePro en vivo

Requiere Node.js 20 o superior (sin dependencias externas):

```bash
npm start
```

### Enlaces directos a paradas

Podés abrir cualquier parada directamente por URL usando `idParada` y `codLinea` (`0` = todas las líneas):

```text
https://titomassa.github.io/DIRECT-GPS/?idParada=CT31498&codLinea=0
```
