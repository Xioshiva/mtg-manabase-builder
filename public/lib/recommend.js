// Starting-point recommendations: land count from Karsten's formula, and how many
// sources of each color the spells need, from the hypergeometric distribution.
import { COLOR_ORDER, COLOR_BITS, popcount } from './mana.js';
import { basicLandDef, landColors } from './cards.js';

export function deckStats(cards) {
  let spells = 0, cmcSum = 0, cheap = 0, mdfc = 0, lands = 0, nonLandMana = 0;
  for (const d of cards) {
    if (!d.count) continue;
    if (d.land) { lands += d.count; continue; }
    if (!d.spell || d.filler) continue;
    spells += d.count;
    cmcSum += d.count * d.spell.cmc;
    if (d.spell.cmc <= 2 && (d.spell.effect || d.producesManaNonLand)) cheap += d.count;
    if (d.mdfcLand) mdfc += d.count;
    if (d.producesManaNonLand) nonLandMana += d.count;
  }
  return { spells, lands, avgCmc: spells ? cmcSum / spells : 0, cheapDrawOrRamp: cheap, mdfc, nonLandMana };
}

export function recommendLandCount(format, stats) {
  const exact = format.landFormula(stats.avgCmc, stats.cheapDrawOrRamp);
  // Spell//land MDFCs act like roughly half a land each.
  const withMdfc = exact - 0.5 * stats.mdfc;
  return { exact, count: Math.round(withMdfc), mdfcCredit: 0.5 * stats.mdfc };
}

const logFact = [0];
for (let i = 1; i <= 200; i++) logFact[i] = logFact[i - 1] + Math.log(i);
const logC = (n, k) => (k < 0 || k > n ? -Infinity : logFact[n] - logFact[k] - logFact[n - k]);

// P(at least `need` colored sources | at least `landsNeeded` lands) among `seen` cards.
export function sourceProbability(deckSize, lands, sources, seen, need, landsNeeded) {
  let joint = 0, cond = 0;
  const total = logC(deckSize, seen);
  for (let a = 0; a <= Math.min(sources, seen); a++) {
    for (let b = 0; b <= Math.min(lands - sources, seen - a); b++) {
      if (a + b < landsNeeded) continue;
      const p = Math.exp(logC(sources, a) + logC(lands - sources, b) + logC(deckSize - lands, seen - a - b) - total);
      cond += p;
      if (a >= need) joint += p;
    }
  }
  return cond ? joint / cond : 0;
}

export function sourcesNeeded(format, landCount, cards, target = 0.9) {
  const need = { W: 0, U: 0, B: 0, R: 0, G: 0 };
  const why = {};
  for (const d of cards) {
    if (!d.count || !d.spell || d.filler) continue;
    const turn = Math.min(7, Math.max(1, Math.round(d.spell.cmc)));
    for (const c of COLOR_ORDER) {
      const k = d.spell.cost.pips.filter((p) => p === COLOR_BITS[c]).length;
      if (!k) continue;
      const seen = format.handSize + turn - 1;
      let s = k;
      while (s < landCount && sourceProbability(format.deckSize, landCount, s, seen, k, turn) < target) s++;
      if (s > need[c]) { need[c] = s; why[c] = `${d.name}: ${('{' + c + '}').repeat(k)} on turn ${turn}`; }
    }
  }
  return { need, why };
}

export function countSources(cards) {
  const have = { W: 0, U: 0, B: 0, R: 0, G: 0 };
  for (const d of cards) {
    if (!d.count || !d.land) continue;
    const m = landColors(d.land);
    for (const c of COLOR_ORDER) if (m & COLOR_BITS[c]) have[c] += d.count;
  }
  return have;
}

// Fill `basics` slots one at a time with the color furthest below its need.
export function splitBasics(cards, basics, need, demand) {
  const have = countSources(cards);
  const colors = COLOR_ORDER.filter((c) => demand[c] > 0);
  const out = Object.fromEntries(colors.map((c) => [c, 0]));
  if (!colors.length) return out;
  const totalDemand = colors.reduce((a, c) => a + demand[c], 0);
  for (let i = 0; i < basics; i++) {
    let best = colors[0], bestScore = -Infinity;
    for (const c of colors) {
      const deficit = need[c] - have[c];
      const share = demand[c] / totalDemand - (have[c] / Math.max(1, basics));
      const score = deficit > 0 ? 1000 + deficit : share;
      if (score > bestScore) { bestScore = score; best = c; }
    }
    out[best]++; have[best]++;
  }
  return out;
}

export function ensureBasics(cards, colors) {
  for (const c of colors) {
    if (!cards.some((d) => d.basicColor === c || (d.land && d.land.isBasic && d.land.mask === COLOR_BITS[c]))) {
      cards.push(basicLandDef(c, 0));
    }
  }
  for (const d of cards) {
    if (d.land && d.land.isBasic && popcount(d.land.mask) === 1 && !d.basicColor) {
      d.basicColor = COLOR_ORDER.find((c) => d.land.mask === COLOR_BITS[c]);
    }
  }
  return cards;
}
