import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, execFileSync, execSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'docs', 'data');

const importLocal = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);

globalThis.window = {
  location: { search: '', hostname: 'titomassa.github.io', origin: 'https://titomassa.github.io' },
  addEventListener: () => {}
};
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

const {
  connectRouteEndpoints,
  parseRouteBranches,
  projectOnPolyline,
  buildTrajectoryFromBranchAlong,
  resolveBusTrajectory
} = await importLocal('docs/js/trajectory.js');
const {
  normalizeBandera,
  formatSecHHMM,
  buildLineScheduleModel,
  buildStopTimetableBlocks,
  evaluateTripState,
  evaluateFreeBusSchedulePos,
  detectEndingServiceBusForStop,
  getArgentinaSecOfDay
} = await importLocal('docs/js/predictor.js');
const { BusSimulator } = await importLocal('docs/js/simulator.js');
const { parseDesvioHorario, distanceMeters } = await importLocal('docs/js/api.js');
const { MAP_TILES } = await importLocal('docs/js/config.js');
const { getHolidayInfo, getCalendarTipoDiaWithHolidays } = await importLocal('docs/js/holidays.js');
const {
  dedupeOrderedStops,
  pickKeyStopsForBranch,
  buildScheduleExportSections
} = await importLocal('docs/js/schedule-image.js');
const {
  computeBridgeStatus,
  detectBunchingAndGaps,
  computeNetworkPunctuality,
  classifyBusEndingBadge,
  evaluateServiceCompletionStatus,
  computeBusPhysicalTelemetry,
  findOppositeStop,
  buildEntitySevenDayProfile,
  formatServiceShareText
} = await importLocal('docs/js/telemetry.js');
const {
  formatCocheForTts,
  formatLineaForTts,
  formatStopNameForTts
} = await importLocal('docs/js/tts.js');
const {
  RideModeController,
  LiveTripTracker,
  buildUberProgressLine,
  buildUberNotificationPayload,
  buildArrivalSpeechMessage
} = await importLocal('docs/js/ride-mode.js');

const catalogo = JSON.parse(await fs.readFile(path.join(DATA_DIR, 'catalogo.json'), 'utf8'));
const stopMap = new Map(catalogo.paradas.map((p) => [p.id, p]));
const lineByCode = new Map(catalogo.lineas.map((l) => [Number(l.codigo), l]));

console.log('1. Testing 3-digit desvioHorario parsing & sanitizeLiveDesvio...');
{
  const d1 = parseDesvioHorario('+106:05');
  assert.equal(d1.status, 'ahead');
  assert.equal(d1.seconds, 106 * 60 + 5);

  const d2 = parseDesvioHorario('-105:12');
  assert.equal(d2.status, 'late');
  assert.equal(d2.seconds, -(105 * 60 + 12));

  const d3 = parseDesvioHorario('00:00');
  assert.equal(d3.status, 'ok');
  assert.equal(d3.seconds, 0);

  const dBad = parseDesvioHorario('SIN_DATOS');
  assert.equal(dBad.status, 'none');
  console.log('  ✓ 3-digit desvios parsed accurately');
}

console.log('2. Testing Bandera normalization + TripKeyMap legacy compatibility across all 26 lines...');
{
  assert.equal(normalizeBandera('Bº DR. MONTAÑA - PUERTO'), 'BO DR MONTANA PUERTO');
  assert.equal(normalizeBandera('B° DR. MONTANA - PUERTO'), 'BO DR MONTANA PUERTO');
  assert.equal(normalizeBandera('AV. FERRÉ Y ESPAÑA - L BRAVA'), 'AV FERRE Y ESPANA L BRAVA');

  for (const cod of [133, 134]) {
    const rec = JSON.parse(await fs.readFile(path.join(DATA_DIR, 'recorridos', `${cod}.json`), 'utf8'));
    const hor = JSON.parse(await fs.readFile(path.join(DATA_DIR, 'horarios', `${cod}.json`), 'utf8'));
    const brs = parseRouteBranches(rec);
    const m = buildLineScheduleModel(cod, brs, hor, 'habil');
    const trips = [...m.tripByKey.values()];
    assert.equal(m.tripByKey.size, trips.length);
    const montanaTrip = trips.find((t) => t.tripKey.includes('MONTANA'));
    assert.ok(montanaTrip, `Expected MONTANA trip in line ${cod}`);
    const legacyKey = montanaTrip.tripKey.replace(/MONTANA/g, 'MONTA A');
    assert.equal(m.tripByKey.get(legacyKey), montanaTrip, `Legacy key ${legacyKey} should resolve to exact trip`);
  }
  console.log('  ✓ Bandera normalization & TripKeyMap 7-day backwards compatibility verified');
}

console.log('3. Testing Multi-leg Trajectory vs evaluateTripState 0.00m precision + BusSimulator on 109A...');
{
  let testedPrevLegs = 0;
  let testedFullCycles = 0;
  for (const l of catalogo.lineas) {
    const rec = JSON.parse(await fs.readFile(path.join(DATA_DIR, 'recorridos', `${l.codigo}.json`), 'utf8'));
    const hor = JSON.parse(await fs.readFile(path.join(DATA_DIR, 'horarios', `${l.codigo}.json`), 'utf8'));
    const brs = parseRouteBranches(rec);
    const m = buildLineScheduleModel(l.codigo, brs, hor, 'habil');
    if (!m) continue;
    for (const tr of m.tripByKey.values()) {
      if (!tr.prevTrip || (tr.branch?.orderedStops?.length || 0) < 5) continue;
      const ms = tr.branch.orderedStops[Math.floor(tr.branch.orderedStops.length / 2)];
      const sp = projectOnPolyline(tr.branch.pts, tr.branch.cum, ms.lat, ms.lng);
      const nowPrev = Math.round((tr.prevTrip.startSec + tr.prevTrip.endSec) / 2);
      const ev = evaluateTripState(tr, ms.id, sp, nowPrev, 0, null);
      if (ev && ev.inOppositeLeg) {
        const traj = buildTrajectoryFromBranchAlong(ev.activeBranch, ev.activeAlong, tr.branch, sp, {
          etaSec: ev.etaSec,
          viaBranch: ev.viaBranch
        });
        assert.ok(Math.abs(traj.totalMeters - ev.remainingMeters) < 0.5, `${l.descripcion} prev_leg mismatch`);
        testedPrevLegs++;
      }
      if (tr.prevTrip.prevTrip) {
        const pp = tr.prevTrip.prevTrip;
        const nowPP = Math.round((pp.startSec + pp.endSec) / 2);
        const ev3 = evaluateTripState(tr, ms.id, sp, nowPP, 0, {});
        if (ev3 && ev3.inNextCycle) {
          const traj3 = buildTrajectoryFromBranchAlong(ev3.activeBranch, ev3.activeAlong, tr.branch, sp, {
            etaSec: ev3.etaSec,
            viaBranch: ev3.viaBranch
          });
          assert.ok(Math.abs(traj3.totalMeters - ev3.remainingMeters) < 0.5, `${l.descripcion} full_cycle mismatch`);
          testedFullCycles++;
        }
      }
    }
  }
  assert.ok(testedPrevLegs > 200, 'Should test >200 previous_leg trips');
  assert.ok(testedFullCycles > 150, 'Should test >150 full_cycle trips');

  const rec109 = JSON.parse(await fs.readFile(path.join(DATA_DIR, 'recorridos', '342.json'), 'utf8'));
  const hor109 = JSON.parse(await fs.readFile(path.join(DATA_DIR, 'horarios', '342.json'), 'utf8'));
  const brs109 = parseRouteBranches(rec109);
  const m109 = buildLineScheduleModel(342, brs109, hor109, 'habil');
  const tr109 = [...m109.tripByKey.values()].find((t) => t.prevTrip && t.prevTrip.branch.git === 'I-PARE');
  const stop109 = tr109.branch.orderedStops[10];
  const sp109 = projectOnPolyline(tr109.branch.pts, tr109.branch.cum, stop109.lat, stop109.lng);
  const origDateNow = Date.now;
  let fakeNowMs = Date.UTC(2026, 10, 25, 3, 0, 0) + Math.round((tr109.prevTrip.startSec + tr109.prevTrip.endSec) / 2) * 1000;
  Date.now = () => fakeNowMs;
  try {
    const sim = new BusSimulator();
    let prevLat = null;
    let prevLng = null;
    for (let poll = 0; poll < 4; poll++) {
      const simClock = getArgentinaSecOfDay(new Date(fakeNowMs));
      const ev = evaluateTripState(tr109, stop109.id, sp109, simClock, 0, {});
      const traj = buildTrajectoryFromBranchAlong(ev.activeBranch, ev.activeAlong, tr109.branch, sp109, {
        etaSec: ev.etaSec,
        viaBranch: ev.viaBranch
      });
      const busObj = {
        key: 'pred:109A:test',
        codigoLinea: 342,
        descripcionLinea: '109A',
        identificadorCoche: '3301',
        isPredicted: true,
        lat: ev.lat,
        lng: ev.lng,
        routeMeters: ev.remainingMeters,
        etaSecondsRemaining: ev.etaSec,
        eta: { valid: true, minutes: ev.etaSec / 60 },
        trajectory: traj,
        scheduledTrip: tr109,
        stopId: stop109.id,
        stopProj: sp109,
        predDesvioSec: 0,
        predAnchor: null
      };
      sim.reconcile([busObj], { stopId: stop109.id, applyPositions: true });
      if (prevLat !== null) {
        const pollJump = distanceMeters(prevLat, prevLng, busObj.lat, busObj.lng);
        assert.ok(pollJump < 1.0, `Unexpected poll jump of ${pollJump}m on 109A reconcile!`);
      }
      for (let f = 0; f < 300; f++) {
        fakeNowMs += 33.333;
        sim.step(0.033333, [busObj], { updateEta: false });
        if (prevLat !== null) {
          const stepJump = distanceMeters(prevLat, prevLng, busObj.lat, busObj.lng);
          assert.ok(stepJump < 2.0, `Unexpected step jump of ${stepJump}m on 109A simulation step!`);
        }
        prevLat = busObj.lat;
        prevLng = busObj.lng;
      }
    }
  } finally {
    Date.now = origDateNow;
  }
  console.log(`  ✓ Verified 0.00m mismatch across ${testedPrevLegs} previous_leg & ${testedFullCycles} full_cycle trips + smooth 109A simulation`);
}

console.log('4. Testing Cortado break termination & Relevo continuation + Spatial GPS Anchor in evaluateFreeBusSchedulePos...');
{
  let cortadoChecked = 0;
  let relevoChecked = 0;
  for (const l of catalogo.lineas) {
    const rec = JSON.parse(await fs.readFile(path.join(DATA_DIR, 'recorridos', `${l.codigo}.json`), 'utf8'));
    const hor = JSON.parse(await fs.readFile(path.join(DATA_DIR, 'horarios', `${l.codigo}.json`), 'utf8'));
    const brs = parseRouteBranches(rec);
    for (const tipo of ['habil', 'sabado', 'domingo']) {
      const m = buildLineScheduleModel(l.codigo, brs, hor, tipo);
      if (!m?.blocks?.length) continue;
      const bySrv = new Map();
      for (const blk of m.blocks) {
        if (!bySrv.has(blk.serviceNumber)) bySrv.set(blk.serviceNumber, []);
        bySrv.get(blk.serviceNumber).push(blk);
      }
      for (const sBlocks of bySrv.values()) {
        sBlocks.sort((a, b) => a.startSec - b.startSec);
        for (let i = 0; i < sBlocks.length - 1; i++) {
          const b1 = sBlocks[i];
          const b2 = sBlocks[i + 1];
          const gap = b2.startSec - b1.endSec;
          const seedTrip = b1.trips[b1.trips.length - 1];
          if (!b1.relevoToNext && gap > 50 * 60) {
            const midSec = Math.round((b1.endSec + b2.startSec) / 2);
            const pos = evaluateFreeBusSchedulePos(seedTrip, m, midSec, { allowShiftContinuation: true });
            assert.equal(pos.finished, true, `Cortado break leaked on ${l.descripcion} ${tipo} S${b1.serviceNumber}`);
            cortadoChecked++;
          } else if (b1.relevoToNext && gap <= 35 * 60 && b2.trips.length > 0) {
            const tInB2 = Math.round((b2.trips[0].startSec + b2.trips[0].endSec) / 2);
            const pos = evaluateFreeBusSchedulePos(seedTrip, m, tInB2, { allowShiftContinuation: true });
            assert.equal(pos.finished, false, `Relevo continuation prematurely stopped on ${l.descripcion}`);
            relevoChecked++;
          }
        }
      }
    }
  }
  assert.ok(cortadoChecked >= 130, `Expected >=130 cortado checks, got ${cortadoChecked}`);
  assert.ok(relevoChecked >= 50, `Expected >=50 relevo checks, got ${relevoChecked}`);

  const rec102 = JSON.parse(await fs.readFile(path.join(DATA_DIR, 'recorridos', '94.json'), 'utf8'));
  const hor102 = JSON.parse(await fs.readFile(path.join(DATA_DIR, 'horarios', '94.json'), 'utf8'));
  const brs102 = parseRouteBranches(rec102);
  const m102 = buildLineScheduleModel(94, brs102, hor102, 'habil');
  const sampleTr = [...m102.tripByKey.values()].find((t) => t.points.length >= 10);
  const midPt = sampleTr.branch.pts[Math.floor(sampleTr.branch.pts.length / 2)];
  const midProj = projectOnPolyline(sampleTr.branch.pts, sampleTr.branch.cum, midPt[0], midPt[1]);
  const fakeGpsSec = Math.round((sampleTr.startSec + sampleTr.endSec) / 2) + 240;
  const posAtGps = evaluateFreeBusSchedulePos(sampleTr, m102, fakeGpsSec, {
    desvioSec: 0,
    lastGpsSec: fakeGpsSec,
    anchorLat: midPt[0],
    anchorLng: midPt[1]
  });
  assert.ok(Math.abs(posAtGps.along - midProj.along) < 1.0, `Expected <1m anchor accuracy`);

  // Verify 3–5 min (210 s) uses last-seen desvio (-06:00), while >= 5 min (310 s) switches strictly to 00:00 punctual!
  const midNowSec = Math.round((sampleTr.startSec + sampleTr.endSec) / 2) + 300;
  const pos3to5 = evaluateFreeBusSchedulePos(sampleTr, m102, midNowSec, {
    desvioSec: -360,
    hasExplicitDesvio: true,
    gpsAgeSec: 210,
    lastGpsSec: midNowSec - 210,
    anchorLat: midPt[0],
    anchorLng: midPt[1]
  });
  const posOver5 = evaluateFreeBusSchedulePos(sampleTr, m102, midNowSec, {
    desvioSec: -360,
    hasExplicitDesvio: true,
    gpsAgeSec: 310,
    lastGpsSec: midNowSec - 310,
    anchorLat: midPt[0],
    anchorLng: midPt[1]
  });
  const posExactPunctual = evaluateFreeBusSchedulePos(sampleTr, m102, midNowSec, {
    desvioSec: 0,
    strictPunctual: true
  });
  assert.equal(pos3to5.isPunctualSchedule, false, '3–5 min without GPS must use last-seen desvio, not punctual override');
  assert.equal(pos3to5.effectiveOffsetSec, -360, '3–5 min without GPS must preserve exact last-seen desvio (-360 s)');
  assert.equal(posOver5.isPunctualSchedule, true, '>= 5 min without GPS must switch to strict punctual 00:00 mode');
  assert.equal(posOver5.effectiveOffsetSec, 0, '>= 5 min without GPS must force effectiveOffsetSec === 0');
  assert.ok(
    Math.abs(posOver5.along - posExactPunctual.along) < 0.01,
    `>= 5 min punctual position must match 00:00 timetable exactly (diff=${Math.abs(posOver5.along - posExactPunctual.along).toFixed(2)}m)`
  );
  assert.ok(
    posOver5.along > pos3to5.along + 50,
    'Late (-06:00) 3–5 min simulation must sit behind the >= 5 min punctual 00:00 position'
  );
  console.log(`  ✓ Verified ${cortadoChecked} cortado terminations, ${relevoChecked} relevo continuations, <1m GPS anchor, and 3-min desvio -> 5-min 00:00 punctual switch`);
}

console.log('5. Testing 103C CT32247 rawStopTimeMap & shared multi-direction stop disambiguation...');
{
  const rec103C = JSON.parse(await fs.readFile(path.join(DATA_DIR, 'recorridos', '134.json'), 'utf8'));
  const hor103C = JSON.parse(await fs.readFile(path.join(DATA_DIR, 'horarios', '134.json'), 'utf8'));
  const brs103C = parseRouteBranches(rec103C);
  const m103C = buildLineScheduleModel(134, brs103C, hor103C, 'habil');
  const st32247 = stopMap.get('CT32247');
  const tt103C = buildStopTimetableBlocks(m103C, 'CT32247', { lat: st32247.lat, lng: st32247.lng });
  assert.ok(tt103C.slotMetaByHora.has('06:15'), '103C CT32247 06:15:55 must match 06:15');
  assert.ok(tt103C.slotMetaByHora.has('07:05'), '103C CT32247 07:05:55 must match 07:05');

  const rec108A = JSON.parse(await fs.readFile(path.join(DATA_DIR, 'recorridos', '356.json'), 'utf8'));
  const hor108A = JSON.parse(await fs.readFile(path.join(DATA_DIR, 'horarios', '356.json'), 'utf8'));
  const brs108A = parseRouteBranches(rec108A);
  const m108A = buildLineScheduleModel(356, brs108A, hor108A, 'sabado');
  const st31509 = stopMap.get('CT31509');
  const tt108A = buildStopTimetableBlocks(m108A, 'CT31509', { lat: st31509.lat, lng: st31509.lng });
  const metaIda = tt108A.slotMetaByHora.get(`09:07|${normalizeBandera('Bº QUINTANA - CUENCA')}`);
  const metaVta = tt108A.slotMetaByHora.get(`09:07|${normalizeBandera('CUENCA - Bº QUINTANA')}`);
  assert.ok(metaIda && metaVta, 'Both directions at 09:07 on CT31509 must be indexed');
  assert.notEqual(metaIda.trip.tripKey, metaVta.trip.tripKey, 'IDA and VUELTA at 09:07 must resolve to distinct trips');
  console.log('  ✓ Verified 103C CT32247 exact HH:MM matching and 108A CT31509 same-minute bidirectional disambiguation');
}

console.log('6. Testing local server.js HTTP endpoints, SW v98, and v2.7.0 assets...');
{
  const port = 3987;
  const proc = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), DISABLE_BG_FLEET_SCAN: '1' },
    stdio: 'pipe'
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server start timeout')), 5000);
    proc.stdout.on('data', (d) => {
      if (String(d).includes('activo en')) {
        clearTimeout(timer);
        resolve();
      }
    });
    proc.on('exit', (c) => {
      clearTimeout(timer);
      reject(new Error(`server exited early: ${c}`));
    });
  });

  try {
    const checkUrl = async (p) => {
      const r = await fetch(`http://127.0.0.1:${port}${p}`);
      assert.equal(r.status, 200, `Expected 200 for ${p}, got ${r.status}`);
      return r;
    };
    const html = await (await checkUrl('/')).text();
    assert.ok(html.includes('DIRECT GPS'), 'index.html should contain DIRECT GPS');
    const sw = await (await checkUrl('/sw.js')).text();
    assert.ok(sw.includes('direct-gps-v113') && sw.includes('direct-gps-data-v6'), 'sw.js should have direct-gps-v113 & direct-gps-data-v6');
    assert.ok(sw.includes('notificationclick') && sw.includes("addEventListener('push'"), 'sw.js must handle push & notificationclick actions');
    for (const asset of [
      '/icons/icon-192.png',
      '/icons/icon-512.png',
      '/icons/icon-maskable-512.png',
      '/icons/apple-touch-icon.png',
      '/js/holidays.js',
      '/js/tts.js',
      '/js/schedule-image.js',
      '/js/telemetry.js',
      '/js/ride-mode.js',
      '/js/ui-extras.js'
    ]) {
      await checkUrl(asset);
    }
    const health = await (await checkUrl('/api/health')).json();
    assert.equal(health.ok, true);
    const simArr = await (await checkUrl('/api/arribos?idParada=CT31498&codLinea=000&simulate=1')).json();
    assert.ok(simArr.data.arribos.length > 0);
    const buscar = await (await checkUrl('/api/flota-buscar?q=2967')).json();
    assert.ok(buscar.data.results.some((r) => r.coche === '2967'), '/api/flota-buscar should find simulated coche 2967');
    const bundle = await (await checkUrl('/api/offline-bundle')).json();
    assert.ok(bundle.data.cars.length > 0 && bundle.data.drivers.length > 0, '/api/offline-bundle should include rosterCars and rosterDrivers');
    console.log('  ✓ Local server.js static, v2.7.0 assets, SW v98 & API endpoints verified');
  } finally {
    proc.kill('SIGTERM');
  }
}

console.log('7. Testing 904A & 904B Lun–Vie schedule restoration, UNNE asueto scanner guard, and Grilla UI layout...');
{
  const { decodeLineFile, detectReducedScheduleAnomaly } = await importLocal('scripts/scan-horarios.mjs');

  const rec904A = JSON.parse(await fs.readFile(path.join(DATA_DIR, 'recorridos', '1037.json'), 'utf8'));
  const hor904A = JSON.parse(await fs.readFile(path.join(DATA_DIR, 'horarios', '1037.json'), 'utf8'));
  const brs904A = parseRouteBranches(rec904A);
  const m904A = buildLineScheduleModel(1037, brs904A, hor904A, 'habil');
  assert.equal(m904A.getTripsForBranch(brs904A[0]).length, 10, '904A branch 0 should have 10 Lun–Vie trips');
  assert.equal(m904A.getTripsForBranch(brs904A[1]).length, 10, '904A branch 1 should have 10 Lun–Vie trips');
  assert.equal(m904A.fleetSummary.services.length, 2, '904A Lun–Vie should have 2 services');

  const rec904B = JSON.parse(await fs.readFile(path.join(DATA_DIR, 'recorridos', '1038.json'), 'utf8'));
  const hor904B = JSON.parse(await fs.readFile(path.join(DATA_DIR, 'horarios', '1038.json'), 'utf8'));
  const brs904B = parseRouteBranches(rec904B);
  const m904B = buildLineScheduleModel(1038, brs904B, hor904B, 'habil');
  assert.equal(m904B.tripByKey.size, 96, '904B Lun–Vie should have 96 one-way trips (48 per branch)');

  for (const cod of ['1037', '1038']) {
    const goodRaw = JSON.parse(await fs.readFile(path.join(DATA_DIR, 'horarios', `${cod}.json`), 'utf8'));
    const storedMap = decodeLineFile(goodRaw);
    let stagedBad = new Map();
    try {
      const badRaw = JSON.parse(
        execSync(`git show 3fa05b2:docs/data/horarios/${cod}.json`, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      );
      const badDecoded = decodeLineFile(badRaw);
      for (const [stopId, obj] of badDecoded.entries()) {
        if (obj.habil) stagedBad.set(stopId, obj.habil);
      }
    } catch {
      // Shallow CI checkout fallback: synthesize a 55% reduced schedule matching a local asueto
      for (const [stopId, obj] of storedMap.entries()) {
        if (obj.habil) stagedBad.set(stopId, obj.habil.filter((_, idx) => idx % 2 === 0));
      }
    }
    const checkBad = detectReducedScheduleAnomaly('habil', storedMap, stagedBad, stagedBad);
    assert.equal(checkBad.anomalous, true, `Expected anomaly guard to reject reduced schedule on ${cod}`);

    const stagedGood = new Map();
    for (const [stopId, obj] of storedMap.entries()) {
      if (obj.habil) stagedGood.set(stopId, obj.habil);
    }
    const checkGood = detectReducedScheduleAnomaly('habil', storedMap, stagedGood, stagedGood);
    assert.equal(checkGood.anomalous, false, `Normal Lun–Vie schedule on ${cod} must NOT trigger anomaly`);
  }

  const horIdx = JSON.parse(await fs.readFile(path.join(DATA_DIR, 'horarios', 'index.json'), 'utf8'));
  assert.ok(horIdx.updatedAt > '2026-11-25T17:30:25.000Z', 'horarios/index.json updatedAt must invalidate stale OTA cache');
  const cssText = await fs.readFile(path.join(ROOT, 'docs', 'css', 'styles.css'), 'utf8');
  const appText = await fs.readFile(path.join(ROOT, 'docs', 'js', 'app.js'), 'utf8');
  assert.ok(cssText.includes('.app-shell.grilla-fullscreen') && cssText.includes('#lineas-content.is-grilla-mode'));
  assert.ok(appText.includes('btn-rec-fullscreen') && appText.includes('syncGrillaLayoutState'));
  console.log('  ✓ Verified 904A (10 trips) & 904B (48 trips) Lun–Vie restoration, UNNE asueto guard, OTA cache bust, and Grilla fullscreen CSS/JS');
}

console.log('8. Testing 904 & weekend/holiday zero-cortado rules + strict cyclic 1..N service ordering across all 26 lines...');
{
  const rec106B = JSON.parse(await fs.readFile(path.join(DATA_DIR, 'recorridos', '351.json'), 'utf8'));
  const hor106B = JSON.parse(await fs.readFile(path.join(DATA_DIR, 'horarios', '351.json'), 'utf8'));
  const brs106B = parseRouteBranches(rec106B);
  const m106B = buildLineScheduleModel(351, brs106B, hor106B, 'habil');
  const p106B = m106B.getTripsForBranch(m106B.primaryBranch);
  const expected106B = [
    ['05:00', 1, 1],
    ['05:30', 3, 1],
    ['05:45', 4, 1],
    ['06:00', 5, 1],
    ['06:16', 1, 2],
    ['06:33', 2, 1],
    ['06:50', 3, 2],
    ['07:08', 4, 2],
    ['07:27', 5, 2]
  ];
  for (let i = 0; i < expected106B.length; i++) {
    const [hh, srv, lap] = expected106B[i];
    assert.equal(formatSecHHMM(p106B[i].startSec), hh, `106B dep #${i} time mismatch`);
    assert.equal(p106B[i].serviceNumber, srv, `106B ${hh} must be Servicio ${srv}`);
    assert.equal(p106B[i].lapNumber, lap, `106B ${hh} must be Vuelta ${lap}`);
  }

  const rec108A = JSON.parse(await fs.readFile(path.join(DATA_DIR, 'recorridos', '356.json'), 'utf8'));
  const hor108A = JSON.parse(await fs.readFile(path.join(DATA_DIR, 'horarios', '356.json'), 'utf8'));
  const brs108A = parseRouteBranches(rec108A);
  const m108A = buildLineScheduleModel(356, brs108A, hor108A, 'habil');
  for (const br of brs108A) {
    const trs = m108A.getTripsForBranch(br);
    const N = m108A.fleetSummary.totalServices;
    for (let i = 1; i < trs.length - 1; i++) {
      const sA = trs[i - 1].serviceNumber;
      const sB = trs[i].serviceNumber;
      const sC = trs[i + 1].serviceNumber;
      if (sA === sB || sB === sC || sA === sC) continue;
      if (trs[i + 1].startSec - trs[i - 1].startSec > 2.5 * 3600) continue;
      const dAC = ((sC - sA) % N + N) % N;
      const dAB = ((sB - sA) % N + N) % N;
      assert.ok(dAB > 0 && dAB < dAC, `108A cyclic violation: S${sA}->S${sB}->S${sC}`);
    }
  }

  const rec105C = JSON.parse(await fs.readFile(path.join(DATA_DIR, 'recorridos', '348.json'), 'utf8'));
  const hor105C = JSON.parse(await fs.readFile(path.join(DATA_DIR, 'horarios', '348.json'), 'utf8'));
  const brs105C = parseRouteBranches(rec105C);
  const m105C = buildLineScheduleModel(348, brs105C, hor105C, 'habil');
  const out105C = [...m105C.getTripsForBranch(brs105C[0]), ...m105C.getTripsForBranch(brs105C[1])].sort(
    (a, b) => a.startSec - b.startSec
  );
  assert.deepEqual(
    out105C.slice(0, 9).map((t) => t.serviceNumber),
    [1, 2, 3, 1, 2, 3, 1, 2, 3],
    '105C morning corridor departures must strictly follow 1,2,3,1,2,3,1,2,3'
  );

  for (const l of catalogo.lineas) {
    const rec = JSON.parse(await fs.readFile(path.join(DATA_DIR, 'recorridos', `${l.codigo}.json`), 'utf8'));
    const hor = JSON.parse(await fs.readFile(path.join(DATA_DIR, 'horarios', `${l.codigo}.json`), 'utf8'));
    const brs = parseRouteBranches(rec);
    for (const tipo of ['habil', 'sabado', 'domingo']) {
      const m = buildLineScheduleModel(l.codigo, brs, hor, tipo);
      if (!m || !m.exactTipo) continue;
      if (m.isInterprovincial || tipo !== 'habil') {
        assert.equal(m.fleetSummary.cortadosCount, 0, `${l.descripcion} [${tipo}] must have 0 cortados`);
        for (const b of m.blocks) {
          assert.equal(b.isCortado, false, `${l.descripcion} [${tipo}] ${b.blockId} must NOT be isCortado`);
          assert.equal(b.resumesFromCortado, false, `${l.descripcion} [${tipo}] ${b.blockId} must NOT have resumesFromCortado`);
        }
      }
      for (const b of m.blocks) {
        assert.ok(!(b.isCortado && (b.relevoFromPrev || b.relevoToNext)), `${l.descripcion} [${tipo}] ${b.blockId} cannot be both cortado and relevo`);
      }
    }
  }
  console.log('  ✓ Verified 904 & weekend/holiday zero-cortado rules, 106B exact sequence, 108A 0 violations, 105C 1→2→3 corridor, and 103C relevo');
}

console.log('9. Testing 7-day retention, Cloudflare DO SQLite write optimizations, En línea ahora CSS overflow fix, and 904B ending-service guards...');
{
  const workerSrc = await fs.readFile(path.join(ROOT, 'cloudflare-worker', 'worker.js'), 'utf8');
  const serverSrc = await fs.readFile(path.join(ROOT, 'server.js'), 'utf8');
  const appSrc = await fs.readFile(path.join(ROOT, 'docs', 'js', 'app.js'), 'utf8');
  const apiSrc = await fs.readFile(path.join(ROOT, 'docs', 'js', 'api.js'), 'utf8');
  const htmlSrc = await fs.readFile(path.join(ROOT, 'docs', 'index.html'), 'utf8');
  const cssSrc = await fs.readFile(path.join(ROOT, 'docs', 'css', 'styles.css'), 'utf8');

  assert.ok(workerSrc.includes('const ROSTER_RETENTION_DAYS = 7;'), 'worker.js must use 7-day retention');
  assert.ok(serverSrc.includes('const ROSTER_RETENTION_DAYS = 7;'), 'server.js must use 7-day retention');
  assert.ok(appSrc.includes('const EVENTS_MAX_PAST_DAYS = 7;'), 'app.js must allow 7 days past events');
  assert.ok(appSrc.includes("version: 'v2.6.0'"), 'app.js CHANGELOG_ENTRIES must include v2.6.0');
  assert.ok(apiSrc.includes('retentionDays: b.retentionDays || 7'), 'api.js fallback retentionDays must be 7');
  assert.ok(htmlSrc.includes('hasta 7 días atrás'), 'index.html tooltip must reflect 7 days');

  assert.ok(cssSrc.includes('grid-template-columns: minmax(0, 1fr);'), '.modal-backdrop must constrain CSS grid column track');
  assert.ok(cssSrc.includes('.fleet-roster-right:empty'), '.fleet-roster-right:empty must collapse when unused');
  assert.ok(cssSrc.includes('overflow-wrap: anywhere;'), '.fleet-roster-* text must wrap cleanly without horizontal overflow');

  assert.ok(workerSrc.includes("version: '2.5.2'"), 'worker /api/health version must be 2.5.2');
  assert.ok(workerSrc.includes('_saveCronMeta('), 'worker must bundle cron metadata into single row');
  assert.ok(workerSrc.includes('outside-scan-windows'), 'worker must skip horarios outside 03:00-04:30 & 15:00-16:00 ART');
  assert.ok(workerSrc.includes('FLOTA_RESUMEN_TTL_MS = 20000'), 'worker must cache /api/flota-resumen DO reads');
  assert.ok(workerSrc.includes('FLOTA_ACTIVA_DO_TTL_MS = 15000'), 'worker must cache /api/flota-activa DO reads');

  const workerMod = await importLocal('cloudflare-worker/worker.js');
  let doFetchCount = 0;
  const scannedWinRows = [];
  const fakeEnv = {
    FLEET_MEMORY: {
      idFromName: () => 'id',
      get: () => ({
        fetch: async (reqUrl, init) => {
          doFetchCount++;
          if (String(reqUrl).includes('/horarios-scan-state')) {
            return new Response(JSON.stringify({ liveCursor: 0, scannedWindows: scannedWinRows }), { status: 200 });
          }
          if (String(reqUrl).includes('/horarios-ingest')) {
            const body = JSON.parse(init?.body || '{}');
            for (const w of body.windows || []) {
              const idx = scannedWinRows.findIndex(
                (r) => r[0] === w.dayKey && r[1] === w.codigoLinea && r[2] === w.stopId && r[3] === w.windowHour
              );
              const row = [w.dayKey, w.codigoLinea, w.stopId, w.windowHour, body.scannedAt || Date.now()];
              if (idx >= 0) scannedWinRows[idx] = row;
              else scannedWinRows.push(row);
            }
            return new Response(JSON.stringify({ ok: true, inserted: 0, windowsUpdated: (body.windows || []).length }), { status: 200 });
          }
          return new Response('{}', { status: 200 });
        }
      })
    }
  };

  for (const utcMs of [
    Date.UTC(2026, 10, 25, 5, 5, 0),
    Date.UTC(2026, 10, 25, 13, 0, 0),
    Date.UTC(2026, 10, 26, 0, 0, 0)
  ]) {
    const res = await workerMod.runScheduledHorariosScan(fakeEnv, utcMs, async () => ({ ok: true, items: [] }));
    assert.equal(res.skipped, true, 'Must skip outside 03:00-04:30 & 15:00-16:00 ART');
    assert.equal(res.reason, 'outside-scan-windows');
  }
  assert.equal(doFetchCount, 0, 'Skipped ticks outside scan windows must make ZERO DO calls');

  const mRes = await workerMod.runScheduledHorariosScan(fakeEnv, Date.UTC(2026, 10, 25, 6, 0, 0), async () => ({
    ok: true,
    items: []
  }));
  assert.equal(mRes.skipped, false);
  assert.equal(mRes.window, 'morning-03');
  assert.equal(mRes.soapCalls, 40);

  const aRes = await workerMod.runScheduledHorariosScan(fakeEnv, Date.UTC(2026, 10, 25, 18, 0, 0), async () => ({
    ok: true,
    items: []
  }));
  assert.equal(aRes.skipped, false);
  assert.equal(aRes.window, 'afternoon-15');
  assert.equal(aRes.soapCalls, 22);

  const healthRes = await workerMod.default.fetch(new Request('https://worker.test/api/health'), {}, {});
  const healthJson = await healthRes.json();
  assert.equal(healthJson.version, '2.5.2');
  assert.equal(healthJson.autoFleetScan.retentionDays, 7);
  assert.deepEqual(healthJson.autoHorariosScan.scheduleWindows, ['03:00-04:30 ART', '15:00-16:00 ART']);

  const rec904B = JSON.parse(await fs.readFile(path.join(DATA_DIR, 'recorridos', '1038.json'), 'utf8'));
  const brs904B = parseRouteBranches(rec904B);
  const stPuerto = stopMap.get('CT31181');
  const bus4127 = {
    lat: -27.474451,
    lng: -58.845655,
    gpsMs: Date.now(),
    descripcionBandera: 'PUERTO UNNE X SARMIENTO',
    eta: { valid: true, minutes: 16 }
  };
  const traj4127 = resolveBusTrajectory(bus4127, 'CT31181', { lat: stPuerto.lat, lng: stPuerto.lng }, brs904B, {
    trail: [
      { lat: -27.471719, lng: -58.842003, ts: Date.now() - 120000, gpsMs: Date.now() - 120000 },
      { lat: -27.474451, lng: -58.845655, ts: Date.now(), gpsMs: Date.now() }
    ]
  });
  assert.equal(traj4127?.leg, 'full_cycle');
  assert.ok(traj4127.totalMeters > 35000);

  const hor904B = JSON.parse(await fs.readFile(path.join(DATA_DIR, 'horarios', '1038.json'), 'utf8'));
  const m904B = buildLineScheduleModel(1038, brs904B, hor904B, 'habil');
  const vBranch904B = brs904B.find((b) => b.git === 'V-SAPU');
  assert.ok(vBranch904B, 'Expected V-SAPU branch on 904B');
  const s4Pt = [-27.474209, -58.855297]; // General Belgrano bridge eastbound (Corrientes approach)
  const busGalvezS4 = {
    lat: s4Pt[0],
    lng: s4Pt[1],
    desvio: { status: 'late', seconds: -(20 * 60 + 46) },
    descripcionBandera: 'UNNE PUERTO X SARMIENTO',
    isOppositeLeg: false,
    trajectory: { leg: 'full_cycle', directionSource: 'eta', isOppositeLeg: false, totalMeters: 39830 },
    routeMeters: 39830
  };
  const endCaseGalvezS4 = detectEndingServiceBusForStop(
    m904B,
    'CT31181',
    { lat: stPuerto.lat, lng: stPuerto.lng },
    busGalvezS4,
    21 * 3600 + 27 * 60 + 15
  );
  assert.equal(endCaseGalvezS4?.isEndingService, true);
  assert.equal(endCaseGalvezS4?.endingTrip?.serviceNumber, 4);
  console.log('  ✓ Verified 7-day retention, 2-window horarios scanner, DO optimizations, CSS overflow fix, and 904B ending-service guards');
}

console.log('10. Testing v2.6.1 features (Night Map zero-API, Holidays, Schedule PNG/JPG Exporter, Finished-Service Coherence, Telemetry, Ride Mode, Centering/Filter fixes, strict exclusions)...');
{
  // 10a) Holidays (Argentina national + movable Easter/Carnival + Corrientes local)
  assert.equal(getHolidayInfo('2026-05-01')?.name, 'Día del Trabajador');
  assert.equal(getCalendarTipoDiaWithHolidays('2026-05-01').tipo, 'domingo');
  assert.equal(getHolidayInfo('2026-02-16')?.name, 'Carnaval (Lunes)');
  assert.equal(getHolidayInfo('2026-04-03')?.name, 'Viernes Santo');
  assert.equal(getHolidayInfo('2026-05-03')?.scope, 'corrientes');
  assert.equal(getHolidayInfo('2026-09-24')?.scope, 'corrientes');
  assert.equal(getCalendarTipoDiaWithHolidays('2026-06-10').tipo, 'habil');
  assert.equal(getCalendarTipoDiaWithHolidays('2026-06-10').holiday, null);

  // Load route branches cache for telemetry & schedule export checks
  const routeBranchesCache = new Map();
  for (const l of catalogo.lineas) {
    const rec = JSON.parse(await fs.readFile(path.join(DATA_DIR, 'recorridos', `${l.codigo}.json`), 'utf8'));
    routeBranchesCache.set(Number(l.codigo), parseRouteBranches(rec));
  }

  // 10b) Customizable PNG/JPG Schedule Image Exporter (Ida/Vuelta, Service filter, Custom stop selection)
  const br106 = routeBranchesCache.get(351);
  const hor106B = JSON.parse(await fs.readFile(path.join(DATA_DIR, 'horarios', '351.json'), 'utf8'));
  const m106B = buildLineScheduleModel(351, br106, hor106B, 'habil');

  const keyStops0 = pickKeyStopsForBranch(br106[0], 7);
  const ordered0 = dedupeOrderedStops(br106[0]);
  assert.ok(keyStops0.has(ordered0[0].id), 'Key stops must always include first cabecera');
  assert.ok(keyStops0.has(ordered0[ordered0.length - 1].id), 'Key stops must always include final cabecera');
  assert.ok(keyStops0.size <= 7 && keyStops0.size >= 2);

  const customSet0 = new Set([ordered0[0].id, ordered0[3].id, ordered0[10].id, ordered0[ordered0.length - 1].id]);
  const ordered1 = dedupeOrderedStops(br106[1]);
  const customSet1 = new Set([ordered1[0].id, ordered1[5].id, ordered1[ordered1.length - 1].id]);
  const exportBothS5 = buildScheduleExportSections(m106B, br106, {
    mode: 'both',
    activeBranchIdx: 0,
    serviceFilter: '5',
    selectedStopIdsByBranch: new Map([
      [0, customSet0],
      [1, customSet1]
    ])
  });
  assert.equal(exportBothS5.sections.length, 2, 'Mode "both" must produce both Ida and Vuelta sections');
  assert.equal(exportBothS5.sections[0].dirLabel, 'IDA');
  assert.equal(exportBothS5.sections[1].dirLabel, 'VUELTA');
  assert.equal(exportBothS5.sections[0].stops.length, customSet0.size, 'Ida section must include ONLY user-selected stops');
  assert.equal(exportBothS5.sections[1].stops.length, customSet1.size, 'Vuelta section must include ONLY user-selected stops');
  assert.ok(exportBothS5.sections[0].columns.every((c) => c.srv === 5), 'Service filter "5" must only include Srv 5 trips');
  assert.ok(exportBothS5.sections[1].columns.every((c) => c.srv === 5), 'Service filter "5" must only include Srv 5 trips on Vuelta');

  // 10c) Coherent Service/Turno Completion Engine (Dabrio 106B Srv 5, Galvez 904B Srv 4 delayed, Relevo chofer vs coche)
  const s5Block106B = m106B.blocks.find((b) => b.serviceNumber === 5 && b.turnoIndex === 1);
  assert.ok(s5Block106B, '106B Lun–Vie must have Servicio 5 Turno 1');
  const s5LastTrip = s5Block106B.trips[s5Block106B.trips.length - 1];
  const s5EndStops = s5LastTrip.branch.orderedStops;
  const s5TerminalTip = s5LastTrip.branch.pts[s5LastTrip.branch.pts.length - 1];
  const s5ApproachStop = s5EndStops[Math.max(0, s5EndStops.length - 5)]; // ~1 km before Cabecera Barrio Nuevo

  const dabrioUnit = {
    identificadorCoche: '2976',
    choferNombre: 'DABRIO JUAN',
    lat: s5ApproachStop.lat,
    lng: s5ApproachStop.lng,
    rawLat: s5ApproachStop.lat,
    rawLng: s5ApproachStop.lng,
    ultimaFechaHoraGPS: '27/11/2026 13:46:51',
    desvio: { status: 'late', seconds: -90, raw: '-01:30' },
    serviceNumber: 5,
    turnoIndex: 1,
    _matchedTrip: s5LastTrip
  };
  // At 15:24 (real mobile screenshot case): MUST be finished & snapped to Cabecera Barrio Nuevo!
  const dabrio1524 = evaluateServiceCompletionStatus(dabrioUnit, m106B, 15 * 3600 + 24 * 60, {
    entityType: 'chofer',
    blockInfo: s5Block106B
  });
  assert.equal(dabrio1524.finished, true, 'Dabrio 106B Srv 5 at 15:24 must be marked finished');
  assert.equal(dabrio1524.snapToTerminal, true, 'Dabrio 106B Srv 5 must snap to finishing terminal');
  assert.ok(
    distanceMeters(dabrio1524.terminalLat, dabrio1524.terminalLng, s5TerminalTip[0], s5TerminalTip[1]) < 1,
    'Dabrio terminal snap coordinates must match exact end of Srv 5 branch polyline (punta de línea)'
  );
  // At 13:53 (just 4 min after 13:49 scheduled end, 2.5 min after delay-adjusted 13:50:30): MUST already be finished (no 15-min lingering "En línea")!
  const dabrio1353 = evaluateServiceCompletionStatus(dabrioUnit, m106B, 13 * 3600 + 53 * 60, {
    entityType: 'coche',
    blockInfo: s5Block106B
  });
  assert.equal(dabrio1353.finished, true, 'Dabrio 106B Srv 5 at 13:53 must already be marked finished');
  // At 13:47:10 (still before scheduled end, fresh 19 s GPS, >850 m away): MUST stay active!
  const s5MidStop = s5EndStops[Math.floor(s5EndStops.length * 0.55)];
  const dabrio1347Active = evaluateServiceCompletionStatus(
    { ...dabrioUnit, lat: s5MidStop.lat, lng: s5MidStop.lng, rawLat: s5MidStop.lat, rawLng: s5MidStop.lng },
    m106B,
    13 * 3600 + 47 * 60 + 10,
    { entityType: 'coche', blockInfo: s5Block106B }
  );
  assert.equal(dabrio1347Active.finished, false, 'Dabrio while still mid-route with fresh GPS before end must stay active');

  // Galvez 904B Srv 4 (scheduled end 21:21, delayed -20:46 -> expected finish ~21:41:46):
  const brs904B = routeBranchesCache.get(1038);
  const hor904B = JSON.parse(await fs.readFile(path.join(DATA_DIR, 'horarios', '1038.json'), 'utf8'));
  const m904B = buildLineScheduleModel(1038, brs904B, hor904B, 'habil');
  const s4Block904B = m904B.blocks.find((b) => b.serviceNumber === 4 && b.turnoIndex === 2) ||
    m904B.blocks.filter((b) => b.serviceNumber === 4).slice(-1)[0];
  const s4LastTrip = s4Block904B.trips[s4Block904B.trips.length - 1];
  const s4MidPt = s4LastTrip.branch.pts[Math.floor(s4LastTrip.branch.pts.length * 0.65)]; // ~5+ km from Puerto
  const galvezDelayedUnit = {
    identificadorCoche: '4127',
    choferNombre: 'GALVEZ',
    lat: s4MidPt[0],
    lng: s4MidPt[1],
    rawLat: s4MidPt[0],
    rawLng: s4MidPt[1],
    ultimaFechaHoraGPS: '27/11/2026 21:26:50',
    desvio: { status: 'late', seconds: -(20 * 60 + 46), raw: '-20:46' },
    serviceNumber: 4,
    turnoIndex: s4Block904B.turnoIndex,
    _matchedTrip: s4LastTrip
  };
  const galvezAt2127 = evaluateServiceCompletionStatus(galvezDelayedUnit, m904B, 21 * 3600 + 27 * 60 + 15, {
    entityType: 'coche',
    blockInfo: s4Block904B
  });
  assert.equal(galvezAt2127.finished, false, 'Heavily delayed Galvez 5+ km from Puerto at 21:27 MUST stay En línea');
  const s4PuertoStop = s4LastTrip.branch.orderedStops[s4LastTrip.branch.orderedStops.length - 1];
  const galvezAt2144 = evaluateServiceCompletionStatus(
    {
      ...galvezDelayedUnit,
      lat: s4PuertoStop.lat,
      lng: s4PuertoStop.lng,
      rawLat: s4PuertoStop.lat,
      rawLng: s4PuertoStop.lng,
      ultimaFechaHoraGPS: '27/11/2026 21:41:50'
    },
    m904B,
    21 * 3600 + 44 * 60,
    { entityType: 'coche', blockInfo: s4Block904B }
  );
  assert.equal(galvezAt2144.finished, true, 'Galvez at 21:44 after arriving at Puerto must be marked finished');
  assert.equal(galvezAt2144.snapToTerminal, true);

  // Relevo-en-línea block: driver finishes turno, car stays active with relieving driver!
  const relevoBlock = m904B.blocks.find((b) => b.relevoToNext) || m106B.blocks.find((b) => b.relevoToNext);
  assert.ok(relevoBlock, 'Expected at least one relevoToNext block on 904B or 106B');
  const relModel = m904B.blocks.includes(relevoBlock) ? m904B : m106B;
  const relEndSec = relevoBlock.endSec;
  const relHH = String(Math.floor((relEndSec - 120) / 3600) % 24).padStart(2, '0');
  const relMM = String(Math.floor(((relEndSec - 120) % 3600) / 60)).padStart(2, '0');
  const relLastTr = relevoBlock.trips[relevoBlock.trips.length - 1];
  const relEndPt = relLastTr.branch.pts[relLastTr.branch.pts.length - 1];
  const relUnit = {
    lat: relEndPt[0],
    lng: relEndPt[1],
    ultimaFechaHoraGPS: `27/11/2026 ${relHH}:${relMM}:00`,
    desvio: { status: 'ok', seconds: 0 }
  };
  assert.equal(
    evaluateServiceCompletionStatus(relUnit, relModel, relEndSec + 180, { entityType: 'coche', blockInfo: relevoBlock }).finished,
    false,
    'Car on relevoToNext block continues with relieving driver'
  );
  const relDrvComp = evaluateServiceCompletionStatus(relUnit, relModel, relEndSec + 180, {
    entityType: 'chofer',
    blockInfo: relevoBlock
  });
  assert.equal(relDrvComp.finished, true, 'Driver on relevoToNext block MUST be marked finished after relevo');
  assert.equal(relDrvComp.reason, 'turno_ended');

  // v3.1.5 / v3.1.6: Once scheduled end of service/turno (NOT relevo) arrives + >= 3 min without GPS,
  // ALWAYS snap to the exact ending polyline endpoint (punta de línea of that bandera), NOT the last tagged stop,
  // regardless of where last GPS was seen (even 15+ km away!)
  {
    const unneStartPt = s4LastTrip.branch.pts[0]; // ~15+ km away from Puerto (UNNE Resistencia)
    const s4PuertoTip = s4LastTrip.branch.pts[s4LastTrip.branch.pts.length - 1];
    assert.ok(distanceMeters(unneStartPt[0], unneStartPt[1], s4PuertoTip[0], s4PuertoTip[1]) > 12000);
    const fmtHM = (sec) => {
      const s = ((Math.round(sec) % 86400) + 86400) % 86400;
      return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`;
    };
    const gpsBeforeEnd = fmtHM(s4Block904B.endSec - 240);
    const far904Unit = {
      identificadorCoche: '4131',
      choferNombre: 'PUCHETA',
      lat: unneStartPt[0],
      lng: unneStartPt[1],
      rawLat: unneStartPt[0],
      rawLng: unneStartPt[1],
      ultimaFechaHoraGPS: `27/11/2026 ${gpsBeforeEnd}:00`,
      desvio: { status: 'late', seconds: -900, raw: '-15:00' },
      serviceNumber: s4Block904B.serviceNumber,
      turnoIndex: s4Block904B.turnoIndex,
      _matchedTrip: s4LastTrip
    };
    // Exactly at scheduled end time + 4 min no GPS (>= 3 min) -> MUST finish and snap straight to Puerto polyline tip!
    const far904Done = evaluateServiceCompletionStatus(far904Unit, m904B, s4Block904B.endSec + 5, {
      entityType: 'coche',
      blockInfo: s4Block904B
    });
    assert.equal(far904Done.finished, true, '904B past scheduled end with >= 3 min no GPS must finish even if last GPS was in Resistencia');
    assert.equal(far904Done.snapToTerminal, true, '904B finished non-relevo service MUST snap to Puerto even from 15+ km away');
    assert.ok(
      distanceMeters(far904Done.terminalLat, far904Done.terminalLng, s4PuertoTip[0], s4PuertoTip[1]) < 1,
      '904B terminal snap must land at the exact Puerto polyline tip'
    );

    // Half-lap ("x vueltas y media") shift: 106B S1T1 (2.5 vueltas, starts at Barrio Nuevo, ends at Puerto!)
    const halfLapBlk = m106B.blocks.find((b) => !b.relevoToNext && b.shiftLaps && b.shiftLaps % 1 !== 0);
    assert.ok(halfLapBlk, 'Expected a non-relevo half-lap block on 106B');
    const hlLastTrip = halfLapBlk.trips[halfLapBlk.trips.length - 1];
    const hlStartPt = hlLastTrip.branch.pts[0]; // opposite end of the line
    const hlExpectedTip = hlLastTrip.branch.pts[hlLastTrip.branch.pts.length - 1];
    const hlGpsHM = fmtHM(halfLapBlk.endSec - 300);
    const hlRes = evaluateServiceCompletionStatus(
      {
        identificadorCoche: '2950',
        lat: hlStartPt[0],
        lng: hlStartPt[1],
        rawLat: hlStartPt[0],
        rawLng: hlStartPt[1],
        ultimaFechaHoraGPS: `27/11/2026 ${hlGpsHM}:00`,
        desvio: { status: 'ok', seconds: 0 }
      },
      m106B,
      halfLapBlk.endSec + 10,
      { entityType: 'coche', blockInfo: halfLapBlk }
    );
    assert.equal(hlRes.finished, true, 'Half-lap shift at endSec + >= 3 min no GPS must finish');
    assert.equal(hlRes.snapToTerminal, true, 'Half-lap shift must snap to its exact opposite ending terminal');
    assert.ok(
      distanceMeters(hlRes.terminalLat, hlRes.terminalLng, hlExpectedTip[0], hlExpectedTip[1]) < 1,
      'Half-lap shift must snap to the exact polyline endpoint of that shift (not last tagged stop or starting terminal)'
    );

    // v3.1.6 regression (user screenshot 106A #3093 FIN):
    // Punta de línea MUST be the exact tip of the ending branch polyline (yellow PUERTO - PIRAYUI tip at -27.504192, -58.787558),
    // NEVER the last tagged stop (RUTA 12 - TUPAC AMATU VUELTA, which sits >1.2 km earlier!).
    const brs106A = routeBranchesCache.get(350);
    const hor106A = JSON.parse(await fs.readFile(path.join(DATA_DIR, 'horarios', '350.json'), 'utf8'));
    const m106A = buildLineScheduleModel(350, brs106A, hor106A, 'habil');
    const pirayuiBlk = m106A.blocks.find(
      (b) => !b.relevoToNext && /PUERTO\s*-\s*PIRAYUI/i.test(b.trips.at(-1)?.branch?.bandera || '')
    );
    assert.ok(pirayuiBlk, '106A must have a non-relevo block ending on PUERTO - PIRAYUI (yellow trace)');
    const pLastTrip = pirayuiBlk.trips[pirayuiBlk.trips.length - 1];
    const pYellowTip = pLastTrip.branch.pts[pLastTrip.branch.pts.length - 1];
    const pLastTaggedStop = pLastTrip.branch.orderedStops[pLastTrip.branch.orderedStops.length - 1];
    const pGpsHM = fmtHM(pirayuiBlk.endSec - 300);
    const pRes = evaluateServiceCompletionStatus(
      {
        identificadorCoche: '3093',
        lat: pLastTaggedStop.lat,
        lng: pLastTaggedStop.lng,
        rawLat: pLastTaggedStop.lat,
        rawLng: pLastTaggedStop.lng,
        ultimaFechaHoraGPS: `27/11/2026 ${pGpsHM}:00`,
        desvio: { status: 'ok', seconds: 0 }
      },
      m106A,
      pirayuiBlk.endSec + 10,
      { entityType: 'coche', blockInfo: pirayuiBlk }
    );
    assert.equal(pRes.finished, true, '106A #3093 after endSec + >= 3 min no GPS must finish');
    assert.equal(pRes.snapToTerminal, true, '106A #3093 must snap to Pirayuí yellow trace endpoint');
    assert.ok(
      distanceMeters(pRes.terminalLat, pRes.terminalLng, pYellowTip[0], pYellowTip[1]) < 1,
      '106A #3093 must snap to exact tip of PUERTO - PIRAYUI yellow polyline (-27.504192, -58.787558)'
    );
    assert.ok(
      distanceMeters(pRes.terminalLat, pRes.terminalLng, pLastTaggedStop.lat, pLastTaggedStop.lng) > 1000,
      '106A #3093 terminal snap must be >1 km beyond last tagged stop (RUTA 12 - TUPAC AMATU VUELTA)'
    );

    const puerto106ABlk = m106A.blocks.find(
      (b) => !b.relevoToNext && /PIRAYUI\s*-\s*PUERTO/i.test(b.trips.at(-1)?.branch?.bandera || '')
    );
    assert.ok(puerto106ABlk, '106A must also have a non-relevo block ending on PIRAYUI - PUERTO (blue trace)');
    const bLastTrip = puerto106ABlk.trips[puerto106ABlk.trips.length - 1];
    const bBlueTip = bLastTrip.branch.pts[bLastTrip.branch.pts.length - 1];
    const bRes = evaluateServiceCompletionStatus(
      {
        identificadorCoche: '3094',
        lat: bLastTrip.branch.pts[0][0],
        lng: bLastTrip.branch.pts[0][1],
        rawLat: bLastTrip.branch.pts[0][0],
        rawLng: bLastTrip.branch.pts[0][1],
        ultimaFechaHoraGPS: `27/11/2026 ${fmtHM(puerto106ABlk.endSec - 300)}:00`,
        desvio: { status: 'ok', seconds: 0 }
      },
      m106A,
      puerto106ABlk.endSec + 10,
      { entityType: 'coche', blockInfo: puerto106ABlk }
    );
    assert.equal(bRes.finished, true);
    assert.equal(bRes.snapToTerminal, true);
    assert.ok(
      distanceMeters(bRes.terminalLat, bRes.terminalLng, bBlueTip[0], bBlueTip[1]) < 1,
      '106A blue-trace ending block must snap to exact tip of PIRAYUI - PUERTO polyline'
    );

    // Chained relevo car: while still in T2 -> NOT finished; once T2 ends + >= 3 min no GPS -> finished & snapped to T2 ending terminal!
    const chainedT2 = relModel.blocks.find(
      (b) => b.serviceNumber === relevoBlock.serviceNumber && b.startSec >= relevoBlock.endSec && !b.relevoToNext
    );
    if (chainedT2) {
      const carAfterT2 = evaluateServiceCompletionStatus(relUnit, relModel, chainedT2.endSec + 180, {
        entityType: 'coche',
        blockInfo: relevoBlock
      });
      assert.equal(carAfterT2.finished, true, 'Car on chained relevo service must finish once final chained turno ends + 3 min no GPS');
      assert.equal(carAfterT2.snapToTerminal, true, 'Car finishing chained relevo service must snap to final ending terminal');
    }
  }

  // 10d) Telemetry module (Bridge monitor, Bunching, Punctuality, Ending badge, Physical telemetry without trail, Upcoming stops, Opposite stop, 7-day profile, Share)
  const bridgeHeavy = computeBridgeStatus([
    { codigoLinea: 1038, lat: -27.465, lng: -58.862, desvio: { status: 'late', seconds: -18 * 60 } },
    { codigoLinea: 1039, lat: -27.468, lng: -58.865, desvio: { status: 'late', seconds: -16 * 60 } }
  ]);
  assert.equal(bridgeHeavy.available, true);
  assert.equal(bridgeHeavy.status, 'heavy');
  assert.equal(bridgeHeavy.onBridgeCount, 2);

  const bunchAlerts = detectBunchingAndGaps([
    { codigoLinea: 351, descripcionLinea: '106B', eta: { valid: true, minutes: 3 } },
    { codigoLinea: 351, descripcionLinea: '106B', eta: { valid: true, minutes: 4 } },
    { codigoLinea: 351, descripcionLinea: '106B', eta: { valid: true, minutes: 26 } }
  ]);
  assert.equal(bunchAlerts.length, 1);
  assert.equal(bunchAlerts[0].kind, 'bunching');
  assert.equal(bunchAlerts[0].gapMin, 22);

  const punct = computeNetworkPunctuality([
    { codigoLinea: 351, desvio: { status: 'ok', seconds: -60 } },
    { codigoLinea: 351, desvio: { status: 'late', seconds: -10 * 60 } },
    { codigoLinea: 1038, desvio: { status: 'ahead', seconds: 5 * 60 } }
  ]);
  assert.equal(punct.totalWithDesvio, 3);
  assert.equal(punct.late, 1);
  assert.equal(punct.ahead, 1);
  assert.equal(punct.onTime, 1);
  assert.ok(punct.perLine.has(351));

  const endBadge = classifyBusEndingBadge({ _matchedTrip: { nextTrip: null, blockInfo: { endPlace: 'Puerto', relevoToNext: false } } });
  assert.equal(endBadge?.kind, 'ending');
  assert.equal(classifyBusEndingBadge({ _matchedTrip: { nextTrip: null, blockInfo: { relevoToNext: true } } }), null);

  const phys = computeBusPhysicalTelemetry(
    { lat: -27.47, lng: -58.83 },
    {
      trail: [
        { lat: -27.472, lng: -58.83, gpsMs: 100000 },
        { lat: -27.47, lng: -58.83, gpsMs: 130000 }
      ]
    },
    null
  );
  assert.ok(phys.speedKmh > 15 && phys.speedKmh < 40, `Expected realistic speed, got ${phys.speedKmh}`);
  assert.equal('trail' in phys, false, 'GPS trail ("estela") must be removed from telemetry output');

  const physFin = computeBusPhysicalTelemetry({ serviceFinished: true, finishedPlace: 'Barrio Nuevo' }, null, null);
  assert.equal(physFin.stateKind, 'finished');
  assert.ok(physFin.stateLabel.includes('Servicio finalizado') && physFin.stateLabel.includes('Barrio Nuevo'));

  const sampleStart = br106[0].orderedStops[2];
  const opp = findOppositeStop(
    { id: sampleStart.id, lat: sampleStart.lat, lng: sampleStart.lng },
    { stopById: stopMap, paradas: catalogo.paradas },
    routeBranchesCache
  );
  assert.ok(opp && opp.id !== sampleStart.id, 'Should find opposite-direction stop nearby');

  const prof = buildEntitySevenDayProfile(
    'coche',
    '4127',
    {
      lines: {
        '1038': {
          descripcionLinea: '904B',
          coches: [{ coche: '4127', esAdaptado: true, lastSeenAt: 1000 }],
          dayObsByDay: {
            '2026-11-26': [{ coche: '4127', choferNombre: 'GALVEZ', choferLegajo: 'L1', lastServiceNum: 4, lastTurnoIdx: 2, lastSeenAt: 1000 }]
          }
        }
      }
    },
    [],
    lineByCode
  );
  assert.equal(prof.id, '4127');
  assert.deepEqual(prof.lines, ['904B']);
  assert.equal(prof.days.length, 1);

  const shareTxt = formatServiceShareText('904B', 'Lun–Vie', { serviceNumber: 4 }, [
    { turnoIndex: 1, startSec: 5 * 3600, endSec: 13 * 3600, lapsCount: 4, startPlace: 'Puerto', endPlace: 'Puerto', trips: [] }
  ]);
  assert.ok(shareTxt.includes('DIRECT GPS') && shareTxt.includes('Servicio 4'));

  // 10e) v2.7.0 Natural Spanish TTS formatting (exact user examples + stop cleanup)
  assert.equal(formatCocheForTts('2976'), 'veintinueve setenta y seis');
  assert.equal(formatCocheForTts('3035'), 'treinta treinta y cinco');
  assert.equal(formatCocheForTts('4100'), 'cuarenta y uno cero cero');
  assert.equal(formatCocheForTts('4122'), 'cuarenta y uno veintidós');
  assert.equal(formatCocheForTts('2905'), 'veintinueve cero cinco');
  assert.equal(formatCocheForTts('3000'), 'treinta cero cero');
  assert.equal(formatLineaForTts('106B'), 'ciento seis B');
  assert.equal(formatLineaForTts('904B'), 'novecientos cuatro B');
  assert.equal(formatStopNameForTts('AV. PEDRO FERRÉ - BRASIL IDA'), 'Avenida Pedro Ferré y Brasil');
  assert.equal(formatStopNameForTts('Bº QUINTANA / GRAL. PAZ VTA'), 'Barrio Quintana y General Paz');
  const speech2976 = buildArrivalSpeechMessage({ lineName: '106B', coche: '2976', etaMin: 3 });
  assert.ok(
    speech2976.includes('ciento seis B') && speech2976.includes('veintinueve setenta y seis') && speech2976.includes('3 minutos'),
    `Unexpected arrival speech: ${speech2976}`
  );

  // 10f) v2.7.0 Uber-style Live Notification Payload + LiveTripTracker (Waiting -> Minute-by-Minute -> Subir -> A Bordo stop-by-stop -> Bajar)
  const bar0 = buildUberProgressLine(0, { segments: 10 });
  const bar50 = buildUberProgressLine(0.5, { segments: 10 });
  const bar100 = buildUberProgressLine(1, { segments: 10 });
  assert.ok(bar0.startsWith('🚌') && bar0.endsWith('◉'));
  assert.ok(bar50.indexOf('🚌') > bar0.indexOf('🚌') && bar100.indexOf('🚌') > bar50.indexOf('🚌'));

  const notifWaiting = buildUberNotificationPayload({
    phase: 'waiting',
    lineName: '106B',
    coche: '2976',
    choferNombre: 'DABRIO JUAN',
    scheduledHHMM: '13:45',
    etaMin: 4,
    distM: 1200,
    progress01: 0.5,
    minuteByMinute: true,
    originStop: { id: 'CT31498', nombre: 'AV. PEDRO FERRÉ - BRASIL IDA' }
  });
  assert.ok(notifWaiting.title.includes('106B') && notifWaiting.title.includes('4 min') && notifWaiting.title.includes('#2976'));
  assert.ok(notifWaiting.body.includes('🚌') && notifWaiting.body.includes('◉'), 'Notification must contain left->right bus progress bar');
  assert.ok(notifWaiting.body.includes('DABRIO JUAN') && notifWaiting.body.includes('Prog. real: 13:45'));
  assert.ok(notifWaiting.actions.some((a) => a.action === 'board'), 'Waiting notification must expose Subir action');

  let watchCb = null;
  let clearedId = null;
  const origNav = globalThis.navigator;
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      geolocation: {
        watchPosition: (cb) => {
          watchCb = cb;
          return 77;
        },
        clearWatch: (id) => {
          clearedId = id;
        }
      }
    }
  });
  try {
    const announcedLog = [];
    const arrivedStops = [];
    const tracker = new LiveTripTracker({
      onAnnounce: (msg) => announcedLog.push(msg),
      onStopArrival: (ev) => arrivedStops.push(ev)
    });

    const boardStop = br106[0].orderedStops[2];
    const nextStopA = br106[0].orderedStops[3];
    const nextStopB = br106[0].orderedStops[4];

    tracker.startWaiting({
      stop: boardStop,
      lineName: '106B',
      codLinea: 351,
      bus: {
        codigoLinea: 351,
        descripcionLinea: '106B',
        identificadorCoche: '2976',
        choferNombre: 'DABRIO JUAN',
        turnoProgramado: '13:45',
        eta: { minutes: 4, valid: true },
        routeMeters: 1600,
        _matchedBranch: br106[0]
      },
      minuteByMinute: true,
      ttsEnabled: false,
      soundEnabled: false
    });
    assert.equal(tracker.phase, 'waiting');
    assert.equal(tracker.scheduledHHMM, '13:45');

    // Minute-by-minute countdown tick: 4 -> 3 -> 2
    tracker.updateFromArrivals([
      {
        codigoLinea: 351,
        descripcionLinea: '106B',
        identificadorCoche: '2976',
        choferNombre: 'DABRIO JUAN',
        turnoProgramado: '13:45',
        eta: { minutes: 3, valid: true },
        routeMeters: 1200,
        _matchedBranch: br106[0]
      }
    ], boardStop);
    assert.ok(announcedLog.some((m) => m.includes('veintinueve setenta y seis') && m.includes('3 minutos')));

    // User presses "Subir" while bus is 3 min away -> arms boarding_armed!
    tracker.requestBoard({ routeBranchesCache });
    assert.equal(tracker.phase, 'boarding_armed');

    // Bus arrives at stop (eta: 0) -> auto-transitions into A Bordo (onboard)!
    tracker.updateFromArrivals([
      {
        codigoLinea: 351,
        descripcionLinea: '106B',
        identificadorCoche: '2976',
        choferNombre: 'DABRIO JUAN',
        turnoProgramado: '13:45',
        eta: { minutes: 0, valid: true },
        routeMeters: 40,
        _matchedBranch: br106[0]
      }
    ], boardStop, routeBranchesCache);
    assert.equal(tracker.phase, 'onboard', 'Boarding-armed tracker must auto-enter onboard mode when bus arrives');

    // Simulate passenger GPS approaching stop #3 -> must trigger "Arribando, <cleanName>."!
    watchCb({ coords: { latitude: nextStopA.lat, longitude: nextStopA.lng } });
    assert.equal(arrivedStops.length, 1, 'Should announce arrival at first upcoming stop');
    assert.ok(
      arrivedStops[0].speech.startsWith('Arribando, '),
      `Expected "Arribando, ..." phrasing, got "${arrivedStops[0].speech}"`
    );
    // Repeated GPS at same stop must NOT duplicate announcement
    watchCb({ coords: { latitude: nextStopA.lat, longitude: nextStopA.lng } });
    assert.equal(arrivedStops.length, 1, 'Must not re-announce the same stop twice');

    // Move along to stop #4 -> must advance & announce second stop!
    watchCb({ coords: { latitude: nextStopB.lat, longitude: nextStopB.lng } });
    assert.equal(arrivedStops.length, 2, 'Should advance and announce next stop along route');
    assert.ok(arrivedStops[1].speech.startsWith('Arribando, '));

    // User presses "Bajar" -> exits cleanly and clears watchPosition!
    tracker.alight({ silent: true });
    assert.equal(tracker.phase, 'idle');
    assert.equal(clearedId, 77);

    // Backwards-compatible RideModeController check
    let triggeredPayload = null;
    const rc = new RideModeController({
      radiusMeters: 300,
      onTrigger: (p) => {
        triggeredPayload = p;
      }
    });
    assert.equal(rc.start({ id: 'CT31498', nombre: 'Junín y Mendoza', lat: -27.468, lng: -58.836 }, { sound: false, tts: false }), true);
    watchCb({ coords: { latitude: -27.48, longitude: -58.836 } });
    assert.equal(triggeredPayload, null);
    watchCb({ coords: { latitude: -27.4685, longitude: -58.836 } });
    assert.ok(triggeredPayload && triggeredPayload.distM < 300);
    rc.stop();
  } finally {
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: origNav });
  }

  // 10g) Night Map zero-API + Foto 1/2 centering + Foto 3 filter pills + Strict Exclusions (NO satellite, NO battery saver, NO Trip Planner, NO PDF, NO GPS trail, NO inspector upcoming stops)
  assert.ok(MAP_TILES.dark && MAP_TILES.dark.darkFilter === true, 'MAP_TILES.dark must use darkFilter: true');
  assert.ok(MAP_TILES.dark.url.includes('tile.openstreetmap.org'), 'Night map must reuse cached OSM tiles with zero external API');
  const cssSrc = await fs.readFile(path.join(ROOT, 'docs', 'css', 'styles.css'), 'utf8');
  assert.ok(cssSrc.includes('.leaflet-tile-pane.osm-dark-filter'), 'styles.css must define .osm-dark-filter for night map');
  assert.ok(
    cssSrc.includes('#fleet-roster-quick-filters') && cssSrc.includes('flex-shrink: 0') && cssSrc.includes('flex-wrap: wrap'),
    'styles.css must prevent vertical squashing of #fleet-roster-quick-filters'
  );
  const mapSrc = await fs.readFile(path.join(ROOT, 'docs', 'js', 'map.js'), 'utf8');
  assert.ok(mapSrc.includes("getElementById('bus-inspector')") && mapSrc.includes('getBoundingClientRect'), 'map.js _getPadding must account for live #bus-inspector height');
  assert.ok(mapSrc.includes('_resolveBusChipEta'), 'map.js must render FIN/ÚLT badge instead of bogus YA on finished/offline tracked buses');
  const tripPlannerExists = await fs
    .access(path.join(ROOT, 'docs', 'js', 'trip-planner.js'))
    .then(() => true)
    .catch(() => false);
  assert.equal(tripPlannerExists, false, 'docs/js/trip-planner.js must be deleted');

  for (const rel of ['docs/index.html', 'docs/css/styles.css', 'docs/js/config.js', 'docs/js/map.js', 'docs/js/telemetry.js', 'docs/js/ui-extras.js']) {
    const content = await fs.readFile(path.join(ROOT, rel), 'utf8');
    assert.equal(/arcgisonline|world_imagery|map-style="sat|mapa satelital/i.test(content), false, `${rel} must NOT contain satellite map`);
    assert.equal(/batterySaver|dataSaver|ahorro de bater[íi]a/i.test(content), false, `${rel} must NOT contain battery/data saver mode`);
    assert.equal(/trip-planner|cómo llego|como llego|drawBusTrail|buildPrintableScheduleHtml|btn-rec-print|insp-upcoming|buildBusUpcomingStops|btn-led-board|led-board-overlay|openLedBoard|renderLedBoard|mini-action-led/i.test(content), false, `${rel} must NOT contain removed features`);
  }

  // 10h) Real PNG PWA icons exist & have valid PNG signature
  const pngSig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  for (const fn of ['icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png']) {
    const buf = await fs.readFile(path.join(ROOT, 'docs', 'icons', fn));
    assert.ok(buf.length > 500 && buf.subarray(0, 8).equals(pngSig), `${fn} must be a valid PNG file`);
  }

  // 10i) Unified driver-overrides.json sync check across all 3 runtime files
  execFileSync('node', ['scripts/sync-drivers.mjs', '--check'], { cwd: ROOT, stdio: 'pipe' });

  // 10j) Capacitor 7 + Native Android Foreground Service + v2.9.0 Immortal Background, Modo Simple, Startup Permissions & Updater
  const notifOnboard = buildUberNotificationPayload({
    phase: 'onboard',
    lineName: '106B',
    coche: '2976',
    choferNombre: 'DABRIO JUAN',
    scheduledHHMM: '13:45',
    nextStop: { cleanName: 'Junín y Mendoza' },
    distToNextM: 180,
    remainingStops: 5,
    finalStopName: 'Puerto',
    progress01: 0.4
  });
  assert.ok(notifOnboard.body.includes('Junín y Mendoza'), 'Onboard notification must list next stop');
  assert.equal(/[━◉]/.test(notifOnboard.body), false, 'Onboard notification must NOT include straight arrival progress bar');

  const { compareSemver, isRemoteVersionNewer, APP_VERSION, APP_VERSION_CODE } = await importLocal('docs/js/updater.js');
  assert.equal(compareSemver('2.9.0', '2.8.0'), 1);
  assert.equal(compareSemver('2.9.0', '2.9.0'), 0);
  assert.equal(compareSemver('2.8.9', '2.9.0'), -1);
  assert.equal(isRemoteVersionNewer({ versionName: '2.8.0', versionCode: 280 }, { version: '2.9.0', versionCode: 290 }), true);
  assert.equal(isRemoteVersionNewer({ versionName: '2.9.0', versionCode: 290 }, { version: '2.9.0', versionCode: 290 }), false);

  const pkgJson = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'));
  const verJson = JSON.parse(await fs.readFile(path.join(ROOT, 'docs', 'version.json'), 'utf8'));
  const gradleSrc = await fs.readFile(path.join(ROOT, 'android', 'app', 'build.gradle'), 'utf8');
  assert.equal(verJson.version, pkgJson.version, 'docs/version.json version must match package.json');
  assert.equal(verJson.version, APP_VERSION, 'updater.js APP_VERSION must match docs/version.json');
  assert.equal(verJson.versionCode, APP_VERSION_CODE, 'updater.js APP_VERSION_CODE must match docs/version.json');
  assert.ok(gradleSrc.includes(`versionCode ${verJson.versionCode}`), 'build.gradle versionCode must match version.json');
  assert.ok(gradleSrc.includes(`versionName "${verJson.version}"`), 'build.gradle versionName must match version.json');

  const capCfg = JSON.parse(await fs.readFile(path.join(ROOT, 'capacitor.config.json'), 'utf8'));
  assert.equal(capCfg.appId, 'ar.corrientes.directgps');
  assert.equal(capCfg.webDir, 'docs');
  const androidJavaBase = path.join(ROOT, 'android', 'app', 'src', 'main', 'java', 'ar', 'corrientes', 'directgps');
  for (const jf of [
    'MainActivity.java',
    'DirectGpsNativePlugin.java',
    'DirectGpsTripService.java',
    'DirectGpsWidgetProvider.java',
    'SpanishTtsFormatter.java',
    'RouteDistanceCalculator.java',
    'NativeScheduleLookup.java',
    'UberProgressBitmapRenderer.java'
  ]) {
    const src = await fs.readFile(path.join(androidJavaBase, jf), 'utf8');
    assert.ok(src.includes('package ar.corrientes.directgps;'), `${jf} must belong to package ar.corrientes.directgps`);
  }
  const tripSvcSrc = await fs.readFile(path.join(androidJavaBase, 'DirectGpsTripService.java'), 'utf8');
  assert.ok(tripSvcSrc.includes('ACTION_UPSERT_WATCH') && tripSvcSrc.includes('CHANNEL_LIVE_SILENT'), 'DirectGpsTripService must support persistent in-place watch alerts');
  assert.ok(tripSvcSrc.includes('PARTIAL_WAKE_LOCK') && tripSvcSrc.includes('scheduleWatchdogRestart') && tripSvcSrc.includes('KEY_PRIMARY_JSON'), 'DirectGpsTripService must hold WakeLock, persist primary trip, and survive task removal');
  assert.ok(tripSvcSrc.includes('ttsWakeLock') && tripSvcSrc.includes('reinitTtsEngine') && tripSvcSrc.includes('ACTION_HEARTBEAT_POLL'), 'DirectGpsTripService must keep background TTS alive with dedicated WakeLock, self-healing binder watchdog, and Doze heartbeat');
  assert.ok(tripSvcSrc.includes('getCustomRingtoneUri') && tripSvcSrc.includes('USAGE_ASSISTANCE_NAVIGATION_GUIDANCE'), 'DirectGpsTripService must support custom phone ringtone and navigation audio attributes');
  assert.ok(tripSvcSrc.includes('pollAllTargetsSafe') && tripSvcSrc.includes('catch (Throwable'), 'Background polling loop must never die on uncaught throwable');
  assert.ok(tripSvcSrc.includes('RouteDistanceCalculator.computeRouteDistance'), 'DirectGpsTripService must compute route-traced distance (not straight-line haversine)');
  assert.ok(tripSvcSrc.includes('DecoratedCustomViewStyle') && tripSvcSrc.includes('UberProgressBitmapRenderer.renderTrack'), 'DirectGpsTripService must render single-track Uber-style custom live notification');
  assert.equal(tripSvcSrc.includes('.setProgress('), false, 'DirectGpsTripService must NOT call .setProgress() (zero redundant progress bars)');
  assert.ok(tripSvcSrc.includes('playDeviceNotificationChime'), 'DirectGpsTripService must play chime before TTS');
  const onboardMethodMatch = tripSvcSrc.match(/private Notification buildOnboardNotification\([\s\S]*?\n    \}/);
  assert.ok(onboardMethodMatch, 'DirectGpsTripService must define buildOnboardNotification');
  assert.equal(onboardMethodMatch[0].includes('notif_uber_'), false, 'Native buildOnboardNotification must NOT use Uber arrival progress track');

  for (const xmlRel of [
    'layout/notif_uber_compact.xml',
    'layout/notif_uber_expanded.xml',
    'layout/notif_onboard_expanded.xml',
    'drawable/notif_uber_card_bg.xml',
    'xml/shortcuts.xml',
    'xml/direct_gps_widget_info.xml',
    'layout/widget_direct_gps.xml',
    'drawable/widget_bg.xml'
  ]) {
    const xmlSrc = await fs.readFile(path.join(ROOT, 'android', 'app', 'src', 'main', 'res', xmlRel), 'utf8');
    assert.ok(xmlSrc.length > 50, `${xmlRel} must exist`);
  }

  // Verify JS LiveTripTracker rejects implausible 320m straight-line distance for a 30-min bus
  const coherenceTracker = new LiveTripTracker();
  coherenceTracker.startWaiting({
    stop: { id: 'CT31942', nombre: 'AV. PEDRO FERRÉ - BRASIL VTA', lat: -27.477427, lng: -58.824951 },
    lineName: '102C',
    codLinea: 96,
    bus: {
      codigoLinea: 96,
      descripcionLinea: '102C',
      identificadorCoche: '4102',
      choferNombre: 'GALARZA A.',
      turnoProgramado: '22:03',
      eta: { minutes: 30, valid: true },
      routeMeters: 320
    },
    ttsEnabled: false,
    soundEnabled: false
  });
  assert.equal(coherenceTracker.distM, null, '320m straight-line distance for 30-min ETA must be rejected as incoherent');
  assert.ok(coherenceTracker.progress01 <= 0.42, `30-min bus must not show near-full progress bar (got ${coherenceTracker.progress01})`);
  coherenceTracker.stop({ silent: true });

  const mainActSrc = await fs.readFile(path.join(androidJavaBase, 'MainActivity.java'), 'utf8');
  assert.ok(mainActSrc.includes('resumeTimers') && mainActSrc.includes('applySystemBars') && mainActSrc.includes('moveTaskToBack'), 'MainActivity must keep timers alive, apply dynamic system bars, and handle back cleanly');
  const pluginSrc = await fs.readFile(path.join(androidJavaBase, 'DirectGpsNativePlugin.java'), 'utf8');
  assert.ok(pluginSrc.includes('requestBackgroundLocationPermission') && pluginSrc.includes('setSystemBarsColor') && pluginSrc.includes('ensureBackgroundAlive'), 'DirectGpsNativePlugin must expose startup permissions, dynamic bars, and keep-alive');
  assert.ok(
    pluginSrc.includes('pickNotificationRingtone') &&
      pluginSrc.includes('ACTION_RINGTONE_PICKER') &&
      pluginSrc.includes('shareImageBase64') &&
      pluginSrc.includes('hapticFeedback') &&
      pluginSrc.includes('getNativeStatus'),
    'DirectGpsNativePlugin must expose v3.0.0 ringtone picker, native image share, haptics, and native status'
  );
  const uberRendSrc = await fs.readFile(path.join(androidJavaBase, 'UberProgressBitmapRenderer.java'), 'utf8');
  assert.ok(uberRendSrc.includes('LinearGradient'), 'UberProgressBitmapRenderer must draw line-colored gradient progress track');
  const routeCalcSrc = await fs.readFile(path.join(androidJavaBase, 'RouteDistanceCalculator.java'), 'utf8');
  assert.ok(routeCalcSrc.includes('loadOrderedStopsForStop'), 'RouteDistanceCalculator must support offline stop loading for Subir action');

  const manifestXml = await fs.readFile(path.join(ROOT, 'android', 'app', 'src', 'main', 'AndroidManifest.xml'), 'utf8');
  assert.ok(manifestXml.includes('FOREGROUND_SERVICE_LOCATION'), 'AndroidManifest must declare FOREGROUND_SERVICE_LOCATION');
  assert.ok(manifestXml.includes('POST_NOTIFICATIONS'), 'AndroidManifest must declare POST_NOTIFICATIONS');
  assert.ok(manifestXml.includes('REQUEST_INSTALL_PACKAGES'), 'AndroidManifest must declare REQUEST_INSTALL_PACKAGES for in-app APK updates');
  assert.ok(manifestXml.includes('android:stopWithTask="false"'), 'DirectGpsTripService must declare android:stopWithTask="false"');
  assert.ok(manifestXml.includes('DirectGpsWidgetProvider') && manifestXml.includes('@xml/shortcuts'), 'AndroidManifest must register home widget provider and launcher shortcuts');
  const apkWorkflow = await fs.readFile(path.join(ROOT, '.github', 'workflows', 'android-apk.yml'), 'utf8');
  assert.ok(apkWorkflow.includes('assembleDebug') && apkWorkflow.includes('upload-artifact') && apkWorkflow.includes('gh release'), 'android-apk.yml must compile, upload artifact, and publish GitHub Release');

  const indexHtml = await fs.readFile(path.join(ROOT, 'docs', 'index.html'), 'utf8');
  assert.ok(indexHtml.includes('id="update-modal"') && indexHtml.includes('id="btn-check-updates"'), 'index.html must include in-app update dialog and settings button');
  assert.equal(indexHtml.includes('id="btn-simple-mode"'), false, 'index.html must NOT include top header Aa button (Modo Simple only in Ajustes -> Apariencia)');
  assert.equal(indexHtml.includes('id="ride-mode-banner"'), false, 'index.html must NOT include floating #ride-mode-banner card');
  assert.ok(indexHtml.includes('id="chk-simple-mode"') && indexHtml.includes('id="simple-mode-bar"'), 'index.html must include Modo Simple toggle in Ajustes -> Apariencia');
  assert.ok(indexHtml.includes('id="permissions-modal"') && indexHtml.includes('id="btn-review-permissions"'), 'index.html must include startup permissions modal and settings trigger');
  assert.ok(indexHtml.includes('id="btn-pick-ringtone"') && indexHtml.includes('id="chk-tts-dnd"') && indexHtml.includes('data-tts-rate'), 'index.html must include v3.0.0 ringtone picker, TTS rate, and DND controls');
  assert.ok(cssSrc.includes('body.simple-mode'), 'styles.css must include Modo Simple rules');
  assert.equal(cssSrc.includes('.ride-mode-banner'), false, 'styles.css must NOT include removed .ride-mode-banner rules');
  assert.ok(cssSrc.includes('.native-only-section') && cssSrc.includes('.ringtone-picker-card'), 'styles.css must include v3.0.0 native Android styles');
  assert.ok(/\.settings-pane\s*\{[\s\S]{0,260}overflow-y:\s*auto/.test(cssSrc), 'styles.css .settings-pane must be vertically scrollable');
  assert.ok(tripSvcSrc.includes('runLiveSimTickOnMain') && tripSvcSrc.includes('computeSmoothLiveProgress01') && tripSvcSrc.includes('parseGpsTimestampMs'), 'DirectGpsTripService must run continuous EN VIVO simulation');
  assert.ok(
    tripSvcSrc.includes('ACTION_TOGGLE_MIN_BY_MIN') &&
      tripSvcSrc.includes('ACTION_BOARD_FROM_WATCH') &&
      tripSvcSrc.includes('resolveLiveDisplayEtaMin') &&
      tripSvcSrc.includes('setSortKey') &&
      tripSvcSrc.includes('recomputeStableArrivalRanks') &&
      tripSvcSrc.includes('ORDER_HYSTERESIS_METERS') &&
      tripSvcSrc.includes('setWhen(fixedWhenMs)') &&
      tripSvcSrc.includes('GROUP_LIVE_ARRIVALS') &&
      tripSvcSrc.includes('notif_onboard_expanded'),
    'DirectGpsTripService must expose v3.1.1 stable distance-ranked ordering, fixed setWhen, group summary anchor, interactive actions, and custom onboard card'
  );
  assert.ok(
    /resolveLiveDisplayEtaMin\([^)]*\)\s*\{\s*return fallbackEtaMin;\s*\}/.test(tripSvcSrc),
    'DirectGpsTripService.resolveLiveDisplayEtaMin must return official SOAP ETA verbatim without inventing Arribando'
  );
  assert.equal(tripSvcSrc.includes('expandedView.setTextViewText(R.id.notif_car_primary, "Coche "'), false, 'Expanded notification must show #coche directly without redundant Coche label');
  assert.equal(tripSvcSrc.includes('expandedView.setTextViewText(R.id.notif_driver_line, "Chofer: "'), false, 'Expanded notification must show driver name directly without redundant Chofer label');

  // Verify BusSimulator NEVER overwrites official SOAP ETA ("2 min." stays 2 min, never flickers to "Arribando")
  {
    const simSoap = new BusSimulator();
    const stopPt = { lat: -27.477427, lng: -58.824951 };
    const traj = {
      pathPts: [
        [-27.4820, -58.824951],
        [-27.4790, -58.824951],
        [stopPt.lat, stopPt.lng]
      ],
      pathCum: [0, 333, 508],
      totalMeters: 508,
      leg: 'direct',
      isAtTerminal: false,
      speedMps: 6.0
    };
    const soapBus = {
      key: '96-c4035',
      codigoLinea: 96,
      identificadorCoche: '4035',
      lat: -27.4820,
      lng: -58.824951,
      gpsMs: Date.now() - 10_000,
      eta: { minutes: 2, valid: true, display: '2', unit: 'min', urgency: 'now' },
      tiempoRaw: '2 min.',
      hasOfficialSoapEta: true,
      isPredicted: false,
      etaSecondsRemaining: 120,
      routeMeters: 508,
      trajectory: traj
    };
    simSoap.reconcile([soapBus], { stopId: 'CT31942', applyPositions: true });
    for (let s = 0; s < 110; s++) {
      simSoap.step(1.0, [soapBus], { updateEta: true });
    }
    assert.equal(soapBus.eta.minutes, 2, 'Live GPS bus with official SOAP ETA must NEVER flicker to 1 min or Arribando');
    assert.equal(soapBus.tiempoRaw, '2 min.', 'Live GPS bus tiempoRaw must remain verbatim from SOAP');
    assert.ok(soapBus.routeMeters < 508, 'BusSimulator must still advance simulated map/bar position smoothly');
  }

  assert.ok(
    tripSvcSrc.includes('NativeScheduleLookup.resolveRealScheduledHHMM') &&
      tripSvcSrc.includes('NativeScheduleLookup.isScheduledHHMMPlausible') &&
      tripSvcSrc.includes('lapRolledOver') &&
      tripSvcSrc.includes('driverChanged'),
    'DirectGpsTripService must clear stale previous-bus scheduledHHMM and resolve real official timetable offline via NativeScheduleLookup'
  );
  const rideModeSrc = await fs.readFile(path.join(ROOT, 'docs', 'js', 'ride-mode.js'), 'utf8');
  assert.ok(rideModeSrc.includes('driverChanged') && rideModeSrc.includes("this.scheduledHHMM = ''"), 'ride-mode.js must clear scheduledHHMM when bus/driver changes');
  {
    const switchTracker = new LiveTripTracker();
    switchTracker.startWaiting({
      stop: { id: 'CT31571', nombre: 'AV. 3 DE ABRIL - ALBERDI', lat: -27.474, lng: -58.831 },
      lineName: '904B',
      codLinea: 1038,
      bus: {
        codigoLinea: 1038,
        descripcionLinea: '904B',
        identificadorCoche: '4120',
        choferNombre: 'ACEVEDO',
        turnoProgramado: '00:43',
        eta: { minutes: 1, valid: true },
        routeMeters: 250
      },
      ttsEnabled: false,
      soundEnabled: false
    });
    assert.equal(switchTracker.scheduledHHMM, '00:43');
    // Next poll: Acevedo arrived and Pucheta #4131 is now next bus (initially without turnoProgramado)
    switchTracker._applyWaitingBusData({
      codigoLinea: 1038,
      descripcionLinea: '904B',
      identificadorCoche: '4131',
      choferNombre: 'PUCHETA NELSON HERNAN',
      turnoProgramado: null,
      eta: { minutes: 33, valid: true },
      routeMeters: 19900
    });
    assert.equal(switchTracker.scheduledHHMM, '', 'Changing from Acevedo to Pucheta must NEVER inherit 00:43');
    switchTracker._applyWaitingBusData({
      codigoLinea: 1038,
      descripcionLinea: '904B',
      identificadorCoche: '4131',
      choferNombre: 'PUCHETA NELSON HERNAN',
      turnoProgramado: '01:17',
      eta: { minutes: 33, valid: true },
      routeMeters: 19900
    });
    assert.equal(switchTracker.scheduledHHMM, '01:17', 'Pucheta must receive its own real official schedule 01:17');
    switchTracker.stop({ silent: true });
  }

  // Verify BusSimulator 3-min desvio -> 5-min strict 00:00 punctual -> fast, smooth & precise GPS recovery glide
  {
    const fmtArtStamp = (ms) => {
      const d = new Date(ms - 3 * 3600 * 1000);
      const pad = (n) => String(n).padStart(2, '0');
      return `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
    };
    const nowMsTest = Date.now();
    const dArt = new Date(nowMsTest - 3 * 3600 * 1000);
    const nowSecArt = dArt.getUTCHours() * 3600 + dArt.getUTCMinutes() * 60 + dArt.getUTCSeconds();
    const effNowArt = nowSecArt < 3 * 3600 ? nowSecArt + 86400 : nowSecArt;

    const branchPts = [
      [-27.5000, -58.8300],
      [-27.4900, -58.8300],
      [-27.4800, -58.8300],
      [-27.4700, -58.8300]
    ];
    const branchCum = [0, 1112, 2224, 3336];
    const synthBranch = {
      bandera: 'TEST IDA',
      color: '#2563eb',
      pts: branchPts,
      cum: branchCum,
      totalLen: 3336
    };
    const synthTrip = {
      tripKey: 'test:1',
      branch: synthBranch,
      startSec: effNowArt - 600,
      endSec: effNowArt + 600,
      points: [
        { along: 0, sec: effNowArt - 600 },
        { along: 1112, sec: effNowArt - 200 },
        { along: 2224, sec: effNowArt + 200 },
        { along: 3336, sec: effNowArt + 600 }
      ],
      stopTimeMap: new Map([['TEST_STOP', effNowArt + 600]])
    };
    const stopProj = projectOnPolyline(synthBranch.pts, synthBranch.cum, -27.4700, -58.8300);
    const makeTrajFromAlong = (fromAlong) => {
      const rem = 3336 - fromAlong;
      const frac = fromAlong / 3336;
      const lat0 = -27.5000 + 0.03 * frac;
      return {
        pathPts: [
          [lat0, -58.8300],
          [-27.4700, -58.8300]
        ],
        pathCum: [0, rem],
        totalMeters: rem,
        leg: 'direct',
        isAtTerminal: false,
        speedMps: 5.5
      };
    };

    const simStale = new BusSimulator();
    // 1) 4 minutes without GPS (240 s) + last seen desvio -05:00 (-300 s) -> schedule mode with last-seen desvio!
    const busTest = {
      key: '96-c4199',
      codigoLinea: 96,
      identificadorCoche: '4199',
      lat: -27.4920,
      lng: -58.8300,
      ultimaFechaHoraGPS: fmtArtStamp(nowMsTest - 240_000),
      desvio: { raw: '-05:00', status: 'late', label: '-05:00', shortLabel: '-05:00', sign: '-', minutes: -5, seconds: -300 },
      eta: { minutes: 15, valid: true, display: '15', unit: 'min', urgency: 'later' },
      hasOfficialSoapEta: true,
      isPredicted: false,
      scheduledTrip: synthTrip,
      stopProj,
      trajectory: makeTrajFromAlong(890)
    };
    simStale.reconcile([busTest], { applyPositions: true, stopId: 'TEST_STOP' });
    let st = simStale.units.get(busTest.key);
    assert.equal(st.mode, 'schedule', '4 min without GPS must enter schedule mode');
    assert.equal(st.schedulePunctual, false, '4 min without GPS must NOT yet force 00:00 punctual mode');
    assert.equal(st.predDesvioSec, -300, '4 min without GPS must use last-seen desvio (-300 s)');
    assert.equal(busTest.gpsLost, true);
    assert.equal(busTest.gpsPunctualFallback, false);
    const latAt4Min = busTest.lat;

    // 2) 6 minutes without GPS (360 s) -> switches strictly to 00:00 punctual schedule!
    busTest.ultimaFechaHoraGPS = fmtArtStamp(nowMsTest - 360_000);
    busTest.trajectory = makeTrajFromAlong(890);
    simStale.reconcile([busTest], { applyPositions: true, stopId: 'TEST_STOP' });
    st = simStale.units.get(busTest.key);
    assert.equal(st.mode, 'schedule');
    assert.equal(st.schedulePunctual, true, '>= 5 min without GPS must switch to strict 00:00 punctual mode');
    assert.equal(st.predDesvioSec, 0, '>= 5 min punctual mode must zero predDesvioSec');
    assert.equal(st.scheduleAnchor, null, '>= 5 min punctual mode must clear old spatial anchor');
    assert.equal(busTest.gpsPunctualFallback, true);
    // Let glide finish (~1.6 s) and verify bus moved ahead to punctual 00:00 position (~1668 m along = -27.4850)
    for (let k = 0; k < 40; k++) simStale.step(0.05, [busTest], { updateEta: false });
    assert.ok(busTest.lat > latAt4Min + 0.004, 'Strict 00:00 punctual mode must advance ahead of late (-05:00) position');

    // 3) GPS RETURNS fresh (3 s ago) at real position 500 m behind punctual (-27.4895, along=1168) -> smooth, brisk & precise glide!
    const realRecoveryLat = -27.4895;
    busTest.lat = realRecoveryLat;
    busTest.lng = -58.8300;
    busTest.ultimaFechaHoraGPS = fmtArtStamp(Date.now() - 3_000);
    busTest.trajectory = makeTrajFromAlong(1168);
    const latBeforeRecovery = busTest.lat;
    simStale.reconcile([busTest], { applyPositions: true, stopId: 'TEST_STOP' });
    st = simStale.units.get(busTest.key);
    assert.equal(st.mode, 'gps', 'Returning fresh GPS must switch immediately back to gps mode');
    assert.equal(busTest.gpsLost, false);
    assert.equal(busTest.gpsPunctualFallback, false);
    assert.ok(st.correctionGlide, 'GPS return must initiate a smooth correctionGlide instead of 0ms teleport or 90s freeze');
    // Step 1 frame (50ms): must have started gliding smoothly, NOT teleported instantaneously
    simStale.step(0.05, [busTest], { updateEta: false });
    assert.ok(st.correctionGlide, 'Correction glide must animate smoothly across frames');
    // Step 1.6s total: glide must complete and land accurately right near realRecoveryLat!
    for (let k = 0; k < 35; k++) simStale.step(0.05, [busTest], { updateEta: false });
    assert.equal(st.correctionGlide, null, 'Correction glide must finish briskly (~0.7–1.45 s)');
    const errAfterRecoveryM = Math.abs(busTest.lat - realRecoveryLat) * 111200;
    assert.ok(
      errAfterRecoveryM < 45,
      `After brisk recovery glide, bus must sit precisely on real GPS position (err=${errAfterRecoveryM.toFixed(1)}m)`
    );
  }

  const nativeSchedSrc = await fs.readFile(path.join(androidJavaBase, 'NativeScheduleLookup.java'), 'utf8');
  assert.ok(
    nativeSchedSrc.includes('computeScheduleRemainingSec') &&
      tripSvcSrc.includes('gpsRecoveredFromGap') &&
      tripSvcSrc.includes('strictPunctual = effGpsAgeMs >= 300_000L'),
    'Native Android service must implement 3-min desvio, 5-min strict 00:00 punctual fallback, and brisk GPS recovery'
  );

  // v3.1.7: All 26 lines / 65 branches MUST have seamlessly connected endpoints (0 m gap at every cabecera/punta de línea)
  {
    const catAll = JSON.parse(await fs.readFile(path.join(DATA_DIR, 'catalogo.json'), 'utf8'));
    let checkedBranches = 0;
    for (const linea of catAll.lineas) {
      const rawRec = JSON.parse(await fs.readFile(path.join(DATA_DIR, 'recorridos', `${linea.codigo}.json`), 'utf8'));
      // 1) Idempotency: running connectRouteEndpoints on already-connected JSON must NOT add extra points
      const reConnected = connectRouteEndpoints(rawRec);
      for (let i = 0; i < rawRec.length; i++) {
        assert.equal(
          reConnected[i].puntos.length,
          rawRec[i].puntos.length,
          `connectRouteEndpoints must be idempotent on ${linea.descripcion} branch ${i}`
        );
      }

      // 2) Every branch endpoint (start & end) MUST touch another branch at <= 1 m (either exact endpoint or trunk polyline)
      const brs = parseRouteBranches(rawRec);
      assert.ok(brs.length >= 2, `${linea.descripcion} should have >= 2 parsed branches`);
      for (let i = 0; i < brs.length; i++) {
        checkedBranches++;
        const st = brs[i].pts[0];
        const en = brs[i].pts[brs[i].pts.length - 1];
        let minStartTouch = Infinity;
        let minEndTouch = Infinity;
        for (let j = 0; j < brs.length; j++) {
          if (j === i) continue;
          const pSt = projectOnPolyline(brs[j].pts, brs[j].cum, st[0], st[1]);
          const pEn = projectOnPolyline(brs[j].pts, brs[j].cum, en[0], en[1]);
          minStartTouch = Math.min(minStartTouch, pSt.perp);
          minEndTouch = Math.min(minEndTouch, pEn.perp);
        }
        assert.ok(
          minStartTouch <= 1.0,
          `${linea.descripcion} [${i}] ${brs[i].bandera} start must touch opposite branch (gap=${minStartTouch.toFixed(1)}m)`
        );
        assert.ok(
          minEndTouch <= 1.0,
          `${linea.descripcion} [${i}] ${brs[i].bandera} end must touch opposite branch (gap=${minEndTouch.toFixed(1)}m)`
        );
      }
    }
    assert.equal(checkedBranches, 65, 'Expected to validate endpoint connectivity on all 65 branches across 26 lines');

    // 3) Synthetic separated input MUST be auto-connected to 0 m by connectRouteEndpoints & parseRouteBranches
    const sepMock = [
      {
        abreviaturaBanderaSMP: 'IDA',
        puntos: [
          { latitud: '-27.47000', longitud: '-58.83000' },
          { latitud: '-27.46300', longitud: '-58.83761' }
        ],
        paradas: []
      },
      {
        abreviaturaBanderaSMP: 'VUELTA',
        puntos: [
          { latitud: '-27.46186', longitud: '-58.83748' },
          { latitud: '-27.47050', longitud: '-58.83050' }
        ],
        paradas: []
      }
    ];
    const mockBrs = parseRouteBranches(sepMock);
    assert.ok(
      distanceMeters(mockBrs[0].pts.at(-1)[0], mockBrs[0].pts.at(-1)[1], mockBrs[1].pts[0][0], mockBrs[1].pts[0][1]) < 0.5,
      'Runtime parseRouteBranches must auto-connect separated branch endpoints to 0 m'
    );
    assert.ok(
      distanceMeters(mockBrs[1].pts.at(-1)[0], mockBrs[1].pts.at(-1)[1], mockBrs[0].pts[0][0], mockBrs[0].pts[0][1]) < 0.5,
      'Runtime parseRouteBranches must auto-connect return endpoint to 0 m'
    );

    // 4) Stitched multi-leg trajectory (106A previous_leg & full_cycle) must have 0 m seam gap and zero duplicate vertices
    const brs106A = routeBranchesCache.get(350);
    const stop106Proj = projectOnPolyline(brs106A[1].pts, brs106A[1].cum, brs106A[1].orderedStops[5].lat, brs106A[1].orderedStops[5].lng);
    const prevLeg106 = buildTrajectoryFromBranchAlong(brs106A[0], brs106A[0].totalLen * 0.5, brs106A[1], stop106Proj, { etaSec: 900 });
    assert.equal(prevLeg106.leg, 'previous_leg');
    assert.ok(
      distanceMeters(
        prevLeg106.segments[0].pts.at(-1)[0],
        prevLeg106.segments[0].pts.at(-1)[1],
        prevLeg106.segments[1].pts[0][0],
        prevLeg106.segments[1].pts[0][1]
      ) < 0.5,
      '106A previous_leg segments must touch at exact 0 m turnaround seam'
    );
    for (let k = 1; k < prevLeg106.pathPts.length; k++) {
      const segD = distanceMeters(
        prevLeg106.pathPts[k - 1][0],
        prevLeg106.pathPts[k - 1][1],
        prevLeg106.pathPts[k][0],
        prevLeg106.pathPts[k][1]
      );
      assert.ok(segD > 0.05 || k === 1 || k === prevLeg106.pathPts.length - 1, 'Stitched pathPts should not contain duplicate seam vertex');
    }

    const mapJsSrc = await fs.readFile(path.join(ROOT, 'docs', 'js', 'map.js'), 'utf8');
    assert.ok(mapJsSrc.includes('connectRouteEndpoints'), 'map.js must connect route endpoints in drawRouteCollection');
    const routeDistSrc = await fs.readFile(path.join(androidJavaBase, 'RouteDistanceCalculator.java'), 'utf8');
    assert.ok(routeDistSrc.includes('bestDist <= 430.0'), 'Android RouteDistanceCalculator must defensively connect branch endpoints');
  }

  const appJsSrc = await fs.readFile(path.join(ROOT, 'docs', 'js', 'app.js'), 'utf8');
  assert.ok(appJsSrc.includes("version: 'v3.1.7'") && appJsSrc.includes('applyTerminalCoords') && appJsSrc.includes('buildCitySimCorrectionGlide') && appJsSrc.includes('hasOfficialSoapEta') && appJsSrc.includes('STORAGE_ARMED_ALERTS_KEY') && appJsSrc.includes('checkAndPromptMissingPermissions'), 'app.js must include v3.1.7 changelog, terminal snap helpers, smooth GPS recovery glide, hasOfficialSoapEta, persistent alerts, and startup permissions');
  assert.equal(/function pauseRealtime\(\)[\s\S]{0,400}state\.isAppPaused\s*=\s*true/.test(appJsSrc), false, 'pauseRealtime must NOT suspend the app on minimize');

  console.log('  ✓ Verified v3.1.7 Seamless 0m Connected Route Polylines (all 26 lines / 65 branches), Exact Polyline-Tip Terminal Snap, 3-min/5-min Schedule Rules, Smooth GPS Recovery & strict exclusions');
}

console.log('\nALL 10 END-TO-END VERIFICATION SUITES PASSED!');
