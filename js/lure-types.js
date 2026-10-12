// Aascategorieën (FL-26) en het omzetten van oude categorieën.

export const LURE_TYPES = [
  'Jerkbaits', 'Softbaits', 'Shads', 'Dropshot Shads', 'Spinnerbaits', 'Chatterbaits',
  'Pluggen', 'Oppervlakte aas', 'Swimbaits', 'Dood aas', 'Tailspinners', 'Spinners',
];

/** Oude categorie → nieuwe. Lepel en Overig hebben geen opvolger; Vlieg valt buiten deze versie (FL-27). */
export const LEGACY_TYPES = {
  Jerkbait: 'Jerkbaits',
  Shad: 'Shads',
  Plug: 'Pluggen',
  Spinner: 'Spinners',
  Spinnerbait: 'Spinnerbaits',
  Topwater: 'Oppervlakte aas',
  'Dropshot-aas': 'Dropshot Shads',
  'Jig + softbait': 'Softbaits',
};

export const FLY_TYPE = 'Vlieg';
export const FLY_METHOD = 'Vliegvissen';

/** Categorie van een aas (of een opgeslagen momentopname ervan); null als er geen geldige categorie is. */
export function categoryOf(lure) {
  if (!lure || !lure.type) return null;
  if (LURE_TYPES.includes(lure.type)) return lure.type;
  return LEGACY_TYPES[lure.type] || null;
}

export const isFlyLure = (l) => !!l && l.type === FLY_TYPE;

/** Een sessie die met de vlieg is gevist: telt in deze versie niet mee in inzichten en keuzes. */
export function isFlySession(s) {
  if (s.method === FLY_METHOD) return true;
  const picks = s.changes && s.changes.length ? s.changes : [{ method: s.method, lure: s.lure }];
  return picks.some((c) => c.method === FLY_METHOD || isFlyLure(c.lure));
}
