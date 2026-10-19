// ============================================================
// LONGHAUL — Dialogs
// Generic modal + missions log, jobs, hail, distress call, station.
// ============================================================

import { ui } from './context.js';
import { $, esc, show, fmtNum, fmtMeters, fmtMass, fmtRewards } from './dom.js';
import { toast } from './toast.js';
import { logEntry } from './log.js';
import { AU_M, AU_KM } from '../core/constants.js';
import { formatDuration } from '../core/clock.js';
import { getWorld } from '../sim/world.js';
import { hailDialogue, signalBars } from '../sim/comms.js';
import { activeMissions, acceptMission, declineMission, completeRescue, missionForEntity } from '../sim/missions.js';
import { contractsAt, acceptContract, completeContract, deliverable, dockedStation, hailContractTarget, abandonContract, serviceQuote, buy, buyOverhaul, overhaulQuote, buyTorpedo, torpedoRefusal, PRICES, CONTRACT_LABEL } from '../sim/contracts.js';
import { bus } from '../core/events.js';
import { jobLabel, describeActivity } from './shipboard.js';
import { canTransmit } from '../sim/comms.js';
import { respondToRequest } from '../sim/agents.js';
import { WARHEADS } from '../sim/weapons.js';
import { WANTED_LABEL } from '../sim/law.js';

let hooks = {};
let onClose = null;

export function initDialogs(h) {
  hooks = h;   // { plotRoute(target), setPaused(reason, on) }
  for (const id of ['#dialog-generic', '#dialog-event', '#dialog-station']) {
    $(id).addEventListener('pointerdown', (e) => { if (e.target === $(id) && id !== '#dialog-event') closeDialog(id); });
  }
  $('#dialog-generic').addEventListener('click', onGenericClick);
  $('#dialog-station').addEventListener('click', onStationClick);
  $('#dialog-event').addEventListener('click', onEventClick);
}

// ---- GENERIC ----

export function openDialog({ title, html, cls = '', buttons = [{ label: 'Close', act: 'close', cls: 'btn-primary' }], onAction = null, pause = false, close = null }) {
  const body = $('#dialog-generic-body');
  body.className = `dialog ${cls}`;
  body.innerHTML = `${title ? `<h3 class="dialog-title">${esc(title)}</h3>` : ''}<div class="dialog-content">${html}</div>
    <div class="form-actions">${buttons.map(b => `<button class="btn ${b.cls || 'btn-secondary'}" data-act="${b.act}">${esc(b.label)}</button>`).join('')}</div>`;
  body._onAction = onAction;
  onClose = close;
  if (pause) hooks.setPaused('dialog', true);
  body._paused = pause;
  show($('#dialog-generic'), true, 'flex');
  body.querySelector('input')?.focus();
  return body;
}

export function closeDialog(id = '#dialog-generic') {
  const el = $(id);
  if (el.style.display === 'none') return;
  show(el, false);
  if (id === '#dialog-generic') {
    const body = $('#dialog-generic-body');
    if (body._paused) hooks.setPaused('dialog', false);
    body._paused = false;
    onClose?.(); onClose = null;
  }
  if (id === '#dialog-event') {
    hooks.setPaused('distress', false);
    eventRequest = null;
    nextEvent();
  }
}

export function anyDialogOpen() {
  return ['#dialog-generic', '#dialog-event', '#dialog-station'].some(id => $(id).style.display !== 'none');
}

export function closeTopDialog() {
  for (const id of ['#dialog-generic', '#dialog-station', '#dialog-event']) {
    if ($(id).style.display !== 'none') { if (id === '#dialog-event') decline(); else closeDialog(id); return true; }
  }
  return false;
}

function onGenericClick(e) {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const body = $('#dialog-generic-body');
  if (b.dataset.act === 'close') { closeDialog(); return; }
  body._onAction?.(b.dataset.act, b, body);
}

// ---- MISSIONS LOG ----

export function openMissions() {
  const render = () => {
    const s = ui.state;
    const sos = s.missions.list.slice().reverse();
    const act = s.contracts.active;
    const hist = s.contracts.history.slice(-12).reverse();
    const timer = (min) => min >= 60 ? formatDuration(min) : `${Math.max(0, Math.round(min))} min`;
    const row = (id, title, status, cls, detail, timerTxt, actions) => `<div class="mission-row ${cls}">
      <div class="mission-row-header"><div class="mission-status-dot status-${status}"></div>
        <div class="mission-info"><div class="mission-title">${esc(title)}</div><div class="mission-meta">${esc(detail)}</div></div>
        <div class="mission-timer">${esc(timerTxt)}</div></div>
      ${actions ? `<div class="mission-actions">${actions}</div>` : ''}</div>`;
    const sosRows = sos.map(m => {
      const live = m.status === 'accepted' || m.status === 'offered';
      const routing = s.autopilot?.plan.target.id === m.entityId;
      const acts = live ? `${m.status === 'offered' ? `<button class="btn btn-primary btn-small" data-act="sos-accept" data-id="${m.id}">ACCEPT</button><button class="btn btn-secondary btn-small" data-act="sos-decline" data-id="${m.id}">DECLINE</button>` : ''}
        ${m.status === 'accepted' && !routing ? `<button class="btn btn-primary btn-small" data-act="plot" data-kind="entity" data-id="${m.entityId}">PLOT INTERCEPT</button>` : ''}` : '';
      const status = m.status === 'failed' ? `FAILED — ${m.failReason}` : m.status === 'lost' ? 'BEACON SILENT' : m.status.toUpperCase();
      return row(m.id, m.title, m.status === 'lost' ? 'declined' : m.status, live ? '' : 'mission-done', status, live ? timer(m.timer) : '', acts);
    }).join('');
    const cRows = act.map(c => {
      const target = c.phase === 'return' ? { id: c.station, label: `RETURN TO ${c.stationName}` }
        : c.type === 'ESCORT' && c.phase !== 'arrived' ? { id: c.targetId, label: 'TO CONVOY' }
        : c.dest ? { id: c.dest, label: `TO ${c.destName}` }
        : c.markId && (c.type === 'BOUNTY' || c.type === 'RECON') ? { id: c.markId, label: 'TO LAST POSITION' } : { id: c.targetId, label: 'TO TARGET' };
      const phase = c.phase === 'return' ? `Return to ${c.stationName}`
        : c.type === 'ESCORT' ? (c.phase === 'active' ? `Join the ${c.targetName} (within 10 km)` : c.phase === 'underway' ? `Escorting to ${c.destName}` : `Dock at ${c.destName}`)
        : c.type === 'RECON' ? `Lock the picket inside 300,000 km — ${Math.round(c.scanned / c.scanMin * 100)}%`
        : c.type === 'BOUNTY' ? `Find the ${c.targetName}: destroy it, or disable it and accept its surrender`
        : c.dest ? `Deliver at ${c.destName}` :
        c.type === 'SURVEY' ? `Survey ${Math.round(c.scanned / c.scanMin * 100)}%` : c.type === 'SALVAGE' && c.worked ? `Salvage ${Math.round(c.worked / c.workMin * 100)}%` : 'Proceed to target';
      return row(c.id, c.title, 'accepted', '', `${CONTRACT_LABEL[c.type]} · ${phase}`, timer(c.dueAt - s.clock.minute),
        `<button class="btn btn-primary btn-small" data-act="plot" data-kind="entity" data-id="${target.id}">PLOT ${esc(target.label)}</button>
         <button class="btn btn-secondary btn-small" data-act="abandon" data-id="${c.id}">ABANDON</button>`);
    }).join('');
    const hRows = hist.map(c => row(c.id, c.title, c.phase === 'complete' ? 'completed' : 'failed', 'mission-done', c.phase === 'complete' ? 'COMPLETE' : `FAILED — ${c.failReason}`, '', '')).join('');
    return `<div class="missions-list">
      <div class="missions-section">DISTRESS CALLS</div>${sosRows || '<p class="missions-empty">— none —</p>'}
      <div class="missions-section">CONTRACTS</div>${cRows || '<p class="missions-empty">— none — hail a station to see its board</p>'}
      ${hRows ? `<div class="missions-section">COMPLETED / FAILED</div>${hRows}` : ''}</div>`;
  };
  const body = openDialog({
    title: 'Mission Log', cls: 'dialog-missions', html: render(),
    onAction: (act, b) => {
      const s = ui.state;
      if (act === 'sos-accept') { acceptMission(s, b.dataset.id); logEntry('Distress call answered', 'nav'); }
      if (act === 'sos-decline') declineMission(s, b.dataset.id);
      if (act === 'abandon') { abandonContract(s, b.dataset.id, (t, p) => bus.emit(t, p)); }
      if (act === 'plot') { closeDialog(); hooks.plotRoute({ kind: b.dataset.kind, id: b.dataset.id }); return; }
      body.querySelector('.dialog-content').innerHTML = render();
    },
  });
}

// ---- JOBS ----

export function openJobs() {
  const s = ui.state;
  const name = (id) => s.ship.crew.find(c => c.id === id)?.name || '—';
  const label = (j) => jobLabel(s, j);
  const P = ['CRIT', 'HIGH', 'NORM'];
  const rows = s.jobs.list.map(j => `<div class="job-row"><span class="job-priority job-priority-${['critical', 'high', 'normal'][j.priority]}">${P[j.priority]}</span>
    <span class="job-type">${esc(label(j))}</span><span class="job-status job-status-${j.status === 'open' ? 'pending' : 'assigned'}">${j.status}</span>
    <span class="job-assignee ${j.assignee == null ? 'job-assignee-none' : ''}">${esc(j.assignee == null ? '—' : name(j.assignee))}</span></div>`).join('');
  const crew = s.ship.crew.map(m => `<div class="job-row"><span class="job-type">${esc(m.name)}</span><span class="job-status">${esc(m.dead ? 'deceased' : describeActivity(m))}</span></div>`).join('');
  openDialog({
    title: 'Crew Jobs', cls: 'dialog-jobs',
    html: `<div class="jobs-list">${rows ? `<div class="jobs-header"><span class="jobs-col-priority">PRI</span><span class="jobs-col-type">Job</span><span class="jobs-col-status">Status</span><span class="jobs-col-assignee">Assignee</span></div>${rows}` : '<p class="jobs-empty">— No open jobs —</p>'}</div>
      <div class="missions-section">CREW ACTIVITY</div><div class="jobs-list">${crew}</div>`,
  });
}

// ---- HAIL ----

export function hail(entityId) {
  const s = ui.state;
  const e = getWorld(s).get(entityId);
  if (!e) return;
  // Close in (docked, formation) a suit radio or a signal lamp will do; beyond that it takes the array
  const dM = Math.hypot(e.pos.x - s.flight.pos.x, e.pos.y - s.flight.pos.y) * AU_M;
  if (!canTransmit(s) && dM > 50_000) { toast('Comms array down — no transmitter', 'danger'); return; }
  if (e.type === 'station') { openStation(e); return; }
  const bars = signalBars(Math.hypot(e.pos.x - s.flight.pos.x, e.pos.y - s.flight.pos.y));
  let text = hailDialogue(e);
  let extra = '';
  const m = missionForEntity(s, e.id);
  if (m) {
    const r = completeRescue(s, m.id);
    if (r.success) {
      text = r.text;
      extra = rewardsHTML(r.rewards);
      toast('Rescue complete', 'ok');
      logEntry(`Rescue of ${e.name} complete${rewardsText(r.rewards)}`, 'ok');
    } else text = `${text}\n\n${r.text}`;
  } else {
    const r = hailContractTarget(s, e.id);
    if (r) {
      text = r.text;
      if (r.ok) { toast('Objective complete', 'ok'); logEntry(`${r.contract.title}: objective complete`, 'ok'); }
    }
  }
  logEntry(`Hailed ${e.transponder ? e.name : 'unidentified contact'}`, 'comms');
  openDialog({
    cls: 'dialog-hail',
    html: `<div class="hail-header"><span class="hail-channel">DIRECT CHANNEL</span><span class="hail-target">${esc(e.transponder ? e.name : 'UNIDENTIFIED')}</span>
      <span class="hail-faction hail-faction-${(e.faction || '').toLowerCase()}">${e.faction !== 'independent' ? esc(e.faction) : ''}</span></div>
      <div class="hail-body"><div class="hail-narrative">${esc(text).replace(/\n/g, '<br>')}</div>${extra}
      <div class="hail-signal-bar"><span class="hail-signal-icon">◈</span><span class="hail-signal-label">SIGNAL</span><span class="hail-signal-strength">${'■'.repeat(bars)}${'□'.repeat(5 - bars)}</span></div></div>`,
    buttons: [{ label: 'Close Channel', act: 'close', cls: 'btn-secondary' }],
  });
}

function rewardsText(r) {
  const t = fmtRewards(r, ', ');
  return t ? ` — ${t}` : '';
}

function rewardsHTML(r) {
  const parts = fmtRewards(r, '\n').split('\n').filter(Boolean).map(p => `<span class="mission-reward-item">${esc(p)}</span>`);
  return parts.length ? `<div class="mission-rewards">${parts.join('')}</div>` : '';
}

// ---- DISTRESS CALLS & DEMANDS ----
// One event dialog at a time; distress calls and comm requests queue for it.

let eventMission = null;
let eventRequest = null;
const eventQueue = [];

const eventBusy = () => eventMission || eventRequest;

function nextEvent() {
  const next = eventQueue.shift();
  if (!next) return;
  setTimeout(() => (next.request ? openRequest(next.request) : openDistress(next.call)), 250);
}

/** Someone wants an answer from us: a patrol, a pirate, a warship, a beaten enemy. */
export function openRequest(r) {
  if (eventBusy()) { eventQueue.push({ request: r }); return; }
  if (!ui.state.comms.requests.some(x => x.id === r.id)) return;    // answered or expired meanwhile
  eventRequest = r;
  const body = $('#dialog-event-body');
  const label = { inspect: 'ORDER TO HEAVE TO', demand: 'ULTIMATUM', warning: 'WARNING', surrender: 'SURRENDER' }[r.kind] || 'TRANSMISSION';
  const left = Math.max(0, r.expires - ui.state.clock.minute);
  body.innerHTML = `<div class="event-header"><span class="event-sos-icon">◈</span><span class="event-sos-label">${label}</span><span class="event-urgency">${left} min to answer</span></div>
    <div class="event-body">
      <div class="event-ship-info"><span class="event-ship-name">${esc(r.fromName)}</span><span class="event-ship-faction">${esc(r.faction)}</span></div>
      <div class="event-narrative">${esc(r.text)}</div>
      <div class="event-feasibility">${esc(REQUEST_HINT[r.kind] || '')}</div>
    </div>
    <div class="form-actions event-actions">${r.options.map((o, i) => `<button class="btn ${i === 0 ? 'btn-primary' : 'btn-secondary'}" data-act="reply" data-opt="${o.id}">${esc(o.label)}</button>`).join('')}</div>`;
  hooks.setPaused('distress', true);
  show($('#dialog-event'), true, 'flex');
}

const REQUEST_HINT = {
  inspect: 'Comply and they search the ship (≈45 min alongside): contraband is seized and fines paid. Run and you are wanted — patrols will try to disable you. Sitting still counts as complying.',
  demand: 'Pay and they leave. Refuse and they come for your drive — they want you crippled, not dead.',
  warning: 'Complying switches the transponder on and cuts the drive. Ignoring it makes you a target.',
  surrender: 'Accept and they strike: drive cold, weapons safe. Hail them in formation to take them in.',
};

function answerRequest(opt) {
  const r = eventRequest;
  eventRequest = null;
  closeDialog('#dialog-event');
  const res = respondToRequest(ui.state, r.id, opt, (t, p) => bus.emit(t, p));
  if (res.text) { logEntry(res.text, opt === 'refuse' ? 'danger' : 'comms'); toast(res.text, opt === 'refuse' ? 'danger' : 'info'); }
}

export function openDistress(call) {
  const { mission, entity, distanceAU, feasibility } = call;
  if (eventBusy()) { eventQueue.push({ call }); return; }       // one at a time
  if (mission.status !== 'offered') return;                     // stale by the time it surfaced
  eventMission = mission;
  const body = $('#dialog-event-body');
  body.innerHTML = `<div class="event-header"><span class="event-sos-icon">⚠</span><span class="event-sos-label">DISTRESS SIGNAL</span><span class="event-urgency">${formatDuration(mission.timer)} to live</span></div>
    <div class="event-body">
      <div class="event-ship-info"><span class="event-ship-name">${esc(entity.name)}</span><span class="event-ship-class">${esc(entity.shipClass)}</span>
        <span class="event-ship-faction">${esc(entity.faction)}</span><span class="event-ship-dist">${fmtMeters(distanceAU * AU_M)}</span></div>
      <div class="event-narrative">${esc(mission.description)}</div>
      ${feasibility.feasible
        ? `<div class="event-feasibility">Nav computer: intercept in ~${formatDuration(feasibility.minutes)} at ${feasibility.g.toFixed(1)}G${feasibility.juice ? ' — juice required' : ''}.</div>`
        : `<div class="event-feasibility infeasible">${esc(feasibility.reason)}</div>`}
      <div class="mission-rewards">${rewardsHTML(mission.rewards)}</div>
    </div>
    <div class="form-actions event-actions">
      <button class="btn btn-secondary event-decline-btn" data-act="decline">${esc(mission.declineText)}</button>
      <button class="btn btn-primary event-accept-btn" data-act="accept">${esc(feasibility.feasible ? mission.acceptText : 'Accept anyway')}</button>
    </div>`;
  hooks.setPaused('distress', true);
  show($('#dialog-event'), true, 'flex');
}

function decline() {
  if (eventRequest) { eventRequest = null; closeDialog('#dialog-event'); return; }    // unanswered: silence decides
  if (eventMission) { declineMission(ui.state, eventMission.id); logEntry(`Distress call from ${eventMission.title.replace('SOS — ', '')} logged — not responding`, 'system'); }
  eventMission = null;
  closeDialog('#dialog-event');
}

function onEventClick(e) {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  if (b.dataset.act === 'reply' && eventRequest) { answerRequest(b.dataset.opt); return; }
  if (!eventMission) return;
  if (b.dataset.act === 'decline') { decline(); return; }
  const m = eventMission;
  acceptMission(ui.state, m.id);
  logEntry(`Answering distress call: ${m.title}`, 'nav');
  eventMission = null;
  closeDialog('#dialog-event');
  hooks.plotRoute({ kind: 'entity', id: m.entityId });
}

// ---- STATION ----

let stationTab = 'board';
let currentStation = null;

export function openStation(station = dockedStation(ui.state)) {
  if (!station) { toast('Not in contact with a station', 'warn'); return; }
  currentStation = station;
  const s = ui.state;
  if (!dockedStation(s) && stationTab === 'services') stationTab = 'board';
  renderStation();
  show($('#dialog-station'), true, 'flex');
  logEntry(`Channel open: ${station.name}`, 'comms');
}

function renderStation() {
  const s = ui.state, st = currentStation;
  const docked = dockedStation(s)?.id === st.id;
  const bars = signalBars(Math.hypot(st.pos.x - s.flight.pos.x, st.pos.y - s.flight.pos.y));
  const board = contractsAt(s, st.id);
  const deliver = docked ? deliverable(s, st) : [];
  const tabs = [['board', `CONTRACTS (${board.length})`], ['deliver', `DELIVER (${deliver.length})`], ['services', 'SERVICES']];
  let content = '';
  if (stationTab === 'board') {
    content = board.length ? board.map(c => {
      const needsDock = c.cargo || c.passengers;
      const meta = c.cargo ? `${fmtMass(c.cargo.mass)} · → ${c.destName}` : c.passengers ? `${c.passengers} passengers · → ${c.destName}` : c.fuelKg ? `${fmtNum(c.fuelKg)} kg from our tanks · → ${c.destName}` : c.distAU ? `${fmtNum(c.distAU * AU_KM)} km out` : '';
      return `<div class="station-mission-card"><div class="station-mission-top"><span class="station-mission-type">${CONTRACT_LABEL[c.type]}</span><span class="station-mission-deadline">${formatDuration(c.deadline)}</span></div>
        <div class="station-mission-desc">${esc(c.description)}</div><div class="station-mission-meta">${esc(meta)}</div>
        <div class="station-mission-bottom"><span class="station-mission-reward">${rewardLine(c.reward)}</span>
        <button class="station-mission-accept" data-act="accept" data-id="${c.id}" ${needsDock && !docked ? 'disabled title="Dock to load"' : ''}>${needsDock && !docked ? 'DOCK TO LOAD' : 'ACCEPT'}</button></div></div>`;
    }).join('') : '<div class="station-mission-empty">No contracts posted. Check back in a few hours.</div>';
  } else if (stationTab === 'deliver') {
    content = !docked ? '<div class="station-mission-empty">Dock to deliver cargo, passengers or reports.</div>'
      : deliver.length ? deliver.map(c => `<div class="station-mission-card"><div class="station-mission-top"><span class="station-mission-type">${CONTRACT_LABEL[c.type]}</span></div>
        <div class="station-mission-desc">${esc(c.title)}</div><div class="station-mission-bottom"><span class="station-mission-reward">${rewardLine(c.reward)}</span>
        <button class="station-mission-accept" data-act="complete" data-id="${c.id}">TURN IN</button></div></div>`).join('')
      : '<div class="station-mission-empty">Nothing to deliver here.</div>';
  } else {
    if (!docked) content = '<div class="station-mission-empty">Dock within 50 km to trade.</div>';
    else {
      const rows = [['fuel', 'Reaction mass', 'kg'], ['water', 'Water', 'L'], ['food', 'Rations', ''], ['o2Tank', 'Oxygen', 'kg'], ['n2Tank', 'Nitrogen', 'kg'], ['medSupplies', 'Medical supplies', 'unit'], ['parts', 'Spare parts', 'unit'], ['pdcRounds', 'PDC rounds', 'rd']].map(([k, name, unit]) => {
        const q = serviceQuote(s, k);
        return `<div class="service-row"><span class="service-name">${name}</span><span class="service-stock">${fmtNum(s.resources[k].current)} / ${fmtNum(s.resources[k].max)} ${unit === 'unit' ? 'units' : unit}</span>
          <span class="service-price">${PRICES[k]} MCR/${unit || 'unit'}</span>
          <button class="station-mission-accept" data-act="buy" data-key="${k}" ${q.qty < 0.5 ? 'disabled' : ''}>FILL · ${fmtNum(q.cost)} MCR</button></div>`;
      }).join('');
      const M = s.magazine;
      const torps = ['he', 'nuke'].map(w => {
        const no = torpedoRefusal(s, st, w);
        const full = M.he + M.nuke >= M.capacity;
        return `<div class="service-row"><span class="service-name">${WARHEADS[w].name}</span><span class="service-stock">${M[w]} aboard · magazine ${M.he + M.nuke}/${M.capacity}${no ? ` · ${esc(no)}` : ''}</span>
          <span class="service-price">${fmtNum(WARHEADS[w].price)} MCR</span>
          <button class="station-mission-accept" data-act="buy-torp" data-w="${w}" ${no || full ? 'disabled' : ''}>${full ? 'FULL' : 'LOAD ONE'}</button></div>`;
      }).join('');
      content = `<div class="service-list">${rows}${torps}
        <div class="service-row"><span class="service-name">Dockside overhaul</span><span class="service-stock">Hull ${Math.round(s.hull.integrity)}% · every system to spec, suits, containment</span><span class="service-price">${fmtNum(overhaulQuote(s))} MCR</span>
        <button class="station-mission-accept" data-act="overhaul">OVERHAUL</button></div>
        <div class="service-credits">Credits: <b>${fmtNum(s.resources.credits.current)} MCR</b></div></div>`;
    }
  }
  const record = st.faction in s.law.standing ? `<span class="station-record">STANDING ${Math.round(s.law.standing[st.faction])} · ${WANTED_LABEL[s.law.wanted[st.faction]]}</span>` : '';
  $('#dialog-station-body').innerHTML = `<div class="station-header"><span class="station-name">${esc(st.name)}</span><span class="station-faction">${st.faction !== 'independent' ? esc(st.faction.toUpperCase()) : ''}</span>${record}
      <span class="station-signal">${docked ? 'DOCKED' : '◈ ' + '■'.repeat(bars) + '□'.repeat(5 - bars)}</span></div>
    <div class="station-greeting">${esc(hailDialogue(st))}</div>
    <div class="station-tabs">${tabs.map(([k, l]) => `<button class="tac-tab ${k === stationTab ? 'active' : ''}" data-act="tab" data-tab="${k}">${l}</button>`).join('')}</div>
    <div class="station-board"><div class="station-board-list">${content}</div></div>
    <div class="form-actions">${!docked ? '<button class="btn btn-primary" data-act="plot-dock">PLOT DOCKING</button>' : ''}<button class="btn btn-secondary" data-act="close">CLOSE CHANNEL</button></div>`;
}

const rewardLine = (r) => fmtRewards(r);

function onStationClick(e) {
  const b = e.target.closest('[data-act]');
  if (!b || !currentStation) return;
  const s = ui.state;
  switch (b.dataset.act) {
    case 'close': closeDialog('#dialog-station'); return;
    case 'tab': stationTab = b.dataset.tab; break;
    case 'accept': {
      const r = acceptContract(s, currentStation.id, b.dataset.id);
      toast(r.text, r.ok ? 'ok' : 'warn');
      if (r.ok) logEntry(r.text, 'nav');
      break;
    }
    case 'complete': {
      const r = completeContract(s, b.dataset.id);
      toast(r.ok ? `Contract complete${r.bonus ? ' + bonus' : ''}` : r.text, r.ok ? 'ok' : 'warn');
      if (r.ok) logEntry(`${r.contract.title} — complete. ${r.text}`, 'ok');
      break;
    }
    case 'buy': {
      const r = buy(s, b.dataset.key);
      toast(r.text, r.ok ? 'ok' : 'warn');
      if (r.ok) logEntry(r.text, 'system');
      break;
    }
    case 'buy-torp': {
      const r = buyTorpedo(s, b.dataset.w);
      toast(r.text, r.ok ? 'ok' : 'warn');
      if (r.ok) logEntry(r.text, 'system');
      break;
    }
    case 'overhaul': {
      const r = buyOverhaul(s);
      toast(r.text, r.ok ? 'ok' : 'warn');
      if (r.ok) logEntry(r.text, 'ok');
      break;
    }
    case 'plot-dock': closeDialog('#dialog-station'); hooks.plotRoute({ kind: 'entity', id: currentStation.id }); return;
  }
  renderStation();
}

