// Ties everything together: card data + parsed list -> recommendation + simulations.
import { normalizeCard, basicLandDef, isBasicName, BASIC_BY_COLOR, describeEffect, landSummary, landColors } from './cards.js';
import { COLOR_ORDER, COLOR_BITS } from './mana.js';
import { colorDemand } from './sim.js';
import { inlineSimulator } from './pool.js';
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

// A decklist name means a card when it is the card's full name or, for a double-faced
// card ("Front // Back"), its front face.
const frontOf = (d) => d.frontName || d.name.split(' // ')[0];
export function matchesName(d, name) {
  const k = cardKey(name);
  return cardKey(d.name) === k || cardKey(frontOf(d)) === k;
}

// Indexes of the lands in `cards` that `names` (a list or Set of decklist names) locks.
export function lockedLandIndexes(cards, names) {
  const keys = new Set([...names].map(cardKey));
  const out = [];
  cards.forEach((d, i) => { if (d.land && (keys.has(cardKey(d.name)) || keys.has(cardKey(frontOf(d))))) out.push(i); });
  return out;
}

// mode: 'analyze' keeps the deck's lands as the starting point;
// 'build' throws the lands away and starts from basics at the recommended count.
// candidateCards: extra Scryfall land cards the optimizer may use.
// keepUtility: in 'analyze' mode, lands that do more than make mana (creature lands,
// card draw, graveyard hate, ...) stay as they are, since the simulator can't value that.
// lockedLands: names of lands the user locked; they keep their decklist counts in both
// modes and the search never swaps them.
// sim: where the simulations run (see pool.js); by default on this thread.
export async function runAnalysis({ model, mode = 'analyze', candidateCards = [], games = 4000, play = 'both', optimize = true, keepUtility = true, lockedLands = [], landCount: landOverride, onProgress = () => {}, sim = inlineSimulator }) {
  const simulateOne = async (cs) => (await sim.simulateMany({ cards: cs, format: model.format }, [null], { games, play }))[0];
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
  let need = sourcesNeeded(format, landCount, cards);

  let current = null;
  const userCards = cards.map((d) => ({ ...d }));
  if (currentLands > 0) {
    onProgress({ stage: 'Simulating your manabase' });
    current = { lands: landRows(userCards), sources: countSources(userCards), sim: await simulateOne(userCards) };
  }

  // Locked lands keep their counts; only the deck's own lands can be locked.
  const locks = lockedLandIndexes(cards.slice(0, model.cards.length), lockedLands);
  for (const i of locks) cards[i].locked = true;
  const fixed = locks.reduce((a, i) => a + cards[i].count, 0);
  // Basics are only added to colors that have an unlocked basic.
  const freeBasic = (c) => cards.find((d) => d.basicColor === c && !d.locked);
  const freeDemand = { ...demand };
  for (const c of COLOR_ORDER) if (!freeBasic(c)) freeDemand[c] = 0;

  // Starting point for the search.
  if (mode === 'build' || currentLands === 0) {
    for (const d of cards) if (d.land && !d.locked) d.count = 0;
    // Start with the best-looking duals (4 each), then fill the rest with basics.
    // Locked nonbasics count toward the dual cap, and all locked lands toward the land count.
    let nonbasic = locks.reduce((a, i) => a + (cards[i].land.isBasic ? 0 : cards[i].count), 0);
    let picked = 0;
    if (colors.length > 1) {
      const cap = Math.floor(landCount * (colors.length === 2 ? 0.5 : 0.7));
      for (const i of pickCandidates(cards, colors, 12 + locks.length)) {
        if (cards[i].locked) continue;
        const n = Math.min(format.maxCopies, cap - nonbasic, landCount - fixed - picked);
        if (n <= 0) break;
        cards[i].count = n;
        nonbasic += n;
        picked += n;
      }
    }
    const basics = splitBasics(cards, Math.max(0, landCount - fixed - picked), need.need, freeDemand);
    for (const c of Object.keys(basics)) freeBasic(c).count += basics[c];
  } else if (landOverride && landOverride !== currentLands) {
    // Adjust land count with unlocked basics before searching.
    const delta = landOverride - currentLands;
    const basics = splitBasics(cards.map((d) => (d.land && d.land.isBasic && !d.locked ? { ...d, count: 0 } : d)), Math.max(0, delta), need.need, freeDemand);
    for (const c of Object.keys(basics)) freeBasic(c).count += basics[c];
    for (let k = 0; k < -delta; k++) {
      const b = cards.filter((d) => d.basicColor && d.count > 0 && !d.locked).sort((x, y) => y.count - x.count)[0];
      if (b) b.count--;
    }
  }

  // Locked basics can leave no basic to take the remaining slots (or to cut): use the
  // other unlocked lands, the deck's own first, and say so if even that falls short.
  const landTotal = () => cards.reduce((a, d) => a + (d.land ? d.count : 0), 0);
  let off = landCount - landTotal();
  if (off !== 0) {
    const own = new Map(model.cards.filter((d) => d.land).map((d) => [d.name, d.count]));
    const rank = new Map(pickCandidates(cards, colors, cards.length).map((i, k) => [i, k]));
    const usable = cards.map((d, i) => i).filter((i) => {
      const d = cards[i];
      return d.land && !d.locked && (own.get(d.name) > 0 || rank.has(i) || (d.basicColor && colors.includes(d.basicColor)));
    });
    usable.sort((a, b) => (own.get(cards[b].name) || 0) - (own.get(cards[a].name) || 0) || (rank.get(a) ?? 1e9) - (rank.get(b) ?? 1e9));
    const cap = (d) => (d.land.isBasic ? Infinity : format.maxCopies);
    while (off > 0) {
      const i = usable.find((j) => cards[j].count < cap(cards[j]));
      if (i === undefined) break;
      cards[i].count++; off--;
    }
    while (off < 0) {
      const i = usable.filter((j) => cards[j].count > 0).sort((a, b) => cards[b].count - cards[a].count)[0];
      if (i === undefined) break;
      cards[i].count--; off++;
    }
    if (off !== 0) {
      notes.push(off < 0
        ? `Your locked lands add up to ${landTotal()} lands, more than the ${landCount} asked for. Unlock one to play fewer.`
        : `Only ${landTotal()} lands fit around your locked lands, not ${landCount}. Unlock one to play more.`);
      landCount = landTotal();
      need = sourcesNeeded(format, landCount, cards);
    }
  }

  // Utility lands the user didn't lock themselves.
  const kept = [];
  if (keepUtility && mode !== 'build') {
    for (const d of cards) if (d.land && d.land.utility && d.count > 0 && !d.locked) { d.locked = true; kept.push(d.name); }
  }
  const locked = locks.map((i) => cards[i].name);

  let suggested = null;
  if (optimize) {
    onProgress({ stage: 'Searching for a better manabase' });
    const result = await optimizeLands({ cards, format }, {
      deckColors: colors, maxCopies: format.maxCopies, play, sim,
      onProgress: (p) => onProgress({ stage: 'Searching for a better manabase', ...p }),
    });
    cards = result.cards;
    onProgress({ stage: 'Checking the suggested manabase' });
    suggested = { lands: landRows(cards), sources: countSources(cards), sim: await simulateOne(cards), history: result.history, kept, locked };
  }

  onProgress({ stage: 'Comparing land counts' });
  const sweep = await landCountSweep({ cards, format }, [-2, -1, 0, 1, 2], { games: Math.min(games, 3000), play, sim });

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
