// Commander mana pieces read from real card text (test/fixtures/real/cards.json): fast mana
// that is used once, rituals, Mox Diamond, Gaea's Cradle, and colors that depend on the commander.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeCard, basicLandDef, landSummary } from '../public/lib/cards.js';
import { COLOR_BITS as C, ANY_COLOR } from '../public/lib/mana.js';
import { simulate } from '../public/lib/sim.js';
import { parseDecklist, cardKey, indexCards } from '../public/lib/decklist.js';
import { buildModel } from '../public/lib/analysis.js';
import { getFormat } from '../public/lib/formats.js';
import { spell } from './helpers.js';

const byName = indexCards(JSON.parse(readFileSync(new URL('./fixtures/real/cards.json', import.meta.url), 'utf8')));
const real = (name, count = 1) => {
  const sc = byName.get(cardKey(name));
  assert.ok(sc, `fixture is missing ${name}`);
  return normalizeCard(sc, count);
};
const commander = getFormat('commander');
const standard = getFormat('standard');
// The same card with some of its mana fields changed, to compare against.
const withMana = (d, change) => ({ ...d, spell: { ...d.spell, mana: { ...d.spell.mana, ...change } } });

test('Mana Vault and Grim Monolith make their mana once', () => {
  for (const n of ['Mana Vault', 'Grim Monolith']) {
    const m = real(n).spell.mana;
    assert.deepEqual([m.mask, m.extra.length, m.noUntap], [C.C, 2, true], n);
  }
  const deck = (vault) => ({ cards: [vault, basicLandDef('B', 30), spell('Big', '{4}{B}', 5, 50)], format: standard });
  const once = simulate(deck(real('Mana Vault', 20)), { games: 2000, seed: 4 });
  const every = simulate(deck(withMana(real('Mana Vault', 20), { noUntap: false })), { games: 2000, seed: 4 });
  // A Mana Vault that untapped would add three mana every turn.
  assert.ok(every.manaSpent > once.manaSpent + 3, `${every.manaSpent} vs ${once.manaSpent}`);
});

test('Lotus Petal is sacrificed for its mana, like a Treasure', () => {
  const petal = real('Lotus Petal');
  assert.deepEqual([petal.spell.mana.mask, petal.spell.mana.oneShot], [ANY_COLOR, true]);
  assert.ok(petal.notes.some((n) => /used once/.test(n)));
  const deck = (p) => ({ cards: [p, basicLandDef('G', 30), spell('Big', '{4}{G}', 5, 50)], format: standard });
  const once = simulate(deck(real('Lotus Petal', 20)), { games: 2000, seed: 4 });
  const kept = simulate(deck(withMana(real('Lotus Petal', 20), { oneShot: false })), { games: 2000, seed: 4 });
  assert.ok(kept.manaSpent > once.manaSpent + 3, `${kept.manaSpent} vs ${once.manaSpent}`);
});

test('rituals add their mana for the turn; Culling the Weak needs a sacrifice', () => {
  assert.deepEqual(real('Dark Ritual').spell.etbMana, [C.B, C.B, C.B]);
  assert.deepEqual(real('Rite of Flame').spell.etbMana, [C.R, C.R]);
  assert.equal(real('Culling the Weak').spell.etbMana, null);
  const deck = (one) => ({ cards: [one, basicLandDef('B', 40), spell('Three', '{2}{B}', 3, 40)], format: standard });
  const ritual = simulate(deck(real('Dark Ritual', 20)), { games: 2000, seed: 4 });
  const plain = simulate(deck(spell('Bolt', '{B}', 1, 20, { type: 'Instant' })), { games: 2000, seed: 4 });
  // Turn 1: Swamp, Dark Ritual, then a three-drop.
  assert.ok(ritual.turns[0].manaSpent > plain.turns[0].manaSpent + 0.5, `${ritual.turns[0].manaSpent} vs ${plain.turns[0].manaSpent}`);
});

test('Mox Diamond costs a land card from hand', () => {
  const mox = real('Mox Diamond');
  assert.equal(mox.spell.discardLand, true);
  assert.equal(mox.spell.mana.mask, ANY_COLOR);
  const deck = (m) => ({ cards: [m, basicLandDef('R', 40), spell('Big', '{5}{R}', 6, 40)], format: standard });
  const discard = simulate(deck(real('Mox Diamond', 20)), { games: 2000, seed: 4 });
  const free = simulate(deck({ ...real('Mox Diamond', 20), spell: { ...real('Mox Diamond').spell, discardLand: false } }), { games: 2000, seed: 4 });
  assert.ok(discard.turns[3].avgLands < free.turns[3].avgLands - 0.2, `${discard.turns[3].avgLands} vs ${free.turns[3].avgLands}`);
});

test("Gaea's Cradle needs a creature; Circle of Dreams Druid counts itself", () => {
  const cradle = real("Gaea's Cradle").land;
  assert.equal(cradle.mask, 0);
  assert.deepEqual(cradle.cond, [{ mask: C.G, types: 0, perm: ['creature'] }]);
  assert.match(landSummary(cradle), /makes mana once you control a creature/);
  // With creatures out the Cradles make mana; with only sorceries they never do.
  const deck = (one) => ({ cards: [real("Gaea's Cradle", 20), basicLandDef('G', 20), one, spell('Big', '{4}{G}', 5, 30)], format: standard });
  const creatures = simulate(deck(spell('Bear', '{G}', 1, 30)), { games: 2000, seed: 4 });
  const sorceries = simulate(deck(spell('Growth', '{G}', 1, 30, { type: 'Sorcery' })), { games: 2000, seed: 4 });
  assert.ok(creatures.manaSpent > sorceries.manaSpent + 1, `${creatures.manaSpent} vs ${sorceries.manaSpent}`);
  assert.deepEqual(real('Circle of Dreams Druid').spell.mana.cond, [{ mask: C.G, types: 0, perm: ['creature'] }]);
  const dorks = simulate({ cards: [real('Circle of Dreams Druid', 20), basicLandDef('G', 30), spell('Four', '{3}{G}', 4, 50)], format: standard }, { games: 2000, seed: 4 });
  const bears = simulate({ cards: [spell('Bear', '{1}{G}{G}', 3, 20), basicLandDef('G', 30), spell('Four', '{3}{G}', 4, 50)], format: standard }, { games: 2000, seed: 4 });
  assert.ok(dorks.turns[3].manaSpent > bears.turns[3].manaSpent, `${dorks.turns[3].manaSpent} vs ${bears.turns[3].manaSpent}`);
});

test('Fellwar Stone, Exotic Orchard and Mox Amber make the commander\'s colors', () => {
  for (const n of ['Fellwar Stone', 'Exotic Orchard']) assert.ok(real(n).notes.some((t) => /opponents' lands/.test(t)), n);
  const amber = real('Mox Amber').spell.mana;
  assert.equal(amber.mask, 0);
  assert.deepEqual(amber.cond, [{ mask: ANY_COLOR, types: 0, perm: ['legendary creature', 'legendary planeswalker'] }]);
  const parsed = parseDecklist('Commander\n1 Kinnan, Bonder Prodigy\n\nDeck\n1 Fellwar Stone\n1 Exotic Orchard\n1 Mox Amber\n');
  const { model } = buildModel(parsed, byName, commander);
  const find = (n) => model.cards.find((d) => d.name === n);
  assert.equal(find('Fellwar Stone').spell.mana.mask, C.U | C.G);
  assert.equal(find('Exotic Orchard').land.mask, C.U | C.G);
  assert.equal(find('Mox Amber').spell.mana.cond[0].mask, C.U | C.G);
  // Mox Amber makes mana only once a legendary creature is out.
  const legend = { ...normalizeCard({ name: 'Leader', mana_cost: '{1}{G}', cmc: 2, type_line: 'Legendary Creature — Elf', oracle_text: '', color_identity: ['G'] }, 1), commander: 1 };
  const amberDeck = (ambers) => ({ cards: [legend, ambers, basicLandDef('G', 30), spell('Five', '{4}{G}', 5, 49)], format: commander });
  const withAmber = simulate(amberDeck(real('Mox Amber', 20)), { games: 2000, seed: 4 });
  const withRock = simulate(amberDeck(withMana(real('Mox Amber', 20), { mask: ANY_COLOR, cond: [] })), { games: 2000, seed: 4 });
  const without = simulate(amberDeck(spell('Trinket', '{0}', 0, 20, { type: 'Legendary Artifact' })), { games: 2000, seed: 4 });
  // On turn 1 Mox Amber makes nothing (no legend out yet); once the commander is out, it does.
  assert.ok(withAmber.turns[0].manaSpent < withRock.turns[0].manaSpent - 0.3, `${withAmber.turns[0].manaSpent} vs ${withRock.turns[0].manaSpent}`);
  assert.ok(withAmber.turns[5].manaSpent > without.turns[5].manaSpent + 0.3, `${withAmber.turns[5].manaSpent} vs ${without.turns[5].manaSpent}`);
});

test('Bloom Tender and Faeburrow Elder make one mana of their own colors', () => {
  assert.equal(real('Bloom Tender').spell.mana.mask, C.G);
  assert.equal(real('Faeburrow Elder').spell.mana.mask, C.G | C.W);
});

test('lands that deal damage: colored mana costs life, Ancient Tomb stays two free {C}', () => {
  assert.deepEqual(real('City of Brass').land.restricted, [{ mask: ANY_COLOR, kind: null, life: 1 }]);
  assert.equal(real('City of Brass').land.utility, false);
  assert.deepEqual(real('Tarnished Citadel').land.restricted, [{ mask: ANY_COLOR, kind: null, life: 3 }]);
  const tomb = real('Ancient Tomb').land;
  assert.deepEqual([tomb.mask, tomb.extra.length, tomb.restricted.length], [C.C, 1, 0]);
});

test('Fanatic of Rhonas: only its {G} is counted; Vesuva makes no mana', () => {
  const fanatic = real('Fanatic of Rhonas');
  assert.deepEqual([fanatic.spell.mana.mask, fanatic.spell.mana.extra.length], [C.G, 0]);
  assert.ok(fanatic.notes.some((n) => /power 4 or greater/.test(n)));
  assert.ok(real('Vesuva').notes.some((n) => /Copying another land/.test(n)));
  assert.deepEqual(real('Echoing Deeps').notes, []);
});

test('Commander hands count cheap rocks and dorks as lands when deciding to keep', () => {
  const leader = { ...normalizeCard({ name: 'Leader', mana_cost: '{2}{G}', cmc: 3, type_line: 'Legendary Creature — Elf', oracle_text: '', color_identity: ['G'] }, 1), commander: 1 };
  const cards = [leader, real('Arcane Signet', 25), basicLandDef('G', 26), spell('Four', '{3}{G}', 4, 48)];
  const rocks = simulate({ cards, format: commander }, { games: 2000, seed: 4 });
  const landsOnly = simulate({ cards, format: { ...commander, keepCountsRocks: false } }, { games: 2000, seed: 4 });
  assert.ok(rocks.mulliganRate < landsOnly.mulliganRate - 0.3, `${rocks.mulliganRate} vs ${landsOnly.mulliganRate}`);
  // Mana Vault is not counted: it makes its mana once.
  const vaults = [leader, real('Mana Vault', 25), basicLandDef('G', 26), spell('Four', '{3}{G}', 4, 48)];
  const vault = simulate({ cards: vaults, format: commander }, { games: 2000, seed: 4 });
  assert.ok(Math.abs(vault.mulliganRate - landsOnly.mulliganRate) < 0.1, `${vault.mulliganRate} vs ${landsOnly.mulliganRate}`);
});
