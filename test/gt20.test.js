'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
process.env.ETAPEFORGE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'etapeforge-gt20-'));
process.env.ETAPEFORGE_OFFLINE = '1';
delete process.env.ETAPEFORGE_PUBLIC;
const gt20 = require('../pipeline/gt20');
const { getDb, closeDb } = require('../backend/db');
let server, base, manifest;
const post = (url, body = {}) => fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
before(async () => {
  const { app } = require('../backend/server');
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise((resolve) => server?.close(resolve));
  closeDb();
  fs.rmSync(process.env.ETAPEFORGE_DATA_DIR, { recursive: true, force: true });
});
test('catalogue privé : disponibilité, transaction, fidélité, idempotence, bilans et sauvegarde', async () => {
  assert.equal((await (await fetch(base + '/api/catalog/gt20')).json()).available, false);
  fs.mkdirSync(gt20.PACKAGE_DIR, { recursive: true });
  manifest = { key: gt20.KEY, attribution: 'Source synthétique de test', license: 'Test', stages: [] };
  for (let n = 1; n <= 12; n++) {
    const gpx = '<gpx><trk><trkseg>' + Array.from({ length: 15 }, (_, i) =>
      `<trkpt lat="${45 + n * 0.01 + i * 0.0004}" lon="${6 + (i % 2) * 0.0001}"><ele>${i * 3}</ele></trkpt>`).join('') + '</trkseg></trk></gpx>';
    fs.writeFileSync(path.join(gt20.PACKAGE_DIR, `step${n}.gpx`), gpx);
    manifest.stages.push({ number: n, name: `Étape GT20 synthétique ${n}`, sha256: gt20.sha(gpx), sparse_segments: [],
      waypoints: [{ label: 'Ville nommée', kind: 'start', km: 0, technical: false, altitude_hint_m: 0, source_urls: ['https://example.org/source'] },
        { label: 'Contrôle technique', kind: 'via', km: 0.1, technical: true }] });
  }
  const file = path.join(gt20.PACKAGE_DIR, 'manifest.json');
  const endpoint = require('../pipeline/geo').cumulativeDistances(require('../pipeline/importTrack').parseGpx(
    fs.readFileSync(path.join(gt20.PACKAGE_DIR, 'step7.gpx'), 'utf8')).points).total;
  manifest.stages[6].waypoints.push({ label: 'Col de fin', kind: 'col', km: (endpoint + 0.05) / 1000, is_pass: true });
  const entry = { ...manifest.stages[6], gpx: fs.readFileSync(path.join(gt20.PACKAGE_DIR, 'step7.gpx'), 'utf8') };
  assert.throws(() => gt20.prepareStage({ ...entry, waypoints: [{ label: 'Arrivée fausse', kind: 'finish', km: (endpoint + 10000) / 1000 }] }), /Arrivée GT20/);
  fs.writeFileSync(file, JSON.stringify(manifest));
  const db = getDb();
  db.exec("CREATE TRIGGER refus_gt20 BEFORE INSERT ON stages WHEN NEW.stage_order=6 BEGIN SELECT RAISE(FAIL, 'panne de test'); END");
  assert.equal((await post('/api/catalog/gt20/import')).status, 500);
  assert.equal(db.prepare('SELECT count(*) n FROM editions').get().n, 0, 'aucune édition partiellement importée');
  assert.equal(db.prepare('SELECT count(*) n FROM stages').get().n, 0);
  db.exec('DROP TRIGGER refus_gt20');
  const summaryBefore = await (await fetch(base + '/api/traces/summary')).json();
  const [a, b] = await Promise.all([post('/api/catalog/gt20/import'), post('/api/catalog/gt20/import')]);
  assert.equal(a.status, 200, await a.clone().text());
  assert.equal(b.status, 200);
  const first = await a.json(), second = await b.json();
  assert.equal(first.id, second.id);
  assert.equal(db.prepare('SELECT count(*) n FROM editions').get().n, 1);
  const stages = db.prepare('SELECT * FROM stages ORDER BY stage_order').all();
  assert.equal(stages.length, 12);
  const { loadStageFull } = require('../pipeline/generate');
  for (const stage of stages) {
    const full = loadStageFull(stage.id);
    const points = require('../pipeline/importTrack').parseGpx(fs.readFileSync(path.join(gt20.PACKAGE_DIR, `step${stage.stage_order}.gpx`), 'utf8')).points;
    assert.deepEqual(full.track.geojson.geometry.coordinates, points.map((p) => [p.lon, p.lat, p.ele]));
    assert.equal(stage.publication, 'private');
    assert.deepEqual(full.stage.origin, { format: 'gpx', mode: 'imported' });
    assert.equal(stage.elapsed_time_s, null);
    assert.equal(full.samples[0].ele_raw_m, 0, 'altitude réelle zéro conservée hors ligne');
    assert.equal(full.landmarks.length, stage.stage_order === 7 ? 2 : 1, 'contrôles techniques exclus du profil');
    assert.equal(full.landmarks[0].expected_ele_m, 0);
    const exported = require('../pipeline/importTrack').parseGpx(require('../backend/exports').stageToGpx(full)).points;
    assert.deepEqual(exported.map((p) => [p.lon, p.lat, p.ele]), points.map((p) => [p.lon, p.lat, p.ele]));
  }
  assert.deepEqual(await (await fetch(base + '/api/traces/summary')).json(), summaryBefore, 'aucune activité fictive');
  const copy = await (await post(`/api/stages/${stages[0].id}/reconstruction-copy`)).json();
  assert.equal(loadStageFull(copy.id).stage.publication, 'private');
  const dump = await (await fetch(base + '/api/backup/export')).json();
  assert.equal((await post('/api/backup/import', { confirm: true, tables: dump.tables })).status, 200);
  assert.equal(loadStageFull(stages[0].id).landmarks.length, 1);
  db.prepare('DELETE FROM stages WHERE id=?').run(stages[11].id);
  await post('/api/catalog/gt20/import');
  assert.equal(db.prepare("SELECT count(*) n FROM stages WHERE edition_id=? AND state='done'").get(first.id).n, 11, 'aucune recréation silencieuse');
});

test('GPX conservé près du méridien : export décimal réimportable sans arrondir les coordonnées', async () => {
  const { importTrackAsStage, parseGpx } = require('../pipeline/importTrack');
  const points = [{ lat: 45, lon: 0.0000001, ele: 100 }, { lat: 45.001, lon: -0.0000002, ele: 101 }];
  const id = await importTrackAsStage(points, { source: 'gpx' });
  const full = require('../pipeline/generate').loadStageFull(id);
  const out = parseGpx(require('../backend/exports').stageToGpx(full)).points;
  assert.deepEqual(out.map((p) => [p.lon, p.lat]), points.map((p) => [p.lon, p.lat]));
});

test('sauvegarde de géométrie dense : plus de 20 Mio restaurables sans perte', async () => {
  const dump = await (await fetch(base + '/api/backup/export')).json();
  const track = dump.tables.tracks[0];
  const geojson = JSON.parse(track.geojson);
  geojson.geometry.coordinates = Array.from({ length: 600000 }, () => [6.123456789, 45.123456789, 111.123]);
  track.geojson = JSON.stringify(geojson);
  const body = JSON.stringify({ confirm: true, tables: dump.tables });
  assert.ok(Buffer.byteLength(body) > 20 * 1024 * 1024, 'sauvegarde réelle au-delà de l’ancienne limite');
  const res = await fetch(base + '/api/backup/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  assert.equal(res.status, 200, await res.text());
  const saved = getDb().prepare('SELECT geojson FROM tracks WHERE stage_id=?').get(track.stage_id);
  assert.equal(JSON.parse(saved.geojson).geometry.coordinates.length, 600000);
});

test('nouveaux imports GPX : géométrie dense distincte des échantillons, confidentialité de tous les points', async () => {
  const points = Array.from({ length: 201 }, (_, i) => ({ lat: 46 + i * 0.00001, lon: 6 + (i % 2) * 0.00001, ele: i / 10 }));
  const id = await require('../pipeline/importTrack').importTrackAsStage(points, { source: 'gpx', name: 'GPX dense' });
  const full = require('../pipeline/generate').loadStageFull(id);
  assert.equal(full.track.geojson.geometry.coordinates.length, points.length);
  assert.ok(full.samples.length < points.length);
  const { maskStage, inZone } = require('../pipeline/privacy');
  const zone = { lat: points[0].lat, lon: points[0].lon, radiusM: 100 };
  const masked = maskStage(full, [zone]);
  assert.ok(masked.track.geojson.geometry.coordinates.every(([lon, lat]) => !inZone({ lat, lon }, [zone])));
  const out = require('../pipeline/importTrack').parseGpx(require('../backend/exports').stageToGpx(masked)).points;
  assert.ok(out.every((p) => !inZone(p, [zone])));
  assert.equal(require('../pipeline/importTrack').parseGpx(require('../backend/exports').stageToGpx(full)).points.length, points.length);
});
