// Runs simulations on several threads. A simulation is split into its chunks (see
// sim.js), the chunks are shared out to workers, and the counts that come back are
// added up here, so the numbers match a single-threaded run exactly.
//
// A simulator has one method: simulateMany(model, variants, opts) plays the same
// simulation for each variant, where a variant is an array of card counts aligned with
// model.cards (or null for the counts already in model.cards), and resolves to one
// result per variant, as simulate() would return it.
import { simulate, simulateChunks, finishSimulation, chunkCount } from './sim.js';

const withCounts = (cards, counts) => (counts ? cards.map((d, i) => ({ ...d, count: counts[i] })) : cards);

// Everything on the calling thread. Used by the tests and with --threads 1.
export const inlineSimulator = {
  threads: 1,
  async simulateMany(model, variants, opts = {}) {
    return variants.map((counts) => simulate({ ...model, cards: withCounts(model.cards, counts) }, opts));
  },
  close() {},
};

// Workers can't receive functions (the format's land formula), and don't need them.
function plainFormat(format) {
  return Object.fromEntries(Object.entries(format).filter(([, v]) => typeof v !== 'function'));
}

// spawn(onMessage, onError) starts one worker running createWorkerHandler and returns
// { post(message), terminate() }. The browser and Node each supply their own.
export function createSimPool({ size, spawn }) {
  const queue = [];
  const calls = new Set();
  let nextId = 1;
  let broken = null;
  const workers = [];
  for (let i = 0; i < size; i++) {
    const w = { job: null };
    w.handle = spawn((msg) => finished(w, msg), (err) => crashed(err));
    workers.push(w);
  }

  function pump() {
    for (const w of workers) {
      while (!w.job && queue.length) {
        const job = queue.shift();
        if (job.call.settled) continue;
        w.job = job;
        w.handle.post({ type: 'run', deck: job.call.id, counts: job.counts, opts: job.call.opts, from: job.from, to: job.to });
      }
    }
  }

  function finished(w, msg) {
    const job = w.job;
    w.job = null;
    if (job && !job.call.settled) {
      if (msg.type === 'error') job.call.fail(Object.assign(new Error(msg.message), { stack: msg.stack }));
      else job.call.done(job, msg.part);
    }
    pump();
  }

  function crashed(err) {
    if (broken) return;
    broken = err instanceof Error ? err : new Error(String(err));
    for (const call of [...calls]) call.fail(broken);
    close();
  }

  function close() {
    if (!broken) broken = new Error('The simulation was stopped.');
    for (const call of [...calls]) call.fail(broken);
    queue.length = 0;
    for (const w of workers.splice(0)) w.handle.terminate();
  }

  async function simulateMany(model, variants, opts = {}) {
    if (broken) throw broken;
    if (!variants.length) return [];
    const nChunks = chunkCount(opts.games ?? 4000);
    // About three jobs per worker so they all finish close together; with many variants
    // each job is a whole simulation.
    const perJob = Math.max(1, Math.floor((variants.length * nChunks) / (workers.length * 3)));
    const call = { id: nextId++, opts, settled: false };
    const parts = variants.map(() => []);
    let left = 0;
    const promise = new Promise((resolve, reject) => {
      call.done = (job, part) => {
        parts[job.v][job.from] = part;
        if (--left === 0) { call.settled = true; calls.delete(call); resolve(); }
      };
      call.fail = (err) => {
        if (call.settled) return;
        call.settled = true;
        calls.delete(call);
        reject(err);
      };
    });
    calls.add(call);
    const message = { type: 'deck', id: call.id, cards: model.cards, format: plainFormat(model.format) };
    for (const w of workers) w.handle.post(message);
    variants.forEach((counts, v) => {
      for (let from = 0; from < nChunks; from += perJob) {
        queue.push({ call, v, counts, from, to: Math.min(nChunks, from + perJob) });
        left++;
      }
    });
    pump();
    try {
      await promise;
    } finally {
      for (const w of workers) w.handle.post({ type: 'drop', id: call.id });
    }
    return variants.map((counts, v) =>
      finishSimulation({ ...model, cards: withCounts(model.cards, counts) }, opts, parts[v].filter(Boolean)));
  }

  return { threads: size, simulateMany, close };
}

// The worker side: post(message) sends a reply to the pool.
export function createWorkerHandler(post) {
  const decks = new Map();
  return (msg) => {
    if (msg.type === 'deck') decks.set(msg.id, msg);
    else if (msg.type === 'drop') decks.delete(msg.id);
    else if (msg.type === 'run') {
      try {
        const deck = decks.get(msg.deck);
        const model = { cards: withCounts(deck.cards, msg.counts), format: deck.format };
        post({ type: 'part', part: simulateChunks(model, msg.opts, msg.from, msg.to) });
      } catch (err) {
        post({ type: 'error', message: err.message, stack: err.stack });
      }
    }
  };
}
