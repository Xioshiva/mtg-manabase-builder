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

const PERM_TYPES = ['equipment', 'artifact', 'creature', 'enchantment', 'planeswalker', 'vehicle', 'legendary creature', 'legendary'];

// Reads "{T}: Add ..." abilities. Free, unconditional mana goes in `mask`; mana that needs
// a land type or a basic in play goes in `cond`; mana that costs life or can only be
// spent on some spells goes in `restricted` as { mask, kind, life } where kind is
// 'creature', 'spell' (instants and sorceries) or null.
export function parseManaAbilities(text) {
  const out = { mask: 0, cond: [], restricted: [], notes: [], unusable: false };
  for (const line of stripReminder(text).split('\n')) {
    const l = line.toLowerCase().trim();
    const m = l.match(/^\{t\}((?:, [^:]+)?): add (.+)$/);
    if (!m) continue;
    const cost = m[1];
    if (/tap an untapped|sacrifice|discard|exile|\{\d|\{[wubrgc]\}/.test(cost)) {
      out.unusable = true; // needs another resource; not counted as a mana source
      continue;
    }
    const life = (cost.match(/pay (\d+) life/) || [])[1];
    const addPart = line.slice(line.toLowerCase().indexOf(': add') + 5);
    let mask = 0;
    if (/any color|any one color|any type/.test(l)) mask |= ANY_COLOR;
    for (const sym of addPart.split('.')[0].matchAll(/\{([WUBRGC])\}/g)) mask |= COLOR_BITS[sym[1]];
    if (/one mana of the chosen color/.test(l)) out.chosenColor = true;
    let kind = null;
    const spend = l.match(/spend this mana only to cast (?:an? )?([a-z ]+?) spells?/);
    if (spend) {
      if (/instant|sorcery/.test(spend[1])) kind = 'spell';
      else if (/creature/.test(spend[1])) kind = 'creature';
      else { kind = 'unknown'; out.notes.push(`Mana only for ${spend[1]} spells is ignored`); }
      if (/chosen type/.test(l)) out.notes.push('Treats "creature of the chosen type" mana as usable for any creature');
    }
    const lifeCost = Number(life || 0) + (/deals 1 damage to you/.test(l) ? 1 : 0);
    const condTypes = l.match(/activate only if you control an? (\w+)(?: or an? (\w+))?/);
    if (/activate only if this land entered this turn or if you control a basic land/.test(l)) {
      out.cond.push({ mask, types: 0, basicOrFresh: true });
    } else if (condTypes && typeBits(condTypes[0])) {
      out.cond.push({ mask, types: typeBits(condTypes[0]) });
    } else if (kind || lifeCost) {
      out.restricted.push({ mask, kind, life: lifeCost });
    } else if (/activate only/.test(l)) {
      out.notes.push(`Unrecognised condition on "${line.trim()}", treated as always available`);
      out.mask |= mask;
    } else out.mask |= mask;
    if (/add \{[wubrgc]\}\{[wubrgc]\}/.test(l)) out.notes.push('Abilities that add two mana count as one source');
  }
  return out;
}

// Lines of land text the simulator models: mana abilities, entering tapped, fetching,
// surveil on entering, and the choices some lands make as they enter.
function isManaLine(l) {
  return /^\{t\}(, pay \d+ life)?: add\b/.test(l)
    || /^\{t\}, (?:pay \d+ life, )?sacrifice [^:]+: search your library for an? basic/.test(l)
    || /enters( the battlefield)? tapped/.test(l)
    || /^as [^,]+ enters, (?:choose a (?:color|basic land type|creature type)|you may behold)/.test(l)
    || /^this land is the chosen type\.?$/.test(l)
    || /^when [^,]+ enters, surveil \d+\.?$/.test(l);
}

export function parseLand(face, producedFallback) {
  const typeLine = face.type_line || '';
  const types = subtypes(typeLine);
  const land = {
    mask: types, // basic land types tap for their color
    cond: [], // [{ mask, types }] mana that needs a land type (verges) or a basic in play
    restricted: [], // [{ mask, kind, life }] mana that costs life or only casts some spells
    choices: null, // [mask...] picked when played (pathways, thriving lands, Multiversal Passage)
    choiceSetsType: false, // the chosen color is also the land's basic land type
    etb: 'untapped',
    etbTypes: 0,
    etbPerm: null, // permanent type that makes it enter untapped ("unless you control an Equipment")
    types,
    isBasic: /\bBasic\b/.test(typeLine),
    fetch: null,
    surveil: 0,
    shockLife: 0, // life paid to have it enter untapped
    utility: false, // does something besides making mana (creature land, card draw, ...)
    notes: [],
  };
  const text = stripReminder(face.oracle_text);
  const lower = text.toLowerCase();

  for (const line of text.split('\n')) {
    const l = line.toLowerCase().trim();
    // Only a land whose own ability is just "{T}, (pay life,) sacrifice: search for a basic" is a fetch.
    const fetch = l.match(/^\{t\}, (?:pay (\d+) life, )?sacrifice [^:]+: search your library for an? basic ([a-z ,]{1,60}?) card/);
    if (fetch) {
      const behold = l.match(/you may behold an? (\w+)\. if you do, untap/);
      land.fetch = {
        types: typeBits(fetch[2]) || ANY_COLOR,
        untapAt: /four or more lands, untap/.test(l) ? 4 : 0,
        life: Number(fetch[1] || 0),
        untapIfBehold: behold ? behold[1] : null,
      };
    }
  }
  const mana = parseManaAbilities(text);
  land.mask |= mana.mask;
  land.cond = mana.cond;
  land.restricted = mana.restricted;
  land.notes.push(...mana.notes);

  const chooseOther = lower.match(/choose a color other than (\w+)/);
  if (chooseOther) {
    const banned = COLOR_WORD[chooseOther[1]];
    land.choices = Object.keys(BASIC_BY_COLOR).filter((c) => c !== banned).map((c) => COLOR_BITS[c]);
  }
  if (/choose a basic land type/.test(lower) && /is the chosen type/.test(lower)) {
    land.choices = Object.keys(BASIC_BY_COLOR).map((c) => COLOR_BITS[c]);
    land.choiceSetsType = true;
  }

  const hasMana = land.mask || land.cond.length || land.restricted.length || land.choices || land.fetch;
  if (!hasMana && producedFallback) land.mask = colorsToMask(producedFallback);

  if (/enters( the battlefield)? tapped/.test(lower)) {
    let m;
    if ((m = lower.match(/you may pay (\d+) life/))) { land.etb = 'shock'; land.shockLife = Number(m[1]); }
    else if ((m = lower.match(/you may behold an? ([a-z]+)\. if you don't, (?:this land|it) enters tapped/))) { land.etb = 'behold'; land.etbPerm = m[1]; }
    else if (/unless you control two or fewer other lands/.test(lower)) land.etb = 'fast';
    else if (/unless you control two or more other lands/.test(lower)) land.etb = 'slow';
    else if (/unless you control a basic land/.test(lower)) land.etb = 'basic';
    else if (/unless you have two or more opponents/.test(lower)) land.etb = 'multiplayer';
    else if (/unless it's your first, second, or third turn/.test(lower)) land.etb = 'earlyTurns';
    else if (/unless a player has (\d+) or less life/.test(lower)) {
      land.etb = 'lowLife';
      land.notes.push('"Unless a player has 13 or less life" is treated as tapped on turns 1-4, untapped after');
    } else if ((m = lower.match(/you may reveal an? (\w+)(?: or an? (\w+))? card from your hand/)) && typeBits(m[0])) {
      land.etb = 'reveal'; land.etbTypes = typeBits(m[0]);
    } else if ((m = lower.match(/unless you control an? (\w+)(?: or an? (\w+))?/)) && typeBits(m[0])) {
      land.etb = 'check'; land.etbTypes = typeBits(m[0]);
    } else if ((m = lower.match(/unless you control an? (legendary creature|[a-z]+)\b/)) && PERM_TYPES.includes(m[1])) {
      land.etb = 'controlPerm'; land.etbPerm = m[1];
    } else if (/unless/.test(lower)) {
      land.etb = 'unknown';
      land.notes.push('Unrecognised enters-tapped condition, treated as always tapped');
    } else land.etb = 'tapped';
  }
  const surveil = lower.match(/when [^.]*enters[^.]*, surveil (\d+)/);
  if (surveil) land.surveil = Number(surveil[1]);
  land.utility = lower.split('\n').some((l) => l.trim() && !isManaLine(l.trim()));
  return land;
}

// "a Dwarf or Equipment card" -> ['type:dwarf', 'type:equipment']. Card types map to
// 'land', 'creature', 'noncreature' and 'permanent'; any other word must be on the type line.
const SKIP_WORDS = new Set(['a', 'an', 'or', 'and', 'up', 'to', 'one', 'two', 'any', 'number', 'of', 'basic', 'card', 'cards']);
function takeFilter(kinds) {
  const filter = [];
  const add = (f) => { if (!filter.includes(f)) filter.push(f); };
  if (/nonland permanent/.test(kinds)) { for (const f of ['creature', 'type:artifact', 'type:enchantment', 'type:planeswalker', 'type:battle']) add(f); kinds = kinds.replace(/nonland permanent/, ''); }
  for (const w of kinds.split(/[\s,/]+/)) {
    if (!w || SKIP_WORDS.has(w)) continue;
    if (/^lands?$/.test(w)) add('land');
    else if (/^creatures?$/.test(w)) add('creature');
    else if (/^permanents?$/.test(w)) add('permanent');
    else if (w === 'noncreature') add('noncreature');
    else add(`type:${w}`);
  }
  return filter.length ? filter : null;
}

const SELECTION = /\bdraws?\b|\bscry\b|\bsurveil\b|look at the top|into your hand/;

// Drops sentences whose draw depends on something a goldfish game doesn't have:
// the opponent's board, a sacrifice, or which colors paid for the spell.
function dropConditional(line, notes) {
  const sentences = line.split(/(?<=\.)\s+/);
  return sentences.filter((sen, k) => {
    if (!SELECTION.test(sen)) return true;
    let why = null;
    if (/\bif (an|each) opponent|\bif a player\b/.test(sen)) why = 'only if an opponent meets a condition';
    else if (/^if you do\b/.test(sen) && k > 0 && /you may sacrifice/.test(sentences[k - 1])) why = 'only if you sacrifice something';
    else if (/\bif (\{[^}]+\})+ was spent/.test(sen)) why = `only if ${sen.match(/(\{[^}]+\})+(?= was spent)/)[0].toUpperCase()} was spent to cast it`;
    if (!why) return true;
    notes.push(`Draws ${why}, so the simulator doesn't count it`);
    return false;
  }).join(' ');
}

// Reads card draw and library selection from rules text. Only spells' own text and
// "when this enters" triggers on permanents count; activated and "whenever" abilities don't.
// Modes ("• ...") count when the line that introduces them does.
export function parseDrawEffect(oracleText, typeLine, notes = []) {
  if (!oracleText) return null;
  const isSpell = /\b(Instant|Sorcery)\b/.test(typeLine || '');
  const eff = {
    draw: 0, scry: 0, surveil: 0, look: 0, lookPerLand: false, take: 0, takeFilter: null,
    discard: 0, discardFirst: false, discardOrCreature: false, delayedDiscard: 0, selectFirst: false,
    rummage: 0, // "discard up to N cards, then draw that many"
    impulse: 0, // "mill/exile the top N cards; you may play them this turn"
  };
  let modesCount = false;
  for (const raw of stripReminder(oracleText).split('\n')) {
    let l = raw.toLowerCase().trim();
    if (!l) continue;
    if (/^[•●]/.test(l)) {
      if (!modesCount) continue;
    } else {
      const colon = l.indexOf(':');
      modesCount = !(colon > 0 && /\{|\bpay\b|sacrifice|exile|discard/.test(l.slice(0, colon)) && !/^(choose|kicker|flashback|escape|cycling|channel)\b/.test(l))
        && !/^(whenever|at the beginning|at end)/.test(l)
        && (isSpell || /^when [^,]*\benters?\b/.test(l));
      if (!modesCount) continue;
    }
    l = dropConditional(l, notes);

    // "draw" is you; third-person "draws" is another player unless it's "target player draws".
    const draw = l.match(/(?:^|[^a-z])(?:you )?draw (a|an|one|two|three|four|five|x|\d+) cards?\b/)
      || l.match(/\btarget player draws (a|an|one|two|three|four|five|x|\d+) cards?\b/);
    const scry = l.match(/\bscry (\d+)/);
    const surveil = l.match(/\bsurveil (\d+)/);
    if (draw) eff.draw += num(draw[1]);
    if (draw && draw[1] === 'x') notes.push("Draws X cards, where X depends on the game, so the simulator doesn't count it");
    if (scry) eff.scry += Number(scry[1]);
    if (surveil) eff.surveil += Number(surveil[1]);
    const sel = Math.min(scry ? scry.index : Infinity, surveil ? surveil.index : Infinity);
    if (draw && sel < draw.index) eff.selectFirst = true;
    if (!draw && (scry || surveil)) eff.selectFirst = true;

    const look = l.match(/look at the top (\w+) cards of your library/);
    if (look) {
      eff.look = num(look[1]);
      eff.lookPerLand = look[1] === 'x' && /where x is the number of lands you control/.test(l);
      const rest = l.slice(look.index);
      const ofThem = rest.match(/put (?:up to )?(one|two|three|a|an) of (?:them|those cards) into your hand/);
      const take = ofThem ? null : rest.match(/(?:put|reveal) (up to (?:one|two)|one|two|a|an|any number of) ([a-z ]*?)cards?(?: from among them)?(?: and put (?:it|them))? into your hand/)
        || rest.match(/(?:put|reveal) (up to (?:one|two)|one|two|a|an) ([a-z ]*?)cards? from among (?:them|those cards)/);
      eff.take = ofThem ? num(ofThem[1]) : take ? Math.max(1, num(take[1].replace('up to ', ''))) : 1;
      eff.takeFilter = takeFilter(take ? take[2] : '');
    }
    // "Mill N. You may put a permanent card from among them into your hand" digs like "look at N, take 1".
    const mill = l.match(/\bmill (\w+) cards?\. you may put an? ([a-z ]*?)card from among (?:them|the milled cards) into your hand/);
    if (mill && !look) {
      eff.look = num(mill[1]);
      eff.take = 1;
      eff.takeFilter = takeFilter(mill[2]);
    }
    const discardFirst = l.match(/\bdiscard (a|an|one|two|three|\d+) cards?, then draw/);
    if (discardFirst) { eff.discard += num(discardFirst[1]); eff.discardFirst = true; }
    const discard = l.match(/\bthen discard (a|an|one|two|three|\d+) cards?/);
    if (discard) eff.discard += num(discard[1]);
    if (discard && /then discard \w+ cards? unless you discard an? creature card/.test(l)) eff.discardOrCreature = true;
    const rummage = l.match(/\bdiscard up to (one|two|three|\d+) cards?, then draw that many cards/);
    if (rummage) eff.rummage += num(rummage[1]);
    const impulse = l.match(/\b(?:mill|exile) the top (card|\w+ cards) of your library\. (?:until end of turn, )?you may play (?:that card|it|those cards|them) this turn/)
      || l.match(/\bmill (a|one|two|three) cards?\. you may play (?:that card|it|those cards|them) this turn/);
    if (impulse) eff.impulse += impulse[1] === 'card' ? 1 : num(impulse[1].replace(' cards', ''));
    const later = l.match(/at the beginning of your next upkeep, discard (a|an|one|two|three|\d+) cards? at random/);
    if (later) eff.delayedDiscard = (eff.delayedDiscard || 0) + num(later[1]);
  }
  if (!eff.draw && !eff.scry && !eff.surveil && !eff.look && !eff.lookPerLand && !eff.rummage && !eff.impulse) return null;
  return eff;
}

const ROMAN = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6 };

// Treasure tokens the card makes without conditions: on entering (or resolving),
// at the beginning of each upkeep, or from Saga chapters (chapter N fires N-1 turns later).
function parseTreasure(text, isSpell) {
  const t = { now: 0, upkeep: 0, later: [] };
  for (const raw of text.split('\n')) {
    const l = raw.trim();
    let m;
    if ((m = l.match(/^when [^,]*\benters?\b[^,]*, create (a|an|one|two|three) treasure tokens?(?! if)/))) t.now += num(m[1]);
    else if ((m = l.match(/^at the beginning of your upkeep, create (a|an|one|two) treasure tokens?(?! if)/))) t.upkeep += num(m[1]);
    else if ((m = l.match(/^((?:i|ii|iii|iv|v|vi)(?:, (?:i|ii|iii|iv|v|vi))*) — create (a|an|one|two) treasure tokens?/))) {
      for (const ch of m[1].split(', ')) {
        for (let k = 0; k < num(m[2]); k++) { if (ROMAN[ch] === 1) t.now++; else t.later.push(ROMAN[ch] - 1); }
      }
    } else if (isSpell && (m = l.match(/(?:^|\. )create (a|an|one|two|three) treasure tokens?\.?$/))) t.now += num(m[1]);
  }
  return t.now || t.upkeep || t.later.length ? t : null;
}

function parseSpell(face, card) {
  const typeLine = face.type_line || card.type_line || '';
  const text = stripReminder(face.oracle_text || '').toLowerCase();
  const notes = [];
  const spell = {
    cost: parseCost(face.mana_cost ?? card.mana_cost ?? ''),
    cmc: face.cmc ?? card.cmc ?? 0,
    isCreature: /\bCreature\b/.test(typeLine),
    kind: /\bCreature\b/.test(typeLine) ? 'creature' : /\b(Instant|Sorcery)\b/.test(typeLine) ? 'spell' : 'other',
    isPermanent: !/\b(Instant|Sorcery)\b/.test(typeLine),
    effect: parseDrawEffect(face.oracle_text, typeLine, notes),
    typeLine,
    costReduction: /this spell costs \{[x\d]+\} less to cast|costs \{[x\d]+\} less to cast for each|^(affinity for|convoke|delve|improvise)\b/m.test(text),
    extraCost: null, // { generic, pips, unlessType: [words], fromHand, sacrifice }
    treasure: parseTreasure(text, /\b(Instant|Sorcery)\b/.test(typeLine)),
    extraLandDrops: /you may play an additional land on each of your turns/.test(text) ? 1 : 0,
    mana: null,
    notes,
  };
  // "Behold a Dragon or pay {2}", "sacrifice an artifact or creature or pay {4}": the
  // extra mana is due unless you have that card in hand (behold) or in play.
  const unless = text.match(/as an additional cost to cast this spell, (behold|sacrifice) an? ([a-z]+(?: or [a-z]+)?) or pay \{(\d+)\}/);
  if (unless) {
    spell.extraCost = { generic: Number(unless[3]), pips: [], unlessType: unless[2].split(' or '), fromHand: unless[1] === 'behold', sacrifice: unless[1] === 'sacrifice' };
  }
  // Spree: at least one "+ {cost} —" mode must be paid. Use the draw mode when there is
  // one (that's what the simulator casts it for), otherwise the cheapest mode.
  if (/^spree$/m.test(text)) {
    const modes = [...text.matchAll(/^\+ ((?:\{[^}]+\})+) — (.*)$/gm)].map((m) => ({ cost: parseCost(m[1].toUpperCase()), digs: SELECTION.test(m[2]) }));
    const size = (c) => c.generic + c.pips.length * 1.01 + c.twobrid.length * 2;
    const mode = (spell.effect && modes.find((m) => m.digs)) || modes.sort((a, b) => size(a.cost) - size(b.cost))[0];
    if (mode) spell.extraCost = { generic: mode.cost.generic, pips: mode.cost.pips, unlessType: null, fromHand: false, sacrifice: false };
  }
  if (spell.extraLandDrops && /you may play lands from your graveyard/.test(text)) notes.push('The extra land drop is modelled; playing lands from the graveyard is not');
  // The turn we check "on curve": its mana value, plus any extra mana it asks for.
  spell.curveTurn = spell.cmc + (spell.extraCost ? spell.extraCost.generic + spell.extraCost.pips.length : 0);
  if (spell.isPermanent) {
    const mana = parseManaAbilities(face.oracle_text || '');
    if (mana.mask || mana.cond.length || mana.restricted.length) {
      spell.mana = { ...mana, sick: spell.isCreature && !/\bhaste\b/.test(text) };
    }
  }
  return spell;
}

export function describeEffect(eff) {
  if (!eff) return '';
  const parts = [];
  if (eff.scry && eff.selectFirst) parts.push(`scry ${eff.scry}`);
  if (eff.surveil && eff.selectFirst) parts.push(`surveil ${eff.surveil}`);
  if (eff.look || eff.lookPerLand) parts.push(`look at ${eff.lookPerLand ? 'one card per land' : eff.look}, take ${eff.take}${eff.takeFilter ? ' ' + eff.takeFilter.map((f) => f.replace('type:', '')).join('/') : ''}`);
  if (eff.rummage) parts.push(`discard up to ${eff.rummage}, draw that many`);
  if (eff.impulse) parts.push(`play the top ${eff.impulse === 1 ? 'card' : eff.impulse + ' cards'} this turn`);
  if (eff.draw) parts.push(`draw ${eff.draw}`);
  if (eff.discard && eff.discardFirst) parts.unshift(`discard ${eff.discard}`);
  else if (eff.discard) parts.push(`discard ${eff.discard}${eff.discardOrCreature ? ' (or one creature)' : ''}`);
  if (eff.delayedDiscard) parts.push(`discard ${eff.delayedDiscard} at random next turn`);
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
    def.notes.push(...def.spell.notes);
    if (def.spell.mana) {
      def.producesManaNonLand = true;
      def.notes.push(...def.spell.mana.notes);
    } else if (/\{t\}[^:]*: add\b/i.test(stripReminder(front.oracle_text || ''))) {
      def.notes.push('Its mana ability needs another resource, so the simulator does not use it as a mana source');
    }
    if (def.spell.costReduction) def.notes.push('Cost reduction is not modelled, so it is left out of the on-curve average');
  }
  return def;
}

export function basicLandDef(color, count = 0) {
  const name = BASIC_BY_COLOR[color];
  return {
    name, frontName: name, count,
    land: { mask: COLOR_BITS[color], cond: [], restricted: [], choices: null, choiceSetsType: false, etb: 'untapped', etbTypes: 0, etbPerm: null, types: COLOR_BITS[color], isBasic: true, fetch: null, surveil: 0, shockLife: 0, notes: [] },
    spell: null, mdfcLand: null, colorIdentity: [color], legalities: {}, producesManaNonLand: false, notes: [], basicColor: color,
  };
}

export function isBasicName(name) {
  return Object.values(BASIC_BY_COLOR).includes(name);
}

// Every color a land can make for at least some spells (choices and fetches included).
// Mana that only casts creatures or only instants/sorceries is left out unless asked for.
export function landColors(L, { restricted = false } = {}) {
  let m = L.mask;
  for (const c of L.cond) m |= c.mask;
  for (const r of L.restricted) if (restricted || r.kind === null) m |= r.mask;
  for (const ch of L.choices || []) m |= ch;
  if (L.fetch) m |= L.fetch.types;
  return m;
}

export function landSummary(land) {
  if (!land) return '';
  const etb = {
    untapped: 'untapped', shock: 'untapped (pay 2 life)', tapped: 'tapped', fast: 'untapped as one of your first three lands',
    slow: 'untapped from your third land', basic: 'untapped with a basic', check: 'untapped with the right land type',
    reveal: 'untapped if you reveal the right land type', multiplayer: 'tapped in 1v1', unknown: 'tapped (unknown condition)',
    earlyTurns: 'untapped on turns 1-3', lowLife: 'tapped until turn 5', controlPerm: `untapped with ${land.etbPerm ? 'an ' + land.etbPerm : 'the right permanent'}`,
    behold: `untapped if you have ${land.etbPerm && /^[aeiou]/.test(land.etbPerm) ? 'an' : 'a'} ${land.etbPerm ? land.etbPerm[0].toUpperCase() + land.etbPerm.slice(1) : ''} in hand or in play`,
  }[land.etb];
  const extras = [];
  if (land.etb === 'shock' && land.shockLife !== 2) extras.push(`pay ${land.shockLife} life`);
  if (land.restricted.some((r) => r.life)) extras.push('colored mana costs life');
  if (land.restricted.some((r) => r.kind === 'creature')) extras.push('colors only for creatures');
  if (land.restricted.some((r) => r.kind === 'spell')) extras.push('colors only for instants/sorceries');
  if (land.cond.length) extras.push('second color needs the right land in play');
  if (land.fetch) {
    const f = land.fetch;
    const untap = f.untapAt ? ' (untaps with 4+ lands)' : f.untapIfBehold ? ` (untaps if you behold ${/^[aeiou]/.test(f.untapIfBehold) ? 'an' : 'a'} ${f.untapIfBehold[0].toUpperCase() + f.untapIfBehold.slice(1)})` : ', tapped';
    return `fetches a basic${untap}${f.life ? `, pay ${f.life} life` : ''}`;
  }
  if (land.surveil) extras.unshift(`surveil ${land.surveil}`);
  return [etb.replace('(pay 2 life)', land.shockLife === 2 ? '(pay 2 life)' : '(pay life)'), ...extras].join(', ');
}
