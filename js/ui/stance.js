// ============================================================
// LONGHAUL — Stance panel: the nav computer's standing orders
//
// A stance keeps a relation to a target until it is released
// (sim/stance.js): HOLD at a range, KEEP OUT, KEEP WITHIN. The panel
// offers the ranges that matter against this target (our guns or gear,
// a torpedo standoff, the long standoff, the edge of our sensors, where
// we are now, or any range typed in), the drive to fly it with, how
// tightly to hold, and the doctrine under fire. It previews the move
// into place with the same simulation the autopilot flies.
//
// It shares the right-hand slot of the nav modal with the route panel
// (nav.js decides which is showing). quickStance() takes a stance in
// one click from the fire-control panel.
// ============================================================

import { ui } from './context.js';
import { $, esc, setHTML, show, fmtKm, fmtSpeed, fmtG, fmtNum } from './dom.js';
import { toast } from './toast.js';
import { logEntry } from './log.js';
import { DAY_MIN } from '../core/constants.js';
import { formatDuration } from '../core/clock.js';
import { simulatePlan, targetName } from '../sim/nav.js';
import { engageStance, abortRoute } from '../sim/autopilot.js';
import { createStance, stanceRanges, stanceBand, STANCE_MODES } from '../sim/stance.js';
import { TECH, playerClass } from '../sim/ship-classes.js';
import { relativeTo, STANCE_PHASE } from './hud.js';
import { bus } from '../core/events.js';

const G_CHOICES = [1, 3, 5, 7, 10];
const TIGHT_BELOW_M = 20_000_000;        // ranges under 20,000 km are held TIGHT by default

let st = null;                           // the panel's choices, or null when closed
let hooks = { preview: () => {}, closed: () => {} };
const panel = () => $('#route-panel');

export function initStance(h) {
  hooks = { ...hooks, ...h };
  panel().addEventListener('click', onClick);
  panel().addEventListener('change', onChange);
}

export const stanceOpen = () => !!st;

/** The stance held on `target` right now, if any. */
export function currentStance(state, target) {
  const ap = state.autopilot;
  return ap?.plan.kind === 'stance' && ap.plan.target.id === target.id ? ap : null;
}

const defaultG = (s) => Math.min(s.combatStations ? 3 : 1, Math.max(1, Math.floor(s.flight.maxG)));

function defaultKey(ranges) {
  return (ranges.find(r => r.key === 'torpedo') || ranges.find(r => r.key === 'here') || ranges[0]).key;
}

/** A stance plan from the panel's choices (or a quick pick). */
function buildPlan(s, target, { mode, rangeM, accelG, tight, evade, slow, label }) {
  return createStance(target, { mode, rangeM, accelG, tight: tight ?? rangeM < TIGHT_BELOW_M, evade, slow, label });
}

export function openStance(target, preset = {}) {
  const s = ui.state;
  if (!s) return;
  const rel = relativeTo(s, target);
  const ranges = stanceRanges(s, target, rel ? rel.dist : null);
  const cur = currentStance(s, target)?.plan;
  st = {
    target, ranges,
    mode: preset.mode ?? cur?.mode ?? 'hold',
    key: preset.key ?? (cur ? ranges.find(r => Math.abs(r.m - cur.standoff) < 1)?.key ?? 'custom' : defaultKey(ranges)),
    customKm: cur ? cur.standoff / 1000 : null,
    accelG: cur?.accelG ?? defaultG(s),
    tight: cur ? cur.tight : null,       // null: by the range
    evade: cur?.evade ?? true,
    slow: cur?.slow ?? true,
    preview: null, computing: false,
  };
  show(panel(), true, 'flex');
  compute();
}

export function closeStance() {
  if (!st) return;
  st = null;
  hooks.preview(null);
  show(panel(), false);
  hooks.closed();
}

function rangeM() {
  if (st.key === 'custom') return Math.max(100, (st.customKm || 0) * 1000);
  return st.ranges.find(r => r.key === st.key)?.m ?? 0;
}

function choices() {
  const m = rangeM();
  return { mode: st.mode, rangeM: m, accelG: st.accelG, tight: st.tight ?? m < TIGHT_BELOW_M, evade: st.evade, slow: st.slow };
}

function compute() {
  const s = ui.state;
  st.computing = true;
  st.preview = null;
  render();
  setTimeout(() => {
    if (!st || !ui.state) return;
    const est = simulatePlan(s, buildPlan(s, st.target, choices()), { maxMinutes: 3 * DAY_MIN, pathPoints: 120 });
    st.preview = est;
    st.computing = false;
    hooks.preview(est.minutes > 0 ? est.path : null);
    render();
  }, 30);
}

function render() {
  if (!st) return;
  const s = ui.state;
  const t = st.target;
  const rel = relativeTo(s, t);
  const name = targetName(s, t);
  const cur = currentStance(s, t);
  const c = choices();
  const band = stanceBand(c.rangeM, c.tight);
  const sel = st.key === 'custom' ? null : st.ranges.find(r => r.key === st.key);
  const tl = playerClass(s).tl;
  const btn = (act, label, active, extra = '') => `<button class="solar-zoom-btn ${active ? 'active' : ''}" data-st="${act}" ${extra}>${label}</button>`;
  const row = (label, body) => `<div class="stance-row"><div class="stance-label">${label}</div>${body}</div>`;

  const modes = Object.entries(STANCE_MODES).map(([k, m]) => btn(`mode:${k}`, m.label, st.mode === k)).join('');
  const ranges = st.ranges.map(r => `<button class="stance-range ${st.key === r.key ? 'active' : ''} ${r.warn ? 'warn' : ''}" data-st="range:${r.key}">
      <b>${esc(r.label)}</b><span>${fmtKm(r.m / 1000)}</span></button>`).join('');
  const custom = `<label class="stance-custom ${st.key === 'custom' ? 'active' : ''}">or <input type="number" min="0.1" step="any" data-st-input="km" value="${st.key === 'custom' && st.customKm ? +st.customKm.toFixed(1) : ''}" placeholder="${fmtNum(c.rangeM / 1000)}"> km</label>`;
  const gs = G_CHOICES.filter(g => g <= s.flight.maxG || g === 1).map(g => btn(`g:${g}`, `${g}G`, st.accelG === g)).join('');
  const juice = st.accelG > 1.5 ? `<div class="route-juice-note">⚠ Above 1.5G the crew stays in the couches whenever the stance may burn</div>` : '';
  const keepDesc = c.tight
    ? `Within ${fmtKm(band / 1000)} of the stance point. Corrections on RCS; the drive carries what the target's own thrust needs.`
    : `Within ${fmtKm(band / 1000)}. Slower, cheaper corrections; off a coasting target the drive stays cold and shows no plume.`;
  const counter = TECH[tl].counterBurn;
  const doctrine = `<button class="stance-check ${st.evade && counter ? 'on' : ''}" data-st="evade" ${counter ? '' : 'disabled'}>${st.evade && counter ? '☑' : '☐'} TURN AWAY FROM TORPEDOES</button>
    <div class="route-card-desc">${counter ? 'Burn away from any torpedo less than 45 minutes out: it arrives slowly, long under our PDCs, and must spend its Δv to catch up.' : 'Needs a fire-control computer that plots the threat axis (TL2 and up).'}</div>
    <button class="stance-check ${st.slow ? 'on' : ''}" data-st="slow">${st.slow ? '☑' : '☐'} CLOSE NO FASTER THAN 5 KM/S</button>
    <div class="route-card-desc">With a torpedo inbound. Every m/s of closing speed is a m/s on their torpedoes.</div>`;

  const p = st.preview;
  const preview = st.computing ? '<div class="stance-preview route-computing">Nav computer plotting…</div>'
    : !p ? ''
    : !p.arrived ? `<div class="stance-preview route-infeasible">● Not in place within 3 days at ${fmtG(st.accelG)}</div>`
    : p.minutes === 0 ? `<div class="stance-preview route-feasible">● ${st.mode === 'hold' ? 'Already on station' : 'Already inside the range: watching'}</div>`
    : `<div class="stance-preview route-feasible">● In place in ${formatDuration(p.minutes)} · ${fmtNum(p.fuel)} kg · peak ${fmtSpeed(p.peakSpeed)}</div>`;
  const now = cur ? `<span class="stance-current">NOW: ${STANCE_MODES[cur.plan.mode].label} ${fmtKm(cur.plan.standoff / 1000)} · ${STANCE_PHASE[cur.display] || cur.display.toUpperCase()}</span>` : '';

  setHTML(panel(), `<div class="route-panel-header"><span class="route-panel-title">STANCE</span><button class="route-panel-close" data-st="close" aria-label="Close">&times;</button></div>
    <div class="route-dest-info">
      <span class="route-dest-label">Keep a stance on</span>
      <span class="route-dest-name">${esc(name)}</span>
      <span class="route-dest-dist">${rel ? `${fmtKm(rel.dist / 1000)} · rel ${fmtSpeed(rel.speed)} · ${rel.closing >= 0 ? 'closing' : 'opening'} ${fmtSpeed(Math.abs(rel.closing))}` : ''}</span>
      ${now}
    </div>
    <div class="stance-body">
      ${row('ORDER', `<div class="route-standoff">${modes}</div><div class="route-card-desc">${esc(STANCE_MODES[st.mode].desc)}</div>`)}
      ${row('RANGE', `<div class="stance-ranges">${ranges}</div>${custom}
        <div class="route-card-desc">${sel ? esc(sel.desc) : 'A range of our own choosing.'}</div>${sel?.warn ? `<div class="stance-warn">⚠ ${esc(sel.warn)}</div>` : ''}`)}
      ${row('DRIVE', `<div class="route-standoff">${gs}</div>${juice}`)}
      ${row('HOLD', `<div class="route-standoff">${btn('tight:1', 'TIGHT', c.tight)}${btn('tight:0', 'LOOSE', !c.tight)}</div><div class="route-card-desc">${keepDesc}</div>`)}
      ${row('UNDER FIRE', doctrine)}
    </div>
    ${preview}
    <div class="route-panel-actions">
      ${cur ? '<button class="btn btn-secondary route-btn" data-st="release">RELEASE</button>' : '<button class="btn btn-secondary route-btn" data-st="close">CANCEL</button>'}
      <button class="btn btn-primary route-btn" data-st="engage" ${c.rangeM > 0 ? '' : 'disabled'}>${cur ? 'CHANGE STANCE' : 'TAKE STANCE'}</button>
    </div>`);
}

function onClick(e) {
  const b = e.target.closest('[data-st]');
  if (!b || !st || !ui.state) return;
  e.stopPropagation();
  const [act, arg] = b.dataset.st.split(':');
  switch (act) {
    case 'close': closeStance(); return;
    case 'mode': st.mode = arg; break;
    case 'range': st.key = arg; st.tight = null; break;
    case 'g': st.accelG = +arg; break;
    case 'tight': st.tight = arg === '1'; break;
    case 'evade': st.evade = !st.evade; render(); return;
    case 'slow': st.slow = !st.slow; render(); return;
    case 'release': release(ui.state); closeStance(); return;
    case 'engage': take(ui.state, st.target, choices()); closeStance(); return;
    default: return;
  }
  compute();
}

function onChange(e) {
  const input = e.target.closest('[data-st-input="km"]');
  if (!input || !st) return;
  const km = parseFloat(input.value);
  if (!(km > 0)) return;
  st.key = 'custom';
  st.customKm = km;
  st.tight = null;
  compute();
}

/** Take up a stance and say so. */
function take(s, target, c) {
  const plan = buildPlan(s, target, c);
  engageStance(s, plan);
  const name = targetName(s, target);
  logEntry(`Stance: ${STANCE_MODES[plan.mode].label} ${fmtKm(plan.standoff / 1000)} on ${name} · ${fmtG(plan.accelG)} · ${plan.tight ? 'tight' : 'loose'}`, 'nav');
  toast(`STANCE → ${name}`, 'nav');
}

export function release(s) {
  if (s.autopilot?.plan.kind === 'stance') abortRoute(s, (type, p) => bus.emit(type, p));
}

/** One click from the fire-control panel: HOLD at one of the target's ranges, with defaults. */
export function quickStance(s, target, key) {
  const rel = relativeTo(s, target);
  const r = stanceRanges(s, target, rel ? rel.dist : null).find(o => o.key === key);
  if (!r) return;
  take(s, target, { mode: 'hold', rangeM: r.m, accelG: defaultG(s), evade: true, slow: true });
}
