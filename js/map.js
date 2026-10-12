// Kaart (Leaflet) met satellietbeeld, stekken als pins en de stek-editor.
import { esc, icon, openSheet, toast, $, fmtNum, confirmButton } from './ui.js';

const L = window.L;

const LAYERS = {
  satelliet: () =>
    L.layerGroup([
      L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
        maxZoom: 21, maxNativeZoom: 19, attribution: 'Beelden © Esri, Maxar, Earthstar Geographics',
      }),
      L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', {
        maxZoom: 21, maxNativeZoom: 19, opacity: 0.85,
      }),
    ]),
  kaart: () =>
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 21, maxNativeZoom: 19, attribution: '© OpenStreetMap-bijdragers',
    }),
};

export const NL_VIEW = { center: [52.2, 5.3], zoom: 7 };

function pinIcon(kind = '') {
  return L.divIcon({
    className: `spot-pin ${kind}`,
    html: '<svg viewBox="0 0 30 40" aria-hidden="true"><path d="M15 39C15 39 2 23.5 2 14a13 13 0 0126 0c0 9.5-13 25-13 25z"/><circle cx="15" cy="14" r="5"/></svg>',
    iconSize: [30, 40],
    iconAnchor: [15, 38],
    popupAnchor: [0, -34],
  });
}

/** Maakt een kaart met een knop om tussen satelliet en kaart te wisselen. */
export function createMap(container, { layer = 'satelliet' } = {}) {
  const map = L.map(container, { zoomControl: false, attributionControl: true, tap: true });
  map.attributionControl.setPrefix(false);
  let current = LAYERS[layer]().addTo(map);
  let currentName = layer;
  map.setLayer = (name) => {
    if (name === currentName) return;
    map.removeLayer(current);
    current = LAYERS[name]().addTo(map);
    currentName = name;
    try { localStorage.setItem('fl-layer', name); } catch (_) { /* geen opslag */ }
  };
  map.toggleLayer = () => {
    map.setLayer(currentName === 'satelliet' ? 'kaart' : 'satelliet');
    return currentName;
  };
  return map;
}

export function savedLayer() {
  try { return localStorage.getItem('fl-layer') || 'satelliet'; } catch (_) { return 'satelliet'; }
}

// ---------- GPS ----------

export function getPosition({ timeout = 15000, maximumAge = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('Locatie wordt niet ondersteund op dit toestel.'));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: Math.round(p.coords.accuracy) }),
      (err) => reject(new Error(geoError(err))),
      { enableHighAccuracy: true, timeout, maximumAge },
    );
  });
}

function geoError(err) {
  if (err && err.code === 1) return 'Geen toestemming voor locatie. Zet dit aan via Instellingen › Privacy › Locatievoorzieningen › Safari-websites.';
  if (err && err.code === 3) return 'Locatie bepalen duurde te lang.';
  return 'Locatie kon niet worden bepaald.';
}

/** Volgt de GPS een tijdje zodat de nauwkeurigheid kan verbeteren. */
export function watchPosition(onUpdate, onError) {
  if (!navigator.geolocation) {
    onError && onError(new Error('Locatie wordt niet ondersteund op dit toestel.'));
    return () => {};
  }
  const id = navigator.geolocation.watchPosition(
    (p) => onUpdate({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: Math.round(p.coords.accuracy) }),
    (err) => onError && onError(new Error(geoError(err))),
    { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 },
  );
  return () => navigator.geolocation.clearWatch(id);
}

// ---------- Kaart-scherm ----------

export class MapScreen {
  constructor(root, { getSpots, statsFor, onEditSpot, onNewSpot, getCatches = async () => [], onOpenSession = () => {} }) {
    this.root = root;
    this.getCatches = getCatches;
    this.onOpenSession = onOpenSession;
    this.getSpots = getSpots;
    this.statsFor = statsFor;
    this.onEditSpot = onEditSpot;
    this.onNewSpot = onNewSpot;
    this.map = null;
    this.markers = L.layerGroup();
    this.me = null;
  }

  mount() {
    if (this.map) {
      setTimeout(() => this.map.invalidateSize(), 50);
      return;
    }
    this.root.innerHTML = `
      <div class="map-screen">
        <div class="map-canvas" id="main-map"></div>
        <div class="map-tools">
          <button class="map-btn" id="map-layer" type="button" aria-label="Wissel satelliet en kaart">${icon('layers')}<span>Kaart</span></button>
          <button class="map-btn" id="map-locate" type="button" aria-label="Toon mijn locatie">${icon('locate')}</button>
        </div>
        <button class="fab" id="map-add" type="button">${icon('plus')}<span>Nieuwe stek</span></button>
      </div>`;
    const layer = savedLayer();
    this.map = createMap($('#main-map', this.root), { layer });
    $('#map-layer span', this.root).textContent = layer === 'satelliet' ? 'Kaart' : 'Satelliet';
    this.markers.addTo(this.map);
    this.map.setView(NL_VIEW.center, NL_VIEW.zoom);
    $('#map-layer', this.root).addEventListener('click', () => {
      const now = this.map.toggleLayer();
      $('#map-layer span', this.root).textContent = now === 'satelliet' ? 'Kaart' : 'Satelliet';
    });
    $('#map-locate', this.root).addEventListener('click', () => this.locate(true));
    $('#map-add', this.root).addEventListener('click', () => this.onNewSpot());
    this.root.addEventListener('click', (e) => {
      const b = e.target.closest('[data-edit-spot]');
      if (b) this.onEditSpot(b.dataset.editSpot);
      const o = e.target.closest('[data-open-session]');
      if (o) { this.map.closePopup(); this.onOpenSession(o.dataset.openSession); }
    });
    this.refresh(true);
    setTimeout(() => this.map.invalidateSize(), 50);
  }

  async refresh(fit = false) {
    if (!this.map) return;
    // Eerst alle gegevens ophalen, dan pas de kaart leegmaken: zo kunnen twee gelijktijdige
    // verversingen geen dubbele stippen opleveren.
    const spots = (await this.getSpots()).filter((s) => !s.archived);
    const catches = await this.getCatches();
    this.markers.clearLayers();
    for (const s of spots) {
      const st = this.statsFor(s.id);
      const m = L.marker([s.lat, s.lng], { icon: pinIcon(st.fish > 0 ? 'has-fish' : ''), title: s.name });
      m.bindPopup(
        `<div class="pop">
          <strong>${esc(s.name)}</strong>
          <div class="pop-stats">
            <span><b>${st.sessions}</b> sessies</span>
            <span><b>${st.fish}</b> vissen</span>
            <span><b>${fmtNum(st.rate, 2)}</b> per uur</span>
          </div>
          <button type="button" class="btn small" data-edit-spot="${esc(s.id)}">${icon('edit')} Bewerk stek</button>
        </div>`,
        { closeButton: false, minWidth: 200 },
      );
      this.markers.addLayer(m);
    }
    // Vangsten als stippen (FL-22)
    for (const c of catches) {
      const dot = L.circleMarker([c.lat, c.lng], { radius: 7, className: 'catch-dot', bubblingMouseEvents: false });
      dot.bindPopup(
        `<div class="pop">
          <strong>${esc(c.species)}${c.lengthCm ? ` · ${fmtNum(c.lengthCm, c.lengthCm % 1 ? 1 : 0)} cm` : ''}</strong>
          <div class="pop-stats"><span>${esc(c.when)}</span>${c.lure ? `<span>${esc(c.lure)}</span>` : ''}${c.spotName ? `<span>bij ${esc(c.spotName)}</span>` : ''}</div>
          <button type="button" class="btn small" data-open-session="${esc(c.sessionId)}">Bekijk sessie</button>
        </div>`,
        { closeButton: false, minWidth: 180 },
      );
      this.markers.addLayer(dot);
    }
    if (fit) {
      const pts = [...spots.map((s) => [s.lat, s.lng]), ...catches.map((c) => [c.lat, c.lng])];
      if (pts.length) {
        const b = L.latLngBounds(pts);
        this.map.fitBounds(b.pad(0.3), { maxZoom: 16 });
      } else {
        this.locate(false);
      }
    }
  }

  async locate(showError) {
    try {
      const p = await getPosition({ timeout: 10000 });
      if (this.me) this.me.remove();
      this.me = L.layerGroup([
        L.circle([p.lat, p.lng], { radius: p.accuracy, className: 'acc-circle', interactive: false }),
        L.circleMarker([p.lat, p.lng], { radius: 7, className: 'me-dot', interactive: false }),
      ]).addTo(this.map);
      this.map.setView([p.lat, p.lng], Math.max(this.map.getZoom(), 16));
    } catch (e) {
      if (showError) toast(e.message, 'warn');
    }
  }
}

// ---------- Stek-editor ----------

/**
 * Opent een volledig scherm met kaart om een stek te plaatsen of te verplaatsen.
 * De pin start op je GPS-positie en is te verslepen naar de exacte plek.
 */
export function openSpotEditor({ spot = null, canDelete = false, onSave, onDelete }) {
  const isNew = !spot;
  const body = document.createElement('div');
  body.className = 'spot-editor';
  body.innerHTML = `
    <div class="spot-map-wrap">
      <div class="spot-map"></div>
      <div class="map-tools">
        <button class="map-btn" type="button" data-act="layer">${icon('layers')}<span>Kaart</span></button>
        <button class="map-btn" type="button" data-act="gps" aria-label="Zet pin op mijn locatie">${icon('locate')}</button>
      </div>
      <div class="gps-badge" aria-live="polite">Locatie bepalen…</div>
    </div>
    <form class="form spot-form" novalidate>
      <p class="hint">Sleep de pin naar de exacte plek waar je vist. Inzoomen kan tot op de meter.</p>
      <label class="field">
        <span>Naam van de stek</span>
        <input id="spot-name" name="name" type="text" autocomplete="off" required maxlength="60" placeholder="Bijv. Steiger bij de brug" value="${esc(spot?.name || '')}">
      </label>
      <div class="coords" aria-live="polite"></div>
      <div class="actions">
        ${!isNew && canDelete ? `<button type="button" class="btn ghost danger" data-act="delete">${icon('trash')} Verwijder</button>` : ''}
        ${!isNew && !canDelete ? `<button type="button" class="btn ghost" data-act="archive">Verberg stek</button>` : ''}
        <button type="submit" class="btn primary">${isNew ? 'Stek opslaan' : 'Wijzigingen opslaan'}</button>
      </div>
    </form>`;

  let stopWatch = () => {};
  const sheet = openSheet({ title: isNew ? 'Nieuwe stek' : 'Stek bewerken', body, full: true, onClose: () => stopWatch() });
  const map = createMap($('.spot-map', body), { layer: savedLayer() });
  $('[data-act="layer"] span', body).textContent = savedLayer() === 'satelliet' ? 'Kaart' : 'Satelliet';
  const badge = $('.gps-badge', body);
  const coords = $('.coords', body);

  const start = spot ? [spot.lat, spot.lng] : NL_VIEW.center;
  map.setView(start, spot ? 18 : NL_VIEW.zoom);
  const marker = L.marker(start, { draggable: true, icon: pinIcon('editing'), autoPan: true });
  let accCircle = null;
  let placed = !!spot;
  let movedByHand = false;
  let accuracy = spot?.accuracy ?? null;

  const showCoords = () => {
    const ll = marker.getLatLng();
    coords.textContent = `${ll.lat.toFixed(6)}, ${ll.lng.toFixed(6)}`;
  };
  if (placed) { marker.addTo(map); showCoords(); badge.textContent = 'Sleep de pin om de stek te verplaatsen'; }

  marker.on('dragend', () => {
    movedByHand = true;
    showCoords();
    badge.textContent = 'Pin handmatig geplaatst';
    badge.className = 'gps-badge good';
  });
  map.on('click', (e) => {
    if (!placed) return;
    marker.setLatLng(e.latlng);
    movedByHand = true;
    showCoords();
    badge.textContent = 'Pin handmatig geplaatst';
    badge.className = 'gps-badge good';
  });

  const useGps = (follow) => {
    stopWatch();
    badge.textContent = 'Locatie bepalen…';
    badge.className = 'gps-badge';
    let best = null;
    const startedAt = Date.now();
    stopWatch = watchPosition(
      (p) => {
        if (best && p.accuracy >= best.accuracy) return;
        best = p;
        accuracy = p.accuracy;
        if (accCircle) accCircle.remove();
        accCircle = L.circle([p.lat, p.lng], { radius: p.accuracy, className: 'acc-circle', interactive: false }).addTo(map);
        if (!movedByHand || follow) {
          marker.setLatLng([p.lat, p.lng]);
          if (!placed) { marker.addTo(map); placed = true; }
          map.setView([p.lat, p.lng], Math.max(map.getZoom(), p.accuracy < 30 ? 18 : 16));
          showCoords();
        }
        follow = false;
        badge.textContent = `GPS-nauwkeurigheid ± ${p.accuracy} m`;
        badge.className = `gps-badge ${p.accuracy <= 10 ? 'good' : p.accuracy <= 30 ? '' : 'warn'}`;
        if (p.accuracy <= 5 || Date.now() - startedAt > 30000) stopWatch();
      },
      (err) => {
        badge.textContent = placed ? 'Sleep de pin naar je stek' : 'Geen GPS. Tik op de kaart om de pin te plaatsen.';
        badge.className = 'gps-badge warn';
        if (!placed) {
          map.once('click', (e) => {
            marker.setLatLng(e.latlng).addTo(map);
            placed = true;
            movedByHand = true;
            showCoords();
          });
        }
        toast(err.message, 'warn');
      },
    );
    setTimeout(() => stopWatch(), 35000);
  };

  if (isNew) useGps(false);

  body.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'layer') {
      const now = map.toggleLayer();
      $('[data-act="layer"] span', body).textContent = now === 'satelliet' ? 'Kaart' : 'Satelliet';
    }
    if (act === 'gps') { movedByHand = false; useGps(true); }
  });

  const archiveBtn = $('[data-act="archive"]', body);
  if (archiveBtn) {
    confirmButton(archiveBtn, 'Tik nogmaals om te verbergen', async () => {
      await onSave({ ...spot, archived: true });
      sheet.close();
    });
  }
  const delBtn = $('[data-act="delete"]', body);
  if (delBtn) {
    confirmButton(delBtn, 'Tik nogmaals om te verwijderen', async () => {
      await onDelete(spot);
      sheet.close();
    });
  }

  $('form', body).addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('#spot-name', body).value.trim();
    if (!name) { $('#spot-name', body).focus(); toast('Geef de stek een naam.', 'warn'); return; }
    if (!placed) { toast('Plaats eerst de pin op de kaart.', 'warn'); return; }
    const ll = marker.getLatLng();
    await onSave({
      ...(spot || {}),
      name,
      lat: ll.lat,
      lng: ll.lng,
      accuracy: movedByHand ? null : accuracy,
      placedByHand: movedByHand || spot?.placedByHand || false,
      archived: false,
    });
    sheet.close();
  });

  setTimeout(() => map.invalidateSize(), 250);
  return sheet;
}


/**
 * Kaart om één punt te kiezen of te verschuiven (bijv. de plek van een vangst).
 * `start` = {lat, lng} of null; `fallback` = waar de kaart begint zonder punt.
 */
export function openPointPicker({ title, start = null, fallback = null, hint = '', onSave, onClear = null }) {
  const body = document.createElement('div');
  body.className = 'spot-editor';
  body.innerHTML = `
    <div class="spot-map-wrap">
      <div class="spot-map"></div>
      <div class="map-tools">
        <button class="map-btn" type="button" data-act="layer">${icon('layers')}<span>Kaart</span></button>
        <button class="map-btn" type="button" data-act="gps" aria-label="Zet de stip op mijn locatie">${icon('locate')}</button>
      </div>
      <div class="gps-badge" aria-live="polite">${start ? 'Sleep de stip of tik op de kaart' : 'Tik op de kaart om de plek te kiezen'}</div>
    </div>
    <div class="form spot-form">
      ${hint ? `<p class="hint">${esc(hint)}</p>` : ''}
      <div class="coords" aria-live="polite"></div>
      <div class="actions">
        ${onClear && start ? `<button type="button" class="btn ghost" data-act="clear">Plek wissen</button>` : ''}
        <button type="button" class="btn primary" data-act="save">Plek opslaan</button>
      </div>
    </div>`;
  const sheet = openSheet({ title, body, full: true });
  const map = createMap($('.spot-map', body), { layer: savedLayer() });
  $('[data-act="layer"] span', body).textContent = savedLayer() === 'satelliet' ? 'Kaart' : 'Satelliet';
  const center = start || fallback;
  map.setView(center ? [center.lat, center.lng] : NL_VIEW.center, center ? 18 : NL_VIEW.zoom);
  const marker = L.marker(center ? [center.lat, center.lng] : NL_VIEW.center, { draggable: true, icon: pinIcon('editing'), autoPan: true });
  let placed = !!start;
  if (placed) marker.addTo(map);
  const coords = $('.coords', body);
  const show = () => { const ll = marker.getLatLng(); coords.textContent = placed ? `${ll.lat.toFixed(6)}, ${ll.lng.toFixed(6)}` : ''; };
  show();
  const place = (ll) => { marker.setLatLng(ll); if (!placed) { marker.addTo(map); placed = true; } show(); };
  marker.on('dragend', show);
  map.on('click', (e) => place(e.latlng));
  body.addEventListener('click', async (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'layer') {
      const now = map.toggleLayer();
      $('[data-act="layer"] span', body).textContent = now === 'satelliet' ? 'Kaart' : 'Satelliet';
    }
    if (act === 'gps') {
      try {
        const p = await getPosition({ timeout: 10000, maximumAge: 0 });
        place([p.lat, p.lng]);
        map.setView([p.lat, p.lng], Math.max(map.getZoom(), 18));
      } catch (err) { toast(err.message, 'warn'); }
    }
    if (act === 'clear') { await onClear(); sheet.close(); }
    if (act === 'save') {
      if (!placed) { toast('Tik eerst op de kaart om de plek te kiezen.', 'warn'); return; }
      const ll = marker.getLatLng();
      await onSave({ lat: ll.lat, lng: ll.lng, accuracy: null, byHand: true });
      sheet.close();
    }
  });
  setTimeout(() => map.invalidateSize(), 250);
  return sheet;
}

// ---------- Kaart van één sessie (FL-25) ----------

function diamondIcon() {
  return L.divIcon({
    className: 'switch-mark',
    html: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 1.5L18.5 10 10 18.5 1.5 10z"/></svg>',
    iconSize: [18, 18],
    iconAnchor: [9, 9],
    popupAnchor: [0, -8],
  });
}

/**
 * Kleine kaart met startplek, vangsten, missers en wissels.
 * `items` = { start, catches: [{lat,lng,label}], bites: [...], switches: [...] }.
 * Slepen staat uit zodat je de pagina gewoon kunt scrollen; knijpen en dubbeltikken zoomen wel.
 * Geeft de Leaflet-kaart terug (of null zonder plekken).
 */
export function createSessionMap(container, items, { onCatch = null } = {}) {
  const pts = [
    ...(items.start ? [items.start] : []),
    ...items.catches,
    ...items.bites,
    ...items.switches,
  ];
  if (!pts.length) return null;
  const map = L.map(container, { zoomControl: false, dragging: false, scrollWheelZoom: false, tap: true, attributionControl: true });
  map.attributionControl.setPrefix(false);
  LAYERS[savedLayer()]().addTo(map);
  const pop = (txt) => `<div class="pop"><strong>${esc(txt.title)}</strong>${txt.sub ? `<div class="pop-stats"><span>${esc(txt.sub)}</span></div>` : ''}</div>`;
  if (items.start) L.marker([items.start.lat, items.start.lng], { icon: pinIcon(''), title: 'Start' }).bindPopup(pop(items.start), { closeButton: false }).addTo(map);
  for (const s of items.switches) L.marker([s.lat, s.lng], { icon: diamondIcon() }).bindPopup(pop(s), { closeButton: false }).addTo(map);
  for (const b of items.bites) L.circleMarker([b.lat, b.lng], { radius: 6, className: 'bite-dot' }).bindPopup(pop(b), { closeButton: false }).addTo(map);
  // Een vangst-pop-up is aan te tikken: die opent het scherm Vangst bewerken.
  const catchPop = (c) => onCatch
    ? `<button type="button" class="pop pop-link" data-edit-catch="${esc(c.catchId)}"><strong>${esc(c.title)}</strong><span class="pop-stats"><span>${esc(c.sub)}</span></span><span class="pop-cta">Bewerk vangst ›</span></button>`
    : pop(c);
  for (const c of items.catches) L.circleMarker([c.lat, c.lng], { radius: 7, className: 'catch-dot' }).bindPopup(catchPop(c), { closeButton: false }).addTo(map);
  if (onCatch) {
    container.addEventListener('click', (e) => {
      const b = e.target.closest('[data-edit-catch]');
      if (!b) return;
      map.closePopup();
      onCatch(b.dataset.editCatch);
    });
  }
  const fit = () => {
    map.invalidateSize();
    if (pts.length === 1) map.setView([pts[0].lat, pts[0].lng], 17);
    else map.fitBounds(L.latLngBounds(pts.map((p) => [p.lat, p.lng])).pad(0.25), { maxZoom: 18 });
  };
  let alive = true;
  map.on('unload', () => { alive = false; });
  fit();
  setTimeout(() => { if (alive) fit(); }, 260); // na het inschuiven van het paneel klopt de maat pas
  return map;
}
