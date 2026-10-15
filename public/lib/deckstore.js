// Saved decks in the browser's localStorage (or any object with getItem/setItem).
// Stored as one JSON array of {name, text, format, locks, savedAt} under KEY.
export const KEY = 'manabase-saved-decks-v1';

const REFUSED = 'The browser refused to store the deck (private browsing, blocked site data or full storage).';

// Reading window.localStorage itself throws when site data is blocked.
function browserStorage() {
  try { return globalThis.localStorage; } catch { return undefined; }
}

const nameKey = (name) => String(name).trim().toLowerCase();

// Drops anything that isn't a usable entry, so hand-edited or old data can't break the page.
function cleanEntry(e) {
  if (!e || typeof e !== 'object' || typeof e.name !== 'string' || !e.name.trim()) return null;
  return {
    name: e.name.trim(),
    text: typeof e.text === 'string' ? e.text : '',
    format: e.format ?? null,
    locks: Array.isArray(e.locks) ? e.locks.filter((l) => typeof l === 'string') : [],
    savedAt: Number.isFinite(e.savedAt) ? e.savedAt : 0,
  };
}

export function createDeckStore(storage = browserStorage()) {
  // { ok: false } when storage is missing or getItem throws; corrupt JSON reads as empty.
  function read() {
    let raw;
    try {
      if (!storage) return { ok: false, decks: [] };
      raw = storage.getItem(KEY);
    } catch {
      return { ok: false, decks: [] };
    }
    let data;
    try { data = raw ? JSON.parse(raw) : []; } catch { data = []; }
    return { ok: true, decks: Array.isArray(data) ? data.map(cleanEntry).filter(Boolean) : [] };
  }

  function write(decks) {
    try {
      storage.setItem(KEY, JSON.stringify(decks));
      return true;
    } catch {
      return false;
    }
  }

  return {
    // [{name, format, savedAt}], newest first.
    list() {
      return read().decks
        .map((e, i) => ({ e, i }))
        .sort((a, b) => b.e.savedAt - a.e.savedAt || b.i - a.i)
        .map(({ e }) => ({ name: e.name, format: e.format, savedAt: e.savedAt }));
    },

    get(name) {
      const key = nameKey(name ?? '');
      return read().decks.find((e) => nameKey(e.name) === key) || null;
    },

    // Adds the deck, or replaces the one with the same name. Returns the stored entry.
    save({ name, text = '', format = null, locks = [], savedAt = Date.now() } = {}) {
      const entry = cleanEntry({ name: String(name ?? ''), text, format, locks, savedAt });
      if (!entry) throw new Error('Give the deck a name.');
      const { ok, decks } = read();
      // Writing after a failed read would wipe the other saved decks.
      if (!ok) throw new Error(REFUSED);
      const key = nameKey(entry.name);
      const next = decks.filter((e) => nameKey(e.name) !== key);
      next.push(entry);
      if (!write(next)) throw new Error(REFUSED);
      return { ...entry, locks: [...entry.locks] };
    },

    // True when a deck was found and removed.
    remove(name) {
      const { ok, decks } = read();
      if (!ok) return false;
      const key = nameKey(name ?? '');
      const next = decks.filter((e) => nameKey(e.name) !== key);
      if (next.length === decks.length) return false;
      return write(next);
    },
  };
}
