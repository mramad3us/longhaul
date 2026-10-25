// ============================================================
// LONGHAUL — Terrain: falling onto a rock, and what the nav computer says first
//
// With gravity (gravity.js) a ship that stops thrusting beside Ceres
// falls: from its approach gate, 100 km up, it hits the ground in about
// seventeen minutes at some 190 m/s. So the nav computer watches the
// ground whenever we fly free near a body: time to impact on the path we
// are on (radial speed, the pull, our own thrust, and the turn of the
// orbit), called out at thirty, ten, three and one minute.
//
// Contact: the ground moves (a body turns: Ceres' equator at 90 m/s), so
// what counts is our speed against the surface under us. Up to 2 m/s it
// is a touch; above, the hull takes damage that grows with the square of
// the speed, and at about 50 m/s the ship is lost. A ship that survives
// rests on the surface (a hold on the ground: no fuel to stay there) until
// a route lifts it off.
//
// NPC hulls and torpedoes come down too: a torpedo that meets the ground
// is spent; a hull that hits faster than a touch is wrecked, and either
// way it is left lying on the surface, on rails with the rock.
//
// Routes are planned as if space were empty, so the nav computer (and an
// NPC's) flies a guard over them near a body (terrainGuard: inside twenty
// radii of it, or twenty minutes at the speed we close, if that is further:
// a ship come in too fast, its drive failed on the brake, still steers
// round the rock rather than through it; one that can't stop short of the
// ground puts its whole drive across its motion, away from the rock's
// centre, for the widest miss): when the line
// to where it is going passes through the rock, or the ground would come
// up on the present command within five minutes and what saving the ship
// would take (the time its braking needs to stop the fall; coasting, the
// drive's; passing the rock, a half turn as well), it climbs off the local
// vertical (straight up when low) and out round the limb toward the
// target's side, the body's pull covered, until the line is clear; then
// the route flies on.
// ============================================================

import { AU_M, MIN_S, TWO_PI } from '../core/constants.js';
import { nearestSurface, pullAt } from './gravity.js';
import { SLEW_RATE } from './flight.js';
import { getWorld } from './world.js';
import { hullPoints, CLASSES, PLAYER_CLASS } from './ship-classes.js';
import { applyHit, wreckNpc } from './damage.js';
import { PLAYER, ensureHull } from './combatants.js';

export const TOUCH_MS = 2;          // a touch, no harm
export const LOST_MS = 50;          // the speed into the ground that takes the whole hull
const WARN_MIN = [30, 10, 3, 1];
const WATCH_ALT_M = 3_000_000;      // the nav computer watches the ground inside 3,000 km

/** Our velocity against the ground under a point on a body (m/s). */
function againstGround(s, vel) {
  // the surface turns at spin × r
  const sx = -s.spin * s.uy * s.r, sy = s.spin * s.ux * s.r;
  return { vx: vel.vx - s.vel.vx - sx, vy: vel.vy - s.vel.vy - sy };
}

/**
 * Seconds until a free-flying ship meets the ground on its present path,
 * or Infinity: its height, its radial speed, the pull, its own thrust's
 * radial part, and what its sideways speed carries it out by (v²/r).
 */
export function timeToImpact(s, vel, thrust = { ax: 0, ay: 0 }) {
  const v = againstGround(s, vel);
  const vr = v.vx * s.ux + v.vy * s.uy;
  const vt2 = v.vx * v.vx + v.vy * v.vy - vr * vr;
  const ar = (thrust.ax * s.ux + thrust.ay * s.uy) - pullAt(s.body, s.r) + vt2 / s.r;
  // alt + vr t + ar t²/2 = 0, the first t > 0
  if (Math.abs(ar) < 1e-9) return vr < 0 ? s.alt / -vr : Infinity;
  const disc = vr * vr - 2 * ar * s.alt;
  if (disc < 0) return Infinity;
  const q = Math.sqrt(disc);
  const t1 = (-vr - q) / ar, t2 = (-vr + q) / ar;
  const ts = [t1, t2].filter(t => t > 0);
  return ts.length ? Math.min(...ts) : Infinity;
}

const GUARD_RANGE_R = 20;            // radii from a body's centre the guard looks out to…
const GUARD_AHEAD_S = 20 * 60;       // …or as far as we close in this long, coming in faster
const CLEAR_R = 1.05;               // a line to the target passing nearer than this is blocked
const CLIMB_S = 300;                // climb and round at the speed five minutes of the drive gives…
const CLIMB_MAX_MS = 1200;           // …held under a port's speed limit (traffic-control.js: 3,000 m/s on the approach, both together)
const SAVE_MAX_S = 2 * 3600;        // the guard looks no further than this beyond its margin
const LOW_M = 20_000;               // below this, straight up first: a turn to lean costs height a ship this low hasn't got

/**
 * Does the straight line from `p` to `q` (AU) pass through a body (its
 * centre `c`, radius rM)? Not if its nearest point to the centre is the end
 * (a target standing just over the ground: a gate, a berth).
 */
function blocked(p, q, c, rM) {
  const dx = (q.x - p.x) * AU_M, dy = (q.y - p.y) * AU_M;
  const cx = (c.x - p.x) * AU_M, cy = (c.y - p.y) * AU_M;
  const L2 = dx * dx + dy * dy;
  if (L2 <= 0) return false;
  const t = (cx * dx + cy * dy) / L2;
  // (the line's very end is the target's own neighbourhood: half a radius of it, however far off we are)
  if (t <= 0 || t >= 1 - Math.min(0.02, 0.5 * rM / Math.sqrt(L2))) return false;
  return Math.hypot(cx - t * dx, cy - t * dy) < CLEAR_R * rM;
}

/**
 * The guard over a flight command near a body: null when the command can
 * stand, else the climb that replaces it. pos/vel: the ship's; cmd: the
 * route's (non-gravitational m/s²); toward: where the route is going (AU);
 * aMax: the drive to use (m/s²).
 */
export function terrainGuard(pos, vel, cmd, toward, aMax, minute, climbing = false) {
  const s = nearestSurface(pos.x, pos.y, minute);
  if (!s) return null;
  const rM = s.body.radius * 1000;
  // (a ship coming in fast is watched from further out: at 100 km/s, twenty radii of a small rock is a minute)
  const vRel = Math.hypot(vel.vx - s.vel.vx, vel.vy - s.vel.vy);
  if (s.r > Math.max(GUARD_RANGE_R * rM, vRel * GUARD_AHEAD_S)) return null;
  // the command as the drive will give it (held to aMax: near a station, to traffic control's 0.1G)
  const thrust = cmd ? { ax: cmd.ax || 0, ay: cmd.ay || 0 } : { ax: 0, ay: 0 };
  const tm = Math.hypot(thrust.ax, thrust.ay);
  if (tm > aMax) { thrust.ax *= aMax / tm; thrust.ay *= aMax / tm; }
  const losBlocked = toward && blocked(pos, toward, s.center, rM);
  // (a climb under way goes on until the ground is well away: no flapping between two commands)
  // Looking far enough ahead to save the ship: the margin, and
  // - on a route only passing this rock (a transfer burn may point at the
  //   ground) with nothing holding us up against the pull, a half turn and
  //   the time the drive takes to stop the fall; coasting in to a target
  //   here, only that time (the route brakes for it later, its nose already
  //   round: flown out unbraked further, a normal approach looks like a fall);
  // - braking against it, as long as that braking takes to stop the fall:
  //   the path flown out shows whether it stops short of the ground (a slow
  //   ship coming down into a big well braking all it can is marginal, and
  //   it is an hour before it knows). At most SAVE_MAX_S.
  const vDown = Math.max(0, -((vel.vx - s.vel.vx) * s.ux + (vel.vy - s.vel.vy) * s.uy));
  const up = thrust.ax * s.ux + thrust.ay * s.uy, pullHere = pullAt(s.body, s.r);
  const passing = !toward || Math.hypot(toward.x - s.center.x, toward.y - s.center.y) * AU_M > GUARD_RANGE_R * rM;
  const save = Math.min(SAVE_MAX_S, up < pullHere ? (passing ? Math.PI / SLEW_RATE * MIN_S : 0) + vDown / Math.max(1e-3, aMax)
    : 1.2 * vDown / Math.max(1e-3, up - pullHere));
  const horizon = (climbing ? 15 : 5) * MIN_S + save;
  const tti = pathToImpact(s, vel, thrust, horizon);
  let soon = tti < horizon;
  if (soon && toward && !losBlocked && !climbing) {
    // coming down to a target in sight above the ground (a gate, a slot): the
    // route brakes for it; only the ground coming before the target is a danger
    const tx = (toward.x - pos.x) * AU_M, ty = (toward.y - pos.y) * AU_M, td = Math.hypot(tx, ty) || 1;
    const vc = ((vel.vx - s.vel.vx) * tx + (vel.vy - s.vel.vy) * ty) / td;
    const above = Math.hypot(toward.x - s.center.x, toward.y - s.center.y) * AU_M > rM * 1.02;
    if (above && vc > 0 && tti > 1.5 * td / vc + MIN_S) soon = false;
  }
  if (!losBlocked && !soon) return null;
  // Up, and the side the target is on (across the local vertical)
  const ux = s.ux, uy = s.uy;
  let sx = 0, sy = 0;
  if (toward) {
    const lx = (toward.x - pos.x), ly = (toward.y - pos.y), l = Math.hypot(lx, ly) || 1;
    const along = (lx * ux + ly * uy) / l;
    sx = lx / l - along * ux; sy = ly / l - along * uy;
  }
  const sl = Math.hypot(sx, sy);
  if (sl < 1e-3) { sx = -uy; sy = ux; } else { sx /= sl; sy /= sl; }
  // Too fast to stop short of the ground (a ship come in on a failed brake): no climb can be had, only
  // a miss; the whole drive across our motion, away from the rock's centre, widens it fastest
  const rvx0 = vel.vx - s.vel.vx, rvy0 = vel.vy - s.vel.vy, v0 = Math.hypot(rvx0, rvy0);
  if (v0 > 0 && tti < Infinity && v0 * v0 / (2 * Math.max(1e-3, aMax)) > v0 * tti) {
    const hx = rvx0 / v0, hy = rvy0 / v0;
    // (the centre seen from us, less its part along our motion: what is left points at the rock across our path)
    const cx = -ux * s.r, cy = -uy * s.r, along = cx * hx + cy * hy;
    let px = -(cx - along * hx), py = -(cy - along * hy);
    const pl = Math.hypot(px, py);
    if (pl < 1) { px = sx || -hy; py = sy || hx; } else { px /= pl; py /= pl; }
    return { ax: px * aMax, ay: py * aMax, maxG: cmd?.maxG, lean: true, climb: true, dodge: true, body: s.body.name };
  }
  // the velocity we want against the body's centre: out, and round toward the target
  const climb = Math.max(400, Math.min(CLIMB_MAX_MS, aMax * CLIMB_S));
  const round = losBlocked && s.alt > LOW_M ? 1.8 * climb : 0;
  const vx = ux * climb + sx * round, vy = uy * climb + sy * round;
  const rvx = vel.vx - s.vel.vx, rvy = vel.vy - s.vel.vy;
  const pull = pullAt(s.body, s.r);
  let ax = (vx - rvx) / MIN_S + pull * ux, ay = (vy - rvy) / MIN_S + pull * uy;
  const a = Math.hypot(ax, ay);
  if (a > aMax) { ax *= aMax / a; ay *= aMax / a; }
  return { ax, ay, maxG: cmd?.maxG, lean: true, climb: true, body: s.body.name };
}

/**
 * An idle ship near a body keeps its height: the pull covered, any fall
 * or climb killed (an NPC with nothing to fly; a disabled drive can't).
 * keepClimb: a climb is kept (a ship leaving a port while its crew strap
 * in: autopilot.js). Null away from bodies.
 */
export function hoverCmd(pos, vel, minute, { keepClimb = false } = {}) {
  const s = nearestSurface(pos.x, pos.y, minute);
  if (!s || s.r > GUARD_RANGE_R * s.body.radius * 1000) return null;
  const vr = (vel.vx - s.vel.vx) * s.ux + (vel.vy - s.vel.vy) * s.uy;
  const a = pullAt(s.body, s.r) - (keepClimb ? Math.min(0, vr) : vr) / MIN_S;
  return { ax: a * s.ux, ay: a * s.uy, hover: true };
}

/**
 * Seconds until a path meets the ground, flown out (horizon seconds at
 * most): from here, with this thrust held, under the body's pull, in the
 * body's frame. A burn across the vertical carries the ship sideways as
 * well as down, which a time-to-impact taken straight down can't see.
 */
function pathToImpact(s, vel, thrust, horizon) {
  const STEP = 30;
  let x = s.ux * s.r, y = s.uy * s.r;
  let vx = vel.vx - s.vel.vx, vy = vel.vy - s.vel.vy;
  const rM = s.body.radius * 1000, gm = s.body.gm * 1e9;
  for (let t = STEP; t <= horizon; t += STEP) {
    const r = Math.hypot(x, y), g = gm / (r * r);
    vx += (thrust.ax - g * x / r) * STEP; vy += (thrust.ay - g * y / r) * STEP;
    const x0 = x, y0 = y;
    x += vx * STEP; y += vy * STEP;
    // (each step's whole stretch, not its end: coming in at 100 km/s a step is 3,000 km, and a small rock lies between)
    const sx = x - x0, sy = y - y0, L2 = sx * sx + sy * sy;
    const k = L2 > 0 ? Math.max(0, Math.min(1, -(x0 * sx + y0 * sy) / L2)) : 1;
    if (Math.hypot(x0 + k * sx, y0 + k * sy) < rM) return t - STEP * (1 - k);
  }
  return Infinity;
}

/** Per minute, after we have flown: the ground's warnings, and contact. */
export function terrainTick(state, emit = () => {}, { free = true } = {}) {
  const f = state.flight;
  if (state.lost) return;
  const now = state.clock.minute;
  const s = nearestSurface(f.pos.x, f.pos.y, now);
  if (!s || s.alt > WATCH_ALT_M) { state.$terrain = null; return; }
  if (!free) { state.$terrain = null; return; }
  if (s.alt <= 0) { contact(state, s, emit); return; }
  const thrust = { ax: f.$ax || 0, ay: f.$ay || 0 };
  const min = timeToImpact(s, f.vel, thrust) / MIN_S;
  // how many of the call-out times we are inside (a new one is called once)
  // (a route under way has the guard watching the ground for it: only the last minute is called)
  const k = state.autopilot?.phase === 'active' ? (min <= 1 ? WARN_MIN.length : 0) : WARN_MIN.filter(m => min <= m).length;
  const w = (state.$terrain ||= { k: 0 });
  if (k > w.k) {
    const v = Math.round(impactSpeed(s, f.vel, min * MIN_S, thrust));
    emit('nav-callout', { level: min <= 3 ? 'danger' : 'warn', key: 'terrain', text: `TERRAIN: falling toward ${s.body.name}, ${Math.round(s.alt / 1000).toLocaleString()} km below. Impact in ${Math.max(1, Math.round(min))} min at ${v} m/s.` });
  }
  w.k = k;
}

/** Roughly how fast we will meet the ground (m/s). */
function impactSpeed(s, vel, t, thrust) {
  const v = againstGround(s, vel);
  const vr = v.vx * s.ux + v.vy * s.uy;
  const ar = (thrust.ax * s.ux + thrust.ay * s.uy) - pullAt(s.body, s.r);
  const vt2 = Math.max(0, v.vx * v.vx + v.vy * v.vy - vr * vr);
  return Math.sqrt(vt2 + (vr + ar * t) ** 2);
}

/** We are on (or in) the ground: the blow, and then we rest on the surface. */
function contact(state, s, emit) {
  const f = state.flight;
  const v = againstGround(s, f.vel);
  const speed = Math.hypot(v.vx, v.vy);
  const name = s.body.name;
  if (speed > TOUCH_MS) {
    const hp = hullPoints(CLASSES[state.ship.classId || PLAYER_CLASS]);
    const share = Math.min(1.2, ((speed - TOUCH_MS) / (LOST_MS - TOUCH_MS)) ** 2);
    emit('ground-impact', { body: name, speed, text: `Impact with ${name} at ${Math.round(speed)} m/s.` });
    applyHit(state, PLAYER, { kind: 'impact', weapon: `the surface of ${name}`, dp: share * hp, spread: true, from: null }, emit);
    if (state.lost) return;
  }
  land(state, s);
  emit('landed', { body: name, speed, text: speed > TOUCH_MS ? `Down on ${name}. The ship rests on the surface.` : `Touched down on ${name}.` });
}

/** Rest on the surface: a hold on the ground at our place on the body (nav.js 'surface' targets). */
export function land(state, s) {
  const f = state.flight;
  const ang = Math.atan2(s.uy, s.ux) - s.spin * state.clock.minute * MIN_S;
  state.autopilot = null;
  f.hold = { kind: 'surface', id: s.body.name, ang, ox: 0, oy: 0 };
  f.manual = null;
  const rM = s.body.radius * 1000;
  f.pos.x = s.center.x + s.ux * rM / AU_M;
  f.pos.y = s.center.y + s.uy * rM / AU_M;
  f.vel.vx = s.vel.vx - s.spin * s.uy * rM; f.vel.vy = s.vel.vy + s.spin * s.ux * rM;
  // (down, a ship stands on its tail, the drive under it: it lifts straight off, no turn to make first)
  f.facing = Math.atan2(s.uy, s.ux);
  f.turning = 0;
}

/**
 * After the NPCs have flown: one that has come down onto a body is
 * wrecked (faster than a touch) and left on the surface, on rails with the
 * rock; a torpedo is spent (the caller retires it).
 */
export function groundCheck(state, e, emit = () => {}) {
  const s = nearestSurface(e.pos.x, e.pos.y, state.clock.minute);
  if (!s || s.alt > 0) return false;
  if (e.type === 'ordnance') return true;
  const v = againstGround(s, e.vel);
  const speed = Math.hypot(v.vx, v.vy);
  const world = getWorld(state);
  if (speed > TOUCH_MS && ensureHull(e).status !== 'wreck') wreckNpc(state, e, null, emit);
  world.setDriven(e, false);
  const spinDays = s.body.rotH / 24;
  const days = state.clock.minute / 1440;
  e.orbit = { body: s.body.name, r: s.body.radius / (AU_M / 1000), phase: Math.atan2(s.uy, s.ux) - (spinDays ? TWO_PI * days / spinDays : 0), period: spinDays };
  e.thrust = 0;
  world.refresh(e, state.clock.minute);
  world.hash.update(e);
  emit('ship-crashed', { id: e.id, name: e.name, body: s.body.name, speed, text: `${e.name} came down on ${s.body.name} at ${Math.round(speed)} m/s.` });
  return true;
}
