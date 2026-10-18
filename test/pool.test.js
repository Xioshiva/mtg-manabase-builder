// Simulations spread over threads must give exactly the numbers of a single-threaded run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { simulate, chunkCount } from '../public/lib/sim.js';
import { createSimPool, createWorkerHandler, inlineSimulator } from '../public/lib/pool.js';
import { buildModel, runAnalysis } from '../public/lib/analysis.js';
import { parseDecklist, indexCards } from '../public/lib/decklist.js';
import { createNodeSimulator, parseThreads, defaultThreads } from '../node-pool.js';
import { spell, basicLandDef, standard, card, izzetText, byName } from './helpers.js';

const toy = {
  cards: [spell('A', '{U}', 1, 14), spell('B', '{1}{R}', 2, 14), spell('C', '{2}{U}{R}', 4, 8), card('Spirebluff Canal', 4), basicLandDef('U', 10), basicLandDef('R', 10)],
  format: standard,
};

// In-process stand-ins for workers, so the scheduling can be tested without threads.
// fail(n) makes the n-th job (counting from 1) report an error.
function fakeSpawn({ fail = () => false } = {}) {
  let jobs = 0;
  return (onMessage) => {
    const handle = createWorkerHandler((msg) => setImmediate(() => onMessage(msg)));
    let stopped = false;
    return {
      post(msg) {
        if (msg.type === 'run' && fail(++jobs)) { setImmediate(() => onMessage({ type: 'error', message: 'boom' })); return; }
        setImmediate(() => { if (!stopped) handle(structuredClone(msg)); });
      },
      terminate() { stopped = true; },
    };
  };
}

test('a simulation splits into chunks only when it is big enough to have batches', () => {
  assert.equal(chunkCount(199), 1);
  assert.equal(chunkCount(200), 20);
});

test('pooled simulations match single-threaded ones exactly', async () => {
  const variants = [null, toy.cards.map((d) => d.count), toy.cards.map((d, i) => (i === 4 ? d.count - 1 : i === 5 ? d.count + 1 : d.count))];
  for (const size of [1, 3, 7]) {
    const pool = createSimPool({ size, spawn: fakeSpawn() });
    for (const opts of [{ games: 150, seed: 4 }, { games: 2003, seed: 5, play: 'draw' }]) {
      const pooled = await pool.simulateMany(toy, variants, opts);
      const single = await inlineSimulator.simulateMany(toy, variants, opts);
      assert.deepEqual(pooled, single, `${size} workers, ${opts.games} games`);
    }
    pool.close();
  }
  assert.deepEqual((await inlineSimulator.simulateMany(toy, [null], { games: 1000 }))[0], simulate(toy, { games: 1000 }));
});

test('the full analysis gives the same answer on any number of threads', async () => {
  const parsed = parseDecklist(izzetText.replace('8 Island\n6 Mountain', '13 Island\n1 Mountain'));
  const { model } = buildModel(parsed, byName, standard);
  const opts = { model, games: 1000, candidateCards: [] };
  const single = await runAnalysis(opts);
  assert.ok(single.suggested.history.length > 0);
  const threads = createNodeSimulator(3);
  try {
    assert.deepEqual(await runAnalysis({ ...opts, sim: threads }), single);
  } finally {
    threads.close();
  }
});

test('real worker threads match on a real deck', async () => {
  const cards = indexCards(JSON.parse(readFileSync(new URL('./fixtures/real/cards.json', import.meta.url), 'utf8')));
  const text = readFileSync(new URL('./fixtures/real/decks/jund-sacrifice-899186.txt', import.meta.url), 'utf8');
  const { model } = buildModel(parseDecklist(text), cards, standard);
  const threads = createNodeSimulator(2);
  try {
    const [r] = await threads.simulateMany(model, [null], { games: 3000, seed: 8 });
    assert.deepEqual(r, simulate(model, { games: 3000, seed: 8 }));
  } finally {
    threads.close();
  }
});

test('a failing job rejects its simulation and the pool keeps working', async () => {
  const pool = createSimPool({ size: 2, spawn: fakeSpawn({ fail: (n) => n === 3 }) });
  await assert.rejects(pool.simulateMany(toy, [null, null], { games: 2000 }), /boom/);
  const [r] = await pool.simulateMany(toy, [null], { games: 500, seed: 2 });
  assert.deepEqual(r, simulate(toy, { games: 500, seed: 2 }));
  pool.close();
});

test('closing the pool stops simulations that are still running', async () => {
  const pool = createSimPool({ size: 2, spawn: fakeSpawn() });
  const running = pool.simulateMany(toy, [null, null, null], { games: 4000 });
  pool.close();
  await assert.rejects(running, /stopped/);
  await assert.rejects(pool.simulateMany(toy, [null], { games: 100 }), /stopped/);
});

test('a thread that crashes stops the pool with its error', async () => {
  let crash;
  const pool = createSimPool({
    size: 2,
    spawn: (onMessage, onError) => { crash = onError; return { post() {}, terminate() {} }; },
  });
  const running = pool.simulateMany(toy, [null], { games: 1000 });
  crash(new Error('out of memory'));
  await assert.rejects(running, /out of memory/);
  await assert.rejects(pool.simulateMany(toy, [null], { games: 100 }), /out of memory/);
});

test('thread counts from the command line are whole numbers from 1 to 64', () => {
  assert.equal(parseThreads('3'), 3);
  assert.equal(parseThreads('2.5'), 2);
  assert.equal(parseThreads('0'), 1);
  assert.equal(parseThreads('-4'), 1);
  assert.equal(parseThreads('1e9'), 64);
  assert.equal(parseThreads('Infinity'), defaultThreads());
  assert.equal(parseThreads('abc'), defaultThreads());
  assert.equal(parseThreads(undefined), defaultThreads());
  assert.equal(createNodeSimulator('1'), inlineSimulator);
});
