// Scryfall client. Works in the browser (Scryfall allows cross-origin requests)
// and in Node 18+.
import { cardKey } from './decklist.js';

const API = 'https://api.scryfall.com';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, init, fetchImpl) {
  const res = await fetchImpl(url, { ...init, headers: { Accept: 'application/json', ...(init && init.headers) } });
  if (!res.ok && res.status !== 404) throw new Error(`Scryfall returned ${res.status} for ${url}`);
  return res.json();
}

// names -> { cards: Map(cardKey(requested name) -> scryfall card), notFound: [name] }
export async function fetchCollection(names, { fetchImpl = globalThis.fetch, onProgress } = {}) {
  const cards = new Map();
  const notFound = [];
  const unique = [...new Set(names)];
  for (let i = 0; i < unique.length; i += 75) {
    const batch = unique.slice(i, i + 75);
    const body = await getJson(`${API}/cards/collection`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifiers: batch.map((name) => ({ name })) }),
    }, fetchImpl);
    const byName = new Map();
    for (const c of body.data || []) {
      byName.set(cardKey(c.name), c);
      for (const f of c.card_faces || []) byName.set(cardKey(f.name), c);
    }
    for (const n of batch) {
      const c = byName.get(cardKey(n));
      if (c) cards.set(cardKey(n), c); else notFound.push(n);
    }
    if (onProgress) onProgress(Math.min(i + 75, unique.length), unique.length);
    if (i + 75 < unique.length) await sleep(100);
  }
  return { cards, notFound };
}

// Nonbasic lands legal in the format whose color identity fits the deck.
export async function searchLands(colors, legalityKey, { fetchImpl = globalThis.fetch, limit = 175 } = {}) {
  const id = colors.length ? colors.join('').toLowerCase() : 'c';
  const q = `t:land -t:basic f:${legalityKey} id<=${id}`;
  let url = `${API}/cards/search?order=edhrec&unique=cards&q=${encodeURIComponent(q)}`;
  const out = [];
  while (url && out.length < limit) {
    const body = await getJson(url, {}, fetchImpl);
    if (body.object === 'error') break;
    out.push(...(body.data || []));
    url = body.has_more ? body.next_page : null;
    if (url) await sleep(100);
  }
  return out;
}

// Keep only the fields the builder reads, so card data is small enough to cache.
const FIELDS = ['name', 'layout', 'mana_cost', 'cmc', 'type_line', 'oracle_text', 'produced_mana', 'color_identity', 'legalities'];
export function trimCard(c) {
  const out = {};
  for (const f of FIELDS) if (c[f] !== undefined) out[f] = c[f];
  if (c.card_faces) out.card_faces = c.card_faces.map((f) => ({ name: f.name, mana_cost: f.mana_cost, cmc: f.cmc, type_line: f.type_line, oracle_text: f.oracle_text }));
  return out;
}
