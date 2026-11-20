import { sampleTrajectory, prependPathToTrajectory } from './trajectory.js';
import { computeProximityPercent, distanceMeters, parseDesvioHorario } from './api.js';
import {
  evaluateTripState,
  getArgentinaSecOfDay,
  buildGpsAnchorForTrip,
  formatDesvioFromSec
} from './predictor.js';

const STATIONARY_OFFLINE_THRESHOLD_SEC = 180; // Full 3 minutes stationary outside a cabecera before switching to predicted mode

/**
 * Parses SmartMovePro GPS timestamp ("DD/MM/YYYY HH:MM:SS" in Argentina UTC-3) into UTC epoch ms.
 */
export function parseGpsTimestampMs(raw = '') {
  const clean = String(raw || '').trim();
  const m = clean.match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return null;
  const [, dd, mm, yyyy, hh, mi, ss] = m;
  return Date.UTC(
    parseInt(yyyy, 10),
    parseInt(mm, 10) - 1,
    parseInt(dd, 10),
    parseInt(hh, 10) + 3, // Argentina UTC-3 -> UTC
    parseInt(mi, 10),
    parseInt(ss, 10)
  );
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

/**
 * Physically-faithful, zero-backjump kinematic vehicle predictor for EN VIVO mode.
 *
 * Operating rules:
 *  - 'gps': tracks fresh real GPS fixes with velocity EMA, zero-backjump hold, stop micro-deceleration,
 *    and cabecera layover hold. If a live GPS bus stays stationary (<20 m) at a non-cabecera spot, it
 *    remains QUIET at its real GPS spot for a full 3 minutes (180 s) before switching to predicted mode!
 *  - 'schedule': tracks the official stop-by-stop timetable anchored to the bus's exact last known GPS
 *    position (`scheduleAnchor`), preserving accumulated delay and recovering gradually (~4.8 s/min)
 *    instead of jumping magically to on-time punctuality.
 */
export class BusSimulator {
  constructor() {
    this.units = new Map(); // busKey -> kinematic state
  }

  clear() {
    this.units.clear();
  }

  /**
   * Transfers persistent kinematic state from `oldKey` to `newKey` so handoffs between
   * timetable-predicted units (`pred:...`) and live GPS units (`codLinea-cXXXX`) happen
   * with zero visual jump or duplicate markers.
   */
  transferState(oldKey, newKey) {
    if (!oldKey || !newKey || oldKey === newKey) return false;
    const prev = this.units.get(oldKey);
    if (!prev || this.units.has(newKey)) return false;
    this.units.set(newKey, prev);
    this.units.delete(oldKey);
    return true;
  }

  /**
   * Reconciles a fresh poll (or offline prediction cycle) of normalized buses with persistent
   * kinematic state.
   */
  reconcile(buses = [], { applyPositions = false, stopId = '' } = {}) {
    const nowMs = Date.now();
    const nowSec = getArgentinaSecOfDay(new Date(nowMs));
    const seen = new Set();
    const busByKey = new Map();
    const nextLapBuses = [];

    for (const bus of buses) {
      busByKey.set(bus.key, bus);
      if (bus.isNextLap && bus.nextLapOfKey) {
        nextLapBuses.push(bus);
        continue;
      }
      if (!bus.trajectory || typeof bus.lat !== 'number' || typeof bus.lng !== 'number') continue;
      seen.add(bus.key);

      const newTraj = bus.trajectory;
      const newRealRem = newTraj.totalMeters;
      const prev = this.units.get(bus.key);
      const etaSec = Math.max(45, bus.etaSecondsRemaining || (bus.eta?.minutes || 10) * 60);

      // ── Case 1: Timetable-predicted unit (offline, vanished mid-route, or no GPS) ──
      if (bus.isPredicted && bus.scheduledTrip && bus.stopProj) {
        const desvioSec = bus.predDesvioSec || bus.desvio?.seconds || 0;
        const incomingAnchor = bus.predAnchor || null;

        if (!prev) {
          const initSpeed = newTraj.isAtTerminal ? 0 : clamp(newTraj.speedMps || 4.2, 0, 7.5);
          this.units.set(bus.key, {
            mode: 'schedule',
            scheduledTrip: bus.scheduledTrip,
            stopProj: bus.stopProj,
            stopId: stopId || bus.stopId || '',
            predDesvioSec: desvioSec,
            scheduleAnchor: incomingAnchor,
            anchorLat: bus.lat,
            anchorLng: bus.lng,
            stationarySinceMs: null,
            lastGpsMs: null,
            lastGpsPollMs: nowMs,
            lastRealRem: newRealRem,
            hasConfirmedFix: false,
            observedSpeedMps: null,
            cruiseSpeedMps: initSpeed,
            currentSpeedMps: initSpeed * 0.55,
            isStopped: newTraj.isAtTerminal,
            isAtTerminal: Boolean(newTraj.isAtTerminal),
            aheadSec: desvioSec,
            overshootMeters: 0,
            lagMeters: 0,
            deadReckonMeters: 0,
            activeTraj: newTraj,
            walkedMeters: 0,
            etaSecondsRemaining: etaSec
          });
          continue;
        }

        // Transitioning smoothly (already 'schedule' OR just handed off from a live GPS unit that vanished!)
        const wasLiveGps = prev.mode === 'gps';
        prev.mode = 'schedule';
        prev.scheduledTrip = bus.scheduledTrip;
        prev.stopProj = bus.stopProj;
        prev.stopId = stopId || bus.stopId || prev.stopId || '';
        prev.predDesvioSec = desvioSec;
        prev.isAtTerminal = Boolean(newTraj.isAtTerminal);
        prev.aheadSec = desvioSec;

        if (wasLiveGps) {
          // Anchor directly to the bus's last visual/GPS position so it starts RIGHT THERE with gradual recovery!
          const curSample = sampleTrajectory(prev.activeTraj, prev.walkedMeters);
          const aLat = curSample?.lat ?? prev.anchorLat ?? bus.lat;
          const aLng = curSample?.lng ?? prev.anchorLng ?? bus.lng;
          prev.scheduleAnchor =
            buildGpsAnchorForTrip(bus.scheduledTrip, aLat, aLng, nowSec, desvioSec) || incomingAnchor;
        } else if (incomingAnchor && !prev.scheduleAnchor) {
          prev.scheduleAnchor = incomingAnchor;
        }

        if (!applyPositions) {
          prev.activeTraj = newTraj;
          prev.walkedMeters = 0;
          prev.etaSecondsRemaining = etaSec;
          continue;
        }

        const prevSimRem = Math.max(0, prev.activeTraj.totalMeters - prev.walkedMeters);
        const deltaRem = newRealRem - prevSimRem;
        const sameLeg = prev.activeTraj.leg === newTraj.leg;

        if (!sameLeg || Math.abs(deltaRem) > 220) {
          if (sameLeg && deltaRem < 0 && -deltaRem <= 320) {
            prev.activeTraj = prependPathToTrajectory(prev.activeTraj, prev.walkedMeters, newTraj);
            prev.walkedMeters = 0;
          } else {
            prev.activeTraj = newTraj;
            prev.walkedMeters = 0;
          }
        }

        prev.etaSecondsRemaining = etaSec;
        this._applySampleToBus(bus, prev, false);
        continue;
      }

      // ── Case 2: Live GPS unit ──
      const gpsMs = parseGpsTimestampMs(bus.ultimaFechaHoraGPS);
      const rawAgeSec = gpsMs ? (nowMs - gpsMs) / 1000 : 0;
      const gpsAgeSec = rawAgeSec >= 0 && rawAgeSec < 7200 ? rawAgeSec : 0;
      const isStaleTracker = gpsAgeSec > 45;

      const isAtTerminal = Boolean(newTraj.isAtTerminal);
      const aheadSec = bus.desvio?.seconds || 0;
      const likelyTerminalRest = isAtTerminal && aheadSec >= 60;

      const conservativeInitSpeed =
        isStaleTracker || isAtTerminal
          ? 0
          : clamp((newRealRem / etaSec) * 0.62, 1.8, 3.8);

      if (!prev) {
        // Record when this bus was first observed at (anchorLat, anchorLng); use GPS timestamp if already aging
        const initialStationarySince =
          gpsMs && gpsMs < nowMs && nowMs - gpsMs < 7200000 ? gpsMs : nowMs;
        const alreadyFrozen3Min =
          applyPositions &&
          !isAtTerminal &&
          gpsAgeSec >= STATIONARY_OFFLINE_THRESHOLD_SEC &&
          Boolean(bus.scheduledTrip && bus.stopProj);

        const initAnchor = alreadyFrozen3Min
          ? buildGpsAnchorForTrip(bus.scheduledTrip, bus.lat, bus.lng, nowSec, aheadSec)
          : null;

        const entry = {
          mode: alreadyFrozen3Min ? 'schedule' : 'gps',
          scheduledTrip: bus.scheduledTrip || null,
          stopProj: bus.stopProj || null,
          stopId: stopId || bus.stopId || '',
          predDesvioSec: aheadSec,
          scheduleAnchor: initAnchor,
          anchorLat: bus.lat,
          anchorLng: bus.lng,
          stationarySinceMs: initialStationarySince,
          lastGpsMs: gpsMs,
          lastGpsPollMs: nowMs,
          lastRealRem: newRealRem,
          hasConfirmedFix: false,
          observedSpeedMps: null,
          cruiseSpeedMps: conservativeInitSpeed,
          currentSpeedMps: alreadyFrozen3Min ? 0 : conservativeInitSpeed * 0.4,
          isStopped: !alreadyFrozen3Min && (isStaleTracker || isAtTerminal),
          isAtTerminal,
          aheadSec,
          overshootMeters: 0,
          lagMeters: 0,
          deadReckonMeters: 0,
          activeTraj: newTraj,
          walkedMeters: 0,
          etaSecondsRemaining: etaSec
        };
        if (alreadyFrozen3Min) bus.gpsLost = true;
        this.units.set(bus.key, entry);
        continue;
      }

      prev.isAtTerminal = isAtTerminal;
      prev.aheadSec = aheadSec;
      if (bus.scheduledTrip && bus.stopProj) {
        prev.scheduledTrip = bus.scheduledTrip;
        prev.stopProj = bus.stopProj;
        prev.stopId = stopId || bus.stopId || prev.stopId || '';
        prev.predDesvioSec = aheadSec;
      }

      // Track genuine spatial displacement from anchor (>= 20 m resets the 3-minute stationary timer)
      const distFromAnchor =
        typeof prev.anchorLat === 'number' && typeof prev.anchorLng === 'number'
          ? distanceMeters(prev.anchorLat, prev.anchorLng, bus.lat, bus.lng) ?? 0
          : 999;

      if (distFromAnchor >= 20) {
        prev.anchorLat = bus.lat;
        prev.anchorLng = bus.lng;
        prev.stationarySinceMs = nowMs;
        prev.scheduleAnchor = null;
      } else if (prev.stationarySinceMs === null) {
        prev.stationarySinceMs = gpsMs && gpsMs < nowMs && nowMs - gpsMs < 7200000 ? gpsMs : nowMs;
      }

      const stationarySec = prev.stationarySinceMs !== null ? (nowMs - prev.stationarySinceMs) / 1000 : 0;

      // Strict 3-minute (180 s) rule:
      // NEVER switch a stationary live GPS bus to predicted/offline mode until at least 3 FULL MINUTES
      // have passed in the same non-cabecera location (or 3 full minutes with no GPS timestamp update).
      // And NEVER switch while parked at either punta de línea (cabecera)!
      const lostGpsMidRoute =
        applyPositions &&
        !isAtTerminal &&
        Boolean(bus.scheduledTrip && bus.stopProj) &&
        (stationarySec >= STATIONARY_OFFLINE_THRESHOLD_SEC || gpsAgeSec >= STATIONARY_OFFLINE_THRESHOLD_SEC);

      if (lostGpsMidRoute) {
        if (prev.mode !== 'schedule' || !prev.scheduleAnchor) {
          // Transition at >= 3 min: anchor RIGHT AT the bus's exact visual/GPS spot (0 m jump!)
          // starting at `nowSec` so it smoothly pulls away from there and recovers delay gradually!
          const curSample = sampleTrajectory(prev.activeTraj, prev.walkedMeters);
          const sameLeg = prev.activeTraj && prev.activeTraj.leg === newTraj.leg;
          const visualDist =
            curSample && typeof curSample.lat === 'number'
              ? distanceMeters(curSample.lat, curSample.lng, bus.lat, bus.lng) ?? 999
              : 999;

          let aLat = bus.lat;
          let aLng = bus.lng;
          if (sameLeg && visualDist <= 85 && curSample) {
            aLat = curSample.lat;
            aLng = curSample.lng;
          } else {
            prev.activeTraj = newTraj;
            prev.walkedMeters = 0;
          }
          prev.currentSpeedMps = 0;
          prev.scheduleAnchor = buildGpsAnchorForTrip(
            bus.scheduledTrip,
            aLat,
            aLng,
            nowSec,
            aheadSec
          );
        }
        prev.mode = 'schedule';
        bus.gpsLost = true;
        this._applySampleToBus(bus, prev, false);
        continue;
      }

      // Active GPS (moving, or stationary < 3 min, or resting at cabecera) -> strictly 'gps' mode!
      const recoveredFromSchedule = prev.mode === 'schedule';
      prev.mode = 'gps';
      prev.scheduleAnchor = null;
      bus.gpsLost = false;

      const movedFromLastReal = Math.abs(prev.lastRealRem - newRealRem);
      const gpsTimeDeltaSec = gpsMs && prev.lastGpsMs ? (gpsMs - prev.lastGpsMs) / 1000 : null;
      const isSameGpsTimestamp = gpsTimeDeltaSec !== null && gpsTimeDeltaSec < 2;
      const isFreshFix =
        (gpsTimeDeltaSec !== null && gpsTimeDeltaSec >= 3) ||
        (gpsTimeDeltaSec === null && movedFromLastReal >= 8) ||
        recoveredFromSchedule;

      // 1. Update real velocity / stopped state ONLY on genuinely fresh GPS fixes
      if (isFreshFix) {
        const dtReal =
          gpsTimeDeltaSec !== null && gpsTimeDeltaSec >= 3 && gpsTimeDeltaSec <= 180
            ? gpsTimeDeltaSec
            : Math.max(5, (nowMs - prev.lastGpsPollMs) / 1000);

        const realAdvance = prev.lastRealRem - newRealRem;
        const minMoveThreshold = isAtTerminal ? 20 : 11;

        if ((realAdvance < minMoveThreshold && dtReal >= 7) || (likelyTerminalRest && realAdvance < 28)) {
          // Bus is stationary (< 3 min at traffic light/stop, or resting at cabecera) -> HOLD QUIET at 0 m/s!
          prev.isStopped = true;
          prev.cruiseSpeedMps = 0;
          if (prev.observedSpeedMps !== null) {
            prev.observedSpeedMps = Math.max(2.2, prev.observedSpeedMps * 0.85);
          }
        } else if (realAdvance >= minMoveThreshold && realAdvance < 900) {
          const instSpeed = clamp(realAdvance / dtReal, 0.9, 10.5);
          prev.observedSpeedMps =
            prev.observedSpeedMps !== null ? 0.62 * instSpeed + 0.38 * prev.observedSpeedMps : instSpeed;
          prev.cruiseSpeedMps = prev.observedSpeedMps;
          prev.isStopped = false;
        } else if (recoveredFromSchedule) {
          prev.isStopped = isAtTerminal;
          prev.cruiseSpeedMps = isAtTerminal ? 0 : Math.max(2.8, prev.currentSpeedMps || 4.0);
        }

        prev.hasConfirmedFix = true;
        prev.lastGpsMs = gpsMs ?? prev.lastGpsMs;
        prev.lastGpsPollMs = nowMs;
        prev.lastRealRem = newRealRem;
      } else if (isSameGpsTimestamp || isStaleTracker || likelyTerminalRest) {
        const silentSec = (nowMs - prev.lastGpsPollMs) / 1000;
        if (silentSec > 24 || isStaleTracker || likelyTerminalRest) {
          prev.isStopped = true;
          prev.cruiseSpeedMps = 0;
        }
      }

      // 2. Smoothly reconcile position without ANY backward jumps when in EN VIVO mode
      if (!applyPositions) {
        prev.activeTraj = newTraj;
        prev.walkedMeters = 0;
        prev.overshootMeters = 0;
        prev.lagMeters = 0;
        prev.deadReckonMeters = 0;
        prev.etaSecondsRemaining = etaSec;
        continue;
      }

      if (isSameGpsTimestamp && !recoveredFromSchedule) {
        this._applySampleToBus(bus, prev, false);
        continue;
      }

      const prevSimRem = Math.max(0, prev.activeTraj.totalMeters - prev.walkedMeters);
      const deltaRem = newRealRem - prevSimRem;
      const sameLegType = prev.activeTraj.leg === newTraj.leg;

      if (sameLegType && deltaRem >= 0 && deltaRem <= 180) {
        prev.activeTraj = newTraj;
        prev.walkedMeters = clamp(deltaRem, 0, newTraj.totalMeters);
        prev.overshootMeters = deltaRem;
        prev.lagMeters = 0;
        prev.deadReckonMeters = 0;
      } else if (sameLegType && deltaRem < 0 && -deltaRem <= 340) {
        const lag = -deltaRem;
        const spliced = prependPathToTrajectory(prev.activeTraj, prev.walkedMeters, newTraj);
        prev.activeTraj = spliced;
        prev.walkedMeters = 0;
        prev.overshootMeters = 0;
        prev.lagMeters = lag;
        prev.deadReckonMeters = 0;
      } else {
        prev.activeTraj = newTraj;
        prev.walkedMeters = 0;
        prev.overshootMeters = 0;
        prev.lagMeters = 0;
        prev.deadReckonMeters = 0;
        prev.currentSpeedMps = Math.min(prev.currentSpeedMps, prev.cruiseSpeedMps);
      }

      const targetEtaSec = etaSec;
      if (Math.abs(targetEtaSec - prev.etaSecondsRemaining) <= 180) {
        prev.etaSecondsRemaining = prev.etaSecondsRemaining * 0.4 + targetEtaSec * 0.6;
      } else {
        prev.etaSecondsRemaining = targetEtaSec;
      }

      this._applySampleToBus(bus, prev, false);
    }

    // Mirror next-lap (`Sig. vuelta`) virtual cards onto their reconciled source bus (lat/lng, routeMeters, live status)
    for (const bus of nextLapBuses) {
      const src = busByKey.get(bus.nextLapOfKey);
      if (!src) continue;
      bus.lat = src.lat;
      bus.lng = src.lng;
      if (typeof src.routeMeters === 'number') {
        bus.routeMeters = Math.max(0, src.routeMeters + (bus.nextLapExtraMeters || 0));
        bus.distanceMeters = bus.routeMeters;
      }
      bus.nextLapSourceLive = !src.isPredicted && !src.gpsLost;
      bus.predictionReason = bus.nextLapSourceLive ? 'next-lap-live' : 'next-lap-offline';
      if (src.realBandera) bus.realBandera = src.realBandera;
      if (src.realBanderaColor) bus.realBanderaColor = src.realBanderaColor;
    }

    // Prune departed buses
    for (const key of this.units.keys()) {
      if (!seen.has(key)) this.units.delete(key);
    }
  }

  /**
   * Advances all buses smoothly by `dtSec` (~0.033 s at 30fps).
   */
  step(dtSec, buses = [], { updateEta = false } = {}) {
    const dt = clamp(dtSec, 0.005, 0.15);
    const nowMs = Date.now();
    const nowSec = getArgentinaSecOfDay(new Date(nowMs));

    for (const bus of buses) {
      const st = this.units.get(bus.key);
      if (!st || !st.activeTraj) continue;

      const traj = st.activeTraj;

      // ── Mode A: Timetable-driven smooth 30fps tracking anchored to last GPS + gradual recovery ──
      if (st.mode === 'schedule' && st.scheduledTrip && st.stopProj) {
        const ev = evaluateTripState(st.scheduledTrip, st.stopId, st.stopProj, nowSec, st.predDesvioSec || 0, {
          maxAheadSec: 160 * 60,
          anchor: st.scheduleAnchor || null
        });
        let targetSpeed = 0;

        if (!ev) {
          targetSpeed = 0;
          st.etaSecondsRemaining = 0;
        } else {
          const targetWalked = clamp(traj.totalMeters - ev.remainingMeters, 0, traj.totalMeters);
          const err = targetWalked - st.walkedMeters;

          if (ev.speedMps <= 0.05 || ev.isAtTerminal) {
            targetSpeed = 0;
          } else if (err < -4) {
            targetSpeed = clamp(ev.speedMps * 0.25, 0, 2.0);
          } else {
            targetSpeed = clamp(ev.speedMps + clamp(err / 6.5, 0, 2.5), 0, 11.0);
          }

          st.etaSecondsRemaining = ev.etaSec;
          if (updateEta && st.scheduleAnchor && Number.isFinite(ev.effectiveOffsetSec)) {
            bus.desvio = parseDesvioHorario(formatDesvioFromSec(ev.effectiveOffsetSec));
          }
        }

        const maxAccel = 0.85;
        const maxBrake = 1.85;
        const dv = targetSpeed - st.currentSpeedMps;
        if (dv > 0) st.currentSpeedMps += Math.min(dv, maxAccel * dt);
        else st.currentSpeedMps += Math.max(dv, -maxBrake * dt);
        if (st.currentSpeedMps < 0.04 && targetSpeed === 0) st.currentSpeedMps = 0;

        const advance = st.currentSpeedMps * dt;
        if (advance > 0) {
          st.walkedMeters = Math.min(traj.totalMeters, st.walkedMeters + advance);
        }

        this._applySampleToBus(bus, st, updateEta);
        continue;
      }

      // ── Mode B: Live GPS kinematic prediction ──
      const silentSec = (nowMs - st.lastGpsPollMs) / 1000;
      const maxLookahead = st.hasConfirmedFix
        ? clamp((st.observedSpeedMps || 3.5) * 13, 42, 80)
        : 40;

      const reachedTurnaround =
        (traj.turnaroundAtMeters > 40 && Math.abs(st.walkedMeters - traj.turnaroundAtMeters) < 25) ||
        (traj.oppStartMeters > 40 && Math.abs(st.walkedMeters - traj.oppStartMeters) < 25);

      let targetSpeed = 0;

      if (st.lagMeters > 3) {
        const baseCruise = st.isStopped ? 1.8 : Math.max(2.2, st.cruiseSpeedMps);
        const catchupBoost = clamp(st.lagMeters / 8.5, 0.4, 3.6);
        targetSpeed = clamp(baseCruise + catchupBoost, 1.5, 10.8);
      } else if (st.isStopped || st.overshootMeters > 6 || (reachedTurnaround && st.aheadSec >= 45)) {
        targetSpeed = 0;
      } else {
        targetSpeed = st.cruiseSpeedMps;

        const taperStart = maxLookahead * 0.62;
        if (st.deadReckonMeters > taperStart) {
          const ratio = clamp(1 - (st.deadReckonMeters - taperStart) / (maxLookahead - taperStart), 0, 1);
          targetSpeed *= ratio;
        }

        if (silentSec > 16) {
          targetSpeed *= clamp(1 - (silentSec - 16) / 10, 0, 1);
        }
      }

      if (targetSpeed > 1.8 && Array.isArray(traj.stopAlongs) && traj.stopAlongs.length > 0) {
        const w = st.walkedMeters;
        for (let i = 0; i < traj.stopAlongs.length; i++) {
          const distToStop = traj.stopAlongs[i] - w;
          if (distToStop > 0 && distToStop < 28) {
            targetSpeed *= 0.62;
            break;
          }
          if (distToStop >= 28) break;
        }
      }

      const maxAccel = 0.85;
      const maxBrake = 1.85;
      const dv = targetSpeed - st.currentSpeedMps;
      if (dv > 0) {
        st.currentSpeedMps += Math.min(dv, maxAccel * dt);
      } else {
        st.currentSpeedMps += Math.max(dv, -maxBrake * dt);
      }
      if (st.currentSpeedMps < 0.04 && targetSpeed === 0) {
        st.currentSpeedMps = 0;
      }

      const advance = st.currentSpeedMps * dt;
      if (advance > 0) {
        const prevW = st.walkedMeters;
        st.walkedMeters = Math.min(traj.totalMeters, st.walkedMeters + advance);
        const actualMove = st.walkedMeters - prevW;

        if (st.lagMeters > 0) {
          const consumed = Math.min(st.lagMeters, actualMove);
          st.lagMeters -= consumed;
          st.deadReckonMeters += actualMove - consumed;
        } else {
          st.deadReckonMeters += actualMove;
        }
      }

      if (st.currentSpeedMps > 0.35) {
        st.etaSecondsRemaining = Math.max(0, st.etaSecondsRemaining - dt);
      }

      this._applySampleToBus(bus, st, updateEta);
    }

    // Keep next-lap (`Sig. vuelta`) virtual cards smoothly synchronized with their source bus at 30fps
    let busByKey = null;
    for (const bus of buses) {
      if (!bus.isNextLap || !bus.nextLapOfKey) continue;
      if (!busByKey) busByKey = new Map(buses.map((b) => [b.key, b]));
      const src = busByKey.get(bus.nextLapOfKey);
      if (!src) continue;

      bus.lat = src.lat;
      bus.lng = src.lng;
      if (typeof src.routeMeters === 'number') {
        bus.routeMeters = Math.max(0, src.routeMeters + (bus.nextLapExtraMeters || 0));
        bus.distanceMeters = bus.routeMeters;
      }
      if (src.realBandera) bus.realBandera = src.realBandera;
      if (src.realBanderaColor) bus.realBanderaColor = src.realBanderaColor;

      bus.etaSecondsRemaining = Math.max(0, (bus.etaSecondsRemaining ?? 0) - dt);
      if (updateEta) {
        const mins = Math.ceil(bus.etaSecondsRemaining / 60);
        if (bus.etaSecondsRemaining <= 35) {
          bus.eta = { minutes: 0, valid: true, display: 'YA', unit: 'Arribando', urgency: 'now' };
          bus.tiempoRaw = 'Arribando..';
        } else {
          bus.eta = {
            minutes: mins,
            valid: true,
            display: `${mins}`,
            unit: 'min',
            urgency: mins <= 3 ? 'now' : mins <= 9 ? 'soon' : 'later'
          };
          bus.tiempoRaw = bus.nextLapSourceLive ? `${mins} min. aprox.` : `${mins} min. est.`;
        }
        bus.proximityPct = computeProximityPercent(bus.eta.minutes, bus.routeMeters);
      }
    }
  }

  _applySampleToBus(bus, st, updateEta) {
    const sample = sampleTrajectory(st.activeTraj, st.walkedMeters);
    if (!sample) return;

    bus.trajectory = st.activeTraj;
    bus.lat = sample.lat;
    bus.lng = sample.lng;
    bus.routeMeters = sample.remainingMeters;
    bus.isOppositeLeg = sample.inOppositeLeg;
    bus.isNextCycle = Boolean(sample.inNextCycle);
    if (sample.currentBandera) bus.realBandera = sample.currentBandera;
    if (sample.currentBranchColor) bus.realBanderaColor = sample.currentBranchColor;

    if (updateEta) {
      bus.etaSecondsRemaining = st.etaSecondsRemaining;
      const mins = Math.ceil(st.etaSecondsRemaining / 60);
      if (sample.arrived || st.etaSecondsRemaining <= 35) {
        bus.eta = { minutes: 0, valid: true, display: 'YA', unit: 'Arribando', urgency: 'now' };
        bus.tiempoRaw = 'Arribando..';
      } else {
        bus.eta = {
          minutes: mins,
          valid: true,
          display: `${mins}`,
          unit: 'min',
          urgency: mins <= 3 ? 'now' : mins <= 9 ? 'soon' : 'later'
        };
        bus.tiempoRaw = bus.isPredicted ? `${mins} min. est.` : `${mins} min. aprox.`;
      }
      bus.proximityPct = computeProximityPercent(bus.eta.minutes, bus.routeMeters);
    }
  }
}
