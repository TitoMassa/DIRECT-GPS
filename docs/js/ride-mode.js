import { distanceMeters, formatDistance, formatBlocks, getApiBase } from './api.js';
import { playArrivalChime } from './audio.js';
import { projectOnPolyline } from './trajectory.js';
import {
  getDirectGpsNativePlugin,
  haptic,
  notifyArrival,
  showSystemNotification,
  closeSystemNotification,
  setKeepAwake,
  startBackgroundKeepAlive,
  updateBackgroundSessionMetadata,
  stopBackgroundKeepAlive
} from './native.js';
import {
  isSpeechSupported,
  speakText,
  speakAfterNotification,
  cancelPendingSpeech,
  formatCocheForTts,
  formatLineaForTts,
  formatStopNameForTts,
  formatDriverForTts
} from './tts.js';

export {
  isSpeechSupported,
  speakText,
  speakAfterNotification,
  cancelPendingSpeech,
  formatCocheForTts,
  formatLineaForTts,
  formatStopNameForTts,
  formatDriverForTts
};

export const LIVE_TRACK_NOTIFICATION_TAG = 'direct-gps-live-track';
const STORAGE_LIVE_TRIP_KEY = 'directgps_live_trip_session_v1';

/**
 * Construye una barra horizontal recta estilo Uber donde el colectivo avanza
 * estrictamente de izquierda (0.0) a derecha (1.0) hacia el punto de llegada.
 */
export function buildUberProgressLine(
  progress01 = 0,
  { segments = 12, busGlyph = '🚌', endGlyph = '◉', filledChar = '━', emptyChar = '─' } = {}
) {
  const p = Math.max(0, Math.min(1, Number.isFinite(Number(progress01)) ? Number(progress01) : 0));
  const segs = Math.max(6, Math.min(20, Math.round(segments)));
  const pos = Math.round(p * segs);
  const left = filledChar.repeat(pos);
  const right = emptyChar.repeat(Math.max(0, segs - pos));
  return `${left}${busGlyph}${right}${endGlyph}`;
}

/**
 * Devuelve ÚNICAMENTE la hora programada REAL del diagrama oficial (nunca estimada).
 */
export function resolveRealScheduledHHMM(bus) {
  if (!bus) return '';
  const raw = String(bus.turnoProgramado || '').trim();
  if (/^\d{1,2}:\d{2}/.test(raw)) return raw.slice(0, 5);
  return '';
}

function shortStopLabel(name, maxLen = 24) {
  const clean = formatStopNameForTts(name);
  if (clean.length <= maxLen) return clean;
  return `${clean.slice(0, maxLen - 1).trim()}…`;
}

/**
 * Deduplica y ordena las paradas de un ramal a lo largo de su polilínea (`along` ascendente).
 */
export function normalizeOrderedStopsForRide(branch) {
  if (!branch || !Array.isArray(branch.orderedStops)) return [];
  const out = [];
  const seen = new Set();
  for (const st of branch.orderedStops) {
    const id = String(st?.id || '').trim().toUpperCase();
    const lat = Number(st?.lat);
    const lng = Number(st?.lng);
    if (!id || seen.has(id) || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    seen.add(id);
    let along = Number(st.along);
    if (!Number.isFinite(along) && Array.isArray(branch.pts) && branch.pts.length >= 2) {
      const proj = projectOnPolyline(branch.pts, branch.cum, lat, lng);
      along = proj ? proj.along : 0;
    }
    out.push({
      id,
      nombre: st.nombre || st.descripcion || id,
      cleanName: formatStopNameForTts(st.nombre || st.descripcion || id),
      lat,
      lng,
      along: Number.isFinite(along) ? along : 0
    });
  }
  out.sort((a, b) => a.along - b.along);
  return out;
}

/**
 * Construye el texto hablado natural en español para un aviso de arribo de colectivo.
 */
export function buildArrivalSpeechMessage({ lineName = '', coche = '', etaMin = null, stopName = '' } = {}) {
  const linePart = lineName ? `Línea ${formatLineaForTts(lineName)}` : 'Colectivo';
  const cochePart = coche ? `, coche ${formatCocheForTts(coche)}` : '';
  let etaPart = '';
  if (etaMin === 0) etaPart = ', arribando ahora';
  else if (etaMin === 1) etaPart = ', a un minuto';
  else if (Number.isFinite(Number(etaMin)) && Number(etaMin) > 1) {
    etaPart = `, a ${Math.round(Number(etaMin))} minutos`;
  }
  const stopPart = stopName ? ` en ${formatStopNameForTts(stopName)}` : '';
  return `${linePart}${cochePart}${etaPart}${stopPart}.`;
}

/**
 * Construye el payload completo para la notificación estilo Uber en la barra de estado Android.
 * Incluye siempre: barra horizontal recta izquierda->derecha, chofer, coche, minutos de arribo
 * y hora programada REAL (nunca estimada).
 */
export function buildUberNotificationPayload(snap) {
  if (!snap || snap.phase === 'idle') return null;

  const lineName = snap.lineName || 'Línea';
  const cocheTxt = snap.coche ? `#${snap.coche}` : 's/d';
  const driverTxt = snap.choferNombre || 'Chofer s/d';
  const schedTxt = snap.scheduledHHMM || 's/d';
  const progressBar = buildUberProgressLine(snap.progress01 ?? 0, { segments: 12 });

  if (snap.phase === 'onboard') {
    const nextStopClean = snap.nextStop?.cleanName || 'Fin del recorrido';
    const nextStopShort = shortStopLabel(nextStopClean, 22);
    const distPart =
      Number.isFinite(snap.distToNextM) && snap.distToNextM !== null
        ? ` · ${formatDistance(snap.distToNextM)}`
        : '';
    const remCount = Math.max(0, Number(snap.remainingStops) || 0);
    const title = snap.arrivingNow
      ? `🔔 ARRIBANDO · ${nextStopClean}`
      : `🚌 A bordo ${lineName}${snap.coche ? ` #${snap.coche}` : ''} → ${nextStopShort}`;

    // La línea recta de progreso es exclusiva de arribos; A Bordo muestra un resumen limpio de próxima parada
    const lines = [
      `Próxima parada: ${nextStopClean}${distPart}`,
      `Chofer: ${driverTxt} · Coche ${cocheTxt} · Prog. real: ${schedTxt}`,
      remCount > 0
        ? `${remCount} ${remCount === 1 ? 'parada restante' : 'paradas restantes'}${snap.finalStopName ? ` · Fin: ${shortStopLabel(snap.finalStopName, 18)}` : ''}`
        : 'Llegando a cabecera final'
    ];

    return {
      title,
      body: lines.join('\n'),
      tag: LIVE_TRACK_NOTIFICATION_TAG,
      actions: [{ action: 'alight', title: '🚪 Bajar' }],
      data: {
        phase: 'onboard',
        stopId: snap.originStop?.id || '',
        lineName,
        coche: snap.coche || ''
      }
    };
  }

  // Waiting or Boarding-Armed phase
  const stopShort = shortStopLabel(snap.originStop?.nombre || snap.originStop?.id || 'Tu parada', 20);
  const hasEta = Number.isFinite(snap.etaMin) && snap.etaMin !== null;
  const etaCompact = !hasEta ? 'En camino' : snap.etaMin <= 0 ? 'ARRIBANDO' : `${snap.etaMin} min`;
  const title =
    hasEta && snap.etaMin <= 0
      ? `🔔 ${lineName} ARRIBANDO · Coche ${cocheTxt}`
      : `🚌 ${lineName} · ${etaCompact} · Coche ${cocheTxt}`;

  const distLine =
    Number.isFinite(snap.distM) && snap.distM > 0
      ? `A ${formatDistance(snap.distM)} (${formatBlocks(snap.distM)} c.)`
      : 'Acercándose a tu parada';

  const statusLine =
    snap.phase === 'boarding_armed'
      ? `✅ Subir listo · activa modo viaje al llegar${snap.minuteByMinute ? ' · Min a min' : ''}`
      : `${distLine}${snap.minuteByMinute ? ' · Aviso min a min' : ''}`;

  const lines = [
    `${progressBar} ${stopShort}`,
    `Chofer: ${driverTxt} · Coche ${cocheTxt}`,
    `Arribo: ${etaCompact} · Prog. real: ${schedTxt}`,
    statusLine
  ];

  const actions =
    snap.phase === 'boarding_armed'
      ? [
          { action: 'board-now', title: '🚌 Ya subí' },
          { action: 'stop-track', title: '✕ Detener' }
        ]
      : [
          { action: 'board', title: '🚌 Subir' },
          { action: 'stop-track', title: '✕ Detener' }
        ];

  return {
    title,
    body: lines.join('\n'),
    tag: LIVE_TRACK_NOTIFICATION_TAG,
    actions,
    data: {
      phase: snap.phase,
      stopId: snap.originStop?.id || '',
      lineName,
      coche: snap.coche || ''
    }
  };
}

/**
 * Controlador completo de Viaje en Vivo estilo Uber:
 *  - Fase `waiting`: sigue la línea/coche seleccionado en barra de estado Android + alerta minuto a minuto
 *  - Fase `boarding_armed`: usuario tocó "Subir"; al llegar el colectivo pasa automáticamente a `onboard`
 *  - Fase `onboard`: modo accesible para no videntes; avisa cada próxima parada con timbre nativo + TTS
 *    ("Arribando, <parada>") usando GPS del celular (con respaldo GPS del colectivo) hasta tocar "Bajar".
 */
export class LiveTripTracker {
  constructor({ onUpdate, onToast, onAnnounce, onStopArrival } = {}) {
    this.onUpdate = onUpdate || (() => {});
    this.onToast = onToast || (() => {});
    this.onAnnounce = onAnnounce || (() => {});
    this.onStopArrival = onStopArrival || (() => {});

    this.phase = 'idle'; // 'idle' | 'waiting' | 'boarding_armed' | 'onboard'
    this.lineName = '';
    this.codLinea = 0;
    this.coche = '';
    this.choferNombre = '';
    this.choferLegajo = '';
    this.bandera = '';
    this.scheduledHHMM = '';
    this.originStop = null;
    this.branch = null;
    this.orderedStops = [];

    // Waiting metrics
    this.initialDistM = 2500;
    this.distM = null;
    this.etaMin = null;
    this.lastSpokenEtaMin = null;
    this.wasCloseToStop = false;
    this.progress01 = 0.05;

    // Onboard metrics
    this.watchId = null;
    this.lastPhoneGpsMs = 0;
    this.currentAlong = 0;
    this.prevStopAlong = 0;
    this.nextStopIdx = 0;
    this.distToNextM = null;
    this.arrivingNow = false;
    this.announcedStopIds = new Set();
    this.gpsErrorNotified = false;

    // User prefs synced from ui-extras
    this.minuteByMinute = false;
    this.ttsEnabled = false;
    this.soundEnabled = true;
    this.leadMin = 3;
    this.lastNotifPushMs = 0;

    // Native Android Foreground Service bridge (Capacitor APK)
    this._nativePlugin = getDirectGpsNativePlugin();
    this._nativeNextStop = null;
    this._nativeRemainingStops = 0;
    this._nativeFinalStopName = '';
    this._nativeUsingPhoneGps = false;

    if (this._nativePlugin) {
      try {
        this._nativePlugin.addListener?.('tripStateChanged', (nativeSnap) => {
          this._applyNativeSnapshot(nativeSnap);
        });
        this._nativePlugin
          .getTripState?.()
          .then((nativeSnap) => {
            if (nativeSnap && nativeSnap.phase && nativeSnap.phase !== 'idle') {
              this._applyNativeSnapshot(nativeSnap);
            }
          })
          .catch(() => {});
      } catch {
        // ignore plugin init errors
      }
    }
  }

  _serializeOrderedStops() {
    return (this.orderedStops || []).map((st) => ({
      id: st.id,
      nombre: st.nombre,
      lat: st.lat,
      lng: st.lng,
      along: st.along
    }));
  }

  _applyNativeSnapshot(s) {
    if (!s || !s.phase || s.phase === 'idle') {
      this.phase = 'idle';
      this.arrivingNow = false;
      this._nativeNextStop = null;
      this._nativeRemainingStops = 0;
      this._nativeFinalStopName = '';
      this._nativeUsingPhoneGps = false;
      this._persistSession();
      this._emitUpdate();
      return;
    }

    this.phase = String(s.phase);
    if (s.lineName) this.lineName = String(s.lineName);
    if (Number.isFinite(Number(s.codLinea)) && Number(s.codLinea) > 0) {
      this.codLinea = Number(s.codLinea);
    }
    this.coche = String(s.coche || '');
    this.choferNombre = String(s.choferNombre || '');
    this.choferLegajo = String(s.choferLegajo || '');
    this.bandera = String(s.bandera || '');
    this.scheduledHHMM = String(s.scheduledHHMM || '');
    if (s.stopId) {
      const prevLat = this.originStop?.id === s.stopId ? this.originStop.lat : NaN;
      const prevLng = this.originStop?.id === s.stopId ? this.originStop.lng : NaN;
      this.originStop = {
        id: String(s.stopId).toUpperCase(),
        nombre: String(s.stopName || s.stopId),
        lat: prevLat,
        lng: prevLng
      };
    }
    this.distM = typeof s.distM === 'number' && Number.isFinite(s.distM) ? s.distM : null;
    this.etaMin = typeof s.etaMin === 'number' && Number.isFinite(s.etaMin) ? s.etaMin : null;
    if (typeof s.progress01 === 'number' && Number.isFinite(s.progress01)) {
      this.progress01 = s.progress01;
    }
    if (typeof s.minuteByMinute === 'boolean') this.minuteByMinute = s.minuteByMinute;
    if (typeof s.ttsEnabled === 'boolean') this.ttsEnabled = s.ttsEnabled;
    this.arrivingNow = Boolean(s.arrivingNow);
    this._nativeNextStop = s.nextStop || null;
    this.distToNextM = typeof s.distToNextM === 'number' && Number.isFinite(s.distToNextM) ? s.distToNextM : null;
    this._nativeRemainingStops = Number.isFinite(Number(s.remainingStops)) ? Number(s.remainingStops) : 0;
    this._nativeFinalStopName = String(s.finalStopName || '');
    this._nativeUsingPhoneGps = Boolean(s.usingPhoneGps);

    this._persistSession();
    this._emitUpdate();
  }

  isActive() {
    return this.phase !== 'idle';
  }

  isOnboard() {
    return this.phase === 'onboard';
  }

  syncPrefs({ minuteByMinute, ttsEnabled, soundEnabled, leadMin, ttsSpeechRate, ttsSpeakInDnd } = {}) {
    if (typeof minuteByMinute === 'boolean') this.minuteByMinute = minuteByMinute;
    if (typeof ttsEnabled === 'boolean') this.ttsEnabled = ttsEnabled;
    if (typeof soundEnabled === 'boolean') this.soundEnabled = soundEnabled;
    if (Number.isFinite(Number(leadMin))) this.leadMin = Number(leadMin);
    if (Number.isFinite(Number(ttsSpeechRate))) this.ttsSpeechRate = Number(ttsSpeechRate);
    if (typeof ttsSpeakInDnd === 'boolean') this.ttsSpeakInDnd = ttsSpeakInDnd;
    if (this._nativePlugin) {
      const payload = {
        minuteByMinute: this.minuteByMinute,
        ttsEnabled: this.ttsEnabled,
        soundEnabled: this.soundEnabled,
        leadMin: this.leadMin
      };
      if (Number.isFinite(Number(this.ttsSpeechRate))) payload.ttsSpeechRate = Number(this.ttsSpeechRate);
      if (typeof this.ttsSpeakInDnd === 'boolean') payload.ttsSpeakInDnd = this.ttsSpeakInDnd;
      this._nativePlugin.syncPrefs?.(payload).catch(() => {});
    }
    if (this.isActive()) {
      this._emitUpdate();
    }
  }

  getSnapshot() {
    const useNativeOnboard = Boolean(this._nativePlugin && this.phase === 'onboard');
    const nextStop = useNativeOnboard
      ? this._nativeNextStop || this.orderedStops[this.nextStopIdx] || null
      : this.phase === 'onboard' && this.orderedStops[this.nextStopIdx]
        ? this.orderedStops[this.nextStopIdx]
        : null;
    const prevStop =
      this.phase === 'onboard' && this.nextStopIdx > 0
        ? this.orderedStops[this.nextStopIdx - 1]
        : null;
    const finalStop = this.orderedStops.length > 0 ? this.orderedStops[this.orderedStops.length - 1] : null;
    return {
      phase: this.phase,
      lineName: this.lineName,
      codLinea: this.codLinea,
      coche: this.coche,
      choferNombre: this.choferNombre,
      choferLegajo: this.choferLegajo,
      bandera: this.bandera,
      scheduledHHMM: this.scheduledHHMM,
      originStop: this.originStop,
      distM: this.distM,
      etaMin: this.etaMin,
      progress01: this.progress01,
      minuteByMinute: this.minuteByMinute,
      ttsEnabled: this.ttsEnabled,
      nextStop,
      prevStop,
      distToNextM: this.distToNextM,
      remainingStops:
        this.phase === 'onboard'
          ? useNativeOnboard
            ? this._nativeRemainingStops
            : Math.max(0, this.orderedStops.length - this.nextStopIdx)
          : 0,
      finalStopName: this._nativeFinalStopName || finalStop?.cleanName || '',
      arrivingNow: this.arrivingNow,
      usingPhoneGps: useNativeOnboard
        ? this._nativeUsingPhoneGps
        : this.phase === 'onboard' && Date.now() - this.lastPhoneGpsMs < 20000
    };
  }

  _emitUpdate() {
    this.onUpdate(this.phase === 'idle' ? null : this.getSnapshot());
  }

  _persistSession() {
    if (typeof localStorage === 'undefined') return;
    try {
      if (this.phase === 'idle') {
        localStorage.removeItem(STORAGE_LIVE_TRIP_KEY);
      } else {
        localStorage.setItem(
          STORAGE_LIVE_TRIP_KEY,
          JSON.stringify({
            phase: this.phase,
            lineName: this.lineName,
            codLinea: this.codLinea,
            coche: this.coche,
            choferNombre: this.choferNombre,
            bandera: this.bandera,
            scheduledHHMM: this.scheduledHHMM,
            originStop: this.originStop,
            minuteByMinute: this.minuteByMinute,
            savedAt: Date.now()
          })
        );
      }
    } catch {
      // ignore
    }
  }

  /**
   * Dispara la notificación nativa de Android (timbre del celular si `alertSound=true`)
   * y reproduce la voz TTS DESPUÉS del timbre si el usuario activó TTS.
   */
  async _dispatchNotification({ alertSound = false, speechText = '', force = false } = {}) {
    const snap = this.getSnapshot();
    const payload = buildUberNotificationPayload(snap);
    if (!payload) return;

    const now = Date.now();
    // Evitar bombardear actualizaciones silenciosas más rápido que cada 4 s
    if (!alertSound && !force && now - this.lastNotifPushMs < 4000) return;
    this.lastNotifPushMs = now;

    // Mantener metadatos de MediaSession actualizados (bloqueo de pantalla / Android media controls)
    updateBackgroundSessionMetadata({
      title: payload.title,
      artist: `${this.choferNombre || 'DIRECT GPS'} · Coche #${this.coche || '—'}${
        this.scheduledHHMM ? ` · Prog. ${this.scheduledHHMM}` : ''
      }`,
      onStop: () => this.stop({ silent: true })
    });

    if (alertSound) {
      haptic('success');
    }

    if (speechText) {
      this.onAnnounce(speechText);
    }

    const res = await showSystemNotification({
      title: payload.title,
      body: payload.body,
      tag: payload.tag,
      silent: !alertSound,
      renotify: alertSound,
      requireInteraction: this.phase === 'onboard',
      vibrate: alertSound ? [160, 80, 160] : null,
      actions: payload.actions,
      data: payload.data
    });

    // Si la notificación nativa Android no entregó sonido (ej. permiso aún no otorgado en primer plano),
    // usar nuestra campanita Web Audio como respaldo antes de hablar.
    if (alertSound && !res.delivered && this.soundEnabled) {
      playArrivalChime();
    }

    if (speechText && this.ttsEnabled && isSpeechSupported()) {
      // Esperar ~950 ms para que termine el timbre nativo de Android antes de hablar
      speakAfterNotification(speechText, { delayMs: alertSound ? 950 : 0 });
    }
  }

  /**
   * Inicia el seguimiento en vivo estilo Uber de una línea o coche específico acercándose a una parada.
   */
  startWaiting({
    stop,
    lineName,
    codLinea = 0,
    bus = null,
    branch = null,
    lockCar = false,
    minuteByMinute = this.minuteByMinute,
    ttsEnabled = this.ttsEnabled,
    soundEnabled = this.soundEnabled
  } = {}) {
    if (!stop || !lineName) return false;
    this._stopPhoneGps();

    const sameTarget =
      (this.phase === 'waiting' || this.phase === 'boarding_armed') &&
      this.originStop?.id === stop.id &&
      this.lineName === lineName &&
      (!lockCar || !bus?.identificadorCoche || this.coche === String(bus.identificadorCoche));

    this.phase = sameTarget ? this.phase : 'waiting';
    this.originStop = {
      id: String(stop.id || '').toUpperCase(),
      nombre: stop.nombre || stop.id || 'Tu parada',
      lat: Number(stop.lat),
      lng: Number(stop.lng)
    };
    this.lineName = String(lineName);
    this.codLinea = Number(codLinea || bus?.codigoLinea) || 0;
    this.minuteByMinute = Boolean(minuteByMinute);
    this.ttsEnabled = Boolean(ttsEnabled);
    this.soundEnabled = Boolean(soundEnabled);
    this.lockCar = Boolean(lockCar && bus?.identificadorCoche);
    this.branch = branch || bus?._matchedBranch || bus?.trajectory?.branch || this.branch || null;
    this.orderedStops = this.branch ? normalizeOrderedStopsForRide(this.branch) : [];

    if (!sameTarget) {
      this.lastSpokenEtaMin = null;
      this.wasCloseToStop = false;
      this.initialDistM = 2600;
    }

    if (bus) {
      this._applyWaitingBusData(bus, { isInitial: !sameTarget });
    } else {
      this.coche = '';
      this.choferNombre = '';
      this.choferLegajo = '';
      this.scheduledHHMM = '';
      this.etaMin = null;
      this.distM = null;
      this.progress01 = 0.08;
    }

    if (this._nativePlugin) {
      this._nativePlugin
        .startWaiting?.({
          apiBase: getApiBase(),
          stopId: this.originStop.id,
          stopName: this.originStop.nombre,
          stopLat: Number.isFinite(this.originStop.lat) ? this.originStop.lat : 0,
          stopLng: Number.isFinite(this.originStop.lng) ? this.originStop.lng : 0,
          lineName: this.lineName,
          codLinea: this.codLinea,
          lockCar: this.lockCar,
          coche: this.coche,
          choferNombre: this.choferNombre,
          choferLegajo: this.choferLegajo,
          bandera: this.bandera,
          scheduledHHMM: this.scheduledHHMM,
          distM: this.distM !== null ? this.distM : -1,
          etaMin: this.etaMin !== null ? this.etaMin : -1,
          minuteByMinute: this.minuteByMinute,
          ttsEnabled: this.ttsEnabled,
          soundEnabled: this.soundEnabled,
          leadMin: this.leadMin,
          orderedStops: this._serializeOrderedStops()
        })
        .catch(() => {});
      this._persistSession();
      this._emitUpdate();
      return true;
    }

    setKeepAwake(true);
    startBackgroundKeepAlive({
      title: `DIRECT GPS · ${this.lineName}`,
      artist: this.originStop.nombre,
      onStop: () => this.stop({ silent: true })
    });
    this._persistSession();
    this._emitUpdate();
    this._dispatchNotification({ alertSound: false, force: true });
    return true;
  }

  _applyWaitingBusData(bus, { isInitial = false } = {}) {
    this.coche = String(bus.identificadorCoche || this.coche || '').trim();
    this.choferNombre = String(bus.choferNombre || this.choferNombre || '').trim();
    this.choferLegajo = String(bus.choferLegajo || this.choferLegajo || '').trim();
    this.bandera = String(bus.realBandera || bus.descripcionBandera || this.bandera || '').trim();
    const realSched = resolveRealScheduledHHMM(bus);
    if (realSched) this.scheduledHHMM = realSched;

    if (bus._matchedBranch || bus.trajectory?.branch) {
      this.branch = bus._matchedBranch || bus.trajectory?.branch;
      this.orderedStops = normalizeOrderedStopsForRide(this.branch);
    }

    const parsedEta =
      bus.eta && typeof bus.eta.minutes === 'number' && Number.isFinite(bus.eta.minutes)
        ? Math.max(0, Math.round(bus.eta.minutes))
        : this.etaMin;
    const rawDist = Number(bus.routeMeters ?? bus.distanceMeters);
    const distCoherent =
      Number.isFinite(rawDist) &&
      rawDist >= 0 &&
      (parsedEta === null || parsedEta < 5 || rawDist / (parsedEta * 60) >= 1.3);

    if (distCoherent) {
      this.distM = Math.round(rawDist);
      const etaRef = parsedEta > 0 ? Math.max(1200, parsedEta * 260) : 2600;
      if (isInitial || this.distM > this.initialDistM) {
        this.initialDistM = Math.max(1000, Math.min(25000, Math.max(this.distM * 1.12, etaRef)));
      }
    } else if (parsedEta !== null && parsedEta >= 5 && this.distM !== null && this.distM / (parsedEta * 60) < 1.3) {
      this.distM = null;
    }

    if (bus.eta && typeof bus.eta.minutes === 'number' && Number.isFinite(bus.eta.minutes)) {
      this.etaMin = Math.max(0, Math.round(bus.eta.minutes));
      if (this.etaMin <= 1 || (this.distM !== null && this.distM <= 250 && this.etaMin <= 3)) {
        this.wasCloseToStop = true;
      }
    }

    if (this.etaMin === 0) {
      this.progress01 = 1;
    } else {
      const rawRatio =
        this.distM !== null
          ? 1 - this.distM / Math.max(450, Math.max(this.initialDistM, this.distM * 1.08))
          : this.etaMin > 0
            ? 1 - this.etaMin / Math.max(18, this.etaMin * 1.25)
            : 0.08;
      const cap =
        this.etaMin >= 20 ? 0.42 : this.etaMin >= 12 ? 0.62 : this.etaMin >= 6 ? 0.8 : this.etaMin >= 2 ? 0.92 : 0.98;
      this.progress01 = Math.max(0.05, Math.min(cap, rawRatio));
    }
  }

  /**
   * Actualiza la barra Uber y dispara avisos minuto a minuto + auto-Subir desde cada poll de arribos.
   */
  updateFromArrivals(arribos = [], activeStop = null, routeBranchesCache = null) {
    if (this.phase !== 'waiting' && this.phase !== 'boarding_armed') return;
    if (activeStop && this.originStop && activeStop.id !== this.originStop.id) return;

    const list = Array.isArray(arribos) ? arribos : [];
    let bus = null;
    if (this.lockCar && this.coche) {
      bus =
        list.find(
          (b) =>
            !b.isNextLap &&
            String(b.identificadorCoche || '') === this.coche &&
            (this.codLinea ? Number(b.codigoLinea) === this.codLinea : b.descripcionLinea === this.lineName)
        ) || null;
    }
    if (!bus) {
      bus =
        list.find(
          (b) =>
            !b.isNextLap &&
            (b.descripcionLinea === this.lineName || (this.codLinea && Number(b.codigoLinea) === this.codLinea))
        ) || null;
    }

    // Si el usuario activó "Subir" y el colectivo que estaba a <=1 min desapareció porque ya pasó la parada:
    // activar automáticamente Modo A Bordo!
    if (!bus) {
      if (this.phase === 'boarding_armed' && this.wasCloseToStop) {
        if (this._nativePlugin) {
          this.requestBoard({ immediate: true, routeBranchesCache });
        } else {
          this.enterOnboardMode({ auto: true, routeBranchesCache });
        }
      }
      return;
    }

    const prevEta = this.etaMin;
    this._applyWaitingBusData(bus, { isInitial: false });

    if (this._nativePlugin) {
      this._nativePlugin
        .updateWaitingFromJs?.({
          coche: this.coche,
          choferNombre: this.choferNombre,
          scheduledHHMM: this.scheduledHHMM,
          distM: this.distM !== null ? this.distM : -1,
          etaMin: this.etaMin !== null ? this.etaMin : -1,
          minuteByMinute: this.minuteByMinute,
          ttsEnabled: this.ttsEnabled,
          soundEnabled: this.soundEnabled,
          leadMin: this.leadMin,
          orderedStops: this._serializeOrderedStops()
        })
        .catch(() => {});
      this._emitUpdate();
      return;
    }

    // Si estamos en "Subir activado" y el colectivo llegó a la parada -> pasar a Modo A Bordo automáticamente!
    if (
      this.phase === 'boarding_armed' &&
      ((this.etaMin !== null && this.etaMin <= 0) || (this.distM !== null && this.distM <= 95))
    ) {
      this.enterOnboardMode({ auto: true, bus, routeBranchesCache });
      return;
    }

    // Decidir si corresponde sonar el timbre + hablar minuto a minuto
    let shouldAlert = false;
    let speechText = '';
    if (this.minuteByMinute && this.etaMin !== null && this.etaMin <= 20) {
      const isNewLowerMinute =
        this.lastSpokenEtaMin === null
          ? this.etaMin <= Math.max(this.leadMin, 10)
          : this.etaMin < this.lastSpokenEtaMin;
      const reachedNow = this.etaMin === 0 && this.lastSpokenEtaMin !== 0;
      if (isNewLowerMinute || reachedNow) {
        this.lastSpokenEtaMin = this.etaMin;
        shouldAlert = true;
        speechText = buildArrivalSpeechMessage({
          lineName: this.lineName,
          coche: this.coche,
          etaMin: this.etaMin,
          stopName: this.etaMin === 0 ? this.originStop?.nombre || '' : ''
        });
      }
    } else if (prevEta !== 0 && this.etaMin === 0) {
      // Aunque minuto-a-minuto esté apagado, al llegar a 0 min avisar con timbre + voz
      shouldAlert = true;
      speechText = buildArrivalSpeechMessage({
        lineName: this.lineName,
        coche: this.coche,
        etaMin: 0,
        stopName: this.originStop?.nombre || ''
      });
    }

    this._emitUpdate();
    this._dispatchNotification({ alertSound: shouldAlert, speechText });
  }

  /**
   * Acción "Subir":
   *  - Si el colectivo ya está llegando (<= 1 min / <= 160 m) o el usuario ya había armado "Subir"
   *    (o se pidió inmediato), entra DIRECTAMENTE en Modo A Bordo (anunciando cada próxima parada).
   *  - Si el colectivo todavía está lejos, arma "Subir al llegar" y entra en A Bordo apenas arribe.
   */
  requestBoard({ immediate = false, bus = null, branch = null, routeBranchesCache = null } = {}) {
    if (bus) {
      this.lineName = bus.descripcionLinea || this.lineName || 'Línea';
      this.codLinea = Number(bus.codigoLinea) || this.codLinea;
      this.coche = String(bus.identificadorCoche || this.coche || '').trim();
      this.choferNombre = String(bus.choferNombre || this.choferNombre || '').trim();
      this.choferLegajo = String(bus.choferLegajo || this.choferLegajo || '').trim();
      this.bandera = String(bus.realBandera || bus.descripcionBandera || this.bandera || '').trim();
      const sched = resolveRealScheduledHHMM(bus);
      if (sched) this.scheduledHHMM = sched;
      if (branch || bus._matchedBranch || bus.trajectory?.branch) {
        this.branch = branch || bus._matchedBranch || bus.trajectory?.branch;
      }
    } else if (branch) {
      this.branch = branch;
    }

    if (!this.branch && routeBranchesCache && this.codLinea) {
      const branches = routeBranchesCache.get(Number(this.codLinea)) || [];
      if (branches.length > 0) {
        const normBand = String(this.bandera || '').toUpperCase();
        this.branch =
          branches.find((b) => normBand && String(b.bandera || '').toUpperCase().includes(normBand)) ||
          (this.originStop?.id
            ? branches.find((b) =>
                (b.orderedStops || []).some((s) => String(s.id || '').toUpperCase() === this.originStop.id)
              )
            : null) ||
          branches[0];
      }
    }
    if (this.branch) {
      this.orderedStops = normalizeOrderedStopsForRide(this.branch);
    }

    const arrivingSoon =
      immediate ||
      this.phase === 'idle' ||
      this.phase === 'boarding_armed' ||
      (this.etaMin !== null && this.etaMin <= 1) ||
      (this.distM !== null && this.distM <= 160);

    if (this._nativePlugin) {
      if (arrivingSoon && this.orderedStops.length === 0) {
        this.onToast('No se encontraron paradas del recorrido para activar Modo A Bordo.', 'warn', 3500);
        return false;
      }
      this._nativePlugin
        .requestBoard?.({
          immediate: Boolean(arrivingSoon),
          lineName: this.lineName,
          codLinea: this.codLinea,
          coche: this.coche,
          choferNombre: this.choferNombre,
          scheduledHHMM: this.scheduledHHMM,
          stopId: this.originStop?.id || '',
          stopName: this.originStop?.nombre || '',
          minuteByMinute: this.minuteByMinute,
          ttsEnabled: this.ttsEnabled,
          soundEnabled: this.soundEnabled,
          leadMin: this.leadMin,
          orderedStops: this._serializeOrderedStops()
        })
        .catch(() => {});
      if (arrivingSoon) {
        this.onToast(
          `A bordo · ${this.lineName}${this.coche ? ` #${this.coche}` : ''} · Servicio Android activo`,
          'success',
          4200
        );
      } else {
        this.onToast('Subir activado: pasará a Modo A Bordo apenas llegue el colectivo', 'success', 3800);
      }
      return true;
    }

    if (arrivingSoon) {
      return this.enterOnboardMode({ auto: false, bus, branch: this.branch, routeBranchesCache });
    }

    this.phase = 'boarding_armed';
    this._persistSession();
    this._emitUpdate();
    const msg = `Subir activado para línea ${formatLineaForTts(this.lineName)}. Cuando llegue el colectivo se activará el aviso de cada parada.`;
    this.onToast('Subir activado: pasará a Modo A Bordo apenas llegue el colectivo', 'success', 3800);
    this._dispatchNotification({ alertSound: false, speechText: msg, force: true });
    return true;
  }

  /**
   * Activa el Modo A Bordo estilo Uber: sigue tu viaje parada por parada y anuncia
   * timbre + "ARRIBANDO, <nombre de parada>" al acercarse a cada próxima parada.
   */
  enterOnboardMode({ auto = false, bus = null, branch = null, routeBranchesCache = null } = {}) {
    if (branch) this.branch = branch;
    if (!this.branch && bus) {
      this.branch = bus._matchedBranch || bus.trajectory?.branch || null;
    }
    if (!this.branch && routeBranchesCache && this.codLinea) {
      const branches = routeBranchesCache.get(Number(this.codLinea)) || [];
      if (branches.length > 0) {
        const normBand = String(this.bandera || '').toUpperCase();
        this.branch =
          branches.find((b) => normBand && String(b.bandera || '').toUpperCase().includes(normBand)) ||
          (this.originStop?.id
            ? branches.find((b) =>
                (b.orderedStops || []).some((s) => String(s.id || '').toUpperCase() === this.originStop.id)
              )
            : null) ||
          branches[0];
      }
    }

    this.orderedStops = this.branch ? normalizeOrderedStopsForRide(this.branch) : [];
    if (this.orderedStops.length === 0) {
      this.onToast('No se encontraron paradas del recorrido para activar Modo A Bordo.', 'warn', 3500);
      return false;
    }

    this.phase = 'onboard';
    this.announcedStopIds.clear();
    this.arrivingNow = false;
    this.gpsErrorNotified = false;
    this.distToNextM = null;
    this.progress01 = 0.05;

    // Determinar el punto de inicio (parada de ascenso o posición del bus)
    let startAlong = 0;
    if (this.originStop?.id) {
      const idx = this.orderedStops.findIndex((s) => s.id === this.originStop.id);
      if (idx >= 0) {
        startAlong = this.orderedStops[idx].along;
        this.announcedStopIds.add(this.orderedStops[idx].id);
        this.nextStopIdx = Math.min(this.orderedStops.length - 1, idx + 1);
        this.prevStopAlong = startAlong;
      }
    } else if (bus && Number.isFinite(Number(bus.lat)) && Number.isFinite(Number(bus.lng)) && this.branch?.pts) {
      const proj = projectOnPolyline(this.branch.pts, this.branch.cum, Number(bus.lat), Number(bus.lng));
      if (proj) {
        startAlong = proj.along;
        const nextI = this.orderedStops.findIndex((s) => s.along > startAlong + 50);
        this.nextStopIdx = nextI >= 0 ? nextI : this.orderedStops.length - 1;
        this.prevStopAlong = this.nextStopIdx > 0 ? this.orderedStops[this.nextStopIdx - 1].along : startAlong;
      }
    } else {
      this.nextStopIdx = Math.min(this.orderedStops.length - 1, 1);
      this.prevStopAlong = this.orderedStops[0].along;
    }
    this.currentAlong = startAlong;

    setKeepAwake(true);
    startBackgroundKeepAlive({
      title: `A bordo · ${this.lineName}${this.coche ? ` #${this.coche}` : ''}`,
      artist: this.orderedStops[this.nextStopIdx]?.cleanName || 'En viaje',
      onStop: () => this.alight()
    });
    this._startPhoneGps();
    this._persistSession();
    this._emitUpdate();

    const nextClean = this.orderedStops[this.nextStopIdx]?.cleanName || '';
    const speech = auto
      ? `El colectivo llegó. Modo a bordo activado en línea ${formatLineaForTts(this.lineName)}.${
          nextClean ? ` Próxima parada, ${nextClean}.` : ''
        }`
      : `Modo a bordo activado en línea ${formatLineaForTts(this.lineName)}${
          this.coche ? `, coche ${formatCocheForTts(this.coche)}` : ''
        }.${nextClean ? ` Próxima parada, ${nextClean}.` : ''}`;

    this.onToast(`A bordo · ${this.lineName}${this.coche ? ` #${this.coche}` : ''} · Avisará cada parada`, 'success', 4200);
    this._dispatchNotification({ alertSound: auto, speechText: speech, force: true });
    return true;
  }

  _startPhoneGps() {
    this._stopPhoneGps();
    if (typeof navigator === 'undefined' || !navigator.geolocation) return;
    try {
      this.watchId = navigator.geolocation.watchPosition(
        (pos) => {
          if (this.phase !== 'onboard') return;
          this.lastPhoneGpsMs = Date.now();
          this.evaluateOnboardPosition(pos.coords.latitude, pos.coords.longitude, 'phone');
        },
        (err) => {
          if (this.phase !== 'onboard' || this.gpsErrorNotified) return;
          this.gpsErrorNotified = true;
          if (err?.code === 1) {
            this.onToast('Sin GPS del celular: siguiendo la posición satelital del colectivo.', 'info', 3500);
          }
        },
        { enableHighAccuracy: true, maximumAge: 4000, timeout: 15000 }
      );
    } catch {
      // ignore
    }
  }

  _stopPhoneGps() {
    if (this.watchId !== null && typeof navigator !== 'undefined' && navigator.geolocation) {
      try {
        navigator.geolocation.clearWatch(this.watchId);
      } catch {
        // ignore
      }
    }
    this.watchId = null;
  }

  /**
   * Respaldo en Modo A Bordo con el GPS en vivo del colectivo cuando el GPS del celular no está disponible.
   */
  updateOnboardFromBus(bus) {
    if (this._nativePlugin) return;
    if (this.phase !== 'onboard' || !bus) return;
    const lat = Number(bus.lat ?? bus.rawLat);
    const lng = Number(bus.lng ?? bus.rawLng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
    // Priorizar GPS del celular si tuvo señal reciente (< 20 s)
    if (Date.now() - this.lastPhoneGpsMs < 20000) return;
    this.evaluateOnboardPosition(lat, lng, 'bus');
  }

  /**
   * Evalúa la posición actual a bordo sobre la polilínea del ramal:
   *  - Avanza de forma monotónica por `orderedStops`
   *  - Dispara timbre + "ARRIBANDO, <nombre de parada>" al entrar en zona de arribo (<= 155 m)
   *  - Actualiza la barra recta estilo Uber entre parada anterior y próxima parada.
   */
  evaluateOnboardPosition(lat, lng, source = 'phone') {
    if (this.phase !== 'onboard' || !this.branch?.pts || this.orderedStops.length === 0) {
      return { announcedStop: null, nextStop: null };
    }
    const proj = projectOnPolyline(this.branch.pts, this.branch.cum, Number(lat), Number(lng));
    if (!proj || proj.perp > 450) {
      return { announcedStop: null, nextStop: this.orderedStops[this.nextStopIdx] || null };
    }

    const curAlong = proj.along;
    // Evitar retrocesos espurios por rebote GPS (> 80 m hacia atrás se ignora)
    if (curAlong + 80 >= this.currentAlong) {
      this.currentAlong = Math.max(this.currentAlong, curAlong);
    }

    // Avanzar el índice si ya pasamos claramente una o más paradas
    while (
      this.nextStopIdx < this.orderedStops.length - 1 &&
      this.currentAlong > this.orderedStops[this.nextStopIdx].along + 45
    ) {
      this.prevStopAlong = this.orderedStops[this.nextStopIdx].along;
      this.nextStopIdx += 1;
      this.arrivingNow = false;
    }

    const nextStop = this.orderedStops[this.nextStopIdx];
    if (!nextStop) {
      return { announcedStop: null, nextStop: null };
    }

    const distAlong = nextStop.along - this.currentAlong;
    const straightM = distanceMeters(Number(lat), Number(lng), nextStop.lat, nextStop.lng);
    const effDistM = Math.max(0, Math.round(Math.min(Math.max(0, distAlong), straightM ?? Infinity)));
    this.distToNextM = effDistM;

    const segLen = Math.max(80, nextStop.along - this.prevStopAlong);
    this.progress01 = Math.max(0.04, Math.min(1, (this.currentAlong - this.prevStopAlong) / segLen));

    const inArrivalZone =
      (distAlong <= 155 && distAlong >= -35) || (straightM !== null && straightM <= 130 && distAlong <= 220);

    let announcedStop = null;
    if (inArrivalZone && !this.announcedStopIds.has(nextStop.id)) {
      this.announcedStopIds.add(nextStop.id);
      this.arrivingNow = true;
      this.progress01 = 1;
      announcedStop = nextStop;

      const isFinal = this.nextStopIdx >= this.orderedStops.length - 1;
      const speech = isFinal
        ? `Arribando, ${nextStop.cleanName}. Fin del recorrido.`
        : `Arribando, ${nextStop.cleanName}.`;

      this._emitUpdate();
      this._dispatchNotification({ alertSound: true, speechText: speech, force: true });
      this.onStopArrival({ stop: nextStop, distM: effDistM, speech, isFinal, source });
      return { announcedStop, nextStop };
    }

    this._emitUpdate();
    this._dispatchNotification({ alertSound: false });
    return { announcedStop: null, nextStop };
  }

  /**
   * Acción "Bajar": sale inmediatamente del Modo A Bordo, limpia notificación Android y anuncia por voz.
   */
  alight({ silent = false } = {}) {
    if (this.phase === 'idle') return;
    const wasOnboard = this.phase === 'onboard';
    this._stopPhoneGps();
    cancelPendingSpeech();
    this.phase = 'idle';
    this.arrivingNow = false;
    this.announcedStopIds.clear();
    this._nativeNextStop = null;
    this._nativeRemainingStops = 0;
    this._nativeFinalStopName = '';
    this._nativeUsingPhoneGps = false;

    if (this._nativePlugin) {
      const fn = silent ? this._nativePlugin.stopTrip : this._nativePlugin.alight;
      fn?.({ silent: Boolean(silent) }).catch(() => {});
      this._persistSession();
      this._emitUpdate();
      if (!silent) {
        const msg = wasOnboard
          ? 'Bajaste del colectivo. Modo viaje finalizado.'
          : 'Seguimiento en barra de estado detenido.';
        this.onToast(msg, 'info', 2800);
        this.onAnnounce(msg);
      }
      return;
    }

    setKeepAwake(false);
    stopBackgroundKeepAlive();
    closeSystemNotification(LIVE_TRACK_NOTIFICATION_TAG);
    this._persistSession();
    this._emitUpdate();

    if (!silent) {
      const msg = wasOnboard
        ? 'Bajaste del colectivo. Modo viaje finalizado.'
        : 'Seguimiento en barra de estado detenido.';
      this.onToast(msg, 'info', 2800);
      this.onAnnounce(msg);
      if (this.ttsEnabled && isSpeechSupported()) {
        speakText(msg);
      }
    }
  }

  stop({ silent = false } = {}) {
    this.alight({ silent });
  }
}

/**
 * Compatibilidad heredada: controlador simple de alarma GPS hacia 1 parada puntual.
 */
export class RideModeController {
  constructor({ onUpdate, onTrigger, onError, radiusMeters = 300 } = {}) {
    this.onUpdate = onUpdate || (() => {});
    this.onTrigger = onTrigger || (() => {});
    this.onError = onError || (() => {});
    this.radiusMeters = radiusMeters;
    this.watchId = null;
    this.target = null;
    this.triggered = false;
    this.lastDistM = null;
    this.useSound = true;
    this.useTts = false;
  }

  isActive() {
    return Boolean(this.target && this.watchId !== null);
  }

  start(target, { sound = true, tts = false, radiusMeters = 300 } = {}) {
    this.stop();
    if (!target || !Number.isFinite(Number(target.lat)) || !Number.isFinite(Number(target.lng))) {
      return false;
    }
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      this.onError('Tu navegador no soporta geolocalización GPS.');
      return false;
    }

    this.target = {
      id: String(target.id || '').toUpperCase(),
      nombre: target.nombre || target.id || 'Parada destino',
      lat: Number(target.lat),
      lng: Number(target.lng),
      lineName: target.lineName || ''
    };
    this.radiusMeters = Math.max(150, Math.min(800, Number(radiusMeters) || 300));
    this.triggered = false;
    this.lastDistM = null;
    this.useSound = Boolean(sound);
    this.useTts = Boolean(tts);

    setKeepAwake(true);
    this.watchId = navigator.geolocation.watchPosition(
      (pos) => {
        if (!this.target) return;
        const d = distanceMeters(pos.coords.latitude, pos.coords.longitude, this.target.lat, this.target.lng);
        if (d === null) return;
        this.lastDistM = Math.round(d);
        this.onUpdate({ target: this.target, distM: this.lastDistM, triggered: this.triggered });

        if (!this.triggered && d <= this.radiusMeters) {
          this.triggered = true;
          haptic('success');
          const cleanName = formatStopNameForTts(this.target.nombre);
          const msg = `Arribando, ${cleanName}.`;
          notifyArrival({
            title: `🔔 ARRIBANDO · ${cleanName}`,
            body: `A ${this.lastDistM} m de tu parada`,
            stopId: this.target.id,
            speechText: msg,
            speakAfterChime: this.useTts
          }).then((res) => {
            if (!res?.delivered && this.useSound) playArrivalChime();
            if (this.useTts && !res?.handledSpeechNatively) speakAfterNotification(msg, { delayMs: 950 });
          });
          this.onTrigger({ target: this.target, distM: this.lastDistM, message: msg });
        }
      },
      (err) => {
        this.onError(
          err?.code === 1
            ? 'Activá el permiso de ubicación para usar el aviso por GPS.'
            : 'Esperando señal GPS del celular...'
        );
      },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
    );

    this.onUpdate({ target: this.target, distM: null, triggered: false });
    return true;
  }

  stop() {
    if (this.watchId !== null && typeof navigator !== 'undefined' && navigator.geolocation) {
      try {
        navigator.geolocation.clearWatch(this.watchId);
      } catch {
        // ignore
      }
    }
    this.watchId = null;
    this.target = null;
    this.triggered = false;
    this.lastDistM = null;
    setKeepAwake(false);
    this.onUpdate(null);
  }
}
