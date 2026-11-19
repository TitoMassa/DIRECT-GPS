import { sampleTrajectory, prependPathToTrajectory } from './trajectory.js';
import { computeProximityPercent } from './api.js';

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
 * Physically-faithful, zero-backjump kinematic vehicle predictor for Simulation Mode.
 *
 * Separates three distinct quantities per unit:
 *  - `overshootMeters`: how far ahead of the freshly-confirmed real GPS the marker sits (triggers smooth hold, NEVER jumps backwards)
 *  - `lagMeters`: how far behind the freshly-confirmed real GPS the marker sits (triggers smooth curve-hugging catch-up)
 *  - `deadReckonMeters`: how far we've cruised since the last GPS fix (capped smoothly so stopped buses never run away)
 */
export class BusSimulator {
  constructor() {
    this.units = new Map(); // busKey -> kinematic state
  }

  clear() {
    this.units.clear();
  }

  /**
   * Reconciles a fresh poll of normalized buses with persistent kinematic state.
   * Call on EVERY poll (with applyPositions = state.simulateMode) so real velocities
   * and stopped states are already known the moment Simulation Mode is turned on.
   */
  reconcile(buses = [], { applyPositions = false } = {}) {
    const nowMs = Date.now();
    const seen = new Set();

    for (const bus of buses) {
      if (!bus.trajectory || typeof bus.lat !== 'number' || typeof bus.lng !== 'number') continue;
      seen.add(bus.key);

      const newTraj = bus.trajectory;
      const newRealRem = newTraj.totalMeters;
      const gpsMs = parseGpsTimestampMs(bus.ultimaFechaHoraGPS);
      const prev = this.units.get(bus.key);

      // Compute GPS staleness safely (ignoring absurd client clock skew > 2h)
      const rawAgeSec = gpsMs ? (nowMs - gpsMs) / 1000 : 0;
      const gpsAgeSec = rawAgeSec >= 0 && rawAgeSec < 7200 ? rawAgeSec : 0;
      const isStaleTracker = gpsAgeSec > 45;

      // Terminal layover (descanso en cabecera / punta de línea):
      // If a bus is physically at a terminal (within ~165 m of branch start/end), especially with
      // positive schedule deviation (+MM:SS adelanto), assume it is resting until fresh GPS proves departure!
      const isAtTerminal = Boolean(newTraj.isAtTerminal);
      const aheadSec = bus.desvio?.seconds || 0;
      const likelyTerminalRest = isAtTerminal && aheadSec >= 60;

      // Conservative initial speed before 2 distinct GPS timestamps have been observed
      const etaSec = Math.max(60, (bus.eta?.minutes || 10) * 60);
      const conservativeInitSpeed =
        isStaleTracker || isAtTerminal
          ? 0
          : clamp((newRealRem / etaSec) * 0.62, 1.8, 3.8);

      if (!prev) {
        const entry = {
          lastGpsMs: gpsMs,
          lastGpsPollMs: nowMs,
          lastRealRem: newRealRem,
          hasConfirmedFix: false,
          observedSpeedMps: null,
          cruiseSpeedMps: conservativeInitSpeed,
          currentSpeedMps: conservativeInitSpeed * 0.4,
          isStopped: isStaleTracker || isAtTerminal,
          isAtTerminal,
          aheadSec,
          overshootMeters: 0,
          lagMeters: 0,
          deadReckonMeters: 0,
          activeTraj: newTraj,
          walkedMeters: 0,
          etaSecondsRemaining: bus.etaSecondsRemaining || etaSec
        };
        this.units.set(bus.key, entry);
        continue;
      }

      prev.isAtTerminal = isAtTerminal;
      prev.aheadSec = aheadSec;

      // Did the bus tracker emit a genuinely NEW GPS fix since last poll?
      const movedFromLastReal = Math.abs(prev.lastRealRem - newRealRem);
      const gpsTimeDeltaSec = gpsMs && prev.lastGpsMs ? (gpsMs - prev.lastGpsMs) / 1000 : null;
      const isSameGpsTimestamp = gpsTimeDeltaSec !== null && gpsTimeDeltaSec < 2;
      const isFreshFix =
        (gpsTimeDeltaSec !== null && gpsTimeDeltaSec >= 3) ||
        (gpsTimeDeltaSec === null && movedFromLastReal >= 8);

      // 1. Update real velocity / stopped state ONLY on genuinely fresh GPS fixes
      if (isFreshFix) {
        const dtReal =
          gpsTimeDeltaSec !== null && gpsTimeDeltaSec >= 3 && gpsTimeDeltaSec <= 180
            ? gpsTimeDeltaSec
            : Math.max(5, (nowMs - prev.lastGpsPollMs) / 1000);

        const realAdvance = prev.lastRealRem - newRealRem;
        // At terminals, GPS drift on parked vehicles can bounce 12-16m -> use a slightly higher departure threshold (20m)
        const minMoveThreshold = isAtTerminal ? 20 : 11;

        if ((realAdvance < minMoveThreshold && dtReal >= 7) || (likelyTerminalRest && realAdvance < 28)) {
          // Bus barely moved -> red light, bus stop, or terminal layover (descanso en cabecera)!
          prev.isStopped = true;
          prev.cruiseSpeedMps = 0;
          if (prev.observedSpeedMps !== null) {
            prev.observedSpeedMps = Math.max(2.2, prev.observedSpeedMps * 0.85);
          }
        } else if (realAdvance >= minMoveThreshold && realAdvance < 900) {
          const instSpeed = clamp(realAdvance / dtReal, 0.9, 10.5); // ~3 to 38 km/h urban Corrientes
          prev.observedSpeedMps =
            prev.observedSpeedMps !== null ? 0.62 * instSpeed + 0.38 * prev.observedSpeedMps : instSpeed;
          prev.cruiseSpeedMps = prev.observedSpeedMps;
          prev.isStopped = false;
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

      // 2. Smoothly reconcile position without ANY backward jumps when in Simulation Mode
      if (!applyPositions) {
        prev.activeTraj = newTraj;
        prev.walkedMeters = 0;
        prev.overshootMeters = 0;
        prev.lagMeters = 0;
        prev.deadReckonMeters = 0;
        prev.etaSecondsRemaining = bus.etaSecondsRemaining || etaSec;
        continue;
      }

      // If the tracker hasn't sent a fresh timestamp yet, keep cruising seamlessly without touching position!
      if (isSameGpsTimestamp) {
        this._applySampleToBus(bus, prev, false);
        continue;
      }

      const prevSimRem = Math.max(0, prev.activeTraj.totalMeters - prev.walkedMeters);
      const deltaRem = newRealRem - prevSimRem;
      // deltaRem > 0 => sim is AHEAD of real GPS (bus slowed down or hit a red light)
      // deltaRem < 0 => sim is BEHIND real GPS (bus accelerated after green light)

      const sameLegType = prev.activeTraj.leg === newTraj.leg;

      if (sameLegType && deltaRem >= 0 && deltaRem <= 150) {
        // Sim is ahead by up to 150 m: KEEP exact visual position on newTraj (0.0 m jump!)
        // and let the controller smoothly brake & hold until the real bus catches up.
        prev.activeTraj = newTraj;
        prev.walkedMeters = clamp(deltaRem, 0, newTraj.totalMeters);
        prev.overshootMeters = deltaRem;
        prev.lagMeters = 0;
        prev.deadReckonMeters = 0;
      } else if (sameLegType && deltaRem < 0 && -deltaRem <= 280) {
        // Sim is behind by up to 280 m: splice exact street polyline from current simulated spot
        // into the front of newTraj so the bus smoothly accelerates along the curve to catch up!
        const lag = -deltaRem;
        const spliced = prependPathToTrajectory(prev.activeTraj, prev.walkedMeters, newTraj);
        prev.activeTraj = spliced;
        prev.walkedMeters = 0;
        prev.overshootMeters = 0;
        prev.lagMeters = lag;
        prev.deadReckonMeters = 0;
      } else {
        // Large genuine discontinuity (>280 m or leg changed): re-anchor cleanly
        prev.activeTraj = newTraj;
        prev.walkedMeters = 0;
        prev.overshootMeters = 0;
        prev.lagMeters = 0;
        prev.deadReckonMeters = 0;
        prev.currentSpeedMps = Math.min(prev.currentSpeedMps, prev.cruiseSpeedMps);
      }

      // Blend ETA gently instead of abrupt jumps
      const targetEtaSec = bus.etaSecondsRemaining || etaSec;
      if (Math.abs(targetEtaSec - prev.etaSecondsRemaining) <= 180) {
        prev.etaSecondsRemaining = prev.etaSecondsRemaining * 0.4 + targetEtaSec * 0.6;
      } else {
        prev.etaSecondsRemaining = targetEtaSec;
      }

      // Immediately project reconciled position onto `bus` so `updateBuses` renders zero snap
      this._applySampleToBus(bus, prev, false);
    }

    // Prune departed buses
    for (const key of this.units.keys()) {
      if (!seen.has(key)) this.units.delete(key);
    }
  }

  /**
   * Advances all simulated buses smoothly by `dtSec` (typically ~0.033s at 30fps).
   */
  step(dtSec, buses = [], { updateEta = false } = {}) {
    const dt = clamp(dtSec, 0.005, 0.15);
    const nowMs = Date.now();

    for (const bus of buses) {
      const st = this.units.get(bus.key);
      if (!st || !st.activeTraj) continue;

      const traj = st.activeTraj;
      const silentSec = (nowMs - st.lastGpsPollMs) / 1000;

      // Conservative lookahead cap beyond the last confirmed real GPS fix:
      // 40 m before 2nd fix (so a bus stopped at a red light never runs away), up to 80 m once cruising speed is confirmed.
      const maxLookahead = st.hasConfirmedFix
        ? clamp((st.observedSpeedMps || 3.5) * 13, 42, 80)
        : 40;

      // Check if simulated bus has reached a terminal turnaround along the trajectory and should pause for layover
      const reachedTurnaround =
        (traj.turnaroundAtMeters > 40 && Math.abs(st.walkedMeters - traj.turnaroundAtMeters) < 25) ||
        (traj.oppStartMeters > 40 && Math.abs(st.walkedMeters - traj.oppStartMeters) < 25);

      let targetSpeed = 0;

      if (st.lagMeters > 3) {
        // Real bus is AHEAD of simulated marker -> smooth catch-up along street curve
        const baseCruise = st.isStopped ? 1.8 : Math.max(2.2, st.cruiseSpeedMps);
        const catchupBoost = clamp(st.lagMeters / 8.5, 0.4, 3.6);
        targetSpeed = clamp(baseCruise + catchupBoost, 1.5, 10.8);
      } else if (st.isStopped || st.overshootMeters > 6 || (reachedTurnaround && st.aheadSec >= 45)) {
        // Bus is stopped (red light / bus stop / terminal descanso), or arrived at cabecera ahead of schedule -> HOLD!
        targetSpeed = 0;
      } else {
        // Normal cruising along street polyline
        targetSpeed = st.cruiseSpeedMps;

        // Soft lookahead ceiling: smoothly taper down as deadReckonMeters nears maxLookahead without a new GPS fix
        const taperStart = maxLookahead * 0.62;
        if (st.deadReckonMeters > taperStart) {
          const ratio = clamp(1 - (st.deadReckonMeters - taperStart) / (maxLookahead - taperStart), 0, 1);
          targetSpeed *= ratio;
        }

        // Extra quiet-tracker damping if >16s since last fresh GPS packet
        if (silentSec > 16) {
          targetSpeed *= clamp(1 - (silentSec - 16) / 10, 0, 1);
        }
      }

      // Organic micro-deceleration when passing within 28 m before an intermediate bus stop
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

      // Apply realistic bus inertia (bounded acceleration & braking)
      const maxAccel = 0.85; // m/s² (gentle realistic pull-out)
      const maxBrake = 1.85; // m/s² (smooth stop without jerk)
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

      // Only decrement ETA countdown when moving
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
        bus.tiempoRaw = `${mins} min. aprox.`;
      }
      bus.proximityPct = computeProximityPercent(bus.eta.minutes, bus.routeMeters);
    }
  }
}
