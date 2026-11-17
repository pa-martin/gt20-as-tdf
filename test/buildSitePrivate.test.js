'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const ROOT = path.join(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'etapeforge-build-private-'));
const env = { ...process.env, ETAPEFORGE_DATA_DIR: path.join(dir, 'data'), ETAPEFORGE_DIST_DIR: path.join(dir, 'dist'), ETAPEFORGE_OFFLINE: '1' };
after(() => fs.rmSync(dir, { recursive: true, force: true }));
function files(d) {
  return fs.readdirSync(d, { withFileTypes: true }).flatMap((f) => f.isDirectory() ? files(path.join(d, f.name)) : [path.join(d, f.name)]);
}

test('build public : aucune donnée privée, catalogue ou descendance ; édition mixte filtrée partout', () => {
  const setup = `
    const {getDb, closeDb} = require('./backend/db');
    const {importTrackAsStage} = require('./pipeline/importTrack');
    const {loadStageFull} = require('./pipeline/generate');
    (async () => {
      const db=getDb();
      const mixed=db.prepare("INSERT INTO editions(name,is_custom) VALUES('PUBLIC_MIXED',1)").run().lastInsertRowid;
      const cat=db.prepare("INSERT INTO editions(name,is_custom,catalog_key) VALUES('SECRET_CATALOG_NAME',1,'gt20-private-v1')").run().lastInsertRowid;
      const points=(lon) => Array.from({length:61},(_,i)=>({lat:45+i*.001,lon,ele:400+i*9}));
      const pub=await importTrackAsStage(points(6),{name:'PUBLIC_STAGE',source:'gpx'});
      const hidden=await importTrackAsStage(points(9.87654321),{name:'SECRET_PRIVATE_STAGE',source:'gpx'});
      const moved=await importTrackAsStage(points(9.87654321),{name:'SECRET_MOVED_CATALOG',source:'gpx'});
      const catalog=await importTrackAsStage(points(9.87654321),{name:'SECRET_CATALOG_STAGE',source:'gpx'});
      const copy=await importTrackAsStage(points(9.87654321),{name:'SECRET_COPY_STAGE',source:'gpx'});
      const grandchild=await importTrackAsStage(points(9.87654321),{name:'SECRET_GRANDCHILD_STAGE',source:'gpx'});
      db.prepare('UPDATE stages SET edition_id=? WHERE id=?').run(mixed,pub);
      db.prepare("UPDATE stages SET checks=json_set(checks,'$.offline',1) WHERE id=?").run(pub);
      db.prepare("UPDATE stages SET edition_id=?,publication='private' WHERE id=?").run(mixed,hidden);
      db.prepare('UPDATE stages SET edition_id=? WHERE id=?').run(cat,catalog);
      db.prepare('UPDATE stages SET source=? WHERE id=?').run(JSON.stringify({trace:'gpx',catalog_key:'gt20-private-v1'}),moved);
      db.prepare('UPDATE stages SET source=? WHERE id=?').run(JSON.stringify({trace:'gpx',reconstructed_from:String(hidden)}),copy);
      db.prepare('UPDATE stages SET source=? WHERE id=?').run(JSON.stringify({trace:'gpx',reconstructed_from:copy}),grandchild);
      const ref=loadStageFull(pub).track.geometry_ref;
      db.prepare("INSERT INTO stage_landmarks(stage_id,label,kind,dist_m,lat,lon,track_ref) VALUES(?,'PUBLIC_LANDMARK','city',0,45,6,?)").run(pub,ref);
      db.prepare("UPDATE climbs SET name='SECRET_PRIVATE_CLIMB' WHERE stage_id<>?").run(pub);
      if(!db.prepare('SELECT count(*) n FROM climbs WHERE stage_id=?').get(hidden).n) throw new Error('Côte privée absente : test non discriminant');
      console.log(JSON.stringify({pub,mixed,cat,hidden:[hidden,moved,catalog,copy,grandchild]}));
      closeDb();
    })().catch(e=>{console.error(e);process.exitCode=1;});`;
  const ids = JSON.parse(execFileSync(process.execPath, ['-e', setup], { cwd: ROOT, env, encoding: 'utf8' }));
  execFileSync(process.execPath, [path.join(ROOT, 'scripts/build-site.js')], { cwd: ROOT, env, stdio: 'pipe', timeout: 120000 });
  const dist = path.join(dir, 'dist');
  const json = (f) => JSON.parse(fs.readFileSync(path.join(dist, 'data', f), 'utf8'));
  assert.deepEqual(json('stages.json').map((s) => s.id), [ids.pub]);
  assert.deepEqual(json('editions.json').map((e) => [e.id, e.stage_count, e.done_count]), [[ids.mixed, 1, 1]]);
  assert.deepEqual(json(`edition-${ids.mixed}.json`).stages.map((s) => s.id), [ids.pub]);
  assert.equal(json(`stage-${ids.pub}.json`).landmarks[0].label, 'PUBLIC_LANDMARK');
  assert.equal(json(`stage-${ids.pub}.json`).stage.origin.format, 'gpx');
  assert.equal(json('status.json').offline, true);
  assert.deepEqual(fs.readdirSync(path.join(dist, 'captures')), []);
  for (const id of ids.hidden) assert.equal(fs.existsSync(path.join(dist, 'data', `stage-${id}.json`)), false);
  for (const f of files(dist).filter((f) => /\.(json|html|js)$/.test(f))) {
    const body = fs.readFileSync(f, 'utf8');
    assert.ok(!/SECRET_(PRIVATE|MOVED|CATALOG|COPY|GRANDCHILD)/.test(body), `${path.relative(dist, f)} contient une métadonnée privée`);
    assert.ok(!body.includes('9.87654321'), `${path.relative(dist, f)} contient une coordonnée privée`);
  }
  assert.equal(fs.existsSync(path.join(dist, 'data', `edition-${ids.cat}.json`)), false);
});
