// Duel Commander and Commander: the commander waits in the command zone, every card must fit
// its color identity, and MTGTop8's exports list the commander as the sideboard.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCard, basicLandDef } from '../public/lib/cards.js';
import { simulate } from '../public/lib/sim.js';
import { buildModel, commandersOf } from '../public/lib/analysis.js';
import { landCountSweep } from '../public/lib/optimize.js';
import { parseDecklist, cardKey } from '../public/lib/decklist.js';
import { getFormat } from '../public/lib/formats.js';
import { parseMtgtop8Url, fetchMtgtop8Deck } from '../public/lib/mtgtop8.js';
import { moxfieldToDecklist } from '../public/lib/moxfield.js';

const duel = getFormat('duel');
const card = (name, cost, cmc, type, colors = [], extra = {}) => ({ name, mana_cost: cost, cmc, type_line: type, oracle_text: '', color_identity: colors, legalities: { duel: 'legal', commander: 'legal' }, ...extra });

test('Duel Commander: 100 cards, 1v1, the usual mulligan, its own legality', () => {
  assert.equal(duel.name, 'Duel Commander');
  assert.equal(duel.status, 'ready');
  assert.equal(duel.deckSize, 100);
  assert.equal(duel.librarySize, 99);
  assert.equal(duel.maxCopies, 1);
  assert.equal(duel.freeMulligan, false);
  assert.equal(duel.multiplayer, false);
  assert.equal(duel.legalityKey, 'duel');
  assert.equal(duel.commander, true);
  assert.equal(getFormat('commander').commander, true);
  assert.equal(getFormat('commander').freeMulligan, true);
});

test('the commander is always there to cast and never drawn', () => {
  const commander = { ...normalizeCard(card('Leader', '{1}{R}', 2, 'Legendary Creature — Goblin', ['R']), 1), commander: 1 };
  const inLibrary = normalizeCard(card('Leader', '{1}{R}', 2, 'Legendary Creature — Goblin', ['R']), 1);
  const rest = [basicLandDef('R', 38), normalizeCard(card('Filler', '{5}', 5, 'Artifact'), 61)];
  const zone = simulate({ cards: [commander, ...rest], format: duel }, { games: 2000 });
  const drawn = simulate({ cards: [inLibrary, ...rest], format: duel }, { games: 2000 });
  const lead = (r) => r.spells.find((s) => s.name === 'Leader');
  assert.equal(lead(zone).inHand, 1); // available on turn 2 of every game
  assert.equal(lead(zone).commander, true);
  assert.ok(lead(drawn).inHand < 0.15, `${lead(drawn).inHand}`);
  assert.ok(lead(zone).onCurve > 0.9, `${lead(zone).onCurve}`);
});

test('the bot plays the land that lets the commander come down', () => {
  // Nothing in hand is castable on turn 2, so only the commander tells an untapped land from a tapped one.
  const commander = { ...normalizeCard(card('Leader', '{1}{R}', 2, 'Legendary Creature — Goblin', ['R']), 1), commander: 1 };
  const tapland = normalizeCard(card('Tapland', '', 0, 'Land', ['R'], { oracle_text: 'This land enters tapped.\n{T}: Add {R}.' }), 19);
  const rest = [basicLandDef('R', 19), tapland, normalizeCard(card('Filler', '{5}', 5, 'Artifact'), 61)];
  const r = simulate({ cards: [commander, ...rest], format: duel }, { games: 2000, seed: 5 });
  assert.ok(r.spells.find((s) => s.name === 'Leader').onCurve > 0.8, `${r.spells.find((s) => s.name === 'Leader').onCurve}`);
});

test('Duel Commander lets only one partner come from the command zone', () => {
  const partner = (name) => ({ ...normalizeCard(card(name, '{1}{R}', 2, 'Legendary Creature — Human', ['R']), 1), commander: 1 });
  const cards = [partner('Left'), partner('Right'), basicLandDef('R', 38), normalizeCard(card('Filler', '{6}', 6, 'Artifact'), 60)];
  const one = simulate({ cards, format: duel }, { games: 2000, seed: 5 });
  const both = simulate({ cards, format: { ...duel, oneCommanderCast: false } }, { games: 2000, seed: 5 });
  // On turn 3 the second partner is the only thing to cast, and Duel Commander doesn't allow it.
  assert.ok(both.turns[2].manaSpent > one.turns[2].manaSpent + 1.5, `${both.turns[2].manaSpent} vs ${one.turns[2].manaSpent}`);
});

test('a land-count sweep never cuts the commander', async () => {
  const commander = { ...normalizeCard(card('Big Leader', '{6}{R}', 7, 'Legendary Creature — Giant', ['R']), 1), commander: 1 };
  const model = { cards: [commander, basicLandDef('R', 38), normalizeCard(card('Two', '{1}{R}', 2, 'Creature — Goblin', ['R']), 61)], format: duel };
  let counts;
  const sim = { simulateMany: async (m, list) => { counts = list; return list.map(() => ({ castOnCurve: 0, turns: [], floodRate: 0, manaSpent: 0 })); } };
  await landCountSweep(model, [2], { sim });
  assert.equal(counts[0][0], 1); // the commander stays
  assert.equal(counts[0][2], 59); // two two-drops make room for two more lands
});

test('commandersOf: the Commander section, or a short sideboard in commander formats', () => {
  const mtgo = parseDecklist('1 Bolt\n98 Mountain\n\n1 Leader\n');
  assert.deepEqual(commandersOf(mtgo, duel), [{ name: 'Leader', count: 1 }]);
  assert.deepEqual(commandersOf(mtgo, getFormat('modern')), []);
  assert.deepEqual(commandersOf(parseDecklist('Commander\n1 Boss\n\nDeck\n1 Bolt\n\nSideboard\n1 Leader\n'), duel), [{ name: 'Boss', count: 1 }]);
  assert.deepEqual(commandersOf(parseDecklist('1 Bolt\n\nSideboard\n1 A\n1 B\n1 C\n'), duel), []);
});

test('buildModel marks the commander, takes it from a one-card sideboard, and checks color identity', () => {
  const cards = new Map([
    ['Leader', card('Leader', '{1}{R}', 2, 'Legendary Creature — Goblin', ['R'])],
    ['Bolt', card('Bolt', '{R}', 1, 'Instant', ['R'])],
    ['Counterspell', card('Counterspell', '{U}{U}', 2, 'Instant', ['U'])],
  ].map(([n, c]) => [cardKey(n), c]));
  const withHeader = buildModel(parseDecklist('Commander\n1 Leader\n\nDeck\n1 Bolt\n98 Mountain\n'), cards, duel);
  assert.equal(withHeader.model.cards.find((d) => d.name === 'Leader').commander, 1);
  assert.deepEqual(withHeader.warnings, []);

  // An MTGO export: the commander is the sideboard.
  const mtgo = buildModel(parseDecklist('1 Bolt\n1 Counterspell\n97 Mountain\n\n1 Leader\n'), cards, duel);
  assert.equal(mtgo.model.cards.find((d) => d.name === 'Leader').commander, 1);
  assert.ok(mtgo.warnings.some((w) => w.includes('Using the sideboard (Leader) as the commander')), mtgo.warnings.join('\n'));
  assert.ok(mtgo.warnings.some((w) => w.includes("Outside the commander's color identity: Counterspell")), mtgo.warnings.join('\n'));
  assert.ok(!mtgo.warnings.some((w) => w.includes('Mountain')));

  const none = buildModel(parseDecklist('1 Bolt\n99 Mountain\n'), cards, duel);
  assert.ok(none.warnings.some((w) => w.includes('No commander found')));
  // Other formats don't treat the sideboard as a commander.
  const modern = buildModel(parseDecklist('4 Bolt\n56 Mountain\n\n1 Leader\n'), cards, getFormat('modern'));
  assert.ok(!modern.model.cards.some((d) => d.commander));
});

test("MTGTop8's EDH is Duel Commander, cEDH is Commander, and the export's sideboard becomes the commander", async () => {
  assert.deepEqual(parseMtgtop8Url('https://www.mtgtop8.com/event?e=92278&d=900971&f=EDH'), { id: '900971', format: 'duel' });
  assert.deepEqual(parseMtgtop8Url('https://www.mtgtop8.com/event?e=1&d=2&f=cEDH'), { id: '2', format: 'commander' });
  const text = '1 Lightning Bolt\n1 Sol Ring\n98 Mountain\n\nSideboard\n1 Aerid Konstrari\n';
  const deck = await fetchMtgtop8Deck({ id: '900971', format: 'duel' }, { fetchImpl: async () => ({ ok: true, status: 200, text: async () => text }) });
  const parsed = parseDecklist(deck.text);
  assert.deepEqual(parsed.commander, [{ name: 'Aerid Konstrari', count: 1 }]);
  assert.deepEqual(parsed.sideboard, []);
  assert.equal(parsed.main.length, 3);
  // A 60-card format keeps its sideboard.
  const modern = await fetchMtgtop8Deck({ id: '1', format: 'modern' }, { fetchImpl: async () => ({ ok: true, status: 200, text: async () => '4 Lightning Bolt\n56 Mountain\n\n2 Abrade\n' }) });
  assert.deepEqual(parseDecklist(modern.text).sideboard, [{ name: 'Abrade', count: 2 }]);
  assert.equal(moxfieldToDecklist({ format: 'duelCommander', boards: { mainboard: { cards: {} } } }).format, 'duel');
});
