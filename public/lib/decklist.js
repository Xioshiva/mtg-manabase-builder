// Parses pasted decklists: Arena/MTGO exports, "4 Opt", "4x Opt", "Opt (M21) 59".
// Cards under a Sideboard/Side/Maybeboard/Companion header go to the sideboard, as do
// "SB: 2 Negate" lines and, when there are no section headers (MTGO style), everything
// after the first blank line that follows main deck cards.
export function parseDecklist(text) {
  const main = new Map();
  const commander = new Map();
  const sideboard = new Map();
  const errors = [];
  let section = 'main';
  let sawHeader = false;
  let sawCards = false;
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line) {
      if (!sawHeader && sawCards && section === 'main') section = 'sideboard';
      continue;
    }
    if (/^(#|\/\/)/.test(line)) continue;
    const header = line.toLowerCase().replace(/[:\s]+$/, '');
    if (['deck', 'main', 'main deck', 'maindeck', 'mainboard'].includes(header)) { section = 'main'; sawHeader = true; continue; }
    if (['sideboard', 'side', 'maybeboard', 'companion'].includes(header)) { section = 'sideboard'; sawHeader = true; continue; }
    if (header === 'commander' || header === 'commanders') { section = 'commander'; sawHeader = true; continue; }
    const sb = /^sb:\s*/i.test(line);
    if (sb) line = line.replace(/^sb:\s*/i, '');
    if (!line) continue;
    const m = line.match(/^(\d+)\s*x?\s+(.+?)$/i) || line.match(/^()(.+)$/);
    const name = cleanName(m[2]);
    const count = m[1] ? parseInt(m[1], 10) : 1;
    if (!name) { errors.push(raw.trim()); continue; }
    const target = sb || section === 'sideboard' ? sideboard : section === 'commander' ? commander : main;
    target.set(name, (target.get(name) || 0) + count);
    if (target !== sideboard) sawCards = true;
  }
  const list = (map) => [...map].map(([name, count]) => ({ name, count }));
  return { main: list(main), commander: list(commander), sideboard: list(sideboard), errors };
}

// Strips set codes, collector numbers, foil markers and back faces from a card name.
// Repeats until nothing changes, so "Opt (M21) 59 *F*" becomes "Opt" and a cleaned
// name always parses back to itself.
function cleanName(s) {
  let name = s.trim();
  for (let prev = null; prev !== name;) {
    prev = name;
    name = name
      .replace(/\s+\([A-Z0-9]{2,6}\)\s*[\w-]*\s*$/i, '') // (SET) 123
      .replace(/\s+\[[^\]]+\]\s*$/, '')
      .replace(/\s+\*[A-Z]+\*\s*$/i, '') // *F* foil markers
      .replace(/\s*\/\/?\s*.*$/, '') // keep the front face of "A // B" or MTGTop8's "A/B"
      .trim();
  }
  return name;
}

const SECTIONS = ['commander', 'main', 'sideboard'];

// Deck {commander?, main, sideboard?} -> Arena-style text that parseDecklist reads back.
export function formatDecklist(deck) {
  const lines = (list) => (list || []).filter((c) => c.count > 0).map((c) => `${c.count} ${c.name}`);
  const commander = lines(deck.commander);
  const side = lines(deck.sideboard);
  const parts = [];
  if (commander.length) parts.push(['Commander', ...commander].join('\n'));
  parts.push(['Deck', ...lines(deck.main)].join('\n'));
  if (side.length) parts.push(['Sideboard', ...side].join('\n'));
  return parts.join('\n\n') + '\n';
}

// Copy of a deck with fresh section arrays and entries; missing sections become [].
function copyDeck(deck) {
  const out = { ...deck };
  for (const s of SECTIONS) out[s] = (deck[s] || []).map((c) => ({ ...c }));
  return out;
}

// New deck with one card's count in a section changed by delta. Entries that drop to 0
// are removed; a card not in the section is added when delta is positive.
export function changeCount(deck, section, name, delta) {
  if (!SECTIONS.includes(section)) throw new Error(`Unknown deck section: ${section}`);
  const out = copyDeck(deck);
  const list = out[section];
  const key = cardKey(name);
  const i = list.findIndex((c) => cardKey(c.name) === key);
  if (i >= 0) {
    list[i].count += delta;
    if (list[i].count <= 0) list.splice(i, 1);
  } else if (delta > 0) {
    list.push({ name, count: delta });
  }
  return out;
}

// New deck with every land in the main deck replaced by rows [{name, count}], placed
// where the first land was (or at the end when the deck had none).
export function replaceLands(deck, isLand, rows) {
  const out = copyDeck(deck);
  const main = [];
  let at = -1;
  for (const c of out.main) {
    if (!isLand(c.name)) main.push(c);
    else if (at < 0) at = main.length;
  }
  const add = rows.filter((r) => r.count > 0).map((r) => ({ name: r.name, count: r.count }));
  main.splice(at < 0 ? main.length : at, 0, ...add);
  out.main = main;
  return out;
}

// Lookup key for card names, so case and accents don't matter ("Kili" finds "Kíli").
export function cardKey(name) {
  return name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

// Map(cardKey -> Scryfall card) for a list of cards, by full name and by each face's name.
export function indexCards(list) {
  const map = new Map();
  for (const c of list) {
    map.set(cardKey(c.name), c);
    for (const f of c.card_faces || []) if (!map.has(cardKey(f.name))) map.set(cardKey(f.name), c);
  }
  return map;
}
