// FL-20: kunstaas herkennen op een foto met Claude (eigen API-sleutel van de gebruiker).
import * as db from './db.js';

export const KEY_SETTING = 'anthropicKey';
const MODEL = 'claude-haiku-5-5';

export const getKey = () => db.getSetting(KEY_SETTING, '');
export const setKey = (k) => db.setSetting(KEY_SETTING, k.trim());
export const clearKey = () => db.del('settings', KEY_SETTING);

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

/**
 * Stuurt de foto naar Claude en krijgt type, naam, kleur, maat en gewicht terug.
 * `types` is de lijst kunstaastypes uit de app, zodat het type daar altijd in past.
 */
export async function recognizeLure(blob, types) {
  const key = await getKey();
  if (!key) throw new RecognizeError('Geen API-sleutel ingesteld.', 'no_key');
  if (!navigator.onLine) throw new RecognizeError('Geen internet. Vul het aas handmatig in.', 'offline');

  const tool = {
    name: 'kunstaas',
    description: 'Leg vast welk kunstaas of welke kunstvlieg op de foto staat.',
    input_schema: {
      type: 'object',
      properties: {
        herkend: { type: 'boolean', description: 'false als er geen kunstaas of kunstvlieg op de foto staat' },
        type: { type: 'string', enum: types },
        naam: { type: 'string', description: 'Merk en model, bijv. "Savage Gear 4D Line Thru Pike". Leeg als je het niet zeker weet.' },
        kleur: { type: 'string', description: 'Kleurnaam zoals vissers die gebruiken, in het Nederlands of de gangbare Engelse term (bijv. firetiger, voorn, chartreuse, zwart/rood)' },
        maat_cm: { type: 'number', description: 'Geschatte lengte in cm, alleen als dat redelijk te schatten is' },
        gewicht_g: { type: 'number', description: 'Gewicht in gram, alleen als het op de verpakking of het aas staat of bij een bekend model' },
        zekerheid: { type: 'string', enum: ['hoog', 'middel', 'laag'] },
        toelichting: { type: 'string', description: 'Eén korte zin in het Nederlands over wat je ziet' },
      },
      required: ['herkend', 'type', 'kleur', 'zekerheid'],
    },
  };

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
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 400,
        tools: [tool],
        tool_choice: { type: 'tool', name: 'kunstaas' },
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: blob.type || 'image/jpeg', data: await blobToBase64(blob) } },
              {
                type: 'text',
                text: 'Dit is een foto van kunstaas voor roofvissen of een kunstvlieg. Herken het type, en als het een bekend merk of model is ook de naam. Gebruik voor het type precies één waarde uit de lijst. Raad geen merk als je het niet herkent.',
              },
            ],
          },
        ],
      }),
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
    throw new RecognizeError(`Herkennen mislukt (${res.status}). Vul het aas handmatig in.`, 'error');
  }
  const data = await res.json();
  const block = (data.content || []).find((b) => b.type === 'tool_use');
  if (!block) throw new RecognizeError('Geen antwoord ontvangen. Vul het aas handmatig in.', 'error');
  const r = block.input || {};
  if (r.herkend === false) throw new RecognizeError('Op deze foto is geen kunstaas herkend. Vul het handmatig in.', 'not_found');
  return {
    type: types.includes(r.type) ? r.type : 'Overig',
    name: (r.naam || '').trim(),
    color: (r.kleur || '').trim(),
    sizeCm: typeof r.maat_cm === 'number' && r.maat_cm > 0 ? Math.round(r.maat_cm * 2) / 2 : null,
    weightG: typeof r.gewicht_g === 'number' && r.gewicht_g > 0 ? Math.round(r.gewicht_g * 2) / 2 : null,
    confidence: r.zekerheid || 'laag',
    note: (r.toelichting || '').trim(),
  };
}
