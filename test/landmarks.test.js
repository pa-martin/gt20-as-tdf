'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.ETAPEFORGE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'etapeforge-landmarks-'));
process.env.ETAPEFORGE_OFFLINE = '1';
delete process.env.ETAPEFORGE_PUBLIC;
const { geometryRef, candidates, pointAt, decorateLandmarks } = require('../pipeline/landmarks');
const { renderProfileSVG } = require('../frontend/profile');
let server, base, id;
const request = (url, method, body) => fetch(base + url, {
  method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const full = async () => (await fetch(`${base}/api/stages/${id}`)).json();
before(async () => {
  const { app } = require('../backend/server');
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  const gpx = '<gpx><trk><trkseg>' + Array.from({ length: 121 }, (_, i) =>
    `<trkpt lat="${45 + i * 0.001}" lon="6"><ele>${300 + i}</ele></trkpt>`).join('') + '</trkseg></trk></gpx>';
  const res = await fetch(`${base}/api/import/gpx`, { method: 'POST', headers: { 'Content-Type': 'application/gpx+xml' }, body: gpx });
  ({ id } = await res.json());
});
after(async () => {
  await new Promise((resolve) => server?.close(resolve));
  require('../backend/db').closeDb();
  fs.rmSync(process.env.ETAPEFORGE_DATA_DIR, { recursive: true, force: true });
});

test('ancrage : segments, extrémités, boucles et altitude inconnue sans coercition', () => {
  const track = { distance_m: 30000, geojson: { geometry: { coordinates: [[6, 45], [6, 45.1], [6, 45], [6, 45.1]] } } };
  assert.equal(pointAt(track, 0).lat, 45);
  assert.equal(pointAt(track, 30000).lat, 45.1);
  assert.throws(() => pointAt(track, -1), /hors du tracé/);
  assert.equal(candidates(track, 45.05, 6).length, 3, 'trois passages au même endroit');
  const short = { distance_m: 222.39, geojson: { geometry: { coordinates: [[6, 45], [6, 45.001], [6, 45]] } } };
  assert.equal(candidates(short, 45.0005, 6).length, 2, 'deux passages distants de moins de 200 m restent distincts');
  assert.equal(candidates(track, 46, 8).length, 0, 'clic éloigné refusé');
  const rows = decorateLandmarks([{ track_ref: geometryRef(track), dist_m: 50, expected_ele_m: 900 }], track,
    [{ dist_m: 0, ele_raw_m: null }, { dist_m: 100, ele_raw_m: 100 }]);
  assert.equal(rows[0].profile_ele_m, null);
  assert.equal(rows[0].altitude_warning, false);
  assert.equal(decorateLandmarks(rows, { ...track, distance_m: 31000 }, [])[0].stale, true);
});

test('repères API : CRUD sans routage ni altération, sources et exports, sauvegarde ancienne compatible', async () => {
  const before = await full();
  const ref = before.track.geometry_ref;
  const endpoint = `/api/stages/${id}/landmarks`;
  const label = '</script><img src=x onerror=alert(1)> Col';
  const body = { label, kind: 'col', dist_m: 1234.5, track_ref: ref, expected_ele_m: 1000, source: 'Référence publiée, altitude à vérifier' };
  const res = await request(endpoint, 'POST', body);
  assert.equal(res.status, 201, await res.clone().text());
  const { id: landmarkId } = await res.json();
  let after = await full();
  assert.equal(after.landmarks[0].dist_m, body.dist_m);
  assert.equal(after.landmarks[0].altitude_warning, true);
  for (const key of ['track', 'samples', 'climbs', 'descents', 'waypoints', 'kmAnalysis']) assert.deepEqual(after[key], before[key], key);
  assert.equal(after.stage.total_ascent_m, before.stage.total_ascent_m);
  for (const ext of ['gpx', 'tcx', 'kml']) {
    const xml = await (await fetch(`${base}/api/stages/${id}/export.${ext}`)).text();
    assert.ok(xml.includes('&lt;/script&gt;'), ext);
    assert.ok(!xml.includes('<img src=x'), ext);
    if (ext === 'gpx') assert.ok(xml.indexOf('<desc>Altitude attendue') < xml.indexOf('<type>col'), 'ordre GPX 1.1 : desc avant type');
  }
  const html = await (await fetch(`${base}/api/stages/${id}/export.html`)).text();
  assert.ok(html.includes('\\u003c/script>'), 'JSON embarqué échappé');
  const roadbook = await (await fetch(`${base}/api/stages/${id}/roadbook.html`)).text();
  assert.ok(roadbook.includes('&lt;/script&gt;'));
  const svg = renderProfileSVG({ ...after, profile: after.samples.filter((_, i) => i % 12 === 0).map((s) => ({ d: s.dist_m, e: s.ele_smooth_m })) });
  assert.ok(svg.includes('data-landmark="1"'));
  assert.ok(svg.includes('&lt;/script&gt;'));
  assert.equal((await request(endpoint, 'POST', { ...body, track_ref: 'ancien' })).status, 409);
  assert.equal((await request(endpoint, 'POST', { ...body, dist_m: -1 })).status, 400);
  assert.equal((await request(endpoint, 'POST', { ...body, label: {} })).status, 400);
  assert.equal((await request(endpoint, 'POST', { ...body, expected_ele_m: '1000' })).status, 400);
  assert.equal((await request(`${endpoint}/${landmarkId}`, 'PUT', { ...body, label: 'Village', dist_m: 0 })).status, 200);
  const dump = await (await fetch(`${base}/api/backup/export`)).json();
  assert.equal(dump.tables.stage_landmarks.length, 1);
  const tooMany = structuredClone(dump.tables);
  tooMany.stage_landmarks = Array.from({ length: 501 }, (_, i) => ({ ...dump.tables.stage_landmarks[0], id: i + 1 }));
  assert.equal((await request('/api/backup/import', 'POST', { confirm: true, tables: tooMany })).status, 400);
  assert.equal((await request('/api/backup/import', 'POST', { confirm: true, tables: dump.tables })).status, 200);
  after = await full();
  assert.equal(after.landmarks[0].label, 'Village');
  const { setSetting } = require('../backend/settings');
  setSetting('privacy_zones', JSON.stringify([{ lat: 45, lon: 6, radiusM: 500 }]));
  const masked = await (await fetch(`${base}/api/stages/${id}/export.json`)).json();
  assert.equal(masked.landmarks.length, 0);
  assert.equal((await full()).landmarks.length, 1);
  assert.equal((await request(`${endpoint}/${landmarkId}`, 'DELETE', { track_ref: ref })).status, 200);
  assert.equal((await full()).landmarks.length, 0);
  delete dump.tables.stage_landmarks;
  assert.equal((await request('/api/backup/import', 'POST', { confirm: true, tables: dump.tables })).status, 200);
  assert.equal((await full()).landmarks.length, 0);
});

test('tracé remplacé : repères conservés mais inactifs et écritures périmées refusées', async () => {
  const initial = await full(), oldRef = initial.track.geometry_ref;
  const endpoint = `/api/stages/${id}/landmarks`;
  assert.equal((await request(endpoint, 'POST', { label: 'À replacer', kind: 'place', dist_m: 1000, track_ref: oldRef })).status, 201);
  const db = require('../backend/db').getDb();
  db.prepare('UPDATE tracks SET distance_m = distance_m + 10 WHERE stage_id = ?').run(id);
  const next = await full();
  assert.equal(next.landmarks[0].stale, true);
  assert.ok(!require('../backend/exports').stagePayload(next).landmarks.length);
  assert.equal((await request(endpoint, 'POST', { label: 'Périmé', kind: 'city', dist_m: 0, track_ref: oldRef })).status, 409);
  const svg = renderProfileSVG({ landmarks: [
    { label: 'Village A', dist_m: 50, profile_ele_m: 400 },
    { label: 'Village B', dist_m: 51, profile_ele_m: 400 },
  ], profile: [{ d: 0, e: 400 }, { d: 100, e: 400 }] }, { width: 420 });
  assert.ok(svg.includes('Village A') && svg.includes('Village B'));
  assert.ok(svg.includes('data-landmark="1"') && svg.includes('data-landmark="2"'));
});
