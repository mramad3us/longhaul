// ============================================================
// LONGHAUL — Ship flight dynamics
//
// The ship is a point mass with an attitude. The Epstein drive pushes
// along the nose (`facing`); turning the nose takes time (RCS slew),
// and the main drive only fires once the nose is on the commanded
// vector — so a "flip" is simply a 180° slew with the drive cold.
// Small corrections (< RCS_MAX_G) are made by RCS translation without
// turning the ship.
//
// Controllers (autopilot, manual helm) hand flightStep a desired
// non-gravitational acceleration; flightStep decides what the ship
// can actually do this minute and integrates the motion.
// ============================================================

import { AU_M, G0, MIN_S } from '../core/constants.js';
import { solarGravity } from './ephemeris.js';

export const SLEW_RATE = Math.PI / 6;            // rad per game-minute → full flip in 6 min
export const FLIP_MINUTES = Math.PI / SLEW_RATE;
export const RCS_MAX_G = 0.02;                   // RCS translation authority
export const ALIGN_TOL = 8 * Math.PI / 180;      // drive fires only within 8° of the commanded vector
export const FUEL_PER_G_MIN = 0.05;              // kg of reaction mass per G per minute (main drive)
export const RCS_FUEL_PER_G_MIN = 0.6;           // RCS is ~12× less efficient

export function createFlight(pos, vel, facing = 0) {
  return {
    pos: { x: pos.x, y: pos.y },     // AU, heliocentric
    vel: { vx: vel.vx, vy: vel.vy }, // m/s
    facing,                          // rad — direction the nose (and drive thrust) points
    thrustG: 0,                      // main drive output last minute (G)
    rcsG: 0,                         // RCS output last minute (G)
    turning: 0,                      // rad turned last minute (signed)
    maxG: 10,                        // drive limit
    hold: null,                      // station-keeping: { kind:'entity'|'body', id, ox, oy (m) }
    manual: null,                    // dev helm: { throttleG }
  };
}

/** Signed shortest angle a − b in (−π, π]. */
export function angleDiff(a, b) {
  let d = (a - b) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  else if (d <= -Math.PI) d += 2 * Math.PI;
  return d;
}

const _g0 = { ax: 0, ay: 0 };
const _g1 = { ax: 0, ay: 0 };

/** Integrate pos/vel over dtSec with constant non-gravitational accel (tax, tay). Velocity-Verlet. */
export function integrate(pos, vel, tax, tay, dtSec) {
  solarGravity(pos.x, pos.y, _g0);
  const ax0 = _g0.ax + tax, ay0 = _g0.ay + tay;
  pos.x += (vel.vx * dtSec + 0.5 * ax0 * dtSec * dtSec) / AU_M;
  pos.y += (vel.vy * dtSec + 0.5 * ay0 * dtSec * dtSec) / AU_M;
  solarGravity(pos.x, pos.y, _g1);
  vel.vx += 0.5 * (ax0 + _g1.ax + tax) * dtSec;
  vel.vy += 0.5 * (ay0 + _g1.ay + tay) * dtSec;
}

/**
 * One flight step.
 * @param f    flight state (mutated)
 * @param cmd  { ax, ay } desired non-gravitational accel in m/s² (solar frame),
 *             maxG drive limit for this maneuver, optional `face` (rad) to point
 *             the nose at when no main-drive burn is wanted
 * @param dtMin step length in game-minutes
 * @returns {{ mainG:number, rcsG:number, turned:number, rotation:number }}
 */
export function flightStep(f, cmd, dtMin = 1) {
  const dt = dtMin * MIN_S;
  const ax = cmd ? cmd.ax : 0;
  const ay = cmd ? cmd.ay : 0;
  const maxA = Math.min(cmd?.maxG ?? f.maxG, f.maxG) * G0;
  const mag = Math.hypot(ax, ay);
  const rcsMax = RCS_MAX_G * G0;

  let tax = 0, tay = 0;     // average non-gravitational accel actually produced
  let mainA = 0, rcsA = 0;
  let turned = 0;
  let rotation = 0;         // total rotation the command asked for at the start of this step
  const maxTurn = SLEW_RATE * dtMin;

  const slewTo = (target) => {
    const diff = angleDiff(target, f.facing);
    rotation = Math.abs(diff);
    const step = Math.max(-maxTurn, Math.min(maxTurn, diff));
    f.facing = angleDiff(f.facing + step, 0);
    turned = step;
  };

  if (mag <= rcsMax) {
    // Fine work on RCS alone; nose optionally swings to a requested attitude
    if (cmd && cmd.face != null) slewTo(cmd.face);
    tax = ax; tay = ay;
    rcsA = mag;
  } else {
    const want = Math.atan2(ay, ax);
    const startErr = Math.abs(angleDiff(want, f.facing));
    slewTo(want);
    const err = angleDiff(want, f.facing);
    if (Math.abs(err) <= ALIGN_TOL) {
      // The drive is cold only while the nose is outside tolerance; small
      // tracking corrections happen with the drive lit.
      const coldMin = Math.max(0, startErr - ALIGN_TOL) / SLEW_RATE;
      const frac = Math.max(0, 1 - coldMin / dtMin);
      const a = Math.min(mag * Math.cos(err), maxA) * frac;
      const cx = Math.cos(f.facing), cy = Math.sin(f.facing);
      tax = a * cx; tay = a * cy;
      mainA = a;
      // RCS trims the residual off-axis component
      let rx = ax * frac - tax, ry = ay * frac - tay;
      const rm = Math.hypot(rx, ry);
      if (rm > 0 && a > 0) {
        const k = Math.min(1, rcsMax / rm);
        rx *= k; ry *= k;
        tax += rx; tay += ry;
        rcsA = Math.hypot(rx, ry);
      }
    }
  }

  integrate(f.pos, f.vel, tax, tay, dt);
  f.thrustG = mainA / G0;
  f.rcsG = rcsA / G0;
  f.turning = turned;
  return { mainG: f.thrustG, rcsG: f.rcsG, turned, rotation };
}

/** Reaction mass used by one step's output. */
export function fuelUsed(mainG, rcsG, dtMin = 1) {
  return (mainG * FUEL_PER_G_MIN + rcsG * RCS_FUEL_PER_G_MIN) * dtMin;
}
