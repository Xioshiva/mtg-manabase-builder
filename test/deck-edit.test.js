import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { parseDecklist, formatDecklist, changeCount, replaceLands, cardKey } from '../public/lib/decklist.js';
import { createDeckStore, KEY } from '../public/lib/deckstore.js';
import { isBasicName } from '../public/lib/cards.js';
import { izzetText } from './helpers.js';

const decksDir = new URL('./fixtures/real/decks/', import.meta.url);
const realCards = JSON.parse(readFileSync(new URL('./fixtures/real/cards.json', import.meta.url), 'utf8'));
const realByKey = new Map(realCards.map((c) => [cardKey(c.name), c]));
// Basics aren't in the fixture, so they're recognised by name.
const isRealLand = (name) => isBasicName(name) || /\bLand\b/.test((realByKey.get(cardKey(name)) || {}).type_line || '');
const sections = (d) => ({ commander: d.commander, main: d.main, sideboard: d.sideboard });

test('reads the sideboard of Arena, MTGO and SB: lists', () => {
  const arena = parseDecklist('Deck\n4 Opt (M21) 59\n2x Shock\n\nSideboard\n3 Negate\n1 Duress (M21) 96\n');
  assert.deepEqual(arena.main, [{ name: 'Opt', count: 4 }, { name: 'Shock', count: 2 }]);
  assert.deepEqual(arena.sideboard, [{ name: 'Negate', count: 3 }, { name: 'Duress', count: 1 }]);

  const mtgo = parseDecklist('4 Opt\n20 Island\n\n3 Negate\n2 Duress\n');
  assert.deepEqual(mtgo.main, [{ name: 'Opt', count: 4 }, { name: 'Island', count: 20 }]);
  assert.deepEqual(mtgo.sideboard, [{ name: 'Negate', count: 3 }, { name: 'Duress', count: 2 }]);

  // Leading blank lines don't start the sideboard.
  assert.deepEqual(parseDecklist('\n\n4 Opt\n').main, [{ name: 'Opt', count: 4 }]);

  const dec = parseDecklist('4 Opt\nSB: 2 Negate\n20 Island\nSB:  1 Duress\nsb: 1 Negate\nSB:\n');
  assert.deepEqual(dec.main, [{ name: 'Opt', count: 4 }, { name: 'Island', count: 20 }]);
  assert.deepEqual(dec.sideboard, [{ name: 'Negate', count: 3 }, { name: 'Duress', count: 1 }]);
  assert.deepEqual(dec.errors, []);

  const other = parseDecklist('Companion\n1 Lurrus of the Dream-Den\nDeck\n4 Opt\nMaybeboard\n1 Shock\nSide:\n1 Negate\n');
  assert.deepEqual(other.main, [{ name: 'Opt', count: 4 }]);
  assert.deepEqual(other.sideboard.map((c) => c.name), ['Negate']);
  assert.deepEqual(other.companion, [{ name: 'Lurrus of the Dream-Den', count: 1 }]);
  assert.deepEqual(other.maybeboard, [{ name: 'Shock', count: 1 }]);

  assert.deepEqual(parseDecklist('Commander\n1 Niv-Mizzet, Parun\nDeck\n1 Opt\n').sideboard, []);
  assert.deepEqual(parseDecklist(izzetText).sideboard, [{ name: 'Glorybringer', count: 2 }]);
});

test('strips every suffix from export lines, including foil after the number', () => {
  const parsed = parseDecklist('1 Sol Ring (CMM) 464 *F*\n2 Opt [M21]\n1 Fire // Ice (MH2) 290');
  assert.deepEqual(parsed.main.map((c) => c.name), ['Sol Ring', 'Opt', 'Fire']);
});

test('real MTGTop8 exports keep a 60-card main and a 15-card sideboard', () => {
  for (const file of readdirSync(decksDir).filter((f) => f.endsWith('.txt'))) {
    const parsed = parseDecklist(readFileSync(new URL(file, decksDir), 'utf8'));
    const total = (list) => list.reduce((a, c) => a + c.count, 0);
    assert.equal(total(parsed.main), 60, file);
    assert.equal(total(parsed.sideboard), 15, file);
  }
});

test('formats Arena-style text', () => {
  assert.equal(formatDecklist({ main: [{ name: 'Opt', count: 4 }, { name: 'Shock', count: 0 }] }), 'Deck\n4 Opt\n');
  assert.equal(
    formatDecklist({
      commander: [{ name: 'Niv-Mizzet, Parun', count: 1 }],
      main: [{ name: 'Opt', count: 1 }, { name: 'Island', count: 30 }],
      sideboard: [{ name: 'Negate', count: 2 }, { name: 'Duress', count: -1 }],
    }),
    'Commander\n1 Niv-Mizzet, Parun\n\nDeck\n1 Opt\n30 Island\n\nSideboard\n2 Negate\n',
  );
  assert.equal(formatDecklist({ commander: [], main: [{ name: 'Opt', count: 4 }], sideboard: [] }), 'Deck\n4 Opt\n');
});

test('formatDecklist round trips through parseDecklist', () => {
  const texts = [
    izzetText,
    'Commander\n1 Niv-Mizzet, Parun\nDeck\n1 Opt\n1 Fire // Ice\n\nSideboard\n1 Negate\n',
    '4 Opt\n20 Island\n\n3 Negate\n',
    '4 Opt\nSB: 2 Negate\n',
    'Commander\n1 Kíli the Resourceful\n',
    'Deck\n\nSideboard\n2 Negate\n',
    '1 Sol Ring (CMM) 464 *F*\n2x X-Ray Vision\n1 Kili the Resourceful\n',
    ...readdirSync(decksDir).filter((f) => f.endsWith('.txt')).map((f) => readFileSync(new URL(f, decksDir), 'utf8')),
  ];
  for (const text of texts) {
    const once = parseDecklist(text);
    const twice = parseDecklist(formatDecklist(once));
    assert.deepEqual(sections(twice), sections(once), text);
    assert.deepEqual(twice.errors, []);
    assert.equal(formatDecklist(twice), formatDecklist(once));
  }
});

test('changeCount adds, removes and matches names loosely', () => {
  const deck = { main: [{ name: 'Opt', count: 4 }, { name: 'Kíli the Resourceful', count: 1 }], commander: [], sideboard: [{ name: 'Negate', count: 2 }] };
  const before = structuredClone(deck);

  assert.deepEqual(changeCount(deck, 'main', 'Opt', 1).main, [{ name: 'Opt', count: 5 }, { name: 'Kíli the Resourceful', count: 1 }]);
  assert.deepEqual(changeCount(deck, 'main', 'opt', -3).main[0], { name: 'Opt', count: 1 });
  assert.deepEqual(changeCount(deck, 'main', 'OPT', -4).main, [{ name: 'Kíli the Resourceful', count: 1 }]);
  assert.deepEqual(changeCount(deck, 'main', 'Opt', -9).main, [{ name: 'Kíli the Resourceful', count: 1 }]);
  assert.deepEqual(changeCount(deck, 'main', 'kili  the resourceful', 2).main[1], { name: 'Kíli the Resourceful', count: 3 });
  assert.deepEqual(changeCount(deck, 'main', 'Shock', 2).main[2], { name: 'Shock', count: 2 });
  assert.equal(changeCount(deck, 'main', 'Shock', -1).main.length, 2);
  assert.deepEqual(changeCount(deck, 'sideboard', 'negate', -2).sideboard, []);
  assert.deepEqual(changeCount(deck, 'sideboard', 'Negate', 1).main, deck.main);

  // Missing sections count as empty.
  const bare = changeCount({ main: [] }, 'commander', 'Niv-Mizzet, Parun', 1);
  assert.deepEqual(bare, { main: [], commander: [{ name: 'Niv-Mizzet, Parun', count: 1 }], sideboard: [], companion: [], maybeboard: [] });
  assert.deepEqual(changeCount({ main: [] }, 'sideboard', 'Negate', -1).sideboard, []);
  assert.throws(() => changeCount(deck, 'maybe', 'Opt', 1), /Unknown deck section/);

  // The input and its entries are untouched, and the result shares nothing with it.
  const out = changeCount(deck, 'main', 'Opt', 1);
  assert.deepEqual(deck, before);
  assert.notEqual(out, deck);
  for (const s of ['main', 'commander', 'sideboard']) {
    assert.notEqual(out[s], deck[s]);
    out[s].forEach((c, i) => assert.notEqual(c, deck[s][i]));
  }
});

test('changeCount keeps other deck fields', () => {
  const out = changeCount({ main: [], errors: ['??'], name: 'Izzet' }, 'main', 'Opt', 1);
  assert.equal(out.name, 'Izzet');
  assert.deepEqual(out.errors, ['??']);
});

test('names from Scryfall ("Front // Back") find the front-face entry the list has', () => {
  const deck = parseDecklist('Deck\n4 Riverglide Pathway\n2 Fire // Ice\n');
  const more = changeCount(deck, 'main', 'Riverglide Pathway // Lavaglide Pathway', 1);
  assert.deepEqual(more.main, [{ name: 'Riverglide Pathway', count: 5 }, { name: 'Fire', count: 2 }]);
  assert.deepEqual(changeCount(deck, 'main', 'Fire // Ice', 1).main[1], { name: 'Fire', count: 3 });
  assert.deepEqual(changeCount(deck, 'main', 'Sink into Stupor // Soporific Springs', 1).main[2], { name: 'Sink into Stupor', count: 1 });
  const rows = replaceLands(deck, (n) => /Pathway/.test(n), [{ name: 'Riverglide Pathway // Lavaglide Pathway', count: 3 }]);
  assert.deepEqual(rows.main[0], { name: 'Riverglide Pathway', count: 3 });
});

test('an Arena companion survives an edit without turning into sideboard copies', () => {
  const text = 'Companion\n1 Lurrus of the Dream-Den (IKO) 226\n\nDeck\n4 Opt (M21) 59\n20 Island (M21) 264\n\nSideboard\n1 Lurrus of the Dream-Den (IKO) 226\n2 Negate (M21) 52\n\nMaybeboard\n3 Counterspell\n';
  const edited = formatDecklist(changeCount(parseDecklist(text), 'main', 'Opt', -1));
  assert.equal(edited, 'Companion\n1 Lurrus of the Dream-Den\n\nDeck\n3 Opt\n20 Island\n\nSideboard\n1 Lurrus of the Dream-Den\n2 Negate\n\nMaybeboard\n3 Counterspell\n');
});

test('replaceLands swaps the manabase in place', () => {
  const lands = new Set(['island', 'mountain', 'spirebluff canal']);
  const isLand = (name) => lands.has(cardKey(name));
  const deck = {
    main: [{ name: 'Opt', count: 4 }, { name: 'Island', count: 8 }, { name: 'Shock', count: 4 }, { name: 'Mountain', count: 6 }, { name: 'Spirebluff Canal', count: 4 }],
    sideboard: [{ name: 'Island', count: 1 }],
  };
  const before = structuredClone(deck);
  const rows = [{ name: 'Island', count: 7 }, { name: 'Mountain', count: 5 }, { name: 'Steam Vents', count: 0 }, { name: 'Thundering Falls', count: 4 }];
  const out = replaceLands(deck, isLand, rows);
  assert.deepEqual(out.main, [
    { name: 'Opt', count: 4 }, { name: 'Island', count: 7 }, { name: 'Mountain', count: 5 },
    { name: 'Thundering Falls', count: 4 }, { name: 'Shock', count: 4 },
  ]);
  assert.deepEqual(out.sideboard, [{ name: 'Island', count: 1 }]);
  assert.deepEqual(out.commander, []);
  assert.deepEqual(deck, before);
  assert.notEqual(out.main[1], rows[0]);

  const noLands = replaceLands({ main: [{ name: 'Opt', count: 4 }] }, isLand, [{ name: 'Island', count: 20 }]);
  assert.deepEqual(noLands.main, [{ name: 'Opt', count: 4 }, { name: 'Island', count: 20 }]);
  assert.deepEqual(replaceLands(deck, isLand, []).main, [{ name: 'Opt', count: 4 }, { name: 'Shock', count: 4 }]);
});

test('replaceLands on a real deck keeps the spells and the land count', () => {
  const parsed = parseDecklist(readFileSync(new URL('dimir-control-899834.txt', decksDir), 'utf8'));
  const landCount = parsed.main.filter((c) => isRealLand(c.name)).reduce((a, c) => a + c.count, 0);
  assert.ok(landCount > 20);
  const out = replaceLands(parsed, isRealLand, [{ name: 'Island', count: landCount - 4 }, { name: 'Swamp', count: 4 }]);
  assert.deepEqual(out.main.filter((c) => !isRealLand(c.name)), parsed.main.filter((c) => !isRealLand(c.name)));
  assert.equal(out.main.reduce((a, c) => a + c.count, 0), 60);
  assert.deepEqual(out.sideboard, parsed.sideboard);
});

// In-memory stand-in for localStorage.
function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => { data.set(k, String(v)); },
    removeItem: (k) => { data.delete(k); },
  };
}

test('deck store saves, lists, replaces and removes decks', () => {
  const storage = memoryStorage();
  const store = createDeckStore(storage);
  assert.deepEqual(store.list(), []);
  assert.equal(store.get('Izzet'), null);

  const saved = store.save({ name: '  Izzet Cantrips ', text: izzetText, format: 'standard', locks: ['Island'], savedAt: 100 });
  assert.deepEqual(saved, { name: 'Izzet Cantrips', text: izzetText, format: 'standard', locks: ['Island'], savedAt: 100 });
  store.save({ name: 'Niv', text: 'Commander\n1 Niv-Mizzet, Parun\n', format: 'commander', savedAt: 300 });
  store.save({ name: 'Mono Red', text: '20 Mountain\n', format: 'standard', savedAt: 200 });

  assert.deepEqual(store.list(), [
    { name: 'Niv', format: 'commander', savedAt: 300 },
    { name: 'Mono Red', format: 'standard', savedAt: 200 },
    { name: 'Izzet Cantrips', format: 'standard', savedAt: 100 },
  ]);
  assert.deepEqual(store.get('izzet cantrips').locks, ['Island']);
  assert.deepEqual(store.get('niv').locks, []);
  assert.deepEqual(JSON.parse(storage.data.get(KEY)).length, 3);
  assert.equal(KEY, 'manabase-saved-decks-v1');

  // Same name, any case: replaced, not duplicated.
  store.save({ name: 'IZZET CANTRIPS', text: '4 Opt\n', format: 'pioneer', savedAt: 400 });
  assert.equal(store.list().length, 3);
  assert.deepEqual(store.list()[0], { name: 'IZZET CANTRIPS', format: 'pioneer', savedAt: 400 });
  assert.equal(store.get('Izzet Cantrips').text, '4 Opt\n');

  // A second store on the same storage sees the same decks.
  assert.equal(createDeckStore(storage).get('mono red').text, '20 Mountain\n');

  assert.equal(store.remove('mono RED'), true);
  assert.equal(store.remove('Mono Red'), false);
  assert.deepEqual(store.list().map((d) => d.name), ['IZZET CANTRIPS', 'Niv']);
});

test('deck store defaults the save time and rejects empty names', () => {
  const store = createDeckStore(memoryStorage());
  const t = Date.now();
  const saved = store.save({ name: 'Izzet', text: '4 Opt\n' });
  assert.ok(saved.savedAt >= t && saved.savedAt <= Date.now());
  assert.deepEqual(saved.locks, []);
  assert.equal(saved.format, null);
  // Same-time saves list the later one first.
  store.save({ name: 'Grixis', text: '', savedAt: saved.savedAt });
  assert.equal(store.list()[0].name, 'Grixis');
  assert.throws(() => store.save({ name: '   ', text: '4 Opt' }), { message: 'Give the deck a name.' });
  assert.throws(() => store.save({ text: '4 Opt' }), { message: 'Give the deck a name.' });
  assert.equal(store.list().length, 2);
});

test('deck store treats corrupt data as empty', () => {
  for (const junk of ['{not json', '{"name":"x"}', '42', 'null']) {
    const storage = memoryStorage({ [KEY]: junk });
    const store = createDeckStore(storage);
    assert.deepEqual(store.list(), [], junk);
    assert.equal(store.get('x'), null);
    store.save({ name: 'Izzet', text: '4 Opt\n', savedAt: 1 });
    assert.deepEqual(store.list(), [{ name: 'Izzet', format: null, savedAt: 1 }]);
  }
  // Bad entries are skipped, good ones kept.
  const mixed = JSON.stringify([null, { text: 'no name' }, { name: '' }, { name: 'Ok', text: '1 Opt\n', savedAt: 'soon' }]);
  const store = createDeckStore(memoryStorage({ [KEY]: mixed }));
  assert.deepEqual(store.list(), [{ name: 'Ok', format: null, savedAt: 0 }]);
  assert.deepEqual(store.get('ok'), { name: 'Ok', text: '1 Opt\n', format: null, locks: [], savedAt: 0 });
});

test('deck store survives missing or refusing storage', () => {
  const refused = /browser refused to store the deck/;
  const missing = createDeckStore(undefined);
  assert.deepEqual(missing.list(), []);
  assert.equal(missing.get('Izzet'), null);
  assert.equal(missing.remove('Izzet'), false);
  assert.throws(() => missing.save({ name: 'Izzet', text: '' }), refused);

  // Default argument outside a browser: no localStorage, no crash.
  assert.deepEqual(createDeckStore().list(), []);

  const throwing = { getItem() { throw new Error('SecurityError'); }, setItem() { throw new Error('SecurityError'); } };
  const blocked = createDeckStore(throwing);
  assert.deepEqual(blocked.list(), []);
  assert.equal(blocked.get('Izzet'), null);
  assert.equal(blocked.remove('Izzet'), false);
  assert.throws(() => blocked.save({ name: 'Izzet', text: '' }), refused);
  assert.throws(() => blocked.save({ name: '' }), /Give the deck a name/);

  // Full storage: reads work, writes throw.
  const storage = memoryStorage();
  createDeckStore(storage).save({ name: 'Izzet', text: '4 Opt\n', savedAt: 1 });
  storage.setItem = () => { throw new Error('QuotaExceededError'); };
  const full = createDeckStore(storage);
  assert.throws(() => full.save({ name: 'Grixis', text: '' }), refused);
  assert.equal(full.remove('Izzet'), false);
  assert.deepEqual(full.list(), [{ name: 'Izzet', format: null, savedAt: 1 }]);
});

test('saved locks that are not names are dropped when read', () => {
  const store = createDeckStore(memoryStorage({ [KEY]: JSON.stringify([{ name: 'X', text: '4 Opt', locks: [null, 'Island', 3] }]) }));
  assert.deepEqual(store.get('X').locks, ['Island']);
});
