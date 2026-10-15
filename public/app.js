import { parseDecklist, cardKey } from './lib/decklist.js';
import { fetchCollection, searchLands, trimCard } from './lib/scryfall.js';
import { FORMATS } from './lib/formats.js';
import { normalizeCard } from './lib/cards.js';
import { colorDemand } from './lib/sim.js';
import { COLOR_ORDER } from './lib/mana.js';
import { recognizeDeckLink } from './lib/importers.js';
import { buildModel, runAnalysis } from './lib/analysis.js';
import { createSimPool } from './lib/pool.js';

const $ = (id) => document.getElementById(id);
const CACHE_KEY = 'manabase-card-cache-v1';
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
try { $('deck').value = localStorage.getItem('manabase-deck') || ''; } catch {}

function loadCache() {
  try { return JSON.parse(localStorage.getItem(CACHE_KEY) || '{}'); } catch { return {}; }
}
function saveCache(cache) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(cache)); } catch {}
}

async function getCards(names) {
  const cache = loadCache();
  const missing = names.filter((n) => !cache[cardKey(n)]);
  let notFound = [];
  if (missing.length) {
    setStatus(`Fetching ${missing.length} cards from Scryfall…`);
    const res = await fetchCollection(missing);
    for (const [k, c] of res.cards) cache[k] = trimCard(c);
    notFound = res.notFound;
    saveCache(cache);
  }
  const map = new Map();
  for (const n of names) if (cache[cardKey(n)]) map.set(cardKey(n), cache[cardKey(n)]);
  return { map, notFound };
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

function render(r) {
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
  </section>`);

  html.push(`<section class="panel"><h2>${sug ? 'Suggested manabase' : 'Your manabase'}</h2>${kpis(cur, sug)}
    <div class="grid">
      ${cur ? `<div><h3>Yours (${cur.lands.reduce((a, l) => a + l.count, 0)} lands)</h3>${landTable(cur.lands)}</div>` : ''}
      ${sug ? `<div><h3>Suggested (${sug.lands.reduce((a, l) => a + l.count, 0)} lands)</h3>${landTable(sug.lands)}
        <h3>Copy into your list</h3><div class="landlist" id="landlist">${sug.lands.map((l) => `${l.count} ${esc(l.name.split(' // ')[0])}`).join('\n')}</div>
        ${sug.history.length ? `<p class="muted">Changes found by the search: ${groupSwaps(sug.history)}</p>` : '<p class="muted">The search found no swap that clearly helped.</p>'}
        ${sug.kept && sug.kept.length ? `<p class="muted">Kept as they are because they do more than make mana: ${sug.kept.map(esc).join(', ')}.</p>` : ''}
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
  const text = $('deck').value;
  const id = ++runId;
  try { localStorage.setItem('manabase-deck', text); } catch {}
  const parsed = parseDecklist(text);
  if (!parsed.main.length) { setStatus('Paste a decklist first.'); return; }
  const format = FORMATS[$('format').value];
  $('run').disabled = true;
  try {
    const names = [...parsed.main, ...parsed.commander].map((c) => c.name);
    const { map } = await getCards(names);
    let candidateCards = [];
    if ($('optimize').checked) {
      const defs = [...map.values()].map((c) => normalizeCard(c, 1));
      const demand = colorDemand(defs);
      const colors = COLOR_ORDER.filter((c) => demand[c] > 0);
      if (colors.length > 1) {
        setStatus('Looking up dual lands legal in ' + format.name + '…');
        const key = `manabase-lands-${format.legalityKey}-${colors.join('')}`;
        try { candidateCards = JSON.parse(sessionStorage.getItem(key) || 'null'); } catch {}
        if (!candidateCards) {
          candidateCards = (await searchLands(colors, format.legalityKey)).map(trimCard);
          try { sessionStorage.setItem(key, JSON.stringify(candidateCards)); } catch {}
        }
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
      sim: pool,
      onProgress: (p) => { if (id === runId) setStatus(`${p.stage}${p.iter ? ` (step ${p.iter})` : ''} on ${threads}…`); },
    });
    if (id !== runId) return;
    render({ ...result, unknown: built.unknown, illegal: built.illegal, warnings: built.warnings });
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
    $('deck').value = body.text;
    if (body.format && FORMATS[body.format]) $('format').value = body.format;
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
$('sample').addEventListener('click', () => { $('deck').value = SAMPLE; });
