// Parser checks against real Standard cards (rules text from test/fixtures/real/cards.json).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { normalizeCard, basicLandDef, landSummary } from '../public/lib/cards.js';
import { COLOR_BITS as C, ANY_COLOR } from '../public/lib/mana.js';
import { simulate } from '../public/lib/sim.js';
import { parseDecklist, cardKey, indexCards } from '../public/lib/decklist.js';
import { buildModel, runAnalysis } from '../public/lib/analysis.js';
import { getFormat } from '../public/lib/formats.js';
import { spell } from './helpers.js';

const dir = new URL('./fixtures/real/', import.meta.url);
const raw = JSON.parse(readFileSync(new URL('cards.json', dir), 'utf8'));
const byName = indexCards(raw);
const real = (name, count = 1) => {
  const sc = byName.get(cardKey(name));
  assert.ok(sc, `fixture is missing ${name}`);
  return normalizeCard(sc, count);
};
const standard = getFormat('standard');

test('Multiversal Passage picks any basic type and can enter untapped for 2 life', () => {
  const L = real('Multiversal Passage').land;
  assert.equal(L.choices.length, 5);
  assert.equal(L.choiceSetsType, true);
  assert.equal(L.etb, 'shock');
  assert.equal(L.shockLife, 2);
});

test('Starting Town is untapped on turns 1-3 and its colors cost life', () => {
  const L = real('Starting Town').land;
  assert.equal(L.etb, 'earlyTurns');
  assert.equal(L.mask, C.C);
  assert.deepEqual(L.restricted, [{ mask: ANY_COLOR, kind: null, life: 1 }]);
});

test('lands with restricted colored mana', () => {
  assert.deepEqual(real('Cavern of Souls').land.restricted, [{ mask: ANY_COLOR, kind: 'creature', life: 0 }]);
  assert.deepEqual(real('Great Hall of the Biblioplex').land.restricted, [{ mask: ANY_COLOR, kind: 'spell', life: 1 }]);
  assert.deepEqual(real('Lupinflower Village').land.restricted, [{ mask: C.W, kind: 'creature', life: 0 }]);
  assert.deepEqual(real('Hidden Lair').land.cond, [{ mask: C.U | C.B, types: 0, basicOrFresh: true }]);
});

test('enters-tapped conditions on real lands', () => {
  const mountain = real('The Lonely Mountain').land;
  assert.equal(mountain.etb, 'controlPerm');
  assert.equal(mountain.etbPerm, 'equipment');
  assert.equal(mountain.mask, C.R);
  assert.equal(real('Ba Sing Se').land.etb, 'basic');
  assert.equal(real('Shipwreck Marsh').land.etb, 'slow');
  assert.equal(real('Restless Reef').land.etb, 'tapped');
  assert.equal(real('Undercity Sewers').land.surveil, 1);
});

test('only real fetchlands fetch', () => {
  const demolition = real('Demolition Field').land;
  assert.equal(demolition.fetch, null);
  assert.equal(demolition.mask, C.C);
  const elven = real('Elven Passage').land.fetch;
  assert.deepEqual(elven, { types: ANY_COLOR, untapAt: 0, life: 1, untapIfBehold: 'elf' });
  assert.equal(real('Fabled Passage').land.fetch.untapAt, 4);
  assert.ok(real('Escape Tunnel').land.fetch);
});

test('mana creatures and rocks', () => {
  const elves = real('Llanowar Elves').spell.mana;
  assert.equal(elves.mask, C.G);
  assert.equal(elves.sick, true);
  const core = real('Firdoch Core').spell.mana;
  assert.equal(core.mask, ANY_COLOR);
  assert.equal(core.sick, false);
  assert.equal(real('Gene Pollinator').spell.mana, null); // needs another permanent tapped
});

test('draw effects: no opponent draws, delayed discards, extra costs, cost reduction', () => {
  assert.equal(real('Deadly Cover-Up').spell.effect, null);
  const casey = real('Casey Jones, Vigilante').spell.effect;
  assert.equal(casey.draw, 3);
  assert.equal(casey.delayedDiscard, 3);
  const sculpt = real('Countersculpt').spell;
  assert.deepEqual(sculpt.extraCost, { generic: 1, pips: [], unlessType: ['jace'], fromHand: true, sacrifice: false });
  assert.equal(sculpt.curveTurn, 3);
  assert.equal(real('Eddymurk Crab').spell.costReduction, true);
  assert.deepEqual({ draw: real('Seasoned Cryomancer').spell.effect.draw, discard: real('Seasoned Cryomancer').spell.effect.discard }, { draw: 2, discard: 2 });
});

test('a mana dork lets three-drops come down a turn early', () => {
  const deck = (dork) => ({ cards: [dork, spell('Three', '{2}{G}', 3, 32), basicLandDef('G', 24)], format: standard });
  const withElves = simulate(deck(real('Llanowar Elves', 4)), { games: 4000, seed: 4 });
  const withBears = simulate(deck(spell('Bear', '{G}', 1, 4)), { games: 4000, seed: 4 });
  assert.ok(withElves.turns[1].manaSpent > withBears.turns[1].manaSpent + 0.1, `${withElves.turns[1].manaSpent} vs ${withBears.turns[1].manaSpent}`);
});

test('Cavern of Souls colors cast creatures but not instants', () => {
  const cards = [real('Cavern of Souls', 24), spell('Guy', '{U}', 1, 18), spell('Zap', '{U}', 1, 18, { type: 'Instant' })];
  const r = simulate({ cards, format: standard }, { games: 2000 });
  assert.ok(r.spells.find((s) => s.name === 'Guy').onCurve > 0.95);
  assert.equal(r.spells.find((s) => s.name === 'Zap').onCurve, 0);
});

test('Starting Town enters tapped after turn 3', () => {
  const cards = [real('Starting Town', 24), spell('One', '{1}', 1, 18), spell('Five', '{5}', 5, 18)];
  const r = simulate({ cards, format: standard }, { games: 2000 });
  assert.ok(r.spells.find((s) => s.name === 'One').onCurve > 0.95);
  // A turn-5 Starting Town enters tapped, so a 5-drop on curve needs the fifth land earlier.
  assert.ok(r.spells.find((s) => s.name === 'Five').onCurveGivenEnough < 0.95);
});

test('every real decklist has card data and simulates', () => {
  for (const file of readdirSync(new URL('decks/', dir)).filter((f) => f.endsWith('.txt'))) {
    const parsed = parseDecklist(readFileSync(new URL(`decks/${file}`, dir), 'utf8'));
    const built = buildModel(parsed, byName, standard);
    assert.deepEqual(built.unknown, [], `${file} is missing card data`);
    assert.equal(parsed.main.reduce((a, c) => a + c.count, 0), 60, `${file} should have 60 cards`);
    const r = simulate(built.model, { games: 300 });
    assert.ok(r.castOnCurve > 0.5 && r.turns[2].hitLandDrop > 0.8, `${file}: ${r.castOnCurve}`);
    const unknownLands = built.model.cards.filter((d) => d.land && d.land.etb === 'unknown').map((d) => d.name);
    assert.deepEqual(unknownLands, [], `${file} has lands with unrecognised conditions`);
  }
});

test('second-pass fixes: digging, conditional draws, Spree and other extra costs', () => {
  const charts = real('Consult the Star Charts').spell.effect;
  assert.equal(charts.lookPerLand, true);
  assert.equal(charts.take, 1);
  for (const n of ['Something Worth Saving', 'Rapid Rescue']) {
    assert.deepEqual(real(n).spell.effect.takeFilter, ['permanent']);
  }
  assert.equal(real('Something Worth Saving').spell.effect.look, 4);
  assert.equal(real('Yuriko, Hope from the Shadows').spell.effect.surveil, 2);
  assert.equal(real('Winternight Stories').spell.effect.discardOrCreature, true);
  // Draws that depend on the opponent, a sacrifice, the colors spent, or X are not counted.
  for (const n of ['Beza, the Bounding Spring', 'Wistfulness', 'Witherbloom Charm', 'The Sackville-Bagginses', 'Together as One']) {
    const c = real(n);
    assert.ok(!c.spell.effect || !c.spell.effect.draw, n);
    assert.ok(c.notes.some((t) => /simulator doesn't count it/.test(t)), n);
  }
  const extra = (n) => { const sp = real(n).spell; return [sp.extraCost.generic, sp.extraCost.pips.length, sp.curveTurn]; };
  assert.deepEqual(extra('Lively Dirge'), [1, 0, 3]);
  assert.deepEqual(extra('Requisition Raid'), [1, 0, 2]);
  assert.deepEqual(extra('Three Steps Ahead'), [2, 0, 3]); // cast for its draw mode
  assert.equal(real('Three Steps Ahead').spell.effect.draw, 2);
  const stir = real('Stir Up Trouble').spell.extraCost;
  assert.deepEqual([stir.generic, stir.unlessType, stir.sacrifice], [4, ['artifact', 'creature'], true]);
  assert.equal(real('Sapling Nursery').spell.costReduction, true);
  assert.equal(real('Icetill Explorer').spell.extraLandDrops, 1);
  assert.match(landSummary(real('Elven Passage').land), /untaps if you behold an Elf/);
  assert.match(landSummary(real('Spirebluff Canal').land), /first three lands/);
  assert.deepEqual(real('The Misty Mountains Cold').spell.treasure, { now: 1, upkeep: 0, later: [1, 2, 3] });
  assert.equal(real('Smaug the Magnificent').spell.treasure.upkeep, 1);
  assert.equal(real('Beza, the Bounding Spring').spell.treasure, null);
});

test('Treasures and extra land drops add mana', () => {
  const big = spell('Big', '{4}{R}{R}', 6, 20);
  const base = (third) => ({ cards: [third, big, spell('Filler', '{R}', 1, 16), basicLandDef('R', 20)], format: standard });
  const saga = simulate(base(real('The Misty Mountains Cold', 4)), { games: 4000, seed: 9 });
  const plain = simulate(base(spell('Plain Saga', '{2}{R}', 3, 4, { type: 'Enchantment' })), { games: 4000, seed: 9 });
  assert.ok(saga.manaSpent > plain.manaSpent + 0.3, `${saga.manaSpent} vs ${plain.manaSpent}`);

  const lands = (four) => simulate({ cards: [four, big, basicLandDef('G', 26), spell('Filler', '{G}', 1, 10)], format: standard }, { games: 4000, seed: 9 }).turns[6].avgLands;
  // The extra land drop adds about 0.09 lands by turn 7 (measured over 40,000 games).
  assert.ok(lands(real('Icetill Explorer', 4)) > lands(spell('Bug', '{2}{G}{G}', 4, 4)) + 0.05);
});

test('"Sacrifice an artifact or creature or pay {4}" is cheap once a creature is out', () => {
  const stir = real('Stir Up Trouble', 8);
  const deck = (one) => ({ cards: [stir, one, basicLandDef('B', 24), spell('Filler', '{3}{B}', 4, 12)], format: standard });
  const withGuys = simulate(deck(spell('Guy', '{B}', 1, 16)), { games: 3000, seed: 2 });
  const withSpells = simulate(deck(spell('Zap', '{B}', 1, 16, { type: 'Instant' })), { games: 3000, seed: 2 });
  // Both are checked on turn 5, but with creatures around it gets cast before then and uses less mana.
  assert.equal(withGuys.spells.find((s) => s.name === 'Stir Up Trouble').curveTurn, 5);
  assert.ok(withGuys.turns[1].manaSpent > withSpells.turns[1].manaSpent);
});

test('third-pass fixes: rummage, play-this-turn, discard-then-draw, typed digs, behold lands', () => {
  assert.equal(real('Tersa Lightshatter').spell.effect.rummage, 2);
  assert.equal(real('Tablet of Discovery').spell.effect.impulse, 1);
  const pulse = real('Case of the Crimson Pulse').spell.effect;
  assert.deepEqual([pulse.discard, pulse.discardFirst, pulse.draw], [1, true, 2]);
  assert.deepEqual(real("Dáin's Company").spell.effect.takeFilter, ['type:dwarf', 'type:equipment']);
  assert.deepEqual(real('Greedy Freebooter').notes, []); // the Treasure reminder text is not its own mana ability
  const sanctum = real("Theorist's Sanctum").land;
  assert.deepEqual([sanctum.etb, sanctum.etbPerm], ['behold', 'jace']);
  // With Jaces in the deck the Sanctum often enters untapped; with no Jaces it never does.
  const deck = (third) => ({ cards: [real("Theorist's Sanctum", 24), spell('Opt-ish', '{U}', 1, 20, { type: 'Instant' }), third], format: standard });
  const jace = simulate(deck(spell('Jace Test', '{2}{U}', 3, 16, { type: 'Legendary Planeswalker — Jace' })), { games: 2000, seed: 3 });
  const noJace = simulate(deck(spell('Not Jace', '{2}{U}', 3, 16, { type: 'Legendary Planeswalker — Kaito' })), { games: 2000, seed: 3 });
  assert.ok(jace.spells.find((x) => x.name === 'Opt-ish').onCurve > 0.5);
  assert.equal(noJace.spells.find((x) => x.name === 'Opt-ish').onCurve, 0);
});

test('lands that do more than make mana are kept by the search', async () => {
  const utility = (n) => real(n).land.utility;
  for (const n of ['Restless Anchorage', 'Escape Tunnel', 'Fountainport', "Theorist's Sanctum"]) assert.equal(utility(n), true, n);
  for (const n of ['Watery Grave', 'Fabled Passage', 'Starting Town', 'Cavern of Souls', 'Multiversal Passage', 'Floodfarm Verge', 'Hidden Lair']) assert.equal(utility(n), false, n);
  const model = {
    cards: [real('Restless Anchorage', 4), basicLandDef('W', 10), basicLandDef('U', 10), spell('Two', '{W}{U}', 2, 20), spell('One', '{U}', 1, 16, { type: 'Instant' })],
    format: standard,
  };
  const kept = await runAnalysis({ model, games: 400 });
  assert.deepEqual(kept.suggested.kept, ['Restless Anchorage']);
  assert.equal(kept.suggested.lands.find((l) => l.name === 'Restless Anchorage').count, 4);
  const swapped = await runAnalysis({ model, games: 400, keepUtility: false });
  assert.deepEqual(swapped.suggested.kept, []);
  assert.ok(!swapped.suggested.lands.some((l) => l.name === 'Restless Anchorage' && l.count === 4)); // a tapped dual loses to basics here
});
