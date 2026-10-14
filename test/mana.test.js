import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCost, canPay, payCost, COLOR_BITS as C } from '../public/lib/mana.js';

test('parses generic, colored, hybrid, twobrid, X and phyrexian symbols', () => {
  assert.deepEqual(parseCost('{2}{W}{U}'), { generic: 2, pips: [C.W, C.U], twobrid: [], x: 0 });
  assert.deepEqual(parseCost('{X}{R}{R}'), { generic: 0, pips: [C.R, C.R], twobrid: [], x: 1 });
  assert.deepEqual(parseCost('{W/U}{2/B}{G/P}').pips, [C.W | C.U]);
  assert.deepEqual(parseCost('{W/U}{2/B}').twobrid, [C.B]);
  assert.deepEqual(parseCost('{1}{U} // {3}{U}{U}'), { generic: 1, pips: [C.U], twobrid: [], x: 0 });
});

test('pays colored pips with the right sources', () => {
  const cost = parseCost('{1}{U}{U}');
  assert.equal(canPay([C.U, C.U, C.R], cost), true);
  assert.equal(canPay([C.U, C.R, C.R], cost), false);
  assert.equal(canPay([C.U | C.R, C.U, C.R], cost), true);
  assert.equal(canPay([C.U, C.U], cost), false);
});

test('saves flexible lands for generic mana when tapping', () => {
  const sources = [C.U | C.R, C.U, C.R];
  const used = payCost(sources, parseCost('{U}'));
  assert.deepEqual([...used], [1]);
  assert.deepEqual(used.pipFor, [C.U]);
});

test('twobrid pips can be paid with two generic', () => {
  assert.equal(canPay([C.R, C.R], parseCost('{2/W}')), true);
  assert.equal(canPay([C.W], parseCost('{2/W}')), true);
  assert.equal(canPay([C.R], parseCost('{2/W}')), false);
});
