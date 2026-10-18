// Mana pieces that matter in Pioneer and Modern: fetchlands that find shocks,
// bounce lands, Lotus Field, Temples, Wastes, domain costs and cards with no mana cost.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCard, basicLandDef, landSummary, landColors, describeEffect } from '../public/lib/cards.js';
import { COLOR_BITS, ANY_COLOR } from '../public/lib/mana.js';
import { simulate } from '../public/lib/sim.js';
import { countSources } from '../public/lib/recommend.js';
import { getFormat } from '../public/lib/formats.js';
import { spell } from './helpers.js';

const modern = getFormat('modern');
const C = COLOR_BITS;
const land = (name, text, type = 'Land', count = 1) => normalizeCard({ name, type_line: type, oracle_text: text, mana_cost: '', cmc: 0 }, count);
const strand = (n) => land('Flooded Strand', '{T}, Pay 1 life, Sacrifice this land: Search your library for a Plains or Island card, put it onto the battlefield, then shuffle.', 'Land', n);
const fountain = (n) => land('Hallowed Fountain', '({T}: Add {W} or {U}.)\nAs Hallowed Fountain enters, you may pay 2 life. If you don\'t, it enters tapped.', 'Land — Plains Island', n);
const urza = (type, other1, other2, n, amount) => land(`Urza's ${type}`, `{T}: Add {C}. If you control an Urza's ${other1} and an Urza's ${other2}, add ${'{C}'.repeat(amount)} instead.`, `Land — Urza's ${type}`, n);
const chamber = (n) => land('Simic Growth Chamber', "This land enters tapped.\nWhen this land enters, return a land you control to its owner's hand.\n{T}: Add {G}{U}.", 'Land', n);
const lotus = (n) => land('Lotus Field', 'Hexproof\nThis land enters tapped.\nWhen this land enters, sacrifice two untapped lands.\n{T}: Add three mana of any one color.', 'Land', n);
const sim = (cards, opts = {}) => simulate({ cards, format: modern }, { games: 3000, seed: 3, ...opts });

test('Modern fetchlands find any land with their types; Prismatic Vista finds a basic untapped', () => {
  const f = strand(1).land.fetch;
  assert.deepEqual(f, { types: C.W | C.U, basicOnly: false, tapped: false, untapAt: 0, life: 1, untapIfBehold: null });
  assert.equal(strand(1).land.utility, false);
  assert.equal(landSummary(strand(1).land), 'fetches a Plains or Island, pay 1 life');
  const vista = land('Prismatic Vista', '{T}, Pay 1 life, Sacrifice this land: Search your library for a basic land card, put it onto the battlefield, then shuffle.').land.fetch;
  assert.deepEqual(vista, { types: ANY_COLOR, basicOnly: true, tapped: false, untapAt: 0, life: 1, untapIfBehold: null });
  // A land that searches for "a land card" without a type is not a fetch.
  assert.equal(land('Odd', '{T}, Sacrifice this land: Search your library for a land card, put it onto the battlefield tapped, then shuffle.').land.fetch, null);
});

test('a fetch counts as a source only of the colors it can find in the deck', () => {
  const cards = [strand(4), basicLandDef('U', 10), basicLandDef('R', 6)];
  assert.deepEqual(countSources(cards), { W: 0, U: 14, B: 0, R: 6, G: 0 });
  cards.push(fountain(2));
  assert.deepEqual(countSources(cards), { W: 6, U: 16, B: 0, R: 6, G: 0 });
});

test('fetchlands fetch the colors the hand needs, untapped, and cost life', () => {
  const spells = [spell('Two', '{W}{U}', 2, 20), spell('One', '{U}', 1, 16, { type: 'Instant' })];
  const fetches = sim([strand(12), basicLandDef('W', 6), basicLandDef('U', 6), ...spells]);
  const basics = sim([basicLandDef('W', 12), basicLandDef('U', 12), ...spells]);
  assert.ok(fetches.castOnCurve > basics.castOnCurve + 0.03, `${fetches.castOnCurve} vs ${basics.castOnCurve}`);
  assert.ok(fetches.lifePaidPerGame > 1, `${fetches.lifePaidPerGame}`);
  // A fetch can find a shockland, which costs 2 more life to have untapped.
  const shocks = sim([strand(12), fountain(4), basicLandDef('W', 4), basicLandDef('U', 4), ...spells]);
  assert.ok(shocks.lifePaidPerGame > fetches.lifePaidPerGame, `${shocks.lifePaidPerGame} vs ${fetches.lifePaidPerGame}`);
});

test("Urza's lands count as one {C} each, with a note that the Tron bonus isn't modelled", () => {
  const tower = urza('Tower', 'Mine', 'Power-Plant', 4, 3);
  assert.equal(tower.land.mask, C.C);
  assert.deepEqual(tower.land.extra, []);
  assert.equal(tower.land.utility, false);
  assert.equal(landSummary(tower.land), 'untapped');
  assert.ok(tower.notes.some((n) => n.includes("other Urza's lands is not modelled")), tower.notes.join('; '));
  const big = [spell('Big', '{7}', 7, 12), spell('Mid', '{4}', 4, 12)];
  const filler = [spell('Cheap', '{1}', 1, 12)];
  const tron = sim([tower, urza('Mine', 'Power-Plant', 'Tower', 4, 2), urza('Power-Plant', 'Mine', 'Tower', 4, 2), land('Wastes', '({T}: Add {C}.)', 'Basic Land', 12), ...big, ...filler]);
  const wastes = sim([land('Wastes', '({T}: Add {C}.)', 'Basic Land', 24), ...big, ...filler]);
  assert.ok(Math.abs(tron.manaSpent - wastes.manaSpent) < 0.2, `${tron.manaSpent} vs ${wastes.manaSpent}`);
});

test('bounce lands make two mana but return a land, and return themselves when alone', () => {
  const g = chamber(1).land;
  assert.equal(g.mask, C.G);
  assert.deepEqual(g.extra, [C.U]);
  assert.equal(g.bounce, true);
  assert.equal(g.etb, 'tapped');
  assert.equal(g.utility, false);
  assert.equal(landSummary(g), 'tapped, makes 2 mana, returns a land to your hand');
  const spells = [spell('Five', '{4}{G}', 5, 18), spell('Two', '{1}{U}', 2, 18)];
  const alone = sim([chamber(24), ...spells], { games: 400 });
  assert.equal(alone.manaSpent, 0);
  assert.equal(alone.turns[6].avgLands, 0);
  const mixed = sim([chamber(6), basicLandDef('G', 9), basicLandDef('U', 9), ...spells]);
  const plain = sim([basicLandDef('G', 12), basicLandDef('U', 12), ...spells]);
  assert.ok(mixed.manaSpent > plain.manaSpent, `${mixed.manaSpent} vs ${plain.manaSpent}`);
  assert.ok(mixed.turns[6].avgLands < plain.turns[6].avgLands);
});

test('Lotus Field makes three mana and sacrifices two untapped lands', () => {
  const L = lotus(1).land;
  assert.equal(L.mask, ANY_COLOR);
  assert.deepEqual(L.extra, [ANY_COLOR, ANY_COLOR]);
  assert.equal(L.sacrifice, 2);
  assert.equal(L.utility, false);
  const spells = [spell('Five', '{4}{G}', 5, 18), spell('Two', '{1}{G}', 2, 18)];
  const withField = sim([lotus(4), basicLandDef('G', 20), ...spells]);
  const without = sim([basicLandDef('G', 24), ...spells]);
  assert.ok(withField.turns[6].avgLands < without.turns[6].avgLands - 0.3, `${withField.turns[6].avgLands} vs ${without.turns[6].avgLands}`);
});

test('Temples scry as they enter, and Wastes and snow basics make their mana', () => {
  const temple = land('Temple of Enlightenment', 'This land enters tapped.\nWhen this land enters, scry 1.\n{T}: Add {W} or {U}.').land;
  assert.equal(temple.scry, 1);
  assert.equal(temple.utility, false);
  assert.equal(landSummary(temple), 'tapped, scry 1');
  assert.equal(land('Wastes', '({T}: Add {C}.)', 'Basic Land').land.mask, C.C);
  const snow = land('Snow-Covered Island', '({T}: Add {U}.)', 'Basic Snow Land — Island').land;
  assert.equal(snow.mask, C.U);
  assert.equal(snow.isBasic, true);
});

test('Sol Ring makes two mana; three mana of one color is read as any colors with a note', () => {
  const ring = normalizeCard({ name: 'Sol Ring', mana_cost: '{1}', cmc: 1, type_line: 'Artifact', oracle_text: '{T}: Add {C}{C}.' });
  assert.equal(ring.spell.mana.mask, C.C);
  assert.deepEqual(ring.spell.mana.extra, [C.C]);
  assert.ok(!ring.notes.some((n) => /count as one source/.test(n)));
  assert.ok(lotus(1).notes.some((n) => /must all be one color/.test(n)));
  // "{W} or {U}" is one mana, not two.
  assert.deepEqual(land('Dual', '{T}: Add {W} or {U}.').land.extra, []);
});

test('domain spells get cheaper for each basic land type, and spells with no mana cost are never cast', () => {
  const binding = normalizeCard({ name: 'Leyline Binding', mana_cost: '{5}{W}', cmc: 6, type_line: 'Enchantment', oracle_text: 'Flash\nDomain — This spell costs {1} less to cast for each basic land type among lands you control.\nWhen this enchantment enters, draw two cards.' }, 12);
  assert.equal(binding.spell.domain, 1);
  assert.equal(binding.spell.costReduction, true);
  const scion = normalizeCard({ name: 'Scion of Draco', mana_cost: '{12}', cmc: 12, type_line: 'Artifact Creature — Dragon', oracle_text: 'Domain — This spell costs {2} less to cast for each basic land type among lands you control.\nFlying' });
  assert.equal(scion.spell.domain, 2);
  const triome = (name, types, n) => land(name, 'This land enters tapped.', `Land — ${types}`, n);
  const typed = sim([triome('Raffine', 'Plains Island Swamp', 12), triome('Ziatora', 'Swamp Mountain Forest', 12), binding, spell('Two', '{1}{W}', 2, 24)]);
  const untyped = sim([land('Plain', 'This land enters tapped.\n{T}: Add {W}.', 'Land', 24), binding, spell('Two', '{1}{W}', 2, 24)]);
  assert.ok(typed.drawSpellsPerGame > untyped.drawSpellsPerGame + 0.3, `${typed.drawSpellsPerGame} vs ${untyped.drawSpellsPerGame}`);

  const vision = normalizeCard({ name: 'Ancestral Vision', mana_cost: '', cmc: 0, type_line: 'Sorcery', oracle_text: 'Suspend 4—{U}\nTarget player draws three cards.' }, 20);
  assert.equal(vision.spell.noCost, true);
  assert.ok(vision.notes.some((n) => /never casts it/.test(n)));
  const r = sim([basicLandDef('U', 24), vision, spell('Two', '{1}{U}', 2, 16)], { games: 500 });
  assert.equal(r.drawSpellsPerGame, 0);
});

test('casting a free spell does not end the turn', () => {
  // With no land in hand, free cantrips are cast one after another to find one
  // (the turn used to stop after the first, about 0.47 here).
  const look = normalizeCard({ name: 'Free Look', mana_cost: '{0}', cmc: 0, type_line: 'Instant', oracle_text: 'Draw a card.' }, 24);
  const r = sim([basicLandDef('U', 12), look, spell('One', '{U}', 1, 24, { type: 'Instant' })], { games: 2000 });
  assert.ok(r.turns[3].hitLandDrop > 0.58, `${r.turns[3].hitLandDrop}`);
});

const card = (name, cost, cmc, type, text, n = 4) => normalizeCard({ name, mana_cost: cost, cmc, type_line: type, oracle_text: text }, n);
const filler = (cost, cmc, n, type = 'Artifact') => card(`Filler ${cost}`, cost, cmc, type, '', n);

test('Leyline of the Guildpact in the opening hand starts in play and makes every land every type', () => {
  const leyline = card('Leyline of the Guildpact', '{G/W}{G/U}{B/G}{R/G}', 4, 'Enchantment', 'If Leyline of the Guildpact is in your opening hand, you may begin the game with it on the battlefield.\nEach nonland permanent you control is all colors.\nLands you control are every basic land type in addition to their other types.');
  assert.equal(leyline.spell.leyline, true);
  assert.equal(leyline.spell.grantTypes, ANY_COLOR);
  const spells = [spell('Gold', '{W}{U}', 2, 20), spell('Other', '{1}{G}', 2, 12)];
  const withLeyline = sim([leyline, basicLandDef('G', 24), ...spells]);
  const without = sim([filler('{4}', 4, 4), basicLandDef('G', 24), ...spells]);
  const gold = (r) => r.spells.find((x) => x.name === 'Gold').onCurve;
  assert.equal(gold(without), 0);
  assert.ok(gold(withLeyline) > 0.25, `${gold(withLeyline)}`);
});

test('Urborg makes every land a Swamp', () => {
  const urborg = land('Urborg, Tomb of Yawgmoth', 'Each land is a Swamp in addition to its other land types.', 'Legendary Land', 4);
  assert.equal(urborg.land.grantTypes, C.B);
  assert.equal(urborg.land.mask, C.B); // it is a Swamp itself
  const spells = [spell('Double', '{B}{B}', 2, 20), spell('Green', '{1}{G}', 2, 16)];
  const withUrborg = sim([urborg, basicLandDef('G', 20), ...spells]);
  const swamps = sim([basicLandDef('B', 4), basicLandDef('G', 20), ...spells]);
  const dbl = (r) => r.spells.find((x) => x.name === 'Double').onCurve;
  assert.ok(dbl(withUrborg) > dbl(swamps) + 0.1, `${dbl(withUrborg)} vs ${dbl(swamps)}`);
});

test("Arboreal Grazer and Rampant Growth put lands into play; Amulet of Vigor's untap is only noted", () => {
  const amulet = card('Amulet of Vigor', '{1}', 1, 'Artifact', 'Whenever a permanent you control enters tapped, untap it.');
  assert.equal(amulet.spell.untapLands, false);
  assert.ok(amulet.notes.some((n) => n.includes('enter tapped is not modelled')), amulet.notes.join('; '));
  const big = [spell('Five', '{4}{G}', 5, 16), spell('Three', '{2}{G}', 3, 12)];

  const grazer = card('Arboreal Grazer', '{G}', 1, 'Creature — Sloth Beast', 'Reach\nWhen this creature enters, you may put a land card from your hand onto the battlefield tapped.', 8);
  assert.deepEqual(grazer.spell.landFromHand, { tapped: true });
  const withGrazer = sim([grazer, basicLandDef('G', 24), ...big]);
  const vanilla = sim([filler('{G}', 1, 8, 'Creature — Beast'), basicLandDef('G', 24), ...big]);
  assert.ok(withGrazer.turns[2].avgLands > vanilla.turns[2].avgLands + 0.1, `${withGrazer.turns[2].avgLands} vs ${vanilla.turns[2].avgLands}`);

  const growth = card('Rampant Growth', '{1}{G}', 2, 'Sorcery', 'Search your library for a basic land card, put it onto the battlefield tapped, then shuffle.', 8);
  assert.deepEqual(growth.spell.ramp, { types: ANY_COLOR, basicOnly: true, anyLand: false, count: 1, toHand: 0, tapped: true });
  const withGrowth = sim([growth, basicLandDef('G', 24), ...big]);
  const plain = sim([filler('{1}{G}', 2, 8, 'Sorcery'), basicLandDef('G', 24), ...big]);
  assert.ok(withGrowth.turns[3].avgLands > plain.turns[3].avgLands + 0.3, `${withGrowth.turns[3].avgLands} vs ${plain.turns[3].avgLands}`);

  const titan = card('Primeval Titan', '{4}{G}{G}', 6, 'Creature — Giant', 'Trample\nWhenever Primeval Titan enters or attacks, you may search your library for up to two land cards, put them onto the battlefield tapped, then shuffle.');
  assert.deepEqual(titan.spell.ramp, { types: ANY_COLOR, basicOnly: false, anyLand: true, count: 2, toHand: 0, tapped: true });
  const cultivate = card('Cultivate', '{2}{G}', 3, 'Sorcery', 'Search your library for up to two basic land cards, reveal those cards, put one onto the battlefield tapped and the other into your hand, then shuffle.');
  assert.deepEqual(cultivate.spell.ramp, { types: ANY_COLOR, basicOnly: true, anyLand: false, count: 1, toHand: 1, tapped: true });
  const map = card('Expedition Map', '{1}', 1, 'Artifact', '{2}, {T}, Sacrifice Expedition Map: Search your library for a land card, reveal it, put it into your hand, then shuffle.');
  assert.equal(map.spell.ramp, null);
});

test("Urza's Saga makes {C} until it is sacrificed; Crumbling Vestige adds a mana as it enters", () => {
  const saga = land("Urza's Saga", "(As this Saga enters and after your draw step, add a lore counter. Sacrifice after III.)\nI — Urza's Saga gains \"{T}: Add {C}.\"\nII — Urza's Saga gains \"{2}, {T}: Create a 0/0 colorless Construct artifact creature token with 'This token gets +1/+1 for each artifact you control.'\"\nIII — Search your library for an artifact card with mana cost {0} or {1}, put it onto the battlefield, then shuffle.", "Enchantment Land — Urza's Saga", 24);
  assert.equal(saga.land.mask, C.C);
  assert.equal(saga.land.leavesAfter, 2);
  const r = sim([saga, spell('Two', '{2}', 2, 36)], { games: 1000 });
  assert.ok(r.turns[6].avgLands <= 2 && r.turns[6].avgLands > 0.8, `${r.turns[6].avgLands}`);
  assert.ok(r.turns[1].avgLands > 1.3, `${r.turns[1].avgLands}`);

  const vestige = land('Crumbling Vestige', 'This land enters tapped.\nWhen this land enters, add one mana of any color.\n{T}: Add {C}.', 'Land', 24);
  assert.equal(vestige.land.etbMana, ANY_COLOR);
  assert.equal(vestige.land.utility, false);
  const one = (r2) => r2.spells.find((x) => x.name === 'One').onCurve;
  assert.ok(one(sim([vestige, spell('One', '{W}', 1, 36)])) > 0.5);
  assert.equal(one(sim([land('Colorless', 'This land enters tapped.\n{T}: Add {C}.', 'Land', 24), spell('One', '{W}', 1, 36)])), 0);
});

test('Mox Opal makes mana only with three artifacts in play', () => {
  const opal = card('Mox Opal', '{0}', 0, 'Legendary Artifact', 'Metalcraft — {T}: Add one mana of any color. Activate only if you control three or more artifacts.');
  assert.deepEqual(opal.spell.mana.cond, [{ mask: ANY_COLOR, types: 0, artifacts: 3 }]);
  assert.equal(opal.spell.mana.mask, 0);
  const wastes = land('Wastes', '({T}: Add {C}.)', 'Basic Land', 20);
  const white = (r) => r.spells.find((x) => x.name === 'White').onCurve;
  const withBaubles = sim([opal, wastes, card('Bauble', '{0}', 0, 'Artifact', '', 16), spell('White', '{1}{W}', 2, 20)]);
  const alone = sim([opal, wastes, card('Rock', '{0}', 0, 'Instant', '', 16), spell('White', '{1}{W}', 2, 20)]);
  // Only one Mox Opal stays in play (the legend rule), so it never has metalcraft alone.
  assert.equal(white(alone), 0);
  assert.ok(white(withBaubles) > 0.08, `${white(withBaubles)}`);
});

test('Ancient Stirrings finds lands (they are colorless); Cavalier of Thorns puts a land into play', () => {
  const stirrings = card('Ancient Stirrings', '{G}', 1, 'Sorcery', 'Look at the top five cards of your library. You may reveal a colorless card from among them and put it into your hand. Then put the rest on the bottom of your library in any order.', 12);
  assert.deepEqual(stirrings.spell.effect.takeFilter, ['colorless']);
  const forest = basicLandDef('G', 16);
  const lands = (fourth) => sim([forest, fourth, spell('Big', '{4}{G}', 5, 32)], { games: 3000 }).turns[3].avgLands;
  const stub = card('Stub', '{G}', 1, 'Sorcery', 'Look at the top five cards of your library. You may reveal a creature card from among them and put it into your hand.', 12);
  assert.ok(lands(stirrings) > lands(stub) + 0.1, `${lands(stirrings)} vs ${lands(stub)}`);
  assert.equal(card('Broodscale', '{1}{G}', 2, 'Creature — Eldrazi Lizard', 'Devoid (This card has no color.)').spell.colorless, true);
  assert.equal(card('Bauble', '{0}', 0, 'Artifact', '').spell.colorless, true);
  assert.equal(stirrings.spell.colorless, false);

  const cavalier = card('Cavalier of Thorns', '{2}{G}{G}{G}', 5, 'Creature — Elemental Knight', 'Reach\nWhen this creature enters, reveal the top five cards of your library. Put a land card from among them onto the battlefield and the rest into your graveyard.');
  assert.deepEqual(cavalier.spell.ramp, { types: ANY_COLOR, basicOnly: false, anyLand: true, count: 1, toHand: 0, tapped: false });
});

test('Den of the Bugbear is untapped as one of your first two lands; Phyrexian pips are paid with life', () => {
  const den = land('Den of the Bugbear', 'If you control two or more other lands, this land enters tapped.\n{T}: Add {R}.\n{3}{R}: Until end of turn, this land becomes a 3/2 red Goblin creature. It\'s still a land.');
  assert.equal(den.land.etb, 'fastTwo');
  assert.equal(landSummary(den.land), 'untapped as one of your first two lands');
  const dismember = card('Dismember', '{1}{B/P}{B/P}', 3, 'Instant', 'Target creature gets -5/-5 until end of turn.', 36);
  assert.equal(dismember.spell.phyrexian, 2);
  // Dismember is cast for one mana and two life, so it spends what a one-mana spell does.
  const spent = (c) => sim([basicLandDef('B', 24), c], { games: 1000 }).manaSpent;
  assert.equal(spent(dismember), spent(card('One', '{1}', 1, 'Instant', 'Target creature gets -1/-1 until end of turn.', 36)));
  const dispute = card('Deadly Dispute', '{1}{B}', 2, 'Instant', 'As an additional cost to cast this spell, sacrifice an artifact or creature.\nDraw two cards and create a Treasure token.');
  assert.equal(dispute.spell.treasure.now, 1);
});

test('review fixes: karoo colors, artifact lands, domain notes, ramp that costs a land, every Leyline copy', () => {
  // A bounce land makes both its colors for source counts and dual suggestions.
  assert.equal(landColors(chamber(1).land), C.G | C.U);
  assert.deepEqual(countSources([chamber(4), basicLandDef('G', 8), basicLandDef('U', 8)]), { W: 0, U: 12, B: 0, R: 0, G: 12 });

  // Darksteel Citadel is an artifact, so Mox Opal turns on with two of them.
  const opal = card('Mox Opal', '{0}', 0, 'Legendary Artifact', 'Metalcraft — {T}: Add one mana of any color. Activate only if you control three or more artifacts.');
  const citadel = land('Darksteel Citadel', 'Indestructible\n{T}: Add {C}.', 'Artifact Land', 20);
  assert.equal(citadel.land.isArtifact, true);
  const white = sim([opal, citadel, spell('White', '{1}{W}', 2, 36)]).spells.find((x) => x.name === 'White').onCurve;
  assert.ok(white > 0.05, `${white}`);

  const binding = card('Leyline Binding', '{5}{W}', 6, 'Enchantment', 'Flash\nDomain — This spell costs {1} less to cast for each basic land type among lands you control.\nWhen Leyline Binding enters, exile target nonland permanent an opponent controls until Leyline Binding leaves the battlefield.');
  assert.ok(binding.notes.some((n) => /^Domain makes it cheaper/.test(n)));
  assert.ok(!binding.notes.some((n) => /not modelled/.test(n)));

  const regrowth = card('Roiling Regrowth', '{2}{G}', 3, 'Instant', 'Sacrifice a land. Search your library for up to two basic land cards, put them onto the battlefield tapped, then shuffle.');
  assert.equal(regrowth.spell.ramp.count, 1);
  const harrow = card('Harrow', '{2}{G}', 3, 'Instant', 'As an additional cost to cast this spell, sacrifice a land.\nSearch your library for up to two basic land cards, put them onto the battlefield, then shuffle.');
  assert.equal(harrow.spell.ramp.count, 1);
  const knight = card('Knight of the White Orchid', '{W}{W}', 2, 'Creature — Human Knight', 'First strike\nWhen this creature enters, if an opponent controls more lands than you, you may search your library for a Plains card, put it onto the battlefield, then shuffle.');
  assert.equal(knight.spell.ramp, null);

  // Leylines aren't legendary: every copy in the opening hand starts in play.
  // Twelve copies of one Leyline play exactly like six copies each of two different ones.
  const axe = (name, n) => card(name, '{3}', 3, 'Artifact — Equipment', `If ${name} is in your opening hand, you may begin the game with it on the battlefield.\nEquipped creature gets +1/+1.\nEquip {3}`, n);
  const spent = (axes) => sim([...axes, basicLandDef('R', 24), spell('Two', '{1}{R}', 2, 24)], { games: 2000 }).manaSpent;
  assert.equal(spent([axe('Axe', 12)]), spent([axe('Axe', 6), axe('Other Axe', 6)]));
});

test("review fixes: Urza's Saga taps on its last turn, Spelunking's own land enters untapped, lands that leave are tapped first", () => {
  // Three Sagas played on turns 1-3 can pay for a three-drop on turn 3.
  const saga = land("Urza's Saga", "(As this Saga enters and after your draw step, add a lore counter. Sacrifice after III.)\nI — Urza's Saga gains \"{T}: Add {C}.\"\nII — Urza's Saga gains \"{2}, {T}: Create a 0/0 colorless Construct artifact creature token.\"\nIII — Search your library for an artifact card with mana cost {0} or {1}, put it onto the battlefield, then shuffle.", "Enchantment Land — Urza's Saga", 30);
  const three = sim([saga, spell('Three', '{3}', 3, 30)], { games: 2000, play: 'play' }).spells.find((x) => x.name === 'Three').onCurve;
  assert.ok(three > 0.5, `${three}`);

  const spelunking = card('Spelunking', '{2}{G}', 3, 'Enchantment', 'When Spelunking enters, draw a card, then you may put a land card from your hand onto the battlefield. If you put a Cave onto the battlefield this way, you gain 4 life.\nLands you control enter untapped.', 12);
  assert.equal(spelunking.spell.untapLands, true);
  const temple = land('Temple of Mystery', 'This land enters tapped.\nWhen this land enters, scry 1.\n{T}: Add {G} or {U}.', 'Land', 24);
  const after = (cards) => sim(cards, { games: 2000, seed: 11 }).turns[3].manaSpent;
  const stub = card('Stub', '{2}{G}', 3, 'Enchantment', 'When Stub enters, draw a card, then you may put a land card from your hand onto the battlefield.\nLands you control enter tapped.', 12);
  assert.ok(after([spelunking, temple, spell('One', '{G}', 1, 24)]) > after([stub, temple, spell('One', '{G}', 1, 24)]) + 0.1);

  // A lone bounce land that enters untapped (Spelunking's effect) is tapped for {G}{U} before it returns itself.
  const untapper = card('Spelunking Leyline', '{1}', 1, 'Artifact', 'If this card is in your opening hand, you may begin the game with it on the battlefield.\nLands you control enter untapped.', 20);
  const r = sim([untapper, chamber(24), spell('One', '{G}', 1, 16)], { games: 2000, play: 'play' });
  assert.ok(r.turns[0].manaSpent > 0.3, `${r.turns[0].manaSpent}`);
});

test('cards from the Pioneer and Modern decks: Gemstone Caverns, Sunken Citadel, Lotus Field, Overlord, Outcaster, Light Up the Stage', () => {
  const caverns = land('Gemstone Caverns', "If this card is in your opening hand and you're not the starting player, you may begin the game with Gemstone Caverns on the battlefield with a luck counter on it. If you do, exile a card from your hand.\n{T}: Add {C}. If Gemstone Caverns has a luck counter on it, instead add one mana of any color.", 'Legendary Land');
  assert.equal(caverns.land.mask, C.C);
  const citadel = land('Sunken Citadel', 'This land enters tapped. As it enters, choose a color.\n{T}: Add one mana of the chosen color.\n{T}: Add two mana of the chosen color. Spend this mana only to activate abilities of land sources.', 'Land — Cave');
  assert.equal(landColors(citadel.land), ANY_COLOR);
  assert.equal(citadel.land.etb, 'tapped');

  // Today's Lotus Field text sacrifices any two lands, itself too when there aren't two others
  // (so the simulator waits until there are).
  const field = land('Lotus Field', 'Hexproof\nThis land enters tapped.\nWhen this land enters, sacrifice two lands.\n{T}: Add three mana of any one color.', 'Land', 24);
  assert.equal(field.land.sacrifice, 2);
  assert.equal(field.land.sacrificeUntapped, false);
  assert.equal(landSummary(field.land), 'tapped, makes 3 mana, sacrifice 2 lands');
  assert.ok(sim([field, spell('Two', '{2}', 2, 36)], { games: 1000 }).turns[6].avgLands < 0.5);

  const overlord = card('Overlord of the Hauntwoods', '{3}{G}{G}', 5, 'Enchantment Creature — Avatar Horror', 'Impending 4—{1}{G}{G}\nWhenever this permanent enters or attacks, create a tapped colorless land token named Everywhere that is every basic land type.', 12);
  assert.equal(overlord.spell.landToken.types, ANY_COLOR);
  assert.equal(overlord.spell.landToken.etb, 'tapped');
  const lands = (five) => sim([basicLandDef('G', 24), five, spell('Two', '{1}{G}', 2, 24)], { games: 2000 }).turns[6].avgLands;
  assert.ok(lands(overlord) > lands(card('Vanilla', '{3}{G}{G}', 5, 'Creature — Beast', 'Trample', 12)) + 0.2);

  const trailblazer = card('Outcaster Trailblazer', '{2}{G}', 3, 'Creature — Human Druid', 'When this creature enters, add one mana of any color.\nWhenever another creature you control with power 4 or greater enters, draw a card.');
  assert.deepEqual(trailblazer.spell.etbMana, [ANY_COLOR]);
  assert.equal(card('Gecko', '{1}{R}', 2, 'Creature — Lizard', 'When this creature enters, if an opponent lost life this turn, add {B}{R}.').spell.etbMana, null);

  const stage = card('Light Up the Stage', '{2}{R}', 3, 'Sorcery', 'Spectacle {R}\nExile the top two cards of your library. Until the end of your next turn, you may play those cards.');
  assert.equal(stage.spell.effect.impulse, 2);
  const rumble = card('Malevolent Rumble', '{1}{G}', 2, 'Sorcery', 'Reveal the top four cards of your library. You may put a permanent card from among them into your hand. Put the rest into your graveyard. Create a 0/1 colorless Eldrazi Spawn creature token with "Sacrifice this token: Add {C}."');
  assert.equal(rumble.spell.effect.look, 4);
  assert.deepEqual(rumble.spell.effect.takeFilter, ['permanent']);
});

test("second review fixes: Saga gone on its last turn, Lotus Field waits for two lands, next-turn impulse, leaving lands' mana, Urborg in the library, Springbloom Druid", () => {
  // Urza's Saga is sacrificed on its third turn, so it no longer counts as a land that turn.
  const saga = land("Urza's Saga", "(As this Saga enters and after your draw step, add a lore counter. Sacrifice after III.)\nI — Urza's Saga gains \"{T}: Add {C}.\"\nII — Urza's Saga gains \"{2}, {T}: Create a 0/0 colorless Construct artifact creature token.\"\nIII — Search your library for an artifact card with mana cost {0} or {1}, put it onto the battlefield, then shuffle.", "Enchantment Land — Urza's Saga", 40);
  const sagas = sim([saga, spell('Three', '{3}', 3, 20)], { games: 2000, play: 'play' });
  assert.ok(sagas.turns[2].avgLands <= 2, `${sagas.turns[2].avgLands}`); // 3 when it left at end of turn

  // Today's Lotus Field isn't played onto fewer than two other lands, where it would sacrifice itself.
  const field = land('Lotus Field', 'Hexproof\nThis land enters tapped.\nWhen this land enters, sacrifice two lands.\n{T}: Add three mana of any one color.', 'Land', 12);
  const fields = sim([field, basicLandDef('G', 12), spell('Two', '{1}{G}', 2, 36)], { games: 2000, play: 'play' });
  assert.ok(fields.turns[6].avgLands > 1.3, `${fields.turns[6].avgLands}`); // 1.1 when it was played alone

  // Light Up the Stage's cards can be played until the end of the next turn.
  const stage = card('Light Up the Stage', '{2}{R}', 3, 'Sorcery', 'Spectacle {R}\nExile the top two cards of your library. Until the end of your next turn, you may play those cards.', 40);
  assert.equal(stage.spell.effect.impulseNext, true);
  assert.equal(describeEffect(stage.spell.effect), 'play the top 2 cards until the end of next turn');
  // A land it exiles after this turn's land drop can still be played next turn.
  const staged = sim([stage, basicLandDef('R', 20)], { games: 2000, play: 'play' });
  assert.ok(staged.turns[6].avgLands > 5.9, `${staged.turns[6].avgLands}`); // 5.75 when they expired the same turn

  // A land that leaves is tapped for mana that can pay for any spell: a creature-only color
  // doesn't count. Turn 2's bounce land returns the untapped Cavern, whose {C} can't cast {G}.
  const cavern = land('Creature Cavern', '{T}: Add {C}.\n{T}: Add one mana of any color. Spend this mana only to cast a creature spell.', 'Land', 12);
  const bounced = sim([cavern, chamber(12), spell('Green', '{G}', 1, 36, { type: 'Sorcery' })], { games: 2000, play: 'play' });
  assert.equal(bounced.turns[1].manaSpent, 0);

  // Urborg is only a Swamp on the battlefield, so a fetch for a Swamp can't find it.
  const urborg = land('Urborg, Tomb of Yawgmoth', 'Each land is a Swamp in addition to its other land types.', 'Legendary Land', 1);
  assert.equal(urborg.land.types, 0);
  const delta = land('Polluted Delta', '{T}, Pay 1 life, Sacrifice this land: Search your library for an Island or Swamp card, put it onto the battlefield, then shuffle.', 'Land', 4);
  assert.deepEqual(countSources([delta, urborg, basicLandDef('U', 10)]), { W: 0, U: 14, B: 1, R: 0, G: 0 });

  // Springbloom Druid sacrifices a land to find two, so it nets one.
  const druid = card('Springbloom Druid', '{2}{G}', 3, 'Creature — Elf Druid', 'When this creature enters, you may sacrifice a land. If you do, search your library for up to two basic land cards, put them onto the battlefield tapped, then shuffle.');
  assert.equal(druid.spell.ramp.count, 1);
});
