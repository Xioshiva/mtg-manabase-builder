// Format rules the builder needs. Add a format by adding an entry here.
// landFormula follows Frank Karsten's regressions (avg = average mana value of
// nonland cards, cheap = cheap card draw / ramp spells).
export const FORMATS = {
  standard: {
    id: 'standard', name: 'Standard', status: 'ready',
    deckSize: 60, maxCopies: 4, handSize: 7, freeMulligan: false, multiplayer: false,
    legalityKey: 'standard',
    landFormula: (avg, cheap) => 19.59 + 1.9 * avg - 0.28 * cheap,
  },
  pioneer: {
    id: 'pioneer', name: 'Pioneer', status: 'ready',
    deckSize: 60, maxCopies: 4, handSize: 7, freeMulligan: false, multiplayer: false,
    legalityKey: 'pioneer',
    landFormula: (avg, cheap) => 19.59 + 1.9 * avg - 0.28 * cheap,
  },
  modern: {
    id: 'modern', name: 'Modern', status: 'ready',
    deckSize: 60, maxCopies: 4, handSize: 7, freeMulligan: false, multiplayer: false,
    legalityKey: 'modern',
    landFormula: (avg, cheap) => 19.59 + 1.9 * avg - 0.28 * cheap,
  },
  // Duel Commander (once called French Commander): 1v1, 20 life, its own banned list and
  // the usual mulligan. The commander starts in the command zone (librarySize leaves it out).
  duel: {
    id: 'duel', name: 'Duel Commander', status: 'ready',
    deckSize: 100, librarySize: 99, maxCopies: 1, handSize: 7, freeMulligan: false, multiplayer: false,
    commander: true,
    legalityKey: 'duel',
    landFormula: (avg, cheap) => 31.42 + 3.13 * avg - 0.28 * cheap,
  },
  commander: {
    id: 'commander', name: 'Commander', status: 'preview',
    deckSize: 100, librarySize: 99, maxCopies: 1, handSize: 7, freeMulligan: true, multiplayer: true,
    commander: true,
    keepRanges: { 7: [3, 5], 6: [2, 4], 5: [2, 4] },
    legalityKey: 'commander',
    landFormula: (avg, cheap) => 31.42 + 3.13 * avg - 0.28 * cheap,
  },
};

export function getFormat(id) {
  const f = FORMATS[id];
  if (!f) throw new Error(`Unknown format "${id}"`);
  return f;
}
