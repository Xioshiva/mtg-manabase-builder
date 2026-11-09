import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simulate } from '../public/lib/sim.js';
import { spell, basicLandDef, standard, card, izzetText, byName } from './helpers.js';
import { recommendLandCount, deckStats, sourcesNeeded } from '../public/lib/recommend.js';
import { buildModel, runAnalysis } from '../public/lib/analysis.js';
import { parseDecklist } from '../public/lib/decklist.js';
import { normalizeCard } from '../public/lib/cards.js';

const deck = (...cards) => ({ cards, format: standard });

test('mono-color deck with enough lands always has the right color', () => {
  const r = simulate(deck(spell('Bear', '{1}{G}', 2, 36), basicLandDef('G', 24)), { games: 2000 });
  const bear = r.spells[0];
  assert.equal(bear.onCurveGivenEnough, 1);
  assert.ok(r.turns[1].hitLandDrop > 0.95);
});

test('a color with no sources is never castable', () => {
  const r = simulate(deck(spell('Bear', '{1}{G}', 2, 18), spell('Merfolk', '{1}{U}', 2, 18), basicLandDef('G', 24)), { games: 1000 });
  assert.equal(r.spells.find((s) => s.name === 'Merfolk').onCurve, 0);
});

test('more lands means more land drops', () => {
  const few = simulate(deck(spell('X', '{2}', 2, 44), basicLandDef('R', 16)), { games: 3000 });
  const many = simulate(deck(spell('X', '{2}', 2, 34), basicLandDef('R', 26)), { games: 3000 });
  assert.ok(many.turns[3].hitLandDrop > few.turns[3].hitLandDrop + 0.1);
});

test('cantrips help hit land drops compared to blank cards', () => {
  const blank = simulate(deck(spell('Blank', '{U}', 1, 12, { type: 'Instant' }), spell('X', '{2}', 2, 28), basicLandDef('U', 20)), { games: 6000, seed: 5 });
  const opt = simulate(deck(spell('Opt', '{U}', 1, 12, { type: 'Instant', text: 'Scry 1.\nDraw a card.' }), spell('X', '{2}', 2, 28), basicLandDef('U', 20)), { games: 6000, seed: 5 });
  assert.ok(opt.drawSpellsPerGame > 2);
  assert.ok(opt.turns[4].hitLandDrop > blank.turns[4].hitLandDrop + 0.03, `${opt.turns[4].hitLandDrop} vs ${blank.turns[4].hitLandDrop}`);
});

test('tapped lands hurt on-curve casting', () => {
  const untapped = simulate(deck(spell('X', '{1}{R}', 2, 36), basicLandDef('R', 24)), { games: 3000 });
  const tapped = simulate(deck(spell('X', '{1}{R}', 2, 36), basicLandDef('R', 12), card('Thundering Falls', 4), card('Thriving Isle', 4), { ...card('Sulfur Falls', 4) }), { games: 3000 });
  assert.ok(tapped.castOnCurve < untapped.castOnCurve - 0.03);
});

test('simulation is reproducible with a seed', () => {
  const m = deck(spell('Bear', '{1}{G}', 2, 36), basicLandDef('G', 24));
  assert.deepEqual(simulate(m, { games: 500, seed: 3 }), simulate(m, { games: 500, seed: 3 }));
});

test('land count formula and source estimates are in the expected range', () => {
  const m = deck(spell('A', '{R}', 1, 12), spell('B', '{1}{R}', 2, 12), spell('C', '{2}{R}', 3, 12), basicLandDef('R', 24));
  const rec = recommendLandCount(standard, deckStats(m.cards));
  assert.equal(rec.count, 23);
  const need = sourcesNeeded(standard, 24, m.cards).need;
  assert.ok(need.R >= 13 && need.R <= 16, String(need.R));
});

test('the optimizer fixes a lopsided two-color manabase', async () => {
  const parsed = parseDecklist(izzetText.replace('8 Island\n6 Mountain', '13 Island\n1 Mountain'));
  const { model } = buildModel(parsed, byName, standard);
  const r = await runAnalysis({ model, games: 2000, candidateCards: [] });
  assert.ok(r.suggested.sim.castOnCurve > r.current.sim.castOnCurve + 0.03);
  assert.ok(r.suggested.sources.R > r.current.sources.R);
});

test('margins of error shrink with more games', () => {
  const m = deck(spell('A', '{U}', 1, 18), spell('B', '{1}{R}', 2, 18), basicLandDef('U', 12), basicLandDef('R', 12));
  const small = simulate(m, { games: 1000 });
  const big = simulate(m, { games: 16000 });
  for (const k of ['castOnCurveMoe', 'manaSpentMoe', 'floodRateMoe']) {
    assert.ok(big[k] > 0 && big[k] < small[k] / 2.5, `${k}: ${small[k]} -> ${big[k]}`);
  }
  assert.ok(big.spells.every((s) => s.onCurveMoe < 0.03));
});

test('strict keep rule sends back hands that cannot cast a spell by turn 2', () => {
  // Every spell is green; half the lands only make blue. The default rule keeps any 2-5 land
  // hand, the strict rule sends back hands whose lands can't cast a green two-drop.
  const cards = [spell('Bear', '{1}{G}', 2, 36), basicLandDef('G', 12), basicLandDef('U', 12)];
  const loose = simulate(deck(...cards), { games: 4000, seed: 3 });
  const strict = simulate(deck(...cards), { games: 4000, seed: 3, keepRule: 'strict' });
  assert.ok(strict.mulliganRate > loose.mulliganRate + 0.05, `${strict.mulliganRate} vs ${loose.mulliganRate}`);
});

test('strict keep rule sends back five-land seven-card hands', () => {
  const cards = [spell('X', '{1}{R}', 2, 20), basicLandDef('R', 40)];
  const loose = simulate(deck(...cards), { games: 4000, seed: 3 });
  const strict = simulate(deck(...cards), { games: 4000, seed: 3, keepRule: 'strict' });
  assert.ok(strict.mulliganRate > loose.mulliganRate + 0.1, `${strict.mulliganRate} vs ${loose.mulliganRate}`);
});

test('floodCheck counts lands in play and in hand at the end of the chosen turn', () => {
  const allLands = simulate(deck(basicLandDef('G', 60)), { games: 500, floodCheck: { turn: 6, lands: 6 } });
  assert.equal(allLands.floodCheckRate, 1);
  const noCheck = simulate(deck(basicLandDef('G', 60)), { games: 500 });
  assert.equal(noCheck.floodCheckRate, 0);
});

test('manaSinks spends spare mana on X counters, Offspring, flashback, Mutagens and tutored one-drops', () => {
  // Every deck: one kind of mana sink, cards nothing can cast by turn 7, and lands. Mana
  // spent by turn 5 goes up only when the sinks are modeled.
  const big = (n) => spell('Big', '{9}', 9, n);
  const gain = (...cards) => {
    const plain = simulate(deck(...cards), { games: 3000, seed: 7 });
    const sunk = simulate(deck(...cards), { games: 3000, seed: 7, manaSinks: true });
    return sunk.turns[4].manaSpent - plain.turns[4].manaSpent;
  };
  const hydra = spell('Hydra', '{X}{W}', 1, 8, { text: 'This creature enters with X +1/+1 counters on it.' });
  assert.ok(gain(hydra, big(28), basicLandDef('W', 24)) > 1);
  const rabbit = spell('Rabbit', '{G}', 1, 8, { text: 'Offspring {2}\nTrample' });
  assert.ok(gain(rabbit, big(28), basicLandDef('G', 24)) > 0.5);
  const offense = spell('Offense', '{2}{W}', 3, 8, { type: 'Sorcery', text: 'Put a +1/+1 counter on each creature target player controls.\nFlashback {1}{W}' });
  assert.ok(gain(offense, big(28), basicLandDef('W', 24)) > 0.5);
  const turtle = spell('Turtle', '{1}{G}', 2, 8, { text: 'When this creature enters, create a Mutagen token.' });
  assert.ok(gain(turtle, big(28), basicLandDef('G', 24)) > 0.3);
  const hulk = spell('Hulk', '{1}{G}', 2, 8, { type: 'Artifact Creature — Construct', text: 'When this creature enters, you may search your library for up to two artifact, creature, and/or enchantment cards with mana value 1 or less, reveal them, put them into your hand, then shuffle.' });
  assert.ok(gain(hulk, spell('Elf', '{G}', 1, 8), big(20), basicLandDef('G', 24)) > 0.3);

  const temple = normalizeCard({ name: 'Temple', type_line: 'Land', oracle_text: '{T}: Add {W}.\n{3}{W}, {T}: Put a +1/+1 counter on each creature you control.', legalities: { standard: 'legal' } }, 12);
  assert.ok(gain(temple, big(36), basicLandDef('W', 12)) > 0.3);

  // X spells that need X of at least 1 count as castable on curve one turn later.
  const r = simulate(deck(hydra, big(28), basicLandDef('W', 24)), { games: 500, manaSinks: true });
  assert.equal(r.spells.find((s) => s.name === 'Hydra').curveTurn, 2);
});
