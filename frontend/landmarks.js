'use strict';

window.EFLandmarks = (() => {
  let picking = false;
  const text = (tag, value) => { const el = document.createElement(tag); el.textContent = value; return el; };
  function display(full, box, edit) {
    box.replaceChildren();
    const list = document.createElement('ol');
    for (const p of full.landmarks || []) {
      const li = text('li', `${p.label} — km ${EF.dec((p.dist_m / 1000).toFixed(2))}` +
        (p.stale ? ' — à replacer : tracé modifié' :
          ` — altitude profil : ${p.profile_ele_m == null ? 'inconnue' : Math.round(p.profile_ele_m) + ' m'}`) +
        (p.expected_ele_m == null ? '' : ` — attendue : ${p.expected_ele_m} m`) +
        (p.altitude_warning ? ' — écart supérieur à 100 m, à vérifier' : ''));
      if (p.source) {
        const details = document.createElement('details');
        details.append(text('summary', 'Sources et réserves'), text('p', p.source));
        li.append(details);
      }
      if (edit) edit(li, p);
      list.append(li);
    }
    box.append(list);
    if (!list.children.length) box.append(text('p', 'Aucun point marquant.'));
  }
  function mount({ full: initial, map, onChange }) {
    let full = initial, selectedId = null;
    const box = document.getElementById('landmark-editor');
    if (!box || !full.track) return;
    box.hidden = false;
    box.innerHTML = `<h2>Points marquants du profil</h2>
      <p class="meta-line">Annotations uniquement : aucun routage. Cliquez sur le profil pour choisir le kilomètre, ou activez la sélection carte (100 m maximum du tracé). Sur une boucle, choisissez le passage par son kilomètre.</p>
      <div id="landmark-profile"></div><div class="row">
      <label class="field">Lieu<input id="lm-label" maxlength="200"></label>
      <label class="field">Type<select id="lm-kind"><option value="city">Ville / village</option><option value="col">Col</option><option value="place">Lieu remarquable</option><option value="start">Départ</option><option value="finish">Arrivée</option></select></label>
      <label class="field">Kilomètre<input id="lm-km" type="number" min="0" step="any"></label>
      <label class="field">Altitude attendue (m, facultative)<input id="lm-ele" type="number" min="-500" max="10000" step="any"></label>
      <label class="field">Source / réserve<input id="lm-source" maxlength="8000"></label></div>
      <label class="field" id="lm-occurrences" hidden>Passage sur le tracé<select id="lm-occurrence"></select></label>
      <div class="toolbar"><button id="lm-pick" class="secondary" aria-pressed="false">Choisir sur la carte</button>
      <button id="lm-save">Ajouter le repère</button><button id="lm-new" class="secondary">Nouveau / annuler</button></div>
      <p id="lm-msg" class="meta-line" role="status"></p><div id="lm-list"></div>`;
    const el = (id) => document.getElementById(`lm-${id}`);
    const markers = L.layerGroup().addTo(map);
    function reset() {
      selectedId = null;
      for (const id of ['label', 'km', 'ele', 'source']) el(id).value = '';
      el('save').textContent = 'Ajouter le repère';
      el('occurrences').hidden = true;
    }
    async function refresh() {
      full = await EF.api(`/api/stages/${full.stage.id}`);
      onChange(full);
      render();
    }
    function render() {
      const payload = { ...full, profile: EFProfile.decimate(full.samples, 900).map((s) => ({
        d: s.dist_m, e: s.ele_smooth_m, r: s.ele_raw_m, lat: s.lat, lon: s.lon,
      })) };
      const profile = document.getElementById('landmark-profile');
      const width = EFProfile.responsiveWidth(profile.clientWidth, 1080), opts = { width, height: 300 };
      profile.innerHTML = EFProfile.renderProfileSVG(payload, opts);
      profile.querySelector('svg').addEventListener('click', (event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        const p = EFProfile.profileHoverAt(payload, opts, (event.clientX - rect.left) / rect.width * width);
        if (p) el('km').value = p.distM / 1000;
      });
      markers.clearLayers();
      for (const p of full.landmarks || []) if (!p.stale) {
        L.circleMarker([p.lat, p.lon], { radius: 5, color: '#145c81' }).bindTooltip(EF.esc(p.label)).addTo(markers);
      }
      display(full, el('list'), (li, p) => {
        const edit = text('button', 'Modifier'), del = text('button', 'Supprimer');
        edit.className = 'secondary'; del.className = 'danger';
        edit.addEventListener('click', () => {
          selectedId = p.id;
          for (const [id, value] of Object.entries({ label: p.label, kind: p.kind, km: p.dist_m / 1000, ele: p.expected_ele_m ?? '', source: p.source || '' })) el(id).value = value;
          el('save').textContent = p.stale ? 'Replacer le repère' : 'Enregistrer le repère';
          el('label').focus();
        });
        del.addEventListener('click', EF.confirmClick(del, { confirmText: 'Confirmer la suppression', onConfirm: async () => {
          try {
            await EF.api(`/api/stages/${full.stage.id}/landmarks/${p.id}`, { method: 'DELETE', body: { track_ref: full.track.geometry_ref } });
            reset(); await refresh();
          } catch (e) { el('msg').textContent = e.message; }
        } }));
        li.append(' ', edit, ' ', del);
      });
    }
    map.on('click', async (event) => {
      if (!picking) return;
      try {
        const lon = ((event.latlng.lng + 540) % 360) - 180;
        const result = await EF.api(`/api/stages/${full.stage.id}/landmark-candidates?lat=${event.latlng.lat}&lon=${lon}`);
        const choices = result.candidates;
        el('occurrence').replaceChildren(...choices.map((p) => new Option(`km ${EF.dec((p.dist_m / 1000).toFixed(3))} · écart ${Math.round(p.offset_m)} m`, p.dist_m)));
        el('occurrences').hidden = choices.length < 2;
        if (!choices.length) { el('msg').textContent = 'Cliquez à moins de 100 m du tracé.'; return; }
        el('km').value = choices[0].dist_m / 1000;
        el('msg').textContent = choices.length > 1 ? 'Plusieurs passages : choisissez le kilomètre.' : 'Ancrage proposé : complétez le lieu.';
      } catch (e) { el('msg').textContent = e.message; }
    });
    el('occurrence').addEventListener('change', () => { el('km').value = Number(el('occurrence').value) / 1000; });
    el('pick').addEventListener('click', () => {
      picking = !picking;
      el('pick').setAttribute('aria-pressed', String(picking));
      el('pick').textContent = picking ? 'Sélection carte active — désactiver' : 'Choisir sur la carte';
    });
    el('new').addEventListener('click', reset);
    el('save').addEventListener('click', async () => {
      if (el('km').value === '') { el('msg').textContent = 'Choisissez un kilomètre sur le tracé.'; return; }
      el('save').disabled = true;
      try {
        await EF.api(`/api/stages/${full.stage.id}/landmarks${selectedId == null ? '' : '/' + selectedId}`, {
          method: selectedId == null ? 'POST' : 'PUT',
          body: { label: el('label').value, kind: el('kind').value, dist_m: Number(el('km').value) * 1000,
            expected_ele_m: el('ele').value === '' ? null : Number(el('ele').value), source: el('source').value || null,
            track_ref: full.track.geometry_ref },
        });
        reset(); await refresh();
        el('msg').textContent = 'Repère enregistré. Tracé et analyses inchangés.';
      } catch (e) { el('msg').textContent = e.message; }
      finally { el('save').disabled = false; }
    });
    if (window.EF_STATIC) { box.hidden = true; return; }
    render();
  }
  return { mount, display, isPicking: () => picking };
})();
