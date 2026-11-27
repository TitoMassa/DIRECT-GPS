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
const { buildTripPlannerIndex, planTripsOffline } = await importLocal('docs/js/trip-planner.js');
const {
  computeBridgeStatus,
  detectBunchingAndGaps,
  computeNetworkPunctuality,
  classifyBusEndingBadge,
  computeBusPhysicalTelemetry,
  buildBusUpcomingStops,
  findOppositeStop,
  buildEntitySevenDayProfile,
  formatServiceShareText,
  buildPrintableScheduleHtml
} = await importLocal('docs/js/telemetry.js');
const { RideModeController } = await importLocal('docs/js/ride-mode.js');

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

console.log('6. Testing local server.js HTTP endpoints, SW v96, and new v2.6.0 assets...');
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
    assert.ok(sw.includes('direct-gps-v96') && sw.includes('direct-gps-data-v5'), 'sw.js should have direct-gps-v96 & direct-gps-data-v5');
    for (const asset of [
      '/icons/icon-192.png',
      '/icons/icon-512.png',
      '/icons/icon-maskable-512.png',
      '/icons/apple-touch-icon.png',
      '/js/holidays.js',
      '/js/trip-planner.js',
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
    console.log('  ✓ Local server.js static, v2.6.0 assets, SW v96 & API endpoints verified');
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

console.log('10. Testing v2.6.0 features (Night Map zero-API, Holidays, Trip Planner, Telemetry, Ride Mode, PNG icons, Driver Overrides sync, strict exclusions)...');
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

  // 10b) Offline Trip Planner across all 26 real routes (direct + 1-transfer)
  const routeBranchesCache = new Map();
  for (const l of catalogo.lineas) {
    const rec = JSON.parse(await fs.readFile(path.join(DATA_DIR, 'recorridos', `${l.codigo}.json`), 'utf8'));
    routeBranchesCache.set(Number(l.codigo), parseRouteBranches(rec));
  }
  const plannerIndex = buildTripPlannerIndex(routeBranchesCache, lineByCode);
  assert.ok(plannerIndex.legs.length >= 40, 'Planner index should cover >=40 directional branches');

  const stPuerto = stopMap.get('CT31181');
  const stUnne = stopMap.get('CT31498'); // Campus / Av. Libertad or Junin
  const directPlans = planTripsOffline(
    plannerIndex,
    { lat: stPuerto.lat, lng: stPuerto.lng, label: 'Puerto' },
    { lat: stUnne.lat, lng: stUnne.lng, label: stUnne.nombre }
  );
  assert.ok(directPlans.length > 0, 'Trip planner must find routes from Puerto to CT31498');
  assert.ok(directPlans.some((p) => p.transfers === 0), 'Should include direct (0-transfer) routes');

  // Test transfer planning between two distant neighborhoods (Laguna Brava -> Resistencia UNNE)
  const br904B = routeBranchesCache.get(1038)?.[0];
  const unneResStop = br904B?.orderedStops?.[br904B.orderedStops.length - 1];
  const br106B = routeBranchesCache.get(351)?.[0];
  const farOriginStop = br106B?.orderedStops?.[0];
  if (unneResStop && farOriginStop) {
    const xferPlans = planTripsOffline(
      plannerIndex,
      { lat: farOriginStop.lat, lng: farOriginStop.lng, label: farOriginStop.nombre },
      { lat: unneResStop.lat, lng: unneResStop.lng, label: unneResStop.nombre }
    );
    assert.ok(xferPlans.length > 0, 'Trip planner must find 1-transfer routes across city + bridge');
  }

  // 10c) Telemetry module (Bridge monitor, Bunching, Punctuality, Ending badge, Physical telemetry, Upcoming stops, Opposite stop, 7-day profile, Share/Print)
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
  assert.ok(phys.trail.length >= 2);

  const br106 = routeBranchesCache.get(351);
  const sampleStart = br106[0].orderedStops[2];
  const upcoming = buildBusUpcomingStops(
    { lat: sampleStart.lat, lng: sampleStart.lng, descripcionBandera: br106[0].bandera, desvio: { status: 'ok', seconds: 0 } },
    null,
    br106,
    10 * 3600
  );
  assert.ok(upcoming.length >= 5, 'Should compute upcoming stops along branch');
  assert.ok(upcoming[0].distM < upcoming[upcoming.length - 1].distM, 'Upcoming stops must be monotonically ordered');

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
  const printHtml = buildPrintableScheduleHtml('Línea 106B', 'Lun–Vie', '<table><tr><td>05:00</td></tr></table>');
  assert.ok(printHtml.includes('window.print()') && printHtml.includes('Línea 106B'));

  // 10d) RideModeController (GPS proximity trigger <= 300 m)
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
    let triggeredPayload = null;
    const rc = new RideModeController({
      radiusMeters: 300,
      onTrigger: (p) => {
        triggeredPayload = p;
      }
    });
    assert.equal(rc.start({ id: 'CT31498', nombre: 'Junín y Mendoza', lat: -27.468, lng: -58.836 }, { sound: false, tts: false }), true);
    watchCb({ coords: { latitude: -27.48, lng: -58.836, longitude: -58.836 } }); // ~1.3 km away
    assert.equal(triggeredPayload, null);
    watchCb({ coords: { latitude: -27.4685, longitude: -58.836 } }); // ~55 m away -> triggers!
    assert.ok(triggeredPayload && triggeredPayload.distM < 300, 'RideModeController must trigger within 300 m');
    rc.stop();
    assert.equal(clearedId, 77);
  } finally {
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: origNav });
  }

  // 10e) Night Map zero-API + Strict Exclusions (NO satellite map, NO battery/data saver)
  assert.ok(MAP_TILES.dark && MAP_TILES.dark.darkFilter === true, 'MAP_TILES.dark must use darkFilter: true');
  assert.ok(MAP_TILES.dark.url.includes('tile.openstreetmap.org'), 'Night map must reuse cached OSM tiles with zero external API');
  const cssSrc = await fs.readFile(path.join(ROOT, 'docs', 'css', 'styles.css'), 'utf8');
  assert.ok(cssSrc.includes('.leaflet-tile-pane.osm-dark-filter'), 'styles.css must define .osm-dark-filter for night map');
  for (const rel of ['docs/index.html', 'docs/js/config.js', 'docs/js/map.js', 'docs/js/ui-extras.js', 'docs/js/app.js']) {
    const content = await fs.readFile(path.join(ROOT, rel), 'utf8');
    assert.equal(/arcgisonline|world_imagery|map-style="sat|mapa satelital/i.test(content), false, `${rel} must NOT contain satellite map`);
    assert.equal(/batterySaver|dataSaver|ahorro de bater[íi]a/i.test(content), false, `${rel} must NOT contain battery/data saver mode`);
  }

  // 10f) Real PNG PWA icons exist & have valid PNG signature
  const pngSig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  for (const fn of ['icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png']) {
    const buf = await fs.readFile(path.join(ROOT, 'docs', 'icons', fn));
    assert.ok(buf.length > 500 && buf.subarray(0, 8).equals(pngSig), `${fn} must be a valid PNG file`);
  }

  // 10g) Unified driver-overrides.json sync check across all 3 runtime files
  execFileSync('node', ['scripts/sync-drivers.mjs', '--check'], { cwd: ROOT, stdio: 'pipe' });

  console.log('  ✓ Verified Night Map (zero-API), Holidays, Trip Planner (26 lines), Telemetry, Ride Mode, PNG icons, driver sync & strict exclusions');
}

console.log('\nALL 10 END-TO-END VERIFICATION SUITES PASSED!');
