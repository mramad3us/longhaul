// ============================================================
// LONGHAUL — Shipboard: engineering board, duty roster, and the
// words for what people and machines are doing. Shared by the
// selection panel, the jobs list and the two shipboard dialogs.
// ============================================================

import { ui } from './context.js';
import { esc, setHTML } from './dom.js';
import { toast } from './toast.js';
import { logEntry } from './log.js';
import { openDialog } from './dialogs.js';
import { formatDuration } from '../core/clock.js';
import {
  SYSTEMS, shipSystems, Status, MAINTAIN_AT, statusLabel, repairMode, orderService, prioritizeRepair, toggleSystem, hullSound, hullPatchLimit } from '../sim/systems.js';
import { STATIONS, STATION_IDS, SHIFTS, scheduleBlock, minutesLeftInBlock, setDuty, rostered } from '../sim/duty.js';
import { NEEDS, NEED_LABEL, efficiency } from '../sim/needs.js';
import { rankTitle, fullName, ageOf, promotionDue, payroll } from '../sim/careers.js';
import { JobType } from '../sim/jobs.js';

// ---- WORDS ----

const ACTIVITY = {
  idle: 'Off watch', securing: 'Heading to a crash couch', secured: 'Strapped in',
  suiting: 'Donning an EVA suit', 'to-medbay': 'Walking to the autodoc', waiting: 'Waiting their turn', healing: 'In the autodoc',
  rescuing: 'Running to a downed crewmate', 'first-aid': 'Administering first aid', carrying: 'Carrying a casualty to the autodoc',
  'to-reactor': 'Heading to the reactor', 'reactor-work': 'Working the reactor', carried: 'Being carried', down: 'Down', dead: 'Deceased',
  sleeping: 'Asleep in a bunk', 'sleeping-couch': 'Asleep in a crash couch', 'to-bed': 'Turning in',
  'to-galley': 'Heading to the galley', cooking: 'Getting a meal', 'cold-rations': 'Opening cold rations', 'to-mess': 'Heading to the mess',
  eating: 'Eating', 'to-head': 'Heading to the head', washing: 'In the shower', 'to-rec': 'Heading to the exercise rig',
  exercising: 'On the exercise rig', socializing: 'Talking at the mess table', 'to-station': 'Reporting for watch',
  'standing-by': 'Standing by to relieve the watch', flying: 'Flying the ship by hand', 'to-helm': 'Running to the helm',
  'watch-helm': 'On watch at the helm', 'watch-ops': 'On watch at ops', 'watch-weapons': 'On watch at fire control', 'watch-engineering': 'On the engineering watch',
  'watch-workshop': 'On duty in the machine shop', 'watch-medbay': 'On duty in sick bay', 'watch-galley': 'Cooking in the galley',
  'to-fabricating': 'Heading to the machine shop', fabricating: 'Refurbishing spare parts',
  'to-patching': 'Heading to the machine shop', patching: 'Cutting plate and patching the hull',
  'to-sealing': 'Heading out to patch the hull breach', sealing: 'Sealing a hull breach',
};

/** What someone is doing, in words. */
export function describeActivity(m) {
  const t = m.task;
  const sys = t?.system ? SYSTEMS[t.system].name : null;
  switch (m.activity) {
    case 'repairing': return `Repairing the ${sys}`;
    case 'jury-rigging': return `Jury-rigging the ${sys} — no spares`;
    case 'maintaining': return `Servicing the ${sys}`;
    case 'to-repairing': return `Heading to repair the ${sys}`;
    case 'to-maintaining': return `Heading to service the ${sys}`;
    default: return ACTIVITY[m.activity] || m.activity;
  }
}

/** A job, in words. */
export function jobLabel(state, j) {
  const name = (id) => state.ship.crew.find(c => c.id === id)?.name || '—';
  const sys = j.data.system ? SYSTEMS[j.data.system].name : '';
  switch (j.type) {
    case JobType.RESCUE: return `Rescue → ${name(j.data.patient)}`;
    case JobType.REPAIR: return `Repair ${sys}${state.systems.units[j.data.system].status !== Status.PATCHED && repairMode(state, j.data.system) === 'jury' ? (state.systems.units[j.data.system].heavy ? ' (rig it to run)' : ' (jury-rig: no spares)') : ''}`;
    case JobType.MAINTAIN: return `Service ${sys}`;
    case JobType.FABRICATE: return 'Refurbish spare parts from scrap';
    case JobType.PATCH: return 'Patch the hull';
    case JobType.HELM: return 'Fly the ship by hand';
    case JobType.SEAL: return `Seal hull breach — ${state.ship.decks[j.data.deck].name}`;
    case JobType.REACTOR: return `Reactor: ${j.data.work}`;
    default: return j.type;
  }
}

/** CSS state class for a system. */
export function systemClass(u) {
  if (!u.enabled) return 'sys-off';
  if (u.status === Status.FAILED) return 'sys-fail';
  if (u.status !== Status.NOMINAL) return 'sys-warn';
  return u.integrity < MAINTAIN_AT ? 'sys-due' : 'sys-ok';
}

/** A system's condition card (selection panel and engineering board). */
export function systemCardHTML(state, id, { compact = false } = {}) {
  const def = SYSTEMS[id];
  const u = state.systems.units[id];
  const job = state.jobs.list.find(j => (j.type === JobType.REPAIR || j.type === JobType.MAINTAIN) && j.data.system === id);
  const who = job?.assignee != null ? state.ship.crew.find(c => c.id === job.assignee) : null;
  let work = '';
  if (job) {
    const what = job.type === JobType.REPAIR ? (u.status === Status.PATCHED ? (u.heavy ? 'Rigging it to hold' : 'Proper repair') : repairMode(state, id) === 'jury' ? 'Jury-rig' : 'Repair') : 'Servicing';
    const t = who?.task;
    const pct = t?.need ? ` ${Math.min(99, Math.round(t.progress / t.need * 100))}%` : '';
    work = who ? `${what}: ${who.name}${t?.phase === 'work' ? pct : ' en route'}` : `${what} queued — waiting for an engineer`;
  }
  const effect = u.status === Status.FAILED ? def.effects.failed : u.status === Status.RIGGED ? `${def.effects.degraded}. Heavy damage: a yard's work` : u.status !== Status.NOMINAL ? def.effects.degraded : '';
  const patch = u.status === Status.PATCHED && u.patchUntil ? ` · holds ~${formatDuration(u.patchUntil - state.clock.minute)}` : '';
  const actions = [];
  if (job?.type === JobType.REPAIR && job.priority !== 0) actions.push(`<button class="crew-action-btn crew-action-rescue" data-act="sys-repair" data-sys="${id}">REPAIR FIRST</button>`);
  if (u.status === Status.NOMINAL && u.integrity < 90 && !(job?.type === JobType.MAINTAIN && job.priority <= 1)) actions.push(`<button class="crew-action-btn crew-action-recover" data-act="sys-service" data-sys="${id}">SERVICE NOW</button>`);
  if (id === 'lifeSupport') actions.push(`<button class="crew-action-btn ${u.enabled ? 'crew-action-cancel' : 'crew-action-recover'}" data-act="sys-toggle" data-sys="${id}">${u.enabled ? 'SHUT DOWN' : 'POWER UP'}</button>`);
  return `<div class="sys-card ${systemClass(u)}${compact ? ' sys-compact' : ''}">
    <div class="sys-card-head"><span class="sys-name lib-inline" data-lib="sys:${id}" title="Ship's library">${esc(def.name)}</span><span class="sys-status">${statusLabel(u)}</span></div>
    <div class="sys-integrity"><div class="sys-bar"><div class="sys-bar-fill" style="width:${u.integrity.toFixed(0)}%"></div></div><span class="sys-int">${u.integrity.toFixed(0)}%</span></div>
    ${u.fault ? `<div class="sys-fault">${esc(u.fault.text)}${patch}</div>` : ''}
    ${effect ? `<div class="sys-effect">${esc(effect)}</div>` : ''}
    ${work ? `<div class="sys-work">${esc(work)}</div>` : ''}
    ${actions.length ? `<div class="sys-actions">${actions.join('')}</div>` : ''}
  </div>`;
}

/** Handle the system card buttons (from any panel). Returns true if handled. */
export function handleSystemAction(act, id) {
  const s = ui.state;
  if (!s || !SYSTEMS[id]) return false;
  let r = null;
  if (act === 'sys-service') r = orderService(s, id);
  else if (act === 'sys-repair') r = prioritizeRepair(s, id);
  else if (act === 'sys-toggle') {
    const on = toggleSystem(s, id);
    r = { ok: true, text: `${SYSTEMS[id].name} ${on ? 'powered up' : 'SHUT DOWN'}` };
    logEntry(r.text, on ? 'system' : 'danger');
    toast(r.text, on ? 'ok' : 'danger');
    return true;
  } else return false;
  toast(r.text, r.ok ? 'info' : 'warn');
  if (r.ok) logEntry(r.text, 'system');
  return true;
}

// ---- ENGINEERING BOARD ----

let boardTimer = 0;

export function openSystems() {
  const render = () => {
    const s = ui.state;
    if (!s) return '';
    const res = s.resources;
    const w = s.$watch || {};
    const eng = w.engineering != null ? s.ship.crew.find(c => c.id === w.engineering) : null;
    const shop = w.workshop != null ? s.ship.crew.find(c => c.id === w.workshop) : null;
    const faults = shipSystems(s).filter(id => s.systems.units[id].status !== Status.NOMINAL).length;
    const hull = s.hull.integrity, sound = hullSound(s), limit = hullPatchLimit(s), patchJob = s.jobs.list.find(j => j.type === JobType.PATCH);
    const patcher = patchJob?.assignee != null ? s.ship.crew.find(c => c.id === patchJob.assignee) : null;
    const hullLine = sound >= 99.5 ? '' : `<div class="sys-summary"><span>HULL <b>${Math.round(hull)}%</b>, <b>${Math.round(sound)}%</b> sound</span>
        <span>${hull + 0.5 < limit ? (patcher ? `${esc(patcher.name)} patching` : patchJob ? 'patch job waiting for a hand' : 'patching waits: no plate, or under burn or fire') : `patched as far as patches go (${Math.round(limit)}%)`}</span>
        <span>Structure is a yard's work</span></div>`;
    return `${hullLine}<div class="sys-summary">
        <span>SPARES <b>${res.parts.current.toFixed(1)}</b> parts</span>
        <span>SCRAP <b>${res.scrap.current.toFixed(1)}</b></span>
        <span>ENGINEERING WATCH <b class="${eng ? '' : 'sys-none'}">${eng ? esc(eng.name) : 'none — faults bite harder'}</b></span>
        <span>MACHINE SHOP <b class="${shop ? '' : 'sys-none'}">${shop ? esc(shop.name) : '—'}</b></span>
        <span>${faults ? `<b class="sys-faults">${faults} FAULT${faults > 1 ? 'S' : ''}</b>` : 'ALL SYSTEMS NOMINAL'}</span>
      </div>
      <div class="sys-grid">${shipSystems(s).map(id => systemCardHTML(s, id)).join('')}</div>
      <p class="sys-legend">Machinery wears with use — hard burns most of all. Worn systems fault far more often. Engineers service them from spare parts; with no spares, repairs are jury-rigged and won't hold. The machine shop refurbishes scrap into spares. Docks sell parts; structure and heavy damage wait for a yard.</p>`;
  };
  const body = openDialog({
    title: 'Engineering — Ship Systems', cls: 'dialog-wide dialog-systems', html: render(),
    onAction: (act, b) => { handleSystemAction(act, b.dataset.sys); refresh(); },
    close: () => clearInterval(boardTimer),
  });
  const content = body.querySelector('.dialog-content');
  const refresh = () => setHTML(content, render());
  clearInterval(boardTimer);
  boardTimer = setInterval(refresh, 700);
}

// ---- DUTY ROSTER ----

let rosterTimer = 0;

const needBars = (m) => NEEDS.map(k => {
  const v = m.needs[k];
  return `<span class="need-mini ${v < 20 ? 'need-low' : v < 45 ? 'need-mid' : ''}" title="${NEED_LABEL[k]} ${Math.round(v)}%"><span style="height:${Math.round(v)}%"></span></span>`;
}).join('');

function blockLabel(state, m) {
  const b = scheduleBlock(state, m);
  const left = formatDuration(minutesLeftInBlock(state, m));
  const txt = b === 'duty' ? `ON WATCH · ${left}` : b === 'sleep' ? `SLEEP · ${left}` : `OFF · ${left}`;
  return `<span class="duty-now duty-${b}">${txt}</span>`;
}

/** Marks by a name: a step up earned, a retirement asked, a hand meaning to go (sim/careers.js), the juice still being paid for (crew.js). */
const flags = (m) => [promotionDue(m) && '<span class="roster-flag roster-flag-up" title="Due a step up: PROMOTE in their panel">▲</span>',
  m.retire && '<span class="roster-flag" title="Asks to retire">R</span>', m.quit && '<span class="roster-flag roster-flag-bad" title="Means to sign off at the next port">✕</span>',
  m.juiceHangover > 0 && `<span class="roster-flag ${m.juiceCrash ? 'roster-flag-bad' : ''}" title="${m.juiceCrash ? 'Juice crash: works at ×0.6 until it passes' : 'Juice hangover: works at ×0.85 until it passes'}. Rest and leave don't shorten it; a hospital on a world's ground clears it.">${m.juiceCrash ? 'CRASH' : 'HANGOVER'} ${formatDuration(m.juiceHangover)}</span>`].filter(Boolean).join('');

/** The month's pay, and those the ship has lost or seen off. */
function serviceFoot(s) {
  const lost = (s.ship.memorial || []).slice(-8).reverse(), left = (s.ship.alumni || []).slice(-6).reverse();
  const day = (min) => `day ${Math.floor(min / 1440) + 1}`;
  const owed = s.ship.crew.reduce((a, m) => a + (m.dead ? 0 : m.owed || 0), 0);
  return `<div class="missions-section">SERVICE</div><div class="roster-legend"><p><b>Payroll.</b> ${payroll(s).toLocaleString()} MCR a month, paid every thirty days${owed > 0 ? `; <span class="tc-bad">${Math.round(owed).toLocaleString()} MCR owed</span>` : ''}. The captain takes the ship's profit.</p>
    ${lost.length ? `<p><b>In memory.</b> ${lost.map(x => `${esc(fullName(x))}, ${esc(x.rank)}: ${esc(x.cause)} (${day(x.died)})`).join(' · ')}</p>` : ''}
    ${left.length ? `<p><b>Served aboard.</b> ${left.map(x => `${esc(fullName(x))}, ${esc(x.rank)}: ${esc(x.why)} (${day(x.left)})`).join(' · ')}</p>` : ''}</div>`;
}

export function openRoster() {
  const render = () => {
    const s = ui.state;
    if (!s) return '';
    // (the living: the dead come off it the day they die, and are named under IN MEMORY below)
    const rows = s.ship.crew.filter(m => !m.dead).map(m => {
      const opts = ['none', ...STATION_IDS].map(id => {
        const st = STATIONS[id];
        const sk = st?.skill ? ` (${st.skill.slice(0, 3).toUpperCase()} ${Math.floor(m.skills[st.skill])})` : '';
        return `<option value="${id}" ${m.duty.station === id ? 'selected' : ''}>${id === 'none' ? 'No station' : st.label + sk}</option>`;
      }).join('');
      const shifts = SHIFTS.map((sh, i) => `<button class="duty-shift ${m.duty.shift === i ? 'active' : ''}" data-act="duty-shift" data-id="${m.id}" data-shift="${i}">${sh.label}</button>`).join('');
      return `<div class="roster-row">
        <div class="roster-who"><span class="roster-name">${esc(m.name)}${flags(m)}</span><span class="roster-role">${esc(m.role === 'Captain' || m.born == null ? m.role : rankTitle(m))}</span>${m.born != null ? `<span class="roster-role">${m.role === 'Captain' || rankTitle(m).includes(m.role) ? '' : `${esc(m.role)} · `}${Math.floor(ageOf(m, s.clock.minute))}</span>` : ''}</div>
        <select class="roster-station" data-id="${m.id}">${opts}</select>
        <div class="roster-shifts">${shifts}</div>
        <div class="roster-now">${blockLabel(s, m)}<span class="roster-activity">${esc(describeActivity(m))}</span></div>
        <div class="roster-needs">${needBars(m)}<span class="roster-morale" title="Morale">${Math.round(m.morale)}</span><span class="roster-eff" title="Efficiency">${Math.round(efficiency(m) * 100) + '%'}</span></div>
      </div>`;
    }).join('');
    const cover = STATION_IDS.map(id => `<div class="cover-row"><span class="cover-station">${STATIONS[id].label}</span>${SHIFTS.map((sh, i) => {
      const who = rostered(s, id, i);
      const empty = !who.length;
      return `<span class="cover-cell ${empty ? (id === 'helm' ? 'cover-gap' : 'cover-empty') : ''}">${empty ? '—' : who.map(m => esc(m.name)).join(', ')}</span>`;
    }).join('')}</div>`).join('');
    return `<div class="roster-head"><span>CREW</span><span>STATION</span><span>WATCH</span><span>NOW</span><span>REST · FOOD · HYGIENE · REC · MORALE · EFF</span></div>
      <div class="roster">${rows}</div>
      <div class="missions-section">COVERAGE</div>
      <div class="cover"><div class="cover-row cover-header"><span class="cover-station"></span>${SHIFTS.map(sh => `<span class="cover-cell">${sh.label}</span>`).join('')}</div>${cover}</div>
      ${serviceFoot(s)}
      <div class="roster-legend">${STATION_IDS.map(id => `<p><b>${STATIONS[id].label}.</b> ${esc(STATIONS[id].desc)}</p>`).join('')}
        <p>Each watch is eight hours on station, eight off (meals, the head, the exercise rig), eight asleep. Bunks are shared between watches.</p></div>`;
  };
  const body = openDialog({
    title: 'Duty Roster', cls: 'dialog-wide dialog-roster', html: render(),
    onAction: (act, b) => {
      if (act !== 'duty-shift') return;
      const m = ui.state.ship.crew.find(c => c.id === +b.dataset.id);
      setDuty(ui.state, m, null, +b.dataset.shift);
      logEntry(`${m.name} moved to the ${SHIFTS[m.duty.shift].label} watch`, 'crew');
      refresh();
    },
    close: () => clearInterval(rosterTimer),
  });
  const content = body.querySelector('.dialog-content');
  content.addEventListener('change', (e) => {
    const sel = e.target.closest('.roster-station');
    if (!sel) return;
    const m = ui.state.ship.crew.find(c => c.id === +sel.dataset.id);
    setDuty(ui.state, m, sel.value, null);
    logEntry(sel.value === 'none' ? `${m.name} relieved of station duty` : `${m.name} assigned to ${STATIONS[sel.value].label}`, 'crew');
    refresh();
  });
  // Live refresh, but never while a dropdown is open (it would close under the cursor)
  const refresh = () => { if (document.activeElement?.closest?.('.roster-station')) return; setHTML(content, render()); };
  clearInterval(rosterTimer);
  rosterTimer = setInterval(refresh, 1000);
}

// ---- HUD STRIP ----

/** Compact per-system status pips for the left panel. */
export function systemsStripHTML(state) {
  return shipSystems(state).map(id => {
    const u = state.systems.units[id];
    return `<button class="sys-pip ${systemClass(u)}" data-act="open-systems" title="${esc(SYSTEMS[id].name)} — ${statusLabel(u)} · ${u.integrity.toFixed(0)}%">
      <span class="sys-pip-name">${SYSTEMS[id].short}</span><span class="sys-pip-bar"><span style="width:${u.integrity.toFixed(0)}%"></span></span></button>`;
  }).join('');
}

