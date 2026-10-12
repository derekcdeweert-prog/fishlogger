// Kleine UI-hulpmiddelen: escapen, sheets, meldingen, foto's.

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

const pad = (n) => String(n).padStart(2, '0');
export const fmtTime = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const DAYS = ['zo', 'ma', 'di', 'wo', 'do', 'vr', 'za'];
const MONTHS_SHORT = ['jan', 'feb', 'mrt', 'apr', 'mei', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];
export const fmtDate = (d) => `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS_SHORT[d.getMonth()]}${d.getFullYear() !== new Date().getFullYear() ? ' ' + d.getFullYear() : ''}`;
export function fmtDuration(hours) {
  const total = Math.round(hours * 60);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h ? `${h} u ${pad(m)} min` : `${m} min`;
}
export const fmtNum = (v, digits = 1) => (v == null || Number.isNaN(v) ? '–' : Number(v).toFixed(digits).replace('.', ','));

/** Waarde voor <input type="datetime-local"> in lokale tijd. */
export function toLocalInput(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ---------- Melding onderin ----------
let toastTimer;
export function toast(msg, kind = '', action = null) {
  let t = $('#toast');
  if (!t) {
    t = el('<div id="toast" role="status" aria-live="polite"></div>');
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.className = `show ${kind}${action ? ' has-action' : ''}`;
  clearTimeout(toastTimer);
  const hide = () => {
    t.className = '';
    if (action && action.onExpire) action.onExpire();
  };
  if (action) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'toast-action';
    b.textContent = action.label;
    b.addEventListener('click', () => {
      clearTimeout(toastTimer);
      t.className = '';
      action.onClick();
    }, { once: true });
    t.appendChild(b);
  }
  toastTimer = setTimeout(hide, action ? 6000 : 3200);
}

// ---------- Sheet (paneel dat van onder in beeld schuift) ----------
export function openSheet({ title, body, full = false, onClose }) {
  const sheet = el(`
    <div class="sheet-wrap" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="sheet-backdrop"></div>
      <section class="sheet ${full ? 'sheet-full' : ''}">
        <header class="sheet-head">
          <h2>${esc(title)}</h2>
          <button class="icon-btn sheet-close" type="button" aria-label="Sluiten">${icon('close')}</button>
        </header>
        <div class="sheet-body"></div>
      </section>
    </div>`);
  const bodyEl = $('.sheet-body', sheet);
  if (typeof body === 'string') bodyEl.innerHTML = body;
  else if (body) bodyEl.appendChild(body);
  document.body.appendChild(sheet);
  document.body.classList.add('has-sheet');
  requestAnimationFrame(() => sheet.classList.add('open'));
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    sheet.classList.remove('open');
    setTimeout(() => {
      sheet.remove();
      if (!$('.sheet-wrap')) document.body.classList.remove('has-sheet');
    }, 220);
    onClose && onClose();
  };
  $('.sheet-backdrop', sheet).addEventListener('click', close);
  $('.sheet-close', sheet).addEventListener('click', close);
  return { el: sheet, body: bodyEl, close };
}

/** Knop die eerst om bevestiging vraagt (een tweede tik) — geen pop-ups nodig. */
export function confirmButton(btn, label, action) {
  let armed = false;
  let timer;
  const original = btn.innerHTML;
  btn.addEventListener('click', async () => {
    if (!armed) {
      armed = true;
      btn.classList.add('armed');
      btn.textContent = label;
      timer = setTimeout(() => {
        armed = false;
        btn.classList.remove('armed');
        btn.innerHTML = original;
      }, 4000);
      return;
    }
    clearTimeout(timer);
    await action();
  });
}

// ---------- Keuzechips ----------
export function chips(name, options, selected, { multi = false } = {}) {
  const sel = new Set(Array.isArray(selected) ? selected : selected != null ? [selected] : []);
  return `<div class="chips" data-name="${esc(name)}" data-multi="${multi}" role="${multi ? 'group' : 'radiogroup'}">
    ${options
      .map((o) => {
        const value = typeof o === 'string' ? o : o.value;
        const label = typeof o === 'string' ? o : o.label;
        const on = sel.has(value);
        return `<button type="button" class="chip ${on ? 'on' : ''}" data-value="${esc(value)}" aria-pressed="${on}">${esc(label)}</button>`;
      })
      .join('')}
  </div>`;
}

export function wireChips(root) {
  $$('.chips', root).forEach((group) => {
    group.addEventListener('click', (e) => {
      const b = e.target.closest('.chip');
      if (!b) return;
      const multi = group.dataset.multi === 'true';
      if (!multi) $$('.chip', group).forEach((c) => { c.classList.remove('on'); c.setAttribute('aria-pressed', 'false'); });
      const on = multi ? !b.classList.contains('on') : true;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
      group.dispatchEvent(new CustomEvent('change', { bubbles: true }));
    });
  });
}

export function chipValue(root, name) {
  const group = $(`.chips[data-name="${name}"]`, root);
  if (!group) return null;
  const vals = $$('.chip.on', group).map((c) => c.dataset.value);
  return group.dataset.multi === 'true' ? vals : vals[0] ?? null;
}

// ---------- Foto's ----------
/** Verkleint een foto (max. 1600 px) en slaat hem op als JPEG. */
export async function compressPhoto(file, max = 1600) {
  let source;
  try {
    source = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch (_) {
    source = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Deze foto kan niet worden gelezen.'));
      img.src = URL.createObjectURL(file);
    });
  }
  const w = source.width;
  const h = source.height;
  const scale = Math.min(1, max / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b || file), 'image/jpeg', 0.82));
}

// ---------- Iconen (lijntekeningen) ----------
const ICONS = {
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  fish: '<path d="M3 12c3-4.5 7-6 11-5 2 .5 3.6 1.7 5 3.2L22 7v10l-3-3.2c-1.4 1.5-3 2.7-5 3.2-4 1-8-.5-11-5z"/><circle cx="15.5" cy="11" r=".9" fill="currentColor" stroke="none"/>',
  map: '<path d="M9 4L3 6v14l6-2 6 2 6-2V4l-6 2-6-2z"/><path d="M9 4v14M15 6v14"/>',
  book: '<path d="M5 4h11a3 3 0 013 3v13H8a3 3 0 01-3-3V4z"/><path d="M5 17a3 3 0 013-3h11"/>',
  box: '<rect x="3" y="7" width="18" height="12" rx="2"/><path d="M9 7V5h6v2M3 12h18M10 12v2h4v-2"/>',
  chart: '<path d="M4 20V4M4 20h16"/><path d="M8 16h3M8 12h7M8 8h10"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  pin: '<path d="M12 21s-7-6.2-7-11a7 7 0 0114 0c0 4.8-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/>',
  locate: '<circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>',
  camera: '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
  pause: '<rect x="7" y="6" width="3.5" height="12" rx="1"/><rect x="13.5" y="6" width="3.5" height="12" rx="1"/>',
  stop: '<rect x="7" y="7" width="10" height="10" rx="1.5"/>',
  layers: '<path d="M12 4l9 5-9 5-9-5 9-5z"/><path d="M3 14l9 5 9-5"/>',
  share: '<path d="M12 3v12M7 8l5-5 5 5"/><path d="M5 13v7h14v-7"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16v4z"/>',
  arrowUp: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  arrowDown: '<path d="M12 5v14M6 13l6 6 6-6"/>',
  arrowFlat: '<path d="M5 12h14M13 6l6 6-6 6"/>',
};
export function icon(name, cls = '') {
  return `<svg class="ico ${cls}" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ''}</svg>`;
}
