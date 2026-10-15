// The visual deck editor: card images grouped by type, +/− buttons, land locks, and the
// dual lands the format allows for the deck's colors. It only draws; app.js owns the
// deck and passes callbacks for every change.
import { cardKey } from './lib/decklist.js';
import { cardImage } from './lib/scryfall.js';
import { normalizeCard } from './lib/cards.js';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const pips = (colors) => [...colors].map((c) => `<span class="pip ${c}">${c}</span>`).join('');

const GROUPS = ['Creatures', 'Planeswalkers', 'Battles', 'Instants', 'Sorceries', 'Artifacts', 'Enchantments', 'Other', 'Lands'];

function frontType(sc) {
  return (sc && (sc.card_faces?.[0]?.type_line || sc.type_line)) || '';
}

function groupOf(sc) {
  const t = frontType(sc);
  if (/\bCreature\b/.test(t)) return 'Creatures';
  if (/\bPlaneswalker\b/.test(t)) return 'Planeswalkers';
  if (/\bBattle\b/.test(t)) return 'Battles';
  if (/\bInstant\b/.test(t)) return 'Instants';
  if (/\bSorcery\b/.test(t)) return 'Sorceries';
  if (/\bLand\b/.test(t)) return 'Lands';
  if (/\bArtifact\b/.test(t)) return 'Artifacts';
  if (/\bEnchantment\b/.test(t)) return 'Enchantments';
  return 'Other';
}

// Whether the card counts as a land for the analysis (the front face is a land).
export function isLandCard(sc) {
  if (!sc) return false;
  try { return !!normalizeCard(sc, 1).land; } catch { return false; }
}

function tile(entry, section, sc, locked) {
  const img = sc && cardImage(sc, 'normal');
  const land = section === 'main' && isLandCard(sc);
  const key = esc(entry.name);
  return `<div class="tile${locked ? ' locked' : ''}" data-name="${key}" data-section="${section}">
    <div class="art">${img ? `<img src="${esc(img)}" alt="${key}" loading="lazy" width="146" height="204">` : `<div class="noimg">${key}${sc ? '' : '<br><span class="muted">not found on Scryfall</span>'}</div>`}
      <span class="count">${entry.count}</span>
      ${land ? `<button class="lock" data-act="lock" aria-pressed="${locked}" title="${locked ? 'Locked: the search keeps this land as it is. Click to unlock.' : 'Lock this land so the search never swaps it.'}">${locked ? '🔒' : '🔓'}</button>` : ''}
    </div>
    <div class="qty"><button class="secondary" data-act="dec" aria-label="Remove one ${key}">−</button><span class="name" title="${key}">${key}</span><button class="secondary" data-act="inc" aria-label="Add one ${key}">+</button></div>
  </div>`;
}

function section(title, entries, sectionName, cards, locks) {
  if (!entries.length) return '';
  const n = entries.reduce((a, e) => a + e.count, 0);
  return `<h3>${esc(title)} <span class="muted">(${n})</span></h3><div class="tiles">${entries
    .map((e) => tile(e, sectionName, cards.get(cardKey(e.name)), locks.has(cardKey(e.name))))
    .join('')}</div>`;
}

// deck: {main, commander, sideboard}; cards: Map(cardKey -> Scryfall card); locks: Set of cardKey.
// landOptions: entries from lands.js for the deck's colors, or null while loading.
export function renderEditor(el, { deck, cards, locks, formatName, landOptions, showAllLands, landsOpen = true }) {
  const groups = new Map(GROUPS.map((g) => [g, []]));
  for (const e of deck.main) groups.get(groupOf(cards.get(cardKey(e.name)))).push(e);
  const total = deck.main.reduce((a, e) => a + e.count, 0);
  const lands = groups.get('Lands').reduce((a, e) => a + e.count, 0);
  const html = [`<p class="summary"><b>${total}</b> cards · <b>${lands}</b> lands · <b>${total - lands}</b> spells${deck.sideboard?.length ? ` · ${deck.sideboard.reduce((a, e) => a + e.count, 0)} in the sideboard` : ''}${locks.size ? ` · 🔒 ${locks.size} locked` : ''}</p>`];
  html.push(section('Commander', deck.commander || [], 'commander', cards, locks));
  for (const g of GROUPS) html.push(section(g, groups.get(g), 'main', cards, locks));
  html.push(section('Sideboard', deck.sideboard || [], 'sideboard', cards, locks));

  if (landOptions === null) html.push('<h3>Dual lands</h3><p class="muted">Looking up the lands legal in ' + esc(formatName) + '…</p>');
  else if (landOptions && landOptions.length) {
    const inDeck = new Map(deck.main.map((e) => [cardKey(e.name), e.count]));
    const shown = showAllLands ? landOptions : landOptions.slice(0, 12);
    html.push(`<details class="duals"${landsOpen ? ' open' : ''}><summary><h3>Dual lands legal in ${esc(formatName)} for your colors <span class="muted">(${landOptions.length})</span></h3></summary>
      <p class="hint tip">Best first. A green frame means the deck already plays it; + adds a copy.</p>
      <div class="tiles small">${shown.map((o) => {
        const have = inDeck.get(cardKey(o.name)) || 0;
        const img = cardImage(o.card, 'normal');
        return `<div class="tile option${have ? ' have' : ''}" data-name="${esc(o.name)}">
          <div class="art">${img ? `<img src="${esc(img)}" alt="${esc(o.name)}" loading="lazy" width="146" height="204">` : `<div class="noimg">${esc(o.name)}</div>`}
            ${have ? `<span class="count">${have}</span>` : ''}</div>
          <div class="qty"><span class="name" title="${esc(o.name)}">${esc(o.name)}</span><button class="secondary" data-act="add-land" aria-label="Add one ${esc(o.name)}">+</button></div>
          <div class="how">${pips(o.colors)} ${esc(o.how)}</div>
        </div>`;
      }).join('')}</div>
      ${landOptions.length > shown.length ? `<button class="secondary more" data-act="more-lands">Show all ${landOptions.length}</button>` : ''}
    </details>`);
  }
  el.innerHTML = html.join('');
}

// One listener for every button in the editor.
export function bindEditor(el, handlers) {
  el.addEventListener('toggle', (e) => { if (e.target.matches('details.duals')) handlers.landsToggled(e.target.open); }, true);
  el.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const t = btn.closest('.tile');
    const name = t?.dataset.name;
    const sectionName = t?.dataset.section || 'main';
    const act = btn.dataset.act;
    if (act === 'inc') handlers.change(sectionName, name, 1);
    else if (act === 'dec') handlers.change(sectionName, name, -1);
    else if (act === 'lock') handlers.lock(name);
    else if (act === 'add-land') handlers.change('main', name, 1);
    else if (act === 'more-lands') handlers.moreLands();
  });
}
