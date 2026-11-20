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
        ? Math.max(2.5, Math.min(22, (last.along - first.along) / (last.sec - first.sec)))
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

  // Step 1: Estimate each branch's natural arrival-to-departure layover at its origin cabecera
  // (e.g. 0-2 min at quick-turnaround cabeceras like Puerto/Centro vs 8-15 min at rest cabeceras)
  const feedersByKey = new Map();
  const branchTypicalLaySec = new Map();
  for (const b of branches) {
    const bKey = getBranchKey(b);
    const feeders = pickIncomingBranches(branches, b);
    feedersByKey.set(bKey, feeders);
    const tripsB = branchTrips.get(bKey) || [];
    const feederTrips = feeders.flatMap((fb) => branchTrips.get(getBranchKey(fb)) || []);
    const samples = [];
    for (const t of tripsB) {
      let bestPos = Infinity;
      let bestNeg = null;
      for (const r of feederTrips) {
        const lay = t.startSec - r.endSec;
        if (lay >= 0 && lay <= 25 * 60 && lay < bestPos) bestPos = lay;
        else if (lay >= -90 && lay < 0 && (bestNeg === null || Math.abs(lay) < Math.abs(bestNeg))) bestNeg = lay;
      }
      if (bestPos < Infinity || bestNeg !== null) {
        samples.push(bestNeg !== null && Math.abs(bestNeg) < bestPos ? bestNeg : bestPos);
      }
    }
    samples.sort((a, c) => a - c);
    const med = samples.length > 0 ? samples[Math.floor(samples.length / 2)] : 300;
    branchTypicalLaySec.set(bKey, med);
  }

  // Step 2: Chain incoming feeder/return trips chronologically across ALL branches (2-, 3- and 4-branch lines)
  const allTripItems = branches
    .flatMap((b) => (branchTrips.get(getBranchKey(b)) || []).map((trip) => ({ b, bKey: getBranchKey(b), trip })))
    .sort((a, c) => a.trip.startSec - c.trip.startSec);

  const claimedReturn = new Set();
  for (const { bKey, trip: t } of allTripItems) {
    const feeders = feedersByKey.get(bKey) || [];
    if (!feeders.length) continue;
    const feederTrips = feeders.flatMap((fb) => branchTrips.get(getBranchKey(fb)) || []);
    if (!feederTrips.length) continue;

    const typicalLay = branchTypicalLaySec.get(bKey) ?? 300;
    let bestPrev = null;
    let bestScore = Infinity;

    for (const r of feederTrips) {
      if (claimedReturn.has(r)) continue;
      const lay = t.startSec - r.endSec;
      if (lay < -90 || lay > 45 * 60) continue;

      let score = Math.abs(lay - typicalLay);
      if (lay < 0 && typicalLay >= 150) {
        score += 600; // never match an unarrived bus at a rest cabecera when a resting bus is waiting
      } else if (lay < 0) {
        score += 45;
      }
      // Subtle FIFO bias so earlier-waiting buses depart first during multi-bus terminal queues
      score -= Math.min(Math.max(0, lay), 15 * 60) * 0.04;

      if (score < bestScore) {
        bestScore = score;
        bestPrev = r;
      }
    }

    if (bestPrev) {
      claimedReturn.add(bestPrev);
      t.prevTrip = bestPrev;
      bestPrev.nextTrip = t;
    }
  }

  // Step 3: Materialize full day-long vehicle blocks (`trip.block` & `trip.blockIndex`)
  let blockSeq = 0;
  const tripByKey = new Map();
  for (const { trip } of allTripItems) {
    tripByKey.set(trip.tripKey, trip);
    if (trip.prevTrip) continue;
    const blockId = `blk:${codLinea}:${resolved.tipo}:${++blockSeq}`;
    const block = [];
    let cur = trip;
    const visited = new Set();
    while (cur && !visited.has(cur)) {
      visited.add(cur);
      cur.blockId = blockId;
      cur.block = block;
      cur.blockIndex = block.length;
      block.push(cur);
      cur = cur.nextTrip;
    }
  }

  const model = {
    codLinea: Number(codLinea),
    tipoDia: resolved.tipo,
    exactTipo: resolved.exact,
    branches,
    branchTrips,
    tripByKey,
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
    speedMps: Math.max(0, Math.min(25.0, dist * duDt))
  };
}

/**
 * Builds a spatial-temporal GPS anchor for `trip` from a last-known GPS fix `(lat, lng, clockSec)`.
 * Evaluates up to 3 legs along the vehicle block (`trip`, `prevTrip`, and `prevTrip.prevTrip` / full_cycle)
 * choosing the leg whose scheduled time at the GPS projection best matches `clockSec + fallbackDesvioSec`.
 * Guarantees 0 m jump on GPS loss and preserves accumulated delay/advance with gradual recovery!
 */
export function buildGpsAnchorForTrip(trip, lat, lng, clockSec, fallbackDesvioSec = 0) {
  if (!trip || typeof lat !== 'number' || typeof lng !== 'number' || Number.isNaN(lat) || Number.isNaN(lng)) {
    return null;
  }
  if (!Number.isFinite(clockSec)) return null;

  const candidates = [{ t: trip, depth: 0 }];
  if (trip.prevTrip) {
    candidates.push({ t: trip.prevTrip, depth: 1 });
    if (trip.prevTrip.prevTrip) {
      candidates.push({ t: trip.prevTrip.prevTrip, depth: 2 });
    }
  }

  let best = null;
  let bestScore = Infinity;

  for (const cand of candidates) {
    const proj = projectOnPolyline(cand.t.branch.pts, cand.t.branch.cum, lat, lng);
    if (!proj || proj.perp > 150) continue;

    const schedSecAtAnchor = getTripSecAtAlong(cand.t, proj.along);
    if (schedSecAtAnchor === null) continue;

    let adjClock = clockSec;
    if (schedSecAtAnchor > 86400 && adjClock < 6 * 3600) adjClock += 86400;
    let rawOffset = schedSecAtAnchor - adjClock;
    if (rawOffset > 43200) rawOffset -= 86400;
    if (rawOffset < -43200) rawOffset += 86400;

    // Sanity guard: ignore anchor if > 60 min off schedule (stale/different cycle)
    if (Math.abs(rawOffset) > 60 * 60) continue;

    // Score against known desvioSec so buses near turnarounds (shared streets) lock to the exact real leg!
    let desvioErr = Math.abs(rawOffset - (fallbackDesvioSec || 0));
    if (desvioErr > 43200) desvioErr = 86400 - desvioErr;
    const score = desvioErr + cand.depth * 25;

    if (score < bestScore) {
      bestScore = score;
      best = {
        branch: cand.t.branch,
        isStopBranch: cand.depth === 0,
        legDepth: cand.depth,
        along: proj.along,
        clockSec: adjClock,
        initialOffsetSec: rawOffset
      };
    }
  }

  return best;
}

/**
 * Evaluates the exact real-time state of a scheduled trip approaching `stopProj` on `trip.branch`
 * across up to 3 vehicle-block legs (`trip`, `prevTrip`, and `prevTrip.prevTrip` / `full_cycle`).
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

  // Only reject as already-passed if anchored directly on THIS trip (`legDepth === 0`) past `stopProj.along`!
  // Never reject a `legDepth === 2` (`full_cycle`) bus finishing the previous lap!
  const isAnchorOnThisLeg = anchor && (anchor.legDepth === 0 || (anchor.legDepth === undefined && anchor.isStopBranch));
  if (isAnchorOnThisLeg && anchor.along > stopProj.along + 60) {
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
  const speedFactor = effectiveOffsetSec < -30 ? 1.08 : effectiveOffsetSec > 30 ? 0.94 : 1.0;

  // 1) Directly on stopBranch (`legDepth = 0`, approaching or arriving at stop)
  if (tEff >= trip.startSec) {
    const ev = evalPointsAtSec(trip.points, Math.min(tEff, targetStopSec));
    const along = Math.min(stopProj.along, ev.along);
    const sample = sampleBranchAtAlong(stopBranch, along);
    if (!sample) return null;
    const remainingMeters = Math.max(0, stopProj.along - along);
    return {
      activeBranch: stopBranch,
      activeAlong: along,
      viaBranch: null,
      legDepth: 0,
      lat: sample.lat,
      lng: sample.lng,
      remainingMeters,
      etaSec: Math.max(0, etaSec),
      speedMps: remainingMeters <= 5 ? 0 : Math.min(25.0, ev.speedMps * speedFactor),
      isAtTerminal: along <= 120 && tEff <= trip.startSec + 20,
      inOppositeLeg: false,
      inNextCycle: false,
      realBandera: stopBranch.bandera,
      realBanderaColor: stopBranch.color,
      effectiveOffsetSec,
      targetStopSec
    };
  }

  // 2) Chained return/feeder leg (`trip.prevTrip`, `legDepth = 1`) and turnaround layovers
  if (trip.prevTrip) {
    const prev = trip.prevTrip;

    // 2a) Resting at `trip` origin cabecera between `prev.endSec` and `trip.startSec`
    if (tEff >= prev.endSec) {
      const sample = sampleBranchAtAlong(stopBranch, 0);
      if (!sample) return null;
      return {
        activeBranch: stopBranch,
        activeAlong: 0,
        viaBranch: null,
        legDepth: 0,
        lat: sample.lat,
        lng: sample.lng,
        remainingMeters: stopProj.along,
        etaSec: Math.max(0, etaSec),
        speedMps: 0,
        isAtTerminal: true,
        inOppositeLeg: false,
        inNextCycle: false,
        realBandera: stopBranch.bandera,
        realBanderaColor: stopBranch.color,
        effectiveOffsetSec,
        targetStopSec
      };
    }

    // 2b) Actively driving on `prevTrip` (`legDepth = 1`)
    if (tEff >= prev.startSec) {
      const ev = evalPointsAtSec(prev.points, tEff);
      const sample = sampleBranchAtAlong(prev.branch, ev.along);
      if (!sample) return null;
      const oppRem = Math.max(0, prev.branch.totalLen - ev.along);
      const remainingMeters = oppRem + stopProj.along;
      return {
        activeBranch: prev.branch,
        activeAlong: ev.along,
        viaBranch: null,
        legDepth: 1,
        lat: sample.lat,
        lng: sample.lng,
        remainingMeters,
        etaSec: Math.max(0, etaSec),
        speedMps: Math.min(25.0, ev.speedMps * speedFactor),
        isAtTerminal: oppRem <= 120,
        inOppositeLeg: true,
        inNextCycle: false,
        realBandera: prev.branch.bandera,
        realBanderaColor: prev.branch.color,
        effectiveOffsetSec,
        targetStopSec
      };
    }

    // 2c) Previous lap (`trip.prevTrip.prevTrip`, `legDepth = 2` -> `full_cycle`)!
    if (prev.prevTrip) {
      const pp = prev.prevTrip;

      // Resting at `prevTrip` origin cabecera between `pp.endSec` and `prev.startSec`
      if (tEff >= pp.endSec) {
        const sample = sampleBranchAtAlong(prev.branch, 0);
        if (!sample) return null;
        return {
          activeBranch: prev.branch,
          activeAlong: 0,
          viaBranch: null,
          legDepth: 1,
          lat: sample.lat,
          lng: sample.lng,
          remainingMeters: prev.branch.totalLen + stopProj.along,
          etaSec: Math.max(0, etaSec),
          speedMps: 0,
          isAtTerminal: true,
          inOppositeLeg: true,
          inNextCycle: false,
          realBandera: prev.branch.bandera,
          realBanderaColor: prev.branch.color,
          effectiveOffsetSec,
          targetStopSec
        };
      }

      // Actively driving on `prev.prevTrip` (`full_cycle`: `pp` -> `prev` -> `trip`)
      if (tEff >= pp.startSec) {
        const ev = evalPointsAtSec(pp.points, tEff);
        const sample = sampleBranchAtAlong(pp.branch, ev.along);
        if (!sample) return null;
        const ppRem = Math.max(0, pp.branch.totalLen - ev.along);
        const remainingMeters = ppRem + prev.branch.totalLen + stopProj.along;
        return {
          activeBranch: pp.branch,
          activeAlong: ev.along,
          viaBranch: prev.branch,
          legDepth: 2,
          lat: sample.lat,
          lng: sample.lng,
          remainingMeters,
          etaSec: Math.max(0, etaSec),
          speedMps: Math.min(25.0, ev.speedMps * speedFactor),
          isAtTerminal: ppRem <= 120,
          inOppositeLeg: false,
          inNextCycle: true,
          realBandera: pp.branch.bandera,
          realBanderaColor: pp.branch.color,
          effectiveOffsetSec,
          targetStopSec
        };
      }
    }
  }

  // 3) Waiting / staging at origin cabecera (first pull-out or unchained trip)
  const sample = sampleBranchAtAlong(stopBranch, 0);
  if (!sample) return null;
  return {
    activeBranch: stopBranch,
    activeAlong: 0,
    viaBranch: null,
    legDepth: 0,
    lat: sample.lat,
    lng: sample.lng,
    remainingMeters: stopProj.along,
    etaSec: Math.max(0, etaSec),
    speedMps: 0,
    isAtTerminal: true,
    inOppositeLeg: false,
    inNextCycle: false,
    realBandera: stopBranch.bandera,
    realBanderaColor: stopBranch.color,
    effectiveOffsetSec,
    targetStopSec
  };
}

/**
 * Matches a single bus `(lat, lng, desvioSec, etaMin, leg)` directly to its exact scheduled trip
 * using spatial-temporal curve alignment `|trip.secAt(busAlong) - (nowSec + desvioSec)|` across
 * up to 3 vehicle-block legs (`direct`, `previous_leg`, and `full_cycle`)!
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
    const normEff = ((tEff % 86400) + 86400) % 86400;
    const leg = bus.trajectory?.leg;
    const isOpp = leg === 'previous_leg' || bus.isOppositeLeg;
    const isFullCycle = leg === 'full_cycle' || bus.isNextCycle || bus.isNextLap;

    const testTripSpatial = (tr) => {
      if (!tr) return Infinity;
      const proj = projectOnPolyline(tr.branch.pts, tr.branch.cum, bus.lat, bus.lng);
      if (!proj || proj.perp > 160) return Infinity;
      const schedAtBus = getTripSecAtAlong(tr, proj.along);
      if (schedAtBus === null) return Infinity;
      let d = Math.abs((schedAtBus % 86400) - normEff);
      if (d > 43200) d = 86400 - d;
      return d;
    };

    if (isFullCycle) {
      // Bus is finishing the previous lap (`prevTrip.prevTrip`) or just turning onto `prevTrip`
      spatialDiffSec = Math.min(
        testTripSpatial(item.trip.prevTrip?.prevTrip),
        testTripSpatial(item.trip.prevTrip)
      );
    } else if (isOpp) {
      spatialDiffSec = Math.min(
        testTripSpatial(item.trip.prevTrip),
        testTripSpatial(item.trip.prevTrip?.prevTrip)
      );
    } else {
      spatialDiffSec = testTripSpatial(item.trip);
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
    const stickyKey = !bus.isNextLap && bus.identificadorCoche ? `${model.codLinea}:${bus.identificadorCoche}` : null;
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

    const tEff = clockSec + (desvioSec || 0);
    const normEff = ((tEff % 86400) + 86400) % 86400;

    // If FleetMemory already knows which trip on this branch this exact coche is running AND that trip
    // is time-consistent at `proj.along` (so a full_cycle bus never marks its NEXT lap!), mark it passed!
    const cleanCoche = String(cocheId || '').trim();
    if (cleanCoche && activeMemTripsByCoche.has(cleanCoche)) {
      for (const tk of activeMemTripsByCoche.get(cleanCoche)) {
        const tr = trips.find((t) => t.tripKey === tk);
        if (!tr) continue;
        const schedAtBus = getTripSecAtAlong(tr, proj.along);
        if (schedAtBus === null) continue;
        let d = Math.abs((schedAtBus % 86400) - normEff);
        if (d > 43200) d = 86400 - d;
        if (d <= 28 * 60) {
          passed.add(tk);
        }
      }
    }

    let bestTrip = null;
    let bestDiff = 16 * 60; // up to 16 min tolerance even if desvio slightly noisy

    for (const tr of trips) {
      const schedAtBus = getTripSecAtAlong(tr, proj.along);
      if (schedAtBus === null) continue;
      let d = Math.abs((schedAtBus % 86400) - normEff);
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

    // 2) Live buses on `full_cycle` (already passed stopId) + downstream/corridor probe buses
    for (const b of [...liveBuses, ...downstreamBuses]) {
      if (Number(b.codigoLinea) !== Number(codLinea)) continue;
      const lat = typeof b.lat === 'number' ? b.lat : parseFloat(b.latitud);
      const lng = typeof b.lng === 'number' ? b.lng : parseFloat(b.longitud);
      const desvioSec =
        typeof b.desvio?.seconds === 'number'
          ? b.desvio.seconds
          : parseDesvioHorario(b.desvioHorario || '').seconds;
      const isLiveFullCycle = b.trajectory?.leg === 'full_cycle';
      const isDownstream = !b.trajectory; // raw downstream/corridor probe bus
      if (isLiveFullCycle || isDownstream) {
        const hint = b.realBandera || b.descripcionBandera || '';
        const cocheId = b.identificadorCoche || b.coche || '';
        const bClock = parseGpsStampSecOfDay(b.ultimaFechaHoraGPS || b.ultimaGps || '') ?? nowSec;
        markPassedBySpatialFix(stopBranch, stopProj, trips, lat, lng, desvioSec, bClock, hint, cocheId);
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
 * Propagates a bus's current schedule deviation (`srcDesvioSec`) forward across intermediate cabeceras
 * in its vehicle block (`block[srcIdx] -> ... -> block[targetIdx]`).
 *  - Early buses (`> 0`) wait out their advance at cabeceras and depart future laps on time (`0`).
 *  - Heavily delayed buses (`< 0`) absorb layover slack (leaving at least 2 min turnaround) plus
 *    gradual en-route recovery, carrying only genuine residual delay into the next lap!
 */
function propagateBlockDesvioSec(block, srcIdx, targetIdx, srcDesvioSec = 0, elapsedSec = 0) {
  if (!Array.isArray(block) || targetIdx <= srcIdx) {
    return computeGradualOffsetSec(srcDesvioSec || 0, elapsedSec);
  }
  const curOffset = computeGradualOffsetSec(srcDesvioSec || 0, elapsedSec);
  if (curOffset >= 0) return 0; // early/on-time buses reset at cabeceras

  let absorbableSec = 0;
  let enRouteTravelSec = 0;
  for (let i = srcIdx; i < targetIdx; i++) {
    const a = block[i];
    const b = block[i + 1];
    if (!a || !b) continue;
    const lay = Math.max(0, b.startSec - a.endSec);
    // Keep at least 120 s minimum physical turnaround before absorbing delay
    absorbableSec += Math.max(0, lay - 120);
    enRouteTravelSec += Math.max(0, (a.endSec - a.startSec) * (i === srcIdx ? 0.5 : 1));
  }
  // Also account for gradual en-route recovery (~3 s/min across intermediate travel)
  absorbableSec += enRouteTravelSec * 0.05;
  return Math.min(0, curOffset + absorbableSec);
}

/**
 * Computes the exact physical street distance (meters) from `stopId` on `block[srcIdx]` through
 * all intermediate legs to `stopProj` on `block[targetIdx]`.
 * Adding `srcBus.routeMeters` yields the true multi-lap distance (never a bogus cabecera distance!).
 */
function computeExtraMetersAcrossBlock(block, srcIdx, targetIdx, stopCoords, stopProj) {
  if (!Array.isArray(block) || targetIdx <= srcIdx || !stopProj) return 0;
  const srcTrip = block[srcIdx];
  let extra = 0;
  if (srcTrip?.branch && stopCoords) {
    const srcStopProj = projectOnPolyline(srcTrip.branch.pts, srcTrip.branch.cum, stopCoords.lat, stopCoords.lng);
    if (srcStopProj && srcStopProj.perp <= 160) {
      extra += Math.max(0, srcTrip.branch.totalLen - srcStopProj.along);
    } else {
      extra += srcTrip.branch.totalLen * 0.5;
    }
  }
  for (let i = srcIdx + 1; i < targetIdx; i++) {
    extra += block[i]?.branch?.totalLen || 0;
  }
  extra += stopProj.along;
  return Math.max(0, extra);
}

/**
 * Synthesizes realistic, street-following predicted bus objects across ALL branches serving `stopId`
 * for active/upcoming scheduled turns that currently have NO live GPS unit — AND links future turns
 * belonging to the SAME vehicle block (`Sig. vuelta`) directly to their real circulating bus & driver!
 *
 * Anchors to live Corridor Radar (`corridorBuses`) and last known online GPS (`fleetMemory`) so predicted
 * buses start right from their exact real spot and gradually recover delay instead of snapping to on-time!
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
  liveBusByTripKey = new Map(),
  corridorBuses = [],
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

  const nowMs = Date.now();

  // Index system FleetMemory trips for this line
  const memByTrip = new Map();
  const knownCoches = new Set(liveMatchedCoches);
  if (fleetMemory && Array.isArray(fleetMemory.trips)) {
    for (const rec of fleetMemory.trips) {
      if (Number(rec.codigoLinea) === Number(codLinea) && rec.tripKey) {
        memByTrip.set(rec.tripKey, rec);
        if (rec.coche) knownCoches.add(String(rec.coche).trim());
      }
    }
  }

  // Helper: spatially match a live corridor probe bus or FleetMemory unit onto its exact trip in `model`
  const ingestObservedUnit = (u, { allowOverwriteOlder = false } = {}) => {
    if (Number(u.codigoLinea) !== Number(codLinea)) return;
    const cleanCoche = String(u.identificadorCoche || u.coche || '').trim();
    if (!cleanCoche) return;
    if (!allowOverwriteOlder && knownCoches.has(cleanCoche)) return;
    if (liveMatchedCoches.has(cleanCoche)) return;
    if (u.updatedAt && nowMs - u.updatedAt > 35 * 60 * 1000) return;

    const uLat = typeof u.lat === 'number' ? u.lat : parseFloat(u.latitud);
    const uLng = typeof u.lng === 'number' ? u.lng : parseFloat(u.longitud);
    if (!Number.isFinite(uLat) || !Number.isFinite(uLng) || (uLat === 0 && uLng === 0)) return;

    const ultimaGps = u.ultimaFechaHoraGPS || u.ultimaGps || '';
    const desvioSec =
      typeof u.desvioSec === 'number'
        ? u.desvioSec
        : parseDesvioHorario(u.desvioHorario || '').seconds;
    const uClock =
      parseGpsStampSecOfDay(ultimaGps) ??
      (u.updatedAt ? getArgentinaSecOfDay(new Date(u.updatedAt)) : nowSec);
    const tEff = uClock + (desvioSec || 0);
    const normEff = ((tEff % 86400) + 86400) % 86400;
    const uNormBandera = normalizeBandera(u.descripcionBandera || u.bandera || '');

    let bestTr = null;
    let bestDiff = 14 * 60;
    for (const b of branches) {
      if (uNormBandera) {
        const nb = normalizeBandera(b.bandera);
        if (nb && uNormBandera !== nb && !uNormBandera.includes(nb) && !nb.includes(uNormBandera)) continue;
      }
      const proj = projectOnPolyline(b.pts, b.cum, uLat, uLng);
      if (!proj || proj.perp > 140) continue;
      for (const tr of model.getTripsForBranch(b)) {
        const sched = getTripSecAtAlong(tr, proj.along);
        if (sched === null) continue;
        let d = Math.abs((sched % 86400) - normEff);
        if (d > 43200) d = 86400 - d;
        if (d < bestDiff) {
          bestDiff = d;
          bestTr = tr;
        }
      }
    }

    if (bestTr) {
      const existing = memByTrip.get(bestTr.tripKey);
      const uTs = u.updatedAt || nowMs;
      if (!existing || (allowOverwriteOlder && uTs >= (existing.updatedAt || 0))) {
        memByTrip.set(bestTr.tripKey, {
          codigoLinea: Number(codLinea),
          tripKey: bestTr.tripKey,
          coche: cleanCoche,
          choferNombre: u.choferNombre || '',
          choferLegajo: u.choferLegajo || '',
          choferRaw: u.choferRaw || u.identificadorChofer || '',
          esAdaptado: Boolean(u.esAdaptado),
          desvioSec: desvioSec || 0,
          ultimaGps,
          lat: uLat,
          lng: uLng,
          updatedAt: uTs
        });
        knownCoches.add(cleanCoche);
      }
    }
  };

  // 1) Ingest LIVE Corridor Radar sightings FIRST (real-time GPS from parallel upstream/downstream/opposite probes!)
  for (const cb of corridorBuses || []) {
    ingestObservedUnit(cb, { allowOverwriteOlder: true });
  }

  // 2) Enrich with recent `fleetMemory.units` (last 35 min across the city) for any remaining units
  for (const u of fleetMemory?.units || []) {
    ingestObservedUnit(u, { allowOverwriteOlder: false });
  }

  // Index live buses by coche so we never assign a live coche from Block A onto Block B via stale memory
  const liveBlockByCoche = new Map();
  for (const [tk, lb] of liveBusByTripKey.entries()) {
    const tr = model.tripByKey?.get(tk);
    if (lb?.identificadorCoche && tr?.blockId) {
      liveBlockByCoche.set(String(lb.identificadorCoche).trim(), tr.blockId);
    }
  }

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

      const block = trip.block || [trip];
      const targetIdx = typeof trip.blockIndex === 'number' ? trip.blockIndex : 0;

      // ── Step A: Check if an EARLIER trip in the EXACT SAME vehicle block is currently LIVE! ──
      // (e.g. Coche 2595 doing 21:25 right now IS the exact bus scheduled for 23:09 on its next lap!)
      let liveBlockSrc = null;
      for (let i = targetIdx - 1; i >= Math.max(0, targetIdx - 6); i--) {
        const earlier = block[i];
        if (!earlier) continue;
        const lb = liveBusByTripKey.get(earlier.tripKey);
        if (lb) {
          liveBlockSrc = { bus: lb, srcIdx: i, srcTrip: earlier };
          break;
        }
      }

      if (liveBlockSrc) {
        const targetStopSec = getTripStopSec(trip, stopId, stopProj.along);
        if (targetStopSec === null) continue;
        let effNow = nowSec;
        if (targetStopSec > 86400 && effNow < 6 * 3600) effNow += 86400;

        const srcBus = liveBlockSrc.bus;
        const propagatedDesvio = propagateBlockDesvioSec(
          block,
          liveBlockSrc.srcIdx,
          targetIdx,
          srcBus.desvio?.seconds || 0,
          0
        );
        const etaSec = targetStopSec - (effNow + propagatedDesvio);
        if (etaSec < -45 || etaSec > effectiveMaxAheadSec) continue;

        const extraMeters = computeExtraMetersAcrossBlock(block, liveBlockSrc.srcIdx, targetIdx, stopCoords, stopProj);
        const baseRem = srcBus.routeMeters ?? srcBus.distanceMeters ?? 0;
        const totalRemMeters = Math.max(stopProj.along, baseRem + extraMeters);
        const desvioRaw = Math.abs(propagatedDesvio) >= 60 ? formatDesvioFromSec(propagatedDesvio) : '';

        seenTripKeys.add(trip.tripKey);
        candidates.push({
          trip,
          stopBranch,
          stopProj,
          predKey,
          anchor: null,
          desvioSec: propagatedDesvio,
          desvioRaw,
          mem: null,
          liveBlockSrc: {
            bus: srcBus,
            extraMeters,
            isLive: !srcBus.isPredicted && !srcBus.gpsLost
          },
          ev: {
            activeBranch: stopBranch,
            activeAlong: 0,
            viaBranch: null,
            legDepth: 0,
            lat: srcBus.lat,
            lng: srcBus.lng,
            remainingMeters: totalRemMeters,
            etaSec: Math.max(0, etaSec),
            speedMps: 0,
            isAtTerminal: false,
            inOppositeLeg: Boolean(srcBus.isOppositeLeg),
            inNextCycle: true,
            realBandera: srcBus.realBandera || srcBus.descripcionBandera || stopBranch.bandera,
            realBanderaColor: srcBus.realBanderaColor || stopBranch.color,
            effectiveOffsetSec: propagatedDesvio,
            targetStopSec
          }
        });
        continue;
      }

      // ── Step A2: Forward vehicle-block check! ──
      // If a LATER trip in this exact block is already matched to a live bus (e.g. SmartMovePro only returned
      // its next lap while the bus is still physically on THIS imminent trip or just passed it!),
      // NEVER spawn an anonymous offline ghost!
      let futureLiveSrc = null;
      for (let i = targetIdx + 1; i <= Math.min(block.length - 1, targetIdx + 4); i++) {
        const later = block[i];
        if (!later) continue;
        const lb = liveBusByTripKey.get(later.tripKey);
        if (lb && !lb.isNextLap) {
          futureLiveSrc = { bus: lb, laterIdx: i, laterTrip: later };
          break;
        }
      }

      if (futureLiveSrc) {
        const srcBus = futureLiveSrc.bus;
        const fLat = srcBus.lat;
        const fLng = srcBus.lng;
        if (typeof fLat === 'number' && typeof fLng === 'number') {
          const projThis = projectOnPolyline(stopBranch.pts, stopBranch.cum, fLat, fLng);
          const projNext = trip.nextTrip
            ? projectOnPolyline(trip.nextTrip.branch.pts, trip.nextTrip.branch.cum, fLat, fLng)
            : null;
          // 1) Already physically passed `stopId` on this trip, or already running the return leg -> suppress ghost!
          if (projThis && projThis.perp <= 150 && projThis.along > stopProj.along + 65) {
            continue;
          }
          if (projNext && projNext.perp <= 140 && (!projThis || projThis.perp > 150)) {
            continue;
          }
          // 2) Still physically approaching `stopId` on this trip (or its prevTrip) -> bind directly to live bus!
          const liveAnchor = buildGpsAnchorForTrip(trip, fLat, fLng, nowSec, srcBus.desvio?.seconds || 0);
          if (liveAnchor) {
            const ev = evaluateTripState(trip, stopId, stopProj, nowSec, srcBus.desvio?.seconds || 0, {
              maxAheadSec: effectiveMaxAheadSec,
              anchor: liveAnchor
            });
            if (ev) {
              const curOffset = ev.effectiveOffsetSec || srcBus.desvio?.seconds || 0;
              const desvioRaw = srcBus.desvio?.raw || formatDesvioFromSec(curOffset);
              seenTripKeys.add(trip.tripKey);
              candidates.push({
                trip,
                stopBranch,
                stopProj,
                ev,
                mem: null,
                anchor: liveAnchor,
                desvioSec: curOffset,
                desvioRaw,
                predKey,
                liveBlockSrc: null,
                promotedLiveSrc: { bus: srcBus, laterIdx: futureLiveSrc.laterIdx }
              });
              continue;
            }
          }
          // Earlier trip in same block already behind the live bus -> never emit a ghost
          continue;
        }
      }

      // ── Step B: Otherwise, walk this trip's vehicle block backwards in FleetMemory (up to 6 legs) ──
      let mem = null;
      let memIdx = targetIdx;
      for (let i = targetIdx; i >= Math.max(0, targetIdx - 6); i--) {
        const rec = memByTrip.get(block[i]?.tripKey);
        if (!rec) continue;
        const ageMin = rec.updatedAt ? (nowMs - rec.updatedAt) / 60000 : 999;
        if (ageMin > 150) continue;
        // Guard: if this coche is currently live on a DIFFERENT vehicle block, ignore stale memory
        const recCoche = String(rec.coche || '').trim();
        if (recCoche && liveBlockByCoche.has(recCoche) && liveBlockByCoche.get(recCoche) !== trip.blockId) {
          continue;
        }
        mem = rec;
        memIdx = i;
        break;
      }

      const memDepth = targetIdx - memIdx;

      // Build spatial-temporal GPS anchor from last online fix so the bus starts from its exact last GPS spot
      // and gradually recovers its delay/advance (~4.8 s/min late recovery, never magically on time!)
      let anchor = null;
      let desvioSec = 0;
      if (mem) {
        const ageMin = mem.updatedAt ? (nowMs - mem.updatedAt) / 60000 : 999;
        const memClockSec =
          parseGpsStampSecOfDay(mem.ultimaGps) ??
          (mem.updatedAt ? getArgentinaSecOfDay(new Date(mem.updatedAt)) : nowSec);
        const elapsedSec = Math.max(0, nowSec - memClockSec);

        if (memDepth <= 2 && ageMin <= 90) {
          const mLat = Number(mem.lat);
          const mLng = Number(mem.lng);
          if (Number.isFinite(mLat) && Number.isFinite(mLng) && mLat !== 0 && mLng !== 0) {
            anchor = buildGpsAnchorForTrip(trip, mLat, mLng, memClockSec, mem.desvioSec || 0);
          }
        }
        if (!anchor && Number.isFinite(mem.desvioSec)) {
          desvioSec = propagateBlockDesvioSec(block, memIdx, targetIdx, mem.desvioSec, elapsedSec);
        }
      }

      const ev = evaluateTripState(trip, stopId, stopProj, nowSec, desvioSec, {
        maxAheadSec: effectiveMaxAheadSec,
        anchor
      });
      if (!ev) continue;

      const curOffset = ev.effectiveOffsetSec || 0;
      const desvioRaw =
        mem && (memDepth === 0 || anchor || Math.abs(curOffset) >= 60) ? formatDesvioFromSec(curOffset) : '';

      seenTripKeys.add(trip.tripKey);
      candidates.push({
        trip,
        stopBranch,
        stopProj,
        ev,
        mem,
        memDepth,
        anchor,
        desvioSec: curOffset,
        desvioRaw,
        predKey,
        liveBlockSrc: null,
        promotedLiveSrc: null
      });
    }
  }

  candidates.sort((a, b) => a.ev.etaSec - b.ev.etaSec);

  const usedCoches = new Set(liveMatchedCoches);
  const emittedByBlockId = new Map(); // blockId -> first predicted bus emitted for this stop
  const predicted = [];

  for (const item of candidates) {
    if (predicted.length >= maxUpcoming) break;

    const { trip, stopBranch, stopProj, ev, anchor, desvioSec, desvioRaw, predKey, liveBlockSrc, promotedLiveSrc } = item;
    let mem = item.mem;

    // Detect if this predicted trip is a NEXT LAP of an earlier already-emitted predicted bus in the same block!
    const earlierPredSameBlock =
      !liveBlockSrc && !promotedLiveSrc && trip.blockId ? emittedByBlockId.get(trip.blockId) || null : null;
    const isNextLapOfLive = Boolean(liveBlockSrc);
    const isNextLapOfPred = Boolean(earlierPredSameBlock);
    const isNextLap = isNextLapOfLive || isNextLapOfPred;

    // Never allow two DIFFERENT concurrent blocks to claim the same coche;
    // DO allow a later lap of the SAME block (`isNextLap`) to keep its rightful coche!
    if (!isNextLap && !promotedLiveSrc && mem?.coche && usedCoches.has(String(mem.coche).trim())) {
      mem = null;
    }

    let finalLat = ev.lat;
    let finalLng = ev.lng;
    let finalRemMeters = ev.remainingMeters;
    let nextLapOfKey = null;
    let nextLapSourceLive = false;
    let nextLapExtraMeters = 0;
    let coche = '';
    let choferNombre = '';
    let choferLegajo = '';
    let choferRaw = '';
    let esAdaptado = false;
    let ultimaGps = '';
    let gpsTimeOnly = '';
    let realBandera = ev.realBandera || stopBranch.bandera;
    let realBanderaColor = ev.realBanderaColor || getLineColor(lineName);
    let traj = null;

    if (promotedLiveSrc) {
      const src = promotedLiveSrc.bus;
      traj = buildTrajectoryFromBranchAlong(ev.activeBranch, ev.activeAlong, stopBranch, stopProj, {
        isAtTerminal: ev.isAtTerminal,
        etaSec: ev.etaSec,
        viaBranch: ev.viaBranch || null
      });
      if (!traj) continue;
      finalLat = src.lat;
      finalLng = src.lng;
      finalRemMeters = traj.totalMeters;
      nextLapSourceLive = !src.isPredicted && !src.gpsLost;
      coche = src.identificadorCoche || '';
      choferNombre = src.choferNombre || '';
      choferLegajo = src.choferLegajo || '';
      choferRaw = src.choferRaw || '';
      esAdaptado = Boolean(src.esAdaptado);
      ultimaGps = src.ultimaFechaHoraGPS || '';
      gpsTimeOnly = src.gpsTimeOnly || (ultimaGps ? formatGpsTimeOnly(ultimaGps) : '');
      // Demote the later-lap live card into `Sig. vuelta` referencing this imminent primary arrival!
      const tgtIdx = typeof trip.blockIndex === 'number' ? trip.blockIndex : 0;
      src.isNextLap = true;
      src.nextLapOfKey = predKey;
      src.nextLapSourceLive = nextLapSourceLive;
      src.nextLapExtraMeters = computeExtraMetersAcrossBlock(
        trip.block || [],
        tgtIdx,
        promotedLiveSrc.laterIdx,
        stopCoords,
        stopProj
      );
    } else if (isNextLapOfLive) {
      const src = liveBlockSrc.bus;
      nextLapOfKey = src.key;
      nextLapSourceLive = liveBlockSrc.isLive;
      nextLapExtraMeters = liveBlockSrc.extraMeters;
      coche = src.identificadorCoche || '';
      choferNombre = src.choferNombre || '';
      choferLegajo = src.choferLegajo || '';
      choferRaw = src.choferRaw || '';
      esAdaptado = Boolean(src.esAdaptado);
      ultimaGps = src.ultimaFechaHoraGPS || '';
      gpsTimeOnly = src.gpsTimeOnly || (ultimaGps ? formatGpsTimeOnly(ultimaGps) : '');
      traj = src.trajectory || buildTrajectoryFromBranchAlong(stopBranch, 0, stopBranch, stopProj, { etaSec: ev.etaSec });
    } else if (isNextLapOfPred) {
      const src = earlierPredSameBlock;
      const srcIdx = typeof src.scheduledTrip?.blockIndex === 'number' ? src.scheduledTrip.blockIndex : 0;
      const tgtIdx = typeof trip.blockIndex === 'number' ? trip.blockIndex : srcIdx + 2;
      nextLapOfKey = src.key;
      nextLapSourceLive = false;
      nextLapExtraMeters = computeExtraMetersAcrossBlock(trip.block || [], srcIdx, tgtIdx, stopCoords, stopProj);
      finalLat = src.lat;
      finalLng = src.lng;
      finalRemMeters = Math.max(stopProj.along, (src.routeMeters ?? 0) + nextLapExtraMeters);
      coche = src.identificadorCoche || mem?.coche || '';
      choferNombre = src.choferNombre || mem?.choferNombre || '';
      choferLegajo = src.choferLegajo || mem?.choferLegajo || '';
      choferRaw = src.choferRaw || mem?.choferRaw || '';
      esAdaptado = Boolean(src.esAdaptado || mem?.esAdaptado);
      ultimaGps = src.ultimaFechaHoraGPS || mem?.ultimaGps || '';
      const lastGpsTime = ultimaGps ? formatGpsTimeOnly(ultimaGps) : '';
      gpsTimeOnly = src.gpsTimeOnly || (lastGpsTime ? `últ. ${lastGpsTime.slice(0, 5)}` : '');
      realBandera = src.realBandera || stopBranch.bandera;
      realBanderaColor = src.realBanderaColor || stopBranch.color;
      traj = src.trajectory || buildTrajectoryFromBranchAlong(stopBranch, 0, stopBranch, stopProj, { etaSec: ev.etaSec });
    } else {
      traj = buildTrajectoryFromBranchAlong(ev.activeBranch, ev.activeAlong, stopBranch, stopProj, {
        isAtTerminal: ev.isAtTerminal,
        etaSec: ev.etaSec,
        viaBranch: ev.viaBranch || null
      });
      if (!traj) continue;

      if (mem?.coche) usedCoches.add(String(mem.coche).trim());
      coche = mem?.coche || '';
      choferNombre = mem?.choferNombre || '';
      choferLegajo = mem?.choferLegajo || '';
      choferRaw = mem?.choferRaw || '';
      esAdaptado = Boolean(mem?.esAdaptado);
      ultimaGps = mem?.ultimaGps || '';
      const lastGpsTime = ultimaGps ? formatGpsTimeOnly(ultimaGps) : '';
      gpsTimeOnly = lastGpsTime ? `últ. ${lastGpsTime.slice(0, 5)}` : '';
    }

    if (!traj) continue;

    const mins = Math.ceil(ev.etaSec / 60);
    const eta =
      ev.etaSec <= 40 || finalRemMeters <= 45
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

    const built = {
      key: predKey,
      codigoLinea: Number(codLinea),
      descripcionLinea: lineName || `L${codLinea}`,
      descripcionBandera: stopBranch.bandera,
      descripcionCartelBandera: stopBranch.bandera,
      tiempoRaw:
        eta.minutes === 0
          ? 'Arribando..'
          : nextLapSourceLive
            ? `${eta.minutes} min. aprox.`
            : `${eta.minutes} min. est.`,
      eta,
      etaSecondsRemaining: ev.etaSec,
      esAdaptado,
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
      isNextLap,
      nextLapOfKey,
      nextLapSourceLive,
      nextLapExtraMeters,
      predictionReason: promotedLiveSrc
        ? 'live-promoted'
        : isNextLapOfLive
          ? nextLapSourceLive
            ? 'next-lap-live'
            : 'next-lap-offline'
          : isNextLapOfPred
            ? 'next-lap-offline'
            : mem
              ? 'last-online'
              : 'schedule',
      lat: finalLat,
      lng: finalLng,
      distanceMeters: finalRemMeters,
      routeMeters: finalRemMeters,
      proximityPct: computeProximityPercent(eta.minutes, finalRemMeters),
      identificadorCoche: coche,
      choferNombre,
      choferLegajo,
      choferRaw,
      desvio,
      ultimaFechaHoraGPS: ultimaGps,
      gpsTimeOnly,
      trajectory: traj,
      isOppositeLeg: Boolean(ev.inOppositeLeg),
      isNextCycle: Boolean(ev.inNextCycle || isNextLap),
      realBandera,
      realBanderaColor
    };

    if (!isNextLap && trip.blockId && !emittedByBlockId.has(trip.blockId)) {
      emittedByBlockId.set(trip.blockId, built);
    }

    predicted.push(built);
  }

  return predicted;
}
