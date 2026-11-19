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
 * Resolves the true direction (current stop leg vs previous opposite leg toward turnaround terminal)
 * and builds a continuous, zero-overhead interpolation path for a real SOAP bus.
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
      realBandera: bus.descripcionBandera,
      turnaroundAtMeters: 0,
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

  // Hypothesis 1: bus is already on stopBranch heading toward stop
  const directDist =
    busOnStop.along <= stopProj.along + 45 ? Math.max(0, stopProj.along - busOnStop.along) : Infinity;

  // Hypothesis 2: bus is still finishing oppositeBranch -> terminal turnaround -> start of stopBranch -> stop
  let loopDist = Infinity;
  if (oppositeBranch && busOnOpp) {
    const oppEnd = oppositeBranch.pts[oppositeBranch.pts.length - 1];
    const stopStart = stopBranch.pts[0];
    const turnaroundGap = distanceMeters(oppEnd[0], oppEnd[1], stopStart[0], stopStart[1]) || 0;
    loopDist = Math.max(0, oppositeBranch.totalLen - busOnOpp.along) + turnaroundGap + stopProj.along;
  }

  // Signal 1: Real observed GPS heading vector between consecutive SOAP polls for this exact bus unit
  let headingDecision = null;
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
          headingDecision = 'previous_leg';
        } else if (dotStop > 0.35 && dotStop > dotOpp + 0.3 && directDist < Infinity) {
          headingDecision = 'direct';
        }
      }
    }
  }

  // Signal 2: ETA vs Route Distance Consistency (immediately catches across-the-street opposite buses on 1st load!)
  let leg = 'direct';
  if (headingDecision) {
    leg = headingDecision;
  } else if (oppositeBranch && busOnOpp && busOnOpp.perp < 450) {
    if (directDist === Infinity) {
      leg = 'previous_leg';
    } else {
      const avgMetersPerMin = 250; // ~15 km/h urban Corrientes average
      const estDirectMin = directDist / avgMetersPerMin;
      const estLoopMin = loopDist / avgMetersPerMin;

      // Case A: Bus is way too close on stopBranch for the reported ETA (e.g., 150m away yet 30 min ETA)
      const directImplausiblySlow = etaMin >= 7 && directDist < etaMin * 105;
      const loopMatchesBetter = Math.abs(estLoopMin - etaMin) + 2 < Math.abs(estDirectMin - etaMin);

      // Case B: Bus is physically closer to oppositeBranch lane AND ETA is far longer than direct distance
      const physicallyOnOppLane = busOnOpp.perp + 18 < busOnStop.perp && etaMin >= 6 && directDist < 1400;

      if ((directImplausiblySlow && loopMatchesBetter) || physicallyOnOppLane) {
        leg = 'previous_leg';
      }
    }
  } else if (directDist === Infinity) {
    // No opposite branch available, but bus already passed the stop -> full loop on stopBranch
    leg = 'direct';
  }

  let pathPts;
  let realBandera;
  let totalMeters;

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
      realBandera,
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
    realBandera: stopBranch.bandera || bus.descripcionBandera,
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
    return { lat: last[0], lng: last[1], remainingMeters: 0, arrived: true, inOppositeLeg: false };
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

  return {
    lat,
    lng,
    remainingMeters: Math.max(0, totalMeters - clamped),
    arrived: false,
    inOppositeLeg: traj.isOppositeLeg && clamped < traj.turnaroundAtMeters
  };
}
