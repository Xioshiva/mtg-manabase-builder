// Parses pasted decklists: Arena/MTGO exports, "4 Opt", "4x Opt", "Opt (M21) 59".
// Stops at a Sideboard header, or at a blank line once main deck cards have been read
// when there are no section headers (MTGO style).
export function parseDecklist(text) {
  const main = new Map();
  const commander = new Map();
  const errors = [];
  let section = 'main';
  let sawHeader = false;
  let sawCards = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      if (!sawHeader && sawCards && section === 'main') section = 'sideboard';
      continue;
    }
    if (/^(#|\/\/)/.test(line)) continue;
    const header = line.toLowerCase().replace(/[:\s]+$/, '');
    if (['deck', 'main', 'main deck', 'maindeck', 'mainboard'].includes(header)) { section = 'main'; sawHeader = true; continue; }
    if (['sideboard', 'side', 'maybeboard', 'companion'].includes(header)) { section = 'sideboard'; sawHeader = true; continue; }
    if (header === 'commander' || header === 'commanders') { section = 'commander'; sawHeader = true; continue; }
    if (/^sb:\s*/i.test(line)) continue;
    const m = line.match(/^(\d+)\s*x?\s+(.+?)$/i) || line.match(/^()(.+)$/);
    let name = m[2]
      .replace(/\s+\([A-Z0-9]{2,6}\)\s*[\w-]*\s*$/i, '') // (SET) 123
      .replace(/\s+\[[^\]]+\]\s*$/, '')
      .replace(/\s+\*[A-Z]+\*\s*$/i, '') // *F* foil markers
      .replace(/\s+\/\/\s+.*$/, '') // keep the front face of "A // B"
      .trim();
    const count = m[1] ? parseInt(m[1], 10) : 1;
    if (!name) { errors.push(line); continue; }
    if (section === 'sideboard') continue;
    const target = section === 'commander' ? commander : main;
    target.set(name, (target.get(name) || 0) + count);
    sawCards = true;
  }
  return {
    main: [...main].map(([name, count]) => ({ name, count })),
    commander: [...commander].map(([name, count]) => ({ name, count })),
    errors,
  };
}
