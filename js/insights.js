// Inzichten: vangst per uur per factor en de beste combinaties.
import { dayPart, DAY_PARTS, SEASONS, DEFAULT_POS } from './conditions.js';

export const MIN_SESSIONS = 5; // minder sessies = te weinig data voor een conclusie
const COMBO_MIN_SESSIONS = 3;
const SLICE_MIN = 10; // dagdeel wordt per 10 minuten bepaald

const hoursOf = (s) => Math.max(0, (Date.parse(s.endedAt) - Date.parse(s.startedAt)) / 3600e3);

// ---------- Indelingen ----------

function windGroup(w) {
  if (!w || w.status !== 'ok' || w.windBft == null) return null;
  if (w.windBft <= 2) return '0–2 Bft';
  if (w.windBft <= 4) return '3–4 Bft';
  return '5+ Bft';
}
function cloudGroup(w) {
  if (!w || w.status !== 'ok' || w.cloudPct == null) return null;
  if (w.cloudPct <= 30) return 'Zonnig';
  if (w.cloudPct <= 70) return 'Half bewolkt';
  return 'Bewolkt';
}
function tempGroup(w) {
  if (!w || w.status !== 'ok' || w.tempC == null) return null;
  const t = w.tempC;
  if (t < 5) return 'Onder 5 °C';
  if (t < 10) return '5–10 °C';
  if (t < 15) return '10–15 °C';
  if (t < 20) return '15–20 °C';
  return '20 °C en warmer';
}
function moonGroup(c) {
  const p = c?.moonPhase;
  if (!p) return null;
  if (p === 'Nieuwe maan') return 'Nieuwe maan';
  if (p === 'Volle maan') return 'Volle maan';
  if (['Wassende sikkel', 'Eerste kwartier', 'Wassende maan'].includes(p)) return 'Wassend';
  return 'Afnemend';
}

/**
 * Factoren. `kind`:
 *  - 'session': één waarde per sessie
 *  - 'slice':   per tijdsblok (dagdeel), vangsten op hun eigen tijdstip
 *  - 'segment': per periode met hetzelfde aas of dezelfde methode (wissels tellen mee)
 */
export const FACTORS = [
  { key: 'dayPart', label: 'Dagdeel', kind: 'slice', order: DAY_PARTS },
  { key: 'pressure', label: 'Drukverloop', kind: 'session', order: ['Dalend', 'Stabiel', 'Stijgend'], get: (s) => (s.weather?.status === 'ok' ? s.weather.pressureTrend : null) },
  { key: 'season', label: 'Seizoen', kind: 'session', order: SEASONS, get: (s) => s.conditions?.season },
  { key: 'temp', label: 'Temperatuur', kind: 'session', order: ['Onder 5 °C', '5–10 °C', '10–15 °C', '15–20 °C', '20 °C en warmer'], get: (s) => tempGroup(s.weather) },
  { key: 'wind', label: 'Windkracht', kind: 'session', order: ['0–2 Bft', '3–4 Bft', '5+ Bft'], get: (s) => windGroup(s.weather) },
  { key: 'windDir', label: 'Windrichting', kind: 'session', order: ['N', 'NO', 'O', 'ZO', 'Z', 'ZW', 'W', 'NW'], get: (s) => (s.weather?.status === 'ok' ? s.weather.windDir : null) },
  { key: 'cloud', label: 'Bewolking', kind: 'session', order: ['Zonnig', 'Half bewolkt', 'Bewolkt'], get: (s) => cloudGroup(s.weather) },
  { key: 'moon', label: 'Maan', kind: 'session', order: ['Nieuwe maan', 'Wassend', 'Volle maan', 'Afnemend'], get: (s) => moonGroup(s.conditions) },
  { key: 'water', label: 'Waterhelderheid', kind: 'session', order: ['Helder', 'Licht troebel', 'Troebel'], get: (s) => s.waterClarity },
  { key: 'platform', label: 'Vanaf', kind: 'session', order: ['Kant', 'Wadend', 'Boot'], get: (s) => s.platform },
  { key: 'spot', label: 'Stek', kind: 'session', get: (s) => s.spot?.name },
  { key: 'method', label: 'Methode', kind: 'segment', field: 'method' },
  { key: 'lure', label: 'Kunstaas', kind: 'segment', field: 'lure' },
];

const lureLabel = (l) => (l ? [l.name || l.type, l.color].filter(Boolean).join(' · ') : null);

/** Periodes binnen een sessie met dezelfde methode en hetzelfde aas. */
export function segments(s) {
  const start = Date.parse(s.startedAt);
  const end = Date.parse(s.endedAt);
  const changes = (s.changes && s.changes.length ? s.changes : [{ at: s.startedAt, method: s.method, lureId: s.lureId, lure: s.lure }])
    .map((c) => ({ ...c, t: Math.min(Math.max(Date.parse(c.at), start), end) }))
    .sort((a, b) => a.t - b.t);
  return changes
    .map((c, i) => ({
      method: c.method,
      lure: lureLabel(c.lure),
      hours: Math.max(0, ((i + 1 < changes.length ? changes[i + 1].t : end) - c.t) / 3600e3),
    }))
    .filter((g) => g.hours > 0);
}

/** Uren per dagdeel voor een sessie (in blokken van 10 minuten). */
function dayPartHours(s) {
  const pos = s.position || (s.spot ? { lat: s.spot.lat, lng: s.spot.lng } : DEFAULT_POS);
  const start = Date.parse(s.startedAt);
  const end = Date.parse(s.endedAt);
  const out = new Map();
  for (let t = start; t < end; t += SLICE_MIN * 60e3) {
    const len = Math.min(SLICE_MIN * 60e3, end - t) / 3600e3;
    const mid = new Date(t + (len * 3600e3) / 2);
    const part = dayPart(mid, pos.lat, pos.lng);
    out.set(part, (out.get(part) || 0) + len);
  }
  return out;
}

function catchDayPart(s, f) {
  const pos = s.position || (s.spot ? { lat: s.spot.lat, lng: s.spot.lng } : DEFAULT_POS);
  return dayPart(new Date(f.at), pos.lat, pos.lng);
}

/** Sessies en vissen die meetellen voor een soort ('Alle' = alles). */
export function scope(sessions, species) {
  const done = sessions.filter((s) => s.endedAt && hoursOf(s) > 0);
  if (!species || species === 'Alle') return { sessions: done, fishOf: (s) => s.catches };
  return {
    sessions: done.filter((s) => (s.targetSpecies || []).includes(species) || s.catches.some((f) => f.species === species)),
    fishOf: (s) => s.catches.filter((f) => f.species === species),
  };
}

/** Vangst per uur per waarde van één factor. */
export function factorTable(factor, sessions, fishOf) {
  const rows = new Map();
  const row = (v) => {
    if (!rows.has(v)) rows.set(v, { value: v, hours: 0, fish: 0, bites: 0, sessions: new Set() });
    return rows.get(v);
  };
  for (const s of sessions) {
    const fish = fishOf(s);
    if (factor.kind === 'session') {
      const v = factor.get(s);
      if (v == null || v === '') continue;
      const r = row(v);
      r.hours += hoursOf(s);
      r.fish += fish.length;
      r.bites += (s.bites || []).length;
      r.sessions.add(s.id);
    } else if (factor.kind === 'slice') {
      for (const [v, h] of dayPartHours(s)) {
        const r = row(v);
        r.hours += h;
        r.sessions.add(s.id);
      }
      for (const f of fish) row(catchDayPart(s, f)).fish += 1;
      for (const a of s.bites || []) row(catchDayPart(s, a)).bites += 1;
    } else {
      for (const g of segments(s)) {
        const v = g[factor.field];
        if (!v) continue;
        const r = row(v);
        r.hours += g.hours;
        r.sessions.add(s.id);
      }
      for (const f of fish) {
        const v = factor.field === 'lure' ? lureLabel(f.lure) : f.method;
        if (!v) continue;
        row(v).fish += 1;
      }
      for (const a of s.bites || []) {
        const v = factor.field === 'lure' ? lureLabel(a.lure) : a.method;
        if (v && rows.has(v)) row(v).bites += 1;
      }
    }
  }
  let list = [...rows.values()]
    .filter((r) => r.hours > 0)
    .map((r) => ({ value: r.value, hours: r.hours, fish: r.fish, bites: r.bites, sessions: r.sessions.size, rate: r.fish / r.hours, lowData: r.sessions.size < MIN_SESSIONS }));
  if (factor.order) list.sort((a, b) => factor.order.indexOf(a.value) - factor.order.indexOf(b.value));
  else list.sort((a, b) => b.rate - a.rate || b.sessions - a.sessions);
  return list;
}

// ---------- Beste combinaties ----------

const COMBO_FACTORS = [
  { label: 'dagdeel', get: (s) => s.conditions?.dayPart },
  ...FACTORS.filter((f) => f.kind === 'session' && f.key !== 'windDir').map((f) => ({ label: f.label.toLowerCase(), get: f.get, key: f.key })),
  { label: 'methode', get: (s) => s.method },
];

function* combinations(arr, k, start = 0, prefix = []) {
  if (prefix.length === k) { yield prefix; return; }
  for (let i = start; i < arr.length; i++) yield* combinations(arr, k, i + 1, [...prefix, arr[i]]);
}

/** Top-combinaties van 2 of 3 factoren, gesorteerd op vangst per uur. */
export function bestCombinations(sessions, fishOf, limit = 3) {
  const results = [];
  // Een factor die in al je sessies gelijk is (bijv. steeds herfst) zegt niets: overslaan.
  const useful = COMBO_FACTORS.filter((f) => new Set(sessions.map((s) => f.get(s)).filter((v) => v != null && v !== '')).size > 1);
  for (const k of [2, 3]) {
    for (const facs of combinations(useful, k)) {
      const groups = new Map();
      for (const s of sessions) {
        const vals = facs.map((f) => f.get(s));
        if (vals.some((v) => v == null || v === '')) continue;
        const key = vals.join('\u0001');
        if (!groups.has(key)) groups.set(key, { parts: facs.map((f, i) => ({ factor: f.label, value: vals[i] })), ids: [], hours: 0, fish: 0 });
        const g = groups.get(key);
        g.ids.push(s.id);
        g.hours += hoursOf(s);
        g.fish += fishOf(s).length;
      }
      for (const g of groups.values()) {
        if (g.ids.length < COMBO_MIN_SESSIONS || g.hours <= 0 || g.fish === 0) continue;
        results.push({ ...g, sessions: g.ids.length, rate: g.fish / g.hours, lowData: g.ids.length < MIN_SESSIONS });
      }
    }
  }
  // Hoogste vangst per uur eerst; bij gelijke stand de algemenere combinatie en meer sessies.
  results.sort((a, b) => b.rate - a.rate || a.parts.length - b.parts.length || b.sessions - a.sessions);
  const seen = new Set();
  const out = [];
  for (const r of results) {
    const sig = [...r.ids].sort().join(',');
    if (seen.has(sig)) continue; // zelfde sessies, alleen een langere omschrijving
    seen.add(sig);
    out.push(r);
    if (out.length >= limit) break;
  }
  return out;
}

export function overall(sessions, fishOf) {
  const hours = sessions.reduce((n, s) => n + hoursOf(s), 0);
  const fish = sessions.reduce((n, s) => n + fishOf(s).length, 0);
  return { hours, fish, sessions: sessions.length, rate: hours > 0 ? fish / hours : 0 };
}
