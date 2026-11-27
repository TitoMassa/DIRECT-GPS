import { getLineColor } from './config.js';
import { formatDistance, formatBlocks } from './api.js';
import { buildTripPlannerIndex, planTripsOffline } from './trip-planner.js';
import {
  buildEntitySevenDayProfile,
  buildPrintableScheduleHtml,
  formatServiceShareText
} from './telemetry.js';
import { RideModeController, speakText, isSpeechSupported } from './ride-mode.js';

const STORAGE_MAP_STYLE_KEY = 'directgps_map_style_v1'; // 'auto' | 'osm' | 'dark'
const STORAGE_ALERT_PREFS_KEY = 'directgps_alert_prefs_v1'; // { leadMin: 3|5|8|10, tts: boolean }
const STORAGE_FAV_ENTITIES_KEY = 'directgps_fav_entities_v1'; // [{ type:'coche'|'chofer', id, label, sub, lineName, codLinea }]

function esc(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function createUiExtras(ctx) {
  const {
    state,
    api,
    transitMap,
    showToast,
    announce,
    getUserGps,
    openStop,
    locateUnitOnMap,
    ensureAllRoutesLoaded,
    onFavoritesChanged,
    getOfflineBundleData,
    getAllLiveUnits,
    applyThemeColor,
    getCurrentThemeHex,
    saveFavorites,
    renderFavoritas
  } = ctx;

  // ── Persistent Extra State ────────────────────────────────────────────────
  let mapStylePref = 'osm';
  try {
    const saved = localStorage.getItem(STORAGE_MAP_STYLE_KEY);
    if (saved === 'osm' || saved === 'dark' || saved === 'auto') mapStylePref = saved;
  } catch {
    // ignore
  }

  let alertPrefs = { leadMin: 3, tts: false };
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_ALERT_PREFS_KEY) || 'null');
    if (raw && typeof raw === 'object') {
      const lm = Number(raw.leadMin);
      alertPrefs = {
        leadMin: [3, 5, 8, 10].includes(lm) ? lm : 3,
        tts: Boolean(raw.tts)
      };
    }
  } catch {
    // ignore
  }

  let favEntities = [];
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_FAV_ENTITIES_KEY) || '[]');
    if (Array.isArray(raw)) favEntities = raw;
  } catch {
    favEntities = [];
  }

  // Per-unit specific alerts (`codLinea:coche`)
  const armedCarAlerts = new Set();
  const triggeredCarAlerts = new Set();

  // Trip planner state
  let plannerIndex = null;
  let plannerOrigin = null; // { lat, lng, label, stopId? }
  let plannerDest = null;
  let lastPlans = [];

  // LED board clock timer
  let ledClockTimer = null;

  // ── 1. Night Map Mode (Zero-API OSM CSS Dark Filter) ──────────────────────
  function resolveEffectiveMapStyle() {
    if (mapStylePref === 'dark') return 'dark';
    if (mapStylePref === 'auto') {
      return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'osm';
    }
    return 'osm';
  }

  function applyMapStyle(nextPref = mapStylePref, { silent = false } = {}) {
    if (nextPref === 'osm' || nextPref === 'dark' || nextPref === 'auto') {
      mapStylePref = nextPref;
      try {
        localStorage.setItem(STORAGE_MAP_STYLE_KEY, mapStylePref);
      } catch {
        // ignore
      }
    }
    const eff = resolveEffectiveMapStyle();
    transitMap?.setTileStyle(eff);

    const btnNight = document.getElementById('btn-map-night-toggle');
    if (btnNight) {
      const isNight = eff === 'dark';
      btnNight.classList.toggle('is-active', isNight);
      btnNight.setAttribute('aria-pressed', String(isNight));
      btnNight.title = isNight ? 'Mapa nocturno activo · Tocá para mapa claro' : 'Activar mapa nocturno';
    }
    document.querySelectorAll('[data-map-style]').forEach((b) => {
      const active = b.dataset.mapStyle === mapStylePref;
      b.classList.toggle('active', active);
      b.setAttribute('aria-pressed', String(active));
    });
    if (!silent) {
      const lbl = mapStylePref === 'dark' ? 'Mapa nocturno activado' : mapStylePref === 'auto' ? 'Mapa automático según tema' : 'Mapa claro activado';
      showToast(lbl, 'info', 2200);
    }
  }

  // ── 2. Alert Preferences & Voice TTS ──────────────────────────────────────
  function saveAlertPrefs() {
    try {
      localStorage.setItem(STORAGE_ALERT_PREFS_KEY, JSON.stringify(alertPrefs));
    } catch {
      // ignore
    }
  }

  function getAlertLeadMinutes() {
    return alertPrefs.leadMin || 3;
  }

  function isTtsEnabled() {
    return Boolean(alertPrefs.tts);
  }

  function speakIfEnabled(text) {
    if (alertPrefs.tts && isSpeechSupported()) {
      speakText(text);
    }
  }

  function toggleCarAlert(codLinea, coche, lineName = '') {
    const key = `${Number(codLinea)}:${String(coche || '').trim()}`;
    if (!coche) return false;
    if (armedCarAlerts.has(key)) {
      armedCarAlerts.delete(key);
      triggeredCarAlerts.delete(key);
      showToast(`Alerta quitada para coche #${coche}`, 'info', 2200);
      return false;
    }
    armedCarAlerts.add(key);
    triggeredCarAlerts.delete(key);
    showToast(`Alerta activada: coche #${coche}${lineName ? ` (${lineName})` : ''} a ≤ ${alertPrefs.leadMin} min`, 'success', 3200);
    return true;
  }

  function isCarAlertArmed(codLinea, coche) {
    return armedCarAlerts.has(`${Number(codLinea)}:${String(coche || '').trim()}`);
  }

  function checkCarAlerts(arribos, activeStop, { soundEnabled, playArrivalChime, notifyArrival }) {
    if (!activeStop || armedCarAlerts.size === 0) return;
    const lead = getAlertLeadMinutes();
    for (const bus of arribos || []) {
      if (!bus.identificadorCoche || !bus.eta?.valid) continue;
      const key = `${Number(bus.codigoLinea)}:${String(bus.identificadorCoche).trim()}`;
      if (armedCarAlerts.has(key) && !triggeredCarAlerts.has(key) && bus.eta.minutes <= lead) {
        triggeredCarAlerts.add(key);
        if (soundEnabled) playArrivalChime();
        const etaTxt = bus.eta.minutes <= 0 ? 'arribando ahora' : `a ${bus.eta.minutes} ${bus.eta.minutes === 1 ? 'minuto' : 'minutos'}`;
        const msg = `Tu coche #${bus.identificadorCoche} de línea ${bus.descripcionLinea} está ${etaTxt}.`;
        showToast(msg, 'success', 6500, { silent: true });
        announce(msg, { assertive: true });
        speakIfEnabled(msg);
        notifyArrival({
          title: `Coche #${bus.identificadorCoche} (${bus.descripcionLinea}) llegando`,
          body: `${etaTxt} · ${activeStop.nombre || activeStop.id}`,
          stopId: activeStop.id
        });
      }
    }
  }

  function clearTriggeredCarAlerts() {
    triggeredCarAlerts.clear();
  }

  // ── 3. Favorite Cars & Drivers ────────────────────────────────────────────
  function saveFavEntities() {
    try {
      localStorage.setItem(STORAGE_FAV_ENTITIES_KEY, JSON.stringify(favEntities));
    } catch {
      // ignore
    }
    onFavoritesChanged?.();
  }

  function getFavEntities() {
    return favEntities;
  }

  function isEntityFavorite(type, id) {
    const norm = String(id || '').trim().toUpperCase();
    return Boolean(norm && favEntities.some((f) => f.type === type && String(f.id).toUpperCase() === norm));
  }

  function toggleEntityFavorite({ type, id, label, sub = '', lineName = '', codLinea = 0 }) {
    const norm = String(id || '').trim().toUpperCase();
    if (!norm) return false;
    const exists = favEntities.some((f) => f.type === type && String(f.id).toUpperCase() === norm);
    if (exists) {
      favEntities = favEntities.filter((f) => !(f.type === type && String(f.id).toUpperCase() === norm));
      saveFavEntities();
      showToast(`${type === 'coche' ? `Coche #${norm}` : label || norm} quitado de favoritos`, 'info', 2200);
      return false;
    }
    favEntities.unshift({
      type,
      id: norm,
      label: label || (type === 'coche' ? `Coche #${norm}` : norm),
      sub,
      lineName,
      codLinea: Number(codLinea) || 0,
      addedAt: Date.now()
    });
    saveFavEntities();
    showToast(`${type === 'coche' ? `Coche #${norm}` : label || norm} guardado en Favoritos`, 'success', 2600);
    return true;
  }

  // ── 4. Modo Viaje (Alarma de Bajada GPS) ──────────────────────────────────
  const rideBanner = document.getElementById('ride-mode-banner');
  const rideTitle = document.getElementById('ride-mode-title');
  const rideSub = document.getElementById('ride-mode-sub');
  const btnRideCancel = document.getElementById('btn-ride-mode-cancel');

  const rideController = new RideModeController({
    radiusMeters: 300,
    onUpdate: (info) => {
      if (!rideBanner) return;
      if (!info) {
        rideBanner.classList.add('hidden');
        rideBanner.classList.remove('is-arrived');
        return;
      }
      rideBanner.classList.remove('hidden');
      rideBanner.classList.toggle('is-arrived', Boolean(info.triggered));
      if (rideTitle) {
        rideTitle.textContent = info.triggered
          ? `¡Bajada próxima! · ${info.target.nombre}`
          : `Modo viaje → ${info.target.nombre}`;
      }
      if (rideSub) {
        rideSub.textContent =
          info.distM !== null
            ? `A ${formatDistance(info.distM)} (${formatBlocks(info.distM)} c.) · Avisa al llegar a ≤ 300 m`
            : 'Obteniendo GPS del celular · Avisa al llegar a ≤ 300 m';
      }
    },
    onTrigger: ({ message }) => {
      showToast(message, 'success', 9000, { silent: true });
      announce(message, { assertive: true });
    },
    onError: (msg) => {
      showToast(msg, 'warn', 4000);
    }
  });

  btnRideCancel?.addEventListener('click', () => {
    rideController.stop();
    showToast('Alarma de bajada desactivada', 'info', 2200);
  });

  function startRideAlarm(stopTarget) {
    if (!stopTarget) return;
    const ok = rideController.start(stopTarget, {
      sound: state.soundEnabled,
      tts: alertPrefs.tts,
      radiusMeters: 300
    });
    if (ok) {
      showToast(`Modo viaje activo: te avisamos 3 cuadras antes de ${stopTarget.nombre || stopTarget.id}`, 'success', 3800);
    }
  }

  // ── 5. 7-Day Cross-Line Car / Driver Profile Modal ────────────────────────
  const profileModal = document.getElementById('profile-modal');
  const profileTitle = document.getElementById('profile-modal-title');
  const profileSub = document.getElementById('profile-modal-sub');
  const profileBody = document.getElementById('profile-modal-body');
  const btnProfileClose = document.getElementById('btn-profile-close');
  const btnProfileFav = document.getElementById('btn-profile-fav');
  let activeProfileReq = null;

  function closeProfileModal() {
    profileModal?.classList.add('hidden');
    activeProfileReq = null;
  }

  btnProfileClose?.addEventListener('click', closeProfileModal);
  profileModal?.addEventListener('click', (e) => {
    if (e.target === profileModal) closeProfileModal();
  });

  btnProfileFav?.addEventListener('click', () => {
    if (!activeProfileReq) return;
    const nowFav = toggleEntityFavorite(activeProfileReq);
    btnProfileFav.classList.toggle('is-active', nowFav);
    btnProfileFav.textContent = nowFav ? '★ Favorito' : '☆ Seguir';
  });

  function openEntityProfileModal(type, id, meta = {}) {
    if (!profileModal || !profileBody) return;
    const bundle = getOfflineBundleData?.() || null;
    const liveUnits = getAllLiveUnits?.() || [];
    const profile = buildEntitySevenDayProfile(type, id, bundle, liveUnits, state.catalogo?.lineByCode);
    if (!profile) {
      showToast('Sin datos históricos suficientes todavía.', 'info', 2400);
      return;
    }

    activeProfileReq = {
      type,
      id: profile.id,
      label: profile.title,
      sub: profile.subtitle,
      lineName: meta.lineName || profile.lines[0] || '',
      codLinea: meta.codLinea || profile.liveNow?.codigoLinea || 0
    };

    if (profileTitle) profileTitle.textContent = profile.title;
    if (profileSub) {
      const liveTxt = profile.liveNow
        ? `● En línea ahora (${profile.liveNow.descripcionLinea || ''})`
        : profile.lines.length > 0
          ? `Líneas en 7 días: ${profile.lines.join(', ')}`
          : profile.subtitle;
      profileSub.textContent = liveTxt;
    }
    if (btnProfileFav) {
      const isFav = isEntityFavorite(type, profile.id);
      btnProfileFav.classList.toggle('is-active', isFav);
      btnProfileFav.textContent = isFav ? '★ Favorito' : '☆ Seguir';
    }

    const linesHtml = profile.lines
      .map(
        (ln) =>
          `<span class="fleet-roster-line-pill" style="background:${getLineColor(ln)}">${esc(ln)}</span>`
      )
      .join('');

    const companionsHtml =
      profile.companions.length > 0
        ? `
          <div class="profile-section">
            <div class="profile-section-title">${type === 'coche' ? 'Choferes en los últimos 7 días' : 'Coches manejados en los últimos 7 días'}</div>
            <div class="profile-chips">
              ${profile.companions
                .slice(0, 12)
                .map((c) => `<span class="profile-chip">${esc(c.label)} <small>×${c.count}</small></span>`)
                .join('')}
            </div>
          </div>
        `
        : '';

    const daysHtml =
      profile.days.length > 0
        ? `
          <div class="profile-section">
            <div class="profile-section-title">Historial diario (${profile.days.length} ${profile.days.length === 1 ? 'día' : 'días'})</div>
            <div class="profile-days-list">
              ${profile.days
                .map((d) => {
                  const [y, mo, da] = d.dayKey.split('-');
                  const niceDate = `${da}/${mo}/${y}`;
                  return `
                    <div class="profile-day-card">
                      <div class="profile-day-date mono">${esc(niceDate)}</div>
                      <div class="profile-day-items">
                        ${d.entries
                          .map((en) => {
                            const col = getLineColor(en.lineName);
                            const srv = en.serviceNumber
                              ? `Srv ${en.serviceNumber}${en.turnoIndex ? ` · T${en.turnoIndex}` : ''}`
                              : '';
                            return `
                              <div class="profile-day-row">
                                <span class="fleet-roster-line-pill" style="background:${col}">${esc(en.lineName)}</span>
                                <div class="profile-day-detail">
                                  <strong>${esc(en.companion)}</strong>
                                  <span>${esc([srv, en.bandera].filter(Boolean).join(' · ') || 'Actividad registrada')}</span>
                                </div>
                              </div>
                            `;
                          })
                          .join('')}
                      </div>
                    </div>
                  `;
                })
                .join('')}
            </div>
          </div>
        `
        : `<div class="fleet-roster-empty">Aún no hay observaciones históricas en el paquete de 7 días para esta unidad.</div>`;

    const liveBannerHtml = profile.liveNow
      ? `
        <div class="profile-live-banner">
          <div>
            <strong>● En línea ahora · Línea ${esc(profile.liveNow.descripcionLinea || '')}</strong>
            <div>${esc(profile.liveNow.realBandera || profile.liveNow.descripcionBandera || 'En servicio')}${
              profile.liveNow.desvio?.label ? ` · Desvío ${esc(profile.liveNow.desvio.label)}` : ''
            }</div>
          </div>
          <button type="button" id="btn-profile-locate-live" class="primary-action-btn seg-btn-xs">Ver en mapa</button>
        </div>
      `
      : '';

    profileBody.innerHTML = `
      ${liveBannerHtml}
      ${linesHtml ? `<div class="profile-lines-row">${linesHtml}</div>` : ''}
      ${companionsHtml}
      ${daysHtml}
    `;

    profileBody.querySelector('#btn-profile-locate-live')?.addEventListener('click', () => {
      const u = profile.liveNow;
      closeProfileModal();
      if (u) locateUnitOnMap?.(u);
    });

    profileModal.classList.remove('hidden');
  }

  // ── 6. "¿Cómo llego?" Offline-First Trip Planner Modal ────────────────────
  const plannerModal = document.getElementById('trip-planner-modal');
  const btnPlannerClose = document.getElementById('btn-planner-close');
  const plannerOrigInput = document.getElementById('planner-origin-input');
  const plannerDestInput = document.getElementById('planner-dest-input');
  const plannerOrigDrop = document.getElementById('planner-origin-dropdown');
  const plannerDestDrop = document.getElementById('planner-dest-dropdown');
  const btnPlannerOrigGps = document.getElementById('btn-planner-origin-gps');
  const btnPlannerSwap = document.getElementById('btn-planner-swap');
  const btnPlannerGo = document.getElementById('btn-planner-go');
  const plannerResultsEl = document.getElementById('planner-results');

  function closePlannerModal() {
    plannerModal?.classList.add('hidden');
  }

  btnPlannerClose?.addEventListener('click', closePlannerModal);
  plannerModal?.addEventListener('click', (e) => {
    if (e.target === plannerModal) closePlannerModal();
  });

  function searchPlaces(query) {
    const q = String(query || '').trim().toLowerCase();
    const out = [];
    for (const h of state.hubs || []) {
      if (!q || h.name.toLowerCase().includes(q)) {
        out.push({ kind: 'hub', label: h.name, sub: 'Zona / Referencia', lat: h.lat, lng: h.lng });
      }
    }
    if (q.length >= 2 && Array.isArray(state.catalogo?.paradas)) {
      for (const p of state.catalogo.paradas) {
        const hay = `${p.id} ${p.nombre}`.toLowerCase();
        if (hay.includes(q)) {
          out.push({
            kind: 'stop',
            stopId: p.id,
            label: p.nombre,
            sub: `Parada ${p.id}`,
            lat: p.lat,
            lng: p.lng
          });
          if (out.length >= 14) break;
        }
      }
    }
    return out.slice(0, 10);
  }

  function wirePlannerAutocomplete(inputEl, dropEl, setter) {
    if (!inputEl || !dropEl) return;
    const renderDrop = () => {
      const items = searchPlaces(inputEl.value);
      if (items.length === 0) {
        dropEl.classList.add('hidden');
        dropEl.innerHTML = '';
        return;
      }
      dropEl.innerHTML = items
        .map(
          (it, idx) => `
          <button type="button" class="planner-ac-item" data-idx="${idx}">
            <strong>${esc(it.label)}</strong>
            <span>${esc(it.sub)}</span>
          </button>
        `
        )
        .join('');
      dropEl.classList.remove('hidden');
      dropEl.querySelectorAll('.planner-ac-item').forEach((btn) => {
        btn.addEventListener('click', () => {
          const picked = items[Number(btn.dataset.idx)];
          if (!picked) return;
          setter(picked);
          inputEl.value = picked.label;
          dropEl.classList.add('hidden');
        });
      });
    };
    inputEl.addEventListener('input', () => {
      setter(null);
      renderDrop();
    });
    inputEl.addEventListener('focus', renderDrop);
    inputEl.addEventListener('blur', () => setTimeout(() => dropEl.classList.add('hidden'), 180));
  }

  wirePlannerAutocomplete(plannerOrigInput, plannerOrigDrop, (v) => {
    plannerOrigin = v;
  });
  wirePlannerAutocomplete(plannerDestInput, plannerDestDrop, (v) => {
    plannerDest = v;
  });

  btnPlannerOrigGps?.addEventListener('click', async () => {
    try {
      if (plannerOrigInput) plannerOrigInput.value = 'Obteniendo GPS...';
      const pos = await getUserGps();
      plannerOrigin = { lat: pos.lat, lng: pos.lng, label: 'Mi ubicación GPS' };
      if (plannerOrigInput) plannerOrigInput.value = 'Mi ubicación GPS';
    } catch {
      if (plannerOrigInput) plannerOrigInput.value = '';
      showToast('No se pudo obtener tu GPS. Escribí una calle o parada.', 'warn', 3200);
    }
  });

  btnPlannerSwap?.addEventListener('click', () => {
    const tmp = plannerOrigin;
    plannerOrigin = plannerDest;
    plannerDest = tmp;
    if (plannerOrigInput) plannerOrigInput.value = plannerOrigin?.label || '';
    if (plannerDestInput) plannerDestInput.value = plannerDest?.label || '';
  });

  async function runTripPlanner() {
    if (!plannerResultsEl) return;
    // Allow automatic match if user typed text without tapping dropdown
    if (!plannerOrigin && plannerOrigInput?.value.trim()) {
      plannerOrigin = searchPlaces(plannerOrigInput.value)[0] || null;
      if (plannerOrigin) plannerOrigInput.value = plannerOrigin.label;
    }
    if (!plannerDest && plannerDestInput?.value.trim()) {
      plannerDest = searchPlaces(plannerDestInput.value)[0] || null;
      if (plannerDest) plannerDestInput.value = plannerDest.label;
    }
    if (!plannerOrigin || !plannerDest) {
      showToast('Elegí un origen y un destino de la lista.', 'warn', 2800);
      return;
    }

    plannerResultsEl.innerHTML = `<div class="fleet-roster-empty">Calculando combinaciones en las 26 líneas...</div>`;
    await ensureAllRoutesLoaded?.();

    if (!plannerIndex || state.routeBranchesCache.size > 0) {
      plannerIndex = buildTripPlannerIndex(state.routeBranchesCache, state.catalogo?.lineByCode);
    }

    let plans = planTripsOffline(plannerIndex, plannerOrigin, plannerDest, { maxResults: 8 });

    // Enrich top 3 unique boarding stops with live ETA when online
    if (!state.isOffline && plans.length > 0) {
      const liveEtaByLineStop = new Map();
      const boardStopIds = Array.from(new Set(plans.slice(0, 4).map((p) => p.legs[0]?.boardStop?.id).filter(Boolean))).slice(0, 3);
      await Promise.all(
        boardStopIds.map(async (sid) => {
          try {
            const res = await api.arribos(sid, '000', { skipCorridor: true });
            for (const a of res?.data?.arribos || []) {
              const cod = Number(a.codigoLinea);
              const txt = String(a.tiempoRestanteArribo || '').toLowerCase();
              const mins = txt.includes('arriband') || txt.includes('llegand') ? 0 : parseInt(txt.match(/(\d+)/)?.[1] || '', 10);
              if (cod && Number.isFinite(mins)) {
                const k = `${cod}:${sid}`;
                if (!liveEtaByLineStop.has(k) || mins < liveEtaByLineStop.get(k)) {
                  liveEtaByLineStop.set(k, mins);
                }
              }
            }
          } catch {
            // Non-fatal offline/timeout
          }
        })
      );
      if (liveEtaByLineStop.size > 0) {
        plans = planTripsOffline(plannerIndex, plannerOrigin, plannerDest, { maxResults: 8, liveEtaByLineStop });
      }
    }

    lastPlans = plans;
    if (plans.length === 0) {
      plannerResultsEl.innerHTML = `<div class="fleet-roster-empty">No encontramos una combinación directa o con 1 trasbordo a menos de 650 m. Probá con una parada o avenida cercana.</div>`;
      return;
    }

    plannerResultsEl.innerHTML = plans
      .map((p, idx) => {
        const pills = p.legs
          .map(
            (l) =>
              `<span class="fleet-roster-line-pill" style="background:${getLineColor(l.lineName)}">${esc(l.lineName)}</span>`
          )
          .join('<span class="planner-arrow">→</span>');
        const waitBadge =
          typeof p.liveWaitMin === 'number'
            ? `<span class="planner-live-badge">● Pasa en ${p.liveWaitMin === 0 ? 'ahora' : `${p.liveWaitMin} min`}</span>`
            : `<span class="planner-offline-badge">${p.transfers === 0 ? 'Directo' : '1 trasbordo'}</span>`;
        const stepsHtml = p.legs
          .map(
            (l, li) => `
            <div class="planner-leg-step">
              <span>${li === 0 ? 'Subí' : 'Trasbordá'} en <strong>${esc(l.boardStop.nombre)}</strong> (${esc(l.boardStop.id)}) · ${l.stopsCount} paradas (~${l.rideMin} min)</span>
              <span>Bajá en <strong>${esc(l.alightStop.nombre)}</strong> (${esc(l.alightStop.id)})</span>
            </div>
          `
          )
          .join('');
        return `
          <div class="planner-result-card" data-plan-idx="${idx}">
            <div class="planner-result-head">
              <div class="planner-pills-wrap">${pills} ${waitBadge}</div>
              <strong class="planner-total-min mono">~${p.totalMin} min</strong>
            </div>
            <div class="planner-walk-meta">Caminata total: ${formatDistance(p.walkTotalM)} (${formatBlocks(p.walkTotalM)} c.)</div>
            ${stepsHtml}
            <div class="planner-card-actions">
              <button type="button" class="seg-btn seg-btn-xs btn-plan-map" data-idx="${idx}">Ver en mapa</button>
              <button type="button" class="seg-btn seg-btn-xs btn-plan-board" data-idx="${idx}">Abrir parada</button>
              <button type="button" class="seg-btn seg-btn-xs btn-plan-ride" data-idx="${idx}">Alarma bajada</button>
            </div>
          </div>
        `;
      })
      .join('');

    plannerResultsEl.querySelectorAll('.btn-plan-map').forEach((btn) => {
      btn.addEventListener('click', () => {
        const plan = lastPlans[Number(btn.dataset.idx)];
        if (!plan) return;
        transitMap?.drawTripPlanRoute(plan, plannerOrigin, plannerDest, state.routeBranchesCache);
        closePlannerModal();
        showToast('Recorrido trazado en el mapa', 'success', 2600);
      });
    });

    plannerResultsEl.querySelectorAll('.btn-plan-board').forEach((btn) => {
      btn.addEventListener('click', () => {
        const plan = lastPlans[Number(btn.dataset.idx)];
        const st = plan?.legs?.[0]?.boardStop;
        if (!st) return;
        closePlannerModal();
        openStop?.({ id: st.id, nombre: st.nombre, lat: st.lat, lng: st.lng }, { focusLineCode: plan.legs[0].codLinea });
      });
    });

    plannerResultsEl.querySelectorAll('.btn-plan-ride').forEach((btn) => {
      btn.addEventListener('click', () => {
        const plan = lastPlans[Number(btn.dataset.idx)];
        const lastLeg = plan?.legs?.[plan.legs.length - 1];
        if (!lastLeg?.alightStop) return;
        closePlannerModal();
        startRideAlarm({ ...lastLeg.alightStop, lineName: lastLeg.lineName });
      });
    });
  }

  btnPlannerGo?.addEventListener('click', runTripPlanner);

  function openTripPlannerModal(presetOrigin = null) {
    if (!plannerModal) return;
    if (presetOrigin) {
      plannerOrigin = presetOrigin;
      if (plannerOrigInput) plannerOrigInput.value = presetOrigin.label || '';
    } else if (!plannerOrigin && state.activeStop) {
      plannerOrigin = {
        lat: state.activeStop.lat,
        lng: state.activeStop.lng,
        label: state.activeStop.nombre || state.activeStop.id,
        stopId: state.activeStop.id
      };
      if (plannerOrigInput) plannerOrigInput.value = plannerOrigin.label;
    }
    plannerModal.classList.remove('hidden');
    setTimeout(() => (plannerOrigin ? plannerDestInput : plannerOrigInput)?.focus(), 80);
  }

  // ── 7. Modo Tablero LED (Pantalla de Parada) ──────────────────────────────
  const ledOverlay = document.getElementById('led-board-overlay');
  const ledStopName = document.getElementById('led-stop-name');
  const ledStopCode = document.getElementById('led-stop-code');
  const ledClock = document.getElementById('led-board-clock');
  const ledList = document.getElementById('led-board-list');
  const btnLedClose = document.getElementById('btn-led-board-close');

  function renderLedBoard() {
    if (!ledOverlay || ledOverlay.classList.contains('hidden')) return;
    if (ledStopName) ledStopName.textContent = state.activeStop?.nombre || 'Parada';
    if (ledStopCode) ledStopCode.textContent = state.activeStop?.id || '';

    const visible = (state.arribos || []).filter(
      (b) => state.filterLine === 'ALL' || b.descripcionLinea === state.filterLine
    );

    if (!ledList) return;
    if (visible.length === 0) {
      ledList.innerHTML = `<div class="led-empty">Sin arribos próximos registrados en este momento.</div>`;
      return;
    }

    ledList.innerHTML = visible
      .slice(0, 8)
      .map((b) => {
        const col = getLineColor(b.descripcionLinea);
        const etaTxt = b.eta?.minutes <= 0 ? 'AHORA' : `${b.eta?.display || b.eta?.minutes || '—'} MIN`;
        const urg = b.eta?.urgency || 'far';
        const desv = b.desvio && b.desvio.status !== 'none' && b.desvio.label ? b.desvio : null;
        return `
          <div class="led-row led-urg-${esc(urg)}">
            <span class="led-line-badge" style="background:${col}">${esc(b.descripcionLinea)}</span>
            <div class="led-mid">
              <div class="led-bandera">${esc(b.realBandera || b.descripcionBandera || '')}</div>
              <div class="led-meta">
                ${b.identificadorCoche ? `<span class="mono">#${esc(b.identificadorCoche)}</span>` : ''}
                ${b.serviceNumber ? `<span>S${b.serviceNumber}${b.lapNumber ? `·V${b.lapNumber}` : ''}</span>` : ''}
                ${desv ? `<span class="desvio-pill desvio-${esc(desv.status)}">${esc(desv.label)}</span>` : ''}
                ${b.esAdaptado ? `<span>♿</span>` : ''}
              </div>
            </div>
            <div class="led-eta mono">${esc(etaTxt)}</div>
          </div>
        `;
      })
      .join('');
  }

  function openLedBoard() {
    if (!ledOverlay || !state.activeStop) return;
    ledOverlay.classList.remove('hidden');
    const tickClock = () => {
      if (!ledClock) return;
      const now = new Date();
      ledClock.textContent = now.toLocaleTimeString('es-AR', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
        timeZone: 'America/Argentina/Buenos_Aires'
      });
    };
    tickClock();
    clearInterval(ledClockTimer);
    ledClockTimer = setInterval(tickClock, 1000);
    renderLedBoard();
  }

  function closeLedBoard() {
    ledOverlay?.classList.add('hidden');
    clearInterval(ledClockTimer);
    ledClockTimer = null;
  }

  btnLedClose?.addEventListener('click', closeLedBoard);

  // ── 8. Settings Tabs inside Theme Modal (Apariencia & Mapa | Alertas & Voz | Respaldo & Diagnóstico) ──
  function wireSettingsModalTabs() {
    const tabBtns = document.querySelectorAll('[data-settings-tab]');
    const panes = document.querySelectorAll('[data-settings-pane]');
    tabBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        const target = btn.dataset.settingsTab;
        tabBtns.forEach((b) => {
          const active = b.dataset.settingsTab === target;
          b.classList.toggle('active', active);
          b.setAttribute('aria-selected', String(active));
        });
        panes.forEach((p) => {
          p.classList.toggle('hidden', p.dataset.settingsPane !== target);
        });
        if (target === 'diag') refreshDiagnosticsPanel();
      });
    });

    // Map style selector buttons
    document.querySelectorAll('[data-map-style]').forEach((btn) => {
      btn.addEventListener('click', () => applyMapStyle(btn.dataset.mapStyle));
    });
    document.getElementById('btn-map-night-toggle')?.addEventListener('click', () => {
      const next = resolveEffectiveMapStyle() === 'dark' ? 'osm' : 'dark';
      applyMapStyle(next);
    });

    // Alert lead-time pills
    const syncAlertUi = () => {
      document.querySelectorAll('[data-alert-lead]').forEach((b) => {
        const active = Number(b.dataset.alertLead) === alertPrefs.leadMin;
        b.classList.toggle('active', active);
        b.setAttribute('aria-pressed', String(active));
      });
      const ttsChk = document.getElementById('chk-tts-alerts');
      if (ttsChk) ttsChk.checked = Boolean(alertPrefs.tts);
    };
    syncAlertUi();

    document.querySelectorAll('[data-alert-lead]').forEach((btn) => {
      btn.addEventListener('click', () => {
        alertPrefs.leadMin = Number(btn.dataset.alertLead) || 3;
        saveAlertPrefs();
        syncAlertUi();
        showToast(`Las alertas avisarán cuando falten ≤ ${alertPrefs.leadMin} min`, 'success', 2400);
      });
    });

    document.getElementById('chk-tts-alerts')?.addEventListener('change', (e) => {
      alertPrefs.tts = Boolean(e.target.checked);
      saveAlertPrefs();
      if (alertPrefs.tts) {
        if (isSpeechSupported()) {
          speakText('Avisos por voz activados en Direct G P S');
        } else {
          showToast('Tu navegador no soporta síntesis de voz.', 'warn', 3000);
        }
      }
    });

    document.getElementById('btn-test-tts')?.addEventListener('click', () => {
      if (!isSpeechSupported()) {
        showToast('Tu navegador no soporta síntesis de voz.', 'warn', 3000);
        return;
      }
      speakText('Línea 106 B, coche 2841, llegando en 3 minutos.');
    });

    // Backup Export & Import
    document.getElementById('btn-backup-export')?.addEventListener('click', async () => {
      const payload = {
        app: 'DIRECT-GPS',
        version: 1,
        exportedAt: new Date().toISOString(),
        favorites: state.favorites || [],
        favEntities,
        themeHex: getCurrentThemeHex?.() || '#121518',
        mapStyle: mapStylePref,
        alertPrefs
      };
      const jsonStr = JSON.stringify(payload, null, 2);
      try {
        await navigator.clipboard?.writeText(jsonStr);
      } catch {
        // ignore clipboard failure
      }
      const blob = new Blob([jsonStr], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `direct-gps-respaldo-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      showToast('Respaldo descargado y copiado al portapapeles', 'success', 3200);
    });

    const importInput = document.getElementById('backup-import-file');
    document.getElementById('btn-backup-import')?.addEventListener('click', () => importInput?.click());
    importInput?.addEventListener('change', async () => {
      const file = importInput.files?.[0];
      if (!file) return;
      try {
        const parsed = JSON.parse(await file.text());
        if (parsed?.app !== 'DIRECT-GPS') throw new Error('Archivo inválido');
        if (Array.isArray(parsed.favorites)) {
          state.favorites = parsed.favorites;
          saveFavorites?.();
        }
        if (Array.isArray(parsed.favEntities)) {
          favEntities = parsed.favEntities;
          saveFavEntities();
        }
        if (parsed.themeHex) applyThemeColor?.(parsed.themeHex);
        if (parsed.mapStyle) applyMapStyle(parsed.mapStyle, { silent: true });
        if (parsed.alertPrefs) {
          alertPrefs = {
            leadMin: [3, 5, 8, 10].includes(Number(parsed.alertPrefs.leadMin)) ? Number(parsed.alertPrefs.leadMin) : 3,
            tts: Boolean(parsed.alertPrefs.tts)
          };
          saveAlertPrefs();
          syncAlertUi();
        }
        renderFavoritas?.();
        showToast('Respaldo restaurado correctamente', 'success', 3200);
      } catch {
        showToast('No se pudo importar: archivo de respaldo inválido.', 'warn', 3500);
      } finally {
        importInput.value = '';
      }
    });

    // Force clean app reload (clears SW caches)
    document.getElementById('btn-force-clean-reload')?.addEventListener('click', async () => {
      showToast('Limpiando caché y recargando la app...', 'info', 2500);
      try {
        if ('caches' in window) {
          const names = await caches.keys();
          await Promise.all(names.map((n) => caches.delete(n)));
        }
        if ('serviceWorker' in navigator) {
          const regs = await navigator.serviceWorker.getRegistrations();
          await Promise.all(regs.map((r) => r.unregister()));
        }
      } catch {
        // Non-fatal
      }
      window.location.reload();
    });
  }

  async function refreshDiagnosticsPanel() {
    const diagEl = document.getElementById('diag-status-box');
    if (!diagEl) return;
    diagEl.innerHTML = `<div class="diag-row"><span>Consultando servidor...</span></div>`;
    let health = null;
    try {
      health = await api.health();
    } catch {
      health = null;
    }
    let storageTxt = 'No disponible';
    try {
      if (navigator.storage?.estimate) {
        const est = await navigator.storage.estimate();
        const usedMb = ((est.usage || 0) / (1024 * 1024)).toFixed(1);
        storageTxt = `${usedMb} MB en caché local`;
      }
    } catch {
      // ignore
    }
    const schedWin = Array.isArray(health?.autoHorariosScan?.scheduleWindows)
      ? health.autoHorariosScan.scheduleWindows.join(' · ')
      : '03:00–04:30 · 15:00–16:00';
    diagEl.innerHTML = `
      <div class="diag-row"><span>Servidor Worker</span><strong class="mono">${health?.ok ? `v${esc(health.version || '?')} · Online` : 'Sin conexión'}</strong></div>
      <div class="diag-row"><span>Retención historial</span><strong>${health?.autoFleetScan?.retentionDays || 7} días</strong></div>
      <div class="diag-row"><span>Escáner horarios</span><strong>${esc(schedWin)}</strong></div>
      <div class="diag-row"><span>Almacenamiento offline</span><strong class="mono">${esc(storageTxt)}</strong></div>
    `;
  }

  // ── 9. Export / Share helpers ─────────────────────────────────────────────
  async function shareServiceSummary(lineName, tipoLabel, serviceSummary, blocks) {
    const txt = formatServiceShareText(lineName, tipoLabel, serviceSummary, blocks);
    if (navigator.share) {
      try {
        await navigator.share({ title: `DIRECT GPS · ${lineName} S${serviceSummary?.serviceNumber || ''}`, text: txt });
        return;
      } catch {
        // fall through to clipboard
      }
    }
    try {
      await navigator.clipboard?.writeText(txt);
      showToast('Resumen del servicio copiado para WhatsApp', 'success', 2800);
    } catch {
      showToast('No se pudo copiar automáticamente.', 'warn', 2600);
    }
  }

  function printScheduleTable(title, subtitle, tableEl) {
    if (!tableEl) return;
    const html = buildPrintableScheduleHtml(title, subtitle, tableEl.outerHTML);
    const win = window.open('', '_blank', 'width=1024,height=740');
    if (!win) {
      showToast('Habilitá las ventanas emergentes para imprimir/guardar PDF.', 'warn', 3500);
      return;
    }
    win.document.open();
    win.document.write(html);
    win.document.close();
  }

  // Initialize controls on creation
  wireSettingsModalTabs();
  applyMapStyle(mapStylePref, { silent: true });

  return {
    applyMapStyle,
    syncAutoMapStyle: () => {
      if (mapStylePref === 'auto') applyMapStyle('auto', { silent: true });
    },
    getAlertLeadMinutes,
    isTtsEnabled,
    speakIfEnabled,
    toggleCarAlert,
    isCarAlertArmed,
    checkCarAlerts,
    clearTriggeredCarAlerts,
    getFavEntities,
    isEntityFavorite,
    toggleEntityFavorite,
    startRideAlarm,
    stopRideAlarm: () => rideController.stop(),
    isRideAlarmActive: () => rideController.isActive(),
    openEntityProfileModal,
    closeProfileModal,
    openTripPlannerModal,
    closePlannerModal,
    openLedBoard,
    closeLedBoard,
    renderLedBoard,
    shareServiceSummary,
    printScheduleTable
  };
}
