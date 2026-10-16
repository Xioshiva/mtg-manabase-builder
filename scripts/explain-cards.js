#!/usr/bin/env node
// Prints each card's rules text next to how the builder reads it, for checking the parser.
//   node scripts/explain-cards.js [cards.json] [--json]
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { normalizeCard, describeEffect, landSummary, landColors } from '../public/lib/cards.js';
import { COLOR_BITS, maskToColors } from '../public/lib/mana.js';

const file = process.argv.slice(2).find((a) => !a.startsWith('--')) || fileURLToPath(new URL('../test/fixtures/real/cards.json', import.meta.url));
const asJson = process.argv.includes('--json');
const colors = (m) => maskToColors(m).join('') || '-';
const costText = (c) => `${c.generic ? `{${c.generic}}` : ''}${c.pips.map((p) => `{${maskToColors(p).join('/')}}`).join('')}${c.twobrid.map((p) => `{2/${maskToColors(p)}}`).join('')}${c.x ? '{X}'.repeat(c.x) : ''}` || '{0}';

function landReading(L) {
  const parts = [`makes ${colors(L.mask)} freely`];
  for (const c of L.cond) parts.push(`${colors(c.mask)} only ${c.basicOrFresh ? 'the turn it enters or with a basic' : c.artifacts ? `with ${c.artifacts} artifacts in play` : `with ${colors(c.types)}-type land in play`}`);
  if (L.extra && L.extra.length) parts.push(`${L.extra.length + 1} mana a tap (extra ${L.extra.map(colors).join(', ')})`);
  for (const r of L.restricted) parts.push(`${colors(r.mask)}${r.kind ? ` only for ${r.kind === 'spell' ? 'instants/sorceries' : r.kind} spells` : ''}${r.life ? ` costing ${r.life} life` : ''}`);
  if (L.choices) parts.push(`choose one of ${L.choices.map(colors).join('/')} when played${L.choiceSetsType ? ' (also its land type)' : ''}`);
  if (L.types) parts.push(`land types ${colors(L.types)}`);
  if (L.grantTypes) parts.push(`gives every land types ${colors(L.grantTypes)}`);
  if (L.etbMana) parts.push(`adds ${colors(L.etbMana)} when it enters`);
  if (L.leavesAfter) parts.push(`leaves after ${L.leavesAfter} turns`);
  return `${landSummary(L)}; ${parts.join('; ')}`;
}

const rows = [];
for (const sc of JSON.parse(readFileSync(file, 'utf8'))) {
  const d = normalizeCard(sc, 1);
  const text = sc.oracle_text ?? (sc.card_faces || []).map((f) => `[${f.name}] ${f.mana_cost || ''} ${f.type_line}\n${f.oracle_text}`).join('\n// ');
  const reading = [];
  if (d.land) reading.push(`LAND: ${landReading(d.land)}`);
  if (d.spell) {
    const sp = d.spell;
    const ex = sp.extraCost;
    const extra = ex ? `, extra ${costText({ generic: ex.generic, pips: ex.pips, twobrid: [], x: 0 })}${ex.unlessType ? ` unless you ${ex.fromHand ? 'behold' : 'sacrifice'} ${/^[aeiou]/.test([].concat(ex.unlessType)[0]) ? 'an' : 'a'} ${[].concat(ex.unlessType).join(' or ')}` : ''}, checked on turn ${sp.curveTurn}` : '';
    reading.push(`SPELL: cost ${costText(sp.cost)}, mana value ${sp.cmc}, kind ${sp.kind}${extra}${sp.costReduction && !sp.domain ? ', has cost reduction (not modelled)' : ''}${sp.extraLandDrops ? `, ${sp.extraLandDrops} extra land drop each turn` : ''}${sp.domain ? `, costs {${sp.domain}} less per basic land type` : ''}${sp.noCost ? ', no mana cost (never cast)' : ''}${sp.legendary ? ', legendary' : ''}${sp.leyline ? ', starts on the battlefield from the opening hand' : ''}`);
    if (sp.ramp) reading.push(`RAMP: ${sp.ramp.count} ${sp.ramp.anyLand ? 'land' : sp.ramp.basicOnly ? 'basic land' : `${colors(sp.ramp.types)} land`}${sp.ramp.count > 1 ? 's' : ''}${sp.ramp.tapped ? ' tapped' : ''}${sp.ramp.toHand ? `, ${sp.ramp.toHand} to hand` : ''}`);
    if (sp.landFromHand) reading.push(`PUTS A LAND FROM HAND ONTO THE BATTLEFIELD${sp.landFromHand.tapped ? ' tapped' : ''}`);
    if (sp.grantTypes) reading.push(`GIVES EVERY LAND TYPES ${colors(sp.grantTypes)}`);
    if (sp.untapLands) reading.push('MAKES LANDS ENTER UNTAPPED');
    reading.push(`DRAW/SELECTION: ${sp.effect ? describeEffect(sp.effect) : 'none'}`);
    if (sp.treasure) reading.push(`TREASURE: ${sp.treasure.now} now${sp.treasure.upkeep ? `, ${sp.treasure.upkeep} each upkeep` : ''}${sp.treasure.later.length ? `, then on turns +${sp.treasure.later.join(', +')}` : ''}`);
    if (sp.mana) reading.push(`MANA SOURCE: ${colors(landColors({ ...sp.mana, choices: null, fetch: null }, { restricted: true }))}${sp.mana.extra && sp.mana.extra.length ? `, ${sp.mana.extra.length + 1} mana a tap` : ''}${sp.mana.sick ? ' from next turn (summoning sick)' : ' immediately'}${sp.mana.restricted.length ? `; restricted: ${sp.mana.restricted.map((r) => `${colors(r.mask)} ${r.kind || ''}${r.life ? ` ${r.life} life` : ''}`).join(', ')}` : ''}`);
  }
  if (d.mdfcLand) reading.push(`BACK FACE LAND: ${landReading(d.mdfcLand)}`);
  for (const n of d.notes) reading.push(`NOTE: ${n}`);
  rows.push({ name: sc.name, cost: sc.mana_cost ?? '', type: sc.type_line, text, reading });
}
if (asJson) console.log(JSON.stringify(rows, null, 1));
else for (const r of rows) console.log(`## ${r.name} | ${r.cost} | ${r.type}\n${r.text}\n=> ${r.reading.join('\n=> ')}\n`);
