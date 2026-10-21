// ============================================================
// LONGHAUL — The stage: what the main view shows, and how it is laid out
//
// The main view is a stage with slots, and what goes in them follows
// what the ship is doing:
//
//   cruise   our interior, the whole view
//   near     our interior, and an inset camera on what is close outside
//            (another hull or a station within a few km)
//   prox     a dock under way (final approach, proximity operations,
//            capture, undocking, holding off): the exterior fills the
//            view with the docking display; our interior is the inset
//   docked   our interior, beside the exterior: the berth, the station's
//            structure, the ships in the berths round us
//   atmo     (reserved: entry and atmospheric flight bring their own
//            exterior layer and effects; the slots are the same)
//
// A click on the inset swaps it with the main slot. The interior is one
// SVG (ship-view.js) that moves between slots; the exterior is one
// canvas (exterior.js).
// ============================================================

import { $, toggleClass, setText } from './dom.js';
import { AU_M } from '../core/constants.js';
import { getWorld } from '../sim/world.js';
import { stationModel } from '../sim/stations.js';
import { hullOf } from '../sim/hulls.js';
import { ExteriorView } from './exterior.js';
import { initDockingHud, updateDockingHud } from './docking-hud.js';
import { refitShipView } from './ship-view.js';

const PROX_PHASES = new Set(['approach', 'prox', 'capture', 'seal', 'undock', 'separate', 'holding', 'outbound']);
const NEAR_STATION_M = 8_000, NEAR_SHIP_M = 5_000;

let el = {}, exterior = null, mode = null, swapped = false;

export function initStage(handlers = {}) {
  el = {
    viewport: $('#ship-viewport'), main: $('#stage-main'), pip: $('#stage-pip'), side: $('#stage-side'),
    exterior: $('#stage-exterior'), interior: $('#ship-container'), hud: $('#dock-hud'), pipLabel: $('#stage-pip-label'),
  };
  exterior = new ExteriorView(el.exterior, { onSelect: (id) => id && handlers.select?.(id) });
  initDockingHud(el.hud);
  el.pip.addEventListener('click', () => { swapped = !swapped; place(mode, true); });
}

export function resetStage() {
  mode = null;
  swapped = false;
  if (exterior) exterior.cam.ready = false;
}

/** Which layout the ship's situation calls for. */
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

/** Put the interior and the exterior in their slots for a mode. */
function place(m, force = false) {
  if (!force && m === mode) return;
  mode = m;
  const v = el.viewport;
  for (const k of ['cruise', 'near', 'prox', 'docked']) toggleClass(v, `stage-${k}`, k === m);
  // which view takes the main slot, which the inset (or the side panel)
  let main = 'interior', inset = null, side = null;
  if (m === 'near') inset = 'exterior';
  if (m === 'prox') { main = 'exterior'; inset = 'interior'; }
  if (m === 'docked') side = 'exterior';
  if (swapped && inset) [main, inset] = [inset, main];
  const host = { main: el.main, inset: el.pip, side: el.side };
  const put = (view, slot) => { const node = view === 'interior' ? el.interior : el.exterior; if (slot && node.parentElement !== host[slot]) host[slot].appendChild(node); };
  put(main, 'main');
  if (inset) put(inset, 'inset');
  if (side) put(side, 'side');
  if (!inset && !side) put(main === 'interior' ? 'exterior' : 'interior', null);
  toggleClass(el.exterior, 'stage-hidden', !(main === 'exterior' || inset === 'exterior' || side === 'exterior'));
  toggleClass(el.pip, 'stage-hidden', !inset);
  toggleClass(el.side, 'stage-hidden', !side);
  setText(el.pipLabel, inset === 'interior' ? 'INTERIOR · click to swap' : inset === 'exterior' ? 'EXTERIOR · click to swap' : '');
  if (exterior) exterior.cam.ready = false;
  requestAnimationFrame(() => refitShipView());
}

export function updateStage(state, alpha) {
  if (!el.viewport) return;
  const m = stageMode(state);
  if (m !== mode) { if (m !== 'near' && mode !== 'near') swapped = false; place(m); }
  if (!el.exterior.classList.contains('stage-hidden')) exterior.render(state, alpha, { labels: mode !== 'near' });
  updateDockingHud(state);
}

export const currentStageMode = () => mode;
