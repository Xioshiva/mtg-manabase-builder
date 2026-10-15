// Simulation threads for the command line, using worker_threads. This file is also
// the script each thread runs.
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import os from 'node:os';
import { createSimPool, createWorkerHandler, inlineSimulator } from './public/lib/pool.js';

if (!isMainThread && workerData?.simWorker) {
  parentPort.on('message', createWorkerHandler((msg) => parentPort.postMessage(msg)));
}

export function defaultThreads() {
  return os.availableParallelism ? os.availableParallelism() : os.cpus().length;
}

// A thread count from the command line: a whole number from 1 to 64, or every thread
// when it isn't a number.
export function parseThreads(value) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) ? Math.min(64, Math.max(1, n)) : defaultThreads();
}

// Call close() when done, or the threads keep the process running.
export function createNodeSimulator(threads = defaultThreads()) {
  threads = parseThreads(threads);
  if (threads === 1) return inlineSimulator;
  return createSimPool({
    size: threads,
    spawn(onMessage, onError) {
      const w = new Worker(new URL(import.meta.url), { workerData: { simWorker: true } });
      let stopping = false;
      w.on('message', onMessage);
      w.on('error', onError);
      w.on('exit', (code) => { if (!stopping) onError(new Error(`A simulation thread stopped (exit code ${code}).`)); });
      return { post: (msg) => w.postMessage(msg), terminate() { stopping = true; w.terminate(); } };
    },
  });
}
