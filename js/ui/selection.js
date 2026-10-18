// ============================================================
// LONGHAUL — Selection panel (crew member or ship console)
// Re-rendered a few times a second; buttons use delegated handlers
// so refreshes never eat clicks.
// ============================================================

import { ui } from './context.js';
import { $, esc, setHTML, setText, fmtNum, fmtSpeed, fmtMass } from './dom.js';
import { toast } from './toast.js';
import { logEntry } from './log.js';
import { G0, MIN_S } from '../core/constants.js';
import { TileType, TILE_NAMES, TILE_DESCRIPTIONS } from '../sim/tiles.js';
import { overallHealth, isConscious, CONDITION_LABELS } from '../sim/crew.js';
import { orderHeal, orderStandDown } from '../sim/crew-ai.js';
import { shipGeometry } from '../sim/ship-layout.js';
import { atmoStatus, equipmentLabel, toggleLS, setVented, setBreach, suitsOnDeck } from '../sim/life-support.js';
import { reactorStatusText, ReactorState, orderShutdown, cancelShutdown, orderStartup, orderPatch, emergencyShutoff, cancelEmergencyShutoff, immediateShutoff, triggerContainmentFailure, MIN_ENGINEERING, STARTUP_MIN_FUEL } from '../sim/reactor.js';
import { toggleTransponder, toggleSOS, signalBars } from '../sim/comms.js';
import { getWorld } from '../sim/world.js';
import { FUEL_PER_G_MIN } from '../sim/flight.js';

let hooks = {};

export function initSelection(h) {
  hooks = h;   // { hail(id), openNav(tab) }
  $('#crew-info').addEventListener('click', onClick);
}

export function selectCrew(id) {
  ui.selection.crew = id;
  ui.selection.tile = null;
  renderSelection(true);
}

export function selectTile(tile, deck, x, y) {
  ui.selection.tile = { tile, deck, x, y };
  ui.selection.crew = null;
  renderSelection(true);
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
  if (ui.selection.crew != null) {
    const m = s.ship.crew.find(c => c.id === ui.selection.crew);
    setText($('#selection-title'), 'Crew Member');
    if (m) setHTML(box, crewHTML(s, m));
  } else if (ui.selection.tile) {
    setText($('#selection-title'), 'Ship System');
    setHTML(box, tileHTML(s, ui.selection.tile));
  } else {
    setText($('#selection-title'), 'Selection');
    setHTML(box, '<p class="info-line info-dim">Click a crew member or a console</p>');
  }
}

// ---- CREW ----

const ACTIVITY = {
  idle: 'Standing watch', patrol: 'On patrol', securing: 'Heading to a crash couch', secured: 'Strapped in',
  suiting: 'Donning EVA suit', 'to-medbay': 'Walking to the autodoc', waiting: 'Waiting for the autodoc', healing: 'In the autodoc',
  rescuing: 'Running to a downed crewmate', 'first-aid': 'Administering first aid', carrying: 'Carrying a casualty to the autodoc',
  repairing: 'Repairing life support', 'to-reactor': 'Heading to the reactor', 'reactor-work': 'Working the reactor',
  carried: 'Being carried', down: 'Down', dead: 'Deceased',
};

function crewHTML(s, m) {
  const b = m.body, h = m.heart;
  const hc = (v) => v >= 70 ? 'var(--ok)' : v >= 40 ? 'var(--warning)' : 'var(--danger)';
  const bc = (v) => v >= 70 ? 'ok' : v >= 40 ? 'warning' : 'danger';
  const beat = h.bpm > 0 ? Math.max(0.5, 91.7 / h.bpm) : 0;
  const conds = [...m.conditions];
  if (m.juiced) conds.unshift('juiced');
  const condHtml = conds.length ? conds.map(c => {
    if (c === 'juiced') return `<span class="crew-condition crew-condition-juice">${m.juiceDose === 'high' ? 'HIGH-DOSE JUICE' : 'JUICED'}</span>`;
    if (c === 'juice-hangover') return `<span class="crew-condition crew-condition-hangover">HANGOVER ${Math.ceil(m.juiceHangover / 60)}h</span>`;
    const sev = ['dead', 'crushed', 'unconscious', 'decompression', 'internal-bleeding'].includes(c) ? 'danger'
      : c === 'critical' ? 'critical'
      : ['brain-damage', 'cardiac-stress', 'injured', 'hypoxic', 'hypercapnia', 'fracture', 'dehydrated', 'starving'].includes(c) ? 'warning' : 'dim';
    return `<span class="crew-condition crew-condition-${sev}">${CONDITION_LABELS[c] || c.toUpperCase()}</span>`;
  }).join('') : '<span class="crew-condition crew-condition-ok">NOMINAL</span>';
  const skills = ['piloting', 'security', 'engineering', 'medical'].map(k =>
    `<div class="crew-skill"><span class="crew-skill-label">${k.slice(0, 3).toUpperCase()}</span><div class="crew-skill-bar"><div class="crew-skill-fill" style="width:${m.skills[k]}%"></div></div><span class="crew-skill-val">${m.skills[k]}</span></div>`).join('');
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
  return `<div class="crew-detail-name">${esc(m.name)}</div>
    <div class="crew-detail-role">${esc(m.role)} · ${esc(deck?.name || '')}</div>
    <div class="crew-activity">${esc(ACTIVITY[m.activity] || m.activity)}</div>
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
    <div class="crew-section-label">SKILLS</div>
    ${skills}
    ${m.suit.wearing ? `<div class="crew-location-tag crew-location-suit">EVA suit · ${m.suit.o2.toFixed(1)}h O₂</div>` : ''}
    ${actions}`;
}

// ---- TILES ----

function tileHTML(s, sel) {
  const { tile, deck: di } = sel;
  const deck = s.ship.decks[di];
  const atmo = deck.atmosphere;
  const st = atmoStatus(atmo);
  const geo = shipGeometry(s.ship);
  const fid = (kind) => `${kind}:${di}:${sel.x}:${sel.y}`;
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
    case TileType.LIFE_SUPPORT: {
      const eq = s.lifeSupport.equipment[di];
      lines.push(equipmentLabel(eq));
      const job = s.jobs.list.find(j => j.type === 'repair-ls' && j.data.deck === di);
      if (job) lines.push(job.assignee != null ? `Repair: ${s.ship.crew.find(c => c.id === job.assignee)?.name} working` : 'Repair queued — waiting for an engineer');
      lines.push(`O₂ tank ${fmtNum(s.resources.o2Tank.current)} kg · N₂ tank ${fmtNum(s.resources.n2Tank.current)} kg`);
      if (eq) actions.push(btn('ls-toggle', eq.enabled ? 'DISABLE LIFE SUPPORT' : 'ENABLE LIFE SUPPORT', eq.enabled ? 'crew-action-cancel' : 'crew-action-recover'));
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
    case TileType.NAV_CONSOLE:
      lines.push(s.autopilot ? `Autopilot engaged` : 'Standing by');
      actions.push(btn('open-nav', 'OPEN NAVIGATION'));
      break;
    case TileType.STORAGE: {
      const load = s.cargo.reduce((a, c) => a + c.mass, 0);
      lines.push(`Hold ${fmtMass(load)} / ${fmtMass(s.cargoCapacity)}`);
      for (const c of s.cargo) lines.push(`· ${fmtMass(c.mass)} ${c.name}`);
      break;
    }
    case TileType.AIRLOCK:
      lines.push(s.flight.hold ? 'Cycled for docking' : 'Sealed');
      break;
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
    <p class="tile-detail-desc">${esc(TILE_DESCRIPTIONS[tile] || '')}</p>
    ${lines.length ? `<div class="tile-detail-status"><span class="tile-status-label">STATUS</span>${lines.map(l => `<span class="tile-status-value">${esc(l)}</span>`).join('')}</div>` : ''}
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
  const sel = ui.selection.tile;
  const m = ui.selection.crew != null ? s.ship.crew.find(c => c.id === ui.selection.crew) : null;
  const report = (r) => { toast(r.message, r.success ? 'ok' : 'danger'); if (r.success) logEntry(r.message, 'system'); };
  switch (act) {
    case 'heal': if (m && orderHeal(s, m)) { toast(`${m.name} → autodoc`, 'info'); logEntry(`${m.name} ordered to the autodoc`, 'crew'); } break;
    case 'stand-down': if (m) { orderStandDown(s, m); toast(`${m.name} standing down`); } break;
    case 'r-shutdown': report(orderShutdown(s)); break;
    case 'r-cancel': report(cancelShutdown(s)); break;
    case 'r-emergency': report(emergencyShutoff(s)); break;
    case 'r-cancel-emergency': report(cancelEmergencyShutoff(s)); break;
    case 'r-immediate': report(immediateShutoff(s)); break;
    case 'r-startup': report(orderStartup(s)); break;
    case 'r-patch': report(orderPatch(s)); break;
    case 'r-fail': if (triggerContainmentFailure(s)) { toast('CONTAINMENT FAILURE', 'danger'); logEntry('Reactor containment failure! 90 minutes to supercritical', 'danger'); } break;
    case 'ls-toggle': {
      const on = toggleLS(s, sel.deck);
      toast(`Life support ${on ? 'enabled' : 'DISABLED'}`, on ? 'ok' : 'danger');
      logEntry(`Life support ${on ? 'enabled' : 'manually disabled'} (${s.ship.decks[sel.deck].name})`, on ? 'system' : 'danger');
      break;
    }
    case 'sos': { const on = toggleSOS(s); toast(on ? 'SOS BROADCASTING' : 'SOS cancelled', on ? 'danger' : 'ok'); logEntry(on ? 'Distress beacon activated' : 'Distress beacon cancelled', on ? 'danger' : 'system'); break; }
    case 'transponder': { const on = toggleTransponder(s); toast(on ? 'Transponder active' : 'Transponder silenced', on ? 'ok' : 'warn'); logEntry(on ? 'Transponder broadcasting' : 'Transponder silenced — running dark', on ? 'system' : 'warn'); break; }
    case 'hail': hooks.hail(b.dataset.id); break;
    case 'open-nav': hooks.openNav('solar'); break;
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
  const items = [`<div class="ctx-header">${esc(d.name.toUpperCase())}</div>`, `<div class="ctx-info">${a.pressure.toFixed(1)} kPa · O₂ ${a.o2Pct.toFixed(1)}%</div>`];
  if (a.vented) items.push('<div class="ctx-item" data-ctx="repress">Close vents — repressurize</div>');
  else if (!a.breached) items.push('<div class="ctx-item ctx-danger" data-ctx="vent">Vent compartment to space</div>');
  if (a.breached) items.push('<div class="ctx-info ctx-breach">HULL BREACH</div>', '<div class="ctx-item" data-ctx="seal">Seal breach (patch kit)</div>');
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
