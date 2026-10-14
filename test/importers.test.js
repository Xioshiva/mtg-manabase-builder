import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMtgtop8Url, fetchMtgtop8Deck } from '../public/lib/mtgtop8.js';
import { recognizeDeckLink } from '../public/lib/importers.js';
import { parseDecklist } from '../public/lib/decklist.js';

// Shape of a real MTGTop8 MTGO export (no "Deck" header, "Sideboard" line before the sideboard).
const EXPORT = '4 Seasoned Cryomancer\r\n4 Watery Grave\r\n3 Swamp\r\nSideboard\r\n2 Negate\r\n';

test('reads MTGTop8 deck and export links', () => {
  assert.deepEqual(parseMtgtop8Url('https://www.mtgtop8.com/event?e=92141&d=899834&f=ST'), { id: '899834', format: 'standard' });
  assert.deepEqual(parseMtgtop8Url('https://www.mtgtop8.com/mtgo?d=899834&f=Standard_Dimir_Control'), { id: '899834', format: null });
  assert.deepEqual(parseMtgtop8Url('https://mtgtop8.com/event?e=1&d=42&f=PI'), { id: '42', format: 'pioneer' });
  assert.equal(parseMtgtop8Url('https://www.mtgtop8.com/format?f=ST'), null);
});

test('routes links to the right importer', () => {
  assert.equal(recognizeDeckLink('https://www.mtgtop8.com/event?e=92141&d=899834&f=ST').site, 'MTGTop8');
  assert.equal(recognizeDeckLink('https://moxfield.com/decks/AbC123xyz').site, 'Moxfield');
  assert.equal(recognizeDeckLink('https://archidekt.com/decks/1'), null);
});

test('fetches the MTGO export and parses it as a decklist', async () => {
  let asked;
  const fetchImpl = async (url) => { asked = url; return { ok: true, status: 200, text: async () => EXPORT }; };
  const deck = await fetchMtgtop8Deck({ id: '899834', format: 'standard' }, { fetchImpl });
  assert.equal(asked, 'https://www.mtgtop8.com/mtgo?d=899834');
  assert.equal(deck.format, 'standard');
  assert.deepEqual(parseDecklist(deck.text).main, [
    { name: 'Seasoned Cryomancer', count: 4 }, { name: 'Watery Grave', count: 4 }, { name: 'Swamp', count: 3 },
  ]);
  await assert.rejects(fetchMtgtop8Deck({ id: '1' }, { fetchImpl: async () => ({ ok: true, status: 200, text: async () => '<html>error</html>' }) }), /not a decklist/);
  await assert.rejects(fetchMtgtop8Deck({ id: '1' }, { fetchImpl: async () => { throw new Error('x'); } }), /couldn't reach/);
});
