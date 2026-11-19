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
  getArgentinaNow,
  getArgentinaTodayTipo,
  matchBusesWithHorarios
} from './api.js';
import { parseRouteBranches, resolveBusTrajectory, sampleTrajectory } from './trajectory.js';
import { TransitMap } from './map.js';
import { playArrivalChime, playSubtleTick } from './audio.js';

const STORAGE_FAVS_KEY = 'direct_gps_favs_v2';
const STORAGE_THEME_KEY = 'direct_gps_theme_v1';

const state = {
  activeStop: null,
  codLineaQuery: '000',
  filterLine: 'ALL',
  focusedLineCode: null, // Numeric codigoLinea when viewing a single line's full fleet
  arribos: [],
  selectedBusKey: null,
  inspectorOpen: false,
  simulateMode: false,
  horariosOpen: false,
  horariosLineCode: null,
  horariosTipoDia: getArgentinaTodayTipo(),
  stopLinesList: [], // [{ codigo, descripcion }] for active stop
  dataSource: 'smartmovepro-soap',
  lastSyncAt: null,
  countdownSec: REFRESH_INTERVAL_SEC,
  routesVisible: false,

  // Real SOAP route branches & today's horarios cache per line
  routeBranchesCache: new Map(),
  horariosByLineCache: new Map(), // `${stopId}:${codLinea}:${tipoDia}` -> horarios[]
  lastRealGpsByUnit: new Map(), // busKey -> { lat, lng, ts }

  // Catalog & Drilldown
  lineas: [],
  quickStops: [],
  hubs: [],
  drill: {
    step: 'lineas',
    linea: null,
    calle: null,
    interseccion: null,
    items: []
  },

  soundEnabled: true,
  armedAlerts: new Set(),
  triggeredAlerts: new Set(),
  favorites: [],
  nearbyStops: []
};

const el = {
  dock: document.getElementById('transit-dock'),
  sheetHandle: document.getElementById('sheet-handle'),
  tabs: document.querySelectorAll('.dock-tab'),
  panels: document.querySelectorAll('.dock-panel'),

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
  btnToggleHorarios: document.getElementById('btn-toggle-horarios'),
  btnFitFleet: document.getElementById('btn-fit-fleet'),
  btnOriginalLink: document.getElementById('btn-original-link'),
  lineFilterStrip: document.getElementById('line-filter-strip'),
  horariosPanel: document.getElementById('horarios-panel'),
  arribosList: document.getElementById('arribos-list'),

  lineasBreadcrumb: document.getElementById('lineas-breadcrumb'),
  lineasFilterInput: document.getElementById('lineas-filter-input'),
  lineasContent: document.getElementById('lineas-content'),

  btnLocateMe: document.getElementById('btn-locate-me'),
  btnSearchMapCenter: document.getElementById('btn-search-map-center'),
  hubsChips: document.getElementById('hubs-chips'),
  cercanasList: document.getElementById('cercanas-list'),

  favoritasList: document.getElementById('favoritas-list'),

  busInspector: document.getElementById('bus-inspector'),
  inspLineBadge: document.getElementById('insp-line-badge'),
  inspBandera: document.getElementById('insp-bandera'),
  inspCochePill: document.getElementById('insp-coche-pill'),
  inspDesvioPill: document.getElementById('insp-desvio-pill'),
  inspTurnoPill: document.getElementById('insp-turno-pill'),
  inspAccessBadge: document.getElementById('insp-access-badge'),
  inspChofer: document.getElementById('insp-chofer'),
  inspLegajo: document.getElementById('insp-legajo'),
  inspEta: document.getElementById('insp-eta'),
  inspDist: document.getElementById('insp-dist'),
  inspBlocks: document.getElementById('insp-blocks'),
  inspGps: document.getElementById('insp-gps'),
  btnCloseInspector: document.getElementById('btn-close-inspector'),
  btnInspRoute: document.getElementById('btn-insp-route'),

  btnMapStyle: document.getElementById('btn-map-style'),
  btnMapCenterStop: document.getElementById('btn-map-center-stop'),
  btnMapScanArea: document.getElementById('btn-map-scan-area'),
  btnZoomIn: document.getElementById('btn-zoom-in'),
  btnZoomOut: document.getElementById('btn-zoom-out'),

  toastContainer: document.getElementById('toast-container')
};

const transitMap = new TransitMap('map', {
  onBusSelect: (busKey) => openBusInspector(busKey),
  onStopPick: (stop) => openStopRadar(stop, '000')
});

// ============================================================================
// Utilities & Toast
// ============================================================================
function escapeHtml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function showToast(message, type = 'info', duration = 3200) {
  const div = document.createElement('div');
  div.className = `toast toast-${type}`;
  div.textContent = message;
  el.toastContainer.appendChild(div);
  setTimeout(() => {
    div.style.opacity = '0';
    div.style.transition = 'opacity 0.2s ease';
    setTimeout(() => div.remove(), 220);
  }, duration);
}

// ============================================================================
// Theme
// ============================================================================
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem(STORAGE_THEME_KEY, theme);
  const isLight = theme === 'light';
  el.iconSun.classList.toggle('hidden', isLight);
  el.iconMoon.classList.toggle('hidden', !isLight);
  el.metaThemeColor.setAttribute('content', isLight ? '#e5ebf2' : '#0f141b');
  if (transitMap.tileKey !== 'hot') {
    transitMap.setTileStyle(isLight ? 'light' : 'dark');
  }
}

// ============================================================================
// Favorites
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
    state.favorites.unshift({ id: s.id, nombre: s.nombre, alias: '', lat: s.lat, lng: s.lng });
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
          <button class="pill-btn btn-open-fav" data-id="${escapeHtml(f.id)}">Abrir radar →</button>
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
      const alias = window.prompt('Etiqueta para esta parada (ej. Casa, Trabajo, Facultad):', fav.alias || '');
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

  el.sheetHandle.addEventListener('click', () => setSheet((idx + 1) % 3));
  el.sheetHandle.addEventListener('touchstart', (e) => { startY = e.touches[0].clientY; }, { passive: true });
  el.sheetHandle.addEventListener(
    'touchend',
    (e) => {
      const dy = e.changedTouches[0].clientY - startY;
      if (dy < -32) setSheet(idx + 1);
      else if (dy > 32) setSheet(idx - 1);
    },
    { passive: true }
  );
}

// ============================================================================
// Clean Welcome State
// ============================================================================
function renderRadarWelcome() {
  el.stopHero.classList.add('hidden');
  el.lineFilterStrip.classList.add('hidden');
  el.horariosPanel.classList.add('hidden');
  el.arribosList.classList.remove('hidden');

  el.arribosList.innerHTML = `
    <div class="radar-welcome">
      <span class="welcome-badge">TELEMETRÍA EN VIVO · CORRIENTES</span>
      <h2>Elegí una parada para iniciar</h2>
      <p>Ingresá el código de parada para consultar arribos en vivo con coche, chofer, legajo, desvío horario (+/-) y horarios programados 24h.</p>

      <form id="welcome-stop-form" class="welcome-code-form">
        <input
          id="welcome-stop-input"
          type="text"
          class="welcome-code-input"
          placeholder="Ej: CT31498 o CT31942"
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
        Mové el mapa OpenStreetMap sobre cualquier avenida y usá la lupa inferior derecha para detectar paradas en esa zona.
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

  document.getElementById('btn-welcome-lineas')?.addEventListener('click', () => switchTab('lineas'));
  document.getElementById('btn-welcome-cercanas')?.addEventListener('click', () => switchTab('cercanas'));
}

function resetToWelcome() {
  state.activeStop = null;
  state.arribos = [];
  state.selectedBusKey = null;
  state.filterLine = 'ALL';
  state.routesVisible = false;
  state.horariosOpen = false;
  el.btnShowRoutes.classList.remove('active');
  el.btnToggleHorarios.classList.remove('active');
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
// Core Radar: Stop Loading, Direction-Aware Trajectories & Zero-Lag Interpolation
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
  el.lineFilterStrip.classList.toggle('hidden', state.horariosOpen);

  const s = state.activeStop;
  const isAll = !state.codLineaQuery || state.codLineaQuery === '0' || state.codLineaQuery === '000';
  el.stopCodeBadge.textContent = s.id;
  el.stopTitle.textContent = s.nombre || `Parada ${s.id}`;
  const focusedLineName = !isAll
    ? state.stopLinesList.find((l) => String(l.codigo) === String(state.codLineaQuery))?.descripcion ||
      state.lineas.find((l) => String(l.codigo) === String(state.codLineaQuery))?.descripcion ||
      (state.filterLine !== 'ALL' ? state.filterLine : state.codLineaQuery)
    : '';
  el.stopPilotTag.textContent = isAll ? 'Todas las líneas' : `Línea ${focusedLineName}`;

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

  const isAll = !rawCode || rawCode === '0' || rawCode === '000';
  const lineObj = !isAll ? state.lineas.find((l) => String(l.codigo) === rawCode) : null;

  state.activeStop = {
    id: stopId,
    nombre: stopInfo.nombre || stopInfo.descripcion || `Parada ${stopId}`,
    lat: typeof stopInfo.lat === 'number' ? stopInfo.lat : parseFloat(stopInfo.latitud) || null,
    lng: typeof stopInfo.lng === 'number' ? stopInfo.lng : parseFloat(stopInfo.longitud) || null
  };
  state.codLineaQuery = isAll ? '000' : rawCode;
  state.focusedLineCode = isAll ? null : Number(rawCode);
  state.filterLine = lineObj ? lineObj.descripcion : 'ALL';
  state.selectedBusKey = null;
  state.routesVisible = false;
  state.horariosOpen = false;
  state.horariosLineCode = isAll ? null : Number(rawCode);
  state.horariosTipoDia = getArgentinaTodayTipo();
  state.stopLinesList = [];
  state.lastRealGpsByUnit.clear();

  el.btnShowRoutes.classList.remove('active');
  el.btnToggleHorarios.classList.remove('active');
  el.horariosPanel.classList.add('hidden');
  el.arribosList.classList.remove('hidden');

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

async function ensureBranchesLoaded(lineCodes) {
  const missing = lineCodes.filter((c) => c && !state.routeBranchesCache.has(c));
  if (missing.length === 0) return;

  await Promise.all(
    missing.map(async (cod) => {
      try {
        const res = await api.recorridos(cod);
        const branches = parseRouteBranches(Array.isArray(res.data) ? res.data : []);
        state.routeBranchesCache.set(cod, branches);
      } catch {
        state.routeBranchesCache.set(cod, []);
      }
    })
  );
}

function normalizeArrivals(rawList, stopId, stopCoords) {
  const seenCounts = new Map();
  const now = Date.now();

  return (rawList || []).map((a) => {
    const lineName = (a.descripcionLinea || '').trim() || `L${a.codigoLinea}`;
    const coche = String(a.identificadorCoche || '').trim();
    const baseId = coche ? `${a.codigoLinea}-c${coche}` : `${a.codigoLinea}-${lineName}`;
    const occ = (seenCounts.get(baseId) || 0) + 1;
    seenCounts.set(baseId, occ);
    const key = occ > 1 ? `${baseId}-${occ}` : baseId;

    const lat = parseFloat(a.latitud);
    const lng = parseFloat(a.longitud);
    const validPos = !Number.isNaN(lat) && !Number.isNaN(lng) && lat !== 0 && lng !== 0;

    const eta = parseEtaMinutes(a.tiempoRestanteArribo);
    const straightDist =
      validPos && stopCoords ? distanceMeters(lat, lng, stopCoords.lat, stopCoords.lng) : null;
    const desvio = parseDesvioHorario(a.desvioHorario);
    const chofer = parseChoferInfo(a.identificadorChofer, a.choferNombre, a.choferLegajo);
    const gpsTimeOnly = formatGpsTimeOnly(a.ultimaFechaHoraGPS);

    const prevFix = state.lastRealGpsByUnit.get(key) || null;
    const branches = state.routeBranchesCache.get(a.codigoLinea) || [];

    const draftBus = {
      lat: validPos ? lat : null,
      lng: validPos ? lng : null,
      descripcionBandera: (a.descripcionBandera || a.descripcionCortaBandera || 'Servicio urbano').trim(),
      eta
    };

    const trajectory =
      validPos && stopCoords
        ? resolveBusTrajectory(draftBus, stopId, stopCoords, branches, prevFix)
        : null;

    if (validPos) {
      if (!prevFix || (distanceMeters(prevFix.lat, prevFix.lng, lat, lng) || 0) >= 15) {
        state.lastRealGpsByUnit.set(key, { lat, lng, ts: now });
      }
    }

    const routeMeters = trajectory ? trajectory.totalMeters : straightDist;
    const etaSec = eta.minutes <= 0 ? 45 : eta.minutes * 60;

    return {
      key,
      codigoLinea: a.codigoLinea,
      descripcionLinea: lineName,
      descripcionBandera: draftBus.descripcionBandera,
      descripcionCartelBandera: (a.descripcionCartelBandera || a.descripcionCortaBandera || '').trim(),
      tiempoRaw: a.tiempoRestanteArribo || '',
      eta,
      etaSecondsRemaining: etaSec,
      esAdaptado: Boolean(a.esAdaptado),
      esLleno: a.esLleno === true,
      esExtendido: Boolean(a.esExtendido),
      viaParada: a.viaParada || null,
      turnoProgramado: null,
      lat: validPos ? lat : null,
      lng: validPos ? lng : null,
      distanceMeters: straightDist,
      routeMeters,
      proximityPct: computeProximityPercent(eta.minutes, routeMeters),
      identificadorCoche: coche,
      choferNombre: chofer.nombre,
      choferLegajo: chofer.legajo,
      choferRaw: chofer.raw,
      desvio,
      ultimaFechaHoraGPS: String(a.ultimaFechaHoraGPS || '').trim(),
      gpsTimeOnly,
      trajectory,
      isOppositeLeg: Boolean(trajectory?.isOppositeLeg),
      isNextCycle: Boolean(trajectory?.isNextCycle),
      realBandera: trajectory?.realBandera || draftBus.descripcionBandera,
      realBanderaColor: trajectory?.realBanderaColor || getLineColor(lineName)
    };
  });
}

// ZERO-LAG 1-second interpolation tick: no innerHTML rebuild, no Leaflet setIcon()!
function stepSoapInterpolation() {
  if (!state.simulateMode || !state.activeStop || state.arribos.length === 0) return;

  for (const bus of state.arribos) {
    const traj = bus.trajectory;
    if (!traj || typeof bus.lat !== 'number' || typeof bus.lng !== 'number') continue;

    traj.walkedMeters = Math.min(traj.totalMeters, traj.walkedMeters + traj.speedMps);
    const sample = sampleTrajectory(traj, traj.walkedMeters);
    if (!sample) continue;

    bus.lat = sample.lat;
    bus.lng = sample.lng;
    bus.routeMeters = sample.remainingMeters;
    bus.isOppositeLeg = sample.inOppositeLeg;
    bus.isNextCycle = Boolean(sample.inNextCycle);
    if (sample.currentBandera) bus.realBandera = sample.currentBandera;
    if (sample.currentBranchColor) bus.realBanderaColor = sample.currentBranchColor;
    bus.etaSecondsRemaining = Math.max(0, (bus.etaSecondsRemaining || 0) - 1);

    const mins = Math.ceil(bus.etaSecondsRemaining / 60);
    if (sample.arrived || bus.etaSecondsRemaining <= 35) {
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
    bus.proximityPct = computeProximityPercent(bus.eta.minutes, bus.routeMeters);
  }

  transitMap.moveBusPositionsFast(state.arribos);

  if (!state.horariosOpen) {
    for (const bus of state.arribos) {
      const card = el.arribosList.querySelector(`[data-bus-key="${CSS.escape(bus.key)}"]`);
      if (!card) continue;
      const etaVal = card.querySelector('[data-eta-val]');
      const etaUnit = card.querySelector('[data-eta-unit]');
      const distVal = card.querySelector('[data-dist-val]');
      const fill = card.querySelector('[data-progress-fill]');
      const banderaTxt = card.querySelector('[data-bandera-txt]');
      const banderaDot = card.querySelector('[data-bandera-dot]');
      if (etaVal) etaVal.textContent = bus.eta.display;
      if (etaUnit) etaUnit.textContent = bus.eta.unit || 'aprox';
      if (distVal && bus.routeMeters !== null) {
        distVal.textContent = `${formatDistance(bus.routeMeters)} · ${formatBlocks(bus.routeMeters)} cuadras`;
      }
      if (fill) fill.style.width = `${bus.proximityPct}%`;
      if (banderaTxt && bus.realBandera) banderaTxt.textContent = bus.realBandera;
      if (banderaDot && bus.realBanderaColor) banderaDot.style.background = bus.realBanderaColor;
    }
  }

  if (state.inspectorOpen && state.selectedBusKey) {
    const focused = state.arribos.find((b) => b.key === state.selectedBusKey);
    if (focused) updateInspectorFields(focused);
  }
}

function renderLineFilters() {
  // Always keep every known line for this stop selectable in the strip
  const lineEntries =
    state.stopLinesList.length > 0
      ? state.stopLinesList
      : Array.from(new Map(state.arribos.map((a) => [a.codigoLinea, { codigo: a.codigoLinea, descripcion: a.descripcionLinea }])).values());

  let html = `
    <button class="filter-chip ${state.filterLine === 'ALL' ? 'active' : ''}" data-line="ALL" data-cod="000" style="--chip-color:#0284c7">
      Todas
    </button>
  `;

  for (const item of lineEntries) {
    const line = item.descripcion;
    const color = getLineColor(line);
    const count = state.arribos.filter((a) => a.descripcionLinea === line).length;
    const countLabel = state.filterLine === line && count > 0 ? ` (${count})` : state.filterLine === 'ALL' && count > 0 ? ` (${count})` : '';
    html += `
      <button class="filter-chip ${state.filterLine === line ? 'active' : ''}" data-line="${escapeHtml(
        line
      )}" data-cod="${item.codigo}" style="--chip-color:${color}">
        <span class="chip-dot"></span>
        ${escapeHtml(line)}${countLabel}
      </button>
    `;
  }

  el.lineFilterStrip.innerHTML = html;
  el.lineFilterStrip.querySelectorAll('.filter-chip').forEach((chip) => {
    chip.addEventListener('click', async () => {
      const selectedLine = chip.dataset.line;
      const selectedCod = chip.dataset.cod;
      if (selectedLine === state.filterLine) return;

      closeBusInspector();
      state.filterLine = selectedLine;
      if (selectedLine === 'ALL') {
        state.focusedLineCode = null;
        state.codLineaQuery = '000';
      } else {
        state.focusedLineCode = Number(selectedCod) || null;
        state.codLineaQuery = String(selectedCod);
      }

      updateStopHeaderUI();
      renderLineFilters();

      // Immediately hide non-selected lines from Leaflet (zero ghost markers!)
      transitMap.updateBuses(state.arribos, {
        filterLine: state.filterLine,
        selectedBusKey: null
      });

      // When focusing a single line, automatically fetch its FULL ACTIVE FLEET (> 3 cars) via upstream probe propagation!
      if (state.focusedLineCode) {
        showToast(`Buscando toda la flota activa de ${selectedLine}...`, 'info', 2000);
      }
      await fetchArribos(true);
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
        <div class="empty-state-icon">◎</div>
        <h3>Sin unidades reportando arribos</h3>
        <p>En este momento no hay colectivos en camino hacia <strong>${escapeHtml(
          state.activeStop.id
        )}</strong>. Podés consultar los <strong>Horarios 24h</strong> programados arriba.</p>
      </div>
    `;
    return;
  }

  el.arribosList.innerHTML = visible
    .map((bus) => {
      const color = getLineColor(bus.descripcionLinea);
      const isSelected = bus.key === state.selectedBusKey;
      const isArmed = state.armedAlerts.has(bus.descripcionLinea);
      const distMeters = bus.routeMeters ?? bus.distanceMeters;
      const distLabel =
        distMeters !== null && distMeters !== undefined
          ? `${formatDistance(distMeters)} · ${formatBlocks(distMeters)} cuadras`
          : '';

      const cocheBadge = bus.identificadorCoche
        ? `<span class="coche-pill" title="Coche">${escapeHtml(bus.identificadorCoche)}</span>`
        : '';

      const desvioBadge =
        bus.desvio && bus.desvio.status !== 'none'
          ? `<span class="desvio-pill desvio-${bus.desvio.status}" title="Desvío horario">${escapeHtml(
              bus.desvio.label
            )}</span>`
          : '';

      const turnoBadge = bus.turnoProgramado
        ? `<span class="turno-pill" title="Turno programado">${escapeHtml(bus.turnoProgramado)}</span>`
        : '';

      const adaptedBadge = bus.esAdaptado
        ? `<span class="adapted-icon-badge" title="Unidad adaptada" aria-label="Unidad adaptada">♿</span>`
        : '';

      const extBadge = bus.esExtendido
        ? `<span class="extended-pill" title="Detectado en parada previa (${escapeHtml(
            bus.viaParada || ''
          )})">+Flota</span>`
        : '';

      const driverHtml = bus.choferNombre
        ? `<span class="driver-inline">
             <strong>${escapeHtml(bus.choferNombre)}</strong>
             ${bus.choferLegajo ? `<span class="legajo-chip">${escapeHtml(bus.choferLegajo)}</span>` : ''}
           </span>`
        : `<span class="driver-inline"><span>—</span></span>`;

      const gpsHtml = bus.gpsTimeOnly ? `<span class="mono-meta" title="Último reporte GPS">${escapeHtml(bus.gpsTimeOnly)}</span>` : '';
      const currentBandera = bus.realBandera || bus.descripcionBandera;
      const dirColor = bus.realBanderaColor || color;

      return `
        <div class="arrival-card ${isSelected ? 'is-selected' : ''}" data-bus-key="${escapeHtml(
          bus.key
        )}" style="--line-color:${color}" role="button" tabindex="0">
          <div class="arrival-card-main">
            <div class="line-badge">${escapeHtml(bus.descripcionLinea)}</div>
            <div class="arrival-info">
              <div class="arrival-bandera" title="${escapeHtml(currentBandera)}">
                <span class="dir-dot" data-bandera-dot style="background:${dirColor}"></span>
                <span class="arrival-bandera-txt" data-bandera-txt>${escapeHtml(currentBandera)}</span>
              </div>
              <div class="arrival-sub-row">
                ${cocheBadge}
                ${desvioBadge}
                ${turnoBadge}
                ${adaptedBadge}
                ${extBadge}
              </div>
              ${distLabel ? `<div class="arrival-sub-row"><span class="arrival-tag" data-dist-val>${escapeHtml(distLabel)}</span></div>` : ''}
            </div>
            <div class="arrival-right">
              <div class="eta-block eta-${bus.eta.urgency}">
                <span class="eta-value" data-eta-val>${escapeHtml(bus.eta.display)}</span>
                <span class="eta-unit" data-eta-unit>${escapeHtml(bus.eta.unit || 'aprox')}</span>
              </div>
              <button class="alert-bell-btn ${isArmed ? 'is-armed' : ''}" data-alert-line="${escapeHtml(
                bus.descripcionLinea
              )}" title="${isArmed ? 'Quitar alerta' : 'Avisarme cuando falten ≤ 3 min'}">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="${isArmed ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2">
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
            <div class="arrival-progress-fill" data-progress-fill style="width:${bus.proximityPct}%"></div>
          </div>
        </div>
      `;
    })
    .join('');

  el.arribosList.querySelectorAll('.arrival-card').forEach((card) => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('.alert-bell-btn')) return;
      focusBusOnMap(card.dataset.busKey);
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
        showToast(`Aviso activado para línea ${line} (≤ 3 min)`, 'success');
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
      const cocheTag = bus.identificadorCoche ? ` (${bus.identificadorCoche})` : '';
      showToast(`¡Línea ${bus.descripcionLinea}${cocheTag} arribando (${bus.tiempoRaw})!`, 'success', 6000);
    }
  }
}

function updateInspectorFields(bus) {
  const color = getLineColor(bus.descripcionLinea);
  const currentBandera = bus.realBandera || bus.descripcionBandera;
  const dirColor = bus.realBanderaColor || color;

  el.inspLineBadge.textContent = bus.descripcionLinea;
  el.inspLineBadge.style.setProperty('--line-color', color);
  el.inspBandera.innerHTML = `<span class="dir-dot" style="background:${dirColor}"></span><span class="arrival-bandera-txt">${escapeHtml(
    currentBandera
  )}</span>`;

  if (bus.identificadorCoche) {
    el.inspCochePill.textContent = bus.identificadorCoche;
    el.inspCochePill.classList.remove('hidden');
  } else {
    el.inspCochePill.classList.add('hidden');
  }

  if (bus.desvio && bus.desvio.status !== 'none' && bus.desvio.label) {
    el.inspDesvioPill.className = `desvio-pill desvio-${bus.desvio.status}`;
    el.inspDesvioPill.textContent = bus.desvio.label;
  } else {
    el.inspDesvioPill.className = 'desvio-pill hidden';
    el.inspDesvioPill.textContent = '';
  }

  if (bus.turnoProgramado) {
    el.inspTurnoPill.textContent = bus.turnoProgramado;
    el.inspTurnoPill.classList.remove('hidden');
  } else {
    el.inspTurnoPill.classList.add('hidden');
  }

  el.inspAccessBadge.classList.toggle('hidden', !bus.esAdaptado);

  const distMeters = bus.routeMeters ?? bus.distanceMeters;
  el.inspEta.textContent = bus.eta.minutes === 0 ? 'Arribando' : `${bus.eta.display} min`;
  el.inspDist.textContent = formatDistance(distMeters);
  el.inspBlocks.textContent = `${formatBlocks(distMeters)} c.`;

  el.inspChofer.textContent = bus.choferNombre || '—';
  if (bus.choferLegajo) {
    el.inspLegajo.textContent = bus.choferLegajo;
    el.inspLegajo.classList.remove('hidden');
  } else {
    el.inspLegajo.classList.add('hidden');
  }

  const gpsParts = [];
  if (bus.gpsTimeOnly) gpsParts.push(bus.gpsTimeOnly);
  if (bus.esExtendido) gpsParts.push('+Flota');
  el.inspGps.textContent = gpsParts.join(' · ') || '—';

  el.btnInspRoute.dataset.codLinea = bus.codigoLinea;
  el.btnInspRoute.dataset.lineName = bus.descripcionLinea;
}

// Tapping an arrival card in the bottom dock: pan & zoom directly to the bus WITHOUT opening the inspector overlay
function focusBusOnMap(busKey) {
  const bus = state.arribos.find((b) => b.key === busKey);
  if (!bus) return;

  state.selectedBusKey = busKey;
  state.inspectorOpen = false;
  el.busInspector.classList.add('hidden');

  // If mobile bottom sheet is expanded full-screen, bring it to half so the map is visible
  if (el.dock.classList.contains('sheet-full')) {
    el.dock.classList.remove('sheet-full');
    el.dock.classList.add('sheet-half');
  }

  if (!state.horariosOpen) renderArribosList();
  transitMap.updateBuses(state.arribos, {
    filterLine: state.filterLine,
    selectedBusKey: state.selectedBusKey
  });
  transitMap.focusBus(bus, 16);
}

// Tapping a bus chip directly on the map: open the ultra-compact inspector card
function openBusInspector(busKey) {
  const bus = state.arribos.find((b) => b.key === busKey);
  if (!bus) {
    closeBusInspector();
    return;
  }

  state.selectedBusKey = busKey;
  state.inspectorOpen = true;
  updateInspectorFields(bus);
  el.busInspector.classList.remove('hidden');
  if (!state.horariosOpen) renderArribosList();
  transitMap.updateBuses(state.arribos, {
    filterLine: state.filterLine,
    selectedBusKey: state.selectedBusKey
  });
}

function closeBusInspector() {
  state.inspectorOpen = false;
  state.selectedBusKey = null;
  el.busInspector.classList.add('hidden');
  transitMap.drawFocusVector(null);
  transitMap.updateBuses(state.arribos, {
    filterLine: state.filterLine,
    selectedBusKey: null
  });
  if (state.activeStop && !state.horariosOpen) renderArribosList();
}

async function crossMatchLineHorarios(stopId, codLinea, buses) {
  const todayTipo = getArgentinaTodayTipo();
  const memKey = `${stopId}:${codLinea}:${todayTipo}`;
  let horarios = state.horariosByLineCache.get(memKey);

  if (!horarios) {
    try {
      const hRes = await api.horarios(stopId, codLinea, todayTipo);
      horarios = hRes?.data?.horarios || [];
      if (horarios.length > 0) {
        state.horariosByLineCache.set(memKey, horarios);
      }
    } catch {
      horarios = [];
    }
  }

  if (horarios.length > 0) {
    const targetBuses = buses.filter((b) => Number(b.codigoLinea) === Number(codLinea));
    return matchBusesWithHorarios(targetBuses, horarios);
  }
  return new Map();
}

async function fetchArribos(showSkeleton = false) {
  if (!state.activeStop) return;

  el.btnRefresh.classList.add('is-loading');
  if (showSkeleton && !state.horariosOpen) {
    el.arribosList.innerHTML = `<div class="skeleton-card"></div><div class="skeleton-card"></div><div class="skeleton-card"></div>`;
  }

  try {
    // When focused on a single line, query /api/arribos-linea to discover ALL active cars (> 3) in parallel!
    const res = state.focusedLineCode
      ? await api.arribosLineaCompleto(state.activeStop.id, state.focusedLineCode)
      : await api.arribos(state.activeStop.id, '000');

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

    const rawArribos = Array.isArray(payload.arribos) ? payload.arribos : [];
    const lineCodes = Array.from(new Set(rawArribos.map((a) => Number(a.codigoLinea)).filter(Boolean)));

    await ensureBranchesLoaded(lineCodes);

    // Keep full stopLinesList when viewing '000' (so user can switch back and forth between lines cleanly)
    if (!state.focusedLineCode) {
      const linesMap = new Map(state.stopLinesList.map((l) => [l.codigo, l.descripcion]));
      for (const a of rawArribos) {
        if (a.codigoLinea && a.descripcionLinea) {
          linesMap.set(Number(a.codigoLinea), a.descripcionLinea);
        }
      }
      state.stopLinesList = Array.from(linesMap.entries()).map(([codigo, descripcion]) => ({ codigo, descripcion }));
    } else if (state.stopLinesList.length === 0 && rawArribos.length > 0) {
      state.stopLinesList = [{ codigo: state.focusedLineCode, descripcion: rawArribos[0].descripcionLinea }];
    }

    const stopCoords =
      typeof state.activeStop.lat === 'number' && typeof state.activeStop.lng === 'number'
        ? { lat: state.activeStop.lat, lng: state.activeStop.lng }
        : payload.stopCoords || null;

    state.arribos = normalizeArrivals(rawArribos, state.activeStop.id, stopCoords);

    // When viewing a single line, automatically cross-match every car against its official Horarios Programados!
    if (state.focusedLineCode && state.arribos.length > 0) {
      await crossMatchLineHorarios(state.activeStop.id, state.focusedLineCode, state.arribos);
    }

    const extLabel = payload.extendedCount > 0 ? ` · +${payload.extendedCount} flota` : '';
    el.lastSyncLabel.textContent = `Act. ${state.lastSyncAt.toLocaleTimeString('es-AR', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    })}${extLabel}`;

    updateSignalPill();
    renderLineFilters();
    if (!state.horariosOpen) renderArribosList();

    transitMap.updateBuses(state.arribos, {
      filterLine: state.filterLine,
      selectedBusKey: state.selectedBusKey
    });

    if (showSkeleton && state.arribos.length > 0) {
      const visibleForFit =
        state.filterLine === 'ALL'
          ? state.arribos
          : state.arribos.filter((b) => b.descripcionLinea === state.filterLine);
      transitMap.fitFleet(visibleForFit);
    }

    if (state.selectedBusKey) {
      const stillHere = state.arribos.find((b) => b.key === state.selectedBusKey);
      if (stillHere) {
        if (state.inspectorOpen) updateInspectorFields(stillHere);
        transitMap.drawFocusVector(stillHere);
      } else {
        closeBusInspector();
      }
    }

    checkProximityAlerts();
  } catch (err) {
    el.lastSyncLabel.textContent = 'Error de conexión';
    showToast(err.message || 'No se pudieron actualizar los arribos', 'warn');
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
// Horarios Programados 24h — Separado por tipo de día (Lun-Vie / Sábado / Domingo)
// Nunca mezcla medianoche; cacheado 14 días por tipo de día + cruce con coches en vivo
// ============================================================================
async function toggleHorariosView() {
  if (!state.activeStop) return;
  state.horariosOpen = !state.horariosOpen;
  el.btnToggleHorarios.classList.toggle('active', state.horariosOpen);
  el.horariosPanel.classList.toggle('hidden', !state.horariosOpen);
  el.arribosList.classList.toggle('hidden', state.horariosOpen);
  el.lineFilterStrip.classList.toggle('hidden', state.horariosOpen);

  if (!state.horariosOpen) return;

  if (state.stopLinesList.length === 0) {
    try {
      const bRes = await api.banderas(state.activeStop.id);
      const names = Array.from(new Set((bRes.data || []).map((b) => String(b.DescripcionLinea || '').trim())));
      state.stopLinesList = names
        .map((desc) => state.lineas.find((l) => l.descripcion === desc))
        .filter(Boolean)
        .map((l) => ({ codigo: l.codigo, descripcion: l.descripcion }));
    } catch {
      // ignore
    }
  }

  if (state.stopLinesList.length === 0) {
    el.horariosPanel.innerHTML = `
      <div class="empty-state">
        <h3>Sin líneas detectadas</h3>
        <p>Elegí una parada o línea primero para ver sus horarios programados.</p>
      </div>
    `;
    return;
  }

  if (state.focusedLineCode) {
    state.horariosLineCode = state.focusedLineCode;
  } else if (!state.horariosLineCode) {
    state.horariosLineCode = state.stopLinesList[0].codigo;
  }
  await loadAndRenderHorarios(state.horariosLineCode, state.horariosTipoDia);
}

async function loadAndRenderHorarios(codLinea, tipoDia = state.horariosTipoDia) {
  state.horariosLineCode = Number(codLinea);
  state.horariosTipoDia = tipoDia;

  const lineObj = state.stopLinesList.find((l) => l.codigo === state.horariosLineCode) || {
    codigo: state.horariosLineCode,
    descripcion: String(state.horariosLineCode)
  };

  const tabsHtml = state.stopLinesList
    .map((l) => {
      const color = getLineColor(l.descripcion);
      const active = l.codigo === state.horariosLineCode;
      return `<button class="filter-chip ${active ? 'active' : ''}" data-hor-line="${l.codigo}" style="--chip-color:${color}">${escapeHtml(
        l.descripcion
      )}</button>`;
    })
    .join('');

  const dayTabs = [
    { key: 'habil', label: 'Lun–Vie' },
    { key: 'sabado', label: 'Sábado' },
    { key: 'domingo', label: 'Domingo' }
  ];
  const dayTabsHtml = `
    <div class="day-type-tabs" role="tablist">
      ${dayTabs
        .map(
          (d) =>
            `<button class="day-tab-btn ${state.horariosTipoDia === d.key ? 'active' : ''}" data-hor-day="${d.key}">${d.label}</button>`
        )
        .join('')}
    </div>
  `;

  el.horariosPanel.innerHTML = `
    <div class="horarios-head">
      <h3>Horarios programados</h3>
      <button id="btn-close-horarios" class="pill-btn">← Arribos</button>
    </div>
    <div class="horarios-line-tabs">${tabsHtml}</div>
    ${dayTabsHtml}
    <div class="skeleton-card"></div>
    <div class="skeleton-card"></div>
  `;
  bindHorariosControls();

  try {
    const res = await api.horarios(state.activeStop.id, state.horariosLineCode, state.horariosTipoDia);
    const data = res.data || {};
    const horarios = Array.isArray(data.horarios) ? data.horarios : [];

    const todayTipo = getArgentinaTodayTipo();
    const isTodayScheme = state.horariosTipoDia === todayTipo;
    const nowArt = getArgentinaNow();
    const nowMin = nowArt.getUTCHours() * 60 + nowArt.getUTCMinutes();

    // Cross-match live buses against scheduled slots when viewing today's day type!
    let slotToBus = new Map();
    if (isTodayScheme && horarios.length > 0) {
      state.horariosByLineCache.set(`${state.activeStop.id}:${state.horariosLineCode}:${todayTipo}`, horarios);
      const lineBuses = state.arribos.filter((b) => Number(b.codigoLinea) === state.horariosLineCode);
      slotToBus = matchBusesWithHorarios(lineBuses, horarios);
    }

    let nextMinute = -1;
    if (isTodayScheme && horarios.length > 0) {
      const nextSlot = horarios.find((h) => h.minuteOfDay >= nowMin);
      nextMinute = nextSlot ? nextSlot.minuteOfDay : -1;
    }

    const groups = [
      { title: 'Madrugada y Mañana (00:00 – 11:59)', items: horarios.filter((h) => h.minuteOfDay < 720) },
      { title: 'Tarde (12:00 – 19:59)', items: horarios.filter((h) => h.minuteOfDay >= 720 && h.minuteOfDay < 1200) },
      { title: 'Noche (20:00 – 23:59)', items: horarios.filter((h) => h.minuteOfDay >= 1200) }
    ].filter((g) => g.items.length > 0);

    const freqText = data.frecuenciaMin ? `Cada ~${data.frecuenciaMin} min` : `${horarios.length} pasos`;
    const statusTag = res.cached
      ? 'Caché 24h local'
      : data.partial
        ? 'Restante de hoy (sin mezclar días)'
        : `Día completo (${data.fechaConsultada || '24h'})`;

    let bodyHtml;
    if (!data.available || horarios.length === 0) {
      bodyHtml = `
        <div class="empty-state">
          <h3>Programación aún no publicada</h3>
          <p>${escapeHtml(
            data.mensaje ||
              `No hay salidas disponibles para ${lineObj.descripcion} en este tipo de día todavía.`
          )}</p>
        </div>
      `;
    } else {
      bodyHtml = `
        <div class="horarios-meta-bar">
          <span><strong>Línea ${escapeHtml(lineObj.descripcion)}</strong> · ${escapeHtml(freqText)}</span>
          <span class="mono-meta">${escapeHtml(statusTag)}</span>
        </div>
        ${groups
          .map(
            (g) => `
            <div class="horarios-group">
              <span class="micro-heading">${escapeHtml(g.title)}</span>
              <div class="horarios-grid">
                ${g.items
                  .map((h) => {
                    const matchedBus = slotToBus.get(h.hora);
                    const cls = matchedBus
                      ? 'has-bus'
                      : isTodayScheme && h.minuteOfDay === nextMinute
                        ? 'is-next'
                        : isTodayScheme && h.minuteOfDay < nowMin
                          ? 'is-past'
                          : '';
                    const busTag = matchedBus?.identificadorCoche
                      ? `<span class="hora-bus-tag">#${escapeHtml(matchedBus.identificadorCoche)}</span>`
                      : '';
                    const tooltip = matchedBus
                      ? `${h.hora} · Coche #${matchedBus.identificadorCoche} (${matchedBus.choferNombre || 'En servicio'}, ${matchedBus.desvio?.label || ''})`
                      : `${h.bandera} · ${h.horaPaso}`;
                    return `<span class="hora-pill ${cls}" title="${escapeHtml(tooltip)}"><span>${escapeHtml(
                      h.hora
                    )}</span>${busTag}</span>`;
                  })
                  .join('')}
              </div>
            </div>
          `
          )
          .join('')}
      `;
    }

    el.horariosPanel.innerHTML = `
      <div class="horarios-head">
        <h3>Horarios programados</h3>
        <button id="btn-close-horarios" class="pill-btn">← Arribos</button>
      </div>
      <div class="horarios-line-tabs">${tabsHtml}</div>
      ${dayTabsHtml}
      ${bodyHtml}
    `;
    bindHorariosControls();
  } catch (err) {
    el.horariosPanel.innerHTML = `
      <div class="horarios-head">
        <h3>Horarios programados</h3>
        <button id="btn-close-horarios" class="pill-btn">← Arribos</button>
      </div>
      <div class="horarios-line-tabs">${tabsHtml}</div>
      ${dayTabsHtml}
      <div class="empty-state"><h3>Error al cargar horarios</h3><p>${escapeHtml(err.message)}</p></div>
    `;
    bindHorariosControls();
  }
}

function bindHorariosControls() {
  document.getElementById('btn-close-horarios')?.addEventListener('click', () => {
    if (state.horariosOpen) toggleHorariosView();
  });
  el.horariosPanel.querySelectorAll('[data-hor-line]').forEach((btn) => {
    btn.addEventListener('click', () => loadAndRenderHorarios(Number(btn.dataset.horLine), state.horariosTipoDia));
  });
  el.horariosPanel.querySelectorAll('[data-hor-day]').forEach((btn) => {
    btn.addEventListener('click', () => loadAndRenderHorarios(state.horariosLineCode, btn.dataset.horDay));
  });
}

// ============================================================================
// Route Polylines Overlay
// ============================================================================
async function loadRouteForLine(codLinea, lineName, { clearExisting = true, fit = true } = {}) {
  if (clearExisting) transitMap.clearRoutes();
  showToast(`Cargando recorrido de línea ${lineName}...`, 'info', 2000);
  try {
    const res = await api.recorridos(codLinea);
    const list = Array.isArray(res.data) ? res.data : [];
    state.routeBranchesCache.set(Number(codLinea), parseRouteBranches(list));
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
                <span class="line-tile-pill">${escapeHtml(l.descripcion)}</span>
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
      btn.addEventListener('click', () => openLineCalles({ codigo: Number(btn.dataset.cod), descripcion: btn.dataset.desc }));
    });
    el.lineasContent.querySelectorAll('.btn-line-map').forEach((btn) => {
      btn.addEventListener('click', () => loadRouteForLine(btn.dataset.cod, btn.dataset.desc, { clearExisting: true, fit: true }));
    });
    return;
  }

  const filtered = items.filter((it) => (it.descripcion || '').toLowerCase().includes(query));
  if (filtered.length === 0) {
    el.lineasContent.innerHTML = `<div class="empty-state"><h3>Sin resultados</h3><p>Probá con otro término.</p></div>`;
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
      btn.addEventListener('click', () => openCalleIntersecciones({ codigo: Number(btn.dataset.cod), descripcion: btn.dataset.desc }));
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
      btn.addEventListener('click', () => openInterseccionParadas({ codigo: Number(btn.dataset.cod), descripcion: btn.dataset.desc }));
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
            <button class="pill-btn btn-open-all" data-id="${escapeHtml(p.identificador)}" data-name="${escapeHtml(p.descripcion)}">Todas las líneas</button>
            <button class="pill-btn pill-btn-ghost btn-open-only" data-id="${escapeHtml(p.identificador)}" data-name="${escapeHtml(p.descripcion)}">Solo ${escapeHtml(state.drill.linea.descripcion)}</button>
          </div>
        </div>
      `
      )
      .join('');

    el.lineasContent.querySelectorAll('.btn-open-all').forEach((btn) => {
      btn.addEventListener('click', () => openStopRadar({ id: btn.dataset.id, nombre: btn.dataset.name }, '000'));
    });
    el.lineasContent.querySelectorAll('.btn-open-only').forEach((btn) => {
      btn.addEventListener('click', () =>
        openStopRadar({ id: btn.dataset.id, nombre: btn.dataset.name }, String(state.drill.linea.codigo))
      );
    });
  }
}

async function openLineCalles(linea) {
  el.lineasFilterInput.value = '';
  state.drill = { step: 'calles', linea, calle: null, interseccion: null, items: [] };
  renderLineasBreadcrumb();
  el.lineasContent.innerHTML = `<div class="skeleton-card"></div><div class="skeleton-card"></div>`;
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
  el.lineasContent.innerHTML = `<div class="skeleton-card"></div>`;
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
// TAB 3: Paradas Cercanas
// ============================================================================
function renderHubs() {
  el.hubsChips.innerHTML = state.hubs
    .map((h, idx) => `<button class="hub-chip" data-hub-idx="${idx}">${escapeHtml(h.name.replace(/\s*\(Piloto\)/i, ''))}</button>`)
    .join('');

  el.hubsChips.querySelectorAll('.hub-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const hub = state.hubs[Number(chip.dataset.hubIdx)];
      if (hub) searchNearbyStops(hub.lat, hub.lng, hub.name);
    });
  });

  el.cercanasList.innerHTML = `
    <div class="empty-state">
      <div class="empty-state-icon">◎</div>
      <h3>Buscá paradas a tu alrededor</h3>
      <p>Usá tu GPS, tocá el centro del mapa o elegí una zona de Corrientes.</p>
    </div>
  `;
}

async function searchNearbyStops(lat, lng, label = 'esta zona') {
  switchTab('cercanas');
  el.cercanasList.innerHTML = `<div class="skeleton-card"></div><div class="skeleton-card"></div>`;

  try {
    const res = await api.paradasCercanas(lat, lng);
    const stops = Array.isArray(res.data) ? res.data : [];
    state.nearbyStops = stops;

    if (stops.length === 0) {
      el.cercanasList.innerHTML = `<div class="empty-state"><h3>Sin paradas cercanas</h3><p>No encontramos paradas cerca de ${escapeHtml(label)}.</p></div>`;
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
            <div class="stop-card-lines">${escapeHtml(s.lineas || '')}</div>
            <div class="stop-card-foot">
              <span class="mono-meta">${escapeHtml(s.callePrincipal || '')}</span>
              <button class="pill-btn btn-nearby-open" data-id="${escapeHtml(s.identificador)}" data-name="${escapeHtml(
                s.descripcion
              )}" data-lat="${sLat}" data-lng="${sLng}">Abrir radar →</button>
            </div>
          </div>
        `;
      })
      .join('');

    el.cercanasList.querySelectorAll('.btn-nearby-open').forEach((btn) => {
      btn.addEventListener('click', () => {
        openStopRadar(
          { id: btn.dataset.id, nombre: btn.dataset.name, lat: parseFloat(btn.dataset.lat), lng: parseFloat(btn.dataset.lng) },
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
    const c = transitMap.getCenter();
    searchNearbyStops(c.lat, c.lng, 'el centro del mapa');
    return;
  }
  showToast('Obteniendo ubicación GPS...', 'info', 1800);
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const { latitude, longitude, accuracy } = pos.coords;
      transitMap.setUserLocation(latitude, longitude, accuracy);
      searchNearbyStops(latitude, longitude, 'tu ubicación');
    },
    () => {
      showToast('Sin permiso GPS. Mostrando paradas en el centro de Corrientes.', 'warn');
      searchNearbyStops(CORRIENTES_CENTER.lat, CORRIENTES_CENTER.lng, 'Centro de Corrientes');
    },
    { enableHighAccuracy: true, timeout: 7000 }
  );
}

// ============================================================================
// Global Search
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
      title: `Ir a parada ${upper}`,
      sub: 'Consultar arribos de todas las líneas',
      badge: upper,
      action: () => openStopRadar({ id: upper, nombre: `Parada ${upper}` }, '000')
    });
  }

  const knownStops = [...state.favorites, ...state.quickStops];
  const seenStop = new Set();
  for (const s of knownStops) {
    if (seenStop.has(s.id)) continue;
    seenStop.add(s.id);
    if (`${s.id} ${s.nombre} ${s.alias || ''}`.toUpperCase().includes(upper)) {
      results.push({
        title: s.nombre,
        sub: s.alias ? `${s.alias} · Todas las líneas` : 'Parada · Todas las líneas',
        badge: s.id,
        action: () => openStopRadar(s, '000')
      });
    }
  }

  for (const l of state.lineas) {
    if (l.descripcion.toUpperCase().includes(upper)) {
      results.push({
        title: `Línea ${l.descripcion}`,
        sub: 'Calles, paradas y recorrido',
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
    el.searchDropdown.innerHTML = `<div class="search-item"><div class="search-item-main"><span class="search-item-title">Sin coincidencias</span><span class="search-item-sub">Ingresá un código como CT31498 o una línea como 106A</span></div></div>`;
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
// Events & Clean Init
// ============================================================================
function bindEvents() {
  el.tabs.forEach((tab) => tab.addEventListener('click', () => switchTab(tab.dataset.tab)));
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
  });

  el.btnLiveMode.addEventListener('click', async () => {
    if (!state.activeStop) {
      showToast('Buscá una parada primero para activar el modo simulación', 'info');
      return;
    }
    state.simulateMode = !state.simulateMode;
    updateSignalPill();
    if (state.simulateMode) {
      showToast('Simulación activa: los coches avanzan sobre su recorrido real', 'success');
      if (state.arribos.length === 0) await fetchArribos(false);
    } else {
      showToast('Modo EN VIVO: actualización automática cada 15s', 'info');
      fetchArribos(false);
    }
  });

  el.btnToggleFav.addEventListener('click', toggleActiveStopFavorite);
  el.btnShareStop.addEventListener('click', async () => {
    if (!state.activeStop) return;
    try {
      await navigator.clipboard.writeText(window.location.href);
      showToast(`Enlace copiado para ${state.activeStop.id}`, 'success');
    } catch {
      showToast(`Parada actual: ${state.activeStop.id}`, 'info');
    }
  });

  el.btnRefresh.addEventListener('click', () => fetchArribos(false));
  el.btnShowRoutes.addEventListener('click', toggleActiveStopRoutes);
  el.btnToggleHorarios.addEventListener('click', toggleHorariosView);
  el.btnFitFleet.addEventListener('click', () => {
    const visible =
      state.filterLine === 'ALL'
        ? state.arribos
        : state.arribos.filter((b) => b.descripcionLinea === state.filterLine);
    transitMap.fitFleet(visible);
  });

  el.btnCloseInspector.addEventListener('click', closeBusInspector);
  el.btnInspRoute.addEventListener('click', () => {
    const cod = el.btnInspRoute.dataset.codLinea;
    const name = el.btnInspRoute.dataset.lineName;
    if (cod) loadRouteForLine(cod, name, { clearExisting: true, fit: true });
  });

  el.btnZoomIn.addEventListener('click', () => transitMap.zoomIn());
  el.btnZoomOut.addEventListener('click', () => transitMap.zoomOut());
  el.btnMapCenterStop.addEventListener('click', () => transitMap.focusStop(16));
  el.btnMapStyle.addEventListener('click', () => {
    const cfg = transitMap.cycleTileStyle();
    showToast(`Mapa: ${cfg.label}`, 'info', 1500);
  });
  el.btnMapScanArea.addEventListener('click', () => {
    const c = transitMap.getCenter();
    searchNearbyStops(c.lat, c.lng, 'el centro del mapa');
  });

  el.btnLocateMe.addEventListener('click', locateUserGps);
  el.btnSearchMapCenter.addEventListener('click', () => {
    const c = transitMap.getCenter();
    searchNearbyStops(c.lat, c.lng, 'el centro del mapa');
  });

  el.lineasFilterInput.addEventListener('input', renderDrilldown);
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
    if (!e.target.closest('.quick-search-wrap')) el.searchDropdown.classList.add('hidden');
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

  try {
    const boot = await api.bootstrap();
    state.lineas = Array.isArray(boot.lineas) ? boot.lineas : [];
    state.quickStops = Array.isArray(boot.quickStops) ? boot.quickStops : [];
    state.hubs = Array.isArray(boot.hubs) ? boot.hubs : [];
    state.drill.items = state.lineas;
    renderDrilldown();
    renderHubs();
  } catch {
    showToast('No se pudo cargar el catálogo de líneas', 'warn');
  }

  const params = new URLSearchParams(window.location.search);
  const paramStopId = (params.get('idParada') || '').trim().toUpperCase();
  const paramCodLinea = params.get('codLinea') || '000';

  if (paramStopId) {
    const known =
      state.quickStops.find((s) => s.id === paramStopId) ||
      state.favorites.find((f) => f.id === paramStopId) || {
        id: paramStopId,
        nombre: `Parada ${paramStopId}`
      };
    await openStopRadar(known, paramCodLinea);
  } else {
    renderRadarWelcome();
  }

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
