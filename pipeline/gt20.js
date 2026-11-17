'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { getDb, DATA_DIR } = require('../backend/db');
const { parseGpx } = require('./importTrack');
const { cumulativeDistances, resamplePolyline, movingAverageByDistance, inLatLonBounds } = require('./geo');
const { plausibleEle, fillNearestValid } = require('./elevation');
const { detectClimbs } = require('./climbs');
const { analyzeByKm } = require('./kmanalysis');
const { runChecks } = require('./checks');
const { geometryRef, pointAt, elevationAt } = require('./landmarks');
const KEY = 'gt20-private-v1';
const NAME = 'GT20 — Grande Traversée de la Corse';
const PACKAGE_DIR = path.join(DATA_DIR, 'catalogs', 'gt20-private');
const sha = (data) => createHash('sha256').update(data).digest('hex');
const fail = (message) => Object.assign(new Error(message), { status: 409 });

function readPackage() {
  const manifest = JSON.parse(fs.readFileSync(path.join(PACKAGE_DIR, 'manifest.json'), 'utf8'));
  if (manifest.key !== KEY || !Array.isArray(manifest.stages) || manifest.stages.length !== 12) throw fail('Manifeste GT20 invalide');
  const stages = manifest.stages.map((s, i) => {
    if (s.number !== i + 1 || typeof s.name !== 'string' || s.name.length > 200 ||
      !Array.isArray(s.waypoints) || s.waypoints.length > 500 ||
      (s.sparse_segments != null && !Array.isArray(s.sparse_segments))) throw fail('Ordre, lieux ou réserves GT20 invalides');
    const data = fs.readFileSync(path.join(PACKAGE_DIR, `step${i + 1}.gpx`));
    if (sha(data) !== s.sha256) throw fail(`Empreinte invalide pour step${i + 1}.gpx`);
    return { ...s, gpx: data.toString('utf8') };
  });
  return { ...manifest, stages };
}

function catalogueStatus() {
  const existing = getDb().prepare('SELECT id FROM editions WHERE catalog_key = ?').get(KEY);
  try {
    readPackage();
    return { key: KEY, name: NAME, available: true, edition_id: existing?.id || null, stage_count: 12 };
  } catch {
    return { key: KEY, name: NAME, available: false, edition_id: existing?.id || null, stage_count: 12,
      reason: 'Paquet privé absent ou invalide. Fournissez step1.gpx à step12.gpx avec scripts/prepare-gt20.js. Aucun téléchargement automatique.' };
  }
}

/** Préparation hors transaction, sans routeur ni fournisseur d'altimétrie. */
function prepareStage(entry) {
  const points = parseGpx(entry.gpx).points;
  if (points.length < 2 || !points.every((p) => inLatLonBounds(p.lat, p.lon))) throw fail(`GPX invalide : ${entry.number}`);
  const { cum, total } = cumulativeDistances(points);
  const originals = points.map((p, i) => ({ dist_m: cum[i], ele_raw_m: plausibleEle(p.ele) }));
  if (!originals.some((p) => p.ele_raw_m != null)) throw fail(`Altitudes GPX absentes : ${entry.number}`);
  const sampled = resamplePolyline(points, total < 60000 ? 100 : 250);
  const raw = sampled.map((s) => elevationAt(originals, s.dist));
  const filled = fillNearestValid(raw);
  const smooth = movingAverageByDistance(sampled.map((s, i) => ({ dist: s.dist, ele: filled[i] })), 1500);
  const samples = sampled.map((p, i) => ({ ...p, idx: i, eleRaw: raw[i], eleSmooth: smooth[i] }));
  let ascent = 0;
  for (let i = 1; i < samples.length; i++) ascent += Math.max(0, samples[i].eleSmooth - samples[i - 1].eleSmooth);
  const climbs = detectClimbs(samples);
  for (const c of climbs) {
    const pass = entry.waypoints.find((w) => w.is_pass && !w.technical && Math.abs(w.km * 1000 - c.endM) < 1000);
    c.name = pass ? pass.label : `Côte au km ${(c.endM / 1000).toFixed(1)}`;
    c.nameSource = pass ? 'repère GT20' : 'defaut';
  }
  const geojson = { type: 'Feature', properties: { preserved: true },
    geometry: { type: 'LineString', coordinates: points.map((p) => plausibleEle(p.ele) == null ? [p.lon, p.lat] : [p.lon, p.lat, p.ele]) } };
  const track = { geojson, distance_m: total };
  const ref = geometryRef(track);
  const landmarks = entry.waypoints.filter((w) => !w.technical).map((w) => {
    let dist = w.km * 1000;
    // Le pack a un axe calculé séparément : tolérer l'arrondi submétrique aux extrémités, pas un lieu hors parcours.
    if (dist >= -1 && dist <= total + 1) dist = Math.max(0, Math.min(total, dist));
    if (w.kind === 'finish' && Math.abs(dist - total) > 1) throw fail('Arrivée GT20 incohérente avec le GPX');
    const p = pointAt(track, dist);
    if (typeof w.label !== 'string' || !w.label.trim() || w.label.length > 200) throw fail('Libellé GT20 invalide');
    return { ...p, label: w.label, kind: w.kind === 'start' || w.kind === 'finish' ? w.kind : w.is_pass ? 'col' : w.nature === 'localite' ? 'city' : 'place',
      expected_ele_m: Number.isFinite(w.altitude_hint_m) ? w.altitude_hint_m : null, track_ref: ref,
      source: JSON.stringify({ source_urls: w.source_urls, published_elevations: w.published_elevations,
        altitude_ign_m: w.altitude_ign_m, altitude_gpx_m: w.altitude_gpx_m, note: w.note, geometry_warning: w.geometry_warning, related_pass: w.related_pass }) };
  });
  const checks = runChecks({ stage: {}, distanceM: total, waypointsOnTrack: [], approxSegments: [], climbs, samples });
  if (entry.sparse_segments?.length) checks.items.push({ id: 'source-gaps', label: 'GPX peu détaillé', status: 'warn',
    detail: 'Certains segments sources sont peu détaillés ; aucun virage intermédiaire n’a été inventé.' });
  return { entry, track, samples, landmarks, climbs, ascent, checks, kmRows: analyzeByKm(samples) };
}

function importCatalogue() {
  const db = getDb();
  const existing = db.prepare('SELECT id FROM editions WHERE catalog_key = ?').get(KEY);
  if (existing) return { id: existing.id, existing: true };
  let packet;
  try { packet = readPackage(); } catch { throw fail('Paquet GT20 absent ou invalide ; préparez les douze GPX et leurs repères.'); }
  const prepared = packet.stages.map(prepareStage);
  return db.transaction(() => {
    const found = db.prepare('SELECT id FROM editions WHERE catalog_key = ?').get(KEY);
    if (found) return { id: found.id, existing: true };
    const editionId = db.prepare('INSERT INTO editions (name, is_custom, catalog_key, source) VALUES (?, 1, ?, ?)').run(NAME, KEY,
      JSON.stringify({ redistribution: 'private', attribution: packet.attribution, license: packet.license })).lastInsertRowid;
    for (const p of prepared) {
      const source = { trace: 'gpx', usage: 'planned', catalog_key: KEY, sha256: p.entry.sha256,
        source_page: p.entry.source_page, attribution: packet.attribution,
        technical_check_count: p.entry.waypoints.filter((w) => w.technical).length, raw_distance_km: p.track.distance_m / 1000 };
      source.sparse_segments = { count: p.entry.sparse_segments?.length || 0,
        note: 'Intervalles peu détaillés conservés tels quels ; détails et contrôles techniques dans le paquet privé local.' };
      const stageId = db.prepare(`INSERT INTO stages (edition_id, stage_order, name, stage_type, status, state, source, publication,
        generated_distance_km, total_ascent_m, checks) VALUES (?, ?, ?, 'parcours GT20', 'parcours privé', 'done', ?, 'private', ?, ?, ?)`)
        .run(editionId, p.entry.number, p.entry.name, JSON.stringify(source), p.track.distance_m / 1000, Math.round(p.ascent),
          JSON.stringify({ ...p.checks, offline: false, imported: true, source_altitude: true })).lastInsertRowid;
      db.prepare("INSERT INTO tracks (stage_id, geojson, distance_m, approx_segments, router) VALUES (?, ?, ?, '[]', 'gpx-catalogue')")
        .run(stageId, JSON.stringify(p.track.geojson), p.track.distance_m);
      const sm = db.prepare('INSERT INTO elevation_samples (stage_id, idx, dist_m, lat, lon, ele_raw_m, ele_smooth_m) VALUES (?, ?, ?, ?, ?, ?, ?)');
      for (const s of p.samples) sm.run(stageId, s.idx, s.dist, s.lat, s.lon, s.eleRaw, s.eleSmooth);
      const cl = db.prepare(`INSERT INTO climbs (stage_id, name, category, score, start_km, end_km, length_km, start_ele_m,
        summit_ele_m, avg_gradient, max_gradient, irregularity_index, km_blocks, name_source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const c of p.climbs) cl.run(stageId, c.name, c.category, c.score, c.startM / 1000, c.endM / 1000,
        c.lengthKm, c.startEle, c.summitEle, c.avgGradient, c.maxGradient, c.irregularityIndex, JSON.stringify(c.kmBlocks), c.nameSource);
      const km = db.prepare('INSERT INTO km_analysis (stage_id, km, ele_start_m, ele_end_m, avg_gradient, max_gradient_100m, ascent_m, cum_ascent_m) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
      for (const r of p.kmRows) km.run(stageId, r.km, r.eleStart, r.eleEnd, r.avgGradient, r.maxGradient100, r.ascent, r.cumAscent);
      const lm = db.prepare('INSERT INTO stage_landmarks (stage_id, label, kind, dist_m, lat, lon, track_ref, expected_ele_m, source) VALUES (?, @label, @kind, @dist_m, @lat, @lon, @track_ref, @expected_ele_m, @source)');
      for (const row of p.landmarks) lm.run(stageId, row);
    }
    return { id: editionId, existing: false };
  }).immediate();
}

module.exports = { KEY, NAME, PACKAGE_DIR, sha, readPackage, prepareStage, catalogueStatus, importCatalogue };
