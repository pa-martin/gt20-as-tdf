'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { originOf } = require('../pipeline/provenance');
const EF = require('../frontend/common');

test('provenance historique GPX indépendante des champs libres ; formats distincts', () => {
  for (const format of ['gpx', 'fit', 'import-link', 'suunto', 'strava']) {
    const origin = originOf({ source: JSON.stringify({ trace: format }), stage_type: 'montagne', status: 'renommée' });
    assert.deepEqual(origin, { format, mode: 'imported' });
    assert.equal(EF.originBadge(origin).includes('Import GPX'), format === 'gpx');
  }
  assert.equal(originOf({ stage_type: 'trace', status: 'importée' }), null);
  assert.equal(originOf({ source: 'JSON abîmé' }), null);
  assert.equal(EF.originBadge(null), '');
});

test('une copie routée ne prétend pas conserver le GPX original', () => {
  const origin = originOf({ source: { trace: 'gpx', reconstructed_from: 7 } }, { router: 'brouter' });
  assert.deepEqual(origin, { format: 'gpx', mode: 'routed' });
  assert.match(EF.originBadge(origin), /Reconstruit depuis un GPX/);
  assert.doesNotMatch(EF.originBadge({ format: '<img src=x onerror=alert(1)>' }), /<img/);
});
