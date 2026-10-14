// Turns Scryfall card objects into the small models the simulator uses:
// lands (colors, enters-tapped rules, fetches) and spells (cost, draw/selection effects).
import { COLOR_BITS, ANY_COLOR, parseCost, colorsToMask } from './mana.js';

const TYPE_BITS = { plains: 1, island: 2, swamp: 4, mountain: 8, forest: 16 };
export const BASIC_BY_COLOR = { W: 'Plains', U: 'Island', B: 'Swamp', R: 'Mountain', G: 'Forest' };
const COLOR_WORD = { white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' };
const NUMBERS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, x: 0 };

function num(word) {
  const w = (word || '').toLowerCase();
  if (w in NUMBERS) return NUMBERS[w];
  const n = parseInt(w, 10);
  return Number.isFinite(n) ? n : 0;
}

function typeBits(text) {
  let m = 0;
  for (const w of (text || '').toLowerCase().split(/[^a-z]+/)) m |= TYPE_BITS[w] || 0;
  return m;
}

function subtypes(typeLine) {
  const parts = (typeLine || '').split('—');
  return parts.length > 1 ? typeBits(parts[1]) : 0;
}

function stripReminder(text) {
  return (text || '').replace(/\([^)]*\)/g, '');
}

export function parseLand(face, producedFallback) {
  const typeLine = face.type_line || '';
  const types = subtypes(typeLine);
  const land = {
    mask: types, // basic land types tap for their color
    cond: [], // [{ mask, types }] mana that needs a land type in play (verges)
    choices: null, // [mask...] picked when played (pathways, thriving lands)
    etb: 'untapped',
    etbTypes: 0,
    types,
    isBasic: /\bBasic\b/.test(typeLine),
    fetch: null,
    surveil: 0,
    pain: 0, // life paid each time it's tapped for mana
    shockLife: 0, // life paid to have it enter untapped
    notes: [],
  };
  const text = stripReminder(face.oracle_text);
  const lower = text.toLowerCase();

  for (const line of text.split('\n')) {
    const l = line.toLowerCase();
    const fetch = l.match(/search your library for an? basic ([a-z ,]{1,60}?) card/);
    if (fetch) {
      land.fetch = {
        types: typeBits(fetch[1]) || ANY_COLOR,
        untapAt: /four or more lands, untap/.test(l) ? 4 : 0,
      };
      continue;
    }
    const addAt = l.search(/\badd\b/);
    if (addAt < 0) continue;
    const addPart = line.slice(addAt);
    let lineMask = 0;
    if (/any color|any one color|any type/.test(l)) lineMask |= ANY_COLOR;
    for (const s of addPart.matchAll(/\{([WUBRGC])\}/g)) lineMask |= COLOR_BITS[s[1]];
    const cond = l.match(/activate only if you control an? (\w+)(?: or an? (\w+))?/);
    if (cond && typeBits(cond[0])) land.cond.push({ mask: lineMask, types: typeBits(cond[0]) });
    else land.mask |= lineMask;
    if (/spend this mana only/.test(l)) land.notes.push('Restricted mana counted as normal mana');
  }

  const chooseOther = lower.match(/choose a color other than (\w+)/);
  if (chooseOther) {
    const banned = COLOR_WORD[chooseOther[1]];
    land.choices = Object.keys(BASIC_BY_COLOR).filter((c) => c !== banned).map((c) => COLOR_BITS[c]);
  }

  if (!land.mask && !land.cond.length && !land.choices && !land.fetch && producedFallback) {
    land.mask = colorsToMask(producedFallback);
  }

  if (/enters( the battlefield)? tapped/.test(lower)) {
    let m;
    if ((m = lower.match(/you may pay (\d+) life/))) { land.etb = 'shock'; land.shockLife = Number(m[1]); }
    else if (/unless you control two or fewer other lands/.test(lower)) land.etb = 'fast';
    else if (/unless you control two or more other lands/.test(lower)) land.etb = 'slow';
    else if (/unless you control a basic land/.test(lower)) land.etb = 'basic';
    else if (/unless you have two or more opponents/.test(lower)) land.etb = 'multiplayer';
    else if ((m = lower.match(/you may reveal an? (\w+)(?: or an? (\w+))? card from your hand/)) && typeBits(m[0])) {
      land.etb = 'reveal'; land.etbTypes = typeBits(m[0]);
    } else if ((m = lower.match(/unless you control an? (\w+)(?: or an? (\w+))?/)) && typeBits(m[0])) {
      land.etb = 'check'; land.etbTypes = typeBits(m[0]);
    } else if (/unless/.test(lower)) {
      land.etb = 'unknown';
      land.notes.push('Unrecognised enters-tapped condition, treated as always tapped');
    } else land.etb = 'tapped';
  }
  if (/deals 1 damage to you/.test(lower)) land.pain = 1;
  const surveil = lower.match(/when [^.]*enters[^.]*, surveil (\d+)/);
  if (surveil) land.surveil = Number(surveil[1]);
  return land;
}

// Reads card draw and library selection from rules text. Only spells' own text and
// "when this enters" triggers on permanents count; activated and "whenever" abilities don't.
export function parseDrawEffect(oracleText, typeLine) {
  if (!oracleText) return null;
  const isSpell = /\b(Instant|Sorcery)\b/.test(typeLine || '');
  const eff = { draw: 0, scry: 0, surveil: 0, look: 0, take: 0, takeFilter: null, discard: 0, selectFirst: false };
  for (const raw of stripReminder(oracleText).split('\n')) {
    const l = raw.toLowerCase().trim();
    if (!l) continue;
    const colon = l.indexOf(':');
    if (colon > 0 && /\{|\bpay\b|sacrifice|exile|discard/.test(l.slice(0, colon)) && !/^(choose|kicker|flashback|escape|cycling|channel)\b/.test(l)) continue;
    if (/^(whenever|at the beginning|at end)/.test(l)) continue;
    if (!isSpell && !/^when [^,]*\benters\b/.test(l)) continue;

    const draw = l.match(/\b(?:you |target player )?draws? (a|an|one|two|three|four|five|x|\d+) cards?\b/);
    const scry = l.match(/\bscry (\d+)/);
    const surveil = l.match(/\bsurveil (\d+)/);
    if (draw && !/each (opponent|player) draws/.test(l)) eff.draw += num(draw[1]);
    if (scry) eff.scry += Number(scry[1]);
    if (surveil) eff.surveil += Number(surveil[1]);
    const sel = Math.min(scry ? scry.index : Infinity, surveil ? surveil.index : Infinity);
    if (draw && sel < draw.index) eff.selectFirst = true;
    if (!draw && (scry || surveil)) eff.selectFirst = true;

    const look = l.match(/look at the top (\w+) cards of your library/);
    if (look) {
      eff.look = num(look[1]);
      const rest = l.slice(look.index);
      const ofThem = rest.match(/put (?:up to )?(one|two|three|a|an) of (?:them|those cards) into your hand/);
      const take = ofThem ? null : rest.match(/(?:put|reveal) (up to (?:one|two)|one|two|a|an|any number of) ([a-z ]*?)cards?(?: from among them)?(?: and put (?:it|them))? into your hand/)
        || rest.match(/(?:put|reveal) (up to (?:one|two)|one|two|a|an) ([a-z ]*?)cards? from among (?:them|those cards)/);
      eff.take = ofThem ? num(ofThem[1]) : take ? Math.max(1, num(take[1].replace('up to ', ''))) : 1;
      const kinds = take ? take[2] : '';
      const filter = [];
      if (/\bland\b/.test(kinds)) filter.push('land');
      if (/creature/.test(kinds)) filter.push('creature');
      if (/instant|sorcery|noncreature|artifact|enchantment|planeswalker/.test(kinds)) filter.push('noncreature');
      eff.takeFilter = filter.length ? filter : null;
    }
    const discard = l.match(/\bthen discard (a|an|one|two|three|\d+) cards?/);
    if (discard) eff.discard += num(discard[1]);
  }
  if (!eff.draw && !eff.scry && !eff.surveil && !eff.look) return null;
  return eff;
}

function parseSpell(face, card) {
  const typeLine = face.type_line || card.type_line || '';
  return {
    cost: parseCost(face.mana_cost ?? card.mana_cost ?? ''),
    cmc: face.cmc ?? card.cmc ?? 0,
    isCreature: /\bCreature\b/.test(typeLine),
    effect: parseDrawEffect(face.oracle_text, typeLine),
    typeLine,
  };
}

export function describeEffect(eff) {
  if (!eff) return '';
  const parts = [];
  if (eff.scry && eff.selectFirst) parts.push(`scry ${eff.scry}`);
  if (eff.surveil && eff.selectFirst) parts.push(`surveil ${eff.surveil}`);
  if (eff.look) parts.push(`look at ${eff.look}, take ${eff.take}${eff.takeFilter ? ' ' + eff.takeFilter.join('/') : ''}`);
  if (eff.draw) parts.push(`draw ${eff.draw}`);
  if (eff.discard) parts.push(`discard ${eff.discard}`);
  if (eff.scry && !eff.selectFirst) parts.push(`scry ${eff.scry}`);
  if (eff.surveil && !eff.selectFirst) parts.push(`surveil ${eff.surveil}`);
  return parts.join(', then ');
}

// Scryfall card JSON -> card model.
export function normalizeCard(sc, count = 1) {
  const faces = sc.card_faces && sc.card_faces.length > 1 ? sc.card_faces : null;
  const doubleFaced = faces && (sc.layout === 'modal_dfc' || sc.layout === 'transform' || !sc.mana_cost && faces[0].mana_cost !== undefined);
  const front = faces ? { ...faces[0], cmc: faces[0].cmc ?? sc.cmc } : sc;
  const back = doubleFaced ? faces[1] : null;
  const frontIsLand = /\bLand\b/.test(front.type_line || sc.type_line || '');
  const def = {
    name: sc.name,
    frontName: faces ? faces[0].name : sc.name,
    count,
    land: null,
    spell: null,
    mdfcLand: null,
    colorIdentity: sc.color_identity || [],
    legalities: sc.legalities || {},
    producesManaNonLand: false,
    notes: [],
  };
  if (frontIsLand) {
    def.land = parseLand(front, sc.produced_mana);
    if (back && sc.layout === 'modal_dfc' && /\bLand\b/.test(back.type_line || '')) {
      const other = parseLand(back);
      def.land.choices = [def.land.mask, other.mask];
      def.land.mask = 0;
    }
    def.notes.push(...def.land.notes);
  } else {
    def.spell = parseSpell(front, sc);
    if (back && sc.layout === 'modal_dfc' && /\bLand\b/.test(back.type_line || '')) {
      def.mdfcLand = parseLand(back);
    }
    const text = (front.oracle_text || '').toLowerCase();
    if (/\{t\}[^:]*: add\b/.test(text)) {
      def.producesManaNonLand = true;
      def.notes.push('Mana creature/artifact: its mana is not used by the simulator yet');
    }
  }
  return def;
}

export function basicLandDef(color, count = 0) {
  const name = BASIC_BY_COLOR[color];
  return {
    name, frontName: name, count,
    land: { mask: COLOR_BITS[color], cond: [], choices: null, etb: 'untapped', etbTypes: 0, types: COLOR_BITS[color], isBasic: true, fetch: null, surveil: 0, pain: 0, shockLife: 0, notes: [] },
    spell: null, mdfcLand: null, colorIdentity: [color], legalities: {}, producesManaNonLand: false, notes: [], basicColor: color,
  };
}

export function isBasicName(name) {
  return Object.values(BASIC_BY_COLOR).includes(name);
}

export function landSummary(land) {
  if (!land) return '';
  const etb = {
    untapped: 'untapped', shock: 'untapped (pay 2 life)', tapped: 'tapped', fast: 'untapped on turns 1-3',
    slow: 'untapped from your third land', basic: 'untapped with a basic', check: 'untapped with the right land type',
    reveal: 'untapped if you reveal the right land type', multiplayer: 'tapped in 1v1', unknown: 'tapped (unknown condition)',
  }[land.etb];
  if (land.fetch) return `fetches a basic${land.fetch.untapAt ? ' (untaps with 4+ lands)' : ', tapped'}`;
  return etb + (land.surveil ? `, surveil ${land.surveil}` : '');
}
