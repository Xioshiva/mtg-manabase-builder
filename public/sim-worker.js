// One simulation thread for the web app (see lib/pool.js).
import { createWorkerHandler } from './lib/pool.js';

const handle = createWorkerHandler((msg) => self.postMessage(msg));
self.onmessage = (e) => handle(e.data);
