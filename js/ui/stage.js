// ============================================================
// LONGHAUL — The exterior cameras: what feeds them, and when they come up
//
// The EXTERIOR display (or its window, when the captain pulls it out:
// console.js) shows one of our cameras, chosen on its own bar, which goes
// where the display goes:
//
//   DRONE      a camera drone out (sim/drones.js): our ship and what is
//              round it, at true scale (exterior.js). The bar deploys and
//              recalls it. With none out nothing sees our hull from
//              outside: the display is blank, and says how to get one (a
//              line in its corner while the docking display is up). A burn
//              leaves the drone behind; none goes out with the drive lit.
//   HULL       the fixed wide-angle cameras on our plating (hullcam.js):
//              what is round us from where we are, a piece of our own hull
//              in the frame. Always there; the bar picks the camera (FWD,
//              AFT, PORT, STBD; K steps through them).
//   SHUTTLE    the cameras on a shuttle of ours that is out (shuttlecam.js:
//              NOSE, DOWN, TAIL), through the whole ride down to the pad
//              and back; with more than one out, the bar picks which.
//              The shuttle window's CAMERA brings it up on that run.
//   TELESCOPE  ours (sim/telescope.js, telescope.js): one contact or one
//              world, from where we are. It holds what it was pointed at
//              (LOOK on a contact's or a world's panel or card, Z, or the
//              bar's LOOK AT PICK); FILTER on the bar steps through its
//              plume filters (lit when one would help). It zooms in steps
//              (− and + on the bar, the keys, the wheel): the computer picks
//              the step that frames what it holds (AUTO), the captain may
//              pick another, until AUTO or a new target.
//
// The docking display goes over it while a dock is under way
// (docking-hud.js), with its own collar camera. The display comes up by
// itself, and goes back to what was showing when it is over (unless the
// captain moved it meanwhile):
//   a dock     under way (final approach, proximity operations, capture,
//              undocking, holding off, the climb out): the docking display,
//              over the drone's picture if one is out, else the hull
//              cameras'
//   torpedoes  ours, in their last OWN_ARRIVAL_S to their target (time runs
//              at 1× for it: sim/combat.js): the telescope on the target,
//              if it can hold it, through whatever happens to them, shot
//              down, hit or missed, and until what followed has played out
//              (a target blown apart is held on a while)
//   a reactor  on a fuse near us in its last minutes (a hull we scuttled,
//              a wreck's core a blast set failing: time runs at 1× for it,
//              sim/combat.js): the telescope on it, through the blast
// The tab is marked when there is something close outside. A target can be
// a world: LOOK on a body's card or panel (the pick, for Z and LOOK AT PICK).
//
// A camera draws only while it can be seen: its tab is up, or its window
// is open.
// ============================================================

import { $, esc, setHTML, show, toggleClass, fmtKm } from './dom.js';
import { toast } from './toast.js';
import { bus } from '../core/events.js';
import { AU_M } from '../core/constants.js';
import { formatDuration } from '../core/clock.js';
import { getWorld } from '../sim/world.js';
import { stationModel } from '../sim/stations.js';
import { hullOf } from '../sim/hulls.js';
import { deployDrone, recallDrone, deployRefusal, droneFeed, droneStatus, DRONE_LAUNCH_MIN } from '../sim/drones.js';
import { scopeOf, scopeLock, FILTERS } from '../sim/telescope.js';
import { launchedBy, timeToGo } from '../sim/ordnance.js';
import { PLAYER } from '../sim/combatants.js';
import { OWN_ARRIVAL_S, fuseAboutToGo } from '../sim/combat.js';
import { dockHolds } from '../sim/docking.js';
import { ExteriorView } from './exterior.js';
import { ScopeView } from './telescope.js';
import { HullCamView, HULL_CAMS } from './hullcam.js';
import { ShuttleCamView, SHUTTLE_CAMS } from './shuttlecam.js';
import { activeRuns } from '../sim/shuttles.js';
import { initDockingHud, updateDockingHud } from './docking-hud.js';

const PROX_PHASES = new Set(['approach', 'prox', 'capture', 'seal', 'undock', 'separate', 'holding', 'outbound']);
const NEAR_STATION_M = 8_000, NEAR_SHIP_M = 5_000;
const AUTO_HOLD_MS = 4500;     // the telescope stays on a target this long after the last torpedo is done with it
const SRC_LABEL = { drone: 'DRONE', hull: 'HULL', shuttle: 'SHUTTLE', scope: 'TELESCOPE' };

let el = {}, exterior = null, scope = null, hullcam = null, shuttlecam = null, mode = null, hooks = {};
let src = 'drone';             // the camera on the display: 'drone' | 'hull' | 'shuttle' | 'scope'
let scopeTarget = null;        // what the telescope holds: { kind: 'entity' | 'body', id }
let dockReturn = null;         // { tab, src, set }: what showed before a dock took the display over, and the camera it put up
let auto = null;               // the telescope come up for our torpedoes: { id, until, back: { tab, src, scopeTarget } }
let watchAt = 0, barAt = 0, barKey = '', lostAt = -1e9;

export function initStage(h = {}) {
  hooks = h;   // { state(), select(id), currentTab(), setTab(tab), back(), isFloating(), pick() }
  el = { exterior: $('#stage-exterior'), scope: $('#stage-scope'), hull: $('#stage-hull'), shuttle: $('#stage-shuttle'), bar: $('#cam-bar'), nofeed: $('#cam-nofeed'), hud: $('#dock-hud'), tab: $('#mv-tab-exterior') };
  exterior = new ExteriorView(el.exterior, { onSelect: (id) => id && hooks.select?.(id) });
  hullcam = new HullCamView(el.hull, { onSelect: (id) => id && hooks.select?.(id) });
  shuttlecam = new ShuttleCamView(el.shuttle, { onSelect: (id) => id && hooks.select?.(id) });
  scope = new ScopeView(el.scope);
  // (the wheel over the telescope's picture steps its zoom)
  el.scope.addEventListener('wheel', (e) => { if (scope.zoomStep(e.deltaY < 0 ? 1 : -1)) { e.preventDefault(); barKey = ''; } }, { passive: false });
  initDockingHud(el.hud);
  el.bar.addEventListener('click', onClick);
  el.nofeed.addEventListener('click', onClick);
  bus.on('drone-lost', () => { lostAt = performance.now(); barKey = ''; });
}

export function resetStage() {
  mode = null;
  dockReturn = null;
  auto = null;
  src = 'drone';
  scopeTarget = null;
  barKey = '';
  lostAt = -1e9;
  exterior?.reset();
  hullcam?.reset();
  shuttlecam?.reset();
  scope?.reset();
}

/** Which situation the ship is in, for the exterior. */
export function stageMode(state) {
  const d = state.dock;
  if (d && d.phase === 'docked') return 'docked';
  if (d && PROX_PHASES.has(d.phase)) return 'prox';
  if (somethingNear(state)) return 'near';
  return 'cruise';
}

const _q = [];
function somethingNear(state) {
  const world = getWorld(state);
  const f = state.flight.pos;
  for (const st of world.stations) {
    const dM = Math.hypot(st.pos.x - f.x, st.pos.y - f.y) * AU_M;
    if (dM < NEAR_STATION_M + (stationModel(st.id)?.sizeM || 0)) return true;
  }
  _q.length = 0;
  world.query(f, NEAR_SHIP_M / AU_M, _q);
  for (const e of _q) {
    if (e.type !== 'ship' || !state.sensors.$seen?.has(e.id)) continue;
    if (Math.hypot(e.pos.x - f.x, e.pos.y - f.y) * AU_M < NEAR_SHIP_M + (hullOf(e.cls)?.L || 0)) return true;
  }
  return false;
}

const floating = () => !!hooks.isFloating?.();
const onDisplay = () => floating() || hooks.currentTab?.() === 'exterior';

/** Bring the display up (its tab, unless it floats in its window). */
function raise() { if (!floating() && hooks.currentTab?.() !== 'exterior') hooks.setTab?.('exterior'); }

/** A dock under way takes the display (the docking display, over the drone's camera, or the hull's); when it is over, the display goes back. */
function enter(state, m) {
  const was = mode;
  mode = m;
  toggleClass(el.tab, 'marked', m !== 'cruise');
  toggleClass(el.tab, 'urgent', m === 'prox');
  if (m === 'prox' && was !== 'prox') {
    dockReturn = { tab: floating() ? null : hooks.currentTab?.(), src };
    // (a picture under the docking display: the drone's if one is out, else the hull cameras')
    if (src === 'scope' || (src === 'drone' && !droneFeed(state))) src = droneFeed(state) ? 'drone' : 'hull';
    dockReturn.set = src;
    raise();
  } else if (was === 'prox' && m !== 'prox' && dockReturn) {
    // (a camera the captain chose during the dock stays up)
    if (src === dockReturn.set) src = dockReturn.src;
    if (dockReturn.tab && dockReturn.tab !== 'exterior' && hooks.currentTab?.() === 'exterior') hooks.setTab?.(dockReturn.tab);
    dockReturn = null;
  }
  if (exterior) exterior.cam.ready = false;
  barKey = '';
}

/**
 * Our torpedoes closing on their target, or a reactor on a fuse about to
 * go: the telescope on it, if it can hold it, until a few seconds after
 * what followed has played out; then back.
 */
function watchTorpedoes(state) {
  const now = performance.now();
  if (now - watchAt < 200) return;
  watchAt = now;
  let soon = null, best = Infinity;
  for (const e of launchedBy(state, PLAYER)) {
    if (e.ord.kind !== 'torpedo') continue;
    const eta = timeToGo(state, e);
    if (eta < OWN_ARRIVAL_S && eta < best && scopeLock(state, e.ord.target).ok) { best = eta; soon = e.ord.target; }
  }
  const fuse = fuseAboutToGo(state);
  if (fuse && fuse.combat.containment * 60 < best && scopeLock(state, fuse.id).ok) soon = fuse.id;
  if (soon) {
    if (!auto) {
      if (dockHolds(state) && state.dock.phase !== 'docked') return;      // (a dock under way keeps the display)
      auto = { id: soon, back: { tab: floating() ? null : hooks.currentTab?.(), src, scopeTarget } };
      look({ kind: 'entity', id: soon });
    } else if (auto.id !== soon && holds(auto.id)) { auto.id = soon; look({ kind: 'entity', id: soon }); }
    auto.until = now + AUTO_HOLD_MS;
    return;
  }
  // (and not before what followed has played out: the flashes, a hull blown apart held on a while)
  if (auto && now > Math.max(auto.until, scope.busyUntil())) {
    // back to what was showing, unless the captain moved the display meanwhile
    if (src === 'scope' && holds(auto.id) && onDisplay()) {
      src = auto.back.src;
      scopeTarget = auto.back.scopeTarget;
      if (auto.back.tab && auto.back.tab !== 'exterior' && hooks.currentTab?.() === 'exterior') hooks.setTab?.(auto.back.tab);
      barKey = '';
    }
    auto = null;
  }
}

/** A telescope target from a pick ({ kind, id }, or an entity's id), or null. */
const asTarget = (t) => !t ? null : typeof t === 'string' ? { kind: 'entity', id: t } : t.kind === 'entity' || t.kind === 'body' ? { kind: t.kind, id: t.id } : null;
const holds = (id) => scopeTarget?.kind === 'entity' && scopeTarget.id === id;
const same = (a, b) => !!a && !!b && a.kind === b.kind && a.id === b.id;

/** Point the telescope at a target and bring it up (the mount slews to it: telescope.js). */
function look(t) {
  scopeTarget = asTarget(t);
  src = 'scope';
  barKey = '';
  raise();
}

/** LOOK: the telescope on a contact or a world (the pick, from a panel or a key). */
export function lookAt(t) {
  const target = asTarget(t);
  if (!target) { toast('Pick a contact or a world to look at', 'warn'); return; }
  auto = null;
  look(target);
}

/** Z: the telescope on the pick; again (or with nothing picked), back from it. */
export function toggleScope(pick) {
  const target = asTarget(pick);
  if (src === 'scope' && onDisplay() && (!target || same(target, scopeTarget))) { hooks.back?.(); return; }
  if (target) lookAt(target);
  else if (scopeTarget) { auto = null; look(scopeTarget); }
  else toast('Pick a contact or a world to look at', 'warn');
}

export function updateStage(state, alpha) {
  if (!el.exterior) return;
  const m = stageMode(state);
  if (m !== mode) enter(state, m);
  watchTorpedoes(state);
  const feed = src === 'scope' ? 'scope' : src === 'hull' ? 'hull' : src === 'shuttle' ? 'shuttle' : droneFeed(state) ? 'drone' : null;
  show(el.exterior, feed === 'drone');
  show(el.scope, feed === 'scope');
  show(el.hull, feed === 'hull');
  show(el.shuttle, feed === 'shuttle');
  if (onDisplay()) {
    if (feed === 'drone') exterior.render(state, alpha, { labels: mode !== 'near' });
    else if (feed === 'hull') hullcam.render(state, alpha);
    else if (feed === 'shuttle') shuttlecam.render(state, alpha);
    else if (feed === 'scope') scope.render(state, alpha, scopeTarget);
    const now = performance.now();
    if (now - barAt > 250 || !barKey) { barAt = now; renderBar(state, feed); }
  }
  updateDockingHud(state);
}

/** The camera's own bar (sources, the drone, the telescope's target) and, without a picture, why. */
function renderBar(state, feed) {
  const ds = droneStatus(state);
  const r = state.resources.drones;
  const no = deployRefusal(state);
  const docking = el.hud.style.display !== 'none';
  const srcBtn = (k, title, dis) => `<button class="mv-btn ${src === k ? 'active' : ''}" data-cam="${k}" title="${title}" ${dis ? 'disabled' : ''}>${SRC_LABEL[k]}</button>`;
  let act = '', note = '';
  if (src === 'scope') {
    const sc = scopeOf(state);
    const f = FILTERS[scope.filter];
    act = `<button class="mv-btn" data-cam-act="look" title="Point the telescope at what is picked on the displays (a contact or a world)">LOOK AT PICK</button>
      <button class="mv-btn ${f.id !== 'off' ? 'active' : ''} ${scope.hint && f.id === 'off' ? 'suggest' : ''}" data-cam-act="filter" title="The plume filter: OFF, PLUME (a drive's lines cut 5 magnitudes, a hull's light half of one), DEEP (9 against 1.2, darker and noisier). It brings a hull out of its own drive's glare, and lets us see, degraded, through our own exhaust">FILTER ${f.label}</button>`;
    const z = scope.zoom;
    const can = !!z?.can;
    const mag = (i) => `×${Math.round(z.levels[0] / z.levels[i]).toLocaleString()}`;
    act += `<span class="mv-sep"></span><button class="mv-btn" data-cam-act="zoom-out" ${can && z.i > 0 ? `title="Zoom out a step: ${mag(z.i - 1)} (−, or the wheel)"` : 'disabled'}>−</button>
      <button class="mv-btn ${can && !z.manual ? 'active' : ''}" data-cam-act="zoom-auto" ${can ? `title="The zoom the computer picks to frame what we hold (${mag(z.autoI)})"` : 'disabled title="Zoom works while the telescope holds a target"'}>${can ? `${mag(z.i)} ${z.manual ? 'MANUAL' : 'AUTO'}` : 'ZOOM'}</button>
      <button class="mv-btn" data-cam-act="zoom-in" ${can && z.i < z.levels.length - 1 ? `title="Zoom in a step: ${mag(z.i + 1)} (+, or the wheel)"` : 'disabled'}>+</button>`;
    note = `${sc.apertureM} m mirror · holds a target to ${fmtKm(sc.lockM / 1000)}${auto ? ' · TORPEDOES CLOSING' : ''}`;
  } else if (src === 'hull') {
    act = HULL_CAMS.map(c => `<button class="mv-btn ${hullcam.cam === c.id ? 'active' : ''}" data-cam-act="hull:${c.id}" title="${esc(c.name.toLowerCase())}">${c.label}</button>`).join('');
    note = 'fixed wide-angle cameras on our plating · K steps through them';
  } else if (src === 'shuttle') {
    const runs = activeRuns(state).filter(r => r.carrier === 'player');
    const on = shuttlecam.runFor(state);
    act = SHUTTLE_CAMS.map(c => `<button class="mv-btn ${shuttlecam.cam === c.id ? 'active' : ''}" data-cam-act="shuttle:${c.id}" title="${esc(c.name.toLowerCase())}">${c.label}</button>`).join('');
    if (runs.length > 1) act += `<span class="mv-sep"></span>${runs.map(r => `<button class="mv-btn ${on?.id === r.id ? 'active' : ''}" data-cam-act="run:${esc(r.id)}" title="Its cameras">${esc(r.name.toUpperCase())}</button>`).join('')}`;
    note = on ? `${on.name} · to ${on.port.name}, ${on.world}` : 'no shuttle out';
  } else {
    act = ds ? `<button class="mv-btn" data-cam-act="recall" ${ds.phase === 'recover' ? 'disabled' : ''} title="Call the drone home">RECALL</button>`
      : `<button class="mv-btn" data-cam-act="deploy" ${no ? `disabled title="${esc(no)}"` : 'title="Send a camera drone out: a view of our ship from outside"'}>DEPLOY DRONE</button>`;
    note = `${r?.current ?? 0}/${r?.max ?? 0} aboard`;
    if (ds) note += ` · ${ds.phase === 'launch' ? `launching, on station in ${formatDuration(ds.left)}` : ds.phase === 'recover' ? `coming home, aboard in ${formatDuration(ds.left)}` : `on station · cells ${formatDuration(ds.endurance)}`}`;
  }
  const out = activeRuns(state).some(r => r.carrier === 'player');
  const html = `<div class="cam-srcs">${srcBtn('drone', 'The drone\'s camera: our ship and what is round it')}${srcBtn('hull', 'The hull cameras: what is round us, from our plating (K)')}${srcBtn('shuttle', out ? 'The cameras on our shuttle out: the ride down and back' : 'Our shuttle\'s cameras, while one is out', !out && src !== 'shuttle')}${srcBtn('scope', 'The telescope: one contact, from here (Z)')}</div>
    <span class="mv-sep"></span>${act}<span class="cam-note">${note}</span>`;
  const key = html + '|' + (feed || '') + '|' + (ds?.phase || '') + (docking ? 'dock' : '') + (performance.now() - lostAt < 20_000 ? 'lost' : '');
  if (key === barKey) return;
  barKey = key;
  setHTML(el.bar, html);
  // No picture: say why, and what would give one
  let msg = null;
  if (!feed) {
    if (ds?.phase === 'launch') msg = { head: 'DRONE LAUNCHING', text: `Out of its bay and climbing to its standoff: a picture in ${formatDuration(ds.left)}.` };
    else {
      const lost = performance.now() - lostAt < 20_000;
      msg = { head: lost ? 'DRONE LOST' : 'NO DRONE OUT',
        text: lost ? 'Left behind by the burn: a drone can\'t keep up with the drive. Send another out once the drive is cold.'
          : 'Nothing sees our hull from outside but a camera drone, and a drone can\'t follow a burn: deploy one when the drive is cold, recall it before we go.',
        btn: no ? `<button class="btn btn-secondary" disabled title="${esc(no)}">DEPLOY DRONE</button><div class="cam-why">${esc(no)}</div>` : `<button class="btn btn-primary" data-cam-act="deploy">DEPLOY DRONE · ${r.current} ABOARD</button><div class="cam-why">On station in ${DRONE_LAUNCH_MIN} minutes.</div>` };
    }
  }
  show(el.nofeed, !!msg, 'flex');
  // (under the docking display, which has its own camera: the view stays blank but for a line in its corner)
  toggleClass(el.nofeed, 'compact', docking);
  if (msg && docking) setHTML(el.nofeed, `<div class="cam-nofeed-box"><span class="cam-nofeed-head">${msg.head}</span>${ds ? '' : no ? '' : '<button class="mv-btn" data-cam-act="deploy">DEPLOY DRONE</button>'}</div>`);
  else if (msg) setHTML(el.nofeed, `<div class="cam-nofeed-box"><div class="cam-nofeed-head">${msg.head}</div><div class="cam-nofeed-text">${msg.text}</div>${msg.btn || ''}
    <div class="cam-nofeed-alt"><button class="btn btn-secondary" data-cam="hull">HULL CAMERAS</button><button class="btn btn-secondary" data-cam="scope">TELESCOPE</button></div></div>`);
}

function onClick(e) {
  const b = e.target.closest('[data-cam], [data-cam-act]');
  const s = hooks.state?.();
  if (!b || !s || b.disabled) return;
  e.stopPropagation();
  if (b.dataset.cam) {
    src = b.dataset.cam;
    auto = null;
    if (src === 'scope' && !scopeTarget) { const p = asTarget(hooks.pick?.()); if (p) look(p); }
  }
  const emit = (t, p) => bus.emit(t, p);
  switch (b.dataset.camAct) {
    case 'deploy': { const r = deployDrone(s, emit); toast(r.text, r.ok ? 'ok' : 'warn'); if (r.ok) src = 'drone'; break; }
    case 'recall': { const r = recallDrone(s, emit); toast(r.text, r.ok ? 'ok' : 'warn'); break; }
    case 'look': { const p = asTarget(hooks.pick?.()); if (p) lookAt(p); else toast('Pick a contact or a world on the displays first', 'warn'); break; }
    case 'filter': { const f = FILTERS[scope.cycleFilter()]; toast(f.id === 'off' ? 'Telescope: filter out' : `Telescope: ${f.label} filter in (a drive's light −${f.plume} mag, a hull's −${f.hull})`, 'info'); break; }
    case 'zoom-in': scope.zoomStep(1); break;
    case 'zoom-out': scope.zoomStep(-1); break;
    case 'zoom-auto': scope.zoomAuto(); break;
  }
  if (b.dataset.camAct?.startsWith('hull:')) hullcam.select(b.dataset.camAct.slice(5));
  if (b.dataset.camAct?.startsWith('shuttle:')) shuttlecam.select(b.dataset.camAct.slice(8));
  if (b.dataset.camAct?.startsWith('run:')) shuttlecam.follow(b.dataset.camAct.slice(4));
  barKey = '';
}

/** The shuttle cameras up, on a run (the shuttle window's CAMERA). */
export function watchShuttle(runId = null) {
  if (runId) shuttlecam.follow(runId);
  src = 'shuttle'; auto = null; raise();
  barKey = '';
}

/** K: the hull cameras up; again, the next one. */
export function toggleHullCams() {
  if (src === 'hull' && onDisplay()) hullcam.next();
  else { src = 'hull'; auto = null; raise(); }
  barKey = '';
}

/** + / −: the telescope's zoom a step, while it is on the display and holds something. */
export function zoomScope(step) {
  if (src !== 'scope' || !onDisplay()) return false;
  const ok = scope.zoomStep(step);
  barKey = '';
  return ok;
}

export const currentStageMode = () => mode;
/** The cameras themselves (for the tools that look at what they drew). */
export const stageViews = () => ({ exterior, hullcam, shuttlecam, scope });
