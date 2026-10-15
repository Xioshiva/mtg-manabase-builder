#!/usr/bin/env node
// Command line version: node cli.js deck.txt|moxfield-url|mtgtop8-url [--format standard] [--mode analyze|build]
//   [--games 5000] [--play both|play|draw] [--lands N] [--no-optimize] [--swap-utility] [--cards cards.json]
//   [--threads N]
// --threads sets how many CPU threads run simulations (default: all of them, at most 64).
// --cards reads Scryfall card JSON from a file instead of the network (lands in it that
// aren't in the deck are offered to the optimizer).
import { readFileSync } from 'node:fs';
import { parseDecklist, cardKey, indexCards } from './public/lib/decklist.js';
import { fetchCollection, searchLands } from './public/lib/scryfall.js';
import { buildModel, runAnalysis, deckColors } from './public/lib/analysis.js';
import { getFormat } from './public/lib/formats.js';
import { recognizeDeckLink, importDeckLink } from './public/lib/importers.js';
import { createNodeSimulator, parseThreads } from './node-pool.js';

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const file = args.find((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--') && !['--no-optimize'].includes(args[i - 1])));
if (!file) { console.error('Usage: node cli.js deck.txt [--format standard] [--mode analyze|build] [--games 5000]'); process.exit(1); }

let deckText, imported = null;
if (recognizeDeckLink(file)) {
  process.stderr.write(`Importing from ${recognizeDeckLink(file).site}…\n`);
  imported = await importDeckLink(file);
  deckText = imported.text;
} else deckText = readFileSync(file, 'utf8');
const format = getFormat(opt('--format', (imported && imported.format) || 'standard'));
const parsed = parseDecklist(deckText);
const names = [...parsed.main, ...parsed.commander].map((c) => c.name);
let cards, candidateCards = [];
const cardFile = opt('--cards');
if (cardFile) {
  const raw = JSON.parse(readFileSync(cardFile, 'utf8'));
  cards = indexCards(raw);
  const inDeck = new Set(names.map((n) => cards.get(cardKey(n))).filter(Boolean));
  candidateCards = raw.filter((c) => !inDeck.has(c) && /\bLand\b/.test(c.type_line || c.card_faces?.[0]?.type_line || '') && !/Basic/.test(c.type_line || ''));
} else {
  process.stderr.write('Fetching cards from Scryfall…\n');
  cards = (await fetchCollection(names)).cards;
}
const built = buildModel(parsed, cards, format);
const optimize = !args.includes('--no-optimize');
if (optimize && !cardFile) {
  const colors = deckColors(built.model.cards);
  if (colors.length > 1) {
    process.stderr.write('Looking up legal dual lands…\n');
    candidateCards = await searchLands(colors, format.legalityKey);
  }
}
const threads = parseThreads(opt('--threads'));
const sim = createNodeSimulator(threads);
process.stderr.write(`Simulating on ${threads} thread${threads === 1 ? '' : 's'}\n`);
let r;
try {
  r = await runAnalysis({
    model: built.model, mode: opt('--mode', 'analyze'), candidateCards, optimize, keepUtility: !args.includes('--swap-utility'),
    games: Number(opt('--games', 10000)), play: opt('--play', 'both'), landCount: Number(opt('--lands', 0)) || undefined, sim,
    onProgress: (p) => process.stderr.write(`\r${p.stage}${p.iter ? ` (step ${p.iter})` : ''}…          `),
  });
} finally {
  sim.close();
}
process.stderr.write('\n');

const pct = (x) => (x * 100).toFixed(1).padStart(5) + '%';
for (const w of [...built.warnings, ...built.unknown.map((n) => `Not found: ${n}`), ...built.illegal.map((n) => `Not legal in ${format.name}: ${n}`)]) console.log('! ' + w);
console.log(`\n${format.name} · colors ${r.colors.join('')} · avg mana value ${r.stats.avgCmc.toFixed(2)} · ${r.stats.cheapDrawOrRamp} cheap draw/ramp`);
console.log(`Recommended lands: ${r.recommendedLands.count} (formula ${r.recommendedLands.exact.toFixed(1)}). You play ${r.currentLands}. Simulated with ${r.landCount}.`);
console.log('Sources needed (90%): ' + r.colors.map((c) => `${c} ${r.sourcesNeeded.need[c]}`).join(', '));
const show = (title, x) => {
  if (!x) return;
  console.log(`\n${title}: ` + r.colors.map((c) => `${c} ${x.sources[c]}`).join(', ') + ' sources');
  for (const l of x.lands) console.log(`  ${String(l.count).padStart(2)} ${l.name.padEnd(42)} ${l.colors.padEnd(5)} ${l.how}`);
  const s = x.sim;
  const pm = (x) => `±${(x * 100).toFixed(1)}`;
  console.log(`  castable on curve ${pct(s.castOnCurve)} ${pm(s.castOnCurveMoe)} · colors OK given lands ${pct(s.colorConsistency)} ${pm(s.colorConsistencyMoe)} · 4th land T4 ${pct(s.turns[3].hitLandDrop)} ${pm(s.turns[3].hitLandDropMoe)}`);
  console.log(`  mana by T7 ${s.manaSpent.toFixed(1)} ±${s.manaSpentMoe.toFixed(1)} · mulligan ${pct(s.mulliganRate)} · flood ${pct(s.floodRate)} · life paid per game ${s.lifePaidPerGame.toFixed(1)}`);
};
show('Your manabase', r.current);
show('Suggested manabase', r.suggested);
if (r.suggested?.kept.length) console.log(`  kept as they are (they do more than make mana; --swap-utility lets the search replace them): ${r.suggested.kept.join(', ')}`);
const main = r.suggested || r.current;
console.log(`\n${main.sim.games} games per manabase; ± is the 95% margin of error.`);
console.log('\nOn-curve castability (when held on its turn):');
for (const s of main.sim.spells.sort((a, b) => a.cmc - b.cmc)) console.log(`  ${pct(s.onCurve)} ±${(s.onCurveMoe * 100).toFixed(1).padStart(4)}  MV${s.cmc} ${s.copies}x ${s.name}${s.isDraw ? ' (draw)' : ''}${s.domain ? ' (domain, left out of the average)' : s.costReduction ? ' (cost reduction not modelled)' : ''}${s.curveTurn !== s.cmc ? ` (checked turn ${s.curveTurn})` : ''}`);
console.log('\nLand count sweep:');
for (const s of r.sweep) console.log(`  ${s.lands} lands: on curve ${pct(s.castOnCurve)} · 4th land T4 ${pct(s.fourthLandOnTurn4)} · flood ${pct(s.floodRate)} · mana by T7 ${s.manaSpent.toFixed(1)}`);
if (r.drawSpells.length) console.log('\nDraw spells: ' + r.drawSpells.map((d) => `${d.name} (${d.effect})`).join('; '));
