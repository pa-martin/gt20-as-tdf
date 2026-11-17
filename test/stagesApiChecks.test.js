'use strict';
// GET /api/stages (frontend/editor.js) n'incluait jamais stages.checks —
// EF.stateBadge() ne pouvait donc pas distinguer une étape "générée" saine
// d'une étape "générée" dont l'audit qualité a échoué dans le tableau de
// l'éditeur (voir test/stateBadgeCheckFail.test.js pour le badge lui-même).
// GET /api/editions/:id l'avait déjà (SELECT * sur stages, JSON.parse déjà
// en place) — seule cette route manquait le champ.

const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.ETAPEFORGE_DATA_DIR = path.join(os.tmpdir(), `etapeforge-stagesapichecks-test-${process.pid}`);
process.env.ETAPEFORGE_OFFLINE = '1';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');

let appServer;
let base;
let getDb;

before(async () => {
  const { app } = require('../backend/server');
  ({ getDb } = require('../backend/db'));
  await new Promise((r) => (appServer = app.listen(0, '127.0.0.1', r)));
  base = `http://127.0.0.1:${appServer.address().port}`;
});

after(() => {
  appServer?.close();
  require('../backend/db').closeDb();
  fs.rmSync(process.env.ETAPEFORGE_DATA_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  const db = getDb();
  db.prepare('DELETE FROM stages').run();
});

test('GET /api/stages : checks est renvoyé et déjà parsé en objet (pas une chaîne JSON brute)', async () => {
  const db = getDb();
  db.prepare(`INSERT INTO stages (name, state, checks) VALUES ('Étape', 'done', ?)`)
    .run(JSON.stringify({ ok: false, items: [{ status: 'fail' }] }));
  const rows = await (await fetch(`${base}/api/stages`)).json();
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(typeof rows[0].checks, 'object');
  assert.strictEqual(rows[0].checks.ok, false);
});

test('GET /api/stages : checks absent (null) → champ checks: null, pas d\'exception', async () => {
  const db = getDb();
  db.prepare(`INSERT INTO stages (name, state) VALUES ('Étape sans checks', 'draft')`).run();
  const res = await fetch(`${base}/api/stages`);
  assert.strictEqual(res.status, 200);
  const rows = await res.json();
  assert.strictEqual(rows[0].checks, null);
});

test('GET /api/stages : checks corrompu (JSON invalide) → checks: null pour cette ligne, pas d\'exception globale', async () => {
  const db = getDb();
  db.prepare(`INSERT INTO stages (name, state, checks) VALUES ('Étape corrompue', 'done', 'pas du json')`).run();
  db.prepare(`INSERT INTO stages (name, state, checks) VALUES ('Étape saine', 'done', ?)`).run(JSON.stringify({ ok: true, items: [] }));
  const res = await fetch(`${base}/api/stages`);
  assert.strictEqual(res.status, 200, 'une ligne corrompue ne doit jamais faire échouer toute la liste');
  const rows = await res.json();
  assert.strictEqual(rows.length, 2);
  const corrupted = rows.find((r) => r.name === 'Étape corrompue');
  const healthy = rows.find((r) => r.name === 'Étape saine');
  assert.strictEqual(corrupted.checks, null);
  assert.strictEqual(healthy.checks.ok, true);
});

// Epic 17 (scripts/scale-bench.js) : à 2 200 étapes, la liste pesait 5,2 Mo,
// presque entièrement le détail des audits — seul le résumé est renvoyé ici,
// le détail reste dans GET /api/stages/:id.
test('GET /api/stages : checks résumé à { ok, offline } — le détail des audits ne transite pas par la liste', async () => {
  const db = getDb();
  const id = db.prepare(`INSERT INTO stages (name, state, checks) VALUES ('Étape', 'done', ?)`)
    .run(JSON.stringify({ ok: false, offline: true, items: [{ status: 'fail', label: 'x', detail: 'y'.repeat(2000) }] })).lastInsertRowid;
  const rows = await (await fetch(`${base}/api/stages`)).json();
  assert.deepStrictEqual(rows[0].checks, { ok: false, offline: true });
  const full = await (await fetch(`${base}/api/stages/${id}`)).json();
  assert.strictEqual(full.stage.checks.items.length, 1, 'le détail reste disponible sur la fiche');
});

test('GET /api/stages : checks de forme inattendue (tableau, scalaire) → null, jamais un objet vide trompeur', async () => {
  const db = getDb();
  for (const v of ['[1,2]', '"x"', 'true']) db.prepare(`INSERT INTO stages (name, state, checks) VALUES (?, 'done', ?)`).run(`Étape ${v}`, v);
  const rows = await (await fetch(`${base}/api/stages`)).json();
  assert.deepStrictEqual(rows.map((r) => r.checks), [null, null, null]);
});

test('provenance GPX cohérente entre résumé, fiche et édition après renommage', async () => {
  const db = getDb();
  const editionId = db.prepare("INSERT INTO editions (name, is_custom) VALUES ('Tour GPX', 1)").run().lastInsertRowid;
  const id = db.prepare("INSERT INTO stages (name, source, edition_id) VALUES ('Avant', ?, ?)")
    .run(JSON.stringify({ trace: 'gpx', points_bruts: 1234 }), editionId).lastInsertRowid;
  const update = await fetch(`${base}/api/stages/${id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Après', stage_type: 'montagne', status: 'prévue' }),
  });

  assert.strictEqual(update.status, 200);
  const row = (await (await fetch(`${base}/api/stages`)).json())[0];
  const full = await (await fetch(`${base}/api/stages/${id}`)).json();
  const edition = await (await fetch(`${base}/api/editions/${editionId}`)).json();
  assert.deepStrictEqual(row.origin, { format: 'gpx', mode: 'imported' });
  assert.deepStrictEqual(full.stage.origin, row.origin);
  assert.deepStrictEqual(edition.stages[0].origin, row.origin);
  assert.strictEqual(row.source, undefined, 'la liste ne transporte pas la provenance volumineuse');
  db.prepare('INSERT INTO tracks (stage_id, geojson, router, distance_m) VALUES (?, ?, ?, ?)')
    .run(id, JSON.stringify({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[9, 42], [9, 43]] } }), 'osrm', 100000);
  const reroutedEdition = await (await fetch(`${base}/api/editions/${editionId}`)).json();
  const reroutedFull = await (await fetch(`${base}/api/stages/${id}`)).json();
  const reroutedRow = (await (await fetch(`${base}/api/stages`)).json())[0];
  assert.deepStrictEqual(reroutedEdition.stages[0].origin, { format: 'gpx', mode: 'routed' });
  assert.deepStrictEqual(reroutedFull.stage.origin, reroutedRow.origin);
  assert.deepStrictEqual(reroutedEdition.stages[0].origin, reroutedRow.origin);
});

test('édition GPX : métadonnées seules, champs absents conservés, null explicite et tracé intact', async () => {
    const gpx = '<gpx><trk><trkseg>' + Array.from({ length: 60 }, (_, i) =>
      `<trkpt lat="${45 + i * 0.001}" lon="6"><ele>${300 + i}</ele></trkpt>`).join('') + '</trkseg></trk></gpx>';
    const imported = await fetch(`${base}/api/import/gpx`, { method: 'POST', headers: { 'Content-Type': 'application/gpx+xml' }, body: gpx });
    assert.strictEqual(imported.status, 200);
    const { id } = await imported.json();
    const db = getDb();
    const editionId = db.prepare("INSERT INTO editions (name) VALUES ('Tour à détacher')").run().lastInsertRowid;
    db.prepare("UPDATE stages SET date = '17 juillet 1920', stage_type = 'Type ancien', edition_id = ? WHERE id = ?").run(editionId, id);
    const before = await (await fetch(`${base}/api/stages/${id}`)).json();
    const put = (body) => fetch(`${base}/api/stages/${id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    let res = await put({ name: 'Informations modifiées', status: 'prévue' });
    assert.strictEqual(res.status, 200);
    let after = await (await fetch(`${base}/api/stages/${id}`)).json();
    assert.strictEqual(after.stage.date, before.stage.date);
    assert.strictEqual(after.stage.stage_type, 'Type ancien');
    for (const key of ['track', 'samples', 'climbs', 'descents', 'fauxPlats', 'kmAnalysis', 'waypoints']) assert.deepStrictEqual(after[key], before[key], key);
    for (const key of ['state', 'checks', 'generated_distance_km', 'total_ascent_m', 'source']) assert.deepStrictEqual(after.stage[key], before.stage[key], key);
    res = await put({ date: null, edition_id: null, status: null, stage_type: '' });
    assert.strictEqual(res.status, 200);
    after = await (await fetch(`${base}/api/stages/${id}`)).json();
    assert.deepStrictEqual([after.stage.date, after.stage.edition_id, after.stage.status], [null, null, null]);
    assert.strictEqual(after.stage.stage_type, 'Type ancien');
    assert.strictEqual((await put({ name: {} })).status, 400);
    assert.strictEqual((await put({ waypoints: [{ label: 'A' }, { label: 'B' }] })).status, 409);
    assert.strictEqual((await fetch(`${base}/api/stages/${id}/generate`, { method: 'POST' })).status, 409);
    await assert.rejects(require('../pipeline/generate').generateStage(id), (e) => e.status === 409);
    const final = await (await fetch(`${base}/api/stages/${id}`)).json();
    assert.deepStrictEqual(final.track, before.track);
    assert.deepStrictEqual(final.samples, before.samples);
});
