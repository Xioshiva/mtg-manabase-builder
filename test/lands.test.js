// Legal dual lands for a deck's colors (lands.js) and card images (scryfall.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { landOptions, landsForColor } from '../public/lib/lands.js';
import { trimCard, cardImage } from '../public/lib/scryfall.js';
import { raw as toyCards } from './helpers.js';

const real = JSON.parse(readFileSync(new URL('./fixtures/real/cards.json', import.meta.url), 'utf8'));
const realLands = real.filter((c) => /\bLand\b/.test(c.type_line || ''));
const names = (opts) => opts.map((o) => o.name);
const has = (name) => real.some((c) => c.name === name);

test('landOptions offers the UR duals and fetches, and nothing mono or off-color', () => {
  const opts = landOptions(realLands, ['U', 'R']);
  for (const n of ['Spirebluff Canal', 'Steam Vents', 'Riverpyre Verge', 'Stormcarved Coast', 'Fabled Passage', 'Multiversal Passage']) {
    if (has(n)) assert.ok(names(opts).includes(n), `${n} should be offered`);
  }
  // Mono-color, colorless and off-color lands are left out.
  for (const n of ["Theorist's Sanctum", 'The Lonely Mountain', 'Cryptic Caves', 'Watery Grave', 'Blood Crypt', 'Sacred Foundry', 'Breeding Pool', 'Gloomlake Verge', 'Cavern of Souls']) {
    if (has(n)) assert.ok(!names(opts).includes(n), `${n} should not be offered`);
  }
  for (const o of opts) {
    assert.equal(o.colors, 'UR');
    assert.equal(typeof o.how, 'string');
    assert.ok(o.how.length > 0);
    assert.equal(typeof o.quality, 'number');
    assert.ok(o.card && o.card.name === o.name, 'entry keeps the Scryfall card');
  }
  const vents = opts.find((o) => o.name === 'Steam Vents');
  assert.equal(vents.etb, 'shock');
  assert.equal(vents.how, 'untapped (pay 2 life)');
  const fetch = opts.find((o) => o.name === 'Fabled Passage');
  assert.match(fetch.how, /^fetches a basic/);
});

test('landOptions sorts by quality, then name', () => {
  const opts = landOptions(realLands, ['U', 'R']);
  for (let i = 1; i < opts.length; i++) {
    const a = opts[i - 1];
    const b = opts[i];
    assert.ok(a.quality > b.quality || (a.quality === b.quality && a.name.localeCompare(b.name) <= 0), `${a.name} before ${b.name}`);
  }
  // Same order whatever order the lands come in.
  assert.deepEqual(names(landOptions([...realLands].reverse(), ['U', 'R'])), names(opts));
});

test('a shockland ranks above a plain tapped dual', () => {
  const ub = names(landOptions(realLands, ['U', 'B']));
  assert.ok(ub.includes('Watery Grave') && ub.includes('Restless Reef'));
  assert.ok(ub.indexOf('Watery Grave') < ub.indexOf('Restless Reef'));
  const ur = names(landOptions(toyCards, ['U', 'R']));
  assert.ok(ur.indexOf('Steam Vents') < ur.indexOf('Thundering Falls'));
  // A made-up tapped dual sorts below the shock too.
  const tapped = { name: 'Test Tapped Dual', layout: 'normal', type_line: 'Land', oracle_text: 'This land enters tapped.\n{T}: Add {U} or {R}.', produced_mana: ['U', 'R'], color_identity: ['U', 'R'] };
  const withTapped = names(landOptions([tapped, ...realLands], ['U', 'R']));
  assert.ok(withTapped.indexOf('Steam Vents') < withTapped.indexOf('Test Tapped Dual'));
});

test('landOptions skips basics, handles three colors, and is empty for one color', () => {
  const ur = names(landOptions(toyCards, ['U', 'R']));
  assert.ok(!ur.includes('Island') && !ur.includes('Mountain'));
  assert.ok(ur.includes('Thriving Isle'), 'a thriving land picks its second color');
  assert.ok(ur.includes('Shivan Reef'), 'a painland counts');
  assert.deepEqual(landOptions(realLands, ['G']), []);
  assert.deepEqual(landOptions(realLands, []), []);
  assert.deepEqual(landOptions([], ['U', 'R']), []);
  const esper = landOptions(realLands, ['B', 'W', 'U']);
  const grave = esper.find((o) => o.name === 'Watery Grave');
  assert.equal(grave.colors, 'UB');
  const fabled = esper.find((o) => o.name === 'Fabled Passage');
  assert.equal(fabled.colors, 'WUB', 'deck colors in WUBRG order');
  assert.ok(fabled.quality > grave.quality, 'a land for three deck colors beats a two-color one');
});

test('landsForColor keeps the entries that make that color, in order', () => {
  const opts = landOptions(realLands, ['W', 'U', 'B']);
  const white = landsForColor(opts, 'W');
  assert.ok(white.length > 0 && white.length < opts.length);
  for (const o of white) assert.ok(o.colors.includes('W'));
  assert.deepEqual(names(white), names(opts).filter((n) => white.some((o) => o.name === n)));
  assert.ok(names(white).includes('Hallowed Fountain'));
  assert.ok(!names(white).includes('Watery Grave'));
  assert.deepEqual(landsForColor(opts, 'G'), []);
});

const uris = (id) => ({
  small: `https://cards.scryfall.io/small/front/${id}.jpg`,
  normal: `https://cards.scryfall.io/normal/front/${id}.jpg`,
  large: `https://cards.scryfall.io/large/front/${id}.jpg`,
  png: `https://cards.scryfall.io/png/front/${id}.png`,
  art_crop: `https://cards.scryfall.io/art_crop/front/${id}.jpg`,
  border_crop: `https://cards.scryfall.io/border_crop/front/${id}.jpg`,
});

const normalCard = {
  object: 'card', id: 'aaa', name: 'Steam Vents', layout: 'normal', mana_cost: '', cmc: 0,
  type_line: 'Land — Island Mountain', oracle_text: '({T}: Add {U} or {R}.)', produced_mana: ['U', 'R'],
  color_identity: ['U', 'R'], legalities: { standard: 'legal' }, image_uris: uris('a/a/aaa'), prices: { usd: '20.00' },
};

const dfc = {
  object: 'card', id: 'bbb', name: 'Fable of the Mirror-Breaker // Reflection of Kiki-Jiki', layout: 'transform', cmc: 3,
  type_line: 'Enchantment — Saga // Enchantment Creature — Goblin Shaman', color_identity: ['R'], legalities: { standard: 'not_legal' },
  card_faces: [
    { object: 'card_face', name: 'Fable of the Mirror-Breaker', mana_cost: '{2}{R}', type_line: 'Enchantment — Saga', oracle_text: 'I — Create a 2/2 red Goblin Shaman creature token.', image_uris: uris('b/b/bbb') },
    { object: 'card_face', name: 'Reflection of Kiki-Jiki', mana_cost: '', type_line: 'Enchantment Creature — Goblin Shaman', oracle_text: '{1}, {T}: Create a token copy.', image_uris: uris('b/b/bbb-back') },
  ],
};

test('trimCard keeps small and normal image urls for a normal card', () => {
  const t = trimCard(normalCard);
  assert.deepEqual(t.image_uris, { small: normalCard.image_uris.small, normal: normalCard.image_uris.normal });
  assert.equal(t.prices, undefined);
  assert.equal(t.id, undefined);
  assert.equal(t.name, 'Steam Vents');
  assert.deepEqual(t.produced_mana, ['U', 'R']);
});

test('trimCard keeps image urls on each face of a double-faced card', () => {
  const t = trimCard(dfc);
  assert.equal(t.image_uris, undefined);
  assert.equal(t.card_faces.length, 2);
  assert.deepEqual(t.card_faces[0].image_uris, { small: dfc.card_faces[0].image_uris.small, normal: dfc.card_faces[0].image_uris.normal });
  assert.deepEqual(t.card_faces[1].image_uris, { small: dfc.card_faces[1].image_uris.small, normal: dfc.card_faces[1].image_uris.normal });
  assert.equal(t.card_faces[0].name, 'Fable of the Mirror-Breaker');
  assert.equal(t.card_faces[0].oracle_text, dfc.card_faces[0].oracle_text);
});

test('trimCard leaves image_uris out when there are none, and keeps only the sizes present', () => {
  const plain = trimCard({ name: 'No Image', type_line: 'Land', card_faces: [{ name: 'A' }, { name: 'B' }] });
  assert.ok(!('image_uris' in plain));
  assert.ok(!('image_uris' in plain.card_faces[0]));
  const onlyLarge = trimCard({ name: 'Large Only', image_uris: { large: 'x', png: 'y' } });
  assert.ok(!('image_uris' in onlyLarge));
  const onlySmall = trimCard({ name: 'Small Only', image_uris: { small: 's', large: 'x' } });
  assert.deepEqual(onlySmall.image_uris, { small: 's' });
  // Image urls survive a round trip through JSON (localStorage).
  const cached = JSON.parse(JSON.stringify(trimCard(dfc)));
  assert.equal(cardImage(cached, 'small'), dfc.card_faces[0].image_uris.small);
  assert.deepEqual(cached.card_faces[1].image_uris, trimCard(dfc).card_faces[1].image_uris);
});

test('cardImage finds the front image of normal and double-faced cards', () => {
  assert.equal(cardImage(normalCard), normalCard.image_uris.normal);
  assert.equal(cardImage(normalCard, 'small'), normalCard.image_uris.small);
  assert.equal(cardImage(trimCard(normalCard), 'normal'), normalCard.image_uris.normal);
  assert.equal(cardImage(dfc), dfc.card_faces[0].image_uris.normal);
  assert.equal(cardImage(trimCard(dfc), 'small'), dfc.card_faces[0].image_uris.small);
  // Sizes trimCard drops are gone afterwards.
  assert.equal(cardImage(normalCard, 'large'), normalCard.image_uris.large);
  assert.equal(cardImage(trimCard(normalCard), 'large'), null);
});

test('cardImage is null for a card without images', () => {
  assert.equal(cardImage({ name: 'No Image', type_line: 'Land' }), null);
  assert.equal(cardImage({ name: 'Faces', card_faces: [{ name: 'A' }, { name: 'B' }] }), null);
  assert.equal(cardImage(realLands[0]), null, 'the real fixture has no images');
  assert.equal(cardImage(null), null);
  assert.equal(cardImage(undefined), null);
});
