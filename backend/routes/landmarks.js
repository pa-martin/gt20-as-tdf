'use strict';

const { getDb } = require('../db');
const { loadStageFull } = require('../../pipeline/generate');
const { httpError } = require('../apiHelpers');
const { candidates, geometryRef, validateLandmark, MAX_LANDMARKS } = require('../../pipeline/landmarks');

module.exports = function register(app) {
  function load(req, writing = false) {
    const full = loadStageFull(Number(req.params.id));
    if (!full) throw httpError(404, 'Étape introuvable');
    if (!full.track) throw httpError(409, 'Un tracé est nécessaire pour placer un repère');
    if (writing && full.stage.state === 'generating') throw httpError(409, 'Génération en cours');
    return full;
  }
  app.get('/api/stages/:id/landmark-candidates', (req, res) => {
    const full = load(req);
    res.json({ track_ref: geometryRef(full.track), candidates: candidates(full.track, Number(req.query.lat), Number(req.query.lon)) });
  });
  app.post('/api/stages/:id/landmarks', (req, res) => {
    const full = load(req, true);
    if (full.landmarks.length >= MAX_LANDMARKS) throw httpError(400, `${MAX_LANDMARKS} repères au plus`);
    const p = validateLandmark(req.body || {}, full.track);
    const { lastInsertRowid: id } = getDb().prepare(`INSERT INTO stage_landmarks
      (stage_id, label, kind, dist_m, lat, lon, track_ref, expected_ele_m, source)
      VALUES (?, @label, @kind, @dist_m, @lat, @lon, @track_ref, @expected_ele_m, @source)`).run(full.stage.id, p);
    res.status(201).json({ id });
  });
  app.put('/api/stages/:id/landmarks/:landmarkId', (req, res) => {
    const full = load(req, true);
    const id = Number(req.params.landmarkId);
    if (!full.landmarks.some((p) => p.id === id)) throw httpError(404, 'Repère introuvable');
    const p = validateLandmark(req.body || {}, full.track);
    getDb().prepare(`UPDATE stage_landmarks SET label=@label, kind=@kind, dist_m=@dist_m,
      lat=@lat, lon=@lon, track_ref=@track_ref, expected_ele_m=@expected_ele_m, source=@source WHERE id=? AND stage_id=?`)
      .run(id, full.stage.id, p);
    res.json({ ok: true });
  });
  app.delete('/api/stages/:id/landmarks/:landmarkId', (req, res) => {
    const full = load(req, true);
    if (req.body?.track_ref !== geometryRef(full.track)) throw httpError(409, 'Le tracé a changé : rechargez');
    const result = getDb().prepare('DELETE FROM stage_landmarks WHERE id=? AND stage_id=?').run(Number(req.params.landmarkId), full.stage.id);
    if (!result.changes) throw httpError(404, 'Repère introuvable');
    res.json({ ok: true });
  });
};
