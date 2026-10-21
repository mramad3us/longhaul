// ============================================================
// LONGHAUL — Ship picker (new game)
// Every class a small crew can fly (PLAYABLE), grouped by the yard that
// builds it, with the facts that matter for choosing one: what it
// carries, how it fights, and what it costs to keep running. Combat
// strength is the AI's own measure (classStrength), on a log scale.
// ============================================================

import { esc } from './dom.js';
import { CLASSES, PLAYABLE, BUILDERS, KINDS, TECH, SIZES, maxCrew, hullPoints } from '../sim/ship-classes.js';
import { hullOf, portSummary } from '../sim/hulls.js';
import { createLayout } from '../sim/ship-layout.js';
import { drawHullPortrait } from './hull-art.js';
import { MINING_GEAR } from '../sim/weapons.js';
import { classStrength } from '../sim/combatants.js';

const YARD_ORDER = ['MCR', 'UN', 'independent', 'Belt'];
const YARD_COLOR = { MCR: '#C1553B', UN: '#4A90D9', independent: '#8A8A6A', Belt: '#E2A355' };

// Log-scale strength bar: an unarmed hull sits at the bottom, the best warship we can fly at the top
const STRENGTHS = Object.fromEntries(PLAYABLE.map(id => [id, classStrength(id)]));
const MAX_LOG = Math.log10(Math.max(...Object.values(STRENGTHS)));

/** Crew a class wants, from the fewest who can keep its watches to all it berths. */
export const crewRange = (id) => [CLASSES[id].crew[0], maxCrew(id)];

function armament(c) {
  const parts = [];
  if (c.pdc) parts.push(`${c.pdc} PDC`);
  if (c.tubes) parts.push(`${c.tubes} tube${c.tubes > 1 ? 's' : ''} (${c.magazine?.he || 0} HE, room for ${c.magazineCap ?? (c.magazine?.he || 0) + (c.magazine?.nuke || 0)})`);
  if (c.railgun) parts.push(`${c.railgun} railgun`);
  if (c.gear) parts.push(`${c.gear.mounts > 1 ? c.gear.mounts + ' × ' : ''}${MINING_GEAR[c.gear.type].name} (mining gear)`);
  return parts.length ? parts.join(' · ') : 'Unarmed';
}

const pct = (v) => `${Math.round(v * 100)}%`;

function detailHTML(id) {
  const c = CLASSES[id];
  const T = TECH[c.tl];
  const s = STRENGTHS[id];
  const bar = Math.max(0.02, Math.log10(Math.max(1, s)) / MAX_LOG);
  const [lo, hi] = crewRange(id);
  const row = (k, v, cls = '') => `<div class="sp-row"><span>${k}</span><b class="${cls}">${v}</b></div>`;
  return `
    <div class="sp-head">
      <canvas class="sp-hull" width="360" height="80" data-hull="${id}" data-view="top"></canvas>
      <canvas class="sp-hull" width="360" height="60" data-hull="${id}" data-view="side"></canvas>
      <div class="sp-title">${esc(c.name)}</div>
      <div class="sp-sub"><span style="color:${YARD_COLOR[c.builder]}">${esc(BUILDERS[c.builder].name)}</span> · ${esc(KINDS[c.kind])} · <span class="sp-tl sp-tl-${c.tl}">${T.label} ${esc(T.name)}</span></div>
      <p class="sp-desc">${esc(c.desc)}</p>
    </div>
    <div class="sp-cols">
      <div class="sp-col">
        <div class="sp-sec">HULL</div>
        ${row('Size', `${SIZES[c.size].label} · ${c.lengthM} m · ${c.massT.toLocaleString()} t`)}
        ${row('Structure', `${hullPoints(c)} DP · armor ${c.armor + T.armor}`)}
        ${row('Drive', `${c.drive.cruiseG} G cruise · ${c.drive.maxG} G max`)}
        ${row('Hold', `${c.cargoT.toLocaleString()} t`)}
        ${row('Crew', `${lo}–${hi} (usually ${c.crewStd})`)}
        ${row('Passengers', c.berths ? `${c.berths} berths on a deck of their own${c.kind === 'cutter' ? ' (the brig)' : ''}` : '—', c.berths ? '' : 'sp-dim')}
        ${row('Collars', esc(portSummary(id)))}
        ${row('Atmosphere', c.atmo ? `rated · ${c.atmo.entry === 'belly' ? 'lifting body, ceramic belly' : 'tail-first, shield ring'} · ${c.atmo.landing}` : 'not rated', c.atmo ? '' : 'sp-dim')}
        ${row('Decks', esc(createLayout(id).map(d => d.name).join(' · ')))}
      </div>
      <div class="sp-col">
        <div class="sp-sec">FIGHTING</div>
        ${row('Armament', esc(armament(c)), armament(c) === 'Unarmed' ? 'sp-dim' : '')}
        ${row('Sensors', `×${T.sensors}`)}
        ${row('Signature', `×${T.stealth}`)}
        ${row('Fire control', `×${T.fireControl}`)}
        ${row('Vs torpedoes', T.counterBurn ? 'turns away' : 'holds course, jinks', T.counterBurn ? '' : 'sp-warn')}
        <div class="sp-row"><span>Strength</span><span class="sp-bar"><i style="width:${pct(bar)}"></i></span></div>
        <div class="sp-sec">UPKEEP</div>
        ${row('Breakdowns', `×${+(1 / T.mtbf).toFixed(2)}`, T.mtbf < 1 ? 'sp-warn' : '')}
        ${row('Wear', `×${T.wear}`, T.wear > 1 ? 'sp-warn' : '')}
        ${row('Spares per repair', `×${T.parts}`, T.parts > 1 ? 'sp-warn' : '')}
        ${row('Yard prices', `×${T.price}`, T.price > 1 ? 'sp-warn' : '')}
        ${row('Jury-rigs hold', `${T.patchHours[0]}–${T.patchHours[1]} h`)}
      </div>
    </div>`;
}

/** The hull from above and from the side, nose right, in the yard's colour (hull-art.js). */
function drawHull(canvas) {
  const c = CLASSES[canvas.dataset.hull];
  drawHullPortrait(canvas, hullOf(canvas.dataset.hull), { view: canvas.dataset.view || 'top', tint: YARD_COLOR[c.builder] });
}

/**
 * Fill `box` with the picker. onSelect(id) fires when the choice changes.
 * Returns { get: () => id }.
 */
export function renderShipPicker(box, selected, onSelect) {
  let current = PLAYABLE.includes(selected) ? selected : PLAYABLE[0];
  const list = YARD_ORDER.map(y => {
    const ids = PLAYABLE.filter(id => CLASSES[id].builder === y);
    if (!ids.length) return '';
    return `<div class="sp-yard" style="--yard:${YARD_COLOR[y]}">${esc(BUILDERS[y].name.toUpperCase())}</div>` + ids.map(id => {
      const c = CLASSES[id];
      return `<button class="sp-item" data-ship="${id}" type="button"><span class="sp-item-name">${esc(c.name)}</span><span class="sp-item-kind">${esc(KINDS[c.kind])}${c.category === 'military' ? ' · navy surplus' : ''}</span><span class="sp-tl sp-tl-${c.tl}">${TECH[c.tl].label}</span></button>`;
    }).join('');
  }).join('');
  box.innerHTML = `<div class="sp-list">${list}</div><div class="sp-detail"></div>`;
  const detail = box.querySelector('.sp-detail');
  const show = (id) => {
    current = id;
    box.querySelectorAll('.sp-item').forEach(b => b.classList.toggle('active', b.dataset.ship === id));
    detail.innerHTML = detailHTML(id);
    detail.querySelectorAll('canvas[data-hull]').forEach(drawHull);
  };
  box.querySelector('.sp-list').addEventListener('click', (e) => {
    const b = e.target.closest('[data-ship]');
    if (!b || b.dataset.ship === current) return;
    show(b.dataset.ship);
    onSelect?.(current);
  });
  show(current);
  box.querySelector('.sp-item.active')?.scrollIntoView({ block: 'nearest' });
  return { get: () => current };
}
