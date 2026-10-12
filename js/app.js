// Fish Logger — release 1
import * as db from './db.js';
import { computedConditions, fetchWeather, distanceM, DEFAULT_POS } from './conditions.js';
import { buildCsv, buildBackup, restoreBackup, saveFile, stamp, sessionHours } from './data-export.js';
import { MapScreen, openSpotEditor, openPointPicker, createSessionMap, getPosition } from './map.js';
import { recognizeLure, getKey, setKey, clearKey, getMode, setMode } from './recognize.js';
import { FACTORS, MIN_SESSIONS, scope, factorTable, bestCombinations, overall } from './insights.js';
import {
  esc, $, $$, el, icon, toast, openSheet, confirmButton, chips, wireChips, chipValue, compressPhoto,
  fmtTime, fmtDate, fmtDuration, fmtNum, toLocalInput,
} from './ui.js';

export const SPECIES = ['Snoek', 'Snoekbaars', 'Baars', 'Forel', 'Kopvoorn', 'Ruisvoorn', 'Winde', 'Overig'];
import { LURE_TYPES, LEGACY_TYPES, FLY_TYPE, categoryOf, isFlySession } from './lure-types.js';
import { activeHours, pauseHours, isPaused, clampPauses } from './session-time.js';
const WATER = ['Helder', 'Licht troebel', 'Troebel'];
const PLATFORMS = ['Kant', 'Wadend', 'Boot'];

const state = {
  tab: 'vissen',
  spots: [],
  lures: [],
  sessions: [],
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
  await migrateLureTypes();
  state.last = await db.getSetting('lastChoices', {});
}

/**
 * FL-26/27: zet kunstaas één keer om naar de nieuwe categorieën.
 * Lepel en Overig krijgen geen categorie (de tackle box vraagt erom); vliegen worden verborgen.
 */
async function migrateLureTypes() {
  // Draait bij elke start (ook na het terugzetten van een oude back-up); raakt alleen oude categorieën.
  for (const l of state.lures) {
    let changed = false;
    if (LEGACY_TYPES[l.type]) { l.type = LEGACY_TYPES[l.type]; changed = true; }
    else if (l.type === FLY_TYPE) { if (!l.archived && !l.flyHidden) { l.archived = true; l.flyHidden = true; changed = true; } }
    else if (l.type && !LURE_TYPES.includes(l.type)) { l.legacyType = l.type; l.type = ''; changed = true; }
    if (changed) await db.put('lures', l);
  }
  state.lures.sort((a, b) => (a.type + a.name).localeCompare(b.type + b.name, 'nl'));
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
    // Mislukte pogingen hooguit eens per 6 uur opnieuw proberen.
    const todo = state.sessions.filter((s) => s.weather?.status !== 'ok' && !(s.weather?.status === 'failed' && Date.now() - Date.parse(s.weather.triedAt || 0) < 6 * 3600e3));
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
  { id: 'inzichten', label: 'Inzichten', icon: 'chart' },
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
  if (state.tab === 'inzichten') renderInzichten();
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
      <p class="eyebrow">${isPaused(s) ? 'Gepauzeerd' : 'Sessie loopt'} · gestart ${fmtTime(new Date(s.startedAt))}</p>
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
        <p class="rig-main">${esc(lureName(s.lure))}</p>
        ${categoryOf(s.lure) ? `<p class="muted small">${esc(categoryOf(s.lure))}</p>` : ''}
      </div>
      <button class="btn ghost small" id="change-rig" type="button">Wissel</button>
    </section>

    ${isPaused(s) ? `<section class="card pause-card" aria-live="polite">
      <p class="eyebrow">Pauze sinds ${fmtTime(new Date(s.pauses.find((p) => !p.end).start))}</p>
      <p class="pause-time"><span id="pause-elapsed">${fmtDuration(pauseOpenHours(s))}</span> pauze · de klok staat stil</p>
      <button class="btn primary huge" id="resume" type="button">${icon('fish')} Verder vissen</button>
    </section>` : ''}
    <div class="catch-actions" ${isPaused(s) ? 'hidden' : ''}>
      <button class="btn primary huge" id="add-catch" type="button">${icon('plus')} Vangst toevoegen</button>
      <button class="btn bite-btn" id="add-bite" type="button">
        <span class="bite-label">Aanbeet of misser</span>
        <span class="bite-count" aria-label="${(s.bites || []).length} aanbeten zonder vangst">${(s.bites || []).length}</span>
      </button>
    </div>

    <section class="catches">
      ${s.catches.length ? `<h2 class="section-title">Vangsten</h2>` : ''}
      ${[...s.catches].reverse().map(catchRow).join('')}
    </section>

    <div class="session-actions">
      ${isPaused(s) ? '' : `<button class="btn ghost" id="pause-session" type="button">${icon('pause')} Pauze</button>`}
      <button class="btn ghost" id="stop-session" type="button">${icon('stop')} Sessie stoppen</button>
    </div>
    ${pauseHours(s) > 0 && !isPaused(s) ? `<p class="hint center">${fmtDuration(pauseHours(s))} pauze telt niet mee als vistijd.</p>` : ''}`;

  $('#add-catch', root).addEventListener('click', () => openCatchSheet(s));
  $('#add-bite', root).addEventListener('click', () => addBite(s));
  $('#stop-session', root).addEventListener('click', () => openStopSheet(s));
  $('#pause-session', root)?.addEventListener('click', () => pauseSession(s));
  $('#resume', root)?.addEventListener('click', () => resumeSession(s));
  $('#change-rig', root).addEventListener('click', () => openRigSheet(s));
  $$('[data-catch]', root).forEach((b) => b.addEventListener('click', () => openCatchSheet(s, s.catches.find((f) => f.id === b.dataset.catch))));
  fillPhotos(root);
}

// ----- Pauzeren (FL-29) -----

const pauseOpenHours = (s) => {
  const p = (s.pauses || []).find((x) => !x.end);
  return p ? Math.max(0, Date.now() - Date.parse(p.start)) / 3600e3 : 0;
};

async function pauseSession(s) {
  if (isPaused(s)) return;
  s.pauses = [...(s.pauses || []), { start: new Date().toISOString(), end: null }];
  await saveSession(s);
  render();
  toast('Pauze. De klok staat stil.');
}

async function resumeSession(s) {
  const p = (s.pauses || []).find((x) => !x.end);
  if (!p) return;
  p.end = new Date().toISOString();
  await saveSession(s);
  render();
  toast(`Verder na ${fmtDuration((Date.parse(p.end) - Date.parse(p.start)) / 3600e3)} pauze`);
}

// ----- Aanbeten en missers tellen (FL-9) -----

/** Telt een aanbeet zonder vangst met één tik: tijd en aas gaan mee, de plek volgt op de achtergrond. */
async function addBite(s) {
  const bite = { id: db.uid(), at: new Date().toISOString(), lureId: s.lureId, lure: s.lure, position: null };
  s.bites = [...(s.bites || []), bite];
  await saveSession(s);
  if (navigator.vibrate) { try { navigator.vibrate(15); } catch (_) { /* geen trilling */ } }
  render();
  const n = s.bites.length;
  toast(`Aanbeet geteld (${n})`, '', {
    label: 'Ongedaan maken',
    onClick: async () => {
      s.bites = (s.bites || []).filter((b) => b.id !== bite.id);
      await saveSession(s);
      render();
    },
  });
  getPosition({ timeout: 20000, maximumAge: 0 })
    .then(async (p) => {
      const saved = (s.bites || []).find((b) => b.id === bite.id);
      if (!saved) return;
      saved.position = { lat: p.lat, lng: p.lng, accuracy: p.accuracy };
      await saveSession(s);
    })
    .catch(() => {});
}

function catchRow(f) {
  return `<button class="catch-row" type="button" data-catch="${esc(f.id)}">
    ${f.photoId ? `<img data-photo="${esc(f.photoId)}" alt="" class="thumb">` : `<span class="thumb empty">${icon('fish')}</span>`}
    <span class="catch-main">
      <strong>${esc(f.species)}${f.lengthCm ? ` · ${fmtNum(f.lengthCm, f.lengthCm % 1 ? 1 : 0)} cm` : ''}</strong>
      <span class="muted">${fmtTime(new Date(f.at))} · ${esc(lureShort(f.lure))}${f.position ? ` <span class="has-place" title="Plek vastgelegd">${icon('pin')}</span>` : ''}</span>
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

// ----- Kunstaas kiezen met foto-carousels (FL-24) -----

/** Hoe vaak elk aas is gekozen: bij de start van een sessie en bij elke wissel. */
function lureUsage() {
  const count = new Map();
  for (const s of state.sessions) {
    const picks = s.changes && s.changes.length ? s.changes : [{ lureId: s.lureId }];
    for (const c of picks) if (c.lureId) count.set(c.lureId, (count.get(c.lureId) || 0) + 1);
  }
  return count;
}

/**
 * Twee carousels: eerst het type, dan het aas zelf (met foto). Meest gekozen eerst.
 * Geeft { value } terug met het gekozen lure-id (of null voor "geen aas").
 */
function mountLurePicker(container, selectedId) {
  const usage = lureUsage();
  const lures = state.lures.filter((l) => (!l.archived || l.id === selectedId) && categoryOf(l));
  const picker = { value: selectedId && lures.some((l) => l.id === selectedId) ? selectedId : null };
  if (!lures.length) {
    container.innerHTML = `<p class="muted">Je tackle box is nog leeg. Voeg kunstaas toe via het tabblad Tackle box; dan kies je het hier met een tik op de foto.</p>`;
    return picker;
  }
  const typeUse = new Map();
  for (const l of lures) typeUse.set(l.type, (typeUse.get(l.type) || 0) + (usage.get(l.id) || 0));
  const unsorted = state.lures.filter((l) => !l.archived && !categoryOf(l)).length;
  const types = [...typeUse.keys()].sort((a, b) => typeUse.get(b) - typeUse.get(a) || LURE_TYPES.indexOf(a) - LURE_TYPES.indexOf(b));
  const firstOfType = (t) => lures.find((l) => l.type === t && l.photoId) || lures.find((l) => l.type === t);
  let type = picker.value ? lureById(picker.value).type : types[0];

  const sizeText = (l) => (l.sizeCm ? `${fmtNum(l.sizeCm, l.sizeCm % 1 ? 1 : 0)} cm` : '');
  const draw = (scrollToSelected) => {
    const inType = lures
      .filter((l) => l.type === type)
      .sort((a, b) => (usage.get(b.id) || 0) - (usage.get(a.id) || 0) || (a.name || '').localeCompare(b.name || '', 'nl'));
    container.innerHTML = `
      <div class="carousel type-carousel" role="radiogroup" aria-label="Type kunstaas">
        ${types.map((t) => {
          const l = firstOfType(t);
          return `<button type="button" class="type-card ${t === type ? 'on' : ''}" data-type="${esc(t)}" role="radio" aria-checked="${t === type}">
            ${l && l.photoId ? `<img data-photo="${esc(l.photoId)}" alt="">` : `<span class="type-ini" aria-hidden="true">${esc(t.slice(0, 1))}</span>`}
            <span>${esc(t)}</span>
          </button>`;
        }).join('')}
        <button type="button" class="type-card none ${picker.value === null && type === null ? 'on' : ''}" data-type="" role="radio" aria-checked="${type === null}">
          <span class="type-ini" aria-hidden="true">–</span><span>Geen aas</span>
        </button>
      </div>
      ${unsorted ? `<p class="hint small">${unsorted} ${unsorted === 1 ? 'aas heeft' : 'aasjes hebben'} nog geen categorie. Kies die in de Tackle box.</p>` : ''}
      ${type === null ? `<p class="muted picker-note">Je start zonder aas. Kies later via Wissel.</p>` : `
      <div class="carousel lure-carousel" role="radiogroup" aria-label="${esc(type)}">
        ${inType.map((l) => `<button type="button" class="lure-card ${l.id === picker.value ? 'on' : ''}" data-pick="${esc(l.id)}" role="radio" aria-checked="${l.id === picker.value}">
          ${l.photoId ? `<img data-photo="${esc(l.photoId)}" alt="">` : `<span class="lure-ph" aria-hidden="true">${esc((l.color || l.name || '?').slice(0, 1).toUpperCase())}</span>`}
          <span class="lure-card-name">${esc(l.name || l.type)}</span>
          <span class="lure-card-sub">${esc([l.color, sizeText(l)].filter(Boolean).join(' · '))}</span>
        </button>`).join('')}
      </div>
      <p class="picker-note ${picker.value ? '' : 'muted'}">${picker.value ? `Gekozen: <b>${esc(lureName(lureById(picker.value)))}</b>` : 'Tik op het aas dat aan je lijn hangt.'}</p>`}`;
    fillPhotos(container);
    if (scrollToSelected) {
      const on = $('.lure-card.on', container);
      if (on && on.scrollIntoView) on.scrollIntoView({ block: 'nearest', inline: 'center' });
    }
  };
  container.addEventListener('click', (e) => {
    const t = e.target.closest('[data-type]');
    if (t) {
      const nt = t.dataset.type || null;
      if (nt === type) return;
      type = nt;
      if (type === null) picker.value = null;
      else {
        // Nieuw type: kies meteen het meest gebruikte aas van dat type.
        const top = lures
          .filter((l) => l.type === type)
          .sort((a, b) => (usage.get(b.id) || 0) - (usage.get(a.id) || 0) || (a.name || '').localeCompare(b.name || '', 'nl'))[0];
        picker.value = top ? top.id : null;
      }
      draw(false);
      return;
    }
    const c = e.target.closest('[data-pick]');
    if (c) {
      picker.value = c.dataset.pick;
      draw(false);
    }
  });
  if (!picker.value && type) {
    const top = lures.filter((l) => l.type === type).sort((a, b) => (usage.get(b.id) || 0) - (usage.get(a.id) || 0))[0];
    picker.value = top ? top.id : null;
  }
  draw(true);
  return picker;
}

function lureOptions(selectedId) {
  const active = state.lures.filter((l) => (!l.archived && categoryOf(l)) || l.id === selectedId);
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
    <div class="field"><span class="label">Kunstaas</span><div id="start-lure"></div></div>
    <div class="field"><span class="label">Waterhelderheid</span>${chips('water', WATER, last.waterClarity || 'Licht troebel')}</div>
    <div class="field"><span class="label">Je vist vanaf</span>${chips('platform', PLATFORMS, 'Kant')}</div>
    <button type="submit" class="btn primary huge">Start</button>
  </form>`);
  wireChips(body);
  const sheet = openSheet({ title: 'Nieuwe sessie', body });
  const lurePicker = mountLurePicker($('#start-lure', body), last.lureId);

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
    const lureId = lurePicker.value || null;
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
      lureId,
      lure: lureSnap(lure),
      waterClarity,
      platform,
      conditions: computedConditions(now, position),
      weather: { status: 'loading' },
      changes: [{ at: now.toISOString(), lureId, lure: lureSnap(lure) }],
      catches: [],
      notes: '',
    };
    state.last = { targetSpecies, lureId, waterClarity };
    await db.setSetting('lastChoices', state.last);
    await saveSession(session);
    sheet.close();
    render();
    toast('Sessie gestart. Succes!');
    updateWeather(session).then(() => state.tab === 'vissen' && render());
  });
}

// ----- Wissel van aas -----

function openRigSheet(s) {
  const body = el(`<form class="form" novalidate>
    <div class="field"><span class="label">Kunstaas</span><div id="rig-lure"></div></div>
    <button type="submit" class="btn primary wide">Opslaan</button>
  </form>`);
  wireChips(body);
  const sheet = openSheet({ title: 'Wissel van aas', body });
  const lurePicker = mountLurePicker($('#rig-lure', body), s.lureId);
  body.addEventListener('submit', async (e) => {
    e.preventDefault();
    if ((lurePicker.value || null) === (s.lureId || null)) { sheet.close(); return; }
    s.lureId = lurePicker.value || null;
    s.lure = lureSnap(lureById(s.lureId));
    const change = { id: db.uid(), at: new Date().toISOString(), lureId: s.lureId, lure: s.lure, position: null };
    s.changes = [...(s.changes || []), change];
    state.last = { ...state.last, lureId: s.lureId };
    await db.setSetting('lastChoices', state.last);
    await saveSession(s);
    sheet.close();
    render();
    // FL-25: plek van de wissel op de achtergrond vastleggen.
    getPosition({ timeout: 20000, maximumAge: 0 })
      .then(async (p) => {
        const saved = (s.changes || []).find((x) => x.id === change.id);
        if (!saved) return;
        saved.position = { lat: p.lat, lng: p.lng, accuracy: p.accuracy };
        await saveSession(s);
      })
      .catch(() => {});
  });
}

// ----- Vangst -----

function openCatchSheet(s, existing = null, onSaved = null) {
  const f = existing || {};
  const defaultSpecies = f.species || s.targetSpecies[0] || 'Snoek';
  // Bij een afgeronde sessie (achteraf invullen) begint de tijd bij de start van de sessie.
  const at = f.at ? new Date(f.at) : s.endedAt ? new Date(s.startedAt) : new Date();
  // FL-22: bij een nieuwe vangst tijdens een lopende sessie wordt de plek op de achtergrond bepaald.
  const live = !existing && !s.endedAt;
  let place = f.position || null;
  let placeTouched = false;
  let gpsPending = live;
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
    <div class="field">
      <span class="label">Plek</span>
      <div class="place-row">
        <span class="place-text" aria-live="polite"></span>
        <button type="button" class="btn ghost small" id="catch-place">${icon('map')} Op kaart</button>
      </div>
    </div>
    <details class="more">
      <summary>Aas, tijd en notitie</summary>
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

  const showPlace = () => {
    const t = $('.place-text', body);
    if (place) t.textContent = place.byHand ? 'Op de kaart gekozen' : `Huidige locatie${place.accuracy ? ` (± ${place.accuracy} m)` : ''}`;
    else if (gpsPending) t.innerHTML = '<span class="spinner" aria-hidden="true"></span> Locatie bepalen…';
    else t.textContent = 'Geen plek vastgelegd';
  };
  showPlace();
  const gpsPromise = live
    ? getPosition({ timeout: 20000, maximumAge: 0 })
        .then((p) => ({ lat: p.lat, lng: p.lng, accuracy: p.accuracy, byHand: false }))
        .catch(() => null)
        .then((p) => {
          gpsPending = false;
          if (p && !placeTouched) place = p;
          if (document.body.contains(body)) showPlace();
          return p;
        })
    : null;
  $('#catch-place', body).addEventListener('click', () => {
    const fallback = s.position || (s.spot ? { lat: s.spot.lat, lng: s.spot.lng } : null);
    openPointPicker({
      title: 'Plek van de vangst',
      start: place,
      fallback,
      hint: 'Sleep de stip naar de plek waar je de vis ving, of tik op de kaart.',
      onSave: (p) => { place = p; placeTouched = true; gpsPending = false; showPlace(); },
      onClear: () => { place = null; placeTouched = true; gpsPending = false; showPlace(); },
    });
  });

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
      onSaved && onSaved();
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
    const when = new Date(existing ? f.at : s.endedAt ? s.startedAt : Date.now());
    when.setHours(hh, mm, 0, 0);
    // Sessie over middernacht: een tijd vóór de start hoort bij de volgende dag.
    if (s.endedAt && when < new Date(s.startedAt)) when.setDate(when.getDate() + 1);
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
      lureId,
      lure: lureId ? lureSnap(lureById(lureId)) || f.lure || null : null,
      photoId,
      notes: $('#catch-notes', body).value.trim(),
      position: place,
    };
    s.catches = existing ? s.catches.map((x) => (x.id === f.id ? record : x)) : [...s.catches, record];
    s.catches.sort((a, b) => a.at.localeCompare(b.at));
    await saveSession(s);
    sheet.close();
    render();
    onSaved && onSaved();
    if (!existing) toast(`${record.species}${record.lengthCm ? ` van ${fmtNum(record.lengthCm, record.lengthCm % 1 ? 1 : 0)} cm` : ''} opgeslagen`);
    // GPS nog bezig? Dan de plek aanvullen zodra die bekend is; opslaan hoeft er niet op te wachten.
    if (gpsPromise && !place && !placeTouched) {
      gpsPromise.then(async (p) => {
        const saved = s.catches.find((x) => x.id === record.id);
        if (!p || !saved || saved.position) return;
        saved.position = p;
        await saveSession(s);
        if (state.tab === 'vissen' || state.tab === 'kaart') render();
      });
    }
  });
}

// ----- Sessie stoppen -----

function openStopSheet(s) {
  const start = new Date(s.startedAt);
  const defaultEnd = toLocalInput(new Date());
  const body = el(`<form class="form" novalidate>
    <p class="summary-line"><strong>${s.catches.length} ${s.catches.length === 1 ? 'vis' : 'vissen'}</strong>${(s.bites || []).length ? ` en ${s.bites.length} ${s.bites.length === 1 ? 'aanbeet' : 'aanbeten'} zonder vangst` : ''} in ${fmtDuration(sessionHours(s))}${pauseHours(s) > 0 ? ` (plus ${fmtDuration(pauseHours(s))} pauze)` : ''}</p>
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
    clampPauses(s); // een lopende pauze eindigt bij het stoppen
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
    <button class="btn wide" type="button" id="add-past">${icon('plus')} Sessie achteraf toevoegen</button>
    <ol class="log-list">
      ${done.map((s) => {
        const start = new Date(s.startedAt);
        return `<li class="swipe" data-swipe="${esc(s.id)}">
          <button type="button" class="swipe-del" data-del-session="${esc(s.id)}" tabindex="-1">${icon('trash')}<span>Verwijder</span></button>
          <button type="button" class="log-row swipe-front" data-session="${esc(s.id)}">
          <span class="log-date"><span class="d">${start.getDate()}</span><span class="m">${fmtDate(start).split(' ')[2]}</span></span>
          <span class="log-main">
            <strong>${esc(s.spot?.name || '')}</strong>
            <span class="muted">${fmtDate(start).split(' ')[0]} ${fmtTime(start)}–${fmtTime(new Date(s.endedAt))} · ${esc(lureShort((s.changes && s.changes[0] ? s.changes[0].lure : s.lure)))} · ${esc(s.conditions?.dayPart || '')}</span>
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

  $$('[data-session]', root).forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.justSwiped) return; // de tik hoorde bij het schuiven
    const li = b.closest('.swipe');
    if (li && li.classList.contains('open')) { closeSwipes(); return; }
    openSessionDetail(b.dataset.session);
  }));
  $$('[data-del-session]', root).forEach((b) => b.addEventListener('click', () => deleteSession(b.dataset.delSession)));
  $$('.swipe', root).forEach(wireSwipe);
  $('#add-past', root).addEventListener('click', () => openSessionForm());
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

// ----- Schuiven om te verwijderen -----

const SWIPE_W = 96; // breedte van de verwijderknop

function closeSwipes(except = null) {
  $$('.swipe.open').forEach((li) => {
    if (li === except) return;
    li.classList.remove('open');
    $('.swipe-front', li).style.transform = '';
    $('.swipe-del', li).tabIndex = -1;
  });
}

function wireSwipe(li) {
  const front = $('.swipe-front', li);
  let startX = 0, startY = 0, dx = 0, base = 0, tracking = false, horizontal = null, pid = null;
  front.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    tracking = true; horizontal = null; dx = 0; pid = e.pointerId;
    startX = e.clientX; startY = e.clientY;
    base = li.classList.contains('open') ? -SWIPE_W : 0;
  });
  front.addEventListener('pointermove', (e) => {
    if (!tracking || e.pointerId !== pid) return;
    const mx = e.clientX - startX, my = e.clientY - startY;
    if (horizontal === null && (Math.abs(mx) > 8 || Math.abs(my) > 8)) {
      horizontal = Math.abs(mx) > Math.abs(my);
      if (horizontal) { front.setPointerCapture(pid); li.classList.add('dragging'); closeSwipes(li); }
    }
    if (!horizontal) return;
    dx = mx;
    const x = Math.max(-SWIPE_W * 1.4, Math.min(0, base + dx));
    front.style.transform = `translateX(${x}px)`;
  });
  const end = () => {
    if (!tracking) return;
    tracking = false;
    li.classList.remove('dragging');
    if (!horizontal) return;
    front.dataset.justSwiped = '1';
    setTimeout(() => delete front.dataset.justSwiped, 50);
    const open = base + dx < -SWIPE_W / 2;
    li.classList.toggle('open', open);
    front.style.transform = open ? `translateX(${-SWIPE_W}px)` : '';
    $('.swipe-del', li).tabIndex = open ? 0 : -1;
  };
  front.addEventListener('pointerup', end);
  front.addEventListener('pointercancel', end);
}

/** Verwijdert een sessie, met 6 seconden de tijd om het ongedaan te maken. */
async function deleteSession(id) {
  const s = state.sessions.find((x) => x.id === id);
  if (!s) return;
  await db.del('sessions', id);
  state.sessions = state.sessions.filter((x) => x.id !== id);
  render();
  toast('Sessie verwijderd', '', {
    label: 'Ongedaan maken',
    onClick: async () => {
      await saveSession(s);
      render();
      toast('Sessie teruggezet');
    },
    // Foto's pas echt weggooien als er niet meer ongedaan gemaakt kan worden.
    onExpire: async () => {
      if (state.sessions.some((x) => x.id === id)) return;
      for (const f of s.catches) if (f.photoId) await db.del('photos', f.photoId);
    },
  });
}

document.addEventListener('pointerdown', (e) => {
  if (!e.target.closest('.swipe')) closeSwipes();
});

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

// ----- Aastabel in de sessiesamenvatting (FL-28) -----

const lureKey = (l, id) => id || (l ? `${l.type}|${l.name || ''}|${l.color || ''}` : 'none');

/** Per aas: gebruikstijd (uit de wissels), vangsten, missers en totale lengte. */
function lureStatsForSession(s) {
  const rows = new Map();
  const row = (lure, id) => {
    const k = lureKey(lure, id);
    if (!rows.has(k)) rows.set(k, { lure, hours: 0, fish: 0, bites: 0, cm: 0 });
    return rows.get(k);
  };
  const start = Date.parse(s.startedAt);
  const end = Date.parse(s.endedAt || new Date().toISOString());
  const picks = (s.changes && s.changes.length ? s.changes : [{ at: s.startedAt, lureId: s.lureId, lure: s.lure }])
    .map((c) => ({ ...c, t: Math.min(Math.max(Date.parse(c.at), start), end) }))
    .sort((a, b) => a.t - b.t);
  picks.forEach((c, i) => {
    const until = i + 1 < picks.length ? picks[i + 1].t : end;
    row(c.lure, c.lureId).hours += activeHours(s, c.t, until);
  });
  for (const f of s.catches) {
    const r = row(f.lure, f.lureId);
    r.fish += 1;
    r.cm += f.lengthCm || 0;
  }
  for (const b of s.bites || []) row(b.lure, b.lureId).bites += 1;
  // Groeperen per categorie, in de vaste volgorde; binnen een groep het meest gebruikte aas eerst.
  const groups = new Map();
  for (const r of rows.values()) {
    if (r.hours < 1 / 120 && !r.fish && !r.bites) continue; // korter dan een halve minuut en niets gebeurd
    const g = r.lure ? categoryOf(r.lure) || 'Zonder categorie' : 'Zonder aas';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(r);
  }
  const order = [...LURE_TYPES, 'Zonder categorie', 'Zonder aas'];
  return [...groups.entries()]
    .sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]))
    .map(([cat, list]) => [cat, list.sort((a, b) => b.hours - a.hours || b.fish - a.fish)]);
}

const hm = (h) => {
  const m = Math.round(h * 60);
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
};

function lureTableHtml(s) {
  const groups = lureStatsForSession(s);
  if (!groups.length) return '<p class="muted">Geen aas vastgelegd in deze sessie.</p>';
  return `<div class="table-wrap"><table class="lure-table">
    <thead><tr><th scope="col">Aas</th><th scope="col" class="num">Tijd</th><th scope="col" class="num">Vis</th><th scope="col" class="num">Mis</th><th scope="col" class="num">cm</th></tr></thead>
    ${groups.map(([cat, list]) => `<tbody>
      <tr class="cat-row"><th colspan="5" scope="rowgroup">${esc(cat)}</th></tr>
      ${list.map((r) => `<tr>
        <th scope="row"><span class="lt-name">${esc(r.lure ? r.lure.name || r.lure.type || 'Aas' : 'Geen aas')}</span>${r.lure && r.lure.color ? `<span class="lt-color">${esc(r.lure.color)}</span>` : ''}</th>
        <td class="num">${r.hours >= 1 / 120 ? hm(r.hours) : '–'}</td>
        <td class="num ${r.fish ? 'hit' : 'zero'}">${r.fish}</td>
        <td class="num ${r.bites ? '' : 'zero'}">${r.bites}</td>
        <td class="num ${r.cm ? '' : 'zero'}">${r.cm ? fmtNum(r.cm, r.cm % 1 ? 1 : 0) : '–'}</td>
      </tr>`).join('')}
    </tbody>`).join('')}
  </table></div>
  <p class="hint small">Tijd in uren:minuten. Vis = vangsten, Mis = aanbeten zonder vangst, cm = totale lengte van de gevangen vis.</p>`;
}

/** Al het aas dat in een sessie is gebruikt, in volgorde van eerste gebruik. */
function usedInSession(s) {
  const lures = [];
  const addL = (l) => { const n = l ? lureShort(l) : ''; if (n && !lures.includes(n)) lures.push(n); };
  const picks = s.changes && s.changes.length ? s.changes : [{ lure: s.lure }];
  for (const c of picks) addL(c.lure);
  for (const f of s.catches) addL(f.lure);
  return { lures };
}

/** Naam of model met de categorie erbij, bijv. "Westin Swim (Jerkbaits)", zodat gelijke merken uit elkaar te houden zijn. */
function lureShort(l) {
  if (!l) return 'geen aas';
  const cat = categoryOf(l);
  const name = l.name || '';
  if (name && cat) return `${name} (${cat})`;
  return name || cat || l.type || 'aas';
}

function sessionMapItems(s) {
  const t = (x) => fmtTime(new Date(x.at));
  const start = s.position || (s.spot ? { lat: s.spot.lat, lng: s.spot.lng } : null);
  return {
    start: start ? { lat: start.lat, lng: start.lng, title: `Start · ${fmtTime(new Date(s.startedAt))}`, sub: s.spot?.name || '' } : null,
    catches: s.catches.filter((f) => f.position).map((f) => ({
      lat: f.position.lat, lng: f.position.lng,
      title: `${f.species}${f.lengthCm ? ` · ${fmtNum(f.lengthCm, f.lengthCm % 1 ? 1 : 0)} cm` : ''}`,
      sub: `${t(f)} · ${lureShort(f.lure)}`,
    })),
    bites: (s.bites || []).filter((b) => b.position).map((b) => ({ lat: b.position.lat, lng: b.position.lng, title: 'Misser', sub: `${t(b)} · ${lureShort(b.lure)}` })),
    switches: (s.changes || []).slice(1).filter((c) => c.position).map((c) => ({ lat: c.position.lat, lng: c.position.lng, title: `Wissel · ${t(c)}`, sub: lureShort(c.lure) })),
  };
}

function openSessionDetail(id) {
  let miniMap = null;
  const sheet = openSheet({ title: 'Sessie', body: '', onClose: () => { if (miniMap) { miniMap.remove(); miniMap = null; } } });
  const draw = () => {
    if (miniMap) { miniMap.remove(); miniMap = null; }
    const s = state.sessions.find((x) => x.id === id);
    if (!s) { sheet.close(); return; }
    const start = new Date(s.startedAt);
    const end = new Date(s.endedAt);
    const c = s.conditions || {};
    $('.sheet-head h2', sheet.el).textContent = s.spot?.name || 'Sessie';
    const wissels = (s.changes || []).length > 1 ? s.changes.slice(1) : [];
    const mapItems = sessionMapItems(s);
    const nPlaced = mapItems.catches.length + mapItems.bites.length + mapItems.switches.length + (mapItems.start ? 1 : 0);
    const legend = [
      mapItems.start ? `<span class="lg"><i class="lg-pin"></i>Start</span>` : '',
      mapItems.catches.length ? `<span class="lg"><i class="lg-catch"></i>${mapItems.catches.length} ${mapItems.catches.length === 1 ? 'vangst' : 'vangsten'}</span>` : '',
      mapItems.bites.length ? `<span class="lg"><i class="lg-bite"></i>${mapItems.bites.length} ${mapItems.bites.length === 1 ? 'misser' : 'missers'}</span>` : '',
      mapItems.switches.length ? `<span class="lg"><i class="lg-switch"></i>${mapItems.switches.length} ${mapItems.switches.length === 1 ? 'wissel' : 'wissels'}</span>` : '',
    ].join('');
    sheet.body.innerHTML = `<div class="detail">
      <p class="muted">${fmtDate(start)} · ${fmtTime(start)}–${fmtTime(end)} · ${fmtDuration(sessionHours(s))} gevist${pauseHours(s) > 0 ? ` · ${fmtDuration(pauseHours(s))} pauze` : ''}</p>
      ${nPlaced ? `<figure class="session-map-wrap">
        <div class="session-map" aria-label="Kaart van de sessie"></div>
        <figcaption class="map-legend">${legend}<span class="lg-hint">Knijp om te zoomen · tik op een punt</span></figcaption>
      </figure>` : ''}
      <section class="live-numbers small-nums">
        <div><span class="big">${s.catches.length}</span><span class="lbl">${s.catches.length === 1 ? 'vis' : 'vissen'}</span></div>
        <div><span class="big">${sRate(s, 2)}</span><span class="lbl">per uur</span></div>
        <div><span class="big">${s.catches.length ? fmtNum(Math.max(...s.catches.map((f) => f.lengthCm || 0)), 0) : '–'}</span><span class="lbl">langste (cm)</span></div>
      </section>
      <h3 class="section-title">Weer</h3>
      ${weatherHtml(s.weather)}
      <h3 class="section-title">Omstandigheden</h3>
      <dl class="facts">
        <div><dt>Dagdeel (start)</dt><dd>${esc(c.dayPart)}</dd></div>
        <div><dt>Seizoen</dt><dd>${esc(c.season)}</dd></div>
        <div><dt>Maan</dt><dd>${esc(c.moonPhase)} (${c.moonIllumination ?? '–'}%)</dd></div>
        <div><dt>Water</dt><dd>${esc(s.waterClarity)}</dd></div>
        <div><dt>Vanaf</dt><dd>${esc(s.platform)}</dd></div>
        <div><dt>Doelsoort</dt><dd>${esc((s.targetSpecies || []).join(', '))}</dd></div>
      </dl>
      ${wissels.length ? `<h3 class="section-title">Gewisseld</h3><ul class="switch-list">${wissels.map((w) => `<li><b>${fmtTime(new Date(w.at))}</b> ${esc(lureShort(w.lure))}</li>`).join('')}</ul>` : ''}
      <h3 class="section-title">Aas</h3>
      ${lureTableHtml(s)}
      <div class="section-row">
        <h3 class="section-title">Missers</h3>
        <div class="stepper" role="group" aria-label="Aanbeten zonder vangst">
          <button class="btn small" type="button" id="bite-minus" aria-label="Eén minder" ${(s.bites || []).length ? '' : 'disabled'}>−</button>
          <span class="stepper-val">${(s.bites || []).length}</span>
          <button class="btn small" type="button" id="bite-plus" aria-label="Eén meer">+</button>
        </div>
      </div>
      <div class="section-row"><h3 class="section-title">Vangsten</h3><button class="btn small" type="button" id="detail-add-catch">${icon('plus')} Vangst</button></div>
      ${s.catches.length ? `<div class="catches">${s.catches.map(catchRow).join('')}</div>` : `<p class="muted">Geen vangst in deze sessie.</p>`}
      ${s.notes ? `<h3 class="section-title">Notitie</h3><p class="note">${esc(s.notes)}</p>` : ''}
      <div class="actions">
        <button class="btn ghost danger" type="button" id="del-session">${icon('trash')} Verwijder</button>
        <button class="btn" type="button" id="edit-session">${icon('edit')} Bewerk sessie</button>
      </div>
    </div>`;
    fillPhotos(sheet.body);
    const mapEl = $('.session-map', sheet.body);
    if (mapEl) miniMap = createSessionMap(mapEl, mapItems);
    $$('[data-catch]', sheet.body).forEach((b) => b.addEventListener('click', () => openCatchSheet(s, s.catches.find((f) => f.id === b.dataset.catch), draw)));
    $('#detail-add-catch', sheet.body).addEventListener('click', () => openCatchSheet(s, null, draw));
    $('#bite-minus', sheet.body).addEventListener('click', async () => {
      if (!(s.bites || []).length) return;
      s.bites = s.bites.slice(0, -1);
      await saveSession(s);
      draw();
      render();
    });
    $('#bite-plus', sheet.body).addEventListener('click', async () => {
      // Achteraf toegevoegd: midden in de sessie, met het aas van de start.
      const mid = new Date((Date.parse(s.startedAt) + Date.parse(s.endedAt)) / 2).toISOString();
      const first = (s.changes && s.changes[0]) || s;
      s.bites = [...(s.bites || []), { id: db.uid(), at: mid, lureId: first.lureId, lure: first.lure, position: null, addedLater: true }];
      await saveSession(s);
      draw();
      render();
    });
    $('#edit-session', sheet.body).addEventListener('click', () => openSessionForm(s, draw));
    confirmButton($('#del-session', sheet.body), 'Tik nogmaals om te verwijderen', async () => {
      sheet.close();
      await deleteSession(s.id);
    });
  };
  draw();
  return draw;
}

// ----- Sessie achteraf invoeren of bewerken (FL-6) -----

function spotOptions(selectedId) {
  const spots = state.spots.filter((sp) => !sp.archived || sp.id === selectedId);
  return `<option value="" ${selectedId ? '' : 'selected'} disabled>Kies een stek</option>${spots
    .map((sp) => `<option value="${esc(sp.id)}" ${sp.id === selectedId ? 'selected' : ''}>${esc(sp.name)}</option>`)
    .join('')}`;
}

const dateInput = (d) => toLocalInput(d).slice(0, 10);

function openSessionForm(existing = null, onSaved = null) {
  const s = existing;
  const first = s ? (s.changes && s.changes[0]) || { lureId: s.lureId, lure: s.lure } : null;
  const last = state.last;
  const start = s ? new Date(s.startedAt) : (() => { const d = new Date(); d.setHours(d.getHours() - 3, 0, 0, 0); return d; })();
  const end = s ? new Date(s.endedAt) : (() => { const d = new Date(start); d.setHours(d.getHours() + 2); return d; })();
  const body = el(`<form class="form" novalidate>
    <div class="field">
      <span class="label">Stek</span>
      <select id="sf-spot">${spotOptions(s?.spot?.id)}</select>
      <button type="button" class="btn ghost small" id="sf-new-spot">${icon('pin')} Nieuwe stek op de kaart</button>
    </div>
    <label class="field"><span class="label">Datum</span><input id="sf-date" type="date" value="${dateInput(start)}" max="${dateInput(new Date())}"></label>
    <div class="two">
      <label class="field"><span class="label">Begin</span><input id="sf-start" type="time" value="${fmtTime(start)}"></label>
      <label class="field"><span class="label">Einde</span><input id="sf-end" type="time" value="${fmtTime(end)}"></label>
    </div>
    <div class="field"><span class="label">Doelsoort(en)</span>${chips('species', SPECIES, s?.targetSpecies || last.targetSpecies || ['Snoek'], { multi: true })}</div>
    <label class="field"><span class="label">Kunstaas${s && s.changes?.length > 1 ? ' bij de start' : ''}</span><select id="sf-lure">${lureOptions(s ? first?.lureId : last.lureId)}</select></label>
    <div class="field"><span class="label">Waterhelderheid</span>${chips('water', WATER, s?.waterClarity || last.waterClarity || 'Licht troebel')}</div>
    <div class="field"><span class="label">Je viste vanaf</span>${chips('platform', PLATFORMS, s?.platform || 'Kant')}</div>
    <label class="field"><span class="label">Notitie</span><textarea id="sf-notes" rows="2" maxlength="1000">${esc(s?.notes || '')}</textarea></label>
    ${s ? '' : '<p class="hint">Het weer van dat moment wordt automatisch opgezocht. Vangsten voeg je daarna toe.</p>'}
    <button type="submit" class="btn primary huge">${s ? 'Opslaan' : 'Sessie toevoegen'}</button>
  </form>`);
  wireChips(body);
  const sheet = openSheet({ title: s ? 'Sessie bewerken' : 'Sessie achteraf', body });

  $('#sf-new-spot', body).addEventListener('click', () => {
    openSpotEditor({
      onSave: async (spot) => {
        const saved = await saveSpot(spot);
        $('#sf-spot', body).innerHTML = spotOptions(saved.id);
      },
    });
  });

  body.addEventListener('submit', async (e) => {
    e.preventDefault();
    const spot = spotById($('#sf-spot', body).value);
    if (!spot) { toast('Kies een stek.', 'warn'); return; }
    const date = $('#sf-date', body).value;
    const t1 = $('#sf-start', body).value;
    const t2 = $('#sf-end', body).value;
    if (!date || !t1 || !t2) { toast('Vul datum, begin- en eindtijd in.', 'warn'); return; }
    const newStart = new Date(`${date}T${t1}`);
    const newEnd = new Date(`${date}T${t2}`);
    if (newEnd <= newStart) newEnd.setDate(newEnd.getDate() + 1); // over middernacht
    if (newEnd > new Date(Date.now() + 60e3)) { toast('De sessie kan niet in de toekomst eindigen.', 'warn'); return; }
    if ((newEnd - newStart) / 3600e3 > 24) { toast('Een sessie duurt maximaal 24 uur.', 'warn'); return; }
    const targetSpecies = chipValue(body, 'species');
    if (!targetSpecies.length) { toast('Kies minstens één doelsoort.', 'warn'); return; }
    const lureId = $('#sf-lure', body).value || null;
    const lure = lureSnap(lureById(lureId)) || (s && first?.lureId === lureId ? first.lure : null);
    const position = { lat: spot.lat, lng: spot.lng, accuracy: spot.accuracy ?? null };
    const spotChanged = !s || s.spot?.id !== spot.id;
    const startChanged = !s || s.startedAt !== newStart.toISOString();

    const record = s || { id: db.uid(), catches: [], addedLater: true };
    record.startedAt = newStart.toISOString();
    record.endedAt = newEnd.toISOString();
    record.spot = { id: spot.id, name: spot.name, lat: spot.lat, lng: spot.lng };
    if (spotChanged || !record.position) record.position = position;
    record.targetSpecies = targetSpecies;
    record.waterClarity = chipValue(body, 'water');
    record.platform = chipValue(body, 'platform');
    record.notes = $('#sf-notes', body).value.trim();
    // Beginsituatie bijwerken; latere wissels blijven staan.
    const later = (record.changes || []).slice(1).filter((c) => Date.parse(c.at) > newStart && Date.parse(c.at) < newEnd);
    record.changes = [{ at: record.startedAt, lureId, lure }, ...later];
    const current = record.changes[record.changes.length - 1];
    record.lureId = current.lureId;
    record.lure = current.lure;
    if (spotChanged || startChanged) {
      record.conditions = computedConditions(newStart, record.position);
      record.weather = { status: 'loading' };
    }
    // Vangsten buiten de nieuwe tijden blijven bewaard, maar worden binnen de sessie gezet.
    const clamp = (f) => {
      const t = Date.parse(f.at);
      if (t < newStart) return { ...f, at: record.startedAt };
      if (t > newEnd) return { ...f, at: record.endedAt };
      return f;
    };
    record.catches = record.catches.map(clamp);
    clampPauses(record);
    record.bites = (record.bites || []).map(clamp);
    await saveSession(record);
    sheet.close();
    render();
    let refresh = onSaved;
    if (!s) {
      toast('Sessie toegevoegd. Voeg nu je vangsten toe.');
      refresh = openSessionDetail(record.id);
    } else {
      toast('Sessie bijgewerkt');
      refresh && refresh();
    }
    if (record.weather?.status === 'loading') {
      updateWeather(record).then(() => {
        render();
        refresh && refresh();
      });
    }
  });
}

// ---------- Inzichten ----------

function renderInzichten() {
  const root = $('#screen-inzichten');
  const species = root.dataset.species || 'Alle';
  const present = SPECIES.filter((sp) => state.sessions.some((s) => s.endedAt && !isFlySession(s) && ((s.targetSpecies || []).includes(sp) || s.catches.some((f) => f.species === sp))));
  const { sessions, fishOf } = scope(state.sessions, species);
  const tot = overall(sessions, fishOf);
  const enough = tot.sessions >= MIN_SESSIONS;
  const combos = bestCombinations(sessions, fishOf);
  const perHour = (r) => fmtNum(r, r >= 10 ? 1 : 2);

  const factorCard = (factor) => {
    const rows = factorTable(factor, sessions, fishOf);
    if (!rows.length) return '';
    const max = Math.max(...rows.map((r) => r.rate), tot.rate, 0.0001);
    const avgPos = (tot.rate / max) * 100;
    return `<section class="card factor">
      <h2 class="section-title">${esc(factor.label)}</h2>
      <div class="bars">
        ${rows.map((r) => `<div class="bar-row ${r.lowData ? 'low' : ''}">
          <span class="bar-label">${esc(r.value)}</span>
          <span class="bar-val">${perHour(r.rate)}<small>/u</small></span>
          <span class="bar-track" aria-hidden="true"><span class="bar" style="width:${Math.max(r.rate > 0 ? 2 : 0, (r.rate / max) * 100).toFixed(1)}%"></span><span class="avg-mark" style="left:${avgPos.toFixed(1)}%"></span></span>
          <span class="bar-meta">${r.sessions} ${r.sessions === 1 ? 'sessie' : 'sessies'} · ${fmtNum(r.hours, r.hours < 10 ? 1 : 0)} u · ${r.fish} ${r.fish === 1 ? 'vis' : 'vissen'}${r.bites ? ` · ${r.bites} ${r.bites === 1 ? 'aanbeet' : 'aanbeten'}` : ''}${r.lowData ? ' · <b>te weinig data</b>' : ''}</span>
        </div>`).join('')}
      </div>
    </section>`;
  };

  root.innerHTML = `
    <header class="screen-head">
      <p class="eyebrow">Inzichten</p>
      <h1>Wanneer vang je het meest?</h1>
    </header>
    ${present.length > 1 ? chips('insight-species', ['Alle', ...present], species) : ''}
    ${tot.sessions === 0 ? `<div class="card empty-state">
      <p><strong>Nog geen afgeronde sessies${species !== 'Alle' ? ` voor ${esc(species.toLowerCase())}` : ''}.</strong></p>
      <p class="muted">Na elke sessie zie je hier je vangst per uur per dagdeel, drukverloop, wind, stek, aas en meer.</p>
    </div>` : `
    <section class="totals">
      <div><span class="big">${perHour(tot.rate)}</span><span class="lbl">vissen per uur</span></div>
      <div><span class="big">${tot.sessions}</span><span class="lbl">sessies</span></div>
      <div><span class="big">${fmtNum(tot.hours, 0)}</span><span class="lbl">uur gevist</span></div>
    </section>
    ${enough ? '' : `<div class="card nudge"><p><strong>${tot.sessions} van de ${MIN_SESSIONS} sessies.</strong> Patronen worden betrouwbaar vanaf ${MIN_SESSIONS} sessies per waarde. Log ook de sessies waarin je niets vangt, want die tellen net zo zwaar mee.</p></div>`}
    <section class="card combos">
      <h2 class="section-title">Beste combinaties</h2>
      ${combos.length ? `<ol class="combo-list">${combos.map((c) => `<li class="${c.lowData ? 'low' : ''}">
        <p class="combo-parts">${c.parts.map((p) => `<span><small>${esc(p.factor)}</small>${esc(p.value)}</span>`).join('<i>+</i>')}</p>
        <p class="combo-num"><b>${perHour(c.rate)}</b> per uur${tot.rate > 0 ? ` · ${fmtNum(c.rate / tot.rate, 1)}× je gemiddelde` : ''}</p>
        <p class="muted small">${c.sessions} sessies · ${c.fish} ${c.fish === 1 ? 'vis' : 'vissen'}${c.lowData ? ' · <b>te weinig data</b>' : ''}</p>
      </li>`).join('')}</ol>` : `<p class="muted">Een combinatie verschijnt zodra je minstens 3 sessies met dezelfde omstandigheden hebt en daarin vis hebt gevangen.</p>`}
    </section>
    <p class="hint legend-hint"><span class="avg-swatch" aria-hidden="true"></span> Streepje = je gemiddelde van ${perHour(tot.rate)} per uur. Dagdeel en aas tellen per uur dat je zo viste, ook binnen één sessie.</p>
    ${FACTORS.map(factorCard).join('')}`}`;

  root.querySelector('.chips')?.addEventListener('click', (e) => {
    const b = e.target.closest('.chip');
    if (!b) return;
    root.dataset.species = b.dataset.value;
    renderInzichten();
  });
}

// ---------- Tackle box ----------

function renderTackle() {
  const root = $('#screen-tacklebox');
  const showHidden = root.dataset.showHidden === 'true';
  const list = state.lures.filter((l) => showHidden || !l.archived);
  const groups = LURE_TYPES.map((t) => [t, list.filter((l) => l.type === t)]).filter(([, ls]) => ls.length);
  const noCat = list.filter((l) => !l.archived && !categoryOf(l));
  if (noCat.length) groups.unshift(['Kies een categorie', noCat]);
  const oldHidden = showHidden ? list.filter((l) => l.archived && !categoryOf(l)) : [];
  if (oldHidden.length) groups.push(['Oude categorie (verborgen)', oldHidden]);
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
          ${l.photoId ? `<img class="swatch photo" data-photo="${esc(l.photoId)}" alt="">` : `<span class="swatch" aria-hidden="true">${esc((l.color || l.type || '?').slice(0, 1).toUpperCase())}</span>`}
          <span class="lure-main"><strong>${esc(l.name || l.type)}</strong><span class="muted">${esc([l.color, l.sizeCm ? `${fmtNum(l.sizeCm, l.sizeCm % 1 ? 1 : 0)} cm` : '', l.weightG ? `${fmtNum(l.weightG, l.weightG % 1 ? 1 : 0)} g` : '', l.action].filter(Boolean).join(' · '))}${l.archived ? ' · verborgen' : ''}</span></span>
        </button>`).join('')}
      </section>`).join('') : `<div class="card empty-state"><p><strong>Nog geen kunstaas.</strong></p><p class="muted">Voeg je jerkbaits, shads, pluggen en ander kunstaas toe. Bij een sessie of vangst kies je ze daarna met één tik.</p></div>`}
    ${hiddenCount ? `<button class="btn ghost small" id="toggle-hidden" type="button">${showHidden ? 'Verberg' : 'Toon'} verborgen aas (${hiddenCount})</button>` : ''}
    <section class="card">
      <h2 class="section-title">Kunstaas herkennen</h2>
      <p id="recog-state" class="muted"></p>
      <button class="btn small" type="button" id="recog-settings">${icon('camera')} Instellingen</button>
    </section>`;

  $('#add-lure', root).addEventListener('click', () => openLureSheet());
  $('#recog-settings', root).addEventListener('click', () => openKeySheet(() => renderTackle()));
  Promise.all([getKey(), getMode()]).then(([k, m]) => {
    const p = $('#recog-state', root);
    if (p) p.textContent = !k ? 'Uit. Je vult kunstaas zelf in.' : m === 'snel' ? 'Aan, snelle stand: alleen de foto, zonder internet.' : 'Aan, grondige stand: de foto wordt bekeken en het product wordt op internet opgezocht.';
  });
  fillPhotos(root);
  $$('[data-lure]', root).forEach((b) => b.addEventListener('click', () => openLureSheet(lureById(b.dataset.lure))));
  $('#toggle-hidden', root)?.addEventListener('click', () => {
    root.dataset.showHidden = String(!showHidden);
    renderTackle();
  });
}

/** Instellen van de eigen Claude API-sleutel voor het herkennen van kunstaas (FL-20). */
async function openKeySheet(onDone) {
  const current = await getKey();
  const mode = await getMode();
  const masked = current ? `${current.slice(0, 10)}…${current.slice(-4)}` : '';
  const body = el(`<form class="form" novalidate>
    <p>Fish Logger kan op een foto zien welk kunstaas het is: type, kleur, maat en soms merk en model. Daarvoor gaat de foto naar Claude van Anthropic.</p>
    <ol class="steps">
      <li>Maak een account op <a href="https://platform.claude.com/" target="_blank" rel="noopener">platform.claude.com</a> en zet er een klein tegoed op (een paar euro is voor duizenden foto's genoeg).</li>
      <li>Maak een sleutel aan via <a href="https://platform.claude.com/settings/keys" target="_blank" rel="noopener">Settings › API keys</a> en kopieer hem. Hij begint met <code>sk-ant-</code> en wordt maar één keer getoond.</li>
      <li>Plak de sleutel hieronder.</li>
    </ol>
    <label class="field"><span class="label">API-sleutel</span>
      <input id="api-key" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="${current ? esc(masked) : 'sk-ant-…'}">
    </label>
    <p class="hint">De sleutel blijft alleen op deze iPhone. Hij gaat niet mee in je back-up en staat niet op GitHub.</p>
    <div class="field"><span class="label">Hoe grondig</span>${chips('mode', [{ value: 'grondig', label: 'Grondig: product opzoeken' }, { value: 'snel', label: 'Snel: alleen de foto' }], mode)}</div>
    <p class="hint"><b>Grondig</b> gebruikt Claude Sonnet en zoekt merk, model, maat en gewicht op internet op. Dat kost een paar cent per foto. <b>Snel</b> gebruikt Claude Haiku zonder internet: minder dan een tiende cent, maar merk en gewicht zijn vaak onbekend. Na elke herkenning zie je wat het kostte.</p>
    <div class="actions">
      ${current ? `<button type="button" class="btn ghost danger" id="key-remove">Sleutel verwijderen</button>` : ''}
      <button type="submit" class="btn primary">Opslaan</button>
    </div>
  </form>`);
  wireChips(body);
  const sheet = openSheet({ title: 'Kunstaas herkennen', body });
  $('#key-remove', body)?.addEventListener('click', async () => {
    await clearKey();
    sheet.close();
    toast('Sleutel verwijderd. Herkennen staat uit.');
    onDone && onDone();
  });
  body.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = $('#api-key', body).value.trim();
    await setMode(chipValue(body, 'mode') || 'grondig');
    if (!v) { if (current) { sheet.close(); toast('Opgeslagen'); onDone && onDone(); return; } toast('Plak eerst je API-sleutel.', 'warn'); return; }
    if (!v.startsWith('sk-ant-')) { toast('Een Claude API-sleutel begint met sk-ant-.', 'warn'); return; }
    await setKey(v);
    sheet.close();
    toast('Sleutel opgeslagen');
    onDone && onDone();
  });
}

function openLureSheet(lure = null) {
  const l = lure || {};
  const body = el(`<form class="form" novalidate>
    <div class="field">
      <span class="label">Foto</span>
      <div class="lure-photo">
        <img class="lure-photo-img" alt="Foto van het kunstaas" ${l.photoId ? `data-photo="${esc(l.photoId)}"` : 'hidden'}>
        <div class="lure-photo-side">
          <label class="btn ${l.photoId ? 'ghost small' : 'primary'}" for="lure-photo-input">${icon('camera')} ${l.photoId ? 'Nieuwe foto' : 'Foto maken en herkennen'}</label>
          <p class="recog-status" aria-live="polite"></p>
          <p class="hint small">Tip: fotografeer het aas van opzij, of de verpakking. Een zichtbaar logo of label helpt het meest.</p>
        </div>
      </div>
      <input id="lure-photo-input" type="file" accept="image/*" hidden>
    </div>
    <div class="field"><span class="label">Categorie</span>${chips('type', LURE_TYPES, categoryOf(l) || (lure ? null : 'Jerkbaits'))}</div>
    ${lure && !categoryOf(l) ? `<p class="hint warn-text">Dit aas stond onder "${esc(l.legacyType || l.type || 'geen categorie')}". Kies een nieuwe categorie.</p>` : ''}
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
  fillPhotos(body);
  let newPhoto = null;
  const status = $('.recog-status', body);
  const setStatus = (html, kind = '') => { status.innerHTML = html; status.className = `recog-status ${kind}`; };

  const applyResult = (r) => {
    // Bij nieuw aas alles invullen; bij bestaand aas alleen lege velden, zodat je eigen invoer blijft staan.
    const fill = (sel, val) => { const inp = $(sel, body); if (val != null && val !== '' && (!lure || !inp.value.trim())) inp.value = String(val).replace('.', ','); };
    if (!lure || !l.type) {
      $$('.chips[data-name="type"] .chip', body).forEach((c) => { const on = c.dataset.value === r.type; c.classList.toggle('on', on); c.setAttribute('aria-pressed', String(on)); });
    }
    fill('#lure-name', r.name);
    fill('#lure-color', r.color);
    fill('#lure-size', r.sizeCm);
    fill('#lure-weight', r.weightG);
    found = r;
  };

  let found = null;
  const runRecognition = async () => {
    if (!newPhoto) return;
    setStatus('<span class="spinner" aria-hidden="true"></span> Herkennen…', 'busy');
    try {
      const r = await recognizeLure(newPhoto, LURE_TYPES, (msg) => setStatus(`<span class="spinner" aria-hidden="true"></span> ${esc(msg)}`, 'busy'));
      applyResult(r);
      const zeker = { hoog: 'vrij zeker', middel: 'redelijk zeker', laag: 'niet zeker' }[r.confidence] || '';
      let host = '';
      try { host = r.source ? new URL(r.source).hostname.replace(/^www\./, '') : ''; } catch (_) { host = ''; }
      setStatus(`<b>Herkend:</b> ${esc([r.type, r.name, r.color].filter(Boolean).join(' · '))}${zeker ? ` (${zeker})` : ''}.
        ${r.note ? `<span class="recog-note">${esc(r.note)}</span>` : ''}
        ${host ? `<span class="recog-note">Gegevens van <a href="${esc(r.source)}" target="_blank" rel="noopener">${esc(host)}</a>.</span>` : ''}
        <span class="recog-note">Controleer de velden. Kosten ≈ $${r.costUsd.toFixed(3).replace('.', ',')}${r.searches ? ` (${r.searches} ${r.searches === 1 ? 'zoekopdracht' : 'zoekopdrachten'})` : ''}.</span>`, 'good');
    } catch (err) {
      if (err.code === 'no_key') {
        setStatus('Foto staat klaar. Automatisch herkennen kan met een eigen Claude API-sleutel. <button type="button" class="link-btn" id="recog-setup">Instellen</button> of vul hieronder zelf in.', '');
        $('#recog-setup', body).addEventListener('click', () => openKeySheet(runRecognition));
      } else {
        setStatus(`${esc(err.message || 'Herkennen mislukt.')}${err.code === 'busy' || err.code === 'offline' ? ' <button type="button" class="link-btn" id="recog-retry">Opnieuw proberen</button>' : ''}`, 'warn');
        $('#recog-retry', body)?.addEventListener('click', runRecognition);
      }
    }
  };

  $('#lure-photo-input', body).addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      newPhoto = await compressPhoto(file, 1200);
    } catch (err) {
      setStatus(esc(err.message), 'warn');
      return;
    }
    const img = $('.lure-photo-img', body);
    img.src = URL.createObjectURL(newPhoto);
    img.hidden = false;
    const btn = $('label[for="lure-photo-input"]', body);
    btn.className = 'btn ghost small';
    btn.innerHTML = `${icon('camera')} Andere foto`;
    runRecognition();
  });

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
      ...(found ? { action: found.action || l.action || '', sourceUrl: found.source || l.sourceUrl || '' } : {}),
      archived: l.archived || false,
      createdAt: l.createdAt || new Date().toISOString(),
      ...extra,
    };
    if (!record.type) { toast('Kies een categorie.', 'warn'); return; }
    delete record.legacyType;
    if (!record.name && !record.color) { toast('Vul een naam of kleur in, zodat je het aas herkent.', 'warn'); return; }
    if (newPhoto) {
      if (record.photoId) { await db.del('photos', record.photoId); state.photoUrls.delete(record.photoId); }
      record.photoId = db.uid();
      await db.put('photos', { id: record.photoId, blob: newPhoto, createdAt: new Date().toISOString() });
    }
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
    getCatches: async () =>
      state.sessions.flatMap((s) =>
        s.catches
          .filter((c) => c.position)
          .map((c) => ({
            lat: c.position.lat,
            lng: c.position.lng,
            species: c.species,
            lengthCm: c.lengthCm,
            when: `${fmtDate(new Date(c.at))} ${fmtTime(new Date(c.at))}`,
            lure: c.lure ? lureName(c.lure) : '',
            spotName: s.spot?.name || '',
            sessionId: s.id,
          })),
      ),
    onOpenSession: (id) => openSessionDetail(id),
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
    const ep = $('#pause-elapsed');
    if (ep) ep.textContent = fmtDuration(pauseOpenHours(s));
    if (e2) e2.textContent = sRate(s);
  }, 30000);
  if ('serviceWorker' in navigator) {
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }).then((reg) => {
      // Een app op het beginscherm wordt vaak hervat in plaats van opnieuw geopend: dan zelf op updates controleren.
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
    }).catch(() => {});
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || reloading) return;
      // Nieuwe versie actief: herladen, maar niet midden in het invullen van een formulier.
      const reload = () => { if (reloading) return; reloading = true; location.reload(); };
      if (!document.querySelector('.sheet-wrap')) reload();
      else toast('Nieuwe versie klaar. Wordt geladen zodra je dit scherm sluit.');
      const iv = setInterval(() => { if (!document.querySelector('.sheet-wrap')) { clearInterval(iv); reload(); } }, 1000);
    });
  }
}

boot();
