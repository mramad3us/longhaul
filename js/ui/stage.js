// ============================================================
// LONGHAUL — The exterior cameras: what feeds them, and when they come up
//
// The EXTERIOR display (or its window, when the captain pulls it out:
// console.js) shows one camera at a time, chosen on its own bar, which
// goes where the display goes:
//
//   DRONE      a camera drone out (sim/drones.js): our ship and what is
//              round it, at true scale (exterior.js). The bar deploys and
//              recalls it. With none out there is no picture of our hull
//              from outside, and the display says how to get one; a burn
//              leaves the drone behind.
//   PORT       docking with a station (or docked at one), its approach and
//              berth cameras feed us the same picture
//   TELESCOPE  ours (sim/telescope.js, telescope.js): one contact, from
//              where we are. It holds what it was pointed at (LOOK on a
//              contact's panel or card, Z, or the bar's LOOK AT PICK).
//
// The docking display goes over it while a dock is under way
// (docking-hud.js). The display comes up by itself, and goes back to what
// was showing when it is over (unless the captain moved it meanwhile):
//   a dock     under way (final approach, proximity operations, capture,
//              undocking, holding off, the climb out): the port's camera
//              (a ship's dock: the drone's, if one is out)
//   torpedoes  ours, in their last OWN_ARRIVAL_S to their target (time runs
//              at 1× for it: sim/combat.js): the telescope on the target,
//              if it can hold it, through whatever happens to them, shot
//              down, hit or missed, and a few seconds after
// The tab is marked when there is something close outside.
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
import { scopeOf, scopeLock } from '../sim/telescope.js';
import { launchedBy, timeToGo } from '../sim/ordnance.js';
import { PLAYER } from '../sim/combatants.js';
import { OWN_ARRIVAL_S } from '../sim/combat.js';
import { dockHolds } from '../sim/docking.js';
import { ExteriorView } from './exterior.js';
import { ScopeView } from './telescope.js';
import { initDockingHud, updateDockingHud } from './docking-hud.js';

const PROX_PHASES = new Set(['approach', 'prox', 'capture', 'seal', 'undock', 'separate', 'holding', 'outbound']);
const NEAR_STATION_M = 8_000, NEAR_SHIP_M = 5_000;
const AUTO_HOLD_MS = 4500;     // the telescope stays on a target this long after the last torpedo is done with it
const SRC_LABEL = { drone: 'DRONE', port: 'PORT', scope: 'TELESCOPE' };

let el = {}, exterior = null, scope = null, mode = null, hooks = {};
let chosen = null;             // the camera chosen on the bar ('drone' | 'port' | 'scope'); null: srcOf decides
let scopeId = null;            // what the telescope holds
let dockReturn = null;         // { tab, chosen }: what showed before a dock took the display over
let auto = null;               // the telescope come up for our torpedoes: { id, until, back: { tab, chosen, scopeId } }
let watchAt = 0, barAt = 0, barKey = '', lostAt = -1e9;

export function initStage(h = {}) {
  hooks = h;   // { state(), select(id), currentTab(), setTab(tab), back(), isFloating(), pick() }
  el = { exterior: $('#stage-exterior'), scope: $('#stage-scope'), bar: $('#cam-bar'), nofeed: $('#cam-nofeed'), hud: $('#dock-hud'), tab: $('#mv-tab-exterior') };
  exterior = new ExteriorView(el.exterior, { onSelect: (id) => id && hooks.select?.(id) });
  scope = new ScopeView(el.scope);
  initDockingHud(el.hud);
  el.bar.addEventListener('click', onClick);
  el.nofeed.addEventListener('click', onClick);
  bus.on('drone-lost', () => { lostAt = performance.now(); barKey = ''; });
}

export function resetStage() {
  mode = null;
  dockReturn = null;
  auto = null;
  chosen = null;
  scopeId = null;
  barKey = '';
  lostAt = -1e9;
  exterior?.reset();
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

/** A station we dock with (or are docked at) lends us its cameras. */
export const portFeed = (state) => !!state.dock && state.dock.target.kind === 'station' && state.dock.phase !== 'inbound' && state.dock.phase !== 'awaiting';

/** The camera on the display: the one chosen, or the drone's if one is out, else the port's, else the drone's (and there is none). */
const srcOf = (state) => chosen ?? (state.drone ? 'drone' : portFeed(state) ? 'port' : 'drone');

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

/** A dock under way takes the display, on the port's camera; when it is over, the display goes back. */
function enter(m, state) {
  const was = mode;
  mode = m;
  toggleClass(el.tab, 'marked', m !== 'cruise');
  toggleClass(el.tab, 'urgent', m === 'prox');
  if (m === 'prox' && was !== 'prox') {
    dockReturn = { tab: floating() ? null : hooks.currentTab?.(), chosen };
    chosen = null;
    raise();
  } else if (was === 'prox' && m !== 'prox' && dockReturn) {
    // (a camera chosen during the dock stays chosen)
    if (chosen === null && !(dockReturn.chosen === 'port' && !portFeed(state))) chosen = dockReturn.chosen;
    if (dockReturn.tab && dockReturn.tab !== 'exterior' && hooks.currentTab?.() === 'exterior') hooks.setTab?.(dockReturn.tab);
    dockReturn = null;
  }
  if (exterior) exterior.cam.ready = false;
  barKey = '';
}

/**
 * Our torpedoes closing on their target: the telescope on it, if it can
 * hold it, until a few seconds after the last of them is done; then back.
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
  if (soon) {
    if (!auto) {
      if (dockHolds(state) && state.dock.phase !== 'docked') return;      // (a dock under way keeps the display)
      auto = { id: soon, back: { tab: floating() ? null : hooks.currentTab?.(), chosen, scopeId } };
      look(soon);
    } else if (auto.id !== soon && scopeId === auto.id) { auto.id = soon; look(soon); }
    auto.until = now + AUTO_HOLD_MS;
    return;
  }
  if (auto && now > auto.until) {
    // back to what was showing, unless the captain moved the display meanwhile
    if (chosen === 'scope' && scopeId === auto.id && onDisplay()) {
      chosen = auto.back.chosen;
      scopeId = auto.back.scopeId;
      if (auto.back.tab && auto.back.tab !== 'exterior' && hooks.currentTab?.() === 'exterior') hooks.setTab?.(auto.back.tab);
      barKey = '';
    }
    auto = null;
  }
}

/** Point the telescope at `id` and bring it up. */
function look(id) {
  if (id !== scopeId) scope.reset();
  scopeId = id;
  chosen = 'scope';
  barKey = '';
  raise();
}

/** LOOK: the telescope on a contact (the pick, from a panel or a key). */
export function lookAt(id) {
  if (!id) { toast('Pick a contact to look at', 'warn'); return; }
  auto = null;
  look(id);
}

/** Z: the telescope on the pick; again (or with nothing picked), back from it. */
export function toggleScope(pickId) {
  if (chosen === 'scope' && onDisplay() && (!pickId || pickId === scopeId)) { hooks.back?.(); return; }
  if (pickId) lookAt(pickId);
  else if (scopeId) { auto = null; look(scopeId); }
  else toast('Pick a contact to look at', 'warn');
}

export function updateStage(state, alpha) {
  if (!el.exterior) return;
  const m = stageMode(state);
  if (m !== mode) enter(m, state);
  watchTorpedoes(state);
  const src = srcOf(state);
  const feed = src === 'scope' ? 'scope' : src === 'port' ? (portFeed(state) ? 'port' : null) : droneFeed(state) ? 'drone' : null;
  show(el.exterior, feed === 'drone' || feed === 'port');
  show(el.scope, feed === 'scope');
  if (onDisplay()) {
    if (feed === 'drone' || feed === 'port') exterior.render(state, alpha, { labels: mode !== 'near' });
    else if (feed === 'scope') scope.render(state, alpha, scopeId);
    const now = performance.now();
    if (now - barAt > 250 || !barKey) { barAt = now; renderBar(state, src, feed); }
  }
  updateDockingHud(state);
}

/** The camera's own bar (sources, the drone, the telescope's target) and, without a picture, why. */
function renderBar(state, src, feed) {
  const ds = droneStatus(state);
  const r = state.resources.drones;
  const port = portFeed(state);
  const no = deployRefusal(state);
  const srcBtn = (k, title, dis) => `<button class="mv-btn ${src === k ? 'active' : ''}" data-cam="${k}" title="${title}" ${dis ? 'disabled' : ''}>${SRC_LABEL[k]}</button>`;
  let act = '', note = '';
  if (src === 'scope') {
    const sc = scopeOf(state);
    act = `<button class="mv-btn" data-cam-act="look" title="Point the telescope at what is picked on the displays">LOOK AT PICK</button>`;
    note = `${sc.apertureM} m mirror · holds a target to ${fmtKm(sc.lockM / 1000)}${auto ? ' · TORPEDOES CLOSING' : ''}`;
  } else {
    act = ds ? `<button class="mv-btn" data-cam-act="recall" ${ds.phase === 'recover' ? 'disabled' : ''} title="Call the drone home">RECALL</button>`
      : `<button class="mv-btn" data-cam-act="deploy" ${no ? `disabled title="${esc(no)}"` : 'title="Send a camera drone out: a view of our ship from outside"'}>DEPLOY DRONE</button>`;
    note = `${r?.current ?? 0}/${r?.max ?? 0} aboard`;
    if (ds) note += ` · ${ds.phase === 'launch' ? `launching, on station in ${formatDuration(ds.left)}` : ds.phase === 'recover' ? `coming home, aboard in ${formatDuration(ds.left)}` : `on station · cells ${formatDuration(ds.endurance)}`}`;
    if (src === 'port' && port) note = `${esc(getWorld(state).get(state.dock.target.id)?.name || 'Port')} cameras · ${note}`;
  }
  const html = `<div class="cam-srcs">${srcBtn('drone', 'The drone\'s camera: our ship and what is round it')}${srcBtn('port', 'The port\'s cameras, while we dock with a station', !port)}${srcBtn('scope', 'The telescope: one contact, from here (Z)')}</div>
    <span class="mv-sep"></span>${act}<span class="cam-note">${note}</span>`;
  const key = html + '|' + (feed || '') + '|' + (ds?.phase || '') + (performance.now() - lostAt < 20_000 ? 'lost' : '');
  if (key === barKey) return;
  barKey = key;
  setHTML(el.bar, html);
  // No picture: say why, and what would give one
  let msg = null;
  if (!feed) {
    if (src === 'port') msg = { head: 'NO PORT CAMERA', text: 'A station lends us its cameras while we dock with it, and while we lie in its berth.' };
    else if (ds?.phase === 'launch') msg = { head: 'DRONE LAUNCHING', text: `Out of its bay and climbing to its standoff: a picture in ${formatDuration(ds.left)}.` };
    else {
      const lost = performance.now() - lostAt < 20_000;
      msg = { head: lost ? 'DRONE LOST' : 'NO DRONE OUT',
        text: lost ? 'Left behind by the burn: a drone can\'t keep up with the drive. Send another out once the drive is cold.'
          : 'Nothing sees our hull from outside but a camera drone, and a drone can\'t follow a burn: deploy one when the drive is cold, recall it before we go.',
        btn: no ? `<button class="btn btn-secondary" disabled title="${esc(no)}">DEPLOY DRONE</button><div class="cam-why">${esc(no)}</div>` : `<button class="btn btn-primary" data-cam-act="deploy">DEPLOY DRONE · ${r.current} ABOARD</button><div class="cam-why">On station in ${DRONE_LAUNCH_MIN} minutes.</div>` };
    }
  }
  show(el.nofeed, !!msg, 'flex');
  if (msg) setHTML(el.nofeed, `<div class="cam-nofeed-box"><div class="cam-nofeed-head">${msg.head}</div><div class="cam-nofeed-text">${msg.text}</div>${msg.btn || ''}
    <div class="cam-nofeed-alt"><button class="btn btn-secondary" data-cam="scope">TELESCOPE</button></div></div>`);
}

function onClick(e) {
  const b = e.target.closest('[data-cam], [data-cam-act]');
  const s = hooks.state?.();
  if (!b || !s || b.disabled) return;
  e.stopPropagation();
  if (b.dataset.cam) {
    chosen = b.dataset.cam;
    auto = null;
    if (chosen === 'scope' && !scopeId) { const p = hooks.pick?.(); if (p) look(p); }
  }
  const emit = (t, p) => bus.emit(t, p);
  switch (b.dataset.camAct) {
    case 'deploy': { const r = deployDrone(s, emit); toast(r.text, r.ok ? 'ok' : 'warn'); if (r.ok) chosen = null; break; }
    case 'recall': { const r = recallDrone(s, emit); toast(r.text, r.ok ? 'ok' : 'warn'); break; }
    case 'look': { const p = hooks.pick?.(); if (p) lookAt(p); else toast('Pick a contact on the displays first', 'warn'); break; }
  }
  barKey = '';
}

export const currentStageMode = () => mode;
