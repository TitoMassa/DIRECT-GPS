import { distanceMeters, parseDesvioHorario } from './api.js';
import { projectOnPolyline } from './trajectory.js';
import { formatSecHHMM, getArgentinaSecOfDay } from './predictor.js';

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
 * Calcula velocidad estimada (km/h), estado físico y estela reciente del colectivo seleccionado.
 */
export function computeBusPhysicalTelemetry(bus, gpsHist = null, simState = null) {
  const trail = [];
  if (Array.isArray(gpsHist?.trail)) {
    for (const pt of gpsHist.trail.slice(-8)) {
      if (Number.isFinite(pt?.lat) && Number.isFinite(pt?.lng)) {
        trail.push([pt.lat, pt.lng]);
      }
    }
  }
  if (Number.isFinite(bus?.lat) && Number.isFinite(bus?.lng)) {
    const last = trail[trail.length - 1];
    if (!last || (distanceMeters(last[0], last[1], bus.lat, bus.lng) || 0) > 4) {
      trail.push([bus.lat, bus.lng]);
    }
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

  return { speedKmh, stateKind, stateLabel, trail };
}

/**
 * Construye la lista de próximas paradas restantes de la vuelta actual del colectivo seleccionado,
 * ajustando los horarios programados por el desvío real en vivo.
 */
export function buildBusUpcomingStops(bus, model, branches = [], nowSec = getArgentinaSecOfDay()) {
  if (!bus || !Number.isFinite(bus.lat) || !Number.isFinite(bus.lng)) return [];
  const trip = bus._matchedTrip || bus.scheduledTrip || null;

  let activeBranch = trip?.branch || null;
  if (!activeBranch && Array.isArray(branches) && branches.length > 0) {
    const targetBand = String(bus.realBandera || bus.descripcionBandera || '').toUpperCase();
    activeBranch =
      branches.find((b) => String(b.bandera || '').toUpperCase() === targetBand) ||
      branches[0];
  }
  if (!activeBranch || !Array.isArray(activeBranch.orderedStops) || activeBranch.orderedStops.length === 0) {
    return [];
  }

  const proj = projectOnPolyline(activeBranch.pts, activeBranch.cum, bus.lat, bus.lng);
  if (!proj) return [];

  const effNow = nowSec < 3 * 3600 ? nowSec + 86400 : nowSec;
  const desvioSec =
    bus.desvio && bus.desvio.status !== 'none' && Math.abs(bus.desvio.seconds || 0) <= 45 * 60
      ? bus.desvio.seconds
      : 0;

  const schedByStopId = new Map();
  if (Array.isArray(trip?.points)) {
    for (const pt of trip.points) {
      if (pt.stopId && typeof pt.sec === 'number' && !schedByStopId.has(pt.stopId)) {
        schedByStopId.set(pt.stopId, pt.sec);
      }
    }
  }

  const remaining = [];
  for (const st of activeBranch.orderedStops) {
    if (st.along < proj.along + 40) continue;
    const distM = Math.round(st.along - proj.along);
    const schedSec = schedByStopId.get(st.id) ?? null;
    let estSec = null;
    if (schedSec !== null) {
      estSec = schedSec - desvioSec;
      // Ensure monotonic non-past ETA
      if (estSec < effNow + 30) estSec = effNow + Math.round(distM / 5.5);
    } else {
      estSec = effNow + Math.round(distM / 5.5);
    }
    const etaMin = Math.max(1, Math.round((estSec - effNow) / 60));
    remaining.push({
      id: st.id,
      nombre: st.nombre || st.descripcion || st.id,
      lat: st.lat,
      lng: st.lng,
      distM,
      etaMin,
      clock: formatSecHHMM(estSec)
    });
  }

  return remaining;
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
 * Construye el perfil histórico de 7 días cruzado en todas las líneas para un Coche o un Chofer
 * a partir del offlineBundle (y datos en vivo actuales).
 */
export function buildEntitySevenDayProfile(type, queryId, offlineBundle, liveBuses = [], lineByCode = null) {
  const normId = String(queryId || '').trim().toUpperCase();
  if (!normId) return null;

  const isCar = type === 'coche';
  const daysMap = new Map(); // dayKey -> { dayKey, entries: [] }
  const linesSet = new Set();
  const companionsMap = new Map(); // key -> { label, sub, count }
  let title = isCar ? `Coche #${normId}` : queryId;
  let subtitle = '';
  let esAdaptado = false;
  let lastSeenAt = 0;
  let liveNow = null;

  const addDayEntry = (dayKey, entry) => {
    if (!dayKey) return;
    if (!daysMap.has(dayKey)) daysMap.set(dayKey, []);
    const list = daysMap.get(dayKey);
    const exists = list.find(
      (e) =>
        e.codigoLinea === entry.codigoLinea &&
        e.serviceNumber === entry.serviceNumber &&
        e.companion === entry.companion
    );
    if (!exists) {
      list.push(entry);
    } else if ((entry.lastSeenAt || 0) > (exists.lastSeenAt || 0)) {
      Object.assign(exists, entry);
    }
  };

  // 1) Scan live buses first
  for (const b of liveBuses || []) {
    const carId = String(b.identificadorCoche || b.coche || '').trim().toUpperCase();
    const drvName = String(b.choferNombre || '').trim();
    const drvLeg = String(b.choferLegajo || '').trim().toUpperCase();
    const match = isCar
      ? carId === normId
      : (drvLeg && drvLeg === normId) || drvName.toUpperCase() === normId;
    if (!match) continue;
    liveNow = b;
    if (b.esAdaptado) esAdaptado = true;
    if (!isCar && drvName) {
      title = drvName;
      if (drvLeg) subtitle = `Legajo ${drvLeg}`;
    }
    const lineName = b.descripcionLinea || lineByCode?.get(Number(b.codigoLinea))?.descripcion || `L${b.codigoLinea}`;
    linesSet.add(lineName);
  }

  // 2) Scan 7-day offlineBundle across ALL lines
  const bundleLines = offlineBundle?.lines || {};
  for (const [codStr, lineObj] of Object.entries(bundleLines)) {
    const cod = Number(codStr);
    const lineName = lineObj?.descripcionLinea || lineByCode?.get(cod)?.descripcion || `L${cod}`;

    if (isCar) {
      for (const c of lineObj?.coches || []) {
        if (String(c.coche || '').trim().toUpperCase() !== normId) continue;
        if (c.esAdaptado) esAdaptado = true;
        if ((c.lastSeenAt || 0) > lastSeenAt) lastSeenAt = c.lastSeenAt;
        linesSet.add(lineName);
      }
    } else {
      for (const d of lineObj?.choferes || []) {
        const dLeg = String(d.choferLegajo || '').trim().toUpperCase();
        const dNom = String(d.choferNombre || '').trim();
        if (dLeg !== normId && dNom.toUpperCase() !== normId && String(d.driverKey || '').toUpperCase() !== normId) {
          continue;
        }
        if (dNom) title = dNom;
        if (dLeg) subtitle = `Legajo ${dLeg}`;
        if ((d.lastSeenAt || 0) > lastSeenAt) lastSeenAt = d.lastSeenAt;
        linesSet.add(lineName);
      }
    }

    const obsByDay = lineObj?.dayObsByDay || {};
    for (const [dayKey, obsList] of Object.entries(obsByDay)) {
      for (const o of obsList || []) {
        const oCar = String(o.coche || '').trim().toUpperCase();
        const oLeg = String(o.choferLegajo || '').trim().toUpperCase();
        const oNom = String(o.choferNombre || '').trim();
        const oKey = String(o.driverKey || '').trim().toUpperCase();

        const match = isCar
          ? oCar === normId
          : (oLeg && oLeg === normId) || oNom.toUpperCase() === normId || (oKey && oKey === normId);
        if (!match) continue;

        if (o.esAdaptado) esAdaptado = true;
        if (!isCar) {
          if (oNom) title = oNom;
          if (oLeg) subtitle = `Legajo ${oLeg}`;
        }
        if ((o.lastSeenAt || 0) > lastSeenAt) lastSeenAt = o.lastSeenAt;
        linesSet.add(lineName);

        const companion = isCar
          ? oNom
            ? `${oNom}${oLeg ? ` (${oLeg})` : ''}`
            : 'Chofer s/d'
          : oCar
            ? `Coche #${oCar}`
            : 'Coche s/d';

        if (companion && !companion.includes('s/d')) {
          const prev = companionsMap.get(companion) || { label: companion, count: 0 };
          prev.count++;
          companionsMap.set(companion, prev);
        }

        addDayEntry(dayKey, {
          dayKey,
          codigoLinea: cod,
          lineName,
          serviceNumber: Number(o.lastServiceNum) || 0,
          turnoIndex: Number(o.lastTurnoIdx) || 0,
          bandera: o.lastBandera || '',
          companion,
          lastSeenAt: o.lastSeenAt || 0,
          firstSeenAt: o.firstSeenAt || 0
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

/**
 * Genera un documento HTML limpio y listo para imprimir o guardar como PDF desde la Grilla de horarios.
 */
export function buildPrintableScheduleHtml(title, subtitle, tableHtml) {
  return `<!DOCTYPE html>
<html lang="es-AR">
<head>
  <meta charset="UTF-8" />
  <title>${title}</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; color: #111827; margin: 18px; }
    h1 { font-size: 18px; margin: 0 0 4px; }
    p { font-size: 12px; color: #4b5563; margin: 0 0 14px; }
    table { width: 100%; border-collapse: collapse; font-size: 11px; }
    th, td { border: 1px solid #d1d5db; padding: 4px 6px; text-align: center; }
    th { background: #f3f4f6; font-weight: 700; }
    td:first-child, th:first-child { text-align: left; font-weight: 600; }
    @media print { body { margin: 8px; } }
  </style>
</head>
<body>
  <h1>${title}</h1>
  <p>${subtitle} · Generado con DIRECT GPS Corrientes</p>
  ${tableHtml}
  <script>window.addEventListener('load', () => { setTimeout(() => window.print(), 250); });</script>
</body>
</html>`;
}
