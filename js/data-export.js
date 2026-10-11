// Export naar Excel (CSV) en back-up / terugzetten.
import * as db from './db.js';

const num = (v, digits = 1) =>
  v == null || Number.isNaN(v) ? '' : Number(v).toFixed(digits).replace('.', ',');

const cell = (v) => {
  const s = v == null ? '' : String(v);
  return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const pad = (n) => String(n).padStart(2, '0');
const dateStr = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const timeStr = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

export function sessionHours(s) {
  const end = s.endedAt ? new Date(s.endedAt) : new Date();
  return Math.max(0, (end - new Date(s.startedAt)) / 3600e3);
}

export function catchRate(s) {
  const h = sessionHours(s);
  return h > 0 ? s.catches.length / h : 0;
}

const HEADER = [
  'sessie_id', 'datum', 'start', 'eind', 'duur_uur', 'stek', 'breedtegraad', 'lengtegraad', 'visplek',
  'doelsoorten', 'methode_start', 'aas_start', 'waterhelderheid', 'dagdeel', 'seizoen', 'maand', 'maanfase',
  'temperatuur_c', 'wind_kmu', 'wind_bft', 'windrichting', 'bewolking_pct', 'neerslag_mm', 'luchtdruk_hpa',
  'drukverloop', 'drukverschil_3u_hpa', 'weer', 'vissen_in_sessie', 'vangst_per_uur',
  'vangst_tijd', 'soort', 'lengte_cm', 'vangst_aas', 'vangst_methode', 'vangst_notitie', 'sessie_notitie',
];

const lureLabel = (l) => (l ? [l.type, l.name, l.color, l.sizeCm ? `${l.sizeCm} cm` : ''].filter(Boolean).join(' · ') : '');

/** Eén rij per vangst; een sessie zonder vangst krijgt één rij met lege vangstkolommen. */
export function buildCsv(sessions) {
  const rows = [HEADER];
  const sorted = [...sessions].filter((s) => s.endedAt).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  for (const s of sorted) {
    const start = new Date(s.startedAt);
    const end = new Date(s.endedAt);
    const w = s.weather || {};
    const c = s.conditions || {};
    const pos = s.position || {};
    const base = [
      s.id, dateStr(start), timeStr(start), timeStr(end), num(sessionHours(s), 2),
      s.spot?.name, pos.lat != null ? pos.lat.toFixed(6).replace('.', ',') : '', pos.lng != null ? pos.lng.toFixed(6).replace('.', ',') : '',
      s.platform, (s.targetSpecies || []).join(', '), s.changes?.[0]?.method ?? s.method, lureLabel(s.changes?.[0] ? s.changes[0].lure : s.lure), s.waterClarity,
      c.dayPart, c.season, c.month, c.moonPhase,
      num(w.tempC), num(w.windKmh, 0), w.windBft ?? '', w.windDir, w.cloudPct ?? '', num(w.precipMm),
      num(w.pressureHpa), w.pressureTrend, num(w.pressureDelta3h), w.desc,
      s.catches.length, num(catchRate(s), 2),
    ];
    if (s.catches.length === 0) {
      rows.push([...base, '', '', '', '', '', '', s.notes]);
    } else {
      for (const f of s.catches) {
        rows.push([...base, timeStr(new Date(f.at)), f.species, num(f.lengthCm), lureLabel(f.lure), f.method, f.notes, s.notes]);
      }
    }
  }
  // Puntkomma's en komma-decimalen: zo opent Nederlandse Excel het direct goed.
  return '﻿' + rows.map((r) => r.map(cell).join(';')).join('\r\n');
}

const blobToDataUrl = (blob) =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });

async function dataUrlToBlob(url) {
  const res = await fetch(url);
  return res.blob();
}

export async function buildBackup() {
  const [sessions, spots, lures, settings, photos] = await Promise.all(
    ['sessions', 'spots', 'lures', 'settings', 'photos'].map((n) => db.getAll(n)),
  );
  const photoData = [];
  for (const p of photos) photoData.push({ id: p.id, createdAt: p.createdAt, dataUrl: await blobToDataUrl(p.blob) });
  return JSON.stringify({ app: 'Fish Logger', version: 1, exportedAt: new Date().toISOString(), sessions, spots, lures, settings, photos: photoData });
}

export async function restoreBackup(text) {
  const data = JSON.parse(text);
  if (data.app !== 'Fish Logger' || !Array.isArray(data.sessions)) throw new Error('Dit is geen back-up van Fish Logger.');
  await db.clearAll();
  for (const s of data.sessions) await db.put('sessions', s);
  for (const s of data.spots || []) await db.put('spots', s);
  for (const l of data.lures || []) await db.put('lures', l);
  for (const s of data.settings || []) await db.put('settings', s);
  for (const p of data.photos || []) await db.put('photos', { id: p.id, createdAt: p.createdAt, blob: await dataUrlToBlob(p.dataUrl) });
  return { sessions: data.sessions.length, photos: (data.photos || []).length };
}

/** Deelt een bestand via het deelmenu van de iPhone (Bewaar in Bestanden, Mail, …), anders downloaden. */
export async function saveFile(filename, content, type) {
  const file = new File([content], filename, { type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: filename });
      return 'shared';
    } catch (e) {
      if (e && e.name === 'AbortError') return 'cancelled';
    }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return 'downloaded';
}

export const stamp = () => {
  const d = new Date();
  return `${dateStr(d)}_${pad(d.getHours())}${pad(d.getMinutes())}`;
};
