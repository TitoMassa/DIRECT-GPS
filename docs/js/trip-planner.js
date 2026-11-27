import { distanceMeters } from './api.js';

const WALK_SPEED_MPS = 1.25; // ~4.5 km/h caminata urbana
const BUS_AVG_SPEED_MPS = 5.4; // ~19.4 km/h velocidad comercial urbana
const MAX_ORIGIN_WALK_M = 650;
const MAX_DEST_WALK_M = 650;
const MAX_TRANSFER_WALK_M = 400;
const TRANSFER_PENALTY_MIN = 8;

/**
 * Indexa todos los ramales con sus paradas ordenadas y distancias acumuladas para
 * consultas rápidas 100 % offline de "¿Cómo llego?".
 *
 * @param {Map<number, Array>} routeBranchesByLine - Map(codLinea -> parsedBranches)
 * @param {Map<number, {codigo:number, descripcion:string}>} lineByCode
 */
export function buildTripPlannerIndex(routeBranchesByLine, lineByCode) {
  const legs = []; // { codLinea, lineName, branchIdx, bandera, git, stops: [{ id, nombre, lat, lng, along }] }
  const stopsIndex = new Map(); // stopId -> [{ legIdx, stopIdx, stop }]

  for (const [cod, branches] of routeBranchesByLine.entries()) {
    if (!Array.isArray(branches) || branches.length === 0) continue;
    const lineName = lineByCode?.get(Number(cod))?.descripcion || `L${cod}`;
    branches.forEach((br, branchIdx) => {
      const ordered = Array.isArray(br.orderedStops) ? br.orderedStops : [];
      if (ordered.length < 2) return;
      const legIdx = legs.length;
      const cleanStops = ordered.map((s) => ({
        id: String(s.id || '').toUpperCase(),
        nombre: s.nombre || s.descripcion || s.id,
        lat: Number(s.lat),
        lng: Number(s.lng),
        along: Number(s.along) || 0
      }));
      legs.push({
        codLinea: Number(cod),
        lineName,
        branchIdx,
        bandera: br.bandera || lineName,
        git: br.git || '',
        stops: cleanStops
      });
      cleanStops.forEach((st, stopIdx) => {
        if (!st.id || Number.isNaN(st.lat) || Number.isNaN(st.lng)) return;
        if (!stopsIndex.has(st.id)) stopsIndex.set(st.id, []);
        stopsIndex.get(st.id).push({ legIdx, stopIdx, stop: st });
      });
    });
  }

  return { legs, stopsIndex };
}

function findNearestStopOnLeg(leg, lat, lng, maxDistM) {
  let best = null;
  for (let i = 0; i < leg.stops.length; i++) {
    const s = leg.stops[i];
    const d = distanceMeters(lat, lng, s.lat, s.lng);
    if (d !== null && d <= maxDistM && (!best || d < best.dist)) {
      best = { stopIdx: i, stop: s, dist: d };
    }
  }
  return best;
}

/**
 * Calcula opciones de viaje (directas y con 1 trasbordo caminando <= 400 m) entre
 * un punto de origen y un punto de destino usando únicamente datos locales.
 *
 * @param {object} index - Resultado de `buildTripPlannerIndex`
 * @param {{ lat:number, lng:number, label?:string, stopId?:string }} origin
 * @param {{ lat:number, lng:number, label?:string, stopId?:string }} dest
 * @param {{ maxResults?:number, liveEtaByLineStop?:Map<string, number> }} options
 */
export function planTripsOffline(index, origin, dest, { maxResults = 8, liveEtaByLineStop = null } = {}) {
  if (!index || !origin || !dest) return [];
  if (!Number.isFinite(origin.lat) || !Number.isFinite(origin.lng)) return [];
  if (!Number.isFinite(dest.lat) || !Number.isFinite(dest.lng)) return [];

  const totalStraightM = distanceMeters(origin.lat, origin.lng, dest.lat, dest.lng) || 0;
  if (totalStraightM < 120) return [];

  const directBestByLine = new Map();
  const originLegs = []; // legs reachable from origin
  const destLegs = []; // legs reaching destination

  for (let legIdx = 0; legIdx < index.legs.length; legIdx++) {
    const leg = index.legs[legIdx];
    const nearOrig = findNearestStopOnLeg(leg, origin.lat, origin.lng, MAX_ORIGIN_WALK_M);
    const nearDest = findNearestStopOnLeg(leg, dest.lat, dest.lng, MAX_DEST_WALK_M);

    if (nearOrig) originLegs.push({ legIdx, leg, ...nearOrig });
    if (nearDest) destLegs.push({ legIdx, leg, ...nearDest });

    // Direct trip on this branch (must travel forward along the branch!)
    if (nearOrig && nearDest && nearDest.stopIdx > nearOrig.stopIdx) {
      const rideMeters = Math.max(150, nearDest.stop.along - nearOrig.stop.along);
      const stopsCount = nearDest.stopIdx - nearOrig.stopIdx;
      const walkOrigM = Math.round(nearOrig.dist);
      const walkDestM = Math.round(nearDest.dist);
      const walkMin = Math.round((walkOrigM + walkDestM) / WALK_SPEED_MPS / 60);
      const rideMin = Math.max(2, Math.round(rideMeters / BUS_AVG_SPEED_MPS / 60));
      const liveEtaKey = `${leg.codLinea}:${nearOrig.stop.id}`;
      const liveWaitMin = liveEtaByLineStop?.has(liveEtaKey) ? liveEtaByLineStop.get(liveEtaKey) : null;
      const totalMin = walkMin + rideMin + (typeof liveWaitMin === 'number' ? liveWaitMin : 6);
      const score = totalMin * 60 + (walkOrigM + walkDestM) * 0.45;

      const cand = {
        type: 'direct',
        transfers: 0,
        score,
        totalMin,
        walkTotalM: walkOrigM + walkDestM,
        walkOriginM: walkOrigM,
        walkDestM: walkDestM,
        liveWaitMin,
        legs: [
          {
            codLinea: leg.codLinea,
            lineName: leg.lineName,
            bandera: leg.bandera,
            branchIdx: leg.branchIdx,
            boardStop: nearOrig.stop,
            alightStop: nearDest.stop,
            boardStopIdx: nearOrig.stopIdx,
            alightStopIdx: nearDest.stopIdx,
            stopsCount,
            rideMeters: Math.round(rideMeters),
            rideMin,
            liveWaitMin
          }
        ]
      };

      const prev = directBestByLine.get(leg.codLinea);
      if (!prev || cand.score < prev.score) {
        directBestByLine.set(leg.codLinea, cand);
      }
    }
  }

  const directResults = Array.from(directBestByLine.values()).sort((a, b) => a.score - b.score);

  // 1-Transfer routes (only computed if direct options are few or require long walks)
  const transferBestByPair = new Map();
  const needTransfers = directResults.length < 4 || directResults[0].walkTotalM > 380;

  if (needTransfers && originLegs.length > 0 && destLegs.length > 0) {
    // Keep up to top 16 closest origin legs & top 16 closest dest legs for < 8 ms mobile execution
    originLegs.sort((a, b) => a.dist - b.dist);
    destLegs.sort((a, b) => a.dist - b.dist);
    const oSlice = originLegs.slice(0, 18);
    const dSlice = destLegs.slice(0, 18);

    for (const o of oSlice) {
      for (const d of dSlice) {
        if (o.leg.codLinea === d.leg.codLinea) continue; // Same line doesn't need transfer
        const pairKey = `${o.leg.codLinea}->${d.leg.codLinea}`;
        if (directBestByLine.has(o.leg.codLinea) && directBestByLine.has(d.leg.codLinea)) continue;

        // Find best transfer point where leg1 stop (after o.stopIdx) is <= 400 m from leg2 stop (before d.stopIdx)
        let bestXfer = null;
        const oStops = o.leg.stops;
        const dStops = d.leg.stops;

        for (let i = o.stopIdx + 1; i < oStops.length; i++) {
          const s1 = oStops[i];
          for (let j = 0; j < d.stopIdx; j++) {
            const s2 = dStops[j];
            // Quick lat/lng bounding box prefilter (~450 m)
            if (Math.abs(s1.lat - s2.lat) > 0.0042 || Math.abs(s1.lng - s2.lng) > 0.0048) continue;
            const xDist = distanceMeters(s1.lat, s1.lng, s2.lat, s2.lng);
            if (xDist === null || xDist > MAX_TRANSFER_WALK_M) continue;
            const r1 = Math.max(150, s1.along - o.stop.along);
            const r2 = Math.max(150, d.stop.along - s2.along);
            const xCost = xDist * 2.5 + (r1 + r2) * 0.22;
            if (!bestXfer || xCost < bestXfer.xCost) {
              bestXfer = { i, j, s1, s2, xDist: Math.round(xDist), r1, r2, xCost };
            }
          }
        }

        if (!bestXfer) continue;
        const walkOrigM = Math.round(o.dist);
        const walkDestM = Math.round(d.dist);
        const walkTotalM = walkOrigM + bestXfer.xDist + walkDestM;
        const ride1Min = Math.max(2, Math.round(bestXfer.r1 / BUS_AVG_SPEED_MPS / 60));
        const ride2Min = Math.max(2, Math.round(bestXfer.r2 / BUS_AVG_SPEED_MPS / 60));
        const walkMin = Math.round(walkTotalM / WALK_SPEED_MPS / 60);
        const liveWait1 = liveEtaByLineStop?.has(`${o.leg.codLinea}:${o.stop.id}`)
          ? liveEtaByLineStop.get(`${o.leg.codLinea}:${o.stop.id}`)
          : null;
        const totalMin = walkMin + ride1Min + ride2Min + TRANSFER_PENALTY_MIN + (typeof liveWait1 === 'number' ? liveWait1 : 6);
        const score = totalMin * 60 + walkTotalM * 0.55 + 240;

        const cand = {
          type: 'transfer',
          transfers: 1,
          score,
          totalMin,
          walkTotalM,
          walkOriginM: walkOrigM,
          walkTransferM: bestXfer.xDist,
          walkDestM: walkDestM,
          liveWaitMin: liveWait1,
          legs: [
            {
              codLinea: o.leg.codLinea,
              lineName: o.leg.lineName,
              bandera: o.leg.bandera,
              branchIdx: o.leg.branchIdx,
              boardStop: o.stop,
              alightStop: bestXfer.s1,
              boardStopIdx: o.stopIdx,
              alightStopIdx: bestXfer.i,
              stopsCount: bestXfer.i - o.stopIdx,
              rideMeters: Math.round(bestXfer.r1),
              rideMin: ride1Min,
              liveWaitMin: liveWait1
            },
            {
              codLinea: d.leg.codLinea,
              lineName: d.leg.lineName,
              bandera: d.leg.bandera,
              branchIdx: d.leg.branchIdx,
              boardStop: bestXfer.s2,
              alightStop: d.stop,
              boardStopIdx: bestXfer.j,
              alightStopIdx: d.stopIdx,
              stopsCount: d.stopIdx - bestXfer.j,
              rideMeters: Math.round(bestXfer.r2),
              rideMin: ride2Min,
              liveWaitMin: null
            }
          ]
        };

        const prev = transferBestByPair.get(pairKey);
        if (!prev || cand.score < prev.score) {
          transferBestByPair.set(pairKey, cand);
        }
      }
    }
  }

  const transferResults = Array.from(transferBestByPair.values())
    .sort((a, b) => a.score - b.score)
    .slice(0, 4);

  return [...directResults, ...transferResults]
    .sort((a, b) => a.score - b.score)
    .slice(0, maxResults);
}
