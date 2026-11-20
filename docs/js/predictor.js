import {
  pickStopBranches,
  pickIncomingBranches,
  projectOnPolyline,
  sampleBranchAtAlong,
  buildTrajectoryFromBranchAlong
} from './trajectory.js';
import {
  computeProximityPercent,
  parseDesvioHorario,
  formatGpsTimeOnly,
  distanceMeters
} from './api.js';
import { getLineColor } from './config.js';

const modelCacheByBranches = new WeakMap(); // branches[] -> Map<`${codLinea}:${tipoDia}`, LineScheduleModel>

function getBranchKey(b) {
  return `${b?.index ?? 0}:${b?.git || normalizeBandera(b?.bandera || '')}`;
}

export function normalizeBandera(str = '') {
  return String(str || '')
    .toUpperCase()
    .replace(/[º°]/g, 'O')
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
}

export function parseTimeToSec(hhmmss = '') {
  const m = String(hhmmss || '').trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  return parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseInt(m[3] || '0', 10);
}

export function parseGpsStampSecOfDay(raw = '') {
  const m = String(raw || '').trim().match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return null;
  return parseInt(m[4], 10) * 3600 + parseInt(m[5], 10) * 60 + parseInt(m[6], 10);
}

export function formatSecHHMM(sec) {
  const norm = ((Math.round(sec) % 86400) + 86400) % 86400;
  const hh = Math.floor(norm / 3600);
  const mm = Math.floor((norm % 3600) / 60);
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

export function formatDesvioFromSec(sec = 0) {
  const s = Math.round(sec || 0);
  if (Math.abs(s) < 10) return '00:00';
  const sign = s >= 0 ? '+' : '-';
  const abs = Math.abs(s);
  const mm = Math.floor(abs / 60);
  const ss = abs % 60;
  return `${sign}${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

export function getArgentinaSecOfDay(date = new Date()) {
  const art = new Date(date.getTime() - 3 * 3600 * 1000);
  return art.getUTCHours() * 3600 + art.getUTCMinutes() * 60 + art.getUTCSeconds() + art.getUTCMilliseconds() / 1000;
}

export function getArgentinaDayKey(date = new Date()) {
  const art = new Date(date.getTime() - 3 * 3600 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${art.getUTCFullYear()}-${pad(art.getUTCMonth() + 1)}-${pad(art.getUTCDate())}`;
}

/**
 * Gradual, physically realistic deviation recovery after a bus loses GPS or goes offline:
 *  - A late bus (initialOffsetSec < 0) stays late and recovers gently (~4.8 s per real minute, i.e. 1.08x speed)
 *  - An early bus (initialOffsetSec > 0) stays ahead and eases gently (~3.6 s per real minute, i.e. 0.94x speed)
 * Never snaps magically to 00:00 on-time punctuality!
 */
export function computeGradualOffsetSec(initialOffsetSec = 0, elapsedSec = 0) {
  const init = Number.isFinite(initialOffsetSec) ? initialOffsetSec : 0;
  const el = Math.max(0, Number.isFinite(elapsedSec) ? elapsedSec : 0);
  if (init < 0) {
    return Math.min(0, init + el * 0.08);
  }
  if (init > 0) {
    return Math.max(0, init - el * 0.06);
  }
  return 0;
}

/**
 * Picks the best available day-type in a line's timetable archive.
 * Exact match first; if unavailable (e.g. Sunday before first Sunday scan), gracefully falls back.
 */
export function resolveAvailableTipoDia(horariosFile, requestedTipo = 'habil') {
  const paradas = horariosFile?.paradas;
  if (!paradas || typeof paradas !== 'object') return null;

  const fallbackOrder =
    requestedTipo === 'domingo'
      ? ['domingo', 'sabado', 'habil']
      : requestedTipo === 'sabado'
        ? ['sabado', 'habil', 'domingo']
        : ['habil', 'sabado', 'domingo'];

  for (const tipo of fallbackOrder) {
    for (const entry of Object.values(paradas)) {
      if (Array.isArray(entry?.[tipo]) && entry[tipo].length > 0) {
        return { tipo, exact: tipo === requestedTipo };
      }
    }
  }
  return null;
}

/**
 * Reconstructs all monotonic scheduled trips on a single route branch using every stop's
 * exact HH:MM:SS timetable entries from `docs/data/horarios/<codLinea>.json`.
 */
function reconstructBranchTrips(branch, horariosFile, tipoDia) {
  const banderas = Array.isArray(horariosFile?.banderas) ? horariosFile.banderas : [];
  const normBranchBandera = normalizeBandera(branch.bandera);
  const paradasMap = horariosFile?.paradas || {};

  const matchingBanderaIdx = new Set();
  banderas.forEach((b, idx) => {
    const nb = normalizeBandera(b);
    if (nb && normBranchBandera && (nb === normBranchBandera || nb.includes(normBranchBandera) || normBranchBandera.includes(nb))) {
      matchingBanderaIdx.add(idx);
    }
  });

  const stopSchedules = [];
  const seenStopId = new Set();
  for (const st of branch.orderedStops || []) {
    if (seenStopId.has(st.id)) continue;
    const rawList = paradasMap[st.id]?.[tipoDia];
    if (!Array.isArray(rawList) || rawList.length === 0) continue;

    const times = [];
    for (const raw of rawList) {
      const [timeStr, idxStr = '0'] = String(raw).split('|');
      const bIdx = Number(idxStr);
      if (matchingBanderaIdx.size > 0 && !matchingBanderaIdx.has(bIdx)) continue;
      const sec = parseTimeToSec(timeStr);
      if (sec !== null) times.push(sec);
    }
    if (times.length === 0) continue;
    times.sort((a, b) => a - b);
    seenStopId.add(st.id);
    stopSchedules.push({ stopId: st.id, along: st.along, times });
  }

  if (stopSchedules.length === 0) return [];

  const trips = [];
  for (let sIdx = 0; sIdx < stopSchedules.length; sIdx++) {
    const st = stopSchedules[sIdx];
    const usedTrips = new Set();

    for (const rawSec of st.times) {
      let bestTrip = null;
      let bestScore = Infinity;

      for (const tr of trips) {
        if (usedTrips.has(tr)) continue;
        const last = tr.points[tr.points.length - 1];
        if (last.sIdx >= sIdx) continue;

        let sec = rawSec;
        if (last.sec >= 21 * 3600 && sec < 3 * 3600) {
          sec += 86400;
        }

        const dt = sec - last.sec;
        const dist = Math.max(0, st.along - last.along);
        const expectedDt = dist / 5.3;
        const maxDt = Math.max(270, dist / 1.15 + 210);
        if (dt < -25 || dt > maxDt) continue;

        const score = Math.abs(dt - expectedDt);
        if (score < bestScore) {
          bestScore = score;
          bestTrip = { tr, sec };
        }
      }

      if (bestTrip) {
        const last = bestTrip.tr.points[bestTrip.tr.points.length - 1];
        const safeSec = Math.max(last.sec + 1, bestTrip.sec);
        bestTrip.tr.points.push({ sIdx, stopId: st.id, along: st.along, sec: safeSec });
        usedTrips.add(bestTrip.tr);
      } else {
        trips.push({
          branch,
          points: [{ sIdx, stopId: st.id, along: st.along, sec: rawSec }]
        });
      }
    }
  }

  const validTrips = trips.filter((tr) => tr.points.length >= 2 || stopSchedules.length === 1);
  const finalized = [];
  const usedKeys = new Set();

  for (const tr of validTrips) {
    const pts = tr.points;
    const first = pts[0];
    const last = pts[pts.length - 1];
    const avgSpeed =
      pts.length >= 2 && last.sec > first.sec
        ? Math.max(2.5, Math.min(11, (last.along - first.along) / (last.sec - first.sec)))
        : 5.0;

    const fullPts = pts.map((p) => ({ stopId: p.stopId, along: p.along, sec: p.sec }));
    if (first.along > 25) {
      const startSec = first.sec - first.along / avgSpeed;
      fullPts.unshift({ stopId: null, along: 0, sec: startSec });
    }
    if (branch.totalLen - last.along > 25) {
      const endSec = last.sec + (branch.totalLen - last.along) / avgSpeed;
      fullPts.push({ stopId: null, along: branch.totalLen, sec: endSec });
    }

    const startSec = fullPts[0].sec;
    const endSec = fullPts[fullPts.length - 1].sec;
    const stopTimeMap = new Map();
    for (const p of pts) {
      if (p.stopId) stopTimeMap.set(p.stopId, p.sec);
    }

    let tripKey = `${normBranchBandera}@${formatSecHHMM(startSec)}`;
    if (usedKeys.has(tripKey)) {
      tripKey = `${normBranchBandera}@${formatSecHHMM(startSec)}:${Math.round(startSec % 60)}`;
    }
    usedKeys.add(tripKey);

    finalized.push({
      tripKey,
      branch,
      points: fullPts,
      startSec,
      endSec,
      stopTimeMap,
      prevTrip: null,
      nextTrip: null
    });
  }

  finalized.sort((a, b) => a.startSec - b.startSec);
  return finalized;
}

/**
 * Builds and caches the complete space-time schedule model for one line and day type,
 * chaining incoming feeder/return branches across cabeceras (supporting 2-, 3- and 4-branch lines).
 */
export function buildLineScheduleModel(codLinea, branches = [], horariosFile = null, requestedTipo = 'habil') {
  if (!codLinea || !Array.isArray(branches) || branches.length === 0 || !horariosFile) return null;

  const resolved = resolveAvailableTipoDia(horariosFile, requestedTipo);
  if (!resolved) return null;

  let byTipo = modelCacheByBranches.get(branches);
  if (!byTipo) {
    byTipo = new Map();
    modelCacheByBranches.set(branches, byTipo);
  }
  const cacheKey = `${codLinea}:${resolved.tipo}`;
  if (byTipo.has(cacheKey)) {
    return byTipo.get(cacheKey);
  }

  const branchTrips = new Map(); // branchKey -> Trip[]
  for (const b of branches) {
    const trips = reconstructBranchTrips(b, horariosFile, resolved.tipo);
    branchTrips.set(getBranchKey(b), trips);
  }

  // Chain incoming feeder/return trips across cabeceras (layover 10 s .. 45 min)
  const claimedReturn = new Set();
  for (const b of branches) {
    const feeders = pickIncomingBranches(branches, b);
    const tripsB = branchTrips.get(getBranchKey(b)) || [];
    if (!tripsB.length || !feeders.length) continue;

    const feederTrips = feeders.flatMap((fb) => branchTrips.get(getBranchKey(fb)) || []);
    if (!feederTrips.length) continue;

    for (const t of tripsB) {
      let bestPrev = null;
      let bestLayover = Infinity;
      for (const r of feederTrips) {
        if (claimedReturn.has(r)) continue;
        const layover = t.startSec - r.endSec;
        if (layover >= 10 && layover <= 45 * 60 && layover < bestLayover) {
          bestLayover = layover;
          bestPrev = r;
        }
      }
      if (bestPrev) {
        claimedReturn.add(bestPrev);
        t.prevTrip = bestPrev;
        bestPrev.nextTrip = t;
      }
    }
  }

  const model = {
    codLinea: Number(codLinea),
    tipoDia: resolved.tipo,
    exactTipo: resolved.exact,
    branches,
    branchTrips,
    getTripsForBranch: (b) => branchTrips.get(getBranchKey(b)) || []
  };
  byTipo.set(cacheKey, model);
  return model;
}

/**
 * Computes the scheduled passage second of `trip` at a target spatial coordinate `along` (meters).
 */
export function getTripSecAtAlong(trip, along) {
  const pts = trip?.points;
  if (!pts || pts.length === 0) return null;
  if (along <= pts[0].along) return pts[0].sec;
  if (along >= pts[pts.length - 1].along) return pts[pts.length - 1].sec;
  let lo = 0;
  let hi = pts.length - 2;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (pts[mid + 1].along < along) lo = mid + 1;
    else hi = mid;
  }
  const a = pts[lo];
  const b = pts[lo + 1];
  const span = Math.max(0.001, b.along - a.along);
  const targetFrac = Math.max(0, Math.min(1, (along - a.along) / span));
  // Exact inverse of evalPointsAtSec's monotonic S-curve so evalPointsAtSec(secAt(along)) === along
  let u = targetFrac;
  for (let i = 0; i < 4; i++) {
    const f = 0.84 * u + 0.08 * (1 - Math.cos(Math.PI * u)) - targetFrac;
    const df = 0.84 + 0.08 * Math.PI * Math.sin(Math.PI * u);
    u -= f / df;
  }
  return a.sec + Math.max(0, Math.min(1, u)) * (b.sec - a.sec);
}

/**
 * Computes the scheduled passage second of `trip` at a target stop (by exact stopId or by `along` interpolation).
 */
export function getTripStopSec(trip, stopId, stopAlong) {
  const cleanId = String(stopId || '').trim().toUpperCase();
  if (cleanId && trip.stopTimeMap.has(cleanId)) {
    return trip.stopTimeMap.get(cleanId);
  }
  return getTripSecAtAlong(trip, stopAlong);
}

/**
 * Evaluates a single branch trip's exact position `along(t)` and speed at effective clock `tEff` (seconds of day).
 */
function evalPointsAtSec(points, tEff) {
  if (!points || points.length === 0) return null;
  if (tEff <= points[0].sec) {
    return { along: points[0].along, speedMps: 0 };
  }
  const last = points[points.length - 1];
  if (tEff >= last.sec) {
    return { along: last.along, speedMps: 0 };
  }
  let lo = 0;
  let hi = points.length - 2;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid + 1].sec < tEff) lo = mid + 1;
    else hi = mid;
  }
  const a = points[lo];
  const b = points[lo + 1];
  const dt = Math.max(0.5, b.sec - a.sec);
  const dist = Math.max(0, b.along - a.along);
  const u = Math.max(0, Math.min(1, (tEff - a.sec) / dt));
  const uSmooth = 0.84 * u + 0.16 * (0.5 - 0.5 * Math.cos(Math.PI * u));
  const duDt = (0.84 + 0.16 * 0.5 * Math.PI * Math.sin(Math.PI * u)) / dt;
  return {
    along: a.along + dist * uSmooth,
    speedMps: Math.max(0, Math.min(11.5, dist * duDt))
  };
}

/**
 * Builds a spatial-temporal GPS anchor for `trip` from a last-known GPS fix `(lat, lng, clockSec)`.
 * Anchoring guarantees that prediction starts RIGHT AT the bus's exact last GPS position (0 m jump)
 * with its real accumulated delay/advance, and then recovers gradually (~4.8 s/min) instead of
 * snapping magically to on-time punctuality!
 */
export function buildGpsAnchorForTrip(trip, lat, lng, clockSec, fallbackDesvioSec = 0) {
  if (!trip || typeof lat !== 'number' || typeof lng !== 'number' || Number.isNaN(lat) || Number.isNaN(lng)) {
    return null;
  }
  if (!Number.isFinite(clockSec)) return null;

  const stopProj = projectOnPolyline(trip.branch.pts, trip.branch.cum, lat, lng);
  const prevProj = trip.prevTrip
    ? projectOnPolyline(trip.prevTrip.branch.pts, trip.prevTrip.branch.cum, lat, lng)
    : null;

  // Decide whether the last GPS fix lies on `trip.branch` or `trip.prevTrip.branch`
  let chosenBranch = null;
  let chosenTrip = null;
  let chosenProj = null;

  const onStopOk = stopProj && stopProj.perp <= 150;
  const onPrevOk = prevProj && prevProj.perp <= 150;

  if (onStopOk && onPrevOk) {
    // Compare time consistency against both branches using fallbackDesvioSec
    const effAnchor = clockSec + (fallbackDesvioSec || 0);
    const stopSched = getTripSecAtAlong(trip, stopProj.along);
    const prevSched = getTripSecAtAlong(trip.prevTrip, prevProj.along);
    const errStop = stopSched !== null ? Math.abs(stopSched - effAnchor) : Infinity;
    const errPrev = prevSched !== null ? Math.abs(prevSched - effAnchor) : Infinity;
    if (errPrev + 120 < errStop) {
      chosenBranch = trip.prevTrip.branch;
      chosenTrip = trip.prevTrip;
      chosenProj = prevProj;
    } else {
      chosenBranch = trip.branch;
      chosenTrip = trip;
      chosenProj = stopProj;
    }
  } else if (onStopOk) {
    chosenBranch = trip.branch;
    chosenTrip = trip;
    chosenProj = stopProj;
  } else if (onPrevOk) {
    chosenBranch = trip.prevTrip.branch;
    chosenTrip = trip.prevTrip;
    chosenProj = prevProj;
  } else {
    return null;
  }

  const schedSecAtAnchor = getTripSecAtAlong(chosenTrip, chosenProj.along);
  if (schedSecAtAnchor === null) return null;

  let adjClock = clockSec;
  if (schedSecAtAnchor > 86400 && adjClock < 6 * 3600) adjClock += 86400;
  let rawOffset = schedSecAtAnchor - adjClock;
  if (rawOffset > 43200) rawOffset -= 86400;
  if (rawOffset < -43200) rawOffset += 86400;

  // Sanity guard: ignore anchor if > 60 min off schedule (stale/different cycle)
  if (Math.abs(rawOffset) > 60 * 60) return null;

  return {
    branch: chosenBranch,
    isStopBranch: chosenBranch === trip.branch,
    along: chosenProj.along,
    clockSec: adjClock,
    initialOffsetSec: rawOffset
  };
}

/**
 * Evaluates the exact real-time state of a scheduled trip approaching `stopProj` on `trip.branch`.
 * When `anchor` is supplied (from live GPS loss or FleetMemory), the bus starts RIGHT FROM its last
 * GPS position and gradually recovers its delay/advance instead of jumping magically to on-time!
 */
export function evaluateTripState(
  trip,
  stopId,
  stopProj,
  nowSec,
  desvioSec = 0,
  { maxAheadSec = 120 * 60, anchor = null } = {}
) {
  if (!trip || !stopProj) return null;
  const targetStopSec = getTripStopSec(trip, stopId, stopProj.along);
  if (targetStopSec === null) return null;

  let effNow = nowSec;
  if (targetStopSec > 86400 && effNow < 6 * 3600) {
    effNow += 86400;
  }

  // If anchored to a real GPS fix that is ALREADY physically past `stopProj.along` on `stopBranch`,
  // this trip ALREADY PASSED the stop -> never generate a ghost arrival!
  if (anchor && anchor.isStopBranch && anchor.along > stopProj.along + 60) {
    return null;
  }

  let effectiveOffsetSec = desvioSec || 0;
  if (anchor && Number.isFinite(anchor.clockSec) && Number.isFinite(anchor.initialOffsetSec)) {
    const elapsedSec = Math.max(0, effNow - anchor.clockSec);
    effectiveOffsetSec = computeGradualOffsetSec(anchor.initialOffsetSec, elapsedSec);
  }

  const tEff = effNow + effectiveOffsetSec;
  const etaSec = targetStopSec - tEff;

  // Already passed the stop by more than 45 s, or beyond horizon
  if (etaSec < -45 || etaSec > maxAheadSec) return null;

  const stopBranch = trip.branch;

  // 1) Directly on stopBranch (or arriving at stop)
  if (tEff >= trip.startSec) {
    const ev = evalPointsAtSec(trip.points, Math.min(tEff, targetStopSec));
    const along = Math.min(stopProj.along, ev.along);
    const sample = sampleBranchAtAlong(stopBranch, along);
    if (!sample) return null;
    const remainingMeters = Math.max(0, stopProj.along - along);
    // Speed scales naturally with gradual recovery factor (1.08x when late, 0.94x when early)
    const speedFactor = effectiveOffsetSec < -30 ? 1.08 : effectiveOffsetSec > 30 ? 0.94 : 1.0;
    return {
      activeBranch: stopBranch,
      activeAlong: along,
      lat: sample.lat,
      lng: sample.lng,
      remainingMeters,
      etaSec: Math.max(0, etaSec),
      speedMps: remainingMeters <= 5 ? 0 : Math.min(11.5, ev.speedMps * speedFactor),
      isAtTerminal: along <= 120 && tEff <= trip.startSec + 20,
      inOppositeLeg: false,
      realBandera: stopBranch.bandera,
      realBanderaColor: stopBranch.color,
      effectiveOffsetSec,
      targetStopSec
    };
  }

  // 2) Before departure from cabecera: if chained return leg (`trip.prevTrip`) is currently active
  if (trip.prevTrip) {
    const prev = trip.prevTrip;
    if (tEff >= prev.startSec && tEff < prev.endSec) {
      const ev = evalPointsAtSec(prev.points, tEff);
      const sample = sampleBranchAtAlong(prev.branch, ev.along);
      if (!sample) return null;
      const oppRem = Math.max(0, prev.branch.totalLen - ev.along);
      const remainingMeters = oppRem + stopProj.along;
      const speedFactor = effectiveOffsetSec < -30 ? 1.08 : effectiveOffsetSec > 30 ? 0.94 : 1.0;
      return {
        activeBranch: prev.branch,
        activeAlong: ev.along,
        lat: sample.lat,
        lng: sample.lng,
        remainingMeters,
        etaSec: Math.max(0, etaSec),
        speedMps: Math.min(11.5, ev.speedMps * speedFactor),
        isAtTerminal: oppRem <= 120,
        inOppositeLeg: true,
        realBandera: prev.branch.bandera,
        realBanderaColor: prev.branch.color,
        effectiveOffsetSec,
        targetStopSec
      };
    }
  }

  // 3) Waiting / staging at origin cabecera until scheduled departure (`trip.startSec`)
  const sample = sampleBranchAtAlong(stopBranch, 0);
  if (!sample) return null;
  return {
    activeBranch: stopBranch,
    activeAlong: 0,
    lat: sample.lat,
    lng: sample.lng,
    remainingMeters: stopProj.along,
    etaSec: Math.max(0, etaSec),
    speedMps: 0,
    isAtTerminal: true,
    inOppositeLeg: false,
    realBandera: stopBranch.bandera,
    realBanderaColor: stopBranch.color,
    effectiveOffsetSec,
    targetStopSec
  };
}

/**
 * Matches a single bus `(lat, lng, desvioSec, etaMin, leg)` directly to its exact scheduled trip
 * using spatial-temporal curve alignment `|trip.secAt(busAlong) - (nowSec + desvioSec)|`!
 * Works accurately even when a bus is +20 min early or -40 min late!
 */
function scoreBusAgainstCandidate(bus, item, nowSec, stickyTripKey, busNormBandera) {
  const desvioSec = bus.desvio?.seconds || 0;
  const hasDesvio = bus.desvio && bus.desvio.status !== 'none';
  const isSticky = Boolean(stickyTripKey && item.trip.tripKey === stickyTripKey);

  // ── Signal A: Exact spatial-temporal match using GPS coordinate + SmartMovePro desvio ──
  // Independent of SmartMovePro's noisy ETA and works even if the bus is 30 min late or 15 min early!
  let spatialDiffSec = Infinity;
  if (typeof bus.lat === 'number' && typeof bus.lng === 'number' && hasDesvio) {
    const tEff = nowSec + desvioSec;
    const onStopProj = projectOnPolyline(item.branch.pts, item.branch.cum, bus.lat, bus.lng);
    const isOpp = bus.trajectory?.leg === 'previous_leg' || bus.isOppositeLeg;

    if (!isOpp && onStopProj && onStopProj.perp <= 160) {
      const schedAtBus = getTripSecAtAlong(item.trip, onStopProj.along);
      if (schedAtBus !== null) {
        let d = Math.abs((schedAtBus % 86400) - ((tEff % 86400) + 86400) % 86400);
        if (d > 43200) d = 86400 - d;
        spatialDiffSec = d;
      }
    } else if (isOpp && item.trip.prevTrip) {
      const prevBr = item.trip.prevTrip.branch;
      const onPrevProj = projectOnPolyline(prevBr.pts, prevBr.cum, bus.lat, bus.lng);
      if (onPrevProj && onPrevProj.perp <= 160) {
        const schedAtBus = getTripSecAtAlong(item.trip.prevTrip, onPrevProj.along);
        if (schedAtBus !== null) {
          let d = Math.abs((schedAtBus % 86400) - ((tEff % 86400) + 86400) % 86400);
          if (d > 43200) d = 86400 - d;
          spatialDiffSec = d;
        }
      }
    }
  }

  // ── Signal B: ETA + Desvio match (`Now + ETA + Desvio` vs `targetStopSec`) ──
  let etaDiffSec = Infinity;
  if (bus.eta && bus.eta.valid !== false && typeof bus.eta.minutes === 'number' && bus.eta.minutes <= 240) {
    const expectedSec = ((nowSec + bus.eta.minutes * 60 + desvioSec) % 86400 + 86400) % 86400;
    const normSt = item.stSec % 86400;
    let d = Math.abs(normSt - expectedSec);
    if (d > 43200) d = 86400 - d;
    etaDiffSec = d;
  }

  // Combine both signals: spatial-temporal dominates when available (exact even at ±35 min off-schedule!)
  let bestRawDiff;
  let maxAllowed;
  if (spatialDiffSec <= 14 * 60) {
    // Also verify ETA isn't pointing to a completely different cycle (> 45 min apart)
    if (etaDiffSec < Infinity && etaDiffSec > 45 * 60) return null;
    bestRawDiff = spatialDiffSec;
    maxAllowed = isSticky ? 18 * 60 : 14 * 60;
  } else {
    if (etaDiffSec === Infinity) return null;
    let baseTolMin = (bus.eta?.minutes || 0) >= 35 || !hasDesvio ? 18 : 14;
    if (bus.esExtendido || bus.isOppositeLeg) baseTolMin += 5;
    if (Math.abs(desvioSec) >= 6 * 60) baseTolMin += 5; // very early/late buses have wider ETA variance
    maxAllowed = isSticky ? Math.max(baseTolMin * 60, 24 * 60) : baseTolMin * 60;
    bestRawDiff = etaDiffSec;
  }

  if (bestRawDiff > maxAllowed) return null;

  let score = bestRawDiff;
  if (isSticky) score -= 5 * 60;
  if (busNormBandera && item.normBandera && item.normBandera !== busNormBandera) {
    score += 3 * 60;
  }
  return score;
}

/**
 * Matches live GPS buses of one line to their exact canonical scheduled `trip` & `turnoProgramado`
 * across ALL branches serving `stopId`. Uses spatial-temporal matching (`|secAt(busAlong) - (now + desvio)|`)
 * + ETA consistency + sticky-coche stability so even very early (+15m) or very late (-35m) buses
 * are linked accurately without spawning ghost arrivals!
 */
export function matchLiveBusesToTrips(
  model,
  stopId,
  stopCoords,
  buses = [],
  nowSec = getArgentinaSecOfDay(),
  { stickyTripByCoche = null } = {}
) {
  const matches = new Map();
  if (!model || !Array.isArray(buses) || buses.length === 0) return matches;

  const stopBranches = pickStopBranches(model.branches, stopId, stopCoords, buses[0]?.descripcionBandera || '');
  if (stopBranches.length === 0) return matches;

  const pool = [];
  for (const sb of stopBranches) {
    const sp = stopCoords ? projectOnPolyline(sb.pts, sb.cum, stopCoords.lat, stopCoords.lng) : null;
    for (const tr of model.getTripsForBranch(sb)) {
      const stSec = getTripStopSec(tr, stopId, sp?.along ?? 0);
      if (stSec !== null) {
        pool.push({ trip: tr, branch: sb, stopProj: sp, stSec, normBandera: normalizeBandera(sb.bandera) });
      }
    }
  }
  if (pool.length === 0) return matches;

  const usedTrips = new Set();
  const ordered = [...buses].sort((a, b) => (a.eta?.minutes ?? 999) - (b.eta?.minutes ?? 999));

  for (const bus of ordered) {
    const stickyKey = bus.identificadorCoche ? `${model.codLinea}:${bus.identificadorCoche}` : null;
    const stickyRec = stickyKey && stickyTripByCoche ? stickyTripByCoche.get(stickyKey) : null;
    const stickyTripKey = stickyRec?.tripKey || null;
    const busNormBandera = normalizeBandera(bus.descripcionBandera || '');

    let bestItem = null;
    let bestScore = Infinity;

    for (const item of pool) {
      if (usedTrips.has(item.trip)) continue;
      const score = scoreBusAgainstCandidate(bus, item, nowSec, stickyTripKey, busNormBandera);
      if (score !== null && score < bestScore) {
        bestScore = score;
        bestItem = item;
      }
    }

    if (bestItem) {
      usedTrips.add(bestItem.trip);
      const turnoHora = formatSecHHMM(bestItem.stSec);
      bus.turnoProgramado = turnoHora;
      bus.tripKey = bestItem.trip.tripKey;
      bus.scheduledTrip = bestItem.trip;
      bus.stopProj = bestItem.stopProj;
      matches.set(bus.key, {
        trip: bestItem.trip,
        tripKey: bestItem.trip.tripKey,
        prevTripKey: bestItem.trip.prevTrip?.tripKey || null,
        turnoHora,
        targetStopSec: bestItem.stSec
      });
    }
  }

  return matches;
}

/**
 * Detects trips that have ALREADY PASSED `stopId` (e.g. a bus running 5+ minutes early that already
 * cleared `stopId` before its scheduled pass time!) by checking:
 *  1) Live buses on `full_cycle` physically positioned PAST `stopProj.along` on `stopBranch`
 *  2) Downstream terminal-probe live buses physically PAST `stopProj.along` on `stopBranch`
 *  3) Central system `FleetMemory` (`trips` & `units` from the last 40 min) already past `stopProj.along`
 *     OR already running `trip.nextTrip`!
 *
 * Returns a `Set<tripKey>` of trips proven to have already passed `stopId` -> ZERO ghost arrivals!
 */
export function detectAlreadyPassedTrips({
  codLinea,
  stopId,
  stopCoords,
  branches = [],
  horariosFile = null,
  tipoDia = 'habil',
  liveBuses = [],
  downstreamBuses = [],
  fleetMemory = null,
  nowSec = getArgentinaSecOfDay()
}) {
  const passed = new Set();
  const model = buildLineScheduleModel(codLinea, branches, horariosFile, tipoDia);
  if (!model || !stopCoords) return passed;

  const stopBranches = pickStopBranches(branches, stopId, stopCoords);
  if (stopBranches.length === 0) return passed;

  const nowMs = Date.now();

  // Build lookup of known active tripKeys and coche -> tripKeys from FleetMemory
  const activeMemTripKeys = new Set();
  const activeMemTripsByCoche = new Map();
  for (const rec of fleetMemory?.trips || []) {
    if (Number(rec.codigoLinea) !== Number(codLinea)) continue;
    if (rec.updatedAt && nowMs - rec.updatedAt <= 45 * 60 * 1000 && rec.tripKey) {
      activeMemTripKeys.add(rec.tripKey);
      if (rec.coche) {
        const ck = String(rec.coche).trim();
        if (!activeMemTripsByCoche.has(ck)) activeMemTripsByCoche.set(ck, new Set());
        activeMemTripsByCoche.get(ck).add(rec.tripKey);
      }
    }
  }

  // Helper: given a bus coordinate + desvio + clockSec physically past `stopProj.along` on `stopBranch`,
  // identify the exact trip on `stopBranch` that just passed `stopId`!
  const markPassedBySpatialFix = (
    stopBranch,
    stopProj,
    trips,
    lat,
    lng,
    desvioSec,
    clockSec,
    banderaHint = '',
    cocheId = ''
  ) => {
    if (typeof lat !== 'number' || typeof lng !== 'number' || Number.isNaN(lat) || Number.isNaN(lng)) return;
    if (banderaHint) {
      const nh = normalizeBandera(banderaHint);
      const nb = normalizeBandera(stopBranch.bandera);
      if (nh && nb && nh !== nb && !nh.includes(nb) && !nb.includes(nh)) return;
    }
    const proj = projectOnPolyline(stopBranch.pts, stopBranch.cum, lat, lng);
    if (!proj || proj.perp > 140) return;
    // Must be genuinely PAST this stop along stopBranch!
    if (proj.along <= stopProj.along + 65) return;

    // If FleetMemory already knows which trip on this branch this exact coche is running, mark it immediately!
    const cleanCoche = String(cocheId || '').trim();
    if (cleanCoche && activeMemTripsByCoche.has(cleanCoche)) {
      for (const tk of activeMemTripsByCoche.get(cleanCoche)) {
        if (trips.some((t) => t.tripKey === tk)) {
          passed.add(tk);
        }
      }
    }

    const tEff = clockSec + (desvioSec || 0);
    let bestTrip = null;
    let bestDiff = 16 * 60; // up to 16 min tolerance even if desvio slightly noisy

    for (const tr of trips) {
      const schedAtBus = getTripSecAtAlong(tr, proj.along);
      if (schedAtBus === null) continue;
      let d = Math.abs((schedAtBus % 86400) - ((tEff % 86400) + 86400) % 86400);
      if (d > 43200) d = 86400 - d;
      if (d < bestDiff) {
        bestDiff = d;
        bestTrip = tr;
      }
    }
    if (bestTrip) {
      passed.add(bestTrip.tripKey);
    }
  };

  for (const stopBranch of stopBranches) {
    const stopProj = projectOnPolyline(stopBranch.pts, stopBranch.cum, stopCoords.lat, stopCoords.lng);
    if (!stopProj) continue;
    const trips = model.getTripsForBranch(stopBranch);

    // 1) If a trip's `nextTrip` (return leg!) is ALREADY active in FleetMemory, this trip already finished!
    for (const tr of trips) {
      if (tr.nextTrip && activeMemTripKeys.has(tr.nextTrip.tripKey)) {
        passed.add(tr.tripKey);
      }
    }

    // 2) Live buses on `full_cycle` (already passed stopId) + downstream terminal probe buses
    for (const b of [...liveBuses, ...downstreamBuses]) {
      if (Number(b.codigoLinea) !== Number(codLinea)) continue;
      const lat = typeof b.lat === 'number' ? b.lat : parseFloat(b.latitud);
      const lng = typeof b.lng === 'number' ? b.lng : parseFloat(b.longitud);
      const desvioSec =
        typeof b.desvio?.seconds === 'number'
          ? b.desvio.seconds
          : parseDesvioHorario(b.desvioHorario || '').seconds;
      const isLiveFullCycle = b.trajectory?.leg === 'full_cycle';
      const isDownstream = !b.trajectory; // raw downstream probe bus
      if (isLiveFullCycle || isDownstream) {
        const hint = b.realBandera || b.descripcionBandera || '';
        const cocheId = b.identificadorCoche || b.coche || '';
        markPassedBySpatialFix(stopBranch, stopProj, trips, lat, lng, desvioSec, nowSec, hint, cocheId);
      }
    }

    // 3) Recent FleetMemory `trips` & `units` physically seen past `stopId` on `stopBranch`
    for (const rec of fleetMemory?.trips || []) {
      if (Number(rec.codigoLinea) !== Number(codLinea)) continue;
      if (rec.updatedAt && nowMs - rec.updatedAt > 45 * 60 * 1000) continue;
      const lat = Number(rec.lat);
      const lng = Number(rec.lng);
      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        const proj = projectOnPolyline(stopBranch.pts, stopBranch.cum, lat, lng);
        if (proj && proj.perp <= 140 && proj.along > stopProj.along + 65) {
          if (trips.some((t) => t.tripKey === rec.tripKey)) {
            passed.add(rec.tripKey);
          }
        }
      }
    }

    for (const u of fleetMemory?.units || []) {
      if (Number(u.codigoLinea) !== Number(codLinea)) continue;
      if (u.updatedAt && nowMs - u.updatedAt > 40 * 60 * 1000) continue;
      const lat = Number(u.lat);
      const lng = Number(u.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      const uClock =
        parseGpsStampSecOfDay(u.ultimaGps) ??
        (u.updatedAt ? getArgentinaSecOfDay(new Date(u.updatedAt)) : nowSec);
      markPassedBySpatialFix(stopBranch, stopProj, trips, lat, lng, u.desvioSec || 0, uClock, u.bandera || '', u.coche || '');
    }
  }

  return passed;
}

/**
 * Synthesizes realistic, street-following predicted bus objects across ALL branches serving `stopId`
 * for active/upcoming scheduled turns that currently have NO live GPS unit.
 *
 * Anchors to last known online GPS position from `fleetMemory` when available so predicted buses
 * start right from their last real spot and gradually recover delay instead of snapping to on-time!
 */
export function predictLineBusesForStop({
  codLinea,
  lineName,
  stopId,
  stopCoords,
  branches = [],
  horariosFile = null,
  tipoDia = 'habil',
  nowSec = getArgentinaSecOfDay(),
  liveMatchedTripKeys = new Set(),
  liveMatchedCoches = new Set(),
  completedTripKeys = new Set(),
  activePredKeys = new Set(),
  fleetMemory = null,
  maxUpcoming = 4,
  maxAheadMin = 65
}) {
  const model = buildLineScheduleModel(codLinea, branches, horariosFile, tipoDia);
  if (!model || !stopCoords) return [];

  const stopBranches = pickStopBranches(branches, stopId, stopCoords);
  if (stopBranches.length === 0) return [];

  // Index system FleetMemory trips for this line
  const memByTrip = new Map();
  if (fleetMemory && Array.isArray(fleetMemory.trips)) {
    for (const rec of fleetMemory.trips) {
      if (Number(rec.codigoLinea) === Number(codLinea) && rec.tripKey) {
        memByTrip.set(rec.tripKey, rec);
      }
    }
  }

  const nowMs = Date.now();
  const candidates = [];
  const seenTripKeys = new Set();

  for (const stopBranch of stopBranches) {
    const stopProj = projectOnPolyline(stopBranch.pts, stopBranch.cum, stopCoords.lat, stopCoords.lng);
    if (!stopProj) continue;

    const trips = model.getTripsForBranch(stopBranch);
    for (const trip of trips) {
      if (seenTripKeys.has(trip.tripKey)) continue;
      if (liveMatchedTripKeys.has(trip.tripKey)) continue;
      if (completedTripKeys.has(trip.tripKey) || completedTripKeys.has(`${codLinea}:${trip.tripKey}`)) continue;

      const predKey = `pred:${codLinea}:${trip.tripKey}`;
      const isAlreadyVisible = activePredKeys.has(predKey);
      const effectiveMaxAheadSec = (isAlreadyVisible ? maxAheadMin + 6 : maxAheadMin) * 60;

      // Look up system memory for this trip (or its preceding return leg!)
      let mem = memByTrip.get(trip.tripKey) || null;
      let memFromPrev = false;
      if (!mem && trip.prevTrip) {
        mem = memByTrip.get(trip.prevTrip.tripKey) || null;
        memFromPrev = Boolean(mem);
      }
      if (mem && mem.coche && liveMatchedCoches.has(mem.coche)) {
        mem = null;
      }

      // Build spatial-temporal GPS anchor from last online fix so the bus starts from its exact last GPS spot
      // and gradually recovers its delay/advance (~4.8 s/min late recovery, never magically on time!)
      let anchor = null;
      let desvioSec = 0;
      if (mem) {
        const ageMin = mem.updatedAt ? (nowMs - mem.updatedAt) / 60000 : 999;
        if (ageMin <= 90) {
          const memClockSec =
            parseGpsStampSecOfDay(mem.ultimaGps) ??
            (mem.updatedAt ? getArgentinaSecOfDay(new Date(mem.updatedAt)) : nowSec);
          const mLat = Number(mem.lat);
          const mLng = Number(mem.lng);
          if (Number.isFinite(mLat) && Number.isFinite(mLng) && mLat !== 0 && mLng !== 0) {
            anchor = buildGpsAnchorForTrip(trip, mLat, mLng, memClockSec, mem.desvioSec || 0);
          }
          if (!anchor && Number.isFinite(mem.desvioSec)) {
            const baseInit = memFromPrev
              ? Math.max(-1800, Math.min(900, mem.desvioSec * 0.7))
              : Math.max(-2400, Math.min(1500, mem.desvioSec));
            const elapsedSec = Math.max(0, nowSec - memClockSec);
            desvioSec = computeGradualOffsetSec(baseInit, elapsedSec);
          }
        }
      }

      const ev = evaluateTripState(trip, stopId, stopProj, nowSec, desvioSec, {
        maxAheadSec: effectiveMaxAheadSec,
        anchor
      });
      if (!ev) continue;

      const curOffset = ev.effectiveOffsetSec || 0;
      const desvioRaw = mem ? formatDesvioFromSec(curOffset) : '';

      seenTripKeys.add(trip.tripKey);
      candidates.push({ trip, stopBranch, stopProj, ev, mem, anchor, desvioSec: curOffset, desvioRaw, predKey });
    }
  }

  candidates.sort((a, b) => a.ev.etaSec - b.ev.etaSec);

  const usedCoches = new Set(liveMatchedCoches);
  const predicted = [];

  for (const item of candidates) {
    if (predicted.length >= maxUpcoming) break;

    const { trip, stopBranch, stopProj, ev, anchor, desvioSec, desvioRaw, predKey } = item;
    let mem = item.mem;
    if (mem?.coche && usedCoches.has(mem.coche)) {
      mem = null;
    }

    const traj = buildTrajectoryFromBranchAlong(ev.activeBranch, ev.activeAlong, stopBranch, stopProj, {
      isAtTerminal: ev.isAtTerminal,
      etaSec: ev.etaSec
    });
    if (!traj) continue;

    if (mem?.coche) usedCoches.add(mem.coche);

    const mins = Math.ceil(ev.etaSec / 60);
    const eta =
      ev.etaSec <= 40 || ev.remainingMeters <= 45
        ? { minutes: 0, valid: true, display: 'YA', unit: 'Arribando', urgency: 'now' }
        : {
            minutes: mins,
            valid: true,
            display: `${mins}`,
            unit: 'min',
            urgency: mins <= 3 ? 'now' : mins <= 9 ? 'soon' : 'later'
          };

    const turnoHora = formatSecHHMM(ev.targetStopSec);
    const desvio = desvioRaw
      ? parseDesvioHorario(desvioRaw)
      : { raw: '', status: 'none', label: '', shortLabel: '', sign: '', minutes: 0, seconds: 0 };
    const lastGpsTime = mem?.ultimaGps ? formatGpsTimeOnly(mem.ultimaGps) : '';
    const coche = mem?.coche || '';

    predicted.push({
      key: predKey,
      codigoLinea: Number(codLinea),
      descripcionLinea: lineName || `L${codLinea}`,
      descripcionBandera: stopBranch.bandera,
      descripcionCartelBandera: stopBranch.bandera,
      tiempoRaw: eta.minutes === 0 ? 'Arribando..' : `${eta.minutes} min. est.`,
      eta,
      etaSecondsRemaining: ev.etaSec,
      esAdaptado: Boolean(mem?.esAdaptado),
      esLleno: false,
      esExtendido: false,
      viaParada: null,
      turnoProgramado: turnoHora,
      tripKey: trip.tripKey,
      scheduledTrip: trip,
      stopProj,
      predAnchor: anchor,
      predDesvioSec: desvioSec,
      isPredicted: true,
      predictionReason: mem ? 'last-online' : 'schedule',
      lat: ev.lat,
      lng: ev.lng,
      distanceMeters: ev.remainingMeters,
      routeMeters: ev.remainingMeters,
      proximityPct: computeProximityPercent(eta.minutes, ev.remainingMeters),
      identificadorCoche: coche,
      choferNombre: mem?.choferNombre || '',
      choferLegajo: mem?.choferLegajo || '',
      choferRaw: mem?.choferRaw || '',
      desvio,
      ultimaFechaHoraGPS: mem?.ultimaGps || '',
      gpsTimeOnly: lastGpsTime ? `últ. ${lastGpsTime.slice(0, 5)}` : '',
      trajectory: traj,
      isOppositeLeg: ev.inOppositeLeg,
      isNextCycle: false,
      realBandera: ev.realBandera || stopBranch.bandera,
      realBanderaColor: ev.realBanderaColor || getLineColor(lineName)
    });
  }

  return predicted;
}
