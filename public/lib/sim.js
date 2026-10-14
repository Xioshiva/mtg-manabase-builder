// Monte Carlo goldfish simulator. Each game: shuffle, London mulligan, then for each
// turn draw, play the best land, cast draw/selection spells to dig, and cast the
// biggest spells the lands can pay for. It measures land drops, whether each spell
// could be cast on curve, and how much mana actually got used.
import { makeRng, shuffle } from './rng.js';
import { payCost, popcount, COLOR_ORDER, COLOR_BITS, ANY_COLOR } from './mana.js';

// A Treasure token: one mana of any color, used up when tapped.
const TREASURE = { mask: ANY_COLOR, cond: [], restricted: [] };

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
  const curveTurn = (d) => d.spell.curveTurn ?? d.spell.cmc;
  defs.forEach((d, i) => { if (d.count > 0 && d.spell && !d.filler && curveTurn(d) >= 1 && curveTurn(d) <= turns) tracked.push(i); });
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

  // bf: lands on the battlefield. perms: nonland permanents we cast or made (for mana and
  // for "unless you control an Equipment"-style checks). Mana sources share one shape:
  // { L, mask, types, isBasic, isLand, tapped, etbTapped, enteredTurn, readyTurn }.
  let lib, hand, bf, perms, turn, pendingDiscard;

  const isLandIdx = (ci) => landish[ci];
  const landsInHand = () => { let n = 0; for (const ci of hand) if (landish[ci]) n++; return n; };
  const needLand = (extra = 0) => bf.length + landsInHand() + extra < Math.min(wantLands, turn + 2);
  const controls = (word) => perms.some((p) => p.typeLine.includes(word)) || hand.some((ci) => (defs[ci].spell?.typeLine || '').toLowerCase().includes(word));

  // Mana a source can make for a spell of `kind` ('creature' | 'spell' | 'other'; null = any).
  function srcMask(x, kind, freeOnly) {
    let m = x.mask;
    for (const cd of x.L.cond) {
      if (cd.basicOrFresh) {
        if (x.enteredTurn === turn || bf.some((y) => y.isBasic)) m |= cd.mask;
      } else {
        for (const y of bf) if (y.types & cd.types) { m |= cd.mask; break; }
      }
    }
    for (const r of x.L.restricted) {
      if (freeOnly && r.life) continue;
      if (r.kind === null || kind === null || r.kind === kind) m |= r.mask;
    }
    return m;
  }

  const ready = (x) => x.isLand ? true : turn >= x.readyTurn;

  // Untapped sources for a spell of `kind`. includeTapped ignores mana already spent this
  // turn (used for the "could you cast it" check, which only cares about what's in play).
  function sourcesFor(kind, includeTapped) {
    const masks = [], refs = [], penalty = [];
    const add = (x) => {
      if (!ready(x) || x.etbTapped || (!includeTapped && x.tapped)) return;
      const m = srcMask(x, kind, false);
      if (!m) return;
      masks.push(m); refs.push(x);
      // Avoid paying life, and keep Treasures for when nothing else will do.
      penalty.push(x.isTreasure ? 2 : x.L.restricted.some((r) => r.life) ? 1 : 0);
    };
    for (const x of bf) add(x);
    for (const x of perms) if (x.isSource) add(x);
    return { masks, refs, penalty };
  }

  const isType = (typeLine, words) => words.some((w) => typeLine.includes(w));
  // Whether the "behold a X" / "sacrifice an X" alternative to the extra mana is available.
  function canSkipExtra(ex, d, skipPos) {
    if (!ex.unlessType) return false;
    const words = [].concat(ex.unlessType);
    if (perms.some((p) => isType(p.typeLine, words))) return true;
    return !!ex.fromHand && hand.some((ci, i) => i !== skipPos && defs[ci] !== d && isType((defs[ci].spell?.typeLine || '').toLowerCase(), words));
  }

  function effectiveCost(d, skipPos) {
    const sp = d.spell;
    const ex = sp.extraCost;
    if (!ex || canSkipExtra(ex, d, skipPos)) return sp.cost;
    return { ...sp.cost, generic: sp.cost.generic + ex.generic, pips: ex.pips?.length ? [...sp.cost.pips, ...ex.pips] : sp.cost.pips };
  }

  function makeTreasures(n) {
    for (let k = 0; k < n; k++) {
      perms.push({ typeLine: 'artifact — treasure', L: TREASURE, mask: ANY_COLOR, types: 0, isBasic: false, isLand: false, isSource: true, isTreasure: true, tapped: false, etbTapped: false, enteredTurn: turn, readyTurn: turn });
    }
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
      case 'earlyTurns': return turn > 3;
      case 'lowLife': return turn < 5;
      case 'controlPerm': return !perms.some((p) => L.etbPerm.split(' ').every((w) => p.typeLine.includes(w)));
      default: return true;
    }
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
      if ((landish[ci] || d.spell?.isPermanent) && filter.includes('permanent')) return true;
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

  function discardRandom(n) {
    for (let k = 0; k < n && hand.length; k++) hand.splice(Math.floor(rng() * hand.length), 1);
  }

  function resolve(e) {
    st.drawSpellsCast++;
    if (e.selectFirst) { if (e.scry) select(e.scry); if (e.surveil) select(e.surveil); }
    const look = e.lookPerLand ? bf.length : e.look;
    if (look) dig(look, e.take, e.takeFilter);
    drawCards(e.draw);
    let discarded = e.discard;
    // "Discard two cards unless you discard a creature card": pitch the priciest creature.
    const creature = e.discardOrCreature ? hand.reduce((b, ci, i) => (defs[ci].spell?.isCreature && !landish[ci] && (b < 0 || defs[ci].spell.cmc > defs[hand[b]].spell.cmc) ? i : b), -1) : -1;
    if (creature >= 0) { hand.splice(creature, 1); discarded = 1; } else if (e.discard) discard(e.discard);
    st.extraCards += e.draw + (look ? e.take : 0) - discarded - (e.delayedDiscard || 0);
    if (e.delayedDiscard) pendingDiscard += e.delayedDiscard;
    if (!e.selectFirst) { if (e.scry) select(e.scry); if (e.surveil) select(e.surveil); }
  }

  function bestFetchTarget(types) {
    const have = new Float64Array(64);
    for (const x of bf) for (const c of COLOR_ORDER) if (srcMask(x, null) & COLOR_BITS[c]) have[COLOR_BITS[c]]++;
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

  // Biggest mana value in hand castable with `extra` (a would-be new source) added.
  function maxCastable(extra, skipPos) {
    let best = 0;
    const cache = {};
    for (let i = 0; i < hand.length; i++) {
      if (i === skipPos) continue;
      const d = defs[hand[i]];
      if (!d.spell || d.spell.cmc <= best) continue;
      const kind = d.spell.kind;
      if (!cache[kind]) {
        const s = sourcesFor(kind, false);
        if (extra) { const m = srcMask(extra, kind, false); if (m) s.masks.push(m); }
        cache[kind] = s.masks;
      }
      if (d.spell.cmc > cache[kind].length) continue;
      if (payCost(cache[kind], effectiveCost(d, skipPos))) best = d.spell.cmc;
    }
    return best;
  }

  function makeLandSource(L, mask, tapped, isBasic) {
    return { L, mask, types: L.choiceSetsType ? mask : L.types, isBasic, isLand: true, tapped, etbTapped: tapped, enteredTurn: turn, readyTurn: 0, isSource: true };
  }

  function chooseAndPlayLand() {
    let totalMask = 0;
    for (const x of bf) totalMask |= srcMask(x, null);
    let best = null, bestScore = -Infinity;
    for (let pos = 0; pos < hand.length; pos++) {
      const d = defs[hand[pos]];
      const options = [];
      if (d.land) options.push({ L: d.land, mdfc: false });
      if (d.mdfcLand) options.push({ L: d.mdfcLand, mdfc: true });
      for (const { L, mdfc } of options) {
        let tapped, masks, fetchedL = null;
        if (L.fetch) {
          const k = bestFetchTarget(L.fetch.types);
          if (k < 0) continue;
          fetchedL = defs[lib[k]].land;
          masks = [fetchedL.mask];
          tapped = !((L.fetch.untapAt && bf.length + 1 >= L.fetch.untapAt) || (L.fetch.untapIfBehold && controls(L.fetch.untapIfBehold)));
        } else {
          tapped = entersTapped(L);
          masks = (L.choices || [0]).map((c) => L.mask | c);
        }
        // Shock-style lands: try both entering tapped for free and paying life.
        const tapOptions = L.etb === 'shock' ? [true, false] : [tapped];
        for (const m of masks) for (tapped of tapOptions) {
          const probe = makeLandSource(fetchedL || L, m, tapped, fetchedL ? true : L.isBasic);
          const castNow = maxCastable(tapped ? null : probe, pos);
          const full = srcMask(probe, null);
          let gain = 0;
          for (const c of COLOR_ORDER) if ((full & COLOR_BITS[c]) && !(totalMask & COLOR_BITS[c])) gain += demand[c] > 0 ? 1 : 0;
          let score = castNow * 100 + gain * 20 + (tapped ? 5 : 0) - (mdfc ? 60 : 0);
          if ((L.etb === 'fast' || L.etb === 'earlyTurns') && !tapped) score += 3;
          if (L.etb === 'slow' && tapped) score -= 3;
          if (L.isBasic) score += 1; // keeps duals that care about basics happy later
          if (L.etb === 'shock' && !tapped) score -= 8;
          if (score > bestScore) { bestScore = score; best = { pos, L, mdfc, mask: m, tapped }; }
        }
      }
    }
    if (!best) return false;
    hand.splice(best.pos, 1);
    if (best.mdfc) st.mdfcAsLand++;
    if (best.L.fetch) {
      const k = bestFetchTarget(best.L.fetch.types);
      const target = lib[k];
      lib.splice(k, 1);
      shuffle(lib, rng);
      st.life += best.L.fetch.life;
      const bl = defs[target].land;
      bf.push(makeLandSource(bl, bl.mask, best.tapped, true));
      return true;
    }
    bf.push(makeLandSource(best.L, best.mask, best.tapped, best.L.isBasic));
    if (best.L.etb === 'shock' && !best.tapped) st.life += best.L.shockLife;
    if (best.L.surveil) select(best.L.surveil);
    return true;
  }

  // Life paid when `x` made mana for pip `pip` using a life-costing ability.
  function lifeFor(x, pip, kind) {
    if (srcMask(x, kind, true) & pip) return 0;
    let cheapest = Infinity;
    for (const r of x.L.restricted) if (r.life && (r.mask & pip) && (r.kind === null || r.kind === kind)) cheapest = Math.min(cheapest, r.life);
    return cheapest === Infinity ? 0 : cheapest;
  }

  function castOne(onlyDraw) {
    const cache = {};
    let pick = -1, pickScore = -Infinity, pay = null, pickSrc = null;
    for (let i = 0; i < hand.length; i++) {
      const d = defs[hand[i]];
      if (!d.spell) continue;
      if (onlyDraw && !d.spell.effect) continue;
      const kind = d.spell.kind;
      const srcs = cache[kind] || (cache[kind] = sourcesFor(kind, false));
      if (d.spell.cmc > srcs.masks.length) continue;
      const score = onlyDraw ? -d.spell.cmc : d.spell.cmc * 10 + (d.spell.effect ? 0 : 1) + (d.spell.mana ? 5 : 0);
      if (score <= pickScore) continue;
      const p = payCost(srcs.masks, effectiveCost(d, i), srcs.penalty);
      if (p) { pick = i; pickScore = score; pay = p; pickSrc = srcs; }
    }
    if (pick < 0) return 0;
    const d = defs[hand[pick]];
    const sp = d.spell;
    const sacrifice = sp.extraCost?.sacrifice && canSkipExtra(sp.extraCost, d, pick);
    pay.forEach((k, n) => {
      const x = pickSrc.refs[k];
      x.tapped = true;
      if (n < pay.pipFor.length) st.life += lifeFor(x, pay.pipFor[n], sp.kind);
    });
    hand.splice(pick, 1);
    if (sacrifice) {
      // Sacrificed instead of paying the extra mana: give up a spare Treasure or a non-mana permanent first.
      const words = [].concat(sp.extraCost.unlessType);
      const fits = perms.map((p, i) => [p, i]).filter(([p]) => isType(p.typeLine, words) && !(p.isTreasure && p.tapped));
      const fit = fits.find(([p]) => p.isTreasure) || fits.find(([p]) => !p.isSource) || fits[0];
      if (fit) perms.splice(fit[1], 1);
    }
    perms = perms.filter((x) => !(x.isTreasure && x.tapped)); // spent Treasures are gone
    if (sp.isPermanent) {
      const perm = { typeLine: (sp.typeLine || '').toLowerCase(), isSource: false, extraLand: sp.extraLandDrops || 0 };
      if (sp.mana) {
        Object.assign(perm, {
          L: sp.mana, mask: sp.mana.mask, types: 0, isBasic: false, isLand: false, isSource: true,
          tapped: false, etbTapped: false, enteredTurn: turn, readyTurn: sp.mana.sick ? turn + 1 : turn,
        });
      }
      if (sp.treasure) {
        perm.treasureUpkeep = sp.treasure.upkeep;
        perm.treasureTurns = sp.treasure.later.map((k) => turn + k);
      }
      perms.push(perm);
    }
    if (sp.treasure) makeTreasures(sp.treasure.now);
    if (sp.effect) resolve(sp.effect);
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
    perms = [];
    pendingDiscard = 0;
    seenTurn.fill(0);
    let spentTotal = 0;
    for (turn = 1; turn <= turns; turn++) {
      for (const x of bf) { x.tapped = false; x.etbTapped = false; }
      for (const x of perms) x.tapped = false;
      // Treasures from upkeep triggers and Saga chapters.
      for (const x of perms.slice()) {
        if (x.treasureUpkeep) makeTreasures(x.treasureUpkeep);
        if (x.treasureTurns) makeTreasures(x.treasureTurns.filter((t) => t === turn).length);
      }
      if (pendingDiscard) { discardRandom(pendingDiscard); pendingDiscard = 0; }
      if (!(onPlay && turn === 1)) drawCards(1);
      let landsPlayed = 0;
      const playLands = () => {
        let drops = 1;
        for (const x of perms) drops += x.extraLand || 0;
        while (landsPlayed < drops && landsInHand() && chooseAndPlayLand()) landsPlayed++;
      };
      let spent = 0;
      // No land in hand: try cheap draw spells first to find one.
      while (!landsInHand()) {
        const used = castOne(true);
        if (!used) break;
        spent += used;
      }
      playLands();

      st.lands[turn] += bf.length;
      if (bf.length >= turn) st.hitDrop[turn]++;
      // For each spell in hand whose mana value equals this turn: could we cast it now
      // with what's in play (ignoring mana already spent on cantrips this turn)?
      const allBy = {};
      for (let i = 0; i < hand.length; i++) {
        const ci = hand[i];
        const d = defs[ci];
        if (!d.spell || !trackedSet[ci] || curveTurn(d) !== turn || seenTurn[ci] === turn) continue;
        seenTurn[ci] = turn;
        const kind = d.spell.kind;
        const all = allBy[kind] || (allBy[kind] = sourcesFor(kind, true).masks);
        const enough = bf.length >= turn;
        const ok = payCost(all, effectiveCost(d, i)) !== null;
        st.inHand[ci]++;
        if (enough) st.enough[ci]++;
        if (ok) { st.onCurve[ci]++; if (enough) st.onCurveGivenEnough[ci]++; }
      }

      for (;;) {
        const used = castOne(false);
        if (!used) break;
        spent += used;
        playLands();
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

// Spells whose cost reduction we can't model would skew the on-curve average.
const headlineWeight = (d) => (d.spell.costReduction ? 0 : d.count);

// Copy-weighted average of per-spell rates from raw counts (arrays aligned with `tracked`).
function weighted(defs, tracked, inHand, onCurve, enough, given) {
  let w = 0, s = 0, s2 = 0;
  tracked.forEach((i, k) => {
    const c = headlineWeight(defs[i]);
    w += c;
    s += c * (inHand[k] ? onCurve[k] / inHand[k] : 0);
    s2 += c * (enough[k] ? given[k] / enough[k] : 0);
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
      curveTurn: defs[i].spell.curveTurn ?? defs[i].spell.cmc,
      copies: defs[i].count,
      isDraw: !!defs[i].spell.effect,
      costReduction: !!defs[i].spell.costReduction,
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
    const c = sp.costReduction ? 0 : sp.copies;
    w += c; s += c * sp.onCurve; s2 += c * sp.onCurveGivenEnough;
    v += (c * sp.onCurveMoe) ** 2; v2 += (c * sp.onCurveGivenEnoughMoe) ** 2;
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
