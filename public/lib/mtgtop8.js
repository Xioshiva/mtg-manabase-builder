// MTGTop8 import. Like Moxfield, MTGTop8 doesn't let other sites fetch from the
// browser, so the local server fetches the deck's MTGO text export.
const SITE = 'https://www.mtgtop8.com';
const FORMAT_CODES = { ST: 'standard', PI: 'pioneer', MO: 'modern', EDH: 'commander' };

// Accepts a deck URL (https://www.mtgtop8.com/event?e=92141&d=899834&f=ST),
// an export URL (https://www.mtgtop8.com/mtgo?d=899834) or "mtgtop8:899834".
export function parseMtgtop8Url(input) {
  const s = (input || '').trim();
  if (!/mtgtop8/i.test(s)) return null;
  const d = s.match(/[?&]d=(\d+)/) || s.match(/^mtgtop8:(\d+)$/i);
  if (!d) return null;
  const f = s.match(/[?&]f=([A-Za-z]+)/);
  return { id: d[1], format: f ? FORMAT_CODES[f[1].toUpperCase()] || null : null };
}

// Server-side fetch (Node). Returns { name, format, text } like the Moxfield importer.
export async function fetchMtgtop8Deck(ref, { fetchImpl = globalThis.fetch } = {}) {
  let res;
  try {
    res = await fetchImpl(`${SITE}/mtgo?d=${ref.id}`, { headers: { 'User-Agent': 'manabase-builder/0.1 (+local)' } });
  } catch {
    throw new Error("couldn't reach MTGTop8");
  }
  if (!res.ok) throw new Error(`MTGTop8 returned ${res.status}`);
  const text = (await res.text()).replace(/\r\n/g, '\n').trim();
  if (!/^\d+\s+\S/m.test(text)) throw new Error('MTGTop8 sent back something that is not a decklist (check the link)');
  return { name: `MTGTop8 deck ${ref.id}`, format: ref.format, text: text + '\n' };
}
