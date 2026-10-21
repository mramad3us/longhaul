// ============================================================
// LONGHAUL — Gravity: the Sun, and every body with mass near you
//
// Free flight (our ship, the NPCs at the helm, torpedoes, a drifting
// hulk) falls under the Sun and under whatever body it is close to:
// Ceres pulls 0.028 G at its surface and 0.019 G at its port's approach
// gate, Luna 0.014 G at its yards' orbit. Bodies ride their rails
// (ephemeris.js), so a body's pull is computed from where it is at the
// moment asked: a ship beside Ceres and Ceres itself both move 18 km/s
// round the Sun, and a minute's error in Ceres' place would be a
// thousand kilometres.
//
// A body counts inside three times its sphere of influence (beyond, its
// pull is micro-G and the Sun's tide on the pair matters more); the few
// dozen bodies are culled on positions cached per minute, so gravity is
// cheap enough for every integrator step.
//
// The same function gives what it costs to hold a place (holding.js,
// autopilot.js): a place on a Keplerian orbit round a body falls freely
// and costs nothing to keep; a place that doesn't (hovering at a gate,
// keeping station on a surface port's vertical) takes the difference in
// thrust.
//
// Callers pass the minute (fractional inside a minute); integrators that
// don't know it use the epoch the minute tick sets (setGravityEpoch).
// ============================================================

import { AU_M, DAY_MIN, MIN_S } from '../core/constants.js';
import { BODIES, SUN, bodyPos, bodyVel } from './ephemeris.js';

const GM_SUN_M3 = SUN.gm * 1e9;

/**
 * Bodies with mass, each with its reach (AU): 3× its sphere of influence,
 * where its pull counts; and how far its ground is looked out for (`see`):
 * that, or 20 of its radii, whichever is more (Phobos' reach ends 10 km
 * over its ground, under the gate of the yard built on it).
 */
const MASSIVE = BODIES.filter(b => b !== SUN && b.gm > 0).map(b => {
  const parentGM = b.parent ? b.parent.gm : SUN.gm;
  const soi = b.a * Math.pow(b.gm / parentGM, 0.4);
  const see = Math.max(3 * soi, 20 * b.radius * 1000 / AU_M);
  return { b, gm: b.gm * 1e9, reach: 3 * soi, reach2: (3 * soi) ** 2, see2: see * see, rM: b.radius * 1000 };
});

let epoch = 0;
/** The minute integrators without a clock of their own take as "now". */
export const setGravityEpoch = (minute) => { epoch = minute; };
export const gravityEpoch = () => epoch;

// Body positions and velocities per whole minute; inside a minute, carried on
// linearly (a body's path bends by metres in a minute)
const _cache = new Map();
function bodiesAt(minute) {
  const m0 = Math.floor(minute);
  let c = _cache.get(m0);
  if (!c) {
    if (_cache.size > 8) _cache.clear();
    const days = m0 / DAY_MIN;
    c = MASSIVE.map(g => ({ p: bodyPos(g.b, days), v: bodyVel(g.b, days) }));
    _cache.set(m0, c);
  }
  return { c, dtS: (minute - m0) * MIN_S };
}

/** Where body i of MASSIVE is at `minute` (AU). */
function placeOf(i, minute, out) {
  const { c, dtS } = bodiesAt(minute);
  out.x = c[i].p.x + c[i].v.vx * dtS / AU_M;
  out.y = c[i].p.y + c[i].v.vy * dtS / AU_M;
  return out;
}

const _p = { x: 0, y: 0 };

/**
 * Gravitational acceleration (m/s²) at (x, y) AU at `minute`: the Sun and
 * every body in reach. Writes into `out` and returns it.
 */
export function gravityAt(x, y, minute = epoch, out = { ax: 0, ay: 0 }) {
  let r2 = x * x + y * y;
  let ax = 0, ay = 0;
  if (r2 > 1e-12) {
    const r = Math.sqrt(r2), rm = r * AU_M;
    const g = GM_SUN_M3 / (rm * rm);
    ax = -g * x / r; ay = -g * y / r;
  }
  const { c, dtS } = bodiesAt(minute);
  for (let i = 0; i < MASSIVE.length; i++) {
    const m = MASSIVE[i];
    const bx = c[i].p.x + c[i].v.vx * dtS / AU_M, by = c[i].p.y + c[i].v.vy * dtS / AU_M;
    const dx = bx - x, dy = by - y;
    r2 = dx * dx + dy * dy;
    if (r2 > m.reach2) continue;
    const rm = Math.max(Math.sqrt(r2) * AU_M, m.rM);        // (inside the rock: as at its surface)
    const g = m.gm / (rm * rm);
    const d = Math.sqrt(r2) * AU_M || 1;
    ax += g * dx * AU_M / d; ay += g * dy * AU_M / d;
  }
  out.ax = ax; out.ay = ay;
  return out;
}

/**
 * The body whose surface is nearest (x, y) within its reach, or null:
 * { body, alt (m above the surface), ux, uy (unit vector from its centre),
 *   vel (its velocity, m/s), spin (rad/s: the surface turns) }.
 */
export function nearestSurface(x, y, minute = epoch) {
  let best = null, bestAlt = Infinity;
  for (let i = 0; i < MASSIVE.length; i++) {
    const m = MASSIVE[i];
    placeOf(i, minute, _p);
    const dx = x - _p.x, dy = y - _p.y;
    const r2 = dx * dx + dy * dy;
    if (r2 > m.see2) continue;
    const r = Math.sqrt(r2) * AU_M;
    const alt = r - m.rM;
    if (alt < bestAlt) {
      bestAlt = alt;
      const { c } = bodiesAt(minute);
      best = { body: m.b, alt, r, ux: r > 0 ? dx * AU_M / r : 1, uy: r > 0 ? dy * AU_M / r : 0, vel: { vx: c[i].v.vx, vy: c[i].v.vy }, spin: m.b.rotH ? 2 * Math.PI / (m.b.rotH * 3600) : 0, center: { x: _p.x, y: _p.y } };
    }
  }
  return best;
}

/** Where a point on a body's surface (at body-frame angle `ang`) is and moves at `minute`. */
export function surfacePoint(body, ang, minute) {
  const days = minute / DAY_MIN;
  const center = bodyPos(body, days), cvel = bodyVel(body, days);
  const spin = body.rotH ? 2 * Math.PI / (body.rotH * 3600) : 0;
  const a = ang + spin * minute * MIN_S, rM = body.radius * 1000;
  const c = Math.cos(a), s = Math.sin(a);
  return { pos: { x: center.x + c * rM / AU_M, y: center.y + s * rM / AU_M }, vel: { vx: cvel.vx - spin * s * rM, vy: cvel.vy + spin * c * rM } };
}

/** A body's own pull at a distance from its centre (m/s²). */
export const pullAt = (body, rM) => body.gm * 1e9 / (rM * rM);

/** The radius of a circular orbit round `body` with period `periodS` (m): the synchronous orbit for its rotation. */
export const syncRadiusM = (body, periodS) => Math.cbrt(body.gm * 1e9 * periodS * periodS / (4 * Math.PI * Math.PI));

const INDEX = new Map(MASSIVE.map((m, i) => [m.b.name, i]));

/** One body's pull at (x, y) (m/s², into `out`), or null outside its reach. */
export function pullOf(bodyName, x, y, minute = epoch, out = { ax: 0, ay: 0 }) {
  const i = INDEX.get(bodyName);
  if (i == null) return null;
  const m = MASSIVE[i];
  placeOf(i, minute, _p);
  const dx = _p.x - x, dy = _p.y - y, r2 = dx * dx + dy * dy;
  if (r2 > m.reach2) return null;
  const d = Math.sqrt(r2) * AU_M || 1, rm = Math.max(d, m.rM);
  const g = m.gm / (rm * rm);
  out.ax = g * dx * AU_M / d; out.ay = g * dy * AU_M / d;
  return out;
}

/** A body's reach (AU): beyond it, gravity treats it as not there. */
export const reachOf = (body) => MASSIVE.find(m => m.b === body)?.reach ?? 0;
