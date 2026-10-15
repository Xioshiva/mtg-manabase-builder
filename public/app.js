import { parseDecklist, cardKey, formatDecklist, changeCount, replaceLands } from './lib/decklist.js';
import { fetchCollection, searchLands, trimCard } from './lib/scryfall.js';
import { FORMATS } from './lib/formats.js';
import { normalizeCard, isBasicName } from './lib/cards.js';
import { colorDemand } from './lib/sim.js';
import { COLOR_ORDER } from './lib/mana.js';
import { recognizeDeckLink } from './lib/importers.js';
import { buildModel, runAnalysis } from './lib/analysis.js';
import { createSimPool } from './lib/pool.js';
import { createDeckStore } from './lib/deckstore.js';
import { landOptions, landsForColor } from './lib/lands.js';
import { renderEditor, bindEditor, isLandCard } from './editor.js';

const $ = (id) => document.getElementById(id);
const CACHE_KEY = 'manabase-card-cache-v2'; // v2 keeps image links
try { localStorage.removeItem('manabase-card-cache-v1'); } catch {}
const SAMPLE = `Deck
4 Opt
4 Consider
2 Sleight of Hand
2 Stock Up
2 Quick Study
4 Cloudkin Seer
4 Shock
4 Lightning Strike
4 Slickshot Show-Off
2 Glorybringer
2 Izzet Charm
2 Sink into Stupor
8 Island
6 Mountain
4 Spirebluff Canal
4 Thundering Falls
2 Riverpyre Verge`;

for (const f of Object.values(FORMATS)) {
  const o = document.createElement('option');
  o.value = f.id;
  o.textContent = f.status === 'ready' ? f.name : `${f.name} (preview)`;
  $('format').append(o);
}

function loadCache() {
  try { return JSON.parse(localStorage.getItem(CACHE_KEY) || '{}'); } catch { return {}; }
}
function saveCache(cache) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(cache)); } catch {}
}

// Names Scryfall didn't know this visit, so they aren't asked for again (cardKey).
const notOnScryfall = new Set();

async function getCards(names) {
  let cache = loadCache();
  const missing = [...new Set(names.filter((n) => !cache[cardKey(n)] && !notOnScryfall.has(cardKey(n))))];
  if (missing.length) {
    const msg = `Fetching ${missing.length} card${missing.length === 1 ? '' : 's'} from Scryfall…`;
    setStatus(msg);
    try {
      const res = await fetchCollection(missing);
      // Re-read: another lookup may have saved cards while this one waited.
      cache = loadCache();
      for (const [k, c] of res.cards) cache[k] = trimCard(c);
      for (const n of res.notFound) notOnScryfall.add(cardKey(n));
      saveCache(cache);
    } finally {
      if ($('status').textContent === msg) setStatus('');
    }
  }
  const map = new Map();
  for (const n of names) if (cache[cardKey(n)]) map.set(cardKey(n), cache[cardKey(n)]);
  return { map, notFound: names.filter((n) => notOnScryfall.has(cardKey(n))) };
}

// The cards this browser already has, without asking Scryfall.
function cachedCards(names) {
  const cache = loadCache();
  const map = new Map();
  for (const n of names) if (cache[cardKey(n)]) map.set(cardKey(n), cache[cardKey(n)]);
  return map;
}

// Saves Scryfall cards we already have (the legal land search) so adding one needs no lookup.
function addToCache(cards) {
  const cache = loadCache();
  for (const c of cards) {
    cache[cardKey(c.name)] ??= c;
    for (const f of c.card_faces || []) cache[cardKey(f.name)] ??= c;
  }
  saveCache(cache);
}

function deckColorsOf(entries, map) {
  const defs = entries.map((e) => map.get(cardKey(e.name))).filter(Boolean).map((c) => normalizeCard(c, 1));
  const demand = colorDemand(defs);
  return COLOR_ORDER.filter((c) => demand[c] > 0);
}

// Nonbasic lands legal in the format within the deck's colors (cached for the session).
async function legalLands(format, colors) {
  const key = `manabase-lands-v2-${format.legalityKey}-${colors.join('')}`;
  let lands = null;
  try { lands = JSON.parse(sessionStorage.getItem(key) || 'null'); } catch {}
  if (!lands) {
    lands = (await searchLands(colors, format.legalityKey)).map(trimCard);
    try { sessionStorage.setItem(key, JSON.stringify(lands)); } catch {}
    addToCache(lands);
  }
  return lands;
}

function setStatus(text) { $('status').textContent = text; }

const pct = (x) => (x * 100).toFixed(1) + '%';
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const pips = (colors) => [...colors].map((c) => `<span class="pip ${c}">${c}</span>`).join('');
const cls = (x) => (x >= 0.9 ? 'ok' : x >= 0.8 ? 'meh' : 'bad');

function delta(a, b, fmt = pct, invert = false) {
  if (a == null || b == null) return '';
  const d = b - a;
  if (Math.abs(d) < 0.0005) return '<span class="d muted">no change</span>';
  const good = invert ? d < 0 : d > 0;
  const shown = fmt === pct ? (d * 100).toFixed(1) + ' pts' : d.toFixed(1);
  return `<span class="d ${good ? 'up' : 'down'}">${d > 0 ? '+' : ''}${shown}</span>`;
}

const pm = (x, fmt) => `<span class="moe">±${fmt(x)}</span>`;
const pts = (x) => (x * 100).toFixed(1);

function kpis(cur, sug) {
  // [label, value, margin of error (95%), format, lower is better]
  const rows = [
    ['Spells castable on curve', (r) => r.sim.castOnCurve, (r) => r.sim.castOnCurveMoe, pct, false],
    ['Colors OK when you had the lands', (r) => r.sim.colorConsistency, (r) => r.sim.colorConsistencyMoe, pct, false],
    ['4th land on turn 4', (r) => r.sim.turns[3].hitLandDrop, (r) => r.sim.turns[3].hitLandDropMoe, pct, false],
    ['Mana spent by turn 7', (r) => r.sim.manaSpent, (r) => r.sim.manaSpentMoe, (x) => x.toFixed(1), false],
    ['Mulligan rate', (r) => r.sim.mulliganRate, (r) => r.sim.mulliganRateMoe, pct, true],
    ['Flooded (lots of extra lands)', (r) => r.sim.floodRate, (r) => r.sim.floodRateMoe, pct, true],
    ['Life paid to lands per game', (r) => r.sim.lifePaidPerGame, null, (x) => x.toFixed(1), true],
  ];
  const main = sug || cur;
  return `<div class="kpis">${rows.map(([label, get, err, fmt, inv]) => `
    <div class="kpi"><div class="v">${fmt(get(main))}${err ? ' ' + pm(err(main), fmt === pct ? (x) => pts(x) : (x) => x.toFixed(1)) : ''}</div><div class="l">${label}</div>
    ${cur && sug ? `<div>${delta(get(cur), get(sug), fmt === pct ? pct : null, inv)} <span class="muted d">vs yours (${fmt(get(cur))})</span></div>` : ''}</div>`).join('')}</div>
    <p class="muted">± is the 95% margin of error from the number of games simulated. Both manabases play the same shuffled games, so the difference between them is more precise than either ± suggests.</p>`;
}

function groupSwaps(history) {
  const counts = new Map();
  for (const h of history) {
    const key = `${h.out} → ${h.in}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts].map(([k, n]) => `${n > 1 ? n + '× ' : ''}${esc(k)}`).join(', ');
}

function landTable(lands) {
  return `<div class="table-wrap"><table><tr><th class="n">#</th><th>Land</th><th>Colors</th><th>Enters</th></tr>
    ${lands.map((l) => `<tr><td class="n">${l.count}</td><td>${esc(l.name)}</td><td>${pips(l.colors)}</td><td class="muted">${esc(l.how)}</td></tr>`).join('')}
  </table></div>`;
}

// For each color short of sources, the best legal duals the deck doesn't play yet.
function shortHints(r) {
  const options = state.lands.options;
  const yours = r.current && r.current.sources;
  if (!yours || !options || !options.length) return '';
  const inDeck = new Set(state.deck.main.map((e) => cardKey(e.name)));
  const lines = r.colors.filter((c) => yours[c] < r.sourcesNeeded.need[c]).map((c) => {
    const picks = landsForColor(options, c).filter((o) => !inDeck.has(cardKey(o.name.split(' // ')[0]))).slice(0, 4);
    return picks.length ? `<li>Short on ${pips(c)} (${yours[c]} of ${r.sourcesNeeded.need[c]}): ${picks.map((o) => `${esc(o.name)} ${pips(o.colors)}`).join(', ')}</li>` : '';
  }).filter(Boolean);
  return lines.length ? `<h3>Dual lands that would help</h3><ul class="notes">${lines.join('')}</ul><p class="muted">All legal in ${esc(r.format)}. Add them from the card view with +.</p>` : '';
}

let lastResult = null;
function clearResults() {
  lastResult = null;
  $('results').innerHTML = '';
}
// What an analysis depends on, to tell whether the deck changed after it.
const analyzedKey = (format, main) => [format, ...main.map((e) => `${e.count} ${cardKey(e.name)}`).sort()].join('\n');

function render(r) {
  lastResult = r;
  const cur = r.current, sug = r.suggested;
  const html = [];
  const problems = [];
  if (r.unknown.length) problems.push(`Not found on Scryfall (ignored): ${r.unknown.map(esc).join(', ')}`);
  if (r.illegal.length) problems.push(`Not legal in ${r.format}: ${r.illegal.map(esc).join(', ')}`);
  problems.push(...r.warnings.map(esc));
  if (problems.length) html.push(`<section class="panel"><h2>Check your list</h2><ul class="notes">${problems.map((p) => `<li>${p}</li>`).join('')}</ul></section>`);

  const rec = r.recommendedLands;
  html.push(`<section class="panel"><h2>Recommendation</h2>
    <p>Your spells average <b>${r.stats.avgCmc.toFixed(2)}</b> mana value with <b>${r.stats.cheapDrawOrRamp}</b> cheap draw or ramp spells${r.stats.mdfc ? ` and <b>${r.stats.mdfc}</b> spell/land double-faced cards` : ''}.
    Karsten's formula suggests <b>${rec.count} lands</b> (${rec.exact.toFixed(1)}${rec.mdfcCredit ? `, minus ${rec.mdfcCredit} for the double-faced cards` : ''}).
    ${r.currentLands ? `You play <b>${r.currentLands}</b>.` : ''} The simulation below used <b>${r.landCount}</b>.</p>
    <div class="table-wrap"><table><tr><th>Color</th><th class="n">Sources needed (90%)</th>${cur ? '<th class="n">Yours</th>' : ''}${sug ? '<th class="n">Suggested</th>' : ''}<th>Hardest card</th></tr>
    ${r.colors.map((c) => {
      const need = r.sourcesNeeded.need[c];
      const mark = (n) => `<span class="${n >= need ? 'ok' : n >= need - 2 ? 'meh' : 'bad'}">${n}</span>`;
      return `<tr><td>${pips(c)}</td><td class="n">${need}</td>${cur ? `<td class="n">${mark(cur.sources[c])}</td>` : ''}${sug ? `<td class="n">${mark(sug.sources[c])}</td>` : ''}<td class="muted">${esc(r.sourcesNeeded.why[c] || '')}</td></tr>`;
    }).join('')}</table></div>
    <p class="muted">Sources needed is a quick probability estimate; the simulated numbers below are the real test.</p>
    ${shortHints(r)}
  </section>`);

  html.push(`<section class="panel"><h2>${sug ? 'Suggested manabase' : 'Your manabase'}</h2>${kpis(cur, sug)}
    <div class="grid">
      ${cur ? `<div><h3>Yours (${cur.lands.reduce((a, l) => a + l.count, 0)} lands)</h3>${landTable(cur.lands)}</div>` : ''}
      ${sug ? `<div><h3>Suggested (${sug.lands.reduce((a, l) => a + l.count, 0)} lands)</h3>${landTable(sug.lands)}
        <h3>Copy into your list</h3><div class="landlist" id="landlist">${sug.lands.map((l) => `${l.count} ${esc(l.name.split(' // ')[0])}`).join('\n')}</div>
        ${sug.history.length ? `<p class="muted">Changes found by the search: ${groupSwaps(sug.history)}</p>` : '<p class="muted">The search found no swap that clearly helped.</p>'}
        ${sug.locked && sug.locked.length ? `<p class="muted">🔒 Kept as you locked them: ${sug.locked.map(esc).join(', ')}.</p>` : ''}
        ${sug.kept && sug.kept.length ? `<p class="muted">Kept as they are because they do more than make mana: ${sug.kept.map(esc).join(', ')}.</p>` : ''}
        <button id="applySuggested" class="secondary">Use these lands in my list</button>
      </div>` : ''}
    </div></section>`);

  const spellsCur = cur ? new Map(cur.sim.spells.map((s) => [s.name, s])) : new Map();
  const main = sug || cur;
  html.push(`<section class="panel"><h2>Can you cast each spell on curve?</h2>
    <p class="muted">When you hold the card on the turn equal to its mana value, how often can your lands pay for it? “Lands but not colors” counts games where you had enough lands but the wrong colors or a tapped land.</p>
    <div class="table-wrap"><table><tr><th>Spell</th><th class="n">MV</th><th class="n">Copies</th>${cur && sug ? '<th class="n">Yours</th>' : ''}<th class="n">${sug ? 'Suggested' : 'Castable'}</th><th class="n">Lands but not colors</th><th></th></tr>
    ${main.sim.spells.sort((a, b) => a.cmc - b.cmc || a.name.localeCompare(b.name)).map((s) => {
      const c = spellsCur.get(s.name);
      const colorFail = s.enoughLands * (1 - s.onCurveGivenEnough);
      const tags = [s.isDraw && 'draw', s.costReduction && 'cost reduction not modelled, left out of the average', s.curveTurn !== s.cmc && `checked on turn ${s.curveTurn} for its extra cost`].filter(Boolean);
      return `<tr><td>${esc(s.name)}${tags.length ? ` <span class="muted">(${tags.join('; ')})</span>` : ''}</td><td class="n">${s.cmc}</td><td class="n">${s.copies}</td>
        ${cur && sug ? `<td class="n ${cls(c ? c.onCurve : 0)}">${c ? pct(c.onCurve) : '–'}</td>` : ''}
        <td class="n ${cls(s.onCurve)}">${pct(s.onCurve)} ${pm(s.onCurveMoe, pts)}</td><td class="n">${pct(colorFail)}</td>
        <td><div class="bar"><span style="width:${(s.onCurve * 100).toFixed(0)}%"></span></div></td></tr>`;
    }).join('')}</table></div></section>`);

  html.push(`<section class="panel"><h2>Land drops by turn</h2><div class="table-wrap"><table>
    <tr><th>Turn</th>${main.sim.turns.map((t) => `<th class="n">${t.turn}</th>`).join('')}</tr>
    ${cur && sug ? `<tr><td>Hit land drop (yours)</td>${cur.sim.turns.map((t) => `<td class="n">${pct(t.hitLandDrop)}</td>`).join('')}</tr>` : ''}
    <tr><td>Hit land drop${cur && sug ? ' (suggested)' : ''}</td>${main.sim.turns.map((t) => `<td class="n">${pct(t.hitLandDrop)}</td>`).join('')}</tr>
    <tr><td class="muted">Margin of error (±)</td>${main.sim.turns.map((t) => `<td class="n muted">${pts(t.hitLandDropMoe)}</td>`).join('')}</tr>
    <tr><td>Total mana spent</td>${main.sim.turns.map((t) => `<td class="n">${t.manaSpent.toFixed(1)}</td>`).join('')}</tr>
    </table></div>
    <p class="muted">${main.sim.games.toLocaleString()} games. Draw and selection spells cast per game: ${main.sim.drawSpellsPerGame.toFixed(2)}, extra cards drawn: ${main.sim.extraCardsPerGame.toFixed(2)}. Average opening hand kept: ${main.sim.avgKept.toFixed(2)} cards.</p></section>`);

  html.push(`<section class="panel"><h2>More or fewer lands?</h2>
    <p class="muted">Same deck with a few lands added (cutting the most expensive spells) or removed (replaced by a generic two-drop).</p>
    <div class="table-wrap"><table><tr><th class="n">Lands</th><th class="n">Castable on curve</th><th class="n">4th land on turn 4</th><th class="n">Flooded</th><th class="n">Mana spent by T7</th></tr>
    ${r.sweep.map((s) => `<tr${s.delta === 0 ? ' style="font-weight:700"' : ''}><td class="n">${s.lands}</td><td class="n">${pct(s.castOnCurve)}</td><td class="n">${pct(s.fourthLandOnTurn4)}</td><td class="n">${pct(s.floodRate)}</td><td class="n">${s.manaSpent.toFixed(1)}</td></tr>`).join('')}
    </table></div></section>`);

  html.push(`<section class="panel"><h2>Draw and selection spells the simulator casts</h2>
    ${r.drawSpells.length ? `<div class="table-wrap"><table><tr><th>Card</th><th class="n">Copies</th><th class="n">MV</th><th>Read as</th></tr>
    ${r.drawSpells.map((d) => `<tr><td>${esc(d.name)}</td><td class="n">${d.count}</td><td class="n">${d.cmc}</td><td>${esc(d.effect)}</td></tr>`).join('')}</table></div>` : '<p class="muted">None found in this list.</p>'}
    ${r.notes.length ? `<h3>Notes</h3><ul class="notes">${[...new Set(r.notes)].map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
  </section>`);

  $('results').innerHTML = html.join('');
}

// Simulations run on one worker per CPU thread (at most 16; each simulation has only 20
// chunks to share out); the page itself only hands out the work and adds up the results.
const THREADS = Math.max(1, Math.min(navigator.hardwareConcurrency || 4, 16));
function startPool() {
  return createSimPool({
    size: THREADS,
    spawn(onMessage, onError) {
      const w = new Worker(new URL('./sim-worker.js', import.meta.url), { type: 'module' });
      w.onmessage = (e) => onMessage(e.data);
      w.onerror = (e) => { e.preventDefault(); onError(new Error(e.message || 'a simulation worker failed to start')); };
      return { post: (msg) => w.postMessage(msg), terminate: () => w.terminate() };
    },
  });
}

let pool = null;
let runId = 0; // a newer run makes an older one's results stale
async function run() {
  flushTyping();
  const text = $('deck').value;
  const id = ++runId;
  saveWorkingDeck();
  const parsed = parseDecklist(text);
  if (!parsed.main.length) { setStatus('Paste a decklist first.'); return; }
  const format = FORMATS[$('format').value];
  $('run').disabled = true;
  try {
    const names = [...parsed.main, ...parsed.commander].map((c) => c.name);
    const { map } = await getCards(names);
    let candidateCards = [];
    if ($('optimize').checked) {
      const colors = deckColorsOf([...parsed.main, ...parsed.commander], map);
      if (colors.length > 1) {
        setStatus('Looking up dual lands legal in ' + format.name + '…');
        candidateCards = await legalLands(format, colors);
      }
    }
    if (pool) pool.close();
    pool = startPool();
    const threads = `${THREADS} thread${THREADS === 1 ? '' : 's'}`;
    setStatus(`Simulating on ${threads}…`);
    const built = buildModel(parsed, map, format);
    const result = await runAnalysis({
      model: built.model, mode: $('mode').value, candidateCards,
      games: Number($('games').value), play: $('play').value,
      landCount: Number($('landCount').value) || undefined, optimize: $('optimize').checked, keepUtility: $('keepUtility').checked,
      lockedLands: parsed.main.filter((e) => state.locks.has(cardKey(e.name))).map((e) => e.name),
      sim: pool,
      onProgress: (p) => { if (id === runId) setStatus(`${p.stage}${p.iter ? ` (step ${p.iter})` : ''} on ${threads}…`); },
    });
    if (id !== runId) return;
    render({ ...result, unknown: built.unknown, illegal: built.illegal, warnings: built.warnings, analyzed: analyzedKey(format.id, parsed.main) });
    setStatus('Done.');
  } catch (err) {
    if (id !== runId) return;
    setStatus('Error: ' + err.message);
    console.error(err);
  } finally {
    if (id === runId) {
      $('run').disabled = false;
      if (pool) { pool.close(); pool = null; }
    }
  }
}

async function importLink() {
  const link = $('deckLink').value.trim();
  const known = recognizeDeckLink(link);
  if (!known) { setStatus('Paste a link to a Moxfield deck or an MTGTop8 deck.'); return; }
  $('importLink').disabled = true;
  setStatus(`Importing from ${known.site}…`);
  try {
    const res = await fetch(`/api/deck?url=${encodeURIComponent(link)}`);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `server returned ${res.status}`);
    if (body.format && FORMATS[body.format]) $('format').value = body.format;
    state.locks.clear();
    startNewDeck(body.name || '');
    setDeckText(body.text);
    showView('cards');
    setStatus(`Imported ${body.name || 'deck'} from ${known.site}.`);
  } catch (err) {
    const how = known.site === 'Moxfield' ? 'In Moxfield, use Export → Copy for MTGA' : 'On MTGTop8, open the deck and use the MTGO export';
    setStatus(`Couldn't import from ${known.site} (${err.message}). ${how}, then paste the list below.`);
  } finally {
    $('importLink').disabled = false;
  }
}

$('importLink').addEventListener('click', importLink);
$('deckLink').addEventListener('keydown', (e) => { if (e.key === 'Enter') importLink(); });
$('run').addEventListener('click', run);
$('sample').addEventListener('click', () => {
  state.locks.clear();
  startNewDeck('');
  setDeckText(SAMPLE);
  showView('cards');
});

// ---- Deck editor: the text box and the card view show the same deck. ----

const state = {
  deck: parseDecklist(''),
  cards: new Map(), // cardKey -> Scryfall card
  locks: new Set(), // cardKey of lands the search must not change
  lands: { key: '', options: [] }, // legal duals for the deck's colors
  showAllLands: false,
  landsOpen: true,
};
const store = createDeckStore();
let refreshId = 0;
let openedName = null; // the saved deck now in the editor, if any
let typing = null; // pending update from the text box

// A deck that didn't come from the saved list: forget the old results and saved name.
function startNewDeck(name) {
  clearResults();
  openedName = null;
  $('deckName').value = name;
  $('savedDecks').value = '';
  $('deleteDeck').disabled = true;
}

// Applies what was typed in the text box right away instead of after the pause.
function flushTyping() {
  if (typing === null) return;
  clearTimeout(typing);
  typing = null;
  setDeckText($('deck').value);
}

function saveWorkingDeck() {
  try {
    localStorage.setItem('manabase-deck', $('deck').value);
    localStorage.setItem('manabase-locks', JSON.stringify([...state.locks]));
    localStorage.setItem('manabase-format', $('format').value);
  } catch {}
}

function drawEditor() {
  renderEditor($('editor'), {
    deck: state.deck, cards: state.cards, locks: state.locks, notFound: notOnScryfall, formatName: FORMATS[$('format').value].name,
    landOptions: state.lands.options, showAllLands: state.showAllLands, landsOpen: state.landsOpen,
  });
}

// Fetches card data (and images) for anything new, then the legal duals for the deck's colors.
// Locks stay set when a land leaves the deck, so taking the last copy out and putting
// it back keeps the lock; only locked lands still in the main deck are used.
async function refresh() {
  const id = ++refreshId;
  const d = state.deck;
  const names = ['commander', 'companion', 'main', 'sideboard', 'maybeboard'].flatMap((s) => d[s] || []).map((e) => e.name);
  // Draw at once from what this browser already has; new cards appear after the lookup.
  state.cards = cachedCards(names);
  drawEditor();
  let cards = state.cards;
  try {
    cards = (await getCards(names)).map;
  } catch (err) {
    if (id === refreshId) setStatus(`Couldn't reach Scryfall for card data (${err.message}).`);
  }
  if (id !== refreshId) return;
  state.cards = cards;
  drawEditor();

  const format = FORMATS[$('format').value];
  const colors = deckColorsOf([...d.main, ...d.commander], state.cards);
  const key = `${format.id}-${colors.join('')}`;
  if (key === state.lands.key) return;
  if (colors.length < 2) { state.lands = { key, options: [] }; drawEditor(); return; }
  const entry = { key, options: null };
  state.lands = entry;
  drawEditor();
  try {
    entry.options = landOptions(await legalLands(format, colors), colors);
  } catch (err) {
    // An empty key makes the next refresh try again.
    entry.options = [];
    entry.key = '';
    if (state.lands === entry) setStatus(`Couldn't look up the lands legal in ${format.name} (${err.message}).`);
  }
  if (state.lands === entry) drawEditor();
}

function setDeckText(text) {
  $('deck').value = text;
  state.deck = parseDecklist(text);
  saveWorkingDeck();
  return refresh();
}

function setDeck(deck) {
  state.deck = deck;
  $('deck').value = formatDecklist(deck);
  saveWorkingDeck();
  return refresh();
}

function showView(which) {
  const cards = which === 'cards';
  if (cards) flushTyping();
  $('cardsView').hidden = !cards;
  $('textView').hidden = cards;
  $('viewCards').setAttribute('aria-selected', String(cards));
  $('viewText').setAttribute('aria-selected', String(!cards));
}

bindEditor($('editor'), {
  change(section, name, delta) {
    flushTyping();
    setDeck(changeCount(state.deck, section, name, delta));
  },
  lock(name) {
    flushTyping();
    const k = cardKey(name);
    if (state.locks.has(k)) state.locks.delete(k); else state.locks.add(k);
    saveWorkingDeck();
    drawEditor();
  },
  moreLands() { state.showAllLands = true; drawEditor(); },
  landsToggled(open) { state.landsOpen = open; },
});

$('viewCards').addEventListener('click', () => showView('cards'));
$('viewText').addEventListener('click', () => showView('text'));

$('deck').addEventListener('input', () => {
  clearTimeout(typing);
  typing = setTimeout(() => { typing = null; setDeckText($('deck').value); }, 500);
});
$('format').addEventListener('change', () => { state.lands = { key: '', options: [] }; saveWorkingDeck(); refresh(); });

$('results').addEventListener('click', (e) => {
  if (e.target.id !== 'applySuggested' || !lastResult?.suggested) return;
  flushTyping();
  if (analyzedKey($('format').value, state.deck.main) !== lastResult.analyzed
    && !confirm('Your deck or format changed after this analysis. Use its lands anyway?')) return;
  const rows = lastResult.suggested.lands.map((l) => ({ name: l.name.split(' // ')[0], count: l.count }));
  const isLand = (name) => isBasicName(name) || isLandCard(state.cards.get(cardKey(name)));
  const deck = replaceLands(state.deck, isLand, rows);
  lastResult.analyzed = analyzedKey($('format').value, deck.main);
  setDeck(deck);
  showView('cards');
  setStatus('Your list now has the suggested lands. Analyze again to check it.');
  $('deckEditor').scrollIntoView({ behavior: 'smooth' });
});

// Adding a card by name, with Scryfall's autocomplete for suggestions.
let suggestTimer = null;
$('addCard').addEventListener('input', () => {
  clearTimeout(suggestTimer);
  const q = $('addCard').value.trim();
  if (q.length < 2) return;
  suggestTimer = setTimeout(async () => {
    try {
      const res = await fetch(`https://api.scryfall.com/cards/autocomplete?q=${encodeURIComponent(q)}`);
      const body = await res.json();
      $('addCardList').innerHTML = (body.data || []).slice(0, 12).map((n) => `<option value="${esc(n)}">`).join('');
    } catch {}
  }, 250);
});
function addCard() {
  const name = $('addCard').value.trim();
  if (!name) return;
  flushTyping();
  $('addCard').value = '';
  setDeck(changeCount(state.deck, 'main', name, 1));
}
$('addCardBtn').addEventListener('click', addCard);
$('addCard').addEventListener('keydown', (e) => { if (e.key === 'Enter') addCard(); });

// Saved decks live in this browser's storage.
function listSaved(selected = '') {
  const decks = store.list();
  $('savedDecks').innerHTML = `<option value="">${decks.length ? 'Open a saved deck…' : 'No saved decks yet'}</option>`
    + decks.map((d) => `<option value="${esc(d.name)}"${d.name === selected ? ' selected' : ''}>${esc(d.name)}${FORMATS[d.format] ? ` (${esc(FORMATS[d.format].name)})` : ''}</option>`).join('');
  $('deleteDeck').disabled = !selected;
}
$('savedDecks').addEventListener('change', () => {
  const entry = store.get($('savedDecks').value);
  $('deleteDeck').disabled = !entry;
  if (!entry) return;
  if (FORMATS[entry.format]) $('format').value = entry.format;
  state.locks = new Set((entry.locks || []).map(cardKey));
  clearResults();
  openedName = entry.name;
  $('deckName').value = entry.name;
  setDeckText(entry.text);
  showView('cards');
  setStatus(`Opened "${entry.name}".`);
});
$('saveDeck').addEventListener('click', () => {
  flushTyping();
  // Saving under the name of a different saved deck replaces it, so ask first.
  const other = store.get($('deckName').value);
  if (other && other.name.toLowerCase() !== (openedName || '').toLowerCase() && other.text !== $('deck').value
    && !confirm(`You already have a saved deck called "${other.name}". Replace it with this one?`)) return;
  try {
    const saved = store.save({
      name: $('deckName').value, text: $('deck').value, format: $('format').value,
      locks: state.deck.main.filter((e) => state.locks.has(cardKey(e.name))).map((e) => e.name),
    });
    openedName = saved.name;
    listSaved(saved.name);
    setStatus(`Saved "${saved.name}".`);
  } catch (err) {
    setStatus(err.message);
    $('deckName').focus();
  }
});
$('deleteDeck').addEventListener('click', () => {
  const name = $('savedDecks').value;
  if (!name || !confirm(`Delete the saved deck "${name}"?`)) return;
  store.remove(name);
  if (openedName && openedName.toLowerCase() === name.toLowerCase()) openedName = null;
  listSaved();
  setStatus(`Deleted "${name}".`);
});
$('downloadDeck').addEventListener('click', () => {
  const name = $('deckName').value.trim() || 'deck';
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([$('deck').value], { type: 'text/plain' }));
  a.download = `${name.replace(/[\\/:*?"<>|]+/g, '-')}.txt`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

// Start where the last visit left off.
listSaved();
try {
  const f = localStorage.getItem('manabase-format');
  if (f && FORMATS[f]) $('format').value = f;
  state.locks = new Set(JSON.parse(localStorage.getItem('manabase-locks') || '[]'));
  $('deck').value = localStorage.getItem('manabase-deck') || '';
} catch {}
state.deck = parseDecklist($('deck').value);
showView(state.deck.main.length ? 'cards' : 'text');
if (state.deck.main.length) refresh();
