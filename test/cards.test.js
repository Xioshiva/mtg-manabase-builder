import { test } from 'node:test';
import assert from 'node:assert/strict';
import { card } from './helpers.js';
import { COLOR_BITS as C } from '../public/lib/mana.js';
import { parseDecklist } from '../public/lib/decklist.js';

test('reads land enters-tapped rules', () => {
  assert.equal(card('Spirebluff Canal').land.etb, 'fast');
  assert.equal(card('Sulfur Falls').land.etb, 'check');
  assert.equal(card('Sulfur Falls').land.etbTypes, C.U | C.R);
  assert.equal(card('Steam Vents').land.etb, 'shock');
  assert.equal(card('Steam Vents').land.shockLife, 2);
  assert.equal(card('Thundering Falls').land.etb, 'tapped');
  assert.equal(card('Thundering Falls').land.surveil, 1);
  assert.equal(card('Island').land.isBasic, true);
});

test('reads land colors, verges, pathways, thriving lands, fetches and painlands', () => {
  assert.equal(card('Steam Vents').land.mask, C.U | C.R);
  const verge = card('Riverpyre Verge').land;
  assert.equal(verge.mask, C.U);
  assert.deepEqual(verge.cond, [{ mask: C.R, types: C.U | C.R }]);
  assert.deepEqual(card('Riverglide Pathway').land.choices, [C.U, C.R]);
  const thriving = card('Thriving Isle').land;
  assert.equal(thriving.mask, C.U);
  assert.equal(thriving.choices.length, 4);
  assert.equal(card('Fabled Passage').land.fetch.untapAt, 4);
  assert.equal(card('Shivan Reef').land.pain, 1);
});

test('reads spell/land double-faced cards', () => {
  const sink = card('Sink into Stupor');
  assert.equal(sink.spell.cmc, 3);
  assert.equal(sink.mdfcLand.mask, C.U);
  assert.equal(sink.mdfcLand.etb, 'shock');
});

test('detects draw and selection effects', () => {
  assert.deepEqual(pick(card('Opt').spell.effect), { draw: 1, scry: 1, selectFirst: true });
  assert.deepEqual(pick(card('Consider').spell.effect), { draw: 1, surveil: 1, selectFirst: true });
  assert.deepEqual(pick(card('Stock Up').spell.effect), { look: 5, take: 2 });
  assert.deepEqual(pick(card('Sleight of Hand').spell.effect), { look: 2, take: 1 });
  assert.deepEqual(pick(card('Izzet Charm').spell.effect), { draw: 2, discard: 2 });
  assert.deepEqual(pick(card('Cloudkin Seer').spell.effect), { draw: 1 });
  assert.equal(card('Shock').spell.effect, null);
  assert.equal(card('Slickshot Show-Off').spell.effect, null);
});

test('flags mana creatures as not simulated', () => {
  assert.equal(card('Llanowar Elves').producesManaNonLand, true);
});

test('parses Arena and MTGO decklists', () => {
  const arena = parseDecklist('Deck\n4 Opt (M21) 59\n2x Shock\nFell the Profane // Fell Mire\n\nSideboard\n3 Negate\n');
  assert.deepEqual(arena.main, [{ name: 'Opt', count: 4 }, { name: 'Shock', count: 2 }, { name: 'Fell the Profane', count: 1 }]);
  const mtgo = parseDecklist('4 Opt\n20 Island\n\n3 Negate\n');
  assert.deepEqual(mtgo.main.map((c) => c.name), ['Opt', 'Island']);
  const edh = parseDecklist('Commander\n1 Niv-Mizzet, Parun\nDeck\n1 Opt\n');
  assert.deepEqual(edh.commander, [{ name: 'Niv-Mizzet, Parun', count: 1 }]);
});

function pick(e) {
  const out = {};
  for (const [k, v] of Object.entries(e)) if (v && !(Array.isArray(v) && !v.length)) out[k] = v;
  delete out.takeFilter;
  return out;
}
