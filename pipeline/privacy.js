'use strict';
// Zones de confidentialité (backlog 34.7, idée geo-activity-playground) :
// autour du domicile (ou de tout lieu à taire), les points d'une trace
// importée sont retirés des exports, des mini-sites et de la carte « toutes
// mes traces ». La trace elle-même n'est pas modifiée en base : la fiche dans
// l'application reste complète pour qui y a accès.

const { haversine, inLatLonBounds } = require('./geo');
const { originOf, sourceOf } = require('./provenance');

// Clé du réglage (backend/settings.js), lue par le profil et les exports.
const PRIVACY_ZONES_KEY = 'privacy_zones';
const MAX_ZONES = 5;
const MIN_RADIUS_M = 100;
const MAX_RADIUS_M = 5000;

/**
 * Valide une liste de zones envoyée par le client. Lève une erreur
 * (status 400) au premier défaut : jamais de zone partiellement acceptée.
 * @returns [{ lat, lon, radiusM }]
 */
function validateZones(zones) {
  const bad = (msg) => Object.assign(new Error(msg), { status: 400 });
  if (!Array.isArray(zones)) throw bad('privacyZones doit être une liste');
  if (zones.length > MAX_ZONES) throw bad(`privacyZones : ${MAX_ZONES} zones au plus`);
  return zones.map((z, i) => {
    const f = `privacyZones[${i}]`;
    if (!z || typeof z !== 'object') throw bad(`${f} : objet attendu`);
    const { lat, lon, radiusM } = z;
    if (typeof lat !== 'number' || typeof lon !== 'number' || !inLatLonBounds(lat, lon)) throw bad(`${f} : lat entre -90 et 90, lon entre -180 et 180`);
    if (!Number.isInteger(radiusM) || radiusM < MIN_RADIUS_M || radiusM > MAX_RADIUS_M) throw bad(`${f}.radiusM : entier de ${MIN_RADIUS_M} à ${MAX_RADIUS_M} m`);
    return { lat, lon, radiusM };
  });
}

/**
 * Zones stockées (réglage JSON). Une zone invalide est écartée seule — les
 * autres protègent toujours (relecture adverse : une seule zone fautive
 * désactivait toutes les zones). Un réglage illisible (JSON cassé, pas une
 * liste) renvoie `null` : les appelants retirent alors TOUS les points des
 * traces, plutôt que de les publier faute de savoir où sont les zones.
 * @returns [{ lat, lon, radiusM }] | null
 */
function parseZones(stored) {
  if (stored == null || stored === '') return [];
  let list;
  try {
    list = typeof stored === 'string' ? JSON.parse(stored) : stored;
  } catch {
    return null;
  }
  if (!Array.isArray(list)) return null;
  const zones = [];
  for (const z of list.slice(0, MAX_ZONES)) {
    try { zones.push(...validateZones([z])); } catch { /* zone écartée seule */ }
  }
  // Des zones enregistrées, toutes invalides : on ne sait plus où est le
  // lieu à taire, comme pour un réglage illisible (seconde relecture).
  return list.length && !zones.length ? null : zones;
}

const inZone = (p, zones) =>
  p && Number.isFinite(p.lat) && Number.isFinite(p.lon) && zones.some((z) => haversine(p, z) <= z.radiusM);

/**
 * Copie d'une étape complète (loadStageFull) telle qu'elle peut sortir de
 * l'application. Protège les traces importées et leurs copies reconstruites,
 * même après un changement de routeur. Ne touche pas aux étapes historiques.
 * Retire :
 * - les échantillons, points du tracé et points de passage dans une zone ;
 * - les côtes, descentes, faux-plats et lignes du km par km qui recouvrent
 *   une portion masquée (nom, altitude et position du lieu caché) ;
 * - la commune, la région et le pays déduits du premier point, s'il est
 *   masqué (`city_hint`, géocodage inverse du départ), et les communes
 *   traversées (`track.communes`) dont le point de mesure est masqué ;
 * - l'indice de pénibilité, dès qu'une côte est retirée (il trahirait la
 *   côte cachée).
 * `zones === null` (réglage illisible) : tout est retiré de la trace, et
 * `privacyUnreadable` le signale aux exports.
 */
function maskStage(full, zones) {
  if (!full || (!originOf(full.stage, full.track) && !sourceOf(full.stage).reconstructed_from) || (zones && !zones.length)) return full;
  const hidden = (p) => zones === null || inZone(p, zones);
  const coords = full.track?.geojson?.geometry?.coordinates;
  const removed = full.samples.filter(hidden).map((sm) => sm.dist_m);
  const hiddenWaypoint = (full.waypoints || []).some((w) => w.lat != null && hidden(w));
  const hiddenCoordinate = Array.isArray(coords) && coords.some(([lon, lat]) => hidden({ lat, lon }));
  const hiddenLandmark = (full.landmarks || []).some(hidden);
  if (!removed.length && !hiddenWaypoint && !hiddenCoordinate && !hiddenLandmark && zones !== null) return full;
  // Portion [aM, bM] recouvrant au moins un échantillon masqué.
  const touches = (aM, bM) => removed.some((d) => d >= aM && d <= bM);
  const byKm = (a, b) => (row) => !touches(Number(row[a]) * 1000, Number(row[b]) * 1000);
  const startHidden = full.samples.length && hidden(full.samples[0]);
  const climbs = (full.climbs || []).filter(byKm('start_km', 'end_km'));
  const communes = full.track?.communes;
  // Une commune est celle d'un point pris tous les `stepM` mètres : masquée
  // si un échantillon masqué tombe à moins d'un demi-pas de ce point.
  const halfStep = (Number(communes?.stepM) || 1000) / 2;
  const maskedCommunes = communes && Array.isArray(communes.communes)
    ? { ...communes, communes: communes.communes.filter((c) => !touches(Number(c.km) * 1000 - halfStep, Number(c.km) * 1000 + halfStep)) }
    : communes;
  return {
    ...full,
    stage: startHidden ? { ...full.stage, city_hint: null, region_hint: null, country_hint: null } : full.stage,
    samples: full.samples.filter((p) => !hidden(p)),
    waypoints: (full.waypoints || []).filter((w) => w.lat == null || !hidden(w)),
    landmarks: (full.landmarks || []).filter((p) => !hidden(p)),
    climbs,
    pain: climbs.length === (full.climbs || []).length ? full.pain : null,
    descents: (full.descents || []).filter(byKm('start_km', 'end_km')),
    fauxPlats: (full.fauxPlats || []).filter(byKm('fromKm', 'toKm')),
    kmAnalysis: (full.kmAnalysis || []).filter((r) => !touches((Number(r.km) - 1) * 1000, Number(r.km) * 1000)),
    track: full.track ? {
      ...full.track,
      communes: maskedCommunes,
      geojson: Array.isArray(coords)
        ? { ...full.track.geojson, geometry: { ...full.track.geojson.geometry, coordinates: coords.filter((c) => !hidden({ lat: c[1], lon: c[0] })) } }
        : full.track.geojson,
    } : null,
    privacyMasked: true,
    ...(zones === null ? { privacyUnreadable: true } : {}),
  };
}

module.exports = { PRIVACY_ZONES_KEY, validateZones, parseZones, inZone, maskStage, MAX_ZONES, MIN_RADIUS_M, MAX_RADIUS_M };
