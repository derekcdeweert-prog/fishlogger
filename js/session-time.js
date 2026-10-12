// Vistijd van een sessie, zonder pauzes (FL-29).

const endMs = (s) => (s.endedAt ? Date.parse(s.endedAt) : Date.now());

/** Pauzes als [van, tot] in ms; een lopende pauze loopt tot nu (of tot het einde van de sessie). */
export function pauseRanges(s) {
  const end = endMs(s);
  return (s.pauses || []).map((p) => [Date.parse(p.start), p.end ? Date.parse(p.end) : Math.min(Date.now(), end)]);
}

/** Gepauzeerde ms binnen [from, to]. */
export function pausedMs(s, from, to) {
  let ms = 0;
  for (const [a, b] of pauseRanges(s)) ms += Math.max(0, Math.min(b, to) - Math.max(a, from));
  return ms;
}

/** Vistijd in uren binnen [from, to] (standaard de hele sessie), zonder pauzes. */
export function activeHours(s, from = Date.parse(s.startedAt), to = endMs(s)) {
  if (to <= from) return 0;
  return Math.max(0, to - from - pausedMs(s, from, to)) / 3600e3;
}

export const pauseHours = (s) => pausedMs(s, Date.parse(s.startedAt), endMs(s)) / 3600e3;

export const isPaused = (s) => !s.endedAt && (s.pauses || []).some((p) => !p.end);

/** Pauzes bijsnijden tot binnen de sessie; een open pauze sluiten bij het einde. */
export function clampPauses(s) {
  const start = Date.parse(s.startedAt);
  const end = s.endedAt ? Date.parse(s.endedAt) : null;
  s.pauses = (s.pauses || [])
    .map((p) => {
      let a = Math.max(Date.parse(p.start), start);
      let b = p.end ? Date.parse(p.end) : end;
      if (end != null) { a = Math.min(a, end); b = b == null ? end : Math.min(b, end); }
      return { start: new Date(a).toISOString(), end: b == null ? null : new Date(b).toISOString() };
    })
    .filter((p) => !p.end || Date.parse(p.end) > Date.parse(p.start));
  return s;
}
