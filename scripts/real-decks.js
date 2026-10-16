#!/usr/bin/env node
// Runs every real decklist in test/fixtures/real (decks/ is Standard, pioneer/ and modern/
// the other formats) through the builder using the saved card data
// (test/fixtures/real/cards.json) and prints what it understood: lands and how they
// enter, detected draw spells, anything unrecognised, and the simulation's headline numbers.
//   node scripts/real-decks.js [--format standard|pioneer|modern] [--games 4000] [--optimize]
//                              [--deck name-substring] [--threads N]
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDecklist, indexCards } from '../public/lib/decklist.js';
import { buildModel, runAnalysis } from '../public/lib/analysis.js';
import { getFormat } from '../public/lib/formats.js';
import { createNodeSimulator } from '../node-pool.js';

const root = fileURLToPath(new URL('../test/fixtures/real/', import.meta.url));
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const games = Number(opt('--games', 4000));
const only = opt('--deck', '');
const sim = createNodeSimulator(opt('--threads'));

export function loadRealCards() {
  const raw = JSON.parse(readFileSync(join(root, 'cards.json'), 'utf8'));
  return indexCards(raw);
}

// Where each format's decklists live under test/fixtures/real.
export const DECK_DIRS = { standard: 'decks', pioneer: 'pioneer', modern: 'modern' };

const cards = loadRealCards();
const formats = opt('--format') ? [opt('--format')] : Object.keys(DECK_DIRS);
const pct = (x) => (x * 100).toFixed(1) + '%';
try {
  for (const id of formats) {
    const format = getFormat(id);
    const dir = join(root, DECK_DIRS[id]);
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.txt') && f.includes(only)).sort()) {
      const parsed = parseDecklist(readFileSync(join(dir, file), 'utf8'));
      const built = buildModel(parsed, cards, format);
      console.log(`\n=== ${format.name}: ${file}`);
      for (const n of built.illegal) console.log(`  ! not legal in ${format.name}: ${n}`);
      for (const w of [...built.warnings, ...built.unknown.map((n) => `missing card data: ${n}`)]) console.log('  ! ' + w);
      const r = await runAnalysis({ model: built.model, games, optimize: args.includes('--optimize'), sim });
      console.log(`  colors ${r.colors.join('')} · avg MV ${r.stats.avgCmc.toFixed(2)} · cheap draw/ramp ${r.stats.cheapDrawOrRamp} · lands ${r.currentLands} (formula ${r.recommendedLands.count}) · MDFC ${r.stats.mdfc}`);
      console.log('  sources ' + r.colors.map((c) => `${c} ${r.current.sources[c]}/${r.sourcesNeeded.need[c]}`).join(', '));
      for (const l of r.current.lands) console.log(`    ${String(l.count).padStart(2)} ${l.name.padEnd(36)} ${l.colors.padEnd(5)} ${l.how}`);
      const s = r.current.sim;
      console.log(`  on curve ${pct(s.castOnCurve)} ±${(s.castOnCurveMoe * 100).toFixed(1)} · colors OK ${pct(s.colorConsistency)} · T4 land ${pct(s.turns[3].hitLandDrop)} · mana T7 ${s.manaSpent.toFixed(1)} · mull ${pct(s.mulliganRate)} · draw spells/game ${s.drawSpellsPerGame.toFixed(2)}`);
      const worst = [...s.spells].sort((a, b) => a.onCurve - b.onCurve).slice(0, 3);
      console.log('  hardest: ' + worst.map((w) => `${w.name} ${pct(w.onCurve)}`).join(', '));
      if (r.drawSpells.length) console.log('  draw: ' + r.drawSpells.map((d) => `${d.name} [${d.effect}]`).join('; '));
      for (const n of new Set(r.notes)) console.log('  note: ' + n);
      if (r.suggested) console.log('  suggested: ' + r.suggested.lands.map((l) => `${l.count} ${l.name}`).join(', ') + ` → on curve ${pct(r.suggested.sim.castOnCurve)}`);
      if (r.suggested?.kept.length) console.log('  kept (more than mana): ' + r.suggested.kept.join(', '));
    }
  }
} finally {
  sim.close();
}
