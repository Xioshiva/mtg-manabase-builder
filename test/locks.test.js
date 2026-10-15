// Lands the user locks keep their decklist counts; the search works around them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeCard } from '../public/lib/cards.js';
import { cardKey, indexCards } from '../public/lib/decklist.js';
import { runAnalysis, matchesName, lockedLandIndexes } from '../public/lib/analysis.js';
import { spell, basicLandDef, card, standard } from './helpers.js';

const raw = JSON.parse(readFileSync(new URL('./fixtures/real/cards.json', import.meta.url), 'utf8'));
const byName = indexCards(raw);
const scry = (name) => {
  const sc = byName.get(cardKey(name));
  assert.ok(sc, `fixture is missing ${name}`);
  return sc;
};
const real = (name, count = 1) => normalizeCard(scry(name), count);

const count = (r, name) => (r.suggested.lands.find((l) => l.name === name) || { count: 0 }).count;
const lands = (r) => r.suggested.lands.reduce((a, l) => a + l.count, 0);
const touched = (r, name) => r.suggested.history.some((h) => h.out === name || h.in === name);
const azorius = (lands) => ({
  cards: [...lands, spell('Two', '{W}{U}', 2, 20), spell('One', '{U}', 1, 16, { type: 'Instant' })],
  format: standard,
});

test('a double-faced land is locked by its front face or its full name; spells are not', () => {
  const pathway = card('Riverglide Pathway', 4);
  assert.equal(pathway.name, 'Riverglide Pathway // Lavaglide Pathway');
  assert.ok(matchesName(pathway, 'Riverglide Pathway'));
  assert.ok(matchesName(pathway, 'riverglide  pathway'));
  assert.ok(matchesName(pathway, 'Riverglide Pathway // Lavaglide Pathway'));
  assert.ok(!matchesName(pathway, 'Lavaglide Pathway'));
  const cards = [spell('Opt', '{U}', 1, 4), pathway, basicLandDef('U', 10), real('Meticulous Archive', 4)];
  assert.deepEqual(lockedLandIndexes(cards, ['Riverglide Pathway', 'Opt', 'island', 'Not In Deck']), [1, 2]);
  assert.deepEqual(lockedLandIndexes(cards, new Set(['Meticulous Archive'])), [3]);
  assert.deepEqual(lockedLandIndexes(cards, []), []);
});

test('in analyze mode a locked tapped dual and a locked basic keep their counts while other lands change', async () => {
  // Too few Plains and a tapped dual: without locks the search adds Plains and drops the dual.
  const model = azorius([real('Meticulous Archive', 4), basicLandDef('W', 2), basicLandDef('U', 18)]);
  const candidateCards = [scry('Hallowed Fountain')];
  const free = await runAnalysis({ model, games: 400, candidateCards });
  assert.ok(count(free, 'Plains') > 2 && count(free, 'Meticulous Archive') < 4);

  const r = await runAnalysis({ model, games: 400, candidateCards, lockedLands: ['meticulous archive', 'Plains'] });
  assert.equal(count(r, 'Meticulous Archive'), 4);
  assert.equal(count(r, 'Plains'), 2);
  assert.ok(!touched(r, 'Meticulous Archive') && !touched(r, 'Plains'));
  assert.ok(r.suggested.history.length > 0);
  assert.ok(count(r, 'Island') < 18 && count(r, 'Hallowed Fountain') > 0);
  assert.equal(lands(r), 24);
  assert.deepEqual(r.suggested.locked, ['Meticulous Archive', 'Plains']);
  // The current manabase is reported as the user wrote it.
  assert.deepEqual(r.current, free.current);
});

test('build mode keeps locked lands and fills the rest of the land count', async () => {
  const model = {
    cards: [card('Riverglide Pathway', 3), basicLandDef('R', 5), basicLandDef('U', 14), real('Stormcarved Coast', 2),
      spell('Two', '{U}{R}', 2, 20), spell('One', '{U}', 1, 16, { type: 'Instant' })],
    format: standard,
  };
  const candidateCards = ['Steam Vents', 'Spirebluff Canal', 'Riverpyre Verge'].map(scry);
  const r = await runAnalysis({ model, mode: 'build', games: 400, landCount: 24, candidateCards, lockedLands: ['Riverglide Pathway', 'Mountain'] });
  assert.equal(count(r, 'Riverglide Pathway // Lavaglide Pathway'), 3);
  assert.equal(count(r, 'Mountain'), 5);
  assert.equal(lands(r), 24);
  assert.ok(count(r, 'Island') > 0); // basics fill only the unlocked colors
  assert.deepEqual(r.suggested.locked, ['Riverglide Pathway // Lavaglide Pathway', 'Mountain']);
  assert.ok(r.suggested.history.length > 0);

  // Locked lands that already make the land count are used as they are.
  const full = await runAnalysis({ model, mode: 'build', games: 400, landCount: 20, candidateCards, lockedLands: ['Riverglide Pathway', 'Mountain', 'Island', 'Stormcarved Coast'] });
  assert.deepEqual(full.suggested.lands.map((l) => [l.name, l.count]), [['Island', 14], ['Mountain', 5], ['Riverglide Pathway // Lavaglide Pathway', 3], ['Stormcarved Coast', 2]]);
});

test('a land count override changes only unlocked basics', async () => {
  // Island is the only unlocked land, so the search has nothing to swap.
  const model = azorius([real('Meticulous Archive', 4), basicLandDef('W', 10), basicLandDef('U', 10)]);
  const lockedLands = ['Meticulous Archive', 'Plains'];
  const more = await runAnalysis({ model, games: 400, landCount: 26, lockedLands });
  assert.deepEqual(more.suggested.lands.map((l) => [l.name, l.count]), [['Island', 12], ['Plains', 10], ['Meticulous Archive', 4]]);
  const fewer = await runAnalysis({ model, games: 400, landCount: 21, lockedLands });
  assert.deepEqual(fewer.suggested.lands.map((l) => [l.name, l.count]), [['Plains', 10], ['Island', 7], ['Meticulous Archive', 4]]);
  // With every land locked there is nothing to remove or add, and the result says so.
  const all = [...lockedLands, 'Island'];
  const stuck = await runAnalysis({ model, games: 400, landCount: 22, lockedLands: all });
  assert.equal(lands(stuck), 24);
  assert.equal(stuck.landCount, 24);
  assert.ok(stuck.notes.some((n) => /locked lands add up to 24 lands, more than the 22/.test(n)), stuck.notes.join('\n'));
  const short = await runAnalysis({ model, games: 400, landCount: 26, lockedLands: all });
  assert.equal(lands(short), 24);
  assert.ok(short.notes.some((n) => /Only 24 lands fit around your locked lands, not 26/.test(n)), short.notes.join('\n'));
});

test('with every basic locked, other unlocked lands make up the land count', async () => {
  const model = azorius([real('Meticulous Archive', 4), basicLandDef('W', 10), basicLandDef('U', 10)]);
  const lockedLands = ['Plains', 'Island'];
  const fewer = await runAnalysis({ model, games: 400, landCount: 22, lockedLands });
  assert.equal(lands(fewer), 22);
  assert.equal(fewer.landCount, 22);
  assert.equal(count(fewer, 'Plains') + count(fewer, 'Island'), 20);
  const candidateCards = [scry('Hallowed Fountain')];
  const more = await runAnalysis({ model, games: 400, landCount: 26, lockedLands, candidateCards });
  assert.equal(lands(more), 26);
  assert.equal(count(more, 'Plains'), 10);
  assert.equal(count(more, 'Island'), 10);
  assert.ok(!more.notes.some((n) => /locked lands/.test(n)));

  // Build mode with both basics locked: duals fill the slots the basics can't.
  const built = await runAnalysis({ model, mode: 'build', games: 400, landCount: 25, lockedLands, candidateCards });
  assert.equal(lands(built), 25);
  assert.equal(count(built, 'Plains') + count(built, 'Island'), 20);
});

test('locked lands are reported under locked, utility lands under kept', async () => {
  const model = azorius([real('Restless Anchorage', 4), real('Meticulous Archive', 4), basicLandDef('W', 8), basicLandDef('U', 8)]);
  const one = await runAnalysis({ model, games: 400, lockedLands: ['Meticulous Archive'] });
  assert.deepEqual(one.suggested.locked, ['Meticulous Archive']);
  assert.deepEqual(one.suggested.kept, ['Restless Anchorage']);
  assert.equal(count(one, 'Meticulous Archive'), 4);
  const both = await runAnalysis({ model, games: 400, lockedLands: ['Two', 'restless anchorage', 'Meticulous Archive', 'Steam Vents'] });
  assert.deepEqual(both.suggested.locked, ['Restless Anchorage', 'Meticulous Archive']);
  assert.deepEqual(both.suggested.kept, []);
  assert.equal(count(both, 'Restless Anchorage'), 4);
  const none = await runAnalysis({ model, games: 400, keepUtility: false });
  assert.deepEqual(none.suggested.locked, []);
  assert.deepEqual(none.suggested.kept, []);
});
