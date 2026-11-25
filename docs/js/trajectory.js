import { distanceMeters } from './api.js';
import { getDirectionColor } from './config.js';

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

const METERS_PER_DEG_LAT = 110850;
const METERS_PER_DEG_LNG_EQ = 111320;

export function projectOnPolyline(pts, cum, lat, lng, minAlong = -Infinity) {
  const cosLat = Math.cos((lat * Math.PI) / 180);
  const scaleLng = METERS_PER_DEG_LNG_EQ * cosLat;
  let bestPerpSq = Infinity;
  let bestIdx = 0;
  let bestT = 0;
  let bestLat = pts[0][0];
  let bestLng = pts[0][1];
  let bestAlong = 0;
  let bestALat = pts[0][0];
  let bestALng = pts[0][1];
  let bestBLat = pts[0][0];
  let bestBLng = pts[0][1];
  let found = false;

  for (let i = 0, n = pts.length - 1; i < n; i++) {
    const segEndAlong = cum[i + 1] || 0;
    if (segEndAlong < minAlong) continue;
    const segStartAlong = cum[i] || 0;
    const aLat = pts[i][0];
    const aLng = pts[i][1];
    const bLat = pts[i + 1][0];
    const bLng = pts[i + 1][1];
    const dyM = (bLat - aLat) * METERS_PER_DEG_LAT;
    const dxM = (bLng - aLng) * scaleLng;
    const lenSq = dxM * dxM + dyM * dyM;
    const pyM = (lat - aLat) * METERS_PER_DEG_LAT;
    const pxM = (lng - aLng) * scaleLng;
    const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, (pxM * dxM + pyM * dyM) / lenSq));
    const along = segStartAlong + (segEndAlong - segStartAlong) * t;
    if (along < minAlong) continue;
    const rdx = pxM - dxM * t;
    const rdy = pyM - dyM * t;
    const perpSq = rdx * rdx + rdy * rdy;
    if (perpSq < bestPerpSq) {
      bestPerpSq = perpSq;
      bestIdx = i;
      bestT = t;
      bestLat = aLat + (bLat - aLat) * t;
      bestLng = aLng + (bLng - aLng) * t;
      bestAlong = along;
      bestALat = aLat;
      bestALng = aLng;
      bestBLat = bLat;
      bestBLng = bLng;
      found = true;
    }
  }

  return {
    segIdx: bestIdx,
    t: bestT,
    lat: bestLat,
    lng: bestLng,
    along: bestAlong,
    perp: found ? Math.sqrt(bestPerpSq) : Infinity,
    tangent: found ? unitVector(bestALat, bestALng, bestBLat, bestBLng) : null
  };
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

function findCumSegment(cum, meters) {
  let lo = 0;
  let hi = cum.length - 2;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cum[mid + 1] < meters) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function sampleBranchAtAlong(branch, alongMeters) {
  const { pts, cum, totalLen } = branch;
  if (!pts || pts.length === 0) return null;
  if (pts.length === 1 || alongMeters <= 0) {
    return { segIdx: 0, t: 0, lat: pts[0][0], lng: pts[0][1], along: 0 };
  }
  if (alongMeters >= totalLen) {
    const lastIdx = pts.length - 1;
    return { segIdx: Math.max(0, lastIdx - 1), t: 1, lat: pts[lastIdx][0], lng: pts[lastIdx][1], along: totalLen };
  }
  const i = findCumSegment(cum, alongMeters);
  const segStart = cum[i];
  const segLen = Math.max(0.001, cum[i + 1] - segStart);
  const t = Math.max(0, Math.min(1, (alongMeters - segStart) / segLen));
  return {
    segIdx: i,
    t,
    lat: pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t,
    lng: pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t,
    along: alongMeters
  };
}

export function parseRouteBranches(recorridos = []) {
  return (recorridos || [])
    .map((r, idx) => {
      const pts = (r.puntos || [])
        .map((p) => [parseFloat(p.latitud), parseFloat(p.longitud)])
        .filter(([la, ln]) => !Number.isNaN(la) && !Number.isNaN(ln));
      if (pts.length < 2) return null;
      const cum = buildCumDist(pts);
      const stopIds = new Set();
      const stopAlongs = [];
      const orderedStops = [];
      let prevAlong = -Infinity;

      for (const s of r.paradas || []) {
        const sid = String(s.identificador || '').trim().toUpperCase();
        if (sid) stopIds.add(sid);
        const sla = parseFloat(s.latitudParada);
        const sln = parseFloat(s.longitudParada);
        if (!Number.isNaN(sla) && !Number.isNaN(sln)) {
          // Prefer monotonic forward projection along the branch so loop routes keep sequential stop order
          let p = prevAlong > -Infinity ? projectOnPolyline(pts, cum, sla, sln, Math.max(0, prevAlong - 45)) : null;
          if (!p || p.perp > 120) {
            p = projectOnPolyline(pts, cum, sla, sln);
          }
          if (p.perp < 160) {
            stopAlongs.push(p.along);
            if (sid) {
              orderedStops.push({
                id: sid,
                along: p.along,
                lat: p.lat,
                lng: p.lng,
                descripcion: String(s.descripcion || '').trim()
              });
            }
            if (p.along >= prevAlong - 45) prevAlong = Math.max(prevAlong, p.along);
          }
        }
      }
      stopAlongs.sort((a, b) => a - b);
      orderedStops.sort((a, b) => a.along - b.along);
      return {
        index: idx,
        color: getDirectionColor(idx),
        bandera: String(r.abreviaturaBanderaSMP || r.descripcion || '').trim(),
        git: String(r.abreviaturaGit || '').trim(),
        pts,
        cum,
        totalLen: cum[cum.length - 1] || 0,
        stopIds,
        stopAlongs,
        orderedStops
      };
    })
    .filter(Boolean);
}

export function pickStopBranch(branches, stopId, stopCoords, stopBandera = '') {
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

/**
 * Returns ALL branches of a line that serve `stopId` (critical for the 207+ shared stops on
 * multi-branch lines like 103C, 104A, 104D, 105C, 109B). Falls back to closest single branch.
 */
export function pickStopBranches(branches, stopId, stopCoords, stopBandera = '') {
  if (!branches || branches.length === 0) return [];
  const cleanId = String(stopId || '').trim().toUpperCase();
  const matched = branches.filter((b) => b.stopIds.has(cleanId));
  if (matched.length > 0) return matched;
  const single = pickStopBranch(branches, stopId, stopCoords, stopBandera);
  return single ? [single] : [];
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
 * Picks the exact paired return branch for `stopBranch` (start near stopBranch's end,
 * end near stopBranch's start). Crucial for 3-4 branch lines like 103C, 104A, 104D.
 */
export function pickPairedReturnBranch(branches, stopBranch) {
  const candidates = branches.filter((b) => b !== stopBranch && b.pts.length >= 6);
  if (candidates.length === 0) return null;

  const stopStart = stopBranch.pts[0];
  const stopEnd = stopBranch.pts[stopBranch.pts.length - 1];
  let best = null;
  let bestGap = Infinity;

  for (const b of candidates) {
    const bStart = b.pts[0];
    const bEnd = b.pts[b.pts.length - 1];
    const gap =
      (distanceMeters(stopEnd[0], stopEnd[1], bStart[0], bStart[1]) || 0) +
      (distanceMeters(bEnd[0], bEnd[1], stopStart[0], stopStart[1]) || 0);
    if (gap < bestGap) {
      bestGap = gap;
      best = b;
    }
  }
  return best;
}

/**
 * Picks ALL feeder/return branches whose endpoint terminates near `targetBranch`'s origin cabecera
 * (within 650 m). Handles multi-branch hubs (e.g. Puerto on 105C, Bº Esperanza on 103C).
 */
export function pickIncomingBranches(branches, targetBranch) {
  if (!branches || !targetBranch?.pts?.length) return [];
  const targetStart = targetBranch.pts[0];
  const near = branches
    .filter((b) => b !== targetBranch && b.pts.length >= 2)
    .map((b) => {
      const bEnd = b.pts[b.pts.length - 1];
      return { b, gap: distanceMeters(bEnd[0], bEnd[1], targetStart[0], targetStart[1]) ?? Infinity };
    })
    .filter((x) => x.gap <= 650)
    .sort((a, c) => a.gap - c.gap)
    .map((x) => x.b);
  if (near.length > 0) return near;
  const fallback = pickPairedReturnBranch(branches, targetBranch);
  return fallback ? [fallback] : [];
}

/**
 * Builds an exact BusSimulator/TransitMap trajectory starting at `activeAlong` on `activeBranch`
 * (either `stopBranch` directly or its paired return branch `prevBranch`) and ending at `stopProj` on `stopBranch`.
 */
export function buildTrajectoryFromBranchAlong(
  activeBranch,
  activeAlong,
  stopBranch,
  stopProj,
  { isAtTerminal = false, etaSec = 600, viaBranch = null } = {}
) {
  if (!activeBranch || !stopBranch || !stopProj) return null;

  const mapStopsInRange = (branch, fromAlong, toAlong, offsetMeters) => {
    const out = [];
    for (const sa of branch?.stopAlongs || []) {
      if (sa > fromAlong + 15 && sa < toAlong - 15) {
        out.push(offsetMeters + (sa - fromAlong));
      }
    }
    return out;
  };

  const stopBandera = stopBranch.bandera || '';
  const stopColor = stopBranch.color;

  // 3-leg full_cycle: finishing `activeBranch` -> full `viaBranch` -> `stopBranch` up to `stopProj`
  if (viaBranch) {
    const clampedAlong = Math.max(0, Math.min(activeBranch.totalLen, activeAlong));
    const startProj = sampleBranchAtAlong(activeBranch, clampedAlong);
    const seg1Pts = slicePolyline(activeBranch.pts, startProj, null);
    const seg2Pts = viaBranch.pts || [];
    const stopStartProj = { segIdx: 0, t: 0, lat: stopBranch.pts[0][0], lng: stopBranch.pts[0][1] };
    const seg3Pts = slicePolyline(stopBranch.pts, stopStartProj, stopProj);

    const pathPts = [...seg1Pts, ...seg2Pts, ...seg3Pts];
    const cum = buildCumDist(pathPts);
    const totalMeters = cum[cum.length - 1] || 0;
    const oppStartMeters = cum[seg1Pts.length] ?? (cum[Math.max(0, seg1Pts.length - 1)] || 0);
    const turnaroundAtMeters = cum[seg1Pts.length + seg2Pts.length] ?? oppStartMeters;

    const actBandera = activeBranch.bandera || stopBandera;
    const actColor = activeBranch.color || stopColor;
    const viaBandera = viaBranch.bandera || 'Sentido opuesto';
    const viaColor = viaBranch.color;

    const stopAlongs = [
      ...mapStopsInRange(activeBranch, clampedAlong, activeBranch.totalLen, 0),
      ...mapStopsInRange(viaBranch, 0, viaBranch.totalLen, oppStartMeters),
      ...mapStopsInRange(stopBranch, 0, stopProj.along, turnaroundAtMeters)
    ].sort((a, b) => a - b);

    const segments = [
      { pts: seg1Pts, color: actColor, bandera: actBandera, startMeters: 0, endMeters: oppStartMeters },
      { pts: seg2Pts, color: viaColor, bandera: viaBandera, startMeters: oppStartMeters, endMeters: turnaroundAtMeters },
      { pts: seg3Pts, color: stopColor, bandera: stopBandera, startMeters: turnaroundAtMeters, endMeters: totalMeters }
    ];

    return {
      leg: 'full_cycle',
      isOppositeLeg: false,
      isNextCycle: true,
      isAtTerminal,
      realBandera: actBandera,
      realBanderaColor: actColor,
      segments,
      stopAlongs,
      oppStartMeters,
      turnaroundAtMeters,
      pathPts,
      pathCum: cum,
      totalMeters,
      walkedMeters: 0,
      speedMps: Math.max(2.2, Math.min(24.0, totalMeters / Math.max(45, etaSec)))
    };
  }

  if (activeBranch === stopBranch) {
    const clampedAlong = Math.max(0, Math.min(stopProj.along, activeAlong));
    const startProj = sampleBranchAtAlong(stopBranch, clampedAlong);
    const pathPts = slicePolyline(stopBranch.pts, startProj, stopProj);
    const cum = buildCumDist(pathPts);
    const totalMeters = cum[cum.length - 1] || 0;
    const stopAlongs = mapStopsInRange(stopBranch, clampedAlong, stopProj.along, 0);

    return {
      leg: 'direct',
      isOppositeLeg: false,
      isNextCycle: false,
      isAtTerminal,
      realBandera: stopBandera,
      realBanderaColor: stopColor,
      segments: [{ pts: pathPts, color: stopColor, bandera: stopBandera, startMeters: 0, endMeters: totalMeters }],
      stopAlongs,
      oppStartMeters: 0,
      turnaroundAtMeters: 0,
      pathPts,
      pathCum: cum,
      totalMeters,
      walkedMeters: 0,
      speedMps: Math.max(2.2, Math.min(24.0, totalMeters / Math.max(45, etaSec)))
    };
  }

  // Bus is currently on the paired return branch (`activeBranch`) heading to the turnaround before `stopBranch`
  const clampedAlong = Math.max(0, Math.min(activeBranch.totalLen, activeAlong));
  const startProj = sampleBranchAtAlong(activeBranch, clampedAlong);
  const oppRemainder = slicePolyline(activeBranch.pts, startProj, null);
  const stopStartProj = { segIdx: 0, t: 0, lat: stopBranch.pts[0][0], lng: stopBranch.pts[0][1] };
  const stopApproach = slicePolyline(stopBranch.pts, stopStartProj, stopProj);
  const pathPts = [...oppRemainder, ...stopApproach];
  const cum = buildCumDist(pathPts);
  const totalMeters = cum[cum.length - 1] || 0;
  const turnaroundAtMeters = cum[oppRemainder.length] ?? (cum[Math.max(0, oppRemainder.length - 1)] || 0);
  const oppBandera = activeBranch.bandera || 'Sentido opuesto';
  const oppColor = activeBranch.color;

  const stopAlongs = [
    ...mapStopsInRange(activeBranch, clampedAlong, activeBranch.totalLen, 0),
    ...mapStopsInRange(stopBranch, 0, stopProj.along, turnaroundAtMeters)
  ].sort((a, b) => a - b);

  const segments = [
    { pts: oppRemainder, color: oppColor, bandera: oppBandera, startMeters: 0, endMeters: turnaroundAtMeters },
    { pts: stopApproach, color: stopColor, bandera: stopBandera, startMeters: turnaroundAtMeters, endMeters: totalMeters }
  ];

  return {
    leg: 'previous_leg',
    isOppositeLeg: true,
    isNextCycle: false,
    isAtTerminal,
    realBandera: oppBandera,
    realBanderaColor: oppColor,
    segments,
    stopAlongs,
    oppStartMeters: 0,
    turnaroundAtMeters,
    pathPts,
    pathCum: cum,
    totalMeters,
    walkedMeters: 0,
    speedMps: Math.max(2.2, Math.min(24.0, totalMeters / Math.max(45, etaSec)))
  };
}

function normalizeBanderaLite(str = '') {
  return String(str || '')
    .toUpperCase()
    .replace(/[º°]/g, 'O')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
}

/**
 * Resolves which route branch a physical bus is genuinely travelling along using an internal
 * multi-point GPS position trail (`[{ lat, lng, gpsMs, ts }, ...]`) plus persisted direction hysteresis.
 *
 * Combines 3 geometric signals across the trail:
 *  1. Net forward progress along each branch polyline (`Δalong > 0` vs `< 0`)
 *  2. Recency-weighted tangent alignment (`dot(gpsDir, branchTangent)`)
 *  3. Mean perpendicular lane proximity (disambiguates parallel one-way streets in Corrientes)
 *
 * Also handles cabecera U-turns cleanly by checking the freshest moving tail (`>= 55 m`),
 * and holds the last confirmed branch steady while stopped at red lights until terminal turnaround.
 */
export function resolveTrailDirection(
  trailOrHist,
  branches = [],
  { currentFix = null, maxAgeMs = 8 * 60 * 1000, persistMaxAgeMs = 6 * 60 * 1000 } = {}
) {
  if (!Array.isArray(branches) || branches.length === 0 || !trailOrHist) return null;

  const isArray = Array.isArray(trailOrHist);
  const rawTrail = isArray
    ? trailOrHist
    : Array.isArray(trailOrHist.trail)
      ? trailOrHist.trail
      : [];
  const confirmedDir = !isArray && trailOrHist.confirmedDir ? trailOrHist.confirmedDir : null;

  // Build chronological list of valid fixes, appending currentFix if fresher/distinct
  const fixes = [];
  for (const pt of rawTrail) {
    if (!pt || typeof pt.lat !== 'number' || typeof pt.lng !== 'number') continue;
    if (Number.isNaN(pt.lat) || Number.isNaN(pt.lng) || (pt.lat === 0 && pt.lng === 0)) continue;
    fixes.push({
      lat: pt.lat,
      lng: pt.lng,
      gpsMs: typeof pt.gpsMs === 'number' && Number.isFinite(pt.gpsMs) ? pt.gpsMs : null,
      ts: typeof pt.ts === 'number' && Number.isFinite(pt.ts) ? pt.ts : 0
    });
  }

  // Fallback for legacy `{ prevMoving, prev, latest }` without `.trail`
  if (fixes.length === 0 && !isArray) {
    const legacyPts = [trailOrHist.prevMoving, trailOrHist.prev, trailOrHist.latest].filter(
      (p) => p && typeof p.lat === 'number' && typeof p.lng === 'number'
    );
    for (const p of legacyPts) {
      if (!fixes.some((f) => f.lat === p.lat && f.lng === p.lng)) {
        fixes.push({ lat: p.lat, lng: p.lng, gpsMs: p.gpsMs ?? null, ts: p.ts || 0 });
      }
    }
  }

  if (currentFix && typeof currentFix.lat === 'number' && typeof currentFix.lng === 'number') {
    const last = fixes[fixes.length - 1];
    const distLast = last ? distanceMeters(last.lat, last.lng, currentFix.lat, currentFix.lng) || 0 : Infinity;
    const curMs = typeof currentFix.gpsMs === 'number' ? currentFix.gpsMs : null;
    const isDup =
      last &&
      distLast < 4 &&
      (curMs === null || last.gpsMs === null || Math.abs(curMs - last.gpsMs) < 3000);
    if (!isDup) {
      fixes.push({
        lat: currentFix.lat,
        lng: currentFix.lng,
        gpsMs: curMs,
        ts: currentFix.ts || Date.now()
      });
    }
  }

  if (fixes.length === 0) return null;

  const latestFix = fixes[fixes.length - 1];
  const refTime = latestFix.gpsMs ?? latestFix.ts ?? 0;

  // Prune fixes older than maxAgeMs relative to latestFix
  const recentFixes =
    refTime > 0
      ? fixes.filter((f) => {
          const ft = f.gpsMs ?? f.ts ?? refTime;
          return refTime - ft <= maxAgeMs;
        })
      : fixes;

  // Compact near-stationary jitter points (< 12 m apart) so red-light waits keep the moving trail intact
  const movingPts = [];
  for (const f of recentFixes) {
    if (movingPts.length === 0) {
      movingPts.push(f);
    } else {
      const prev = movingPts[movingPts.length - 1];
      const d = distanceMeters(prev.lat, prev.lng, f.lat, f.lng) || 0;
      if (d >= 12) {
        movingPts.push(f);
      }
    }
  }

  const evaluateWindow = (pts) => {
    if (pts.length < 2) return null;
    let totalSpan = 0;
    const segDirs = [];
    for (let i = 1; i < pts.length; i++) {
      const d = distanceMeters(pts[i - 1].lat, pts[i - 1].lng, pts[i].lat, pts[i].lng) || 0;
      if (d < 12) continue;
      totalSpan += d;
      const dir = unitVector(pts[i - 1].lat, pts[i - 1].lng, pts[i].lat, pts[i].lng);
      if (dir) {
        segDirs.push({ idx: i, dist: d, dir, recency: 0.55 + 0.45 * (i / Math.max(1, pts.length - 1)) });
      }
    }
    if (totalSpan < 18 || segDirs.length === 0) return null;

    const scored = [];
    for (const b of branches) {
      if (!b?.pts || b.pts.length < 2) continue;
      const latestProj = projectOnPolyline(b.pts, b.cum, latestFix.lat, latestFix.lng);
      if (!latestProj || latestProj.perp > 240) continue;

      const projs = pts.map((p) => projectOnPolyline(b.pts, b.cum, p.lat, p.lng));
      let fwdMeters = 0;
      let bwdMeters = 0;
      let validAlongSpan = 0;
      let dotWeighted = 0;
      let weightSum = 0;
      let perpSum = 0;
      let perpCount = 0;

      for (const p of projs) {
        if (p && Number.isFinite(p.perp)) {
          perpSum += p.perp;
          perpCount++;
        }
      }

      for (const seg of segDirs) {
        const pPrev = projs[seg.idx - 1];
        const pCur = projs[seg.idx];
        if (!pPrev || !pCur) continue;
        const w = seg.dist * seg.recency;

        // Tangent consensus against both endpoints of segment for curved avenues
        const tCur = pCur.tangent;
        const tPrev = pPrev.tangent;
        if (tCur) {
          const dCur = seg.dir[0] * tCur[0] + seg.dir[1] * tCur[1];
          const dPrev = tPrev ? seg.dir[0] * tPrev[0] + seg.dir[1] * tPrev[1] : dCur;
          const dot = (dCur * 0.65 + dPrev * 0.35);
          dotWeighted += dot * w;
          weightSum += w;
        }

        // Net along-polyline progress (ignore wrap-around jumps on self-crossing corridors)
        const dAlong = pCur.along - pPrev.along;
        if (Math.abs(dAlong) <= seg.dist * 2.4 + 220) {
          if (dAlong >= 0) fwdMeters += dAlong;
          else bwdMeters += -dAlong;
          validAlongSpan += seg.dist;
        }
      }

      if (weightSum <= 0) continue;
      const meanDot = dotWeighted / weightSum;
      const netAlong = fwdMeters - bwdMeters;
      const alongRatio =
        validAlongSpan >= 18 ? Math.max(-1, Math.min(1, netAlong / Math.max(25, validAlongSpan))) : meanDot;
      const meanPerp = perpCount > 0 ? perpSum / perpCount : latestProj.perp;

      // Combined directional evidence: tangent consensus + net forward along progress - lane offset penalty
      const score = meanDot * 1.0 + alongRatio * 1.0 - Math.min(0.55, meanPerp / 220);
      scored.push({
        branch: b,
        score,
        meanDot,
        alongRatio,
        netAlong,
        meanPerp,
        latestAlong: latestProj.along,
        latestPerp: latestProj.perp,
        totalSpan
      });
    }

    if (scored.length === 0) return null;
    scored.sort((a, b) => b.score - a.score);
    const top = scored[0];
    const second = scored[1] || null;
    const margin = second ? top.score - second.score : top.score + 0.5;
    if (top.score < 0.42 || (top.meanDot < 0.25 && top.alongRatio < 0.32)) return null;
    if (second && margin < 0.28) return null;

    return {
      branch: top.branch,
      bandera: top.branch.bandera || '',
      index: top.branch.index,
      along: top.latestAlong,
      perp: top.latestPerp,
      meanDot: top.meanDot,
      netAlong: top.netAlong,
      totalSpan: top.totalSpan,
      sampleCount: pts.length,
      confidence: Math.max(0.5, Math.min(1.0, margin / 1.45)),
      source: 'trail'
    };
  };

  // Evaluate both the full moving trail and the freshest tail (to catch fresh cabecera U-turns quickly!)
  const fullRes = evaluateWindow(movingPts);
  const tailPts = movingPts.length >= 3 ? movingPts.slice(-3) : null;
  const tailRes = tailPts ? evaluateWindow(tailPts) : null;

  if (
    tailRes &&
    tailRes.totalSpan >= 55 &&
    tailRes.meanDot >= 0.62 &&
    tailRes.netAlong >= 40 &&
    (!fullRes || tailRes.branch !== fullRes.branch)
  ) {
    return tailRes;
  }
  if (fullRes) return fullRes;
  if (tailRes) return tailRes;

  // Hysteresis fallback: keep previously confirmed direction steady while stopped at red lights
  if (confirmedDir && confirmedDir.bandera) {
    const dirAgeMs =
      confirmedDir.gpsMs && latestFix.gpsMs
        ? latestFix.gpsMs - confirmedDir.gpsMs
        : confirmedDir.ts && latestFix.ts
          ? latestFix.ts - confirmedDir.ts
          : 0;
    const maxPersist = confirmedDir.fromServer ? Math.min(persistMaxAgeMs, 3.5 * 60 * 1000) : persistMaxAgeMs;
    if (dirAgeMs >= -60000 && dirAgeMs <= maxPersist) {
      const normTarget = normalizeBanderaLite(confirmedDir.bandera);
      const matchedBranch = branches.find((b) => normalizeBanderaLite(b.bandera) === normTarget);
      if (matchedBranch) {
        const proj = projectOnPolyline(matchedBranch.pts, matchedBranch.cum, latestFix.lat, latestFix.lng);
        const nearEndTerminal = matchedBranch.totalLen - proj.along <= 240;
        // Hold direction while still on/near that branch and not yet parked at the far turnaround terminal
        if (proj.perp <= 200 && !nearEndTerminal) {
          return {
            branch: matchedBranch,
            bandera: matchedBranch.bandera || '',
            index: matchedBranch.index,
            along: proj.along,
            perp: proj.perp,
            meanDot: null,
            netAlong: 0,
            totalSpan: 0,
            sampleCount: fixes.length,
            confidence: Math.max(0.45, (confirmedDir.confidence || 0.7) * 0.85),
            source: 'persisted'
          };
        }
      }
    }
  }

  return null;
}

/**
 * Resolves the true direction & cycle of a live bus:
 *  - 'direct': on stopBranch approaching the stop directly
 *  - 'previous_leg': on oppositeBranch heading to turnaround terminal before stopBranch
 *  - 'full_cycle': on stopBranch AFTER the stop (already passed it) -> far terminal -> full paired returnBranch -> turnaround -> stop
 * Computes exact remaining routeMeters along the real street polylines and per-direction color segments.
 * Accepts either a legacy single `prevFix` `{ lat, lng }` or a rich unit GPS history `{ trail, prevMoving, confirmedDir }`.
 */
export function resolveBusTrajectory(bus, stopId, stopCoords, branches = [], prevFixOrHist = null) {
  if (!stopCoords || typeof bus.lat !== 'number' || typeof bus.lng !== 'number') {
    return null;
  }

  const etaMin = bus.eta?.valid === false ? 10 : (bus.eta?.minutes ?? 10);
  const etaSec = etaMin <= 0 ? 45 : etaMin * 60;
  const stopBranch = pickStopBranch(branches, stopId, stopCoords, bus.descripcionBandera);

  if (!stopBranch) {
    const directPts = [
      [bus.lat, bus.lng],
      [stopCoords.lat, stopCoords.lng]
    ];
    const cum = buildCumDist(directPts);
    const total = cum[cum.length - 1] || 0;
    const fallbackColor = getDirectionColor(0);
    return {
      leg: 'direct',
      isOppositeLeg: false,
      isNextCycle: false,
      realBandera: bus.descripcionBandera,
      realBanderaColor: fallbackColor,
      segments: [{ pts: directPts, color: fallbackColor, bandera: bus.descripcionBandera, startMeters: 0, endMeters: total }],
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
  let { oppositeBranch, busOnOpp } = pickBestOppositeBranch(branches, stopBranch, bus.lat, bus.lng);
  const returnBranch = pickPairedReturnBranch(branches, stopBranch);

  // Signal 1: Multi-point GPS trail direction aligned against route polylines (+ persisted hysteresis)
  let headingDir = null; // 'stop' | 'opp' | null
  let confirmedBranch = null;
  let directionConfidence = 0;
  let directionSource = 'eta';

  const isRichHist = Boolean(
    prevFixOrHist && (Array.isArray(prevFixOrHist) || Array.isArray(prevFixOrHist.trail) || prevFixOrHist.confirmedDir)
  );
  const trailDir = isRichHist
    ? resolveTrailDirection(prevFixOrHist, branches, {
        currentFix: { lat: bus.lat, lng: bus.lng, gpsMs: bus.gpsMs ?? null, ts: Date.now() }
      })
    : null;

  if (trailDir && trailDir.branch) {
    confirmedBranch = trailDir.branch;
    directionConfidence = trailDir.confidence;
    directionSource = trailDir.source;
    if (trailDir.branch === stopBranch) {
      headingDir = 'stop';
    } else {
      headingDir = 'opp';
      // On 3-4 branch lines (103C, 104A, 104D, 105C), lock oppositeBranch to the trail-confirmed branch!
      oppositeBranch = trailDir.branch;
      busOnOpp = projectOnPolyline(oppositeBranch.pts, oppositeBranch.cum, bus.lat, bus.lng);
    }
  }

  // Hypothesis 1: bus is already on stopBranch BEFORE stop, heading directly toward stop
  const directDist =
    busOnStop.along <= stopProj.along + 45 ? Math.max(0, stopProj.along - busOnStop.along) : Infinity;

  // Hypothesis 2: bus is finishing oppositeBranch -> turnaround -> start of stopBranch -> stop
  let loopDist = Infinity;
  if (oppositeBranch && busOnOpp) {
    const oppEnd = oppositeBranch.pts[oppositeBranch.pts.length - 1];
    const stopStart = stopBranch.pts[0];
    const gapOppToStop = distanceMeters(oppEnd[0], oppEnd[1], stopStart[0], stopStart[1]) || 0;
    loopDist = Math.max(0, oppositeBranch.totalLen - busOnOpp.along) + gapOppToStop + stopProj.along;
  }

  // Hypothesis 3: bus is on stopBranch AFTER the stop (or just passing it) -> far terminal -> full returnBranch -> turnaround -> stop
  let fullCycleDist = Infinity;
  if (busOnStop) {
    const stopEnd = stopBranch.pts[stopBranch.pts.length - 1];
    const stopStart = stopBranch.pts[0];
    if (returnBranch) {
      const retStart = returnBranch.pts[0];
      const retEnd = returnBranch.pts[returnBranch.pts.length - 1];
      const gap1 = distanceMeters(stopEnd[0], stopEnd[1], retStart[0], retStart[1]) || 0;
      const gap2 = distanceMeters(retEnd[0], retEnd[1], stopStart[0], stopStart[1]) || 0;
      fullCycleDist =
        Math.max(0, stopBranch.totalLen - busOnStop.along) + gap1 + returnBranch.totalLen + gap2 + stopProj.along;
    } else {
      const gapClose = distanceMeters(stopEnd[0], stopEnd[1], stopStart[0], stopStart[1]) || 0;
      fullCycleDist = Math.max(0, stopBranch.totalLen - busOnStop.along) + gapClose + stopProj.along;
    }
  }

  // Realistic urban Corrientes commercial speed estimates (including stops + terminal layovers)
  const estDirectMin = directDist < Infinity ? directDist / 230 : Infinity;
  const estOppMin = loopDist < Infinity ? loopDist / 210 + 3 : Infinity;
  const estCycleMin = fullCycleDist < Infinity ? fullCycleDist / 210 + (returnBranch ? 6 : 3) : Infinity;

  // Legacy 2-point heading fallback when caller passed a single prevFix or trail had no multi-point consensus
  const fallbackPrevFix = !isRichHist
    ? prevFixOrHist
    : prevFixOrHist?.prevMoving || prevFixOrHist?.prev || null;
  if (!headingDir && fallbackPrevFix && typeof fallbackPrevFix.lat === 'number' && typeof fallbackPrevFix.lng === 'number') {
    const moved = distanceMeters(fallbackPrevFix.lat, fallbackPrevFix.lng, bus.lat, bus.lng) || 0;
    if (moved >= 25) {
      const gpsDir = unitVector(fallbackPrevFix.lat, fallbackPrevFix.lng, bus.lat, bus.lng);
      if (gpsDir && busOnStop.tangent) {
        const dotStop = gpsDir[0] * busOnStop.tangent[0] + gpsDir[1] * busOnStop.tangent[1];
        const dotOpp =
          busOnOpp && busOnOpp.tangent
            ? gpsDir[0] * busOnOpp.tangent[0] + gpsDir[1] * busOnOpp.tangent[1]
            : -1;

        if (oppositeBranch && dotOpp > 0.35 && dotOpp > dotStop + 0.3) {
          headingDir = 'opp';
          confirmedBranch = oppositeBranch;
          directionConfidence = 0.6;
          directionSource = 'heading';
        } else if (dotStop > 0.35 && dotStop > dotOpp + 0.3) {
          headingDir = 'stop';
          confirmedBranch = stopBranch;
          directionConfidence = 0.6;
          directionSource = 'heading';
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

    if (Math.abs(fullCycleDist - loopDist) < 1500) {
      return oppErr <= cycleErr + 6 ? 'previous_leg' : 'full_cycle';
    }

    if (cycleErr + 4 < oppErr) return 'full_cycle';
    if (oppErr + 4 < cycleErr) return 'previous_leg';

    if (busOnStop.perp + 15 < busOnOpp.perp) return 'full_cycle';
    return 'previous_leg';
  };

  // Signal 2: Combine GPS trail direction + divided-avenue carriageway + ETA vs Route Distance Consistency
  let leg = 'direct';
  const hasOpposite = Boolean(oppositeBranch && busOnOpp && busOnOpp.perp < 650);
  const nearOppTerm =
    hasOpposite &&
    (busOnOpp.along <= 200 || Math.max(0, (oppositeBranch.totalLen || 0) - busOnOpp.along) <= 200);
  const physicallyOnOppLane =
    hasOpposite &&
    !nearOppTerm &&
    busOnOpp &&
    busOnStop &&
    busOnOpp.perp <= 28 &&
    busOnOpp.perp + 9 < busOnStop.perp;
  const isFreshPhysicalTrail = directionSource === 'trail' || directionSource === 'heading';

  if (headingDir === 'opp' && hasOpposite) {
    leg = 'previous_leg';
  } else if (headingDir === 'stop' && isFreshPhysicalTrail) {
    if (directDist === Infinity) {
      leg = 'full_cycle';
    } else if (etaMin >= 25 && Math.abs(estCycleMin - etaMin) + 12 < Math.abs(estDirectMin - etaMin)) {
      leg = 'full_cycle';
    } else {
      leg = 'direct';
    }
  } else if (physicallyOnOppLane) {
    // Divided avenue (Av. Independencia, Av. Ferré, Av. 3 de Abril) or one-way street:
    // physical opposite carriageway beats both bogus SmartMovePro ETA and stale persisted dirBandera!
    leg = 'previous_leg';
    confirmedBranch = oppositeBranch;
    directionSource = 'lane';
    directionConfidence = Math.max(directionConfidence, 0.72);
  } else if (headingDir === 'stop') {
    if (directDist === Infinity) {
      leg = 'full_cycle';
    } else if (etaMin >= 25 && Math.abs(estCycleMin - etaMin) + 12 < Math.abs(estDirectMin - etaMin)) {
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

      const directImplausiblySlow = etaMin >= 7 && directDist < etaMin * 105;
      const indirectMatchesBetter = Math.abs(bestIndirectEst - etaMin) + 3 < Math.abs(estDirectMin - etaMin);

      if (directImplausiblySlow && indirectMatchesBetter) {
        leg = bestIndirect;
      }
    }
  } else if (directDist === Infinity) {
    leg = 'full_cycle';
  }

  const stopBandera = stopBranch.bandera || bus.descripcionBandera;
  const stopColor = stopBranch.color;

  // Detect if the bus is currently parked/resting at a line terminal (cabecera / punta de línea)
  const terminalPts = [
    stopBranch.pts[0],
    stopBranch.pts[stopBranch.pts.length - 1]
  ];
  if (oppositeBranch) {
    terminalPts.push(oppositeBranch.pts[0], oppositeBranch.pts[oppositeBranch.pts.length - 1]);
  }
  if (returnBranch && returnBranch !== oppositeBranch) {
    terminalPts.push(returnBranch.pts[0], returnBranch.pts[returnBranch.pts.length - 1]);
  }
  const nearTerminalPt = terminalPts.some(
    (pt) => (distanceMeters(bus.lat, bus.lng, pt[0], pt[1]) ?? Infinity) <= 240
  );
  const firstStopAlong = stopBranch.orderedStops?.[0]?.along ?? 0;
  const nearStopBranchOrigin =
    leg === 'direct' &&
    busOnStop &&
    busOnStop.perp <= 140 &&
    busOnStop.along <= Math.min(340, Math.max(220, firstStopAlong + 130));
  const nearOppBranchTerminal =
    leg === 'previous_leg' &&
    oppositeBranch &&
    busOnOpp &&
    busOnOpp.perp <= 140 &&
    (oppositeBranch.totalLen - busOnOpp.along <= 360 || busOnOpp.along <= 220);
  const isAtTerminal = nearTerminalPt || nearStopBranchOrigin || nearOppBranchTerminal;

  const mapStopsInRange = (branch, fromAlong, toAlong, offsetMeters) => {
    const out = [];
    for (const sa of branch?.stopAlongs || []) {
      if (sa > fromAlong + 15 && sa < toAlong - 15) {
        out.push(offsetMeters + (sa - fromAlong));
      }
    }
    return out;
  };

  if (leg === 'full_cycle' && busOnStop) {
    const stopRemainder = slicePolyline(stopBranch.pts, busOnStop, null);
    const retFull = returnBranch ? returnBranch.pts.slice() : [];
    const stopStartProj = { segIdx: 0, t: 0, lat: stopBranch.pts[0][0], lng: stopBranch.pts[0][1] };
    const stopApproach = slicePolyline(stopBranch.pts, stopStartProj, stopProj);

    const pathPts = [...stopRemainder, ...retFull, ...stopApproach];
    const cum = buildCumDist(pathPts);
    const totalMeters = cum[cum.length - 1] || 0;
    const oppStartMeters = cum[stopRemainder.length] ?? (cum[Math.max(0, stopRemainder.length - 1)] || 0);
    const turnaroundAtMeters = cum[stopRemainder.length + retFull.length] ?? oppStartMeters;

    const stopAlongs = [
      ...mapStopsInRange(stopBranch, busOnStop.along, stopBranch.totalLen, 0),
      ...(returnBranch ? mapStopsInRange(returnBranch, 0, returnBranch.totalLen, oppStartMeters) : []),
      ...mapStopsInRange(stopBranch, 0, stopProj.along, turnaroundAtMeters)
    ].sort((a, b) => a - b);

    const segments = [
      { pts: stopRemainder, color: stopColor, bandera: stopBandera, startMeters: 0, endMeters: oppStartMeters }
    ];
    if (returnBranch && retFull.length >= 2) {
      segments.push({
        pts: retFull,
        color: returnBranch.color,
        bandera: returnBranch.bandera || 'Sentido opuesto',
        startMeters: oppStartMeters,
        endMeters: turnaroundAtMeters
      });
    }
    segments.push({
      pts: stopApproach,
      color: stopColor,
      bandera: stopBandera,
      startMeters: turnaroundAtMeters,
      endMeters: totalMeters
    });

    return {
      leg: 'full_cycle',
      isOppositeLeg: false,
      isNextCycle: true,
      isAtTerminal,
      confirmedBranch,
      confirmedDirectionBandera: confirmedBranch?.bandera || '',
      directionConfidence,
      directionSource,
      realBandera: stopBandera,
      realBanderaColor: stopColor,
      segments,
      stopAlongs,
      oppStartMeters,
      turnaroundAtMeters,
      pathPts,
      pathCum: cum,
      totalMeters,
      walkedMeters: 0,
      speedMps: Math.max(2.2, Math.min(24.0, totalMeters / etaSec))
    };
  }

  if (leg === 'previous_leg' && oppositeBranch && busOnOpp) {
    const oppRemainder = slicePolyline(oppositeBranch.pts, busOnOpp, null);
    const stopStartProj = { segIdx: 0, t: 0, lat: stopBranch.pts[0][0], lng: stopBranch.pts[0][1] };
    const stopApproach = slicePolyline(stopBranch.pts, stopStartProj, stopProj);
    const pathPts = [...oppRemainder, ...stopApproach];
    const oppBandera = oppositeBranch.bandera || 'Sentido opuesto';
    const oppColor = oppositeBranch.color;
    const cum = buildCumDist(pathPts);
    const totalMeters = cum[cum.length - 1] || 0;
    const turnaroundAtMeters = cum[oppRemainder.length] ?? (cum[Math.max(0, oppRemainder.length - 1)] || 0);

    const stopAlongs = [
      ...mapStopsInRange(oppositeBranch, busOnOpp.along, oppositeBranch.totalLen, 0),
      ...mapStopsInRange(stopBranch, 0, stopProj.along, turnaroundAtMeters)
    ].sort((a, b) => a - b);

    const segments = [
      { pts: oppRemainder, color: oppColor, bandera: oppBandera, startMeters: 0, endMeters: turnaroundAtMeters },
      { pts: stopApproach, color: stopColor, bandera: stopBandera, startMeters: turnaroundAtMeters, endMeters: totalMeters }
    ];

    return {
      leg: 'previous_leg',
      isOppositeLeg: true,
      isNextCycle: false,
      isAtTerminal,
      confirmedBranch,
      confirmedDirectionBandera: confirmedBranch?.bandera || '',
      directionConfidence,
      directionSource,
      realBandera: oppBandera,
      realBanderaColor: oppColor,
      segments,
      stopAlongs,
      oppStartMeters: 0,
      turnaroundAtMeters,
      pathPts,
      pathCum: cum,
      totalMeters,
      walkedMeters: 0,
      speedMps: Math.max(2.2, Math.min(24.0, totalMeters / etaSec))
    };
  }

  // Direct approach along stopBranch
  const pathPts =
    directDist < Infinity
      ? slicePolyline(stopBranch.pts, busOnStop, stopProj)
      : [
          [bus.lat, bus.lng],
          [stopCoords.lat, stopCoords.lng]
        ];
  const cum = buildCumDist(pathPts);
  const totalMeters = cum[cum.length - 1] || 0;
  const stopAlongs =
    directDist < Infinity ? mapStopsInRange(stopBranch, busOnStop.along, stopProj.along, 0) : [];

  return {
    leg: 'direct',
    isOppositeLeg: false,
    isNextCycle: false,
    isAtTerminal,
    confirmedBranch,
    confirmedDirectionBandera: confirmedBranch?.bandera || '',
    directionConfidence,
    directionSource,
    realBandera: stopBandera,
    realBanderaColor: stopColor,
    segments: [{ pts: pathPts, color: stopColor, bandera: stopBandera, startMeters: 0, endMeters: totalMeters }],
    stopAlongs,
    oppStartMeters: 0,
    turnaroundAtMeters: 0,
    pathPts,
    pathCum: cum,
    totalMeters,
    walkedMeters: 0,
    speedMps: Math.max(2.2, Math.min(24.0, totalMeters / etaSec))
  };
}

function projectOnPolylineWindow(pts, cum, lat, lng, minAlong, maxAlong, preferAlong) {
  const cosLat = Math.cos((lat * Math.PI) / 180);
  const scaleLng = METERS_PER_DEG_LNG_EQ * cosLat;
  let best = null;
  let bestScore = Infinity;

  for (let i = 0, n = pts.length - 1; i < n; i++) {
    const segStartAlong = cum[i] || 0;
    const segEndAlong = cum[i + 1] || 0;
    if (segEndAlong < minAlong || segStartAlong > maxAlong) continue;
    const aLat = pts[i][0];
    const aLng = pts[i][1];
    const bLat = pts[i + 1][0];
    const bLng = pts[i + 1][1];
    const dyM = (bLat - aLat) * METERS_PER_DEG_LAT;
    const dxM = (bLng - aLng) * scaleLng;
    const lenSq = dxM * dxM + dyM * dyM;
    const pyM = (lat - aLat) * METERS_PER_DEG_LAT;
    const pxM = (lng - aLng) * scaleLng;
    const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, (pxM * dxM + pyM * dyM) / lenSq));
    const along = segStartAlong + (segEndAlong - segStartAlong) * t;
    if (along < minAlong || along > maxAlong) continue;
    const rdx = pxM - dxM * t;
    const rdy = pyM - dyM * t;
    const perp = Math.sqrt(rdx * rdx + rdy * rdy);
    // Strong preference for forward position matching expected lag prevents snapping onto overlapping return lanes
    const score = perp + (Number.isFinite(preferAlong) ? Math.abs(along - preferAlong) * 0.18 : 0);
    if (score < bestScore) {
      bestScore = score;
      best = {
        segIdx: i,
        t,
        lat: aLat + (bLat - aLat) * t,
        lng: aLng + (bLng - aLng) * t,
        along,
        perp
      };
    }
  }
  return best;
}

/**
 * Splices the exact street polyline segment from the previous simulated position (`prevTraj` at `fromMeters`)
 * to the start of `newTraj`, shifting all cumulative distances and segment offsets seamlessly.
 */
export function prependPathToTrajectory(prevTraj, fromMeters, newTraj) {
  if (!prevTraj || !newTraj || !prevTraj.pathPts?.length || !newTraj.pathPts?.length) {
    return newTraj;
  }

  const startSample = sampleTrajectory(prevTraj, fromMeters);
  if (!startSample) return newTraj;

  const targetStart = newTraj.pathPts[0];
  const expectedAlong = Math.max(fromMeters, prevTraj.totalMeters - newTraj.totalMeters);
  const windowPad = Math.max(220, (expectedAlong - fromMeters) * 0.45);
  const windowedProj = projectOnPolylineWindow(
    prevTraj.pathPts,
    prevTraj.pathCum,
    targetStart[0],
    targetStart[1],
    Math.max(0, fromMeters - 15),
    expectedAlong + windowPad,
    expectedAlong
  );
  const endProj =
    windowedProj && windowedProj.perp <= 140
      ? windowedProj
      : projectOnPolyline(prevTraj.pathPts, prevTraj.pathCum, targetStart[0], targetStart[1], Math.max(0, fromMeters - 15));

  const prefixPts = [[startSample.lat, startSample.lng]];
  if (endProj && endProj.along > fromMeters + 3) {
    for (let i = 0; i < prevTraj.pathPts.length; i++) {
      const m = prevTraj.pathCum[i];
      if (m > fromMeters + 2 && m < endProj.along - 2) {
        prefixPts.push(prevTraj.pathPts[i]);
      }
    }
  }

  const mergedPts = [...prefixPts, ...newTraj.pathPts];
  const mergedCum = buildCumDist(mergedPts);
  const totalMeters = mergedCum[mergedCum.length - 1] || newTraj.totalMeters;
  const addedMeters = Math.max(0, totalMeters - newTraj.totalMeters);

  const firstNewSeg = newTraj.segments?.[0];
  const crossesDirection =
    Boolean(
      firstNewSeg &&
        startSample.currentBandera &&
        firstNewSeg.bandera &&
        startSample.currentBandera !== firstNewSeg.bandera &&
        addedMeters > 8
    );

  const shiftedSegments = crossesDirection
    ? [
        {
          pts: [...prefixPts, newTraj.pathPts[0]],
          color: startSample.currentBranchColor || firstNewSeg.color,
          bandera: startSample.currentBandera,
          startMeters: 0,
          endMeters: addedMeters
        },
        ...(newTraj.segments || []).map((s) => ({
          ...s,
          startMeters: s.startMeters + addedMeters,
          endMeters: s.endMeters + addedMeters
        }))
      ]
    : (newTraj.segments || []).map((s, idx) =>
        idx === 0
          ? { ...s, pts: [...prefixPts, ...s.pts], startMeters: 0, endMeters: s.endMeters + addedMeters }
          : { ...s, startMeters: s.startMeters + addedMeters, endMeters: s.endMeters + addedMeters }
      );

  const oppStartMeters = newTraj.oppStartMeters ? newTraj.oppStartMeters + addedMeters : 0;
  const turnaroundAtMeters = newTraj.turnaroundAtMeters
    ? newTraj.turnaroundAtMeters + addedMeters
    : crossesDirection && prevTraj.leg === 'previous_leg' && newTraj.leg === 'direct'
      ? addedMeters
      : 0;

  return {
    ...newTraj,
    isOppositeLeg: newTraj.isOppositeLeg || (crossesDirection && prevTraj.leg === 'previous_leg'),
    pathPts: mergedPts,
    pathCum: mergedCum,
    totalMeters,
    segments: shiftedSegments,
    stopAlongs: (newTraj.stopAlongs || []).map((sa) => sa + addedMeters),
    oppStartMeters,
    turnaroundAtMeters,
    walkedMeters: 0
  };
}

export function sampleTrajectory(traj, walkedMeters) {
  const { pathPts, pathCum, totalMeters, segments = [] } = traj;
  if (!pathPts || pathPts.length === 0) return null;

  const lastSeg = segments[segments.length - 1] || { bandera: traj.realBandera, color: traj.realBanderaColor };
  if (walkedMeters >= totalMeters || pathPts.length === 1) {
    const last = pathPts[pathPts.length - 1];
    return {
      lat: last[0],
      lng: last[1],
      remainingMeters: 0,
      arrived: true,
      inOppositeLeg: false,
      inNextCycle: false,
      currentBandera: lastSeg.bandera,
      currentBranchColor: lastSeg.color
    };
  }

  const clamped = Math.max(0, walkedMeters);
  const i = findCumSegment(pathCum, clamped);
  const segStart = pathCum[i];
  const segLen = Math.max(0.001, pathCum[i + 1] - segStart);
  const frac = Math.max(0, Math.min(1, (clamped - segStart) / segLen));
  const lat = pathPts[i][0] + (pathPts[i + 1][0] - pathPts[i][0]) * frac;
  const lng = pathPts[i][1] + (pathPts[i + 1][1] - pathPts[i][1]) * frac;

  let activeSeg = segments[0] || lastSeg;
  for (let s = 0; s < segments.length; s++) {
    if (clamped >= segments[s].startMeters && clamped <= segments[s].endMeters) {
      activeSeg = segments[s];
      break;
    }
  }

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
    inNextCycle,
    currentBandera: activeSeg.bandera,
    currentBranchColor: activeSeg.color
  };
}
