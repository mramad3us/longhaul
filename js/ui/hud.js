// ============================================================
// LONGHAUL — The console's top rail, its flight band's status, the SHIP panel
// The rail: the ship, the flag chip and whose space this is, the clock,
// time warp, the annunciators (a hostile or a torpedo inbound, master
// caution and warning, battle stations, suits). The flight band (over the
// display): the nav status chip and traffic control's chip.
// The SHIP panel: drive, attitude, the reference velocity, hull, mass,
// cargo, the systems' health, stores.
// ============================================================

import { suitedCount } from '../sim/life-support.js';
import { ui } from './context.js';
import { $, $$, esc, setText, setHTML, show, toggleClass, fmtSpeed, fmtMeters, fmtNum, fmtG, fmtMass } from './dom.js';
import { flagChip, openService } from './service.js';
import { formatDate, formatTime, formatDuration } from '../core/clock.js';
import { AU_M } from '../core/constants.js';
import { maxSpeed } from '../sim/autopilot.js';
import { targetStateAt, targetName } from '../sim/nav.js';
import { dockedStation } from '../sim/contracts.js';
import { leaseFor } from '../sim/leases.js';
import { activeMissions } from '../sim/missions.js';
import { iconFuel, iconOxygen, iconN2, iconWater, iconFood, iconPower, iconMedical, iconCrew, iconParts } from '../svg-icons.js';
import { shipSystems, Status, waterRecovery } from '../sim/systems.js';
import { systemsStripHTML } from './shipboard.js';
import { controlAt, spaceLabel } from '../sim/factions.js';
import { zonesAt, ZONE_KINDS } from '../sim/conflict.js';
import { hostilesOfPlayer } from '../sim/agents.js';
import { getWorld } from '../sim/world.js';
import { clearanceFor } from '../sim/traffic-control.js';
import { finesOwed } from '../sim/law.js';
import { threatSummary } from './combat.js';
import { ourName } from '../sim/service.js';

let el = {};
let onThreat = null;
let onHail = null;

/** The traffic-control chip's HAIL button opens the comms window on the station. */
export function setHailHandler(fn) { onHail = fn; }
let onRoute = null, onDock = null;
export function setRouteHandler(fn) { onRoute = fn; }
export function setDockHandler(fn) { onDock = fn; }

export function initHud(onSpeed, onCombat, onSystems, openCombatTab, onSuits = null) {
  onThreat = openCombatTab;
  $('#hud-flag').addEventListener('click', () => openService());
  el = {
    date: $('#hud-date'), time: $('#hud-time'), ship: $('#hud-ship-name'), chip: $('#hud-nav-chip'),
    perf: $('#hud-perf'), combat: $('#combat-toggle'), combatStatus: $('#combat-status'), suits: $('#suits-toggle'), suitsStatus: $('#suits-status'),
    station: $('#hud-station-btn'), missions: $('#hud-missions-count'), jobs: $('#hud-jobs-count'),
    drive: $('#info-drive'), attitude: $('#info-attitude'), vel: $('#info-velocity'), ref: $('#info-vel-ref'),
    orbit: $('#info-orbit'), mass: $('#info-mass'), cargo: $('#info-cargo'), alert: $('#alert-border'),
    speedBtns: $$('.speed-btn'), strip: $('#systems-strip'), sysCount: $('#hud-systems-count'),
    space: $('#hud-space'), threat: $('#hud-threat'), hull: $('#info-hull'), flag: $('#hud-flag'),
    tc: $('#tc-chip'), comms: $('#hud-comms-btn'),
  };
  el.tc.addEventListener('click', (e) => {
    const b = e.target.closest('[data-hail]');
    if (b) onHail?.(b.dataset.hail);
    const r = e.target.closest('[data-slot]');
    if (r) onRoute?.({ kind: 'slot', id: r.dataset.station, slot: r.dataset.slot });
    const d = e.target.closest('[data-dock]');
    if (d) onDock?.(d.dataset.dock);
  });
  el.threat.addEventListener('click', () => onThreat?.());
  el.strip.addEventListener('click', (e) => { if (e.target.closest('[data-act="open-systems"]')) onSystems(); });
  el.speedBtns.forEach(b => b.addEventListener('click', () => onSpeed(+b.dataset.speed)));
  el.combat.addEventListener('click', onCombat);
  el.suits?.addEventListener('click', () => onSuits?.());
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

/** How each phase of a stance (sim/stance.js) is shown. */
export const STANCE_PHASE = {
  prepare: 'SECURING', held: 'FLIP HELD', holding: 'ON STATION', watch: 'WATCHING', ready: 'READY TO BURN', guard: 'HOLDING THE LINE',
  evade: 'EVADING TORPEDO', approach: 'MOVING · RCS', burn: 'MOVING · BURN', brake: 'MOVING · BRAKE', coast: 'MOVING · COAST',
  flip: 'MOVING · FLIP', orient: 'ORIENT',
};

const DOCK_CHIP = {
  awaiting: ['AWAITING DOCKING CLEARANCE', 'chip-warn'], approach: ['FINAL APPROACH', 'chip-nav'], prox: ['DOCKING', 'chip-nav'],
  capture: ['SOFT CAPTURE', 'chip-ok'], seal: ['HARD DOCK', 'chip-ok'], undock: ['UNDOCKING', 'chip-warn'], separate: ['SEPARATING', 'chip-warn'],
  holding: ['HOLDING OFF', 'chip-ok'], outbound: ['CLIMBING OUT ON RCS', 'chip-nav'],
};

const fmtLeft = (min) => min >= 48 * 60 ? `${Math.floor(min / 1440)}D ${Math.floor(min % 1440 / 60)}H` : `${Math.floor(min / 60)}H${String(min % 60).padStart(2, '0')}`;

export function navStatus(state) {
  const ap = state.autopilot;
  const d = state.dock;
  if (d && d.phase === 'docked') {
    const e = getWorld(state).get(d.target.id);
    const L = d.target.kind === 'station' ? leaseFor(state) : null;
    const lease = L ? ` · ${L.left >= 0 ? `LEASE ${fmtLeft(L.left)}` : `${fmtLeft(-L.left)} OVER LEASE`}` : '';
    return { chip: `DOCKED · ${e?.name || ''} · ${d.target.kind === 'station' ? d.berth : 'collar to collar'}${lease}`, cls: L && L.left < 0 ? 'chip-warn' : 'chip-ok' };
  }
  if (d && DOCK_CHIP[d.phase]) {
    const e = getWorld(state).get(d.target.id);
    const [label, cls] = DOCK_CHIP[d.phase];
    const r = d.phase === 'prox' || d.phase === 'separate' ? ` · ${d.rel.x < 10 ? d.rel.x.toFixed(1) : Math.round(d.rel.x)} m${d.mode === 'manual' ? ' · BY HAND' : ''}` : d.phase === 'approach' ? ` · ${fmtMeters(Math.hypot(d.rel.x - (d.target.kind === 'ship' ? 300 : 1000), d.rel.y, d.rel.z || 0))}` : d.phase === 'outbound' && d.goal ? ` · ${fmtMeters(Math.hypot(d.goal.x - d.rel.x, d.goal.y - d.rel.y))} TO THE GATE` : '';
    return { chip: `${label} · ${e?.name || ''}${r}`, cls };
  }
  if (ap) {
    const name = targetName(state, ap.plan.target);
    if (ap.phase === 'prepare') return { chip: `PREPARING → ${name}`, cls: 'chip-warn' };
    if (ap.helm === 'unmanned') return { chip: `HELM UNMANNED — COASTING → ${name}`, cls: 'chip-danger' };
    if (ap.turnHeld != null) return { chip: `FLIP HELD — CREW ON THEIR FEET · ${name}`, cls: 'chip-danger' };
    if (state.$maneuverAlert) return { chip: `MANEUVERING — SECURE ALL HANDS · ${name}`, cls: 'chip-danger' };
    if (ap.plan.kind === 'stance') {
      const hand = ap.helm === 'manual' ? ` · HAND-FLOWN (${ap.helmBy})` : '';
      const cls = ap.display === 'evade' ? 'chip-danger' : ap.display === 'holding' || ap.display === 'watch' ? 'chip-ok'
        : ['ready', 'guard', 'flip', 'orient'].includes(ap.display) ? 'chip-warn' : 'chip-nav';
      return { chip: `${STANCE_PHASE[ap.display] || ap.display.toUpperCase()} · ${name}${hand}`, cls };
    }
    const label = { burn: 'BURN', brake: 'BRAKE', coast: 'COAST', approach: 'APPROACH', flip: 'FLIP', orient: 'ORIENT', 'transfer-burn': 'BURN', depart: 'DEPARTING ON RCS' }[ap.display] || ap.display.toUpperCase();
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

const ZONE_LABEL = { control: 'CONTROL SPACE', approach: 'ON THE APPROACH', keepout: 'INSIDE THE GATE', docked: 'IN A BERTH' };

/** Near a station: which of its zones we are in, our clearance, and a HAIL button when we need one. */
function updateTcChip(state) {
  const tc = state.tc;
  const st = tc?.station ? getWorld(state).get(tc.station) : null;
  if (!st || tc.zone === 'none') { show(el.tc, false); return; }
  const cl = clearanceFor(state, st.id);
  const now = state.clock.minute;
  const leaving = tc.outbound === st.id;
  const status = tc.zone === 'docked' ? (cl.depart ? ['tc-ok', 'CLEARED TO DEPART'] : ['tc-warn', 'NO DEPARTURE CLEARANCE'])
    : cl.dock ? ['tc-ok', `CLEARED TO DOCK · ${cl.dock.berth} · ${cl.dock.until - now} MIN`]
    : cl.hold ? ['tc-ok', `HOLDING ${cl.hold.slot} · ${Math.round((cl.hold.until - now) / 60)} H`]
    : cl.approach ? ['tc-ok', 'CLEARED TO APPROACH']
    : leaving ? ['tc-ok', 'OUTBOUND']
    : tc.zone === 'control' ? ['', 'NO CLEARANCE'] : ['tc-bad', 'NO CLEARANCE'];
  const owed = finesOwed(state, st.faction).reduce((a, f) => a + f.amount, 0);
  const holdingThere = state.flight.hold?.kind === 'slot' && state.flight.hold.id === st.id;
  const toSlot = cl.hold && !holdingThere && !state.autopilot && !state.dock;
  const needHail = !leaving && !holdingThere && (tc.zone !== 'docked' ? !cl.dock && !cl.hold : !cl.depart);
  // (docked or docking there, the nav chip beside it names the station: this is just its traffic control)
  const ours = state.dock?.target.id === st.id;
  const html = `<span class="tc-zone">${ours ? 'TRAFFIC' : `${st.name.toUpperCase()} · ${ZONE_LABEL[tc.zone] || ''}`}</span><span class="${status[0]}">${status[1]}</span>${owed ? `<span class="tc-warn">${owed.toLocaleString()} MCR OWED</span>` : ''}${cl.dock && !state.dock ? `<button data-dock="${st.id}" title="The docking computer takes us down to our berth">DOCK ${esc(cl.dock.berth)}</button>` : ''}${toSlot ? `<button data-slot="${esc(cl.hold.slot)}" data-station="${st.id}" title="Plot a route into our holding slot">TO SLOT ${esc(cl.hold.slot)}</button>` : ''}${needHail ? `<button data-hail="${st.id}">HAIL</button>` : ''}`;
  setHTML(el.tc, html);
  show(el.tc, true, 'flex');
}

function turningLabel(state) {
  if (Math.abs(state.flight.turning) < 0.2) return null;
  return state.autopilot?.display === 'flip' || state.flight.manual?.flipTo != null ? 'FLIPPING' : 'TURNING';
}

// ---- PER-FRAME ----

export function updateHud(state) {
  setText(el.date, formatDate(state.clock));
  setText(el.time, formatTime(state.clock));
  setText(el.ship, ourName(state));
  // The flag we fly and our rank (or what is wrong with our papers)
  const fc = flagChip(state);
  const key = fc ? `${fc.text}|${fc.cls}` : '';
  if (el.flag.dataset.key !== key) {
    el.flag.dataset.key = key;
    show(el.flag, !!fc);
    if (fc) { el.flag.textContent = fc.text; el.flag.className = `hud-flag-chip ${fc.cls}`; el.flag.style.setProperty('--fc', fc.color || ''); }
  }
  const ns = navStatus(state);
  setText(el.chip, ns.chip);
  if (el.chip.title !== ns.chip) el.chip.title = ns.chip;     // (the whole of it, when the bar cuts it short)
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
  if (el.suits) {
    const aboard = state.ship.crew.filter(m => !m.dead && !m.away).length;
    toggleClass(el.suits, 'active', !!state.suitsOn);
    setText(el.suitsStatus, state.suitsOn ? `${suitedCount(state)}/${aboard}` : 'OFF');
  }
  show(el.station, !!dockedStation(state));
  updateTcChip(state);
  toggleClass(el.comms, 'has-requests', state.comms.requests.length > 0);

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
  setText(el.cargo, `${fmtMass(cargoKg)} / ${fmtMass(state.cargoCapacity)}${aboardLabel(state)}`);

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
    el.space.className = `rail-space ${zone ? 'space-hot' : ctl.lawless ? 'space-lawless' : ctl.contested ? 'space-contested' : ''}`;
  }
  const th = threatSummary(state);
  const hostiles = hostilesOfPlayer(state).length;
  const show_ = !!th || hostiles > 0;
  show(el.threat, show_);
  if (!show_) return;
  // (an annunciator on the rail: what, over how soon or how many)
  setHTML(el.threat, th
    ? `<span class="ann-label">${th.count} ${th.nuke ? 'NUKE' : 'TORP'}${th.count > 1 ? 'S' : ''} INBOUND<br>${isFinite(th.eta) ? `${formatDuration(th.eta / 60)} OUT` : 'CLOSING'}</span>`
    : `<span class="ann-label">${hostiles} HOSTILE<br>CONTACT${hostiles > 1 ? 'S' : ''}</span>`);
  toggleClass(el.threat, 'urgent', !!th && th.eta < 30 * 60);
}

// ---- SYSTEMS ----

let stripAt = 0;
function updateSystemsStrip(state) {
  const units = state.systems.units;
  const ids = shipSystems(state);
  const faults = ids.filter(id => units[id].status !== Status.NOMINAL).length;
  setText(el.sysCount, faults ? faults : '');
  toggleClass(el.sysCount, 'has-faults', faults > 0);
  toggleClass(el.sysCount, 'has-critical', ids.some(id => units[id].status === Status.FAILED));
  const now = performance.now();
  if (now - stripAt < 500) return;
  stripAt = now;
  setHTML(el.strip, systemsStripHTML(state));
}

// ---- RESOURCES ----

const RES = [
  { key: 'fuel', name: 'Fuel', icon: iconFuel, bar: 'bar-fuel', fmt: (r) => `${fmtNum(r.current)} kg` },
  // (O2, N2: the panel's pixel font has no subscript ₂)
  { key: 'o2Tank', name: 'O2', icon: iconOxygen, bar: 'bar-oxygen', fmt: (r, s) => `${fmtNum(r.current)} kg · ${hours(s.lifeSupport.oxygenHours)}` },
  { key: 'n2Tank', name: 'N2', icon: iconN2, bar: 'bar-n2', fmt: (r) => `${fmtNum(r.current)} kg` },
  { key: 'water', name: 'Water', icon: iconWater, bar: 'bar-water', fmt: (r, s) => `${fmtNum(r.current)} L · ${days(r.current, s, WATER_GROSS * (1 - waterRecovery(s)))}` },
  { key: 'food', name: 'Rations', icon: iconFood, bar: 'bar-food', fmt: (r, s) => `${fmtNum(r.current)} · ${days(r.current, s, 0.001)}` },
  { key: 'power', name: 'Power', icon: iconPower, bar: 'bar-power', fmt: (r) => `${Math.round(r.current)}%` },
  { key: 'medSupplies', name: 'Medical', icon: iconMedical, bar: 'bar-medical', fmt: (r) => r.current.toFixed(1) },
  { key: 'parts', name: 'Spare parts', icon: iconParts, bar: 'bar-parts', fmt: (r, s) => `${r.current.toFixed(1)} · scrap ${s.resources.scrap.current.toFixed(1)}`,
    level: (r) => r.current < 2 ? 'critical' : r.current < 5 ? 'warning' : 'ok' },
  { key: 'pdcRounds', name: 'PDC rounds', icon: iconParts, bar: 'bar-ammo', fmt: (r, s) => `${fmtNum(r.current)} · torps ${s.magazine.he} HE ${s.magazine.nuke} NUKE` },
  // (a drone out is counted with the rack: it is ours until a burn leaves it)
  { key: 'drones', name: 'Drones', icon: iconParts, bar: 'bar-parts', fmt: (r, s) => `${r.current}/${r.max}${s.drone ? ' · one out' : ''}`, level: () => 'ok' },
];
// Gross water per person per minute (drinking, galley, a shower a day) — reclamation recovers most of it
const WATER_GROSS = 0.004 + 12 / 1440;

function hours(h) { return !isFinite(h) ? '—' : h > 72 ? `${Math.round(h / 24)}d` : `${Math.round(h)}h`; }
function days(amount, s, perMin) {
  const mouths = s.ship.crew.filter(m => !m.dead).length + s.passengers.reduce((a, p) => a + p.count, 0);
  if (!mouths || perMin <= 0) return '—';
  const min = amount / (mouths * perMin);
  return min > 30 * 1440 ? `${Math.round(min / 1440)}d` : formatDuration(min);     // (a month out, hours don't matter)
}

const resEls = {};
const WIDE = new Set(['parts', 'pdcRounds']);     // (their lines say two things: a whole row in the panel)
const lastLevel = {};

function initResources() {
  const list = $('#resource-list');
  list.innerHTML = '';
  const row = (id, name, iconFn, bar) => {
    const item = document.createElement('div');
    item.className = `resource-item${WIDE.has(id) ? ' resource-wide' : ''}`;
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
/** Who else is aboard, for the readouts: passengers (pax) and prisoners (held), each counted apart. */
function aboardLabel(state) {
  let pax = 0, held = 0;
  for (const p of state.passengers) { if (p.kind === 'prisoners') held += p.count; else pax += p.count; }
  return `${pax ? ` · ${pax} pax` : ''}${held ? ` · ${held} held` : ''}`;
}

export let onResourceAlert = () => {};
export function setResourceAlertHandler(fn) { onResourceAlert = fn; }

function updateResources(state) {
  const alive = state.ship.crew.filter(m => !m.dead).length;
  setText(resEls.crew.val, `${alive} / ${state.ship.crew.length}${aboardLabel(state)}`);
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
  // amber: the nav computer is maneuvering and someone is still on their feet
  toggleClass(el.alert, 'maneuver', !critical && !!state.$maneuverAlert);
}

export function resetResourceAlerts() {
  for (const k of Object.keys(lastLevel)) delete lastLevel[k];
}

