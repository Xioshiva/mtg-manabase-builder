import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simulate } from '../public/lib/sim.js';
import { spell, basicLandDef, standard, card, izzetText, byName } from './helpers.js';
import { recommendLandCount, deckStats, sourcesNeeded } from '../public/lib/recommend.js';
import { buildModel, runAnalysis } from '../public/lib/analysis.js';
import { parseDecklist } from '../public/lib/decklist.js';

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

test('the optimizer fixes a lopsided two-color manabase', () => {
  const parsed = parseDecklist(izzetText.replace('8 Island\n6 Mountain', '13 Island\n1 Mountain'));
  const { model } = buildModel(parsed, byName, standard);
  const r = runAnalysis({ model, games: 2000, candidateCards: [] });
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
