import { getLineColor } from './config.js';
import { formatDistance, formatBlocks } from './api.js';
import { formatSecHHMM } from './predictor.js';
import {
  buildEntitySevenDayProfile,
  formatServiceShareText
} from './telemetry.js';
import {
  dedupeOrderedStops,
  pickKeyStopsForBranch,
  buildScheduleExportSections,
  renderScheduleImageToCanvas,
  exportCanvasAsImage
} from './schedule-image.js';
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
    locateUnitOnMap,
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

  // ── 6. Customizable Schedule Image Exporter (PNG / JPG — Ida/Vuelta + Paradas) ──
  const expModal = document.getElementById('schedule-export-modal');
  const expSub = document.getElementById('sched-exp-sub');
  const btnExpClose = document.getElementById('btn-sched-exp-close');
  const expDirRow = document.getElementById('sched-exp-dir-row');
  const expSrvPills = document.getElementById('sched-exp-srv-pills');
  const expBranchTabs = document.getElementById('sched-exp-branch-tabs');
  const expStopsList = document.getElementById('sched-exp-stops-list');
  const btnExpStopsAll = document.getElementById('btn-sched-exp-stops-all');
  const btnExpStopsKey = document.getElementById('btn-sched-exp-stops-key');
  const btnExpStopsNone = document.getElementById('btn-sched-exp-stops-none');
  const expCanvas = document.getElementById('sched-exp-canvas');
  const expEmptyMsg = document.getElementById('sched-exp-empty-msg');
  const btnExpShare = document.getElementById('btn-sched-exp-share');
  const btnExpDownload = document.getElementById('btn-sched-exp-download');

  let expCtx = null; // { linea, model, branches, activeBranchIdx, tipoDia, tipoLabel, dirMode, serviceFilter, editBranchIdx, selectedStopsByBranch, format, theme }

  function closeScheduleExportModal() {
    expModal?.classList.add('hidden');
    expCtx = null;
  }

  btnExpClose?.addEventListener('click', closeScheduleExportModal);
  expModal?.addEventListener('click', (e) => {
    if (e.target === expModal) closeScheduleExportModal();
  });

  function renderScheduleExportPreview() {
    if (!expCtx || !expCanvas) return;
    const { linea, model, branches, activeBranchIdx, tipoLabel, dirMode, serviceFilter, selectedStopsByBranch, format, theme } = expCtx;

    // Sync direction pills
    expDirRow?.querySelectorAll('[data-exp-dir]').forEach((b) => {
      const val = b.dataset.expDir;
      const disabled = val === 'both' && branches.length < 2;
      b.disabled = disabled;
      const active = val === dirMode;
      b.classList.toggle('active', active);
      b.setAttribute('aria-pressed', String(active));
    });

    // Sync format & theme pills
    expModal?.querySelectorAll('[data-exp-format]').forEach((b) => {
      const active = b.dataset.expFormat === format;
      b.classList.toggle('active', active);
      b.setAttribute('aria-pressed', String(active));
    });
    expModal?.querySelectorAll('[data-exp-theme]').forEach((b) => {
      const active = b.dataset.expTheme === theme;
      b.classList.toggle('active', active);
      b.setAttribute('aria-pressed', String(active));
    });
    if (btnExpDownload) {
      btnExpDownload.textContent = `Descargar ${format.toUpperCase()}`;
    }

    // Build service summary lines when a specific service is chosen
    const serviceSummaryLines = [];
    if (serviceFilter !== 'ALL' && Array.isArray(model?.blocks)) {
      const srvBlocks = model.blocks
        .filter((b) => String(b.serviceNumber) === String(serviceFilter))
        .sort((a, b) => a.startSec - b.startSec);
      for (const blk of srvBlocks) {
        const tTag = srvBlocks.length > 1 ? `T${blk.turnoIndex}/${srvBlocks.length}` : 'Turno corrido';
        const places = [blk.startPlace || '', blk.endPlace || ''].filter(Boolean).join(' → ');
        const reg = blk.isCortado ? ' [Cortado]' : blk.relevoToNext ? ' [Relevo]' : '';
        serviceSummaryLines.push(
          `${tTag} (${formatSecHHMM(blk.startSec)}–${formatSecHHMM(blk.endSec)})${reg}${places ? ` · ${places}` : ''}`
        );
      }
    }

    const built = buildScheduleExportSections(model, branches, {
      mode: dirMode,
      activeBranchIdx,
      serviceFilter,
      selectedStopIdsByBranch: selectedStopsByBranch
    });

    if (built.sections.length === 0) {
      expCanvas.classList.add('hidden');
      expEmptyMsg?.classList.remove('hidden');
      if (btnExpDownload) btnExpDownload.disabled = true;
      if (btnExpShare) btnExpShare.disabled = true;
      return;
    }

    expCanvas.classList.remove('hidden');
    expEmptyMsg?.classList.add('hidden');
    if (btnExpDownload) btnExpDownload.disabled = false;
    if (btnExpShare) btnExpShare.disabled = false;

    const dirSuffix = dirMode === 'both' && branches.length >= 2 ? 'Ida y Vuelta' : branches[activeBranchIdx]?.bandera || '';
    const srvLabel = serviceFilter === 'ALL' ? 'Todos los servicios' : `Servicio ${serviceFilter}`;

    renderScheduleImageToCanvas(
      expCanvas,
      {
        lineName: linea.descripcion,
        tipoLabel: `${tipoLabel}${dirMode === 'both' && branches.length >= 2 ? ' · Ida y Vuelta' : ''}`,
        serviceLabel: dirMode === 'both' && branches.length >= 2 ? srvLabel : `${srvLabel}${dirSuffix ? ` · ${dirSuffix}` : ''}`,
        serviceSummaryLines,
        sections: built.sections
      },
      { theme }
    );
  }

  function renderScheduleExportStopPicker() {
    if (!expCtx || !expStopsList) return;
    const { branches, dirMode, activeBranchIdx, selectedStopsByBranch } = expCtx;

    // Show branch selector tabs when "Ida y Vuelta" is active so user can pick stops for EACH direction
    if (expBranchTabs) {
      if (dirMode === 'both' && branches.length >= 2) {
        expBranchTabs.classList.remove('hidden');
        expBranchTabs.innerHTML = branches
          .map((br, idx) => {
            const allSt = dedupeOrderedStops(br);
            const chosen = selectedStopsByBranch.get(idx)?.size ?? allSt.length;
            const lbl = branches.length === 2 ? (idx === 0 ? 'Ida' : 'Vuelta') : `Ramal ${idx + 1}`;
            const active = expCtx.editBranchIdx === idx;
            return `<button type="button" class="flota-tab-btn ${active ? 'active' : ''}" data-exp-edit-br="${idx}" role="tab" aria-selected="${active}">${lbl} (${chosen}/${allSt.length})</button>`;
          })
          .join('');
        expBranchTabs.querySelectorAll('[data-exp-edit-br]').forEach((b) => {
          b.addEventListener('click', () => {
            expCtx.editBranchIdx = Number(b.dataset.expEditBr) || 0;
            renderScheduleExportStopPicker();
          });
        });
      } else {
        expBranchTabs.classList.add('hidden');
        expCtx.editBranchIdx = activeBranchIdx;
      }
    }

    const brIdx = expCtx.editBranchIdx;
    const br = branches[brIdx];
    const allStops = dedupeOrderedStops(br);
    const chosenSet = selectedStopsByBranch.get(brIdx) || new Set(allStops.map((s) => s.id));
    selectedStopsByBranch.set(brIdx, chosenSet);

    expStopsList.innerHTML = allStops
      .map((st, idx) => {
        const checked = chosenSet.has(st.id);
        const isEnd = idx === 0 || idx === allStops.length - 1;
        return `
          <label class="sched-exp-stop-row ${checked ? 'is-checked' : ''}">
            <input type="checkbox" class="sched-exp-stop-chk" data-stop-id="${esc(st.id)}" ${checked ? 'checked' : ''} />
            <span class="sched-exp-stop-num mono">#${idx + 1}</span>
            <span class="sched-exp-stop-name">${esc(st.nombre)}${isEnd ? ' <small>(Cabecera)</small>' : ''}</span>
            <span class="sched-exp-stop-code mono">${esc(st.id)}</span>
          </label>
        `;
      })
      .join('');

    expStopsList.querySelectorAll('.sched-exp-stop-chk').forEach((chk) => {
      chk.addEventListener('change', () => {
        const sid = chk.dataset.stopId;
        if (!sid) return;
        if (chk.checked) chosenSet.add(sid);
        else chosenSet.delete(sid);
        chk.closest('.sched-exp-stop-row')?.classList.toggle('is-checked', chk.checked);
        // Update tab counters if Ida y Vuelta
        if (expCtx.dirMode === 'both' && expBranchTabs) {
          const tabBtn = expBranchTabs.querySelector(`[data-exp-edit-br="${brIdx}"]`);
          if (tabBtn) {
            const lbl = branches.length === 2 ? (brIdx === 0 ? 'Ida' : 'Vuelta') : `Ramal ${brIdx + 1}`;
            tabBtn.textContent = `${lbl} (${chosenSet.size}/${allStops.length})`;
          }
        }
        renderScheduleExportPreview();
      });
    });
  }

  function renderScheduleExportServicePills() {
    if (!expCtx || !expSrvPills) return;
    const { model, branches, serviceFilter } = expCtx;
    const srvSet = new Set();
    for (const br of branches) {
      for (const tr of model.getTripsForBranch(br) || []) {
        if (Number.isFinite(tr.serviceNumber) && tr.serviceNumber > 0) srvSet.add(tr.serviceNumber);
      }
    }
    const nums = Array.from(srvSet).sort((a, b) => a - b);
    const items = [{ val: 'ALL', label: 'Todos' }, ...nums.map((n) => ({ val: String(n), label: `Srv ${n}` }))];
    expSrvPills.innerHTML = items
      .map(
        (it) =>
          `<button type="button" class="events-pill ${String(serviceFilter) === it.val ? 'active' : ''}" data-exp-srv="${esc(it.val)}" aria-pressed="${String(serviceFilter) === it.val}">${esc(it.label)}</button>`
      )
      .join('');

    expSrvPills.querySelectorAll('[data-exp-srv]').forEach((btn) => {
      btn.addEventListener('click', () => {
        expCtx.serviceFilter = btn.dataset.expSrv || 'ALL';
        renderScheduleExportServicePills();
        renderScheduleExportPreview();
      });
    });
  }

  expDirRow?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-exp-dir]');
    if (!btn || btn.disabled || !expCtx) return;
    expCtx.dirMode = btn.dataset.expDir === 'both' ? 'both' : 'active';
    if (expCtx.dirMode === 'active') expCtx.editBranchIdx = expCtx.activeBranchIdx;
    renderScheduleExportStopPicker();
    renderScheduleExportPreview();
  });

  expModal?.addEventListener('click', (e) => {
    const fmtBtn = e.target.closest('[data-exp-format]');
    if (fmtBtn && expCtx) {
      expCtx.format = fmtBtn.dataset.expFormat === 'jpg' ? 'jpg' : 'png';
      renderScheduleExportPreview();
      return;
    }
    const thBtn = e.target.closest('[data-exp-theme]');
    if (thBtn && expCtx) {
      expCtx.theme = thBtn.dataset.expTheme === 'light' ? 'light' : 'dark';
      renderScheduleExportPreview();
    }
  });

  btnExpStopsAll?.addEventListener('click', () => {
    if (!expCtx) return;
    const br = expCtx.branches[expCtx.editBranchIdx];
    expCtx.selectedStopsByBranch.set(expCtx.editBranchIdx, new Set(dedupeOrderedStops(br).map((s) => s.id)));
    renderScheduleExportStopPicker();
    renderScheduleExportPreview();
  });

  btnExpStopsKey?.addEventListener('click', () => {
    if (!expCtx) return;
    const br = expCtx.branches[expCtx.editBranchIdx];
    expCtx.selectedStopsByBranch.set(expCtx.editBranchIdx, pickKeyStopsForBranch(br, 7));
    renderScheduleExportStopPicker();
    renderScheduleExportPreview();
  });

  btnExpStopsNone?.addEventListener('click', () => {
    if (!expCtx) return;
    expCtx.selectedStopsByBranch.set(expCtx.editBranchIdx, new Set());
    renderScheduleExportStopPicker();
    renderScheduleExportPreview();
  });

  const buildExportFileName = () => {
    if (!expCtx) return 'direct-gps-horarios';
    const ln = String(expCtx.linea?.descripcion || 'linea').replace(/[^a-z0-9]+/gi, '');
    const srv = expCtx.serviceFilter === 'ALL' ? 'todos' : `srv${expCtx.serviceFilter}`;
    const dir = expCtx.dirMode === 'both' ? 'ida-vuelta' : `r${expCtx.activeBranchIdx + 1}`;
    return `direct-gps-${ln}-${expCtx.tipoDia || 'habil'}-${srv}-${dir}`.toLowerCase();
  };

  btnExpDownload?.addEventListener('click', async () => {
    if (!expCtx || !expCanvas) return;
    const res = await exportCanvasAsImage(expCanvas, {
      format: expCtx.format,
      fileName: buildExportFileName(),
      share: false
    });
    if (res.ok) {
      showToast(`Imagen ${expCtx.format.toUpperCase()} descargada`, 'success', 2600);
    }
  });

  btnExpShare?.addEventListener('click', async () => {
    if (!expCtx || !expCanvas) return;
    const res = await exportCanvasAsImage(expCanvas, {
      format: expCtx.format,
      fileName: buildExportFileName(),
      share: true
    });
    if (res.ok && res.mode === 'downloaded') {
      showToast(`Imagen ${expCtx.format.toUpperCase()} guardada (lista para enviar por WhatsApp)`, 'success', 3000);
    }
  });

  function openScheduleExportModal({ linea, model, branches, activeBranchIdx = 0, tipoDia = 'habil', tipoLabel = 'Lun–Vie', serviceFilter = 'ALL' }) {
    if (!expModal || !model || !Array.isArray(branches) || branches.length === 0) return;
    const safeIdx = Math.max(0, Math.min(branches.length - 1, Number(activeBranchIdx) || 0));
    const selectedStopsByBranch = new Map();
    branches.forEach((br, idx) => {
      // Pre-select smart key stops if branch is very long (>18 stops), or all stops if compact — user can click "Todas" in 1 tap!
      const ordered = dedupeOrderedStops(br);
      selectedStopsByBranch.set(
        idx,
        ordered.length > 18 ? pickKeyStopsForBranch(br, 9) : new Set(ordered.map((s) => s.id))
      );
    });

    expCtx = {
      linea,
      model,
      branches,
      activeBranchIdx: safeIdx,
      editBranchIdx: safeIdx,
      tipoDia,
      tipoLabel,
      // If user already isolated a specific service, default to "Ida y Vuelta" (when 2+ branches exist) so they immediately see the full round-trip service!
      dirMode: serviceFilter !== 'ALL' && branches.length >= 2 ? 'both' : 'active',
      serviceFilter: String(serviceFilter || 'ALL'),
      selectedStopsByBranch,
      format: 'png',
      theme: document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'
    };

    if (expSub) {
      expSub.textContent = `Línea ${linea.descripcion} · ${tipoLabel} · Elegí sentido, servicio y paradas`;
    }

    renderScheduleExportServicePills();
    renderScheduleExportStopPicker();
    renderScheduleExportPreview();
    expModal.classList.remove('hidden');
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
    openScheduleExportModal,
    closeScheduleExportModal,
    openLedBoard,
    closeLedBoard,
    renderLedBoard,
    shareServiceSummary
  };
}
