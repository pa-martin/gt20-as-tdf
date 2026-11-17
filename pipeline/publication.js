'use strict';

const { sourceOf } = require('./provenance');

// Aucun catalogue redistribuable autorisé actuellement. Un catalogue inconnu
// reste privé jusqu'à une décision explicite dans le code, jamais via HTTP.
function publicationPolicy(db) {
  const privateEditionIds = new Set(db.prepare('SELECT id, catalog_key FROM editions').all()
    .filter((e) => e.catalog_key != null).map((e) => e.id));
  const rows = db.prepare('SELECT id, edition_id, source, publication FROM stages').all();
  const blocked = new Set(rows.filter((s) => s.publication !== 'public' ||
    privateEditionIds.has(s.edition_id) || sourceOf(s).catalog_key).map((s) => s.id));
  let changed;
  do {
    changed = false;
    for (const s of rows) {
      const ref = sourceOf(s).reconstructed_from;
      const parent = typeof ref === 'number' ? ref :
        typeof ref === 'string' && /^[1-9][0-9]*$/.test(ref) ? Number(ref) : NaN;
      if (!blocked.has(s.id) && ref != null && (!Number.isSafeInteger(parent) || parent < 1 || blocked.has(parent))) {
        blocked.add(s.id);
        changed = true;
      }
    }
  } while (changed);
  return {
    stageIds: new Set(rows.filter((s) => !blocked.has(s.id)).map((s) => s.id)),
    privateEditionIds,
    hasPrivateData: blocked.size > 0 || privateEditionIds.size > 0,
  };
}

module.exports = { publicationPolicy };
