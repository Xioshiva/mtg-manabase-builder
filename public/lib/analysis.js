// Ties everything together: card data + parsed list -> recommendation + simulations.
import { normalizeCard, basicLandDef, isBasicName, BASIC_BY_COLOR, describeEffect, landSummary, landColors } from './cards.js';
import { COLOR_ORDER, COLOR_BITS } from './mana.js';
import { simulate, colorDemand } from './sim.js';
import { deckStats, recommendLandCount, sourcesNeeded, countSources, splitBasics, ensureBasics } from './recommend.js';
import { optimizeLands, landCountSweep, pickCandidates } from './optimize.js';
import { cardKey } from './decklist.js';

// parsed: output of parseDecklist; cardData: Map(cardKey(name) -> Scryfall card)
export function buildModel(parsed, cardData, format) {
  const cards = [];
  const unknown = [];
  const illegal = [];
  const warnings = [];
  const entries = [...parsed.main, ...(parsed.commander || [])];
  for (const { name, count } of entries) {
    const sc = cardData.get(cardKey(name));
    if (!sc) {
      const basic = Object.entries(BASIC_BY_COLOR).find(([, n]) => n.toLowerCase() === name.toLowerCase());
      if (basic) { cards.push(basicLandDef(basic[0], count)); continue; }
      unknown.push(name);
      continue;
    }
    const def = normalizeCard(sc, count);
    if (format.legalityKey && sc.legalities && !['legal', 'restricted'].includes(sc.legalities[format.legalityKey]) && !isBasicName(def.name)) {
      illegal.push(def.name);
    }
    if (count > format.maxCopies && !(def.land && def.land.isBasic) && !/any number of cards named/i.test(sc.oracle_text || '')) {
      warnings.push(`${def.name}: ${count} copies (format allows ${format.maxCopies})`);
    }
    cards.push(def);
  }
  const total = cards.reduce((a, d) => a + d.count, 0);
  if (total !== format.deckSize) warnings.push(`Deck has ${total} cards; ${format.name} decks are usually ${format.deckSize}.`);
  return { model: { cards, format }, unknown, illegal, warnings };
}

export function deckColors(cards) {
  const demand = colorDemand(cards);
  return COLOR_ORDER.filter((c) => demand[c] > 0);
}

function landRows(cards) {
  return cards
    .filter((d) => d.land && d.count > 0)
    .map((d) => {
      const m = landColors(d.land, { restricted: true });
      const colors = [...COLOR_ORDER, 'C'].filter((c) => m & COLOR_BITS[c]).join('');
      return { name: d.name, count: d.count, colors, how: landSummary(d.land), notes: d.notes };
    })
    .sort((a, b) => b.count - a.count);
}

// mode: 'analyze' keeps the deck's lands as the starting point;
// 'build' throws the lands away and starts from basics at the recommended count.
// candidateCards: extra Scryfall land cards the optimizer may use.
export function runAnalysis({ model, mode = 'analyze', candidateCards = [], games = 4000, play = 'both', optimize = true, landCount: landOverride, onProgress = () => {} }) {
  const format = model.format;
  let cards = model.cards.map((d) => ({ ...d }));
  const colors = deckColors(cards);
  const stats = deckStats(cards);
  const rec = recommendLandCount(format, stats);
  const demand = colorDemand(cards);

  const drawSpells = cards.filter((d) => d.spell && d.spell.effect).map((d) => ({ name: d.name, count: d.count, cmc: d.spell.cmc, effect: describeEffect(d.spell.effect) }));
  const notes = [];
  for (const d of cards) for (const n of d.notes) notes.push(`${d.name}: ${n}`);

  const known = new Set(cards.map((d) => d.name));
  for (const sc of candidateCards) {
    if (known.has(sc.name)) continue;
    const def = normalizeCard(sc, 0);
    if (def.land) { cards.push(def); known.add(def.name); }
  }
  ensureBasics(cards, colors);

  const currentLands = cards.reduce((a, d) => a + (d.land ? d.count : 0), 0);
  let landCount = landOverride || (mode === 'build' || currentLands === 0 ? rec.count : currentLands);
  const need = sourcesNeeded(format, landCount, cards);

  let current = null;
  const userCards = cards.map((d) => ({ ...d }));
  if (currentLands > 0) {
    onProgress({ stage: 'Simulating your manabase' });
    current = { lands: landRows(userCards), sources: countSources(userCards), sim: simulate({ cards: userCards, format }, { games, play }) };
  }

  // Starting point for the search.
  if (mode === 'build' || currentLands === 0) {
    for (const d of cards) if (d.land) d.count = 0;
    // Start with the best-looking duals (4 each), then fill the rest with basics.
    let nonbasic = 0;
    if (colors.length > 1) {
      const cap = Math.floor(landCount * (colors.length === 2 ? 0.5 : 0.7));
      for (const i of pickCandidates(cards, colors, 12)) {
        const n = Math.min(format.maxCopies, cap - nonbasic);
        if (n <= 0) break;
        cards[i].count = n;
        nonbasic += n;
      }
    }
    const basics = splitBasics(cards, landCount - nonbasic, need.need, demand);
    for (const c of Object.keys(basics)) cards.find((d) => d.basicColor === c).count = basics[c];
  } else if (landOverride && landOverride !== currentLands) {
    // Adjust land count with basics before searching.
    const delta = landOverride - currentLands;
    const basics = splitBasics(cards.map((d) => (d.land && d.land.isBasic ? { ...d, count: 0 } : d)), Math.max(0, delta), need.need, demand);
    for (const c of Object.keys(basics)) cards.find((d) => d.basicColor === c).count += basics[c];
    for (let k = 0; k < -delta; k++) {
      const b = cards.filter((d) => d.basicColor && d.count > 0).sort((x, y) => y.count - x.count)[0];
      if (b) b.count--;
    }
  }

  let suggested = null;
  if (optimize) {
    onProgress({ stage: 'Searching for a better manabase' });
    const result = optimizeLands({ cards, format }, {
      deckColors: colors, maxCopies: format.maxCopies, play,
      onProgress: (p) => onProgress({ stage: 'Searching for a better manabase', ...p }),
    });
    cards = result.cards;
    onProgress({ stage: 'Checking the suggested manabase' });
    suggested = { lands: landRows(cards), sources: countSources(cards), sim: simulate({ cards, format }, { games, play }), history: result.history };
  }

  onProgress({ stage: 'Comparing land counts' });
  const sweep = landCountSweep({ cards, format }, [-2, -1, 0, 1, 2], { games: Math.min(games, 3000), play });

  return {
    format: format.name,
    colors,
    stats,
    recommendedLands: rec,
    landCount,
    currentLands,
    sourcesNeeded: need,
    drawSpells,
    notes,
    current,
    suggested,
    sweep,
  };
}
