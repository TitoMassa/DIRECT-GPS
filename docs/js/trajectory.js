import { distanceMeters } from './api.js';

function buildCumDist(pts) {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) {
    const d = distanceMeters(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]) || 0;
    cum.push(cum[i - 1] + d);
  }
  return cum;
}

function unitVector(lat1, lng1, lat2, lng2) {
  const cosLat = Math.cos(((lat1 + lat2) * 0.5 * Math.PI) / 180);
  const dx = (lng2 - lng1) * cosLat;
  const dy = lat2 - lat1;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return null;
  return [dx / len, dy / len];
}

function projectOnPolyline(pts, cum, lat, lng) {
  let best = {
    segIdx: 0,
    t: 0,
    lat: pts[0][0],
    lng: pts[0][1],
    along: 0,
    perp: Infinity,
    tangent: null
  };

  for (let i = 0; i < pts.length - 1; i++) {
    const aLat = pts[i][0];
    const aLng = pts[i][1];
    const bLat = pts[i + 1][0];
    const bLng = pts[i + 1][1];
    const dx = bLat - aLat;
    const dy = bLng - aLng;
    const lenSq = dx * dx + dy * dy;
    const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((lat - aLat) * dx + (lng - aLng) * dy) / lenSq));
    const pLat = aLat + dx * t;
    const pLng = aLng + dy * t;
    const perp = distanceMeters(lat, lng, pLat, pLng);
    if (perp !== null && perp < best.perp) {
      const segLen = (cum[i + 1] || 0) - (cum[i] || 0);
      best = {
        segIdx: i,
        t,
        lat: pLat,
        lng: pLng,
        along: (cum[i] || 0) + segLen * t,
        perp,
        tangent: unitVector(aLat, aLng, bLat, bLng)
      };
    }
  }
  return best;
}

function slicePolyline(pts, startProj, endProj) {
  const out = [[startProj.lat, startProj.lng]];
  const startIdx = startProj.segIdx + 1;
  const endIdx = endProj ? endProj.segIdx : pts.length - 1;

  for (let i = startIdx; i <= endIdx && i < pts.length; i++) {
    out.push(pts[i]);
  }
  if (endProj) {
    out.push([endProj.lat, endProj.lng]);
  }
  return out;
}

export function parseRouteBranches(recorridos = []) {
  return (recorridos || [])
    .map((r) => {
      const pts = (r.puntos || [])
        .map((p) => [parseFloat(p.latitud), parseFloat(p.longitud)])
        .filter(([la, ln]) => !Number.isNaN(la) && !Number.isNaN(ln));
      if (pts.length < 2) return null;
      const cum = buildCumDist(pts);
      const stopIds = new Set(
        (r.paradas || []).map((s) => String(s.identificador || '').trim().toUpperCase()).filter(Boolean)
      );
      return {
        bandera: String(r.abreviaturaBanderaSMP || r.descripcion || '').trim(),
        git: String(r.abreviaturaGit || '').trim(),
        pts,
        cum,
        totalLen: cum[cum.length - 1] || 0,
        stopIds
      };
    })
    .filter(Boolean);
}

function pickStopBranch(branches, stopId, stopCoords, stopBandera = '') {
  if (!branches || branches.length === 0) return null;

  const cleanId = String(stopId || '').trim().toUpperCase();
  let stopBranch = branches.find((b) => b.stopIds.has(cleanId)) || null;

  if (!stopBranch && stopBandera) {
    const target = stopBandera.toUpperCase();
    stopBranch =
      branches.find((b) => b.bandera.toUpperCase().includes(target) || target.includes(b.bandera.toUpperCase())) ||
      null;
  }

  if (!stopBranch && stopCoords) {
    let bestD = Infinity;
    for (const b of branches) {
      const p = projectOnPolyline(b.pts, b.cum, stopCoords.lat, stopCoords.lng);
      if (p.perp < bestD) {
        bestD = p.perp;
        stopBranch = b;
      }
    }
  }

  return stopBranch;
}

function pickBestOppositeBranch(branches, stopBranch, busLat, busLng) {
  const candidates = branches.filter((b) => b !== stopBranch && b.pts.length >= 6);
  if (candidates.length === 0) return { oppositeBranch: null, busOnOpp: null };

  let bestBranch = null;
  let bestProj = null;
  for (const b of candidates) {
    const proj = projectOnPolyline(b.pts, b.cum, busLat, busLng);
    if (!bestProj || proj.perp < bestProj.perp) {
      bestBranch = b;
      bestProj = proj;
    }
  }
  return { oppositeBranch: bestBranch, busOnOpp: bestProj };
}

/**
 * Resolves the true direction & cycle of a live bus:
 *  - 'direct': on stopBranch approaching the stop directly
 *  - 'previous_leg': on oppositeBranch heading to turnaround terminal before stopBranch
 *  - 'full_cycle': on stopBranch AFTER the stop (already passed it) -> far terminal -> full oppositeBranch -> turnaround -> stop
 * Computes exact remaining routeMeters along the real street polylines for all 3 cases.
 */
export function resolveBusTrajectory(bus, stopId, stopCoords, branches = [], prevFix = null) {
  if (!stopCoords || typeof bus.lat !== 'number' || typeof bus.lng !== 'number') {
    return null;
  }

  const etaMin = bus.eta?.minutes ?? 10;
  const etaSec = etaMin <= 0 ? 45 : etaMin * 60;
  const stopBranch = pickStopBranch(branches, stopId, stopCoords, bus.descripcionBandera);

  if (!stopBranch) {
    // Fallback straight path if line polylines haven't loaded yet
    const directPts = [
      [bus.lat, bus.lng],
      [stopCoords.lat, stopCoords.lng]
    ];
    const cum = buildCumDist(directPts);
    const total = cum[cum.length - 1] || 0;
    return {
      leg: 'direct',
      isOppositeLeg: false,
      isNextCycle: false,
      realBandera: bus.descripcionBandera,
      turnaroundAtMeters: 0,
      oppStartMeters: 0,
      pathPts: directPts,
      pathCum: cum,
      totalMeters: total,
      walkedMeters: 0,
      speedMps: Math.max(3.2, Math.min(13.5, total / etaSec))
    };
  }

  const stopProj = projectOnPolyline(stopBranch.pts, stopBranch.cum, stopCoords.lat, stopCoords.lng);
  const busOnStop = projectOnPolyline(stopBranch.pts, stopBranch.cum, bus.lat, bus.lng);
  const { oppositeBranch, busOnOpp } = pickBestOppositeBranch(branches, stopBranch, bus.lat, bus.lng);

  // Hypothesis 1: bus is already on stopBranch BEFORE stop, heading directly toward stop
  const directDist =
    busOnStop.along <= stopProj.along + 45 ? Math.max(0, stopProj.along - busOnStop.along) : Infinity;

  // Hypothesis 2: bus is finishing oppositeBranch -> turnaround -> start of stopBranch -> stop
  let loopDist = Infinity;
  let turnGapOppToStop = 0;
  if (oppositeBranch && busOnOpp) {
    const oppEnd = oppositeBranch.pts[oppositeBranch.pts.length - 1];
    const stopStart = stopBranch.pts[0];
    turnGapOppToStop = distanceMeters(oppEnd[0], oppEnd[1], stopStart[0], stopStart[1]) || 0;
    loopDist = Math.max(0, oppositeBranch.totalLen - busOnOpp.along) + turnGapOppToStop + stopProj.along;
  }

  // Hypothesis 3: bus is on stopBranch AFTER the stop (or just passing it) -> far terminal -> full oppositeBranch -> turnaround -> stop
  let fullCycleDist = Infinity;
  let turnGapStopToOpp = 0;
  if (oppositeBranch && busOnStop) {
    const stopEnd = stopBranch.pts[stopBranch.pts.length - 1];
    const oppStart = oppositeBranch.pts[0];
    turnGapStopToOpp = distanceMeters(stopEnd[0], stopEnd[1], oppStart[0], oppStart[1]) || 0;
    fullCycleDist =
      Math.max(0, stopBranch.totalLen - busOnStop.along) +
      turnGapStopToOpp +
      oppositeBranch.totalLen +
      turnGapOppToStop +
      stopProj.along;
  }

  // Realistic urban Corrientes commercial speed estimates (including stops + terminal layovers)
  const estDirectMin = directDist < Infinity ? directDist / 230 : Infinity;
  const estOppMin = loopDist < Infinity ? loopDist / 210 + 3 : Infinity;
  const estCycleMin = fullCycleDist < Infinity ? fullCycleDist / 210 + 6 : Infinity;

  // Signal 1: Real observed GPS heading vector between consecutive polls for this exact bus unit
  let headingDir = null; // 'stop' | 'opp' | null
  if (prevFix && typeof prevFix.lat === 'number' && typeof prevFix.lng === 'number') {
    const moved = distanceMeters(prevFix.lat, prevFix.lng, bus.lat, bus.lng) || 0;
    if (moved >= 25) {
      const gpsDir = unitVector(prevFix.lat, prevFix.lng, bus.lat, bus.lng);
      if (gpsDir && busOnStop.tangent) {
        const dotStop = gpsDir[0] * busOnStop.tangent[0] + gpsDir[1] * busOnStop.tangent[1];
        const dotOpp =
          busOnOpp && busOnOpp.tangent
            ? gpsDir[0] * busOnOpp.tangent[0] + gpsDir[1] * busOnOpp.tangent[1]
            : -1;

        if (oppositeBranch && dotOpp > 0.35 && dotOpp > dotStop + 0.3) {
          headingDir = 'opp';
        } else if (dotStop > 0.35 && dotStop > dotOpp + 0.3) {
          headingDir = 'stop';
        }
      }
    }
  }

  // Helper: pick between previous_leg and full_cycle using ETA consistency (+ lane proximity near turnaround)
  const pickIndirectLeg = () => {
    if (fullCycleDist === Infinity) return 'previous_leg';
    if (loopDist === Infinity) return 'full_cycle';

    const oppErr = Math.abs(estOppMin - etaMin);
    const cycleErr = Math.abs(estCycleMin - etaMin);

    // If bus is right at the far terminal where both distances are nearly identical (< 1.5 km apart),
    // prefer previous_leg so it isn't flagged as "next cycle" right after turning around.
    if (Math.abs(fullCycleDist - loopDist) < 1500) {
      return oppErr <= cycleErr + 6 ? 'previous_leg' : 'full_cycle';
    }

    // Prefer full_cycle when ETA clearly fits the full round-trip much better than oppositeBranch alone
    if (cycleErr + 4 < oppErr) return 'full_cycle';
    if (oppErr + 4 < cycleErr) return 'previous_leg';

    // Tie-breaker: physical lane proximity
    if (busOnStop.perp + 15 < busOnOpp.perp) return 'full_cycle';
    return 'previous_leg';
  };

  // Signal 2: Combine GPS heading + ETA vs Route Distance Consistency across all 3 hypotheses
  let leg = 'direct';
  const hasOpposite = Boolean(oppositeBranch && busOnOpp && busOnOpp.perp < 650);

  if (headingDir === 'opp' && hasOpposite) {
    leg = 'previous_leg';
  } else if (headingDir === 'stop') {
    if (directDist === Infinity) {
      leg = hasOpposite ? 'full_cycle' : 'direct';
    } else if (hasOpposite && etaMin >= 25 && Math.abs(estCycleMin - etaMin) + 12 < Math.abs(estDirectMin - etaMin)) {
      // Bus is on stopBranch lane, moving in stopBranch direction, just barely before/at stop yet ETA is ~1 full loop
      leg = 'full_cycle';
    } else {
      leg = 'direct';
    }
  } else if (hasOpposite) {
    if (directDist === Infinity) {
      leg = pickIndirectLeg();
    } else {
      const bestIndirect = pickIndirectLeg();
      const bestIndirectEst = bestIndirect === 'full_cycle' ? estCycleMin : estOppMin;

      // Case A: Bus is way too close on stopBranch for the reported ETA (e.g., 150m away yet 30 min or 115 min ETA)
      const directImplausiblySlow = etaMin >= 7 && directDist < etaMin * 105;
      const indirectMatchesBetter = Math.abs(bestIndirectEst - etaMin) + 3 < Math.abs(estDirectMin - etaMin);

      // Case B: Bus is physically closer to oppositeBranch lane AND ETA is far longer than direct distance
      const physicallyOnOppLane =
        bestIndirect === 'previous_leg' && busOnOpp.perp + 18 < busOnStop.perp && etaMin >= 6 && directDist < 1400;

      if ((directImplausiblySlow && indirectMatchesBetter) || physicallyOnOppLane) {
        leg = bestIndirect;
      }
    }
  }

  let pathPts;
  let realBandera;
  let totalMeters;

  if (leg === 'full_cycle' && oppositeBranch && busOnStop) {
    const stopRemainder = slicePolyline(stopBranch.pts, busOnStop, null);
    const oppFull = oppositeBranch.pts.slice();
    const stopStartProj = { segIdx: 0, t: 0, lat: stopBranch.pts[0][0], lng: stopBranch.pts[0][1] };
    const stopApproach = slicePolyline(stopBranch.pts, stopStartProj, stopProj);

    pathPts = [...stopRemainder, ...oppFull, ...stopApproach];
    realBandera = stopBranch.bandera || bus.descripcionBandera;

    const cum = buildCumDist(pathPts);
    totalMeters = cum[cum.length - 1] || 0;
    const oppStartMeters = buildCumDist(stopRemainder).slice(-1)[0] || 0;
    const turnaroundAtMeters = buildCumDist([...stopRemainder, ...oppFull]).slice(-1)[0] || 0;

    return {
      leg: 'full_cycle',
      isOppositeLeg: false,
      isNextCycle: true,
      realBandera,
      oppStartMeters,
      turnaroundAtMeters,
      pathPts,
      pathCum: cum,
      totalMeters,
      walkedMeters: 0,
      speedMps: Math.max(3.2, Math.min(13.5, totalMeters / etaSec))
    };
  }

  if (leg === 'previous_leg' && oppositeBranch && busOnOpp) {
    const oppRemainder = slicePolyline(oppositeBranch.pts, busOnOpp, null);
    const stopStartProj = { segIdx: 0, t: 0, lat: stopBranch.pts[0][0], lng: stopBranch.pts[0][1] };
    const stopApproach = slicePolyline(stopBranch.pts, stopStartProj, stopProj);
    pathPts = [...oppRemainder, ...stopApproach];
    realBandera = oppositeBranch.bandera || 'Sentido opuesto';
    const cum = buildCumDist(pathPts);
    totalMeters = cum[cum.length - 1] || 0;
    return {
      leg: 'previous_leg',
      isOppositeLeg: true,
      isNextCycle: false,
      realBandera,
      oppStartMeters: 0,
      turnaroundAtMeters: buildCumDist(oppRemainder).slice(-1)[0] || 0,
      pathPts,
      pathCum: cum,
      totalMeters,
      walkedMeters: 0,
      speedMps: Math.max(3.2, Math.min(13.5, totalMeters / etaSec))
    };
  }

  // Direct approach along stopBranch
  if (directDist < Infinity) {
    pathPts = slicePolyline(stopBranch.pts, busOnStop, stopProj);
  } else {
    pathPts = [
      [bus.lat, bus.lng],
      [stopCoords.lat, stopCoords.lng]
    ];
  }
  const cum = buildCumDist(pathPts);
  totalMeters = cum[cum.length - 1] || 0;
  return {
    leg: 'direct',
    isOppositeLeg: false,
    isNextCycle: false,
    realBandera: stopBranch.bandera || bus.descripcionBandera,
    oppStartMeters: 0,
    turnaroundAtMeters: 0,
    pathPts,
    pathCum: cum,
    totalMeters,
    walkedMeters: 0,
    speedMps: Math.max(3.2, Math.min(13.5, totalMeters / etaSec))
  };
}

export function sampleTrajectory(traj, walkedMeters) {
  const { pathPts, pathCum, totalMeters } = traj;
  if (!pathPts || pathPts.length === 0) return null;
  if (walkedMeters >= totalMeters || pathPts.length === 1) {
    const last = pathPts[pathPts.length - 1];
    return { lat: last[0], lng: last[1], remainingMeters: 0, arrived: true, inOppositeLeg: false, inNextCycle: false };
  }

  const clamped = Math.max(0, walkedMeters);
  let i = 0;
  while (i < pathCum.length - 2 && pathCum[i + 1] < clamped) {
    i++;
  }
  const segStart = pathCum[i];
  const segLen = Math.max(0.001, pathCum[i + 1] - segStart);
  const frac = Math.max(0, Math.min(1, (clamped - segStart) / segLen));
  const lat = pathPts[i][0] + (pathPts[i + 1][0] - pathPts[i][0]) * frac;
  const lng = pathPts[i][1] + (pathPts[i + 1][1] - pathPts[i][1]) * frac;

  let inOppositeLeg = false;
  let inNextCycle = false;
  if (traj.leg === 'full_cycle') {
    if (clamped < traj.oppStartMeters) {
      inNextCycle = true;
    } else if (clamped < traj.turnaroundAtMeters) {
      inOppositeLeg = true;
    }
  } else if (traj.isOppositeLeg) {
    inOppositeLeg = clamped < traj.turnaroundAtMeters;
  }

  return {
    lat,
    lng,
    remainingMeters: Math.max(0, totalMeters - clamped),
    arrived: false,
    inOppositeLeg,
    inNextCycle
  };
}
