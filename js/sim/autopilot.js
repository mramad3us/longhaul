// ============================================================
// LONGHAUL — Autopilot & station-keeping
//
// Lifecycle of a route:
//   prepare — all hands to crash couches, pilot at the helm. Engages
//             automatically when everyone able is strapped in, or on
//             the captain's override (unsecured crew may get hurt).
//             Leaving a port, the docking computer climbs out of its
//             gate on RCS meanwhile (docking.js outbound).
//   depart  — leaving a port, the route's first leg: on the RCS out of
//             the station's approach before the drive lights (no
//             fines for a burn across the port).
//   active  — guidance flies the plan (burn / flip / brake / coast /
//             RCS approach), re-planning every minute.
//   arrive  — co-moving within the standoff: hold station on target.
// A stance (stance.js) goes through prepare and active the same way but
// never arrives: it keeps its relation to the target, flown, until it is
// released, the target is lost, or another route replaces it.
//
// Crew safety. A flip throws anyone not strapped in, at any G. So the
// crew are called to the couches for every stretch in which the nav
// computer may turn the ship: preparing, the flip and the half hour before
// it, the end of an approach, a stance moving into place. And whatever the
// plan, the computer won't start a flip with anyone able still on their
// feet: it holds the turn (drive cold, time warp off) until they are in
// (a walk to the couches can take a quarter of an hour), until the captain
// says FLIP NOW, or for half an hour at most.
//
// Holding station: the ship rides with its target at a fixed offset
// (parked off a station, formation with a ship, parking orbit at a
// body). If the target is under thrust, holding means burning with it.
// ============================================================

import { gravityAt, nearestSurface } from './gravity.js';
import { terrainGuard, hoverCmd } from './terrain.js';
import { AU_M, G0, DAY_MIN, MIN_S } from '../core/constants.js';
import { getWorld, predictEntity } from './world.js';
import { targetStateAt, targetName, guidanceStep, portOfTarget, departingFrom, DEPART_OUT } from './nav.js';
import { turnAhead, FLIP_TURN, SLEW_RATE, RCS_MAX_G } from './flight.js';
import { KEEPOUT_SPEED_MS, APPROACH_SPEED_MS, APPROACH_M, keepOutM } from './traffic-control.js';
import { crewSecureStatus } from './crew-ai.js';
import { stanceDoctrine, STANCE_MODES } from './stance.js';
import { isTracked, setSensorRange, SENSOR_RANGES } from './sensors.js';
import { undock, clearOff, releaseDock, dockHolds, proxActive, CLEAR_M } from './docking.js';

/** Begin flying a plan. opts: { missionId, intercept, estimate } */
export function engageRoute(state, plan, opts = {}) {
  if (plan.port === undefined && plan.kind !== 'stance') plan.port = portOfTarget(state, plan.target);
  const f = state.flight;
  state.autopilot = {
    plan: { ...plan, target: { ...plan.target } },
    phase: 'prepare',
    display: 'prepare',
    override: false,
    createdAt: state.clock.minute,
    engagedAt: null,
    ignitedAt: null,
    startPos: { x: f.pos.x, y: f.pos.y },
    fuelStart: state.resources.fuel.current,
    estimate: opts.estimate ? { minutes: opts.estimate.minutes, fuel: opts.estimate.fuel, path: opts.estimate.path } : null,
    missionId: opts.missionId ?? null,
    intercept: opts.intercept ?? null,
    peakG: 0,
    flipIn: Infinity,
    d: null, vClose: 0, relSpeed: 0,
    depart: departingFrom(state, plan),
  };
  return state.autopilot;
}

/**
 * Take up a stance (stance.createStance). The sensors are opened out to a
 * band that holds the stance range: a ship is kept only while it is tracked.
 */
export function engageStance(state, plan, opts = {}) {
  if (plan.target.kind === 'entity') widenSensors(state, plan.standoff);
  return engageRoute(state, plan, opts);
}

/** Open the sensor board out to a band that holds a contact `m` metres away (with room to spare). */
function widenSensors(state, m) {
  const need = 1.25 * m / AU_M;
  if (SENSOR_RANGES[state.sensors.range].au >= need) return;
  const band = SENSOR_RANGES.findIndex(b => b.au >= need);
  setSensorRange(state, band >= 0 ? band : SENSOR_RANGES.length - 1);
}

export function abortRoute(state, emit = () => {}) {
  if (!state.autopilot) return false;
  const name = targetName(state, state.autopilot.plan.target);
  const stance = state.autopilot.plan.kind === 'stance';
  state.autopilot = null;
  state.flight.thrustG = 0;
  emit('route-aborted', { target: name, stance });
  return true;
}

export function overrideSecure(state) {
  if (state.autopilot?.phase !== 'prepare') return false;
  state.autopilot.override = true;
  return true;
}

export const TURN_HOLD_MAX_MIN = 30;      // a flip waits for the crew this long at most (the longest walk to a couch, and then some)

/**
 * The flip interlock: given the command the autopilot is about to fly, hold
 * a flip from rest while anyone able is on their feet. Returns the command
 * to fly (the drive cold, the nose where it is, while held). Running from a
 * torpedo doesn't wait.
 */
export function flipInterlock(state, cmd, emit = () => {}) {
  const ap = state.autopilot, f = state.flight;
  const flip = Math.abs(f.turning || 0) < 0.5 * SLEW_RATE && turnAhead(f, cmd) > FLIP_TURN;
  if (!flip || ap.display === 'evade') { ap.turnHeld = null; return cmd; }
  const st = crewSecureStatus(state);
  const now = state.clock.minute;
  if (!st.unsecured.length || ap.forceTurn || (ap.turnHeld != null && now - ap.turnHeld >= TURN_HOLD_MAX_MIN)) {
    if (st.unsecured.length) emit('turn-forced', { count: st.unsecured.length, names: st.unsecured.map(m => m.name), captain: !!ap.forceTurn });
    ap.turnHeld = null;
    ap.forceTurn = false;
    return cmd;
  }
  if (ap.turnHeld == null) {
    ap.turnHeld = now;
    emit('turn-held', { count: st.unsecured.length, names: st.unsecured.map(m => m.name) });
  }
  ap.display = 'held';
  return { ax: 0, ay: 0, maxG: cmd.maxG };
}

/** The captain's EXECUTE on a held flip. */
export function forceTurn(state) {
  if (state.autopilot?.turnHeld == null) return false;
  state.autopilot.forceTurn = true;
  return true;
}

/** Hold station on a target at the current relative offset. */
export function holdStation(state, target) {
  const tgt = targetStateAt(state, target, state.clock.minute, true);
  if (!tgt) return false;
  const f = state.flight;
  state.flight.hold = {
    ...target,
    ox: (f.pos.x - tgt.pos.x) * AU_M,
    oy: (f.pos.y - tgt.pos.y) * AU_M,
  };
  f.vel.vx = tgt.vel.vx; f.vel.vy = tgt.vel.vy;
  return true;
}

/** Let go of whatever holds us: station-keeping, or a dock's hold point. (Dev tools also tear a hard dock loose.) */
export function releaseHold(state) {
  state.flight.hold = null;
  if (state.dock) releaseDock(state);
}

/**
 * Keep the ship on its held offset for the current minute (after the
 * world has advanced). Returns the G the ship must burn to keep up.
 */
const _hg = { ax: 0, ay: 0 }, _ht = { ax: 0, ay: 0 };

export function holdStep(state) {
  const h = state.flight.hold;
  if (!h) return 0;
  const tgt = targetStateAt(state, h, state.clock.minute, true);
  if (!tgt) { state.flight.hold = null; return 0; }
  const f = state.flight;
  f.pos.x = tgt.pos.x + h.ox / AU_M;
  f.pos.y = tgt.pos.y + h.oy / AU_M;
  f.vel.vx = tgt.vel.vx; f.vel.vy = tgt.vel.vy;
  if (tgt.ground) return 0;                       // resting on the surface: the ground holds us
  // Keeping the place takes the thrust between how the place moves and how
  // we would fall there (gravity.js): nothing on a Keplerian orbit, the
  // body's pull hovering over a surface port's gate
  const now = state.clock.minute;
  const g = gravityAt(f.pos.x, f.pos.y, now, _hg);
  let ax, ay;
  if (tgt.atx != null) { ax = tgt.atx - g.ax; ay = tgt.aty - g.ay; }
  else { const gt = gravityAt(tgt.pos.x, tgt.pos.y, now, _ht); ax = tgt.ax + gt.ax - g.ax; ay = tgt.ay + gt.ay - g.ay; }
  const need = Math.hypot(ax, ay) / G0;
  if (need > 1e-5) f.facing = Math.atan2(ay, ax);
  return need < 1e-5 ? 0 : need;
}

export function holdTargetName(state) {
  const h = state.flight.hold;
  return h ? targetName(state, h) : null;
}

/**
 * One minute of autopilot decision-making. Returns the flight command
 * (or null when not flying), and updates the display status.
 */
export function autopilotTick(state, emit = () => {}) {
  const ap = state.autopilot;
  if (!ap) return null;
  const now = state.clock.minute;
  const plan = ap.plan;
  const tgt = targetStateAt(state, plan.target, now, true);
  if (!tgt) {
    state.autopilot = null;
    emit('route-target-lost', {});
    return null;
  }

  // A route from a berth: undock first (the departure clearance is ours to ask
  // for: traffic-control.js), back out to the hold point, then go
  const d = state.dock;
  if (d && ap.phase === 'prepare' && !isDockRoute(d, plan)) {
    if (d.phase === 'docked') {
      if (!ap.undockAsked) { ap.undockAsked = true; const r = undock(state, emit); if (!r.ok) { state.autopilot = null; emit('route-aborted', { target: targetName(state, plan.target), why: r.text }); return null; } }
      ap.display = 'undock';
      return null;
    }
    if (d.phase === 'inbound' || d.phase === 'awaiting') state.dock = null;     // a new route replaces the docking
    else {
      // out through the gate in the berth's frame, on RCS, before the route has the ship (docking.js clearOff)
      if (d.phase === 'holding' || d.phase === 'approach' || d.phase === 'separate' && d.rel.x >= CLEAR_M) clearOff(state, emit);
      else if (d.phase === 'separate') d.$depart = true;
      if (state.dock) { ap.display = state.dock.phase === 'outbound' ? 'outbound' : 'undock'; return null; }
    }
  }

  if (ap.phase === 'prepare') {
    const st = crewSecureStatus(state);
    ap.display = 'prepare';
    ap.secure = { secured: st.secured, total: st.total, pilotReady: st.pilotReady, pilot: st.pilot?.name || null, helpless: st.helpless.length };
    const allIn = st.unsecured.length === 0;
    if ((st.pilotReady || !st.pilot) && (allIn || ap.override) || (ap.override && !st.pilot)) {
      ap.phase = 'active';
      ap.engagedAt = now;
      state.flight.hold = null;
      emit('route-engaged', { target: targetName(state, plan.target), unsecured: st.unsecured.map(m => m.name), override: ap.override && !allIn, stance: plan.kind === 'stance' ? STANCE_MODES[plan.mode].label : null, departing: ap.depart ? getWorld(state).get(ap.depart.station)?.name || null : null });
    } else {
      // while the crew strap in (RCS is safe on their feet): out of port on the departure leg, or a ship not held by anything keeps its height over a rock (terrain.js)
      if (ap.depart && !state.dock) { const c = departLeg(state, ap, now, emit); if (c) return c; }
      return !state.flight.hold && !state.dock ? hoverCmd(state.flight.pos, state.flight.vel, now, { keepClimb: true }) : null;
    }
  }
  if (ap.depart && !state.dock) {
    const c = departLeg(state, ap, now, emit);
    if (c) {
      // (the route's readouts while guidance waits: range and speed to the target)
      const f = state.flight;
      ap.d = Math.hypot(tgt.pos.x - f.pos.x, tgt.pos.y - f.pos.y) * AU_M;
      ap.relSpeed = Math.hypot(f.vel.vx - tgt.vel.vx, f.vel.vy - tgt.vel.vy);
      ap.display = 'depart';
      return guarded(state, ap, c, { pos: f.pos }, emit);
    }
  }
  if (plan.kind === 'stance') return guarded(state, ap, stanceTick(state, ap, tgt, emit), tgt, emit);

  const arrival = plan.kind === 'transfer' ? arrivalTarget(state, ap) : null;
  const g = guidanceStep(plan, state.flight, now, tgt, arrival);
  ap.d = g.d; ap.vClose = g.vClose; ap.relSpeed = g.relSpeed; ap.flipIn = g.flipIn;
  ap.display = g.phase;
  if (g.arrived) {
    const name = targetName(state, plan.target);
    const fuelUsed = ap.fuelStart - state.resources.fuel.current;
    state.autopilot = null;
    holdStation(state, plan.target);
    emit('route-arrived', { target: name, targetSpec: plan.target, minutes: now - (ap.engagedAt ?? now), fuelUsed, peakG: ap.peakG, missionId: ap.missionId, intercept: ap.intercept });
    return null;
  }
  ap.via = g.via;
  return guarded(state, ap, g.cmd, { pos: g.toward }, emit);
}

// ---- LEAVING A PORT ----

/**
 * Leaving a port, a route doesn't light its drive until we are out of the
 * station's approach (traffic-control.js: the speed limits, and nobody
 * loitering there uncleared): a burn from the gate would cross the port at
 * speed, and the station cites it. So the route begins with a departure leg
 * flown on the RCS alone (no plume), from the gate (docking.js has brought
 * us out through it) to just past the approach's edge: the rock's pull held
 * first, the rest of the RCS pushing out toward the side the route will
 * burn for (never down into the rock), to the speed limit. Then the drive
 * lights, already outbound. The crew may still be strapping in: RCS is safe
 * on their feet.
 */
const DEPART_FAR = 3;                 // …or this far, if the route's burn from there would come back at the station
const DEPART_UP = 0.5;                // within a radius of a rock's ground, the way out climbs at least this much (cosine off the vertical)

/** The departure leg's command this minute, or null when it is over (we are out). */
function departLeg(state, ap, now, emit) {
  const dep = ap.depart;
  const world = getWorld(state);
  const st = world.get(dep.station);
  const f = state.flight;
  const s0 = st && predictEntity(st, now, world);
  const rM = s0 ? Math.hypot(f.pos.x - s0.pos.x, f.pos.y - s0.pos.y) * AU_M : Infinity;
  // Out of the approach: done, unless the route would burn straight back across it (then on, a little further)
  if (rM > APPROACH_M * DEPART_OUT && (rM > APPROACH_M * DEPART_FAR || !burnsBack(state, ap, now, s0))) {
    ap.depart = null;
    if (st) emit('route-departed', { station: st.name, target: targetName(state, ap.plan.target) });
    return null;
  }
  f.hold = null;
  if (dep.ux == null) Object.assign(dep, departDirection(state, ap, now, s0));
  // the way out, climbing off a rock close by
  let ux = dep.ux, uy = dep.uy;
  const sf = nearestSurface(f.pos.x, f.pos.y, now);
  if (sf && sf.alt < sf.body.radius * 1000) {
    const up = ux * sf.ux + uy * sf.uy;
    if (up < DEPART_UP) { ux += (DEPART_UP - up) * sf.ux; uy += (DEPART_UP - up) * sf.uy; const n = Math.hypot(ux, uy); ux /= n; uy /= n; }
  }
  const want = 0.9 * (rM < keepOutM(st.id) ? KEEPOUT_SPEED_MS : APPROACH_SPEED_MS);
  // what holds us against the pull, in the station's frame (a surface port turns with its rock)…
  const s1 = predictEntity(st, now + 1, world);
  const pull = gravityAt(f.pos.x, f.pos.y, now, _pull);
  const hx = (s1.vel.vx - s0.vel.vx) / MIN_S - pull.ax, hy = (s1.vel.vy - s0.vel.vy) / MIN_S - pull.ay;
  // …and the push out, what the RCS has left after it
  const cx = (want * ux - (f.vel.vx - s0.vel.vx)) / MIN_S, cy = (want * uy - (f.vel.vy - s0.vel.vy)) / MIN_S;
  const rcs = RCS_MAX_G * G0 * 0.999;
  const h2 = hx * hx + hy * hy;
  if (h2 >= rcs * rcs) { const h = Math.sqrt(h2); return { ax: hx * rcs / h, ay: hy * rcs / h, depart: true }; }
  const c2 = cx * cx + cy * cy, hc = hx * cx + hy * cy;
  const k = c2 > 0 ? Math.min(1, (-hc + Math.sqrt(hc * hc - c2 * (h2 - rcs * rcs))) / c2) : 0;
  return { ax: hx + k * cx, ay: hy + k * cy, depart: true };
}
const _pull = { ax: 0, ay: 0 };

/** Would the route's burn from here head back toward the station (s0: its place now)? */
function burnsBack(state, ap, now, s0) {
  const f = state.flight;
  const { ux, uy } = departDirection(state, ap, now, s0);
  const rx = f.pos.x - s0.pos.x, ry = f.pos.y - s0.pos.y, r = Math.hypot(rx, ry) || 1;
  return (ux * rx + uy * ry) / r < -0.2;
}

/** Which way the route will burn from here (asked of guidance on a copy of the plan), else toward the target: away from the station. */
function departDirection(state, ap, now, s0) {
  const f = state.flight;
  const tgt = targetStateAt(state, ap.plan.target, now);
  const probe = { ...ap.plan, target: { ...ap.plan.target }, $memo: undefined, $keep: undefined, $coastUntil: undefined, $want: undefined };
  const g = tgt ? guidanceStep(probe, f, now, tgt, ap.plan.kind === 'transfer' ? targetStateAt(state, ap.plan.target, ap.plan.arriveAt) : null) : null;
  let ux = g ? g.cmd.ax : 0, uy = g ? g.cmd.ay : 0;
  if (Math.hypot(ux, uy) < 1e-6 && tgt) { ux = tgt.pos.x - f.pos.x; uy = tgt.pos.y - f.pos.y; }
  if (Math.hypot(ux, uy) < 1e-12) { ux = f.pos.x - s0.pos.x; uy = f.pos.y - s0.pos.y; }
  const n = Math.hypot(ux, uy) || 1;
  return { ux: ux / n, uy: uy / n };
}

/** The terrain guard over the route's command (terrain.js): climb out round a rock in the way. */
function guarded(state, ap, cmd, tgt, emit) {
  if (!state.autopilot) return cmd;
  const f = state.flight;
  const aMax = Math.min(ap.plan.accelG, f.maxG) * G0;
  const g = terrainGuard(f.pos, f.vel, cmd, tgt?.pos, aMax, state.clock.minute, !!ap.climbing);
  if (!g) { if (ap.climbing) { ap.climbing = false; emit('nav-callout', { level: 'info', key: 'terrain', text: 'Clear of the ground. Resuming the route.' }); } return cmd; }
  if (!ap.climbing) { ap.climbing = true; emit('nav-callout', { level: 'warn', key: 'terrain', text: `${g.body} is in the way: climbing out round it.` }); }
  ap.display = 'climb';
  return g;
}

/** Is this route the one a dock is flying (to the gate, or the final approach)? */
function isDockRoute(d, plan) {
  return d.phase === 'inbound' && (plan.name === 'DOCKING' || plan.target.id === `${d.target.id}-gate` || plan.target.id === d.target.id);
}

const STANCE_TRACK_GRACE_MIN = 10;   // minutes a stance flies on without a sensor track

/** A minute of a stance: the doctrine first (running from torpedoes), then the stance itself. */
function stanceTick(state, ap, tgt, emit) {
  const now = state.clock.minute;
  const plan = ap.plan, f = state.flight;
  const name = targetName(state, plan.target);
  // A ship is kept on the sensor track (the board opened out as it draws
  // away): lose it for longer than a sensor sweep or two and the stance is over
  const e = plan.target.kind === 'entity' ? getWorld(state).get(plan.target.id) : null;
  if (e) widenSensors(state, Math.hypot(e.pos.x - f.pos.x, e.pos.y - f.pos.y) * AU_M);
  if (e?.type === 'ship' && !isTracked(state, e.id)) {
    ap.untrackedSince ??= now;
    if (now - ap.untrackedSince >= STANCE_TRACK_GRACE_MIN) {
      state.autopilot = null;
      emit('stance-lost', { target: name });
      return null;
    }
  } else ap.untrackedSince = null;
  const doc = stanceDoctrine(state, plan);
  plan.$underFire = doc.underFire;
  if (doc.evadeFrom) {
    // Turn away and burn from the nearest torpedo: it arrives slowly, long
    // under the PDCs, and has to spend its Δv to catch up
    if (!ap.evading) emit('stance-evading', { target: name, etaS: doc.eta });
    ap.evading = true;
    ap.settled = false;
    ap.unsettledAt ??= now;
    ap.display = 'evade';
    ap.flipIn = Infinity;
    plan.$holding = false;
    const dx = f.pos.x - doc.evadeFrom.x, dy = f.pos.y - doc.evadeFrom.y;
    const d = Math.hypot(dx, dy) || 1;
    const a = Math.min(plan.accelG, f.maxG) * G0;
    return { ax: dx / d * a, ay: dy / d * a, maxG: plan.accelG, lean: true };
  }
  ap.evading = false;
  const g = guidanceStep(plan, f, now, tgt, null);
  ap.d = g.d; ap.vClose = g.vClose; ap.relSpeed = g.relSpeed; ap.flipIn = g.flipIn; ap.range = g.range;
  ap.display = g.phase;
  if (g.settled) {
    // (announced when first in place, and when back in place after a real move)
    if (!ap.settled && (ap.settledOnce !== true || now - (ap.unsettledAt ?? now) >= 10)) {
      emit('stance-settled', { target: name, mode: plan.mode, rangeM: plan.standoff, first: !ap.settledOnce });
      ap.settledOnce = true;
    }
    ap.unsettledAt = null;
  } else {
    ap.unsettledAt ??= now;
  }
  ap.settled = g.settled;
  return g.cmd;
}

function arrivalTarget(state, ap) {
  // Rails targets are exact; refresh a free target's predicted arrival point daily
  if (!ap.$arrival || state.clock.minute - (ap.$arrivalAt ?? -Infinity) >= DAY_MIN) {
    ap.$arrival = targetStateAt(state, ap.plan.target, ap.plan.arriveAt);
    ap.$arrivalAt = state.clock.minute;
  }
  return ap.$arrival;
}

/** Bookkeeping after the flight step (ignition times, peak G, flip display). */
export function autopilotAfterStep(state, out) {
  const ap = state.autopilot;
  if (!ap || ap.phase !== 'active') return;
  if (out.mainG > 0.05 && ap.ignitedAt == null) ap.ignitedAt = state.clock.minute;
  if (out.mainG <= 0.05) ap.ignitedAt = null;
  ap.peakG = Math.max(ap.peakG, out.mainG);
  // A real reorientation (not the small corrections of a burn, or a pilot's hand)
  if (out.rotation > 0.6 && Math.abs(out.turned) > 0.05) ap.display = ap.flipIn === 0 || ap.display === 'brake' ? 'flip' : 'orient';
}

// ---- POLICIES ----

const ENDGAME_S = 60 * 60;          // the last hour of an approach is flown strapped in

/** Should the crew be in couches right now? */
export function crewPolicy(state) {
  if (state.combatStations) return 'secure';
  const f = state.flight;
  if (f.thrustG > 1.5 || (f.hold && holdBurnG(state) > 1.5)) return 'secure';
  if (f.manual && f.manual.throttleG > 1.5) return 'secure';
  const ap = state.autopilot;
  if (!ap) return 'free';
  if (ap.phase === 'prepare' || ap.turnHeld != null) return 'secure';
  if (ap.plan.kind === 'stance') {
    // Settled, or guarding the range on a steady burn, the crew may move
    // about; moving into place, turning to guard, or running from a torpedo,
    // a turn can come any minute
    if (ap.display === 'holding' || ap.display === 'watch' || ap.display === 'guard') return 'free';
    return 'secure';
  }
  if (Math.min(ap.plan.accelG, state.$driveCap ?? f.maxG) > 1.5 && (ap.display === 'burn' || ap.display === 'brake' || ap.display === 'transfer-burn')) return 'secure';
  if (ap.display === 'flip' || ap.display === 'orient') return 'secure';
  if (ap.flipIn <= 30) return 'secure';                               // re-secure ahead of the flip
  if (ap.ignitedAt != null && state.clock.minute - ap.ignitedAt < 10) return 'secure';  // settle into the burn
  // The end of an approach (the last of the brake, the turn into the target's
  // pull, the near zone, the RCS terminal) can turn the ship at any time
  const togo = ap.d == null ? Infinity : ap.d - ap.plan.standoff;
  if (ap.display === 'approach' || ap.plan.$keep || (ap.vClose > 1 && togo / ap.vClose < ENDGAME_S)) return 'secure';
  return 'free';
}

function holdBurnG(state) {
  const h = state.flight.hold;
  if (!h || h.kind !== 'entity') return 0;
  const e = getWorld(state).get(h.id);
  return e && !e.orbit ? (e.thrust || 0) : 0;
}

/**
 * KSP-style time warp limits: fast-forward only through quiet stretches.
 * The tactical picture (inbound ordnance, hostiles close by, a demand
 * awaiting an answer) caps it too — combat.js leaves that in $combatWarp.
 */
export function maxSpeed(state) {
  return Math.min(state.$combatWarp ?? 3, flightSpeedLimit(state));
}

function flightSpeedLimit(state) {
  if (state.combatStations) return 1;
  // Docking: hand-flown proximity operations are flown in real time
  if (state.dock && proxActive(state) && state.dock.mode === 'manual') return 1;
  if (state.dock && dockHolds(state) && state.dock.phase !== 'docked' && state.dock.phase !== 'holding') return 2;
  const ap = state.autopilot;
  const f = state.flight;
  if (f.manual && f.manual.throttleG > 0) return 1;
  if (!ap) return 3;
  if (ap.phase === 'prepare') return 1;
  // A human flying, or nobody flying: no skipping ahead
  if (ap.helm === 'unmanned') return 1;
  const cap = ap.helm === 'manual' || ap.helm === 'degraded' ? 2 : 3;
  if (ap.display === 'flip' || ap.display === 'orient' || ap.turnHeld != null) return 1;
  const stance = ap.plan.kind === 'stance';
  if (stance) {
    if (ap.display === 'evade' || ap.display === 'guard' || ap.display === 'ready') return 1;
    if (ap.display === 'holding' || ap.display === 'watch') return f.thrustG > 0.05 ? 2 : cap;
  }
  if (ap.flipIn <= 15) return 1;
  if (ap.ignitedAt != null && state.clock.minute - ap.ignitedAt < 5) return 1;
  // (a stance measures to its stance point)
  const togo = ap.d == null ? null : stance ? ap.d : ap.d - ap.plan.standoff;
  const eta = ap.vClose > 1 && togo != null ? togo / ap.vClose / 60 : Infinity;
  if (ap.display === 'approach' || eta < 45) return 1;
  if (f.thrustG > 0.05) return 2;
  if (ap.flipIn > 6 * 60 && eta > 12 * 60) return cap;
  return 2;
}

