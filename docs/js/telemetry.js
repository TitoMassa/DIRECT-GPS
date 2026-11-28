import { distanceMeters, parseDesvioHorario } from './api.js';
import { projectOnPolyline } from './trajectory.js';
import { formatSecHHMM, getArgentinaSecOfDay, parseGpsStampSecOfDay } from './predictor.js';

const INTERPROVINCIAL_CODES = new Set([852, 1037, 1038, 1039]); // 902, 904A, 904B, 904C

// Bounding box del corredor Puente General Belgrano + accesos RN16 (Av. 3 de Abril <-> Rotonda Barranqueras)
const BRIDGE_CORRIDOR_BOUNDS = {
  minLat: -27.479,
  maxLat: -27.436,
  minLng: -58.902,
  maxLng: -58.842
};

/**
 * Monitor en vivo del Puente General Belgrano (Corrientes <-> Resistencia)
 * calculado a partir de los coches activos de las líneas 904A/B/C y 902.
 */
export function computeBridgeStatus(buses = []) {
  const inter = [];
  const onBridge = [];
  const delaysMin = [];

  for (const b of buses || []) {
    const cod = Number(b.codigoLinea);
    if (!INTERPROVINCIAL_CODES.has(cod)) continue;
    inter.push(b);

    const lat = Number(b.lat ?? b.lastLat);
    const lng = Number(b.lng ?? b.lastLng);
    const inCorridor =
      Number.isFinite(lat) &&
      Number.isFinite(lng) &&
      lat >= BRIDGE_CORRIDOR_BOUNDS.minLat &&
      lat <= BRIDGE_CORRIDOR_BOUNDS.maxLat &&
      lng >= BRIDGE_CORRIDOR_BOUNDS.minLng &&
      lng <= BRIDGE_CORRIDOR_BOUNDS.maxLng;
    if (inCorridor) onBridge.push(b);

    const sec =
      typeof b.desvio?.seconds === 'number'
        ? b.desvio.seconds
        : typeof b.desvioSec === 'number'
          ? b.desvioSec
          : typeof b.lastDesvioSec === 'number'
            ? b.lastDesvioSec
            : null;
    if (sec !== null && Math.abs(sec) <= 90 * 60 && sec < 0) {
      delaysMin.push(Math.abs(sec) / 60);
    } else if (sec !== null && Math.abs(sec) <= 90 * 60) {
      delaysMin.push(0);
    }
  }

  if (inter.length === 0) {
    return {
      available: false,
      status: 'unknown',
      label: 'Sin datos en puente',
      activeCount: 0,
      onBridgeCount: 0,
      avgDelayMin: 0
    };
  }

  const avgDelayMin =
    delaysMin.length > 0 ? Math.round(delaysMin.reduce((a, v) => a + v, 0) / delaysMin.length) : 0;

  let status = 'ok';
  let label = 'Fluido';
  if (avgDelayMin >= 15) {
    status = 'heavy';
    label = 'Congestionado';
  } else if (avgDelayMin >= 7) {
    status = 'slow';
    label = 'Lento';
  }

  return {
    available: true,
    status,
    label,
    activeCount: inter.length,
    onBridgeCount: onBridge.length,
    avgDelayMin
  };
}

/**
 * Detector de "tren de colectivos" (bus bunching: 2+ unidades de la misma línea con <= 2 min
 * de diferencia) y huecos de frecuencia (>= 18 min después).
 */
export function detectBunchingAndGaps(arribos = []) {
  const byLine = new Map();
  for (const b of arribos || []) {
    if (!b || b.isNextLap || !b.eta?.valid || typeof b.eta.minutes !== 'number') continue;
    const key = b.descripcionLinea || String(b.codigoLinea);
    if (!byLine.has(key)) byLine.set(key, []);
    byLine.get(key).push(b);
  }

  const alerts = [];
  for (const [lineName, list] of byLine.entries()) {
    const sorted = [...list].sort((a, b) => a.eta.minutes - b.eta.minutes);
    if (sorted.length < 2) continue;

    // Group bunched buses at the head (<= 2 min between consecutive buses)
    let bunchEnd = 0;
    while (
      bunchEnd + 1 < sorted.length &&
      sorted[bunchEnd + 1].eta.minutes - sorted[bunchEnd].eta.minutes <= 2
    ) {
      bunchEnd++;
    }

    if (bunchEnd >= 1) {
      const count = bunchEnd + 1;
      const nextAfter = sorted[bunchEnd + 1] || null;
      const gapMin = nextAfter ? Math.round(nextAfter.eta.minutes - sorted[bunchEnd].eta.minutes) : null;
      alerts.push({
        kind: 'bunching',
        lineName,
        count,
        firstEtaMin: Math.round(sorted[0].eta.minutes),
        gapMin: gapMin !== null && gapMin >= 16 ? gapMin : null,
        message:
          gapMin !== null && gapMin >= 16
            ? `Línea ${lineName}: vienen ${count} coches pegados (${Math.round(sorted[0].eta.minutes)} min) y luego ${gapMin} min de hueco.`
            : `Línea ${lineName}: vienen ${count} coches juntos en ~${Math.round(sorted[0].eta.minutes)} min.`
      });
    } else if (sorted.length >= 2) {
      const gap = Math.round(sorted[1].eta.minutes - sorted[0].eta.minutes);
      if (gap >= 25 && sorted[0].eta.minutes <= 8) {
        alerts.push({
          kind: 'gap',
          lineName,
          count: 1,
          firstEtaMin: Math.round(sorted[0].eta.minutes),
          gapMin: gap,
          message: `Línea ${lineName}: si perdés el próximo (${Math.round(sorted[0].eta.minutes)} min), el siguiente viene en ${gap} min.`
        });
      }
    }
  }

  return alerts;
}

/**
 * Termómetro de puntualidad global y por línea a partir de los desvíos reales en vivo.
 */
export function computeNetworkPunctuality(buses = []) {
  let totalWithDesvio = 0;
  let onTime = 0;
  let late = 0;
  let ahead = 0;
  let delaySumSec = 0;
  const byLine = new Map();

  for (const b of buses || []) {
    const cod = Number(b.codigoLinea);
    const dObj =
      b.desvio && b.desvio.status && b.desvio.status !== 'none'
        ? b.desvio
        : b.desvioRaw || b.lastDesvioRaw
          ? parseDesvioHorario(b.desvioRaw || b.lastDesvioRaw)
          : null;
    if (!dObj || dObj.status === 'none' || typeof dObj.seconds !== 'number') continue;
    if (Math.abs(dObj.seconds) > 95 * 60) continue;

    totalWithDesvio++;
    const isLate = dObj.seconds <= -4 * 60;
    const isAhead = dObj.seconds >= 3 * 60;
    if (isLate) {
      late++;
      delaySumSec += Math.abs(dObj.seconds);
    } else if (isAhead) {
      ahead++;
    } else {
      onTime++;
    }

    if (cod) {
      if (!byLine.has(cod)) {
        byLine.set(cod, { total: 0, onTime: 0, late: 0, ahead: 0, delaySumSec: 0 });
      }
      const st = byLine.get(cod);
      st.total++;
      if (isLate) {
        st.late++;
        st.delaySumSec += Math.abs(dObj.seconds);
      } else if (isAhead) {
        st.ahead++;
      } else {
        st.onTime++;
      }
    }
  }

  const perLine = new Map();
  for (const [cod, st] of byLine.entries()) {
    const onTimePct = st.total > 0 ? Math.round((st.onTime / st.total) * 100) : 100;
    const avgLateMin = st.late > 0 ? Math.round(st.delaySumSec / st.late / 60) : 0;
    const status = avgLateMin >= 12 || onTimePct < 45 ? 'late' : avgLateMin >= 6 || onTimePct < 70 ? 'warn' : 'ok';
    perLine.set(cod, { ...st, onTimePct, avgLateMin, status });
  }

  const onTimePct = totalWithDesvio > 0 ? Math.round((onTime / totalWithDesvio) * 100) : 100;
  const avgLateMin = late > 0 ? Math.round(delaySumSec / late / 60) : 0;
  return {
    totalWithDesvio,
    onTime,
    late,
    ahead,
    onTimePct,
    avgLateMin,
    perLine
  };
}

/**
 * Clasifica si una unidad activa está realizando su última vuelta antes de finalizar servicio
 * o antes de cortar (horario cortado), para mostrar píldoras informativas en Modo Libre / Inspector.
 */
export function classifyBusEndingBadge(bus, model = null) {
  const trip = bus?._matchedTrip || bus?.scheduledTrip || null;
  if (!trip) return null;
  if (trip.nextTrip) return null;

  const bi = trip.blockInfo || (trip.blockId && model?.blockInfoById ? model.blockInfoById.get(trip.blockId) : null);
  if (bi?.relevoToNext) return null;

  // Check if the same service has a later block after a cortado break
  if (bi && model?.blocks) {
    const laterSameSrv = model.blocks.find(
      (b) => b.serviceNumber === bi.serviceNumber && b.startSec > bi.endSec + 30 * 60
    );
    if (laterSameSrv) {
      return {
        kind: 'cortado',
        label: 'Corta al llegar',
        detail: bi.endPlace ? `Corta en ${bi.endPlace}` : 'Entra en corte al finalizar vuelta'
      };
    }
  }

  return {
    kind: 'ending',
    label: 'Última vuelta',
    detail: bi?.endPlace ? `Finaliza servicio en ${bi.endPlace}` : 'Finaliza servicio al llegar a cabecera'
  };
}

/**
 * Evalúa con coherencia entre horario programado de fin de servicio/turno, desvío real,
 * última marca GPS, distancia a la punta de línea y hora actual si un coche o chofer
 * YA FINALIZÓ su servicio/turno (evitando que figure "En línea" o siga simulando movimiento).
 */
export function evaluateServiceCompletionStatus(
  unit,
  model = null,
  nowSec = getArgentinaSecOfDay(),
  { entityType = 'coche', srvMeta = null, blockInfo = null, nowMs = Date.now() } = {}
) {
  const NOT_FINISHED = { finished: false, snapToTerminal: false };
  if (!unit) return NOT_FINISHED;

  // 1) Resolve blockInfo (service/turno block)
  let bi =
    blockInfo ||
    srvMeta?.blockInfo ||
    srvMeta?.trip?.blockInfo ||
    unit._matchedTrip?.blockInfo ||
    unit.scheduledTrip?.blockInfo ||
    null;

  if (!bi && model?.blocks?.length) {
    const bid = srvMeta?.blockId || unit._matchedTrip?.blockId || unit.scheduledTrip?.blockId || '';
    if (bid && model.blockInfoById?.has(bid)) {
      bi = model.blockInfoById.get(bid);
    } else {
      const sNum = Number(srvMeta?.serviceNumber ?? unit.serviceNumber);
      const tIdx = Number(srvMeta?.turnoIndex ?? unit.turnoIndex ?? 1);
      if (sNum > 0) {
        bi =
          model.blocks.find((b) => b.serviceNumber === sNum && b.turnoIndex === tIdx) ||
          model.blocks.find((b) => b.serviceNumber === sNum) ||
          null;
      }
    }
  }

  let isRelevoToNext = Boolean(bi?.relevoToNext ?? srvMeta?.relevoToNext ?? unit.relevoToNext);

  // On a relevo-en-linea block, the CAR continues with the relieving driver into the next chained turno.
  // Follow the continuous relevo chain to find where the CAR itself finishes its service/cortado!
  if (entityType === 'coche' && isRelevoToNext) {
    let chainedEndBi = null;
    if (bi && Array.isArray(model?.blocks) && bi.serviceNumber) {
      const sameSrv = model.blocks
        .filter((b) => b.serviceNumber === bi.serviceNumber && b.startSec >= bi.startSec)
        .sort((a, b) => a.startSec - b.startSec);
      const startIdx = sameSrv.findIndex((b) => b.blockId === bi.blockId || b.turnoIndex === bi.turnoIndex);
      if (startIdx >= 0) {
        let cur = sameSrv[startIdx];
        for (let i = startIdx + 1; i < sameSrv.length; i++) {
          const nxt = sameSrv[i];
          const gapSec = nxt.startSec - cur.endSec;
          if (!cur.relevoToNext || gapSec > 55 * 60) break;
          cur = nxt;
          if (!cur.relevoToNext) {
            chainedEndBi = cur;
            break;
          }
        }
      }
    }
    if (!chainedEndBi) {
      return NOT_FINISHED;
    }
    bi = chainedEndBi;
    isRelevoToNext = false;
  }

  const schedEndSec =
    typeof bi?.endSec === 'number'
      ? bi.endSec
      : typeof srvMeta?.endSec === 'number'
        ? srvMeta.endSec
        : typeof unit.turnoEndSec === 'number'
          ? unit.turnoEndSec
          : null;

  if (schedEndSec === null || !Number.isFinite(schedEndSec)) return NOT_FINISHED;

  const isCortadoBreak = Boolean(
    !isRelevoToNext &&
      bi &&
      model?.blocks?.some((b) => b.serviceNumber === bi.serviceNumber && b.startSec > bi.endSec + 30 * 60)
  );

  // 2) Resolve final trip of the block and exact terminal (punta de línea) coordinates
  const lastTrip =
    (Array.isArray(bi?.trips) && bi.trips.length > 0 ? bi.trips[bi.trips.length - 1] : null) ||
    srvMeta?.trip ||
    unit._matchedTrip ||
    unit.scheduledTrip ||
    null;
  const endBranch = lastTrip?.branch || null;
  let terminalLat = null;
  let terminalLng = null;
  let lastStopName = '';
  if (endBranch) {
    const stops = Array.isArray(endBranch.orderedStops) ? endBranch.orderedStops : [];
    const lastStop = stops.length > 0 ? stops[stops.length - 1] : null;
    if (lastStop) {
      lastStopName = lastStop.nombre || lastStop.descripcion || '';
    }
    // La punta de línea es SIEMPRE el extremo final del trazado (polilínea) de la bandera donde finaliza el turno,
    // NO la última parada etiquetada (que en muchas líneas queda varios cientos de metros o >1 km antes de la cabecera real).
    if (Array.isArray(endBranch.pts) && endBranch.pts.length > 0) {
      const pt = endBranch.pts[endBranch.pts.length - 1];
      if (Number.isFinite(Number(pt?.[0])) && Number.isFinite(Number(pt?.[1]))) {
        terminalLat = Number(pt[0]);
        terminalLng = Number(pt[1]);
      }
    }
    if (
      (terminalLat === null || terminalLng === null) &&
      lastStop &&
      Number.isFinite(Number(lastStop.lat)) &&
      Number.isFinite(Number(lastStop.lng))
    ) {
      terminalLat = Number(lastStop.lat);
      terminalLng = Number(lastStop.lng);
    }
  }
  const endPlace = bi?.endPlace || srvMeta?.endPlace || unit.endPlace || lastStopName || '';

  // 3) Compute delay-adjusted real expected finish time & GPS age
  const effNow = nowSec < 3 * 3600 ? nowSec + 86400 : nowSec;
  let rawDesvioSec = null;
  if (typeof unit.desvio?.seconds === 'number' && unit.desvio?.status !== 'none') {
    rawDesvioSec = unit.desvio.seconds;
  } else if (typeof unit.desvioSec === 'number') {
    rawDesvioSec = unit.desvioSec;
  } else if (typeof unit.lastDesvioSec === 'number') {
    rawDesvioSec = unit.lastDesvioSec;
  } else if (unit.desvioRaw || unit.lastDesvioRaw) {
    const p = parseDesvioHorario(unit.desvioRaw || unit.lastDesvioRaw);
    if (p && p.status !== 'none' && typeof p.seconds === 'number') rawDesvioSec = p.seconds;
  }
  const clampedDesvio =
    rawDesvioSec !== null && Number.isFinite(rawDesvioSec) && Math.abs(rawDesvioSec) <= 95 * 60
      ? Math.max(-75 * 60, Math.min(4 * 60, rawDesvioSec))
      : 0;
  // Negative desvio = late (atrasado), so expectedEndSec shifts LATER by |desvio|
  const expectedEndSec = schedEndSec - clampedDesvio;

  const rawGpsStr = unit.ultimaFechaHoraGPS || unit.lastGps || '';
  const parsedGpsSec = parseGpsStampSecOfDay(rawGpsStr);
  const lastGpsSec = parsedGpsSec !== null ? (parsedGpsSec < 3 * 3600 ? parsedGpsSec + 86400 : parsedGpsSec) : null;
  let gpsAgeSec = null;
  if (lastGpsSec !== null) {
    gpsAgeSec = Math.max(0, effNow - lastGpsSec);
  } else if (typeof unit.lastSeenAt === 'number' && unit.lastSeenAt > 0) {
    gpsAgeSec = Math.max(0, (nowMs - unit.lastSeenAt) / 1000);
  }

  // 4) Measure distance from last real GPS to the end terminal (punta de línea)
  const lat = Number(unit.rawLat ?? unit.lat ?? unit.lastLat);
  const lng = Number(unit.rawLng ?? unit.lng ?? unit.lastLng);
  let distToEndM = null;
  let remAlongM = null;
  if (Number.isFinite(lat) && Number.isFinite(lng) && Number.isFinite(terminalLat) && Number.isFinite(terminalLng)) {
    distToEndM = distanceMeters(lat, lng, terminalLat, terminalLng);
    if (endBranch && Array.isArray(endBranch.pts) && endBranch.pts.length >= 2) {
      const proj = projectOnPolyline(endBranch.pts, endBranch.cum, lat, lng);
      if (proj && proj.perp <= 380) {
        remAlongM = Math.max(0, (endBranch.totalLen || 0) - proj.along);
      }
    }
  }
  const remDistM = remAlongM !== null ? remAlongM : distToEndM;
  const estRemTravelSec = remDistM !== null ? Math.round(remDistM / 4.4) : 0;
  const etaTerminalFromLastGps = lastGpsSec !== null ? lastGpsSec + estRemTravelSec : expectedEndSec;

  // Guard: If GPS is actively reporting RIGHT NOW (< 75 s old) AND bus is still > 850 m away from terminal,
  // it is genuinely still circulating (e.g. heavily delayed or assigned an extra stretch).
  if (gpsAgeSec !== null && gpsAgeSec <= 75 && distToEndM !== null && distToEndM > 850 && effNow < expectedEndSec + 10 * 60) {
    return NOT_FINISHED;
  }

  // Condition A: Bus already reached/approached the end terminal right around or after end-of-shift
  const atTerminalAroundEnd =
    ((distToEndM !== null && distToEndM <= 500) || (remAlongM !== null && remAlongM <= 550)) &&
    effNow >= Math.min(schedEndSec, expectedEndSec) - 3 * 60 &&
    (effNow >= expectedEndSec || gpsAgeSec === null || gpsAgeSec >= 75);

  // Condition B: Past delay-adjusted end time, GPS has stopped updating, and enough time passed to reach terminal
  const pastExpectedAndReachable =
    effNow >= expectedEndSec + 75 &&
    (gpsAgeSec === null || gpsAgeSec >= 75) &&
    (remDistM === null || effNow >= etaTerminalFromLastGps + 45);

  // Condition C: Well past expected end (>= 20 min) with stale GPS (>= 3 min)
  const wellPastExpectedEnd =
    effNow >= expectedEndSec + 20 * 60 && (gpsAgeSec === null || gpsAgeSec >= 180);

  // Condition D (strict 3-min no-GPS end-of-service/turno rule, NOT relevo):
  // Once the scheduled finish time has arrived (`effNow >= schedEndSec`) and GPS has been silent >= 3 min
  // (`gpsAgeSec === null || gpsAgeSec >= 180`), treat the unit as finished at its ending punta de línea
  // regardless of where along the route its last GPS fix was seen!
  const pastScheduledEndNoGps3Min =
    !isRelevoToNext &&
    effNow >= schedEndSec &&
    (gpsAgeSec === null || gpsAgeSec >= 180);

  if (!atTerminalAroundEnd && !pastExpectedAndReachable && !wellPastExpectedEnd && !pastScheduledEndNoGps3Min) {
    return NOT_FINISHED;
  }

  const reason = isRelevoToNext ? 'turno_ended' : isCortadoBreak ? 'cortado_ended' : 'service_ended';
  const label = isRelevoToNext
    ? 'Turno finalizado'
    : isCortadoBreak
      ? 'En corte'
      : 'Servicio finalizado';

  // Para fin de servicio o corte (NO relevo): siempre mostrar como última ubicación la punta de línea
  // donde finaliza el colectivo, sin importar en qué punto del recorrido fue su último reporte GPS.
  const snapToTerminal = Boolean(
    Number.isFinite(terminalLat) &&
      Number.isFinite(terminalLng) &&
      (!isRelevoToNext || remDistM === null || remDistM <= 1500)
  );

  const displayEndSec = pastScheduledEndNoGps3Min && effNow < expectedEndSec ? schedEndSec : expectedEndSec;

  return {
    finished: true,
    reason,
    label,
    endPlace,
    scheduledEndHHMM: formatSecHHMM(schedEndSec),
    expectedEndHHMM: formatSecHHMM(displayEndSec),
    snapToTerminal,
    terminalLat,
    terminalLng
  };
}

/**
 * Calcula velocidad estimada (km/h) y estado físico del colectivo seleccionado.
 */
export function computeBusPhysicalTelemetry(bus, gpsHist = null, simState = null) {
  if (bus?.serviceFinished) {
    const placeSuffix = bus.finishedPlace ? ` · ${bus.finishedPlace}` : '';
    return {
      speedKmh: null,
      stateKind: 'finished',
      stateLabel: `${bus.finishedLabel || 'Servicio finalizado'}${placeSuffix}`
    };
  }
  if (bus?.isFreeTracked && bus?.enLineaAhora === false) {
    return {
      speedKmh: null,
      stateKind: 'offline',
      stateLabel: 'Fuera de línea · Última ubicación'
    };
  }

  let speedMps = null;
  if (typeof simState?.speedMps === 'number' && Number.isFinite(simState.speedMps)) {
    speedMps = simState.speedMps;
  } else if (Array.isArray(gpsHist?.trail) && gpsHist.trail.length >= 2) {
    const a = gpsHist.trail[gpsHist.trail.length - 2];
    const b = gpsHist.trail[gpsHist.trail.length - 1];
    const dt = ((b.gpsMs || b.ts || 0) - (a.gpsMs || a.ts || 0)) / 1000;
    const d = distanceMeters(a.lat, a.lng, b.lat, b.lng);
    if (dt >= 5 && dt <= 240 && d !== null) {
      speedMps = d / dt;
    }
  } else if (typeof bus?.trajectory?.speedMps === 'number' && Number.isFinite(bus.trajectory.speedMps)) {
    speedMps = bus.trajectory.speedMps;
  }

  const speedKmh = speedMps !== null ? Math.max(0, Math.min(78, Math.round(speedMps * 3.6))) : null;
  const isAtTerminal = Boolean(bus?.trajectory?.isAtTerminal || simState?.isAtTerminal);
  const isStopped = Boolean(simState?.isStopped || (speedKmh !== null && speedKmh <= 2));

  let stateKind = 'moving';
  let stateLabel = speedKmh !== null ? `En marcha · ${speedKmh} km/h` : 'En marcha';
  if (isAtTerminal) {
    stateKind = 'terminal';
    stateLabel = 'En cabecera esperando salida';
  } else if (isStopped) {
    stateKind = 'stopped';
    stateLabel = 'Detenido en tráfico / parada';
  } else if (speedKmh !== null && speedKmh < 12) {
    stateKind = 'slow';
    stateLabel = `Tránsito lento · ${speedKmh} km/h`;
  }

  return { speedKmh, stateKind, stateLabel };
}

/**
 * Encuentra la parada equivalente en la mano de enfrente (ramal opuesto) para el botón `⇄`.
 */
export function findOppositeStop(activeStop, catalogo, routeBranchesCache) {
  if (!activeStop || !Number.isFinite(activeStop.lat) || !Number.isFinite(activeStop.lng)) return null;
  const stopId = String(activeStop.id || '').toUpperCase();

  // Gather all lines serving activeStop
  const catStop = catalogo?.stopById?.get(stopId) || null;
  const lineCodes = Array.isArray(catStop?.lineas) ? catStop.lineas : [];

  let best = null;
  const considerStop = (candStop, sameLineBoost) => {
    const cid = String(candStop.id || '').toUpperCase();
    if (!cid || cid === stopId) return;
    const d = distanceMeters(activeStop.lat, activeStop.lng, candStop.lat, candStop.lng);
    if (d === null || d < 12 || d > 520) return;
    const score = d - (sameLineBoost ? 140 : 0);
    if (!best || score < best.score) {
      best = {
        id: cid,
        nombre: candStop.nombre || candStop.descripcion || cid,
        lat: Number(candStop.lat),
        lng: Number(candStop.lng),
        distM: Math.round(d),
        score
      };
    }
  };

  for (const cod of lineCodes) {
    const branches = routeBranchesCache?.get(Number(cod)) || [];
    if (branches.length < 2) continue;
    const stopBranches = branches.filter((b) =>
      (b.orderedStops || []).some((s) => String(s.id || '').toUpperCase() === stopId)
    );
    const oppBranches = branches.filter((b) => !stopBranches.includes(b));
    for (const ob of oppBranches) {
      for (const s of ob.orderedStops || []) {
        considerStop(s, true);
      }
    }
  }

  // Fallback: nearest stop in catalog that shares at least one line but isn't this stop
  if (!best && Array.isArray(catalogo?.paradas)) {
    const lineSet = new Set(lineCodes.map(Number));
    for (const p of catalogo.paradas) {
      if (String(p.id || '').toUpperCase() === stopId) continue;
      if (lineSet.size > 0 && !(p.lineas || []).some((l) => lineSet.has(Number(l)))) continue;
      considerStop(p, false);
    }
  }

  return best;
}

/**
 * Construye el perfil histórico completo de 7 días cruzado en todas las líneas para un Coche o un Chofer
 * fusionando todas las fuentes del offlineBundle (dayObsByDay, dayTripsByDay, coches/choferes) + datos en vivo.
 * Incluye choferes/coches asociados, turnos, servicios, horarios/salidas y última posición GPS (global y diaria).
 */
export function buildEntitySevenDayProfile(type, queryId, offlineBundle, liveBuses = [], lineByCode = null) {
  const normId = String(queryId || '').trim().toUpperCase();
  if (!normId) return null;

  const isCar = type === 'coche';
  const daysMap = new Map(); // dayKey -> Array<entry>
  const linesSet = new Set();
  const companionsMap = new Map(); // key -> { label, count }
  let title = isCar ? `Coche #${normId}` : String(queryId || '').trim();
  let subtitle = '';
  let esAdaptado = false;
  let lastSeenAt = 0;
  let liveNow = null;
  let lastPosition = null;

  const isValidCoord = (la, ln) => {
    const a = Number(la);
    const b = Number(ln);
    return Number.isFinite(a) && Number.isFinite(b) && (Math.abs(a) > 0.01 || Math.abs(b) > 0.01);
  };

  const normName = (s) =>
    String(s || '')
      .trim()
      .replace(/\.+$/, '')
      .toUpperCase();

  const matchesDriver = (leg, nom, dKey = '') => {
    const l = String(leg || '').trim().toUpperCase();
    const n = normName(nom);
    const k = String(dKey || '').trim().toUpperCase();
    const qClean = normId.replace(/^LEG:/, '').replace(/^NAME:/, '');
    return (
      (l && (l === normId || l === qClean)) ||
      (n && (n === normId || n === normName(qClean))) ||
      (k && (k === normId || k === `LEG:${qClean}` || k === `NAME:${normName(qClean)}`))
    );
  };

  const trackCompanion = (label) => {
    if (!label || label.includes('s/d')) return;
    const prev = companionsMap.get(label) || { label, count: 0 };
    prev.count++;
    companionsMap.set(label, prev);
  };

  const considerLastPosition = (cand) => {
    if (!cand) return;
    const ts = Number(cand.lastSeenAt) || 0;
    const hasCoords = isValidCoord(cand.lat, cand.lng);
    if (!lastPosition) {
      if (hasCoords || cand.lastGps || cand.bandera) lastPosition = { ...cand };
      return;
    }
    const prevHasCoords = isValidCoord(lastPosition.lat, lastPosition.lng);
    const prevTs = Number(lastPosition.lastSeenAt) || 0;
    const isNewer = ts > prevTs || (ts === prevTs && hasCoords && !prevHasCoords);
    if (isNewer && (hasCoords || !prevHasCoords)) {
      lastPosition = {
        ...lastPosition,
        ...cand,
        lat: hasCoords ? Number(cand.lat) : lastPosition.lat,
        lng: hasCoords ? Number(cand.lng) : lastPosition.lng,
        serviceNumber: Number(cand.serviceNumber) || (ts === prevTs ? lastPosition.serviceNumber : 0),
        turnoIndex: Number(cand.turnoIndex) || (ts === prevTs ? lastPosition.turnoIndex : 0),
        turnoStart: cand.turnoStart || (ts === prevTs ? lastPosition.turnoStart : ''),
        turnoEnd: cand.turnoEnd || (ts === prevTs ? lastPosition.turnoEnd : '')
      };
    } else if (ts === prevTs || (cand.dayKey && cand.dayKey === lastPosition.dayKey && cand.codigoLinea === lastPosition.codigoLinea)) {
      if (!lastPosition.serviceNumber && cand.serviceNumber) lastPosition.serviceNumber = Number(cand.serviceNumber);
      if (!lastPosition.turnoIndex && cand.turnoIndex) lastPosition.turnoIndex = Number(cand.turnoIndex);
      if (!lastPosition.turnoStart && cand.turnoStart) lastPosition.turnoStart = cand.turnoStart;
      if (!lastPosition.turnoEnd && cand.turnoEnd) lastPosition.turnoEnd = cand.turnoEnd;
      if (!lastPosition.bandera && cand.bandera) lastPosition.bandera = cand.bandera;
      if (!lastPosition.lastGps && cand.lastGps) lastPosition.lastGps = cand.lastGps;
      if (!prevHasCoords && hasCoords) {
        lastPosition.lat = Number(cand.lat);
        lastPosition.lng = Number(cand.lng);
      }
    }
  };

  const extractTripHHMM = (turnoHora, tripKey) => {
    const h = String(turnoHora || '').trim();
    if (/^\d{2}:\d{2}/.test(h)) return h.slice(0, 5);
    const m = String(tripKey || '').match(/@(\d{2}:\d{2})/);
    return m ? m[1] : '';
  };

  const addDayEntry = (dayKey, entry) => {
    if (!dayKey) return;
    if (!daysMap.has(dayKey)) daysMap.set(dayKey, []);
    const list = daysMap.get(dayKey);
    const normComp = String(entry.companion || '').trim();
    const isUnknownComp = !normComp || normComp.includes('s/d');
    const exists = list.find((e) => {
      if (e.codigoLinea !== entry.codigoLinea) return false;
      const sameComp = e.companion === normComp || isUnknownComp || !e.companion || e.companion.includes('s/d');
      if (!sameComp) return false;
      // Merge if same service/turno, or if either entry lacks a serviceNumber yet
      if (e.serviceNumber && entry.serviceNumber && e.serviceNumber !== entry.serviceNumber) return false;
      if (e.turnoIndex && entry.turnoIndex && e.turnoIndex !== entry.turnoIndex) return false;
      return true;
    });

    const incomingTimes = Array.isArray(entry.tripTimes) ? entry.tripTimes.filter(Boolean) : [];
    if (!exists) {
      list.push({
        ...entry,
        tripTimes: Array.from(new Set(incomingTimes)).sort()
      });
    } else {
      if ((exists.companion?.includes('s/d') || !exists.companion) && normComp && !isUnknownComp) {
        exists.companion = normComp;
      }
      if (!exists.coche && entry.coche) exists.coche = entry.coche;
      if (!exists.choferNombre && entry.choferNombre) exists.choferNombre = entry.choferNombre;
      if (!exists.choferLegajo && entry.choferLegajo) exists.choferLegajo = entry.choferLegajo;
      if (entry.esAdaptado) exists.esAdaptado = true;
      if (!exists.serviceNumber && entry.serviceNumber) exists.serviceNumber = Number(entry.serviceNumber);
      if (!exists.turnoIndex && entry.turnoIndex) exists.turnoIndex = Number(entry.turnoIndex);
      if (!exists.turnoStart && entry.turnoStart) exists.turnoStart = entry.turnoStart;
      if (!exists.turnoEnd && entry.turnoEnd) exists.turnoEnd = entry.turnoEnd;
      if (incomingTimes.length > 0) {
        exists.tripTimes = Array.from(new Set([...(exists.tripTimes || []), ...incomingTimes])).sort();
      }
      if ((entry.firstSeenAt || 0) > 0 && (!exists.firstSeenAt || entry.firstSeenAt < exists.firstSeenAt)) {
        exists.firstSeenAt = entry.firstSeenAt;
      }
      const incomingNewer = (entry.lastSeenAt || 0) >= (exists.lastSeenAt || 0);
      if (incomingNewer) {
        if (entry.lastSeenAt) exists.lastSeenAt = entry.lastSeenAt;
        if (entry.bandera) exists.bandera = entry.bandera;
        if (entry.lastGps) exists.lastGps = entry.lastGps;
        if (entry.lastStopId) exists.lastStopId = entry.lastStopId;
        if (entry.desvioRaw) {
          exists.desvioRaw = entry.desvioRaw;
          exists.desvioSec = Number(entry.desvioSec) || 0;
        }
        if (isValidCoord(entry.lat, entry.lng)) {
          exists.lat = Number(entry.lat);
          exists.lng = Number(entry.lng);
        }
      } else {
        if (!exists.bandera && entry.bandera) exists.bandera = entry.bandera;
        if (!exists.lastGps && entry.lastGps) exists.lastGps = entry.lastGps;
        if (!isValidCoord(exists.lat, exists.lng) && isValidCoord(entry.lat, entry.lng)) {
          exists.lat = Number(entry.lat);
          exists.lng = Number(entry.lng);
        }
      }
    }
  };

  // 1) Scan live buses first
  for (const b of liveBuses || []) {
    const carId = String(b.identificadorCoche || b.coche || '').trim().toUpperCase();
    const drvName = String(b.choferNombre || '').trim();
    const drvLeg = String(b.choferLegajo || '').trim().toUpperCase();
    const match = isCar ? carId === normId : matchesDriver(drvLeg, drvName);
    if (!match) continue;
    liveNow = b;
    if (b.esAdaptado) esAdaptado = true;
    if (!isCar && drvName) {
      title = drvName;
      if (drvLeg) subtitle = `Legajo ${drvLeg}`;
    }
    const cod = Number(b.codigoLinea) || 0;
    const lineName = b.descripcionLinea || lineByCode?.get(cod)?.descripcion || `L${cod}`;
    linesSet.add(lineName);
    const liveTs = Number(b.lastSeenAt) || Date.now();
    if (liveTs > lastSeenAt) lastSeenAt = liveTs;
    considerLastPosition({
      codigoLinea: cod,
      lineName,
      coche: carId,
      choferNombre: drvName,
      choferLegajo: drvLeg,
      esAdaptado: Boolean(b.esAdaptado),
      lat: b.rawLat ?? b.lat ?? b.lastLat ?? null,
      lng: b.rawLng ?? b.lng ?? b.lastLng ?? null,
      bandera: b.realBandera || b.descripcionBandera || b.lastBandera || '',
      lastGps: b.ultimaFechaHoraGPS || b.lastGps || '',
      lastStopId: b.lastStopId || '',
      desvioRaw: b.desvio?.raw || b.lastDesvioRaw || '',
      desvioSec: b.desvio?.seconds ?? b.lastDesvioSec ?? 0,
      serviceNumber: Number(b.serviceNumber || b.lastServiceNum) || 0,
      turnoIndex: Number(b.turnoIndex || b.lastTurnoIdx) || 0,
      turnoStart: b.turnoStart || b.lastTurnoStart || '',
      turnoEnd: b.turnoEnd || b.lastTurnoEnd || '',
      dayKey: offlineBundle?.dayKey || '',
      lastSeenAt: liveTs,
      enLineaAhora: true
    });
  }

  // 2) Scan 7-day offlineBundle across ALL lines (dayObsByDay + dayTripsByDay + coches/choferes roster)
  const bundleLines = offlineBundle?.lines || {};
  for (const [codStr, lineObj] of Object.entries(bundleLines)) {
    const cod = Number(codStr);
    const lineName = lineObj?.descripcionLinea || lineByCode?.get(cod)?.descripcion || `L${cod}`;

    // 2a) Per-day observations (fleet_daily_obs — primary 7-day archive)
    const obsByDay = lineObj?.dayObsByDay || {};
    for (const [dayKey, obsList] of Object.entries(obsByDay)) {
      for (const o of obsList || []) {
        const oCar = String(o.coche || '').trim().toUpperCase();
        const oLeg = String(o.choferLegajo || '').trim().toUpperCase();
        const oNom = String(o.choferNombre || '').trim();
        const oKey = String(o.driverKey || '').trim().toUpperCase();

        const match = isCar ? oCar === normId : matchesDriver(oLeg, oNom, oKey);
        if (!match) continue;

        if (o.esAdaptado) esAdaptado = true;
        if (!isCar) {
          if (oNom && !oNom.startsWith('Legajo ')) title = oNom;
          if (oLeg) subtitle = `Legajo ${oLeg}`;
        }
        const seenMs = Number(o.lastSeenAt) || 0;
        if (seenMs > lastSeenAt) lastSeenAt = seenMs;
        linesSet.add(lineName);

        const companion = isCar
          ? oNom
            ? `${oNom}${oLeg ? ` (${oLeg})` : ''}`
            : 'Chofer s/d'
          : oCar
            ? `Coche #${oCar}`
            : 'Coche s/d';

        trackCompanion(companion);

        const latVal = isValidCoord(o.lastLat, o.lastLng) ? Number(o.lastLat) : null;
        const lngVal = isValidCoord(o.lastLat, o.lastLng) ? Number(o.lastLng) : null;
        const srvNum = Number(o.lastServiceNum) || 0;
        const turnoIdx = Number(o.lastTurnoIdx) || 0;

        addDayEntry(dayKey, {
          dayKey,
          codigoLinea: cod,
          lineName,
          coche: oCar,
          choferNombre: oNom,
          choferLegajo: oLeg,
          esAdaptado: Boolean(o.esAdaptado),
          serviceNumber: srvNum,
          turnoIndex: turnoIdx,
          turnoStart: '',
          turnoEnd: '',
          bandera: o.lastBandera || '',
          lastGps: o.lastGps || '',
          lastStopId: o.lastStopId || '',
          lat: latVal,
          lng: lngVal,
          desvioRaw: o.lastDesvioRaw || '',
          desvioSec: Number(o.lastDesvioSec) || 0,
          companion,
          tripTimes: [],
          lastSeenAt: seenMs,
          firstSeenAt: Number(o.firstSeenAt) || 0
        });

        considerLastPosition({
          codigoLinea: cod,
          lineName,
          coche: oCar,
          choferNombre: oNom,
          choferLegajo: oLeg,
          esAdaptado: Boolean(o.esAdaptado),
          lat: latVal,
          lng: lngVal,
          bandera: o.lastBandera || '',
          lastGps: o.lastGps || '',
          lastStopId: o.lastStopId || '',
          desvioRaw: o.lastDesvioRaw || '',
          desvioSec: Number(o.lastDesvioSec) || 0,
          serviceNumber: srvNum,
          turnoIndex: turnoIdx,
          turnoStart: '',
          turnoEnd: '',
          dayKey,
          lastSeenAt: seenMs,
          enLineaAhora: false
        });
      }
    }

    // 2b) Per-day trip_assignments (enriches departure times & recovers any day without dayObsByDay)
    const tripsByDay = lineObj?.dayTripsByDay || {};
    for (const [dayKey, tripList] of Object.entries(tripsByDay)) {
      for (const t of tripList || []) {
        const tCar = String(t.coche || '').trim().toUpperCase();
        const tLeg = String(t.choferLegajo || '').trim().toUpperCase();
        const tNom = String(t.choferNombre || '').trim();

        const match = isCar ? tCar === normId : matchesDriver(tLeg, tNom);
        if (!match) continue;

        if (t.esAdaptado) esAdaptado = true;
        if (!isCar) {
          if (tNom && !tNom.startsWith('Legajo ') && (!title || title === normId || title.startsWith('Legajo '))) {
            title = tNom;
          }
          if (tLeg && !subtitle) subtitle = `Legajo ${tLeg}`;
        }
        const updMs = Number(t.updatedAt) || 0;
        if (updMs > lastSeenAt) lastSeenAt = updMs;
        linesSet.add(lineName);

        const companion = isCar
          ? tNom
            ? `${tNom}${tLeg ? ` (${tLeg})` : ''}`
            : 'Chofer s/d'
          : tCar
            ? `Coche #${tCar}`
            : 'Coche s/d';

        const hhmm = extractTripHHMM(t.turnoHora, t.tripKey);
        const latVal = isValidCoord(t.lat, t.lng) ? Number(t.lat) : null;
        const lngVal = isValidCoord(t.lat, t.lng) ? Number(t.lng) : null;
        const tripBandera = String(t.tripKey || '').split('@')[0] || '';

        addDayEntry(dayKey, {
          dayKey,
          codigoLinea: cod,
          lineName,
          coche: tCar,
          choferNombre: tNom,
          choferLegajo: tLeg,
          esAdaptado: Boolean(t.esAdaptado),
          serviceNumber: 0,
          turnoIndex: 0,
          turnoStart: '',
          turnoEnd: '',
          bandera: tripBandera,
          lastGps: t.ultimaGps || '',
          lastStopId: t.stopId || '',
          lat: latVal,
          lng: lngVal,
          desvioRaw: t.desvioRaw || '',
          desvioSec: Number(t.desvioSec) || 0,
          companion,
          tripTimes: hhmm ? [hhmm] : [],
          lastSeenAt: updMs,
          firstSeenAt: updMs
        });

        considerLastPosition({
          codigoLinea: cod,
          lineName,
          coche: tCar,
          choferNombre: tNom,
          choferLegajo: tLeg,
          esAdaptado: Boolean(t.esAdaptado),
          lat: latVal,
          lng: lngVal,
          bandera: tripBandera,
          lastGps: t.ultimaGps || '',
          lastStopId: t.stopId || '',
          desvioRaw: t.desvioRaw || '',
          desvioSec: Number(t.desvioSec) || 0,
          serviceNumber: 0,
          turnoIndex: 0,
          turnoStart: '',
          turnoEnd: '',
          dayKey,
          lastSeenAt: updMs,
          enLineaAhora: false
        });
      }
    }

    // 2c) Roster coches/choferes (enriches turnoStart–turnoEnd, exact service/turno, and last known GPS)
    if (isCar) {
      for (const c of lineObj?.coches || []) {
        if (String(c.coche || '').trim().toUpperCase() !== normId) continue;
        if (c.esAdaptado) esAdaptado = true;
        const seenMs = Number(c.lastSeenAt) || 0;
        if (seenMs > lastSeenAt) lastSeenAt = seenMs;
        linesSet.add(lineName);

        const cNom = String(c.lastChoferNombre || '').trim();
        const cLeg = String(c.lastChoferLegajo || '').trim().toUpperCase();
        const companion = cNom ? `${cNom}${cLeg ? ` (${cLeg})` : ''}` : 'Chofer s/d';
        const latVal = isValidCoord(c.lastLat, c.lastLng) ? Number(c.lastLat) : null;
        const lngVal = isValidCoord(c.lastLat, c.lastLng) ? Number(c.lastLng) : null;
        const dk = c.lastDayKey || '';

        if (dk) {
          addDayEntry(dk, {
            dayKey: dk,
            codigoLinea: cod,
            lineName,
            coche: normId,
            choferNombre: cNom,
            choferLegajo: cLeg,
            esAdaptado: Boolean(c.esAdaptado),
            serviceNumber: Number(c.lastServiceNum) || 0,
            turnoIndex: Number(c.lastTurnoIdx) || 0,
            turnoStart: c.lastTurnoStart || '',
            turnoEnd: c.lastTurnoEnd || '',
            bandera: c.lastBandera || '',
            lastGps: c.lastGps || '',
            lastStopId: c.lastStopId || '',
            lat: latVal,
            lng: lngVal,
            desvioRaw: c.lastDesvioRaw || '',
            desvioSec: Number(c.lastDesvioSec) || 0,
            companion,
            tripTimes: [],
            lastSeenAt: seenMs,
            firstSeenAt: Number(c.firstSeenAt) || 0
          });
        }
        if (companionsMap.size === 0) trackCompanion(companion);

        considerLastPosition({
          codigoLinea: cod,
          lineName,
          coche: normId,
          choferNombre: cNom,
          choferLegajo: cLeg,
          esAdaptado: Boolean(c.esAdaptado),
          lat: latVal,
          lng: lngVal,
          bandera: c.lastBandera || '',
          lastGps: c.lastGps || '',
          lastStopId: c.lastStopId || '',
          desvioRaw: c.lastDesvioRaw || '',
          desvioSec: Number(c.lastDesvioSec) || 0,
          serviceNumber: Number(c.lastServiceNum) || 0,
          turnoIndex: Number(c.lastTurnoIdx) || 0,
          turnoStart: c.lastTurnoStart || '',
          turnoEnd: c.lastTurnoEnd || '',
          dayKey: dk,
          lastSeenAt: seenMs,
          enLineaAhora: Boolean(c.enLineaAhora)
        });
      }
    } else {
      for (const d of lineObj?.choferes || []) {
        const dLeg = String(d.choferLegajo || '').trim().toUpperCase();
        const dNom = String(d.choferNombre || '').trim();
        if (!matchesDriver(dLeg, dNom, d.driverKey)) continue;
        if (dNom && !dNom.startsWith('Legajo ')) title = dNom;
        if (dLeg) subtitle = `Legajo ${dLeg}`;
        if (d.lastEsAdaptado) esAdaptado = true;
        const seenMs = Number(d.lastSeenAt) || 0;
        if (seenMs > lastSeenAt) lastSeenAt = seenMs;
        linesSet.add(lineName);

        const dCar = String(d.lastCoche || '').trim().toUpperCase();
        const companion = dCar ? `Coche #${dCar}` : 'Coche s/d';
        const latVal = isValidCoord(d.lastLat, d.lastLng) ? Number(d.lastLat) : null;
        const lngVal = isValidCoord(d.lastLat, d.lastLng) ? Number(d.lastLng) : null;
        const dk = d.lastDayKey || '';

        if (dk) {
          addDayEntry(dk, {
            dayKey: dk,
            codigoLinea: cod,
            lineName,
            coche: dCar,
            choferNombre: dNom,
            choferLegajo: dLeg,
            esAdaptado: Boolean(d.lastEsAdaptado),
            serviceNumber: Number(d.lastServiceNum) || 0,
            turnoIndex: Number(d.lastTurnoIdx) || 0,
            turnoStart: d.lastTurnoStart || '',
            turnoEnd: d.lastTurnoEnd || '',
            bandera: d.lastBandera || '',
            lastGps: d.lastGps || '',
            lastStopId: d.lastStopId || '',
            lat: latVal,
            lng: lngVal,
            desvioRaw: d.lastDesvioRaw || '',
            desvioSec: Number(d.lastDesvioSec) || 0,
            companion,
            tripTimes: [],
            lastSeenAt: seenMs,
            firstSeenAt: Number(d.firstSeenAt) || 0
          });
        }
        if (companionsMap.size === 0) trackCompanion(companion);

        considerLastPosition({
          codigoLinea: cod,
          lineName,
          coche: dCar,
          choferNombre: dNom,
          choferLegajo: dLeg,
          esAdaptado: Boolean(d.lastEsAdaptado),
          lat: latVal,
          lng: lngVal,
          bandera: d.lastBandera || '',
          lastGps: d.lastGps || '',
          lastStopId: d.lastStopId || '',
          desvioRaw: d.lastDesvioRaw || '',
          desvioSec: Number(d.lastDesvioSec) || 0,
          serviceNumber: Number(d.lastServiceNum) || 0,
          turnoIndex: Number(d.lastTurnoIdx) || 0,
          turnoStart: d.lastTurnoStart || '',
          turnoEnd: d.lastTurnoEnd || '',
          dayKey: dk,
          lastSeenAt: seenMs,
          enLineaAhora: Boolean(d.enLineaAhora)
        });
      }
    }
  }

  const days = Array.from(daysMap.entries())
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([dayKey, entries]) => ({
      dayKey,
      entries: entries.sort((a, b) => (b.lastSeenAt || 0) - (a.lastSeenAt || 0))
    }));

  const companions = Array.from(companionsMap.values()).sort((a, b) => b.count - a.count);

  return {
    type,
    id: normId,
    title,
    subtitle: isCar ? (esAdaptado ? 'Unidad adaptada ♿' : 'Unidad urbana/interprovincial') : subtitle || 'Chofer registrado',
    esAdaptado,
    liveNow,
    lastPosition,
    lastSeenAt,
    lines: Array.from(linesSet).sort((a, b) => a.localeCompare(b, 'es', { numeric: true })),
    companions,
    days
  };
}

/**
 * Formatea un resumen de texto limpio listo para compartir por WhatsApp de un Servicio / Turno.
 */
export function formatServiceShareText(lineName, tipoLabel, serviceSummary, blocks = []) {
  const lines = [`🚌 *DIRECT GPS · Línea ${lineName} (${tipoLabel})*`];
  if (serviceSummary) {
    lines.push(`📋 *Servicio ${serviceSummary.serviceNumber}* · ${blocks.length} ${blocks.length === 1 ? 'turno' : 'turnos'}`);
  }
  for (const b of blocks) {
    const tLabel = blocks.length > 1 ? `T${b.turnoIndex}/${blocks.length}` : 'Turno corrido';
    const start = formatSecHHMM(b.startSec);
    const end = formatSecHHMM(b.endSec);
    const flags = [];
    if (b.isCortado) flags.push('Cortado');
    if (b.relevoToNext) flags.push('Relevo en línea');
    const flagTxt = flags.length ? ` [${flags.join(' · ')}]` : '';
    const places = [b.startPlace ? `Inicia: ${b.startPlace}` : '', b.endPlace ? `Fin: ${b.endPlace}` : '']
      .filter(Boolean)
      .join(' → ');
    lines.push(`• *${tLabel}* (${start}–${end})${flagTxt} · ${b.lapsCount || b.trips?.length || 0} vueltas`);
    if (places) lines.push(`  ${places}`);
    if (Array.isArray(b.trips) && b.trips.length > 0) {
      const deps = b.trips
        .filter((t, i) => i === 0 || t.branch === b.trips[0].branch)
        .map((t) => formatSecHHMM(t.startSec))
        .join(', ');
      if (deps) lines.push(`  Salidas: ${deps}`);
    }
  }
  return lines.join('\n');
}
