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
  console.log(`  ✓ Verified ${cortadoChecked} cortado terminations, ${relevoChecked} relevo continuations, and <1m spatial GPS anchor`);
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
    assert.ok(sw.includes('direct-gps-v101') && sw.includes('direct-gps-data-v5'), 'sw.js should have direct-gps-v101 & direct-gps-data-v5');
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
  const s4Pt = vBranch904B.pts[Math.floor(vBranch904B.pts.length * 0.72)];
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
  const s5TerminalStop = s5EndStops[s5EndStops.length - 1];
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
    distanceMeters(dabrio1524.terminalLat, dabrio1524.terminalLng, s5TerminalStop.lat, s5TerminalStop.lng) < 5,
    'Dabrio terminal snap coordinates must match final stop of Srv 5'
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
  for (const jf of ['MainActivity.java', 'DirectGpsNativePlugin.java', 'DirectGpsTripService.java', 'SpanishTtsFormatter.java']) {
    const src = await fs.readFile(path.join(androidJavaBase, jf), 'utf8');
    assert.ok(src.includes('package ar.corrientes.directgps;'), `${jf} must belong to package ar.corrientes.directgps`);
  }
  const tripSvcSrc = await fs.readFile(path.join(androidJavaBase, 'DirectGpsTripService.java'), 'utf8');
  assert.ok(tripSvcSrc.includes('ACTION_UPSERT_WATCH') && tripSvcSrc.includes('CHANNEL_LIVE_SILENT'), 'DirectGpsTripService must support persistent in-place watch alerts');
  assert.ok(tripSvcSrc.includes('PARTIAL_WAKE_LOCK') && tripSvcSrc.includes('scheduleWatchdogRestart') && tripSvcSrc.includes('KEY_PRIMARY_JSON'), 'DirectGpsTripService must hold WakeLock, persist primary trip, and survive task removal');
  assert.ok(tripSvcSrc.includes('pollAllTargetsSafe') && tripSvcSrc.includes('catch (Throwable'), 'Background polling loop must never die on uncaught throwable');
  assert.ok(tripSvcSrc.includes('playDeviceNotificationChime'), 'DirectGpsTripService must play chime before TTS');
  const onboardMethodMatch = tripSvcSrc.match(/private Notification buildOnboardNotification\([\s\S]*?\n    \}/);
  assert.ok(onboardMethodMatch, 'DirectGpsTripService must define buildOnboardNotification');
  assert.equal(onboardMethodMatch[0].includes('setProgress('), false, 'Native buildOnboardNotification must NOT draw a progress bar');

  const mainActSrc = await fs.readFile(path.join(androidJavaBase, 'MainActivity.java'), 'utf8');
  assert.ok(mainActSrc.includes('resumeTimers') && mainActSrc.includes('applySystemBars') && mainActSrc.includes('moveTaskToBack'), 'MainActivity must keep timers alive, apply dynamic system bars, and handle back cleanly');
  const pluginSrc = await fs.readFile(path.join(androidJavaBase, 'DirectGpsNativePlugin.java'), 'utf8');
  assert.ok(pluginSrc.includes('requestBackgroundLocationPermission') && pluginSrc.includes('setSystemBarsColor') && pluginSrc.includes('ensureBackgroundAlive'), 'DirectGpsNativePlugin must expose startup permissions, dynamic bars, and keep-alive');

  const manifestXml = await fs.readFile(path.join(ROOT, 'android', 'app', 'src', 'main', 'AndroidManifest.xml'), 'utf8');
  assert.ok(manifestXml.includes('FOREGROUND_SERVICE_LOCATION'), 'AndroidManifest must declare FOREGROUND_SERVICE_LOCATION');
  assert.ok(manifestXml.includes('POST_NOTIFICATIONS'), 'AndroidManifest must declare POST_NOTIFICATIONS');
  assert.ok(manifestXml.includes('REQUEST_INSTALL_PACKAGES'), 'AndroidManifest must declare REQUEST_INSTALL_PACKAGES for in-app APK updates');
  assert.ok(manifestXml.includes('android:stopWithTask="false"'), 'DirectGpsTripService must declare android:stopWithTask="false"');
  const apkWorkflow = await fs.readFile(path.join(ROOT, '.github', 'workflows', 'android-apk.yml'), 'utf8');
  assert.ok(apkWorkflow.includes('assembleDebug') && apkWorkflow.includes('upload-artifact') && apkWorkflow.includes('gh release'), 'android-apk.yml must compile, upload artifact, and publish GitHub Release');

  const indexHtml = await fs.readFile(path.join(ROOT, 'docs', 'index.html'), 'utf8');
  assert.ok(indexHtml.includes('id="update-modal"') && indexHtml.includes('id="btn-check-updates"'), 'index.html must include in-app update dialog and settings button');
  assert.ok(indexHtml.includes('id="btn-simple-mode"') && indexHtml.includes('id="chk-simple-mode"') && indexHtml.includes('id="simple-mode-bar"'), 'index.html must include Modo Simple controls');
  assert.ok(indexHtml.includes('id="permissions-modal"') && indexHtml.includes('id="btn-review-permissions"'), 'index.html must include startup permissions modal and settings trigger');
  assert.ok(cssSrc.includes('body.simple-mode') && cssSrc.includes('.ride-mode-banner.is-onboard .live-trip-track-wrap'), 'styles.css must include Modo Simple rules and hide onboard banner track');
  const appJsSrc = await fs.readFile(path.join(ROOT, 'docs', 'js', 'app.js'), 'utf8');
  assert.ok(appJsSrc.includes("version: 'v2.9.0'") && appJsSrc.includes('STORAGE_ARMED_ALERTS_KEY') && appJsSrc.includes('checkAndPromptMissingPermissions'), 'app.js must include v2.9.0 changelog, persistent alerts, and startup permissions');
  assert.equal(/function pauseRealtime\(\)[\s\S]{0,400}state\.isAppPaused\s*=\s*true/.test(appJsSrc), false, 'pauseRealtime must NOT suspend the app on minimize');

  console.log('  ✓ Verified v2.9.0 Immortal Background Service, Zero Minimize Suspension, Modo Simple, Startup Permissions, Immersive Bars, LED Removal & strict exclusions');
}

console.log('\nALL 10 END-TO-END VERIFICATION SUITES PASSED!');
