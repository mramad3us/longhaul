// ============================================================
// LONGHAUL — Navigation: targets, plans, route estimation
//
// A *plan* is a guidance recipe (closing law with a G limit and
// optional cruise cap, a Lambert transfer, or a stance kept on a
// target until released: stance.js). The SAME guidanceStep
// drives the live autopilot and the planner's fast-forward simulation,
// so route previews (ETA, fuel, Δv, drawn trajectory) match what the
// ship will actually fly.
// ============================================================

import { AU_M, G0, MIN_S, GM_SUN, DAY_MIN } from '../core/constants.js';
import { getBody, bodyPos, bodyVel } from './ephemeris.js';
import { getWorld, predictEntity, stepFree, propagateFree, orbitStateAt } from './world.js';
import { slotOrbit } from './holding.js';
import { APPROACH_M, APPROACH_SPEED_MS, KEEPOUT_SPEED_MS, KEEPOUT_EDGE, keepOutM } from './traffic-control.js';
import { surfacePoint, nearestSurface } from './gravity.js';
import { terrainGuard } from './terrain.js';
import { createFlight, flightStep, fuelUsed, RCS_MAX_G, SLEW_RATE } from './flight.js';
import { playerClass, ratedG } from './ship-classes.js';

const RCS_LIMIT = RCS_MAX_G * G0;
import { relativeState, pointFrom, closingLaw, keepLaw, hasArrived, transferLaw, brakingSpeed, flipSeconds, minutesToFlip, BRAKE_MARGIN } from './guidance.js';
import { stanceStep } from './stance.js';
import { solveLambert } from './lambert.js';
import { collarFrame } from './docking.js';
import { knownName } from './flags.js';
import { trackOf } from './intel.js';
import { ourName } from './service.js';

// Standoff distances (m)
export const STANDOFF = {
  STATION: 3_000,        // a ship holding off a station (not a berth: that is docking.js)
  GATE: 1_000,           // a station's approach gate (where routes to a station end)
  SHIP: 2_000,           // formation distance
  SCANNER: 0.1 * AU_M,   // long sensor range
  CLOSE: 100_000_000,    // 100,000 km — full sensor lock, comms
  TACTICAL: 2_000,       // formation: boarding, tow, EVA
  SLOT: 200,             // our slot in a port's holding pattern (holding.js)
};

// ---- TARGETS ----
// target spec: { kind:'body', id:'Mars' } | { kind:'entity', id:'ceres-station' }
//              | { kind:'player' } (NPC guidance flying to our ship)
//              | { kind:'slot', id: stationId, slot } (a place in a port's holding
//                pattern: an orbit, holding.js)
//              | { kind:'surface', id: bodyName, ang } (a place on a body's ground: terrain.js)
//              | { kind:'port', id, berth, offsetM, dockKind } (the mouth of a
//                berth's corridor: a point out along a collar's axis, moving and
//                turning with the station or ship it belongs to: docking.js)
//              | { kind:'fix', id } (where a lost contact's last fix has coasted
//                to, as the plot has it: intel.js. Flown to on the plot's
//                numbers, never the ship's own; the autopilot hands the route
//                to the contact the minute our sensors hold it again)

export function targetName(state, target) {
  if (target.kind === 'body') return target.id;
  if (target.kind === 'surface') return `the surface of ${target.id}`;
  if (target.kind === 'slot') return `${getWorld(state).get(target.id)?.name || 'port'} holding ${target.slot}`;
  if (target.kind === 'player') return ourName(state);
  if (target.kind === 'fix') return `${knownName(state, target.id) || trackOf(state, target.id)?.name || 'unidentified contact'} · last fix`;
  // (a ship by the name we know it by: an unidentified contact is no more than that)
  const e = getWorld(state).get(target.id);
  const name = !e ? 'Unknown' : e.type === 'ship' ? knownName(state, e.id) || 'unidentified contact' : e.name;
  return target.kind === 'port' ? `${name} · ${target.berth}` : name;
}

export function targetExists(state, target) {
  if (target.kind === 'player') return !state.lost;
  if (target.kind === 'slot') return !!getWorld(state).get(target.id) && !!slotOrbit(target.id, target.slot);
  if (target.kind === 'fix') return !!trackOf(state, target.id);
  return target.kind === 'body' || target.kind === 'surface' ? !!getBody(target.id) : !!getWorld(state).get(target.id);
}

/** A corridor mouth at `minute`: the collar's frame, out along its normal. */
function portPoint(state, target, minute) {
  const fr = collarFrame(state, { target: { kind: target.dockKind || 'station', id: target.id }, berth: target.berth }, minute);
  if (!fr) return null;
  const k = target.offsetM || 0, w = fr.omega || 0;
  const ox = fr.normal.x * k, oy = fr.normal.y * k;
  return { pos: { x: fr.pos.x + ox / AU_M, y: fr.pos.y + oy / AU_M }, vel: { vx: fr.vel.vx - w * oy, vy: fr.vel.vy + w * ox } };
}

/** Default stop distance for a target. Bodies: a parking orbit well clear of the surface. */
export function defaultStandoff(state, target) {
  if (target.kind === 'slot') return STANDOFF.SLOT;
  if (target.kind === 'fix') return STANDOFF.SHIP;
  if (target.kind === 'body') {
    const b = getBody(target.id);
    return Math.max(2_000_000, (b?.radius || 0) * 1000 * 3);
  }
  const e = getWorld(state).get(target.id);
  if (e?.tags?.gate) return STANDOFF.GATE;
  return e?.type === 'station' ? STANDOFF.STATION : STANDOFF.SHIP;
}

/**
 * The swing of a circular orbit around its centre at `days`: the part of
 * the orbiter's velocity and acceleration that comes round every period.
 * r in AU, period in days, angle in rad.
 */
function swing(r, period, angle, about) {
  const w = 2 * Math.PI / (period * 86400);
  const c = Math.cos(angle), s = Math.sin(angle);
  const v = w * r * AU_M, a = w * v;
  return { vx: -v * s, vy: v * c, ax: -a * c, ay: -a * s, period: period * 86400, about };
}

/** A moon's swing around its planet (none for planets and asteroids). */
function bodySwings(b, days, out) {
  if (b.parent && b.period > 0) out.push(swing(b.a, b.period, b.initAngle + 2 * Math.PI * days / b.period, b.parent.name));
  return out;
}

/**
 * Target state {pos, vel, ax, ay} at a minute. `live` refreshes entities in
 * place (use for the current minute); otherwise predicts without mutation.
 * Rails targets also give `atx/aty`, their total acceleration, and `swings`:
 * the periodic parts of their motion (a station circling a moon, the moon
 * circling its planet), which guidance follows only near arrival.
 */
export function targetStateAt(state, target, minute, live = false) {
  const out = stateOfTarget(state, target, minute, live);
  if (out) out.t = minute;           // (guidance takes gravity at this moment: gravity.js)
  return out;
}

function stateOfTarget(state, target, minute, live) {
  if (target.kind === 'body') {
    const b = getBody(target.id);
    if (!b) return null;
    const days = minute / DAY_MIN;
    const out = { pos: bodyPos(b, days), vel: bodyVel(b, days), ax: 0, ay: 0 };
    // total acceleration (moons swing around their planet hard) for guidance feed-forward
    // average over the coming step (what the flight integrator will see)
    const v1 = bodyVel(b, (minute + 1) / DAY_MIN), v0 = out.vel;
    out.atx = (v1.vx - v0.vx) / MIN_S; out.aty = (v1.vy - v0.vy) / MIN_S;
    out.swings = bodySwings(b, days, []);
    return out;
  }
  if (target.kind === 'slot') {
    // a slot in a holding pattern: an orbit with no one on it (holding.js)
    const o = slotOrbit(target.id, target.slot);
    if (!o) return null;
    const pos = { x: 0, y: 0 }, vel = { vx: 0, vy: 0 }, p1 = { x: 0, y: 0 }, v1 = { vx: 0, vy: 0 };
    orbitStateAt(o, minute, pos, vel); orbitStateAt(o, minute + 1, p1, v1);
    const days = minute / DAY_MIN;
    const swings = o.period > 0 ? [swing(o.r, o.period, o.phase + 2 * Math.PI * days / o.period, o.body)] : [];
    const b = getBody(o.body);
    if (b) bodySwings(b, days, swings);
    return { pos, vel, ax: 0, ay: 0, atx: (v1.vx - vel.vx) / MIN_S, aty: (v1.vy - vel.vy) / MIN_S, swings };
  }
  if (target.kind === 'surface') {
    // a place on a body's ground, turning with it (where we came down: terrain.js)
    const b = getBody(target.id);
    if (!b) return null;
    const p0 = surfacePoint(b, target.ang, minute), p1 = surfacePoint(b, target.ang, minute + 1);
    return { pos: p0.pos, vel: p0.vel, ax: 0, ay: 0, atx: (p1.vel.vx - p0.vel.vx) / MIN_S, aty: (p1.vel.vy - p0.vel.vy) / MIN_S, swings: [], ground: true };
  }
  if (target.kind === 'player') {
    // NPCs flying to us: our state now, or coasted forward under our current thrust
    const f = state.flight;
    const a = f.thrustG * G0;
    const pos = { x: f.pos.x, y: f.pos.y }, vel = { vx: f.vel.vx, vy: f.vel.vy };
    if (minute > state.clock.minute) propagateFree(pos, vel, state.clock.minute, minute, f.thrustG, f.facing, f.thrustG > 0 ? 1 : 10);
    return { pos, vel, ax: a * Math.cos(f.facing), ay: a * Math.sin(f.facing) };
  }
  if (target.kind === 'fix') {
    // the plot's dead reckoning (intel.estimate): a straight coast on the
    // last fix's velocity. A record that is a filed plan or a berth now is
    // flown to as the ship it names (the nav computer has the same public data)
    const r = trackOf(state, target.id);
    if (!r) return null;
    if (r.kind !== 'fix') return stateOfTarget(state, { kind: 'entity', id: target.id }, minute, live);
    const s = (minute - r.at) * MIN_S;
    return { pos: { x: r.x + r.vx * s / AU_M, y: r.y + r.vy * s / AU_M }, vel: { vx: r.vx, vy: r.vy }, ax: 0, ay: 0, atx: 0, aty: 0, swings: [] };
  }
  if (target.kind === 'port') {
    if (live) { const e = getWorld(state).get(target.id); if (e) { getWorld(state).refresh(e, minute); getWorld(state).hash.update(e); } }
    const p0 = portPoint(state, target, minute);
    if (!p0) return null;
    const p1 = portPoint(state, target, minute + 1);
    const out = { pos: p0.pos, vel: p0.vel, ax: 0, ay: 0 };
    if (p1) { out.atx = (p1.vel.vx - p0.vel.vx) / MIN_S; out.aty = (p1.vel.vy - p0.vel.vy) / MIN_S; }
    out.swings = [];
    return out;
  }
  const world = getWorld(state);
  const e = world.get(target.id);
  if (!e) return null;
  let pos, vel;
  if (live) {
    world.refresh(e, minute);
    world.hash.update(e);
    pos = e.pos; vel = e.vel;
  } else {
    ({ pos, vel } = predictEntity(e, minute, world));
  }
  const tg = e.orbit ? 0 : (e.thrust || 0) * G0;
  const out = { pos, vel, ax: tg * Math.cos(e.heading || 0), ay: tg * Math.sin(e.heading || 0) };
  if (e.orbit || e.transit) {
    // rails motion isn't free fall: give guidance the true total acceleration
    // average over the coming step (what the flight integrator will see)
    const a = predictEntity(e, minute + 1, world).vel;
    out.atx = (a.vx - vel.vx) / MIN_S; out.aty = (a.vy - vel.vy) / MIN_S;
  }
  const b = e.orbit && getBody(e.orbit.body);
  if (b) {
    const days = minute / DAY_MIN, o = e.orbit;
    out.swings = o.period > 0 ? [swing(o.r, o.period, o.phase + 2 * Math.PI * days / o.period, o.body)] : [];
    bodySwings(b, days, out.swings);
  }
  // a station's gate: where its keep-out zone is, so a route in goes round it, not through (keepOutVia)
  const host = e.tags?.gate && world.get(e.tags.gate);
  if (host) { const h = predictEntity(host, minute, world); out.keepOut = { pos: h.pos, vel: h.vel, rM: keepOutM(host.id) * KEEPOUT_CLEAR }; }
  return out;
}

/**
 * Monotonic target predictor for fast-forward simulation: bodies and rails
 * entities are exact at any time; free-flying entities are propagated
 * incrementally from a private copy (O(1) per step, never mutates the world).
 */
export function targetTracker(state, target, t0) {
  if (target.kind === 'body' || target.kind === 'port' || target.kind === 'surface' || target.kind === 'slot' || target.kind === 'fix') return (t) => targetStateAt(state, target, t);
  const e = getWorld(state).get(target.id);
  if (!e) return () => null;
  if (e.orbit || e.transit) return (t) => targetStateAt(state, target, t);
  const { pos, vel } = predictEntity(e, t0);
  const thrust = e.thrust || 0, heading = e.heading || 0;
  const tg = thrust * G0;
  const out = { pos, vel, ax: tg * Math.cos(heading), ay: tg * Math.sin(heading) };
  let tc = t0;
  return (t) => {
    if (t > tc) {
      while (tc < t) {
        const step = Math.min(t - tc, thrust > 0 ? 1 : 30);
        stepFree(pos, vel, step * MIN_S, thrust, heading, tc);
        tc += step;
      }
    }
    out.t = t;          // (guidance takes gravity at the moment of the state: gravity.js)
    return out;
  };
}

// ---- ROUND A ROCK ----

const VIA_R = 4;            // the waypoint stands this many radii from the body's centre
const VIA_NEAR_R = 6;       // a target this close to a body (radii) may be behind it
const VIA_NEXT = 0.1;      // a waypoint reached (this near it, in ring radii) with the target still hidden: the next
const VIA_CLEAR_MIN = 3;    // minutes the line must stay clear before a waypoint is let go
const VIA_TURN = Math.PI / 3;   // the waypoint leads us round by up to this much of the way to the target's side
const KEEPOUT_CLEAR = KEEPOUT_EDGE;   // a station's keep-out, as traffic control draws it (zoneAt), in gates
const KEEPOUT_VIA = 2.5;    // the waypoint round it stands this far out, in keep-outs (room to turn short of the zone)

/**
 * The bearing (unit, from a centre) of a waypoint that leads us round it:
 * ours (u) turned toward the target's (w) by at most VIA_TURN. At 1.3 radii
 * and more, the line to such a point clears the sphere from any distance,
 * and as we move it leads on; dead behind, round the `side` we chose first.
 */
function leadRound(ux, uy, wx, wy, side) {
  let th = Math.atan2(ux * wy - uy * wx, ux * wx + uy * wy);
  if (Math.abs(th) > 170 * Math.PI / 180) th = side * Math.PI;
  const a = Math.sign(th) * Math.min(Math.abs(th), VIA_TURN), c = Math.cos(a), s = Math.sin(a);
  return { x: ux * c - uy * s, y: ux * s + uy * c };
}

/** Does the segment p→q (AU) pass within `rM` of `c`, short of q? */
function segBlocked(p, q, c, rM) {
  const dx = (q.x - p.x) * AU_M, dy = (q.y - p.y) * AU_M, cx = (c.x - p.x) * AU_M, cy = (c.y - p.y) * AU_M;
  const L2 = dx * dx + dy * dy;
  if (L2 <= 0) return false;
  const t = (cx * dx + cy * dy) / L2;
  return t > 0 && t < 0.98 && Math.hypot(cx - t * dx, cy - t * dy) < 1.05 * rM;
}

/**
 * Routes are planned through empty space; a target standing over a rock
 * (a surface port's gate, a holding slot round it) may have the rock
 * between it and us. Then the route flies at a point VIA_R radii out from
 * the body's centre, our bearing from it turned toward the target's
 * (leadRound), moving with the body, and on to the target once the line to it
 * clears. The point is held while we fly at it (a straight leg), and the
 * next set from there once we are near it, so it leads us round: we never
 * catch it and stop there, waiting on a rock that turns the target away
 * from us for hours. Dead behind, the side we went round is kept ($via).
 * Returns that point's state, or null to fly at the target.
 */
function viaPoint(plan, flight, tgt, minute) {
  const s = nearestSurface(tgt.pos.x, tgt.pos.y, minute);
  if (!s || s.r > VIA_NEAR_R * s.body.radius * 1000) { plan.$via = null; return null; }
  const rM = s.body.radius * 1000;
  // from the body: our side, turned toward the target's
  const ox = flight.pos.x - s.center.x, oy = flight.pos.y - s.center.y, ol = Math.hypot(ox, oy) || 1;
  const ux = ox / ol, uy = oy / ol;
  // round far enough when the line to the target has stayed clear a few minutes (no flapping between the two)
  if (!segBlocked(flight.pos, tgt.pos, s.center, rM)) {
    if (!plan.$via || plan.$via.body !== s.body.name || ++plan.$via.clear >= VIA_CLEAR_MIN) { plan.$via = null; return null; }
  } else if (plan.$via) plan.$via.clear = 0;
  if (!plan.$via || plan.$via.body !== s.body.name) plan.$via = { body: s.body.name, side: Math.sign(ux * s.uy - uy * s.ux) || 1, clear: 0 };
  const b = getBody(plan.$via.body);
  const days = minute / DAY_MIN;
  const c = bodyPos(b, days), v = bodyVel(b, days), v1 = bodyVel(b, (minute + 1) / DAY_MIN);
  // (and outside the keep-out of a station built on it: Phobos is 11 km across, its yard's gate 60 km out)
  const k = Math.max(VIA_R * rM, tgt.keepOut ? KEEPOUT_VIA * tgt.keepOut.rM + rM : 0) / AU_M;
  // the point, held while we fly at it: first halfway round between our side and the target's (dead
  // behind, round the side chosen); reached with the target still hidden, the next from there, turned on
  // round by VIA_TURN (else we would wait at it on a rock turning the target away for hours)
  const P = plan.$via;
  if (P.dx == null) {
    let dx = ux + s.ux, dy = uy + s.uy;
    if (Math.hypot(dx, dy) < 0.2) { dx = -uy * P.side; dy = ux * P.side; }
    const l = Math.hypot(dx, dy); P.dx = dx / l; P.dy = dy / l;
  } else if (Math.hypot(c.x + P.dx * k - flight.pos.x, c.y + P.dy * k - flight.pos.y) < VIA_NEXT * k) {
    const d = leadRound(ux, uy, s.ux, s.uy, P.side);
    P.dx = d.x; P.dy = d.y;
  }
  return { pos: { x: c.x + plan.$via.dx * k, y: c.y + plan.$via.dy * k }, vel: v, ax: 0, ay: 0, atx: (v1.vx - v.vx) / MIN_S, aty: (v1.vy - v.vy) / MIN_S, swings: [], t: minute };
}

/**
 * A route to a station's gate that would cut through its keep-out zone
 * (coming in from the station's far side) flies first at a point just
 * outside the zone, turned from our side toward the gate's (leadRound), held
 * while we fly at it and the next set once we are near, as viaPoint does
 * round a rock. Returns that point's state, or null to fly at the gate.
 */
function keepOutVia(plan, flight, tgt) {
  const K = tgt.keepOut;
  if (!K) { plan.$kvia = null; return null; }
  if (!segBlocked(flight.pos, tgt.pos, K.pos, K.rM / 1.05)) {
    if (!plan.$kvia || ++plan.$kvia.clear >= VIA_CLEAR_MIN) { plan.$kvia = null; return null; }
  } else if (plan.$kvia) plan.$kvia.clear = 0;
  const ox = flight.pos.x - K.pos.x, oy = flight.pos.y - K.pos.y, ol = Math.hypot(ox, oy) || 1;
  const gx = tgt.pos.x - K.pos.x, gy = tgt.pos.y - K.pos.y, gl = Math.hypot(gx, gy) || 1;
  const ux = ox / ol, uy = oy / ol, wx = gx / gl, wy = gy / gl;
  if (!plan.$kvia) plan.$kvia = { side: Math.sign(ux * wy - uy * wx) || 1, clear: 0 };
  const P = plan.$kvia, k = KEEPOUT_VIA * K.rM / AU_M;
  // (held while we fly at it, the next set once we are near: as viaPoint)
  if (P.dx == null || Math.hypot(K.pos.x + P.dx * k - flight.pos.x, K.pos.y + P.dy * k - flight.pos.y) < VIA_NEXT * k) {
    const d = leadRound(ux, uy, wx, wy, P.side);
    P.dx = d.x; P.dy = d.y;
  }
  return { pos: { x: K.pos.x + P.dx * k, y: K.pos.y + P.dy * k }, vel: K.vel, ax: 0, ay: 0, atx: tgt.atx, aty: tgt.aty, swings: [], t: tgt.t };
}

// ---- PORTS ----

const PORT_LOOKAHEAD_S = 150;   // (margin on the closing law's own curve, which allows for its flip: 240 s had
                                // the gate's 200 m/s on from 500 km out, and the last stretch crawled for an hour)
const ROCK_R = 5, ROCK_SPEED_MS = 1000;

/**
 * The station a target belongs to (a station, its gate, a berth's
 * corridor, a holding slot) and how far the target lies from it:
 * { id, offM, keepM }, or null. Plans into a port carry it, and keep to the
 * port's speed limits on the way in.
 */
export function portOfTarget(state, target) {
  const world = getWorld(state);
  let id = null;
  if (target.kind === 'slot' || target.kind === 'port') id = target.id;
  else if (target.kind === 'entity') { const e = world.get(target.id); id = e?.type === 'station' ? e.id : e?.tags?.gate || null; }
  const st = id && world.get(id);
  if (!st || st.type !== 'station') return null;
  const t = targetStateAt(state, target, state.clock.minute);
  if (!t) return null;
  const sp = predictEntity(st, state.clock.minute, world).pos;     // (a far station's stored place can be hours old)
  // a port on (or close round) a small rock: slower still near it, where a
  // fast ship can't turn (no slower than three times an orbit's speed there:
  // round a moon the size of Luna, that is faster than the approach's limit)
  const b = getBody(st.orbit?.body);
  const rM = st.orbit?.r * AU_M;
  const rockMS = b ? Math.max(ROCK_SPEED_MS, 3 * Math.sqrt(b.gm * 1e9 / rM)) : Infinity;
  const near = b && rM < 6 * b.radius * 1000 && rockMS < APPROACH_SPEED_MS;
  const offM = Math.hypot(t.pos.x - sp.x, t.pos.y - sp.y) * AU_M;
  // and the planet a moon close in goes round (Phobos turns 2.8 Mars radii out: its own 11 km limit nothing,
  // Mars' well the danger): no faster than three times an orbit's speed there, within ROCK_R of its radii
  const p = b?.parent, aM = p && b.a * AU_M;
  const parent = p && aM < 6 * p.radius * 1000 ? { rockM: ROCK_R * p.radius * 1000, rockMS: Math.max(ROCK_SPEED_MS, 3 * Math.sqrt(p.gm * 1e9 / aM)) } : null;
  // (the gate's limit is for targets at the gate or inside it: a slot far out is flown to at the approach's)
  return { id, offM, keepM: offM <= keepOutM(id) * 1.5 ? keepOutM(id) : 0, rockM: near ? ROCK_R * b.radius * 1000 : 0, rockMS, parent };
}

/**
 * The closing speed allowed `dM` from a station (m/s): traffic control's
 * limits (3,000 m/s on the approach, 200 m/s inside the gate, each kept 10%
 * under), and further out what still brakes down to them in time, braking
 * as the closing law does (BRAKE_MARGIN of `aMax`): far out the cap is the
 * law's own braking curve, and it only bites near the port.
 */
export function portSpeedCap(dM, aMax, keepM, rockM = 0, rockMS = ROCK_SPEED_MS) {
  const a = BRAKE_MARGIN * aMax;
  const approach = Math.sqrt((0.9 * APPROACH_SPEED_MS) ** 2 + 2 * a * Math.max(0, dM - APPROACH_M));
  const gate = keepM ? Math.sqrt((0.9 * KEEPOUT_SPEED_MS) ** 2 + 2 * a * Math.max(0, dM - keepM)) : Infinity;
  // (round a rock, no more than ROCK_SPEED_MS within ROCK_R radii of it: a fast ship there can't turn in time)
  const rock = rockM ? Math.sqrt(rockMS ** 2 + 2 * a * Math.max(0, dM - rockM)) : Infinity;
  return Math.min(approach, gate, rock);
}

// ---- PLANS ----

/**
 * @param kind 'closing' | 'transfer'
 * opts: { accelG, cruise (m/s), arriveAt (minute, transfer), standoff (m), label, name }
 */
export function createPlan(kind, target, opts) {
  return {
    kind,
    target: { ...target },
    accelG: opts.accelG,
    cruise: opts.cruise ?? null,           // m/s cap on closing speed (economy)
    arriveAt: opts.arriveAt ?? null,       // transfer: planned arrival minute
    standoff: opts.standoff,
    stage: kind === 'transfer' ? 'transfer' : 'closing',
    name: opts.name || '',
    label: opts.label || '',
  };
}

const _rel = {};
const _relP = {};
const _cl = {};

// The closing law plans an approach from afar: the flip, the brake, the turn
// into the attitude that holding on the target takes. Close in it has no
// room to plan, and a ship that has fallen off the plan there has nothing
// to fall back on. So the keep law (guidance.js) flies the near zone when:
// - the route starts there, toward a target whose pull takes the drive (a
//   ship under thrust, a station circling a moon): no hold turn was planned;
// - the approach has fallen off its plan there: opening on the target fast.
// It hands back if the ship gets well clear again.
const NEAR_M = 100_000;              // m from the stop point
const OFF_PLAN_OPENING = 50;         // m/s opening on the target, inside NEAR_M
const HOLD_PULL = 0.8 * RCS_LIMIT;   // a pull above this takes the drive (guidance.js)

function nearHandover(plan, rel) {
  const dEff = rel.d - plan.standoff;
  if (plan.$keep == null) plan.$keep = dEff <= NEAR_M && Math.hypot(rel.ffx, rel.ffy) > HOLD_PULL;
  else if (!plan.$keep && dEff <= NEAR_M && rel.vClose < -OFF_PLAN_OPENING) plan.$keep = true;
  else if (plan.$keep && dEff > 2 * NEAR_M) plan.$keep = false;
  return plan.$keep;
}

const _tl = {};

/**
 * One guidance decision for `plan` at `minute`.
 * Returns { cmd, arrived, rel, phase, flipIn } — `phase` is a display hint:
 * 'burn' | 'coast' | 'brake' | 'approach' | 'transfer-burn', and for a
 * stance (stance.js, which never ends on arrival) 'holding' | 'watch' |
 * 'ready' | 'guard'.
 */
export function guidanceStep(plan, flight, minute, tgtNow, arrivalTarget, dtSec = MIN_S) {
  // The plan's G, or less if the machinery can't give it right now
  const aMax = Math.min(plan.accelG, flight.maxG ?? Infinity) * G0;
  const slew = flight.$slew ?? SLEW_RATE;
  if (plan.kind === 'stance') return stanceStep(plan, flight, tgtNow, { aMax, slew, dtSec });
  // A target behind a rock is come at round it, by a point off the body on our side (viaPoint)
  const via = plan.stage === 'closing' ? viaPoint(plan, flight, tgtNow, minute) || keepOutVia(plan, flight, tgtNow) : null;
  // (the way still to go: by the waypoint, then on to the target)
  const beyond = via ? Math.hypot(tgtNow.pos.x - via.pos.x, tgtNow.pos.y - via.pos.y) * AU_M : 0;
  if (via) tgtNow = { ...via, keepOut0: tgtNow.keepOut };   // (the station's keep-out stays known while we fly by a waypoint)
  const rel = relativeState(flight, tgtNow, _rel);
  let cruise = plan.cruise ?? Infinity;
  // Into a port: traffic control's speed limits, met with braking in hand (portSpeedCap)
  // (looking ahead by a flip's worth at the capped speed: the cap comes on
  // while we still burn; a function of distance alone, so it doesn't move as we slow)
  if (plan.port) {
    // (how far in we are: along the way still to fly, but never further than the station straight
    // off, where the gate's target tells us that: traffic control's zones are spheres round it)
    const K = tgtNow.keepOut && !via ? tgtNow.keepOut : (via && tgtNow.keepOut0) || null;
    const straight = K ? Math.hypot(flight.pos.x - K.pos.x, flight.pos.y - K.pos.y) * AU_M : Infinity;
    const P = plan.port, dS = Math.max(0, Math.min(rel.d + beyond - P.offM, straight));
    const cap = (d) => Math.min(portSpeedCap(d, aMax, P.keepM, P.rockM, P.rockMS), P.parent ? portSpeedCap(d, aMax, 0, P.parent.rockM, P.parent.rockMS) : Infinity);
    const c1 = cap(dS);
    cruise = Math.min(cruise, cap(Math.max(0, dS - c1 * PORT_LOOKAHEAD_S)));
  }
  const cmd = { ax: 0, ay: 0, maxG: plan.accelG, lean: true };
  let phase = 'coast';
  let flipIn = Infinity;

  if (plan.stage === 'transfer') {
    const vMax = brakingSpeed(Math.max(0, rel.d - plan.standoff), aMax, flipSeconds(flight.facing, rel.ux, rel.uy, slew));
    const timeLeft = (plan.arriveAt - minute);
    if (rel.vClose >= 0.9 * vMax || timeLeft < 60 || rel.d < 0.002 * AU_M || !arrivalTarget) {
      plan.stage = 'closing';
    } else if (minute < (plan.$coastUntil ?? -Infinity)) {
      phase = 'coast';                       // on the arc; next correction check scheduled
      cmd.face = Math.atan2(rel.uy, rel.ux);
    } else {
      const tl = transferLaw(flight, arrivalTarget, minute, plan.arriveAt, aMax, dtSec, _tl);
      if (!tl) plan.stage = 'closing';
      else {
        cmd.ax = tl.ax; cmd.ay = tl.ay;
        phase = tl.dv > 20 ? 'transfer-burn' : 'coast';
        // On the arc: re-check for mid-course corrections hourly
        if (tl.dv < 0.5) plan.$coastUntil = minute + 60;
        // Keep the nose pointed along the track while coasting (ready to burn)
        cmd.face = Math.atan2(rel.uy, rel.ux);
      }
    }
  }

  if (plan.stage === 'closing' && nearHandover(plan, rel)) {
    // Close in, off the closing law's plan: the keep law flies us onto the
    // stop point (the standoff, on the line of sight) from whatever state
    const P = pointFrom(tgtNow, rel.ux, rel.uy, -plan.standoff);
    keepLaw(relativeState(flight, P, _relP), { aMax, facing: flight.facing, slew, dtSec, settled: false }, _cl);
    cmd.ax = _cl.ax; cmd.ay = _cl.ay;
    if (_cl.face != null) cmd.face = _cl.face;
    phase = 'approach';
  } else if (plan.stage === 'closing') {
    const cl = closingLaw(rel, { aMax, standoff: plan.standoff, cruise, facing: flight.facing, slew, dtSec, memo: plan.$memo ??= {} }, _cl);
    cmd.ax = cl.ax; cmd.ay = cl.ay;
    if (cl.face != null) cmd.face = cl.face;
    const along = cl.ax * rel.ux + cl.ay * rel.uy;
    const mag = Math.hypot(cl.ax, cl.ay);
    if (cl.dEff < 1e7 && mag < 0.05 * G0) phase = 'approach';
    else if (mag < 0.002 * G0) phase = 'coast';
    else phase = along >= 0 ? 'burn' : 'brake';
    if (phase === 'coast' || phase === 'burn') {
      flipIn = minutesToFlip(rel, aMax, plan.standoff, cruise, flight.facing);
    }
  }

  // Never stall halfway through a rotation: if the command goes quiet while the
  // nose is swinging, keep swinging to the last commanded attitude.
  const mag = Math.hypot(cmd.ax, cmd.ay);
  if (mag > RCS_LIMIT) plan.$want = Math.atan2(cmd.ay, cmd.ax);
  else if (plan.$want != null && Math.abs(flight.turning) > 1e-3 && cmd.face == null) cmd.face = plan.$want;

  return {
    cmd,
    toward: tgtNow.pos,
    via: !!via,
    arrived: !via && plan.stage === 'closing' && hasArrived(rel, plan.standoff),
    phase,
    flipIn,
    d: rel.d,
    dEff: Math.max(0, rel.d - plan.standoff),
    vClose: rel.vClose,
    relSpeed: rel.speed,
  };
}

// ---- ESTIMATION ----

/**
 * Fly a plan forward from the current state without touching it.
 * Returns { arrived, minutes, fuel, dv, peakSpeed, maxG, path:[{x,y}], end }.
 */
export function simulatePlan(state, planIn, { maxMinutes = 2 * 365 * DAY_MIN, pathPoints = 160 } = {}) {
  // (a copy: what the plan remembers, it remembers for the live flight only)
  const plan = { ...planIn, target: { ...planIn.target }, $memo: planIn.$memo && { ...planIn.$memo } };
  const f = createFlight(state.flight.pos, state.flight.vel, state.flight.facing);
  f.maxG = state.$planG ?? state.flight.maxG;      // (the drive out of port: the gate's cap is for the gate)
  const rated = ratedG(playerClass(state));
  const t0 = state.clock.minute;
  let t = t0;
  let fuel = 0, dv = 0, peak = 0, maxG = 0;
  const raw = [];
  const arrivalTgt = plan.kind === 'transfer' ? targetStateAt(state, plan.target, plan.arriveAt) : null;
  const track = targetTracker(state, plan.target, t0);
  let arrived = false, climbing = false, hit = null;
  let steps = 0;

  while (t - t0 < maxMinutes && steps < 400_000) {
    steps++;
    const tgt = track(t);
    if (!tgt) break;
    // Coarse steps on long ballistic coasts far from the target
    let dtMin = 1;
    const rd = Math.hypot(tgt.pos.x - f.pos.x, tgt.pos.y - f.pos.y);
    if (plan.stage === 'transfer' && f.thrustG === 0 && rd > 0.05 && plan.arriveAt - t > 2 * DAY_MIN) dtMin = 30;
    const g = guidanceStep(plan, f, t, tgt, arrivalTgt, dtMin * MIN_S);
    if (g.arrived) { arrived = true; break; }
    f.t = t;
    // the terrain guard flies over the plan here as it will in flight (terrain.js)
    const guard = terrainGuard(f.pos, f.vel, g.cmd, g.toward, Math.min(plan.accelG, f.maxG) * G0, t, climbing);
    climbing = !!guard;
    if (guard) dtMin = 1;
    const out = flightStep(f, guard || g.cmd, dtMin);
    fuel += fuelUsed(out.mainG, out.rcsG, dtMin, rated);
    dv += (out.mainG + out.rcsG) * G0 * dtMin * MIN_S;
    if (out.mainG > maxG) maxG = out.mainG;
    if (g.relSpeed > peak) peak = g.relSpeed;
    if (steps % 10 === 1) raw.push({ x: f.pos.x, y: f.pos.y });
    t += dtMin;
    // (a plan that comes down on a rock is no plan: in flight the guard would fight it all the way)
    const sf = nearestSurface(f.pos.x, f.pos.y, t);
    if (sf && sf.alt < 0) { hit = sf.body.name; break; }
  }
  raw.push({ x: f.pos.x, y: f.pos.y });
  const stride = Math.max(1, Math.ceil(raw.length / pathPoints));
  const path = raw.filter((_, i) => i % stride === 0 || i === raw.length - 1);
  return { arrived, hit, minutes: t - t0, fuel, dv, peakSpeed: peak, maxG, path, end: { x: f.pos.x, y: f.pos.y } };
}

// ---- TRANSFER WINDOW SEARCH ----

/** Pick the arrival time with the lowest total Δv for a ballistic transfer. */
export function findTransfer(state, target) {
  const t0 = state.clock.minute;
  const sp = state.flight.pos, sv = state.flight.vel;
  const r1 = Math.hypot(sp.x, sp.y) * AU_M;
  const tgt0 = targetStateAt(state, target, t0);
  if (!tgt0) return null;
  const r2 = Math.hypot(tgt0.pos.x, tgt0.pos.y) * AU_M;
  const aT = (r1 + r2) / 2;
  const hohmannDays = Math.PI * Math.sqrt(aT * aT * aT / GM_SUN) / 86400;
  const lo = 2, hi = Math.min(500, Math.max(30, hohmannDays * 1.6));
  let best = null;
  const N = 48;
  for (let i = 0; i <= N; i++) {
    const days = lo * Math.pow(hi / lo, i / N);
    const tA = t0 + Math.round(days * DAY_MIN);
    const tgt = targetStateAt(state, target, tA);
    const sol = solveLambert(sp.x * AU_M, sp.y * AU_M, tgt.pos.x * AU_M, tgt.pos.y * AU_M, days * 86400);
    if (!sol) continue;
    const dv1 = Math.hypot(sol.v1x - sv.vx, sol.v1y - sv.vy);
    const dv2 = Math.hypot(sol.v2x - tgt.vel.vx, sol.v2y - tgt.vel.vy);
    const cost = dv1 + dv2;
    if (!best || cost < best.dv) best = { arriveAt: tA, days, dv: cost, dv1, dv2 };
  }
  return best;
}

// ---- ROUTE OPTIONS ----

const OPTION_DEFS = [
  { name: 'EXPRESS', label: '3G brachistochrone', accelG: 3, desc: 'Hard burn, flip, hard brake. Fastest — crew on juice the whole way.' },
  { name: 'STANDARD', label: '1G brachistochrone', accelG: 1, desc: 'Earth-normal gravity throughout. Comfortable and quick.' },
  { name: 'BELTER', label: '0.3G brachistochrone', accelG: 0.3, desc: 'Belter standard — easy on bodies and drive. Slow but gentle.' },
  { name: 'ECONOMY', label: '0.3G burn · coast', accelG: 0.3, cruiseFrac: 0.3, desc: 'Short burns, long coast at cruise speed. Saves reaction mass.' },
];
const COMBAT_DEFS = [
  { name: 'COMBAT 5G', label: '5G brachistochrone', accelG: 5, desc: 'Combat burn. Juice mandatory; hangover guaranteed.' },
  { name: 'ASSAULT 7G', label: '7G brachistochrone', accelG: 7, desc: 'Rated maximum. Expect casualties among the unsecured.' },
  { name: 'FLANK 10G', label: '10G — drive overdriven', accelG: 10, flank: true, desc: 'Past rated limits. High-dose juice (2 med per crew, a booster a day), stroke risk, a crash of a week or more afterwards, double fuel above 7G, and every minute risks a containment failure.' },
];

/** Every route profile the planner can offer (the ship's library lists them). */
export const ROUTE_PROFILES = [...OPTION_DEFS, ...COMBAT_DEFS,
  { name: 'BALLISTIC', label: 'Lambert transfer', desc: 'Burn onto a free-fall arc and coast. Minimum fuel, very long transit.' }];

/**
 * Build and estimate route options to a target.
 * @param opts { standoff, combat (bool), includeBallistic (bool) }
 */
export function planRoutes(state, target, opts = {}) {
  target = routeTarget(state, target);
  const standoff = opts.standoff ?? defaultStandoff(state, target);
  const t0 = state.clock.minute;
  const tgt = targetStateAt(state, target, t0);
  if (!tgt) return [];
  const distM = Math.hypot(tgt.pos.x - state.flight.pos.x, tgt.pos.y - state.flight.pos.y) * AU_M;
  const fuelAvail = state.resources.fuel.current;
  // A thrusting target can only be caught by out-accelerating it
  const minG = opts.minG ?? 0;
  const defs = [...OPTION_DEFS, ...(opts.combat ? COMBAT_DEFS : [])]
    .filter(d => d.accelG <= (state.$planG ?? state.flight.maxG) && d.accelG > minG);

  const options = [];
  for (const d of defs) {
    const cruise = d.cruiseFrac ? Math.max(500, d.cruiseFrac * Math.sqrt(Math.max(0, distM - standoff) * d.accelG * G0)) : null;
    const plan = createPlan('closing', target, { accelG: d.accelG, cruise, standoff, name: d.name, label: d.label });
    plan.port = portOfTarget(state, target);
    const opt = finishOption(state, plan, d.desc, fuelAvail);
    opt.flank = !!d.flank;
    options.push(opt);
  }

  const ballisticOK = opts.includeBallistic !== false && target.kind !== 'fix' &&
    (target.kind === 'body' || getWorld(state).get(target.id)?.orbit) &&
    distM > 0.02 * AU_M;
  if (ballisticOK) {
    const tr = findTransfer(state, target);
    if (tr) {
      const plan = createPlan('transfer', target, { accelG: 0.3, arriveAt: tr.arriveAt, standoff, name: 'BALLISTIC', label: `Lambert transfer · ${Math.round(tr.days)}d` });
      plan.port = portOfTarget(state, target);
      options.push(finishOption(state, plan, 'Burn onto a free-fall arc and coast. Minimum fuel, very long transit.', fuelAvail));
    }
  }
  return options;
}

function finishOption(state, plan, desc, fuelAvail) {
  const est = simulatePlan(state, plan);
  return {
    plan,
    name: plan.name,
    label: plan.label,
    desc,
    accelG: plan.accelG,
    estimate: est,
    minutes: est.minutes + PREP_MINUTES + departMinutes(state, plan),
    departMin: departMinutes(state, plan),
    fuel: est.fuel,
    feasible: est.arrived && est.fuel <= fuelAvail * 0.95,
    reason: est.hit ? `Would come down on ${est.hit}` : !est.arrived ? 'No convergent trajectory' : est.fuel > fuelAvail * 0.95 ? 'Insufficient reaction mass' : '',
    juice: plan.accelG > 1.5,
  };
}

/**
 * Where a route to a target really ends: a station's approach gate (the
 * last stretch, down to a berth, is docking: docking.js); anything else
 * is its own target.
 */
export function routeTarget(state, target) {
  if (target.kind !== 'entity') return target;
  const e = getWorld(state).get(target.id);
  if (e?.type !== 'station') return target;
  const gate = getWorld(state).get(`${e.id}-gate`);
  return gate ? { kind: 'entity', id: gate.id } : target;
}

/** Rough allowance for securing crew before the first burn. */
export const PREP_MINUTES = 10;

// ---- LEAVING A PORT ----

/** A route leaving a port flies on the RCS until this far out, in approaches (autopilot.js departLeg). */
export const DEPART_OUT = 1.05;

/** The station a route leaves (it starts at a berth, or in its approach, bound elsewhere), or null. */
export function departingFrom(state, plan) {
  if (plan.kind === 'stance') return null;
  const d = state.dock;
  // (a dock that holds us at a station; one inbound elsewhere doesn't say where we are)
  const id = d?.target.kind === 'station' && d.phase !== 'inbound' && d.phase !== 'awaiting' ? d.target.id
    : state.tc?.station && (state.tc.zone === 'keepout' || state.tc.zone === 'approach') ? state.tc.station : null;
  if (!id || plan.port?.id === id) return null;
  return { station: id, ux: null, uy: null };
}

/**
 * Roughly how long leaving takes before the route proper (the estimate
 * flies from where we are as if the drive were free to light): out of a
 * berth and up to the gate (docking.js), then the RCS out of the approach.
 */
export function departMinutes(state, plan) {
  const id = departingFrom(state, plan)?.station;
  const world = getWorld(state);
  const st = id && world.get(id);
  if (!st) return 0;
  const p = predictEntity(st, state.clock.minute, world).pos;
  const rM = Math.hypot(state.flight.pos.x - p.x, state.flight.pos.y - p.y) * AU_M;
  const a = 0.85 * RCS_LIMIT;                      // (near a rock some of it holds us against the pull)
  const leg = Math.sqrt(2 * Math.max(0, APPROACH_M * DEPART_OUT - rM) / a) / MIN_S;
  const out = state.dock?.target.id === id ? 6 + Math.sqrt(2 * keepOutM(id) / a) / MIN_S : 0;   // unlatch, back out, climb to the gate
  return Math.round(leg + out);
}
