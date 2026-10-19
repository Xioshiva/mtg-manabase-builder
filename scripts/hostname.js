// Adds or removes the "manabuilder" name for this computer, so the app opens at http://manabuilder.
// Usage: node scripts/hostname.js add|remove (npm run add-name / npm run remove-name).
// The hosts file belongs to the system: run it from a terminal opened as administrator on
// Windows, or with sudo on macOS and Linux.
import { readFile, writeFile } from 'node:fs/promises';
import { NAME, hostsPath, addHostsEntry, removeHostsEntry, hasHostsEntry } from '../hostname.js';

const action = process.argv[2];
if (action !== 'add' && action !== 'remove') {
  console.error('Usage: node scripts/hostname.js add|remove');
  process.exit(1);
}

const file = hostsPath();
try {
  const text = await readFile(file, 'utf8');
  const next = action === 'add' ? addHostsEntry(text) : removeHostsEntry(text);
  if (next === null) {
    if (action === 'add') console.log(`${NAME} is already set up in ${file}.`);
    else if (hasHostsEntry(text)) console.log(`${file} maps ${NAME} on a line this script didn't add, so it was left alone.`);
    else console.log(`${NAME} isn't in ${file}.`);
  } else {
    await writeFile(file, next);
    if (action === 'add') console.log(`Added ${NAME} to ${file}. Start the app with node server.js and open http://${NAME}`);
    else console.log(`Removed ${NAME} from ${file}.`);
  }
} catch (err) {
  if (err.code !== 'EACCES' && err.code !== 'EPERM') throw err;
  console.error(`Can't change ${file} without administrator rights.`);
  console.error(process.platform === 'win32'
    ? 'Right-click Terminal (or Command Prompt) in the Start menu, choose "Run as administrator", go to this folder and run the command again.'
    : `Run it again with sudo: sudo node scripts/hostname.js ${action}`);
  process.exit(1);
}
