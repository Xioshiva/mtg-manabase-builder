// Monte Carlo goldfish simulator. Each game: shuffle, London mulligan, then for each
// turn draw, play the best land, cast draw/selection spells to dig, and cast the
// biggest spells the lands can pay for. It measures land drops, whether each spell
// could be cast on curve, and how much mana actually got used.
import { makeRng, shuffle } from './rng.js';
import { payCost, popcount, COLOR_ORDER, COLOR_BITS, ANY_COLOR } from './mana.js';

// A Treasure token: one mana of any color, used up when tapped.
const TREASURE = { mask: ANY_COLOR, cond: [], restricted: [], extra: [] };
const NONE = [];

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

// Games are played in fixed chunks, each with its own seed. A simulation gives the same
// numbers whether its chunks run one after another or spread across several threads
// (see pool.js), and the chunks double as the batches for the margins of error.
export function chunkCount(games) {
  return games >= 200 ? 20 : 1;
}

export function chunkSeed(seed, k) {
  let h = (seed ^ Math.imul(k + 1, 0x9e3779b9)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

export function simulate(model, opts = {}) {
  return finishSimulation(model, opts, [simulateChunks(model, opts, 0, chunkCount(opts.games ?? 4000))]);
}

// What both halves of a simulation (playing chunks, summarizing them) need to agree on.
function setup(model, opts) {
  const turns = opts.turns ?? 7;
  const games = opts.games ?? 4000;
  const defs = model.cards;
  const tracked = [];
  const curveTurn = (d) => d.spell.curveTurn ?? d.spell.cmc;
  defs.forEach((d, i) => { if (d.count > 0 && d.spell && !d.filler && curveTurn(d) >= 1 && curveTurn(d) <= turns) tracked.push(i); });
  let maxCmc = 0;
  for (const d of defs) if (d.count && d.spell && !d.filler) maxCmc = Math.max(maxCmc, d.spell.cmc);
  const wantLands = opts.wantLands ?? Math.max(3, Math.min(6, maxCmc));
  return { turns, games, defs, tracked, curveTurn, wantLands, floodAt: wantLands + 4 };
}

const SCALAR_STATS = ['mulligans', 'cardsKept', 'drawSpellsCast', 'extraCards', 'flood', 'mdfcAsLand', 'life', 'spentSq'];
const TURN_STATS = ['hitDrop', 'lands', 'spent'];
const CARD_STATS = ['inHand', 'onCurve', 'enough', 'onCurveGivenEnough'];

function emptyStats(turns, nCards) {
  const st = {};
  for (const k of SCALAR_STATS) st[k] = 0;
  for (const k of TURN_STATS) st[k] = new Float64Array(turns + 1);
  for (const k of CARD_STATS) st[k] = new Float64Array(nCards);
  return st;
}

// Plays chunks [from, to) of a simulation and returns the raw counts summed over them,
// plus each chunk's headline averages (the batches behind the margins of error).
export function simulateChunks(model, opts, from, to) {
  const { turns, games, defs, tracked, curveTurn, wantLands, floodAt } = setup(model, opts);
  const nChunks = chunkCount(games);
  const seed = opts.seed ?? 12345;
  const mode = opts.play ?? 'both';
  let rng;
  const fmt = model.format;
  const handSize = fmt.handSize ?? 7;
  const keepRanges = fmt.keepRanges ?? { 7: [2, 5], 6: [2, 4], 5: [1, 4] };

  // Commanders start in the command zone: never drawn, always there to cast.
  const deckList = [], commandList = [];
  defs.forEach((d, i) => {
    const inCommand = Math.min(d.commander || 0, d.count);
    for (let k = 0; k < d.count; k++) (k < inCommand ? commandList : deckList).push(i);
  });
  const landish = defs.map((d) => !!(d.land || d.mdfcLand));
  const trackedSet = new Uint8Array(defs.length);
  for (const i of tracked) trackedSet[i] = 1;
  const seenTurn = new Int32Array(defs.length);
  const demand = colorDemand(defs);

  const st = emptyStats(turns, defs.length);

  // bf: lands on the battlefield. perms: nonland permanents we cast or made (for mana and
  // for "unless you control an Equipment"-style checks). Mana sources share one shape:
  // { L, mask, types, isBasic, isLand, tapped, usedExtra, etbTapped, enteredTurn, readyTurn, ci }.
  // A source that makes several mana from one tap (Sol Ring, bounce lands) offers its first
  // mana as itself and the rest as `extra`; `tapped` says the first is spent, bit j of
  // `usedExtra` that extra mana j is. Mana made by one tap can pay for several spells that turn.
  let lib, hand, command, bf, perms, turn, pendingDiscard, expiring, expiringNext;
  // Effects of what's in play: land types every land has (Urborg, Leyline of the
  // Guildpact) and whether lands enter untapped (Spelunking).
  let grant = 0, untapAll = false;
  function refreshStatics() {
    grant = 0;
    untapAll = false;
    for (const x of bf) grant |= x.L.grantTypes || 0;
    for (const p of perms) { grant |= p.grantTypes || 0; if (p.untapLands) untapAll = true; }
  }
  const artifactCount = () => {
    let n = 0;
    for (const p of perms) if (p.typeLine.includes('artifact')) n++;
    for (const x of bf) if (x.L.isArtifact) n++;
    return n;
  };

  const isLandIdx = (ci) => landish[ci];
  const landsInHand = () => { let n = 0; for (const ci of hand) if (landish[ci]) n++; return n; };
  const needLand = (extra = 0) => bf.length + landsInHand() + extra < Math.min(wantLands, turn + 2);
  const controls = (word) => perms.some((p) => p.typeLine.includes(word)) || hand.some((ci) => (defs[ci].spell?.typeLine || '').toLowerCase().includes(word));

  // Mana a source can make for a spell of `kind` ('creature' | 'spell' | 'other'; null = any).
  function srcMask(x, kind, freeOnly) {
    let m = x.mask;
    if (x.isLand) m |= grant; // a land that is also a Swamp taps for {B}
    for (const cd of x.L.cond) {
      if (cd.basicOrFresh) {
        if (x.enteredTurn === turn || bf.some((y) => y.isBasic)) m |= cd.mask;
      } else if (cd.artifacts) {
        if (artifactCount() >= cd.artifacts) m |= cd.mask;
      } else {
        for (const y of bf) if ((y.types | grant) & cd.types) { m |= cd.mask; break; }
      }
    }
    for (const r of x.L.restricted) {
      if (freeOnly && r.life) continue;
      if (r.kind === null || kind === null || r.kind === kind) m |= r.mask;
    }
    return m;
  }

  const ready = (x) => x.isLand ? true : turn >= x.readyTurn;
  // Every color `x` can make for any spell, its extra mana included (Gruul Turf's {G}).
  const allColors = (x) => { let m = srcMask(x, null); for (const e of extraMana(x)) m |= e; return m; };

  // Mana after the first that one tap of `x` makes (Sol Ring, Simic Growth Chamber).
  const extraMana = (x) => x.L.extra || NONE;

  // Untapped sources for a spell of `kind`, one entry per mana (slots: 0 for a source's
  // first mana, j + 1 for its extra mana j). includeTapped ignores mana already spent this
  // turn (used for the "could you cast it" check, which only cares about what's in play).
  function sourcesFor(kind, includeTapped) {
    const masks = [], refs = [], penalty = [], slots = [];
    const add = (x) => {
      if (!ready(x) || x.etbTapped) return;
      const m = srcMask(x, kind, false);
      if (m && (includeTapped || !x.tapped)) {
        masks.push(m); refs.push(x); slots.push(0);
        // Avoid paying life, and keep Treasures for when nothing else will do.
        penalty.push(x.isTreasure ? 2 : x.L.restricted.some((r) => r.life) ? 1 : 0);
      }
      const extra = extraMana(x);
      for (let j = 0; j < extra.length; j++) {
        if (!includeTapped && (x.usedExtra & (1 << j))) continue;
        masks.push(extra[j]); refs.push(x); slots.push(j + 1); penalty.push(0);
      }
    };
    for (const x of bf) add(x);
    for (const x of perms) if (x.isSource) add(x);
    return { masks, refs, penalty, slots };
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
    let cost = sp.cost;
    if (ex && !canSkipExtra(ex, d, skipPos)) {
      cost = { ...cost, generic: cost.generic + ex.generic, pips: ex.pips?.length ? [...cost.pips, ...ex.pips] : cost.pips };
    }
    // Domain: cheaper for each basic land type among our lands.
    if (sp.domain && cost.generic) {
      let types = 0;
      for (const x of bf) types |= x.types | grant;
      const cut = Math.min(cost.generic, sp.domain * popcount(types & ANY_COLOR));
      if (cut) cost = { ...cost, generic: cost.generic - cut };
    }
    return cost;
  }

  const manaNeeded = (c) => c.generic + c.pips.length + c.twobrid.length;

  function makeTreasures(n) {
    for (let k = 0; k < n; k++) {
      perms.push({ typeLine: 'artifact — treasure', L: TREASURE, mask: ANY_COLOR, types: 0, isBasic: false, isLand: false, isSource: true, isTreasure: true, tapped: false, usedExtra: 0, etbTapped: false, enteredTurn: turn, readyTurn: turn });
    }
  }

  function entersTapped(L) {
    if (untapAll) return false;
    switch (L.etb) {
      case 'untapped': case 'shock': return false;
      case 'fast': return bf.length > 2;
      case 'fastTwo': return bf.length > 1;
      case 'slow': return bf.length < 2;
      case 'basic': return !bf.some((x) => x.isBasic);
      case 'check': return !bf.some((x) => (x.types | grant) & L.etbTypes);
      case 'reveal': return !hand.some((ci) => defs[ci].land && (defs[ci].land.types & L.etbTypes));
      case 'multiplayer': return !fmt.multiplayer;
      case 'earlyTurns': return turn > 3;
      case 'lowLife': return turn < 5;
      case 'controlPerm': return !perms.some((p) => L.etbPerm.split(' ').every((w) => p.typeLine.includes(w)));
      case 'behold': return !controls(L.etbPerm);
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
      if ((landish[ci] || d.spell?.colorless) && filter.includes('colorless')) return true;
      const typeLine = (d.spell?.typeLine || '').toLowerCase();
      return filter.some((f) => f.startsWith('type:') && typeLine.includes(f.slice(5)));
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

  // Discard up to n cards we don't want (spare lands when we have enough, spells we can't
  // cast soon when we're short), then draw that many.
  function rummage(n) {
    let k = 0;
    for (; k < n; k++) {
      let pick = -1;
      if (!needLand()) pick = hand.findIndex((ci) => defs[ci].land);
      else {
        const reach = bf.length + landsInHand() + 1;
        for (let i = 0; i < hand.length; i++) {
          const sp = defs[hand[i]].spell;
          if (sp && !landish[hand[i]] && sp.cmc > reach && (pick < 0 || sp.cmc > defs[hand[pick]].spell.cmc)) pick = i;
        }
      }
      if (pick < 0) break;
      hand.splice(pick, 1);
    }
    drawCards(k);
  }

  function discardRandom(n) {
    for (let k = 0; k < n && hand.length; k++) hand.splice(Math.floor(rng() * hand.length), 1);
  }

  function resolve(e) {
    st.drawSpellsCast++;
    if (e.selectFirst) { if (e.scry) select(e.scry); if (e.surveil) select(e.surveil); }
    const look = e.lookPerLand ? bf.length : e.look;
    if (look) dig(look, e.take, e.takeFilter);
    if (e.discardFirst) discard(e.discard);
    if (e.rummage) rummage(e.rummage);
    // Cards we may play only this turn (or until the end of next turn) go to hand and are
    // removed again when that runs out.
    for (let k = 0; k < (e.impulse || 0) && lib.length; k++) { const ci = lib.pop(); hand.push(ci); (e.impulseNext ? expiringNext : expiring).push(ci); }
    drawCards(e.draw);
    let discarded = e.discard;
    // "Discard two cards unless you discard a creature card": pitch the priciest creature.
    const creature = e.discardOrCreature ? hand.reduce((b, ci, i) => (defs[ci].spell?.isCreature && !landish[ci] && (b < 0 || defs[ci].spell.cmc > defs[hand[b]].spell.cmc) ? i : b), -1) : -1;
    if (creature >= 0) { hand.splice(creature, 1); discarded = 1; } else if (e.discard && !e.discardFirst) discard(e.discard);
    st.extraCards += e.draw + (look ? e.take : 0) - discarded - (e.delayedDiscard || 0);
    if (e.delayedDiscard) pendingDiscard += e.delayedDiscard;
    if (!e.selectFirst) { if (e.scry) select(e.scry); if (e.surveil) select(e.surveil); }
  }

  // Library positions of the lands a fetch (or a ramp spell) can find, one per different
  // card (latest copy).
  function fetchTargets(f) {
    const out = [], seen = new Set();
    for (let k = lib.length - 1; k >= 0; k--) {
      const ci = lib[k];
      const L = defs[ci].land;
      const anyBasic = f.basicOnly && f.types === ANY_COLOR; // "a basic land card" finds Wastes too
      if (!L || seen.has(ci) || (f.basicOnly && !L.isBasic) || (!f.anyLand && !anyBasic && !(L.types & f.types))) continue;
      seen.add(ci);
      out.push(k);
    }
    return out;
  }

  // Biggest mana value in hand castable with `extra` (a would-be new land) in play.
  function maxCastable(extra, skipPos) {
    if (extra) bf.push(extra);
    let best = 0;
    const cache = {};
    for (let i = 0; i < hand.length; i++) {
      if (i === skipPos) continue;
      const d = defs[hand[i]];
      if (!d.spell || d.spell.noCost || d.spell.cmc <= best) continue;
      const kind = d.spell.kind;
      const masks = cache[kind] || (cache[kind] = sourcesFor(kind, false).masks);
      const cost = effectiveCost(d, skipPos);
      if (manaNeeded(cost) > masks.length) continue;
      if (payCost(masks, cost)) best = d.spell.cmc;
    }
    if (extra) bf.pop();
    return best;
  }

  const landColorsOf = (L) => { let m = 0; for (const c of L.cond) m |= c.mask; for (const r of L.restricted) if (r.kind === null) m |= r.mask; return m; };

  function makeLandSource(L, mask, tapped, isBasic, ci) {
    return { L, mask, types: L.choiceSetsType ? mask : L.types, isBasic, isLand: true, tapped, usedExtra: 0, etbTapped: tapped, enteredTurn: turn, readyTurn: 0, isSource: true, ci };
  }

  function placeLand(L, mask, tapped, ci) {
    const src = makeLandSource(L, mask, tapped, L.isBasic, ci);
    bf.push(src);
    landEnters(src);
    refreshStatics();
    return src;
  }

  // What a land does as it enters: look at the top of the library, give up other lands,
  // add mana for this turn.
  // Mana that lasts until the end of the turn (spent last, like a Treasure).
  function addFleetingMana(mask) {
    perms.push({ typeLine: '', L: { mask, cond: [], restricted: [], extra: NONE }, mask, types: 0, isBasic: false, isLand: false, isSource: true, isTreasure: true, fleeting: true, tapped: false, usedExtra: 0, etbTapped: false, enteredTurn: turn, readyTurn: turn });
  }

  // A land about to leave is tapped for its mana first, in response to the trigger. The
  // mana can go to any spell, so only colors that cost no life and have no spell
  // restriction count.
  function leaveBattlefield(i) {
    const y = bf[i];
    if (!y.etbTapped) {
      const free = y.tapped ? 0 : srcMask({ ...y, L: { ...y.L, restricted: y.L.restricted.filter((r) => r.kind === null && !r.life) } }, null);
      if (free) addFleetingMana(free);
      const extra = extraMana(y);
      for (let j = 0; j < extra.length; j++) if (!(y.usedExtra & (1 << j))) addFleetingMana(extra[j]);
    }
    bf.splice(i, 1);
    return y;
  }

  function landEnters(src) {
    const L = src.L;
    if (L.surveil) select(L.surveil);
    if (L.scry) select(L.scry);
    if (L.etbMana) addFleetingMana(L.etbMana);
    // Lotus Field: sacrifice lands, already-used ones first, then the ones making the fewest
    // colors. With too few other lands it goes too (older wording: only untapped lands count).
    for (let n = 0; n < (L.sacrifice || 0); n++) {
      let pick = -1, worst = Infinity;
      for (let i = 0; i < bf.length; i++) {
        const y = bf[i];
        const used = y.tapped || y.usedExtra || y.etbTapped;
        if (y === src || (used && L.sacrificeUntapped)) continue;
        const v = (used ? 0 : 10) + popcount(allColors(y));
        if (v < worst) { worst = v; pick = i; }
      }
      if (pick < 0) {
        if (!L.sacrificeUntapped && bf.includes(src)) leaveBattlefield(bf.indexOf(src));
        break;
      }
      leaveBattlefield(pick);
    }
    // Bounce lands: return the land that loses least (one already used this turn, then the
    // plainest), or the bounce land itself when it is alone.
    if (L.bounce) {
      let pick = bf.indexOf(src), worst = Infinity;
      for (let i = 0; i < bf.length; i++) {
        const y = bf[i];
        if (y === src) continue;
        const v = (y.tapped || y.usedExtra ? 0 : 10) + popcount(allColors(y)) + (y.L.bounce ? 5 : 0);
        if (v < worst) { worst = v; pick = i; }
      }
      const y = leaveBattlefield(pick);
      if (y.ci !== undefined) hand.push(y.ci);
    }
  }

  // Plays the best land from hand. fromEffect: put onto the battlefield by a spell
  // ({ tapped }), which doesn't use the land drop and can't use a spell//land card's back.
  function chooseAndPlayLand(fromEffect = null) {
    const forced = fromEffect && fromEffect.tapped && !untapAll;
    let totalMask = 0;
    const have = { W: 0, U: 0, B: 0, R: 0, G: 0 };
    let untapped = 0;
    for (const x of bf) {
      const m = allColors(x);
      totalMask |= m;
      for (const c of COLOR_ORDER) if (m & COLOR_BITS[c]) have[c]++;
      if (!x.tapped && !x.usedExtra && !x.etbTapped) untapped++;
    }
    const demandTotal = COLOR_ORDER.reduce((a, c) => a + demand[c], 0) || 1;
    let best = null, bestScore = -Infinity;
    for (let pos = 0; pos < hand.length; pos++) {
      const d = defs[hand[pos]];
      const options = [];
      if (d.land) options.push({ L: d.land, mdfc: false });
      if (d.mdfcLand && !fromEffect) options.push({ L: d.mdfcLand, mdfc: true });
      for (const { L, mdfc } of options) {
        if (L.legendary && bf.some((y) => y.L === L)) continue; // a second copy would just die
        // Lotus Field with too few other lands would sacrifice itself for nothing.
        if (L.sacrifice && !L.sacrificeUntapped && bf.length < L.sacrifice && !untapAll) continue;
        // A fetch is judged by each different land it can find.
        const finds = L.fetch ? fetchTargets(L.fetch) : [-1];
        for (const k of finds) {
          const target = k >= 0 ? defs[lib[k]].land : null;
          const enters = target || L;
          let tapped, masks;
          if (target && L.fetch.tapped) {
            tapped = !untapAll && !((L.fetch.untapAt && bf.length + 1 >= L.fetch.untapAt) || (L.fetch.untapIfBehold && controls(L.fetch.untapIfBehold)));
            masks = [target.mask];
          } else {
            tapped = entersTapped(enters);
            masks = (enters.choices || [0]).map((c) => enters.mask | c);
          }
          // Shock-style lands: try both entering tapped for free and paying life.
          const shock = enters.etb === 'shock' && !(target && L.fetch.tapped) && !untapAll && !forced;
          const tapOptions = forced ? [true] : shock ? [true, false] : [tapped];
          // Urborg and friends count as in play while we look at what it would do.
          const before = grant;
          grant |= enters.grantTypes || 0;
          for (const m of masks) for (tapped of tapOptions) {
            const probe = makeLandSource(enters, m, tapped, enters.isBasic);
            // Crumbling Vestige's mana as it enters counts this turn, even though it enters tapped.
            if (enters.etbMana) addFleetingMana(enters.etbMana);
            const castNow = maxCastable(tapped ? null : probe, pos);
            if (enters.etbMana) perms.pop();
            const full = allColors(probe);
            let gain = 0, need = 0;
            for (const c of COLOR_ORDER) {
              if (!(full & COLOR_BITS[c])) continue;
              if (!(totalMask & COLOR_BITS[c]) && demand[c] > 0) gain++;
              need += demand[c] / demandTotal / (1 + have[c]);
            }
            let score = castNow * 100 + gain * 20 + (tapped ? 5 : 0) - (mdfc ? 60 : 0);
            if ((enters.etb === 'fast' || enters.etb === 'fastTwo' || enters.etb === 'earlyTurns') && !tapped) score += 3;
            if (enters.etb === 'slow' && tapped) score -= 3;
            if (enters.isBasic) score += 1; // keeps duals that care about basics happy later
            if (shock && !tapped) score -= 8;
            if (target) score += 2 * need; // which land to fetch: the colors we have least of
            if (enters.bounce) score -= bf.length ? 5 : 200;
            if (enters.sacrifice) {
              const others = enters.sacrificeUntapped ? untapped : bf.length;
              score -= 30 * Math.min(enters.sacrifice, others) + (!enters.sacrificeUntapped && others < enters.sacrifice ? 200 : 0);
            }
            if (score > bestScore) { bestScore = score; best = { pos, L, mdfc, mask: m, tapped, k, shock }; }
          }
          grant = before;
        }
      }
    }
    if (!best) return false;
    const played = hand[best.pos];
    hand.splice(best.pos, 1);
    if (best.mdfc) st.mdfcAsLand++;
    let ci = played, L = best.L;
    if (best.k >= 0) {
      ci = lib[best.k];
      lib.splice(best.k, 1);
      shuffle(lib, rng);
      st.life += best.L.fetch.life;
      L = defs[ci].land;
    }
    if (best.shock && !best.tapped) st.life += L.shockLife;
    placeLand(L, best.mask, best.tapped, ci);
    return true;
  }

  // How much a land from the library would help: new colors, colors we have least of.
  // Bounce and sacrifice lands come last.
  function landValue(L) {
    let total = 0;
    const have = { W: 0, U: 0, B: 0, R: 0, G: 0 };
    for (const x of bf) {
      const m = allColors(x);
      total |= m;
      for (const c of COLOR_ORDER) if (m & COLOR_BITS[c]) have[c]++;
    }
    const m = L.mask | grant | landColorsOf(L) | (L.extra || NONE).reduce((a, e) => a | e, 0);
    let v = 0;
    for (const c of COLOR_ORDER) {
      if (!(m & COLOR_BITS[c]) || !demand[c]) continue;
      v += (total & COLOR_BITS[c] ? 0 : 20) + 10 * demand[c] / (1 + have[c]) / (COLOR_ORDER.reduce((a, k) => a + demand[k], 0) || 1);
    }
    if (L.extra && L.extra.length) v += 5 * L.extra.length;
    if (L.isBasic) v += 1;
    if (L.bounce || L.sacrifice || L.fetch) v -= 30;
    return v;
  }

  // Ramp spells: lands from the library onto the battlefield, then into hand.
  function rampLands(r) {
    let moved = false;
    for (let n = 0; n < r.count + r.toHand; n++) {
      const ks = fetchTargets(r);
      if (!ks.length) break;
      let best = ks[0], bestV = -Infinity;
      for (const k of ks) { const v = landValue(defs[lib[k]].land); if (v > bestV) { bestV = v; best = k; } }
      const ci = lib[best];
      lib.splice(best, 1);
      moved = true;
      const L = defs[ci].land;
      if (n < r.count) placeLand(L, L.mask | (L.choices ? L.choices[0] : 0), !untapAll && (r.tapped || L.etb === 'shock' || entersTapped(L)), ci);
      else hand.push(ci);
    }
    if (moved) shuffle(lib, rng);
  }

  // Life paid when `x` made mana for pip `pip` using a life-costing ability.
  function lifeFor(x, pip, kind) {
    if (srcMask(x, kind, true) & pip) return 0;
    let cheapest = Infinity;
    for (const r of x.L.restricted) if (r.life && (r.mask & pip) && (r.kind === null || r.kind === kind)) cheapest = Math.min(cheapest, r.life);
    return cheapest === Infinity ? 0 : cheapest;
  }

  // Casts the best spell we can pay for from hand or the command zone. Positions past the
  // end of the hand are command-zone cards.
  function castOne(onlyDraw) {
    const cache = {};
    const pool = command.length ? hand.concat(command) : hand;
    let pick = -1, pickScore = -Infinity, pay = null, pickSrc = null;
    for (let i = 0; i < pool.length; i++) {
      const d = defs[pool[i]];
      if (!d.spell || d.spell.noCost) continue;
      if (onlyDraw && !d.spell.effect) continue;
      if (d.spell.legendary && perms.some((p) => p.def === d)) continue; // the legend rule
      const kind = d.spell.kind;
      const srcs = cache[kind] || (cache[kind] = sourcesFor(kind, false));
      const score = onlyDraw ? -d.spell.cmc : d.spell.cmc * 10 + (d.spell.effect ? 0 : 1) + (d.spell.mana ? 5 : 0);
      if (score <= pickScore) continue;
      const cost = effectiveCost(d, i < hand.length ? i : -1);
      if (manaNeeded(cost) > srcs.masks.length) continue;
      const p = payCost(srcs.masks, cost, srcs.penalty);
      if (p) { pick = i; pickScore = score; pay = p; pickSrc = srcs; }
    }
    if (pick < 0) return null;
    const fromHand = pick < hand.length;
    const d = defs[pool[pick]];
    const sp = d.spell;
    const sacrifice = sp.extraCost?.sacrifice && canSkipExtra(sp.extraCost, d, fromHand ? pick : -1);
    pay.forEach((k, n) => {
      const x = pickSrc.refs[k];
      const slot = pickSrc.slots[k];
      if (slot) { x.usedExtra |= 1 << (slot - 1); return; }
      x.tapped = true;
      if (n < pay.pipFor.length) st.life += lifeFor(x, pay.pipFor[n], sp.kind);
    });
    if (fromHand) hand.splice(pick, 1); else command.splice(pick - hand.length, 1);
    if (sacrifice) {
      // Sacrificed instead of paying the extra mana: give up a spare Treasure or a non-mana permanent first.
      const words = [].concat(sp.extraCost.unlessType);
      const fits = perms.map((p, i) => [p, i]).filter(([p]) => isType(p.typeLine, words) && !(p.isTreasure && p.tapped));
      const fit = fits.find(([p]) => p.isTreasure) || fits.find(([p]) => !p.isSource) || fits[0];
      if (fit) perms.splice(fit[1], 1);
    }
    perms = perms.filter((x) => !(x.isTreasure && x.tapped)); // spent Treasures are gone
    if (sp.isPermanent) { enterPermanent(sp, d); refreshStatics(); }
    if (sp.etbMana) for (const m of sp.etbMana) addFleetingMana(m);
    if (sp.landToken) placeLand(sp.landToken, sp.landToken.mask, !untapAll && sp.landToken.etb === 'tapped');
    if (sp.treasure) makeTreasures(sp.treasure.now);
    if (sp.effect) resolve(sp.effect);
    if (sp.ramp) rampLands(sp.ramp);
    if (sp.landFromHand && landsInHand()) chooseAndPlayLand(sp.landFromHand);
    refreshStatics();
    // Mana spent: the mana value, or what was paid when that was more (extra costs) or the
    // spell got cheaper (domain). null means nothing was cast; free spells return 0.
    return Math.max(sp.domain ? 0 : sp.cmc - (sp.phyrexian || 0), pay.length);
  }

  function enterPermanent(sp, def) {
    const perm = { def, typeLine: (sp.typeLine || '').toLowerCase(), isSource: false, extraLand: sp.extraLandDrops || 0, grantTypes: sp.grantTypes || 0, untapLands: sp.untapLands };
    if (sp.mana) {
      Object.assign(perm, {
        L: sp.mana, mask: sp.mana.mask, types: 0, isBasic: false, isLand: false, isSource: true,
        tapped: false, usedExtra: 0, etbTapped: false, enteredTurn: turn, readyTurn: sp.mana.sick ? turn + 1 : turn,
      });
    }
    if (sp.treasure) {
      perm.treasureUpkeep = sp.treasure.upkeep;
      perm.treasureTurns = sp.treasure.later.map((k) => turn + k);
    }
    perms.push(perm);
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
  // correlated, so their margin of error comes from the spread across the chunks.
  const batches = [];
  const snap = { inHand: new Float64Array(defs.length), onCurve: new Float64Array(defs.length), enough: new Float64Array(defs.length), given: new Float64Array(defs.length) };
  const closeBatch = () => {
    const d = (a, b) => tracked.map((i) => a[i] - b[i]);
    batches.push(weighted(defs, tracked, d(st.inHand, snap.inHand), d(st.onCurve, snap.onCurve), d(st.enough, snap.enough), d(st.onCurveGivenEnough, snap.given)));
    snap.inHand.set(st.inHand); snap.onCurve.set(st.onCurve); snap.enough.set(st.enough); snap.given.set(st.onCurveGivenEnough);
  };

  function playGame(g) {
    const onPlay = mode === 'both' ? g % 2 === 0 : mode === 'play';
    mulligan();
    command = commandList.slice();
    bf = [];
    perms = [];
    pendingDiscard = 0;
    expiring = [];
    expiringNext = [];
    seenTurn.fill(0);
    turn = 1;
    // Leylines in the opening hand start the game on the battlefield.
    for (let i = hand.length - 1; i >= 0; i--) {
      const sp = defs[hand[i]].spell;
      if (sp && sp.leyline && !(sp.legendary && perms.some((p) => p.def === defs[hand[i]]))) { enterPermanent(sp, defs[hand[i]]); hand.splice(i, 1); }
    }
    refreshStatics();
    let spentTotal = 0;
    for (turn = 1; turn <= turns; turn++) {
      for (const x of bf) { x.tapped = false; x.usedExtra = 0; x.etbTapped = false; }
      for (const x of perms) { x.tapped = false; x.usedExtra = 0; }
      // Urza's Saga's last chapter: it is tapped for mana in response, then sacrificed.
      if (bf.some((x) => x.L.leavesAfter && turn >= x.enteredTurn + x.L.leavesAfter)) {
        for (let i = bf.length - 1; i >= 0; i--) if (bf[i].L.leavesAfter && turn >= bf[i].enteredTurn + bf[i].L.leavesAfter) leaveBattlefield(i);
        refreshStatics();
      }
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
        if (used === null) break;
        spent += used;
      }
      playLands();

      st.lands[turn] += bf.length;
      if (bf.length >= turn) st.hitDrop[turn]++;
      // For each spell in hand whose mana value equals this turn: could we cast it now
      // with what's in play (ignoring mana already spent on cantrips this turn)?
      const allBy = {};
      const castable = command.length ? hand.concat(command) : hand;
      for (let i = 0; i < castable.length; i++) {
        const ci = castable[i];
        const d = defs[ci];
        if (!d.spell || !trackedSet[ci] || curveTurn(d) !== turn || seenTurn[ci] === turn) continue;
        seenTurn[ci] = turn;
        const kind = d.spell.kind;
        const all = allBy[kind] || (allBy[kind] = sourcesFor(kind, true).masks);
        const enough = bf.length >= turn;
        const ok = payCost(all, effectiveCost(d, i < hand.length ? i : -1)) !== null;
        st.inHand[ci]++;
        if (enough) st.enough[ci]++;
        if (ok) { st.onCurve[ci]++; if (enough) st.onCurveGivenEnough[ci]++; }
      }

      for (;;) {
        const used = castOne(false);
        if (used === null) break;
        spent += used;
        playLands();
      }
      for (const ci of expiring) { const i = hand.lastIndexOf(ci); if (i >= 0) hand.splice(i, 1); }
      expiring.length = 0;
      expiring.push(...expiringNext);
      expiringNext.length = 0;
      if (perms.some((x) => x.fleeting)) perms = perms.filter((x) => !x.fleeting); // mana empties at end of turn
      spentTotal += spent;
      st.spent[turn] += spentTotal;
    }
    if (bf.length + landsInHand() >= floodAt) st.flood++;
    st.spentSq += spentTotal * spentTotal;
  }

  for (let k = from; k < to; k++) {
    rng = makeRng(chunkSeed(seed, k));
    const end = Math.floor((k + 1) * games / nChunks);
    for (let g = Math.floor(k * games / nChunks); g < end; g++) playGame(g);
    if (nChunks > 1) closeBatch();
  }
  return { st, batches };
}

// Adds up the parts returned by simulateChunks (in chunk order) and summarizes them.
export function finishSimulation(model, opts, parts) {
  const { turns, games, defs, tracked, wantLands, floodAt } = setup(model, opts);
  const st = emptyStats(turns, defs.length);
  const batches = [];
  for (const p of parts) {
    for (const k of SCALAR_STATS) st[k] += p.st[k];
    for (const k of [...TURN_STATS, ...CARD_STATS]) for (let i = 0; i < st[k].length; i++) st[k][i] += p.st[k][i];
    batches.push(...p.batches);
  }
  return summarize({ ...st, games, turns, batches }, defs, tracked, { wantLands, floodAt });
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
      commander: !!defs[i].commander,
      isDraw: !!defs[i].spell.effect,
      costReduction: !!defs[i].spell.costReduction,
      domain: !!defs[i].spell.domain,
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
