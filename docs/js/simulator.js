import { sampleTrajectory, prependPathToTrajectory } from './trajectory.js';
import { computeProximityPercent } from './api.js';
import { evaluateTripState, getArgentinaSecOfDay } from './predictor.js';

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
 * Supports two seamless operating modes per unit:
 *  - 'gps': tracks fresh real GPS fixes with velocity EMA, zero-backjump hold on overshoot,
 *    curve-hugging catch-up on lag, stop micro-deceleration, and terminal layover hold.
 *  - 'schedule': tracks the official stop-by-stop timetable curve `along(now + desvio)` along
 *    the real street polylines when the phone is offline, a unit has no GPS, or GPS goes silent.
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
   * kinematic state. Call on EVERY poll (with applyPositions = state.simulateMode) so real
   * velocities and stopped states are already known when switching between ULT. GPS and EN VIVO.
   */
  reconcile(buses = [], { applyPositions = false, stopId = '' } = {}) {
    const nowMs = Date.now();
    const seen = new Set();

    for (const bus of buses) {
      if (!bus.trajectory || typeof bus.lat !== 'number' || typeof bus.lng !== 'number') continue;
      seen.add(bus.key);

      const newTraj = bus.trajectory;
      const newRealRem = newTraj.totalMeters;
      const prev = this.units.get(bus.key);
      const etaSec = Math.max(45, bus.etaSecondsRemaining || (bus.eta?.minutes || 10) * 60);

      // ── Case 1: Timetable-predicted unit (offline or running without GPS) ──
      if (bus.isPredicted && bus.scheduledTrip && bus.stopProj) {
        const desvioSec = bus.predDesvioSec || bus.desvio?.seconds || 0;
        if (!prev) {
          const initSpeed = newTraj.isAtTerminal ? 0 : clamp(newTraj.speedMps || 4.2, 0, 7.5);
          this.units.set(bus.key, {
            mode: 'schedule',
            scheduledTrip: bus.scheduledTrip,
            stopProj: bus.stopProj,
            stopId: stopId || bus.stopId || '',
            predDesvioSec: desvioSec,
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

        // Transitioning smoothly from previous state (either already 'schedule' or just lost GPS!)
        prev.mode = 'schedule';
        prev.scheduledTrip = bus.scheduledTrip;
        prev.stopProj = bus.stopProj;
        prev.stopId = stopId || bus.stopId || prev.stopId || '';
        prev.predDesvioSec = desvioSec;
        prev.isAtTerminal = Boolean(newTraj.isAtTerminal);
        prev.aheadSec = desvioSec;

        if (!applyPositions) {
          prev.activeTraj = newTraj;
          prev.walkedMeters = 0;
          prev.etaSecondsRemaining = etaSec;
          continue;
        }

        const prevSimRem = Math.max(0, prev.activeTraj.totalMeters - prev.walkedMeters);
        const deltaRem = newRealRem - prevSimRem;
        const sameLeg = prev.activeTraj.leg === newTraj.leg;

        // If already smoothly on the same leg within 220 m, keep exact visual path and let 30fps tracker converge!
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

      // Detect genuine mid-route GPS signal loss (>95 s stale while NOT parked at a cabecera):
      // when we know the bus's scheduled trip, keep it moving smoothly via timetable prediction!
      const lostGpsMidRoute =
        applyPositions && gpsAgeSec > 95 && !isAtTerminal && Boolean(bus.scheduledTrip && bus.stopProj);

      const conservativeInitSpeed =
        isStaleTracker || isAtTerminal
          ? 0
          : clamp((newRealRem / etaSec) * 0.62, 1.8, 3.8);

      if (!prev) {
        const entry = {
          mode: lostGpsMidRoute ? 'schedule' : 'gps',
          scheduledTrip: bus.scheduledTrip || null,
          stopProj: bus.stopProj || null,
          stopId: stopId || bus.stopId || '',
          predDesvioSec: aheadSec,
          lastGpsMs: gpsMs,
          lastGpsPollMs: nowMs,
          lastRealRem: newRealRem,
          hasConfirmedFix: false,
          observedSpeedMps: null,
          cruiseSpeedMps: conservativeInitSpeed,
          currentSpeedMps: conservativeInitSpeed * 0.4,
          isStopped: !lostGpsMidRoute && (isStaleTracker || isAtTerminal),
          isAtTerminal,
          aheadSec,
          overshootMeters: 0,
          lagMeters: 0,
          deadReckonMeters: 0,
          activeTraj: newTraj,
          walkedMeters: 0,
          etaSecondsRemaining: etaSec
        };
        if (lostGpsMidRoute) bus.gpsLost = true;
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

      // Did the bus tracker emit a genuinely NEW GPS fix since last poll?
      const movedFromLastReal = Math.abs(prev.lastRealRem - newRealRem);
      const gpsTimeDeltaSec = gpsMs && prev.lastGpsMs ? (gpsMs - prev.lastGpsMs) / 1000 : null;
      const isSameGpsTimestamp = gpsTimeDeltaSec !== null && gpsTimeDeltaSec < 2;
      const isFreshFix =
        (gpsTimeDeltaSec !== null && gpsTimeDeltaSec >= 3) ||
        (gpsTimeDeltaSec === null && movedFromLastReal >= 8) ||
        (prev.mode === 'schedule' && !lostGpsMidRoute);

      // Handle mid-route GPS dropout seamlessly: switch to timetable curve until fresh GPS returns
      if (lostGpsMidRoute) {
        prev.mode = 'schedule';
        bus.gpsLost = true;
        this._applySampleToBus(bus, prev, false);
        continue;
      }

      // Fresh or active GPS -> ensure mode is 'gps'
      const recoveredFromSchedule = prev.mode === 'schedule';
      prev.mode = 'gps';
      bus.gpsLost = false;

      // 1. Update real velocity / stopped state ONLY on genuinely fresh GPS fixes
      if (isFreshFix) {
        const dtReal =
          gpsTimeDeltaSec !== null && gpsTimeDeltaSec >= 3 && gpsTimeDeltaSec <= 180
            ? gpsTimeDeltaSec
            : Math.max(5, (nowMs - prev.lastGpsPollMs) / 1000);

        const realAdvance = prev.lastRealRem - newRealRem;
        const minMoveThreshold = isAtTerminal ? 20 : 11;

        if ((realAdvance < minMoveThreshold && dtReal >= 7) || (likelyTerminalRest && realAdvance < 28)) {
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
        // Sim is ahead by up to 180 m: keep visual position on newTraj (0.0 m jump!) & hold smoothly
        prev.activeTraj = newTraj;
        prev.walkedMeters = clamp(deltaRem, 0, newTraj.totalMeters);
        prev.overshootMeters = deltaRem;
        prev.lagMeters = 0;
        prev.deadReckonMeters = 0;
      } else if (sameLegType && deltaRem < 0 && -deltaRem <= 340) {
        // Sim is behind by up to 340 m: splice street curve & catch up smoothly
        const lag = -deltaRem;
        const spliced = prependPathToTrajectory(prev.activeTraj, prev.walkedMeters, newTraj);
        prev.activeTraj = spliced;
        prev.walkedMeters = 0;
        prev.overshootMeters = 0;
        prev.lagMeters = lag;
        prev.deadReckonMeters = 0;
      } else {
        // Large genuine discontinuity (>340 m or leg changed): re-anchor cleanly
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

      // ── Mode A: Timetable-driven smooth 30fps tracking (offline / no-GPS / lost-GPS) ──
      if (st.mode === 'schedule' && st.scheduledTrip && st.stopProj) {
        const ev = evaluateTripState(st.scheduledTrip, st.stopId, st.stopProj, nowSec, st.predDesvioSec || 0);
        let targetSpeed = 0;

        if (!ev) {
          targetSpeed = 0;
          st.etaSecondsRemaining = 0;
        } else {
          const targetWalked = clamp(traj.totalMeters - ev.remainingMeters, 0, traj.totalMeters);
          const err = targetWalked - st.walkedMeters;

          if (ev.speedMps <= 0.05 || ev.isAtTerminal) {
            // Resting at cabecera or arrived at stop -> smooth stop & hold at 0 m/s
            targetSpeed = 0;
          } else if (err < -4) {
            // Slightly ahead of schedule curve -> gently ease off (NEVER jump backwards!)
            targetSpeed = clamp(ev.speedMps * 0.25, 0, 2.0);
          } else {
            // Track exact timetable speed + gentle proportional convergence
            targetSpeed = clamp(ev.speedMps + clamp(err / 6.5, 0, 3.0), 0, 11.0);
          }

          st.etaSecondsRemaining = ev.etaSec;
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
