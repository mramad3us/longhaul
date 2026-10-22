// ============================================================
// LONGHAUL — The exterior cameras, and when they come up
//
// What is outside the hull is one display (exterior.js), with the
// docking display over it (docking-hud.js). It is the main view's
// EXTERIOR tab, or a window of its own when the captain pulls it out
// (console.js). What the ship is doing decides how forward it is:
//
//   cruise   nothing close outside: the camera is there if asked for
//   near     another hull or a station within a few km: the EXTERIOR tab
//            is marked, there is something to look at
//   prox     a dock under way (final approach, proximity operations,
//            capture, undocking, holding off, the climb out): the main
//            view switches to the exterior with the docking display, and
//            goes back to what it showed before once the dock is done
//            (unless the captain moved it meanwhile)
//   docked   the berth, the station's structure, the ships round us: the
//            tab is marked
//   atmo     (reserved: entry and atmospheric flight bring their own
//            exterior layer and effects)
//
// The camera draws only while it can be seen: its tab is up, or its
// window is open.
// ============================================================

import { $, toggleClass } from './dom.js';
import { AU_M } from '../core/constants.js';
import { getWorld } from '../sim/world.js';
import { stationModel } from '../sim/stations.js';
import { hullOf } from '../sim/hulls.js';
import { ExteriorView } from './exterior.js';
import { initDockingHud, updateDockingHud } from './docking-hud.js';

const PROX_PHASES = new Set(['approach', 'prox', 'capture', 'seal', 'undock', 'separate', 'holding', 'outbound']);
const NEAR_STATION_M = 8_000, NEAR_SHIP_M = 5_000;

let el = {}, exterior = null, mode = null, hooks = {};
let returnTo = null;           // the display the main view showed before a dock took it over

export function initStage(h = {}) {
  hooks = h;   // { select(id), currentTab(), setTab(tab), isFloating() }
  el = { exterior: $('#stage-exterior'), hud: $('#dock-hud'), tab: $('#mv-tab-exterior') };
  exterior = new ExteriorView(el.exterior, { onSelect: (id) => id && hooks.select?.(id) });
  initDockingHud(el.hud);
}

export function resetStage() {
  mode = null;
  returnTo = null;
  exterior?.reset();
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

/** A dock under way takes the main view; when it is over, the view goes back. */
function enter(m) {
  const was = mode;
  mode = m;
  toggleClass(el.tab, 'marked', m !== 'cruise');
  toggleClass(el.tab, 'urgent', m === 'prox');
  if (m === 'prox' && !hooks.isFloating?.()) {
    const cur = hooks.currentTab?.();
    if (cur !== 'exterior') { returnTo = cur; hooks.setTab?.('exterior'); }
  } else if (was === 'prox' && returnTo) {
    if (hooks.currentTab?.() === 'exterior') hooks.setTab?.(returnTo);
    returnTo = null;
  }
  if (exterior) exterior.cam.ready = false;
}

export function updateStage(state, alpha) {
  if (!el.exterior) return;
  const m = stageMode(state);
  if (m !== mode) enter(m);
  const seen = hooks.isFloating?.() || hooks.currentTab?.() === 'exterior';
  if (seen) exterior.render(state, alpha, { labels: mode !== 'near' });
  updateDockingHud(state);
}

export const currentStageMode = () => mode;
