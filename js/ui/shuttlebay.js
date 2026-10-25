// ============================================================
// LONGHAUL — The shuttle window: our bays, a run planned, a run flown
//
// What our shuttles are doing (sim/shuttles.js), and where they can go:
// from a world's high orbit (the parking orbit or a stationary one held:
// worlds.js), a spaceport in one of its airspaces. The plan is the run's
// whole timeline before anything moves (the drop to the air, the entry and
// what it costs the shield and the crew, the landing, the turnaround, the
// climb, the way back), its controller's answer to the landing, and the
// freight bound for that pad that will go down with it (PLANETSIDE
// contracts). Launched, the window follows it: its phase, its height and
// speed, the heat and the G of the entry as they come, and its log, and it
// can be called back (CALL BACK: shuttles.js abortRun). G opens it; a
// world's sheet sends a shuttle to an airspace (SEND SHUTTLE).
// ============================================================

import { ui } from './context.js';
import { $, esc, show, fmtMeters } from './dom.js';
import { toast } from './toast.js';
import { logEntry } from './log.js';
import { bus } from '../core/events.js';
import { formatDuration } from '../core/clock.js';
import { CLASSES } from '../sim/ship-classes.js';
import { airspacesOf } from '../sim/worlds.js';
import { runRefusal, planRun, launchRun, runReadout, activeRuns, landingClearance, cargoFor, defaultPilot, abortRun } from '../sim/shuttles.js';

const emit = (t, p) => bus.emit(t, p);
let chosen = { shuttle: null, airspace: null };

export function initShuttleBay() {
  const ov = $('#dialog-shuttle');
  ov.addEventListener('pointerdown', (e) => { if (e.target === ov) closeShuttleBay(); });
  ov.addEventListener('click', onClick);
  ov.addEventListener('change', onChange);
}

export const shuttleBayOpen = () => $('#dialog-shuttle').style.display !== 'none';

/** Open it (toward an airspace, if given). */
export function openShuttleBay(airspaceId = null) {
  const s = ui.state;
  if (!s) return;
  if (airspaceId) chosen.airspace = airspaceId;
  show($('#dialog-shuttle'), true, 'flex');
  render();
}
export function closeShuttleBay() {
  if (!shuttleBayOpen()) return false;
  show($('#dialog-shuttle'), false);
  return true;
}
export function toggleShuttleBay() { if (shuttleBayOpen()) closeShuttleBay(); else openShuttleBay(); }

const dur = (min) => formatDuration(Math.max(0, min));

function render() {
  const s = ui.state;
  const body = $('#dialog-shuttle-body');
  const bay = s.shuttles?.bay || [];
  if (!bay.length) {
    body.innerHTML = `<h3 class="dialog-title">Shuttles</h3><p class="dialog-text">This hull carries no shuttles. Big hulls aren't rated for an atmosphere and carry shuttles to reach a world's ground; ours is either small enough to need none, or rated to land itself (not yet).</p><div class="form-actions"><button class="btn btn-secondary" data-act="close">Close</button></div>`;
    return;
  }
  const runs = activeRuns(s);
  const bayRows = bay.map(sh => {
    const run = sh.run && runs.find(r => r.id === sh.run);
    const rd = run ? runReadout(s, run) : null;
    return `<div class="sb-row"><span class="sb-name">${esc(sh.name)}</span><span class="sb-class">${esc(CLASSES[sh.cls].name)} · ${CLASSES[sh.cls].cargoT} t · ${CLASSES[sh.cls].berths} seats</span>
      <span class="sb-state ${run ? 'out' : ''}">${run ? `${esc(rd.words || rd.phase)} · ${esc(run.port.name)} · home in ${dur(rd.eta)}` : 'in its bay'}</span></div>`;
  }).join('');
  const out = runs.map(run => runPanel(s, run)).join('');
  const no = runRefusal(s);
  let plan = '';
  if (no.why) plan = `<p class="dialog-text sb-why">${esc(no.why)}</p>`;
  else {
    const w = no.w;
    const air = airspacesOf(w);
    if (!air.length) plan = `<p class="dialog-text sb-why">Nobody lives on ${esc(w.name)}: no spaceports, no ground control, nowhere to land.</p>`;
    else {
      const free = bay.filter(x => !x.run);
      if (!free.length) plan = runs.length ? '' : '<p class="dialog-text sb-why">Every shuttle is out.</p>';
      else {
        if (!free.some(x => x.id === chosen.shuttle)) chosen.shuttle = free[0].id;
        // (the first time, the pad our freight is bound for)
        if (!air.some(a => a.id === chosen.airspace)) chosen.airspace = (air.find(a => cargoFor(s, a.id, 'lander').items.length) || air[0]).id;
        const p = planRun(s, chosen.shuttle, chosen.airspace);
        const clr = landingClearance(s, chosen.airspace);
        const sh = bay.find(x => x.id === chosen.shuttle);
        const load = cargoFor(s, chosen.airspace, sh.cls);
        const pilot = defaultPilot(s);
        plan = `<div class="sb-plan">
          <div class="sb-pick"><label>SHUTTLE <select data-pick="shuttle">${free.map(x => `<option value="${x.id}" ${x.id === chosen.shuttle ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label>
            <label>TO <select data-pick="airspace">${air.map(a => `<option value="${a.id}" ${a.id === chosen.airspace ? 'selected' : ''}>${esc(a.port.name)} · ${esc(a.controller)}</option>`).join('')}</select></label></div>
          ${p.ok ? timeline(p.plan.summary) : `<p class="dialog-text sb-why">${esc(p.why)}</p>`}
          <div class="sb-line"><b>CLEARANCE</b> <span class="${clr.ok ? 'sb-ok' : 'sb-bad'}">${esc(clr.text)}</span></div>
          <div class="sb-line"><b>FREIGHT</b> ${load.items.length ? `${load.items.map(i => `${Math.round(i.mass).toLocaleString()} kg of ${esc(i.name)}`).join(', ')} (of ${Math.round(load.room).toLocaleString()} kg room)` : 'nothing aboard bound for this pad'}</div>
          <div class="sb-line"><b>PILOT</b> ${pilot ? `${esc(pilot.name)} (${esc(pilot.role)}, piloting ${Math.round(pilot.skills.piloting)}): away from the ship until it is home` : 'nobody fit to fly it'}</div>
          <div class="form-actions"><button class="btn btn-primary" data-act="launch" ${p.ok && clr.ok && pilot ? '' : 'disabled'}>LAUNCH ${esc(sh.name.toUpperCase())}</button></div>
        </div>`;
      }
    }
  }
  body.innerHTML = `<h3 class="dialog-title">Shuttles</h3>
    <div class="sb-bay">${bayRows}</div>
    ${out}
    ${plan}
    <div class="form-actions"><button class="btn btn-secondary" data-act="close">Close</button></div>`;
}

/** A plan's whole run, stretch by stretch. */
function timeline(S) {
  const step = (k, v, note = '') => `<div class="sb-step"><span class="sb-k">${k}</span><span class="sb-v">${v}</span><span class="sb-note">${note}</span></div>`;
  return `<div class="sb-timeline">
    ${step('DROP', dur(S.dropMin), S.air ? `on the drive to the top of the air, braking to ${(S.entryV / 1000).toFixed(1)} km/s` : 'on the drive, to 10 km over the pad')}
    ${S.air ? step('ENTRY', dur(S.downMin), `${(S.entryV / 1000).toFixed(1)} km/s in · heat ${(S.peakHeat / 1e6).toFixed(2)} MW/m² at its peak · ${Math.round(S.downrangeKm).toLocaleString()} km of glide · up to ${S.peakG.toFixed(1)} G · down on the drive`) : step('LANDING', dur(S.downMin), `on the drive · up to ${S.peakG.toFixed(1)} G`)}
    ${step('GROUND', dur(S.groundMin), 'the freight off, the pad cleared')}
    ${step('CLIMB', dur(S.upMin), S.air ? 'through the air on the drive' : 'off the pad on the drive')}
    ${step('BACK', dur(S.returnMin), 'up to us on our orbit')}
    ${step('TOTAL', dur(S.totalMin), `${S.fuelKg.toFixed(1)} kg of reaction mass`)}
  </div>`;
}

/** A run under way: where it is, how it flies, its log. */
function runPanel(s, run) {
  const rd = runReadout(s, run);
  const live = rd.h != null ? `${fmtMeters(rd.h)} up · ${Math.round(rd.v).toLocaleString()} m/s${rd.q > 1000 ? ` · heat ${(rd.q / 1e6).toFixed(2)} MW/m²` : ''}${rd.g > 0.05 ? ` · ${rd.g.toFixed(1)} G` : ''}` : 'in the bay';
  return `<div class="sb-run"><div class="bd-phase">${esc(run.name.toUpperCase())} · ${esc((rd.words || rd.phase).toUpperCase())} · ${esc(run.port.name)}, ${esc(run.world)}</div>
    <div class="sb-line">${live} · this stretch ${dur(rd.legEnd)} more · home in ${dur(rd.eta)}</div>
    ${['launch', 'drop', 'down', 'ground'].includes(rd.phase) && !run.aborted ? `<div class="bd-actions"><button class="btn btn-secondary" data-act="abort" data-run="${esc(run.id)}" title="Bring it back: braking short of the air while it still can, or else landing and lifting again at once">CALL BACK</button></div>` : ''}
    <div class="bd-log">${run.log.slice().reverse().map(l => `<div>${esc(l.text)}</div>`).join('')}</div></div>`;
}

function onChange(ev) {
  const sel = ev.target.closest('[data-pick]');
  if (!sel) return;
  chosen[sel.dataset.pick] = sel.value;
  render();
}

function onClick(ev) {
  const btn = ev.target.closest('[data-act]');
  if (!btn || !ui.state) return;
  const s = ui.state;
  switch (btn.dataset.act) {
    case 'close': closeShuttleBay(); return;
    case 'abort': { const r = abortRun(s, btn.dataset.run, emit); toast(r.text, r.ok ? 'nav' : 'warn'); if (r.ok) logEntry(r.text, 'nav'); break; }
    case 'launch': {
      const p = planRun(s, chosen.shuttle, chosen.airspace);
      if (!p.ok) { toast(p.why, 'warn'); break; }
      const r = launchRun(s, p.plan, emit);
      toast(r.text, r.ok ? 'nav' : 'warn');
      if (r.ok) logEntry(r.text, 'nav');
      break;
    }
  }
  render();
}

/** While open, follow the runs (a few times a second: the entry moves fast). */
export function updateShuttleBay() {
  if (!shuttleBayOpen() || !ui.state) return;
  const now = performance.now();
  if (now - (updateShuttleBay.at || 0) < 400) return;
  updateShuttleBay.at = now;
  // (not while a select is open: the redraw would close it)
  if (document.activeElement?.tagName === 'SELECT') return;
  render();
}
