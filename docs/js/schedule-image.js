import { getLineColor, getDirectionColor } from './config.js';
import { getTripStopSec, formatSecHHMM, formatLapNumber } from './predictor.js';

/**
 * Devuelve un Set con los stopIds "clave" (cabeceras + paradas intermedias distribuidas
 * uniformemente) para el atajo "Cabeceras y claves" del exportador de imágenes.
 */
export function pickKeyStopsForBranch(branch, targetCount = 7) {
  const ordered = dedupeOrderedStops(branch);
  const picked = new Set();
  if (ordered.length === 0) return picked;
  if (ordered.length <= targetCount) {
    ordered.forEach((s) => picked.add(s.id));
    return picked;
  }
  picked.add(ordered[0].id);
  picked.add(ordered[ordered.length - 1].id);
  const interiorSlots = Math.max(1, targetCount - 2);
  const step = (ordered.length - 1) / (interiorSlots + 1);
  for (let i = 1; i <= interiorSlots; i++) {
    const idx = Math.round(i * step);
    if (ordered[idx]) picked.add(ordered[idx].id);
  }
  return picked;
}

export function dedupeOrderedStops(branch) {
  const out = [];
  const seen = new Set();
  for (const st of branch?.orderedStops || []) {
    const id = String(st?.id || '').trim().toUpperCase();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      nombre: st.nombre || st.descripcion || id,
      along: Number(st.along) || 0,
      lat: Number(st.lat),
      lng: Number(st.lng)
    });
  }
  return out;
}

/**
 * Construye las secciones de datos (Ida y/o Vuelta, filtradas por servicio y paradas elegidas)
 * listas para renderizar en Canvas como imagen PNG o JPG.
 */
export function buildScheduleExportSections(
  model,
  branches = [],
  { mode = 'active', activeBranchIdx = 0, serviceFilter = 'ALL', selectedStopIdsByBranch = null } = {}
) {
  if (!model || !Array.isArray(branches) || branches.length === 0) {
    return { sections: [], totalTrips: 0, totalStops: 0 };
  }

  const safeActiveIdx = Math.max(0, Math.min(branches.length - 1, Number(activeBranchIdx) || 0));
  const targetIndices =
    mode === 'both' && branches.length >= 2
      ? branches.map((_, idx) => idx)
      : [safeActiveIdx];

  const sections = [];
  let totalTrips = 0;
  let totalStops = 0;

  for (const bIdx of targetIndices) {
    const br = branches[bIdx];
    if (!br) continue;
    const allTrips = model.getTripsForBranch(br) || [];
    const filteredTrips =
      serviceFilter === 'ALL'
        ? allTrips
        : allTrips.filter((t) => String(t.serviceNumber) === String(serviceFilter));
    if (filteredTrips.length === 0) continue;

    const allStops = dedupeOrderedStops(br);
    const chosenSet = selectedStopIdsByBranch?.get(bIdx) || null;
    const stops = allStops
      .map((st, idx) => ({
        ...st,
        origIdx: idx + 1,
        isFirst: idx === 0,
        isLast: idx === allStops.length - 1
      }))
      .filter((st) => !chosenSet || chosenSet.has(st.id));

    if (stops.length === 0) continue;

    const columns = filteredTrips.map((tr) => ({
      srv: tr.serviceNumber || 0,
      lap: tr.lapNumber ? formatLapNumber(tr.lapNumber) : '',
      turnoIndex: tr.blockInfo?.turnoIndex || tr.turnoIndex || 1,
      startHHMM: formatSecHHMM(tr.startSec)
    }));

    const rows = stops.map((st) => ({
      stop: st,
      times: filteredTrips.map((tr) => {
        const sec = getTripStopSec(tr, st.id, st.along);
        return sec !== null ? formatSecHHMM(sec) : '—';
      })
    }));

    const dirLabel =
      branches.length === 2
        ? bIdx === 0
          ? 'IDA'
          : 'VUELTA'
        : `RAMAL ${bIdx + 1}`;

    sections.push({
      branchIdx: bIdx,
      dirLabel,
      bandera: br.bandera || dirLabel,
      branchColor: br.color || getDirectionColor(bIdx),
      stops,
      columns,
      rows
    });
    totalTrips += filteredTrips.length;
    totalStops += stops.length;
  }

  return { sections, totalTrips, totalStops };
}

function drawRoundedRect(ctx, x, y, w, h, r) {
  const rad = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.arcTo(x + w, y, x + w, y + h, rad);
  ctx.arcTo(x + w, y + h, x, y + h, rad);
  ctx.arcTo(x, y + h, x, y, rad);
  ctx.arcTo(x, y, x + w, y, rad);
  ctx.closePath();
}

function fitText(ctx, text, maxW) {
  const str = String(text || '');
  if (ctx.measureText(str).width <= maxW) return str;
  let lo = 0;
  let hi = str.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (ctx.measureText(`${str.slice(0, mid)}…`).width <= maxW) lo = mid;
    else hi = mid - 1;
  }
  return `${str.slice(0, Math.max(1, lo))}…`;
}

/**
 * Renderiza la grilla de horarios con diseño limpio HiDPI (2×) en un <canvas>,
 * lista para previsualizar o exportar como PNG o JPG para WhatsApp.
 */
export function renderScheduleImageToCanvas(
  canvas,
  { lineName, tipoLabel, serviceLabel = '', serviceSummaryLines = [], sections = [] },
  { theme = 'dark', maxColsPerBand = 11 } = {}
) {
  if (!canvas || !Array.isArray(sections) || sections.length === 0) return null;

  const isLight = theme === 'light';
  const palette = isLight
    ? {
        bg: '#f1f5f9',
        cardBg: '#ffffff',
        cardBorder: '#cbd5e1',
        headerBg: '#f8fafc',
        text1: '#0f172a',
        text2: '#475569',
        text3: '#64748b',
        rowAlt: '#f8fafc',
        rowLine: '#e2e8f0',
        thBg: '#eef2f6',
        chipBg: '#e2e8f0',
        chipText: '#0f172a',
        accent: '#059669'
      }
    : {
        bg: '#090d12',
        cardBg: '#111720',
        cardBorder: 'rgba(148, 163, 184, 0.22)',
        headerBg: '#151e2a',
        text1: '#f8fafc',
        text2: '#cbd5e1',
        text3: '#94a3b8',
        rowAlt: 'rgba(255, 255, 255, 0.03)',
        rowLine: 'rgba(148, 163, 184, 0.14)',
        thBg: '#192231',
        chipBg: 'rgba(148, 163, 184, 0.16)',
        chipText: '#e2e8f0',
        accent: '#10b981'
      };

  const lineColor = getLineColor(lineName);
  const PAD = 24;
  const STOP_COL_W = 246;
  const CELL_W = 68;
  const ROW_H = 34;
  const TH_H = 42;
  const SEC_HEAD_H = 40;
  const BAND_GAP = 14;
  const SEC_GAP = 22;

  // Determine optimal column count across all bands so the card looks balanced
  let maxColsUsed = 1;
  const sectionBands = sections.map((sec) => {
    const bands = [];
    for (let i = 0; i < sec.columns.length; i += maxColsPerBand) {
      const sliceCols = sec.columns.slice(i, i + maxColsPerBand);
      if (sliceCols.length > maxColsUsed) maxColsUsed = sliceCols.length;
      bands.push({
        startIdx: i,
        columns: sliceCols
      });
    }
    return { sec, bands };
  });

  const tableW = Math.max(540, STOP_COL_W + maxColsUsed * CELL_W);
  const canvasW = tableW + PAD * 2;
  const hasSrvSummary = Array.isArray(serviceSummaryLines) && serviceSummaryLines.length > 0;
  const headerH = hasSrvSummary ? 102 + serviceSummaryLines.length * 18 : 96;
  const footerH = 42;

  let bodyH = 0;
  for (let sIdx = 0; sIdx < sectionBands.length; sIdx++) {
    const { sec, bands } = sectionBands[sIdx];
    bodyH += SEC_HEAD_H;
    for (let bIdx = 0; bIdx < bands.length; bIdx++) {
      bodyH += TH_H + sec.rows.length * ROW_H;
      if (bIdx < bands.length - 1) bodyH += BAND_GAP;
    }
    if (sIdx < sectionBands.length - 1) bodyH += SEC_GAP;
  }

  const canvasH = PAD + headerH + 18 + bodyH + 16 + footerH + PAD;
  const scale = 2;
  canvas.width = Math.round(canvasW * scale);
  canvas.height = Math.round(canvasH * scale);

  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);

  // Canvas background
  ctx.fillStyle = palette.bg;
  ctx.fillRect(0, 0, canvasW, canvasH);

  // Outer Header Card
  const hX = PAD;
  const hY = PAD;
  drawRoundedRect(ctx, hX, hY, tableW, headerH, 16);
  ctx.fillStyle = palette.cardBg;
  ctx.fill();
  ctx.strokeStyle = palette.cardBorder;
  ctx.lineWidth = 1;
  ctx.stroke();

  // Top Line Color Accent Strip
  ctx.save();
  drawRoundedRect(ctx, hX, hY, tableW, headerH, 16);
  ctx.clip();
  ctx.fillStyle = lineColor;
  ctx.fillRect(hX, hY, tableW, 6);
  ctx.restore();

  // Line Plate Badge
  const plateX = hX + 18;
  const plateY = hY + 22;
  const plateW = Math.max(76, Math.min(112, 26 + String(lineName).length * 13));
  const plateH = 44;
  drawRoundedRect(ctx, plateX, plateY, plateW, plateH, 11);
  ctx.fillStyle = lineColor;
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.font = '800 22px "JetBrains Mono", ui-monospace, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(lineName), plateX + plateW / 2, plateY + plateH / 2 + 1);

  // Title & Subtitle
  const titleX = plateX + plateW + 16;
  const maxTitleW = tableW - (titleX - hX) - 160;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = palette.text1;
  ctx.font = '800 20px "Plus Jakarta Sans", system-ui, -apple-system, sans-serif';
  ctx.fillText(fitText(ctx, `Horarios · Línea ${lineName}`, maxTitleW), titleX, hY + 42);

  ctx.fillStyle = palette.text2;
  ctx.font = '600 13px "Plus Jakarta Sans", system-ui, -apple-system, sans-serif';
  const subParts = [tipoLabel, serviceLabel || 'Todos los servicios'].filter(Boolean).join(' · ');
  ctx.fillText(fitText(ctx, subParts, maxTitleW), titleX, hY + 63);

  // Right Brand Mark (DIRECT GPS triangle)
  const brandRightX = hX + tableW - 18;
  ctx.textAlign = 'right';
  ctx.fillStyle = palette.accent;
  ctx.font = '800 12.5px "Plus Jakarta Sans", system-ui, -apple-system, sans-serif';
  ctx.fillText('▲ DIRECT GPS', brandRightX, hY + 40);
  ctx.fillStyle = palette.text3;
  ctx.font = '600 11px "Plus Jakarta Sans", system-ui, -apple-system, sans-serif';
  ctx.fillText('Corrientes Capital', brandRightX, hY + 57);

  // Optional Service Turnos Summary Lines inside header
  if (hasSrvSummary) {
    let sy = hY + 86;
    ctx.textAlign = 'left';
    ctx.fillStyle = palette.text2;
    ctx.font = '600 11.5px "JetBrains Mono", ui-monospace, monospace';
    for (const lineTxt of serviceSummaryLines) {
      ctx.fillText(fitText(ctx, lineTxt, tableW - 36), hX + 18, sy);
      sy += 18;
    }
  }

  // Draw Directional Sections
  let curY = hY + headerH + 18;
  for (let sIdx = 0; sIdx < sectionBands.length; sIdx++) {
    const { sec, bands } = sectionBands[sIdx];

    // Section Banner
    drawRoundedRect(ctx, hX, curY, tableW, SEC_HEAD_H - 4, 10);
    ctx.fillStyle = palette.headerBg;
    ctx.fill();
    ctx.strokeStyle = palette.cardBorder;
    ctx.lineWidth = 1;
    ctx.stroke();

    // Direction Pill
    const pillW = Math.max(54, sec.dirLabel.length * 8.5 + 18);
    drawRoundedRect(ctx, hX + 10, curY + 7, pillW, 22, 6);
    ctx.fillStyle = sec.branchColor;
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = '800 10.5px "Plus Jakarta Sans", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(sec.dirLabel, hX + 10 + pillW / 2, curY + 18);

    // Bandera Name
    ctx.textAlign = 'left';
    ctx.fillStyle = palette.text1;
    ctx.font = '700 13px "Plus Jakarta Sans", system-ui, sans-serif';
    ctx.fillText(
      fitText(ctx, sec.bandera, tableW - pillW - 140),
      hX + 10 + pillW + 10,
      curY + 18
    );

    // Right trip count
    ctx.textAlign = 'right';
    ctx.fillStyle = palette.text3;
    ctx.font = '600 11px "JetBrains Mono", ui-monospace, monospace';
    ctx.fillText(
      `${sec.stops.length} par. · ${sec.columns.length} ${sec.columns.length === 1 ? 'vta' : 'vtas'}`,
      hX + tableW - 12,
      curY + 18
    );

    curY += SEC_HEAD_H;

    // Render each column band
    for (let bIdx = 0; bIdx < bands.length; bIdx++) {
      const band = bands[bIdx];
      const bandCols = band.columns;
      const bandH = TH_H + sec.rows.length * ROW_H;
      const effCellW = Math.floor((tableW - STOP_COL_W) / Math.max(1, bandCols.length));
      const colW = Math.min(86, Math.max(CELL_W, effCellW));

      // Table Card Frame
      ctx.save();
      drawRoundedRect(ctx, hX, curY, tableW, bandH, 12);
      ctx.fillStyle = palette.cardBg;
      ctx.fill();
      ctx.clip();

      // Table Header Row
      ctx.fillStyle = palette.thBg;
      ctx.fillRect(hX, curY, tableW, TH_H);

      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = palette.text3;
      ctx.font = '700 11px "Plus Jakarta Sans", system-ui, sans-serif';
      const bandTag = bands.length > 1 ? `PARADA (BLOQUE ${bIdx + 1}/${bands.length})` : 'PARADA';
      ctx.fillText(bandTag, hX + 14, curY + TH_H / 2);

      for (let c = 0; c < bandCols.length; c++) {
        const col = bandCols[c];
        const cx = hX + STOP_COL_W + c * colW;

        // Vertical column divider
        ctx.strokeStyle = palette.rowLine;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(cx, curY);
        ctx.lineTo(cx, curY + bandH);
        ctx.stroke();

        // Service + Lap header
        ctx.textAlign = 'center';
        const centerX = cx + colW / 2;
        if (col.srv) {
          ctx.fillStyle = palette.text1;
          ctx.font = '800 11px "JetBrains Mono", ui-monospace, monospace';
          ctx.fillText(`S${col.srv}`, centerX, curY + 14);
          ctx.fillStyle = palette.text3;
          ctx.font = '600 10px "JetBrains Mono", ui-monospace, monospace';
          ctx.fillText(col.lap ? `V${col.lap}` : col.startHHMM, centerX, curY + 29);
        } else {
          ctx.fillStyle = palette.text1;
          ctx.font = '700 11px "JetBrains Mono", ui-monospace, monospace';
          ctx.fillText(col.startHHMM, centerX, curY + TH_H / 2);
        }
      }

      // Data Rows
      for (let r = 0; r < sec.rows.length; r++) {
        const rowObj = sec.rows[r];
        const ry = curY + TH_H + r * ROW_H;

        if (r % 2 === 1) {
          ctx.fillStyle = palette.rowAlt;
          ctx.fillRect(hX, ry, tableW, ROW_H);
        }

        // Row bottom hairline
        ctx.strokeStyle = palette.rowLine;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(hX, ry);
        ctx.lineTo(hX + tableW, ry);
        ctx.stroke();

        // Stop Dot
        const dotColor = rowObj.stop.isFirst
          ? '#10b981'
          : rowObj.stop.isLast
            ? '#f43f5e'
            : sec.branchColor;
        ctx.beginPath();
        ctx.arc(hX + 16, ry + ROW_H / 2, rowObj.stop.isFirst || rowObj.stop.isLast ? 4.2 : 3, 0, Math.PI * 2);
        ctx.fillStyle = dotColor;
        ctx.fill();

        // Stop Name
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = rowObj.stop.isFirst || rowObj.stop.isLast ? palette.text1 : palette.text2;
        ctx.font =
          rowObj.stop.isFirst || rowObj.stop.isLast
            ? '700 12px "Plus Jakarta Sans", system-ui, sans-serif'
            : '600 11.5px "Plus Jakarta Sans", system-ui, sans-serif';
        ctx.fillText(
          fitText(ctx, rowObj.stop.nombre, STOP_COL_W - 34),
          hX + 27,
          ry + ROW_H / 2
        );

        // Departure Times
        for (let c = 0; c < bandCols.length; c++) {
          const tStr = rowObj.times[band.startIdx + c] || '—';
          const cx = hX + STOP_COL_W + c * colW;
          ctx.textAlign = 'center';
          ctx.fillStyle =
            tStr === '—'
              ? palette.text3
              : rowObj.stop.isFirst || rowObj.stop.isLast
                ? palette.text1
                : palette.text2;
          ctx.font =
            rowObj.stop.isFirst || rowObj.stop.isLast
              ? '700 12.5px "JetBrains Mono", ui-monospace, monospace'
              : '600 12px "JetBrains Mono", ui-monospace, monospace';
          ctx.fillText(tStr, cx + colW / 2, ry + ROW_H / 2);
        }
      }

      ctx.restore();

      // Card outer border
      drawRoundedRect(ctx, hX, curY, tableW, bandH, 12);
      ctx.strokeStyle = palette.cardBorder;
      ctx.lineWidth = 1;
      ctx.stroke();

      curY += bandH + (bIdx < bands.length - 1 ? BAND_GAP : 0);
    }

    if (sIdx < sectionBands.length - 1) curY += SEC_GAP;
  }

  // Footer
  const footY = curY + 24;
  ctx.strokeStyle = palette.rowLine;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(hX, footY - 12);
  ctx.lineTo(hX + tableW, footY - 12);
  ctx.stroke();

  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillStyle = palette.text3;
  ctx.font = '600 11px "Plus Jakarta Sans", system-ui, sans-serif';
  ctx.fillText('DIRECT GPS · Corrientes · Horarios programados oficiales', hX + 4, footY + 6);

  const stamp = new Date().toLocaleDateString('es-AR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: 'America/Argentina/Buenos_Aires'
  });
  ctx.textAlign = 'right';
  ctx.font = '600 11px "JetBrains Mono", ui-monospace, monospace';
  ctx.fillText(`Generado ${stamp}`, hX + tableW - 4, footY + 6);

  return { width: canvasW, height: canvasH };
}

/**
 * Exporta el canvas generado como PNG o JPG, con soporte nativo para compartir imagen
 * por WhatsApp (Web Share API Level 2) y descarga automática de respaldo.
 */
export async function exportCanvasAsImage(canvas, { format = 'png', fileName = 'direct-gps-horarios', share = false } = {}) {
  if (!canvas) return { ok: false, mode: 'none' };
  const isJpg = format === 'jpg' || format === 'jpeg';
  const mime = isJpg ? 'image/jpeg' : 'image/png';
  const ext = isJpg ? 'jpg' : 'png';
  const fullName = `${fileName}.${ext}`;

  const blob = await new Promise((resolve) => canvas.toBlob(resolve, mime, isJpg ? 0.94 : undefined));
  if (!blob) return { ok: false, mode: 'none' };

  if (share && typeof File !== 'undefined' && navigator.canShare) {
    try {
      const file = new File([blob], fullName, { type: mime });
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({
          title: fileName,
          files: [file]
        });
        return { ok: true, mode: 'shared' };
      }
    } catch (err) {
      if (err?.name === 'AbortError') return { ok: false, mode: 'cancelled' };
    }
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fullName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
  return { ok: true, mode: 'downloaded' };
}
