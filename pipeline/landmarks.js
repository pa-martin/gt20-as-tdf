'use strict';

const { createHash } = require('node:crypto');
const { cumulativeDistances, haversine, inLatLonBounds } = require('./geo');
const TOLERANCE_M = 100;
const ALTITUDE_WARNING_M = 100;
const MAX_LANDMARKS = 500;
const KINDS = new Set(['city', 'col', 'place', 'start', 'finish']);
const bad = (message, status = 400) => Object.assign(new Error(message), { status });
const lonDelta = (v) => ((v + 540) % 360) - 180;

function geometryRef(track) {
  if (!track) return null;
  return createHash('sha256').update(JSON.stringify([track.geojson.geometry.coordinates, track.distance_m])).digest('hex');
}

function axis(track) {
  const points = track.geojson.geometry.coordinates.map(([lon, lat]) => ({ lat, lon }));
  const { cum } = cumulativeDistances(points);
  const length = cum[cum.length - 1];
  if (!(length > 0) || !(track.distance_m > 0)) throw bad('Tracé sans longueur exploitable', 409);
  return { points, cum, scale: track.distance_m / length };
}

function pointAt(track, distM) {
  if (!Number.isFinite(distM) || distM < 0 || distM > track.distance_m) throw bad('Kilomètre hors du tracé');
  const { points, cum, scale } = axis(track);
  const m = distM / scale;
  let i = 1;
  while (i < points.length - 1 && cum[i] < m) i++;
  const a = points[i - 1], b = points[i];
  const t = cum[i] > cum[i - 1] ? (m - cum[i - 1]) / (cum[i] - cum[i - 1]) : 0;
  const lon = a.lon + lonDelta(b.lon - a.lon) * t;
  return { lat: a.lat + (b.lat - a.lat) * t, lon: lonDelta(lon), dist_m: distM };
}

/** Toutes les occurrences proches ; deux passages sur une boucle ne fusionnent pas. */
function candidates(track, lat, lon) {
  if (!inLatLonBounds(lat, lon)) throw bad('Coordonnées hors bornes');
  const { points, cum, scale } = axis(track);
  const out = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const cos = Math.max(0.00001, Math.cos(lat * Math.PI / 180));
    const bx = lonDelta(b.lon - a.lon) * cos, by = b.lat - a.lat;
    const px = lonDelta(lon - a.lon) * cos, py = lat - a.lat;
    const norm = bx * bx + by * by;
    const t = norm ? Math.max(0, Math.min(1, (px * bx + py * by) / norm)) : 0;
    const dist_m = (cum[i - 1] + t * (cum[i] - cum[i - 1])) * scale;
    const point = pointOnSegment(a, b, t);
    const offset_m = haversine({ lat, lon }, point);
    out.push({ ...point, dist_m, offset_m, t });
  }
  // Minima sur les segments et leurs sommets, pas regroupement par kilomètre :
  // un demi-tour peut repasser au même lieu à quelques mètres d'intervalle.
  return out.filter((p, i) => p.offset_m <= TOLERANCE_M && (
    (p.t > 1e-9 && p.t < 1 - 1e-9) ||
    (i === 0 && p.t === 0) ||
    (p.t === 1 && (i === out.length - 1 || out[i + 1].t === 0))
  )).filter((p, i, all) => i === 0 || p.dist_m - all[i - 1].dist_m > 0.01)
    .map(({ lat: la, lon: lo, dist_m, offset_m }) => ({ lat: la, lon: lo, dist_m, offset_m }));
}

function pointOnSegment(a, b, t) {
  return { lat: a.lat + (b.lat - a.lat) * t, lon: lonDelta(a.lon + lonDelta(b.lon - a.lon) * t) };
}

function elevationAt(samples, distM) {
  if (!samples.length) return null;
  let i = 0;
  while (i < samples.length - 1 && samples[i].dist_m < distM) i++;
  const b = samples[i], a = samples[Math.max(0, i - 1)];
  const ele = (s) => Number.isFinite(s.ele_raw_m) ? s.ele_raw_m : null;
  if (b.dist_m === distM) return ele(b);
  if (ele(a) == null || ele(b) == null) return null;
  const t = b.dist_m > a.dist_m ? (distM - a.dist_m) / (b.dist_m - a.dist_m) : 0;
  return ele(a) + t * (ele(b) - ele(a));
}

function decorateLandmarks(rows, track, samples) {
  const ref = geometryRef(track);
  return rows.map((r) => {
    const stale = r.track_ref !== ref;
    const profile_ele_m = stale ? null : elevationAt(samples, r.dist_m);
    return { ...r, stale, profile_ele_m, altitude_warning: !stale && Number.isFinite(r.expected_ele_m) &&
      profile_ele_m != null && Math.abs(r.expected_ele_m - profile_ele_m) > ALTITUDE_WARNING_M };
  });
}

function validateLandmark(body, track) {
  if (body.track_ref !== geometryRef(track)) throw bad('Le tracé a changé : rechargez puis replacez le repère', 409);
  if (typeof body.label !== 'string' || !body.label.trim() || body.label.length > 200) throw bad('Libellé requis, 200 caractères au plus');
  if (!KINDS.has(body.kind)) throw bad('Type de repère inconnu');
  if (body.expected_ele_m != null && (!Number.isFinite(body.expected_ele_m) || body.expected_ele_m < -500 || body.expected_ele_m > 10000)) throw bad('Altitude attendue invalide');
  if (body.source != null && (typeof body.source !== 'string' || body.source.length > 8000)) throw bad('Source : texte de 8000 caractères au plus');
  return { ...pointAt(track, body.dist_m), label: body.label.trim(), kind: body.kind,
    track_ref: body.track_ref, expected_ele_m: body.expected_ele_m ?? null, source: body.source ?? null };
}

module.exports = { geometryRef, pointAt, candidates, elevationAt, decorateLandmarks, validateLandmark,
  TOLERANCE_M, ALTITUDE_WARNING_M, MAX_LANDMARKS, KINDS };
