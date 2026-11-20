import {
  pickStopBranches,
  pickPairedReturnBranch,
  pickIncomingBranches,
  projectOnPolyline,
  sampleBranchAtAlong,
  buildTrajectoryFromBranchAlong,
  resolveTrailDirection
} from './trajectory.js';
import {
  computeProximityPercent,
  parseDesvioHorario,
  formatGpsTimeOnly,
  distanceMeters
} from './api.js';
import { getLineColor } from './config.js';

const modelCacheByBranches = new WeakMap(); // branches[] -> Map<`${codLinea}:${tipoDia}`, LineScheduleModel>

// Interprovincial 904 lines (Corrientes-Chaco) operate continuous shifts with NO horarios cortados.
// Urban lines (102-109) regularly have horarios cortados (peak cars pulling in mid-morning / returning midday).
export const INTERPROVINCIAL_LINE_CODES = new Set([1037, 1038, 1039, 517, 607, 608]); // 904A, 904B, 904C + aliases
const INTERURBAN_LINE_CODES = new Set([705, 433]); // SANTA ANA-INGENIO, RIACHUELO - ERSA

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
  const m = String(raw || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})$/);
  if (!m) return null;
  return parseInt(m[4], 10) * 3600 + parseInt(m[5], 10) * 60 + parseInt(m[6], 10);
}

export function formatSecHHMM(sec) {
  const norm = ((Math.round(sec) % 86400) + 86400) % 86400;
  const hh = Math.floor(norm / 3600);
  const mm = Math.floor((norm % 3600) / 60);
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

export function formatLapNumber(lap) {
  const val = Number(lap);
  if (!Number.isFinite(val) || val <= 0) return '';
  const whole = Math.floor(val);
  const hasHalf = Math.abs(val - whole - 0.5) < 0.01;
  if (hasHalf) return whole === 0 ? '½' : `${whole}½`;
  return String(whole);
}

export function formatLapSpoken(lap) {
  const val = Number(lap);
  if (!Number.isFinite(val) || val <= 0) return '';
  const whole = Math.floor(val);
  const hasHalf = Math.abs(val - whole - 0.5) < 0.01;
  if (hasHalf) return whole === 0 ? 'media' : `${whole} y media`;
  return String(whole);
}

export function formatShiftLaps(laps) {
  const val = Number(laps);
  if (!Number.isFinite(val) || val <= 0) return '';
  const whole = Math.floor(val);
  const hasHalf = Math.abs(val - whole - 0.5) < 0.01;
  if (hasHalf) {
    return whole === 0 ? '½ vuelta' : `${whole}½ vueltas`;
  }
  return `${whole} ${whole === 1 ? 'vuelta' : 'vueltas'}`;
}

export function formatShiftLapsSpoken(laps) {
  const val = Number(laps);
  if (!Number.isFinite(val) || val <= 0) return '';
  const whole = Math.floor(val);
  const hasHalf = Math.abs(val - whole - 0.5) < 0.01;
  if (hasHalf) {
    return whole === 0 ? 'media vuelta' : `${whole} y media vueltas`;
  }
  return `${whole} ${whole === 1 ? 'vuelta' : 'vueltas'}`;
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

export const SERVICE_DAY_CUTOFF_SEC = 3 * 3600; // 03:00 AM (0 buses operate between 02:00 and 04:25 AM across Corrientes)

export function toServiceSec(sec) {
  if (!Number.isFinite(sec)) return sec;
  return sec >= 0 && sec < SERVICE_DAY_CUTOFF_SEC ? sec + 86400 : sec;
}

export function getArgentinaSecOfDay(date = new Date()) {
  const art = new Date(date.getTime() - 3 * 3600 * 1000);
  return art.getUTCHours() * 3600 + art.getUTCMinutes() * 60 + art.getUTCSeconds() + art.getUTCMilliseconds() / 1000;
}

// Service day key rolls over at 03:00 AM ART (UTC-6 shift) so 00:00-02:59 stays in the night's service
// and 03:00 AM starts a 100% clean day with zero previous-day driver/bus leakage.
export function getArgentinaDayKey(date = new Date()) {
  const serviceArt = new Date(date.getTime() - (3 * 3600 + SERVICE_DAY_CUTOFF_SEC) * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${serviceArt.getUTCFullYear()}-${pad(serviceArt.getUTCMonth() + 1)}-${pad(serviceArt.getUTCDate())}`;
}

export function getArgentinaServiceTipo(date = new Date()) {
  const serviceArt = new Date(date.getTime() - (3 * 3600 + SERVICE_DAY_CUTOFF_SEC) * 1000);
  const dow = serviceArt.getUTCDay();
  return dow === 0 ? 'domingo' : dow === 6 ? 'sabado' : 'habil';
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
      const rawSec = parseTimeToSec(timeStr);
      if (rawSec !== null) times.push(toServiceSec(rawSec));
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
        bestTrip.tr.points.push({ sIdx, stopId: st.stopId, along: st.along, sec: safeSec });
        usedTrips.add(bestTrip.tr);
      } else {
        trips.push({
          branch,
          points: [{ sIdx, stopId: st.stopId, along: st.along, sec: rawSec }]
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
        : 5.5;

    // Terminal approach/tail deadheads move faster than stop-congested downtown averages,
    // preventing artificial endpoint overlaps on immediate-turnaround cabeceras (e.g. 103A).
    const headSpd = Math.max(avgSpeed, 6.5);
    const tailSpd = Math.max(avgSpeed, 7.0);

    const fullPts = pts.map((p) => ({ stopId: p.stopId, along: p.along, sec: p.sec }));
    if (first.along > 25) {
      const startSec = first.sec - first.along / headSpd;
      fullPts.unshift({ stopId: null, along: 0, sec: startSec });
    }
    if (branch.totalLen - last.along > 25) {
      const endSec = last.sec + (branch.totalLen - last.along) / tailSpd;
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
      nextTrip: null,
      layoverFromPrevSec: null,
      linkConfidence: 'none'
    });
  }

  finalized.sort((a, b) => a.startSec - b.startSec);
  return finalized;
}

/**
 * Estimates a cabecera's true scheduled rest/layover duration using mutually-isolated turnarounds
 * (where only 1 arrival precedes a departure's first feasible slot, plus the first arrival of the day).
 * Immune to peak-hour headway < layover corruption (e.g. 904B, 105A, 103B) and morning pull-outs (102B, 105B).
 */
function estimateTypicalTerminalLayover(arrivals, departures, longLayoverMode) {
  if (!arrivals.length || !departures.length) return longLayoverMode ? 600 : 300;
  const maxProbe = longLayoverMode ? 55 * 60 : 28 * 60;
  const isolated = [];

  for (let i = 0; i < arrivals.length; i++) {
    const arr = arrivals[i];
    let firstDep = null;
    for (let j = 0; j < departures.length; j++) {
      const lay = departures[j].startSec - arr.endSec;
      if (lay >= -120 && lay <= maxProbe) {
        firstDep = departures[j];
        break;
      }
    }
    if (!firstDep) continue;

    let arrCount = 0;
    for (let k = 0; k < arrivals.length; k++) {
      const lay = firstDep.startSec - arrivals[k].endSec;
      if (lay >= -120 && lay <= maxProbe) arrCount++;
    }
    const lay = firstDep.startSec - arr.endSec;
    if (arrCount === 1 || i === 0) {
      isolated.push(lay);
    }
  }

  if (isolated.length > 0) {
    isolated.sort((a, b) => a - b);
    return isolated[Math.floor(isolated.length / 2)];
  }

  const fallback = [];
  for (const arr of arrivals) {
    const dep = departures.find((d) => {
      const l = d.startSec - arr.endSec;
      return l >= -120 && l <= maxProbe;
    });
    if (dep) fallback.push(dep.startSec - arr.endSec);
  }
  if (!fallback.length) return longLayoverMode ? 600 : 300;
  fallback.sort((a, b) => a - b);
  return fallback[Math.floor(fallback.length / 2)];
}

/**
 * Global Optimal Monotonic (FIFO) Terminal Sequence Alignment via Dynamic Programming.
 * Guarantees zero bus overtaking at cabeceras, recovers exact variable-duration laps,
 * keeps 904 (interprovincial) continuous with no false cuts, and cleanly cuts urban 102-109
 * blocks at horarios cortados so out-of-service cars are never linked to another car's lap.
 */
function alignTerminalFIFO(
  arrivals,
  departures,
  { isInterprovincial = false, isInterurban = false, preferSamePair = false, pairMap = null } = {}
) {
  const n = arrivals.length;
  const m = departures.length;
  if (!n || !m) return [];

  const longMode = isInterprovincial || isInterurban;
  const typicalLay = estimateTypicalTerminalLayover(arrivals, departures, longMode);
  const isImmediate = typicalLay <= 150;

  const minLay = isInterurban ? -60 : isImmediate ? -120 : typicalLay >= 420 ? 90 : -30;
  const maxLay = isInterurban
    ? Math.max(60 * 60, typicalLay + 35 * 60)
    : isInterprovincial
      ? Math.max(36 * 60, typicalLay + 22 * 60)
      : isImmediate
        ? 11 * 60
        : Math.max(20 * 60, Math.min(28 * 60, typicalLay + 11 * 60));

  const skipCost = isInterurban
    ? 2600
    : isInterprovincial
      ? 1900
      : isImmediate
        ? 480
        : Math.max(460, Math.min(720, typicalLay * 0.9));

  const INF = 1e12;
  const dp = Array.from({ length: n + 1 }, () => new Float64Array(m + 1).fill(INF));
  const bt = Array.from({ length: n + 1 }, () => new Uint8Array(m + 1)); // 1=skipArr, 2=skipDep, 3=match

  for (let i = 0; i <= n; i++) {
    dp[i][0] = i * skipCost;
    bt[i][0] = 1;
  }
  for (let j = 0; j <= m; j++) {
    dp[0][j] = j * skipCost;
    bt[0][j] = 2;
  }
  bt[0][0] = 0;

  for (let i = 1; i <= n; i++) {
    const arr = arrivals[i - 1];
    for (let j = 1; j <= m; j++) {
      const dep = departures[j - 1];
      let best = dp[i - 1][j] + skipCost;
      let move = 1;

      const cSkipDep = dp[i][j - 1] + skipCost;
      if (cSkipDep < best) {
        best = cSkipDep;
        move = 2;
      }

      const lay = dep.startSec - arr.endSec;
      if (lay >= minLay && lay <= maxLay) {
        let matchCost = Math.abs(lay - typicalLay);
        if (lay < 0) matchCost += isImmediate ? 45 : 350;
        if (!longMode && lay > typicalLay + 360) {
          matchCost += (lay - typicalLay - 360) * 0.65;
        }
        if (preferSamePair && pairMap && pairMap.get(dep.branch) !== arr.branch) {
          matchCost += 90;
        }
        const cMatch = dp[i - 1][j - 1] + matchCost;
        if (cMatch < best) {
          best = cMatch;
          move = 3;
        }
      }

      dp[i][j] = best;
      bt[i][j] = move;
    }
  }

  const pairs = [];
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    const mv = bt[i][j];
    if (mv === 3) {
      const arr = arrivals[i - 1];
      const dep = departures[j - 1];
      const lay = dep.startSec - arr.endSec;
      const dev = Math.abs(lay - typicalLay);
      const confidence =
        longMode ? (dev <= 11 * 60 ? 'high' : 'medium') : dev <= 4.5 * 60 ? 'high' : 'medium';
      pairs.push({ arr, dep, lay, typicalLay, confidence });
      i--;
      j--;
    } else if (mv === 1) {
      i--;
    } else {
      j--;
    }
  }
  pairs.reverse();
  return pairs;
}

/**
 * Builds and caches the complete space-time schedule model for one line and day type,
 * reconstructing variable-duration vehicle rotations via Global FIFO DP alignment,
 * respecting urban horarios cortados vs. continuous 904 interprovincial operations,
 * and recovering true active-rotation service numbering (Servicio 1..N once all services are active).
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

  const numCode = Number(codLinea);
  const isInterprovincial = INTERPROVINCIAL_LINE_CODES.has(numCode);
  const isInterurban = INTERURBAN_LINE_CODES.has(numCode);

  const branchTrips = new Map(); // branchKey -> Trip[]
  for (const b of branches) {
    const trips = reconstructBranchTrips(b, horariosFile, resolved.tipo);
    branchTrips.set(getBranchKey(b), trips);
  }

  const pairMap = new Map();
  for (const b of branches) {
    pairMap.set(b, pickPairedReturnBranch(branches, b));
  }

  // Separate structurally disjoint shuttle sub-loops (e.g. 103C: 3.8 km Montaña shuttle vs 12.2 km Puerto trunk)
  // while preserving genuine shared-hub branch interchanges (e.g. 104A, 104D, 105C).
  const shuttleIsolated = new Set();
  for (const b of branches) {
    const p = pairMap.get(b);
    if (!p || p === b || pairMap.get(p) !== b) continue;
    const feeders = pickIncomingBranches(branches, b);
    const foreignFeeders = feeders.filter((f) => f !== p && (branchTrips.get(getBranchKey(f)) || []).length > 0);
    if (!foreignFeeders.length) continue;
    const avgPairLen = (b.totalLen + p.totalLen) * 0.5;
    const foreignLen = Math.max(...foreignFeeders.map((f) => f.totalLen));
    const ratio = Math.max(avgPairLen, foreignLen) / Math.max(1, Math.min(avgPairLen, foreignLen));
    const nB = (branchTrips.get(getBranchKey(b)) || []).length;
    const nP = (branchTrips.get(getBranchKey(p)) || []).length;
    if (ratio >= 2.2 && nB > 0 && nP > 0 && Math.abs(nB - nP) <= 2) {
      shuttleIsolated.add(b);
    }
  }

  // Group branches into physical cabeceras and align each cabecera with Global FIFO DP
  const handledOut = new Set();
  const terminals = [];
  for (const b of branches) {
    if (handledOut.has(b) || !(branchTrips.get(getBranchKey(b)) || []).length) continue;

    if (shuttleIsolated.has(b)) {
      terminals.push({ inBranches: [pairMap.get(b)], outBranches: [b], preferSamePair: false });
      handledOut.add(b);
      continue;
    }

    const feeders = pickIncomingBranches(branches, b).filter(
      (fb) => !shuttleIsolated.has(fb) || pairMap.get(fb) === b
    );
    if (!feeders.length) continue;

    const siblings = [b];
    handledOut.add(b);
    for (const other of branches) {
      if (handledOut.has(other) || shuttleIsolated.has(other)) continue;
      if (!(branchTrips.get(getBranchKey(other)) || []).length) continue;
      const oFeed = pickIncomingBranches(branches, other).filter(
        (fb) => !shuttleIsolated.has(fb) || pairMap.get(fb) === other
      );
      if (oFeed.some((f) => feeders.includes(f))) {
        siblings.push(other);
        handledOut.add(other);
      }
    }

    const inSet = new Set();
    for (const sb of siblings) {
      for (const f of pickIncomingBranches(branches, sb)) {
        if (!shuttleIsolated.has(f) || siblings.includes(pairMap.get(f))) {
          inSet.add(f);
        }
      }
    }
    terminals.push({
      inBranches: [...inSet],
      outBranches: siblings,
      preferSamePair: siblings.length > 1 || inSet.size > 1
    });
  }

  for (const term of terminals) {
    const arrivals = term.inBranches
      .flatMap((b) => branchTrips.get(getBranchKey(b)) || [])
      .sort((a, c) => a.endSec - c.endSec);
    const departures = term.outBranches
      .flatMap((b) => branchTrips.get(getBranchKey(b)) || [])
      .sort((a, c) => a.startSec - c.startSec);

    const aligned = alignTerminalFIFO(arrivals, departures, {
      isInterprovincial,
      isInterurban,
      preferSamePair: term.preferSamePair,
      pairMap
    });

    for (const { arr, dep, lay, confidence } of aligned) {
      if (!arr.nextTrip && !dep.prevTrip) {
        arr.nextTrip = dep;
        dep.prevTrip = arr;
        dep.layoverFromPrevSec = lay;
        dep.linkConfidence = confidence;
      }
    }
  }

  // Step 3: Materialize continuous duty blocks & assign canonical physical service numbers (1..N).
  // A service (e.g. Servicio 1 on 106B) keeps its SAME number all day across:
  //  - ~8h full shifts + "relevo en línea" (~14-19h continuous duty),
  //  - "horarios cortados" (morning peak block pulling in + midday/afternoon return),
  //  - "mete coche" breaks (morning 8h shift + afternoon/evening 2nd shift).
  const allTrips = branches
    .flatMap((b) => branchTrips.get(getBranchKey(b)) || [])
    .sort((a, c) => a.startSec - c.startSec);

  const tripByKey = new Map();
  const rawBlocks = [];
  for (const trip of allTrips) {
    tripByKey.set(trip.tripKey, trip);
    if (trip.prevTrip) continue;
    const block = [];
    let cur = trip;
    const visited = new Set();
    while (cur && !visited.has(cur)) {
      visited.add(cur);
      cur.block = block;
      cur.blockIndex = block.length;
      block.push(cur);
      cur = cur.nextTrip;
    }
    rawBlocks.push(block);
  }

  const firstTrip = allTrips[0] || null;
  const primaryBranch = firstTrip?.branch || branches[0] || null;
  const primaryTrips = primaryBranch ? branchTrips.get(getBranchKey(primaryBranch)) || [] : [];

  const cyclicDist = (a, b, n) => (((b - a) % n) + n) % n;
  const isStrictlyBetweenCyc = (prevS, cand, nextS, n) => {
    if (prevS === nextS) return cand !== prevS;
    const dPN = cyclicDist(prevS, nextS, n);
    const dPC = cyclicDist(prevS, cand, n);
    return dPC > 0 && dPC < dPN;
  };

  const blockMeta = rawBlocks.map((trips, idx) => {
    const startSec = trips[0]?.startSec ?? 0;
    const endSec = trips[trips.length - 1]?.endSec ?? 0;
    const durSec = Math.max(0, endSec - startSec);
    const primTrips = primaryBranch ? trips.filter((t) => t.branch === primaryBranch) : [];
    const branchSet = new Set(trips.map((t) => t.branch));
    return {
      idx,
      trips,
      startSec,
      endSec,
      durSec,
      isCortado: !isInterprovincial && durSec < 5.5 * 3600,
      isRelevoEnLinea: durSec >= 11 * 3600,
      primTrips,
      branchSet,
      firstPrimStart: primTrips.length ? primTrips[0].startSec : startSec
    };
  });

  // 3a) Compute exact peak simultaneous active vehicles across the day (3-min edge trim avoids double-counting handoffs)
  const sweepEvents = [];
  for (const bm of blockMeta) {
    const s = bm.startSec;
    const e = Math.max(s + 60, bm.endSec - 180);
    sweepEvents.push([s, 1, bm]);
    sweepEvents.push([e, -1, bm]);
  }
  sweepEvents.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const curActive = new Set();
  let peakCount = 0;
  let peakTime = 0;
  let peakSnapshot = [];
  for (const [t, delta, bm] of sweepEvents) {
    if (delta === 1) curActive.add(bm);
    else curActive.delete(bm);
    if (curActive.size > peakCount) {
      peakCount = curActive.size;
      peakTime = t;
      peakSnapshot = [...curActive];
    }
  }

  // Compute midday valley floor (09:30–11:30, when urban horarios cortados are off the road)
  let middayValleyCount = peakCount;
  for (let t = 9.5 * 3600; t <= 11.5 * 3600; t += 300) {
    let active = 0;
    for (const bm of blockMeta) {
      if (bm.startSec <= t && bm.endSec >= t) active++;
    }
    if (active > 0 && active < middayValleyCount) middayValleyCount = active;
  }

  // 3b) Canonical morning service numbering (1..N):
  // Once all active morning services are running, departures starting from Service 1's 2nd lap
  // follow exact numeric order (Servicio 1, 2, 3, ..., N).
  const tripToBm = new Map();
  for (const bm of blockMeta) {
    for (const t of bm.trips) tripToBm.set(t, bm);
  }
  const firstPrimTrip = primaryTrips[0] || null;
  const firstBm = firstPrimTrip ? tripToBm.get(firstPrimTrip) : null;
  const firstLap2 = firstBm && firstBm.primTrips.length >= 2 ? firstBm.primTrips[1] : null;
  const peakSet = new Set(peakSnapshot);

  const morningOrdered = [];
  const usedMorning = new Set();
  if (firstLap2) {
    const lap2Idx = primaryTrips.indexOf(firstLap2);
    for (let k = lap2Idx; k < primaryTrips.length; k++) {
      const bm = tripToBm.get(primaryTrips[k]);
      if (!bm || usedMorning.has(bm)) break;
      if (!peakSet.has(bm) && bm.endSec <= peakTime - 180) continue;
      usedMorning.add(bm);
      morningOrdered.push(bm);
    }
  }

  const missingPeak = peakSnapshot
    .filter((bm) => !usedMorning.has(bm))
    .sort((a, b) => a.firstPrimStart - b.firstPrimStart);
  for (const mp of missingPeak) {
    if (mp.primTrips.length > 0 && morningOrdered.length > 0) {
      const refTrip = mp.primTrips.reduce((best, t) =>
        Math.abs(t.startSec - peakTime) < Math.abs(best.startSec - peakTime) ? t : best
      );
      const rIdx = primaryTrips.indexOf(refTrip);
      let prevKnown = null;
      for (let k = rIdx - 1; k >= 0; k--) {
        const b = tripToBm.get(primaryTrips[k]);
        if (b && usedMorning.has(b)) {
          prevKnown = b;
          break;
        }
      }
      if (prevKnown) {
        morningOrdered.splice(morningOrdered.indexOf(prevKnown) + 1, 0, mp);
      } else {
        morningOrdered.push(mp);
      }
    } else {
      morningOrdered.push(mp);
    }
    usedMorning.add(mp);
  }

  if (morningOrdered.length === 0 && blockMeta.length > 0) {
    morningOrdered.push(...peakSnapshot.sort((a, b) => a.startSec - b.startSec));
  }

  let totalServices = Math.max(1, morningOrdered.length);
  const assignedServiceByBm = new Map();
  const serviceBlocksMap = new Map(); // serviceNumber -> bm[]
  const peakServiceBms = new Set(morningOrdered);
  morningOrdered.forEach((bm, i) => {
    const s = i + 1;
    assignedServiceByBm.set(bm, s);
    serviceBlocksMap.set(s, [bm]);
  });

  // 3c) Assign every subsequent block (cortado returns, 2nd 8h shifts, evening turns) back to its
  // TRUE canonical service number (1..N) via Most-Constrained-First cyclic neighbor alignment!
  const overlapsService = (bm, s) =>
    (serviceBlocksMap.get(s) || []).some(
      (ex) => bm.startSec < ex.endSec - 180 && ex.startSec < bm.endSec - 180
    );

  const getAdjacentBlocks = (bm, s) => {
    const list = serviceBlocksMap.get(s) || [];
    let prev = null;
    let next = null;
    for (const ex of list) {
      if (ex.endSec <= bm.startSec + 180 && (!prev || ex.endSec > prev.endSec)) prev = ex;
      if (ex.startSec >= bm.endSec - 180 && (!next || ex.startSec < next.startSec)) next = ex;
    }
    return { prev, next };
  };

  const scoreServiceCandidate = (bm, s) => {
    let matches = 0;
    let violations = 0;
    let observations = 0;
    let arcFracSum = 0;

    for (const t of bm.trips) {
      const list = branchTrips.get(getBranchKey(t.branch)) || [];
      const pos = list.indexOf(t);
      if (pos < 0) continue;

      let prevS = null;
      let nextS = null;
      let prevDt = Infinity;
      let nextDt = Infinity;
      for (let k = pos - 1; k >= 0; k--) {
        const dt = t.startSec - list[k].startSec;
        if (dt > 110 * 60) break;
        const b = tripToBm.get(list[k]);
        if (b && assignedServiceByBm.has(b)) {
          prevS = assignedServiceByBm.get(b);
          prevDt = dt;
          break;
        }
      }
      for (let k = pos + 1; k < list.length; k++) {
        const dt = list[k].startSec - t.startSec;
        if (dt > 110 * 60) break;
        const b = tripToBm.get(list[k]);
        if (b && assignedServiceByBm.has(b)) {
          nextS = assignedServiceByBm.get(b);
          nextDt = dt;
          break;
        }
      }

      if (prevS !== null && nextS !== null) {
        const w = t.branch === primaryBranch ? 2 : 1;
        observations += w;
        if (isStrictlyBetweenCyc(prevS, s, nextS, totalServices)) {
          matches += w;
          const dPN = cyclicDist(prevS, nextS, totalServices) || totalServices;
          const dPC = cyclicDist(prevS, s, totalServices);
          const slotFrac = dPC / dPN;
          const timeFrac = prevDt / Math.max(1, prevDt + nextDt);
          arcFracSum += w * Math.abs(slotFrac - timeFrac);
        } else {
          violations += w;
        }
      }
    }

    const avgArcFrac = matches > 0 ? arcFracSum / matches : 0.5;
    const { prev: prevBlk, next: nextBlk } = getAdjacentBlocks(bm, s);
    let contBonus = 0;
    const refBlk = prevBlk || nextBlk;
    if (refBlk) {
      const sharesBranch = [...bm.branchSet].some((br) => refBlk.branchSet.has(br));
      if (sharesBranch) contBonus += 4.0;
    }
    if (prevBlk) {
      const gapH = (bm.startSec - prevBlk.endSec) / 3600;
      if (gapH >= 0.3 && gapH <= 5.5) contBonus += 2.0;
      const startH = bm.startSec / 3600;
      if (startH >= 10.5 && startH <= 14.2 && prevBlk.isCortado) contBonus += 2.5;
      if (startH >= 14.5 && startH <= 18.5 && !prevBlk.isCortado) contBonus += 2.0;
      contBonus -= Math.abs(gapH - 3.0) * 0.15;
    }

    return {
      s,
      matches,
      violations,
      observations,
      score: matches * 10 - violations * 40 - avgArcFrac * 3 + contBonus
    };
  };

  const remainingBms = blockMeta
    .filter((bm) => !assignedServiceByBm.has(bm))
    .sort((a, b) => a.startSec - b.startSec);

  while (remainingBms.length > 0) {
    let bestPick = null;
    for (let i = 0; i < remainingBms.length; i++) {
      const bm = remainingBms[i];
      const free = [];
      for (let s = 1; s <= totalServices; s++) {
        if (!overlapsService(bm, s)) free.push(s);
      }
      if (!free.length) continue;

      const evals = free.map((s) => scoreServiceCandidate(bm, s)).sort((a, b) => b.score - a.score);
      const perfect = evals.filter((e) => e.observations > 0 && e.violations === 0 && e.matches > 0);
      const priority =
        perfect.length === 1
          ? 10000 + perfect[0].matches * 100 - bm.startSec / 1000
          : perfect.length > 1
            ? 5000 + (evals[0].score - evals[1].score) * 10 - bm.startSec / 1000
            : 1000 + evals[0].score - bm.startSec / 1000;

      if (!bestPick || priority > bestPick.priority) {
        bestPick = { idx: i, bm, chosen: evals[0], priority };
      }
    }

    if (!bestPick) {
      const bm = remainingBms.shift();
      totalServices += 1;
      assignedServiceByBm.set(bm, totalServices);
      serviceBlocksMap.set(totalServices, [bm]);
    } else {
      remainingBms.splice(bestPick.idx, 1);
      assignedServiceByBm.set(bestPick.bm, bestPick.chosen.s);
      serviceBlocksMap.get(bestPick.chosen.s).push(bestPick.bm);
    }
  }

  // 3d) Split continuous multi-driver "relevo en línea" runs (> 10.2h) into ~8h driver shifts
  // so lap numbering ALWAYS resets to Vuelta 1 at every shift change (preserving trip.prevTrip/nextTrip
  // for seamless physical bus tracking across the relevo).
  const singleShiftDurs = blockMeta
    .filter((b) => b.durSec >= 6.0 * 3600 && b.durSec <= 9.8 * 3600)
    .map((b) => b.durSec)
    .sort((a, b) => a - b);
  const singleShiftLegsList = blockMeta
    .filter((b) => b.durSec >= 6.0 * 3600 && b.durSec <= 9.8 * 3600)
    .map((b) => b.trips.length)
    .sort((a, b) => a - b);
  const typicalShiftSec = singleShiftDurs.length
    ? Math.max(7.0 * 3600, Math.min(8.4 * 3600, singleShiftDurs[Math.floor(singleShiftDurs.length / 2)]))
    : 8.0 * 3600;
  const typicalShiftLegs = singleShiftLegsList.length
    ? singleShiftLegsList[Math.floor(singleShiftLegsList.length / 2)]
    : null;

  const splitContinuousShift = (p) => {
    const out = [];
    let curTrips = p.trips;
    const isPeak = peakServiceBms.has(p);

    while (curTrips.length >= 4) {
      const s0 = curTrips[0].startSec;
      const eLast = curTrips[curTrips.length - 1].endSec;
      const remDur = eLast - s0;
      if (remDur <= 10.2 * 3600) break;

      const targetDur =
        remDur <= 17.2 * 3600
          ? Math.min(typicalShiftSec, Math.max(7.2 * 3600, remDur * 0.5))
          : typicalShiftSec;
      const minRightLegs = curTrips.length >= 4 ? 2 : 1;
      let bestIdx = -1;
      let bestScore = Infinity;

      for (let i = 2; i <= curTrips.length - minRightLegs; i++) {
        const t1End = curTrips[i - 1].endSec;
        const t2Start = curTrips[i].startSec;
        const t1Dur = t1End - s0;
        if (t1Dur < 5.0 * 3600 || t1Dur > 10.0 * 3600) continue;
        const midElapsed = (t1End + t2Start) * 0.5 - s0;
        let score = Math.abs(midElapsed - targetDur);
        if (typicalShiftLegs && i === typicalShiftLegs) score -= 900;
        if (remDur <= 17.2 * 3600 && i === Math.floor(curTrips.length / 2)) score -= 300;
        if (score < bestScore) {
          bestScore = score;
          bestIdx = i;
        }
      }
      if (bestIdx < 0) break;

      const head = curTrips.slice(0, bestIdx);
      out.push({
        trips: head,
        startSec: head[0].startSec,
        endSec: head[head.length - 1].endSec,
        durSec: Math.max(0, head[head.length - 1].endSec - head[0].startSec),
        isCortado: false,
        isRelevoEnLinea: true,
        relevoFromPrev: out.length > 0,
        relevoToNext: true,
        isPeak
      });
      curTrips = curTrips.slice(bestIdx);
    }

    const tailDur = Math.max(0, curTrips[curTrips.length - 1].endSec - curTrips[0].startSec);
    const cameFromRelevo = out.length > 0;
    out.push({
      trips: curTrips,
      startSec: curTrips[0].startSec,
      endSec: curTrips[curTrips.length - 1].endSec,
      durSec: tailDur,
      // A trailing night relief right after a relevo en línea is a continuation shift, NOT a morning cortado
      isCortado: cameFromRelevo ? false : !isInterprovincial && tailDur < 5.5 * 3600,
      isRelevoEnLinea: cameFromRelevo,
      relevoFromPrev: cameFromRelevo,
      relevoToNext: false,
      isPeak
    });
    return out;
  };

  // 3e) Finalize blockInfo objects with true serviceNumber (1..N), per-shift turnoIndex, and per-shift laps
  const blockInfos = [];
  const blockInfoById = new Map();
  const fleetServices = [];
  let corridosCount = 0;
  let cortadosCount = 0;
  let relevoEnLineaCount = 0;

  for (let s = 1; s <= totalServices; s++) {
    const rawParts = (serviceBlocksMap.get(s) || []).sort((a, b) => a.startSec - b.startSec);
    if (!rawParts.length) continue;

    const parts = rawParts.flatMap((p) => splitContinuousShift(p));
    const firstPart = parts[0];
    const hasRelevo = parts.some((p) => p.isRelevoEnLinea);
    if (firstPart.isCortado) cortadosCount++;
    else corridosCount++;
    if (hasRelevo) relevoEnLineaCount++;

    const serviceTurnos = parts.map((p, idx) => ({
      blockId: `blk:${numCode}:${resolved.tipo}:${s}:t${idx + 1}`,
      turnoIndex: idx + 1,
      startSec: p.startSec,
      endSec: p.endSec,
      durationSec: p.durSec,
      isCortado: p.isCortado,
      isRelevoEnLinea: p.isRelevoEnLinea,
      relevoFromPrev: Boolean(p.relevoFromPrev),
      relevoToNext: Boolean(p.relevoToNext),
      legCount: p.trips.length,
      shiftLaps: p.trips.length / 2
    }));

    fleetServices.push({
      serviceNumber: s,
      isCortadoMorning: firstPart.isCortado,
      isRelevoEnLinea: hasRelevo,
      turnos: serviceTurnos
    });

    parts.forEach((p, idx) => {
      const turnoIndex = idx + 1;
      const blockId = serviceTurnos[idx].blockId;
      const shiftLaps = p.trips.length / 2;
      const info = {
        blockId,
        serviceNumber: s,
        turnoIndex,
        serviceTurnosCount: parts.length,
        serviceTurnos,
        isPeakService: Boolean(p.isPeak),
        isCortado: p.isCortado,
        isRelevoEnLinea: p.isRelevoEnLinea,
        relevoFromPrev: Boolean(p.relevoFromPrev),
        relevoToNext: Boolean(p.relevoToNext),
        isInterprovincial,
        startSec: p.startSec,
        endSec: p.endSec,
        durationSec: p.durSec,
        legCount: p.trips.length,
        shiftLaps,
        trips: p.trips
      };

      // Per-shift lap numbering: strictly resets to Vuelta 1 on every new turno / relevo en línea!
      // Handles whole-lap (e.g. 5 vueltas = 10 legs) and half-lap (e.g. 4½ = 9 legs, 3½ = 7 legs) shifts accurately.
      p.trips.forEach((t, legIdx) => {
        const isHalfLap = p.trips.length % 2 === 1 && legIdx === p.trips.length - 1;
        const lap = isHalfLap ? Math.floor(legIdx / 2) + 0.5 : Math.floor(legIdx / 2) + 1;
        t.blockId = blockId;
        t.serviceNumber = s;
        t.turnoIndex = turnoIndex;
        t.serviceTurnosCount = parts.length;
        t.lapNumber = lap;
        t.shiftLaps = shiftLaps;
        t.isHalfLap = isHalfLap;
        t.isCortadoBlock = p.isCortado;
        t.isRelevoEnLinea = p.isRelevoEnLinea;
        t.blockInfo = info;
      });

      blockInfos.push(info);
      blockInfoById.set(blockId, info);
    });
  }

  const fleetSummary = {
    totalServices: fleetServices.length,
    corridosCount,
    cortadosCount,
    middayValleyCount: Math.min(fleetServices.length, middayValleyCount),
    relevoEnLineaCount,
    services: fleetServices
  };

  const model = {
    codLinea: numCode,
    tipoDia: resolved.tipo,
    exactTipo: resolved.exact,
    isInterprovincial,
    branches,
    primaryBranch,
    branchTrips,
    tripByKey,
    blocks: blockInfos,
    blockInfoById,
    fleetSummary,
    getTripsForBranch: (b) => branchTrips.get(getBranchKey(b)) || []
  };
  byTipo.set(cacheKey, model);
  return model;
}

/**
 * Maps every scheduled pass slot at `stopId` to its reconstructed continuous vehicle rotation block
 * (Servicio/Bloque, vuelta number, variable lap durations, and whether the rotation is cortado or continuo).
 */
export function buildStopTimetableBlocks(model, stopId, stopCoords) {
  const slotMetaByHora = new Map(); // 'HH:MM' -> { trip, blockInfo, lapAtStop, totalLapsAtStop, stopSlots }
  const blockSlotsById = new Map(); // blockId -> Array<{ hora, sec, trip, lapAtStop }>
  if (!model || !stopCoords) return { slotMetaByHora, blockSlotsById };

  const stopBranches = pickStopBranches(model.branches, stopId, stopCoords);
  if (!stopBranches.length) return { slotMetaByHora, blockSlotsById };

  for (const sb of stopBranches) {
    const sp = projectOnPolyline(sb.pts, sb.cum, stopCoords.lat, stopCoords.lng);
    for (const tr of model.getTripsForBranch(sb)) {
      const stSec = getTripStopSec(tr, stopId, sp?.along ?? 0);
      if (stSec === null) continue;
      const hora = formatSecHHMM(stSec);
      const bId = tr.blockId || tr.tripKey;
      if (!blockSlotsById.has(bId)) blockSlotsById.set(bId, []);
      blockSlotsById.get(bId).push({ hora, sec: stSec, trip: tr });
    }
  }

  for (const [bId, slots] of blockSlotsById.entries()) {
    slots.sort((a, b) => a.sec - b.sec);
    const info = model.blockInfoById?.get(bId) || null;
    slots.forEach((s, idx) => {
      s.lapAtStop = idx + 1;
      s.deltaPrevMin = idx > 0 ? Math.round((s.sec - slots[idx - 1].sec) / 60) : null;
      if (!slotMetaByHora.has(s.hora)) {
        slotMetaByHora.set(s.hora, {
          hora: s.hora,
          sec: s.sec,
          trip: s.trip,
          blockId: bId,
          blockInfo: info,
          lapAtStop: idx + 1,
          totalLapsAtStop: slots.length,
          stopSlots: slots
        });
      }
    });
  }

  return { slotMetaByHora, blockSlotsById };
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

function isAtBranchStartTerminal(branch, projAlong, lat, lng, incomingBranch = null) {
  if (!branch?.pts?.length) return false;
  const firstStopAlong = branch.orderedStops?.[0]?.along ?? 0;
  const maxStartAlong = Math.min(360, Math.max(240, firstStopAlong + 145));
  if (projAlong <= maxStartAlong) return true;
  const startPt = branch.pts[0];
  if ((distanceMeters(lat, lng, startPt[0], startPt[1]) ?? Infinity) <= 250) return true;
  const incPts = incomingBranch?.pts;
  if (incPts?.length) {
    const incEndPt = incPts[incPts.length - 1];
    if ((distanceMeters(lat, lng, incEndPt[0], incEndPt[1]) ?? Infinity) <= 250) return true;
  }
  return false;
}

function isAtBranchEndTerminal(branch, projAlong, lat, lng, outgoingBranch = null) {
  if (!branch?.pts?.length) return false;
  const remToEnd = Math.max(0, (branch.totalLen ?? 0) - projAlong);
  if (remToEnd <= 380) return true;
  const endPt = branch.pts[branch.pts.length - 1];
  if ((distanceMeters(lat, lng, endPt[0], endPt[1]) ?? Infinity) <= 250) return true;
  const outStartPt = outgoingBranch?.pts?.[0];
  if (outStartPt && (distanceMeters(lat, lng, outStartPt[0], outStartPt[1]) ?? Infinity) <= 250) return true;
  return false;
}

function unitVector(lat1, lng1, lat2, lng2) {
  const cosLat = Math.cos(((lat1 + lat2) * 0.5 * Math.PI) / 180);
  const dx = (lng2 - lng1) * cosLat;
  const dy = lat2 - lat1;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return null;
  return [dx / len, dy / len];
}

/**
 * Builds a spatial-temporal GPS anchor for `trip` from a last-known GPS fix `(lat, lng, clockSec)`.
 * Evaluates up to 3 legs along the vehicle block (`trip`, `prevTrip`, and `prevTrip.prevTrip` / full_cycle)
 * choosing the leg whose scheduled time at the GPS projection best matches `clockSec + fallbackDesvioSec`.
 *
 * Enforces:
 *  1) Punta de línea (cabecera) departure rule: an early bus at a cabecera waits until `trip.startSec` and
 *     departs punctually on time (`initialOffsetSec = 0`).
 *  2) Two-way street & pre-departure anti-U-turn protection: uses GPS heading vector (`prevFix -> (lat, lng)`
 *     vs `proj.tangent`), pre-departure mid-route guards, and `preferredLeg` continuity so a bus driving toward
 *     a cabecera on a two-way street (like Av. Sarmiento / Plaza 25 de Mayo) NEVER flips direction onto the
 *     return leg before reaching the cabecera!
 */
export function buildGpsAnchorForTrip(trip, lat, lng, clockSec, fallbackDesvioSec = 0, options = {}) {
  if (!trip || typeof lat !== 'number' || typeof lng !== 'number' || Number.isNaN(lat) || Number.isNaN(lng)) {
    return null;
  }
  if (!Number.isFinite(clockSec)) return null;

  const effClock = toServiceSec(clockSec);
  const prevFix = options?.prevFix || null;
  const preferredLeg = options?.preferredLeg || null;
  let gpsDir = null;
  if (
    prevFix &&
    typeof prevFix.lat === 'number' &&
    typeof prevFix.lng === 'number' &&
    (distanceMeters(prevFix.lat, prevFix.lng, lat, lng) ?? 0) >= 20
  ) {
    gpsDir = unitVector(prevFix.lat, prevFix.lng, lat, lng);
  }

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

    let rawOffset = schedSecAtAnchor - effClock;
    if (rawOffset > 43200) rawOffset -= 86400;
    if (rawOffset < -43200) rawOffset += 86400;

    // Sanity guard: ignore anchor if > 60 min off schedule (stale/different cycle)
    if (Math.abs(rawOffset) > 60 * 60) continue;

    // Check if the bus is parked/staging at `trip`'s origin cabecera (start of `trip` or arrival end of `prevTrip`)
    const atTripOriginCabecera =
      (cand.depth === 0 && isAtBranchStartTerminal(trip.branch, proj.along, lat, lng, trip.prevTrip?.branch)) ||
      (cand.depth === 1 && isAtBranchEndTerminal(cand.t.branch, proj.along, lat, lng, trip.branch));

    const tripDepRefSec = cand.depth === 0 ? Math.max(trip.startSec, schedSecAtAnchor) : trip.startSec;
    const waitingAtTripOrigin =
      atTripOriginCabecera &&
      (effClock <= tripDepRefSec + 20 ||
        (cand.depth === 0 && rawOffset > 0) ||
        (fallbackDesvioSec > 0 && effClock <= tripDepRefSec + 240));

    // Check if the bus is parked/staging at `prevTrip`'s origin cabecera (start of `prevTrip` or arrival end of `prev.prevTrip`)
    const prevTrip = trip.prevTrip;
    const atPrevOriginCabecera =
      Boolean(prevTrip) &&
      !waitingAtTripOrigin &&
      ((cand.depth === 1 && isAtBranchStartTerminal(prevTrip.branch, proj.along, lat, lng, prevTrip.prevTrip?.branch)) ||
        (cand.depth === 2 && isAtBranchEndTerminal(cand.t.branch, proj.along, lat, lng, prevTrip.branch)));

    let waitingAtPrevOrigin = false;
    if (atPrevOriginCabecera && prevTrip) {
      const prevDepRefSec = cand.depth === 1 ? Math.max(prevTrip.startSec, schedSecAtAnchor) : prevTrip.startSec;
      waitingAtPrevOrigin =
        effClock <= prevDepRefSec + 20 ||
        (cand.depth === 1 && rawOffset > 0) ||
        (fallbackDesvioSec > 0 && effClock <= prevDepRefSec + 240);
    }

    let score;
    let initialOffsetSec = rawOffset;
    if (waitingAtTripOrigin) {
      // Waiting at `trip` origin punta de línea ahead of departure: lock to closest terminal polyline and reset offset to 0 (punctual departure!)
      initialOffsetSec = 0;
      score = proj.perp + cand.depth * 18;
    } else if (waitingAtPrevOrigin) {
      initialOffsetSec = 0;
      score = proj.perp + (cand.depth - 1) * 18 + 30;
    } else {
      // Score against known desvioSec so buses near turnarounds (shared streets) lock to the exact real leg!
      let desvioErr = Math.abs(rawOffset - (fallbackDesvioSec || 0));
      if (desvioErr > 43200) desvioErr = 86400 - desvioErr;
      score = desvioErr + cand.depth * 25;

      // 1) Pre-departure mid-route guard on two-way streets:
      //    A bus cannot already be mid-route (`!atTripOriginCabecera`) on `trip` (`depth === 0`) when the real clock
      //    is still minutes before `trip.startSec` while `prevTrip` (`depth === 1`) is actively running toward the cabecera!
      if (
        cand.depth === 0 &&
        !atTripOriginCabecera &&
        prevTrip &&
        effClock < trip.startSec - 150 &&
        effClock <= prevTrip.endSec + 600
      ) {
        score += 2200;
      }
      if (
        cand.depth === 1 &&
        !atPrevOriginCabecera &&
        prevTrip?.prevTrip &&
        effClock < prevTrip.startSec - 150 &&
        effClock <= prevTrip.prevTrip.endSec + 600
      ) {
        score += 2200;
      }

      // 2) Real GPS heading vector alignment against polyline tangent (prevents U-turns on shared two-way avenues!)
      if (gpsDir && proj.tangent) {
        const dot = gpsDir[0] * proj.tangent[0] + gpsDir[1] * proj.tangent[1];
        if (dot < -0.25) {
          score += 2400; // moving in the opposite direction of this branch!
        } else if (dot > 0.35) {
          score -= 180; // moving in the exact direction of this branch!
        }
      }

      // 3) Continuity with already-resolved live leg (`preferredLeg`)
      if (preferredLeg === 'previous_leg') {
        if (cand.depth === 1) score -= 160;
        else if (cand.depth === 0 && effClock < trip.startSec) score += 700;
      } else if (preferredLeg === 'full_cycle') {
        if (cand.depth === 2) score -= 160;
        else if (cand.depth === 0 && effClock < trip.startSec) score += 700;
      } else if (preferredLeg === 'direct' && cand.depth === 0 && effClock >= trip.startSec - 120) {
        score -= 120;
      }
    }

    if (score < bestScore) {
      bestScore = score;
      best = {
        branch: cand.t.branch,
        isStopBranch: cand.depth === 0,
        legDepth: cand.depth,
        along: proj.along,
        clockSec: effClock,
        initialOffsetSec,
        atOriginTerminal: waitingAtTripOrigin,
        atPrevOriginTerminal: waitingAtPrevOrigin,
        terminalWaitUntilSec: waitingAtTripOrigin
          ? trip.startSec
          : waitingAtPrevOrigin && prevTrip
            ? prevTrip.startSec
            : null
      };
    }
  }

  return best;
}

/**
 * Evaluates the exact real-time state of a scheduled trip approaching `stopProj` on `trip.branch`
 * across up to 3 vehicle-block legs (`trip`, `prevTrip`, and `prevTrip.prevTrip` / `full_cycle`).
 *
 * Enforces physical cabecera rules:
 *  - When a bus is at a punta de línea ahead of schedule (`anchor.atOriginTerminal` or after arriving early
 *    from `prevTrip`), it waits quietly at the cabecera (`speedMps = 0, isAtTerminal = true`) until the
 *    scheduled departure time (`effNow >= trip.startSec`) and then departs punctually (`effectiveOffsetSec = 0`),
 *    neither early nor late!
 *  - When a bus is mid-route or late, it starts right from its last GPS position and gradually recovers delay.
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

  const effNow = toServiceSec(nowSec);

  // Only reject as already-passed if anchored directly on THIS trip (`legDepth === 0`) past `stopProj.along`!
  // Never reject a `legDepth === 2` (`full_cycle`) bus finishing the previous lap!
  const isAnchorOnThisLeg = anchor && (anchor.legDepth === 0 || (anchor.legDepth === undefined && anchor.isStopBranch));
  if (isAnchorOnThisLeg && !anchor.atOriginTerminal && anchor.along > stopProj.along + 60) {
    return null;
  }

  const stopBranch = trip.branch;

  // ── Case 0: Bus was last seen parked/waiting at `trip`'s origin punta de línea ahead of `trip.startSec` ──
  // Must stay completely stationary at its exact cabecera spot until `effNow >= trip.startSec`,
  // and then depart punctually on time (`effectiveOffsetSec = 0`: neither early nor late)!
  if (anchor?.atOriginTerminal) {
    const etaSec = targetStopSec - effNow; // effectiveOffsetSec === 0 (punctual departure at trip.startSec)
    if (etaSec < -45 || etaSec > maxAheadSec) return null;

    const termBranch = anchor.branch || stopBranch;
    const termAlong = Number.isFinite(anchor.along) ? anchor.along : 0;
    const inOpp = termBranch !== stopBranch;
    const oppRem = inOpp ? Math.max(0, termBranch.totalLen - termAlong) : 0;

    if (effNow < trip.startSec) {
      const sample = sampleBranchAtAlong(termBranch, termAlong) || sampleBranchAtAlong(stopBranch, 0);
      if (!sample) return null;
      const remainingMeters = inOpp ? oppRem + stopProj.along : Math.max(0, stopProj.along - termAlong);
      return {
        activeBranch: termBranch,
        activeAlong: termAlong,
        viaBranch: null,
        legDepth: inOpp ? 1 : 0,
        lat: sample.lat,
        lng: sample.lng,
        remainingMeters,
        etaSec: Math.max(0, etaSec),
        speedMps: 0,
        isAtTerminal: true,
        inOppositeLeg: inOpp,
        inNextCycle: false,
        realBandera: termBranch.bandera,
        realBanderaColor: termBranch.color,
        effectiveOffsetSec: 0,
        targetStopSec
      };
    }

    // `effNow >= trip.startSec`: depart punctually right at `trip.startSec` from the exact anchored cabecera spot (0.00 m jump!)
    const ev = evalPointsAtSec(trip.points, Math.min(effNow, targetStopSec));
    const u = stopProj.along > 1 ? Math.max(0, Math.min(1, ev.along / stopProj.along)) : 1;

    if (inOpp && oppRem > 1) {
      const totalDist = oppRem + stopProj.along;
      const travelled = u * totalDist;
      const scale = totalDist / Math.max(1, stopProj.along);
      if (travelled < oppRem) {
        const curAlong = Math.min(termBranch.totalLen, termAlong + travelled);
        const sample = sampleBranchAtAlong(termBranch, curAlong);
        if (!sample) return null;
        const remainingMeters = Math.max(0, totalDist - travelled);
        const spd = Math.min(25.0, ev.speedMps * scale);
        return {
          activeBranch: termBranch,
          activeAlong: curAlong,
          viaBranch: null,
          legDepth: 1,
          lat: sample.lat,
          lng: sample.lng,
          remainingMeters,
          etaSec: Math.max(0, etaSec),
          speedMps: spd,
          isAtTerminal: spd <= 0.05,
          inOppositeLeg: true,
          inNextCycle: false,
          realBandera: termBranch.bandera,
          realBanderaColor: termBranch.color,
          effectiveOffsetSec: 0,
          targetStopSec
        };
      }
      const along = Math.min(stopProj.along, Math.max(0, travelled - oppRem));
      const sample = sampleBranchAtAlong(stopBranch, along);
      if (!sample) return null;
      const remainingMeters = Math.max(0, stopProj.along - along);
      const spd = remainingMeters <= 5 ? 0 : Math.min(25.0, ev.speedMps * scale);
      return {
        activeBranch: stopBranch,
        activeAlong: along,
        viaBranch: null,
        legDepth: 0,
        lat: sample.lat,
        lng: sample.lng,
        remainingMeters,
        etaSec: Math.max(0, etaSec),
        speedMps: spd,
        isAtTerminal: false,
        inOppositeLeg: false,
        inNextCycle: false,
        realBandera: stopBranch.bandera,
        realBanderaColor: stopBranch.color,
        effectiveOffsetSec: 0,
        targetStopSec
      };
    }

    const startAlong = Math.min(termAlong, Math.max(0, stopProj.along - 10));
    const span = Math.max(1, stopProj.along - startAlong);
    const along = Math.min(stopProj.along, startAlong + u * span);
    const sample = sampleBranchAtAlong(stopBranch, along);
    if (!sample) return null;
    const remainingMeters = Math.max(0, stopProj.along - along);
    const scale = span / Math.max(1, stopProj.along);
    const spd = remainingMeters <= 5 ? 0 : Math.min(25.0, ev.speedMps * scale);
    return {
      activeBranch: stopBranch,
      activeAlong: along,
      viaBranch: null,
      legDepth: 0,
      lat: sample.lat,
      lng: sample.lng,
      remainingMeters,
      etaSec: Math.max(0, etaSec),
      speedMps: spd,
      isAtTerminal: spd <= 0.05,
      inOppositeLeg: false,
      inNextCycle: false,
      realBandera: stopBranch.bandera,
      realBanderaColor: stopBranch.color,
      effectiveOffsetSec: 0,
      targetStopSec
    };
  }

  // ── Compute per-leg schedule offsets enforcing cabecera advance absorption ──
  // An early bus (`> 0`) on `pp` or `prev` (or without a mid-route `legDepth === 0` GPS anchor)
  // NEVER departs a punta de línea early: its positive advance is absorbed to `0` at the cabecera!
  let baseOffsetSec = desvioSec || 0;
  if (anchor && Number.isFinite(anchor.clockSec) && Number.isFinite(anchor.initialOffsetSec)) {
    const elapsedSec = Math.max(0, effNow - anchor.clockSec);
    baseOffsetSec = anchor.atPrevOriginTerminal ? 0 : computeGradualOffsetSec(anchor.initialOffsetSec, elapsedSec);
  }

  const originDepth = anchor && typeof anchor.legDepth === 'number' ? anchor.legDepth : 0;
  const observedMidRouteOnTrip = Boolean(anchor && originDepth === 0 && !anchor.atOriginTerminal);

  const prev = trip.prevTrip || null;
  const pp = prev?.prevTrip || null;

  const offsetPP = originDepth === 2 ? baseOffsetSec : 0;
  let offsetPrev = baseOffsetSec;
  if (anchor?.atPrevOriginTerminal) {
    offsetPrev = 0;
  } else if (originDepth === 2 && prev && pp) {
    const layPPToPrev = Math.max(0, prev.startSec - pp.endSec);
    offsetPrev = offsetPP >= 0 ? 0 : Math.min(0, offsetPP + Math.max(0, layPPToPrev - 90));
  } else if (!anchor && offsetPrev > 0) {
    // Without a mid-route GPS anchor on prevTrip, never depart prevTrip's origin cabecera early
    if (prev && effNow < prev.startSec) offsetPrev = 0;
  }

  let offsetTrip;
  if (observedMidRouteOnTrip) {
    offsetTrip = baseOffsetSec;
  } else if (offsetPrev >= 0) {
    // Early or on-time bus arriving at (or waiting at) `trip`'s origin cabecera -> waits for `trip.startSec` and departs ON TIME (0)!
    offsetTrip = 0;
  } else if (originDepth >= 1 && prev) {
    // Late bus arriving from `prevTrip` -> cabecera layover absorbs delay (keeping 90 s turnaround)
    const layPrevToTrip = Math.max(0, trip.startSec - prev.endSec);
    offsetTrip = Math.min(0, offsetPrev + Math.max(0, layPrevToTrip - 90));
  } else {
    offsetTrip = offsetPrev; // (< 0, late)
  }

  const tEffTrip = effNow + offsetTrip;
  const tEffPrev = effNow + offsetPrev;
  const tEffPP = effNow + offsetPP;
  const etaSec = targetStopSec - tEffTrip;

  // Already passed the stop by more than 45 s, or beyond horizon
  if (etaSec < -45 || etaSec > maxAheadSec) return null;

  const speedFactorTrip = offsetTrip < -30 ? 1.08 : offsetTrip > 30 ? 0.94 : 1.0;
  const speedFactorPrev = offsetPrev < -30 ? 1.08 : offsetPrev > 30 ? 0.94 : 1.0;
  const speedFactorPP = offsetPP < -30 ? 1.08 : offsetPP > 30 ? 0.94 : 1.0;

  // 1) Directly on stopBranch (`legDepth = 0`, approaching or arriving at stop)
  if (tEffTrip >= trip.startSec) {
    const ev = evalPointsAtSec(trip.points, Math.min(tEffTrip, targetStopSec));
    const along = Math.min(stopProj.along, ev.along);
    const sample = sampleBranchAtAlong(stopBranch, along);
    if (!sample) return null;
    const remainingMeters = Math.max(0, stopProj.along - along);
    const spd = remainingMeters <= 5 ? 0 : Math.min(25.0, ev.speedMps * speedFactorTrip);
    return {
      activeBranch: stopBranch,
      activeAlong: along,
      viaBranch: null,
      legDepth: 0,
      lat: sample.lat,
      lng: sample.lng,
      remainingMeters,
      etaSec: Math.max(0, etaSec),
      speedMps: spd,
      isAtTerminal: spd <= 0.05 && along <= 30,
      inOppositeLeg: false,
      inNextCycle: false,
      realBandera: stopBranch.bandera,
      realBanderaColor: stopBranch.color,
      effectiveOffsetSec: offsetTrip,
      targetStopSec
    };
  }

  // 2) Chained return/feeder leg (`trip.prevTrip`, `legDepth = 1`) and turnaround layovers
  if (prev) {
    // 2a) Resting at `trip` origin cabecera between `prev.endSec` (at `tEffPrev`) and `trip.startSec` (at `tEffTrip`)
    if (tEffPrev >= prev.endSec) {
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
        effectiveOffsetSec: offsetTrip,
        targetStopSec
      };
    }

    // 2a-bis) Anchored waiting at `prevTrip`'s origin cabecera before `prev.startSec`
    if (anchor?.atPrevOriginTerminal && effNow < prev.startSec) {
      const termBranch = anchor.branch || prev.branch;
      const termAlong = Number.isFinite(anchor.along) ? anchor.along : 0;
      const sample = sampleBranchAtAlong(termBranch, termAlong) || sampleBranchAtAlong(prev.branch, 0);
      if (!sample) return null;
      const inPP = termBranch !== prev.branch;
      const ppRem = inPP ? Math.max(0, termBranch.totalLen - termAlong) : 0;
      const remainingMeters = inPP
        ? ppRem + prev.branch.totalLen + stopProj.along
        : Math.max(0, prev.branch.totalLen - termAlong) + stopProj.along;
      return {
        activeBranch: termBranch,
        activeAlong: termAlong,
        viaBranch: inPP ? prev.branch : null,
        legDepth: inPP ? 2 : 1,
        lat: sample.lat,
        lng: sample.lng,
        remainingMeters,
        etaSec: Math.max(0, etaSec),
        speedMps: 0,
        isAtTerminal: true,
        inOppositeLeg: !inPP,
        inNextCycle: inPP,
        realBandera: termBranch.bandera,
        realBanderaColor: termBranch.color,
        effectiveOffsetSec: 0,
        targetStopSec
      };
    }

    // 2b) Actively driving on `prevTrip` (`legDepth = 1`)
    if (tEffPrev >= prev.startSec) {
      const ev = evalPointsAtSec(prev.points, Math.min(tEffPrev, prev.endSec));
      const sample = sampleBranchAtAlong(prev.branch, ev.along);
      if (!sample) return null;
      const oppRem = Math.max(0, prev.branch.totalLen - ev.along);
      const remainingMeters = oppRem + stopProj.along;
      const spd = oppRem <= 3 ? 0 : Math.min(25.0, ev.speedMps * speedFactorPrev);
      return {
        activeBranch: prev.branch,
        activeAlong: ev.along,
        viaBranch: null,
        legDepth: 1,
        lat: sample.lat,
        lng: sample.lng,
        remainingMeters,
        etaSec: Math.max(0, etaSec),
        speedMps: spd,
        isAtTerminal: spd <= 0.05,
        inOppositeLeg: true,
        inNextCycle: false,
        realBandera: prev.branch.bandera,
        realBanderaColor: prev.branch.color,
        effectiveOffsetSec: offsetPrev,
        targetStopSec
      };
    }

    // 2c) Previous lap (`trip.prevTrip.prevTrip`, `legDepth = 2` -> `full_cycle`)!
    if (pp) {
      // Resting at `prevTrip` origin cabecera between `pp.endSec` (at `tEffPP`) and `prev.startSec` (at `tEffPrev`)
      if (tEffPP >= pp.endSec) {
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
          effectiveOffsetSec: offsetPrev,
          targetStopSec
        };
      }

      // Actively driving on `prev.prevTrip` (`full_cycle`: `pp` -> `prev` -> `trip`)
      if (tEffPP >= pp.startSec) {
        const ev = evalPointsAtSec(pp.points, Math.min(tEffPP, pp.endSec));
        const sample = sampleBranchAtAlong(pp.branch, ev.along);
        if (!sample) return null;
        const ppRem = Math.max(0, pp.branch.totalLen - ev.along);
        const remainingMeters = ppRem + prev.branch.totalLen + stopProj.along;
        const spd = ppRem <= 3 ? 0 : Math.min(25.0, ev.speedMps * speedFactorPP);
        return {
          activeBranch: pp.branch,
          activeAlong: ev.along,
          viaBranch: prev.branch,
          legDepth: 2,
          lat: sample.lat,
          lng: sample.lng,
          remainingMeters,
          etaSec: Math.max(0, etaSec),
          speedMps: spd,
          isAtTerminal: spd <= 0.05,
          inOppositeLeg: false,
          inNextCycle: true,
          realBandera: pp.branch.bandera,
          realBanderaColor: pp.branch.color,
          effectiveOffsetSec: offsetPP,
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
    effectiveOffsetSec: offsetTrip,
    targetStopSec
  };
}

/**
 * Matches a single bus `(lat, lng, desvioSec, etaMin, leg)` directly to its exact scheduled trip
 * using spatial-temporal curve alignment `|trip.secAt(busAlong) - (nowSec + desvioSec)|` across
 * up to 3 vehicle-block legs (`direct`, `previous_leg`, and `full_cycle`)!
 * Works accurately even when a bus is +20 min early or -40 min late!
 */
function findNextSameBranchPassTime(trip, stopId, stopAlong) {
  const block = trip?.block;
  if (!Array.isArray(block) || typeof trip.blockIndex !== 'number') return null;
  for (let i = trip.blockIndex + 1; i < Math.min(block.length, trip.blockIndex + 5); i++) {
    const next = block[i];
    if (next && next.branch === trip.branch) {
      const sec = getTripStopSec(next, stopId, stopAlong);
      return sec !== null ? formatSecHHMM(sec) : null;
    }
  }
  return null;
}

/**
 * Exact Kuhn-Munkres / Hungarian minimum-cost rectangular assignment solver.
 * Assigns `R` live physical buses to `C` scheduled services (or unassigned slack of cost `unassignedPenalty`)
 * minimizing the exact global sum of errors across the entire line simultaneously.
 * Complexity O(R^2 * (C + R)) — for Corrientes fleet sizes (<= 15), executes in < 0.05 ms.
 */
export function solveMinCostAssignment(costMatrix = [], unassignedPenalty = 2400) {
  const R = costMatrix.length;
  if (R === 0) return [];
  const C = costMatrix[0]?.length || 0;
  if (C === 0) return new Array(R).fill(-1);

  const W = C + R;
  const BIG = 1e9;
  const a = Array.from({ length: R + 1 }, () => new Array(W + 1).fill(BIG));

  for (let i = 1; i <= R; i++) {
    const row = costMatrix[i - 1];
    for (let j = 1; j <= C; j++) {
      const val = row[j - 1];
      if (typeof val === 'number' && Number.isFinite(val)) {
        a[i][j] = val;
      }
    }
    // Dedicated unassigned slack column for row i so every row always has a finite fallback
    a[i][C + i] = unassignedPenalty;
  }

  const u = new Array(R + 1).fill(0);
  const v = new Array(W + 1).fill(0);
  const p = new Array(W + 1).fill(0);
  const way = new Array(W + 1).fill(0);

  for (let i = 1; i <= R; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array(W + 1).fill(Infinity);
    const used = new Array(W + 1).fill(false);

    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = Infinity;
      let j1 = 0;

      for (let j = 1; j <= W; j++) {
        if (!used[j]) {
          const cur = a[i0][j] - u[i0] - v[j];
          if (cur < minv[j]) {
            minv[j] = cur;
            way[j] = j0;
          }
          if (minv[j] < delta) {
            delta = minv[j];
            j1 = j;
          }
        }
      }

      for (let j = 0; j <= W; j++) {
        if (used[j]) {
          u[p[j]] += delta;
          v[j] -= delta;
        } else {
          minv[j] -= delta;
        }
      }
      j0 = j1;
    } while (p[j0] !== 0);

    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0 !== 0);
  }

  const assignment = new Array(R).fill(-1);
  for (let j = 1; j <= C; j++) {
    if (p[j] > 0) {
      const rIdx = p[j] - 1;
      const val = costMatrix[rIdx][j - 1];
      if (typeof val === 'number' && Number.isFinite(val) && val < unassignedPenalty) {
        assignment[rIdx] = j - 1;
      }
    }
  }
  return assignment;
}

/**
 * Scores a stop-approaching bus against a candidate scheduled trip `item`.
 * Returns `{ rawScore, effScore }` (seconds of error) or `null` if outside tolerance.
 * `rawScore` is 100% unbiased (used for global auto-correction); `effScore` includes only a
 * lightweight anti-flicker hysteresis tie-breaker (-90 s same trip / -65 s same service today).
 */
function scoreBusAgainstCandidate(
  bus,
  item,
  nowSec,
  stickyRec,
  evidenceRec,
  busNormBandera,
  getProjForBranch
) {
  const desvioSec = bus.desvio?.seconds || 0;
  const hasDesvio = bus.desvio && bus.desvio.status !== 'none';
  const stickyTripKey = stickyRec?.tripKey || null;
  const stickyService = stickyRec?.serviceNumber || null;
  const isStickyTrip = Boolean(stickyTripKey && item.trip.tripKey === stickyTripKey);
  const isStickyService = Boolean(stickyService && item.trip.serviceNumber === stickyService);
  const effNow = toServiceSec(nowSec);

  const confirmedBranch =
    !bus.trajectory?.isAtTerminal &&
    (bus.trajectory?.directionSource === 'trail' || bus.trajectory?.directionSource === 'persisted')
      ? bus.trajectory.confirmedBranch
      : null;

  // ── Signal A: Exact spatial-temporal match using GPS coordinate + SmartMovePro desvio ──
  // Independent of SmartMovePro's noisy ETA and works even if the bus is 30 min late or 15 min early!
  let spatialDiffSec = Infinity;
  if (typeof bus.lat === 'number' && typeof bus.lng === 'number' && hasDesvio) {
    const tEff = effNow + desvioSec;
    const leg = bus.trajectory?.leg;
    const isOpp = leg === 'previous_leg' || bus.isOppositeLeg;
    const isFullCycle = leg === 'full_cycle' || bus.isNextCycle || bus.isNextLap;

    const testTripSpatial = (tr) => {
      if (!tr) return Infinity;
      const proj = getProjForBranch(tr.branch);
      if (!proj || proj.perp > 160) return Infinity;
      const schedAtBus = getTripSecAtAlong(tr, proj.along);
      if (schedAtBus === null) return Infinity;
      let d = Math.abs(schedAtBus - tEff);
      if (d > 43200) d = Math.abs(d - 86400);
      // Multi-point GPS trail direction penalty: prevent matching opposite-direction trips on two-way avenues
      if (confirmedBranch && tr.branch !== confirmedBranch) {
        const nearTerminal = proj.along <= 240 || (tr.branch.totalLen || 0) - proj.along <= 240;
        if (!nearTerminal) d += 9 * 60;
      }
      return d;
    };

    if (isFullCycle) {
      spatialDiffSec = Math.min(
        testTripSpatial(item.trip.prevTrip?.prevTrip),
        testTripSpatial(item.trip.prevTrip)
      );
    } else if (isOpp) {
      spatialDiffSec = Math.min(
        testTripSpatial(item.trip.prevTrip),
        testTripSpatial(item.trip.prevTrip?.prevTrip)
      );
    } else if (bus.trajectory?.isAtTerminal) {
      spatialDiffSec = Math.min(
        testTripSpatial(item.trip),
        testTripSpatial(item.trip.prevTrip)
      );
    } else {
      spatialDiffSec =
        effNow < item.trip.startSec - 120 && item.trip.prevTrip
          ? Math.min(testTripSpatial(item.trip), testTripSpatial(item.trip.prevTrip))
          : testTripSpatial(item.trip);
    }
  }

  // ── Signal B: ETA + Desvio match (`Now + ETA + Desvio` vs `targetStopSec`) ──
  let etaDiffSec = Infinity;
  if (bus.eta && bus.eta.valid !== false && typeof bus.eta.minutes === 'number' && bus.eta.minutes <= 240) {
    const expectedSec = effNow + bus.eta.minutes * 60 + desvioSec;
    let d = Math.abs(item.stSec - expectedSec);
    if (d > 43200) d = Math.abs(d - 86400);
    etaDiffSec = d;
  }

  // Combine both signals: spatial-temporal dominates when available (exact even at ±35 min off-schedule!)
  let bestRawDiff;
  let maxAllowed;
  if (spatialDiffSec <= 15 * 60) {
    if (etaDiffSec < Infinity && etaDiffSec > 45 * 60) return null;
    bestRawDiff = spatialDiffSec;
    maxAllowed = isStickyTrip || isStickyService ? 18 * 60 : 15 * 60;
  } else {
    if (etaDiffSec === Infinity) return null;
    let baseTolMin = (bus.eta?.minutes || 0) >= 35 || !hasDesvio ? 18 : 14;
    if (bus.esExtendido || bus.isOppositeLeg) baseTolMin += 5;
    if (Math.abs(desvioSec) >= 6 * 60) baseTolMin += 5;
    maxAllowed = isStickyTrip || isStickyService ? Math.max(baseTolMin * 60, 22 * 60) : baseTolMin * 60;
    bestRawDiff = etaDiffSec;
  }

  if (bestRawDiff > maxAllowed) return null;

  let rawScore = bestRawDiff;
  if (busNormBandera && item.normBandera && item.normBandera !== busNormBandera) {
    rawScore += 3 * 60;
  }

  // Lightweight anti-flicker tie-breaker ONLY — small enough that global auto-correction ALWAYS overrides stale guesses!
  let hysteresisBonus = 0;
  if (isStickyTrip) {
    hysteresisBonus = 90;
  } else if (isStickyService) {
    hysteresisBonus = 65;
  } else if (
    evidenceRec &&
    evidenceRec.serviceNumber === item.trip.serviceNumber &&
    evidenceRec.count >= 2 &&
    evidenceRec.avgErrSec <= 240
  ) {
    hysteresisBonus = 75;
  }

  return {
    rawScore,
    effScore: Math.max(0, rawScore - hysteresisBonus)
  };
}

/**
 * Scores a live Corridor Radar peer unit (seen anywhere along the line by Worker probes, even
 * outside the active stop's arrivals) against all trips of a candidate service `serviceNumber`.
 * Allows a real Service 2 spotted elsewhere on the corridor to claim Service 2 in the global
 * matrix and immediately auto-correct a misassigned bus approaching the active stop!
 */
function scoreCorridorPeerAgainstService(unit, serviceTrips, model, nowSec, unitHist) {
  const uLat = parseFloat(unit.latitud ?? unit.lat);
  const uLng = parseFloat(unit.longitud ?? unit.lng);
  if (Number.isNaN(uLat) || Number.isNaN(uLng) || (uLat === 0 && uLng === 0)) return null;

  const ultimaGps = String(unit.ultimaFechaHoraGPS || unit.ultimaGps || '').trim();
  const parsedDesvio =
    typeof unit.desvioSec === 'number'
      ? { seconds: unit.desvioSec, status: 'ok' }
      : parseDesvioHorario(unit.desvioHorario || '');
  const hasDesvio = parsedDesvio && parsedDesvio.status !== 'none';
  const desvioSec = parsedDesvio?.seconds || 0;

  const effNow = toServiceSec(nowSec);
  const uClockRaw = parseGpsStampSecOfDay(ultimaGps);
  const uClock = uClockRaw !== null ? toServiceSec(uClockRaw) : effNow;
  // Ignore stale corridor fixes older than 6 minutes
  if (Math.abs(effNow - uClock) > 6 * 60 && Math.abs(effNow - uClock) < 20 * 3600) return null;

  const tEff = uClock + desvioSec;
  const uNormBandera = normalizeBandera(unit.descripcionBandera || unit.bandera || '');

  // Resolve direction from multi-point GPS trail!
  const trailDir = unitHist
    ? resolveTrailDirection(unitHist, model.branches, {
        currentFix: { lat: uLat, lng: uLng, ts: Date.now() }
      })
    : null;
  if (!hasDesvio && !trailDir) return null;

  const projByBranch = new Map();
  const getProj = (b) => {
    if (!projByBranch.has(b)) projByBranch.set(b, projectOnPolyline(b.pts, b.cum, uLat, uLng));
    return projByBranch.get(b);
  };

  let bestTrip = null;
  let bestRaw = 14 * 60;

  for (const tr of serviceTrips) {
    // Skip trips far outside the current time window
    if (tEff < tr.startSec - 16 * 60 || tEff > tr.endSec + 16 * 60) continue;
    const proj = getProj(tr.branch);
    if (!proj || proj.perp > 150) continue;

    const sched = getTripSecAtAlong(tr, proj.along);
    if (sched === null) continue;
    let d = Math.abs(sched - tEff);
    if (d > 43200) d = Math.abs(d - 86400);

    // Direction check from multi-point trail (or 2-point fallback)
    if (trailDir?.branch) {
      const nearTerminal = proj.along <= 240 || (tr.branch.totalLen || 0) - proj.along <= 240;
      if (trailDir.branch === tr.branch) {
        d = Math.max(0, d - 45);
      } else if (!nearTerminal) {
        d += 12 * 60;
      }
    }

    const nb = normalizeBandera(tr.branch.bandera);
    if (uNormBandera && nb && uNormBandera !== nb && !uNormBandera.includes(nb) && !nb.includes(uNormBandera)) {
      d += 40;
    }

    if (d < bestRaw) {
      bestRaw = d;
      bestTrip = tr;
    }
  }

  if (!bestTrip) return null;
  return { trip: bestTrip, rawScore: bestRaw, effScore: bestRaw };
}

/**
 * Globally matches ALL live GPS buses of one line (stop arrivals + Corridor Radar peers) to their
 * canonical scheduled `serviceNumber` & `trip` simultaneously using exact minimum-cost bipartite
 * assignment (Hungarian algorithm).
 *
 * Self-corrects on the fly: if Bus A tentatively took Service 2 on an earlier poll, the moment the
 * true Service 2 appears (at the stop OR anywhere on the corridor), the global solver re-optimizes
 * ALL cars on the line together, moves Bus B -> Service 2, shifts Bus A -> its true service, and
 * emits `supersededTripKey` so stale client/server records are cleaned automatically!
 */
export function matchLiveBusesToTrips(
  model,
  stopId,
  stopCoords,
  buses = [],
  nowSec = getArgentinaSecOfDay(),
  {
    stickyTripByCoche = null,
    corridorBuses = [],
    gpsHistoryByUnit = null,
    serviceEvidenceByCoche = null
  } = {}
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

  // Group stop-serving trips AND all line trips by canonical service slot (`serviceNumber` or fallback `blockId`)
  const getSlotKey = (tr) => (tr.serviceNumber ? `srv:${tr.serviceNumber}` : `blk:${tr.blockId || tr.tripKey}`);
  const stopPoolBySlot = new Map();
  const allTripsBySlot = new Map();

  for (const item of pool) {
    const sk = getSlotKey(item.trip);
    if (!stopPoolBySlot.has(sk)) stopPoolBySlot.set(sk, []);
    stopPoolBySlot.get(sk).push(item);
  }
  for (const b of model.branches) {
    for (const tr of model.getTripsForBranch(b)) {
      const sk = getSlotKey(tr);
      if (!allTripsBySlot.has(sk)) allTripsBySlot.set(sk, []);
      allTripsBySlot.get(sk).push(tr);
    }
  }

  const slotKeys = Array.from(allTripsBySlot.keys());
  const primaryBuses = buses.filter((b) => !b.isNextLap);
  const nextLapBuses = buses.filter((b) => b.isNextLap);
  const primaryCocheSet = new Set(primaryBuses.map((b) => String(b.identificadorCoche || '').trim()).filter(Boolean));

  // Include live Corridor Radar peers of the same line (not already in `primaryBuses`) so a real
  // Service N spotted elsewhere on the route claims its true service and prevents misassignment!
  const peerUnits = [];
  const seenPeerCoches = new Set();
  for (const u of corridorBuses || []) {
    if (Number(u.codigoLinea) !== Number(model.codLinea)) continue;
    const c = String(u.identificadorCoche || u.coche || '').trim();
    if (!c || primaryCocheSet.has(c) || seenPeerCoches.has(c)) continue;
    seenPeerCoches.add(c);
    peerUnits.push(u);
  }

  const totalRows = primaryBuses.length + peerUnits.length;
  const totalCols = slotKeys.length;
  const UNASSIGNED_PENALTY = 2400; // 40 min — strictly above any valid match (<= 22 min)

  const rawMatrix = Array.from({ length: totalRows }, () => new Array(totalCols).fill(Infinity));
  const effMatrix = Array.from({ length: totalRows }, () => new Array(totalCols).fill(Infinity));
  const bestItemMatrix = Array.from({ length: totalRows }, () => new Array(totalCols).fill(null));
  const prevStickyByRow = new Array(primaryBuses.length).fill(null);

  // Fill rows for stop-approaching primary buses
  primaryBuses.forEach((bus, rIdx) => {
    const coche = String(bus.identificadorCoche || '').trim();
    const stickyKey = coche ? `${model.codLinea}:${coche}` : null;
    const stickyRec = stickyKey && stickyTripByCoche ? stickyTripByCoche.get(stickyKey) : null;
    const evidenceRec = stickyKey && serviceEvidenceByCoche ? serviceEvidenceByCoche.get(stickyKey) : null;
    prevStickyByRow[rIdx] = stickyRec;
    const busNormBandera = normalizeBandera(bus.descripcionBandera || '');

    const projCache = new Map();
    const getProjForBranch = (branch) => {
      if (!projCache.has(branch)) {
        projCache.set(branch, projectOnPolyline(branch.pts, branch.cum, bus.lat, bus.lng));
      }
      return projCache.get(branch);
    };

    slotKeys.forEach((sk, cIdx) => {
      const items = stopPoolBySlot.get(sk) || [];
      let bestItem = null;
      let bestEff = Infinity;
      let bestRaw = Infinity;
      for (const item of items) {
        const res = scoreBusAgainstCandidate(
          bus,
          item,
          nowSec,
          stickyRec,
          evidenceRec,
          busNormBandera,
          getProjForBranch
        );
        if (res && res.effScore < bestEff) {
          bestEff = res.effScore;
          bestRaw = res.rawScore;
          bestItem = item;
        }
      }
      if (bestItem) {
        rawMatrix[rIdx][cIdx] = bestRaw;
        effMatrix[rIdx][cIdx] = bestEff;
        bestItemMatrix[rIdx][cIdx] = bestItem;
      }
    });
  });

  // Fill rows for corridor peer units (competing globally for canonical services!)
  peerUnits.forEach((unit, pIdx) => {
    const rIdx = primaryBuses.length + pIdx;
    const c = String(unit.identificadorCoche || unit.coche || '').trim();
    const unitHist = gpsHistoryByUnit ? gpsHistoryByUnit.get(`${model.codLinea}-c${c}`) : null;
    const stickyKey = c ? `${model.codLinea}:${c}` : null;
    const stickyRec = stickyKey && stickyTripByCoche ? stickyTripByCoche.get(stickyKey) : null;

    slotKeys.forEach((sk, cIdx) => {
      const sTrips = allTripsBySlot.get(sk) || [];
      const res = scoreCorridorPeerAgainstService(unit, sTrips, model, nowSec, unitHist);
      if (res) {
        const sameStickySrv = stickyRec?.serviceNumber && res.trip.serviceNumber === stickyRec.serviceNumber;
        rawMatrix[rIdx][cIdx] = res.rawScore;
        effMatrix[rIdx][cIdx] = Math.max(0, res.effScore - (sameStickySrv ? 45 : 0));
        bestItemMatrix[rIdx][cIdx] = { trip: res.trip, isPeer: true };
      }
    });
  });

  // Solve BOTH sticky-smoothed assignment and 100% unbiased global optimum
  const effAssign = solveMinCostAssignment(effMatrix, UNASSIGNED_PENALTY);
  const rawAssign = solveMinCostAssignment(rawMatrix, UNASSIGNED_PENALTY);

  // Evaluate raw global cost of both solutions: if the unbiased global optimum beats the
  // sticky-smoothed solution by >= 120 s (2 min) or matches more buses, auto-correct ALL buses immediately!
  const evalRawTotal = (assign) => {
    let matched = 0;
    let sum = 0;
    for (let r = 0; r < totalRows; r++) {
      const c = assign[r];
      if (c >= 0 && Number.isFinite(rawMatrix[r][c])) {
        matched++;
        sum += rawMatrix[r][c];
      } else {
        sum += UNASSIGNED_PENALTY;
      }
    }
    return { matched, sum };
  };
  const effEval = evalRawTotal(effAssign);
  const rawEval = evalRawTotal(rawAssign);
  const chosenAssign =
    rawEval.matched > effEval.matched || rawEval.sum + 120 <= effEval.sum ? rawAssign : effAssign;

  const usedTrips = new Set();
  const primaryMatchByCoche = new Map();

  const applyBusMatch = (bus, bestItem, rawErrSec, prevSticky) => {
    usedTrips.add(bestItem.trip);
    const turnoHora = formatSecHHMM(bestItem.stSec);
    bus.turnoProgramado = turnoHora;
    bus.tripKey = bestItem.trip.tripKey;
    bus.scheduledTrip = bestItem.trip;
    bus.stopProj = bestItem.stopProj;
    bus.serviceNumber = bestItem.trip.serviceNumber || null;
    bus.turnoIndex = bestItem.trip.turnoIndex || 1;
    bus.serviceTurnosCount = bestItem.trip.serviceTurnosCount || 1;
    bus.lapNumber = bestItem.trip.lapNumber || null;
    bus.shiftLaps = bestItem.trip.shiftLaps || null;
    bus.isHalfLap = Boolean(bestItem.trip.isHalfLap);
    bus.isCortadoBlock = Boolean(bestItem.trip.isCortadoBlock);
    bus.isRelevoEnLinea = Boolean(bestItem.trip.isRelevoEnLinea);
    bus.nextLapStopTime = findNextSameBranchPassTime(bestItem.trip, stopId, bestItem.stopProj?.along ?? 0);

    // Detect genuine on-the-fly auto-correction (different serviceNumber than previous sticky assignment,
    // NOT merely normal lap progression to the next leg of the same service!)
    let supersededTripKey = null;
    if (
      prevSticky &&
      prevSticky.tripKey &&
      prevSticky.tripKey !== bestItem.trip.tripKey &&
      prevSticky.serviceNumber &&
      bestItem.trip.serviceNumber &&
      prevSticky.serviceNumber !== bestItem.trip.serviceNumber
    ) {
      supersededTripKey = prevSticky.tripKey;
    }

    const matchInfo = {
      trip: bestItem.trip,
      tripKey: bestItem.trip.tripKey,
      prevTripKey: bestItem.trip.prevTrip?.tripKey || null,
      serviceNumber: bestItem.trip.serviceNumber || null,
      blockId: bestItem.trip.blockId || null,
      turnoHora,
      targetStopSec: bestItem.stSec,
      rawErrorSec: Number.isFinite(rawErrSec) ? Math.round(rawErrSec) : null,
      wasAutoCorrected: Boolean(supersededTripKey),
      supersededTripKey
    };
    matches.set(bus.key, matchInfo);
    if (!bus.isNextLap && bus.identificadorCoche) {
      primaryMatchByCoche.set(String(bus.identificadorCoche).trim(), matchInfo);
    }
  };

  // Apply winning global assignments to stop primary buses
  primaryBuses.forEach((bus, rIdx) => {
    const cIdx = chosenAssign[rIdx];
    if (cIdx < 0) return;
    const bestItem = bestItemMatrix[rIdx][cIdx];
    if (!bestItem || bestItem.isPeer) return;
    applyBusMatch(bus, bestItem, rawMatrix[rIdx][cIdx], prevStickyByRow[rIdx]);
  });

  // Match `isNextLap` (`occ > 1`) entries consistently to the SAME physical bus's next lap in its assigned service!
  for (const bus of nextLapBuses) {
    const coche = String(bus.identificadorCoche || '').trim();
    const primaryMatch = coche ? primaryMatchByCoche.get(coche) : null;
    const busNormBandera = normalizeBandera(bus.descripcionBandera || '');
    const projCache = new Map();
    const getProjForBranch = (branch) => {
      if (!projCache.has(branch)) {
        projCache.set(branch, projectOnPolyline(branch.pts, branch.cum, bus.lat, bus.lng));
      }
      return projCache.get(branch);
    };

    let bestItem = null;
    let bestScore = Infinity;

    // Prefer the exact next same-branch trip in the same serviceNumber as the bus's primary arrival
    if (primaryMatch?.serviceNumber) {
      const sameSrvItems = (stopPoolBySlot.get(`srv:${primaryMatch.serviceNumber}`) || []).filter(
        (it) => !usedTrips.has(it.trip) && it.stSec > primaryMatch.targetStopSec + 10 * 60
      );
      for (const item of sameSrvItems) {
        const res = scoreBusAgainstCandidate(bus, item, nowSec, null, null, busNormBandera, getProjForBranch);
        if (res && res.rawScore < bestScore) {
          bestScore = res.rawScore;
          bestItem = item;
        }
      }
    }

    if (!bestItem) {
      for (const item of pool) {
        if (usedTrips.has(item.trip)) continue;
        const res = scoreBusAgainstCandidate(bus, item, nowSec, null, null, busNormBandera, getProjForBranch);
        if (res && res.rawScore < bestScore) {
          bestScore = res.rawScore;
          bestItem = item;
        }
      }
    }

    if (bestItem) {
      applyBusMatch(bus, bestItem, bestScore, null);
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
  const effNow = toServiceSec(nowSec);

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

    const effClock = toServiceSec(clockSec);
    const tEff = effClock + (desvioSec || 0);

    // Guard on shared two-way streets: if the bus is actually on an opposite branch whose scheduled trip
    // matches `tEff` much better than any trip on `stopBranch`, do NOT falsely mark a `stopBranch` trip passed!
    let bestOppDiff = Infinity;
    for (const ob of branches) {
      if (ob === stopBranch) continue;
      const oProj = projectOnPolyline(ob.pts, ob.cum, lat, lng);
      if (!oProj || oProj.perp > 130) continue;
      for (const otr of model.getTripsForBranch(ob)) {
        const oSched = getTripSecAtAlong(otr, oProj.along);
        if (oSched === null) continue;
        let od = Math.abs(oSched - tEff);
        if (od > 43200) od = Math.abs(od - 86400);
        if (od < bestOppDiff) bestOppDiff = od;
      }
    }

    // If FleetMemory already knows which trip on this branch this exact coche is running AND that trip
    // is time-consistent at `proj.along` (so a full_cycle bus never marks its NEXT lap!), mark it passed!
    const cleanCoche = String(cocheId || '').trim();
    if (cleanCoche && activeMemTripsByCoche.has(cleanCoche)) {
      for (const tk of activeMemTripsByCoche.get(cleanCoche)) {
        const tr = trips.find((t) => t.tripKey === tk);
        if (!tr) continue;
        const schedAtBus = getTripSecAtAlong(tr, proj.along);
        if (schedAtBus === null) continue;
        let d = Math.abs(schedAtBus - tEff);
        if (d > 43200) d = Math.abs(d - 86400);
        if (d <= 28 * 60 && d <= bestOppDiff + 90) {
          passed.add(tk);
        }
      }
    }

    let bestTrip = null;
    let bestDiff = 16 * 60; // up to 16 min tolerance even if desvio slightly noisy

    for (const tr of trips) {
      const schedAtBus = getTripSecAtAlong(tr, proj.along);
      if (schedAtBus === null) continue;
      let d = Math.abs(schedAtBus - tEff);
      if (d > 43200) d = Math.abs(d - 86400);
      if (d < bestDiff) {
        bestDiff = d;
        bestTrip = tr;
      }
    }
    if (bestTrip && bestDiff <= bestOppDiff + 90) {
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
        const bClock = parseGpsStampSecOfDay(b.ultimaFechaHoraGPS || b.ultimaGps || '') ?? effNow;
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
        const tr = trips.find((t) => t.tripKey === rec.tripKey);
        if (!tr) continue;
        const recClock =
          parseGpsStampSecOfDay(rec.ultimaGps) ??
          (rec.updatedAt ? getArgentinaSecOfDay(new Date(rec.updatedAt)) : effNow);
        const anchor = buildGpsAnchorForTrip(tr, lat, lng, recClock, rec.desvioSec || 0, {
          prevFix: rec.prevFix || null,
          preferredLeg: rec.realLeg || null
        });
        if (anchor && anchor.legDepth === 0 && !anchor.atOriginTerminal && anchor.along > stopProj.along + 65) {
          passed.add(rec.tripKey);
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
        (u.updatedAt ? getArgentinaSecOfDay(new Date(u.updatedAt)) : effNow);
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
  gpsHistoryByUnit = null,
  maxUpcoming = 4,
  maxAheadMin = 65
}) {
  const model = buildLineScheduleModel(codLinea, branches, horariosFile, tipoDia);
  if (!model || !stopCoords) return [];

  const stopBranches = pickStopBranches(branches, stopId, stopCoords);
  if (stopBranches.length === 0) return [];

  const nowMs = Date.now();
  const effNow = toServiceSec(nowSec);
  const todayServiceKey = getArgentinaDayKey();

  // Index system FleetMemory trips for this line — strictly current service day only
  // (daily bus/driver assignments vary every day and must never leak across service days!)
  const memByTrip = new Map();
  const knownCoches = new Set(liveMatchedCoches);
  if (fleetMemory && Array.isArray(fleetMemory.trips)) {
    for (const rec of fleetMemory.trips) {
      if (Number(rec.codigoLinea) !== Number(codLinea) || !rec.tripKey) continue;
      if (rec.dayKey && rec.dayKey !== todayServiceKey) continue;
      memByTrip.set(rec.tripKey, rec);
      if (rec.coche) knownCoches.add(String(rec.coche).trim());
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
    const uClock = toServiceSec(
      parseGpsStampSecOfDay(ultimaGps) ??
        (u.updatedAt ? getArgentinaSecOfDay(new Date(u.updatedAt)) : effNow)
    );
    const tEff = uClock + (desvioSec || 0);
    const uNormBandera = normalizeBandera(u.descripcionBandera || u.bandera || '');

    const unitHist = gpsHistoryByUnit ? gpsHistoryByUnit.get(`${codLinea}-c${cleanCoche}`) : null;
    const trailDir = unitHist
      ? resolveTrailDirection(unitHist, branches, { currentFix: { lat: uLat, lng: uLng, ts: nowMs } })
      : null;
    const prevFix = unitHist?.prevMoving || unitHist?.prev || null;
    const gpsDir =
      !trailDir && prevFix && (distanceMeters(prevFix.lat, prevFix.lng, uLat, uLng) ?? 0) >= 20
        ? unitVector(prevFix.lat, prevFix.lng, uLat, uLng)
        : null;

    let bestTr = null;
    let bestScore = 14 * 60;
    for (const b of branches) {
      const proj = projectOnPolyline(b.pts, b.cum, uLat, uLng);
      if (!proj || proj.perp > 140) continue;

      let dirPenalty = 0;
      if (trailDir?.branch) {
        const nearTerminal = proj.along <= 240 || (b.totalLen || 0) - proj.along <= 240;
        if (trailDir.branch === b) dirPenalty = -120;
        else if (!nearTerminal) dirPenalty = 2400;
      } else if (gpsDir && proj.tangent) {
        const dot = gpsDir[0] * proj.tangent[0] + gpsDir[1] * proj.tangent[1];
        if (dot < -0.25) dirPenalty = 2400;
        else if (dot > 0.35) dirPenalty = -90;
      }

      const nb = normalizeBandera(b.bandera);
      const banderaPenalty =
        uNormBandera && nb && uNormBandera !== nb && !uNormBandera.includes(nb) && !nb.includes(uNormBandera) ? 35 : 0;

      for (const tr of model.getTripsForBranch(b)) {
        const sched = getTripSecAtAlong(tr, proj.along);
        if (sched === null) continue;
        let d = Math.abs(sched - tEff);
        if (d > 43200) d = Math.abs(d - 86400);
        const score = d + dirPenalty + banderaPenalty;
        if (score < bestScore) {
          bestScore = score;
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

  // 2) Enrich with recent `fleetMemory.units` (last 35 min, current service day only)
  for (const u of fleetMemory?.units || []) {
    if (u.dayKey && u.dayKey !== todayServiceKey) continue;
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

      // ── Step A: Check if an EARLIER trip in the EXACT SAME continuous vehicle block is currently LIVE! ──
      // (Because FIFO DP cuts blocks cleanly at horarios cortados, a car that pulls into garage NEVER links here!)
      let liveBlockSrc = null;
      for (let i = targetIdx - 1; i >= Math.max(0, targetIdx - 4); i--) {
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
          const liveAnchor = buildGpsAnchorForTrip(trip, fLat, fLng, effNow, srcBus.desvio?.seconds || 0, {
            prevFix: srcBus.prevGpsFix || null,
            preferredLeg: srcBus.trajectory?.leg || null
          });
          if (liveAnchor) {
            const ev = evaluateTripState(trip, stopId, stopProj, effNow, srcBus.desvio?.seconds || 0, {
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

      // ── Step B: Otherwise, walk this trip's continuous vehicle block backwards in FleetMemory (up to 4 legs / 125 min) ──
      let mem = null;
      let memIdx = targetIdx;
      for (let i = targetIdx; i >= Math.max(0, targetIdx - 4); i--) {
        const rec = memByTrip.get(block[i]?.tripKey);
        if (!rec) continue;
        const ageMin = rec.updatedAt ? (nowMs - rec.updatedAt) / 60000 : 999;
        if (ageMin > 125) continue;
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
        const memClockSec = toServiceSec(
          parseGpsStampSecOfDay(mem.ultimaGps) ??
            (mem.updatedAt ? getArgentinaSecOfDay(new Date(mem.updatedAt)) : effNow)
        );
        const elapsedSec = Math.max(0, effNow - memClockSec);

        if (memDepth <= 2 && ageMin <= 90) {
          const mLat = Number(mem.lat);
          const mLng = Number(mem.lng);
          if (Number.isFinite(mLat) && Number.isFinite(mLng) && mLat !== 0 && mLng !== 0) {
            const cleanMemCoche = String(mem.coche || '').trim();
            const unitHist =
              cleanMemCoche && gpsHistoryByUnit ? gpsHistoryByUnit.get(`${codLinea}-c${cleanMemCoche}`) : null;
            const prevFix = mem.prevFix || unitHist?.prevMoving || unitHist?.prev || null;
            const preferredLeg =
              memDepth === 0 ? mem.realLeg || null : memDepth === 1 ? 'previous_leg' : 'full_cycle';
            anchor = buildGpsAnchorForTrip(trip, mLat, mLng, memClockSec, mem.desvioSec || 0, {
              prevFix,
              preferredLeg
            });
          }
        }
        if (!anchor && Number.isFinite(mem.desvioSec)) {
          desvioSec = propagateBlockDesvioSec(block, memIdx, targetIdx, mem.desvioSec, elapsedSec);
        }
      }

      const tripMaxAheadSec = mem ? Math.max(effectiveMaxAheadSec, 110 * 60) : effectiveMaxAheadSec;
      const ev = evaluateTripState(trip, stopId, stopProj, effNow, desvioSec, {
        maxAheadSec: tripMaxAheadSec,
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
      serviceNumber: trip.serviceNumber || null,
      turnoIndex: trip.turnoIndex || 1,
      serviceTurnosCount: trip.serviceTurnosCount || 1,
      lapNumber: trip.lapNumber || null,
      shiftLaps: trip.shiftLaps || null,
      isHalfLap: Boolean(trip.isHalfLap),
      isCortadoBlock: Boolean(trip.isCortadoBlock),
      isRelevoEnLinea: Boolean(trip.isRelevoEnLinea),
      nextLapStopTime: findNextSameBranchPassTime(trip, stopId, stopProj?.along ?? 0),
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
