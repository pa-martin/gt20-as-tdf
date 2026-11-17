#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { KEY, PACKAGE_DIR, sha } = require('../pipeline/gt20');
const args = process.argv.slice(2);
const value = (flag) => args[args.indexOf(flag) + 1];
if (!args.includes('--sources')) {
  console.error('Usage : node scripts/prepare-gt20.js --sources <dossier step1.gpx…step12.gpx> [--landmarks <waypoints-gt20.json>]');
  process.exitCode = 1;
} else {
  const landmarks = args.includes('--landmarks') ? JSON.parse(fs.readFileSync(path.resolve(value('--landmarks')), 'utf8')) : null;
  const stages = Array.from({ length: 12 }, (_, i) => {
    const data = fs.readFileSync(path.join(path.resolve(value('--sources')), `step${i + 1}.gpx`));
    const entry = landmarks?.stages?.find((s) => s.number === i + 1);
    if (entry?.sparse_segments != null && !Array.isArray(entry.sparse_segments)) throw new Error(`Réserves de géométrie invalides : étape ${i + 1}`);
    if (entry?.source_sha256 && entry.source_sha256 !== sha(data)) throw new Error(`GPX différent de la source des repères : étape ${i + 1}`);
    return { number: i + 1, name: entry ? `${entry.start} → ${entry.finish}` : `GT20 — étape ${i + 1}`,
      sha256: sha(data), source_page: entry?.source_page || null,
      waypoints: entry?.waypoints || [], sparse_segments: entry?.sparse_segments || [], data };
  });
  const manifest = { key: KEY, version: 1, license: 'Usage local privé uniquement ; redistribution non autorisée.',
    attribution: landmarks?.attribution || 'GPX fournis par l’utilisateur ; droits de redistribution à vérifier.',
    stages: stages.map((s) => { const entry = { ...s }; delete entry.data; return entry; }) };
  const target = path.join(PACKAGE_DIR, 'manifest.json');
  if (fs.existsSync(target) && fs.readFileSync(target, 'utf8') !== JSON.stringify(manifest)) throw new Error('Un manifeste différent existe déjà : aucun écrasement');
  for (const s of stages) {
    const dest = path.join(PACKAGE_DIR, `step${s.number}.gpx`);
    if (fs.existsSync(dest) && sha(fs.readFileSync(dest)) !== s.sha256) throw new Error(`Paquet existant différent : ${dest}`);
  }
  fs.mkdirSync(PACKAGE_DIR, { recursive: true, mode: 0o700 });
  for (const s of stages) {
    const dest = path.join(PACKAGE_DIR, `step${s.number}.gpx`);
    if (!fs.existsSync(dest)) fs.writeFileSync(dest, s.data, { flag: 'wx', mode: 0o600 });
  }
  if (!fs.existsSync(target)) fs.writeFileSync(target, JSON.stringify(manifest), { flag: 'wx', mode: 0o600 });
  console.log('Paquet GT20 privé prêt. Ouvrez Archives pour importer les douze étapes.');
}
