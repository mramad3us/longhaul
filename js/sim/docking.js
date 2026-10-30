// ============================================================
// LONGHAUL — Docking: from the gate to a hard seal, and back out
//
// A minute is far too coarse for the last kilometre: at the speeds a
// collar can take (a few tenths of a metre a second) everything happens
// between two sim steps. So docking has a mode of its own. A dock runs
// through phases:
//
//   inbound   a route to the station's approach gate (or the ship) is
//             flown by the autopilot as any other route
//   awaiting  holding at the gate for docking clearance: traffic control
//             has to be asked (dialogue.js, or the one-click hail), the
//             nav computer won't do it for us
//   approach  the final approach, gate to corridor, flown by the docking
//             computer in the berth's frame (below) on the drive at 0.1G and
//             under the keep-out speed limit (traffic-control.js), to a
//             point CORRIDOR out along the berth's axis
//   spin      SPIN MATCH, off a tumbling wreck (damage.js tumbleOf): at
//             the corridor's mouth our ship takes up the wreck's turn on
//             the RCS, and flies round it as it does until the collar we
//             want faces us down the corridor (to us, the wreck's turn
//             slows and stops with the collar on our axis: at most half a
//             turn round, the arc at our RCS's acceleration, a minute to a
//             few: spinMatchS); from then on it stands still to us, and
//             mated, our RCS despins the pair (despin): it turns no more
//             when we let go. Called off before the seal, we let go of its
//             turn (releaseSpin) and it turns on, to us.
//   prox      PROXIMITY OPERATIONS, flown second by second on RCS in the
//             berth's own frame: x out along the collar's axis (range),
//             y along its `up`, z out of the plane; and the attitude errors
//             yaw, pitch and roll. The docking computer flies it (auto), or
//             the pilot does (manual: translate on the RCS, turn the nose;
//             the computer holds attitude when the stick is let go).
//   capture   contact inside the collar's envelope (closing speed, miss,
//             angle and roll: hulls.js COLLARS): the latches catch, the
//             collar retracts and seals (CAPTURE_MIN), the lock equalizes
//             (SEAL_MIN) and we are
//   docked    held to the berth, the berth ours. Outside the envelope the
//             collars bounce, and hard enough it is damage (bump()).
//   undock    the lock is vented and the latches let go (UNDOCK_MIN)
//   separate  backing out on RCS to the hold point (CLEAR_M); with a route
//             waiting, on through it without stopping (autopilot.js)
//   holding   station-keeping at a point in the berth's frame, until a
//             route takes us away, we clear off, or we come back in.
//   outbound  leaving a station: up the corridor to just past the gate
//             (OUT_PAST), on RCS alone, still in the berth's frame, where
//             the dock lets us go (no torch inside the gate: traffic-
//             control.js). With no route, the nav computer flies on out of
//             the approach on the RCS and holds past it (autopilot.js
//             clearOutTick), so a route plotted there lights at once. A hold point by a surface port is a hundred
//             metres over the rock, and the RCS can't hold a ship up
//             against even Ceres' pull: let go there, it falls.
//
// TIME. Proximity operations integrate in whole seconds inside the
// current minute (dock.t). The game loop may fly them a second at a time
// at a slower rate (PROX_RATES: real time for hand-flying), and the
// minute tick flies whatever is left of the minute (finishMinute), so a
// headless run and the browser fly the same thing. Nothing else in the
// sim changes inside a minute: only our place relative to the berth.
//
// THE FRAME. From the final approach on (and out again to the gate) our
// ship is held in the berth's frame: its place is the berth's, plus our
// offset. That frame turns with the station (or moves with the ship we are
// docking with). The body's gravity, which station and ship share, is left
// out of the motion: a station circling a moon fast (Ganymede's turns in
// three hours and pulls a tenth of a G to stay on it) would otherwise take
// more drive to keep up with than traffic control allows inside the gate.
// What holding against it costs is charged (hoverG): on the drive on the
// final approach, which flies on it anyway, and on the RCS everywhere
// else, which never lights the torch by a berth. Nothing in the frame
// meets the ground. A ship we are docked to that lights its drive tears
// us loose.
//
// SHIP TO SHIP. The other ship has to hold still: one that agreed to it
// (dialogue.js puts it in 'dock-hold'), one that has struck, a disabled
// or dead hull, or a command ship at its post (forces.js), which takes
// its own power's contractors alongside (service.js). Collars of one size
// mate.
// ============================================================

import { gravityAt } from './gravity.js';
import { AU_M, G0, MIN_S } from '../core/constants.js';
import { random, gaussian } from '../core/rng.js';
import { getWorld, predictEntity } from './world.js';
import { hullOf, COLLARS } from './hulls.js';
import { mateRotation, planeView, turn, shipPortFrame } from './mating.js';
import { berthFrame, berthOf, claimBerth, releaseBerth, stationModel, gateId, STATIONS } from './stations.js';
import { systemPerf } from './systems.js';
import { RCS_FUEL_PER_G_MIN, RCS_MAX_G, fuelUsed } from './flight.js';
import { createPlan, portOfTarget } from './nav.js';
import { engageRoute, abortRoute, holdStation } from './autopilot.js';
import { CORRIDOR_M, clearanceFor, clearanceUsed, keepOutM, markOutbound } from './traffic-control.js';
import { CLASSES, PLAYER_CLASS } from './ship-classes.js';
import { applyHit, tumbling, tumbleOf, holdSpin, releaseSpin, despin, spinLeft } from './damage.js';
import { flagOf } from './service.js';
import { crewAboard, passengersAboard, setCrewAboard, freeBerths } from './manifest.js';
import { adjustStanding, cite } from './law.js';
import { PLAYER, isOutOfFight } from './combatants.js';

/** Game seconds per real second in docking mode (the HUD's rate buttons). */
export const PROX_RATES = [1, 5, 20, 60];
export const CAPTURE_MIN = 2;       // latches to hard dock
export const SEAL_MIN = 3;          // equalize and open the lock
export const UNDOCK_MIN = 2;        // vent, unlatch
export const CLEAR_M = 150;         // the hold point after separation
const OUT_PAST = 1.03;              // leaving: let go this far out, in gates (just through it)
const OUT_MS = 180;                 // …climbing to it no faster than this (traffic-control.js KEEPOUT_SPEED_MS, kept 10% under)
const SHIP_CORRIDOR_M = 300;        // a ship's corridor is shorter than a station's
const APPROACH_G = 0.1;             // the final approach, inside the gate
const APPROACH_CRUISE_MS = 150;     // …under the keep-out limit
const BUMP_DP_PER_KJ = 1 / 60;      // collar strikes: hull damage per kJ over the first 200
const RAD = Math.PI / 180;

// ---- QUERIES ----

/** Phases in which our ship is held in the berth's frame (no flight step). */
const HELD = new Set(['approach', 'spin', 'prox', 'capture', 'seal', 'docked', 'undock', 'separate', 'holding', 'outbound']);
/** Phases flown second by second, on RCS (the pilot may fly them). */
const PROX = new Set(['prox', 'separate']);
/** …and with the final approach, every phase flown second by second in the berth's frame. */
const IN_FRAME = new Set(['approach', 'spin', 'prox', 'separate', 'outbound']);
/** Phases a dock at a station can be left from for somewhere else (beginDocking chains through clearOff). */
const LEAVING_FROM = new Set(['docked', 'undock', 'separate', 'holding', 'outbound', 'approach']);

export const dockHolds = (state) => !!state.dock && HELD.has(state.dock.phase);
export const proxActive = (state) => !!state.dock && PROX.has(state.dock.phase);
export const inFrame = (state) => !!state.dock && IN_FRAME.has(state.dock.phase);
export const isDocked = (state) => state.dock?.phase === 'docked';

/** What we are docked to (a station or a ship), or null. */
export function dockedTo(state) {
  if (!isDocked(state)) return null;
  return getWorld(state).get(state.dock.target.id) || null;
}

/** The station we are docked at, or null (contracts.js: services need a hard seal). */
export function dockedStationEntity(state) {
  const e = dockedTo(state);
  return e?.type === 'station' ? e : null;
}

/** Our collar for a dock. */
function ourPort(state, d) {
  const h = hullOf(state.ship.classId || PLAYER_CLASS);
  return h.ports.find(p => p.id === d.port) || h.ports[0];
}

/** The other side's collar spec (a station berth or a ship's port). */
function theirCollar(state, d) {
  if (d.target.kind === 'station') return berthOf(d.target.id, d.berth);
  const e = getWorld(state).get(d.target.id);
  return e ? hullOf(e.cls)?.ports.find(p => p.id === d.berth) || null : null;
}

/** A ship's nose direction (an agent flies its own; a ship on rails points along its heading). */
export const facingOf = (e) => e.nav?.facing ?? e.heading ?? 0;

/**
 * The collar frame we dock to, at `minute`: { pos (AU), vel (m/s), normal,
 * up, omega }. A station's berth turns with the station; a ship's collar
 * moves with the ship.
 */
export function collarFrame(state, d, minute = state.clock.minute) {
  const world = getWorld(state);
  const e = world.get(d.target.id);
  if (!e) return null;
  if (d.target.kind === 'station') {
    const b = berthOf(e.id, d.berth);
    return b ? berthFrame(state, e, b, minute) : null;
  }
  const port = theirCollar(state, d);
  if (!port) return null;
  // (a ship's collar at another moment of the minute: where the sim would put the ship then, as the view
  // draws the ship, so the two stay mated on the screen)
  const p = minute !== state.clock.minute ? predictEntity(e, minute, world) : { pos: e.pos, vel: e.vel };
  const fr = shipPortFrame(p.pos, facingOf(e), port);
  return { ...fr, vel: { vx: p.vel.vx, vy: p.vel.vy }, omega: 0 };
}


/**
 * Our pose for a dock state: centre (AU), velocity, facing, view. Our
 * collar sits at the frame's origin plus rel (x along the normal, y along
 * up), our attitude is the mated one turned by the yaw error.
 */
export function dockPose(state, d, fr = collarFrame(state, d)) {
  if (!fr) return null;
  const port = ourPort(state, d);
  const r = d.rel;
  if (d.phase === 'approach' || d.phase === 'outbound' || d.phase === 'spin') {
    // the final approach (and the way out, and a spin match at the corridor's mouth): rel is our centre, and we point where we thrust
    const ox = r.x * fr.normal.x + r.y * fr.up.x, oy = r.x * fr.normal.y + r.y * fr.up.y;
    const w = fr.omega || 0;
    return {
      pos: { x: fr.pos.x + ox / AU_M, y: fr.pos.y + oy / AU_M },
      vel: { vx: fr.vel.vx + r.vx * fr.normal.x + r.vy * fr.up.x - w * oy, vy: fr.vel.vy + r.vx * fr.normal.y + r.vy * fr.up.y + w * ox },
      facing: d.facing ?? state.flight.facing, view: 'top', R: null,
    };
  }
  const R = mateRotation(port.face, fr.normal, fr.up);
  const view = planeView(R);
  const facing = view.facing + r.yaw;
  // our collar's place in the solar frame
  const cx = r.x * fr.normal.x + r.y * fr.up.x, cy = r.x * fr.normal.y + r.y * fr.up.y;
  // and our centre, off the collar by the port's place on our hull (turned by the yaw too)
  const p = turn(R, [port.x, port.y, port.z]);
  const c = Math.cos(r.yaw), s = Math.sin(r.yaw);
  const px = p[0] * c - p[1] * s, py = p[0] * s + p[1] * c;
  const w = fr.omega || 0;
  const ox = cx - px, oy = cy - py;
  return {
    pos: { x: fr.pos.x + ox / AU_M, y: fr.pos.y + oy / AU_M },
    vel: {
      vx: fr.vel.vx + r.vx * fr.normal.x + r.vy * fr.up.x - w * oy,
      vy: fr.vel.vy + r.vx * fr.normal.y + r.vy * fr.up.y + w * ox,
    },
    facing, view: view.view, R,
  };
}

// ---- STARTING A DOCK ----

const zeroRel = () => ({ x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, yaw: 0, pitch: 0, roll: 0, wy: 0, wp: 0, wr: 0 });

/** Is a ship willing (or unable to refuse) to be docked with? */
export function shipDockable(state, e) {
  if (!e || e.type !== 'ship') return { ok: false, text: 'Nothing to dock with.' };
  if (e.tags?.blown) return { ok: false, text: 'Nothing left to dock with: it is in pieces.' };
  const h = e.combat;
  if (e.agent?.mode === 'dock-hold') return { ok: true };
  // A command ship at its post takes its own contractors alongside, and nobody else
  if (e.tags?.command) {
    if (flagOf(state) !== e.faction) return { ok: false, text: `${e.name} is a command ship: it takes only its own navy's contractors alongside.` };
    return e.tags.force?.state === 'post' && !e.agent ? { ok: true } : { ok: false, text: `${e.name} isn't on station yet: it takes ships alongside once it holds its post.` };
  }
  if (isOutOfFight(e) || h?.status === 'disabled' || (h && h.drive < 0.25)) return { ok: true, uninvited: !(h?.status === 'surrendered') };
  if (e.tags?.derelict || e.tags?.wreck) return { ok: true, uninvited: true };
  return { ok: false, text: `${e.name} hasn't agreed to a docking. Hail them first.` };
}

/** Pick the collars for a dock with a ship: ours and theirs, of one size. */
function shipCollars(state, e) {
  const ours = hullOf(state.ship.classId || PLAYER_CLASS).ports;
  const theirs = hullOf(e.cls)?.ports || [];
  for (const o of ours) {
    const t = theirs.find(p => p.size === o.size);
    if (t) return { port: o.id, berth: t.id };
  }
  return null;
}

/**
 * Begin docking with a station (its berth from our clearance) or a ship.
 * Far out, the autopilot flies us to the gate first (`route`, a plan the
 * player chose); close in, it flies the final approach. Returns { ok, text }.
 */
export function beginDocking(state, target, { mode = 'auto', route = null } = {}, emit = () => {}) {
  const world = getWorld(state);
  const e = world.get(target.id);
  if (!e) return { ok: false, text: 'No such target.' };
  const cur = state.dock;
  // Docking somewhere else from a station's berth (or its frame): out of the berth and through its
  // gate first, on RCS (a hold point by a surface port is a hundred metres over its rock), then on
  if (cur && cur.target.kind === 'station' && cur.target.id !== e.id && LEAVING_FROM.has(cur.phase)) {
    if (cur.phase === 'docked') { const r = undock(state, emit); if (!r.ok) return r; }
    else if (cur.phase === 'holding' || cur.phase === 'approach') clearOff(state, emit);
    if (state.dock) {
      state.dock.next = { target: { kind: target.kind, id: e.id }, mode, route: route || null };
      return { ok: true, text: `Leaving ${world.get(cur.target.id)?.name || 'port'} first: out through the gate on RCS, then ${e.name}.` };
    }
  }
  if (cur && cur.target.kind === 'ship' && cur.target.id !== e.id && cur.phase === 'holding') releaseDock(state);
  if (dockHolds(state) && state.dock.phase !== 'holding') return { ok: false, text: state.dock.phase === 'docked' ? 'Docked here already.' : 'Already docking.' };
  let berth = null, port = null;
  if (target.kind === 'station') {
    const cl = clearanceFor(state, e.id).dock;
    if (cl) { berth = cl.berth; port = cl.port; }
  } else {
    const ok = shipDockable(state, e);
    if (!ok.ok) return ok;
    const c = shipCollars(state, e);
    if (!c) return { ok: false, text: `None of our collars mate with ${e.name}'s.` };
    ({ berth, port } = c);
  }
  // Holding off a berth here with no clearance to come back in: stay put and ask (the clearance was used docking)
  if (target.kind === 'station' && !berth && state.dock?.phase === 'holding' && state.dock.target.id === e.id) {
    return { ok: false, text: `Ask ${e.name} traffic control for docking clearance first (hail them).` };
  }
  const dM = Math.hypot(e.pos.x - state.flight.pos.x, e.pos.y - state.flight.pos.y) * AU_M;
  const near = target.kind === 'ship' ? dM < 200_000 : dM < keepOutM(e.id) * 3;
  // Holding off the berth we are cleared for: straight into proximity
  // operations from where we are. Cleared for another berth, the hold's
  // place means nothing there: the final approach starts from where we are.
  const keep = state.dock?.phase === 'holding' && state.dock.target.id === e.id && state.dock.berth === berth && state.dock.port === port;
  const cleared = target.kind === 'ship' || !!berth;
  // (a berth held off and given back keeps its lease; another berth here lets ours go)
  const was = state.dock;
  if (was && !keep && was.target.kind === 'station' && was.berth) { const h = world.get(was.target.id); if (h) releaseBerth(h, was.berth, 'player'); }
  state.dock = {
    target: { kind: target.kind, id: e.id }, berth, port, mode,
    // (a tumbling wreck held off and come back to: the final approach again, and its spin matched)
    phase: keep && cleared && !(target.kind === 'ship' && tumbling(e)) ? 'prox' : near ? (cleared ? 'approach' : 'awaiting') : 'inbound',
    rel: keep ? was.rel : zeroRel(), t: 0, since: state.clock.minute, timer: 0, bumps: 0, fuel: 0, rate: mode === 'manual' ? 1 : 3,
    ...(keep && was.lease ? { lease: was.lease } : {}),
  };
  if (state.dock.phase === 'inbound') {
    const gate = target.kind === 'station' ? world.get(gateId(e.id)) : null;
    const plan = route || createPlan('closing', gate ? { kind: 'entity', id: gate.id } : { kind: 'entity', id: e.id }, { accelG: Math.min(1, state.flight.maxG), standoff: gate ? 1_000 : 20_000, name: 'DOCKING', label: 'to the gate' });
    if (!route) plan.port = portOfTarget(state, plan.target);
    engageRoute(state, plan);
  } else if (state.dock.phase === 'approach') startApproach(state, emit);
  else if (state.dock.phase === 'awaiting') awaitClearance(state, emit);
  emit('dock-begun', { target: e.name, berth, phase: state.dock.phase });
  const where = cleared ? berthLabel(state) : 'a berth';
  return { ok: true, text: state.dock.phase === 'awaiting' ? `Holding at ${e.name}'s gate: request docking clearance from traffic control.` : near ? `Final approach to ${where}.` : `Inbound to ${e.name}'s gate${cleared ? `, then down to ${where}` : ': we will need docking clearance there'}.` };
}

/** Hold at the gate until traffic control clears us to a berth. */
function awaitClearance(state, emit) {
  const d = state.dock;
  d.phase = 'awaiting';
  d.since = state.clock.minute;
  const gate = getWorld(state).get(gateId(d.target.id));
  if (gate && !state.flight.hold) holdStation(state, { kind: 'entity', id: gate.id });
  emit('dock-awaiting', { target: getWorld(state).get(d.target.id)?.name });
}

export function berthLabel(state, d = state.dock) {
  if (!d) return '';
  if (!d.berth) return 'a berth';
  if (d.target.kind === 'station') return berthOf(d.target.id, d.berth)?.label || d.berth;
  const e = getWorld(state).get(d.target.id);
  return `${e?.name || 'the ship'}'s ${hullOf(e?.cls)?.ports.find(p => p.id === d.berth)?.label.toLowerCase() || 'collar'}`;
}

/** The point the final approach flies to: the corridor's mouth, out along the berth's axis. */
export function corridorTarget(d) {
  return { kind: 'port', id: d.target.id, berth: d.berth, offsetM: d.target.kind === 'ship' ? SHIP_CORRIDOR_M : CORRIDOR_M, dockKind: d.target.kind };
}

/** Where our centre is now in a dock's berth frame, and how it moves there (`f`: our place, the flight's by default). */
function centreInFrame(state, d, f = state.flight) {
  const fr = collarFrame(state, d);
  if (!fr) return null;
  const dx = (f.pos.x - fr.pos.x) * AU_M, dy = (f.pos.y - fr.pos.y) * AU_M;
  const w = fr.omega || 0;
  // velocity relative to the frame at our place in it (its turn carries us too)
  const dvx = f.vel.vx - (fr.vel.vx - w * dy), dvy = f.vel.vy - (fr.vel.vy + w * dx);
  return {
    x: dx * fr.normal.x + dy * fr.normal.y, y: dx * fr.up.x + dy * fr.up.y,
    vx: dvx * fr.normal.x + dvy * fr.normal.y, vy: dvx * fr.up.x + dvy * fr.up.y,
  };
}

function startApproach(state, emit) {
  const d = state.dock;
  const c = centreInFrame(state, d);
  if (!c) { abortDocking(state, emit, 'lost the berth'); return; }
  if (state.autopilot) abortRoute(state);
  d.phase = 'approach';
  d.since = state.clock.minute;
  d.rel = { ...zeroRel(), ...c };
  d.facing = state.flight.facing;
  d.t = 0;
  state.flight.hold = null;
  emit('dock-phase', { phase: 'approach', berth: berthLabel(state) });
}

/**
 * One second of the final approach: the docking computer flies us at the
 * corridor's mouth on the drive (0.1G at most), no faster than it could stop
 * in time and never over the keep-out limit, in the berth's frame.
 */
function approachStep(state, dtS, emit) {
  const d = state.dock, r = d.rel;
  const f = state.flight;
  const goal = d.target.kind === 'ship' ? SHIP_CORRIDOR_M : CORRIDOR_M;
  const aMax = Math.min(APPROACH_G, f.maxG > 0 ? f.maxG : APPROACH_G) * G0;
  const ex = r.x - goal, ey = r.y, ez = r.z;
  const dist = Math.hypot(ex, ey, ez);
  const vmax = Math.min(APPROACH_CRUISE_MS, Math.sqrt(2 * 0.6 * aMax * dist));
  const k = dist > 1e-6 ? vmax / dist : 0;
  const tau = 6;
  let ax = (-ex * k - r.vx) / tau, ay = (-ey * k - r.vy) / tau, az = (-ez * k - r.vz) / tau;
  const a = Math.hypot(ax, ay, az);
  if (a > aMax) { ax *= aMax / a; ay *= aMax / a; az *= aMax / a; }
  r.vx += ax * dtS; r.vy += ay * dtS; r.vz += az * dtS;
  r.x += r.vx * dtS; r.y += r.vy * dtS; r.z += r.vz * dtS;
  const g = Math.min(a, aMax) / G0;
  const drive = g > RCS_MAX_G;
  if (drive) {
    // the nose goes where the drive pushes (in the plane)
    const fr = collarFrame(state, d);
    if (fr) d.facing = Math.atan2(ax * fr.normal.y + ay * fr.up.y, ax * fr.normal.x + ay * fr.up.x);
  }
  const kg = fuelUsed(drive ? g : 0, drive ? 0 : g, dtS / MIN_S);
  state.resources.fuel.current = Math.max(0, state.resources.fuel.current - kg);
  d.fuel += kg;
  state.$dockThrust = drive ? g : 0;
  state.$dockRcs = drive ? 0 : g;
  d.t += dtS;
  if (dist < 40 && Math.hypot(r.vx, r.vy, r.vz) < 2) {
    const e = d.target.kind === 'ship' && getWorld(state).get(d.target.id);
    if (e && tumbling(e)) startSpin(state, e, emit); else startProx(state, emit);
  }
}

/**
 * How long a spin match from now takes (s): taking up the turn (longer the
 * faster it is), or flying the arc round the wreck to its collar on the
 * RCS (accelerating, then braking), whichever is longer. { S, arcM, g }.
 */
export function spinMatchS(state, e, minute = state.clock.minute) {
  const rate = tumbleOf(e)?.rate || 0;
  const arcM = Math.abs(spinLeft(e, minute)) * RAD * (SHIP_CORRIDOR_M + (hullOf(e.cls)?.L || 50) / 2);
  const a = Math.max(0.005, ourRcs(state).accel);
  const S = Math.round(Math.max(40 + 10 * rate, 2 * Math.sqrt(arcM / a)));
  return { S, arcM, g: Math.max(SPIN_RCS_G, 4 * arcM / (S * S) / G0) };
}
const SPIN_RCS_G = 0.004;            // what the match takes from the RCS at the least: the turn, and holding the circle round the wreck's centre

/** At the corridor's mouth off a tumbling wreck: take up its turn before proximity operations. */
function startSpin(state, e, emit) {
  const d = state.dock;
  const t0 = state.clock.minute + (d.t || 0) / MIN_S;
  const { S, arcM, g } = spinMatchS(state, e, t0);
  d.phase = 'spin';
  d.since = state.clock.minute;
  d.timer = 0;
  d.spinS = S;
  d.spinG = g;
  d.rel.vx = d.rel.vy = d.rel.vz = 0;
  state.$dockThrust = 0;
  holdSpin(e, t0, S / MIN_S);
  state.flight.spinWith = e.id;
  emit('dock-phase', { phase: 'spin', berth: berthLabel(state), rate: tumbleOf(e).rate, seconds: S, arcM, target: e.name });
}

/** One second of a spin match: held at the corridor's mouth, the RCS taking up the wreck's turn. */
function spinStep(state, dtS, emit) {
  const d = state.dock;
  const g = d.spinG || SPIN_RCS_G;
  const kg = fuelUsed(0, g, dtS / MIN_S);
  state.resources.fuel.current = Math.max(0, state.resources.fuel.current - kg);
  d.fuel += kg;
  state.$dockRcs = g;
  d.timer += dtS;
  d.t += dtS;
  if (d.timer >= d.spinS) startProx(state, emit);
}

/** Enter proximity operations at the corridor mouth (where the final approach left us). */
function startProx(state, emit) {
  const d = state.dock;
  const fr = collarFrame(state, d);
  if (!fr) { abortDocking(state, emit, 'lost the berth'); return; }
  const port = ourPort(state, d);
  // Where our collar is, in the berth's frame: our centre plus the collar's
  // place on the hull, once the nose is round to the mated attitude
  const c = d.phase === 'approach' || d.phase === 'spin' ? d.rel : centreInFrame(state, d);
  const R = mateRotation(port.face, fr.normal, fr.up);
  const p = turn(R, [port.x, port.y, port.z]);
  const r = d.rel = zeroRel();
  r.x = c.x + p[0] * fr.normal.x + p[1] * fr.normal.y;
  r.y = c.y + p[0] * fr.up.x + p[1] * fr.up.y;
  r.vx = c.vx; r.vy = c.vy;
  d.facing = null;
  state.$dockThrust = 0;
  // Nobody arrives exactly on the axis: drift out of the plane, a few degrees off
  r.z = gaussian() * 3;
  r.vz = gaussian() * 0.05;
  r.yaw = gaussian() * 2.5 * RAD; r.pitch = gaussian() * 2.5 * RAD; r.roll = gaussian() * 8 * RAD;
  d.phase = 'prox';
  d.since = state.clock.minute;
  // (dock.t carries on: the seconds of this minute flown on the approach stand, and prox flies the rest)
  emit('dock-phase', { phase: 'prox', berth: berthLabel(state), mode: d.mode, kind: d.target.kind });
}

// ---- LEAVING ----

/**
 * Leaving a station from the hold point (or from anywhere in the frame
 * short of the berth: an approach turned back): the docking computer takes
 * us up the corridor and out through the gate on RCS. A ship's dock has no
 * gate and no rock under it: it lets go where we are.
 */
export function clearOff(state, emit = () => {}) {
  const d = state.dock;
  if (!d) return { ok: false, text: 'Not docking.' };
  if (!['holding', 'separate', 'approach', 'outbound'].includes(d.phase)) return { ok: false, text: 'Still joined to the collar.' };
  if (d.phase === 'outbound') return { ok: true, text: 'Already climbing out.' };
  const world = getWorld(state);
  const e = world.get(d.target.id);
  const gate = d.target.kind === 'station' && e && world.get(gateId(e.id));
  if (!gate) { releaseDock(state); return { ok: true, text: 'Clear of the collar.' }; }
  // where we are this second: backing out, part of the minute may already be flown (dock.t), and
  // that part stands; coming in on the final approach, we stop dead first (as an abort does)
  const fr = collarFrame(state, d);
  const pose = d.phase === 'separate' && d.t > 0 ? dockPose(state, d, fr) : null;
  const c = d.phase === 'approach' ? { x: d.rel.x, y: d.rel.y, vx: 0, vy: 0 } : centreInFrame(state, d, pose || state.flight);
  if (!c || !fr) { releaseDock(state); return { ok: true, text: 'Clear of the berth.' }; }
  // the point just through the gate, in the berth's frame (it turns with the station: fixed there)
  const now = state.clock.minute;
  const sp = predictEntity(e, now, world).pos, gp = predictEntity(gate, now, world).pos;
  const ox = (sp.x + OUT_PAST * (gp.x - sp.x) - fr.pos.x) * AU_M, oy = (sp.y + OUT_PAST * (gp.y - sp.y) - fr.pos.y) * AU_M;
  const wasFacing = d.phase === 'approach' ? d.facing ?? state.flight.facing : pose?.facing ?? state.flight.facing;
  const t = d.phase === 'separate' ? d.t || 0 : 0;
  d.phase = 'outbound';
  d.since = now;
  d.rel = { ...zeroRel(), ...c };
  d.goal = { x: ox * fr.normal.x + oy * fr.normal.y, y: ox * fr.up.x + oy * fr.up.y };
  d.start = { x: c.x, y: c.y };
  // a gate on the far side of the station: round it by a point off its side, ours, clear of the structure
  const sx = (sp.x - fr.pos.x) * AU_M, sy = (sp.y - fr.pos.y) * AU_M;
  const S = { x: sx * fr.normal.x + sy * fr.normal.y, y: sx * fr.up.x + sy * fr.up.y };
  d.via = roundStation(c, d.goal, S, 0.6 * (stationModel(e.id)?.sizeM || 500) + 200);
  d.facing = wasFacing;
  d.t = t;
  d.cleared = false;
  if (e) releaseBerth(e, d.berth, 'player');
  markOutbound(state, e.id);
  emit('dock-phase', { phase: 'outbound', berth: berthLabel(state), gateKm: STATIONS[e.id]?.gateKm });
  return { ok: true, text: `Climbing out of the corridor on RCS, through the gate at ${STATIONS[e.id]?.gateKm ?? 50} km.` };
}

/** A point to fly by so the line from `a` to `b` misses a station centred at `S` (radius R), or null if it already does. */
function roundStation(a, b, S, R) {
  const dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((S.x - a.x) * dx + (S.y - a.y) * dy) / L2));
  if (Math.hypot(a.x + t * dx - S.x, a.y + t * dy - S.y) >= R) return null;
  // off the station across the line to the gate, on the side we're on
  const gx = b.x - S.x, gy = b.y - S.y, g = Math.hypot(gx, gy) || 1;
  let px = -gy / g, py = gx / g;
  if ((a.x - S.x) * px + (a.y - S.y) * py < 0) { px = -px; py = -py; }
  return { x: S.x + px * 1.5 * R, y: S.y + py * 1.5 * R };
}

/** One second of the climb out: straight at the point past the gate, on RCS, under the keep-out limit. */
function outboundStep(state, dtS, emit = () => {}) {
  const d = state.dock, r = d.rel;
  const aMax = RCS_MAX_G * G0 * Math.min(1, ourRcs(state).accel / Math.max(1e-6, hullOf(state.ship.classId || PLAYER_CLASS).rcs.accel));
  if (aMax <= 0 && !d.rcsOut) { d.rcsOut = true; emit('nav-callout', { level: 'warn', text: 'RCS out: the docking computer cannot move us. We hold here until it is repaired, or the tanks are filled.' }); }
  else if (aMax > 0) d.rcsOut = false;
  const aim = d.via || d.goal;
  const ex = aim.x - r.x, ey = aim.y - r.y;
  const dist = Math.hypot(ex, ey);
  const ux = dist > 1e-6 ? ex / dist : 0, uy = dist > 1e-6 ? ey / dist : 0;
  const tau = 20;
  let ax = (OUT_MS * ux - r.vx) / tau, ay = (OUT_MS * uy - r.vy) / tau, az = (-0.05 * r.z - r.vz) / tau;
  const a = Math.hypot(ax, ay, az);
  if (a > aMax) { ax *= aMax / a; ay *= aMax / a; az *= aMax / a; }
  r.vx += ax * dtS; r.vy += ay * dtS; r.vz += az * dtS;
  r.x += r.vx * dtS; r.y += r.vy * dtS; r.z += r.vz * dtS;
  const g = Math.min(a, aMax) / G0;
  const kg = fuelUsed(0, g, dtS / MIN_S);
  state.resources.fuel.current = Math.max(0, state.resources.fuel.current - kg);
  d.fuel += kg;
  state.$dockThrust = 0;
  state.$dockRcs = g;
  d.t += dtS;
  // there (or past it, along the line we set out on): on to the gate, or through it, and the
  // dock lets go at the next minute (clearGate)
  const st = d.start || aim;
  if (dist < 100 || ex * (aim.x - st.x) + ey * (aim.y - st.y) <= 0) {
    if (d.via) { d.start = { x: d.via.x, y: d.via.y }; d.via = null; }
    else d.cleared = true;
  }
}

/** Through the gate: the dock lets go, and the drive is ours. With no route to fly, we hold where we are. */
function clearGate(state, e, emit) {
  const next = state.dock?.next;
  releaseDock(state);
  if (e) markOutbound(state, e.id);
  emit('dock-phase', { phase: 'clear', station: e?.name });
  if (next) { beginDocking(state, next.target, { mode: next.mode, route: next.route }, emit); return; }
  // bound nowhere yet: on out of the approach on the RCS, to hold past it, the torch free (autopilot.js clearOutTick)
  if (!state.autopilot && e) { state.flight.hold = null; state.flight.leaving = { station: e.id, ux: null, uy: null }; }
}

// ---- PER MINUTE ----

/**
 * Before the flight step: move the dock along its phases. Returns true when
 * our ship is held in the berth's frame this minute (no flight step).
 */
export function dockingTick(state, emit = () => {}) {
  const d = state.dock;
  const world = getWorld(state);
  // (a wreck's turn we took up and are no longer held to: it turns on, to us)
  const sw = state.flight.spinWith;
  if (sw && (!d || d.target.id !== sw || !HELD.has(d.phase))) {
    const e = world.get(sw);
    if (e?.tags?.spinHeld) { releaseSpin(e, state.clock.minute); emit('spin-released', { target: e.name }); }
    state.flight.spinWith = null;
  }
  if (!d) return false;
  const e = world.get(d.target.id);
  const now = state.clock.minute;
  if (!e) {
    // gone (blown up, broken up): whatever phase, the dock lets go of nothing, and we fly free from where it left us
    if (!abortDocking(state, emit, 'the target is gone') || state.dock === d) { state.dock = null; state.$dockView = null; emit('dock-aborted', { why: 'the target is gone' }); }
    return false;
  }

  // A ship we are joined to lights its drive: the collar tears
  if (d.target.kind === 'ship' && HELD.has(d.phase) && d.phase !== 'holding' && (e.thrust || 0) > 0.01) {
    emit('dock-torn', { target: e.name });
    tearLoose(state, emit);
    return true;
  }

  switch (d.phase) {
    case 'inbound':
      if (!state.autopilot) {
        const gate = d.target.kind === 'station' ? world.get(gateId(e.id)) : e;
        const dM = gate ? Math.hypot(gate.pos.x - state.flight.pos.x, gate.pos.y - state.flight.pos.y) * AU_M : Infinity;
        if (dM >= (d.target.kind === 'station' ? keepOutM(e.id) * 0.5 : 60_000)) { emit('dock-aborted', { target: e.name, why: 'the route to the gate was dropped' }); state.dock = null; }
        else if (d.target.kind === 'station' && !d.berth) {
          const cl = clearanceFor(state, e.id).dock;
          if (cl) { d.berth = cl.berth; d.port = cl.port; startApproach(state, emit); } else awaitClearance(state, emit);
        } else startApproach(state, emit);
      }
      return false;
    case 'awaiting': {
      const cl = clearanceFor(state, e.id).dock;
      if (cl) { d.berth = cl.berth; d.port = cl.port; startApproach(state, emit); return true; }
      return false;
    }
    case 'approach':
      return true;
    case 'outbound':
      if (d.cleared) { clearGate(state, e, emit); return false; }
      return true;
    case 'separate': case 'holding':
      // bound elsewhere (beginDocking: d.next): on out through the gate without stopping
      if (d.next && (d.phase === 'holding' || d.rel.x >= CLEAR_M)) clearOff(state, emit);
      return true;
    case 'capture':
      if (now - d.since >= CAPTURE_MIN) { d.phase = 'seal'; d.since = now; emit('dock-phase', { phase: 'seal', berth: berthLabel(state) }); }
      return true;
    case 'seal':
      if (now - d.since >= SEAL_MIN) completeDock(state, emit);
      return true;
    case 'undock':
      if (now - d.since >= UNDOCK_MIN) {
        d.phase = 'separate'; d.since = now; d.t = 0;
        d.rel.vx = 0.05;
        emit('dock-phase', { phase: 'separate', berth: berthLabel(state) });
      }
      return true;
    default:
      return HELD.has(d.phase);
  }
}

/** Fly whatever is left of the minute in proximity operations (the loop may have flown part of it). */
export function finishMinute(state, emit = () => {}) {
  const d = state.dock;
  if (!d || !IN_FRAME.has(d.phase)) { if (d) d.t = 0; return; }
  while (d.t < MIN_S && state.dock === d && IN_FRAME.has(d.phase)) frameStep(state, 1, emit);
  if (state.dock) state.dock.t = 0;
}

/** One second in the berth's frame: the final approach, or proximity operations. */
export function frameStep(state, dtS = 1, emit = () => {}) {
  const d = state.dock;
  if (!d) return;
  if (d.phase === 'approach') approachStep(state, dtS, emit);
  else if (d.phase === 'spin') spinStep(state, dtS, emit);
  else if (d.phase === 'outbound') outboundStep(state, dtS, emit);
  else if (PROX.has(d.phase)) proxStep(state, dtS, emit);
}

/**
 * After the world has moved: put our ship where the dock holds it, in the
 * berth's frame at the new minute. Returns the G the hold takes (none:
 * the frame is free fall, or the station itself holds us).
 */
export function dockHold(state) {
  const d = state.dock;
  if (!d || !HELD.has(d.phase)) return 0;
  const pose = dockPose(state, d);
  if (!pose) return 0;
  const f = state.flight;
  f.pos.x = pose.pos.x; f.pos.y = pose.pos.y;
  f.vel.vx = pose.vel.vx; f.vel.vy = pose.vel.vy;
  f.facing = pose.facing;
  f.thrustG = d.phase === 'approach' ? (state.$dockThrust || 0) : 0;
  f.turning = 0;
  f.hold = null;
  state.$dockView = pose.view;
  return f.thrustG;
}

// ---- PROXIMITY OPERATIONS ----

/** RCS authority of our hull: { accel (m/s² per axis), rot (rad/s) }. */
export function ourRcs(state) {
  const h = hullOf(state.ship.classId || PLAYER_CLASS);
  // (a damaged RCS gives less, never under 15%; a dead one, or dry tanks, nothing)
  const p = state.systems?.units?.rcs ? systemPerf(state, 'rcs') : 1;
  const perf = p > 0 && state.resources.fuel.current > 0 ? Math.max(0.15, p) : 0;
  return { accel: h.rcs.accel * perf, rot: h.rcs.rotDeg * RAD * perf };
}

/** The pilot's stick (manual): translation and rotation, each −1…1. Runtime only. */
export function setDockInput(state, input) {
  state.$dockInput = { tx: 0, ty: 0, tz: 0, yaw: 0, pitch: 0, roll: 0, ...input };
}

export function setDockMode(state, mode) {
  if (!state.dock) return false;
  state.dock.mode = mode;
  if (mode === 'auto') state.$dockInput = null;
  return true;
}

/** The docking computer kills our drift: relative velocity nulled over the next seconds. */
export function killDrift(state) {
  if (state.dock) state.dock.killDrift = 8;
}

/**
 * The docking computer's approach: closing speed in proportion to range
 * (2% of it a second, capped, slowest at the collar), lateral error and
 * attitude nulled first; it waits at ten metres until it is lined up.
 */
function autopilotStick(state, d, rcs) {
  const r = d.rel;
  const port = ourPort(state, d);
  const col = COLLARS[port.size];
  const out = d.phase === 'separate' || d.backingOut;
  if (d.retreat && r.x >= d.retreat) d.retreat = 0;
  let vxWant;
  // (backing out: slow off the collar, 1 m/s clear of it; a route waiting (departing) goes on through the hold point)
  if (out) vxWant = Math.min(1, 0.1 + 0.02 * r.x) * (r.x < CLEAR_M || (d.departing && state.autopilot) || d.next ? 1 : 0);
  else if (d.retreat) vxWant = 0.3;                 // after a bump: back off and line up again
  else {
    const lat = Math.hypot(r.y, r.z);
    const vmax = rcs.accel < 0.1 ? 1.5 : 3;
    const creep = col.captureMS * 0.4;
    // no faster than half the RCS can stop short of the collar
    const brake = Math.sqrt(2 * 0.5 * rcs.accel * Math.max(0, r.x - 0.3)) + creep;
    vxWant = -Math.min(vmax, brake, Math.max(creep, 0.02 * r.x));
    if (r.x < 12 && (lat > col.missM * 0.5 || Math.abs(r.yaw) > col.angleDeg * 0.5 * RAD || Math.abs(r.pitch) > col.angleDeg * 0.5 * RAD || Math.abs(r.roll) > col.rollDeg * 0.5 * RAD)) vxWant = r.x < 6 ? 0.03 : 0;
  }
  const tau = 4;
  const latCap = (v) => Math.max(-0.5, Math.min(0.5, v));
  const ax = (vxWant - r.vx) / tau;
  const ay = (latCap(-0.05 * r.y) - r.vy) / tau;
  const az = (latCap(-0.05 * r.z) - r.vz) / tau;
  return { ax, ay, az, yaw: -r.yaw, pitch: -r.pitch, roll: -r.roll, auto: true };
}

/** One second (dtS) of proximity operations. */
export function proxStep(state, dtS = 1, emit = () => {}) {
  const d = state.dock;
  if (!d || !PROX.has(d.phase)) return;
  const r = d.rel;
  const rcs = ourRcs(state);
  let cmd;
  if (d.mode === 'manual' && d.phase === 'prox' && !d.backingOut) {
    const i = state.$dockInput || {};
    cmd = { ax: -(i.tx || 0) * rcs.accel, ay: (i.ty || 0) * rcs.accel, az: (i.tz || 0) * rcs.accel, yawRate: (i.yaw || 0) * rcs.rot, pitchRate: (i.pitch || 0) * rcs.rot, rollRate: (i.roll || 0) * rcs.rot, manual: true };
    if (d.killDrift > 0) { cmd.ax = -r.vx / 2; cmd.ay = -r.vy / 2; cmd.az = -r.vz / 2; d.killDrift -= dtS; }
  } else cmd = autopilotStick(state, d, rcs);

  // Translation: each axis capped at the RCS's authority
  const cap = (a) => Math.max(-rcs.accel, Math.min(rcs.accel, a));
  const ax = cap(cmd.ax), ay = cap(cmd.ay), az = cap(cmd.az);
  r.vx += ax * dtS; r.vy += ay * dtS; r.vz += az * dtS;
  const x0 = r.x;
  r.x += r.vx * dtS; r.y += r.vy * dtS; r.z += r.vz * dtS;
  // Attitude: the computer holds what the stick doesn't command
  const rot = (err, rate, want) => {
    const goal = want != null ? want : Math.max(-rcs.rot, Math.min(rcs.rot, -err * 0.3));
    return rate + Math.max(-rcs.rot * dtS, Math.min(rcs.rot * dtS, goal - rate));
  };
  if (cmd.manual) {
    r.wy = rot(r.yaw, r.wy, cmd.yawRate || null); r.wp = rot(r.pitch, r.wp, cmd.pitchRate || null); r.wr = rot(r.roll, r.wr, cmd.rollRate || null);
  } else {
    r.wy = rot(r.yaw, r.wy, null); r.wp = rot(r.pitch, r.wp, null); r.wr = rot(r.roll, r.wr, null);
  }
  r.yaw += r.wy * dtS; r.pitch += r.wp * dtS; r.roll += r.wr * dtS;
  // Reaction mass: RCS at its usual rate
  const g = Math.hypot(ax, ay, az) / G0;
  const kg = RCS_FUEL_PER_G_MIN * g * dtS / MIN_S;
  state.resources.fuel.current = Math.max(0, state.resources.fuel.current - kg);
  d.fuel += kg;
  state.$dockRcs = g;
  d.t += dtS;

  if (d.phase === 'prox' && x0 > 0 && r.x <= 0) contact(state, emit);
  else if (d.phase === 'prox' && r.x < 25 && Math.hypot(r.y, r.z) > 25) strikeStructure(state, emit);
  else if ((d.phase === 'separate' || d.backingOut) && r.x >= CLEAR_M && Math.abs(r.vx) < 0.05) {
    const wasAbort = d.backingOut;
    d.phase = 'holding'; d.backingOut = false; d.since = state.clock.minute;
    r.vx = r.vy = r.vz = 0;
    emit('dock-phase', { phase: 'holding', berth: berthLabel(state), aborted: !!wasAbort });
  }
}

/** Collars meet: inside the envelope it is a capture, outside a bump. */
function contact(state, emit) {
  const d = state.dock, r = d.rel;
  const port = ourPort(state, d);
  const col = COLLARS[port.size];
  const closing = -r.vx;
  const miss = Math.hypot(r.y, r.z);
  const angle = Math.max(Math.abs(r.yaw), Math.abs(r.pitch)) / RAD;
  const roll = Math.abs(r.roll) / RAD;
  const fits = closing <= col.captureMS && miss <= col.missM && angle <= col.angleDeg && roll <= col.rollDeg;
  if (fits) {
    Object.assign(r, zeroRel());
    d.phase = 'capture';
    d.since = state.clock.minute;
    emit('dock-capture', { berth: berthLabel(state), closing, miss, angle, roll });
    return;
  }
  bump(state, { closing, miss, angle, roll, col }, emit);
}

/**
 * A miss or a hard contact: the hulls rebound. Over the collar's capture
 * speed twice over the collar is damaged; with real energy behind it the
 * hull is (our mass, the closing speed: kJ over the first 200).
 */
function bump(state, b, emit) {
  const d = state.dock, r = d.rel;
  d.bumps++;
  r.x = 0.1;
  r.vx = Math.max(0.05, b.closing * 0.35);
  r.vy *= -0.4; r.vz *= -0.4;
  r.wy += (random() - 0.5) * 0.02; r.wp += (random() - 0.5) * 0.02;
  const massT = CLASSES[state.ship.classId || PLAYER_CLASS].massT;
  const kJ = 0.5 * massT * 1000 * b.closing * b.closing / 1000;
  const dp = Math.max(0, kJ - 200) * BUMP_DP_PER_KJ;
  const why = b.closing > b.col.captureMS ? `too fast (${b.closing.toFixed(2)} m/s, the collar takes ${b.col.captureMS})`
    : b.miss > b.col.missM ? `off the axis by ${b.miss.toFixed(2)} m`
    : b.angle > b.col.angleDeg ? `${b.angle.toFixed(1)}° off the axis` : `rolled ${b.roll.toFixed(1)}° out of the latches`;
  const damaged = b.closing > b.col.captureMS * 2;
  if (damaged && d.target.kind === 'station') damageBerth(state, d, emit);
  if (dp > 0) applyHit(state, PLAYER, { dp, section: 'hull', kind: 'collision', from: d.target.id, weapon: 'collision' }, emit);
  emit('dock-bump', { berth: berthLabel(state), why, closing: b.closing, dp, damaged });
  // The docking computer backs off and tries again; after four bumps it gives up
  if (d.mode === 'auto') {
    d.retreat = 20;
    if (d.bumps >= 4) { d.backingOut = true; emit('dock-aborted', { why: 'the docking computer could not make a clean capture', backingOut: true }); }
  }
  // A hard contact is reckless flying in controlled space
  if (b.closing > 1 && d.target.kind === 'station') {
    const st = getWorld(state).get(d.target.id);
    if (st) cite(state, st.faction, { station: st.id, kind: 'collision with a berth', amount: Math.round(200 + dp * 30) }, emit);
  }
}

/** Far off the axis close in: we hit the arm, the tower, the other hull. */
function strikeStructure(state, emit) {
  const d = state.dock, r = d.rel;
  const v = Math.hypot(r.vx, r.vy, r.vz);
  bump(state, { closing: Math.max(v, 0.3), miss: Math.hypot(r.y, r.z), angle: 0, roll: 0, col: COLLARS[ourPort(state, d).size] }, emit);
  r.x = 25; r.vx = 0.2;
}

/** A berth struck hard is out of service until the station's crews fix it. */
function damageBerth(state, d, emit) {
  const st = getWorld(state).get(d.target.id);
  if (!st) return;
  st.berthsOut ||= {};
  st.berthsOut[d.berth] = state.clock.minute + 12 * 60;
  emit('berth-damaged', { station: st.name, berth: d.berth });
}

function completeDock(state, emit) {
  const d = state.dock;
  const e = getWorld(state).get(d.target.id);
  d.phase = 'docked';
  d.since = state.clock.minute;
  d.at = state.clock.minute;
  if (d.target.kind === 'station') {
    claimBerth(e, d.berth, 'player');
    clearanceUsed(state, e.id);
    landSurvivors(state, e, emit);
  } else if (e) {
    if (e.agent) {
      e.agent.mode = e.agent.mode === 'dock-hold' ? 'docked' : e.agent.mode;
      e.agent.dockedWith = PLAYER;
    }
    // a wreck whose turn we took up: mated, our RCS kills the pair's (the bigger the wreck, the longer)
    if (e.tags?.spinHeld) {
      const ratio = Math.max(0.3, Math.min(6, (hullOf(e.cls)?.L || 50) / (hullOf(state.ship.classId || PLAYER_CLASS)?.L || 50)));
      const kg = fuelUsed(0, SPIN_RCS_G, ratio * 1.5);
      state.resources.fuel.current = Math.max(0, state.resources.fuel.current - kg);
      d.fuel += kg;
      despin(e, state.clock.minute);
      state.flight.spinWith = null;
      emit('nav-callout', { level: 'info', key: 'dock', text: `Mated with the ${e.name}: the RCS kills the pair's tumble. It will turn no more when we let go.` });
    }
    if (e.tags?.rescue) takeSurvivors(state, e, emit);
  }
  emit('docked', { target: e?.name, kind: d.target.kind, id: d.target.id, berth: berthLabel(state), fuel: d.fuel, bumps: d.bumps });
}

/** A crew we offered to take off comes across the collar (dialogue.js 'rescue'). */
function takeSurvivors(state, e, emit) {
  const room = freeBerths(state);
  const n = Math.min(e.tags.rescue, room, crewAboard(e) + passengersAboard(e));
  e.tags.rescue = 0;
  if (n <= 0) return;
  const crew = Math.min(n, crewAboard(e));
  setCrewAboard(e, crewAboard(e) - crew);
  if (n > crew) e.paxAboard = Math.max(0, passengersAboard(e) - (n - crew));
  state.passengers.push({ kind: 'survivors', count: n, faction: e.faction, from: e.id, name: e.name, at: state.clock.minute });
  e.tags.helped = true;
  emit('survivors-aboard', { count: n, from: e.name, text: `${n} survivors from ${e.name} come across the collar.` });
}

/** Survivors we carry go ashore at the first station we dock at: thanked, and paid salvage money. */
function landSurvivors(state, st, emit) {
  const groups = state.passengers.filter(p => p.kind === 'survivors');
  if (!groups.length) return;
  let n = 0;
  for (const g of groups) { n += g.count; if (g.faction in state.law.standing) adjustStanding(state, g.faction, 1 + g.count * 0.5); }
  state.passengers = state.passengers.filter(p => p.kind !== 'survivors');
  const pay = n * 300;
  state.resources.credits.current += pay;
  emit('survivors-landed', { count: n, station: st.name, credits: pay, text: `${n} survivors ashore at ${st.name}. The port pays ${pay.toLocaleString()} MCR salvage money.` });
}

// ---- LEAVING ----

/** Undock: vent the lock, let go of the latches, back out. A station wants a departure clearance first. */
export function undock(state, emit = () => {}, { evicted = false } = {}) {
  const d = state.dock;
  if (!d || d.phase !== 'docked') return { ok: false, text: 'Not docked.' };
  if (state.ship.crew.some(m => m.away)) return { ok: false, text: 'Crew are aboard the other side. Recall them first.' };
  const e = getWorld(state).get(d.target.id);
  // (thrown off the berth by the station itself, there's no clearance to have asked for)
  if (d.target.kind === 'station' && e && !evicted && !clearanceFor(state, e.id).depart) {
    cite(state, e.faction, { station: e.id, kind: 'undocking without departure clearance', amount: 200 }, emit);
    emit('tc-warning', { station: e.id, name: e.name, key: 'undock', level: 'warn', text: `${e.name.split(' ')[0]} Dock: you are releasing without clearance. That's a citation.` });
  }
  d.phase = 'undock';
  d.since = state.clock.minute;
  if (d.target.kind === 'station') markOutbound(state, d.target.id);
  emit('dock-phase', { phase: 'undock', berth: berthLabel(state) });
  return { ok: true, text: 'Venting the lock. Latches release in two minutes.' };
}

/** The dock lets go of us (a route takes over from the hold point). */
export function releaseDock(state) {
  const d = state.dock;
  if (!d) return;
  const e = getWorld(state).get(d.target.id);
  if (d.target.kind === 'station' && e) releaseBerth(e, d.berth, 'player');
  if (d.target.kind === 'ship' && e?.agent?.dockedWith === PLAYER) { e.agent.dockedWith = null; if (e.agent.mode === 'docked') e.agent.mode = 'drift'; }
  state.dock = null;
  state.$dockView = null;
}

/** Back out of an approach (or call off a dock that hasn't sealed). */
export function abortDocking(state, emit = () => {}, why = 'aborted') {
  const d = state.dock;
  if (!d) return false;
  if (d.phase === 'inbound' || d.phase === 'awaiting') { abortRoute(state, emit); state.dock = null; emit('dock-aborted', { why }); return true; }
  if (d.phase === 'approach' || d.phase === 'spin') {
    // (a match called off: we stop turning with the wreck, and it tumbles on, to us)
    if (d.phase === 'spin') { const e = getWorld(state).get(d.target.id); if (e) releaseSpin(e, state.clock.minute + (d.t || 0) / MIN_S); state.flight.spinWith = null; }
    d.phase = 'holding'; d.rel.vx = d.rel.vy = d.rel.vz = 0; emit('dock-aborted', { why, holding: true }); return true;
  }
  if (d.phase === 'prox') { d.backingOut = true; emit('dock-aborted', { why, backingOut: true }); return true; }
  if (d.phase === 'capture' || d.phase === 'seal') { d.phase = 'separate'; d.rel.vx = 0.1; d.since = state.clock.minute; emit('dock-aborted', { why, backingOut: true }); return true; }
  return false;
}

/** The other ship lit its drive (or we were hit loose): we tumble off its collar. */
function tearLoose(state, emit) {
  const d = state.dock;
  const wasDocked = d.phase === 'docked' || d.phase === 'seal' || d.phase === 'capture';
  if (d.target.kind === 'ship') {
    const e = getWorld(state).get(d.target.id);
    if (e?.agent) e.agent.dockedWith = null;
  }
  if (wasDocked) applyHit(state, PLAYER, { dp: 8, section: 'hull', kind: 'collision', weapon: 'collision' }, emit);
  // free flight from here: the hold point is behind us
  const pose = dockPose(state, d);
  state.dock = null;
  if (pose) { state.flight.pos.x = pose.pos.x; state.flight.pos.y = pose.pos.y; }
}

// ---- NEW GAMES, TESTS ----

/**
 * Docked at a station from the start (a new game, a test): in a free berth
 * that takes one of our collars, sealed.
 */
export function dockInstant(state, stationId) {
  const world = getWorld(state);
  const st = world.get(stationId);
  if (!st) return false;
  const ports = hullOf(state.ship.classId || PLAYER_CLASS).ports;
  const m = stationModel(stationId);
  const free = m.berths.filter(b => !st.berths?.[b.id]);
  let pick = null;
  for (const b of free) { const p = ports.find(p => p.use === 'crew' && p.face !== 'x+' && b.accepts.includes(p.size)) || ports.find(p => b.accepts.includes(p.size)); if (p) { pick = { b, p }; break; } }
  if (!pick) return false;
  state.dock = { target: { kind: 'station', id: stationId }, berth: pick.b.id, port: pick.p.id, mode: 'auto', phase: 'docked', rel: zeroRel(), t: 0, since: state.clock.minute, at: state.clock.minute, timer: 0, bumps: 0, fuel: 0, rate: 3 };
  claimBerth(st, pick.b.id, 'player');
  state.flight.hold = null;
  dockHold(state);
  return true;
}

/**
 * What hovering off a berth costs while we fly in its frame (G): the
 * frame's own acceleration less what gravity gives us where we are
 * (gravity.js). Next to a surface port it is most of the rock's pull; off
 * an orbital station, next to nothing. Latched or sealed, the station holds
 * us; beside a ship, we fall together.
 */
/** …which is the drive's on the final approach, the RCS's everywhere else. */
export const hoverOnRcs = (state) => state.dock?.phase !== 'approach';
export function hoverG(state) {
  const d = state.dock;
  if (!d || !HOVER.has(d.phase) || d.target.kind !== 'station') return 0;
  const now = state.clock.minute;
  const f0 = collarFrame(state, d, now), f1 = collarFrame(state, d, now + 1);
  if (!f0 || !f1) return 0;
  const g = gravityAt(state.flight.pos.x, state.flight.pos.y, now, _hov);
  const ax = (f1.vel.vx - f0.vel.vx) / MIN_S - g.ax, ay = (f1.vel.vy - f0.vel.vy) / MIN_S - g.ay;
  return Math.hypot(ax, ay) / G0;
}
const HOVER = new Set(['approach', 'prox', 'separate', 'holding', 'outbound']);
const _hov = { ax: 0, ay: 0 };

/** For the HUD and the docking display: where the dock stands. */
export function dockStatus(state) {
  const d = state.dock;
  if (!d) return null;
  const e = getWorld(state).get(d.target.id);
  const port = ourPort(state, d);
  const col = COLLARS[port.size];
  const r = d.rel;
  return {
    phase: d.phase, mode: d.mode, target: e?.name || '—', kind: d.target.kind, berth: berthLabel(state), port, collar: col,
    range: r.x, closing: -r.vx, lateral: Math.hypot(r.y, r.z), y: r.y, z: r.z, vy: r.vy, vz: r.vz,
    toGo: d.phase === 'outbound' && d.goal ? Math.hypot(d.goal.x - r.x, d.goal.y - r.y)
      : d.phase === 'approach' ? Math.hypot(r.x - (d.target.kind === 'ship' ? SHIP_CORRIDOR_M : CORRIDOR_M), r.y, r.z) : null,
    yaw: r.yaw / RAD, pitch: r.pitch / RAD, roll: r.roll / RAD, fuel: d.fuel, bumps: d.bumps, tumble: d.phase === 'spin' && e ? tumbleOf(e)?.rate || 0 : 0,
    timer: d.phase === 'spin' ? Math.max(0, (d.spinS - d.timer) / MIN_S) : d.phase === 'capture' ? CAPTURE_MIN - (state.clock.minute - d.since) : d.phase === 'seal' ? SEAL_MIN - (state.clock.minute - d.since) : d.phase === 'undock' ? UNDOCK_MIN - (state.clock.minute - d.since) : null,
    rate: PROX_RATES[d.rate ?? 3],
  };
}

/** Docking-mode rate (game seconds per real second). */
export function setProxRate(state, i) {
  if (state.dock) state.dock.rate = Math.max(0, Math.min(PROX_RATES.length - 1, i));
}

