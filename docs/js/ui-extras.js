import { getLineColor } from './config.js';
import { formatDistance, formatBlocks, getApiBase } from './api.js';
import { formatSecHHMM } from './predictor.js';
import { playArrivalChime } from './audio.js';
import {
  isNative,
  ensureNotificationPermission,
  getNotificationPermissionState,
  getDetailedPermissionsStatus,
  requestStartupPermissions,
  requestBackgroundLocationPermission,
  openNativeAppSettings,
  onSwNotificationAction,
  openAndroidBatterySettings,
  speakViaNativeAndroid,
  upsertNativeWatchAlert,
  removeNativeWatchAlert,
  getNotificationRingtone,
  pickNotificationRingtone,
  resetNotificationRingtone,
  shareNativeImage,
  getNativeAndroidStatus,
  haptic,
  notifyArrival as sendNativeNotification
} from './native.js';
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
import {
  LiveTripTracker,
  buildArrivalSpeechMessage,
  speakText,
  speakAfterNotification,
  isSpeechSupported
} from './ride-mode.js';

const STORAGE_MAP_STYLE_KEY = 'directgps_map_style_v1'; // 'auto' | 'osm' | 'dark'
const STORAGE_ALERT_PREFS_KEY = 'directgps_alert_prefs_v1'; // { leadMin: 3|5|8|10, tts: boolean, minuteByMinute: boolean, ttsRate: number, ttsSpeakInDnd: boolean }
const STORAGE_FAV_ENTITIES_KEY = 'directgps_fav_entities_v1'; // [{ type:'coche'|'chofer', id, label, sub, lineName, codLinea }]
const STORAGE_SIMPLE_MODE_KEY = 'directgps_simple_mode_v1';
const STORAGE_PERMS_DISMISSED_KEY = 'directgps_perms_prompt_dismissed_v1';

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
    renderFavoritas,
    ensureLineBranchesLoaded
  } = ctx;

  // ── Persistent Extra State ────────────────────────────────────────────────
  let mapStylePref = 'osm';
  try {
    const saved = localStorage.getItem(STORAGE_MAP_STYLE_KEY);
    if (saved === 'osm' || saved === 'dark' || saved === 'auto') mapStylePref = saved;
  } catch {
    // ignore
  }

  let alertPrefs = { leadMin: 3, tts: false, minuteByMinute: false, ttsRate: 1.02, ttsSpeakInDnd: true };
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_ALERT_PREFS_KEY) || 'null');
    if (raw && typeof raw === 'object') {
      const lm = Number(raw.leadMin);
      const rateRaw = Number(raw.ttsRate);
      const validRate = [0.85, 1.02, 1.2].find((r) => Math.abs(r - rateRaw) < 0.02);
      alertPrefs = {
        leadMin: [3, 5, 8, 10].includes(lm) ? lm : 3,
        tts: Boolean(raw.tts),
        minuteByMinute: Boolean(raw.minuteByMinute),
        ttsRate: validRate || 1.02,
        ttsSpeakInDnd: raw.ttsSpeakInDnd !== false
      };
    }
  } catch {
    // ignore
  }

  let simpleModeEnabled = false;
  try {
    simpleModeEnabled = localStorage.getItem(STORAGE_SIMPLE_MODE_KEY) === 'true';
  } catch {
    simpleModeEnabled = false;
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

  // ── 2. Alert Preferences & Natural Voice TTS (After Chime) ────────────────
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

  function isMinuteByMinuteEnabled() {
    return Boolean(alertPrefs.minuteByMinute);
  }

  function speakIfEnabled(text, { afterChime = false, delayMs = 950 } = {}) {
    if (!alertPrefs.tts || !text) return;
    if (isNative) {
      speakViaNativeAndroid(text, { delayMs: afterChime ? delayMs : 0 });
      return;
    }
    if (!isSpeechSupported()) return;
    if (afterChime) {
      speakAfterNotification(text, { delayMs, rate: alertPrefs.ttsRate });
    } else {
      speakText(text, { rate: alertPrefs.ttsRate });
    }
  }

  function toggleCarAlert(codLinea, coche, lineName = '') {
    const key = `${Number(codLinea)}:${String(coche || '').trim()}`;
    if (!coche) return false;
    if (armedCarAlerts.has(key)) {
      armedCarAlerts.delete(key);
      triggeredCarAlerts.delete(key);
      if (isNative) removeNativeWatchAlert(`car::${key}`);
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

  function checkCarAlerts(arribos, activeStop, { soundEnabled, playArrivalChime: playChime, notifyArrival }) {
    if (!activeStop || armedCarAlerts.size === 0) return;
    const lead = getAlertLeadMinutes();
    for (const bus of arribos || []) {
      if (!bus.identificadorCoche || !bus.eta?.valid) continue;
      const key = `${Number(bus.codigoLinea)}:${String(bus.identificadorCoche).trim()}`;
      if (!armedCarAlerts.has(key)) continue;

      // Android APK: el servicio nativo mantiene UNA notificación en vivo (actualizada en el lugar),
      // suena el timbre y lee TTS aunque la app esté cerrada.
      if (isNative) {
        const rawDist = Number(bus.routeMeters ?? bus.distanceMeters);
        const rawEtaSec = Number(bus.etaSecondsRemaining);
        const etaMinVal = Math.max(0, Math.round(bus.eta.minutes));
        upsertNativeWatchAlert({
          key: `car::${key}`,
          apiBase: getApiBase(),
          stopId: String(activeStop.id || '').toUpperCase(),
          stopName: activeStop.nombre || activeStop.id,
          stopLat: Number(activeStop.lat) || 0,
          stopLng: Number(activeStop.lng) || 0,
          lineName: bus.descripcionLinea,
          codLinea: Number(bus.codigoLinea) || 0,
          coche: String(bus.identificadorCoche).trim(),
          lockCar: true,
          choferNombre: bus.choferNombre || '',
          scheduledHHMM: /^\d{1,2}:\d{2}/.test(String(bus.turnoProgramado || '')) ? String(bus.turnoProgramado).slice(0, 5) : '',
          distM: Number.isFinite(rawDist) && rawDist >= 0 ? Math.round(rawDist) : -1,
          etaMin: etaMinVal,
          etaSec: Number.isFinite(rawEtaSec) && rawEtaSec >= 0 ? Math.round(rawEtaSec) : etaMinVal * 60,
          simSpeedMps: Number.isFinite(Number(bus.simSpeedMps)) && Number(bus.simSpeedMps) > 0.3 ? Number(Number(bus.simSpeedMps).toFixed(2)) : -1,
          fromLiveSim: Boolean(state.simulateMode && bus.simActive),
          leadMin: lead,
          minuteByMinute: Boolean(alertPrefs.minuteByMinute),
          ttsEnabled: Boolean(alertPrefs.tts),
          soundEnabled: Boolean(soundEnabled)
        });
        if (!triggeredCarAlerts.has(key) && bus.eta.minutes <= lead) {
          triggeredCarAlerts.add(key);
          const etaTxt = bus.eta.minutes <= 0 ? 'arribando ahora' : `a ${bus.eta.minutes} ${bus.eta.minutes === 1 ? 'minuto' : 'minutos'}`;
          showToast(`Tu coche #${bus.identificadorCoche} (${bus.descripcionLinea}) está ${etaTxt}.`, 'success', 6500, { silent: true });
        }
        continue;
      }

      if (!triggeredCarAlerts.has(key) && bus.eta.minutes <= lead) {
        triggeredCarAlerts.add(key);
        const etaTxt = bus.eta.minutes <= 0 ? 'arribando ahora' : `a ${bus.eta.minutes} ${bus.eta.minutes === 1 ? 'minuto' : 'minutos'}`;
        const toastMsg = `Tu coche #${bus.identificadorCoche} (${bus.descripcionLinea}) está ${etaTxt}.`;
        const speechMsg = buildArrivalSpeechMessage({
          lineName: bus.descripcionLinea,
          coche: bus.identificadorCoche,
          etaMin: bus.eta.minutes,
          stopName: activeStop.nombre || ''
        });
        showToast(toastMsg, 'success', 6500, { silent: true });
        announce(toastMsg, { assertive: true });
        Promise.resolve(
          notifyArrival({
            title: `🔔 Coche #${bus.identificadorCoche} (${bus.descripcionLinea}) llegando`,
            body: `${etaTxt}${bus.choferNombre ? ` · ${bus.choferNombre}` : ''}${bus.turnoProgramado ? ` · Prog. real: ${bus.turnoProgramado}` : ''}\n${activeStop.nombre || activeStop.id}`,
            stopId: activeStop.id,
            tag: `direct-gps-car-${key}`,
            speechText: speechMsg,
            speakAfterChime: Boolean(alertPrefs.tts)
          })
        ).then((res) => {
          if (!res?.delivered && soundEnabled) (playChime || playArrivalChime)();
          if (!res?.handledSpeechNatively) {
            // Hablar DESPUÉS del timbre de notificación
            speakIfEnabled(speechMsg, { afterChime: true, delayMs: 950 });
          }
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

  // ── 4. Live Trip Tracker (Android Real-Time Push Notifications + Accessible Subir/Bajar) ──
  function syncNotifPermissionButtons() {
    const perm = getNotificationPermissionState();
    const settingsNotifBtn = document.getElementById('btn-enable-android-notifs');
    if (settingsNotifBtn) {
      if (perm === 'granted') {
        settingsNotifBtn.textContent = isNative
          ? '✓ Notif. Android activas · Permitir 2° plano'
          : '✓ Notificaciones Android activas';
        settingsNotifBtn.classList.add('active');
      } else if (perm === 'denied') {
        settingsNotifBtn.textContent = '⚠ Notificaciones bloqueadas en ajustes';
        settingsNotifBtn.classList.remove('active');
      } else {
        settingsNotifBtn.textContent = '🔔 Activar notificaciones Android';
        settingsNotifBtn.classList.remove('active');
      }
    }
  }

  const liveTracker = new LiveTripTracker({
    onUpdate: () => {
      syncNotifPermissionButtons();
    },
    onToast: (msg, kind, dur) => showToast(msg, kind, dur),
    onAnnounce: (msg) => announce(msg, { assertive: true }),
    onStopArrival: ({ stop, speech }) => {
      showToast(`🔔 ARRIBANDO · ${stop.cleanName}`, 'success', 6000, { silent: true });
      announce(speech, { assertive: true });
    }
  });

  liveTracker.syncPrefs({
    minuteByMinute: alertPrefs.minuteByMinute,
    ttsEnabled: alertPrefs.tts,
    soundEnabled: state.soundEnabled,
    leadMin: alertPrefs.leadMin,
    ttsSpeechRate: alertPrefs.ttsRate,
    ttsSpeakInDnd: alertPrefs.ttsSpeakInDnd
  });

  // Escuchar acciones enviadas directamente desde los botones de la notificación Android (Subir / Ya subí / Bajar / Detener)
  onSwNotificationAction(async (action, data) => {
    if (action === 'alight') {
      liveTracker.alight();
    } else if (action === 'stop-track') {
      liveTracker.stop();
    } else if (action === 'board' || action === 'board-now') {
      const snap = liveTracker.getSnapshot();
      const cod = Number(snap.codLinea || data?.codLinea) || 0;
      if (cod && ensureLineBranchesLoaded) {
        await ensureLineBranchesLoaded([cod]).catch(() => {});
      }
      liveTracker.requestBoard({
        immediate: action === 'board-now',
        routeBranchesCache: state.routeBranchesCache
      });
    } else if (action === 'speak' && data?.text) {
      speakIfEnabled(data.text, { afterChime: true, delayMs: 950 });
    }
  });

  async function startLiveLineTrack({ stop, lineName, codLinea, bus = null, lockCar = false } = {}) {
    if (!stop || !lineName) return false;
    // No pisar un viaje "A bordo" ya activo al cambiar de filtro
    if (liveTracker.isOnboard()) return false;
    if (codLinea && ensureLineBranchesLoaded) {
      ensureLineBranchesLoaded([codLinea]).catch(() => {});
    }
    liveTracker.syncPrefs({
      minuteByMinute: alertPrefs.minuteByMinute,
      ttsEnabled: alertPrefs.tts,
      soundEnabled: state.soundEnabled,
      leadMin: alertPrefs.leadMin
    });
    const ok = liveTracker.startWaiting({
      stop,
      lineName,
      codLinea,
      bus,
      lockCar,
      minuteByMinute: alertPrefs.minuteByMinute,
      ttsEnabled: alertPrefs.tts,
      soundEnabled: state.soundEnabled
    });
    syncNotifPermissionButtons();
    return ok;
  }

  function updateLiveTripFromArrivals(arribos, activeStop, { fromSimTick = false } = {}) {
    if (!fromSimTick) {
      liveTracker.syncPrefs({
        minuteByMinute: alertPrefs.minuteByMinute,
        ttsEnabled: alertPrefs.tts,
        soundEnabled: state.soundEnabled,
        leadMin: alertPrefs.leadMin,
        ttsSpeechRate: alertPrefs.ttsRate,
        ttsSpeakInDnd: alertPrefs.ttsSpeakInDnd
      });
    }
    if (liveTracker.isOnboard()) {
      const snap = liveTracker.getSnapshot();
      const matched = (arribos || []).find(
        (b) =>
          (snap.coche && String(b.identificadorCoche || '') === snap.coche) ||
          (snap.codLinea && Number(b.codigoLinea) === snap.codLinea)
      );
      if (matched) liveTracker.updateOnboardFromBus(matched);
      return;
    }
    liveTracker.updateFromArrivals(arribos, activeStop, state.routeBranchesCache, { fromSimTick });
  }

  function updateLiveTripFromBus(bus) {
    if (!bus || !liveTracker.isOnboard()) return;
    const snap = liveTracker.getSnapshot();
    if (snap.coche && String(bus.identificadorCoche || '') !== snap.coche) return;
    liveTracker.updateOnboardFromBus(bus);
  }

  async function requestBoardBus(bus, { immediate = false } = {}) {
    if (!bus) return false;
    await ensureNotificationPermission();
    syncNotifPermissionButtons();
    const cod = Number(bus.codigoLinea) || 0;
    if (cod && ensureLineBranchesLoaded) {
      await ensureLineBranchesLoaded([cod]).catch(() => {});
    }
    liveTracker.syncPrefs({
      minuteByMinute: alertPrefs.minuteByMinute,
      ttsEnabled: alertPrefs.tts,
      soundEnabled: state.soundEnabled,
      leadMin: alertPrefs.leadMin
    });
    if (state.activeStop && !bus.isFreeTracked && !bus.isCityFleet && !liveTracker.isActive()) {
      liveTracker.startWaiting({
        stop: state.activeStop,
        lineName: bus.descripcionLinea,
        codLinea: cod,
        bus,
        lockCar: Boolean(bus.identificadorCoche),
        minuteByMinute: alertPrefs.minuteByMinute,
        ttsEnabled: alertPrefs.tts,
        soundEnabled: state.soundEnabled
      });
    }
    return liveTracker.requestBoard({
      immediate: immediate || Boolean(bus.isFreeTracked || bus.isCityFleet),
      bus,
      branch: bus._matchedBranch || bus.trajectory?.branch || null,
      routeBranchesCache: state.routeBranchesCache
    });
  }

  function alightFromBus() {
    liveTracker.alight();
  }

  function stopLiveTrip({ silent = false } = {}) {
    if (!liveTracker.isOnboard()) {
      liveTracker.stop({ silent });
    }
  }

  function hasActiveTrackingSession() {
    return liveTracker.isActive() || armedCarAlerts.size > 0;
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
    if (isNative) {
      const mime = expCtx.format === 'jpg' ? 'image/jpeg' : 'image/png';
      const ext = expCtx.format === 'jpg' ? 'jpg' : 'png';
      const dataUrl = expCanvas.toDataURL(mime, 0.94);
      const shared = await shareNativeImage({
        dataUrl,
        filename: `${buildExportFileName()}.${ext}`,
        title: `Horarios DIRECT GPS · ${expCtx.linea?.descripcion || ''}`.trim()
      });
      if (shared) {
        haptic('light');
        showToast('Compartiendo imagen desde Android...', 'success', 2200);
        return;
      }
    }
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

  // ── 7A. Modo Simple (Interfaz accesible para baja visión y personas mayores) ──
  const chkSimpleMode = document.getElementById('chk-simple-mode');
  const simpleModeBar = document.getElementById('simple-mode-bar');
  const btnSimpleExit = document.getElementById('btn-simple-mode-exit');
  const btnSimpleTts = document.getElementById('btn-simple-tts');

  function syncSimpleModeUi() {
    document.documentElement.dataset.simpleMode = simpleModeEnabled ? 'true' : 'false';
    document.body.classList.toggle('simple-mode', simpleModeEnabled);
    if (chkSimpleMode) chkSimpleMode.checked = simpleModeEnabled;
    if (simpleModeBar) simpleModeBar.classList.toggle('hidden', !simpleModeEnabled);
    if (btnSimpleTts) {
      const ttsOn = Boolean(alertPrefs.tts);
      btnSimpleTts.textContent = ttsOn ? '🔊 Voz: ACTIVADA' : '🔇 Voz: DESACTIVADA';
      btnSimpleTts.classList.toggle('active', ttsOn);
      btnSimpleTts.setAttribute('aria-pressed', String(ttsOn));
    }
  }

  function setSimpleMode(enabled, { silent = false } = {}) {
    simpleModeEnabled = Boolean(enabled);
    try {
      localStorage.setItem(STORAGE_SIMPLE_MODE_KEY, String(simpleModeEnabled));
    } catch {
      // ignore
    }
    syncSimpleModeUi();
    requestAnimationFrame(() => transitMap?.invalidateSize?.());
    if (!silent) {
      haptic('medium');
      const msg = simpleModeEnabled
        ? 'Modo Simple activado: letras grandes y botones claros'
        : 'Modo completo restaurado';
      showToast(msg, 'success', 2800);
      announce?.(msg);
      if (simpleModeEnabled && alertPrefs.tts) {
        speakIfEnabled('Modo simple activado.');
      }
    }
  }

  function isSimpleModeEnabled() {
    return Boolean(simpleModeEnabled);
  }

  btnSimpleExit?.addEventListener('click', () => setSimpleMode(false));
  chkSimpleMode?.addEventListener('change', (e) => setSimpleMode(Boolean(e.target.checked)));
  btnSimpleTts?.addEventListener('click', () => {
    const next = !alertPrefs.tts;
    alertPrefs.tts = next;
    saveAlertPrefs();
    liveTracker.syncPrefs({ ttsEnabled: next });
    const ttsChk = document.getElementById('chk-tts-alerts');
    if (ttsChk) ttsChk.checked = next;
    syncSimpleModeUi();
    haptic('light');
    if (next) {
      const msg = 'Avisos por voz activados.';
      showToast(msg, 'success', 2400);
      if (isNative) speakViaNativeAndroid(msg);
      else if (isSpeechSupported()) speakText(msg);
    } else {
      showToast('Avisos por voz desactivados', 'info', 2200);
    }
  });

  // ── 7B. Permisos al abrir la app (pide todos los permisos pendientes del teléfono) ──
  const permsModal = document.getElementById('permissions-modal');
  const permsListEl = document.getElementById('permissions-list');
  const btnPermsClose = document.getElementById('btn-perms-close');
  const btnPermsLater = document.getElementById('btn-perms-later');
  const btnPermsGrantAll = document.getElementById('btn-perms-grant-all');

  function getMissingPermItems(status) {
    const items = [];
    if (status?.notifications !== 'unsupported') {
      items.push({
        id: 'notifications',
        icon: '🔔',
        title: 'Notificaciones y alertas en vivo',
        desc: 'Muestra la barra estilo Uber y avisa la llegada de tus colectivos',
        granted: status?.notifications === 'granted'
      });
    }
    items.push({
      id: 'location',
      icon: '📍',
      title: 'Ubicación GPS',
      desc: 'Encuentra tus paradas cercanas y anuncia cada parada en Modo A Bordo',
      granted: status?.location === 'granted'
    });
    if (isNative) {
      items.push({
        id: 'backgroundLocation',
        icon: '🧭',
        title: 'GPS en segundo plano ("Todo el tiempo")',
        desc: 'Permite que Modo A Bordo siga leyendo paradas con la pantalla apagada',
        granted: status?.backgroundLocation === 'granted'
      });
      items.push({
        id: 'batteryOptimization',
        icon: '🔋',
        title: 'Segundo plano sin restricciones',
        desc: 'Evita que Android suspenda la app o apague las campanitas al minimizar',
        granted: status?.batteryOptimization === 'granted'
      });
    }
    return items;
  }

  async function renderPermissionsModal() {
    if (!permsListEl) return null;
    const status = await getDetailedPermissionsStatus();
    const items = getMissingPermItems(status);
    const pendingCount = items.filter((it) => !it.granted).length;

    permsListEl.innerHTML = items
      .map(
        (it) => `
        <div class="perm-row ${it.granted ? 'is-granted' : 'is-pending'}">
          <span class="perm-icon" aria-hidden="true">${it.icon}</span>
          <div class="perm-copy">
            <strong>${esc(it.title)}</strong>
            <span>${esc(it.desc)}</span>
          </div>
          ${
            it.granted
              ? `<span class="perm-badge-ok">✓ Activo</span>`
              : `<button type="button" class="primary-action-btn seg-btn-xs perm-grant-btn" data-perm-action="${esc(it.id)}">Permitir</button>`
          }
        </div>
      `
      )
      .join('');

    if (btnPermsGrantAll) {
      btnPermsGrantAll.classList.toggle('hidden', pendingCount === 0);
      btnPermsGrantAll.textContent =
        pendingCount === 1 ? '✓ Conceder permiso pendiente' : `✓ Conceder ${pendingCount} pendientes`;
    }
    if (btnPermsLater) {
      btnPermsLater.textContent = pendingCount === 0 ? 'Listo' : 'Más tarde';
    }
    syncNotifPermissionButtons();
    return { status, items, pendingCount };
  }

  async function openPermissionsModal() {
    if (!permsModal) return;
    await renderPermissionsModal();
    permsModal.classList.remove('hidden');
  }

  function closePermissionsModal({ dismiss = false } = {}) {
    permsModal?.classList.add('hidden');
    if (dismiss) {
      try {
        sessionStorage.setItem(STORAGE_PERMS_DISMISSED_KEY, '1');
      } catch {
        // ignore
      }
    }
  }

  async function handleSinglePermissionGrant(permId) {
    haptic('light');
    if (permId === 'notifications') {
      const ok = await ensureNotificationPermission();
      if (!ok && isNative) {
        await openNativeAppSettings();
        showToast('Activá "Notificaciones" en los ajustes de DIRECT GPS y volvé a la app.', 'info', 4200);
      }
    } else if (permId === 'location') {
      if (isNative) {
        const res = await requestStartupPermissions();
        if (res?.location !== 'granted') {
          await openNativeAppSettings();
          showToast('Activá "Ubicación" en los ajustes de DIRECT GPS y volvé a la app.', 'info', 4200);
        }
      } else if (navigator.geolocation) {
        await new Promise((resolve) =>
          navigator.geolocation.getCurrentPosition(() => resolve(), () => resolve(), { timeout: 8000 })
        );
      }
    } else if (permId === 'backgroundLocation') {
      const res = await requestBackgroundLocationPermission();
      if (res?.backgroundLocation !== 'granted') {
        await openNativeAppSettings();
        showToast('En Ubicación elegí "Permitir todo el tiempo" para que Modo A Bordo funcione con pantalla apagada.', 'info', 4800);
      }
    } else if (permId === 'batteryOptimization') {
      await openAndroidBatterySettings();
      showToast('Elegí "Permitir" / "Sin restricciones" para que nunca se suspenda en segundo plano.', 'info', 4200);
    }
    const info = await renderPermissionsModal();
    if (info && info.pendingCount === 0) {
      showToast('¡Todos los permisos concedidos!', 'success', 2800);
      setTimeout(() => closePermissionsModal(), 700);
    }
  }

  permsListEl?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-perm-action]');
    if (!btn) return;
    handleSinglePermissionGrant(btn.dataset.permAction);
  });

  btnPermsGrantAll?.addEventListener('click', async () => {
    const status = await getDetailedPermissionsStatus();
    if (status.notifications !== 'granted' || status.location !== 'granted') {
      if (isNative) {
        await requestStartupPermissions();
      } else {
        if (status.notifications !== 'granted') await ensureNotificationPermission();
        if (status.location !== 'granted' && navigator.geolocation) {
          await new Promise((resolve) =>
            navigator.geolocation.getCurrentPosition(() => resolve(), () => resolve(), { timeout: 8000 })
          );
        }
      }
    }
    const after = await renderPermissionsModal();
    if (isNative && after?.status) {
      if (after.status.location === 'granted' && after.status.backgroundLocation !== 'granted') {
        await handleSinglePermissionGrant('backgroundLocation');
        return;
      }
      if (after.status.batteryOptimization !== 'granted') {
        await handleSinglePermissionGrant('batteryOptimization');
        return;
      }
    }
    if (after && after.pendingCount === 0) {
      showToast('¡Todos los permisos concedidos!', 'success', 2800);
      closePermissionsModal();
    }
  });

  btnPermsClose?.addEventListener('click', () => closePermissionsModal({ dismiss: true }));
  btnPermsLater?.addEventListener('click', () => closePermissionsModal({ dismiss: true }));
  permsModal?.addEventListener('click', (e) => {
    if (e.target === permsModal) closePermissionsModal({ dismiss: true });
  });

  async function refreshPermissionsModalIfOpen() {
    if (permsModal && !permsModal.classList.contains('hidden')) {
      const info = await renderPermissionsModal();
      if (info && info.pendingCount === 0) {
        showToast('¡Todos los permisos quedaron activos!', 'success', 2600);
        setTimeout(() => closePermissionsModal(), 500);
      }
    } else {
      const status = await getDetailedPermissionsStatus();
      if (status) syncNotifPermissionButtons();
    }
  }

  async function checkAndPromptMissingPermissions({ onStartup = true } = {}) {
    if (typeof window === 'undefined') return;
    if (onStartup) {
      try {
        if (sessionStorage.getItem(STORAGE_PERMS_DISMISSED_KEY) === '1') return;
      } catch {
        // ignore
      }
    }

    const status = await getDetailedPermissionsStatus();
    if (isNative) {
      // En Android APK pedir automáticamente los permisos del sistema que todavía no fueron concedidos
      if (status.notifications !== 'granted' || status.location !== 'granted') {
        await requestStartupPermissions();
      }
      const after = await getDetailedPermissionsStatus();
      const missing = getMissingPermItems(after).filter((it) => !it.granted);
      if (missing.length > 0) {
        await openPermissionsModal();
      }
      return;
    }

    // En Web/PWA: mostrar el asistente amigable una sola vez si falta notificaciones o ubicación
    if (!onStartup) {
      await openPermissionsModal();
      return;
    }
    const missingWeb = getMissingPermItems(status).filter((it) => !it.granted);
    if (missingWeb.length > 0) {
      let seenWeb = false;
      try {
        seenWeb = localStorage.getItem('directgps_web_perms_seen_v1') === '1';
      } catch {
        // ignore
      }
      if (!seenWeb) {
        try {
          localStorage.setItem('directgps_web_perms_seen_v1', '1');
        } catch {
          // ignore
        }
        await openPermissionsModal();
      }
    }
  }

  function syncSoundPref(enabled) {
    liveTracker.syncPrefs({ soundEnabled: Boolean(enabled) });
  }

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

    // Alert lead-time pills, minute-by-minute, TTS, native phone ringtone & Android notifications
    const ringtoneTitleEl = document.getElementById('ringtone-current-title');
    if (isNative && ringtoneTitleEl) {
      getNotificationRingtone().then((r) => {
        if (r?.title) ringtoneTitleEl.textContent = r.title;
      });
    }

    document.getElementById('btn-pick-ringtone')?.addEventListener('click', async () => {
      if (!isNative) return;
      haptic('light');
      const res = await pickNotificationRingtone();
      if (res && !res.canceled) {
        if (ringtoneTitleEl) ringtoneTitleEl.textContent = res.title || 'Timbre elegido';
        haptic('medium');
        showToast(`Timbre actualizado: ${res.title || 'Timbre elegido'}`, 'success', 3000);
      }
    });

    document.getElementById('btn-reset-ringtone')?.addEventListener('click', async () => {
      if (!isNative) return;
      haptic('light');
      const res = await resetNotificationRingtone();
      if (ringtoneTitleEl) ringtoneTitleEl.textContent = res?.title || 'Timbre predeterminado del teléfono';
      showToast('Timbre restablecido al predeterminado del teléfono', 'info', 2600);
    });

    const syncAlertUi = () => {
      document.querySelectorAll('[data-alert-lead]').forEach((b) => {
        const active = Number(b.dataset.alertLead) === alertPrefs.leadMin;
        b.classList.toggle('active', active);
        b.setAttribute('aria-pressed', String(active));
      });
      document.querySelectorAll('[data-tts-rate]').forEach((b) => {
        const active = Math.abs(Number(b.dataset.ttsRate) - (alertPrefs.ttsRate || 1.02)) < 0.02;
        b.classList.toggle('active', active);
        b.setAttribute('aria-pressed', String(active));
      });
      const minChk = document.getElementById('chk-minute-alerts');
      if (minChk) minChk.checked = Boolean(alertPrefs.minuteByMinute);
      const ttsChk = document.getElementById('chk-tts-alerts');
      if (ttsChk) ttsChk.checked = Boolean(alertPrefs.tts);
      const dndChk = document.getElementById('chk-tts-dnd');
      if (dndChk) dndChk.checked = alertPrefs.ttsSpeakInDnd !== false;
      syncNotifPermissionButtons();
    };
    syncAlertUi();

    document.querySelectorAll('[data-alert-lead]').forEach((btn) => {
      btn.addEventListener('click', () => {
        alertPrefs.leadMin = Number(btn.dataset.alertLead) || 3;
        saveAlertPrefs();
        liveTracker.syncPrefs({ leadMin: alertPrefs.leadMin });
        syncAlertUi();
        haptic('light');
        showToast(`Las alertas avisarán cuando falten ≤ ${alertPrefs.leadMin} min`, 'success', 2400);
      });
    });

    document.querySelectorAll('[data-tts-rate]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const r = Number(btn.dataset.ttsRate);
        alertPrefs.ttsRate = [0.85, 1.02, 1.2].find((v) => Math.abs(v - r) < 0.02) || 1.02;
        saveAlertPrefs();
        liveTracker.syncPrefs({ ttsSpeechRate: alertPrefs.ttsRate });
        syncAlertUi();
        haptic('light');
        const lbl = alertPrefs.ttsRate < 0.95 ? 'Pausada' : alertPrefs.ttsRate > 1.1 ? 'Ágil' : 'Natural';
        showToast(`Velocidad de voz: ${lbl}`, 'success', 2200);
      });
    });

    document.getElementById('chk-tts-dnd')?.addEventListener('change', (e) => {
      alertPrefs.ttsSpeakInDnd = Boolean(e.target.checked);
      saveAlertPrefs();
      liveTracker.syncPrefs({ ttsSpeakInDnd: alertPrefs.ttsSpeakInDnd });
      haptic('light');
      showToast(
        alertPrefs.ttsSpeakInDnd
          ? 'La voz hablará incluso en No molestar o vibración'
          : 'La voz respetará el modo No molestar del teléfono',
        'info',
        2800
      );
    });

    document.getElementById('chk-minute-alerts')?.addEventListener('change', async (e) => {
      alertPrefs.minuteByMinute = Boolean(e.target.checked);
      saveAlertPrefs();
      liveTracker.syncPrefs({ minuteByMinute: alertPrefs.minuteByMinute });
      if (alertPrefs.minuteByMinute) {
        await ensureNotificationPermission();
        syncNotifPermissionButtons();
        showToast('Avisos minuto a minuto activados (suena y habla cada minuto que baja)', 'success', 3000);
      } else {
        showToast('Avisos minuto a minuto desactivados', 'info', 2200);
      }
    });

    document.getElementById('chk-tts-alerts')?.addEventListener('change', (e) => {
      alertPrefs.tts = Boolean(e.target.checked);
      saveAlertPrefs();
      liveTracker.syncPrefs({ ttsEnabled: alertPrefs.tts });
      syncSimpleModeUi();
      if (alertPrefs.tts) {
        if (isNative) {
          speakViaNativeAndroid('Avisos por voz activados en Direct G P S.');
        } else if (isSpeechSupported()) {
          speakText('Avisos por voz activados en Direct G P S.', { rate: alertPrefs.ttsRate });
        } else {
          showToast('Tu navegador no soporta síntesis de voz.', 'warn', 3000);
        }
      }
    });

    document.getElementById('btn-review-permissions')?.addEventListener('click', () => {
      openPermissionsModal();
    });

    document.getElementById('btn-enable-android-notifs')?.addEventListener('click', async () => {
      const wasGranted = getNotificationPermissionState() === 'granted';
      const ok = await ensureNotificationPermission();
      syncNotifPermissionButtons();
      if (ok) {
        if (isNative && wasGranted) {
          await openAndroidBatterySettings();
          showToast('Permití segundo plano sin restricciones para que funcione incluso cerrada', 'info', 4000);
        } else {
          showToast('Notificaciones Android activadas con el timbre de tu celular', 'success', 3000);
        }
      } else {
        showToast('Habilitá las notificaciones para DIRECT GPS desde los ajustes de Android.', 'warn', 4200);
      }
    });

    document.getElementById('btn-test-tts')?.addEventListener('click', async () => {
      const demoMsg =
        'Línea ciento seis B, coche veintinueve setenta y seis, a tres minutos. Arribando, Avenida Pedro Ferré y Brasil.';
      const res = await sendNativeNotification({
        title: '🔔 Prueba DIRECT GPS · 106B #2976',
        body: '━━━━━━🚌────◉ Av. Pedro Ferré y Brasil\nChofer: PRUEBA · Coche #2976 · Prog. real: 14:30',
        tag: 'direct-gps-test-alert',
        speechText: demoMsg,
        speakAfterChime: true
      });
      if (!res?.delivered) playArrivalChime();
      if (!res?.handledSpeechNatively) {
        if (!isSpeechSupported()) {
          showToast('Tu navegador no soporta síntesis de voz.', 'warn', 3000);
          return;
        }
        // Reproducir voz DESPUÉS del timbre de notificación
        speakAfterNotification(demoMsg, { delayMs: 950, rate: alertPrefs.ttsRate });
      }
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
        simpleMode: simpleModeEnabled,
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
        if (typeof parsed.simpleMode === 'boolean') setSimpleMode(parsed.simpleMode, { silent: true });
        if (parsed.alertPrefs) {
          const rateRaw = Number(parsed.alertPrefs.ttsRate);
          const validRate = [0.85, 1.02, 1.2].find((r) => Math.abs(r - rateRaw) < 0.02);
          alertPrefs = {
            leadMin: [3, 5, 8, 10].includes(Number(parsed.alertPrefs.leadMin)) ? Number(parsed.alertPrefs.leadMin) : 3,
            tts: Boolean(parsed.alertPrefs.tts),
            minuteByMinute: Boolean(parsed.alertPrefs.minuteByMinute),
            ttsRate: validRate || 1.02,
            ttsSpeakInDnd: parsed.alertPrefs.ttsSpeakInDnd !== false
          };
          saveAlertPrefs();
          liveTracker.syncPrefs({
            leadMin: alertPrefs.leadMin,
            ttsEnabled: alertPrefs.tts,
            minuteByMinute: alertPrefs.minuteByMinute,
            ttsSpeechRate: alertPrefs.ttsRate,
            ttsSpeakInDnd: alertPrefs.ttsSpeakInDnd
          });
          syncAlertUi();
          syncSimpleModeUi();
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
    diagEl.innerHTML = `<div class="diag-row"><span>Consultando estado...</span></div>`;
    const [health, nativeStatus] = await Promise.all([
      api.health().catch(() => null),
      isNative ? getNativeAndroidStatus().catch(() => null) : Promise.resolve(null)
    ]);
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
    let nativeRows = '';
    if (nativeStatus) {
      const watchCount = Number(nativeStatus.activeWatchCount) || 0;
      const svcTxt = nativeStatus.serviceRunning
        ? `Activo${watchCount > 0 ? ` · ${watchCount} alerta${watchCount === 1 ? '' : 's'}` : ''}`
        : 'En espera';
      nativeRows = `
        <div class="diag-row"><span>App Android</span><strong class="mono">v${esc(nativeStatus.versionName || '3.0.0')} · Android ${esc(nativeStatus.androidRelease || '?')}</strong></div>
        <div class="diag-row"><span>Dispositivo</span><strong>${esc(nativeStatus.deviceModel || 'Android')}</strong></div>
        <div class="diag-row"><span>Servicio 2° plano</span><strong>${esc(svcTxt)}</strong></div>
        <div class="diag-row"><span>Timbre elegido</span><strong>${esc(nativeStatus.ringtoneTitle || 'Predeterminado')}</strong></div>
        <div class="diag-row"><span>Batería 2° plano</span><strong>${nativeStatus.batteryUnrestricted ? '✓ Sin restricciones' : '⚠ Optimizada'}</strong></div>
      `;
    }
    diagEl.innerHTML = `
      ${nativeRows}
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

  // Initialize controls on creation and sync persisted TTS/alert prefs to native Android service
  wireSettingsModalTabs();
  liveTracker.syncPrefs({
    leadMin: alertPrefs.leadMin,
    ttsEnabled: alertPrefs.tts,
    minuteByMinute: alertPrefs.minuteByMinute,
    soundEnabled: state.soundEnabled,
    ttsSpeechRate: alertPrefs.ttsRate,
    ttsSpeakInDnd: alertPrefs.ttsSpeakInDnd
  });
  applyMapStyle(mapStylePref, { silent: true });
  syncSimpleModeUi();

  return {
    applyMapStyle,
    syncAutoMapStyle: () => {
      if (mapStylePref === 'auto') applyMapStyle('auto', { silent: true });
    },
    getAlertLeadMinutes,
    isTtsEnabled,
    isMinuteByMinuteEnabled,
    speakIfEnabled,
    syncSoundPref,
    setSimpleMode,
    isSimpleModeEnabled,
    openPermissionsModal,
    closePermissionsModal,
    refreshPermissionsModalIfOpen,
    checkAndPromptMissingPermissions,
    toggleCarAlert,
    isCarAlertArmed,
    checkCarAlerts,
    clearTriggeredCarAlerts,
    getFavEntities,
    isEntityFavorite,
    toggleEntityFavorite,
    startLiveLineTrack,
    updateLiveTripFromArrivals,
    updateLiveTripFromBus,
    requestBoardBus,
    alightFromBus,
    stopLiveTrip,
    getLiveTripSnapshot: () => liveTracker.getSnapshot(),
    isLiveTripOnboard: () => liveTracker.isOnboard(),
    hasActiveTrackingSession,
    openEntityProfileModal,
    closeProfileModal,
    openScheduleExportModal,
    closeScheduleExportModal,
    shareServiceSummary
  };
}
