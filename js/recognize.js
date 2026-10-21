// FL-20: kunstaas herkennen op een foto met Claude (eigen API-sleutel van de gebruiker).
// Twee standen:
//  - grondig: Claude Sonnet 5.5 bekijkt de foto en zoekt het product op internet op
//             (merk, model, maat en gewicht van de fabrikant of een webshop)
//  - snel:    Claude Haiku 5.5 bekijkt alleen de foto, zonder internet
import * as db from './db.js';

export const KEY_SETTING = 'anthropicKey';
export const MODE_SETTING = 'recognizeMode';

const MODES = {
  grondig: { model: 'claude-sonnet-5-5', search: true, inPerM: 2, outPerM: 10 },
  snel: { model: 'claude-haiku-5-5', search: false, inPerM: 0.1, outPerM: 0.5 },
};
const SEARCH_PRICE = 0.01; // $10 per 1000 zoekopdrachten
const MAX_SEARCHES = 4;

export const getKey = () => db.getSetting(KEY_SETTING, '');
export const setKey = (k) => db.setSetting(KEY_SETTING, k.trim());
export const clearKey = () => db.del('settings', KEY_SETTING);
export const getMode = () => db.getSetting(MODE_SETTING, 'grondig');
export const setMode = (m) => db.setSetting(MODE_SETTING, m);

const blobToBase64 = (blob) =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });

export class RecognizeError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

function lureTool(types) {
  return {
    name: 'kunstaas',
    description: 'Leg vast welk kunstaas op de foto staat. Roep dit altijd als laatste stap aan.',
    input_schema: {
      type: 'object',
      properties: {
        herkend: { type: 'boolean', description: 'false als er geen kunstaas op de foto staat' },
        type: { type: 'string', enum: types, description: 'Categorie. Shads = shads met paddle tail op een jigkop of systeem; Dropshot Shads = kleine slanke shads voor dropshot; Softbaits = overige softbaits (creatures, wormen, slugs); Pluggen = crankbaits, wobblers en minnows met lip; Jerkbaits = lipless/glide jerkbaits; Oppervlakte aas = topwater, poppers, walkers.' },
        merk: { type: 'string', description: 'Merk, bijv. "Savage Gear". Leeg als je het niet zeker weet.' },
        model: { type: 'string', description: 'Modelnaam zoals de fabrikant die gebruikt, bijv. "4D Line Thru Pike". Leeg als je het niet zeker weet.' },
        kleur: { type: 'string', description: 'Kleurnaam zoals de fabrikant of vissers die gebruiken (bijv. Firetiger, Roach, Chartreuse)' },
        maat_cm: { type: 'number', description: 'Lengte in cm. Liefst uit de productgegevens; anders geschat.' },
        gewicht_g: { type: 'number', description: 'Gewicht in gram uit de productgegevens. Weglaten als je het niet weet.' },
        drijfvermogen: { type: 'string', description: 'Bijv. drijvend, zinkend, suspending, langzaam zinkend. Alleen als bekend.' },
        bron: { type: 'string', description: 'URL van de productpagina waar maat en gewicht vandaan komen, als je die hebt gevonden' },
        zekerheid: { type: 'string', enum: ['hoog', 'middel', 'laag'], description: 'Hoe zeker je bent van merk en model' },
        toelichting: { type: 'string', description: 'Eén korte zin in het Nederlands: wat je zag en hoe je het product hebt gevonden' },
      },
      required: ['herkend', 'type', 'kleur', 'zekerheid'],
    },
  };
}

const PROMPT_SEARCH = `Dit is een foto van kunstaas voor roofvissen (snoek, snoekbaars, baars).
1. Bekijk de foto goed: vorm, lip, ogen, haken, opdruk of logo, en tekst op een eventuele verpakking.
2. Bepaal welk merk en model het waarschijnlijk is. Gebruik web_search om dat te controleren: zoek op merk, model en kenmerken en vergelijk de productfoto's met deze foto. Zoek ook de lengte en het gewicht van precies deze uitvoering op.
3. Roep daarna het hulpmiddel kunstaas aan met wat je hebt gevonden.
Wees eerlijk: als je het model niet zeker weet, laat merk of model leeg of zet zekerheid op laag. Verzin geen gewicht.`;

const PROMPT_PLAIN = `Dit is een foto van kunstaas voor roofvissen. Herken de categorie, en als het een bekend merk of model is ook merk en model. Gebruik voor de categorie precies één waarde uit de lijst. Raad geen merk als je het niet herkent. Roep het hulpmiddel kunstaas aan.`;

async function callApi(key, body) {
  let res;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify(body),
    });
  } catch (_) {
    throw new RecognizeError('Geen verbinding met de herkenning. Vul het aas handmatig in.', 'offline');
  }
  if (res.status === 401) throw new RecognizeError('De API-sleutel klopt niet. Controleer hem in de Tackle box.', 'bad_key');
  if (res.status === 429 || res.status === 529) throw new RecognizeError('De herkenning is even druk. Probeer het zo opnieuw.', 'busy');
  if (!res.ok) {
    let msg = '';
    try { msg = (await res.json()).error?.message || ''; } catch (_) { /* leeg */ }
    if (/credit|billing|balance/i.test(msg)) throw new RecognizeError('Je API-tegoed is op. Vul het aan in de Claude Console.', 'credit');
    if (/web search is not enabled/i.test(msg)) throw new RecognizeError('Zoeken op internet staat uit in je Claude Console (Settings › Capabilities). Zet het aan, of kies de snelle stand.', 'no_search');
    throw new RecognizeError(`Herkennen mislukt (${res.status}). Vul het aas handmatig in.`, 'error');
  }
  return res.json();
}

/**
 * Stuurt de foto naar Claude en krijgt type, merk, model, kleur, maat en gewicht terug.
 * `types` is de lijst kunstaastypes uit de app, zodat het type daar altijd in past.
 */
export async function recognizeLure(blob, types, onProgress = () => {}) {
  const key = await getKey();
  if (!key) throw new RecognizeError('Geen API-sleutel ingesteld.', 'no_key');
  if (!navigator.onLine) throw new RecognizeError('Geen internet. Vul het aas handmatig in.', 'offline');
  const mode = MODES[await getMode()] || MODES.grondig;
  const tool = lureTool(types);

  const tools = mode.search
    ? [{ type: 'web_search_20250305', name: 'web_search', max_uses: MAX_SEARCHES, user_location: { type: 'approximate', country: 'NL', timezone: 'Europe/Amsterdam' } }, tool]
    : [tool];
  const messages = [
    {
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: blob.type || 'image/jpeg', data: await blobToBase64(blob) } },
        { type: 'text', text: mode.search ? PROMPT_SEARCH : PROMPT_PLAIN },
      ],
    },
  ];

  const usage = { input: 0, output: 0, searches: 0 };
  const count = (data) => {
    usage.input += (data.usage?.input_tokens || 0) + (data.usage?.cache_creation_input_tokens || 0) + (data.usage?.cache_read_input_tokens || 0);
    usage.output += data.usage?.output_tokens || 0;
    usage.searches += data.usage?.server_tool_use?.web_search_requests || 0;
  };

  onProgress(mode.search ? 'Foto bekijken en product opzoeken…' : 'Foto bekijken…');
  let data = await callApi(key, {
    model: mode.model,
    max_tokens: 1500,
    tools,
    tool_choice: mode.search ? { type: 'auto' } : { type: 'tool', name: 'kunstaas' },
    messages,
  });
  count(data);

  // Lange zoektochten kunnen pauzeren; dan één keer laten doorgaan.
  let rounds = 0;
  while (data.stop_reason === 'pause_turn' && rounds < 2) {
    rounds++;
    onProgress('Nog even zoeken…');
    messages.push({ role: 'assistant', content: data.content });
    data = await callApi(key, { model: mode.model, max_tokens: 1500, tools, tool_choice: { type: 'auto' }, messages });
    count(data);
  }

  let block = (data.content || []).find((b) => b.type === 'tool_use' && b.name === 'kunstaas');
  if (!block) {
    // Claude gaf alleen tekst: vraag het formulier alsnog in te vullen.
    messages.push({ role: 'assistant', content: data.content });
    messages.push({ role: 'user', content: 'Vul nu het hulpmiddel kunstaas in met wat je hebt gevonden.' });
    // Zelfde tools meesturen: het gesprek bevat al zoekresultaten.
    data = await callApi(key, { model: mode.model, max_tokens: 800, tools, tool_choice: { type: 'tool', name: 'kunstaas' }, messages });
    count(data);
    block = (data.content || []).find((b) => b.type === 'tool_use' && b.name === 'kunstaas');
  }
  if (!block) throw new RecognizeError('Geen antwoord ontvangen. Vul het aas handmatig in.', 'error');

  const r = block.input || {};
  if (r.herkend === false) throw new RecognizeError('Op deze foto is geen kunstaas herkend. Vul het handmatig in.', 'not_found');
  const costUsd = (usage.input * mode.inPerM + usage.output * mode.outPerM) / 1e6 + usage.searches * SEARCH_PRICE;
  const name = [r.merk, r.model].map((x) => (x || '').trim()).filter(Boolean).join(' ');
  const source = typeof r.bron === 'string' && /^https?:\/\//.test(r.bron) ? r.bron : '';
  return {
    type: types.includes(r.type) ? r.type : '',
    name,
    color: (r.kleur || '').trim(),
    sizeCm: typeof r.maat_cm === 'number' && r.maat_cm > 0 ? Math.round(r.maat_cm * 2) / 2 : null,
    weightG: typeof r.gewicht_g === 'number' && r.gewicht_g > 0 ? Math.round(r.gewicht_g * 2) / 2 : null,
    action: (r.drijfvermogen || '').trim(),
    source,
    confidence: r.zekerheid || 'laag',
    note: (r.toelichting || '').trim(),
    searches: usage.searches,
    costUsd,
  };
}

// ---------- Kunstaas ophalen via een link (FL-32) ----------

const LINK_MODEL = 'claude-haiku-5-5';

function linkTool(types) {
  return {
    name: 'kunstaas',
    description: 'Leg de productgegevens vast van het kunstaas op de opgehaalde productpagina. Roep dit altijd als laatste stap aan.',
    input_schema: {
      type: 'object',
      properties: {
        gevonden: { type: 'boolean', description: 'false als de pagina niet te lezen was of geen kunstaas-product toont' },
        categorie: { type: 'string', enum: types, description: 'Categorie die het best past. Shads = paddle tail shads; Dropshot Shads = kleine slanke shads voor dropshot; Softbaits = overige softbaits; Pluggen = crankbaits, wobblers, minnows met lip; Jerkbaits = lipless/glide jerkbaits; Oppervlakte aas = topwater, poppers, walkers.' },
        merk: { type: 'string', description: 'Merk, bijv. "Westin"' },
        model: { type: 'string', description: 'Modelnaam zonder merk, maat en kleur, bijv. "Swim Glidebait"' },
        kleur: { type: 'string', description: 'Kleur of kleurnaam van deze uitvoering. Leeg als de pagina meerdere kleuren toont en niet duidelijk is welke bedoeld is.' },
        maat_cm: { type: 'number', description: 'Lengte in cm van deze uitvoering' },
        gewicht_g: { type: 'number', description: 'Gewicht in gram van deze uitvoering' },
        drijfvermogen: { type: 'string', description: 'Bijv. drijvend, zinkend, suspending. Alleen als vermeld.' },
        afbeelding_url: { type: 'string', description: 'Volledige https-URL van de hoofdafbeelding van het product, als die in de pagina staat' },
        meerdere_varianten: { type: 'boolean', description: 'true als de pagina meerdere maten of kleuren aanbiedt en niet zeker is welke bedoeld is' },
      },
      required: ['gevonden', 'categorie'],
    },
  };
}

/** Haalt merk, model, kleur, maat, gewicht en afbeelding op van een productpagina (bijv. tackleshop.nl). */
export async function importFromLink(url, types, onProgress = () => {}) {
  const key = await getKey();
  if (!key) throw new RecognizeError('Geen API-sleutel ingesteld.', 'no_key');
  if (!navigator.onLine) throw new RecognizeError('Geen internet. Vul het aas handmatig in.', 'offline');
  let u;
  try { u = new URL(url.trim()); } catch (_) { throw new RecognizeError('Dit is geen geldige link. Kopieer de link van de productpagina en plak hem hier.', 'bad_url'); }
  if (!/^https?:$/.test(u.protocol)) throw new RecognizeError('Dit is geen geldige link.', 'bad_url');

  const tool = linkTool(types);
  const tools = [{ type: 'web_fetch_20250910', name: 'web_fetch', max_uses: 2, max_content_tokens: 30000 }, tool];
  const messages = [{
    role: 'user',
    content: `Haal deze productpagina op: ${u.href}\nDit is een pagina van een hengelsportwinkel met kunstaas. Lees merk, model, kleur, lengte, gewicht en de hoofdafbeelding van precies deze uitvoering af (let op kleur- of maatkeuze in de link). Vul daarna het hulpmiddel kunstaas in. Verzin niets: wat niet op de pagina staat laat je leeg.`,
  }];
  const usage = { input: 0, output: 0 };
  const count = (d) => { usage.input += (d.usage?.input_tokens || 0) + (d.usage?.cache_read_input_tokens || 0) + (d.usage?.cache_creation_input_tokens || 0); usage.output += d.usage?.output_tokens || 0; };

  onProgress('Productpagina ophalen…');
  let data = await callApi(key, { model: LINK_MODEL, max_tokens: 1200, tools, tool_choice: { type: 'auto' }, messages });
  count(data);
  let rounds = 0;
  while (data.stop_reason === 'pause_turn' && rounds < 2) {
    rounds++;
    messages.push({ role: 'assistant', content: data.content });
    data = await callApi(key, { model: LINK_MODEL, max_tokens: 1200, tools, tool_choice: { type: 'auto' }, messages });
    count(data);
  }
  let block = (data.content || []).find((b) => b.type === 'tool_use' && b.name === 'kunstaas');
  if (!block) {
    messages.push({ role: 'assistant', content: data.content });
    messages.push({ role: 'user', content: 'Vul nu het hulpmiddel kunstaas in met wat je op de pagina hebt gevonden.' });
    data = await callApi(key, { model: LINK_MODEL, max_tokens: 800, tools, tool_choice: { type: 'tool', name: 'kunstaas' }, messages });
    count(data);
    block = (data.content || []).find((b) => b.type === 'tool_use' && b.name === 'kunstaas');
  }
  if (!block) throw new RecognizeError('De pagina kon niet worden gelezen. Vul het aas handmatig in.', 'error');
  const r = block.input || {};
  if (r.gevonden === false) throw new RecognizeError('Op deze pagina is geen kunstaas gevonden, of de winkel was niet bereikbaar. Vul het handmatig in.', 'not_found');
  const img = typeof r.afbeelding_url === 'string' && /^https:\/\//.test(r.afbeelding_url) ? r.afbeelding_url : '';
  return {
    type: types.includes(r.categorie) ? r.categorie : '',
    name: [r.merk, r.model].map((x) => (x || '').trim()).filter(Boolean).join(' '),
    color: (r.kleur || '').trim(),
    sizeCm: typeof r.maat_cm === 'number' && r.maat_cm > 0 ? Math.round(r.maat_cm * 2) / 2 : null,
    weightG: typeof r.gewicht_g === 'number' && r.gewicht_g > 0 ? Math.round(r.gewicht_g * 2) / 2 : null,
    action: (r.drijfvermogen || '').trim(),
    imageUrl: img,
    variants: !!r.meerdere_varianten,
    source: u.href,
    costUsd: (usage.input * 0.1 + usage.output * 0.5) / 1e6,
  };
}
