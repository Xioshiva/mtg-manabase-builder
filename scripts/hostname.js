// Adds or removes the "manabuilder" name for this computer, so the app opens at http://manabuilder.
// Usage: node scripts/hostname.js add|remove
// The hosts file belongs to the system: run it from a terminal opened as administrator on
// Windows, or with sudo on macOS and Linux.
import { readFile, writeFile } from 'node:fs/promises';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NAME, hostsPath, addHostsEntry, removeHostsEntry, hasHostsEntry } from '../hostname.js';

const action = process.argv[2];
if (action !== 'add' && action !== 'remove') {
  console.error('Usage: node scripts/hostname.js add|remove');
  process.exit(1);
}

const file = hostsPath();
try {
  // latin1 keeps every byte of the file as it is, whatever its encoding; the line added is ASCII.
  const text = await readFile(file, 'latin1');
  const next = action === 'add' ? addHostsEntry(text) : removeHostsEntry(text);
  if (next === null) {
    if (action === 'add') console.log(`${NAME} is already set up in ${file}.`);
    else if (hasHostsEntry(text)) console.log(`${file} maps ${NAME} on a line this script didn't add, so it was left alone.`);
    else console.log(`${NAME} isn't in ${file}.`);
  } else {
    await writeFile(file, next, 'latin1');
    if (action === 'add') console.log(`Added ${NAME} to ${file}. Start the app with node server.js (restart it if it's running) and open http://${NAME}`);
    else console.log(`Removed ${NAME} from ${file}.`);
  }
} catch (err) {
  if (err.code !== 'EACCES' && err.code !== 'EPERM') throw err;
  const script = relative(process.cwd(), fileURLToPath(import.meta.url));
  console.error(`Can't change ${file} without administrator rights.`);
  if (process.platform === 'win32') {
    console.error('Right-click Terminal (or Command Prompt) in the Start menu, choose "Run as administrator", go to this folder and run the command again.');
    console.error('If it already runs as administrator, the hosts file is read-only or protected by security software: clear Read-only in its Properties, or allow the change, and try again.');
  } else {
    console.error(`Run it again with sudo: sudo "${process.execPath}" ${script} ${action}`);
  }
  process.exit(1);
}
