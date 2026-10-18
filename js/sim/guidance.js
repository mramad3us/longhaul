// ============================================================
// LONGHAUL — Guidance laws (pure functions)
//
// CLOSING LAW — rendezvous with a moving target, closed loop.
//   Work in the target's frame. Command the relative velocity that
//   points at the stop point with the largest speed we can still
//   brake from (v = √(2·a·d), minus the distance covered while
//   flipping), capped by an optional cruise speed. The acceleration
//   that achieves it is clamped to the drive limit. This yields a
//   burn → flip → brake brachistochrone from rest, automatically
//   cancels sideways drift, and corrects for differential gravity
//   and target thrust every minute. No snapping, no special cases.
//
// TRANSFER LAW — fuel-cheap ballistic arc.
//   Solve Lambert from the ship to where the target will be at the
//   planned arrival time, burn to that velocity, coast, re-solve
//   periodically for small corrections; hand over to the closing law
//   once braking is due.
// ============================================================

import { AU_M, G0, MIN_S } from '../core/constants.js';
import { solarGravity } from './ephemeris.js';
import { solveLambert } from './lambert.js';
import { FLIP_MINUTES, RCS_MAX_G } from './flight.js';

export const BRAKE_MARGIN = 0.85;     // plan braking at 85% of available thrust
export const ARRIVE_SPEED = 3;        // m/s relative — "stopped"
const FLIP_S = FLIP_MINUTES * MIN_S;

const _gs = { ax: 0, ay: 0 };
const _gt = { ax: 0, ay: 0 };

/**
 * Relative state of a target as seen from the ship.
 * target: { pos:{x,y} AU, vel:{vx,vy} m/s, ax?, ay? (target's own thrust, m/s²),
 *          atx?, aty? (target's total acceleration, for rails/moon targets) }
 */
export function relativeState(flight, target, out = {}) {
  const dx = (target.pos.x - flight.pos.x) * AU_M;
  const dy = (target.pos.y - flight.pos.y) * AU_M;
  const d = Math.hypot(dx, dy);
  const dvx = flight.vel.vx - target.vel.vx;   // ship relative to target
  const dvy = flight.vel.vy - target.vel.vy;
  solarGravity(flight.pos.x, flight.pos.y, _gs);
  solarGravity(target.pos.x, target.pos.y, _gt);
  out.dx = dx; out.dy = dy; out.d = d;
  out.ux = d > 0 ? dx / d : 0;
  out.uy = d > 0 ? dy / d : 0;
  out.dvx = dvx; out.dvy = dvy;
  out.speed = Math.hypot(dvx, dvy);
  out.vClose = dvx * out.ux + dvy * out.uy;    // > 0: closing
  // feed-forward: how the target's frame accelerates relative to free fall at our position.
  // Rails/moon targets supply their total acceleration; free ones = gravity + own thrust.
  if (target.atx != null) {
    out.ffx = target.atx - _gs.ax;
    out.ffy = target.aty - _gs.ay;
  } else {
    out.ffx = (_gt.ax - _gs.ax) + (target.ax || 0);
    out.ffy = (_gt.ay - _gs.ay) + (target.ay || 0);
  }
  return out;
}

// Terminal zone: the last stretch is flown on RCS alone (no drive, no flips).
export const TERMINAL_RANGE = 25_000;                 // m
const RCS_A = RCS_MAX_G * G0;
const RCS_PLAN_A = RCS_A * 0.7;                       // plan RCS braking with margin
const TERMINAL_V = Math.sqrt(2 * RCS_PLAN_A * TERMINAL_RANGE);   // ≈ 83 m/s entering the zone

/**
 * Max closing speed at distance dEff that still allows stopping at the stop point:
 * a main-drive braking curve handing over to RCS at the terminal boundary. With
 * the nose toward the target, the ship must first flip (coasting FLIP_S at that
 * speed), so solve v² + 2·a·F·v = 2·a·(d − D_T) + v_T² for v.
 */
export function brakingSpeed(dEff, aMax, noseTowardTarget, cruise = Infinity, dtSec = MIN_S) {
  let v;
  if (dEff <= TERMINAL_RANGE) {
    v = Math.sqrt(2 * RCS_PLAN_A * dEff);
  } else {
    const aB = BRAKE_MARGIN * aMax;
    const base = 2 * aB * (dEff - TERMINAL_RANGE) + TERMINAL_V * TERMINAL_V;
    if (noseTowardTarget) {
      const k = aB * FLIP_S;
      v = -k + Math.sqrt(k * k + base);
    } else {
      v = Math.sqrt(base);
    }
  }
  v = Math.min(v, dEff / (2 * dtSec));    // deadbeat bound: never plan to cover > ½ the gap per step
  return Math.min(v, cruise);
}

/**
 * Closing law. Writes desired non-grav accel (m/s²) into out.ax/out.ay.
 * p: { aMax, standoff (m), cruise (m/s), facing (rad), dtSec }
 */
export function closingLaw(rel, p, out = {}) {
  const dEff = Math.max(0, rel.d - p.standoff);
  const nose = Math.cos(p.facing) * rel.ux + Math.sin(p.facing) * rel.uy > 0;
  const cruise = p.cruise ?? Infinity;
  // Aim at the curve where we'll be after this step, not where we are (else we lag it)
  let vMax = brakingSpeed(dEff, p.aMax, nose, cruise, p.dtSec);
  const dNext = Math.max(0, dEff - 0.5 * (rel.vClose + vMax) * p.dtSec);
  vMax = Math.min(vMax, brakingSpeed(dNext, p.aMax, nose, cruise, p.dtSec));

  // desired relative velocity: straight at the stop point at vMax
  const vdx = rel.ux * vMax, vdy = rel.uy * vMax;
  let cx = (vdx - rel.dvx) / p.dtSec;
  let cy = (vdy - rel.dvy) / p.dtSec;

  const terminal = dEff <= TERMINAL_RANGE;
  let limit = p.aMax;
  if (terminal && rel.speed < 2 * vMax + 10) {
    limit = RCS_A;                                    // fine approach: corrections on RCS only
  } else if (!nose && rel.vClose > 0) {
    // In braking attitude and still closing: never flip back toward the target
    // just to close a little faster — RCS does the nudging, the drive only brakes.
    const along = cx * rel.ux + cy * rel.uy;
    if (along > RCS_A) { cx -= (along - RCS_A) * rel.ux; cy -= (along - RCS_A) * rel.uy; }
  }
  const c = Math.hypot(cx, cy);
  if (c > limit) { cx *= limit / c; cy *= limit / c; }
  // Feed-forward (target thrust, differential gravity) always passes through:
  // holding formation with a ship under thrust means burning with it.
  let ax = cx + rel.ffx, ay = cy + rel.ffy;
  const a = Math.hypot(ax, ay);
  if (a > p.aMax) { ax *= p.aMax / a; ay *= p.aMax / a; }
  out.ax = ax; out.ay = ay;
  out.vMax = vMax;
  out.dEff = dEff;
  out.terminal = terminal;
  return out;
}

export function arrivalTolerance(standoff) {
  return Math.max(100, standoff * 0.02);
}

export function hasArrived(rel, standoff) {
  return rel.d - standoff <= arrivalTolerance(standoff) && rel.speed <= ARRIVE_SPEED;
}

/**
 * Estimate game-minutes until the closing law will flip from accelerating to
 * braking (1D, constant thrust). Returns Infinity if not accelerating toward target.
 */
export function minutesToFlip(rel, aMax, standoff, cruise = Infinity, facing = 0, horizon = 90) {
  const nose = Math.cos(facing) * rel.ux + Math.sin(facing) * rel.uy > 0;
  if (!nose) return Infinity;
  let v = rel.vClose;
  let d = Math.max(0, rel.d - standoff);
  for (let t = 0; t <= horizon; t++) {
    const vMax = brakingSpeed(d, aMax, true, cruise);
    if (v >= vMax * 0.98) return v >= cruise * 0.98 && cruise < Infinity ? Infinity : t;
    v = Math.min(v + aMax * MIN_S, cruise);
    d -= v * MIN_S;
    if (d <= 0) return t;
  }
  return Infinity;
}

/**
 * Transfer law: velocity needed now to coast onto the target at `arriveMinute`.
 * Returns { ax, ay, dv } or null when Lambert has no solution.
 */
export function transferLaw(flight, targetAtArrival, minute, arriveMinute, aMax, dtSec, out = {}) {
  const tof = (arriveMinute - minute) * MIN_S;
  if (tof <= 0) return null;
  const sol = solveLambert(
    flight.pos.x * AU_M, flight.pos.y * AU_M,
    targetAtArrival.pos.x * AU_M, targetAtArrival.pos.y * AU_M,
    tof,
  );
  if (!sol) return null;
  const dvx = sol.v1x - flight.vel.vx;
  const dvy = sol.v1y - flight.vel.vy;
  const dv = Math.hypot(dvx, dvy);
  let ax = dvx / dtSec, ay = dvy / dtSec;
  const a = Math.hypot(ax, ay);
  if (a > aMax) { ax *= aMax / a; ay *= aMax / a; }
  // Residuals under 0.5 m/s aren't worth a correction; small ones end up on RCS (flightStep)
  if (dv < 0.5) { ax = 0; ay = 0; }
  out.ax = ax; out.ay = ay; out.dv = dv;
  out.v2x = sol.v2x; out.v2y = sol.v2y;
  return out;
}
