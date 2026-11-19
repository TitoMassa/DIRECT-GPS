import { CORRIENTES_CENTER, REFRESH_INTERVAL_SEC, getLineColor } from './config.js';
import {
  api,
  distanceMeters,
  formatDistance,
  formatBlocks,
  formatWalkMin,
  parseEtaMinutes,
  computeProximityPercent,
  parseDesvioHorario,
  parseChoferInfo,
  formatGpsTimeOnly,
  extractRoutePolylines,
  interpolateSoapBusStep
} from './api.js';
import { TransitMap } from './map.js';
import { playArrivalChime, playSubtleTick } from './audio.js';

const STORAGE_FAVS_KEY = 'direct_gps_favs_v2';
const STORAGE_THEME_KEY = 'direct_gps_theme_v1';

const state = {
  // Active stop & arrivals (starts null = clean interface until user picks/searches a stop)
  activeStop: null,
  codLineaQuery: '000', // 000 = all lines passing the stop (richer SOAP results)
  filterLine: 'ALL',
  arribos: [],
  selectedBusKey: null,
  simulateMode: false, // Smooth 1s interpolation over real SOAP data & polylines
  dataSource: 'smartmovepro-soap',
  lastSyncAt: null,
  countdownSec: REFRESH_INTERVAL_SEC,
  routesVisible: false,

  // Cache of real SOAP route polylines by codigoLinea (used both for map drawing & SOAP interpolation)
  routePolylinesCache: new Map(),

  // Catalog & Drilldown (Lineas -> Calles -> Intersecciones -> Paradas)
  lineas: [],
  quickStops: [],
  hubs: [],
  drill: {
    step: 'lineas', // 'lineas' | 'calles' | 'intersecciones' | 'paradas'
    linea: null,
    calle: null,
    interseccion: null,
    items: []
  },

  // Alerts, Favorites, Preferences
  soundEnabled: true,
  armedAlerts: new Set(),
  triggeredAlerts: new Set(),
  favorites: [],
  nearbyStops: []
};

// DOM References
const el = {
  dock: document.getElementById('transit-dock'),
  sheetHandle: document.getElementById('sheet-handle'),
  tabs: document.querySelectorAll('.dock-tab'),
  panels: document.querySelectorAll('.dock-panel'),

  // Top bar
  btnBrandHome: document.getElementById('btn-brand-home'),
  globalSearch: document.getElementById('global-search-input'),
  searchDropdown: document.getElementById('global-search-dropdown'),
  btnLiveMode: document.getElementById('btn-live-mode'),
  signalLabel: document.getElementById('signal-label'),
  btnSoundToggle: document.getElementById('btn-sound-toggle'),
  iconSoundOn: document.getElementById('icon-sound-on'),
  iconSoundOff: document.getElementById('icon-sound-off'),
  btnThemeToggle: document.getElementById('btn-theme-toggle'),
  iconSun: document.getElementById('icon-sun'),
  iconMoon: document.getElementById('icon-moon'),
  metaThemeColor: document.getElementById('meta-theme-color'),

  // Radar panel
  stopHero: document.getElementById('stop-hero'),
  stopCodeBadge: document.getElementById('stop-code-badge'),
  stopPilotTag: document.getElementById('stop-pilot-tag'),
  stopTitle: document.getElementById('stop-title'),
  stopCoordsLabel: document.getElementById('stop-coords-label'),
  lastSyncLabel: document.getElementById('last-sync-label'),
  btnToggleFav: document.getElementById('btn-toggle-fav'),
  btnShareStop: document.getElementById('btn-share-stop'),
  btnRefresh: document.getElementById('btn-refresh-arribos'),
  ringProgress: document.getElementById('refresh-ring-progress'),
  ringLabel: document.getElementById('refresh-countdown-txt'),
  btnShowRoutes: document.getElementById('btn-show-routes'),
  btnFitFleet: document.getElementById('btn-fit-fleet'),
  btnOriginalLink: document.getElementById('btn-original-link'),
  lineFilterStrip: document.getElementById('line-filter-strip'),
  arribosList: document.getElementById('arribos-list'),

  // Lineas panel
  lineasBreadcrumb: document.getElementById('lineas-breadcrumb'),
  lineasFilterInput: document.getElementById('lineas-filter-input'),
  lineasContent: document.getElementById('lineas-content'),

  // Cercanas panel
  btnLocateMe: document.getElementById('btn-locate-me'),
  btnSearchMapCenter: document.getElementById('btn-search-map-center'),
  hubsChips: document.getElementById('hubs-chips'),
  cercanasList: document.getElementById('cercanas-list'),

  // Favoritas panel
  favoritasList: document.getElementById('favoritas-list'),

  // Bus Inspector
  busInspector: document.getElementById('bus-inspector'),
  inspLineBadge: document.getElementById('insp-line-badge'),
  inspBandera: document.getElementById('insp-bandera'),
  inspCochePill: document.getElementById('insp-coche-pill'),
  inspDesvioPill: document.getElementById('insp-desvio-pill'),
  inspChofer: document.getElementById('insp-chofer'),
  inspLegajo: document.getElementById('insp-legajo'),
  inspCoche: document.getElementById('insp-coche'),
  inspEta: document.getElementById('insp-eta'),
  inspDist: document.getElementById('insp-dist'),
  inspBlocks: document.getElementById('insp-blocks'),
  inspAccess: document.getElementById('insp-access'),
  inspCartel: document.getElementById('insp-cartel'),
  inspGps: document.getElementById('insp-gps'),
  btnCloseInspector: document.getElementById('btn-close-inspector'),
  btnInspRoute: document.getElementById('btn-insp-route'),

  // Map Controls
  btnMapStyle: document.getElementById('btn-map-style'),
  btnMapCenterStop: document.getElementById('btn-map-center-stop'),
  btnMapScanArea: document.getElementById('btn-map-scan-area'),
  btnZoomIn: document.getElementById('btn-zoom-in'),
  btnZoomOut: document.getElementById('btn-zoom-out'),

  toastContainer: document.getElementById('toast-container')
};

// Map Instance (Leaflet + OpenStreetMap)
const transitMap = new TransitMap('map', {
  onBusSelect: (busKey) => selectBus(busKey, true),
  onStopPick: (stop) => openStopRadar(stop, '000')
});

// ============================================================================
// Utilities & Toast Notifications
// ============================================================================
function escapeHtml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function showToast(message, type = 'info', duration = 3600) {
  const div = document.createElement('div');
  div.className = `toast toast-${type}`;
  div.textContent = message;
  el.toastContainer.appendChild(div);
  setTimeout(() => {
    div.style.opacity = '0';
    div.style.transform = 'translateX(16px)';
    div.style.transition = 'all 0.25s ease';
    setTimeout(() => div.remove(), 260);
  }, duration);
}

// ============================================================================
// Theme (Leaflet Free OpenStreetMap Nocturno / Clásico)
// ============================================================================
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem(STORAGE_THEME_KEY, theme);
  const isLight = theme === 'light';
  el.iconSun.classList.toggle('hidden', isLight);
  el.iconMoon.classList.toggle('hidden', !isLight);
  el.metaThemeColor.setAttribute('content', isLight ? '#e8eef5' : '#0c1118');
  if (transitMap.tileKey !== 'hot') {
    transitMap.setTileStyle(isLight ? 'light' : 'dark');
  }
}

// ============================================================================
// Favorites Storage (Clean empty default — no hardcoded pilot stop)
// ============================================================================
function loadFavorites() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_FAVS_KEY) || 'null');
    if (Array.isArray(saved)) {
      state.favorites = saved;
      renderFavorites();
      return;
    }
  } catch {
    // ignore
  }
  state.favorites = [];
  renderFavorites();
}

function saveFavorites() {
  localStorage.setItem(STORAGE_FAVS_KEY, JSON.stringify(state.favorites));
  updateFavStarButton();
  renderFavorites();
}

function isFavorite(stopId) {
  return Boolean(stopId) && state.favorites.some((f) => f.id === stopId);
}

function updateFavStarButton() {
  const fav = state.activeStop ? isFavorite(state.activeStop.id) : false;
  el.btnToggleFav.classList.toggle('is-fav', fav);
  el.btnToggleFav.title = fav ? 'Quitar de favoritas' : 'Guardar parada en favoritas';
}

function toggleActiveStopFavorite() {
  if (!state.activeStop) return;
  const s = state.activeStop;
  if (isFavorite(s.id)) {
    state.favorites = state.favorites.filter((f) => f.id !== s.id);
    showToast(`Parada ${s.id} quitada de favoritas`, 'info');
  } else {
    state.favorites.unshift({
      id: s.id,
      nombre: s.nombre,
      alias: '',
      lat: s.lat,
      lng: s.lng
    });
    showToast(`Parada ${s.id} guardada en favoritas`, 'success');
  }
  saveFavorites();
}

function renderFavorites() {
  if (state.favorites.length === 0) {
    el.favoritasList.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">★</div>
        <h3>Sin paradas favoritas</h3>
        <p>Buscá una parada y tocá la estrella para guardarla acá con acceso directo.</p>
      </div>
    `;
    return;
  }

  el.favoritasList.innerHTML = state.favorites
    .map(
      (f) => `
      <div class="stop-list-card" data-fav-id="${escapeHtml(f.id)}">
        <div class="stop-card-top">
          <div>
            <span class="code-badge">${escapeHtml(f.id)}</span>
            ${f.alias ? `<span class="pilot-tag" style="margin-left:5px">${escapeHtml(f.alias)}</span>` : ''}
          </div>
          <div style="display:flex;gap:4px">
            <button class="mini-action-btn btn-edit-fav" data-id="${escapeHtml(f.id)}" title="Editar etiqueta">✎</button>
            <button class="mini-action-btn btn-del-fav" data-id="${escapeHtml(f.id)}" title="Eliminar">✕</button>
          </div>
        </div>
        <div class="stop-card-name">${escapeHtml(f.nombre)}</div>
        <div class="stop-card-foot">
          <span class="mono-meta">${f.lat ? `${f.lat.toFixed(4)}, ${f.lng.toFixed(4)}` : 'Corrientes Capital'}</span>
          <button class="pill-btn btn-open-fav" data-id="${escapeHtml(f.id)}">Ver Radar →</button>
        </div>
      </div>
    `
    )
    .join('');

  el.favoritasList.querySelectorAll('.btn-open-fav').forEach((btn) => {
    btn.addEventListener('click', () => {
      const fav = state.favorites.find((x) => x.id === btn.dataset.id);
      if (fav) openStopRadar(fav, '000');
    });
  });

  el.favoritasList.querySelectorAll('.btn-del-fav').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.favorites = state.favorites.filter((x) => x.id !== btn.dataset.id);
      saveFavorites();
      showToast('Parada eliminada de favoritas', 'info');
    });
  });

  el.favoritasList.querySelectorAll('.btn-edit-fav').forEach((btn) => {
    btn.addEventListener('click', () => {
      const fav = state.favorites.find((x) => x.id === btn.dataset.id);
      if (!fav) return;
      const alias = window.prompt('Nombre corto para esta parada (ej. Casa, Trabajo, Facultad):', fav.alias || '');
      if (alias !== null) {
        fav.alias = alias.trim();
        saveFavorites();
      }
    });
  });
}

// ============================================================================
// Tabs & Mobile Bottom Sheet
// ============================================================================
function switchTab(tabName) {
  el.tabs.forEach((t) => {
    const active = t.dataset.tab === tabName;
    t.classList.toggle('active', active);
    t.setAttribute('aria-selected', String(active));
  });
  el.panels.forEach((p) => {
    p.classList.toggle('active', p.id === `panel-${tabName}`);
  });
}

function setupMobileSheet() {
  const states = ['sheet-peek', 'sheet-half', 'sheet-full'];
  let idx = 1;
  let startY = 0;

  const setSheet = (newIdx) => {
    idx = Math.max(0, Math.min(2, newIdx));
    states.forEach((s) => el.dock.classList.remove(s));
    el.dock.classList.add(states[idx]);
  };

  el.sheetHandle.addEventListener('click', () => {
    setSheet((idx + 1) % 3);
  });

  el.sheetHandle.addEventListener(
    'touchstart',
    (e) => {
      startY = e.touches[0].clientY;
    },
    { passive: true }
  );

  el.sheetHandle.addEventListener(
    'touchend',
    (e) => {
      const dy = e.changedTouches[0].clientY - startY;
      if (dy < -36) setSheet(idx + 1);
      else if (dy > 36) setSheet(idx - 1);
    },
    { passive: true }
  );
}

// ============================================================================
// Clean Welcome State (No stop loaded until user searches or selects one)
// ============================================================================
function renderRadarWelcome() {
  el.stopHero.classList.add('hidden');
  el.lineFilterStrip.classList.add('hidden');

  el.arribosList.innerHTML = `
    <div class="radar-welcome">
      <span class="welcome-badge">TELEMETRÍA SOAP EN VIVO · CORRIENTES</span>
      <h2>Elegí una parada para iniciar el radar</h2>
      <p>Ingresá el código de una parada para ver todos los colectivos en vivo (coche, chofer, ID y desvío horario +/-), o explorá por línea y cercanía.</p>

      <form id="welcome-stop-form" class="welcome-code-form">
        <input
          id="welcome-stop-input"
          type="text"
          class="welcome-code-input"
          placeholder="Ej: CT31498"
          autocomplete="off"
          aria-label="Código de parada"
        />
        <button type="submit" class="primary-action-btn">Buscar</button>
      </form>

      <div class="welcome-actions">
        <button id="btn-welcome-lineas" class="secondary-action-btn">Explorar líneas</button>
        <button id="btn-welcome-cercanas" class="secondary-action-btn">Paradas cercanas</button>
      </div>

      <div class="welcome-tip">
        <strong>Tip:</strong> también podés mover el mapa Leaflet sobre cualquier avenida de Corrientes y tocar el botón de lupa inferior derecho para detectar paradas en esa zona.
      </div>
    </div>
  `;

  const form = document.getElementById('welcome-stop-form');
  const input = document.getElementById('welcome-stop-input');
  form?.addEventListener('submit', (e) => {
    e.preventDefault();
    const raw = (input?.value || '').trim().toUpperCase();
    if (!raw) {
      showToast('Ingresá un código de parada (ej. CT31498)', 'info');
      return;
    }
    const known = state.quickStops.find((s) => s.id === raw) || state.favorites.find((f) => f.id === raw);
    openStopRadar(known || { id: raw, nombre: `Parada ${raw}` }, '000');
  });

  document.getElementById('btn-welcome-lineas')?.addEventListener('click', () => {
    switchTab('lineas');
  });

  document.getElementById('btn-welcome-cercanas')?.addEventListener('click', () => {
    switchTab('cercanas');
  });
}

function resetToWelcome() {
  state.activeStop = null;
  state.arribos = [];
  state.selectedBusKey = null;
  state.filterLine = 'ALL';
  state.routesVisible = false;
  el.btnShowRoutes.classList.remove('active');
  closeBusInspector();
  transitMap.clearActiveStop();
  transitMap.clearRoutes();
  transitMap.resetViewToCity();

  const url = new URL(window.location.href);
  url.searchParams.delete('idParada');
  url.searchParams.delete('codLinea');
  window.history.replaceState({}, '', url.toString());

  switchTab('radar');
  renderRadarWelcome();
}

// ============================================================================
// Core Radar: Stop Loading, Live SOAP Arrivals & SOAP-Based Interpolation
// ============================================================================
function updateSignalPill() {
  el.btnLiveMode.classList.remove('is-sim', 'is-warn');
  if (state.simulateMode) {
    el.btnLiveMode.classList.add('is-sim');
    el.signalLabel.textContent = 'SIMULACIÓN';
  } else if (state.dataSource === 'smartmovepro-cache') {
    el.btnLiveMode.classList.add('is-warn');
    el.signalLabel.textContent = 'CACHÉ';
  } else {
    el.signalLabel.textContent = 'EN VIVO';
  }
}

function updateStopHeaderUI() {
  if (!state.activeStop) {
    el.stopHero.classList.add('hidden');
    el.lineFilterStrip.classList.add('hidden');
    return;
  }

  el.stopHero.classList.remove('hidden');
  el.lineFilterStrip.classList.remove('hidden');

  const s = state.activeStop;
  const isAll = !state.codLineaQuery || state.codLineaQuery === '0' || state.codLineaQuery === '000';
  el.stopCodeBadge.textContent = s.id;
  el.stopTitle.textContent = s.nombre || `Parada ${s.id}`;
  el.stopPilotTag.textContent = isAll ? 'TODAS LAS LÍNEAS (000)' : `LÍNEA CÓD. ${state.codLineaQuery}`;

  if (typeof s.lat === 'number' && typeof s.lng === 'number') {
    el.stopCoordsLabel.textContent = `${s.lat.toFixed(5)}, ${s.lng.toFixed(5)}`;
  } else {
    el.stopCoordsLabel.textContent = 'Corrientes Capital';
  }

  el.btnOriginalLink.href = `https://cuandollega.smartmovepro.net/corrientes/arribos/?codLinea=${encodeURIComponent(
    isAll ? '0' : state.codLineaQuery
  )}&idParada=${encodeURIComponent(s.id)}`;

  updateFavStarButton();

  const url = new URL(window.location.href);
  url.searchParams.set('idParada', s.id);
  url.searchParams.set('codLinea', isAll ? '000' : state.codLineaQuery);
  window.history.replaceState({}, '', url.toString());
}

async function openStopRadar(stopInfo, codLinea = '000') {
  const rawCode = String(codLinea ?? '000').trim();
  const stopId = String(stopInfo.id || stopInfo.identificador || '').trim().toUpperCase();
  if (!stopId) return;

  state.activeStop = {
    id: stopId,
    nombre: stopInfo.nombre || stopInfo.descripcion || `Parada ${stopId}`,
    lat: typeof stopInfo.lat === 'number' ? stopInfo.lat : parseFloat(stopInfo.latitud) || null,
    lng: typeof stopInfo.lng === 'number' ? stopInfo.lng : parseFloat(stopInfo.longitud) || null
  };
  state.codLineaQuery = !rawCode || rawCode === '0' ? '000' : rawCode;
  state.filterLine = 'ALL';
  state.selectedBusKey = null;
  state.routesVisible = false;
  el.btnShowRoutes.classList.remove('active');
  transitMap.clearRoutes();
  closeBusInspector();

  switchTab('radar');
  updateStopHeaderUI();

  if (state.activeStop.lat && state.activeStop.lng) {
    transitMap.setActiveStop(state.activeStop);
    transitMap.focusStop(15);
  }

  await fetchArribos(true);
}

function normalizeArrivals(rawList, stopCoords) {
  const seenCounts = new Map();
  return (rawList || []).map((a) => {
    const lineName = (a.descripcionLinea || '').trim() || `L${a.codigoLinea}`;
    const coche = String(a.identificadorCoche || '').trim();
    const baseId = coche ? `${a.codigoLinea}-c${coche}` : `${a.codigoLinea}-${lineName}`;
    const occ = (seenCounts.get(baseId) || 0) + 1;
    seenCounts.set(baseId, occ);

    const lat = parseFloat(a.latitud);
    const lng = parseFloat(a.longitud);
    const validPos = !Number.isNaN(lat) && !Number.isNaN(lng) && lat !== 0 && lng !== 0;

    const eta = parseEtaMinutes(a.tiempoRestanteArribo);
    const dist =
      validPos && stopCoords ? distanceMeters(lat, lng, stopCoords.lat, stopCoords.lng) : null;
    const desvio = parseDesvioHorario(a.desvioHorario);
    const chofer = parseChoferInfo(a.identificadorChofer, a.choferNombre, a.choferLegajo);
    const gpsTimeOnly = formatGpsTimeOnly(a.ultimaFechaHoraGPS);

    // Derive realistic approach speed (m/s) directly from real SOAP distance & ETA
    const etaSec = eta.minutes <= 0 ? 40 : eta.minutes * 60;
    const rawSpeed = dist !== null && etaSec > 0 ? dist / etaSec : 6.5;
    const speedMps = Math.max(3.5, Math.min(13, rawSpeed));

    return {
      key: occ > 1 ? `${baseId}-${occ}` : baseId,
      codigoLinea: a.codigoLinea,
      descripcionLinea: lineName,
      descripcionBandera: (a.descripcionBandera || a.descripcionCortaBandera || 'Servicio urbano').trim(),
      descripcionCartelBandera: (a.descripcionCartelBandera || a.descripcionCortaBandera || '').trim(),
      tiempoRaw: a.tiempoRestanteArribo || '',
      eta,
      etaSecondsRemaining: etaSec,
      speedMps,
      esAdaptado: Boolean(a.esAdaptado),
      esLleno: a.esLleno === true,
      lat: validPos ? lat : null,
      lng: validPos ? lng : null,
      distanceMeters: dist,
      proximityPct: computeProximityPercent(eta.minutes, dist),
      identificadorCoche: coche,
      choferNombre: chofer.nombre,
      choferLegajo: chofer.legajo,
      choferRaw: chofer.raw,
      desvio,
      ultimaFechaHoraGPS: String(a.ultimaFechaHoraGPS || '').trim(),
      gpsTimeOnly
    };
  });
}

// Preload real SOAP route polylines for approaching buses so SOAP interpolation glides along real streets
async function preloadPolylinesForInterpolation() {
  const uniqueLineCodes = Array.from(
    new Set(state.arribos.map((b) => b.codigoLinea).filter((c) => c && !state.routePolylinesCache.has(c)))
  ).slice(0, 5);

  await Promise.all(
    uniqueLineCodes.map(async (cod) => {
      try {
        const res = await api.recorridos(cod);
        const polylines = extractRoutePolylines(Array.isArray(res.data) ? res.data : []);
        state.routePolylinesCache.set(cod, polylines);
      } catch {
        state.routePolylinesCache.set(cod, []);
      }
    })
  );
}

// Smooth 1-second interpolation step powered purely by the latest real SOAP fleet & SOAP polylines
function stepSoapInterpolation() {
  if (!state.simulateMode || !state.activeStop || state.arribos.length === 0) return;
  const stopCoords =
    typeof state.activeStop.lat === 'number' && typeof state.activeStop.lng === 'number'
      ? { lat: state.activeStop.lat, lng: state.activeStop.lng }
      : null;
  if (!stopCoords) return;

  let changed = false;
  for (const bus of state.arribos) {
    if (typeof bus.lat !== 'number' || typeof bus.lng !== 'number') continue;
    const polylines = state.routePolylinesCache.get(bus.codigoLinea) || [];
    const next = interpolateSoapBusStep(bus, stopCoords, bus.speedMps, polylines);
    bus.lat = next.lat;
    bus.lng = next.lng;
    bus.distanceMeters = distanceMeters(bus.lat, bus.lng, stopCoords.lat, stopCoords.lng);
    bus.etaSecondsRemaining = Math.max(0, (bus.etaSecondsRemaining || 0) - 1);

    const mins = Math.ceil(bus.etaSecondsRemaining / 60);
    if (next.arrived || bus.etaSecondsRemaining <= 35) {
      bus.eta = { minutes: 0, display: 'YA', unit: 'Arribando', urgency: 'now' };
      bus.tiempoRaw = 'Arribando..';
    } else {
      bus.eta = {
        minutes: mins,
        display: `${mins}`,
        unit: 'min',
        urgency: mins <= 3 ? 'now' : mins <= 9 ? 'soon' : 'later'
      };
      bus.tiempoRaw = `${mins} min. aprox.`;
    }
    bus.proximityPct = computeProximityPercent(bus.eta.minutes, bus.distanceMeters);
    changed = true;
  }

  if (changed) {
    transitMap.updateBuses(state.arribos, {
      filterLine: state.filterLine,
      selectedBusKey: state.selectedBusKey
    });
    renderArribosList();
    if (state.selectedBusKey) {
      const focused = state.arribos.find((b) => b.key === state.selectedBusKey);
      if (focused) updateInspectorFields(focused);
    }
    checkProximityAlerts();
  }
}

function renderLineFilters() {
  const uniqueLines = Array.from(new Set(state.arribos.map((a) => a.descripcionLinea)));
  const totalCount = state.arribos.length;

  let html = `
    <button class="filter-chip ${state.filterLine === 'ALL' ? 'active' : ''}" data-line="ALL" style="--chip-color:#0284c7">
      Todas (${totalCount})
    </button>
  `;

  for (const line of uniqueLines) {
    const color = getLineColor(line);
    const count = state.arribos.filter((a) => a.descripcionLinea === line).length;
    html += `
      <button class="filter-chip ${state.filterLine === line ? 'active' : ''}" data-line="${escapeHtml(
        line
      )}" style="--chip-color:${color}">
        <span class="chip-dot"></span>
        ${escapeHtml(line)} · ${count}
      </button>
    `;
  }

  el.lineFilterStrip.innerHTML = html;
  el.lineFilterStrip.querySelectorAll('.filter-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      state.filterLine = chip.dataset.line;
      renderLineFilters();
      renderArribosList();
      transitMap.updateBuses(state.arribos, {
        filterLine: state.filterLine,
        selectedBusKey: state.selectedBusKey
      });
    });
  });
}

function renderArribosList() {
  if (!state.activeStop) {
    renderRadarWelcome();
    return;
  }

  const visible =
    state.filterLine === 'ALL'
      ? state.arribos
      : state.arribos.filter((a) => a.descripcionLinea === state.filterLine);

  if (visible.length === 0) {
    el.arribosList.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/>
          </svg>
        </div>
        <h3>Sin unidades reportando arribos</h3>
        <p>En este momento el servicio SOAP no reporta colectivos en camino hacia <strong>${escapeHtml(
          state.activeStop.id
        )}</strong>. Podés reintentar en unos segundos o elegir otra parada.</p>
      </div>
    `;
    return;
  }

  el.arribosList.innerHTML = visible
    .map((bus) => {
      const color = getLineColor(bus.descripcionLinea);
      const isSelected = bus.key === state.selectedBusKey;
      const isArmed = state.armedAlerts.has(bus.descripcionLinea);
      const distLabel =
        bus.distanceMeters !== null
          ? `${formatDistance(bus.distanceMeters)} · ${formatBlocks(bus.distanceMeters)} cuadras`
          : 'Telemetría GPS activa';

      const cocheBadge = bus.identificadorCoche
        ? `<span class="coche-pill" title="Número de coche">#${escapeHtml(bus.identificadorCoche)}</span>`
        : '';

      const desvioBadge =
        bus.desvio && bus.desvio.status !== 'none'
          ? `<span class="desvio-pill desvio-${bus.desvio.status}" title="Desvío respecto al horario programado">${escapeHtml(
              bus.desvio.label
            )}</span>`
          : '';

      const driverHtml = bus.choferNombre
        ? `<span class="driver-inline" title="Conductor asignado">
             <span>Chofer: <strong>${escapeHtml(bus.choferNombre)}</strong></span>
             ${bus.choferLegajo ? `<span class="legajo-chip">ID ${escapeHtml(bus.choferLegajo)}</span>` : ''}
           </span>`
        : `<span class="driver-inline"><span>Unidad sin chofer asignado</span></span>`;

      const gpsHtml = bus.gpsTimeOnly
        ? `<span class="mono-meta" title="Última señal GPS">GPS ${escapeHtml(bus.gpsTimeOnly)}</span>`
        : '';

      return `
        <div class="arrival-card ${isSelected ? 'is-selected' : ''}" data-bus-key="${escapeHtml(
          bus.key
        )}" style="--line-color:${color}" role="button" tabindex="0">
          <div class="arrival-card-main">
            <div class="line-badge">${escapeHtml(bus.descripcionLinea)}</div>
            <div class="arrival-info">
              <div class="arrival-title-row">
                <div class="arrival-bandera" title="${escapeHtml(bus.descripcionBandera)}">${escapeHtml(
                  bus.descripcionBandera
                )}</div>
              </div>
              <div class="arrival-sub-row">
                ${cocheBadge}
                ${desvioBadge}
              </div>
              <div class="arrival-sub-row">
                <span class="arrival-tag">${escapeHtml(distLabel)}</span>
                ${bus.esAdaptado ? '<span class="arrival-tag tag-adapted">♿ Adaptado</span>' : ''}
                ${bus.esLleno ? '<span class="arrival-tag tag-full">Unidad llena</span>' : ''}
              </div>
            </div>
            <div class="arrival-right">
              <div class="eta-block eta-${bus.eta.urgency}">
                <span class="eta-value">${escapeHtml(bus.eta.display)}</span>
                <span class="eta-unit">${escapeHtml(bus.eta.unit || 'aprox')}</span>
              </div>
              <button class="alert-bell-btn ${isArmed ? 'is-armed' : ''}" data-alert-line="${escapeHtml(
                bus.descripcionLinea
              )}" title="${isArmed ? 'Quitar alerta de llegada' : 'Avisarme cuando falten ≤ 3 min'}">
                <svg viewBox="0 0 24 24" width="15" height="15" fill="${isArmed ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2">
                  <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/>
                  <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
                </svg>
              </button>
            </div>
          </div>
          <div class="arrival-card-telemetry">
            ${driverHtml}
            ${gpsHtml}
          </div>
          <div class="arrival-progress">
            <div class="arrival-progress-fill" style="width:${bus.proximityPct}%"></div>
          </div>
        </div>
      `;
    })
    .join('');

  el.arribosList.querySelectorAll('.arrival-card').forEach((card) => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('.alert-bell-btn')) return;
      selectBus(card.dataset.busKey, true);
    });
  });

  el.arribosList.querySelectorAll('.alert-bell-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const line = btn.dataset.alertLine;
      if (state.armedAlerts.has(line)) {
        state.armedAlerts.delete(line);
        state.triggeredAlerts.delete(line);
        showToast(`Alerta desactivada para línea ${line}`, 'info');
      } else {
        state.armedAlerts.add(line);
        state.triggeredAlerts.delete(line);
        if (state.soundEnabled) playSubtleTick();
        showToast(`Te avisaremos cuando la línea ${line} esté a ≤ 3 min`, 'success');
      }
      renderArribosList();
    });
  });
}

function checkProximityAlerts() {
  if (!state.activeStop) return;
  for (const bus of state.arribos) {
    if (
      state.armedAlerts.has(bus.descripcionLinea) &&
      !state.triggeredAlerts.has(bus.descripcionLinea) &&
      bus.eta.minutes <= 3
    ) {
      state.triggeredAlerts.add(bus.descripcionLinea);
      if (state.soundEnabled) playArrivalChime();
      const cocheTag = bus.identificadorCoche ? ` (Coche #${bus.identificadorCoche})` : '';
      showToast(
        `¡Línea ${bus.descripcionLinea}${cocheTag} llegando a ${state.activeStop.id} (${bus.tiempoRaw})!`,
        'success',
        6500
      );
    }
  }
}

function updateInspectorFields(bus) {
  const color = getLineColor(bus.descripcionLinea);
  el.inspLineBadge.textContent = bus.descripcionLinea;
  el.inspLineBadge.style.setProperty('--line-color', color);
  el.inspBandera.textContent = bus.descripcionBandera;

  el.inspCochePill.textContent = bus.identificadorCoche ? `Coche #${bus.identificadorCoche}` : 'Coche s/d';
  el.inspDesvioPill.className = `desvio-pill desvio-${bus.desvio.status === 'none' ? 'ontime' : bus.desvio.status}`;
  el.inspDesvioPill.textContent = bus.desvio.status !== 'none' ? bus.desvio.label : 'Sin desvío';

  el.inspChofer.textContent = bus.choferNombre || 'Sin informar';
  el.inspLegajo.textContent = bus.choferLegajo || '—';
  el.inspCoche.textContent = bus.identificadorCoche ? `#${bus.identificadorCoche}` : '—';

  el.inspEta.textContent = bus.eta.minutes === 0 ? 'Arribando' : `${bus.eta.display} min`;
  el.inspDist.textContent = formatDistance(bus.distanceMeters);
  el.inspBlocks.textContent = formatBlocks(bus.distanceMeters);
  el.inspAccess.textContent = bus.esAdaptado ? '♿ Rampa' : 'Estándar';

  el.inspCartel.textContent = `Cartel: ${bus.descripcionCartelBandera || bus.descripcionBandera}`;
  const coordsStr = bus.lat !== null ? `${bus.lat.toFixed(5)}, ${bus.lng.toFixed(5)}` : 's/d';
  el.inspGps.textContent = bus.gpsTimeOnly ? `GPS ${bus.gpsTimeOnly} · ${coordsStr}` : `GPS: ${coordsStr}`;

  el.btnInspRoute.dataset.codLinea = bus.codigoLinea;
  el.btnInspRoute.dataset.lineName = bus.descripcionLinea;
}

function selectBus(busKey, focusMap = false) {
  state.selectedBusKey = busKey;
  const bus = state.arribos.find((b) => b.key === busKey);
  if (!bus) {
    closeBusInspector();
    return;
  }

  updateInspectorFields(bus);
  el.busInspector.classList.remove('hidden');
  renderArribosList();
  transitMap.updateBuses(state.arribos, {
    filterLine: state.filterLine,
    selectedBusKey: state.selectedBusKey
  });
  if (focusMap) {
    transitMap.focusBusAndStop(bus);
  }
}

function closeBusInspector() {
  state.selectedBusKey = null;
  el.busInspector.classList.add('hidden');
  transitMap.drawFocusVector(null);
  transitMap.updateBuses(state.arribos, {
    filterLine: state.filterLine,
    selectedBusKey: null
  });
  if (state.activeStop) renderArribosList();
}

async function fetchArribos(showSkeleton = false) {
  if (!state.activeStop) return;

  el.btnRefresh.classList.add('is-loading');
  if (showSkeleton) {
    el.arribosList.innerHTML = `<div class="skeleton-card"></div><div class="skeleton-card"></div><div class="skeleton-card"></div>`;
  }

  try {
    const res = await api.arribos(state.activeStop.id, state.codLineaQuery);
    const payload = res.data || {};
    state.dataSource = res.source || 'smartmovepro-soap';
    state.lastSyncAt = new Date();

    if (payload.knownStop && state.activeStop.nombre === `Parada ${state.activeStop.id}`) {
      state.activeStop.nombre = payload.knownStop.nombre;
    }

    if (payload.stopCoords && (!state.activeStop.lat || !state.activeStop.lng)) {
      state.activeStop.lat = payload.stopCoords.lat;
      state.activeStop.lng = payload.stopCoords.lng;
      updateStopHeaderUI();
      transitMap.setActiveStop(state.activeStop);
    } else if (state.activeStop.lat && state.activeStop.lng) {
      transitMap.setActiveStop(state.activeStop);
    }

    const stopCoords =
      typeof state.activeStop.lat === 'number' && typeof state.activeStop.lng === 'number'
        ? { lat: state.activeStop.lat, lng: state.activeStop.lng }
        : payload.stopCoords || null;

    state.arribos = normalizeArrivals(payload.arribos, stopCoords);
    el.lastSyncLabel.textContent = `SOAP ${state.lastSyncAt.toLocaleTimeString('es-AR', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    })}`;

    updateSignalPill();
    renderLineFilters();
    renderArribosList();
    transitMap.updateBuses(state.arribos, {
      filterLine: state.filterLine,
      selectedBusKey: state.selectedBusKey
    });

    if (showSkeleton && state.arribos.length > 0) {
      transitMap.fitFleet(state.arribos);
    }

    if (state.selectedBusKey) {
      const stillHere = state.arribos.find((b) => b.key === state.selectedBusKey);
      if (stillHere) updateInspectorFields(stillHere);
      else closeBusInspector();
    }

    if (state.simulateMode) {
      preloadPolylinesForInterpolation();
    }

    checkProximityAlerts();
  } catch (err) {
    el.lastSyncLabel.textContent = 'Error de conexión';
    showToast(err.message || 'No se pudieron actualizar los arribos SOAP', 'warn');
  } finally {
    el.btnRefresh.classList.remove('is-loading');
    state.countdownSec = REFRESH_INTERVAL_SEC;
    updateCountdownRing();
  }
}

function updateCountdownRing() {
  const circumference = 2 * Math.PI * 14;
  const ratio = state.countdownSec / REFRESH_INTERVAL_SEC;
  el.ringProgress.style.strokeDashoffset = String(circumference * (1 - ratio));
  el.ringLabel.textContent = String(state.countdownSec);
}

// ============================================================================
// Route Polylines Overlay
// ============================================================================
async function loadRouteForLine(codLinea, lineName, { clearExisting = true, fit = true } = {}) {
  if (clearExisting) transitMap.clearRoutes();
  showToast(`Cargando recorrido oficial de línea ${lineName}...`, 'info', 2200);
  try {
    const res = await api.recorridos(codLinea);
    const list = Array.isArray(res.data) ? res.data : [];
    state.routePolylinesCache.set(Number(codLinea), extractRoutePolylines(list));
    if (list.length === 0) {
      showToast(`Sin traza disponible para ${lineName}`, 'warn');
      return;
    }
    transitMap.drawRouteCollection(list, lineName, { showStops: true, fit });
    state.routesVisible = true;
    el.btnShowRoutes.classList.add('active');
    showToast(`Recorrido ${lineName} dibujado (${list.length} ramales)`, 'success');
  } catch (err) {
    showToast(err.message || `No se pudo cargar el recorrido de ${lineName}`, 'warn');
  }
}

async function toggleActiveStopRoutes() {
  if (state.routesVisible) {
    transitMap.clearRoutes();
    state.routesVisible = false;
    el.btnShowRoutes.classList.remove('active');
    showToast('Recorridos ocultos', 'info', 1800);
    return;
  }

  const unique = [];
  for (const a of state.arribos) {
    if (!unique.some((u) => u.codigoLinea === a.codigoLinea)) {
      unique.push({ codigoLinea: a.codigoLinea, lineName: a.descripcionLinea });
    }
    if (unique.length >= 3) break;
  }
  if (unique.length === 0) {
    showToast('Seleccioná una línea en la pestaña Líneas para trazar su recorrido', 'info');
    return;
  }

  transitMap.clearRoutes();
  for (let i = 0; i < unique.length; i++) {
    await loadRouteForLine(unique[i].codigoLinea, unique[i].lineName, {
      clearExisting: false,
      fit: i === 0
    });
  }
}

// ============================================================================
// TAB 2: Líneas -> Calles -> Intersecciones -> Paradas
// ============================================================================
function renderLineasBreadcrumb() {
  const { step, linea, calle, interseccion } = state.drill;
  if (step === 'lineas') {
    el.lineasBreadcrumb.innerHTML = `<span class="crumb-current">Todas las líneas · Corrientes (${state.lineas.length})</span>`;
    return;
  }

  const parts = [`<button class="crumb-btn" data-back="lineas">← Líneas</button>`];
  if (linea) {
    if (step === 'calles') {
      parts.push(`<span class="crumb-sep">/</span><span class="crumb-current">Línea ${escapeHtml(linea.descripcion)} · Calles</span>`);
    } else {
      parts.push(`<span class="crumb-sep">/</span><button class="crumb-btn" data-back="calles">${escapeHtml(linea.descripcion)}</button>`);
    }
  }
  if (calle) {
    const shortCalle = calle.descripcion.replace(/\s*-\s*CORRIENTES$/i, '');
    if (step === 'intersecciones') {
      parts.push(`<span class="crumb-sep">/</span><span class="crumb-current">${escapeHtml(shortCalle)}</span>`);
    } else {
      parts.push(`<span class="crumb-sep">/</span><button class="crumb-btn" data-back="intersecciones">${escapeHtml(shortCalle)}</button>`);
    }
  }
  if (interseccion && step === 'paradas') {
    const shortInt = interseccion.descripcion.replace(/\s*-\s*CORRIENTES$/i, '');
    parts.push(`<span class="crumb-sep">/</span><span class="crumb-current">${escapeHtml(shortInt)}</span>`);
  }

  el.lineasBreadcrumb.innerHTML = parts.join('');
  el.lineasBreadcrumb.querySelectorAll('.crumb-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.back;
      el.lineasFilterInput.value = '';
      if (target === 'lineas') {
        state.drill = { step: 'lineas', linea: null, calle: null, interseccion: null, items: state.lineas };
        renderDrilldown();
      } else if (target === 'calles' && state.drill.linea) {
        openLineCalles(state.drill.linea);
      } else if (target === 'intersecciones' && state.drill.linea && state.drill.calle) {
        openCalleIntersecciones(state.drill.calle);
      }
    });
  });
}

function renderDrilldown() {
  renderLineasBreadcrumb();
  const query = el.lineasFilterInput.value.trim().toLowerCase();
  const { step, items } = state.drill;

  if (step === 'lineas') {
    const filtered = state.lineas.filter((l) => l.descripcion.toLowerCase().includes(query));
    el.lineasContent.innerHTML = `
      <div class="lines-grid">
        ${filtered
          .map((l) => {
            const color = getLineColor(l.descripcion);
            return `
              <div class="line-tile" style="--line-color:${color}">
                <div class="line-tile-head">
                  <span class="line-tile-pill">${escapeHtml(l.descripcion)}</span>
                </div>
                <div class="line-tile-actions">
                  <button class="tile-mini-btn primary btn-line-calles" data-cod="${l.codigo}" data-desc="${escapeHtml(l.descripcion)}">Calles</button>
                  <button class="tile-mini-btn btn-line-map" data-cod="${l.codigo}" data-desc="${escapeHtml(l.descripcion)}">Mapa</button>
                </div>
              </div>
            `;
          })
          .join('')}
      </div>
    `;

    el.lineasContent.querySelectorAll('.btn-line-calles').forEach((btn) => {
      btn.addEventListener('click', () => {
        openLineCalles({ codigo: Number(btn.dataset.cod), descripcion: btn.dataset.desc });
      });
    });

    el.lineasContent.querySelectorAll('.btn-line-map').forEach((btn) => {
      btn.addEventListener('click', () => {
        loadRouteForLine(btn.dataset.cod, btn.dataset.desc, { clearExisting: true, fit: true });
      });
    });
    return;
  }

  const filtered = items.filter((it) => (it.descripcion || '').toLowerCase().includes(query));
  if (filtered.length === 0) {
    el.lineasContent.innerHTML = `
      <div class="empty-state">
        <h3>Sin resultados</h3>
        <p>Probá con otro término de búsqueda.</p>
      </div>
    `;
    return;
  }

  if (step === 'calles') {
    el.lineasContent.innerHTML = filtered
      .map(
        (c) => `
        <button class="list-row-btn" data-cod="${c.codigo}" data-desc="${escapeHtml(c.descripcion)}">
          <div class="list-row-main">
            <span class="list-row-title">${escapeHtml(c.descripcion.replace(/\s*-\s*CORRIENTES$/i, ''))}</span>
            <span class="list-row-sub">Seleccionar intersección</span>
          </div>
          <span class="row-chevron">›</span>
        </button>
      `
      )
      .join('');

    el.lineasContent.querySelectorAll('.list-row-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        openCalleIntersecciones({ codigo: Number(btn.dataset.cod), descripcion: btn.dataset.desc });
      });
    });
    return;
  }

  if (step === 'intersecciones') {
    el.lineasContent.innerHTML = filtered
      .map(
        (i) => `
        <button class="list-row-btn" data-cod="${i.codigo}" data-desc="${escapeHtml(i.descripcion)}">
          <div class="list-row-main">
            <span class="list-row-title">${escapeHtml(i.descripcion.replace(/\s*-\s*CORRIENTES$/i, ''))}</span>
            <span class="list-row-sub">Ver paradas en esta esquina</span>
          </div>
          <span class="row-chevron">›</span>
        </button>
      `
      )
      .join('');

    el.lineasContent.querySelectorAll('.list-row-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        openInterseccionParadas({ codigo: Number(btn.dataset.cod), descripcion: btn.dataset.desc });
      });
    });
    return;
  }

  if (step === 'paradas') {
    el.lineasContent.innerHTML = filtered
      .map(
        (p) => `
        <div class="stop-list-card">
          <div class="stop-card-top">
            <span class="code-badge">${escapeHtml(p.identificador)}</span>
          </div>
          <div class="stop-card-name">${escapeHtml(p.descripcion)}</div>
          <div class="stop-card-foot">
            <button class="pill-btn btn-open-all" data-id="${escapeHtml(p.identificador)}" data-name="${escapeHtml(p.descripcion)}">Todas las líneas (000)</button>
            <button class="pill-btn pill-btn-ghost btn-open-only" data-id="${escapeHtml(p.identificador)}" data-name="${escapeHtml(p.descripcion)}">Solo ${escapeHtml(state.drill.linea.descripcion)}</button>
          </div>
        </div>
      `
      )
      .join('');

    el.lineasContent.querySelectorAll('.btn-open-all').forEach((btn) => {
      btn.addEventListener('click', () => {
        openStopRadar({ id: btn.dataset.id, nombre: btn.dataset.name }, '000');
      });
    });
    el.lineasContent.querySelectorAll('.btn-open-only').forEach((btn) => {
      btn.addEventListener('click', () => {
        openStopRadar({ id: btn.dataset.id, nombre: btn.dataset.name }, String(state.drill.linea.codigo));
      });
    });
  }
}

async function openLineCalles(linea) {
  el.lineasFilterInput.value = '';
  state.drill = { step: 'calles', linea, calle: null, interseccion: null, items: [] };
  renderLineasBreadcrumb();
  el.lineasContent.innerHTML = `<div class="skeleton-card"></div><div class="skeleton-card"></div><div class="skeleton-card"></div>`;

  try {
    const res = await api.calles(linea.codigo);
    state.drill.items = Array.isArray(res.data) ? res.data : [];
    renderDrilldown();
  } catch (err) {
    el.lineasContent.innerHTML = `<div class="empty-state"><h3>Error</h3><p>${escapeHtml(err.message)}</p></div>`;
  }
}

async function openCalleIntersecciones(calle) {
  el.lineasFilterInput.value = '';
  state.drill = { ...state.drill, step: 'intersecciones', calle, interseccion: null, items: [] };
  renderLineasBreadcrumb();
  el.lineasContent.innerHTML = `<div class="skeleton-card"></div><div class="skeleton-card"></div>`;

  try {
    const res = await api.intersecciones(state.drill.linea.codigo, calle.codigo);
    state.drill.items = Array.isArray(res.data) ? res.data : [];
    renderDrilldown();
  } catch (err) {
    el.lineasContent.innerHTML = `<div class="empty-state"><h3>Error</h3><p>${escapeHtml(err.message)}</p></div>`;
  }
}

async function openInterseccionParadas(interseccion) {
  el.lineasFilterInput.value = '';
  state.drill = { ...state.drill, step: 'paradas', interseccion, items: [] };
  renderLineasBreadcrumb();
  el.lineasContent.innerHTML = `<div class="skeleton-card"></div>`;

  try {
    const res = await api.paradas(state.drill.linea.codigo, state.drill.calle.codigo, interseccion.codigo);
    state.drill.items = Array.isArray(res.data) ? res.data : [];
    renderDrilldown();
  } catch (err) {
    el.lineasContent.innerHTML = `<div class="empty-state"><h3>Error</h3><p>${escapeHtml(err.message)}</p></div>`;
  }
}

// ============================================================================
// TAB 3: Paradas Cercanas & Corrientes Hubs
// ============================================================================
function renderHubs() {
  el.hubsChips.innerHTML = state.hubs
    .map(
      (h, idx) =>
        `<button class="hub-chip" data-hub-idx="${idx}">${escapeHtml(h.name.replace(/\s*\(Piloto\)/i, ''))}</button>`
    )
    .join('');

  el.hubsChips.querySelectorAll('.hub-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const hub = state.hubs[Number(chip.dataset.hubIdx)];
      if (!hub) return;
      searchNearbyStops(hub.lat, hub.lng, hub.name);
    });
  });

  el.cercanasList.innerHTML = `
    <div class="empty-state">
      <div class="empty-state-icon">◎</div>
      <h3>Buscá paradas a tu alrededor</h3>
      <p>Usá tu GPS, tocá el centro del mapa o elegí una zona rápida de Corrientes arriba.</p>
    </div>
  `;
}

async function searchNearbyStops(lat, lng, label = 'esta zona') {
  switchTab('cercanas');
  el.cercanasList.innerHTML = `<div class="skeleton-card"></div><div class="skeleton-card"></div><div class="skeleton-card"></div>`;

  try {
    const res = await api.paradasCercanas(lat, lng);
    const stops = Array.isArray(res.data) ? res.data : [];
    state.nearbyStops = stops;

    if (stops.length === 0) {
      el.cercanasList.innerHTML = `
        <div class="empty-state">
          <h3>Sin paradas cercanas</h3>
          <p>No encontramos paradas cerca de ${escapeHtml(label)}. Probá mover el mapa sobre una avenida de Corrientes.</p>
        </div>
      `;
      return;
    }

    transitMap.showNearbyStops(stops, { lat, lng });

    el.cercanasList.innerHTML = stops
      .map((s) => {
        const sLat = parseFloat(s.latitud);
        const sLng = parseFloat(s.longitud);
        const dist = distanceMeters(lat, lng, sLat, sLng);
        return `
          <div class="stop-list-card">
            <div class="stop-card-top">
              <span class="code-badge">${escapeHtml(s.identificador)}</span>
              <span class="mono-meta">${formatDistance(dist)} · ${formatWalkMin(dist)}</span>
            </div>
            <div class="stop-card-name">${escapeHtml(s.descripcion)}</div>
            <div class="stop-card-lines">${escapeHtml(s.lineas || 'Todas las líneas habilitadas')}</div>
            <div class="stop-card-foot">
              <span class="mono-meta">${escapeHtml(s.callePrincipal || '')}</span>
              <button class="pill-btn btn-nearby-open" data-id="${escapeHtml(s.identificador)}" data-name="${escapeHtml(
                s.descripcion
              )}" data-lat="${sLat}" data-lng="${sLng}">Ver Radar →</button>
            </div>
          </div>
        `;
      })
      .join('');

    el.cercanasList.querySelectorAll('.btn-nearby-open').forEach((btn) => {
      btn.addEventListener('click', () => {
        openStopRadar(
          {
            id: btn.dataset.id,
            nombre: btn.dataset.name,
            lat: parseFloat(btn.dataset.lat),
            lng: parseFloat(btn.dataset.lng)
          },
          '000'
        );
      });
    });
  } catch (err) {
    el.cercanasList.innerHTML = `<div class="empty-state"><h3>Error</h3><p>${escapeHtml(err.message)}</p></div>`;
  }
}

function locateUserGps() {
  if (!navigator.geolocation) {
    showToast('Tu navegador no soporta GPS. Buscando en el centro del mapa.', 'warn');
    const c = transitMap.getCenter();
    searchNearbyStops(c.lat, c.lng, 'el centro del mapa');
    return;
  }

  showToast('Obteniendo ubicación GPS...', 'info', 2000);
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const { latitude, longitude, accuracy } = pos.coords;
      transitMap.setUserLocation(latitude, longitude, accuracy);
      searchNearbyStops(latitude, longitude, 'tu ubicación');
    },
    () => {
      showToast('Sin permiso GPS. Buscando paradas en el centro de Corrientes.', 'warn');
      searchNearbyStops(CORRIENTES_CENTER.lat, CORRIENTES_CENTER.lng, 'Centro de Corrientes');
    },
    { enableHighAccuracy: true, timeout: 7000 }
  );
}

// ============================================================================
// Global Instant Search (Stop Code CTxxxxx, Known Stops, Favorites, Lines)
// ============================================================================
function renderGlobalSearchResults(rawQuery) {
  const q = rawQuery.trim();
  if (!q) {
    el.searchDropdown.classList.add('hidden');
    return;
  }

  const upper = q.toUpperCase();
  const results = [];

  if (/^CT\d{3,6}$/.test(upper)) {
    results.push({
      type: 'direct-stop',
      title: `Ir a parada ${upper}`,
      sub: 'Consultar arribos SOAP de todas las líneas (código 000)',
      badge: upper,
      action: () => openStopRadar({ id: upper, nombre: `Parada ${upper}` }, '000')
    });
  }

  const knownStops = [...state.favorites, ...state.quickStops];
  const seenStop = new Set();
  for (const s of knownStops) {
    if (seenStop.has(s.id)) continue;
    seenStop.add(s.id);
    const hay = `${s.id} ${s.nombre} ${s.alias || ''}`.toUpperCase();
    if (hay.includes(upper)) {
      results.push({
        type: 'stop',
        title: s.nombre,
        sub: s.alias ? `${s.alias} · Todas las líneas` : 'Parada · Todas las líneas (000)',
        badge: s.id,
        action: () => openStopRadar(s, '000')
      });
    }
  }

  for (const l of state.lineas) {
    if (l.descripcion.toUpperCase().includes(upper)) {
      results.push({
        type: 'line',
        title: `Línea ${l.descripcion}`,
        sub: 'Ver calles, paradas y recorrido en mapa',
        badge: l.descripcion,
        color: getLineColor(l.descripcion),
        action: () => {
          switchTab('lineas');
          openLineCalles(l);
        }
      });
    }
  }

  if (results.length === 0) {
    el.searchDropdown.innerHTML = `<div class="search-item"><div class="search-item-main"><span class="search-item-title">Sin coincidencias para "${escapeHtml(q)}"</span><span class="search-item-sub">Ingresá un código como CT31498 o una línea como 102B</span></div></div>`;
  } else {
    el.searchDropdown.innerHTML = results
      .slice(0, 8)
      .map(
        (r, i) => `
        <button class="search-item" data-res-idx="${i}">
          <div class="search-item-main">
            <span class="search-item-title">${escapeHtml(r.title)}</span>
            <span class="search-item-sub">${escapeHtml(r.sub)}</span>
          </div>
          <span class="code-badge" ${r.color ? `style="background:${r.color};color:#fff"` : ''}>${escapeHtml(r.badge)}</span>
        </button>
      `
      )
      .join('');

    el.searchDropdown.querySelectorAll('.search-item').forEach((item) => {
      item.addEventListener('click', () => {
        const res = results[Number(item.dataset.resIdx)];
        el.searchDropdown.classList.add('hidden');
        el.globalSearch.value = '';
        res?.action();
      });
    });
  }

  el.searchDropdown.classList.remove('hidden');
}

// ============================================================================
// Event Bindings & Clean Startup
// ============================================================================
function bindEvents() {
  el.tabs.forEach((tab) => {
    tab.addEventListener('click', () => switchTab(tab.dataset.tab));
  });

  el.btnBrandHome.addEventListener('click', resetToWelcome);

  el.btnThemeToggle.addEventListener('click', () => {
    const cur = document.documentElement.getAttribute('data-theme');
    applyTheme(cur === 'dark' ? 'light' : 'dark');
  });

  el.btnSoundToggle.addEventListener('click', () => {
    state.soundEnabled = !state.soundEnabled;
    el.btnSoundToggle.setAttribute('aria-pressed', String(state.soundEnabled));
    el.iconSoundOn.classList.toggle('hidden', !state.soundEnabled);
    el.iconSoundOff.classList.toggle('hidden', state.soundEnabled);
    if (state.soundEnabled) playSubtleTick();
    showToast(state.soundEnabled ? 'Alertas sonoras activadas' : 'Alertas sonoras silenciadas', 'info', 2000);
  });

  el.btnLiveMode.addEventListener('click', async () => {
    if (!state.activeStop) {
      showToast('Primero buscá o elegí una parada para interpolar sus colectivos SOAP en vivo', 'info');
      return;
    }
    state.simulateMode = !state.simulateMode;
    updateSignalPill();
    if (state.simulateMode) {
      showToast('Interpolación fluida activada usando posiciones y recorridos reales SOAP', 'success');
      if (state.arribos.length === 0) {
        await fetchArribos(false);
      }
      await preloadPolylinesForInterpolation();
    } else {
      showToast('Modo EN VIVO: sincronizando directo cada 15s con SOAP', 'info');
      fetchArribos(false);
    }
  });

  el.btnToggleFav.addEventListener('click', toggleActiveStopFavorite);

  el.btnShareStop.addEventListener('click', async () => {
    if (!state.activeStop) return;
    const shareUrl = window.location.href;
    try {
      await navigator.clipboard.writeText(shareUrl);
      showToast(`Enlace copiado para parada ${state.activeStop.id}`, 'success');
    } catch {
      showToast(`Parada actual: ${state.activeStop.id}`, 'info');
    }
  });

  el.btnRefresh.addEventListener('click', () => fetchArribos(false));
  el.btnShowRoutes.addEventListener('click', toggleActiveStopRoutes);
  el.btnFitFleet.addEventListener('click', () => transitMap.fitFleet(state.arribos));

  // Inspector
  el.btnCloseInspector.addEventListener('click', closeBusInspector);
  el.btnInspRoute.addEventListener('click', () => {
    const cod = el.btnInspRoute.dataset.codLinea;
    const name = el.btnInspRoute.dataset.lineName;
    if (cod) loadRouteForLine(cod, name, { clearExisting: true, fit: true });
  });

  // Map controls
  el.btnZoomIn.addEventListener('click', () => transitMap.zoomIn());
  el.btnZoomOut.addEventListener('click', () => transitMap.zoomOut());
  el.btnMapCenterStop.addEventListener('click', () => transitMap.focusStop(16));
  el.btnMapStyle.addEventListener('click', () => {
    const cfg = transitMap.cycleTileStyle();
    showToast(`Mapa Leaflet: ${cfg.label}`, 'info', 1600);
  });
  el.btnMapScanArea.addEventListener('click', () => {
    const c = transitMap.getCenter();
    searchNearbyStops(c.lat, c.lng, 'el centro del mapa');
  });

  // Cercanas buttons
  el.btnLocateMe.addEventListener('click', locateUserGps);
  el.btnSearchMapCenter.addEventListener('click', () => {
    const c = transitMap.getCenter();
    searchNearbyStops(c.lat, c.lng, 'el centro del mapa');
  });

  // Lineas filter
  el.lineasFilterInput.addEventListener('input', renderDrilldown);

  // Global search
  el.globalSearch.addEventListener('input', (e) => renderGlobalSearchResults(e.target.value));
  el.globalSearch.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const first = el.searchDropdown.querySelector('.search-item[data-res-idx="0"]');
      if (first) first.click();
    } else if (e.key === 'Escape') {
      el.searchDropdown.classList.add('hidden');
    }
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.quick-search-wrap')) {
      el.searchDropdown.classList.add('hidden');
    }
  });

  setupMobileSheet();
}

async function init() {
  const savedTheme = localStorage.getItem(STORAGE_THEME_KEY) || 'dark';
  applyTheme(savedTheme);

  loadFavorites();
  bindEvents();
  updateSignalPill();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }

  // Bootstrap real Corrientes catalog (33 lines + hubs) without opening any pilot stop
  try {
    const boot = await api.bootstrap();
    state.lineas = Array.isArray(boot.lineas) ? boot.lineas : [];
    state.quickStops = Array.isArray(boot.quickStops) ? boot.quickStops : [];
    state.hubs = Array.isArray(boot.hubs) ? boot.hubs : [];
    state.drill.items = state.lineas;
    renderDrilldown();
    renderHubs();
  } catch {
    showToast('No se pudo cargar el catálogo inicial de líneas', 'warn');
  }

  // Only open a stop automatically if explicitly provided via URL (?idParada=...)
  const params = new URLSearchParams(window.location.search);
  const paramStopId = (params.get('idParada') || '').trim().toUpperCase();
  const paramCodLinea = params.get('codLinea') || '000';

  if (paramStopId) {
    const matchedKnown =
      state.quickStops.find((s) => s.id === paramStopId) ||
      state.favorites.find((f) => f.id === paramStopId) || {
        id: paramStopId,
        nombre: `Parada ${paramStopId}`
      };
    await openStopRadar(matchedKnown, paramCodLinea);
  } else {
    renderRadarWelcome();
  }

  // 1-second loop: live countdown + smooth 1s SOAP interpolation when simulation mode is enabled
  setInterval(() => {
    if (!state.activeStop) return;

    if (state.simulateMode) {
      stepSoapInterpolation();
    }

    state.countdownSec -= 1;
    if (state.countdownSec <= 0) {
      state.countdownSec = REFRESH_INTERVAL_SEC;
      fetchArribos(false);
    }
    updateCountdownRing();
  }, 1000);
}

init();
