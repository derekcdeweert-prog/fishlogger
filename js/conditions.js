// Omstandigheden: zon, maan, seizoen, dagdeel en weer (Open-Meteo).

const RAD = Math.PI / 180;
const DAY_MS = 864e5;
const J1970 = 2440588;
const J2000 = 2451545;
const OBLIQUITY = RAD * 23.4397;

// Standaard-locatie (midden Nederland) als er geen GPS is.
export const DEFAULT_POS = { lat: 52.1, lng: 5.1 };

const toJulian = (date) => date.valueOf() / DAY_MS - 0.5 + J1970;
const fromJulian = (j) => new Date((j + 0.5 - J1970) * DAY_MS);
const toDays = (date) => toJulian(date) - J2000;

function solarMeanAnomaly(d) {
  return RAD * (357.5291 + 0.98560028 * d);
}
function eclipticLongitude(M) {
  const C = RAD * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
  return M + C + RAD * 102.9372 + Math.PI;
}
function declination(l) {
  return Math.asin(Math.sin(OBLIQUITY) * Math.sin(l));
}

/** Zonsopkomst en -ondergang voor de dag van `date` op lat/lng. */
export function sunTimes(date, lat, lng) {
  const noonLocal = new Date(date);
  noonLocal.setHours(12, 0, 0, 0);
  const lw = RAD * -lng;
  const phi = RAD * lat;
  const d = toDays(noonLocal);
  const n = Math.round(d - 0.0009 - lw / (2 * Math.PI));
  const ds = 0.0009 + lw / (2 * Math.PI) + n;
  const M = solarMeanAnomaly(ds);
  const L = eclipticLongitude(M);
  const dec = declination(L);
  const jNoon = J2000 + ds + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L);
  const h0 = -0.833 * RAD;
  const cosW = (Math.sin(h0) - Math.sin(phi) * Math.sin(dec)) / (Math.cos(phi) * Math.cos(dec));
  if (cosW < -1 || cosW > 1) return null; // poolnacht of middernachtzon
  const w = Math.acos(cosW);
  const a = 0.0009 + (w + lw) / (2 * Math.PI) + n;
  const jSet = J2000 + a + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L);
  const jRise = jNoon - (jSet - jNoon);
  return { sunrise: fromJulian(jRise), sunset: fromJulian(jSet) };
}

export const DAY_PARTS = ['Ochtendschemer', 'Ochtend', 'Middag', 'Avondschemer', 'Nacht'];

/** Dagdeel: schemer = één uur voor tot één uur na zonsopkomst/-ondergang. */
export function dayPart(date, lat, lng) {
  const st = sunTimes(date, lat, lng);
  if (!st) return 'Middag';
  const t = date.getTime();
  const hour = 3600e3;
  const rise = st.sunrise.getTime();
  const set = st.sunset.getTime();
  if (t >= rise - hour && t <= rise + hour) return 'Ochtendschemer';
  if (t >= set - hour && t <= set + hour) return 'Avondschemer';
  if (t > rise + hour && date.getHours() < 12) return 'Ochtend';
  if (date.getHours() >= 12 && t < set - hour) return 'Middag';
  return 'Nacht';
}

export const SEASONS = ['Lente', 'Zomer', 'Herfst', 'Winter'];

/** Meteorologisch seizoen. */
export function season(date) {
  const m = date.getMonth(); // 0 = januari
  if (m >= 2 && m <= 4) return 'Lente';
  if (m >= 5 && m <= 7) return 'Zomer';
  if (m >= 8 && m <= 10) return 'Herfst';
  return 'Winter';
}

export const MONTHS = ['januari', 'februari', 'maart', 'april', 'mei', 'juni', 'juli', 'augustus', 'september', 'oktober', 'november', 'december'];

export const MOON_PHASES = ['Nieuwe maan', 'Wassende sikkel', 'Eerste kwartier', 'Wassende maan', 'Volle maan', 'Afnemende maan', 'Laatste kwartier', 'Afnemende sikkel'];

/** Maanfase als fractie (0 = nieuw, 0,5 = vol), naam en verlicht deel. */
export function moon(date) {
  const synodic = 29.530588853;
  const ref = Date.UTC(2000, 0, 6, 18, 14); // nieuwe maan
  let p = ((date.getTime() - ref) / DAY_MS / synodic) % 1;
  if (p < 0) p += 1;
  let name;
  if (p < 0.033 || p >= 0.967) name = 'Nieuwe maan';
  else if (p < 0.217) name = 'Wassende sikkel';
  else if (p < 0.283) name = 'Eerste kwartier';
  else if (p < 0.467) name = 'Wassende maan';
  else if (p < 0.533) name = 'Volle maan';
  else if (p < 0.717) name = 'Afnemende maan';
  else if (p < 0.783) name = 'Laatste kwartier';
  else name = 'Afnemende sikkel';
  const illumination = Math.round(((1 - Math.cos(2 * Math.PI * p)) / 2) * 100);
  return { phase: p, name, illumination };
}

/** Alle berekende (offline) omstandigheden voor een moment en plek. */
export function computedConditions(date, pos) {
  const { lat, lng } = pos || DEFAULT_POS;
  const st = sunTimes(date, lat, lng);
  const m = moon(date);
  return {
    dayPart: dayPart(date, lat, lng),
    season: season(date),
    month: date.getMonth() + 1,
    moonPhase: m.name,
    moonIllumination: m.illumination,
    sunrise: st ? st.sunrise.toISOString() : null,
    sunset: st ? st.sunset.toISOString() : null,
  };
}

// ---------- Weer ----------

const WIND_DIRS = ['N', 'NO', 'O', 'ZO', 'Z', 'ZW', 'W', 'NW'];
export function windDirName(deg) {
  if (deg == null || Number.isNaN(deg)) return '';
  return WIND_DIRS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
}

const BFT_LIMITS = [1, 6, 12, 20, 29, 39, 50, 62, 75, 89, 103, 118]; // km/u
export function beaufort(kmh) {
  if (kmh == null) return null;
  let b = 0;
  while (b < BFT_LIMITS.length && kmh >= BFT_LIMITS[b]) b++;
  return b;
}

export function pressureTrend(delta3h) {
  if (delta3h == null) return null;
  if (delta3h >= 1) return 'Stijgend';
  if (delta3h <= -1) return 'Dalend';
  return 'Stabiel';
}

const WMO = {
  0: 'Onbewolkt', 1: 'Overwegend helder', 2: 'Half bewolkt', 3: 'Bewolkt',
  45: 'Mist', 48: 'Mist met rijp',
  51: 'Lichte motregen', 53: 'Motregen', 55: 'Dichte motregen',
  56: 'IJzel', 57: 'IJzel',
  61: 'Lichte regen', 63: 'Regen', 65: 'Zware regen',
  66: 'IJzel', 67: 'IJzel',
  71: 'Lichte sneeuw', 73: 'Sneeuw', 75: 'Zware sneeuw', 77: 'Korrelsneeuw',
  80: 'Lichte buien', 81: 'Buien', 82: 'Zware buien',
  85: 'Sneeuwbuien', 86: 'Zware sneeuwbuien',
  95: 'Onweer', 96: 'Onweer met hagel', 99: 'Onweer met hagel',
};
export const weatherDesc = (code) => WMO[code] ?? '';

/**
 * Haalt het weer op voor een moment en plek. Werkt ook achteraf (tot ±90 dagen terug),
 * zodat een sessie zonder bereik later kan worden aangevuld.
 */
export async function fetchWeather(date, pos) {
  const now = Date.now();
  const daysBack = Math.ceil((now - date.getTime()) / DAY_MS) + 1;
  if (daysBack > 92) throw new Error('Te lang geleden voor weergegevens');
  const params = new URLSearchParams({
    latitude: pos.lat.toFixed(4),
    longitude: pos.lng.toFixed(4),
    hourly: 'temperature_2m,precipitation,cloud_cover,pressure_msl,wind_speed_10m,wind_direction_10m,weather_code',
    timezone: 'auto',
    past_days: String(Math.max(1, daysBack)),
    forecast_days: '1',
    wind_speed_unit: 'kmh',
  });
  const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Weerdienst gaf fout ${res.status}`);
  const data = await res.json();
  return pickHour(data, date);
}

/** Kiest het uur dat het dichtst bij `date` ligt en berekent het drukverloop over 3 uur. */
export function pickHour(data, date) {
  const h = data.hourly;
  const offset = (data.utc_offset_seconds || 0) * 1000;
  const target = date.getTime();
  let best = -1;
  let bestDiff = Infinity;
  for (let i = 0; i < h.time.length; i++) {
    const t = Date.parse(h.time[i] + ':00Z') - offset;
    const diff = Math.abs(t - target);
    if (diff < bestDiff) { bestDiff = diff; best = i; }
  }
  if (best < 0 || bestDiff > 2 * 3600e3) throw new Error('Geen weergegevens voor dit tijdstip');
  const p = h.pressure_msl[best];
  const p3 = best >= 3 ? h.pressure_msl[best - 3] : null;
  const delta = p != null && p3 != null ? Math.round((p - p3) * 10) / 10 : null;
  const windKmh = h.wind_speed_10m[best];
  const dirDeg = h.wind_direction_10m[best];
  const code = h.weather_code[best];
  return {
    status: 'ok',
    fetchedAt: new Date().toISOString(),
    tempC: h.temperature_2m[best],
    windKmh,
    windBft: beaufort(windKmh),
    windDirDeg: dirDeg,
    windDir: windDirName(dirDeg),
    cloudPct: h.cloud_cover[best],
    precipMm: h.precipitation[best],
    pressureHpa: p,
    pressureDelta3h: delta,
    pressureTrend: pressureTrend(delta),
    weatherCode: code,
    desc: weatherDesc(code),
  };
}

// ---------- Afstand ----------

export function distanceM(a, b) {
  const R = 6371e3;
  const dLat = (b.lat - a.lat) * RAD;
  const dLng = (b.lng - a.lng) * RAD;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
