'use strict';

const FORMATS = new Set(['gpx', 'fit', 'import-link', 'suunto', 'strava']);

function sourceOf(stage) {
  const raw = stage?.source;
  if (typeof raw !== 'string') return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  try { return sourceOf({ source: JSON.parse(raw) }); } catch { return {}; }
}

/** Origine indépendante des champs libres nom/type/statut. */
function originOf(stage, track) {
  const source = sourceOf(stage);
  const format = FORMATS.has(source.trace) ? source.trace : null;
  if (!format && track?.router !== 'trace') return null;
  const mode = source.reconstructed_from || (track?.router && track.router !== 'trace') ? 'routed' : 'imported';
  return { format, mode };
}

module.exports = { sourceOf, originOf };
