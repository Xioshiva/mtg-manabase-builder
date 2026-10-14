import { readFileSync } from 'node:fs';
import { normalizeCard, basicLandDef } from '../public/lib/cards.js';
import { getFormat } from '../public/lib/formats.js';

export const raw = JSON.parse(readFileSync(new URL('./fixtures/cards.json', import.meta.url), 'utf8'));
export const byName = new Map();
for (const c of raw) { byName.set(c.name.toLowerCase(), c); for (const f of c.card_faces || []) byName.set(f.name.toLowerCase(), c); }
export const card = (name, count = 1) => normalizeCard(byName.get(name.toLowerCase()), count);
export const standard = getFormat('standard');
export const izzetText = readFileSync(new URL('./fixtures/izzet.txt', import.meta.url), 'utf8');

// A spell with an arbitrary cost, for building toy decks.
export function spell(name, manaCost, cmc, count, extra = {}) {
  return normalizeCard({ name, mana_cost: manaCost, cmc, type_line: extra.type || 'Creature — Test', oracle_text: extra.text || '', legalities: { standard: 'legal' } }, count);
}
export { basicLandDef };
