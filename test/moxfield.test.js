import { test } from 'node:test';
import assert from 'node:assert/strict';
import { moxfieldId, moxfieldToDecklist, fetchMoxfieldDeck } from '../public/lib/moxfield.js';
import { parseDecklist } from '../public/lib/decklist.js';

const v3 = {
  name: 'Izzet Cantrips', format: 'standard',
  boards: {
    mainboard: { cards: { a1: { quantity: 4, card: { name: 'Opt' } }, b2: { quantity: 20, card: { name: 'Island' } } } },
    sideboard: { cards: { c3: { quantity: 2, card: { name: 'Negate' } } } },
    commanders: { cards: {} },
  },
};
const v2 = {
  name: 'Niv', format: 'commander',
  commanders: { 'Niv-Mizzet, Parun': { quantity: 1, card: { name: 'Niv-Mizzet, Parun' } } },
  mainboard: { Opt: { quantity: 1, card: { name: 'Opt' } } },
  sideboard: {},
};

test('reads deck ids from Moxfield links', () => {
  assert.equal(moxfieldId('https://www.moxfield.com/decks/AbC123_xyz-9'), 'AbC123_xyz-9');
  assert.equal(moxfieldId('moxfield.com/decks/AbC123?tab=stats'), 'AbC123');
  assert.equal(moxfieldId('AbC123xyz'), 'AbC123xyz');
  assert.equal(moxfieldId('https://archidekt.com/decks/1'), null);
});

test('converts Moxfield v3 and v2 decks to a decklist', () => {
  const a = moxfieldToDecklist(v3);
  assert.equal(a.format, 'standard');
  assert.deepEqual(parseDecklist(a.text).main, [{ name: 'Opt', count: 4 }, { name: 'Island', count: 20 }]);
  const b = moxfieldToDecklist(v2);
  assert.equal(b.format, 'commander');
  const parsed = parseDecklist(b.text);
  assert.deepEqual(parsed.commander, [{ name: 'Niv-Mizzet, Parun', count: 1 }]);
  assert.deepEqual(parsed.main, [{ name: 'Opt', count: 1 }]);
});

test('falls back to the v2 endpoint and reports missing decks', async () => {
  const calls = [];
  const fake = (body, status = 200) => ({ ok: status === 200, status, json: async () => body });
  const fetchImpl = async (url) => { calls.push(url); return url.includes('/v3/') ? fake({}, 403) : fake(v2); };
  const deck = await fetchMoxfieldDeck('abc123', { fetchImpl });
  assert.equal(deck.name, 'Niv');
  assert.equal(calls.length, 2);
  await assert.rejects(fetchMoxfieldDeck('gone12', { fetchImpl: async () => fake({}, 404) }), /not found/);
});
