// Tiny static file server: `node server.js`, then open http://localhost:5173
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { staticFile } from './static-file.js';
import { importDeckLink, recognizeDeckLink } from './public/lib/importers.js';

const root = join(fileURLToPath(new URL('.', import.meta.url)), 'public');
const port = Number(process.env.PORT) || 5173;
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/deck') {
    // Fetches a Moxfield or MTGTop8 deck for the page (those sites block browser requests).
    const link = url.searchParams.get('url') || '';
    res.setHeader('Content-Type', 'application/json');
    if (!recognizeDeckLink(link)) { res.writeHead(400).end(JSON.stringify({ error: 'Not a Moxfield or MTGTop8 deck link' })); return; }
    try {
      const deck = await importDeckLink(link);
      res.writeHead(200).end(JSON.stringify(deck));
    } catch (err) {
      res.writeHead(502).end(JSON.stringify({ error: err.message }));
    }
    return;
  }
  const file = staticFile(root, url.pathname);
  if (!file) { res.writeHead(403).end(); return; }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('Not found');
  }
}).listen(port, () => console.log(`Manabase builder running at http://localhost:${port}`));
