// The card index and the query engine over it.
//
// The index ships with the site, so search runs against memory rather than the
// network: no round trip per keystroke and nothing breaks if the API is down.

export const state = {
  cards: [],
  byId: new Map(),
  sets: [],
  setName: new Map(),
  rarities: [],
  artists: [],
  ready: false,
};

/**
 * Rarities whose cards are the reason people build display pages. Checked
 * against the built index: "Full Art Trainer" is excluded because all six of
 * its entries lack artwork.
 */
export const ART_RARITIES = [
  'Special illustration rare',
  'Illustration rare',
  'Ultra Rare',
  'Secret Rare',
  'Hyper rare',
  'Mega Hyper Rare',
  'Shiny Ultra Rare',
  'Crown',
  'Radiant Rare',
  'Amazing Rare',
  'Black White Rare',
];

export async function load(base = '') {
  const [cards, sets] = await Promise.all([
    fetch(`${base}data/cards.json`).then((r) => {
      if (!r.ok) throw new Error(`card index failed to load (${r.status})`);
      return r.json();
    }),
    fetch(`${base}data/sets.json`).then((r) => {
      if (!r.ok) throw new Error(`set list failed to load (${r.status})`);
      return r.json();
    }),
  ]);

  state.cards = cards;
  state.sets = sets;
  for (const c of cards) {
    state.byId.set(c.i, c);
    c._n = c.n.toLowerCase();
    c._a = (c.a || '').toLowerCase();
  }
  for (const s of sets) state.setName.set(s.i, s.n);
  for (const c of cards) c._s = (state.setName.get(c.s) || c.s).toLowerCase();

  state.rarities = [...new Set(cards.map((c) => c.r).filter(Boolean))].sort();
  state.artists = [...new Set(cards.map((c) => c.a).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));
  state.ready = true;
  return state;
}

export const getCard = (id) => state.byId.get(id) || null;
export const setNameOf = (card) => state.setName.get(card.s) || card.s;

/**
 * 'low' for thumbnails, 'high' for the page canvas and printing.
 *
 * Cards carry a provider flag because the two sources shape their URLs
 * differently: TCGdex appends /high.webp to a folder, while pokemontcg.io --
 * which supplies the scans TCGdex lacks -- appends _hires.png to the card.
 */
export const imageUrl = (card, quality = 'low') =>
  card.p === 'p'
    ? `${card.u}${quality === 'high' ? '_hires' : ''}.png`
    : `${card.u}/${quality}.webp`;

export const imageFallback = (card, quality = 'low') =>
  card.p === 'p' ? `${card.u}.png` : `${card.u}/${quality}.png`;

export const cardLabel = (card) =>
  `${card.n} - ${setNameOf(card)} ${card.l}`;

/**
 * Rank matches: whole name first, then name start, then anywhere in the name,
 * then artist, then set. Ties break on the shorter name so "Pikachu" outranks
 * "Pikachu & Zekrom GX" for a bare "pikachu".
 */
function score(card, q) {
  if (card._n === q) return 0;
  const at = card._n.indexOf(q);
  if (at === 0) return 1;
  if (at > 0) return 2;
  if (card._a.includes(q)) return 3;
  if (card._s.includes(q)) return 4;
  return -1;
}

export function search(query, filters = {}, limit = 240) {
  const q = (query || '').trim().toLowerCase();
  const rarities = filters.rarities && filters.rarities.length
    ? new Set(filters.rarities) : null;
  const setId = filters.setId || null;

  const hits = [];
  for (const card of state.cards) {
    if (rarities && !rarities.has(card.r)) continue;
    if (setId && card.s !== setId) continue;

    let rank = 0;
    if (q) {
      rank = score(card, q);
      if (rank < 0) continue;
    }
    hits.push({ card, rank });
  }

  hits.sort((a, b) =>
    a.rank - b.rank ||
    a.card.n.length - b.card.n.length ||
    a.card.n.localeCompare(b.card.n) ||
    a.card.i.localeCompare(b.card.i)
  );

  return { total: hits.length, cards: hits.slice(0, limit).map((h) => h.card) };
}
