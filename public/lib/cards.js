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

const COUNT_WORDS = { two: 2, three: 3, four: 4, five: 5 };
const ROMAN = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6 };

// Reads "{T}: Add ..." abilities. Free, unconditional mana goes in `mask`; mana that needs
// a land type or a basic in play goes in `cond`; mana that costs life or can only be
// spent on some spells goes in `restricted` as { mask, kind, life } where kind is
// 'creature', 'spell' (instants and sorceries) or null.
// Abilities that make more than one mana ("Add {C}{C}", "Add {G}{U}", "Add three mana of
// any one color") put the mana after the first in `extra`, one mask per mana.
export function parseManaAbilities(text) {
  const out = { mask: 0, cond: [], restricted: [], notes: [], unusable: false, extra: [] };
  for (const line of stripReminder(text).split('\n')) {
    // An ability word ("Metalcraft — ") doesn't change the ability.
    const l = line.toLowerCase().trim().replace(/^[a-z' ]+ — (?=\{t\})/, '')
      .replace(/ if [^.]+ has a luck counter on it, instead add [^.]+\./, ''); // Gemstone Caverns: just {C}
    const m = l.match(/^\{t\}((?:, [^:]+)?): add (.+)$/);
    if (!m) continue;
    const cost = m[1];
    if (/tap an untapped|sacrifice|discard|exile|\{\d|\{[wubrgc]\}/.test(cost)) {
      out.unusable = true; // needs another resource; not counted as a mana source
      continue;
    }
    const life = (cost.match(/pay (\d+) life/) || [])[1];
    const addPart = line.slice(line.toLowerCase().indexOf(': add') + 5);
    const first = addPart.split('.')[0];
    let mask = 0;
    if (/any color|any one color|any type|any combination of colors/.test(l)) mask |= ANY_COLOR;
    const syms = [...first.matchAll(/\{([WUBRGC])\}/g)].map((x) => COLOR_BITS[x[1]]);
    // "{W} or {U}" is one mana of either color; "{G}{U}" is two mana.
    const several = /^\s*(\{[WUBRGC]\}){2,}\s*$/i.test(first);
    for (const b of several ? syms.slice(0, 1) : syms) mask |= b;
    let extra = several ? syms.slice(1) : [];
    const many = first.toLowerCase().match(/\b(two|three|four|five) mana (?:of any one color|in any combination of colors|of any color)/);
    if (many) extra = Array(COUNT_WORDS[many[1]] - 1).fill(ANY_COLOR);
    if (many && /any one color/.test(many[0])) out.notes.push(`Counts its ${many[1]} mana as any colors, though they must all be one color`);
    // Urza's lands: only their plain {C} is counted.
    if (/if you control an? [^.]+ and an? [^.]+, add (?:\{c\})+ instead/.test(l)) out.notes.push("Counted as one {C}; the extra mana with the other Urza's lands is not modelled");
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
    const artifacts = l.match(/activate only if you control (two|three|four) or more artifacts/);
    if (/if a card is exiled with this land, add [^.]+ instead/.test(l)) out.notes.push('Its extra mana needs an exiled card and is not counted');
    if (/activate only if a card is exiled with/.test(l)) {
      out.notes.push('Its mana that needs an exiled card is not counted');
      continue;
    }
    if (/activate only if this land entered this turn or if you control a basic land/.test(l)) {
      out.cond.push({ mask, types: 0, basicOrFresh: true });
    } else if (artifacts) {
      out.cond.push({ mask, types: 0, artifacts: COUNT_WORDS[artifacts[1]] });
    } else if (condTypes && typeBits(condTypes[0])) {
      out.cond.push({ mask, types: typeBits(condTypes[0]) });
    } else if (kind || lifeCost) {
      out.restricted.push({ mask, kind, life: lifeCost });
      if (extra.length) out.notes.push('Only the first mana of an ability that costs life or only casts some spells is counted');
    } else {
      if (/activate only/.test(l)) out.notes.push(`Unrecognised condition on "${line.trim()}", treated as always available`);
      out.mask |= mask;
      if (extra.length > out.extra.length) out.extra = extra;
    }
  }
  return out;
}

// Lines of land text the simulator models: mana abilities, entering tapped, fetching,
// surveil on entering, and the choices some lands make as they enter.
function isManaLine(l) {
  return /^\{t\}(, pay \d+ life)?: add\b/.test(l)
    || FETCH.test(l)
    || /enters( the battlefield)? tapped/.test(l)
    || /^as [^,]+ enters, (?:choose a (?:color|basic land type|creature type)|you may behold)/.test(l)
    || /^this land is the chosen type\.?$/.test(l)
    || /^when [^,]+ enters, (?:surveil|scry) \d+\.?$/.test(l)
    || /^when [^,]+ enters, return a land you control to its owner's hand\./.test(l)
    || /^when [^,]+ enters, (?:sacrifice (?:a|an|one|two|three) (?:untapped )?lands?|add one mana of any color)\.?$/.test(l)
    || GRANTS.test(l)
    || /^(hexproof|indestructible)\.?$/.test(l);
}

// "Each land is a Swamp in addition to its other land types" (Urborg), "Lands you control are
// every basic land type in addition to their other types" (Leyline of the Guildpact).
const GRANTS = /^(?:each land is an? (\w+)|lands you control are every basic land type) in addition to (?:its|their) other (?:land )?types\.?$/;
function grantedTypes(text) {
  for (const line of text.toLowerCase().split('\n')) {
    const m = line.trim().match(GRANTS);
    if (m) return m[1] ? typeBits(m[1]) : ANY_COLOR;
  }
  return 0;
}

// "{T}, (Pay 1 life,) Sacrifice this land: Search your library for a basic land card /
// a Plains or Island card, put it onto the battlefield (tapped)".
const FETCH = /^\{t\}, (?:pay (\d+) life, )?sacrifice [^:]+: search your library for an? (basic )?([a-z ,]{1,60}?) card, put it onto the battlefield( tapped)?/;

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
    legendary: /\bLegendary\b/.test(typeLine),
    isArtifact: /\bArtifact\b/.test(typeLine), // counts for metalcraft (Darksteel Citadel)
    fetch: null,
    extra: [], // more mana from one tap (see parseManaAbilities)
    surveil: 0,
    scry: 0,
    bounce: false, // returns a land to hand as it enters (Simic Growth Chamber)
    sacrifice: 0, // lands sacrificed as it enters (Lotus Field)
    sacrificeUntapped: false, // only untapped ones (older Lotus Field wording)
    etbMana: 0, // one mana, this turn only, as it enters (Crumbling Vestige)
    grantTypes: 0, // land types it gives every land (Urborg, Yavimaya)
    leavesAfter: 0, // turns until it is gone (Urza's Saga is sacrificed after chapter III)
    shockLife: 0, // life paid to have it enter untapped
    utility: false, // does something besides making mana (creature land, card draw, ...)
    notes: [],
  };
  const text = stripReminder(face.oracle_text);
  const lower = text.toLowerCase();

  for (const line of text.split('\n')) {
    const l = line.toLowerCase().trim();
    // Only a land whose own ability is just "{T}, (pay life,) sacrifice: search for a land" is a fetch.
    const fetch = l.match(FETCH);
    // "a basic land card" finds any basic; "a Plains or Island card" any land with those types.
    const fetchTypes = fetch && (typeBits(fetch[3]) || (fetch[2] && /^land$/.test(fetch[3]) ? ANY_COLOR : 0));
    if (fetchTypes) {
      const behold = l.match(/you may behold an? (\w+)\. if you do, untap/);
      land.fetch = {
        types: fetchTypes,
        basicOnly: !!fetch[2],
        tapped: !!fetch[4],
        untapAt: /four or more lands, untap/.test(l) ? 4 : 0,
        life: Number(fetch[1] || 0),
        untapIfBehold: behold ? behold[1] : null,
      };
    }
  }
  let mana = parseManaAbilities(text);
  // Basics like Wastes only have their mana ability as reminder text.
  if (!mana.mask && !mana.cond.length && !mana.restricted.length && !types && !land.fetch) {
    const reminder = parseManaAbilities((face.oracle_text || '').replace(/[()]/g, ''));
    if (reminder.mask) mana = reminder;
  }
  // Urza's Saga: chapter I gives it "{T}: Add {C}", and it is sacrificed after its last chapter.
  const sagaMana = text.match(/^I — [^\n]*gains "(\{T\}: Add [^"]+)"/m);
  if (sagaMana && /\bSaga\b/.test(typeLine)) {
    mana = parseManaAbilities(sagaMana[1]);
    const chapters = (text.match(/^(I|II|III|IV|V|VI)(?:, (?:I|II|III|IV|V|VI))* —/gm) || []).map((c) => ROMAN[c.split(' ')[0].replace(',', '').toLowerCase()] || 0);
    land.leavesAfter = Math.max(...chapters, 1) - 1;
    land.notes.push(`Counted as a land that makes {C} until it is sacrificed after chapter ${['', 'I', 'II', 'III', 'IV', 'V', 'VI'][land.leavesAfter + 1]}; its other chapters are not modelled`);
  }
  land.mask |= mana.mask;
  land.cond = mana.cond;
  land.restricted = mana.restricted;
  land.extra = mana.extra;
  land.notes.push(...mana.notes);

  const chooseOther = lower.match(/choose a color other than (\w+)/);
  if (chooseOther) {
    const banned = COLOR_WORD[chooseOther[1]];
    land.choices = Object.keys(BASIC_BY_COLOR).filter((c) => c !== banned).map((c) => COLOR_BITS[c]);
  }
  if (!chooseOther && mana.chosenColor && /as [^.]*enters, choose a color\./.test(lower)) {
    land.choices = Object.keys(BASIC_BY_COLOR).map((c) => COLOR_BITS[c]);
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
    // Den of the Bugbear: "If you control two or more other lands, this land enters tapped."
    else if (/if you control two or more other lands, [^.]*enters tapped/.test(lower)) land.etb = 'fastTwo';
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
  const scry = lower.match(/when [^.]*enters[^.]*, scry (\d+)/);
  if (scry) land.scry = Number(scry[1]);
  if (/when [^.]*enters[^.]*, return a land you control to its owner's hand/.test(lower)) land.bounce = true;
  const sac = lower.match(/when [^.]*enters[^.]*, sacrifice (a|an|one|two|three) (untapped )?lands?/);
  if (sac) { land.sacrifice = num(sac[1]); land.sacrificeUntapped = !!sac[2]; }
  if (/when [^.]*enters[^.]*, add one mana of any color/.test(lower)) land.etbMana = ANY_COLOR;
  land.grantTypes = grantedTypes(text);
  // Urborg is a Swamp itself, so it taps for {B} though its text has no mana ability.
  // Its own types only change on the battlefield (the grant), so a fetch can't find it as a Swamp.
  if (land.grantTypes) land.mask |= land.grantTypes;
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
    else if (w === 'colorless') add('colorless');
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
    impulse: 0, // "mill/exile the top N cards; you may play them this turn" (impulseNext: until the end of next turn)
  };
  let modesCount = false;
  for (const raw of stripReminder(oracleText).split('\n')) {
    let l = raw.toLowerCase().trim();
    if (!l) continue;
    if (/^[•●]/.test(l)) {
      if (!modesCount) continue;
    } else {
      const bare = l.replace(/"[^"]*"/g, '""'); // a token's quoted ability isn't this card's cost
      const colon = bare.indexOf(':');
      modesCount = !(colon > 0 && /\{|\bpay\b|sacrifice|exile|discard/.test(bare.slice(0, colon)) && !/^(choose|kicker|flashback|escape|cycling|channel)\b/.test(l))
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

    const look = l.match(/look at the top (\w+) cards of your library/)
      || (/from among them into your hand/.test(l) ? l.match(/reveal the top (\w+) cards of your library/) : null);
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
    const impulse = l.match(/\b(?:mill|exile) the top (card|\w+ cards) of your library\. (?:until end of turn, you may play (?:that card|it|those cards|them)|until the end of your next turn, you may play (?:that card|it|those cards|them)|you may play (?:that card|it|those cards|them) this turn)/)
      || l.match(/\bmill (a|one|two|three) cards?\. you may play (?:that card|it|those cards|them) this turn/);
    if (impulse) eff.impulse += impulse[1] === 'card' ? 1 : num(impulse[1].replace(' cards', ''));
    if (impulse && impulse[0].includes('until the end of your next turn')) eff.impulseNext = true;
    const later = l.match(/at the beginning of your next upkeep, discard (a|an|one|two|three|\d+) cards? at random/);
    if (later) eff.delayedDiscard = (eff.delayedDiscard || 0) + num(later[1]);
  }
  if (!eff.draw && !eff.scry && !eff.surveil && !eff.look && !eff.lookPerLand && !eff.rummage && !eff.impulse) return null;
  return eff;
}


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
    } else if (isSpell && (m = l.match(/(?:^|\. |,? and )create (a|an|one|two|three) treasure tokens?\.?$/))) t.now += num(m[1]);
  }
  return t.now || t.upkeep || t.later.length ? t : null;
}

// Lands a spell (or its "when this enters" / "when you cast this spell" trigger) puts into
// play: from your hand (Arboreal Grazer, Spelunking) or from your library (Rampant Growth,
// Cultivate, Primeval Titan, Sowing Mycospawn). Activated abilities don't count.
function parseLandEffects(text, isSpell) {
  let landFromHand = null, ramp = null;
  for (const raw of text.split('\n')) {
    const l = raw.trim();
    const bare = l.replace(/"[^"]*"/g, '""');
    const colon = bare.indexOf(':');
    if (colon > 0 && /\{|\bpay\b|sacrifice|exile|discard/.test(bare.slice(0, colon))) continue;
    if (!(isSpell || /^when(ever)? [^,]*\benters?\b|^when you cast this spell/.test(l))) continue;
    if (/if an opponent controls more lands than you/.test(l)) continue; // never true when goldfishing
    if (/^when[^,]*, if [^,]+ was spent to cast/.test(l)) continue; // Vibrance: depends on the mana paid
    const hand = l.match(/you may put a land card from your hand onto the battlefield( tapped)?/);
    if (hand) landFromHand = { tapped: !!hand[1] };
    // Cavalier of Thorns: a land from the top few cards. Treated as a search, which it nearly always finds.
    const top = l.match(/reveal the top (\w+) cards of your library\. put a land card from among them onto the battlefield( tapped)?/);
    if (top && num(top[1]) >= 5) ramp = { types: ANY_COLOR, basicOnly: false, anyLand: true, count: 1, toHand: 0, tapped: !!top[2] };
    const m = l.match(/search your library for (up to (one|two|three|four) |an? )(basic )?([a-z ]*?)(land )?cards?(?:,| and)([^.]*)/);
    if (!m || (!m[5] && !typeBits(m[4]))) continue;
    const count = m[2] ? num(m[2]) : 1;
    const rest = m[6];
    const types = typeBits(m[4]) || ANY_COLOR;
    const base = { types, basicOnly: !!m[3], anyLand: !m[3] && !typeBits(m[4]) };
    if (/put (?:it|them|that card|those cards) onto the battlefield/.test(rest)) {
      ramp = { ...base, count, toHand: 0, tapped: /onto the battlefield tapped/.test(rest) };
    } else if (/put one (?:of them )?onto the battlefield( tapped)? and the other into your hand/.test(rest)) {
      ramp = { ...base, count: 1, toHand: count - 1, tapped: /onto the battlefield tapped/.test(rest) };
    } else if (/put (?:it|them|that card|those cards) into your hand/.test(rest)) {
      ramp = { ...base, count: 0, toHand: count, tapped: false };
    }
  }
  // Harrow, Roiling Regrowth, Springbloom Druid: a land is sacrificed for it, so it nets one land fewer.
  if (ramp && /(?:^|\. |additional cost to cast this spell, )sacrifice a land\b|you may sacrifice a land\. if you do, search your library/m.test(text)) {
    if (ramp.count > 0) ramp.count--; else if (ramp.toHand > 0) ramp.toHand--;
    if (!ramp.count && !ramp.toHand) ramp = null;
  }
  return { landFromHand, ramp };
}

// "When this enters, create a tapped colorless land token named Everywhere that is every
// basic land type" -> a land model for the token.
function parseLandToken(text) {
  const m = text.match(/^when(?:ever)? [^,]*\benters?\b[^,]*, create an? (tapped )?[a-z ]*?land token[^.]* every basic land type/m);
  if (!m) return null;
  return parseLand({ type_line: 'Land — Plains Island Swamp Mountain Forest', oracle_text: m[1] ? 'This land enters tapped.' : '' });
}

// Mana a permanent adds once as it enters, with no condition.
function parseEtbMana(text) {
  const m = text.match(/^when [^,]*\benters?, add (one mana of any color|(?:\{[wubrgc]\})+)\.?$/m);
  if (!m) return null;
  if (m[1] === 'one mana of any color') return [ANY_COLOR];
  return [...m[1].matchAll(/\{([wubrgc])\}/g)].map((x) => COLOR_BITS[x[1].toUpperCase()]);
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
    legendary: /\bLegendary\b/.test(typeLine) && !/\b(Instant|Sorcery)\b/.test(typeLine),
    // Phyrexian pips ({B/P}) are paid with life, so they are left out of the mana spent.
    phyrexian: ((face.mana_cost ?? card.mana_cost ?? '').split('//')[0].match(/\{[^}]*\/P\}/gi) || []).length,
    // No colored mana symbol in its cost (or devoid): what "a colorless card" digs find.
    colorless: !!(face.mana_cost ?? card.mana_cost) && !/\{[^}]*[WUBRG][^}]*\}/.test(face.mana_cost ?? card.mana_cost) || /^devoid\b/m.test(text),
    effect: parseDrawEffect(face.oracle_text, typeLine, notes),
    typeLine,
    costReduction: /this spell costs \{[x\d]+\} less to cast|costs \{[x\d]+\} less to cast for each|^(affinity for|convoke|delve|improvise)\b/m.test(text),
    extraCost: null, // { generic, pips, unlessType: [words], fromHand, sacrifice }
    treasure: parseTreasure(text, /\b(Instant|Sorcery)\b/.test(typeLine)),
    extraLandDrops: num((text.match(/you may play (an|one|two|three) additional lands? on each of your turns/) || [])[1]),
    leyline: /if [^.]+ is in your opening hand, you may begin the game with it on the battlefield/.test(text),
    grantTypes: grantedTypes(text),
    landToken: parseLandToken(text), // Overlord of the Hauntwoods' Everywhere
    etbMana: parseEtbMana(text), // [mask...] added when it enters (Outcaster Trailblazer)
    // Spelunking: lands come into play untapped.
    untapLands: /lands you control enter untapped/.test(text),
    landFromHand: null, // { tapped } put a land from hand onto the battlefield (Arboreal Grazer)
    ramp: null, // { count, toHand, types, basicOnly, anyLand, tapped } lands from the library
    // Domain: "costs {1} less to cast for each basic land type among lands you control".
    domain: Number((text.match(/costs \{(\d+)\} less to cast for each basic land type among lands you control/) || [])[1] || 0),
    // Cards with no mana cost (Living End, suspend-only cards) can't be cast from hand.
    noCost: !(face.mana_cost ?? card.mana_cost),
    mana: null,
    notes,
  };
  if (spell.noCost) notes.push("Has no mana cost, so the simulator never casts it");
  if (/whenever a permanent you control enters tapped, untap it/.test(text)) notes.push('Its untap of permanents that enter tapped is not modelled');
  const { landFromHand, ramp } = parseLandEffects(text, /\b(Instant|Sorcery)\b/.test(typeLine));
  spell.landFromHand = landFromHand;
  spell.ramp = ramp;
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
  if (eff.impulse) parts.push(`play the top ${eff.impulse === 1 ? 'card' : eff.impulse + ' cards'} ${eff.impulseNext ? 'until the end of next turn' : 'this turn'}`);
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
    if (def.spell.domain) def.notes.push('Domain makes it cheaper for each basic land type you control. The simulator applies that, but leaves it out of the on-curve average because its curve turn depends on your lands');
    else if (def.spell.costReduction) def.notes.push('Cost reduction is not modelled, so it is left out of the on-curve average');
  }
  def.notes = [...new Set(def.notes)];
  return def;
}

export function basicLandDef(color, count = 0) {
  const name = BASIC_BY_COLOR[color];
  return {
    name, frontName: name, count,
    land: {
      mask: COLOR_BITS[color], cond: [], restricted: [], choices: null, choiceSetsType: false, etb: 'untapped', etbTypes: 0, etbPerm: null,
      types: COLOR_BITS[color], isBasic: true, fetch: null, extra: [],
      surveil: 0, scry: 0, bounce: false, sacrifice: 0, shockLife: 0, utility: false, isArtifact: false, notes: [],
    },
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
  for (const e of L.extra || []) m |= e; // Simic Growth Chamber's {U}
  if (L.fetch) m |= L.fetch.types;
  return m;
}

export function landSummary(land) {
  if (!land) return '';
  const etb = {
    untapped: 'untapped', shock: 'untapped (pay 2 life)', tapped: 'tapped', fast: 'untapped as one of your first three lands', fastTwo: 'untapped as one of your first two lands',
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
    const untap = !f.tapped ? '' : f.untapAt ? ' (untaps with 4+ lands)' : f.untapIfBehold ? ` (untaps if you behold ${/^[aeiou]/.test(f.untapIfBehold) ? 'an' : 'a'} ${f.untapIfBehold[0].toUpperCase() + f.untapIfBehold.slice(1)})` : ', tapped';
    const what = f.types === ANY_COLOR ? 'a basic' : `${f.basicOnly ? 'a basic ' : 'a '}${Object.keys(TYPE_BITS).filter((t) => f.types & TYPE_BITS[t]).map((t) => t[0].toUpperCase() + t.slice(1)).join(' or ')}`;
    return `fetches ${what}${untap}${f.life ? `, pay ${f.life} life` : ''}`;
  }
  if (land.surveil) extras.unshift(`surveil ${land.surveil}`);
  if (land.scry) extras.unshift(`scry ${land.scry}`);
  const mana = 1 + (land.extra || []).length;
  if (mana > 1) extras.push(`makes ${mana} mana`);
  if (land.bounce) extras.push('returns a land to your hand');
  if (land.sacrifice) extras.push(`sacrifice ${land.sacrifice} ${land.sacrificeUntapped ? 'untapped ' : ''}land${land.sacrifice > 1 ? 's' : ''}`);
  return [etb.replace('(pay 2 life)', land.shockLife === 2 ? '(pay 2 life)' : '(pay life)'), ...extras].join(', ');
}
