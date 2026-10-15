// The nonbasic lands worth offering a deck: duals (and better) in its colors, and
// fetches that can find two or more of them, most useful first.
import { COLOR_ORDER, COLOR_BITS, popcount } from './mana.js';
import { normalizeCard, landColors, landSummary } from './cards.js';
import { candidateQuality } from './optimize.js';

function deckMaskOf(deckColors) {
  return COLOR_ORDER.reduce((m, c) => ((deckColors || []).includes(c) ? m | COLOR_BITS[c] : m), 0);
}

// Deck colors in the mask, in WUBRG order: 10 -> 'UR'.
function colorString(mask) {
  return COLOR_ORDER.filter((c) => mask & COLOR_BITS[c]).join('');
}

// scryfallLands: Scryfall land cards (from searchLands), deckColors: ['U', 'R'].
// -> [{ name, card, colors, how, etb, quality }], best first, then by name.
export function landOptions(scryfallLands, deckColors) {
  const deckMask = deckMaskOf(deckColors);
  if (popcount(deckMask) < 2) return [];
  const out = [];
  const seen = new Set();
  for (const card of scryfallLands || []) {
    if (!card || seen.has(card.name)) continue;
    const land = normalizeCard(card).land;
    if (!land || land.isBasic) continue;
    // landColors counts what a fetch can find, so fetches for two deck colors pass too.
    const mask = landColors(land) & deckMask;
    if (popcount(mask) < 2) continue;
    seen.add(card.name);
    // The search's prior gives fetches a bonus; when listing lands, real duals come first.
    const quality = candidateQuality(land, deckMask) - (land.fetch ? 1.5 : 0);
    out.push({ name: card.name, card, colors: colorString(mask), how: landSummary(land), etb: land.etb, quality });
  }
  return out.sort((a, b) => b.quality - a.quality || a.name.localeCompare(b.name));
}

// The options that can make that color, in the same order.
export function landsForColor(options, color) {
  return options.filter((o) => o.colors.includes(color));
}
