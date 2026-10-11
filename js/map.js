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
  constructor(root, { getSpots, statsFor, onEditSpot, onNewSpot }) {
    this.root = root;
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
    });
    this.refresh(true);
    setTimeout(() => this.map.invalidateSize(), 50);
  }

  async refresh(fit = false) {
    if (!this.map) return;
    const spots = (await this.getSpots()).filter((s) => !s.archived);
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
    if (fit) {
      if (spots.length) {
        const b = L.latLngBounds(spots.map((s) => [s.lat, s.lng]));
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
