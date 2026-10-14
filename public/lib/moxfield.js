// Moxfield import. Moxfield's API doesn't allow browser requests from other sites,
// so the page asks the local server (server.js, /api/moxfield/<id>) to fetch it.
const API = 'https://api2.moxfield.com';

// Accepts a deck URL (https://moxfield.com/decks/<id>) or a bare deck id.
export function moxfieldId(input) {
  const s = (input || '').trim();
  const m = s.match(/moxfield\.com\/decks\/([A-Za-z0-9_-]+)/);
  if (m) return m[1];
  return /^[A-Za-z0-9_-]{6,}$/.test(s) ? s : null;
}

const FORMAT_MAP = { standard: 'standard', pioneer: 'pioneer', modern: 'modern', commander: 'commander' };

function boardCards(deck, board) {
  // v3: deck.boards.mainboard.cards = { key: { quantity, card: { name } } }
  // v2: deck.mainboard = { "Card Name": { quantity, card: { name } } }
  const b = deck.boards ? deck.boards[board] && deck.boards[board].cards : deck[board];
  if (!b) return [];
  return Object.entries(b).map(([key, v]) => ({ name: (v.card && v.card.name) || key, count: v.quantity || 1 }));
}

// Moxfield deck JSON -> { name, format, text } with text in Arena export format.
export function moxfieldToDecklist(deck) {
  const lines = (cards) => cards.map((c) => `${c.count} ${c.name}`).join('\n');
  const commanders = boardCards(deck, 'commanders');
  const main = boardCards(deck, 'mainboard');
  const side = boardCards(deck, 'sideboard');
  const parts = [];
  if (commanders.length) parts.push('Commander\n' + lines(commanders));
  parts.push('Deck\n' + lines(main));
  if (side.length) parts.push('Sideboard\n' + lines(side));
  return { name: deck.name || '', format: FORMAT_MAP[deck.format] || null, text: parts.join('\n\n') + '\n' };
}

// Server-side fetch (Node). Tries the v3 endpoint, then v2.
export async function fetchMoxfieldDeck(id, { fetchImpl = globalThis.fetch } = {}) {
  let lastStatus = 0;
  for (const path of [`/v3/decks/all/${id}`, `/v2/decks/all/${id}`]) {
    let res;
    try {
      res = await fetchImpl(API + path, {
        headers: { Accept: 'application/json', 'User-Agent': 'manabase-builder/0.1 (+local)' },
      });
    } catch {
      throw new Error("couldn't reach Moxfield");
    }
    if (res.ok) return moxfieldToDecklist(await res.json());
    lastStatus = res.status;
    if (res.status === 404) break;
  }
  const why = lastStatus === 404 ? 'deck not found (is it public?)' : `Moxfield returned ${lastStatus}`;
  throw new Error(why);
}
