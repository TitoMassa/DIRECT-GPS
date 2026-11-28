import { sampleTrajectory, prependPathToTrajectory, projectOnPolyline, buildTrajectoryFromBranchAlong } from './trajectory.js';
import { computeProximityPercent, distanceMeters, parseDesvioHorario } from './api.js';
import {
  evaluateTripState,
  getArgentinaSecOfDay,
  toServiceSec,
  buildGpsAnchorForTrip,
  formatDesvioFromSec,
  getTripLocalSpeedMps,
  getPaceAdjustedTripSpeedMps,
  projectAlongTripBySeconds,
  measureTripPaceFactor,
  GPS_SILENT_DESVIO_SEC,
  GPS_SILENT_PUNCTUAL_SEC
} from './predictor.js';

const STATIONARY_OFFLINE_THRESHOLD_SEC = GPS_SILENT_DESVIO_SEC; // 3 min (180 s): simulate using last-seen desvioHorario
const PUNCTUAL_SCHEDULE_THRESHOLD_SEC = GPS_SILENT_PUNCTUAL_SEC; // 5 min (300 s): simulate strictly punctual (00:00) on official timetable
const DEFAULT_GPS_CADENCE_SEC = 75; // Realistic median Corrientes AVL reporting interval (60–120 s)
const MIN_GPS_CADENCE_SEC = 15;
const MAX_GPS_CADENCE_SEC = 135;
const MAX_VALID_FIX_DT_SEC = 195;
const LEG_ORDER = { full_cycle: 0, previous_leg: 1, direct: 2 };

function isCompatibleLegTransition(prevLeg, newLeg) {
  if (!prevLeg || !newLeg) return false;
  if (prevLeg === newLeg) return true;
  const prevRank = LEG_ORDER[prevLeg];
  const newRank = LEG_ORDER[newLeg];
  return prevRank !== undefined && newRank !== undefined && newRank > prevRank;
}

/**
 * Parses SmartMovePro GPS timestamp ("DD/MM/YYYY HH:MM:SS" in Argentina UTC-3) into UTC epoch ms.
 */
export function parseGpsTimestampMs(raw = '') {
  const clean = String(raw || '').trim();
  const m = clean.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})$/);
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
 * Maps a trajectory position `walkedMeters` along `traj` back to its exact active scheduled trip leg
 * and `along` coordinate on that trip's branch, even across `previous_leg` / `full_cycle` or spliced paths.
 */
function resolveTrajTripCursor(scheduledTrip, stopProj, traj, walkedMeters = 0) {
  if (!scheduledTrip || !traj) return null;
  const w = Math.max(0, Number.isFinite(walkedMeters) ? walkedMeters : 0);

  if (traj.leg === 'full_cycle' && scheduledTrip.prevTrip) {
    if (w < (traj.oppStartMeters || 0) && scheduledTrip.prevTrip.prevTrip?.branch) {
      const tr = scheduledTrip.prevTrip.prevTrip;
      const totalLen = tr.branch.totalLen || 0;
      const remToOpp = Math.max(0, (traj.oppStartMeters || 0) - w);
      return { trip: tr, along: clamp(totalLen - remToOpp, 0, totalLen), maxLegAlong: totalLen };
    }
    if (w < (traj.turnaroundAtMeters || 0) && scheduledTrip.prevTrip?.branch) {
      const tr = scheduledTrip.prevTrip;
      const totalLen = tr.branch.totalLen || 0;
      const remToTurn = Math.max(0, (traj.turnaroundAtMeters || 0) - w);
      return { trip: tr, along: clamp(totalLen - remToTurn, 0, totalLen), maxLegAlong: totalLen };
    }
  } else if (traj.leg === 'previous_leg' && w < (traj.turnaroundAtMeters || 0) && scheduledTrip.prevTrip?.branch) {
    const tr = scheduledTrip.prevTrip;
    const totalLen = tr.branch.totalLen || 0;
    const remToTurn = Math.max(0, (traj.turnaroundAtMeters || 0) - w);
    return { trip: tr, along: clamp(totalLen - remToTurn, 0, totalLen), maxLegAlong: totalLen };
  }

  if (!stopProj || !scheduledTrip.branch) return null;
  const remToStop = Math.max(0, (traj.totalMeters || 0) - w);
  const along = clamp((stopProj.along || 0) - remToStop, 0, stopProj.along || scheduledTrip.branch.totalLen || 0);
  return {
    trip: scheduledTrip,
    along,
    maxLegAlong: stopProj.along || scheduledTrip.branch.totalLen || along
  };
}

/**
 * Extracts real reporting cadence (15–135 s) and freshest moving GPS fix pair from `gpsTrail` + `prevGpsFix`.
 */
function extractTrailKinematics(bus, gpsMs) {
  const rawTrail = Array.isArray(bus.gpsTrail) ? bus.gpsTrail : [];
  const pts = [];
  for (const item of rawTrail) {
    const lat = Number(Array.isArray(item) ? item[0] : item?.lat);
    const lng = Number(Array.isArray(item) ? item[1] : item?.lng);
    const ms = Number(Array.isArray(item) ? item[2] : item?.gpsMs);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0)) continue;
    if (!Number.isFinite(ms) || ms <= 0) continue;
    pts.push({ lat, lng, gpsMs: ms });
  }
  if (
    bus.prevGpsFix &&
    typeof bus.prevGpsFix.lat === 'number' &&
    typeof bus.prevGpsFix.lng === 'number' &&
    typeof bus.prevGpsFix.gpsMs === 'number'
  ) {
    if (!pts.some((p) => Math.abs(p.gpsMs - bus.prevGpsFix.gpsMs) < 2000)) {
      pts.push({ lat: bus.prevGpsFix.lat, lng: bus.prevGpsFix.lng, gpsMs: bus.prevGpsFix.gpsMs });
    }
  }
  if (typeof bus.lat === 'number' && typeof bus.lng === 'number' && typeof gpsMs === 'number') {
    if (!pts.some((p) => Math.abs(p.gpsMs - gpsMs) < 2000)) {
      pts.push({ lat: bus.lat, lng: bus.lng, gpsMs });
    }
  }
  pts.sort((a, b) => a.gpsMs - b.gpsMs);

  const dts = [];
  let latestMovingPair = null;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const dt = (b.gpsMs - a.gpsMs) / 1000;
    if (dt < 5 || dt > MAX_VALID_FIX_DT_SEC) continue;
    dts.push(dt);
    const moved = distanceMeters(a.lat, a.lng, b.lat, b.lng) ?? 0;
    const maxPlausible = Math.max(2200, dt * 30);
    if (moved >= 11 && moved < maxPlausible) {
      latestMovingPair = { prev: a, cur: b, dt, moved };
    }
  }

  let cadence = null;
  if (dts.length > 0) {
    const recent = dts.slice(-4).sort((a, b) => a - b);
    cadence = clamp(recent[Math.floor(recent.length / 2)], MIN_GPS_CADENCE_SEC, MAX_GPS_CADENCE_SEC);
  }
  return { cadence, latestMovingPair };
}

function measurePairPaceFactor(activeTrip, lat1, lng1, lat2, lng2, dtSec) {
  if (!activeTrip?.branch?.pts?.length || dtSec < 6 || dtSec > MAX_VALID_FIX_DT_SEC) return null;
  const p1 = projectOnPolyline(activeTrip.branch.pts, activeTrip.branch.cum, lat1, lng1);
  const p2 = projectOnPolyline(activeTrip.branch.pts, activeTrip.branch.cum, lat2, lng2);
  if (!p1 || !p2 || p1.perp > 165 || p2.perp > 165) return null;
  if (p2.along - p1.along < 18) return null;
  return measureTripPaceFactor(activeTrip, p1.along, p2.along, dtSec);
}

/**
 * Estimates initial cruising speed, cadence, and schedule pace factor on first sight using:
 *  1. Direct penultimate -> latest GPS fix (and multi-point `gpsTrail`) over 4–195 s intervals
 *  2. Local scheduled segment speed along the matched timetable trip (exact corridor + hour speed)
 *  3. Direct route-distance / ETA ratio (avoiding turnaround-layover deflation on indirect legs)
 */
function estimateInitialKinematics(bus, newTraj, stopId, nowSec, gpsMs, etaSec, aheadSec, isAtTerminal, gpsAgeSec) {
  if (isAtTerminal) {
    return { cruise: 0, observedSpeed: null, paceFactor: 1.0, cadence: null, hasConfirmed: false, isStopped: true };
  }

  const cursor0 = resolveTrajTripCursor(bus.scheduledTrip, bus.stopProj, newTraj, 0);
  const activeTrip = cursor0?.trip || null;
  const localSchedV = cursor0 ? getTripLocalSpeedMps(cursor0.trip, cursor0.along) : null;
  const trailKin = extractTrailKinematics(bus, gpsMs);

  // 1) Check direct penultimate -> latest fix first (preserves true stopped-bus detection!)
  const prevFix = bus.prevGpsFix;
  if (
    prevFix &&
    typeof prevFix.lat === 'number' &&
    typeof prevFix.lng === 'number' &&
    typeof prevFix.gpsMs === 'number' &&
    typeof gpsMs === 'number'
  ) {
    const dtPrev = (gpsMs - prevFix.gpsMs) / 1000;
    if (dtPrev >= 4 && dtPrev <= MAX_VALID_FIX_DT_SEC) {
      const moved = distanceMeters(prevFix.lat, prevFix.lng, bus.lat, bus.lng) ?? 0;
      const learnedCadence = trailKin.cadence ?? clamp(dtPrev, MIN_GPS_CADENCE_SEC, MAX_GPS_CADENCE_SEC);
      if (moved < 11 && dtPrev >= 8) {
        return {
          cruise: 0,
          observedSpeed: null,
          paceFactor: 1.0,
          cadence: learnedCadence,
          hasConfirmed: true,
          isStopped: true
        };
      }
      const maxPlausible = Math.max(2200, dtPrev * 30);
      if (moved >= 11 && moved < maxPlausible) {
        const inst = clamp((moved * 1.03) / dtPrev, 1.2, 26.0);
        const pace = measurePairPaceFactor(activeTrip, prevFix.lat, prevFix.lng, bus.lat, bus.lng, dtPrev) ?? 1.0;
        const localCruise =
          cursor0 && localSchedV !== null
            ? getPaceAdjustedTripSpeedMps(cursor0.trip, cursor0.along, pace) ?? inst
            : inst;
        return {
          cruise: localCruise,
          observedSpeed: inst,
          paceFactor: pace,
          cadence: learnedCadence,
          hasConfirmed: true,
          isStopped: false
        };
      }
    }
  }

  // 1b) Multi-point gpsTrail fallback (e.g. cold start hydrated from server FleetMemory!)
  if (trailKin.latestMovingPair && gpsAgeSec < 175) {
    const mp = trailKin.latestMovingPair;
    const inst = clamp((mp.moved * 1.03) / mp.dt, 1.2, 26.0);
    const pace = measurePairPaceFactor(activeTrip, mp.prev.lat, mp.prev.lng, mp.cur.lat, mp.cur.lng, mp.dt) ?? 1.0;
    const localCruise =
      cursor0 && localSchedV !== null
        ? getPaceAdjustedTripSpeedMps(cursor0.trip, cursor0.along, pace) ?? inst
        : inst;
    return {
      cruise: localCruise,
      observedSpeed: inst,
      paceFactor: pace,
      cadence: trailKin.cadence,
      hasConfirmed: true,
      isStopped: false
    };
  }

  // Only treat an unmatched bus as stale-stopped if GPS is near/past the 3-min offline threshold
  if (gpsAgeSec >= 175 && !bus.scheduledTrip) {
    return { cruise: 0, observedSpeed: null, paceFactor: 1.0, cadence: trailKin.cadence, hasConfirmed: false, isStopped: true };
  }

  // 2) Local scheduled segment speed along the matched trip (distinguishes downtown vs avenue vs bridge!)
  if (localSchedV !== null) {
    return {
      cruise: clamp(localSchedV, 2.2, 20.0),
      observedSpeed: null,
      paceFactor: 1.0,
      cadence: trailKin.cadence,
      hasConfirmed: false,
      isStopped: false
    };
  }

  if (bus.scheduledTrip && bus.stopProj) {
    const ev = evaluateTripState(bus.scheduledTrip, stopId, bus.stopProj, nowSec, aheadSec, {
      maxAheadSec: 240 * 60
    });
    if (ev && !ev.isAtTerminal && ev.speedMps > 1.2) {
      return {
        cruise: clamp(ev.speedMps, 2.4, 20.0),
        observedSpeed: null,
        paceFactor: 1.0,
        cadence: trailKin.cadence,
        hasConfirmed: false,
        isStopped: false
      };
    }
  }

  // 3) Direct route-distance / ETA ratio (on indirect legs ETA includes terminal layover, so use urban default)
  const fallbackSpd =
    newTraj.leg === 'direct'
      ? clamp(newTraj.totalMeters / Math.max(45, etaSec), 3.0, 16.0)
      : 4.8;

  return {
    cruise: fallbackSpd,
    observedSpeed: null,
    paceFactor: 1.0,
    cadence: trailKin.cadence,
    hasConfirmed: false,
    isStopped: false
  };
}

/**
 * Computes how many meters along `traj` a moving bus has already progressed between its GPS timestamp
 * (`ultimaFechaHoraGPS`) and current wall-clock time `nowMs`, integrating over the corridor's local
 * pace-adjusted speed profile so 60–120 s AVL gaps stay synchronized with physical street position.
 */
function computeAgeAdvanceMeters(stateSpec, traj, gpsAgeSec, { isColdStart = false } = {}) {
  if (!traj || !stateSpec || stateSpec.isStopped || stateSpec.isAtTerminal) return 0;
  if (!Number.isFinite(gpsAgeSec) || gpsAgeSec <= 0.5 || gpsAgeSec >= 178) return 0;

  const cadence = clamp(stateSpec.observedGpsIntervalSec || DEFAULT_GPS_CADENCE_SEC, MIN_GPS_CADENCE_SEC, MAX_GPS_CADENCE_SEC);
  const maxCompSec = clamp(Math.max(cadence * 1.25, 120), 120, 165);
  const confidence = stateSpec.hasConfirmedFix ? 1.0 : 0.88;
  const effAgeSec = Math.min(gpsAgeSec, maxCompSec) * confidence;
  if (effAgeSec <= 0.5) return 0;

  // Never project a bus across a cabecera layover or past the stop pin on first sight
  let maxAdvance = traj.totalMeters;
  if (traj.leg === 'direct') {
    const stopMargin = isColdStart ? (traj.totalMeters > 25 ? 18 : Math.min(6, traj.totalMeters * 0.25)) : 0;
    maxAdvance = Math.max(0, traj.totalMeters - stopMargin);
  } else if (traj.turnaroundAtMeters > 40 && (stateSpec.aheadSec || 0) >= 30) {
    maxAdvance = Math.max(0, traj.turnaroundAtMeters - 20);
  } else if (traj.oppStartMeters > 40 && (stateSpec.aheadSec || 0) >= 30) {
    maxAdvance = Math.max(0, traj.oppStartMeters - 20);
  }
  if (maxAdvance <= 0.5) return 0;

  const cursor = resolveTrajTripCursor(stateSpec.scheduledTrip, stateSpec.stopProj, traj, 0);
  if (cursor) {
    const proj = projectAlongTripBySeconds(
      cursor.trip,
      cursor.along,
      effAgeSec,
      stateSpec.paceFactor || 1.0,
      cursor.maxLegAlong
    );
    if (proj && Number.isFinite(proj.deltaMeters)) {
      return clamp(proj.deltaMeters, 0, maxAdvance);
    }
  }

  const fallbackSpd = stateSpec.observedSpeedMps || stateSpec.cruiseSpeedMps || 4.8;
  return clamp(fallbackSpd * effAgeSec, 0, maxAdvance);
}

/**
 * Physically-faithful, time-compensated, zero-backjump kinematic vehicle predictor for EN VIVO mode.
 *
 * Operating rules:
 *  - 'gps': compensates every GPS fix for its real timestamp age (`now - ultimaFechaHoraGPS`) using
 *    each corridor's stop-by-stop timetable speed profile scaled by the bus's real-time observed pace
 *    factor (`paceFactor`) from `gpsTrail` / consecutive fixes, adapts dead-reckoning envelopes to real
 *    Corrientes AVL reporting cadences (15–135 s), avoids false overshoot braking from GPS pipeline delay,
 *    and smoothly splices forward lag with zero teleports. If a live GPS bus stays stationary (<20 m)
 *    at a non-cabecera spot, it transitions seamlessly at 3 minutes (180 s) to predicted schedule mode.
 *  - 'schedule': tracks the official stop-by-stop timetable anchored to the bus's exact visual/GPS
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

  _getVisualLatLng(st) {
    if (!st) return null;
    if (st.correctionGlide?.type === 'latlng' && Number.isFinite(st.correctionGlide.curLat)) {
      return { lat: st.correctionGlide.curLat, lng: st.correctionGlide.curLng };
    }
    if (st.activeTraj) {
      const s = sampleTrajectory(st.activeTraj, st.walkedMeters || 0);
      if (s && Number.isFinite(s.lat) && Number.isFinite(s.lng)) return { lat: s.lat, lng: s.lng };
    }
    if (Number.isFinite(st.lastRealLat) && Number.isFinite(st.lastRealLng)) {
      return { lat: st.lastRealLat, lng: st.lastRealLng };
    }
    return null;
  }

  _buildTrajFromEval(scheduledTrip, stopProj, ev, fallbackTraj) {
    if (!scheduledTrip?.branch || !stopProj || !ev?.activeBranch) return fallbackTraj;
    const built = buildTrajectoryFromBranchAlong(
      ev.activeBranch,
      ev.activeAlong,
      scheduledTrip.branch,
      stopProj,
      {
        isAtTerminal: Boolean(ev.isAtTerminal),
        etaSec: ev.etaSec,
        viaBranch: ev.viaBranch || null
      }
    );
    return built || fallbackTraj;
  }

  /**
   * Starts a crisp, smooth, high-precision ease-out glide (~0.65–1.45 s) from the marker's
   * current visual position to `targetWalked` on `newTraj`.
   *  - When `(fromLat, fromLng)` lies near `newTraj`, glides along the exact street polyline
   *    (forward OR backward) so the bus follows curves & corners cleanly.
   *  - When transitioning across branches/legs, glides smoothly in lat/lng directly onto the
   *    moving target point on `newTraj`, landing with 0.0 m error.
   */
  _startCorrectionGlide(st, newTraj, targetWalked, { fromLat, fromLng, followSpeed = 0 } = {}) {
    if (!st || !newTraj) return;
    const clampedTarget = clamp(Number.isFinite(targetWalked) ? targetWalked : 0, 0, newTraj.totalMeters);
    const targetPt = sampleTrajectory(newTraj, clampedTarget);
    if (!targetPt || !Number.isFinite(fromLat) || !Number.isFinite(fromLng)) {
      st.activeTraj = newTraj;
      st.walkedMeters = clampedTarget;
      st.gpsOriginWalkedMeters = 0;
      st.overshootMeters = 0;
      st.lagMeters = 0;
      st.deadReckonMeters = clampedTarget;
      st.correctionGlide = null;
      return;
    }

    const corrDist = distanceMeters(fromLat, fromLng, targetPt.lat, targetPt.lng) ?? 0;
    if (corrDist < 6) {
      st.activeTraj = newTraj;
      st.walkedMeters = clampedTarget;
      st.gpsOriginWalkedMeters = 0;
      st.overshootMeters = 0;
      st.lagMeters = 0;
      st.deadReckonMeters = clampedTarget;
      st.correctionGlide = null;
      return;
    }

    const safeFollow = Math.max(0, Math.min(20, Number.isFinite(followSpeed) ? followSpeed : 0));
    const proj =
      Array.isArray(newTraj.pathPts) && newTraj.pathPts.length >= 2
        ? projectOnPolyline(newTraj.pathPts, newTraj.pathCum, fromLat, fromLng)
        : null;

    const prevTraj = st.activeTraj;
    const prevWalked = st.walkedMeters || 0;
    const prevRem = prevTraj ? Math.max(0, prevTraj.totalMeters - prevWalked) : 0;
    const targetRem = Math.max(0, newTraj.totalMeters - clampedTarget);
    const canSpliceForward =
      (!proj || proj.perp > 55) &&
      prevTraj &&
      isCompatibleLegTransition(prevTraj.leg, newTraj.leg) &&
      prevRem > targetRem + 10 &&
      prevRem - targetRem <= 3200;

    if (canSpliceForward) {
      const spliced = prependPathToTrajectory(prevTraj, prevWalked, newTraj);
      if (spliced && spliced.totalMeters > newTraj.totalMeters) {
        const spliceTarget = clamp(spliced.totalMeters - newTraj.totalMeters + clampedTarget, 0, spliced.totalMeters);
        const dur = clamp(0.65 + spliceTarget / 1100, 0.65, 1.45);
        st.activeTraj = spliced;
        st.walkedMeters = 0;
        st.gpsOriginWalkedMeters = Math.max(0, spliced.totalMeters - newTraj.totalMeters);
        st.overshootMeters = 0;
        st.lagMeters = 0;
        st.deadReckonMeters = 0;
        st.correctionGlide = {
          type: 'along',
          fromAlong: 0,
          targetAlong: spliceTarget,
          elapsedSec: 0,
          durationSec: dur,
          followSpeed: safeFollow
        };
        return;
      }
    }

    st.activeTraj = newTraj;
    st.gpsOriginWalkedMeters = 0;
    st.overshootMeters = 0;
    st.lagMeters = 0;

    if (proj && proj.perp <= 55) {
      const fromAlong = clamp(proj.along, 0, newTraj.totalMeters);
      const alongDist = Math.abs(clampedTarget - fromAlong);
      const dur = clamp(0.65 + alongDist / 1100, 0.65, 1.45);
      st.walkedMeters = fromAlong;
      st.deadReckonMeters = fromAlong;
      st.correctionGlide = {
        type: 'along',
        fromAlong,
        targetAlong: clampedTarget,
        elapsedSec: 0,
        durationSec: dur,
        followSpeed: safeFollow
      };
    } else {
      const dur = clamp(0.68 + corrDist / 1200, 0.70, 1.35);
      st.walkedMeters = clampedTarget;
      st.deadReckonMeters = clampedTarget;
      st.correctionGlide = {
        type: 'latlng',
        fromLat,
        fromLng,
        targetAlong: clampedTarget,
        elapsedSec: 0,
        durationSec: dur,
        followSpeed: safeFollow,
        curLat: fromLat,
        curLng: fromLng
      };
    }
  }

  _stepCorrectionGlide(st, dt, bus, updateEta) {
    const g = st.correctionGlide;
    if (!g || !st.activeTraj) return false;

    g.elapsedSec += dt;
    const u = clamp(g.elapsedSec / Math.max(0.15, g.durationSec), 0, 1);
    const eased = 1 - Math.pow(1 - u, 3);
    const liveTargetAlong = clamp(g.targetAlong + g.followSpeed * g.elapsedSec, 0, st.activeTraj.totalMeters);

    if (g.type === 'along') {
      st.walkedMeters = clamp(g.fromAlong + (liveTargetAlong - g.fromAlong) * eased, 0, st.activeTraj.totalMeters);
      st.deadReckonMeters = Math.max(0, st.walkedMeters - (st.gpsOriginWalkedMeters || 0));
    } else {
      st.walkedMeters = liveTargetAlong;
      const tp = sampleTrajectory(st.activeTraj, liveTargetAlong);
      if (tp) {
        g.curLat = g.fromLat + (tp.lat - g.fromLat) * eased;
        g.curLng = g.fromLng + (tp.lng - g.fromLng) * eased;
      }
    }

    if (g.followSpeed > 0.35) {
      st.etaSecondsRemaining = Math.max(0, st.etaSecondsRemaining - dt);
    }

    if (u >= 1) {
      st.walkedMeters = liveTargetAlong;
      st.deadReckonMeters = liveTargetAlong;
      st.currentSpeedMps = g.followSpeed;
      st.correctionGlide = null;
    }

    this._applySampleToBus(bus, st, updateEta);
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
        const predGpsMs =
          bus.predLastGpsMs ??
          parseGpsTimestampMs(bus.ultimaFechaHoraGPS || '') ??
          prev?.lastGpsMs ??
          null;
        const predSilentSec = predGpsMs ? Math.max(0, (nowMs - predGpsMs) / 1000) : PUNCTUAL_SCHEDULE_THRESHOLD_SEC;
        const isPunctual = Boolean(bus.predPunctualSchedule) || predSilentSec >= PUNCTUAL_SCHEDULE_THRESHOLD_SEC;
        const desvioSec = isPunctual ? 0 : (bus.predDesvioSec || bus.desvio?.seconds || 0);
        const incomingAnchor = isPunctual ? null : (bus.predAnchor || null);
        bus.gpsPunctualFallback = isPunctual;

        if (!prev) {
          const initSpeed = newTraj.isAtTerminal ? 0 : clamp(newTraj.speedMps || 4.8, 0, 22.0);
          this.units.set(bus.key, {
            mode: 'schedule',
            schedulePunctual: isPunctual,
            scheduledTrip: bus.scheduledTrip,
            stopProj: bus.stopProj,
            stopId: stopId || bus.stopId || '',
            predDesvioSec: desvioSec,
            lastSeenDesvioSec: desvioSec,
            scheduleAnchor: incomingAnchor,
            correctionGlide: null,
            anchorLat: bus.lat,
            anchorLng: bus.lng,
            stationarySinceMs: predGpsMs,
            lastGpsMs: predGpsMs,
            lastGpsPollMs: nowMs,
            lastRealRem: newRealRem,
            lastRealLat: bus.lat,
            lastRealLng: bus.lng,
            lastRealLeg: newTraj.leg,
            observedGpsIntervalSec: null,
            hasConfirmedFix: false,
            observedSpeedMps: null,
            paceFactor: 1.0,
            cruiseSpeedMps: initSpeed,
            currentSpeedMps: initSpeed,
            isStopped: newTraj.isAtTerminal,
            isAtTerminal: Boolean(newTraj.isAtTerminal),
            aheadSec: desvioSec,
            overshootMeters: 0,
            lagMeters: 0,
            deadReckonMeters: 0,
            gpsOriginWalkedMeters: 0,
            lastApplyPositions: applyPositions,
            activeTraj: newTraj,
            walkedMeters: 0,
            etaSecondsRemaining: etaSec
          });
          continue;
        }

        // Transitioning smoothly (already 'schedule' OR just handed off from a live GPS unit that vanished!)
        const wasLiveGps = prev.mode === 'gps';
        const justBecamePunctual = !prev.schedulePunctual && isPunctual;
        const prevVisual = (justBecamePunctual || wasLiveGps) ? this._getVisualLatLng(prev) : null;

        prev.mode = 'schedule';
        prev.schedulePunctual = isPunctual;
        prev.scheduledTrip = bus.scheduledTrip;
        prev.stopProj = bus.stopProj;
        prev.stopId = stopId || bus.stopId || prev.stopId || '';
        prev.predDesvioSec = desvioSec;
        if (predGpsMs && !prev.lastGpsMs) prev.lastGpsMs = predGpsMs;
        prev.isAtTerminal = Boolean(newTraj.isAtTerminal);
        prev.aheadSec = desvioSec;
        prev.lastApplyPositions = applyPositions;
        if (prev.isAtTerminal) {
          prev.isStopped = true;
          prev.currentSpeedMps = 0;
        }

        if (isPunctual) {
          prev.scheduleAnchor = null;
        } else if (wasLiveGps) {
          // 3–5 min window handoff: keep last-seen desvio cleanly without snapping backward
          const curSample = prevVisual || sampleTrajectory(prev.activeTraj, prev.walkedMeters);
          const aLat = curSample?.lat ?? prev.anchorLat ?? bus.lat;
          const aLng = curSample?.lng ?? prev.anchorLng ?? bus.lng;
          const prevFix =
            typeof prev.lastRealLat === 'number' && typeof prev.lastRealLng === 'number'
              ? { lat: prev.lastRealLat, lng: prev.lastRealLng }
              : null;
          prev.scheduleAnchor =
            buildGpsAnchorForTrip(bus.scheduledTrip, aLat, aLng, nowSec, desvioSec, {
              prevFix,
              preferredLeg: prev.lastRealLeg || prev.activeTraj?.leg || null
            }) || incomingAnchor;
        } else if (incomingAnchor && !prev.scheduleAnchor) {
          prev.scheduleAnchor = incomingAnchor;
        }
        if (prev.scheduleAnchor?.atOriginTerminal && toServiceSec(nowSec) < (bus.scheduledTrip.startSec || 0)) {
          prev.isAtTerminal = true;
          prev.isStopped = true;
          prev.currentSpeedMps = 0;
        }

        if (!applyPositions) {
          prev.activeTraj = newTraj;
          prev.walkedMeters = 0;
          prev.gpsOriginWalkedMeters = 0;
          prev.correctionGlide = null;
          prev.etaSecondsRemaining = etaSec;
          continue;
        }

        if (justBecamePunctual) {
          this._startCorrectionGlide(prev, newTraj, 0, {
            fromLat: prevVisual?.lat,
            fromLng: prevVisual?.lng,
            followSpeed: newTraj.isAtTerminal ? 0 : clamp(newTraj.speedMps || 4.8, 0, 20)
          });
          prev.etaSecondsRemaining = etaSec;
          this._applySampleToBus(bus, prev, false);
          continue;
        }

        if (prev.correctionGlide) {
          prev.etaSecondsRemaining = etaSec;
          this._applySampleToBus(bus, prev, false);
          continue;
        }

        const prevSimRem = Math.max(0, prev.activeTraj.totalMeters - prev.walkedMeters);
        const deltaRem = newRealRem - prevSimRem;
        const compatibleLeg = isCompatibleLegTransition(prev.activeTraj.leg, newTraj.leg);

        if (!compatibleLeg || Math.abs(deltaRem) > 260) {
          if (compatibleLeg && deltaRem < 0 && -deltaRem <= 950) {
            prev.activeTraj = prependPathToTrajectory(prev.activeTraj, prev.walkedMeters, newTraj);
            prev.walkedMeters = 0;
            prev.gpsOriginWalkedMeters = 0;
          } else {
            const vis = this._getVisualLatLng(prev);
            this._startCorrectionGlide(prev, newTraj, 0, {
              fromLat: vis?.lat,
              fromLng: vis?.lng,
              followSpeed: newTraj.isAtTerminal ? 0 : clamp(newTraj.speedMps || 4.8, 0, 20)
            });
          }
        }

        prev.etaSecondsRemaining = etaSec;
        this._applySampleToBus(bus, prev, false);
        continue;
      }

      // ── Case 2: Live GPS unit ──
      const gpsRaw = String(bus.ultimaFechaHoraGPS || '').trim();
      const gpsMs = parseGpsTimestampMs(gpsRaw);
      const rawAgeSec = gpsMs ? (nowMs - gpsMs) / 1000 : 0;
      const gpsAgeSec = rawAgeSec >= 0 ? Math.min(rawAgeSec, 86400) : 0;

      const isAtTerminal = Boolean(newTraj.isAtTerminal);
      const hasExplicitDesvio = Boolean(bus.desvio && bus.desvio.status && bus.desvio.status !== 'none');
      const aheadSec = hasExplicitDesvio ? (bus.desvio.seconds || 0) : 0;
      const likelyTerminalRest = isAtTerminal && aheadSec >= 60;

      if (!prev) {
        const initKin = estimateInitialKinematics(
          bus,
          newTraj,
          stopId || bus.stopId || '',
          nowSec,
          gpsMs,
          etaSec,
          aheadSec,
          isAtTerminal,
          gpsAgeSec
        );
        const initialStationarySince =
          gpsMs && gpsMs < nowMs && nowMs - gpsMs < 86400000 ? gpsMs : nowMs;
        const canUseSchedule = applyPositions && Boolean(bus.scheduledTrip && bus.stopProj);
        const alreadyPunctual5Min = canUseSchedule && gpsAgeSec >= PUNCTUAL_SCHEDULE_THRESHOLD_SEC;
        const alreadyDesvio3Min =
          canUseSchedule && !alreadyPunctual5Min && !isAtTerminal && gpsAgeSec >= STATIONARY_OFFLINE_THRESHOLD_SEC;
        const alreadyFrozen = alreadyPunctual5Min || alreadyDesvio3Min;

        let initAnchor = null;
        let initTraj = newTraj;
        let initSchedDesvio = alreadyPunctual5Min ? 0 : aheadSec;
        let initSpeedNow = alreadyFrozen || initKin.isStopped ? 0 : initKin.cruise;
        let initEtaSec = etaSec;

        if (alreadyPunctual5Min) {
          // >= 5 min without GPS update: strictly follow official stop-by-stop timetable as 100% punctual (00:00)
          const evP = evaluateTripState(bus.scheduledTrip, stopId || bus.stopId || '', bus.stopProj, nowSec, 0, {
            maxAheadSec: 240 * 60,
            anchor: null
          });
          if (evP) {
            initTraj = this._buildTrajFromEval(bus.scheduledTrip, bus.stopProj, evP, newTraj);
            initSpeedNow = evP.isAtTerminal ? 0 : clamp(evP.speedMps, 0, 22.0);
            initEtaSec = evP.etaSec;
          }
        } else if (alreadyDesvio3Min) {
          // 3–5 min without GPS update: simulate using last-seen desvioHorario (or real GPS-timestamp anchor if none)
          if (!hasExplicitDesvio) {
            const gpsClockSec = gpsMs ? getArgentinaSecOfDay(new Date(gpsMs)) : nowSec;
            initAnchor = buildGpsAnchorForTrip(bus.scheduledTrip, bus.lat, bus.lng, gpsClockSec, 0, {
              prevFix: bus.prevGpsFix || null,
              preferredLeg: newTraj.leg || null
            });
          }
          const evD = evaluateTripState(
            bus.scheduledTrip,
            stopId || bus.stopId || '',
            bus.stopProj,
            nowSec,
            initSchedDesvio,
            { maxAheadSec: 240 * 60, anchor: initAnchor }
          );
          if (evD) {
            initTraj = this._buildTrajFromEval(bus.scheduledTrip, bus.stopProj, evD, newTraj);
            initSpeedNow = evD.isAtTerminal ? 0 : clamp(evD.speedMps, 0, 22.0);
            initEtaSec = evD.etaSec;
          }
        }

        const entry = {
          mode: alreadyFrozen ? 'schedule' : 'gps',
          schedulePunctual: alreadyPunctual5Min,
          scheduledTrip: bus.scheduledTrip || null,
          stopProj: bus.stopProj || null,
          stopId: stopId || bus.stopId || '',
          predDesvioSec: initSchedDesvio,
          lastSeenDesvioSec: aheadSec,
          hasLastSeenDesvio: hasExplicitDesvio,
          scheduleAnchor: initAnchor,
          correctionGlide: null,
          anchorLat: bus.lat,
          anchorLng: bus.lng,
          stationarySinceMs: initialStationarySince,
          lastGpsMs: gpsMs,
          lastGpsRaw: gpsRaw,
          lastGpsPollMs: nowMs,
          lastRealRem: newRealRem,
          lastRealLat: bus.lat,
          lastRealLng: bus.lng,
          lastRealLeg: newTraj.leg,
          observedGpsIntervalSec: initKin.cadence,
          hasConfirmedFix: initKin.hasConfirmed,
          observedSpeedMps: initKin.observedSpeed,
          paceFactor: initKin.paceFactor || 1.0,
          cruiseSpeedMps: initKin.cruise,
          currentSpeedMps: initSpeedNow,
          isStopped: !alreadyFrozen && initKin.isStopped,
          isAtTerminal: alreadyFrozen ? Boolean(initTraj.isAtTerminal) : isAtTerminal,
          aheadSec,
          overshootMeters: 0,
          lagMeters: 0,
          deadReckonMeters: 0,
          gpsOriginWalkedMeters: 0,
          lastApplyPositions: applyPositions,
          activeTraj: initTraj,
          walkedMeters: 0,
          etaSecondsRemaining: initEtaSec
        };

        // Immediately compensate GPS timestamp age on Frame 1 so a 45–110 s old fix starts where the bus is NOW!
        if (applyPositions && !alreadyFrozen && !entry.isStopped) {
          const initAgeAdvance = computeAgeAdvanceMeters(entry, newTraj, gpsAgeSec, { isColdStart: true });
          if (initAgeAdvance > 0) {
            entry.walkedMeters = initAgeAdvance;
            entry.deadReckonMeters = initAgeAdvance;
            const curAtNow = resolveTrajTripCursor(entry.scheduledTrip, entry.stopProj, newTraj, initAgeAdvance);
            const vAtNow = curAtNow ? getPaceAdjustedTripSpeedMps(curAtNow.trip, curAtNow.along, entry.paceFactor) : null;
            if (vAtNow !== null) {
              entry.cruiseSpeedMps = vAtNow;
              entry.currentSpeedMps = vAtNow;
            }
          }
          const ageEtaTrim = Math.min(gpsAgeSec, Math.max(0, etaSec - 25));
          let initEta = Math.max(15, etaSec - ageEtaTrim);
          const remAfterAge = Math.max(0, newRealRem - entry.walkedMeters);
          if (newTraj.leg === 'direct' && remAfterAge < 600 && entry.cruiseSpeedMps > 2.0) {
            const kinEta = remAfterAge / entry.cruiseSpeedMps;
            initEta = initEta * 0.45 + kinEta * 0.55;
          }
          entry.etaSecondsRemaining = Math.max(10, initEta);
          this._applySampleToBus(bus, entry, true);
        } else if (alreadyFrozen) {
          this._applySampleToBus(bus, entry, false);
        }

        bus.gpsLost = alreadyFrozen;
        bus.gpsPunctualFallback = alreadyPunctual5Min;
        this.units.set(bus.key, entry);
        continue;
      }

      const justEnabledSim = !prev.lastApplyPositions && applyPositions;
      prev.lastApplyPositions = applyPositions;
      prev.isAtTerminal = isAtTerminal;
      prev.aheadSec = aheadSec;
      if (gpsAgeSec < STATIONARY_OFFLINE_THRESHOLD_SEC && hasExplicitDesvio) {
        prev.lastSeenDesvioSec = aheadSec;
        prev.hasLastSeenDesvio = true;
      }
      if (bus.scheduledTrip && bus.stopProj) {
        prev.scheduledTrip = bus.scheduledTrip;
        prev.stopProj = bus.stopProj;
        prev.stopId = stopId || bus.stopId || prev.stopId || '';
      }

      // Track genuine spatial displacement from anchor (>= 20 m resets the 3-minute stationary timer),
      // and reset timer immediately if a fresh GPS timestamp arrives after an offline blackout (>= 3 min gap).
      const distFromAnchor =
        typeof prev.anchorLat === 'number' && typeof prev.anchorLng === 'number'
          ? distanceMeters(prev.anchorLat, prev.anchorLng, bus.lat, bus.lng) ?? 0
          : 999;
      const gpsReturnedAfterGap = Boolean(
        gpsMs &&
          prev.lastGpsMs &&
          gpsMs > prev.lastGpsMs &&
          gpsAgeSec < STATIONARY_OFFLINE_THRESHOLD_SEC &&
          gpsMs - prev.lastGpsMs >= STATIONARY_OFFLINE_THRESHOLD_SEC * 1000
      );

      if (distFromAnchor >= 20 || gpsReturnedAfterGap) {
        prev.anchorLat = bus.lat;
        prev.anchorLng = bus.lng;
        prev.stationarySinceMs = nowMs;
        prev.scheduleAnchor = null;
      } else if (prev.stationarySinceMs === null) {
        prev.stationarySinceMs = gpsMs && gpsMs < nowMs && nowMs - gpsMs < 86400000 ? gpsMs : nowMs;
      }

      const stationarySec = prev.stationarySinceMs !== null ? (nowMs - prev.stationarySinceMs) / 1000 : 0;
      const silentSec = isAtTerminal ? gpsAgeSec : Math.max(gpsAgeSec, stationarySec);

      // Two-tier GPS silence policy in EN VIVO mode:
      //  - 3–5 min (`180 <= silentSec < 300`, outside cabeceras): simulate using last-seen desvioHorario
      //  - >= 5 min (`silentSec >= 300`): strictly follow official stop-by-stop timetable as 100% punctual (00:00)
      const canUseSchedule = applyPositions && Boolean(bus.scheduledTrip && bus.stopProj);
      const usePunctualSchedule = canUseSchedule && silentSec >= PUNCTUAL_SCHEDULE_THRESHOLD_SEC;
      const useDesvioSchedule =
        canUseSchedule && !usePunctualSchedule && !isAtTerminal && silentSec >= STATIONARY_OFFLINE_THRESHOLD_SEC;

      if (usePunctualSchedule) {
        const justEnteredPunctual = prev.mode !== 'schedule' || !prev.schedulePunctual;
        const vis = justEnteredPunctual ? this._getVisualLatLng(prev) : null;
        prev.mode = 'schedule';
        prev.schedulePunctual = true;
        prev.predDesvioSec = 0;
        prev.scheduleAnchor = null;
        bus.gpsLost = true;
        bus.gpsPunctualFallback = true;

        if (justEnteredPunctual) {
          const evP = evaluateTripState(bus.scheduledTrip, prev.stopId, bus.stopProj, nowSec, 0, {
            maxAheadSec: 240 * 60,
            anchor: null
          });
          if (evP) {
            const pTraj = this._buildTrajFromEval(bus.scheduledTrip, bus.stopProj, evP, newTraj);
            this._startCorrectionGlide(prev, pTraj, 0, {
              fromLat: vis?.lat,
              fromLng: vis?.lng,
              followSpeed: evP.isAtTerminal ? 0 : clamp(evP.speedMps, 0, 20)
            });
            prev.etaSecondsRemaining = evP.etaSec;
          }
        }
        this._applySampleToBus(bus, prev, false);
        continue;
      }

      if (useDesvioSchedule) {
        const justEnteredDesvio = prev.mode !== 'schedule' || prev.schedulePunctual;
        const lastDesvio = hasExplicitDesvio ? aheadSec : (prev.lastSeenDesvioSec || 0);
        const hasKnownDesvio = hasExplicitDesvio || Boolean(prev.hasLastSeenDesvio);
        const vis = justEnteredDesvio ? this._getVisualLatLng(prev) : null;

        prev.mode = 'schedule';
        prev.schedulePunctual = false;
        prev.predDesvioSec = lastDesvio;
        bus.gpsLost = true;
        bus.gpsPunctualFallback = false;

        if (justEnteredDesvio) {
          if (hasKnownDesvio) {
            // 3–5 min window: simulate strictly with last-seen desvioHorario
            prev.scheduleAnchor = null;
            const evD = evaluateTripState(bus.scheduledTrip, prev.stopId, bus.stopProj, nowSec, lastDesvio, {
              maxAheadSec: 240 * 60,
              anchor: null
            });
            if (evD) {
              const dTraj = this._buildTrajFromEval(bus.scheduledTrip, bus.stopProj, evD, newTraj);
              this._startCorrectionGlide(prev, dTraj, 0, {
                fromLat: vis?.lat,
                fromLng: vis?.lng,
                followSpeed: evD.isAtTerminal ? 0 : clamp(evD.speedMps, 0, 20)
              });
              prev.etaSecondsRemaining = evD.etaSec;
            }
          } else {
            // No explicit SmartMovePro desvio -> anchor at actual GPS timestamp (not nowSec!)
            const gpsClockSec = gpsMs ? getArgentinaSecOfDay(new Date(gpsMs)) : nowSec;
            const prevFix =
              typeof prev.lastRealLat === 'number' && typeof prev.lastRealLng === 'number'
                ? { lat: prev.lastRealLat, lng: prev.lastRealLng }
                : bus.prevGpsFix || null;
            prev.scheduleAnchor = buildGpsAnchorForTrip(
              bus.scheduledTrip,
              bus.lat,
              bus.lng,
              gpsClockSec,
              0,
              { prevFix, preferredLeg: prev.lastRealLeg || newTraj.leg || null }
            );
          }
        }
        this._applySampleToBus(bus, prev, false);
        continue;
      }

      // Active GPS (moving, or stationary < 3 min, or resting at cabecera with fresh GPS) -> strictly 'gps' mode!
      const recoveredFromSchedule = prev.mode === 'schedule';
      const prevVisual = this._getVisualLatLng(prev);
      prev.mode = 'gps';
      prev.schedulePunctual = false;
      prev.scheduleAnchor = null;
      prev.predDesvioSec = aheadSec;
      bus.gpsLost = false;
      bus.gpsPunctualFallback = false;

      const straightFromLastReal =
        typeof prev.lastRealLat === 'number' && typeof prev.lastRealLng === 'number'
          ? distanceMeters(prev.lastRealLat, prev.lastRealLng, bus.lat, bus.lng) ?? 0
          : Math.abs(prev.lastRealRem - newRealRem);
      const movedFromLastReal = Math.max(Math.abs(prev.lastRealRem - newRealRem), straightFromLastReal);
      const gpsTimeDeltaSec = gpsMs && prev.lastGpsMs ? (gpsMs - prev.lastGpsMs) / 1000 : null;
      const isSameGpsTimestamp =
        (gpsTimeDeltaSec !== null && gpsTimeDeltaSec < 2) ||
        Boolean(gpsRaw && prev.lastGpsRaw && gpsRaw === prev.lastGpsRaw && movedFromLastReal < 5);
      const isFreshFix =
        (gpsTimeDeltaSec !== null && gpsTimeDeltaSec >= 3) ||
        (gpsTimeDeltaSec === null && !isSameGpsTimestamp && movedFromLastReal >= 8) ||
        recoveredFromSchedule;

      // 1. Update real velocity, pace factor & reporting cadence ONLY on genuinely fresh GPS fixes
      //    measuring exact distance covered between penultimate (`anteúltimo`) and latest (`último`) GPS fixes!
      if (isFreshFix) {
        const dtReal =
          gpsTimeDeltaSec !== null && gpsTimeDeltaSec >= 3 && gpsTimeDeltaSec <= MAX_VALID_FIX_DT_SEC
            ? gpsTimeDeltaSec
            : Math.max(5, (nowMs - prev.lastGpsPollMs) / 1000);

        // Learn real AVL cadence across full 15–135 s spectrum (adapt faster upward so straight-avenue 90–120 s intervals aren't clipped!)
        if (gpsTimeDeltaSec !== null && gpsTimeDeltaSec >= 5 && gpsTimeDeltaSec <= 165) {
          const sampleCadence = clamp(gpsTimeDeltaSec, MIN_GPS_CADENCE_SEC, MAX_GPS_CADENCE_SEC);
          if (prev.observedGpsIntervalSec !== null) {
            const wNew = sampleCadence > prev.observedGpsIntervalSec ? 0.65 : 0.45;
            prev.observedGpsIntervalSec = wNew * sampleCadence + (1 - wNew) * prev.observedGpsIntervalSec;
          } else {
            prev.observedGpsIntervalSec = sampleCadence;
          }
        }

        const routeAdvance = prev.lastRealRem - newRealRem;
        const minMoveThreshold = isAtTerminal ? 20 : 11;
        const speedLegOk = isCompatibleLegTransition(prev.lastRealLeg || prev.activeTraj?.leg, newTraj.leg);
        const routeMatchesDisplacement =
          speedLegOk &&
          routeAdvance >= -25 &&
          Math.abs(routeAdvance) <= Math.max(240, straightFromLastReal * 2.3 + 150);

        // Exact street-following distance between penultimate & latest GPS fixes (fallback to straight-line on leg jump)
        const effectiveAdvance = routeMatchesDisplacement
          ? routeAdvance
          : straightFromLastReal >= minMoveThreshold
            ? straightFromLastReal * 1.04
            : 0;
        const maxPlausibleAdvance = Math.max(2200, dtReal * 30);

        if (
          (effectiveAdvance < minMoveThreshold && straightFromLastReal < minMoveThreshold && dtReal >= 7) ||
          (likelyTerminalRest && effectiveAdvance < 28 && straightFromLastReal < 28)
        ) {
          // Bus is confirmed stationary (< 3 min at traffic light/stop, or resting at cabecera) -> HOLD QUIET at 0 m/s!
          prev.isStopped = true;
          prev.cruiseSpeedMps = 0;
          if (prev.observedSpeedMps !== null) {
            prev.observedSpeedMps = Math.max(2.5, prev.observedSpeedMps * 0.85);
          }
        } else if (effectiveAdvance >= minMoveThreshold && effectiveAdvance < maxPlausibleAdvance) {
          const instSpeed = clamp(effectiveAdvance / dtReal, 1.0, 26.5);
          if (prev.observedSpeedMps === null) {
            prev.observedSpeedMps = instSpeed;
          } else if (instSpeed > prev.observedSpeedMps * 1.35 || instSpeed < prev.observedSpeedMps * 0.65) {
            // Fast adaptation on speed regime transitions (entering highway/bridge or dense downtown traffic)
            prev.observedSpeedMps = 0.78 * instSpeed + 0.22 * prev.observedSpeedMps;
          } else {
            prev.observedSpeedMps = 0.65 * instSpeed + 0.35 * prev.observedSpeedMps;
          }

          // Measure corridor-normalized pace factor against the exact street segment just traversed
          if (typeof prev.lastRealLat === 'number' && typeof prev.lastRealLng === 'number') {
            const curCursor = resolveTrajTripCursor(prev.scheduledTrip, prev.stopProj, newTraj, 0);
            const instPace = curCursor
              ? measurePairPaceFactor(curCursor.trip, prev.lastRealLat, prev.lastRealLng, bus.lat, bus.lng, dtReal)
              : null;
            if (instPace !== null) {
              const prevPace = Number.isFinite(prev.paceFactor) ? prev.paceFactor : 1.0;
              prev.paceFactor = clamp(0.65 * instPace + 0.35 * prevPace, 0.55, 1.55);
            }
          }

          prev.cruiseSpeedMps = prev.observedSpeedMps;
          prev.isStopped = false;
        } else if (recoveredFromSchedule) {
          const curNow = resolveTrajTripCursor(prev.scheduledTrip, prev.stopProj, newTraj, 0);
          const localV = curNow ? getPaceAdjustedTripSpeedMps(curNow.trip, curNow.along, prev.paceFactor || 1.0) : null;
          prev.isStopped = isAtTerminal;
          prev.cruiseSpeedMps = isAtTerminal ? 0 : Math.max(3.2, localV || prev.currentSpeedMps || 4.8);
        }

        prev.hasConfirmedFix = true;
        prev.lastGpsMs = gpsMs ?? prev.lastGpsMs;
        if (gpsRaw) prev.lastGpsRaw = gpsRaw;
        prev.lastGpsPollMs = nowMs;
        prev.lastRealRem = newRealRem;
        prev.lastRealLat = bus.lat;
        prev.lastRealLng = bus.lng;
        prev.lastRealLeg = newTraj.leg;
      } else if (likelyTerminalRest) {
        prev.isStopped = true;
        prev.cruiseSpeedMps = 0;
      } else if (!prev.scheduledTrip && gpsAgeSec >= 175) {
        // Unmatched bus without timetable fallback: gently stop only past the 3-min horizon
        prev.isStopped = true;
        prev.cruiseSpeedMps = 0;
      }

      // 2. Smoothly reconcile position in EN VIVO mode (with fast, smooth, precise recovery when GPS returns!)
      if (!applyPositions) {
        prev.activeTraj = newTraj;
        prev.walkedMeters = 0;
        prev.gpsOriginWalkedMeters = 0;
        prev.overshootMeters = 0;
        prev.lagMeters = 0;
        prev.deadReckonMeters = 0;
        prev.correctionGlide = null;
        prev.etaSecondsRemaining = etaSec;
        continue;
      }

      if (isSameGpsTimestamp && !recoveredFromSchedule && !justEnabledSim) {
        // Keep smooth 60fps simulated position (and any active recovery glide) steady across 10s polls!
        this._applySampleToBus(bus, prev, true);
        continue;
      }

      // Project the incoming GPS fix forward by its timestamp age (`gpsAgeSec`) to compare NOW vs NOW!
      const ageAdvance = prev.isStopped
        ? 0
        : computeAgeAdvanceMeters(prev, newTraj, gpsAgeSec, { isColdStart: justEnabledSim });
      const newEstRem = Math.max(0, newRealRem - ageAdvance);

      if (justEnabledSim) {
        prev.activeTraj = newTraj;
        prev.walkedMeters = clamp(ageAdvance, 0, newTraj.totalMeters);
        prev.gpsOriginWalkedMeters = 0;
        prev.overshootMeters = 0;
        prev.lagMeters = 0;
        prev.deadReckonMeters = prev.walkedMeters;
        prev.correctionGlide = null;
        if (!prev.isStopped) {
          const curNow = resolveTrajTripCursor(prev.scheduledTrip, prev.stopProj, newTraj, prev.walkedMeters);
          const vNow = curNow ? getPaceAdjustedTripSpeedMps(curNow.trip, curNow.along, prev.paceFactor) : null;
          prev.currentSpeedMps = vNow ?? prev.cruiseSpeedMps;
        }
      } else if (recoveredFromSchedule) {
        // GPS returned after schedule fallback (3–5 min or 5+ min):
        // Smooth, brisk (~0.65–1.45 s), exact correction directly to the newly reported GPS position!
        const targetWalked = clamp(ageAdvance, 0, newTraj.totalMeters);
        const curNow = resolveTrajTripCursor(prev.scheduledTrip, prev.stopProj, newTraj, targetWalked);
        const vNow = !prev.isStopped && curNow
          ? getPaceAdjustedTripSpeedMps(curNow.trip, curNow.along, prev.paceFactor || 1.0)
          : null;
        const followV = prev.isStopped ? 0 : (vNow ?? prev.cruiseSpeedMps ?? 4.8);
        this._startCorrectionGlide(prev, newTraj, targetWalked, {
          fromLat: prevVisual?.lat,
          fromLng: prevVisual?.lng,
          followSpeed: followV
        });
      } else {
        prev.correctionGlide = null;
        const prevSimRem = Math.max(0, prev.activeTraj.totalMeters - prev.walkedMeters);
        const rawDelta = newRealRem - prevSimRem; // marker distance ahead of raw P(t_gps)
        const estDelta = newEstRem - prevSimRem;  // marker distance ahead of time-compensated P_est(now)
        const compatibleLeg = isCompatibleLegTransition(prev.activeTraj.leg, newTraj.leg);
        const learnedCadence = clamp(prev.observedGpsIntervalSec || DEFAULT_GPS_CADENCE_SEC, MIN_GPS_CADENCE_SEC, MAX_GPS_CADENCE_SEC);
        const refSpeed = prev.observedSpeedMps || prev.cruiseSpeedMps || 4.8;
        const expectedStepMeters = refSpeed * Math.max(learnedCadence, 75);
        const maxOvershootHold = prev.isStopped
          ? 220
          : clamp(Math.max(320, expectedStepMeters * 1.15), 320, 950);
        const maxForwardSplice = clamp(Math.max(850, expectedStepMeters * 2.2), 850, 2200);

        if (compatibleLeg && estDelta >= 0 && rawDelta <= maxOvershootHold) {
          // Regime A: Marker is genuinely ahead of P_est(now) (e.g. bus hit red lights) -> zero backjump, gentle bleed-off
          prev.activeTraj = newTraj;
          prev.walkedMeters = clamp(rawDelta, 0, newTraj.totalMeters);
          prev.gpsOriginWalkedMeters = 0;
          prev.overshootMeters = estDelta;
          prev.lagMeters = 0;
          prev.deadReckonMeters = prev.walkedMeters;
        } else if (compatibleLeg && estDelta < 0 && rawDelta >= 0 && -estDelta <= maxForwardSplice) {
          // Regime B: Marker sits between P(t_gps) and P_est(now) -> zero jump on newTraj, smoothly close small lag!
          prev.activeTraj = newTraj;
          prev.walkedMeters = clamp(rawDelta, 0, newTraj.totalMeters);
          prev.gpsOriginWalkedMeters = 0;
          prev.overshootMeters = 0;
          prev.lagMeters = -estDelta;
          prev.deadReckonMeters = prev.walkedMeters;
        } else if (compatibleLeg && estDelta < 0 && rawDelta < 0 && -estDelta <= maxForwardSplice) {
          // Regime C: Even raw P(t_gps) is ahead of marker -> splice street path seamlessly and close full lag to P_est(now)!
          const spliced = prependPathToTrajectory(prev.activeTraj, prev.walkedMeters, newTraj);
          prev.activeTraj = spliced;
          prev.walkedMeters = 0;
          prev.gpsOriginWalkedMeters = Math.max(0, spliced.totalMeters - newRealRem);
          prev.overshootMeters = 0;
          prev.lagMeters = -estDelta;
          prev.deadReckonMeters = 0;
        } else {
          // Regime D: Incompatible leg or large GPS correction -> smooth, brisk, exact glide to P_est(now) (no instant teleport!)
          const targetWalked = clamp(ageAdvance, 0, newTraj.totalMeters);
          const followV = prev.isStopped ? 0 : Math.min(prev.currentSpeedMps || prev.cruiseSpeedMps || 4.8, prev.cruiseSpeedMps || 12);
          this._startCorrectionGlide(prev, newTraj, targetWalked, {
            fromLat: prevVisual?.lat,
            fromLng: prevVisual?.lng,
            followSpeed: followV
          });
        }
      }

      // Time-compensated ETA reconciliation aligned with remaining street distance on final direct approach
      const ageEtaTrim = prev.isStopped ? 0 : Math.min(gpsAgeSec, Math.max(0, etaSec - 25));
      let targetEtaSec = Math.max(15, etaSec - ageEtaTrim);
      if (!prev.isStopped && newTraj.leg === 'direct' && newEstRem < 600) {
        const curAtNow = resolveTrajTripCursor(prev.scheduledTrip, prev.stopProj, newTraj, ageAdvance);
        const vEst =
          (curAtNow ? getPaceAdjustedTripSpeedMps(curAtNow.trip, curAtNow.along, prev.paceFactor) : null) ||
          prev.observedSpeedMps ||
          prev.cruiseSpeedMps ||
          4.5;
        const kinEta = newEstRem / Math.max(2.2, vEst);
        targetEtaSec = targetEtaSec * 0.45 + kinEta * 0.55;
      }
      if (Math.abs(targetEtaSec - prev.etaSecondsRemaining) <= 180) {
        prev.etaSecondsRemaining = prev.etaSecondsRemaining * 0.35 + targetEtaSec * 0.65;
      } else {
        prev.etaSecondsRemaining = targetEtaSec;
      }

      this._applySampleToBus(bus, prev, true);
    }

    // Mirror next-lap (`Sig. vuelta`) virtual cards onto their reconciled source bus (lat/lng, desvio, GPS, routeMeters, live status)
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
      if (src.desvio) bus.desvio = src.desvio;
      if (src.ultimaFechaHoraGPS) bus.ultimaFechaHoraGPS = src.ultimaFechaHoraGPS;
      if (src.gpsTimeOnly) bus.gpsTimeOnly = src.gpsTimeOnly;
      if (src.choferNombre) bus.choferNombre = src.choferNombre;
      if (src.choferLegajo) bus.choferLegajo = src.choferLegajo;
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

      if (this._stepCorrectionGlide(st, dt, bus, updateEta)) {
        continue;
      }

      let traj = st.activeTraj;

      // ── Mode A: Timetable-driven smooth 30fps tracking (3–5 min last-seen desvio; >= 5 min strict 00:00 punctual) ──
      if (st.mode === 'schedule' && st.scheduledTrip && st.stopProj) {
        if (!st.schedulePunctual && st.lastGpsMs) {
          const liveGpsAge = Math.max(0, (nowMs - st.lastGpsMs) / 1000);
          const liveStatSec =
            st.stationarySinceMs !== null ? Math.max(0, (nowMs - st.stationarySinceMs) / 1000) : 0;
          const liveSilentSec = st.isAtTerminal ? liveGpsAge : Math.max(liveGpsAge, liveStatSec);
          if (liveSilentSec >= PUNCTUAL_SCHEDULE_THRESHOLD_SEC) {
            const vis = this._getVisualLatLng(st);
            st.schedulePunctual = true;
            st.predDesvioSec = 0;
            st.scheduleAnchor = null;
            bus.gpsPunctualFallback = true;
            const evP = evaluateTripState(st.scheduledTrip, st.stopId, st.stopProj, nowSec, 0, {
              maxAheadSec: 240 * 60,
              anchor: null
            });
            if (evP) {
              const pTraj = this._buildTrajFromEval(st.scheduledTrip, st.stopProj, evP, traj);
              this._startCorrectionGlide(st, pTraj, 0, {
                fromLat: vis?.lat,
                fromLng: vis?.lng,
                followSpeed: evP.isAtTerminal ? 0 : clamp(evP.speedMps, 0, 20)
              });
              st.etaSecondsRemaining = evP.etaSec;
              this._applySampleToBus(bus, st, updateEta);
              continue;
            }
          }
        }

        const effDesvio = st.schedulePunctual ? 0 : (st.predDesvioSec || 0);
        const effAnchor = st.schedulePunctual ? null : (st.scheduleAnchor || null);
        const ev = evaluateTripState(st.scheduledTrip, st.stopId, st.stopProj, nowSec, effDesvio, {
          maxAheadSec: 240 * 60,
          anchor: effAnchor
        });
        let targetSpeed = 0;

        if (!ev) {
          targetSpeed = 0;
          st.etaSecondsRemaining = 0;
        } else {
          if (ev.remainingMeters > traj.totalMeters + 45) {
            const rebuilt = this._buildTrajFromEval(st.scheduledTrip, st.stopProj, ev, traj);
            if (rebuilt !== traj) {
              const vis = this._getVisualLatLng(st);
              this._startCorrectionGlide(st, rebuilt, 0, {
                fromLat: vis?.lat,
                fromLng: vis?.lng,
                followSpeed: ev.isAtTerminal ? 0 : clamp(ev.speedMps, 0, 20)
              });
              st.etaSecondsRemaining = ev.etaSec;
              this._applySampleToBus(bus, st, updateEta);
              continue;
            }
          }

          const targetWalked = clamp(traj.totalMeters - ev.remainingMeters, 0, traj.totalMeters);
          const err = targetWalked - st.walkedMeters;

          if (ev.speedMps <= 0.05 || ev.isAtTerminal) {
            targetSpeed = 0;
            if (ev.isAtTerminal && ev.speedMps <= 0.05) {
              st.currentSpeedMps = 0;
            }
          } else if (err < -4) {
            targetSpeed = clamp(ev.speedMps * 0.25, 0, 3.0);
          } else {
            targetSpeed = clamp(ev.speedMps + clamp(err / 6.0, 0, 4.5), 0, 26.0);
          }

          st.etaSecondsRemaining = ev.etaSec;
          // NEVER invent/overwrite `bus.desvio` on live SmartMovePro buses (keep real GPS desvio intact!)
          // For pure timetable-predicted units (`bus.isPredicted`), clear stale desvio once >= 5 min punctual (00:00).
          if (updateEta && bus.isPredicted) {
            if (st.schedulePunctual) {
              bus.desvio = { raw: '', status: 'none', label: '', shortLabel: '', sign: '', minutes: 0, seconds: 0 };
            } else if (st.scheduleAnchor && Number.isFinite(ev.effectiveOffsetSec)) {
              bus.desvio = parseDesvioHorario(formatDesvioFromSec(ev.effectiveOffsetSec));
            }
          }
        }

        const maxAccel = targetSpeed > 11 ? 1.85 : 1.15;
        const maxBrake = st.currentSpeedMps > 11 ? 2.4 : 1.85;
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

      // ── Mode B: Live GPS kinematic prediction (time-compensated + corridor-adaptive) ──
      const gpsAgeSec = st.lastGpsMs
        ? clamp((nowMs - st.lastGpsMs) / 1000, 0, 300)
        : Math.max(0, (nowMs - st.lastGpsPollMs) / 1000);
      const cadence = clamp(st.observedGpsIntervalSec || DEFAULT_GPS_CADENCE_SEC, MIN_GPS_CADENCE_SEC, MAX_GPS_CADENCE_SEC);
      const hasSchedule = Boolean(st.scheduledTrip && st.stopProj);

      let localCruise = st.isStopped ? 0 : st.cruiseSpeedMps;
      if (!st.isStopped && hasSchedule) {
        const cursor = resolveTrajTripCursor(st.scheduledTrip, st.stopProj, traj, st.walkedMeters);
        const schedAdapted = cursor
          ? getPaceAdjustedTripSpeedMps(cursor.trip, cursor.along, st.paceFactor || 1.0)
          : null;
        if (schedAdapted !== null) {
          localCruise = schedAdapted;
          st.cruiseSpeedMps = schedAdapted;
        }
      }

      const refSpeed = Math.max(localCruise || 0, st.observedSpeedMps || 0, st.cruiseSpeedMps || 4.8);
      const expectedStepMeters = refSpeed * Math.max(cadence, 95);
      const maxLookahead = st.hasConfirmedFix
        ? clamp(expectedStepMeters * 1.45, 220, 2600)
        : clamp(expectedStepMeters * 1.25, 200, 1600);
      const ageTaperStart = clamp(Math.max(cadence * 1.25, 120), 120, 162);
      st.deadReckonMeters = Math.max(0, st.walkedMeters - (st.gpsOriginWalkedMeters || 0));

      const reachedTurnaround =
        (traj.turnaroundAtMeters > 40 && Math.abs(st.walkedMeters - traj.turnaroundAtMeters) < 25) ||
        (traj.oppStartMeters > 40 && Math.abs(st.walkedMeters - traj.oppStartMeters) < 25);

      let targetSpeed = 0;

      if (st.lagMeters > 2) {
        const baseCruise = st.isStopped ? 2.5 : Math.max(3.0, localCruise);
        const maxCatchupSpeed = clamp(Math.max(15.0, baseCruise * 1.65), 15.0, 29.0);
        const maxBoost = Math.max(6.0, baseCruise * 0.75);
        const catchupBoost = clamp(st.lagMeters / 5.0, 0.6, maxBoost);
        targetSpeed = clamp(baseCruise + catchupBoost, 2.0, maxCatchupSpeed);
      } else if (st.isStopped || (reachedTurnaround && st.aheadSec >= 45)) {
        targetSpeed = 0;
      } else if (st.overshootMeters > 4) {
        // Real bus is genuinely behind our time-compensated estimate (e.g. red lights): gently ease speed without backjump!
        const cruise = Math.max(1.8, localCruise);
        const overshootSec = st.overshootMeters / cruise;
        if (overshootSec <= 6.0) {
          targetSpeed = cruise * 0.72;
        } else if (overshootSec <= 14.0) {
          targetSpeed = cruise * 0.45;
        } else if (overshootSec <= 26.0) {
          targetSpeed = cruise * 0.22;
        } else {
          targetSpeed = 0;
        }
        if (gpsAgeSec > ageTaperStart && !hasSchedule) {
          targetSpeed *= clamp(1 - (gpsAgeSec - ageTaperStart) / 30, 0, 1);
        }
      } else {
        targetSpeed = localCruise;

        const taperStart = maxLookahead * 0.85;
        if (st.deadReckonMeters > taperStart) {
          const minRatio = hasSchedule ? 0.45 : 0;
          const ratio = clamp(1 - (st.deadReckonMeters - taperStart) / Math.max(30, maxLookahead - taperStart), minRatio, 1);
          targetSpeed *= ratio;
        }

        if (gpsAgeSec > ageTaperStart) {
          const minAgeRatio = hasSchedule ? 0.55 : 0;
          const ageRatio = clamp(1 - (gpsAgeSec - ageTaperStart) / 30, minAgeRatio, 1);
          targetSpeed *= ageRatio;
        }
      }

      const maxAccel = targetSpeed > 11 ? 2.1 : 1.35;
      const maxBrake = st.currentSpeedMps > 11 ? 2.4 : 1.85;
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
      let actualMove = 0;
      if (advance > 0) {
        const prevW = st.walkedMeters;
        st.walkedMeters = Math.min(traj.totalMeters, st.walkedMeters + advance);
        actualMove = st.walkedMeters - prevW;
        st.deadReckonMeters = Math.max(0, st.walkedMeters - (st.gpsOriginWalkedMeters || 0));

        if (st.lagMeters > 0) {
          // Only net catch-up above the real moving bus's speed reduces remaining lag!
          const estRealAdvance = !st.isStopped && localCruise > 0.5 ? localCruise * dt : 0;
          const netGain = st.isStopped ? actualMove : Math.max(0, actualMove - estRealAdvance);
          st.lagMeters = Math.max(0, st.lagMeters - netGain);
        }
      }

      if (st.overshootMeters > 0 && !st.isStopped && localCruise > 0.5) {
        const estimatedRealAdvance = localCruise * dt;
        const netCatchup = Math.max(0, estimatedRealAdvance - actualMove);
        st.overshootMeters = Math.max(0, st.overshootMeters - netCatchup);
      }

      if (st.currentSpeedMps > 0.35) {
        st.etaSecondsRemaining = Math.max(0, st.etaSecondsRemaining - dt);
        const remMeters = Math.max(0, traj.totalMeters - st.walkedMeters);
        if (traj.leg === 'direct' && remMeters < 550 && localCruise > 2.0) {
          const kinEta = remMeters / localCruise;
          const pull = Math.min(0.25, dt * 0.35);
          st.etaSecondsRemaining = st.etaSecondsRemaining * (1 - pull) + kinEta * pull;
        }
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
      if (src.desvio) bus.desvio = src.desvio;
      if (src.ultimaFechaHoraGPS) bus.ultimaFechaHoraGPS = src.ultimaFechaHoraGPS;
      if (src.gpsTimeOnly) bus.gpsTimeOnly = src.gpsTimeOnly;
      if (src.realBandera) bus.realBandera = src.realBandera;
      if (src.realBanderaColor) bus.realBanderaColor = src.realBanderaColor;

      bus.etaSecondsRemaining = Math.max(0, (bus.etaSecondsRemaining ?? 0) - dt);
      if (updateEta && (bus.isPredicted || !bus.hasOfficialSoapEta)) {
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
      } else if (updateEta && bus.eta?.valid) {
        bus.proximityPct = computeProximityPercent(bus.eta.minutes, bus.routeMeters);
      }
    }
  }

  _applySampleToBus(bus, st, updateEta) {
    const sample = sampleTrajectory(st.activeTraj, st.walkedMeters);
    if (!sample) return;

    const useLatLngGlide =
      st.correctionGlide?.type === 'latlng' &&
      Number.isFinite(st.correctionGlide.curLat) &&
      Number.isFinite(st.correctionGlide.curLng);
    const outLat = useLatLngGlide ? st.correctionGlide.curLat : sample.lat;
    const outLng = useLatLngGlide ? st.correctionGlide.curLng : sample.lng;

    const prevLat = bus.lat;
    const prevLng = bus.lng;
    const moved =
      typeof prevLat !== 'number' ||
      typeof prevLng !== 'number' ||
      Math.abs(outLat - prevLat) > 1.5e-7 ||
      Math.abs(outLng - prevLng) > 1.5e-7;

    bus._posChanged = moved;
    bus.trajectory = st.activeTraj;
    if (moved) {
      bus.lat = outLat;
      bus.lng = outLng;
    }
    bus.routeMeters = sample.remainingMeters;
    bus.simSpeedMps = Number.isFinite(st.currentSpeedMps) && st.currentSpeedMps > 0.2 ? st.currentSpeedMps : 5.5;
    bus.simActive = true;
    bus.isOppositeLeg = sample.inOppositeLeg;
    bus.isNextCycle = Boolean(sample.inNextCycle);
    if (sample.currentBandera) bus.realBandera = sample.currentBandera;
    if (sample.currentBranchColor) bus.realBanderaColor = sample.currentBranchColor;

    if (updateEta) {
      bus.etaSecondsRemaining = st.etaSecondsRemaining;
      // Regla estricta: si el colectivo tiene GPS real y ETA oficial del SOAP (Cuando Llega original),
      // JAMÁS inventar "Arribando" ni alterar los minutos. Solo calcular ETA si es predicción por horario (sin GPS).
      if (bus.isPredicted || !bus.hasOfficialSoapEta) {
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
      }
      if (bus.eta?.valid) {
        bus.proximityPct = computeProximityPercent(bus.eta.minutes, bus.routeMeters);
      }
    }
  }
}
