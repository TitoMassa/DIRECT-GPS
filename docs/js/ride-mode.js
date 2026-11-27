import { distanceMeters } from './api.js';
import { playArrivalChime } from './audio.js';
import { haptic, notifyArrival, setKeepAwake } from './native.js';

/**
 * Síntesis de voz (TTS) opcional en español rioplatense/latinoamericano.
 */
export function isSpeechSupported() {
  return typeof window !== 'undefined' && 'speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined';
}

export function speakText(text) {
  if (!isSpeechSupported() || !text) return false;
  try {
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(String(text));
    u.lang = 'es-AR';
    u.rate = 1.04;
    u.pitch = 1.0;
    const voices = window.speechSynthesis.getVoices?.() || [];
    const esVoice =
      voices.find((v) => /^es-AR/i.test(v.lang)) ||
      voices.find((v) => /^es-(UY|CL|419|MX|ES)/i.test(v.lang)) ||
      voices.find((v) => /^es/i.test(v.lang));
    if (esVoice) u.voice = esVoice;
    window.speechSynthesis.speak(u);
    return true;
  } catch {
    return false;
  }
}

/**
 * "Modo Viaje" — Alarma de bajada por GPS del celular.
 * Monitorea continuamente la posición del pasajero arriba del colectivo y avisa
 * con sonido, vibración, notificación y voz cuando falta <= `radiusMeters` (~300 m / 2 cuadras).
 */
export class RideModeController {
  constructor({ onUpdate, onTrigger, onError, radiusMeters = 300 } = {}) {
    this.onUpdate = onUpdate || (() => {});
    this.onTrigger = onTrigger || (() => {});
    this.onError = onError || (() => {});
    this.radiusMeters = radiusMeters;
    this.watchId = null;
    this.target = null; // { id, nombre, lat, lng, lineName? }
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
      this.onError('Tu navegador no soporta geolocalización GPS para la alarma de bajada.');
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
          if (this.useSound) playArrivalChime();
          const msg = `¡Preparate para bajar! Estás a ${this.lastDistM} metros de ${this.target.nombre}.`;
          if (this.useTts) speakText(msg);
          notifyArrival({
            title: `Bajada próxima · ${this.target.nombre}`,
            body: `A ${this.lastDistM} m (~${Math.max(1, Math.round(this.lastDistM / 100))} cuadras) de tu parada destino`,
            stopId: this.target.id
          });
          this.onTrigger({ target: this.target, distM: this.lastDistM, message: msg });
        }
      },
      (err) => {
        this.onError(
          err?.code === 1
            ? 'Activa el permiso de ubicación para usar la alarma de bajada.'
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
        // Ignore
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
