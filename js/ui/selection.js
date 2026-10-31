// ============================================================
// LONGHAUL — The CONTEXT panel's crew and machine card
// A crew member or a machine, picked on a room camera (cams.js), and a
// compartment's own menu (vent it, seal it: right-click its camera).
// Re-rendered a few times a second; buttons use delegated handlers
// so refreshes never eat clicks.
// ============================================================

import { ui } from './context.js';
import { $, esc, setHTML, setText, fmtNum, fmtSpeed, fmtMass } from './dom.js';
import { toast } from './toast.js';
import { bus } from '../core/events.js';
import { logEntry } from './log.js';
import { G0, MIN_S } from '../core/constants.js';
import { TileType, TILE_NAMES, TILE_DESCRIPTIONS } from '../sim/tiles.js';
import { tileEntry } from './library.js';
import { overallHealth, isConscious, lastingWound, CONDITION_LABELS } from '../sim/crew.js';
import { orderHeal, orderStandDown } from '../sim/crew-ai.js';
import { shipGeometry, FIXTURE_KIND, seatKind } from '../sim/ship-layout.js';
import { atmoStatus, setVented, setBreach, suitsOnDeck } from '../sim/life-support.js';
import { FIRE } from '../sim/fire.js';
import { JobType } from '../sim/jobs.js';
import { SYSTEM_BY_FIXTURE, systemPerf, waterRecovery, sensorRangeFactor, flightComputerState } from '../sim/systems.js';
import { STATIONS, SHIFTS, scheduleBlock, minutesLeftInBlock } from '../sim/duty.js';
import { NEEDS, NEED_LABEL, efficiency } from '../sim/needs.js';
import { rankTitle, fullName, ageOf, wageOf, promotionDue, promote, grantRetirement, askToStay, serviceOf, RANK_XP, YEAR_MIN, CABIN_FEVER_DAYS } from '../sim/careers.js';
import { formatDuration } from '../core/clock.js';
import { describeActivity, systemCardHTML, handleSystemAction } from './shipboard.js';
import { reactorStatusText, ReactorState, orderShutdown, cancelShutdown, orderStartup, orderPatch, emergencyShutoff, cancelEmergencyShutoff, immediateShutoff, triggerContainmentFailure, MIN_ENGINEERING, STARTUP_MIN_FUEL } from '../sim/reactor.js';
import { toggleTransponder, toggleSOS, signalBars } from '../sim/comms.js';
import { getWorld } from '../sim/world.js';
import { FUEL_PER_G_MIN } from '../sim/flight.js';

let hooks = {};

export function initSelection(h) {
  hooks = h;   // { hail(id), openNav(tab), showPanel(id) }
  $('#crew-info').addEventListener('click', onClick);
}

export function selectCrew(id) {
  ui.selection.crew = id;
  ui.selection.tile = null;
  renderSelection(true);
  hooks.showPanel?.('context');
}

export function selectTile(tile, deck, x, y) {
  ui.selection.tile = { tile, deck, x, y };
  ui.selection.crew = null;
  renderSelection(true);
  hooks.showPanel?.('context');
}

export function clearSelection() {
  ui.selection.crew = null;
  ui.selection.tile = null;
  renderSelection(true);
}

let lastRender = 0;
export function renderSelection(force = false) {
  const s = ui.state;
  if (!s) return;
  const now = performance.now();
  if (!force && now - lastRender < 250) return;
  lastRender = now;
  const box = $('#crew-info');
  const wrap = $('#ctx-selection');
  if (ui.selection.crew != null) {
    const m = s.ship.crew.find(c => c.id === ui.selection.crew);
    setText($('#selection-title'), 'CREW');
    if (m) setHTML(box, crewHTML(s, m));
  } else if (ui.selection.tile) {
    setText($('#selection-title'), 'ABOARD');
    setHTML(box, tileHTML(s, ui.selection.tile));
  } else {
    setText($('#selection-title'), 'SELECTION');
    setHTML(box, '<p class="info-line info-dim">Nothing selected. Click something on the display, or a crew member or a machine on a room camera.</p>');
  }
  // (with something picked on the display and nobody aboard, the display's pick has the panel to itself,
  // when the display has something to say about it)
  const navCard = ['#map-selection', '#scanner-detail'].some(id => { const el = $(id); return el && el.style.display !== 'none' && el.innerHTML; });
  if (wrap) wrap.style.display = ui.selection.crew == null && !ui.selection.tile && ui.nav.target && navCard ? 'none' : '';
}

// ---- CREW ----

function crewHTML(s, m) {
  const b = m.body, h = m.heart;
  const hc = (v) => v >= 70 ? 'var(--ok)' : v >= 40 ? 'var(--warning)' : 'var(--danger)';
  const bc = (v) => v >= 70 ? 'ok' : v >= 40 ? 'warning' : 'danger';
  const beat = h.bpm > 0 ? Math.max(0.5, 91.7 / h.bpm) : 0;
  const conds = [...m.conditions];
  if (m.juiced) conds.unshift('juiced');
  if (lastingWound(m)) conds.push(m.stabilized ? 'stabilized' : 'worsening');
  const condHtml = conds.length ? conds.map(c => {
    if (c === 'stabilized') return '<span class="crew-condition crew-condition-dim">STABILIZED · NEEDS A HOSPITAL</span>';
    if (c === 'worsening') return '<span class="crew-condition crew-condition-danger">WORSENING · GET THEM TO THE AUTODOC</span>';
    if (c === 'juiced') return `<span class="crew-condition crew-condition-juice">${m.juiceDose === 'high' ? 'HIGH-DOSE JUICE' : 'JUICED'}</span>`;
    if (c === 'juice-hangover') return `<span class="crew-condition crew-condition-hangover">${m.juiceCrash ? 'JUICE CRASH' : 'HANGOVER'} ${Math.ceil(m.juiceHangover / 60)}h</span>`;
    const sev = ['dead', 'crushed', 'unconscious', 'decompression', 'internal-bleeding', 'severe-burns', 'deep-trauma'].includes(c) ? 'danger'
      : c === 'critical' ? 'critical'
      : ['brain-damage', 'cardiac-stress', 'injured', 'hypoxic', 'hypercapnia', 'fracture', 'dehydrated', 'starving', 'burned'].includes(c) ? 'warning' : 'dim';
    return `<span class="crew-condition crew-condition-${sev}">${CONDITION_LABELS[c] || c.toUpperCase()}</span>`;
  }).join('') : '<span class="crew-condition crew-condition-ok">NOMINAL</span>';
  const skills = ['piloting', 'security', 'engineering', 'medical'].map(k =>
    `<div class="crew-skill"><span class="crew-skill-label">${k.slice(0, 3).toUpperCase()}</span><div class="crew-skill-bar"><div class="crew-skill-fill" style="width:${Math.round(m.skills[k])}%"></div></div><span class="crew-skill-val">${Math.floor(m.skills[k])}</span></div>`).join('');
  const geo = shipGeometry(s.ship);
  const deck = s.ship.decks[geo.deckOfRow(m.pos.sy)];
  const part = (cls, name, v, icon) => `<div class="crew-body-part ${cls} ${bc(v)}" title="${name}: ${Math.round(v)}%">${icon ? '<span class="crew-body-icon">&#9673;</span>' : `<span class="crew-body-val">${Math.round(v)}</span>`}</div>`;
  const overall = overallHealth(m);
  let actions = '';
  if (!m.dead) {
    const btns = [];
    if (isConscious(m) && m.task?.type !== 'heal' && overall < 100) btns.push('<button class="crew-action-btn crew-action-recover" data-act="heal">SEND TO AUTODOC</button>');
    if (isConscious(m) && (m.task || m.seat) && m.task?.type !== 'carried') btns.push('<button class="crew-action-btn crew-action-cancel" data-act="stand-down">STAND DOWN</button>');
    if (btns.length) actions = `<div class="crew-actions">${btns.join('')}</div>`;
  }
  const block = scheduleBlock(s, m);
  const st = STATIONS[m.duty.station];
  const dutyLine = m.dead ? '' : `<div class="crew-duty"><span class="crew-duty-station">${esc(st ? st.label : 'No station')} · ${SHIFTS[m.duty.shift].label}</span>
    <span class="duty-now duty-${block}">${block === 'duty' ? 'ON WATCH' : block === 'sleep' ? 'SLEEP' : 'OFF WATCH'} · ${formatDuration(minutesLeftInBlock(s, m))}</span></div>`;
  const needs = m.dead ? '' : `<div class="crew-section-label">NEEDS <span class="crew-eff">EFFICIENCY ${Math.round(efficiency(m) * 100)}%</span></div>` +
    NEEDS.map(k => `<div class="crew-stat"><span class="crew-stat-label">${NEED_LABEL[k]}</span><div class="crew-stat-bar"><div class="crew-stat-fill need-fill${m.needs[k] < 20 ? ' need-low' : m.needs[k] < 45 ? ' need-mid' : ''}" style="width:${Math.round(m.needs[k])}%"></div></div></div>`).join('');
  const rank = m.born != null && m.role !== 'Captain' && !rankTitle(m).includes(m.role) ? `${rankTitle(m)} · ` : '';
  return `<div class="crew-detail-name">${esc(fullName(m))}</div>
    <div class="crew-detail-role">${esc(rank)}${esc(m.role)} · ${esc(m.lost ? `lost with ${m.lost}` : deck?.name || '')}</div>
    <div class="crew-activity">${esc(describeActivity(m))}</div>
    ${dutyLine}
    <div class="crew-section-label">CONDITION</div>
    <div class="crew-conditions">${condHtml}</div>
    <div class="crew-section-label">VITALS</div>
    <div class="crew-vitals-row">
      <div class="crew-heart-container">
        <svg class="crew-heartbeat" viewBox="0 0 48 20" width="48" height="20"><polyline class="crew-heartbeat-line${m.dead ? ' flatline' : ''}" style="${beat ? `animation-duration:${beat}s` : 'animation:none'}" points="${m.dead ? '0,10 48,10' : '0,10 8,10 12,10 15,2 18,18 21,6 24,14 27,10 32,10 40,10 48,10'}"/></svg>
        <span class="crew-heart-bpm${m.dead ? ' flatline' : ''}">${m.dead ? '---' : h.bpm}</span>
      </div>
      <div class="crew-vital-mini"><span class="crew-vital-label">Heart</span><span class="crew-vital-val" style="color:${hc(h.health)}">${Math.round(h.health)}%</span></div>
      <div class="crew-vital-mini"><span class="crew-vital-label">Mind</span><span class="crew-vital-val" style="color:${hc(m.consciousness)}">${Math.round(m.consciousness)}%</span></div>
      <div class="crew-vital-mini"><span class="crew-vital-label">BP</span><span class="crew-vital-val">${m.dead ? '---' : `${h.bpSystolic}/${h.bpDiastolic}`}</span></div>
    </div>
    <div class="crew-section-label">BODY</div>
    <div class="crew-body-diagram">
      <div class="crew-body-row">${part('crew-body-head', 'Head', b.head, true)}</div>
      <div class="crew-body-row crew-body-mid">${part('crew-body-arm', 'L. arm', b.leftArm)}${part('crew-body-torso', 'Torso', b.torso)}${part('crew-body-arm', 'R. arm', b.rightArm)}</div>
      <div class="crew-body-row crew-body-legs">${part('crew-body-leg', 'L. leg', b.leftLeg)}${part('crew-body-leg', 'R. leg', b.rightLeg)}</div>
    </div>
    <div class="crew-stat"><span class="crew-stat-label">Overall</span><div class="crew-stat-bar"><div class="crew-stat-fill health" style="width:${overall}%;background:${hc(overall)}"></div></div></div>
    <div class="crew-stat"><span class="crew-stat-label">Morale</span><div class="crew-stat-bar"><div class="crew-stat-fill morale" style="width:${Math.round(m.morale)}%"></div></div></div>
    ${needs}
    <div class="crew-section-label">SKILLS</div>
    ${skills}
    ${serviceHTML(s, m)}
    ${m.suit.wearing ? `<div class="crew-location-tag crew-location-suit">EVA suit · ${m.suit.o2.toFixed(1)}h O₂</div>` : ''}
    ${actions}`;
}

/** Their service (sim/careers.js): rank and the way to the next, age and home, pay, leave, what they ask of us, their record. */
function serviceHTML(s, m) {
  if (m.born == null) return '';
  const now = s.clock.minute, DAY = 1440;
  const age = Math.floor(ageOf(m, now));
  const years = serviceOf(m, now) / YEAR_MIN;
  const days = (n) => `${n} day${n === 1 ? '' : 's'}`;
  const served = years >= 1 ? `${Math.floor(years)} y ${Math.floor((years % 1) * 12)} mo aboard` : serviceOf(m, now) < DAY ? 'joined today' : `${days(Math.floor(serviceOf(m, now) / DAY))} aboard`;
  const rows = [`<div class="crew-service-line"><b>${esc(rankTitle(m))}</b> · ${age} · from ${esc(m.home === 'Belt' ? 'the Belt' : m.home === 'Jovian' ? 'the Jovian moons' : m.home === 'Saturnian' ? 'Titan' : m.home)} · ${served}</div>`];
  if (m.dead) return `<div class="crew-section-label">SERVICE</div>${rows.join('')}${recordHTML(m)}`;
  const due = promotionDue(m);
  if (m.role !== 'Captain' && (m.rank ?? 0) < 4) {
    const next = (m.rank ?? 0) + 1, from = RANK_XP[m.rank ?? 0], to = RANK_XP[next];
    const pct = Math.max(0, Math.min(100, ((m.xp || 0) - from) / (to - from) * 100));
    rows.push(`<div class="crew-stat" title="Experience: an hour of real work is a point, and more for what it brought"><span class="crew-stat-label">To next</span><div class="crew-stat-bar"><div class="crew-stat-fill xp-fill${due ? ' xp-due' : ''}" style="width:${Math.round(pct)}%"></div></div></div>`);
    if (!due && (m.xp || 0) >= to) rows.push('<div class="crew-service-note">The experience is there; the skill for the next step isn\'t yet.</div>');
  }
  const wage = wageOf(m);
  const pay = m.role === 'Captain' ? 'takes the ship\'s profit' : `${fmtNum(wage)} MCR a month${m.owed > 0 ? ` · <span class="tc-bad">owed ${fmtNum(m.owed)}</span>` : ''}`;
  const out = m.lastLeave != null ? Math.floor((now - m.lastLeave) / DAY) : 0;
  rows.push(`<div class="crew-service-line">${pay} · ashore ${out ? `${days(out)} ago` : 'today'}${out > CABIN_FEVER_DAYS ? ' <span class="tc-warn">(cabin fever)</span>' : ''}</div>`);
  const btns = [];
  if (due) btns.push(`<button class="crew-action-btn crew-action-recover" data-act="promote" title="${esc(due.title)}: ${fmtNum(due.wage)} MCR a month">PROMOTE · ${esc(due.title.toUpperCase())}</button>`);
  if (m.retire && !m.retire.granted) {
    rows.push(`<div class="crew-service-note">${m.retire.insist ? 'Has given the ship enough years: signs off at the next port.' : m.retire.refused != null ? 'Asked to retire; we asked them to stay on.' : 'Asks to sign off and retire at the next port.'}</div>`);
    if (!m.retire.insist) btns.push('<button class="crew-action-btn crew-action-recover" data-act="retire-grant">GRANT RETIREMENT</button>');
    if (!m.retire.insist && m.retire.refused == null) btns.push('<button class="crew-action-btn crew-action-cancel" data-act="retire-stay">ASK TO STAY</button>');
  } else if (m.retire?.granted) rows.push('<div class="crew-service-note">Retiring: signs off at the next port.</div>');
  if (m.quit) rows.push('<div class="crew-service-note tc-bad">Has had enough: means to sign off at the next port.</div>');
  return `<div class="crew-section-label">SERVICE</div>${rows.join('')}${btns.length ? `<div class="crew-actions">${btns.join('')}</div>` : ''}${recordHTML(m)}`;
}

/** The last few lines of their record. */
function recordHTML(m) {
  if (!m.record?.length) return '';
  return `<div class="crew-record">${m.record.slice(-4).reverse().map(r => `<div><span>${esc(dayOf(r.at))}</span> ${esc(r.text)}</div>`).join('')}</div>`;
}
const dayOf = (min) => `D${Math.floor(min / 1440) + 1}`;

// ---- TILES ----

function tileHTML(s, sel) {
  const { tile, deck: di } = sel;
  const deck = s.ship.decks[di];
  const atmo = deck.atmosphere;
  const st = atmoStatus(atmo);
  const geo = shipGeometry(s.ship);
  const fid = (kind) => `${kind}:${di}:${sel.x}:${sel.y}`;
  const on = (station) => { const id = s.$watch?.[station]; return id != null ? s.ship.crew.find(c => c.id === id) : null; };
  const sysId = SYSTEM_BY_FIXTURE[FIXTURE_KIND[tile]];
  const lines = [];
  const actions = [];
  const btn = (act, label, cls = 'crew-action-recover', extra = '') => `<button class="crew-action-btn ${cls}" data-act="${act}" ${extra}>${label}</button>`;

  switch (tile) {
    case TileType.REACTOR: {
      const r = s.reactor;
      lines.push(reactorStatusText(s));
      lines.push(`Power ${Math.round(s.resources.power.current)}% · fuel ${fmtNum(s.resources.fuel.current)} kg`);
      const engs = s.ship.crew.filter(m => isConscious(m) && m.skills.engineering >= MIN_ENGINEERING);
      if (!engs.length) lines.push(`No conscious crew with engineering ≥ ${MIN_ENGINEERING}`);
      if (r.status === ReactorState.ONLINE) actions.push(btn('r-shutdown', 'ORDER SHUTDOWN'), btn('r-emergency', '⚠ EMERGENCY SHUTOFF (1h)', 'crew-action-rescue'));
      if (r.status === ReactorState.SHUTTING_DOWN || r.status === ReactorState.SHUTDOWN_COUNTDOWN) actions.push(btn('r-cancel', 'CANCEL SHUTDOWN'));
      if (r.status === ReactorState.EMERGENCY_SHUTOFF) actions.push(btn('r-cancel-emergency', 'CANCEL EMERGENCY'), btn('r-immediate', '⚠ DUMP ALL FUEL NOW', 'crew-action-rescue'));
      if (r.status === ReactorState.OFFLINE && r.breach && r.work !== 'patch') actions.push(btn('r-patch', 'PATCH CONTAINMENT'));
      if (r.status === ReactorState.OFFLINE && !r.breach && r.work == null) actions.push(btn('r-startup', 'START REACTOR', 'crew-action-recover', s.resources.fuel.current < STARTUP_MIN_FUEL ? 'disabled' : ''));
      if (r.status === ReactorState.CONTAINMENT_FAILURE) actions.push(btn('r-shutdown', 'EMERGENCY SCRAM', 'crew-action-rescue'), btn('r-emergency', 'EMERGENCY SHUTOFF (1h)', 'crew-action-rescue'));
      if (ui.settings.devMode && r.status === ReactorState.ONLINE) actions.push(btn('r-fail', 'DEV: CONTAINMENT FAILURE', 'crew-action-cancel'));
      break;
    }
    case TileType.LIFE_SUPPORT:
      lines.push(`O₂ tank ${fmtNum(s.resources.o2Tank.current)} kg · N₂ tank ${fmtNum(s.resources.n2Tank.current)} kg`);
      break;
    case TileType.WATER_RECYCLER:
      lines.push(`Recovering ${Math.round(waterRecovery(s) * 100)}% · tanks ${fmtNum(s.resources.water.current)} L`);
      break;
    case TileType.GALLEY: {
      const cook = on('galley');
      lines.push(systemPerf(s, 'galley') === 0 ? 'Down — cold rations only' : cook ? `${cook.name} cooking — hot meals` : 'No cook on duty — self-serve');
      lines.push(`Rations ${fmtNum(s.resources.food.current)}`);
      break;
    }
    case TileType.WORKBENCH: {
      const who = on('workshop');
      lines.push(`Spares ${s.resources.parts.current.toFixed(1)} · scrap ${s.resources.scrap.current.toFixed(1)}`);
      lines.push(who ? `${who.name} on duty` : 'Nobody on the machine-shop watch');
      const fab = s.ship.crew.find(m => m.task?.kind === 'fabricate' && m.task.phase === 'work');
      if (fab) lines.push(`${fab.name} refurbishing a part — ${Math.min(99, Math.round(fab.task.progress / fab.task.need * 100))}%`);
      break;
    }
    case TileType.OPS_CONSOLE: {
      const who = on('ops');
      lines.push(who ? `${who.name} on watch — faster tracking, debris watch` : 'Unmanned');
      lines.push(`Sensor reach ${Math.round(sensorRangeFactor(s) * (who ? 125 : 100))}%`);
      break;
    }
    case TileType.ENG_CONSOLE: {
      const who = on('engineering');
      lines.push(who ? `${who.name} on watch — faults caught early` : 'Unmanned — faults bite harder');
      break;
    }
    case TileType.BUNK:
    case TileType.HEAD:
    case TileType.REC: {
      const p = s.ship.crew.find(m => m.seat === fid(FIXTURE_KIND[tile]));
      lines.push(p ? `${p.name} — ${describeActivity(p).toLowerCase()}` : 'Free');
      break;
    }
    case TileType.TABLE: {
      const here = s.ship.crew.filter(m => !m.dead && (m.activity === 'eating' || m.activity === 'socializing') && geo.deckOfRow(m.pos.sy) === di);
      lines.push(here.length ? here.map(m => `${m.name} ${m.activity === 'eating' ? 'eating' : 'chatting'}`).join(' · ') : 'Nobody at the table');
      break;
    }
    case TileType.RADIO: {
      lines.push(`${s.comms.radioTotal || s.comms.radio.length} contacts in radio range${s.comms.sos ? ' · SOS BROADCASTING' : ''}`);
      actions.push(btn('sos', s.comms.sos ? 'CANCEL SOS' : 'BROADCAST SOS', s.comms.sos ? 'crew-action-rescue' : 'crew-action-cancel'));
      const world = getWorld(s);
      const rows = s.comms.radio.slice(0, 12).map(id => {
        const e = world.get(id);
        if (!e) return '';
        const d = Math.hypot(e.pos.x - s.flight.pos.x, e.pos.y - s.flight.pos.y);
        const bars = signalBars(d);
        return `<div class="radio-contact-row"><span class="radio-contact-info">${esc(e.name)} ${e.sos ? '<span style="color:var(--danger)">[SOS]</span>' : ''}<br><span class="dim">${'■'.repeat(bars)}${'□'.repeat(5 - bars)} ${e.type === 'station' ? 'station' : esc(e.shipClass || 'ship')}</span></span><button class="radio-hail-btn" data-act="hail" data-id="${esc(id)}">HAIL</button></div>`;
      }).join('');
      if (rows) actions.push(`<div class="radio-list">${rows}</div>`);
      break;
    }
    case TileType.TRANSPONDER:
      lines.push(s.comms.transponder ? 'ACTIVE — broadcasting ship identity' : 'SILENT — identity masked');
      if (!s.comms.transponder && s.flight.thrustG > 0.02) lines.push('⚠ Drive plume visible — identifiable while burning');
      actions.push(btn('transponder', s.comms.transponder ? 'SILENCE TRANSPONDER' : 'ENABLE TRANSPONDER', s.comms.transponder ? 'crew-action-cancel' : 'crew-action-recover'));
      break;
    case TileType.ENGINE: {
      const f = s.flight;
      lines.push(f.thrustG > 0.02 ? `Burning ${f.thrustG.toFixed(2)}G` : 'Drive cold');
      const dvLeft = s.resources.fuel.current / FUEL_PER_G_MIN * MIN_S * G0;
      lines.push(`Reaction mass ${fmtNum(s.resources.fuel.current)} kg · Δv ≈ ${fmtSpeed(dvLeft)}`);
      lines.push(`Fuel burned this voyage ${fmtNum(s.stats.fuelBurned)} kg · peak ${s.stats.peakG.toFixed(1)}G`);
      break;
    }
    case TileType.MEDBAY: {
      const p = s.ship.crew.find(m => m.seat === fid('medbay'));
      lines.push(p ? `Treating ${p.name} — ${overallHealth(p)}% overall` : 'Autodoc ready');
      const waiting = s.ship.crew.filter(m => m.task?.type === 'heal' && !m.seat).map(m => m.name);
      if (waiting.length) lines.push(`Waiting: ${waiting.join(', ')}`);
      lines.push(`Medical supplies ${s.resources.medSupplies.current.toFixed(1)}`);
      break;
    }
    case TileType.CRASH_COUCH: {
      const p = s.ship.crew.find(m => m.seat === fid('couch'));
      lines.push(p ? `${p.name}${p.juiced ? ' — juiced' : ''}` : 'Empty');
      break;
    }
    case TileType.EVA_LOCKER: {
      const l = s.lifeSupport.lockers[fid('locker')];
      lines.push(l?.hasSuit ? 'EVA suit stowed (48h O₂)' : 'Empty — suit in use');
      break;
    }
    case TileType.NAV_CONSOLE: {
      const pilot = s.ship.crew.find(m => !m.dead && seatKind(m.seat) === 'helm');
      const fc = flightComputerState(s);
      lines.push(pilot ? `${pilot.name} at the helm${s.autopilot?.helm === 'manual' ? ' — FLYING BY HAND' : ''}` : 'Helm unmanned');
      lines.push(fc === 'failed' ? 'Flight computer DOWN — manual flight only' : s.autopilot ? 'Autopilot engaged' : 'Standing by');
      actions.push(btn('open-nav', 'OPEN NAVIGATION'));
      break;
    }
    case TileType.STORAGE: {
      const load = s.cargo.reduce((a, c) => a + c.mass, 0);
      lines.push(`Hold ${fmtMass(load)} / ${fmtMass(s.cargoCapacity)}`);
      for (const c of s.cargo) lines.push(`· ${fmtMass(c.mass)} ${c.name}`);
      break;
    }
    case TileType.AIRLOCK:
      lines.push(s.flight.hold ? 'Cycled for docking' : 'Sealed');
      break;
    case TileType.PDC_MOUNT:
      lines.push(`${fmtNum(s.resources.pdcRounds.current)} rounds · mode ${s.combat.pdc.toUpperCase()}`);
      actions.push(btn('open-combat', 'FIRE CONTROL'));
      break;
    case TileType.TORPEDO_LAUNCHER: {
      const M = s.magazine;
      lines.push(`Magazine ${M.he} HE · ${M.nuke} nuclear (${M.he + M.nuke}/${M.capacity})`);
      const now = s.clock.minute;
      lines.push(s.combat.tubes.map((t, i) => `Tube ${i + 1} ${t <= now ? 'loaded' : `cycling ${t - now} min`}`).join(' · '));
      actions.push(btn('open-combat', 'FIRE CONTROL'));
      break;
    }
    case TileType.WEAPONS_CONSOLE: {
      const who = s.ship.crew.find(c => isConscious(c) && seatKind(c.seat) === 'weapons');
      lines.push(who ? `${who.name} at fire control — PDCs laid by hand` : 'Unmanned — PDCs on automatic');
      actions.push(btn('open-combat', 'FIRE CONTROL'));
      break;
    }
    case TileType.TERMINAL:
    case TileType.CONSOLE: {
      const crewHere = s.ship.crew.filter(m => geo.deckOfRow(m.pos.sy) === di && !m.dead).map(m => m.name);
      lines.push(crewHere.length ? `On deck: ${crewHere.join(', ')}` : 'Nobody on this deck');
      break;
    }
  }

  const atmoCls = st === 'nominal' ? 'atmo-ok' : st === 'warning' ? 'atmo-warn' : 'atmo-danger';
  return `<div class="tile-detail-name">${esc(TILE_NAMES[tile] || 'Unknown')}</div>
    <div class="tile-detail-deck">${esc(deck.name.toUpperCase())}</div>
    <p class="tile-detail-desc">${esc(TILE_DESCRIPTIONS[tile] || '')}${TILE_DESCRIPTIONS[tile] ? ` <button class="lib-ref" data-lib="${tileEntry(tile)}">LIBRARY</button>` : ''}</p>
    ${lines.length ? `<div class="tile-detail-status"><span class="tile-status-label">STATUS</span>${lines.map(l => `<span class="tile-status-value">${esc(l)}</span>`).join('')}</div>` : ''}
    ${sysId ? systemCardHTML(s, sysId, { compact: true }) : ''}
    <div class="tile-detail-atmosphere"><span class="tile-status-label">COMPARTMENT — ${st.toUpperCase()}</span>
      <div class="atmo-readout ${atmoCls}"><span>${atmo.pressure.toFixed(1)} kPa</span><span>O₂ ${atmo.o2Pct.toFixed(1)}%</span><span>N₂ ${atmo.n2Pct.toFixed(1)}%</span><span>CO₂ ${atmo.co2Pct.toFixed(2)}%</span></div>
      <div class="atmo-meta">EVA suits on deck: ${suitsOnDeck(s, di)}</div></div>
    ${actions.length ? `<div class="tile-actions">${actions.join('')}</div>` : ''}`;
}

function onClick(e) {
  const b = e.target.closest('[data-act]');
  const s = ui.state;
  if (!b || !s) return;
  const act = b.dataset.act;
  const m = ui.selection.crew != null ? s.ship.crew.find(c => c.id === ui.selection.crew) : null;
  const report = (r) => { toast(r.message, r.success ? 'ok' : 'danger'); if (r.success) logEntry(r.message, 'system'); };
  switch (act) {
    case 'heal': if (m && orderHeal(s, m)) { toast(`${m.name} → autodoc`, 'info'); logEntry(`${m.name} ordered to the autodoc`, 'crew'); } break;
    case 'stand-down': if (m) { orderStandDown(s, m); toast(`${m.name} standing down`); } break;
    case 'promote': if (m) { const r = promote(s, m.id, (t, p) => bus.emit(t, p)); if (!r.ok) toast(r.text, 'danger'); } break;
    case 'retire-grant': if (m) { const r = grantRetirement(s, m.id); toast(r.text, r.ok ? 'ok' : 'danger'); if (r.ok) logEntry(r.text, 'crew'); } break;
    case 'retire-stay': if (m) { const r = askToStay(s, m.id); toast(r.text, r.ok ? 'info' : 'danger'); if (r.ok) logEntry(r.text, 'crew'); } break;
    case 'r-shutdown': report(orderShutdown(s)); break;
    case 'r-cancel': report(cancelShutdown(s)); break;
    case 'r-emergency': report(emergencyShutoff(s)); break;
    case 'r-cancel-emergency': report(cancelEmergencyShutoff(s)); break;
    case 'r-immediate': report(immediateShutoff(s)); break;
    case 'r-startup': report(orderStartup(s)); break;
    case 'r-patch': report(orderPatch(s)); break;
    case 'r-fail': if (triggerContainmentFailure(s)) { toast('CONTAINMENT FAILURE', 'danger'); logEntry('Reactor containment failure! 90 minutes to supercritical', 'danger'); } break;
    case 'sys-service': case 'sys-repair': case 'sys-toggle': handleSystemAction(act, b.dataset.sys); break;
    case 'sos': { const on = toggleSOS(s); toast(on ? 'SOS BROADCASTING' : 'SOS cancelled', on ? 'danger' : 'ok'); logEntry(on ? 'Distress beacon activated' : 'Distress beacon cancelled', on ? 'danger' : 'system'); break; }
    case 'transponder': { const on = toggleTransponder(s); toast(on ? 'Transponder active' : 'Transponder silenced', on ? 'ok' : 'warn'); logEntry(on ? 'Transponder broadcasting' : 'Transponder silenced — running dark', on ? 'system' : 'warn'); break; }
    case 'hail': hooks.hail(b.dataset.id); break;
    case 'open-nav': hooks.openNav('solar'); break;
    case 'open-combat': hooks.openNav('combat'); break;
  }
  renderSelection(true);
}

// ---- COMPARTMENT MENU ----

export function showDeckMenu(deck, x, y) {
  const s = ui.state;
  document.getElementById('compartment-menu')?.remove();
  const d = s.ship.decks[deck];
  const a = d.atmosphere;
  const menu = document.createElement('div');
  menu.id = 'compartment-menu';
  menu.className = 'compartment-context-menu';
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  const geo = shipGeometry(s.ship);
  const here = s.ship.crew.filter(m => !m.dead && !m.away && geo.deckOfRow(m.pos.sy) === deck);
  const bare = here.filter(m => !m.suit.wearing).length;
  const items = [`<div class="ctx-header">${esc(d.name.toUpperCase())}</div>`, `<div class="ctx-info">${a.pressure.toFixed(1)} kPa · O₂ ${a.o2Pct.toFixed(1)}% · ${here.length} aboard${bare ? `, ${bare} unsuited` : ''}</div>`];
  if (a.fire) items.push(`<div class="ctx-info ctx-fire">FIRE · ${Math.round(a.fire.intensity * 100)}% — fight it, or vent the deck: nothing burns under ${FIRE.OUT_KPA} kPa</div>`);
  if (a.vented) items.push('<div class="ctx-item" data-ctx="repress">Close vents — repressurize</div>');
  else if (!a.breached) items.push(`<div class="ctx-item ctx-danger" data-ctx="vent">${a.fire ? 'Vent to space to put the fire out' : 'Vent compartment to space'}${bare ? ` (${bare} on deck without a suit!)` : ''}</div>`);
  if (a.breached) {
    // the patch is an engineer's job in a suit (life-support.js breachJobs, top priority): who is on it
    const job = s.jobs.list.find(j => j.type === JobType.SEAL && j.data.deck === deck);
    const by = job?.assignee != null ? s.ship.crew.find(m => m.id === job.assignee) : null;
    items.push('<div class="ctx-info ctx-breach">HULL BREACH</div>', `<div class="ctx-info">${by ? `${esc(by.name)} is on the patch` : 'Patch job waiting for an engineer with a suit'}</div>`);
    if (ui.settings.devMode) items.push('<div class="ctx-item" data-ctx="seal">DEV: seal it now</div>');
  }
  if (ui.settings.devMode && !a.breached) items.push('<div class="ctx-item ctx-danger" data-ctx="breach">DEV: hull breach</div>');
  menu.innerHTML = items.join('');
  document.body.appendChild(menu);
  menu.addEventListener('click', (e) => {
    const act = e.target.dataset.ctx;
    if (act === 'vent') { setVented(s, deck, true); logEntry(`${d.name} vented to space`, 'danger'); toast(`${d.name} VENTING`, 'danger'); }
    if (act === 'repress') { setVented(s, deck, false); logEntry(`${d.name} vents closed — repressurizing`, 'system'); }
    if (act === 'seal') { setBreach(s, deck, false); logEntry(`${d.name} breach sealed`, 'ok'); }
    if (act === 'breach') { setBreach(s, deck, true); logEntry(`HULL BREACH — ${d.name}`, 'danger'); }
    menu.remove();
  });
  const close = (e) => { if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('pointerdown', close); } };
  setTimeout(() => document.addEventListener('pointerdown', close), 0);
}
