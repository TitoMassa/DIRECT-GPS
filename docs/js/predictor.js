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
  formatGpsTimeOnly
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

  // Match which bandera index(es) in the horarios file correspond to this branch
  const matchingBanderaIdx = new Set();
  banderas.forEach((b, idx) => {
    const nb = normalizeBandera(b);
    if (nb && normBranchBandera && (nb === normBranchBandera || nb.includes(normBranchBandera) || normBranchBandera.includes(nb))) {
      matchingBanderaIdx.add(idx);
    }
  });

  // Collect ordered stops along this branch with their parsed timestamps
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

  // Reconstruct monotonic trips sweeping from first stop to last stop of the branch
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
 * Computes the scheduled passage second of `trip` at a target stop (by exact stopId or by `along` interpolation).
 */
export function getTripStopSec(trip, stopId, stopAlong) {
  const cleanId = String(stopId || '').trim().toUpperCase();
  if (cleanId && trip.stopTimeMap.has(cleanId)) {
    return trip.stopTimeMap.get(cleanId);
  }
  const pts = trip.points;
  if (!pts || pts.length === 0) return null;
  if (stopAlong <= pts[0].along) return pts[0].sec;
  if (stopAlong >= pts[pts.length - 1].along) return pts[pts.length - 1].sec;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    if (stopAlong >= a.along && stopAlong <= b.along) {
      const span = Math.max(0.001, b.along - a.along);
      return a.sec + ((stopAlong - a.along) / span) * (b.sec - a.sec);
    }
  }
  return null;
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
 * Evaluates the exact real-time state of a scheduled trip approaching `stopProj` on `trip.branch`.
 * Strictly monotonic: any upcoming trip within `maxAheadSec` is ALWAYS represented (never hidden
 * behind an arbitrary departure-time gap that would later pop in and evict subsequent trips!).
 */
export function evaluateTripState(trip, stopId, stopProj, nowSec, desvioSec = 0, { maxAheadSec = 120 * 60 } = {}) {
  if (!trip || !stopProj) return null;
  const targetStopSec = getTripStopSec(trip, stopId, stopProj.along);
  if (targetStopSec === null) return null;

  let effNow = nowSec;
  if (targetStopSec > 86400 && effNow < 6 * 3600) {
    effNow += 86400;
  }
  const tEff = effNow + (desvioSec || 0);
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
    return {
      activeBranch: stopBranch,
      activeAlong: along,
      lat: sample.lat,
      lng: sample.lng,
      remainingMeters,
      etaSec: Math.max(0, etaSec),
      speedMps: remainingMeters <= 5 ? 0 : ev.speedMps,
      isAtTerminal: along <= 120 && tEff <= trip.startSec + 20,
      inOppositeLeg: false,
      realBandera: stopBranch.bandera,
      realBanderaColor: stopBranch.color,
      targetStopSec
    };
  }

  // 2) Before departure from cabecera: if chained return leg (`trip.prevTrip`) is currently active,
  // place bus moving realistically along the return branch toward cabecera!
  if (trip.prevTrip) {
    const prev = trip.prevTrip;
    if (tEff >= prev.startSec && tEff < prev.endSec) {
      const ev = evalPointsAtSec(prev.points, tEff);
      const sample = sampleBranchAtAlong(prev.branch, ev.along);
      if (!sample) return null;
      const oppRem = Math.max(0, prev.branch.totalLen - ev.along);
      const remainingMeters = oppRem + stopProj.along;
      return {
        activeBranch: prev.branch,
        activeAlong: ev.along,
        lat: sample.lat,
        lng: sample.lng,
        remainingMeters,
        etaSec: Math.max(0, etaSec),
        speedMps: ev.speedMps,
        isAtTerminal: oppRem <= 120,
        inOppositeLeg: true,
        realBandera: prev.branch.bandera,
        realBanderaColor: prev.branch.color,
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
    targetStopSec
  };
}

/**
 * Matches live GPS buses of one line to their exact canonical scheduled `trip` & `turnoProgramado`
 * across ALL branches serving `stopId`, with sticky-coche stability so 1–3 min SmartMovePro ETA
 * wobbles never drop/swap a bus's match and cause predicted arrivals to flicker!
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

  // Build candidate (trip, branch, stopProj) pool across all branches serving this stop
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
    if (!bus.eta || bus.eta.valid === false || typeof bus.eta.minutes !== 'number' || bus.eta.minutes > 240) {
      continue;
    }
    const desvioSec = bus.desvio?.seconds || 0;
    const expectedSec = (nowSec + bus.eta.minutes * 60 + desvioSec) % 86400;
    const stickyKey = bus.identificadorCoche ? `${model.codLinea}:${bus.identificadorCoche}` : null;
    const stickyRec = stickyKey && stickyTripByCoche ? stickyTripByCoche.get(stickyKey) : null;
    const stickyTripKey = stickyRec?.tripKey || null;
    const busNormBandera = normalizeBandera(bus.descripcionBandera || '');

    // Longer ETAs & opposite-leg buses carry higher SmartMovePro propagation variance (delay recovery at cabecera)
    let baseTolMin = bus.eta.minutes >= 35 ? 16 : 12;
    if (bus.esExtendido || bus.isOppositeLeg) baseTolMin += 4;
    const baseTolSec = baseTolMin * 60;

    let bestItem = null;
    let bestScore = Infinity;

    for (const item of pool) {
      if (usedTrips.has(item.trip)) continue;
      const normSt = item.stSec % 86400;
      let diff = Math.abs(normSt - expectedSec);
      if (diff > 43200) diff = 86400 - diff;

      const isSticky = stickyTripKey && item.trip.tripKey === stickyTripKey;
      const maxAllowed = isSticky ? Math.max(baseTolSec, 22 * 60) : baseTolSec;
      if (diff > maxAllowed) continue;

      let score = diff;
      if (isSticky) score -= 5 * 60; // strong stickiness bonus prevents oscillation between adjacent slots
      if (busNormBandera && item.normBandera && item.normBandera !== busNormBandera) {
        score += 3 * 60; // gently prefer the branch matching the stop's reported bandera when multiple branches exist
      }

      if (score < bestScore) {
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
 * Synthesizes realistic, street-following predicted bus objects across ALL branches serving `stopId`
 * for active/upcoming scheduled turns that currently have NO live GPS unit.
 *
 * Guarantees stability across consecutive 10s polls:
 *  - Evaluates all serving branches, sorts strictly by ETA ascending BEFORE slicing `maxUpcoming`
 *  - Applies +6 min upper-horizon hysteresis for already-displayed predicted keys (`activePredKeys`)
 *  - Suppresses trips already completed early at this stop (`completedTripKeys`)
 *  - Enriches with central system `fleetMemory` (coche, chofer, legajo, adaptado, last GPS time)
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

      // Carry forward recent schedule deviation from last online observation on this exact trip
      let desvioSec = 0;
      let desvioRaw = '';
      if (mem && Number.isFinite(mem.desvioSec)) {
        const ageMin = mem.updatedAt ? (nowMs - mem.updatedAt) / 60000 : 999;
        if (!memFromPrev && ageMin <= 75) {
          desvioSec = Math.max(-1800, Math.min(1200, mem.desvioSec));
          desvioRaw = mem.desvioRaw || formatDesvioFromSec(desvioSec);
        } else if (memFromPrev && ageMin <= 35) {
          desvioSec = Math.round(Math.max(-900, Math.min(600, mem.desvioSec * 0.5)));
          desvioRaw = formatDesvioFromSec(desvioSec);
        }
      }

      const ev = evaluateTripState(trip, stopId, stopProj, nowSec, desvioSec, {
        maxAheadSec: effectiveMaxAheadSec
      });
      if (!ev) continue;

      seenTripKeys.add(trip.tripKey);
      candidates.push({ trip, stopBranch, stopProj, ev, mem, desvioSec, desvioRaw, predKey });
    }
  }

  // Sort strictly by ETA ascending across ALL serving branches BEFORE slicing to maxUpcoming!
  candidates.sort((a, b) => a.ev.etaSec - b.ev.etaSec);

  const usedCoches = new Set(liveMatchedCoches);
  const predicted = [];

  for (const item of candidates) {
    if (predicted.length >= maxUpcoming) break;

    const { trip, stopBranch, stopProj, ev, desvioSec, desvioRaw, predKey } = item;
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
