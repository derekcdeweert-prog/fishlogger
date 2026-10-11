// Fish Logger — release 1
import * as db from './db.js';
import { computedConditions, fetchWeather, distanceM, DEFAULT_POS } from './conditions.js';
import { buildCsv, buildBackup, restoreBackup, saveFile, stamp, sessionHours } from './data-export.js';
import { MapScreen, openSpotEditor, getPosition } from './map.js';
import {
  esc, $, $$, el, icon, toast, openSheet, confirmButton, chips, wireChips, chipValue, compressPhoto,
  fmtTime, fmtDate, fmtDuration, fmtNum, toLocalInput,
} from './ui.js';

export const SPECIES = ['Snoek', 'Snoekbaars', 'Baars', 'Forel', 'Kopvoorn', 'Ruisvoorn', 'Winde', 'Overig'];
const FLY_SPECIES = ['Forel', 'Kopvoorn', 'Ruisvoorn', 'Winde'];
const DEFAULT_METHODS = ['Jerken', 'Dropshotten', 'Jiggen', 'Spinnen', 'Vliegvissen'];
const LURE_TYPES = ['Jerkbait', 'Shad', 'Plug', 'Spinner', 'Lepel', 'Spinnerbait', 'Topwater', 'Dropshot-aas', 'Jig + softbait', 'Vlieg', 'Overig'];
const WATER = ['Helder', 'Licht troebel', 'Troebel'];
const PLATFORMS = ['Kant', 'Wadend', 'Boot'];

const state = {
  tab: 'vissen',
  spots: [],
  lures: [],
  sessions: [],
  methods: DEFAULT_METHODS,
  last: {},
  photoUrls: new Map(),
};

const active = () => state.sessions.find((s) => !s.endedAt) || null;
const spotById = (id) => state.spots.find((s) => s.id === id);
const lureById = (id) => state.lures.find((l) => l.id === id);
const lureSnap = (l) => (l ? { type: l.type, name: l.name, color: l.color, sizeCm: l.sizeCm, weightG: l.weightG } : null);
// Vangst per uur pas tonen na een kwartier; daarvoor zegt het getal nog niets.
const rateText = (fish, hours, digits = 1) => (hours < 0.25 ? '–' : fmtNum(fish / hours, digits));
const sRate = (s, digits = 1) => rateText(s.catches.length, sessionHours(s), digits);
const lureName = (l) => (l ? [l.name || l.type, l.color].filter(Boolean).join(' · ') : 'Geen aas gekozen');

// ---------- Laden ----------

async function load() {
  const [spots, lures, sessions] = await Promise.all([db.getAll('spots'), db.getAll('lures'), db.getAll('sessions')]);
  state.spots = spots.sort((a, b) => a.name.localeCompare(b.name, 'nl'));
  state.lures = lures.sort((a, b) => (a.type + a.name).localeCompare(b.type + b.name, 'nl'));
  state.sessions = sessions.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  state.methods = await db.getSetting('methods', DEFAULT_METHODS);
  state.last = await db.getSetting('lastChoices', {});
}

async function saveSession(s) {
  await db.put('sessions', s);
  const i = state.sessions.findIndex((x) => x.id === s.id);
  if (i >= 0) state.sessions[i] = s;
  else state.sessions.unshift(s);
  state.sessions.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

function spotStats(spotId) {
  const list = state.sessions.filter((s) => s.spot?.id === spotId && s.endedAt);
  const fish = list.reduce((n, s) => n + s.catches.length, 0);
  const hours = list.reduce((n, s) => n + sessionHours(s), 0);
  return { sessions: list.length, fish, rate: hours > 0 ? fish / hours : 0 };
}

async function photoUrl(id) {
  if (!id) return null;
  if (state.photoUrls.has(id)) return state.photoUrls.get(id);
  const p = await db.get('photos', id);
  if (!p) return null;
  const url = URL.createObjectURL(p.blob);
  state.photoUrls.set(id, url);
  return url;
}

async function fillPhotos(root) {
  for (const img of $$('img[data-photo]', root)) {
    const url = await photoUrl(img.dataset.photo);
    if (url) img.src = url;
  }
}

// ---------- Weer ----------

let weatherBusy = false;
async function updateWeather(session) {
  const pos = session.position || (session.spot ? { lat: session.spot.lat, lng: session.spot.lng } : null);
  if (!pos) return;
  try {
    const w = await fetchWeather(new Date(session.startedAt), pos);
    session.weather = w;
  } catch (e) {
    session.weather = { status: navigator.onLine ? 'failed' : 'pending', error: e.message, triedAt: new Date().toISOString() };
  }
  await saveSession(session);
}

/** Vult het weer aan voor sessies die zonder bereik zijn gestart. */
async function backfillWeather() {
  if (weatherBusy || !navigator.onLine) return;
  weatherBusy = true;
  try {
    const todo = state.sessions.filter((s) => s.weather?.status !== 'ok' && Date.now() - Date.parse(s.startedAt) < 90 * 864e5);
    for (const s of todo) await updateWeather(s);
    if (todo.length) render();
  } finally {
    weatherBusy = false;
  }
}

function weatherHtml(w, { compact = false } = {}) {
  if (!w || w.status === 'pending') return `<span class="muted">Weer volgt zodra je bereik hebt</span>`;
  if (w.status === 'loading') return `<span class="muted">Weer ophalen…</span>`;
  if (w.status !== 'ok') return `<span class="muted">Weer niet beschikbaar</span>`;
  const trendIcon = { Stijgend: 'arrowUp', Dalend: 'arrowDown', Stabiel: 'arrowFlat' }[w.pressureTrend] || 'arrowFlat';
  const items = [
    ['Temp.', `${fmtNum(w.tempC)}°C`],
    ['Wind', `${w.windBft} Bft ${w.windDir}`],
    ['Druk', `${Math.round(w.pressureHpa)} hPa`, `<span class="trend">${icon(trendIcon)} ${esc((w.pressureTrend || '').toLowerCase())}</span>`],
    ['Lucht', w.desc || `${w.cloudPct}% bewolkt`],
  ];
  if (!compact) items.push(['Bewolking', `${w.cloudPct}%`], ['Neerslag', `${fmtNum(w.precipMm)} mm`]);
  return `<dl class="gauges">${items
    .map(([k, v, extra]) => `<div><dt>${k}</dt><dd>${esc(v)}${extra || ''}</dd></div>`)
    .join('')}</dl>`;
}

// ---------- Tabs ----------

const TABS = [
  { id: 'vissen', label: 'Vissen', icon: 'fish' },
  { id: 'kaart', label: 'Kaart', icon: 'map' },
  { id: 'logboek', label: 'Logboek', icon: 'book' },
  { id: 'tacklebox', label: 'Tackle box', icon: 'box' },
];

let mapScreen;

function setTab(tab) {
  if (!TABS.some((t) => t.id === tab)) tab = 'vissen';
  state.tab = tab;
  $$('.tabbar button').forEach((b) => b.setAttribute('aria-current', b.dataset.tab === tab ? 'page' : 'false'));
  $$('.screen').forEach((s) => (s.hidden = s.id !== `screen-${tab}`));
  if (history.replaceState) history.replaceState(null, '', `#${tab}`);
  render();
}

function render() {
  if (state.tab === 'vissen') renderVissen();
  if (state.tab === 'kaart') {
    mapScreen.mount();
    mapScreen.refresh(false);
  }
  if (state.tab === 'logboek') renderLogboek();
  if (state.tab === 'tacklebox') renderTackle();
}

// ---------- Vissen ----------

function renderVissen() {
  const root = $('#screen-vissen');
  const s = active();
  if (!s) return renderIdle(root);

  const hours = sessionHours(s);
  const c = s.conditions || {};
  root.innerHTML = `
    <header class="screen-head">
      <p class="eyebrow">Sessie loopt · sinds ${fmtTime(new Date(s.startedAt))}</p>
      <h1>${esc(s.spot?.name || 'Onbekende stek')}</h1>
    </header>
    <section class="live card">
      <div class="live-numbers">
        <div><span class="big" id="live-elapsed">${fmtDuration(hours)}</span><span class="lbl">aan het water</span></div>
        <div><span class="big">${s.catches.length}</span><span class="lbl">${s.catches.length === 1 ? 'vis' : 'vissen'}</span></div>
        <div><span class="big" id="live-rate">${sRate(s)}</span><span class="lbl">per uur</span></div>
      </div>
      ${weatherHtml(s.weather, { compact: true })}
      <p class="cond-line">${esc(c.dayPart)} · ${esc(c.season)} · ${esc(c.moonPhase)} · ${esc(s.platform)} · water ${esc((s.waterClarity || '').toLowerCase())}</p>
    </section>

    <section class="rig card">
      <div>
        <p class="eyebrow">Nu aan je lijn</p>
        <p class="rig-main">${esc(s.method)} · ${esc(lureName(s.lure))}</p>
      </div>
      <button class="btn ghost small" id="change-rig" type="button">Wissel</button>
    </section>

    <button class="btn primary huge" id="add-catch" type="button">${icon('plus')} Vangst toevoegen</button>

    <section class="catches">
      ${s.catches.length ? `<h2 class="section-title">Vangsten</h2>` : ''}
      ${[...s.catches].reverse().map(catchRow).join('')}
    </section>

    <button class="btn ghost wide" id="stop-session" type="button">${icon('stop')} Sessie stoppen</button>`;

  $('#add-catch', root).addEventListener('click', () => openCatchSheet(s));
  $('#stop-session', root).addEventListener('click', () => openStopSheet(s));
  $('#change-rig', root).addEventListener('click', () => openRigSheet(s));
  $$('[data-catch]', root).forEach((b) => b.addEventListener('click', () => openCatchSheet(s, s.catches.find((f) => f.id === b.dataset.catch))));
  fillPhotos(root);
}

function catchRow(f) {
  return `<button class="catch-row" type="button" data-catch="${esc(f.id)}">
    ${f.photoId ? `<img data-photo="${esc(f.photoId)}" alt="" class="thumb">` : `<span class="thumb empty">${icon('fish')}</span>`}
    <span class="catch-main">
      <strong>${esc(f.species)}${f.lengthCm ? ` · ${fmtNum(f.lengthCm, f.lengthCm % 1 ? 1 : 0)} cm` : ''}</strong>
      <span class="muted">${fmtTime(new Date(f.at))} · ${esc(f.method)} · ${esc(lureName(f.lure))}</span>
    </span>
  </button>`;
}

function renderIdle(root) {
  const done = state.sessions.filter((s) => s.endedAt);
  const last = done[0];
  const fish = done.reduce((n, s) => n + s.catches.length, 0);
  root.innerHTML = `
    <header class="screen-head">
      <p class="eyebrow">Fish Logger</p>
      <h1>Klaar om te vissen?</h1>
    </header>
    <button class="btn primary huge" id="start-session" type="button">${icon('fish')} Start sessie</button>
    <p class="hint center">Tijd, locatie en weer worden automatisch vastgelegd.</p>
    ${state.lures.length === 0 ? `<div class="card nudge"><p>Je tackle box is nog leeg. Voeg je kunstaas toe, dan kies je het straks met één tik.</p><button class="btn small" type="button" data-goto="tacklebox">${icon('box')} Naar tackle box</button></div>` : ''}
    ${last ? `
      <section class="card">
        <p class="eyebrow">Vorige sessie</p>
        <p class="last-line"><strong>${esc(last.spot?.name || '')}</strong> · ${fmtDate(new Date(last.startedAt))}</p>
        <p class="muted">${fmtDuration(sessionHours(last))} · ${last.catches.length} ${last.catches.length === 1 ? 'vis' : 'vissen'} · ${sRate(last)} per uur</p>
      </section>
      <section class="totals">
        <div><span class="big">${done.length}</span><span class="lbl">sessies</span></div>
        <div><span class="big">${fish}</span><span class="lbl">vissen</span></div>
        <div><span class="big">${state.spots.filter((s) => !s.archived).length}</span><span class="lbl">stekken</span></div>
      </section>` : ''}
    ${installHint()}`;
  $('#start-session', root).addEventListener('click', openStartSheet);
}

function installHint() {
  const standalone = window.navigator.standalone || window.matchMedia('(display-mode: standalone)').matches;
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  if (standalone || !ios) return '';
  return `<section class="card install">
    <p class="eyebrow">Eén keer instellen</p>
    <p>Zet Fish Logger op je beginscherm: tik in Safari op ${icon('share')} <b>Deel</b> en kies <b>Zet op beginscherm</b>. Daarna open je de app vanaf je beginscherm, zodat je gegevens veilig bewaard blijven.</p>
  </section>`;
}

// ----- Sessie starten -----

function lureOptions(selectedId) {
  const active = state.lures.filter((l) => !l.archived || l.id === selectedId);
  const groups = LURE_TYPES.map((t) => [t, active.filter((l) => l.type === t)]).filter(([, ls]) => ls.length);
  return `<option value="">Geen / niet in tackle box</option>${groups
    .map(([t, ls]) => `<optgroup label="${esc(t)}">${ls
      .map((l) => `<option value="${esc(l.id)}" ${l.id === selectedId ? 'selected' : ''}>${esc(lureName(l))}${l.sizeCm ? ` (${fmtNum(l.sizeCm, l.sizeCm % 1 ? 1 : 0)} cm)` : ''}</option>`)
      .join('')}</optgroup>`)
    .join('')}`;
}

function openStartSheet() {
  const last = state.last;
  const body = el(`<form class="form" novalidate>
    <div class="field">
      <span class="label">Stek</span>
      <div class="spot-list" id="spot-list"><p class="muted">Locatie bepalen…</p></div>
      <button type="button" class="btn ghost small" id="new-spot">${icon('pin')} Nieuwe stek op de kaart</button>
    </div>
    <div class="field"><span class="label">Doelsoort(en)</span>${chips('species', SPECIES, last.targetSpecies || ['Snoek'], { multi: true })}</div>
    <div class="field"><span class="label">Methode</span>${chips('method', state.methods, last.method || state.methods[0])}</div>
    <label class="field"><span class="label">Kunstaas</span><select id="start-lure">${lureOptions(last.lureId)}</select></label>
    <div class="field"><span class="label">Waterhelderheid</span>${chips('water', WATER, last.waterClarity || 'Licht troebel')}</div>
    <div class="field"><span class="label">Je vist vanaf</span>${chips('platform', PLATFORMS, 'Kant')}</div>
    <button type="submit" class="btn primary huge">Start</button>
  </form>`);
  wireChips(body);
  const sheet = openSheet({ title: 'Nieuwe sessie', body });

  let gps = null;
  let selectedSpot = null;

  const renderSpots = () => {
    const list = $('#spot-list', body);
    const spots = state.spots.filter((s) => !s.archived).map((s) => ({ ...s, dist: gps ? distanceM(gps, s) : null }));
    if (gps) spots.sort((a, b) => a.dist - b.dist);
    if (!selectedSpot && gps && spots[0] && spots[0].dist <= 200) selectedSpot = spots[0].id;
    if (!spots.length) {
      list.innerHTML = `<p class="muted">Nog geen stekken. Leg je eerste stek vast op de kaart.</p>`;
      return;
    }
    list.innerHTML = spots
      .slice(0, 8)
      .map((s) => `<button type="button" class="spot-opt ${s.id === selectedSpot ? 'on' : ''}" data-spot="${esc(s.id)}" aria-pressed="${s.id === selectedSpot}">
        <span>${esc(s.name)}</span>
        <span class="muted">${s.dist != null ? (s.dist < 1000 ? `${Math.round(s.dist)} m` : `${fmtNum(s.dist / 1000)} km`) : ''}</span>
      </button>`)
      .join('');
  };
  renderSpots();
  getPosition({ timeout: 12000 })
    .then((p) => { gps = p; renderSpots(); })
    .catch(() => { renderSpots(); });

  $('#spot-list', body).addEventListener('click', (e) => {
    const b = e.target.closest('[data-spot]');
    if (!b) return;
    selectedSpot = b.dataset.spot;
    renderSpots();
  });

  $('#new-spot', body).addEventListener('click', () => {
    openSpotEditor({
      onSave: async (spot) => {
        const saved = await saveSpot(spot);
        selectedSpot = saved.id;
        renderSpots();
      },
    });
  });

  body.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!selectedSpot) { toast('Kies eerst een stek of leg een nieuwe vast.', 'warn'); return; }
    const targetSpecies = chipValue(body, 'species');
    if (!targetSpecies.length) { toast('Kies minstens één doelsoort.', 'warn'); return; }
    const spot = spotById(selectedSpot);
    const method = chipValue(body, 'method');
    const lureId = $('#start-lure', body).value || null;
    const lure = lureById(lureId);
    const waterClarity = chipValue(body, 'water');
    const platform = chipValue(body, 'platform');
    const now = new Date();
    const position = gps && distanceM(gps, spot) < 2000 ? gps : { lat: spot.lat, lng: spot.lng, accuracy: spot.accuracy ?? null };
    const session = {
      id: db.uid(),
      startedAt: now.toISOString(),
      endedAt: null,
      spot: { id: spot.id, name: spot.name, lat: spot.lat, lng: spot.lng },
      position,
      targetSpecies,
      method,
      lureId,
      lure: lureSnap(lure),
      waterClarity,
      platform,
      conditions: computedConditions(now, position),
      weather: { status: 'loading' },
      changes: [{ at: now.toISOString(), method, lureId, lure: lureSnap(lure) }],
      catches: [],
      notes: '',
    };
    state.last = { targetSpecies, method, lureId, waterClarity };
    await db.setSetting('lastChoices', state.last);
    await saveSession(session);
    sheet.close();
    render();
    toast('Sessie gestart. Succes!');
    updateWeather(session).then(() => state.tab === 'vissen' && render());
  });
}

// ----- Wissel aas of methode -----

function openRigSheet(s) {
  const body = el(`<form class="form" novalidate>
    <div class="field"><span class="label">Methode</span>${chips('method', state.methods, s.method)}</div>
    <label class="field"><span class="label">Kunstaas</span><select id="rig-lure">${lureOptions(s.lureId)}</select></label>
    <button type="submit" class="btn primary wide">Opslaan</button>
  </form>`);
  wireChips(body);
  const sheet = openSheet({ title: 'Wissel aas of methode', body });
  body.addEventListener('submit', async (e) => {
    e.preventDefault();
    s.method = chipValue(body, 'method');
    s.lureId = $('#rig-lure', body).value || null;
    s.lure = lureSnap(lureById(s.lureId));
    s.changes = [...(s.changes || []), { at: new Date().toISOString(), method: s.method, lureId: s.lureId, lure: s.lure }];
    state.last = { ...state.last, method: s.method, lureId: s.lureId };
    await db.setSetting('lastChoices', state.last);
    await saveSession(s);
    sheet.close();
    render();
  });
}

// ----- Vangst -----

function openCatchSheet(s, existing = null) {
  const f = existing || {};
  const defaultSpecies = f.species || (s.method === 'Vliegvissen' ? (s.targetSpecies.find((x) => FLY_SPECIES.includes(x)) || s.targetSpecies[0]) : s.targetSpecies[0]) || 'Snoek';
  const at = f.at ? new Date(f.at) : new Date();
  const body = el(`<form class="form" novalidate>
    <div class="field"><span class="label">Soort</span>${chips('species', SPECIES, defaultSpecies)}</div>
    <label class="field length-field">
      <span class="label">Lengte</span>
      <span class="with-unit"><input id="catch-length" type="text" inputmode="decimal" autocomplete="off" placeholder="0" value="${f.lengthCm != null ? String(f.lengthCm).replace('.', ',') : ''}"><span>cm</span></span>
    </label>
    <div class="field">
      <span class="label">Foto</span>
      <div class="photo-pick">
        <img class="photo-preview" alt="Foto van de vangst" ${f.photoId ? `data-photo="${esc(f.photoId)}"` : 'hidden'}>
        <label class="btn ghost small" for="catch-photo">${icon('camera')} ${f.photoId ? 'Andere foto' : 'Foto maken of kiezen'}</label>
        <input id="catch-photo" type="file" accept="image/*" hidden>
      </div>
    </div>
    <details class="more">
      <summary>Aas, methode, tijd en notitie</summary>
      <div class="field"><span class="label">Methode</span>${chips('method', state.methods, f.method || s.method)}</div>
      <label class="field"><span class="label">Kunstaas</span><select id="catch-lure">${lureOptions(existing ? f.lureId : s.lureId)}</select></label>
      <label class="field"><span class="label">Tijdstip</span><input id="catch-time" type="time" value="${fmtTime(at)}"></label>
      <label class="field"><span class="label">Notitie</span><textarea id="catch-notes" rows="2" maxlength="500" placeholder="Bijv. aanbeet vlak bij de rietkraag">${esc(f.notes || '')}</textarea></label>
    </details>
    <div class="actions">
      ${existing ? `<button type="button" class="btn ghost danger" id="catch-delete">${icon('trash')} Verwijder</button>` : ''}
      <button type="submit" class="btn primary">${existing ? 'Opslaan' : 'Vangst opslaan'}</button>
    </div>
  </form>`);
  wireChips(body);
  const sheet = openSheet({ title: existing ? 'Vangst bewerken' : 'Vangst', body });
  fillPhotos(body);

  let newPhoto = null;
  $('#catch-photo', body).addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    try {
      newPhoto = await compressPhoto(file);
      const img = $('.photo-preview', body);
      img.src = URL.createObjectURL(newPhoto);
      img.hidden = false;
    } catch (err) {
      toast(err.message, 'warn');
    }
  });

  if (existing) {
    confirmButton($('#catch-delete', body), 'Tik nogmaals om te verwijderen', async () => {
      s.catches = s.catches.filter((x) => x.id !== f.id);
      if (f.photoId) await db.del('photos', f.photoId);
      await saveSession(s);
      sheet.close();
      render();
    });
  }

  body.addEventListener('submit', async (e) => {
    e.preventDefault();
    const lenRaw = $('#catch-length', body).value.replace(',', '.');
    const lengthCm = lenRaw ? Number(lenRaw) : null;
    if (lengthCm != null && (Number.isNaN(lengthCm) || lengthCm <= 0 || lengthCm > 200)) {
      toast('Vul een lengte in tussen 1 en 200 cm.', 'warn');
      return;
    }
    const [hh, mm] = ($('#catch-time', body).value || fmtTime(at)).split(':').map(Number);
    const when = new Date(existing ? f.at : Date.now());
    when.setHours(hh, mm, 0, 0);
    let photoId = f.photoId || null;
    if (newPhoto) {
      if (photoId) await db.del('photos', photoId);
      photoId = db.uid();
      await db.put('photos', { id: photoId, blob: newPhoto, createdAt: new Date().toISOString() });
    }
    const lureId = $('#catch-lure', body).value || null;
    const record = {
      id: f.id || db.uid(),
      at: when.toISOString(),
      species: chipValue(body, 'species'),
      lengthCm,
      method: chipValue(body, 'method'),
      lureId,
      lure: lureId ? lureSnap(lureById(lureId)) || f.lure || null : null,
      photoId,
      notes: $('#catch-notes', body).value.trim(),
    };
    s.catches = existing ? s.catches.map((x) => (x.id === f.id ? record : x)) : [...s.catches, record];
    s.catches.sort((a, b) => a.at.localeCompare(b.at));
    await saveSession(s);
    sheet.close();
    render();
    if (!existing) toast(`${record.species}${record.lengthCm ? ` van ${fmtNum(record.lengthCm, record.lengthCm % 1 ? 1 : 0)} cm` : ''} opgeslagen`);
  });
}

// ----- Sessie stoppen -----

function openStopSheet(s) {
  const start = new Date(s.startedAt);
  const defaultEnd = toLocalInput(new Date());
  const body = el(`<form class="form" novalidate>
    <p class="summary-line"><strong>${s.catches.length} ${s.catches.length === 1 ? 'vis' : 'vissen'}</strong> in ${fmtDuration(sessionHours(s))}</p>
    ${s.catches.length === 0 ? `<p class="hint">Ook een sessie zonder vis telt mee. Juist die laten zien wanneer het minder goed gaat.</p>` : ''}
    <label class="field"><span class="label">Gestopt om</span><input id="stop-time" type="datetime-local" value="${defaultEnd}" min="${toLocalInput(start)}" max="${toLocalInput(new Date())}"></label>
    <p class="hint">Vergeten te stoppen? Pas de eindtijd hierboven aan.</p>
    <label class="field"><span class="label">Notitie bij de sessie</span><textarea id="stop-notes" rows="3" maxlength="1000" placeholder="Wat viel je op?">${esc(s.notes || '')}</textarea></label>
    <button type="submit" class="btn primary huge">Opslaan en stoppen</button>
  </form>`);
  const sheet = openSheet({ title: 'Sessie stoppen', body });
  body.addEventListener('submit', async (e) => {
    e.preventDefault();
    const raw = $('#stop-time', body).value;
    // Niet aangepast? Dan geldt het echte moment van stoppen (tot op de seconde).
    const end = raw === defaultEnd ? new Date() : new Date(raw);
    if (Number.isNaN(end.getTime()) || end <= start) { toast('De eindtijd moet na de starttijd liggen.', 'warn'); return; }
    if (end > new Date(Date.now() + 60e3)) { toast('De eindtijd kan niet in de toekomst liggen.', 'warn'); return; }
    s.endedAt = end.toISOString();
    s.notes = $('#stop-notes', body).value.trim();
    await saveSession(s);
    sheet.close();
    render();
    toast('Sessie opgeslagen');
  });
}

// ---------- Stekken ----------

async function saveSpot(spot) {
  const record = { ...spot, id: spot.id || db.uid(), createdAt: spot.createdAt || new Date().toISOString() };
  await db.put('spots', record);
  const i = state.spots.findIndex((x) => x.id === record.id);
  if (i >= 0) state.spots[i] = record;
  else state.spots.push(record);
  state.spots.sort((a, b) => a.name.localeCompare(b.name, 'nl'));
  if (mapScreen) mapScreen.refresh(false);
  toast(spot.archived ? 'Stek verborgen' : 'Stek opgeslagen');
  return record;
}

function editSpot(id) {
  const spot = spotById(id);
  if (!spot) return;
  const used = state.sessions.some((s) => s.spot?.id === id);
  openSpotEditor({
    spot,
    canDelete: !used,
    onSave: saveSpot,
    onDelete: async (sp) => {
      await db.del('spots', sp.id);
      state.spots = state.spots.filter((x) => x.id !== sp.id);
      mapScreen.refresh(false);
      toast('Stek verwijderd');
    },
  });
}

// ---------- Logboek ----------

function renderLogboek() {
  const root = $('#screen-logboek');
  const done = state.sessions.filter((s) => s.endedAt);
  const hours = done.reduce((n, s) => n + sessionHours(s), 0);
  const fish = done.reduce((n, s) => n + s.catches.length, 0);
  root.innerHTML = `
    <header class="screen-head">
      <p class="eyebrow">Logboek</p>
      <h1>${done.length} ${done.length === 1 ? 'sessie' : 'sessies'}</h1>
    </header>
    ${done.length ? `<section class="totals">
      <div><span class="big">${fmtNum(hours, 0)}</span><span class="lbl">uur gevist</span></div>
      <div><span class="big">${fish}</span><span class="lbl">vissen</span></div>
      <div><span class="big">${rateText(fish, hours, 2)}</span><span class="lbl">per uur</span></div>
    </section>` : `<div class="card empty-state">
      <p><strong>Nog geen sessies.</strong></p>
      <p class="muted">Start je eerste sessie op het tabblad Vissen. Na afloop staat hij hier, met weer, stek, aas en vangsten.</p>
    </div>`}
    <ol class="log-list">
      ${done.map((s) => {
        const start = new Date(s.startedAt);
        return `<li><button type="button" class="log-row" data-session="${esc(s.id)}">
          <span class="log-date"><span class="d">${start.getDate()}</span><span class="m">${fmtDate(start).split(' ')[2]}</span></span>
          <span class="log-main">
            <strong>${esc(s.spot?.name || '')}</strong>
            <span class="muted">${fmtDate(start).split(' ')[0]} ${fmtTime(start)}–${fmtTime(new Date(s.endedAt))} · ${esc(s.method)} · ${esc(s.conditions?.dayPart || '')}</span>
          </span>
          <span class="log-fish ${s.catches.length ? '' : 'zero'}"><b>${s.catches.length}</b><small>${sRate(s)}/u</small></span>
        </button></li>`;
      }).join('')}
    </ol>
    <section class="card data-card">
      <h2 class="section-title">Je gegevens</h2>
      <p class="muted">Alles staat op deze iPhone. Maak af en toe een back-up en bewaar die in Bestanden of iCloud Drive.</p>
      <div class="data-actions">
        <button class="btn" type="button" id="export-csv">${icon('share')} Exporteer naar Excel</button>
        <button class="btn" type="button" id="make-backup">${icon('share')} Maak back-up</button>
        <label class="btn ghost" for="restore-file">Zet back-up terug</label>
        <input id="restore-file" type="file" accept=".json,application/json" hidden>
      </div>
      <p class="muted small" id="last-backup"></p>
    </section>`;

  $$('[data-session]', root).forEach((b) => b.addEventListener('click', () => openSessionDetail(b.dataset.session)));
  $('#export-csv', root).addEventListener('click', async () => {
    if (!done.length) { toast('Er zijn nog geen afgeronde sessies om te exporteren.', 'warn'); return; }
    await saveFile(`fish-logger_${stamp()}.csv`, buildCsv(state.sessions), 'text/csv');
  });
  $('#make-backup', root).addEventListener('click', async () => {
    const json = await buildBackup();
    const r = await saveFile(`fish-logger-backup_${stamp()}.json`, json, 'application/json');
    if (r !== 'cancelled') {
      await db.setSetting('lastBackup', new Date().toISOString());
      showLastBackup();
    }
  });
  $('#restore-file', root).addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (file) openRestoreSheet(file);
    e.target.value = '';
  });
  const showLastBackup = async () => {
    const t = await db.getSetting('lastBackup', null);
    const p = $('#last-backup', root);
    if (p) p.textContent = t ? `Laatste back-up: ${fmtDate(new Date(t))} om ${fmtTime(new Date(t))}` : 'Nog geen back-up gemaakt.';
  };
  showLastBackup();
}

function openRestoreSheet(file) {
  const body = el(`<div class="form">
    <p>Je zet <strong>${esc(file.name)}</strong> terug. Alle huidige sessies, stekken en kunstaas op deze iPhone worden vervangen door de inhoud van de back-up.</p>
    <button class="btn primary wide danger-fill" type="button" id="do-restore">Vervang mijn gegevens</button>
  </div>`);
  const sheet = openSheet({ title: 'Back-up terugzetten', body });
  confirmButton($('#do-restore', body), 'Tik nogmaals om te vervangen', async () => {
    try {
      const res = await restoreBackup(await file.text());
      state.photoUrls.clear();
      await load();
      sheet.close();
      render();
      toast(`Back-up teruggezet: ${res.sessions} ${res.sessions === 1 ? 'sessie' : 'sessies'}, ${res.photos} ${res.photos === 1 ? 'foto' : "foto's"}`);
    } catch (e) {
      toast(e.message || 'Terugzetten mislukt.', 'warn');
    }
  });
}

function openSessionDetail(id) {
  const s = state.sessions.find((x) => x.id === id);
  if (!s) return;
  const start = new Date(s.startedAt);
  const end = new Date(s.endedAt);
  const c = s.conditions || {};
  const body = el(`<div class="detail">
    <p class="muted">${fmtDate(start)} · ${fmtTime(start)}–${fmtTime(end)} · ${fmtDuration(sessionHours(s))}</p>
    <section class="live-numbers small-nums">
      <div><span class="big">${s.catches.length}</span><span class="lbl">${s.catches.length === 1 ? 'vis' : 'vissen'}</span></div>
      <div><span class="big">${sRate(s, 2)}</span><span class="lbl">per uur</span></div>
      <div><span class="big">${s.catches.length ? fmtNum(Math.max(...s.catches.map((f) => f.lengthCm || 0)), 0) : '–'}</span><span class="lbl">langste (cm)</span></div>
    </section>
    <h3 class="section-title">Weer</h3>
    ${weatherHtml(s.weather)}
    <h3 class="section-title">Omstandigheden</h3>
    <dl class="facts">
      <div><dt>Dagdeel</dt><dd>${esc(c.dayPart)}</dd></div>
      <div><dt>Seizoen</dt><dd>${esc(c.season)}</dd></div>
      <div><dt>Maan</dt><dd>${esc(c.moonPhase)} (${c.moonIllumination ?? '–'}%)</dd></div>
      <div><dt>Water</dt><dd>${esc(s.waterClarity)}</dd></div>
      <div><dt>Vanaf</dt><dd>${esc(s.platform)}</dd></div>
      <div><dt>Doelsoort</dt><dd>${esc((s.targetSpecies || []).join(', '))}</dd></div>
      <div><dt>Methode</dt><dd>${esc(s.method)}</dd></div>
      <div><dt>Aas</dt><dd>${esc(lureName(s.lure))}</dd></div>
    </dl>
    ${s.catches.length ? `<h3 class="section-title">Vangsten</h3><div class="catches">${s.catches.map(catchRow).join('')}</div>` : ''}
    ${s.notes ? `<h3 class="section-title">Notitie</h3><p class="note">${esc(s.notes)}</p>` : ''}
    <div class="actions"><button class="btn ghost danger" type="button" id="del-session">${icon('trash')} Verwijder sessie</button></div>
  </div>`);
  const sheet = openSheet({ title: s.spot?.name || 'Sessie', body });
  fillPhotos(body);
  $$('[data-catch]', body).forEach((b) => b.addEventListener('click', () => openCatchSheet(s, s.catches.find((f) => f.id === b.dataset.catch))));
  confirmButton($('#del-session', body), 'Tik nogmaals om te verwijderen', async () => {
    for (const f of s.catches) if (f.photoId) await db.del('photos', f.photoId);
    await db.del('sessions', s.id);
    state.sessions = state.sessions.filter((x) => x.id !== s.id);
    sheet.close();
    render();
    toast('Sessie verwijderd');
  });
}

// ---------- Tackle box ----------

function renderTackle() {
  const root = $('#screen-tacklebox');
  const showHidden = root.dataset.showHidden === 'true';
  const list = state.lures.filter((l) => showHidden || !l.archived);
  const groups = LURE_TYPES.map((t) => [t, list.filter((l) => l.type === t)]).filter(([, ls]) => ls.length);
  const hiddenCount = state.lures.filter((l) => l.archived).length;
  root.innerHTML = `
    <header class="screen-head">
      <p class="eyebrow">Tackle box</p>
      <h1>${state.lures.filter((l) => !l.archived).length} kunstaas</h1>
    </header>
    <button class="btn primary wide" id="add-lure" type="button">${icon('plus')} Kunstaas toevoegen</button>
    ${groups.length ? groups.map(([t, ls]) => `
      <section class="lure-group">
        <h2 class="section-title">${esc(t)}</h2>
        ${ls.map((l) => `<button type="button" class="lure-row ${l.archived ? 'archived' : ''}" data-lure="${esc(l.id)}">
          <span class="swatch" aria-hidden="true">${esc((l.color || l.type || '?').slice(0, 1).toUpperCase())}</span>
          <span class="lure-main"><strong>${esc(l.name || l.type)}</strong><span class="muted">${esc([l.color, l.sizeCm ? `${fmtNum(l.sizeCm, l.sizeCm % 1 ? 1 : 0)} cm` : '', l.weightG ? `${fmtNum(l.weightG, l.weightG % 1 ? 1 : 0)} g` : ''].filter(Boolean).join(' · '))}${l.archived ? ' · verborgen' : ''}</span></span>
        </button>`).join('')}
      </section>`).join('') : `<div class="card empty-state"><p><strong>Nog geen kunstaas.</strong></p><p class="muted">Voeg je jerkbaits, shads, spinners en vliegen toe. Bij een sessie of vangst kies je ze daarna met één tik.</p></div>`}
    ${hiddenCount ? `<button class="btn ghost small" id="toggle-hidden" type="button">${showHidden ? 'Verberg' : 'Toon'} verborgen aas (${hiddenCount})</button>` : ''}
    <section class="card">
      <h2 class="section-title">Methodes</h2>
      <div class="method-list">${state.methods.map((m) => `<span class="chip on static">${esc(m)}<button type="button" class="chip-x" data-remove-method="${esc(m)}" aria-label="Verwijder ${esc(m)}">${icon('close')}</button></span>`).join('')}</div>
      <form class="inline-add" id="add-method" novalidate>
        <input id="new-method" type="text" maxlength="30" placeholder="Nieuwe methode, bijv. Trollen" aria-label="Nieuwe methode">
        <button class="btn small" type="submit">Toevoegen</button>
      </form>
    </section>`;

  $('#add-lure', root).addEventListener('click', () => openLureSheet());
  $$('[data-lure]', root).forEach((b) => b.addEventListener('click', () => openLureSheet(lureById(b.dataset.lure))));
  $('#toggle-hidden', root)?.addEventListener('click', () => {
    root.dataset.showHidden = String(!showHidden);
    renderTackle();
  });
  $$('[data-remove-method]', root).forEach((b) => b.addEventListener('click', async () => {
    if (state.methods.length <= 1) { toast('Houd minstens één methode over.', 'warn'); return; }
    state.methods = state.methods.filter((m) => m !== b.dataset.removeMethod);
    await db.setSetting('methods', state.methods);
    renderTackle();
  }));
  $('#add-method', root).addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = $('#new-method', root).value.trim();
    if (!v) return;
    if (state.methods.some((m) => m.toLowerCase() === v.toLowerCase())) { toast('Deze methode bestaat al.', 'warn'); return; }
    state.methods = [...state.methods, v];
    await db.setSetting('methods', state.methods);
    renderTackle();
  });
}

function openLureSheet(lure = null) {
  const l = lure || {};
  const body = el(`<form class="form" novalidate>
    <div class="field"><span class="label">Type</span>${chips('type', LURE_TYPES, l.type || 'Jerkbait')}</div>
    <label class="field"><span class="label">Naam of model</span><input id="lure-name" type="text" maxlength="60" placeholder="Bijv. Buster Jerk II" value="${esc(l.name || '')}"></label>
    <label class="field"><span class="label">Kleur</span><input id="lure-color" type="text" maxlength="40" placeholder="Bijv. firetiger, voorn, zwart" value="${esc(l.color || '')}"></label>
    <div class="two">
      <label class="field"><span class="label">Maat</span><span class="with-unit"><input id="lure-size" type="text" inputmode="decimal" autocomplete="off" value="${l.sizeCm != null ? String(l.sizeCm).replace('.', ',') : ''}"><span>cm</span></span></label>
      <label class="field"><span class="label">Gewicht</span><span class="with-unit"><input id="lure-weight" type="text" inputmode="decimal" autocomplete="off" value="${l.weightG != null ? String(l.weightG).replace('.', ',') : ''}"><span>g</span></span></label>
    </div>
    <div class="actions">
      ${lure ? `<button type="button" class="btn ghost" id="lure-archive">${l.archived ? 'Weer tonen' : 'Verbergen'}</button>` : ''}
      <button type="submit" class="btn primary">${lure ? 'Opslaan' : 'Toevoegen'}</button>
    </div>
  </form>`);
  wireChips(body);
  const sheet = openSheet({ title: lure ? 'Kunstaas bewerken' : 'Kunstaas toevoegen', body });
  const num = (id) => { const v = Number($(id, body).value.trim().replace(',', '.')); return $(id, body).value.trim() && Number.isFinite(v) && v > 0 ? v : null; };
  const save = async (extra = {}) => {
    const record = {
      ...l,
      id: l.id || db.uid(),
      type: chipValue(body, 'type'),
      name: $('#lure-name', body).value.trim(),
      color: $('#lure-color', body).value.trim(),
      sizeCm: num('#lure-size'),
      weightG: num('#lure-weight'),
      archived: l.archived || false,
      createdAt: l.createdAt || new Date().toISOString(),
      ...extra,
    };
    if (!record.name && !record.color) { toast('Vul een naam of kleur in, zodat je het aas herkent.', 'warn'); return; }
    await db.put('lures', record);
    const i = state.lures.findIndex((x) => x.id === record.id);
    if (i >= 0) state.lures[i] = record; else state.lures.push(record);
    state.lures.sort((a, b) => (a.type + a.name).localeCompare(b.type + b.name, 'nl'));
    sheet.close();
    renderTackle();
    toast(lure ? 'Kunstaas bijgewerkt' : 'Kunstaas toegevoegd');
  };
  body.addEventListener('submit', (e) => { e.preventDefault(); save(); });
  $('#lure-archive', body)?.addEventListener('click', () => save({ archived: !l.archived }));
}

// ---------- Start ----------

function shell() {
  document.getElementById('app').innerHTML = `
    <main>
      ${TABS.map((t) => `<section class="screen ${t.id === 'kaart' ? 'screen-map' : ''}" id="screen-${t.id}" hidden></section>`).join('')}
    </main>
    <nav class="tabbar" aria-label="Hoofdmenu">
      ${TABS.map((t) => `<button type="button" data-tab="${t.id}" aria-current="false">${icon(t.icon)}<span>${t.label}</span></button>`).join('')}
    </nav>`;
  $('.tabbar').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]');
    if (b) setTab(b.dataset.tab);
  });
  document.addEventListener('click', (e) => {
    const g = e.target.closest('[data-goto]');
    if (g) setTab(g.dataset.goto);
  });
  mapScreen = new MapScreen($('#screen-kaart'), {
    getSpots: async () => state.spots,
    statsFor: spotStats,
    onEditSpot: editSpot,
    onNewSpot: () => openSpotEditor({ onSave: saveSpot }),
  });
}

async function boot() {
  shell();
  try {
    await load();
  } catch (e) {
    document.getElementById('app').innerHTML = `<div class="card fatal"><p><strong>Fish Logger kan zijn opslag niet openen.</strong></p><p>${esc(e.message || '')}</p><p>Open de app vanaf je beginscherm of in Safari zonder privémodus.</p></div>`;
    return;
  }
  const hash = location.hash.replace('#', '');
  setTab(hash || 'vissen');
  db.requestPersistence();
  backfillWeather();
  window.addEventListener('online', backfillWeather);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { backfillWeather(); if (state.tab === 'vissen') renderVissen(); }
  });
  setInterval(() => {
    const s = active();
    if (!s || state.tab !== 'vissen') return;
    const e1 = $('#live-elapsed');
    const e2 = $('#live-rate');
    if (e1) e1.textContent = fmtDuration(sessionHours(s));
    if (e2) e2.textContent = sRate(s);
  }, 30000);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
}

boot();
