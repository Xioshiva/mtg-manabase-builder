import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { staticFile } from '../static-file.js';

test('maps URLs to files on Windows and elsewhere', () => {
  const win = 'C:\\Users\\me\\mtg-manabase-builder\\public';
  assert.equal(staticFile(win, '/', path.win32), `${win}\\index.html`);
  assert.equal(staticFile(win, '/app.js', path.win32), `${win}\\app.js`);
  assert.equal(staticFile(win, '/lib/sim.js', path.win32), `${win}\\lib\\sim.js`);
  const posix = '/home/me/mtg-manabase-builder/public';
  assert.equal(staticFile(posix, '/', path.posix), `${posix}/index.html`);
  assert.equal(staticFile(posix, '/style.css', path.posix), `${posix}/style.css`);
});

test('refuses paths outside the public folder', () => {
  const win = 'C:\\app\\public';
  for (const p of ['/../server.js', '/%2e%2e/server.js', '/..%5cserver.js', '/..\\server.js', '/x/../../server.js']) {
    assert.equal(staticFile(win, p, path.win32), null, p);
  }
  assert.equal(staticFile('/app/public', '/../server.js', path.posix), null);
  assert.equal(staticFile('/app/public', '/%2e%2e/server.js', path.posix), null);
  assert.equal(staticFile('/app/public-other', '/../public-other2/x', path.posix), null);
  assert.equal(staticFile('/app/public', '/%E0%A4%A', path.posix), null); // malformed escape
});
