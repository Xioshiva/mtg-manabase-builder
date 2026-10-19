import { readFile } from 'node:fs/promises';

// The "manabuilder" name for this computer: one line in the hosts file points it at
// 127.0.0.1, so the app opens at http://manabuilder. `npm run add-name` writes the line.
export const NAME = 'manabuilder';
const MARK = '# added by mtg-manabase-builder';

export const hostsPath = (platform = process.platform, env = process.env) =>
  platform === 'win32' ? `${env.SystemRoot || 'C:\\Windows'}\\System32\\drivers\\etc\\hosts` : '/etc/hosts';

// Whether a hosts line maps the name (comments don't count).
const mapsName = (line) => line.replace(/#.*/, '').trim().split(/\s+/).slice(1).some((h) => h.toLowerCase() === NAME);
const eolOf = (text) => (text.includes('\r\n') ? '\r\n' : '\n');

export const hasHostsEntry = (text) => text.split(/\r?\n/).some(mapsName);

// The hosts file with the name added, or null if some line already maps it.
export function addHostsEntry(text) {
  if (hasHostsEntry(text)) return null;
  const eol = eolOf(text);
  const sep = text === '' || text.endsWith('\n') ? '' : eol;
  return `${text}${sep}127.0.0.1 ${NAME} ${MARK}${eol}`;
}

// The hosts file without the lines addHostsEntry wrote, or null if it has none.
export function removeHostsEntry(text) {
  const lines = text.split(/\r?\n/);
  const kept = lines.filter((line) => !(line.includes(MARK) && mapsName(line)));
  return kept.length === lines.length ? null : kept.join(eolOf(text));
}

// Whether this computer's hosts file maps the name. False when it can't be read.
export async function nameIsSetUp(file = hostsPath()) {
  try { return hasHostsEntry(await readFile(file, 'utf8')); } catch { return false; }
}
