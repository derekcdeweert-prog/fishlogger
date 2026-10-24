// Waterhelderheid die tijdens een sessie kan veranderen (FL-33).
import { activeHours } from './session-time.js';

export const WATER = ['Helder', 'Licht troebel', 'Troebel'];

/** Alle wissels van waterhelderheid, oudste eerst; zonder wissels één regel vanaf de start. */
export function waterTimeline(s) {
  const list = s.waterChanges && s.waterChanges.length ? s.waterChanges : [{ at: s.startedAt, clarity: s.waterClarity }];
  return [...list].filter((w) => w.clarity).sort((a, b) => a.at.localeCompare(b.at));
}

/** Waterhelderheid op een moment. */
export function waterAt(s, iso) {
  const line = waterTimeline(s);
  let cur = line[0] ? line[0].clarity : s.waterClarity;
  for (const w of line) if (w.at <= iso) cur = w.clarity;
  return cur || null;
}

/** Vistijd (zonder pauzes) per waterhelderheid. */
export function waterHours(s) {
  const start = Date.parse(s.startedAt);
  const end = s.endedAt ? Date.parse(s.endedAt) : Date.now();
  const line = waterTimeline(s).map((w) => ({ ...w, t: Math.min(Math.max(Date.parse(w.at), start), end) }));
  const out = new Map();
  line.forEach((w, i) => {
    const until = i + 1 < line.length ? line[i + 1].t : end;
    const h = activeHours(s, w.t, until);
    if (h > 0) out.set(w.clarity, (out.get(w.clarity) || 0) + h);
  });
  return out;
}

/** De waterhelderheid waarbij het langst is gevist. */
export function waterMost(s) {
  let best = null;
  let bestH = -1;
  for (const [c, h] of waterHours(s)) if (h > bestH) { best = c; bestH = h; }
  return best || s.waterClarity || null;
}
