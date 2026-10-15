// Hill-climbing search over the land slots. Each step tries swapping one land for
// another (basic for basic, basic for a dual, ...) and keeps the swap that scores
// best in simulation. All candidates are simulated on the same shuffles (same seed)
// so differences come from the lands, not from luck. `sim` (see pool.js) runs the
// simulations, on several threads when it can.
import { score, landsWanted } from './sim.js';
import { inlineSimulator } from './pool.js';
import { COLOR_ORDER, COLOR_BITS, popcount } from './mana.js';
import { landColors } from './cards.js';

function cloneCards(cards) {
  return cards.map((d) => ({ ...d }));
}

export function landMaskOf(L) {
  return landColors(L);
}

// Rough prior so the search tries the most promising duals first.
export function candidateQuality(L, deckMask) {
  const useful = popcount(landMaskOf(L) & deckMask);
  const etb = { untapped: 3, shock: 3, fast: 2.5, earlyTurns: 2.5, slow: 2, check: 2, reveal: 2, basic: 2, controlPerm: 1.5, behold: 1.5, lowLife: 1.2, multiplayer: 1, tapped: 1, unknown: 0.5 }[L.etb] ?? 1;
  return useful * 10 + etb + (L.surveil ? 0.5 : 0) + (L.fetch ? 1 : 0);
}

export function pickCandidates(cards, deckColors, max = 10) {
  const deckMask = deckColors.reduce((m, c) => m | COLOR_BITS[c], 0);
  const scored = [];
  for (let i = 0; i < cards.length; i++) {
    const d = cards[i];
    if (!d.land || d.land.isBasic) continue;
    const m = landMaskOf(d.land);
    const useful = popcount(m & deckMask);
    if (useful < 2 && !(d.land.fetch && deckColors.length > 1)) continue;
    scored.push({ i, q: candidateQuality(d.land, deckMask) + (d.count ? 100 : 0) });
  }
  scored.sort((a, b) => b.q - a.q);
  return scored.slice(0, max).map((s) => s.i);
}

export async function optimizeLands(model, opts = {}) {
  const {
    games = 4000, quickGames = 400, seed = 777, maxIter = 30, maxCopies = 4,
    minGain = 0.003, // about two standard errors of a paired comparison at 4000 games
    deckColors = [], onProgress = () => {}, play = 'both', turns = 7, sim = inlineSimulator,
  } = opts;
  const cards = cloneCards(model.cards);
  const flex = new Set();
  cards.forEach((d, i) => { if (d.land && !d.locked && (d.land.isBasic || d.count > 0)) flex.add(i); });
  for (const i of pickCandidates(cards, deckColors, opts.maxCandidates ?? 10)) if (!cards[i].locked) flex.add(i);
  const flexList = [...flex];
  const cap = (i) => (cards[i].land.isBasic ? Infinity : maxCopies);
  // Moves are screened on one set of shuffles and confirmed on another, so a move
  // that only looked good by luck in the screen doesn't get accepted.
  const evalMoves = async (moves, n, sd) => {
    const variants = moves.map(([from, to]) => {
      const counts = cards.map((d) => d.count);
      if (from >= 0) { counts[from]--; counts[to]++; }
      return counts;
    });
    return (await sim.simulateMany({ ...model, cards }, variants, { games: n, seed: sd, play, turns })).map(score);
  };
  const confirmSeed = seed + 1;

  let [current] = await evalMoves([[-1, -1]], games, confirmSeed);
  const start = current;
  const history = [];
  // Bounded by steps, not time, so a slow machine or fewer threads still finds the same lands.
  for (let iter = 0; iter < maxIter; iter++) {
    const moves = [];
    for (const from of flexList) {
      if (!cards[from].count) continue;
      for (const to of flexList) {
        if (to === from || cards[to].count >= cap(to)) continue;
        const tl = cards[to].land;
        if (tl.isBasic && !deckColors.some((c) => tl.mask === COLOR_BITS[c])) continue;
        moves.push([from, to]);
      }
    }
    const quickScores = await evalMoves(moves, quickGames, seed);
    const quick = moves.map(([from, to], k) => ({ from, to, s: quickScores[k] }));
    quick.sort((a, b) => b.s - a.s);
    const top = quick.slice(0, 3);
    const confirmed = await evalMoves(top.map((m) => [m.from, m.to]), games, confirmSeed);
    let best = null;
    top.forEach((m, k) => { if (!best || confirmed[k] > best.s) best = { ...m, s: confirmed[k] }; });
    onProgress({ iter: iter + 1, maxIter, score: current });
    if (!best || best.s <= current + minGain) break;
    cards[best.from].count--; cards[best.to].count++;
    history.push({ out: cards[best.from].name, in: cards[best.to].name, score: best.s });
    current = best.s;
  }
  return { cards, startScore: start, finalScore: current, history };
}

// Re-run the deck with a few more or fewer lands. Extra lands replace the most
// expensive spell; fewer lands are replaced by a colorless two-mana filler spell.
export async function landCountSweep(model, deltas, opts = {}) {
  const tried = [];
  const wantLands = landsWanted(model.cards);
  const filler = {
    name: '(filler spell)', filler: true, count: 0, land: null, mdfcLand: null, notes: [],
    spell: { cost: { generic: 2, pips: [], twobrid: [], x: 0 }, cmc: 2, isCreature: true, effect: null },
  };
  const base = [...cloneCards(model.cards), filler];
  for (const delta of deltas) {
    const cards = cloneCards(base);
    const fillerIdx = cards.length - 1;
    const basics = () => cards.map((d, i) => i).filter((i) => cards[i].land && cards[i].land.isBasic && cards[i].basicColor);
    let ok = true;
    for (let k = 0; k < Math.abs(delta); k++) {
      if (delta > 0) {
        const b = basics();
        if (!b.length) { ok = false; break; }
        b.sort((x, y) => cards[x].count - cards[y].count);
        cards[b[b.length - 1]].count++;
        let worst = -1;
        cards.forEach((d, i) => {
          if (d.spell && !d.filler && d.count > 0 && (worst < 0 || d.spell.cmc > cards[worst].spell.cmc)) worst = i;
        });
        if (worst < 0) { ok = false; break; }
        cards[worst].count--;
      } else {
        const b = basics().filter((i) => cards[i].count > 0);
        if (!b.length) { ok = false; break; }
        b.sort((x, y) => cards[y].count - cards[x].count);
        cards[b[0]].count--;
        cards[fillerIdx].count++;
      }
    }
    if (!ok) continue;
    tried.push({ delta, lands: cards.reduce((a, d) => a + (d.land ? d.count : 0), 0), counts: cards.map((d) => d.count) });
  }
  const sim = opts.sim ?? inlineSimulator;
  const results = await sim.simulateMany({ ...model, cards: base }, tried.map((t) => t.counts), {
    games: opts.games ?? 3000, seed: opts.seed ?? 99, play: opts.play ?? 'both', turns: opts.turns ?? 7, wantLands,
  });
  return tried.map(({ delta, lands }, k) => {
    const r = results[k];
    return {
      delta, lands,
      castOnCurve: r.castOnCurve,
      fourthLandOnTurn4: r.turns[3] ? r.turns[3].hitLandDrop : 0,
      floodRate: r.floodRate,
      manaSpent: r.manaSpent,
    };
  });
}
