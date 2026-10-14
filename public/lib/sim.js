// Monte Carlo goldfish simulator. Each game: shuffle, London mulligan, then for each
// turn draw, play the best land, cast draw/selection spells to dig, and cast the
// biggest spells the lands can pay for. It measures land drops, whether each spell
// could be cast on curve, and how much mana actually got used.
import { makeRng, shuffle } from './rng.js';
import { payCost, popcount, COLOR_ORDER, COLOR_BITS } from './mana.js';

export function colorDemand(cards) {
  const demand = { W: 0, U: 0, B: 0, R: 0, G: 0 };
  for (const d of cards) {
    if (!d.spell || d.filler) continue;
    for (const p of [...d.spell.cost.pips, ...d.spell.cost.twobrid]) {
      const cs = COLOR_ORDER.filter((c) => p & COLOR_BITS[c]);
      for (const c of cs) demand[c] += d.count / cs.length;
    }
  }
  return demand;
}

export function landsWanted(cards) {
  let maxCmc = 0;
  for (const d of cards) if (d.count && d.spell && !d.filler) maxCmc = Math.max(maxCmc, d.spell.cmc);
  return Math.max(3, Math.min(6, maxCmc));
}

export function simulate(model, opts = {}) {
  const turns = opts.turns ?? 7;
  const games = opts.games ?? 4000;
  const mode = opts.play ?? 'both';
  const rng = makeRng(opts.seed ?? 12345);
  const defs = model.cards;
  const fmt = model.format;
  const handSize = fmt.handSize ?? 7;
  const keepRanges = fmt.keepRanges ?? { 7: [2, 5], 6: [2, 4], 5: [1, 4] };

  const deckList = [];
  defs.forEach((d, i) => { for (let k = 0; k < d.count; k++) deckList.push(i); });
  const landish = defs.map((d) => !!(d.land || d.mdfcLand));
  const tracked = [];
  defs.forEach((d, i) => { if (d.count > 0 && d.spell && !d.filler && d.spell.cmc >= 1 && d.spell.cmc <= turns) tracked.push(i); });
  const trackedSet = new Uint8Array(defs.length);
  for (const i of tracked) trackedSet[i] = 1;
  const seenTurn = new Int32Array(defs.length);
  const demand = colorDemand(defs);
  const demandBits = new Float64Array(64);
  for (const c of COLOR_ORDER) demandBits[COLOR_BITS[c]] = demand[c];
  let maxCmc = 0;
  for (const d of defs) if (d.count && d.spell && !d.filler) maxCmc = Math.max(maxCmc, d.spell.cmc);
  const wantLands = opts.wantLands ?? Math.max(3, Math.min(6, maxCmc));
  const floodAt = wantLands + 4;

  const st = {
    games, turns,
    mulligans: 0, cardsKept: 0,
    hitDrop: new Float64Array(turns + 1),
    lands: new Float64Array(turns + 1),
    spent: new Float64Array(turns + 1),
    drawSpellsCast: 0, extraCards: 0, flood: 0, mdfcAsLand: 0, life: 0, spentSq: 0,
    inHand: new Float64Array(defs.length),
    onCurve: new Float64Array(defs.length),
    enough: new Float64Array(defs.length),
    onCurveGivenEnough: new Float64Array(defs.length),
  };

  let lib, hand, bf, turn;

  const isLandIdx = (ci) => landish[ci];
  const landsInHand = () => { let n = 0; for (const ci of hand) if (landish[ci]) n++; return n; };
  const needLand = (extra = 0) => bf.length + landsInHand() + extra < Math.min(wantLands, turn + 2);

  function landMask(x) {
    let m = x.mask;
    for (const cd of x.L.cond) {
      for (const y of bf) if (y.types & cd.types) { m |= cd.mask; break; }
    }
    return m;
  }

  function entersTapped(L) {
    switch (L.etb) {
      case 'untapped': case 'shock': return false;
      case 'fast': return bf.length > 2;
      case 'slow': return bf.length < 2;
      case 'basic': return !bf.some((x) => x.isBasic);
      case 'check': return !bf.some((x) => x.types & L.etbTypes);
      case 'reveal': return !hand.some((ci) => defs[ci].land && (defs[ci].land.types & L.etbTypes));
      case 'multiplayer': return !fmt.multiplayer;
      default: return true;
    }
  }

  function untappedSources() {
    const out = [];
    for (const x of bf) if (!x.tapped) out.push(landMask(x));
    return out;
  }

  function drawCards(n) {
    for (let k = 0; k < n && lib.length; k++) hand.push(lib.pop());
  }

  function bottom(ci) { lib.unshift(ci); }

  // Keep a card on top when it's what we need: lands while short, spells otherwise.
  function select(n) {
    const seen = [];
    for (let k = 0; k < n && lib.length; k++) seen.push(lib.pop());
    const keep = [];
    let extra = 0;
    for (const ci of seen) {
      if (isLandIdx(ci)) {
        if (needLand(extra)) { keep.push(ci); extra++; } else bottom(ci);
      } else if (!needLand(extra) || keep.length) keep.push(ci);
      else bottom(ci);
    }
    for (let k = keep.length - 1; k >= 0; k--) lib.push(keep[k]);
  }

  function dig(n, take, filter) {
    const seen = [];
    for (let k = 0; k < n && lib.length; k++) seen.push(lib.pop());
    const ok = (ci) => {
      if (!filter) return true;
      const d = defs[ci];
      if (landish[ci] && filter.includes('land')) return true;
      if (d.spell && d.spell.isCreature && filter.includes('creature')) return true;
      if (d.spell && !d.spell.isCreature && filter.includes('noncreature')) return true;
      return false;
    };
    for (let t = 0; t < take; t++) {
      const wantLand = needLand();
      let pick = -1;
      for (let k = 0; k < seen.length; k++) {
        if (!ok(seen[k])) continue;
        if (pick < 0 || (isLandIdx(seen[k]) === wantLand && isLandIdx(seen[pick]) !== wantLand)) pick = k;
      }
      if (pick < 0) break;
      hand.push(seen[pick]);
      seen.splice(pick, 1);
    }
    for (const ci of seen) bottom(ci);
  }

  function discard(n) {
    for (let k = 0; k < n && hand.length; k++) {
      let pick = -1;
      const tooMany = !needLand();
      for (let i = 0; i < hand.length; i++) {
        const ci = hand[i];
        if (tooMany && defs[ci].land) { pick = i; break; }
        if (!defs[ci].land && (pick < 0 || defs[ci].spell.cmc > defs[hand[pick]].spell.cmc)) pick = i;
      }
      if (pick < 0) pick = 0;
      hand.splice(pick, 1);
    }
  }

  function resolve(e) {
    st.drawSpellsCast++;
    if (e.selectFirst) { if (e.scry) select(e.scry); if (e.surveil) select(e.surveil); }
    if (e.look) dig(e.look, e.take, e.takeFilter);
    drawCards(e.draw);
    st.extraCards += e.draw + (e.look ? e.take : 0) - e.discard;
    if (e.discard) discard(e.discard);
    if (!e.selectFirst) { if (e.scry) select(e.scry); if (e.surveil) select(e.surveil); }
  }

  function bestFetchTarget(types) {
    const have = new Float64Array(64);
    for (const x of bf) for (const c of COLOR_ORDER) if (landMask(x) & COLOR_BITS[c]) have[COLOR_BITS[c]]++;
    let best = -1, bestScore = -1;
    for (let k = 0; k < lib.length; k++) {
      const d = defs[lib[k]];
      if (!d.land || !d.land.isBasic || !(d.land.types & types)) continue;
      const bit = d.land.mask;
      const score = (demandBits[bit] || 0) / (1 + have[bit]);
      if (score > bestScore) { bestScore = score; best = k; }
    }
    return best;
  }

  function maxCastable(sources, skipPos) {
    let best = 0;
    for (let i = 0; i < hand.length; i++) {
      if (i === skipPos) continue;
      const d = defs[hand[i]];
      if (!d.spell || d.spell.cmc <= best || d.spell.cmc > sources.length) continue;
      if (payCost(sources, d.spell.cost)) best = d.spell.cmc;
    }
    return best;
  }

  function chooseAndPlayLand() {
    const current = untappedSources();
    let totalMask = 0;
    for (const x of bf) totalMask |= landMask(x);
    let best = null, bestScore = -Infinity;
    for (let pos = 0; pos < hand.length; pos++) {
      const d = defs[hand[pos]];
      const options = [];
      if (d.land) options.push({ L: d.land, mdfc: false });
      if (d.mdfcLand) options.push({ L: d.mdfcLand, mdfc: true });
      for (const { L, mdfc } of options) {
        let tapped, masks;
        if (L.fetch) {
          const k = bestFetchTarget(L.fetch.types);
          if (k < 0) continue;
          masks = [defs[lib[k]].land.mask];
          tapped = !(L.fetch.untapAt && bf.length + 1 >= L.fetch.untapAt);
        } else {
          tapped = entersTapped(L);
          masks = (L.choices || [0]).map((c) => L.mask | c);
        }
        // Shock-style lands: try both entering tapped for free and paying life.
        const tapOptions = L.etb === 'shock' ? [true, false] : [tapped];
        for (const m of masks) for (tapped of tapOptions) {
          const after = tapped ? current : [...current, m];
          const castNow = maxCastable(after, pos);
          let gain = 0;
          for (const c of COLOR_ORDER) if ((m & COLOR_BITS[c]) && !(totalMask & COLOR_BITS[c])) gain += demand[c] > 0 ? 1 : 0;
          let score = castNow * 100 + gain * 20 + (tapped ? 5 : 0) - (mdfc ? 60 : 0);
          if (L.etb === 'fast' && !tapped) score += 3;
          if (L.etb === 'slow' && tapped) score -= 3;
          if (L.isBasic) score += 1; // keeps duals that care about basics happy later
          if (L.etb === 'shock' && !tapped) score -= 8;
          if (score > bestScore) { bestScore = score; best = { pos, L, mdfc, mask: m, tapped }; }
        }
      }
    }
    if (!best) return false;
    const ci = hand[best.pos];
    hand.splice(best.pos, 1);
    if (best.mdfc) st.mdfcAsLand++;
    if (best.L.fetch) {
      const k = bestFetchTarget(best.L.fetch.types);
      const target = lib[k];
      lib.splice(k, 1);
      shuffle(lib, rng);
      const bl = defs[target].land;
      bf.push({ L: bl, mask: bl.mask, types: bl.types, isBasic: true, tapped: best.tapped, etbTapped: best.tapped });
      return true;
    }
    bf.push({ L: best.L, mask: best.mask, types: best.L.types, isBasic: best.L.isBasic, tapped: best.tapped, etbTapped: best.tapped, ci });
    if (best.L.etb === 'shock' && !best.tapped) st.life += best.L.shockLife;
    if (best.L.surveil) select(best.L.surveil);
    return true;
  }

  function castOne(onlyDraw) {
    const sources = untappedSources();
    if (!sources.length) return 0;
    let pick = -1, pickScore = -Infinity, pay = null;
    for (let i = 0; i < hand.length; i++) {
      const d = defs[hand[i]];
      if (!d.spell || d.spell.cmc > sources.length) continue;
      if (onlyDraw && !d.spell.effect) continue;
      const score = onlyDraw ? -d.spell.cmc : d.spell.cmc * 10 + (d.spell.effect ? 0 : 1);
      if (score <= pickScore) continue;
      const p = payCost(sources, d.spell.cost);
      if (p) { pick = i; pickScore = score; pay = p; }
    }
    if (pick < 0) return 0;
    // map source indices back to battlefield lands
    const untapped = bf.filter((x) => !x.tapped);
    for (const k of pay) { untapped[k].tapped = true; st.life += untapped[k].L.pain; }
    const d = defs[hand[pick]];
    hand.splice(pick, 1);
    if (d.spell.effect) resolve(d.spell.effect);
    return Math.max(d.spell.cmc, pay.length);
  }

  function mulligan() {
    let mulls = 0;
    for (;;) {
      lib = deckList.slice();
      shuffle(lib, rng);
      hand = lib.splice(lib.length - handSize, handSize);
      const charged = fmt.freeMulligan && mulls > 0 ? mulls - 1 : mulls;
      const size = handSize - charged;
      const lands = hand.filter((ci) => landish[ci]).length;
      const range = keepRanges[size];
      if (!range || (lands >= range[0] && lands <= range[1])) {
        for (let k = 0; k < charged; k++) {
          const landCount = hand.filter((ci) => landish[ci]).length;
          let pick = -1;
          if (landCount > Math.ceil((hand.length - 1) / 2)) {
            pick = hand.findIndex((ci) => landish[ci]);
          } else {
            for (let i = 0; i < hand.length; i++) {
              if (landish[hand[i]] && !defs[hand[i]].spell) continue;
              const c = defs[hand[i]].spell ? defs[hand[i]].spell.cmc : 0;
              if (pick < 0 || c > (defs[hand[pick]].spell?.cmc ?? 0)) pick = i;
            }
          }
          if (pick < 0) pick = 0;
          bottom(hand[pick]);
          hand.splice(pick, 1);
        }
        st.mulligans += mulls;
        st.cardsKept += hand.length;
        return;
      }
      mulls++;
    }
  }

  // Batch means: the headline averages mix spells from the same games, which are
  // correlated, so their margin of error comes from the spread across 20 batches.
  const nBatches = games >= 200 ? 20 : 0;
  const batchSize = nBatches ? Math.ceil(games / nBatches) : 0;
  const snap = { inHand: new Float64Array(defs.length), onCurve: new Float64Array(defs.length), enough: new Float64Array(defs.length), given: new Float64Array(defs.length) };
  st.batches = [];
  const closeBatch = () => {
    const d = (a, b) => tracked.map((i) => a[i] - b[i]);
    st.batches.push(weighted(defs, tracked, d(st.inHand, snap.inHand), d(st.onCurve, snap.onCurve), d(st.enough, snap.enough), d(st.onCurveGivenEnough, snap.given)));
    snap.inHand.set(st.inHand); snap.onCurve.set(st.onCurve); snap.enough.set(st.enough); snap.given.set(st.onCurveGivenEnough);
  };

  for (let g = 0; g < games; g++) {
    if (batchSize && g > 0 && g % batchSize === 0) closeBatch();
    const onPlay = mode === 'both' ? g % 2 === 0 : mode === 'play';
    mulligan();
    bf = [];
    seenTurn.fill(0);
    let spentTotal = 0;
    for (turn = 1; turn <= turns; turn++) {
      for (const x of bf) { x.tapped = false; x.etbTapped = false; }
      if (!(onPlay && turn === 1)) drawCards(1);
      let landPlayed = false;
      let spent = 0;
      // No land in hand: try cheap draw spells first to find one.
      while (!landsInHand()) {
        const used = castOne(true);
        if (!used) break;
        spent += used;
      }
      if (landsInHand()) landPlayed = chooseAndPlayLand();

      st.lands[turn] += bf.length;
      if (bf.length >= turn) st.hitDrop[turn]++;
      // For each spell in hand whose mana value equals this turn: could we cast it now?
      const allUntapped = [];
      for (const x of bf) if (!x.etbTapped) allUntapped.push(landMask(x));
      for (const ci of hand) {
        const d = defs[ci];
        if (!d.spell || d.spell.cmc !== turn || seenTurn[ci] === turn || !trackedSet[ci]) continue;
        seenTurn[ci] = turn;
        const enough = bf.length >= turn;
        const ok = allUntapped.length >= turn && payCost(allUntapped, d.spell.cost) !== null;
        st.inHand[ci]++;
        if (enough) st.enough[ci]++;
        if (ok) { st.onCurve[ci]++; if (enough) st.onCurveGivenEnough[ci]++; }
      }

      for (;;) {
        const used = castOne(false);
        if (!used) break;
        spent += used;
        if (!landPlayed && landsInHand()) {
          landPlayed = chooseAndPlayLand();
        }
      }
      spentTotal += spent;
      st.spent[turn] += spentTotal;
    }
    if (bf.length + landsInHand() >= floodAt) st.flood++;
    st.spentSq += spentTotal * spentTotal;
  }

  if (batchSize) closeBatch();
  return summarize(st, defs, tracked, { wantLands, floodAt });
}

// Copy-weighted average of per-spell rates from raw counts (arrays aligned with `tracked`).
function weighted(defs, tracked, inHand, onCurve, enough, given) {
  let w = 0, s = 0, s2 = 0;
  tracked.forEach((i, k) => {
    w += defs[i].count;
    s += defs[i].count * (inHand[k] ? onCurve[k] / inHand[k] : 0);
    s2 += defs[i].count * (enough[k] ? given[k] / enough[k] : 0);
  });
  return { castOnCurve: w ? s / w : 0, colorConsistency: w ? s2 / w : 0 };
}

function batchMoe(batches, key, fallback) {
  if (batches.length < 5) return fallback;
  const xs = batches.map((b) => b[key]);
  const m = xs.reduce((a, c) => a + c, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((a, c) => a + (c - m) ** 2, 0) / (xs.length - 1));
  return 1.96 * sd / Math.sqrt(xs.length);
}

// 95% margin of error for a proportion p measured over n trials.
export function moe(p, n) {
  return n > 0 ? 1.96 * Math.sqrt(Math.max(p * (1 - p), 0) / n) : 1;
}

function summarize(st, defs, tracked, extra) {
  const g = st.games;
  const turnRows = [];
  for (let t = 1; t <= st.turns; t++) {
    const p = st.hitDrop[t] / g;
    turnRows.push({ turn: t, hitLandDrop: p, hitLandDropMoe: moe(p, g), avgLands: st.lands[t] / g, manaSpent: st.spent[t] / g });
  }
  const spells = tracked.map((i) => {
    const onCurve = st.inHand[i] ? st.onCurve[i] / st.inHand[i] : 0;
    const given = st.enough[i] ? st.onCurveGivenEnough[i] / st.enough[i] : 0;
    return {
      name: defs[i].name,
      cmc: defs[i].spell.cmc,
      copies: defs[i].count,
      isDraw: !!defs[i].spell.effect,
      inHand: st.inHand[i] / g,
      // probabilities below are conditional on holding the spell on the turn equal to its mana value
      onCurve,
      onCurveMoe: moe(onCurve, st.inHand[i]),
      samples: st.inHand[i],
      enoughLands: st.inHand[i] ? st.enough[i] / st.inHand[i] : 0,
      onCurveGivenEnough: given,
      onCurveGivenEnoughMoe: moe(given, st.enough[i]),
    };
  });
  // Weighted averages. The independent-spells margin is only a fallback for tiny runs.
  let w = 0, s = 0, s2 = 0, v = 0, v2 = 0;
  for (const sp of spells) {
    w += sp.copies; s += sp.copies * sp.onCurve; s2 += sp.copies * sp.onCurveGivenEnough;
    v += (sp.copies * sp.onCurveMoe) ** 2; v2 += (sp.copies * sp.onCurveGivenEnoughMoe) ** 2;
  }
  const manaSpent = turnRows.length ? turnRows[turnRows.length - 1].manaSpent : 0;
  const spentVar = Math.max(0, st.spentSq / g - manaSpent * manaSpent);
  const flood = st.flood / g;
  const mull = st.mulligans / g;
  return {
    games: g,
    turns: turnRows,
    spells,
    mulliganRate: mull,
    mulliganRateMoe: moe(Math.min(mull, 1), g),
    avgKept: st.cardsKept / g,
    drawSpellsPerGame: st.drawSpellsCast / g,
    extraCardsPerGame: st.extraCards / g,
    floodRate: flood,
    floodRateMoe: moe(flood, g),
    mdfcAsLandPerGame: st.mdfcAsLand / g,
    lifePaidPerGame: st.life / g,
    castOnCurve: w ? s / w : 0,
    castOnCurveMoe: batchMoe(st.batches, 'castOnCurve', w ? Math.sqrt(v) / w : 0),
    colorConsistency: w ? s2 / w : 0,
    colorConsistencyMoe: batchMoe(st.batches, 'colorConsistency', w ? Math.sqrt(v2) / w : 0),
    manaSpent,
    manaSpentMoe: 1.96 * Math.sqrt(spentVar / g),
    ...extra,
  };
}

// Single number used to compare manabases: how often spells are castable on curve,
// plus a small reward for mana actually used (punishes tapped lands and stumbles),
// minus a small cost for life paid to shocks and painlands.
export function score(result) {
  return result.castOnCurve + 0.004 * result.manaSpent - 0.003 * result.lifePaidPerGame;
}
