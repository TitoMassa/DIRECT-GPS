import { CORRIENTES_CENTER, REFRESH_INTERVAL_SEC, getLineColor } from './config.js';
import {
  api,
  warmOfflineArchive,
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
import {
  parseRouteBranches,
  resolveBusTrajectory,
  resolveTrailDirection,
  buildTrajectoryFromBranchAlong,
  pickStopBranches,
  projectOnPolyline,
  sampleBranchAtAlong
} from './trajectory.js';
import {
  buildLineScheduleModel,
  buildStopTimetableBlocks,
  getTripStopSec,
  matchLiveBusesToTrips,
  buildGpsAnchorForTrip,
  parseGpsStampSecOfDay,
  detectAlreadyPassedTrips,
  predictLineBusesForStop,
  getArgentinaSecOfDay,
  getArgentinaDayKey,
  formatSecHHMM,
  formatLapNumber,
  formatLapSpoken,
  formatShiftLaps,
  formatShiftLapsSpoken,
  resolveUnitScheduleMeta,
  matchFreeFleetUnitsToModel
} from './predictor.js';
import { BusSimulator, parseGpsTimestampMs } from './simulator.js';
import { TransitMap } from './map.js';
import { playArrivalChime, playSubtleTick } from './audio.js';
import {
  isNative,
  initNative,
  hideSplash,
  setSystemBarsTheme,
  setKeepAwake,
  getCurrentPosition,
  shareStop,
  haptic,
  ensureNotificationPermission,
  notifyArrival
} from './native.js';

const busSimulator = new BusSimulator();
let simRafId = null;
let simLastFrameMs = 0;
let simLastDomMs = 0;
let fetchSeq = 0;

// Keyed DOM caches for zero-teardown updates on 10s polls and 1Hz sim ticks
const arrivalRowCache = new Map(); // busKey -> HTMLElement (with ._refs)
let filterStripSig = '';

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
  simulateMode: true, // Default mode: EN VIVO (green) — smooth motion + offline/no-GPS timetable prediction
  isOffline: typeof navigator !== 'undefined' && navigator.onLine === false,
  horariosOpen: false,
  horariosLineCode: null,
  horariosTipoDia: getArgentinaTodayTipo(),
  horariosSelectedBlockId: null,
  horariosSelectedHora: null,
  horariosViewCtx: null, // Cached rendered timetable metadata for live in-place updates
  stopLinesList: [], // [{ codigo, descripcion }] for active stop
  dataSource: 'smartmovepro-soap',
  lastSyncAt: null,
  countdownSec: REFRESH_INTERVAL_SEC,
  routesVisible: false,

  // Optional citywide circulating buses overlay (all lines)
  allFleetMode: false,
  allFleetBuses: [],
  allFleetLoading: false,
  allFleetTimerId: null,
  dockExpanded: false,

  // Offline archives & system FleetMemory caches
  catalogo: null,
  routeBranchesCache: new Map(),
  horariosArchiveCache: new Map(), // codLinea -> full horarios/<codLinea>.json
  horariosByLineCache: new Map(), // `${stopId}:${codLinea}:${tipoDia}` -> horarios[]
  lastRealGpsByUnit: new Map(), // baseId -> { latest, prev, prevMoving, trail[], confirmedDir }
  fleetMemory: { dayKey: '', stopSnapshot: null, trips: [], units: [] },
  fleetMemoryLastFetchMs: 0,
  sessionObservedTrips: new Map(), // `${codLinea}:${tripKey}` -> latest online observation
  stickyLiveTripByCoche: new Map(), // `${codLinea}:${coche}` -> { tripKey, serviceNumber, blockId, dayKey, updatedAt }
  serviceEvidenceByCoche: new Map(), // `${codLinea}:${coche}` -> { serviceNumber, blockId, dayKey, avgErrSec, count, updatedAt }
  completedTripsByStop: new Map(), // `${dayKey}:${stopId}` -> Set<`${codLinea}:${tripKey}`>
  downstreamProbeCache: new Map(), // `${codLinea}:${terminalStopId}` -> { ts, arribos }
  corridorFleet: [], // Latest parallel corridor-radar units returned by Worker (/api/arribos-linea & /api/arribos)

  // Catalog & Drilldown
  lineas: [],
  quickStops: [],
  hubs: [],
  flotaSummaryByLine: new Map(), // codLinea -> { cochesHoy, cochesSemana, choferesHoy, choferesSemana, lastSeenAt }
  flotaSummaryMeta: null,
  flotaSummaryLastFetchMs: 0,
  flotaView: {
    tab: 'coches', // 'coches' | 'choferes' | 'servicios'
    scope: 'semana', // 'semana' | 'hoy'
    data: null,
    schedSummary: null, // Cross-referenced from official timetable model for today
    model: null, // Full LineScheduleModel for resolving per-unit service/turno/vuelta
    loading: false,
    error: null
  },
  recorridoView: {
    tipoDia: getArgentinaTodayTipo(),
    branchIdx: 0,
    viewMode: 'grilla', // 'grilla' | 'paradas'
    serviceFilter: 'ALL',
    expandedStopId: null,
    model: null,
    branches: [],
    horFile: null,
    loading: false,
    error: null
  },
  trackedUnit: null, // { codLinea, lineName, coche, choferNombre, choferLegajo, timerId, bus, buses, seq }
  drill: {
    step: 'lineas', // 'lineas' | 'recorrido' | 'flota' | 'calles' | 'intersecciones' | 'paradas'
    linea: null,
    calle: null,
    interseccion: null,
    items: []
  },

  soundEnabled: true,
  isAppPaused: false,
  editingFavId: null,
  armedAlerts: new Set(),
  triggeredAlerts: new Set(),
  favorites: [],
  nearbyStops: []
};

const el = {
  appShell: document.getElementById('app-shell'),
  dock: document.getElementById('transit-dock'),
  btnDockSize: document.getElementById('btn-dock-size'),
  dockSizeLabel: document.getElementById('dock-size-label'),
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
  btnRefreshStop: document.getElementById('btn-refresh-stop'),
  btnToggleFav: document.getElementById('btn-toggle-fav'),
  btnShareStop: document.getElementById('btn-share-stop'),
  btnShowRoutes: document.getElementById('btn-show-routes'),
  btnToggleHorarios: document.getElementById('btn-toggle-horarios'),
  btnFitFleet: document.getElementById('btn-fit-fleet'),
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
  inspServicePill: document.getElementById('insp-service-pill'),
  inspAccessBadge: document.getElementById('insp-access-badge'),
  inspChofer: document.getElementById('insp-chofer'),
  inspLegajo: document.getElementById('insp-legajo'),
  inspEta: document.getElementById('insp-eta'),
  inspDist: document.getElementById('insp-dist'),
  inspBlocks: document.getElementById('insp-blocks'),
  inspNextLapCell: document.getElementById('insp-nextlap-cell'),
  inspNextLap: document.getElementById('insp-nextlap'),
  inspGps: document.getElementById('insp-gps'),
  btnCloseInspector: document.getElementById('btn-close-inspector'),
  btnInspTrack: document.getElementById('btn-insp-track'),
  btnInspCenter: document.getElementById('btn-insp-center'),
  btnInspRoute: document.getElementById('btn-insp-route'),

  btnAllBuses: document.getElementById('btn-all-buses'),
  allBusesCount: document.getElementById('all-buses-count'),
  btnMapLocate: document.getElementById('btn-map-locate'),
  btnMapCenterStop: document.getElementById('btn-map-center-stop'),
  btnMapScanArea: document.getElementById('btn-map-scan-area'),
  btnZoomIn: document.getElementById('btn-zoom-in'),
  btnZoomOut: document.getElementById('btn-zoom-out'),

  aliasModal: document.getElementById('alias-modal'),
  aliasModalForm: document.getElementById('alias-modal-form'),
  aliasModalSub: document.getElementById('alias-modal-sub'),
  aliasModalInput: document.getElementById('alias-modal-input'),
  btnAliasClose: document.getElementById('btn-alias-close'),
  btnAliasCancel: document.getElementById('btn-alias-cancel'),

  srAnnouncer: document.getElementById('sr-announcer'),
  srAlert: document.getElementById('sr-alert'),
  toastContainer: document.getElementById('toast-container')
};

let lastModalTriggerEl = null;

const transitMap = new TransitMap('map', {
  onBusSelect: (busKey) => openBusInspector(busKey),
  onAllFleetBusSelect: (busKey) => openAllFleetBusInspector(busKey),
  onStopPick: (stop) => openStopRadar(stop, '000')
});

// ============================================================================
// Utilities, Screen-Reader Announcer & Toast
// ============================================================================
function escapeHtml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function announce(message, { assertive = false } = {}) {
  const region = assertive ? el.srAlert : el.srAnnouncer;
  if (!region || !message) return;
  region.textContent = '';
  requestAnimationFrame(() => {
    region.textContent = String(message);
  });
}

function showToast(message, type = 'info', duration = 3200, { silent = false } = {}) {
  const div = document.createElement('div');
  div.className = `toast toast-${type}`;
  div.textContent = message;
  el.toastContainer.appendChild(div);
  if (!silent) {
    announce(message, { assertive: type === 'warn' });
  }
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
  el.btnThemeToggle.setAttribute(
    'aria-label',
    isLight ? 'Tema claro activo. Cambiar a tema oscuro' : 'Tema oscuro activo. Cambiar a tema claro'
  );
  el.metaThemeColor.setAttribute('content', isLight ? '#f4f5f7' : '#0b0d10');
  setSystemBarsTheme(theme);
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
  if (!state.activeStop) {
    renderRadarWelcome();
  }
}

function isFavorite(stopId) {
  return Boolean(stopId) && state.favorites.some((f) => f.id === stopId);
}

function updateFavStarButton() {
  const stopId = state.activeStop?.id || '';
  const fav = stopId ? isFavorite(stopId) : false;
  el.btnToggleFav.classList.toggle('is-fav', fav);
  el.btnToggleFav.setAttribute('aria-pressed', String(fav));
  const label = fav
    ? `Quitar parada ${stopId} de favoritas`
    : `Guardar parada ${stopId} en favoritas`;
  el.btnToggleFav.title = label;
  el.btnToggleFav.setAttribute('aria-label', label);
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
  haptic('medium');
  saveFavorites();
}

function renderFavorites() {
  if (state.favorites.length === 0) {
    el.favoritasList.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon" aria-hidden="true">★</div>
        <h3>Sin paradas favoritas</h3>
        <p>Buscá una parada y tocá la estrella para guardarla acá con acceso directo.</p>
      </div>
    `;
    return;
  }

  el.favoritasList.innerHTML = state.favorites
    .map(
      (f) => {
        const displayLabel = f.alias ? `${f.alias}, ${f.nombre || f.id}` : f.nombre || f.id;
        return `
      <div class="stop-list-card" data-fav-id="${escapeHtml(f.id)}">
        <div class="stop-card-top">
          <div>
            <span class="code-badge">${escapeHtml(f.id)}</span>
            ${f.alias ? `<span class="pilot-tag" style="margin-left:5px">${escapeHtml(f.alias)}</span>` : ''}
          </div>
          <div style="display:flex;gap:4px">
            <button type="button" class="mini-action-btn btn-edit-fav" data-id="${escapeHtml(f.id)}" title="Editar etiqueta" aria-label="Editar etiqueta de parada ${escapeHtml(f.id)}, ${escapeHtml(displayLabel)}">✎</button>
            <button type="button" class="mini-action-btn btn-del-fav" data-id="${escapeHtml(f.id)}" title="Eliminar" aria-label="Eliminar parada ${escapeHtml(f.id)}, ${escapeHtml(displayLabel)} de favoritas">✕</button>
          </div>
        </div>
        <div class="stop-card-name">${escapeHtml(f.nombre)}</div>
        <div class="stop-card-foot">
          <span class="mono-meta" aria-hidden="true">${f.lat ? `${f.lat.toFixed(4)}, ${f.lng.toFixed(4)}` : 'Corrientes Capital'}</span>
          <button type="button" class="seg-btn seg-btn-xs btn-open-fav" data-id="${escapeHtml(f.id)}" aria-label="Abrir radar de parada ${escapeHtml(f.id)}, ${escapeHtml(displayLabel)}">Abrir radar →</button>
        </div>
      </div>
    `;
      }
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
      if (fav) openAliasModal(fav);
    });
  });
}

function openAliasModal(fav) {
  if (!el.aliasModal) return;
  lastModalTriggerEl = document.activeElement;
  state.editingFavId = fav.id;
  el.aliasModalSub.textContent = `${fav.id} · ${fav.nombre || 'Parada guardada'}`;
  el.aliasModalInput.value = fav.alias || '';
  el.aliasModal.classList.remove('hidden');
  requestAnimationFrame(() => {
    el.aliasModalInput.focus();
    el.aliasModalInput.select();
  });
}

function closeAliasModal() {
  if (!el.aliasModal) return;
  state.editingFavId = null;
  el.aliasModal.classList.add('hidden');
  el.aliasModalInput.blur();
  if (lastModalTriggerEl && typeof lastModalTriggerEl.focus === 'function') {
    lastModalTriggerEl.focus();
    lastModalTriggerEl = null;
  }
}

// ============================================================================
// Tabs & Fluid Interactive Mobile Bottom Sheet
// ============================================================================
function getActiveTab() {
  const active = Array.from(el.tabs).find((t) => t.classList.contains('active'));
  return active ? active.dataset.tab : 'radar';
}

function switchTab(tabName) {
  el.tabs.forEach((t) => {
    const active = t.dataset.tab === tabName;
    t.classList.toggle('active', active);
    t.setAttribute('aria-selected', String(active));
    t.setAttribute('tabindex', active ? '0' : '-1');
  });
  el.panels.forEach((p) => {
    const active = p.id === `panel-${tabName}`;
    p.classList.toggle('active', active);
    p.setAttribute('aria-hidden', String(!active));
  });
  if (tabName === 'lineas' && !state.isOffline) {
    loadFlotaResumen(false);
  }
}

const SHEET_STATES = ['sheet-peek', 'sheet-half', 'sheet-full'];

function getSheetIndex() {
  const found = SHEET_STATES.findIndex((s) => el.dock.classList.contains(s));
  return found === -1 ? 1 : found;
}

// Matches CSS breakpoints: bottom sheet on <= 860px except wide-landscape side-rail
function isBottomSheetLayout() {
  const isLandscapeRail = window.matchMedia('(max-height: 540px) and (min-width: 560px)').matches;
  return window.innerWidth <= 860 && !isLandscapeRail;
}

function getSheetSnapHeights() {
  const vh = window.innerHeight;
  const header = document.querySelector('.top-bar');
  const topClearance = header ? Math.ceil(header.getBoundingClientRect().bottom + 10) : 64;
  return [
    Math.min(170, Math.round(vh * 0.24)),
    Math.round(vh * 0.47),
    Math.max(300, vh - topClearance)
  ];
}

function clearSheetInlineSize() {
  el.dock.style.height = '';
  el.dock.classList.remove('is-dragging');
  el.appShell?.style.removeProperty('--sheet-h');
}

function setSheetIndex(idx = 1, { silent = false } = {}) {
  clearSheetInlineSize();
  const expanded = idx >= 2;
  state.dockExpanded = expanded;
  SHEET_STATES.forEach((s) => el.dock.classList.remove(s));
  el.dock.classList.add(expanded ? 'sheet-full' : 'sheet-half');
  el.appShell?.classList.toggle('dock-expanded', expanded);
  if (el.btnDockSize) {
    el.btnDockSize.setAttribute('aria-pressed', String(expanded));
    el.btnDockSize.setAttribute('aria-label', expanded ? 'Volver a vista dividida con mapa' : 'Ampliar panel');
  }
  if (el.dockSizeLabel) {
    el.dockSizeLabel.textContent = expanded ? 'Ver mapa' : 'Ampliar';
  }
  requestAnimationFrame(() => transitMap.invalidateSize());
  if (!silent) haptic('light');
}

function setupMobileSheet() {
  setSheetIndex(1, { silent: true });
  el.btnDockSize?.addEventListener('click', () => {
    setSheetIndex(state.dockExpanded ? 1 : 2);
  });
  window.addEventListener('resize', () => {
    clearSheetInlineSize();
    requestAnimationFrame(() => transitMap.invalidateSize());
  });
}

// ============================================================================
// Clean Welcome State
// ============================================================================
function renderRadarWelcome() {
  el.stopHero.classList.add('hidden');
  el.lineFilterStrip.classList.add('hidden');
  el.horariosPanel.classList.add('hidden');
  el.arribosList.classList.remove('hidden');
  arrivalRowCache.clear();
  filterStripSig = '';

  const topFavs = state.favorites.slice(0, 3);
  const favsHtml =
    topFavs.length > 0
      ? `
      <div class="welcome-favs-block">
        <span class="micro-heading">Favoritas</span>
        <div class="welcome-favs-list">
          ${topFavs
            .map(
              (f) => `
            <button type="button" class="welcome-fav-btn" data-welcome-fav="${escapeHtml(f.id)}">
              <span class="list-row-main">
                <span class="list-row-title">${escapeHtml(f.alias || f.nombre || f.id)}</span>
                ${f.alias && f.nombre ? `<span class="list-row-sub">${escapeHtml(f.nombre)}</span>` : ''}
              </span>
              <span class="code-badge">${escapeHtml(f.id)}</span>
            </button>
          `
            )
            .join('')}
        </div>
      </div>
    `
      : '';

  el.arribosList.innerHTML = `
    <div class="radar-welcome">
      <h2>Elegí una parada para iniciar</h2>
      <p>Consultá arribos en vivo con coche, chofer, desvío horario, horarios programados 24h y rotaciones de servicio.</p>

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

      ${favsHtml}

      <div class="welcome-tip">
        Mové el mapa sobre cualquier avenida y usá la lupa inferior derecha para detectar paradas en esa zona.
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
  el.arribosList.querySelectorAll('[data-welcome-fav]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const fav = state.favorites.find((x) => x.id === btn.dataset.welcomeFav);
      if (fav) openStopRadar(fav, '000');
    });
  });
}

function resetToWelcome() {
  state.activeStop = null;
  state.arribos = [];
  state.selectedBusKey = null;
  state.filterLine = 'ALL';
  state.routesVisible = false;
  state.horariosOpen = false;
  state.horariosSelectedBlockId = null;
  state.horariosSelectedHora = null;
  state.horariosViewCtx = null;
  arrivalRowCache.clear();
  filterStripSig = '';
  stopSimLoop();
  busSimulator.clear();
  el.btnShowRoutes.classList.remove('active');
  el.btnShowRoutes.setAttribute('aria-pressed', 'false');
  el.btnToggleHorarios.classList.remove('active');
  el.btnToggleHorarios.setAttribute('aria-pressed', 'false');
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
  syncKeepAwake();
  announce('Inicio de DIRECT GPS. Elegí una parada para iniciar.');
}

// ============================================================================
// Core Radar: Stop Loading, Direction-Aware Trajectories & Zero-Lag Interpolation
// ============================================================================
function updateSignalPill() {
  el.btnLiveMode.classList.remove('is-gps', 'is-warn');
  el.btnLiveMode.setAttribute('aria-pressed', String(state.simulateMode));
  if (state.simulateMode) {
    el.signalLabel.textContent = 'EN VIVO';
    const desc = 'Modo EN VIVO activo: seguimiento continuo y predicción por horarios. Tocá para ver último GPS.';
    el.btnLiveMode.title = desc;
    el.btnLiveMode.setAttribute('aria-label', desc);
  } else {
    el.btnLiveMode.classList.add('is-gps');
    el.signalLabel.textContent = 'ULT. GPS';
    const desc = 'Modo último GPS activo: posición satelital estática. Tocá para volver a EN VIVO.';
    el.btnLiveMode.title = desc;
    el.btnLiveMode.setAttribute('aria-label', desc);
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

  updateFavStarButton();

  const url = new URL(window.location.href);
  url.searchParams.set('idParada', s.id);
  url.searchParams.set('codLinea', isAll ? '000' : state.codLineaQuery);
  window.history.replaceState({}, '', url.toString());
}

async function openStopRadar(stopInfo, codLinea = '000') {
  stopTrackedUnit();
  const rawCode = String(codLinea ?? '000').trim();
  const stopId = String(stopInfo.id || stopInfo.identificador || '').trim().toUpperCase();
  if (!stopId) return;

  // Enrich stop name, coordinates, and serving lines immediately from offline catalogo.json
  if (!state.catalogo) {
    state.catalogo = await api.catalogo().catch(() => null);
  }
  const catStop = state.catalogo?.stopById?.get(stopId) || null;

  const isAll = !rawCode || rawCode === '0' || rawCode === '000';
  const lineObj = !isAll ? state.lineas.find((l) => String(l.codigo) === rawCode) : null;

  const rawName = stopInfo.nombre || stopInfo.descripcion || '';
  const bestName =
    rawName && rawName !== `Parada ${stopId}`
      ? rawName
      : catStop?.nombre || `Parada ${stopId}`;
  const bestLat =
    typeof stopInfo.lat === 'number' && !Number.isNaN(stopInfo.lat)
      ? stopInfo.lat
      : parseFloat(stopInfo.latitud) || catStop?.lat || null;
  const bestLng =
    typeof stopInfo.lng === 'number' && !Number.isNaN(stopInfo.lng)
      ? stopInfo.lng
      : parseFloat(stopInfo.longitud) || catStop?.lng || null;

  state.activeStop = {
    id: stopId,
    nombre: bestName,
    lat: bestLat,
    lng: bestLng
  };
  state.codLineaQuery = isAll ? '000' : rawCode;
  syncKeepAwake();
  state.focusedLineCode = isAll ? null : Number(rawCode);
  state.filterLine = lineObj ? lineObj.descripcion : 'ALL';
  state.selectedBusKey = null;
  state.routesVisible = false;
  state.horariosOpen = false;
  state.horariosLineCode = isAll ? null : Number(rawCode);
  state.horariosTipoDia = getArgentinaTodayTipo();
  state.horariosSelectedBlockId = null;
  state.horariosSelectedHora = null;
  state.horariosViewCtx = null;
  arrivalRowCache.clear();
  filterStripSig = '';
  state.stopLinesList = (catStop?.lineas || [])
    .map((cod) => {
      const l = state.catalogo?.lineByCode?.get(Number(cod)) || state.lineas.find((x) => Number(x.codigo) === Number(cod));
      return l ? { codigo: Number(l.codigo), descripcion: l.descripcion } : null;
    })
    .filter(Boolean);
  if (state.focusedLineCode && !state.stopLinesList.some((l) => l.codigo === state.focusedLineCode) && lineObj) {
    state.stopLinesList.push({ codigo: Number(lineObj.codigo), descripcion: lineObj.descripcion });
  }
  // Prune stale (>10 min) GPS history instead of wiping it so penultimate-to-latest speed & heading survive stop switches!
  const pruneBefore = Date.now() - 10 * 60 * 1000;
  for (const [k, v] of state.lastRealGpsByUnit.entries()) {
    if (!v?.latest || v.latest.ts < pruneBefore) state.lastRealGpsByUnit.delete(k);
  }
  busSimulator.clear();

  el.btnShowRoutes.classList.remove('active');
  el.btnShowRoutes.setAttribute('aria-pressed', 'false');
  el.btnToggleHorarios.classList.remove('active');
  el.btnToggleHorarios.setAttribute('aria-pressed', 'false');
  el.horariosPanel.classList.add('hidden');
  el.arribosList.classList.remove('hidden');

  transitMap.clearRoutes();
  closeBusInspector();

  switchTab('radar');
  updateStopHeaderUI();
  el.stopTitle?.focus({ preventScroll: true });

  if (state.activeStop.lat && state.activeStop.lng) {
    transitMap.setActiveStop(state.activeStop);
    transitMap.focusStop(15);
  }

  await fetchArribos(true, { announceSummary: true });
}

async function ensureBranchesLoaded(lineCodes) {
  const missing = lineCodes.filter((c) => c && !state.routeBranchesCache.has(Number(c)));
  if (missing.length === 0) return;

  await Promise.all(
    missing.map(async (cod) => {
      const numCod = Number(cod);
      try {
        const res = await api.recorridos(numCod);
        const branches = parseRouteBranches(Array.isArray(res.data) ? res.data : []);
        state.routeBranchesCache.set(numCod, branches);
      } catch {
        state.routeBranchesCache.set(numCod, []);
      }
    })
  );
}

async function ensureScheduleAssetsLoaded(lineCodes) {
  const cleanCodes = Array.from(new Set((lineCodes || []).map(Number).filter(Boolean)));
  if (cleanCodes.length === 0) return;
  await Promise.all([
    ensureBranchesLoaded(cleanCodes),
    ...cleanCodes
      .filter((c) => !state.horariosArchiveCache.has(c))
      .map(async (c) => {
        const file = await api.horariosLineArchive(c).catch(() => null);
        if (file) state.horariosArchiveCache.set(c, file);
      })
  ]);
}

async function syncFleetMemory(lineCodes, { force = false, stopId = '' } = {}) {
  const nowMs = Date.now();
  const sameStop = !stopId || state.fleetMemory?.stopSnapshot?.idParada === stopId;
  if (!force && sameStop && nowMs - state.fleetMemoryLastFetchMs < 45000 && state.fleetMemory.trips.length > 0) {
    return state.fleetMemory;
  }
  state.fleetMemoryLastFetchMs = nowMs;
  const mem = await api.getFleetMemory(lineCodes, stopId).catch(() => null);
  if (mem) {
    state.fleetMemory = mem;
  }
  return state.fleetMemory;
}

/**
 * Maintains an internal multi-point GPS position trail (up to 8 spatially distinct moving fixes)
 * plus penultimate/latest fixes and route-aligned `confirmedDir` per physical bus unit.
 * Hydrates from server `FleetMemory` (`gpsTrail` + `dirBandera`) on cold start so direction
 * relative to the route polyline is known from Poll #1 and remains rock-steady through red lights.
 */
const MAX_UNIT_TRAIL_POINTS = 8;
const UNIT_TRAIL_MAX_AGE_MS = 12 * 60 * 1000;

function recordUnitGpsFix(baseId, codLinea, coche, lat, lng, gpsRaw, now = Date.now()) {
  const gpsMs = parseGpsTimestampMs(gpsRaw);
  const curFix = { lat, lng, gpsMs, ts: now };
  let hist = state.lastRealGpsByUnit.get(baseId);

  const pushToTrail = (trail, fix) => {
    if (!fix || typeof fix.lat !== 'number' || typeof fix.lng !== 'number') return;
    if (Number.isNaN(fix.lat) || Number.isNaN(fix.lng) || (fix.lat === 0 && fix.lng === 0)) return;
    const last = trail[trail.length - 1];
    if (!last) {
      trail.push(fix);
      return;
    }
    const moved = distanceMeters(last.lat, last.lng, fix.lat, fix.lng) || 0;
    // Update stationary point in place so traffic-light waits NEVER evict earlier moving trail points!
    if (moved < 10) {
      if ((fix.gpsMs ?? fix.ts) >= (last.gpsMs ?? last.ts)) {
        trail[trail.length - 1] = { ...last, gpsMs: fix.gpsMs ?? last.gpsMs, ts: Math.max(last.ts || 0, fix.ts || 0) };
      }
      return;
    }
    trail.push(fix);
    const refT = fix.gpsMs ?? fix.ts ?? now;
    while (trail.length > MAX_UNIT_TRAIL_POINTS) trail.shift();
    while (trail.length > 2 && refT - (trail[0].gpsMs ?? trail[0].ts ?? refT) > UNIT_TRAIL_MAX_AGE_MS) {
      trail.shift();
    }
  };

  if (!hist || !hist.latest) {
    // Cold-start hydration from central FleetMemory (multi-point trail + server-persisted confirmed direction)
    const initTrail = [];
    let memPrev = null;
    let initConfirmedDir = null;

    if (coche && Array.isArray(state.fleetMemory?.units)) {
      const memUnit = state.fleetMemory.units.find(
        (u) => Number(u.codigoLinea) === Number(codLinea) && String(u.coche || '').trim() === coche
      );
      if (memUnit) {
        const refMs = gpsMs ?? now;
        const serverTrail = Array.isArray(memUnit.gpsTrail) ? memUnit.gpsTrail : [];
        for (const pt of serverTrail) {
          const pLat = Number(Array.isArray(pt) ? pt[0] : pt?.lat);
          const pLng = Number(Array.isArray(pt) ? pt[1] : pt?.lng);
          const pMs = Number(Array.isArray(pt) ? pt[2] : pt?.gpsMs) || null;
          if (!Number.isFinite(pLat) || !Number.isFinite(pLng) || (pLat === 0 && pLng === 0)) continue;
          if (pMs && refMs - pMs > UNIT_TRAIL_MAX_AGE_MS) continue;
          if (pMs && gpsMs && pMs >= gpsMs - 2000) continue;
          pushToTrail(initTrail, { lat: pLat, lng: pLng, gpsMs: pMs, ts: pMs || memUnit.updatedAt || now });
        }

        // Fallback single point if server doesn't have gpsTrail yet
        if (initTrail.length === 0 && typeof memUnit.lat === 'number' && typeof memUnit.lng === 'number') {
          const mMs = parseGpsTimestampMs(memUnit.ultimaGps);
          if (mMs && gpsMs && gpsMs - mMs >= 4000 && gpsMs - mMs <= UNIT_TRAIL_MAX_AGE_MS) {
            pushToTrail(initTrail, { lat: memUnit.lat, lng: memUnit.lng, gpsMs: mMs, ts: memUnit.updatedAt || mMs });
          }
        }

        if (initTrail.length > 0) {
          const lastServer = initTrail[initTrail.length - 1];
          const ageSec = gpsMs && lastServer.gpsMs ? (gpsMs - lastServer.gpsMs) / 1000 : 30;
          if (ageSec >= 3 && ageSec <= 180) memPrev = lastServer;
        }

        if (memUnit.dirBandera && memUnit.updatedAt && now - memUnit.updatedAt <= 8 * 60 * 1000) {
          initConfirmedDir = {
            bandera: String(memUnit.dirBandera).trim(),
            confidence: 0.72,
            gpsMs: parseGpsTimestampMs(memUnit.ultimaGps),
            ts: memUnit.updatedAt,
            fromServer: true
          };
        }
      }
    }

    pushToTrail(initTrail, curFix);
    const prevMovingCand =
      initTrail.length >= 2 ? initTrail[initTrail.length - 2] : memPrev;
    const movedMem = prevMovingCand ? distanceMeters(prevMovingCand.lat, prevMovingCand.lng, lat, lng) || 0 : 0;

    hist = {
      latest: curFix,
      prev: memPrev,
      prevMoving: prevMovingCand && movedMem >= 20 ? prevMovingCand : null,
      trail: initTrail,
      confirmedDir: initConfirmedDir
    };
    state.lastRealGpsByUnit.set(baseId, hist);
  } else {
    if (!Array.isArray(hist.trail)) hist.trail = [hist.latest];
    const movedFromLatest = distanceMeters(hist.latest.lat, hist.latest.lng, lat, lng) || 0;
    const gpsDeltaSec =
      gpsMs !== null && hist.latest.gpsMs !== null ? (gpsMs - hist.latest.gpsMs) / 1000 : null;
    const isNewerFix =
      (gpsDeltaSec !== null && gpsDeltaSec >= 3) ||
      (gpsDeltaSec === null && movedFromLatest >= 10);

    if (isNewerFix) {
      hist.prev = hist.latest;
      if (movedFromLatest >= 20) {
        hist.prevMoving = hist.latest;
      }
      hist.latest = curFix;
      pushToTrail(hist.trail, curFix);
    } else if (gpsDeltaSec === null || gpsDeltaSec >= -2) {
      hist.latest.ts = now;
      if (hist.trail.length > 0) hist.trail[hist.trail.length - 1].ts = now;
    }
  }

  // Continuously update confirmed direction relative to the line's route polylines from the multi-point trail
  const branches = state.routeBranchesCache.get(Number(codLinea)) || [];
  if (branches.length > 0) {
    const dir = resolveTrailDirection(hist, branches, { currentFix: curFix });
    if (dir && dir.source === 'trail' && dir.bandera) {
      hist.confirmedDir = {
        bandera: dir.bandera,
        branchIndex: dir.index,
        confidence: dir.confidence,
        along: dir.along,
        gpsMs,
        ts: now,
        fromServer: false
      };
    } else if (!dir && hist.confirmedDir) {
      // Clear stale/completed confirmed direction once bus reaches terminal or ages out
      hist.confirmedDir = null;
    }
  }

  const candHeading = hist.prevMoving || hist.prev;
  const headingPrevFix =
    candHeading && (distanceMeters(candHeading.lat, candHeading.lng, lat, lng) || 0) >= 20
      ? candHeading
      : null;

  const prevGpsFix =
    hist.prev && (hist.prev.gpsMs === null || gpsMs === null || hist.prev.gpsMs < gpsMs - 2000)
      ? hist.prev
      : null;

  return { headingPrevFix, prevGpsFix, gpsHist: hist, confirmedDir: hist.confirmedDir || null };
}

function normalizeArrivals(rawList, stopId, stopCoords) {
  const seenCounts = new Map();
  const primaryRouteByBaseId = new Map();
  const now = Date.now();

  // Sort by ascending ETA first so the 1st occurrence (`occ === 1`) of any coche is ALWAYS its earliest arrival,
  // and any subsequent occurrence (`occ > 1`) is cleanly linked as `Sig. vuelta`!
  const sortedRaw = [...(rawList || [])].sort(
    (a, b) => (parseEtaMinutes(a.tiempoRestanteArribo).minutes ?? 999) - (parseEtaMinutes(b.tiempoRestanteArribo).minutes ?? 999)
  );

  return sortedRaw.map((a) => {
    const lineName = (a.descripcionLinea || '').trim() || `L${a.codigoLinea}`;
    const coche = String(a.identificadorCoche || '').trim();
    const baseId = coche ? `${a.codigoLinea}-c${coche}` : `${a.codigoLinea}-${lineName}`;
    const occ = (seenCounts.get(baseId) || 0) + 1;
    seenCounts.set(baseId, occ);
    const key = occ > 1 ? `${baseId}-${occ}` : baseId;
    const isLiveNextLap = Boolean(coche && occ > 1);

    const lat = parseFloat(a.latitud);
    const lng = parseFloat(a.longitud);
    const validPos = !Number.isNaN(lat) && !Number.isNaN(lng) && lat !== 0 && lng !== 0;

    const eta = parseEtaMinutes(a.tiempoRestanteArribo);
    const straightDist =
      validPos && stopCoords ? distanceMeters(lat, lng, stopCoords.lat, stopCoords.lng) : null;
    const desvio = parseDesvioHorario(a.desvioHorario);
    const chofer = parseChoferInfo(a.identificadorChofer, a.choferNombre, a.choferLegajo);
    const gpsRaw = String(a.ultimaFechaHoraGPS || '').trim();
    const gpsTimeOnly = formatGpsTimeOnly(gpsRaw);
    const gpsMs = parseGpsTimestampMs(gpsRaw);

    let headingPrevFix = null;
    let prevGpsFix = null;
    let gpsHist = null;
    let confirmedDir = null;
    if (validPos && !isLiveNextLap) {
      const rec = recordUnitGpsFix(baseId, a.codigoLinea, coche, lat, lng, gpsRaw, now);
      headingPrevFix = rec.headingPrevFix;
      prevGpsFix = rec.prevGpsFix;
      gpsHist = rec.gpsHist;
      confirmedDir = rec.confirmedDir;
    } else if (validPos) {
      const hist = state.lastRealGpsByUnit.get(baseId);
      headingPrevFix = hist?.prevMoving || hist?.prev || null;
      prevGpsFix = hist?.prev || null;
      gpsHist = hist || null;
      confirmedDir = hist?.confirmedDir || null;
    }

    const branches = state.routeBranchesCache.get(a.codigoLinea) || [];

    const draftBus = {
      lat: validPos ? lat : null,
      lng: validPos ? lng : null,
      gpsMs,
      descripcionBandera: (a.descripcionBandera || a.descripcionCortaBandera || 'Servicio urbano').trim(),
      eta
    };

    const trajectory =
      validPos && stopCoords
        ? resolveBusTrajectory(draftBus, stopId, stopCoords, branches, gpsHist || headingPrevFix)
        : null;

    const routeMeters = trajectory ? trajectory.totalMeters : straightDist;
    if (!isLiveNextLap && typeof routeMeters === 'number') {
      primaryRouteByBaseId.set(baseId, routeMeters);
    }
    const primaryRem = primaryRouteByBaseId.get(baseId);
    const nextLapExtraMeters =
      isLiveNextLap && typeof routeMeters === 'number' && typeof primaryRem === 'number'
        ? Math.max(0, routeMeters - primaryRem)
        : 0;
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
      serviceNumber: null,
      lapNumber: null,
      isCortadoBlock: false,
      nextLapStopTime: null,
      lat: validPos ? lat : null,
      lng: validPos ? lng : null,
      prevGpsFix,
      confirmedDirectionBandera: trajectory?.confirmedDirectionBandera || confirmedDir?.bandera || '',
      directionSource: trajectory?.directionSource || (confirmedDir ? 'persisted' : 'eta'),
      distanceMeters: straightDist,
      routeMeters,
      proximityPct: computeProximityPercent(eta.minutes, routeMeters),
      identificadorCoche: coche,
      choferNombre: chofer.nombre,
      choferLegajo: chofer.legajo,
      choferRaw: chofer.raw,
      desvio,
      ultimaFechaHoraGPS: gpsRaw,
      gpsTimeOnly,
      trajectory,
      isPredicted: false,
      isNextLap: isLiveNextLap,
      nextLapOfKey: isLiveNextLap ? baseId : null,
      nextLapSourceLive: isLiveNextLap,
      nextLapExtraMeters,
      isOppositeLeg: Boolean(trajectory?.isOppositeLeg),
      isNextCycle: Boolean(trajectory?.isNextCycle || isLiveNextLap),
      realBandera: trajectory?.realBandera || draftBus.descripcionBandera,
      realBanderaColor: trajectory?.realBanderaColor || getLineColor(lineName)
    };
  });
}

// Smooth ~20fps kinematic simulation loop (zero DOM rebuilds, zero querySelector scans, pauses during map pan!)
function syncSimCardsDom() {
  if (!state.horariosOpen && arrivalRowCache.size > 0) {
    for (let i = 0; i < state.arribos.length; i++) {
      const bus = state.arribos[i];
      const row = arrivalRowCache.get(bus.key);
      if (!row || !row._refs) continue;
      const r = row._refs;

      const etaDisp = bus.eta.display;
      const etaUnit = bus.eta.unit || 'aprox';
      const etaCls = `eta-block eta-${bus.eta.urgency}`;
      const etaChanged = r.etaVal.textContent !== etaDisp;
      if (etaChanged) r.etaVal.textContent = etaDisp;
      if (r.etaUnit.textContent !== etaUnit) r.etaUnit.textContent = etaUnit;
      if (r.etaBlock.className !== etaCls) r.etaBlock.className = etaCls;

      const distMeters = bus.routeMeters ?? bus.distanceMeters;
      if (distMeters !== null && distMeters !== undefined) {
        const distTxt = `${formatDistance(distMeters)} · ${formatBlocks(distMeters)} c.`;
        if (r.distVal.textContent !== distTxt) r.distVal.textContent = distTxt;
      }

      if (bus.realBandera && r.banderaTxt.textContent !== bus.realBandera) {
        r.banderaTxt.textContent = bus.realBandera;
        r.banderaWrap.title = bus.realBandera;
      }
      if (bus.realBanderaColor && r.lastDirColor !== bus.realBanderaColor) {
        r.banderaDot.style.background = bus.realBanderaColor;
        r.lastDirColor = bus.realBanderaColor;
      }
      if (etaChanged && r.mainBtn) {
        const spoken = buildArrivalAriaLabel(bus);
        if (r.lastAriaLabel !== spoken) {
          r.mainBtn.setAttribute('aria-label', spoken);
          r.lastAriaLabel = spoken;
        }
      }
    }
  }

  if (state.inspectorOpen && state.selectedBusKey) {
    const focused = state.arribos.find((b) => b.key === state.selectedBusKey);
    if (focused) updateInspectorFields(focused);
  }
}

function startSimLoop() {
  if (simRafId !== null) return;
  simLastFrameMs = performance.now();
  simLastDomMs = simLastFrameMs;

  const frame = (now) => {
    const hasStopWork = Boolean(state.activeStop && state.arribos.length > 0);
    const hasCityWork = Boolean(state.allFleetMode && state.allFleetBuses.length > 0);
    if (!state.simulateMode || (!state.activeStop && !state.allFleetMode)) {
      simRafId = null;
      return;
    }
    const elapsedMs = now - simLastFrameMs;
    // Target ~20fps (50ms interval) for silky motion with minimal mobile CPU/battery
    if (elapsedMs >= 50 && (hasStopWork || hasCityWork)) {
      const dtSec = Math.min(0.15, elapsedMs / 1000);
      simLastFrameMs = now;

      const shouldSyncDom = now - simLastDomMs >= 1000;
      if (hasStopWork) {
        busSimulator.step(dtSec, state.arribos, { updateEta: shouldSyncDom });
        if (!transitMap.isInteracting) {
          transitMap.moveBusPositionsFast(state.arribos);
        }
      }
      if (hasCityWork) {
        stepCityFleetSim(dtSec);
        if (!transitMap.isInteracting) {
          transitMap.moveAllFleetPositionsFast(state.allFleetBuses);
        }
      }

      if (shouldSyncDom) {
        simLastDomMs = now;
        if (hasStopWork) syncSimCardsDom();
      }
    }
    simRafId = requestAnimationFrame(frame);
  };

  simRafId = requestAnimationFrame(frame);
}

function stopSimLoop() {
  if (simRafId !== null) {
    cancelAnimationFrame(simRafId);
    simRafId = null;
  }
}

function renderLineFilters() {
  // Always keep every known line for this stop selectable in the strip (preserving horizontal scroll!)
  const lineEntries =
    state.stopLinesList.length > 0
      ? state.stopLinesList
      : Array.from(new Map(state.arribos.map((a) => [a.codigoLinea, { codigo: a.codigoLinea, descripcion: a.descripcionLinea }])).values());

  const sig = lineEntries.map((l) => `${l.codigo}:${l.descripcion}`).join('|');

  if (sig !== filterStripSig || el.lineFilterStrip.children.length === 0) {
    filterStripSig = sig;
    let html = `
      <button type="button" class="filter-chip" data-line="ALL" data-cod="000" aria-pressed="true" aria-label="Mostrar todas las líneas" style="--chip-color:#38bdf8">
        Todas
      </button>
    `;
    for (const item of lineEntries) {
      const line = item.descripcion;
      const color = getLineColor(line);
      html += `
        <button type="button" class="filter-chip" data-line="${escapeHtml(line)}" data-cod="${item.codigo}" aria-pressed="false" style="--chip-color:${color}">
          <span class="chip-dot" aria-hidden="true"></span>
          <span>${escapeHtml(line)}</span>
          <span class="chip-count"></span>
        </button>
      `;
    }
    el.lineFilterStrip.innerHTML = html;
  }

  // Fast in-place count and active-state patch (zero innerHTML teardown, preserves scrollLeft)
  const countsByLine = new Map();
  for (const a of state.arribos) {
    countsByLine.set(a.descripcionLinea, (countsByLine.get(a.descripcionLinea) || 0) + 1);
  }

  const chips = el.lineFilterStrip.children;
  for (let i = 0; i < chips.length; i++) {
    const chip = chips[i];
    const line = chip.dataset.line;
    const isActive = state.filterLine === line;
    chip.classList.toggle('active', isActive);
    chip.setAttribute('aria-pressed', String(isActive));
    if (line === 'ALL') {
      chip.setAttribute(
        'aria-label',
        `Mostrar todas las líneas, ${state.arribos.length} ${state.arribos.length === 1 ? 'unidad' : 'unidades'}`
      );
    } else {
      const count = countsByLine.get(line) || 0;
      const countEl = chip.querySelector('.chip-count');
      if (countEl) {
        const txt = (isActive || state.filterLine === 'ALL') && count > 0 ? ` (${count})` : '';
        if (countEl.textContent !== txt) countEl.textContent = txt;
      }
      chip.setAttribute(
        'aria-label',
        `Filtrar línea ${line}${count > 0 ? `, ${count} ${count === 1 ? 'unidad' : 'unidades'}` : ''}`
      );
    }
  }
}

async function handleLineFilterClick(e) {
  const chip = e.target.closest('.filter-chip');
  if (!chip || !el.lineFilterStrip.contains(chip)) return;

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
    selectedBusKey: null,
    simulateMode: state.simulateMode
  });

  if (state.focusedLineCode) {
    showToast(`Buscando toda la flota activa de ${selectedLine}...`, 'info', 2000);
  } else {
    announce('Mostrando todas las líneas de esta parada.');
  }
  await fetchArribos(true, { announceSummary: true });
}

function buildArrivalAriaLabel(bus) {
  const parts = [];
  const currentBandera = bus.realBandera || bus.descripcionBandera;
  parts.push(`Línea ${bus.descripcionLinea}, hacia ${currentBandera}.`);

  if (bus.eta.minutes === 0) {
    parts.push('Arribando ahora.');
  } else if (bus.eta.valid !== false) {
    parts.push(`Llega en ${bus.eta.minutes === 1 ? '1 minuto' : `${bus.eta.minutes} minutos`}.`);
  }

  const distMeters = bus.routeMeters ?? bus.distanceMeters;
  if (distMeters !== null && distMeters !== undefined) {
    const blocks = formatBlocks(distMeters);
    parts.push(`A ${formatDistance(distMeters)}, ${blocks === 1 ? '1 cuadra' : `${blocks} cuadras`}.`);
  }

  if (bus.identificadorCoche) {
    parts.push(`Coche ${bus.identificadorCoche}.`);
  }

  if (bus.desvio && bus.desvio.status !== 'none') {
    if (bus.desvio.status === 'ontime' || bus.desvio.status === 'ok') {
      parts.push('En hora.');
    } else {
      const absMin = Math.round(Math.abs(bus.desvio.seconds || 0) / 60);
      const minText = absMin <= 1 ? '1 minuto' : `${absMin} minutos`;
      parts.push(bus.desvio.status === 'late' ? `Atrasado ${minText}.` : `Adelantado ${minText}.`);
    }
  }

  if (bus.turnoProgramado) {
    parts.push(`Horario programado ${bus.turnoProgramado}.`);
  }

  if (bus.serviceNumber) {
    const shiftLapsSpoken = bus.shiftLaps ? formatShiftLapsSpoken(bus.shiftLaps) : '';
    const lapSpoken = bus.lapNumber ? formatLapSpoken(bus.lapNumber) : '';
    const lapPhrase = lapSpoken
      ? `vuelta ${lapSpoken}${shiftLapsSpoken ? ` de ${shiftLapsSpoken} del turno` : ' del turno'}`
      : null;
    const srvDesc = [
      `Servicio ${bus.serviceNumber}`,
      bus.serviceTurnosCount > 1 ? `turno ${bus.turnoIndex || 1}` : null,
      lapPhrase,
      bus.isCortadoBlock
        ? 'horario cortado'
        : bus.isRelevoEnLinea
          ? 'relevo en línea'
          : null
    ]
      .filter(Boolean)
      .join(', ');
    parts.push(`${srvDesc}.`);
  }

  if (bus.nextLapStopTime) {
    parts.push(`Próxima vuelta a las ${bus.nextLapStopTime}.`);
  } else if (bus.serviceNumber && bus.isCortadoBlock) {
    parts.push('Última vuelta del turno cortado.');
  }

  if (bus.isNextLap) {
    parts.push('Siguiente vuelta de la misma unidad.');
  }
  if (bus.esAdaptado) {
    parts.push('Unidad adaptada para silla de ruedas.');
  }
  if (bus.choferNombre) {
    parts.push(`Chofer ${bus.choferNombre}.`);
  }

  const isOfflineStyled = (bus.isPredicted && !bus.nextLapSourceLive) || Boolean(bus.gpsLost);
  if (isOfflineStyled) {
    parts.push('Estimado por horario programado, sin señal GPS.');
  }

  return parts.join(' ');
}

function buildArrivalTagsHtml(bus) {
  const parts = [];
  if (bus.identificadorCoche) {
    parts.push(`<span class="coche-pill" title="Coche">${escapeHtml(bus.identificadorCoche)}</span>`);
  }
  if (bus.desvio && bus.desvio.status !== 'none') {
    parts.push(
      `<span class="desvio-pill desvio-${bus.desvio.status}" title="Desvío horario">${escapeHtml(bus.desvio.label)}</span>`
    );
  }
  if (bus.turnoProgramado) {
    parts.push(`<span class="turno-pill" title="Paso programado">${escapeHtml(bus.turnoProgramado)}</span>`);
  }
  if (bus.serviceNumber) {
    const lapTxt = bus.lapNumber ? formatLapNumber(bus.lapNumber) : '';
    const srvLabel = lapTxt ? `S${bus.serviceNumber}·V${lapTxt}` : `S${bus.serviceNumber}`;
    const turnoTag = bus.serviceTurnosCount > 1 ? ` · Turno ${bus.turnoIndex || 1}/${bus.serviceTurnosCount}` : '';
    const shiftLapsTxt = bus.shiftLaps ? ` (${formatShiftLaps(bus.shiftLaps)})` : '';
    const regimeTag = bus.isCortadoBlock
      ? 'Horario cortado'
      : bus.isRelevoEnLinea
        ? 'Relevo en línea'
        : 'Turno corrido';
    const srvTip = [
      `Servicio ${bus.serviceNumber}${turnoTag}${lapTxt ? ` · Vuelta ${lapTxt} del turno` : ''}${shiftLapsTxt}`,
      regimeTag,
      bus.nextLapStopTime ? `Sig. vuelta: ${bus.nextLapStopTime}` : null
    ]
      .filter(Boolean)
      .join(' · ');
    parts.push(`<span class="service-pill" title="${escapeHtml(srvTip)}">${escapeHtml(srvLabel)}</span>`);
  }
  if (bus.isNextLap) {
    parts.push(`<span class="next-lap-pill" title="Misma unidad en su siguiente vuelta">Sig. vuelta</span>`);
  }
  if (bus.esAdaptado) {
    parts.push(`<span class="adapted-icon-badge" title="Unidad adaptada">♿</span>`);
  }
  if (bus.esExtendido) {
    parts.push(
      `<span class="extended-pill" title="Detectado en parada previa (${escapeHtml(bus.viaParada || '')})">+Flota</span>`
    );
  }
  return parts.join('');
}

function createArrivalRow(bus) {
  const row = document.createElement('div');
  row.className = 'arrival-row';
  row.dataset.busKey = bus.key;
  row.setAttribute('role', 'listitem');

  // Non-nested accessible layout: main arrival button + sibling alert toggle button
  row.innerHTML = `
    <button type="button" class="arrival-row-main">
      <div class="arrival-row-top" aria-hidden="true">
        <div class="line-plate"></div>
        <div class="arrival-info">
          <div class="arrival-bandera">
            <span class="dir-dot"></span>
            <span class="arrival-bandera-txt"></span>
          </div>
          <div class="arrival-tags-row"></div>
        </div>
        <div class="eta-block">
          <span class="eta-value"></span>
          <span class="eta-unit"></span>
        </div>
      </div>
      <div class="arrival-row-foot" aria-hidden="true">
        <span class="driver-inline"></span>
        <span class="arrival-foot-right">
          <span class="arrival-dist-val"></span>
          <span class="arrival-gps-val"></span>
        </span>
      </div>
    </button>
    <button type="button" class="alert-bell-btn" aria-pressed="false">
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true" focusable="false">
        <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/>
        <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
      </svg>
    </button>
  `;

  row._refs = {
    mainBtn: row.querySelector('.arrival-row-main'),
    linePlate: row.querySelector('.line-plate'),
    banderaWrap: row.querySelector('.arrival-bandera'),
    banderaDot: row.querySelector('.dir-dot'),
    banderaTxt: row.querySelector('.arrival-bandera-txt'),
    tagsRow: row.querySelector('.arrival-tags-row'),
    etaBlock: row.querySelector('.eta-block'),
    etaVal: row.querySelector('.eta-value'),
    etaUnit: row.querySelector('.eta-unit'),
    alertBtn: row.querySelector('.alert-bell-btn'),
    alertSvg: row.querySelector('.alert-bell-btn svg'),
    driverInline: row.querySelector('.driver-inline'),
    distVal: row.querySelector('.arrival-dist-val'),
    gpsVal: row.querySelector('.arrival-gps-val'),
    lastColor: '',
    lastDirColor: '',
    lastTagsSig: '',
    lastDriverSig: '',
    lastGpsSig: '',
    lastAriaLabel: ''
  };

  return row;
}

function patchArrivalRow(row, bus) {
  const r = row._refs;
  const color = getLineColor(bus.descripcionLinea);
  const isSelected = bus.key === state.selectedBusKey;
  const isArmed = state.armedAlerts.has(bus.descripcionLinea);
  const isOfflineStyled = (bus.isPredicted && !bus.nextLapSourceLive) || Boolean(bus.gpsLost);

  row.classList.toggle('is-selected', isSelected);
  row.classList.toggle('is-predicted', isOfflineStyled);

  if (r.lastColor !== color) {
    row.style.setProperty('--line-color', color);
    r.lastColor = color;
  }
  if (r.linePlate.textContent !== bus.descripcionLinea) {
    r.linePlate.textContent = bus.descripcionLinea;
  }

  const currentBandera = bus.realBandera || bus.descripcionBandera;
  const dirColor = bus.realBanderaColor || color;
  if (r.banderaTxt.textContent !== currentBandera) {
    r.banderaTxt.textContent = currentBandera;
    r.banderaWrap.title = currentBandera;
  }
  if (r.lastDirColor !== dirColor) {
    r.banderaDot.style.background = dirColor;
    r.lastDirColor = dirColor;
  }

  const tagsSig = `${bus.identificadorCoche}|${bus.desvio?.status || ''}:${bus.desvio?.label || ''}|${bus.turnoProgramado || ''}|${bus.serviceNumber || ''}:${bus.lapNumber || ''}:${bus.isCortadoBlock ? 1 : 0}:${bus.nextLapStopTime || ''}|${bus.isNextLap ? 1 : 0}|${bus.esAdaptado ? 1 : 0}|${bus.esExtendido ? 1 : 0}:${bus.viaParada || ''}`;
  if (r.lastTagsSig !== tagsSig) {
    r.tagsRow.innerHTML = buildArrivalTagsHtml(bus);
    r.lastTagsSig = tagsSig;
  }

  const etaCls = `eta-block eta-${bus.eta.urgency}`;
  const etaDisp = bus.eta.display;
  const etaUnit = bus.eta.unit || 'aprox';
  if (r.etaBlock.className !== etaCls) r.etaBlock.className = etaCls;
  if (r.etaVal.textContent !== etaDisp) r.etaVal.textContent = etaDisp;
  if (r.etaUnit.textContent !== etaUnit) r.etaUnit.textContent = etaUnit;

  r.alertBtn.dataset.alertLine = bus.descripcionLinea;
  r.alertBtn.classList.toggle('is-armed', isArmed);
  r.alertBtn.setAttribute('aria-pressed', String(isArmed));
  const alertDesc = isArmed
    ? `Desactivar aviso de arribo para línea ${bus.descripcionLinea}`
    : `Activar aviso sonoro para línea ${bus.descripcionLinea} cuando falten 3 minutos o menos`;
  r.alertBtn.title = alertDesc;
  r.alertBtn.setAttribute('aria-label', alertDesc);
  r.alertSvg.setAttribute('fill', isArmed ? 'currentColor' : 'none');

  const driverSig = `${bus.choferNombre || ''}|${bus.choferLegajo || ''}`;
  if (r.lastDriverSig !== driverSig) {
    r.driverInline.innerHTML = bus.choferNombre
      ? `<strong>${escapeHtml(bus.choferNombre)}</strong>${
          bus.choferLegajo ? `<span class="legajo-chip">${escapeHtml(bus.choferLegajo)}</span>` : ''
        }`
      : '<span>—</span>';
    r.lastDriverSig = driverSig;
  }

  const distMeters = bus.routeMeters ?? bus.distanceMeters;
  const distTxt =
    distMeters !== null && distMeters !== undefined
      ? `${formatDistance(distMeters)} · ${formatBlocks(distMeters)} c.`
      : '';
  if (r.distVal.textContent !== distTxt) r.distVal.textContent = distTxt;

  const gpsSig = `${isOfflineStyled ? 1 : 0}|${bus.gpsTimeOnly || ''}`;
  if (r.lastGpsSig !== gpsSig) {
    if (isOfflineStyled) {
      r.gpsVal.className = 'arrival-gps-val pred-meta';
      r.gpsVal.title = 'Posición estimada por horarios programados';
      r.gpsVal.textContent = bus.gpsTimeOnly ? `Sin GPS · ${bus.gpsTimeOnly}` : 'Est. horario';
    } else if (bus.gpsTimeOnly) {
      r.gpsVal.className = 'arrival-gps-val';
      r.gpsVal.title = 'Último reporte GPS';
      r.gpsVal.textContent = bus.gpsTimeOnly;
    } else {
      r.gpsVal.className = 'arrival-gps-val';
      r.gpsVal.title = '';
      r.gpsVal.textContent = '';
    }
    r.lastGpsSig = gpsSig;
  }

  const spoken = buildArrivalAriaLabel(bus);
  if (r.lastAriaLabel !== spoken) {
    r.mainBtn.setAttribute('aria-label', spoken);
    r.lastAriaLabel = spoken;
  }
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
    arrivalRowCache.clear();
    el.arribosList.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon" aria-hidden="true">◎</div>
        <h3>Sin unidades reportando arribos</h3>
        <p>En este momento no hay colectivos en camino hacia <strong>${escapeHtml(
          state.activeStop.id
        )}</strong>. Podés consultar los <strong>Horarios 24h</strong> programados arriba.</p>
      </div>
    `;
    return;
  }

  // Remove any non-row placeholder (welcome, skeleton, empty state) before keyed reconciliation
  if (el.arribosList.firstElementChild && !el.arribosList.firstElementChild.classList.contains('arrival-row')) {
    el.arribosList.textContent = '';
    arrivalRowCache.clear();
  }

  const activeKeys = new Set();
  for (let i = 0; i < visible.length; i++) {
    const bus = visible[i];
    activeKeys.add(bus.key);
    let row = arrivalRowCache.get(bus.key);
    if (!row) {
      row = createArrivalRow(bus);
      arrivalRowCache.set(bus.key, row);
    }
    patchArrivalRow(row, bus);

    const currentAtIdx = el.arribosList.children[i];
    if (currentAtIdx !== row) {
      el.arribosList.insertBefore(row, currentAtIdx || null);
    }
  }

  // Prune rows no longer present
  for (const [key, row] of arrivalRowCache.entries()) {
    if (!activeKeys.has(key)) {
      row.remove();
      arrivalRowCache.delete(key);
    }
  }
}

function handleArribosListClick(e) {
  const bellBtn = e.target.closest('.alert-bell-btn');
  if (bellBtn && el.arribosList.contains(bellBtn)) {
    e.stopPropagation();
    const line = bellBtn.dataset.alertLine;
    if (!line) return;
    if (state.armedAlerts.has(line)) {
      state.armedAlerts.delete(line);
      state.triggeredAlerts.delete(line);
      showToast(`Alerta desactivada para línea ${line}`, 'info');
      haptic('light');
    } else {
      state.armedAlerts.add(line);
      state.triggeredAlerts.delete(line);
      if (state.soundEnabled) playSubtleTick();
      haptic('medium');
      showToast(`Aviso activado para línea ${line} cuando falten 3 minutos o menos`, 'success');
      ensureNotificationPermission().then((ok) => {
        if (!ok && isNative) {
          showToast('Activá las notificaciones de DIRECT GPS para recibir el aviso con la pantalla apagada', 'warn', 4500);
        }
      });
    }
    syncKeepAwake();
    renderArribosList();
    return;
  }

  const mainBtn = e.target.closest('.arrival-row-main');
  const row = mainBtn ? mainBtn.closest('.arrival-row') : null;
  if (row && el.arribosList.contains(row)) {
    focusBusOnMap(row.dataset.busKey);
  }
}

// Keep the screen on while the user is waiting for an armed arrival alert at an open stop
function syncKeepAwake() {
  setKeepAwake(Boolean(state.activeStop) && state.armedAlerts.size > 0);
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
      const cocheTag = bus.identificadorCoche ? `, coche ${bus.identificadorCoche}` : '';
      const etaTxt = bus.eta.minutes === 0 ? 'arribando ahora' : `a ${bus.eta.minutes} ${bus.eta.minutes === 1 ? 'minuto' : 'minutos'}`;
      const msg = `Atención: Línea ${bus.descripcionLinea}${cocheTag}, ${etaTxt}.`;
      showToast(msg, 'success', 6000, { silent: true });
      announce(msg, { assertive: true });
      notifyArrival({
        title: `Línea ${bus.descripcionLinea} llegando a ${state.activeStop.id}`,
        body: `${bus.tiempoRaw || `${bus.eta.minutes} min`}${cocheTag} · ${state.activeStop.nombre || 'Tu parada'}`,
        stopId: state.activeStop.id
      });
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

  if (el.inspServicePill) {
    if (bus.serviceNumber) {
      const lapTxt = bus.lapNumber ? formatLapNumber(bus.lapNumber) : '';
      const shiftLapsTxt = bus.shiftLaps ? ` (${formatShiftLaps(bus.shiftLaps)})` : '';
      el.inspServicePill.textContent = lapTxt
        ? `Srv ${bus.serviceNumber} · Vta ${lapTxt}`
        : `Srv ${bus.serviceNumber}`;
      const regimeDesc = bus.isCortadoBlock
        ? 'Horario cortado'
        : bus.isRelevoEnLinea
          ? 'Relevo en línea'
          : bus.serviceTurnosCount > 1
            ? `Turno ${bus.turnoIndex || 1} de ${bus.serviceTurnosCount}`
            : 'Turno corrido';
      el.inspServicePill.title = `Rotación estimada · ${regimeDesc}${shiftLapsTxt}`;
      el.inspServicePill.classList.remove('hidden');
    } else {
      el.inspServicePill.classList.add('hidden');
    }
  }

  el.inspAccessBadge.classList.toggle('hidden', !bus.esAdaptado);

  const etaLabelEl = el.inspEta?.closest('.insp-metric')?.querySelector('.insp-metric-label');
  const distLabelEl = el.inspDist?.closest('.insp-metric')?.querySelector('.insp-metric-label');

  if (bus.isFreeTracked) {
    if (etaLabelEl) etaLabelEl.textContent = 'Horario servicio';
    if (distLabelEl) distLabelEl.textContent = 'Estado · Vuelta';
    const schedSpan = bus.serviceSpan || (bus.turnoStart && bus.turnoEnd ? `${bus.turnoStart}–${bus.turnoEnd}` : '—');
    el.inspEta.textContent = schedSpan;
    const lapPart = bus.lapNumber
      ? `Vta ${formatLapNumber(bus.lapNumber)}${bus.shiftLaps ? `/${formatLapNumber(bus.shiftLaps)}` : ''}`
      : bus.shiftLaps
        ? formatShiftLaps(bus.shiftLaps)
        : '';
    el.inspDist.textContent = bus.enLineaAhora ? 'En línea' : 'Últ. posición';
    el.inspBlocks.textContent = lapPart || (bus.serviceNumber ? `Srv ${bus.serviceNumber}` : 'GPS');
  } else {
    if (etaLabelEl) etaLabelEl.textContent = 'Arribo';
    if (distLabelEl) distLabelEl.textContent = 'Distancia';
    const distMeters = bus.routeMeters ?? bus.distanceMeters;
    el.inspEta.textContent = bus.eta.minutes === 0 ? 'Arribando' : `${bus.eta.display} min`;
    el.inspDist.textContent = formatDistance(distMeters);
    el.inspBlocks.textContent = `${formatBlocks(distMeters)} c.`;
  }

  el.inspChofer.textContent = bus.choferNombre || '—';
  if (bus.choferLegajo) {
    el.inspLegajo.textContent = bus.choferLegajo;
    el.inspLegajo.classList.remove('hidden');
  } else {
    el.inspLegajo.classList.add('hidden');
  }

  if (el.inspNextLapCell && el.inspNextLap) {
    const nextLapLabelEl = el.inspNextLapCell.querySelector('.insp-metric-label');
    const serviceSpan =
      bus.serviceSpan ||
      (bus.scheduledTrip?.blockInfo
        ? `${formatSecHHMM(bus.scheduledTrip.blockInfo.startSec)}–${formatSecHHMM(bus.scheduledTrip.blockInfo.endSec)}`
        : '');
    if (bus.isFreeTracked) {
      el.inspNextLapCell.classList.add('hidden');
      const driverCell = el.inspChofer.closest('.insp-metric');
      if (driverCell) driverCell.style.gridColumn = '1 / -1';
    } else {
      const showNextLap = Boolean(bus.nextLapStopTime || serviceSpan || (bus.serviceNumber && bus.isCortadoBlock));
      if (showNextLap) {
        if (nextLapLabelEl) nextLapLabelEl.textContent = bus.nextLapStopTime ? 'Sig. vuelta' : 'Turno';
        el.inspNextLap.textContent = bus.nextLapStopTime || serviceSpan || 'Fin turno (cortado)';
        el.inspNextLapCell.classList.remove('hidden');
      } else {
        el.inspNextLapCell.classList.add('hidden');
      }
      const driverCell = el.inspChofer.closest('.insp-metric');
      if (driverCell) {
        driverCell.style.gridColumn = showNextLap ? '' : '1 / -1';
      }
    }
  }

  const gpsParts = [];
  const isOfflineStyled = (bus.isPredicted && !bus.nextLapSourceLive) || Boolean(bus.gpsLost);
  if (bus.isFreeTracked) {
    if (bus.enLineaAhora) gpsParts.push('Seguimiento en vivo');
    else gpsParts.push('Última ubicación conocida');
    if (bus.gpsTimeOnly) gpsParts.push(`GPS ${bus.gpsTimeOnly}`);
    else if (bus.lastSeenLabel) gpsParts.push(bus.lastSeenLabel);
  } else if (isOfflineStyled) {
    gpsParts.push(bus.gpsTimeOnly ? `Sin GPS · ${bus.gpsTimeOnly}` : 'Est. horario');
  } else {
    if (bus.gpsTimeOnly) gpsParts.push(bus.gpsTimeOnly);
    if (bus.esExtendido) gpsParts.push('+Flota');
  }
  el.inspGps.textContent = gpsParts.join(' · ') || '—';

  el.btnInspRoute.dataset.codLinea = bus.codigoLinea;
  el.btnInspRoute.dataset.lineName = bus.descripcionLinea;
  if (el.btnInspTrack) {
    const showTrackBtn = Boolean(bus.isCityFleet);
    el.btnInspTrack.classList.toggle('hidden', !showTrackBtn);
    el.btnInspTrack.dataset.busKey = bus.key || '';
  }
}

// Tapping an arrival row in the dock: pan & zoom visually on map + announce concise summary for screen readers
function focusBusOnMap(busKey) {
  const bus = state.arribos.find((b) => b.key === busKey);
  if (!bus) return;
  const mapTarget =
    bus.isNextLap && bus.nextLapOfKey
      ? state.arribos.find((b) => b.key === bus.nextLapOfKey) || bus
      : bus;

  state.selectedBusKey = mapTarget.key;
  state.inspectorOpen = false;
  el.busInspector.classList.add('hidden');

  // If mobile bottom panel is expanded, return to 50/50 split so the map is clearly visible
  if (state.dockExpanded) {
    setSheetIndex(1, { silent: true });
  }
  haptic('light');

  if (!state.horariosOpen) renderArribosList();
  transitMap.updateBuses(state.arribos, {
    filterLine: state.filterLine,
    selectedBusKey: state.selectedBusKey,
    simulateMode: state.simulateMode
  });
  transitMap.focusBus(mapTarget, 16);
  announce(`Seleccionado: ${buildArrivalAriaLabel(bus)}`);
}

// Tapping a bus chip directly on the map: open the ultra-compact inspector card
function openBusInspector(busKey) {
  const trackedPool = state.trackedUnit?.buses || [];
  const bus =
    state.arribos.find((b) => b.key === busKey) ||
    trackedPool.find((b) => b.key === busKey) ||
    (state.trackedUnit?.bus?.key === busKey ? state.trackedUnit.bus : null) ||
    state.allFleetBuses.find((b) => b.key === busKey) ||
    null;
  if (!bus) {
    closeBusInspector();
    return;
  }

  state.selectedBusKey = busKey;
  state.inspectorOpen = true;
  if (bus.isFreeTracked && state.trackedUnit) {
    state.trackedUnit.bus = bus;
    state.trackedUnit.coche = bus.identificadorCoche || state.trackedUnit.coche;
  }
  updateInspectorFields(bus);
  el.busInspector.classList.remove('hidden');
  if (!bus.isFreeTracked && !bus.isCityFleet && !state.horariosOpen) renderArribosList();
  const displayList = bus.isFreeTracked && trackedPool.length > 0 ? trackedPool : state.arribos;
  transitMap.updateBuses(displayList, {
    filterLine: bus.isFreeTracked ? 'ALL' : state.filterLine,
    selectedBusKey: state.selectedBusKey,
    simulateMode: state.simulateMode
  });
  if (state.allFleetMode) {
    transitMap.updateAllFleetBuses(state.allFleetBuses, { selectedBusKey: state.selectedBusKey });
  }
}

function stopTrackedUnit() {
  if (state.trackedUnit?.timerId) {
    clearInterval(state.trackedUnit.timerId);
  }
  state.trackedUnit = null;
}

function closeBusInspector() {
  const wasFreeTracked = Boolean(state.trackedUnit);
  stopTrackedUnit();
  state.inspectorOpen = false;
  state.selectedBusKey = null;
  el.busInspector.classList.add('hidden');
  transitMap.drawFocusVector(null);
  transitMap.updateBuses(state.arribos, {
    filterLine: state.filterLine,
    selectedBusKey: null,
    simulateMode: state.simulateMode
  });
  if (state.allFleetMode) {
    transitMap.updateAllFleetBuses(state.allFleetBuses, { selectedBusKey: null });
  }
  if (wasFreeTracked && !state.activeStop) {
    transitMap.clearRoutes();
  }
  if (state.activeStop && !state.horariosOpen) renderArribosList();
}

// ============================================================================
// Optional Citywide Circulating Fleet ("Todos los colectivos" across all lines)
// ============================================================================
function updateAllFleetButtonUi() {
  if (!el.btnAllBuses) return;
  el.btnAllBuses.setAttribute('aria-pressed', String(state.allFleetMode));
  el.btnAllBuses.classList.toggle('is-active', state.allFleetMode);
  el.btnAllBuses.classList.toggle('is-loading', state.allFleetLoading);
  if (el.allBusesCount) {
    const n = state.allFleetBuses.length;
    el.allBusesCount.textContent = String(n);
    el.allBusesCount.classList.toggle('hidden', !state.allFleetMode || n === 0);
  }
}

function buildCityFleetBusObject(u) {
  const numCod = Number(u.codigoLinea);
  const lineName =
    String(u.descripcionLinea || '').trim() ||
    state.lineas.find((l) => Number(l.codigo) === numCod)?.descripcion ||
    state.catalogo?.lineByCode?.get(numCod)?.descripcion ||
    `L${numCod}`;
  const coche = String(u.coche || u.identificadorCoche || '').trim();
  const parsedDesv =
    u.desvioRaw || u.desvioHorario
      ? parseDesvioHorario(u.desvioRaw || u.desvioHorario)
      : Number.isFinite(Number(u.desvioSec)) && Number(u.desvioSec) !== 0
        ? parseDesvioHorario(
            `${Number(u.desvioSec) >= 0 ? '+' : '-'}${String(Math.floor(Math.abs(Number(u.desvioSec)) / 60)).padStart(2, '0')}:${String(Math.abs(Number(u.desvioSec)) % 60).padStart(2, '0')}`
          )
        : { status: 'none', label: '', seconds: 0, raw: '' };
  const gpsRaw = String(u.ultimaGps || u.ultimaFechaHoraGPS || '').trim();
  const startHH = String(u.lastTurnoStart || '').trim();
  const endHH = String(u.lastTurnoEnd || '').trim();
  return {
    key: `city:${numCod}:${coche}`,
    codigoLinea: numCod,
    descripcionLinea: lineName,
    descripcionBandera: u.bandera || u.descripcionBandera || `Línea ${lineName}`,
    realBandera: u.bandera || u.descripcionBandera || `Línea ${lineName}`,
    realBanderaColor: getLineColor(lineName),
    identificadorCoche: coche,
    choferNombre: u.choferNombre || '',
    choferLegajo: u.choferLegajo || '',
    esAdaptado: Boolean(u.esAdaptado),
    desvio: parsedDesv,
    eta: { minutes: 0, display: '—' },
    distanceMeters: 0,
    routeMeters: 0,
    lat: Number(u.lat),
    lng: Number(u.lng),
    rawLat: Number(u.lat),
    rawLng: Number(u.lng),
    ultimaFechaHoraGPS: gpsRaw,
    gpsTimeOnly: formatGpsTimeOnly(gpsRaw),
    lastStopId: u.lastStopId || '',
    lastTripKey: u.lastTripKey || '',
    lastSeenAt: u.lastSeenAt || Date.now(),
    serviceNumber: Number(u.lastServiceNum) || null,
    turnoIndex: Number(u.lastTurnoIdx) || 1,
    serviceTurnosCount: 1,
    lapNumber: Number(u.lastLapNum) || null,
    shiftLaps: Number(u.lastShiftLaps) || null,
    turnoStart: startHH,
    turnoEnd: endHH,
    serviceSpan: startHH && endHH ? `${startHH}–${endHH}` : '',
    enLineaAhora: true,
    isFreeTracked: true,
    isCityFleet: true,
    isPredicted: false
  };
}

// Lightweight 20fps street-following kinematics for citywide Modo Libre (allFleetBuses)
const cityFleetSim = new Map(); // bus.key -> { branch, along, gpsAlong, maxAlong, speedMps, lastGpsMs, isStopped }

function pickCityBusBranch(bus, branches, confirmedDir) {
  if (!Array.isArray(branches) || branches.length === 0) return null;
  const lat = bus.rawLat ?? bus.lat;
  const lng = bus.rawLng ?? bus.lng;
  if (typeof lat !== 'number' || typeof lng !== 'number') return null;

  // 1) Confirmed multi-point GPS trail direction wins when bus is near that branch
  if (confirmedDir && typeof confirmedDir.branchIndex === 'number' && branches[confirmedDir.branchIndex]) {
    const cb = branches[confirmedDir.branchIndex];
    const cp = projectOnPolyline(cb.pts, cb.cum, lat, lng);
    if (cp && cp.perp <= 260) return { branch: cb, proj: cp };
  }

  // 2) Matched schedule trip branch
  if (bus._matchedBranch && branches.includes(bus._matchedBranch)) {
    const mp = projectOnPolyline(bus._matchedBranch.pts, bus._matchedBranch.cum, lat, lng);
    if (mp && mp.perp <= 260) return { branch: bus._matchedBranch, proj: mp };
  }

  // 3) Closest branch with bandera tie-breaker
  const normB = String(bus.realBandera || bus.descripcionBandera || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
  let best = null;
  let bestScore = Infinity;
  for (const b of branches) {
    const proj = projectOnPolyline(b.pts, b.cum, lat, lng);
    if (!proj || proj.perp > 320) continue;
    const bn = String(b.bandera || '')
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, ' ')
      .trim();
    const matchBand = normB && bn && (bn.includes(normB) || normB.includes(bn));
    const score = proj.perp + (normB && !matchBand ? 140 : 0);
    if (score < bestScore) {
      bestScore = score;
      best = { branch: b, proj };
    }
  }
  return best;
}

function reconcileCityFleetSim(buses = []) {
  const nowMs = Date.now();
  const seenKeys = new Set();

  for (const bus of buses) {
    const rawLat = typeof bus.rawLat === 'number' ? bus.rawLat : bus.lat;
    const rawLng = typeof bus.rawLng === 'number' ? bus.rawLng : bus.lng;
    if (typeof rawLat !== 'number' || typeof rawLng !== 'number') continue;
    seenKeys.add(bus.key);

    const baseId = `${bus.codigoLinea}-c${bus.identificadorCoche}`;
    const rec = recordUnitGpsFix(baseId, bus.codigoLinea, bus.identificadorCoche, rawLat, rawLng, bus.ultimaFechaHoraGPS, nowMs);
    const gpsMs = parseGpsTimestampMs(bus.ultimaFechaHoraGPS);
    const gpsAgeSec = gpsMs ? Math.max(0, (nowMs - gpsMs) / 1000) : 999;

    const branches = state.routeBranchesCache.get(bus.codigoLinea) || [];
    const picked = pickCityBusBranch(bus, branches, rec?.confirmedDir);
    if (!picked) {
      cityFleetSim.delete(bus.key);
      continue;
    }

    const { branch, proj } = picked;
    const gpsAlong = proj.along;
    const nearTerminal = gpsAlong <= 140 || (branch.totalLen || 0) - gpsAlong <= 140;

    // Learn real speed from penultimate -> latest GPS fix
    let speedMps = 5.4;
    let isStopped = gpsAgeSec > 180 || nearTerminal;
    const prevFix = rec?.prevGpsFix;
    if (!isStopped && prevFix && gpsMs && prevFix.gpsMs) {
      const dtPrev = (gpsMs - prevFix.gpsMs) / 1000;
      if (dtPrev >= 4 && dtPrev <= 180) {
        const moved = distanceMeters(prevFix.lat, prevFix.lng, rawLat, rawLng) ?? 0;
        if (moved < 16 && dtPrev >= 10) {
          isStopped = true;
          speedMps = 0;
        } else if (moved >= 16 && moved < Math.max(2000, dtPrev * 30)) {
          speedMps = Math.max(2.2, Math.min(18.5, (moved * 1.03) / dtPrev));
        }
      }
    }

    // Advance initial along slightly to account for small GPS reporting lag (capped at 22s)
    const initialLead = !isStopped && gpsAgeSec <= 45 ? Math.min(22, gpsAgeSec) * speedMps * 0.75 : 0;
    const targetAlong = Math.min(Math.max(0, branch.totalLen - 15), gpsAlong + initialLead);
    const maxAlong = isStopped
      ? gpsAlong
      : Math.min(Math.max(0, branch.totalLen - 15), gpsAlong + Math.max(180, speedMps * 42));

    const prevSim = cityFleetSim.get(bus.key);
    let curAlong = targetAlong;
    if (prevSim && prevSim.branch === branch) {
      const diff = targetAlong - prevSim.along;
      if (diff >= -220 && diff <= 420) {
        // Zero-backjump continuity: keep simulated position if slightly ahead, gently pull forward if behind
        curAlong = diff < 0 ? prevSim.along : prevSim.along + diff * 0.45;
      }
    }
    curAlong = Math.max(0, Math.min(branch.totalLen, curAlong));

    cityFleetSim.set(bus.key, {
      branch,
      along: curAlong,
      gpsAlong,
      targetAlong,
      maxAlong,
      speedMps: isStopped ? 0 : speedMps,
      lastGpsMs: gpsMs,
      isStopped
    });

    if (state.simulateMode) {
      const pt = sampleBranchAtAlong(branch, curAlong);
      if (pt) {
        bus.lat = pt.lat;
        bus.lng = pt.lng;
      }
    } else {
      bus.lat = rawLat;
      bus.lng = rawLng;
    }
  }

  for (const k of cityFleetSim.keys()) {
    if (!seenKeys.has(k)) cityFleetSim.delete(k);
  }
}

function stepCityFleetSim(dtSec) {
  if (!state.simulateMode || !state.allFleetMode) return;
  for (let i = 0; i < state.allFleetBuses.length; i++) {
    const bus = state.allFleetBuses[i];
    const sim = cityFleetSim.get(bus.key);
    if (!sim || sim.isStopped || sim.speedMps <= 0.1 || !sim.branch) continue;

    // Gentle speed bleed if slightly ahead of targetAlong, smooth catch-up if behind
    let effSpeed = sim.speedMps;
    if (sim.along > sim.targetAlong + 45) {
      effSpeed *= 0.45;
    } else if (sim.along < sim.targetAlong - 20) {
      effSpeed *= 1.35;
    }

    const nextAlong = Math.min(sim.maxAlong, sim.along + effSpeed * dtSec);
    if (nextAlong - sim.along < 0.08) continue;
    sim.along = nextAlong;
    const pt = sampleBranchAtAlong(sim.branch, sim.along);
    if (pt) {
      bus.lat = pt.lat;
      bus.lng = pt.lng;
      bus._posChanged = true;
    }
  }
}

let allFleetFetchSeq = 0;
async function refreshAllFleetBuses({ fit = false, silent = true } = {}) {
  if (!state.allFleetMode) return;
  const seq = ++allFleetFetchSeq;
  state.allFleetLoading = true;
  updateAllFleetButtonUi();
  try {
    const res = await api.flotaActiva({ live: true });
    if (!state.allFleetMode || seq !== allFleetFetchSeq) return;
    const rawUnits = Array.isArray(res?.data?.units) ? res.data.units : [];
    const byKey = new Map();
    for (const u of rawUnits) {
      if (!u.codigoLinea || !u.coche) continue;
      if (!Number.isFinite(Number(u.lat)) || !Number.isFinite(Number(u.lng))) continue;
      const obj = buildCityFleetBusObject(u);
      byKey.set(obj.key, obj);
    }
    // Also merge any fresh live buses currently seen at the active stop or corridor radar
    for (const b of [...(state.arribos || []), ...(state.corridorFleet || [])]) {
      if (b.isPredicted || b.gpsLost) continue;
      const cod = Number(b.codigoLinea);
      const coche = String(b.identificadorCoche || b.coche || '').trim();
      const la = typeof b.lat === 'number' ? b.lat : parseFloat(b.latitud);
      const ln = typeof b.lng === 'number' ? b.lng : parseFloat(b.longitud);
      if (!cod || !coche || Number.isNaN(la) || Number.isNaN(ln) || (la === 0 && ln === 0)) continue;
      const key = `city:${cod}:${coche}`;
      const existing = byKey.get(key);
      const bMs = parseGpsTimestampMs(b.ultimaFechaHoraGPS) || 0;
      const exMs = existing ? parseGpsTimestampMs(existing.ultimaFechaHoraGPS) || 0 : 0;
      if (!existing || bMs > exMs) {
        byKey.set(
          key,
          buildCityFleetBusObject({
            codigoLinea: cod,
            descripcionLinea: b.descripcionLinea,
            coche,
            choferNombre: b.choferNombre || existing?.choferNombre,
            choferLegajo: b.choferLegajo || existing?.choferLegajo,
            esAdaptado: b.esAdaptado || existing?.esAdaptado,
            bandera: b.realBandera || b.descripcionBandera || existing?.descripcionBandera,
            lat: la,
            lng: ln,
            desvioRaw: b.desvio?.raw || b.desvioHorario || existing?.desvio?.raw || '',
            desvioSec: b.desvio?.seconds || existing?.desvio?.seconds || 0,
            ultimaGps: b.ultimaFechaHoraGPS || existing?.ultimaFechaHoraGPS || ''
          })
        );
      }
    }

    // Enrich with cached immutable schedule models immediately when already loaded
    const nowSec = getArgentinaSecOfDay();
    const todayTipo = getArgentinaTodayTipo();
    const missingRouteLines = [];
    for (const bus of byKey.values()) {
      const branches = state.routeBranchesCache.get(bus.codigoLinea);
      if (!branches?.length && !missingRouteLines.includes(bus.codigoLinea)) {
        missingRouteLines.push(bus.codigoLinea);
      }
      const horFile = state.horariosArchiveCache.get(bus.codigoLinea);
      if (branches?.length && horFile) {
        const model = buildLineScheduleModel(bus.codigoLinea, branches, horFile, todayTipo);
        const meta = resolveUnitScheduleMeta(
          model,
          {
            lat: bus.rawLat,
            lng: bus.rawLng,
            bandera: bus.descripcionBandera,
            lastGps: bus.ultimaFechaHoraGPS,
            desvioSec: bus.desvio?.seconds || 0,
            desvioRaw: bus.desvio?.raw || '',
            lastSeenAt: bus.lastSeenAt,
            enLineaAhora: true
          },
          nowSec
        );
        if (meta) {
          bus._matchedBranch = meta.trip?.branch || null;
          bus.serviceNumber = meta.serviceNumber;
          bus.turnoIndex = meta.turnoIndex;
          bus.serviceTurnosCount = meta.serviceTurnosCount;
          bus.lapNumber = meta.lapNumber;
          bus.shiftLaps = meta.shiftLaps;
          bus.isCortadoBlock = meta.isCortado;
          bus.isRelevoEnLinea = meta.isRelevoEnLinea;
          bus.turnoStart = meta.startHHMM;
          bus.turnoEnd = meta.endHHMM;
          bus.serviceSpan = meta.startHHMM && meta.endHHMM ? `${meta.startHHMM}–${meta.endHHMM}` : '';
        }
      }
    }

    state.allFleetBuses = Array.from(byKey.values());
    reconcileCityFleetSim(state.allFleetBuses);
    transitMap.updateAllFleetBuses(state.allFleetBuses, { selectedBusKey: state.selectedBusKey });
    if (state.simulateMode && state.allFleetBuses.length > 0) {
      startSimLoop();
    }

    // Load street polylines for active lines in the background (cached forever) so EN VIVO moves every bus along its streets
    if (missingRouteLines.length > 0) {
      ensureBranchesLoaded(missingRouteLines)
        .then(() => {
          if (!state.allFleetMode || seq !== allFleetFetchSeq) return;
          reconcileCityFleetSim(state.allFleetBuses);
          if (state.simulateMode && state.allFleetBuses.length > 0) {
            startSimLoop();
          }
        })
        .catch(() => {});
    }

    // If user currently has a city-fleet bus open in inspector, refresh its fields seamlessly
    if (state.inspectorOpen && state.selectedBusKey?.startsWith('city:')) {
      const refreshed = state.allFleetBuses.find((b) => b.key === state.selectedBusKey);
      if (refreshed) updateInspectorFields(refreshed);
    }

    if (fit && state.allFleetBuses.length > 0 && !state.activeStop) {
      transitMap.fitFleet(state.allFleetBuses);
    }
    if (!silent) {
      showToast(
        state.allFleetBuses.length > 0
          ? `${state.allFleetBuses.length} colectivos circulando en todas las líneas`
          : 'No se detectaron colectivos activos en este momento',
        state.allFleetBuses.length > 0 ? 'success' : 'info',
        2600
      );
      announce(
        `${state.allFleetBuses.length} colectivos circulando visibles en el mapa. Tocá cualquier unidad para ver sus datos.`
      );
    }
  } catch {
    if (!silent) {
      showToast('No se pudo consultar la flota general en este momento', 'warn', 2600);
    }
  } finally {
    if (seq === allFleetFetchSeq) {
      state.allFleetLoading = false;
      updateAllFleetButtonUi();
    }
  }
}

async function openAllFleetBusInspector(busKey) {
  const bus = state.allFleetBuses.find((b) => b.key === busKey);
  if (!bus) return;

  if (state.dockExpanded) {
    setSheetIndex(1, { silent: true });
  }
  haptic('light');
  state.selectedBusKey = bus.key;
  state.inspectorOpen = true;
  updateInspectorFields(bus);
  el.busInspector.classList.remove('hidden');
  transitMap.updateAllFleetBuses(state.allFleetBuses, { selectedBusKey: bus.key });
  transitMap.focusBus(bus, Math.max(15, transitMap.map.getZoom()));

  // Resolve exact immutable Service / Turno / Vuelta asynchronously if that line's archive wasn't loaded yet
  await ensureScheduleAssetsLoaded([bus.codigoLinea]);
  const branches = state.routeBranchesCache.get(bus.codigoLinea) || [];
  const horFile = state.horariosArchiveCache.get(bus.codigoLinea) || null;
  if (branches.length && horFile) {
    const model = buildLineScheduleModel(bus.codigoLinea, branches, horFile, getArgentinaTodayTipo());
    const meta = resolveUnitScheduleMeta(
      model,
      {
        lat: bus.rawLat ?? bus.lat,
        lng: bus.rawLng ?? bus.lng,
        bandera: bus.descripcionBandera,
        lastGps: bus.ultimaFechaHoraGPS,
        desvioSec: bus.desvio?.seconds || 0,
        desvioRaw: bus.desvio?.raw || '',
        lastSeenAt: bus.lastSeenAt,
        enLineaAhora: true
      },
      getArgentinaSecOfDay()
    );
    if (meta) {
      bus._matchedBranch = meta.trip?.branch || null;
      bus.serviceNumber = meta.serviceNumber;
      bus.turnoIndex = meta.turnoIndex;
      bus.serviceTurnosCount = meta.serviceTurnosCount;
      bus.lapNumber = meta.lapNumber;
      bus.shiftLaps = meta.shiftLaps;
      bus.isCortadoBlock = meta.isCortado;
      bus.isRelevoEnLinea = meta.isRelevoEnLinea;
      bus.turnoStart = meta.startHHMM;
      bus.turnoEnd = meta.endHHMM;
      bus.serviceSpan = meta.startHHMM && meta.endHHMM ? `${meta.startHHMM}–${meta.endHHMM}` : '';
      if (state.inspectorOpen && state.selectedBusKey === bus.key) {
        updateInspectorFields(bus);
      }
    }
  }
}

function toggleAllFleetMode(forceState = null) {
  const next = typeof forceState === 'boolean' ? forceState : !state.allFleetMode;
  state.allFleetMode = next;
  if (state.allFleetTimerId) {
    clearInterval(state.allFleetTimerId);
    state.allFleetTimerId = null;
  }
  haptic('light');
  if (!next) {
    state.allFleetBuses = [];
    state.allFleetLoading = false;
    cityFleetSim.clear();
    if (!state.activeStop) stopSimLoop();
    transitMap.clearAllFleetBuses();
    if (state.selectedBusKey?.startsWith('city:')) {
      closeBusInspector();
    }
    updateAllFleetButtonUi();
    showToast('Capa de todos los colectivos ocultada', 'info', 1800);
    announce('Capa de todos los colectivos desactivada.');
    return;
  }

  if (state.dockExpanded) {
    setSheetIndex(1, { silent: true });
  }
  updateAllFleetButtonUi();
  refreshAllFleetBuses({ fit: !state.activeStop, silent: false });
  state.allFleetTimerId = setInterval(() => {
    if (!state.isAppPaused && state.allFleetMode) {
      refreshAllFleetBuses({ fit: false, silent: true });
    }
  }, 12000);
}

/**
 * Free-form Map Locator: shows ANY car or driver directly on the map WITHOUT needing to pick a stop!
 * Draws the line's full route polylines + stops, places the unit marker immediately, opens the live
 * telemetry inspector (service, current lap, start-end schedule, driver, car), and keeps refreshing
 * live GPS via Corridor Radar every 12s while tracking.
 */
let trackedUnitSeq = 0;
async function locateFleetUnitOnMap({
  codLinea,
  lineName = '',
  coche = '',
  choferNombre = '',
  choferLegajo = '',
  esAdaptado = false,
  lat = null,
  lng = null,
  bandera = '',
  lastGps = '',
  lastStopId = '',
  desvioRaw = '',
  desvioSec = 0,
  enLineaAhora = false,
  lastSeenLabel = '',
  serviceMeta = null
} = {}) {
  const numCod = Number(codLinea);
  if (!numCod) return;
  stopTrackedUnit();
  const mySeq = ++trackedUnitSeq;

  const resolvedLineName =
    lineName ||
    state.lineas.find((l) => Number(l.codigo) === numCod)?.descripcion ||
    state.catalogo?.lineByCode?.get(numCod)?.descripcion ||
    `L${numCod}`;

  haptic('light');
  // Lower the mobile bottom sheet so the map, route polylines, stops, and bus pin are clearly visible!
  if (window.innerWidth < 768) {
    setSheetIndex(0, { silent: true });
  }

  // 1) Load route polylines + stops AND schedule model for this line
  await ensureScheduleAssetsLoaded([numCod]);
  if (mySeq !== trackedUnitSeq) return;

  const recRes = await api.recorridos(numCod).catch(() => null);
  if (mySeq !== trackedUnitSeq) return;
  const recorridos = Array.isArray(recRes?.data) ? recRes.data : [];
  if (recorridos.length > 0) {
    transitMap.clearRoutes();
    transitMap.drawRouteCollection(recorridos, resolvedLineName, { showStops: true, fit: false });
    state.routesVisible = true;
  }

  const branches = state.routeBranchesCache.get(numCod) || [];
  const horFile = state.horariosArchiveCache.get(numCod) || null;
  const todayTipo = getArgentinaTodayTipo();
  const model = branches.length && horFile ? buildLineScheduleModel(numCod, branches, horFile, todayTipo) : null;

  // Pick a strategic anchor stop on this line for live Corridor Radar sweeps
  const pickAnchorStop = () => {
    if (lastStopId) return String(lastStopId).trim().toUpperCase();
    for (const r of recorridos) {
      const paradas = Array.isArray(r.paradas) ? r.paradas : [];
      if (paradas.length > 2) {
        const mid = paradas[Math.floor(paradas.length * 0.5)];
        if (mid?.Identificador) return String(mid.Identificador).trim().toUpperCase();
      }
    }
    return '';
  };

  const buildTrackedBusObj = (raw, meta, isLiveNow) => {
    const bLat = parseFloat(raw.lat ?? raw.latitud);
    const bLng = parseFloat(raw.lng ?? raw.longitud);
    const hasCoords = !Number.isNaN(bLat) && !Number.isNaN(bLng) && (bLat !== 0 || bLng !== 0);
    const parsedDesv = raw.desvioRaw || raw.desvioHorario
      ? parseDesvioHorario(raw.desvioRaw || raw.desvioHorario)
      : { status: 'none', label: '', seconds: Number(raw.desvioSec) || 0, raw: '' };
    const startHHMM = meta?.startHHMM || '';
    const endHHMM = meta?.endHHMM || '';
    const serviceSpan = startHHMM && endHHMM ? `${startHHMM}–${endHHMM}` : '';
    const bCoche = String(raw.coche || raw.identificadorCoche || coche || '').trim();
    const gpsRaw = raw.ultimaFechaHoraGPS || raw.lastGps || lastGps || '';
    return {
      key: `track:${numCod}:${bCoche || choferNombre || 'unit'}`,
      codigoLinea: numCod,
      descripcionLinea: resolvedLineName,
      descripcionBandera: raw.descripcionBandera || raw.bandera || bandera || `Línea ${resolvedLineName}`,
      realBandera: raw.descripcionBandera || raw.bandera || bandera || `Línea ${resolvedLineName}`,
      realBanderaColor: getLineColor(resolvedLineName),
      identificadorCoche: bCoche,
      choferNombre: raw.choferNombre || choferNombre || '',
      choferLegajo: raw.choferLegajo || choferLegajo || '',
      esAdaptado: Boolean(raw.esAdaptado ?? esAdaptado),
      desvio: parsedDesv,
      eta: { minutes: 0, display: '—' },
      distanceMeters: 0,
      routeMeters: 0,
      lat: hasCoords ? bLat : null,
      lng: hasCoords ? bLng : null,
      ultimaFechaHoraGPS: gpsRaw,
      gpsTimeOnly: formatGpsTimeOnly(gpsRaw),
      lastSeenLabel,
      serviceNumber: meta?.serviceNumber || null,
      turnoIndex: meta?.turnoIndex || 1,
      serviceTurnosCount: meta?.serviceTurnosCount || 1,
      lapNumber: meta?.lapNumber || null,
      shiftLaps: meta?.shiftLaps || null,
      isCortadoBlock: Boolean(meta?.isCortado),
      isRelevoEnLinea: Boolean(meta?.isRelevoEnLinea),
      turnoStart: startHHMM,
      turnoEnd: endHHMM,
      serviceSpan,
      enLineaAhora: Boolean(isLiveNow),
      isFreeTracked: true,
      isPredicted: false
    };
  };

  // Resolve initial metadata & render immediately if coordinates exist
  const initialMeta =
    serviceMeta ||
    resolveUnitScheduleMeta(model, {
      lat,
      lng,
      bandera,
      lastGps,
      desvioSec,
      desvioRaw
    });
  const initBus = buildTrackedBusObj(
    { lat, lng, coche, choferNombre, choferLegajo, esAdaptado, bandera, lastGps, desvioRaw, desvioSec },
    initialMeta,
    enLineaAhora
  );

  const tracker = {
    codLinea: numCod,
    lineName: resolvedLineName,
    coche: String(coche || '').trim(),
    choferNombre: String(choferNombre || '').trim(),
    choferLegajo: String(choferLegajo || '').trim(),
    bus: initBus,
    buses: initBus.lat !== null ? [initBus] : [],
    timerId: null,
    seq: mySeq
  };
  state.trackedUnit = tracker;

  if (initBus.lat !== null && initBus.lng !== null) {
    state.selectedBusKey = initBus.key;
    state.inspectorOpen = true;
    updateInspectorFields(initBus);
    el.busInspector.classList.remove('hidden');
    transitMap.updateBuses(tracker.buses, {
      filterLine: 'ALL',
      selectedBusKey: initBus.key,
      simulateMode: false
    });
    transitMap.focusBus(initBus, 15);
  } else {
    showToast(`Buscando ubicación en vivo de ${choferNombre || `Coche #${coche}`} (${resolvedLineName})...`, 'info', 2200);
  }

  // 2) Live Corridor Radar refresh function for this line (updates exact GPS position + service/vuelta!)
  const refreshTrackedLive = async (isFirst = false) => {
    if (!state.trackedUnit || state.trackedUnit.seq !== mySeq) return;
    const anchorStop = pickAnchorStop();
    if (!anchorStop) return;
    try {
      const liveRes = await api.arribosLineaCompleto(anchorStop, numCod);
      if (!state.trackedUnit || state.trackedUnit.seq !== mySeq) return;
      const rawList = [
        ...(Array.isArray(liveRes?.data?.arribos) ? liveRes.data.arribos : []),
        ...(Array.isArray(liveRes?.data?.corridorFleet) ? liveRes.data.corridorFleet : [])
      ];
      const byCoche = new Map();
      for (const a of rawList) {
        if (Number(a.codigoLinea) !== numCod) continue;
        const c = String(a.identificadorCoche || '').trim();
        const la = parseFloat(a.latitud);
        const ln = parseFloat(a.longitud);
        if (!c || Number.isNaN(la) || Number.isNaN(ln) || (la === 0 && ln === 0)) continue;
        if (!byCoche.has(c)) byCoche.set(c, a);
      }
      const liveUnits = Array.from(byCoche.values());
      const nowSec = getArgentinaSecOfDay();
      const matchedMap = model
        ? matchFreeFleetUnitsToModel(model, liveUnits, nowSec, state.lastRealGpsByUnit)
        : new Map();

      const liveBuses = liveUnits.map((u) => {
        const c = String(u.identificadorCoche || '').trim();
        const meta = matchedMap.get(c) || resolveUnitScheduleMeta(model, u, nowSec);
        return buildTrackedBusObj(u, meta, true);
      });

      const normTargetName = tracker.choferNombre.toUpperCase();
      const found =
        liveBuses.find(
          (b) =>
            (tracker.choferLegajo && b.choferLegajo && b.choferLegajo === tracker.choferLegajo) ||
            (normTargetName && b.choferNombre && b.choferNombre.toUpperCase().includes(normTargetName))
        ) ||
        liveBuses.find((b) => tracker.coche && b.identificadorCoche === tracker.coche) ||
        null;

      if (found) {
        tracker.bus = found;
        tracker.coche = found.identificadorCoche || tracker.coche;
        tracker.buses = liveBuses;
        state.selectedBusKey = found.key;
        state.inspectorOpen = true;
        updateInspectorFields(found);
        el.busInspector.classList.remove('hidden');
        transitMap.updateBuses(tracker.buses, {
          filterLine: 'ALL',
          selectedBusKey: found.key,
          simulateMode: false
        });
        if (isFirst) {
          transitMap.focusBus(found, 15);
          const srvTxt = found.serviceNumber ? `Servicio ${found.serviceNumber}` : '';
          const lapTxt = found.lapNumber ? `, vuelta ${formatLapSpoken(found.lapNumber)}` : '';
          const spanTxt = found.serviceSpan ? `, horario ${found.serviceSpan}` : '';
          announce(
            `Ubicado en vivo: Línea ${resolvedLineName}, coche ${found.identificadorCoche}${
              found.choferNombre ? `, chofer ${found.choferNombre}` : ''
            }${srvTxt ? `, ${srvTxt}` : ''}${lapTxt}${spanTxt}.`
          );
        }
      } else if (isFirst) {
        if (initBus.lat === null) {
          showToast(
            `${choferNombre || `Coche #${coche}`} no transmite GPS en este momento. Mostrando recorrido de ${resolvedLineName}.`,
            'warn',
            3200
          );
          if (recorridos.length > 0) {
            transitMap.drawRouteCollection(recorridos, resolvedLineName, { showStops: true, fit: true });
          }
          if (liveBuses.length > 0) {
            tracker.buses = liveBuses;
            transitMap.updateBuses(liveBuses, { filterLine: 'ALL', selectedBusKey: null, simulateMode: false });
          }
        } else {
          // Keep last-known pin + also show any other currently live buses of the line
          const merged = [initBus, ...liveBuses.filter((b) => b.key !== initBus.key)];
          tracker.buses = merged;
          transitMap.updateBuses(merged, { filterLine: 'ALL', selectedBusKey: initBus.key, simulateMode: false });
        }
      }
    } catch {
      // Keep last-known pin on transient error
    }
  };

  await refreshTrackedLive(true);
  if (state.trackedUnit && state.trackedUnit.seq === mySeq) {
    state.trackedUnit.timerId = setInterval(() => {
      if (!state.isAppPaused) refreshTrackedLive(false);
    }, 12000);
  }
}

function getMergedFleetMemory() {
  const merged = new Map();
  for (const t of state.fleetMemory?.trips || []) {
    merged.set(`${t.codigoLinea}:${t.tripKey}`, t);
  }
  const todayKey = getArgentinaDayKey();
  const nowMs = Date.now();
  for (const [k, rec] of state.sessionObservedTrips.entries()) {
    if (rec.dayKey === todayKey || (rec.updatedAt && nowMs - rec.updatedAt < 4 * 3600 * 1000)) {
      merged.set(k, rec);
    }
  }
  return {
    dayKey: todayKey,
    trips: Array.from(merged.values()),
    units: state.fleetMemory?.units || []
  };
}

/**
 * Unified Online <-> Lost-GPS <-> Offline <-> GPS-Recovery continuity engine:
 *  1) Matches every live GPS bus to its canonical scheduled `tripKey` & `turnoProgramado`.
 *  2) Reports fresh `(tripKey -> coche, chofer, desvio)` assignments to central system FleetMemory.
 *  3) Transfers BusSimulator kinematic state across `predicted <-> gps` handoffs (0 m jump!).
 *  4) In EN VIVO mode, predicts positions along street polylines for offline / no-GPS / lost-GPS turns.
 */
function reconcileWithSchedulePrediction(
  liveBuses,
  stopId,
  stopCoords,
  targetLineCodes,
  { isOffline = false, skipReport = false } = {}
) {
  const prevArribos = state.arribos || [];
  const prevByTripKey = new Map();
  const prevByCoche = new Map();
  const activePredKeys = new Set();
  for (const b of prevArribos) {
    if (b.tripKey) prevByTripKey.set(`${b.codigoLinea}:${b.tripKey}`, b);
    if (b.identificadorCoche) prevByCoche.set(`${b.codigoLinea}:${b.identificadorCoche}`, b);
    if (b.isPredicted) activePredKeys.add(b.key);
  }

  const nowSec = getArgentinaSecOfDay();
  const todayTipo = getArgentinaTodayTipo();
  const todayDayKey = getArgentinaDayKey();
  const nowMs = Date.now();
  const completedStopKey = `${todayDayKey}:${stopId}`;
  if (!state.completedTripsByStop.has(completedStopKey)) {
    state.completedTripsByStop.set(completedStopKey, new Set());
  }
  const completedSet = state.completedTripsByStop.get(completedStopKey);

  // Prune stale sticky & service-evidence entries (> 2 hours old or from prior service day)
  for (const [k, v] of state.stickyLiveTripByCoche.entries()) {
    if (nowMs - v.updatedAt > 2 * 3600 * 1000) {
      state.stickyLiveTripByCoche.delete(k);
    }
  }
  for (const [k, v] of state.serviceEvidenceByCoche.entries()) {
    if (v.dayKey !== todayDayKey || nowMs - v.updatedAt > 6 * 3600 * 1000) {
      state.serviceEvidenceByCoche.delete(k);
    }
  }

  const liveByLine = new Map();
  const curLiveCoches = new Set();
  for (const b of liveBuses) {
    const cod = Number(b.codigoLinea);
    if (!liveByLine.has(cod)) liveByLine.set(cod, []);
    liveByLine.get(cod).push(b);
    if (b.identificadorCoche) curLiveCoches.add(`${cod}:${b.identificadorCoche}`);
  }

  // If a live GPS bus was right about to pass this stop (<= 3 min or <= 950 m) on the previous online poll
  // and is now gone from live arrivals, mark its trip completed at this stop so we NEVER spawn a phantom
  // scheduled bus for a unit that already passed ahead of schedule!
  if (!isOffline) {
    for (const prev of prevArribos) {
      if (prev.isPredicted || prev.isNextLap || !prev.tripKey || !prev.identificadorCoche) continue;
      const ck = `${prev.codigoLinea}:${prev.identificadorCoche}`;
      if (!curLiveCoches.has(ck)) {
        const wasPassing =
          (prev.eta?.valid && prev.eta.minutes <= 3) ||
          (typeof prev.routeMeters === 'number' && prev.routeMeters <= 950);
        if (wasPassing) {
          completedSet.add(`${prev.codigoLinea}:${prev.tripKey}`);
        }
      }
    }
  }

  const liveMatchedTripKeysByLine = new Map();
  const liveMatchedCochesByLine = new Map();
  const liveBusByTripKeyByLine = new Map();
  const seenReports = [];

  for (const [cod, buses] of liveByLine.entries()) {
    const branches = state.routeBranchesCache.get(cod) || [];
    const horFile = state.horariosArchiveCache.get(cod) || null;
    const model = buildLineScheduleModel(cod, branches, horFile, todayTipo);

    const matchedTrips = new Set();
    const matchedCoches = new Set();
    const liveBusByTrip = new Map();
    liveMatchedTripKeysByLine.set(cod, matchedTrips);
    liveMatchedCochesByLine.set(cod, matchedCoches);
    liveBusByTripKeyByLine.set(cod, liveBusByTrip);

    for (const b of buses) {
      if (b.identificadorCoche) matchedCoches.add(b.identificadorCoche);
    }

    const lineCorridorBuses = (state.corridorFleet || []).filter((u) => Number(u.codigoLinea) === Number(cod));

    if (model && stopCoords) {
      const matches = matchLiveBusesToTrips(model, stopId, stopCoords, buses, nowSec, {
        stickyTripByCoche: state.stickyLiveTripByCoche,
        corridorBuses: lineCorridorBuses,
        gpsHistoryByUnit: state.lastRealGpsByUnit,
        serviceEvidenceByCoche: state.serviceEvidenceByCoche
      });
      for (const b of buses) {
        const m = matches.get(b.key);
        if (!m) continue;
        matchedTrips.add(m.tripKey);
        liveBusByTrip.set(m.tripKey, b);
        completedSet.delete(`${cod}:${m.tripKey}`); // bus is actively approaching, definitely not completed

        if (!b.isNextLap && b.identificadorCoche) {
          const cocheKey = `${cod}:${b.identificadorCoche}`;

          // If the global assignment auto-corrected this car to a different service, clean up the stale
          // local observation so no phantom duplicate remains on the old trip!
          if (m.wasAutoCorrected && m.supersededTripKey) {
            const staleKey = `${cod}:${m.supersededTripKey}`;
            const staleObs = state.sessionObservedTrips.get(staleKey);
            if (staleObs && String(staleObs.coche || '').trim() === String(b.identificadorCoche).trim()) {
              state.sessionObservedTrips.delete(staleKey);
            }
          }

          state.stickyLiveTripByCoche.set(cocheKey, {
            tripKey: m.tripKey,
            serviceNumber: m.serviceNumber || null,
            blockId: m.blockId || null,
            dayKey: todayDayKey,
            updatedAt: nowMs
          });

          if (m.serviceNumber) {
            const prevEv = state.serviceEvidenceByCoche.get(cocheKey);
            const curErr = typeof m.rawErrorSec === 'number' ? m.rawErrorSec : 300;
            if (prevEv && prevEv.serviceNumber === m.serviceNumber && !m.wasAutoCorrected) {
              state.serviceEvidenceByCoche.set(cocheKey, {
                serviceNumber: m.serviceNumber,
                blockId: m.blockId || prevEv.blockId || null,
                dayKey: todayDayKey,
                avgErrSec: Math.round(prevEv.avgErrSec * 0.65 + curErr * 0.35),
                count: Math.min(20, (prevEv.count || 1) + 1),
                updatedAt: nowMs
              });
            } else {
              state.serviceEvidenceByCoche.set(cocheKey, {
                serviceNumber: m.serviceNumber,
                blockId: m.blockId || null,
                dayKey: todayDayKey,
                avgErrSec: curErr,
                count: 1,
                updatedAt: nowMs
              });
            }
          }
        }

        // If this is a cold-start Poll 1 on a shared two-way street (no `prevGpsFix` heading vector yet)
        // and the spatial-temporal schedule anchor proves the bus is actually on `prevTrip` (`legDepth === 1`)
        // heading toward the turnaround cabecera, refine its trajectory to `previous_leg` immediately!
        if (
          !b.isNextLap &&
          !b.prevGpsFix &&
          b.trajectory?.leg === 'direct' &&
          m.trip?.prevTrip &&
          b.stopProj &&
          typeof b.lat === 'number' &&
          typeof b.lng === 'number'
        ) {
          const gpsClock = parseGpsStampSecOfDay(b.ultimaFechaHoraGPS) ?? nowSec;
          const liveAnchor = buildGpsAnchorForTrip(m.trip, b.lat, b.lng, gpsClock, b.desvio?.seconds || 0);
          if (liveAnchor && liveAnchor.legDepth === 1 && !liveAnchor.atOriginTerminal) {
            const refinedTraj = buildTrajectoryFromBranchAlong(
              liveAnchor.branch,
              liveAnchor.along,
              m.trip.branch,
              b.stopProj,
              {
                isAtTerminal: Boolean(b.trajectory.isAtTerminal),
                etaSec: b.etaSecondsRemaining || 600
              }
            );
            if (refinedTraj) {
              b.trajectory = refinedTraj;
              b.routeMeters = refinedTraj.totalMeters;
              b.isOppositeLeg = Boolean(refinedTraj.isOppositeLeg);
              b.realBandera = refinedTraj.realBandera || b.realBandera;
              b.realBanderaColor = refinedTraj.realBanderaColor || b.realBanderaColor;
            }
          }
        }

        // Seamless GPS recovery handoff: transfer simulator state from prior predicted marker!
        if (!b.isNextLap) {
          const predKey = `pred:${cod}:${m.tripKey}`;
          if (busSimulator.transferState(predKey, b.key)) {
            if (state.selectedBusKey === predKey) state.selectedBusKey = b.key;
          }
        }

        // Persist last-seen online vehicle, GPS position trail & confirmed direction into central FleetMemory
        if (!b.isNextLap && b.identificadorCoche) {
          const unitHist = state.lastRealGpsByUnit.get(`${cod}-c${b.identificadorCoche}`);
          const compactTrail = Array.isArray(unitHist?.trail)
            ? unitHist.trail
                .slice(-6)
                .map((pt) => [Number(pt.lat.toFixed(6)), Number(pt.lng.toFixed(6)), pt.gpsMs || pt.ts || nowMs])
            : [];
          const dirBandera =
            b.confirmedDirectionBandera || unitHist?.confirmedDir?.bandera || '';

          // Resolve the trip the bus is PHYSICALLY driving right now (not a future leg / next-turno trip approaching stopId!)
          const gpsClock = parseGpsStampSecOfDay(b.ultimaFechaHoraGPS) ?? nowSec;
          const gpsSvcSec = gpsClock < 3 * 3600 ? gpsClock + 86400 : gpsClock;
          let recTrip = m.trip;
          if (m.trip && typeof b.lat === 'number' && typeof b.lng === 'number') {
            const safeDesvio = Math.abs(b.desvio?.seconds || 0) <= 40 * 60 ? (b.desvio?.seconds || 0) : 0;
            const curAnchor = buildGpsAnchorForTrip(m.trip, b.lat, b.lng, gpsClock, safeDesvio);
            if (curAnchor?.trip && curAnchor.legDepth >= 1) {
              recTrip = curAnchor.trip;
            }
          }
          const recBi = recTrip?.blockInfo || (recTrip?.blockId ? model.blockInfoById?.get(recTrip.blockId) : null);
          const recTripKey = recTrip?.tripKey || m.tripKey;
          const recInWindow = Boolean(
            recTrip && gpsSvcSec >= recTrip.startSec - 20 * 60 && gpsSvcSec <= recTrip.endSec + 30 * 60
          );

          const rec = {
            dayKey: todayDayKey,
            codigoLinea: cod,
            tripKey: recTripKey,
            supersededTripKey: recTripKey === m.tripKey ? (m.supersededTripKey || '') : '',
            turnoHora: recTripKey === m.tripKey ? m.turnoHora : formatSecHHMM(recTrip?.startSec ?? 0),
            coche: b.identificadorCoche,
            choferNombre: b.choferNombre || '',
            choferLegajo: b.choferLegajo || '',
            choferRaw: b.choferRaw || '',
            esAdaptado: Boolean(b.esAdaptado),
            desvioSec: b.desvio?.seconds || 0,
            desvioRaw: b.desvio?.raw || '',
            bandera: b.realBandera || b.descripcionBandera || '',
            dirBandera,
            gpsTrail: compactTrail,
            realLeg: b.trajectory?.leg || null,
            prevFix: b.prevGpsFix || null,
            ultimaGps: b.ultimaFechaHoraGPS || '',
            lat: b.lat,
            lng: b.lng,
            stopId,
            serviceNumber: recBi?.serviceNumber || b.serviceNumber || 0,
            turnoIndex: recBi?.turnoIndex || b.turnoIndex || 0,
            turnoStart: recBi ? formatSecHHMM(recBi.startSec) : '',
            turnoEnd: recBi ? formatSecHHMM(recBi.endSec) : '',
            lapNumber: recTrip?.lapNumber || b.lapNumber || 0,
            shiftLaps: recBi?.shiftLaps || b.shiftLaps || 0,
            updatedAt: nowMs
          };
          state.sessionObservedTrips.set(`${cod}:${m.tripKey}`, { ...rec, tripKey: m.tripKey, turnoHora: m.turnoHora });
          if (recInWindow) {
            state.sessionObservedTrips.set(`${cod}:${recTripKey}`, rec);
            seenReports.push(rec);
          }
        }
      }
    }
  }

  if (seenReports.length > 0 && !isOffline && !skipReport) {
    api.reportFleetSeen(seenReports, todayDayKey);
  }

  // ULT. GPS (blue mode): show ONLY static last GPS positions without schedule-synthesized units
  if (!state.simulateMode) {
    return liveBuses;
  }

  // EN VIVO (green mode): synthesize realistic street-following buses for active turns without live GPS
  const fleetMem = getMergedFleetMemory();
  const predictedAll = [];
  const lineNameOf = (cod) =>
    state.stopLinesList.find((l) => Number(l.codigo) === Number(cod))?.descripcion ||
    state.catalogo?.lineByCode?.get(Number(cod))?.descripcion ||
    state.lineas.find((l) => Number(l.codigo) === Number(cod))?.descripcion ||
    `L${cod}`;

  // UNIFIED caps across online & offline so brief network hiccups NEVER make scheduled arrivals blink in/out!
  // Single-line mode uses 130 min horizon to cover low-frequency 2h headway lines (109B, 105C Perichón, Riachuelo).
  const isSingleLine = Boolean(state.focusedLineCode);
  const maxUpcoming = isSingleLine ? 6 : 3;
  const maxAheadMin = isSingleLine ? 130 : 75;

  for (const cod of targetLineCodes) {
    const branches = state.routeBranchesCache.get(cod) || [];
    const horFile = state.horariosArchiveCache.get(cod) || null;
    if (!branches.length || !horFile || !stopCoords) continue;

    const matchedTrips = liveMatchedTripKeysByLine.get(cod) || new Set();
    const matchedCoches = liveMatchedCochesByLine.get(cod) || new Set();
    const liveBusByTrip = liveBusByTripKeyByLine.get(cod) || new Map();
    const lineLive = liveByLine.get(cod) || [];

    // Live corridor-radar units discovered in parallel upstream/downstream/opposite stops by the Worker
    const corridorBuses = (state.corridorFleet || []).filter((u) => Number(u.codigoLinea) === Number(cod));

    // Gather any fresh (< 90 s) fallback downstream terminal probe results for this line
    const downstreamBuses = [...corridorBuses];
    for (const [k, entry] of state.downstreamProbeCache.entries()) {
      if (k.startsWith(`${cod}:`) && nowMs - entry.ts <= 90000 && Array.isArray(entry.arribos)) {
        downstreamBuses.push(...entry.arribos);
      }
    }

    // Detect trips that ALREADY PASSED `stopId` (e.g. a bus running 5+ min ahead of schedule) via:
    //  1) live full_cycle buses past stopId, 2) parallel corridor-radar probes, 3) FleetMemory units/trips
    const alreadyPassed = detectAlreadyPassedTrips({
      codLinea: cod,
      stopId,
      stopCoords,
      branches,
      horariosFile: horFile,
      tipoDia: todayTipo,
      liveBuses: lineLive,
      downstreamBuses,
      fleetMemory: fleetMem,
      nowSec
    });
    for (const tk of alreadyPassed) {
      completedSet.add(`${cod}:${tk}`);
    }

    const preds = predictLineBusesForStop({
      codLinea: cod,
      lineName: lineNameOf(cod),
      stopId,
      stopCoords,
      branches,
      horariosFile: horFile,
      tipoDia: todayTipo,
      nowSec,
      liveMatchedTripKeys: matchedTrips,
      liveMatchedCoches: matchedCoches,
      liveBusByTripKey: liveBusByTrip,
      corridorBuses,
      completedTripKeys: completedSet,
      activePredKeys,
      fleetMemory: fleetMem,
      gpsHistoryByUnit: state.lastRealGpsByUnit,
      maxUpcoming,
      maxAheadMin
    });

    for (const p of preds) {
      // Next-lap (`Sig. vuelta`) virtual cards mirror their active source bus; never steal live simulator state!
      if (p.isNextLap) {
        p.stopId = stopId;
        predictedAll.push(p);
        continue;
      }

      // Spatial de-duplication: if an unmatched live GPS bus of the same line & branch is right next to
      // this predicted slot (e.g., running >16 min late), bind the live bus instead of spawning a ghost!
      const nearbyUnmatchedLive = lineLive.find(
        (lb) =>
          !lb.tripKey &&
          typeof lb.lat === 'number' &&
          typeof lb.lng === 'number' &&
          (distanceMeters(lb.lat, lb.lng, p.lat, p.lng) ?? Infinity) <= 450 &&
          lb.realBandera === p.realBandera
      );
      if (nearbyUnmatchedLive) {
        nearbyUnmatchedLive.tripKey = p.tripKey;
        nearbyUnmatchedLive.turnoProgramado = p.turnoProgramado;
        nearbyUnmatchedLive.scheduledTrip = p.scheduledTrip;
        nearbyUnmatchedLive.stopProj = p.stopProj;
        nearbyUnmatchedLive.serviceNumber = p.serviceNumber || null;
        nearbyUnmatchedLive.turnoIndex = p.turnoIndex || 1;
        nearbyUnmatchedLive.serviceTurnosCount = p.serviceTurnosCount || 1;
        nearbyUnmatchedLive.lapNumber = p.lapNumber || null;
        nearbyUnmatchedLive.shiftLaps = p.shiftLaps || null;
        nearbyUnmatchedLive.isHalfLap = Boolean(p.isHalfLap);
        nearbyUnmatchedLive.isCortadoBlock = Boolean(p.isCortadoBlock);
        nearbyUnmatchedLive.isRelevoEnLinea = Boolean(p.isRelevoEnLinea);
        nearbyUnmatchedLive.nextLapStopTime = p.nextLapStopTime || null;
        matchedTrips.add(p.tripKey);
        if (nearbyUnmatchedLive.identificadorCoche) {
          state.stickyLiveTripByCoche.set(`${cod}:${nearbyUnmatchedLive.identificadorCoche}`, {
            tripKey: p.tripKey,
            serviceNumber: p.serviceNumber || null,
            blockId: p.scheduledTrip?.blockId || null,
            dayKey: todayDayKey,
            updatedAt: nowMs
          });
        }
        const predKey = p.key;
        if (busSimulator.transferState(predKey, nearbyUnmatchedLive.key)) {
          if (state.selectedBusKey === predKey) state.selectedBusKey = nearbyUnmatchedLive.key;
        }
        continue;
      }

      // Seamless GPS-loss handoff: if a live unit just disappeared from SmartMovePro on this trip/coche,
      // transfer its exact visual position & speed to the predicted unit!
      const prevSameTrip = prevByTripKey.get(`${cod}:${p.tripKey}`);
      const prevSameCoche = p.identificadorCoche ? prevByCoche.get(`${cod}:${p.identificadorCoche}`) : null;
      const prevSource =
        prevSameTrip && !prevSameTrip.isPredicted
          ? prevSameTrip
          : prevSameCoche && !prevSameCoche.isPredicted
            ? prevSameCoche
            : null;
      if (prevSource) {
        if (busSimulator.transferState(prevSource.key, p.key)) {
          if (state.selectedBusKey === prevSource.key) state.selectedBusKey = p.key;
        }
      }

      p.stopId = stopId;
      predictedAll.push(p);
    }
  }

  return [...liveBuses, ...predictedAll].sort(
    (a, b) => (a.etaSecondsRemaining ?? 99999) - (b.etaSecondsRemaining ?? 99999)
  );
}

/**
 * Fallback downstream probe when online in multi-line ("Todas") mode and an imminent (<= 14 min)
 * unmatched scheduled turn belongs to a diverging branch not covered by the main avenue corridor probe.
 */
async function probeDownstreamForImminentGhosts(buses, stopId, stopCoords) {
  if (state.isOffline || !stopCoords || !Array.isArray(buses) || buses.length === 0) return false;
  const nowMs = Date.now();
  const toProbe = [];
  const seenProbe = new Set();

  for (const b of buses) {
    if (!b.isPredicted || b.predictionReason !== 'schedule') continue;
    if ((b.etaSecondsRemaining ?? 99999) > 14 * 60) continue;
    const cod = Number(b.codigoLinea);
    const branches = state.routeBranchesCache.get(cod) || [];
    const sbs = pickStopBranches(branches, stopId, stopCoords);
    for (const sb of sbs) {
      if (!sb.orderedStops?.length) continue;
      const stopProj = projectOnPolyline(sb.pts, sb.cum, stopCoords.lat, stopCoords.lng);
      const lastStop = sb.orderedStops[sb.orderedStops.length - 1];
      if (!lastStop || lastStop.id === stopId) continue;
      if (stopProj && lastStop.along <= stopProj.along + 350) continue;
      const pKey = `${cod}:${lastStop.id}`;
      if (seenProbe.has(pKey)) continue;
      const cached = state.downstreamProbeCache.get(pKey);
      if (cached && nowMs - cached.ts < 75000) continue;
      seenProbe.add(pKey);
      toProbe.push({ cod, termStopId: lastStop.id, pKey });
    }
    if (toProbe.length >= 3) break;
  }

  if (toProbe.length === 0) return false;

  let anyFresh = false;
  await Promise.all(
    toProbe.map(async ({ cod, termStopId, pKey }) => {
      try {
        const res = await api.arribos(termStopId, String(cod), { skipCorridor: true });
        const arribos = Array.isArray(res?.data?.arribos) ? res.data.arribos : [];
        state.downstreamProbeCache.set(pKey, { ts: Date.now(), arribos });
        if (arribos.length > 0) anyFresh = true;
      } catch {
        state.downstreamProbeCache.set(pKey, { ts: Date.now(), arribos: [] });
      }
    })
  );
  return anyFresh;
}

async function renderOfflineOrFallback(showSkeleton = false, mySeq = null) {
  if (!state.activeStop) return;
  const stopId = state.activeStop.id;
  state.corridorFleet = [];

  if (!state.catalogo) {
    state.catalogo = await api.catalogo().catch(() => null);
  }
  if (mySeq !== null && mySeq !== fetchSeq) return;

  const catStop = state.catalogo?.stopById?.get(stopId) || null;
  if (catStop) {
    if (state.activeStop.nombre === `Parada ${stopId}` && catStop.nombre) {
      state.activeStop.nombre = catStop.nombre;
    }
    if (!state.activeStop.lat && catStop.lat) {
      state.activeStop.lat = catStop.lat;
      state.activeStop.lng = catStop.lng;
      updateStopHeaderUI();
    }
    if (state.stopLinesList.length === 0 && catStop.lineas?.length) {
      state.stopLinesList = catStop.lineas
        .map((cod) => {
          const l =
            state.catalogo.lineByCode.get(Number(cod)) ||
            state.lineas.find((x) => Number(x.codigo) === Number(cod));
          return l ? { codigo: Number(l.codigo), descripcion: l.descripcion } : null;
        })
        .filter(Boolean);
    }
  }

  if (state.activeStop.lat && state.activeStop.lng) {
    transitMap.setActiveStop(state.activeStop);
  }

  const targetLineCodes = state.focusedLineCode
    ? [state.focusedLineCode]
    : state.stopLinesList.map((l) => Number(l.codigo)).filter(Boolean);

  await ensureScheduleAssetsLoaded(targetLineCodes);
  await syncFleetMemory(targetLineCodes, { force: false, stopId });
  if (mySeq !== null && mySeq !== fetchSeq) return;

  const stopCoords =
    typeof state.activeStop.lat === 'number' && typeof state.activeStop.lng === 'number'
      ? { lat: state.activeStop.lat, lng: state.activeStop.lng }
      : state.fleetMemory?.stopSnapshot?.stopCoords || null;

  if (state.simulateMode) {
    state.dataSource = 'offline-schedule';
    state.arribos = reconcileWithSchedulePrediction([], stopId, stopCoords, targetLineCodes, { isOffline: true });
    busSimulator.reconcile(state.arribos, { applyPositions: true, stopId });
    el.lastSyncLabel.textContent = 'Sin conexión · Por horarios';
  } else {
    // ULT. GPS offline: restore last consulted arrivals snapshot from system mirror if none in memory
    if (state.arribos.length === 0 && state.fleetMemory?.stopSnapshot?.arribos?.length > 0) {
      const snap = state.fleetMemory.stopSnapshot;
      const snapCodes = Array.from(new Set(snap.arribos.map((a) => Number(a.codigoLinea)).filter(Boolean)));
      await ensureBranchesLoaded(snapCodes);
      if (mySeq !== null && mySeq !== fetchSeq) return;
      state.arribos = normalizeArrivals(snap.arribos, stopId, stopCoords);
      if (snap.savedAt) state.lastSyncAt = new Date(snap.savedAt);
    }
    el.lastSyncLabel.textContent = state.lastSyncAt
      ? `Sin conexión · Últ. GPS ${state.lastSyncAt.toLocaleTimeString('es-AR', {
          hour: '2-digit',
          minute: '2-digit',
          hour12: false
        })}`
      : 'Sin conexión · Cambiá a EN VIVO';
  }

  updateSignalPill();
  renderLineFilters();
  if (!state.horariosOpen) renderArribosList();
  else refreshHorariosLiveTags();

  transitMap.updateBuses(state.arribos, {
    filterLine: state.filterLine,
    selectedBusKey: state.selectedBusKey,
    simulateMode: state.simulateMode
  });

  if (state.simulateMode && state.arribos.length > 0) {
    startSimLoop();
  }

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
}

function announceArrivalsSummary({ isRefresh = false } = {}) {
  if (!state.activeStop || state.horariosOpen) return;
  const visible =
    state.filterLine === 'ALL'
      ? state.arribos
      : state.arribos.filter((a) => a.descripcionLinea === state.filterLine);
  const prefix = isRefresh
    ? 'Actualizado.'
    : `Parada ${state.activeStop.id}, ${state.activeStop.nombre || ''}.`;

  if (visible.length === 0) {
    announce(`${prefix} Sin colectivos reportando arribos en este momento. Podés abrir Horarios 24 horas.`);
    return;
  }
  const first = visible[0];
  const etaTxt =
    first.eta.minutes === 0
      ? 'arribando ahora'
      : `en ${first.eta.minutes === 1 ? '1 minuto' : `${first.eta.minutes} minutos`}`;
  const countTxt = visible.length === 1 ? '1 colectivo' : `${visible.length} colectivos`;
  announce(`${prefix} ${countTxt} en camino. Próximo: línea ${first.descripcionLinea}, ${etaTxt}.`);
}

async function fetchArribos(showSkeleton = false, { announceSummary = false, isRefresh = false } = {}) {
  if (!state.activeStop) return;
  const mySeq = ++fetchSeq;
  const stopId = state.activeStop.id;

  if (showSkeleton && !state.horariosOpen) {
    arrivalRowCache.clear();
    el.arribosList.innerHTML = `<div class="skeleton-row"></div><div class="skeleton-row"></div><div class="skeleton-row"></div><div class="skeleton-row"></div>`;
  }

  try {
    // Pass first known line on this stop as corridor hint in "Todas" mode so the Worker probes
    // 1 upstream + 1 downstream stop in parallel even if 0 buses are currently returned at stopId!
    const catStop = state.catalogo?.stopById?.get(stopId);
    const hintLinea = Number(state.stopLinesList[0]?.codigo) || Number(catStop?.lineas?.[0]) || null;

    // When focused on a single line, /api/arribos-linea runs full 3-zone corridor radar (upstream + downstream + opposite)!
    const res = state.focusedLineCode
      ? await api.arribosLineaCompleto(stopId, state.focusedLineCode)
      : await api.arribos(stopId, '000', { hintLinea });

    if (mySeq !== fetchSeq || !state.activeStop || state.activeStop.id !== stopId) return;

    const wasOffline = state.isOffline;
    state.isOffline = false;
    if (wasOffline) {
      showToast('Conexión recuperada · GPS en línea', 'success', 2400);
    }

    const payload = res.data || {};
    state.dataSource = res.source || 'smartmovepro-soap';
    state.lastSyncAt = new Date();
    state.corridorFleet = Array.isArray(payload.corridorFleet) ? payload.corridorFleet : [];

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

    // Keep full stopLinesList when viewing '000' (merged with offline catalogo + live lines)
    if (!state.focusedLineCode) {
      const linesMap = new Map(state.stopLinesList.map((l) => [Number(l.codigo), l.descripcion]));
      for (const a of rawArribos) {
        if (a.codigoLinea && a.descripcionLinea) {
          linesMap.set(Number(a.codigoLinea), a.descripcionLinea);
        }
      }
      state.stopLinesList = Array.from(linesMap.entries()).map(([codigo, descripcion]) => ({ codigo, descripcion }));
    } else if (state.stopLinesList.length === 0 && rawArribos.length > 0) {
      state.stopLinesList = [{ codigo: state.focusedLineCode, descripcion: rawArribos[0].descripcionLinea }];
    }

    const targetLineCodes = state.focusedLineCode
      ? [state.focusedLineCode]
      : Array.from(
          new Set([
            ...state.stopLinesList.map((l) => Number(l.codigo)),
            ...rawArribos.map((a) => Number(a.codigoLinea))
          ].filter(Boolean))
        );

    await Promise.all([
      ensureScheduleAssetsLoaded(targetLineCodes),
      syncFleetMemory(targetLineCodes, { force: showSkeleton || wasOffline, stopId })
    ]);

    if (mySeq !== fetchSeq || !state.activeStop || state.activeStop.id !== stopId) return;

    const stopCoords =
      typeof state.activeStop.lat === 'number' && typeof state.activeStop.lng === 'number'
        ? { lat: state.activeStop.lat, lng: state.activeStop.lng }
        : payload.stopCoords || null;

    const liveBuses = normalizeArrivals(rawArribos, stopId, stopCoords);

    // Also record Corridor Radar sightings so buses spotted along the route already have penultimate GPS speed when entering arrivals
    const nowRecordMs = Date.now();
    for (const cb of state.corridorFleet) {
      const cbCoche = String(cb.identificadorCoche || '').trim();
      const cbLat = parseFloat(cb.latitud);
      const cbLng = parseFloat(cb.longitud);
      if (cbCoche && cb.codigoLinea && !Number.isNaN(cbLat) && !Number.isNaN(cbLng) && cbLat !== 0 && cbLng !== 0) {
        recordUnitGpsFix(
          `${cb.codigoLinea}-c${cbCoche}`,
          cb.codigoLinea,
          cbCoche,
          cbLat,
          cbLng,
          String(cb.ultimaFechaHoraGPS || '').trim(),
          nowRecordMs
        );
      }
    }

    let reconciled = reconcileWithSchedulePrediction(
      liveBuses,
      stopId,
      stopCoords,
      targetLineCodes,
      { isOffline: false }
    );

    // Single-line mode already probed downstream inside the Worker; only run client fallback in multi-line mode
    // or if Worker returned 0 corridor probes!
    const needsFallbackProbe =
      state.simulateMode && !(state.focusedLineCode && (payload.corridorProbeCount || 0) >= 2);
    if (needsFallbackProbe) {
      const probed = await probeDownstreamForImminentGhosts(reconciled, stopId, stopCoords);
      if (mySeq !== fetchSeq || !state.activeStop || state.activeStop.id !== stopId) return;
      if (probed) {
        reconciled = reconcileWithSchedulePrediction(
          liveBuses,
          stopId,
          stopCoords,
          targetLineCodes,
          { isOffline: false, skipReport: true }
        );
      }
    }

    state.arribos = reconciled;

    // Always learn real speeds & stopped states from fresh GPS fixes; apply smooth non-backjumping motion in EN VIVO
    busSimulator.reconcile(state.arribos, { applyPositions: state.simulateMode, stopId });

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
    else refreshHorariosLiveTags();

    transitMap.updateBuses(state.arribos, {
      filterLine: state.filterLine,
      selectedBusKey: state.selectedBusKey,
      simulateMode: state.simulateMode
    });

    if (state.simulateMode && state.arribos.length > 0) {
      startSimLoop();
    }

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
    if (announceSummary) announceArrivalsSummary({ isRefresh });
  } catch (err) {
    if (mySeq !== fetchSeq || !state.activeStop || state.activeStop.id !== stopId) return;
    const enteringOffline = !state.isOffline;
    state.isOffline = true;
    if (enteringOffline) {
      showToast(
        state.simulateMode
          ? 'Sin conexión · Predicción activa por horarios'
          : 'Sin conexión · Cambiá a EN VIVO para predicción por horarios',
        'info',
        3200
      );
    }
    await renderOfflineOrFallback(showSkeleton, mySeq);
    if (announceSummary) announceArrivalsSummary({ isRefresh });
  } finally {
    if (mySeq === fetchSeq) {
      state.countdownSec = REFRESH_INTERVAL_SEC;
    }
  }
}

// ============================================================================
// Horarios Programados 24h + Inspector Interactivo de Rotaciones de Servicio
// Reconstruye vueltas del mismo coche por DP FIFO respetando horarios cortados
// ============================================================================
function toServiceMinuteOfDay(minOfDay) {
  return minOfDay < 180 ? minOfDay + 1440 : minOfDay;
}

function formatMinuteOfDayHHMM(minOfDay) {
  const m = ((minOfDay % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

function lookupSlotBlockMeta(slotMetaByHora, hora, minuteOfDay) {
  if (!slotMetaByHora || slotMetaByHora.size === 0) return null;
  if (slotMetaByHora.has(hora)) return slotMetaByHora.get(hora);
  if (typeof minuteOfDay === 'number') {
    const prev = formatMinuteOfDayHHMM(minuteOfDay - 1);
    if (slotMetaByHora.has(prev)) return slotMetaByHora.get(prev);
    const next = formatMinuteOfDayHHMM(minuteOfDay + 1);
    if (slotMetaByHora.has(next)) return slotMetaByHora.get(next);
  }
  return null;
}

function computeHorariosLiveMatch(ctx) {
  const todayTipo = getArgentinaTodayTipo();
  const isTodayScheme = ctx.tipoDia === todayTipo;
  const nowArt = getArgentinaNow();
  const nowRawMin = nowArt.getUTCHours() * 60 + nowArt.getUTCMinutes();
  const nowSvcMin = toServiceMinuteOfDay(nowRawMin);

  let slotToBus = new Map();
  if (isTodayScheme && ctx.horarios.length > 0) {
    const lineBuses = state.arribos.filter((b) => Number(b.codigoLinea) === ctx.codLinea);
    slotToBus = matchBusesWithHorarios(lineBuses, ctx.horarios);
  }

  let nextHora = '';
  if (isTodayScheme && ctx.horarios.length > 0) {
    let bestSvc = Infinity;
    for (const h of ctx.horarios) {
      const sm = toServiceMinuteOfDay(h.minuteOfDay);
      if (sm >= nowSvcMin && sm < bestSvc) {
        bestSvc = sm;
        nextHora = h.hora;
      }
    }
  }

  return { isTodayScheme, nowSvcMin, nextHora, slotToBus };
}

function formatFleetSummaryShort(fleetSummary) {
  if (!fleetSummary || !fleetSummary.totalServices) return '';
  const n = fleetSummary.totalServices;
  const sWord = n === 1 ? 'servicio' : 'servicios';
  if (fleetSummary.cortadosCount > 0) {
    return `${n} ${sWord} (${fleetSummary.corridosCount} corridos · ${fleetSummary.cortadosCount} cortados)`;
  }
  return `${n} ${sWord} ${n === 1 ? 'continuo' : 'continuos'}`;
}

function renderRotationBannerContent(ctx, liveInfo, { speakSelection = false } = {}) {
  const banner = document.getElementById('horarios-rotation-banner');
  if (!banner) return;

  const model = ctx?.model;
  if (!model || !model.blocks?.length) {
    banner.classList.add('hidden');
    return;
  }
  banner.classList.remove('hidden');

  const selBlockId = state.horariosSelectedBlockId;
  const selHora = state.horariosSelectedHora;
  const blockSlots = selBlockId ? ctx.blockData?.blockSlotsById?.get(selBlockId) : null;
  const blockInfo = selBlockId ? model.blockInfoById?.get(selBlockId) : null;

  if (!selBlockId || !blockSlots || !blockInfo) {
    const fs = model.fleetSummary;
    const regimeTag = model.isInterprovincial
      ? '<span class="rotation-tag is-continuo">Interprovincial · continuo</span>'
      : fs && fs.cortadosCount > 0 && fs.middayValleyCount < fs.totalServices
        ? `<span class="rotation-tag is-cortado">Valle: ${fs.middayValleyCount} en línea</span>`
        : '<span class="rotation-tag is-continuo">Turno corrido</span>';
    banner.innerHTML = `
      <div class="rotation-banner-head">
        <span class="rotation-hint">Tocá un horario para ver vueltas y turnos del mismo servicio.</span>
        ${regimeTag}
      </div>
    `;
    return;
  }

  const tagCls = blockInfo.isCortado
    ? 'is-cortado'
    : blockInfo.isRelevoEnLinea
      ? 'is-relevo'
      : 'is-continuo';
  const tagText = blockInfo.isCortado
    ? 'Horario cortado'
    : blockInfo.isRelevoEnLinea
      ? 'Relevo en línea'
      : 'Turno corrido';
  const turnoLabel =
    blockInfo.serviceTurnosCount > 1
      ? `Servicio ${blockInfo.serviceNumber} · Turno ${blockInfo.turnoIndex}/${blockInfo.serviceTurnosCount}`
      : `Servicio ${blockInfo.serviceNumber}`;

  const chainHtml = blockSlots
    .map((s, idx) => {
      const delta =
        idx > 0 && typeof s.deltaPrevMin === 'number'
          ? `<span class="rotation-lap-delta" aria-hidden="true">+${s.deltaPrevMin}m →</span>`
          : '';
      const isCur = s.hora === selHora;
      return `${delta}<span class="rotation-lap-chip ${isCur ? 'is-current' : ''}">${escapeHtml(s.hora)}</span>`;
    })
    .join('');

  // Continuity line showing all turnos of this same service across the full service day
  let continuityHtml = '';
  let continuitySpoken = '';
  const allTurnos = Array.isArray(blockInfo.serviceTurnos) ? blockInfo.serviceTurnos : [];
  if (allTurnos.length > 1) {
    const descPieces = [];
    allTurnos.forEach((tr, idx) => {
      const span = `${formatSecHHMM(tr.startSec)}–${formatSecHHMM(tr.endSec)}`;
      const lapsTxt = tr.shiftLaps ? formatShiftLaps(tr.shiftLaps) : '';
      const detail = [lapsTxt, tr.isCortado ? 'cortado' : null].filter(Boolean).join(', ');
      const label = `T${tr.turnoIndex} ${span}${detail ? ` (${detail})` : ''}`;
      descPieces.push(tr.blockId === blockInfo.blockId ? `<strong>${escapeHtml(label)}</strong>` : escapeHtml(label));
      if (idx < allTurnos.length - 1) {
        descPieces.push(tr.relevoToNext ? ' → relevo · ' : ' · ');
      }
    });
    continuityHtml = `<div class="rotation-continuity">Mismo Servicio ${blockInfo.serviceNumber}: ${descPieces.join('')}</div>`;
    const otherTurnos = allTurnos.filter((tr) => tr.blockId !== blockInfo.blockId);
    continuitySpoken =
      ' ' +
      otherTurnos
        .map((tr) => {
          const lapsSpoken = tr.shiftLaps ? ` de ${formatShiftLapsSpoken(tr.shiftLaps)}` : '';
          const relPhrase =
            tr.turnoIndex === blockInfo.turnoIndex + 1 && blockInfo.relevoToNext
              ? 'continúa por relevo en línea'
              : tr.turnoIndex > blockInfo.turnoIndex
                ? 'retoma'
                : 'salió antes';
          return `Mismo Servicio ${blockInfo.serviceNumber} ${relPhrase} en turno ${tr.turnoIndex}${lapsSpoken}, de ${formatSecHHMM(
            tr.startSec
          )} a ${formatSecHHMM(tr.endSec)}.`;
        })
        .join(' ');
  } else if (blockInfo.isRelevoEnLinea) {
    const span = `${formatSecHHMM(blockInfo.startSec)}–${formatSecHHMM(blockInfo.endSec)}`;
    continuityHtml = `<div class="rotation-continuity">Jornada continua ${escapeHtml(span)} con relevo de chofer en línea (~8 h por turno)</div>`;
    continuitySpoken = ` Jornada continua de ${formatSecHHMM(blockInfo.startSec)} a ${formatSecHHMM(blockInfo.endSec)} con relevo de chofer en línea.`;
  }

  // Identify live bus currently serving this block TODAY (never across different days!)
  let liveBlockBus = null;
  if (liveInfo.isTodayScheme) {
    for (const s of blockSlots) {
      const matched = liveInfo.slotToBus.get(s.hora);
      if (matched?.identificadorCoche) {
        liveBlockBus = matched;
        break;
      }
    }
    if (!liveBlockBus) {
      liveBlockBus = state.arribos.find(
        (b) =>
          Number(b.codigoLinea) === ctx.codLinea &&
          b.scheduledTrip?.blockId === selBlockId &&
          b.identificadorCoche
      );
    }
  }

  const shiftLapsVisual = blockInfo.shiftLaps
    ? formatShiftLaps(blockInfo.shiftLaps)
    : `${blockSlots.length} ${blockSlots.length === 1 ? 'vuelta' : 'vueltas'}`;
  const shiftLapsSpoken = blockInfo.shiftLaps
    ? formatShiftLapsSpoken(blockInfo.shiftLaps)
    : `${blockSlots.length} ${blockSlots.length === 1 ? 'vuelta' : 'vueltas'}`;
  const stopPassesNote =
    blockInfo.shiftLaps && Math.abs(blockSlots.length - blockInfo.shiftLaps) > 0.01
      ? ` · ${blockSlots.length} ${blockSlots.length === 1 ? 'paso' : 'pasos'} por esta parada`
      : '';

  const liveNote = liveBlockBus
    ? `Turno de ${escapeHtml(shiftLapsVisual)} · Hoy en servicio: <strong>Coche #${escapeHtml(liveBlockBus.identificadorCoche)}</strong>${
        liveBlockBus.choferNombre ? ` · ${escapeHtml(liveBlockBus.choferNombre)}` : ''
      } (asignación diaria)`
    : `Turno de ${escapeHtml(shiftLapsVisual)}${stopPassesNote} · Coche y chofer rotan cada día.`;

  banner.innerHTML = `
    <div class="rotation-banner-head">
      <div class="rotation-banner-title">
        <span>${escapeHtml(turnoLabel)}</span>
        <span class="rotation-tag ${tagCls}">${tagText}</span>
      </div>
      <button type="button" class="mini-close-btn" data-clear-rotation aria-label="Limpiar selección de servicio">✕</button>
    </div>
    <div class="rotation-laps-chain">${chainHtml}</div>
    ${continuityHtml}
    <div class="rotation-hint">${liveNote}</div>
  `;

  if (speakSelection) {
    const spokenChain = blockSlots
      .map((s, idx) => (idx > 0 && typeof s.deltaPrevMin === 'number' ? `${s.hora} a los ${s.deltaPrevMin} minutos` : s.hora))
      .join(', ');
    const spokenLive = liveBlockBus
      ? ` Hoy en servicio: coche ${liveBlockBus.identificadorCoche}.`
      : ' Coche y chofer rotan cada día.';
    announce(
      `${turnoLabel}, ${tagText}, turno de ${shiftLapsSpoken}. ${blockSlots.length} ${
        blockSlots.length === 1 ? 'paso' : 'pasos'
      } por esta parada: ${spokenChain}.${continuitySpoken}${spokenLive}`
    );
  }
}

function buildHoraPillAriaLabel(hora, slotMeta, matchedBus, isNext) {
  const parts = [hora];
  if (isNext && !matchedBus) parts.push('próximo paso');
  if (matchedBus?.identificadorCoche) {
    parts.push(`coche ${matchedBus.identificadorCoche} en servicio hoy`);
  }
  if (slotMeta?.blockInfo?.serviceNumber) {
    const bi = slotMeta.blockInfo;
    const turnoPart = bi.serviceTurnosCount > 1 ? `, turno ${bi.turnoIndex} de ${bi.serviceTurnosCount}` : '';
    const kindPart = bi.isCortado ? ', horario cortado' : bi.isRelevoEnLinea ? ', relevo en línea' : '';
    const tripLap = slotMeta.trip?.lapNumber;
    const lapPart = tripLap
      ? `, vuelta ${formatLapSpoken(tripLap)}${
          bi.shiftLaps ? ` de ${formatShiftLapsSpoken(bi.shiftLaps)} del turno` : ' del turno'
        }`
      : `, vuelta ${slotMeta.lapAtStop} de ${slotMeta.totalLapsAtStop}`;
    parts.push(`Servicio ${bi.serviceNumber}${turnoPart}${lapPart}${kindPart}`);
  }
  return parts.join(', ');
}

function updateHorariosRotationHighlights({ speakSelection = false } = {}) {
  const ctx = state.horariosViewCtx;
  if (!ctx || !state.horariosOpen) return;
  const selBlockId = state.horariosSelectedBlockId;
  const selHora = state.horariosSelectedHora;
  const selInfo = selBlockId ? ctx.model?.blockInfoById?.get(selBlockId) : null;
  const selSrvStr = selInfo?.serviceNumber ? String(selInfo.serviceNumber) : '';
  const liveInfo = computeHorariosLiveMatch(ctx);

  el.horariosPanel.querySelectorAll('.hora-pill[data-hora]').forEach((pill) => {
    const bId = pill.dataset.blockId || '';
    const srv = pill.dataset.srv || '';
    const hora = pill.dataset.hora || '';
    const inBlock = Boolean(selBlockId && bId && bId === selBlockId);
    const inSiblingTurno = Boolean(!inBlock && selSrvStr && srv === selSrvStr);
    const isSel = inBlock && hora === selHora;
    pill.classList.toggle('is-block-active', inBlock);
    pill.classList.toggle('is-service-sibling', inSiblingTurno);
    pill.classList.toggle('is-block-selected', isSel);
    pill.setAttribute('aria-pressed', String(isSel));
  });

  renderRotationBannerContent(ctx, liveInfo, { speakSelection });
}

function refreshHorariosLiveTags() {
  const ctx = state.horariosViewCtx;
  if (!ctx || !state.horariosOpen) return;
  if (!state.activeStop || ctx.stopId !== state.activeStop.id) return;

  const liveInfo = computeHorariosLiveMatch(ctx);
  const { isTodayScheme, nowSvcMin, nextHora, slotToBus } = liveInfo;

  el.horariosPanel.querySelectorAll('.hora-pill[data-hora]').forEach((pill) => {
    const hora = pill.dataset.hora || '';
    const minOfDay = Number(pill.dataset.min || 0);
    const srvNum = pill.dataset.srv || '';
    const matchedBus = slotToBus.get(hora);
    const svcMin = toServiceMinuteOfDay(minOfDay);
    const isNext = !matchedBus && isTodayScheme && hora === nextHora;

    pill.classList.toggle('has-bus', Boolean(matchedBus));
    pill.classList.toggle('is-next', isNext);
    pill.classList.toggle('is-past', !matchedBus && isTodayScheme && hora !== nextHora && svcMin < nowSvcMin);

    const slotMeta = lookupSlotBlockMeta(ctx.blockData?.slotMetaByHora, hora, minOfDay);
    pill.setAttribute('aria-label', buildHoraPillAriaLabel(hora, slotMeta, matchedBus, isNext));

    const sub = pill.querySelector('[data-hora-sub]');
    if (sub) {
      if (matchedBus?.identificadorCoche) {
        sub.className = 'hora-bus-tag';
        sub.textContent = `#${matchedBus.identificadorCoche}`;
      } else if (srvNum) {
        sub.className = 'hora-srv-tag';
        sub.textContent = `S${srvNum}`;
      } else {
        sub.className = 'hora-srv-tag';
        sub.textContent = '';
      }
    }
  });

  renderRotationBannerContent(ctx, liveInfo);
}

async function toggleHorariosView() {
  if (!state.activeStop) return;
  state.horariosOpen = !state.horariosOpen;
  el.btnToggleHorarios.classList.toggle('active', state.horariosOpen);
  el.btnToggleHorarios.setAttribute('aria-pressed', String(state.horariosOpen));
  el.horariosPanel.classList.toggle('hidden', !state.horariosOpen);
  el.arribosList.classList.toggle('hidden', state.horariosOpen);
  el.lineFilterStrip.classList.toggle('hidden', state.horariosOpen);

  if (!state.horariosOpen) {
    renderArribosList();
    announce('Volviendo al tablero de arribos en vivo.');
    return;
  }

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
  state.horariosSelectedBlockId = null;
  state.horariosSelectedHora = null;
  state.horariosViewCtx = null;

  const stopId = state.activeStop.id;
  const lineObj = state.stopLinesList.find((l) => l.codigo === state.horariosLineCode) || {
    codigo: state.horariosLineCode,
    descripcion: String(state.horariosLineCode)
  };

  const tabsHtml = state.stopLinesList
    .map((l) => {
      const color = getLineColor(l.descripcion);
      const active = l.codigo === state.horariosLineCode;
      return `<button type="button" class="filter-chip ${active ? 'active' : ''}" data-hor-line="${l.codigo}" aria-pressed="${active}" aria-label="Horarios de línea ${escapeHtml(l.descripcion)}" style="--chip-color:${color}">${escapeHtml(
        l.descripcion
      )}</button>`;
    })
    .join('');

  const dayTabs = [
    { key: 'habil', label: 'Lun–Vie', spoken: 'Lunes a viernes' },
    { key: 'sabado', label: 'Sábado', spoken: 'Sábado' },
    { key: 'domingo', label: 'Domingo', spoken: 'Domingo' }
  ];
  const dayTabsHtml = `
    <div class="day-type-tabs" role="tablist" aria-label="Tipo de día">
      ${dayTabs
        .map(
          (d) => {
            const active = state.horariosTipoDia === d.key;
            return `<button type="button" role="tab" aria-selected="${active}" aria-label="${d.spoken}" class="day-tab-btn ${active ? 'active' : ''}" data-hor-day="${d.key}">${d.label}</button>`;
          }
        )
        .join('')}
    </div>
  `;

  el.horariosPanel.innerHTML = `
    <div class="horarios-head">
      <h3>Horarios programados</h3>
      <button type="button" id="btn-close-horarios" class="seg-btn seg-btn-xs" aria-label="Volver a arribos en vivo">← Arribos</button>
    </div>
    <div class="horarios-line-tabs" role="group" aria-label="Seleccionar línea">${tabsHtml}</div>
    ${dayTabsHtml}
    <div class="skeleton-card"></div>
    <div class="skeleton-card"></div>
  `;
  bindHorariosControls();

  try {
    const [res] = await Promise.all([
      api.horarios(stopId, state.horariosLineCode, state.horariosTipoDia),
      ensureScheduleAssetsLoaded([state.horariosLineCode])
    ]);
    if (!state.activeStop || state.activeStop.id !== stopId || !state.horariosOpen) return;

    const data = res.data || {};
    const horarios = Array.isArray(data.horarios) ? data.horarios : [];

    // Reconstruct vehicle rotation blocks for this line & day type (FIFO DP + horarios cortados)
    const branches = state.routeBranchesCache.get(state.horariosLineCode) || [];
    const horFile = state.horariosArchiveCache.get(state.horariosLineCode) || null;
    const stopCoords =
      typeof state.activeStop.lat === 'number' && typeof state.activeStop.lng === 'number'
        ? { lat: state.activeStop.lat, lng: state.activeStop.lng }
        : null;
    const model =
      branches.length && horFile
        ? buildLineScheduleModel(state.horariosLineCode, branches, horFile, state.horariosTipoDia)
        : null;
    const blockData = model && stopCoords ? buildStopTimetableBlocks(model, stopId, stopCoords) : null;

    const ctx = {
      stopId,
      codLinea: state.horariosLineCode,
      tipoDia: state.horariosTipoDia,
      horarios,
      model,
      blockData
    };
    state.horariosViewCtx = ctx;

    const liveInfo = computeHorariosLiveMatch(ctx);
    const { isTodayScheme, nowSvcMin, nextHora, slotToBus } = liveInfo;

    if (isTodayScheme && horarios.length > 0) {
      state.horariosByLineCache.set(`${stopId}:${state.horariosLineCode}:${state.horariosTipoDia}`, horarios);
    }

    const groups = [
      { title: 'Mañana (03:00 – 11:59)', items: horarios.filter((h) => h.minuteOfDay >= 180 && h.minuteOfDay < 720) },
      { title: 'Tarde (12:00 – 19:59)', items: horarios.filter((h) => h.minuteOfDay >= 720 && h.minuteOfDay < 1200) },
      { title: 'Noche y Madrugada (20:00 – 02:59)', items: horarios.filter((h) => h.minuteOfDay >= 1200 || h.minuteOfDay < 180) }
    ].filter((g) => g.items.length > 0);

    const freqText = data.frecuenciaMin ? `Cada ~${data.frecuenciaMin} min` : `${horarios.length} pasos`;
    const fleetShort = formatFleetSummaryShort(model?.fleetSummary);
    const statusTag = res.archived
      ? 'Grilla completa'
      : res.cached
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
          <span><strong>Línea ${escapeHtml(lineObj.descripcion)}</strong>${fleetShort ? ` · ${escapeHtml(fleetShort)}` : ''} · ${escapeHtml(freqText)}</span>
          <span class="mono-meta">${escapeHtml(statusTag)}</span>
        </div>
        <div id="horarios-rotation-banner" class="rotation-banner hidden"></div>
        ${groups
          .map(
            (g) => `
            <div class="horarios-group">
              <span class="micro-heading">${escapeHtml(g.title)}</span>
              <div class="horarios-grid">
                ${g.items
                  .map((h) => {
                    const matchedBus = slotToBus.get(h.hora);
                    const slotMeta = lookupSlotBlockMeta(blockData?.slotMetaByHora, h.hora, h.minuteOfDay);
                    const bId = slotMeta?.blockId || '';
                    const srvNum = slotMeta?.blockInfo?.serviceNumber || '';
                    const svcMin = toServiceMinuteOfDay(h.minuteOfDay);
                    const isNext = !matchedBus && isTodayScheme && h.hora === nextHora;

                    const cls = matchedBus
                      ? 'has-bus'
                      : isNext
                        ? 'is-next'
                        : isTodayScheme && svcMin < nowSvcMin
                          ? 'is-past'
                          : '';

                    const subHtml = matchedBus?.identificadorCoche
                      ? `<span class="hora-bus-tag" data-hora-sub aria-hidden="true">#${escapeHtml(matchedBus.identificadorCoche)}</span>`
                      : srvNum
                        ? `<span class="hora-srv-tag" data-hora-sub aria-hidden="true">S${srvNum}</span>`
                        : `<span class="hora-srv-tag" data-hora-sub aria-hidden="true"></span>`;

                    const ariaLabel = buildHoraPillAriaLabel(h.hora, slotMeta, matchedBus, isNext);
                    return `<button type="button" class="hora-pill ${cls}" data-hora="${escapeHtml(h.hora)}" data-min="${h.minuteOfDay}" data-block-id="${escapeHtml(bId)}" data-srv="${srvNum}" aria-pressed="false" aria-label="${escapeHtml(ariaLabel)}" title="${escapeHtml(ariaLabel)}"><span aria-hidden="true">${escapeHtml(
                      h.hora
                    )}</span>${subHtml}</button>`;
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
        <button type="button" id="btn-close-horarios" class="seg-btn seg-btn-xs" aria-label="Volver a arribos en vivo">← Arribos</button>
      </div>
      <div class="horarios-line-tabs" role="group" aria-label="Seleccionar línea">${tabsHtml}</div>
      ${dayTabsHtml}
      ${bodyHtml}
    `;
    renderRotationBannerContent(ctx, liveInfo);
    bindHorariosControls();

    const daySpoken = dayTabs.find((d) => d.key === state.horariosTipoDia)?.spoken || state.horariosTipoDia;
    if (!data.available || horarios.length === 0) {
      announce(`Línea ${lineObj.descripcion}, ${daySpoken}. Programación aún no publicada.`);
    } else {
      const nextHint = nextHora ? ` Próximo paso programado: ${nextHora}.` : '';
      announce(`Horarios de línea ${lineObj.descripcion}, ${daySpoken}. ${horarios.length} pasos programados.${nextHint}`);
    }
  } catch (err) {
    el.horariosPanel.innerHTML = `
      <div class="horarios-head">
        <h3>Horarios programados</h3>
        <button type="button" id="btn-close-horarios" class="seg-btn seg-btn-xs" aria-label="Volver a arribos en vivo">← Arribos</button>
      </div>
      <div class="horarios-line-tabs" role="group" aria-label="Seleccionar línea">${tabsHtml}</div>
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

function handleHorariosPanelClick(e) {
  if (e.target.closest('[data-clear-rotation]')) {
    state.horariosSelectedBlockId = null;
    state.horariosSelectedHora = null;
    updateHorariosRotationHighlights();
    announce('Selección de servicio limpiada.');
    return;
  }

  const pill = e.target.closest('.hora-pill[data-hora]');
  if (!pill || !el.horariosPanel.contains(pill)) return;
  const bId = pill.dataset.blockId || '';
  const hora = pill.dataset.hora || '';
  if (!bId) {
    showToast('Sin datos de rotación disponibles para este horario', 'info', 1800);
    return;
  }

  if (state.horariosSelectedBlockId === bId && state.horariosSelectedHora === hora) {
    state.horariosSelectedBlockId = null;
    state.horariosSelectedHora = null;
    haptic('light');
    updateHorariosRotationHighlights();
    announce('Selección de servicio limpiada.');
  } else {
    state.horariosSelectedBlockId = bId;
    state.horariosSelectedHora = hora;
    haptic('light');
    updateHorariosRotationHighlights({ speakSelection: true });
  }
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
    el.btnShowRoutes.setAttribute('aria-pressed', 'true');
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
    el.btnShowRoutes.setAttribute('aria-pressed', 'false');
    announce('Recorridos ocultados del mapa.');
    return;
  }

  const unique = [];
  if (state.focusedLineCode) {
    const focused =
      state.stopLinesList.find((l) => Number(l.codigo) === state.focusedLineCode) ||
      state.lineas.find((l) => Number(l.codigo) === state.focusedLineCode);
    unique.push({
      codigoLinea: state.focusedLineCode,
      lineName: focused?.descripcion || state.filterLine || String(state.focusedLineCode)
    });
  } else {
    for (const a of state.arribos) {
      if (!unique.some((u) => u.codigoLinea === a.codigoLinea)) {
        unique.push({ codigoLinea: a.codigoLinea, lineName: a.descripcionLinea });
      }
      if (unique.length >= 3) break;
    }
    if (unique.length === 0) {
      for (const l of state.stopLinesList) {
        unique.push({ codigoLinea: l.codigo, lineName: l.descripcion });
        if (unique.length >= 3) break;
      }
    }
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
// TAB 2: Líneas -> Calles -> Intersecciones -> Paradas | Flota y Choferes
// ============================================================================
function formatRosterClockArt(tsMs) {
  if (!tsMs || !Number.isFinite(Number(tsMs))) return '';
  const d = new Date(Number(tsMs) - 3 * 3600 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

function formatRosterSeenInfo(tsMs, lastDayKey, todayDayKey) {
  const clock = formatRosterClockArt(tsMs);
  if (lastDayKey && todayDayKey && lastDayKey === todayDayKey) {
    return {
      isToday: true,
      badge: 'Hoy',
      whenShort: clock ? `Hoy ${clock}` : 'Hoy',
      whenSpoken: clock ? `hoy a las ${clock}` : 'hoy'
    };
  }
  const d = tsMs ? new Date(Number(tsMs) - 3 * 3600 * 1000) : null;
  const pad = (n) => String(n).padStart(2, '0');
  const dateStr = d ? `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}` : lastDayKey || '';

  let daysAgo = null;
  if (lastDayKey && todayDayKey) {
    const t1 = Date.parse(`${todayDayKey}T12:00:00Z`);
    const t2 = Date.parse(`${lastDayKey}T12:00:00Z`);
    if (Number.isFinite(t1) && Number.isFinite(t2)) {
      daysAgo = Math.max(1, Math.round((t1 - t2) / 86400000));
    }
  }
  if (daysAgo === null && tsMs) {
    daysAgo = Math.max(1, Math.round((Date.now() - Number(tsMs)) / 86400000));
  }

  if (daysAgo === 1) {
    return {
      isToday: false,
      badge: 'Ayer',
      whenShort: clock ? `Ayer ${clock}` : 'Ayer',
      whenSpoken: clock ? `ayer a las ${clock}` : 'ayer'
    };
  }
  return {
    isToday: false,
    badge: daysAgo ? `Hace ${daysAgo}d` : dateStr || 'Reciente',
    whenShort: dateStr && clock ? `${dateStr} ${clock}` : dateStr || 'Reciente',
    whenSpoken: dateStr && clock ? `el ${dateStr} a las ${clock}` : dateStr || 'recientemente'
  };
}

let flotaResumenInFlight = false;
async function loadFlotaResumen(force = false) {
  if (flotaResumenInFlight || state.isOffline) return;
  const now = Date.now();
  if (!force && now - state.flotaSummaryLastFetchMs < 45000) return;
  flotaResumenInFlight = true;
  try {
    const res = await api.flotaResumen();
    const data = res?.data;
    if (data && Array.isArray(data.lineas)) {
      const nextMap = new Map();
      for (const item of data.lineas) {
        nextMap.set(Number(item.codigoLinea), item);
      }
      state.flotaSummaryByLine = nextMap;
      state.flotaSummaryMeta = data.meta || null;
      state.flotaSummaryLastFetchMs = Date.now();
      if (state.drill.step === 'lineas') {
        renderDrilldown();
      }
    }
  } catch {
    // Non-fatal: keep UI responsive even if backend summary is temporarily unavailable
  } finally {
    flotaResumenInFlight = false;
  }
}

function syncLineasFilterPlaceholder() {
  const { step, linea } = state.drill;
  if (step === 'recorrido') {
    el.lineasFilterInput.placeholder = 'Filtrar parada por calle o código...';
    el.lineasFilterInput.setAttribute(
      'aria-label',
      `Filtrar paradas en orden de recorrido de línea ${linea?.descripcion || ''}`.trim()
    );
  } else if (step === 'flota') {
    el.lineasFilterInput.placeholder = 'Filtrar por coche, chofer o servicio...';
    el.lineasFilterInput.setAttribute(
      'aria-label',
      `Filtrar coches, choferes o servicios de línea ${linea?.descripcion || ''}`.trim()
    );
  } else if (step === 'calles') {
    el.lineasFilterInput.placeholder = 'Filtrar calle...';
    el.lineasFilterInput.setAttribute('aria-label', 'Filtrar calles de la línea');
  } else if (step === 'intersecciones') {
    el.lineasFilterInput.placeholder = 'Filtrar intersección...';
    el.lineasFilterInput.setAttribute('aria-label', 'Filtrar intersecciones');
  } else if (step === 'paradas') {
    el.lineasFilterInput.placeholder = 'Filtrar parada...';
    el.lineasFilterInput.setAttribute('aria-label', 'Filtrar paradas');
  } else {
    el.lineasFilterInput.placeholder = 'Filtrar línea...';
    el.lineasFilterInput.setAttribute('aria-label', 'Filtrar lista de líneas');
  }
}

function renderLineasBreadcrumb() {
  const { step, linea, calle, interseccion } = state.drill;
  syncLineasFilterPlaceholder();

  if (step === 'lineas') {
    el.lineasBreadcrumb.innerHTML = `<span class="crumb-current">Todas las líneas · Corrientes (${state.lineas.length})</span>`;
    return;
  }

  const parts = [`<button type="button" class="crumb-btn" data-back="lineas">← Líneas</button>`];
  if (linea) {
    if (step === 'recorrido') {
      parts.push(
        `<span class="crumb-sep" aria-hidden="true">/</span><span class="crumb-current">Línea ${escapeHtml(linea.descripcion)} · Horarios</span>`
      );
      parts.push(
        `<button type="button" class="crumb-btn" data-back="servicios" aria-label="Ver servicios de línea ${escapeHtml(linea.descripcion)}">Servicios</button>`
      );
      parts.push(
        `<button type="button" class="crumb-btn" data-back="flota" aria-label="Ver flota de línea ${escapeHtml(linea.descripcion)}">Flota</button>`
      );
      parts.push(
        `<button type="button" class="crumb-btn" data-back="calles" aria-label="Ver calles de línea ${escapeHtml(linea.descripcion)}">Calles</button>`
      );
    } else if (step === 'flota') {
      parts.push(
        `<span class="crumb-sep" aria-hidden="true">/</span><span class="crumb-current">Línea ${escapeHtml(linea.descripcion)} · Flota</span>`
      );
      parts.push(
        `<button type="button" class="crumb-btn" data-back="recorrido" aria-label="Ver paradas y horarios de línea ${escapeHtml(linea.descripcion)}">Horarios</button>`
      );
      parts.push(
        `<button type="button" class="crumb-btn" data-back="calles" aria-label="Ver calles y paradas de línea ${escapeHtml(linea.descripcion)}">Calles</button>`
      );
    } else if (step === 'calles') {
      parts.push(`<span class="crumb-sep" aria-hidden="true">/</span><span class="crumb-current">Línea ${escapeHtml(linea.descripcion)} · Calles</span>`);
      parts.push(
        `<button type="button" class="crumb-btn" data-back="recorrido" aria-label="Ver paradas y horarios de línea ${escapeHtml(linea.descripcion)}">Horarios</button>`
      );
      parts.push(
        `<button type="button" class="crumb-btn" data-back="flota" aria-label="Ver flota de coches y choferes de línea ${escapeHtml(linea.descripcion)}">Flota</button>`
      );
    } else {
      parts.push(`<span class="crumb-sep" aria-hidden="true">/</span><button type="button" class="crumb-btn" data-back="calles">${escapeHtml(linea.descripcion)}</button>`);
    }
  }
  if (calle && step !== 'flota' && step !== 'recorrido') {
    const shortCalle = calle.descripcion.replace(/\s*-\s*CORRIENTES$/i, '');
    if (step === 'intersecciones') {
      parts.push(`<span class="crumb-sep" aria-hidden="true">/</span><span class="crumb-current">${escapeHtml(shortCalle)}</span>`);
    } else {
      parts.push(`<span class="crumb-sep" aria-hidden="true">/</span><button type="button" class="crumb-btn" data-back="intersecciones">${escapeHtml(shortCalle)}</button>`);
    }
  }
  if (interseccion && step === 'paradas') {
    const shortInt = interseccion.descripcion.replace(/\s*-\s*CORRIENTES$/i, '');
    parts.push(`<span class="crumb-sep" aria-hidden="true">/</span><span class="crumb-current">${escapeHtml(shortInt)}</span>`);
  }

  el.lineasBreadcrumb.innerHTML = parts.join('');
  el.lineasBreadcrumb.querySelectorAll('.crumb-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.back;
      el.lineasFilterInput.value = '';
      if (target === 'lineas') {
        state.drill = { step: 'lineas', linea: null, calle: null, interseccion: null, items: state.lineas };
        renderDrilldown();
        loadFlotaResumen(false);
      } else if (target === 'recorrido' && state.drill.linea) {
        openLineRecorrido(state.drill.linea);
      } else if (target === 'servicios' && state.drill.linea) {
        openLineFlota(state.drill.linea, { initialTab: 'servicios' });
      } else if (target === 'calles' && state.drill.linea) {
        openLineCalles(state.drill.linea);
      } else if (target === 'flota' && state.drill.linea) {
        openLineFlota(state.drill.linea);
      } else if (target === 'intersecciones' && state.drill.linea && state.drill.calle) {
        openCalleIntersecciones(state.drill.calle);
      }
    });
  });
}

function renderLineFlotaView() {
  const linea = state.drill.linea;
  if (!linea) return;
  const fv = state.flotaView;
  const color = getLineColor(linea.descripcion);

  if (fv.loading) {
    el.lineasContent.innerHTML = `<div class="skeleton-card"></div><div class="skeleton-card"></div><div class="skeleton-card"></div>`;
    return;
  }

  if (fv.error) {
    el.lineasContent.innerHTML = `
      <div class="empty-state">
        <h3>No se pudo consultar la flota</h3>
        <p>${escapeHtml(fv.error)}</p>
        <button type="button" id="btn-flota-retry" class="secondary-action-btn">Reintentar</button>
      </div>
    `;
    document.getElementById('btn-flota-retry')?.addEventListener('click', () => openLineFlota(linea, { force: true }));
    return;
  }

  const data = fv.data || { coches: [], choferes: [], todayTrips: [], dayKey: getArgentinaDayKey(), retentionDays: 7, meta: {} };
  const todayKey = data.dayKey || getArgentinaDayKey();
  const retentionDays = data.retentionDays || 7;
  const meta = data.meta || {};
  const model = fv.model || null;
  const nowSec = getArgentinaSecOfDay();
  const allCoches = Array.isArray(data.coches) ? data.coches : [];
  const allChoferes = Array.isArray(data.choferes) ? data.choferes : [];
  const todayTrips = Array.isArray(data.todayTrips) ? data.todayTrips : [];

  // Globally match currently live cars to unique services so live cards never collide
  const liveCoches = allCoches.filter((c) => c.enLineaAhora);
  const liveMatchByCoche = model
    ? matchFreeFleetUnitsToModel(model, liveCoches, nowSec, state.lastRealGpsByUnit)
    : new Map();

  const carByNum = new Map();
  for (const c of allCoches) carByNum.set(c.coche, c);

  const resolveRawCarMeta = (c) =>
    (c.enLineaAhora ? liveMatchByCoche.get(c.coche) : null) || resolveUnitScheduleMeta(model, c, nowSec);

  const normDriverName = (name) =>
    String(name || '')
      .trim()
      .replace(/\s+/g, ' ')
      .replace(/\.+$/, '')
      .toUpperCase();

  const isSameDriver = (legA, nameA, legB, nameB) => {
    const lA = String(legA || '').trim().toUpperCase();
    const lB = String(legB || '').trim().toUpperCase();
    if (lA && lB) return lA === lB;
    const nA = normDriverName(nameA);
    const nB = normDriverName(nameB);
    return Boolean(nA && nB && nA === nB);
  };

  // Build map of blockId -> best today car/driver observation FIRST as the single source of truth
  // shared across Servicios, Choferes, and Coches tabs. Enforces three physical invariants:
  //  1) A turno is marked "En línea" ONLY if that car is currently matched to THAT turno (never on finished morning turnos!).
  //  2) The same physical car cannot be assigned to two truly simultaneous turnos on the same day, while preserving
  //     relevos and brief cross-service boundary handoffs between DIFFERENT drivers (e.g. T1 ending 14:09 / T2 starting 13:58).
  //  3) Driver attribution is strictly scoped per turno (using driver votes from trips & fleet_drivers observed inside THAT turno's window),
  //     so a T2 relevo driver (e.g. GOMEZ R. on #3093) NEVER overwrites T1's driver (e.g. ROMERO L. on #3093)!
  const obsSecFromRecord = (gpsStr, tsMs) => {
    const parsed = parseGpsStampSecOfDay(gpsStr);
    if (parsed !== null) return parsed < 3 * 3600 ? parsed + 86400 : parsed;
    if (typeof tsMs === 'number' && tsMs > 0) {
      const art = new Date(tsMs - 3 * 3600 * 1000);
      const s = art.getUTCHours() * 3600 + art.getUTCMinutes() * 60 + art.getUTCSeconds();
      return s < 3 * 3600 ? s + 86400 : s;
    }
    return null;
  };

  // Filter out stale/future trip_assignments recorded outside the trip's actual active window
  // (e.g. a morning driver near terminal accidentally linked to an upcoming T2 departure 60-90m later).
  const validTodayTrips = model?.tripByKey
    ? todayTrips.filter((t) => {
        const tr = model.tripByKey.get(t.tripKey);
        if (!tr?.blockId || !t.coche) return false;
        const tObsSec = obsSecFromRecord(t.ultimaGps, t.updatedAt);
        if (tObsSec !== null && (tObsSec < tr.startSec - 25 * 60 || tObsSec > tr.endSec + 35 * 60)) {
          return false;
        }
        return true;
      })
    : [];

  const blockAssignMap = new Map();
  if (model) {
    const nowSvcSec = nowSec < 3 * 3600 ? nowSec + 86400 : nowSec;
    const candidatesByBlock = new Map(); // blockId -> Map<coche, candidate>

    const findPrevTurnoInfo = (bi) => {
      if (!bi || !bi.serviceNumber || (bi.turnoIndex || 1) <= 1) return null;
      for (const other of model.blockInfoById?.values() || []) {
        if (other.serviceNumber === bi.serviceNumber && other.turnoIndex === bi.turnoIndex - 1) {
          return other;
        }
      }
      return null;
    };

    const addCandidate = (blockId, coche, entry) => {
      if (!blockId || !coche) return;
      const bi = model.blockInfoById?.get(blockId);
      if (!bi) return;
      let byCar = candidatesByBlock.get(blockId);
      if (!byCar) {
        byCar = new Map();
        candidatesByBlock.set(blockId, byCar);
      }
      const prev = byCar.get(coche);
      const mergedCount = (prev?.tripCount || 0) + (entry.tripDelta || 0);
      const liveMeta = liveMatchByCoche.get(coche) || null;
      const liveBlockId = liveMeta?.blockInfo?.blockId || '';
      const inTurnoWindow = nowSvcSec >= bi.startSec - 15 * 60 && nowSvcSec <= bi.endSec + 25 * 60;
      const isLiveOnBlock = Boolean(
        entry.carEnLinea && (liveBlockId ? liveBlockId === blockId : inTurnoWindow)
      );

      // Per-turno driver voting so a late-login or relevo never overwrites the real driver of this turno
      const driverVotes = prev?.driverVotes ? new Map(prev.driverVotes) : new Map();
      const dName = String(entry.choferNombre || '').trim();
      const dLeg = String(entry.choferLegajo || '').trim();
      if (dName) {
        const dKey = dLeg ? `leg:${dLeg.toUpperCase()}` : `name:${normDriverName(dName)}`;
        const prevVote = driverVotes.get(dKey) || { nombre: dName, legajo: dLeg, weight: 0, latestAt: 0 };
        prevVote.weight += entry.driverWeight || 1;
        prevVote.latestAt = Math.max(prevVote.latestAt, entry.updatedAt || 0);
        if (!prevVote.legajo && dLeg) prevVote.legajo = dLeg;
        driverVotes.set(dKey, prevVote);
      }
      let bestDriver = null;
      for (const v of driverVotes.values()) {
        if (!bestDriver || v.weight > bestDriver.weight || (v.weight === bestDriver.weight && v.latestAt > bestDriver.latestAt)) {
          bestDriver = v;
        }
      }

      const next = {
        blockId,
        startSec: bi.startSec,
        endSec: bi.endSec,
        coche,
        driverVotes,
        choferNombre: bestDriver?.nombre || prev?.choferNombre || '',
        choferLegajo: bestDriver?.legajo || prev?.choferLegajo || '',
        esAdaptado: Boolean(entry.esAdaptado || prev?.esAdaptado),
        enLineaAhora: isLiveOnBlock,
        lat: entry.lat ?? prev?.lat ?? null,
        lng: entry.lng ?? prev?.lng ?? null,
        lastGps: entry.lastGps || prev?.lastGps || '',
        lastStopId: entry.lastStopId || prev?.lastStopId || '',
        bandera: entry.bandera || prev?.bandera || '',
        lapNumber: isLiveOnBlock
          ? liveMeta?.lapNumber || entry.lapNumber || prev?.lapNumber || null
          : entry.lapNumber || prev?.lapNumber || null,
        shiftLaps: bi.shiftLaps || entry.shiftLaps || prev?.shiftLaps || null,
        desvioRaw: entry.desvioRaw || prev?.desvioRaw || '',
        desvioSec: entry.desvioRaw ? entry.desvioSec : prev?.desvioSec ?? entry.desvioSec ?? 0,
        tripCount: mergedCount,
        updatedAt: Math.max(prev?.updatedAt || 0, entry.updatedAt || 0)
      };
      byCar.set(coche, next);
    };

    // 1) Ingest validated today's trip_assignments (strictly keeping each trip's OWN driver, never carRec's later relevo driver!)
    const driverValidatedBlockMap = new Map(); // driverKey -> Map<blockId, { count, latestAt }>
    const getDriverKey = (leg, name) => {
      const l = String(leg || '').trim().toUpperCase();
      if (l) return `leg:${l}`;
      const n = normDriverName(name);
      return n ? `name:${n}` : '';
    };
    for (const t of validTodayTrips) {
      const tr = model.tripByKey?.get(t.tripKey);
      if (!tr?.blockId || !t.coche) continue;
      const bi = model.blockInfoById?.get(tr.blockId);
      const carRec = carByNum.get(t.coche);
      const carObsSec = carRec ? obsSecFromRecord(carRec.lastGps, carRec.lastSeenAt) : null;
      const carInThisBlock = Boolean(
        bi && carObsSec !== null && carObsSec >= bi.startSec - 15 * 60 && carObsSec <= bi.endSec + 20 * 60
      );
      const dk = getDriverKey(t.choferLegajo, t.choferNombre);
      if (dk) {
        let byBlk = driverValidatedBlockMap.get(dk);
        if (!byBlk) {
          byBlk = new Map();
          driverValidatedBlockMap.set(dk, byBlk);
        }
        const prevB = byBlk.get(tr.blockId) || { count: 0, latestAt: 0 };
        prevB.count += 1;
        prevB.latestAt = Math.max(prevB.latestAt, t.updatedAt || 0);
        byBlk.set(tr.blockId, prevB);
      }
      addCandidate(tr.blockId, t.coche, {
        choferNombre: t.choferNombre || (carInThisBlock ? carRec?.lastChoferNombre || '' : ''),
        choferLegajo: t.choferLegajo || (carInThisBlock ? carRec?.lastChoferLegajo || '' : ''),
        driverWeight: t.choferNombre ? 2 : 1,
        esAdaptado: Boolean(t.esAdaptado || carRec?.esAdaptado),
        carEnLinea: Boolean(carRec?.enLineaAhora),
        lat: carInThisBlock ? (carRec?.lastLat ?? t.lat ?? null) : (t.lat ?? carRec?.lastLat ?? null),
        lng: carInThisBlock ? (carRec?.lastLng ?? t.lng ?? null) : (t.lng ?? carRec?.lastLng ?? null),
        lastGps: carInThisBlock ? (carRec?.lastGps || t.ultimaGps || '') : (t.ultimaGps || carRec?.lastGps || ''),
        lastStopId: carInThisBlock ? (carRec?.lastStopId || t.stopId || '') : (t.stopId || carRec?.lastStopId || ''),
        bandera: carInThisBlock ? (carRec?.lastBandera || tr.branch?.bandera || '') : (tr.branch?.bandera || carRec?.lastBandera || ''),
        lapNumber: tr.lapNumber,
        shiftLaps: tr.shiftLaps,
        desvioRaw: carInThisBlock ? (carRec?.lastDesvioRaw || t.desvioRaw || '') : (t.desvioRaw || ''),
        desvioSec: carInThisBlock ? (carRec?.lastDesvioSec ?? t.desvioSec ?? 0) : (t.desvioSec ?? 0),
        tripDelta: 1,
        updatedAt: t.updatedAt || 0
      });
    }

    // 2) Ingest today's drivers directly from fleet_drivers (captures finished T1 relevo drivers even if same car is now on T2!)
    for (const d of allChoferes.filter((x) => x.vistoHoy && x.lastCoche)) {
      const dk = getDriverKey(d.choferLegajo, d.choferNombre);
      const valByBlk = !d.enLineaAhora && dk ? driverValidatedBlockMap.get(dk) : null;
      let bId = '';
      let dMeta = null;
      let fromValidatedTrips = false;
      if (valByBlk && valByBlk.size > 0) {
        let bestB = null;
        for (const [blkId, info] of valByBlk.entries()) {
          if (!bestB || info.count > bestB.count || (info.count === bestB.count && info.latestAt > bestB.latestAt)) {
            bestB = { blkId, ...info };
          }
        }
        if (bestB) {
          bId = bestB.blkId;
          fromValidatedTrips = true;
        }
      }
      if (!bId) {
        dMeta =
          (d.enLineaAhora && liveMatchByCoche.has(d.lastCoche) ? liveMatchByCoche.get(d.lastCoche) : null) ||
          resolveUnitScheduleMeta(model, d, nowSec);
        bId = dMeta?.blockInfo?.blockId || '';
      }
      if (!bId) continue;
      let bi = model.blockInfoById?.get(bId);
      const dObsSec = obsSecFromRecord(d.lastGps, d.lastSeenAt);
      if (!fromValidatedTrips && bi && dObsSec !== null && (dObsSec < bi.startSec - 20 * 60 || dObsSec > bi.endSec + 35 * 60)) {
        continue;
      }
      let reassignedToPrev = false;
      // Guard against a stray end-of-morning-shift ping (e.g. 14:08) falsely claiming an ongoing afternoon turno (13:58-21:55).
      // If that ping lands right after the same service's previous turno (e.g. T1 ending 13:45), re-attribute it to T1 instead!
      if (!fromValidatedTrips && !d.enLineaAhora && bi && dObsSec !== null && dObsSec <= bi.startSec + 25 * 60 && nowSvcSec >= bi.startSec + 60 * 60) {
        const hasTripsInBlock = validTodayTrips.some((t) => {
          const tr = model.tripByKey?.get(t.tripKey);
          return tr?.blockId === bId && isSameDriver(d.choferLegajo, d.choferNombre, t.choferLegajo, t.choferNombre);
        });
        if (!hasTripsInBlock) {
          const prevBi = findPrevTurnoInfo(bi);
          if (prevBi && dObsSec >= prevBi.endSec - 20 * 60 && dObsSec <= prevBi.endSec + 35 * 60) {
            bId = prevBi.blockId;
            bi = prevBi;
            reassignedToPrev = true;
          } else {
            continue;
          }
        }
      }
      const carRec = carByNum.get(d.lastCoche);
      addCandidate(bId, d.lastCoche, {
        choferNombre: d.choferNombre || '',
        choferLegajo: d.choferLegajo || '',
        driverWeight: d.enLineaAhora ? 3 : reassignedToPrev ? 1 : 2,
        esAdaptado: Boolean(d.lastEsAdaptado || carRec?.esAdaptado),
        carEnLinea: Boolean(d.enLineaAhora && carRec?.enLineaAhora),
        lat: d.lastLat ?? carRec?.lastLat ?? null,
        lng: d.lastLng ?? carRec?.lastLng ?? null,
        lastGps: d.lastGps || '',
        lastStopId: d.lastStopId || '',
        bandera: d.lastBandera || '',
        lapNumber: reassignedToPrev ? null : dMeta?.lapNumber || null,
        shiftLaps: bi?.shiftLaps || dMeta?.shiftLaps || null,
        desvioRaw: d.lastDesvioRaw || '',
        desvioSec: d.lastDesvioSec || 0,
        tripDelta: d.enLineaAhora ? 2 : 1,
        updatedAt: d.lastSeenAt || 0
      });
    }

    // 3) Ingest today's cars (matching their current / latest position to its exact turno)
    for (const c of allCoches.filter((x) => x.vistoHoy)) {
      const m = resolveRawCarMeta(c);
      let bId = m?.blockInfo?.blockId;
      if (!bId) continue;
      let bi = model.blockInfoById?.get(bId);
      const cObsSec = obsSecFromRecord(c.lastGps, c.lastSeenAt);
      let reassignedToPrev = false;
      if (!c.enLineaAhora && bi && cObsSec !== null && cObsSec <= bi.startSec + 25 * 60 && nowSvcSec >= bi.startSec + 60 * 60) {
        const hasTripsInBlock = validTodayTrips.some((t) => {
          const tr = model.tripByKey?.get(t.tripKey);
          return tr?.blockId === bId && t.coche === c.coche;
        });
        if (!hasTripsInBlock) {
          const prevBi = findPrevTurnoInfo(bi);
          if (prevBi && cObsSec >= prevBi.endSec - 20 * 60 && cObsSec <= prevBi.endSec + 35 * 60) {
            bId = prevBi.blockId;
            bi = prevBi;
            reassignedToPrev = true;
          } else {
            continue;
          }
        }
      }
      addCandidate(bId, c.coche, {
        choferNombre: c.lastChoferNombre || '',
        choferLegajo: c.lastChoferLegajo || '',
        driverWeight: c.enLineaAhora ? 3 : 1,
        esAdaptado: Boolean(c.esAdaptado),
        carEnLinea: Boolean(c.enLineaAhora),
        lat: c.lastLat,
        lng: c.lastLng,
        lastGps: c.lastGps,
        lastStopId: c.lastStopId,
        bandera: c.lastBandera,
        lapNumber: reassignedToPrev ? null : m.lapNumber,
        shiftLaps: bi?.shiftLaps || m.shiftLaps,
        desvioRaw: c.lastDesvioRaw || '',
        desvioSec: c.lastDesvioSec || 0,
        tripDelta: c.enLineaAhora ? 3 : 1,
        updatedAt: c.lastSeenAt || 0
      });
    }

    // Flatten and resolve globally: highest-confidence (live on block -> most trips -> freshest) claims its block;
    // reject truly simultaneous turno claims by the same car or same driver while allowing brief boundary handoffs.
    const allCands = [];
    for (const byCar of candidatesByBlock.values()) {
      for (const cand of byCar.values()) allCands.push(cand);
    }
    allCands.sort((a, b) => {
      if (a.enLineaAhora !== b.enLineaAhora) return a.enLineaAhora ? -1 : 1;
      if (b.tripCount !== a.tripCount) return b.tripCount - a.tripCount;
      return (b.updatedAt || 0) - (a.updatedAt || 0);
    });

    const claimedWindowsByCoche = new Map(); // coche -> Array<{ startSec, endSec, choferLegajo, choferNombre }>
    const claimedWindowsByDriver = []; // Array<{ startSec, endSec, choferLegajo, choferNombre }>
    for (const cand of allCands) {
      if (blockAssignMap.has(cand.blockId)) continue;
      const used = claimedWindowsByCoche.get(cand.coche) || [];
      const carOverlaps = used.some((w) => {
        const overlapSec = Math.min(cand.endSec, w.endSec) - Math.max(cand.startSec, w.startSec);
        const sameDrv = isSameDriver(cand.choferLegajo, cand.choferNombre, w.choferLegajo, w.choferNombre);
        const maxAllowedOverlapSec = sameDrv || (!cand.choferNombre && !w.choferNombre) ? 20 * 60 : 45 * 60;
        return overlapSec > maxAllowedOverlapSec;
      });
      if (carOverlaps) continue;
      const driverOverlaps =
        cand.choferLegajo || cand.choferNombre
          ? claimedWindowsByDriver.some((w) => {
              if (!isSameDriver(cand.choferLegajo, cand.choferNombre, w.choferLegajo, w.choferNombre)) return false;
              const overlapSec = Math.min(cand.endSec, w.endSec) - Math.max(cand.startSec, w.startSec);
              return overlapSec > 25 * 60;
            })
          : false;
      if (driverOverlaps) continue;
      blockAssignMap.set(cand.blockId, cand);
      used.push({
        startSec: cand.startSec,
        endSec: cand.endSec,
        choferLegajo: cand.choferLegajo,
        choferNombre: cand.choferNombre
      });
      claimedWindowsByCoche.set(cand.coche, used);
      if (cand.choferLegajo || cand.choferNombre) {
        claimedWindowsByDriver.push({
          startSec: cand.startSec,
          endSec: cand.endSec,
          choferLegajo: cand.choferLegajo,
          choferNombre: cand.choferNombre
        });
      }
    }

    // 4) Same-car driver-change relevo clue: if a service's T2 is assigned to car #X with Driver B,
    // and T1 has no assignment yet, check if another unassigned driver A was seen today on #X during T1!
    for (const srv of fv.schedSummary?.services || []) {
      const turnos = srv.turnos || [];
      for (let ti = 1; ti < turnos.length; ti++) {
        const curT = turnos[ti];
        const prevT = turnos[ti - 1];
        const curAssign = blockAssignMap.get(curT.blockId);
        if (!curAssign?.coche || blockAssignMap.has(prevT.blockId)) continue;
        const priorDriver = allChoferes.find((d) => {
          if (!d.vistoHoy || d.lastCoche !== curAssign.coche) return false;
          if (!d.choferLegajo && !d.choferNombre) return false;
          if (isSameDriver(d.choferLegajo, d.choferNombre, curAssign.choferLegajo, curAssign.choferNombre)) return false;
          const alreadyClaimed = claimedWindowsByDriver.some((w) => {
            if (!isSameDriver(d.choferLegajo, d.choferNombre, w.choferLegajo, w.choferNombre)) return false;
            const overlapSec = Math.min(prevT.endSec, w.endSec) - Math.max(prevT.startSec, w.startSec);
            return overlapSec > 25 * 60;
          });
          if (alreadyClaimed) return false;
          const dObs = obsSecFromRecord(d.lastGps, d.lastSeenAt);
          return dObs !== null && dObs >= prevT.startSec - 15 * 60 && dObs <= prevT.endSec + 35 * 60;
        });
        if (priorDriver) {
          blockAssignMap.set(prevT.blockId, {
            blockId: prevT.blockId,
            startSec: prevT.startSec,
            endSec: prevT.endSec,
            coche: curAssign.coche,
            choferNombre: priorDriver.choferNombre || '',
            choferLegajo: priorDriver.choferLegajo || '',
            esAdaptado: Boolean(priorDriver.lastEsAdaptado || curAssign.esAdaptado),
            enLineaAhora: false,
            lat: priorDriver.lastLat ?? curAssign.lat ?? null,
            lng: priorDriver.lastLng ?? curAssign.lng ?? null,
            lastGps: priorDriver.lastGps || '',
            lastStopId: priorDriver.lastStopId || '',
            bandera: priorDriver.lastBandera || curAssign.bandera || '',
            lapNumber: null,
            shiftLaps: prevT.shiftLaps,
            desvioRaw: priorDriver.lastDesvioRaw || '',
            desvioSec: priorDriver.lastDesvioSec || 0,
            tripCount: 1,
            updatedAt: priorDriver.lastSeenAt || 0
          });
          claimedWindowsByDriver.push({
            startSec: prevT.startSec,
            endSec: prevT.endSec,
            choferLegajo: priorDriver.choferLegajo || '',
            choferNombre: priorDriver.choferNombre || ''
          });
        }
      }
    }
  }

  const packBlockAssignMeta = (assign) => {
    const bi = assign?.blockId ? model?.blockInfoById?.get(assign.blockId) : null;
    if (!bi) return null;
    return {
      trip: null,
      blockInfo: bi,
      tripKey: '',
      serviceNumber: bi.serviceNumber,
      turnoIndex: bi.turnoIndex,
      serviceTurnosCount: bi.serviceTurnosCount,
      lapNumber: assign.lapNumber || null,
      shiftLaps: bi.shiftLaps || assign.shiftLaps || null,
      isHalfLap: false,
      isCortado: Boolean(bi.isCortado),
      isRelevoEnLinea: Boolean(bi.isRelevoEnLinea),
      startSec: bi.startSec,
      endSec: bi.endSec,
      startHHMM: formatSecHHMM(bi.startSec),
      endHHMM: formatSecHHMM(bi.endSec)
    };
  };

  const resolveCarMeta = (c) => {
    if (c.enLineaAhora && liveMatchByCoche.has(c.coche)) {
      return liveMatchByCoche.get(c.coche);
    }
    if (c.vistoHoy && blockAssignMap.size > 0) {
      let bestAssign = null;
      for (const assign of blockAssignMap.values()) {
        if (assign.coche !== c.coche) continue;
        const matchesLastDrv = isSameDriver(
          c.lastChoferLegajo,
          c.lastChoferNombre,
          assign.choferLegajo,
          assign.choferNombre
        );
        const prevMatchesLastDrv = bestAssign
          ? isSameDriver(c.lastChoferLegajo, c.lastChoferNombre, bestAssign.choferLegajo, bestAssign.choferNombre)
          : false;
        if (
          !bestAssign ||
          (assign.enLineaAhora && !bestAssign.enLineaAhora) ||
          (assign.enLineaAhora === bestAssign.enLineaAhora && matchesLastDrv && !prevMatchesLastDrv) ||
          (assign.enLineaAhora === bestAssign.enLineaAhora &&
            matchesLastDrv === prevMatchesLastDrv &&
            (assign.endSec || 0) > (bestAssign.endSec || 0))
        ) {
          bestAssign = assign;
        }
      }
      if (bestAssign) {
        const packed = packBlockAssignMeta(bestAssign);
        if (packed) return packed;
      }
    }
    const direct = resolveUnitScheduleMeta(model, c, nowSec);
    if (direct) {
      const bId = direct.blockInfo?.blockId;
      if (c.vistoHoy && bId && blockAssignMap.has(bId)) {
        const claimed = blockAssignMap.get(bId);
        if (claimed.coche && claimed.coche !== c.coche) return null;
      }
      return direct;
    }
    return null;
  };

  const resolveDriverMeta = (d) => {
    if (d.enLineaAhora && d.lastCoche && liveMatchByCoche.has(d.lastCoche)) {
      return liveMatchByCoche.get(d.lastCoche);
    }
    // 1) For today's drivers, consult the unified blockAssignMap first so Choferes & Servicios always agree
    if (d.vistoHoy && blockAssignMap.size > 0) {
      let bestAssign = null;
      for (const assign of blockAssignMap.values()) {
        if (!isSameDriver(d.choferLegajo, d.choferNombre, assign.choferLegajo, assign.choferNombre)) continue;
        if (
          !bestAssign ||
          (assign.enLineaAhora && !bestAssign.enLineaAhora) ||
          (assign.enLineaAhora === bestAssign.enLineaAhora && (assign.updatedAt || 0) > (bestAssign.updatedAt || 0))
        ) {
          bestAssign = assign;
        }
      }
      if (bestAssign) {
        const packed = packBlockAssignMeta(bestAssign);
        if (packed) return packed;
      }
    }
    // 2) Majority block across validated today's recorded trips for this driver (beats a single noisy terminal ping)
    if (d.vistoHoy && model?.tripByKey && validTodayTrips.length > 0) {
      const blockCounts = new Map();
      for (const t of validTodayTrips) {
        if (!isSameDriver(d.choferLegajo, d.choferNombre, t.choferLegajo, t.choferNombre)) continue;
        const tr = model.tripByKey.get(t.tripKey);
        if (!tr?.blockId) continue;
        const cur = blockCounts.get(tr.blockId) || { count: 0, latestAt: 0, tripKey: t.tripKey };
        cur.count += 1;
        if ((t.updatedAt || 0) >= cur.latestAt) {
          cur.latestAt = t.updatedAt || 0;
          cur.tripKey = t.tripKey;
        }
        blockCounts.set(tr.blockId, cur);
      }
      let bestBlk = null;
      for (const [bId, info] of blockCounts.entries()) {
        const claimed = blockAssignMap.get(bId);
        if (
          claimed &&
          (claimed.choferLegajo || claimed.choferNombre) &&
          !isSameDriver(d.choferLegajo, d.choferNombre, claimed.choferLegajo, claimed.choferNombre) &&
          info.count < 2
        ) {
          continue;
        }
        if (!bestBlk || info.count > bestBlk.count || (info.count === bestBlk.count && info.latestAt > bestBlk.latestAt)) {
          bestBlk = { bId, ...info };
        }
      }
      if (bestBlk) {
        const meta = resolveUnitScheduleMeta(model, { tripKey: bestBlk.tripKey }, nowSec);
        if (meta) return meta;
      }
    }
    // 3) Single-ping spatial-temporal / persisted fallback (never claim a today turno already owned by a different driver)
    const direct = resolveUnitScheduleMeta(model, d, nowSec);
    if (direct) {
      const bId = direct.blockInfo?.blockId;
      if (d.vistoHoy && bId && blockAssignMap.has(bId)) {
        const claimed = blockAssignMap.get(bId);
        if (
          (claimed.choferLegajo || claimed.choferNombre) &&
          !isSameDriver(d.choferLegajo, d.choferNombre, claimed.choferLegajo, claimed.choferNombre)
        ) {
          return null;
        }
      }
      return direct;
    }
    return null;
  };

  const formatServiceLineHtml = (srvMeta, isLiveNow, isHistorical = false) => {
    if (!srvMeta?.serviceNumber) return '';
    const srvLabel = `Servicio ${srvMeta.serviceNumber}`;
    const turnoPart = srvMeta.serviceTurnosCount > 1 ? ` · T${srvMeta.turnoIndex}/${srvMeta.serviceTurnosCount}` : '';
    const lapPart =
      isLiveNow && srvMeta.lapNumber
        ? ` · Vta ${formatLapNumber(srvMeta.lapNumber)}${srvMeta.shiftLaps ? `/${formatLapNumber(srvMeta.shiftLaps)}` : ''}`
        : srvMeta.shiftLaps
          ? ` · ${formatShiftLaps(srvMeta.shiftLaps)}`
          : '';
    const spanPart = srvMeta.startHHMM && srvMeta.endHHMM ? ` · ${srvMeta.startHHMM}–${srvMeta.endHHMM}` : '';
    const prefix = isHistorical && !isLiveNow ? 'Hizo ' : '';
    return `<div class="flota-service-line"><span class="flota-srv-pill">${escapeHtml(prefix + srvLabel + turnoPart)}</span><span class="flota-srv-meta">${escapeHtml((lapPart + spanPart).replace(/^\s*·\s*/, ''))}</span></div>`;
  };

  const formatServiceSpoken = (srvMeta, isLiveNow) => {
    if (!srvMeta?.serviceNumber) return '';
    const parts = [`Servicio ${srvMeta.serviceNumber}`];
    if (srvMeta.serviceTurnosCount > 1) parts.push(`turno ${srvMeta.turnoIndex} de ${srvMeta.serviceTurnosCount}`);
    if (isLiveNow && srvMeta.lapNumber) {
      parts.push(`vuelta ${formatLapSpoken(srvMeta.lapNumber)}${srvMeta.shiftLaps ? ` de ${formatLapSpoken(srvMeta.shiftLaps)}` : ''}`);
    }
    if (srvMeta.startHHMM && srvMeta.endHHMM) parts.push(`de ${srvMeta.startHHMM} a ${srvMeta.endHHMM}`);
    return parts.join(', ');
  };

  const scopeCoches = fv.scope === 'hoy' ? allCoches.filter((c) => c.vistoHoy) : allCoches;
  const scopeChoferes = fv.scope === 'hoy' ? allChoferes.filter((d) => d.vistoHoy) : allChoferes;

  const query = el.lineasFilterInput.value.trim().toLowerCase();
  const visibleCoches = query
    ? scopeCoches.filter((c) => {
        const m = resolveCarMeta(c);
        const srvTxt = m?.serviceNumber ? `servicio ${m.serviceNumber} ${m.startHHMM || ''} ${m.endHHMM || ''}` : '';
        return `${c.coche} ${c.lastChoferNombre || ''} ${c.lastChoferLegajo || ''} ${c.lastBandera || ''} ${srvTxt}`
          .toLowerCase()
          .includes(query);
      })
    : scopeCoches;
  const visibleChoferes = query
    ? scopeChoferes.filter((d) => {
        const m = resolveDriverMeta(d);
        const srvTxt = m?.serviceNumber ? `servicio ${m.serviceNumber} ${m.startHHMM || ''} ${m.endHHMM || ''}` : '';
        return `${d.choferNombre || ''} ${d.choferLegajo || ''} ${d.lastCoche || ''} ${d.lastBandera || ''} ${srvTxt}`
          .toLowerCase()
          .includes(query);
      })
    : scopeChoferes;

  const allServices = Array.isArray(fv.schedSummary?.services) ? fv.schedSummary.services : [];
  const visibleServices = query
    ? allServices.filter((s) => {
        const turnosTxt = (s.turnos || [])
          .map((t) => {
            const a = blockAssignMap.get(t.blockId);
            return `${formatSecHHMM(t.startSec)} ${formatSecHHMM(t.endSec)} ${a?.coche || ''} ${a?.choferNombre || ''}`;
          })
          .join(' ');
        return `servicio ${s.serviceNumber} ${turnosTxt}`.toLowerCase().includes(query);
      })
    : allServices;

  const lastScanClock = formatRosterClockArt(meta.lastCronAt || meta.lastCycleAt);
  const autoMetaText = lastScanClock
    ? `Sistema · Act. auto ${lastScanClock} · Renovación ${retentionDays}d`
    : `Sistema · Escaneo automático cada ${meta.scanIntervalMin || 5} min · Renovación ${retentionDays}d`;

  const hoyCochesCount = allCoches.filter((c) => c.vistoHoy).length;
  const hoyChoferesCount = allChoferes.filter((d) => d.vistoHoy).length;
  const activeCount =
    fv.tab === 'coches' ? visibleCoches.length : fv.tab === 'choferes' ? visibleChoferes.length : visibleServices.length;
  const activeScopeTotal =
    fv.tab === 'coches' ? scopeCoches.length : fv.tab === 'choferes' ? scopeChoferes.length : allServices.length;

  const clickTargets = [];

  let listHtml = '';
  if (fv.tab === 'coches') {
    if (visibleCoches.length === 0) {
      listHtml = `
        <div class="empty-state">
          <h3>${query ? 'Sin coches coincidentes' : fv.scope === 'hoy' ? 'Sin coches registrados hoy' : 'Sin coches registrados todavía'}</h3>
          <p>${
            query
              ? 'Probá con otro número de coche, servicio o apellido de chofer.'
              : fv.scope === 'hoy' && allCoches.length > 0
                ? `Hoy todavía no se detectaron unidades activas. Cambiá a Últimos ${retentionDays} días para ver los ${allCoches.length} coches recientes de la línea.`
                : 'El sistema escanea automáticamente todas las líneas cada pocos minutos y guarda la flota en el servidor.'
          }</p>
        </div>
      `;
    } else {
      listHtml = `
        <ul class="flota-list" role="list" aria-label="Flota de coches de línea ${escapeHtml(linea.descripcion)}">
          ${visibleCoches
            .map((c) => {
              const seen = formatRosterSeenInfo(c.lastSeenAt, c.lastDayKey, todayKey);
              const isLiveNow = Boolean(c.enLineaAhora);
              const badgeLabel = isLiveNow ? 'En línea' : seen.badge;
              const srvMeta = resolveCarMeta(c);
              const driverTxt = c.lastChoferNombre
                ? `${c.lastChoferNombre}${c.lastChoferLegajo ? ` (${c.lastChoferLegajo})` : ''}`
                : '';
              const targetIdx = clickTargets.length;
              clickTargets.push({
                codLinea: linea.codigo,
                lineName: linea.descripcion,
                coche: c.coche,
                choferNombre: c.lastChoferNombre || '',
                choferLegajo: c.lastChoferLegajo || '',
                esAdaptado: Boolean(c.esAdaptado),
                lat: c.lastLat,
                lng: c.lastLng,
                bandera: c.lastBandera || '',
                lastGps: c.lastGps || '',
                lastStopId: c.lastStopId || '',
                desvioRaw: c.lastDesvioRaw || '',
                desvioSec: c.lastDesvioSec || 0,
                enLineaAhora: isLiveNow,
                lastSeenLabel: seen.whenShort,
                serviceMeta: srvMeta
              });
              const srParts = [
                `Coche ${c.coche}${c.esAdaptado ? ', unidad adaptada' : ''}`,
                isLiveNow
                  ? `en línea ahora, visto ${seen.whenSpoken}`
                  : seen.isToday
                    ? `en servicio hoy, visto ${seen.whenSpoken}`
                    : `visto por última vez ${seen.whenSpoken}`,
                formatServiceSpoken(srvMeta, isLiveNow),
                driverTxt
                  ? `chofer: ${c.lastChoferNombre}${c.lastChoferLegajo ? `, legajo ${c.lastChoferLegajo}` : ''}`
                  : 'chofer sin datos',
                'Tocá para ver en el mapa'
              ].filter(Boolean);
              return `
                <li class="flota-row flota-row-clickable ${isLiveNow ? 'is-live' : seen.isToday ? 'is-today' : 'is-recent'}" style="--line-color:${color}">
                  <button type="button" class="flota-row-btn" data-locate-idx="${targetIdx}" aria-label="${escapeHtml(srParts.join('. '))}">
                    <div class="flota-row-visual" aria-hidden="true">
                      <div class="flota-row-head">
                        <div class="flota-row-primary">
                          <span class="flota-coche-title">#${escapeHtml(c.coche)}</span>
                          ${c.esAdaptado ? `<span class="adapted-icon-badge" title="Unidad adaptada">♿</span>` : ''}
                        </div>
                        <span class="flota-status-pill ${isLiveNow ? 'is-live' : seen.isToday ? 'is-today' : 'is-recent'}">${escapeHtml(badgeLabel)}</span>
                      </div>
                      ${formatServiceLineHtml(srvMeta, isLiveNow, !isLiveNow)}
                      <div class="flota-row-sub">
                        <span>${driverTxt ? `${isLiveNow ? 'Chofer' : 'Últ. chofer'}: <strong>${escapeHtml(c.lastChoferNombre)}</strong>${c.lastChoferLegajo ? ` <span class="legajo-chip">${escapeHtml(c.lastChoferLegajo)}</span>` : ''}` : 'Chofer s/d'}</span>
                      </div>
                      <div class="flota-row-foot">
                        <span class="flota-bandera-txt">${escapeHtml(c.lastBandera || `Línea ${linea.descripcion}`)}</span>
                        <span class="flota-map-cue">${escapeHtml(seen.whenShort)} · Mapa ›</span>
                      </div>
                    </div>
                  </button>
                </li>
              `;
            })
            .join('')}
        </ul>
      `;
    }
  } else if (fv.tab === 'choferes') {
    if (visibleChoferes.length === 0) {
      listHtml = `
        <div class="empty-state">
          <h3>${query ? 'Sin choferes coincidentes' : fv.scope === 'hoy' ? 'Sin choferes registrados hoy' : 'Sin choferes registrados todavía'}</h3>
          <p>${
            query
              ? 'Probá con otro nombre, legajo, servicio o número de coche.'
              : fv.scope === 'hoy' && allChoferes.length > 0
                ? `Hoy todavía no se detectaron choferes activos. Cambiá a Últimos ${retentionDays} días para ver los ${allChoferes.length} choferes recientes de la línea.`
                : 'El sistema registra automáticamente a cada chofer y el último coche en el que fue visto en el servidor.'
          }</p>
        </div>
      `;
    } else {
      listHtml = `
        <ul class="flota-list" role="list" aria-label="Choferes de línea ${escapeHtml(linea.descripcion)}">
          ${visibleChoferes
            .map((d) => {
              const seen = formatRosterSeenInfo(d.lastSeenAt, d.lastDayKey, todayKey);
              const isLiveNow = Boolean(d.enLineaAhora);
              const badgeLabel = isLiveNow ? 'En línea' : seen.badge;
              const srvMeta = resolveDriverMeta(d);
              const targetIdx = clickTargets.length;
              clickTargets.push({
                codLinea: linea.codigo,
                lineName: linea.descripcion,
                coche: d.lastCoche || '',
                choferNombre: d.choferNombre || '',
                choferLegajo: d.choferLegajo || '',
                esAdaptado: Boolean(d.lastEsAdaptado),
                lat: d.lastLat,
                lng: d.lastLng,
                bandera: d.lastBandera || '',
                lastGps: d.lastGps || '',
                lastStopId: d.lastStopId || '',
                desvioRaw: d.lastDesvioRaw || '',
                desvioSec: d.lastDesvioSec || 0,
                enLineaAhora: isLiveNow,
                lastSeenLabel: seen.whenShort,
                serviceMeta: srvMeta
              });
              const srParts = [
                `Chofer ${d.choferNombre}${d.choferLegajo ? `, legajo ${d.choferLegajo}` : ''}`,
                isLiveNow ? 'en línea ahora' : seen.whenSpoken,
                formatServiceSpoken(srvMeta, isLiveNow),
                d.lastCoche
                  ? `${isLiveNow ? 'en el coche' : 'último coche'} ${d.lastCoche}${d.lastEsAdaptado ? ', unidad adaptada' : ''}`
                  : 'último coche sin datos',
                'Tocá para ver en el mapa'
              ].filter(Boolean);
              return `
                <li class="flota-row flota-row-clickable ${isLiveNow ? 'is-live' : seen.isToday ? 'is-today' : 'is-recent'}" style="--line-color:${color}">
                  <button type="button" class="flota-row-btn" data-locate-idx="${targetIdx}" aria-label="${escapeHtml(srParts.join('. '))}">
                    <div class="flota-row-visual" aria-hidden="true">
                      <div class="flota-row-head">
                        <div class="flota-row-primary">
                          <span class="flota-driver-title">${escapeHtml(d.choferNombre)}</span>
                          ${d.choferLegajo ? `<span class="legajo-chip">${escapeHtml(d.choferLegajo)}</span>` : ''}
                        </div>
                        <span class="flota-status-pill ${isLiveNow ? 'is-live' : seen.isToday ? 'is-today' : 'is-recent'}">${escapeHtml(badgeLabel)}</span>
                      </div>
                      ${formatServiceLineHtml(srvMeta, isLiveNow, !isLiveNow)}
                      <div class="flota-row-sub">
                        <span class="flota-last-coche">${isLiveNow ? 'Coche actual' : 'Último coche'}: <strong>#${escapeHtml(d.lastCoche || '—')}</strong>${d.lastEsAdaptado ? ' <span class="adapted-icon-badge">♿</span>' : ''}</span>
                      </div>
                      <div class="flota-row-foot">
                        <span class="flota-bandera-txt">${escapeHtml(d.lastBandera || `Línea ${linea.descripcion}`)}</span>
                        <span class="flota-map-cue">${escapeHtml(seen.whenShort)} · Mapa ›</span>
                      </div>
                    </div>
                  </button>
                </li>
              `;
            })
            .join('')}
        </ul>
      `;
    }
  } else {
    // TAB 3: SERVICIOS — Clean start/end schedule per service & turno + assigned car & driver today
    if (visibleServices.length === 0) {
      listHtml = `
        <div class="empty-state">
          <h3>${query ? 'Sin servicios coincidentes' : 'Sin horarios programados'}</h3>
          <p>${query ? 'Probá con otro número de servicio, horario, coche o chofer.' : 'Esta línea no tiene grilla horaria fija publicada.'}</p>
        </div>
      `;
    } else {
      listHtml = `
        <ul class="flota-list" role="list" aria-label="Servicios y horarios de línea ${escapeHtml(linea.descripcion)}">
          ${visibleServices
            .map((s) => {
              const turnosHtml = (s.turnos || [])
                .map((t) => {
                  const startHH = formatSecHHMM(t.startSec);
                  const endHH = formatSecHHMM(t.endSec);
                  const assign = blockAssignMap.get(t.blockId) || null;
                  const isLiveNow = Boolean(assign?.enLineaAhora);
                  const regimeTxt = t.isCortado ? 'Cortado' : t.isRelevoEnLinea ? 'Relevo' : 'Corrido';
                  const lapsTxt = t.shiftLaps ? formatShiftLaps(t.shiftLaps) : '';
                  const lapLiveTxt =
                    isLiveNow && assign?.lapNumber
                      ? `Vta ${formatLapNumber(assign.lapNumber)}${t.shiftLaps ? `/${formatLapNumber(t.shiftLaps)}` : ''}`
                      : '';
                  let assignHtml = `<span class="srv-turno-unassigned">Sin registro hoy</span>`;
                  let btnOpen = `<div class="srv-turno-row">`;
                  let btnClose = `</div>`;

                  if (assign) {
                    const targetIdx = clickTargets.length;
                    clickTargets.push({
                      codLinea: linea.codigo,
                      lineName: linea.descripcion,
                      coche: assign.coche,
                      choferNombre: assign.choferNombre,
                      choferLegajo: assign.choferLegajo,
                      esAdaptado: assign.esAdaptado,
                      lat: assign.lat,
                      lng: assign.lng,
                      bandera: assign.bandera,
                      lastGps: assign.lastGps,
                      lastStopId: assign.lastStopId,
                      desvioRaw: assign.desvioRaw,
                      desvioSec: assign.desvioSec,
                      enLineaAhora: isLiveNow,
                      lastSeenLabel: isLiveNow ? 'En línea' : 'Hoy',
                      serviceMeta: {
                        serviceNumber: s.serviceNumber,
                        turnoIndex: t.turnoIndex,
                        serviceTurnosCount: s.turnos.length,
                        lapNumber: assign.lapNumber,
                        shiftLaps: t.shiftLaps,
                        isCortado: t.isCortado,
                        isRelevoEnLinea: t.isRelevoEnLinea,
                        startHHMM: startHH,
                        endHHMM: endHH
                      }
                    });
                    const drvLabel = assign.choferNombre
                      ? ` · ${escapeHtml(assign.choferNombre)}`
                      : '';
                    assignHtml = `
                      <span class="srv-turno-assigned">
                        <strong>#${escapeHtml(assign.coche)}</strong>${drvLabel}
                      </span>
                      <span class="flota-status-pill ${isLiveNow ? 'is-live' : 'is-today'}">${escapeHtml(
                        isLiveNow ? (lapLiveTxt ? `En línea · ${lapLiveTxt}` : 'En línea') : 'Hoy · Mapa ›'
                      )}</span>
                    `;
                    const srLbl = `Servicio ${s.serviceNumber}, Turno ${t.turnoIndex} de ${startHH} a ${endHH}, ${lapsTxt}. Coche ${assign.coche}${
                      assign.choferNombre ? `, chofer ${assign.choferNombre}` : ''
                    }${isLiveNow ? ', en línea ahora' : ''}. Tocá para ver en el mapa.`;
                    btnOpen = `<button type="button" class="srv-turno-row is-clickable ${isLiveNow ? 'is-live' : ''}" data-locate-idx="${targetIdx}" aria-label="${escapeHtml(srLbl)}">`;
                    btnClose = `</button>`;
                  }

                  return `
                    ${btnOpen}
                      <div class="srv-turno-top">
                        <span class="srv-turno-time">T${t.turnoIndex} · <strong>${escapeHtml(startHH)} – ${escapeHtml(endHH)}</strong></span>
                        <span class="srv-turno-meta">${escapeHtml([lapsTxt, regimeTxt].filter(Boolean).join(' · '))}</span>
                      </div>
                      <div class="srv-turno-bottom">
                        ${assignHtml}
                      </div>
                    ${btnClose}
                  `;
                })
                .join('');

              return `
                <li class="flota-row flota-srv-card" style="--line-color:${color}">
                  <div class="flota-srv-card-head">
                    <span class="flota-coche-title">Servicio ${s.serviceNumber}</span>
                    <span class="mono-meta">${s.turnos.length} ${s.turnos.length === 1 ? 'turno' : 'turnos'}</span>
                  </div>
                  <div class="srv-turnos-stack">
                    ${turnosHtml}
                  </div>
                </li>
              `;
            })
            .join('')}
        </ul>
      `;
    }
  }

  const sched = fv.schedSummary;
  const cap = data.capacity || null;
  const activeNowCount =
    typeof cap?.activeNow === 'number'
      ? cap.activeNow
      : allCoches.filter((c) => c.enLineaAhora).length;
  const peakSimultaneousToday =
    typeof cap?.peakSimultaneousToday === 'number' && cap.peakSimultaneousToday > 0
      ? cap.peakSimultaneousToday
      : Math.max(activeNowCount, Math.min(hoyCochesCount, sched?.totalServices || hoyCochesCount));
  const replacementSwapsToday =
    typeof cap?.replacementSwapsToday === 'number'
      ? cap.replacementSwapsToday
      : Math.max(0, hoyCochesCount - peakSimultaneousToday);
  const learnedTypicalToday = Number(cap?.learnedTypicalToday) || 0;

  let crossCardHtml = '';
  if ((sched && sched.totalServices > 0) || hoyCochesCount > 0 || learnedTypicalToday > 0) {
    const tipoKey = sched?.tipoDia || cap?.tipoDia || getArgentinaTodayTipo();
    const tipoLabel =
      tipoKey === 'domingo' ? 'Domingo' : tipoKey === 'sabado' ? 'Sábado' : 'Lun–Vie';
    const schedTotal = sched?.totalServices || 0;
    const schedVal =
      schedTotal > 0
        ? `${schedTotal} ${schedTotal === 1 ? 'servicio' : 'servicios'}`
        : learnedTypicalToday > 0
          ? `${learnedTypicalToday} ${learnedTypicalToday === 1 ? 'coche típico' : 'coches típicos'}`
          : 'Sin horario fijo';

    let schedSub = '';
    if (schedTotal > 0) {
      const baseRegime =
        sched.cortadosCount > 0
          ? `${sched.corridosCount} corridos · ${sched.cortadosCount} cortados${
              sched.middayValleyCount < schedTotal ? ` · valle ${sched.middayValleyCount}` : ''
            }`
          : `${schedTotal === 1 ? 'Turno continuo' : 'Todos corridos'}${
              sched.relevoEnLineaCount > 0 ? ` · ${sched.relevoEnLineaCount} c/ relevo` : ''
            }`;
      let deltaTag = '';
      const compareRef = peakSimultaneousToday > 0 ? peakSimultaneousToday : learnedTypicalToday;
      if (compareRef > 0) {
        const diff = compareRef - schedTotal;
        if (diff === 0 && peakSimultaneousToday > 0) {
          deltaTag = ' · Flota completa';
        } else if (diff > 0) {
          deltaTag = ` · +${diff} refuerzo detectado`;
        } else if (diff < 0 && learnedTypicalToday > 0 && learnedTypicalToday < schedTotal && (cap?.sampleDaysForTipo || 0) >= 2) {
          deltaTag = ` · Típico real: ${learnedTypicalToday}`;
        }
      }
      schedSub = `${baseRegime}${deltaTag}`;
    } else {
      schedSub = 'Aprendido por escaneo automático';
    }

    const obsVal =
      peakSimultaneousToday > 0
        ? `${peakSimultaneousToday} ${peakSimultaneousToday === 1 ? 'simultáneo' : 'simultáneos'} hoy`
        : `${hoyCochesCount} ${hoyCochesCount === 1 ? 'coche' : 'coches'} hoy`;

    const obsSubParts = [];
    if (activeNowCount > 0) {
      obsSubParts.push(`${activeNowCount} en línea ahora`);
    }
    if (replacementSwapsToday > 0) {
      obsSubParts.push(
        `${hoyCochesCount} internos (${replacementSwapsToday} ${replacementSwapsToday === 1 ? 'reemplazo' : 'reemplazos'})`
      );
    } else if (peakSimultaneousToday > 0 && hoyCochesCount !== peakSimultaneousToday) {
      obsSubParts.push(`${hoyCochesCount} vistos hoy`);
    }
    if (learnedTypicalToday > 0 && learnedTypicalToday !== peakSimultaneousToday) {
      obsSubParts.push(`típico ${learnedTypicalToday}`);
    }
    obsSubParts.push(`${allCoches.length} en ${retentionDays}d · ${allChoferes.length} chof.`);
    const obsSub = obsSubParts.join(' · ');

    const srCross = `Programación ${tipoLabel}: ${schedVal}, ${schedSub.replace(/·/g, ',')}. Detectado en tiempo real por el sistema: ${obsVal}, ${obsSub.replace(/·/g, ',')}.`;
    crossCardHtml = `
      <div class="flota-cross-card" role="region" aria-label="Cruce de servicios programados y flota simultánea real">
        <span class="sr-only">${escapeHtml(srCross)}</span>
        <div class="flota-cross-cell" aria-hidden="true">
          <span class="flota-cross-label">Programado · ${escapeHtml(tipoLabel)}</span>
          <span class="flota-cross-val">${escapeHtml(schedVal)}</span>
          <span class="flota-cross-sub">${escapeHtml(schedSub)}</span>
        </div>
        <div class="flota-cross-cell" aria-hidden="true">
          <span class="flota-cross-label">Flota real · Sistema</span>
          <span class="flota-cross-val">${escapeHtml(obsVal)}</span>
          <span class="flota-cross-sub">${escapeHtml(obsSub)}</span>
        </div>
      </div>
    `;
  }

  const scopeBarHtml =
    fv.tab === 'servicios'
      ? `
      <div class="flota-scope-bar">
        <span class="mono-meta">Inicio y fin de cada turno · Tocá un servicio activo para ver en el mapa</span>
        <span class="mono-meta">${activeCount} srv.</span>
      </div>
    `
      : `
      <div class="flota-scope-bar">
        <div class="flota-scope-group" role="group" aria-label="Período de la lista">
          <button type="button" class="seg-btn seg-btn-xs ${fv.scope === 'semana' ? 'active' : ''}" data-flota-scope="semana" aria-pressed="${fv.scope === 'semana'}">Últimos ${retentionDays} días</button>
          <button type="button" class="seg-btn seg-btn-xs ${fv.scope === 'hoy' ? 'active' : ''}" data-flota-scope="hoy" aria-pressed="${fv.scope === 'hoy'}">Hoy (${fv.tab === 'coches' ? hoyCochesCount : hoyChoferesCount})</button>
        </div>
        <span class="mono-meta">${query ? `${activeCount} de ${activeScopeTotal}` : `${activeCount} reg.`}</span>
      </div>
    `;

  el.lineasContent.innerHTML = `
    <div class="flota-view">
      <div class="flota-system-bar">
        <div class="flota-system-info">
          <div class="flota-system-title">
            <span class="line-tile-swatch" style="background:${color}" aria-hidden="true"></span>
            <span>Línea ${escapeHtml(linea.descripcion)}</span>
          </div>
          <span class="flota-system-meta">${escapeHtml(autoMetaText)}</span>
        </div>
        <button type="button" id="btn-flota-refresh" class="mini-action-btn" title="Actualizar lista desde el servidor" aria-label="Actualizar lista de coches y choferes de línea ${escapeHtml(linea.descripcion)} desde el servidor">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
            <path d="M21 12a9 9 0 1 1-2.64-6.36"/>
            <polyline points="21 3 21 9 15 9"/>
          </svg>
        </button>
      </div>

      ${crossCardHtml}

      <div class="flota-tabs-bar flota-tabs-3" role="tablist" aria-label="Ver coches, choferes o servicios">
        <button type="button" class="flota-tab-btn ${fv.tab === 'coches' ? 'active' : ''}" data-flota-tab="coches" role="tab" aria-selected="${fv.tab === 'coches'}" tabindex="${fv.tab === 'coches' ? '0' : '-1'}">Coches (${scopeCoches.length})</button>
        <button type="button" class="flota-tab-btn ${fv.tab === 'choferes' ? 'active' : ''}" data-flota-tab="choferes" role="tab" aria-selected="${fv.tab === 'choferes'}" tabindex="${fv.tab === 'choferes' ? '0' : '-1'}">Choferes (${scopeChoferes.length})</button>
        <button type="button" class="flota-tab-btn ${fv.tab === 'servicios' ? 'active' : ''}" data-flota-tab="servicios" role="tab" aria-selected="${fv.tab === 'servicios'}" tabindex="${fv.tab === 'servicios' ? '0' : '-1'}">Servicios (${allServices.length})</button>
      </div>

      ${scopeBarHtml}

      ${listHtml}
    </div>
  `;

  document.getElementById('btn-flota-refresh')?.addEventListener('click', () => {
    haptic('light');
    openLineFlota(linea, { force: true, announceLoad: true });
  });

  const subTabs = Array.from(el.lineasContent.querySelectorAll('[data-flota-tab]'));
  subTabs.forEach((btn, idx) => {
    btn.addEventListener('click', () => {
      const next = btn.dataset.flotaTab;
      if (state.flotaView.tab === next) return;
      state.flotaView.tab = next;
      haptic('light');
      renderLineFlotaView();
      const count = next === 'coches' ? scopeCoches.length : next === 'choferes' ? scopeChoferes.length : allServices.length;
      announce(
        next === 'coches'
          ? `Lista de coches de línea ${linea.descripcion}: ${count} ${count === 1 ? 'coche' : 'coches'}.`
          : next === 'choferes'
            ? `Lista de choferes de línea ${linea.descripcion}: ${count} ${count === 1 ? 'chofer' : 'choferes'}.`
            : `Horarios de servicios de línea ${linea.descripcion}: ${count} ${count === 1 ? 'servicio' : 'servicios'}.`
      );
    });
    btn.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        const dir = e.key === 'ArrowRight' ? 1 : -1;
        const nextBtn = subTabs[(idx + dir + subTabs.length) % subTabs.length];
        nextBtn?.click();
        el.lineasContent.querySelector(`[data-flota-tab="${state.flotaView.tab}"]`)?.focus();
      }
    });
  });

  el.lineasContent.querySelectorAll('[data-flota-scope]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const next = btn.dataset.flotaScope;
      if (state.flotaView.scope === next) return;
      state.flotaView.scope = next;
      haptic('light');
      renderLineFlotaView();
      const label = next === 'hoy' ? 'de hoy' : `de los últimos ${retentionDays} días`;
      const cCount = next === 'hoy' ? hoyCochesCount : allCoches.length;
      const dCount = next === 'hoy' ? hoyChoferesCount : allChoferes.length;
      announce(`Mostrando registros ${label}: ${cCount} coches y ${dCount} choferes.`);
    });
  });

  el.lineasContent.querySelectorAll('[data-locate-idx]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = Number(btn.dataset.locateIdx);
      const target = clickTargets[idx];
      if (target) locateFleetUnitOnMap(target);
    });
  });
}

async function computeLineScheduledFleetSummary(codLinea) {
  const num = Number(codLinea);
  if (!num) return null;
  try {
    let branches = state.routeBranchesCache.get(num);
    if (!branches) {
      const recRes = await api.recorridos(num).catch(() => null);
      if (Array.isArray(recRes?.data) && recRes.data.length > 0) {
        branches = parseRouteBranches(recRes.data);
        state.routeBranchesCache.set(num, branches);
      }
    }
    let horFile = state.horariosArchiveCache.get(num);
    if (horFile === undefined) {
      horFile = await api.horariosLineArchive(num).catch(() => null);
      state.horariosArchiveCache.set(num, horFile || null);
    }
    if (!branches?.length || !horFile) return null;
    const todayTipo = getArgentinaTodayTipo();
    const model = buildLineScheduleModel(num, branches, horFile, todayTipo);
    if (!model?.fleetSummary) return null;
    return { ...model.fleetSummary, tipoDia: model.tipoDia, _model: model };
  } catch {
    return null;
  }
}

async function openLineFlota(linea, { force = true, announceLoad = true, initialTab = null } = {}) {
  el.lineasFilterInput.value = '';
  const sameLine = state.drill.step === 'flota' && state.drill.linea?.codigo === linea.codigo;
  state.drill = { step: 'flota', linea, calle: null, interseccion: null, items: [] };
  if (!sameLine) {
    state.flotaView = {
      tab: initialTab || 'coches',
      scope: 'semana',
      data: null,
      schedSummary: null,
      model: null,
      loading: true,
      error: null
    };
  } else {
    if (initialTab) state.flotaView.tab = initialTab;
    if (force) {
      state.flotaView.loading = true;
      state.flotaView.error = null;
    }
  }
  renderLineasBreadcrumb();
  renderLineFlotaView();

  try {
    const [res, schedSummary] = await Promise.all([
      api.flotaLinea(linea.codigo),
      computeLineScheduledFleetSummary(linea.codigo)
    ]);
    const data = res?.data;
    if (state.drill.step !== 'flota' || state.drill.linea?.codigo !== linea.codigo) return;
    state.flotaView.data = data || { coches: [], choferes: [], todayTrips: [], retentionDays: 7, meta: {} };
    state.flotaView.schedSummary = schedSummary;
    state.flotaView.model = schedSummary?._model || null;
    state.flotaView.loading = false;
    state.flotaView.error = null;

    // Keep summary badge in sync with freshly fetched line roster + live capacity
    if (data) {
      const cHoy = (data.coches || []).filter((c) => c.vistoHoy).length;
      const cap = data.capacity || null;
      state.flotaSummaryByLine.set(Number(linea.codigo), {
        codigoLinea: Number(linea.codigo),
        descripcionLinea: data.descripcionLinea || linea.descripcion,
        cochesHoy: cHoy,
        cochesSemana: (data.coches || []).length,
        choferesHoy: (data.choferes || []).filter((d) => d.vistoHoy).length,
        choferesSemana: (data.choferes || []).length,
        activeNow: cap?.activeNow || 0,
        peakSimultaneousToday: cap?.peakSimultaneousToday || cHoy,
        replacementSwapsToday: cap?.replacementSwapsToday || 0,
        learnedTypicalToday: cap?.learnedTypicalToday || 0,
        lastSeenAt: Date.now()
      });
    }

    renderLineFlotaView();
    if (announceLoad) {
      const cTotal = (data?.coches || []).length;
      const cHoy = (data?.coches || []).filter((c) => c.vistoHoy).length;
      const dTotal = (data?.choferes || []).length;
      const peakSim = data?.capacity?.peakSimultaneousToday || cHoy;
      const swaps = data?.capacity?.replacementSwapsToday || 0;
      const schedHint = schedSummary?.totalServices
        ? ` Programados hoy: ${formatFleetSummaryShort(schedSummary)}.`
        : '';
      const simHint =
        peakSim > 0
          ? `${peakSim} ${peakSim === 1 ? 'coche simultáneo' : 'coches simultáneos'} hoy${
              swaps > 0 ? ` (${cHoy} internos vistos, ${swaps} de reemplazo)` : ''
            }`
          : `${cHoy} hoy`;
      announce(
        `Flota de línea ${linea.descripcion}:${schedHint} Detectado en el sistema: ${simHint}, ${cTotal} ${
          cTotal === 1 ? 'coche' : 'coches'
        } en la semana y ${dTotal} ${dTotal === 1 ? 'chofer' : 'choferes'}.`
      );
    }
  } catch (err) {
    if (state.drill.step !== 'flota' || state.drill.linea?.codigo !== linea.codigo) return;
    state.flotaView.loading = false;
    state.flotaView.error = err?.isOffline
      ? 'Conectate a internet para consultar la lista actualizada de coches y choferes del sistema.'
      : err.message || 'No se pudo conectar con el servidor.';
    renderLineFlotaView();
    announce(state.flotaView.error);
  }
}

// ============================================================================
// Ordered Stops & Glanceable Full Timetable Matrix per Line (Líneas -> Horarios)
// ============================================================================
async function openLineRecorrido(linea, { tipoDia = null, drawOnMap = true } = {}) {
  el.lineasFilterInput.value = '';
  const sameLine = state.drill.step === 'recorrido' && state.drill.linea?.codigo === linea.codigo;
  state.drill = { step: 'recorrido', linea, calle: null, interseccion: null, items: [] };
  const targetTipo = tipoDia || (sameLine ? state.recorridoView.tipoDia : getArgentinaTodayTipo());
  state.recorridoView = {
    tipoDia: targetTipo,
    branchIdx: sameLine ? state.recorridoView.branchIdx : 0,
    viewMode: sameLine ? state.recorridoView.viewMode : 'grilla',
    serviceFilter: sameLine ? state.recorridoView.serviceFilter : 'ALL',
    expandedStopId: null,
    model: null,
    branches: [],
    horFile: null,
    loading: true,
    error: null
  };
  renderLineasBreadcrumb();
  renderLineRecorridoView();

  try {
    const num = Number(linea.codigo);
    await ensureScheduleAssetsLoaded([num]);
    const recRes = await api.recorridos(num).catch(() => null);
    if (state.drill.step !== 'recorrido' || state.drill.linea?.codigo !== linea.codigo) return;

    const recorridos = Array.isArray(recRes?.data) ? recRes.data : [];
    let branches = state.routeBranchesCache.get(num) || [];
    if (!branches.length && recorridos.length > 0) {
      branches = parseRouteBranches(recorridos);
      state.routeBranchesCache.set(num, branches);
    }
    const horFile = state.horariosArchiveCache.get(num) || (await api.horariosLineArchive(num).catch(() => null));
    if (horFile) state.horariosArchiveCache.set(num, horFile);

    if (drawOnMap && recorridos.length > 0) {
      transitMap.clearRoutes();
      transitMap.drawRouteCollection(recorridos, linea.descripcion, { showStops: true, fit: !state.activeStop });
      state.routesVisible = true;
    }

    const model = branches.length && horFile ? buildLineScheduleModel(num, branches, horFile, targetTipo) : null;
    state.recorridoView.branches = branches;
    state.recorridoView.horFile = horFile;
    state.recorridoView.model = model;
    if (state.recorridoView.branchIdx >= branches.length) state.recorridoView.branchIdx = 0;
    state.recorridoView.loading = false;
    state.recorridoView.error = null;
    renderLineRecorridoView();
    announce(
      `Línea ${linea.descripcion}: recorrido ordenado y horarios programados (${branches.length} ${
        branches.length === 1 ? 'sentido' : 'sentidos'
      }).`
    );
  } catch (err) {
    if (state.drill.step !== 'recorrido' || state.drill.linea?.codigo !== linea.codigo) return;
    state.recorridoView.loading = false;
    state.recorridoView.error = err?.message || 'No se pudo cargar el recorrido y los horarios.';
    renderLineRecorridoView();
  }
}

function renderLineRecorridoView() {
  const linea = state.drill.linea;
  if (!linea) return;
  const rv = state.recorridoView;
  const color = getLineColor(linea.descripcion);

  if (rv.loading) {
    el.lineasContent.innerHTML = `<div class="skeleton-card"></div><div class="skeleton-card"></div><div class="skeleton-card"></div>`;
    return;
  }
  if (rv.error) {
    el.lineasContent.innerHTML = `
      <div class="empty-state">
        <h3>Error al cargar horarios</h3>
        <p>${escapeHtml(rv.error)}</p>
        <button type="button" id="btn-rec-retry" class="secondary-action-btn">Reintentar</button>
      </div>
    `;
    document.getElementById('btn-rec-retry')?.addEventListener('click', () => openLineRecorrido(linea));
    return;
  }

  const branches = rv.branches || [];
  if (!branches.length) {
    el.lineasContent.innerHTML = `
      <div class="empty-state">
        <h3>Sin recorrido archivado</h3>
        <p>Esta línea no tiene paradas ni recorridos publicados en el catálogo.</p>
      </div>
    `;
    return;
  }

  const horFile = rv.horFile;
  const checkTipoAvailable = (tipo) => {
    if (!horFile?.paradas) return false;
    for (const entry of Object.values(horFile.paradas)) {
      if (Array.isArray(entry?.[tipo]) && entry[tipo].length > 0) return true;
    }
    return false;
  };
  const tipoOpts = [
    { key: 'habil', label: 'Lun–Vie', avail: checkTipoAvailable('habil') },
    { key: 'sabado', label: 'Sábado', avail: checkTipoAvailable('sabado') },
    { key: 'domingo', label: 'Domingo', avail: checkTipoAvailable('domingo') }
  ];

  const activeBranch = branches[rv.branchIdx] || branches[0];
  const branchColor = activeBranch.color || color;
  const model =
    rv.model && rv.model.tipoDia === rv.tipoDia
      ? rv.model
      : horFile
        ? buildLineScheduleModel(linea.codigo, branches, horFile, rv.tipoDia)
        : null;
  rv.model = model;

  const isExactTipo = Boolean(model && model.tipoDia === rv.tipoDia && model.exactTipo);
  const allBranchTrips = isExactTipo && model ? model.getTripsForBranch(activeBranch) || [] : [];

  // Available services on this branch for quick service isolation
  const serviceNums = Array.from(
    new Set(allBranchTrips.map((t) => t.serviceNumber).filter((n) => Number.isFinite(n) && n > 0))
  ).sort((a, b) => a - b);

  if (rv.serviceFilter !== 'ALL' && !serviceNums.includes(Number(rv.serviceFilter))) {
    rv.serviceFilter = 'ALL';
  }
  const filteredTrips =
    rv.serviceFilter === 'ALL'
      ? allBranchTrips
      : allBranchTrips.filter((t) => String(t.serviceNumber) === String(rv.serviceFilter));

  // Deduplicate ordered stops while preserving exact route sequence (cabecera -> destino)
  const orderedStops = [];
  const seenStop = new Set();
  for (const st of activeBranch.orderedStops || []) {
    if (!st.id || seenStop.has(st.id)) continue;
    seenStop.add(st.id);
    orderedStops.push(st);
  }

  const query = el.lineasFilterInput.value.trim().toLowerCase();
  const visibleStops = query
    ? orderedStops.filter((st) => `${st.id} ${st.descripcion}`.toLowerCase().includes(query))
    : orderedStops;

  const nowSecRaw = getArgentinaSecOfDay();
  const nowSvcSec = nowSecRaw < 3 * 3600 ? nowSecRaw + 86400 : nowSecRaw;
  const isTodayTipo = rv.tipoDia === getArgentinaTodayTipo();

  // Identify current/next trip index for instant highlighting and "Ir a ahora" scroll
  let currentTripIdx = -1;
  if (filteredTrips.length > 0) {
    currentTripIdx = filteredTrips.findIndex((tr) => tr.endSec >= nowSvcSec - 120);
    if (currentTripIdx < 0) currentTripIdx = filteredTrips.length - 1;
  }

  const dayTabsHtml = tipoOpts
    .map(
      (opt) => `
      <button type="button" class="seg-btn seg-btn-xs rec-tipo-btn ${rv.tipoDia === opt.key ? 'active' : ''}" data-rec-tipo="${opt.key}" aria-pressed="${rv.tipoDia === opt.key}" ${!opt.avail ? 'title="Sin servicio programado este día"' : ''}>
        ${opt.label}${!opt.avail ? ' · s/d' : ''}
      </button>
    `
    )
    .join('');

  const branchTabsHtml = branches
    .map((b, i) => {
      const shortName = String(b.bandera || `Ramal ${i + 1}`).trim();
      return `
        <button type="button" class="rec-branch-pill ${i === rv.branchIdx ? 'active' : ''}" data-rec-branch="${i}" style="--branch-color:${b.color || color}" aria-pressed="${i === rv.branchIdx}">
          <span class="dir-dot" style="background:${b.color || color}" aria-hidden="true"></span>
          <span>${escapeHtml(shortName)}</span>
        </button>
      `;
    })
    .join('');

  const srvFilterHtml =
    serviceNums.length > 1
      ? `
      <div class="rec-srv-strip" role="group" aria-label="Filtrar vueltas por servicio">
        <button type="button" class="rec-srv-chip ${rv.serviceFilter === 'ALL' ? 'active' : ''}" data-rec-srv="ALL">Todos (${allBranchTrips.length})</button>
        ${serviceNums
          .map(
            (s) =>
              `<button type="button" class="rec-srv-chip ${String(rv.serviceFilter) === String(s) ? 'active' : ''}" data-rec-srv="${s}">Srv ${s}</button>`
          )
          .join('')}
      </div>
    `
      : '';

  let bodyHtml = '';
  if (!isExactTipo || allBranchTrips.length === 0) {
    // Still render ordered stops list even if a line has no scheduled trips for that day type (e.g. 109B on Sunday)
    bodyHtml = `
      <div class="rec-notice-bar">
        <span>Sin horarios programados publicados para <strong>${
          rv.tipoDia === 'domingo' ? 'Domingo' : rv.tipoDia === 'sabado' ? 'Sábado' : 'Lun–Vie'
        }</strong> en este sentido. Se muestran las ${visibleStops.length} paradas en orden de recorrido.</span>
      </div>
      <div class="rec-stops-timeline" style="--branch-color:${branchColor}">
        ${visibleStops
          .map((st, idx) => {
            const origIdx = orderedStops.indexOf(st) + 1;
            return `
              <div class="rec-stop-item">
                <div class="rec-stop-rail" aria-hidden="true">
                  <span class="rec-stop-dot ${origIdx === 1 || origIdx === orderedStops.length ? 'is-terminal' : ''}"></span>
                </div>
                <button type="button" class="rec-stop-card" data-open-stop="${escapeHtml(st.id)}" data-stop-name="${escapeHtml(st.descripcion)}" data-stop-lat="${st.lat}" data-stop-lng="${st.lng}">
                  <div class="rec-stop-head">
                    <span class="rec-stop-num">#${origIdx}</span>
                    <span class="rec-stop-name">${escapeHtml(st.descripcion)}</span>
                    <span class="code-badge">${escapeHtml(st.id)}</span>
                  </div>
                </button>
              </div>
            `;
          })
          .join('')}
      </div>
    `;
  } else if (rv.viewMode === 'grilla') {
    // GLANCEABLE TIMETABLE MATRIX (Ordered Stops × All Scheduled Vueltas)
    const headerCells = filteredTrips
      .map((tr, cIdx) => {
        const isCurrent = isTodayTipo && cIdx === currentTripIdx;
        const depHH = formatSecHHMM(tr.startSec);
        const srvTag = tr.serviceNumber ? `S${tr.serviceNumber}` : `V${cIdx + 1}`;
        const lapTag = tr.lapNumber ? `·V${formatLapNumber(tr.lapNumber)}` : '';
        return `
          <th scope="col" class="rec-th-trip ${isCurrent ? 'is-now-col' : ''}" data-trip-col="${cIdx}" title="Salida ${depHH} · Servicio ${tr.serviceNumber || '—'}${tr.lapNumber ? ` · Vuelta ${formatLapNumber(tr.lapNumber)}` : ''}">
            <span class="rec-th-time">${depHH}</span>
            <span class="rec-th-srv">${escapeHtml(srvTag + lapTag)}</span>
          </th>
        `;
      })
      .join('');

    const rowsHtml = visibleStops
      .map((st) => {
        const origIdx = orderedStops.indexOf(st) + 1;
        const isTerminal = origIdx === 1 || origIdx === orderedStops.length;
        const cells = filteredTrips
          .map((tr, cIdx) => {
            const sec = getTripStopSec(tr, st.id, st.along);
            const isCurrent = isTodayTipo && cIdx === currentTripIdx;
            const isPassed = isTodayTipo && sec !== null && sec < nowSvcSec - 60;
            return `<td class="rec-td-time ${isCurrent ? 'is-now-col' : ''} ${isPassed ? 'is-passed' : ''}">${
              sec !== null ? formatSecHHMM(sec) : '—'
            }</td>`;
          })
          .join('');
        return `
          <tr class="${isTerminal ? 'is-terminal-row' : ''}">
            <th scope="row" class="rec-td-stop">
              <button type="button" class="rec-stop-inline-btn" data-open-stop="${escapeHtml(st.id)}" data-stop-name="${escapeHtml(st.descripcion)}" data-stop-lat="${st.lat}" data-stop-lng="${st.lng}" title="Abrir radar en vivo de ${escapeHtml(st.descripcion)} (${escapeHtml(st.id)})">
                <span class="rec-stop-seq ${isTerminal ? 'is-terminal' : ''}" style="--branch-color:${branchColor}">${origIdx}</span>
                <span class="rec-stop-txt">
                  <span class="rec-stop-label">${escapeHtml(st.descripcion)}</span>
                  <span class="rec-stop-code">${escapeHtml(st.id)}</span>
                </span>
              </button>
            </th>
            ${cells}
          </tr>
        `;
      })
      .join('');

    bodyHtml = `
      <div class="rec-matrix-toolbar">
        <span class="mono-meta">${visibleStops.length} paradas en orden · ${filteredTrips.length} vueltas</span>
        ${
          isTodayTipo && currentTripIdx >= 0
            ? `<button type="button" id="btn-rec-scroll-now" class="seg-btn seg-btn-xs active">Ir a ahora</button>`
            : ''
        }
      </div>
      <div id="rec-matrix-scroll" class="rec-matrix-wrap" role="region" aria-label="Grilla completa de horarios por parada en orden de recorrido">
        <table class="rec-matrix-table">
          <thead>
            <tr>
              <th scope="col" class="rec-th-stop">Parada (orden recorrido)</th>
              ${headerCells}
            </tr>
          </thead>
          <tbody>
            ${rowsHtml}
          </tbody>
        </table>
      </div>
    `;
  } else {
    // ORDERED STOPS TIMELINE VIEW (with quick upcoming times + tap to expand all pass times)
    bodyHtml = `
      <div class="rec-matrix-toolbar">
        <span class="mono-meta">${visibleStops.length} paradas en orden · ${filteredTrips.length} vueltas</span>
        <span class="mono-meta">Tocá una parada para ver todas sus horas</span>
      </div>
      <div class="rec-stops-timeline" style="--branch-color:${branchColor}">
        ${visibleStops
          .map((st) => {
            const origIdx = orderedStops.indexOf(st) + 1;
            const isTerminal = origIdx === 1 || origIdx === orderedStops.length;
            const passTimes = filteredTrips
              .map((tr) => ({
                sec: getTripStopSec(tr, st.id, st.along),
                srv: tr.serviceNumber,
                lap: tr.lapNumber
              }))
              .filter((p) => p.sec !== null);
            const upcoming = isTodayTipo ? passTimes.filter((p) => p.sec >= nowSvcSec - 60) : passTimes;
            const previewList = (upcoming.length ? upcoming : passTimes).slice(0, 5);
            const isExpanded = rv.expandedStopId === st.id;
            const previewHtml = previewList
              .map(
                (p, idx) =>
                  `<span class="rec-time-chip ${isTodayTipo && idx === 0 && upcoming.length ? 'is-next' : ''}">${formatSecHHMM(p.sec)}</span>`
              )
              .join('');
            const allTimesHtml = isExpanded
              ? `
                <div class="rec-stop-all-times">
                  ${passTimes
                    .map((p) => {
                      const passed = isTodayTipo && p.sec < nowSvcSec - 60;
                      const isNext = isTodayTipo && upcoming.length && p === upcoming[0];
                      return `<span class="rec-time-chip ${isNext ? 'is-next' : ''} ${passed ? 'is-passed' : ''}" title="${
                        p.srv ? `Servicio ${p.srv}${p.lap ? ` · Vuelta ${formatLapNumber(p.lap)}` : ''}` : ''
                      }">${formatSecHHMM(p.sec)}${p.srv ? `<small>S${p.srv}</small>` : ''}</span>`;
                    })
                    .join('')}
                </div>
              `
              : '';

            return `
              <div class="rec-stop-item ${isExpanded ? 'is-expanded' : ''}">
                <div class="rec-stop-rail" aria-hidden="true">
                  <span class="rec-stop-dot ${isTerminal ? 'is-terminal' : ''}"></span>
                </div>
                <div class="rec-stop-card">
                  <div class="rec-stop-head">
                    <button type="button" class="rec-stop-toggle-btn" data-toggle-stop="${escapeHtml(st.id)}" aria-expanded="${isExpanded}">
                      <span class="rec-stop-num">#${origIdx}</span>
                      <span class="rec-stop-name">${escapeHtml(st.descripcion)}</span>
                    </button>
                    <button type="button" class="seg-btn seg-btn-xs rec-stop-radar-btn" data-open-stop="${escapeHtml(st.id)}" data-stop-name="${escapeHtml(st.descripcion)}" data-stop-lat="${st.lat}" data-stop-lng="${st.lng}" aria-label="Abrir radar en parada ${escapeHtml(st.descripcion)}">Radar</button>
                  </div>
                  <div class="rec-stop-preview-row">
                    <span class="code-badge">${escapeHtml(st.id)}</span>
                    <div class="rec-preview-chips">${previewHtml || '<span class="mono-meta">Sin horarios</span>'}</div>
                  </div>
                  ${allTimesHtml}
                </div>
              </div>
            `;
          })
          .join('')}
      </div>
    `;
  }

  el.lineasContent.innerHTML = `
    <div class="rec-view">
      <div class="rec-controls-card">
        <div class="rec-controls-row">
          <div class="rec-day-group" role="group" aria-label="Tipo de día">
            ${dayTabsHtml}
          </div>
          <div class="rec-mode-group" role="group" aria-label="Modo de visualización">
            <button type="button" class="seg-btn seg-btn-xs ${rv.viewMode === 'grilla' ? 'active' : ''}" data-rec-mode="grilla" aria-pressed="${rv.viewMode === 'grilla'}">Grilla</button>
            <button type="button" class="seg-btn seg-btn-xs ${rv.viewMode === 'paradas' ? 'active' : ''}" data-rec-mode="paradas" aria-pressed="${rv.viewMode === 'paradas'}">Paradas</button>
          </div>
        </div>
        <div class="rec-branches-row" role="group" aria-label="Sentido o ramal">
          ${branchTabsHtml}
        </div>
        ${srvFilterHtml}
      </div>
      ${bodyHtml}
    </div>
  `;

  // Bind controls
  el.lineasContent.querySelectorAll('[data-rec-tipo]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const nextTipo = btn.dataset.recTipo;
      if (state.recorridoView.tipoDia === nextTipo) return;
      state.recorridoView.tipoDia = nextTipo;
      state.recorridoView.model = null;
      state.recorridoView.serviceFilter = 'ALL';
      haptic('light');
      renderLineRecorridoView();
    });
  });

  el.lineasContent.querySelectorAll('[data-rec-branch]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const nextIdx = Number(btn.dataset.recBranch);
      if (state.recorridoView.branchIdx === nextIdx) return;
      state.recorridoView.branchIdx = nextIdx;
      state.recorridoView.expandedStopId = null;
      haptic('light');
      renderLineRecorridoView();
    });
  });

  el.lineasContent.querySelectorAll('[data-rec-mode]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const nextMode = btn.dataset.recMode;
      if (state.recorridoView.viewMode === nextMode) return;
      state.recorridoView.viewMode = nextMode;
      haptic('light');
      renderLineRecorridoView();
    });
  });

  el.lineasContent.querySelectorAll('[data-rec-srv]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const nextSrv = btn.dataset.recSrv;
      if (String(state.recorridoView.serviceFilter) === String(nextSrv)) return;
      state.recorridoView.serviceFilter = nextSrv;
      haptic('light');
      renderLineRecorridoView();
    });
  });

  el.lineasContent.querySelectorAll('[data-toggle-stop]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const sid = btn.dataset.toggleStop;
      state.recorridoView.expandedStopId = state.recorridoView.expandedStopId === sid ? null : sid;
      haptic('light');
      renderLineRecorridoView();
    });
  });

  el.lineasContent.querySelectorAll('[data-open-stop]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const stop = {
        id: btn.dataset.openStop,
        nombre: btn.dataset.stopName || btn.dataset.openStop,
        lat: parseFloat(btn.dataset.stopLat),
        lng: parseFloat(btn.dataset.stopLng)
      };
      openStopRadar(stop, String(linea.codigo));
    });
  });

  const scrollNowCol = (smooth = false) => {
    const wrap = document.getElementById('rec-matrix-scroll');
    const nowTh = wrap?.querySelector('.rec-th-trip.is-now-col');
    if (wrap && nowTh) {
      const stopColW = wrap.querySelector('.rec-th-stop')?.offsetWidth || 150;
      const targetLeft = Math.max(0, nowTh.offsetLeft - stopColW - 8);
      wrap.scrollTo({ left: targetLeft, behavior: smooth ? 'smooth' : 'auto' });
    }
  };
  document.getElementById('btn-rec-scroll-now')?.addEventListener('click', () => {
    haptic('light');
    scrollNowCol(true);
  });
  if (rv.viewMode === 'grilla' && isTodayTipo && currentTripIdx >= 0) {
    requestAnimationFrame(() => scrollNowCol(false));
  }
}

function renderDrilldown() {
  renderLineasBreadcrumb();
  const query = el.lineasFilterInput.value.trim().toLowerCase();
  const { step, items } = state.drill;

  if (step === 'recorrido') {
    renderLineRecorridoView();
    return;
  }

  if (step === 'flota') {
    renderLineFlotaView();
    return;
  }

  if (step === 'lineas') {
    const filtered = state.lineas.filter((l) => l.descripcion.toLowerCase().includes(query));
    el.lineasContent.innerHTML = `
      <div class="lines-grid">
        ${filtered
          .map((l) => {
            const color = getLineColor(l.descripcion);
            const sum = state.flotaSummaryByLine.get(Number(l.codigo));
            const peakOrHoy = sum ? sum.peakSimultaneousToday || sum.cochesHoy || 0 : 0;
            const swapsNote =
              sum && sum.replacementSwapsToday > 0
                ? ` (${sum.cochesHoy} internos · ${sum.replacementSwapsToday} reempl.)`
                : '';
            const activeNote =
              sum && sum.activeNow > 0 ? `${sum.activeNow} en línea ahora · ` : '';
            const countBadge =
              sum && sum.cochesSemana > 0
                ? `<span class="line-tile-count" aria-hidden="true" title="${activeNote}Pico simultáneo hoy: ${peakOrHoy}${swapsNote} · ${sum.cochesSemana} en 7 días · ${sum.choferesSemana} choferes">${peakOrHoy > 0 ? `${peakOrHoy}/${sum.cochesSemana}` : `${sum.cochesSemana}`} c.</span>`
                : '';
            const flotaAria =
              sum && sum.cochesSemana > 0
                ? `Ver flota de coches y choferes de línea ${l.descripcion}. ${peakOrHoy} coches simultáneos hoy${
                    sum.replacementSwapsToday > 0 ? ` (${sum.cochesHoy} internos en total)` : ''
                  }, ${sum.cochesSemana} en la semana y ${sum.choferesSemana} choferes`
                : `Ver flota de coches y choferes de línea ${l.descripcion}`;
            return `
              <div class="line-tile" style="--line-color:${color}">
                <div class="line-tile-head">
                  <button type="button" class="line-tile-title-btn btn-line-recorrido" data-cod="${l.codigo}" data-desc="${escapeHtml(l.descripcion)}" aria-label="Ver paradas en orden de recorrido y horarios de línea ${escapeHtml(l.descripcion)}">
                    <span class="line-tile-swatch" aria-hidden="true"></span>
                    <span class="line-tile-name">${escapeHtml(l.descripcion)}</span>
                  </button>
                  ${countBadge}
                </div>
                <div class="line-tile-actions line-tile-actions-4">
                  <button type="button" class="tile-mini-btn primary btn-line-recorrido" data-cod="${l.codigo}" data-desc="${escapeHtml(l.descripcion)}" aria-label="Ver paradas ordenadas y horarios de línea ${escapeHtml(l.descripcion)}">Horarios</button>
                  <button type="button" class="tile-mini-btn btn-line-servicios" data-cod="${l.codigo}" data-desc="${escapeHtml(l.descripcion)}" aria-label="Ver servicios y turnos de línea ${escapeHtml(l.descripcion)}">Servicios</button>
                  <button type="button" class="tile-mini-btn btn-line-flota" data-cod="${l.codigo}" data-desc="${escapeHtml(l.descripcion)}" aria-label="${escapeHtml(flotaAria)}">Flota</button>
                  <button type="button" class="tile-mini-btn btn-line-calles" data-cod="${l.codigo}" data-desc="${escapeHtml(l.descripcion)}" aria-label="Ver calles y paradas de línea ${escapeHtml(l.descripcion)}">Calles</button>
                </div>
              </div>
            `;
          })
          .join('')}
      </div>
    `;

    el.lineasContent.querySelectorAll('.btn-line-recorrido').forEach((btn) => {
      btn.addEventListener('click', () => openLineRecorrido({ codigo: Number(btn.dataset.cod), descripcion: btn.dataset.desc }));
    });
    el.lineasContent.querySelectorAll('.btn-line-servicios').forEach((btn) => {
      btn.addEventListener('click', () =>
        openLineFlota({ codigo: Number(btn.dataset.cod), descripcion: btn.dataset.desc }, { initialTab: 'servicios' })
      );
    });
    el.lineasContent.querySelectorAll('.btn-line-flota').forEach((btn) => {
      btn.addEventListener('click', () => openLineFlota({ codigo: Number(btn.dataset.cod), descripcion: btn.dataset.desc }));
    });
    el.lineasContent.querySelectorAll('.btn-line-calles').forEach((btn) => {
      btn.addEventListener('click', () => openLineCalles({ codigo: Number(btn.dataset.cod), descripcion: btn.dataset.desc }));
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
        <button type="button" class="list-row-btn" data-cod="${c.codigo}" data-desc="${escapeHtml(c.descripcion)}">
          <div class="list-row-main">
            <span class="list-row-title">${escapeHtml(c.descripcion.replace(/\s*-\s*CORRIENTES$/i, ''))}</span>
            <span class="list-row-sub">Seleccionar intersección</span>
          </div>
          <span class="row-chevron" aria-hidden="true">›</span>
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
        <button type="button" class="list-row-btn" data-cod="${i.codigo}" data-desc="${escapeHtml(i.descripcion)}">
          <div class="list-row-main">
            <span class="list-row-title">${escapeHtml(i.descripcion.replace(/\s*-\s*CORRIENTES$/i, ''))}</span>
            <span class="list-row-sub">Ver paradas en esta esquina</span>
          </div>
          <span class="row-chevron" aria-hidden="true">›</span>
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
            <button type="button" class="seg-btn seg-btn-xs active btn-open-all" data-id="${escapeHtml(p.identificador)}" data-name="${escapeHtml(p.descripcion)}" aria-label="Abrir parada ${escapeHtml(p.identificador)}, ${escapeHtml(p.descripcion)}, todas las líneas">Todas las líneas</button>
            <button type="button" class="seg-btn seg-btn-xs btn-open-only" data-id="${escapeHtml(p.identificador)}" data-name="${escapeHtml(p.descripcion)}" aria-label="Abrir parada ${escapeHtml(p.identificador)}, ${escapeHtml(p.descripcion)}, solo línea ${escapeHtml(state.drill.linea.descripcion)}">Solo ${escapeHtml(state.drill.linea.descripcion)}</button>
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
    announce(`Línea ${linea.descripcion}: ${state.drill.items.length} calles disponibles.`);
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
    announce(`${state.drill.items.length} intersecciones disponibles.`);
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
    announce(`${state.drill.items.length} ${state.drill.items.length === 1 ? 'parada encontrada' : 'paradas encontradas'}.`);
  } catch (err) {
    el.lineasContent.innerHTML = `<div class="empty-state"><h3>Error</h3><p>${escapeHtml(err.message)}</p></div>`;
  }
}

// ============================================================================
// TAB 3: Paradas Cercanas
// ============================================================================
function renderHubs() {
  el.hubsChips.innerHTML = state.hubs
    .map((h, idx) => `<button type="button" class="hub-chip" data-hub-idx="${idx}">${escapeHtml(h.name.replace(/\s*\(Piloto\)/i, ''))}</button>`)
    .join('');

  el.hubsChips.querySelectorAll('.hub-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const hub = state.hubs[Number(chip.dataset.hubIdx)];
      if (hub) searchNearbyStops(hub.lat, hub.lng, hub.name);
    });
  });

  el.cercanasList.innerHTML = `
    <div class="empty-state">
      <div class="empty-state-icon" aria-hidden="true">◎</div>
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
      announce(`No se encontraron paradas cerca de ${label}.`);
      return;
    }

    transitMap.showNearbyStops(stops, { lat, lng });

    el.cercanasList.innerHTML = stops
      .map((s) => {
        const sLat = parseFloat(s.latitud);
        const sLng = parseFloat(s.longitud);
        const dist = distanceMeters(lat, lng, sLat, sLng);
        const openAria = `Abrir radar de parada ${s.identificador}, ${s.descripcion}, a ${formatDistance(dist)}${
          s.lineas ? `, líneas ${s.lineas}` : ''
        }`;
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
              <button type="button" class="seg-btn seg-btn-xs btn-nearby-open" data-id="${escapeHtml(s.identificador)}" data-name="${escapeHtml(
                s.descripcion
              )}" data-lat="${sLat}" data-lng="${sLng}" aria-label="${escapeHtml(openAria)}">Abrir radar →</button>
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

    announce(`Se encontraron ${stops.length} paradas cerca de ${label}.`);
  } catch (err) {
    el.cercanasList.innerHTML = `<div class="empty-state"><h3>Error</h3><p>${escapeHtml(err.message)}</p></div>`;
  }
}

async function locateUserGps() {
  showToast('Obteniendo ubicación GPS...', 'info', 1800);
  try {
    const { latitude, longitude, accuracy } = await getCurrentPosition({ enableHighAccuracy: true, timeout: 9000 });
    haptic('light');
    transitMap.setUserLocation(latitude, longitude, accuracy);
    searchNearbyStops(latitude, longitude, 'tu ubicación');
  } catch (err) {
    const denied = err?.code === 1 || /denied|permiso/i.test(String(err?.message || ''));
    showToast(
      denied
        ? 'Sin permiso de ubicación. Mostrando paradas en el centro de Corrientes.'
        : 'No se pudo obtener tu ubicación. Mostrando el centro de Corrientes.',
      'warn'
    );
    searchNearbyStops(CORRIENTES_CENTER.lat, CORRIENTES_CENTER.lng, 'Centro de Corrientes');
  }
}

// ============================================================================
// Global Search (Accessible Combobox)
// ============================================================================
function closeSearchDropdown() {
  el.searchDropdown.classList.add('hidden');
  el.globalSearch.setAttribute('aria-expanded', 'false');
}

let fleetSearchTimer = null;
let fleetSearchSeq = 0;

function renderSearchDropdownItems(results, isSearchingServer = false) {
  if (results.length === 0) {
    el.searchDropdown.innerHTML = isSearchingServer
      ? `<div class="search-item" role="option" aria-disabled="true"><div class="search-item-main"><span class="search-item-title">Buscando coches y choferes...</span><span class="search-item-sub">Consultando la flota del sistema</span></div></div>`
      : `<div class="search-item" role="option" aria-disabled="true"><div class="search-item-main"><span class="search-item-title">Sin coincidencias</span><span class="search-item-sub">Ingresá una parada (CT31498), línea (106A), coche (4123) o chofer</span></div></div>`;
  } else {
    el.searchDropdown.innerHTML = results
      .slice(0, 10)
      .map(
        (r, i) => `
        <button type="button" class="search-item" role="option" data-res-idx="${i}">
          <div class="search-item-main">
            <span class="search-item-title">${escapeHtml(r.title)}</span>
            <span class="search-item-sub">${escapeHtml(r.sub)}</span>
          </div>
          <span class="code-badge" ${r.color ? `style="background:${r.color};color:#fff"` : ''}>${escapeHtml(r.badge)}</span>
        </button>
      `
      )
      .join('');

    el.searchDropdown.querySelectorAll('.search-item[data-res-idx]').forEach((item) => {
      item.addEventListener('click', () => {
        const res = results[Number(item.dataset.resIdx)];
        closeSearchDropdown();
        el.globalSearch.value = '';
        res?.action();
      });
    });
  }
  el.searchDropdown.classList.remove('hidden');
  el.globalSearch.setAttribute('aria-expanded', 'true');
}

function renderGlobalSearchResults(rawQuery) {
  const q = rawQuery.trim();
  if (fleetSearchTimer) {
    clearTimeout(fleetSearchTimer);
    fleetSearchTimer = null;
  }
  if (!q) {
    closeSearchDropdown();
    return;
  }

  const upper = q.toUpperCase();
  const baseResults = [];

  if (/^CT\d{3,6}V?$/.test(upper)) {
    const catHit = state.catalogo?.stopById?.get(upper);
    baseResults.push({
      title: catHit ? catHit.nombre : `Ir a parada ${upper}`,
      sub: 'Consultar arribos de todas las líneas',
      badge: upper,
      action: () =>
        openStopRadar(
          catHit || { id: upper, nombre: `Parada ${upper}` },
          '000'
        )
    });
  }

  const knownStops = [...state.favorites, ...state.quickStops];
  const seenStop = new Set(baseResults.map((r) => r.badge));
  for (const s of knownStops) {
    if (seenStop.has(s.id)) continue;
    if (`${s.id} ${s.nombre} ${s.alias || ''}`.toUpperCase().includes(upper)) {
      seenStop.add(s.id);
      baseResults.push({
        title: s.nombre,
        sub: s.alias ? `${s.alias} · Todas las líneas` : 'Parada · Todas las líneas',
        badge: s.id,
        action: () => openStopRadar(s, '000')
      });
    }
  }

  for (const l of state.lineas) {
    if (l.descripcion.toUpperCase().includes(upper)) {
      baseResults.push({
        title: `Línea ${l.descripcion}`,
        sub: 'Paradas en orden, horarios, servicios y flota',
        badge: l.descripcion,
        color: getLineColor(l.descripcion),
        action: () => {
          switchTab('lineas');
          openLineRecorrido(l);
        }
      });
    }
  }

  // Search full offline Corrientes stops catalog (1,000+ stops by code or street name)
  if (q.length >= 2 && state.catalogo?.paradas?.length && baseResults.length < 6) {
    for (const s of state.catalogo.paradas) {
      if (baseResults.length >= 6) break;
      if (seenStop.has(s.id)) continue;
      if (`${s.id} ${s.nombre}`.toUpperCase().includes(upper)) {
        seenStop.add(s.id);
        const linesTxt = (s.lineas || [])
          .map((c) => state.catalogo.lineByCode.get(Number(c))?.descripcion)
          .filter(Boolean)
          .slice(0, 5)
          .join(', ');
        baseResults.push({
          title: s.nombre,
          sub: linesTxt || 'Parada · Todas las líneas',
          badge: s.id,
          action: () => openStopRadar(s, '000')
        });
      }
    }
  }

  const shouldSearchFleet = q.length >= 2 && !/^CT\d{3,6}V?$/.test(upper);
  renderSearchDropdownItems(baseResults, shouldSearchFleet && baseResults.length === 0);

  if (shouldSearchFleet) {
    const mySeq = ++fleetSearchSeq;
    fleetSearchTimer = setTimeout(async () => {
      try {
        const res = await api.flotaBuscar(q);
        if (mySeq !== fleetSearchSeq) return;
        if (el.globalSearch.value.trim() !== q) return;
        const hits = Array.isArray(res?.data?.results) ? res.data.results : [];
        const todayKey = res?.data?.dayKey || getArgentinaDayKey();
        const fleetItems = hits.slice(0, 6).map((h) => {
          const seen = formatRosterSeenInfo(h.lastSeenAt, h.lastDayKey, todayKey);
          const statusTxt = h.enLineaAhora ? 'En línea' : seen.badge;
          const srvPart =
            h.lastServiceNum > 0
              ? `Srv ${h.lastServiceNum}${h.lastTurnoStart && h.lastTurnoEnd ? ` (${h.lastTurnoStart}–${h.lastTurnoEnd})` : ''}`
              : '';
          const title =
            h.type === 'chofer'
              ? `${h.choferNombre}${h.choferLegajo ? ` (${h.choferLegajo})` : ''}`
              : `Coche #${h.coche}`;
          const subParts = [
            statusTxt,
            h.type === 'chofer'
              ? h.coche
                ? `Coche #${h.coche}`
                : ''
              : h.choferNombre || '',
            srvPart,
            'Ver en mapa'
          ].filter(Boolean);
          return {
            title,
            sub: subParts.join(' · '),
            badge: h.descripcionLinea,
            color: getLineColor(h.descripcionLinea),
            action: () =>
              locateFleetUnitOnMap({
                codLinea: h.codigoLinea,
                lineName: h.descripcionLinea,
                coche: h.coche,
                choferNombre: h.choferNombre,
                choferLegajo: h.choferLegajo,
                esAdaptado: h.esAdaptado,
                lat: h.lastLat,
                lng: h.lastLng,
                bandera: h.lastBandera,
                lastGps: h.lastGps,
                lastStopId: h.lastStopId,
                desvioRaw: h.lastDesvioRaw,
                desvioSec: h.lastDesvioSec,
                enLineaAhora: h.enLineaAhora,
                lastSeenLabel: seen.whenShort,
                serviceMeta:
                  h.lastServiceNum > 0
                    ? {
                        serviceNumber: h.lastServiceNum,
                        turnoIndex: h.lastTurnoIdx || 1,
                        serviceTurnosCount: 0,
                        lapNumber: h.lastLapNum || null,
                        shiftLaps: h.lastShiftLaps || null,
                        startHHMM: h.lastTurnoStart || '',
                        endHHMM: h.lastTurnoEnd || ''
                      }
                    : null
              })
          };
        });

        // Show fleet matches first when query looks like a driver name or 3-4 digit car number
        const combined =
          fleetItems.length > 0 && baseResults.length <= 3
            ? [...fleetItems, ...baseResults]
            : [...baseResults.slice(0, 4), ...fleetItems];
        renderSearchDropdownItems(combined, false);
      } catch {
        if (mySeq === fleetSearchSeq && baseResults.length === 0) {
          renderSearchDropdownItems([], false);
        }
      }
    }, 200);
  }
}

// ============================================================================
// Events & Clean Init
// ============================================================================
function bindEvents() {
  const tabArr = Array.from(el.tabs);
  tabArr.forEach((tab, idx) => {
    tab.addEventListener('click', () => {
      switchTab(tab.dataset.tab);
      announce(`Sección ${tab.textContent.trim()}.`);
    });
    tab.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        const nextIdx = (idx + (e.key === 'ArrowRight' ? 1 : -1) + tabArr.length) % tabArr.length;
        const nextTab = tabArr[nextIdx];
        switchTab(nextTab.dataset.tab);
        nextTab.focus();
      }
    });
  });

  el.btnBrandHome.addEventListener('click', resetToWelcome);

  // Single delegated listeners for high-frequency panels (zero listener leaks/churn)
  el.lineFilterStrip.addEventListener('click', handleLineFilterClick);
  el.arribosList.addEventListener('click', handleArribosListClick);
  el.horariosPanel.addEventListener('click', handleHorariosPanelClick);

  el.btnThemeToggle.addEventListener('click', () => {
    const cur = document.documentElement.getAttribute('data-theme');
    const next = cur === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    announce(next === 'light' ? 'Tema claro activado.' : 'Tema oscuro activado.');
  });

  el.btnSoundToggle.addEventListener('click', () => {
    state.soundEnabled = !state.soundEnabled;
    el.btnSoundToggle.setAttribute('aria-pressed', String(state.soundEnabled));
    el.btnSoundToggle.setAttribute(
      'aria-label',
      state.soundEnabled ? 'Alertas sonoras activadas' : 'Alertas sonoras desactivadas'
    );
    el.iconSoundOn.classList.toggle('hidden', !state.soundEnabled);
    el.iconSoundOff.classList.toggle('hidden', state.soundEnabled);
    if (state.soundEnabled) playSubtleTick();
    announce(state.soundEnabled ? 'Alertas sonoras activadas.' : 'Alertas sonoras desactivadas.');
  });

  el.btnLiveMode.addEventListener('click', async () => {
    state.simulateMode = !state.simulateMode;
    updateSignalPill();
    if (state.simulateMode) {
      showToast('EN VIVO: movimiento continuo y predicción por horarios', 'success');
      if (state.activeStop) {
        await fetchArribos(false);
        if (state.arribos.length > 0) startSimLoop();
      }
      if (state.allFleetMode && state.allFleetBuses.length > 0) {
        reconcileCityFleetSim(state.allFleetBuses);
        transitMap.updateAllFleetBuses(state.allFleetBuses, { selectedBusKey: state.selectedBusKey });
        startSimLoop();
      }
    } else {
      stopSimLoop();
      showToast('ULT. GPS: última actualización satelital real', 'info');
      if (state.activeStop) {
        if (state.isOffline) {
          // Drop schedule-only synthetic buses when viewing static ULT. GPS offline
          state.arribos = state.arribos.filter((b) => !b.isPredicted);
          await renderOfflineOrFallback(false);
        } else {
          await fetchArribos(false);
        }
      }
      if (state.allFleetMode && state.allFleetBuses.length > 0) {
        for (const b of state.allFleetBuses) {
          if (typeof b.rawLat === 'number' && typeof b.rawLng === 'number') {
            b.lat = b.rawLat;
            b.lng = b.rawLng;
          }
        }
        transitMap.updateAllFleetBuses(state.allFleetBuses, { selectedBusKey: state.selectedBusKey });
      }
    }
  });

  el.btnRefreshStop?.addEventListener('click', async () => {
    if (!state.activeStop) return;
    haptic('light');
    state.countdownSec = REFRESH_INTERVAL_SEC;
    el.btnRefreshStop.classList.add('is-spinning');
    try {
      await fetchArribos(false, { announceSummary: true, isRefresh: true });
    } finally {
      el.btnRefreshStop.classList.remove('is-spinning');
    }
  });

  el.btnToggleFav.addEventListener('click', toggleActiveStopFavorite);
  el.btnShareStop.addEventListener('click', async () => {
    if (!state.activeStop) return;
    const result = await shareStop({
      id: state.activeStop.id,
      nombre: state.activeStop.nombre,
      codLinea: state.codLineaQuery
    });
    if (result === 'copied') showToast(`Enlace copiado para ${state.activeStop.id}`, 'success');
    else if (result === 'failed') showToast(`Parada actual: ${state.activeStop.id}`, 'info');
  });

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
  el.btnInspTrack?.addEventListener('click', () => {
    const key = el.btnInspTrack.dataset.busKey || state.selectedBusKey;
    const bus = state.allFleetBuses.find((b) => b.key === key);
    if (!bus) return;
    locateFleetUnitOnMap({
      codLinea: bus.codigoLinea,
      lineName: bus.descripcionLinea,
      coche: bus.identificadorCoche,
      choferNombre: bus.choferNombre,
      choferLegajo: bus.choferLegajo,
      esAdaptado: bus.esAdaptado,
      lat: bus.lat,
      lng: bus.lng,
      bandera: bus.descripcionBandera,
      lastGps: bus.ultimaFechaHoraGPS,
      lastStopId: bus.lastStopId,
      desvioRaw: bus.desvio?.raw || '',
      desvioSec: bus.desvio?.seconds || 0,
      enLineaAhora: true,
      serviceMeta: bus.serviceNumber
        ? {
            serviceNumber: bus.serviceNumber,
            turnoIndex: bus.turnoIndex || 1,
            serviceTurnosCount: bus.serviceTurnosCount || 1,
            lapNumber: bus.lapNumber,
            shiftLaps: bus.shiftLaps,
            isCortado: bus.isCortadoBlock,
            isRelevoEnLinea: bus.isRelevoEnLinea,
            startHHMM: bus.turnoStart,
            endHHMM: bus.turnoEnd
          }
        : null
    });
  });
  el.btnInspCenter?.addEventListener('click', () => {
    const bus =
      state.arribos.find((b) => b.key === state.selectedBusKey) ||
      state.trackedUnit?.buses?.find((b) => b.key === state.selectedBusKey) ||
      state.trackedUnit?.bus ||
      state.allFleetBuses.find((b) => b.key === state.selectedBusKey) ||
      null;
    if (bus) {
      haptic('light');
      transitMap.focusBus(bus, 16);
    }
  });
  el.btnInspRoute.addEventListener('click', () => {
    const cod = el.btnInspRoute.dataset.codLinea;
    const name = el.btnInspRoute.dataset.lineName;
    if (cod) loadRouteForLine(cod, name, { clearExisting: true, fit: true });
  });

  el.btnAllBuses?.addEventListener('click', () => toggleAllFleetMode());
  el.btnMapLocate?.addEventListener('click', () => {
    haptic('light');
    locateUserGps();
  });
  el.btnZoomIn.addEventListener('click', () => transitMap.zoomIn());
  el.btnZoomOut.addEventListener('click', () => transitMap.zoomOut());
  el.btnMapCenterStop.addEventListener('click', () => transitMap.focusStop(16));
  el.btnMapScanArea.addEventListener('click', () => {
    const c = transitMap.getCenter();
    searchNearbyStops(c.lat, c.lng, 'el centro del mapa');
  });

  el.btnLocateMe.addEventListener('click', locateUserGps);
  el.btnSearchMapCenter.addEventListener('click', () => {
    const c = transitMap.getCenter();
    searchNearbyStops(c.lat, c.lng, 'el centro del mapa');
  });

  // Alias modal (replaces legacy window.prompt, includes Tab focus trap)
  el.aliasModalForm?.addEventListener('submit', (e) => {
    e.preventDefault();
    const fav = state.favorites.find((x) => x.id === state.editingFavId);
    if (fav) {
      fav.alias = el.aliasModalInput.value.trim();
      saveFavorites();
      haptic('light');
      showToast(fav.alias ? `Etiqueta guardada: ${fav.alias}` : 'Etiqueta eliminada', 'success', 2000);
    }
    closeAliasModal();
  });
  el.btnAliasClose?.addEventListener('click', closeAliasModal);
  el.btnAliasCancel?.addEventListener('click', closeAliasModal);
  el.aliasModal?.addEventListener('click', (e) => {
    if (e.target === el.aliasModal) closeAliasModal();
  });

  el.lineasFilterInput.addEventListener('input', renderDrilldown);
  el.globalSearch.addEventListener('input', (e) => renderGlobalSearchResults(e.target.value));
  el.globalSearch.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const first = el.searchDropdown.querySelector('.search-item[data-res-idx="0"]');
      if (first) first.click();
    } else if (e.key === 'ArrowDown') {
      const first = el.searchDropdown.querySelector('.search-item[data-res-idx="0"]');
      if (first) {
        e.preventDefault();
        first.focus();
      }
    } else if (e.key === 'Escape') {
      closeSearchDropdown();
    }
  });
  el.searchDropdown.addEventListener('keydown', (e) => {
    const opts = Array.from(el.searchDropdown.querySelectorAll('.search-item[data-res-idx]'));
    const idx = opts.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' && opts.length > 0) {
      e.preventDefault();
      opts[(idx + 1) % opts.length].focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (idx <= 0) el.globalSearch.focus();
      else opts[idx - 1].focus();
    } else if (e.key === 'Escape') {
      closeSearchDropdown();
      el.globalSearch.focus();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (el.aliasModal && !el.aliasModal.classList.contains('hidden')) {
      if (e.key === 'Escape') {
        closeAliasModal();
        return;
      }
      if (e.key === 'Tab') {
        const focusables = Array.from(
          el.aliasModal.querySelectorAll('button, input, [tabindex]:not([tabindex="-1"])')
        );
        if (focusables.length > 0) {
          const first = focusables[0];
          const last = focusables[focusables.length - 1];
          if (e.shiftKey && document.activeElement === first) {
            e.preventDefault();
            last.focus();
          } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
        }
      }
    } else if (e.key === 'Escape' && state.inspectorOpen) {
      closeBusInspector();
    }
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.quick-search-wrap')) closeSearchDropdown();
  });

  window.addEventListener('offline', () => {
    state.isOffline = true;
    showToast(
      state.simulateMode
        ? 'Sin conexión · Predicción activa por horarios'
        : 'Sin conexión · Cambiá a EN VIVO para predicción por horarios',
      'info',
      3000
    );
    if (state.activeStop) renderOfflineOrFallback(false);
  });

  window.addEventListener('online', () => {
    if (state.isOffline) {
      state.isOffline = false;
      showToast('Conexión recuperada · Sincronizando GPS...', 'success', 2200);
      if (state.activeStop) fetchArribos(false);
    }
  });

  // Pause kinematic simulation and animations when tab/app is hidden to save battery
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) pauseRealtime();
    else resumeRealtime();
  });

  setupMobileSheet();
}

function pauseRealtime() {
  stopSimLoop();
  document.body.classList.add('app-paused');
  if (state.armedAlerts.size === 0) {
    state.isAppPaused = true;
  }
}

function resumeRealtime() {
  const wasPaused = state.isAppPaused;
  state.isAppPaused = false;
  document.body.classList.remove('app-paused');
  transitMap.invalidateSize();
  if (state.activeStop) {
    if (wasPaused) {
      state.countdownSec = REFRESH_INTERVAL_SEC;
      fetchArribos(false);
    }
    if (state.simulateMode && state.arribos.length > 0) {
      startSimLoop();
    }
  }
}

// Android system back button / swipe-back layered navigation
async function handleNativeBack() {
  if (el.aliasModal && !el.aliasModal.classList.contains('hidden')) {
    closeAliasModal();
    return true;
  }
  if (!el.searchDropdown.classList.contains('hidden')) {
    closeSearchDropdown();
    el.globalSearch.blur();
    return true;
  }
  if (state.inspectorOpen) {
    closeBusInspector();
    return true;
  }
  if (state.horariosOpen) {
    await toggleHorariosView();
    return true;
  }
  if (isBottomSheetLayout() && getSheetIndex() === 2) {
    setSheetIndex(1);
    return true;
  }

  const activeTab = getActiveTab();
  if (activeTab === 'lineas' && state.drill.step !== 'lineas') {
    el.lineasFilterInput.value = '';
    if (state.drill.step === 'paradas' && state.drill.calle) {
      await openCalleIntersecciones(state.drill.calle);
    } else if (state.drill.step === 'intersecciones' && state.drill.linea) {
      await openLineCalles(state.drill.linea);
    } else {
      state.drill = { step: 'lineas', linea: null, calle: null, interseccion: null, items: state.lineas };
      renderDrilldown();
    }
    return true;
  }
  if (activeTab !== 'radar') {
    switchTab('radar');
    return true;
  }
  if (state.activeStop) {
    resetToWelcome();
    return true;
  }
  return false;
}

async function openStopById(stopId, codLinea = '000') {
  const id = String(stopId || '').trim().toUpperCase();
  if (!id) return;
  const known =
    state.quickStops.find((s) => s.id === id) ||
    state.favorites.find((f) => f.id === id) ||
    state.catalogo?.stopById?.get(id) || {
      id,
      nombre: `Parada ${id}`
    };
  await openStopRadar(known, codLinea || '000');
}

async function handleDeepLink(link) {
  if (!link) return;
  if (link.stopId) {
    await openStopById(link.stopId, link.codLinea);
    return;
  }
  if (link.action === 'locate') {
    switchTab('cercanas');
    locateUserGps();
    return;
  }
  if (link.tab && ['radar', 'lineas', 'cercanas', 'favoritas'].includes(link.tab)) {
    switchTab(link.tab);
  }
}

async function init() {
  const prefersLight =
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-color-scheme: light)').matches;
  const savedTheme = localStorage.getItem(STORAGE_THEME_KEY) || (prefersLight ? 'light' : 'dark');
  applyTheme(savedTheme);

  const launchLink = await initNative({
    onBack: handleNativeBack,
    onPause: pauseRealtime,
    onResume: resumeRealtime,
    onDeepLink: (link) => handleDeepLink(link),
    onKeyboard: (open) => {
      if (open && isBottomSheetLayout() && document.activeElement === el.globalSearch) {
        setSheetIndex(0, { silent: true });
      }
      setTimeout(() => transitMap.invalidateSize(), 180);
    }
  });

  // Re-apply system bar colors after native bridge init
  setSystemBarsTheme(savedTheme);

  loadFavorites();
  bindEvents();
  updateSignalPill();

  if (!isNative && 'serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }

  try {
    const [boot, cat] = await Promise.all([api.bootstrap(), api.catalogo().catch(() => null)]);
    state.catalogo = cat;
    state.lineas = Array.isArray(boot.lineas) && boot.lineas.length > 0 ? boot.lineas : cat?.lineas || [];
    state.quickStops = Array.isArray(boot.quickStops) ? boot.quickStops : [];
    state.hubs = Array.isArray(boot.hubs) ? boot.hubs : [];
    state.drill.items = state.lineas;
    renderDrilldown();
    renderHubs();
  } catch {
    showToast('No se pudo cargar el catálogo de líneas', 'warn');
  }

  // On web, warm routes + schedules gently in idle time after initial load; on Android they're bundled inside the APK
  if (!isNative) {
    setTimeout(() => warmOfflineArchive(), 8000);
  }

  const params = new URLSearchParams(window.location.search);
  const paramStopId = (params.get('idParada') || '').trim().toUpperCase();
  const paramCodLinea = params.get('codLinea') || '000';

  if (launchLink) {
    await handleDeepLink(launchLink);
    if (!state.activeStop) renderRadarWelcome();
  } else if (paramStopId) {
    await openStopById(paramStopId, paramCodLinea);
  } else {
    renderRadarWelcome();
  }

  // Reveal the native WebView cleanly once initial content is ready
  requestAnimationFrame(() => {
    transitMap.invalidateSize();
    hideSplash();
  });

  setInterval(() => {
    if (!state.activeStop || state.isAppPaused) return;

    state.countdownSec -= 1;
    if (state.countdownSec <= 0) {
      state.countdownSec = REFRESH_INTERVAL_SEC;
      fetchArribos(false);
    }
  }, 1000);
}

init();
