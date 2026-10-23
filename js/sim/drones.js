// ============================================================
// LONGHAUL — Camera drones: the only eye on our own hull from outside
//
// To see the ship in its surroundings (alongside another hull, in a
// berth, over a rock) something has to be outside with a camera. A ship
// carries a small rack of camera drones (DRONE_RACK by size; more are
// bought in port: contracts.js buyDrones). One at a time goes out:
//
//   launch    out of its bay and up to a standoff off our plane, from
//             where it looks down on us (DRONE_LAUNCH_MIN); no picture yet
//   station   holding off us on its own thrusters: the exterior view
//             (ui/exterior.js) is its picture
//   recover   called home: it flies back and is caught in its bay
//             (DRONE_RECOVER_MIN), its camera on until it is aboard
//
// It goes out only with the drive cold (it would launch into our own
// exhaust). Out, it keeps up with anything gentle (the RCS, a docking's
// final approach, hovering at a gate: DRONE_FOLLOW_G) but not with a burn:
// that leaves it behind, and it is lost. The exterior view is for a ship
// that isn't burning; without a drone out, there is none. A route
// waits for the drone as it waits for the crew to strap in (it is called
// home the minute the route is engaged, and the burn waits: autopilot.js);
// EXECUTE NOW goes without it, unless the way out of port on the RCS
// leaves it time to come home. Coasting on a route, it is called home
// ahead of the flip. Its cells and gas last DRONE_ENDURANCE_MIN, then it
// comes home by itself.
// ============================================================

import { CLASSES, PLAYER_CLASS } from './ship-classes.js';

export const DRONE_RACK = { S: 2, M: 3, L: 4, XL: 6 };   // drones a hull carries, by size
export const DRONE_FOLLOW_G = 0.12;      // what its thrusters can keep up with (a docking's final approach is 0.1G)
export const DRONE_LAUNCH_G = 0.01;      // and the drive must be cold to launch one
export const DRONE_LAUNCH_MIN = 2;       // out of the bay and up to its standoff
export const DRONE_RECOVER_MIN = 4;      // home and caught in the bay
export const DRONE_ENDURANCE_MIN = 6 * 60;
export const DRONE_PRICE = 450;          // MCR each, in port

/** The rack, as one of the ship's stores (state.resources.drones), full. */
export function createDroneStores(classId) {
  const n = DRONE_RACK[CLASSES[classId || PLAYER_CLASS]?.size] ?? 2;
  return { current: n, max: n, unit: 'drones' };
}

const LEAVING = new Set(['undock', 'outbound', 'depart']);     // a route's legs out of port, before the drive lights

/** A drone is out (launching, on station or coming home). */
export const droneOut = (state) => !!state.drone;

/** Is a drone sending pictures? (on station, or flying home with its camera on) */
export const droneFeed = (state) => state.drone?.phase === 'station' || state.drone?.phase === 'recover';

/** How hard we are accelerating this minute, as the drone feels it (G). */
const ourG = (state) => Math.max(state.flight.thrustG || 0, state.$jinkG || 0);

/** Why a drone can't go out now (null: it can). */
export function deployRefusal(state) {
  if (state.drone) return 'A drone is already out.';
  if ((state.resources.drones?.current || 0) < 1) return 'No drones aboard: buy them in port.';
  if (state.reactor?.blackout) return 'No power to the drone bay.';
  if (ourG(state) > DRONE_LAUNCH_G) return 'Not under thrust: it would launch into our exhaust. Cut the drive first.';
  if (state.autopilot?.phase === 'prepare') return 'Securing for a burn: it would be left behind.';
  return null;
}

export function deployDrone(state, emit = () => {}) {
  const no = deployRefusal(state);
  if (no) return { ok: false, text: no };
  const now = state.clock.minute;
  state.resources.drones.current--;
  state.drone = { phase: 'launch', since: now, until: now + DRONE_LAUNCH_MIN, launchedAt: now };
  emit('drone-deployed', { left: state.resources.drones.current });
  const underway = state.autopilot?.phase === 'active';
  return { ok: true, text: `Drone away: on station in ${DRONE_LAUNCH_MIN} minutes${underway ? '. It comes home before the next burn' : ''}` };
}

/** Call the drone home (why: 'captain', 'burn', 'endurance'). */
export function recallDrone(state, emit = () => {}, why = 'captain') {
  const d = state.drone;
  if (!d) return { ok: false, text: 'No drone out.' };
  if (d.phase === 'recover') return { ok: true, text: 'The drone is already coming home.' };
  const now = state.clock.minute;
  // (still on its way out: it turns round, and is back as soon as it went)
  const back = d.phase === 'launch' ? Math.max(1, now - d.since) : DRONE_RECOVER_MIN;
  Object.assign(d, { phase: 'recover', since: now, until: now + back });
  emit('drone-recalled', { why, minutes: back });
  return { ok: true, text: `Drone recalled: aboard in ${back} minute${back === 1 ? '' : 's'}` };
}

/**
 * Per minute, after the ship has flown it: a burn leaves the drone behind;
 * phases run out; a burn coming (a route securing, or the flip ahead on a
 * coast) or flat cells call it home.
 */
export function dronesTick(state, emit = () => {}) {
  const d = state.drone;
  if (!d) return;
  const now = state.clock.minute;
  const g = ourG(state);
  if (g > DRONE_FOLLOW_G) {
    state.drone = null;
    emit('drone-lost', { why: 'burn', g });
    return;
  }
  if (d.phase === 'launch' && now >= d.until) {
    Object.assign(d, { phase: 'station', since: now, until: null });
    emit('drone-on-station', {});
  }
  if (d.phase !== 'recover') {
    const ap = state.autopilot;
    // (a route securing, leaving port on the RCS, or coasting with its flip close: the drive is coming)
    const burnAhead = ap?.phase === 'prepare' || (ap?.phase === 'active' && g < 0.01 && (LEAVING.has(ap.display) || ap.flipIn <= DRONE_RECOVER_MIN + 2));
    if (burnAhead) recallDrone(state, emit, 'burn');
    else if (now - d.launchedAt >= DRONE_ENDURANCE_MIN) recallDrone(state, emit, 'endurance');
  }
  if (d.phase === 'recover' && now >= d.until) {
    state.drone = null;
    const r = state.resources.drones;
    r.current = Math.min(r.max, r.current + 1);
    emit('drone-recovered', {});
  }
}

/** For the displays: { phase, left (minutes in this phase), endurance (minutes of cells left) } or null. */
export function droneStatus(state) {
  const d = state.drone;
  if (!d) return null;
  const now = state.clock.minute;
  return { phase: d.phase, left: d.until != null ? Math.max(0, d.until - now) : null, endurance: Math.max(0, d.launchedAt + DRONE_ENDURANCE_MIN - now) };
}
