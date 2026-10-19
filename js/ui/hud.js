// ============================================================
// LONGHAUL — HUD bar, ship status, resources
// ============================================================

import { ui } from './context.js';
import { $, $$, setText, setHTML, show, toggleClass, fmtSpeed, fmtMeters, fmtNum, fmtG, fmtMass } from './dom.js';
import { formatDate, formatTime, formatDuration } from '../core/clock.js';
import { AU_M } from '../core/constants.js';
import { maxSpeed } from '../sim/autopilot.js';
import { targetStateAt, targetName } from '../sim/nav.js';
import { dockedStation } from '../sim/contracts.js';
import { activeMissions } from '../sim/missions.js';
import { iconFuel, iconOxygen, iconN2, iconWater, iconFood, iconPower, iconMedical, iconCrew, iconParts } from '../svg-icons.js';
import { SYSTEM_IDS, Status, waterRecovery } from '../sim/systems.js';
import { systemsStripHTML } from './shipboard.js';
import { controlAt, spaceLabel } from '../sim/factions.js';
import { zonesAt, ZONE_KINDS } from '../sim/conflict.js';
import { hostilesOfPlayer } from '../sim/agents.js';
import { threatSummary } from './combat.js';

let el = {};
let onThreat = null;

export function initHud(onSpeed, onCombat, onSystems, openCombatTab) {
  onThreat = openCombatTab;
  el = {
    date: $('#hud-date'), time: $('#hud-time'), ship: $('#hud-ship-name'), chip: $('#hud-nav-chip'),
    perf: $('#hud-perf'), combat: $('#combat-toggle'), combatStatus: $('#combat-status'),
    station: $('#hud-station-btn'), missions: $('#hud-missions-count'), jobs: $('#hud-jobs-count'),
    drive: $('#info-drive'), attitude: $('#info-attitude'), vel: $('#info-velocity'), ref: $('#info-vel-ref'),
    orbit: $('#info-orbit'), mass: $('#info-mass'), cargo: $('#info-cargo'), alert: $('#alert-border'),
    speedBtns: $$('.speed-btn'), strip: $('#systems-strip'), sysCount: $('#hud-systems-count'),
    space: $('#hud-space'), threat: $('#hud-threat'), hull: $('#info-hull'),
  };
  el.threat.addEventListener('click', () => onThreat?.());
  el.strip.addEventListener('click', (e) => { if (e.target.closest('[data-act="open-systems"]')) onSystems(); });
  el.speedBtns.forEach(b => b.addEventListener('click', () => onSpeed(+b.dataset.speed)));
  el.combat.addEventListener('click', onCombat);
  initResources();
}

// ---- REFERENCE FRAME ----

/** What "relative velocity" is relative to: route target → held target → locked contact. */
export function velocityReference(state) {
  const ap = state.autopilot;
  if (ap) return { target: ap.plan.target, why: 'route' };
  if (state.flight.hold) return { target: { kind: state.flight.hold.kind, id: state.flight.hold.id }, why: 'hold' };
  if (state.sensors.locked) return { target: { kind: 'entity', id: state.sensors.locked }, why: 'lock' };
  return null;
}

export function relativeTo(state, target) {
  const t = targetStateAt(state, target, state.clock.minute);
  if (!t) return null;
  const f = state.flight;
  const dvx = f.vel.vx - t.vel.vx, dvy = f.vel.vy - t.vel.vy;
  const dx = (t.pos.x - f.pos.x) * AU_M, dy = (t.pos.y - f.pos.y) * AU_M;
  const d = Math.hypot(dx, dy);
  const closing = d > 0 ? (dvx * dx + dvy * dy) / d : 0;
  return { name: targetName(state, target), speed: Math.hypot(dvx, dvy), closing, dist: d, dvx, dvy, dx, dy };
}

// ---- NAV STATUS ----

export function navStatus(state) {
  const ap = state.autopilot;
  if (ap) {
    const name = targetName(state, ap.plan.target);
    if (ap.phase === 'prepare') return { chip: `PREPARING → ${name}`, cls: 'chip-warn' };
    if (ap.helm === 'unmanned') return { chip: `HELM UNMANNED — COASTING → ${name}`, cls: 'chip-danger' };
    const label = { burn: 'BURN', brake: 'BRAKE', coast: 'COAST', approach: 'APPROACH', flip: 'FLIP', orient: 'ORIENT', 'transfer-burn': 'BURN' }[ap.display] || ap.display.toUpperCase();
    const hand = ap.helm === 'manual' ? ` · HAND-FLOWN (${ap.helmBy})` : '';
    return { chip: `${label} → ${name}${hand}`, cls: ap.display === 'flip' || ap.helm === 'manual' ? 'chip-warn' : 'chip-nav' };
  }
  const st = dockedStation(state);
  if (st) return { chip: `DOCKED · ${st.name}`, cls: 'chip-ok' };
  if (state.flight.hold) {
    const h = state.flight.hold;
    return { chip: `HOLDING · ${targetName(state, h)} · ${fmtMeters(Math.hypot(h.ox, h.oy))}`, cls: 'chip-ok' };
  }
  return { chip: state.flight.thrustG > 0.01 ? `MANUAL BURN ${fmtG(state.flight.thrustG)}` : 'DRIFTING', cls: 'chip-dim' };
}

function turningLabel(state) {
  if (Math.abs(state.flight.turning) < 0.2) return null;
  return state.autopilot?.display === 'flip' || state.flight.manual?.flipTo != null ? 'FLIPPING' : 'TURNING';
}

// ---- PER-FRAME ----

export function updateHud(state) {
  setText(el.date, formatDate(state.clock));
  setText(el.time, formatTime(state.clock));
  setText(el.ship, state.ship.name);
  const ns = navStatus(state);
  setText(el.chip, ns.chip);
  if (el.chip.dataset.cls !== ns.cls) { el.chip.className = `hud-nav-chip ${ns.cls}`; el.chip.dataset.cls = ns.cls; }

  const max = maxSpeed(state);
  for (const b of el.speedBtns) {
    const s = +b.dataset.speed;
    toggleClass(b, 'active', s === state.speed && s > 0);
    toggleClass(b, 'paused', s === 0 && state.speed === 0);
    toggleClass(b, 'speed-restricted', s > max);
  }
  toggleClass(el.combat, 'active', state.combatStations);
  setText(el.combatStatus, state.combatStations ? 'ON' : 'OFF');
  show(el.station, !!dockedStation(state));

  const missions = activeMissions(state).length + state.contracts.active.length;
  setText(el.missions, missions);
  toggleClass(el.missions, 'has-missions', missions > 0);
  toggleClass(el.missions, 'has-sos', activeMissions(state).some(m => m.status === 'offered'));
  const jobs = state.jobs.list.length;
  setText(el.jobs, jobs);
  toggleClass(el.jobs, 'has-jobs', jobs > 0);
  toggleClass(el.jobs, 'has-critical', state.jobs.list.some(j => j.priority === 0));
  updateSystemsStrip(state);
  updateTactical(state);

  // Ship status
  const f = state.flight;
  const drive = f.thrustG > 0.02 ? `LIT ${fmtG(f.thrustG)}` : f.rcsG > 0.0005 ? 'RCS' : state.reactor.status === 'online' ? 'COLD' : 'NO POWER';
  setText(el.drive, drive);
  toggleClass(el.drive, 'val-hot', f.thrustG > 0.02);
  const ref = velocityReference(state);
  const rel = ref ? relativeTo(state, ref.target) : null;
  if (rel) {
    const forward = Math.cos(f.facing) * rel.dvx + Math.sin(f.facing) * rel.dvy;
    setText(el.vel, `${fmtSpeed(rel.speed)} ${rel.closing > 0.5 ? '▼ closing' : rel.closing < -0.5 ? '▲ opening' : ''}`.trim());
    setText(el.ref, `${rel.name} · ${fmtMeters(rel.dist)}`);
    setText(el.attitude, turningLabel(state) || (rel.speed < 1 ? 'STATION-KEEPING' : forward >= 0 ? 'PROGRADE' : 'RETROGRADE'));
  } else {
    setText(el.vel, '—');
    setText(el.ref, 'none — lock a contact');
    setText(el.attitude, turningLabel(state) || 'FREE');
  }
  const r = Math.hypot(f.pos.x, f.pos.y);
  setText(el.orbit, `${r.toFixed(3)} AU · ${fmtSpeed(Math.hypot(f.vel.vx, f.vel.vy))}`);
  const cargoKg = state.cargo.reduce((s, c) => s + c.mass, 0);
  setText(el.mass, fmtMass(state.shipMass + cargoKg + state.resources.fuel.current));
  setText(el.hull, `${Math.round(state.hull.integrity)}%${state.hull.integrity < 50 ? ' · burns limited to 3G' : ''}`);
  toggleClass(el.hull, 'val-hot', state.hull.integrity < 50);
  const pax = state.passengers.reduce((s, p) => s + p.count, 0);
  setText(el.cargo, `${fmtMass(cargoKg)} / ${fmtMass(state.cargoCapacity)}${pax ? ` · ${pax} pax` : ''}`);

  updateResources(state);
}

export function updatePerf(fps) {
  show(el.perf, ui.settings.showPerf);
  if (!ui.settings.showPerf || !ui.loop) return;
  const n = ui.state?.entities.length ?? 0;
  setText(el.perf, `${fps} FPS · sim ${ui.loop.simMsLastFrame.toFixed(1)}ms · ${ui.loop.stepsLastFrame} min/f · ${fmtNum(n)} ent`);
}

// ---- TACTICAL: whose space, what's coming ----

let spaceAt = 0;
function updateTactical(state) {
  const now = performance.now();
  if (now - spaceAt > 1000) {
    spaceAt = now;
    const p = state.flight.pos;
    const ctl = controlAt(p.x, p.y, state.clock.minute);
    const zone = zonesAt(state, p)[0];
    setText(el.space, zone ? `${spaceLabel(ctl)} · ${ZONE_KINDS[zone.kind].label}` : spaceLabel(ctl));
    el.space.className = `hud-space-chip ${zone ? 'space-hot' : ctl.lawless ? 'space-lawless' : ctl.contested ? 'space-contested' : ''}`;
  }
  const th = threatSummary(state);
  const hostiles = hostilesOfPlayer(state).length;
  const show_ = !!th || hostiles > 0;
  show(el.threat, show_);
  if (!show_) return;
  setText(el.threat, th
    ? `⚠ ${th.count} ${th.nuke ? 'NUCLEAR ' : ''}INBOUND · ${isFinite(th.eta) ? formatDuration(th.eta / 60) : '—'}`
    : `⚠ ${hostiles} HOSTILE${hostiles > 1 ? 'S' : ''}`);
  toggleClass(el.threat, 'urgent', !!th && th.eta < 30 * 60);
}

// ---- SYSTEMS ----

let stripAt = 0;
function updateSystemsStrip(state) {
  const units = state.systems.units;
  const faults = SYSTEM_IDS.filter(id => units[id].status !== Status.NOMINAL).length;
  setText(el.sysCount, faults ? faults : '');
  toggleClass(el.sysCount, 'has-faults', faults > 0);
  toggleClass(el.sysCount, 'has-critical', SYSTEM_IDS.some(id => units[id].status === Status.FAILED));
  const now = performance.now();
  if (now - stripAt < 500) return;
  stripAt = now;
  setHTML(el.strip, systemsStripHTML(state));
}

// ---- RESOURCES ----

const RES = [
  { key: 'fuel', name: 'Fuel', icon: iconFuel, bar: 'bar-fuel', fmt: (r) => `${fmtNum(r.current)} / ${fmtNum(r.max)} kg` },
  { key: 'o2Tank', name: 'O₂', icon: iconOxygen, bar: 'bar-oxygen', fmt: (r, s) => `${fmtNum(r.current)} kg · ${hours(s.lifeSupport.oxygenHours)}` },
  { key: 'n2Tank', name: 'N₂', icon: iconN2, bar: 'bar-n2', fmt: (r) => `${fmtNum(r.current)} / ${fmtNum(r.max)} kg` },
  { key: 'water', name: 'Water', icon: iconWater, bar: 'bar-water', fmt: (r, s) => `${fmtNum(r.current)} L · ${days(r.current, s, WATER_GROSS * (1 - waterRecovery(s)))}` },
  { key: 'food', name: 'Food', icon: iconFood, bar: 'bar-food', fmt: (r, s) => `${fmtNum(r.current)} · ${days(r.current, s, 0.001)}` },
  { key: 'power', name: 'Power', icon: iconPower, bar: 'bar-power', fmt: (r) => `${Math.round(r.current)}%` },
  { key: 'medSupplies', name: 'Medical', icon: iconMedical, bar: 'bar-medical', fmt: (r) => `${r.current.toFixed(1)} / ${r.max}` },
  { key: 'parts', name: 'Spare parts', icon: iconParts, bar: 'bar-parts', fmt: (r, s) => `${r.current.toFixed(1)} · scrap ${s.resources.scrap.current.toFixed(1)}`,
    level: (r) => r.current < 2 ? 'critical' : r.current < 5 ? 'warning' : 'ok' },
  { key: 'pdcRounds', name: 'PDC rounds', icon: iconParts, bar: 'bar-ammo', fmt: (r, s) => `${fmtNum(r.current)} · torps ${s.magazine.he} HE ${s.magazine.nuke} NUKE` },
];
// Gross water per person per minute (drinking, galley, a shower a day) — reclamation recovers most of it
const WATER_GROSS = 0.004 + 12 / 1440;

function hours(h) { return !isFinite(h) ? '—' : h > 72 ? `${Math.round(h / 24)}d` : `${Math.round(h)}h`; }
function days(amount, s, perMin) {
  const mouths = s.ship.crew.filter(m => !m.dead).length + s.passengers.reduce((a, p) => a + p.count, 0);
  if (!mouths || perMin <= 0) return '—';
  return formatDuration(amount / (mouths * perMin));
}

const resEls = {};
const lastLevel = {};

function initResources() {
  const list = $('#resource-list');
  list.innerHTML = '';
  const row = (id, name, iconFn, bar) => {
    const item = document.createElement('div');
    item.className = 'resource-item';
    item.innerHTML = `<div class="resource-icon"></div><div class="resource-info"><div class="resource-name">${name}</div><div class="resource-value"></div>${bar ? `<div class="resource-bar"><div class="resource-bar-fill ${bar}"></div></div>` : ''}</div>`;
    const icon = item.querySelector('.resource-icon');
    if (iconFn) icon.appendChild(iconFn()); else icon.innerHTML = '<span class="res-text-icon">MCR</span>';
    list.appendChild(item);
    resEls[id] = { item, val: item.querySelector('.resource-value'), bar: item.querySelector('.resource-bar-fill') };
  };
  row('crew', 'Crew', iconCrew, null);
  row('credits', 'Credits', null, null);
  for (const r of RES) row(r.key, r.name, r.icon, r.bar);
}

/** Fires once when a resource crosses into low/critical (UI alerts). */
export let onResourceAlert = () => {};
export function setResourceAlertHandler(fn) { onResourceAlert = fn; }

function updateResources(state) {
  const alive = state.ship.crew.filter(m => !m.dead).length;
  setText(resEls.crew.val, `${alive} / ${state.ship.crew.length}${state.passengers.length ? ` · ${state.passengers.reduce((s, p) => s + p.count, 0)} pax` : ''}`);
  setText(resEls.credits.val, `${fmtNum(state.resources.credits.current)} MCR`);
  let critical = false;
  for (const cfg of RES) {
    const r = state.resources[cfg.key];
    const e = resEls[cfg.key];
    const pct = Math.max(0, Math.min(100, r.current / r.max * 100));
    setText(e.val, cfg.fmt(r, state));
    const w = `${pct.toFixed(1)}%`;
    if (e.bar.style.width !== w) e.bar.style.width = w;
    const level = cfg.level ? cfg.level(r) : pct < 15 ? 'critical' : pct < 30 ? 'warning' : 'ok';
    toggleClass(e.item, 'critical', level === 'critical');
    toggleClass(e.item, 'warning', level === 'warning');
    if (level === 'critical') critical = true;
    const prev = lastLevel[cfg.key];
    if (prev && prev !== level && level !== 'ok' && (prev === 'ok' || level === 'critical')) onResourceAlert(cfg.name, level, pct);
    lastLevel[cfg.key] = level;
  }
  toggleClass(el.alert, 'critical', critical);
}

export function resetResourceAlerts() {
  for (const k of Object.keys(lastLevel)) delete lastLevel[k];
}

