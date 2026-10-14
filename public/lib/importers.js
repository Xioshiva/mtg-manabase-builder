// Deck link importers, tried in order. Each returns { name, format, text } or throws.
import { moxfieldId, fetchMoxfieldDeck } from './moxfield.js';
import { parseMtgtop8Url, fetchMtgtop8Deck } from './mtgtop8.js';

export function recognizeDeckLink(input) {
  const s = (input || '').trim();
  const top8 = parseMtgtop8Url(s);
  if (top8) return { site: 'MTGTop8', fetch: (opts) => fetchMtgtop8Deck(top8, opts) };
  if (/moxfield\.com\/decks\//i.test(s)) {
    const id = moxfieldId(s);
    return { site: 'Moxfield', fetch: (opts) => fetchMoxfieldDeck(id, opts) };
  }
  return null;
}

export async function importDeckLink(input, opts) {
  const link = recognizeDeckLink(input);
  if (!link) throw new Error('Not a Moxfield or MTGTop8 deck link');
  return { site: link.site, ...(await link.fetch(opts)) };
}
