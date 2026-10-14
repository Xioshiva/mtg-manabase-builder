// Mana symbols are bitmasks: W=1 U=2 B=4 R=8 G=16 C=32.
// Basic land types use the same bits (Plains=1 ... Forest=16).
export const COLOR_BITS = { W: 1, U: 2, B: 4, R: 8, G: 16, C: 32 };
export const COLOR_ORDER = ['W', 'U', 'B', 'R', 'G'];
export const ANY_COLOR = 31;
export const COLOR_NAMES = { W: 'White', U: 'Blue', B: 'Black', R: 'Red', G: 'Green', C: 'Colorless' };

export function popcount(m) {
  let c = 0;
  while (m) { m &= m - 1; c++; }
  return c;
}

export function maskToColors(mask) {
  return Object.keys(COLOR_BITS).filter((c) => mask & COLOR_BITS[c]);
}

export function colorsToMask(colors) {
  let m = 0;
  for (const c of colors || []) m |= COLOR_BITS[c] || 0;
  return m;
}

// Parse "{2}{W/U}{B}{X}" into { generic, pips: [mask...], twobrid: [mask...], x }.
// Phyrexian pips are ignored (you can always pay life in a goldfish game).
// Only the first half of split costs ("{1}{U} // {3}{U}") is read.
export function parseCost(str) {
  const cost = { generic: 0, pips: [], twobrid: [], x: 0 };
  if (!str) return cost;
  const first = str.split('//')[0];
  for (const m of first.matchAll(/\{([^}]+)\}/g)) {
    const sym = m[1].toUpperCase();
    if (/^\d+$/.test(sym)) cost.generic += Number(sym);
    else if (sym === 'X' || sym === 'Y' || sym === 'Z') cost.x++;
    else if (sym in COLOR_BITS) cost.pips.push(COLOR_BITS[sym]);
    else if (sym === 'S') cost.generic++;
    else if (sym.includes('/')) {
      const parts = sym.split('/');
      if (parts.includes('P')) continue;
      if (/^\d+$/.test(parts[0])) cost.twobrid.push(COLOR_BITS[parts[1]] || 0);
      else cost.pips.push(parts.reduce((a, p) => a | (COLOR_BITS[p] || 0), 0));
    }
  }
  return cost;
}

// Assign colored pips to distinct sources. Sources are tried fewest-colors first so
// flexible lands are saved for later. Returns the used source indices or null.
function assignPips(sources, pips, order) {
  const used = new Uint8Array(sources.length);
  const picked = [];
  const sorted = pips.slice().sort((a, b) => popcount(a) - popcount(b));
  function go(k) {
    if (k === sorted.length) return true;
    const p = sorted[k];
    for (const i of order) {
      if (!used[i] && (sources[i] & p)) {
        used[i] = 1; picked.push(i);
        if (go(k + 1)) return true;
        used[i] = 0; picked.pop();
      }
    }
    return false;
  }
  return go(0) ? picked : null;
}

// Returns the indices of sources to tap to pay `cost`, or null if it can't be paid.
// `sources` is an array of color masks, one per untapped mana source.
export function payCost(sources, cost) {
  const tb = cost.twobrid.length;
  const order = sources.map((_, i) => i).sort((a, b) => popcount(sources[a]) - popcount(sources[b]));
  // Each twobrid pip is paid either with its color or with two generic.
  for (let combo = 0; combo < 1 << tb; combo++) {
    const pips = cost.pips.slice();
    let generic = cost.generic;
    for (let k = 0; k < tb; k++) {
      if (combo & (1 << k)) generic += 2;
      else pips.push(cost.twobrid[k]);
    }
    if (sources.length < pips.length + generic) continue;
    const picked = assignPips(sources, pips, order);
    if (!picked) continue;
    if (generic === 0) return picked;
    const taken = new Set(picked);
    for (const i of order) {
      if (generic === 0) break;
      if (!taken.has(i)) { picked.push(i); taken.add(i); generic--; }
    }
    if (generic === 0) return picked;
  }
  return null;
}

export function canPay(sources, cost) {
  return payCost(sources, cost) !== null;
}
