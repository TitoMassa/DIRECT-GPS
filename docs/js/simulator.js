import { sampleTrajectory, prependPathToTrajectory } from './trajectory.js';
import { computeProximityPercent, distanceMeters, parseDesvioHorario } from './api.js';
import {
  evaluateTripState,
  getArgentinaSecOfDay,
  toServiceSec,
  buildGpsAnchorForTrip,
  formatDesvioFromSec
} from './predictor.js';

const STATIONARY_OFFLINE_THRESHOLD_SEC = 180; // Full 3 minutes stationary outside a cabecera before switching to predicted mode
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
 * Estimates initial cruising speed on first sight using (in priority order):
 *  1. Real distance covered between penultimate (`anteúltimo`) and latest (`último`) GPS fixes
 *  2. Local scheduled segment speed along the matched timetable trip
 *  3. Direct route-distance / ETA ratio (avoiding turnaround-layover deflation on indirect legs)
 */
function estimateInitialKinematics(bus, newTraj, stopId, nowSec, gpsMs, etaSec, aheadSec, isAtTerminal, isStaleTracker) {
  if (isStaleTracker) {
    return { cruise: 0, observedSpeed: null, cadence: null, hasConfirmed: false, isStopped: true };
  }

  // 1) Penultimate -> latest GPS fix distance/time (works on Frame 1 when history/FleetMemory has prior fix!)
  const prevFix = bus.prevGpsFix;
  if (
    prevFix &&
    typeof prevFix.lat === 'number' &&
    typeof prevFix.lng === 'number' &&
    typeof prevFix.gpsMs === 'number' &&
    typeof gpsMs === 'number'
  ) {
    const dtPrev = (gpsMs - prevFix.gpsMs) / 1000;
    if (dtPrev >= 4 && dtPrev <= 110) {
      const moved = distanceMeters(prevFix.lat, prevFix.lng, bus.lat, bus.lng) ?? 0;
      const learnedCadence = clamp(dtPrev, 12, 55);
      const minMove = isAtTerminal ? 24 : 11;
      if (moved < minMove && dtPrev >= 8) {
        return { cruise: 0, observedSpeed: null, cadence: learnedCadence, hasConfirmed: true, isStopped: true };
      }
      const maxPlausible = Math.max(1500, dtPrev * 30);
      if (moved >= minMove && moved < maxPlausible) {
        const inst = clamp((moved * 1.04) / dtPrev, 1.0, 26.5);
        return { cruise: inst, observedSpeed: inst, cadence: learnedCadence, hasConfirmed: true, isStopped: false };
      }
    }
  }

  if (isAtTerminal) {
    return { cruise: 0, observedSpeed: null, cadence: null, hasConfirmed: false, isStopped: true };
  }

  // 2) Local scheduled segment speed along the matched trip (distinguishes highway/bridge vs downtown!)
  if (bus.scheduledTrip && bus.stopProj) {
    const ev = evaluateTripState(bus.scheduledTrip, stopId, bus.stopProj, nowSec, aheadSec, {
      maxAheadSec: 240 * 60
    });
    if (ev && !ev.isAtTerminal && ev.speedMps > 1.2) {
      const schedSpd = clamp(ev.speedMps * 0.92, 2.8, 18.0);
      return { cruise: schedSpd, observedSpeed: null, cadence: null, hasConfirmed: false, isStopped: false };
    }
  }

  // 3) Direct route-distance / ETA ratio (on indirect legs ETA includes terminal layover, so use urban default)
  const fallbackSpd =
    newTraj.leg === 'direct'
      ? clamp((newTraj.totalMeters / etaSec) * 0.85, 3.0, 14.0)
      : 5.2;

  return { cruise: fallbackSpd, observedSpeed: null, cadence: null, hasConfirmed: false, isStopped: false };
}

/**
 * Physically-faithful, zero-backjump kinematic vehicle predictor for EN VIVO mode.
 *
 * Operating rules:
 *  - 'gps': learns each unit's real speed from the exact distance & clock delta between its
 *    penultimate (`anteúltimo`) and latest (`último`) GPS fixes, adapts dead-reckoning lookahead
 *    and silence windows to each tracker's real reporting cadence (12–55 s), gently bleeds off
 *    moving overshoots without stopping, and smoothly splices forward lag (including across
 *    turnarounds) with zero teleports. If a live GPS bus stays stationary (<20 m) at a non-cabecera
 *    spot, it remains QUIET at its real GPS spot for a full 3 minutes (180 s) before switching to
 *    predicted mode.
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
          const initSpeed = newTraj.isAtTerminal ? 0 : clamp(newTraj.speedMps || 4.8, 0, 22.0);
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
            lastRealLat: bus.lat,
            lastRealLng: bus.lng,
            lastRealLeg: newTraj.leg,
            observedGpsIntervalSec: null,
            hasConfirmedFix: false,
            observedSpeedMps: null,
            cruiseSpeedMps: initSpeed,
            currentSpeedMps: initSpeed * 0.75,
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
        if (prev.isAtTerminal) {
          prev.isStopped = true;
          prev.currentSpeedMps = 0;
        }

        if (wasLiveGps) {
          // Anchor directly to the bus's last visual/GPS position so it starts RIGHT THERE with gradual recovery!
          const curSample = sampleTrajectory(prev.activeTraj, prev.walkedMeters);
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
          prev.etaSecondsRemaining = etaSec;
          continue;
        }

        const prevSimRem = Math.max(0, prev.activeTraj.totalMeters - prev.walkedMeters);
        const deltaRem = newRealRem - prevSimRem;
        const compatibleLeg = isCompatibleLegTransition(prev.activeTraj.leg, newTraj.leg);

        if (!compatibleLeg || Math.abs(deltaRem) > 260) {
          if (compatibleLeg && deltaRem < 0 && -deltaRem <= 950) {
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
      const priorCadence = clamp(prev?.observedGpsIntervalSec || 28, 14, 55);
      const staleThresholdSec = Math.max(65, priorCadence * 1.75);
      const isStaleTracker = gpsAgeSec > staleThresholdSec;

      const isAtTerminal = Boolean(newTraj.isAtTerminal);
      const aheadSec = bus.desvio?.seconds || 0;
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
          isStaleTracker
        );
        // Record when this bus was first observed at (anchorLat, anchorLng); use GPS timestamp if already aging
        const initialStationarySince =
          gpsMs && gpsMs < nowMs && nowMs - gpsMs < 7200000 ? gpsMs : nowMs;
        const alreadyFrozen3Min =
          applyPositions &&
          !isAtTerminal &&
          gpsAgeSec >= STATIONARY_OFFLINE_THRESHOLD_SEC &&
          Boolean(bus.scheduledTrip && bus.stopProj);

        const initAnchor = alreadyFrozen3Min
          ? buildGpsAnchorForTrip(bus.scheduledTrip, bus.lat, bus.lng, nowSec, aheadSec, {
              prevFix: bus.prevGpsFix || null,
              preferredLeg: newTraj.leg || null
            })
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
          lastRealLat: bus.lat,
          lastRealLng: bus.lng,
          lastRealLeg: newTraj.leg,
          observedGpsIntervalSec: initKin.cadence,
          hasConfirmedFix: initKin.hasConfirmed,
          observedSpeedMps: initKin.observedSpeed,
          cruiseSpeedMps: initKin.cruise,
          currentSpeedMps: alreadyFrozen3Min || initKin.isStopped ? 0 : initKin.cruise * 0.78,
          isStopped: !alreadyFrozen3Min && initKin.isStopped,
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
          const prevFix =
            typeof prev.lastRealLat === 'number' && typeof prev.lastRealLng === 'number'
              ? { lat: prev.lastRealLat, lng: prev.lastRealLng }
              : bus.prevGpsFix || null;
          prev.scheduleAnchor = buildGpsAnchorForTrip(
            bus.scheduledTrip,
            aLat,
            aLng,
            nowSec,
            aheadSec,
            {
              prevFix,
              preferredLeg: prev.lastRealLeg || newTraj.leg || null
            }
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

      const straightFromLastReal =
        typeof prev.lastRealLat === 'number' && typeof prev.lastRealLng === 'number'
          ? distanceMeters(prev.lastRealLat, prev.lastRealLng, bus.lat, bus.lng) ?? 0
          : Math.abs(prev.lastRealRem - newRealRem);
      const movedFromLastReal = Math.max(Math.abs(prev.lastRealRem - newRealRem), straightFromLastReal);
      const gpsTimeDeltaSec = gpsMs && prev.lastGpsMs ? (gpsMs - prev.lastGpsMs) / 1000 : null;
      const isSameGpsTimestamp = gpsTimeDeltaSec !== null && gpsTimeDeltaSec < 2;
      const isFreshFix =
        (gpsTimeDeltaSec !== null && gpsTimeDeltaSec >= 3) ||
        (gpsTimeDeltaSec === null && movedFromLastReal >= 8) ||
        recoveredFromSchedule;

      // 1. Update real velocity & reporting cadence ONLY on genuinely fresh GPS fixes
      //    measuring exact distance covered between penultimate (`anteúltimo`) and latest (`último`) GPS fixes!
      if (isFreshFix) {
        const dtReal =
          gpsTimeDeltaSec !== null && gpsTimeDeltaSec >= 3 && gpsTimeDeltaSec <= 180
            ? gpsTimeDeltaSec
            : Math.max(5, (nowMs - prev.lastGpsPollMs) / 1000);

        if (gpsTimeDeltaSec !== null && gpsTimeDeltaSec >= 5 && gpsTimeDeltaSec <= 75) {
          const sampleCadence = clamp(gpsTimeDeltaSec, 12, 55);
          prev.observedGpsIntervalSec =
            prev.observedGpsIntervalSec !== null
              ? 0.55 * sampleCadence + 0.45 * prev.observedGpsIntervalSec
              : sampleCadence;
        }

        const routeAdvance = prev.lastRealRem - newRealRem;
        const minMoveThreshold = isAtTerminal ? 20 : 11;
        const speedLegOk = isCompatibleLegTransition(prev.lastRealLeg || prev.activeTraj?.leg, newTraj.leg);
        const routeMatchesDisplacement =
          speedLegOk &&
          routeAdvance >= -25 &&
          Math.abs(routeAdvance) <= Math.max(220, straightFromLastReal * 2.3 + 140);

        // Exact street-following distance between penultimate & latest GPS fixes (fallback to straight-line on leg jump)
        const effectiveAdvance = routeMatchesDisplacement
          ? routeAdvance
          : straightFromLastReal >= minMoveThreshold
            ? straightFromLastReal * 1.05
            : 0;
        const maxPlausibleAdvance = Math.max(1500, dtReal * 30);

        if (
          (effectiveAdvance < minMoveThreshold && straightFromLastReal < minMoveThreshold && dtReal >= 7) ||
          (likelyTerminalRest && effectiveAdvance < 28 && straightFromLastReal < 28)
        ) {
          // Bus is stationary (< 3 min at traffic light/stop, or resting at cabecera) -> HOLD QUIET at 0 m/s!
          prev.isStopped = true;
          prev.cruiseSpeedMps = 0;
          if (prev.observedSpeedMps !== null) {
            prev.observedSpeedMps = Math.max(2.5, prev.observedSpeedMps * 0.85);
          }
        } else if (effectiveAdvance >= minMoveThreshold && effectiveAdvance < maxPlausibleAdvance) {
          const instSpeed = clamp(effectiveAdvance / dtReal, 0.9, 26.5);
          if (prev.observedSpeedMps === null) {
            prev.observedSpeedMps = instSpeed;
          } else if (instSpeed > prev.observedSpeedMps * 1.35 || instSpeed < prev.observedSpeedMps * 0.65) {
            // Fast adaptation on speed regime transitions (entering highway/bridge or dense downtown traffic)
            prev.observedSpeedMps = 0.80 * instSpeed + 0.20 * prev.observedSpeedMps;
          } else {
            prev.observedSpeedMps = 0.68 * instSpeed + 0.32 * prev.observedSpeedMps;
          }
          prev.cruiseSpeedMps = prev.observedSpeedMps;
          prev.isStopped = false;
        } else if (recoveredFromSchedule) {
          prev.isStopped = isAtTerminal;
          prev.cruiseSpeedMps = isAtTerminal ? 0 : Math.max(3.2, prev.currentSpeedMps || 4.8);
        }

        prev.hasConfirmedFix = true;
        prev.lastGpsMs = gpsMs ?? prev.lastGpsMs;
        prev.lastGpsPollMs = nowMs;
        prev.lastRealRem = newRealRem;
        prev.lastRealLat = bus.lat;
        prev.lastRealLng = bus.lng;
        prev.lastRealLeg = newTraj.leg;
      } else if (isSameGpsTimestamp || isStaleTracker || likelyTerminalRest) {
        const silentSec = (nowMs - prev.lastGpsPollMs) / 1000;
        const silentStopThreshold = Math.max(48, priorCadence * 1.60);
        if (silentSec > silentStopThreshold || isStaleTracker || likelyTerminalRest) {
          prev.isStopped = true;
          prev.cruiseSpeedMps = 0;
        }
      }

      // 2. Smoothly reconcile position without ANY backward jumps or forward teleports when in EN VIVO mode
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
      const compatibleLeg = isCompatibleLegTransition(prev.activeTraj.leg, newTraj.leg);
      const learnedCadence = clamp(prev.observedGpsIntervalSec || 28, 14, 55);
      const refSpeed = prev.observedSpeedMps || prev.cruiseSpeedMps || 5.0;
      const expectedStepMeters = refSpeed * learnedCadence;
      const maxOvershootHold = clamp(Math.max(260, expectedStepMeters * 0.95), 260, 720);
      const maxForwardSplice = clamp(Math.max(650, expectedStepMeters * 2.2), 650, 1650);

      if (compatibleLeg && deltaRem >= 0 && deltaRem <= maxOvershootHold) {
        prev.activeTraj = newTraj;
        prev.walkedMeters = clamp(deltaRem, 0, newTraj.totalMeters);
        prev.overshootMeters = deltaRem;
        prev.lagMeters = 0;
        prev.deadReckonMeters = deltaRem;
      } else if (compatibleLeg && deltaRem < 0 && -deltaRem <= maxForwardSplice) {
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

      const traj = st.activeTraj;

      // ── Mode A: Timetable-driven smooth 30fps tracking anchored to last GPS + gradual recovery ──
      if (st.mode === 'schedule' && st.scheduledTrip && st.stopProj) {
        const ev = evaluateTripState(st.scheduledTrip, st.stopId, st.stopProj, nowSec, st.predDesvioSec || 0, {
          maxAheadSec: 240 * 60,
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
            if (ev.isAtTerminal && ev.speedMps <= 0.05) {
              st.currentSpeedMps = 0;
            }
          } else if (err < -4) {
            targetSpeed = clamp(ev.speedMps * 0.25, 0, 3.0);
          } else {
            targetSpeed = clamp(ev.speedMps + clamp(err / 6.0, 0, 4.5), 0, 26.0);
          }

          st.etaSecondsRemaining = ev.etaSec;
          if (updateEta && st.scheduleAnchor && Number.isFinite(ev.effectiveOffsetSec)) {
            bus.desvio = parseDesvioHorario(formatDesvioFromSec(ev.effectiveOffsetSec));
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

      // ── Mode B: Live GPS kinematic prediction (adaptive cadence + velocity) ──
      const silentSec = (nowMs - st.lastGpsPollMs) / 1000;
      const cadence = clamp(st.observedGpsIntervalSec || 28, 14, 55);
      const refSpeed = st.observedSpeedMps || st.cruiseSpeedMps || 5.0;
      const expectedStepMeters = refSpeed * cadence;
      const maxLookahead = st.hasConfirmedFix
        ? clamp(expectedStepMeters * 1.30, 90, 1250)
        : clamp(Math.max(4.8, st.cruiseSpeedMps || 4.8) * 32, 110, 480);
      const silentTaperStart = Math.max(30, cadence * 1.20);

      const reachedTurnaround =
        (traj.turnaroundAtMeters > 40 && Math.abs(st.walkedMeters - traj.turnaroundAtMeters) < 25) ||
        (traj.oppStartMeters > 40 && Math.abs(st.walkedMeters - traj.oppStartMeters) < 25);

      let targetSpeed = 0;

      if (st.lagMeters > 2) {
        const baseCruise = st.isStopped ? 2.2 : Math.max(2.8, st.cruiseSpeedMps);
        const maxCatchupSpeed = clamp(Math.max(12.5, baseCruise * 1.42), 12.5, 29.0);
        const maxBoost = Math.max(4.5, baseCruise * 0.42);
        const catchupBoost = clamp(st.lagMeters / 7.5, 0.5, maxBoost);
        targetSpeed = clamp(baseCruise + catchupBoost, 1.8, maxCatchupSpeed);
      } else if (st.isStopped || (reachedTurnaround && st.aheadSec >= 45)) {
        targetSpeed = 0;
      } else if (st.overshootMeters > 4) {
        // Real bus is moving behind our slight overshoot: gently ease speed so it catches up smoothly without freezing!
        const cruise = Math.max(1.5, st.cruiseSpeedMps);
        const overshootSec = st.overshootMeters / cruise;
        if (overshootSec <= 4.5) {
          targetSpeed = cruise * 0.65;
        } else if (overshootSec <= 10) {
          targetSpeed = cruise * 0.35;
        } else if (overshootSec <= 18) {
          targetSpeed = cruise * 0.12;
        } else {
          targetSpeed = 0;
        }
        if (silentSec > silentTaperStart) {
          targetSpeed *= clamp(1 - (silentSec - silentTaperStart) / 16, 0, 1);
        }
      } else {
        targetSpeed = st.cruiseSpeedMps;

        const taperStart = maxLookahead * 0.80;
        if (st.deadReckonMeters > taperStart) {
          const ratio = clamp(1 - (st.deadReckonMeters - taperStart) / (maxLookahead - taperStart), 0, 1);
          targetSpeed *= ratio;
        }

        if (silentSec > silentTaperStart) {
          targetSpeed *= clamp(1 - (silentSec - silentTaperStart) / 16, 0, 1);
        }
      }

      if (
        targetSpeed > 1.8 &&
        targetSpeed <= 13.5 &&
        st.lagMeters <= 5 &&
        Array.isArray(traj.stopAlongs) &&
        traj.stopAlongs.length > 0
      ) {
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

      const maxAccel = targetSpeed > 11 ? 1.85 : 1.15;
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

        if (st.lagMeters > 0) {
          const consumed = Math.min(st.lagMeters, actualMove);
          st.lagMeters -= consumed;
          st.deadReckonMeters += actualMove - consumed;
        } else {
          st.deadReckonMeters += actualMove;
        }
      }

      if (st.overshootMeters > 0 && !st.isStopped && st.cruiseSpeedMps > 0.5) {
        const estimatedRealAdvance = st.cruiseSpeedMps * dt;
        const netCatchup = Math.max(0, estimatedRealAdvance - actualMove);
        st.overshootMeters = Math.max(0, st.overshootMeters - netCatchup);
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
      if (src.desvio) bus.desvio = src.desvio;
      if (src.ultimaFechaHoraGPS) bus.ultimaFechaHoraGPS = src.ultimaFechaHoraGPS;
      if (src.gpsTimeOnly) bus.gpsTimeOnly = src.gpsTimeOnly;
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

    const prevLat = bus.lat;
    const prevLng = bus.lng;
    const moved =
      typeof prevLat !== 'number' ||
      typeof prevLng !== 'number' ||
      Math.abs(sample.lat - prevLat) > 1.5e-6 ||
      Math.abs(sample.lng - prevLng) > 1.5e-6;

    bus._posChanged = moved;
    bus.trajectory = st.activeTraj;
    if (moved) {
      bus.lat = sample.lat;
      bus.lng = sample.lng;
    }
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
